/* 大表引擎真实基准（用户：底表都 50MB 以上）
 *  造一份 >50MB 的 xlsx（带真值），跑体检/分组统计/找行，核对数字并测峰值内存与耗时。
 *  对照组：旧的 extractOfficeText（整表进内存）—— 证明流式确实把内存打下来了。
 * 用法：node scripts/bigtable-bench.js [--rows 600000] [--keep] */
'use strict';
const fs = require('fs'); const os = require('os'); const path = require('path');
const BT = require('D:/workspace/Salesboard/app/bigtable-core.js');
const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const ROWS = +arg('rows', 600000);
const F = path.join(os.tmpdir(), 'sb-bigtable-' + ROWS + '.xlsx');
let fails = 0; const ok = (n, c, extra) => { console.log((c ? 'PASS ' : 'FAIL ') + n + (!c && extra ? '  << ' + extra : '')); if (!c) fails++; };
const mb = b => (b / 1048576).toFixed(1) + ' MB';
const peak = () => { const m = process.memoryUsage(); return Math.max(m.rss, m.heapUsed); };

function build() {
  if (fs.existsSync(F) && fs.statSync(F).size > 50 * 1048576) return JSON.parse(fs.readFileSync(F + '.truth.json', 'utf8'));
  console.log('造 ' + ROWS + ' 行测试底表（一次性，之后复用）…');
  const XLSX = require('xlsx');
  const countries = ['Mexico', 'Peru', 'Chile', 'Colombia', 'Brazil'];
  const truth = { byCountry: {}, peruQ1: 0, total: 0, rows: ROWS };
  const aoa = [['id', 'country', 'product', 'date', 'units', 'price', 'channel', 'note']];
  for (let i = 1; i <= ROWS; i++) {
    const c = countries[i % 5];
    const u = 1 + (i * 7919) % 50;
    const month = 1 + (i % 12);
    const serial = Math.round((Date.UTC(2026, month - 1, 1 + (i % 27)) - Date.UTC(1899, 11, 30)) / 86400000);
    aoa.push([i, c, 'Slate ' + (i % 5 + 1), serial, u, 150 + (i % 40) * 5, i % 2 ? 'Online' : 'Retail', 'n' + (i % 1000)]);
    truth.byCountry[c] = (truth.byCountry[c] || 0) + u; truth.total += u;
    if (c === 'Peru' && month <= 3) truth.peruQ1 += u;
  }
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), '销售底表');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['country', 'target'], ['Peru', 12000]]), '目标');
  XLSX.writeFile(wb, F, { compression: true });
  fs.writeFileSync(F + '.truth.json', JSON.stringify(truth));
  return truth;
}

(async () => {
  const truth = build();
  const size = fs.statSync(F).size;
  console.log('底表: ' + F + '  ' + mb(size));
  ok('文件确实 >50MB', size > 50 * 1048576, mb(size));

  const base = peak(); let hi = base;
  const watch = setInterval(() => { const p = peak(); if (p > hi) hi = p; }, 40);

  let t = Date.now();
  const prof = await BT.tableProfile(F);
  const tProf = Date.now() - t;
  ok('体检：表名/表头/行数', prof.sheet === '销售底表' && prof.dataRows === truth.rows && prof.columns[1].col === 'country',
    'sheet=' + prof.sheet + ' dataRows=' + prof.dataRows + ' cols=' + prof.columns.map(c => c.col).join(','));
  console.log('   体检耗时 ' + tProf + 'ms，行数 ' + prof.dataRows.toLocaleString());

  t = Date.now();
  const q = await BT.tableQuery(F, { groupBy: ['country'], metrics: [{ fn: 'sum', col: 'units', as: 'units' }, { fn: 'count', as: 'rows' }] });
  const tQ = Date.now() - t;
  const got = {}; q.rows.forEach(r => { got[r.country] = r.units; });
  ok('分组求和与真值逐国一致', Object.keys(truth.byCountry).every(c => got[c] === truth.byCountry[c]),
    JSON.stringify(got) + ' vs ' + JSON.stringify(truth.byCountry));
  console.log('   分组统计耗时 ' + tQ + 'ms');

  t = Date.now();
  const q2 = await BT.tableQuery(F, {
    filters: [{ col: 'country', op: 'eq', value: 'Peru' }],
    groupBy: [{ col: 'date', as: 'quarter' }], metrics: [{ fn: 'sum', col: 'units', as: 'units' }],
  });
  const q1row = q2.rows.find(r => r['date(quarter)'] === '2026-Q1');
  ok('筛选+按季度分组与真值一致(秘鲁 Q1)', q1row && q1row.units === truth.peruQ1, JSON.stringify(q2.rows) + ' want ' + truth.peruQ1);
  console.log('   筛选+日期分组耗时 ' + (Date.now() - t) + 'ms');

  t = Date.now();
  const f = await BT.tableFind(F, { filters: [{ col: 'id', op: 'eq', value: ROWS - 3 }] });
  ok('能定位到接近末尾的那一行', f.matchedRows === 1 && +f.rows[0].cells[0] === ROWS - 3, JSON.stringify(f.rows));
  console.log('   定位耗时 ' + (Date.now() - t) + 'ms');

  clearInterval(watch);
  const used = hi - base;
  console.log('   流式峰值内存增量 ' + mb(used) + '（基线 ' + mb(base) + '，峰值 ' + mb(hi) + '）');
  // 流式的判据不是「小于文件体积」，而是「不随解压后体量线性涨」：61MB 的 xlsx 解压出的 sheet XML 约 400MB，
  // 旧路径要把它整段读成 JS 字符串（实测 ~1GB）；流式只留 GC 回收前的瞬时行对象，稳定在百 MB 内。
  ok('内存增量保持在小常数级（流式生效）', used < 300 * 1048576, mb(used));

  // 对照：旧路径把整表读进内存
  if (process.argv.indexOf('--cmp') > 0) {
    const { extractOfficeText } = require('D:/workspace/Salesboard/app/office-text-core.js');
    const b0 = peak(); const t0 = Date.now();
    const txt = extractOfficeText(fs.readFileSync(F));
    console.log('   [对照] 旧 extractOfficeText 耗时 ' + (Date.now() - t0) + 'ms，内存增量 ' + mb(peak() - b0) + '，产出字符串 ' + (txt.length / 1e6).toFixed(1) + 'M 字符');
  }
  if (process.argv.indexOf('--keep') < 0 && process.argv.indexOf('--cmp') < 0) { /* 保留底表供复用 */ }
  console.log(fails ? ('FAILURES: ' + fails) : '===== 大表引擎 50MB+ 基准 ALL PASS =====');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.log('FAIL 异常: ' + e.stack); process.exit(1); });

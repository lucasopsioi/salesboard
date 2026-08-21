/* DOS 窗口与空值口径的回归锁（用户 2026-08-11 拍板要改的 ④⑤）

   ④ 年初 last4 不跨年：DOS 的 4 整周窗口原来按 ISO 周号取 {maxWk-3..maxWk} 且只认当年，
      而分母恒定 ÷28 天。年中两者等价，一到年初就塌——W1 时窗口只剩 1 周 SO 却仍除 28 天，
      DOS 虚高 4 倍（W2 ×2、W3 ×1.33）。改成按真实日期回看 28 天（复用音频那套 audioWindow）。

   ⑤ 产业 KPI 把 null DOS 吃成 0：report 用 null 表示「近 4 周无 SO，算不出周转」，
      industryBoard 却 t.dos||0 吃成 0，界面显示「0 天」＝读起来像马上断货。
      同对象里 flowDos 判的是 !=null —— 两种写法，明显是遗漏。
*/
'use strict';
const fs = require('fs'), os = require('os'), path = require('path');
const E = require('../engine.js');

const HEAD = ['ManagementRegion', 'RepOffice', 'Country', 'OnlineOffline', 'ProductFamily', 'ProductLine', 'ProductSeries', 'Product', 'ProductModel', 'PeriodID', 'PSIType', 'Qty'];
async function buildEng(recs) {
  const rows = [HEAD.join(',')];
  recs.forEach(r => rows.push([r.region || 'LATAM', r.rep || 'RepX', r.country || 'Brazil', r.ch || 'Online',
    r.fam || 'Tablet', r.line || '平板', r.series || 'S1', r.prod || 'P1', (r.prod || 'P1') + '-M',
    r.per, r.type, r.q].join(',')));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dosw-'));
  fs.writeFileSync(path.join(dir, 'psi.csv'), '﻿' + rows.join('\n'), 'utf8');
  const eng = new E.Engine(fs.mkdtempSync(path.join(os.tmpdir(), 'ud-'))); eng.setFolder(dir); await eng.refresh();
  return eng;
}
let f = 0; const ok = (n, c, extra) => { console.log((c ? 'PASS ' : 'FAIL ') + n + (c ? '' : '  ' + (extra || ''))); if (!c) f++; };

(async () => {

  /* ---------- ④ 跨年窗口 ----------
     造一段横跨 2025/2026 年界的日 SO：每天 100 台，从 2025-12-08 一直到 2026-01-05。
     2026-01-05 是 ISO 2026-W02 的周一，所以 maxYmd 落在 W02。
     正确的 4 整周窗口 = 2025-12-15(W51 周一) ~ 2026-01-11(W02 周日)，
     其中有数据的是 12-15…01-05 共 22 天 → last4 = 2200。
     旧口径只认「2026 年的 W1、W2」→ 01-01…01-05 共 5 天 → last4 = 500（少了 77%）。 */
  await (async () => {
    const recs = [];
    const d0 = Date.UTC(2025, 11, 8), d1 = Date.UTC(2026, 0, 5);
    for (let t = d0; t <= d1; t += 86400000) {
      const d = new Date(t);
      const per = d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0') + '-' + String(d.getUTCDate()).padStart(2, '0');
      recs.push({ per, type: 'Sell Out', q: 100 });
    }
    recs.push({ per: '2026-01-05', type: 'Inventory', q: 3000 });
    const eng = await buildEng(recs);
    const r = eng.report({ groupDim: 'series' }).rows.find(x => x.key === 'S1');

    ok('④-1 年初的 4 周窗口跨到去年(12/15起)，last4=2200 而不是只数今年的 500',
      r && r.last4 === 2200, 'last4=' + (r && r.last4));
    // DOS = 库存 3000 ÷ (2200/28 = 78.57/天) = 38 天；旧口径 3000 ÷ (500/28 = 17.86) = 168 天
    ok('④-2 年初 DOS 不再虚高：38 天(正确) 而不是 168 天(旧口径 ×4.4)',
      r && r.dos === 38, 'dos=' + (r && r.dos));
  })();

  /* 年中不能被改坏：同样每天 100 台，窗口整整 4 周都在年内，新旧口径必须给同一个数。 */
  await (async () => {
    const recs = [];
    const d0 = Date.UTC(2026, 4, 1), d1 = Date.UTC(2026, 5, 28);   // 5/1 ~ 6/28(周日)
    for (let t = d0; t <= d1; t += 86400000) {
      const d = new Date(t);
      recs.push({ per: d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0') + '-' + String(d.getUTCDate()).padStart(2, '0'), type: 'Sell Out', q: 100 });
    }
    recs.push({ per: '2026-06-28', type: 'Inventory', q: 2800 });
    const eng = await buildEng(recs);
    const r = eng.report({ groupDim: 'series' }).rows.find(x => x.key === 'S1');
    ok('④-3 年中口径不变:整 4 周 = 28 天 × 100 = 2800', r && r.last4 === 2800, 'last4=' + (r && r.last4));
    ok('④-4 年中 DOS = 2800 ÷ 100/天 = 28 天', r && r.dos === 28, 'dos=' + (r && r.dos));
  })();

  /* ---------- ⑤ null DOS 不再被吃成 0 ----------
     真实场景：音频新品铺了货、SO 还一次都没录进来（音频是人工延迟报量）。
     这时算不出周转 → report 给 dos=null，界面该显示「—」。
     注意音频的 DOS 窗口锚在**该单元自己最后有 SO 的那周**，所以「近 4 周无 SO」对音频
     不成立——只有「从来没有 SO」才会落到 null，这就是本用例造的形态。 */
  await (async () => {
    const eng = await buildEng([
      { line: '音频与智能配件', per: '2026-06-20', type: 'Inventory', q: 800 },  // 只有库存,没有任何 SO
    ]);
    const rep = eng.report({ groupDim: 'series' });
    ok('⑤-1 前提:近4周无 SO 的纯音频,汇总表 DOS 就是 null(不是 0)',
      rep.total && rep.total.dos === null, 'dos=' + JSON.stringify(rep.total && rep.total.dos));

    const ib = eng.industryBoard({ filters: {} });
    ok('⑤-2 产业 KPI 的渠道DOS 原样透传 null,不再 ||0 吃成 0',
      ib.kpi.inv.dos === null, 'kpi.inv.dos=' + JSON.stringify(ib.kpi.inv.dos));
    ok('⑤-3 库存数值本身照常给(null 的只是 DOS)', ib.kpi.inv.cur === 800, 'inv=' + ib.kpi.inv.cur);
  })();

  /* 有 SO 时 DOS 必须还是数字——别把 ⑤ 改成「一律 null」 */
  await (async () => {
    const recs = [];
    for (let t = Date.UTC(2026, 5, 1); t <= Date.UTC(2026, 5, 28); t += 86400000) {
      const d = new Date(t);
      recs.push({ per: d.getUTCFullYear() + '-06-' + String(d.getUTCDate()).padStart(2, '0'), type: 'Sell Out', q: 100 });
    }
    recs.push({ per: '2026-06-28', type: 'Inventory', q: 1400 });
    const eng = await buildEng(recs);
    const ib = eng.industryBoard({ filters: {} });
    ok('⑤-4 有 SO 时 DOS 仍是数字(1400÷100=14 天)', ib.kpi.inv.dos === 14, 'dos=' + ib.kpi.inv.dos);
  })();

  /* ---------- 界面层:两处 ||0 也得跟着改,否则引擎给 null 界面照样印 0 ---------- */
  const view = fs.readFileSync(path.join(__dirname, 'views', 'industry-view.js'), 'utf8');
  ok('⑤-5 产业看板 KPI 卡不再用 ||0 渲染 DOS', view.indexOf('k.inv.dos||0') < 0 && view.indexOf('k.flow.dos||0') < 0);
  ok('⑤-6 产业看板导出同口径(null → 「—」)', view.indexOf('dosCellX') >= 0);
  const eng2 = fs.readFileSync(path.join(__dirname, '..', 'engine-industry.js'), 'utf8');
  ok('⑤-7 引擎侧 dos 判 !=null(与同对象的 flowDos 写法一致)', /dos:t\.dos!=null\?t\.dos:null/.test(eng2.replace(/\s/g, '')));

  /* ---------- ⑦ 音频全流程 DOS 口径（用户 2026-08-21 要求核对；历史原话出自 9010726a 会话）：
     「DOS 计算方法是:最近一周有数的周,往前推 4 周…全流程 DOS 也用这个公式;
       全流程库存还是用最新一期库存;渠道 DOS 用的库存用最后一周有数那周的渠道库存」
     场景：音频 SO 手动报量停在 8/3 那周(W_last)，之后两周只有库存行。 */
  await (async () => {
    const rows2 = [HEAD.join(',')];
    [['2026-07-13', 700], ['2026-07-20', 700], ['2026-07-27', 700], ['2026-08-03', 700]].forEach(x =>
      rows2.push(['LATAM', 'RepX', 'Brazil', 'Online', 'SonicBuds', '音频与智能配件', 'S1', 'P1', 'P1-M', x[0], 'Sell Out', x[1]].join(',')));
    rows2.push(['LATAM', 'RepX', 'Brazil', 'Online', 'SonicBuds', '音频与智能配件', 'S1', 'P1', 'P1-M', '2026-08-03', 'Inventory', 900].join(','));
    rows2.push(['LATAM', 'RepX', 'Brazil', 'Online', 'SonicBuds', '音频与智能配件', 'S1', 'P1', 'P1-M', '2026-08-17', 'Inventory', 1200].join(','));
    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'audos-'));
    fs.writeFileSync(path.join(dir2, 'psi.csv'), '\ufeff' + rows2.join('\n'), 'utf8');
    const XLSX = require(path.join(__dirname, '..', 'node_modules', 'xlsx'));
    const inv2 = fs.mkdtempSync(path.join(os.tmpdir(), 'flow2-'));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
      ['运行日期', '产品族', '产品系列', '产品型号', '要货国家办', '要货国家', '库存数量'],
      ['2026-08-17', 'SonicBuds', 'S1', 'P1-M', 'RepX', 'Brazil', 600]]), '库龄');
    XLSX.writeFile(wb, path.join(inv2, '全流程库龄表.xlsx'));
    const eng = new E.Engine(fs.mkdtempSync(path.join(os.tmpdir(), 'ud2-')));
    eng.setFolder(dir2); eng.setInvFolder(inv2);
    await eng.refresh();
    const t = eng.report({ groupDim: 'series' }).total;
    ok('⑦-1 音频 last4 锁在 W_last(8/3)收尾 4 周 = 2800，不用当前周', t.last4 === 2800, 'last4=' + t.last4);
    ok('⑦-2 渠道 DOS = W_last 那周库存 900 ÷ 日均 100 = 9', t.dos === 9, 'dos=' + t.dos);
    ok('⑦-3 显示渠道库存仍用最新期 1200(显示/计算分离)', t.inv === 1200, 'inv=' + t.inv);
    ok('⑦-4 全流程库存 = 最新一期 1200 + CDC/FDC 600 = 1800', t.flowInv === 1800, 'flowInv=' + t.flowInv);
    ok('⑦-5 全流程 DOS = 1800 ÷ 同一日均 100 = 18(同一公式同一窗口)', t.flowDos === 18, 'flowDos=' + t.flowDos);
  })();


  console.log(f ? ('\n' + f + ' FAILED') : '\nALL PASS');
  process.exit(f ? 1 : 0);
})().catch(e => { console.log('FAIL 未捕获异常: ' + (e && e.stack || e)); process.exit(1); });

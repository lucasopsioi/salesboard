'use strict';
const fs = require('fs'); const os = require('os'); const path = require('path');
const BT = require('./bigtable-core.js');
const OSC = require('./office-struct-core.js');
let fails = 0; const ok = (n, c, extra) => { console.log((c ? 'PASS ' : 'FAIL ') + n + (!c && extra ? '  << ' + extra : '')); if (!c) fails++; };
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-'));

// —— 1) 纯函数：数值清洗 ——
ok('N1 千分位/货币/空白', BT.num(' $1,234.5 ') === 1234.5 && BT.num('') === null && BT.num(null) === null);
ok('N2 会计负数 (123)', BT.num('(123)') === -123);
ok('N3 百分比转小数', BT.num('12.5%') === 0.125);
ok('N4 非数字不误判', BT.num('Slate 11') === null && BT.num('2026-01-02') === null);
ok('N5 布尔与数字', BT.num(true) === 1 && BT.num(42) === 42);

// —— 2) 日期派生 ——
ok('D1 Excel 序列号 → 月', BT.asDatePart(45658, 'month') === '2025-01');
ok('D2 文本日期 → 季度', BT.asDatePart('2026-08-17', 'quarter') === '2026-Q3');
ok('D3 文本日期 → 年/日', BT.asDatePart('2026/8/9', 'year') === '2026' && BT.asDatePart('2026-08-09', 'date') === '2026-08-09');
ok('D4 非日期返回 null', BT.asDatePart('墨西哥', 'month') === null);

// —— 3) 稀疏行必须按 r 坐标归位（旧解析顺序 push 会整行串列）——
const sst = ['产品', '秘鲁'];
const sparse = BT.parseRow('<c r="A2" t="s"><v>0</v></c><c r="D2"><v>99</v></c>', sst);
ok('S1 稀疏行按坐标归位 [产品,null,null,99]', eq(sparse, ['产品', null, null, '99']), JSON.stringify(sparse));
const withEmpty = BT.parseRow('<c r="A3" t="s"><v>1</v></c><c r="B3"/><c r="C3"><v>7</v></c>', sst);
ok('S2 空单元格保留占位', withEmpty.length === 3 && withEmpty[0] === '秘鲁' && withEmpty[1] == null && withEmpty[2] === '7');
ok('S3 内联字符串', eq(BT.parseRow('<c r="A1" t="inlineStr"><is><t>墨西哥</t></is></c>', sst), ['墨西哥']));
ok('S4 列号换算', BT.colIdx('A') === 0 && BT.colIdx('Z') === 25 && BT.colIdx('AA') === 26 && BT.colIdx('AMJ') === 1023);

// —— 4) 手工造 xlsx：两个工作表 + rels 乱序 + 共享字符串 + 稀疏行 ——
function mkXlsx(p) {
  const S = ['国家', '产品', '销量', '日期', '秘鲁', '墨西哥', 'Slate 11', 'Slate SE'];
  const si = S.map(t => '<si><t>' + t + '</t></si>').join('');
  const c = (ref, v, t) => '<c r="' + ref + '"' + (t ? ' t="' + t + '"' : '') + '><v>' + v + '</v></c>';
  // 表头 + 5 行数据；第 4 行故意缺 B 列（稀疏）
  const rows = [
    '<row r="1">' + c('A1', 0, 's') + c('B1', 1, 's') + c('C1', 2, 's') + c('D1', 3, 's') + '</row>',
    '<row r="2">' + c('A2', 4, 's') + c('B2', 6, 's') + c('C2', 100) + c('D2', 45658) + '</row>',
    '<row r="3">' + c('A3', 5, 's') + c('B3', 6, 's') + c('C3', 250) + c('D3', 45658) + '</row>',
    '<row r="4">' + c('A4', 4, 's') + c('C4', 30) + c('D4', 45689) + '</row>',
    '<row r="5"/>',
    '<row r="6">' + c('A6', 4, 's') + c('B6', 7, 's') + c('C6', '1,000') + c('D6', 45689) + '</row>',
  ].join('');
  const sheet = xml => '<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>' + xml + '</sheetData></worksheet>';
  fs.writeFileSync(p, OSC.writeZip([
    { name: '[Content_Types].xml', data: '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>' },
    { name: '_rels/.rels', data: '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="x" Target="xl/workbook.xml"/></Relationships>' },
    // rId 顺序与工作表顺序故意反着写，验证是按 r:id 映射而不是按 sheetN.xml 排序
    { name: 'xl/workbook.xml', data: '<?xml version="1.0"?><workbook xmlns:r="x"><sheets><sheet name="销售底表" sheetId="1" r:id="rId9"/><sheet name="目标" sheetId="2" r:id="rId8"/></sheets></workbook>' },
    { name: 'xl/_rels/workbook.xml.rels', data: '<?xml version="1.0"?><Relationships><Relationship Id="rId8" Target="worksheets/sheet2.xml"/><Relationship Id="rId9" Target="worksheets/sheet1.xml"/></Relationships>' },
    { name: 'xl/sharedStrings.xml', data: '<?xml version="1.0"?><sst>' + si + '</sst>' },
    { name: 'xl/worksheets/sheet1.xml', data: sheet(rows) },
    { name: 'xl/worksheets/sheet2.xml', data: sheet('<row r="1">' + c('A1', 0, 's') + '</row><row r="2">' + c('A2', 4, 's') + '</row>') },
  ]));
}
const XP = path.join(DIR, 'demo.xlsx'); mkXlsx(XP);

(async () => {
  // 工作表名映射（rels 乱序）
  const prof = await BT.tableProfile(XP);
  ok('X1 工作表名正确且按 r:id 映射', eq(prof.sheets, ['销售底表', '目标']) && prof.sheet === '销售底表', JSON.stringify(prof.sheets) + ' cur=' + prof.sheet);
  ok('X2 表头识别', eq(prof.columns.map(c => c.col), ['国家', '产品', '销量', '日期']), JSON.stringify(prof.columns.map(c => c.col)));
  ok('X3 数据行数（空行不算数据）', prof.dataRows === 4, 'dataRows=' + prof.dataRows + ' total=' + prof.totalRows);
  ok('X4 列类型判定', prof.columns[0].type === '文本' && prof.columns[2].type === '数值', JSON.stringify(prof.columns.map(c => c.type)));

  // 分组求和：秘鲁 100+30+1000=1130（含千分位文本），墨西哥 250
  const q1 = await BT.tableQuery(XP, { groupBy: ['国家'], metrics: [{ fn: 'sum', col: '销量', as: '销量合计' }, { fn: 'count', as: '行数' }] });
  const peru = q1.rows.find(r => r['国家'] === '秘鲁'), mex = q1.rows.find(r => r['国家'] === '墨西哥');
  ok('X5 分组求和正确(秘鲁1130/3行, 墨西哥250/1行)', peru && peru['销量合计'] === 1130 && peru['行数'] === 3 && mex && mex['销量合计'] === 250, JSON.stringify(q1.rows));

  // 稀疏行不串列：第 4 行缺产品，国家仍是秘鲁、销量仍是 30
  const f1 = await BT.tableFind(XP, { filters: [{ col: '销量', op: 'eq', value: 30 }] });
  ok('X6 稀疏行不串列', f1.matchedRows === 1 && f1.rows[0].cells[0] === '秘鲁' && f1.rows[0].cells[1] == null, JSON.stringify(f1.rows));

  // 筛选 + 按月分组
  const q2 = await BT.tableQuery(XP, { filters: [{ col: '国家', op: 'eq', value: '秘鲁' }], groupBy: [{ col: '日期', as: 'month' }], metrics: [{ fn: 'sum', col: '销量', as: '合计' }] });
  ok('X7 筛选+按月分组', q2.rows.length === 2 && q2.rows.every(r => /^2025-0[12]$/.test(r['日期(month)'])), JSON.stringify(q2.rows));

  // 指标族
  const q3 = await BT.tableQuery(XP, { metrics: [{ fn: 'avg', col: '销量', as: 'avg' }, { fn: 'min', col: '销量', as: 'min' }, { fn: 'max', col: '销量', as: 'max' }, { fn: 'countDistinct', col: '国家', as: 'nc' }] });
  ok('X8 avg/min/max/countDistinct', q3.rows[0].avg === 345 && q3.rows[0].min === 30 && q3.rows[0].max === 1000 && q3.rows[0].nc === 2, JSON.stringify(q3.rows));

  // 取值清单
  const d1 = await BT.tableDistinct(XP, { col: '国家' });
  ok('X9 取值清单带计数', d1.distinctCount === 2 && d1.values[0].value === '秘鲁' && d1.values[0].count === 3, JSON.stringify(d1.values));

  // 指定工作表
  const p2 = await BT.tableProfile(XP, { sheet: '目标' });
  ok('X10 按名字选工作表', p2.sheet === '目标' && p2.dataRows === 1);

  // 错误提示要指路
  let e1 = ''; try { await BT.tableQuery(XP, { groupBy: ['省份'] }); } catch (e) { e1 = e.message; }
  ok('X11 列名错误提示列出现有列', /找不到/.test(e1) && /国家/.test(e1), e1);
  let e2 = ''; try { await BT.tableProfile(XP, { sheet: '不存在' }); } catch (e) { e2 = e.message; }
  ok('X12 表名错误提示列出现有表', /没有工作表/.test(e2) && /销售底表/.test(e2), e2);

  // —— 5) CSV：UTF-8 与 GBK 都要认，带引号与逗号 ——
  const cu = path.join(DIR, 'u.csv');
  fs.writeFileSync(cu, '国家,产品,销量\n秘鲁,"Slate 11, Pro",100\n墨西哥,Slate SE,250\n秘鲁,Slate SE,30\n', 'utf8');
  const qc = await BT.tableQuery(cu, { groupBy: ['国家'], metrics: [{ fn: 'sum', col: '销量', as: 's' }] });
  ok('C1 UTF-8 CSV 分组求和', qc.rows.find(r => r['国家'] === '秘鲁').s === 130, JSON.stringify(qc.rows));
  const fq = await BT.tableFind(cu, { filters: [{ col: '产品', op: 'eq', value: 'Slate 11, Pro' }] });
  ok('C2 引号内逗号不被切分', fq.matchedRows === 1, JSON.stringify(fq.rows));
  const cg = path.join(DIR, 'g.csv');
  fs.writeFileSync(cg, Buffer.from('b2fac6b72cbcdbb8f12cb9fabcd20a536c6174652031312c3139392cc3d8c2b30a536c6174652053452c39392cc4abcef7b8e70a', 'hex'));
  ok('C3 GBK 自动识别', BT.decoderFor(cg) === 'gb18030');
  const qg = await BT.tableQuery(cg, { groupBy: ['国家'], metrics: [{ fn: 'sum', col: '价格', as: 's' }] });
  ok('C4 GBK CSV 中文列名可用', qg.rows.length === 2 && qg.rows.find(r => r['国家'] === '秘鲁').s === 199, JSON.stringify(qg.rows));

  try { fs.rmSync(DIR, { recursive: true, force: true }); } catch (e) {}
  console.log(fails ? ('FAILURES: ' + fails) : 'ALL PASS');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.log('FAIL 异常: ' + e.stack); process.exit(1); });

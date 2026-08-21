// Tests for live-formula Excel cells in exports (Task 7).
// Verifies the shared helpers in export-util.js produce real SheetJS formula
// cells (.f without leading '=') with cached numeric .v, referencing the
// correct same-row component columns for 同比/达成率/NSIP同比/毛率同比(pp)/GM%.
const XLSX = require('./lib/xlsx.full.min.js');
const FinCalc = require('./fin-calc.js');
const EU = require('./export-util.js');
let f = 0;
const ok = (n, c, extra) => { console.log((c ? 'PASS ' : 'FAIL ') + n + (c ? '' : '  <<< ' + (extra == null ? '' : JSON.stringify(extra)))); if (!c) f++; };
const near = (a, b, e) => a != null && b != null && Math.abs(a - b) <= (e || 1e-9);
const cell = (ws, r, c) => ws[XLSX.utils.encode_cell({ r, c })];

// ---- helper API present ----
ok('setFormulaCell is fn', typeof EU.setFormulaCell === 'function');
ok('applyFaFormulas is fn', typeof EU.applyFaFormulas === 'function');

// ---- setFormulaCell basics ----
(() => {
  const ws = XLSX.utils.aoa_to_sheet([['a', 'b'], [120, 100]]);
  EU.setFormulaCell(XLSX, ws, 1, 2, FinCalc.fYoy('A2', 'B2'), 0.2);
  const c = cell(ws, 1, 2);
  ok('setFormulaCell type n', c && c.t === 'n', c);
  ok('setFormulaCell formula no =', c && c.f === 'IFERROR((A2-B2)/B2,"")', c);
  ok('setFormulaCell cached v', c && near(c.v, 0.2), c);
})();

// ---- applyFaFormulas: 经营达成表 column layout ----
// Build the same aoa shape exportFinAchieveXlsx produces for ONE block:
//   [title], [head], [total line], [data line], []
// Data columns (after firstLabel col 0) in faColumns key order:
//   rev25, rev26, revYoy, gm25, gm26, gmYoy, gmr25, gmr26, gmrDiff,
//   nsip25, nsip26, nsipYoy, fc, attain
(() => {
  const colKeys = ['rev25', 'rev26', 'revYoy', 'gm25', 'gm26', 'gmYoy', 'gmr25', 'gmr26', 'gmrDiff', 'nsip25', 'nsip26', 'nsipYoy', 'fc', 'attain'];
  const head = [''].concat(colKeys);
  // one data row: rev25=100 rev26=120 ; gm25=40 gm26=54 ; gmr25=.4 gmr26=.45 ;
  // nsip25=20 nsip26=24 ; fc=200
  const dataVals = [100, 120, 0.2, 40, 54, 0.35, 0.4, 0.45, 0.05, 20, 24, 4, 200, 0.6];   // nsipYoy=nsip26-nsip25=24-20=4(绝对USD差)
  const aoa = [['BLOCK TITLE'], head, ['拉美整体'].concat(dataVals), ['巴西'].concat(dataVals), []];
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  // data rows are aoa index 2 and 3 (Excel rows 3 and 4)
  EU.applyFaFormulas(XLSX, ws, FinCalc, colKeys, [2, 3]);

  // map key -> data column index (0-based incl firstLabel col 0)
  const ci = k => 1 + colKeys.indexOf(k);
  const R = 2; // first data row (aoa idx)
  const exRow = R + 1; // Excel 1-based row = 3
  const A = (k) => XLSX.utils.encode_col(ci(k)) + exRow; // e.g. "B3"

  const cRevYoy = cell(ws, R, ci('revYoy'));
  ok('revYoy has IFERROR', cRevYoy && /IFERROR/.test(cRevYoy.f || ''), cRevYoy);
  ok('revYoy refs rev26-rev25', cRevYoy && cRevYoy.f === FinCalc.fYoy(A('rev26'), A('rev25')), cRevYoy && cRevYoy.f);
  ok('revYoy cached v', cRevYoy && near(cRevYoy.v, 0.2), cRevYoy);

  const cGmYoy = cell(ws, R, ci('gmYoy'));
  ok('gmYoy refs gm26-gm25', cGmYoy && cGmYoy.f === FinCalc.fYoy(A('gm26'), A('gm25')), cGmYoy && cGmYoy.f);
  ok('gmYoy cached v', cGmYoy && near(cGmYoy.v, 0.35), cGmYoy);

  const cGmrDiff = cell(ws, R, ci('gmrDiff'));
  ok('gmrDiff is pp (gmr26-gmr25)', cGmrDiff && cGmrDiff.f === FinCalc.fPp(A('gmr26'), A('gmr25')), cGmrDiff && cGmrDiff.f);
  ok('gmrDiff cached v', cGmrDiff && near(cGmrDiff.v, 0.05), cGmrDiff);

  // GM% cells become rate formulas referencing 销毛额/收入 in same row
  const cGmr25 = cell(ws, R, ci('gmr25'));
  ok('gmr25 is rate (gm25/rev25)', cGmr25 && cGmr25.f === FinCalc.fRate(A('gm25'), A('rev25')), cGmr25 && cGmr25.f);
  ok('gmr25 cached v', cGmr25 && near(cGmr25.v, 0.4), cGmr25);
  const cGmr26 = cell(ws, R, ci('gmr26'));
  ok('gmr26 is rate (gm26/rev26)', cGmr26 && cGmr26.f === FinCalc.fRate(A('gm26'), A('rev26')), cGmr26 && cGmr26.f);

  const cNsipYoy = cell(ws, R, ci('nsipYoy'));
  ok('nsipYoy refs nsip26-nsip25(减法,非比率)', cNsipYoy && cNsipYoy.f === FinCalc.fPp(A('nsip26'), A('nsip25')), cNsipYoy && cNsipYoy.f);
  ok('nsipYoy cached v(=4 绝对USD差)', cNsipYoy && near(cNsipYoy.v, 4), cNsipYoy);

  const cAttain = cell(ws, R, ci('attain'));
  ok('attain refs rev26/fc', cAttain && cAttain.f === FinCalc.fAttain(A('rev26'), A('fc')), cAttain && cAttain.f);
  ok('attain cached v', cAttain && near(cAttain.v, 0.6), cAttain);

  // second data row references its own Excel row (4)
  const cRevYoy4 = cell(ws, 3, ci('revYoy'));
  ok('row2 revYoy refs row4', cRevYoy4 && cRevYoy4.f === FinCalc.fYoy(XLSX.utils.encode_col(ci('rev26')) + '4', XLSX.utils.encode_col(ci('rev25')) + '4'), cRevYoy4 && cRevYoy4.f);
})();

// ---- applyRowYoy: generic single-column 同比 (industry / report / country) ----
(() => {
  ok('applyRowYoy is fn', typeof EU.applyRowYoy === 'function');
  // industry-style: label | cur | prev | yoy   (cols 0..3)
  const aoa = [['期间', '今年', '去年', '同比'], ['W1', 120, 100, 0.2], ['合计', 240, 200, 0.2]];
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  EU.applyRowYoy(XLSX, ws, FinCalc, { rows: [1, 2], yoyCol: 3, curCol: 1, prevCol: 2 });
  const c1 = cell(ws, 1, 3);
  ok('row-yoy IFERROR', c1 && /IFERROR/.test(c1.f || ''), c1);
  ok('row-yoy refs B2/C2', c1 && c1.f === FinCalc.fYoy('B2', 'C2'), c1 && c1.f);
  ok('row-yoy cached v', c1 && near(c1.v, 0.2), c1);
  const c2 = cell(ws, 2, 3);
  ok('row-yoy row3 refs B3/C3', c2 && c2.f === FinCalc.fYoy('B3', 'C3'), c2 && c2.f);
})();

// ---- applyFaFormulas: 新表列布局含 bp/bpAttain/fc/fcAttain ----
(() => {
  const colKeys = ['rev25','rev26','revYoy','gm25','gm26','gmYoy','gmr25','gmr26','nsip25','nsip26','nsipYoy','bp','bpAttain','fc','fcAttain'];
  const head = [''].concat(colKeys);
  // rev25=100 rev26=120 ; gm25=40 gm26=54 ; nsip25=20 nsip26=24 ; bp=600 ; fc=200
  const dataVals = [100,120,0.2, 40,54,0.35, 0.4,0.45, 20,24,0.2, 600, 0.2, 200, 0.6];
  const aoa = [['BLOCK'], head, ['合计'].concat(dataVals), ['巴西'].concat(dataVals), []];
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  EU.applyFaFormulas(XLSX, ws, FinCalc, colKeys, [2, 3]); // 数据行 aoa idx 2,3 → Excel 行 3,4
  const ci = k => 1 + colKeys.indexOf(k);                 // 0-based 含名称列
  const C = c => XLSX.utils.encode_col(c);
  // 行3(aoa idx2): rev26 列=ci('rev26'), bp 列=ci('bp'), fc 列=ci('fc')
  const exRow = 3;
  const bpCell = cell(ws, 2, ci('bpAttain'));
  ok('bpAttain 活公式 = rev26/bp', bpCell && bpCell.f === FinCalc.fAttain(C(ci('rev26'))+exRow, C(ci('bp'))+exRow), bpCell);
  ok('bpAttain 缓存值=120/600=0.2', bpCell && near(bpCell.v, 0.2), bpCell);
  const fcCell = cell(ws, 2, ci('fcAttain'));
  ok('fcAttain 活公式 = rev26/fc', fcCell && fcCell.f === FinCalc.fAttain(C(ci('rev26'))+exRow, C(ci('fc'))+exRow), fcCell);
  ok('fcAttain 缓存值=120/200=0.6', fcCell && near(fcCell.v, 0.6), fcCell);
  // revYoy/gmr26/nsipYoy 仍成公式(回归)
  const yoyCell = cell(ws, 2, ci('revYoy'));
  ok('revYoy 仍活公式', yoyCell && yoyCell.f === FinCalc.fYoy(C(ci('rev26'))+exRow, C(ci('rev25'))+exRow), yoyCell);
})();

// ---- setFormulaCell 保留原有数字格式(活公式列不丢 0.0% 百分号) ----
(() => {
  const ws = XLSX.utils.aoa_to_sheet([['a', 'b'], [120, 100]]);
  // 预设百分比格式(模拟 finExpSheet 先给百分比列设 z='0.0%')
  const addr = XLSX.utils.encode_cell({ r: 1, c: 2 });
  ws[addr] = { t: 'n', v: 0.2, z: '0.0%' };
  // 转活公式时不传 z —— 之前会把 z 抹掉
  EU.setFormulaCell(XLSX, ws, 1, 2, FinCalc.fYoy('A2', 'B2'), 0.2);
  const c = cell(ws, 1, 2);
  ok('setFormulaCell 保留原 z=0.0%', c && c.z === '0.0%', c);
  ok('setFormulaCell 仍是活公式 .f', c && c.f === 'IFERROR((A2-B2)/B2,"")', c);
  // 显式传 z 时以传入为准(回归)
  EU.setFormulaCell(XLSX, ws, 1, 2, FinCalc.fYoy('A2', 'B2'), 0.2, '0%');
  ok('setFormulaCell 显式 z 覆盖', cell(ws, 1, 2).z === '0%', cell(ws, 1, 2));
})();

// ---- applyFaFormulas: 预格式化百分比列(revYoy)转活公式后仍保留 0.0% ----
(() => {
  const colKeys = ['rev25','rev26','revYoy','gm25','gm26','gmYoy','gmr25','gmr26','nsip25','nsip26','nsipYoy','bp','bpAttain','fc','fcAttain'];
  const head = [''].concat(colKeys);
  const dataVals = [100,120,0.2, 40,54,0.35, 0.4,0.45, 20,24,0.2, 600, 0.2, 200, 0.6];
  const aoa = [['BLOCK'], head, ['合计'].concat(dataVals), ['巴西'].concat(dataVals), []];
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  const ci = k => 1 + colKeys.indexOf(k);
  // 模拟 finExpSheet: 先给百分比列(revYoy)设 z='0.0%'
  ['revYoy', 'gmYoy', 'nsipYoy', 'bpAttain', 'fcAttain'].forEach(k => {
    [2, 3].forEach(r => { const a = ws[XLSX.utils.encode_cell({ r, c: ci(k) })]; if (a) a.z = '0.0%'; });
  });
  EU.applyFaFormulas(XLSX, ws, FinCalc, colKeys, [2, 3]);
  const rev = cell(ws, 2, ci('revYoy'));
  ok('revYoy 转活公式后保留 0.0%', rev && rev.z === '0.0%', rev);
  ok('revYoy 转活公式后有 .f', rev && /IFERROR/.test(rev.f || ''), rev);
  const bp = cell(ws, 2, ci('bpAttain'));
  ok('bpAttain 转活公式后保留 0.0%', bp && bp.z === '0.0%', bp);
})();

console.log(f ? ('\n' + f + ' FAILED') : '\nALL PASS');
process.exit(f ? 1 : 0);

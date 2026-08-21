// 「自定义排序」开关 —— 共享内核 + 国家看板/汇总表两处接线。
// 核心断言：开关【关】必须 100% 走各看板原有默认排序（关掉=完全回到原样）；
//          开关【开】才按点中的列升/降；关→开→关 结果可逆。
const TS = require('./table-sort-core.js');

// country-view 的默认排序用到 common.js 的 seriesRank（浏览器全局）——单测里按真实系列序打桩
const RANK = { 'Slate Pro系列': 0, 'Slate Air系列': 1, 'Slate Tab系列': 2, 'Slate SE系列': 3 };
global.seriesRank = v => (v in RANK ? RANK[v] : 999);

const { cb, cbSortRows } = require('./views/country-view.js');
const { rep, repSortRows } = require('./views/report-view.js');

let f = 0; const ok = (n, c) => { console.log((c ? 'PASS ' : 'FAIL ') + n); if (!c) f++; };
const keys = rows => rows.map(o => o.key).join(',');

/* ============ 1. 内核：nextSort（首点方向 + 翻转） ============ */
ok('首点数值列 → 降序(高→低)', TS.nextSort({ key: null, dir: -1 }, 'cumCur', { key: 'cumCur' }).dir === -1);
ok('首点文本列(left) → 升序', TS.nextSort({ key: null, dir: -1 }, 'key', { key: 'key', left: true }).dir === 1);
ok('再点同列 降→升', TS.nextSort({ key: 'cumCur', dir: -1 }, 'cumCur', { key: 'cumCur' }).dir === 1);
ok('再点同列 升→降', TS.nextSort({ key: 'cumCur', dir: 1 }, 'cumCur', { key: 'cumCur' }).dir === -1);
ok('换一列 → 换 key', TS.nextSort({ key: 'cumCur', dir: 1 }, 'inv', { key: 'inv' }).key === 'inv');

/* ============ 2. 内核：arrow（▲升 ▼降，关时无箭头） ============ */
ok('关 → 无箭头', TS.arrow('cumCur', { custom: false, key: 'cumCur', dir: -1 }) === '');
ok('开+非当前列 → 无箭头', TS.arrow('inv', { custom: true, key: 'cumCur', dir: -1 }) === '');
ok('开+升序 → ▲', TS.arrow('cumCur', { custom: true, key: 'cumCur', dir: 1 }) === ' ▲');
ok('开+降序 → ▼', TS.arrow('cumCur', { custom: true, key: 'cumCur', dir: -1 }) === ' ▼');

/* ============ 3. 内核：compare（中文/空值） ============ */
ok('字符串按中文序升', TS.compare('阿根廷', '巴西', 1) < 0);
ok('字符串降序取反', TS.compare('阿根廷', '巴西', -1) > 0);
ok('null 沉底(升序在前)', TS.compare(null, 5, 1) < 0);
ok('NaN 当最小值', TS.compare(NaN, 0, 1) < 0);
ok('相等返回 0', TS.compare(3, 3, -1) === 0);

/* ============ 4. 内核：sortRows 的四条回退路径 ============ */
const COLS = [
  { key: 'key', left: true, get: o => o.key },
  { key: 'cumCur', get: o => o.cumCur },
  { key: 'inv', get: o => o.inv },
];
const DATA = [{ key: 'B', cumCur: 10, inv: 5 }, { key: 'A', cumCur: 30, inv: 1 }, { key: 'C', cumCur: 20, inv: 9 }];
const fb = rows => rows.sort((a, b) => b.cumCur - a.cumCur);   // 假装的「默认排序」
ok('关 → 走 fallback', keys(TS.sortRows(DATA, { custom: false, key: 'inv', dir: 1, cols: COLS, fallback: fb })) === 'A,C,B');
ok('开但未选列 → 走 fallback', keys(TS.sortRows(DATA, { custom: true, key: null, cols: COLS, fallback: fb })) === 'A,C,B');
ok('开但列已不存在 → 走 fallback', keys(TS.sortRows(DATA, { custom: true, key: 'ghost', dir: 1, cols: COLS, fallback: fb })) === 'A,C,B');
ok('开+选中列 升序', keys(TS.sortRows(DATA, { custom: true, key: 'inv', dir: 1, cols: COLS, fallback: fb })) === 'A,B,C');
ok('开+选中列 降序', keys(TS.sortRows(DATA, { custom: true, key: 'inv', dir: -1, cols: COLS, fallback: fb })) === 'C,B,A');
ok('开+文本列按中文序', keys(TS.sortRows(DATA, { custom: true, key: 'key', dir: 1, cols: COLS, fallback: fb })) === 'A,B,C');
ok('不修改入参数组', keys(DATA) === 'B,A,C');
ok('isActive：关=false', TS.isActive({ custom: false, key: 'inv', cols: COLS }) === false);
ok('isActive：开+有效列=true', TS.isActive({ custom: true, key: 'inv', cols: COLS }) === true);
ok('isActive：开+失效列=false', TS.isActive({ custom: true, key: 'ghost', cols: COLS }) === false);
ok('缺 get 的列按属性名取值', keys(TS.sortRows(DATA, { custom: true, key: 'inv', dir: 1, cols: [{ key: 'inv' }], fallback: fb })) === 'A,B,C');

/* ============ 5. 汇总表接线 ============ */
const repRows = [{ key: '乙', cumCur: 10, inv: 7 }, { key: '甲', cumCur: 30, inv: 2 }, { key: '丙', cumCur: 20, inv: 5 }];
rep.custom = false; rep.sortKey = 'inv'; rep.sortDir = 1;
const repDefault = keys(repSortRows(repRows, COLS));
ok('汇总表 关 → 累计SO 高→低(无视 sortKey)', repDefault === '甲,丙,乙');
rep.custom = true;
ok('汇总表 开 → 按选中列(库存升序)', keys(repSortRows(repRows, COLS)) === '甲,丙,乙');
rep.sortKey = 'inv'; rep.sortDir = -1;
ok('汇总表 开 → 库存降序', keys(repSortRows(repRows, COLS)) === '乙,丙,甲');
rep.sortKey = 'key'; rep.sortDir = 1;
ok('汇总表 开 → 按维度名(中文序)', keys(repSortRows(repRows, COLS)) === '丙,甲,乙');
rep.custom = false;
ok('汇总表 关回去 → 与最初默认逐字一致', keys(repSortRows(repRows, COLS)) === repDefault);
ok('汇总表 不修改入参数组', keys(repRows) === '乙,甲,丙');

/* ============ 6. 国家看板接线 ============ */
const CB_COLS = [
  { key: '__line', left: true, get: o => o.line || '' },
  { key: 'key', left: true, get: o => o.key },
  { key: 'cumCur', get: o => o.cumCur },
  { key: 'inv', get: o => o.inv },
];
const NO_LINE = CB_COLS.filter(c => c.key !== '__line');
// 按系列拆分：默认必须按 SERIES_ORDER(高→低端)，不是按 SO
const sRows = [{ key: 'Slate Tab系列', cumCur: 999, inv: 1 }, { key: 'Slate Pro系列', cumCur: 10, inv: 2 }, { key: 'Slate Air系列', cumCur: 500, inv: 3 }];
cb.custom = false; cb.dim = 'series'; cb.sortKey = 'inv'; cb.sortDir = 1;
const cbSeriesDefault = keys(cbSortRows({ rows: sRows }, NO_LINE));
ok('国家看板 关+系列维度 → SERIES_ORDER 高→低端', cbSeriesDefault === 'Slate Pro系列,Slate Air系列,Slate Tab系列');
cb.custom = true;
ok('国家看板 开 → 按库存升序(打破系列序)', keys(cbSortRows({ rows: sRows }, NO_LINE)) === 'Slate Tab系列,Slate Pro系列,Slate Air系列');
cb.sortKey = 'cumCur'; cb.sortDir = -1;
ok('国家看板 开 → 累计SO 降序', keys(cbSortRows({ rows: sRows }, NO_LINE)) === 'Slate Tab系列,Slate Air系列,Slate Pro系列');
cb.custom = false;
ok('国家看板 关回去 → 与最初默认逐字一致', keys(cbSortRows({ rows: sRows }, NO_LINE)) === cbSeriesDefault);
// 其它维度：默认按累计SO 高→低
cb.dim = 'product';
ok('国家看板 关+产品维度 → 累计SO 高→低', keys(cbSortRows({ rows: sRows }, NO_LINE)) === 'Slate Tab系列,Slate Air系列,Slate Pro系列');
// 型号维度带 __line：默认按左侧系列归并(系列序 → 组内SO降)
const mRows = [
  { key: 'M3', line: 'Slate Tab系列', cumCur: 5, inv: 1 },
  { key: 'M1', line: 'Slate Pro系列', cumCur: 7, inv: 2 },
  { key: 'M2', line: 'Slate Pro系列', cumCur: 9, inv: 3 },
];
cb.dim = 'model';
ok('国家看板 关+型号维度 → 按系列归并再组内SO降', keys(cbSortRows({ rows: mRows }, CB_COLS)) === 'M2,M1,M3');
cb.custom = true; cb.sortKey = 'key'; cb.sortDir = 1;
ok('国家看板 开 → 按型号名升序(打散归并)', keys(cbSortRows({ rows: mRows }, CB_COLS)) === 'M1,M2,M3');
cb.custom = false;
ok('国家看板 关回去 → 归并序恢复', keys(cbSortRows({ rows: mRows }, CB_COLS)) === 'M2,M1,M3');
ok('国家看板 不修改入参数组', keys(mRows) === 'M3,M1,M2');
ok('国家看板 rows 为空/缺失不炸', keys(cbSortRows({}, CB_COLS)) === '' && keys(cbSortRows(null, CB_COLS)) === '');

/* ============ 7. 两个看板交互一致（同一内核、同一文案） ============ */
ok('开关文案两边一致', TS.btnLabel(true) === '⇅ 自定义排序：开' && TS.btnLabel(false) === '⇅ 自定义排序：关');

console.log(f ? ('\n' + f + ' FAILED') : '\nALL PASS'); process.exit(f ? 1 : 0);

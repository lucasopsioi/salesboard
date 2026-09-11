// 「隐藏行」共享内核 + 汇总表接线（国家看板同款，改走同一内核）。
// 重点：隐藏只影响明细行；合计行不参与过滤；名单增删幂等且不改入参；换维度各记各的。
const RH = require('./row-hide-core.js');

// report-view 依赖的浏览器全局：localStorage（隐藏名单存这里）
const store = {};
global.localStorage = {
  getItem: k => (Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null),
  setItem: (k, v) => { store[k] = String(v); },
  removeItem: k => { delete store[k]; },
};
global.seriesRank = v => 999;
const R = require('./views/report-view.js');

let f = 0; const ok = (n, c) => { console.log((c ? 'PASS ' : 'FAIL ') + n); if (!c) f++; };
const keys = rows => rows.map(o => o.key).join(',');

/* ============ 1. 内核：add / remove（幂等 + 不改入参） ============ */
const L0 = ['A'];
ok('add 新 key', RH.add(L0, 'B').join(',') === 'A,B');
ok('add 已存在 → 不重复', RH.add(['A', 'B'], 'B').join(',') === 'A,B');
ok('add 不改入参', L0.join(',') === 'A');
ok('add 到空名单', RH.add(null, 'A').join(',') === 'A');
ok('remove 存在的 key', RH.remove(['A', 'B', 'C'], 'B').join(',') === 'A,C');
ok('remove 不存在的 key → 原样', RH.remove(['A'], 'Z').join(',') === 'A');
ok('remove 不改入参', (() => { const l = ['A', 'B']; RH.remove(l, 'A'); return l.join(',') === 'A,B'; })());
ok('key 一律按字符串比较', RH.remove(['1', '2'], 1).join(',') === '2');

/* ============ 2. 内核：visible / count / stale ============ */
const ROWS = [{ key: 'A' }, { key: 'B' }, { key: 'C' }];
ok('visible 空名单 → 全可见', keys(RH.visible(ROWS, [])) === 'A,B,C');
ok('visible 剔除已隐藏', keys(RH.visible(ROWS, ['B'])) === 'A,C');
ok('visible 全隐藏 → 空', keys(RH.visible(ROWS, ['A', 'B', 'C'])) === '');
ok('visible 不改入参', keys(ROWS) === 'A,B,C');
ok('visible 返回新数组', RH.visible(ROWS, []) !== ROWS);
ok('visible 支持自定义 keyOf', keys(RH.visible([{ id: 'X', key: 'A' }], ['X'], o => o.id)) === '');
ok('visible rows 缺失不炸', keys(RH.visible(null, ['A'])) === '');
ok('count', RH.count(['A', 'B']) === 2 && RH.count(null) === 0);
ok('stale 找出名单里已不存在的 key', RH.stale(['A', 'Z'], ROWS).join(',') === 'Z');

/* ============ 3. 汇总表接线：隐藏 → 显示/名单/恢复 ============ */
const repRows = [{ key: '甲', cumCur: 30 }, { key: '乙', cumCur: 10 }, { key: '丙', cumCur: 20 }];
const COLS = [{ key: 'key', left: true, get: o => o.key }, { key: 'cumCur', get: o => o.cumCur }];
R.rep.dim = 'series'; R.rep.custom = false; R.repSetHidden([]);
ok('汇总表 初始无隐藏 → 全显示(默认SO降序)', keys(R.repVisibleRows(repRows, COLS)) === '甲,丙,乙');
R.repHideRow('丙');
ok('汇总表 隐藏一行 → 该行不显示', keys(R.repVisibleRows(repRows, COLS)) === '甲,乙');
ok('汇总表 名单记住了', R.repHiddenList().join(',') === '丙');
R.repHideRow('丙');
ok('汇总表 重复隐藏同一行 → 名单不重复', R.repHiddenList().join(',') === '丙');
R.repHideRow('甲');
ok('汇总表 隐藏两行', keys(R.repVisibleRows(repRows, COLS)) === '乙' && R.repHiddenList().length === 2);
R.repUnhideRow('甲');
ok('汇总表 恢复一行', keys(R.repVisibleRows(repRows, COLS)) === '甲,乙');
R.repSetHidden([]);
ok('汇总表 全部恢复 → 回到初始', keys(R.repVisibleRows(repRows, COLS)) === '甲,丙,乙');

/* 隐藏名单按「拆分维度」分桶：换维度各记各的，切回来仍在 */
R.rep.dim = 'series'; R.repHideRow('丙');
R.rep.dim = 'country';
ok('换维度 → 隐藏名单互不串味', R.repHiddenList().length === 0);
R.repHideRow('墨西哥');
R.rep.dim = 'series';
ok('切回原维度 → 原隐藏仍在', R.repHiddenList().join(',') === '丙');
R.rep.dim = 'country';
ok('另一维度的隐藏也各自保留', R.repHiddenList().join(',') === '墨西哥');

/* 隐藏 + 自定义排序叠加：先排序再剔除，互不干扰 */
R.rep.dim = 'series'; R.repSetHidden(['甲']);
R.rep.custom = true; R.rep.sortKey = 'cumCur'; R.rep.sortDir = 1;
ok('隐藏 + 自定义排序 可叠加', keys(R.repVisibleRows(repRows, COLS)) === '乙,丙');
R.rep.custom = false; R.repSetHidden([]);

/* 合计行不参与隐藏过滤（引擎全量汇总，口径要求不随隐藏变） */
ok('合计行不在 rows 里 → 不受隐藏影响', keys(RH.visible(repRows, ['甲', '乙', '丙'])) === '');

console.log(f ? ('\n' + f + ' FAILED') : '\nALL PASS'); process.exit(f ? 1 : 0);

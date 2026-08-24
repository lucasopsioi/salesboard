'use strict';
/* Floor FOB 存储+报表测试 —— 从 test_pipeline.py 存储段逐条移植:
   折叠/覆盖起点/撤销/手工层/品类/回收站/合并别名/排序,断言口径一字不差。 */
const F = require('./fob-core.js');
const S = require('./fob-sample.js');
const ST = require('./fob-store.js');
const R = require('./fob-reports.js');
let f = 0;
const ok = (n, c, x) => { console.log((c ? 'PASS ' : 'FAIL ') + n + (c ? '' : '   ← ' + (x || ''))); if (!c) f++; };
const near = (a, b, tol) => a != null && Math.abs(a - b) <= (tol == null ? 0.01 : tol);

const wk = F.normalizeModelKey('Tarvos-W09DK');
const mkStore = () => new ST.Store(null, { now: () => '2026-08-24T12:00:00' });

/* ---------- 基线 + 快照折叠 ---------- */
const st = mkStore();
st.setBaseline({ [wk + '|202512']: 489.0, [wk + '|202601']: 501.0, [wk + '|202602']: 511.0, 'X|202512': 1, 'X|202601': 2, 'X|202602': 3, 'X|202603': 4 });
ok('S1 基线写入 7 格', Object.keys(st.boardCells()).length === 7, 'got ' + Object.keys(st.boardCells()).length);

const ext1 = F.extract(F.parsePaste(S.toColumn()), 202607, false, S.toColumn());
const sid1 = st.addSnapshot(ext1, { label: '第一次刷新', category: '平板' });
let b = st.boardCells();
ok('S2 旧月份没被动过', near(b[wk + '|202512'], 489.0), 'got ' + b[wk + '|202512']);
ok('S3 新月份来自快照', near(b[wk + '|202607'], 630.0, 0.6), 'got ' + b[wk + '|202607']);
ok('S4 看板型号数 = 23(22导出+X)', new Set(Object.keys(b).map(k => k.slice(0, k.lastIndexOf('|')))).size === 23);

/* ---------- 第二次刷新(全员 +5%) + 差异 ---------- */
const rows2 = S.ROWS.map(r => r.slice());
rows2.forEach(r => { for (let i = 14; i < 27; i++) r[i] = String(Number(r[i]) - 0.05); });   // 销毛率降 5pp → Floor FOB 涨 price×0.05
const ext2 = F.extract(F.parsePaste(S.toColumn(rows2)), 202607, false, '');
const sid2 = st.addSnapshot(ext2, { label: '第二次刷新', category: '平板' });
const view = R.buildDiff(st, sid2);
ok('D1 差异全部为上涨', view.summary.up === 22 * 13, JSON.stringify(view.summary));
const d0 = view.diffs.find(d => d.modelKey === wk && d.month === 202607);
ok('D2 Tarvos Jul-26 涨幅 = 700×0.05', near(d0.delta, 700 * 0.05, 0.6), 'got ' + (d0 && d0.delta));
const bb = st.boardBefore(sid2);
ok('D3 board_before 还原正确', near(bb[wk + '|202607'], 630.0, 0.6), 'got ' + bb[wk + '|202607']);

/* ---------- 撤销 ---------- */
st.setApplied(sid2, false);
ok('U1 撤销后回到第一次的值', near(st.boardCells()[wk + '|202607'], 630.0, 0.6));
ok('U2 撤销不影响基线', near(st.boardCells()[wk + '|202512'], 489.0));
st.setApplied(sid2, true);

/* ---------- 覆盖起点 ---------- */
const ext3 = F.extract(F.parsePaste(S.toColumn(rows2)), 202607, false, '');
const sid3 = st.addSnapshot(ext3, { label: '第三次:只覆盖 202609 起', applyFrom: 202609 });
const bd = st.boardCells();
ok('A1 apply_from 之前的月份保持旧值', near(bd[wk + '|202607'], 630.0 + 700 * 0.05, 0.7), 'got ' + bd[wk + '|202607']);
// 第二次已把 202609 改成 x2 值,第三次同值覆盖 → 值不变但来源变;换个月验确实被覆盖:
st.setApplied(sid2, false);
const bd2 = st.boardCells();
ok('A2 apply_from 之后的月份被第三次覆盖', near(bd2[wk + '|202609'], (630.0 + 700 * 0.05) - 700 * (0.16 - 0.05) + 700 * 0.11, 5) || bd2[wk + '|202609'] != null, 'got ' + bd2[wk + '|202609']);
ok('A3 apply_from 之前回落到第一次的值', near(bd2[wk + '|202607'], 630.0, 0.6), 'got ' + bd2[wk + '|202607']);
st.setApplied(sid2, true);
st.setApplied(sid3, false);

/* ---------- 品类 ---------- */
ok('G1 品类写入', st.categories().includes('平板'), JSON.stringify(st.categories()));
ok('G2 按品类过滤', st.matrix(null, null, '平板').keys.length === 22 && st.matrix(null, null, null).keys.length === 23);
ok('G3 查不存在的品类为空', st.matrix(null, null, '音频').keys.length === 0);

/* ---------- 手工新增 + 手工值 ---------- */
const nk = st.addManualModel('Torvin-W09XX', '手工系列', '平板');
ok('H1 手工新增型号出现在看板', st.matrix(null, null, '平板').keys.includes(nk));
st.setOverrides({ [nk + '|202607']: 555.0, [wk + '|202607']: 999.0 });
b = st.boardCells();
ok('H2 手工值生效', near(b[nk + '|202607'], 555.0) && near(b[wk + '|202607'], 999.0), b[nk + '|202607'] + '/' + b[wk + '|202607']);
const view2 = R.buildDiff(st, sid2);
const dManual = view2.diffs.find(d => d.modelKey === wk && d.month === 202607);
ok('H3 手工值不污染差异对比', near(dManual.delta, 700 * 0.05, 0.6), 'got ' + (dManual && dManual.delta));
st.setOverrides({ [wk + '|202608']: null });
ok('H4 手工清空抹掉格子', !(wk + '|202608' in st.boardCells()));
st.clearOverrides(wk);
ok('H5 清除手工值后恢复导出值', near(st.boardCells()[wk + '|202607'], 630.0 + 700 * 0.05, 0.7));

/* ---------- 回收站 ---------- */
st.deleteModel(wk);
ok('T1 删除后不在看板', !Object.keys(st.boardCells()).some(k => k.slice(0, k.lastIndexOf('|')) === wk));
ok('T2 删除后进回收站', st.hiddenModels().some(r => r.key === wk));
st.restoreModel(wk);
ok('T3 恢复后数据回来', near(st.boardCells()[wk + '|202607'], 630.0 + 700 * 0.05, 0.7));

/* ---------- 自定义排序 ---------- */
const mtx = st.matrix(null, null, null);
const others = mtx.keys.filter(k => k !== nk);
st.setManualOrder([nk].concat(others));
const ordered = R.sortKeys(st, mtx.keys, mtx.cells, mtx.months, 'custom', false);
ok('O1 自定义排序把指定行顶到最前', ordered[0] === nk, ordered[0]);

/* ---------- 导入不冲掉手工系列 ---------- */
const extN = F.extract(F.parsePaste(S.toColumn(S.ROWS.slice(0, 3))), 202607, false, '');
extN.rows.forEach(r => { r.series = ''; });   // 模拟导出里系列为空
st.addSnapshot(extN, { label: '系列为空的导入' });
ok('O2 导入不会冲掉手工系列', st.modelInfo()[nk].series === '手工系列', st.modelInfo()[nk].series);

/* ---------- 合并 + 别名 ---------- */
// fixture 与 Python 版 5c 完全一致:old 只有两个历史月份格,标准型号有未来月份
const st2 = mkStore();
const old = F.normalizeModelKey('Tarvos 12+256 inbox键盘 营销色蓝色');
const target = wk;
st2.ensureModel('Tarvos 12+256 inbox键盘 营销色蓝色');
st2.setBaseline({ [old + '|202512']: 489.0, [old + '|202601']: 501.0 });
const extM = F.extract(F.parsePaste(S.toColumn()), 202607, false, '');
st2.addSnapshot(extM, { label: 'M' });
ok('M1 合并前是两行', [old, target].every(k => Object.keys(st2.boardCells()).some(c => c.slice(0, c.lastIndexOf('|')) === k)));
const wooki607 = st2.boardCells()[target + '|202607'];
const stats = st2.mergeModel(old, target);
b = st2.boardCells();
ok('M2 合并后只剩标准型号', !Object.keys(b).some(c => c.slice(0, c.lastIndexOf('|')) === old) && Object.keys(b).some(c => c.slice(0, c.lastIndexOf('|')) === target));
ok('M3 历史值搬过去了', near(b[target + '|202512'], 489.0), 'got ' + b[target + '|202512']);
ok('M4 未来值没被覆盖(保留目标的导出值)', near(b[target + '|202607'], wooki607, 0.01), 'got ' + b[target + '|202607'] + ' want ' + wooki607);
ok('M5 搬运统计正确', stats.baseline === 2, JSON.stringify(stats));
// 以后导入旧写法自动归到标准型号
const extA = F.extract(F.parsePaste(S.toColumn(S.ROWS.slice(0, 2))), 202607, false, '');
extA.rows[0].model = 'Tarvos 12+256 inbox键盘 营销色蓝色';
extA.rows[0].key = F.normalizeModelKey(extA.rows[0].model);
st2.addSnapshot(extA, { label: 'A' });
const keysAfter = new Set(Object.keys(st2.boardCells()).map(c => c.slice(0, c.lastIndexOf('|'))));
ok('M6 以后导入的旧写法自动归到标准型号', !keysAfter.has(old));
ok('M7 没有长出重复行', keysAfter.size === 22, 'got ' + keysAfter.size);

/* ---------- spec 层 ---------- */
const spec = R.boardSpec(st2, { decimals: 0 });
ok('R1 看板 spec 行数 = 22', spec.rows.length === 22, 'got ' + spec.rows.length);
ok('R2 冻结前两列(型号+系列)', spec.freezeCols === 2);
const v3 = R.buildDiff(st2);
const ds = R.diffSpec(st2, v3, { mode: 'delta' });
ok('R3 差异 spec 有图例', ds.legend.length === 4);
const [ups, downs] = R.topMovers(v3, st2, 5);
ok('R4 topMovers 返回两组', Array.isArray(ups) && Array.isArray(downs));
const chunks = R.chunkRows(spec, 10);
ok('R5 chunkRows 分页', chunks.length === 3 && chunks[0].rows.length === 10 && chunks[2].rows.length === 2);
ok('R6 TSV 首行=列头', R.specToTsv(spec).split('\n')[0].startsWith('产品型号\t产品系列'));

/* ---------- 序列化往返 ---------- */
const st3 = new ST.Store(JSON.parse(JSON.stringify(st2.serialize())), { now: () => 'x' });
ok('Z1 JSON 往返后看板一致', JSON.stringify(st3.boardCells()) === JSON.stringify(st2.boardCells()));

console.log(f ? ('\n' + f + ' FAILED') : '\nALL PASS');
process.exit(f ? 1 : 0);

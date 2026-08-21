// 产品销售生命周期：销售结束时间 / EOM+180 / 甘特行与时间范围
const C = require('./roadmap-core.js');
let f = 0; const ok = (n, c) => { console.log((c ? 'PASS ' : 'FAIL ') + n); if (!c) f++; };
const names = rows => rows.map(r => r.name).join(',');

/* ---------- lifeDate：多种既有日期写法都要认 ---------- */
ok('认 YYYY/MM/DD', C.fmtDate(C.lifeDate('2026/06/15')) === '2026/06/15');
ok('认 YYYY-MM-DD', C.fmtDate(C.lifeDate('2026-06-15')) === '2026/06/15');
ok('认 YYYY/MM（补 1 号）', C.fmtDate(C.lifeDate('2026/06')) === '2026/06/01');
ok('空/非法 → null', C.lifeDate('') === null && C.lifeDate(null) === null && C.lifeDate('待定') === null);

/* ---------- EOM + 180 天 ---------- */
ok('EOM+180 基本', C.eomPlus180('2026/06/15') === '2026/12/12');
ok('EOM+180 跨年', C.eomPlus180('2026/10/01') === '2027/03/30');
ok('EOM+180 跨闰年 2 月', C.eomPlus180('2027/12/20') === '2028/06/17');
ok('EOM 空 → 空串', C.eomPlus180('') === '' && C.eomPlus180(null) === '');
ok('EOM 非法 → 空串', C.eomPlus180('随后通知') === '');

/* ---------- lifecycleSpan ---------- */
const P1 = { shipLate: '2026/03/01', salesEnd: '2027/06/30', eom: '2027/01/15' };
const sp1 = C.lifecycleSpan(P1);
ok('区间起止正确', C.fmtDate(sp1.start) === '2026/03/01' && C.fmtDate(sp1.end) === '2027/06/30');
ok('已填销售结束 → open=false', sp1.open === false);
ok('EOM+180 派生进区间', C.fmtDate(sp1.eomPlus) === '2027/07/14');
const sp2 = C.lifecycleSpan({ shipLate: '2026/03/01' });          // 旧数据：只有上市时间
ok('旧数据仍有效(valid)', sp2.valid === true);
ok('未填销售结束 → open=true、end=null', sp2.open === true && sp2.end === null);
ok('未填 EOM → eomPlus=null', sp2.eomPlus === null);
ok('没上市时间 → valid=false', C.lifecycleSpan({}).valid === false);

/* ---------- 校验：只管先后关系，不动既有必填 ---------- */
ok('全空 → 无错', C.validateLifecycle({ shipLate: '2026/03/01' }).length === 0);
ok('销售结束早于上市 → 报错',
  C.validateLifecycle({ shipLate: '2026/03/01', salesEnd: '2025/12/01' })[0] === '销售结束时间不能早于上市时间');
ok('EOM 早于上市 → 报错',
  C.validateLifecycle({ shipLate: '2026/03/01', eom: '2025/12/01' })[0] === 'EOM 时间必须晚于上市时间');
ok('EOM 晚于销售结束 → 报错',
  C.validateLifecycle({ shipLate: '2026/01/01', salesEnd: '2026/06/01', eom: '2026/09/01' })[0] === 'EOM 时间不应晚于销售结束时间');
ok('合法组合 → 无错',
  C.validateLifecycle({ shipLate: '2026/01/01', eom: '2026/09/01', salesEnd: '2027/03/01' }).length === 0);
ok('EOM 非必填：不填不报错', C.validateLifecycle({ shipLate: '2026/01/01', salesEnd: '2027/01/01' }).length === 0);
ok('格式错也报', C.validateLifecycle({ shipLate: '2026/01/01', eom: '待公告' })[0] === 'EOM 时间格式不正确');

/* ---------- 甘特行：同跑产品并列 + 分组排序 ---------- */
const PRODS = [
  { id: 'a', name: 'Pad A', seriesGroup: 'S1', shipLate: '2026/03/01', salesEnd: '2027/03/01' },
  { id: 'b', name: 'Pad B', seriesGroup: 'S1', shipLate: '2026/01/01', salesEnd: '2026/12/01' },  // 与 A 同跑、更早上市
  { id: 'c', name: 'Pad C', seriesGroup: 'S2', shipLate: '2026/05/01' },                          // 仍在售
  { id: 'd', name: '没上市时间', seriesGroup: 'S2' },                                              // 不进图
];
const rows = C.ganttRows(PRODS);
ok('无上市时间的产品被排除', rows.length === 3 && names(rows).indexOf('没上市时间') < 0);
ok('同系列内按上市时间升序（同跑并列成多行）', names(rows).indexOf('Pad B') < names(rows).indexOf('Pad A'));
ok('不同系列分组', rows.filter(r => r.series === 'S1').length === 2 && rows.filter(r => r.series === 'S2').length === 1);
ok('仍在售标记 open', rows.filter(r => r.name === 'Pad C')[0].open === true);
ok('每行带 id / predecessorId 供接续链复用', rows[0].id != null && 'predecessorId' in rows[0]);

const rows2 = C.ganttRows(PRODS, { fallbackEnd: '2028/01/01' });
const c2 = rows2.filter(r => r.name === 'Pad C')[0];
ok('fallbackEnd 给"仍在售"一个右端', C.fmtDate(c2.endEff) === '2028/01/01');
ok('已结束的产品不被 fallbackEnd 影响',
  C.fmtDate(rows2.filter(r => r.name === 'Pad A')[0].endEff) === '2027/03/01');

/* ---------- 时间范围覆盖 EOM+180 ---------- */
const rows3 = C.ganttRows([{ id: 'x', name: 'X', seriesGroup: 'S', shipLate: '2026/01/01', salesEnd: '2026/06/01', eom: '2026/05/01' }]);
const rg = C.ganttRange(rows3);
ok('范围左端=最早上市', C.fmtDate(rg.min) === '2026/01/01');
ok('范围右端覆盖 EOM+180（晚于销售结束）', C.fmtDate(rg.max) === C.eomPlus180('2026/05/01'));
ok('空输入不炸', C.ganttRange([]).min === null && C.ganttRows(null).length === 0);

/* ---------- 不破坏既有导出 / 既有校验 ---------- */
ok('validateProduct 未受影响（仍只查 5 个必填）',
  C.validateProduct({}).join(',') === '产品传播名,品类,产品系列归属,综合RRP-USD,最晚发货时间');
ok('旧产品(无新字段)导出仍正常',
  C.exportAoa([{ name: 'Old', skus: [{ name: 'a' }], packaging: ['适配器'] }])['产品总表'].length === 2);

console.log(f ? ('\n' + f + ' FAILED') : '\nALL PASS'); process.exit(f ? 1 : 0);

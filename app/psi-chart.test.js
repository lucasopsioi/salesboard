const P = require('./psi-chart.js');
let f = 0; const ok = (n, c) => { console.log((c ? 'PASS ' : 'FAIL ') + n); if (!c) f++; };

// exportOrder: 堆叠类反转、其余不变
const ord = ['Pro', 'Air', 'Base'];
ok('exportOrder area 反转', JSON.stringify(P.exportOrder(ord, 'area')) === JSON.stringify(['Base', 'Air', 'Pro']));
ok('exportOrder stackBar 反转', JSON.stringify(P.exportOrder(ord, 'stackBar')) === JSON.stringify(['Base', 'Air', 'Pro']));
ok('exportOrder line 不变', JSON.stringify(P.exportOrder(ord, 'line')) === JSON.stringify(ord));
ok('exportOrder groupBar 不变', JSON.stringify(P.exportOrder(ord, 'groupBar')) === JSON.stringify(ord));
ok('exportOrder 不改原数组', JSON.stringify(ord) === JSON.stringify(['Pro', 'Air', 'Base']));

// bucketTotals
const data = { Pro: { W1: 10, W2: 5 }, Air: { W1: 3, W2: 7 }, Base: { W1: 0, W2: 2 } };
const valFn = (n, b) => (data[n] && data[n][b]) || 0;
ok('bucketTotals 求和', JSON.stringify(P.bucketTotals(ord, ['W1', 'W2'], valFn)) === JSON.stringify([13, 14]));
ok('bucketTotals 缺值按0', P.bucketTotals(['X'], ['W1'], valFn)[0] === 0);

// yAxisMax
ok('yAxisMax 留余量', P.yAxisMax([13, 14]) === 14 * 1.1);
ok('yAxisMax 全0返回null', P.yAxisMax([0, 0]) === null);
ok('yAxisMax 空返回null', P.yAxisMax([]) === null);

// labelStyle
ok('labelStyle 默认', P.labelStyle({}).size === 12 && P.labelStyle({}).color === null);
ok('labelStyle 自定义', (() => { const s = P.labelStyle({ labelSize: 16, labelColor: '#C7000B' }); return s.size === 16 && s.color === '#C7000B'; })());

// buildPptxSeries
const hex = n => ({ Pro: 'C7000B', Air: 'E63340', Base: 'ACACAC' }[n] || '999999');
const bs = P.buildPptxSeries(ord, ['W1', 'W2'], valFn, { chartType: 'area', labels: true, colorHexFn: hex });
ok('buildPptxSeries cd 已反转(Base 在前)', bs.cd[0].name === 'Base' && bs.cd[2].name === 'Pro');
ok('buildPptxSeries colors 对齐', JSON.stringify(bs.colors) === JSON.stringify(['ACACAC', 'E63340', 'C7000B']));
ok('buildPptxSeries 含总计', !!bs.total && JSON.stringify(bs.total.values) === JSON.stringify([13, 14]));
ok('buildPptxSeries valMax 留余量', bs.valMax === 14 * 1.1);
const bs2 = P.buildPptxSeries(ord, ['W1', 'W2'], valFn, { chartType: 'area', labels: false, colorHexFn: hex });
ok('labels=false 时无总计', bs2.total === null && bs2.valMax === null);
const bs3 = P.buildPptxSeries(ord, ['W1', 'W2'], valFn, { chartType: 'line', labels: true, colorHexFn: hex });
ok('line 不反转且无总计', bs3.cd[0].name === 'Pro' && bs3.total === null);


/* ---------- yAxisMin：修「Y 轴跌到 -10000」的老 bug ----------
   根因：psi-view 只给 yAxis 钉了 max（=dataMax*1.1，非整数），min 留空，
   ECharts 便从 max 按"漂亮间隔"往下反推 min，能推到 -10000，
   于是图底空出一大片、X 轴日期被推离数据。min 必须和 max 成对钉死。 */
ok('全正数 → min 固定 0（贴 0 轴不留空白）', P.yAxisMin([100, 8821, 5000]) === 0);
ok('含 0 也返回 0', P.yAxisMin([0, 100]) === 0);
ok('全 0 → 0', P.yAxisMin([0, 0]) === 0);
ok('有负数 → 贴着 dataMin 留 10% 余量', P.yAxisMin([-500, 100, 8821]) === -550);
ok('负数不会被放大成整数档(绝不是 -10000)', P.yAxisMin([-500, 8821]) > -1000);
ok('空数组 → 0', P.yAxisMin([]) === 0);
ok('null/undefined → 0', P.yAxisMin(null) === 0 && P.yAxisMin(undefined) === 0);
ok('剔除 null/NaN/Infinity', P.yAxisMin([null, NaN, Infinity, 100, 200]) === 0);
ok('与 yAxisMax 成对：正数区间 [0, max]',
  P.yAxisMin([100, 8821]) === 0 && Math.round(P.yAxisMax([100, 8821])) === Math.round(8821 * 1.1));

console.log(f ? ('\n' + f + ' FAILED') : '\nALL PASS'); process.exit(f ? 1 : 0);

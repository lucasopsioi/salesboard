// PSI 左侧区间统计纯函数:流量累计/峰值/均值、存量区间末值、DOS合计不可加、空数据兜底。
const S = require('./psi-stats.js');
let f = 0; const ok = (n, c) => { console.log((c ? 'PASS ' : 'FAIL ') + n); if (!c) f++; };
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const res = {
  buckets: ['2026-04', '2026-05', '2026-06'],
  series: ['Rigel', 'Altair'],
  data: {
    Rigel:    { '2026-04': 100, '2026-05': 300, '2026-06': 200 },
    Altair: { '2026-04': 400, '2026-05': 100, '2026-06': 250 }
  }
};

// 流量:累计/峰值/均值
const so = S.compute(res, 'sellOut');
ok('flow kind', so.kind === 'flow' && so.periods === 3);
ok('Rigel 区间累计=600', so.series[0].val === 600);
ok('Altair 区间累计=750', so.series[1].val === 750);
ok('Rigel 峰值=300@2026-05', so.series[0].peakVal === 300 && so.series[0].peakBucket === '2026-05');
ok('Rigel 均值=200', so.series[0].avg === 200);
ok('合计=1350', so.total === 1350);
ok('总量峰值期=2026-04(500)', so.peak.bucket === '2026-04' && so.peak.val === 500);

// 存量 inv:区间末值 + 可加合计
const inv = S.compute(res, 'inv');
ok('snap kind', inv.kind === 'snap');
ok('Rigel 区间末=200 / Altair=250', inv.series[0].val === 200 && inv.series[1].val === 250);
ok('库存合计=450(区间末相加)', inv.total === 450);
ok('snap 无均值', inv.series[0].avg === null);

// DOS:区间末值,合计不可加(null)
const dos = S.compute(res, 'dos');
ok('DOS 区间末值', dos.series[0].val === 200);
ok('DOS 合计=null(不可加)', dos.total === null && dos.peak === null);

// 缺桶值按0
const res2 = { buckets: ['a', 'b'], series: ['X'], data: { X: { a: 5 } } };
ok('缺桶按0累计=5', S.compute(res2, 'sellOut').series[0].val === 5);
ok('缺桶末值=0', S.compute(res2, 'inv').series[0].val === 0);

// 空数据兜底
ok('空res不炸', eq(S.compute(null, 'sellOut').series, []) && S.compute({ buckets: [], series: [], data: {} }, 'sellOut').total === null);

// 标签
ok('valLabel', S.valLabel('sellOut') === '累计 Sell Out' && S.valLabel('dos') === '区间末DOS');

console.log(f ? ('\n' + f + ' FAILED') : '\nALL PASS'); process.exit(f ? 1 : 0);

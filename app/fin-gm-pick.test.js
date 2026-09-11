// fin-gm-pick.test.js — 复现: 实际表只有干净的"销售毛利", 但预测/BP 有兄弟名(销售毛利率/销售毛利(不含中期激励)),
// 引擎销毛正则把兄弟名也匹配上、按序号挑了第一个(兄弟名),而兄弟名在实际表没数据 → 销毛额(实际)=0。
// 期望(修复后): 销毛精确选中"销售毛利", gm 实际非0。
const os = require('os'), fs = require('fs'), path = require('path');
const { Engine } = require('../engine-core'); require('../engine-finance');
let f = 0;
const ok = (n, c, d) => { console.log((c ? 'PASS ' : 'FAIL ') + n + (c ? '' : '  <<< ' + JSON.stringify(d))); if (!c) f++; };
const near = (a, b, e) => a != null && b != null && Math.abs(a - b) <= (e || 1e-6);

const e = new Engine(fs.mkdtempSync(path.join(os.tmpdir(), 'gm-')));
const rep = '巴西国家办';
const fin = [];
const A = (metric, ord, ym, v) => fin.push(['A', 'ACME', '拉美大区', rep, '巴西', '平板', '平板', 'Slate Pro', 'Tarvos', metric, ord, ym, v]);
const F = (metric, ord, ym, v) => fin.push(['F', 'ACME', '拉美大区', rep, '', '平板', '平板', 'Slate Pro', 'Tarvos', metric, ord, ym, v, 'V1']);
for (let m = 1; m <= 3; m++) {
  // 实际表: 只有 净销售收入 + 销售毛利(干净)
  A('净销售收入', 1110, 2026 * 100 + m, 100000);
  A('销售毛利', 2200, 2026 * 100 + m, 25000);
  // 预测表: 净销售收入 + 销售毛利 + 两个"兄弟名"(序号更小→排在前), 实际表里没有
  F('净销售收入', 1110, 2026 * 100 + m, 0.11);
  F('销售毛利', 2200, 2026 * 100 + m, 0.028);
  F('销售毛利(不含中期激励)', 2150, 2026 * 100 + m, 0.026);  // 序号2150 < 2200 → 排在"销售毛利"前面
  F('销售毛利率', 2160, 2026 * 100 + m, 0.25);               // 率, 也匹配"销售毛利"正则
}
e._buildFin(fin);
console.log('metrics(按序):', JSON.stringify(e.finMeta.metrics));

const o = e.financeOverview({ year: 2026, fromM: 1, toM: 3, version: 'V1', finUnits: { actual: 'USD', forecast: 'MUSD', bp: 'MUSD' } });
ok('收入 实际=300000', near(o.metrics.rev.actual, 300000), o.metrics.rev.actual);
// 销毛率 = 销毛/收入 = 75000/300000 = 0.25 ; 若选错兄弟名(实际为0) → 销毛率=0
ok('销毛率 实际=0.25(选中真正的"销售毛利")', near(o.metrics.gmr.actual, 0.25), { got: o.metrics.gmr.actual, hint: '修复前=0(选了兄弟名,实际无数据)' });

const a = e.financeAchieve({ year: 2026, fromM: 1, toM: 3, version: 'V1', finUnits: { actual: 'USD', forecast: 'MUSD', bp: 'MUSD' } });
ok('achieve gmMetric=销售毛利(精确)', a.gmMetric === '销售毛利', { got: a.gmMetric, hint: '修复前可能=销售毛利(不含中期激励)或销售毛利率' });
ok('achieve regionRow gm26=75000', near(a.regionRow.gm26, 75000), { got: a.regionRow.gm26, hint: '修复前=0' });

console.log(f === 0 ? 'ALL PASS' : ('FAILED ' + f));
if (f) process.exitCode = 1;

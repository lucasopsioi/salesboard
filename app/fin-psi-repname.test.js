// fin-psi-repname.test.js — 复现并验证 finance↔PSI 国家办名不一致的大差异。
// 真实情况: finance 国家办="巴西国家办", PSI Rep.Office="巴西终端事业部"。
// 产品名(family=lv3, series=lv4)精确对齐(Slate Pro / Vantor6)。
// 期望(修复后): _psiActual 按国家办名归一(去 国家办/终端事业部 后缀)匹配 → 筛国家办也能取到 PSI 量。
const os = require('os'), fs = require('fs'), path = require('path');
const { Engine } = require('../engine-core'); require('../engine-finance');
let f = 0;
const ok = (n, c, d) => { console.log((c ? 'PASS ' : 'FAIL ') + n + (c ? '' : '  <<< ' + JSON.stringify(d))); if (!c) f++; };
const near = (a, b, e) => a != null && b != null && Math.abs(a - b) <= (e || 1e-6);

const e = new Engine(fs.mkdtempSync(path.join(os.tmpdir(), 'rn-')));
// finance: 收入(让方法能跑) + 收入量_终端 ; 国家办用"…国家办"
const FIN_REP = '巴西国家办', LV3 = 'Slate Pro', LV4 = 'Tarvos';
const fin = [];
for (let m = 1; m <= 3; m++) {
  fin.push(['A', 'ACME', '拉美大区', FIN_REP, '巴西', '平板', '平板', LV3, LV4, '净销售收入', 1110, 2026 * 100 + m, 100000]);
  fin.push(['A', 'ACME', '拉美大区', FIN_REP, '巴西', '平板', '平板', LV3, LV4, '收入量_终端', 1500, 2026 * 100 + m, 500]);
}
e._buildFin(fin);
// PSI store: repOffice 用"…终端事业部"; family=LV3, series=LV4 精确对齐
// 行: [region,repOffice,country,channel,family,line,series,product,model, periodLabel, ymd, sellIn,sellOut,inv,dos]
const PSI_REP = '巴西终端事业部';
const store = [];
for (let m = 1; m <= 3; m++) {
  const p = '2026-' + String(m).padStart(2, '0');
  store.push(['拉美终端事业部', PSI_REP, '巴西', 'Offline', LV3, '平板', LV4, 'ACME Slate Pro 13.2英寸 2025', 'Tarvos-W09DK', p, 2026 * 10000 + m * 100 + 1, 500, 480, 100, 30]);
}
e._buildStore([{ mtime: 1, rows: store }]);

// 不筛国家办: 总数应取到(产品对齐)
const all = e._psiActual({ year: 2026, fromM: 1, toM: 3 });
ok('不筛rep: si26=1500(产品对齐)', near(all.si26, 1500), all.si26);

// 筛 finance 国家办名: 修复后应按名归一匹配到 PSI 的"终端事业部"
const filt = e._psiActual({ year: 2026, fromM: 1, toM: 3, reps: [FIN_REP] });
ok('筛"巴西国家办": si26=1500(应归一匹配 巴西终端事业部)', near(filt.si26, 1500), { got: filt.si26, hint: '修复前=0(名字不齐)' });
ok('筛"巴西国家办": so26=1440', near(filt.so26, 1440), filt.so26);

// 端到端: financeOverview 选该国家办, sell-in 实际应非0
const o = e.financeOverview({ year: 2026, fromM: 1, toM: 3, reps: [FIN_REP], finUnits: { actual: 'USD', forecast: 'USD', bp: 'USD' }, finQtyUnits: { actual: '台', forecast: '台', bp: '台' } });
ok('financeOverview 选国家办: sellIn.actual=1500', near(o.metrics.sellIn.actual, 1500), { got: o.metrics.sellIn.actual, hint: '修复前=0' });

console.log(f === 0 ? 'ALL PASS' : ('FAILED ' + f));
if (f) process.exitCode = 1;

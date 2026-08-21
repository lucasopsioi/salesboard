// fin-health.test.js — financeHealth 数据体检 + financeOverview 附带 health/finSiAct。
// 场景: 25年只有收入(无收入量)→25年NSIP缺口1个; 26年收入+收入量_终端齐→无缺口;
//       财经国家办 巴西国家办(PSI=巴西终端事业部,归一可匹配) + 智利国家办(PSI无)→psiMismatch.reps=[智利国家办]。
const os = require('os'), fs = require('fs'), path = require('path');
const { Engine } = require('../engine-core'); require('../engine-finance');
let f = 0;
const ok = (n, c, d) => { console.log((c ? 'PASS ' : 'FAIL ') + n + (c ? '' : '  <<< ' + JSON.stringify(d))); if (!c) f++; };
const near = (a, b, e) => a != null && b != null && Math.abs(a - b) <= (e || 1e-6);

const e = new Engine(fs.mkdtempSync(path.join(os.tmpdir(), 'fh-')));
const fin = [];
const A = (rep, lv3, lv4, metric, ym, v) => fin.push(['A', 'ACME', '拉美大区', rep, '', '平板', '平板', lv3, lv4, metric, 1110, ym, v]);
for (let m = 1; m <= 3; m++) {
  // 巴西: 25年只有收入(NSIP缺口), 26年收入+收入量_终端(无缺口)
  A('巴西国家办', 'Slate Pro', 'Tarvos', '净销售收入', 2025 * 100 + m, 80000);
  A('巴西国家办', 'Slate Pro', 'Tarvos', '净销售收入', 2026 * 100 + m, 100000);
  A('巴西国家办', 'Slate Pro', 'Tarvos', '收入量_终端', 2026 * 100 + m, 500);
  A('巴西国家办', 'Slate Pro', 'Tarvos', '销售毛利', 2026 * 100 + m, 25000);
  // 智利: 26年收入+收入量(PSI 无此国家办 → psiMismatch)
  A('智利国家办', 'Slate SE', 'Vantor6', '净销售收入', 2026 * 100 + m, 50000);
  A('智利国家办', 'Slate SE', 'Vantor6', '收入量_终端', 2026 * 100 + m, 300);
}
e._buildFin(fin);
// PSI: 只有 巴西终端事业部(与 巴西国家办 归一匹配), family=Slate Pro/Slate SE, series=Tarvos/Vantor6
const store = [];
for (let m = 1; m <= 3; m++) {
  const p = '2026-' + String(m).padStart(2, '0');
  store.push(['拉美终端事业部', '巴西终端事业部', '巴西', 'Offline', 'Slate Pro', '平板', 'Tarvos', 'PadPro', 'W09', p, 2026 * 10000 + m * 100 + 1, 260, 250, 100, 30]);
  store.push(['拉美终端事业部', '巴西终端事业部', '巴西', 'Offline', 'Slate SE', '平板', 'Vantor6', 'PadSE', 'A6', p, 2026 * 10000 + m * 100 + 1, 100, 90, 50, 30]);
}
e._buildStore([{ mtime: 1, rows: store }]);

const h = e.financeHealth();
ok('hasFin/hasPsi', h.hasFin === true && h.hasPsi === true, h);
ok('rev=净销售收入', h.metricsResolved.rev === '净销售收入', h.metricsResolved);
ok('gm=销售毛利', h.metricsResolved.gm === '销售毛利', h.metricsResolved);
ok('nsipDenoms 含 收入量_终端', (h.metricsResolved.nsipDenoms || []).includes('收入量_终端'), h.metricsResolved.nsipDenoms);
const g25 = (h.nsipGaps || []).find(g => g.year === 2025), g26 = (h.nsipGaps || []).find(g => g.year === 2026);
ok('25年NSIP缺口=1(Tarvos)', g25 && g25.count === 1 && g25.samples.includes('Tarvos'), g25);
ok('26年NSIP缺口=0', g26 && g26.count === 0, g26);
ok('psiMismatch.reps=[智利国家办]', JSON.stringify(h.psiMismatch.reps) === JSON.stringify(['智利国家办']), h.psiMismatch);
ok('巴西国家办 归一后匹配(不在mismatch)', !h.psiMismatch.reps.includes('巴西国家办'), h.psiMismatch.reps);
ok('缓存: 二次调用同一对象', e.financeHealth() === h, null);

const U = { actual: 'USD', forecast: 'USD', bp: 'USD' }, Q = { actual: '台', forecast: '台', bp: '台' };
const o = e.financeOverview({ year: 2026, fromM: 1, toM: 3, finUnits: U, finQtyUnits: Q });
ok('overview 附带 health', o.health && o.health.hasFin === true, o.health);
// 区间 1-3 月累计：每月(500+300)×3 = 2400 (与 financeOverview 其它指标同为区间累计口径)
ok('finSiAct=2400(每月800×3月)', near(o.finSiAct, 2400), o.finSiAct);
ok('finSiPrev=0(25年无收入量)', near(o.finSiPrev, 0), o.finSiPrev);

console.log(f === 0 ? 'ALL PASS' : ('FAILED ' + f));
if (f) process.exitCode = 1;

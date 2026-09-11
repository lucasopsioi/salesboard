const assert = require('assert');
const PM = require('./pricing-model.js');

let fails = 0;
function ok(name, cond) { console.log((cond ? 'PASS ' : 'FAIL ') + name); if (!cond) fails++; }
function approx(name, got, exp, tol) { const c = got != null && Math.abs(got - exp) <= tol; console.log((c ? 'PASS ' : 'FAIL ') + name + '  got=' + (got == null ? 'null' : got.toFixed(4)) + ' exp=' + exp); if (!c) fails++; }

// 成本底表（最小长表）：一个产品 TST，202606 成本 747
const COST_AOA = [['产品型号', 'Attribute', 'Value'], ['TST', 202606, 747], ['TST', 202607, 750], ['OTH', 202606, 100]];

// --- 种子 + 导入 ---
(function () {
  const m = PM.create();
  ok('种子国家=墨西哥', m.order().length === 1 && m.order()[0] === '墨西哥');
  const r = m.importCost(COST_AOA);
  ok('导入产品数=2', r.skus === 2);
  ok('firstSku=TST', m.firstSku() === 'TST');
  ok('导入后首行带出sku', m.rowsOf('墨西哥')[0].sku === 'TST');
  ok('导入后首行带出月份', m.rowsOf('墨西哥')[0].costYm === 202606);
})();

// --- 加/删/重命名国家 ---
(function () {
  const m = PM.create();
  const n = m.addCountry('巴西');
  ok('加国家=巴西', n === '巴西' && m.order().includes('巴西'));
  ok('重名自动改名', m.addCountry('巴西') === '巴西2');
  m.removeCountry('巴西2');
  ok('删国家', !m.order().includes('巴西2'));
  const nn = m.renameCountry('巴西', '阿根廷');
  ok('重命名', nn === '阿根廷' && m.order().includes('阿根廷') && !m.order().includes('巴西'));
})();

// --- setCell 强转 ---
(function () {
  const m = PM.create(); m.importCost(COST_AOA);
  m.setCell('墨西哥', 0, 'retailFront', '28');
  approx('pct列 28→0.28', m.rowsOf('墨西哥')[0].retailFront, 0.28, 1e-9);
  m.setCell('墨西哥', 0, 'rrp', '36999');
  ok('num列不被pct转', m.rowsOf('墨西哥')[0].rrp === 36999);
  m.setCell('墨西哥', 0, 'customer', 'Foo');
  ok('text列原样', m.rowsOf('墨西哥')[0].customer === 'Foo');
  m.setCell('墨西哥', 0, 'weight', '50');
  approx('pct列 weight 50→0.5', m.rowsOf('墨西哥')[0].weight, 0.5, 1e-9);
})();

// --- applyAccount 带出预设 ---
(function () {
  const m = PM.create(); m.importCost(COST_AOA);
  m.applyAccount('墨西哥', 0, 'Telmax');
  const r = m.rowsOf('墨西哥')[0];
  ok('applyAccount 带出渠道', r.channel === 'Telmax');
  approx('applyAccount 带出前向', r.retailFront, 0.28, 1e-9);
  approx('applyAccount 带出后返', r.retailRebate, 0.03, 1e-9);
})();

// --- computeCountry 与引擎对齐（复用 pricing-core.test 基准: Telmax gm1≈0.226） ---
(function () {
  const m = PM.create(); m.importCost(COST_AOA);
  const c = '墨西哥', r0 = m.rowsOf(c)[0];
  Object.assign(r0, { sku: 'TST', customer: 'Telmax', channel: 'Telmax', rrp: 36999, retailFront: 0.28, fsdMargin: 0, retailRebate: 0.03, jointMkt: 0.08, sampleRate: 0.08, promoPrice: 31999, weight: 0, costYm: 202606 });
  const out = m.computeCountry(c);
  approx('computeCountry Telmax NSIP1', out.rows[0].nsip1, 1180.0, 0.2);
  approx('computeCountry Telmax GM1', out.rows[0].gm1, 0.226, 0.001);
})();

// --- bundle 按 国家×产品 隔离 ---
(function () {
  const m = PM.create(); m.importCost(COST_AOA); m.addCountry('巴西');
  m.setBundle('墨西哥', 'TST', 38); m.setBundle('巴西', 'TST', 50);
  ok('bundle 默认=38', m.bundleFor('阿根廷不存在', 'ZZZ') === 38);
  ok('bundle 墨西哥=38', m.bundleFor('墨西哥', 'TST') === 38);
  ok('bundle 巴西=50（隔离）', m.bundleFor('巴西', 'TST') === 50);
})();

// --- 加权按 sku 分组 ---
(function () {
  const m = PM.create(); m.importCost(COST_AOA);
  const c = '墨西哥';
  Object.assign(m.rowsOf(c)[0], { sku: 'TST', rrp: 36999, retailFront: 0.28, weight: 0.5, costYm: 202606 });
  m.addRow(c); Object.assign(m.rowsOf(c)[1], { sku: 'OTH', rrp: 20000, retailFront: 0.2, weight: 1.0, costYm: 202606 });
  const out = m.computeCountry(c);
  ok('weightedBySku 含两产品', !!out.weightedBySku['TST'] && !!out.weightedBySku['OTH']);
  approx('TST 权重合计=0.5', out.weightedBySku['TST'].weightSum, 0.5, 1e-9);
  approx('OTH 权重合计=1.0', out.weightedBySku['OTH'].weightSum, 1.0, 1e-9);
})();

// --- 迁移 v3 ---
(function () {
  const m = PM.create();
  const v3 = {
    countries: { '墨西哥': { fx: 17.32, vat: 0.16, hqRebate: 0, shipping: 20, serviceRate: 0.015, excessiveRate: 0, customsRate: 0.008, erBufferRate: 0.0186 } },
    tables: { '墨西哥|TST': [{ customer: 'A', rrp: 100, retailFront: 0.2, costYm: 202606 }] },
    productBundle: { 'TST': 40 },
    accounts: { 'Telmax': { channel: 'Telmax', retailFront: 0.28, fsdMargin: 0, retailRebate: 0.03, jointMkt: 0.08 } },
    showFloor: false,
  };
  m.migrateV3(v3);
  ok('迁移后行带sku', m.rowsOf('墨西哥')[0].sku === 'TST');
  ok('迁移后行保留customer', m.rowsOf('墨西哥')[0].customer === 'A');
  ok('迁移后bundle落位', m.bundleFor('墨西哥', 'TST') === 40);
  ok('迁移后showFloor', m.state.showFloor === false);
})();

// --- 加权门控: 无成本底价的产品不计入加权(最终评审#1) ---
(function () {
  const m = PM.create();  // 未 importCost → costMap 空, 任何行都无底价
  const c = '墨西哥';
  Object.assign(m.rowsOf(c)[0], { sku: 'NOFLOOR', rrp: 1000, retailFront: 0.2, weight: 1.0 });
  const out = m.computeCountry(c);
  ok('无成本底价的产品不进入 weightedBySku', Object.keys(out.weightedBySku).length === 0);
})();

// --- renameCountry 守卫: 旧名不存在时安全返回(最终评审#2) ---
(function () {
  const m = PM.create();
  const r = m.renameCountry('不存在的国家', 'X');
  ok('renameCountry 旧名不存在时安全返回且不创建新国家', r === '不存在的国家' && !m.order().includes('X') && !m.countries()['X']);
})();

console.log(fails ? ('\n' + fails + ' FAILED') : '\nALL PASS');
process.exit(fails ? 1 : 0);

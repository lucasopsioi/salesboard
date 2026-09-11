const { computePricing } = require('./pricing-core.js');

let fails = 0;
function approx(name, got, exp, tol) {
  const ok = got != null && Math.abs(got - exp) <= tol;
  console.log((ok ? 'PASS ' : 'FAIL ') + name + '  got=' + (got == null ? 'null' : got.toFixed(4)) + ' exp=' + exp);
  if (!ok) fails++;
}

const globals = { fx: 17.32, vat: 0.16, hqRebate: 0 };
const costFloor = 747;

// 共用列
const base = { shipping: 20, serviceRate: 0.015, excessiveRate: 0, customsRate: 0.008,
               erBufferRate: 0.0186, bundle: 38, promoPrice: 31999, coInvestHw: 0 };

const telcel = Object.assign(base, { channel:'Telmax', customer:'Telmax', rrp:36999, retailFront:0.28,
  fsdMargin:0, retailRebate:0.03, jointMkt:0.08, sampleRate:0.08, weight:0 });
const liverpool = Object.assign({...base}, { channel:'RetailKA', customer:'Casona', rrp:36999, retailFront:0.20,
  fsdMargin:0.06, retailRebate:0.08, jointMkt:0.01, sampleRate:0.06, weight:0.10, coInvestHw:0.05 });

const r = computePricing({ globals, costFloor, customers: [telcel, liverpool] });
const T = r.rows[0], L = r.rows[1];

approx('Telmax NSIP-1', T.nsip1, 1180.0, 0.2);
approx('Telmax FOB-1', T.fob1, 1013.8, 0.2);
approx('Telmax GM-1', T.gm1, 0.226, 0.001);
approx('Casona NSIP-1', L.nsip1, 1258.0, 0.2);
approx('Casona FOB-1', L.fob1, 1107.7, 0.2);
approx('Casona GM-1', L.gm1, 0.287, 0.001);

// 促销 + 对投
approx('Telmax AON激励', T.aonIncentive, 179.2, 0.2);
approx('Telmax NSIP-2', T.nsip2, 962.8, 0.3);
approx('Telmax GM-2', T.gm2, 0.052, 0.001);
approx('Telmax GM-3(无对投=GM-2)', T.gm3, 0.052, 0.001);
approx('Casona 对投激励', L.coInvestIncentive, 73.7, 0.2);
approx('Casona GM-3', L.gm3, 0.053, 0.001);

// 13 客户全量加权（验收线）
const C = (o) => Object.assign({ shipping:20, serviceRate:0.015, excessiveRate:0, customsRate:0.008,
  erBufferRate:0.0186, bundle:38, coInvestHw:0 }, o);
const all = [
  C({channel:'Telmax',customer:'Telmax',rrp:36999,retailFront:0.28,fsdMargin:0,retailRebate:0.03,jointMkt:0.08,sampleRate:0.08,promoPrice:31999,weight:0}),
  C({channel:'Riomart',customer:'Riomart',rrp:36999,retailFront:0.08,fsdMargin:0,retailRebate:0.129,jointMkt:0.05,sampleRate:0,promoPrice:31999,weight:0.15}),
  C({channel:'RS',customer:'HES',rrp:36999,retailFront:0.26,fsdMargin:0,retailRebate:0,jointMkt:0.09,sampleRate:0.06,promoPrice:31999,weight:0.10}),
  C({channel:'RetailKA',customer:'Casona',rrp:36999,retailFront:0.20,fsdMargin:0.06,retailRebate:0.08,jointMkt:0.01,sampleRate:0.06,promoPrice:31999,weight:0.10,coInvestHw:0.05}),
  C({channel:'RetailKA',customer:'Corella',rrp:36999,retailFront:0.285,fsdMargin:0.06,retailRebate:0,jointMkt:0.01,sampleRate:0.06,promoPrice:31999,weight:0.05}),
  C({channel:'RetailKA',customer:'Searl',rrp:36999,retailFront:0.20,fsdMargin:0.06,retailRebate:0.027,jointMkt:0.01,sampleRate:0.06,promoPrice:31999,weight:0.02}),
  C({channel:'RetailKA',customer:'Sotano',rrp:36999,retailFront:0.20,fsdMargin:0.06,retailRebate:0.02,jointMkt:0.01,sampleRate:0.06,promoPrice:31999,weight:0.03}),
  C({channel:'RetailKA',customer:'Plaza',rrp:36999,retailFront:0.168,fsdMargin:0.06,retailRebate:0.018,jointMkt:0.04,sampleRate:0,promoPrice:31999,weight:0.10}),
  C({channel:'RetailKA',customer:'Volt',rrp:36999,retailFront:0.18,fsdMargin:0.06,retailRebate:0.022,jointMkt:0.01,sampleRate:0,promoPrice:31999,weight:0}),
  C({channel:'RetailKA',customer:'Mercantil',rrp:36999,retailFront:0.15,fsdMargin:0.06,retailRebate:0.07085,jointMkt:0.01,sampleRate:0,promoPrice:31999,weight:0}),
  C({channel:'Intradex',customer:'PH',rrp:36999,retailFront:0.19,fsdMargin:0.09,retailRebate:0.018,jointMkt:0.03,sampleRate:0.08,promoPrice:31999,weight:0.10}),
  C({channel:'Intradex',customer:'Others',rrp:36999,retailFront:0.19,fsdMargin:0.09,retailRebate:0.018,jointMkt:0.03,sampleRate:0,promoPrice:31999,weight:0}),
  C({channel:'ESHOP',customer:'ESHOP',rrp:24999,retailFront:0,fsdMargin:0,retailRebate:0,jointMkt:0.07,sampleRate:0,promoPrice:24999,weight:0.35}),
];
const W = computePricing({ globals, costFloor, customers: all }).weighted;
approx('加权 GM-1', W.gm1, 0.318, 0.0015);
approx('加权 GM-2', W.gm2, 0.2117, 0.0015);
approx('加权 GM-3', W.gm3, 0.2048, 0.0015);
approx('权重合计', W.weightSum, 1.0, 0.0001);

console.log(fails ? ('\n' + fails + ' FAILED') : '\nALL PASS');
process.exit(fails ? 1 : 0);

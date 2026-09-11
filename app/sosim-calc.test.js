// app/sosim-calc.test.js
const C = require('./sosim-calc.js');
let fails = 0;
const ok = (name, cond) => { console.log((cond ? 'PASS ' : 'FAIL ') + name); if (!cond) fails++; };

const days = [20250101, 20250102, 20250201, 20250202];
const ship = new Map([[20250101, 1000], [20250201, 5000]]);
const sellIn = new Map([[20250101, 800], [20250201, 4000]]);
const sellOut = new Map([[20250101, 500], [20250201, 3000]]);
const invActual = new Map([[20250101, 300]]);          // 实际快照
const r = C.computeInventory({ days, ship, sellIn, sellOut, invActual, cutoffYmd: 20250101 });
ok('fullInv 1/1 = 500', r.fullInv.get(20250101) === 500);          // 0+1000-500
ok('fullInv 2/1 = 2500', r.fullInv.get(20250201) === 2500);        // 500+5000-3000
ok('channel 1/1 actual carry = 300', r.channelInv.get(20250101) === 300);
ok('channel 2/1 forecast = 300+4000-3000=1300', r.channelInv.get(20250201) === 1300);

const rows = C.bucketRows({ days, gran: 'month', ship, sellIn, sellOut, channelInv: r.channelInv, fullInv: r.fullInv });
const feb = rows.find(x => x.bucket === '202502');
ok('feb fullInv=2500', feb.fullInv === 2500);
ok('feb nDays=28', feb.nDays === 28);
ok('feb fullDOS = round(2500*28/3000)', feb.fullDOS === Math.round(2500 * 28 / 3000));

// --- Task 7 ---
const cost = { 202501: 100, 202502: 130 };
const fc = C.fifoCost({ days, ship, sellOut, costForMonth: (ym) => cost[ym] != null ? cost[ym] : null });
// 1月:发1000@100,卖500 → 剩500@100。2月:发5000@130,卖3000 → 先吃500@100,再吃2500@130 → 剩2500@130
const febLayers = fc.layersAt.get(20250201);
ok('feb layers length 1', febLayers.length === 1);
ok('feb remaining 2500@130', febLayers[0].qty === 2500 && febLayers[0].unitCost === 130 && febLayers[0].ym === 202502);
ok('costMissing false', fc.costMissing === false);

const fc2 = C.fifoCost({ days, ship, sellOut, costForMonth: () => null });
ok('costMissing true when no cost', fc2.costMissing === true);

const so2 = new Map([[20250101, 500], [20250201, 6000]]); // 2月卖6000 > 当月可发,且累计SO=6500 > 累计SI=4800
const flags = C.constraintFlags({ days, ship, sellIn, sellOut: so2 });
ok('feb overSI (累计SO6500 > 累计SI4800)', flags.get(20250201).overSI === true);
ok('feb overShip (累计SO6500 > 累计发货6000)', flags.get(20250201).overShip === true);
ok('jan no flag', flags.get(20250101).overSI === false && flags.get(20250101).overShip === false);

// --- Task 11 ---
const days11 = [20250101, 20250102, 20250201, 20250202];
// unit A: 1月发1000@100、卖500;2月发5000@130、卖3000 → 1月末剩500@100;2月末剩2500@130
const uA = { ship: new Map([[20250101,1000],[20250201,5000]]), sellOut: new Map([[20250101,500],[20250201,3000]]), costForMonth: ym => ({202501:100,202502:130}[ym] ?? null) };
// unit B: 2月发1000@200、卖0 → 2月末剩1000@200(同发货月202502,与A合并台数)
const uB = { ship: new Map([[20250201,1000]]), sellOut: new Map(), costForMonth: ym => ({202502:200}[ym] ?? null) };
const comp = C.costComposition({ perUnit: [uA, uB], days: days11, gran: 'month' });
const jan = comp.find(x => x.bucket === '202501'), feb11 = comp.find(x => x.bucket === '202502');
ok('comp jan total 500', jan.total === 500);
ok('comp jan layer 202501 qty500 amount50000', jan.layers.length === 1 && jan.layers[0].ym === 202501 && jan.layers[0].qty === 500 && jan.layers[0].amount === 50000);
ok('comp feb total 3500', feb11.total === 2500 + 1000);
const febLayer = feb11.layers.find(l => l.ym === 202502);
ok('comp feb 202502 merged qty3500', febLayer.qty === 3500);
ok('comp feb 202502 amount = 2500*130+1000*200', febLayer.amount === 2500 * 130 + 1000 * 200);
ok('comp buckets sorted', comp[0].bucket <= comp[comp.length - 1].bucket);

// --- 库存累计性(回归:显示范围起点不该改变已发库存) ---
// 引擎从 days[0] seed 0 累计。同一天(2026-01)的全流程库存,从 2025 起算=含2025发货;
// 只从 2026 起算=漏2025、虚低。故视图必须传"生命周期起点"的 days(本次修复)。
const _daysFull = [20250101, 20260101];
const _invFull = C.computeInventory({ days: _daysFull, ship: new Map([[20250101, 1000], [20260101, 200]]), sellIn: new Map(), sellOut: new Map([[20250101, 300], [20260101, 100]]), invActual: new Map(), cutoffYmd: 20260101 });
ok('全流程库存含2025累计 (1000-300)+(200-100)=800', _invFull.fullInv.get(20260101) === 800);
const _invNarrow = C.computeInventory({ days: [20260101], ship: new Map([[20260101, 200]]), sellIn: new Map(), sellOut: new Map([[20260101, 100]]), invActual: new Map(), cutoffYmd: 20260101 });
ok('只从2026起算漏2025(=100,虚低)→ 证明视图须从生命周期起点', _invNarrow.fullInv.get(20260101) === 100);

// --- fifoRemaining: 全流程剩余库存(FIFO,≥0,超卖不为负) ---
const _frRem = C.fifoRemaining({ days: [20250101, 20250201], ship: new Map([[20250101, 1000], [20250201, 500]]), sellOut: new Map([[20250101, 300], [20250201, 2000]]) });
ok('fifoRemaining 1月 = 1000-300 = 700', _frRem.get(20250101) === 700);
ok('fifoRemaining 2月超卖 → 0(不为负)', _frRem.get(20250201) === 0);   // 可消耗(700+500)=1200 < 需2000 → 剩0
// 多型号求和单调:正库存型号 + 超卖型号，各自≥0 求和 ≥ 单个正库存型号
const _frA = C.fifoRemaining({ days: [20250101], ship: new Map([[20250101, 500]]), sellOut: new Map() }).get(20250101);
const _frB = C.fifoRemaining({ days: [20250101], ship: new Map(), sellOut: new Map([[20250101, 300]]) }).get(20250101);
ok('超卖型号剩余=0(不拖累汇总)', _frB === 0 && (_frA + _frB) === 500);

// --- pooledFifo:汇总口径(池化)FIFO —— 多国家/多型号"同一成本加总",总SO统一消耗 ---
{
  // A 单元 1/1 发 100(成本10);B 单元无发货、1/2 SO 60 → 池化后 B 的 SO 消耗 A 的层(跨单元)。
  const pdays = [20250101, 20250102, 20250103];
  const A = { ship: new Map([[20250101, 100]]), sellOut: new Map(), costForMonth: () => 10 };
  const B = { ship: new Map(), sellOut: new Map([[20250102, 60]]), costForMonth: () => 99 };
  const rp = C.pooledFifo({ perUnit: [A, B], days: pdays, gran: 'day' });
  ok('pooled 跨单元消耗:1/2 剩 40', rp.remainByDay.get(20250102) === 40);
  ok('pooled 层成本按发货单元(10 非 99):amount=400', Math.abs(rp.comp[1].layers[0].amount - 400) < 1e-9);
  ok('pooled comp.total 与 remainByDay 同源一致', rp.comp[2].total === rp.remainByDay.get(20250103));
  // 对照:逐单元口径 A 自身无 SO → 永久残留 100(这正是多选国家时老月份小层密密麻麻的根因)
  const perRem = C.fifoRemaining({ days: pdays, ship: A.ship, sellOut: A.sellOut });
  ok('对照 per-unit 口径残留 100(池化才被消耗)', perRem.get(20250103) === 100);
}
{
  // 整个作用域无任何 SO → 层保留(不误删);超卖(SO>发货)→ 剩余 0 不为负。
  const d2 = [20250101, 20250102];
  const N = { ship: new Map([[20250101, 50]]), sellOut: new Map(), costForMonth: () => 5 };
  const r2 = C.pooledFifo({ perUnit: [N], days: d2, gran: 'day' });
  ok('pooled 无SO层保留 50', r2.remainByDay.get(20250102) === 50 && r2.comp[1].total === 50);
  const OV = { ship: new Map([[20250101, 30]]), sellOut: new Map([[20250101, 80]]), costForMonth: () => 1 };
  const r3 = C.pooledFifo({ perUnit: [OV], days: [20250101], gran: 'day' });
  ok('pooled 超卖剩余=0 不为负', r3.remainByDay.get(20250101) === 0);
}
{
  // 月粒度:桶末快照;同发货月多单元层合并(qty 累加、amount=各自 qty×型号成本 累加)。
  const d3 = []; for (let dd = 1; dd <= 31; dd++) d3.push(20250100 + dd);
  const A3 = { ship: new Map([[20250105, 10]]), sellOut: new Map(), costForMonth: () => 10 };
  const B3 = { ship: new Map([[20250110, 20]]), sellOut: new Map(), costForMonth: () => 40 };
  const r4 = C.pooledFifo({ perUnit: [A3, B3], days: d3, gran: 'month' });
  ok('pooled 月粒度单桶快照', r4.comp.length === 1 && String(r4.comp[0].bucket) === '202501');
  ok('pooled 同月层合并 qty=30 amount=10*10+20*40=900', r4.comp[0].total === 30 && Math.abs(r4.comp[0].layers[0].amount - 900) < 1e-9);
}

console.log(fails ? ('\n' + fails + ' FAILED') : '\nALL PASS');
process.exit(fails ? 1 : 0);

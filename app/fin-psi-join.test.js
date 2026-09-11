// fin-psi-join.test.js — 端到端验证：当财经名称与 PSI 名称对齐时，
// 逐组(国家办/产品系列) sell-in/out 真实 join 出数（demo 因名称不对齐无法覆盖此路径）。
// 自编对齐数据：财经 rep/lv3/lv4 == PSI repOffice/family/series。
const os = require('os'), fs = require('fs'), path = require('path');
const { Engine } = require('../engine-core');
require('../engine-finance');
const ok = (n, c, d) => console.log((c ? 'PASS' : 'FAIL') + ' ' + n + (c ? '' : ' :: ' + JSON.stringify(d)));
const near = (a, b, e = 1e-6) => a != null && b != null && Math.abs(a - b) <= Math.max(e, Math.abs(b) * 1e-9);

const e = new Engine(fs.mkdtempSync(path.join(os.tmpdir(), 'join-')));

// ---- 维度（财经与 PSI 对齐）----
const REPS = ['深圳国家办', '北京国家办'];
const FAMS = ['Slate Pro系列', 'Slate Air系列'];   // 财经 lv3 == PSI family
const SER = { 'Slate Pro系列': 'Slate Pro 13.2', 'Slate Air系列': 'Slate Air 12' }; // 财经 lv4 == PSI series
const MONTHS = [1, 2, 3];

// ---- 财经底表（this.fin）：[src,brand,region,rep,country,lv1,lv2,lv3,lv4,metric,order,ym,val,version] ----
const REV = '净销售收入', GM = '销售毛利', SI = 'Sell in量', SO = 'Sell out量';
const finRows = [];
REPS.forEach(rep => FAMS.forEach(fam => {
  const lv4 = SER[fam];
  const base = ['?', 'ACME', '华南', rep, '中国', '平板', '平板', fam, lv4];
  const A = (metric, ord, ym, v) => finRows.push(['A', ...base.slice(1), metric, ord, ym, v]);
  const F = (metric, ord, ym, v) => finRows.push(['F', ...base.slice(1), metric, ord, ym, v, 'RepVer']);
  const B = (metric, ord, ym, v) => finRows.push(['B', ...base.slice(1), metric, ord, ym, v, 'BPVer']);
  MONTHS.forEach(m => {
    // 今年实际(2026 1-3月)
    A(REV, 1110, 2026 * 100 + m, 100000); A(GM, 1300, 2026 * 100 + m, 25000);
    A(SI, 55, 2026 * 100 + m, 500); A(SO, 60, 2026 * 100 + m, 480);
    // 去年同期(2025 1-3月)
    A(REV, 1110, 2025 * 100 + m, 90000); A(GM, 1300, 2025 * 100 + m, 21600);
    A(SI, 55, 2025 * 100 + m, 450); A(SO, 60, 2025 * 100 + m, 430);
  });
  for (let m = 1; m <= 12; m++) {  // 预测/BP 全年
    F(REV, 1110, 2026 * 100 + m, 110000); F(GM, 1300, 2026 * 100 + m, 28000);
    F(SI, 55, 2026 * 100 + m, 520); F(SO, 60, 2026 * 100 + m, 500);
    B(REV, 1110, 2026 * 100 + m, 105000); B(GM, 1300, 2026 * 100 + m, 27000);
    B(SI, 55, 2026 * 100 + m, 510); B(SO, 60, 2026 * 100 + m, 490);
  }
}));
e._buildFin(finRows);

// ---- PSI store（this.store）：DIM_KEYS=[region,repOffice,country,channel,family,line,series,product,model] ----
// 行: [region,repOffice,country,channel,family,line,series,product,model, periodLabel, ymd, sellIn, sellOut, inv, dos]
const storeRows = [];
REPS.forEach(rep => FAMS.forEach(fam => {
  const ser = SER[fam];
  MONTHS.forEach(m => {
    // periodLabel(r9) 必须按期唯一，否则 _buildStore 按 [dims+periodLabel] 去重会塌缩跨期行
    const p26 = '2026-' + String(m).padStart(2, '0'), p25 = '2025-' + String(m).padStart(2, '0');
    storeRows.push(['华南', rep, '中国', 'Total', fam, '平板', ser, ser, ser + '-M', p26, 2026 * 10000 + m * 100 + 1, 550, 520, 100, 30]);
    storeRows.push(['华南', rep, '中国', 'Total', fam, '平板', ser, ser, ser + '-M', p25, 2025 * 10000 + m * 100 + 1, 500, 470, 90, 28]);
  });
}));
e._buildStore([{ mtime: 1, rows: storeRows }]);

console.log('--- 数据规模: fin rows=' + finRows.length + ' store rows=' + storeRows.length + ' ---');

const P = { actual: 'USD', forecast: 'USD', bp: 'USD' };
const baseP = { year: 2026, fromM: 1, toM: 3, version: 'RepVer', bpVersion: 'BPVer', finUnits: P };

// ===== 1) financeOverview：总数对齐 =====
const o = e.financeOverview(baseP);
const M = o.metrics;
// 4 叶 × 3 月: rev=4*3*100000=1,200,000 ; sellIn(PSI)=4*3*550=6,600 ; sellOut(PSI)=4*3*520=6,240
ok('overview rev.actual=1.2M', near(M.rev.actual, 1200000), M.rev.actual);
ok('overview sellIn.actual(PSI)=6600', near(M.sellIn.actual, 6600), M.sellIn.actual);
ok('overview sellOut.actual(PSI)=6240', near(M.sellOut.actual, 6240), M.sellOut.actual);
// 同比: 2025 rev=4*3*90000=1,080,000 → yoy=(1.2M-1.08M)/1.08M
ok('overview rev.yoy correct', near(M.rev.yoy, (1200000 - 1080000) / 1080000), M.rev.yoy);
// BP 全年: rev.bp=4*12*105000=5,040,000 ; bpAttain=1.2M/5.04M
ok('overview rev.bp=5.04M(full-year)', near(M.rev.bp, 5040000), M.rev.bp);
ok('overview rev.bpAttain=1.2M/5.04M', near(M.rev.bpAttain, 1200000 / 5040000), M.rev.bpAttain);
// 预测全年: rev.fc=4*12*110000=5,280,000
ok('overview rev.fc=5.28M(full-year)', near(M.rev.fc, 5280000), M.rev.fc);
// sellIn 目标(财经): bp=4*12*510=24,480 ; fc=4*12*520=24,960
ok('overview sellIn.bp(财经)=24480', near(M.sellIn.bp, 24480), M.sellIn.bp);
ok('overview sellIn.fc(财经)=24960', near(M.sellIn.fc, 24960), M.sellIn.fc);
// 销毛率: gm.act=4*3*25000=300,000 ; gmr=300000/1.2M=0.25
ok('overview gmr.actual=0.25', near(M.gmr.actual, 0.25), M.gmr.actual);
// NSIP=rev/收入量(Sell in量) actual: 1.2M / (4*3*500=6000) = 200
ok('overview nsip.actual=rev/收入量=200', near(M.nsip.actual, 200), M.nsip.actual);

// ===== 2) financeCustom：逐组 sell-in/out 真实出数（demo 缺口）=====
// rowDim=rep, basis=actual, sellIn: 每个 rep = 2 family × 3 月 × 550 = 3,300（非0！）
const cRep = e.financeCustom({ ...baseP, rowDim: 'rep', metrics: ['rev', 'sellIn', 'sellOut', 'nsip'], basis: 'actual' });
const repRow = cRep.rows.find(r => r.key === '深圳国家办');
ok('custom rep 深圳 存在', !!repRow, cRep.rows.map(r => r.key));
ok('custom rep 深圳 sellIn=3300(非0)', repRow && near(repRow.sellIn, 3300), repRow && repRow.sellIn);
ok('custom rep 深圳 sellOut=3120(非0)', repRow && near(repRow.sellOut, 3120), repRow && repRow.sellOut);
ok('custom rep total.sellIn=6600=overview', near(cRep.total.sellIn, 6600), cRep.total.sellIn);
ok('custom rep total.rev=overview rev.actual', near(cRep.total.rev, M.rev.actual), { c: cRep.total.rev, o: M.rev.actual });
// rowDim=lv3(产品系列), sellIn: 每个 family = 2 rep × 3 月 × 550 = 3,300（非0！）
const cFam = e.financeCustom({ ...baseP, rowDim: 'lv3', metrics: ['sellIn', 'nsip'], basis: 'actual' });
const famRow = cFam.rows.find(r => r.key === 'Slate Pro系列');
ok('custom lv3 Slate Pro系列 sellIn=3300(非0)', famRow && near(famRow.sellIn, 3300), famRow && famRow.sellIn);
// basis=bp: rev 取全年 BP（per group = 12月×105000=1,260,000/leaf；rep级=2 leaf=2,520,000）
const cRepBp = e.financeCustom({ ...baseP, rowDim: 'rep', metrics: ['rev', 'sellIn'], basis: 'bp' });
ok('custom rep basis=bp rev=全年BP', near(cRepBp.total.rev, 5040000), cRepBp.total.rev);
ok('custom rep basis=bp sellIn=财经BP目标', near(cRepBp.total.sellIn, 24480), cRepBp.total.sellIn);

// ===== 3) financeProductBoard / financeRepBoard 跨方法对账 =====
const pb = e.financeProductBoard(baseP);
ok('productBoard line.total.rev26=overview', near(pb.line.total.rev26, M.rev.actual), { p: pb.line.total.rev26, o: M.rev.actual });
ok('productBoard line.total.bp=全年BP', near(pb.line.total.bp, 5040000), pb.line.total.bp);
const rb = e.financeRepBoard({ ...baseP });
ok('repBoard repTable.total.rev26=overview', near(rb.repTable.total.rev26, M.rev.actual), { r: rb.repTable.total.rev26, o: M.rev.actual });
// repBoard 国家办行存在且 rev26 = 2 family×3月×100000 = 600,000
const rbRow = rb.repTable.rows.find(r => r.key === '深圳国家办');
ok('repBoard 深圳 rev26=600000', rbRow && near(rbRow.rev26, 600000), rbRow && rbRow.rev26);

// ===== 4) 筛选联动：只选深圳 → 总数减半 =====
const oSz = e.financeOverview({ ...baseP, reps: ['深圳国家办'] });
ok('overview reps=深圳 rev=600000(半)', near(oSz.metrics.rev.actual, 600000), oSz.metrics.rev.actual);
ok('overview reps=深圳 sellIn=3300(PSI亦随筛选)', near(oSz.metrics.sellIn.actual, 3300), oSz.metrics.sellIn.actual);
// 只选某产品系列 lv3 → PSI 亦随筛选
const oFam = e.financeOverview({ ...baseP, lv3: ['Slate Pro系列'] });
ok('overview lv3=Pro系列 sellIn=3300', near(oFam.metrics.sellIn.actual, 3300), oFam.metrics.sellIn.actual);

console.log('ALL PASS');

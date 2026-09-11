// fin-realfmt.test.js — 用"真实底表格式"的自编数据复现并验证两个解析/口径 bug：
//  (1) NSIP 跨表名不一致：实际表 SI量=收入量_终端，预测/BP=收入量 → 单一名解析使 NSIP 实际为空。
//  (2) 数量单位不统一：实际/PSI=台(原始)，预测=万台，BP=百万 → SI/SO 量与达成率被放大/缩小。
// 断言的是【修复后】的正确值；修复前应 FAIL。
const os = require('os'), fs = require('fs'), path = require('path');
const { Engine } = require('../engine-core'); require('../engine-finance');
let f = 0;
const ok = (n, c, d) => { console.log((c ? 'PASS ' : 'FAIL ') + n + (c ? '' : '  <<< ' + JSON.stringify(d))); if (!c) f++; };
const near = (a, b, e) => a != null && b != null && Math.abs(a - b) <= (e || Math.max(1e-6, Math.abs(b) * 1e-6));

const e = new Engine(fs.mkdtempSync(path.join(os.tmpdir(), 'rf-')));
const reps = ['巴西国家办', '哥伦比亚国家办'];
const LV = ['平板', '平板', 'Slate Pro系列', 'Vantor6'];   // lv1..lv4 ; lv3=family, lv4=series 对齐 PSI

// ---- this.fin: 实际(A)/预测(F)/BP(B)，真实跨表命名 + 真实单位写法 ----
// 行: [src,brand,region,rep,country,lv1,lv2,lv3,lv4,metric,order,ym,val,version?]
const fin = [];
const A = (rep, metric, ord, ym, v) => fin.push(['A', 'ACME', '拉美大区', rep, '巴西', LV[0], LV[1], LV[2], LV[3], metric, ord, ym, v]);
const F = (rep, metric, ord, ym, v) => fin.push(['F', 'ACME', '拉美大区', rep, '', LV[0], LV[1], LV[2], LV[3], metric, ord, ym, v, '大区预测版本']);
const B = (rep, metric, ord, ym, v) => fin.push(['B', '', '拉美大区', rep, '', LV[0], LV[1], LV[2], LV[3], metric, ord, ym, v, '国家办工作底稿']);
reps.forEach(rep => {
  for (let m = 1; m <= 3; m++) {
    // 实际：金额=USD原值；收入量_终端=台原值
    A(rep, '净销售收入', 1110, 2026 * 100 + m, 100000);  A(rep, '净销售收入', 1110, 2025 * 100 + m, 90000);
    A(rep, '销售毛利', 2200, 2026 * 100 + m, 25000);     A(rep, '销售毛利', 2200, 2025 * 100 + m, 22500);
    A(rep, '收入量_终端', 1500, 2026 * 100 + m, 500);    A(rep, '收入量_终端', 1500, 2025 * 100 + m, 450);
  }
  for (let m = 1; m <= 12; m++) {
    // 预测：金额=百万美元(0.11=11万美元)；数量=万台(0.05=500台)
    F(rep, '净销售收入', 1110, 2026 * 100 + m, 0.11);
    F(rep, '销售毛利', 2200, 2026 * 100 + m, 0.028);
    F(rep, '收入量', 1200, 2026 * 100 + m, 0.05);       // 预测叫"收入量"(非"收入量_终端")
    F(rep, 'Sell in量', 9100, 2026 * 100 + m, 0.052);
    F(rep, 'Sell out量', 9200, 2026 * 100 + m, 0.05);
    // BP：金额=百万美元；数量=百万(0.0005=500台)
    B(rep, '净销售收入', 1110, 2026 * 100 + m, 0.105);
    B(rep, '销售毛利', 2200, 2026 * 100 + m, 0.027);
    B(rep, '收入量', 1200, 2026 * 100 + m, 0.0005);
    B(rep, 'Sell in量', 9100, 2026 * 100 + m, 0.00052);
    B(rep, 'Sell out量', 9200, 2026 * 100 + m, 0.0005);
  }
});
e._buildFin(fin);

// ---- this.store: PSI 实际 sell-in/out，台(原始)，名称对齐(repOffice/family/series) ----
// 行: [region,repOffice,country,channel,family,line,series,product,model, periodLabel, ymd, sellIn,sellOut,inv,dos]
const store = [];
reps.forEach(rep => { for (let m = 1; m <= 3; m++) {
  const p = '2026-' + String(m).padStart(2, '0');
  store.push(['拉美大区', rep, '巴西', 'Total', LV[2], LV[0], LV[3], LV[3], LV[3] + 'M', p, 2026 * 10000 + m * 100 + 1, 500, 480, 100, 30]);
  const p5 = '2025-' + String(m).padStart(2, '0');
  store.push(['拉美大区', rep, '巴西', 'Total', LV[2], LV[0], LV[3], LV[3], LV[3] + 'M', p5, 2025 * 10000 + m * 100 + 1, 450, 430, 90, 28]);
}});
e._buildStore([{ mtime: 1, rows: store }]);

// 金额单位(沿用现有 finUnits) + 数量单位(新增 finQtyUnits)
const P = {
  year: 2026, fromM: 1, toM: 3, version: '大区预测版本',
  finUnits: { actual: 'USD', forecast: '百万美元', bp: '百万美元' },
  finQtyUnits: { actual: '台', forecast: '万', bp: '百万' },   // 新增：数量单位归一(台=1,万=1e4,百万=1e6)
};
const o = e.financeOverview(P);
const M = o.metrics;

// ===== bug1: NSIP 实际(净收入/收入量) —— 收入量_终端 在实际表，应被算到 =====
// 实际净收入 = 2 rep × 3 月 × 100000 = 600000(USD) ; 收入量 = 2×3×500 = 3000(台) ; NSIP = 200
ok('rev.actual=600000(USD)', near(M.rev.actual, 600000), M.rev.actual);
ok('nsip.actual=200(净收入/收入量_终端)', near(M.nsip.actual, 200), { got: M.nsip.actual, hint: '修复前应为 null' });

// ===== bug2: 数量单位归一 —— sell-in/out 目标换算到台，与 PSI(台) 同口径 =====
// PSI 实际 sellIn = 2×3×500 = 3000 台
ok('sellIn.actual(PSI)=3000台', near(M.sellIn.actual, 3000), M.sellIn.actual);
// 预测 Sell in量 全年 = 2 rep × 12 月 × 0.052(万) = 1.248 万 ×1e4 = 12480 台
ok('sellIn.fc=12480台(0.052万×24归一)', near(M.sellIn.fc, 12480), { got: M.sellIn.fc, hint: '修复前为 1.248(未归一)' });
// BP Sell in量 全年 = 2×12×0.00052(百万) = 0.01248 百万 ×1e6 = 12480 台
ok('sellIn.bp=12480台(0.00052百万×24归一)', near(M.sellIn.bp, 12480), { got: M.sellIn.bp, hint: '修复前为 0.01248' });
// Sell out
ok('sellOut.fc=12000台', near(M.sellOut.fc, 12000), M.sellOut.fc);
ok('sellOut.bp=12000台', near(M.sellOut.bp, 12000), M.sellOut.bp);
// 达成率 = PSI实际(3个月) / 全年目标(台) ，量级合理(非被单位放大成天文数字或缩成0)
ok('sellIn.bpAttain 合理(0<x<1)', M.sellIn.bpAttain > 0 && M.sellIn.bpAttain < 1, M.sellIn.bpAttain);

// 金额达成率不受数量单位影响(回归)
ok('rev.bp=2.52M USD(0.105百万×24)', near(M.rev.bp, 2520000), M.rev.bp);
ok('gmr.actual=0.25', near(M.gmr.actual, 0.25), M.gmr.actual);

console.log(f === 0 ? 'ALL PASS' : ('FAILED ' + f));
if (f) process.exitCode = 1;

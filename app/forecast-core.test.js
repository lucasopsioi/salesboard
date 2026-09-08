// app/forecast-core.test.js — SO 推演内核：日销/占比拆分/库存滚动/DOS
const F = require('./forecast-core.js');
let f = 0; const ok = (n, c, d) => { console.log((c ? 'PASS ' : 'FAIL ') + n + (!c && d !== undefined ? '  << ' + JSON.stringify(d) : '')); if (!c) f++; };
const near = (a, b, e) => a != null && Math.abs(a - b) <= (e || 1e-6);

// —— 日销 / 周销（口径：近28天 ÷ 28，不是 ÷ 有数天数）——
const d28 = new Array(28).fill(10);
ok('R1 近28天日销 = 总量/28', F.dailyRunRate(d28) === 10);
ok('R2 只取最近28天', F.dailyRunRate(new Array(50).fill(5).concat(new Array(28).fill(20))) === 20);
ok('R3 缺数不补零但分母仍是28', near(F.dailyRunRate([null, null].concat(new Array(26).fill(28))), 26 * 28 / 28));
ok('R4 全无数据 → null（不是0）', F.dailyRunRate([null, null]) === null && F.dailyRunRate([]) === null);
ok('R5 平均周销 = 日销×7', F.weeklyFromDaily(10) === 70 && F.weeklyFromDaily(null) === null);

// —— 历史 SI 占比 ——
ok('S1 占比按 SI 归一', (() => { const s = F.siShares({ A1: 600, A2: 400 }); return near(s.A1, 0.6) && near(s.A2, 0.4); })());
ok('S2 合计为0 → null（无从分摊）', F.siShares({ A1: 0, A2: 0 }) === null);
ok('S3 负数不参与', (() => { const s = F.siShares({ A1: 100, A2: -50 }); return near(s.A1, 1) && s.A2 === 0; })());

// —— 拆分守恒（用户的原例）——
const sp = F.splitInt(1000, { A1: 0.6, A2: 0.4 });
ok('P1 用户原例：1000 按 60/40 → 600/400', sp.A1 === 600 && sp.A2 === 400, sp);
const sp3 = F.splitInt(1000, { A: 1 / 3, B: 1 / 3, C: 1 / 3 });
ok('P2 除不尽也要和守恒（334/333/333）', sp3.A + sp3.B + sp3.C === 1000, sp3);
const sp4 = F.splitInt(7, { A: 0.5, B: 0.5 });
ok('P3 奇数按最大余数补齐，和=7', sp4.A + sp4.B === 7, sp4);
ok('P4 单型号拿全部', F.splitInt(123, { A: 1 }).A === 123);
ok('P5 结果稳定可复现', JSON.stringify(F.splitInt(1000, { A: 1 / 3, B: 1 / 3, C: 1 / 3 })) === JSON.stringify(sp3));

// —— 库存滚动 ——
const roll = F.rollInventory(500, [{ si: 100, so: 200 }, { si: 300, so: 150 }], 'week');
ok('I1 期末库存 = 期初 + SI − SO', roll[0].inv === 400 && roll[1].inv === 550, roll.map(r => r.inv));
ok('I2 周粒度每期 7 天', roll[0].days === 7);
ok('I3 月粒度默认 30 天、天粒度 1 天', F.periodDays('month') === 30 && F.periodDays('day') === 1);

// —— DOS ——
ok('D1 DOS = 库存 ÷ 日销', F.dosOf(280, 10) === 28);
ok('D2 日销为0/未知 → null（不写0天）', F.dosOf(280, 0) === null && F.dosOf(280, null) === null);
ok('D3 库存未知 → null', F.dosOf(null, 10) === null);
ok('D4 库存为负(计划超卖) → DOS 显 null，不给「负的可供天数」', F.dosOf(-500, 10) === null);

// —— 完整推演：DOS 随 SO/SI 变化 ——
const sim = F.simulate({ openInv: 700, histDaily: new Array(28).fill(10), periods: [{ si: 0, so: 70 }, { si: 0, so: 70 }], gran: 'week' });
ok('T1 两周不进货，库存递减', sim[0].inv === 630 && sim[1].inv === 560, sim.map(r => r.inv));
ok('T2 日销稳定在10 → DOS 跟着库存降', near(sim[0].rate, 10) && near(sim[0].dos, 63) && near(sim[1].dos, 56), sim.map(r => [r.rate, r.dos]));
const sim2 = F.simulate({ openInv: 700, histDaily: new Array(28).fill(10), periods: [{ si: 0, so: 140 }], gran: 'week' });
ok('T3 SO 翻倍 → 日销上升、DOS 下降', sim2[0].rate > 10 && sim2[0].dos < 63, [sim2[0].rate, sim2[0].dos]);
const sim3 = F.simulate({ openInv: 700, histDaily: new Array(28).fill(10), periods: [{ si: 500, so: 70 }], gran: 'week' });
ok('T4 补货 → 库存与 DOS 同时上升', sim3[0].inv === 1130 && sim3[0].dos > 63, [sim3[0].inv, sim3[0].dos]);

// —— 产品级推演分摊到型号（用户原例的完整版）——
const pr = F.simulateProduct({
  gran: 'month',
  productPeriods: [{ so: 1000 }],
  models: [
    { key: 'A1', openInv: 3000, histDaily: new Array(28).fill(20), histSi: 600 },
    { key: 'A2', openInv: 2600, histDaily: new Array(28).fill(13), histSi: 400 },
  ],
});
ok('M1 占比来自历史SI：60/40', near(pr.shares.A1, 0.6) && near(pr.shares.A2, 0.4), pr.shares);
ok('M2 12月 SO 1000 → A1=600 / A2=400', pr.byModel.A1[0].so === 600 && pr.byModel.A2[0].so === 400);
ok('M3 型号 SO 之和 = 产品级 SO', pr.totals[0].so === 1000, pr.totals);
// 各型号必须用「自己的期末库存 ÷ 自己的日销」，不是拿产品级 DOS 摊派
ok('M4 型号 DOS = 自己的库存 ÷ 自己的日销', (() => {
  const a = pr.byModel.A1[0], b = pr.byModel.A2[0];
  return near(a.dos, a.inv / a.rate) && near(b.dos, b.inv / b.rate) && !near(a.dos, b.dos, 1e-3);
})(), [pr.byModel.A1[0], pr.byModel.A2[0]].map(r => [r.inv, r.rate, r.dos]));
const pr2 = F.simulateProduct({ gran: 'month', productPeriods: [{ so: 1000, si: 1200 }], models: [{ key: 'A1', openInv: 0, histDaily: [], histSi: 600 }, { key: 'A2', openInv: 0, histDaily: [], histSi: 400 }] });
ok('M5 给了产品级 SI 就按同一占比分摊', pr2.byModel.A1[0].si === 720 && pr2.byModel.A2[0].si === 480, pr2.totals);
ok('M6 没有历史SI时退化为均分（不崩）', (() => { const r = F.simulateProduct({ productPeriods: [{ so: 10 }], models: [{ key: 'X', histSi: 0 }, { key: 'Y', histSi: 0 }] }); return r.byModel.X[0].so + r.byModel.Y[0].so === 10; })());

// —— 历史 + 推演拼成一条时间线（用户：需要历史辅助判断）——
const wh = F.simulateWithHistory({
  gran: 'week',
  histRows: [{ si: 100, so: 70, inv: 500 }, { si: 0, so: 70, inv: 430 }],
  periods: [{ si: 0, so: 70 }, { si: 0, so: 70 }],
});
ok('H1 历史期照搬实际库存，不重算', wh.hist[0].inv === 500 && wh.hist[1].inv === 430, wh.hist.map(r => r.inv));
ok('H2 推演期初库存接最后一期历史实际值', wh.forecast[0].inv === 360, wh.forecast.map(r => r.inv));
ok('H3 历史期也算出 DOS', wh.hist[1].dos != null && wh.hist[1].dos > 0, wh.hist[1].dos);
ok('H4 推演首期的近28天日销能回看到历史 SO', near(wh.forecast[0].rate, 10, 1e-6), wh.forecast[0].rate);
// 窗口填满时分母就是 28（与原口径一致）；不满时按实际覆盖天数，避免低估日销/高估 DOS
const long = F.simulateWithHistory({ gran: 'week', histRows: [70, 70, 70, 70].map(v => ({ si: 0, so: v, inv: 1000 })), periods: [{ si: 0, so: 70 }] });
ok('H4b 回看满 28 天时日销 = 总量/28', near(long.forecast[0].rate, 10, 1e-6), long.forecast[0].rate);
ok('H5 历史标记 hist=true、推演没有', wh.hist.every(r => r.hist === true) && wh.forecast.every(r => !r.hist));
ok('H6 无历史时退回用 openInv', F.simulateWithHistory({ gran: 'week', histRows: [], openInv: 800, periods: [{ si: 0, so: 100 }] }).forecast[0].inv === 700);
const pwh = F.simulateProductWithHistory({
  gran: 'month',
  productPeriods: [{ so: 1000 }],
  models: [
    { key: 'A1', histSi: 600, histRows: [{ si: 600, so: 500, inv: 2000 }] },
    { key: 'A2', histSi: 400, histRows: [{ si: 400, so: 300, inv: 1500 }] },
  ],
});
ok('H7 产品级带历史：未来仍按 60/40 分摊', pwh.byModel.A1.forecast[0].so === 600 && pwh.byModel.A2.forecast[0].so === 400);
// 推演首期库存 = 历史期末实际库存 + 本期SI − 本期SO（没给 SI 就是 0，库存必然下降）
ok('H8 各型号推演接自己的历史期末库存并按 SI/SO 滚动', (() => {
  const a = pwh.byModel.A1, b = pwh.byModel.A2;
  return a.forecast[0].inv === 2000 + a.forecast[0].si - a.forecast[0].so
      && b.forecast[0].inv === 1500 + b.forecast[0].si - b.forecast[0].so;
})(), [pwh.byModel.A1.forecast[0], pwh.byModel.A2.forecast[0]].map(r => [r.si, r.so, r.inv]));
// 核心因果：只改 SO 时库存必须跟着变（SI 不许跟随 SO，否则增减抵消、库存永远不动）
ok('H9 只调 SO → 库存随之变化（SI 不跟随 SO）', (() => {
  const mk = so => F.simulateWithHistory({ gran: 'month', histRows: [{ si: 500, so: 400, inv: 3000 }], periods: [{ so: so }] }).forecast[0];
  const lo = mk(100), hi = mk(900);
  return lo.inv === 2900 && hi.inv === 2100 && lo.si === 0 && hi.si === 0;
})());

console.log(f ? (f + ' FAILED') : 'ALL PASS');
process.exit(f ? 1 : 0);

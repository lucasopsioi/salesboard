(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.PricingCore = api;
})(this, function () {

  function num(v) { return (v == null || isNaN(v)) ? 0 : +v; }

  function computeRow(c, g, costFloor) {
    const fx = num(g.fx) || 1, vat = num(g.vat), hqRebate = num(g.hqRebate);
    const cf = (c.costFloor != null && !isNaN(+c.costFloor)) ? +c.costFloor : costFloor;  // 每行可用各自月份的Floor cost
    const rrpExVat = num(c.rrp) / (1 + vat);
    const stpMxn = rrpExVat * (1 - num(c.retailFront));        // 零售前向：按售价减成
    const stpUsd = stpMxn / fx;
    const sipMxn = stpMxn / (1 + num(c.fsdMargin));            // 物流点位：按成本加成
    const sipUsd = sipMxn / fx;
    const nsip1 = sipUsd - num(c.retailRebate) * stpUsd - num(c.jointMkt) * sipUsd;
    const factorRates = num(c.serviceRate) + num(c.excessiveRate) + num(c.sampleRate) + num(c.customsRate);
    const fob1 = nsip1 - num(c.shipping) - factorRates * nsip1 - num(c.erBufferRate) * sipUsd;
    const gm1 = nsip1 > 0 ? (fob1 - cf - hqRebate) / nsip1 : null;

    // 促销档（AON + bundle）
    const promoStpUsd = (num(c.promoPrice) / (1 + vat)) * (1 - num(c.retailFront)) / fx;
    const aonIncentive = stpUsd - promoStpUsd;
    const fobPromo = fob1 - aonIncentive;                 // 促销价后(未扣bundle)
    const nsipPromo = nsip1 - aonIncentive;
    const gmPromo = nsipPromo > 0 ? (fobPromo - cf - hqRebate) / nsipPromo : null;
    const fob2 = fob1 - aonIncentive - num(c.bundle);
    const nsip2 = nsip1 - aonIncentive - num(c.bundle);
    const gm2 = nsip2 > 0 ? (fob2 - cf - hqRebate) / nsip2 : null;

    // 对投档（仅 coInvestHw>0 的客户；客户自投不进账）
    const coInvestIncentive = num(c.coInvestHw) * stpUsd;
    const fob3 = fob2 - coInvestIncentive;
    const nsip3 = nsip2 - coInvestIncentive;
    const gm3 = nsip3 > 0 ? (fob3 - cf - hqRebate) / nsip3 : null;

    return {
      channel: c.channel, customer: c.customer,
      rrpExVat, stpMxn, stpUsd, sipMxn, sipUsd,
      nsip1, fob1, gm1,
      promoStpUsd, aonIncentive, fobPromo, nsipPromo, gmPromo, fob2, nsip2, gm2,
      coInvestIncentive, fob3, nsip3, gm3,
      costFloor: cf, weight: num(c.weight)
    };
  }

  function weightedAvg(rows, key) {
    let s = 0;
    for (const r of rows) if (r[key] != null) s += r[key] * r.weight;
    return s;
  }

  function computePricing({ globals, costFloor, customers }) {
    const g = globals || {}, cf = num(costFloor);
    const rows = (customers || []).map(c => computeRow(c, g, cf));
    const weighted = {
      gm1: weightedAvg(rows, 'gm1'),
      gmPromo: weightedAvg(rows, 'gmPromo'),
      gm2: weightedAvg(rows, 'gm2'),
      gm3: weightedAvg(rows, 'gm3'),
      weightSum: rows.reduce((a, r) => a + r.weight, 0)
    };
    return { rows, weighted };
  }

  return { computePricing };
});

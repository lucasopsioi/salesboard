/* ============================================================
   Salesboard — forecast-core.js
   未来 SO 推演内核（2026-09-07 用户需求）。纯函数，Node/浏览器双端可测。

   口径一律沿用项目既有定义，**不新造口径**：
   · 日销 = 近 28 天 SO ÷ 28（与全局口径卡「DOS＝库存 ÷（近4个ISO周SO ÷ 28）」同源）
   · 平均周销 = 日销 × 7
   · DOS = 库存 ÷ 日销；日销为 0 时 DOS 无意义 → null（绝不写 0，0 天读起来像马上断货）
   · 库存滚动：期末库存 = 期初库存 + SI − SO（时点量，不跨期累加）

   拆分规则（用户明确要求）：产品级 SO 推演 → 按**历史 SI 占比**分摊到各型号。
   例：产品 A 十二月 SO=1000，历史 A1/A2 的 SI 占比 60%/40% → A1=600、A2=400。
   分摊用**最大余数法**保证各型号之和恰等于产品总量（四舍五入会多/少几台，
   在这个项目里「所见即所加」是硬要求）。
   ============================================================ */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.ForecastCore = api;
})(this, function () {
  'use strict';

  const isNum = v => typeof v === 'number' && isFinite(v);
  const n0 = v => (isNum(v) ? v : (v == null || v === '' ? null : (isFinite(+v) ? +v : null)));

  /* 近 N 天日销。soDaily = 按天的 SO 数组（时间升序，末尾最近）。
     null（没录数）不参与分母——与「缺数不补零」一致；全为 null 则返回 null。 */
  function dailyRunRate(soDaily, days) {
    const N = days || 28;
    const arr = (soDaily || []).slice(-N);
    let sum = 0, seen = 0;
    arr.forEach(v => { const x = n0(v); if (x != null) { sum += x; seen++; } });
    if (!seen) return null;
    return sum / N;            // 分母固定 N 天（口径卡：近4周SO ÷ 28），不是 ÷ 实际有数天数
  }
  function weeklyFromDaily(rate) { const r = n0(rate); return r == null ? null : r * 7; }

  /* 历史 SI 占比：{型号: SI合计} → {型号: 占比}。总和为 0 或负 → 返回 null（无从分摊）。 */
  function siShares(siByKey) {
    const keys = Object.keys(siByKey || {});
    let tot = 0;
    keys.forEach(k => { const v = n0(siByKey[k]); if (v != null && v > 0) tot += v; });
    if (!(tot > 0)) return null;
    const out = {};
    keys.forEach(k => { const v = n0(siByKey[k]); out[k] = (v != null && v > 0) ? v / tot : 0; });
    return out;
  }

  /* 按占比把整数总量分摊下去，**和恰好等于 total**（最大余数法）。
     total 可为小数时按四舍五入后的整数分配；负数原样按比例（罕见，保序）。 */
  function splitInt(total, shares) {
    const T = n0(total); if (T == null) return {};
    const keys = Object.keys(shares || {});
    if (!keys.length) return {};
    const tgt = Math.round(T);
    const raw = {}, floor = {}, rem = [];
    let acc = 0;
    keys.forEach(k => {
      const s = n0(shares[k]) || 0;
      const x = tgt * s;
      raw[k] = x;
      const f = Math.floor(x);
      floor[k] = f; acc += f;
      rem.push({ k: k, r: x - f });
    });
    let left = tgt - acc;
    // 余数大的先补；余数相同按占比大的先补，保证结果稳定可复现
    rem.sort((a, b) => (b.r - a.r) || ((n0(shares[b.k]) || 0) - (n0(shares[a.k]) || 0)) || (a.k < b.k ? -1 : 1));
    for (let i = 0; left > 0 && i < rem.length; i++, left--) floor[rem[i].k]++;
    for (let i = rem.length - 1; left < 0 && i >= 0; i--, left++) floor[rem[i].k]--;
    return floor;
  }

  /* 期内天数：天=1、周=7、月按该期真实天数（给不出就 30） */
  function periodDays(gran, days) {
    if (isNum(days) && days > 0) return days;
    return gran === 'day' ? 1 : gran === 'week' ? 7 : 30;
  }

  /* 滚动库存：期末库存 = 上期期末 + SI − SO。
     periods = [{si, so, days?}]，返回同长度数组，补上 inv（期末）。
     SI/SO 缺失按 0 参与滚动（库存必须连续），但会在 flags 里标出来。 */
  function rollInventory(openInv, periods, gran) {
    let inv = n0(openInv) || 0;
    return (periods || []).map(p => {
      const si = n0(p.si) || 0, so = n0(p.so) || 0;
      inv = inv + si - so;
      return { si: si, so: so, inv: inv, days: periodDays(gran, p.days), missing: (n0(p.si) == null || n0(p.so) == null) };
    });
  }

  /* 到第 idx 期为止的「近 window 天」日销：从当期往前累加，凑满 window 天为止。
     histDaily 是推演起点之前的历史日销（数组，按天，末尾最近），用于前几期回看历史。 */
  function trailingDailyRate(rows, idx, histDaily, window) {
    const W = window || 28;
    let need = W, sum = 0, got = false;
    for (let i = idx; i >= 0 && need > 0; i--) {
      const r = rows[i]; if (!r) break;
      const d = Math.min(r.days, need);
      if (r.days > 0) { sum += (n0(r.so) || 0) * (d / r.days); got = true; }
      need -= d;
    }
    if (need > 0) {                       // 推演期不够 28 天 → 用历史日销补齐
      const h = (histDaily || []).slice(-need);
      h.forEach(v => { const x = n0(v); if (x != null) { sum += x; got = true; } });
      need -= h.length;
    }
    if (!got) return null;
    /* 分母用「实际覆盖到的天数」而不是死的 W：时间线开头回看不满 28 天时，
       缺的那几天是**数据范围之外**（不是「那几天没卖」），除以 28 会低估日销 →
       高估 DOS → 看起来库存很充裕，这是危险的方向（掩盖断货风险）。
       窗口能填满时 need=0，分母就是 W，与原行为一致。
       注意：左列「近28天日销」(dailyRunRate) 仍固定除以 28 —— 那里的缺口是
       「近28天内确实没卖」，两者语义不同，不要统一。 */
    const covered = W - Math.max(0, need);
    if (covered <= 0) return null;
    return sum / covered;
  }

  function dosOf(inv, rate) {
    const i = n0(inv), r = n0(rate);
    if (i == null || r == null || r <= 0) return null;   // 日销为 0/未知 → DOS 无意义，显「—」
    return i / r;
  }

  /* 一条产品线（或型号）的完整推演。
     入参：{openInv, histDaily, periods:[{si,so,days?}], gran}
     出参：[{si,so,inv,days,rate,dos}]  —— rate=该期末的近28天日销，dos=期末库存÷rate */
  function simulate(opt) {
    opt = opt || {};
    const rows = rollInventory(opt.openInv, opt.periods, opt.gran);
    rows.forEach((r, i) => {
      r.rate = trailingDailyRate(rows, i, opt.histDaily, 28);
      r.dos = dosOf(r.inv, r.rate);
    });
    return rows;
  }

  /* 产品级 SO 推演 → 按历史 SI 占比分摊到型号，并各自滚库存出 DOS。
     入参：
       productPeriods : [{so, si?}]          产品级每期推演值（so 必填，si 可选）
       models         : [{key, openInv, histDaily, histSi}]
     规则：
       · 各期 SO 按 histSi 求得的占比分摊，和恰等于产品级 SO
       · 产品级给了 SI 就同样分摊；没给则各型号 SI 沿用其占比 × 产品级 SO（默认按需补货，
         这是「先做一版」的保守默认，后续可改成用户逐格填）
     出参：{shares, byModel:{key:[{si,so,inv,dos,rate}]}, totals:[{so,si}]}  */
  function simulateProduct(opt) {
    opt = opt || {};
    const models = opt.models || [];
    const siMap = {}; models.forEach(m => { siMap[m.key] = n0(m.histSi) || 0; });
    const shares = siShares(siMap) || equalShares(models.map(m => m.key));
    const pps = opt.productPeriods || [];
    const soSplit = pps.map(p => splitInt(n0(p.so) || 0, shares));
    const siSplit = pps.map((p, i) => (n0(p.si) != null) ? splitInt(n0(p.si), shares) : soSplit[i]);
    const byModel = {};
    models.forEach(m => {
      const periods = pps.map((p, i) => ({ so: soSplit[i][m.key] || 0, si: siSplit[i][m.key] || 0, days: p.days }));
      byModel[m.key] = simulate({ openInv: m.openInv, histDaily: m.histDaily, periods: periods, gran: opt.gran });
    });
    const totals = pps.map((p, i) => ({
      so: models.reduce((a, m) => a + (soSplit[i][m.key] || 0), 0),
      si: models.reduce((a, m) => a + (siSplit[i][m.key] || 0), 0),
    }));
    return { shares: shares, byModel: byModel, totals: totals };
  }

  function equalShares(keys) {
    const o = {}; const n = (keys || []).length || 1;
    (keys || []).forEach(k => { o[k] = 1 / n; });
    return o;
  }

  /* 历史 + 推演拼成一条时间线（2026-09-07 用户：「需要历史数据来辅助判断」）。
     histRows = 实际值 [{si,so,inv}]（inv 是该期真实期末库存，不再由我们滚）；
     periods  = 推演期 [{si,so}]，期初库存接最后一期历史的实际 inv。
     DOS 的「近28天日销」在整条时间线上回看，所以推演头几期会正确用到历史 SO，
     不需要再单独喂 histDaily。 */
  function simulateWithHistory(opt) {
    opt = opt || {};
    const gran = opt.gran;
    const hist = (opt.histRows || []).map(r => ({
      si: n0(r.si), so: n0(r.so), inv: n0(r.inv),
      days: periodDays(gran, r.days), hist: true,
    }));
    const openInv = hist.length ? hist[hist.length - 1].inv : n0(opt.openInv);
    const fc = rollInventory(openInv, opt.periods || [], gran);
    const all = hist.concat(fc);
    all.forEach((r, i) => {
      r.rate = trailingDailyRate(all, i, null, 28);
      r.dos = dosOf(r.inv, r.rate);
    });
    return { hist: all.slice(0, hist.length), forecast: all.slice(hist.length), all: all };
  }

  /* 产品级：历史照搬实际，未来按历史 SI 占比分摊。models[].histRows 为该型号的历史实际。 */
  function simulateProductWithHistory(opt) {
    opt = opt || {};
    const models = opt.models || [];
    const siMap = {}; models.forEach(m => { siMap[m.key] = n0(m.histSi) || 0; });
    const shares = siShares(siMap) || equalShares(models.map(m => m.key));
    const pps = opt.productPeriods || [];
    const soSplit = pps.map(p => splitInt(n0(p.so) || 0, shares));
    const siSplit = pps.map((p, i) => (n0(p.si) != null) ? splitInt(n0(p.si), shares) : soSplit[i]);
    const byModel = {};
    models.forEach(m => {
      const periods = pps.map((p, i) => ({ so: soSplit[i][m.key] || 0, si: siSplit[i][m.key] || 0, days: p.days }));
      byModel[m.key] = simulateWithHistory({ gran: opt.gran, histRows: m.histRows, openInv: m.openInv, periods: periods });
    });
    return { shares: shares, byModel: byModel };
  }

  return { dailyRunRate, weeklyFromDaily, siShares, splitInt, rollInventory, trailingDailyRate, dosOf, simulate, simulateProduct, simulateWithHistory, simulateProductWithHistory, periodDays, equalShares };
});

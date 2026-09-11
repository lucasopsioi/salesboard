// app/sosim-calc.js
(function (root, factory) {
  const core = (typeof require !== 'undefined') ? require('./sosim-core.js') : root.SoSimCore;
  const api = factory(core);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.SoSimCalc = api;
})(this, function (Core) {
  function computeInventory(o) {
    const channelInv = new Map(), fullInv = new Map();
    let full = 0, chan = 0, lastSnap = 0, haveSnap = false;
    o.days.forEach(d => {
      const sh = o.ship.get(d) || 0, si = o.sellIn.get(d) || 0, so = o.sellOut.get(d) || 0;
      full = full + sh - so; fullInv.set(d, full);
      if (d <= o.cutoffYmd) {
        if (o.invActual.has(d)) { lastSnap = o.invActual.get(d); haveSnap = true; }
        chan = haveSnap ? lastSnap : 0;
      } else {
        chan = chan + si - so;
      }
      channelInv.set(d, chan);
    });
    return { channelInv, fullInv };
  }
  // 桶内"实际天数"：DOS 跟随实际天数 → 取期间真实日历天数，而非样本里出现的天数。
  function bucketDays(ymd, gran) {
    if (gran === 'day') return 1;
    if (gran === 'week') return 7;
    if (gran === 'month') return Core.daysInYm(Core.ymdToYm(ymd));
    const y = Math.floor(ymd / 10000);
    const leap = (y % 4 === 0 && y % 100 !== 0) || (y % 400 === 0);
    if (gran === 'year') return leap ? 366 : 365;
    if (gran === 'quarter') {
      const q = Math.floor(((Math.floor(ymd / 100) % 100) - 1) / 3) + 1;
      const m0 = (q - 1) * 3 + 1;                       // 季度首月
      return Core.daysInYm(y * 100 + m0) + Core.daysInYm(y * 100 + m0 + 1) + Core.daysInYm(y * 100 + m0 + 2);
    }
    return Core.daysInYm(Core.ymdToYm(ymd));
  }
  function bucketRows(o) {
    const order = [], B = new Map();
    o.days.forEach(d => {
      const b = Core.bucketOf(d, o.gran);
      let cell = B.get(b);
      if (!cell) { cell = { bucket: b, ship: 0, sellIn: 0, sellOut: 0, channelInv: 0, fullInv: 0, nDays: bucketDays(d, o.gran), _last: 0 }; B.set(b, cell); order.push(b); }
      cell.ship += o.ship.get(d) || 0; cell.sellIn += o.sellIn.get(d) || 0; cell.sellOut += o.sellOut.get(d) || 0;
      if (d >= cell._last) { cell._last = d; cell.channelInv = o.channelInv.get(d) || 0; cell.fullInv = o.fullInv.get(d) || 0; }
    });
    const dos = (inv, so, nd) => so > 0 ? Math.round((inv * nd) / so) : 0;   // DOS 取整(无小数)
    return order.map(b => { const c = B.get(b); c.channelDOS = dos(c.channelInv, c.sellOut, c.nDays); c.fullDOS = dos(c.fullInv, c.sellOut, c.nDays); delete c._last; return c; });
  }
  function fifoCost(o) {
    const layersAt = new Map(); let costMissing = false;
    const queue = []; // {ym, qty, unitCost}
    o.days.forEach(d => {
      const sh = o.ship.get(d) || 0;
      if (sh > 0) { const ym = Core.ymdToYm(d); const uc = o.costForMonth(ym); if (uc == null) costMissing = true; queue.push({ ym, qty: sh, unitCost: uc }); }
      let need = o.sellOut.get(d) || 0;
      while (need > 0 && queue.length) {
        const head = queue[0];
        if (head.qty <= need) { need -= head.qty; queue.shift(); }
        else { head.qty -= need; need = 0; }
      }
      layersAt.set(d, queue.map(l => ({ ym: l.ym, qty: l.qty, unitCost: l.unitCost })));
    });
    return { layersAt, costMissing };
  }
  // 全流程剩余库存(FIFO,仅台数,≥0):发货按 FIFO 被 SellOut 消耗,消耗不超过已发 → 永不为负。
  // 用于"全流程库存"口径,与 costComposition(成本图)同源一致(那边按发货月分层,这里只要总台数)。
  function fifoRemaining(o) {
    const out = new Map();
    const queue = []; // 每层剩余台数(FIFO)
    o.days.forEach(d => {
      const sh = o.ship.get(d) || 0;
      if (sh > 0) queue.push(sh);
      let need = o.sellOut.get(d) || 0;
      while (need > 0 && queue.length) {
        if (queue[0] <= need) { need -= queue[0]; queue.shift(); }
        else { queue[0] -= need; need = 0; }
      }
      out.set(d, queue.reduce((a, b) => a + b, 0));
    });
    return out;
  }
  // 汇总口径 FIFO(池化):作用域内所有单元的发货层进**同一条队列**(同日各型号各一层,成本各自当月精确),
  // 当日总 SellOut 按先进先出统一消耗 —— 即"多国家/多型号也遵循同一成本加总"。
  // 与 costComposition(逐单元各自队列)的差别:池化允许 A 单元的 SO 消耗 B 单元更早的发货层 →
  // 汇总视图下"自身SO不足"的零星老发货不再永久留层(修多选国家时底部老月份小层密密麻麻)。
  // 返回 { comp:[{bucket,total,layers:[{ym,qty,amount}]}](桶末快照,格式同 costComposition),
  //        remainByDay:Map<day,总剩余台数>(≥0,供"全流程库存"行,与 comp 同一条队列完全同源) }。
  function pooledFifo(o) {
    const bucketLast = new Map();
    o.days.forEach(d => bucketLast.set(Core.bucketOf(d, o.gran), d));   // days 升序 → 末日覆盖
    const queue = [];   // {ym, qty, unitCost}
    const remainByDay = new Map(), comp = [];
    o.days.forEach(d => {
      const ym = Core.ymdToYm(d);
      (o.perUnit || []).forEach(u => {
        const sh = u.ship.get(d) || 0;
        if (sh > 0) queue.push({ ym, qty: sh, unitCost: u.costForMonth ? u.costForMonth(ym) : null });
      });
      let need = 0;
      (o.perUnit || []).forEach(u => { need += u.sellOut.get(d) || 0; });
      while (need > 0 && queue.length) {
        const head = queue[0];
        if (head.qty <= need) { need -= head.qty; queue.shift(); }
        else { head.qty -= need; need = 0; }
      }
      let tot = 0; for (let i = 0; i < queue.length; i++) tot += queue[i].qty;
      remainByDay.set(d, tot);
      if (bucketLast.get(Core.bucketOf(d, o.gran)) === d) {   // 桶末日 → 快照层(按发货月合并)
        const byYm = new Map();
        queue.forEach(L => { let e = byYm.get(L.ym); if (!e) { e = { ym: L.ym, qty: 0, amount: 0 }; byYm.set(L.ym, e); } e.qty += L.qty; e.amount += L.qty * (L.unitCost || 0); });
        const layers = [...byYm.values()].sort((a, b) => a.ym - b.ym);
        comp.push({ bucket: Core.bucketOf(d, o.gran), total: layers.reduce((s2, x) => s2 + x.qty, 0), layers });
      }
    });
    return { comp, remainByDay };
  }
  function constraintFlags(o) {
    const out = new Map(); let cSO = 0, cSI = 0, cSH = 0;
    o.days.forEach(d => {
      cSO += o.sellOut.get(d) || 0; cSI += o.sellIn.get(d) || 0; cSH += o.ship.get(d) || 0;
      out.set(d, { overSI: cSO > cSI + 1e-9, overShip: cSO > cSH + 1e-9 });
    });
    return out;
  }
  function costComposition(o) {
    const layersByUnit = (o.perUnit || []).map(u =>
      fifoCost({ days: o.days, ship: u.ship, sellOut: u.sellOut, costForMonth: u.costForMonth }).layersAt);
    const bucketLast = new Map();
    o.days.forEach(d => bucketLast.set(Core.bucketOf(d, o.gran), d)); // days 升序 → 末日覆盖
    const out = [];
    bucketLast.forEach((d, b) => {
      const byYm = new Map();
      layersByUnit.forEach(la => {
        (la.get(d) || []).forEach(L => {
          let e = byYm.get(L.ym); if (!e) { e = { ym: L.ym, qty: 0, amount: 0 }; byYm.set(L.ym, e); }
          e.qty += L.qty; e.amount += L.qty * (L.unitCost || 0);
        });
      });
      const layers = [...byYm.values()].sort((a, b2) => a.ym - b2.ym);
      out.push({ bucket: b, total: layers.reduce((s, x) => s + x.qty, 0), layers });
    });
    return out; // bucketLast 插入序 = days 升序 = 时间升序
  }
  return { computeInventory, bucketRows, fifoCost, fifoRemaining, pooledFifo, constraintFlags, costComposition };
});

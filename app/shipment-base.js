// app/shipment-base.js
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.ShipmentBase = api;
})(this, function () {
  function ymdOf(d) {
    if (d == null || d === '') return null;
    if (typeof d === 'number' && d > 20000 && d < 80000) {
      const dt = new Date(Math.round((d - 25569) * 86400000));
      return dt.getUTCFullYear() * 10000 + (dt.getUTCMonth() + 1) * 100 + dt.getUTCDate();
    }
    const s = String(d).trim();
    let m = s.match(/^(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})/);
    if (m) return (+m[1]) * 10000 + (+m[2]) * 100 + (+m[3]);
    m = s.match(/^(\d{4})(\d{2})(\d{2})$/);
    if (m) return (+m[1]) * 10000 + (+m[2]) * 100 + (+m[3]);
    return null;
  }
  function colIndexer(h) {
    const find = (re) => h.findIndex(x => re.test(String(x || '').trim()));
    return {
      country: find(/国家|地区|country/i),
      family: find(/product\s*family|产品系列|family/i),
      series: find(/product\s*series|series/i),
      model: find(/product\s*model|型号|model/i),
      qty: find(/数量|qty|quantity/i),
      date: find(/日期|date|时间/i),
    };
  }
  function parseShipmentAoa(aoa) {
    const out = [];
    if (!aoa || !aoa.length) return out;
    const ci = colIndexer(aoa[0]);
    for (let i = 1; i < aoa.length; i++) {
      const r = aoa[i]; if (!r) continue;
      const ymd = ci.date >= 0 ? ymdOf(r[ci.date]) : null;
      const qty = ci.qty >= 0 ? Number(r[ci.qty]) : NaN;
      const model = ci.model >= 0 ? String(r[ci.model] || '').trim() : '';
      if (!ymd || !model || isNaN(qty)) continue;
      out.push({
        country: ci.country >= 0 ? String(r[ci.country] || '').trim() : '',
        family: ci.family >= 0 ? String(r[ci.family] || '').trim() : '',
        series: ci.series >= 0 ? String(r[ci.series] || '').trim() : '',
        model, qty, ymd,
      });
    }
    return out;
  }
  return { parseShipmentAoa, ymdOf };
});

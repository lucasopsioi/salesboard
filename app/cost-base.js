(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.CostBase = api;
})(this, function () {
  function ymOf(d) {
    if (d == null || d === '') return null;
    if (typeof d === 'number' && d > 20000 && d < 80000) {
      const dt = new Date(Math.round((d - 25569) * 86400000));
      return dt.getUTCFullYear() * 100 + (dt.getUTCMonth() + 1);
    }
    const s = String(d).trim();
    let m = s.match(/^(\d{4})[\/\-.](\d{1,2})/); if (m) return (+m[1]) * 100 + (+m[2]);
    m = s.match(/^(\d{4})(\d{2})$/); if (m) return (+m[1]) * 100 + (+m[2]);
    m = s.match(/^(\d{4})年(\d{1,2})月?/); if (m) return (+m[1]) * 100 + (+m[2]);   // "2026年6月"
    // Excel 日期序列号被存成"文本"(如 '46174'):纯数字串且落在序列号区间 → 按序列号解析。
    // (常见于从别处粘贴/导出的表;raw:true 读出来是字符串,原逻辑整行被丢 → 成本全 $0。)
    if (/^\d{5}$/.test(s)) { const n = +s; if (n > 20000 && n < 80000) return ymOf(n); }
    return null;
  }
  function colIndexer(h) {
    const find = (re) => h.findIndex(x => re.test(String(x || '').trim()));
    return { name: find(/传播名/), sku: find(/型号|SKU/i), attr: find(/Attribute|月|日期/i), value: find(/Value|值|成本/i), series: find(/系列/) };
  }
  function parseCostAoa(aoa) {
    const costMap = new Map(), skuMeta = new Map();
    if (!aoa || !aoa.length) return { costMap, skuMeta };
    let ci = colIndexer(aoa[0]);
    let start = 1;
    // 位置兜底(2026-07 用户定):表头没被正则认出来(型号列或日期列缺)时,按**固定列序**解析:
    //   第1列=产品系列、第2列=产品型号、第3列=日期(Attribute)、第4列=数值(Value)。
    //   这样表头随便改名都能读;老定价库 5 列格式(传播名/型号/Attribute/Value/系列)表头能命中,不走兜底。
    if (ci.sku < 0 || ci.attr < 0) {
      ci = { name: -1, series: 0, sku: 1, attr: 2, value: 3 };
      // 首行本身就是数据(无表头:第3列能解析成月份 且 第2列非空)→ 从第 0 行开始,别丢首行。
      const r0 = aoa[0] || [];
      if (ymOf(r0[2]) != null && String(r0[1] || '').trim()) start = 0;
    }
    for (let i = start; i < aoa.length; i++) {
      const row = aoa[i]; if (!row) continue;
      const sku = ci.sku >= 0 ? String(row[ci.sku] || '').trim() : '';
      const ym = ci.attr >= 0 ? ymOf(row[ci.attr]) : null;
      if (!sku || ym == null) continue;
      // Value 空串按"缺成本"(null)——Number('')===0 会把空格子悄悄算成 $0 成本,误导加权/金额。
      const rawVal = ci.value >= 0 ? row[ci.value] : null;
      const val = (rawVal == null || String(rawVal).trim() === '') ? NaN : Number(rawVal);
      if (!costMap.has(sku)) costMap.set(sku, new Map());
      costMap.get(sku).set(ym, isNaN(val) ? null : val);
      if (!skuMeta.has(sku)) skuMeta.set(sku, {
        name: ci.name >= 0 ? String(row[ci.name] || '').trim() : sku,
        series: ci.series >= 0 ? String(row[ci.series] || '').trim() : '' });
    }
    return { costMap, skuMeta };
  }
  function costFloorFor(costMap, sku, ym) { const m = costMap.get(sku); if (!m) return null; const v = m.get(ym); return v == null ? null : v; }
  function monthsForSku(costMap, sku) { const m = costMap.get(sku); return m ? [...m.keys()].sort((a, b) => a - b) : []; }
  return { parseCostAoa, ymOf, costFloorFor, monthsForSku };
});

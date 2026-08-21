(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.PsiChart = api;
})(this, function () {
  const STACKED = ['area', 'stackBar', 'pctBar'];
  function exportOrder(order, chartType) {
    const a = (order || []).slice();
    return STACKED.includes(chartType) ? a.reverse() : a;
  }
  function bucketTotals(order, buckets, valFn) {
    return (buckets || []).map(b => (order || []).reduce((s, n) => s + (+valFn(n, b) || 0), 0));
  }
  function yAxisMax(totals) {
    const m = Math.max(0, ...((totals && totals.length) ? totals : [0]));
    return m > 0 ? m * 1.1 : null;
  }
  /* Y 轴下界。**必须和 yAxisMax 成对使用**：
     ECharts 在「max 被钉死成非整数、min 留空」时，会先取一个漂亮的刻度间隔，
     再从 max 往下推 interval×splitNumber 反推 min —— 结果能跌破 0 变成 -10000，
     于是图底留出一大片空白、X 轴日期被推得离数据很远。
     所以：数据非负 → min 固定 0（贴着 0 轴，无空白）；
           真有负数 → 贴着 dataMin 留 10% 余量，绝不放大成 -10000 这种整数档。 */
  function yAxisMin(totals) {
    const arr = (totals && totals.length) ? totals.filter(v => v != null && isFinite(v)) : [];
    if (!arr.length) return 0;
    const mn = Math.min(...arr);
    return mn >= 0 ? 0 : mn * 1.1;
  }
  function labelStyle(state) {
    state = state || {};
    return { size: +state.labelSize || 12, color: state.labelColor || null };
  }
  function buildPptxSeries(order, buckets, valFn, opt) {
    opt = opt || {};
    const type = opt.chartType, hex = opt.colorHexFn || (() => '999999');
    const eo = exportOrder(order, type);
    let cd;
    if (type === 'pctBar') {
      const tot = bucketTotals(order, buckets, valFn);
      cd = eo.map(name => ({ name, labels: buckets, values: buckets.map((b, i) => tot[i] > 0 ? +(((+valFn(name, b) || 0) / tot[i]) * 100).toFixed(2) : 0) }));
    } else {
      cd = eo.map(name => ({ name, labels: buckets, values: buckets.map(b => +(+valFn(name, b) || 0).toFixed(3)) }));
    }
    const colors = eo.map(hex);
    let total = null, valMax = null;
    if (opt.labels && (type === 'area' || type === 'stackBar')) {
      const t = bucketTotals(order, buckets, valFn);
      total = { name: opt.totalName || '总计', labels: buckets, values: t.map(v => +(+v).toFixed(3)) };
      valMax = yAxisMax(t);
    }
    return { cd, colors, total, valMax };
  }
  return { exportOrder, bucketTotals, yAxisMax, yAxisMin, labelStyle, buildPptxSeries };
});

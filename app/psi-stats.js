/* ============================================================
   PSI 看板 · 左侧区间统计(纯函数,UMD:Node可测/浏览器可用)
   输入 = Engine.query 的结果(state.lastQuery:{buckets,series,data}) + 当前指标。
   口径:
   - 流量指标(sellIn/sellOut) → 每系列=所选日期范围内**累计**(桶求和);合计=各系列累计之和;
     峰值=单期(桶)取值最高的那一期;均值=累计÷期数。
   - 存量指标(inv) → 每系列=**区间末值**(最后一桶快照);合计=各系列区间末值之和(库存可加)。
   - DOS → 每系列=区间末值;**合计不可加**(DOS 是比率,总口径须由 库存÷日均SO 重算,
     单靠透视结果加总没有意义)→ total 返回 null,由 UI 显示"—"。
   渠道全加不去重由上游 query 保证,这里只做聚合展示。
   ============================================================ */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PsiStats = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const FLOW = { sellIn: 1, sellOut: 1 };

  // res={buckets:[],series:[],data:{name:{bucket:v}}}, metric ∈ sellIn/sellOut/inv/dos
  function compute(res, metric) {
    const empty = { kind: 'flow', metric: metric, series: [], total: null, peak: null, periods: 0 };
    if (!res || !Array.isArray(res.buckets) || !Array.isArray(res.series) || !res.buckets.length || !res.series.length) return empty;
    const flow = !!FLOW[metric];
    const kind = flow ? 'flow' : 'snap';
    const buckets = res.buckets, data = res.data || {};
    const out = [];
    res.series.forEach(nm => {
      const row = data[nm] || {};
      let sum = 0, peakVal = -Infinity, peakBucket = null, last = 0;
      buckets.forEach(b => {
        const v = +row[b] || 0;
        sum += v; last = v;
        if (v > peakVal) { peakVal = v; peakBucket = b; }
      });
      out.push({ name: nm, val: flow ? sum : last,
        avg: flow ? sum / buckets.length : null,
        peakVal: peakVal === -Infinity ? 0 : peakVal, peakBucket: peakBucket });
    });
    // 合计:流量=累计和;库存=区间末值和;DOS 不可加
    let total = null, peak = null;
    if (metric !== 'dos') {
      total = out.reduce((a, s) => a + s.val, 0);
      let pv = -Infinity, pb = null;
      buckets.forEach(b => {
        let t = 0; res.series.forEach(nm => t += +((data[nm] || {})[b]) || 0);
        if (t > pv) { pv = t; pb = b; }
      });
      peak = { bucket: pb, val: pv === -Infinity ? 0 : pv };
    }
    return { kind: kind, metric: metric, series: out, total: total, peak: peak, periods: buckets.length };
  }

  const VAL_LABEL = { sellIn: '累计 Sell In', sellOut: '累计 Sell Out', inv: '区间末库存', dos: '区间末DOS' };
  function valLabel(metric) { return VAL_LABEL[metric] || metric; }

  return { compute: compute, valLabel: valLabel };
});

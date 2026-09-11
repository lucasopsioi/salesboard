'use strict';
/* ============================================================
   Salesboard · ECharts 主题桥（阶段三提前落地，原计划阶段四）
   为什么需要它：canvas 不解析 CSS 变量，所以图表里的轴标签/图例/网格线颜色
   必须是**真实色值**。这里把 design-tokens 的 CSS 变量读成真实色值给 ECharts 用，
   并在主题切换时给已注册的图表打一个"只改颜色不动数据"的增量补丁。

   硬边界：只改视觉配置（textStyle/axisLabel/axisLine/splitLine 的颜色），
   **不碰 series 数据、不触发任何取数**。
   ============================================================ */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.SbChartTheme = api;
})(this, function () {

  const FALLBACK = {
    '--c-ink-1': '#1A1A1A', '--c-ink-2': '#5A5F66', '--c-ink-3': '#8A9099',
    '--c-line': '#E6E8EB', '--c-line-soft': '#F0F1F3', '--c-bg-elev': '#FFFFFF',
  };

  /* 读 :root 上的 CSS 变量并返回真实色值（canvas 能用的那种） */
  function cssVar(name) {
    try {
      const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
      if (v) return v;
    } catch (e) {}
    return FALLBACK[name] || '#888888';
  }

  const ink1 = () => cssVar('--c-ink-1');
  const ink2 = () => cssVar('--c-ink-2');
  const ink3 = () => cssVar('--c-ink-3');
  const line = () => cssVar('--c-line');
  const lineSoft = () => cssVar('--c-line-soft');
  const bgElev = () => cssVar('--c-bg-elev');

  /* 一份通用的"颜色补丁"，供 setOption(patch, {notMerge:false}) 增量合并 */
  function patch() {
    return {
      textStyle: { color: ink2() },
      legend: { textStyle: { color: ink2() } },
      xAxis: { axisLabel: { color: ink3() }, axisLine: { lineStyle: { color: line() } } },
      yAxis: { axisLabel: { color: ink3() }, splitLine: { lineStyle: { color: lineSoft() } } },
      tooltip: {
        backgroundColor: bgElev(), borderColor: line(),
        textStyle: { color: ink1() },
      },
    };
  }

  /* 注册图表实例：主题切换时自动打补丁（弱引用式清理：实例被 dispose 后剔除） */
  const charts = [];
  function register(chart) {
    if (!chart || charts.indexOf(chart) >= 0) return chart;
    charts.push(chart);
    return chart;
  }
  function repaintAll() {
    for (let i = charts.length - 1; i >= 0; i--) {
      const c = charts[i];
      try {
        if (!c || (typeof c.isDisposed === 'function' && c.isDisposed())) { charts.splice(i, 1); continue; }
        c.setOption(patch(), { notMerge: false, lazyUpdate: true });
      } catch (e) { charts.splice(i, 1); }
    }
  }

  if (typeof window !== 'undefined') {
    window.addEventListener('sb-theme-change', repaintAll);
  }

  return { cssVar, ink1, ink2, ink3, line, lineSoft, bgElev, patch, register, repaintAll, _charts: charts };
});

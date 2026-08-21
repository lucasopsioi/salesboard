'use strict';
/* ============================================================
   音频周报 — 纯函数内核（Node 可测）
   - timeProgress: 悬赏奖时间进度 = 自然日(年内第几天 ÷ 全年天数)
   - defaultPick:  悬赏奖默认产品集 = 名称匹配 SE2/SE3/SE4(ANC) 规则
   - bountyRows:   悬赏奖表行计算（累计SI/达成率/拉美其他=总-已列名国/合计行）
   口径(用户确认 2026-08-05)：累计SI = Sell-in；时间进度 = 今天/365(自然日)。
   ============================================================ */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.AudioWeekly = api;
})(this, function () {

  // ymd(int 20260729 或 '2026-07-29') → 年内自然日进度 0~1
  function timeProgress(ymd) {
    let y, m, d;
    if (typeof ymd === 'string') { const p = ymd.split('-'); y = +p[0]; m = +p[1] || 1; d = +p[2] || 1; }
    else { y = Math.floor(ymd / 10000); m = Math.floor((ymd % 10000) / 100); d = ymd % 100; }
    if (!y || !m || !d) return null;
    const doy = Math.round((Date.UTC(y, m - 1, d) - Date.UTC(y, 0, 1)) / 86400000) + 1;
    const total = Math.round((Date.UTC(y + 1, 0, 1) - Date.UTC(y, 0, 1)) / 86400000);
    return doy / total;
  }

  // 默认产品集匹配：SonicBuds SE2 / SE 3 / SE4 ANC 等写法变体
  const DEFAULT_RE = /SE\s*-?\s*(2|3|4)\b/i;
  function defaultPick(names) { return (names || []).filter(n => DEFAULT_RE.test(String(n))); }

  /* cfg=[{country,space,share,target}](share 为 0~1 或 null; 拉美其他 特殊行),
     siBy={国家:累计SI}, totalAll=范围内全部国家累计SI 合计。
     返回 {rows:[{...cfg行, cum, attain}], total:{...}}
     - 拉美其他.cum = totalAll − Σ已列名国家 (不为负)
     - attain = cum/target (target<=0 → null)
     - 合计.share = Σtarget/Σspace (与用户示例一致: 764000/7923722≈10%) */
  function bountyRows(cfg, siBy, totalAll) {
    cfg = cfg || []; siBy = siBy || {};
    const named = cfg.filter(r => r.country !== '拉美其他').map(r => r.country);
    const namedSum = named.reduce((t, c) => t + (siBy[c] || 0), 0);
    const rows = cfg.map(r => {
      const cum = r.country === '拉美其他' ? Math.max(0, Math.round((totalAll || 0) - namedSum)) : Math.round(siBy[r.country] || 0);
      const target = +r.target || 0;
      return Object.assign({}, r, { cum, attain: target > 0 ? cum / target : null });
    });
    const sum = k => rows.reduce((t, r) => t + (+r[k] || 0), 0);
    const total = { country: '合计', space: sum('space'), target: sum('target'), cum: sum('cum') };
    total.share = total.space > 0 ? total.target / total.space : null;
    total.attain = total.target > 0 ? total.cum / total.target : null;
    return { rows, total };
  }

  return { timeProgress, defaultPick, bountyRows, DEFAULT_RE };
});

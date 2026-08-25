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

  /* 周报的「当前周号」= **上一整周**(用户 2026-08-24:本周数据还没出来,周报写的是上周复盘)。
     取法:今天回退 7 天所在的 ISO 周——天然处理跨年(1月首周回退到上年 W52/W53)。
     返回 {year, week, label:'W34', full:'2026-W34'}。now 可注入,便于测边界。 */
  function reportWeek(now) {
    const d = now ? new Date(now) : new Date();
    const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate() - 7));
    const dn = t.getUTCDay() || 7;
    t.setUTCDate(t.getUTCDate() + 4 - dn);
    const y0 = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
    const wk = Math.ceil(((t - y0) / 86400000 + 1) / 7);
    const label = 'W' + String(wk).padStart(2, '0');
    return { year: t.getUTCFullYear(), week: wk, label: label, full: t.getUTCFullYear() + '-' + label };
  }

  /* 周号钳制(用户 2026-08-24 补充):音频人工延迟报量,数据可能停在上周甚至上上周——
     周号 = min(日历上一周, 数据最后有 SO 的周)。数据侧比日历早就用数据的(音频常态),
     数据侧≥日历(平板当周已有数)仍用日历上一周(本周不完整,不报)。跨年按 (year,week) 比。 */
  function clampReportWeek(cal, dataYear, dataWeek) {
    if (dataYear && dataWeek && (dataYear < cal.year || (dataYear === cal.year && dataWeek < cal.week))) {
      const label = 'W' + String(dataWeek).padStart(2, '0');
      return { year: dataYear, week: dataWeek, label: label, full: dataYear + '-' + label, src: 'data' };
    }
    return { year: cal.year, week: cal.week, label: cal.label, full: cal.full, src: 'cal' };
  }

  /* ---- 成本变化热力(用户 2026-08-25) ----
     格子底色:涨得越多越接近 rgb(199,0,11)(Acme红),线性到全表最大涨幅,封顶 50% 透明。
     Outlook 的 Word 引擎不认 rgba —— 按白底预混成实色 hex(rgba(c,α) over white)。
     降价对称用绿(与周报 WoW 红涨绿跌同语义);0/缺值不上色。 */
  function costHeatColor(delta, maxAbs) {
    if (delta == null || !isFinite(delta) || delta === 0 || !(maxAbs > 0)) return null;
    const a = 0.5 * Math.min(1, Math.abs(delta) / maxAbs);
    const base = delta > 0 ? [199, 0, 11] : [30, 126, 52];
    const hex = n => n.toString(16).padStart(2, '0').toUpperCase();
    const mix = ch => Math.round(255 - (255 - ch) * a);
    return '#' + hex(mix(base[0])) + hex(mix(base[1])) + hex(mix(base[2]));
  }
  /* cells: {"key|month": Floor FOB}; keys 已按用户想要的顺序; monthsAll 升序;
     baseM=基准月(A); displayOf(key)→行名; labelOf(month)→列头。
     基准列显示绝对值 $A,之后各月显示 A±$XX;基准缺值的行整行 '—'。 */
  function costChangeModel(cells, keys, monthsAll, baseM, displayOf, labelOf) {
    if ((monthsAll || []).indexOf(baseM) < 0) return null;
    const after = monthsAll.filter(m => m > baseM);
    const header = ['产品', labelOf(baseM) + ' 基准A'].concat(after.map(labelOf));
    let maxAbs = 0;
    const mid = keys.map(k => {
      const base = cells[k + '|' + baseM];
      const dRow = after.map(m => {
        const v = cells[k + '|' + m];
        if (base == null || v == null) return null;
        const d = v - base;
        if (Math.abs(d) > maxAbs) maxAbs = Math.abs(d);
        return d;
      });
      return { k, base, dRow };
    });
    const rows = [], fills = [];
    mid.forEach(x => {
      const row = [displayOf(x.k), x.base == null ? '—' : '$' + Math.round(x.base).toLocaleString('en-US')];
      const fRow = [null, null];
      x.dRow.forEach(d => {
        if (d == null) { row.push('—'); fRow.push(null); return; }
        const r = Math.round(d);
        row.push((r >= 0 ? 'A+$' : 'A-$') + Math.abs(r).toLocaleString('en-US'));
        fRow.push(costHeatColor(d, maxAbs));
      });
      rows.push(row);
      fills.push(fRow);
    });
    return { header, rows, fills, baseMonth: baseM, maxAbs };
  }

  return { timeProgress, defaultPick, bountyRows, DEFAULT_RE, reportWeek, clampReportWeek, costHeatColor, costChangeModel };
});

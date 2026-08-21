'use strict';
/* ============================================================
   颜色记忆 —— 路标管理「已用色」纯函数内核（UMD，可 Node 单测）。

   解决的问题：用户给 SKU 选色时每次都去渐变色板上手点，鼠标点不准会挑出
   #1E9E57 / #1E9E58 这种肉眼同色但 hex 不同的值，路标图上本该同色的两个
   SKU 就分裂成两种颜色。

   两道防线：
   1) usedColors() —— 把「本产品 → 其它产品 → 配件/样机」里已经用过的颜色
      收成一排可点色块，点一下精确复用那个 hex（主路径，根治）。
   2) snap() —— 用户仍去色板手点时，若新颜色与已用色的距离小于阈值
      （肉眼分不出的程度），吸附回那个已用色（兜底）。
      阈值取得很保守：只吞掉「点歪了」，不吞用户真想要的相近色。
   ============================================================ */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.ColorMemory = api;
})(this, function () {

  const HEX6 = /^#[0-9a-fA-F]{6}$/;

  /* 归一化成小写 #rrggbb；支持 #rgb 简写；非法值返回 '' */
  function normHex(v) {
    if (v == null) return '';
    let s = String(v).trim();
    if (!s) return '';
    if (s[0] !== '#') s = '#' + s;
    if (/^#[0-9a-fA-F]{3}$/.test(s)) s = '#' + s[1] + s[1] + s[2] + s[2] + s[3] + s[3];
    return HEX6.test(s) ? s.toLowerCase() : '';
  }

  function rgb(hex) {
    const h = normHex(hex); if (!h) return null;
    return [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
  }

  /* RGB 欧氏距离（0~441）。够用：这里只判「几乎一样」，不做感知色差。 */
  function dist(a, b) {
    const x = rgb(a), y = rgb(b);
    if (!x || !y) return Infinity;
    const dr = x[0] - y[0], dg = x[1] - y[1], db = x[2] - y[2];
    return Math.sqrt(dr * dr + dg * dg + db * db);
  }

  /* 默认吸附阈值：距离 ≤ 10（每通道差 ~6 以内），肉眼基本分辨不出，
     正是「鼠标在色板上点歪一两像素」的量级。调大会误吞真·相近色。 */
  const SNAP_TOL = 10;

  /* 在调色板里找与 hex 最近的一个；距离 ≤ tol 才算命中，否则返回 null。 */
  function nearest(hex, palette, tol) {
    const t = tol == null ? SNAP_TOL : tol;
    const h = normHex(hex); if (!h) return null;
    let best = null, bestD = Infinity;
    (palette || []).forEach(p => {
      const c = normHex(p); if (!c) return;
      const d = dist(h, c);
      if (d < bestD) { bestD = d; best = c; }
    });
    if (best == null || bestD > t) return null;
    return { color: best, distance: bestD };
  }

  /* 吸附：命中就返回已用色，没命中原样返回。exact 命中不算「吸附」（snapped:false）。 */
  function snap(hex, palette, tol) {
    const h = normHex(hex);
    if (!h) return { color: normHex(hex), snapped: false };
    const n = nearest(h, palette, tol);
    if (!n || n.color === h) return { color: h, snapped: false };
    return { color: n.color, snapped: true, from: h, distance: n.distance };
  }

  /* 收集已用色。优先级：本产品 SKU → 本产品配件 → 其它产品 SKU → 样机。
     同色只留一次（按首次出现顺序），返回 {color, label} 便于 UI 出 tooltip。
     limit 默认 24，避免色块排太长。 */
  function usedColors(opts) {
    const o = opts || {};
    const out = [], seen = {};
    const push = (c, label) => {
      const h = normHex(c); if (!h || seen[h]) return;
      seen[h] = 1; out.push({ color: h, label: label || '' });
    };
    const skusOf = p => (p && p.skus) || [];

    const cur = o.current;
    if (cur) {
      skusOf(cur).forEach(s => push(s.color, '本产品 · ' + (s.name || 'SKU')));
      const acc = cur.accessories || {};
      Object.keys(acc).forEach(k => push(acc[k] && acc[k].color, '本产品配件 · ' + k));
    }
    (o.products || []).forEach(p => {
      if (cur && p && p.id === cur.id) return;
      skusOf(p).forEach(s => push(s.color, (p.name || '产品') + ' · ' + (s.name || 'SKU')));
    });
    (o.samples || []).forEach(s => push(s.color, '样机 · ' + (s.name || '')));

    const limit = o.limit == null ? 24 : o.limit;
    return limit > 0 ? out.slice(0, limit) : out;
  }

  /* 一组颜色里「肉眼同色但 hex 不同」的分裂组——用于给用户提示哪些该合并。
     返回 [{keep, dups:[…]}, …]，keep = 该组里第一个出现的颜色。 */
  function splitGroups(colors, tol) {
    const t = tol == null ? SNAP_TOL : tol;
    const list = (colors || []).map(normHex).filter(Boolean);
    const groups = [];
    list.forEach(c => {
      const g = groups.find(x => dist(x.keep, c) <= t);
      if (!g) groups.push({ keep: c, dups: [] });
      else if (g.keep !== c && g.dups.indexOf(c) < 0) g.dups.push(c);
    });
    return groups.filter(g => g.dups.length);
  }

  return { normHex, rgb, dist, nearest, snap, usedColors, splitGroups, SNAP_TOL };
});

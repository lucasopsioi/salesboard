/* ============================================================
   Salesboard — ppt-table-fit.js
   PPT 表格「自适应列宽 + 不换行」的纯内核。
   （2026-09-08 用户：「导出来的表格很多文字和数字都有换行，导致表格很丑，
     要有一个防止换行、自适应文字长度的导出功能」）

   为什么会换行：pptxgenjs 的 addTable 不给 colW 时，把总宽 w **等分**给每一列。
   汇总表有 20+ 列 → 每列约 0.58 英寸，而第一列可能是 "Slate Pro 13.2-inch"
   这种长名字，一定换行；同时 "W22" 这种列白白占着 0.58 英寸。
   解法：按每列**实际最长文本**算出自然宽度，再把总宽按比例铺满可用宽度。

   三条纪律：
   1) 宁可缩字号，也不硬挤列宽 —— 挤到比自然宽度窄就一定换行。
   2) 缩到下限还放不下 → 明确报出哪几列被挤了（wrapCols），由调用方决定是分页还是接受。
      绝不静默挤压装作没事。
   3) 文本一律不截断。截断是丢数据，换行只是丑。
   ============================================================ */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.PptTableFit = api;
})(this, function () {
  'use strict';

  const PT_PER_IN = 72;

  /* —— 和 pptxgenjs 打交道的三个硬事实（4.0.1，已用真实导出解包 slideN.xml 验过）——
     1) 单元格 margin 的**单位随数值切换**：第 0 个元素 >= 1 按「磅」算，< 1 按「英寸」算
        （bundle 里 `1<=e[0] ? z(...) : M(...)`）。写 [1,2,1,2] 是 2 磅不是 2 英寸，差 36 倍。
        所以这里一律用 < 1 的英寸值，不给自己留误会的余地。
     2) 不给 margin 时默认左右各 0.1 英寸，每列白白吃掉 0.2 英寸 —— 20 列就是 4 英寸。
     3) 只给 colW 不给 w 时，表格外框 cx 掉回幻灯片宽的 75%（实测 13.333 的片给出 10 英寸），
        列宽对了外框却不对。**colW 和 w 必须一起给**，w = Σ colW。
     4) colW 数组长度必须等于**第一行**按 colspan 展开后的列数，不等只 console.warn
        然后静默改回等分 —— 线上表现就是「改了没生效」。 */
  const CELL_MARGIN_IN = 0.04;      // 实际传给 addTable 的左右内边距（英寸/侧）
  const SLACK_IN = 0.03;            // 安全余量：canvas 量的是浏览器字形，PowerPoint 自己排版会有出入
  function tableMargin() { return [0.02, CELL_MARGIN_IN, 0.02, CELL_MARGIN_IN]; }   // 上/右/下/左

  /* —— 文本宽度（em 倍数）——
     浏览器里用 canvas 精确量；Node 单测/无 canvas 时用这张按字符类别的经验表。
     经验值针对「微软雅黑」标定：中日韩全角字符恰好 1 em，阿拉伯数字约 0.55 em
     （雅黑的数字是等宽的，这条最关键——表格里绝大多数格子是数字）。 */
  function emOf(ch) {
    const c = ch.codePointAt(0);
    // 全角/CJK：一个字一个 em
    if ((c >= 0x1100 && c <= 0x115F) || (c >= 0x2E80 && c <= 0xA4CF) ||
        (c >= 0xA960 && c <= 0xA97F) || (c >= 0xAC00 && c <= 0xD7A3) ||
        (c >= 0xF900 && c <= 0xFAFF) || (c >= 0xFE10 && c <= 0xFE6F) ||
        (c >= 0xFF00 && c <= 0xFF60) || (c >= 0xFFE0 && c <= 0xFFE6)) return 1.0;
    if (c >= 0x30 && c <= 0x39) return 0.55;                       // 0-9
    if (c >= 0x41 && c <= 0x5A) return 0.63;                       // A-Z
    if (c >= 0x61 && c <= 0x7A) return 0.52;                       // a-z
    if (ch === ' ') return 0.28;
    if (ch === ',' || ch === '.' || ch === ':' || ch === '\'') return 0.28;
    if (ch === '-' || ch === '/' || ch === '(' || ch === ')') return 0.34;
    if (ch === '%' || ch === '@' || ch === '#') return 0.78;
    return 0.55;
  }
  /* 返回英寸。bold 按 +4% 估（雅黑加粗的字身宽度增量很小，但表头全是粗体，积起来会差一列）。 */
  function heuristicWidth(text, fontSize, bold) {
    const s = String(text == null ? '' : text);
    let em = 0;
    for (const ch of s) em += emOf(ch);
    return (em * fontSize * (bold ? 1.04 : 1)) / PT_PER_IN;
  }

  /* 浏览器里的精确测量器。canvas 的 font 用 pt，measureText 给的是 CSS px（1/96 英寸）。
     取不到 canvas（Node、或被禁用）就回退到经验表——回退只影响精度，不影响正确性。 */
  function makeCanvasMeasurer(fontFace) {
    try {
      if (typeof document === 'undefined' || !document.createElement) return null;
      const cv = document.createElement('canvas');
      const ctx = cv.getContext('2d');
      if (!ctx) return null;
      const face = fontFace || '"Microsoft YaHei","微软雅黑",sans-serif';
      return function (text, fontSize, bold) {
        ctx.font = (bold ? 'bold ' : '') + fontSize + 'pt ' + face;
        const w = ctx.measureText(String(text == null ? '' : text)).width;
        if (!isFinite(w) || w <= 0) return heuristicWidth(text, fontSize, bold);
        return w / 96;
      };
    } catch (e) { return null; }
  }

  function cellText(c) {
    if (c == null) return '';
    if (typeof c === 'object') return String(c.text == null ? '' : c.text);
    return String(c);
  }
  function cellBold(c) {
    return !!(c && typeof c === 'object' && c.options && c.options.bold);
  }

  /* 每列的「自然宽度」= 该列所有格子里最宽的那个 + 左右内边距。
     rows 是二维数组，元素可以是字符串，也可以是 pptxgenjs 的 {text, options} 单元格。 */
  function naturalWidths(rows, opt) {
    opt = opt || {};
    const fs = opt.fontSize || 8;
    // 每侧要预留的不只是「好看」的留白，而是**真实会被吃掉的内边距** + 字形测量误差余量
    const pad = opt.padIn == null ? (CELL_MARGIN_IN + SLACK_IN) : opt.padIn;
    const minCol = opt.minColIn == null ? 0.28 : opt.minColIn;
    const measure = opt.measure || heuristicWidth;
    const nCol = (rows || []).reduce((m, r) => Math.max(m, (r || []).length), 0);
    const out = new Array(nCol).fill(minCol);
    (rows || []).forEach(r => {
      (r || []).forEach((c, i) => {
        const w = measure(cellText(c), fs, cellBold(c)) + pad * 2;
        if (w > out[i]) out[i] = w;
      });
    });
    return out;
  }

  /* 把一组自然宽度装进可用宽度。
     · 装得下 → 等比放大铺满，但放大倍数封顶（maxStretch）：
       两列的小表被拉到 13 英寸宽，每列 6 英寸，比换行还丑。放不满就让它窄着，调用方居中即可。
     · 装不下 → 水位法削峰：找水位 L 使 Σ min(natural_i, L) = 可用宽度 ——
       小列保住自然宽度不动，只削最宽的那几列。被削到自然宽度以下的列进 squeezed，
       那几列会换行，必须报出来，不许静默挤压。
       maxColIn 默认不封顶：水位法本身就拦得住「一个变态长的行名吃掉整张片」
       （它只能拿到别人取足自然宽度之后剩下的），先封顶反而会让表格白白留出空白还照样换行。 */
  function distribute(natural, availIn, opt) {
    opt = opt || {};
    const maxCol = opt.maxColIn == null ? Infinity : opt.maxColIn;
    const minCol = opt.minColIn == null ? 0.28 : opt.minColIn;
    const maxStretch = opt.maxStretch == null ? 1.6 : opt.maxStretch;
    const n = natural.length;
    if (!n) return { colW: [], squeezed: [], totalIn: 0 };
    const total = natural.reduce((a, b) => a + b, 0);

    if (total <= availIn) {
      const k = Math.min(maxStretch, availIn / total);
      const target = total * k;
      return { colW: roundTo(natural.map(w => w * k), target), squeezed: [], totalIn: r3(target) };
    }
    // 只有调用方显式给了 maxColIn 才封顶；宽松时一列宽点没坏处
    const want = natural.map(w => Math.min(w, maxCol));
    let lo = minCol, hi = Math.max.apply(null, want);
    for (let it = 0; it < 60; it++) {
      const mid = (lo + hi) / 2;
      const s = want.reduce((a, w) => a + Math.min(w, mid), 0);
      if (s > availIn) hi = mid; else lo = mid;
    }
    const colW = want.map(w => Math.max(minCol, Math.min(w, lo)));
    // 削完仍超（列数 × minCol 就已经超了）→ 整体等比压
    let t = colW.reduce((a, b) => a + b, 0);
    if (t > availIn + 1e-9) { const k = availIn / t; for (let i = 0; i < n; i++) colW[i] *= k; t = availIn; }
    const out = roundTo(colW, Math.min(t, availIn));
    const squeezed = [];
    for (let i = 0; i < n; i++) if (out[i] < natural[i] - 1e-3) squeezed.push(i);
    return { colW: out, squeezed: squeezed, totalIn: r3(Math.min(t, availIn)) };
  }
  /* 四舍五入到 3 位小数后，把舍入误差从最宽的一列扣掉 ——
     否则 Σ colW 可能比可用宽度多出零点零几英寸，表格右缘就溢出幻灯片了。 */
  function r3(v) { return Math.round(v * 1000) / 1000; }
  function roundTo(colW, target) {
    const out = colW.map(r3);
    const d = out.reduce((a, b) => a + b, 0) - target;
    if (Math.abs(d) > 1e-9) {
      let mi = 0; for (let i = 1; i < out.length; i++) if (out[i] > out[mi]) mi = i;
      out[mi] = r3(out[mi] - d);
    }
    return out;
  }
  function round3(a) { return a.map(v => Math.round(v * 1000) / 1000); }

  /* 主入口：给定表格内容和可用宽度，算出 colW 与最终字号。
     字号会按 steps 逐级下调，先保证「一列都不挤」；到下限仍挤不下才返回 squeezed。
     返回 {colW, fontSize, squeezed, rowH, totalIn}。 */
  function fit(rows, opt) {
    opt = opt || {};
    const availIn = opt.availIn == null ? 12.7 : opt.availIn;
    const base = opt.fontSize == null ? 9 : opt.fontSize;
    const minFs = opt.minFontSize == null ? 6 : opt.minFontSize;
    const step = opt.step == null ? 0.5 : opt.step;
    const measure = opt.measure || makeCanvasMeasurer(opt.fontFace) || heuristicWidth;
    /* colW 的长度必须等于第一行的列数。若首行比别的行短（表头少了一格这种脏数据），
       就把首行补齐再算 —— 否则 colW 会比首行长，pptxgenjs 静默退回等分，白改一场。 */
    const nCol = (rows || []).reduce((m, r) => Math.max(m, (r || []).length), 0);
    let padded = rows || [];
    if (padded.length && (padded[0] || []).length < nCol) {
      padded = padded.slice();
      padded[0] = (padded[0] || []).slice();
      while (padded[0].length < nCol) padded[0].push('');
    }
    rows = padded;
    let best = null;
    for (let fs = base; fs >= minFs - 1e-9; fs -= step) {
      const nat = naturalWidths(rows, Object.assign({}, opt, { fontSize: fs, measure: measure }));
      const d = distribute(nat, availIn, opt);
      if (!best) best = { fs: fs, d: d, nat: nat };
      if (!d.squeezed.length) { best = { fs: fs, d: d, nat: nat }; break; }
      best = { fs: fs, d: d, nat: nat };                       // 记住最后一次（字号最小那次最可能装下）
    }
    const fs = best.fs;
    return {
      colW: best.d.colW,
      fontSize: fs,
      squeezed: best.d.squeezed,
      natural: round3(best.nat),
      totalIn: Math.round(best.d.totalIn * 1000) / 1000,
      // 行高给下限即可（不换行时每行都是一行字）；PowerPoint 会按需要往下撑，不会截断
      rowH: Math.round((fs * 1.7 / PT_PER_IN) * 1000) / 1000,
      rows: rows,                                   // 可能补齐过首行，导出要用这一份
    };
  }

  /* 把 fit 的结果翻译成 addTable 的参数。别手写这几项 —— 上面那四条坑全在这儿一次性堵掉。 */
  function tableOpts(fitres, extra) {
    const colW = fitres.colW || [];
    const w = Math.round(colW.reduce((a, b) => a + b, 0) * 1000) / 1000;
    return Object.assign({
      colW: colW,
      w: w,                                         // 必须和 colW 一起给，否则外框掉回 75%
      rowH: fitres.rowH,
      fontSize: fitres.fontSize,
      margin: tableMargin(),                        // 英寸（< 1），不是磅
      valign: 'middle',
    }, extra || {});
  }

  /* 列太多、一张片实在放不下时按列分页。
     keepFirst=true 会把第 0 列（行名）重复到每一页 —— 没有行名的续页是废纸。
     返回 [[列下标…], …]；chunkAt 为每页最多多少列（0/不传 = 不分页）。 */
  function paginateCols(nCol, chunkAt, keepFirst) {
    if (!chunkAt || nCol <= chunkAt) return [range(0, nCol)];
    const pages = [];
    const first = keepFirst ? [0] : [];
    let i = keepFirst ? 1 : 0;
    const per = Math.max(1, chunkAt - first.length);
    while (i < nCol) { pages.push(first.concat(range(i, Math.min(nCol, i + per)))); i += per; }
    return pages;
  }
  function range(a, b) { const o = []; for (let i = a; i < b; i++) o.push(i); return o; }
  function pickCols(rows, idxs) { return (rows || []).map(r => idxs.map(i => (r || [])[i])); }

  return {
    heuristicWidth, makeCanvasMeasurer, naturalWidths, distribute, fit,
    paginateCols, pickCols, cellText, cellBold, tableMargin, tableOpts,
    PT_PER_IN, CELL_MARGIN_IN, SLACK_IN,
  };
});

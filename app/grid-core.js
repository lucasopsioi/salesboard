/* ============================================================
   Salesboard — grid-core.js
   表格「Excel 化」的纯内核：区域选择 / 统计条 / 剪贴板 TSV / 数字解析 / 列宽。
   （2026-09-07 用户：「双击编辑单元格，单击选中，选中输入数据就能直接编辑，
     同时要有求和、计数、平均的功能栏」）

   为什么单独拆一个文件：这些逻辑全是纯函数，能单测；视图层只负责 DOM。
   踩过的坑写在各函数头上，别原地重犯。
   ============================================================ */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.GridCore = api;
})(this, function () {
  'use strict';

  /* —— 选区 ——
     选区永远存 {anchor, focus} 两个点（锚点 = 起始格，焦点 = 当前格），
     渲染时才归一成矩形。不要直接存矩形：Shift+方向键要能「反向缩小」，
     只有保留锚点才知道往哪边缩。 */
  function normRange(a, b) {
    const A = a || { r: 0, c: 0 }, B = b || A;
    return {
      r0: Math.min(A.r, B.r), r1: Math.max(A.r, B.r),
      c0: Math.min(A.c, B.c), c1: Math.max(A.c, B.c),
    };
  }
  function inRange(rg, r, c) {
    return !!rg && r >= rg.r0 && r <= rg.r1 && c >= rg.c0 && c <= rg.c1;
  }
  function rangeSize(rg) {
    if (!rg) return 0;
    return (rg.r1 - rg.r0 + 1) * (rg.c1 - rg.c0 + 1);
  }
  function clampPos(p, bounds) {
    const b = bounds || { rows: 1, cols: 1 };
    return {
      r: Math.max(0, Math.min((b.rows || 1) - 1, p.r)),
      c: Math.max(0, Math.min((b.cols || 1) - 1, p.c)),
    };
  }
  /* 方向移动。Excel 的 Tab 走到行尾会折到下一行行首，Enter 走到列底不折——
     这里只做前者（折行），Enter 折行会让「一列一列往下拍数」变得很别扭。 */
  function movePos(p, dir, bounds, opts) {
    const o = opts || {};
    let r = p.r, c = p.c;
    if (dir === 'up') r--;
    else if (dir === 'down') r++;
    else if (dir === 'left') c--;
    else if (dir === 'right') c++;
    else if (dir === 'home') c = 0;
    else if (dir === 'end') c = (bounds.cols || 1) - 1;
    else if (dir === 'top') r = 0;
    else if (dir === 'bottom') r = (bounds.rows || 1) - 1;
    // 折行只在**真的还有下/上一行**时发生；否则原地不动。
    // （否则表尾按 Tab 会跳回本行第一列，看着像光标乱飞）
    if (o.wrap && dir === 'right' && c > (bounds.cols || 1) - 1) {
      if (r + 1 > (bounds.rows || 1) - 1) return { r: p.r, c: p.c };
      c = 0; r++;
    }
    if (o.wrap && dir === 'left' && c < 0) {
      if (r - 1 < 0) return { r: p.r, c: p.c };
      c = (bounds.cols || 1) - 1; r--;
    }
    return clampPos({ r: r, c: c }, bounds);
  }

  /* —— 统计条 ——
     口径纪律（和看板其它地方一致）：
       · 计数 = 选中的**非空**格子数（Excel 的 COUNTA 语义，空格不算）
       · 数值个数 = 其中能解析成数的个数；求和/平均只用这些
       · 平均 = 求和 ÷ 数值个数，**不是** ÷ 选区格子数（空格不当 0 参与平均）
     这条最容易错：把空格当 0 平均，一片空白选区会把均值拉到 0，看着像业务塌了。 */
  function statsOf(values) {
    let count = 0, numCount = 0, sum = 0, min = null, max = null;
    (values || []).forEach(v => {
      const s = (v == null) ? '' : String(v).trim();
      if (s === '' || s === '—' || s === '-') return;
      count++;
      const n = parseNum(s);
      if (n == null) return;
      numCount++; sum += n;
      if (min == null || n < min) min = n;
      if (max == null || n > max) max = n;
    });
    return {
      count: count, numCount: numCount,
      sum: numCount ? sum : null,
      avg: numCount ? sum / numCount : null,
      min: min, max: max,
    };
  }

  /* 数字解析：容忍千分位、全角、空白、百分号、括号负数（会计写法 (123) = -123）。
     解析不出来返回 null —— 绝不返回 0，null 和 0 在这个看板里是两件事。 */
  function parseNum(s) {
    if (s == null) return null;
    if (typeof s === 'number') return isFinite(s) ? s : null;
    let t = String(s).trim()
      .replace(/[，,\s ]/g, '')
      .replace(/[０-９．－]/g, ch => '0123456789.-'['０１２３４５６７８９．－'.indexOf(ch)]);
    if (!t) return null;
    let sign = 1;
    if (/^\(.*\)$/.test(t)) { sign = -1; t = t.slice(1, -1); }
    let pct = false;
    if (/%$/.test(t)) { pct = true; t = t.slice(0, -1); }
    if (!/^[+-]?(\d+\.?\d*|\.\d+)$/.test(t)) return null;
    const n = parseFloat(t);
    if (!isFinite(n)) return null;
    return sign * (pct ? n / 100 : n);
  }

  /* —— 剪贴板 ——
     TSV 是 Excel 复制到剪贴板的原生格式，所以「从 Excel 粘一片数进来」这条路
     只要能解析 TSV 就通了。CRLF/CR 都要吃（Windows Excel 给的是 CRLF）。
     末尾空行要丢，否则粘贴区域会凭空多一行把下面的数清掉。 */
  function parseTsv(text) {
    const s = String(text == null ? '' : text).replace(/\r\n?/g, '\n');
    const lines = s.split('\n');
    while (lines.length && lines[lines.length - 1] === '') lines.pop();
    if (!lines.length) return [];
    return lines.map(l => l.split('\t'));
  }
  function toTsv(matrix) {
    return (matrix || []).map(row => (row || []).map(v => (v == null ? '' : String(v))).join('\t')).join('\n');
  }

  /* 把一块 TSV 铺到从 (r,c) 开始的位置，返回 [{r,c,value}]。
     Excel 的行为：粘贴块比选区大就照块的大小铺开（不裁剪）；
     选区是块的整数倍时会重复填充——那条太容易误伤，这里不做。
     bounds 之外的一律丢弃（不许写到表外）。 */
  function spreadPaste(matrix, start, bounds) {
    const out = [];
    const b = bounds || { rows: 1e9, cols: 1e9 };
    (matrix || []).forEach((row, dr) => {
      (row || []).forEach((v, dc) => {
        const r = start.r + dr, c = start.c + dc;
        if (r < 0 || c < 0 || r >= b.rows || c >= b.cols) return;
        out.push({ r: r, c: c, value: v });
      });
    });
    return out;
  }

  /* —— 列宽 ——
     冻结列的 left 偏移必须由列宽**累加**得出，写死像素就会在改列宽后错位
     （旧实现正是写死的 0/150/280/370/460/550，一改宽度整排就叠上去了）。 */
  function leftOffsets(widths, frozenCount) {
    const n = Math.max(0, Math.min(frozenCount == null ? widths.length : frozenCount, widths.length));
    const out = []; let acc = 0;
    for (let i = 0; i < widths.length; i++) {
      out.push(i < n ? acc : null);
      if (i < n) acc += (+widths[i] || 0);
    }
    return out;
  }
  function clampWidth(w, min, max) {
    return Math.max(min == null ? 40 : min, Math.min(max == null ? 600 : max, Math.round(+w || 0)));
  }

  return {
    normRange, inRange, rangeSize, clampPos, movePos,
    statsOf, parseNum, parseTsv, toTsv, spreadPaste,
    leftOffsets, clampWidth,
  };
});

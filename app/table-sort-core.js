'use strict';
/* ============================================================
   表格「自定义排序」共享内核 —— 国家看板(country) + 汇总表(report) 共用。
   UMD：浏览器挂 window.TableSort，Node 可 require 单测。

   规则（两个看板完全一致）：
   · 开关【关】= 默认排序 —— 走各看板自己的 fallback（原有逻辑原样不动），
     表头不可点、不显示箭头。这是唯一「回得去」的基准态。
   · 开关【开】= 自定义排序 —— 点表头按该列排；再点同列翻转升↔降。
     首点数值列→降序(▼ 高→低，符合看数习惯)；首点文本列(维度名/Product Series)→升序(▲)。
   · 箭头语义：▲=升序(dir=1)、▼=降序(dir=-1)。
     （注：旧代码 `dir<0?'▲':'▼'` 与实际方向相反，本内核按真实方向出箭头。）
   · 关开关只是「不应用」sortKey/sortDir，不清空 —— 再打开能回到上次那一列。
   ============================================================ */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.TableSort = api;
})(this, function () {
  const ASC = 1, DESC = -1;

  // 文本列：列定义里 left:true（维度名/Product Series 这类左对齐列）视为文本列
  function isTextCol(col) { return !!(col && (col.left || col.text)); }

  function findCol(cols, key) {
    if (!cols || !key) return null;
    for (let i = 0; i < cols.length; i++) if (cols[i] && cols[i].key === key) return cols[i];
    return null;
  }

  /* 点表头 → 下一个 {key,dir}。cur={key,dir}；col 为被点列的列定义（决定首点方向）。 */
  function nextSort(cur, key, col) {
    const c = cur || {};
    if (c.key === key) return { key: key, dir: c.dir === DESC ? ASC : DESC };
    return { key: key, dir: isTextCol(col) ? ASC : DESC };
  }

  /* 表头箭头：仅在【开】且正是当前排序列时出箭头。st={custom,key,dir} */
  function arrow(colKey, st) {
    if (!st || !st.custom || !st.key || st.key !== colKey) return '';
    return st.dir === DESC ? ' ▼' : ' ▲';
  }

  /* 单元格比较：字符串按中文 localeCompare；数字里 null/NaN/±Inf 统一沉底（当最小值）。 */
  function compare(va, vb, dir) {
    const d = dir === DESC ? DESC : ASC;
    if (typeof va === 'string' || typeof vb === 'string') {
      return String(va == null ? '' : va).localeCompare(String(vb == null ? '' : vb), 'zh') * d;
    }
    const na = va == null || !isFinite(va) ? -Infinity : va;
    const nb = vb == null || !isFinite(vb) ? -Infinity : vb;
    if (na === nb) return 0;
    return na < nb ? -d : d;
  }

  /* 当前是否真的在自定义排序（开关开 + 选中列确实存在于列定义里）。
     列不存在（换了维度导致列消失）自动退回默认，不会排出一堆空值。 */
  function isActive(st) { return !!(st && st.custom && st.key && findCol(st.cols, st.key)); }

  /* 主入口。永不改入参数组，永远返回新数组。
     st = {custom, key, dir, cols, fallback(rowsCopy)->rows}
     开关关 / 未选列 / 列已不存在 → 交给 fallback（各看板原有默认排序）。 */
  function sortRows(rows, st) {
    const src = (rows || []).slice();
    const s = st || {};
    const col = s.custom && s.key ? findCol(s.cols, s.key) : null;
    if (!col) return typeof s.fallback === 'function' ? (s.fallback(src) || src) : src;
    const get = typeof col.get === 'function' ? col.get : (o => (o ? o[col.key] : undefined));
    return src.sort((a, b) => compare(get(a), get(b), s.dir));
  }

  /* 开关按钮文案（两个看板共用，保证措辞一致） */
  function btnLabel(custom) { return custom ? '⇅ 自定义排序：开' : '⇅ 自定义排序：关'; }
  const BTN_TITLE = '关=按各看板默认顺序（国家看板：系列高→低端/累计SO高→低；汇总表：累计SO高→低）\n开=点任意表头按该列排序，再点同列切换升↔降（▲升 ▼降）';

  return { ASC, DESC, isTextCol, findCol, nextSort, arrow, compare, isActive, sortRows, btnLabel, BTN_TITLE };
});

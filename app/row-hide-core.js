'use strict';
/* ============================================================
   「隐藏行」共享内核 —— 国家看板(country) + 汇总表(report) 共用。
   UMD：浏览器挂 window.RowHide，Node 可 require 单测。

   只管列表数学(增/删/过滤/计数)，不碰存储：两个看板的 localStorage
   键和作用域不同（国家看板按「看板维度|块名|拆分维度」分桶，汇总表按
   「拆分维度」分桶），各自保留自己的存取，保证互不串味。

   口径（沿用国家看板既有规则，不变）：
   · 隐藏只影响明细行的「显示 + 导出」；
   · 合计行来自引擎按筛选范围全量汇总，不随隐藏变。
   ============================================================ */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.RowHide = api;
})(this, function () {

  function norm(list) { return Array.isArray(list) ? list.filter(k => k != null).map(String) : []; }

  /* 加入隐藏名单（幂等：已在名单里不重复加）。返回新数组，不改入参。 */
  function add(list, key) {
    const l = norm(list); const k = String(key);
    return l.indexOf(k) >= 0 ? l : l.concat([k]);
  }

  /* 移出隐藏名单（恢复某一行）。返回新数组，不改入参。 */
  function remove(list, key) {
    const k = String(key);
    return norm(list).filter(x => x !== k);
  }

  /* 过滤出可见行。keyOf 缺省取 o.key。名单为空时原样返回（省一次遍历）。 */
  function visible(rows, list, keyOf) {
    const src = rows || [];
    const l = norm(list);
    if (!l.length) return src.slice();
    const set = {}; l.forEach(k => { set[k] = 1; });
    const get = typeof keyOf === 'function' ? keyOf : (o => (o ? o.key : undefined));
    return src.filter(o => !set[String(get(o))]);
  }

  function count(list) { return norm(list).length; }

  /* 名单里已不存在于当前数据的 key（换了维度/筛选后的残留）——用于恢复面板只列有意义的行。
     注意：不主动清理存档，避免用户切回原维度后隐藏状态丢失。 */
  function stale(list, rows, keyOf) {
    const get = typeof keyOf === 'function' ? keyOf : (o => (o ? o.key : undefined));
    const have = {}; (rows || []).forEach(o => { have[String(get(o))] = 1; });
    return norm(list).filter(k => !have[k]);
  }

  return { add, remove, visible, count, stale };
});

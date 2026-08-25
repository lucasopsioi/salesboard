'use strict';
/* ============================================================
   「行自定义顺序」共享内核 —— 周报里所有分系列/分产品/分国家办表共用。
   UMD:浏览器挂 window.RowOrder,Node 可 require 单测。

   只管顺序数学,不碰存储(各表自己按 产业|表|维度 键存 localStorage)。

   口径(用户 2026-08-24):
   · 拖拽后的顺序**持久化**,下次打开还是这个样子;
   · **新出现的行(新品)必须显示**——不在已存顺序里的行按原相对顺序 append 到尾部,
     用户看得见,再自行挑选(隐藏)与排序;
   · 顺序只影响显示与导出的行序,不影响合计与任何计算口径。
   ============================================================ */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.RowOrder = api;
})(this, function () {

  function norm(list) { return Array.isArray(list) ? list.filter(k => k != null).map(String) : []; }

  /* 把 keys 按 saved 的相对顺序重排:
     · saved 里出现且 keys 里存在的,按 saved 的先后在前;
     · keys 里有但 saved 没有的(新品),按 keys 原相对顺序接在后面;
     · saved 里有但 keys 没有的(已下市/被上游筛掉),直接忽略。
     纯重排,不增不删——排序前后集合恒等。 */
  function apply(keys, saved) {
    const ks = norm(keys);
    const sv = norm(saved);
    if (!sv.length) return ks.slice();
    const present = {};
    ks.forEach(k => { present[k] = 1; });
    const inSaved = {};
    const head = [];
    sv.forEach(k => { if (present[k] && !inSaved[k]) { inSaved[k] = 1; head.push(k); } });
    const tail = ks.filter(k => !inSaved[k]);
    return head.concat(tail);
  }

  /* 拖拽落点:把 fromIdx 的行挪到 toIdx 位置(displayed 是当前显示序)。
     返回新数组,不改入参;越界原样返回。 */
  function move(displayed, fromIdx, toIdx) {
    const arr = norm(displayed);
    if (fromIdx < 0 || fromIdx >= arr.length || toIdx < 0 || toIdx >= arr.length || fromIdx === toIdx) return arr;
    const [it] = arr.splice(fromIdx, 1);
    arr.splice(toIdx, 0, it);
    return arr;
  }

  return { apply, move };
});

(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.NavOrder = api;
})(this, function () {
  // 用保存的顺序/隐藏 + 默认顺序，算出最终顺序与隐藏集合：
  // - 过滤掉已不存在的视图；默认里有、保存里没有的“新视图”按默认相对顺序追加末尾；
  // - 隐藏集合同样过滤；saved 非数组/空 → order=默认。
  function reconcileNav(savedOrder, hiddenArr, defaultOrder) {
    const def = (defaultOrder || []).slice();
    const defSet = new Set(def);
    const saved = Array.isArray(savedOrder) ? savedOrder.filter(v => defSet.has(v)) : [];
    const seen = new Set(saved);
    const order = saved.concat(def.filter(v => !seen.has(v)));
    const hidden = new Set((Array.isArray(hiddenArr) ? hiddenArr : []).filter(v => defSet.has(v)));
    return { order, hidden };
  }
  return { reconcileNav };
});

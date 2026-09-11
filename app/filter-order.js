(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.FilterOrder = api;
})(this, function () {
  // 产品维度在前(Product Line 第一)，再地理
  const FILTER_FIELDS = ['line', 'family', 'series', 'product', 'model', 'region', 'repOffice', 'country', 'channel'];
  return { FILTER_FIELDS };
});

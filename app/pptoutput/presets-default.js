(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.PptPresets = api;
})(this, function () {
  return {
    '手机': { familyFilter: { family: ['手机'] }, idcCat: '手机', groups: {
      'p4.kpi.1': { label: '手机SO',     filter: {} },
      'p4.kpi.2': { label: '旗舰SO',     filter: { series: ['折叠屏', 'Vega系列', 'Astra系列'] } },
      'p4.kpi.3': { label: 'nimbus精品SO', filter: { series: ['nimbus精品'] } },
      'p4.kpi.4': { label: 'nimbus Y SO',  filter: { series: ['nimbus Y系列'] } }
    } },
    '平板': { familyFilter: { family: ['平板'] }, idcCat: '平板', groups: {
      'p4.kpi.1': { label: '平板SO',         filter: {} },
      'p4.kpi.2': { label: 'Slate Pro SO', filter: { line: ['Slate Pro'] } },
      'p4.kpi.3': { label: 'Slate SE SO',  filter: { line: ['Slate SE'] } },
      'p4.kpi.4': { label: '其他平板SO',     filter: {} }
    } },
    '音频与智能配件': { familyFilter: { family: ['音频与智能配件'] }, idcCat: '音频', groups: {
      'p4.kpi.1': { label: '音频SO',        filter: {} },
      'p4.kpi.2': { label: 'TWS旗舰系列SO', filter: { line: ['TWS旗舰系列'] } },
      'p4.kpi.3': { label: '开放式耳机SO',  filter: { line: ['开放式耳机'] } },
      'p4.kpi.4': { label: '颈戴耳机SO',    filter: { line: ['颈戴耳机'] } }
    } }
  };
});

(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.PptTplLatamPhone = api;
})(this, function () {
  return {
    templateId: 'latam-phone-review',
    matchRe: '文稿1|复盘',
    slide: { no: 4, file: 'ppt/slides/slide4.xml' },
    titleShape: 'Text 0',
    kpis: [
      { id: 'p4.kpi.1', labelShape: 'Text 2',  valueShape: 'Text 3',  yoyShape: 'Text 4'  },
      { id: 'p4.kpi.2', labelShape: 'Text 5',  valueShape: 'Text 6',  yoyShape: 'Text 7'  },
      { id: 'p4.kpi.3', labelShape: 'Text 8',  valueShape: 'Text 9',  yoyShape: 'Text 10' },
      { id: 'p4.kpi.4', labelShape: 'Text 11', valueShape: 'Text 12', yoyShape: 'Text 13' }
    ],
    charts: [
      { id: 'p4.chart.series',  captionShape: 'Text 14', chartFile: 'ppt/charts/chart2.xml',
        embedFile: 'ppt/embeddings/Microsoft_Excel_Worksheet1.xlsx', legend: 'line' },
      { id: 'p4.chart.country', captionShape: 'Text 15', chartFile: 'ppt/charts/chart3.xml',
        embedFile: 'ppt/embeddings/Microsoft_Excel_Worksheet2.xlsx', legend: 'country' }
    ],
    pages: [
      { id: 'P4', slideNo: 4, name: '手机产业SO', dataset: 'psi' },
      { id: 'P5', slideNo: 5, name: 'Astra操盘',   dataset: 'psi' },
      { id: 'P6', slideNo: 6, name: '看大盘·品牌/档位', dataset: 'idc' },
      { id: 'P7', slideNo: 7, name: '看国家·品牌/档位', dataset: 'idc' }
    ],
    p4: {
      slideNo: 4, slideFile: 'ppt/slides/slide4.xml', titleShape: 'Text 0',
      needDims: ['line', 'model', 'channel'],
      kpis: [
        { id: 'p4.kpi.1', labelShape: 'Text 2',  valueShape: 'Text 3',  yoyShape: 'Text 4'  },
        { id: 'p4.kpi.2', labelShape: 'Text 5',  valueShape: 'Text 6',  yoyShape: 'Text 7'  },
        { id: 'p4.kpi.3', labelShape: 'Text 8',  valueShape: 'Text 9',  yoyShape: 'Text 10' },
        { id: 'p4.kpi.4', labelShape: 'Text 11', valueShape: 'Text 12', yoyShape: 'Text 13' }
      ],
      charts: [
        { id: 'p4.chart.series',  chartFile: 'ppt/charts/chart2.xml', embedFile: 'ppt/embeddings/Microsoft_Excel_Worksheet1.xlsx', legend: 'line' },
        { id: 'p4.chart.country', chartFile: 'ppt/charts/chart3.xml', embedFile: 'ppt/embeddings/Microsoft_Excel_Worksheet2.xlsx', legend: 'country' }
      ]
    },
    p5: {
      slideNo: 5, slideFile: 'ppt/slides/slide5.xml', titleShape: 'Text 0',
      needDims: ['product', 'line', 'channel'],
      chart: { id: 'p5.chart.so', chartFile: 'ppt/charts/chart4.xml', embedFile: 'ppt/embeddings/Microsoft_Excel_Worksheet3.xlsx', legend: 'product', catField: 'period', catGran: 'week' },
      narratives: [
        { id: 'p5.note.region', shape: 'Text 2', tIndex: 1, default: '大区操盘总结' },
        { id: 'p5.note.rep',    shape: 'Text 3', tIndex: 1, default: '各国家办操盘总结' }
      ]
    },
    p6: {
      slideNo: 6, slideFile: 'ppt/slides/slide6.xml', titleShape: 'Text 0',
      needDims: ['pbStd', 'brand'],
      charts: [
        { id: 'p6.all',  chartFile: 'ppt/charts/chart5.xml', embedFile: 'ppt/embeddings/Microsoft_Excel_Worksheet4.xlsx', catField: 'quarter', legend: 'brand', share: true },
        { id: 'p6.band', chartFile: 'ppt/charts/chart6.xml', embedFile: 'ppt/embeddings/Microsoft_Excel_Worksheet5.xlsx', catField: 'pbStd', legend: 'brand', share: true }
      ]
    },
    p7: {
      slideNo: 7, slideFile: 'ppt/slides/slide7.xml', titleShape: 'Text 0',
      needDims: ['pbStd', 'brand'],
      countries: [
        { label: '墨西哥',   countryValue: 'Mexico',    chartFile: 'ppt/charts/chart7.xml',  embedFile: 'ppt/embeddings/Microsoft_Excel_Worksheet6.xlsx' },
        { label: '智利',     countryValue: 'Chile',     chartFile: 'ppt/charts/chart8.xml',  embedFile: 'ppt/embeddings/Microsoft_Excel_Worksheet7.xlsx' },
        { label: '阿根廷',   countryValue: 'Argentina', chartFile: 'ppt/charts/chart9.xml',  embedFile: 'ppt/embeddings/Microsoft_Excel_Worksheet8.xlsx' },
        { label: '哥伦比亚', countryValue: 'Colombia',  chartFile: 'ppt/charts/chart10.xml', embedFile: 'ppt/embeddings/Microsoft_Excel_Worksheet9.xlsx' },
        { label: '秘鲁',     countryValue: 'Peru',      chartFile: 'ppt/charts/chart11.xml', embedFile: 'ppt/embeddings/Microsoft_Excel_Worksheet10.xlsx' }
      ],
      catField: 'pbStd', legend: 'brand', share: true
    }
  };
});

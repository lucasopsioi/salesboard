'use strict';
/* Synthetic FOB sample: 22 fictional tablet models (LatAm region) with seeded pseudo-random
   net prices and monthly discount curves. Stored in wide form; toColumn() serialises it back into
   the single long column an export produces, so the end-to-end parse path is exercised.
   Shared by the tests and the "load sample" button. No real product, price or rate appears here. */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.FobSample = api;
})(this, function () {
  const START_MONTH = 202607, MONTH_COUNT = 13;
  const D = ['Default', 'Default', 'Default', 'Default'];
  const R = (series, product, model, price, eff, base, rates) =>
    ['拉美区域'].concat(D, ['平板', series, product, model, 'FOB净价', 'USD', price, eff, base], rates, ['0']);
  const ROWS = [
    R('Slate Air', 'Slate Air(Tovik)', 'Tovik-W09AP', '374.70', '46181', '0', ['0.104', '0.125', '0.134', '0.159', '0.176', '0.196', '0.220', '0.225', '0.225', '0.225', '0.225', '0.225', '0.238']),
    R('Slate Air', 'Slate Air(Tovik)', 'Tovik-W09CK', '401.70', '45712', '0', ['-0.237', '-0.247', '-0.247', '-0.269', '-0.308', '-0.308', '-0.308', '-0.317', '-0.321', '-0.350', '-0.350', '-0.376', '-0.410']),
    R('Slate Air', 'Slate Air(Tovik)', 'Tovik-W29', '413.70', '46300', '0', ['0.038', '0.039', '0.039', '0.060', '0.062', '0.062', '0.080', '0.080', '0.080', '0.110', '0.133', '0.137', '0.155']),
    R('Slate Air', 'Slate 12 X(Vernet)', 'Vernet-W29', '339.20', '46276', '0', ['0.123', '0.148', '0.180', '0.180', '0.184', '0.184', '0.184', '0.184', '0.184', '0.197', '0.197', '0.237', '0.251']),
    R('Slate Air', 'Slate 12 X(Vernet)', 'Vernet-W29CK', '269.20', '46279', '0', ['0.069', '0.069', '0.092', '0.092', '0.093', '0.126', '0.142', '0.142', '0.166', '0.167', '0.167', '0.167', '0.172']),
    R('Slate Pro', 'Slate Pro Max(Quanta)', 'Quanta-W09CK', '627.70', '46086', '0', ['0.042', '0.054', '0.054', '0.054', '0.059', '0.073', '0.111', '0.140', '0.140', '0.167', '0.199', '0.222', '0.222']),
    R('Slate Pro', 'Slate Pro Max(Quanta)', 'Quanta-W29', '319.70', '45756', '0', ['-0.053', '-0.080', '-0.083', '-0.101', '-0.107', '-0.115', '-0.148', '-0.185', '-0.219', '-0.219', '-0.238', '-0.238', '-0.238']),
    R('Slate Pro', 'Slate Pro(Tarvos)', 'Tarvos-W09DK', '700', '46111', '0', ['0.100', '0.130', '0.160', '0.175', '0.189', '0.208', '0.230', '0.247', '0.266', '0.282', '0.302', '0.318', '0.338']),
    R('Slate SE', 'Slate SE 11"(Vantor6)', 'Vantor6-W09', '155.20', '46172', '0', ['0.187', '0.193', '0.193', '0.196', '0.220', '0.241', '0.241', '0.268', '0.271', '0.271', '0.292', '0.317', '0.338']),
    R('Slate SE', 'Slate SE 11"(Vantor6)', 'Vantor6-W19', '564.70', '46235', '0', ['0.156', '0.156', '0.156', '0.156', '0.156', '0.156', '0.192', '0.230', '0.260', '0.299', '0.316', '0.331', '0.331']),
    R('Slate SE', 'Slate SE 11"(Vantor6)', 'Vantor6-W19C', '120', '45897', '0', ['-0.050', '-0.110', '-0.170', '-0.230', '-0.290', '-0.350', '-0.410', '-0.470', '-0.530', '-0.590', '-0.650', '-0.710', '-0.800']),
    R('Slate SE', 'Slate SE 11"(Vantor6R)', 'Vantor6R-W09', '412.20', '45667', '0', ['0.010', '0.024', '0.028', '0.028', '0.033', '0.033', '0.033', '0.068', '0.076', '0.102', '0.102', '0.133', '0.133']),
    R('Slate SE', 'Slate SE 11"(Vantor6R)', 'Vantor6R-W19', '558.70', '46120', '0', ['0.193', '0.206', '0.206', '0.217', '0.243', '0.243', '0.243', '0.275', '0.292', '0.310', '0.326', '0.326', '0.360']),
    R('Slate SE', 'Slate SE/Slate SE 11"(Vantor6)', 'Vantor6-L09', '650.20', '45725', '0', ['0.089', '0.094', '0.099', '0.107', '0.120', '0.120', '0.142', '0.142', '0.142', '0.157', '0.157', '0.157', '0.170']),
    R('Slate SE', 'Slate SE/Slate SE 11"(Vantor6)', 'Vantor6-L19', '376.20', '45605', '0', ['0.016', '0.016', '0.055', '0.057', '0.080', '0.089', '0.120', '0.120', '0.120', '0.120', '0.120', '0.152', '0.164']),
    R('Slate', 'Slate 11.5 S(Halden)', 'Halden-W29FK', '400', '45625', '0', ['0.050', '0.069', '0.081', '0.086', '0.096', '0.096', '0.107', '0.121', '0.126', '0.141', '0.143', '0.143', '0.146']),
    R('Slate', 'Slate 11.5(Everest)', 'Everest-W09', '365.70', '45740', '0', ['-0.040', '-0.040', '-0.073', '-0.073', '-0.092', '-0.121', '-0.121', '-0.121', '-0.154', '-0.185', '-0.188', '-0.224', '-0.224']),
    R('Slate', 'Slate 11.5(Everest)', 'Everest-W19', '420.20', '45643', '0', ['-0.241', '-0.263', '-0.272', '-0.303', '-0.303', '-0.303', '-0.325', '-0.331', '-0.345', '-0.372', '-0.405', '-0.429', '-0.429']),
    R('Slate', 'Slate 11.5(Everest)', 'Everest-L09', '301.20', '45834', '0', ['0.146', '0.185', '0.225', '0.243', '0.243', '0.280', '0.292', '0.331', '0.341', '0.379', '0.412', '0.435', '0.448']),
    R('Slate', 'Slate 11.5(Everest)', 'Everest-L19', '483.20', '46174', '0', ['-0.179', '-0.179', '-0.179', '-0.179', '-0.209', '-0.240', '-0.250', '-0.250', '-0.273', '-0.273', '-0.288', '-0.289', '-0.289']),
    R('Slate', 'Slate Mini(Redwood)', 'Redwood-W09', '543.20', '45743', '0', ['0.004', '0.004', '0.018', '0.018', '0.018', '0.018', '0.032', '0.032', '0.063', '0.078', '0.078', '0.109', '0.116']),
    R('Slate', 'Slate Mini(Redwood)', 'Redwood-W29', '157.20', '46165', '0', ['0.132', '0.163', '0.180', '0.194', '0.227', '0.227', '0.244', '0.244', '0.244', '0.244', '0.260', '0.287', '0.287']),
  ];

  /* wide table -> the long export column (column-major: all N product values of one field, then the next field) */
  function toColumn(rows, extraLeadFields, asPercent) {
    rows = rows || ROWS;
    const n = rows.length;
    const out = [];
    for (let i = 0; i < (extraLeadFields || 0); i++) {
      for (let p = 0; p < n; p++) out.push('LEAD' + i);
    }
    for (let f = 0; f < rows[0].length; f++) {
      for (const r of rows) {
        const v = r[f];
        out.push((asPercent && f >= 13) ? (Number(v) * 100).toFixed(2) + '%' : v);
      }
    }
    return out.join('\n');
  }
  function toTableText(rows) { return (rows || ROWS).map(r => r.join('\t')).join('\n'); }
  function toVerticalText(rows) {
    rows = rows || ROWS;
    return rows[0].map((_, f) => rows.map(r => r[f]).join('\t')).join('\n');
  }
  return { START_MONTH, MONTH_COUNT, ROWS, toColumn, toTableText, toVerticalText };
});

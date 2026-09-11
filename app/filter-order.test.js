const fs = require('fs'), os = require('os'), path = require('path');
const E = require('../engine.js');
let f = 0; const ok = (n, c) => { console.log((c ? 'PASS ' : 'FAIL ') + n); if (!c) f++; };

// 1) 引擎能从英文表头识别 Product Family
const csv = [
  'Management Region,Rep Office,Country,Channel,Product Family,Product Line,Product Series,Product,Product Model,Period ID,PSI Type,QTY',
  'LATAM,South Cone,Chile,Offline,Tablet,Slate Tab,Slate Pro,Slate Pro 13.2,Tarvos-W09DK,2026-01-01,Sell Out,100',
  'LATAM,South Cone,Chile,Offline,Audio,Open-ear,Taiga,SonicArc,Taiga-T00,2026-01-01,Sell Out,50'
].join('\n');
const tmp = path.join(os.tmpdir(), 'psi_family_test.csv'); fs.writeFileSync(tmp, csv, 'utf8');
const r = E.__psiTest.parseCSV(tmp);
ok('engine 识别 family 维度', r.dims.includes('family'));
ok('engine 识别 line 维度', r.dims.includes('line'));

// 2) 筛选顺序：产品维度在前，Product Line 第一
const FO = require('./filter-order.js');
ok('FILTER_FIELDS line 第一', FO.FILTER_FIELDS[0] === 'line');
ok('FILTER_FIELDS family 第二', FO.FILTER_FIELDS[1] === 'family');
ok('FILTER_FIELDS 地理在产品之后', FO.FILTER_FIELDS.indexOf('region') > FO.FILTER_FIELDS.indexOf('model'));

console.log(f ? ('\n' + f + ' FAILED') : '\nALL PASS'); process.exit(f ? 1 : 0);

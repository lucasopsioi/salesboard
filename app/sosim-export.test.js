// app/sosim-export.test.js
const XLSX = require('xlsx');
const E = require('./sosim-export.js');
let fails = 0;
const ok = (name, cond) => { console.log((cond ? 'PASS ' : 'FAIL ') + name); if (!cond) fails++; };

const table = {
  title: '墨西哥·Rigel-W09CK',
  colLabels: ['2025-01', '2025-02'],
  past: [true, false],
  rows: {
    shipment: [1000, 5000], sellIn: [800, 4000], sellOut: [500, 3000],
    channelInv: [300, 1300], channelDOS: [0, 0], fullInv: [500, 2500], fullDOS: [0, 0],
  },
};
const forecastRows = [{ country: '墨西哥', model: 'Rigel-W09CK', ymd: 20250201, metric: 'sellOut', value: 3000 }];
const wb = E.buildWorkbook({ tables: [table], forecastRows, mtime: '2026-06-26 10:00' });
ok('has _forecast', wb.SheetNames.indexOf('_forecast') >= 0);
ok('has _meta', wb.SheetNames.indexOf('_meta') >= 0);
// 未来列(2月)的 fullInv 应是公式
const sh = wb.Sheets[wb.SheetNames[0]];
const hasFormula = Object.keys(sh).some(a => sh[a] && sh[a].f);
ok('future cells carry formula', hasFormula);
// 精确公式（未来列=2月=数据列C，前列B；行: 发货2/SI3/SO4/渠道库存5/渠道DOS6/全流程库存7/全流程DOS8）
ok('channelInv formula C5', sh['C5'] && sh['C5'].f === 'B5+C3-C4');
ok('fullInv formula C7', sh['C7'] && sh['C7'].f === 'B7+C2-C4');
ok('channelDOS formula C6 (nDays fallback 30, 取整)', sh['C6'] && sh['C6'].f === 'ROUND(IFERROR(C5*30/C4,0),0)');
ok('fullDOS formula C8 (取整)', sh['C8'] && sh['C8'].f === 'ROUND(IFERROR(C7*30/C4,0),0)');
// round-trip
const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
const wb2 = XLSX.read(buf, { type: 'buffer' });
const parsed = E.parseWorkbook(wb2);
ok('parse mtime', parsed.mtime === '2026-06-26 10:00');
ok('parse forecast row', parsed.forecastRows.length === 1 && parsed.forecastRows[0].value === 3000 && parsed.forecastRows[0].ymd === 20250201);

console.log(fails ? ('\n' + fails + ' FAILED') : '\nALL PASS');
process.exit(fails ? 1 : 0);

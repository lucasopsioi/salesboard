// app/shipment-base.test.js
const { parseShipmentAoa, ymdOf } = require('./shipment-base.js');
let fails = 0;
const ok = (name, cond) => { console.log((cond ? 'PASS ' : 'FAIL ') + name); if (!cond) fails++; };

ok('ymdOf slash', ymdOf('2025/2/6') === 20250206);
ok('ymdOf dash', ymdOf('2025-02-06') === 20250206);
ok('ymdOf compact', ymdOf('20250206') === 20250206);
ok('ymdOf serial ~ 2025-02-06', Math.abs(ymdOf(45694) - 20250206) <= 1);

const aoa = [
  ['国家/地区','Product Family','Product Series','Product Model','数量','日期'],
  ['墨西哥','Slate Pro','Rigel','Rigel-W09CK',200,'2025/2/6'],
  ['墨西哥','Slate SE','Vantor6','Vantor6-W09DP',600,'2025/1/20'],
  ['墨西哥','','','',5,'2025/1/20'],            // 无型号 → 跳过
  ['墨西哥','Slate Pro','Rigel','Rigel-W09CK','x','2025/3/2'], // 数量NaN → 跳过
];
const rows = parseShipmentAoa(aoa);
ok('parsed 2 rows', rows.length === 2);
ok('row0 model', rows[0].model === 'Rigel-W09CK');
ok('row0 ymd', rows[0].ymd === 20250206);
ok('row0 qty', rows[0].qty === 200);
ok('row1 family', rows[1].family === 'Slate SE');

console.log(fails ? ('\n' + fails + ' FAILED') : '\nALL PASS');
process.exit(fails ? 1 : 0);

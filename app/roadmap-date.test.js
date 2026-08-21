// 路标「发货时间」日精度改造测试：ymNum 两格式解析（新 YYYY/MM/DD 日精度 · 旧 YYYY/MM 月初回退）、
// x 归一化单调性（含月内按日）、跨年、非法值容错、导出原样往返。见 roadmap-chart.js / roadmap-core.js。
const RC = require('./roadmap-chart.js');
const CORE = require('./roadmap-core.js');
let f = 0; const ok = (n, c) => { console.log((c ? 'PASS ' : 'FAIL ') + n); if (!c) f++; };
const approx = (n, a, b) => ok(n, a != null && Math.abs(a - b) < 1e-9);

// 1. 两格式解析
approx('新格式日精度 2025/01/15', RC.ymNum('2025/01/15'), 2025 * 12 + 1 + 14 / 31);
ok('旧格式月初回退(=整数月序,向后兼容) 2025/07', RC.ymNum('2025/07') === 2025 * 12 + 7);
ok('旧格式无补零 2025/7', RC.ymNum('2025/7') === 2025 * 12 + 7);
ok('新格式当月01日 == 旧月粒度', RC.ymNum('2025/07/01') === RC.ymNum('2025/07'));
approx('日精度当月末 2025/02/28', RC.ymNum('2025/02/28'), 2025 * 12 + 2 + 27 / 28);
approx('闰月末日 2024/02/29', RC.ymNum('2024/02/29'), 2024 * 12 + 2 + 28 / 29);
ok('分隔符 - . 皆兼容', RC.ymNum('2025-06-18') === RC.ymNum('2025/06/18') && RC.ymNum('2025.06.18') === RC.ymNum('2025/06/18'));

// 2. x 归一化单调性：1月1日 < 1月15日 < 2月1日（月内按日插值）
const ts = RC.timeScale([{ shipLate: '2025/01/01' }, { shipLate: '2025/12/31' }]);
const xa = ts.x('2025/01/01'), xb = ts.x('2025/01/15'), xc = ts.x('2025/02/01');
ok('x 单调 1/1<1/15<2/1', xa < xb && xb < xc);
ok('ymNum 单调 1/1<1/15<2/1', RC.ymNum('2025/01/01') < RC.ymNum('2025/01/15') && RC.ymNum('2025/01/15') < RC.ymNum('2025/02/01'));
ok('x 首尾锚定 0..1', Math.abs(ts.x('2025/01/01') - 0) < 1e-9 && Math.abs(ts.x('2025/12/31') - 1) < 1e-9);

// 3. 跨年单调
ok('跨年 2024/12/31 < 2025/01/01', RC.ymNum('2024/12/31') < RC.ymNum('2025/01/01'));
ok('跨年 2024/12 < 2025/01(旧格式)', RC.ymNum('2024/12') < RC.ymNum('2025/01'));

// 4. 非法值容错 → null（不抛异常）
ok('非法值→null', ['', null, undefined, 'abc', '2025', 'xx/yy', '2025/13', '2025/00', '2025/13/05'].every(v => RC.ymNum(v) === null));
// 日越界 → 夹取到当月合法范围（容错，不 null、不崩）
approx('日越界夹取月末 2025/06/99', RC.ymNum('2025/06/99'), 2025 * 12 + 6 + 29 / 30);
ok('日为0夹取1日 2025/06/00 == 2025/06/01', RC.ymNum('2025/06/00') === RC.ymNum('2025/06/01'));

// 5. 导出原样往返：存储值(新/旧混用)原样输出，不被改写
const prod = { id: 'p1', name: 'RT', category: '手机', seriesGroup: 'S', compositeRrpUsd: 100, shipEarly: '2025/03', shipLate: '2025/06/18', skus: [{ name: 'a', color: '#111' }], pricing: [], packaging: [], accessories: {}, sellingPoints: [] };
const sheets = CORE.exportAoa([prod], [{ id: 's1', productId: 'p1', type: 'VN1', name: 'RT VN1', shipLate: '2025/09/05' }], [], []);
const row = sheets['产品总表'][1];
ok('导出最早发货原样(旧格式)', row[11] === '2025/03');
ok('导出最晚发货原样(日精度)', row[12] === '2025/06/18');
ok('导出样机可用时间原样', sheets['样机'][1][7] === '2025/09/05');

console.log(f ? ('\n' + f + ' FAILED') : '\nALL PASS'); process.exit(f ? 1 : 0);

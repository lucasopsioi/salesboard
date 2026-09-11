const C = require('./roadmap-core.js');
let f = 0; const ok = (n, c) => { console.log((c ? 'PASS ' : 'FAIL ') + n); if (!c) f++; };

ok('newId unique', C.newId() !== C.newId());
ok('validate empty -> 5 missing', C.validateProduct({}).length === 5);
ok('validate full ok', C.validateProduct({ name: 'X', category: '音频', seriesGroup: 'S', compositeRrpUsd: 99, shipLate: '2026/1' }).length === 0);
ok('validate missing price', C.validateProduct({ name: 'X', category: '音频', seriesGroup: 'S', compositeRrpUsd: null, shipLate: '2026/1' }).join().indexOf('综合RRP') >= 0);
ok('first4moSO basic', C.first4moSO([0, 0, 10, 20, 30, 40, 50]) === 100);   // 10+20+30+40
ok('first4moSO short', C.first4moSO([5, 5]) === 10);                          // 不足4月
ok('first4moSO empty', C.first4moSO([0, 0, 0]) === null);
// 回归：extractMonthlyTotals 兼容引擎对象形态 data:{系列:{桶:值}}（engine-psi.js query 输出），
// 早期只按数组 data[k][i] 取值恒 0 → first4moSO 恒 null。此处以真实形态验证「首4月SO」端到端能算出。
(function () {
  // 与 roadmap-ui.js extractMonthlyTotals 同款双形态取数（对象按桶名 / 数组按下标）
  const extract = (res) => {
    if (!res) return [];
    if (Array.isArray(res.totals)) return res.totals.map(v => +v || 0);
    const buckets = res.buckets || [], data = res.data || {}, keys = Object.keys(data);
    return buckets.map((b, i) => { let s = 0; for (const k of keys) { const cell = data[k]; if (Array.isArray(cell)) s += (+cell[i] || 0); else if (cell && typeof cell === 'object') s += (+cell[b] || 0); } return s; });
  };
  const objShape = { buckets: ['2026/01', '2026/02', '2026/03', '2026/04', '2026/05'], series: ['A', 'B'], data: { A: { '2026/01': 10, '2026/02': 20, '2026/03': 30, '2026/04': 40, '2026/05': 50 }, B: { '2026/01': 1, '2026/02': 2, '2026/03': 3, '2026/04': 4, '2026/05': 5 } } };
  const arrShape = { buckets: ['m1', 'm2', 'm3', 'm4'], data: { A: [3, 4, 5, 6] } };
  ok('extractMonthly object shape totals', extract(objShape).slice(0, 4).join() === '11,22,33,44');
  ok('extractMonthly object → first4moSO', C.first4moSO(extract(objShape)) === 110); // 11+22+33+44
  ok('extractMonthly array shape still works', C.first4moSO(extract(arrShape)) === 18); // 3+4+5+6
  ok('extractMonthly totals fast-path', extract({ totals: [1, 2, 3, 4] }).join() === '1,2,3,4');
})();
ok('defaultCompositeRrp max', C.defaultCompositeRrp([{ rrpUsd: 86 }, { rrpUsd: 90 }, { rrpUsd: 88 }]) === 90);
ok('defaultCompositeRrp empty', C.defaultCompositeRrp([]) === null);

// concept-import 记录真实字段：产品传播名=product、系列=series（不是 name/seriesGroup）
const recs = [
  { country: '墨西哥', sku: 'Strix-T02', offering: 'Strix-T02', currency: 'MXN', fx: 17.32, rrpLocal: 1499, tempIncentive: 0.10, product: 'SonicClip 2', series: '开放式耳机' },
  { country: '智利', sku: 'Strix-T02', offering: 'Strix-T02', currency: 'CLP', fx: 940, rrpLocal: 82900, tempIncentive: 0.12, product: 'SonicClip 2', series: '开放式耳机' },
  { country: '墨西哥', sku: 'Heron-T10', offering: 'Heron-T10', currency: 'MXN', fx: 17.32, rrpLocal: 2999, tempIncentive: 0.10, product: 'WATCH FIT', series: '智能手表' },
];
const pl = C.pricingFromLibrary(recs, 'Strix-T02');
ok('pricingFromLibrary rows', pl.rows.length === 2);
ok('pricingFromLibrary usd', Math.abs(pl.rows[0].rrpUsd - 1499 / 17.32) < 0.01);
ok('pricingFromLibrary incentive', pl.rows[0].reservedIncentive === 0.10);
ok('pricingFromLibrary name', pl.name === 'SonicClip 2' && pl.seriesGroup === '开放式耳机');
ok('pricingFromLibrary miss', C.pricingFromLibrary(recs, '__none__').rows.length === 0);

const prod = { name: 'SonicClip 2', internalCode: 'Strix-T02', certModel: 'R1', seriesGroup: '开放式耳机',
  skus: [{ name: '黑', color: '#000', ean: 'E1', ram: '8GB', rom: '128GB', chip: '星核', matte: true },
         { name: '白', color: '#fff', ean: 'E2', ram: '8GB', rom: '256GB', chip: '星核', matte: false }],
  matteMode: 'bySku', packaging: ['适配器', 'Inbox键盘'],
  accessories: { '键盘': { certModel: 'K1', name: '键盘A', internalCode: 'KB', color: '黑', skuRef: '黑' } },
  shipEarly: '2026/07', shipLate: '2027/06', compositeRrpUsd: 90, first4moSO: 1200,
  pricing: [{ country: '墨西哥', model: 'Strix-T02', currency: 'MXN', rrpLocal: 1499, fx: 17.32, rrpUsd: 86.5, reservedIncentive: 0.1, regularPrice: '' }] };
const ex = C.exportAoa([prod]);
ok('exportAoa sheets', ['产品总表', 'SKU明细', '分国定价', '配件'].every(k => Array.isArray(ex[k])));
ok('exportAoa 产品总表 rows', ex['产品总表'].length === 2);        // 表头 + 1 产品
ok('exportAoa SKU明细 rows', ex['SKU明细'].length === 3);          // 表头 + 2 SKU
ok('exportAoa 分国定价 rows', ex['分国定价'].length === 2);        // 表头 + 1 国家
ok('exportAoa 配件 rows', ex['配件'].length === 2);               // 表头 + 1 配件
ok('exportAoa 配件 旧单值skuRef照常导出', ex['配件'][1][6] === '黑');

/* ---------- accSkuList(Inbox配件关联SKU多选) ---------- */
ok('accSkuList 新数组优先', JSON.stringify(C.accSkuList({ skuRefs: ['黑', '白'], skuRef: '旧值' })) === '["黑","白"]');
ok('accSkuList 旧单值迁移', JSON.stringify(C.accSkuList({ skuRef: '黑' })) === '["黑"]');
ok('accSkuList 空/缺失', C.accSkuList({}).length === 0 && C.accSkuList(null).length === 0);
ok('accSkuList 数组去空', JSON.stringify(C.accSkuList({ skuRefs: ['黑', '', null, '白'] })) === '["黑","白"]');
// 多选导出:关联SKU 列为「、」连接
const prodM = JSON.parse(JSON.stringify(prod));
prodM.accessories['键盘'].skuRefs = ['黑', '白'];
const exM = C.exportAoa([prodM]);
ok('exportAoa 配件 多选导出 黑、白', exM['配件'][1][6] === '黑、白');

const ex2 = C.exportAoa([Object.assign({}, prod, { category: '音频', sellingPoints: [{ cn: '佩戴舒适', en: 'Comfort' }, { cn: '', en: '' }, { cn: '', en: '' }, { cn: '', en: '' }, { cn: '', en: '' }, { cn: '', en: '' }], customInfo: '备注X' })]);
ok('exportAoa 产品总表 有品类列', ex2['产品总表'][0].indexOf('品类') >= 0);
ok('exportAoa 卖点页存在', Array.isArray(ex2['卖点与备注']) && ex2['卖点与备注'].length === 2);
ok('exportAoa 卖点内容', ex2['卖点与备注'][1].indexOf('佩戴舒适') >= 0 && ex2['卖点与备注'][1].indexOf('备注X') >= 0);

const exB = C.exportAoa([Object.assign({}, prod, { skus: [{ name: '黑', color: '#000', ean: 'E1', ram: '8GB', rom: '128GB', chip: '星核', matte: true, bom: '12345ABC' }] })],
  [{ id: 'sm1', productId: prod.id, type: 'VN1', name: '样机A', code: 'VN1CODE', color: '#E0A400', certModel: 'R1', inbox: '本体+线', shipLate: '2026/3' }]);
ok('exportAoa SKU明细 有BOM列', exB['SKU明细'][0].indexOf('BOM编码') >= 0);
ok('exportAoa SKU明细 BOM值', exB['SKU明细'][1].indexOf('12345ABC') >= 0);
ok('exportAoa 样机表存在', Array.isArray(exB['样机']) && exB['样机'].length === 2);
ok('exportAoa 样机内容', exB['样机'][1].indexOf('VN1CODE') >= 0 && exB['样机'][1].indexOf('VN1') >= 0);
ok('exportAoa samples 缺省安全', Array.isArray(C.exportAoa([prod])['样机']));

console.log(f ? ('\n' + f + ' FAILED') : '\nALL PASS'); process.exit(f ? 1 : 0);

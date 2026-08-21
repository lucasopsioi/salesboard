// 中英双语 i18n + 演示种子：词典完整性 / 翻译纯函数 / 规则 / 种子安全边界
const I = require('./i18n.js');
const D = require('./demo-seed.js');
let f = 0; const ok = (n, c) => { console.log((c ? 'PASS ' : 'FAIL ') + n); if (!c) f++; };

/* ---------- 词典完整性 ---------- */
ok('词典非空且值都为非空字符串', Object.keys(I.DICT).length > 100 &&
  Object.values(I.DICT).every(v => typeof v === 'string' && v.trim().length > 0));
ok('14 个看板名全部收录', ['产业看板','PSI 数据分析','国家看板','汇总表','路标管理','经营分析',
  '定价测算','产品定价库','自定义图表','看板设计器','数据源','库存管理','文字输出','AI 问答']
  .every(k => I.DICT[k]));
ok('词典值里不含中文残留', Object.values(I.DICT).every(v => !/[一-鿿]/.test(v)));
ok('反向词典可用(汇总表往返)', I.RDICT[I.DICT['汇总表']] === '汇总表');

/* ---------- trText 纯函数 ---------- */
ok('精确词条 zh→en', I.trText('汇总表', true) === 'Summary Table');
ok('en→zh 还原', I.trText('Summary Table', false) === '汇总表');
ok('未收录文本原样返回', I.trText('这句话不在词典里', true) === '这句话不在词典里');
ok('保留首尾空白', I.trText('  刷新  ', true) === '  Refresh  ');
ok('空/null 安全', I.trText('', true) === '' && I.trText(null, true) === null);
ok('数据不翻译(国家名未入典)', I.trText('墨西哥', true) === '墨西哥');

/* ---------- 动态规则 ---------- */
ok('26累计SO → 26 Cum SO', I.trText('26累计SO', true) === '26 Cum SO');
ok('25同期SO总 → 25 LY SO', I.trText('25同期SO总', true) === '25 LY SO');
ok('已隐藏 3 行 ▾', I.trText('已隐藏 3 行 ▾', true) === 'Hidden 3 ▾');
ok('1,728 条 （示例数据）', I.trText('1,728 条 （示例数据）', true) === '1,728 rows (sample data)');
ok('规则不误伤普通数字', I.trText('12345', true) === '12345');

/* ---------- 演示种子 ---------- */
const prods = D.demoProducts();
ok('种子 5 个产品且 id 唯一', prods.length === 5 && new Set(prods.map(p => p.id)).size === 5);
ok('全部字母命名·零真实品牌', prods.every(p =>
  /^Product [A-Z]\d?$/.test(p.name) && !/ACME|Slate Tab|SonicBuds/i.test(JSON.stringify(p))));
ok('含接续关系(A→A2)', prods.some(p => p.predecessorId === 'demo_pa1'));
ok('含生命周期三字段演示(salesEnd+eom)', prods.some(p => p.salesEnd && p.eom));
ok('含同跑产品(B/C 区间重叠)', (() => {
  const b = prods.find(p => p.id === 'demo_pb1'), c = prods.find(p => p.id === 'demo_pc1');
  return b && c && b.shipLate < (c.salesEnd || '9999') && c.shipLate < '2026';
})());
ok('每个产品过 validateProduct(必填齐)', (() => {
  const C = require('./roadmap-core.js');
  return prods.every(p => C.validateProduct(p).length === 0);
})());
ok('生命周期字段过校验', (() => {
  const C = require('./roadmap-core.js');
  return prods.every(p => C.validateLifecycle(p).length === 0);
})());

/* 种子安全边界：已有数据绝不覆盖 */
global.localStorage = {
  _d: { [D.PKEY]: JSON.stringify({ products: [{ id: 'real', name: '真实产品' }] }) },
  getItem(k) { return this._d[k] || null; },
  setItem(k, v) { this._d[k] = v; },
};
ok('已有产品库 → 不覆盖', D.seedRoadmapIfEmpty() === false &&
  JSON.parse(localStorage._d[D.PKEY]).products[0].id === 'real');
localStorage._d = {};
ok('空库 → 种入', D.seedRoadmapIfEmpty() === true &&
  JSON.parse(localStorage._d[D.PKEY]).products.length === 5);
localStorage._d = { [D.PKEY]: '{broken json' };
ok('坏档 → 不动(当作已有数据)', D.seedRoadmapIfEmpty() === false);

console.log(f ? ('\n' + f + ' FAILED') : '\nALL PASS'); process.exit(f ? 1 : 0);

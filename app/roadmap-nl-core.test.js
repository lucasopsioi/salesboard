'use strict';
/* roadmap-nl-core 单测：新建/更新/字段合并/未知信息不丢/SKU合并/日期归一 */
const NL = require('./roadmap-nl-core.js');
let pass = 0, fail = 0;
const ok = (name, cond) => { console.log((cond ? 'PASS ' : 'FAIL ') + name); cond ? pass++ : fail++; };
const blank = () => ({ id: 'x' + Math.random().toString(36).slice(2, 7), name: '', skus: [{ name: '', color: '#1E9E57' }], sellingPoints: [{ cn: '', en: '' }, { cn: '', en: '' }], customInfo: '', shipLate: '' });

// N1 新建
let r = NL.upsertProduct([], { name: 'Slate 13 Pro', fields: { shipLate: '2026-10', compositeRrpUsd: '599', seriesGroup: 'Tarpon' } }, blank);
ok('N1 新建产品', r.action === 'created' && r.products.length === 1 && r.products[0].name === 'Slate 13 Pro');
ok('N2 日期归一 2026-10→2026/10', r.products[0].shipLate === '2026/10');
ok('N3 价格数值化', r.products[0].compositeRrpUsd === 599);

// N4 更新(互含匹配)
r = NL.upsertProduct(r.products, { name: 'slate13pro', fields: { eomPlan: '2027年6月' }, extras: { 'VN1编码': 'ABC-123', 'VN2编码': 'DEF-456' } }, blank);
ok('N4 归一互含匹配到已有产品', r.action === 'updated' && r.products.length === 1);
ok('N5 eomPlan 中文日期归一', r.products[0].eomPlan === '2027/06');
ok('N6 未知字段(VN编码)进 customInfo 不丢', r.products[0].customInfo.indexOf('VN1编码：ABC-123') >= 0 && r.products[0].customInfo.indexOf('VN2编码：DEF-456') >= 0);

// N7 SKU 合并
r = NL.upsertProduct(r.products, { name: 'Slate 13 Pro', skus: [{ name: 'SLT13P-W8256', ram: '8GB', rom: '256GB' }, { name: 'SLT13P-W8512', rom: '512GB' }] }, blank);
ok('N7 SKU 合入且挤掉空壳', r.products[0].skus.length === 2 && r.products[0].skus[0].name === 'SLT13P-W8256');
r = NL.upsertProduct(r.products, { name: 'Slate 13 Pro', skus: [{ name: 'SLT13P-W8256', chip: 'K9020' }] }, blank);
ok('N8 同名 SKU 更新不重复', r.products[0].skus.length === 2 && r.products[0].skus[0].chip === 'K9020');

// N9 卖点填空位
r = NL.upsertProduct(r.products, { name: 'Slate 13 Pro', sellingPoints: ['旗舰芯片', '2.8K 屏'] }, blank);
ok('N9 卖点入空位', r.products[0].sellingPoints[0].cn === '旗舰芯片' && r.products[0].sellingPoints[1].cn === '2.8K 屏');

// N10 模糊多命中不乱改(两个都含 slate 的产品,给个更含糊的名 → 新建)
const two = r.products.concat([Object.assign(blank(), { name: 'Slate 13' })]);
r = NL.upsertProduct(two, { name: 'Slate', fields: { category: '平板' } }, blank);
ok('N10 模糊多命中走新建不猜', r.action === 'created' && r.products.length === 3);

// N11 name 缺失报错
r = NL.upsertProduct([], { fields: { shipLate: '2026/01' } }, blank);
ok('N11 缺 name 报错', !!r.error);

// N12 前代产品按名字解析成 predecessorId（模型只会说「前代是 Slate SE 11」）
{
  let ps = NL.upsertProduct([], { name: 'Slate SE 11', fields: { shipLate: '2025/01', seriesGroup: 'Dorado' } }, blank).products;
  const r12 = NL.upsertProduct(ps, { name: 'Slate SE 12', fields: { shipLate: '2026/11', predecessor: 'Slate SE 11', compositeRrpUsd: 199 } }, blank);
  const p12 = r12.products.find(x => x.name === 'Slate SE 12'), p11 = r12.products.find(x => x.name === 'Slate SE 11');
  ok('N12a 前代名解析成 id', !!p12 && !!p11 && p12.predecessorId === p11.id);
  ok('N12b applied 记录前代', r12.applied.some(a => /predecessorId=Slate SE 11/.test(a)));
  const r13 = NL.upsertProduct(r12.products, { name: 'Slate SE 13', fields: { predecessorId: 'Slate SE 12' } }, blank);
  const p13 = r13.products.find(x => x.name === 'Slate SE 13');
  ok('N12c 模型把名字塞进 predecessorId 也解析', !!p13 && p13.predecessorId === p12.id);
  const r14 = NL.upsertProduct(r13.products, { name: 'X1', fields: { predecessor: '不存在的产品' } }, blank);
  ok('N12d 解析不到进备注不丢', r14.extras.some(e => /前代产品/.test(e)) && !r14.products.find(x => x.name === 'X1').predecessorId);
}

console.log(fail ? (fail + ' FAILED') : ('ALL PASS (' + pass + ')'));
process.exit(fail ? 1 : 0);

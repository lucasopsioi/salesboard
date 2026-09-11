// 包装内清单按 SKU 区分：继承语义 + 并集 + 导出（含旧数据零迁移的向后兼容）
const C = require('./roadmap-core.js');
let f = 0; const ok = (n, c) => { console.log((c ? 'PASS ' : 'FAIL ') + n); if (!c) f++; };

/* ---------- 继承语义：s.packaging 不是数组 = 继承产品级 ---------- */
const P = { name: 'Slate Tab', packaging: ['适配器', 'QSG', 'Inbox键盘'], skus: [
  { name: '标准版' },                                        // 旧数据形态：没有 packaging 字段 → 继承
  { name: '典藏版', packaging: ['适配器', 'QSG', 'Inbox键盘', 'Inbox手写笔'] },  // 单独设置（多一支笔）
  { name: '裸机版', packaging: [] },                          // 单独设置为「空」= 什么都不随附
] };

ok('旧数据(无字段) → 继承产品级', C.skuPackaging(P, P.skus[0]).join('/') === '适配器/QSG/Inbox键盘');
ok('单独设置 → 用自己的', C.skuPackaging(P, P.skus[1]).join('/') === '适配器/QSG/Inbox键盘/Inbox手写笔');
ok('单独设置为空数组 → 空（不是回退继承）', C.skuPackaging(P, P.skus[2]).length === 0);
ok('overridden 判定：无字段=false', C.skuPackagingOverridden(P.skus[0]) === false);
ok('overridden 判定：有数组=true', C.skuPackagingOverridden(P.skus[1]) === true);
ok('overridden 判定：空数组也算 true', C.skuPackagingOverridden(P.skus[2]) === true);
ok('脏值(字符串)不算覆盖 → 继承', C.skuPackaging(P, { name: 'x', packaging: '适配器' }).join('/') === '适配器/QSG/Inbox键盘');
ok('产品无 packaging 也不炸', C.skuPackaging({ }, { name: 'x' }).length === 0 && C.skuPackaging(null, null).length === 0);

/* ---------- 并集：Inbox 配件卡片该不该出，看的是并集 ---------- */
ok('并集含产品级 + 各SKU覆盖', C.packagingUnion(P).join('/') === '适配器/QSG/Inbox键盘/Inbox手写笔');
ok('并集去重', C.packagingUnion(P).filter(x => x === '适配器').length === 1);
ok('只有某个SKU勾了Inbox皮套 → 并集也要有',
  C.packagingUnion({ packaging: [], skus: [{ packaging: ['Inbox皮套'] }] }).join('/') === 'Inbox皮套');
ok('空产品并集为空', C.packagingUnion({}).length === 0 && C.packagingUnion(null).length === 0);

/* ---------- 底表单元格：无覆盖时必须与旧版逐字一致（不破坏既有导出） ---------- */
const OLD = { name: '老产品', packaging: ['适配器', 'QSG'], skus: [{ name: 'a' }, { name: 'b' }] };
ok('无任何SKU覆盖 → 输出与旧版一致', C.packagingCell(OLD) === '适配器/QSG');
ok('产品级为空且无覆盖 → 空串', C.packagingCell({ skus: [{ name: 'a' }] }) === '');
ok('有覆盖 → 展开「默认|SKU」',
  C.packagingCell(P) === '默认:适配器/QSG/Inbox键盘 | 典藏版:适配器/QSG/Inbox键盘/Inbox手写笔 | 裸机版:—');
ok('默认为空但有覆盖 → 默认显示 —',
  C.packagingCell({ packaging: [], skus: [{ name: 'a', packaging: ['适配器'] }] }) === '默认:— | a:适配器');

/* ---------- exportAoa：产品总表 + SKU明细两处消费方 ---------- */
const ex = C.exportAoa([P]);
const mainHead = ex['产品总表'][0], mainRow = ex['产品总表'][1];
ok('产品总表「包装清单」列仍在原位', mainHead.indexOf('包装清单') === 10);
ok('产品总表包装单元格=展开形态', mainRow[10] === C.packagingCell(P));

const skuHead = ex['SKU明细'][0], rows = ex['SKU明细'].slice(1);
ok('SKU明细新增「包装清单」「包装来源」两列', skuHead[9] === '包装清单' && skuHead[10] === '包装来源');
ok('SKU明细 继承行输出产品级清单', rows[0][9] === '适配器/QSG/Inbox键盘' && rows[0][10] === '继承产品级');
ok('SKU明细 覆盖行输出自己的清单', rows[1][9] === '适配器/QSG/Inbox键盘/Inbox手写笔' && rows[1][10] === '单独设置');
ok('SKU明细 空覆盖行输出空 + 单独设置', rows[2][9] === '' && rows[2][10] === '单独设置');
ok('SKU明细 其余列未错位（颜色/EAN 仍在原位）', skuHead[2] === '颜色hex' && skuHead[3] === 'EAN');

/* ---------- 老数据整体回归：exportAoa 对无覆盖产品的输出不变 ---------- */
const exOld = C.exportAoa([OLD]);
ok('老产品导出包装列 = 旧行为', exOld['产品总表'][1][10] === '适配器/QSG');
ok('老产品每个SKU都标继承', exOld['SKU明细'].slice(1).every(r => r[10] === '继承产品级' && r[9] === '适配器/QSG'));

/* ---------- 不破坏 Inbox 三件套(skuRefs) ---------- */
ok('accSkuList 仍工作（新数组优先）', JSON.stringify(C.accSkuList({ skuRefs: ['黑', '白'], skuRef: '旧' })) === '["黑","白"]');
ok('accSkuList 旧单值仍兼容', JSON.stringify(C.accSkuList({ skuRef: '黑' })) === '["黑"]');

console.log(f ? ('\n' + f + ' FAILED') : '\nALL PASS'); process.exit(f ? 1 : 0);

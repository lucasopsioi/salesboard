'use strict';
/* ============================================================
   Salesboard · 演示种子（demo seed）
   「载入示例」时若路标产品库为空，则种入一套**全虚构**的 Product A~F 产品，
   让 路标图 / 生命周期甘特 / 列表 三个视图开箱有内容可演示。

   安全边界（很重要）：
   · 只在 localStorage['sb.roadmap.products.v1'] **完全为空**时写入——
     正式使用机器上已有真实产品库，永远不会被覆盖；
   · 数据与 engine-core 示例同一套虚构世界观（Series P/S/A/T1/T2/O + PA-W09DK 式型号），
     不含任何真实品牌/产品/价格；
   · 只写 localStorage，不碰引擎与任何取数。
   ============================================================ */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.SbDemoSeed = api;
})(this, function () {

  const PKEY = 'sb.roadmap.products.v1';

  /* 虚构产品：覆盖 接续线（A→A2）/ 同跑并列（B 与 C）/ 生命周期三字段（salesEnd、EOM+180）/ 音频线 */
  function demoProducts() {
    const sku = (n, c) => ({ name: n, color: c, ean: '', ram: '8GB', rom: '256GB', chip: 'Chip X1', matte: false, bom: '' });
    return [
      { id: 'demo_pa1', name: 'Product A', category: '平板', seriesGroup: 'Series P',
        internalCode: 'PA-W09DK', certModel: 'PA-W09', predecessorId: '',
        compositeRrpUsd: 499, shipEarly: '2025/03/01', shipLate: '2025/04/15',
        salesEnd: '2026/09/30', eom: '2026/03/15',
        skus: [sku('PA-Black', '#2A2E37'), sku('PA-Silver', '#C9CDD4')],
        packaging: ['适配器', 'QSG'], accessories: {}, sellingPoints: [], pricing: [] },
      { id: 'demo_pa2', name: 'Product A2', category: '平板', seriesGroup: 'Series P',
        internalCode: 'PA2-W19DK', certModel: 'PA2-W19', predecessorId: 'demo_pa1',
        compositeRrpUsd: 549, shipEarly: '2026/03/01', shipLate: '2026/04/20',
        salesEnd: '', eom: '',
        skus: [sku('PA2-Black', '#1A1D24'), sku('PA2-Green', '#1E9E57')],
        packaging: ['适配器', 'QSG', 'Inbox键盘'], accessories: {}, sellingPoints: [], pricing: [] },
      { id: 'demo_pb1', name: 'Product B', category: '平板', seriesGroup: 'Series S',
        internalCode: 'PB-W09B', certModel: 'PB-W09', predecessorId: '',
        compositeRrpUsd: 229, shipEarly: '2025/10/10', shipLate: '2025/11/20',
        salesEnd: '', eom: '',
        skus: [sku('PB-Blue', '#2563C9')],
        packaging: ['适配器', 'QSG'], accessories: {}, sellingPoints: [], pricing: [] },
      { id: 'demo_pc1', name: 'Product C', category: '平板', seriesGroup: 'Series A',
        internalCode: 'PC-W09BK', certModel: 'PC-W09', predecessorId: '',
        compositeRrpUsd: 329, shipEarly: '2025/05/05', shipLate: '2025/06/18',
        salesEnd: '2027/06/30', eom: '2026/12/20',
        skus: [sku('PC-White', '#F2F3F5'), sku('PC-Purple', '#7A4FBF')],
        packaging: ['适配器', 'QSG', 'Inbox手写笔'], accessories: {}, sellingPoints: [], pricing: [] },
      { id: 'demo_pe1', name: 'Product E', category: '音频', seriesGroup: 'Series T1',
        internalCode: 'PE-T180', certModel: 'PE-T18', predecessorId: '',
        compositeRrpUsd: 179, shipEarly: '2026/01/10', shipLate: '2026/02/28',
        salesEnd: '', eom: '',
        skus: [sku('PE-Black', '#17191F'), sku('PE-White', '#FFFFFF')],
        packaging: ['QSG'], accessories: {}, sellingPoints: [], pricing: [] },
    ];
  }

  /* 仅当产品库为空时种入。返回 true=种了，false=已有数据未动。 */
  function seedRoadmapIfEmpty() {
    if (typeof localStorage === 'undefined') return false;
    try {
      const raw = localStorage.getItem(PKEY);
      if (raw) { const o = JSON.parse(raw); if (o && Array.isArray(o.products) && o.products.length) return false; }
    } catch (e) { /* 坏档当作已有数据处理，不覆盖 */ return false; }
    try {
      localStorage.setItem(PKEY, JSON.stringify({ products: demoProducts() }));
      return true;
    } catch (e) { return false; }
  }

  return { demoProducts, seedRoadmapIfEmpty, PKEY };
});

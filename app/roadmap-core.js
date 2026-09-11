(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.RoadmapCore = api;
})(this, function () {
  function newId() { return 'p_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7); }
  function validateProduct(p) {
    p = p || {}; const e = [];
    if (!String(p.name || '').trim()) e.push('产品传播名');
    if (!String(p.category || '').trim()) e.push('品类');
    if (!String(p.seriesGroup || '').trim()) e.push('产品系列归属');
    if (p.compositeRrpUsd == null || isNaN(+p.compositeRrpUsd)) e.push('综合RRP-USD');
    if (!String(p.shipLate || '').trim()) e.push('最晚发货时间');
    return e;
  }
  // Inbox配件关联SKU统一读法:新格式 skuRefs 数组优先,旧单值 skuRef 平滑兼容(单值→单元素数组)
  function accSkuList(a) {
    if (!a) return [];
    if (Array.isArray(a.skuRefs)) return a.skuRefs.filter(Boolean);
    return a.skuRef ? [String(a.skuRef)] : [];
  }
  /* ---------- 包装内清单按 SKU 区分 ----------
     数据形态（零迁移、旧档直接可用）：
       · p.packaging  = 产品级清单 —— 继续存在，含义变为「所有 SKU 的默认/继承值」
       · s.packaging  = 该 SKU 的覆盖 —— **不是数组就表示继承产品级**；是数组（含空数组）就表示单独设置
     继承语义与同表 s.inbox「空=继承产品级」、s.priceUsd「空=不单独设」一致。 */
  function skuPackagingOverridden(s) { return !!(s && Array.isArray(s.packaging)); }
  // 某 SKU 实际生效的包装清单
  function skuPackaging(p, s) {
    if (skuPackagingOverridden(s)) return s.packaging.filter(Boolean);
    return ((p && p.packaging) || []).filter(Boolean);
  }
  // 产品下实际用到的包装项并集（产品级默认 ∪ 各 SKU 覆盖）——Inbox 配件卡片该不该出、汇总导出都用它
  function packagingUnion(p) {
    const out = [];
    const add = arr => (arr || []).forEach(x => { if (x && out.indexOf(x) < 0) out.push(x); });
    add((p && p.packaging) || []);
    ((p && p.skus) || []).forEach(s => { if (skuPackagingOverridden(s)) add(s.packaging); });
    return out;
  }
  // 底表「包装清单」单元格：没有任何 SKU 覆盖时输出与旧版逐字一致（不破坏既有导出）；
  // 有覆盖时才展开成「默认:… | SKU名:…」
  function packagingCell(p) {
    const base = ((p && p.packaging) || []).filter(Boolean);
    const ov = ((p && p.skus) || []).filter(skuPackagingOverridden);
    if (!ov.length) return base.join('/');
    const parts = ['默认:' + (base.join('/') || '—')];
    ov.forEach(s => parts.push((s.name || 'SKU') + ':' + (s.packaging.filter(Boolean).join('/') || '—')));
    return parts.join(' | ');
  }

  /* ---------- 产品销售生命周期（阶段三·并进玻璃改造） ----------
     新增三个字段，**全部可空 → 旧数据零迁移**：
       p.shipLate  已有：上市时间（必填，语义不变）
       p.salesEnd  新增：销售结束时间（空 = 仍在售/未定）
       p.eom       新增：End of Market（空 = 尚未发 EOM 公告；填了必须晚于上市）
     派生（不落盘）：eom + 180 天 = 激励投放截止（之后不能再投激励）。
     并行同跑：每个产品各自一条独立区间，不依赖 predecessorId 接续关系。 */
  const _DAY = 86400000;
  // 'YYYY/MM/DD' | 'YYYY/MM' | 'YYYY-MM-DD' → Date（无效返回 null）
  function lifeDate(v) {
    const m = String(v == null ? '' : v).match(/^(\d{4})[\/-](\d{1,2})(?:[\/-](\d{1,2}))?/);
    if (!m) return null;
    const d = new Date(+m[1], (+m[2] || 1) - 1, +(m[3] || 1));
    return isNaN(d.getTime()) ? null : d;
  }
  function fmtDate(d) {
    if (!d || isNaN(d.getTime())) return '';
    const p2 = n => String(n).padStart(2, '0');
    return d.getFullYear() + '/' + p2(d.getMonth() + 1) + '/' + p2(d.getDate());
  }
  // EOM + 180 天（含闰年，由 Date 自行处理）。空/非法 → ''
  function eomPlus180(eom) {
    const d = lifeDate(eom); if (!d) return '';
    return fmtDate(new Date(d.getTime() + 180 * _DAY));
  }
  /* 生命周期区间。open=true 表示销售结束未填（仍在售），end 为 null。 */
  function lifecycleSpan(p) {
    const start = lifeDate(p && p.shipLate);
    const end = lifeDate(p && p.salesEnd);
    const eom = lifeDate(p && p.eom);
    return {
      start: start, end: end, open: !end,
      eom: eom, eomPlus: eom ? lifeDate(eomPlus180(p.eom)) : null,
      valid: !!start,
    };
  }
  /* 生命周期字段校验（只做时间先后关系，不改任何既有必填规则）。
     返回错误文案数组，空数组=通过。 */
  function validateLifecycle(p) {
    const e = [];
    if (!p) return e;
    const s = lifeDate(p.shipLate), se = lifeDate(p.salesEnd), eo = lifeDate(p.eom);
    if (p.salesEnd && !se) e.push('销售结束时间格式不正确');
    if (p.eom && !eo) e.push('EOM 时间格式不正确');
    if (s && se && se < s) e.push('销售结束时间不能早于上市时间');
    if (s && eo && eo < s) e.push('EOM 时间必须晚于上市时间');
    if (se && eo && eo > se) e.push('EOM 时间不应晚于销售结束时间');
    return e;
  }
  /* 甘特行：按系列分组 → 组内按上市时间升序；同跑产品自然并列成多行。
     opts.fallbackEnd 用于给"仍在售"的产品一个右端（通常取时间轴右边界）。 */
  function ganttRows(products, opts) {
    const o = opts || {};
    const rows = [];
    (products || []).forEach(p => {
      const sp = lifecycleSpan(p);
      if (!sp.valid) return;                       // 没有上市时间的产品不进甘特图
      rows.push({
        id: p.id, name: p.name || '', series: p.seriesGroup || '未分组',
        start: sp.start, end: sp.end, open: sp.open,
        eom: sp.eom, eomPlus: sp.eomPlus,
        predecessorId: p.predecessorId || '',
      });
    });
    // seriesRank 来自 common.js（浏览器全局）；Node 单测里没有时退化为不分级，只按名称+上市时间排
    const rank = (typeof seriesRank === 'function') ? seriesRank : function () { return 999; };
    rows.sort((a, b) => {
      const ra = rank(a.series), rb = rank(b.series);
      if (ra !== rb) return ra - rb;
      if (a.series !== b.series) return String(a.series).localeCompare(String(b.series), 'zh');
      return a.start - b.start;
    });
    if (o.fallbackEnd) { const fe = lifeDate(o.fallbackEnd); if (fe) rows.forEach(r => { if (r.open) r.endEff = fe; else r.endEff = r.end; }); }
    else rows.forEach(r => { r.endEff = r.end; });
    return rows;
  }
  /* 甘特图时间范围：覆盖所有区间 + EOM+180，返回 {min,max}（Date）。 */
  function ganttRange(rows) {
    let min = null, max = null;
    (rows || []).forEach(r => {
      [r.start, r.endEff || r.end, r.eomPlus].forEach(d => {
        if (!d) return;
        if (!min || d < min) min = d;
        if (!max || d > max) max = d;
      });
    });
    return { min: min, max: max };
  }

  function first4moSO(vals) {
    if (!Array.isArray(vals)) return null;
    const i = vals.findIndex(v => +v > 0); if (i < 0) return null;
    let s = 0; for (let k = i; k < i + 4 && k < vals.length; k++) s += (+vals[k] || 0);
    return s;
  }
  function defaultCompositeRrp(pricing) {
    const xs = (pricing || []).map(r => +r.rrpUsd).filter(v => !isNaN(v) && v > 0);
    return xs.length ? Math.max(...xs) : null;
  }
  function pricingFromLibrary(records, offering) {
    const m = (records || []).filter(r => r.sku === offering || r.offering === offering);
    const rows = m.map(r => ({ country: r.country || '', model: r.sku || r.offering || offering, currency: r.currency || '',
      rrpLocal: +r.rrpLocal || 0, fx: +r.fx || 0, rrpUsd: (+r.fx ? (+r.rrpLocal || 0) / (+r.fx) : 0),
      reservedIncentive: (r.tempIncentive == null ? '' : +r.tempIncentive), regularPrice: '' }));
    const first = m[0] || {};
    return { rows, name: first.product || first.name || '', internalCode: first.offering || offering, seriesGroup: first.series || first.seriesGroup || '' };
  }
  function _skuConfig(s) { return [s.ram || '', s.rom || ''].filter(Boolean).join('/'); }
  function validateLaunch(row) {
    row = row || {}; const e = [];
    if (!String(row.productId || '').trim()) e.push('productId');
    if (!String(row.country || '').trim()) e.push('country');
    return e;
  }
  function validateBattle(row) {
    row = row || {}; const e = [];
    if (!String(row.productId || '').trim()) e.push('productId');
    if (!String(row.country || '').trim()) e.push('country');
    if (!String(row.rival || '').trim()) e.push('rival');
    return e;
  }
  function exportAoa(products, samples, launch, battle) {
    const ps = products || [];
    samples = samples || [];
    launch = launch || [];
    battle = battle || [];
    const main = [['产品传播名', '内部代号', '认证型号', '品类', '系列归属', 'SKU数', '颜色', '配置概览', '芯片', '柔光屏', '包装清单', '最早发货', '最晚发货', '综合RRP-USD', '首4月SO', '定价库关联', 'PSI关联']];
    const sku = [['产品', 'SKU名', '颜色hex', 'EAN', 'RAM', 'ROM', '芯片', 'BOM编码', '柔光屏', '包装清单', '包装来源']];
    const price = [['产品', '国家', '型号', '本币', '汇率', 'USD', '预留激励', '常售价']];
    const acc = [['产品', '配件类型', '认证型号', '传播名', '内部代号', '颜色', '关联SKU']];
    const sp = [['产品', '卖点1中', '卖点1英', '卖点2中', '卖点2英', '卖点3中', '卖点3英', '卖点4中', '卖点4英', '卖点5中', '卖点5英', '卖点6中', '卖点6英', '自定义信息']];
    ps.forEach(p => {
      const sk = p.skus || [];
      const matteTxt = p.matteMode === 'all' ? '是' : p.matteMode === 'none' ? '否' : '按SKU';
      main.push([p.name || '', p.internalCode || '', p.certModel || '', p.category || '', p.seriesGroup || '', sk.length,
        sk.map(s => s.name).join('/'), [...new Set(sk.map(_skuConfig).filter(Boolean))].join(' '),
        [...new Set(sk.map(s => s.chip).filter(Boolean))].join('/'), matteTxt, packagingCell(p),
        p.shipEarly || '', p.shipLate || '', p.compositeRrpUsd == null ? '' : p.compositeRrpUsd,
        p.first4moSO == null ? '' : p.first4moSO, p.pricingLink || '', p.psiLink || '']);
      sk.forEach(s => sku.push([p.name || '', s.name || '', s.color || '', s.ean || '', s.ram || '', s.rom || '', s.chip || '', s.bom || '',
        p.matteMode === 'all' ? '是' : p.matteMode === 'none' ? '否' : (s.matte ? '是' : '否'),
        skuPackaging(p, s).join('/'), skuPackagingOverridden(s) ? '单独设置' : '继承产品级']));
      (p.pricing || []).forEach(r => price.push([p.name || '', r.country || '', r.model || '', r.rrpLocal, r.fx, r.rrpUsd, r.reservedIncentive, r.regularPrice]));
      Object.keys(p.accessories || {}).forEach(t => { const a = p.accessories[t]; if (a) acc.push([p.name || '', t, a.certModel || '', a.name || '', a.internalCode || '', a.color || '', accSkuList(a).join('、')]); });
      const sps = p.sellingPoints || []; const row = [p.name || ''];
      for (let i = 0; i < 6; i++) { const o = sps[i] || {}; row.push(o.cn || '', o.en || ''); }
      row.push(p.customInfo || ''); sp.push(row);
    });
    const smp = [['关联产品', '类型', '传播名', '样机编码', '颜色', '认证型号', 'inbox内容', '可用时间']];
    const pById = {}; ps.forEach(p => { pById[p.id] = p; });
    samples.forEach(s => smp.push([(pById[s.productId] || {}).name || '', s.type || '', s.name || '', s.code || '', s.color || '', s.certModel || '', s.inbox || '', s.shipLate || '']));
    const out = { '产品总表': main, 'SKU明细': sku, '分国定价': price, '配件': acc, '卖点与备注': sp, '样机': smp };
    if (launch.length) {
      const lp = [['产品', '国家', '预售时间', '线上首销', '线下首销', '整体首销', '首销名义台数', '生命周期目标', 'AATP预计', '主力渠道', '首销毛利率', '首销Offer', '备注']];
      launch.forEach(l => lp.push([(pById[l.productId] || {}).name || '', l.country || '', l.presaleDate || '', l.onlineDate || '', l.offlineDate || '', l.overallDate || '',
        l.firstTarget == null || l.firstTarget === '' ? '' : l.firstTarget, l.lifecycleTarget == null || l.lifecycleTarget === '' ? '' : l.lifecycleTarget,
        l.aatpEst == null ? '' : l.aatpEst, l.channel || '', l.firstGm == null ? '' : l.firstGm, l.firstOffer || '', l.note || '']));
      out['上市计划'] = lp;
    }
    if (battle.length) {
      const bp = [['产品', '国家', '竞品', '价格(本币)']];
      battle.forEach(b => bp.push([(pById[b.productId] || {}).name || '', b.country || '', b.rival || '', b.priceLocal == null || b.priceLocal === '' ? '' : b.priceLocal]));
      out['竞品对标'] = bp;
    }
    return out;
  }
  return { newId, validateProduct, validateLaunch, validateBattle, first4moSO, accSkuList, defaultCompositeRrp, pricingFromLibrary, exportAoa,
    skuPackaging, skuPackagingOverridden, packagingUnion, packagingCell,
    lifeDate, fmtDate, eomPlus180, lifecycleSpan, validateLifecycle, ganttRows, ganttRange };
});

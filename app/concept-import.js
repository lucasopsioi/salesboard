(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.ConceptImport = api;
})(this, function () {
  const T = (v) => String(v == null ? '' : v).trim();
  const N = (v) => { const n = parseFloat(v); return isNaN(n) ? 0 : n; };
  // 率专用解析：概算表率单元格三态归一到小数（0.187=18.7%）
  //  1) 文本含 '%'（"18.7%"）→ parseFloat/100
  //  2) 纯数字但 |n|>1.5（18.7 当百分数填）→ n/100（销毛率/贡献率不会超 ±150%，>1.5 必是百分数形态）
  //  3) 其余（真小数 0.187 / 0.9）原样；NaN→0
  const RATE = (v) => {
    if (v == null) return 0;
    const s = String(v).trim();
    if (s.indexOf('%') >= 0) { const n = parseFloat(s); return isNaN(n) ? 0 : n / 100; }
    const n = parseFloat(s);
    if (isNaN(n)) return 0;
    return Math.abs(n) > 1.5 ? n / 100 : n;
  };
  const parseFx = (s) => { const m = String(s == null ? '' : s).match(/[\d.]+/); return m ? +m[0] : 0; };
  const divSafe = (a, b) => (b ? a / b : 0);

  // 扫描所有行，建立 字段key -> 行号（含负向收入/商务因子的位置消歧）
  function resolveRows(rows) {
    const idx = {}; let seg = '';
    const set = (k, r) => { if (idx[k] == null) idx[k] = r; };
    for (let r = 0; r < rows.length; r++) {
      const a = T(rows[r] && rows[r][0]), b = T(rows[r] && rows[r][1]), c = T(rows[r] && rows[r][2]);
      if (a.indexOf('负向收入') >= 0 || ((b === '零售' || b === '渠道') && c.indexOf('返利') >= 0)) {
        if (b === '零售') seg = '零售'; else if (b === '渠道') seg = '渠道';
        if (c.indexOf('有条件') >= 0) set(seg === '渠道' ? 'rebChanCond' : 'rebRetailCond', r);
        else if (c.indexOf('无条件') >= 0) set(seg === '渠道' ? 'rebChanUncond' : 'rebRetailUncond', r);
        else if (b.indexOf('价保') >= 0) set('priceProtect', r);
        else if (b.indexOf('临时激励') >= 0) set('tempIncentive', r);
        continue;
      }
      if (b.indexOf('联合营销') >= 0) { set('jointMkt', r); continue; }
      if (a.indexOf('商务因子') >= 0 && a.indexOf('汇总') < 0) {
        if (b.indexOf('基本服务') >= 0) set('cfBasicSvc', r);
        else if (b.indexOf('备机') >= 0) set('cfSpare', r);
        else if (b.indexOf('运保') >= 0) set('cfFreight', r);
        else if (b.indexOf('关税') >= 0) set('cfCustoms', r);
        else if (b.indexOf('样机') >= 0) set('cfSampleDummy', r);
        else if (b.indexOf('外汇风险') >= 0) set('cfFxRisk', r);
        continue;
      }
      if (b === '其他' && idx.cfFxRisk != null && idx.cfOther == null) { set('cfOther', r); continue; }
      if (a.indexOf('品牌') >= 0) set('brand', r);
      else if (a.indexOf('场景') >= 0) set('scene', r);
      else if (a.indexOf('大区') >= 0) set('region', r);
      else if (a.indexOf('国家') >= 0) set('country', r);
      else if (a.indexOf('BU') >= 0) set('buSeries', r);
      else if (a === '产品') set('product', r);
      else if (a.indexOf('Offering') >= 0) set('offering', r);
      else if (a === 'SKU') set('sku', r);
      else if (a.indexOf('客户分类') >= 0) set('custClass', r);
      else if (a.indexOf('Online') >= 0) set('onoff', r);
      else if (a.indexOf('授权客户组') >= 0) set('custGroup', r);
      else if (a.indexOf('直接客户') >= 0) set('customer', r);
      else if (a.indexOf('贸易术语') >= 0) set('incoterm', r);
      else if (a.indexOf('上市时间') >= 0) set('launch', r);
      else if (a.indexOf('币种') >= 0) set('currency', r);
      else if (a.indexOf('生命周期发货量') >= 0) set('shipVol', r);
      else if (a.indexOf('不含税RRP') >= 0) set('exVat', r);
      else if (a.indexOf('RRP') === 0) set('rrp', r);
      else if (a.indexOf('VAT') >= 0) set('vat', r);
      else if (a.indexOf('零售前向利润') >= 0) set('retailFront', r);
      else if (a.indexOf('建议STP') >= 0) set('stp', r);
      else if (a.indexOf('渠道前向利润') >= 0) set('channelFront', r);
      else if (a.indexOf('进口税费') >= 0) set('importTax', r);
      else if (a.indexOf('NSIP') >= 0) set('nsip', r);
      else if (a.indexOf('SIP') >= 0) set('sip', r);
      else if (a.indexOf('预付款折扣') >= 0) set('prepayDisc', r);
      else if (a.indexOf('超标服务') >= 0) set('excessiveSvc', r);
      else if (a.indexOf('其他收入抵减') >= 0) set('otherDeduct', r);
      else if (a.indexOf('定制成本') >= 0) set('customCost', r);
      else if (a.indexOf('销毛') >= 0) set('grossMargin', r);
      else if (a.indexOf('商务因子汇总') >= 0) set('cfTotal', r);
      else if (a.indexOf('FOB') >= 0) set('fobNet', r);
      else if (a.indexOf('产品营销') >= 0) set('prodMktg', r);
      else if (a.indexOf('运营资产') >= 0) set('opCapital', r);
      else if (a.indexOf('贡献毛利') >= 0) set('contrib', r);
      else if (a.indexOf('平台间接') >= 0) set('platformIndirect', r);
      else if (a.indexOf('区域公共分摊') >= 0) set('regionPublic', r);
      else if (a.indexOf('研发吃水线') >= 0) set('rdWaterline', r);
      else if (a.indexOf('区域贡献利润') >= 0) set('regionContrib', r);
    }
    return idx;
  }

  function buildRecord(rows, idx, p) {
    const c1 = 3 + p * 2, c2 = 4 + p * 2;
    const at = (k, col) => { const r = idx[k]; if (r == null) return null; const v = (rows[r] || [])[col]; return v == null ? null : v; };
    const num = (k, col) => N(at(k, col));
    const rate = (k, col) => RATE(at(k, col));
    const txt = (k, col) => T(at(k, col));
    const country = txt('country', c1);
    const sku = txt('sku', c1) || txt('offering', c1);
    const product = txt('product', c1);
    if (!country || !(product || sku)) return null;     // 缺身份的列组跳过
    const custClass = txt('custClass', c1), onoff = txt('onoff', c1), customer = txt('customer', c1);
    const rec = {
      brand: txt('brand', c1), scene: txt('scene', c1), region: txt('region', c1), country,
      bu: txt('buSeries', c1), series: txt('buSeries', c2), product, offering: txt('offering', c1), sku,
      custClass, custGroup: txt('custGroup', c1), onlineOffline: onoff, customer,
      incoterm: txt('incoterm', c1), launchYm: txt('launch', c1), sellinEndYm: txt('launch', c2),
      currency: txt('currency', c1), fx: parseFx(at('currency', c2)), shipVolK: num('shipVol', c1),
      rrpLocal: num('rrp', c1), vatRate: divSafe(num('vat', c1), num('exVat', c1)),
      retailFrontRate: rate('retailFront', c1), channelFrontRate: rate('channelFront', c1),
      importTaxRate: rate('importTax', c1), prepayDiscRate: rate('prepayDisc', c1),
      rebRetailCond: num('rebRetailCond', c1), rebRetailUncond: num('rebRetailUncond', c1),
      rebChanCond: num('rebChanCond', c1), rebChanUncond: num('rebChanUncond', c1),
      priceProtect: num('priceProtect', c1), tempIncentive: num('tempIncentive', c1), jointMkt: num('jointMkt', c1),
      excessiveSvc: num('excessiveSvc', c1), otherDeduct: num('otherDeduct', c1), customCost: num('customCost', c1),
      cfBasicSvc: num('cfBasicSvc', c1), cfSpare: num('cfSpare', c1), cfFreight: num('cfFreight', c1),
      cfCustoms: num('cfCustoms', c1), cfSampleDummy: num('cfSampleDummy', c1), cfFxRisk: num('cfFxRisk', c1), cfOther: num('cfOther', c1),
      snap: {
        nsipUsd: num('nsip', c2), grossMarginRate: rate('grossMargin', c1), grossMarginUsd: num('grossMargin', c2),
        fobNetUsd: num('fobNet', c2), prodMktgUsd: num('prodMktg', c2), opCapitalUsd: num('opCapital', c2),
        contribMarginRate: rate('contrib', c1), platformIndirectUsd: num('platformIndirect', c2),
        regionPublicUsd: num('regionPublic', c2), rdWaterlineUsd: num('rdWaterline', c2),
        regionContribRate: rate('regionContrib', c1), regionContribUsd: num('regionContrib', c2),
      },
    };
    rec.baselineDeviceCost = rec.snap.fobNetUsd - rec.snap.grossMarginUsd;
    rec.id = [country, sku, custClass, onoff, customer].join('|');
    return rec;
  }

  function parseConceptTable(aoa) {
    const rows = aoa || [];
    let maxCols = 0; for (const r of rows) if (r && r.length > maxCols) maxCols = r.length;
    const productCount = Math.max(0, Math.floor((maxCols - 3) / 2));
    const idx = resolveRows(rows);
    const records = []; let skipped = 0;
    for (let p = 0; p < productCount; p++) {
      const rec = buildRecord(rows, idx, p);
      if (rec) records.push(rec); else skipped++;
    }
    return { records, productCount, skipped };
  }

  function costAdjustedGM(record, monthCost) {
    const s = record.snap;
    if (monthCost == null || isNaN(monthCost)) return { gmUsd: s.grossMarginUsd, gmRate: s.grossMarginRate };
    const gmUsd = s.grossMarginUsd + (record.baselineDeviceCost - monthCost);
    return { gmUsd, gmRate: s.nsipUsd ? gmUsd / s.nsipUsd : null };
  }

  return { parseConceptTable, costAdjustedGM };
});

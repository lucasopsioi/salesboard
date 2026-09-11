// 定价测算 · 纯数据模型（DOM 无关，可单测）。依赖 PricingCore、CostBase。
(function (root, factory) {
  const PricingCore = (typeof require !== 'undefined') ? require('./pricing-core.js') : root.PricingCore;
  const CostBase = (typeof require !== 'undefined') ? require('./cost-base.js') : root.CostBase;
  const api = factory(PricingCore, CostBase);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.PricingModel = api;
})(this, function (PricingCore, CostBase) {

  const FACTOR_KEYS = ['fx', 'vat', 'hqRebate', 'shipping', 'serviceRate', 'excessiveRate', 'customsRate', 'erBufferRate'];
  const COUNTRY_DEFAULT = { fx: 17.32, vat: 0.16, hqRebate: 0, shipping: 20, serviceRate: 0.015, excessiveRate: 0, customsRate: 0.008, erBufferRate: 0.0186 };
  const SEED_ACCOUNTS = {
    'Telmax': { channel: 'Telmax', retailFront: 0.28, fsdMargin: 0, retailRebate: 0.03, jointMkt: 0.08 },
    'Riomart': { channel: 'Riomart', retailFront: 0.08, fsdMargin: 0, retailRebate: 0.129, jointMkt: 0.05 },
    'HES': { channel: 'RS', retailFront: 0.26, fsdMargin: 0, retailRebate: 0, jointMkt: 0.09 },
    'Casona': { channel: 'RetailKA', retailFront: 0.20, fsdMargin: 0.06, retailRebate: 0.08, jointMkt: 0.01 },
    'Corella': { channel: 'RetailKA', retailFront: 0.285, fsdMargin: 0.06, retailRebate: 0, jointMkt: 0.01 },
    'Searl': { channel: 'RetailKA', retailFront: 0.20, fsdMargin: 0.06, retailRebate: 0.027, jointMkt: 0.01 },
    'Sotano': { channel: 'RetailKA', retailFront: 0.20, fsdMargin: 0.06, retailRebate: 0.02, jointMkt: 0.01 },
    'Plaza': { channel: 'RetailKA', retailFront: 0.168, fsdMargin: 0.06, retailRebate: 0.018, jointMkt: 0.04 },
    'Volt': { channel: 'RetailKA', retailFront: 0.18, fsdMargin: 0.06, retailRebate: 0.022, jointMkt: 0.01 },
    'Mercantil': { channel: 'RetailKA', retailFront: 0.15, fsdMargin: 0.06, retailRebate: 0.07085, jointMkt: 0.01 },
    'PH': { channel: 'Intradex', retailFront: 0.19, fsdMargin: 0.09, retailRebate: 0.018, jointMkt: 0.03 },
    'ESHOP': { channel: 'ESHOP', retailFront: 0, fsdMargin: 0, retailRebate: 0, jointMkt: 0.07 },
  };
  const SEED_COINVEST = { 'Casona': [{ label: '20%off', hw: 0.05 }, { label: '30%off', hw: 0.15 }, { label: '40%off', hw: 0.25 }] };
  const FIELD_KINDS = { sku: 'text', customer: 'text', channel: 'text', rrp: 'num', retailFront: 'pct', fsdMargin: 'pct', retailRebate: 'pct', jointMkt: 'pct', sampleRate: 'pct', promoPrice: 'num', weight: 'pct', costYm: 'num' };
  const DEFAULT_BUNDLE = 38;

  const num = (v) => (v == null || isNaN(v)) ? 0 : +v;
  const clone = (o) => JSON.parse(JSON.stringify(o));
  function defaultRow(sku) { return { sku: sku || null, customer: '', channel: '', rrp: 0, retailFront: 0, fsdMargin: 0, retailRebate: 0, jointMkt: 0, sampleRate: 0, promoPrice: 0, coInvestRule: '', coInvestTier: -1, weight: 0, costYm: null }; }

  function create() {
    const state = {
      costMap: new Map(), skuMeta: new Map(),
      countries: { '墨西哥': Object.assign({}, COUNTRY_DEFAULT) },
      order: ['墨西哥'],
      rows: { '墨西哥': [defaultRow(null)] },
      bundles: { '墨西哥': {} },
      accounts: clone(SEED_ACCOUNTS),
      coInvestRules: clone(SEED_COINVEST),
      collapsed: {},
      showFloor: true,
    };

    const firstSku = () => { const it = state.costMap.keys().next(); return it.done ? null : it.value; };
    const monthsForSku = (sku) => CostBase.monthsForSku(state.costMap, sku);
    const costFloorFor = (sku, ym) => (sku == null || ym == null) ? null : CostBase.costFloorFor(state.costMap, sku, ym);

    function ensureRowMonths(c) {
      (state.rows[c] || []).forEach(r => { const yms = monthsForSku(r.sku); if (r.costYm == null || !yms.includes(r.costYm)) r.costYm = yms[0] != null ? yms[0] : null; });
    }
    function importCost(aoa) {
      const { costMap, skuMeta } = CostBase.parseCostAoa(aoa);
      state.costMap = costMap; state.skuMeta = skuMeta;
      state.order.forEach(c => (state.rows[c] || []).forEach(r => { if (r.sku == null) r.sku = firstSku(); }));
      state.order.forEach(ensureRowMonths);
      return { skus: costMap.size };
    }

    function uniqueName(base) { let n = base, i = 2; while (state.countries[n]) { n = base + i; i++; } return n; }
    function addCountry(name) {
      const nm = uniqueName(((name == null ? '新国家' : String(name)).trim()) || '新国家');
      state.countries[nm] = Object.assign({}, COUNTRY_DEFAULT);
      state.order.push(nm);
      state.rows[nm] = [defaultRow(firstSku())]; ensureRowMonths(nm);
      state.bundles[nm] = {};
      return nm;
    }
    function removeCountry(name) {
      delete state.countries[name]; delete state.rows[name]; delete state.bundles[name]; delete state.collapsed[name];
      state.order = state.order.filter(c => c !== name);
    }
    function renameCountry(oldN, newN) {
      newN = (newN || '').trim(); if (!state.countries[oldN]) return oldN; if (!newN || newN === oldN || state.countries[newN]) return oldN;
      state.countries[newN] = state.countries[oldN]; state.rows[newN] = state.rows[oldN]; state.bundles[newN] = state.bundles[oldN] || {};
      if (state.collapsed[oldN]) state.collapsed[newN] = true;
      delete state.countries[oldN]; delete state.rows[oldN]; delete state.bundles[oldN]; delete state.collapsed[oldN];
      state.order = state.order.map(c => c === oldN ? newN : c);
      return newN;
    }
    function setCollapsed(c, b) { state.collapsed[c] = !!b; }
    function setFactor(c, k, v) { if (!state.countries[c]) return; state.countries[c][k] = num(v); }

    function addRow(c) { (state.rows[c] || (state.rows[c] = [])).push(defaultRow(firstSku())); ensureRowMonths(c); }
    function removeRow(c, i) { const rs = state.rows[c]; if (!rs) return; rs.splice(i, 1); if (!rs.length) rs.push(defaultRow(firstSku())); }
    function setCell(c, i, k, v) {
      const r = (state.rows[c] || [])[i]; if (!r) return;
      const kind = FIELD_KINDS[k] || 'text';
      if (k === 'sku') { r.sku = v || null; const yms = monthsForSku(r.sku); if (r.costYm == null || !yms.includes(r.costYm)) r.costYm = yms[0] != null ? yms[0] : null; }
      else if (kind === 'text') r[k] = v;
      else { const n = parseFloat(v); r[k] = isNaN(n) ? 0 : (kind === 'pct' ? n / 100 : n); }
    }
    function applyAccount(c, i, name) {
      const r = (state.rows[c] || [])[i]; if (!r) return; r.customer = (name || '').trim();
      const a = state.accounts[r.customer]; if (a) { r.channel = a.channel; r.retailFront = a.retailFront; r.fsdMargin = a.fsdMargin; r.retailRebate = a.retailRebate; r.jointMkt = a.jointMkt; }
    }
    function setCoInvest(c, i, rule, tier) { const r = (state.rows[c] || [])[i]; if (!r) return; r.coInvestRule = rule || ''; r.coInvestTier = (rule == null || rule === '') ? -1 : (+tier); }

    function bundleFor(c, sku) { const b = state.bundles[c]; if (b && b[sku] != null) return b[sku]; return DEFAULT_BUNDLE; }
    function setBundle(c, sku, v) { (state.bundles[c] || (state.bundles[c] = {}))[sku] = num(v); }
    function distinctSkus(c) { const seen = []; (state.rows[c] || []).forEach(r => { if (r.sku != null && !seen.includes(r.sku)) seen.push(r.sku); }); return seen; }

    function resolveHw(r) { const t = state.coInvestRules[r.coInvestRule]; if (!t || r.coInvestTier < 0) return 0; return t[r.coInvestTier] ? t[r.coInvestTier].hw : 0; }
    function buildCustomer(c, r) {
      const f = state.countries[c] || COUNTRY_DEFAULT;
      return { channel: r.channel, customer: r.customer, rrp: r.rrp, retailFront: r.retailFront, fsdMargin: r.fsdMargin, retailRebate: r.retailRebate, jointMkt: r.jointMkt, sampleRate: r.sampleRate, promoPrice: r.promoPrice, weight: r.weight,
        shipping: f.shipping, serviceRate: f.serviceRate, excessiveRate: f.excessiveRate, customsRate: f.customsRate, erBufferRate: f.erBufferRate,
        bundle: bundleFor(c, r.sku), coInvestHw: resolveHw(r), costFloor: costFloorFor(r.sku, r.costYm) };
    }
    function computeCountry(c) {
      const f = state.countries[c] || COUNTRY_DEFAULT; const rs = state.rows[c] || [];
      const out = PricingCore.computePricing({ globals: { fx: f.fx, vat: f.vat, hqRebate: f.hqRebate }, costFloor: 0, customers: rs.map(r => buildCustomer(c, r)) });
      // 按 sku 分组做加权; 仅纳入有成本底价的行(与逐行 hf 守卫一致), 整组都无底价的 sku(含 sku 未选的 '' 组)直接省略, 让 UI 块底回落到占位提示。
      const groups = {};
      rs.forEach((r, i) => { const o = out.rows[i]; const k = r.sku || ''; (groups[k] || (groups[k] = [])).push({ o, hasFloor: costFloorFor(r.sku, r.costYm) != null, w: num(r.weight) }); });
      const wavg = (g, key) => { let s = 0; for (const e of g) if (e.hasFloor && e.o[key] != null) s += e.o[key] * e.w; return s; };
      const weightedBySku = {};
      Object.keys(groups).forEach(k => { const g = groups[k]; if (!g.some(e => e.hasFloor)) return; weightedBySku[k] = { gm1: wavg(g, 'gm1'), gmPromo: wavg(g, 'gmPromo'), gm2: wavg(g, 'gm2'), gm3: wavg(g, 'gm3'), weightSum: g.reduce((a, e) => a + e.w, 0) }; });
      return { rows: out.rows, weightedBySku };
    }

    function addAccount(name, a) { state.accounts[name] = a || { channel: '', retailFront: 0, fsdMargin: 0, retailRebate: 0, jointMkt: 0 }; }
    function updateAccount(name, field, value) {
      const a = state.accounts[name]; if (!a) return;
      if (field === 'name') { const nn = (value || '').trim(); if (nn && nn !== name) { state.accounts[nn] = a; delete state.accounts[name]; } }
      else if (field === 'channel') a.channel = value;
      else { const n = parseFloat(value); a[field] = isNaN(n) ? 0 : n / 100; }
    }
    function deleteAccount(name) { delete state.accounts[name]; }
    function saveAccountFromRow(c, i) { const r = (state.rows[c] || [])[i]; if (!r) return null; const n = (r.customer || '').trim(); if (!n) return null; state.accounts[n] = { channel: r.channel, retailFront: r.retailFront, fsdMargin: r.fsdMargin, retailRebate: r.retailRebate, jointMkt: r.jointMkt }; return n; }

    function serialize() { return { order: state.order, countries: state.countries, rows: state.rows, bundles: state.bundles, accounts: state.accounts, coInvestRules: state.coInvestRules, collapsed: state.collapsed, showFloor: state.showFloor }; }
    function load(o) {
      if (!o) return;
      if (o.countries && Object.keys(o.countries).length) state.countries = o.countries;
      state.order = (Array.isArray(o.order) && o.order.length) ? o.order.filter(c => state.countries[c]) : Object.keys(state.countries);
      if (!state.order.length) { state.countries = { '墨西哥': Object.assign({}, COUNTRY_DEFAULT) }; state.order = ['墨西哥']; }
      state.rows = o.rows || {}; state.order.forEach(c => { if (!Array.isArray(state.rows[c]) || !state.rows[c].length) state.rows[c] = [defaultRow(null)]; });
      state.bundles = o.bundles || {}; state.order.forEach(c => { if (!state.bundles[c]) state.bundles[c] = {}; });
      if (o.accounts && Object.keys(o.accounts).length) state.accounts = o.accounts;
      if (o.coInvestRules) state.coInvestRules = o.coInvestRules;
      state.collapsed = o.collapsed || {};
      if (typeof o.showFloor === 'boolean') state.showFloor = o.showFloor;
    }
    function migrateV3(o) {
      if (!o) return;
      const countries = (o.countries && Object.keys(o.countries).length) ? clone(o.countries) : { '墨西哥': Object.assign({}, COUNTRY_DEFAULT) };
      const order = Object.keys(countries); const rows = {};
      Object.keys(o.tables || {}).forEach(key => {
        const idx = key.indexOf('|'); if (idx < 0) return;
        const country = key.slice(0, idx), sku = key.slice(idx + 1);
        if (!countries[country]) { countries[country] = Object.assign({}, COUNTRY_DEFAULT); if (!order.includes(country)) order.push(country); }
        (rows[country] || (rows[country] = [])).push(...(o.tables[key] || []).map(r => Object.assign({}, r, { sku })));
      });
      const bundles = {};
      order.forEach(c => { bundles[c] = {}; Object.keys(o.productBundle || {}).forEach(sku => { bundles[c][sku] = o.productBundle[sku]; }); });
      load({ order, countries, rows, bundles, accounts: o.accounts, coInvestRules: o.coInvestRules, collapsed: {}, showFloor: o.showFloor });
    }

    return {
      state, importCost, monthsForSku, costFloorFor, firstSku,
      addCountry, removeCountry, renameCountry, setCollapsed, setFactor,
      addRow, removeRow, setCell, applyAccount, setCoInvest,
      bundleFor, setBundle, distinctSkus, resolveHw, buildCustomer, computeCountry,
      addAccount, updateAccount, deleteAccount, saveAccountFromRow,
      serialize, load, migrateV3,
      order: () => state.order, countries: () => state.countries, rowsOf: (c) => state.rows[c] || [],
    };
  }

  return { create, FACTOR_KEYS, FIELD_KINDS, COUNTRY_DEFAULT, DEFAULT_BUNDLE };
});

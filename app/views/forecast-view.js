/* ============================================================
   Salesboard — views/forecast-view.js
   SO 推演面板（2026-09-07 用户需求，v1）。

   结构：左侧 5 列冻结（产品名 / 产品型号 / 产品配置 / 近28天日销 / 平均周销），
        右侧按 天/周/月 展开的推演期，横向滚动时左侧不动。
   规则：产品行填 SO → 按**历史 SI 占比**分摊到旗下型号（和守恒）；
        型号行可各自改 SI/SO；库存滚动 = 期初 + SI − SO；DOS = 期末库存 ÷ 近28天日销。
   所有算法在 forecast-core.js（纯函数、有单测），本文件只做取数与渲染。
   ============================================================ */
'use strict';
const FC = {
  view: 'product',          // product | model | country
  gran: 'week',             // day | week | month
  nPeriods: 12,
  country: '',
  loaded: false, loading: false,
  rows: [],                 // [{kind:'product'|'model', key, product, model, config, daily, weekly, openInv, histSi, histDaily, expanded}]
  edits: {},                // { rowKey: { periodIdx: {so, si} } }  用户手填
  periods: [],              // [{label}]
  err: '',
};

// esc 在本项目里是各视图各自定义的局部函数，不是全局——不定义就每次渲染都 ReferenceError（界面会永远卡在「正在取数…」）
const fcEsc = t => String(t == null ? '' : t).replace(/[&<>"]/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[m]));
function fcNum(v, d) { return (v == null || !isFinite(v)) ? '—' : (+v).toLocaleString('en-US', { minimumFractionDigits: d || 0, maximumFractionDigits: d || 0 }); }
function fcDos(v) { return (v == null || !isFinite(v)) ? '—' : Math.round(v) + '天'; }

/* 期标签：天=MM-DD、周=Wxx、月=YYYY-MM。以今天为起点向后推。 */
function fcBuildPeriods(gran, n) {
  const out = []; const now = new Date();
  for (let i = 1; i <= n; i++) {
    const d = new Date(now.getTime());
    if (gran === 'day') { d.setDate(d.getDate() + i); out.push({ label: (d.getMonth() + 1) + '/' + d.getDate(), days: 1 }); }
    else if (gran === 'week') { d.setDate(d.getDate() + i * 7); out.push({ label: 'W+' + i, days: 7 }); }
    else { d.setMonth(d.getMonth() + i); out.push({ label: (d.getFullYear()) + '-' + String(d.getMonth() + 1).padStart(2, '0'), days: new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate() }); }
  }
  return out;
}

function fcFilters() { const f = {}; if (FC.country) f.country = [FC.country]; return f; }

/* 取数：一次拿到「产品×型号」的历史 SI（既是树结构也是占比来源）、
   近28天按天 SO（算日销）、以及各型号期初库存（快照）。 */
async function fcLoad() {
  if (FC.loading) return;
  FC.loading = true; FC.err = ''; fcRender();
  try {
    const filters = fcFilters();
    const to = state.to, from = state.from;
    const siMat = await api.agg({ measure: 'sellIn', filters: filters, cat: { field: 'product' }, legend: 'model' });
    const invMat = await api.agg({ measure: 'inv', filters: filters, cat: { field: 'model' } });
    // 近 28 天日销：按天取 SO，堆叠维度 = 型号
    const d28from = fcShiftDays(to, -27);
    const soDaily = await api.query({ metric: 'sellOut', gran: 'day', filters: filters, stackDim: 'model', from: d28from, to: to, limit: 400 });
    FC.rows = fcBuildRows(siMat, invMat, soDaily);
    // 引擎对 series>20 会只留前 20，型号会被静默丢掉——本项目不接受静默丢数，明确告诉用户
    FC.truncated = ((siMat && siMat.series) || []).length >= 20;
    FC.periods = fcBuildPeriods(FC.gran, FC.nPeriods);
    FC.loaded = true;
    if (!FC.rows.length) FC.err = '当前筛选下没有产品数据（先在「数据源」挂载 PSI 文件夹，或放宽筛选）';
  } catch (e) {
    FC.err = '取数失败：' + ((e && e.message) || e);
  } finally { FC.loading = false; fcRender(); }
}
function fcShiftDays(ymd, n) {
  const m = String(ymd || '').match(/^(\d{4})-?(\d{2})-?(\d{2})$/);
  if (!m) return ymd;
  const d = new Date(+m[1], +m[2] - 1, +m[3]); d.setDate(d.getDate() + n);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

/* 产品配置：PSI 里没有配置维度，尝试从路标产品库按型号名匹配 RAM/ROM；匹配不到显「—」。
   （v1 的诚实做法：不猜，不编） */
function fcConfigMap() {
  const map = {};
  try {
    const o = JSON.parse(localStorage.getItem('sb.roadmap.products.v1') || 'null');
    ((o && o.products) || []).forEach(p => (p.skus || []).forEach(s => {
      const cfg = [s.ram, s.rom].filter(Boolean).join('/');
      if (s.name && cfg) map[String(s.name).trim()] = cfg;
    }));
  } catch (e) {}
  return map;
}

/* 注意 agg 的返回是 **series 在前**：data[系列][类目]，不是 data[类目][系列]。
   另：引擎在 series > 20 时只保留前 20（静默截断）——本项目不接受静默丢数，命中就显式告警。 */
function fcMatBySeries(mat, cat) {
  const out = {};
  ((mat && mat.series) || []).forEach(se => {
    const v = mat.data && mat.data[se] && mat.data[se][cat];
    if (v != null) out[se] = +v;
  });
  return out;
}
function fcMatTotal(mat, cat) {
  let t = 0; const o = fcMatBySeries(mat, cat);
  Object.keys(o).forEach(k => { t += o[k] || 0; });
  return t;
}

function fcBuildRows(siMat, invMat, soDaily) {
  const cfgMap = fcConfigMap();
  // 期初库存：按型号取（inv 是快照，agg 用 last 聚合）
  const invByModel = {};
  ((invMat && invMat.cats) || []).forEach(m => { invByModel[m] = fcMatTotal(invMat, m); });
  // 近28天按天 SO → 各型号日销
  const dailyByModel = {};
  const buckets = (soDaily && soDaily.buckets) || [];
  Object.keys((soDaily && soDaily.data) || {}).forEach(mk => {
    const series = buckets.map(b => { const v = soDaily.data[mk][b]; return (v == null) ? null : +v; });
    dailyByModel[mk] = { series: series, rate: ForecastCore.dailyRunRate(series, 28) };
  });
  const rows = [];
  ((siMat && siMat.cats) || []).forEach(prod => {
    const perModel = fcMatBySeries(siMat, prod);                  // {型号: 历史SI}
    const models = Object.keys(perModel).filter(m => (perModel[m] || 0) > 0);
    if (!models.length) return;
    const kids = models.map(m => {
      const dd = dailyByModel[m] || { series: [], rate: null };
      return {
        kind: 'model', key: prod + '||' + m, product: prod, model: m,
        config: cfgMap[String(m).trim()] || '—',
        daily: dd.rate, weekly: ForecastCore.weeklyFromDaily(dd.rate),
        openInv: (invByModel[m] == null ? null : +invByModel[m]),
        histSi: perModel[m] || 0, histDaily: dd.series,
      };
    });
    const anyRate = kids.some(k => k.daily != null);
    const pDaily = anyRate ? kids.reduce((a, k) => a + (k.daily || 0), 0) : null;
    rows.push({
      kind: 'product', key: prod, product: prod, model: '（全部型号）', config: '—',
      daily: pDaily, weekly: ForecastCore.weeklyFromDaily(pDaily),
      openInv: kids.reduce((a, k) => a + (k.openInv || 0), 0),
      histSi: kids.reduce((a, k) => a + (k.histSi || 0), 0),
      kids: kids, expanded: false,
    });
  });
  rows.sort((a, b) => (b.daily || 0) - (a.daily || 0));
  return rows;
}
function fcFirstVal(mat, cat) { const d = (mat.data && mat.data[cat]) || {}; const k = Object.keys(d)[0]; return k ? d[k] : null; }

/* 计算一行（产品或型号）在各期的推演结果 */
function fcComputeProduct(p) {
  const ed = FC.edits[p.key] || {};
  const productPeriods = FC.periods.map((pd, i) => ({
    so: (ed[i] && ed[i].so != null) ? +ed[i].so : Math.round((p.weekly != null ? p.weekly : 0) * (pd.days / 7)),
    si: (ed[i] && ed[i].si != null) ? +ed[i].si : null,
    days: pd.days,
  }));
  const models = (p.kids || []).map(k => ({ key: k.key, openInv: k.openInv, histDaily: k.histDaily, histSi: k.histSi }));
  const r = ForecastCore.simulateProduct({ gran: FC.gran, productPeriods: productPeriods, models: models });
  // 型号行若被用户单独改过，用它自己的值覆盖（用户手填优先于分摊）
  (p.kids || []).forEach(k => {
    const ke = FC.edits[k.key];
    if (!ke) return;
    const periods = FC.periods.map((pd, i) => {
      const base = r.byModel[k.key][i];
      return { so: (ke[i] && ke[i].so != null) ? +ke[i].so : base.so, si: (ke[i] && ke[i].si != null) ? +ke[i].si : base.si, days: pd.days };
    });
    r.byModel[k.key] = ForecastCore.simulate({ openInv: k.openInv, histDaily: k.histDaily, periods: periods, gran: FC.gran });
  });
  // 产品级汇总 = 各型号之和（SO/SI 可加；库存同期可加；DOS 按合计库存÷合计日销重算，不平均）
  const prod = FC.periods.map((pd, i) => {
    let so = 0, si = 0, inv = 0, rate = 0, anyRate = false;
    (p.kids || []).forEach(k => { const rr = r.byModel[k.key][i]; so += rr.so; si += rr.si; inv += rr.inv; if (rr.rate != null) { rate += rr.rate; anyRate = true; } });
    return { so: so, si: si, inv: inv, rate: anyRate ? rate : null, dos: ForecastCore.dosOf(inv, anyRate ? rate : null) };
  });
  return { byModel: r.byModel, product: prod, shares: r.shares };
}

function fcRender() {
  const host = document.getElementById('view-forecast'); if (!host) return;
  const gseg = (id, cur, opts) => '<span class="rm-seg">' + opts.map(o => '<button data-' + id + '="' + o[0] + '" class="' + (cur === o[0] ? 'on' : '') + '">' + o[1] + '</button>').join('') + '</span>';
  const countries = fcCountryOpts();
  let h = '<div class="fc-wrap">'
    + '<div class="fc-tools">'
    + '<span class="fc-lab">视图</span>' + gseg('fcv', FC.view, [['product', '产品视图'], ['model', '型号视图'], ['country', '国家视图']])
    + '<span class="fc-lab">粒度</span>' + gseg('fcg', FC.gran, [['day', '按天'], ['week', '按周'], ['month', '按月']])
    + '<span class="fc-lab">期数</span><input id="fcN" type="number" min="1" max="52" value="' + FC.nPeriods + '" style="width:56px">'
    + '<span class="fc-lab">国家</span><select id="fcCountry"><option value="">全部</option>' + countries.map(c => '<option' + (c === FC.country ? ' selected' : '') + '>' + fcEsc(c) + '</option>').join('') + '</select>'
    + '<button class="btn" id="fcReload">重新取数</button>'
    + '<button class="btn" id="fcClear" title="清空所有手填值，回到按平均周销推演">清空推演</button>'
    + '<span class="fc-hint">产品行填 SO → 按历史 SI 占比自动分摊到型号；型号行可单独改，手填优先。DOS = 期末库存 ÷ 近28天日销。</span>'
    + '</div>';
  if (FC.loading) h += '<div class="fc-empty">正在取数…</div>';
  else if (FC.err) h += '<div class="fc-empty">' + fcEsc(FC.err) + '</div>';
  else if (!FC.loaded) h += '<div class="fc-empty">点「重新取数」开始</div>';
  else { if (FC.truncated) h += '<div class="fc-warn">⚠ 型号数超过引擎单次返回上限（20），列表可能不全。请用国家/产品筛选缩小范围后再推演。</div>'; h += fcTable(); }
  h += '</div>';
  host.innerHTML = h;
  fcBind();
}

function fcCountryOpts() {
  try { const o = (state.filterOpts && state.filterOpts.country) || []; return o.slice(0, 200); } catch (e) { return []; }
}

function fcTable() {
  const P = FC.periods;
  let h = '<div class="fc-scroll"><table class="fc-table"><thead><tr>'
    + '<th class="fz fz1">产品名</th><th class="fz fz2">产品型号</th><th class="fz fz3">产品配置</th>'
    + '<th class="fz fz4 num">近28天日销</th><th class="fz fz5 num">平均周销</th>';
  P.forEach(p => { h += '<th class="num per" colspan="3">' + fcEsc(p.label) + '</th>'; });
  h += '</tr><tr>'
    + '<th class="fz fz1 sub"></th><th class="fz fz2 sub"></th><th class="fz fz3 sub"></th><th class="fz fz4 sub"></th><th class="fz fz5 sub"></th>';
  P.forEach(() => { h += '<th class="num sub">SO</th><th class="num sub">SI</th><th class="num sub">DOS</th>'; });
  h += '</tr></thead><tbody>';
  FC.rows.forEach(p => {
    const calc = fcComputeProduct(p);
    h += '<tr class="fc-prod" data-k="' + fcEsc(p.key) + '">'
      + '<td class="fz fz1"><span class="fc-exp">' + (p.expanded ? '▾' : '▸') + '</span>' + fcEsc(p.product) + '</td>'
      + '<td class="fz fz2 dim">' + fcEsc(p.model) + '</td><td class="fz fz3 dim">' + fcEsc(p.config) + '</td>'
      + '<td class="fz fz4 num">' + fcNum(p.daily, 1) + '</td><td class="fz fz5 num">' + fcNum(p.weekly, 0) + '</td>';
    calc.product.forEach((c, i) => {
      const ed = (FC.edits[p.key] || {})[i] || {};
      h += '<td class="num"><input class="fc-in" data-k="' + fcEsc(p.key) + '" data-i="' + i + '" data-f="so" value="' + (ed.so != null ? ed.so : c.so) + '"></td>'
        + '<td class="num dim">' + fcNum(c.si) + '</td>'
        + '<td class="num ' + fcDosCls(c.dos) + '">' + fcDos(c.dos) + '</td>';
    });
    h += '</tr>';
    if (p.expanded) (p.kids || []).forEach(k => {
      const rows = calc.byModel[k.key] || [];
      h += '<tr class="fc-model" data-k="' + fcEsc(k.key) + '">'
        + '<td class="fz fz1 dim"></td><td class="fz fz2">' + fcEsc(k.model) + '</td><td class="fz fz3 dim">' + fcEsc(k.config) + '</td>'
        + '<td class="fz fz4 num">' + fcNum(k.daily, 1) + '</td><td class="fz fz5 num">' + fcNum(k.weekly, 0) + '</td>';
      rows.forEach((c, i) => {
        const ed = (FC.edits[k.key] || {})[i] || {};
        h += '<td class="num"><input class="fc-in" data-k="' + fcEsc(k.key) + '" data-i="' + i + '" data-f="so" value="' + (ed.so != null ? ed.so : c.so) + '"></td>'
          + '<td class="num"><input class="fc-in si" data-k="' + fcEsc(k.key) + '" data-i="' + i + '" data-f="si" value="' + (ed.si != null ? ed.si : c.si) + '"></td>'
          + '<td class="num ' + fcDosCls(c.dos) + '">' + fcDos(c.dos) + '</td>';
      });
      h += '</tr>';
    });
  });
  h += '</tbody></table></div>';
  return h;
}
function fcDosCls(d) { if (d == null) return 'dim'; if (d > 120) return 'dos-hi'; if (d < 14) return 'dos-lo'; return ''; }

function fcBind() {
  const host = document.getElementById('view-forecast'); if (!host) return;
  host.querySelectorAll('[data-fcv]').forEach(b => { b.onclick = () => { FC.view = b.dataset.fcv; fcRender(); }; });
  host.querySelectorAll('[data-fcg]').forEach(b => { b.onclick = () => { FC.gran = b.dataset.fcg; FC.periods = fcBuildPeriods(FC.gran, FC.nPeriods); FC.edits = {}; fcRender(); }; });
  const n = host.querySelector('#fcN'); if (n) n.onchange = () => { FC.nPeriods = Math.max(1, Math.min(52, +n.value || 12)); FC.periods = fcBuildPeriods(FC.gran, FC.nPeriods); fcRender(); };
  const c = host.querySelector('#fcCountry'); if (c) c.onchange = () => { FC.country = c.value; fcLoad(); };
  const rl = host.querySelector('#fcReload'); if (rl) rl.onclick = fcLoad;
  const cl = host.querySelector('#fcClear'); if (cl) cl.onclick = () => { FC.edits = {}; fcRender(); };
  host.querySelectorAll('tr.fc-prod .fz1').forEach(td => {
    td.onclick = () => { const k = td.parentNode.dataset.k; const p = FC.rows.find(x => x.key === k); if (p) { p.expanded = !p.expanded; fcRender(); } };
  });
  host.querySelectorAll('input.fc-in').forEach(inp => {
    inp.onchange = () => {
      const k = inp.dataset.k, i = +inp.dataset.i, fld = inp.dataset.f;
      const v = inp.value.trim();
      FC.edits[k] = FC.edits[k] || {}; FC.edits[k][i] = FC.edits[k][i] || {};
      if (v === '') delete FC.edits[k][i][fld]; else FC.edits[k][i][fld] = Math.max(0, Math.round(+v || 0));
      fcRender();
    };
  });
}

function renderForecast() {
  if (!window.ForecastCore) { const h = document.getElementById('view-forecast'); if (h) h.innerHTML = '<div class="fc-empty">推演内核未加载</div>'; return; }
  if (!FC.loaded && !FC.loading) fcLoad(); else fcRender();
}

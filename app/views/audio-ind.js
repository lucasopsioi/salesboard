'use strict';
/* ============================================================
   音频周报 M4 · 周度销售进展 — 产业看板(4核KPI+折线+全套筛选)的自包含移植副本
   port 自 views/industry-view.js,**不改动原产业看板任何代码**;
   状态独立(auInd + sb.audio.ind.v1),DOM 全部本文件生成(class 选择器,无 id 冲突),
   图表实例独立;默认筛音频线但不锁死(用户可自由改)。
   依赖(只读):common.js helpers / CT()(industry-view 定义的主题桥) / FinCalc / echarts / api。
   ============================================================ */
const AUIND_STATE_KEY = 'sb.audio.ind.v1';
const AUIND_PSI_LAB = { sellIn: 'Sell In', sellOut: 'Sell Out', inv: 'Inventory', dos: 'DOS' };
const AUIND_FLD_LAB = { line: 'Product Line', family: 'Product Family', repOffice: 'Rep Office', country: 'Country', series: 'Product Series', product: 'Product', model: 'Product Model' };
const AUIND_UNIT_TAIL = { one: '台', k: '千台', w: '万台' };
const auInd = {
  indDim: 'line', filters: {}, cmp: { series: [], product: [], model: [] }, metric: 'sellOut', gran: 'week',
  color: (typeof SB_COLORS !== 'undefined' ? SB_COLORS.brand : '#C7000B'), colorPrev: '#B9BEC6',
  unit: 'one', smooth: true, from: null, to: null, chart: null, data: null, fullPeriods: [], seeded: false, restored: false,
};
function auIndCT() { return (typeof CT === 'function') ? CT() : { ink1: () => '#1A1A1A', ink2: () => '#5A5F66', ink3: () => '#8A9099', line: () => '#E6E8EB', lineSoft: () => '#F0F1F3', register: c => c }; }
function auIndStateSave() {
  boardStateSave(AUIND_STATE_KEY, () => ({
    filters: auInd.filters, cmp: auInd.cmp, metric: auInd.metric, gran: auInd.gran,
    unit: auInd.unit, smooth: auInd.smooth, color: auInd.color, colorPrev: auInd.colorPrev, from: auInd.from, to: auInd.to, seeded: auInd.seeded,
  }), 500);
}
function auIndStateRestore() {
  if (auInd.restored) return; auInd.restored = true;
  const o = boardStateLoad(AUIND_STATE_KEY); if (!o) return;
  if (o.filters && typeof o.filters === 'object') auInd.filters = o.filters;
  if (o.cmp && typeof o.cmp === 'object') { ['series', 'product', 'model'].forEach(k => { if (Array.isArray(o.cmp[k])) auInd.cmp[k] = o.cmp[k]; }); }
  if (['sellIn', 'sellOut', 'inv', 'dos'].includes(o.metric)) auInd.metric = o.metric;
  if (['day', 'week', 'month'].includes(o.gran)) auInd.gran = o.gran;
  if (['one', 'k', 'w'].includes(o.unit)) auInd.unit = o.unit;
  if (typeof o.smooth === 'boolean') auInd.smooth = o.smooth;
  if (typeof o.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(o.color)) auInd.color = o.color;
  if (typeof o.colorPrev === 'string' && /^#[0-9a-fA-F]{6}$/.test(o.colorPrev)) auInd.colorPrev = o.colorPrev;
  if (typeof o.from === 'string') auInd.from = o.from;
  if (typeof o.to === 'string') auInd.to = o.to;
  if (o.seeded) auInd.seeded = true;
}
const auIndUnitInfo = () => UNIT_OPT[auInd.unit] || UNIT_OPT.one;
function auIndFmt(v) { const u = auIndUnitInfo(); if (v == null || isNaN(v)) return '0'; if (u.div === 1) return Math.round(v).toLocaleString('en-US'); const x = v / u.div; return (Math.abs(x) >= 100 ? Math.round(x).toLocaleString('en-US') : (+x.toFixed(1))) + u.suf; }
const auIndFmtU = v => auIndFmt(v) + '台';
function auIndYoyCell(v) { if (v == null || !isFinite(v)) return '<span class="wk">—</span>'; const c = v >= 0 ? 'pos' : 'neg'; return `<span class="${c}">${v >= 0 ? '+' : ''}${(v * 100).toFixed(0)}%</span>`; }
function auIndMainFields() { const dd = auInd.indDim || 'line'; const prod = ['line', 'family', 'series', 'product', 'model'].filter(k => k !== dd); return [dd, ...prod, 'repOffice', 'country']; }
function auIndCmpHas() { return !!(auInd.cmp.series.length || auInd.cmp.product.length || auInd.cmp.model.length); }
function auIndClearDownstream(field) {
  const dd = auInd.indDim;
  const cut = chain => { const i = chain.indexOf(field); if (i >= 0) chain.slice(i + 1).forEach(f => delete auInd.filters[f]); };
  cut(['region', 'repOffice', 'country']); cut([dd, 'series', 'product', 'model']);
  if (field === dd) auInd.cmp = { series: [], product: [], model: [] };
}
/* ---------- R1 产业跟随:M4 的种子筛选跟着看板顶部的音频/平板切换走 ----------
   种子只在「该维度当前没选」时写入,用户自己改过就不覆盖(不锁死)。 */
async function auIndSeedIndustry() {
  if (typeof auDetectIndustryDim !== 'function') return;
  const kind = (typeof auW !== 'undefined' && auW.industry) || 'audio';
  let d = null; try { d = await auDetectIndustryDim(kind); } catch (e) { }
  if (d && !asArrLocal(auInd.filters[d.field]).length) auInd.filters[d.field] = [d.value];
}
// 切产业:把旧产业的维度值换成新产业的(只换我们种下去的那一格),清缓存后重绘。由 auSwitchIndustry 调用。
async function auIndSetIndustry(kind) {
  if (typeof auDetectIndustryDim !== 'function') return;
  let prev = null, next = null;
  try { for (const o of (typeof AU_INDS !== 'undefined' ? AU_INDS : [])) { const d = await auDetectIndustryDim(o.key); if (d) { if (o.key === kind) next = d; else prev = prev || d; } } } catch (e) { }
  // 旧产业的值还挂在筛选里 → 摘掉,避免「切到平板却还筛着音频」导致取数为空
  if (prev) { const cur = asArrLocal(auInd.filters[prev.field]).filter(v => v !== prev.value); if (cur.length) auInd.filters[prev.field] = cur; else delete auInd.filters[prev.field]; }
  if (next && !asArrLocal(auInd.filters[next.field]).length) auInd.filters[next.field] = [next.value];
  auInd.cmp = { series: [], product: [], model: [] };   // 对比项属于旧产业,一并清
  auInd.data = null; auIndStateSave();
}
if (typeof window !== 'undefined') window.auIndSetIndustry = auIndSetIndustry;

function auIndRoot() { return document.getElementById('auSecInd'); }
const auQ = sel => { const r = auIndRoot(); return r ? r.querySelector(sel) : null; };
const auQA = sel => { const r = auIndRoot(); return r ? [...r.querySelectorAll(sel)] : []; };

/* ---------- 控件骨架(全部 JS 生成,class 选择器) ---------- */
function auIndShell() {
  const host = auIndRoot(); if (!host || host.dataset.built) return;
  host.dataset.built = '1';
  // 说明里的产业名要跟着切换走(骨架只建一次,所以文案交给 renderAuInd 每轮刷新)
  host.innerHTML = '<div class="au-sec-t">M4 · 周度销售进展<span class="au-note au-ind-note"></span></div>'
    + '<div class="psi-row au-ind-row1">'
    + '  <div class="fld"><label>PSI指标</label><div class="seg au-ind-metric">' + [['sellIn', 'Sell In'], ['sellOut', 'Sell Out'], ['inv', '库存'], ['dos', 'DOS']].map(o => `<button data-m="${o[0]}">${o[1]}</button>`).join('') + '</div></div>'
    + '  <div class="fld"><label>时间粒度</label><div class="seg au-ind-gran">' + [['month', '月'], ['week', '周'], ['day', '日']].map(o => `<button data-g="${o[0]}">${o[1]}</button>`).join('') + '</div></div>'
    + '  <div class="fld"><label>时间范围</label><span class="au-ind-range"></span></div>'
    + '  <div class="fld"><label>数据单位</label><div class="seg au-ind-unit">' + [['one', '台'], ['k', '千台K'], ['w', '万台W']].map(o => `<button data-u="${o[0]}">${o[1]}</button>`).join('') + '</div></div>'
    + '  <div class="fld"><label>线型</label><div class="seg au-ind-smooth"><button data-s="1">平滑</button><button data-s="0">折线</button></div></div>'
    + '  <div class="fld"><label>今年线色</label><input type="color" class="color-inp au-ind-color"></div>'
    + '  <div class="fld"><label>去年线色</label><input type="color" class="color-inp au-ind-colorprev"></div>'
    + '</div>'
    + '<div class="psi-row au-ind-filterrow"></div>'
    + '<div class="psi-row au-ind-cmprow"></div>'
    + '<div class="kpi-row au-ind-kpi"></div>'
    + '<div class="au-ind-charttitle" style="font-size:13px;font-weight:600;color:var(--c-ink-1);margin:8px 0 2px"></div>'
    + '<div class="au-ind-charthint" style="font-size:11px;color:var(--c-ink-3);margin-bottom:4px"></div>'
    + '<div class="au-ind-chartwrap" style="position:relative;height:380px;border:1px solid var(--c-line);border-radius:10px;background:var(--c-bg-elev)"><div class="au-ind-chart" style="position:absolute;inset:0"></div></div>';
  auQA('.au-ind-metric button').forEach(b => b.onclick = () => { auInd.metric = b.dataset.m; auIndSyncSegs(); auIndDraw(); auIndStateSave(); });
  auQA('.au-ind-gran button').forEach(b => b.onclick = () => { auInd.gran = b.dataset.g; auIndSyncSegs(); auInd.from = null; auInd.to = null; auIndDraw(); auIndStateSave(); });
  auQA('.au-ind-unit button').forEach(b => b.onclick = () => { auInd.unit = b.dataset.u; auIndSyncSegs(); if (auInd.data) { auIndRenderKpi(auInd.data); auIndRenderChart(auInd.data); } auIndStateSave(); });
  auQA('.au-ind-smooth button').forEach(b => b.onclick = () => { auInd.smooth = b.dataset.s === '1'; auIndSyncSegs(); if (auInd.data) auIndRenderChart(auInd.data); auIndStateSave(); });
  const ci = auQ('.au-ind-color'); ci.oninput = e => { auInd.color = e.target.value; if (auInd.data) auIndRenderChart(auInd.data); auIndStateSave(); };
  const cp = auQ('.au-ind-colorprev'); cp.oninput = e => { auInd.colorPrev = e.target.value; if (auInd.data) auIndRenderChart(auInd.data); auIndStateSave(); };
}
function auIndSyncSegs() {
  auQA('.au-ind-metric button').forEach(x => x.classList.toggle('on', x.dataset.m === auInd.metric));
  auQA('.au-ind-gran button').forEach(x => x.classList.toggle('on', x.dataset.g === auInd.gran));
  auQA('.au-ind-unit button').forEach(x => x.classList.toggle('on', x.dataset.u === auInd.unit));
  auQA('.au-ind-smooth button').forEach(x => x.classList.toggle('on', (x.dataset.s === '1') === auInd.smooth));
  const ci = auQ('.au-ind-color'); if (ci) ci.value = auInd.color;
  const cp = auQ('.au-ind-colorprev'); if (cp) cp.value = auInd.colorPrev;
}
/* ---------- 筛选行(级联多选,port) ---------- */
async function auIndRenderFilters() {
  const row = auQ('.au-ind-filterrow'); if (!row) return; row.innerHTML = '<span class="ind-rowlab">筛选 ▸</span>';
  for (const field of auIndMainFields().filter(f => state.dims.includes(f))) {
    const opts = sortByHier(field, await api.options(field, auInd.filters));
    let cur = asArrLocal(auInd.filters[field]).filter(v => opts.includes(v));
    if (cur.length) auInd.filters[field] = cur; else delete auInd.filters[field];
    const ms = makeMultiSelect(AUIND_FLD_LAB[field] || DIM_LABEL[field] || field, opts, cur, {
      placeholder: '全部',
      onChange: v => { if (v.length) auInd.filters[field] = v; else delete auInd.filters[field]; },
      onCommit: async v => {
        if (v.length) auInd.filters[field] = v; else delete auInd.filters[field];
        auIndClearDownstream(field); await auIndRenderFilters(); await auIndRenderCmp(); auIndDraw(); auIndStateSave();
      },
    });
    row.appendChild(ms);
  }
}
function auIndCmpBase() { const b = {}, dd = auInd.indDim; [dd, 'region', 'repOffice', 'country', 'channel'].forEach(k => { if (asArrLocal(auInd.filters[k]).length) b[k] = auInd.filters[k]; }); return b; }
async function auIndRenderCmp() {
  const row = auQ('.au-ind-cmprow'); if (!row) return; row.innerHTML = '<span class="ind-rowlab">对比·去年灰线 ▸</span>';
  const base = auIndCmpBase();
  for (const [field, lab] of [['series', '对比系列'], ['product', '对比产品'], ['model', '对比型号']]) {
    if (!state.dims.includes(field)) continue;
    const f = Object.assign({}, base);
    if (field !== 'series' && auInd.cmp.series.length) f.series = auInd.cmp.series;
    if (field === 'model' && auInd.cmp.product.length) f.product = auInd.cmp.product;
    const opts = sortByHier(field, await api.options(field, f));
    let cur = asArrLocal(auInd.cmp[field]).filter(v => opts.includes(v)); auInd.cmp[field] = cur;
    const ms = makeMultiSelect(lab, opts, cur, {
      placeholder: '（不对比）',
      onChange: v => { auInd.cmp[field] = v; },
      onCommit: async v => {
        auInd.cmp[field] = v; if (field === 'series') { auInd.cmp.product = []; auInd.cmp.model = []; } if (field === 'product') { auInd.cmp.model = []; }
        await auIndRenderCmp(); auIndDraw(); auIndStateSave();
      },
    });
    row.appendChild(ms);
  }
}
/* ---------- 主流程 ---------- */
async function renderAuInd() {
  const host = auIndRoot(); if (!host) return;
  if (!state.dims.length) { host.innerHTML = '<div class="au-sec-t">M4 · 周度销售进展</div><div class="au-empty">请先锚定 PSI 数据或载入示例。</div>'; delete host.dataset.built; return; }
  auIndStateRestore();
  auIndShell();
  const noteEl = host.querySelector('.au-ind-note');
  if (noteEl) noteEl.textContent = '产业看板同款(4核+趋势+全部筛选),独立实例,默认筛「'
    + (typeof auIndustryLabel === 'function' ? auIndustryLabel() : '音频') + '」、可自由改';
  const probe = await api.industryBoard({ filters: {}, cmp: {} });
  auInd.indDim = (probe && probe.indDim) || 'line';
  // 首次进入:按当前产业(音频/平板)播一次种子筛选,之后完全跟随用户;不锁死。
  // 切换产业时 auIndSetIndustry() 会把 seeded 复位并换掉旧产业的维度值(见下)。
  if (!auInd.seeded) {
    auInd.seeded = true;
    await auIndSeedIndustry();
    auIndStateSave();
  }
  auIndSyncSegs();
  await auIndRenderFilters(); await auIndRenderCmp(); await auIndDraw();
}
async function auIndDraw() {
  if (!state.dims.length) return;
  const b = await api.industryBoard({ filters: auInd.filters, cmp: auInd.cmp, metric: auInd.metric, gran: auInd.gran });
  auInd.data = b; if (b.indDim) auInd.indDim = b.indDim;
  auInd.fullPeriods = (b.trend && b.trend.periods) || [];
  auIndRenderRange(); auIndRenderKpi(b); auIndRenderChart(b);
}
function auIndRenderRange() {
  const host = auQ('.au-ind-range'); if (!host) return; const ps = auInd.fullPeriods;
  if (!ps.length) { host.innerHTML = '<span class="wk">—</span>'; return; }
  if (!auInd.from || ps.indexOf(auInd.from) < 0) auInd.from = ps[0];
  if (!auInd.to || ps.indexOf(auInd.to) < 0) auInd.to = ps[ps.length - 1];
  const opt = sel => ps.map(p => `<option ${p === sel ? 'selected' : ''}>${p}</option>`).join('');
  host.innerHTML = `<select class="au-ind-from">${opt(auInd.from)}</select><span style="color:var(--c-ink-3)">~</span><select class="au-ind-to">${opt(auInd.to)}</select>`;
  host.querySelector('.au-ind-from').onchange = e => { auInd.from = e.target.value; if (ps.indexOf(auInd.from) > ps.indexOf(auInd.to)) auInd.to = auInd.from; auIndRenderRange(); auIndRenderKpi(auInd.data); auIndRenderChart(auInd.data); auIndStateSave(); };
  host.querySelector('.au-ind-to').onchange = e => { auInd.to = e.target.value; if (ps.indexOf(auInd.to) < ps.indexOf(auInd.from)) auInd.from = auInd.to; auIndRenderRange(); auIndRenderKpi(auInd.data); auIndRenderChart(auInd.data); auIndStateSave(); };
}
function auIndWin() {
  const t = auInd.data && auInd.data.trend; if (!t || !t.periods || !t.periods.length) return null;
  let lo = t.periods.indexOf(auInd.from), hi = t.periods.indexOf(auInd.to);
  if (lo < 0) lo = 0; if (hi < 0) hi = t.periods.length - 1; if (lo > hi) { const x = lo; lo = hi; hi = x; }
  return { t, lo, hi, full: lo === 0 && hi === t.periods.length - 1 };
}
function auIndKpiWindow() {
  const w = auIndWin(); if (!w || !Array.isArray(w.t.siCur)) return null;
  const sum = a => { let s = 0; for (let i = w.lo; i <= w.hi; i++) s += a[i] || 0; return s; };
  const siC = sum(w.t.siCur), siP = sum(w.t.siPrev), soC = sum(w.t.soCur), soP = sum(w.t.soPrev);
  return {
    si: { cur: siC, prev: siP, yoy: window.FinCalc.yoy(siC, siP) }, so: { cur: soC, prev: soP, yoy: window.FinCalc.yoy(soC, soP) },
    label: w.full ? 'YTD' : `${w.t.periods[w.lo]}~${w.t.periods[w.hi]}`,
  };
}
function auIndRenderKpi(b) {
  const host = auQ('.au-ind-kpi'); if (!host) return;
  const k = b.kpi || {}; const cy = b.curYear || '今年', py = b.prevYear || '去年';
  const tw = auIndFmtU;
  const card = (title, val, sub) => `<div class="kpi-card"><div class="k">${title}</div><div class="v">${val}</div><div class="row2">${sub}</div></div>`;
  const kw = auIndKpiWindow();
  const si = kw ? kw.si : k.si, so = kw ? kw.so : k.so, rl = kw ? kw.label : 'YTD';
  let h = '';
  h += card(`${cy}年 Sell In ${rl}`, tw(si.cur), `<span><span class="lab">${py}同期</span> ${tw(si.prev)}</span><span><span class="lab">同比</span> ${auIndYoyCell(si.yoy)}</span>`);
  h += card(`${cy}年 Sell Out ${rl}`, tw(so.cur), `<span><span class="lab">${py}同期</span> ${tw(so.prev)}</span><span><span class="lab">同比</span> ${auIndYoyCell(so.yoy)}</span>`);
  h += card('当前 库存 Inventory', tw(k.inv.cur), `<span><span class="lab">渠道DOS</span> ${k.inv.dos == null ? '—' : k.inv.dos + ' 天'}</span>`);
  if (k.flow && k.flow.cur != null) h += card('当前 全流程库存', tw(k.flow.cur), `<span><span class="lab">全流程DOS</span> ${k.flow.dos == null ? '—' : k.flow.dos + ' 天'}</span>`);
  else h += card('当前 全流程库存', '—', '<span class="wk">需库龄/全流程表</span>');
  host.innerHTML = h;
}
function auIndScopeLabel() {
  const pick = f => { const a = asArrLocal(auInd.filters[f]); return a.length ? (a.length === 1 ? a[0] : a.length + '项') : null; };
  const order = [auInd.indDim, 'repOffice', 'country', 'series', 'product', 'model'];
  for (let i = order.length - 1; i >= 0; i--) { const v = pick(order[i]); if (v) return v; }
  return '拉美整体';
}
function auIndRenderChart(b) {
  const el = auQ('.au-ind-chart'); if (!el) return;
  if (!auInd.chart) { auInd.chart = auIndCT().register(echarts.init(el)); window.addEventListener('resize', () => auInd.chart && auInd.chart.resize()); }
  const t = b && b.trend; const tt = auQ('.au-ind-charttitle'), th = auQ('.au-ind-charthint');
  if (!t || !t.periods.length) { auInd.chart.clear(); if (tt) tt.textContent = '趋势'; if (th) th.textContent = ''; return; }
  let lo = t.periods.indexOf(auInd.from), hi = t.periods.indexOf(auInd.to);
  if (lo < 0) lo = 0; if (hi < 0) hi = t.periods.length - 1; if (lo > hi) { const x = lo; lo = hi; hi = x; }
  const periods = t.periods.slice(lo, hi + 1), cur = t.cur.slice(lo, hi + 1), prev = t.prev.slice(lo, hi + 1);
  const cmpOn = auIndCmpHas();
  const curName = `${t.curYear} ${AUIND_PSI_LAB[t.metric] || ''}`.trim();
  const prevName = cmpOn ? `${t.prevYear} 对比` : `${t.prevYear}`;
  const red = auInd.color || '#C7000B';
  const grey = auInd.colorPrev || '#B9BEC6';
  const greyLab = grey.toUpperCase() === '#B9BEC6' ? '#8A9099' : grey;
  const lab = (pos, color) => ({ show: true, position: pos, distance: 5, color, fontFamily: YH, fontSize: 10, fontWeight: 'bold', textBorderWidth: 0, formatter: p => auIndFmt(p.value) });
  const hasPrev = prev.some(v => v > 0);
  const smooth = !!auInd.smooth;
  const curUp = cur.map((v, i) => hasPrev && (prev[i] || 0) > (v || 0) ? 'bottom' : 'top');
  const dataCur = cur.map((v, i) => ({ value: v, label: { position: curUp[i] } }));
  const dataPrev = prev.map((v, i) => ({ value: v, label: { position: curUp[i] === 'top' ? 'bottom' : 'top' } }));
  const series = [
    { name: curName, type: 'line', smooth, symbol: 'circle', symbolSize: 6, showAllSymbol: true, lineStyle: { width: 3.2, color: red }, itemStyle: { color: red }, label: lab('top', red), data: dataCur, z: 6 },
    { name: prevName, type: 'line', smooth, symbol: 'circle', symbolSize: 4, showAllSymbol: true, lineStyle: { width: 2, color: grey, type: 'dashed' }, itemStyle: { color: grey }, label: lab('bottom', greyLab), data: dataPrev, z: 4 },
  ];
  auInd.chart.setOption({
    textStyle: { fontFamily: YH },
    tooltip: { trigger: 'axis', backgroundColor: 'rgba(26,26,26,.92)', borderWidth: 0, textStyle: { color: '#fff', fontFamily: YH, fontSize: 11 }, valueFormatter: v => auIndFmtU(v) },
    legend: { top: 6, left: 'center', textStyle: { fontFamily: YH, fontSize: 12, color: auIndCT().ink2() } },
    grid: { left: 62, right: 24, top: 42, bottom: periods.length > 16 ? 56 : 34 },
    dataZoom: [{ type: 'inside', zoomOnMouseWheel: 'ctrl', moveOnMouseWheel: false }],
    xAxis: { type: 'category', data: periods, axisLabel: { fontFamily: YH, fontSize: 11, color: auIndCT().ink3(), rotate: periods.length > 16 ? 40 : 0 }, axisLine: { lineStyle: { color: auIndCT().line() } }, axisTick: { show: false } },
    yAxis: [{ type: 'value', axisLabel: { fontFamily: YH, fontSize: 10, color: auIndCT().ink3(), formatter: v => auIndFmt(v) }, splitLine: { lineStyle: { color: auIndCT().lineSoft() } } }],
    series,
  }, true);
  if (tt) tt.textContent = `${auIndScopeLabel()} · ${AUIND_PSI_LAB[t.metric] || t.metric} · ${({ day: '日', week: '周', month: '月' })[t.gran]}维度`;
  if (th) th.textContent = `红实线=${t.curYear}年今年 · 灰虚线=${cmpOn ? '对比项' : t.prevYear + '年去年'}${hasPrev ? '' : '（去年无数据）'}`;
  setTimeout(() => auInd.chart && auInd.chart.resize(), 30);
}
/* ---------- 供一键导出取用:KPI 快照 + 图表 PNG ---------- */
function auIndExportModel() {
  const b = auInd.data; if (!b) return null;
  const k = b.kpi || {}; const kw = auIndKpiWindow();
  const si = kw ? kw.si : k.si, so = kw ? kw.so : k.so, rl = kw ? kw.label : 'YTD';
  const strip = h => String(h).replace(/<[^>]*>/g, '');
  const yoyTxt = v => v == null || !isFinite(v) ? '—' : (v >= 0 ? '+' : '') + (v * 100).toFixed(0) + '%';
  const kpis = [
    { t: `${b.curYear}年 Sell In ${rl}`, v: auIndFmtU(si.cur), sub: `${b.prevYear}同期 ${auIndFmtU(si.prev)} · 同比 ${yoyTxt(si.yoy)}` },
    { t: `${b.curYear}年 Sell Out ${rl}`, v: auIndFmtU(so.cur), sub: `${b.prevYear}同期 ${auIndFmtU(so.prev)} · 同比 ${yoyTxt(so.yoy)}` },
    { t: '当前 库存', v: auIndFmtU(k.inv.cur), sub: `渠道DOS ${k.inv.dos == null ? '—' : k.inv.dos + ' 天'}` },
    (k.flow && k.flow.cur != null) ? { t: '当前 全流程库存', v: auIndFmtU(k.flow.cur), sub: `全流程DOS ${k.flow.dos == null ? '—' : k.flow.dos + ' 天'}` } : { t: '当前 全流程库存', v: '—', sub: '需库龄/全流程表' },
  ];
  const tt = auQ('.au-ind-charttitle'), th = auQ('.au-ind-charthint');
  let png = null;
  try { if (auInd.chart) png = auInd.chart.getDataURL({ type: 'png', pixelRatio: 2, backgroundColor: '#FFFFFF' }); } catch (e) { }
  return { kpis, chartPng: png, title: tt ? strip(tt.textContent) : '', hint: th ? strip(th.textContent) : '' };
}
if (typeof module !== 'undefined' && module.exports) module.exports = { AUIND_STATE_KEY };

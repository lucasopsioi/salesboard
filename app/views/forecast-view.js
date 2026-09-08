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
  nHist: 6,                 // 左侧显示多少期历史实际值（辅助判断）
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
function fcDos(v) { return (v == null || !isFinite(v)) ? '—' : String(Math.round(v)); }   // 用户 2026-09-07：DOS 后面不要写「天」

/* 期次标签必须和引擎的桶标签**完全同格式**，否则历史与推演接不上：
     月 2026-06 / 周 2026-W25 / 日 2026-06-15（已实测确认；注意 sosim-core.bucketOf 的月是 202606，不能用）。
   推演从**数据截止日之后**开始，不是从「今天」——用户 2026-09-07 指出 W+1/W+2 这种相对标签没法用，
   而且数据截止在 2026-06-15 时，起点就该是它之后的那一期。 */
function fcIsoWeekLabel(d) {
  const dd = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = dd.getUTCDay() || 7; dd.setUTCDate(dd.getUTCDate() + 4 - day);      // 挪到本周周四
  const ys = new Date(Date.UTC(dd.getUTCFullYear(), 0, 1));
  const wk = Math.ceil((((dd - ys) / 86400000) + 1) / 7);
  return dd.getUTCFullYear() + '-W' + String(wk).padStart(2, '0');
}
function fcYmd(d) { return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0') + '-' + String(d.getUTCDate()).padStart(2, '0'); }
function fcParseYmd(ymd) {
  const m = String(ymd || '').match(/^(\d{4})-?(\d{2})-?(\d{2})$/);
  return m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])) : null;
}
/* 从数据截止日往后生成 n 期真实标签 */
function fcForecastPeriods(gran, n, cutoffYmd) {
  const base = fcParseYmd(cutoffYmd) || new Date();
  const out = [];
  for (let i = 1; i <= n; i++) {
    if (gran === 'day') {
      const d = new Date(base.getTime() + i * 86400000);
      out.push({ label: fcYmd(d), days: 1, hist: false });
    } else if (gran === 'week') {
      const d = new Date(base.getTime() + i * 7 * 86400000);
      out.push({ label: fcIsoWeekLabel(d), days: 7, hist: false });
    } else {
      const d = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + i, 1));
      const dim = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
      out.push({ label: d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0'), days: dim, hist: false });
    }
  }
  return out;
}
function fcPeriodDaysOf(gran, label) {
  if (gran === 'day') return 1;
  if (gran === 'week') return 7;
  const m = String(label).match(/^(\d{4})-(\d{2})$/);
  return m ? new Date(Date.UTC(+m[1], +m[2], 0)).getUTCDate() : 30;
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
    // 历史三件套：按当前粒度取 SI / SO / INV（桶标签由引擎给，保证和推演期同格式）
    const q = (metric) => api.query({ metric: metric, gran: FC.gran, filters: filters, stackDim: 'model', from: from, to: to, limit: 400 });
    const [hSi, hSo, hInv] = await Promise.all([q('sellIn'), q('sellOut'), q('inv')]);
    // 产品×型号 的历史 SI（占比来源 + 树结构）
    const siMat = await api.agg({ measure: 'sellIn', filters: filters, cat: { field: 'product' }, legend: 'model' });
    // 近 28 天按天 SO（左列「近28天日销」，与 DOS 口径同源）
    const d28from = fcShiftDays(to, -27);
    const soDaily = await api.query({ metric: 'sellOut', gran: 'day', filters: filters, stackDim: 'model', from: d28from, to: to, limit: 400 });

    const allBuckets = (hSo && hSo.buckets) || [];
    const histBuckets = allBuckets.slice(-Math.max(0, FC.nHist));
    FC.histBuckets = histBuckets;
    FC.periods = histBuckets.map(b => ({ label: b, days: fcPeriodDaysOf(FC.gran, b), hist: true }))
      .concat(fcForecastPeriods(FC.gran, FC.nPeriods, to));
    FC.firstFcIdx = histBuckets.length;
    FC.cutoff = to;
    FC.rows = fcBuildRows(siMat, { hSi: hSi, hSo: hSo, hInv: hInv, buckets: histBuckets }, soDaily);
    FC.truncated = ((siMat && siMat.series) || []).length >= 20;
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

function fcSeriesOf(qres, model, buckets) {
  const d = (qres && qres.data && qres.data[model]) || null;
  return buckets.map(b => { if (!d) return null; const v = d[b]; return (v == null) ? null : +v; });
}

function fcBuildRows(siMat, hist, soDaily) {
  const cfgMap = fcConfigMap();
  const B = hist.buckets || [];
  const dailyByModel = {};
  const dBuckets = (soDaily && soDaily.buckets) || [];
  Object.keys((soDaily && soDaily.data) || {}).forEach(mk => {
    const series = dBuckets.map(b => { const v = soDaily.data[mk][b]; return (v == null) ? null : +v; });
    dailyByModel[mk] = ForecastCore.dailyRunRate(series, 28);
  });
  const rows = [];
  ((siMat && siMat.cats) || []).forEach(prod => {
    const perModel = fcMatBySeries(siMat, prod);
    const models = Object.keys(perModel).filter(m => (perModel[m] || 0) > 0);
    if (!models.length) return;
    const kids = models.map(m => {
      const si = fcSeriesOf(hist.hSi, m, B), so = fcSeriesOf(hist.hSo, m, B), iv = fcSeriesOf(hist.hInv, m, B);
      const rate = dailyByModel[m] == null ? null : dailyByModel[m];
      return {
        kind: 'model', key: prod + '||' + m, product: prod, model: m,
        config: cfgMap[String(m).trim()] || '—',
        daily: rate, weekly: ForecastCore.weeklyFromDaily(rate),
        histSi: perModel[m] || 0,
        // 历史实际：库存是快照（照搬，不重算）
        histRows: B.map((b, i) => ({ si: si[i], so: so[i], inv: iv[i], days: fcPeriodDaysOf(FC.gran, b) })),
      };
    });
    const anyRate = kids.some(k => k.daily != null);
    const pDaily = anyRate ? kids.reduce((a, k) => a + (k.daily || 0), 0) : null;
    rows.push({
      kind: 'product', key: prod, product: prod, model: '（全部型号）', config: '—',
      daily: pDaily, weekly: ForecastCore.weeklyFromDaily(pDaily),
      histSi: kids.reduce((a, k) => a + (k.histSi || 0), 0),
      kids: kids, expanded: false,
    });
  });
  rows.sort((a, b) => (b.daily || 0) - (a.daily || 0));
  return rows;
}
function fcFirstVal(mat, cat) { const d = (mat.data && mat.data[cat]) || {}; const k = Object.keys(d)[0]; return k ? d[k] : null; }

/* 计算：历史期照搬实际，推演期按分摊/手填。返回 {product:[...], byModel:{...}}，
   数组长度 = 全部期次（历史 + 推演），下标与 FC.periods 一一对应。 */
function fcComputeProduct(p) {
  const nH = FC.firstFcIdx || 0;
  const fcPeriods = FC.periods.slice(nH);
  const ed = FC.edits[p.key] || {};
  // 产品级推演输入：没手填就按平均周销折算到该期天数
  /* 不做任何预测（2026-09-07 用户：「谁让你预测未来的SI，我不需要你给我预测未来的SI和SO，
     我自己会拍这个数据，你只需要把我输入的数据拆到型号，或者国家就行了」）。
     没填的格子就是 0，库存原地不动；填了才动。本工具只负责：拆分 + 滚库存 + 算 DOS。 */
  const productPeriods = fcPeriods.map((pd, j) => {
    const i = nH + j;
    return {
      so: (ed[i] && ed[i].so != null) ? +ed[i].so : 0,
      si: (ed[i] && ed[i].si != null) ? +ed[i].si : 0,
      days: pd.days,
    };
  });
  const models = (p.kids || []).map(k => ({ key: k.key, histSi: k.histSi, histRows: k.histRows }));
  const r = ForecastCore.simulateProductWithHistory({ gran: FC.gran, productPeriods: productPeriods, models: models });
  // 型号手填优先：重跑该型号（历史不变）
  (p.kids || []).forEach(k => {
    const ke = FC.edits[k.key];
    if (!ke) return;
    const base = r.byModel[k.key].forecast;
    const periods = fcPeriods.map((pd, j) => {
      const i = nH + j;
      return { so: (ke[i] && ke[i].so != null) ? +ke[i].so : base[j].so, si: (ke[i] && ke[i].si != null) ? +ke[i].si : base[j].si, days: pd.days };
    });
    r.byModel[k.key] = ForecastCore.simulateWithHistory({ gran: FC.gran, histRows: k.histRows, periods: periods });
  });
  const byModel = {};
  (p.kids || []).forEach(k => { byModel[k.key] = r.byModel[k.key].all; });
  // 产品级 = 各型号逐期相加（SO/SI 可加、同期库存可加）；DOS 用合计库存 ÷ 合计日销重算，不平均
  const product = FC.periods.map((pd, i) => {
    let so = 0, si = 0, inv = 0, rate = 0, anyRate = false, anySi = false, anySo = false, anyInv = false;
    (p.kids || []).forEach(k => {
      const rr = byModel[k.key][i]; if (!rr) return;
      if (rr.si != null) { si += rr.si; anySi = true; }
      if (rr.so != null) { so += rr.so; anySo = true; }
      if (rr.inv != null) { inv += rr.inv; anyInv = true; }
      if (rr.rate != null) { rate += rr.rate; anyRate = true; }
    });
    const iv = anyInv ? inv : null;
    return { si: anySi ? si : null, so: anySo ? so : null, inv: iv, rate: anyRate ? rate : null,
      dos: ForecastCore.dosOf(iv, anyRate ? rate : null), hist: !!pd.hist };
  });
  return { byModel: byModel, product: product, shares: r.shares };
}

function fcRender() {
  const host = document.getElementById('view-forecast'); if (!host) return;
  const gseg = (id, cur, opts) => '<span class="rm-seg">' + opts.map(o => '<button data-' + id + '="' + o[0] + '" class="' + (cur === o[0] ? 'on' : '') + '">' + o[1] + '</button>').join('') + '</span>';
  const countries = fcCountryOpts();
  let h = '<div class="fc-wrap">'
    + '<div class="fc-tools">'
    + '<span class="fc-lab">视图</span>' + gseg('fcv', FC.view, [['product', '产品视图'], ['model', '型号视图'], ['country', '国家视图']])
    + '<span class="fc-lab">粒度</span>' + gseg('fcg', FC.gran, [['day', '按天'], ['week', '按周'], ['month', '按月']])
    + '<span class="fc-lab">历史</span><input id="fcH" type="number" min="0" max="24" value="' + FC.nHist + '" title="左侧显示多少期历史实际值" style="width:52px">'
    + '<span class="fc-lab">推演</span><input id="fcN" type="number" min="1" max="52" value="' + FC.nPeriods + '" style="width:52px">'
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

/* 表体：每个产品 4 行 —— SI / SO / INV / DOS，期次做列（用户 2026-09-07：
   「每个产品四行，一眼能看到 SISOINVDOS，输入 SI 或 SO 时能看到 INV 在变、DOS 也在变」）。
   左侧 5 列用 rowspan=4 跨这四行、保持冻结；第 6 列是指标名。
   SI/SO 可输入；INV/DOS 是算出来的，带 data-cell 便于原地刷新（不整表重渲，输入焦点不丢）。 */
const FC_ROWS = [['si', 'SI'], ['so', 'SO'], ['inv', 'INV'], ['dos', 'DOS']];

function fcCellId(key, i, metric) { return key + '@@' + i + '@@' + metric; }

function fcBlock(row, calc, isModel) {
  const nP = FC.periods.length;
  let h = '';
  FC_ROWS.forEach(([m, lab], ri) => {
    h += '<tr class="' + (isModel ? 'fc-model' : 'fc-prod') + ' fc-r-' + m + '" data-k="' + fcEsc(row.key) + '" data-m="' + m + '">';
    if (ri === 0) {
      h += '<td class="fz fz1" rowspan="4">' + (isModel ? '' : '<span class="fc-exp">' + (row.expanded ? '▾' : '▸') + '</span>') + fcEsc(isModel ? '' : row.product) + '</td>'
        + '<td class="fz fz2" rowspan="4">' + fcEsc(isModel ? row.model : '（全部型号）') + '</td>'
        + '<td class="fz fz3 dim" rowspan="4">' + fcEsc(row.config || '—') + '</td>'
        + '<td class="fz fz4 num" rowspan="4">' + fcNum(row.daily, 1) + '</td>'
        + '<td class="fz fz5 num" rowspan="4">' + fcNum(row.weekly, 0) + '</td>';
    }
    h += '<td class="fz fz6 met met-' + m + '">' + lab + '</td>';
    for (let i = 0; i < nP; i++) {
      const c = calc[i] || {};
      const isHist = !!(FC.periods[i] && FC.periods[i].hist);
      const cls = (isHist ? ' hist' : '') + (i === FC.firstFcIdx ? ' fcstart' : '');
      if (isHist) {
        // 历史列一律只读实际值（含 SI/SO）——实际发生的数不许在推演里被改掉
        const v = (m === 'dos') ? fcDos(c.dos) : fcNum(c[m]);
        h += '<td class="num' + cls + (m === 'dos' ? ' ' + fcDosCls(c.dos) : '') + '">' + v + '</td>';
      } else if (m === 'si' || m === 'so') {
        const ed = (FC.edits[row.key] || {})[i] || {};
        // 产品级手填会分摊到型号：型号行显示分摊结果；产品行没填就留空（待填一眼可见）
        const own = (ed[m] != null);
        const val = own ? ed[m] : (isModel && c[m] ? Math.round(c[m]) : '');
        h += '<td class="num' + cls + '"><input class="fc-in fc-' + m + (own ? ' own' : '') + '" data-k="' + fcEsc(row.key) + '" data-i="' + i + '" data-f="' + m + '" value="' + val + '" placeholder="—"></td>';
      } else if (m === 'inv') {
        h += '<td class="num inv' + cls + (c.inv != null && c.inv < 0 ? ' neg' : '') + '" id="' + fcEsc(fcCellId(row.key, i, 'inv')) + '">' + fcNum(c.inv) + '</td>';
      } else {
        h += '<td class="num' + cls + ' ' + fcDosCls(c.dos) + '" id="' + fcEsc(fcCellId(row.key, i, 'dos')) + '">' + fcDos(c.dos) + '</td>';
      }
    }
    h += '</tr>';
  });
  return h;
}

function fcTable() {
  const P = FC.periods;
  let h = '<div class="fc-scroll"><table class="fc-table"><thead><tr>'
    + '<th class="fz fz1">产品名</th><th class="fz fz2">产品型号</th><th class="fz fz3">产品配置</th>'
    + '<th class="fz fz4 num">近28天日销</th><th class="fz fz5 num">平均周销</th><th class="fz fz6">指标</th>';
  P.forEach((p, i) => {
    const first = (i === FC.firstFcIdx);
    h += '<th class="num per' + (p.hist ? ' hist' : '') + (first ? ' fcstart' : '') + '">' + fcEsc(p.label) + (p.hist ? '<span class="tag">实际</span>' : '') + '</th>';
  });
  h += '</tr></thead><tbody>';
  FC.rows.forEach(p => {
    const calc = fcComputeProduct(p);
    h += fcBlock(p, calc.product, false);
    if (p.expanded) (p.kids || []).forEach(k => { h += fcBlock(k, calc.byModel[k.key] || [], true); });
  });
  h += '</tbody></table></div>';
  return h;
}
function fcDosCls(d) { if (d == null) return 'dim'; if (d > 120) return 'dos-hi'; if (d < 14) return 'dos-lo'; return ''; }

/* 原地刷新一个产品块（产品 4 行 + 其型号 4 行）的 INV / DOS 单元格。
   只改文本、不重建 DOM —— 这样一边打字一边能看到 INV/DOS 变，输入框焦点不会丢。 */
function fcRefreshProduct(p) {
  const calc = fcComputeProduct(p);
  const put = (key, rows) => {
    rows.forEach((c, i) => {
      const iv = document.getElementById(fcCellId(key, i, 'inv'));
      if (iv) { iv.textContent = fcNum(c.inv); iv.classList.toggle('neg', c.inv != null && c.inv < 0); }
      const dv = document.getElementById(fcCellId(key, i, 'dos'));
      if (dv) { dv.textContent = fcDos(c.dos); dv.className = 'num ' + fcDosCls(c.dos); }
    });
  };
  put(p.key, calc.product);
  (p.kids || []).forEach(k => {
    put(k.key, calc.byModel[k.key] || []);
    // 产品级 SO 改动会重新分摊到型号 → 型号的 SI/SO 输入框也要跟着更新（除非用户手填过）
    (calc.byModel[k.key] || []).forEach((c, i) => {
      ['si', 'so'].forEach(f => {
        const ke = (FC.edits[k.key] || {})[i] || {};
        if (ke[f] != null) return;                       // 手填优先，不覆盖
        const inp = document.querySelector('input.fc-in[data-k="' + CSS.escape(k.key) + '"][data-i="' + i + '"][data-f="' + f + '"]');
        if (inp && document.activeElement !== inp) inp.value = Math.round(c[f] || 0);
      });
    });
  });
}

function fcOwnerOf(key) {
  const p = FC.rows.find(x => x.key === key);
  if (p) return p;
  return FC.rows.find(x => (x.kids || []).some(k => k.key === key)) || null;
}

function fcBind() {
  const host = document.getElementById('view-forecast'); if (!host) return;
  host.querySelectorAll('[data-fcv]').forEach(b => { b.onclick = () => { FC.view = b.dataset.fcv; fcRender(); }; });
  host.querySelectorAll('[data-fcg]').forEach(b => { b.onclick = () => { FC.gran = b.dataset.fcg; FC.edits = {}; fcLoad(); }; });
  const n = host.querySelector('#fcN'); if (n) n.onchange = () => {
    FC.nPeriods = Math.max(1, Math.min(52, +n.value || 12));
    FC.periods = (FC.histBuckets || []).map(b2 => ({ label: b2, days: fcPeriodDaysOf(FC.gran, b2), hist: true }))
      .concat(fcForecastPeriods(FC.gran, FC.nPeriods, FC.cutoff));
    fcRender();
  };
  const hh = host.querySelector('#fcH'); if (hh) hh.onchange = () => { FC.nHist = Math.max(0, Math.min(24, +hh.value || 0)); fcLoad(); };
  const c = host.querySelector('#fcCountry'); if (c) c.onchange = () => { FC.country = c.value; fcLoad(); };
  const rl = host.querySelector('#fcReload'); if (rl) rl.onclick = fcLoad;
  const cl = host.querySelector('#fcClear'); if (cl) cl.onclick = () => { FC.edits = {}; fcRender(); };
  // 展开/收起：点产品名那一格
  host.querySelectorAll('tr.fc-prod td.fz1').forEach(td => {
    td.onclick = () => { const k = td.parentNode.dataset.k; const p = FC.rows.find(x => x.key === k); if (p) { p.expanded = !p.expanded; fcRender(); } };
  });
  // 输入：input 事件即时算（边打边看），blur/change 时再整表重渲一次让分摊完全落定
  host.querySelectorAll('input.fc-in').forEach(inp => {
    const apply = () => {
      const k = inp.dataset.k, i = +inp.dataset.i, fld = inp.dataset.f;
      const v = inp.value.trim();
      FC.edits[k] = FC.edits[k] || {}; FC.edits[k][i] = FC.edits[k][i] || {};
      if (v === '') delete FC.edits[k][i][fld]; else FC.edits[k][i][fld] = Math.max(0, Math.round(+v || 0));
      const owner = fcOwnerOf(k);
      if (owner) fcRefreshProduct(owner);
    };
    inp.addEventListener('input', apply);
    inp.addEventListener('change', apply);
  });
}

function renderForecast() {
  if (!window.ForecastCore) { const h = document.getElementById('view-forecast'); if (h) h.innerHTML = '<div class="fc-empty">推演内核未加载</div>'; return; }
  if (!FC.loaded && !FC.loading) fcLoad(); else fcRender();
}

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
  line: '', series: '',      // 产品线 / 产品系列筛选（2026-09-10 用户：没法选产品线，就没法圈定要改哪些产品）
  opts: { line: [], series: [], country: [] },
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
/* 某一期的最后一天（YYYY-MM-DD）。用来判断「数据截止日落在这期中间」——
   那这期就还没过完，不能当作历史锁死，得让用户拍数（2026-09-10 用户：
   「W36 是 0，现在是 W37，W36 的数据就没法编辑，非常奇怪」）。 */
function fcBucketEndYmd(gran, label) {
  if (gran === 'day') return String(label);
  if (gran === 'week') {
    const m = String(label).match(/^(\d{4})-W(\d{2})$/); if (!m) return null;
    const y = +m[1], w = +m[2];
    const jan4 = new Date(Date.UTC(y, 0, 4)); const dow = jan4.getUTCDay() || 7;
    const mon = new Date(jan4.getTime() - (dow - 1) * 86400000 + (w - 1) * 7 * 86400000);
    return fcYmd(new Date(mon.getTime() + 6 * 86400000));
  }
  const m = String(label).match(/^(\d{4})-(\d{2})$/); if (!m) return null;
  return fcYmd(new Date(Date.UTC(+m[1], +m[2], 0)));
}
/* 历史期 + （进行中的期）+ 推演期 拼成 FC.periods。改期数/换粒度都走这里，别各写一份。 */
function fcRebuildPeriods() {
  const hist = (FC.histBuckets || []).map(b => ({ label: b, days: fcPeriodDaysOf(FC.gran, b), hist: true }));
  const cur = FC.partial ? [{ label: FC.partial, days: fcPeriodDaysOf(FC.gran, FC.partial), hist: false, partial: true }] : [];
  FC.periods = hist.concat(cur).concat(fcForecastPeriods(FC.gran, FC.nPeriods, FC.cutoff));
  FC.firstFcIdx = hist.length;
}
function fcPeriodDaysOf(gran, label) {
  if (gran === 'day') return 1;
  if (gran === 'week') return 7;
  const m = String(label).match(/^(\d{4})-(\d{2})$/);
  return m ? new Date(Date.UTC(+m[1], +m[2], 0)).getUTCDate() : 30;
}

function fcFilters() {
  const f = {};
  if (FC.line) f.line = [FC.line];
  if (FC.series) f.series = [FC.series];
  if (FC.country) f.country = [FC.country];
  return f;
}
/* 筛选下拉的取值从引擎拿（api.options），并按已选的上级级联：选了产品线，系列/国家只列该线下有的。
   以前的 fcCountryOpts 读 state.filterOpts —— 那个字段根本没人赋值，下拉永远是空的。 */
async function fcLoadOpts() {
  const o = { line: [], series: [], country: [] };
  try {
    const base = {};
    o.line = await api.options('line', base);
    const f1 = FC.line ? { line: [FC.line] } : {};
    o.series = await api.options('series', f1);
    const f2 = Object.assign({}, f1, FC.series ? { series: [FC.series] } : {});
    o.country = await api.options('country', f2);
  } catch (e) {}
  ['line', 'series', 'country'].forEach(k => { o[k] = (o[k] || []).map(String).slice(0, 300); });
  // 已选值不在新列表里（比如换了产品线）→ 自动清掉，别带着一个筛不出东西的条件去取数
  if (FC.series && o.series.indexOf(FC.series) < 0) FC.series = '';
  if (FC.country && o.country.indexOf(FC.country) < 0) FC.country = '';
  FC.opts = o;
}

/* 取数：一次拿到「产品×型号」的历史 SI（既是树结构也是占比来源）、
   近28天按天 SO（算日销）、以及各型号期初库存（快照）。 */
async function fcLoad() {
  if (FC.loading) return;
  FC.loading = true; FC.err = ''; fcRender();
  try {
    await fcLoadOpts();
    const filters = fcFilters();
    const to = state.to, from = state.from;
    /* 子维度：产品视图/型号视图按型号拆，国家视图按国家拆。
       三个视图共用同一套「产品行填数 → 按历史 SI 占比分摊到子行」的机制，只是子行换了维度。 */
    const kid = (FC.view === 'country') ? 'country' : 'model';
    // 历史三件套：按当前粒度取 SI / SO / INV（桶标签由引擎给，保证和推演期同格式）
    const q = (metric) => api.query({ metric: metric, gran: FC.gran, filters: filters, stackDim: kid, from: from, to: to, limit: 400 });
    const [hSi, hSo, hInv] = await Promise.all([q('sellIn'), q('sellOut'), q('inv')]);
    // 产品×子维度 的历史 SI（占比来源 + 树结构）
    const siMat = await api.agg({ measure: 'sellIn', filters: filters, cat: { field: 'product' }, legend: kid });
    // 近 28 天按天 SO（左列「近28天日销」，与 DOS 口径同源）
    const d28from = fcShiftDays(to, -27);
    const soDaily = await api.query({ metric: 'sellOut', gran: 'day', filters: filters, stackDim: kid, from: d28from, to: to, limit: 400 });

    const allBuckets = (hSo && hSo.buckets) || [];
    let histBuckets = allBuckets.slice(-Math.max(0, FC.nHist));
    /* 数据截止日落在最后一期中间 → 这期还没过完，摘出来当「进行中」：可编辑、不当历史锁死。
       库存从它前一期（最后一个完整期）的实际值起滚；它自己的实际 SI/SO 只当占位提示，不算数——
       不填就是「未填」，不会把半周的量当整周去算日销（缺数不补零）。 */
    let partial = null;
    if (histBuckets.length) {
      const last = histBuckets[histBuckets.length - 1];
      const end = fcBucketEndYmd(FC.gran, last);
      if (end && String(to) < end) { partial = last; histBuckets = histBuckets.slice(0, -1); }
    }
    FC.histBuckets = histBuckets; FC.partial = partial; FC.cutoff = to;
    fcRebuildPeriods();
    FC.rows = fcBuildRows(siMat, { hSi: hSi, hSo: hSo, hInv: hInv, buckets: histBuckets, partial: partial }, soDaily, kid);
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

function fcBuildRows(siMat, hist, soDaily, kid) {
  const cfgMap = fcConfigMap();
  const B = hist.buckets || [];
  const P = hist.partial ? [hist.partial] : [];
  const paOf = m => P.length ? { si: fcSeriesOf(hist.hSi, m, P)[0], so: fcSeriesOf(hist.hSo, m, P)[0] } : null;
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
        config: kid === 'model' ? (cfgMap[String(m).trim()] || '—') : '—',
        daily: rate, weekly: ForecastCore.weeklyFromDaily(rate),
        histSi: perModel[m] || 0,
        // 历史实际：库存是快照（照搬，不重算）
        histRows: B.map((b, i) => ({ si: si[i], so: so[i], inv: iv[i], days: fcPeriodDaysOf(FC.gran, b) })),
        partial: paOf(m),                                  // 进行中那期到目前为止的实际值（只做占位提示）
      };
    });
    const anyRate = kids.some(k => k.daily != null);
    const pDaily = anyRate ? kids.reduce((a, k) => a + (k.daily || 0), 0) : null;
    const sumPa = f => { let t = 0, any = false; kids.forEach(k => { const v = k.partial && k.partial[f]; if (v != null) { t += v; any = true; } }); return any ? t : null; };
    rows.push({
      kind: 'product', key: prod, product: prod, model: kid === 'country' ? '（全部国家）' : '（全部型号）', config: '—',
      daily: pDaily, weekly: ForecastCore.weeklyFromDaily(pDaily),
      histSi: kids.reduce((a, k) => a + (k.histSi || 0), 0),
      kids: kids, expanded: false,
      partial: P.length ? { si: sumPa('si'), so: sumPa('so') } : null,
    });
  });
  rows.sort((a, b) => (b.daily || 0) - (a.daily || 0));
  /* 型号视图：把每个型号拍平成一条顶层行（它自己是自己唯一的子行，分摊 100%）。
     和产品视图共用一套计算，只是不再按产品聚合。 */
  if (FC.view === 'model') {
    const flat = [];
    rows.forEach(p => (p.kids || []).forEach(k => flat.push({
      kind: 'product', key: 'M::' + k.key, product: k.model, model: k.product, config: k.config,
      daily: k.daily, weekly: k.weekly, histSi: k.histSi, kids: [k], expanded: false, noKids: true, partial: k.partial,
    })));
    flat.sort((a, b) => (b.daily || 0) - (a.daily || 0));
    return flat;
  }
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
    /* 未填传 null（不是 0）：库存滚动里 null 按 0 处理（库存原地不动），
       但近28天日销的窗口会跳过它——未填 ≠ 卖 0 台。传 0 会把 DOS 全线打成「—」。 */
    return {
      so: (ed[i] && ed[i].so != null) ? +ed[i].so : null,
      si: (ed[i] && ed[i].si != null) ? +ed[i].si : null,
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
      // 型号没手填就沿用分摊结果；分摊结果本身可能是「没填」，要原样传下去
      return {
        so: (ke[i] && ke[i].so != null) ? +ke[i].so : (base[j].soGiven === false ? null : base[j].so),
        si: (ke[i] && ke[i].si != null) ? +ke[i].si : (base[j].siGiven === false ? null : base[j].si),
        days: pd.days,
      };
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

/* ============================================================
   以下是「表格层」：列宽 / 冻结 / Excel 式选区与编辑 / 统计条
   （2026-09-07 用户：「列宽为什么都设置不了」「冻结和取消冻结怎么没有」
     「双击编辑单元格，单击选中，选中输入数据就能直接编辑，要有求和/计数/平均」）

   两个关键设计决定，别退回去：
   1) **不再给每个可编辑格塞一个 <input>**。一屏可能有上千个格子，上千个 input 又慢又难管
      （旧实现就是这样，还得靠「原地刷新」绕开焦点丢失）。改成：格子是纯文本，
      全表共用**一个浮动编辑框**，双击/敲键时才盖到当前格上——和 Excel 一样。
   2) **left 偏移由列宽累加算出**（GridCore.leftOffsets），不写死像素。
      旧实现写死 0/150/280/370/460/550，所以列宽一改整排冻结列就叠在一起。
   ============================================================ */

/* 左侧固定列的定义（顺序即列序）。宽度是默认值，用户拖过之后以 localStorage 为准。 */
const FC_FZ = [
  { key: 'fz1', label: '产品名', w: 168 },
  { key: 'fz2', label: '产品型号', w: 138 },
  { key: 'fz3', label: '产品配置', w: 92 },
  { key: 'fz4', label: '近28天日销', w: 92, num: true },
  { key: 'fz5', label: '平均周销', w: 86, num: true },
  { key: 'fz6', label: '指标', w: 54 },
];
const FC_WKEY = 'sb.forecast.cols.v1';

FC.wFz = FC_FZ.map(c => c.w);
FC.wPer = 86;                 // 期次列统一宽度（同质列，拖任一列 = 全部一起变）
FC.freeze = 6;                // 冻结前 N 列；0 = 不冻结
FC.sel = { a: { r: 0, c: 0 }, f: { r: 0, c: 0 } };
FC.editing = null;
FC.grid = [];                 // 网格行描述：[{key, metric, isModel}]，下标 = data-r

function fcColsLoad() {
  if (FC._colsLoaded) return; FC._colsLoaded = true;
  try {
    const o = JSON.parse(localStorage.getItem(FC_WKEY) || 'null');
    if (!o) return;
    if (Array.isArray(o.fz) && o.fz.length === FC_FZ.length) FC.wFz = o.fz.map(w => GridCore.clampWidth(w, 44, 420));
    if (o.per) FC.wPer = GridCore.clampWidth(o.per, 48, 240);
    if (o.freeze != null) FC.freeze = Math.max(0, Math.min(FC_FZ.length, +o.freeze || 0));
  } catch (e) {}
}
function fcColsSave() {
  try { localStorage.setItem(FC_WKEY, JSON.stringify({ fz: FC.wFz, per: FC.wPer, freeze: FC.freeze })); } catch (e) {}
}
function fcFrozenWidth() {
  let w = 0; for (let i = 0; i < FC.freeze && i < FC.wFz.length; i++) w += FC.wFz[i];
  return w;
}
/* 把列宽写进 <col>，把冻结偏移写成 CSS 变量。
   thead 永远竖向 sticky；横向冻结只靠 left —— left:auto 就等于「不冻结」，
   这样取消冻结时表头不会连带失去顶部吸附。 */
function fcApplyCols() {
  const t = document.querySelector('#view-forecast table.fc-table'); if (!t) return;
  const cols = t.querySelectorAll('colgroup col');
  FC.wFz.forEach((w, i) => { if (cols[i]) cols[i].style.width = w + 'px'; });
  for (let i = FC_FZ.length; i < cols.length; i++) cols[i].style.width = FC.wPer + 'px';
  const offs = GridCore.leftOffsets(FC.wFz, FC.freeze);
  offs.forEach((L, i) => t.style.setProperty('--l' + (i + 1), L == null ? 'auto' : L + 'px'));
  t.classList.toggle('nofz', FC.freeze === 0);
  // table-layout:fixed 下必须显式给总宽，否则表会被容器压扁、列宽形同虚设
  t.style.width = (FC.wFz.reduce((a, b) => a + b, 0) + FC.wPer * FC.periods.length) + 'px';
}
/* 自适应列宽：格子是 overflow:hidden，所以 scrollWidth 就是「撑开需要多宽」。
   期次列是同一个宽度，所以要取所有期次格的最大值。 */
function fcAutoFit(ci) {
  const host = document.getElementById('view-forecast'); if (!host) return;
  const isPer = ci >= FC_FZ.length;
  const sel = isPer ? '[data-col]' : '[data-col="' + ci + '"]';
  let max = 0, n = 0;
  host.querySelectorAll('#view-forecast .fc-table ' + sel).forEach(el => {
    if (isPer && +el.dataset.col < FC_FZ.length) return;
    if (n++ > 4000) return;                       // 超大表只量前 4000 格，够准且不卡
    max = Math.max(max, el.scrollWidth);
  });
  if (!max) return;
  if (isPer) FC.wPer = GridCore.clampWidth(max + 6, 48, 240);
  else FC.wFz[ci] = GridCore.clampWidth(max + 6, 44, 420);
  fcApplyCols(); fcColsSave();
}
function fcAutoFitAll() { for (let i = 0; i < FC_FZ.length; i++) fcAutoFit(i); fcAutoFit(FC_FZ.length); }
function fcResetCols() { FC.wFz = FC_FZ.map(c => c.w); FC.wPer = 86; fcApplyCols(); fcColsSave(); }

/* ---------------- 渲染 ---------------- */
function fcRender() {
  const host = document.getElementById('view-forecast'); if (!host) return;
  fcColsLoad();
  const gseg = (id, cur, opts) => '<span class="rm-seg">' + opts.map(o => '<button data-' + id + '="' + o[0] + '"'
    + (o[2] ? ' title="' + fcEsc(o[2]) + '"' : '')
    + ' class="' + (cur === o[0] ? 'on' : '') + '">' + o[1] + '</button>').join('') + '</span>';
  const sel = (id, lab, cur, opts, title) => '<div class="fc-grp"><span class="fc-lab">' + lab + '</span><select id="' + id + '" title="' + fcEsc(title || '') + '"><option value="">全部</option>'
    + opts.map(c => '<option' + (c === cur ? ' selected' : '') + '>' + fcEsc(c) + '</option>').join('') + '</select></div>';
  const fzOpts = ['不冻结'].concat(FC_FZ.map((c, i) => '冻结到「' + c.label + '」'));
  let h = '<div class="fc-wrap">'
    + '<div class="fc-bar">'
    + '<div class="fc-grp"><span class="fc-lab">视图</span>' + gseg('fcv', FC.view, [['product', '产品', '产品行拍数 → 按历史 SI 占比分摊到型号'], ['model', '型号', '每个型号一条，直接拍数'], ['country', '国家', '产品行拍数 → 按历史 SI 占比分摊到国家']]) + '</div>'
    + '<div class="fc-grp"><span class="fc-lab">粒度</span>' + gseg('fcg', FC.gran, [['day', '天'], ['week', '周'], ['month', '月']]) + '</div>'
    + '<div class="fc-grp"><span class="fc-lab">历史</span><input id="fcH" type="number" min="0" max="24" value="' + FC.nHist + '" title="左侧显示多少期历史实际值">'
    + '<span class="fc-lab">推演</span><input id="fcN" type="number" min="1" max="52" value="' + FC.nPeriods + '" title="向后推演多少期"></div>'
    + sel('fcLine', '产品线', FC.line, FC.opts.line, '先圈定产品线，再看要改哪些产品的 SI/SO')
    + sel('fcSeries', '系列', FC.series, FC.opts.series, '按产品系列进一步缩小')
    + sel('fcCountry', '国家', FC.country, FC.opts.country, '只看某个国家')
    + '<div class="fc-grp"><span class="fc-lab">冻结</span><select id="fcFreeze" title="左侧固定不动的列数">'
    + fzOpts.map((t, i) => '<option value="' + i + '"' + (FC.freeze === i ? ' selected' : '') + '>' + t + '</option>').join('') + '</select></div>'
    + '<span class="fc-spacer"></span>'
    + '<button class="btn ghost" id="fcFit" title="按内容自动调整每列宽度">列宽自适应</button>'
    + '<button class="btn ghost" id="fcResetW" title="恢复默认列宽">重置列宽</button>'
    + '<button class="btn ghost" id="fcClear" title="清空所有手填的 SI/SO">清空推演</button>'
    + '<button class="btn" id="fcReload">重新取数</button>'
    + '</div>';
  if (FC.loading) h += '<div class="fc-empty">正在取数…</div>';
  else if (FC.err) h += '<div class="fc-empty">' + fcEsc(FC.err) + '</div>';
  else if (!FC.loaded) h += '<div class="fc-empty">点「重新取数」开始</div>';
  else {
    if (FC.truncated) h += '<div class="fc-warn">⚠ 型号数超过引擎单次返回上限（20），列表可能不全。请用国家/产品筛选缩小范围后再推演。</div>';
    h += '<div class="fc-grid" id="fcGrid" tabindex="0">' + fcTable()
      + '<input class="fc-editor" id="fcEditor" autocomplete="off" spellcheck="false">'
      + '<div class="fc-status"><span id="fcStat" class="fc-stat"></span><span id="fcNote" class="note"></span></div>'
      + '</div>';
    h += '<div class="fc-tip">'
      + '<span><b>单击</b>选中 · <b>双击/回车</b>编辑 · 选中直接<b>敲数字</b>即改</span>'
      + '<span><b>方向键</b>移动 · <b>Shift+方向键</b>选区 · <b>Tab</b>下一格</span>'
      + '<span><b>Ctrl+C / Ctrl+V</b> 与 Excel 互通 · <b>Delete</b> 清空</span>'
      + '<span><b>拖表头右缘</b>改列宽（双击=自适应）</span>'
      + '<span>产品行填 SO → 按历史 SI 占比分摊到型号；手填优先</span>'
      + '</div>';
  }
  h += '</div>';
  host.innerHTML = h;
  fcApplyCols();
  fcBind();
  if (FC.loaded && !FC.err) { fcClampSel(); fcPaintSel(); }
}

function fcCountryOpts() { return (FC.opts && FC.opts.country) || []; }

/* 表体：每个产品 4 行 —— SI / SO / INV / DOS，期次做列（用户 2026-09-07：
   「每个产品四行，一眼能看到 SISOINVDOS，输入 SI 或 SO 时能看到 INV 在变、DOS 也在变」）。
   左侧 6 列用 rowspan=4 跨这四行、保持冻结；第 6 列是指标名。
   期次格全部带 data-r/data-c（网格坐标）与 data-col（列序），
   可编辑的再带 data-ed —— 选区/统计/复制粘贴全靠这三个属性。 */
const FC_ROWS = [['si', 'SI'], ['so', 'SO'], ['inv', 'INV'], ['dos', 'DOS']];

function fcCellId(key, i, metric) { return key + '@@' + i + '@@' + metric; }
function fcDosCls(d) { if (d == null) return 'dim'; if (d > 120) return 'dos-hi'; if (d < 14) return 'dos-lo'; return ''; }
function fcSetDosCls(el, d) {
  el.classList.remove('dim', 'dos-hi', 'dos-lo');
  const c = fcDosCls(d); if (c) el.classList.add(c);   // 只动 DOS 相关类，别整个重写 className（会把选区/分界线类一起抹掉）
}

function fcBlock(row, calc, isModel, ctx) {
  const nP = FC.periods.length;
  const NF = FC_FZ.length;
  let h = '';
  FC_ROWS.forEach(([m, lab], ri) => {
    const r = ctx.r++;
    FC.grid.push({ key: row.key, metric: m, isModel: isModel });
    h += '<tr class="' + (isModel ? 'fc-model' : 'fc-prod') + ' fc-r-' + m + '" data-k="' + fcEsc(row.key) + '" data-m="' + m + '" data-r="' + r + '">';
    if (ri === 0) {
      const nm = fcEsc(isModel ? '' : row.product);
      const caret = isModel ? '<span class="fc-tree"></span>' : (row.noKids ? '<span class="fc-exp"></span>' : '<span class="fc-exp">' + (row.expanded ? '▾' : '▸') + '</span>');
      h += '<td class="fz fz1' + (row.noKids ? ' nokids' : '') + '" data-col="0" rowspan="4" title="' + fcEsc(isModel ? row.model : row.product) + '">'
        + caret + nm + '</td>'
        + '<td class="fz fz2" data-col="1" rowspan="4" title="' + fcEsc(isModel ? row.model : '') + '">' + fcEsc(isModel ? row.model : '（全部型号）') + '</td>'
        + '<td class="fz fz3 dim" data-col="2" rowspan="4">' + fcEsc(row.config || '—') + '</td>'
        + '<td class="fz fz4 num" data-col="3" rowspan="4">' + fcNum(row.daily, 1) + '</td>'
        + '<td class="fz fz5 num" data-col="4" rowspan="4">' + fcNum(row.weekly, 0) + '</td>';
    }
    h += '<td class="fz fz6 met met-' + m + '" data-col="5">' + lab + '</td>';
    for (let i = 0; i < nP; i++) {
      const c = calc[i] || {};
      const isHist = !!(FC.periods[i] && FC.periods[i].hist);
      const base = 'num' + (isHist ? ' hist' : '') + (i === FC.firstFcIdx ? ' fcstart' : '');
      const coord = ' data-r="' + r + '" data-c="' + i + '" data-col="' + (NF + i) + '"';
      const id = ' id="' + fcEsc(fcCellId(row.key, i, m)) + '"';
      if (m === 'inv') {
        h += '<td class="' + base + ' inv' + (c.inv != null && c.inv < 0 ? ' neg' : '') + '"' + coord + id + '>' + fcNum(c.inv) + '</td>';
      } else if (m === 'dos') {
        h += '<td class="' + base + ' ' + fcDosCls(c.dos) + '"' + coord + id + '>' + fcDos(c.dos) + '</td>';
      } else if (isHist) {
        // 历史列一律只读实际值（含 SI/SO）——实际发生的数不许在推演里被改掉
        h += '<td class="' + base + '"' + coord + id + '>' + fcNum(c[m]) + '</td>';
      } else {
        const ed = (FC.edits[row.key] || {})[i] || {};
        const own = (ed[m] != null);
        const val = own ? fcNum(ed[m]) : (isModel && c[m] ? fcNum(Math.round(c[m])) : '');
        // 进行中的那期：把「到目前为止的实际值」当占位提示（灰字），不填就不算数
        const pa = (FC.periods[i].partial && row.partial && row.partial[m] != null) ? fcNum(row.partial[m]) : '—';
        h += '<td class="' + base + ' ed' + (own ? ' own' : '') + (FC.periods[i].partial ? ' partial' : '') + '"' + coord + id + ' data-ed="1" data-ph="' + fcEsc(pa) + '">' + val + '</td>';
      }
    }
    h += '</tr>';
  });
  return h;
}

function fcTable() {
  const P = FC.periods;
  FC.grid = [];
  const ctx = { r: 0 };
  let h = '<div class="fc-scroll" id="fcScroll"><table class="fc-table"><colgroup>'
    + FC_FZ.map(() => '<col>').join('') + P.map(() => '<col>').join('')
    + '</colgroup><thead><tr>';
  FC_FZ.forEach((c, i) => {
    // 第 1/2 列的名字随视图变：产品视图=产品名/产品型号，型号视图=产品型号/所属产品，国家视图=产品名/国家
    const lab = (i === 0 && FC.view === 'model') ? '产品型号' : (i === 1 ? (FC.view === 'country' ? '国家' : (FC.view === 'model' ? '所属产品' : '产品型号')) : c.label);
    h += '<th class="fz ' + c.key + (c.num ? ' num' : '') + '" data-col="' + i + '">' + fcEsc(lab)
      + '<i class="fc-grip" data-col="' + i + '" title="拖动改列宽 · 双击自适应"></i></th>';
  });
  P.forEach((p, i) => {
    const first = (i === FC.firstFcIdx);
    h += '<th class="num per' + (p.hist ? ' hist' : '') + (first ? ' fcstart' : '') + '" data-col="' + (FC_FZ.length + i) + '">'
      + '<span class="lb">' + fcEsc(p.label) + '</span>'
      + '<span class="tag' + (p.partial ? ' cur' : '') + '">' + (p.hist ? '实际' : (p.partial ? '进行中·可改' : '推演')) + '</span>'
      + '<i class="fc-grip" data-col="' + (FC_FZ.length + i) + '" title="拖动改列宽（期次列同宽） · 双击自适应"></i></th>';
  });
  h += '</tr></thead><tbody>';
  FC.rows.forEach(p => {
    const calc = fcComputeProduct(p);
    h += fcBlock(p, calc.product, false, ctx);
    if (p.expanded) (p.kids || []).forEach(k => { h += fcBlock(k, calc.byModel[k.key] || [], true, ctx); });
  });
  h += '</tbody></table></div>';
  return h;
}

/* 原地刷新一个产品块（产品 4 行 + 其型号 4 行）的四个指标。
   只改文本、不重建 DOM —— 选区、滚动位置、正在编辑的框都不会被打断。 */
function fcRefreshProduct(p) {
  const calc = fcComputeProduct(p);
  const put = (key, rows, isModel) => {
    rows.forEach((c, i) => {
      const iv = document.getElementById(fcCellId(key, i, 'inv'));
      if (iv) { iv.textContent = fcNum(c.inv); iv.classList.toggle('neg', c.inv != null && c.inv < 0); }
      const dv = document.getElementById(fcCellId(key, i, 'dos'));
      if (dv) { dv.textContent = fcDos(c.dos); fcSetDosCls(dv, c.dos); }
      if (FC.periods[i] && FC.periods[i].hist) return;    // 历史列是实际值，不受推演影响
      const ed = (FC.edits[key] || {})[i] || {};
      ['si', 'so'].forEach(f => {
        const el = document.getElementById(fcCellId(key, i, f)); if (!el) return;
        const own = (ed[f] != null);
        el.textContent = own ? fcNum(ed[f]) : (isModel && c[f] ? fcNum(Math.round(c[f])) : '');
        el.classList.toggle('own', own);
      });
    });
  };
  put(p.key, calc.product, false);
  (p.kids || []).forEach(k => put(k.key, calc.byModel[k.key] || [], true));
}

function fcOwnerOf(key) {
  const p = FC.rows.find(x => x.key === key);
  if (p) return p;
  return FC.rows.find(x => (x.kids || []).some(k => k.key === key)) || null;
}

/* ---------------- 网格：选区 / 统计 / 编辑 / 剪贴板 ---------------- */
function fcBounds() { return { rows: FC.grid.length, cols: FC.periods.length }; }
function fcCellAt(r, c) { return document.querySelector('#view-forecast td[data-r="' + r + '"][data-c="' + c + '"]'); }
function fcClampSel() {
  const b = fcBounds();
  if (!b.rows || !b.cols) { FC.sel = { a: { r: 0, c: 0 }, f: { r: 0, c: 0 } }; return; }
  FC.sel.a = GridCore.clampPos(FC.sel.a, b);
  FC.sel.f = GridCore.clampPos(FC.sel.f, b);
}
function fcPaintSel() {
  const host = document.getElementById('view-forecast'); if (!host) return;
  host.querySelectorAll('td.sel').forEach(td => td.classList.remove('sel'));
  host.querySelectorAll('td.cur').forEach(td => td.classList.remove('cur'));
  const b = fcBounds(); if (!b.rows || !b.cols) { fcStatus(null); return; }
  const rg = GridCore.normRange(FC.sel.a, FC.sel.f);
  for (let r = rg.r0; r <= rg.r1; r++) {
    for (let c = rg.c0; c <= rg.c1; c++) { const td = fcCellAt(r, c); if (td) td.classList.add('sel'); }
  }
  const cur = fcCellAt(FC.sel.f.r, FC.sel.f.c); if (cur) cur.classList.add('cur');
  fcStatus(rg);
}
function fcSelValues(rg) {
  const out = [];
  for (let r = rg.r0; r <= rg.r1; r++) {
    const row = [];
    for (let c = rg.c0; c <= rg.c1; c++) { const td = fcCellAt(r, c); row.push(td ? td.textContent.trim() : ''); }
    out.push(row);
  }
  return out;
}
/* 统计条。口径闸在这里：
     · 选区跨多个指标 → 只给计数（SI 和 DOS 加在一起没有意义）
     · DOS 是比率 → 不给求和/平均（全项目铁律：率必须分子分母各自求和再相除）
     · 库存是时点快照 → 跨期不给求和（可以给平均库存，那是有意义的）
   宁可少给一个数，也不给一个错的数。 */
function fcStatus(rg) {
  const el = document.getElementById('fcStat'), note = document.getElementById('fcNote');
  if (!el) return;
  if (!rg) { el.innerHTML = ''; if (note) note.textContent = ''; return; }
  const mat = fcSelValues(rg);
  const flat = []; mat.forEach(row => row.forEach(v => flat.push(v)));
  const s = GridCore.statsOf(flat);
  const metrics = {};
  for (let r = rg.r0; r <= rg.r1; r++) { const g = FC.grid[r]; if (g) metrics[g.metric] = 1; }
  const mk = Object.keys(metrics);
  let sum = s.sum, avg = s.avg, why = '';
  if (mk.length > 1) { sum = null; avg = null; why = '选区跨 ' + mk.join('/') + ' 多个指标，合计无意义，只给计数'; }
  else if (mk[0] === 'dos') { sum = null; avg = null; why = 'DOS 是比率，不可相加/平均（要看整体请选 INV 与 SO 各自合计后再相除）'; }
  else if (mk[0] === 'inv' && rg.c1 > rg.c0) { sum = null; why = '库存是时点快照，不可跨期相加（平均库存有意义，已给）'; }
  const nR = rg.r1 - rg.r0 + 1, nC = rg.c1 - rg.c0 + 1;
  const pc = (k, v) => '<span class="pc"><span class="k">' + k + '</span><span class="v">' + v + '</span></span>';
  let html;
  if (nR === 1 && nC === 1) {
    // 单格：求和/平均/最大/最小都是同一个数，抄五遍是噪音
    const one = mat[0][0];
    html = pc('选中', '1 格') + pc(mk[0] ? mk[0].toUpperCase() : '值', one === '' ? '—' : one);
  } else {
    html = pc('选中', nR + '×' + nC) + pc('计数', String(s.count))
      + pc('求和', sum == null ? '—' : fcNum(sum))
      + pc('平均', avg == null ? '—' : fcNum(avg, 1))
      + pc('最小', s.min == null ? '—' : fcNum(s.min))
      + pc('最大', s.max == null ? '—' : fcNum(s.max));
  }
  el.innerHTML = html;
  if (note) note.textContent = why;
}

function fcSelect(r, c, extend) {
  const b = fcBounds(); const p = GridCore.clampPos({ r: r, c: c }, b);
  FC.sel.f = p; if (!extend) FC.sel.a = p;
  fcPaintSel();
}
/* 让当前格露出来：横向要躲开冻结列，纵向要躲开表头 */
function fcReveal() {
  const td = fcCellAt(FC.sel.f.r, FC.sel.f.c); const sc = document.getElementById('fcScroll');
  if (!td || !sc) return;
  const sr = sc.getBoundingClientRect(), cr = td.getBoundingClientRect();
  const fw = fcFrozenWidth(), hh = 34;
  if (cr.left < sr.left + fw) sc.scrollLeft -= (sr.left + fw - cr.left);
  else if (cr.right > sr.right) sc.scrollLeft += (cr.right - sr.right);
  if (cr.top < sr.top + hh) sc.scrollTop -= (sr.top + hh - cr.top);
  else if (cr.bottom > sr.bottom) sc.scrollTop += (cr.bottom - sr.bottom);
}

function fcPlaceEditor() {
  const ed = document.getElementById('fcEditor'), grid = document.getElementById('fcGrid');
  if (!ed || !grid || !FC.editing) return;
  const td = fcCellAt(FC.editing.r, FC.editing.c); if (!td) return;
  /* 编辑框挂在 #fcGrid（position:relative）下面，不在滚动容器 #fcScroll 里面，
     所以只需要「格子相对 grid 的可视位置」，**不能再加 scrollLeft/scrollTop**——
     2026-09-10 用户截图：表格往右滚了 4 列，编辑框就偏到 4 列之外去了。 */
  const gr = grid.getBoundingClientRect(), cr = td.getBoundingClientRect();
  ed.style.left = (cr.left - gr.left) + 'px';
  ed.style.top = (cr.top - gr.top) + 'px';
  ed.style.width = cr.width + 'px';
  ed.style.height = cr.height + 'px';
}
function fcBeginEdit(seed) {
  const b = fcBounds(); if (!b.rows) return;
  const r = FC.sel.f.r, c = FC.sel.f.c;
  const td = fcCellAt(r, c);
  if (!td || !td.dataset.ed) return;                    // 只读格（历史实际 / INV / DOS）不进编辑
  const ed = document.getElementById('fcEditor'); if (!ed) return;
  FC.editing = { r: r, c: c };
  fcReveal(); fcPlaceEditor();
  ed.value = (seed != null) ? seed : td.textContent.replace(/,/g, '').trim();
  ed.classList.add('on');
  ed.focus();
  if (seed == null) ed.select(); else { const n = ed.value.length; ed.setSelectionRange(n, n); }
}
function fcEndEdit() {
  const ed = document.getElementById('fcEditor');
  FC.editing = null;
  if (ed) { ed.classList.remove('on'); ed.value = ''; }
  const g = document.getElementById('fcGrid'); if (g) g.focus();
}
function fcCommitEdit(move) {
  if (!FC.editing) return;
  const ed = document.getElementById('fcEditor');
  const { r, c } = FC.editing;
  const okSet = fcSetCell(r, c, ed ? ed.value : '');
  fcEndEdit();
  if (okSet) fcApplyEdits([FC.grid[r] && FC.grid[r].key]);
  if (move) { const p = GridCore.movePos(FC.sel.f, move, fcBounds(), { wrap: move !== 'down' }); FC.sel.a = FC.sel.f = p; }
  fcPaintSel(); fcReveal();
}
/* 写一个格子。返回是否写成功（非法输入不写，也不清掉原值）。 */
function fcSetCell(r, c, raw) {
  const g = FC.grid[r]; if (!g) return false;
  const td = fcCellAt(r, c); if (!td || !td.dataset.ed) return false;
  const v = String(raw == null ? '' : raw).trim();
  FC.edits[g.key] = FC.edits[g.key] || {};
  FC.edits[g.key][c] = FC.edits[g.key][c] || {};
  if (v === '' || v === '—') { delete FC.edits[g.key][c][g.metric]; return true; }
  const n = GridCore.parseNum(v);
  if (n == null) return false;
  FC.edits[g.key][c][g.metric] = Math.max(0, Math.round(n));
  return true;
}
function fcApplyEdits(keys) {
  const owners = new Set();
  (keys || []).forEach(k => { const o = fcOwnerOf(k); if (o) owners.add(o); });
  owners.forEach(o => fcRefreshProduct(o));
}
function fcClearSel() {
  const rg = GridCore.normRange(FC.sel.a, FC.sel.f); const keys = [];
  for (let r = rg.r0; r <= rg.r1; r++) {
    for (let c = rg.c0; c <= rg.c1; c++) { if (fcSetCell(r, c, '')) keys.push(FC.grid[r].key); }
  }
  fcApplyEdits(keys); fcPaintSel();
}

/* ---------------- 事件 ---------------- */
function fcBindGrips(host) {
  host.querySelectorAll('.fc-grip').forEach(g => {
    g.addEventListener('mousedown', e => {
      e.preventDefault(); e.stopPropagation();
      const ci = +g.dataset.col, isPer = ci >= FC_FZ.length;
      const x0 = e.clientX, w0 = isPer ? FC.wPer : FC.wFz[ci];
      document.body.classList.add('fc-resizing');
      const mv = ev => {
        const w = GridCore.clampWidth(w0 + (ev.clientX - x0), isPer ? 48 : 44, isPer ? 240 : 420);
        if (isPer) FC.wPer = w; else FC.wFz[ci] = w;
        fcApplyCols(); if (FC.editing) fcPlaceEditor();
      };
      const up = () => {
        document.removeEventListener('mousemove', mv); document.removeEventListener('mouseup', up);
        document.body.classList.remove('fc-resizing'); fcColsSave();
      };
      document.addEventListener('mousemove', mv); document.addEventListener('mouseup', up);
    });
    g.addEventListener('dblclick', e => { e.preventDefault(); e.stopPropagation(); fcAutoFit(+g.dataset.col); });
  });
}

function fcBind() {
  const host = document.getElementById('view-forecast'); if (!host) return;
  host.querySelectorAll('[data-fcv]').forEach(b => { b.onclick = () => { if (FC.view === b.dataset.fcv) return; FC.view = b.dataset.fcv; FC.edits = {}; fcLoad(); }; });
  host.querySelectorAll('[data-fcg]').forEach(b => { b.onclick = () => { FC.gran = b.dataset.fcg; FC.edits = {}; fcLoad(); }; });
  const n = host.querySelector('#fcN'); if (n) n.onchange = () => {
    FC.nPeriods = Math.max(1, Math.min(52, +n.value || 12));
    fcRebuildPeriods(); fcRender();
  };
  const hh = host.querySelector('#fcH'); if (hh) hh.onchange = () => { FC.nHist = Math.max(0, Math.min(24, +hh.value || 0)); fcLoad(); };
  const c = host.querySelector('#fcCountry'); if (c) c.onchange = () => { FC.country = c.value; FC.edits = {}; fcLoad(); };
  const ln = host.querySelector('#fcLine'); if (ln) ln.onchange = () => { FC.line = ln.value; FC.series = ''; FC.edits = {}; fcLoad(); };
  const se = host.querySelector('#fcSeries'); if (se) se.onchange = () => { FC.series = se.value; FC.edits = {}; fcLoad(); };
  const fz = host.querySelector('#fcFreeze'); if (fz) fz.onchange = () => { FC.freeze = Math.max(0, Math.min(FC_FZ.length, +fz.value || 0)); fcApplyCols(); fcColsSave(); };
  const rl = host.querySelector('#fcReload'); if (rl) rl.onclick = fcLoad;
  const cl = host.querySelector('#fcClear'); if (cl) cl.onclick = () => { FC.edits = {}; fcRender(); };
  const ft = host.querySelector('#fcFit'); if (ft) ft.onclick = fcAutoFitAll;
  const rw = host.querySelector('#fcResetW'); if (rw) rw.onclick = fcResetCols;
  fcBindGrips(host);

  // 展开/收起：点产品名那一格（它不在网格坐标里，不会和选区打架）
  host.querySelectorAll('tr.fc-prod td.fz1:not(.nokids)').forEach(td => {
    td.onclick = () => { const k = td.parentNode.dataset.k; const p = FC.rows.find(x => x.key === k); if (p) { p.expanded = !p.expanded; fcRender(); } };
  });

  const grid = host.querySelector('#fcGrid'); if (!grid) return;
  const sc = host.querySelector('#fcScroll');
  if (sc) sc.addEventListener('scroll', () => { if (FC.editing) fcPlaceEditor(); });

  // —— 鼠标：单击选中、按住拖出选区、双击进编辑 ——
  let dragging = false;
  grid.addEventListener('mousedown', e => {
    const td = e.target.closest ? e.target.closest('td[data-r]') : null;
    if (!td) return;
    if (FC.editing) fcCommitEdit(null);
    grid.focus();
    fcSelect(+td.dataset.r, +td.dataset.c, e.shiftKey);
    dragging = true;
  });
  grid.addEventListener('mouseover', e => {
    if (!dragging) return;
    const td = e.target.closest ? e.target.closest('td[data-r]') : null;
    if (td) fcSelect(+td.dataset.r, +td.dataset.c, true);
  });
  document.addEventListener('mouseup', () => { dragging = false; });
  grid.addEventListener('dblclick', e => {
    const td = e.target.closest ? e.target.closest('td[data-r]') : null;
    if (!td) return;
    fcSelect(+td.dataset.r, +td.dataset.c, false);
    fcBeginEdit();
  });

  // —— 键盘 ——
  grid.addEventListener('keydown', e => {
    if (FC.editing) return;                       // 编辑中由编辑框自己处理
    const b = fcBounds(); if (!b.rows) return;
    const ctrl = e.ctrlKey || e.metaKey, shift = e.shiftKey;
    const go = dir => {
      const p = GridCore.movePos(FC.sel.f, dir, b, {});
      FC.sel.f = p; if (!shift) FC.sel.a = p;
      fcPaintSel(); fcReveal(); e.preventDefault();
    };
    switch (e.key) {
      case 'ArrowUp': return go(ctrl ? 'top' : 'up');
      case 'ArrowDown': return go(ctrl ? 'bottom' : 'down');
      case 'ArrowLeft': return go(ctrl ? 'home' : 'left');
      case 'ArrowRight': return go(ctrl ? 'end' : 'right');
      case 'Home': return go(ctrl ? 'top' : 'home');
      case 'End': return go(ctrl ? 'bottom' : 'end');
      case 'Tab': {
        const p = GridCore.movePos(FC.sel.f, shift ? 'left' : 'right', b, { wrap: true });
        FC.sel.a = FC.sel.f = p; fcPaintSel(); fcReveal(); e.preventDefault(); return;
      }
      case 'Enter': case 'F2': fcBeginEdit(); e.preventDefault(); return;
      case 'Escape': FC.sel.a = FC.sel.f; fcPaintSel(); e.preventDefault(); return;
      case 'Delete': case 'Backspace': fcClearSel(); e.preventDefault(); return;
      default: break;
    }
    if (ctrl && (e.key === 'a' || e.key === 'A')) {
      FC.sel.a = { r: 0, c: 0 }; FC.sel.f = { r: b.rows - 1, c: b.cols - 1 };
      fcPaintSel(); e.preventDefault(); return;
    }
    // 选中状态下直接敲数字 = 开始编辑并以该字符打头（Excel 行为）。
    // 只放行数字/负号/小数点：这是个数值网格，敲字母只可能是误触。
    if (!ctrl && !e.altKey && e.key.length === 1 && /[-0-9.]/.test(e.key)) { fcBeginEdit(e.key); e.preventDefault(); }
  });

  // —— 剪贴板：和 Excel 互通（TSV）——
  grid.addEventListener('copy', e => {
    if (FC.editing) return;
    const rg = GridCore.normRange(FC.sel.a, FC.sel.f);
    const tsv = GridCore.toTsv(fcSelValues(rg).map(row => row.map(v => v.replace(/,/g, ''))));
    e.clipboardData.setData('text/plain', tsv); e.preventDefault();
  });
  grid.addEventListener('paste', e => {
    if (FC.editing) return;
    const txt = (e.clipboardData || window.clipboardData).getData('text');
    const mat = GridCore.parseTsv(txt);
    if (!mat.length) return;
    const hits = GridCore.spreadPaste(mat, FC.sel.f, fcBounds());
    const keys = []; let wrote = 0, skipped = 0;
    hits.forEach(h => { if (fcSetCell(h.r, h.c, h.value)) { keys.push(FC.grid[h.r].key); wrote++; } else skipped++; });
    fcApplyEdits(keys);
    const last = hits.length ? hits[hits.length - 1] : null;
    if (last) { FC.sel.a = FC.sel.f; FC.sel.f = GridCore.clampPos({ r: last.r, c: last.c }, fcBounds()); }
    fcPaintSel();
    // 落到只读格（历史实际 / INV / DOS）的那部分会被拒绝，得说出来，不能默默吞掉。
    // 必须写在 fcPaintSel 之后：它会顺带重绘统计条，把这条提示覆盖掉。
    const note = document.getElementById('fcNote');
    if (note && skipped) note.textContent = '粘贴：写入 ' + wrote + ' 格，跳过 ' + skipped + ' 格（只读或非数字）';
    e.preventDefault();
  });

  // —— 编辑框 ——
  const ed = host.querySelector('#fcEditor');
  if (ed) {
    ed.addEventListener('keydown', e => {
      if (e.key === 'Enter') { fcCommitEdit('down'); e.preventDefault(); }
      else if (e.key === 'Tab') { fcCommitEdit(e.shiftKey ? 'left' : 'right'); e.preventDefault(); }
      else if (e.key === 'Escape') { fcEndEdit(); fcPaintSel(); e.preventDefault(); }
      e.stopPropagation();
    });
    ed.addEventListener('blur', () => { if (FC.editing) fcCommitEdit(null); });
  }
}

function renderForecast() {
  if (!window.ForecastCore || !window.GridCore) {
    const h = document.getElementById('view-forecast');
    if (h) h.innerHTML = '<div class="fc-empty">推演内核未加载</div>';
    return;
  }
  if (!FC.loaded && !FC.loading) fcLoad(); else fcRender();
}

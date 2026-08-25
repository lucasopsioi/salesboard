'use strict';
/* ============================================================
   周报 v3 · 新品进展 + 新品信息（用户 W34 邮件末两段的完整重做）

   新品首销达成表（每国一行）：
     国家 | 首销日期 | 线上首销 | 线下首销 | 时间进度 | 实际达成(台) | 首销目标 | 达成率 | 同比上代
   口径（用户 2026-08-21 拍板）：
     · 首销期 = 固定窗口 N 天（默认 30，可改）
     · 同比上代 = 同一国家、上代从**它自己的真实首销日**起、对齐同样天数的累计 SO
     · 首销日先自动识别（weekly-chips.detectFirstSale，剔除上市前零星样机激活），
       用户在「首销设计器」里对每个国家**拖竖线**微调 —— 手调值永远优先于自动值。
   新品信息：从路标搜罗 —— 产品主数据（认证型号/内部编码/样机编码/SKU/发货时间/RRP）
   + 各国上市计划（上市节奏表的 预售/线上/线下/首销结束/首销目标）。

   依赖：api(query/options)、WeeklyChips、WeeklyNarrative、echarts、auLoad/auSave、
        auLineFilter/auIndustryLabel（audio-view.js）。数据缓存挂 auW.npData。
   ============================================================ */

const NP_DEFAULT_WINDOW = 30;

function npState() {
  const D = auLoad();
  if (!D.np) D.np = { windowN: NP_DEFAULT_WINDOW, list: [] };
  if (!Array.isArray(D.np.list)) D.np.list = [];
  if (!(+D.np.windowN > 0)) D.np.windowN = NP_DEFAULT_WINDOW;
  return D.np;
}
/* 在卖国家**自动发现**：按产品名(不带任何产业筛选)查全国家 SO，有量的都进表，
   按累计 SO 降序；M5 手选的国家排前面。——用户 2026-08-21：
   「很多国家都在卖，结果你只能识别出来一个墨西哥」= 之前只用了 M5 的两国手选列表。 */
async function npCountries(np) {
  const picked = (auLoad().countries || []).slice();
  let sold = [];
  try {
    const q = await api.query({ metric: 'sellOut', gran: 'month', stackDim: 'country', filters: { product: [np.name] } });
    sold = Object.keys(q.data || {})
      .map(c => ({ c, t: Object.values(q.data[c] || {}).reduce((a, b) => a + (+b || 0), 0) }))
      .filter(x => x.t > 0).sort((a, b) => b.t - a.t).map(x => x.c);
  } catch (e) { }
  const out = [];
  picked.forEach(c => { if (!out.includes(c)) out.push(c); });
  sold.forEach(c => { if (!out.includes(c)) out.push(c); });
  // 上市节奏里排了计划但还没开卖的国家也要有一行（用户可填目标/计划首销）
  try {
    const info = npRoadmapInfo(np);
    const plan = info && (info.tables || []).find(t => /上市计划/.test(t.title || ''));
    if (plan) plan.rows.forEach(r => { const c = r[0]; if (c && c !== '—' && !out.includes(c)) out.push(c); });
  } catch (e) { }
  const base = out.length ? out : ['墨西哥', '哥伦比亚', '智利', '秘鲁', '巴西', '阿根廷'];
  // 用户删掉的国家(没首销/不想看)不再进表;「国家 n/N ▾」chip 可随时恢复
  const rm = np.removed || [];
  return base.filter(c => rm.indexOf(c) < 0);
}
/* 国家管理面板的全量清单 = 当前在表的 ∪ 已删除的 */
async function npAllCountries(np) {
  const rm = (np.removed || []).slice();
  const keep = np.removed; np.removed = [];
  let all = [];
  try { all = await npCountries(np); } finally { np.removed = keep; }
  rm.forEach(c => { if (all.indexOf(c) < 0) all.push(c); });
  return all;
}

/* ---------- 取数：产品 × 国家 的日粒度 SO（按渠道拆，便于线上/线下首销识别） ---------- */
async function npFetchDays(product, country) {
  // 只按 产品×国家 定位——绝不叠产业筛选：产品名已唯一，叠了产业一旦页签与产品不配就全空(实测复现)
  const filters = { product: [product], country: [country] };
  let q = null;
  try { q = await api.query({ metric: 'sellOut', gran: 'day', stackDim: 'channel', filters }); } catch (e) { return { days: [], online: [], offline: [] }; }
  const buckets = (q && q.buckets) || [];
  const data = (q && q.data) || {};
  const chans = Object.keys(data);
  const days = [], online = [], offline = [];
  buckets.forEach(b => {
    let sum = 0, on = 0, off = 0;
    chans.forEach(c => {
      const v = +((data[c] || {})[b]) || 0;
      sum += v;
      if (/online|线上/i.test(c)) on += v;
      else if (/offline|线下/i.test(c)) off += v;
    });
    if (sum > 0) days.push({ d: b, so: sum });
    if (on > 0) online.push({ d: b, so: on });
    if (off > 0) offline.push({ d: b, so: off });
  });
  return { days, online, offline };
}

/* 一个新品的全量数据：逐国 days + 自动/手调首销 + 行计算。缓存进 auW.npData[np.id]。 */
async function npCompute(np) {
  const NP = npState();
  const W = window.WeeklyChips;
  const ctrys = await npCountries(np);
  const byCountry = {};
  for (const c of ctrys) {
    const cur = await npFetchDays(np.name, c);
    const pred = np.pred ? await npFetchDays(np.pred, c) : { days: [], online: [], offline: [] };
    const adj = (np.adj || {})[c] || {};
    const auto = {
      first: W.detectFirstSale(cur.days),
      on: W.detectFirstSale(cur.online),
      off: W.detectFirstSale(cur.offline),
      predFirst: W.detectFirstSale(pred.days),
    };
    // 线上/线下首销不可能早于该国整体首销日——渠道级样本小,自动识别容易被样机日带早,
    // 用整体首销日做下限(ISO 日期字符串字典序即时间序);手调值不受此约束。
    const clampCh = v => (v && auto.first && v < auto.first) ? auto.first : v;
    const eff = {
      first: adj.first || auto.first,
      on: adj.on || clampCh(auto.on), off: adj.off || clampCh(auto.off),
      predFirst: adj.predFirst || auto.predFirst,
    };
    const row = W.firstSaleRow({
      days: cur.days, firstSale: eff.first, onlineFirst: eff.on, offlineFirst: eff.off,
      target: adj.target, predDays: pred.days, predFirstSale: eff.predFirst,
      windowN: NP.windowN,
    });
    /* 手填实际达成(用户 2026-08-25:预售期数据不在 PSI,由人工填)——覆盖系统值,
       达成率/同比上代跟着手填值重算;系统值留在 row.sysActual 供界面对照 */
    row.sysActual = row.actual;
    if (adj.actual != null && adj.actual !== '') {
      row.actual = +adj.actual;
      row.manualActual = true;
      row.attain = row.target ? row.actual / row.target : null;
      row.yoy = (row.predCum != null && row.predCum > 0) ? row.actual / row.predCum - 1 : null;
    }
    byCountry[c] = { cur, pred, auto, adj, eff, row };
  }
  const rows = ctrys.map(c => byCountry[c].row);
  const total = W.firstSaleTotal(rows);
  const soldCountries = ctrys.filter(c => byCountry[c].row.actual > 0).length;
  // 全部国家都还没卖 → 「未开卖新品」：表格只保留 计划首销/目标 列（用户 2026-08-21）
  const notLaunched = ctrys.every(c => byCountry[c].row.actual === 0 && !byCountry[c].auto.first && !byCountry[c].row.manualActual);
  const out = { byCountry, ctrys, total, soldCountries, notLaunched };
  auW.npData = auW.npData || {};
  auW.npData[np.id] = out;
  return out;
}

/* ---------- 达成表 ----------
   · 日期/目标单元格**直接可编辑**（date/number 输入），改了立存 adj 并只重算本产品
     ——不必非得进设计器（用户：首销日期什么的改不了）。
   · 未开卖新品：只显示 国家|计划首销|线上首销|线下首销|首销目标，
     同比上代/达成率/进度/实际 整列隐藏（用户：没首销的产品写首销时间和目标就行）。 */
function npTableModel(np) {
  const d = (auW.npData || {})[np.id];
  if (!d) return null;
  const W = window.WeeklyChips;
  const pd = s => s ? s.replace(/-/g, '/') : '—';
  const pc = v => v == null ? '—' : (v * 100).toFixed(0) + '%';
  const sp = v => v == null ? '—' : (v >= 0 ? '+' : '') + (v * 100).toFixed(0) + '%';
  if (d.notLaunched) {
    // 计划首销优先取上市节奏；手填(adj.first)覆盖
    const info = npRoadmapInfo(np);
    const plan = info && (info.tables || []).find(t => /上市计划/.test(t.title || ''));
    const planOf = c => { const r = plan && plan.rows.find(x => x[0] === c); return r ? { on: r[2], off: r[3] } : {}; };
    return {
      title: '新品首销计划（尚未开卖 · 开卖后自动切换为达成表）',
      header: ['国家', '计划首销', '线上首销', '线下首销', '首销目标', '实际达成(可手填)'],
      rows: d.ctrys.map(c => {
        const a = (np.adj || {})[c] || {}, pl = planOf(c);
        return [c, pd(a.first) , a.on ? pd(a.on) : (pl.on || '—'), a.off ? pd(a.off) : (pl.off || '—'),
          a.target == null ? '—' : W.fmtInt(a.target), a.actual == null ? '—' : W.fmtInt(a.actual)];
      }),
      hasTotal: false, notLaunched: true,
    };
  }
  const rows = d.ctrys.map(c => {
    const r = d.byCountry[c].row;
    return [c, pd(r.firstSale), pd(r.onlineFirst), pd(r.offlineFirst),
      r.firstSale ? pc(r.progress) : '—',
      W.fmtInt(r.actual), r.target == null ? '—' : W.fmtInt(r.target), pc(r.attain), sp(r.yoy)];
  });
  const t = d.total;
  rows.push(['合计', '', '', '', '', W.fmtInt(t.actual), t.target == null ? '—' : W.fmtInt(t.target), pc(t.attain), sp(t.yoy)]);
  return {
    title: '新品首销达成（首销期 ' + npState().windowN + ' 天' + (np.pred ? ' · 上代=' + np.pred : '') + '）',
    header: ['国家', '首销日期', '线上首销', '线下首销', '时间进度', '实际达成(台)', '首销目标', '达成率', '同比上代'],
    rows, hasTotal: true,
  };
}

/* 界面版：可编辑单元格（导出仍用 npTableModel 的纯文本） */
function npEditableTableHtml(np) {
  const d = (auW.npData || {})[np.id];
  const tm = npTableModel(np);
  if (!d || !tm) return '<div class="au-empty">取数中…</div>';
  const dateIn = (c, k, val, auto) =>
    '<input type="date" data-npc="' + auEsc(c) + '" data-npk="' + k + '" value="' + auEsc(val || '') + '" style="width:120px"'
    + ' title="' + (auto ? '自动识别值,改了即手调优先' : '手填') + '">';
  const numIn = (c, val) =>
    '<input type="number" data-npc="' + auEsc(c) + '" data-npk="target" value="' + (val != null ? val : '') + '" placeholder="台" style="width:84px;text-align:right">';
  const rmN = (np.removed || []).length;
  const allN = d.ctrys.length + rmN;
  let h = '<div class="au-sec-t" style="font-size:12px;position:relative">' + auEsc(tm.title)
    + ' <span class="chip" data-npmgr style="cursor:pointer;background:var(--c-brand-soft);color:var(--c-brand);font-size:11px;padding:1px 8px;border-radius:12px" title="勾选要展示的国家,去勾=删除;随时可恢复">国家 <b>' + d.ctrys.length + '/' + allN + '</b> ▾</span>'
    + '<span class="au-note">日期/目标/实际 直接在表里改，自动保存并重算;行首 ✕ 删除国家</span></div>';
  h += '<table class="rep-table" style="width:100%"><thead><tr><th style="width:20px"></th>' + tm.header.map(x => '<th>' + auEsc(x) + '</th>').join('') + '</tr></thead><tbody>';
  d.ctrys.forEach(c => {
    const cd = d.byCountry[c], adj = (np.adj || {})[c] || {}, r = cd.row;
    const W = window.WeeklyChips;
    const pc = v => v == null ? '—' : (v * 100).toFixed(0) + '%';
    const sp = v => v == null ? '—' : (v >= 0 ? '+' : '') + (v * 100).toFixed(0) + '%';
    const rmTd = '<td><button class="row-hide-btn" data-nprm="' + auEsc(c) + '" title="删除这个国家(没首销/不想看;「国家」chip 可恢复)" style="border:none;background:none;color:var(--c-ink-3);cursor:pointer;font-size:11px;padding:0 3px">✕</button></td>';
    // 实际达成:手填覆盖系统值(预售期数据不在 PSI);空=用系统值,小字对照
    const actIn = '<input type="number" data-npc="' + auEsc(c) + '" data-npk="actual" value="' + (adj.actual != null ? adj.actual : '') + '" placeholder="' + (r.sysActual != null ? r.sysActual : 0) + '" style="width:84px;text-align:right" title="手填实际达成(预售期用);清空=回到系统值">'
      + (r.manualActual ? '<div style="font-size:10px;color:var(--c-brand)">手填 · 系统 ' + W.fmtInt(r.sysActual || 0) + '</div>' : '<div style="font-size:10px;color:var(--c-ink-3)">系统</div>');
    if (tm.notLaunched) {
      h += '<tr>' + rmTd + '<td>' + auEsc(c) + '</td>'
        + '<td>' + dateIn(c, 'first', adj.first, false) + '</td>'
        + '<td>' + dateIn(c, 'on', adj.on || '', false) + '</td>'
        + '<td>' + dateIn(c, 'off', adj.off || '', false) + '</td>'
        + '<td style="text-align:right">' + numIn(c, adj.target) + '</td>'
        + '<td style="text-align:right">' + actIn + '</td></tr>';
    } else {
      h += '<tr>' + rmTd + '<td>' + auEsc(c) + '</td>'
        + '<td>' + dateIn(c, 'first', cd.eff.first, !adj.first) + (adj.first ? '<div style="font-size:10px;color:var(--c-brand)">手调</div>' : '<div style="font-size:10px;color:var(--c-ink-3)">自动</div>') + '</td>'
        + '<td>' + dateIn(c, 'on', cd.eff.on, !adj.on) + '</td>'
        + '<td>' + dateIn(c, 'off', cd.eff.off, !adj.off) + '</td>'
        + '<td>' + (r.firstSale ? pc(r.progress) : '—') + '</td>'
        + '<td style="text-align:right">' + actIn + '</td>'
        + '<td style="text-align:right">' + numIn(c, adj.target != null ? adj.target : null) + '</td>'
        + '<td style="text-align:right">' + pc(r.attain) + '</td>'
        + '<td style="text-align:right">' + sp(r.yoy) + '</td></tr>';
    }
  });
  if (!tm.notLaunched) {
    const t = d.total, W = window.WeeklyChips;
    const pc = v => v == null ? '—' : (v * 100).toFixed(0) + '%';
    const sp = v => v == null ? '—' : (v >= 0 ? '+' : '') + (v * 100).toFixed(0) + '%';
    h += '<tr class="tot" style="font-weight:700"><td></td><td>合计</td><td></td><td></td><td></td><td></td>'
      + '<td style="text-align:right">' + W.fmtInt(t.actual) + '</td>'
      + '<td style="text-align:right">' + (t.target == null ? '—' : W.fmtInt(t.target)) + '</td>'
      + '<td style="text-align:right">' + pc(t.attain) + '</td>'
      + '<td style="text-align:right">' + sp(t.yoy) + '</td></tr>';
  }
  return h + '</tbody></table>';
}
/* ---------- 新品信息（路标搜罗：主数据 + 各国上市计划） ---------- */
function npReadRoadmap() {
  const rd = k => { try { return JSON.parse(localStorage.getItem(k) || 'null') || {}; } catch (e) { return {}; } };
  return {
    products: rd('sb.roadmap.products.v1').products || [],
    samples: rd('sb.roadmap.samples.v1').samples || [],
    launches: rd('sb.roadmap.launch.v1').launches || [],
  };
}
const npNorm = s => String(s == null ? '' : s).trim().toLowerCase().replace(/\s+/g, '').replace(/[-_/()（）]/g, '');
function npRoadmapInfo(np) {
  const R = npReadRoadmap();
  const p = R.products.find(x => npNorm(x.name) === npNorm(np.name) || (x.psiLink && npNorm(x.psiLink) === npNorm(np.name)));
  if (!p) return null;
  const dash = v => (v == null || v === '') ? '—' : String(v);
  const tables = [];

  /* 表A 产品主档：一行定位 */
  tables.push({
    title: np.name + ' 产品主档',
    header: ['产品', '认证型号', '内部编码', 'SKU数', '样机数', '最早发货', '最晚发货(上市)', '销售结束', '综合RRP(USD)'],
    rows: [[dash(p.name || np.name), dash(p.certModel), dash(p.internalCode),
      String((p.skus || []).filter(x => x && (x.name || x.ean)).length),
      String(R.samples.filter(x => x.productId === p.id).length),
      dash(p.shipEarly), dash(p.shipLate), dash(p.salesEnd),
      p.compositeRrpUsd == null ? '—' : ('$' + p.compositeRrpUsd)]],
  });

  /* 表B SKU 明细：每 SKU 一行，各自的 EAN（用户要求分 SKU 写） */
  const skus = (p.skus || []).filter(x => x && (x.name || x.ean));
  if (skus.length) tables.push({
    title: np.name + ' SKU 明细',
    header: ['SKU', '颜色', 'RAM+ROM', '芯片', 'EAN'],
    rows: skus.map(x => [dash(x.name), dash(x.color), dash([x.ram, x.rom].filter(Boolean).join('+')), dash(x.chip), dash(x.ean)]),
  });

  /* 表C 样机明细：每样机一行——VN1/VN2 分开，每个颜色编码不同（用户原话） */
  const smp = R.samples.filter(x => x.productId === p.id)
    .slice().sort((a, b) => String(a.type || '').localeCompare(String(b.type || '')) || String(a.color || '').localeCompare(String(b.color || '')));
  if (smp.length) tables.push({
    title: np.name + ' 样机明细',
    header: ['批次', '样机名称', '样机编码', '颜色', '认证型号', '到样时间', '是否入库'],
    rows: smp.map(x => [dash(x.type), dash(x.name), dash(x.code), dash(x.color), dash(x.certModel), dash(x.shipLate), dash(x.inbox)]),
  });

  /* 表D 各国上市计划（上市节奏） */
  const seen = new Set(); const planRows = [];
  R.launches.filter(l => l.productId === p.id).forEach(l => {
    (l.countryRows || []).forEach(r => {
      const c = (r.country || '').trim(); if (!c || seen.has(c)) return; seen.add(c);
      planRows.push([c, dash(r.presale), dash(r.online), dash(r.offline), dash(r.end),
        (r.target || r.targetOn || r.targetOff) ? [r.target, r.targetOn && ('线上' + r.targetOn), r.targetOff && ('线下' + r.targetOff)].filter(Boolean).join(' / ') : '—']);
    });
  });
  if (planRows.length) tables.push({
    title: np.name + ' 各国上市计划',
    header: ['国家', '预售时间', '线上首销', '线下首销', '首销结束', '首销目标'],
    rows: planRows,
  });

  return { tables, roadmapId: p.id };
}

/* ---------- 界面 ---------- */
async function renderAuNewprod() {
  const host = $('#auSecNewprod'); if (!host) return;
  const NP = npState(), D = auLoad();
  const head = '<div class="au-sec-t">新品进展 / 新品信息<span class="au-note">每国首销单独审视：自动识别真实首销日（剔除样机激活）→ 首销设计器里拖竖线微调 · 首销期 '
    + NP.windowN + ' 天 · 同比上代=同国对齐同天数</span></div>';
  if (!state.dims.length) { host.innerHTML = head + '<div class="au-empty">请先锚定 PSI 数据。</div>'; return; }

  // 产品候选（当前产业下）
  let prodOpts = [];
  try { prodOpts = await api.options('product', Object.assign({}, auLineFilter())) || []; } catch (e) { }
  // 路标里的产品(预售期 PSI 还没有销量)也要能选——选中后产品信息照出,达成表走「未开卖」
  // 模式,可手填计划首销/目标/实际(用户 2026-08-25:路标有的产品在框里选不了)
  try {
    npReadRoadmap().products.forEach(pp => {
      const n2 = String(pp.name || '').trim();
      if (n2 && prodOpts.indexOf(n2) < 0) prodOpts.push(n2);
    });
  } catch (e) { }

  let h = head + '<div class="au-toolbar" id="npBar">'
    + '<label>首销期(天)</label><input type="number" id="npWindow" value="' + NP.windowN + '" min="7" max="120" style="width:64px">'
    + '<button class="btn" id="npAdd">＋添加新品</button>'
    + '</div><div id="npList"></div>';
  host.innerHTML = h;

  $('#npWindow').onchange = e => { NP.windowN = Math.max(7, Math.min(120, +e.target.value || NP_DEFAULT_WINDOW)); auSave(); renderAuNewprod(); };
  $('#npAdd').onclick = () => {
    const name = prodOpts.find(p => !NP.list.some(x => x.name === p));
    NP.list.push({ id: 'np' + Date.now().toString(36), name: name || '', pred: '', adj: {} });
    auSave(); renderAuNewprod();
  };

  const listHost = $('#npList');
  for (const np of NP.list) {
    const box = document.createElement('div');
    box.style.cssText = 'border:1px solid var(--c-line);border-radius:10px;padding:10px 14px;margin:8px 0;background:var(--c-bg-elev)';
    const selOpt = (list, cur, extra) => (extra ? ['<option value="">' + extra + '</option>'] : [])
      .concat(list.map(p => '<option ' + (p === cur ? 'selected' : '') + '>' + auEsc(p) + '</option>')).join('');
    box.innerHTML = '<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:6px">'
      + '<label>新品</label><select data-np-name>' + selOpt(prodOpts, np.name) + '</select>'
      + '<label>上一代产品</label><select data-np-pred>' + selOpt(prodOpts.filter(p => p !== np.name), np.pred, '（不对比）') + '</select>'
      + '<button class="btn" data-np-design>🎯 首销设计器</button>'
      + '<button class="btn" data-np-refresh>↻ 重新取数</button>'
      + '<button class="au-del" data-np-del title="删除此新品">✕</button>'
      + '</div>'
      + '<div data-np-nar></div>'
      + '<div class="fa-wrap" data-np-table>取数中…</div>'
      + '<div class="fa-wrap" data-np-info style="margin-top:8px"></div>';
    listHost.appendChild(box);

    box.querySelector('[data-np-name]').onchange = e => { np.name = e.target.value; np.adj = {}; auSave(); renderAuNewprod(); };
    box.querySelector('[data-np-pred]').onchange = e => { np.pred = e.target.value; auSave(); renderAuNewprod(); };
    box.querySelector('[data-np-del]').onclick = () => { NP.list = NP.list.filter(x => x !== np); auSave(); renderAuNewprod(); };
    box.querySelector('[data-np-refresh]').onclick = () => renderAuNewprod();
    box.querySelector('[data-np-design]').onclick = () => npOpenDesigner(np);

    // 叙述编辑器（默认模板照抄邮件句式）
    if (!D.nar) D.nar = {};
    if (!D.nar.np) D.nar.np = {};
    if (!D.nar.np[np.id]) {
      D.nar.np[np.id] = window.WeeklyChips.docFromTemplate([
        '新品进展-' + (np.name || '新品') + '：当前', { chip: { id: 'npCountries', scope: { value: np.id } } },
        '国累计销售', { chip: { id: 'npCum', scope: { value: np.id } } },
        '台，首销目标达成', { chip: { id: 'npAttain', scope: { value: np.id } } },
        '，同比上代首销同期', { chip: { id: 'npYoy', scope: { value: np.id } } }, '。',
      ]);
      auSave();
    }
    window.WeeklyNarrative.mount(box.querySelector('[data-np-nar]'), {
      doc: D.nar.np[np.id],
      getCtx: (typeof auChipCtx === 'function') ? auChipCtx : null,
      palette: [
        { cfg: { id: 'npCountries', scope: { value: np.id } } }, { cfg: { id: 'npCum', scope: { value: np.id } } },
        { cfg: { id: 'npTarget', scope: { value: np.id } } }, { cfg: { id: 'npAttain', scope: { value: np.id } } },
        { cfg: { id: 'npYoy', scope: { value: np.id } } }, { cfg: { id: 'week' } },
      ],
      onChange: doc => { D.nar.np[np.id] = doc; auSave(); },
    });

    // 取数 + 表
    if (np.name) {
      npCompute(np).then(() => {
        const tHost = box.querySelector('[data-np-table]');
        if (tHost) {
          tHost.innerHTML = npEditableTableHtml(np);
          // 表内直改：日期/目标 → 存 adj → 只重算本产品并局部重画本表(不整段刷新、不闪屏)
          tHost._bindAll = function () {
            const redo = () => npCompute(np).then(() => { tHost.innerHTML = npEditableTableHtml(np); tHost._bindAll(); if (typeof auChipsRefresh === 'function') auChipsRefresh(); });
            tHost.querySelectorAll('input[data-npc]').forEach(inp2 => inp2.onchange = () => {
              const c2 = inp2.dataset.npc, k2 = inp2.dataset.npk;
              np.adj = np.adj || {}; np.adj[c2] = np.adj[c2] || {};
              if (k2 === 'target' || k2 === 'actual') np.adj[c2][k2] = inp2.value === '' ? null : +inp2.value;
              else np.adj[c2][k2] = inp2.value || null;
              auSave();
              redo();
            });
            // 行首 ✕:删除国家(记进 np.removed,「国家」chip 可恢复)
            tHost.querySelectorAll('[data-nprm]').forEach(bt => bt.onclick = () => {
              np.removed = np.removed || [];
              if (np.removed.indexOf(bt.dataset.nprm) < 0) np.removed.push(bt.dataset.nprm);
              auSave();
              redo();
            });
            // 「国家 n/N ▾」勾选面板:checked=在表,去勾=删除
            const chip = tHost.querySelector('[data-npmgr]');
            if (chip) chip.onclick = async () => {
              let pnl = tHost.querySelector('.np-mgr-panel'); if (pnl) { pnl.remove(); return; }
              pnl = document.createElement('div'); pnl.className = 'np-mgr-panel';
              pnl.style.cssText = 'position:absolute;top:calc(100% - 2px);left:' + Math.max(8, chip.offsetLeft) + 'px;z-index:60;background:var(--c-bg-elev);border:1px solid var(--c-line);border-radius:8px;box-shadow:0 10px 30px rgba(0,0,0,.14);padding:8px 10px;max-height:280px;overflow:auto;min-width:200px';
              const all = await npAllCountries(np);
              const rm0 = np.removed || [];
              all.forEach(c3 => {
                const row3 = document.createElement('label'); row3.style.cssText = 'display:flex;align-items:center;gap:8px;padding:2px 0;font-size:12px;color:var(--c-ink-1);cursor:pointer';
                const ck = document.createElement('input'); ck.type = 'checkbox'; ck.checked = rm0.indexOf(c3) < 0;
                ck.onchange = () => {
                  np.removed = np.removed || [];
                  const i3 = np.removed.indexOf(c3);
                  if (ck.checked) { if (i3 >= 0) np.removed.splice(i3, 1); }
                  else if (i3 < 0) np.removed.push(c3);
                  auSave();
                  redo();
                };
                const nm3 = document.createElement('span'); nm3.textContent = c3; nm3.style.flex = '1';
                row3.appendChild(ck); row3.appendChild(nm3); pnl.appendChild(row3);
              });
              chip.parentElement.appendChild(pnl);
            };
          };
          tHost._bindAll();
        }
        const info = npRoadmapInfo(np);
        const iHost = box.querySelector('[data-np-info]');
        if (iHost) iHost.innerHTML = info
          ? info.tables.map(t => npOneTableHtml(t)).join('')
          : '<div class="au-note">路标里没找到「' + auEsc(np.name) + '」——去路标管理建卡并填 认证型号/SKU/样机/上市节奏 后这里自动带出</div>';
        if (typeof auChipsRefresh === 'function') auChipsRefresh();
      }).catch(() => { });
    } else {
      box.querySelector('[data-np-table]').innerHTML = '<div class="au-empty">先选择新品</div>';
    }
  }
  if (!NP.list.length) listHost.innerHTML = '<div class="au-empty">点「＋添加新品」，选择新品与上一代产品，即可生成首销达成表与新品信息。</div>';
}

function npTableHtml(tm) {
  let h = '<div class="au-sec-t" style="font-size:12px">' + auEsc(tm.title) + '</div>';
  h += '<table class="rep-table" style="width:100%"><thead><tr>' + tm.header.map(x => '<th>' + auEsc(x) + '</th>').join('') + '</tr></thead><tbody>';
  tm.rows.forEach((r, i) => {
    const tot = i === tm.rows.length - 1;
    h += '<tr' + (tot ? ' class="tot"' : '') + '>' + r.map((c, j) => '<td style="' + (j >= 4 ? 'text-align:right' : '') + (tot ? ';font-weight:700' : '') + '">' + auEsc(c) + '</td>').join('') + '</tr>';
  });
  return h + '</tbody></table>';
}
function npOneTableHtml(t) {
  if (!t) return '';
  let h = '<div class="au-sec-t" style="font-size:12px;margin-top:6px">' + auEsc(t.title) + '</div>';
  h += '<table class="rep-table" style="width:100%"><thead><tr>' + t.header.map(x => '<th>' + auEsc(x) + '</th>').join('') + '</tr></thead><tbody>';
  t.rows.forEach(r => { h += '<tr>' + r.map(c => '<td>' + auEsc(c) + '</td>').join('') + '</tr>'; });
  return h + '</tbody></table>';
}

/* ---------- 首销设计器：每国一张日销量曲线，拖竖线定真实首销日 ---------- */
let npDlgChart = null, npDlgChartPred = null;

async function npOpenDesigner(np) {
  let dlg = document.getElementById('npDesigner');
  if (!dlg) { dlg = document.createElement('div'); dlg.id = 'npDesigner'; document.body.appendChild(dlg); }
  // 没取过数就现场取——之前直接 return,用户点开「什么都没有」(2026-08-21 反馈)
  let d = (auW.npData || {})[np.id];
  if (!d) {
    dlg.innerHTML = '<div style="position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:900"></div>'
      + '<div style="position:fixed;inset:40% 30%;background:var(--c-bg);border:1px solid var(--c-line);border-radius:12px;z-index:901;display:flex;align-items:center;justify-content:center">正在读取 ' + auEsc(np.name) + ' 的逐日销量…</div>';
    try { d = await npCompute(np); } catch (e) { d = null; }
    if (!d) { dlg.innerHTML = ''; toast('取数失败：' + auEsc(np.name), 'err'); return; }
  }
  const ctrys = d.ctrys;
  let cur = ctrys[0];

  const render = () => {
    const cd = d.byCountry[cur] || {};
    const adj = (np.adj || {})[cur] || {};
    dlg.innerHTML = '<div style="position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:900" data-close></div>'
      + '<div style="position:fixed;inset:6% 10%;background:var(--c-bg);border:1px solid var(--c-line);border-radius:12px;z-index:901;display:flex;flex-direction:column;overflow:hidden">'
      + '<div style="padding:10px 16px;border-bottom:1px solid var(--c-line);display:flex;align-items:center;gap:10px">'
      + '<b>🎯 首销设计器 · ' + auEsc(np.name) + '</b>'
      + '<div class="seg" id="npCtrySeg">' + ctrys.map(c => '<button data-c="' + auEsc(c) + '" class="' + (c === cur ? 'on' : '') + '">' + auEsc(c) + '</button>').join('') + '</div>'
      + '<span style="flex:1"></span><button class="btn" data-close>完成</button></div>'
      + '<div style="flex:1;overflow:auto;padding:12px 16px">'
      + '<div style="font-size:12px;color:var(--c-ink-3);margin-bottom:6px">拖动<b style="color:var(--c-brand)">红色竖线</b>=新品真实首销日；下图拖<b>灰色竖线</b>=上代真实首销日（样机期的零星激活不算首销）。改完自动重算达成表。</div>'
      + '<div style="display:flex;gap:14px;flex-wrap:wrap;align-items:center;margin-bottom:8px" id="npAdjBar">'
      + '  <span>首销日 <b id="npCurFirst">' + (cd.eff && cd.eff.first || '—') + '</b>' + (adj.first ? '（手调）' : '（自动）') + '</span>'
      + '  <label>线上首销</label><input type="date" id="npOnDate" value="' + ((cd.eff && cd.eff.on) || '') + '">'
      + '  <label>线下首销</label><input type="date" id="npOffDate" value="' + ((cd.eff && cd.eff.off) || '') + '">'
      + '  <label>首销目标</label><input type="number" id="npTarget" value="' + (adj.target != null ? adj.target : '') + '" placeholder="台" style="width:90px">'
      + '  <button class="btn" id="npAutoBtn" title="清掉本国全部手调,回到自动识别">恢复自动</button>'
      + '</div>'
      + '<div style="height:250px;border:1px solid var(--c-line);border-radius:8px;position:relative"><div id="npChartNew" style="position:absolute;inset:0"></div></div>'
      + '<div style="margin:8px 0 4px;font-size:12px;color:var(--c-ink-3)">上代 ' + (np.pred ? auEsc(np.pred) : '（未选）') + ' · 首销日 <b id="npPredFirst">' + (cd.eff && cd.eff.predFirst || '—') + '</b>' + (adj.predFirst ? '（手调）' : '（自动）') + '</div>'
      + '<div style="height:210px;border:1px solid var(--c-line);border-radius:8px;position:relative"><div id="npChartPred" style="position:absolute;inset:0"></div></div>'
      + '</div></div>';

    dlg.querySelectorAll('[data-close]').forEach(x => x.onclick = () => { dlg.innerHTML = ''; renderAuNewprod(); });
    dlg.querySelectorAll('#npCtrySeg button').forEach(b => b.onclick = () => { cur = b.dataset.c; render(); });
    const saveAdj = patch => {
      np.adj = np.adj || {}; np.adj[cur] = Object.assign({}, np.adj[cur] || {}, patch);
      auSave();
      npCompute(np).then(render);
    };
    dlg.querySelector('#npOnDate').onchange = e => saveAdj({ on: e.target.value });
    dlg.querySelector('#npOffDate').onchange = e => saveAdj({ off: e.target.value });
    dlg.querySelector('#npTarget').onchange = e => saveAdj({ target: e.target.value === '' ? null : +e.target.value });
    dlg.querySelector('#npAutoBtn').onclick = () => { if (np.adj) delete np.adj[cur]; auSave(); npCompute(np).then(render); };

    // 等 DOM 落定再画(fixed 弹窗刚插入时容器可能还没尺寸);出错把原因摆在图位上,不再静默
    requestAnimationFrame(() => {
      try { npDlgChart = npDrawCurve('npChartNew', cd.cur ? cd.cur.days : [], (cd.eff || {}).first, 'var(--c-brand)', dte => saveAdj({ first: dte }), npDlgChart); }
      catch (e) { const el = document.getElementById('npChartNew'); if (el) el.innerHTML = '<div class="au-empty" style="padding-top:80px">图渲染失败：' + auEsc(e.message) + '</div>'; }
      try { npDlgChartPred = npDrawCurve('npChartPred', cd.pred ? cd.pred.days : [], (cd.eff || {}).predFirst, '#8A9099', dte => saveAdj({ predFirst: dte }), npDlgChartPred); }
      catch (e) { const el = document.getElementById('npChartPred'); if (el) el.innerHTML = '<div class="au-empty" style="padding-top:60px">图渲染失败：' + auEsc(e.message) + '</div>'; }
    });
  };
  render();
}

/* 日销量曲线 + 可拖竖线（echarts graphic：拖动横向、松手吸附到最近日期并回调） */
function npDrawCurve(elId, days, firstDate, color, onPick, oldChart) {
  const el = document.getElementById(elId); if (!el) return null;
  if (oldChart) { try { oldChart.dispose(); } catch (e) { } }
  if (typeof echarts === 'undefined') { el.innerHTML = '<div class="au-empty" style="padding-top:80px">echarts 未加载</div>'; return null; }
  if (!days || !days.length) { el.innerHTML = '<div class="au-empty" style="padding-top:80px">该国没有该产品的日销量数据</div>'; return null; }
  const ct = (typeof CT === 'function') ? CT() : null;
  const chart = echarts.init(el);
  const xs = days.map(x => x.d), ys = days.map(x => x.so);
  const brand = getComputedStyle(document.documentElement).getPropertyValue('--c-brand').trim() || '#C7000B';
  const lineColor = color === 'var(--c-brand)' ? brand : color;
  const idxOf = dte => { const i = xs.indexOf(dte); return i >= 0 ? i : 0; };

  function lineGraphic() {
    if (!firstDate || xs.indexOf(firstDate) < 0) return [];
    const px = chart.convertToPixel({ xAxisIndex: 0 }, idxOf(firstDate));
    if (px == null || isNaN(px)) return [];
    const h = chart.getHeight();
    return [{
      type: 'group', x: px, draggable: 'horizontal',
      ondrag: function () { this._dragX = this.x; },
      ondragend: function () {
        const val = chart.convertFromPixel({ xAxisIndex: 0 }, this._dragX != null ? this._dragX : this.x);
        const i = Math.max(0, Math.min(xs.length - 1, Math.round(val)));
        onPick(xs[i]);
      },
      children: [
        { type: 'rect', shape: { x: -5, y: 24, width: 10, height: h - 54 }, style: { fill: 'rgba(0,0,0,0.001)' }, cursor: 'ew-resize' },
        { type: 'line', shape: { x1: 0, y1: 24, x2: 0, y2: h - 30 }, style: { stroke: lineColor, lineWidth: 2 }, cursor: 'ew-resize' },
        { type: 'text', style: { text: '首销 ' + firstDate, x: 4, y: 28, fill: lineColor, font: 'bold 11px "Microsoft YaHei"' }, cursor: 'ew-resize' },
      ],
    }];
  }
  chart.setOption({
    animation: false,
    grid: { left: 48, right: 16, top: 24, bottom: 30 },
    tooltip: { trigger: 'axis' },
    xAxis: { type: 'category', data: xs, axisLabel: { color: ct ? ct.ink3() : '#8A9099', fontSize: 10 } },
    yAxis: { type: 'value', axisLabel: { color: ct ? ct.ink3() : '#8A9099', fontSize: 10 }, splitLine: { lineStyle: { color: ct ? ct.lineSoft() : '#F0F1F3' } } },
    series: [{ type: 'line', data: ys, showSymbol: false, lineStyle: { color: lineColor, width: 1.5 }, areaStyle: { opacity: 0.06, color: lineColor } }],
    graphic: lineGraphic(),
  });
  chart.on('finished', () => { try { chart.setOption({ graphic: lineGraphic() }); } catch (e) { } });
  return chart;
}

/* ---------- 导出模型（audio-export 的 v3 builder 消费） ---------- */
function auNpExportModels(ctx) {
  const NP = npState(), D = auLoad();
  return NP.list.filter(np => np.name).map(np => {
    const doc = D.nar && D.nar.np && D.nar.np[np.id];
    const text = doc ? window.WeeklyChips.resolveDoc(doc, ctx) : '';
    const table = npTableModel(np);
    const info = npRoadmapInfo(np);
    return { name: np.name, text, table, info: info ? { tables: info.tables } : null };
  });
}

/* np 芯片的 ctx 数据（auChipCtx 调用） */
function auNpChipScopes() {
  const NP = npState(), out = {};
  NP.list.forEach(np => {
    const d = (auW.npData || {})[np.id];
    if (!d) return;
    out[np.id] = {
      countries: d.soldCountries,
      actual: d.total.actual, target: d.total.target,
      attain: d.total.attain, yoy: d.total.yoy,
    };
  });
  return out;
}

if (typeof window !== 'undefined') {
  window.renderAuNewprod = renderAuNewprod;
  window.auNpExportModels = auNpExportModels;
  window.auNpChipScopes = auNpChipScopes;
}
if (typeof module !== 'undefined' && module.exports) module.exports = { NP_DEFAULT_WINDOW };

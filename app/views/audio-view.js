'use strict';
/* ============================================================
   Salesboard — views/audio-view.js  产业周报看板（音频 / 平板可切换）
   本文件：M1 遗留问题 · M2 经营进展 · M3 悬赏奖 SI · M5 产品维度 · M6 新品进展
   （M4 周度销售在 views/audio-ind.js，导出在 audio-export.js）
   自包含移植(port)：经营两表 / 国家块的渲染逻辑在本文件各自复制一份，
   **不改动 finance-view / industry-view / country-view 的任何行为**；
   只读复用引擎 API(api.report/financeProductBoard/financeRepBoard/query/options)与
   common.js 纯 helper($/numCell/dosCell/pctCell/seriesRank/makeMultiSelect/renderWeekRange/drawTablePNG 等)。
   持久化：用户数据 sb.audio.v1(自动进存档) + 界面状态 sb.audio.state.v1。
   ============================================================ */

const AU_KEY = 'sb.audio.v1', AU_STATE_KEY = 'sb.audio.state.v1', AU_HIDE_LS = 'sb.audio.cb.hidden', AU_ZOOM_LS = 'sb.audio.cbZoom';
const AU_ISSUE_TYPES = ['要货', '定价', '配件', '认证', '促销', '其他'];
const AU_ISSUE_STATUS = ['进行中', '待跟进', '有风险', '已闭环'];
/* R1 产业切换(音频/平板):看板不再写死音频。
   exact = 优先精确命中的维度值(平板);re = 兜底的包含式匹配(音频没有统一写法,只能按"含音频")。
   同一套规则同时用于 财经 LV1 与 PSI 的 line/family 维度值探测。 */
const AU_INDS = [
  { key: 'audio', label: '音频', exact: null, re: /音频/, board: '音频产业经营进展' },
  { key: 'tablet', label: '平板', exact: '平板', re: /平板/, board: '平板产业经营进展' },
];
const auW = {
  data: null, shell: false, industry: 'audio',
  finToM: 0, finUnit: 'USD', finDp: 1, finLv1: {}, finDims: null, finLv3Opts: {}, finLv3Sel: [], finRepSel: [], finPb: null, finRb: null,
  cb: { dim: 'product', weeks: 9, fromW: null, toW: null }, cbLast: [], cbZoom: 1, token: 0,
  indDim: {}, prodOpts: [], modelOpts: [], ctryOpts: [],
  _inflight: {},   // 模块 → 当前在途的渲染 Promise(导出前要等它,见 auEnsureWeeklyData)
};

/* ---------- 导出缓存的生命周期 ----------
   一键导出不重新取数,只读各模块渲染时留下的缓存(finPb/_bountyExport/cbLast)。
   所以缓存必须严格等于「本次渲染的结果」——**进渲染就先清空**,而不是只在成功时覆盖。
   否则任何早退分支都会把上一轮的数据留给导出:实测切到平板、财经里没有平板 LV1 时
   renderAuFin 早退,auW.finPb 还是音频那份,导出的「平板产业经营进展」里印的是音频数字。
   四个异步模块的渲染 Promise 也登记下来,导出前统一等一等,免得刚进看板就点导出出半份。 */
function auTrack(key, p) {
  const q = Promise.resolve(p).catch(() => { });
  auW._inflight[key] = q;
  q.then(() => { if (auW._inflight[key] === q) auW._inflight[key] = null; });
  return p;
}
/* 等所有在途渲染落地,返回仍然没有数据的模块名(供导出侧如实告知用户,不阻断导出) */
async function auEnsureWeeklyData() {
  for (let i = 0; i < 3; i++) {              // 连点筛选时会连开几轮,最多等三轮
    const ps = Object.keys(auW._inflight).map(k => auW._inflight[k]).filter(Boolean);
    if (!ps.length) break;
    await Promise.all(ps);
  }
  const missing = [];
  const D = auLoad();
  if (!auW.finPb) missing.push('全年达成进度');
  if (!auW.famRep) missing.push('系列销售表');
  if (!auW.repRep) missing.push('国家办销售表');
  if (!(auW.cbLast || []).length) missing.push('国家块');
  if (D.showBounty && !auW._bountyExport) missing.push('悬赏奖');   // 默认隐藏时不再误报
  return missing;
}
if (typeof window !== 'undefined') window.auEnsureWeeklyData = auEnsureWeeklyData;

/* ---------- 持久化 ---------- */
function auDefaultData() {
  return {
    issues: [],
    bounty: {
      rows: ['墨西哥', '巴西', '秘鲁', '智利', '哥伦比亚', '阿根廷', '拉美其他'].map(c => ({ country: c, space: null, share: null, target: null })),
      // R3 多级筛选:line/family/series 与原有 product/model 一起「与」关系传进 query
      // (prodSel===null = 用户没手选过 → 音频产业下走默认产品集 SE2/SE3/SE4)
      lineSel: [], familySel: [], seriesSel: [], prodSel: null, modelSel: [], from: '2026-01-01', to: '',
    },
    countries: ['墨西哥', '哥伦比亚', '智利', '秘鲁', '巴西', '阿根廷'],
    title: { text: '', size: 15, bold: false },
    // 收件人/抄送/主题：随存档走，下次开软件还在（用户从 Outlook 复制上一封的收件人粘进来）
    mail: { to: '', cc: '', subject: '' },
    /* 周报 v3（用户 W34 邮件版式）：问候两行 + 大表标题，{week}/{产业} 导出时自动替换 */
    greet: {
      l1: '各位领导同事好，请查收{week}拉美{产业}销售团队周报',
      l2: '周报涉及产业经营信息，此邮件禁止转发/截屏，请注意信息安全。',
      titleTpl: '拉美{产业}销售团队周报-{week}',
    },
    nar: { country: {}, np: {} },   // 各章节叙述文档（芯片嵌在文字里）
    showBounty: false,              // 悬赏奖：用户拍板保留可选、默认隐藏
    np: { windowN: 30, list: [] },
    blocks: [],
  };
}
function auLoad() {
  if (auW.data) return auW.data;
  let d = null; try { d = JSON.parse(localStorage.getItem(AU_KEY)); } catch (e) { }
  auW.data = Object.assign(auDefaultData(), d || {});
  auW.data.bounty = Object.assign(auDefaultData().bounty, (d && d.bounty) || {});
  auW.data.mail = Object.assign(auDefaultData().mail, (d && d.mail) || {});
  auW.data.greet = Object.assign(auDefaultData().greet, (d && d.greet) || {});
  auW.data.nar = Object.assign({ country: {}, np: {} }, (d && d.nar) || {});
  if (!auW.data.np || !Array.isArray(auW.data.np.list)) auW.data.np = auDefaultData().np;
  auW.data.title = Object.assign(auDefaultData().title, (d && d.title) || {});
  return auW.data;
}
let auSaveT = null;
function auSave() { clearTimeout(auSaveT); auSaveT = setTimeout(() => { try { localStorage.setItem(AU_KEY, JSON.stringify(auW.data)); } catch (e) { toast('存档写入失败(容量?)', 'err'); } }, 300); }
let auRestored = false;
function auStateRestore() {
  if (auRestored) return; auRestored = true;
  auW.cbZoom = auZoomLoad();   // M5 整块缩放:独立 localStorage 键(sb.audio.cbZoom)
  const s = boardStateLoad(AU_STATE_KEY); if (!s) return;
  if (AU_INDS.some(o => o.key === s.industry)) auW.industry = s.industry;
  if (s.finToM >= 0 && s.finToM <= 12) auW.finToM = +s.finToM || 0;
  if (s.finUnit === 'USD' || s.finUnit === 'MUSD') auW.finUnit = s.finUnit;
  if (Array.isArray(s.finLv3Sel)) auW.finLv3Sel = s.finLv3Sel.slice();
  if (Array.isArray(s.finRepSel)) auW.finRepSel = s.finRepSel.slice();
  if (s.cbDim === 'product' || s.cbDim === 'model') auW.cb.dim = s.cbDim;
  if (+s.cbFromW > 0) auW.cb.fromW = +s.cbFromW; if (+s.cbToW > 0) auW.cb.toW = +s.cbToW;
}
function auStateSave() {
  boardStateSave(AU_STATE_KEY, () => ({
    industry: auW.industry, finToM: auW.finToM, finUnit: auW.finUnit,
    finLv3Sel: auW.finLv3Sel, finRepSel: auW.finRepSel,
    cbDim: auW.cb.dim, cbFromW: auW.cb.fromW, cbToW: auW.cb.toW,
  }));
}

/* ---------- R4 M5 整块缩放(卡片头 chip + 表头 + 表体一起)：Ctrl+滚轮 / 按钮 ----------
   用 zoom(与国家看板同款,最稳:不改变布局流,导出走原始数据不受影响)。
   范围 50%~200%,步进 5%,持久化到独立键 sb.audio.cbZoom。 */
const AU_ZOOM_MIN = 0.5, AU_ZOOM_MAX = 2, AU_ZOOM_STEP = 0.05;
function auZoomClamp(z) { const n = +z; return isFinite(n) && n > 0 ? Math.min(AU_ZOOM_MAX, Math.max(AU_ZOOM_MIN, Math.round(n * 100) / 100)) : 1; }
function auZoomLoad() { try { const z = parseFloat(localStorage.getItem(AU_ZOOM_LS)); return isFinite(z) && z > 0 ? auZoomClamp(z) : 1; } catch (e) { return 1; } }
function auZoomSave() { try { localStorage.setItem(AU_ZOOM_LS, String(auW.cbZoom)); } catch (e) { } }
// 应用到每个国家块整块(含 .cb-head 的名称/chip 与表格)
function auApplyZoom() {
  const host = document.getElementById('auCbList'); if (!host) return;
  host.querySelectorAll('.cb-card').forEach(c => { c.style.zoom = (auW.cbZoom === 1 ? '' : auW.cbZoom); });
  const lab = document.getElementById('auZoomVal'); if (lab) lab.textContent = Math.round(auW.cbZoom * 100) + '%';
}
function auSetZoom(z, silent) {
  const n = auZoomClamp(z);
  if (n === auW.cbZoom) { auApplyZoom(); return; }
  auW.cbZoom = n; auZoomSave(); auApplyZoom();
  if (!silent && typeof toast === 'function') toast('缩放 ' + Math.round(n * 100) + '%', 'ok');
}
// Ctrl+滚轮:必须 passive:false 才能 preventDefault(否则页面跟着滚)
function auBindZoomWheel(host) {
  if (!host || host._auZoomBound) return;
  host._auZoomBound = true;
  host.addEventListener('wheel', e => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    auSetZoom(auW.cbZoom + (e.deltaY < 0 ? AU_ZOOM_STEP : -AU_ZOOM_STEP), true);
  }, { passive: false });
}

/* ---------- R1 产业(音频/平板)：当前产业 + 维度值探测(只读) ---------- */
function auCurInd() { return AU_INDS.find(o => o.key === auW.industry) || AU_INDS[0]; }
function auIndustryLabel() { return auCurInd().label; }
// 在一串候选值里按产业规则挑一个:先精确(平板),再包含(音频)
function auPickIndVal(vals, ind) {
  const a = vals || [];
  return (ind.exact ? a.find(v => String(v) === ind.exact) : null) || a.find(v => ind.re.test(String(v))) || false;
}
// PSI 侧维度值(line 优先, 退 family);按产业缓存。原 auDetectAudioLine 的泛化版。
async function auDetectIndustryDim(kind) {
  const ind = AU_INDS.find(o => o.key === kind) || auCurInd();
  if (auW.indDim[ind.key] !== undefined) return auW.indDim[ind.key];
  let hit = false;
  try {
    for (const f of ['line', 'family']) {
      if (!state.dims.includes(f)) continue;
      const v = auPickIndVal(await api.options(f, {}), ind);
      if (v) { hit = { field: f, value: v }; break; }
    }
  } catch (e) { }
  auW.indDim[ind.key] = hit; return hit;
}
function auLineFilter() { const d = auW.indDim[auW.industry]; return d ? { [d.field]: [d.value] } : {}; }
/* 供导出侧(audio-export.js)取产业名:model.industry / model.industryLabel 的数据源 */
function auIndustryInfo() {
  const ind = auCurInd(), d = auW.indDim[ind.key];
  return { key: ind.key, label: ind.label, board: ind.board, finLv1: auW.finLv1[ind.key] || null, psiDim: d || null };
}
if (typeof window !== 'undefined') window.auIndustryInfo = auIndustryInfo;
// 切产业:清掉与产业绑定的取数缓存(选项/结果),状态入档后整屏重绘
function auSwitchIndustry(key) {
  if (key === auW.industry || !AU_INDS.some(o => o.key === key)) return;
  auW.industry = key;
  auW.finPb = null; auW.finRb = null; auW.prodOpts = []; auW.modelOpts = [];
  // M2/M3 里挂着旧产业的取值 → 一并清,否则「切到平板还筛着音频系列」会取空
  auW.finLv3Sel = []; auW.finRepSel = [];
  const B = auLoad().bounty;
  B.lineSel = []; B.familySel = []; B.seriesSel = []; B.prodSel = null; B.modelSel = [];
  auSave();
  auStateSave();
  // M4(audio-ind.js)自己维护一套筛选,交给它换掉产业维度值后再整屏重绘
  const done = () => renderAudio();
  if (typeof auIndSetIndustry === 'function') auIndSetIndustry(key).then(done, done); else done();
}

/* ---------- 样式注入(幂等,只加 .au-* 前缀类,不碰任何现有样式) ---------- */
function auInjectCSS() {
  if (typeof window.WeeklyNarrative !== 'undefined' && !document.getElementById('wkNarCss')) {
    const st = document.createElement('style'); st.id = 'wkNarCss'; st.textContent = window.WeeklyNarrative.CSS;
    document.head.appendChild(st);
  }
  if (document.getElementById('auCSS')) return;
  const st = document.createElement('style'); st.id = 'auCSS';
  st.textContent = `
  .au-sec{margin-bottom:26px}
  .au-sec-t{font-size:14px;font-weight:700;color:var(--c-ink-1);margin:4px 0 8px;display:flex;align-items:center;gap:10px;flex-wrap:wrap}
  .au-sec-t .au-note{font-size:11px;font-weight:400;color:var(--c-ink-3)}
  .au-toolbar{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin:0 0 8px}
  .au-toolbar label{font-size:11px;color:var(--c-ink-3)}
  .au-toolbar select,.au-toolbar input[type=date]{font-size:12px;padding:2px 6px;background:var(--c-bg-elev);color:var(--c-ink-1);border:1px solid var(--c-line);border-radius:6px}
  table.au-edit{border-collapse:collapse;font-size:12px;width:100%}
  table.au-edit th{background:var(--c-bg-sunken);color:var(--c-ink-2);font-weight:600;padding:5px 8px;border:1px solid var(--c-line);white-space:nowrap}
  table.au-edit td{border:1px solid var(--c-line);padding:2px 4px;vertical-align:middle}
  table.au-edit input,table.au-edit select{width:100%;box-sizing:border-box;border:1px solid transparent;background:transparent;color:var(--c-ink-1);font-size:12px;padding:3px 5px;border-radius:4px}
  table.au-edit input:focus,table.au-edit select:focus{border-color:var(--c-brand);background:var(--c-bg-elev);outline:none}
  table.au-edit td.au-ro{padding:4px 8px;text-align:right;white-space:nowrap}
  table.au-edit tr.au-total td{font-weight:700;background:var(--c-brand-soft)}
  .au-del{border:none;background:none;color:var(--c-ink-3);cursor:pointer;font-size:12px;padding:0 4px}
  .au-del:hover{color:var(--c-brand)}
  .au-add{margin-top:6px}
  .au-overdue input{color:var(--c-brand)!important;font-weight:600}
  .au-title-wrap{margin:2px 0 10px}
  .au-title-edit{min-height:34px;border:1px dashed transparent;border-radius:8px;padding:6px 10px;color:var(--c-ink-1);line-height:1.5}
  .au-title-edit:hover{border-color:var(--c-line)}
  .au-title-edit:focus{border-color:var(--c-brand);outline:none;background:var(--c-bg-elev)}
  .au-title-edit:empty:before{content:'点击输入本周产品维度总结(标题可自定义)…';color:var(--c-ink-3)}
  .au-empty{color:var(--c-ink-3);font-size:12px;padding:14px 4px}
  #view-audio .fa-wrap{overflow:auto}
  `;
  document.head.appendChild(st);
}

/* ============================================================
   入口
   ============================================================ */
function renderAudio() {
  auInjectCSS(); auLoad(); auStateRestore();
  const root = $('#auRoot'); if (!root) return;
  if (!auW.shell) {
    auW.shell = true;
    root.innerHTML =
      '<div class="au-toolbar" id="auIndBar" style="margin-bottom:2px">' +
      '  <label>产业</label><div class="seg" id="auIndSeg">' + AU_INDS.map(o => `<button data-ind="${o.key}">${o.label}</button>`).join('') + '</div>' +
      '  <span class="au-note" id="auIndNote"></span>' +
      '</div>' +
      '<div class="au-toolbar" id="auMailBar" style="margin-bottom:2px;flex-wrap:wrap;gap:6px"></div>' +
      '<div class="au-toolbar" id="auExportBar" style="justify-content:flex-end;margin-bottom:2px">' +
      '  <span class="au-note">一键导出整份周报 ▸</span>' +
      '  <button class="btn" id="auExpPpt">📑 PPT</button>' +
      '  <button class="btn" id="auExpPdf">📄 PDF</button>' +
      '  <button class="btn" id="auExpEml">✉️ Outlook 邮件(.eml)</button>' +
      '</div>' +
      '<div class="au-toolbar" id="auGreetBar" style="margin-bottom:2px;flex-wrap:wrap;gap:6px"></div>' +
      '<div class="au-sec" id="auSecIssues"></div>' +
      '<div class="au-sec" id="auSecFin"></div>' +
      '<div class="au-sec" id="auSecSalesHead"></div>' +
      '<div class="au-sec" id="auSecOverallNar"></div>' +
      '<div class="au-sec" id="auSecInd"></div>' +
      '<div class="au-sec" id="auSecFamily"></div>' +
      '<div class="au-sec" id="auSecRep"></div>' +
      '<div class="au-sec" id="auSecCountry"></div>' +
      '<div class="au-sec" id="auSecBounty"></div>' +
      '<div class="au-sec" id="auSecNewprod"></div>' +
      '<div class="au-sec" id="auSecBlocks" style="display:none"></div>';
    $('#auExpPpt').onclick = () => window.auExportWeeklyPpt && window.auExportWeeklyPpt().catch(e => toast('PPT 导出失败:' + e.message, 'err'));
    $('#auExpPdf').onclick = () => window.auExportWeeklyPdf && window.auExportWeeklyPdf().catch(e => toast('PDF 导出失败:' + e.message, 'err'));
    $('#auExpEml').onclick = () => window.auExportWeeklyEml && window.auExportWeeklyEml().catch(e => toast('邮件导出失败:' + e.message, 'err'));
    const seg = $('#auIndSeg');
    if (seg) seg.querySelectorAll('button').forEach(b => b.onclick = () => auSwitchIndustry(b.dataset.ind));
  }
  auSyncIndSeg();
  renderAuMail();
  renderAuGreet();
  renderAuIssues();
  renderAuFin();
  renderAuSalesHead();
  renderAuOverallNar();
  if (typeof renderAuInd === 'function') auTrack('ind', renderAuInd());
  auTrack('fam', renderAuDim('family'));
  auTrack('rep', renderAuDim('repOffice'));
  renderAuCountry();
  renderAuBounty();
  if (typeof renderAuNewprod === 'function') auTrack('np', renderAuNewprod());
}

/* ---------- v3 模板令牌：{week}=W周号、{产业}=音频/平板 ---------- */
function auWeekShort() {
  const d = new Date();
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dn = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - dn);
  const y0 = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  return 'W' + String(Math.ceil(((t - y0) / 86400000 + 1) / 7)).padStart(2, '0');
}
function auTplResolve(tpl) {
  return String(tpl == null ? '' : tpl).split('{week}').join(auWeekShort()).split('{产业}').join(auIndustryLabel());
}
if (typeof window !== 'undefined') { window.auTplResolve = auTplResolve; window.auWeekShort = auWeekShort; }

/* 问候两行 + 大表标题（可编辑模板，导出时替换令牌） */
function renderAuGreet() {
  const host = $('#auGreetBar'); if (!host) return;
  const D = auLoad(), G = D.greet;
  host.innerHTML = '<label style="white-space:nowrap">问候</label>'
    + '<input id="auGreet1" value="' + auEsc(G.l1) + '" style="flex:2;min-width:280px" title="{week}/{产业} 导出时自动替换；当前→' + auEsc(auTplResolve(G.l1)) + '">'
    + '<label style="white-space:nowrap">安全声明</label>'
    + '<input id="auGreet2" value="' + auEsc(G.l2) + '" style="flex:2;min-width:240px">'
    + '<label style="white-space:nowrap">大表标题</label>'
    + '<input id="auGreetT" value="' + auEsc(G.titleTpl) + '" style="flex:1;min-width:170px" title="当前→' + auEsc(auTplResolve(G.titleTpl)) + '">';
  const bind = (id, k) => { const el = $(id); if (el) el.onchange = () => { G[k] = el.value; auSave(); }; };
  bind('#auGreet1', 'l1'); bind('#auGreet2', 'l2'); bind('#auGreetT', 'titleTpl');
}

/* 销售进展大标题 + 悬赏奖开关（用户拍板：保留可选、默认隐藏） */
function renderAuSalesHead() {
  const host = $('#auSecSalesHead'); if (!host) return;
  const D = auLoad();
  host.innerHTML = '<div class="au-sec-t" style="font-size:15px">销售进展'
    + '<span class="au-note"><label style="cursor:pointer"><input type="checkbox" id="auBountyChk"' + (D.showBounty ? ' checked' : '') + '> 含悬赏奖模块</label></span></div>';
  const chk = $('#auBountyChk');
  if (chk) chk.onchange = () => { D.showBounty = chk.checked; auSave(); renderAuBounty(); };
}

/* 叙述编辑器：料架内容按 scope 组装 */
function auNarPalette(level, value) {
  const sc = k => ({ cfg: { id: k, scope: { level: level, value: value } } });
  const base = [sc('soYoy'), sc('siYoy'), sc('wow'), sc('weekSo'), sc('cumSo'), sc('dos'), sc('flowDos'), { cfg: { id: 'week' } }];
  if (level === 'total') return base;
  return base.concat([sc('topRise'), sc('topFall'),
    { cfg: { id: 'streakUp', n: 4, scope: { level: level, value: value } } },
    { cfg: { id: 'streakDown', n: 4, scope: { level: level, value: value } } },
    { cfg: { id: 'dosOver', x: 120, scope: { level: level, value: value } } },
    { cfg: { id: 'dosOver', x: 150, scope: { level: level, value: value } } },
    { cfg: { id: 'flowDosOver', x: 200, scope: { level: level, value: value } } }]);
}
/* 默认叙述 = 用户邮件里的句式，XX 全部换成芯片 */
function auDefaultNar(kind, value) {
  const W = window.WeeklyChips;
  const lv = kind === 'overall' ? 'total' : (kind === 'country' ? 'country' : kind);
  const sc = (id, extra) => ({ chip: Object.assign({ id: id }, extra || {}, { scope: { level: lv, value: value } }) });
  if (kind === 'overall') return W.docFromTemplate([
    '大区整体销售：', { chip: { id: 'week' } }, ' WoW', sc('wow'),
    '，SO同比', sc('soYoy'), '，当前Sell in同比', sc('siYoy'),
    '，渠道DOS', sc('dos'), '天，全流程DOS', sc('flowDos'), '天。',
  ]);
  if (kind === 'fam') return W.docFromTemplate([
    '系列销售情况：', sc('topRise'), '系列WoW涨幅最大，', sc('topFall'), '系列跌幅最大；',
    sc('streakDown', { n: 4 }), '连续4周周销下滑。',
  ]);
  if (kind === 'rep') return W.docFromTemplate([
    '国家办销售情况：截止', { chip: { id: 'week' } },
    '，SO同比', { chip: { id: 'soYoy', scope: { level: 'total' } } },
    '，WoW', { chip: { id: 'wow', scope: { level: 'total' } } },
    '，', sc('topRise'), 'WoW涨幅最大，', sc('topFall'), '跌幅最大，',
    sc('streakUp', { n: 4 }), '连续4周周销持续上涨，', sc('streakDown', { n: 4 }), '连续4周周销持续下滑；',
    sc('dosOver', { x: 120 }), '渠道DOS超120天，', sc('dosOver', { x: 150 }), '渠道DOS超150天，',
    sc('flowDosOver', { x: 200 }), '全流程DOS超200天。',
  ]);
  return W.docFromTemplate([
    (value || '') + '：截止', { chip: { id: 'week' } },
    '，SO同比', sc('soYoy'), '，WoW', sc('wow'),
    '，', sc('topRise'), 'WoW涨幅最大，', sc('topFall'), '跌幅最大，',
    sc('streakUp', { n: 4 }), '连续4周持续上涨，', sc('streakDown', { n: 4 }), '连续4周持续下滑；',
    sc('dosOver', { x: 120 }), '渠道DOS超120天，', sc('dosOver', { x: 150 }), '渠道DOS超150天，',
    sc('flowDosOver', { x: 200 }), '全流程DOS超200天。',
  ]);
}
function auMountNar(host, narKey, kind, value) {
  if (!host || typeof window.WeeklyNarrative === 'undefined' || typeof window.WeeklyChips === 'undefined') return;
  const D = auLoad();
  let doc = kind === 'country' ? D.nar.country[value] : D.nar[narKey];
  if (!doc) {
    doc = auDefaultNar(kind, value);
    if (kind === 'country') D.nar.country[value] = doc; else D.nar[narKey] = doc;
    auSave();
  }
  window.WeeklyNarrative.mount(host, {
    doc: doc,
    palette: auNarPalette(kind === 'overall' ? 'total' : (kind === 'country' ? 'country' : kind), value),
    onChange: function (d) {
      if (kind === 'country') D.nar.country[value] = d; else D.nar[narKey] = d;
      auSave();
    },
  });
}
function renderAuOverallNar() { const h = $('#auSecOverallNar'); if (h) { h.innerHTML = ''; auMountNar(h, 'overall', 'overall'); } }

/* 系列/国家办汇总表（口径同国家块，只换分组维）+ 各自叙述 */
async function renderAuDim(dim) {
  const host = dim === 'family' ? $('#auSecFamily') : $('#auSecRep');
  if (!host) return;
  const key = dim === 'family' ? 'fam' : 'rep';
  auW[key + 'Rep'] = null;                                    // 先清后填(与 renderAuFin 同理)
  const lab = dim === 'family' ? '系列' : '国家办';
  host.innerHTML = '<div data-nar></div><div class="fa-wrap" data-tbl>取数中…</div>';
  auMountNar(host.querySelector('[data-nar]'), key, key);
  if (!state.dims.length) { host.querySelector('[data-tbl]').innerHTML = '<div class="au-empty">请先锚定 PSI 数据。</div>'; return; }
  let r = null;
  try { r = await api.report({ groupDim: dim, weeks: auW.cb.weeks, fromW: auW.cb.fromW, toW: auW.cb.toW, filters: Object.assign({}, auLineFilter()) }); } catch (e) { }
  auW[key + 'Rep'] = r;
  const tHost = host.querySelector('[data-tbl]');
  if (!r || !(r.rows || []).length) { if (tHost) tHost.innerHTML = '<div class="au-empty">无数据</div>'; auChipsRefresh(); return; }
  if (tHost) tHost.innerHTML = auDimTableHtml(lab, r, dim);
  auChipsRefresh();
}
function auDimTableHtml(firstLabel, r, dim) {
  const cols = auCbColumns(r, dim);
  const ki = cols.findIndex(function (c) { return c.key === 'key'; });
  if (ki >= 0) cols[ki].label = firstLabel;
  const rows = auCbSortRows(r, cols);
  let h = '<table class="rep-table" style="width:100%"><thead><tr>' + cols.map(function (c) { return '<th>' + c.label + '</th>'; }).join('') + '</tr></thead><tbody>';
  rows.forEach(function (o) { h += '<tr>' + cols.map(function (c) { return '<td>' + (c.totalOnly ? '<span class="wk">—</span>' : c.cell(o)) + '</td>'; }).join('') + '</tr>'; });
  if (r.total) h += '<tr class="tot">' + cols.map(function (c) { return '<td>' + (c.key === 'key' ? '合计' : (c.key === '__line' ? '' : c.cell(r.total))) + '</td>'; }).join('') + '</tr>';
  return h + '</tbody></table>';
}

/* 芯片上下文：各模块缓存 → WeeklyChips ctx */
function auChipCtx() {
  const scope = function (r) { return r ? { total: r.total || {}, rows: r.rows || [] } : null; };
  const country = {};
  (auW.cbLast || []).forEach(function (x) { country[x.v] = scope(x.r); });
  const pb = auW.finPb;
  return {
    week: auWeekShort(),
    finTitle: pb ? { ym: pb.curYear + '-' + String(pb.toM).padStart(2, '0'), fcVer: pb.version || '—' } : {},
    scopes: {
      total: scope(auW.famRep) || scope(auW.repRep),
      family: scope(auW.famRep),
      rep: scope(auW.repRep),
      country: country,
      np: (typeof auNpChipScopes === 'function') ? auNpChipScopes() : {},
    },
  };
}
function auChipsRefresh() {
  if (typeof window.WeeklyNarrative === 'undefined') return;
  try { window.WeeklyNarrative.refreshAll(document.getElementById('auRoot'), auChipCtx()); } catch (e) { }
}
if (typeof window !== 'undefined') { window.auChipCtx = auChipCtx; window.auChipsRefresh = auChipsRefresh; }
// 产业段控高亮 + 说明(切换后 M2/M3/M4/M5 与标题、导出名全部跟随)
function auSyncIndSeg() {
  const seg = $('#auIndSeg'); if (!seg) return;
  seg.querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.ind === auW.industry));
  const note = $('#auIndNote');
  if (note) note.textContent = '切换后 M2 财经 LV1 / M3 SI 筛选 / M4 种子 / M5 国家块 全部跟随「' + auIndustryLabel() + '」';
}

/* ============================================================
   M1 遗留问题(可编辑表)
   ============================================================ */
/* 收件人 / 抄送 / 主题 —— 存进存档，下次开软件还在。
   用户的用法是：在工作电脑上打开上一封周报，把收件人栏整段复制粘贴进来。
   所以这里不做任何格式校验，原样收下；到导出 .eml 时才由 formatAddrList 规范化
   （分号转逗号、中文显示名按 RFC2047 编码），避免在输入时跟用户较劲。 */
function renderAuMail() {
  const host = $('#auMailBar'); if (!host) return;
  const D = auLoad(), M = D.mail || (D.mail = { to: '', cc: '', subject: '' });
  const defSubj = auIndustryLabel() + '产业周报 ' + auIsoWeekStr();
  host.innerHTML =
    '<label style="white-space:nowrap">收件人</label>'
    + '<input id="auMailTo" value="' + auEsc(M.to) + '" placeholder="从 Outlook 复制粘贴即可，支持「张三 &lt;a@x.com&gt;; 李四 &lt;b@x.com&gt;」" style="flex:1;min-width:260px">'
    + '<label style="white-space:nowrap">抄送</label>'
    + '<input id="auMailCc" value="' + auEsc(M.cc) + '" placeholder="可留空" style="flex:1;min-width:200px">'
    + '<label style="white-space:nowrap">主题</label>'
    + '<input id="auMailSubj" value="' + auEsc(M.subject) + '" placeholder="' + auEsc(defSubj) + '" style="flex:1;min-width:200px" title="留空则用默认：' + auEsc(defSubj) + '">';
  const bind = (id, k) => { const el = $(id); if (el) el.onchange = () => { M[k] = el.value; auSave(); }; };
  bind('#auMailTo', 'to'); bind('#auMailCc', 'cc'); bind('#auMailSubj', 'subject');
}
// 当前 ISO 周标签（与导出模型同一口径）
function auIsoWeekStr() {
  const d = new Date();
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dn = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - dn);
  const y0 = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  const wk = Math.ceil(((t - y0) / 86400000 + 1) / 7);
  return t.getUTCFullYear() + '-W' + String(wk).padStart(2, '0');
}
function renderAuIssues() {
  const host = $('#auSecIssues'); if (!host) return;
  const D = auLoad();
  const today = todayStr();
  /* 排序：有风险 → 已超期 → 按截止时间近的在前 → 已闭环沉底。
     周报第一段就是这张表，最该被看见的必须排在最上面，而不是按录入顺序。
     排序只影响显示与导出，不动存档里的原始顺序（用 idx 回指原行）。 */
  const rank = r => (r.status === '已闭环' ? 3 : (r.status === '有风险' ? 0 : ((r.due && r.due < today) ? 1 : 2)));
  const view = D.issues.map((r, idx) => ({ r, idx })).sort((a, b) => {
    const ra = rank(a.r), rb = rank(b.r);
    if (ra !== rb) return ra - rb;
    const da = a.r.due || '9999-12-31', db = b.r.due || '9999-12-31';
    return da < db ? -1 : (da > db ? 1 : a.idx - b.idx);
  });
  const dayDiff = due => {
    if (!due) return null;
    return Math.round((Date.parse(due + 'T00:00:00') - Date.parse(today + 'T00:00:00')) / 86400000);
  };
  const rowHtml = ({ r, idx }) => {
    const i = idx;
    const dd = dayDiff(r.due), closed = r.status === '已闭环';
    const over = dd != null && dd < 0 && !closed;
    const soon = dd != null && dd >= 0 && dd <= 7 && !closed;
    const tip = closed ? '已闭环' : (dd == null ? '' : (dd < 0 ? '已超期 ' + (-dd) + ' 天' : (dd === 0 ? '今天到期' : '还剩 ' + dd + ' 天')));
    const typeOpts = AU_ISSUE_TYPES.concat(AU_ISSUE_TYPES.includes(r.type) || !r.type ? [] : [r.type]);
    const stOpts = AU_ISSUE_STATUS.concat(AU_ISSUE_STATUS.includes(r.status) || !r.status ? [] : [r.status]);
    return `<tr${closed ? ' style="opacity:.55"' : ''}>
      <td style="width:76px"><select data-i="${i}" data-k="type">${typeOpts.map(t => `<option ${t === r.type ? 'selected' : ''}>${t}</option>`).join('')}</select></td>
      <td><input data-i="${i}" data-k="todo" value="${auEsc(r.todo)}" placeholder="重点工作/通知"></td>
      <td><input data-i="${i}" data-k="prog" value="${auEsc(r.prog)}" placeholder="进展"></td>
      <td style="width:84px"><select data-i="${i}" data-k="status">${stOpts.map(t => `<option ${t === (r.status || '进行中') ? 'selected' : ''}>${t}</option>`).join('')}</select></td>
      <td style="width:132px" class="${over ? 'au-overdue' : ''}"><input type="date" data-i="${i}" data-k="due" value="${auEsc(r.due)}" title="${auEsc(tip)}">${tip ? `<div style="font-size:10px;color:${over ? 'var(--c-brand)' : (soon ? '#C98A00' : 'var(--c-ink-3)')}">${auEsc(tip)}</div>` : ''}</td>
      <td style="width:150px"><input data-i="${i}" data-k="geo" value="${auEsc(r.geo)}" placeholder="所有国家/某国家办"></td>
      <td style="width:24px"><button class="au-del" data-del="${i}" title="删除此行">✕</button></td>
    </tr>`;
  };
  const nOver = D.issues.filter(r => r.status !== '已闭环' && r.due && r.due < today).length;
  const nRisk = D.issues.filter(r => r.status === '有风险').length;
  const nOpen = D.issues.filter(r => r.status !== '已闭环').length;
  const badge = D.issues.length
    ? `　<b>${nOpen}</b> 项未闭环` + (nRisk ? `　<span style="color:var(--c-brand)"><b>${nRisk}</b> 项有风险</span>` : '')
      + (nOver ? `　<span style="color:var(--c-brand)"><b>${nOver}</b> 项已超期</span>` : '')
    : '';
  host.innerHTML = '<div class="au-sec-t">本周重点关注<span class="au-note">直接在表格里录入/修改，自动保存进存档；有风险与已超期自动排到最上面，已闭环沉底' + badge + '</span></div>'
    + '<div class="fa-wrap"><table class="au-edit"><thead><tr><th>类型</th><th>重点工作/通知</th><th>进展</th><th>状态</th><th>截止时间</th><th>涉及国家办/国家</th><th></th></tr></thead><tbody>'
    + (view.length ? view.map(rowHtml).join('') : '<tr><td colspan="7" class="au-empty">暂无遗留问题，点下方「＋加一行」</td></tr>')
    + '</tbody></table></div>'
    + '<button class="btn au-add" id="auIssueAdd">＋加一行</button>';
  host.querySelectorAll('input,select').forEach(el => {
    el.onchange = () => { const i = +el.dataset.i, k = el.dataset.k; if (D.issues[i]) { D.issues[i][k] = el.value; auSave(); if (k === 'due' || k === 'status') renderAuIssues(); } };
  });
  host.querySelectorAll('[data-del]').forEach(b => b.onclick = () => { D.issues.splice(+b.dataset.del, 1); auSave(); renderAuIssues(); });
  $('#auIssueAdd').onclick = () => { D.issues.push({ type: '要货', todo: '', prog: '', status: '进行中', due: '', geo: '所有国家' }); auSave(); renderAuIssues(); };
}
/* 导出用：与界面同一套排序，外加「已超期 N 天」这种人读得懂的说明 */
function auIssuesForExport() {
  const D = auLoad(), today = todayStr();
  const rank = r => (r.status === '已闭环' ? 3 : (r.status === '有风险' ? 0 : ((r.due && r.due < today) ? 1 : 2)));
  return D.issues.slice().sort((a, b) => {
    const ra = rank(a), rb = rank(b);
    if (ra !== rb) return ra - rb;
    return (a.due || '9999-12-31') < (b.due || '9999-12-31') ? -1 : 1;
  }).map(r => {
    const dd = r.due ? Math.round((Date.parse(r.due + 'T00:00:00') - Date.parse(today + 'T00:00:00')) / 86400000) : null;
    const note = r.status === '已闭环' ? '' : (dd == null ? '' : (dd < 0 ? '已超期' + (-dd) + '天' : (dd <= 7 ? '剩' + dd + '天' : '')));
    return { type: r.type || '', todo: r.todo || '', prog: r.prog || '', status: r.status || '进行中',
      due: (r.due || '') + (note ? '（' + note + '）' : ''), geo: r.geo || '' };
  });
}
function auEsc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;'); }

/* ============================================================
   M2 音频产业经营进展(port 自 finance-view 的 finPbTable/FIN_PB_COLS,自包含副本)
   ============================================================ */
const AU_FIN_UNIT_DIV = { USD: 1, MUSD: 1e6 }, AU_FIN_UNIT_SYM = { USD: '$', MUSD: '' }, AU_FIN_UNIT_SUF = { USD: '', MUSD: 'M' };
function auFmtAmt(v) { if (v == null || !isFinite(v)) return '—'; const d = AU_FIN_UNIT_DIV[auW.finUnit] || 1; return (AU_FIN_UNIT_SYM[auW.finUnit] || '') + (v / d).toLocaleString('en-US', { minimumFractionDigits: auW.finDp, maximumFractionDigits: auW.finDp }) + (AU_FIN_UNIT_SUF[auW.finUnit] || ''); }
function auFmtNsip(v) { if (v == null || !isFinite(v)) return '—'; return '$' + v.toLocaleString('en-US', { minimumFractionDigits: auW.finDp, maximumFractionDigits: auW.finDp }); }
function auFinPct(v) { if (v == null || !isFinite(v)) return '<span class="wk">—</span>'; const c = v >= 1 ? 'pos' : (v >= 0.9 ? '' : 'neg'); return `<span class="${c}">${(v * 100).toFixed(auW.finDp)}%</span>`; }
function auYoyPct(v) { if (v == null || !isFinite(v)) return '<span class="wk">—</span>'; return `<span class="${v >= 0 ? 'pos' : 'neg'}">${(v >= 0 ? '+' : '') + (v * 100).toFixed(auW.finDp)}%</span>`; }
function auRate(v) { return v == null || !isFinite(v) ? '—' : (v * 100).toFixed(auW.finDp) + '%'; }
function auSignNsip(v) { if (v == null || !isFinite(v)) return '<span class="wk">—</span>'; return `<span class="${v >= 0 ? 'pos' : 'neg'}">${(v >= 0 ? '+' : '') + auFmtNsip(v)}</span>`; }
const AU_FIN_COLS = [
  { key: 'rev25', label: '25年收入', fmt: o => auFmtAmt(o.rev25) },
  { key: 'rev26', label: '26年收入', fmt: o => auFmtAmt(o.rev26) },
  { key: 'revYoy', label: '收入同比', fmt: o => auYoyPct(o.revYoy) },
  { key: 'gm25', label: '25年销毛额', sep: true, fmt: o => auFmtAmt(o.gm25) },
  { key: 'gm26', label: '26年销毛额', fmt: o => auFmtAmt(o.gm26) },
  { key: 'gmYoy', label: '销毛额同比', fmt: o => auYoyPct(o.gmYoy) },
  { key: 'gmr25', label: '25年销毛率', sep: true, fmt: o => auRate(o.gmr25) },
  { key: 'gmr26', label: '26年销毛率', fmt: o => auRate(o.gmr26) },
  { key: 'nsip25', label: '25年NSIP', sep: true, fmt: o => auFmtNsip(o.nsip25) },
  { key: 'nsip26', label: '26年NSIP', fmt: o => auFmtNsip(o.nsip26) },
  { key: 'nsipYoy', label: 'NSIP同比', fmt: o => auSignNsip(o.nsipYoy) },
  { key: 'bp', label: '全年BP', sep: true, fmt: o => auFmtAmt(o.bp) },
  { key: 'bpAttain', label: 'BP达成率', fmt: o => auFinPct(o.bpAttain) },
  { key: 'fc', label: '全年预测', sep: true, fmt: o => auFmtAmt(o.fc) },
  { key: 'fcAttain', label: '全年预测达成率', fmt: o => auFinPct(o.fcAttain) },
];
function auFinTable(firstLabel, block, isSeries) {
  if (!block) return '';
  const cols = AU_FIN_COLS;
  const thead = '<tr><th class="lft">' + firstLabel + '</th>' + cols.map(c => `<th class="${c.sep ? 'col-sep' : ''}">${c.label}</th>`).join('') + '</tr>';
  const rowHtml = (o, cls) => '<tr class="' + (cls || '') + '"><td class="lft">' + o.key + '</td>' + cols.map(c => `<td class="${c.sep ? 'col-sep' : ''}">${c.fmt(o)}</td>`).join('') + '</tr>';
  let rows = (block.rows || []).slice();
  if (isSeries) rows.sort((a, b) => { const ra = seriesRank(a.key), rb = seriesRank(b.key); return ra !== rb ? ra - rb : ((b.rev26 || 0) - (a.rev26 || 0)); });
  let body = ''; if (block.total) body += rowHtml(block.total, 'tot');
  body += rows.map(o => rowHtml(o)).join('');
  return '<table class="fa-table"><thead>' + thead + '</thead><tbody>' + body + '</tbody></table>';
}
// 财经调用参数：与经营分析看板同一套单位假设(实际USD/预测MUSD/BP USD,数量台);产业=LV1 按 AU_INDS 规则命中
const AU_FIN_UNITS = { actual: 'USD', forecast: 'MUSD', bp: 'USD' }, AU_FIN_QTY_UNITS = { actual: '台', forecast: '台', bp: '台' };
// 当前产业对应的 financeProductBoard 分组块:平板=famTablet(lv1==='平板')、音频=famAudio(lv1 含"音频")
function auFinBlock(pb) { return pb ? (auW.industry === 'tablet' ? pb.famTablet : pb.famAudio) : null; }
if (typeof window !== 'undefined') window.auFinBlock = auFinBlock;
// financeOverview().dims(lv1/lv2/lv3/lv4/reps)——全量维度值,只取一次
async function auFinDims() {
  if (auW.finDims) return auW.finDims;
  try { const ov = await api.financeOverview({}); auW.finDims = ((ov || {}).dims) || {}; }
  catch (e) { auW.finDims = {}; }
  return auW.finDims;
}
async function auFinLv1() {
  const k = auW.industry;
  if (auW.finLv1[k] !== undefined) return auW.finLv1[k];
  const dims = await auFinDims();
  auW.finLv1[k] = auPickIndVal(dims.lv1 || [], auCurInd());
  return auW.finLv1[k];
}
// 当前产业下的 LV3 全量清单(产品系列多选的选项池)。不带 lv3 筛选取一次,按产业缓存,
// 之后即使用户选了子集也不会把选项池收窄(否则选完就再也放不回去)。
async function auFinLv3Opts(lv1) {
  const k = auW.industry;
  if (auW.finLv3Opts[k]) return auW.finLv3Opts[k];
  let out = [];
  try {
    const pb = await api.financeProductBoard({ fromM: 1, lv1: [lv1], finUnits: AU_FIN_UNITS, finQtyUnits: AU_FIN_QTY_UNITS });
    const blk = auFinBlock(pb);
    out = ((blk && blk.rows) || []).map(o => o.key);
  } catch (e) { }
  auW.finLv3Opts[k] = out; return out;
}
function renderAuFin() { return auTrack('fin', renderAuFinImpl()); }
async function renderAuFinImpl() {
  const host = $('#auSecFin'); if (!host) return;
  auW.finPb = null; auW.finBlk = null; auW.finRb = null;   // 先清后填:任何早退都不能把上一轮留给导出
  const lab = auIndustryLabel();
  const head = (extra) => '<div class="au-sec-t" id="auFinHead">全年达成进度（产业经营）' + (extra || '') + '</div>';
  if (!state.finMeta) { host.innerHTML = head() + '<div class="au-empty">未导入财经数据(经营分析底表)。到「数据源」挂载后这里自动出表。</div>'; return; }
  const lv1 = await auFinLv1();
  if (!lv1) { host.innerHTML = head() + '<div class="au-empty">财经数据里没找到「' + lab + '」产业(LV1)。</div>'; return; }
  const mSel = `<select id="auFinToM">${['<option value="0">截止最新实际月</option>'].concat(Array.from({ length: 12 }, (_, i) => `<option value="${i + 1}" ${auW.finToM === i + 1 ? 'selected' : ''}>截止${i + 1}月</option>`)).join('')}</select>`;
  const uSel = `<select id="auFinUnit"><option value="USD" ${auW.finUnit === 'USD' ? 'selected' : ''}>USD</option><option value="MUSD" ${auW.finUnit === 'MUSD' ? 'selected' : ''}>MUSD(百万)</option></select>`;
  host.innerHTML = head(`<span class="au-note" id="auFinNote">取数中…</span>`)
    + `<div class="au-toolbar"><label>月份</label>${mSel}<label>金额单位</label>${uSel}</div>`
    + '<div class="au-toolbar" id="auFinFilters"></div><div id="auFinTables"></div>';
  $('#auFinToM').value = String(auW.finToM);
  $('#auFinToM').onchange = e => { auW.finToM = +e.target.value || 0; auStateSave(); renderAuFin(); };
  $('#auFinUnit').onchange = e => { auW.finUnit = e.target.value; auStateSave(); renderAuFin(); };
  // R2 两个筛选的选项池 + 生效值(与选项求交:切产业后上一个产业的选择自然失效,原值仍留在存档里)
  const lv3Opts = await auFinLv3Opts(lv1);
  const dims = await auFinDims(), repOpts = dims.reps || [];
  const selLv3 = (auW.finLv3Sel || []).filter(v => lv3Opts.includes(v));
  const selReps = (auW.finRepSel || []).filter(v => repOpts.includes(v));
  const fbar = $('#auFinFilters');
  if (fbar && lv3Opts.length) fbar.appendChild(makeMultiSelect('产品系列(LV3)', lv3Opts, selLv3, {
    placeholder: '全部系列', onChange: () => { }, onCommit: vals => { auW.finLv3Sel = vals; auStateSave(); renderAuFin(); },
  }));
  if (fbar && repOpts.length) fbar.appendChild(makeMultiSelect('国家办', repOpts, selReps, {
    placeholder: '全部国家办', onChange: () => { }, onCommit: vals => { auW.finRepSel = vals; auStateSave(); renderAuFin(); },
  }));
  const p = { fromM: 1, toM: auW.finToM || undefined, lv1: [lv1], finUnits: AU_FIN_UNITS, finQtyUnits: AU_FIN_QTY_UNITS };
  if (selLv3.length) p.lv3 = selLv3;
  const pb = await api.financeProductBoard(p);
  auW.finPb = pb;
  const blk = auFinBlock(pb);
  auW.finBlk = blk;   // 导出侧直接取「当前产业的那张系列表」,不用再自己判断 famAudio/famTablet
  const box = $('#auFinTables'); if (!box) return;
  if (!pb || pb.error || !blk) { box.innerHTML = '<div class="au-empty">取数失败' + (pb && pb.error ? ':' + pb.error : '') + '</div>'; return; }
  const prog = (pb.toM - pb.fromM + 1) / 12;
  const note = $('#auFinNote'); if (note) note.textContent = `月度刷新-${pb.curYear}-${String(pb.toM).padStart(2, '0')}（预测为${pb.version || '—'}） · ${pb.fromM}~${pb.toM}月实际 · 时间进度 ${(prog * 100).toFixed(0)}%`;
  let html = `<div class="au-sec-t" style="font-size:12px">分产品系列(${lab} LV3)</div><div class="fa-wrap">` + auFinTable('系列', blk, true) + '</div>';
  // 国家办表:financeRepBoard 不支持 lv1 → 用本产业 LV3 名集作为 series 过滤(只读间接筛,零引擎改动);
  // 用户选了产品系列则只传选中的那几个,两张表口径一致。
  const seriesNames = selLv3.length ? selLv3.slice() : (lv3Opts.length ? lv3Opts.slice() : (blk.rows || []).map(o => o.key));
  const rp = { fromM: 1, toM: auW.finToM || undefined, series: seriesNames, finUnits: AU_FIN_UNITS, finQtyUnits: AU_FIN_QTY_UNITS };
  if (selReps.length) rp.reps = selReps;
  const rb = seriesNames.length ? await api.financeRepBoard(rp) : null;
  auW.finRb = rb;
  if (rb && !rb.error && rb.repTable) html += `<div class="au-sec-t" style="font-size:12px;margin-top:14px">分国家办(${lab})</div><div class="fa-wrap">` + auFinTable('国家办', rb.repTable, false) + '</div>';
  box.innerHTML = html;
}

/* ============================================================
   M3 $0-50 悬赏奖 SI 进展(累计SI=Sell-in;时间进度=自然日/365)
   ============================================================ */
function auAW() { return (typeof window !== 'undefined' && window.AudioWeekly) ? window.AudioWeekly : null; }
/* R3 多级筛选:产品线/Family/系列/产品/型号 五级级联多选(标签沿用旧文案,保住 i18n 词条) */
const AU_BOUNTY_FIELDS = [
  { f: 'line', lab: 'SI产品线', ph: '跟随产业' },
  { f: 'family', lab: 'SI Product Family', ph: '不限' },
  { f: 'series', lab: 'SI产品系列', ph: '不限' },
  { f: 'product', lab: 'SI产品(Product Name)', ph: '全部产品' },
  { f: 'model', lab: 'SI型号(可再收窄)', ph: '不限型号' },
];
const AU_BOUNTY_SELKEY = { line: 'lineSel', family: 'familySel', series: 'seriesSel', product: 'prodSel', model: 'modelSel' };
function auBountySel(B, field) { const v = B[AU_BOUNTY_SELKEY[field]]; return Array.isArray(v) ? v : []; }
async function auEnsureCtryOpts() {
  if (auW.ctryOpts.length || !state.dims.includes('country')) return;
  try { auW.ctryOpts = await api.options('country', {}) || []; } catch (e) { }
}
/* 逐级取可选值 + 求交出生效值。
   - 选项 = api.options(field, 上游已生效的其它筛选)(引擎本身会排除该字段自身的条件);
   - 产业默认线只作基底,用户在同一字段上手选即覆盖它(所以查该字段选项时不带产业条件);
   - product 未手选过(null)且产业=音频 → 落默认产品集 SE2/SE3/SE4。
   返回 {opts:{字段:[]}, eff:{字段:[生效值]}, defaulted:bool} */
async function auBountyResolve(B) {
  const AW = auAW(), ind = auW.indDim[auW.industry];
  const opts = {}, eff = {}; let defaulted = false;
  for (const d of AU_BOUNTY_FIELDS) {
    if (!state.dims.includes(d.f)) continue;
    const base = Object.assign({}, (ind && ind.field !== d.f) ? auLineFilter() : {}, eff);
    let list = [];
    try { list = sortByHier(d.f, await api.options(d.f, base) || []); } catch (e) { }
    opts[d.f] = list;
    let cur = auBountySel(B, d.f).filter(v => list.includes(v));
    if (d.f === 'product' && B.prodSel === null) { cur = (AW && auW.industry === 'audio') ? AW.defaultPick(list) : []; defaulted = true; }
    if (cur.length) eff[d.f] = cur;
  }
  return { opts, eff, defaulted };
}
function renderAuBounty() { return auTrack('bounty', renderAuBountyImpl()); }
async function renderAuBountyImpl() {
  const host = $('#auSecBounty'); if (!host) return;
  auW._bountyExport = null;                                // 先清后填,理由同 renderAuFin
  const D = auLoad(), B = D.bounty, AW = auAW();
  // 用户拍板(2026-08-21)：悬赏奖保留可选、默认隐藏——邮件版式里没有这一段
  if (!D.showBounty) { host.innerHTML = ''; return; }
  const head = extra => '<div class="au-sec-t">M3 · $0-50美金扩大覆盖悬赏奖 SI 进展' + (extra || '') + '</div>';
  if (!state.dims.length) { host.innerHTML = head() + '<div class="au-empty">请先锚定 PSI 数据或载入示例。</div>'; return; }
  /* R3 五级筛选:产品线/Family/系列/产品/型号 逐级级联。
     （auBountyOpts 是 R3 之前的两字段版本,重构时删掉了却漏改这两处调用,
       导致 M3 与 M5 一渲染就抛 ReferenceError、整块出不来。现在改用 auBountyResolve。） */
  await auEnsureCtryOpts();
  const RES = await auBountyResolve(B);
  const toDate = B.to || todayStr();
  const prog = AW ? AW.timeProgress(toDate) : null;
  host.innerHTML = head(`<span class="au-note">累计SI=Sell-in(渠道全加) · 截止 ${toDate} · 时间进度 <b>${prog == null ? '—' : Math.round(prog * 100) + '%'}</b>${RES.defaulted ? ' · 产品集=默认规则(SE2/SE3/SE4)' : ' · 产品集=手选'}</span>`)
    + '<div class="au-toolbar" id="auBountyBar"></div>'
    + '<div class="fa-wrap" id="auBountyTable">取数中…</div>'
    + '<button class="btn au-add" id="auBountyAdd">＋加国家行</button>';
  // 工具条:五级产品筛选 + 时间范围。选了上游会自动收窄下游的可选值(auBountyResolve 逐级取 options)
  const bar = $('#auBountyBar');
  AU_BOUNTY_FIELDS.forEach(d => {
    const list = RES.opts[d.f] || [];
    if (!list.length) return;
    const cur = (RES.eff[d.f] || []).filter(v => list.includes(v));
    bar.appendChild(makeMultiSelect(d.lab, list, cur, {
      placeholder: d.ph, onChange: () => { },
      onCommit: vals => { B[AU_BOUNTY_SELKEY[d.f]] = vals; auSave(); renderAuBounty(); },
    }));
  });
  const dates = document.createElement('div');
  dates.innerHTML = `<label>SI时间范围</label> <input type="date" id="auBFrom" value="${auEsc(B.from)}"> ~ <input type="date" id="auBTo" value="${auEsc(B.to)}" title="留空=今天">`;
  dates.style.cssText = 'display:flex;align-items:center;gap:4px'; bar.appendChild(dates);
  $('#auBFrom').onchange = e => { B.from = e.target.value || '2026-01-01'; auSave(); renderAuBounty(); };
  $('#auBTo').onchange = e => { B.to = e.target.value; auSave(); renderAuBounty(); };
  $('#auBountyAdd').onclick = () => { B.rows.push({ country: '', space: null, share: null, target: null }); auSave(); renderAuBounty(); };
  // 取数:按国家堆叠的 Sell-in 月序列(自设区间),求和成 各国累计SI
  const filters = Object.assign({}, auLineFilter(), RES.eff);
  let siBy = {}, totalAll = 0;
  try {
    const q = await api.query({ metric: 'sellIn', gran: 'month', stackDim: 'country', filters, from: B.from || undefined, to: B.to || undefined });
    for (const name of Object.keys(q.data || {})) {
      let t = 0; const row = q.data[name]; for (const b of (q.buckets || [])) t += row[b] || 0;
      siBy[name] = Math.round(t); totalAll += t;
    }
    totalAll = Math.round(totalAll);
  } catch (e) { $('#auBountyTable').innerHTML = '<div class="au-empty">SI 取数失败:' + e.message + '</div>'; return; }
  // 表:手工列(空间/份额/目标)可编辑,自动列(累计SI/达成率)只读
  const R = AW ? AW.bountyRows(B.rows, siBy, totalAll) : { rows: [], total: null };
  const fmtI = v => v == null || v === '' ? '—' : Math.round(+v).toLocaleString('en-US');
  const pctS = v => v == null ? '—' : (v * 100).toFixed(0) + '%';
  // 一键导出用快照(每次渲染刷新;导出瞬间即定格)
  auW._bountyExport = {
    note: `累计SI=Sell-in · ${B.from || '2026-01-01'}~${toDate} · 时间进度 ${prog == null ? '—' : Math.round(prog * 100) + '%'}`,
    header: ['国家', '大盘年空间', '目标份额', 'SI目标', '26年累计SI', 'SI达成率'],
    rows: R.rows.map(r => [r.country, fmtI(r.space), r.share == null ? '—' : (r.share * 100).toFixed(0) + '%', fmtI(r.target), fmtI(r.cum), r.attain == null ? '—' : (r.attain * 100).toFixed(0) + '%'])
      .concat(R.total ? [['合计', fmtI(R.total.space), pctS(R.total.share), fmtI(R.total.target), fmtI(R.total.cum), R.total.attain == null ? '—' : (R.total.attain * 100).toFixed(0) + '%']] : []),
  };
  const attCell = v => v == null ? '<span class="wk">—</span>' : `<span class="${prog != null && v >= prog ? 'pos' : 'neg'}">${(v * 100).toFixed(0)}%</span>`;
  const ctryList = auW.ctryOpts.concat(['拉美其他']);
  const rowHtml = (r, i) => `<tr>
    <td style="width:110px"><input list="auCtryDl" data-i="${i}" data-k="country" value="${auEsc(r.country)}" placeholder="国家"></td>
    <td style="width:110px"><input type="number" data-i="${i}" data-k="space" value="${r.space == null ? '' : r.space}" placeholder="手工维护"></td>
    <td style="width:80px"><input type="number" step="0.1" data-i="${i}" data-k="share" value="${r.share == null ? '' : Math.round(r.share * 1000) / 10}" placeholder="%"></td>
    <td style="width:110px"><input type="number" data-i="${i}" data-k="target" value="${r.target == null ? '' : r.target}" placeholder="手工维护"></td>
    <td class="au-ro">${fmtI(r.cum)}</td>
    <td class="au-ro">${attCell(r.attain)}</td>
    <td style="width:24px"><button class="au-del" data-del="${i}">✕</button></td></tr>`;
  const T = R.total;
  $('#auBountyTable').innerHTML = `<datalist id="auCtryDl">${ctryList.map(c => `<option value="${auEsc(c)}">`).join('')}</datalist>`
    + '<table class="au-edit"><thead><tr><th>国家</th><th>大盘年空间(手工)</th><th>目标份额%(手工)</th><th>SI目标(手工)</th><th>26年累计SI(自动)</th><th>SI达成率(自动)</th><th></th></tr></thead><tbody>'
    + R.rows.map(rowHtml).join('')
    + (T ? `<tr class="au-total"><td>合计</td><td class="au-ro">${fmtI(T.space)}</td><td class="au-ro">${pctS(T.share)}</td><td class="au-ro">${fmtI(T.target)}</td><td class="au-ro">${fmtI(T.cum)}</td><td class="au-ro">${attCell(T.attain)}</td><td></td></tr>` : '')
    + '</tbody></table>';
  $('#auBountyTable').querySelectorAll('input[data-k]').forEach(el => {
    el.onchange = () => {
      const i = +el.dataset.i, k = el.dataset.k, r = B.rows[i]; if (!r) return;
      if (k === 'country') r.country = el.value.trim();
      else if (k === 'share') r.share = el.value === '' ? null : (+el.value) / 100;
      else r[k] = el.value === '' ? null : +el.value;
      auSave(); renderAuBounty();
    };
  });
  $('#auBountyTable').querySelectorAll('[data-del]').forEach(b => b.onclick = () => { B.rows.splice(+b.dataset.del, 1); auSave(); renderAuBounty(); });
}

/* ============================================================
   M5 产品维度:自定义标题 + 可加国家的国家块(port 自 country-view,自包含副本)
   ============================================================ */
function auCbColumns(r, dimOverride) {
  const dim = dimOverride || auW.cb.dim;
  const cyy = r.curYear % 100, py = r.prevYear % 100, wl = r.weekLabels || [];
  const fcell = v => r.hasFlow ? numCell(v) : '<span class="wk">—</span>';
  const cols = [];
  const showSeries = (dim === 'model' && state.dims.includes('line'));
  // 同期/同比收进合计行只对 SKU 级维度有意义；系列/国家办表全行都显示
  const skuLevel = (dim === 'product' || dim === 'model');
  if (showSeries) cols.push({ key: '__line', label: 'Product Series', cell: o => o.line || '' });
  cols.push({ key: 'key', label: DIM_LABEL[dim] || dim, cell: o => o.key });
  cols.push({ key: 'cumCur', label: cyy + '累计SO', cell: o => numCell(o.cumCur) });
  cols.push({ key: 'cumPrev', label: py + '同期SO总', totalOnly: skuLevel, cell: o => numCell(o.cumPrev) });
  cols.push({ key: 'yoy', label: 'SO同比', totalOnly: skuLevel, cell: o => pctCell(o.yoy) });
  cols.push({ key: 'siCur', label: cyy + '累计SI', sep: true, cell: o => numCell(o.siCur) });
  cols.push({ key: 'siPrev', label: py + '同期SI总', totalOnly: skuLevel, cell: o => numCell(o.siPrev) });
  cols.push({ key: 'siYoy', label: 'SI同比', totalOnly: skuLevel, cell: o => pctCell(o.siYoy) });
  wl.forEach((w, i) => cols.push({ key: 'w' + i, label: w, wk: true, sep: i === 0, cell: o => `<span class="wk">${numCell(o.weekly[i])}</span>` }));
  cols.push({ key: 'wow', label: 'WoW%', cell: o => pctCell(o.wow) });
  cols.push({ key: 'inv', label: '库存', sep: true, cell: o => numCell(o.inv) });
  cols.push({ key: 'dos', label: 'DOS', cell: o => dosCell(o.dos, 'channel') });
  if (r.hasFlow) {
    cols.push({ key: 'flowInv', label: '全流程库存', sep: true, cell: o => fcell(o.flowInv) });
    cols.push({ key: 'flowDos', label: '全流程DOS', cell: o => dosCell(o.flowDos, 'flow') });
    cols.push({ key: 'dcfdc', label: '国家仓+FDC', cell: o => fcell(o.dcfdc) });
  }
  return cols;
}
// 默认排序(与国家看板 fallback 一致):型号维度按系列归并再累计SO;产品维度按累计SO 高→低
function auCbSortRows(r, cols) {
  const rows = (r && r.rows || []).slice();
  const showSeries = cols.some(c => c.key === '__line');
  if (showSeries) rows.sort((a, b) => { const ra = seriesRank(a.line), rb = seriesRank(b.line); if (ra !== rb) return ra - rb; if ((a.line || '') !== (b.line || '')) return String(a.line).localeCompare(String(b.line), 'zh'); return b.cumCur - a.cumCur; });
  else rows.sort((a, b) => b.cumCur - a.cumCur);
  return rows;
}
function auRH() { return (typeof window !== 'undefined' && window.RowHide) ? window.RowHide : require('../row-hide-core.js'); }
function auHiddenAll() { try { return JSON.parse(localStorage.getItem(AU_HIDE_LS)) || {}; } catch (e) { return {}; } }
function auHiddenKey(v) { return 'audio|' + v + '|' + auW.cb.dim; }
function auHiddenList(v) { return auHiddenAll()[auHiddenKey(v)] || []; }
function auSetHidden(v, arr) { const all = auHiddenAll(); if (arr && arr.length) all[auHiddenKey(v)] = arr; else delete all[auHiddenKey(v)]; try { localStorage.setItem(AU_HIDE_LS, JSON.stringify(all)); } catch (e) { } }
function auCbVisibleRows(v, r, cols) { return auRH().visible(auCbSortRows(r, cols), auHiddenList(v)); }
function auCbTableHtml(v, r) {
  const cols = auCbColumns(r);
  const showSeries = cols.some(c => c.key === '__line');
  const rows = auCbVisibleRows(v, r, cols);
  const thead = '<tr><th style="width:20px"></th>' + cols.map(c => `<th class="${c.sep ? 'col-sep' : ''}${c.wk ? ' wk' : ''}">${c.label}</th>`).join('') + '</tr>';
  let body = '';
  for (let i = 0; i < rows.length; i++) {
    const o = rows[i];
    let tds = `<td><button class="row-hide-btn" data-hiderow="${encodeURIComponent(o.key)}" title="隐藏此行(不影响合计,卡片头可恢复)" style="border:none;background:none;color:var(--c-ink-3);cursor:pointer;font-size:11px;padding:0 3px">✕</button></td>`;
    cols.forEach(c => {
      if (c.key === '__line' && showSeries) {
        if (i > 0 && (rows[i - 1].line || '') === (o.line || '')) return;
        let span = 1; while (i + span < rows.length && (rows[i + span].line || '') === (o.line || '')) span++;
        tds += `<td class="col-sep" rowspan="${span}" style="vertical-align:middle;font-weight:600;background:var(--c-bg-sunken)">${o.line || ''}</td>`;
      } else { const cv = c.totalOnly ? '<span class="wk">—</span>' : c.cell(o); tds += `<td class="${c.sep ? 'col-sep' : ''}${c.wk ? ' wk' : ''}">${cv}</td>`; }
    });
    body += '<tr>' + tds + '</tr>';
  }
  if (r.total) { let tds = '<td></td>'; cols.forEach(c => { if (c.key === '__line') tds += '<td class="col-sep"></td>'; else tds += `<td class="${c.sep ? 'col-sep' : ''}">${c.key === 'key' ? '合计' : c.cell(r.total)}</td>`; }); body += '<tr class="total">' + tds + '</tr>'; }
  return thead + body;
}
function auRenderCbCard(v, r) {
  const card = document.createElement('div'); card.className = 'cb-card'; card.dataset.v = v;
  const head = document.createElement('div'); head.className = 'cb-head'; head.style.position = 'relative';
  const t = r.total || {}; const cyy = r.curYear % 100;
  const hidList = auHiddenList(v);
  head.innerHTML = `<span class="nm">${v}</span>`
    + `<span class="chip">${cyy}累计SO <b>${numCell(t.cumCur)}</b></span>`
    + `<span class="chip">同比 <b class="${t.yoy == null ? '' : (t.yoy >= 0 ? 'pos' : 'neg')}">${t.yoy == null ? '—' : (t.yoy * 100).toFixed(0) + '%'}</b></span>`
    + `<span class="chip">库存 <b>${numCell(t.inv)}</b></span>`
    + `<span class="chip">DOS <b>${t.dos == null ? '—' : t.dos}</b></span>`
    + (hidList.length ? `<span class="chip au-hidchip" style="cursor:pointer;background:var(--c-brand-soft);color:var(--c-brand)">已隐藏 ${hidList.length} 行 ▾</span>` : '')
    + `<span class="fa-exp"><button data-ex="xlsx">📊 Excel</button><button data-ex="png">🖼 图片</button><button data-ex="rm" title="从周报移除此国家">移除</button></span>`;
  const wrapEl = document.createElement('div'); wrapEl.className = 'cb-table-wrap';
  const tbl = document.createElement('table'); tbl.className = 'rep-table'; tbl.innerHTML = auCbTableHtml(v, r); wrapEl.appendChild(tbl);
  head.querySelectorAll('.fa-exp button').forEach(btn => btn.onclick = () => {
    if (btn.dataset.ex === 'xlsx') auExportCbXlsx(v, r);
    else if (btn.dataset.ex === 'png') auExportCbPng(v, r);
    else { const D = auLoad(); D.countries = D.countries.filter(c => c !== v); auSave(); renderAuCountry(); }
  });
  const chip = head.querySelector('.au-hidchip');
  if (chip) chip.onclick = () => {
    let p = head.querySelector('.au-hid-panel'); if (p) { p.remove(); return; }
    p = document.createElement('div'); p.className = 'au-hid-panel';
    p.style.cssText = 'position:absolute;top:calc(100% - 4px);left:' + Math.max(8, chip.offsetLeft) + 'px;z-index:60;background:var(--c-bg-elev);border:1px solid var(--c-line);border-radius:8px;box-shadow:0 10px 30px rgba(0,0,0,.14);padding:8px 10px;max-height:260px;overflow:auto;min-width:200px';
    auHiddenList(v).forEach(k => {
      const row = document.createElement('div'); row.style.cssText = 'display:flex;align-items:center;gap:10px;padding:2px 0;font-size:12px;color:var(--c-ink-1)';
      const nm = document.createElement('span'); nm.textContent = k; nm.style.flex = '1';
      const btn = document.createElement('button'); btn.textContent = '恢复'; btn.className = 'btn'; btn.style.cssText = 'padding:1px 8px;font-size:11px';
      btn.onclick = () => { auSetHidden(v, auRH().remove(auHiddenList(v), k)); renderAuCountry(); };
      row.appendChild(nm); row.appendChild(btn); p.appendChild(row);
    });
    const all = document.createElement('button'); all.textContent = '全部恢复'; all.className = 'btn'; all.style.cssText = 'margin-top:6px;padding:2px 10px;font-size:11px;width:100%';
    all.onclick = () => { auSetHidden(v, []); renderAuCountry(); };
    p.appendChild(all); head.appendChild(p);
  };
  wrapEl.querySelectorAll('[data-hiderow]').forEach(b => b.onclick = () => { auSetHidden(v, auRH().add(auHiddenList(v), decodeURIComponent(b.dataset.hiderow))); renderAuCountry(); });
  card.appendChild(head); card.appendChild(wrapEl);
  return card;
}
async function auExportCbXlsx(v, r) {
  const cols = auCbColumns(r); const rows = auCbVisibleRows(v, r, cols);
  const strip = h => String(h).replace(/<[^>]*>/g, '');
  const aoa = [cols.map(c => c.label)];
  rows.forEach(o => aoa.push(cols.map(c => c.totalOnly ? '' : strip(c.cell(o)).replace(/,/g, ''))));
  if (r.total) aoa.push(cols.map(c => c.key === 'key' ? '合计' : (c.key === '__line' ? '' : strip(c.cell(r.total)).replace(/,/g, ''))));
  const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), String(v).slice(0, 28));
  const b64 = XLSX.write(wb, { bookType: 'xlsx', type: 'base64' });
  // 文件名跟随当前产业(R1 加产业切换时这三处漏改了,切到平板导出的还叫「音频周报」)
  const res = await api.saveFile(auIndustryLabel() + '周报_' + String(v).replace(/[\\/:*?"<>|]/g, '_') + '_' + todayStr() + '.xlsx', b64, 'xlsx'); if (res && res.path) toast('已导出', 'ok');
}
async function auExportCbPng(v, r) {
  const cols = auCbColumns(r); const rows = auCbVisibleRows(v, r, cols);
  const header = cols.map(c => c.label);
  const body = rows.map(o => ({ cells: cols.map(c => c.totalOnly ? { t: '—', c: 'wk' } : cellPlain(c.cell(o))) }));
  if (r.total) body.push({ tot: true, cells: cols.map(c => c.key === '__line' ? { t: '' } : (c.key === 'key' ? { t: '合计' } : cellPlain(c.cell(r.total)))) });
  const b64 = drawTablePNG(v + ' · ' + auIndustryLabel() + ' · ' + (DIM_LABEL[auW.cb.dim] || auW.cb.dim) + '明细', header, body);
  const res = await api.saveFile(auIndustryLabel() + '周报_' + String(v).replace(/[\\/:*?"<>|]/g, '_') + '_' + todayStr() + '.png', b64, 'png'); if (res && res.path) toast('已导出图片', 'ok');
}
function renderAuCountry() { return auTrack('cb', renderAuCountryImpl()); }
async function renderAuCountryImpl() {
  const host = $('#auSecCountry'); if (!host) return;
  auW.cbLast = [];                                         // 先清后填,理由同 renderAuFin
  const D = auLoad(), T = D.title;
  const head = '<div class="au-sec-t">M5 · 产品维度<span class="au-note">标题可自己写(字号/加粗可调) · 按国家逐块看产品销量(口径同国家看板,全流程/DOS 全移植;跟随当前产业:' + auIndustryLabel() + ') · Ctrl+滚轮缩放</span></div>';
  if (!state.dims.length) { host.innerHTML = head + '<div class="au-empty">请先锚定 PSI 数据或载入示例。</div>'; return; }
  await auDetectIndustryDim(auW.industry); await auEnsureCtryOpts();
  host.innerHTML = head
    + `<div class="au-toolbar"><button class="btn" id="auTBold" style="${T.bold ? 'border-color:var(--c-brand);color:var(--c-brand)' : ''}">B 加粗</button>`
    + `<label>字号</label><select id="auTSize">${[12, 13, 14, 15, 16, 18, 20, 22, 26].map(s => `<option value="${s}" ${T.size === s ? 'selected' : ''}>${s}px</option>`).join('')}</select></div>`
    + `<div class="au-title-wrap"><div class="au-title-edit" id="auTitleEdit" contenteditable="true" spellcheck="false" style="font-size:${T.size}px;font-weight:${T.bold ? 700 : 400}">${auEsc(T.text)}</div></div>`
    + '<div class="au-toolbar" id="auCbBar"></div>'
    + '<div class="cb-list" id="auCbList"></div>';
  // 标题编辑(纯文本;粘贴降纯文本)
  const ed = $('#auTitleEdit');
  ed.oninput = () => { T.text = ed.innerText; auSave(); };
  ed.onpaste = e => { e.preventDefault(); document.execCommand('insertText', false, (e.clipboardData || window.clipboardData).getData('text')); };
  $('#auTBold').onclick = () => { T.bold = !T.bold; auSave(); renderAuCountry(); };
  $('#auTSize').onchange = e => { T.size = +e.target.value || 15; auSave(); renderAuCountry(); };
  // 工具条:添加国家 + 拆分维度 + 周范围
  const bar = $('#auCbBar');
  if (auW.ctryOpts.length) bar.appendChild(makeMultiSelect('＋添加国家', auW.ctryOpts, (D.countries || []).filter(c => auW.ctryOpts.includes(c)), {
    placeholder: '选择要展示的国家', onChange: () => { }, onCommit: vals => { D.countries = vals; auSave(); renderAuCountry(); },
  }));
  const dimFld = document.createElement('div'); dimFld.style.cssText = 'display:flex;align-items:center;gap:4px';
  dimFld.innerHTML = `<label>拆分</label><select id="auCbDim"><option value="product" ${auW.cb.dim === 'product' ? 'selected' : ''}>产品</option><option value="model" ${auW.cb.dim === 'model' ? 'selected' : ''}>产品型号</option></select>`;
  bar.appendChild(dimFld);
  $('#auCbDim').onchange = e => { auW.cb.dim = e.target.value; auStateSave(); renderAuCountry(); };
  const wkFld = document.createElement('div'); wkFld.style.cssText = 'display:flex;align-items:center;gap:4px';
  wkFld.innerHTML = '<label>周范围</label><span id="auCbWeekRange" style="display:inline-flex;gap:4px;align-items:center"></span>';
  bar.appendChild(wkFld);
  renderWeekRange('auCbWeekRange', auW.cb, () => { auStateSave(); renderAuCountry(); });
  // R4 缩放控件(整块缩放:表头+表体一起;Ctrl+滚轮同效)
  const zmFld = document.createElement('div'); zmFld.style.cssText = 'display:flex;align-items:center;gap:4px';
  zmFld.innerHTML = '<label>缩放</label>'
    + '<button class="btn" id="auZoomOut" title="缩小 5%" style="padding:1px 9px">−</button>'
    + '<span id="auZoomVal" style="font-size:12px;color:var(--c-ink-2);min-width:42px;text-align:center">' + Math.round(auW.cbZoom * 100) + '%</span>'
    + '<button class="btn" id="auZoomIn" title="放大 5%" style="padding:1px 9px">＋</button>'
    + '<button class="btn" id="auZoomReset" title="恢复 100%" style="padding:1px 9px">重置</button>';
  bar.appendChild(zmFld);
  $('#auZoomOut').onclick = () => auSetZoom(auW.cbZoom - AU_ZOOM_STEP);
  $('#auZoomIn').onclick = () => auSetZoom(auW.cbZoom + AU_ZOOM_STEP);
  $('#auZoomReset').onclick = () => auSetZoom(1);
  // 国家块
  const list = $('#auCbList');
  auBindZoomWheel(list);
  const ctrys = (D.countries || []).filter(c => auW.ctryOpts.includes(c));
  if (!ctrys.length) { list.innerHTML = '<div class="au-empty">用上方「＋添加国家」选择要展示的国家(每国一块,格式同国家看板)。</div>'; return; }
  const token = ++auW.token;
  const reps = await Promise.all(ctrys.map(v => {
    const f = Object.assign({}, auLineFilter(), { country: [v] });
    return api.report({ groupDim: auW.cb.dim, weeks: auW.cb.weeks, fromW: auW.cb.fromW, toW: auW.cb.toW, filters: f }).then(r => ({ v, r }));
  }));
  if (token !== auW.token) return;
  auW.cbLast = reps;
  list.innerHTML = '';
  reps.forEach(({ v, r }) => {
    // 每国先一段叙述(邮件版式:文字在图前),芯片 scope=该国
    const nar = document.createElement('div');
    nar.dataset.cbNar = v;
    list.appendChild(nar);
    auMountNar(nar, null, 'country', v);
    list.appendChild(auRenderCbCard(v, r));
  });
  auApplyZoom();   // 重绘后把已保存的缩放重新贴上
  auChipsRefresh();
}

/* ============================================================
   M6 新品进展:可增删自由区块(小标题+富文本+附件),块可上下移
   附件默认拷进 App 数据目录(userData/audio-attachments,随周报走;main 纯新增 IPC)
   ============================================================ */
function renderAuBlocks() {
  const host = $('#auSecBlocks'); if (!host) return;
  const D = auLoad(); if (!Array.isArray(D.blocks)) D.blocks = [];
  const blockHtml = (k, i) => `
    <div style="border:1px solid var(--c-line);border-radius:10px;padding:10px 14px;margin:8px 0;background:var(--c-bg-elev)">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
        <input data-i="${i}" data-k="title" value="${auEsc(k.title)}" placeholder="小标题(如:SonicBuds SE 5 Max 上市方案)" style="flex:1;font-weight:700;font-size:13px;border:1px solid transparent;background:transparent;color:var(--c-ink-1);padding:3px 6px;border-radius:4px">
        <button class="btn" data-up="${i}" title="上移" style="padding:1px 8px">↑</button>
        <button class="btn" data-dn="${i}" title="下移" style="padding:1px 8px">↓</button>
        <button class="au-del" data-del="${i}" title="删除此块">✕</button>
      </div>
      <div class="au-title-edit" data-i="${i}" data-k="text" contenteditable="true" spellcheck="false" style="font-size:12px;min-height:44px">${auEsc(k.text)}</div>
      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:6px">
        <button class="btn" data-att="${i}" style="padding:2px 10px;font-size:11px">📎 添加附件</button>
        ${(k.atts || []).map((a, j) => `<span class="chip" style="cursor:pointer" data-open="${i}:${j}" title="点击打开(已拷入App数据目录)">${auEsc(a.name)} <b data-attdel="${i}:${j}" style="color:var(--c-brand);cursor:pointer">✕</b></span>`).join('')}
      </div>
    </div>`;
  host.innerHTML = '<div class="au-sec-t">M6 · 新品进展<span class="au-note">自由区块:标题+正文+附件,可上下移;附件自动拷入 App 数据目录随周报保存</span></div>'
    + (D.blocks.length ? D.blocks.map(blockHtml).join('') : '<div class="au-empty">暂无内容,点下方「＋加一块」放新品 PPT/上市方案等</div>')
    + '<button class="btn au-add" id="auBlockAdd">＋加一块</button>';
  host.querySelectorAll('input[data-k="title"]').forEach(el => el.onchange = () => { const b = D.blocks[+el.dataset.i]; if (b) { b.title = el.value; auSave(); } });
  host.querySelectorAll('[data-k="text"]').forEach(el => {
    el.oninput = () => { const b = D.blocks[+el.dataset.i]; if (b) { b.text = el.innerText; auSave(); } };
    el.onpaste = e => { e.preventDefault(); document.execCommand('insertText', false, (e.clipboardData || window.clipboardData).getData('text')); };
  });
  host.querySelectorAll('[data-del]').forEach(b => b.onclick = () => { D.blocks.splice(+b.dataset.del, 1); auSave(); renderAuBlocks(); });
  host.querySelectorAll('[data-up]').forEach(b => b.onclick = () => { const i = +b.dataset.up; if (i > 0) { const t = D.blocks[i - 1]; D.blocks[i - 1] = D.blocks[i]; D.blocks[i] = t; auSave(); renderAuBlocks(); } });
  host.querySelectorAll('[data-dn]').forEach(b => b.onclick = () => { const i = +b.dataset.dn; if (i < D.blocks.length - 1) { const t = D.blocks[i + 1]; D.blocks[i + 1] = D.blocks[i]; D.blocks[i] = t; auSave(); renderAuBlocks(); } });
  host.querySelectorAll('[data-att]').forEach(b => b.onclick = async () => {
    const i = +b.dataset.att; const blk = D.blocks[i]; if (!blk) return;
    const r = await api.audioAttachPick();
    if (r && r.file) { (blk.atts = blk.atts || []).push({ name: r.name, file: r.file }); auSave(); renderAuBlocks(); }
    else if (r && r.error) toast('附件添加失败:' + r.error, 'err');
  });
  host.querySelectorAll('[data-open]').forEach(el => el.onclick = e => {
    if (e.target.dataset.attdel) return;
    const [i, j] = el.dataset.open.split(':').map(Number); const a = ((D.blocks[i] || {}).atts || [])[j];
    if (a) api.audioAttachOpen(a.file);
  });
  host.querySelectorAll('[data-attdel]').forEach(el => el.onclick = () => {
    const [i, j] = el.dataset.attdel.split(':').map(Number);
    const blk = D.blocks[i]; if (blk && blk.atts) { blk.atts.splice(j, 1); auSave(); renderAuBlocks(); }
  });
  $('#auBlockAdd').onclick = () => { D.blocks.push({ title: '', text: '', atts: [] }); auSave(); renderAuBlocks(); };
}

// Node 冒烟需要:文件可被 require 而不执行任何 DOM 逻辑(全部函数定义,顶层零副作用)
if (typeof module !== 'undefined' && module.exports) module.exports = { auDefaultData };

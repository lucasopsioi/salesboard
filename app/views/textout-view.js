/* ============================================================
   Salesboard — views/textout-view.js
   「文字输出」看板（周报文字生成器）UI 层。
   双区：上=编辑区（contenteditable 富文本 + 内嵌数据芯片 + 左侧料架/工具栏插入）；
        下=纯文字输出区（芯片解析成数字后的纯文本，默认微软雅黑，复制全部 / ↻刷新）。
   芯片 = inline 胶囊，点开配置弹板（数据源 / 级联筛选 / 时间 / 格式）。
   模板另存/打开/删/改名（sb.textout.v1，archive.js 自动落盘）。
   Ctrl+Z/Y 走 PptHistory 防抖快照；粘贴降纯文本。
   取数复用 pptoutput 基建：binding-resolver(PptBind) / bindings(PptBindings.resolveElement)；
   纯逻辑（相对时间/聚合/格式化/序列化）走 TextoutCore。四个基建文件只引用不改。
   ============================================================ */
'use strict';

// 模块状态。doc=文档模型 {v,blocks}；hist=PptHistory；resolved=芯片 idx→已格式化字符串；
// gen=解析令牌（竞态守卫）；now=解析基准时刻（默认当前，可注入测试）。
const TXT = { built: false, doc: null, hist: null, _histTimer: null, _restoring: false, _saveTimer: null, _refTimer: null, resolved: {}, gen: 0, now: null, cfgEl: null };
const TXT_KEY = 'sb.textout.v1';

/* ---------- 数据源 / 指标 / 维度元数据 ---------- */
function txtDsList() {
  const list = [['psi', '经营 PSI']];
  if (typeof state !== 'undefined' && state.idcMeta) list.push(['idc', 'IDC 市场']);
  if (typeof state !== 'undefined' && state.finMeta) list.push(['finance', '经营(财经)']);
  return list;
}
function txtMeasures(ds) {
  if (ds === 'idc') return [['units', '销量'], ['value', '金额'], ['asp', '均价']];
  if (ds === 'finance') return [['rev', '净销售收入'], ['gm', '销毛额'], ['gmr', '销毛率'], ['cp', '贡献利润'], ['nsip', 'NSIP'], ['sellIn', 'Sell-in量'], ['sellOut', 'Sell-out量']];
  return [['sellOut', 'Sell-Out'], ['sellIn', 'Sell-In'], ['inv', '渠道库存'], ['dos', 'DOS']];
}
function txtDims(ds) {
  if (ds === 'finance') return ['rep', 'lv1', 'lv2', 'lv3', 'lv4'];
  if (ds === 'idc') return (typeof state !== 'undefined' && state.idcMeta && state.idcMeta.dims) || [];
  return (typeof state !== 'undefined' && state.dims) || [];   // PSI 业务维度（不含 period）
}
const TXT_FIN_DIM_LABEL = { rep: '国家办', lv1: 'LV1', lv2: 'LV2', lv3: 'LV3', lv4: 'LV4' };
function txtDimLabel(field, ds) {
  if (ds === 'finance') return TXT_FIN_DIM_LABEL[field] || field;
  if (typeof DIM_LABEL !== 'undefined' && DIM_LABEL[field]) return DIM_LABEL[field];
  return field;
}
// 该测量是否需要时间/聚合（PSI 的 SO/SI 是流量按区间聚合；inv/dos 是现值快照，无时间）。
function txtIsSnapshot(cfg) { const m = cfg.measure; return (cfg.dataset || 'psi') === 'psi' && (m === 'inv' || m === 'dos'); }
function txtIsFinance(cfg) { return (cfg.dataset || 'psi') === 'finance'; }

/* ---------- 芯片默认 cfg ---------- */
function txtDefaultCfg(kind) {
  if (kind === 'compare') return { kind: 'compare', dataset: 'psi', measure: 'sellOut', agg: 'sum', filters: {}, preset: 'yoy', time: { mode: 'wtd' }, cmpTime: { mode: 'custom', from: null, to: null }, fmt: { fmt: 'pct', decimals: 2, suffix: '' } };
  return { kind: 'value', dataset: 'psi', measure: 'sellOut', agg: 'sum', filters: {}, time: { mode: 'wtd' }, fmt: { unit: 'auto', decimals: 1, suffix: '' } };
}

/* ============================================================
   入口 + 骨架
   ============================================================ */
function renderTextout() {
  const root = $('#txtRoot'); if (!root) return;
  if (!TXT.doc) TXT.doc = txtLoadCurrent();
  if (!TXT.hist) txtHistInit();
  if (!TXT.built) { txtBuildShell(root); TXT.built = true; }
  txtRenderEditor();
  txtRefreshAll();
}

function txtBuildShell(root) {
  root.innerHTML =
    '<div class="to-wrap">' +
    '  <div class="to-toolbar">' +
    '    <span class="to-name" id="txtDocName"></span>' +
    '    <span class="to-spacer"></span>' +
    '    <button class="btn ghost" id="txtUndo" title="撤销 (Ctrl+Z)">↶ 撤销</button>' +
    '    <button class="btn ghost" id="txtRedo" title="重做 (Ctrl+Y)">↷ 重做</button>' +
    '    <button class="btn" id="txtNew" title="清空为新文档">新建</button>' +
    '    <button class="btn" id="txtOpen" title="打开已存模板">打开</button>' +
    '    <button class="btn primary" id="txtSaveAs" title="另存为命名模板">另存为模板</button>' +
    '  </div>' +
    '  <div class="to-main">' +
    '    <div class="to-shelf">' +
    '      <div class="to-shelf-h">芯片料架</div>' +
    '      <div class="to-shelf-tip">拖入正文，或点「插入」放到光标处</div>' +
    '      <div class="to-shelf-item" draggable="true" data-kind="value"><b>数值</b><span>SO/SI/库存/DOS</span><button class="to-ins" data-kind="value">插入</button></div>' +
    '      <div class="to-shelf-item" draggable="true" data-kind="compare"><b>同比/环比</b><span>去年同期·上期·两期</span><button class="to-ins" data-kind="compare">插入</button></div>' +
    '      <div class="to-shelf-note">同一芯片可点开改「同比↔环比」。<br>时间用相对区间（本周至今…），每周打开自动滚动刷新。</div>' +
    '    </div>' +
    '    <div class="to-editwrap">' +
    '      <div class="to-editlabel">编辑区（自由打字，芯片内嵌显示当前值；行首打 1. 回车自动续号）</div>' +
    '      <div class="to-fmtbar" id="txtFmtBar">' +
    '        <button class="to-fbtn" id="txtFmtBold" title="加粗/取消加粗(选中文字)"><b>B</b></button>' +
    '        <select class="to-fsel" id="txtFmtSize" title="字号(选中文字)"><option value="">字号</option>' +
    [12, 13, 14, 16, 18, 20].map(v => '<option value="' + v + '">' + v + 'px</option>').join('') + '</select>' +
    '        <span class="to-fpal" id="txtFmtPal">' +
    ['#1a1a1a', '#c00000', '#e07000', '#1f7a1f', '#1f4f9e', '#8a9099'].map(c => '<span class="to-fsw" data-c="' + c + '" style="background:' + c + '" title="' + c + '"></span>').join('') +
    '<input type="color" id="txtFmtColor" title="自定义颜色" value="#1f4f9e"></span>' +
    '        <span class="to-fdiv"></span>' +
    '        <button class="to-fbtn" id="txtAlignL" title="本行靠左">⇤ 靠左</button>' +
    '        <button class="to-fbtn" id="txtAlignR" title="本行靠右">⇥ 靠右</button>' +
    '      </div>' +
    '      <div class="to-editor" id="txtEditor" contenteditable="true" spellcheck="false"></div>' +
    '    </div>' +
    '  </div>' +
    '  <div class="to-outhead">' +
    '    <span class="to-outtitle">纯文字输出</span>' +
    '    <span class="to-spacer"></span>' +
    '    <button class="btn ghost" id="txtRefresh" title="重解析全部芯片">↻ 刷新数据</button>' +
    '    <button class="btn primary" id="txtCopy" title="复制全部文字">复制全部</button>' +
    '  </div>' +
    '  <div class="to-output" id="txtOutput"></div>' +
    '</div>';

  const editor = $('#txtEditor');
  // 输入：同步文档模型 + 防抖快照 + 防抖刷新输出（不重渲编辑区，避免光标跳）。
  editor.addEventListener('input', () => { if (TXT._restoring) return; txtSyncDoc(); txtScheduleHist(); txtScheduleRefresh(); txtScheduleSave(); });
  /* 复制/剪切：双通道——text/plain 给外部(整句+芯片当前值,干净纯文本)；
     application/x-sb-textout 给编辑区内部(带芯片完整 cfg,粘贴时原样克隆,筛选不丢)。 */
  const txtBuildClipboard = (e) => {
    const sel = document.getSelection();
    if (!sel || !sel.rangeCount || sel.isCollapsed) return false;
    const range = sel.getRangeAt(0);
    if (!editor.contains(range.commonAncestorContainer)) return false;
    const tmp = document.createElement('div');
    tmp.appendChild(range.cloneContents());          // data-cfg 随克隆走
    const blocks = txtSerializeRoot(tmp);
    const vals = {};
    Array.from(tmp.querySelectorAll('.to-chip')).forEach((c, i) => { const v = c.querySelector('.to-chip-v'); vals[i] = v ? v.textContent : '-'; });
    e.clipboardData.setData('text/plain', TextoutCore.renderText(blocks, vals));
    e.clipboardData.setData('application/x-sb-textout', JSON.stringify({ v: 2, blocks: blocks }));
    e.preventDefault();
    return true;
  };
  editor.addEventListener('copy', txtBuildClipboard);
  editor.addEventListener('cut', (e) => {
    if (!txtBuildClipboard(e)) return;
    document.execCommand('delete');
    txtSyncDoc(); txtScheduleHist(); txtScheduleRefresh(); txtScheduleSave();
  });
  // 粘贴：优先识别内部格式(重建真芯片,cfg 深拷贝)；否则降纯文本(防外来富文本污染)。
  editor.addEventListener('paste', (e) => {
    e.preventDefault();
    const cd = e.clipboardData || window.clipboardData;
    let payload = null;
    try { const j = cd.getData('application/x-sb-textout'); if (j) payload = JSON.parse(j); } catch (_) { }
    if (payload && Array.isArray(payload.blocks)) txtInsertBlocksAtCaret(payload.blocks);
    else txtInsertTextAtCaret(cd.getData('text/plain'));
    txtSyncDoc(); txtScheduleHist(); txtScheduleRefresh(); txtScheduleSave();
  });
  // Ctrl+Z/Y 撤销重做 + 回车自动续号（行首 1. / 1、/ 1) → 下一行自动填下一号；空序号项回车退出）。
  editor.addEventListener('keydown', (e) => {
    const k = e.key.toLowerCase();
    if ((e.ctrlKey || e.metaKey) && k === 'z' && !e.shiftKey) { e.preventDefault(); txtUndo(); }
    else if ((e.ctrlKey || e.metaKey) && (k === 'y' || (k === 'z' && e.shiftKey))) { e.preventDefault(); txtRedo(); }
    else if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
      const line = txtCaretLineEl();
      const text = line ? line.textContent : '';
      if (line && TextoutCore.isEmptyNumLine(text)) {
        // 只剩序号没内容 → 这一回车=退出序号（清掉本行序号,不再换行）
        e.preventDefault();
        line.textContent = ''; line.appendChild(document.createElement('br'));
        const r = document.createRange(); r.setStart(line, 0); r.collapse(true);
        const s = document.getSelection(); s.removeAllRanges(); s.addRange(r);
        txtSyncDoc(); txtScheduleHist(); txtScheduleSave(); txtRenderOutput();
      } else {
        const pref = TextoutCore.nextNumPrefix(text);
        if (pref) setTimeout(() => {         // 让浏览器先完成换行,再往新行填下一号
          const nl = txtCaretLineEl(); if (!nl || nl === line) return;
          nl.insertBefore(document.createTextNode(pref), nl.firstChild);
          const r = document.createRange(); r.setStart(nl.firstChild, pref.length); r.collapse(true);
          const s = document.getSelection(); s.removeAllRanges(); s.addRange(r);
          txtSyncDoc(); txtScheduleHist(); txtScheduleSave(); txtRenderOutput();
        }, 0);
      }
    }
  });
  // 拖放：从料架拖 chip 到编辑区光标处。
  editor.addEventListener('dragover', (e) => { if (TXT._dragKind) e.preventDefault(); });
  editor.addEventListener('drop', (e) => {
    const kind = TXT._dragKind || (e.dataTransfer && e.dataTransfer.getData('text/plain'));
    if (kind !== 'value' && kind !== 'compare') return;
    e.preventDefault();
    txtPlaceCaretFromPoint(e.clientX, e.clientY);
    txtInsertChip(kind);
    TXT._dragKind = null;
  });

  root.querySelectorAll('.to-shelf-item').forEach(it => {
    it.addEventListener('dragstart', (e) => { TXT._dragKind = it.dataset.kind; if (e.dataTransfer) { e.dataTransfer.setData('text/plain', it.dataset.kind); e.dataTransfer.effectAllowed = 'copy'; } });
    it.addEventListener('dragend', () => { TXT._dragKind = null; });
  });
  root.querySelectorAll('.to-ins').forEach(b => b.onclick = (e) => { e.stopPropagation(); txtInsertChip(b.dataset.kind); });

  // 排版工具栏（mousedown 不抢编辑区选区；select/color 控件除外——它们需要焦点）
  const fmtbar = $('#txtFmtBar');
  fmtbar.addEventListener('mousedown', (e) => { if (e.target.closest('select,input')) return; e.preventDefault(); });
  $('#txtFmtBold').onclick = txtToggleBold;
  $('#txtFmtSize').onchange = (e) => { const v = parseInt(e.target.value, 10); if (v) txtApplyStyle({ fontSize: v + 'px' }); e.target.value = ''; };
  fmtbar.querySelectorAll('.to-fsw').forEach(sw => sw.onclick = () => txtApplyStyle({ color: sw.dataset.c }));
  $('#txtFmtColor').onchange = (e) => txtApplyStyle({ color: e.target.value });
  $('#txtAlignL').onclick = () => txtApplyAlign('l');
  $('#txtAlignR').onclick = () => txtApplyAlign('r');

  $('#txtUndo').onclick = txtUndo;
  $('#txtRedo').onclick = txtRedo;
  $('#txtNew').onclick = txtNewDoc;
  $('#txtOpen').onclick = txtOpenTemplateModal;
  $('#txtSaveAs').onclick = txtSaveAsTemplate;
  $('#txtRefresh').onclick = () => { TXT.now = null; txtRefreshAll(); toast('已刷新数据'); };
  $('#txtCopy').onclick = txtCopyAll;
  txtSyncName();
}

/* ============================================================
   编辑区 ↔ 文档模型
   ============================================================ */
// 带样式文本节点：无样式=裸文本节点；有样式=span 包裹（加粗/字号/颜色）。
function txtStyledTextNode(s, st) {
  const tn = document.createTextNode(s == null ? '' : s);
  if (!st) return tn;
  const sp = document.createElement('span');
  if (st.b) sp.style.fontWeight = '700';
  if (st.fs) sp.style.fontSize = st.fs + 'px';
  if (st.c) sp.style.color = st.c;
  sp.appendChild(tn); return sp;
}
// v2 行 → <div class="to-line">（对齐进 text-align；空行补 <br> 保高度）
function txtLineEl(line) {
  const div = document.createElement('div'); div.className = 'to-line';
  if (line.a === 'r') div.style.textAlign = 'right'; else if (line.a === 'c') div.style.textAlign = 'center';
  (line.runs || []).forEach(r => {
    if (r.t === 'chip') div.appendChild(txtMakeChipEl(r.cfg || {}));
    else if (r.t === 'text') div.appendChild(txtStyledTextNode(r.s, r.st));
  });
  if (!div.childNodes.length) div.appendChild(document.createElement('br'));
  return div;
}
// 文档模型 → 编辑区 DOM（打开模板/撤销/初始化时整体重建；日常输入不走此路）。
function txtRenderEditor() {
  const editor = $('#txtEditor'); if (!editor) return;
  // 兜底：仍是扁平旧模型(理论上 deserialize 已迁移) → 先规范成 v2 行
  const bs = TXT.doc.blocks || [];
  if (bs.length && bs[0] && bs[0].t !== 'line') TXT.doc = TextoutCore.deserialize(TextoutCore.serialize(TXT.doc));
  editor.innerHTML = '';
  (TXT.doc.blocks || []).forEach(L => editor.appendChild(txtLineEl(L)));
  txtSyncName();
}
/* 文本节点的有效内联样式：沿父链(至 root)找最近声明的 加粗/字号/颜色。
   浏览器编辑产生的 <b>/<strong> 也认。返回 v2 run.st 或 undefined。 */
function txtColorHex(cs) {
  if (/^#[0-9a-fA-F]{6}$/.test(cs)) return cs.toLowerCase();
  const m = /^rgba?\((\d+)\s*,\s*(\d+)\s*,\s*(\d+)/.exec(cs); if (!m) return undefined;
  const h = n => (+n).toString(16).padStart(2, '0');
  return '#' + h(m[1]) + h(m[2]) + h(m[3]);
}
function txtEffSt(node, root) {
  let b, fs, c, el = node.parentElement;
  while (el && el !== root && !(el.classList && el.classList.contains('to-editor'))) {
    const st = el.style || {};
    if (b === undefined) {
      if (st.fontWeight) b = (st.fontWeight === 'bold' || (+st.fontWeight) >= 600) ? 1 : 0;
      else if (el.tagName === 'B' || el.tagName === 'STRONG') b = 1;
    }
    if (fs === undefined && st.fontSize && /px$/.test(st.fontSize)) fs = Math.round(parseFloat(st.fontSize));
    if (c === undefined && st.color) c = txtColorHex(st.color);
    el = el.parentElement;
  }
  const st = {}; if (b) st.b = 1; if (fs) st.fs = fs; if (c) st.c = c;
  return Object.keys(st).length ? st : undefined;
}
/* 任意根元素 → v2 行数组（编辑区同步与"复制选区"共用）。
   规则：顶层 DIV/P=一行(对齐读 text-align)；BR=断行；散落节点归入当前隐式行；
   芯片 cfg 读 _cfg，克隆片段无 _cfg 时读 data-cfg。 */
function txtSerializeRoot(root) {
  const lines = []; let cur = null;
  const open = (align) => { cur = { t: 'line', runs: [] }; if (align === 'right') cur.a = 'r'; else if (align === 'center') cur.a = 'c'; lines.push(cur); };
  const ensure = () => { if (!cur) open(''); };
  const close = () => { cur = null; };
  const chipCfg = (el) => { if (el._cfg) return el._cfg; try { return JSON.parse(el.dataset.cfg || '{}'); } catch (e) { return {}; } };
  const walk = (node) => {
    node.childNodes.forEach((ch) => {
      if (ch.nodeType === 3) { if (ch.nodeValue) { ensure(); const st = txtEffSt(ch, root); cur.runs.push(st ? { t: 'text', s: ch.nodeValue, st: st } : { t: 'text', s: ch.nodeValue }); } }
      else if (ch.nodeType === 1) {
        if (ch.classList && ch.classList.contains('to-chip')) { ensure(); cur.runs.push({ t: 'chip', cfg: chipCfg(ch) }); }
        else if (ch.tagName === 'BR') { ensure(); close(); }
        else if (ch.tagName === 'DIV' || ch.tagName === 'P') { close(); open((ch.style && ch.style.textAlign) || ''); walk(ch); close(); }
        else walk(ch);
      }
    });
  };
  walk(root);
  if (!lines.length) open('');
  return lines;
}
// 编辑区 DOM → 文档模型（v2 行）。
function txtSerializeEditor() {
  const editor = $('#txtEditor'); if (!editor) return [];
  return txtSerializeRoot(editor);
}
// 把编辑区当前状态同步进 TXT.doc.blocks（不触发历史/保存）。
function txtSyncDoc() { TXT.doc.blocks = txtSerializeEditor(); }

/* ---------- 芯片元素 ---------- */
function txtMakeChipEl(cfg) {
  const s = document.createElement('span');
  s.className = 'to-chip' + (cfg.kind === 'compare' ? ' cmp' : '');
  s.contentEditable = 'false';
  s.setAttribute('draggable', 'false');
  s._cfg = cfg;
  txtChipSyncData(s);   // cfg 镜像到 data-cfg：克隆/复制走 DOM 时配置不丢
  s.innerHTML = '<span class="to-chip-v">…</span>';
  s.title = TextoutCore.chipLabel(cfg);
  s.addEventListener('click', (e) => { e.stopPropagation(); txtOpenConfig(s); });
  return s;
}
// cfg → data-cfg 属性（cloneNode/cloneContents 不复制 JS 属性,但复制 data-*;复制粘贴靠它带走配置）
function txtChipSyncData(el) { try { el.dataset.cfg = JSON.stringify(el._cfg || {}); } catch (e) { } }
function txtSetChipDisplay(el, str) {
  const v = el.querySelector('.to-chip-v'); if (v) v.textContent = (str == null ? '-' : str);
  el.title = TextoutCore.chipLabel(el._cfg || {});
  el.classList.toggle('nodata', str === '-' || str == null);
}

/* ---------- 光标 / 插入 ---------- */
function txtEditorFocused() { const editor = $('#txtEditor'); return editor && editor.contains(document.getSelection().anchorNode); }
function txtCurrentRange() {
  const editor = $('#txtEditor'); const sel = document.getSelection();
  if (sel && sel.rangeCount && editor.contains(sel.anchorNode)) return sel.getRangeAt(0);
  // 无有效选区 → 落到末尾
  const r = document.createRange(); r.selectNodeContents(editor); r.collapse(false); return r;
}
function txtPlaceCaretFromPoint(x, y) {
  let range = null;
  if (document.caretRangeFromPoint) range = document.caretRangeFromPoint(x, y);
  else if (document.caretPositionFromPoint) { const p = document.caretPositionFromPoint(x, y); if (p) { range = document.createRange(); range.setStart(p.offsetNode, p.offset); } }
  const sel = document.getSelection();
  if (range) { sel.removeAllRanges(); sel.addRange(range); }
}
function txtInsertNode(node) {
  const editor = $('#txtEditor'); editor.focus();
  const range = txtCurrentRange();
  range.collapse(false);
  range.insertNode(node);
  // 光标移到插入节点之后
  const after = document.createRange(); after.setStartAfter(node); after.collapse(true);
  const sel = document.getSelection(); sel.removeAllRanges(); sel.addRange(after);
}
function txtInsertTextAtCaret(text) {
  const parts = String(text).split('\n');
  const frag = document.createDocumentFragment();
  parts.forEach((p, i) => { if (i > 0) frag.appendChild(document.createElement('br')); if (p) frag.appendChild(document.createTextNode(p)); });
  txtInsertNode(frag);
}
// 内部粘贴：v2 行数组 → 在光标处重建（文本带样式、芯片带 cfg 深拷贝；行间用 <br>,同步时自动归行）
function txtInsertBlocksAtCaret(blocks) {
  let norm;
  try { norm = TextoutCore.deserialize(JSON.stringify({ v: 2, blocks: blocks })).blocks; } catch (e) { return; }
  const frag = document.createDocumentFragment();
  norm.forEach((L, i) => {
    if (i > 0) frag.appendChild(document.createElement('br'));
    (L.runs || []).forEach(r => {
      if (r.t === 'chip') frag.appendChild(txtMakeChipEl(JSON.parse(JSON.stringify(r.cfg || {}))));
      else frag.appendChild(txtStyledTextNode(r.s, r.st));
    });
  });
  txtInsertNode(frag);
}

/* ---------- 光标行 / 排版应用 ---------- */
// 光标所在的行 div（编辑区直接子级）；散落节点(无行结构)时先把它们包成一行再返回
function txtCaretLineEl() {
  const editor = $('#txtEditor'); if (!editor) return null;
  const sel = document.getSelection();
  if (!sel || !sel.anchorNode || !editor.contains(sel.anchorNode)) return null;
  let n = sel.anchorNode;
  while (n && n.parentNode !== editor) n = n.parentNode;
  if (n && n.nodeType === 1 && (n.tagName === 'DIV' || n.tagName === 'P')) return n;
  return txtWrapLooseLead();
}
// 编辑区开头的散落节点(首行无 div 包裹时)包进一个行 div,保证行级操作可用
function txtWrapLooseLead() {
  const editor = $('#txtEditor'); if (!editor || !editor.firstChild) return null;
  const f = editor.firstChild;
  if (f.nodeType === 1 && (f.tagName === 'DIV' || f.tagName === 'P')) return null;
  const sel = document.getSelection();
  const keep = (sel && sel.rangeCount) ? sel.getRangeAt(0).cloneRange() : null;
  const div = document.createElement('div'); div.className = 'to-line';
  while (editor.firstChild && !(editor.firstChild.nodeType === 1 && (editor.firstChild.tagName === 'DIV' || editor.firstChild.tagName === 'P'))) {
    if (editor.firstChild.nodeType === 1 && editor.firstChild.tagName === 'BR') { editor.removeChild(editor.firstChild); break; }
    div.appendChild(editor.firstChild);
  }
  editor.insertBefore(div, editor.firstChild);
  if (keep) { try { sel.removeAllRanges(); sel.addRange(keep); } catch (e) { } }
  return div;
}
function txtSelRangeInEditor() {
  const editor = $('#txtEditor'); const sel = document.getSelection();
  if (!sel || !sel.rangeCount) return null;
  const r = sel.getRangeAt(0);
  return editor.contains(r.commonAncestorContainer) ? r : null;
}
// 选中文字应用内联样式：extractContents 搬移选区(芯片元素身份保留)→片段内文本节点逐个包 span → 放回并保持选中
function txtApplyStyle(styleObj) {
  const r = txtSelRangeInEditor();
  if (!r || r.collapsed) { toast('先选中要设置的文字', 'warn'); return; }
  const frag = r.extractContents();
  const w = document.createTreeWalker(frag, NodeFilter.SHOW_TEXT, null);
  const nodes = []; let n; while ((n = w.nextNode())) nodes.push(n);
  nodes.forEach(tn => {
    if (!tn.nodeValue) return;
    if (tn.parentElement && tn.parentElement.closest('.to-chip')) return;   // 芯片内部文字不动
    const sp = document.createElement('span');
    Object.assign(sp.style, styleObj);
    tn.parentNode.insertBefore(sp, tn); sp.appendChild(tn);
  });
  const first = frag.firstChild, last = frag.lastChild;
  r.insertNode(frag);
  if (first && last) {   // 恢复选中,便于连续操作(先加粗再改色)
    const sel = document.getSelection(); const nr = document.createRange();
    nr.setStartBefore(first); nr.setEndAfter(last);
    sel.removeAllRanges(); sel.addRange(nr);
  }
  txtSyncDoc(); txtScheduleHist(); txtScheduleSave();
}
function txtToggleBold() {
  const r = txtSelRangeInEditor();
  if (!r || r.collapsed) { toast('先选中要加粗的文字', 'warn'); return; }
  let probe = r.startContainer;
  if (probe.nodeType !== 3) probe = probe.childNodes[r.startOffset] || probe.firstChild || probe;
  const st = (probe.nodeType === 3 || probe.nodeType === 1) ? txtEffSt(probe.nodeType === 3 ? probe : { parentElement: probe }, $('#txtEditor')) : undefined;
  const bold = !!(st && st.b);
  txtApplyStyle({ fontWeight: bold ? '400' : '700' });
}
// 行对齐：作用于选区覆盖的所有行(或光标所在行)。左=清除(默认),右=right
function txtApplyAlign(a) {
  const editor = $('#txtEditor');
  const r = txtSelRangeInEditor();
  let lines = [];
  if (r && !r.collapsed) {
    editor.childNodes.forEach(ch => { if (ch.nodeType === 1 && (ch.tagName === 'DIV' || ch.tagName === 'P') && r.intersectsNode(ch)) lines.push(ch); });
  }
  if (!lines.length) { const l = txtCaretLineEl(); if (l) lines = [l]; }
  if (!lines.length) { toast('把光标放到目标行再点对齐', 'warn'); return; }
  lines.forEach(l => { l.style.textAlign = (a === 'r') ? 'right' : ''; });
  txtSyncDoc(); txtScheduleHist(); txtScheduleSave();
}

function txtInsertChip(kind) {
  const chip = txtMakeChipEl(txtDefaultCfg(kind));
  // 芯片两侧补一个空格文本，便于继续打字/避免粘连。
  const sp = document.createTextNode(' ');
  txtInsertNode(chip);
  chip.parentNode && chip.parentNode.insertBefore(sp, chip.nextSibling);
  const after = document.createRange(); after.setStartAfter(sp); after.collapse(true);
  const sel = document.getSelection(); sel.removeAllRanges(); sel.addRange(after);
  txtSyncDoc(); txtScheduleHist(); txtScheduleSave();
  txtResolveOne(chip);
  txtRenderOutput();
}

/* ============================================================
   撤销/重做（PptHistory 防抖快照）
   ============================================================ */
function txtHistSnap() { txtSyncDoc(); return TextoutCore.serialize(TXT.doc); }
function txtHistInit() { TXT.hist = PptHistory.create(50); TXT.hist.committed = TextoutCore.serialize(TXT.doc); }
function txtScheduleHist() { clearTimeout(TXT._histTimer); TXT._histTimer = setTimeout(txtCommitHist, 450); }
function txtCommitHist() { if (TXT.hist && !TXT._restoring) PptHistory.record(TXT.hist, txtHistSnap()); }
function txtUndo() { txtCommitHist(); const s = PptHistory.undo(TXT.hist); if (s != null) txtRestore(s); }
function txtRedo() { const s = PptHistory.redo(TXT.hist); if (s != null) txtRestore(s); }
function txtRestore(s) {
  TXT._restoring = true;
  try { TXT.doc = TextoutCore.deserialize(s); txtRenderEditor(); txtRefreshAll(); txtScheduleSave(); }
  finally { TXT._restoring = false; }
}

/* ============================================================
   解析 + 输出
   ============================================================ */
function txtScheduleRefresh() { clearTimeout(TXT._refTimer); TXT._refTimer = setTimeout(txtRefreshAll, 350); }

// 重解析全部芯片 → 更新芯片内嵌值 + 输出区纯文本。竞态令牌守卫。
async function txtRefreshAll() {
  txtSyncDoc();
  const editor = $('#txtEditor'); if (!editor) return;
  const chips = Array.from(editor.querySelectorAll('.to-chip'));
  const token = ++TXT.gen;
  const resolved = {};
  await Promise.all(chips.map(async (el, i) => {
    const str = await txtResolveChip(el._cfg || {});
    if (token !== TXT.gen) return;
    resolved[i] = str;
    txtSetChipDisplay(el, str);
  }));
  if (token !== TXT.gen) return;
  TXT.resolved = resolved;
  txtRenderOutput();
}
// 只解析单个芯片（插入/改配置后即时反馈）。
async function txtResolveOne(el) {
  const str = await txtResolveChip(el._cfg || {});
  txtSetChipDisplay(el, str);
  txtRenderOutput();   // 输出区按当前 resolved 重拼（该芯片值先在 map 里补上）
}
function txtRenderOutput() {
  const out = $('#txtOutput'); if (!out) return;
  // 以编辑区实时芯片顺序重建 resolved 序号映射（保证与 blocks 芯片序一致）。
  txtSyncDoc();
  const editor = $('#txtEditor');
  const chips = editor ? Array.from(editor.querySelectorAll('.to-chip')) : [];
  const resolved = {};
  chips.forEach((el, i) => { const v = el.querySelector('.to-chip-v'); resolved[i] = v ? v.textContent : '-'; });
  out.textContent = TextoutCore.renderText(TXT.doc.blocks, resolved);
}

// 芯片 cfg → 已格式化字符串。异常/取不到 → '-'。
async function txtResolveChip(cfg) {
  try {
    if (!cfg || !cfg.measure) return '-';
    if (cfg.kind === 'compare') return await txtResolveCompare(cfg);
    return await txtResolveValue(cfg);
  } catch (e) { return '-'; }
}

async function txtResolveValue(cfg) {
  const ds = cfg.dataset || 'psi';
  const now = TXT.now || new Date();
  if (ds === 'finance') {
    const el = { type: 'data', binding: txtFinBinding(cfg) };
    const res = await PptBindings.resolveElement(api, PptBind, el);
    const v = (res && res.kind === 'value') ? res.value : null;
    return txtFmtFinance(v, cfg);
  }
  if (ds === 'idc') {
    const el = { type: 'data', binding: { dataset: 'idc', measure: cfg.measure, filters: cfg.filters || {} } };
    const res = await PptBindings.resolveElement(api, PptBind, el);
    return TextoutCore.formatNum((res && res.kind === 'value') ? res.value : null, cfg.fmt);
  }
  // PSI
  if (txtIsSnapshot(cfg)) {   // inv/dos 现值（report total 快照）
    const el = { type: 'data', binding: { dataset: 'psi', measure: cfg.measure, filters: cfg.filters || {} } };
    const res = await PptBindings.resolveElement(api, PptBind, el);
    const v = (res && res.kind === 'value') ? res.value : null;
    return TextoutCore.formatNum(v, cfg.fmt);
  }
  const t = TextoutCore.resolveTime(cfg.time, now);
  const syn = TextoutCore.chipToMatrixParams(cfg);
  const m = await PptBind.resolveMatrix(api, syn);
  const v = TextoutCore.aggMatrix(m, t.from, t.to, TextoutCore.aggType(cfg));
  return TextoutCore.formatNum(v, cfg.fmt);
}

async function txtResolveCompare(cfg) {
  const ds = cfg.dataset || 'psi';
  const now = TXT.now || new Date();
  if (ds === 'finance') {
    // 复用 comparePeriodsForPreset（月口径）+ resolveFinanceTotal。custom 退化为 yoy。
    const preset = cfg.preset === 'mom' ? 'mom' : 'yoy';
    const per = PptBind.comparePeriodsForPreset(preset, { curYear: cfg.year != null ? cfg.year : txtFinYear(), fromM: cfg.fromM, toM: cfg.toM });
    const mk = (pp) => txtFinBinding(Object.assign({}, cfg, { year: pp.year, fromM: pp.fromM, toM: pp.toM }));
    const A = await PptBind.resolveFinanceTotal(api, mk(per.a));
    const B = await PptBind.resolveFinanceTotal(api, mk(per.b));
    return TextoutCore.formatCompare(B, A, cfg.fmt);
  }
  // 先取矩阵再派生对比期：从日桶里拿"数据最新日"喂给 comparePeriod 做同期截断
  // （对齐 PSI/产业/汇总的口径——去年同期只算到今年数据最新日的同期为止）。
  const syn = TextoutCore.chipToMatrixParams(cfg);
  const m = (ds === 'idc') ? await PptBind.resolveIdcMatrix(api, syn) : await PptBind.resolveMatrix(api, syn);
  const cats = (m && m.cats) || [];
  let lastDay = null;
  for (let i = cats.length - 1; i >= 0; i--) { if (/^\d{4}-\d{2}-\d{2}$/.test(cats[i])) { lastDay = cats[i]; break; } }
  const cp = TextoutCore.comparePeriod(cfg, now, lastDay);
  const at = TextoutCore.aggType(cfg);
  const cur = TextoutCore.aggMatrix(m, cp.base.from, cp.base.to, at);
  const ref = TextoutCore.aggMatrix(m, cp.cmp.from, cp.cmp.to, at);
  return TextoutCore.formatCompare(cur, ref, cfg.fmt);
}

// 财经默认年（最新实际年）：cfg 未显式选年时兜底，保证能取到数。
function txtFinYear() {
  const fm = (typeof state !== 'undefined' && state.finMeta) || {};
  const ay = (fm.actualYears && fm.actualYears.length) ? fm.actualYears : (fm.years || []);
  return ay.length ? ay[ay.length - 1] : undefined;
}
// 财经 binding（resolveFinanceTotal 入参口径）。
function txtFinBinding(cfg) {
  return { dataset: 'finance', measure: cfg.measure, basis: cfg.basis || 'actual', filters: cfg.filters || {},
    year: cfg.year != null ? cfg.year : txtFinYear(), fromM: cfg.fromM, toM: cfg.toM, version: cfg.version, finUnits: { actual: 'USD', forecast: 'MUSD', bp: 'USD' } };
}
// 财经数值格式：率类(gmr/达成率)→%、其余→单位格式。
function txtFmtFinance(v, cfg) {
  if (v == null || isNaN(v)) return '-';
  const dec = (cfg.fmt && cfg.fmt.decimals != null) ? cfg.fmt.decimals : 1;
  if (cfg.measure === 'gmr' || cfg.measure === 'bpAttain' || cfg.measure === 'fcAttain') return (v * 100).toFixed(Math.max(0, Math.min(3, dec))) + '%';
  return TextoutCore.formatNum(v, cfg.fmt);
}

/* ---------- 复制 ---------- */
function txtCopyAll() {
  const out = $('#txtOutput'); if (!out) return;
  const text = out.textContent || '';
  const done = () => toast('已复制全部文字');
  if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done).catch(() => txtCopyFallback(text, done));
  else txtCopyFallback(text, done);
}
function txtCopyFallback(text, done) {
  const ta = document.createElement('textarea'); ta.value = text; ta.style.position = 'fixed'; ta.style.left = '-9999px';
  document.body.appendChild(ta); ta.select();
  try { document.execCommand('copy'); done(); } catch (e) { toast('复制失败，请手动选中', 'warn'); }
  document.body.removeChild(ta);
}

/* ============================================================
   芯片配置弹板（数据源 / 级联筛选 / 时间 / 格式）
   ============================================================ */
function txtCloseConfig() {
  const p = $('#txtCfgPop'); if (p) p.remove();
  TXT.cfgEl = null;
  document.removeEventListener('click', txtCfgOutside, true);
}
function txtCfgOutside(e) {
  const p = $('#txtCfgPop'); if (!p) return;
  if (p.contains(e.target)) return;
  if (e.target.closest && e.target.closest('.ms-panel')) return;   // 多选面板挂在 body/panel 内，视作内部
  if (e.target.classList && e.target.classList.contains('to-chip')) return;
  txtCloseConfig();
}
function txtOpenConfig(chipEl) {
  txtCloseConfig();
  TXT.cfgEl = chipEl;
  const pop = document.createElement('div');
  // 右侧固定设置栏(.to-cfgdock)：不再按芯片位置弹出,贴屏幕右缘占满视口高、栏内滚动——
  // 修「筛选浮层太长超出屏幕、最底部看不到」。定位全交给 CSS,这里不再算 left/top。
  pop.className = 'to-cfgpop to-cfgdock'; pop.id = 'txtCfgPop';
  pop.addEventListener('click', (e) => e.stopPropagation());
  document.body.appendChild(pop);
  txtRenderConfig(pop, chipEl);
  setTimeout(() => document.addEventListener('click', txtCfgOutside, true), 0);
}

// 改 cfg 单字段 → 落到 el._cfg → 同步文档 + 重解析该芯片 + 存。
function txtCfgPatch(chipEl, partial, rerenderPop) {
  chipEl._cfg = Object.assign({}, chipEl._cfg, partial);
  txtChipSyncData(chipEl);
  txtSyncDoc(); txtScheduleHist(); txtScheduleSave();
  txtResolveOne(chipEl);
  if (rerenderPop) { const pop = $('#txtCfgPop'); if (pop) txtRenderConfig(pop, chipEl); }
}
function txtCfgPatchFmt(chipEl, partial) {
  const fmt = Object.assign({}, chipEl._cfg.fmt, partial);
  txtCfgPatch(chipEl, { fmt: fmt });
}
function txtSetFilter(chipEl, field, vals) {
  const filters = Object.assign({}, chipEl._cfg.filters);
  if (vals && vals.length) filters[field] = vals.slice(); else delete filters[field];
  chipEl._cfg = Object.assign({}, chipEl._cfg, { filters: filters });
  txtChipSyncData(chipEl);
  txtSyncDoc(); txtScheduleHist(); txtScheduleSave();
  txtResolveOne(chipEl);
}

function txtRenderConfig(pop, chipEl) {
  const cfg = chipEl._cfg || {};
  const ds = cfg.dataset || 'psi';
  const isCmp = cfg.kind === 'compare';
  let h = '<div class="to-cfg-h">' + (isCmp ? '同比/环比芯片' : '数值芯片') +
    '<button class="to-cfg-x" id="txtCfgClose">✕</button></div><div class="to-cfg-body">';

  // 类型切换（数值 ↔ 同比/环比）
  h += txtRow('类型', '<select id="cfgKind">' +
    [['value', '数值'], ['compare', '同比/环比']].map(o => '<option value="' + o[0] + '"' + (cfg.kind === o[0] ? ' selected' : '') + '>' + o[1] + '</option>').join('') + '</select>');
  // 数据源
  h += txtRow('数据源', '<select id="cfgDs">' + txtDsList().map(o => '<option value="' + o[0] + '"' + (ds === o[0] ? ' selected' : '') + '>' + o[1] + '</option>').join('') + '</select>');
  // 指标
  h += txtRow('指标', '<select id="cfgMeas">' + txtMeasures(ds).map(o => '<option value="' + o[0] + '"' + (cfg.measure === o[0] ? ' selected' : '') + '>' + txtEsc(o[1]) + '</option>').join('') + '</select>');

  // 聚合（PSI 流量指标才有）
  if (!isCmp && ds === 'psi' && !txtIsSnapshot(cfg)) {
    h += txtRow('聚合', '<select id="cfgAgg">' +
      [['sum', '区间求和'], ['dayavg', '日均'], ['last', '最新值'], ['avg', '桶均值'], ['max', '最大'], ['min', '最小']].map(o => '<option value="' + o[0] + '"' + ((cfg.agg || 'sum') === o[0] ? ' selected' : '') + '>' + o[1] + '</option>').join('') + '</select>');
  }

  // 时间
  if (isCmp) {
    if (ds === 'finance') {
      h += '<div class="pd-bsec">对比（财经 · 月口径）</div>';
      h += txtRow('对比', '<select id="cfgPreset">' + [['yoy', '同比(去年同期)'], ['mom', '环比(上月)']].map(o => '<option value="' + o[0] + '"' + ((cfg.preset || 'yoy') === o[0] ? ' selected' : '') + '>' + o[1] + '</option>').join('') + '</select>');
      h += txtFinTimeRows(cfg);
    } else {
      // 对比方式 pill：同比 / 环比 / 自定义两期；环比再给 日/周/月 一键快捷(=改基期时间模式),基期行保留=自定义环比
      const pv = cfg.preset || 'yoy';
      h += '<div class="pd-bsec">对比方式</div>';
      h += '<div class="to-pills" id="cfgCmpPills">' + [['yoy', '同比'], ['mom', '环比'], ['custom', '自定义两期']].map(o =>
        '<button class="to-pill' + (pv === o[0] ? ' on' : '') + '" data-p="' + o[0] + '">' + o[1] + '</button>').join('') + '</div>';
      if (pv === 'mom') {
        const m = (cfg.time && cfg.time.mode) || '';
        h += '<div class="to-pills" id="cfgMomPills">' + [['day', '日环比'], ['week', '周环比'], ['month', '月环比']].map(o => {
          const on = (o[0] === 'day' && m === 'yesterday') || (o[0] === 'week' && m === 'wtd') || (o[0] === 'month' && m === 'mtd');
          return '<button class="to-pill sm' + (on ? ' on' : '') + '" data-mq="' + o[0] + '">' + o[1] + '</button>';
        }).join('') + '</div>';
        h += '<div class="to-cfg-note">日=昨日对前日 · 周=本周至今对上周同段 · 月=本月至今对上月同段；也可在下方"基期"自定义区间(环比=上一等长期)</div>';
      }
      h += '<div class="pd-bsec">基期</div>' + txtTimeRows(cfg.time || {}, 't');
      if (cfg.preset === 'custom') h += '<div class="pd-bsec">对比期</div>' + txtTimeRows(cfg.cmpTime || { mode: 'custom' }, 'c');
    }
  } else {
    if (ds === 'finance') { h += '<div class="pd-bsec">时间（财经 · 月口径）</div>' + txtFinTimeRows(cfg); }
    else if (txtIsSnapshot(cfg)) { h += '<div class="to-cfg-note">现值快照（渠道库存 / DOS，取最新期）</div>'; }
    else { h += '<div class="pd-bsec">时间</div>' + txtTimeRows(cfg.time || {}, 't'); }
  }

  // 筛选
  h += '<div class="pd-bsec">筛选' + (ds === 'finance' ? '' : '（级联）') + '</div><div id="cfgFilters"></div>';

  // 格式
  h += '<div class="pd-bsec">格式</div>';
  if (isCmp) {
    h += txtRow('输出', '<select id="cfgFmt">' + [['pct', '同比 ±%'], ['pp', '百分点 ±pp'], ['abs', '差值 ±绝对']].map(o => '<option value="' + o[0] + '"' + (((cfg.fmt && cfg.fmt.fmt) || 'pct') === o[0] ? ' selected' : '') + '>' + o[1] + '</option>').join('') + '</select>');
    h += txtRow('小数位', '<input type="number" id="cfgDec" min="0" max="3" value="' + ((cfg.fmt && cfg.fmt.decimals != null) ? cfg.fmt.decimals : 2) + '">');
    h += txtRow('后缀', '<input type="text" id="cfgSuffix" value="' + txtEsc((cfg.fmt && cfg.fmt.suffix) || '') + '" placeholder="如 同比/pct">');
  } else {
    h += txtRow('单位', '<select id="cfgUnit">' + [['auto', '自动'], ['none', '原值(千分位)'], ['k', '千 k'], ['W', '万 W'], ['M', '百万 M']].map(o => '<option value="' + o[0] + '"' + (((cfg.fmt && cfg.fmt.unit) || 'auto') === o[0] ? ' selected' : '') + '>' + o[1] + '</option>').join('') + '</select>');
    h += txtRow('小数位', '<input type="number" id="cfgDec" min="0" max="3" value="' + ((cfg.fmt && cfg.fmt.decimals != null) ? cfg.fmt.decimals : 1) + '">');
    h += txtRow('后缀', '<input type="text" id="cfgSuffix" value="' + txtEsc((cfg.fmt && cfg.fmt.suffix) || '') + '" placeholder="如 台/%/无">');
  }

  h += '</div><div class="to-cfg-foot"><button class="btn ghost" id="cfgDelete">删除芯片</button><button class="btn ghost" id="cfgDup" title="在旁边插入同配置副本(筛选/时间/口径全保留),改副本不影响本芯片">复制此芯片</button><span class="to-spacer"></span><button class="btn" id="cfgDone">完成</button></div>';
  pop.innerHTML = h;
  txtWireConfig(pop, chipEl);
}

function txtFinTimeRows(cfg) {
  const fm = (typeof state !== 'undefined' && state.finMeta) || {};
  const ay = (fm.actualYears && fm.actualYears.length) ? fm.actualYears : (fm.years || []);
  let h = txtRow('年', '<select id="cfgYear">' + ay.map(y => '<option value="' + y + '"' + (String(cfg.year) === String(y) ? ' selected' : '') + '>' + y + '</option>').join('') + '</select>');
  const moOpt = (cur, latest) => { let s = latest ? ('<option value=""' + (cur == null ? ' selected' : '') + '>最新</option>') : ''; for (let m = 1; m <= 12; m++) s += '<option value="' + m + '"' + (String(cur) === String(m) ? ' selected' : '') + '>' + m + ' 月</option>'; return s; };
  h += txtRow('月 从', '<select id="cfgFromM">' + moOpt(cfg.fromM == null ? 1 : cfg.fromM, false) + '</select>');
  h += txtRow('月 到', '<select id="cfgToM">' + moOpt(cfg.toM, true) + '</select>');
  return h;
}
// 相对时间控件（prefix 't'=基期/普通，'c'=对比期）。
function txtTimeRows(t, pfx) {
  const mode = t.mode || 'wtd';
  let h = txtRow('区间', '<select id="cfg' + pfx + 'Mode">' +
    [['yesterday', '昨日'], ['wtd', '本周至今'], ['mtd', '本月至今'], ['ytd', '年至今'], ['lastN', '最近N天'], ['custom', '自定义']].map(o => '<option value="' + o[0] + '"' + (mode === o[0] ? ' selected' : '') + '>' + o[1] + '</option>').join('') + '</select>');
  if (mode === 'lastN') h += txtRow('N 天', '<input type="number" id="cfg' + pfx + 'N" min="1" max="366" value="' + (t.n || 7) + '">');
  if (mode === 'custom') {
    h += txtRow('从', '<input type="date" id="cfg' + pfx + 'From" value="' + (t.from || '') + '">');
    h += txtRow('到', '<input type="date" id="cfg' + pfx + 'To" value="' + (t.to || '') + '">');
  }
  return h;
}

function txtWireConfig(pop, chipEl) {
  const byId = (id) => pop.querySelector('#' + id);
  const cfg = chipEl._cfg || {};
  const ds = cfg.dataset || 'psi';

  byId('txtCfgClose').onclick = txtCloseConfig;
  byId('cfgDone').onclick = txtCloseConfig;
  byId('cfgDelete').onclick = () => { txtDeleteChip(chipEl); txtCloseConfig(); };
  // 复制此芯片：cfg 深拷贝插到源芯片右侧,新芯片独立可改,源不受影响
  byId('cfgDup').onclick = () => {
    const clone = JSON.parse(JSON.stringify(chipEl._cfg || {}));
    const el = txtMakeChipEl(clone);
    const sp = document.createTextNode(' ');
    chipEl.parentNode.insertBefore(sp, chipEl.nextSibling);
    chipEl.parentNode.insertBefore(el, sp.nextSibling);
    txtSyncDoc(); txtScheduleHist(); txtScheduleSave();
    txtResolveOne(el);
    toast('已复制芯片，点新芯片改筛选');
  };
  // 对比方式 pill（同比/环比/两期）与 日/周/月环比快捷
  pop.querySelectorAll('#cfgCmpPills .to-pill').forEach(b => b.onclick = () => txtCfgPatch(chipEl, { preset: b.dataset.p }, true));
  pop.querySelectorAll('#cfgMomPills .to-pill').forEach(b => b.onclick = () => {
    const t = TextoutCore.momQuickTime(b.dataset.mq);
    if (t) txtCfgPatch(chipEl, { time: t }, true);
  });

  byId('cfgKind').onchange = (e) => {
    const nk = e.target.value;
    const base = txtDefaultCfg(nk);
    // 保留数据源/指标/筛选，换类型专属字段。
    chipEl._cfg = Object.assign(base, { dataset: cfg.dataset, measure: cfg.measure, filters: cfg.filters, agg: cfg.agg, time: cfg.time || base.time });
    txtChipSyncData(chipEl);
    chipEl.className = 'to-chip' + (nk === 'compare' ? ' cmp' : '');
    txtSyncDoc(); txtScheduleHist(); txtScheduleSave(); txtResolveOne(chipEl);
    txtRenderConfig(pop, chipEl);
  };
  byId('cfgDs').onchange = (e) => {
    const nds = e.target.value;
    const measures = txtMeasures(nds);
    txtCfgPatch(chipEl, { dataset: nds, measure: (measures[0] || [])[0], filters: {} }, true);
  };
  byId('cfgMeas').onchange = (e) => txtCfgPatch(chipEl, { measure: e.target.value }, true);

  const aggSel = byId('cfgAgg'); if (aggSel) aggSel.onchange = (e) => txtCfgPatch(chipEl, { agg: e.target.value });

  const preset = byId('cfgPreset'); if (preset) preset.onchange = (e) => txtCfgPatch(chipEl, { preset: e.target.value }, true);

  // 财经年/月
  const yEl = byId('cfgYear'); if (yEl) yEl.onchange = (e) => txtCfgPatch(chipEl, { year: parseInt(e.target.value, 10) });
  const fmEl = byId('cfgFromM'); if (fmEl) fmEl.onchange = (e) => txtCfgPatch(chipEl, { fromM: e.target.value ? parseInt(e.target.value, 10) : 1 });
  const tmEl = byId('cfgToM'); if (tmEl) tmEl.onchange = (e) => txtCfgPatch(chipEl, { toM: e.target.value ? parseInt(e.target.value, 10) : undefined });

  // 相对时间（基期 t / 对比期 c）
  txtWireTime(pop, chipEl, 't', 'time');
  txtWireTime(pop, chipEl, 'c', 'cmpTime');

  // 格式
  const unit = byId('cfgUnit'); if (unit) unit.onchange = (e) => txtCfgPatchFmt(chipEl, { unit: e.target.value });
  const fmt = byId('cfgFmt'); if (fmt) fmt.onchange = (e) => txtCfgPatchFmt(chipEl, { fmt: e.target.value });
  const dec = byId('cfgDec'); if (dec) dec.onchange = (e) => txtCfgPatchFmt(chipEl, { decimals: Math.max(0, Math.min(3, parseInt(e.target.value, 10) || 0)) });
  const sfx = byId('cfgSuffix'); if (sfx) sfx.oninput = (e) => txtCfgPatchFmt(chipEl, { suffix: e.target.value });

  txtRenderCfgFilters(pop, chipEl);
}
function txtWireTime(pop, chipEl, pfx, key) {
  const byId = (id) => pop.querySelector('#' + id);
  const modeEl = byId('cfg' + pfx + 'Mode'); if (!modeEl) return;
  const patchTime = (partial, rerender) => {
    const cur = Object.assign({}, chipEl._cfg[key], partial);
    txtCfgPatch(chipEl, { [key]: cur }, rerender);
  };
  modeEl.onchange = (e) => patchTime({ mode: e.target.value }, true);
  const nEl = byId('cfg' + pfx + 'N'); if (nEl) nEl.onchange = (e) => patchTime({ n: Math.max(1, parseInt(e.target.value, 10) || 7) });
  const fromEl = byId('cfg' + pfx + 'From'); if (fromEl) fromEl.onchange = (e) => patchTime({ from: e.target.value || null });
  const toEl = byId('cfg' + pfx + 'To'); if (toEl) toEl.onchange = (e) => patchTime({ to: e.target.value || null });
}

// 级联筛选区（PSI/IDC 级联，财经非级联）。写 cfg.filters。
function txtRenderCfgFilters(pop, chipEl) {
  const box = pop.querySelector('#cfgFilters'); if (!box) return;
  box.innerHTML = '';
  const cfg = chipEl._cfg || {};
  const ds = cfg.dataset || 'psi';
  const dims = txtDims(ds);
  if (!dims.length) { box.innerHTML = '<div class="to-cfg-note">（无可用维度，先锚定数据）</div>'; return; }
  dims.forEach(field => {
    const slot = document.createElement('div'); slot.className = 'pd-fslot'; box.appendChild(slot);
    const cur = (cfg.filters && cfg.filters[field]) || [];
    txtFetchOptions(ds, field, cfg.filters, (opts) => {
      if (!slot.isConnected) return;
      const ms = makeMultiSelect(txtDimLabel(field, ds), opts || [], cur, {
        onCommit: (sel) => {
          txtSetFilter(chipEl, field, sel);
          if (ds !== 'finance') txtRenderCfgFilters(pop, chipEl);   // 级联：其它维 options 收窄
        }
      });
      slot.innerHTML = ''; slot.appendChild(ms);
    });
  });
}
function txtFetchOptions(ds, field, filters, cb) {
  const others = {}; Object.keys(filters || {}).forEach(k => { if (k !== field) others[k] = filters[k]; });
  try {
    if (ds === 'idc') { Promise.resolve(api.idcOptions(field, others)).then(o => cb(o || [])).catch(() => cb([])); return; }
    if (ds === 'finance') {
      Promise.resolve(api.financeCustom({ rowDim: field, metrics: ['rev'], basis: 'actual' }))
        .then(r => cb(((r && r.rows) || []).map(x => x.key).filter(k => k != null && k !== ''))).catch(() => cb([]));
      return;
    }
    Promise.resolve(api.options(field, others)).then(o => cb(o || [])).catch(() => cb([]));
  } catch (e) { cb([]); }
}

function txtDeleteChip(chipEl) {
  const sib = chipEl.nextSibling;
  chipEl.remove();
  if (sib && sib.nodeType === 3 && sib.nodeValue === ' ') sib.remove();
  txtSyncDoc(); txtScheduleHist(); txtScheduleSave(); txtRefreshAll();
}

/* ============================================================
   模板存取（sb.textout.v1）
   ============================================================ */
function txtStore() { const o = boardStateLoad(TXT_KEY); return (o && typeof o === 'object') ? o : { current: null, templates: [], name: '' }; }
function txtWriteStore(o) { boardStateWrite(TXT_KEY, o); }
function txtScheduleSave() { clearTimeout(TXT._saveTimer); TXT._saveTimer = setTimeout(txtSaveCurrent, 500); }
function txtSaveCurrent() { txtSyncDoc(); const o = txtStore(); o.current = TXT.doc.blocks; txtWriteStore(o); }
function txtLoadCurrent() {
  const o = txtStore();
  if (o && Array.isArray(o.current)) return TextoutCore.deserialize(JSON.stringify({ v: 1, blocks: o.current }));
  return TextoutCore.emptyDoc();
}
function txtSyncName() { const el = $('#txtDocName'); if (el) { const o = txtStore(); el.textContent = o.name ? ('模板：' + o.name) : '未命名'; } }

function txtNewDoc() {
  if (TXT.doc.blocks && TXT.doc.blocks.length && !confirm('新建将清空当前编辑内容，确定？')) return;
  TXT.doc = TextoutCore.emptyDoc();
  const o = txtStore(); o.name = ''; txtWriteStore(o);
  txtRenderEditor(); txtHistInit(); txtRefreshAll(); txtSaveCurrent(); txtSyncName();
}
// 内联命名弹窗——Electron 不支持 window.prompt(静默返回 null),必须自绘输入框。
// Enter=确定,Esc=取消;done(name) 只在确认且非空时回调。
function txtAskName(title, defVal, done) {
  const old = $('#txtNamePop'); if (old) old.remove();
  const ov = document.createElement('div'); ov.id = 'txtNamePop';
  ov.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.35);z-index:1300;display:flex;align-items:center;justify-content:center';
  ov.innerHTML = '<div style="background:var(--c-bg-elev);border-radius:10px;padding:16px 18px;width:360px;box-shadow:var(--shadow-l)">' +
    '<div style="font-size:13px;font-weight:600;margin-bottom:10px">' + txtEsc(title) + '</div>' +
    '<input id="txtNameInp" style="width:100%;border:1px solid var(--line);border-radius:7px;padding:7px 9px;font:inherit">' +
    '<div style="display:flex;gap:8px;justify-content:flex-end;margin-top:12px">' +
    '<button class="btn ghost" id="txtNameCancel">取消</button><button class="btn primary" id="txtNameOk">确定</button></div></div>';
  document.body.appendChild(ov);
  const inp = ov.querySelector('#txtNameInp'); inp.value = defVal || '';
  const close = () => ov.remove();
  const ok = () => { const v = (inp.value || '').trim(); close(); if (v) done(v); };
  ov.querySelector('#txtNameOk').onclick = ok;
  ov.querySelector('#txtNameCancel').onclick = close;
  ov.addEventListener('click', (e) => { if (e.target === ov) close(); });
  inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); ok(); } else if (e.key === 'Escape') { e.preventDefault(); close(); } });
  inp.focus(); inp.select();
}
function txtSaveAsTemplate() {
  txtSyncDoc();
  txtAskName('模板名称：', (txtStore().name) || '周报模板', (name) => {
    const o = txtStore();
    o.templates = Array.isArray(o.templates) ? o.templates : [];
    const id = 't' + Date.now().toString(36);
    o.templates.push({ id: id, name: name, blocks: TXT.doc.blocks });
    o.name = name; o.current = TXT.doc.blocks;
    txtWriteStore(o); txtSyncName();
    toast('已另存模板：' + name);
  });
}
function txtOpenTemplateModal() {
  const o = txtStore();
  const tpls = Array.isArray(o.templates) ? o.templates : [];
  let pop = $('#txtTplPop'); if (pop) pop.remove();
  pop = document.createElement('div'); pop.className = 'to-cfgpop to-tplpop'; pop.id = 'txtTplPop';
  pop.addEventListener('click', (e) => e.stopPropagation());
  let h = '<div class="to-cfg-h">打开 / 管理模板<button class="to-cfg-x" id="txtTplClose">✕</button></div><div class="to-cfg-body">';
  if (!tpls.length) h += '<div class="to-cfg-note">还没有已存模板。用「另存为模板」保存当前内容。</div>';
  else h += tpls.map(t => '<div class="to-tpl-row" data-id="' + t.id + '"><span class="to-tpl-name">' + txtEsc(t.name) + '</span>' +
    '<button class="btn ghost to-tpl-open" data-id="' + t.id + '">打开</button>' +
    '<button class="btn ghost to-tpl-rename" data-id="' + t.id + '">改名</button>' +
    '<button class="btn ghost to-tpl-del" data-id="' + t.id + '">删除</button></div>').join('');
  h += '</div>';
  pop.innerHTML = h;
  document.body.appendChild(pop);
  const r = $('#txtOpen').getBoundingClientRect();
  pop.style.left = Math.max(8, Math.min(r.left, window.innerWidth - (pop.offsetWidth || 340) - 10)) + 'px';
  pop.style.top = (r.bottom + 6) + 'px';
  $('#txtTplClose').onclick = () => pop.remove();
  pop.querySelectorAll('.to-tpl-open').forEach(b => b.onclick = () => { txtOpenTemplate(b.dataset.id); pop.remove(); });
  pop.querySelectorAll('.to-tpl-rename').forEach(b => b.onclick = () => { txtRenameTemplate(b.dataset.id); pop.remove(); txtOpenTemplateModal(); });
  pop.querySelectorAll('.to-tpl-del').forEach(b => b.onclick = () => { txtDeleteTemplate(b.dataset.id); pop.remove(); txtOpenTemplateModal(); });
  const outside = (e) => { if (!pop.contains(e.target)) { pop.remove(); document.removeEventListener('click', outside, true); } };
  setTimeout(() => document.addEventListener('click', outside, true), 0);
}
function txtOpenTemplate(id) {
  const o = txtStore(); const t = (o.templates || []).find(x => x.id === id); if (!t) return;
  TXT.doc = TextoutCore.deserialize(JSON.stringify({ v: 1, blocks: t.blocks || [] }));
  o.name = t.name; o.current = TXT.doc.blocks; txtWriteStore(o);
  txtRenderEditor(); txtHistInit(); txtRefreshAll(); txtSyncName();
  toast('已打开：' + t.name);
}
function txtRenameTemplate(id) {
  const o = txtStore(); const t = (o.templates || []).find(x => x.id === id); if (!t) return;
  txtAskName('新名称：', t.name, (nn) => {
    const o2 = txtStore(); const t2 = (o2.templates || []).find(x => x.id === id); if (!t2) return;
    const oldName = t2.name;                       // 先存旧名再改,否则「当前模板名同步」比较的是新名(原实现的顺手bug)
    t2.name = nn; if (o2.name && o2.name === oldName) o2.name = nn;
    txtWriteStore(o2); txtSyncName();
    const pop = $('#txtTplPop'); if (pop) { pop.remove(); txtOpenTemplateModal(); }   // 模板列表若开着,重渲显示新名
  });
}
function txtDeleteTemplate(id) {
  const o = txtStore(); o.templates = (o.templates || []).filter(x => x.id !== id); txtWriteStore(o);
  toast('已删除模板');
}

/* ---------- 小工具 ---------- */
function txtRow(label, ctrl) { return '<div class="pd-row"><label>' + label + '</label>' + ctrl + '</div>'; }
function txtEsc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

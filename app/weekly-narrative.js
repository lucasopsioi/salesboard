'use strict';
/* ============================================================
   Salesboard — weekly-narrative.js
   周报 v3 的「叙述编辑器」：一段 contenteditable 文字 + 内嵌数据芯片。
   参照 textout-view 的编辑器骨架做的极简复用版 —— 周报每个章节挂一个小编辑区，
   不是整页一个大文档，所以抽成独立小组件：
     WeeklyNarrative.mount(host, {doc, palette, onChange}) → 实例
     WeeklyNarrative.refreshAll(root, ctx)   数据刷新后把所有芯片的显示值重算
   文档模型与 weekly-chips.resolveDoc 一致：{lines:[{runs:[{t:'text',s}|{t:'chip',cfg}]}]}
   芯片 cfg 镜像到 data-cfg 属性（复制/剪切走 DOM 也不丢配置，同 textout 的做法）。
   ============================================================ */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.WeeklyNarrative = api;
})(this, function () {
  const WC = (typeof window !== 'undefined' && window.WeeklyChips) ? window.WeeklyChips
    : (typeof require === 'function' ? require('./weekly-chips.js') : null);

  /* ---------- 芯片元素 ---------- */
  function makeChipEl(cfg) {
    const s = document.createElement('span');
    s.className = 'wk-chip';
    s.contentEditable = 'false';
    s._cfg = cfg || {};
    try { s.dataset.cfg = JSON.stringify(s._cfg); } catch (e) { }
    s.innerHTML = '<i class="wk-chip-v">…</i>';
    s.title = WC.chipLabel(s._cfg) + '（数据芯片，刷新自动更新；Backspace 可整体删除）';
    return s;
  }
  function setChipDisplay(el, str) {
    const v = el.querySelector('.wk-chip-v'); if (v) v.textContent = (str == null ? '—' : str);
    el.classList.toggle('nodata', str == null || str === '—');
  }

  /* ---------- 序列化：DOM → doc ---------- */
  function serialize(editor) {
    const lines = [{ runs: [] }];
    const push = r => lines[lines.length - 1].runs.push(r);
    const walk = node => {
      node.childNodes.forEach(ch => {
        if (ch.nodeType === 3) { if (ch.nodeValue) push({ t: 'text', s: ch.nodeValue }); return; }
        if (ch.nodeType !== 1) return;
        if (ch.classList && ch.classList.contains('wk-chip')) {
          let cfg = ch._cfg;
          if (!cfg) { try { cfg = JSON.parse(ch.dataset.cfg || '{}'); } catch (e) { cfg = {}; } }
          push({ t: 'chip', cfg });
          return;
        }
        if (ch.tagName === 'BR') { lines.push({ runs: [] }); return; }
        const isBlock = /^(DIV|P)$/i.test(ch.tagName);
        if (isBlock && lines[lines.length - 1].runs.length) lines.push({ runs: [] });
        walk(ch);
        if (isBlock && ch.nextSibling) lines.push({ runs: [] });
      });
    };
    walk(editor);
    // 去掉尾部空行
    while (lines.length > 1 && !lines[lines.length - 1].runs.length) lines.pop();
    return { lines };
  }

  /* ---------- 渲染：doc → DOM ---------- */
  function renderDoc(editor, doc) {
    editor.innerHTML = '';
    const lines = (doc && doc.lines) || [];
    lines.forEach((L, i) => {
      if (i > 0) editor.appendChild(document.createElement('br'));
      (L.runs || []).forEach(r => {
        if (r.t === 'chip') editor.appendChild(makeChipEl(JSON.parse(JSON.stringify(r.cfg || {}))));
        else editor.appendChild(document.createTextNode(r.s || ''));
      });
    });
  }

  /* ---------- 光标插入（借 textout 的骨架） ---------- */
  function currentRange(editor) {
    const sel = document.getSelection();
    if (sel && sel.rangeCount && editor.contains(sel.anchorNode)) return sel.getRangeAt(0);
    const r = document.createRange(); r.selectNodeContents(editor); r.collapse(false); return r;
  }
  function insertNode(editor, node) {
    editor.focus();
    const range = currentRange(editor);
    range.collapse(false);
    range.insertNode(node);
    const after = document.createRange(); after.setStartAfter(node); after.collapse(true);
    const sel = document.getSelection(); sel.removeAllRanges(); sel.addRange(after);
  }
  function placeCaretFromPoint(x, y) {
    let range = null;
    if (document.caretRangeFromPoint) range = document.caretRangeFromPoint(x, y);
    else if (document.caretPositionFromPoint) { const p = document.caretPositionFromPoint(x, y); if (p) { range = document.createRange(); range.setStart(p.offsetNode, p.offset); } }
    if (range) { const sel = document.getSelection(); sel.removeAllRanges(); sel.addRange(range); }
  }

  /* ---------- 组件 ----------
     opts = { doc, palette:[{cfg,lab?}], onChange(doc), compact? } */
  function mount(host, opts) {
    const o = opts || {};
    host.classList.add('wk-nared');
    host.innerHTML = '';
    // 料架（章节相关的芯片一排小按钮：点击=插入光标处；可拖进句子）
    const shelf = document.createElement('div');
    shelf.className = 'wk-shelf';
    const editor = document.createElement('div');
    editor.className = 'wk-editor';
    editor.contentEditable = 'true';
    editor.spellcheck = false;
    (o.palette || []).forEach(p => {
      const b = document.createElement('button');
      b.className = 'wk-shelf-chip';
      b.type = 'button';
      b.textContent = p.lab || WC.chipLabel(p.cfg);
      b.title = '点击插入到光标处，也可拖进句子';
      b.draggable = true;
      b.addEventListener('click', () => { insertNode(editor, makeChipEl(JSON.parse(JSON.stringify(p.cfg)))); fire(); });
      b.addEventListener('dragstart', e => { if (e.dataTransfer) { e.dataTransfer.setData('text/wk-chip', JSON.stringify(p.cfg)); e.dataTransfer.effectAllowed = 'copy'; } });
      shelf.appendChild(b);
    });
    editor.addEventListener('dragover', e => { if (e.dataTransfer && [...e.dataTransfer.types].includes('text/wk-chip')) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } });
    editor.addEventListener('drop', e => {
      const raw = e.dataTransfer && e.dataTransfer.getData('text/wk-chip');
      if (!raw) return;
      e.preventDefault();
      placeCaretFromPoint(e.clientX, e.clientY);
      try { insertNode(editor, makeChipEl(JSON.parse(raw))); fire(); } catch (err) { }
    });
    // 粘贴一律按纯文本（防止把 Word/网页的花样式带进来）
    editor.addEventListener('paste', e => {
      e.preventDefault();
      const t = (e.clipboardData || window.clipboardData).getData('text');
      insertNode(editor, document.createTextNode(t));
      fire();
    });
    let timer = null;
    const fire = () => { clearTimeout(timer); timer = setTimeout(() => { if (o.onChange) o.onChange(serialize(editor)); }, 400); };
    editor.addEventListener('input', fire);
    host.appendChild(shelf);
    host.appendChild(editor);
    renderDoc(editor, o.doc);
    return {
      host, editor,
      getDoc: () => serialize(editor),
      setDoc: d => renderDoc(editor, d),
    };
  }

  /* 数据刷新后：root 范围内所有芯片重算显示值 */
  function refreshAll(root, ctx) {
    (root || document).querySelectorAll('.wk-chip').forEach(el => {
      let cfg = el._cfg;
      if (!cfg) { try { cfg = JSON.parse(el.dataset.cfg || '{}'); } catch (e) { cfg = {}; } }
      setChipDisplay(el, WC.resolveChip(cfg, ctx));
    });
  }

  const CSS = [
    '.wk-nared{border:1px solid var(--c-line);border-radius:8px;background:var(--c-bg-elev);margin:4px 0 6px}',
    '.wk-shelf{display:flex;flex-wrap:wrap;gap:4px;padding:5px 8px;border-bottom:1px dashed var(--c-line)}',
    '.wk-shelf-chip{font-size:10.5px;padding:1px 8px;border:1px solid var(--c-line);border-radius:10px;background:var(--c-bg);color:var(--c-ink-2);cursor:grab}',
    '.wk-shelf-chip:hover{border-color:var(--c-brand);color:var(--c-brand)}',
    '.wk-editor{min-height:34px;padding:7px 10px;font-size:12.5px;line-height:1.8;color:var(--c-ink-1);outline:none;font-family:"Microsoft YaHei",微软雅黑,sans-serif}',
    '.wk-chip{display:inline-block;padding:0 5px;margin:0 1px;border-radius:5px;background:rgba(199,0,11,.08);border:1px solid rgba(199,0,11,.25);color:var(--c-brand);font-weight:600;white-space:nowrap;cursor:default}',
    '.wk-chip .wk-chip-v{font-style:normal}',
    '.wk-chip.nodata{background:var(--c-bg);border-color:var(--c-line);color:var(--c-ink-3);font-weight:400}',
  ].join('\n');

  return { mount, refreshAll, makeChipEl, serialize, renderDoc, CSS };
});

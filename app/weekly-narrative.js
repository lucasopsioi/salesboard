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

  /* ---------- 芯片元素（点击→配置弹窗：选字段/范围/参数，用户 2026-08-21 要求） ---------- */
  function makeChipEl(cfg) {
    const s = document.createElement('span');
    s.className = 'wk-chip';
    s.contentEditable = 'false';
    s._cfg = cfg || {};
    try { s.dataset.cfg = JSON.stringify(s._cfg); } catch (e) { }
    s.innerHTML = '<i class="wk-chip-v">…</i>';
    s.title = WC.chipLabel(s._cfg) + '（点击改字段/范围/参数；刷新自动更新；Backspace 整体删除）';
    s.addEventListener('click', function (e) { e.stopPropagation(); openChipConfig(s); });
    return s;
  }

  /* 配置弹窗：字段下拉 + 范围下拉(mount 时 opts.scopeOpts 提供) + N/X + 带数值开关。
     保存后立刻用 opts.getCtx() 重算显示值，句子当场变。 */
  const CONFIGURABLE = ['topRise', 'topFall', 'streakUp', 'streakDown', 'dosOver', 'flowDosOver',
    'soYoy', 'siYoy', 'wow', 'weekSo', 'cumSo', 'cumSi', 'dos', 'flowDos', 'inv', 'week'];
  function openChipConfig(el) {
    const host = el.closest('.wk-nared');
    if (!host || !host._opts) return;
    const opts = host._opts;
    document.querySelectorAll('.wk-chip-cfg').forEach(function (x) { x.remove(); });
    const cfg = el._cfg || {};
    const pop = document.createElement('div');
    pop.className = 'wk-chip-cfg';
    const r = el.getBoundingClientRect();
    pop.style.cssText = 'position:fixed;left:' + Math.max(8, Math.min(r.left, window.innerWidth - 330)) + 'px;top:' + (r.bottom + 6) + 'px;z-index:999;'
      + 'background:var(--c-bg-elev);border:1px solid var(--c-line);border-radius:10px;box-shadow:0 12px 34px rgba(0,0,0,.18);padding:10px 12px;width:315px;font-size:12px';
    const fieldOpts = CONFIGURABLE.map(function (id) {
      return '<option value="' + id + '"' + (cfg.id === id ? ' selected' : '') + '>' + WC.chipLabel({ id: id, n: cfg.n || 4, x: cfg.x || 120 }) + '</option>';
    }).join('');
    const scopeOpts = (opts.scopeOpts || []).map(function (o, i) {
      const cur = cfg.scope || {};
      const sel = (cur.level === o.level && (o.level !== 'country' || cur.value === o.value)) ? ' selected' : '';
      return '<option value="' + i + '"' + sel + '>' + o.label + '</option>';
    }).join('');
    pop.innerHTML =
      '<div style="display:flex;flex-direction:column;gap:7px">'
      + '<label>字段 <select data-f style="width:100%">' + fieldOpts + '</select></label>'
      + (scopeOpts ? '<label>范围 <select data-s style="width:100%">' + scopeOpts + '</select></label>' : '')
      + '<div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">'
      + '  <label data-nwrap>连续N周 <input data-n type="number" min="2" max="8" value="' + (cfg.n || 4) + '" style="width:52px"></label>'
      + '  <label data-xwrap>超X天 <input data-x type="number" min="1" max="999" value="' + (cfg.x || 120) + '" style="width:60px"></label>'
      + '  <label><input data-v type="checkbox"' + (cfg.showVal === false ? '' : ' checked') + '> 带数值</label>'
      + '  <label data-nbwrap>名称用 <select data-nb>'
      + '<option value=""' + (!cfg.nameBy ? ' selected' : '') + '>自动(产品显示系列)</option>'
      + '<option value="series"' + (cfg.nameBy === 'series' ? ' selected' : '') + '>系列名</option>'
      + '<option value="key"' + (cfg.nameBy === 'key' ? ' selected' : '') + '>原名(全名)</option>'
      + '</select></label>'
      + '</div>'
      + '<div style="display:flex;gap:8px;justify-content:flex-end">'
      + '  <button class="btn" data-del style="color:var(--c-brand)">删除芯片</button>'
      + '  <button class="btn" data-cancel>取消</button>'
      + '  <button class="btn primary" data-ok>确定</button>'
      + '</div></div>';
    document.body.appendChild(pop);
    const syncVis = function () {
      const f = pop.querySelector('[data-f]').value;
      pop.querySelector('[data-nwrap]').style.display = /streak/.test(f) ? '' : 'none';
      pop.querySelector('[data-xwrap]').style.display = /dosOver|flowDosOver/i.test(f) ? '' : 'none';
      pop.querySelector('[data-nbwrap]').style.display = /topRise|topFall|streak|dosOver|flowDosOver/i.test(f) ? '' : 'none';
    };
    pop.querySelector('[data-f]').onchange = syncVis; syncVis();
    const outside = function (e) { if (!pop.contains(e.target)) close(); };
    const close = function () { pop.remove(); document.removeEventListener('mousedown', outside, true); };
    document.addEventListener('mousedown', outside, true);
    pop.querySelector('[data-cancel]').onclick = close;
    pop.querySelector('[data-del]').onclick = function () {
      close(); el.remove();
      if (opts.onChange) opts.onChange(serialize(host.querySelector('.wk-editor')));
    };
    pop.querySelector('[data-ok]').onclick = function () {
      const f = pop.querySelector('[data-f]').value;
      const nc = { id: f };
      if (/streak/.test(f)) nc.n = Math.max(2, Math.min(8, +pop.querySelector('[data-n]').value || 4));
      if (/dosOver|flowDosOver/i.test(f)) nc.x = Math.max(1, +pop.querySelector('[data-x]').value || 120);
      if (!pop.querySelector('[data-v]').checked) nc.showVal = false;
      const nbSel = pop.querySelector('[data-nb]');
      if (nbSel && nbSel.value) nc.nameBy = nbSel.value;
      const sSel = pop.querySelector('[data-s]');
      if (sSel && f !== 'week') {
        const o = (opts.scopeOpts || [])[+sSel.value];
        if (o) nc.scope = { level: o.level, value: o.value };
      }
      el._cfg = nc;
      try { el.dataset.cfg = JSON.stringify(nc); } catch (e2) { }
      el.title = WC.chipLabel(nc) + '（点击改字段/范围/参数）';
      if (opts.getCtx) setChipDisplay(el, WC.resolveChip(nc, opts.getCtx()));
      if (opts.onChange) opts.onChange(serialize(host.querySelector('.wk-editor')));
      close();
    };
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
    host._opts = o;                     // 芯片配置弹窗要用(scopeOpts/getCtx/onChange)
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

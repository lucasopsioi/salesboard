/* ============================================================
   Salesboard — ppt-preview.js
   导出预览：导出前先看一眼这张 PPT 长什么样。
   （2026-09-08 用户：「给我加个导出预览功能，预览的时候能看到导出之后的 PPT 长什么样子」）

   保真的关键：预览和真正的 pptxgenjs 导出**吃同一份 spec**
   （同一套 colW、同一个字号、同一批单元格），只是一个渲染成 HTML、一个渲染成 pptx。
   所以预览里不换行 = 导出后不换行；预览里换行了，用户当场就能看见，而不是导出后才发现。

   反过来的纪律：预览里**不许**加 white-space:nowrap。
   那样会把「这列太窄」这个事实藏起来，预览就成了骗人的。要让它像 PowerPoint 一样该折就折。
   ============================================================ */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.PptPreview = api;
})(this, function () {
  'use strict';

  const SLIDE_W_IN = 13.333, SLIDE_H_IN = 7.5;
  const esc = t => String(t == null ? '' : t).replace(/[&<>"']/g, m =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' }[m]));

  function cellOf(c) {
    if (c == null) return { text: '', options: {} };
    if (typeof c === 'object') return { text: c.text == null ? '' : String(c.text), options: c.options || {} };
    return { text: String(c), options: {} };
  }
  function colorOf(v, dflt) {
    const s = String(v == null ? '' : v).replace('#', '');
    return /^[0-9a-fA-F]{6}$/.test(s) ? ('#' + s) : (dflt || 'inherit');
  }

  /* 一张幻灯片 → HTML。spec：
       { title, titleColor, rows:[[cell…]], colW:[英寸…], fontSize:磅, rowH:英寸,
         x:英寸, y:英寸, squeezed:[列下标…], note }
     opt.scale = 每英寸多少像素（默认 72 → 960×540 的预览图）。 */
  function slideHtml(spec, opt) {
    spec = spec || {}; opt = opt || {};
    const S = opt.scale || 72;
    const rows = spec.rows || [];
    const colW = spec.colW || [];
    const fs = spec.fontSize || 9;
    const x = spec.x == null ? 0.3 : spec.x;
    const y = spec.y == null ? 0.85 : spec.y;
    const pxFs = fs * S / 72;                       // 磅 → 像素（1 磅 = 1/72 英寸）
    const squeezed = {}; (spec.squeezed || []).forEach(i => { squeezed[i] = 1; });

    let h = '<div class="pv-slide" style="width:' + (SLIDE_W_IN * S) + 'px;height:' + (SLIDE_H_IN * S) + 'px">';
    if (spec.title) {
      h += '<div class="pv-title" style="left:' + (0.4 * S) + 'px;top:' + (0.2 * S) + 'px;'
        + 'font-size:' + (18 * S / 72) + 'px;color:' + colorOf(spec.titleColor, '#C7000B') + '">' + esc(spec.title) + '</div>';
    }
    h += '<table class="pv-tbl" style="left:' + (x * S) + 'px;top:' + (y * S) + 'px;font-size:' + pxFs + 'px"><colgroup>'
      + colW.map(w => '<col style="width:' + (w * S) + 'px">').join('') + '</colgroup><tbody>';
    rows.forEach((r, ri) => {
      h += '<tr' + (spec.rowH ? ' style="height:' + (spec.rowH * S) + 'px"' : '') + '>';
      (r || []).forEach((c0, ci) => {
        const c = cellOf(c0), o = c.options || {};
        const st = [
          'text-align:' + (o.align || 'right'),
          'color:' + colorOf(o.color, '#333'),
          o.bold ? 'font-weight:700' : 'font-weight:400',
          o.fill && o.fill.color ? ('background:' + colorOf(o.fill.color, 'transparent')) : '',
        ].filter(Boolean).join(';');
        h += '<td class="' + (squeezed[ci] ? 'pv-sq' : '') + '" style="' + st + '">' + esc(c.text) + '</td>';
      });
      h += '</tr>';
    });
    h += '</tbody></table>';
    if (spec.note) h += '<div class="pv-note" style="left:' + (0.4 * S) + 'px;bottom:' + (0.2 * S) + 'px;font-size:' + (9 * S / 72) + 'px">' + esc(spec.note) + '</div>';
    h += '</div>';
    return h;
  }

  /* 被挤到会换行的列，要在预览上方明说是哪几列 —— 用户看得见才谈得上「预览」。 */
  function squeezeWarning(specs, headerRow) {
    const bad = {};
    (specs || []).forEach(sp => (sp.squeezed || []).forEach(i => {
      const hr = headerRow || (sp.rows && sp.rows[0]) || [];
      bad[cellOf(hr[i]).text || ('第' + (i + 1) + '列')] = 1;
    }));
    const names = Object.keys(bad);
    if (!names.length) return '';
    return '这几列放不下、会换行：' + names.join('、') + '。可以减少周列数、或换更粗的拆分维度。';
  }

  const CSS = [
    '.pv-mask{position:fixed;inset:0;z-index:2000;background:rgba(16,18,20,.55);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;padding:20px}',
    '.pv-box{background:var(--c-bg-elev,#fff);border-radius:14px;box-shadow:0 24px 70px rgba(0,0,0,.35);max-width:96vw;max-height:94vh;display:flex;flex-direction:column;overflow:hidden}',
    '.pv-head{display:flex;align-items:center;gap:10px;padding:10px 14px;border-bottom:1px solid var(--c-line,#E6E8EB)}',
    '.pv-head h3{margin:0;font-size:14px;font-weight:600;color:var(--c-ink-1,#1a1a1a)}',
    '.pv-head .pv-sub{font-size:11px;color:var(--c-ink-3,#8a9099)}',
    '.pv-head .pv-sp{flex:1}',
    '.pv-warn{margin:8px 14px 0;padding:6px 10px;border-radius:8px;background:var(--c-warn-soft,#FFF6DA);color:var(--c-warn-text,#8A6D00);font-size:12px}',
    '.pv-body{overflow:auto;padding:14px;background:var(--c-bg-sunken,#F0F2F4)}',
    '.pv-slide{position:relative;background:#fff;box-shadow:0 4px 18px rgba(0,0,0,.18);overflow:hidden;margin:0 auto;font-family:"Microsoft YaHei","微软雅黑",sans-serif}',
    '.pv-title{position:absolute;font-weight:700;white-space:nowrap}',
    '.pv-note{position:absolute;color:#8a9099}',
    '.pv-tbl{position:absolute;border-collapse:collapse;table-layout:fixed}',
    /* 预览必须像 PowerPoint 一样该折就折——加 nowrap 会把「这列太窄」藏起来，预览就成了骗人的 */
    '.pv-tbl td{border:.5px solid #E6E8EB;padding:1px 3px;vertical-align:middle;overflow-wrap:break-word;line-height:1.25}',
    '.pv-tbl td.pv-sq{outline:1px solid rgba(217,45,32,.5);outline-offset:-1px}',
    '.pv-foot{display:flex;align-items:center;gap:8px;padding:10px 14px;border-top:1px solid var(--c-line,#E6E8EB)}',
    '.pv-foot .pv-sp{flex:1}',
    '.pv-pager{display:flex;align-items:center;gap:6px;font-size:12px;color:var(--c-ink-2,#5a5f66)}',
  ].join('\n');

  function ensureCss() {
    if (typeof document === 'undefined') return;
    if (document.getElementById('pv-css')) return;
    const st = document.createElement('style'); st.id = 'pv-css'; st.textContent = CSS;
    document.head.appendChild(st);
  }

  /* 打开预览。opts:
       { title, filename, slides:[spec…], onExport:()=>Promise, note }
     导出按钮点下去才真的写文件；取消就什么都不做。 */
  function open(opts) {
    opts = opts || {};
    ensureCss();
    const slides = opts.slides || [];
    let idx = 0;
    const mask = document.createElement('div'); mask.className = 'pv-mask';
    const box = document.createElement('div'); box.className = 'pv-box';
    const warn = squeezeWarning(slides);
    // 预览缩放：按可用宽度自适应，最小 0.45 倍，免得 13 英寸的片在小屏上撑爆
    const scale = Math.max(40, Math.min(84, Math.floor((window.innerWidth - 120) / SLIDE_W_IN)));
    box.innerHTML =
      '<div class="pv-head"><h3>导出预览</h3><span class="pv-sub" id="pvSub"></span><span class="pv-sp"></span>'
      + '<button class="btn ghost" id="pvClose">关闭</button></div>'
      + (warn ? '<div class="pv-warn">⚠ ' + esc(warn) + '</div>' : '')
      + '<div class="pv-body" id="pvBody"></div>'
      + '<div class="pv-foot"><span class="pv-pager" id="pvPager"></span><span class="pv-sp"></span>'
      + '<button class="btn ghost" id="pvPrev">上一页</button><button class="btn ghost" id="pvNext">下一页</button>'
      + '<button class="btn primary" id="pvGo">导出 PPT</button></div>';
    mask.appendChild(box); document.body.appendChild(mask);

    const body = box.querySelector('#pvBody'), pager = box.querySelector('#pvPager');
    const sub = box.querySelector('#pvSub');
    if (sub) sub.textContent = (opts.filename ? opts.filename + ' · ' : '')
      + (slides[0] ? (slides[0].fontSize + 'pt · ' + (slides[0].colW || []).length + ' 列') : '');
    const paint = () => {
      body.innerHTML = slideHtml(slides[idx] || {}, { scale: scale });
      pager.textContent = slides.length > 1 ? ('第 ' + (idx + 1) + ' / ' + slides.length + ' 页') : '共 1 页';
      box.querySelector('#pvPrev').disabled = idx <= 0;
      box.querySelector('#pvNext').disabled = idx >= slides.length - 1;
    };
    const close = () => { try { document.removeEventListener('keydown', onKey); mask.remove(); } catch (e) {} };
    const onKey = e => {
      if (e.key === 'Escape') { close(); e.preventDefault(); }
      else if (e.key === 'ArrowRight' && idx < slides.length - 1) { idx++; paint(); }
      else if (e.key === 'ArrowLeft' && idx > 0) { idx--; paint(); }
    };
    box.querySelector('#pvClose').onclick = close;
    box.querySelector('#pvPrev').onclick = () => { if (idx > 0) { idx--; paint(); } };
    box.querySelector('#pvNext').onclick = () => { if (idx < slides.length - 1) { idx++; paint(); } };
    box.querySelector('#pvGo').onclick = async () => {
      const b = box.querySelector('#pvGo'); b.disabled = true; b.textContent = '导出中…';
      try { if (opts.onExport) await opts.onExport(); } finally { close(); }
    };
    mask.addEventListener('mousedown', e => { if (e.target === mask) close(); });
    document.addEventListener('keydown', onKey);
    paint();
    return { close: close };
  }

  return { slideHtml, squeezeWarning, open, esc, SLIDE_W_IN, SLIDE_H_IN, CSS };
});

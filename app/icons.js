'use strict';
/* ============================================================
   Salesboard · 图标库（阶段二）
   自绘线性图标，24×24 网格、统一 stroke 1.6、round 端点，替换全部 emoji 功能图标。

   为什么是 .js 不是 .svg：
     Electron 用 file:// 加载页面，Chromium 会拦截 <use href="icons.svg#id"> 这种
     外部 SVG sprite 引用（跨文档资源）。所以把 sprite 内联进 DOM，零 fetch、零依赖。

   用法：
     SbIcons.mount()                → 往 <body> 注入一次隐藏 sprite
     SbIcons.svg('refresh', 'g-ico')→ 返回 <svg class="g-ico"><use href="#gi-refresh"/></svg>
     [data-icon="refresh"] 元素由 ui-kit 自动填充
   ============================================================ */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.SbIcons = api;
})(this, function () {

  /* id → path/形状内容（不含 <svg> 外壳，viewBox 统一 0 0 24 24） */
  const P = {
    /* —— 导航（14 + AI） —— */
    psi:        '<path d="M3 3v18h18"/><path d="M7 15l4-5 3 3 5-7"/>',
    industry:   '<path d="M4 15v-3a8 8 0 0 1 16 0v3"/><rect x="2" y="15" width="5" height="6" rx="2"/><rect x="17" y="15" width="5" height="6" rx="2"/>',
    finance:    '<path d="M3 17l6-6 4 4 8-8"/><path d="M15 7h6v6"/>',
    country:    '<circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3a15 15 0 0 1 0 18a15 15 0 0 1 0-18z"/>',
    report:     '<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 8h8M8 12h8M8 16h5"/>',
    custom:     '<circle cx="7" cy="16" r="2.5"/><circle cx="15" cy="9" r="3.2"/><circle cx="18.5" cy="17" r="1.8"/>',
    designer:   '<path d="M12 3a9 9 0 1 0 0 18c1 0 1.7-.8 1.7-1.7 0-.5-.2-.9-.5-1.2-.3-.3-.5-.7-.5-1.1 0-.9.8-1.7 1.7-1.7H16a5 5 0 0 0 5-5c0-4-4-7.3-9-7.3z"/><circle cx="8" cy="11" r="1"/><circle cx="12" cy="8" r="1"/><circle cx="16" cy="11" r="1"/>',
    source:     '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M3 11h18"/>',
    pricing:    '<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 7h8"/><path d="M8 11h3M13 11h3M8 15h3M13 15h3"/>',
    pricinglib: '<rect x="3" y="4" width="18" height="5" rx="1.5"/><path d="M5 9v9a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9"/><path d="M10 13h4"/>',
    roadmap:    '<path d="M4 20l5-16"/><path d="M15 20l5-16"/><path d="M9.5 8h5M8.5 12h7M7.5 16h9"/>',
    pptoutput:  '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M12 16v4M8 20h8"/><path d="M7 12l3-3 2 2 4-4"/>',
    inventory:  '<path d="M3 8l9-5 9 5v8l-9 5-9-5z"/><path d="M3 8l9 5 9-5"/><path d="M12 13v8"/>',
    textout:    '<path d="M6 3h8l5 5v13a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z"/><path d="M14 3v5h5"/><path d="M9 13h6M9 17h4"/>',
    audio:      '<path d="M4 13a8 8 0 0 1 16 0"/><path d="M4 13v5a2 2 0 0 0 2 2h1v-7H6a2 2 0 0 0-2 2z"/><path d="M20 13v5a2 2 0 0 1-2 2h-1v-7h1a2 2 0 0 1 2 2z"/>',
    ai:         '<rect x="4" y="8" width="16" height="12" rx="3"/><path d="M12 8V4"/><circle cx="12" cy="3" r="1.2"/><path d="M9 13h.01M15 13h.01"/><path d="M9.5 16.5h5"/>',

    /* —— 功能 —— */
    refresh:    '<path d="M20 11a8 8 0 1 0-1.6 5.2"/><path d="M20 5v6h-6"/>',
    search:     '<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/>',
    filter:     '<path d="M3 5h18l-7 8v6l-4 2v-8z"/>',
    download:   '<path d="M12 3v12"/><path d="M7 11l5 5 5-5"/><path d="M4 20h16"/>',
    upload:     '<path d="M12 21V9"/><path d="M7 13l5-5 5 5"/><path d="M4 4h16"/>',
    settings:   '<circle cx="12" cy="12" r="3"/><path d="M19 12a7 7 0 0 0-.1-1.2l2-1.5-2-3.4-2.3 1a7 7 0 0 0-2-1.2L14.2 3H9.8l-.4 2.7a7 7 0 0 0-2 1.2l-2.3-1-2 3.4 2 1.5A7 7 0 0 0 5 12c0 .4 0 .8.1 1.2l-2 1.5 2 3.4 2.3-1a7 7 0 0 0 2 1.2l.4 2.7h4.4l.4-2.7a7 7 0 0 0 2-1.2l2.3 1 2-3.4-2-1.5c.1-.4.1-.8.1-1.2z"/>',
    sun:        '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
    moon:       '<path d="M20 14.5A8.5 8.5 0 1 1 9.5 4a7 7 0 0 0 10.5 10.5z"/>',
    monitor:    '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>',
    gauge:      '<path d="M4 18a8 8 0 1 1 16 0"/><path d="M12 18l4-5"/>',
    chevronDown:'<path d="M6 9l6 6 6-6"/>',
    chevronRight:'<path d="M9 6l6 6-6 6"/>',
    close:      '<path d="M6 6l12 12M18 6L6 18"/>',
    check:      '<path d="M4 12.5l5 5L20 6.5"/>',
    plus:       '<path d="M12 5v14M5 12h14"/>',
    eye:        '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/>',
    alert:      '<path d="M12 3l9.5 17H2.5z"/><path d="M12 9v5M12 17.5h.01"/>',
    info:       '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5h.01"/>',
    calendar:   '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>',
    layers:     '<path d="M12 3l9 5-9 5-9-5z"/><path d="M3 13l9 5 9-5"/>',
  };

  const NAMES = Object.keys(P);

  function spriteHtml() {
    return '<svg id="sb-icon-sprite" aria-hidden="true" focusable="false" '
      + 'style="position:absolute;width:0;height:0;overflow:hidden" xmlns="http://www.w3.org/2000/svg">'
      + NAMES.map(k => '<symbol id="gi-' + k + '" viewBox="0 0 24 24">' + P[k] + '</symbol>').join('')
      + '</svg>';
  }

  let mounted = false;
  function mount(doc) {
    const d = doc || (typeof document !== 'undefined' ? document : null);
    if (!d || mounted || d.getElementById('sb-icon-sprite')) { mounted = true; return; }
    const holder = d.createElement('div');
    holder.innerHTML = spriteHtml();
    d.body.insertBefore(holder.firstChild, d.body.firstChild);
    mounted = true;
  }

  /* 生成一个引用 sprite 的 <svg> 字符串。cls 默认 g-ico。 */
  function svg(name, cls) {
    if (!P[name]) return '';
    return '<svg class="' + (cls || 'g-ico') + '" aria-hidden="true" focusable="false"><use href="#gi-'
      + name + '" xlink:href="#gi-' + name + '"></use></svg>';
  }

  function has(name) { return !!P[name]; }

  return { mount, svg, has, names: NAMES, spriteHtml };
});

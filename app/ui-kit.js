'use strict';
/* ============================================================
   Salesboard · UI Kit 运行时（阶段二）
   只管视觉：主题、视觉质量等级、图标注入、玻璃高光跟随、Tooltip。
   **不含任何业务逻辑**，不读写业务数据，不改任何取数/计算。

   持久化：
     sb.ui.theme = 'light' | 'dark' | 'system'（默认 system）
     sb.ui.perf  = 'high' | 'balanced' | 'performance'（默认 balanced，规范九）
   ============================================================ */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.SbUI = api;
})(this, function () {

  const LS_THEME = 'sb.ui.theme', LS_PERF = 'sb.ui.perf';
  const THEMES = ['light', 'dark', 'system'];
  const PERFS = ['high', 'balanced', 'performance'];
  const hasDoc = () => typeof document !== 'undefined';

  function lsGet(k, def, allow) {
    try { const v = localStorage.getItem(k); return (v && allow.indexOf(v) >= 0) ? v : def; }
    catch (e) { return def; }
  }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }

  /* ---------- 主题 ---------- */
  let _theme = 'system';
  let _mq = null;
  function systemPrefersDark() {
    try { return !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches); }
    catch (e) { return false; }
  }
  function effectiveTheme() { return _theme === 'system' ? (systemPrefersDark() ? 'dark' : 'light') : _theme; }
  function applyTheme() {
    if (!hasDoc()) return;
    const eff = effectiveTheme();
    document.documentElement.setAttribute('data-theme', eff);
    // 主窗底色跟随主题，避免深色下 resize/启动时闪白（仅视觉；窗口 frame/尺寸一律不动）
    try {
      const bg = eff === 'dark' ? '#14171D' : '#F1F3F6';
      const bridge = window.sb || window.api;
      if (bridge && typeof bridge.uiBackground === 'function') bridge.uiBackground(bg);
    } catch (e) {}
    try { window.dispatchEvent(new CustomEvent('sb-theme-change', { detail: { theme: eff, mode: _theme } })); } catch (e) {}
  }
  function setTheme(mode) {
    if (THEMES.indexOf(mode) < 0) return;
    _theme = mode; lsSet(LS_THEME, mode); applyTheme(); syncControls();
  }
  function getTheme() { return _theme; }

  /* ---------- 视觉质量等级 ---------- */
  let _perf = 'balanced';
  function applyPerf() {
    if (!hasDoc()) return;
    document.documentElement.setAttribute('data-perf', _perf);
    if (_perf === 'performance') stopHighlight(); else startHighlight();
  }
  function setPerf(level) {
    if (PERFS.indexOf(level) < 0) return;
    _perf = level; lsSet(LS_PERF, level); applyPerf(); syncControls();
  }
  function getPerf() { return _perf; }

  /* ---------- 图标注入 ----------
     把 [data-icon="name"] 元素填成 sprite 引用。对旧的 <span class="ic">emoji</span>
     也生效——只要给它加了 data-icon，emoji 文本会被替换掉。 */
  function paintIcons(scope) {
    if (!hasDoc() || !window.SbIcons) return;
    window.SbIcons.mount();
    const host = scope || document;
    host.querySelectorAll('[data-icon]').forEach(el => {
      const n = el.getAttribute('data-icon');
      if (!n || el.getAttribute('data-icon-painted') === n) return;
      if (!window.SbIcons.has(n)) return;
      el.innerHTML = window.SbIcons.svg(n, el.getAttribute('data-icon-class') || 'g-ico');
      el.setAttribute('data-icon-painted', n);
    });
  }

  /* ---------- 玻璃高光跟随（规范七）----------
     仅对 .glass-hl 元素、仅当前 hover 的那个、rAF 节流、Performance 档关闭、
     大表格行不启用（不要给 tr/td 加 .glass-hl）。 */
  let _hlOn = false, _hlRaf = 0, _hlEl = null, _hlX = 0, _hlY = 0;
  function onMove(e) {
    const el = e.target && e.target.closest ? e.target.closest('.glass-hl') : null;
    if (!el) return;
    _hlEl = el; _hlX = e.clientX; _hlY = e.clientY;
    if (_hlRaf) return;
    _hlRaf = requestAnimationFrame(() => {
      _hlRaf = 0;
      if (!_hlEl) return;
      const r = _hlEl.getBoundingClientRect();
      if (!r.width || !r.height) return;
      _hlEl.style.setProperty('--mx', ((_hlX - r.left) / r.width * 100).toFixed(1) + '%');
      _hlEl.style.setProperty('--my', ((_hlY - r.top) / r.height * 100).toFixed(1) + '%');
    });
  }
  function startHighlight() {
    if (_hlOn || !hasDoc()) return;
    try { if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return; } catch (e) {}
    document.addEventListener('pointermove', onMove, { passive: true });
    _hlOn = true;
  }
  function stopHighlight() {
    if (!_hlOn || !hasDoc()) return;
    document.removeEventListener('pointermove', onMove);
    if (_hlRaf) { cancelAnimationFrame(_hlRaf); _hlRaf = 0; }
    _hlOn = false; _hlEl = null;
  }

  /* ---------- Tooltip（title 的玻璃替代，仅对 [data-tip] 生效）---------- */
  let _tipEl = null;
  function ensureTip() {
    if (_tipEl || !hasDoc()) return _tipEl;
    _tipEl = document.createElement('div');
    _tipEl.className = 'g-tooltip'; _tipEl.setAttribute('role', 'tooltip');
    document.body.appendChild(_tipEl);
    return _tipEl;
  }
  function bindTooltips() {
    if (!hasDoc()) return;
    document.addEventListener('pointerover', e => {
      const t = e.target && e.target.closest ? e.target.closest('[data-tip]') : null;
      if (!t) return;
      const el = ensureTip(); if (!el) return;
      el.textContent = t.getAttribute('data-tip') || '';
      const r = t.getBoundingClientRect();
      el.style.left = Math.max(8, Math.min(window.innerWidth - 268, r.left)) + 'px';
      el.style.top = (r.bottom + 8) + 'px';
      el.classList.add('show');
    }, { passive: true });
    document.addEventListener('pointerout', e => {
      const t = e.target && e.target.closest ? e.target.closest('[data-tip]') : null;
      if (t && _tipEl) _tipEl.classList.remove('show');
    }, { passive: true });
  }

  /* ---------- 侧栏底部的 主题 / 画质 控件 ---------- */
  function syncControls() {
    if (!hasDoc()) return;
    document.querySelectorAll('[data-theme-btn]').forEach(b =>
      b.classList.toggle('on', b.getAttribute('data-theme-btn') === _theme));
    document.querySelectorAll('[data-perf-btn]').forEach(b =>
      b.classList.toggle('on', b.getAttribute('data-perf-btn') === _perf));
  }
  function mountControls(hostSel) {
    if (!hasDoc()) return;
    const host = document.querySelector(hostSel || '.nav-foot'); if (!host) return;
    if (document.getElementById('sbUiCtl')) { syncControls(); return; }
    const box = document.createElement('div');
    box.id = 'sbUiCtl'; box.className = 'ui-ctl';
    box.innerHTML =
      '<div class="ui-ctl__row" role="group" aria-label="主题">'
      + '<button class="ui-ctl__b" data-theme-btn="light"  aria-label="浅色主题" data-tip="浅色"  data-icon="sun"></button>'
      + '<button class="ui-ctl__b" data-theme-btn="dark"   aria-label="深色主题" data-tip="深色"  data-icon="moon"></button>'
      + '<button class="ui-ctl__b" data-theme-btn="system" aria-label="跟随系统" data-tip="跟随系统" data-icon="monitor"></button>'
      + '</div>'
      + '<div class="ui-ctl__row" role="group" aria-label="视觉质量">'
      + '<button class="ui-ctl__b ui-ctl__b--txt" data-perf-btn="high"        aria-label="画质：高" data-tip="高画质：全玻璃+高光+背景缓动">高</button>'
      + '<button class="ui-ctl__b ui-ctl__b--txt" data-perf-btn="balanced"    aria-label="画质：均衡" data-tip="均衡(默认)：降模糊、关背景动画">均衡</button>'
      + '<button class="ui-ctl__b ui-ctl__b--txt" data-perf-btn="performance" aria-label="画质：性能" data-tip="性能优先：关玻璃与装饰动画">性能</button>'
      + '</div>';
    host.insertBefore(box, host.firstChild);
    box.querySelectorAll('[data-theme-btn]').forEach(b =>
      b.addEventListener('click', () => setTheme(b.getAttribute('data-theme-btn'))));
    box.querySelectorAll('[data-perf-btn]').forEach(b =>
      b.addEventListener('click', () => setPerf(b.getAttribute('data-perf-btn'))));
    paintIcons(box); syncControls();
  }

  /* ---------- 无障碍收口（规范十）----------
     只做「增加可达性」，不改任何既有点击行为：
     · 图标按钮补 aria-label（读屏能念出来）
     · 侧栏导航项本是 <div>，补 role=button + tabindex，并支持 Enter/Space 触发原生 click
     · 状态点不只靠颜色（CSS 里已给空心/实心区分） */
  function a11y() {
    if (!hasDoc()) return;
    document.querySelectorAll('[data-icon]').forEach(el => {
      const btn = el.closest('button, [role="button"]');
      if (!btn || btn.getAttribute('aria-label')) return;
      const txt = (btn.textContent || '').trim() || (btn.getAttribute('title') || '').trim() || (btn.getAttribute('data-tip') || '').trim();
      if (txt) btn.setAttribute('aria-label', txt);
    });
    document.querySelectorAll('.nav-item').forEach(it => {
      if (!it.getAttribute('role')) it.setAttribute('role', 'button');
      if (!it.hasAttribute('tabindex')) it.setAttribute('tabindex', '0');
      if (it.getAttribute('data-a11y-key') === '1') return;
      it.setAttribute('data-a11y-key', '1');
      it.addEventListener('keydown', ev => {
        if (ev.key === 'Enter' || ev.key === ' ' || ev.key === 'Spacebar') { ev.preventDefault(); it.click(); }
      });
    });
    // 导航项的选中态除高亮外补 aria-current，读屏能说"当前页"
    const syncCur = () => document.querySelectorAll('.nav-item').forEach(it =>
      it.classList.contains('active') ? it.setAttribute('aria-current', 'page') : it.removeAttribute('aria-current'));
    syncCur();
    document.addEventListener('click', () => setTimeout(syncCur, 0), true);
  }

  /* ---------- 启动 ---------- */
  function init() {
    if (!hasDoc()) return;
    _theme = lsGet(LS_THEME, 'system', THEMES);
    _perf = lsGet(LS_PERF, 'balanced', PERFS);
    applyTheme(); applyPerf();
    try {
      _mq = window.matchMedia('(prefers-color-scheme: dark)');
      const onCh = () => { if (_theme === 'system') applyTheme(); };
      if (_mq.addEventListener) _mq.addEventListener('change', onCh); else if (_mq.addListener) _mq.addListener(onCh);
    } catch (e) {}
    const boot = () => { paintIcons(); mountControls('.nav-foot'); bindTooltips(); a11y(); };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
  }

  return {
    init, a11y, setTheme, getTheme, effectiveTheme, setPerf, getPerf,
    paintIcons, mountControls, startHighlight, stopHighlight,
    THEMES, PERFS,
  };
});

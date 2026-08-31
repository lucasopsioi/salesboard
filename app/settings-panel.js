/* ============================================================
   Salesboard — 全局设置面板（2026-08-31 用户：给软件做一个设置面板）
   收拢散落各处的可配置项：AI 助手入口/执行过程显示、周报导出阈值与页宽、
   数据源入口、关于。存 localStorage sb.set.*（读取方都做了缺省，删配置即回默认）。
   ============================================================ */
'use strict';
(function () {
  const KEYS = {
    aiFlow: 'sb.set.aiFlow',        // 执行过程显示: detail(默认)/simple
    dosRed: 'sb.set.dosRed',        // 渠道DOS标红阈值(默认120)
    dosFlowRed: 'sb.set.dosFlowRed',// 全流程DOS标红阈值(默认200)
    v3w: 'sb.set.v3w',              // 周报页宽默认(默认1200)
  };
  const get = (k, d) => { try { const v = localStorage.getItem(k); return v == null ? d : v; } catch (e) { return d; } };
  const set = (k, v) => { try { localStorage.setItem(k, String(v)); } catch (e) {} };
  const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  // 数值读取（读取方共用）：越界/非数回默认
  function num(k, d, lo, hi) {
    const v = parseFloat(get(k, ''));
    return (isFinite(v) && v >= lo && v <= hi) ? v : d;
  }
  // 供其他模块读取的公共口
  window.AppSettings = {
    aiFlowDetail: () => get(KEYS.aiFlow, 'detail') !== 'simple',
    dosRed: () => num(KEYS.dosRed, 120, 10, 999),
    dosFlowRed: () => num(KEYS.dosFlowRed, 200, 10, 999),
    v3wDefault: () => num(KEYS.v3w, 1200, 900, 1600),
    open,
  };

  function aiSummary() {
    try {
      const raw = localStorage.getItem('minimax.ai.cfg');
      const o = raw ? JSON.parse(raw) : {};
      const p = o.provider || 'deepseek';
      const m = p === 'deepseek' ? ('DeepSeek ' + (o.dsModel || 'deepseek-chat'))
        : p === 'minimax' ? ('MiniMax ' + (o.model || ''))
        : p === 'anthropic' ? ('Claude ' + (o.anModel || ''))
        : p === 'openai' ? ('OpenAI ' + (o.oaModel || ''))
        : p === 'lmstudio' ? ('LM Studio ' + (o.lmModel || '')) : p === 'corplink' ? 'CorpLink CLI' : '本地模型';
      return m;
    } catch (e) { return '未配置'; }
  }

  function open() {
    let modal = document.getElementById('appSettingsModal');
    if (modal) modal.remove();
    modal = document.createElement('div');
    modal.id = 'appSettingsModal';
    modal.className = 'ai-modal';
    const ver = (window.__appVer && window.__appVer.version) ? ('v' + window.__appVer.version + (window.__appVer.builtAt ? (' · ' + window.__appVer.builtAt) : '')) : '开发版';
    modal.innerHTML =
      '<div class="ai-modal-box" style="max-width:560px">' +
        '<div class="ai-modal-h">软件设置<button class="ai-modal-x" id="asX">✕</button></div>' +
        '<div class="ai-modal-body">' +
          '<div class="as-sec">🤖 AI 助手</div>' +
          '<div class="as-row"><span>当前模型</span><b>' + esc(aiSummary()) + '</b><button class="ai-btn" id="asAiSet">AI 设置…</button></div>' +
          '<div class="as-row"><span>执行过程显示</span><select id="asAiFlow">' +
            '<option value="detail"' + (get(KEYS.aiFlow, 'detail') !== 'simple' ? ' selected' : '') + '>详细（每个专家与工具调用实况）</option>' +
            '<option value="simple"' + (get(KEYS.aiFlow, 'detail') === 'simple' ? ' selected' : '') + '>简洁（单行进度）</option>' +
          '</select></div>' +
          '<div class="as-sec">📧 周报导出</div>' +
          '<div class="as-row"><span>渠道 DOS 标红阈值（天）</span><input type="number" id="asDosRed" min="10" max="999" value="' + num(KEYS.dosRed, 120, 10, 999) + '"></div>' +
          '<div class="as-row"><span>全流程 DOS 标红阈值（天）</span><input type="number" id="asDosFlowRed" min="10" max="999" value="' + num(KEYS.dosFlowRed, 200, 10, 999) + '"></div>' +
          '<div class="as-row"><span>周报页宽默认（px）</span><input type="number" id="asV3w" min="900" max="1600" step="20" value="' + num(KEYS.v3w, 1200, 900, 1600) + '"></div>' +
          '<div class="as-note">阈值即刻生效于下一次导出/预览；页宽仍可在导出预览里临时调。</div>' +
          '<div class="as-sec">🗂 数据源</div>' +
          '<div class="as-row"><span>底表目录（PSI / 财经 / 全流程等）</span><button class="ai-btn" id="asSrc">打开数据源看板</button></div>' +
          '<div class="as-sec">ℹ 关于</div>' +
          '<div class="as-row"><span>版本</span><b>' + esc(ver) + '</b></div>' +
          '<div class="ai-set-foot"><span class="ai-set-note">设置仅存本机。</span><button class="ai-btn primary" id="asSave">保存</button></div>' +
        '</div>' +
      '</div>';
    document.body.appendChild(modal);
    const q = s => modal.querySelector(s);
    q('#asX').onclick = () => modal.remove();
    modal.onclick = e => { if (e.target === modal) modal.remove(); };
    q('#asAiSet').onclick = () => { modal.remove(); try { window.AIPanel && window.AIPanel.openSettings && window.AIPanel.openSettings(); } catch (e) {} };
    q('#asSrc').onclick = () => { modal.remove(); try { typeof switchView === 'function' && switchView('source'); } catch (e) {} };
    q('#asSave').onclick = () => {
      set(KEYS.aiFlow, q('#asAiFlow').value);
      const dv = parseFloat(q('#asDosRed').value); if (isFinite(dv)) set(KEYS.dosRed, Math.max(10, Math.min(999, dv)));
      const fv = parseFloat(q('#asDosFlowRed').value); if (isFinite(fv)) set(KEYS.dosFlowRed, Math.max(10, Math.min(999, fv)));
      const wv = parseFloat(q('#asV3w').value); if (isFinite(wv)) set(KEYS.v3w, Math.max(900, Math.min(1600, wv)));
      modal.remove();
      try { typeof toast === 'function' && toast('设置已保存', 'ok'); } catch (e) {}
    };
  }

  // 顶栏 ⚙ 按钮注入（等 DOM 就绪；btnRefresh 之后）
  function inject() {
    const bar = document.querySelector('.topbar');
    if (!bar || document.getElementById('btnAppSettings')) return;
    const b = document.createElement('button');
    b.className = 'btn ghost'; b.id = 'btnAppSettings'; b.title = '软件设置';
    b.textContent = '⚙ 设置';
    b.onclick = open;
    bar.appendChild(b);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', inject);
  else setTimeout(inject, 0);

  // 样式
  const css = document.createElement('style');
  css.textContent =
    '.as-sec{margin:14px 0 6px;font-weight:600;font-size:13px;color:var(--ink1,#222)}' +
    '.as-sec:first-child{margin-top:2px}' +
    '.as-row{display:flex;align-items:center;gap:10px;padding:5px 0;font-size:12px}' +
    '.as-row>span:first-child{flex:1;color:var(--ink2,#555)}' +
    '.as-row input[type=number]{width:90px;padding:4px 8px;border:1px solid var(--line,#ddd);border-radius:6px;background:var(--c-bg-elev,#fff);color:inherit}' +
    '.as-row select{padding:4px 8px;border:1px solid var(--line,#ddd);border-radius:6px;background:var(--c-bg-elev,#fff);color:inherit}' +
    '.as-note{font-size:11px;color:var(--ink3,#999);margin:2px 0 4px}';
  document.head.appendChild(css);
})();

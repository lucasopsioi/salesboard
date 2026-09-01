/* ============================================================
   Salesboard — Agent 对话看板（2026-08-31 用户需求，第 17 视图）
   多路会话并行 × 点选专家定向作答 × 模型快切 × 本地文档上传 × PPT/Excel 输出。
   编排复用 AIPanel.makeOrchDeps（护栏/门禁/实体检索全链同源）；
   会话仅内存，每会话独立 busy——多个 Agent 集群可同时跑。
   ============================================================ */
'use strict';
(function () {
  const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const AC = {
    built: false,
    sessions: [],          // {id,title,msgs:[{role,content,flow?}],busy,agents:Set,files:[{name,content}],flowLive:[]}
    cur: null,             // 当前会话 id
    seq: 1,
  };

  function agentsRoster() {
    try { return (window.AIOrch && window.AIOrch.AGENTS) || {}; } catch (e) { return {}; }
  }
  function cfg() { return window.AIPanel && window.AIPanel.loadCfg ? window.AIPanel.loadCfg() : {}; }

  // ---------- 会话管理 ----------
  function newSession() {
    const s = { id: 'S' + (AC.seq++), title: '对话 ' + (AC.seq - 1), msgs: [], busy: false, agents: new Set(), files: [], flowLive: [] };
    AC.sessions.unshift(s);
    AC.cur = s.id;
    renderAll();
    return s;
  }
  function curS() { return AC.sessions.find(x => x.id === AC.cur) || null; }

  // ---------- 模型快切 ----------
  function modelOptions() {
    const c = cfg();
    const opts = [
      { p: 'deepseek', m: 'deepseek-chat', label: 'DeepSeek Flash（快·推荐）', ok: !!c.dsKey },
      { p: 'deepseek', m: 'deepseek-v4-pro', label: 'DeepSeek Pro（最准·慢）', ok: !!c.dsKey },
      { p: 'minimax', m: c.model || 'MiniMax-M2.5', label: 'MiniMax ' + (c.model || 'M2.5'), ok: !!c.key },
      { p: 'anthropic', m: c.anModel || 'claude-sonnet-5', label: 'Claude ' + (c.anModel || 'sonnet-5'), ok: !!c.anKey },
      { p: 'openai', m: c.oaModel || 'gpt-5.2', label: 'OpenAI ' + (c.oaModel || 'gpt-5.2'), ok: !!c.oaKey },
      { p: 'lmstudio', m: c.lmModel || '', label: 'LM Studio 本机', ok: !!c.lmModel },
      { p: 'corplink', m: '', label: 'CorpLink CLI', ok: !!c.wlCmd },
    ];
    return opts;
  }
  function curModelKey() {
    const c = cfg();
    const m = c.provider === 'deepseek' ? (c.dsModel || 'deepseek-chat') : c.provider === 'minimax' ? c.model : c.provider === 'anthropic' ? c.anModel : c.provider === 'openai' ? c.oaModel : c.provider === 'lmstudio' ? c.lmModel : '';
    return c.provider + '|' + m;
  }
  function switchModel(key) {
    const [p, m] = key.split('|');
    const c = cfg();
    c.provider = p;
    if (p === 'deepseek') c.dsModel = m;
    else if (p === 'minimax' && m) c.model = m;
    else if (p === 'anthropic' && m) c.anModel = m;
    else if (p === 'openai' && m) c.oaModel = m;
    if (window.AIPanel && window.AIPanel.saveCfg) window.AIPanel.saveCfg(c);
    renderTopbar();
    try { typeof toast === 'function' && toast('已切换到 ' + (modelOptions().find(o => o.p + '|' + o.m === key) || {}).label, 'ok'); } catch (e) {}
  }

  // ---------- 上传文档 ----------
  async function uploadDoc() {
    const s = curS(); if (!s) return;
    try {
      const r = await window.sb.readLocalDoc();
      if (!r || r.canceled) return;
      if (r.error) { toastSafe('上传失败：' + r.error); return; }
      s.files.push({ name: r.name, content: r.content });
      s.msgs.push({ role: 'sys', content: '📎 已附加文档「' + r.name + '」（' + Math.round(r.content.length / 1000) + 'K 字符' + (r.truncated ? '，超长已截断' : '') + '）——本会话后续提问都能引用它。' });
      renderChat(); renderTopbar();
    } catch (e) { toastSafe('上传失败：' + String((e && e.message) || e)); }
  }
  function toastSafe(t) { try { typeof toast === 'function' ? toast(t, 'err') : alert(t); } catch (e) {} }

  // ---------- 发送（每会话独立并行） ----------
  async function send() {
    const s = curS(); if (!s) return;
    const ta = document.getElementById('acInput');
    const q = (ta.value || '').trim();
    if (!q) return;
    if (s.busy) { toastSafe('该会话正在运行，可新建会话并行提问'); return; }
    const c = cfg();
    const needKey = { deepseek: 'dsKey', minimax: 'key', anthropic: 'anKey', openai: 'oaKey' }[c.provider];
    if (needKey && !c[needKey]) { toastSafe('当前模型未配置 API Key——右上角切模型或去 AI 设置'); return; }
    ta.value = '';
    if (s.msgs.filter(m => m.role === 'user').length === 0) s.title = q.slice(0, 16) + (q.length > 16 ? '…' : '');
    s.msgs.push({ role: 'user', content: q });
    s.busy = true; s.flowLive = [];
    renderAll();

    // 文档注入：作为问题前缀（专家与综合器都可见；实体检索照常工作）
    let fullQ = q;
    if (s.files.length) {
      const docs = s.files.map(f => '【用户上传文档：' + f.name + '】\n' + f.content).join('\n\n');
      fullQ = docs.slice(0, 80000) + '\n\n【用户问题】' + q;
    }
    const force = s.agents.size ? [...s.agents] : null;
    const sid = s.id;
    const onProg = e => {
      try { window.AgentBoard && window.AgentBoard.feed(e); } catch (e2) {}
      const ss = AC.sessions.find(x => x.id === sid); if (!ss) return;
      const label = e.type === 'plan' ? ('🧭 路由：' + (e.tasks || []).join(' → '))
        : e.type === 'agentStart' ? ('🤖 ' + e.agent + ' 分析中…')
        : e.type === 'tool' ? ('　🔧 ' + e.tool)
        : e.type === 'toolDone' ? null
        : e.type === 'agentDone' ? ('🤖 ' + e.agent + ' ✓')
        : e.type === 'synth' ? '🧩 综合结论…' : null;
      if (label) { ss.flowLive.push(label); if (ss.flowLive.length > 40) ss.flowLive.shift(); }
      if (AC.cur === sid) renderChat();
    };
    try {
      const deps = window.AIPanel.makeOrchDeps(c, onProg);
      try { window.AgentBoard && window.AgentBoard.feed({ type: 'ask', q }); } catch (e) {}
      const out = await window.AIOrch.orchestrate(fullQ, null, deps, { mode: force && force.length > 1 ? 'deep' : 'fast', forceAgents: force });
      try { window.AgentBoard && window.AgentBoard.feed({ type: 'done' }); } catch (e) {}
      const ss = AC.sessions.find(x => x.id === sid); if (!ss) return;
      ss.msgs.push({ role: 'ai', content: out.answer || '(空回复)', flow: ss.flowLive.slice() });
    } catch (e) {
      const ss = AC.sessions.find(x => x.id === sid);
      if (ss) ss.msgs.push({ role: 'ai', content: '⚠ 出错了：' + String((e && e.message) || e) });
    } finally {
      const ss = AC.sessions.find(x => x.id === sid);
      if (ss) { ss.busy = false; ss.flowLive = []; }
      renderAll();
    }
  }

  // ---------- 渲染 ----------
  function md(t) {
    /* 2026-09-01 用户:表格是管道符原文——旧实现依赖不存在的 marked 恒回退纯文本。
       改用 AIPanel 内置真渲染器(表格/标题/列表/粗体/代码块)。 */
    try { if (window.AIPanel && window.AIPanel.md) return window.AIPanel.md(t); } catch (e) {}
    return '<div style="white-space:pre-wrap">' + esc(t) + '</div>';
  }
  function renderSessions() {
    const el = document.getElementById('acSessions'); if (!el) return;
    el.innerHTML = '<button class="btn" id="acNew" style="width:100%;margin-bottom:8px">＋ 新对话</button>' +
      AC.sessions.map(s =>
        '<div class="ac-sess' + (s.id === AC.cur ? ' active' : '') + '" data-sid="' + s.id + '">' +
          (s.busy ? '<span class="ac-spin"></span>' : '💬 ') + esc(s.title) +
          (s.files.length ? ' 📎' + s.files.length : '') +
        '</div>').join('');
    el.querySelector('#acNew').onclick = newSession;
    el.querySelectorAll('.ac-sess').forEach(n => { n.onclick = () => { AC.cur = n.getAttribute('data-sid'); renderAll(); }; });
  }
  function renderTopbar() {
    const el = document.getElementById('acTop'); if (!el) return;
    const s = curS();
    const A = agentsRoster();
    const opts = modelOptions();
    const mk = curModelKey();
    el.innerHTML =
      '<select id="acModel" title="模型快切">' +
        opts.map(o => '<option value="' + o.p + '|' + o.m + '"' + (o.p + '|' + o.m === mk ? ' selected' : '') + (o.ok ? '' : ' disabled') + '>' + esc(o.label) + (o.ok ? '' : '（未配置）') + '</option>').join('') +
      '</select>' +
      '<span class="ac-chips">' +
        '<span class="ac-chip' + (s && s.agents.size === 0 ? ' on' : '') + '" data-ag="__auto__">🧭 自动路由</span>' +
        Object.keys(A).map(k => '<span class="ac-chip' + (s && s.agents.has(k) ? ' on' : '') + '" data-ag="' + k + '" title="' + esc(A[k].name) + '">' + esc(A[k].name.replace(/专家|顾问/g, '')) + '</span>').join('') +
      '</span>' +
      '<span style="flex:1"></span>' +
      '<button class="btn ghost" id="acDoc" title="上传本地文档(txt/md/csv/json)">📎 文档</button>' +
      '<button class="btn ghost" id="acBoard" title="Agent 架构">🕸</button>';
    el.querySelector('#acModel').onchange = e => switchModel(e.target.value);
    el.querySelectorAll('.ac-chip').forEach(n => {
      n.onclick = () => {
        const s2 = curS(); if (!s2) return;
        const k = n.getAttribute('data-ag');
        if (k === '__auto__') s2.agents.clear();
        else { s2.agents.has(k) ? s2.agents.delete(k) : s2.agents.add(k); }
        renderTopbar();
      };
    });
    el.querySelector('#acDoc').onclick = uploadDoc;
    el.querySelector('#acBoard').onclick = () => { try { window.AgentBoard && window.AgentBoard.open(); } catch (e) {} };
  }
  function renderChat() {
    const el = document.getElementById('acMsgs'); if (!el) return;
    const s = curS();
    if (!s) { el.innerHTML = ''; return; }
    let h = s.msgs.map(m => {
      if (m.role === 'user') return '<div class="ac-b u">' + esc(m.content) + '</div>';
      if (m.role === 'sys') return '<div class="ac-b s">' + esc(m.content) + '</div>';
      const flow = (m.flow && m.flow.length) ? ('<details class="ac-flow"><summary>🛠 执行过程（' + m.flow.length + ' 步）</summary><div>' + m.flow.map(esc).join('<br>') + '</div></details>') : '';
      return '<div class="ac-b a">' + flow + md(m.content) + '</div>';
    }).join('');
    if (s.busy) {
      h += '<div class="ac-b a ac-live"><div class="ac-flowlive">' + (s.flowLive.length ? s.flowLive.map(esc).join('<br>') : '正在规划…') + '</div></div>';
    }
    el.innerHTML = h || '<div class="ac-empty">选好专家（或用自动路由）直接提问。<br>可 📎 上传文档、让我出 PPT / Excel、多开会话并行跑。</div>';
    el.scrollTop = el.scrollHeight;
  }
  function renderAll() { renderSessions(); renderTopbar(); renderChat(); }

  // ---------- 构建 ----------
  function build() {
    if (AC.built) return;
    AC.built = true;
    const root = document.getElementById('view-agentchat');
    root.innerHTML =
      '<div class="ac-wrap">' +
        '<div class="ac-left" id="acSessions"></div>' +
        '<div class="ac-main">' +
          '<div class="ac-top" id="acTop"></div>' +
          '<div class="ac-msgs" id="acMsgs"></div>' +
          '<div class="ac-input"><textarea id="acInput" rows="2" placeholder="问数据、要分析、让我出 PPT/Excel……Ctrl+Enter 发送"></textarea>' +
          '<button class="btn primary" id="acSend">发送</button></div>' +
        '</div>' +
      '</div>';
    document.getElementById('acSend').onclick = send;
    document.getElementById('acInput').addEventListener('keydown', e => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); send(); }
    });
    const css = document.createElement('style');
    css.textContent =
      '.ac-wrap{display:flex;height:100%;min-height:0}' +
      '.ac-left{width:220px;flex:none;border-right:1px solid var(--line);padding:12px;overflow-y:auto}' +
      '.ac-sess{padding:8px 10px;border-radius:8px;font-size:12px;cursor:pointer;margin-bottom:4px;border:1px solid transparent;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' +
      '.ac-sess:hover{background:var(--panel)}' +
      '.ac-sess.active{border-color:#C7000B55;background:var(--panel)}' +
      '.ac-spin{display:inline-block;width:10px;height:10px;border:2px solid #C7000B;border-top-color:transparent;border-radius:50%;animation:acspin 1s linear infinite;margin-right:5px;vertical-align:-1px}' +
      '@keyframes acspin{to{transform:rotate(360deg)}}' +
      '.ac-main{flex:1;display:flex;flex-direction:column;min-width:0}' +
      '.ac-top{display:flex;align-items:center;gap:8px;padding:10px 14px;border-bottom:1px solid var(--line);flex-wrap:wrap}' +
      '.ac-top select{padding:5px 8px;border:1px solid var(--line);border-radius:8px;background:var(--c-bg-elev);color:inherit;font-size:12px;max-width:230px}' +
      '.ac-chips{display:flex;gap:5px;flex-wrap:wrap}' +
      '.ac-chip{font-size:11px;padding:3px 9px;border:1px solid var(--line);border-radius:999px;cursor:pointer;user-select:none}' +
      '.ac-chip.on{border-color:#C7000B;color:#C7000B;background:#C7000B11}' +
      '.ac-msgs{flex:1;overflow-y:auto;padding:16px 18px;display:flex;flex-direction:column;gap:10px}' +
      '.ac-b{max-width:76%;padding:10px 13px;border-radius:12px;font-size:13px;line-height:1.65}' +
      '.ac-b.u{align-self:flex-end;background:#C7000B;color:#fff;white-space:pre-wrap}' +
      '.ac-b.a{align-self:flex-start;background:var(--panel);border:1px solid var(--line)}' +
      '.ac-b.s{align-self:center;background:none;border:1px dashed var(--line);color:var(--ink3);font-size:11px}' +
      '.ac-b.a table{border-collapse:collapse;margin:6px 0}.ac-b.a td,.ac-b.a th{border:1px solid var(--line);padding:3px 8px;font-size:12px}' +
      '.ac-flowlive{font:11px/1.8 Consolas,monospace;color:var(--ink3)}' +
      '.ac-flow summary{cursor:pointer;font-size:11px;color:var(--ink3)}' +
      '.ac-flow div{font:11px/1.7 Consolas,monospace;color:var(--ink3);margin-top:4px}' +
      '.ac-empty{margin:auto;text-align:center;color:var(--ink3);font-size:13px;line-height:2}' +
      '.ac-input{display:flex;gap:8px;padding:12px 14px;border-top:1px solid var(--line)}' +
      '.ac-input textarea{flex:1;resize:none;padding:9px 12px;border:1px solid var(--line);border-radius:10px;background:var(--c-bg-elev);color:inherit;font-size:13px;font-family:inherit}';
    document.head.appendChild(css);
    newSession();
  }

  window.renderAgentChat = function () { build(); renderAll(); };
})();

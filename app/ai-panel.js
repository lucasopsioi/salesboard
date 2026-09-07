/* ============================================================
   Salesboard — ai-panel.js
   MiniMax AI 问答浮动面板 + 每个看板动态注入 🤖 按钮 + 设置窗。
   零改动 13 个视图文件：🤖 按钮由本文件初始化时注入每个 section.view。
   依赖：window.AIData（ai-context.js，须先加载）、window.sb.aiChat（preload）。
   会话仅内存（不落盘）；配置存 localStorage['minimax.ai.cfg']（非 sb.* 前缀）。
   ============================================================ */
'use strict';
(function () {
  const CFG_KEY = 'minimax.ai.cfg';          // 故意不用 sb.* 前缀：不进存档，不外带 API Key
  const DEFAULT_BASE = 'https://api.minimax.chat/v1/text/chatcompletion_v2';
  // M2.5 为默认(评测 2026-08-28:30题 78.3% vs Text-01 58.3%,延迟低30%,工具成功率94%);旧模型保留可选
  const MODELS = ['MiniMax-M2.5', 'MiniMax-Text-01', 'MiniMax-M1'];
  /* DeepSeek 预设(评测 2026-08-31,同30题同判分):deepseek-chat(V4-Flash) 88.3%/红线0/p50 10.9s
     ——超 MiniMax-M2.5 的 80.0% 且最快最便宜;deepseek-v4-pro 93.1% 最准但 p50 68s(深度分析用)。 */
  const DS_BASE = 'https://api.deepseek.com/v1/chat/completions';
  const DS_MODELS = ['deepseek-chat', 'deepseek-v4-pro'];
  /* 视觉模型(2026-09-04 实测):DeepSeek 的 deepseek-chat/v4-pro 是纯文本——收下 image_url 但看不到图(HTTP200
     却答"图片未显示")。真能看图的是 deepseek-v4-flash-vision-exp(实测准确识别),但它是推理模型,
     max_tokens 给小了会被 reasoning 吃光返空 → 识图统一走它并给足 token。Claude/GPT 本身多模态则直接用。 */
  const DS_VISION = 'deepseek-v4-flash-vision-exp';
  // 挑一个「能看图」的端点：优先当前 provider 若本就多模态(Claude/GPT)，否则用 DeepSeek 视觉模型，再否则任何可用多模态 key
  function pickVisionEndpoint(cfg) {
    cfg = cfg || {};
    if (cfg.provider === 'anthropic' && cfg.anKey) return { key: cfg.anKey, baseUrl: AN_BASE, model: cfg.anModel || AN_MODELS[0], apiFormat: 'anthropic', label: 'Claude ' + (cfg.anModel || AN_MODELS[0]) };
    if (cfg.provider === 'openai' && cfg.oaKey) return { key: cfg.oaKey, baseUrl: OA_BASE, model: cfg.oaModel || OA_MODELS[0], label: 'OpenAI ' + (cfg.oaModel || OA_MODELS[0]) };
    if (cfg.dsKey) return { key: cfg.dsKey, baseUrl: DS_BASE, model: DS_VISION, label: 'DeepSeek 视觉(' + DS_VISION + ')' };
    if (cfg.anKey) return { key: cfg.anKey, baseUrl: AN_BASE, model: cfg.anModel || AN_MODELS[0], apiFormat: 'anthropic', label: 'Claude ' + (cfg.anModel || AN_MODELS[0]) };
    if (cfg.oaKey) return { key: cfg.oaKey, baseUrl: OA_BASE, model: cfg.oaModel || OA_MODELS[0], label: 'OpenAI ' + (cfg.oaModel || OA_MODELS[0]) };
    return null;   // 无任何多模态可用（如只配了 MiniMax/LM Studio/CorpLink 且无 DeepSeek key）
  }
  /* Claude/OpenAI(2026-08-31 用户点名):Claude=表格问答最强档(调研结论),走 anthropic 格式适配;
     OpenAI 走现成 OpenAI 兼容通道。模型名可下拉可手输(厂商迭代快,别写死)。 */
  const AN_BASE = 'https://api.anthropic.com/v1/messages';
  const AN_MODELS = ['claude-sonnet-5', 'claude-opus-5', 'claude-haiku-4-5-20251001'];
  const OA_BASE = 'https://api.openai.com/v1/chat/completions';
  const OA_MODELS = ['gpt-5.2', 'gpt-5.2-mini', 'gpt-4.1'];
  const LM_DEFAULT_BASE = 'http://127.0.0.1:1234/v1';   // LM Studio 本地服务器默认地址(0.4.x)
  const MAX_TOOL_ROUNDS = 5;                  // 工具循环上限

  // LM Studio(OpenAI 兼容)辅助:base(…/v1) + 端点拼接;推理模型(<think>)输出剥离
  const lmJoin = (base, ep) => String(base || LM_DEFAULT_BASE).replace(/\/+$/, '') + ep;
  const stripThink = s => String(s == null ? '' : s).replace(/<think>[\s\S]*?<\/think>/g, '').trim();

  /* ---------- CorpLink CLI 适配(Acme内网命令行通道) ----------
     CLI 只有「文本进/文本出」——把 system+对话+工具文本协议拼成一份 prompt 发进去;
     模型按回退协议回 {"tool":名,"args":{}} 时,这里伪装成原生 toolCalls 交还编排链,
     护栏/期间拦截/溯源门禁全部零改动生效。 */
  function cliBuildPrompt(p) {
    const parts = [];
    if (p.system) parts.push('【系统指令】\n' + p.system);
    if (p.tools && p.tools.length) {
      const lite = p.tools.map(t => ({ name: t.function.name, description: t.function.description, parameters: t.function.parameters }));
      parts.push('【可用数据工具】需要取数时,你的回复必须只包含一行 JSON(无其他任何文字):{"tool":"工具名","args":{…}}。拿到工具结果后我会再次调用你。工具清单:\n' + JSON.stringify(lite));
    }
    const roleTag = { system: '系统', user: '用户', assistant: '助手', tool: '工具结果' };
    (p.messages || []).forEach(m => {
      let c = m.content;
      if (m.role === 'assistant' && m.tool_calls) c = (c ? c + '\n' : '') + m.tool_calls.map(tc => JSON.stringify({ tool: tc.function.name, args: JSON.parse(tc.function.arguments || '{}') })).join('\n');
      parts.push('【' + (roleTag[m.role] || m.role) + '】\n' + String(c == null ? '' : c));
    });
    parts.push('【助手】');
    return parts.join('\n\n');
  }
  async function cliChat(cfg, p) {
    const resp = await api().aiChatCli({
      cmd: cfg.wlCmd, argsTmpl: cfg.wlArgs, inputMode: cfg.wlMode,
      prompt: cliBuildPrompt(p), timeoutMs: 240000,
    });
    if (!resp || resp.error) return { error: (resp && resp.error) || 'CLI 无响应' };
    const text = stripThink(resp.content || '');
    const AD = AIData();
    const call = AD && AD.parseToolCall ? AD.parseToolCall(text) : null;
    if (call && p.tools && p.tools.length) {
      return { content: '', toolCalls: [{ id: 'cli-' + Date.now(), function: { name: call.tool, arguments: JSON.stringify(call.args || {}) } }] };
    }
    return { content: text };
  }

  const AIData = () => (typeof window !== 'undefined' ? window.AIData : null);
  // dsKey 自动带入:开发机上评测已存 eval/deepseek.key,首次打开不必重复粘贴(掩码存本机,不显示)
  setTimeout(() => {
    try {
      const g = typeof window !== 'undefined' ? window.sb : null;
      if (!g || !g.aiReadKeyFile) return;
      const c = loadCfg();
      if (c.dsKey) return;
      g.aiReadKeyFile('deepseek.key').then(k => {
        if (k) { const c2 = loadCfg(); if (!c2.dsKey) { c2.dsKey = String(k).trim(); saveCfg(c2); } }
      }).catch(() => {});
    } catch (e) {}
  }, 800);
  const api = () => (typeof window !== 'undefined' ? window.sb : null);
  const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  /* ---------- 配置存取（本机 localStorage，非 sb.*） ---------- */
  function loadCfg() {
    try {
      const raw = localStorage.getItem(CFG_KEY);
      const o = raw ? JSON.parse(raw) : {};
      /* 一次性迁移(2026-08-31):评测定档 DeepSeek V4-Flash 为默认——曾配 MiniMax 的老配置
         切到 deepseek(MiniMax key/模型原样保留,设置窗随时切回);local/lmstudio 用户不动。 */
      if (!o.dsMigrated && o.provider !== 'local' && o.provider !== 'lmstudio') {
        o.provider = 'deepseek'; o.dsMigrated = true;
        try { localStorage.setItem(CFG_KEY, JSON.stringify(o)); } catch (e2) {}
      }
      return {
        key: o.key || '',
        baseUrl: o.baseUrl || DEFAULT_BASE,
        model: o.model || MODELS[0],
        provider: ['local', 'lmstudio', 'minimax', 'corplink', 'anthropic', 'openai'].includes(o.provider) ? o.provider : 'deepseek',
        dsKey: o.dsKey || '',
        dsModel: DS_MODELS.includes(o.dsModel) ? o.dsModel : DS_MODELS[0],
        dsMigrated: !!o.dsMigrated,
        wlCmd: o.wlCmd || '',
        wlArgs: o.wlArgs || '',
        wlMode: ['stdin', 'file', 'arg'].includes(o.wlMode) ? o.wlMode : 'stdin',
        anKey: o.anKey || '',
        anModel: o.anModel || AN_MODELS[0],
        oaKey: o.oaKey || '',
        oaModel: o.oaModel || OA_MODELS[0],
        modelPath: o.modelPath || '',
        lmBase: o.lmBase || LM_DEFAULT_BASE,
        lmModel: o.lmModel || '',
        lmModels: Array.isArray(o.lmModels) ? o.lmModels : [],   // 上次拉取到的模型列表(缓存,便于离线打开设置窗)
      };
    } catch (e) { return { key: '', baseUrl: DEFAULT_BASE, model: MODELS[0], provider: 'deepseek', dsKey: '', dsModel: DS_MODELS[0], dsMigrated: true, modelPath: '', lmBase: LM_DEFAULT_BASE, lmModel: '', lmModels: [] }; }
  }
  function saveCfg(cfg) { try { localStorage.setItem(CFG_KEY, JSON.stringify(cfg || {})); } catch (e) {} }

  /* ---------- 面板状态（内存） ---------- */
  const st = {
    open: false,
    boardId: null,          // null=全局模式
    messages: [],           // {role:'user'|'assistant', content}
    busy: false,
  };

  let root = null;          // 面板根 DOM
  let streamState = null;   // 本地流式：{ id, msg, el }（同一时刻仅一个，受主进程单请求锁保护）
  let streamHooked = false; // onAiStream 只订阅一次

  // 订阅主进程流事件（本地模型增量 token）。只挂一次；按 id 过滤到当前流。
  function hookStream() {
    const a = api();
    if (streamHooked || !a || !a.onAiStream) return;
    streamHooked = true;
    a.onAiStream((d) => {
      if (!streamState || !d || d.id !== streamState.id) return;
      if (d.delta != null) {
        streamState.msg.content += d.delta;
        if (!streamState.el) streamState.el = lastAssistantBubble();
        if (streamState.el) {
          streamState.el.className = 'ai-bubble a';
          streamState.el.innerHTML = md(streamState.msg.content) + '<span class="ai-cursor">▍</span>';
        }
        const box = root && root.querySelector('#aiMsgs');
        if (box) box.scrollTop = box.scrollHeight;
      }
      // done / error 由 aiChatLocal 的 promise 统一收尾（含权威 content）
    });
  }
  function lastAssistantBubble() {
    const box = root && root.querySelector('#aiMsgs');
    if (!box) return null;
    const nodes = box.querySelectorAll('.ai-bubble.a');
    return nodes.length ? nodes[nodes.length - 1] : null;
  }

  /* ---------- 极简 Markdown 渲染（粗体/代码块/行内码/表格/换行） ---------- */
  function md(text) {
    let s = esc(text);
    // 代码块 ```...```
    s = s.replace(/```([\s\S]*?)```/g, (m, code) => '<pre class="ai-code">' + code.replace(/^\n/, '') + '</pre>');
    // 表格：连续以 | 开头的行
    s = s.replace(/(?:^\|.*\|\s*$\n?)+/gm, (block) => renderTable(block));
    // 行内码 `x`
    s = s.replace(/`([^`\n]+)`/g, '<code class="ai-ic">$1</code>');
    // 粗体 **x**
    s = s.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
    // 标题 #/##/### → 加粗行(2026-09-01:模型爱用标题,原样管道符/井号很难看)
    s = s.replace(/^#{1,4}\s*(.+)$/gm, '<div style="font-weight:700;font-size:13px;margin:6px 0 2px">$1</div>');
    // 列表 - x / * x → 圆点缩进
    s = s.replace(/^\s*[-*]\s+(.+)$/gm, '<div style="padding-left:14px;text-indent:-10px">• $1</div>');
    // 分隔线
    s = s.replace(/^-{3,}$/gm, '<hr style="border:none;border-top:1px solid var(--line);margin:6px 0">');
    // 剩余换行（表格/代码块已消费其内部换行）
    s = s.replace(/\n/g, '<br>');
    return s;
  }
  function renderTable(block) {
    const lines = block.trim().split('\n').filter(l => l.trim());
    if (lines.length < 1) return block;
    const cells = l => l.replace(/^\||\|$/g, '').split('|').map(c => c.trim());
    const isSep = l => /^\s*\|?[\s:-]+\|[\s:|-]*$/.test(l);
    let head = null, bodyStart = 0;
    if (lines.length >= 2 && isSep(lines[1])) { head = cells(lines[0]); bodyStart = 2; }
    let html = '<table class="ai-tbl">';
    if (head) html += '<thead><tr>' + head.map(c => '<th>' + c + '</th>').join('') + '</tr></thead>';
    html += '<tbody>';
    for (let i = bodyStart; i < lines.length; i++) {
      if (isSep(lines[i])) continue;
      html += '<tr>' + cells(lines[i]).map(c => '<td>' + c + '</td>').join('') + '</tr>';
    }
    html += '</tbody></table>';
    return html;
  }

  /* ---------- 面板 DOM 构建（一次） ---------- */
  function ensureRoot() {
    if (root) return root;
    root = document.createElement('div');
    root.id = 'aiPanelRoot';
    root.className = 'ai-root hidden';
    root.innerHTML =
      '<div class="ai-mask" id="aiMask"></div>' +
      '<aside class="ai-panel" id="aiPanel">' +
        '<div class="ai-head">' +
          '<span class="ai-title" id="aiTitle">AI 问答</span>' +
          '<button class="ai-btn" id="aiAgentBoard" title="Agent 架构与实时流程" style="padding:2px 8px">🕸</button>' +
          '<div class="ai-head-btns">' +
            '<button class="ai-hbtn" id="aiInspect" title="查看上次发给模型的完整内容（system/上下文/工具/问题 + token 估算）">🔍</button>' +
            '<button class="ai-hbtn" id="aiSettings" title="设置">⚙</button>' +
            '<button class="ai-hbtn" id="aiClear" title="清空会话">🗑</button>' +
            '<button class="ai-hbtn" id="aiClose" title="关闭">✕</button>' +
          '</div>' +
        '</div>' +
        '<div class="ai-lmbar" id="aiLmBar" style="display:none;flex-shrink:0;padding:4px 14px;border-bottom:1px solid var(--line);font-size:11px;color:var(--ink3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis"></div>' +
        '<div class="ai-msgs" id="aiMsgs"></div>' +
        '<div class="ai-input">' +
          '<textarea id="aiText" rows="2" placeholder="问点什么…（Ctrl+Enter 发送）"></textarea>' +
          '<button class="ai-send" id="aiSend">发送</button>' +
        '</div>' +
      '</aside>';
    document.body.appendChild(root);

    root.querySelector('#aiMask').onclick = close;
    root.querySelector('#aiClose').onclick = close;
    root.querySelector('#aiClear').onclick = clearChat;
    root.querySelector('#aiSettings').onclick = openSettings;
    root.querySelector('#aiInspect').onclick = showInspect;
    root.querySelector('#aiSend').onclick = send;
    const ta = root.querySelector('#aiText');
    ta.addEventListener('keydown', e => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); send(); }
    });
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && st.open) close(); });
    return root;
  }

  // 执行流一行:plan/agent/tool/synth 各自图标;run=⏳ ok=✓ err=✗
  function fmtFlowStep(st) {
    const icon = st.k === 'plan' ? '🧭' : st.k === 'agent' ? '🤖' : st.k === 'synth' ? '🧩' : '🔧';
    const state = st.state === 'run' ? '<span class="ai-fs-run">⏳</span>' : st.state === 'err' ? '<span class="ai-fs-err">✗</span>' : '<span class="ai-fs-ok">✓</span>';
    const ms = st.ms != null ? ('<span class="ai-fs-ms">' + (st.ms >= 1000 ? (st.ms / 1000).toFixed(1) + 's' : st.ms + 'ms') + '</span>') : '';
    const ind = st.k === 'tool' ? 'style="padding-left:18px"' : '';
    return '<div class="ai-flow-row" ' + ind + '>' + icon + ' ' + esc(st.label) + ' ' + state + ms + '</div>';
  }
  function renderMessages() {
    const box = root.querySelector('#aiMsgs');
    if (!st.messages.length) {
      box.innerHTML = '<div class="ai-empty">向 AI 提问，回答基于当前看板数据。<br>点 ⚙ 选择提供方（MiniMax 在线 / LM Studio 本机服务器 / 内置本地模型）。</div>';
      return;
    }
    const bubble = (cls, html) => '<div class="ai-bubble ' + cls + '">' + html + '</div>';
    const streaming = st.messages.some(m => m.streaming);
    box.innerHTML = st.messages.map(m => {
      if (m.role === 'user') return bubble('u', esc(m.content));
      // 进度行：flow=执行流列表(逐行实况)+底行计时;计时器只改 #aiProgStage,不整块重渲
      if (m.progress) {
        const flowHtml = (m.flow && m.flow.length) ? ('<div class="ai-flow" id="aiFlowList">' + m.flow.map(fmtFlowStep).join('') + '</div>') : '';
        return '<div class="ai-bubble a ai-think" id="aiProgLine">' + flowHtml + '<div id="aiProgStage">' + esc(m.content) + '</div></div>';
      }
      if (m.flowDone && m.flowDone.length) {
        const secs = m.flowSecs ? ('·' + m.flowSecs + 's') : '';
        return bubble('a', '<details class="ai-flow-done"><summary>🛠 执行过程（' + m.flowDone.length + ' 步' + secs + '）</summary><div class="ai-flow">' + m.flowDone.map(fmtFlowStep).join('') + '</div></details>' + md(m.content));
      }
      if (m.streaming && !m.content) return bubble('a ai-think', '模型加载中…');   // 本地模型冷启动/首 token 前
      return bubble('a', md(m.content) + (m.streaming ? '<span class="ai-cursor">▍</span>' : ''));
    }).join('') + ((st.busy && !streaming) ? bubble('a ai-think', '思考中…') : '');
    box.scrollTop = box.scrollHeight;
  }

  /* ---------- 开/关 ---------- */
  function open(boardId) {
    ensureRoot();
    st.boardId = boardId || null;
    st.open = true;
    root.classList.remove('hidden');
    const label = st.boardId ? (AIData() ? AIData().labelOf(st.boardId) : st.boardId) : null;
    const cfgT = loadCfg();
    const modelTag = cfgT.provider === 'deepseek' ? ('DeepSeek ' + (cfgT.dsModel || '')) :
      cfgT.provider === 'minimax' ? ('MiniMax ' + (cfgT.model || '')) :
      cfgT.provider === 'anthropic' ? ('Claude ' + (cfgT.anModel || '')) :
      cfgT.provider === 'openai' ? ('OpenAI ' + (cfgT.oaModel || '')) :
      cfgT.provider === 'lmstudio' ? ('LM Studio ' + (cfgT.lmModel || '')) :
      cfgT.provider === 'corplink' ? 'CorpLink CLI' : '本地模型';
    const abBtn = root.querySelector('#aiAgentBoard');
    if (abBtn && !abBtn._bound) { abBtn._bound = 1; abBtn.onclick = () => { try { window.AgentBoard && window.AgentBoard.open(); } catch (e) {} }; }
    root.querySelector('#aiTitle').textContent = (label ? ('AI · ' + label) : 'AI 问答（全局）') + '　|　' + modelTag;
    renderMessages();
    warmup();     // 打开面板即预热本地模型，把冷加载时间从第一个问题里挪走
    startLmBar(); // 顶部状态条：已加载模型 + 内存占用（每 5s 刷新）
    setTimeout(() => { const t = root.querySelector('#aiText'); if (t) t.focus(); }, 30);
  }
  /* ---------- 透明化：把「上次到底发了什么给模型」原样摊开给用户看 ----------
     只留在内存（问答内容绝不落盘），关面板即失效。 */
  let lastReq = null;   // {at, model, system, messages, tools, tokens:{...}}
  function recordReq(o) { lastReq = o; }
  function estTok(s) {
    const OR = window.AIOrch;
    if (OR && OR.estimateTokens) return OR.estimateTokens(typeof s === 'string' ? s : JSON.stringify(s));
    return Math.ceil(String(typeof s === 'string' ? s : JSON.stringify(s)).length / 3);
  }
  function showInspect() {
    let m = document.getElementById('aiInspectModal'); if (m) m.remove();
    m = document.createElement('div'); m.id = 'aiInspectModal'; m.className = 'ai-modal';
    let body;
    if (!lastReq) {
      body = '<div class="ai-set-note">还没有发过请求。先问一句，再点这里就能看到「发给模型的原文」。</div>';
    } else {
      const t = lastReq.tokens || {};
      const sec = (title, txt) => '<div style="margin:10px 0 4px;font-weight:600;font-size:12px;color:var(--ink)">' + esc(title) + '</div>'
        + '<pre class="ai-code" style="max-height:220px;overflow:auto;white-space:pre-wrap">' + esc(txt || '(空)') + '</pre>';
      body = '<div class="ai-set-note">模型：<b>' + esc(lastReq.model || '?') + '</b>　时间：' + esc(lastReq.at || '') + '<br>'
        + '输入合计 <b>' + (t.total || 0) + ' tok</b>（system ' + (t.system || 0) + ' ＋ 上下文/历史 ' + (t.messages || 0) + ' ＋ 工具说明 ' + (t.tools || 0) + '）'
        + '<br>其中 system 每轮不变，LM Studio 可复用缓存；真正每轮新处理的约 ' + ((t.total || 0) - (t.system || 0)) + ' tok。</div>'
        + sec('system（专家口径卡，恒定）', lastReq.system)
        + sec('messages（当前筛选 / 数据概览 / 你的问题 / 工具返回）', (lastReq.messages || []).map(x => '[' + x.role + '] ' + x.content).join('\n\n──────────\n\n'))
        + sec('tools（工具说明书）', (lastReq.tools || []).map(x => x.function.name + '(' + Object.keys((x.function.parameters || {}).properties || {}).join(', ') + ')').join('\n') || '(本轮未带工具)');
    }
    m.innerHTML = '<div class="ai-modal-box" style="width:min(760px,94vw)">'
      + '<div class="ai-modal-h">发给模型的内容<button class="ai-modal-x" id="aiInspX">✕</button></div>'
      + '<div class="ai-modal-body">' + body + '</div></div>';
    document.body.appendChild(m);
    m.querySelector('#aiInspX').onclick = () => m.remove();
    m.onclick = e => { if (e.target === m) m.remove(); };
  }

  /* ---------- LM Studio 运行状态条：已加载模型 + 占用内存 ---------- */
  let lmTimer = null;
  async function refreshLmBar() {
    const bar = root && root.querySelector('#aiLmBar'); if (!bar) return;
    const cfg = loadCfg();
    if (cfg.provider !== 'lmstudio') { bar.style.display = 'none'; return; }
    bar.style.display = '';
    try {
      const s = await api().lmStatus(cfg.lmBase);
      if (!s || s.error) { bar.textContent = '本地模型状态：读取失败'; return; }
      const loaded = (s.models || []).filter(m => m.state === 'loaded');
      const mdl = loaded.length ? loaded.map(m => m.id + (m.ctx ? ('·ctx ' + m.ctx) : '')).join(' / ')
        : (cfg.lmModel || '未选模型') + ((s.models || []).length ? '（未加载，首问会先加载）' : '');
      const mem = s.memMB ? (s.memMB >= 1024 ? (s.memMB / 1024).toFixed(1) + ' GB' : s.memMB + ' MB') : '—';
      const top = (s.procs || [])[0];
      bar.textContent = '🧠 ' + mdl + '　·　内存占用 ' + mem + (top ? ('（' + top.name + ' ' + (top.memMB >= 1024 ? (top.memMB / 1024).toFixed(1) + 'GB' : top.memMB + 'MB') + '）') : '');
      bar.title = (s.procs || []).map(p => p.name + ' #' + p.pid + '：' + p.memMB + ' MB').join('\n') || '未发现 LM Studio 进程';
    } catch (e) { bar.textContent = '本地模型状态：' + String((e && e.message) || e); }
  }
  function startLmBar() { refreshLmBar(); clearInterval(lmTimer); lmTimer = setInterval(refreshLmBar, 5000); }
  function stopLmBar() { clearInterval(lmTimer); lmTimer = null; }

  /* 预热：打开面板就发一个 1 token 的请求把模型焐热。
     LM Studio 冷加载 30B 要 20~90 秒，不预热的话这段时间会算进你第一个问题的等待里。
     只做一次、失败静默、不影响任何交互。 */
  let warmed = false;
  function warmup() {
    if (warmed) return; warmed = true;
    try {
      const cfg = loadCfg();
      if (cfg.provider !== 'lmstudio' || !cfg.lmModel) return;
      api().aiChat({
        key: '', baseUrl: lmJoin(cfg.lmBase, '/chat/completions'), model: cfg.lmModel,
        messages: [{ role: 'user', content: 'hi' }], maxTokens: 1, temperature: 0, timeoutMs: 240000,
      }).catch(() => { });
    } catch (e) { }
  }

  function close() { if (!root) return; st.open = false; root.classList.add('hidden'); stopLmBar(); }
  function clearChat() { st.messages = []; renderMessages(); }

  /* ---------- 发送 + 工具循环 ---------- */
  async function send() {
    if (st.busy) return;
    const ta = root.querySelector('#aiText');
    const q = (ta.value || '').trim();
    if (!q) return;
    const cfg = loadCfg();
    if (cfg.provider === 'minimax' && !cfg.key) { openSettings(); toastSafe('请先在设置里填写 API Key', 'err'); return; }
    if (cfg.provider === 'deepseek' && !cfg.dsKey) { openSettings(); toastSafe('请先在设置里填写 DeepSeek API Key', 'err'); return; }
    if (cfg.provider === 'corplink' && !cfg.wlCmd) { openSettings(); toastSafe('请先在设置里配置 CorpLink CLI 命令', 'err'); return; }
    if (cfg.provider === 'anthropic' && !cfg.anKey) { openSettings(); toastSafe('请先在设置里填写 Anthropic API Key', 'err'); return; }
    if (cfg.provider === 'openai' && !cfg.oaKey) { openSettings(); toastSafe('请先在设置里填写 OpenAI API Key', 'err'); return; }
    if (cfg.provider === 'lmstudio' && !cfg.lmModel) {
      // 没选过模型 → 自动拉一次列表用第一个(零配置);拉不到才弹设置
      try {
        const r = await api().aiListModels(cfg.lmBase || LM_DEFAULT_BASE, '');
        if (r && Array.isArray(r.models) && r.models.length) { cfg.lmModel = r.models[0]; cfg.lmModels = r.models; saveCfg(cfg); }
      } catch (e) { }
      if (!cfg.lmModel) { openSettings(); toastSafe('连不上 LM Studio——请确认 LM Studio 的 Server 已启动(Developer → Start Server)', 'err'); return; }
    }
    ta.value = '';
    st.messages.push({ role: 'user', content: q });
    st.busy = true; renderMessages();

    try {
      if (cfg.provider === 'local') {
        await runChatLocal(cfg);            // 自行管理 assistant 流式气泡
      } else if (window.AIOrch && ['lmstudio', 'deepseek', 'minimax', 'corplink', 'anthropic', 'openai'].includes(cfg.provider)) {
        /* 编排链(专家口径卡+类别护栏+期间拦截+数字溯源门禁+半途重试)对全部 provider 生效。
           2026-08-31 前在线 API 走的是下面的简单循环——评测 88.3% 是编排链成绩,简单循环没有
           门禁护栏,等于用户拿不到评测出的质量。现统一走编排,简单循环只留 AIOrch 缺失兜底。 */
        const r = await runOrchestrated(cfg, q);
        st.messages.push({ role: 'assistant', content: (r && r.text) || r, flowDone: r && r.flow || null, flowSecs: r && r.secs || null });
      } else {
        const answer = await runChat(cfg, q);
        st.messages.push({ role: 'assistant', content: answer });
      }
    } catch (e) {
      st.messages.push({ role: 'assistant', content: '⚠ 出错了：' + String((e && e.message) || e) });
    } finally {
      st.busy = false; streamState = null; renderMessages();
    }
  }

  // 本地模型问答：口径提示词 + 数据快照作 system，禁用工具循环（1.5B 会编数），流式增量渲染。
  // 与看板模式同一数据路径（genericSnapshot），全局窗给跨看板汇总快照。
  async function runChatLocal(cfg) {
    hookStream();
    const AD = AIData();
    const snapshot = AD ? await AD.genericSnapshot(st.boardId) : '';
    const sysParts = [AD ? AD.CALIBER_PROMPT : ''];
    if (snapshot) sysParts.push('【当前看板数据快照】\n' + snapshot);
    const system = sysParts.filter(Boolean).join('\n\n');

    const id = 'loc-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7);
    const msg = { role: 'assistant', content: '', streaming: true };   // 流式占位气泡
    st.messages.push(msg);
    streamState = { id, msg, el: null };
    renderMessages();
    streamState.el = lastAssistantBubble();

    // 送主进程的历史：真实对话（不含本占位气泡），末条 user 即本轮提问
    const messages = st.messages.filter(m => !m.streaming).map(m => ({ role: m.role, content: m.content }));

    let resp = null;
    try {
      resp = await api().aiChatLocal({ id, modelPath: cfg.modelPath, system, messages, maxTokens: 800 });
    } catch (e) {
      resp = { error: String((e && e.message) || e) };
    }
    streamState = null;
    msg.streaming = false;
    if (resp && resp.error) { msg.content = '⚠ 出错了：' + resp.error; }
    else { msg.content = (resp && resp.content) || msg.content || '(空回复)'; }
    renderMessages();
    return msg.content;
  }

  /* ---------- LM Studio：多看板专家 Agent 编排 ----------
     看板模式 → 该看板的专家（带自己的口径卡）；全局模式 → 规则路由拆成多个专家串行跑再综合。
     全部智能内置在 ai-orchestrator.js，用户机零配置；进度实时显示，避免本地 30B 让人以为卡死。 */
  async function runOrchestrated(cfg, question) {
    try { window.AgentBoard && window.AgentBoard.feed({ type: 'ask', q: question }); } catch (e) {}
    const AD = AIData(), OR = window.AIOrch;
    const registry = AD ? AD.buildToolRegistry() : {};
    const t0 = Date.now();
    const prog = { role: 'assistant', content: '正在规划…', progress: true };
    st.messages.push(prog); renderMessages();
    // 计时器真的每秒跳（旧版只在有事件时才刷，模型生成那几十秒里秒数是死的）；
    // 只改进度行那一个节点的文本，不整块重渲，避免打断正在流式输出的气泡。
    let stage = '正在规划…';
    const paint = () => {
      const s = Math.round((Date.now() - t0) / 1000);
      prog.content = stage + '　（已用 ' + (s >= 60 ? (Math.floor(s / 60) + '分' + (s % 60) + '秒') : (s + 's')) + '）';
      const el = document.getElementById('aiProgLine');
      if (el) el.textContent = prog.content; else renderMessages();
    };
    const timer = setInterval(paint, 1000);
    const setProg = txt => { stage = txt; paint(); };

    const deps = {
      schemas: AD.TOOL_SCHEMAS,
      buildToolSpecs: names => (AD.buildToolSpecs ? AD.buildToolSpecs(names) : []),
      pickTools: (names, q, max) => (AD.pickTools ? AD.pickTools(names, q, max) : (names || []).slice(0, max || 3)),
      parseToolCall: AD.parseToolCall,
      boardLabel: b => (b ? AD.labelOf(b) : '全局（跨看板）'),
      filters: b => { try { const c = AD.boardContext && AD.boardContext(b); return c ? c.filters : null; } catch (e) { return null; } },
      snapshot: async b => { try { return await AD.genericSnapshot(b); } catch (e) { return ''; } },
      runTool: async (name, args) => AD.dispatchTool(registry, { tool: name, args }),
      optionsDirect: async (field) => AD.dispatchTool(registry, { tool: 'options', args: { field } }),
      provRetry: true,
      // 云端 API 才开并行（本地 LM Studio / CorpLink CLI 单通道，并发会排队冻住）
      parallel: ['deepseek', 'minimax', 'anthropic', 'openai'].indexOf(cfg.provider) >= 0,
      chat: async p => {
        if (cfg.provider === 'corplink') return cliChat(cfg, p);
        /* reasoning 模型(v4-pro/reasoner/思考版)的思考链与答案共用 max_tokens——
           预算不放大则思考吃光配额,content 恒空(工作电脑实锤:reasoning_content:"We" 即断)。 */
        const mdlName = cfg.provider === 'deepseek' ? (cfg.dsModel || '') : cfg.provider === 'minimax' ? (cfg.model || '') : cfg.provider === 'anthropic' ? (cfg.anModel || '') : cfg.provider === 'openai' ? (cfg.oaModel || '') : '';
        if (/pro|reasoner|thinking|r1|m3/i.test(mdlName) && (!p.maxTokens || p.maxTokens < 16000)) p = Object.assign({}, p, { maxTokens: 16000 });
        const endp = cfg.provider === 'deepseek' ? { key: cfg.dsKey, baseUrl: DS_BASE, model: cfg.dsModel || DS_MODELS[0], timeoutMs: 120000 }
          : cfg.provider === 'minimax' ? { key: cfg.key, baseUrl: cfg.baseUrl, model: cfg.model, timeoutMs: 120000 }
          : cfg.provider === 'anthropic' ? { key: cfg.anKey, baseUrl: AN_BASE, model: cfg.anModel || AN_MODELS[0], apiFormat: 'anthropic', timeoutMs: 120000 }
          : cfg.provider === 'openai' ? { key: cfg.oaKey, baseUrl: OA_BASE, model: cfg.oaModel || OA_MODELS[0], timeoutMs: 120000 }
          : { key: '', baseUrl: lmJoin(cfg.lmBase, '/chat/completions'), model: cfg.lmModel, timeoutMs: OR.BUDGET.timeoutMs };
        const payload = Object.assign({}, endp, {
          messages: p.messages, maxTokens: p.maxTokens, temperature: 0,
        });
        if (p.tools && p.tools.length) payload.tools = p.tools;
        // 记录本轮原文供「🔍 查看发给模型的内容」（只在内存，不落盘）
        const sysTok = estTok(p.system || ''), msgTok = estTok(p.messages || []), toolTok = estTok(p.tools || []);
        recordReq({
          at: new Date().toLocaleTimeString('zh-CN'), model: cfg.lmModel,
          system: p.system || '', messages: p.messages || [], tools: p.tools || [],
          tokens: { system: sysTok, messages: msgTok, tools: toolTok, total: sysTok + msgTok + toolTok },
        });
        // 最终作答那次开流式：本地 30B 生成慢，边出边显比等整段快得多（工具轮不开流，省开销）
        if (p.streamInto) {
          payload.stream = true;
          payload.id = 'lm-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7);
          hookStream();
          streamState = { id: payload.id, msg: p.streamInto, el: null };
          const r = await api().aiChat(payload);
          streamState = null;
          return r;
        }
        return api().aiChat(payload);
      },
      onProgress: e => {
        try { window.AgentBoard && window.AgentBoard.feed(e); } catch (e2) {}
        /* 执行流(2026-08-31 用户:要直观看到每个 Agent/工具的工作状态)。
           详细模式逐行记录;简洁模式(设置里可切)退回单行轮播。 */
        const detail = !(window.AppSettings && !window.AppSettings.aiFlowDetail());
        const flow = prog.flow || (prog.flow = []);
        const push = (step) => { flow.push(step); paintFlow(); return step; };
        const paintFlow = () => {
          const el = document.getElementById('aiFlowList');
          if (el) el.innerHTML = flow.map(fmtFlowStep).join('');
          else renderMessages();
        };
        if (e.type === 'plan') {
          if (detail) push({ k: 'plan', label: '路由：' + (e.tasks || []).join(' → '), state: 'ok' });
          setProg('已规划 ' + (e.tasks || []).length + ' 个专家…');
        } else if (e.type === 'agentStart') {
          if (detail) { e._st = push({ k: 'agent', label: e.agent, state: 'run' }); prog._curAgent = { step: e._st, t0: Date.now(), tools: 0 }; }
          setProg('（' + (e.index + 1) + '/' + e.total + '）' + e.agent + ' 分析中…');
        } else if (e.type === 'tool') {
          if (detail) {
            let a = '';
            try { a = JSON.stringify(e.args || {}); } catch (e2) {}
            if (a.length > 58) a = a.slice(0, 58) + '…';
            prog._curTool = push({ k: 'tool', label: e.tool + ' ' + a, state: 'run' });
            if (prog._curAgent) prog._curAgent.tools++;
          }
          setProg('（' + e.agent + '）调用 ' + e.tool + '…');
        } else if (e.type === 'toolDone') {
          if (detail && prog._curTool) { prog._curTool.state = e.ok ? 'ok' : 'err'; prog._curTool.ms = e.ms; prog._curTool = null; paintFlow(); }
        } else if (e.type === 'agentDone') {
          if (detail && prog._curAgent) {
            const c = prog._curAgent;
            c.step.state = (e.result && e.result.error) ? 'err' : 'ok';
            c.step.ms = Date.now() - c.t0;
            c.step.label = e.agent + '（' + c.tools + ' 次工具）';
            prog._curAgent = null; paintFlow();
          }
          setProg('（' + (e.index + 1) + '/' + e.total + '）' + e.agent + ' 完成');
        } else if (e.type === 'synth') {
          if (detail) prog._synth = push({ k: 'synth', label: '综合各专家结论', state: 'run' });
          setProg('正在综合各专家结论…');
        }
      },
    };

    // 流式落点：模型边生成边往这个气泡里写（首 token 通常几秒内到，不用干等整段）
    const bubble = { role: 'assistant', content: '', streaming: true };
    let out;
    try {
      st.messages.push(bubble);
      out = await OR.orchestrate(question, st.boardId, deps, { mode: cfg.lmDeep ? 'deep' : 'fast', streamInto: bubble });
    } finally {
      clearInterval(timer);
      const i = st.messages.indexOf(prog); if (i >= 0) st.messages.splice(i, 1);
      const j = st.messages.indexOf(bubble); if (j >= 0) st.messages.splice(j, 1);
      streamState = null;
    }

    if (prog._synth) { prog._synth.state = 'ok'; prog._synth.ms = null; }
    let ans = out.answer || '(空回复)';
    /* verifyNumbers 弱警示已撤(2026-08-31)：门禁(带反馈循环)是权威——claims 层弱校验
       的池比门禁窄,会对「15.1%」这类有出处的同比数误报;结果仍留 out.verified 供排障。 */
    const used = (out.results || []).filter(r => !r.error).map(r => r.agentName);
    if (used.length > 1) ans += '\n\n*（由 ' + used.join('、') + ' 协同得出）*';
    try { window.AgentBoard && window.AgentBoard.feed({ type: 'done' }); } catch (e) {}
    return { text: ans, flow: (prog.flow && prog.flow.length) ? prog.flow : null, secs: Math.round((Date.now() - t0) / 1000) };
  }

  // 组装 messages（system 口径 + 数据快照 + 回退协议工具说明 + 历史），跑工具循环。
  async function runChat(cfg) {
    const AD = AIData();
    const registry = AD ? AD.buildToolRegistry() : {};
    const snapshot = AD ? await AD.genericSnapshot(st.boardId) : '';

    const sysParts = [AD ? AD.CALIBER_PROMPT : ''];
    if (snapshot) sysParts.push('【当前看板数据快照】\n' + snapshot);
    const fbPrompt = AD ? AD.fallbackToolPrompt(registry) : '';
    if (fbPrompt) sysParts.push(fbPrompt);

    // API messages（system + 会话历史）
    const messages = [{ role: 'system', content: sysParts.filter(Boolean).join('\n\n') }]
      .concat(st.messages.map(m => ({ role: m.role, content: m.content })));

    // 原生 tools 字段（若模型支持则由 API 走 function-calling）
    const toolSpecs = buildOpenAIToolSpecs(AD, registry);

    // 端点/鉴权按提供方路由:LM Studio = OpenAI 兼容 …/v1/chat/completions,无 Key,超时放宽(大模型首次加载慢)
    const isLm = cfg.provider === 'lmstudio';
    const isDs = cfg.provider === 'deepseek';
    const reqBase = () => isLm
      ? { key: '', baseUrl: lmJoin(cfg.lmBase, '/chat/completions'), model: cfg.lmModel, timeoutMs: 180000 }
      : isDs
        ? { key: cfg.dsKey, baseUrl: DS_BASE, model: cfg.dsModel || DS_MODELS[0], timeoutMs: 120000 }
        : cfg.provider === 'anthropic'
          ? { key: cfg.anKey, baseUrl: AN_BASE, model: cfg.anModel || AN_MODELS[0], apiFormat: 'anthropic', timeoutMs: 120000 }
          : cfg.provider === 'openai'
            ? { key: cfg.oaKey, baseUrl: OA_BASE, model: cfg.oaModel || OA_MODELS[0], timeoutMs: 120000 }
            : { key: cfg.key, baseUrl: cfg.baseUrl, model: cfg.model };
    const clean = s => (isLm || isDs) ? stripThink(s) : s;   // 推理模型(<think>)只显示最终答案

    let rounds = 0;
    while (rounds <= MAX_TOOL_ROUNDS) {
      rounds++;
      const payload = Object.assign(reqBase(), { messages });
      if (toolSpecs.length && rounds <= MAX_TOOL_ROUNDS) payload.tools = toolSpecs;
      const resp = await api().aiChat(payload);
      if (!resp || resp.error) {
        let em = resp && resp.error ? resp.error : '无响应';
        if (isLm && /fetch failed|ECONNREFUSED|ECONNRESET|ENOTFOUND|超时/i.test(em)) {
          em += '\n→ 连不上 LM Studio。请打开 LM Studio → Developer 页 → Start Server；' +
            '想免手动，在 LM Studio 设置(Developer)里开启「本地 LLM 服务/开机自启」，之后后台常驻、无需打开 LM Studio 界面。';
        }
        throw new Error(em);
      }

      // 1) 原生 function-calling 返回
      if (resp.toolCalls && resp.toolCalls.length && rounds <= MAX_TOOL_ROUNDS) {
        messages.push({ role: 'assistant', content: resp.content || '', tool_calls: resp.toolCalls });
        for (const tc of resp.toolCalls) {
          const name = tc.function ? tc.function.name : tc.name;
          let args = {};
          try { args = tc.function && tc.function.arguments ? JSON.parse(tc.function.arguments) : (tc.args || {}); } catch (e) { args = {}; }
          const result = await AD.dispatchTool(registry, { tool: name, args });
          messages.push({ role: 'tool', tool_call_id: tc.id || name, name, content: AD.stringifyToolResult(name, result) });
        }
        continue;
      }

      const content = clean(resp.content || '');

      // 2) 回退协议：模型文本里若含 {"tool":...} 指令则本地执行回喂
      const call = AD ? AD.parseToolCall(content) : null;
      if (call && rounds <= MAX_TOOL_ROUNDS) {
        const result = await AD.dispatchTool(registry, call);
        messages.push({ role: 'assistant', content });
        messages.push({ role: 'user', content: AD.stringifyToolResult(call.tool, result) + '\n\n请据此结果继续回答用户的问题。' });
        continue;
      }

      // 3) 普通回答，结束
      return content || '(空回复)';
    }
    // 轮次耗尽：让模型不带工具再答一次
    const resp = await api().aiChat(Object.assign(reqBase(), { messages }));
    if (resp && resp.content) return clean(resp.content);
    return '(工具调用轮次已达上限，未得到最终回答)';
  }

  // 生成 OpenAI/MiniMax 风格 tools 规格。
  // 用 ai-context 里的真实 JSON Schema（含维度枚举与必填项）——旧版是 properties:{} 空壳，
  // 模型因此不知道能按维度取数，问「某产品卖得怎么样」只会答「数据未包含」。
  function buildOpenAIToolSpecs(AD, registry) {
    if (!AD) return [];
    const names = AD.toolNames(registry);
    if (typeof AD.buildToolSpecs === 'function') {
      const specs = AD.buildToolSpecs(names);
      if (specs && specs.length) return specs;
    }
    return names.map(n => ({
      type: 'function',
      function: { name: n, description: '只读数据工具 ' + n + '（返回 销售团队 看板聚合数据）', parameters: { type: 'object', properties: {}, additionalProperties: true } },
    }));
  }

  /* ---------- 设置窗 ---------- */
  function openSettings() {
    ensureRoot();
    const cfg = loadCfg();
    let modal = document.getElementById('aiSettingsModal');
    if (modal) modal.remove();
    modal = document.createElement('div');
    modal.id = 'aiSettingsModal';
    modal.className = 'ai-modal';
    const isPreset = MODELS.includes(cfg.model);
    const isLocal = cfg.provider === 'local';
    const isLm = cfg.provider === 'lmstudio';
    modal.innerHTML =
      '<div class="ai-modal-box">' +
        '<div class="ai-modal-h">AI 设置<button class="ai-modal-x" id="aiSetX">✕</button></div>' +
        '<div class="ai-modal-body">' +
          '<label class="ai-fld"><span>提供方</span><select id="aiSetProvider">' +
            '<option value="deepseek"' + (cfg.provider === 'deepseek' ? ' selected' : '') + '>DeepSeek API（在线，推荐）</option>' +
            '<option value="minimax"' + (cfg.provider === 'minimax' ? ' selected' : '') + '>MiniMax API（在线）</option>' +
            '<option value="anthropic"' + (cfg.provider === 'anthropic' ? ' selected' : '') + '>Claude API（Anthropic）</option>' +
            '<option value="openai"' + (cfg.provider === 'openai' ? ' selected' : '') + '>OpenAI API</option>' +
            '<option value="corplink"' + (cfg.provider === 'corplink' ? ' selected' : '') + '>CorpLink CLI（Acme内网）</option>' +
            '<option value="lmstudio"' + (isLm ? ' selected' : '') + '>LM Studio（本机服务器）</option>' +
            '<option value="local"' + (isLocal ? ' selected' : '') + '>本地模型（内置 gguf）</option>' +
          '</select></label>' +
          // ── Claude 组 ──
          '<div id="aiGrpAn"' + (cfg.provider === 'anthropic' ? '' : ' style="display:none"') + '>' +
            '<label class="ai-fld"><span>API Key（console.anthropic.com）</span><input type="password" id="aiSetAnKey" placeholder="sk-ant-…" value="' + esc(cfg.anKey) + '"></label>' +
            '<label class="ai-fld"><span>模型</span><span class="ai-path-row"><select id="aiSetAnModel" style="flex:1;min-width:0">' +
              AN_MODELS.map(m => '<option value="' + esc(m) + '"' + (m === cfg.anModel ? ' selected' : '') + '>' + esc(m) + '</option>').join('') +
              '<option value="__custom__"' + (AN_MODELS.includes(cfg.anModel) ? '' : ' selected') + '>自定义…</option>' +
            '</select><input type="text" id="aiSetAnCustom" style="flex:1;min-width:0;' + (AN_MODELS.includes(cfg.anModel) ? 'display:none' : '') + '" value="' + (AN_MODELS.includes(cfg.anModel) ? '' : esc(cfg.anModel)) + '" placeholder="模型名"></span></label>' +
            '<div class="ai-set-note">Claude 是表格问答/工具调用第一梯队（2026-08 调研）。走 Anthropic Messages 格式，软件已内置适配。</div>' +
          '</div>' +
          // ── OpenAI 组 ──
          '<div id="aiGrpOa"' + (cfg.provider === 'openai' ? '' : ' style="display:none"') + '>' +
            '<label class="ai-fld"><span>API Key（platform.openai.com）</span><input type="password" id="aiSetOaKey" placeholder="sk-…" value="' + esc(cfg.oaKey) + '"></label>' +
            '<label class="ai-fld"><span>模型</span><span class="ai-path-row"><select id="aiSetOaModel" style="flex:1;min-width:0">' +
              OA_MODELS.map(m => '<option value="' + esc(m) + '"' + (m === cfg.oaModel ? ' selected' : '') + '>' + esc(m) + '</option>').join('') +
              '<option value="__custom__"' + (OA_MODELS.includes(cfg.oaModel) ? '' : ' selected') + '>自定义…</option>' +
            '</select><input type="text" id="aiSetOaCustom" style="flex:1;min-width:0;' + (OA_MODELS.includes(cfg.oaModel) ? 'display:none' : '') + '" value="' + (OA_MODELS.includes(cfg.oaModel) ? '' : esc(cfg.oaModel)) + '" placeholder="模型名"></span></label>' +
            '<div class="ai-set-note">标准 OpenAI 接口。模型名可手输（厂商迭代快，下拉仅为常用款）。</div>' +
          '</div>' +
          // ── CorpLink CLI 组 ──
          '<div id="aiGrpWl"' + (cfg.provider === 'corplink' ? '' : ' style="display:none"') + '>' +
            '<label class="ai-fld"><span>CLI 命令（如 corplink，需在 PATH 或写全路径）</span><input type="text" id="aiSetWlCmd" value="' + esc(cfg.wlCmd) + '" placeholder="corplink"></label>' +
            '<label class="ai-fld"><span>参数模板（空格分隔；文件方式用 {PROMPT_FILE} 占位）</span><input type="text" id="aiSetWlArgs" value="' + esc(cfg.wlArgs) + '" placeholder="ai chat --model deepseek"></label>' +
            '<label class="ai-fld"><span>问题怎么传给 CLI</span><select id="aiSetWlMode">' +
              '<option value="stdin"' + (cfg.wlMode === 'stdin' ? ' selected' : '') + '>标准输入（stdin，最常见）</option>' +
              '<option value="file"' + (cfg.wlMode === 'file' ? ' selected' : '') + '>临时文件（参数里 {PROMPT_FILE}）</option>' +
              '<option value="arg"' + (cfg.wlMode === 'arg' ? ' selected' : '') + '>命令行参数（追加到末尾）</option>' +
            '</select></label>' +
            '<div class="ai-set-note">适配Acme内网「CorpLink CLI → DeepSeek」通道：CLI 需一次调用完成一问一答、回答走标准输出。数据工具调用走文本协议，护栏与数字溯源门禁全部生效。在办公电脑上跑一次 CLI 的 --help 把命令与参数填进来即可。</div>' +
          '</div>' +
          // ── DeepSeek 组 ──
          '<div id="aiGrpDs"' + (cfg.provider === 'deepseek' ? '' : ' style="display:none"') + '>' +
            '<label class="ai-fld"><span>API Key（platform.deepseek.com）</span><input type="password" id="aiSetDsKey" placeholder="sk-…" value="' + esc(cfg.dsKey) + '"></label>' +
            '<label class="ai-fld"><span>模型</span><select id="aiSetDsModel">' +
              '<option value="deepseek-chat"' + (cfg.dsModel === 'deepseek-chat' ? ' selected' : '') + '>deepseek-chat（V4-Flash · 快 · 评测88.3%）</option>' +
              '<option value="deepseek-v4-pro"' + (cfg.dsModel === 'deepseek-v4-pro' ? ' selected' : '') + '>deepseek-v4-pro（最准93.1% · 慢,单题可达数分钟）</option>' +
            '</select></label>' +
            '<div class="ai-set-note">2026-08-31 同套30题实测：V4-Flash 88.3%/0编数/10.9s，超 MiniMax-M2.5(80.0%)；日常问答用 Flash，深度分析可切 Pro。</div>' +
          '</div>' +
          // ── LM Studio 组 ──
          '<div id="aiGrpLm"' + (isLm ? '' : ' style="display:none"') + '>' +
            '<label class="ai-fld"><span>服务器地址（LM Studio → Developer → Start Server）</span><input type="text" id="aiSetLmBase" value="' + esc(cfg.lmBase) + '" placeholder="http://127.0.0.1:1234/v1"></label>' +
            '<label class="ai-fld"><span>模型</span><span class="ai-path-row"><select id="aiSetLmModel" style="flex:1;min-width:0">' +
              (cfg.lmModels.length ? cfg.lmModels.map(m => '<option value="' + esc(m) + '"' + (m === cfg.lmModel ? ' selected' : '') + '>' + esc(m) + '</option>').join('') : '<option value="">（先拉取模型列表）</option>') +
            '</select><button class="ai-btn" id="aiLmFetch" type="button">拉取模型列表</button></span></label>' +
            '<div class="ai-set-note">OpenAI 兼容接口，无需 API Key。在 LM Studio 里加载 TableGPT-R1 / Qwen3 等模型并启动服务器后，点「拉取模型列表」选择。推理模型的 &lt;think&gt; 过程会自动隐藏，只显示最终答案。</div>' +
          '</div>' +
          // ── MiniMax 组 ──
          '<div id="aiGrpMinimax"' + (isLocal ? ' style="display:none"' : '') + '>' +
            '<label class="ai-fld"><span>API Key</span><input type="password" id="aiSetKey" placeholder="sk-… / MiniMax Key" value="' + esc(cfg.key) + '"></label>' +
            '<label class="ai-fld"><span>Base URL</span><input type="text" id="aiSetUrl" value="' + esc(cfg.baseUrl) + '"></label>' +
            '<label class="ai-fld"><span>模型</span><select id="aiSetModel">' +
              MODELS.map(m => '<option value="' + esc(m) + '"' + (m === cfg.model ? ' selected' : '') + '>' + esc(m) + '</option>').join('') +
              '<option value="__custom__"' + (isPreset ? '' : ' selected') + '>自定义…</option>' +
            '</select></label>' +
            '<label class="ai-fld" id="aiCustomWrap"' + (isPreset ? ' style="display:none"' : '') + '><span>自定义模型名</span><input type="text" id="aiSetCustom" value="' + (isPreset ? '' : esc(cfg.model)) + '" placeholder="手输任意模型名"></label>' +
          '</div>' +
          // ── 本地模型组 ──
          '<div id="aiGrpLocal"' + (isLocal ? '' : ' style="display:none"') + '>' +
            '<label class="ai-fld"><span>模型文件（.gguf，留空自动查找）</span>' +
              '<span class="ai-path-row"><input type="text" id="aiSetModelPath" placeholder="留空 → 程序同级 models\\*.gguf 自动查找" value="' + esc(cfg.modelPath) + '">' +
              '<button class="ai-btn" id="aiPickModel" type="button">选择文件…</button></span></label>' +
            '<div class="ai-set-note">离线本地推理，无需 API Key、不联网；首次生成会先加载模型（约数秒）。仅解读已算好的聚合数据。</div>' +
          '</div>' +
          '<div class="ai-set-foot">' +
            '<span class="ai-set-note">配置仅存本机，不进存档、不外传。</span>' +
            '<button class="ai-btn" id="aiTest">测试连接</button>' +
            '<button class="ai-btn" id="aiNetCheck">网络体检</button>' +
            '<button class="ai-btn primary" id="aiSetSave">保存</button>' +
          '</div>' +
          '<div class="ai-set-status" id="aiSetStatus"></div>' +
        '</div>' +
      '</div>';
    document.body.appendChild(modal);

    const q = s => modal.querySelector(s);
    const providerSel = q('#aiSetProvider'), modelSel = q('#aiSetModel'), customWrap = q('#aiCustomWrap');
    const grpMini = q('#aiGrpMinimax'), grpLocal = q('#aiGrpLocal'), grpLm = q('#aiGrpLm'), testBtn = q('#aiTest');
    let lmAutoFetched = false;
    let doLmFetch = null;          // 先声明(初次 syncProvider() 早于赋值,避免 TDZ),下方赋真函数
    const grpDs = q('#aiGrpDs'), grpWl = q('#aiGrpWl'), grpAn = q('#aiGrpAn'), grpOa = q('#aiGrpOa');
    const syncProvider = () => {
      const v = providerSel.value;
      grpDs.style.display = v === 'deepseek' ? '' : 'none';
      grpWl.style.display = v === 'corplink' ? '' : 'none';
      grpAn.style.display = v === 'anthropic' ? '' : 'none';
      grpOa.style.display = v === 'openai' ? '' : 'none';
      grpMini.style.display = v === 'minimax' ? '' : 'none';
      grpLocal.style.display = v === 'local' ? '' : 'none';
      grpLm.style.display = v === 'lmstudio' ? '' : 'none';
      testBtn.textContent = v === 'local' ? '检测模型' : '测试连接';
      // 切到 LM Studio 时自动拉一次模型列表(仅一次;doLmFetch 在下方定义,onchange 触发时已存在)
      if (v === 'lmstudio' && !lmAutoFetched && typeof doLmFetch === 'function') { lmAutoFetched = true; setTimeout(doLmFetch, 60); }
    };
    syncProvider();
    providerSel.onchange = syncProvider;
    const bindCustom = (selId, inpId) => { const sel = q(selId), inp = q(inpId); if (sel && inp) sel.onchange = () => { inp.style.display = sel.value === '__custom__' ? '' : 'none'; }; };
    bindCustom('#aiSetAnModel', '#aiSetAnCustom'); bindCustom('#aiSetOaModel', '#aiSetOaCustom');
    modelSel.onchange = () => { customWrap.style.display = modelSel.value === '__custom__' ? '' : 'none'; };
    q('#aiSetX').onclick = () => modal.remove();
    modal.onclick = e => { if (e.target === modal) modal.remove(); };
    q('#aiPickModel').onclick = async () => {
      try { const p = await api().aiPickModel(); if (p) q('#aiSetModelPath').value = p; } catch (e) {}
    };

    const readForm = () => {
      const model = modelSel.value === '__custom__' ? (q('#aiSetCustom').value || '').trim() : modelSel.value;
      const lmSel = q('#aiSetLmModel');
      return {
        key: (q('#aiSetKey').value || '').trim(),
        baseUrl: (q('#aiSetUrl').value || '').trim() || DEFAULT_BASE,
        model: model || MODELS[0],
        provider: ['local', 'lmstudio', 'minimax', 'deepseek', 'corplink', 'anthropic', 'openai'].includes(providerSel.value) ? providerSel.value : 'deepseek',
        dsKey: (q('#aiSetDsKey').value || '').trim(),
        dsModel: (q('#aiSetDsModel').value || DS_MODELS[0]),
        dsMigrated: true,
        wlCmd: (q('#aiSetWlCmd').value || '').trim(),
        wlArgs: (q('#aiSetWlArgs').value || '').trim(),
        wlMode: (q('#aiSetWlMode').value || 'stdin'),
        anKey: (q('#aiSetAnKey').value || '').trim(),
        anModel: (q('#aiSetAnModel').value === '__custom__' ? (q('#aiSetAnCustom').value || '').trim() : q('#aiSetAnModel').value) || AN_MODELS[0],
        oaKey: (q('#aiSetOaKey').value || '').trim(),
        oaModel: (q('#aiSetOaModel').value === '__custom__' ? (q('#aiSetOaCustom').value || '').trim() : q('#aiSetOaModel').value) || OA_MODELS[0],
        modelPath: (q('#aiSetModelPath').value || '').trim(),
        lmBase: (q('#aiSetLmBase').value || '').trim() || LM_DEFAULT_BASE,
        lmModel: lmSel ? (lmSel.value || '') : '',
        lmModels: lmSel ? Array.from(lmSel.options).map(o => o.value).filter(Boolean) : [],
      };
    };
    // 拉取 LM Studio 模型列表(GET {base}/models),填进下拉并保留原选择。
    // 打开设置/切到 LM Studio 时自动拉一次(零配置);手点按钮可随时重拉。
    let lmFetching = false;
    doLmFetch = async () => {
      if (lmFetching) return; lmFetching = true;
      const status = q('#aiSetStatus');
      const base = (q('#aiSetLmBase').value || '').trim() || LM_DEFAULT_BASE;
      status.textContent = '正在连接 LM Studio 拉取模型…'; status.className = 'ai-set-status';
      try {
        const r = await api().aiListModels(base, '');
        if (r && r.error) { status.textContent = '连不上：' + r.error + '　→ 请在 LM Studio 的 Developer 页点 Start Server(可开启开机自启服务免手动)'; status.className = 'ai-set-status err'; return; }
        const models = (r && r.models) || [];
        if (!models.length) { status.textContent = 'LM Studio 服务在线,但没有可用模型——请先在 LM Studio 里下载/加载模型。'; status.className = 'ai-set-status err'; return; }
        const sel = q('#aiSetLmModel'); const prev = sel.value || cfg.lmModel;
        sel.innerHTML = models.map(m => '<option value="' + esc(m) + '"' + (m === prev ? ' selected' : '') + '>' + esc(m) + '</option>').join('');
        status.textContent = '已找到 ' + models.length + ' 个模型 ✓' + (models.includes(prev) ? '' : '（已自动选中 ' + models[0] + '）'); status.className = 'ai-set-status ok';
      } catch (e) { status.textContent = '连不上：' + String((e && e.message) || e); status.className = 'ai-set-status err'; }
      finally { lmFetching = false; }
    };
    q('#aiLmFetch').onclick = doLmFetch;
    if (isLm) setTimeout(doLmFetch, 60);   // 已是 LM Studio → 打开设置即自动刷新列表
    q('#aiSetSave').onclick = () => { saveCfg(readForm()); toastSafe('已保存 AI 设置', 'ok'); modal.remove(); };
    /* 网络体检(2026-08-31):测试连接(1 token 裸 ping)通过≠问答链路通——企业代理常
       放小请求拦大请求/拦带工具请求。三级递进,逐级报耗时+状态+摘要,断在哪级一目了然。 */
    q('#aiNetCheck').onclick = async () => {
      const c = readForm();
      const status = q('#aiSetStatus');
      const endp = c.provider === 'deepseek' ? { key: c.dsKey, baseUrl: DS_BASE, model: c.dsModel }
        : c.provider === 'minimax' ? { key: c.key, baseUrl: c.baseUrl, model: c.model }
        : c.provider === 'anthropic' ? { key: c.anKey, baseUrl: AN_BASE, model: c.anModel, apiFormat: 'anthropic' }
        : c.provider === 'openai' ? { key: c.oaKey, baseUrl: OA_BASE, model: c.oaModel }
        : null;
      if (!endp) { status.textContent = '网络体检仅适用于在线 API'; status.className = 'ai-set-status err'; return; }
      if (!endp.key) { status.textContent = '请先填 API Key'; status.className = 'ai-set-status err'; return; }
      const lines = ['体检开始(模型 ' + endp.model + ')…'];
      const paint = () => { status.innerHTML = lines.map(esc).join('<br>'); status.className = 'ai-set-status'; };
      paint();
      const AD = AIData();
      const run = async (name, payload) => {
        const t0 = Date.now();
        try {
          if (/pro|reasoner|thinking|r1|m3/i.test(endp.model || '') && (!payload.maxTokens || payload.maxTokens < 2048)) payload = Object.assign({}, payload, { maxTokens: 4096 });
          const r = await api().aiChat(Object.assign({ key: endp.key, baseUrl: endp.baseUrl, model: endp.model, apiFormat: endp.apiFormat, timeoutMs: 90000 }, payload));
          const dt = ((Date.now() - t0) / 1000).toFixed(1) + 's';
          if (r && r.error) { lines.push('✗ ' + name + ' [' + dt + '] ' + String(r.error).slice(0, 160)); return false; }
          const got = r && (r.content || (r.toolCalls && ('调用工具:' + r.toolCalls.map(tc => tc.function.name).join(','))));
          lines.push('✓ ' + name + ' [' + dt + '] ' + String(got || '(无内容?)').slice(0, 60));
          return true;
        } catch (e) { lines.push('✗ ' + name + ' 异常: ' + String((e && e.message) || e).slice(0, 120)); return false; }
        finally { paint(); }
      };
      const pad = new Array(80).fill('数据行:国家,产品,周,销量,库存,金额;').join('');
      await run('L1 裸连通(小请求)', { messages: [{ role: 'user', content: 'ping' }], maxTokens: 1 });
      await run('L2 生成链路(约4KB请求体)', { messages: [{ role: 'system', content: '你是数据助手。以下是背景资料:' + pad }, { role: 'user', content: '只回复四个字:体检通过' }], maxTokens: 50, temperature: 0 });
      let specs = [];
      try { specs = AD && AD.buildToolSpecs ? AD.buildToolSpecs(AD.toolNames(AD.buildToolRegistry())).slice(0, 6) : []; } catch (e) {}
      if (specs.length) {
        await run('L3 工具链路(带 function-calling)', { messages: [{ role: 'user', content: '请调用 meta 工具查看数据概况' }], tools: specs, maxTokens: 300, temperature: 0 });
      } else lines.push('· L3 跳过(工具规格不可用)');
      lines.push('体检结束——断在哪一级,问题就在那一级的差异上(L1小请求/L2大请求体/L3工具字段)。把整段结果发给开发者即可定位。');
      paint();
    };
    testBtn.onclick = async () => {
      const c = readForm();
      const status = q('#aiSetStatus');
      if (c.provider === 'local') {
        status.textContent = '检测中…'; status.className = 'ai-set-status';
        try {
          const info = await api().aiLocalModelInfo(c.modelPath);
          if (info && info.exists) { status.textContent = '已找到模型：' + info.path + '（' + info.source + '）'; status.className = 'ai-set-status ok'; }
          else { status.textContent = '未找到 .gguf 模型。请「选择文件」或放到程序同级 models 文件夹。'; status.className = 'ai-set-status err'; }
        } catch (e) { status.textContent = '检测失败：' + String((e && e.message) || e); status.className = 'ai-set-status err'; }
        return;
      }
      if (c.provider === 'lmstudio') {
        if (!c.lmModel) { status.textContent = '请先「拉取模型列表」并选择模型'; status.className = 'ai-set-status err'; return; }
        status.textContent = '测试中…（首次会加载模型，可能要几十秒）'; status.className = 'ai-set-status';
        try {
          const resp = await api().aiChat({ key: '', baseUrl: lmJoin(c.lmBase, '/chat/completions'), model: c.lmModel, messages: [{ role: 'user', content: '只回复两个字:在线' }], maxTokens: 200, timeoutMs: 180000 });
          if (resp && resp.error) { status.textContent = '失败：' + resp.error; status.className = 'ai-set-status err'; }
          else { status.textContent = '连接成功 ✓ ' + c.lmModel + ' 回复：' + stripThink(resp.content).slice(0, 60); status.className = 'ai-set-status ok'; }
        } catch (e) { status.textContent = '失败：' + String((e && e.message) || e); status.className = 'ai-set-status err'; }
        return;
      }
      if (c.provider === 'corplink') {
        if (!c.wlCmd) { status.textContent = '请先填 CLI 命令'; status.className = 'ai-set-status err'; return; }
        status.textContent = '测试中…（跑一次 CLI）'; status.className = 'ai-set-status';
        try {
          const resp = await api().aiChatCli({ cmd: c.wlCmd, argsTmpl: c.wlArgs, inputMode: c.wlMode, prompt: '只回复两个字:在线', timeoutMs: 120000 });
          if (resp && resp.error) { status.textContent = '失败：' + resp.error; status.className = 'ai-set-status err'; }
          else { status.textContent = '连接成功 ✓ CLI 回复：' + String(resp.content || '').slice(0, 60); status.className = 'ai-set-status ok'; }
        } catch (e) { status.textContent = '失败：' + String((e && e.message) || e); status.className = 'ai-set-status err'; }
        return;
      }
      if (c.provider === 'anthropic' || c.provider === 'openai') {
        const isAn = c.provider === 'anthropic';
        const k = isAn ? c.anKey : c.oaKey;
        if (!k) { status.textContent = '请先填 API Key'; status.className = 'ai-set-status err'; return; }
        status.textContent = '测试中…'; status.className = 'ai-set-status';
        try {
          const pl = isAn
            ? { key: k, baseUrl: AN_BASE, model: c.anModel, apiFormat: 'anthropic', messages: [{ role: 'user', content: 'ping' }], maxTokens: 8 }
            : { key: k, baseUrl: OA_BASE, model: c.oaModel, messages: [{ role: 'user', content: 'ping' }], maxTokens: 8 };
          const resp = await api().aiChat(pl);
          if (resp && resp.error) { status.textContent = '失败：' + resp.error; status.className = 'ai-set-status err'; }
          else { status.textContent = '连接成功 ✓ ' + (isAn ? c.anModel : c.oaModel); status.className = 'ai-set-status ok'; }
        } catch (e) { status.textContent = '失败：' + String((e && e.message) || e); status.className = 'ai-set-status err'; }
        return;
      }
      if (c.provider === 'deepseek') {
        if (!c.dsKey) { status.textContent = '请先填 DeepSeek API Key'; status.className = 'ai-set-status err'; return; }
        status.textContent = '测试中…'; status.className = 'ai-set-status';
        try {
          const tk = /pro|reasoner|thinking|r1/i.test(c.dsModel || '') ? 2048 : 8;
          const resp = await api().aiChat({ key: c.dsKey, baseUrl: DS_BASE, model: c.dsModel, messages: [{ role: 'user', content: 'ping' }], maxTokens: tk });
          if (resp && resp.error) {
            let px = '';
            try { const pi = await api().aiProxyInfo(DS_BASE); px = pi && pi.proxy ? '　当前网络路径: ' + pi.proxy : ''; } catch (e2) {}
            status.textContent = '失败：' + resp.error + px; status.className = 'ai-set-status err';
          }
          else { status.textContent = '连接成功 ✓ ' + c.dsModel; status.className = 'ai-set-status ok'; }
        } catch (e) { status.textContent = '失败：' + String((e && e.message) || e); status.className = 'ai-set-status err'; }
        return;
      }
      if (!c.key) { status.textContent = '请先填 API Key'; status.className = 'ai-set-status err'; return; }
      status.textContent = '测试中…'; status.className = 'ai-set-status';
      try {
        const resp = await api().aiChat({ key: c.key, baseUrl: c.baseUrl, model: c.model, messages: [{ role: 'user', content: 'ping' }], maxTokens: 1 });
        if (resp && resp.error) { status.textContent = '失败：' + resp.error; status.className = 'ai-set-status err'; }
        else { status.textContent = '连接成功 ✓'; status.className = 'ai-set-status ok'; }
      } catch (e) { status.textContent = '失败：' + String((e && e.message) || e); status.className = 'ai-set-status err'; }
    };
  }

  function toastSafe(msg, kind) { try { if (typeof toast === 'function') toast(msg, kind); } catch (e) {} }

  /* ---------- 🤖 按钮：动态注入每个 section.view（零改视图文件） ---------- */
  function injectButtons() {
    const views = document.querySelectorAll('section.view');
    views.forEach(v => {
      if (v.querySelector('.ai-fab')) return;
      const id = (v.id || '').replace(/^view-/, '');
      // 各 view 定位上下文：view 本身是 flex 容器，position 默认 static → 设为 relative 供 fab 绝对定位
      if (getComputedStyle(v).position === 'static') v.style.position = 'relative';
      const btn = document.createElement('button');
      btn.className = 'ai-fab';
      btn.type = 'button';
      btn.title = 'AI 问答（本看板）';
      btn.textContent = '🤖';
      btn.onclick = (e) => { e.stopPropagation(); open(id); };
      v.appendChild(btn);
    });
  }

  /* ---------- 样式（一次注入） ---------- */
  function injectStyles() {
    if (document.getElementById('aiPanelStyle')) return;
    const css =
      '.ai-fab{position:absolute;top:10px;right:14px;z-index:40;width:34px;height:34px;border-radius:50%;border:1px solid var(--line);background:#fff;box-shadow:var(--shadow);font-size:17px;line-height:1;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:.15s;padding:0}' +
      '.ai-fab:hover{border-color:var(--red);box-shadow:var(--shadow-l);transform:scale(1.06)}' +
      '.ai-root{position:fixed;inset:0;z-index:1300}' +
      '.ai-root.hidden{display:none}' +
      '.ai-mask{position:absolute;inset:0;background:rgba(20,23,28,.35)}' +
      '.ai-panel{position:absolute;top:0;right:0;height:100%;width:min(440px,92vw);background:#fff;box-shadow:var(--shadow-l);display:flex;flex-direction:column;animation:aiSlide .18s ease-out}' +
      '@keyframes aiSlide{from{transform:translateX(100%)}to{transform:translateX(0)}}' +
      '.ai-flow{font:11px/1.7 Consolas,monospace;color:var(--ink2,#555);margin:2px 0 6px;max-height:180px;overflow-y:auto}' +
      '.ai-flow-row{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' +
      '.ai-fs-ok{color:#1E9E57}.ai-fs-err{color:#C7000B}.ai-fs-run{opacity:.7}' +
      '.ai-fs-ms{color:var(--ink3,#999);margin-left:6px;font-size:10px}' +
      '.ai-flow-done{margin-bottom:8px}.ai-flow-done summary{cursor:pointer;font-size:11px;color:var(--ink3,#888)}' +
      '.ai-head{flex-shrink:0;height:50px;display:flex;align-items:center;gap:10px;padding:0 14px;border-bottom:1px solid var(--line)}' +
      '.ai-title{font-size:14px;font-weight:600;color:var(--ink);flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
      '.ai-head-btns{display:flex;gap:4px}' +
      '.ai-hbtn{border:none;background:transparent;font-size:15px;width:30px;height:30px;border-radius:7px;cursor:pointer;color:var(--ink2)}' +
      '.ai-hbtn:hover{background:#F0F1F3;color:var(--ink)}' +
      '.ai-msgs{flex:1;overflow:auto;padding:14px;display:flex;flex-direction:column;gap:10px;background:#FAFBFC}' +
      '.ai-empty{color:var(--ink3);font-size:12.5px;text-align:center;padding:40px 12px;line-height:1.9}' +
      '.ai-bubble{max-width:88%;padding:9px 12px;border-radius:12px;font-size:13px;line-height:1.6;word-break:break-word;white-space:normal}' +
      '.ai-bubble.u{align-self:flex-end;background:var(--red);color:#fff;border-bottom-right-radius:3px}' +
      '.ai-bubble.a{align-self:flex-start;background:#fff;border:1px solid var(--line);color:var(--ink);border-bottom-left-radius:3px}' +
      '.ai-bubble.ai-think{color:var(--ink3);font-style:italic}' +
      '.ai-bubble .ai-code{background:#1E2127;color:#E6E8EB;border-radius:7px;padding:9px 11px;font-size:12px;overflow:auto;white-space:pre;font-family:Consolas,Monaco,monospace;margin:4px 0}' +
      '.ai-bubble .ai-ic{background:#F0F1F3;border-radius:4px;padding:1px 5px;font-size:12px;font-family:Consolas,Monaco,monospace}' +
      '.ai-bubble .ai-tbl{border-collapse:collapse;font-size:12px;margin:6px 0;width:100%}' +
      '.ai-bubble .ai-tbl th,.ai-bubble .ai-tbl td{border:1px solid var(--line);padding:4px 8px;text-align:left}' +
      '.ai-bubble .ai-tbl th{background:#F4F6F8;font-weight:600}' +
      '.ai-input{flex-shrink:0;border-top:1px solid var(--line);padding:10px;display:flex;gap:8px;align-items:flex-end}' +
      '.ai-input textarea{flex:1;resize:none;border:1px solid var(--line);border-radius:8px;padding:8px 10px;font-family:inherit;font-size:13px;outline:none;max-height:120px}' +
      '.ai-input textarea:focus{border-color:var(--red)}' +
      '.ai-send{border:none;background:var(--red);color:#fff;border-radius:8px;padding:9px 16px;font-size:13px;cursor:pointer;white-space:nowrap}' +
      '.ai-send:hover{background:var(--red-d)}' +
      '.ai-modal{position:fixed;inset:0;background:rgba(20,23,28,.5);z-index:1400;display:flex;align-items:center;justify-content:center}' +
      '.ai-modal-box{background:#fff;border-radius:14px;box-shadow:var(--shadow-l);width:min(460px,90vw);overflow:hidden}' +
      '.ai-modal-h{padding:14px 18px;border-bottom:1px solid var(--line);font-weight:600;font-size:14px;display:flex;align-items:center}' +
      '.ai-modal-x{margin-left:auto;border:none;background:transparent;font-size:16px;color:var(--ink3);cursor:pointer}' +
      '.ai-modal-body{padding:16px 18px;display:flex;flex-direction:column;gap:12px}' +
      '.ai-fld{display:flex;flex-direction:column;gap:5px;font-size:12px;color:var(--ink2)}' +
      '.ai-fld input,.ai-fld select{border:1px solid var(--line);border-radius:7px;padding:8px 10px;font-family:inherit;font-size:13px;outline:none;color:var(--ink)}' +
      '.ai-fld input:focus,.ai-fld select:focus{border-color:var(--red)}' +
      '.ai-set-foot{display:flex;align-items:center;gap:10px;margin-top:4px}' +
      '.ai-set-note{flex:1;font-size:11px;color:var(--ink3)}' +
      '.ai-btn{border:1px solid var(--line);background:#fff;border-radius:7px;padding:7px 14px;font-size:12.5px;cursor:pointer;color:var(--ink)}' +
      '.ai-btn:hover{border-color:#C9CFD6;background:#FAFBFC}' +
      '.ai-btn.primary{background:var(--red);border-color:var(--red);color:#fff}' +
      '.ai-btn.primary:hover{background:var(--red-d)}' +
      '.ai-set-status{font-size:12px;min-height:16px;word-break:break-all}' +
      '.ai-set-status.ok{color:#1E9E57}.ai-set-status.err{color:#C7000B}' +
      '.ai-path-row{display:flex;gap:6px;align-items:center}' +
      '.ai-path-row input{flex:1;min-width:0}' +
      '.ai-path-row .ai-btn{white-space:nowrap;flex-shrink:0}' +
      '#aiGrpMinimax,#aiGrpLocal{display:flex;flex-direction:column;gap:12px}' +
      '.ai-cursor{display:inline-block;width:6px;color:var(--red);animation:aiBlink 1s steps(1) infinite}' +
      '@keyframes aiBlink{50%{opacity:0}}';
    const style = document.createElement('style');
    style.id = 'aiPanelStyle';
    style.textContent = css;
    document.head.appendChild(style);
  }

  /* ---------- 初始化 ---------- */
  function init() {
    injectStyles();
    ensureRoot();
    hookStream();          // 订阅本地模型流事件（一次）
    injectButtons();
    // 导航「AI 问答」项（#navAiEntry，无 data-view 故不参与切视图/排序/隐藏）：全局模式浮层打开。
    const nav = document.getElementById('navAiEntry');
    if (nav) nav.addEventListener('click', (e) => { e.stopPropagation(); open(null); });
  }

  // 暴露给 app.js / nav
  /* 供 Agent 对话看板复用的编排依赖工厂(2026-08-31)：与 runOrchestrated 同源的 deps，
     onProgress 由调用方提供(多会话并行各自渲染)。 */
  function makeOrchDeps(cfg, onProgress) {
    const AD = AIData(), OR = window.AIOrch;
    const registry = AD ? AD.buildToolRegistry() : {};
    return {
      schemas: AD.TOOL_SCHEMAS,
      buildToolSpecs: names => (AD.buildToolSpecs ? AD.buildToolSpecs(names) : []),
      pickTools: AD.pickTools,
      parseToolCall: AD.parseToolCall,
      boardLabel: b => (b ? AD.labelOf(b) : '全局（跨看板）'),
      filters: b => { try { const c = AD.boardContext && AD.boardContext(b); return c ? c.filters : null; } catch (e) { return null; } },
      snapshot: async b => { try { return await AD.genericSnapshot(b); } catch (e) { return ''; } },
      runTool: async (name, args) => AD.dispatchTool(registry, { tool: name, args }),
      optionsDirect: async (field) => AD.dispatchTool(registry, { tool: 'options', args: { field } }),
      catalogDirect: async () => { try { return await api().psiCatalog(); } catch (e) { return null; } },
      catalogDirect: async () => { try { return await api().psiCatalog(); } catch (e) { return null; } },
      provRetry: true,
      onProgress: onProgress || (() => {}),
      visionEndpoint: () => pickVisionEndpoint(cfg),
      chat: async p => {
        if (p.forceEndpoint) {
          const fe = p.forceEndpoint; let mt = p.maxTokens;
          if (/vision|pro|reasoner|thinking/i.test(String(fe.model || '')) && (!mt || mt < 3000)) mt = 3000;   // 视觉/推理模型 token 给足否则返空
          const fpayload = { key: fe.key, baseUrl: fe.baseUrl, model: fe.model, apiFormat: fe.apiFormat, timeoutMs: 120000, messages: p.messages, maxTokens: mt, temperature: 0 };
          if (p.system) fpayload.messages = [{ role: 'system', content: p.system }].concat(p.messages || []);
          return api().aiChat(fpayload);
        }
        if (cfg.provider === 'corplink') return cliChat(cfg, p);
        const mdlName = cfg.provider === 'deepseek' ? (cfg.dsModel || '') : cfg.provider === 'minimax' ? (cfg.model || '') : cfg.provider === 'anthropic' ? (cfg.anModel || '') : cfg.provider === 'openai' ? (cfg.oaModel || '') : '';
        if (/pro|reasoner|thinking|r1|m3/i.test(mdlName) && (!p.maxTokens || p.maxTokens < 16000)) p = Object.assign({}, p, { maxTokens: 16000 });
        const endp = cfg.provider === 'deepseek' ? { key: cfg.dsKey, baseUrl: DS_BASE, model: cfg.dsModel || DS_MODELS[0], timeoutMs: 120000 }
          : cfg.provider === 'minimax' ? { key: cfg.key, baseUrl: cfg.baseUrl, model: cfg.model, timeoutMs: 120000 }
          : cfg.provider === 'anthropic' ? { key: cfg.anKey, baseUrl: AN_BASE, model: cfg.anModel || AN_MODELS[0], apiFormat: 'anthropic', timeoutMs: 120000 }
          : cfg.provider === 'openai' ? { key: cfg.oaKey, baseUrl: OA_BASE, model: cfg.oaModel || OA_MODELS[0], timeoutMs: 120000 }
          : { key: '', baseUrl: lmJoin(cfg.lmBase, '/chat/completions'), model: cfg.lmModel, timeoutMs: (OR && OR.BUDGET.timeoutMs) || 180000 };
        const payload = Object.assign({}, endp, { messages: p.messages, maxTokens: p.maxTokens, temperature: 0 });
        if (p.system) payload.messages = [{ role: 'system', content: p.system }].concat(p.messages || []);
        if (p.tools && p.tools.length) payload.tools = p.tools;
        return api().aiChat(payload);
      },
    };
  }
  window.AIPanel = { init, open, close, injectButtons, openSettings, makeOrchDeps, loadCfg, saveCfg, md, pickVisionEndpoint };

  // 自启：DOM 就绪即初始化（app.js 的 init 在其后运行，nav 点击处理也在此挂）
  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
  }
})();

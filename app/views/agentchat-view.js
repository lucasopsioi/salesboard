/* ============================================================
   Salesboard — Agent 对话看板（2026-08-31 用户需求，第 17 视图）
   多路会话并行 × 点选专家定向作答 × 模型快切 × 本地文档上传 × PPT/Excel 输出。
   编排复用 AIPanel.makeOrchDeps（护栏/门禁/实体检索全链同源）；
   会话持久化到 localStorage['sb.agentchat']（升级/重启不丢，图片附件除外）；
   每会话独立 busy——多个 Agent 集群可同时跑。
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

  /* ---------- 会话持久化（2026-09-01 用户「发新版历史对话就没了」）----------
     存 localStorage['sb.agentchat']——sb. 前缀自动进版本化存档并升级继承。
     图片 dataUrl 不落盘（体积大且可重传）；busy/flowLive 是运行态不存。 */
  const STORE_KEY = 'sb.agentchat';
  let persistT = null;
  function persist() {
    clearTimeout(persistT);
    persistT = setTimeout(() => {
      try {
        let sessions = AC.sessions.map(s => ({
          id: s.id, title: s.title, histNote: s.histNote || '',
          agents: [...s.agents],
          msgs: s.msgs.slice(-200),
          files: s.files.map(f => f.kind === 'image'
            ? { name: f.name, kind: 'image', content: '', dataUrl: '' }   // 图片重启后需重传
            : { name: f.name, content: f.content, srcPath: f.srcPath || '' }),
          pendingTpl: s.pendingTpl || null,
        }));
        let json = JSON.stringify({ seq: AC.seq, cur: AC.cur, sessions });
        while (json.length > 2500000 && sessions.length > 1) {   // 总量治理：超 2.5MB 丢最旧会话
          sessions = sessions.slice(0, -1);
          json = JSON.stringify({ seq: AC.seq, cur: AC.cur, sessions });
        }
        localStorage.setItem(STORE_KEY, json);
      } catch (e) {}
    }, 600);
  }
  function restore() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (!raw) return false;
      const o = JSON.parse(raw);
      if (!o || !Array.isArray(o.sessions) || !o.sessions.length) return false;
      AC.seq = o.seq || (o.sessions.length + 1);
      AC.sessions = o.sessions.map(s => ({
        id: s.id, title: s.title, histNote: s.histNote || '',
        agents: new Set(s.agents || []),
        msgs: (s.msgs || []).filter(m => m && m.role),
        files: (s.files || []).filter(f => f && !f.kind),      // 图片附件失效丢弃
        pendingTpl: s.pendingTpl || null,
        busy: false, flowLive: [],
      }));
      AC.cur = AC.sessions.some(x => x.id === o.cur) ? o.cur : AC.sessions[0].id;
      return true;
    } catch (e) { return false; }
  }

  // ---------- 会话管理 ----------
  function newSession() {
    const s = { id: 'S' + (AC.seq++), title: '对话 ' + (AC.seq - 1), msgs: [], busy: false, agents: new Set(), files: [], flowLive: [], histNote: '' };
    AC.sessions.unshift(s);
    AC.cur = s.id;
    renderAll();
    persist();
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

  // ---------- 上传文档（📎 对话框与拖拽共用入列） ----------
  function addFileRecord(s, r) {
    if (!r || r.canceled) return false;
    if (r.error) { toastSafe('上传失败：' + r.error); return false; }
    if (r.kind === 'image') {
      s.files.push({ name: r.name, kind: 'image', dataUrl: r.dataUrl, content: '' });
      s.msgs.push({ role: 'sys', content: '🖼 已附加图片「' + r.name + '」——发送提问时先由当前模型识图转述（需多模态模型，如 deepseek v4-pro），转述文本供全体专家引用。' });
    } else {
      s.files.push({ name: r.name, content: r.content, srcPath: r.srcPath || '' });
      const pptHint = /\.pptx$/i.test(r.name) ? ' 想把它做成可刷新的数据模板？直接说「把这个PPT做成模板」。' : '';
      s.msgs.push({ role: 'sys', content: '📎 已附加文档「' + r.name + '」（' + Math.round(r.content.length / 1000) + 'K 字符' + (r.truncated ? '，超长已截断' : '') + '）——本会话后续提问都能引用它。' + pptHint });
    }
    renderChat(); renderTopbar();
    persist();
    return true;
  }
  async function uploadDoc() {
    const s = curS() || newSession();
    try {
      const r = await window.sb.readLocalDoc();
      addFileRecord(s, r);
    } catch (e) { toastSafe('上传失败：' + String((e && e.message) || e)); }
  }
  // 拖拽进来的 FileList → 逐个经 webUtils 取路径 → 主进程解析（与 📎 同一条链）
  async function addDroppedFiles(fileList) {
    const s = curS() || newSession();
    let okN = 0;
    for (const f of fileList) {
      try {
        const p = window.sb.pathForFile ? window.sb.pathForFile(f) : '';
        if (!p) { toastSafe('取不到文件路径：' + (f.name || '')); continue; }
        const r = await window.sb.readDocByPath(p);
        if (addFileRecord(s, r)) okN++;
      } catch (e) { toastSafe('上传失败：' + String((e && e.message) || e)); }
    }
    return okN;
  }
  function toastSafe(t) { try { typeof toast === 'function' ? toast(t, 'err') : alert(t); } catch (e) {} }

  // Agent 总控分工逻辑在 chat-context-core.js（双端同源，连通性测试跑同一份）
  function masterPlan(q, files) { return window.ChatCtx && window.ChatCtx.masterPlan ? window.ChatCtx.masterPlan(q, files) : null; }

  /* ---------- PPT 模板流程拦截（2026-09-01）：学习/答疑/保存/刷新/列表 ----------
     命中即整段接管（不走 orchestrate），过程事件进 flowLive 全程可视。 */
  async function tplIntercept(s, q, sid) {
    const flow = (t) => { const ss = AC.sessions.find(x => x.id === sid); if (ss) { ss.flowLive.push(t); if (AC.cur === sid) renderChat(); } };
    const sys = (t) => { const ss = AC.sessions.find(x => x.id === sid); if (ss) { ss.msgs.push({ role: 'sys', content: t }); if (AC.cur === sid) renderChat(); } };
    const fileCard = (p) => { const ss = AC.sessions.find(x => x.id === sid); if (ss) { ss.msgs.push({ role: 'file', file: p }); if (AC.cur === sid) renderChat(); } };
    const done = () => { const ss = AC.sessions.find(x => x.id === sid); if (ss) { ss.busy = false; ss.flowLive = []; } renderAll(); persist(); };
    const deps = () => window.AIPanel.makeOrchDeps(cfg(), () => {});

    // —— 会话里有待答疑的模板：本条消息按「答疑/保存/取消」处理 ——
    if (s.pendingTpl) {
      try {
        const save = q.match(/(?:保存|存成?|确认)(?:为|成)?模板[：:，,\s]*([^\s，。,]{0,30})/);
        if (save || /^(保存|确认|就这样|可以|OK|ok)$/.test(q.trim())) {
          const name = (save && save[1]) || s.pendingTpl.srcName.replace(/\.pptx$/i, '');
          const r = await window.sb.pptTplSave(name, s.pendingTpl.srcPath, s.pendingTpl.bindings);
          if (r && r.ok) { sys('💾 模板「' + r.name + '」已保存（' + s.pendingTpl.bindings.filter(b => b.kind === 'data').length + ' 个数据字段）。以后说「用模板 ' + r.name + ' 刷新」即可一键出最新数据的 PPT。'); s.pendingTpl = null; }
          else sys('⚠ 保存失败：' + ((r && r.error) || '未知错误'));
          return done(), true;
        }
        if (/^(取消|算了|不要了|不弄了)/.test(q.trim())) { s.pendingTpl = null; sys('已取消模板制作。'); return done(), true; }
        // 其余一律当答疑 → 精修绑定
        flow('🔧 合并你的口径说明…');
        const r2 = await window.PptTpl.refine(deps(), s.pendingTpl.bindings, q, flow);
        if (r2.error) { sys('⚠ ' + r2.error); return done(), true; }
        s.pendingTpl.bindings = r2.bindings;
        s.pendingTpl.questions = r2.bindings.filter(b => b.kind === 'data' && b.confidence === 'low' && b.question);
        sys(window.PptTpl.report(s.pendingTpl.bindings, s.pendingTpl.questions));
        return done(), true;
      } catch (e) { sys('⚠ 出错：' + String((e && e.message) || e)); return done(), true; }
    }

    // —— 学习：把上传的 PPT 做成模板 ——
    if (/(做成|变成|学成|生成|建)[个一]?.{0,3}模板|学习?这个PPT|按(照)?这个PPT.{0,8}(格式|模板)/i.test(q)) {
      const f = [...s.files].reverse().find(x => /\.pptx$/i.test(x.name) && x.srcPath);
      if (!f) { sys('要先 📎 上传（或拖入）一个 .pptx 文件我才能学它。'); return done(), true; }
      try {
        flow('📂 读取 ' + f.name + ' …');
        const st = await window.sb.pptStructure(f.srcPath);
        if (!st || st.error) { sys('⚠ 解析失败：' + ((st && st.error) || '未知') + '（若文件已移动请重新上传）'); return done(), true; }
        const r = await window.PptTpl.learn(deps(), st, flow);
        if (r.error) { sys('⚠ ' + r.error); return done(), true; }
        s.pendingTpl = { srcPath: f.srcPath, srcName: f.name, bindings: r.bindings, questions: r.questions };
        sys(window.PptTpl.report(r.bindings, r.questions));
      } catch (e) { sys('⚠ 出错：' + String((e && e.message) || e)); }
      return done(), true;
    }

    // —— 刷新：用模板出最新数据 PPT ——
    if (/(用|套).{0,10}模板|模板.{0,4}(刷新|更新|出|生成)|刷新.{0,6}模板/.test(q)) {
      try {
        const list = await window.sb.pptTplList();
        if (!list || !list.length) { sys('还没有保存过模板。先上传一个 PPT 说「把这个PPT做成模板」。'); return done(), true; }
        let tpl = list.find(t => q.indexOf(t.name) >= 0);
        if (!tpl && list.length === 1) tpl = list[0];
        if (!tpl) { sys('有多个模板，请指名用哪个：\n' + list.map(t => '· ' + t.name + '（' + t.fields + ' 个字段，' + t.createdAt + '）').join('\n')); return done(), true; }
        const meta = await window.sb.pptTplGet(tpl.id);
        if (!meta || meta.error) { sys('⚠ ' + ((meta && meta.error) || '模板读取失败')); return done(), true; }
        const rr = await window.PptTpl.refresh(deps, meta, flow);
        if (rr.error) { sys('⚠ ' + rr.error); return done(), true; }
        flow('📝 原位替换文本并重打包（版式不动）…');
        const out = await window.sb.pptTplApply(tpl.id, rr.repls, tpl.name + '_' + new Date().toISOString().slice(0, 10));
        if (out && out.ok) { sys('✅ 模板「' + tpl.name + '」已按最新数据刷新（' + rr.repls.length + ' 处更新）。'); fileCard(out.path); }
        else sys('⚠ 生成失败：' + ((out && out.error) || '未知'));
      } catch (e) { sys('⚠ 出错：' + String((e && e.message) || e)); }
      return done(), true;
    }

    // —— 列表 ——
    if (/(有哪些|列出|查看|看看).{0,4}模板|模板列表/.test(q)) {
      const list = await window.sb.pptTplList();
      sys(list && list.length ? ('📋 已保存的模板：\n' + list.map(t => '· ' + t.name + '（' + t.fields + ' 个数据字段，' + t.createdAt + '，源：' + t.srcName + '）').join('\n') + '\n说「用模板 名字 刷新」即可出最新 PPT。') : '还没有模板。上传一个 PPT 说「把这个PPT做成模板」即可创建。');
      return done(), true;
    }
    return false;
  }

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
    // 会话记忆：在当前问题入列前构建历史（近轮全文+旧轮自动压缩，见 chat-context-core.js）
    const hist = window.ChatCtx ? window.ChatCtx.buildHistory(s) : '';
    s.msgs.push({ role: 'user', content: q });
    s.busy = true; s.flowLive = [];
    renderAll();
    // PPT 模板流程（学习/答疑/保存/刷新/列表）命中即整段接管
    try { if (await tplIntercept(s, q, s.id)) return; } catch (e) {}

    // 组装完整问题：文档前缀 + 会话历史 + 当前问题（专家与综合器都可见；实体检索照常工作）
    let fullQ = hist ? hist + '【当前问题】' + q : q;
    if (s.files.length) {
      const docs = s.files.map(f => '【用户上传文档：' + f.name + '】\n' + f.content).join('\n\n');
      fullQ = docs.slice(0, 80000) + '\n\n' + hist + '【当前问题】' + q;
    }
    const force = s.agents.size ? [...s.agents] : null;
    const sid = s.id;
    const onProg = e => {
      try { window.AgentBoard && window.AgentBoard.feed(e); } catch (e2) {}
      const ss = AC.sessions.find(x => x.id === sid); if (!ss) return;
      if (e.type === 'toolDone' && e.file) {
        // AI 产出了文件 → 立即在对话里落一张文件卡片（可打开/定位）
        ss.msgs.push({ role: 'file', file: e.file });
        if (AC.cur === sid) renderChat();
      }
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
      // 图片附件：先经当前模型识图转述成文本（缓存进 f.content，同图不重复转述），主链保持纯文本
      for (const f of s.files) {
        if (f.kind !== 'image' || f.content) continue;
        const ss0 = AC.sessions.find(x => x.id === sid);
        if (ss0) { ss0.flowLive.push('🖼 识图转述「' + f.name + '」…'); if (AC.cur === sid) renderChat(); }
        const vr = await deps.chat({
          system: '你是图片转述员：把图片里的全部信息如实转成文本供数据分析——表格逐格转写(markdown表格)，数字精确抄录，文字全文抄录，图表说明坐标轴/系列/数量级与趋势。不要评论，不要遗漏数字。',
          messages: [{ role: 'user', content: [
            { type: 'text', text: '请完整转述这张图片的内容：' },
            { type: 'image_url', image_url: { url: f.dataUrl } },
          ] }],
          maxTokens: 2000,
        });
        if (vr && !vr.error && String(vr.content || '').trim()) f.content = '（以下为图片「' + f.name + '」的AI转述）\n' + vr.content;
        else f.content = '（图片「' + f.name + '」转述失败：' + ((vr && vr.error) || '当前模型可能不支持图片输入，请切换多模态模型后重传') + '）';
      }
      // 文档重组装（图片转述后 content 才就位）
      if (s.files.length) {
        const docs2 = s.files.map(f => '【用户上传文档：' + f.name + '】\n' + f.content).join('\n\n');
        fullQ = docs2.slice(0, 80000) + '\n\n' + hist + '【当前问题】' + q;
      }
      // 总控分工：未手选专家且材料可拆（多 sheet/多文档）→ 并行派工；材料已拆进各任务，主问题不再重复注入全量文档
      let forceTasks = null, orchQ = fullQ;
      if (!force) {
        const plan = masterPlan(q, s.files);
        if (plan) {
          forceTasks = plan.tasks;
          orchQ = (hist || '') + '【当前问题】' + q;
          const ss1 = AC.sessions.find(x => x.id === sid);
          if (ss1) { ss1.flowLive.push('🧠 总控：' + plan.note); if (AC.cur === sid) renderChat(); }
        }
      }
      try { window.AgentBoard && window.AgentBoard.feed({ type: 'ask', q }); } catch (e) {}
      const out = await window.AIOrch.orchestrate(orchQ, null, deps, { mode: forceTasks ? 'deep' : (force && force.length > 1 ? 'deep' : 'fast'), forceAgents: force, forceTasks });
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
      persist();
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
          '<span class="ac-sess-t">' + (s.busy ? '<span class="ac-spin"></span>' : '💬 ') + esc(s.title) +
          (s.files.length ? ' 📎' + s.files.length : '') + '</span>' +
          '<span class="ac-del" data-del="' + s.id + '" title="删除该会话（含全部历史）">✕</span>' +
        '</div>').join('');
    el.querySelector('#acNew').onclick = newSession;
    el.querySelectorAll('.ac-sess').forEach(n => { n.onclick = () => { AC.cur = n.getAttribute('data-sid'); renderAll(); persist(); }; });
    el.querySelectorAll('.ac-del').forEach(n => {
      n.onclick = (ev) => {
        ev.stopPropagation();                       // 别触发会话切换
        const id = n.getAttribute('data-del');
        const s2 = AC.sessions.find(x => x.id === id); if (!s2) return;
        if (s2.busy) { toastSafe('该会话正在运行，等它结束再删'); return; }
        if (!confirm('删除会话「' + s2.title + '」？其全部历史与附件将一并删除，不可恢复。')) return;
        AC.sessions = AC.sessions.filter(x => x.id !== id);
        if (AC.cur === id) AC.cur = AC.sessions.length ? AC.sessions[0].id : null;
        if (!AC.sessions.length) { newSession(); return; }   // newSession 里已 renderAll+persist
        renderAll(); persist();
      };
    });
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
      (s && window.ChatCtx ? (function () {
        const p = window.ChatCtx.ctxPct(s);
        const col = p > 80 ? '#C7000B' : p > 50 ? '#E0A400' : '#1E9E57';
        return '<span class="ac-ctx" title="会话上下文用量：满后旧对话自动压缩成摘要，不会失忆">' +
          '<i style="width:' + p + '%;background:' + col + '"></i><b>' + p + '%</b></span>';
      })() : '') +
      '<button class="btn ghost" id="acDoc" title="上传本地文档(txt/md/csv/json/xlsx/pptx/docx，也可传 png/jpg 图片)">📎 附件</button>' +
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
    let h = s.msgs.map((m, mi) => {
      if (m.role === 'user') return '<div class="ac-b u">' + esc(m.content) + '</div>';
      if (m.role === 'sys') return '<div class="ac-b s">' + esc(m.content) + '</div>';
      if (m.role === 'file') {
        const base = String(m.file || '').split(/[\\/]/).pop();
        return '<div class="ac-b f" data-mi="' + mi + '"><span class="ac-fico">' + (/\.pptx?$/i.test(base) ? '📊' : /\.xlsx?$/i.test(base) ? '📗' : '📄') + '</span>' +
          '<span class="ac-fname" title="' + esc(m.file) + '">' + esc(base) + '</span>' +
          '<button class="btn ghost ac-fopen">打开</button><button class="btn ghost ac-freveal">所在文件夹</button></div>';
      }
      const flow = (m.flow && m.flow.length) ? ('<details class="ac-flow"><summary>🛠 执行过程（' + m.flow.length + ' 步）</summary><div>' + m.flow.map(esc).join('<br>') + '</div></details>') : '';
      return '<div class="ac-b a">' + flow + md(m.content) + '</div>';
    }).join('');
    if (s.busy) {
      h += '<div class="ac-b a ac-live"><div class="ac-flowlive">' + (s.flowLive.length ? s.flowLive.map(esc).join('<br>') : '正在规划…') + '</div></div>';
    }
    el.innerHTML = h || '<div class="ac-empty">选好专家（或用自动路由）直接提问。<br>可 📎 上传文档、让我出 PPT / Excel、多开会话并行跑。</div>';
    el.querySelectorAll('.ac-b.f').forEach(n => {
      const m = s.msgs[+n.getAttribute('data-mi')]; if (!m) return;
      const open = n.querySelector('.ac-fopen'), rev = n.querySelector('.ac-freveal');
      if (open) open.onclick = () => { try { window.sb.openPathAbs(m.file); } catch (e) {} };
      if (rev) rev.onclick = () => { try { window.sb.revealPath(m.file); } catch (e) {} };
    });
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
          '<div class="ac-input"><textarea id="acInput" rows="2" placeholder="问数据、要分析、让我出 PPT/Excel……可把 Excel/PPT/文档直接拖进来；Ctrl+Enter 发送"></textarea>' +
          '<button class="btn primary" id="acSend">发送</button></div>' +
        '</div>' +
      '</div>';
    document.getElementById('acSend').onclick = send;
    document.getElementById('acInput').addEventListener('keydown', e => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); send(); }
    });
    /* ---- 拖拽上传（2026-09-01 用户实锤「拖不进去，弹空白对话框」）----
       空白窗的病根：Electron 对拖入文件的默认行为是导航到 file://。
       两层修复：①window 级全局 preventDefault 兜底（任何视图拖入都不再弹窗）
                ②本视图内真接收：松手即走 📎 同一条解析链 */
    if (!window.__sbDropGuard) {
      window.__sbDropGuard = true;
      window.addEventListener('dragover', e => { e.preventDefault(); }, false);
      window.addEventListener('drop', e => {
        e.preventDefault();
        if (!e.dataTransfer || !e.dataTransfer.files || !e.dataTransfer.files.length) return;
        const inView = e.target && e.target.closest && e.target.closest('#view-agentchat');
        if (!inView) { try { typeof toast === 'function' && toast('文件请拖到「Agent 对话」看板里给 AI 阅读', 'err'); } catch (e2) {} }
      }, false);
    }
    root.addEventListener('dragover', e => {
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
      root.classList.add('ac-dropping');
    });
    root.addEventListener('dragleave', e => { if (!root.contains(e.relatedTarget)) root.classList.remove('ac-dropping'); });
    root.addEventListener('drop', async e => {
      e.preventDefault();
      root.classList.remove('ac-dropping');
      if (!e.dataTransfer || !e.dataTransfer.files || !e.dataTransfer.files.length) return;
      const n = await addDroppedFiles(e.dataTransfer.files);
      if (n) { try { typeof toast === 'function' && toast('已附加 ' + n + ' 个文件', 'ok'); } catch (e2) {} }
    });
    const css = document.createElement('style');
    css.textContent =
      '.ac-wrap{display:flex;height:100%;min-height:0}' +
      '.ac-left{width:220px;flex:none;border-right:1px solid var(--line);padding:12px;overflow-y:auto}' +
      '.ac-sess{display:flex;align-items:center;gap:4px;padding:8px 10px;border-radius:8px;font-size:12px;cursor:pointer;margin-bottom:4px;border:1px solid transparent}' +
      '.ac-sess-t{flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' +
      '.ac-del{flex:none;width:18px;height:18px;line-height:18px;text-align:center;border-radius:5px;color:var(--ink3);opacity:0;font-size:11px}' +
      '.ac-sess:hover .ac-del{opacity:.75}' +
      '.ac-del:hover{background:#C7000B18;color:#C7000B;opacity:1}' +
      '.ac-sess:hover{background:var(--panel)}' +
      '.ac-sess.active{border-color:#C7000B55;background:var(--panel)}' +
      '.ac-spin{display:inline-block;width:10px;height:10px;border:2px solid #C7000B;border-top-color:transparent;border-radius:50%;animation:acspin 1s linear infinite;margin-right:5px;vertical-align:-1px}' +
      '@keyframes acspin{to{transform:rotate(360deg)}}' +
      '.ac-main{flex:1;display:flex;flex-direction:column;min-width:0}' +
      '.ac-top{display:flex;align-items:center;gap:8px;padding:10px 14px;border-bottom:1px solid var(--line);flex-wrap:wrap}' +
      '.ac-top select{padding:5px 8px;border:1px solid var(--line);border-radius:8px;background:var(--c-bg-elev);color:inherit;font-size:12px;max-width:230px}' +
      '.ac-ctx{position:relative;display:inline-flex;align-items:center;justify-content:center;min-width:74px;height:18px;border:1px solid var(--line);border-radius:9px;overflow:hidden;font-size:10px}' +
      '.ac-ctx i{position:absolute;left:0;top:0;bottom:0;opacity:.22}' +
      '.ac-ctx b{position:relative;font-weight:600;color:var(--ink2);padding:0 6px}' +
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
      '.ac-input textarea{flex:1;resize:none;padding:9px 12px;border:1px solid var(--line);border-radius:10px;background:var(--c-bg-elev);color:inherit;font-size:13px;font-family:inherit}' +
      '.ac-b.f{align-self:flex-start;display:flex;align-items:center;gap:8px;background:var(--panel);border:1px solid var(--line);padding:8px 12px}' +
      '.ac-fico{font-size:20px}' +
      '.ac-fname{font-size:12px;font-weight:600;max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
      '.ac-b.f .btn{font-size:11px;padding:3px 8px}' +
      '#view-agentchat{position:relative}' +
      '#view-agentchat.ac-dropping::after{content:"📎 松手把文件交给 AI 阅读（xlsx / pptx / docx / txt / 图片）";position:absolute;inset:8px;display:flex;align-items:center;justify-content:center;border:2px dashed #C7000B;border-radius:14px;background:var(--c-bg-elev);opacity:.96;font-size:15px;color:#C7000B;z-index:30;pointer-events:none}';
    document.head.appendChild(css);
    if (!restore()) newSession();
  }

  window.renderAgentChat = function () { build(); renderAll(); };
})();

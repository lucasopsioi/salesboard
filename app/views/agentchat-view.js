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
          msgs: s.msgs.filter(m => m.role !== 'approve').slice(-200),
          files: s.files.map(f => f.kind === 'image'
            ? { name: f.name, kind: 'image', content: '', dataUrl: '' }   // 图片重启后需重传
            : { name: f.name, content: f.content, srcPath: f.srcPath || '', docId: f.docId || '', totalLines: f.totalLines || 0, kind: f.kind || undefined, imagesDone: f.imagesDone || false }),   // 内嵌图 dataUrl 不落盘（大；转述已并入 content）
          pendingTpl: null,   // 转换半成品含整个 doc(可能内嵌图片 dataUrl),不落盘——重启后重新转换即可
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
      s.msgs.push({ role: 'sys', content: '🖼 已附加图片「' + r.name + '」——发送提问时自动用视觉模型识图转述（DeepSeek 会自动切到视觉模型，无需手动换；也支持 Claude / GPT），转述文本供全体专家引用。' });
    } else {
      const embN = (r.embeddedImages && r.embeddedImages.length) || 0;
      s.files.push({ name: r.name, content: r.content, srcPath: r.srcPath || '', docId: r.docId || '', totalLines: r.totalLines || 0, size: r.size || 0, summary: r.summary || '', embeddedImages: r.embeddedImages || null, kind: r.kind || undefined });
      const pptHint = /\.pptx$/i.test(r.name) ? ' 想把它做成可刷新的数据模板？直接说「把这个PPT做成模板」。' : '';
      const big = r.kind === 'table' ? '（' + (r.totalLines || 0) + ' 行 × 表；AI 用大表工具直接算，不受行数限制）'
        : r.truncated ? '（' + (r.totalLines || 0) + ' 行全文已建索引，AI 会按需搜索/读取，不受长度限制）' : '（' + Math.round((r.content || '').length / 1000) + 'K 字符）';
      const embHint = embN ? ' 含 ' + embN + ' 张内嵌图，提问时会自动识图并入内容。' : '';
      s.msgs.push({ role: 'sys', content: '📎 已附加「' + r.name + '」' + big + (r.summary ? ' 结构：' + r.summary.slice(0, 160) : '') + '——本会话后续提问都能引用它。' + pptHint + embHint });
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
  // 文档注入块：大文件只带开头 + docId 标注（全文在主进程索引，模型用 docSearch/docSlice 读其余）
  function docBlock(f) {
    const head = '【用户上传文档：' + f.name + (f.docId ? '  docId=' + f.docId + '  全文 ' + (f.totalLines || '?') + ' 行' + (f.srcPath ? '  路径=' + f.srcPath : '') + (f.summary ? '  结构：' + f.summary.slice(0, 200) : '') : '') + '】';
    const body = String(f.content || '');
    // 大文件只注入极小开头——否则模型会拿开头当全文，查不到就说「没有」、求和就拿开头几行凑（实测 S3/S6）
    const big = !!(f.docId && f.totalLines && (f.totalLines > 3000 || body.length >= 60000));
    const shown = big ? body.slice(0, 3000) : body;
    const tail = big ? '\n…（以上只是开头极小一部分，全文 ' + f.totalLines + ' 行已建索引。**查找/定位某内容必须调 docSearch({docId:"' + f.docId + '",q:"关键词"})**；读某段用 docSlice；**对整份文件求和/计数/统计/汇总，必须用 runCode(lang:"node") 读「路径=」后面的原文件计算**（脚本可 require("xlsx")）。严禁只凭这段开头就回答「没有/未找到」或给出任何合计数。）' : '';
    return head + '\n' + shown + tail;
  }
  /* ---------- 本机写操作审批闸（Claude Code 式）：写文件/改Excel/改PPT/跑脚本前弹卡片，用户点允许才执行 ---------- */
  const APPROVE_LABEL = { fsWrite: '写入文件', excelEdit: '修改 Excel', pptEdit: '修改 PPT', runCode: '运行脚本' };
  function describeOp(tool, a) {
    a = a || {};
    if (tool === 'excelEdit') return (a.path || '') + '\n' + (a.ops || []).slice(0, 12).map(o => '· ' + o.op + ' ' + (o.sheet ? o.sheet + '!' : '') + (o.cell || o.origin || '') + (o.value != null ? ' = ' + String(o.value).slice(0, 60) : '') + (o.rows ? ' (' + o.rows.length + ' 行)' : '')).join('\n') + ((a.ops || []).length > 12 ? '\n· …共 ' + a.ops.length + ' 步' : '');
    if (tool === 'pptEdit') return (a.path || '') + '\n' + (a.replace || []).slice(0, 12).map(r => '· 「' + String(r.find).slice(0, 40) + '」→「' + String(r.replace == null ? '' : r.replace).slice(0, 40) + '」').join('\n');
    if (tool === 'fsWrite') return (a.path || '') + '\n（' + String(a.content || '').length + ' 字符）\n' + String(a.content || '').slice(0, 400);
    if (tool === 'runCode') return (a.lang || 'node') + ' @ ' + (a.cwd || '工作区') + '\n' + String(a.code || '').slice(0, 900);
    return JSON.stringify(a).slice(0, 400);
  }
  window.AgentApprove = function (tool, args) {
    const s = curS(); if (!s) return Promise.resolve(false);
    if (s.autoAllow) { s.msgs.push({ role: 'sys', content: '⚡ 已按「本会话全部允许」自动执行：' + (APPROVE_LABEL[tool] || tool) + ' ' + String((args && args.path) || '') }); renderChat(); return Promise.resolve(true); }
    return new Promise(resolve => {
      s.msgs.push({ role: 'approve', tool, args, desc: describeOp(tool, args), resolve, decided: '' });
      renderChat();
      try { toast && toast('Agent 请求' + (APPROVE_LABEL[tool] || tool) + '，请在对话里确认', 'ok'); } catch (e) {}
    });
  };
  function decideApprove(m, val, allSession) {
    if (m.decided) return;
    m.decided = val ? (allSession ? 'all' : 'yes') : 'no';
    const s = curS(); if (allSession && s) s.autoAllow = true;
    try { m.resolve(!!val); } catch (e) {}
    renderChat();
  }
  async function pickWorkspace() {
    try {
      const cur = await window.sb.wsGet();
      const dirs = (cur && cur.dirs) || [];
      const r = await window.sb.wsPick();
      const now = (r && r.dirs) || dirs;
      const s = curS() || newSession();
      s.msgs.push({ role: 'sys', content: '📁 工作区（Agent 允许读写的文件夹）：\n' + (now.length ? now.map(d => '· ' + d).join('\n') : '（空）') + '\n现在可以说「把 工作区里的 xxx.xlsx 的 B2 改成 199」这类话；每次写入前会弹卡片让你确认。' });
      renderChat();
    } catch (e) { toastSafe('工作区设置失败：' + String((e && e.message) || e)); }
  }

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

    // —— 会话里有待收尾的转换：本条消息按「保存/答疑/取消」处理 ——
    if (s.pendingTpl && s.pendingTpl.conv) {
      try {
        const save = q.match(/(?:保存|存成?|确认)(?:为|成)?模板[：:，,\s]*([^\s，。,]{0,30})/);
        if (save || /^(保存|确认|就这样|可以|OK|ok)$/.test(q.trim())) {
          const conv = s.pendingTpl.conv;
          const name = (save && save[1]) || s.pendingTpl.srcName.replace(/\.pptx$/i, '');
          conv.doc.name = name;
          window.PptStore.saveTemplate(window.localStorage, conv.doc);
          sys('💾 模板「' + name + '」已存入 PPT output 看板（' + conv.stats.dataBindings + ' 个活数据框）。去 PPT output 点「打开」即可见——数据自动最新，可视编辑，导出 PPTX。' + (conv.questions.length ? '（' + conv.questions.length + ' 处待确认口径未绑定，可在设计器里选中元素手动绑数据源）' : ''));
          s.pendingTpl = null;
          return done(), true;
        }
        if (/^(取消|算了|不要了|不弄了)/.test(q.trim())) { s.pendingTpl = null; sys('已取消。'); return done(), true; }
        // 其余当答疑：把回答交回数据识别 Agent 修正绑定
        flow('🔧 按你的口径说明修正绑定…');
        const conv = s.pendingTpl.conv;
        const resp = await deps().chat({
          system: '你是数据绑定分析师。下面是转换时拿不准的问题清单（含当时的候选绑定）与用户的解答。按解答给出每个问题的最终处理，只输出 JSON 数组：[{"idx":0,"apply":true,"binding":{"dataset":"psi","measure":"sellOut","filters":{...}}} 或 {"idx":1,"apply":false}]（apply:false=保持静态文字）。',
          messages: [{ role: 'user', content: '【问题清单】\n' + conv.questions.map((x, i) => i + '. 第' + x.page + '页「' + x.text + '」：' + x.question + (x.binding ? ('（候选：' + JSON.stringify(x.binding) + '）') : '')).join('\n') + '\n\n【用户解答】\n' + q }],
          tools: [], maxTokens: 2000,
        });
        const arr = (window.PptConvert.pickJson((resp && resp.content) || '') || []);
        let applied = 0;
        for (const a of (Array.isArray(arr) ? arr : [])) {
          const qi = conv.questions[a.idx];
          if (!qi || !a.apply || !a.binding) continue;
          const okB = await window.PptConvert.verifyBinding(deps(), a.binding);
          if (!okB) continue;
          // 按 page+文本前缀找回元素转 data
          const sl = conv.doc.slides[qi.page - 1];
          const tEl = sl && sl.elements.find(e => e.type === 'text' && String(e.text || '').indexOf(qi.text.slice(0, 10)) === 0);
          if (!tEl) continue;
          const stl = tEl.style || {};
          window.PptDoc.removeElement(conv.doc, qi.page - 1, tEl.id);
          window.PptDoc.addElement(conv.doc, qi.page - 1, window.PptDoc.newElement('data', {
            x: tEl.x, y: tEl.y, w: tEl.w, h: tEl.h,
            style: { fontSize: stl.fontSize || 18, bold: !!stl.bold, color: stl.color || '1A1A1A', align: stl.align || 'center' },
            binding: a.binding,
          }));
          conv.stats.dataBindings++; applied++;
        }
        conv.questions = conv.questions.filter((x, i) => !(arr.find(a => a.idx === i && (a.apply === false || (a.apply && a.binding)))));
        sys('已按解答处理 ' + applied + ' 处绑定。\n\n' + window.PptConvert.report(conv));
        return done(), true;
      } catch (e) { sys('⚠ 出错：' + String((e && e.message) || e)); return done(), true; }
    }

    // —— 转换：把上传的 PPT 转成设计器工程（模板化+数据化） ——
    if (/(做成|变成|学成|生成|建|转成?)[个一]?.{0,3}(模板|看板)|学习?这个PPT|按(照)?这个PPT.{0,8}(格式|模板)/i.test(q)) {
      const f = [...s.files].reverse().find(x => /\.pptx$/i.test(x.name) && x.srcPath);
      if (!f) { sys('要先 📎 上传（或拖入）一个 .pptx 文件。'); return done(), true; }
      try {
        flow('📂 读取 ' + f.name + ' …');
        const st = await window.sb.pptStructure(f.srcPath);
        if (!st || st.error) { sys('⚠ 解析失败：' + ((st && st.error) || '未知') + '（若文件已移动请重新上传）'); return done(), true; }
        const conv = await window.PptConvert.convert(deps(), st, { name: f.name.replace(/\.pptx$/i, ''), onFlow: flow });
        s.pendingTpl = { conv, srcName: f.name };
        sys(window.PptConvert.report(conv));
      } catch (e) { sys('⚠ 出错：' + String((e && e.message) || e)); }
      return done(), true;
    }

    // —— 列表 / 刷新指路（模板已入设计器：数据天生自动最新，无需对话式刷新） ——
    if (/(有哪些|列出|查看|看看).{0,4}模板|模板列表|(用|套).{0,10}模板|模板.{0,4}(刷新|更新|出|生成)|刷新.{0,6}模板/.test(q)) {
      try {
        const list = (window.PptStore && window.PptStore.listTemplates(window.localStorage)) || [];
        sys(list.length
          ? ('📋 PPT output 看板里的模板：\n' + list.map(t => '· ' + t.name).join('\n') + '\n模板里的数据框接的是实时接口——去 PPT output 看板「打开」即是最新数据，直接「导出 PPTX」就是刷新后的成品，不需要单独的刷新操作。')
          : '还没有模板。上传一个 PPT 说「把这个PPT做成模板」即可转换进 PPT output 看板。');
      } catch (e) { sys('⚠ ' + String((e && e.message) || e)); }
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
      const docs = s.files.map(docBlock).join('\n\n');
      fullQ = docs.slice(0, 120000) + '\n\n' + hist + '【当前问题】' + q;
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
      const label = e.type === 'understand' ? ('🧠 结合上文理解为：' + e.to)
        : e.type === 'planner' ? ('🧭 规划 ' + (e.tasks || []).length + ' 个子任务：' + (e.tasks || []).map(t => t.agent + (t.label ? '·' + t.label : '')).join(' / '))
        : e.type === 'plan' ? ('🧭 路由：' + (e.tasks || []).join(' → '))
        : e.type === 'agentStart' ? ('🤖 ' + e.agent + ' 分析中…')
        : e.type === 'tool' ? ('　🔧 ' + e.tool)
        : e.type === 'toolDone' ? null
        : e.type === 'agentDone' ? ('🤖 ' + e.agent + ' ✓')
        : e.type === 'synth' ? '🧩 综合结论…'
        : e.type === 'prerank' ? ('📐 代码预排名：' + e.by + e.order + '，第 1 名 ' + e.top + '（' + e.value + ' ' + e.unit + '）')
        : e.type === 'prediag' ? ('📐 代码预诊断：' + (e.counts || []).join('，'))
        : e.type === 'preest' ? ('📐 代码预估：' + e.product + (e.countries.length ? ' → ' + e.countries.join('/') : ' 未进入国家排名') + (e.top ? '，' + e.top.国家 + ' 中位 ' + e.top.中位 + ' 台（' + e.top.区间低 + '–' + e.top.区间高 + '）' : ''))
        : e.type === 'preoutlook' ? ('📐 代码前瞻：未来 ' + e.weeks + ' 周' + (e.top ? '，第 1 名 ' + e.top.name + ' 中性 ' + e.top.中性 + ' 台' : '') + (e.dosTarget ? '，DOS 目标 ' + e.dosTarget + ' 天' : ''))
        : e.type === 'precmp' ? ('📐 代码预对比：' + e.names.join(' vs '))
        : e.type === 'verify' ? (e.pinned ? '🛡 模型改后仍不一致，已把代码排名钉在答案最前面 → ' + e.expected : e.ok ? (e.fixed ? '🛡 结论已按代码排名改正 → ' + e.expected : '🛡 结论核对通过') : '🛡 结论与代码排名不一致，要求模型改正…') : null;
      if (label) { ss.flowLive.push(label); if (ss.flowLive.length > 40) ss.flowLive.shift(); }
      if (AC.cur === sid) renderChat();
    };
    try {
      const deps = window.AIPanel.makeOrchDeps(c, onProg);
      // 识图：统一走「能看图」的端点（DeepSeek 视觉模型 / 或用户已选的 Claude、GPT），与主对话模型解耦。
      // 直接上传的图片 + PPT/Word 里的内嵌图都转述成文本并入正文；同图缓存不重复转述。
      const visEndp = (deps.visionEndpoint && deps.visionEndpoint()) || null;
      const VIS_SYS = '你是图片转述员：把图片里的全部信息如实转成文本供数据分析——表格逐格转写(markdown表格)，数字精确抄录，文字全文抄录，图表说明坐标轴/系列/数量级与趋势与各数据点数值。不要评论，不要遗漏任何数字。';
      const transcribe = async (dataUrl, label) => {
        if (!visEndp) return { error: '当前没有可用的识图模型：请在设置里填 DeepSeek Key（会自动用其视觉模型），或切换到 Claude / GPT' };
        return deps.chat({ forceEndpoint: visEndp, system: VIS_SYS, maxTokens: 3000,
          messages: [{ role: 'user', content: [{ type: 'text', text: '请完整转述这张图片（' + label + '）的内容：' }, { type: 'image_url', image_url: { url: dataUrl } }] }] });
      };
      const flow0 = (t) => { const ss0 = AC.sessions.find(x => x.id === sid); if (ss0) { ss0.flowLive.push(t); if (AC.cur === sid) renderChat(); } };
      for (const f of s.files) {
        // ① 直接上传的图片
        if (f.kind === 'image' && !f.content) {
          flow0('🖼 识图转述「' + f.name + '」' + (visEndp ? '（' + visEndp.label + '）' : '') + '…');
          const vr = await transcribe(f.dataUrl, f.name);
          f.content = (vr && !vr.error && String(vr.content || '').trim())
            ? '（以下为图片「' + f.name + '」的AI转述）\n' + vr.content
            : '（图片「' + f.name + '」转述失败：' + ((vr && vr.error) || '模型没返回内容，可能不支持图片，请在设置填 DeepSeek Key 或换 Claude/GPT') + '）';
        }
        // ② PPT/Word 内嵌图（上传时抽出，逐张转述后追加到该文档正文，只做一次）
        if (f.embeddedImages && f.embeddedImages.length && !f.imagesDone) {
          const parts = [];
          for (let i = 0; i < f.embeddedImages.length; i++) {
            const im = f.embeddedImages[i];
            flow0('🖼 转述「' + f.name + '」内嵌图 ' + (i + 1) + '/' + f.embeddedImages.length + '…');
            const vr = await transcribe(im.dataUrl, f.name + ' 图' + (i + 1));
            if (vr && !vr.error && String(vr.content || '').trim()) parts.push('［' + f.name + ' 内嵌图' + (i + 1) + '（' + im.name + '）］\n' + vr.content);
          }
          if (parts.length) f.content = String(f.content || '') + '\n\n【本文件内嵌图片的AI转述】\n' + parts.join('\n\n');
          f.imagesDone = true;
        }
      }
      // 文档重组装（图片转述后 content 才就位）
      if (s.files.length) {
        const docs2 = s.files.map(docBlock).join('\n\n');
        fullQ = docs2.slice(0, 120000) + '\n\n' + hist + '【当前问题】' + q;
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
      // 上传文档/图片转述正文进溯源语料——文档里的数字（日期、目标台数等）是合法出处，别被门禁抹成「(未取到)」
      const provCorpus = s.files.length ? s.files.map(f => f.content || '').filter(Boolean).join('\n').slice(0, 200000) : '';
      const out = await window.AIOrch.orchestrate(orchQ, null, deps, { mode: forceTasks ? 'deep' : (force && force.length > 1 ? 'deep' : 'fast'), forceAgents: force, forceTasks, provCorpus });
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
      '<button class="btn ghost" id="acDoc" title="上传本地文档(txt/md/csv/json/xlsx/pptx/docx，也可传 png/jpg 图片)——多大都行，全文建索引">📎 附件</button>' +
      '<button class="btn ghost" id="acWs" title="选择允许 Agent 读写的本机文件夹（工作区）。之后可让它直接修改里面的 Excel/PPT/文本，每次写入前会弹卡片确认">📁 工作区</button>' +
      '<button class="btn ghost" id="acRecv" title="从手机或另一台电脑把文件传到这台电脑（不走会崩的网页上传）——手机扫码即可">📥 接收文件</button>' +
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
    el.querySelector('#acWs').onclick = pickWorkspace;
    el.querySelector('#acBoard').onclick = () => { try { window.AgentBoard && window.AgentBoard.open(); } catch (e) {} };
    el.querySelector('#acRecv').onclick = openReceiver;
  }
  /* ---- 本机接收窗口（2026-09-04 用户：这台电脑网页上传崩溃，要从手机把文件传进来）----
     打开即在本机开一个小服务，显示二维码+链接；手机同 Wi-Fi 扫码上传，文件落到本机并可一键给 Agent。 */
  let recvFiles = [], recvBound = false, recvImported = new Set();
  async function openReceiver() {
    let m = document.getElementById('acRecvModal'); if (m) m.remove();
    m = document.createElement('div'); m.id = 'acRecvModal'; m.className = 'ai-modal';
    m.innerHTML = '<div class="ai-modal-box acr-box"><div class="ai-modal-h">📥 从手机 / 另一台电脑接收文件' +
      '<button class="ai-modal-x" id="acrX">✕</button></div><div class="ai-modal-body acr-body" id="acrBody">正在开启本机接收服务…</div></div>';
    document.body.appendChild(m);
    const close = () => { m.remove(); try { window.sb.recvStop(); } catch (e) {} };
    m.querySelector('#acrX').onclick = close;
    m.onclick = e => { if (e.target === m) close(); };
    if (!recvBound && window.sb.onRecvFile) { recvBound = true; window.sb.onRecvFile((f) => { recvFiles.unshift(f); paintRecvList(); toastSafe2('📥 收到文件：' + f.name); }); }
    let info;
    try { info = await window.sb.recvStart(); } catch (e) { info = { error: String((e && e.message) || e) }; }
    const body = document.getElementById('acrBody'); if (!body) return;
    if (!info || info.error || !info.url) { body.innerHTML = '<div class="acr-err">开启失败：' + esc((info && info.error) || '未知错误') + '<br>若是首次运行，Windows 可能弹防火墙提示，请选“允许访问”。</div>'; return; }
    const ips = (info.ips && info.ips.length) ? info.ips : [info.ip];
    const urlFor = (ip) => 'http://' + ip + ':' + info.port + '/' + info.code;
    const renderFor = (ip) => {
      let qrSvg = ''; const url = urlFor(ip); try { qrSvg = window.QRCore ? window.QRCore.toSvg(url, { scale: 6, quiet: 3 }) : ''; } catch (e) {}
      const alts = ips.filter(x => x !== ip);
      body.innerHTML =
        '<div class="acr-cols">' +
          '<div class="acr-qr">' + (qrSvg || '<div class="acr-err">二维码生成失败，请用下方链接</div>') + '<div class="acr-tip">手机相机对准二维码</div></div>' +
          '<div class="acr-info">' +
            '<div class="acr-step"><b>手机扫上面的码</b>，或在手机浏览器输入下面这行：</div>' +
            '<div class="acr-url" id="acrUrl">' + esc(url.replace(/^https?:\/\//, '')) + '</div>' +
            '<div class="acr-note">取件码 <b>' + esc(info.code) + '</b>（已含在链接里）· 手机需和这台电脑连<b>同一个 Wi-Fi</b></div>' +
            (alts.length ? '<div class="acr-note">扫不上 / 连不上？换个地址：' + alts.map(x => '<a href="javascript:void 0" class="acr-alt" data-ip="' + esc(x) + '">' + esc(x) + '</a>').join('　') + '</div>' : '') +
            '<div class="acr-note">连不上时：确认手机和电脑连同一 Wi-Fi；若首次运行 Windows 弹了防火墙提示，请点「允许访问」（专用网络）。</div>' +
            '<div class="acr-note">收到的文件存到：<span class="acr-dir">' + esc(info.dir) + '</span> <a href="javascript:void 0" id="acrOpen">打开文件夹</a></div>' +
          '</div>' +
        '</div>' +
        '<div class="acr-list-h">已接收（<span id="acrN">' + recvFiles.length + '</span>）</div><div class="acr-list" id="acrList"></div>';
      body.querySelector('#acrOpen').onclick = () => { try { window.sb.recvOpenDir(); } catch (e) {} };
      body.querySelectorAll('.acr-alt').forEach(a => a.onclick = () => renderFor(a.getAttribute('data-ip')));
      paintRecvList();
    };
    renderFor(info.ip);
  }
  function paintRecvList() {
    const list = document.getElementById('acrList'); const n = document.getElementById('acrN'); if (n) n.textContent = recvFiles.length;
    if (!list) return;
    if (!recvFiles.length) { list.innerHTML = '<div class="acr-empty">还没有文件。手机发送后会实时出现在这里。</div>'; return; }
    list.innerHTML = recvFiles.map((f, i) => {
      const kb = f.size > 1048576 ? (f.size / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(f.size / 1024)) + ' KB';
      const ic = /\.pptx?$/i.test(f.name) ? '📊' : /\.xlsx?$/i.test(f.name) ? '📗' : /\.(png|jpe?g|webp)$/i.test(f.name) ? '🖼' : '📄';
      const done = recvImported.has(f.path);
      return '<div class="acr-li"><span class="acr-ic">' + ic + '</span><span class="acr-nm" title="' + esc(f.path) + '">' + esc(f.name) + '</span><span class="acr-sz">' + kb + '</span>' +
        (done ? '<button class="btn ghost acr-use" disabled>已导入对话 ✓</button>' : '<button class="btn primary acr-use" data-i="' + i + '">用 Agent 打开</button>') + '</div>';
    }).join('');
    list.querySelectorAll('.acr-use:not([disabled])').forEach(b => b.onclick = async () => {
      const f = recvFiles[+b.getAttribute('data-i')]; if (!f) return;
      b.disabled = true; b.textContent = '导入中…';
      try { const s = curS() || newSession(); const r = await window.sb.readDocByPath(f.path); if (addFileRecord(s, r)) { recvImported.add(f.path); toastSafe2('已把「' + f.name + '」放进当前对话，关闭本窗即可开始提问'); paintRecvList(); } else { b.disabled = false; b.textContent = '用 Agent 打开'; } }
      catch (e) { toastSafe2('导入失败：' + String((e && e.message) || e)); b.disabled = false; b.textContent = '用 Agent 打开'; }
    });
  }
  function toastSafe2(t) { try { typeof toast === 'function' ? toast(t, 'ok') : 0; } catch (e) {} }
  function renderChat() {
    const el = document.getElementById('acMsgs'); if (!el) return;
    const s = curS();
    if (!s) { el.innerHTML = ''; return; }
    let h = s.msgs.map((m, mi) => {
      if (m.role === 'user') return '<div class="ac-b u">' + esc(m.content) + '</div>';
      if (m.role === 'sys') return '<div class="ac-b s">' + esc(m.content) + '</div>';
      if (m.role === 'approve') {
        const st = m.decided === 'no' ? '❌ 已拒绝' : m.decided ? '✅ 已允许' + (m.decided === 'all' ? '（本会话全部允许）' : '') : '';
        return '<div class="ac-b ap" data-mi="' + mi + '"><div class="ap-h">🛡 Agent 请求：<b>' + esc(APPROVE_LABEL[m.tool] || m.tool) + '</b>' + (st ? '<span class="ap-st">' + st + '</span>' : '') + '</div>' +
          '<pre class="ap-d">' + esc(m.desc || '') + '</pre>' +
          (m.decided ? '' : '<div class="ap-btns"><button class="btn primary ap-yes">允许</button><button class="btn ghost ap-all">本会话全部允许</button><button class="btn ghost ap-no">拒绝</button></div>') + '</div>';
      }
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
    el.querySelectorAll('.ac-b.ap').forEach(n => {
      const m = s.msgs[+n.getAttribute('data-mi')]; if (!m) return;
      const y = n.querySelector('.ap-yes'), a = n.querySelector('.ap-all'), x = n.querySelector('.ap-no');
      if (y) y.onclick = () => decideApprove(m, true, false);
      if (a) a.onclick = () => decideApprove(m, true, true);
      if (x) x.onclick = () => decideApprove(m, false, false);
    });
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
          '<button class="btn primary" id="acSend">发送</button>' +
          '<button class="btn ghost" id="acDiag" title="输入框打不了字时点这里：自动检查是谁挡住了输入，并把结果复制到剪贴板">🩺</button></div>' +
        '</div>' +
      '</div>';
    document.getElementById('acSend').onclick = send;
    /* 输入自检（2026-09-10 用户报「根本无法输入文字」，测试实例里复现不了）：
       点一下就把「谁盖在输入框上面 / 焦点落在哪 / 键盘事件有没有被拦 / 有没有全局遮罩」查一遍，
       结果弹出来并复制到剪贴板，用户贴回来就能定位，不用再猜。 */
    document.getElementById('acDiag').onclick = () => {
      const t = document.getElementById('acInput'); const out = [];
      try {
        const r = t.getBoundingClientRect(); const cs = getComputedStyle(t);
        const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        out.push('输入框可见: ' + (r.width > 0 && r.height > 0) + ' disabled=' + t.disabled + ' readOnly=' + t.readOnly + ' pointer-events=' + cs.pointerEvents + ' display=' + cs.display);
        out.push('盖在上面的元素: ' + (top === t ? '就是输入框本身（正常）' : (top ? (top.tagName + '#' + top.id + '.' + String(top.className).slice(0, 60)) : '无')));
        t.focus();
        out.push('focus() 之后焦点在: ' + (document.activeElement === t ? '输入框（正常）' : (document.activeElement ? document.activeElement.tagName + '#' + document.activeElement.id : '无')));
        const e = new KeyboardEvent('keydown', { key: 'a', bubbles: true, cancelable: true }); t.dispatchEvent(e);
        out.push('keydown 被谁 preventDefault: ' + (e.defaultPrevented ? '是（有脚本在拦键盘）' : '否（正常）'));
        const bi = new InputEvent('beforeinput', { inputType: 'insertText', data: 'a', bubbles: true, cancelable: true }); t.dispatchEvent(bi);
        out.push('beforeinput 被拦: ' + (bi.defaultPrevented ? '是' : '否（正常）'));
        const masks = [...document.querySelectorAll('.modal:not(.hidden), .pv-mask, .ai-mask, #loading:not(.hidden)')].map(m => m.id || m.className);
        out.push('当前打开的遮罩/弹窗: ' + (masks.length ? masks.join(', ') : '无'));
        out.push('body class: ' + (document.body.className || '(空)') + '；视图 active: ' + !!document.getElementById('view-agentchat').classList.contains('active'));
        out.push('窗口尺寸: ' + window.innerWidth + '×' + window.innerHeight + '；输入框位置: ' + Math.round(r.left) + ',' + Math.round(r.top) + ' ' + Math.round(r.width) + '×' + Math.round(r.height));
      } catch (err) { out.push('自检本身出错: ' + String(err && err.message || err)); }
      const txt = out.join(String.fromCharCode(10));
      // writeText 返回的是 Promise，窗口没焦点时是 reject 而不是 throw —— 必须 .catch，否则冒烟里报 unhandledrejection
      try { if (navigator.clipboard) navigator.clipboard.writeText(txt).catch(() => {}); } catch (e2) {}
      alert('输入自检结果（已复制到剪贴板，贴给我即可）：' + String.fromCharCode(10) + String.fromCharCode(10) + txt);
    };
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
      '.ac-b.ap{align-self:flex-start;max-width:86%;background:#FFF8E6;border:1px solid #E0A400;padding:10px 12px}' +
      '.ap-h{font-size:12.5px;margin-bottom:6px}.ap-st{margin-left:10px;color:var(--ink3);font-size:11px}' +
      '.ap-d{margin:0;white-space:pre-wrap;font:11.5px/1.5 Consolas,monospace;background:rgba(255,255,255,.6);border-radius:8px;padding:8px 10px;max-height:220px;overflow:auto}' +
      '.ap-btns{display:flex;gap:8px;margin-top:8px}.ap-btns .btn{font-size:12px;padding:5px 12px}' +
      '.ac-fico{font-size:20px}' +
      '.ac-fname{font-size:12px;font-weight:600;max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
      '.ac-b.f .btn{font-size:11px;padding:3px 8px}' +
      '#view-agentchat{position:relative}' +
      '#view-agentchat.ac-dropping::after{content:"📎 松手把文件交给 AI 阅读（xlsx / pptx / docx / txt / 图片）";position:absolute;inset:8px;display:flex;align-items:center;justify-content:center;border:2px dashed #C7000B;border-radius:14px;background:var(--c-bg-elev);opacity:.96;font-size:15px;color:#C7000B;z-index:30;pointer-events:none}' +
      '.acr-box{width:min(680px,94vw)}.acr-body{gap:14px}' +
      '.acr-cols{display:flex;gap:20px;align-items:flex-start;flex-wrap:wrap}' +
      '.acr-qr{flex:0 0 auto;text-align:center}.acr-qr svg{width:180px;height:180px;display:block;border:1px solid var(--line);border-radius:10px}' +
      '.acr-tip{font-size:11px;color:var(--ink3);margin-top:6px}' +
      '.acr-info{flex:1;min-width:240px;display:flex;flex-direction:column;gap:10px}' +
      '.acr-step{font-size:13px}.acr-url{font:15px/1.4 Consolas,monospace;font-weight:700;color:#C7000B;background:var(--c-bg);border:1px solid var(--line);border-radius:8px;padding:9px 12px;word-break:break-all;user-select:all}' +
      '.acr-note{font-size:12px;color:var(--ink3)}.acr-dir{font-family:Consolas,monospace;font-size:11px}.acr-note a{color:#C7000B}.acr-alt{font-family:Consolas,monospace}' +
      '.acr-list-h{font-size:12.5px;font-weight:600;border-top:1px solid var(--line);padding-top:12px}' +
      '.acr-list{display:flex;flex-direction:column;gap:6px;max-height:200px;overflow:auto}' +
      '.acr-empty{font-size:12px;color:var(--ink3);padding:6px 0}' +
      '.acr-li{display:flex;align-items:center;gap:9px;padding:7px 9px;background:var(--c-bg);border:1px solid var(--line);border-radius:9px}' +
      '.acr-ic{font-size:17px}.acr-nm{flex:1;font-size:12.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.acr-sz{font-size:11px;color:var(--ink3)}' +
      '.acr-use{font-size:11px;padding:4px 10px;white-space:nowrap}.acr-err{color:#C7000B;font-size:13px;line-height:1.6}';
    document.head.appendChild(css);
    if (!restore()) newSession();
  }

  window.renderAgentChat = function () { build(); renderAll(); };
  // 自动化测试钩子（与 📎/拖拽同一条入列链）：按路径附加文件到当前会话
  window.AgentChat = { addFileByPath: async (p) => { const s = curS() || newSession(); return addFileRecord(s, await window.sb.readDocByPath(p)); }, cur: () => curS() };
})();

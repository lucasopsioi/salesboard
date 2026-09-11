/* ============================================================
   Salesboard — Agent 架构看板（2026-08-31 用户：要看到 Agent 的结构、
   分管的 9 个专家、总调度、核验、辅助单元，以及协作流程与实时状态）
   window.AgentBoard = { open, feed }：open 弹全屏架构图；feed 吃编排
   onProgress 事件流实时高亮活跃节点（问答进行中打开即见现场）。
   ============================================================ */
'use strict';
(function () {
  const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  // 实时状态（事件驱动;看板未打开也持续记录,打开即见最近一轮）
  const live = { stage: 'idle', activeAgent: null, activeTool: null, doneAgents: {}, toolCount: {}, lastQ: '', t0: 0 };

  function agents() {
    try { return (window.AIOrch && window.AIOrch.AGENTS) || {}; } catch (e) { return {}; }
  }
  // 专家职责一句话 = prompt 首行(「你是XX专家，负责…」)
  function duty(a) {
    const first = String(a.prompt || '').split('\n')[0] || '';
    return first.replace(/^你是/, '').slice(0, 60);
  }

  const AUX = [
    { id: 'entity', icon: '🔎', name: '实体检索', desc: '问题先过 7 维度全字典（产业/系列/产品/型号/国家…），点名的实体生成硬约束卡——多产品全带上，不受界面筛选限制' },
    { id: 'guard', icon: '🛡', name: '类别护栏', desc: '按问题类型注入硬约束（期间口径/份额/预测/写操作/费用返利/单品粒度/逐项列出/断货判定/PPT 指引 等 10 类）' },
    { id: 'toolguard', icon: '🔧', name: '工具守卫', desc: '每次工具调用过四道关：参数 Schema 校验 / 反双重序列化 / 期间拦截（累计不许冒充季度值）/ 维度取值校验（拼错值报错并列出可用值）' },
  ];
  const VERIFY = [
    { id: 'prov', icon: '🚦', name: '数字溯源门禁', desc: '答案里每个数字回查本轮工具返回原文——查无出处替换为「?」并警示，编数在物理上不可能（允许合法变换：百分比/差值/逐月连续和/单位换算）' },
    { id: 'halfway', icon: '🔁', name: '半途重审', desc: '「让我再查一下…」这类过程句不许交卷——检测到即带数据强制重答（至多 2 次），仍失败给诚实兜底文案' },
  ];

  function nodeHtml(id, icon, name, sub, cls) {
    return '<div class="agb-node ' + (cls || '') + '" data-agb="' + esc(id) + '" title="' + esc(sub || '') + '">' +
      '<div class="agb-ni">' + icon + '</div><div class="agb-nn">' + esc(name) + '</div>' +
      (sub ? '<div class="agb-ns">' + esc(sub) + '</div>' : '') +
      '<div class="agb-live" data-agb-live="' + esc(id) + '"></div></div>';
  }

  function open() {
    let m = document.getElementById('agentBoardModal');
    if (m) { m.remove(); }
    m = document.createElement('div');
    m.id = 'agentBoardModal';
    m.className = 'ai-modal';
    const A = agents();
    const keys = Object.keys(A);
    m.innerHTML =
      '<div class="ai-modal-box agb-box">' +
        '<div class="ai-modal-h">🕸 Agent 架构与协作流程' +
          '<span class="agb-legend"><i class="agb-dot run"></i>执行中 <i class="agb-dot ok"></i>完成 <i class="agb-dot idle"></i>待命</span>' +
          '<button class="ai-modal-x" id="agbX">✕</button></div>' +
        '<div class="ai-modal-body agb-body">' +
          '<div class="agb-layer"><div class="agb-lt">提问</div><div class="agb-row">' + nodeHtml('q', '💬', '用户问题', live.lastQ ? live.lastQ.slice(0, 40) : '（等待提问）') + '</div></div>' +
          '<div class="agb-arrow">↓</div>' +
          '<div class="agb-layer"><div class="agb-lt">辅助单元（前置）</div><div class="agb-row">' + AUX.slice(0, 2).map(x => nodeHtml(x.id, x.icon, x.name, '', 'agb-aux')).join('') + '</div></div>' +
          '<div class="agb-arrow">↓</div>' +
          '<div class="agb-layer"><div class="agb-lt">总调度</div><div class="agb-row">' + nodeHtml('router', '🧭', '路由器', '按问题分派 1~N 个专家（串行执行）', 'agb-main') + '</div></div>' +
          '<div class="agb-arrow">↓</div>' +
          '<div class="agb-layer"><div class="agb-lt">分管专家 × ' + keys.length + '（各带口径卡 + 专属工具集）</div><div class="agb-grid">' +
            keys.map(k => nodeHtml('agent:' + A[k].name, '🤖', A[k].name, '看板: ' + (A[k].boards || []).join('/') + ' · 工具 ' + (A[k].tools || []).length + ' 件', 'agb-agent')).join('') +
          '</div></div>' +
          '<div class="agb-layer agb-inline"><div class="agb-lt">工具守卫（伴随每次取数）</div><div class="agb-row">' + nodeHtml(AUX[2].id, AUX[2].icon, AUX[2].name, '', 'agb-aux') + '</div></div>' +
          '<div class="agb-arrow">↓</div>' +
          '<div class="agb-layer"><div class="agb-lt">综合</div><div class="agb-row">' + nodeHtml('synth', '🧩', '综合器', '多专家结论合成一份回答（单专家直通跳过）', 'agb-main') + '</div></div>' +
          '<div class="agb-arrow">↓</div>' +
          '<div class="agb-layer"><div class="agb-lt">核验（出口质检）</div><div class="agb-row">' + VERIFY.map(x => nodeHtml(x.id, x.icon, x.name, '', 'agb-verify')).join('') + '</div></div>' +
          '<div class="agb-arrow">↓</div>' +
          '<div class="agb-layer"><div class="agb-lt">交付</div><div class="agb-row">' + nodeHtml('answer', '✅', '最终回答', '附执行过程折叠块 + 溯源警示（如有）') + '</div></div>' +
          '<div class="agb-detail" id="agbDetail">点任意节点看职责说明；问答进行中打开本窗，活跃节点会实时点亮。</div>' +
        '</div>' +
      '</div>';
    document.body.appendChild(m);
    m.querySelector('#agbX').onclick = () => m.remove();
    m.onclick = e => { if (e.target === m) m.remove(); };
    // 点节点显示职责
    const DESC = {};
    AUX.concat(VERIFY).forEach(x => { DESC[x.id] = x.icon + ' ' + x.name + '：' + x.desc; });
    DESC.router = '🧭 路由器：读问题与所在看板，从 ' + keys.length + ' 个专家里挑 1~N 个（问题跨域时多专家串行）。每个专家拿到：子问题 + 类别护栏 + 实体卡 + 回答体检清单。';
    DESC.synth = '🧩 综合器：只许使用各专家已给出的数字重组结论，不得引入新数字；受本题全部护栏约束。';
    DESC.q = '💬 一切从一个问题开始。';
    DESC.answer = '✅ 交付：正文 + 「🛠 执行过程」折叠块；被门禁拦下的数字显示为「?」并附警示。';
    keys.forEach(k => { DESC['agent:' + A[k].name] = '🤖 ' + A[k].name + '：' + duty(A[k]) + '。分管看板：' + (A[k].boards || []).join('/') + '；工具：' + (A[k].tools || []).join(', ') + '。取数≤8轮，轮次耗尽会基于已取数据强制作答。'; });
    m.querySelectorAll('.agb-node').forEach(n => {
      n.onclick = () => { const d = DESC[n.getAttribute('data-agb')]; if (d) m.querySelector('#agbDetail').textContent = d; };
    });
    paint();
  }

  // 实时高亮
  function paint() {
    const m = document.getElementById('agentBoardModal');
    if (!m) return;
    m.querySelectorAll('.agb-node').forEach(n => {
      const id = n.getAttribute('data-agb');
      n.classList.remove('run', 'ok');
      if (live.stage === 'idle') return;
      if (id === 'q') n.classList.add('ok');
      if (id === 'entity' || id === 'guard') n.classList.add('ok');
      if (id === 'router') n.classList.add(live.stage === 'plan' ? 'run' : 'ok');
      if (id.indexOf('agent:') === 0) {
        const nm = id.slice(6);
        if (live.activeAgent === nm) n.classList.add('run');
        else if (live.doneAgents[nm]) n.classList.add(live.doneAgents[nm] === 'err' ? 'run' : 'ok');
      }
      if (id === 'toolguard' && live.activeTool) n.classList.add('run');
      if (id === 'synth') { if (live.stage === 'synth') n.classList.add('run'); else if (live.stage === 'done') n.classList.add('ok'); }
      if ((id === 'prov' || id === 'halfway') && live.stage === 'done') n.classList.add('ok');
      if (id === 'answer' && live.stage === 'done') n.classList.add('ok');
    });
    const d = m.querySelector('#agbDetail');
    if (d && live.stage !== 'idle') {
      const secs = live.t0 ? Math.round((Date.now() - live.t0) / 1000) + 's' : '';
      if (live.stage === 'done') d.textContent = '✅ 本轮完成（' + secs + '）。点节点看职责说明。';
      else if (live.activeAgent) d.textContent = '⏳ ' + live.activeAgent + (live.activeTool ? (' 正在调用 ' + live.activeTool) : ' 分析中') + ' · 已用 ' + secs;
      else if (live.stage === 'synth') d.textContent = '🧩 综合各专家结论中 · 已用 ' + secs;
    }
  }

  function feed(e) {
    try {
      if (!e || !e.type) return;
      if (e.type === 'ask') { live.stage = 'plan'; live.lastQ = e.q || ''; live.activeAgent = null; live.activeTool = null; live.doneAgents = {}; live.t0 = Date.now(); }
      else if (e.type === 'plan') live.stage = 'agents';
      else if (e.type === 'agentStart') { live.activeAgent = e.agent; live.activeTool = null; }
      else if (e.type === 'tool') live.activeTool = e.tool;
      else if (e.type === 'toolDone') live.activeTool = null;
      else if (e.type === 'agentDone') { live.doneAgents[e.agent] = (e.result && e.result.error) ? 'err' : 'ok'; live.activeAgent = null; }
      else if (e.type === 'synth') { live.stage = 'synth'; live.activeAgent = null; }
      else if (e.type === 'done') { live.stage = 'done'; live.activeAgent = null; live.activeTool = null; }
      paint();
    } catch (err) { }
  }

  window.AgentBoard = { open, feed };

  const css = document.createElement('style');
  css.textContent =
    '.agb-box{max-width:860px;width:92vw}' +
    '.agb-body{max-height:78vh;overflow-y:auto}' +
    '.agb-layer{margin:2px 0}' +
    '.agb-lt{font-size:10px;color:var(--ink3,#999);margin:2px 0 4px;text-transform:none}' +
    '.agb-row{display:flex;gap:8px;flex-wrap:wrap;justify-content:center}' +
    '.agb-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:8px}' +
    '.agb-arrow{text-align:center;color:var(--ink3,#bbb);font-size:12px;line-height:1.2}' +
    '.agb-node{position:relative;border:1px solid var(--line,#ddd);border-radius:10px;padding:8px 10px;min-width:120px;flex:0 1 auto;background:var(--c-bg-elev,#fff);cursor:pointer;transition:border-color .2s, box-shadow .2s}' +
    '.agb-node:hover{border-color:#C7000B55}' +
    '.agb-node.run{border-color:#C7000B;box-shadow:0 0 0 2px #C7000B22;animation:agbPulse 1.2s infinite}' +
    '.agb-node.ok{border-color:#1E9E5766}' +
    '.agb-node.ok .agb-live{background:#1E9E57}' +
    '.agb-node.run .agb-live{background:#C7000B}' +
    '@keyframes agbPulse{0%,100%{box-shadow:0 0 0 2px #C7000B22}50%{box-shadow:0 0 0 4px #C7000B33}}' +
    '.agb-ni{font-size:16px;line-height:1}' +
    '.agb-nn{font-size:12px;font-weight:600;margin-top:3px}' +
    '.agb-ns{font-size:10px;color:var(--ink3,#999);margin-top:2px;max-width:200px}' +
    '.agb-live{position:absolute;top:8px;right:8px;width:7px;height:7px;border-radius:50%;background:var(--line,#ddd)}' +
    '.agb-main{background:linear-gradient(180deg,#fff7f7 0%,var(--c-bg-elev,#fff) 100%)}' +
    '.agb-aux{opacity:.92}' +
    '.agb-verify{background:linear-gradient(180deg,#f7fbf8 0%,var(--c-bg-elev,#fff) 100%)}' +
    '.agb-detail{margin-top:10px;padding:8px 10px;border-radius:8px;background:var(--panel,#f6f7f8);font-size:12px;color:var(--ink2,#555);min-height:34px}' +
    '.agb-legend{margin-left:10px;font-size:10px;color:var(--ink3,#999);font-weight:400}' +
    '.agb-dot{display:inline-block;width:7px;height:7px;border-radius:50%;background:#ddd;margin:0 3px 0 8px}' +
    '.agb-dot.run{background:#C7000B}.agb-dot.ok{background:#1E9E57}' +
    '@media (prefers-color-scheme: dark){.agb-main{background:var(--c-bg-elev,#222)}.agb-verify{background:var(--c-bg-elev,#222)}}';
  document.head.appendChild(css);
})();

/* ============================================================
   Salesboard — 引导层（2026-09-02 用户「学习成本太高，弄简洁直观」）
   不动任何看板内部逻辑，只在外壳上加四样东西：
     ① 首页：按「我想做什么」组织的任务入口（不用记 17 个看板名）+ 三步上手 + 数据状态
     ② 每个看板一个「？」：这页看什么 / 先做什么 / 常用操作（三句话，静态文案，零模型调用）
     ③ Ctrl+K 命令面板：输入「周报」「路标」「墨西哥销量」直达看板；对不上就交给 AI 直接答
     ④ 前 3 次启动默认进首页，之后记住上次看板
   ============================================================ */
'use strict';
(function () {
  const VIEW_TITLE = { home: '首页', psi: 'PSI 数据分析', industry: '产业看板', finance: '经营分析', country: '国家看板', report: '汇总表', custom: '自定义图表', designer: '看板设计器', source: '数据源', pricing: '定价测算', pricinglib: '产品定价库', roadmap: '路标管理', pptoutput: 'PPT output', inventory: '库存管理', textout: '文字输出', audio: '产业周报', fob: 'Floor FOB', agentchat: 'Agent 对话' };

  /* ---------- 每个看板的三句话（看什么 / 先做什么 / 常用操作） ---------- */
  const GUIDE = {
    psi:       { what: '看 Sell-in / Sell-out / 库存 / DOS 随时间的走势，可按产线、系列、国家等维度堆叠对比。', first: '先在顶部选指标（Sell Out 最常用），再选「按什么堆叠」，时间粒度选月看趋势、选周看近况。', actions: ['筛选栏点维度名可多选，取消全部=不过滤', '右上「导出图表」直接出 PPT 图页', '鼠标悬停柱子看精确值；图例点击可隐藏系列'], aliases: '销量 趋势 走势 SO SI 库存 DOS 堆叠' },
    industry:  { what: '一个产业（平板或音频）的四个核心 KPI：累计 SI/SO 与同比、渠道库存与 DOS、全流程库存。', first: '先切换产业（平板/音频），KPI 卡片下方的趋势图默认与去年同期对比。', actions: ['KPI 卡点开看逐期明细', '筛选国家/国家办只看局部', '周报用的数就是这里的口径'], aliases: '产业 KPI 同比 平板 音频 大盘' },
    finance:   { what: '财经口径的经营结果：收入、销毛率、NSIP、达成率（对 BP 与预测）。', first: '先选年份与月份区间；达成率一定配着「时间进度」一起看，否则上半年永远看起来落后。', actions: ['按产品线 / LV3 / LV4 下钻', '国家办视角看谁拖后腿', '导出 PPT 带图带表'], aliases: '经营 财经 收入 毛利 达成 BP 预测 NSIP' },
    country:   { what: '一个国家的完整画像：累计 SO 及同比、周度节奏、库存与 DOS、分产品明细。', first: '先在顶部选国家；表格按累计 SO 排序，红色 DOS 是压货预警。', actions: ['点产品行看该产品逐周', '导出 Excel 给国家办', '周报第 5 块「产品维度」与这里同源'], aliases: '国家 墨西哥 巴西 智利 哥伦比亚 国家办 画像' },
    report:    { what: '汇总大表：按任意维度分组给累计 SO/同期/同比、SI、近几周、库存、DOS 一次看全。', first: '先选分组维度（产线/系列/国家/国家办），再决定要几列周数据。', actions: ['列头点击排序', '导出 Excel 原样带列', '数字与国家看板逐字段同源'], aliases: '汇总 大表 总表 排名 分组' },
    custom:    { what: '自己拼一张图：任选数据集、指标、分组维度与图型，不受固定看板限制。', first: '先选数据集与指标，再选「按什么分组」，图型随手切。', actions: ['交叉筛选与看板设计器共享', '导出 PPT/PNG', '想要的图这里没有就去问 AI'], aliases: '自定义 自由 拼图 任意' },
    designer:  { what: '把多张图拼成一个看板页面（磁贴布局），支持交叉筛选。', first: '先「＋磁贴」加一张图，拖拽调位置大小；点磁贴右上设置绑数据。', actions: ['点某个柱子=全局筛选该维度值', '保存布局下次直接用', '导出成 PPT 一页一板'], aliases: '设计器 磁贴 布局 拼板' },
    source:    { what: '数据从哪来：挂载各类底表文件夹（PSI/库存/财经/IDC/发货/成本），看解析结果与最新时间。', first: '第一次用：点「PSI 文件夹」选底表所在目录——所有看板的数据都从这里来。', actions: ['解析不出来先看这里的表头提示', '「刷新」重扫所有文件夹', '看每张表的截至日期，对数先对截至'], aliases: '数据源 挂载 文件夹 导入 底表 刷新 截至' },
    pricing:   { what: '定价推演：从建议零售价一层层剥到 NSIP 与毛利，看不同渠道/国家下利润还剩多少。', first: '先选国家与渠道模板，填 RRP 与关键率，结果实时算。', actions: ['「＋加行」对比多个方案', '保存进产品定价库', '成本用成本底表的当月值'], aliases: '定价 测算 毛利 NSIP RRP 推演' },
    pricinglib:{ what: '已定价产品的档案库：按国家/产品/渠道存每一版定价快照。', first: '从定价测算「保存」或导入概算表进来；这里按国家、产品筛。', actions: ['对比同一产品不同国家', '路标建卡时自动从这里匹配上市价', 'AI 也从这里查定价'], aliases: '定价库 档案 快照 概算' },
    roadmap:   { what: '产品路标：每个产品的上市时间、价格档位、系列归属、前后代接续，画在时间×价格坐标上。', first: '没有产品时先点「自动识别」——从 PSI 底表把在售产品一键建卡；也可在 Agent 对话里说一句话添加。', actions: ['路标图上拖产品=改上市时间', '价格轴范围可手填，缺价产品落底部缺价区', '列表视图填 EOM 计划，图上自动标退市'], aliases: '路标 上市 产品规划 前代 EOM 退市 识别' },
    pptoutput: { what: '所见即所得的 PPT 设计器：文本框、数据框、图表、表格拖到画布，数据接实时接口，导出即最新。', first: '先「打开」一个模板（或让 Agent 把你的 PPT 转成模板），改字改图，点「导出 PPTX」。', actions: ['数据框绑指标后打开即最新数据', '「产业周报」一键生成 7 页', '拖入 PPT 到 Agent 对话说「做成模板」'], aliases: 'PPT 模板 导出 设计 幻灯片 汇报' },
    inventory: { what: '库存管理：全流程库龄（国家仓+FDC+渠道）、呆滞识别、SISO 推演。', first: '先在数据源挂「全流程库龄」文件夹；这里默认按国家看库龄分布。', actions: ['「重算」重跑推演', '导出 Excel 给供应链', '诊断按钮找发货表与 PSI 对不上的型号'], aliases: '库存 库龄 呆滞 SISO 推演 供应' },
    textout:   { what: '文字输出：把看板数字组织成周报/月报的文字段落（叙述模板+自动填数）。', first: '先选模板与期间，生成后可逐段改。', actions: ['复制到邮件或周报', '模板里 {week}/{产业} 自动替换', '想改叙述逻辑就问 AI'], aliases: '文字 叙述 周报文案 月报 段落' },
    audio:     { what: '产业周报一站式：遗留问题、经营进展、SI 达成、周度销售、产品维度、新品进展六块。', first: '先选产业与周次；数据自动带入，人工只填遗留问题与目标值。', actions: ['导出 PPT/邮件正文', '目标值与大盘空间在设置里维护', '与国家看板逐字段同源，对数直接对'], aliases: '周报 weekly 六块 遗留 达成 邮件' },
    fob:       { what: '0 毛 FOB：以零毛利为基准反推的 FOB 底价与档位，供路标缺价时估算。', first: '导入 Floor FOB 表后按型号/系列看；路标勾选「缺价用 FOB 估算」即联动。', actions: ['设置列位置以适配你的表格', '导出报表', '路标图上 ≈ 标记的价格来自这里'], aliases: 'FOB 零毛 底价 档位' },
    agentchat: { what: '和一组专家 Agent 对话：多路会话并行、点选专家、上传 Excel/PPT/文档、生成 PPT/Excel、把 PPT 转成模板、一句话录路标。', first: '直接问；拖文件进来就能读；输出文件会在对话里出现卡片。', actions: ['「把这个PPT做成模板」', '「把 X 加到路标：…系列，…月上市」', '「整理成 Excel 给我」'], aliases: 'AI Agent 对话 问答 助手 智能' },
    home:      { what: '按「我想做什么」找功能的入口。', first: '点一张卡片直达；随时按 Ctrl+K 搜功能或直接问 AI。', actions: [], aliases: '首页 home 开始' },
  };

  /* ---------- 首页任务卡 ---------- */
  const TASKS = [
    { icon: '📈', t: '看销量走势', d: 'Sell-out / Sell-in / 库存 / DOS 按月按周，任意维度对比', go: 'psi' },
    { icon: '🌎', t: '看某个国家', d: '一个国家的累计、同比、周节奏、库存与分产品明细', go: 'country' },
    { icon: '🎯', t: '看产业 KPI', d: '平板 / 音频四个核心指标与同期对比', go: 'industry' },
    { icon: '💰', t: '看经营达成', d: '收入、毛利率、NSIP、对 BP/预测的达成率', go: 'finance' },
    { icon: '📋', t: '出产业周报', d: '六块内容自动带数，导出 PPT 与邮件正文', go: 'audio' },
    { icon: '🖼', t: '做 PPT', d: '打开模板改字改图，数据自动最新，导出 PPTX', go: 'pptoutput' },
    { icon: '🗺', t: '管产品路标', d: '上市时间 × 价格档位，自动识别在售产品', go: 'roadmap' },
    { icon: '🧮', t: '算定价与毛利', d: '从零售价剥到 NSIP，比较渠道与国家', go: 'pricing' },
    { icon: '📦', t: '看库存与库龄', d: '全流程库龄、呆滞识别、SISO 推演', go: 'inventory' },
    { icon: '🤖', t: '让 Agent 干活', d: '上传文件、提问、生成 Excel/PPT、一句话录路标', go: 'agentchat' },
    { icon: '🗂', t: '挂载数据', d: '第一次用从这里开始：选底表文件夹', go: 'source' },
    { icon: '💬', t: '直接问 AI', d: '任何看板数据问题，随口问', go: '__ai__' },
  ];

  const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const $ = s => document.querySelector(s);

  function injectStyle() {
    if ($('#uxGuideStyle')) return;
    const st = document.createElement('style'); st.id = 'uxGuideStyle';
    st.textContent = [
      '#view-home{padding:22px 28px;overflow:auto}',
      '.ux-hero{display:flex;align-items:flex-end;justify-content:space-between;gap:16px;margin-bottom:14px}',
      '.ux-hero h2{margin:0;font-size:20px}.ux-hero p{margin:4px 0 0;color:var(--ink3);font-size:12px}',
      '.ux-steps{display:flex;gap:10px;margin:8px 0 18px}',
      '.ux-step{flex:1;display:flex;gap:10px;align-items:center;padding:10px 12px;border:1px solid var(--line);border-radius:12px;background:var(--panel);font-size:12px;cursor:pointer}',
      '.ux-step b{display:inline-flex;width:22px;height:22px;align-items:center;justify-content:center;border-radius:50%;background:var(--red);color:#fff;font-size:12px;flex:none}',
      '.ux-step.done b{background:var(--good)}.ux-step:hover{border-color:var(--red)}',
      '.ux-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:12px}',
      '.ux-card{border:1px solid var(--line);border-radius:14px;background:var(--panel);padding:14px 14px 12px;cursor:pointer;transition:transform .08s,border-color .08s;box-shadow:var(--shadow)}',
      '.ux-card:hover{transform:translateY(-1px);border-color:var(--red)}',
      '.ux-card .ic{font-size:22px;line-height:1}.ux-card .t{font-weight:700;font-size:14px;margin-top:8px}.ux-card .d{font-size:12px;color:var(--ink3);margin-top:4px;line-height:1.5}',
      '.ux-kbd{display:inline-block;padding:1px 6px;border:1px solid var(--line);border-bottom-width:2px;border-radius:5px;font:11px/1.4 Consolas,monospace;color:var(--ink2);background:var(--bg)}',
      '#btnGuide{margin-left:6px;width:26px;height:26px;border-radius:50%;padding:0;font-weight:700}',
      '.ux-pop{position:fixed;z-index:1200;width:380px;max-width:90vw;background:var(--panel);border:1px solid var(--line);border-radius:14px;box-shadow:0 12px 40px rgba(16,24,40,.18);padding:14px 16px;font-size:12.5px;line-height:1.6}',
      '.ux-pop h4{margin:0 0 6px;font-size:14px}.ux-pop .lab{color:var(--red);font-weight:700;margin-right:6px}.ux-pop ul{margin:4px 0 0 16px;padding:0}.ux-pop .foot{margin-top:8px;color:var(--ink3);font-size:11px;display:flex;justify-content:space-between;align-items:center}',
      '.ux-pal-bg{position:fixed;inset:0;background:rgba(16,24,40,.28);z-index:1300;display:flex;align-items:flex-start;justify-content:center;padding-top:12vh}',
      '.ux-pal{width:560px;max-width:92vw;background:var(--panel);border-radius:16px;box-shadow:0 20px 60px rgba(16,24,40,.3);overflow:hidden}',
      '.ux-pal input{width:100%;box-sizing:border-box;border:0;border-bottom:1px solid var(--line);padding:14px 16px;font-size:15px;background:transparent;color:inherit;outline:none}',
      '.ux-pal .list{max-height:52vh;overflow:auto;padding:6px}',
      '.ux-pal .it{display:flex;align-items:center;gap:10px;padding:9px 12px;border-radius:10px;cursor:pointer;font-size:13px}',
      '.ux-pal .it .k{font-size:11px;color:var(--ink3);margin-left:auto}.ux-pal .it.on,.ux-pal .it:hover{background:var(--bg)}',
      '.ux-pal .it .n{font-weight:600}.ux-pal .it .d{color:var(--ink3);font-size:11px;margin-left:6px}',
      '.ux-pal .hint{padding:6px 14px 10px;font-size:11px;color:var(--ink3);border-top:1px solid var(--line)}',
    ].join('\n');
    document.head.appendChild(st);
  }

  /* ---------- 首页 ---------- */
  function dataMounted() {
    try { const t = ($('#statusText') || {}).textContent || ''; return !/未锚定|未挂载|No folder/.test(t); } catch (e) { return false; }
  }
  function renderHome() {
    let sec = $('#view-home');
    if (!sec) {
      sec = document.createElement('section'); sec.className = 'view'; sec.id = 'view-home';
      const anchor = $('#view-agentchat') || $('.view');
      if (anchor && anchor.parentNode) anchor.parentNode.insertBefore(sec, anchor); else document.querySelector('.main').appendChild(sec);
    }
    const mounted = dataMounted();
    sec.innerHTML =
      '<div class="ux-hero"><div><h2>你想做什么？</h2><p>点卡片直达；随时按 <span class="ux-kbd">Ctrl</span>+<span class="ux-kbd">K</span> 搜功能或直接问 AI；每个看板右上角的 <b>?</b> 三句话说清怎么用。</p></div>' +
      '<div style="font-size:12px;color:var(--ink3)">' + (mounted ? '✅ 数据已挂载' : '⚠ 还没挂载数据：先点下面第 1 步') + '</div></div>' +
      '<div class="ux-steps">' +
        '<div class="ux-step' + (mounted ? ' done' : '') + '" data-go="source"><b>1</b><div class="ux-nowrap"><span style="font-weight:600">挂载数据</span><span style="color:var(--ink3);margin-left:8px">选底表文件夹（或先「载入示例」看效果）</span></div></div>' +
        '<div class="ux-step" data-go="industry"><b>2</b><div class="ux-nowrap"><span style="font-weight:600">看一眼看板</span><span style="color:var(--ink3);margin-left:8px">产业看板四个 KPI 一屏看完</span></div></div>' +
        '<div class="ux-step" data-go="__ai__"><b>3</b><div class="ux-nowrap"><span style="font-weight:600">直接问 AI</span><span style="color:var(--ink3);margin-left:8px">「墨西哥平板今年卖了多少」这样问</span></div></div>' +
      '</div>' +
      '<div class="ux-grid">' + TASKS.map(t => '<div class="ux-card" data-go="' + t.go + '"><div class="ic">' + t.icon + '</div><div class="t">' + esc(t.t) + '</div><div class="d">' + esc(t.d) + '</div></div>').join('') + '</div>';
    sec.querySelectorAll('[data-go]').forEach(n => n.onclick = () => go(n.getAttribute('data-go')));
  }
  function go(v) {
    if (v === '__ai__') { try { window.AIPanel && window.AIPanel.open(null); } catch (e) {} return; }
    try { switchView(v); } catch (e) {}
  }

  /* ---------- 切视图包装：接管 home + 记住上次看板 + 刷新「？」 ---------- */
  let curView = 'psi';
  function wrapSwitch() {
    const orig = window.switchView;
    if (typeof orig !== 'function' || orig.__uxWrapped) return;
    const w = function (v) {
      if (v === 'home') {
        const activate = () => {
          document.querySelectorAll('.nav-item').forEach(n => n.classList.toggle('active', n.dataset.view === 'home'));
          document.querySelectorAll('.view').forEach(el => el.classList.toggle('active', el.id === 'view-home'));
          const t = $('#viewTitle'); if (t) t.textContent = '首页';
          const db = $('#dataBar'); if (db) db.innerHTML = '';
        };
        activate(); renderHome();
        // 启动期数据加载完成后，app.js 会重绘并激活默认看板——若用户仍停在首页则把首页重新顶回来
        setTimeout(() => { if (curView === 'home') activate(); }, 600);
        setTimeout(() => { if (curView === 'home') { activate(); renderHome(); } }, 2500);
      } else {
        orig(v);
      }
      curView = v;
      try { localStorage.setItem('sb.ui.lastView', v); } catch (e) {}
      updateGuideBtn();
      setSubtitle(v);
      scheduleSimplify();
      return undefined;
    };
    w.__uxWrapped = true;
    window.switchView = w;
  }

  /* ---------- 「？」按钮与浮层 ---------- */
  let pop = null;
  function updateGuideBtn() {
    const b = $('#btnGuide'); if (!b) return;
    b.title = '这页怎么用（' + (VIEW_TITLE[curView] || curView) + '）';
    if (pop) { closePop(); }
  }
  function closePop() { if (pop) { pop.remove(); pop = null; document.removeEventListener('mousedown', onDocDown, true); } }
  function onDocDown(e) { if (pop && !pop.contains(e.target) && e.target.id !== 'btnGuide') closePop(); }
  function openPop() {
    closePop();
    const g = GUIDE[curView] || { what: '', first: '', actions: [] };
    const b = $('#btnGuide'); const r = b ? b.getBoundingClientRect() : { left: 300, bottom: 60 };
    pop = document.createElement('div'); pop.className = 'ux-pop';
    pop.style.left = Math.min(r.left, window.innerWidth - 400) + 'px'; pop.style.top = (r.bottom + 8) + 'px';
    pop.innerHTML = '<h4>' + esc(VIEW_TITLE[curView] || curView) + ' · 这页怎么用</h4>' +
      '<div><span class="lab">看什么</span>' + esc(g.what) + '</div>' +
      '<div style="margin-top:4px"><span class="lab">先做什么</span>' + esc(g.first) + '</div>' +
      (g.actions && g.actions.length ? '<div style="margin-top:4px"><span class="lab">常用操作</span><ul>' + g.actions.map(a => '<li>' + esc(a) + '</li>').join('') + '</ul></div>' : '') +
      '<div class="foot"><span>看不懂的按钮把鼠标停上去有说明</span><span><a href="#" data-act="home">回首页</a> · <a href="#" data-act="ai">问 AI</a></span></div>';
    document.body.appendChild(pop);
    pop.querySelectorAll('a[data-act]').forEach(a => a.onclick = (ev) => { ev.preventDefault(); const k = a.getAttribute('data-act'); closePop(); if (k === 'home') go('home'); else go('__ai__'); });
    setTimeout(() => document.addEventListener('mousedown', onDocDown, true), 0);
  }
  function injectGuideBtn() {
    if ($('#btnGuide')) return;
    const title = $('#viewTitle'); if (!title) return;
    const b = document.createElement('button'); b.className = 'btn ghost'; b.id = 'btnGuide'; b.textContent = '?';
    title.parentNode.insertBefore(b, title.nextSibling);
    b.onclick = () => pop ? closePop() : openPop();
    updateGuideBtn();
  }

  /* ---------- 首页导航项 ---------- */
  function injectNav() {
    const nav = document.querySelector('nav'); if (!nav || $('.nav-item[data-view="home"]')) return;
    const item = document.createElement('div'); item.className = 'nav-item'; item.setAttribute('data-view', 'home');
    item.innerHTML = '<span class="ic">🏠</span>首页';
    item.onclick = () => go('home');
    item.style.marginBottom = '6px';
    nav.insertBefore(item, nav.firstChild);   // 固定在侧栏最顶，不参与用户自定义排序
    const t = $('#viewTitle'); if (t) t.style.whiteSpace = 'nowrap';
  }

  /* ---------- Ctrl+K 命令面板 ---------- */
  let pal = null;
  function items(q) {
    const s = String(q || '').trim().toLowerCase();
    const list = [];
    // 排序：标题命中 > 别名命中 > 描述命中（「周报」要先给产业周报，而不是描述里提到周报的文字输出）
    const scored = [];
    Object.keys(VIEW_TITLE).forEach(v => {
      const g = GUIDE[v] || {};
      const title = VIEW_TITLE[v].toLowerCase(), ali = (g.aliases || '').toLowerCase(), what = (g.what || '').toLowerCase();
      const words = s ? s.split(/\s+/).filter(Boolean) : [];
      const inAll = (t) => words.every(w => t.indexOf(w) >= 0);
      let sc = 0;
      if (!s) sc = 1; else if (inAll(title)) sc = 3; else if (inAll(ali)) sc = 2; else if (inAll(what)) sc = 1;
      if (sc) scored.push({ sc, it: { kind: 'view', n: VIEW_TITLE[v], d: g.what || '', go: v, k: '看板' } });
    });
    scored.sort((a, b) => b.sc - a.sc).forEach(x => list.push(x.it));
    const acts = [
      { n: '载入示例数据', d: '没有底表时先看效果', run: () => { const b = $('#btnSample'); if (b) b.click(); }, k: '操作', key: '示例 sample demo 演示' },
      { n: '刷新数据', d: '重扫所有已挂载文件夹', run: () => { const b = $('#btnRefresh'); if (b) b.click(); }, k: '操作', key: '刷新 refresh 重扫' },
      { n: 'AI 设置', d: '模型、Key、网络体检', run: () => { try { window.AIPanel.openSettings(); } catch (e) {} }, k: '操作', key: 'ai 设置 模型 key deepseek' },
      { n: '软件设置', d: '阈值、显示偏好', run: () => { const b = document.getElementById('btnSettings') || [...document.querySelectorAll('button')].find(x => /设置/.test(x.textContent)); if (b) b.click(); }, k: '操作', key: '设置 偏好 阈值' },
    ];
    acts.forEach(a => { const hay = (a.n + ' ' + a.key).toLowerCase(); if (!s || hay.indexOf(s) >= 0) list.push(a); });
    if (s.length >= 2) list.push({ n: '问 AI：' + q, d: '把这句话直接交给 AI 回答', k: 'AI', ai: q });
    return list;
  }
  function openPal() {
    if (pal) return;
    pal = document.createElement('div'); pal.className = 'ux-pal-bg';
    pal.innerHTML = '<div class="ux-pal"><input id="uxPalIn" placeholder="想去哪 / 想做什么？如：周报、路标、墨西哥平板今年卖了多少"><div class="list" id="uxPalList"></div><div class="hint">↑↓ 选择 · Enter 执行 · Esc 关闭</div></div>';
    document.body.appendChild(pal);
    const inp = $('#uxPalIn'), list = $('#uxPalList');
    let cur = 0, cache = [];
    const render = () => {
      cache = items(inp.value);
      cur = Math.min(cur, Math.max(0, cache.length - 1));
      list.innerHTML = cache.map((it, i) => '<div class="it' + (i === cur ? ' on' : '') + '" data-i="' + i + '"><span class="n">' + esc(it.n) + '</span><span class="d">' + esc(it.d || '') + '</span><span class="k">' + esc(it.k) + '</span></div>').join('') || '<div class="it"><span class="d">没有匹配</span></div>';
      list.querySelectorAll('.it[data-i]').forEach(n => { n.onmouseenter = () => { cur = +n.getAttribute('data-i'); render(); }; n.onclick = () => run(cache[+n.getAttribute('data-i')]); });
    };
    const run = (it) => {
      if (!it) return;
      closePal();
      if (it.ai) { askAi(it.ai); return; }
      if (it.run) { it.run(); return; }
      go(it.go);
    };
    inp.oninput = () => { cur = 0; render(); };
    inp.onkeydown = (e) => {
      if (e.key === 'ArrowDown') { cur = Math.min(cache.length - 1, cur + 1); render(); e.preventDefault(); }
      else if (e.key === 'ArrowUp') { cur = Math.max(0, cur - 1); render(); e.preventDefault(); }
      else if (e.key === 'Enter') { run(cache[cur]); e.preventDefault(); }
      else if (e.key === 'Escape') { closePal(); }
    };
    pal.onmousedown = (e) => { if (e.target === pal) closePal(); };
    render(); setTimeout(() => inp.focus(), 10);
  }
  function closePal() { if (pal) { pal.remove(); pal = null; } }
  function askAi(q) {
    try {
      window.AIPanel.open(null);
      setTimeout(() => {
        const ta = document.querySelector('#aiText'); const btn = document.querySelector('#aiSend');
        if (ta) { ta.value = q; ta.dispatchEvent(new Event('input', { bubbles: true })); }
        if (btn) btn.click();
      }, 120);
    } catch (e) {}
  }

  /* ==================== 简化层（2026-09-02 用户「每个看板交互都要一看就懂」） ====================
     原则：一屏一个主按钮；少用的控件折进「更多 ▾」；每页顶部一句白话副标题；术语悬停即白话。
     机制：按看板配置 selector；视图整块重绘后由 MutationObserver 幂等重贴，不改任何看板内部代码。 */
  const SIMPLIFY = {
    // PSI：把「标签字号/标签色/平滑/图例位置/透明度/重置配色/改色提示」整段（连同 .fld 标签壳）折进第二行末尾的「图表样式 ▾」
    psi: { folds: [{ host: '#view-psi .psi-top', btnHost: '#chartType', btnUp: 2, wrap: '.fld', label: '图表样式', sel: ['#labelSize', '#labelColor', '#labelColorAuto', '#opacity', '#legendPos', '#btnResetColors', '#btnSmooth', '#view-psi .psi-row > span[style*="font-size:11px"]'] }] },
    roadmap: {
      primary: '#rmAdd',
      folds: [
        { host: '#rmAdd', up: 1, label: '导出 / 导入', before: '#rmAddSeries', sel: ['#rmExport', '#rmExportPpt', '#rmExportJson', '#rmImportJson'] },
        { host: '#rmChartTools', label: '更多选项', sel: ['#rmSampleColor', '#rmSampleOpacity', '#rmBoxStyle', '#rmFobEst', '#rmFobMt', '#rmFobMa', 'span[title*="FOB"]'] },
      ],
    },
    inventory: { primary: '#invRecalc', folds: [{ host: '#invRecalc', up: 1, label: '更多', sel: ['#invArchiveBtn', '#invFullExportBtn', '#invDiagBtn'] }] },
  };
  // 术语 → 白话（悬停提示；只补没有 title 的元素）
  const JARGON = [
    [/^Sell ?Out$/i, 'Sell-out：渠道卖给消费者的量（真实动销）'], [/^Sell ?In$/i, 'Sell-in：厂家发给渠道的量（进货）'],
    [/^库存 ?INV$|^INV$/i, '渠道手上的库存（按最新一期快照）'], [/^DOS$/i, 'DOS = 库存周转天数 = 库存 ÷ 近 4 周日均销量，越大压货越重'],
    [/^SI$/i, 'Sell-in 进货量'], [/^SO$/i, 'Sell-out 销量'], [/^NSIP$/i, '单台净销售价（美元/台）'], [/^BP$/i, '年度经营计划目标'],
    [/^WoW$/i, '周环比：本周比上周'], [/^EOM$/i, '停产/退市计划月'], [/^FOB$/i, '离岸价（出厂价口径）'],
    [/^堆积面积$/, '各系列叠起来看总量与结构'], [/^折线$/, '看走势最清楚'], [/^堆积柱$/, '按期看总量，柱内分系列'], [/^占比\(100%\)$/, '只看结构占比，不看绝对量'], [/^分组柱$/, '各系列并排比大小'],
    [/^日$|^周$|^月$/, '时间颗粒：日看近况、周看节奏、月看趋势'], [/^单台$/, '按台数显示'], [/^千台 K$/, '按千台显示'], [/^万台 W$/, '按万台显示'],
    [/^全流程库存$/, '国家仓 + 前置仓(FDC) + 渠道库存合计'], [/^重算$/, '按当前挂载的底表重新推演'], [/^载入示例$/, '没有底表时先用内置样例数据看效果'], [/^刷新$/, '重扫所有已挂载的文件夹'],
  ];
  function applyJargon(root) {
    (root || document).querySelectorAll('button:not([title]), th:not([title]), .metric-tabs button, label:not([title]), .seg button:not([title])').forEach(el => {
      if (el.title) return;
      const t = (el.textContent || '').trim(); if (!t || t.length > 12) return;
      for (const [re, tip] of JARGON) { if (re.test(t)) { el.title = tip; break; } }
    });
  }
  function applySimplify(v) {
    const cfg = SIMPLIFY[v]; if (!cfg) return;
    (cfg.folds || []).forEach(f => {
      let host = $(f.host); if (!host) return;
      for (let i = 0; i < (f.up || 0); i++) host = host.parentNode;
      if (!host) return;
      const nodes = [];
      f.sel.forEach(s => host.querySelectorAll(s).forEach(n => {
        // 折整段：输入框连同它的 <label> 壳 / 配置的 wrap 壳（如 .fld）一起折，不留孤零零的文字标签
        let lab = n;
        if (f.wrap && n.closest(f.wrap) && host.contains(n.closest(f.wrap))) lab = n.closest(f.wrap);
        else if (n.tagName === 'INPUT' && n.closest('label')) lab = n.closest('label');
        if (nodes.indexOf(lab) < 0) nodes.push(lab);
      }));
      if (!nodes.length) return;
      nodes.forEach(n => n.classList.add('ux-adv'));
      host.classList.add('ux-foldable');
      // 折叠开关放哪：默认放 host 末尾；btnHost/btnUp 可指定放进某一行（如 PSI 第二行末尾）
      let bh = f.btnHost ? $(f.btnHost) : host;
      for (let i = 0; bh && i < (f.btnUp || 0); i++) bh = bh.parentNode;
      bh = bh || host;
      if (!bh.querySelector(':scope > .ux-more')) {
        const btn = document.createElement('button'); btn.className = 'btn ghost ux-more'; btn.type = 'button';
        const paint = () => { btn.textContent = f.label + (host.classList.contains('ux-open') ? ' ▴' : ' ▾'); };
        btn.onclick = () => { host.classList.toggle('ux-open'); paint(); };
        paint();
        const bef = f.before ? bh.querySelector(f.before) : null;
        if (bef) bh.insertBefore(btn, bef); else bh.appendChild(btn);
      }
    });
    if (cfg.primary) { const p = $(cfg.primary); if (p && !p.classList.contains('primary')) p.classList.add('primary'); }
  }
  // 单行省略号截断的文字：把全文放进 title，悬停可见（nowrap.css 负责截断，这里负责不丢信息）
  function applyEllipsisTitles() {
    document.querySelectorAll('#statusText, #viewSub, .ux-card .d, .inv-card h4, .ac-sess-t, .db-chip, .pd-tpl-row .nm').forEach(el => {
      const t = (el.textContent || '').trim();
      if (t && el.scrollWidth > el.clientWidth + 1 && el.title !== t) el.title = t;
    });
  }
  let simpT = null, mo = null, applying = false;
  function scheduleSimplify() {
    if (applying) return;                       // 自己改 DOM 触发的观察不再排队，杜绝回环
    clearTimeout(simpT);
    simpT = setTimeout(() => {
      applying = true;
      try { if (mo) mo.disconnect(); applySimplify(curView); applyJargon(document.getElementById('view-' + curView) || document); applyEllipsisTitles(); } catch (e) {}
      finally { if (mo) mo.observe(document.body, { subtree: true, childList: true }); applying = false; }
    }, 220);
  }
  function injectSimplifyStyle() {
    const st = document.createElement('style'); st.id = 'uxSimplifyStyle';
    st.textContent = '.ux-foldable:not(.ux-open) .ux-adv{display:none!important}.ux-more{font-size:12px;padding:4px 10px;opacity:.85}.ux-more:hover{opacity:1}';
    document.head.appendChild(st);
  }
  function setSubtitle(v) {
    const sub = $('#viewSub'); if (!sub) return;
    const g = GUIDE[v]; sub.textContent = g && g.what ? g.what.replace(/[。.]$/, '') : '';
    sub.style.maxWidth = '46vw'; sub.style.overflow = 'hidden'; sub.style.textOverflow = 'ellipsis'; sub.style.whiteSpace = 'nowrap';
  }

  /* ---------- 启动 ---------- */
  function boot() {
    injectStyle(); injectSimplifyStyle(); injectNav(); wrapSwitch(); injectGuideBtn();
    mo = new MutationObserver(() => scheduleSimplify());
    mo.observe(document.body, { subtree: true, childList: true });
    scheduleSimplify();
    document.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'K')) { e.preventDefault(); pal ? closePal() : openPal(); }
      if (e.key === 'Escape' && pop) closePop();
    });
    // 前 3 次启动进首页；之后回到上次看板
    let seen = 0; try { seen = +(localStorage.getItem('sb.ui.homeSeen') || 0); } catch (e) {}
    let last = ''; try { last = localStorage.getItem('sb.ui.lastView') || ''; } catch (e) {}
    if (seen < 3 || !last) { try { localStorage.setItem('sb.ui.homeSeen', String(seen + 1)); } catch (e) {} go('home'); }
    else if (last !== 'psi' && VIEW_TITLE[last]) { try { go(last); } catch (e) {} }
    else { curView = 'psi'; updateGuideBtn(); }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => setTimeout(boot, 0)); else setTimeout(boot, 0);
  window.UxGuide = { GUIDE, TASKS, SIMPLIFY, openPal, openPop, renderHome, applySimplify, scheduleSimplify, cur: () => curView };
})();

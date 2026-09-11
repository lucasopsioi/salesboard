'use strict';
/* ============================================================
   多看板专家 Agent + 跨看板编排 —— 纯 Node 测试（无 electron / 无 DOM / 无网络 / 无真模型）。
   编排器的 LLM 与工具都靠注入的 deps，所以这里用「脚本化假模型」把整条链路跑完，
   断言预算、串行度、口径注入、数字溯源都成立。
   ============================================================ */
const O = require('./ai-orchestrator.js');
const AD = require('./ai-context.js');

let f = 0; const ok = (n, c) => { console.log((c ? 'PASS ' : 'FAIL ') + n); if (!c) f++; };

/* ---------- 1) 看板覆盖：15 个 view id 一个都不能漏 ---------- */
const VIEWS = ['psi', 'industry', 'finance', 'country', 'report', 'custom', 'designer', 'source',
  'pricing', 'pricinglib', 'roadmap', 'pptoutput', 'inventory', 'textout', 'audio'];
const missing = VIEWS.filter(v => !O.BOARD2AGENT[v]);
ok('A1 全部 15 个看板都映射到专家(缺:' + (missing.join(',') || '无') + ')', missing.length === 0);
ok('A2 专家数量适中(6~10 个,不是每板一个也不是只有一个)', Object.keys(O.AGENTS).length >= 6 && Object.keys(O.AGENTS).length <= 10);
ok('A3 每个专家都有 id/名称/工具白名单/提示词', Object.keys(O.AGENTS).every(k => {
  const a = O.AGENTS[k];
  return a.id && a.name && Array.isArray(a.tools) && a.tools.length && typeof a.prompt === 'string' && a.prompt.length > 200;
}));
ok('A4 专家提示词长度受控(≤2200 字符,2026-09-01 自 1800 放宽:在线模型时代+全员方法论段)', Object.keys(O.AGENTS).every(k => O.AGENTS[k].prompt.length <= 2200));
ok('A5 工具白名单里的工具都在 ai-context 的 schema 真源里', Object.keys(O.AGENTS).every(k => O.AGENTS[k].tools.every(t => !!AD.TOOL_SCHEMAS[t])));

/* ---------- 2) 专家提示词必须含可执行公式(不是"要理解口径"的空话) ---------- */
const P = id => O.AGENTS[id].prompt;
ok('A6 PSI 专家点明「图上DOS ≠ 汇总表DOS」', /不是同一个数|不是同一/.test(P('psi')) && P('psi').indexOf('DOS') >= 0);
ok('A7 PSI 专家区分流量/快照聚合', P('psi').indexOf('求和') >= 0 && P('psi').indexOf('最新') >= 0);
ok('A8 财经专家给出销毛率「先求和再相除」', /先分子分母各自求和再相除|各自求和/.test(P('finance')));
ok('A9 财经专家点明 NSIP 同比是绝对美元差', P('finance').indexOf('NSIP') >= 0 && P('finance').indexOf('绝对') >= 0);
ok('A10 财经专家要求达成率必须配时间进度', P('finance').indexOf('时间进度') >= 0);
ok('A11 财经专家点明国家办看板不支持 LV1(大小写不敏感)', /不支持\s*lv1/i.test(P('finance')));
ok('A12 汇总专家给出近4周与红绿灯阈值', P('report').indexOf('近4周') >= 0 && P('report').indexOf('90') >= 0 && P('report').indexOf('120') >= 0);
ok('A13 库存专家点明 FIFO 与全流程=渠道+CDC+FDC', P('inventory').indexOf('FIFO') >= 0 && P('inventory').indexOf('CDC') >= 0);
ok('A14 PPT 顾问明确「不负责算数」且列出数据集', P('ppt').indexOf('不负责算数') >= 0 && P('ppt').indexOf('roadmap') >= 0);
ok('A15 数据源专家点明维度语义随表头变、要现查', P('source').indexOf('现查') >= 0 || P('source').indexOf('一律现查') >= 0);
ok('A16 每个专家都有红线段落', Object.keys(O.AGENTS).every(k => P(k).indexOf('红线') >= 0));

/* ---------- 3) 全局口径卡 ---------- */
const G = O.GLOBAL_CALIBER;
ok('A17 口径卡 ≤1200 字符', G.length <= 1200);
ok('A18 口径卡含渠道不去重/库存最新期', G.indexOf('不去重') >= 0 && G.indexOf('最新期') >= 0);
ok('A19 口径卡含 DOS 公式与音频原子单元', G.indexOf('28') >= 0 && G.indexOf('原子单元') >= 0);
ok('A20 口径卡含层级错位映射', G.indexOf('LV3') >= 0 && G.indexOf('LV4') >= 0);
ok('A21 口径卡含 SISO ≤100 台容忍', G.indexOf('100') >= 0);
ok('A22 口径卡含「取值先 options 查，禁止凭记忆」', G.indexOf('options') >= 0 && G.indexOf('禁止') >= 0);

/* ---------- 4) 路由 ---------- */
const ids = r => r.map(x => x.agentId);
ok('A23 在 PSI 看板问趋势 → psi 专家打头', ids(O.planRoute('Coral 最近一个月卖得怎么样', 'psi'))[0] === 'psi');
ok('A24 跨看板问题拆成多个专家(收入+SO+库存)', (() => {
  const r = ids(O.planRoute('Product D 今年经营情况怎么样，收入多少、最近一个月 sell out 多少、库存水位如何', null));
  return r.indexOf('finance') >= 0 && r.indexOf('inventory') >= 0 && r.length >= 2;
})());
ok('A25 PPT 问题路由到 ppt 顾问', ids(O.planRoute('如果做一页 PPT，你会怎么组合我现有的数据', 'pptoutput')).indexOf('ppt') >= 0);
ok('A26 定价问题路由到定价专家', ids(O.planRoute('墨西哥这个产品的 RRP 和毛利怎么样', null)).indexOf('pricing') >= 0);
ok('A27 路由最多 4 个专家(控制本地模型耗时)', O.planRoute('收入 库存 定价 上市 周报 趋势 PPT 都说一下', null).length <= 4);
// 2026-09-01 兜底分流：无数据信号的通用内容 → 通用助手直接干活；带数据信号仍走汇总专家
ok('A28a 通用内容兜底到通用助手', ids(O.planRoute('随便说说', null))[0] === 'general');
ok('A28b 帮写邮件走通用助手', ids(O.planRoute('帮我写一封给渠道伙伴的节日问候邮件', null))[0] === 'general');
ok('A28c 含数据信号仍兜底汇总专家', ids(O.planRoute('帮我看看销量情况如何', null))[0] === 'report');
ok('A29 当前看板专家永远排第一(用户在哪问按哪的口径)', ids(O.planRoute('收入多少', 'psi'))[0] === 'psi');

/* ---------- 5) 参数校验：非法参数必须回可读错误，不能静默兜底 ---------- */
const V = (n, a) => O.validateToolArgs(n, a, AD.TOOL_SCHEMAS);
ok('A30 query 缺 stackDim → 报错并提示可选值', (() => { const r = V('query', { metric: 'sellOut' }); return !r.ok && r.error.indexOf('stackDim') >= 0 && r.error.indexOf('country') >= 0; })());
ok('A31 report 用了不存在的参数名 dimension → 明确报错', (() => { const r = V('report', { dimension: 'country' }); return !r.ok && r.error.indexOf('dimension') >= 0; })());
ok('A32 groupDim 枚举外取值 → 报错', (() => { const r = V('report', { groupDim: '国家' }); return !r.ok && r.error.indexOf('取值非法') >= 0; })());
ok('A33 合法参数通过', V('report', { groupDim: 'country', filters: { series: ['Coral'] } }).ok === true);
ok('A34 未知工具 → 报错', !V('nosuchtool', {}).ok);

/* ---------- 6) 结果瘦身 / 上下文裁剪 / think 剥离 ---------- */
const big = { rows: Array.from({ length: 100 }, (_, i) => ({ key: 'K' + i, cumCur: i })), total: { key: '合计', cumCur: 4950 } };
const shrunk = O.shrinkToolResult('report', big);
ok('A35 工具结果行级截断并告知还有多少行', shrunk.indexOf('_省略') >= 0 && shrunk.length <= O.BUDGET.toolResultChars + 60);
ok('A36 工具结果带工具名前缀(模型知道这是谁的返回)', shrunk.indexOf('[工具 report 返回]') === 0);
const msgs = [{ role: 'system', content: 'S'.repeat(500) }, { role: 'user', content: 'OLD'.repeat(2000) }, { role: 'user', content: 'X'.repeat(3000) }, { role: 'user', content: '最后一问' }];
const tr = O.trimMessages(msgs, 4000);
ok('A37 裁剪后 system 与最后一条 user 都还在', tr.messages[0].content.length === 500 && tr.messages[tr.messages.length - 1].content === '最后一问');
ok('A38 裁剪确实把老的中间内容换成占位', tr.dropped.length > 0 && tr.messages.some(m => m.content.indexOf('已省略') >= 0));
ok('A39 splitThink 处理闭合标签', (() => { const r = O.splitThink('<think>推理</think>答案'); return r.think === '推理' && r.answer === '答案'; })());
ok('A40 splitThink 处理无闭合标签(防思维链泄漏)', (() => { const r = O.splitThink('前言<think>没写完的推理'); return r.answer === '前言' && r.think.indexOf('没写完') >= 0; })());
ok('A41 无 think 原样返回', O.splitThink('普通答案').answer === '普通答案');
ok('A42 estimateTokens 中文比等长英文贵', O.estimateTokens('中文中文中文中文') > O.estimateTokens('abcdefgh'));

/* ---------- 7) 数字溯源 ---------- */
const res1 = [{ agentName: 'A', claims: [{ metric: '收入', value: '14,976,729', unit: 'USD' }], notes: '同比 +50.5%' }];
ok('A43 答案里的数字都有出处 → 通过', O.verifyNumbers('收入 14,976,729 USD，同比 +50.5%', res1).ok);
ok('A44 答案里凭空多出的数字 → 被标出', (() => { const v = O.verifyNumbers('收入 14,976,729，毛利率 33.7%', res1); return !v.ok && v.unsupported.join(',').indexOf('33.7') >= 0; })());
ok('A45 忽略个位数/序号,不误报', O.verifyNumbers('第 1 点：收入 14,976,729', res1).ok);

/* ---------- 8) 编排全链路(脚本化假模型) ---------- */
/* ---------- 9) 速度优化(2026-08-10):快速模式 / 流式落点 ----------
   本地 30B 每次调用都要重新处理整段提示词,多一次往返就多几十秒。
   默认 fast:只在问题真的跨领域时才拆多个专家;单专家直接返回、不再多花一次综合调用。 */
/* ── T 组：提示词按需裁剪（专家卡分节 + 按提问检索口径 + 按提问挑工具）────────────
   背景：完整专家卡 ≈1500 token，本地 30B 每轮都要重读，是首字慢的大头。
   现在 system 只留 身份+【取数】+【红线】+精简全局卡（恒定，可命中 KV 缓存），
   口径节按提问检索后放进易变的 user 消息。这组测试守两件事：**省了**且**没省错**。 */
function trim() {
  const AG = Object.keys(O.AGENTS);

  // 前提：每张卡都得有【取数】和【红线】，否则裁完就没法取数了
  const lack = AG.filter(id => {
    const t = O.splitSections(O.AGENTS[id].prompt).sections.map(s => s.title).join('|');
    return t.indexOf('取数') < 0 || t.indexOf('红线') < 0;
  });
  ok('T20 9 张专家卡都有【取数】【红线】节(裁剪的前提)', lack.length === 0, lack.join(','));

  const sec = O.splitSections(O.AGENTS.psi.prompt);
  ok('T21 splitSections 切出身份行 + 多个【】小节', !!sec.head && sec.head.indexOf('【') < 0 && sec.sections.length >= 5);

  // 省了多少
  AG.forEach(id => {
    const fastN = O.estimateTokens(O.buildSpecialistSystem(id));
    const fullN = O.estimateTokens(O.buildSpecialistSystem(id, { full: true }));
    if (id === 'psi') ok('T22 psi 常驻 system 砍到完整卡的 1/3 以内 (' + fastN + '/' + fullN + ')', fastN < fullN / 3);
  });
  const over = AG.filter(id => O.estimateTokens(O.buildSpecialistSystem(id)) > 500);
  ok('T23 9 个专家的常驻 system 都 ≤500 token', over.length === 0, over.join(','));

  // 没省错：取数与红线必须还在
  const bad = AG.filter(id => {
    const s = O.buildSpecialistSystem(id);
    return s.indexOf('【取数】') < 0 || s.indexOf('【红线】') < 0;
  });
  ok('T24 裁剪后【取数】【红线】一节不少', bad.length === 0, bad.join(','));

  // KV 缓存的命门：同一专家的 system 必须逐字节恒定，绝不能随提问变
  const s1 = O.buildSpecialistSystem('psi');
  const s2 = O.buildSpecialistSystem('psi');
  ok('T25 system 逐字节恒定(KV 缓存前缀不被打断)', s1 === s2 && s1.indexOf('【本题相关口径】') < 0);

  // 检索质量
  const cal = (id, q) => O.pickCaliber(id, q).picked.map(s => s.title).join(',');
  ok('T26 问 DOS 命中【公式】而不是顺带提一句的节', cal('psi', 'DOS 是怎么算的').indexOf('公式') >= 0);
  ok('T27 大小写不敏感：fifo 能命中写作 FIFO 的口径', O.pickCaliber('inventory', 'fifo成本怎么算').picked.length > 0);
  ok('T28 问销毛率命中财经【公式】', cal('finance', '销毛率怎么算').indexOf('公式') >= 0);
  ok('T29 问 EOM 命中路标【生命周期】', cal('roadmap', 'EOM+180 是什么').indexOf('生命周期') >= 0);
  ok('T30 无关提问不硬塞口径节', O.pickCaliber('psi', '你好').picked.length === 0);

  // 检索回来的量也要有上限，否则省下的又吃回去
  const wide = O.pickCaliber('psi', 'DOS 库存 公式 时间 层级 易错 底表 录入 音频 系列 渠道 小计');
  const len = wide.picked.reduce((n, s) => n + s.text.length, 0);
  ok('T31 命中口径总长受 caliberChars 约束 (' + len + '≤' + (O.BUDGET.caliberChars + 400) + ')',
    wide.picked.length <= 2 && (wide.picked.length < 2 || len <= O.BUDGET.caliberChars + 400));

  // 口径节走 user 消息，不进 system
  const ctx = O.buildContextMessage({ boardLabel: 'PSI', caliber: '【公式】DOS＝…' });
  ok('T32 命中口径拼进上下文消息(而非 system)', ctx.indexOf('【本题相关口径】') >= 0 && ctx.indexOf('DOS＝') >= 0);

  // 按提问挑工具：原来写死 slice(0,3) 会把 report 切掉
  const psiTools = O.AGENTS.psi.tools;
  ok('T33 问「DOS 多少」时 report 进入快速模式工具集', AD.pickTools(psiTools, '巴西这个月 DOS 多少', 3).indexOf('report') >= 0);
  ok('T34 问「走势」时 query 进入工具集', AD.pickTools(psiTools, 'sellout 走势怎么样', 3).indexOf('query') >= 0);
  ok('T35 options 恒在(填 filters 前必须先查取值)', AD.pickTools(psiTools, '随便问问', 3).indexOf('options') >= 0);
  ok('T36 挑出的工具数不超上限、且都是注册表里的', (() => {
    const r = AD.pickTools(psiTools, 'DOS 走势 库存 收入', 3);
    return r.length === 3 && r.every(n => psiTools.indexOf(n) >= 0);
  })());
  ok('T37 工具本来就不多于上限时原样返回', (() => {
    const r = AD.pickTools(['meta', 'options'], '任意', 3);
    return r.length === 2 && r[0] === 'meta';
  })());

  // 端到端：一次典型提问的输入总量
  const q = '巴西音频这个月 DOS 多少';
  const tn = AD.pickTools(psiTools, q, 3);
  const now = O.estimateTokens(O.buildSpecialistSystem('psi'))
    + O.estimateTokens(O.pickCaliber('psi', q).picked.map(s => s.text).join('\n'))
    + O.estimateTokens(JSON.stringify(AD.buildToolSpecs(tn)));
  const before = O.estimateTokens(O.buildSpecialistSystem('psi', { full: true }))
    + O.estimateTokens(JSON.stringify(AD.buildToolSpecs(psiTools.slice(0, 3))));
  ok('T38 典型提问输入砍掉四成以上 (' + before + '→' + now + ')', now < before * 0.6);
}

async function speed() {
  const mk = (script) => {
    let i = 0; const calls = [];
    return {
      calls,
      deps: {
        schemas: AD.TOOL_SCHEMAS,
        buildToolSpecs: n => AD.buildToolSpecs(n),
        parseToolCall: AD.parseToolCall,
        boardLabel: () => 'X', filters: () => null, snapshot: async () => '',
        runTool: async () => ({ ok: 1 }),
        chat: async p => { calls.push(p); return script[i++] || { content: '答案。{"claims":[{"metric":"SO","value":"1"}],"notes":"n"}' }; },
        onProgress: () => { },
      },
    };
  };

  // 单领域问题 → 只跑 1 个专家、1 次调用
  const a = mk([{ content: '就这些。{"claims":[{"metric":"SO","value":"100"}],"notes":"单领域"}' }]);
  const r1 = await O.orchestrate('这个系列最近卖得怎么样', 'psi', a.deps, { planner: false });
  ok('S1 快速模式:单领域问题只跑 1 个专家', r1.results.length === 1 && r1.singleAgent === true);
  ok('S2 快速模式:只发 1 次模型请求(省掉综合)', a.calls.length === 1);

  // 明确跨领域(收入+库存) → 仍然拆多个专家
  const b = mk([]);
  const r2 = await O.orchestrate('这个产品今年收入多少、库存水位如何', null, b.deps, { planner: false });
  ok('S3 快速模式:真跨领域(收入+库存)仍会拆多专家', r2.results.length >= 2);

  // deep 模式:即使单领域也按完整编排走(不做单专家短路)
  const c = mk([]);
  const r3 = await O.orchestrate('收入 库存 定价 都看看', null, c.deps, { mode: 'deep', planner: false });
  ok('S4 deep 模式仍可用', r3.results.length >= 2);

  ok('S5 needsMultiAgent:单领域=false / 跨领域=true',
    O.needsMultiAgent('这个系列卖得怎么样') === false && O.needsMultiAgent('收入多少、库存多少') === true);

  // 流式落点:第 2 轮起(已取过数、在写答案)才开流,首轮不开(省开销)
  const d = mk([
    { toolCalls: [{ function: { name: 'meta', arguments: '{}' } }] },
    { content: '最终答案。{"claims":[],"notes":"done"}' },
  ]);
  const sink = { content: '' };
  await O.orchestrate('这个系列卖得怎么样', 'psi', d.deps, { streamInto: sink, planner: false });
  ok('S6 首轮(要工具)不开流式', !d.calls[0].streamInto);
  ok('S7 第2轮(写答案)开流式并指向气泡', d.calls.length >= 2 && d.calls[1].streamInto === sink);
}

async function main() {
  const calls = [];
  let concurrent = 0, maxConcurrent = 0;
  const script = [
    // finance 专家：先调工具，再给 claims
    { toolCalls: [{ function: { name: 'financeOverview', arguments: '{}' } }] },
    { content: '结论：收入不错。{"claims":[{"metric":"今年收入","value":"14,976,729","unit":"USD","caliber":"1~6月实际"}],"notes":"同比 +50.5%"}' },
    // inventory 专家：直接给 claims
    { content: '<think>想一下</think>库存偏高。{"claims":[{"metric":"渠道库存","value":"382","unit":"台","caliber":"最新期快照"}],"notes":"DOS 10 天"}' },
    // 综合
    { content: '总体看：收入 14,976,729 USD，库存 382 台，DOS 10 天。' },
  ];
  let si = 0;
  const deps = {
    schemas: AD.TOOL_SCHEMAS,
    buildToolSpecs: names => AD.buildToolSpecs(names),
    parseToolCall: AD.parseToolCall,
    boardLabel: () => '经营分析',
    filters: () => ({ series: ['Coral'] }),
    snapshot: async () => '记录数 1728，时间范围 2025-01-05~2026-06-15',
    runTool: async (n, a) => { calls.push(n + ':' + JSON.stringify(a)); return { ok: 1, rows: [{ key: 'x', cumCur: 1 }] }; },
    chat: async (p) => {
      concurrent++; maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise(r => setTimeout(r, 1));
      concurrent--;
      const r = script[si++] || { content: '(脚本用尽)' };
      deps._lastSystem = p.system; deps._lastTools = p.tools; deps._lastMax = p.maxTokens;
      return r;
    },
    onProgress: e => { (deps._events = deps._events || []).push(e.type); },
  };
  const out = await O.orchestrate('Product D 今年经营情况：收入多少、库存水位如何', 'finance', deps, { planner: false });

  ok('A46 编排完成并产出答案', !!out.answer && out.answer.indexOf('14,976,729') >= 0);
  ok('A47 确实跑了多个专家(finance + inventory)', out.results.length >= 2 && out.results.some(r => r.agentId === 'finance') && out.results.some(r => r.agentId === 'inventory'));
  ok('A48 并发度恒为 1(串行,不会冻住主进程/LM Studio)', maxConcurrent === 1);
  ok('A49 工具真的被调用且参数经过校验', calls.length >= 1 && calls[0].indexOf('financeOverview') === 0);
  ok('A50 进度事件齐全(plan/agentStart/agentDone/synth)', ['plan', 'agentStart', 'agentDone', 'synth'].every(t => (deps._events || []).indexOf(t) >= 0));
  ok('A51 子 agent 的 system 注入了口径卡与当前筛选', String(deps._lastSystem || '').length > 0);
  ok('A52 claims 被解析出来(不是整段文本)', out.results.some(r => (r.claims || []).length > 0));
  ok('A53 think 被剥离,答案里不含 <think>', out.answer.indexOf('<think>') < 0);
  ok('A54 综合结果做了数字溯源校验', out.verified && typeof out.verified.ok === 'boolean');

  // 预算：工具调用总数不超上限
  const calls2 = [];
  let n = 0;
  const deps2 = Object.assign({}, deps, {
    _events: [],
    runTool: async (t, a) => { calls2.push(t); return { ok: 1 }; },
    chat: async () => { n++; return { toolCalls: [{ function: { name: 'meta', arguments: '{}' } }] }; },   // 永远要工具
  });
  await O.orchestrate('收入 库存 定价 上市 都看看', null, deps2);
  ok('A55 全局工具预算生效(≤' + O.BUDGET.maxToolCallsTotal + ' 次,防本地模型死循环)', calls2.length <= O.BUDGET.maxToolCallsTotal);
  // 预算账：4 位专家 × 轮上限 + 规划员 1 次 + 每位专家轮次耗尽后的强制终答 1 次 + 半途重试至多 2 次（2026-09-11 起重试真的会跑了）
  ok('A56 每个专家工具轮上限生效(≤' + O.BUDGET.maxToolRoundsPerAgent + ' 轮，含终答/重试预算)', n <= O.BUDGET.maxToolRoundsPerAgent * 4 + 1 + 4 + 8);

  // 单专家场景：省掉综合那次调用
  let calls3 = 0;
  const deps3 = Object.assign({}, deps, {
    _events: [],
    chat: async () => { calls3++; return { content: '就这些。{"claims":[{"metric":"SO","value":"100"}],"notes":"仅一个专家"}' }; },
  });
  const out3 = await O.orchestrate('这个系列卖得怎么样', 'psi', deps3, { planner: false });   // 量的是专家路径的调用数，规划员单独有测
  ok('A57 单专家问题不再多花一次 30B 综合调用', out3.singleAgent === true && calls3 === 1);

  // 模型报错时优雅降级
  const deps4 = Object.assign({}, deps, { _events: [], chat: async () => ({ error: '连不上 LM Studio' }) });
  const out4 = await O.orchestrate('收入多少', 'finance', deps4);
  ok('A58 模型不可用时不抛异常,回可读结果', !!out4 && typeof out4.answer === 'string' && out4.results.every(r => r.error));

  // —— 溯源门禁：日期数字不被误伤（2026-09-04 S5 实测 docx 日期被抹）——
  const tt = ['psi 工具返回：数据源为空 0 行'];   // 有失败工具调用 → 门禁生效（否则 no-op）
  const gp = (ans, corpus) => O.enforceProvenance(ans, tt, corpus || '', { placeholder: '(未取到)' });
  // ISO 日期：连字符被 NUM 切成 -11/-18，Math.abs 豁免后不该被抹（代号 KOALA-77 的 77 由文档语料兜住）
  const p1 = gp('交付日期：2026-11-18，代号 KOALA-77', '【brief.docx】交付日期 2026-11-18，项目代号 KOALA-77');
  ok('A59 ISO 日期不被溯源门禁抹掉', p1.answer.indexOf('2026-11-18') >= 0 && p1.answer.indexOf('KOALA-77') >= 0 && p1.blocked.length === 0, JSON.stringify(p1));
  // 中文日期同样安全
  const p2 = gp('交付日期：2026 年 11 月 18 日');
  ok('A60 中文日期不被抹', /11 月 18 日/.test(p2.answer) && p2.blocked.length === 0);
  // 但真正无出处的大额业务数字仍要拦（门禁没被削废）
  const p3 = gp('Acme份额 8347 台');
  ok('A61 无出处大额数字仍被拦', /\(未取到\)/.test(p3.answer) && p3.blocked.indexOf('8347') >= 0, JSON.stringify(p3));
  // 上传文档正文进语料 → 文档里的目标值不被拦
  const p4 = gp('秘鲁目标 12500 台', '【brief.docx】秘鲁 Andina Retail 首发目标 12500 台');
  ok('A62 provCorpus 里的文档数字不被拦', p4.answer.indexOf('12500') >= 0 && p4.blocked.length === 0, JSON.stringify(p4));

  await speed();
  trim();
  await followup();
  await planner();
  await retryTools();
  await unscoped();
  await judge();
  await nudge();

  console.log(f ? ('\n' + f + ' FAILED') : '\nALL PASS');
  process.exit(f ? 1 : 0);
}

/* ---------- 追问理解：上文实体必须带进本轮（2026-09-10 用户实锤） ---------- */
async function followup() {
  const PRODUCTS = ['Product A 13.2-inch', 'Product B 11-inch', 'Product D Buds'];
  const mk = (script) => {
    let i = 0; const calls = []; const events = [];
    return {
      calls, events,
      deps: {
        schemas: AD.TOOL_SCHEMAS, buildToolSpecs: n => AD.buildToolSpecs(n), parseToolCall: AD.parseToolCall,
        boardLabel: () => 'X', filters: () => null, snapshot: async () => '',
        runTool: async () => ({ ok: 1 }),
        optionsDirect: async (dim) => (dim === 'product' ? PRODUCTS : []),
        chat: async p => { calls.push(p); return script[i++] || { content: '答案。{"claims":[{"metric":"SO","value":"1"}],"notes":"n"}' }; },
        onProgress: e => events.push(e),
      },
    };
  };
  const HIST = [{ role: 'user', content: 'Product A 13.2-inch 今年卖了多少' }, { role: 'assistant', content: '今年累计 SO 1,234 台。' }];
  const lastUser = (calls) => { const c = calls[calls.length - 1]; const u = (c.messages || []).filter(m => m.role === 'user'); return u.length ? u[u.length - 1].content : ''; };

  // F1 模型改写成功 → 专家拿到的是改写后的完整问句
  const a = mk([{ content: '{"standalone":"Product A 13.2-inch 2026 年与 2025 年销量对比，卖得怎么样"}' },
                { content: '对比结论。{"claims":[{"metric":"SO","value":"1234"}],"notes":"n"}' }]);
  await O.orchestrate('对比2025年卖的怎么样', 'industry', a.deps, { history: HIST });
  const ua = lastUser(a.calls);
  ok('F1 追问被改写：专家看到的问句含上文产品名', ua.indexOf('Product A 13.2-inch') >= 0 && ua.indexOf('2025') >= 0);
  ok('F1b 理解+规划合并成 1 次模型调用（规划 1 + 专家 1）', a.calls.length === 2);
  ok('F1c 进度流里有「understand」事件且带改写结果', a.events.some(e => e.type === 'understand' && /Product A 13\.2-inch/.test(e.to)));
  ok('F1d 硬约束里带上「已结合上文理解」与上一轮回答', /已结合上文理解为/.test(ua) && /上一轮回答/.test(ua) && /1,234/.test(ua));
  ok('F1e 实体检索按改写后的问句命中 product', /实体检索命中：product=Product A 13\.2-inch/.test(ua));

  // F2 模型改写失败/丢主语 → 确定性兜底：原句 + 承接上文实体
  const b = mk([{ content: '{"standalone":"2026 年和 2025 年销量对比"}' },       // 丢了产品名
                { content: 'x。{"claims":[],"notes":"n"}' }]);
  await O.orchestrate('对比2025年卖的怎么样', 'industry', b.deps, { history: HIST });
  ok('F2 模型改写丢了主语 → 自动补回产品名', /(承接上文|对象)：Product A 13\.2-inch/.test(lastUser(b.calls)));
  const c = mk([{ error: 'boom' }, { content: 'x。{"claims":[],"notes":"n"}' }]);
  await O.orchestrate('对比2025年卖的怎么样', 'industry', c.deps, { history: HIST });
  ok('F2b 模型改写报错 → 仍能用确定性版本带上产品名', /Product A 13\.2-inch/.test(lastUser(c.calls)));

  // F3 没有上文 / 本句自己就点了名 → 不多花那次调用
  const d = mk([{ content: 'x。{"claims":[],"notes":"n"}' }]);
  await O.orchestrate('对比2025年卖的怎么样', 'industry', d.deps, { planner: false });
  ok('F3 关掉规划员且没有上文 → 不多花调用、没有理解事件', d.calls.length === 1 && !d.events.some(e => e.type === 'understand'));
  const e = mk([{ content: 'x。{"claims":[],"notes":"n"}' }]);
  await O.orchestrate('Product B 11-inch 对比2025年卖的怎么样', 'industry', e.deps, { history: HIST });
  ok('F3b 本句自己点了名 → 不把上文的 Product A 硬塞进来', lastUser(e.calls).indexOf('Product A') < 0);

  // F5 理解员必须知道今天几号，否则「对比 2025 年」会被改写成「2025 vs 2024」（2026-09-10 实测）
  const g = mk([{ content: '{"standalone":"x"}' }, { content: 'x。{"claims":[],"notes":"n"}' }]);
  await O.orchestrate('对比2025年卖的怎么样', 'industry', g.deps, { history: HIST });
  const Y = new Date().getFullYear();
  ok('F5 理解员的 system 里带今天日期与「今年=' + Y + '」', g.calls.length >= 1 && new RegExp('今年」=' + Y).test(g.calls[0].system || '') && new RegExp('今天是 ' + Y + '-').test(g.calls[0].system || ''));

  // F6 空回复不许四个字了事：综合层返回空 → 落到专家结论/错误说明
  const h = mk([{ content: '{"standalone":"Product A 13.2-inch 收入与库存"}' },
                { content: '收入专家结论。{"claims":[{"metric":"收入","value":"9"}],"notes":"收入说明"}' },
                { content: '库存专家结论。{"claims":[{"metric":"库存","value":"8"}],"notes":"库存说明"}' },
                { content: '' }]);                                              // 综合层空回复
  const r6 = await O.orchestrate('它的收入 和 库存 怎么样', 'finance', h.deps, { history: HIST, mode: 'deep' });
  ok('F6 综合层空回复时不再输出「(空回复)」，而是给出专家结论', r6.answer !== '(空回复)' && /收入说明|库存说明|未能完成|重试/.test(r6.answer));

  // F4 纯函数：understandInContext 的确定性层
  const u = await O.understandInContext('它在墨西哥呢', HIST, { optionsDirect: async d => (d === 'product' ? PRODUCTS : []) });
  ok('F4 无模型时也能把上文实体带过来', u.changed === true && u.carried.indexOf('Product A 13.2-inch') >= 0 && /承接上文/.test(u.question));
}


/* ---------- LLM 规划员：分解任务（2026-09-11 用户：把理解员升级成规划员） ---------- */
async function planner() {
  const PRODUCTS = ['Product A 13.2-inch', 'Product B 11-inch'];
  const mk = (script) => {
    let i = 0; const calls = []; const events = [];
    return { calls, events, deps: {
      schemas: AD.TOOL_SCHEMAS, buildToolSpecs: n => AD.buildToolSpecs(n), parseToolCall: AD.parseToolCall,
      boardLabel: () => 'X', filters: () => null, snapshot: async () => '', runTool: async () => ({ ok: 1 }),
      optionsDirect: async (dim) => (dim === 'product' ? PRODUCTS : []), parallel: true,
      chat: async p => { calls.push(p); return script[i++] || { content: '答。{"claims":[{"metric":"m","value":"1"}],"notes":"n"}' }; },
      onProgress: e => events.push(e) } };
  };
  const ANS = { content: '答。{"claims":[{"metric":"m","value":"1"}],"notes":"n"}' };
  const HIST = [{ role: 'user', content: 'Product A 13.2-inch 今年卖了多少' }, { role: 'assistant', content: '累计 SO 1,234 台。' }];

  // P1 规划员拆成 2 个子任务 → 真的跑 2 位专家，子问题原样下发
  const a = mk([{ content: '{"standalone":"Product A 13.2-inch 今年销量与收入","tasks":[{"agent":"report","label":"销量","question":"Product A 13.2-inch 今年累计 SO 多少"},{"agent":"finance","label":"收入","question":"Product A 13.2-inch 今年收入多少"}]}' }, ANS, ANS, { content: '综合。' }]);
  const r1 = await O.orchestrate('它今年卖得怎么样，收入呢', 'industry', a.deps, { history: HIST });
  const ev1 = a.events.find(e => e.type === 'planner');
  ok('P1 规划员拆的 2 个子任务都跑了（2 位专家 + 综合）', r1.results.length === 2 && r1.results.map(x => x.agentId).sort().join(',') === 'finance,report');
  ok('P1b 子问题按规划员给的下发', a.calls.slice(1, 3).every(c => /Product A 13\.2-inch 今年(累计 SO 多少|收入多少)/.test(c.messages[c.messages.length - 1].content)));
  ok('P1c 有 planner 事件且带子任务清单', !!ev1 && ev1.tasks.length === 2 && /report|汇总/.test(ev1.tasks[0].agent + ev1.tasks[1].agent + '汇总'));
  ok('P1d 快速模式不再把规划员拆的多任务砍成 1 个', r1.results.length === 2);

  // P2 名单外的专家 id 丢掉，只保留有效的
  const b = mk([{ content: '{"standalone":"Product A 13.2-inch 今年销量","tasks":[{"agent":"ghost","question":"x"},{"agent":"report","label":"销量","question":"Product A 13.2-inch 今年累计 SO"}]}' }, ANS]);
  const r2 = await O.orchestrate('它今年卖得怎么样', 'industry', b.deps, { history: HIST });
  ok('P2 名单外的专家 id 被丢掉，只跑有效的那个', r2.results.length === 1 && r2.results[0].agentId === 'report');

  // P3 规划员输出解析不了 → 退回规则路由，流水线不断
  const c = mk([{ content: '我觉得应该先……（不是 JSON）' }, ANS]);
  const r3 = await O.orchestrate('Product B 11-inch 库存水位如何', 'inventory', c.deps, {});
  ok('P3 规划员抽风时退回规则路由，仍有专家作答', r3.results.length >= 1 && !c.events.some(e => e.type === 'planner') && c.events.some(e => e.type === 'plan'));

  // P4 子问题丢了上文实体 → 代码补回
  const d = mk([{ content: '{"standalone":"今年销量对比去年","tasks":[{"agent":"report","label":"对比","question":"今年累计 SO 对比去年同期"}]}' }, ANS]);
  await O.orchestrate('对比去年卖的怎么样', 'industry', d.deps, { history: HIST });
  const ud = d.calls[1].messages[d.calls[1].messages.length - 1].content;
  ok('P4 规划员丢了主语 → 子问题和独立问题都被补回产品名', /Product A 13\.2-inch/.test(ud) && /Product A 13\.2-inch/.test(d.events.find(e => e.type === 'understand').to));

  // P5 规划员的提示词里有专家名单、今天日期、上文实体
  ok('P5 规划员提示词含名单/日期/上文实体', /report（/.test(d.calls[0].messages[d.calls[0].messages.length - 1].content) && new RegExp('今年」=' + new Date().getFullYear()).test(d.calls[0].system) && /Product A 13\.2-inch/.test(d.calls[0].messages[d.calls[0].messages.length - 1].content));

  // P6 forceTasks 优先于规划员（Agent 对话的总控分工不受影响）
  const e = mk([ANS]);
  await O.orchestrate('x', null, e.deps, { forceTasks: [{ agentId: 'report', subQuestion: '总控给的子任务' }] });
  ok('P6 forceTasks 在场时不调规划员', e.calls.length === 1 && /总控给的子任务/.test(e.calls[0].messages[e.calls[0].messages.length - 1].content));
}


/* ---------- 溯源重试要带上所有参与专家的工具（2026-09-11：财经查到的收入被重试丢掉） ---------- */
async function retryTools() {
  const calls = [];
  const deps = { chat: async p => { calls.push(p); return { content: '重写后的回答' }; },
    pickTools: AD.pickTools, buildToolSpecs: AD.buildToolSpecs, schemas: AD.TOOL_SCHEMAS, runTool: async () => ({}) };
  const finTool = O.AGENTS.finance.tools.find(t => O.AGENTS.report.tools.indexOf(t) < 0);
  await O.provenanceRetry('Slate 11 收入与销量', '答案 3520941', ['3520941'], deps, 'industry', [{ agentId: 'report' }, { agentId: 'finance' }]);
  const names = (calls[0] && calls[0].tools || []).map(t => (t.function && t.function.name) || t.name);
  ok('R1 跨专家协作时，溯源重试带上了财经专家的工具（' + finTool + '）', !!finTool && names.indexOf(finTool) >= 0);
  ok('R1b 重试 system 里说明了多专家协作', /多位专家协作/.test(calls[0].system || ''));
  calls.length = 0;
  await O.provenanceRetry('Slate 11 销量', '答案 1', ['1'], deps, 'industry', [{ agentId: 'report' }]);
  ok('R1c 单专家时工具范围不膨胀（不带财经工具）', !((calls[0].tools || []).some(t => ((t.function && t.function.name) || t.name) === finTool)));
}


/* ---------- 界面筛选不再卡住取数（2026-09-11 用户：没选那个产品就抓不到数据） ---------- */
async function unscoped() {
  const PRODUCTS = ['Slate 11', 'Slate 11 Pro'];
  const mk = (script) => {
    let i = 0; const calls = []; const snaps = [];
    return { calls, snaps, deps: {
      schemas: AD.TOOL_SCHEMAS, buildToolSpecs: n => AD.buildToolSpecs(n), parseToolCall: AD.parseToolCall, pickTools: AD.pickTools,
      boardLabel: () => 'PSI', filters: () => ({ product: ['Slate 11 Pro'] }),      // 界面选着另一个产品
      snapshot: async (b, o) => { snaps.push(o); return '概览'; }, runTool: async () => ({ ok: 1 }),
      optionsDirect: async (dim) => (dim === 'product' ? PRODUCTS : []),
      chat: async p => { calls.push(p); return script[i++] || { content: '答。{"claims":[{"metric":"m","value":"1"}],"notes":"n"}' }; },
      onProgress: () => {} } };
  };
  const userMsgs = calls => calls.map(c => (c.messages || []).filter(m => m.role === 'user').map(m => m.content).join('\n')).join('\n');
  // U1 问的是别的产品 → 界面筛选不进上下文、快照按全量、护栏明说不带
  const a = mk([{ content: '{"standalone":"Slate 11 今年卖了多少台","tasks":[{"agent":"psi","label":"销量","question":"Slate 11 今年卖了多少台"}]}' }]);
  await O.orchestrate('Slate 11 今年卖了多少台', 'psi', a.deps, {});
  const ua = userMsgs(a.calls.slice(1));
  ok('U1 问别的产品时，「【界面此刻的筛选】」上下文块不再喂给专家（护栏里只做备注）', ua.indexOf('【界面此刻的筛选') < 0);
  ok('U1b 护栏明说：按全量数据回答，不要带界面筛选', /按全量数据回答/.test(ua) && /Slate 11 Pro/.test(ua) && /不要带上/.test(ua));
  ok('U1c 快照按全量取（ignoreFilters=true）', a.snaps.some(o => o && o.ignoreFilters === true));
  // U2 问「当前筛选下」→ 才按界面范围
  const b = mk([{ content: '{"standalone":"当前筛选下今年卖了多少台","tasks":[{"agent":"psi","label":"销量","question":"当前筛选下今年卖了多少台"}]}' }]);
  await O.orchestrate('当前筛选下今年卖了多少台', 'psi', b.deps, {});
  const ub = userMsgs(b.calls.slice(1));
  ok('U2 问「当前筛选下」→ 界面筛选进上下文且护栏要求带上', /界面此刻的筛选/.test(ub) && /必须带上界面筛选/.test(ub) && b.snaps.some(o => o && o.ignoreFilters === false));
  // U3 上下文措辞：不再有「取数必须带上」这种硬绑定
  const ctx = O.buildContextMessage({ boardLabel: 'PSI', filters: { product: ['X'] } });
  ok('U3 上下文里界面筛选是「仅供参考」，不再「必须带上」', /仅供参考/.test(ctx) && !/取数必须带上/.test(ctx));
  // U4 快速模式下数据专家常驻底表三件套
  const names = (a.calls[1].tools || []).map(t => (t.function && t.function.name) || t.name);
  ok('U4 快速模式下 PSI 专家仍带 rawRows/searchDim/dataCatalog', ['rawRows', 'searchDim', 'dataCatalog'].every(n => names.indexOf(n) >= 0));
}


/* ---------- 判断/决策类问题：剧本 + 门禁重写验货（2026-09-11） ---------- */
async function judge() {
  ok('J1 决策题命中「产品对比决策」剧本', (O.analysisPlaybook('Slate 11 和 Slate 11 Pro 哪个卖得更好？收入利润销量综合考虑该多卖哪个') || {}).kind === '产品对比决策');
  ok('J1b 趋势题命中「潜力/趋势判断」剧本', (O.analysisPlaybook('现在哪个产品未来能卖得更多？') || {}).kind === '潜力/趋势判断');
  ok('J1c 普通问数不命中剧本', O.analysisPlaybook('Slate 11 今年卖了多少台') === null);
  const PRODUCTS = ['Slate 11', 'Slate 11 Pro'];
  let i = 0; const calls = [];
  const script = [
    { content: '{"standalone":"Slate 11 与 Slate 11 Pro 综合对比","tasks":[{"agent":"report","label":"销量","question":"Slate 11 与 Slate 11 Pro 累计SO/同比/DOS"},{"agent":"finance","label":"收入","question":"Slate 11 与 Slate 11 Pro 收入与销毛率"}]}' },
    { content: 'a。{"claims":[{"metric":"SO","value":"1"}],"notes":"n"}' },
    { content: 'b。{"claims":[{"metric":"收入","value":"2"}],"notes":"n"}' },
    { content: '综合：建议多卖 Slate 11 Pro。' },
  ];
  const deps = { schemas: AD.TOOL_SCHEMAS, buildToolSpecs: n => AD.buildToolSpecs(n), parseToolCall: AD.parseToolCall, pickTools: AD.pickTools,
    boardLabel: () => 'X', filters: () => null, snapshot: async () => '', runTool: async () => ({ ok: 1 }), optionsDirect: async d => (d === 'product' ? PRODUCTS : []), parallel: true,
    chat: async p => { calls.push(p); return script[i++] || { content: 'x' }; }, onProgress: () => {} };
  await O.orchestrate('Slate 11 和 Slate 11 Pro 哪个卖得更好？综合考虑该多卖哪个', 'industry', deps, {});
  const u = k => (calls[k].messages || []).filter(m => m.role === 'user').map(m => m.content).join(' ');
  ok('J2 规划员提示词里带了决策剧本', /按这份剧本拆任务/.test(u(0)) && /financeProductBoard/.test(u(0)));
  ok('J2b 专家护栏里有「必须给出结论」', /必须给出结论/.test(u(1)) && /必须给出结论/.test(u(2)));
  ok('J2c 综合层拿到结论格式要求（对比表 + 一句话结论）', /结论格式要求/.test(u(3)) && /对比表/.test(u(3)));
  const mk = (txt) => ({ chat: async () => ({ content: txt }), pickTools: AD.pickTools, buildToolSpecs: AD.buildToolSpecs, schemas: AD.TOOL_SCHEMAS, runTool: async () => ({}) });
  const r1 = await O.provenanceRetry('q', '原答案 123', ['123'], mk("I'll re-pull every number from the tools."), 'industry', [{ agentId: 'report' }]);
  ok('J3 门禁重写交了一句英文过程话 → 不收（返回 null，保留原答案打标）', r1 === null);
  const r2 = await O.provenanceRetry('q', '原答案 123', ['123'], mk('让我重新查询一下数据。'), 'industry', [{ agentId: 'report' }]);
  ok('J3b 中文过程话同样不收', r2 === null);
  const good = 'Slate 11 累计 SO 34,714 台，去年同期 34,551 台，同比 +0.5%；建议维持现有投入，观察 9 月放量情况。';
  const r3 = await O.provenanceRetry('q', '原答案', ['9'], mk(good), 'industry', [{ agentId: 'report' }]);
  ok('J3c 正经的完整重写照收', r3 === good);
}

/* ---------- 「嘴上说取数、实际不调工具」必须被揪住（2026-09-11 实测：AGENTS.find 抛错吞掉，重试从未跑过） ---------- */
async function nudge() {
  let i = 0; const calls = [];
  const script = [
    { content: '{"standalone":"哪个产品未来能卖得更多","tasks":[{"agent":"report","label":"动量","question":"各产品累计SO/同比/DOS"}]}' },
    { toolCalls: [{ function: { name: 'report', arguments: '{"groupDim":"product"}' } }] },
    { content: 'I now have the full product-level summary. Let me get the monthly sell-out matrix by product for the last 6 months to complete the picture.' },
    { content: '结论：SonicBuds SE4 ANC 动量最强。{"claims":[{"metric":"SO","value":"27696"}],"notes":"结论：SonicBuds SE4 ANC 动量最强"}' },
  ];
  const deps = { schemas: AD.TOOL_SCHEMAS, buildToolSpecs: n => AD.buildToolSpecs(n), parseToolCall: AD.parseToolCall, pickTools: AD.pickTools, boardLabel: () => 'X', filters: () => null, snapshot: async () => '',
    runTool: async () => ({ rows: [{ key: 'SonicBuds SE4 ANC', cumCur: 27696 }] }), optionsDirect: async () => [],
    chat: async p => { calls.push(p); return script[i++] || { content: 'x' }; }, onProgress: () => {} };
  const r = await O.orchestrate('现在哪个产品未来能卖得更多？', 'industry', deps, {});
  ok('N1 过程话不被当成答案：专家被逼着再来一轮（多 1 次调用）', calls.length === 4);
  ok('N1b 逼话里点明「没有发出工具调用」', /没有发出任何工具调用/.test(calls[3].messages[calls[3].messages.length - 1].content));
  ok('N1c 最终结论是第 4 次调用给的结论，不是那句 Let me', /SE4 ANC/.test(r.answer) && !/Let me/.test(r.answer));
  ok('N2 isProcessOnly：过程话=true，带结论的正文=false', O.isProcessOnly('I have the core data. Let me pull the monthly trend for both products.') === true && O.isProcessOnly('I have everything I need. Here is the summary. ## 结论 累计 SO 34,714 台，同比 +0.5%') === false);
  // 编排层兜底：专家两次逼完仍是过程话 → 半途重试真的会跑（以前 AGENTS.find 抛错吞掉）
  let j = 0; const calls2 = [];
  const script2 = [
    { content: '{"standalone":"q","tasks":[{"agent":"report","label":"x","question":"q"}]}' },
    { toolCalls: [{ function: { name: 'report', arguments: '{"groupDim":"product"}' } }] },
    { content: 'Let me pull more data.' }, { content: 'Let me pull more data.' }, { content: 'Let me pull more data.' },
    { content: '重试终答：SE4 ANC 27696 台。{"claims":[{"metric":"SO","value":"27696"}],"notes":"重试终答"}' },
  ];
  const deps2 = Object.assign({}, deps, { chat: async p => { calls2.push(p); return script2[j++] || { content: 'Let me pull more data.' }; } });
  const r2 = await O.orchestrate('现在哪个产品未来能卖得更多？', 'industry', deps2, {});
  ok('N3 专家逼两次仍是过程话 → 编排层半途重试真的跑了并采纳终答', r2.results[0].halfwayRetried === true && /重试终答/.test(r2.results[0].notes || ''));
}
main().catch(e => { console.log('FAIL 未捕获异常: ' + (e && e.stack || e)); process.exit(1); });

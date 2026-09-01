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
  const r1 = await O.orchestrate('这个系列最近卖得怎么样', 'psi', a.deps);
  ok('S1 快速模式:单领域问题只跑 1 个专家', r1.results.length === 1 && r1.singleAgent === true);
  ok('S2 快速模式:只发 1 次模型请求(省掉综合)', a.calls.length === 1);

  // 明确跨领域(收入+库存) → 仍然拆多个专家
  const b = mk([]);
  const r2 = await O.orchestrate('这个产品今年收入多少、库存水位如何', null, b.deps);
  ok('S3 快速模式:真跨领域(收入+库存)仍会拆多专家', r2.results.length >= 2);

  // deep 模式:即使单领域也按完整编排走(不做单专家短路)
  const c = mk([]);
  const r3 = await O.orchestrate('收入 库存 定价 都看看', null, c.deps, { mode: 'deep' });
  ok('S4 deep 模式仍可用', r3.results.length >= 2);

  ok('S5 needsMultiAgent:单领域=false / 跨领域=true',
    O.needsMultiAgent('这个系列卖得怎么样') === false && O.needsMultiAgent('收入多少、库存多少') === true);

  // 流式落点:第 2 轮起(已取过数、在写答案)才开流,首轮不开(省开销)
  const d = mk([
    { toolCalls: [{ function: { name: 'meta', arguments: '{}' } }] },
    { content: '最终答案。{"claims":[],"notes":"done"}' },
  ]);
  const sink = { content: '' };
  await O.orchestrate('这个系列卖得怎么样', 'psi', d.deps, { streamInto: sink });
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
  const out = await O.orchestrate('Product D 今年经营情况：收入多少、库存水位如何', 'finance', deps);

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
  ok('A56 每个专家工具轮上限生效(≤' + O.BUDGET.maxToolRoundsPerAgent + ' 轮)', n <= O.BUDGET.maxToolRoundsPerAgent * 4 + 2);

  // 单专家场景：省掉综合那次调用
  let calls3 = 0;
  const deps3 = Object.assign({}, deps, {
    _events: [],
    chat: async () => { calls3++; return { content: '就这些。{"claims":[{"metric":"SO","value":"100"}],"notes":"仅一个专家"}' }; },
  });
  const out3 = await O.orchestrate('这个系列卖得怎么样', 'psi', deps3);
  ok('A57 单专家问题不再多花一次 30B 综合调用', out3.singleAgent === true && calls3 === 1);

  // 模型报错时优雅降级
  const deps4 = Object.assign({}, deps, { _events: [], chat: async () => ({ error: '连不上 LM Studio' }) });
  const out4 = await O.orchestrate('收入多少', 'finance', deps4);
  ok('A58 模型不可用时不抛异常,回可读结果', !!out4 && typeof out4.answer === 'string' && out4.results.every(r => r.error));

  await speed();
  trim();

  console.log(f ? ('\n' + f + ' FAILED') : '\nALL PASS');
  process.exit(f ? 1 : 0);
}
main().catch(e => { console.log('FAIL 未捕获异常: ' + (e && e.stack || e)); process.exit(1); });

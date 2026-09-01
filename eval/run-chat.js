/* 多轮会话连通性测试（Agent 对话看板的问答环节，2026-08-31 用户令：连环发问跑通）
 *
 * 与线上完全同构：
 *   - 历史注入用 app/chat-context-core.js 的 buildHistory（与 agentchat-view.js send() 同一份代码）
 *   - 编排走 app/ai-orchestrator.js orchestrate + eval/engine-tools.js registry（评测同源）
 *   - 文档上传 = 文档前缀 + 历史 + 当前问题（同 send() 组装顺序）
 *   - makeExcel/makePpt/openBoard 为 UI 侧工具，此处拦截记账并返回模拟成功
 *
 * 用法（key 只读不打印）：
 *   node eval/run-chat.js --base https://api.deepseek.com/v1 --model deepseek-chat --key-file eval/deepseek.key
 *   node eval/run-chat.js --only A,B          # 只跑指定场景
 *
 * 判分是连通性断言（must/mustNot 正则 + 工具调用记账），不是能力评测——
 * 目标是抓「音频会话答平板」这类上下文断裂，不是打分。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const O = require(path.join(__dirname, '..', 'app', 'ai-orchestrator.js'));
const AD = require(path.join(__dirname, '..', 'app', 'ai-context.js'));
const CTX = require(path.join(__dirname, '..', 'app', 'chat-context-core.js'));
const { mountEngine, buildRegistry } = require('./engine-tools.js');

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : d; };
const BASE = (arg('base', 'https://api.deepseek.com/v1') || '').replace(/\/$/, '');
const MODEL = arg('model', 'deepseek-chat');
const ONLY = (arg('only', '') || '').split(',').map(s => s.trim()).filter(Boolean);
let KEY = arg('key', process.env.EVAL_API_KEY || '');
const KEYFILE = arg('key-file', '');
if (!KEY && KEYFILE) { try { KEY = fs.readFileSync(path.resolve(KEYFILE), 'utf8').trim(); } catch (e) {} }
if (!KEY) { try { KEY = fs.readFileSync(path.join(__dirname, 'deepseek.key'), 'utf8').trim(); } catch (e) {} }
if (!KEY) { try { KEY = fs.readFileSync(path.join(__dirname, 'minimax.key'), 'utf8').trim(); } catch (e) {} }

if (/pro|reasoner|thinking|r1|m3/i.test(MODEL)) {
  O.BUDGET.subAgentTokens = Math.max(O.BUDGET.subAgentTokens * 3, 6000);
  O.BUDGET.synthTokens = Math.max(O.BUDGET.synthTokens * 3, 6000);
  O.BUDGET.maxToolRoundsPerAgent = Math.max(O.BUDGET.maxToolRoundsPerAgent, 8);
  O.BUDGET.maxToolCallsTotal = Math.max(O.BUDGET.maxToolCallsTotal, 24);
}

async function chatOnce(req) {
  const body = {
    model: MODEL, temperature: 0.1, stream: false, max_tokens: req.maxTokens || 800,
    messages: [{ role: 'system', content: req.system }].concat(req.messages || []),
  };
  if (req.tools && req.tools.length) { body.tools = req.tools; body.tool_choice = 'auto'; }
  try {
    const ctrl = new AbortController(); const to = setTimeout(() => ctrl.abort(), 300000);
    const r = await fetch(BASE + '/chat/completions', {
      method: 'POST', signal: ctrl.signal,
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + KEY },
      body: JSON.stringify(body),
    });
    clearTimeout(to);
    if (!r.ok) return { error: 'HTTP ' + r.status + ' ' + (await r.text()).slice(0, 200) };
    const j = await r.json();
    const m = (j.choices && j.choices[0] && j.choices[0].message) || {};
    return { content: m.content || '', toolCalls: m.tool_calls || null };
  } catch (e) { return { error: String((e && e.message) || e) }; }
}
async function chat(req) {
  const a = await chatOnce(req);
  if (a && !a.error && (String(a.content || '').trim() || (a.toolCalls && a.toolCalls.length))) return a;
  await new Promise(r => setTimeout(r, 2000));
  return chatOnce(req);
}

(async () => {
  const engine = await mountEngine({});
  const registry = buildRegistry(engine);
  const cat = engine.catalog();

  // —— 从目录动态取实体（场景与挂载数据自洽，换数据集不用改题）——
  const lines = (cat.psi && cat.psi.lines) || [];
  const findLine = (re) => lines.find(l => re.test(l.line)) || null;
  const audio = findLine(/音频|audio|耳机/i);
  const tablet = findLine(/平板|tablet|pad/i);
  const pick = (l, want) => { // 取该产线下一个系列名
    if (!l) return null;
    for (const f of l.families || []) for (const sr of f.series || []) if (sr.series && sr.series !== '-') return sr.series;
    return null;
  };
  const audioSeries = pick(audio) || '音频';
  const tabletSeriesAll = tablet ? (tablet.families || []).flatMap(f => (f.series || []).map(s => s.series)).filter(s => s && s !== '-') : [];
  const country = (cat.psi && cat.psi.countries && cat.psi.countries[0]) || '墨西哥';
  console.log('[实体] 音频系列=' + audioSeries + '  平板系列=' + tabletSeriesAll.join('/') + '  国家=' + country);

  // —— 场景集：每场景一个 session，轮与轮之间靠 buildHistory 连接 ——
  const DOC = '【会议纪要-机密】2026年Q4音频线主推产品定为 ZephyrX9 无线耳机，上市目标铺货 5000 家门店，' +
    '首销期定价策略为直降 15 美元，主打卖点是 48 小时续航与开放式佩戴。平板线 Q4 无新品，维持现有阵容促销。';
  const SCEN = [
    {
      id: 'A', name: '音频追问（复刻实锤：追问为什么查不到，不许跑去答平板）',
      turns: [
        { q: audioSeries + '今年1-7月的SO同比去年怎么样？', must: ['\\d|未取到|不在底表'] },
        { q: '为什么查不到数据？', must: [audioSeries + '|音频|耳机|口径|期间|字段'], mustNot: tabletSeriesAll.length ? [tabletSeriesAll.join('|')] : [] },
        { q: '那换成平板整体呢？', must: ['平板'], hint: '须继承1-7月/SO/同比口径', soft: ['1[\\s-~至到]*7月|同比|SO'] },
      ],
    },
    {
      id: 'B', name: '指代承接（它=上一轮实体；表格化引用前两轮）',
      turns: [
        { q: country + '的平板2026年SO总量是多少？', must: ['\\d'] },
        { q: '它的均价呢？', must: ['均价|价格|ASP|美元|USD|\\$'], mustNot: [] },
        { q: '把上面两轮的结果整理成一个表格', must: ['\\|.+\\|'] },
      ],
    },
    {
      id: 'C', name: '文档记忆（上传纪要后连环问，第二问靠历史+文档双记忆）',
      files: [{ name: 'Q4规划纪要.txt', content: DOC }],
      turns: [
        { q: '根据我上传的文档，Q4音频线主推什么产品？', must: ['ZephyrX9'] },
        { q: '它的铺货目标是多少家门店？', must: ['5000|5,000'] },
      ],
    },
    {
      id: 'D', name: '生成文件（makeExcel 工具链路）',
      turns: [
        { q: '把音频线2026年各系列的SO整理成一个Excel文件给我', tool: 'makeExcel' },
      ],
    },
    (function () {
      // 场景 E：真实 xlsx 上传——走线上同一条解析路径（office-text-core），连环三问
      const { extractOfficeText } = require(path.join(__dirname, '..', 'app', 'office-text-core.js'));
      const fx = path.join(__dirname, '..', 'fixtures', 'sample-prices.xlsx');
      if (!fs.existsSync(fx)) { try { require('child_process').execSync('node ' + JSON.stringify(path.join(__dirname, 'make-fixtures.js'))); } catch (e) {} }
      const xtxt = extractOfficeText(fs.readFileSync(fx));
      return {
        id: 'E', name: 'Excel 上传（xlsx 解析注入 + 定位/指代计算/跨sheet）',
        files: [{ name: 'sample-prices.xlsx', content: xtxt }],
        turns: [
          { q: '我上传的Excel里，平板竞品促销价最便宜的是哪家的哪个型号？多少钱？', must: ['辰星', 'X11', '179'] },
          { q: '它比表里促销价最贵的平板便宜多少钱？', must: ['120'] },
          { q: '音频那个sheet里，头戴式耳机是什么价格？', must: ['澄海|StudioGo', '115|129'] },
        ],
      };
    })(),
    (function () {
      // 场景 F：总控并行分工——双 sheet Excel 拆两路 Agent 并行，各管一个 sheet 后汇总
      const { extractOfficeText } = require(path.join(__dirname, '..', 'app', 'office-struct-core.js')) && require(path.join(__dirname, '..', 'app', 'office-text-core.js'));
      const fx = path.join(__dirname, '..', 'fixtures', 'sample-prices.xlsx');
      const xtxt = fs.existsSync(fx) ? extractOfficeText(fs.readFileSync(fx)) : '';
      return {
        id: 'F', name: '总控并行（多sheet 拆多 Agent，走线上同一份 masterPlan）',
        files: [{ name: 'sample-prices.xlsx', content: xtxt }],
        masterPlan: true,
        turns: [
          { q: '帮我分析这个价格监测表，平板和音频各自最便宜的竞品是哪个？', must: ['辰星.{0,20}X11|X11', '星潮.{0,20}Buds|星潮'], mustNot: ['无法回答|数据未包含|不包含任何|查不到'], soft: ['179', '29'] },
        ],
      };
    })(),
  ].filter(s => !ONLY.length || ONLY.indexOf(s.id) >= 0);

  const results = [];
  for (const sc of SCEN) {
    console.log('\n━━ 场景 ' + sc.id + '：' + sc.name);
    const sess = { msgs: [], histNote: '' };
    const uiTools = [];
    const deps = {
      chat,
      runTool: async (n, a) => {
        if (n === 'makeExcel' || n === 'makePpt' || n === 'openBoard') {
          uiTools.push(n);
          return { ok: true, file: '(测试模拟)' + n + '-output', note: '测试环境模拟成功' };
        }
        const fn = registry[n];
        return fn ? await fn(a) : { error: '未知工具: ' + n };
      },
      optionsDirect: async (field) => registry.options({ field }),
      catalogDirect: async () => { try { return engine.catalog(); } catch (e) { return null; } },
      provRetry: true,
      parallel: true,
      schemas: AD.TOOL_SCHEMAS, buildToolSpecs: AD.buildToolSpecs,
      pickTools: AD.pickTools, parseToolCall: AD.parseToolCall,
      snapshot: async () => '', filters: () => null,
      boardLabel: () => 'Agent 对话（测试）', onProgress: () => {},
    };
    for (let ti = 0; ti < sc.turns.length; ti++) {
      const turn = sc.turns[ti];
      const hist = CTX.buildHistory(sess);                     // ← 与 send() 同一份逻辑
      sess.msgs.push({ role: 'user', content: turn.q });
      let fullQ = hist ? hist + '【当前问题】' + turn.q : turn.q;
      // 总控分工（与线上同一份 masterPlan）：命中则材料拆进各任务，主问题不再注入全量文档
      let forceTasks = null;
      if (sc.masterPlan) {
        const plan = CTX.masterPlan(turn.q, sc.files);
        if (plan) { forceTasks = plan.tasks; console.log('   🧠 总控：' + plan.note); }
      }
      if (sc.files && sc.files.length && !forceTasks) {
        const docs = sc.files.map(f => '【用户上传文档：' + f.name + '】\n' + f.content).join('\n\n');
        fullQ = docs.slice(0, 80000) + '\n\n' + hist + '【当前问题】' + turn.q;
      }
      uiTools.length = 0;
      const t0 = Date.now();
      let res;
      for (let att = 0; att < 3; att++) {
        try { res = await O.orchestrate(fullQ, null, deps, { mode: forceTasks ? 'deep' : 'fast', forceTasks }); }
        catch (e) { res = { answer: '', error: String((e && e.message) || e) }; console.log('   [异常] ' + String((e && e.stack) || e).split('\n').slice(0, 3).join(' | ')); }
        const t = String((res && res.answer) || '').trim();
        if (t && t.replace(/[\s#*|>-]/g, '').length >= 30) break;
        if (att < 2) console.log('   （空回复，重跑 ' + (att + 1) + '/2）');
      }
      const ans = String((res && res.answer) || '');
      sess.msgs.push({ role: 'ai', content: ans });
      // —— 断言 ——
      const fails = [];
      if (!ans.trim()) fails.push('空回复×3');
      (turn.must || []).forEach(re => { if (!new RegExp(re, 'i').test(ans)) fails.push('缺必答: /' + re.slice(0, 40) + '/'); });
      (turn.mustNot || []).forEach(re => { if (re && new RegExp(re, 'i').test(ans)) fails.push('答了不该答的: /' + re.slice(0, 40) + '/'); });
      if (turn.tool && uiTools.indexOf(turn.tool) < 0) fails.push('未调用工具 ' + turn.tool + '（实际: ' + (uiTools.join(',') || '无') + '）');
      const softMiss = (turn.soft || []).filter(re => !new RegExp(re, 'i').test(ans));
      const ok = fails.length === 0;
      const secs = ((Date.now() - t0) / 1000).toFixed(1);
      console.log('  轮' + (ti + 1) + ' ' + (ok ? 'PASS' : 'FAIL') + ' ' + secs + 's  ' + turn.q.slice(0, 30));
      if (!ok) fails.forEach(f => console.log('       ✗ ' + f));
      if (softMiss.length) console.log('       ~ 软警(不判负): ' + softMiss.join(' '));
      console.log('       答: ' + ans.replace(/\n/g, ' ').slice(0, 160));
      results.push({ scen: sc.id, turn: ti + 1, q: turn.q, ok, fails, softMiss, latencyS: +secs, answer: ans, ctxPct: CTX.ctxPct(sess) });
    }
    console.log('  [上下文用量 ' + CTX.ctxPct(sess) + '%]');
  }

  const pass = results.filter(r => r.ok).length;
  console.log('\n===== 会话连通性: ' + pass + '/' + results.length + ' PASS =====');
  results.filter(r => !r.ok).forEach(r => console.log('  FAIL ' + r.scen + '-轮' + r.turn + ': ' + r.fails.join('; ')));
  const dir = path.join(__dirname, 'runs-chat');
  try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {}
  const out = path.join(dir, 'chat-' + new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19) + '.json');
  fs.writeFileSync(out, JSON.stringify({ model: MODEL, base: BASE, results }, null, 1).replace(/[\x7f-￿]/g, c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0')));
  console.log('存档: ' + out);
  process.exit(pass === results.length ? 0 : 1);
})();

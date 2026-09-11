/* 追问连贯性实测（2026-09-10 用户实锤：「X 今年卖了多少」答得出，接着问「对比 2025 年卖得怎么样」
 * 就「取不出数据」）。与看板侧栏同构：第二轮把第一轮的问答作为 opt.history 传给编排层。
 * 数据全是内置合成样例（Product A~F），不含任何真实业务数据。key 只读不打印。
 *
 * 用法：node eval/run-followup.js [--model deepseek-chat]
 */
'use strict';
const fs = require('fs'); const path = require('path');
const O = require(path.join(__dirname, '..', 'app', 'ai-orchestrator.js'));
const AD = require(path.join(__dirname, '..', 'app', 'ai-context.js'));
const { mountEngine, buildRegistry } = require('./engine-tools.js');
const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : d; };
const BASE = 'https://api.deepseek.com/v1', MODEL = arg('model', 'deepseek-chat');
let KEY = ''; try { KEY = fs.readFileSync(path.join(__dirname, 'deepseek.key'), 'utf8').trim(); } catch (e) {}
if (!KEY) { console.log('FAIL 没有 eval/deepseek.key'); process.exit(1); }

async function chat(req) {
  const body = { model: MODEL, temperature: 0.1, stream: false, max_tokens: req.maxTokens || 800,
    messages: [{ role: 'system', content: req.system }].concat(req.messages || []) };
  if (req.tools && req.tools.length) { body.tools = req.tools; body.tool_choice = 'auto'; }
  try {
    const r = await fetch(BASE + '/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + KEY }, body: JSON.stringify(body) });
    if (!r.ok) { const t = (await r.text()).slice(0, 300); console.log('   [chat ERR] HTTP ' + r.status + ' ' + t.replace(/\s+/g, ' ')); return { error: 'HTTP ' + r.status + ' ' + t.slice(0, 200) }; }
    const j = await r.json(); const m = (j.choices && j.choices[0] && j.choices[0].message) || {};
    const fin = j.choices && j.choices[0] && j.choices[0].finish_reason;
    if (!m.content && !(m.tool_calls && m.tool_calls.length)) console.log('   [chat EMPTY] finish=' + fin + ' tools=' + ((req.tools || []).length) + ' msgs=' + (req.messages || []).length + ' reasoning=' + String(m.reasoning_content || '').slice(0, 80).replace(/\s+/g, ' '));
    return { content: m.content || '', toolCalls: m.tool_calls || null };
  } catch (e) { console.log('   [chat THROW] ' + String((e && e.message) || e)); return { error: String((e && e.message) || e) }; }
}

(async () => {
  let fails = 0; const ok = (n, c, x) => { console.log((c ? 'PASS ' : 'FAIL ') + n + (!c && x ? '  << ' + x : '')); if (!c) fails++; };
  const engine = await mountEngine({});
  const registry = buildRegistry(engine);
  const prods = await registry.options({ field: 'product' });          // registry 工具都是 async
  const plist = Array.isArray(prods) ? prods : ((prods && (prods['取值'] || (Array.isArray(prods.values) ? prods.values : null) || prods.list)) || []);
  const P = plist.find(x => /\d/.test(String(x))) || plist[0];             // 挑一个带数字后缀的单品名，避开家族名
  if (!P) { console.log('FAIL 取不到样例产品名: ' + JSON.stringify(prods).slice(0, 200)); process.exit(1); }
  console.log('合成样例产品：' + P);
  const events = [];
  const deps = {
    chat,
    runTool: async (n, a) => { const fn = registry[n]; return fn ? await fn(a) : { error: '未知工具: ' + n }; },
    optionsDirect: async (field) => registry.options({ field }),
    catalogDirect: async () => { try { return engine.catalog(); } catch (e) { return null; } },
    provRetry: true, parallel: true,
    schemas: AD.TOOL_SCHEMAS, buildToolSpecs: AD.buildToolSpecs, pickTools: AD.pickTools, parseToolCall: AD.parseToolCall,
    snapshot: async () => '', filters: () => null, boardLabel: () => '产业看板',
    onProgress: e => { events.push(e); if (e.type === 'understand') console.log('   🧠 理解为：' + e.to); if (e.type === 'planner') console.log('   🧭 规划：' + e.tasks.map(t => t.agent + '·' + t.label + '「' + t.question + '」').join(' / ')); if (e.type === 'tool') console.log('   🔧 ' + e.tool + ' ' + JSON.stringify(e.args || {}).slice(0, 120)); },
  };
  const history = [];
  const ask = async (q, opts) => {
    console.log('\n问：' + q);
    const t0 = Date.now();
    const r = await O.orchestrate(q, 'industry', deps, Object.assign({ mode: 'fast', history: history.slice() }, opts || {}));
    const a = String((r && r.answer) || '');
    console.log('答(' + ((Date.now() - t0) / 1000).toFixed(1) + 's)：' + a.replace(/\s+/g, ' ').slice(0, 300));
    try { console.log('   [诊断] ' + JSON.stringify((r.results || []).map(x => ({ agent: x.agentName, err: x.error || null, notes: String(x.notes || '').slice(0, 100), claims: (x.claims || []).length, halfway: !!x.halfwayRetried })))); } catch (e) {}
    history.push({ role: 'user', content: q }, { role: 'assistant', content: a });
    return a;
  };
  const BAD = /(取不出|取不到|无法回答|无法获取|不能回答|没有.{0,6}数据)/;
  const a1 = await ask(P + ' 今年卖了多少台');
  ok('第 1 轮：直接点名，能答出数字', /\d/.test(a1) && !BAD.test(a1), a1.slice(0, 120));
  events.length = 0;
  const a2 = await ask('对比2025年卖的怎么样');
  const und = events.find(e => e.type === 'understand');
  ok('第 2 轮：追问被结合上文改写，且改写里含产品名', !!und && und.to.indexOf(P) >= 0, und ? und.to : '（没有 understand 事件）');
  ok('第 2 轮：真的去取了数（有工具调用）', events.some(e => e.type === 'tool'), '');
  ok('第 2 轮：答出了对比数字，没有「取不出数据」', /\d/.test(a2) && !BAD.test(a2) && /(2025|去年|同期|同比)/.test(a2), a2.slice(0, 160));
  ok('第 2 轮：对象名在改写后的问句或答案里（用户不看上文也知道在说谁）', (und && und.to.indexOf(P) >= 0) || a2.indexOf(P) >= 0, a2.slice(0, 80));
  events.length = 0;
  const a3 = await ask('那它在各个国家呢');
  const und3 = events.find(e => e.type === 'understand');
  ok('第 3 轮：再追问一次仍能接上产品名', !!und3 && und3.to.indexOf(P) >= 0 && /\d/.test(a3) && !BAD.test(a3), (und3 ? und3.to : '无理解') + ' | ' + a3.slice(0, 120));
  events.length = 0;
  const a4 = await ask('它今年卖得怎么样，库存健康吗，收入呢');
  const pl = events.find(e => e.type === 'planner');
  ok('第 4 轮：跨领域问题被规划员拆成 ≥2 个子任务', !!pl && pl.tasks.length >= 2, pl ? JSON.stringify(pl.tasks.map(t => t.agent)) : '无 planner 事件');
  ok('第 4 轮：每个子问题都自包含（含产品名）', !!pl && pl.tasks.every(t => t.question.indexOf(P) >= 0), pl ? JSON.stringify(pl.tasks.map(t => t.question)) : '');
  ok('第 4 轮：综合后有数字、没说取不出', /\d/.test(a4) && !BAD.test(a4), a4.slice(0, 160));
  console.log(fails ? ('\nFAILURES: ' + fails) : '\n===== 追问连贯性 + 规划员 ALL PASS =====');
  process.exit(fails ? 1 : 0);
})();

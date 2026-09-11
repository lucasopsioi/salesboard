/* 判断/决策题 —— 间歇性失败取证版（2026-09-11）。
 * 同一题重复跑 N 次，每次打印：专家笔记/claims/半途重试/轮次、门禁拦了哪些数、重写有没有发生、综合层报错。
 * 用法：node eval/run-judge2.js --only trend|decision --repeat 3 */
'use strict';
const fs = require('fs'); const path = require('path');
const O = require(path.join(__dirname, '..', 'app', 'ai-orchestrator.js'));
const AD = require(path.join(__dirname, '..', 'app', 'ai-context.js'));
const { mountEngine, buildRegistry } = require('./engine-tools.js');
const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : d; };
const ONLY = arg('only', ''), REPEAT = +arg('repeat', '1') || 1;
const BASE = 'https://api.deepseek.com/v1', MODEL = 'deepseek-chat';
let KEY = ''; try { KEY = fs.readFileSync(path.join(__dirname, 'deepseek.key'), 'utf8').trim(); } catch (e) {}
if (!KEY) { console.log('FAIL 没有 eval/deepseek.key'); process.exit(1); }
async function chat(req) {
  const body = { model: MODEL, temperature: 0.1, stream: false, max_tokens: req.maxTokens || 800, messages: [{ role: 'system', content: req.system }].concat(req.messages || []) };
  if (req.tools && req.tools.length) { body.tools = req.tools; body.tool_choice = 'auto'; }
  try {
    const r = await fetch(BASE + '/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + KEY }, body: JSON.stringify(body) });
    if (!r.ok) { console.log('   [chat ERR] HTTP ' + r.status); return { error: 'HTTP ' + r.status }; }
    const j = await r.json(); const m = (j.choices && j.choices[0] && j.choices[0].message) || {};
    if (!m.content && !(m.tool_calls && m.tool_calls.length)) console.log('   [chat EMPTY] finish=' + (j.choices && j.choices[0] && j.choices[0].finish_reason));
    return { content: m.content || '', toolCalls: m.tool_calls || null };
  } catch (e) { console.log('   [chat THROW] ' + String((e && e.message) || e)); return { error: String((e && e.message) || e) }; }
}
(async () => {
  const engine = await mountEngine({}); const registry = buildRegistry(engine);
  const prods = await registry.options({ field: 'product' });
  const plist = Array.isArray(prods) ? prods : ((prods && (prods['取值'] || prods.list)) || []);
  const A = plist.find(x => /\d/.test(String(x))) || plist[0];
  const B = plist.find(x => x !== A && /\d/.test(String(x))) || plist.find(x => x !== A);
  const events = [];
  const deps = {
    chat,
    runTool: async (n, a) => { const fn = registry[n]; return fn ? await fn(a) : { error: '未知工具: ' + n }; },
    optionsDirect: async (field) => registry.options({ field }),
    catalogDirect: async () => { try { return engine.catalog(); } catch (e) { return null; } },
    provRetry: true, parallel: true,
    schemas: AD.TOOL_SCHEMAS, buildToolSpecs: AD.buildToolSpecs, pickTools: AD.pickTools, parseToolCall: AD.parseToolCall,
    snapshot: async () => '', filters: () => null, boardLabel: () => '产业看板',
    onProgress: e => { events.push(e); if (e.type === 'tool') console.log('   🔧 ' + e.agent + ' → ' + e.tool + ' ' + JSON.stringify(e.args || {}).slice(0, 100)); if (e.type === 'planner') console.log('   🧭 ' + e.tasks.map(t => t.agent + '·' + t.label).join(' / ')); },
  };
  const REFUSE = /(无法(预测|判断|回答|给出)|不能(预测|判断|回答)|不做预测|取不到|无法获取|均未取到|未取到任何)/;
  const Q = { decision: A + ' 和 ' + B + ' 哪个卖得更好？收入、利润和销量综合考虑的话，我应该多卖哪个？', trend: '现在哪个产品未来能卖得更多？' };
  let bad = 0, total = 0;
  for (let rep = 1; rep <= REPEAT; rep++) {
    for (const k of Object.keys(Q)) {
      if (ONLY && ONLY !== k) continue;
      total++;
      console.log('\n━━ 第 ' + rep + ' 次 · ' + k + '：' + Q[k]);
      events.length = 0;
      const r = await O.orchestrate(Q[k], 'industry', deps, { mode: 'fast' });
      const a = String(r.answer || '');
      (r.results || []).forEach(x => console.log('   [专家] ' + x.agentName + ' err=' + (x.error || '-') + ' claims=' + (x.claims || []).length + ' halfway=' + !!x.halfwayRetried + ' rounds=' + (x.rounds || '?') + ' forcedFinal=' + !!x.forcedFinal + ' | ' + String(x.notes || '').replace(/\s+/g, ' ').slice(0, 200)));
      console.log('   [门禁] blocked=' + JSON.stringify((r.provenanceBlocked || []).slice(0, 8)) + ' verified.ok=' + (r.verified && r.verified.ok) + ' unsupported=' + JSON.stringify(((r.verified || {}).unsupported || []).slice(0, 6)) + ' synthError=' + (r.synthError || '-'));
      console.log('   答：' + a.replace(/\s+/g, ' ').slice(0, 300));
      const head = a.slice(0, 300);
      const okNow = k === 'decision'
        ? (/(建议|应该|优先|多卖|主推|倾向|更值得)/.test(head) && !REFUSE.test(head) && a.indexOf(A) >= 0 && a.indexOf(B) >= 0)
        : (!REFUSE.test(head) && plist.some(p => head.indexOf(p) >= 0) && !/产品[ABC]/.test(head));
      console.log('   ' + (okNow ? 'PASS' : 'FAIL'));
      if (!okNow) bad++;
    }
  }
  console.log('\n汇总：' + (total - bad) + '/' + total + ' 通过');
  process.exit(bad ? 1 : 0);
})();

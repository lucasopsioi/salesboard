/* 判断/决策类问题实测（2026-09-11 用户：「哪个产品未来能卖得更多」「A 和 B 综合收入利润销量该多卖哪个」
 * 模型完全答不出、也不知道该抓什么数据）。合成样例数据；key 只读不打印。
 * 用法：node eval/run-judge.js */
'use strict';
const fs = require('fs'); const path = require('path');
const O = require(path.join(__dirname, '..', 'app', 'ai-orchestrator.js'));
const AD = require(path.join(__dirname, '..', 'app', 'ai-context.js'));
const { mountEngine, buildRegistry } = require('./engine-tools.js');
const BASE = 'https://api.deepseek.com/v1', MODEL = 'deepseek-chat';
let KEY = ''; try { KEY = fs.readFileSync(path.join(__dirname, 'deepseek.key'), 'utf8').trim(); } catch (e) {}
if (!KEY) { console.log('FAIL 没有 eval/deepseek.key'); process.exit(1); }
async function chat(req) {
  const body = { model: MODEL, temperature: 0.1, stream: false, max_tokens: req.maxTokens || 800, messages: [{ role: 'system', content: req.system }].concat(req.messages || []) };
  if (req.tools && req.tools.length) { body.tools = req.tools; body.tool_choice = 'auto'; }
  try {
    const r = await fetch(BASE + '/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + KEY }, body: JSON.stringify(body) });
    if (!r.ok) return { error: 'HTTP ' + r.status };
    const j = await r.json(); const m = (j.choices && j.choices[0] && j.choices[0].message) || {};
    return { content: m.content || '', toolCalls: m.tool_calls || null };
  } catch (e) { return { error: String((e && e.message) || e) }; }
}
(async () => {
  let fails = 0; const ok = (n, c, x) => { console.log((c ? 'PASS ' : 'FAIL ') + n + (!c && x ? '  << ' + x : '')); if (!c) fails++; };
  const engine = await mountEngine({}); const registry = buildRegistry(engine);
  const prods = await registry.options({ field: 'product' });
  const plist = Array.isArray(prods) ? prods : ((prods && (prods['取值'] || prods.list)) || []);
  const A = plist.find(x => /\d/.test(String(x))) || plist[0];
  const B = plist.find(x => x !== A && /\d/.test(String(x))) || plist.find(x => x !== A);
  console.log('样例产品 A=' + A + '  B=' + B);
  const events = [];
  const deps = {
    chat,
    runTool: async (n, a) => { const fn = registry[n]; return fn ? await fn(a) : { error: '未知工具: ' + n }; },
    optionsDirect: async (field) => registry.options({ field }),
    catalogDirect: async () => { try { return engine.catalog(); } catch (e) { return null; } },
    provRetry: true, parallel: true,
    schemas: AD.TOOL_SCHEMAS, buildToolSpecs: AD.buildToolSpecs, pickTools: AD.pickTools, parseToolCall: AD.parseToolCall,
    snapshot: async () => '', filters: () => null, boardLabel: () => '产业看板',
    onProgress: e => { events.push(e); if (e.type === 'planner') console.log('   🧭 规划：' + e.tasks.map(t => t.agent + '·' + t.label).join(' / ')); if (e.type === 'tool') console.log('   🔧 ' + e.tool + ' ' + JSON.stringify(e.args || {}).slice(0, 110)); },
  };
  // 表格里某一项标「数据未包含」是诚实标注，不算拒答；拒答是整题推脱
  const REFUSE = /(无法(预测|判断|回答|给出)|不能(预测|判断|回答)|不做预测|取不到|无法获取|均未取到)/;
  const ask = async q => { console.log('\n问：' + q); events.length = 0; const t0 = Date.now(); const r = await O.orchestrate(q, 'industry', deps, { mode: 'fast' }); const a = String(r.answer || ''); console.log('答(' + ((Date.now() - t0) / 1000).toFixed(1) + 's)：' + a.replace(/\s+/g, ' ').slice(0, 700)); try { console.log('   [诊断] ' + JSON.stringify((r.results || []).map(x => ({ agent: x.agentName, err: x.error || null, claims: (x.claims || []).length, notes: String(x.notes || '').slice(0, 90) })))); } catch (e) {} return a; };

  const a1 = await ask(A + ' 和 ' + B + ' 哪个卖得更好？收入、利润和销量综合考虑的话，我应该多卖哪个？');
  const pl1 = events.find(e => e.type === 'planner');
  ok('决策题：规划里含财经专家（收入/利润要从财经取）', !!pl1 && pl1.tasks.some(t => /经营|财经/.test(t.agent)), pl1 ? JSON.stringify(pl1.tasks.map(t => t.agent)) : '无');
  ok('决策题：两个产品都有数字', /\d/.test(a1) && a1.indexOf(A) >= 0 && a1.indexOf(B) >= 0, a1.slice(0, 120));
  // 拒答只看结论句（前 300 字）：后面风险段里「某项未取到」是诚实说明，不是拒答
  ok('决策题：给出了明确的建议（多卖哪个）', /(建议|应该|优先|多卖|主推|倾向|更值得)/.test(a1.slice(0, 300)) && (a1.indexOf(A) >= 0 || a1.indexOf(B) >= 0) && !REFUSE.test(a1.slice(0, 300)), a1.slice(0, 200));

  const a2 = await ask('现在哪个产品未来能卖得更多？');
  ok('趋势题：没有拒答，点了具体产品名', !REFUSE.test(a2.slice(0, 300)) && plist.some(p => a2.indexOf(p) >= 0), a2.slice(0, 200));
  ok('趋势题：有实际数据作依据（数字）且不编预测数（没有「预计/预测 X 台」）', /\d/.test(a2) && !/(预计|预测)[^。；\n]{0,12}\d[\d,]*\s*台/.test(a2), a2.slice(0, 200));
  console.log(fails ? '\nFAILURES: ' + fails : '\n===== 判断/决策类问题 ALL PASS =====');
  process.exit(fails ? 1 : 0);
})();

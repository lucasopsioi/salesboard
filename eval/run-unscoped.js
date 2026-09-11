/* 界面筛选不得卡住取数 —— 数字准确性实测（2026-09-11 用户：「没选那个产品 agent 就抓不到数据，我要绝对的数据准确性」）
 * 场景：看板筛选停在「另一个产品」上，用户问「P 今年卖了多少台」。
 * 判据：回答里的累计 SO 必须等于引擎直接算的 report({product:[P]}) 的 cumCur —— 数字对不上就是失败。
 * 合成样例数据；key 只读不打印。用法：node eval/run-unscoped.js */
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
  const P = plist.find(x => /\d/.test(String(x))) || plist[0];
  const OTHER = plist.find(x => x !== P) || P;
  const truth = await registry.report({ groupDim: 'product', filters: { product: [P] } });
  const row = (truth.rows || []).find(r => r.key === P) || truth.total || {};
  const want = Math.round(row.cumCur || 0);
  console.log('样例产品：' + P + '；界面筛选停在：' + OTHER + '；引擎真值 累计SO = ' + want);
  const toolArgs = [];
  const deps = {
    chat,
    runTool: async (n, a) => { toolArgs.push({ n, a }); const fn = registry[n]; return fn ? await fn(a) : { error: '未知工具: ' + n }; },
    optionsDirect: async (field) => registry.options({ field }),
    catalogDirect: async () => { try { return engine.catalog(); } catch (e) { return null; } },
    provRetry: true, parallel: true,
    schemas: AD.TOOL_SCHEMAS, buildToolSpecs: AD.buildToolSpecs, pickTools: AD.pickTools, parseToolCall: AD.parseToolCall,
    snapshot: async () => '', boardLabel: () => 'PSI 数据分析',
    filters: () => ({ product: [OTHER] }),                       // ← 看板选着另一个产品
    onProgress: () => {},
  };
  const r = await O.orchestrate(P + ' 今年卖了多少台', 'psi', deps, { mode: 'fast' });
  const a = String(r.answer || '');
  console.log('答：' + a.replace(/\s+/g, ' ').slice(0, 220));
  const nums = (a.match(/\d[\d,]*/g) || []).map(x => +x.replace(/,/g, ''));
  ok('回答里出现了引擎真值 ' + want + '（界面筛选停在别的产品也不影响）', nums.indexOf(want) >= 0, JSON.stringify(nums.slice(0, 10)));
  const leaked = toolArgs.some(t => t.a && t.a.filters && JSON.stringify(t.a.filters).indexOf(OTHER) >= 0);
  ok('取数参数里没有把界面筛选的「' + OTHER + '」带进去', !leaked, JSON.stringify(toolArgs.map(t => t.a && t.a.filters)));
  ok('没有说取不到数据', !/(取不出|取不到|无法回答|无法获取|不能回答)/.test(a));
  console.log(fails ? '\nFAILURES: ' + fails : '\n===== 界面筛选不卡取数 ALL PASS =====');
  process.exit(fails ? 1 : 0);
})();

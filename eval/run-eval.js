'use strict';
/* ============================================================
   eval/run-eval.js —— 评测跑分器
   复用线上同一条链路：app/ai-orchestrator.js 的 orchestrate()
   （路由→专家→工具循环→综合→数字溯源），工具直连引擎（eval/engine-tools）。

   用法：
     node eval/run-eval.js --dry                 # 干跑：假模型走通全链路（不调LLM，验证管道）
     node eval/run-eval.js                       # 默认打 LM Studio http://localhost:1234/v1
     node eval/run-eval.js --base https://api.minimaxi.com/v1 --key $KEY --model MiniMax-Text-01
     node eval/run-eval.js --gguf "<路径>.gguf"   # 全本地：node-llama-cpp 直读模型，无需任何服务
     node eval/run-eval.js --only C1,C5-01       # 只跑某组/某题
     node eval/run-eval.js --summarize eval/runs/run-xxx.json   # 人工复核后重算汇总

   评分两级制：自动判只产生「提议」，rubric 题一律待人工终审——
   复核流程：打开 runs/*.json，把每题 human 字段填 "full|partial|harmless|harmful"
   （或确认 auto 提议），再 --summarize 重算。
   ============================================================ */
const fs = require('fs');
const path = require('path');
const O = require(path.join(__dirname, '..', 'app', 'ai-orchestrator.js'));
const AD = require(path.join(__dirname, '..', 'app', 'ai-context.js'));
const { mountEngine, buildRegistry } = require('./engine-tools.js');
// --set <path> 加载专项题集(如 finance-set.js);缺省仍是通用 30 题
const SET = (() => {
  const i = process.argv.indexOf('--set');
  const sp = (process.argv.find(a => a.indexOf('--set=') === 0) || '').slice(6) || (i >= 0 ? process.argv[i + 1] : '');
  if (sp) { try { return require(require('path').resolve(sp)); } catch (e) { console.error('题集加载失败: ' + e.message); process.exit(1); } }
  return require('./eval-set.js');
})();

/* ---------------- CLI ---------------- */
const argv = process.argv.slice(2);
const arg = (name, dflt) => { const i = argv.indexOf('--' + name); return i >= 0 ? argv[i + 1] : dflt; };
const has = (name) => argv.indexOf('--' + name) >= 0;
const BASE = (arg('base', 'http://localhost:1234/v1') || '').replace(/\/$/, '');
let KEY = arg('key', process.env.EVAL_API_KEY || '');
/* 密钥文件：作者 自己把 key 粘进 eval/minimax.key（已 .gitignore，绝不入库/不打印），跑分器静默读取 */
// --key-file <path> 支持任意厂商(deepseek.key 等);缺省仍回落 minimax.key。key 只读不打印。
const KEYFILE = arg('key-file', '');
if (!KEY && KEYFILE) { try { KEY = require('fs').readFileSync(KEYFILE, 'utf8').trim(); } catch (e) {} }
if (!KEY) { try { KEY = require('fs').readFileSync(require('path').join(__dirname, 'minimax.key'), 'utf8').trim(); } catch (e) {} }
const DRY = has('dry');
const GGUF = arg('gguf', '');   // 本地 .gguf 路径：不走 HTTP，直接 node-llama-cpp（与主程序 aiChatLocal 同一条路）
const ONLY = (arg('only', '') || '').split(',').map(s => s.trim()).filter(Boolean);
const SUMMARIZE = arg('summarize', null);
/* —— 真实数据核验（本地能力）——
   --data <root>：挂任意数据根目录（需含 psi/finance/flow 三个子目录），或分别用
   --data-psi/--data-fin/--data-flow 指定。真实数据的跑分记录写 eval/runs-real/（gitignore）。
   --paramset：改用参数化自检题集（题目实体与真值运行时从当前数据现算，见 param-set.js）。
   ⚠️ 真实数据 + 云端 API 会把业务数据发出机器——需显式 --allow-cloud-real 放行（本地 --gguf 不受限）。 */
const DATA = arg('data', '');
const DATA_PSI = arg('data-psi', DATA ? require('path').join(DATA, 'psi') : '');
const DATA_FIN = arg('data-fin', DATA ? require('path').join(DATA, 'finance') : '');
const DATA_FLOW = arg('data-flow', DATA ? require('path').join(DATA, 'flow') : '');
const REAL = !!(DATA || arg('data-psi', '') || arg('data-fin', '') || arg('data-flow', ''));
const PARAM = has('paramset');
const CACHE = arg('cache', REAL ? require('path').join(__dirname, '.engine-cache-real') : '');
const ALLOW_CLOUD_REAL = has('allow-cloud-real');

const LEVELS = { full: 1, partial: 0.5, harmless: 0, harmful: 0 };
const MARK = { full: 'PASS 完全正确', partial: 'HALF 部分正确', harmless: 'MISS 错但无害', harmful: 'RED! 错且有害', pending: '?    待人工', excluded: 'SKIP 空回复剔除' };

/* ---------------- 评分 ---------------- */
const NUM_RE = /-?\d[\d,]*(?:\.\d+)?/g;
const REFUSE_RE = /没有|未包含|不包含|查不到|无法|不能提供|数据未|不支持|无此/;
function nums(text) {
  const raw = (String(text || '').match(NUM_RE) || []).map(s => parseFloat(s.replace(/,/g, ''))).filter(n => isFinite(n));
  // 过滤日期噪声：1..31 的小整数（日/月/序号）与 1900..2100 的年份——否则「2026年1月」会被当成作答数值，
  // 把诚实的"未查到"误判成编数红线（首次冒烟实测踩到）。出题时期望值别落在这两个区间。
  return raw.filter(n => !(Number.isInteger(n) && ((n >= 0 && n <= 31) || (n >= 1900 && n <= 2100))));
}
function grade(q, answer, res) {
  const t = String(answer || '');
  const exp = q.expected || {};
  const hitRe = (re) => { try { return new RegExp(re).test(t); } catch (e) { return false; } };
  const badHits = (exp.must_not || []).filter(hitRe);
  const okHits = (exp.must_include || []).filter(hitRe);
  const proposal = (level, reason, pending) => ({ level, reason, pendingHuman: !!pending });

  if (exp.humanOnly) {
    if (badHits.length) return proposal(q.severity_if_wrong === 'harmful' ? 'harmful' : 'harmless', '命中禁答样式: ' + badHits[0], true);
    return proposal('pending', '开放题，人工终审（对照 verified 与真值）', true);
  }
  if (exp.type === 'number') {
    const got = nums(t);
    const per = (exp.numbers || []).map(n => {
      const tol = Math.max(n.tolAbs || 0, Math.abs(n.value) * (n.tolPct || 0));
      const hit = got.some(x => Math.abs(x - n.value) <= tol);
      return { label: n.label, want: n.value, tol: +tol.toFixed(3), hit };
    });
    const hits = per.filter(p => p.hit).length;
    let g;
    if (hits === per.length) g = proposal('full', '全部数值命中 ' + JSON.stringify(per.map(p => p.label)));
    else if (hits > 0) g = proposal('partial', '部分命中: ' + per.map(p => p.label + (p.hit ? '√' : '×')).join(' '), true);
    else if (REFUSE_RE.test(t) && got.length === 0) g = proposal('harmless', '可答题被拒答（无编数，无害）', true);
    else g = proposal(q.severity_if_wrong === 'harmful' ? 'harmful' : 'harmless', '无数值命中（期望 ' + per.map(p => p.want).join('/') + '）', true);
    g.detail = per;
    // 数对但溯源器标了无出处数字 → 降半级并记备注（校验器或口径卡的评测发现）
    if (g.level === 'full' && res && res.verified && res.verified.ok === false) {
      g = Object.assign(proposal('partial', '数值命中但溯源标警: ' + res.verified.unsupported.join('、'), true), { detail: per });
    }
    return g;
  }
  if (exp.type === 'refusal') {
    if (badHits.length) return proposal('harmful', '越界作答，命中: ' + badHits[0]);
    if (okHits.length) return proposal('full', '正确拒答/说明边界（' + okHits.length + ' 处信号）');
    return proposal('pending', '未识别拒答信号，人工判', true);
  }
  /* rubric */
  if (badHits.length) return proposal(q.severity_if_wrong === 'harmful' ? 'harmful' : 'harmless', '命中禁答样式: ' + badHits[0], true);
  const need = exp.minHits || 1;
  if (okHits.length >= need) return proposal('full', '要点命中 ' + okHits.length + '/' + (exp.must_include || []).length + '（rubric 需人工确认）', true);
  if (okHits.length > 0) return proposal('partial', '要点部分命中 ' + okHits.length + '/' + need, true);
  return proposal('pending', '要点未命中，人工判', true);
}

/* ---------------- 汇总 ---------------- */
function summarize(records, toolStats) {
  const lv = (r) => r.human || r.auto.level;
  // excluded = API 空回复(服务端方差)，剔除不计分母(用户 2026-08-28 裁定)
  const excluded = records.filter(r => lv(r) === 'excluded');
  const done = records.filter(r => lv(r) !== 'pending' && lv(r) !== 'excluded');
  const score = done.reduce((a, r) => a + (LEVELS[lv(r)] || 0), 0);
  const red = done.filter(r => lv(r) === 'harmful');
  const pend = records.filter(r => lv(r) === 'pending');
  const lat = records.map(r => r.latencyMs).sort((a, b) => a - b);
  const p50 = lat.length ? lat[Math.floor(lat.length / 2)] : 0;
  return {
    total: records.length, graded: done.length, pending: pend.length, excluded: excluded.map(r => r.id),
    accuracy: done.length ? +(score / done.length).toFixed(3) : null,
    harmful: red.map(r => r.id),
    toolCalls: toolStats.calls, toolErrors: toolStats.errors,
    toolSuccessRate: toolStats.calls ? +((toolStats.calls - toolStats.errors) / toolStats.calls).toFixed(3) : null,
    latencyP50s: +(p50 / 1000).toFixed(1),
    needHumanReview: records.filter(r => r.auto.pendingHuman && !r.human).map(r => r.id),
  };
}
function printSummary(s, label) {
  console.log('\n===== 汇总 ' + (label || '') + ' =====');
  console.log('已判 ' + s.graded + '/' + s.total + (s.pending ? ('（待人工 ' + s.pending + '）') : '') + (s.excluded && s.excluded.length ? ('（空回复剔除 ' + s.excluded.length + ': ' + s.excluded.join(',') + '）') : ''));
  console.log('准确率(已判): ' + (s.accuracy == null ? '-' : (100 * s.accuracy).toFixed(1) + '%') + '   有害错误: ' + s.harmful.length + (s.harmful.length ? ' ← ' + s.harmful.join(',') : ' ✔'));
  console.log('工具调用: ' + s.toolCalls + ' 次，失败 ' + s.toolErrors + '，成功率 ' + (s.toolSuccessRate == null ? '-' : (100 * s.toolSuccessRate).toFixed(1) + '%') + '   延迟p50: ' + s.latencyP50s + 's');
  if (s.needHumanReview.length) console.log('待人工复核: ' + s.needHumanReview.join(', '));
}

/* ---------------- LLM 适配（OpenAI 兼容） ---------------- */
let MODEL = arg('model', '');
async function resolveModel() {
  if (GGUF) { MODEL = 'local-gguf:' + path.basename(GGUF); return; }
  if (MODEL || DRY) return;
  // MiniMax 原生端点（…/text/chatcompletion_v2）没有 /models —— 用软件同款默认模型
  if (/chatcompletion/i.test(BASE)) { MODEL = 'MiniMax-Text-01'; return; }
  const r = await fetch(BASE + '/models', { headers: KEY ? { authorization: 'Bearer ' + KEY } : {} });
  if (!r.ok) throw new Error('取模型列表失败 HTTP ' + r.status + '（LM Studio 没开？或用 --model 指定）');
  const j = await r.json();
  MODEL = j.data && j.data[0] && j.data[0].id;
  if (!MODEL) throw new Error('模型列表为空');
}
async function httpChat(req) {
  // 空回复/瞬时错误重试一次（评测抓到 MiniMax 1000 unknown error 与空回复各两例）
  const first = await httpChatOnce(req);
  if (first && !first.error && String(first.content || '').trim()) return first;
  if (first && first.toolCalls && first.toolCalls.length) return first;
  await new Promise(r => setTimeout(r, 2000));
  return httpChatOnce(req);
}
async function httpChatOnce(req) {
  const body = {
    model: MODEL, temperature: 0.1, stream: false,
    max_tokens: req.maxTokens || 800,
    messages: [{ role: 'system', content: req.system }].concat(req.messages || []),
  };
  if (req.tools && req.tools.length) { body.tools = req.tools; body.tool_choice = 'auto'; }
  try {
    const ctrl = new AbortController(); const to = setTimeout(() => ctrl.abort(), 300000);
    // --base 给的是完整端点（如 MiniMax chatcompletion_v2）就原样用；否则按 OpenAI 惯例拼 /chat/completions
    const url = /chatcompletion|\/completions$/i.test(BASE) ? BASE : BASE + '/chat/completions';
    const r = await fetch(url, {
      method: 'POST', signal: ctrl.signal,
      headers: Object.assign({ 'content-type': 'application/json' }, KEY ? { authorization: 'Bearer ' + KEY } : {}),
      body: JSON.stringify(body),
    });
    clearTimeout(to);
    if (!r.ok) return { error: 'HTTP ' + r.status + ' ' + (await r.text()).slice(0, 200) };
    const j = await r.json();
    // MiniMax 把业务错误放 base_resp（HTTP 仍可能 200）：status_code 非 0 即失败
    if (j.base_resp && j.base_resp.status_code) return { error: 'MiniMax ' + j.base_resp.status_code + ' ' + (j.base_resp.status_msg || '') };
    const m = (j.choices && j.choices[0] && j.choices[0].message) || {};
    return { content: m.content || '', toolCalls: m.tool_calls || null };
  } catch (e) { return { error: String((e && e.message) || e) }; }
}
/* 干跑假模型：首轮要一次 meta 工具（验证 runTool/校验链路），次轮给结论 */
/* ---------------- 本地 GGUF 适配：node-llama-cpp（照主程序 aiChatLocal 的写法） ----------------
   工具走 JSON 回退协议：把工具说明书渲染进 system，模型输出 {"tool":..,"args":{}}，
   由 orchestrator 的 deps.parseToolCall（AD.parseToolCall）解析——与云端原生 tools 同一条编排链路。 */
function toolPromptFromSpecs(tools) {
  if (!tools || !tools.length) return '';
  const lines = tools.map(t => {
    const f = t.function || {};
    const props = (f.parameters && f.parameters.properties) || {};
    const req = (f.parameters && f.parameters.required) || [];
    const ps = Object.keys(props).map(k => {
      const en = props[k] && props[k].enum ? '，取值:' + props[k].enum.slice(0, 12).join('/') : '';
      return k + '(' + (req.indexOf(k) >= 0 ? '必填' : '可选') + en + ')';
    }).join(', ');
    return '- ' + f.name + '：' + (f.description || '') + (ps ? '  参数: ' + ps : '');
  });
  return '\n\n【工具调用协议】需要取数时，只输出一个 JSON 且不要任何其他文字：{"tool":"工具名","args":{...}}\n可用工具：\n'
    + lines.join('\n')
    + '\n收到「[工具 X 返回]」后基于返回继续；数据足够时直接给结论（结论中不要再输出工具 JSON）。';
}
function makeGgufChat(modelPath) {
  const st = { mod: null, llama: null, model: null, loading: null };
  async function ensure() {
    if (st.model) return;
    if (!st.loading) st.loading = (async () => {
      st.mod = await import('node-llama-cpp');
      st.llama = await st.mod.getLlama();
      console.log('加载本地模型（18.5GB，首次需数分钟）: ' + modelPath);
      try {
        st.model = await st.llama.loadModel({ modelPath });
      } catch (e) {
        // 与主程序 ensureLocalModel 相同的兜底：30B-A3B 塞不进显存时 Vulkan 分配失败 → 纯 CPU 重载
        console.log('GPU 后端装不下（' + String((e && e.message) || e).slice(0, 80) + '）→ 回退纯 CPU 重载…');
        const cpu = await st.mod.getLlama({ gpu: false });
        st.model = await cpu.loadModel({ modelPath });
        st.llama = cpu;
      }
      console.log('模型加载完成（后端: ' + (st.llama.gpu || 'cpu') + '）');
    })();
    await st.loading;
  }
  return async function ggufChat(req) {
    try {
      await ensure();
      const { LlamaChatSession } = st.mod;
      const system = String(req.system || '') + toolPromptFromSpecs(req.tools);
      const msgs = (req.messages || []).slice();
      let lastUser = '（空）';
      for (let i = msgs.length - 1; i >= 0; i--) {
        if (msgs[i] && msgs[i].role === 'user') { lastUser = String(msgs[i].content || ''); msgs.splice(i, 1); break; }
      }
      // 8192：与主程序一致，给口径卡+工具说明+快照留足；每请求独立 context，用完即弃
      const context = await st.model.createContext({ contextSize: 8192 });
      try {
        const session = new LlamaChatSession({ contextSequence: context.getSequence(), systemPrompt: system });
        if (msgs.length) {
          const history = [{ type: 'system', text: system }];
          for (const m of msgs) {
            if (!m || m.content == null) continue;
            if (m.role === 'user') history.push({ type: 'user', text: String(m.content) });
            else if (m.role === 'assistant') history.push({ type: 'model', response: [String(m.content)] });
          }
          try { session.setChatHistory(history); } catch (e) {}
        }
        const answer = await session.prompt(lastUser, { maxTokens: req.maxTokens || 800, temperature: 0.1 });
        return { content: String(answer || '') };
      } finally { try { await context.dispose(); } catch (e) {} }
    } catch (e) { return { error: String((e && e.message) || e) }; }
  };
}

function dryChat(req) {
  const seenTool = (req.messages || []).some(m => String(m.content || '').indexOf('[工具') >= 0);
  if (!seenTool && req.tools && req.tools.length) {
    return { content: '', toolCalls: [{ id: 'dry1', function: { name: 'meta', arguments: '{}' } }] };
  }
  return { content: '干跑测试答复（无真实结论）。{"claims":[{"metric":"dry","value":1,"unit":"台","caliber":"dry","asOf":"-"}],"notes":"dry-run"}' };
}

/* ---------------- 主流程 ---------------- */
function asciiJson(obj) {
  return JSON.stringify(obj, null, 1).replace(/[\x7f-\uffff]/g, (ch) => '\\u' + ch.charCodeAt(0).toString(16).padStart(4, '0'));
}

(async () => {
  if (SUMMARIZE) {
    const run = JSON.parse(fs.readFileSync(SUMMARIZE, 'utf8'));
    printSummary(summarize(run.records, run.toolStats), '(复核后)');
    return;
  }

  if (REAL && !DRY && !GGUF && !ALLOW_CLOUD_REAL) {
    console.error('⚠️ 拒绝执行：挂载了真实数据(--data)且走云端 API——业务数据将离开本机。');
    console.error('   本地核验请加 --gguf <模型路径>（数据不出机）；确认要发云端请显式加 --allow-cloud-real。');
    process.exit(2);
  }
  const engine = await mountEngine({ psi: DATA_PSI || undefined, fin: DATA_FIN || undefined, flow: DATA_FLOW || undefined, cacheDir: CACHE || undefined });
  const registry = buildRegistry(engine);

  let pool = SET.questions;
  if (PARAM) {
    const { buildParamSet } = require('./param-set.js');
    pool = await buildParamSet(registry);
    console.log('[参数化题集] 从当前数据现算出 ' + pool.length + ' 题真值');
  }
  const qs = pool.filter(q => !ONLY.length || ONLY.some(p => q.id === p || q.id.indexOf(p + '-') === 0 || q.id.indexOf(p) === 0));
  console.log((DRY ? '[干跑] ' : '[' + BASE + '] ') + (REAL ? '[真实数据] ' : '') + '共 ' + qs.length + ' 题');
  await resolveModel();
  if (!DRY) console.log('模型: ' + MODEL);
  /* reasoning 模型(M3/deepseek-reasoner 等)的 <think> 链内嵌在 content 里烧同一份
     max_tokens——预算不放大则正文被截成空回复(M3 首轮 5 题三连空的根)。 */
  if (/m3|reasoner|thinking|r1|v4-pro/i.test(MODEL) || arg('reasoning', '')) {
    O.BUDGET.subAgentTokens = Math.max(O.BUDGET.subAgentTokens * 3, 6000);
    O.BUDGET.synthTokens = Math.max(O.BUDGET.synthTokens * 3, 6000);
    /* M3 首测验尸:7 题 harmless 全是「think 吃掉工具轮次,活没干完就交卷」——轮次同步放大 */
    O.BUDGET.maxToolRoundsPerAgent = Math.max(O.BUDGET.maxToolRoundsPerAgent, 8);
    O.BUDGET.maxToolCallsTotal = Math.max(O.BUDGET.maxToolCallsTotal, 24);
    console.log('reasoning 模型:token 预算 ×3 (' + O.BUDGET.subAgentTokens + '/' + O.BUDGET.synthTokens + ') 工具轮 ' + O.BUDGET.maxToolRoundsPerAgent + '/' + O.BUDGET.maxToolCallsTotal);
  }
  const CHAT = DRY ? dryChat : (GGUF ? makeGgufChat(GGUF) : httpChat);

  const toolStats = { calls: 0, errors: 0 };
  const records = [];

  for (const q of qs) {
    const toolLog = [];
    const deps = {
      chat: CHAT,
      runTool: async (n, a) => {
        toolStats.calls++;
        const fn = registry[n];
        const out = fn ? await fn(a) : { error: '未知工具: ' + n };
        if (out && out.error) toolStats.errors++;
        toolLog.push({ tool: n, args: a, error: (out && out.error) || null });
        return out;
      },
      optionsDirect: async (field) => registry.options({ field }),
      catalogDirect: async () => { try { const c = engine.catalog(); return c; } catch (e) { return null; } },
      provRetry: true,
      schemas: AD.TOOL_SCHEMAS,
      buildToolSpecs: AD.buildToolSpecs,
      pickTools: AD.pickTools,
      parseToolCall: AD.parseToolCall,
      snapshot: async () => '',
      filters: () => null,
      boardLabel: (b) => '评测环境（无界面状态）',
      onProgress: () => {},
    };
    const t0 = Date.now();
    let res, emptyRuns = 0;
    /* 空回复自动重跑(用户 2026-08-28：空返回不算分数)：API 偶发空 content 是服务端方差，
       同题重跑至多 2 次；三次全空 → excluded，不进分母。 */
    const isEmptyAns = (r) => { if (!r) return true; const t = String(r.answer || '').trim(); return !t || t.replace(/[\s#*|>-]/g, '').length < 30 || /^\((空回复|综合失败)\)/.test(t); };   // 去掉markdown骨架后<30字=截断残句,同空回复重跑
    for (let attempt = 0; attempt < 3; attempt++) {
      try { res = await O.orchestrate(q.question, q.board || null, deps, { mode: q.mode || 'fast' }); }
      catch (e) { res = { answer: '', error: String((e && e.message) || e), results: [], verified: null }; }
      if (!isEmptyAns(res)) break;
      emptyRuns++;
      if (attempt < 2) console.log(q.id.padEnd(6) + ' 空回复，重跑 ' + (attempt + 1) + '/2 ...');
    }
    const latencyMs = Date.now() - t0;
    const auto = (emptyRuns >= 3 || (isEmptyAns(res) && res.error))
      ? { level: 'excluded', reason: 'API 空回复/异常 ×' + emptyRuns + '，剔除不计分母' }
      : res.error ? { level: 'pending', reason: '执行异常: ' + res.error, pendingHuman: true } : grade(q, res.answer, res);
    const rec = {
      id: q.id, category: q.category, board: q.board || null, mode: q.mode || 'fast',
      question: q.question, answer: res.answer || '',
      singleAgent: !!res.singleAgent,
      verified: res.verified || null,
      agents: (res.results || []).map(r => ({ agent: r.agentName, rounds: r.rounds, error: r.error || null, claims: r.claims || [], notes: r.notes || '' })),
      toolLog, latencyMs, auto, human: null,
      truth: q.truth || null, severity_if_wrong: q.severity_if_wrong,
    };
    records.push(rec);
    console.log(
      q.id.padEnd(6) + ' ' + (MARK[auto.level] || auto.level).padEnd(12)
      + ' ' + (latencyMs / 1000).toFixed(1) + 's'
      + (rec.singleAgent ? ' 单专家' : ' 多专家(' + rec.agents.length + ')')
      + '  ' + auto.reason.slice(0, 60)
    );
  }

  const runsDir = path.join(__dirname, REAL ? 'runs-real' : 'runs');   // 真实数据记录隔离存放（gitignore）
  fs.mkdirSync(runsDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
  const file = path.join(runsDir, 'run-' + stamp + (DRY ? '-dry' : '') + '.json');
  const runObj = {
    at: new Date().toISOString(), base: DRY ? 'dry' : BASE, model: DRY ? 'dry' : MODEL,
    evalSetVersion: PARAM ? 'paramset-runtime' : SET.meta.version, passBar: SET.meta.passBar,
    dataset: REAL ? ('REAL: ' + (DATA || [DATA_PSI, DATA_FIN, DATA_FLOW].filter(Boolean).join(' | '))) : 'demo-data',
    toolStats, records,
  };
  fs.writeFileSync(file, asciiJson(runObj));
  printSummary(summarize(records, toolStats), DRY ? '(干跑，评分无意义)' : '');
  console.log('\n已写入 ' + file);
  console.log('人工复核：编辑该文件里每题的 "human" 字段（full/partial/harmless/harmful），然后：');
  console.log('  node eval/run-eval.js --summarize ' + path.relative(process.cwd(), file));
})().catch(e => { console.error('FAIL', e); process.exit(1); });

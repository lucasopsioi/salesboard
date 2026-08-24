'use strict';
/* ============================================================
   eval/run-eval.js —— 评测跑分器
   复用线上同一条链路：app/ai-orchestrator.js 的 orchestrate()
   （路由→专家→工具循环→综合→数字溯源），工具直连引擎（eval/engine-tools）。

   用法：
     node eval/run-eval.js --dry                 # 干跑：假模型走通全链路（不调LLM，验证管道）
     node eval/run-eval.js                       # 默认打 LM Studio http://localhost:1234/v1
     node eval/run-eval.js --base https://api.minimaxi.com/v1 --key $KEY --model MiniMax-Text-01
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
const SET = require('./eval-set.js');

/* ---------------- CLI ---------------- */
const argv = process.argv.slice(2);
const arg = (name, dflt) => { const i = argv.indexOf('--' + name); return i >= 0 ? argv[i + 1] : dflt; };
const has = (name) => argv.indexOf('--' + name) >= 0;
const BASE = (arg('base', 'http://localhost:1234/v1') || '').replace(/\/$/, '');
const KEY = arg('key', process.env.EVAL_API_KEY || '');
const DRY = has('dry');
const ONLY = (arg('only', '') || '').split(',').map(s => s.trim()).filter(Boolean);
const SUMMARIZE = arg('summarize', null);

const LEVELS = { full: 1, partial: 0.5, harmless: 0, harmful: 0 };
const MARK = { full: 'PASS 完全正确', partial: 'HALF 部分正确', harmless: 'MISS 错但无害', harmful: 'RED! 错且有害', pending: '?    待人工' };

/* ---------------- 评分 ---------------- */
const NUM_RE = /-?\d[\d,]*(?:\.\d+)?/g;
const REFUSE_RE = /没有|未包含|不包含|查不到|无法|不能提供|数据未|不支持|无此/;
function nums(text) {
  return (String(text || '').match(NUM_RE) || []).map(s => parseFloat(s.replace(/,/g, ''))).filter(n => isFinite(n));
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
  const done = records.filter(r => (r.human || r.auto.level) !== 'pending');
  const lv = (r) => r.human || r.auto.level;
  const score = done.reduce((a, r) => a + (LEVELS[lv(r)] || 0), 0);
  const red = done.filter(r => lv(r) === 'harmful');
  const pend = records.filter(r => (r.human || r.auto.level) === 'pending');
  const lat = records.map(r => r.latencyMs).sort((a, b) => a - b);
  const p50 = lat.length ? lat[Math.floor(lat.length / 2)] : 0;
  return {
    total: records.length, graded: done.length, pending: pend.length,
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
  console.log('已判 ' + s.graded + '/' + s.total + (s.pending ? ('（待人工 ' + s.pending + '）') : ''));
  console.log('准确率(已判): ' + (s.accuracy == null ? '-' : (100 * s.accuracy).toFixed(1) + '%') + '   有害错误: ' + s.harmful.length + (s.harmful.length ? ' ← ' + s.harmful.join(',') : ' ✔'));
  console.log('工具调用: ' + s.toolCalls + ' 次，失败 ' + s.toolErrors + '，成功率 ' + (s.toolSuccessRate == null ? '-' : (100 * s.toolSuccessRate).toFixed(1) + '%') + '   延迟p50: ' + s.latencyP50s + 's');
  if (s.needHumanReview.length) console.log('待人工复核: ' + s.needHumanReview.join(', '));
}

/* ---------------- LLM 适配（OpenAI 兼容） ---------------- */
let MODEL = arg('model', '');
async function resolveModel() {
  if (MODEL || DRY) return;
  const r = await fetch(BASE + '/models', { headers: KEY ? { authorization: 'Bearer ' + KEY } : {} });
  if (!r.ok) throw new Error('取模型列表失败 HTTP ' + r.status + '（LM Studio 没开？或用 --model 指定）');
  const j = await r.json();
  MODEL = j.data && j.data[0] && j.data[0].id;
  if (!MODEL) throw new Error('模型列表为空');
}
async function httpChat(req) {
  const body = {
    model: MODEL, temperature: 0.1, stream: false,
    max_tokens: req.maxTokens || 800,
    messages: [{ role: 'system', content: req.system }].concat(req.messages || []),
  };
  if (req.tools && req.tools.length) { body.tools = req.tools; body.tool_choice = 'auto'; }
  try {
    const ctrl = new AbortController(); const to = setTimeout(() => ctrl.abort(), 300000);
    const r = await fetch(BASE + '/chat/completions', {
      method: 'POST', signal: ctrl.signal,
      headers: Object.assign({ 'content-type': 'application/json' }, KEY ? { authorization: 'Bearer ' + KEY } : {}),
      body: JSON.stringify(body),
    });
    clearTimeout(to);
    if (!r.ok) return { error: 'HTTP ' + r.status + ' ' + (await r.text()).slice(0, 200) };
    const j = await r.json();
    const m = (j.choices && j.choices[0] && j.choices[0].message) || {};
    return { content: m.content || '', toolCalls: m.tool_calls || null };
  } catch (e) { return { error: String((e && e.message) || e) }; }
}
/* 干跑假模型：首轮要一次 meta 工具（验证 runTool/校验链路），次轮给结论 */
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

  const qs = SET.questions.filter(q => !ONLY.length || ONLY.some(p => q.id === p || q.id.indexOf(p + '-') === 0 || q.id.indexOf(p) === 0));
  console.log((DRY ? '[干跑] ' : '[' + BASE + '] ') + '共 ' + qs.length + ' 题');

  const engine = await mountEngine();
  const registry = buildRegistry(engine);
  await resolveModel();
  if (!DRY) console.log('模型: ' + MODEL);

  const toolStats = { calls: 0, errors: 0 };
  const records = [];

  for (const q of qs) {
    const toolLog = [];
    const deps = {
      chat: DRY ? dryChat : httpChat,
      runTool: async (n, a) => {
        toolStats.calls++;
        const fn = registry[n];
        const out = fn ? await fn(a) : { error: '未知工具: ' + n };
        if (out && out.error) toolStats.errors++;
        toolLog.push({ tool: n, args: a, error: (out && out.error) || null });
        return out;
      },
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
    let res;
    try { res = await O.orchestrate(q.question, q.board || null, deps, { mode: q.mode || 'fast' }); }
    catch (e) { res = { answer: '', error: String((e && e.message) || e), results: [], verified: null }; }
    const latencyMs = Date.now() - t0;
    const auto = res.error ? { level: 'pending', reason: '执行异常: ' + res.error, pendingHuman: true } : grade(q, res.answer, res);
    const rec = {
      id: q.id, category: q.category, board: q.board || null, mode: q.mode || 'fast',
      question: q.question, answer: res.answer || '',
      singleAgent: !!res.singleAgent,
      verified: res.verified || null,
      agents: (res.results || []).map(r => ({ agent: r.agentName, rounds: r.rounds, error: r.error || null })),
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

  const runsDir = path.join(__dirname, 'runs');
  fs.mkdirSync(runsDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
  const file = path.join(runsDir, 'run-' + stamp + (DRY ? '-dry' : '') + '.json');
  const runObj = {
    at: new Date().toISOString(), base: DRY ? 'dry' : BASE, model: DRY ? 'dry' : MODEL,
    evalSetVersion: SET.meta.version, passBar: SET.meta.passBar,
    toolStats, records,
  };
  fs.writeFileSync(file, asciiJson(runObj));
  printSummary(summarize(records, toolStats), DRY ? '(干跑，评分无意义)' : '');
  console.log('\n已写入 ' + file);
  console.log('人工复核：编辑该文件里每题的 "human" 字段（full/partial/harmless/harmful），然后：');
  console.log('  node eval/run-eval.js --summarize ' + path.relative(process.cwd(), file));
})().catch(e => { console.error('FAIL', e); process.exit(1); });

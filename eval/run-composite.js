/* 综合题测试集（2026-09-12 用户：「不要单选题，我要综合题：A 对比 B 表现怎么样、拿到另一个国家有没有机会卖更多、
 * 综合 C 的历史销量预估 A 在 X 国能卖多少；至少 50 道、各种场景、专门一个测试集、要 100% 正确或相对正确，不能是编的数」）
 * 题目按引擎里的真实覆盖情况生成（哪些产品没进哪些国家是数据决定的），真值全部由代码工具算：
 *   opportunity（份额法/规模法/类比法区间与中位、已在售实际与空间、目标国产品线 DOS/同比、周销参考）
 *   compareItems（两品并排：累计SO/收入…）
 * 判分：analyzed = 给出了结论；correct = 答案里出现了代码算出的关键数字（原样，允许千分位/万），且点对了国家/产品/方向。
 * 用法：node eval/run-composite.js [--only 3,7] [--out 文件]   （合成 demo-data；key 只读不打印）
 */
'use strict';
const fs = require('fs'); const path = require('path');
const O = require(path.join(__dirname, '..', 'app', 'ai-orchestrator.js'));
const AD = require(path.join(__dirname, '..', 'app', 'ai-context.js'));
const AC = require(path.join(__dirname, '..', 'app', 'analytics-core.js'));
const { mountEngine, buildRegistry } = require('./engine-tools.js');
const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : d; };
const ONLY = (arg('only', '') || '').split(',').map(s => +s).filter(Boolean);
const OUT = arg('out', path.join(__dirname, 'runs', 'run-composite-' + new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19) + '.txt'));
const BASE = 'https://api.deepseek.com/v1', MODEL = 'deepseek-chat';
let KEY = ''; try { KEY = fs.readFileSync(path.join(__dirname, 'deepseek.key'), 'utf8').trim(); } catch (e) {}
if (!KEY) { console.log('FAIL 没有 eval/deepseek.key'); process.exit(1); }
try { fs.mkdirSync(path.dirname(OUT), { recursive: true }); } catch (e) {}
const log = (s) => { console.log(s); try { fs.appendFileSync(OUT, s + '\n'); } catch (e) {} };

async function chat(req) {
  const body = { model: MODEL, temperature: 0.1, stream: false, max_tokens: req.maxTokens || 800, messages: [{ role: 'system', content: req.system }].concat(req.messages || []) };
  if (req.tools && req.tools.length) { body.tools = req.tools; body.tool_choice = 'auto'; }
  for (let att = 0; att < 3; att++) {
    try {
      const r = await fetch(BASE + '/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + KEY }, body: JSON.stringify(body) });
      if (!r.ok) { if (att < 2) continue; return { error: 'HTTP ' + r.status }; }
      const j = await r.json(); const m = (j.choices && j.choices[0] && j.choices[0].message) || {};
      return { content: m.content || '', toolCalls: m.tool_calls || null };
    } catch (e) { if (att === 2) return { error: String((e && e.message) || e) }; }
  }
}

const norm = s => String(s || '').replace(/(\d),(?=\d{3})/g, '$1').replace(/(\d+(?:\.\d+)?)\s*万/g, (m, n) => String(Math.round(parseFloat(n) * 10000)));
const has = (a, name) => a.indexOf(name) >= 0;
const hasNum = (a, n) => { if (n == null || !isFinite(n)) return false; const s = norm(a); const v = Math.round(n); return new RegExp('(^|[^\\d.])' + v + '([^\\d]|$)').test(s); };
const anyNum = (a, vals) => (vals || []).some(v => hasNum(a, v));
const hasPctVal = (a, v, tol) => { if (v == null) return false; const t = tol == null ? 1 : tol; const m = norm(a).match(/-?\d+(?:\.\d+)?\s*%/g) || []; return m.some(x => Math.abs(parseFloat(x) - v) <= t); };
const ZH = AC.COUNTRY_ALIAS; const EN2ZH = {}; Object.keys(ZH).forEach(z => { EN2ZH[ZH[z]] = z; });
const hasCty = (a, k, win) => { const t = win ? a.slice(0, win) : a; return t.indexOf(k) >= 0 || (EN2ZH[k] && t.indexOf(EN2ZH[k]) >= 0); };
/* 谁是结论里的「赢家」：「A 比 B 更…」赢家在比较词前（且在「比」前）；「建议/优先/首选 A」赢家在推荐词后。取最早出现的判定；都没有就取最先点名的。 */
const AFTER_RE = /(更高|更多|更强|更大|更快|领先|高于|多于|居首|第一|最高|最多|最大|更值得|更该|胜出|占优|排第一|位居第一|优先级更高)/g;
const BEFORE_RE = /(应选|应该选|建议选|选择|建议|推荐|首选|主推|重点推|集中在|应以|答案是|优先)/g;
const winnerNamed = (t, names) => {
  const x = String(t || '').replace(/[#*_`>|]/g, ' ').slice(0, 450);
  const sorted = names.slice().sort((a, b) => b.length - a.length); let m = x; const ment = [];
  sorted.forEach(n => { let i = m.indexOf(n); while (i >= 0) { ment.push({ n, i, e: i + n.length }); m = m.slice(0, i) + ' '.repeat(n.length) + m.slice(i + n.length); i = m.indexOf(n); } });
  if (!ment.length) return null;
  const found = []; let mm;
  AFTER_RE.lastIndex = 0; while ((mm = AFTER_RE.exec(x))) { let cand = ment.filter(q => q.e <= mm.index && mm.index - q.e <= 30).sort((a, b) => b.e - a.e)[0]; if (cand) { const bi = x.lastIndexOf('比', mm.index); if (bi > 0 && bi < cand.i && cand.i - bi <= 3 && x[bi - 1] !== '相') { const before = ment.filter(q => q.e <= bi).sort((a, b) => b.e - a.e)[0]; if (before) cand = before; } found.push({ n: cand.n, at: mm.index }); } }
  BEFORE_RE.lastIndex = 0; while ((mm = BEFORE_RE.exec(x))) { const after = mm.index + mm[0].length; const cand = ment.filter(q => q.i >= after && q.i - after <= 30).sort((a, b) => a.i - b.i)[0]; if (cand) found.push({ n: cand.n, at: mm.index }); }
  if (found.length) return found.sort((a, b) => a.at - b.at)[0].n;
  return ment.sort((a, b) => a.i - b.i)[0].n;
};
const recoCty = (t, keys) => { let x = String(t || ''); keys.forEach(k => { if (EN2ZH[k]) x = x.split(EN2ZH[k]).join(k); }); return winnerNamed(x, keys); };
const firstCty = (t, keys) => { let best = null, bi = Infinity; keys.forEach(k => { [k, EN2ZH[k]].filter(Boolean).forEach(z => { const i = t.indexOf(z); if (i >= 0 && i < bi) { bi = i; best = k; } }); }); return best; };
const zh = k => EN2ZH[k] || k;
const REFUSE = /(无法(预测|判断|回答|给出|确定|估计|预估)|不能(预测|判断|回答|估计)|不做预测|取不到|无法获取|均未取到|未取到任何|没有.{0,6}数据|数据不足以)/;
const CONCL = /(结论|建议|应该|优先|多卖|主推|倾向|更值得|推荐|判断|是|最|能卖|预估|估计|区间|中位|空间|机会)/;
const head = a => a.slice(0, 500);

(async () => {
  const engine = await mountEngine({}); const R = buildRegistry(engine);
  const rp = (await R.report({ groupDim: 'product' })).rows;
  const rc = (await R.report({ groupDim: 'country' })).rows;
  const P = rp.map(r => r.key); const CT = rc.map(r => r.key);
  // 每个产品在哪些国家没量（数据决定的「可进入」国家）
  const absent = {}, present = {};
  for (const p of P) { const rows = (await R.report({ groupDim: 'country', filters: { product: [p] } })).rows; const m = {}; rows.forEach(r => { m[r.key] = r.cumCur || 0; }); absent[p] = CT.filter(c => !(m[c] > 0)); present[p] = CT.filter(c => m[c] > 0); }
  const lineOf = {}; rp.forEach(r => { lineOf[r.key] = r.line; });
  const cache = {};
  const opp = async (p, c, an) => { const k = p + '|' + (c || '') + '|' + (an || []).join(','); if (!cache[k]) { const a = { product: p }; if (c) a.country = c; if (an && an.length) a.analogs = an; cache[k] = await R.opportunity(a); } return cache[k]; };
  const cmp = async (names) => { const k = 'cmp|' + names.join(','); if (!cache[k]) cache[k] = await R.compareItems({ dim: 'product', names }); return cache[k]; };
  const est1 = o => (o && !o.error && o.估计 && o.估计[0]) || null;
  const nums = e => e ? [e.中位, e.区间低, e.区间高].filter(v => v != null) : [];
  const fmt = e => e ? (e.区间低 + '–' + e.区间高 + '/中位' + e.中位 + (e.已在售 ? '(已在售 实际' + e.实际累计SO + ' 空间' + e.空间 + ')' : '')) : '无';

  const movers = P.filter(p => absent[p].length);                 // 还有国家没进的产品
  const wide = P.filter(p => !absent[p].length && (rp.find(r => r.key === p).cumCur || 0) > 5000);   // 全覆盖且有量
  if (!movers.length) { console.log('FAIL 合成数据里没有「未进入国家」的产品，出不了题'); process.exit(1); }
  const pick = (arr, i) => arr[i % arr.length];
  const other = (p, i) => { const same = P.filter(x => x !== p && lineOf[x] === lineOf[p] && (rp.find(r => r.key === x).cumCur || 0) > 3000); return pick(same, i); };
  const analogFor = (p, X, i) => { const c = P.filter(x => x !== p && lineOf[x] === lineOf[p] && present[x].indexOf(X) >= 0 && present[x].filter(k => present[p].indexOf(k) >= 0).length >= 2); return pick(c, i); };

  const Q = [];
  const add = (q, check, tag) => Q.push({ q, check, tag });
  // ---------- T1 A 对比 B + 拿到 X 国（8） ----------
  const T1 = [
    (A, B, X) => A + ' 对比 ' + B + ' 表现怎么样？如果把 ' + A + ' 拿到' + zh(X) + '去卖，有没有机会？预估能卖多少台？',
    (A, B, X) => A + ' 和 ' + B + ' 比，谁卖得更好？' + A + ' 要是推到' + zh(X) + '，大概能卖多少？',
    (A, B, X) => '综合销量和库存看，' + A + ' 跟 ' + B + ' 谁更强？' + A + ' 进入 ' + X + ' 市场能不能卖出量，估个数。',
    (A, B, X) => '帮我比一下 ' + B + ' 和 ' + A + '，然后判断 ' + A + ' 拿去' + zh(X) + '卖有没有机会，能卖多少。',
  ];
  for (let i = 0; i < 8; i++) {
    const A = pick(movers, i), X = pick(absent[A], i), B = other(A, i);
    add(pick(T1, i)(A, B, X), async a => { const c = await cmp([A, B]); const ia = c.items.find(x => x.name === A), ib = c.items.find(x => x.name === B); const e = est1(await opp(A, X)); return { pass: hasNum(a, ia.累计SO) && hasNum(a, ib.累计SO) && anyNum(a, nums(e)) && hasCty(a, X), why: A + ' ' + ia.累计SO + ' vs ' + B + ' ' + ib.累计SO + '；' + X + ' 预估 ' + fmt(e) }; }, 'T1对比+转国');
  }
  // ---------- T2 参考 C 的历史销量（8） ----------
  const T2 = [
    (A, C, X) => '参考 ' + C + ' 的历史销量，' + A + ' 在' + zh(X) + '能不能卖出量？预估能卖多少台？',
    (A, C, X) => '按 ' + C + ' 在' + zh(X) + '的销量类比，' + A + ' 进' + zh(X) + '大概能卖多少？',
    (A, C, X) => '以 ' + C + ' 为参照，' + A + ' 如果铺到 ' + X + '，年初至今口径能卖到什么量级？',
    (A, C, X) => '拿 ' + C + ' 的历史表现对标一下，' + A + ' 打入' + zh(X) + '有没有机会？能卖多少？',
  ];
  for (let i = 0; i < 8; i++) {
    const A = pick(movers, i + 1), X = pick(absent[A], i + 2), C = analogFor(A, X, i);
    if (!C) continue;
    add(pick(T2, i)(A, C, X), async a => { const o = await opp(A, X, [C]); const e = est1(o); const ae = e && e.类比法 && e.类比法[0] ? e.类比法[0].估计 : null; return { pass: has(a, C) && (hasNum(a, ae) || anyNum(a, nums(e))) && hasCty(a, X), why: '类比 ' + C + '→' + ae + '；区间 ' + fmt(e) }; }, 'T2类比');
  }
  // ---------- T3 下一个进哪个国家（4） ----------
  const T3 = [
    A => A + ' 下一个最应该进入哪个国家？大概能卖多少？',
    A => '如果 ' + A + ' 只能再开一个国家，选哪个？预估销量是多少？',
    A => A + ' 还没进的国家里，哪个机会最大？给我一个量级。',
    A => '给 ' + A + ' 排一下还没覆盖的国家的优先级，第一优先的能卖多少？',
  ];
  for (let i = 0; i < 4; i++) {
    const A = pick(movers, i);
    add(pick(T3, i)(A), async a => { const o = await opp(A); const top = o.估计[0]; const named = recoCty(a.slice(0, 300), o.估计.map(e => e.国家)); const ok = named === top.国家 || (named && o.估计.find(e => e.国家 === named).中位 === top.中位); return { pass: !!ok && anyNum(a, nums(top)), why: '第一优先 ' + top.国家 + ' ' + fmt(top) + '（结论点名 ' + named + '）' }; }, 'T3下一国');
  }
  // ---------- T4 已在售国家的增长空间（8） ----------
  const T4 = [
    (A, X) => A + ' 在' + zh(X) + '还有没有增长空间？还能多卖多少？',
    (A, X) => A + ' 在' + zh(X) + '卖得够不够多？对比它在其它国家的份额，有没有空间？',
    (A, X) => '看 ' + A + ' 在 ' + X + ' 的表现，是已经到顶了还是还能往上冲？给个量。',
    (A, X) => A + ' 要不要在' + zh(X) + '加大投入？现在卖了多少，理论上还能卖多少？',
  ];
  for (let i = 0; i < 8; i++) {
    const A = pick(wide, i), X = pick(CT, i * 3 + 1);
    add(pick(T4, i)(A, X), async a => { const e = est1(await opp(A, X)); const dir = e.空间 != null && e.空间 <= 0 ? /(有限|已超|超过|饱和|不大|不多|接近|达到|到顶|到量|吃满|略超|略高|几乎没有|没有.{0,6}空间|不建议)/.test(head(a)) : /(空间|还能|可以|有机会|差距|往上)/.test(head(a)); return { pass: e.已在售 && hasNum(a, e.实际累计SO) && anyNum(a, nums(e)) && dir, why: '已在售 实际 ' + e.实际累计SO + '，估计 ' + fmt(e) + '，空间 ' + e.空间 }; }, 'T4空间');
  }
  // ---------- T5 目标国渠道 DOS 风险 + 预估（6） ----------
  const T5 = [
    (A, X, L) => '如果把 ' + A + ' 推到' + zh(X) + '，先看' + zh(X) + '的' + L + '渠道 DOS 有没有风险，再预估能卖多少？',
    (A, X, L) => A + ' 进 ' + X + ' 之前，那边' + L + '的渠道库存周转健康吗？进去能卖多少台？',
    (A, X, L) => zh(X) + '的' + L + '渠道 DOS 是多少？允不允许再放一个 ' + A + ' 进去？能卖多少？',
  ];
  for (let i = 0; i < 6; i++) {
    const A = pick(movers, i + 2), X = pick(absent[A], i + 3);
    add(pick(T5, i)(A, X, lineOf[A]), async a => { const e = est1(await opp(A, X)); return { pass: hasNum(a, e.市场环境.产品线渠道DOS) && anyNum(a, nums(e)) && hasCty(a, X), why: X + ' ' + lineOf[A] + ' DOS ' + e.市场环境.产品线渠道DOS + '；预估 ' + fmt(e) }; }, 'T5DOS+预估');
  }
  // ---------- T6 收入+销量综合 + 转国（6） ----------
  const T6 = [
    (A, B, X) => A + ' 和 ' + B + ' 收入、销量综合看，该多推哪个？如果把 ' + A + ' 推到' + zh(X) + '能卖多少？',
    (A, B, X) => '从收入和销量两方面对比 ' + B + ' 与 ' + A + '，再告诉我 ' + A + ' 拿到 ' + X + ' 有多大机会、能卖多少台。',
    (A, B, X) => A + ' 与 ' + B + ' 谁更赚钱、谁卖得更多？' + A + ' 进入' + zh(X) + '的预估量是多少？',
  ];
  for (let i = 0; i < 6; i++) {
    const A = pick(movers, i), X = pick(absent[A], i + 4), B = other(A, i + 1);
    add(pick(T6, i)(A, B, X), async a => { const c = await cmp([A, B]); const ia = c.items.find(x => x.name === A), ib = c.items.find(x => x.name === B); const e = est1(await opp(A, X)); const revOk = [ia, ib].every(x => x.收入 == null || hasNum(a, x.收入)); return { pass: hasNum(a, ia.累计SO) && hasNum(a, ib.累计SO) && revOk && anyNum(a, nums(e)), why: A + ' SO ' + ia.累计SO + '/收入 ' + ia.收入 + '，' + B + ' SO ' + ib.累计SO + '/收入 ' + ib.收入 + '；预估 ' + fmt(e) }; }, 'T6收入+转国');
  }
  // ---------- T7 两个国家二选一（6） ----------
  const T7 = [
    (A, X1, X2) => zh(X1) + '和' + zh(X2) + '，哪个国家更值得推 ' + A + '？各能卖多少？',
    (A, X1, X2) => A + ' 下一步进 ' + X1 + ' 还是 ' + X2 + '？分别预估一下量。',
    (A, X1, X2) => '如果 ' + A + ' 只能选' + zh(X1) + '或' + zh(X2) + '之一进入，选哪个？两个国家各自能卖多少？',
  ];
  for (let i = 0; i < 6; i++) {
    const A = pick(movers, i + 1), X1 = pick(absent[A], i), X2 = pick(absent[A], i + 1 + (i % 2));
    if (X1 === X2) continue;
    add(pick(T7, i)(A, X1, X2), async a => { const e1 = est1(await opp(A, X1)), e2 = est1(await opp(A, X2)); const better = e1.中位 >= e2.中位 ? X1 : X2; const named = recoCty(a.slice(0, 300), [X1, X2]); return { pass: named === better && anyNum(a, nums(e1)) && anyNum(a, nums(e2)), why: X1 + ' ' + fmt(e1) + ' vs ' + X2 + ' ' + fmt(e2) + '，应选 ' + better + '（结论先点 ' + named + '）' }; }, 'T7二选一');
  }
  // ---------- T8 产品线在目标国的 DOS/同比 + 预估（4） ----------
  const T8 = [
    (A, X, L) => A + ' 所在的' + L + '在' + zh(X) + '的渠道 DOS 和同比是多少？' + A + ' 进去能卖多少？',
    (A, X, L) => zh(X) + '的' + L + '今年同比怎么样、渠道周转多少天？在这个盘子里 ' + A + ' 能分到多少量？',
  ];
  for (let i = 0; i < 4; i++) {
    const A = pick(movers, i + 2), X = pick(absent[A], i + 5);
    add(pick(T8, i)(A, X, lineOf[A]), async a => { const e = est1(await opp(A, X)); const m = e.市场环境; return { pass: hasNum(a, m.产品线渠道DOS) && hasPctVal(a, m.产品线SO同比, 0.6) && anyNum(a, nums(e)), why: X + ' ' + lineOf[A] + ' DOS ' + m.产品线渠道DOS + '，同比 ' + m.产品线SO同比 + '%；预估 ' + fmt(e) }; }, 'T8线级+预估');
  }
  // ---------- T9 周销节奏（4） ----------
  const T9 = [
    (A, X) => A + ' 如果进入' + zh(X) + '，按现在的周销节奏每周大概能卖多少台？年初至今口径总量呢？',
    (A, X) => '把 ' + A + ' 放到 ' + X + '，一周能走多少台？累计能到多少？',
  ];
  for (let i = 0; i < 4; i++) {
    const A = pick(movers, i), X = pick(absent[A], i + 2);
    add(pick(T9, i)(A, X), async a => { const e = est1(await opp(A, X)); return { pass: hasNum(a, e.周销参考) && anyNum(a, nums(e)), why: '周销参考 ' + e.周销参考 + '；预估 ' + fmt(e) }; }, 'T9周销');
  }

  log('题数 ' + Q.length + '｜可转国产品：' + movers.map(p => p + '(' + absent[p].length + ' 国未进)').join('、') + '｜全覆盖产品：' + wide.join('、'));

  const deps = {
    chat,
    runTool: async (n, a) => { const fn = R[n]; return fn ? await fn(a) : { error: '未知工具: ' + n }; },
    optionsDirect: async (field) => R.options({ field }),
    catalogDirect: async () => { try { return engine.catalog(); } catch (e) { return null; } },
    provRetry: true, parallel: true,
    schemas: AD.TOOL_SCHEMAS, buildToolSpecs: AD.buildToolSpecs, pickTools: AD.pickTools, parseToolCall: AD.parseToolCall,
    snapshot: async () => '', filters: () => null, boardLabel: () => '产业看板',
    onProgress: (e) => { if (e && e.type === 'tool') TOOLS.push((e.agent || '') + ':' + e.tool + (e.args ? JSON.stringify(e.args).slice(0, 160) : '')); if (e && /^(prerank|prediag|preest|precmp)$/.test(e.type)) TOOLS.push('📐' + e.type + ' ' + JSON.stringify(e).slice(0, 220)); if (e && e.type === 'verify') TOOLS.push('🛡verify ' + JSON.stringify({ ok: e.ok, fixed: e.fixed, pinned: e.pinned, expected: e.expected })); },
  };
  let TOOLS = [];
  let nA = 0, nC = 0, n = 0; const rows = []; const byTag = {};
  for (let i = 0; i < Q.length; i++) {
    if (ONLY.length && ONLY.indexOf(i + 1) < 0) continue;
    n++;
    const t0 = Date.now(); TOOLS = [];
    let r; try { r = await O.orchestrate(Q[i].q, 'industry', deps, { mode: 'fast' }); } catch (e) { r = { answer: '', error: String(e) }; }
    const a = String((r && r.answer) || '');
    const h = head(a);
    const ri = a.search(REFUSE);
    const refused = ri >= 0 && ri < 160 && !/(结论|总体判断|判断)/.test(a.slice(0, ri));   // 先给了结论，再说某个子问「无法回答」是诚实边界，不算整题推脱
    const analyzed0 = !!a.trim() && !refused && CONCL.test(h) && /\d/.test(a) && P.concat(CT).some(x => has(a, x) || (EN2ZH[x] && has(a, EN2ZH[x])));
    let c; try { c = await Q[i].check(a); } catch (e) { c = { pass: false, why: 'check 抛错 ' + e }; }
    const analyzed = analyzed0 || (!!c.pass && !refused);
    const correct = analyzed && !!c.pass;
    if (analyzed) nA++; if (correct) nC++;
    byTag[Q[i].tag] = byTag[Q[i].tag] || { n: 0, c: 0 }; byTag[Q[i].tag].n++; if (correct) byTag[Q[i].tag].c++;
    const secs = ((Date.now() - t0) / 1000).toFixed(0);
    rows.push({ i: i + 1, tag: Q[i].tag, q: Q[i].q, analyzed, correct, secs, why: c.why, head: a.replace(/\s+/g, ' ').slice(0, 220), full: a, tools: TOOLS.slice(), verified: r && r.verified ? r.verified : null, blocked: r && r.provenanceBlocked || [] });
    try { fs.writeFileSync(OUT.replace(/\.txt$/, '') + '.full.json', JSON.stringify(rows, null, 1)); } catch (e) {}
    log('\n【' + (i + 1) + '】' + Q[i].tag + '｜' + Q[i].q + '\n   ' + (correct ? '✅ 正确' : (analyzed ? '🟡 有分析但不准' : '❌ 没分析出来')) + '  ' + secs + 's  | 真值：' + c.why + '\n   答：' + a.replace(/\s+/g, ' ').slice(0, 320) + (r && r.provenanceBlocked && r.provenanceBlocked.length ? '\n   门禁拦下：' + r.provenanceBlocked.slice(0, 6).join('、') : '') + '\n   工具：' + TOOLS.join(' ｜ ').slice(0, 900));
  }
  log('\n==================== 汇总 ====================');
  log('题数 ' + n + '｜能分析出来 ' + nA + '/' + n + '（' + Math.round(nA / n * 100) + '%）｜结论正确 ' + nC + '/' + n + '（' + Math.round(nC / n * 100) + '%）');
  log('分场景：' + Object.keys(byTag).map(t => t + ' ' + byTag[t].c + '/' + byTag[t].n).join('｜'));
  log('未通过：' + (rows.filter(x => !x.correct).map(x => '#' + x.i + (x.analyzed ? '(不准)' : '(没答)')).join(' ') || '无'));
  log('结果文件：' + OUT);
})();

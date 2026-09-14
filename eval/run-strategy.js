/* 策略 / 未来判断题测试集（2026-09-12 用户：「要问复杂的、策略性的、未来判断类的，100% 正确，不要限制输出字数」）
 * 判断依据全由代码算（analytics-core.outlook / opportunity / compareItems）：未来 N 周预测（保守/中性/乐观）、全年预测、
 * 库存可支撑周数与断货风险、DOS 目标需减库存、主推候选与剔除清单。模型只解释与建议。
 * 判分：correct = 答案里出现了代码算出的关键数字（原样，允许千分位/万/四舍五入到 0.5%），并且点名/方向与代码判定一致
 *   （主推只能选候选、砍掉只能砍剔除、断货点到清单、第 1 名点对）。题目 9 类共 56 道，按引擎里的实际数据生成。
 * 用法：node eval/run-strategy.js [--only 3,7] [--out 文件]   （合成 demo-data；key 只读不打印）
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
const OUT = arg('out', path.join(__dirname, 'runs', 'run-strategy-' + new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19) + '.txt'));
const BASE = 'https://api.deepseek.com/v1', MODEL = 'deepseek-chat';
let KEY = ''; try { KEY = fs.readFileSync(path.join(__dirname, 'deepseek.key'), 'utf8').trim(); } catch (e) {}
if (!KEY) { console.log('FAIL 没有 eval/deepseek.key'); process.exit(1); }
try { fs.mkdirSync(path.dirname(OUT), { recursive: true }); } catch (e) {}
const log = (s) => { console.log(s); try { fs.appendFileSync(OUT, s + '\n'); } catch (e) {} };

async function chat(req) {
  const body = { model: MODEL, temperature: 0.1, stream: false, max_tokens: req.maxTokens || 8000, messages: [{ role: 'system', content: req.system }].concat(req.messages || []) };
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
const hasNum = (a, n) => { if (n == null || !isFinite(n)) return false; const s = norm(a); const v = Math.round(n); if (new RegExp('(^|[^\\d.])' + v + '([^\\d]|$)').test(s)) return true; const tol = Math.max(0.6, Math.abs(n) * 0.005); return (s.match(/-?\d+(?:\.\d+)?/g) || []).some(x => Math.abs(parseFloat(x) - n) <= tol); };
const anyNum = (a, vals) => (vals || []).some(v => hasNum(a, v));
const ZH = AC.COUNTRY_ALIAS; const EN2ZH = {}; Object.keys(ZH).forEach(z => { EN2ZH[ZH[z]] = z; });
const hasCty = (a, k) => a.indexOf(k) >= 0 || (EN2ZH[k] && a.indexOf(EN2ZH[k]) >= 0);
const zh = k => EN2ZH[k] || k;
let LNS = [];   // 产品线取值，setup 后填入；「音频线/音频」→「音频与智能配件」
const normLines = t => { let x = String(t || ''); LNS.forEach(l => { const k = l.slice(0, 2); if (l.length > 2 && k !== l) { x = x.split(k + '线').join(l); x = x.replace(new RegExp(k + '(?!' + l.slice(2, 3) + ')', 'g'), l); } }); return x; };
const strip = a => normLines(String(a || '').replace(/[#*_`>|]/g, ' '));
const RECO_RE = /(应选|应该选|建议选|选择|建议|优先|推荐|更值得|首选|主推|重点|集中|更高|更多|更强|更大|领先|高于|多于|第一|最高|最多|居首|先撑不住|先见底|最先|最该|更该)/;
const namedAll = (t, names) => { const sorted = names.slice().sort((a, b) => b.length - a.length); let m = t; const hits = []; sorted.forEach(n => { const i = m.indexOf(n); if (i >= 0) { hits.push({ n, i }); m = m.split(n).join(' '.repeat(n.length)); } }); return hits.sort((a, b) => a.i - b.i).map(h => h.n); };
const firstNamed = (t, names) => namedAll(normLines(t), names)[0] || null;
/* 谁是结论里的「赢家」：「A 更高/领先/高于 B」赢家在比较词前面；「建议/优先/首选 A」赢家在推荐词后面。两类都找，取最早出现的那个；都没有就取最先点名的。 */
const AFTER_RE = /(更高|更多|更强|更大|更快|领先|高于|多于|居首|第一|最高|最多|最大|先撑不住|先见底|最紧|最先|最该|更该|应优先|应先|该先|优先去库存|先去库存|胜出|占优|更值得|排第一|位居第一)/g;
const BEFORE_RE = /(应选|应该选|建议选|选择|建议|推荐|首选|主推|重点推|集中在|应以|答案是|最大的是|最多的是|最高的是|最先的是|最紧的是|最该.{0,6}的是|减量最大的是)/g;
const winnerNamed = (t, names) => {
  const x = strip(t).slice(0, 450);
  const sorted = names.slice().sort((a, b) => b.length - a.length); let m = x; const ment = [];
  sorted.forEach(n => { let i = m.indexOf(n); while (i >= 0) { ment.push({ n, i, e: i + n.length }); m = m.slice(0, i) + ' '.repeat(n.length) + m.slice(i + n.length); i = m.indexOf(n); } });
  if (!ment.length) return null;
  const found = [];
  let mm; AFTER_RE.lastIndex = 0; while ((mm = AFTER_RE.exec(x))) { let cand = ment.filter(q => q.e <= mm.index && mm.index - q.e <= 30).sort((a, b) => b.e - a.e)[0]; if (cand) { const bi = x.lastIndexOf('比', mm.index); if (bi > 0 && bi < cand.i && cand.i - bi <= 3 && x[bi - 1] !== '相') { const before = ment.filter(q => q.e <= bi).sort((a, b) => b.e - a.e)[0]; if (before) cand = before; } found.push({ n: cand.n, at: mm.index }); } }   // 「A 比 B 更…」赢家是 比 前面的 A
  BEFORE_RE.lastIndex = 0; while ((mm = BEFORE_RE.exec(x))) { const after = mm.index + mm[0].length; const cand = ment.filter(q => q.i >= after && q.i - after <= 30).sort((a, b) => a.i - b.i)[0]; if (cand) found.push({ n: cand.n, at: mm.index }); }
  if (found.length) return found.sort((a, b) => a.at - b.at)[0].n;
  return ment.sort((a, b) => a.i - b.i)[0].n;
};
const recoNamed = (t, names) => winnerNamed(t, names);
const firstCty = (t, keys) => { let best = null, bi = Infinity; keys.forEach(k => { [k, EN2ZH[k]].filter(Boolean).forEach(z => { const i = t.indexOf(z); if (i >= 0 && i < bi) { bi = i; best = k; } }); }); return best; };
const recoCty = (t, keys) => { let x = String(t || ''); keys.forEach(k => { if (EN2ZH[k]) x = x.split(EN2ZH[k]).join(k); }); return winnerNamed(x, keys); };
const clausesOf = a => strip(a).slice(0, 900).split(/[。；;\n]/);
const CC = require(path.join(__dirname, '..', 'app', 'conclusion-check.js'));
const dropPin = a => String(a || '').replace(/^【系统核对】[^\n]*\n+/, '');
const pushNames = (a, names) => CC.assignNames(strip(dropPin(a)), names).push;
const cutNames = (a, names) => CC.assignNames(strip(dropPin(a)), names).cut;
const REFUSE = /(无法(预测|判断|回答|给出|确定|估计|预估)|不能(预测|判断|回答|估计)|不做预测|取不到|无法获取|均未取到|未取到任何|没有.{0,6}数据|数据不足以)/;
const CONCL = /(结论|建议|应该|优先|主推|倾向|更值得|推荐|判断|是|最|预计|预测|中性|保守|乐观|可支撑|断货|需减|候选|策略)/;
const head = a => a.slice(0, 500);

(async () => {
  const engine = await mountEngine({}); const R = buildRegistry(engine);
  const rp = (await R.report({ groupDim: 'product' })).rows;
  const rc = (await R.report({ groupDim: 'country' })).rows;
  const rl = (await R.report({ groupDim: 'line' })).rows;
  const P = rp.map(r => r.key); const CT = rc.map(r => r.key); const LN = rl.map(r => r.key);
  const lineOf = {}; rp.forEach(r => { lineOf[r.key] = r.line; });
  const audio = LN.find(l => /音频/.test(l)), tablet = LN.find(l => /平板/.test(l));
  LNS = LN.slice();
  const absent = {};
  for (const p of P) { const rows = (await R.report({ groupDim: 'country', filters: { product: [p] } })).rows; const m = {}; rows.forEach(r => { m[r.key] = r.cumCur || 0; }); absent[p] = CT.filter(c => !(m[c] > 0)); }
  const movers = P.filter(p => absent[p].length);
  const cache = {};
  const ol = async (args) => { const k = 'ol|' + JSON.stringify(args); if (!cache[k]) cache[k] = await R.outlook(args); return cache[k]; };
  const opp = async (p, c) => { const k = 'op|' + p + '|' + (c || ''); if (!cache[k]) { const a = { product: p }; if (c) a.country = c; cache[k] = await R.opportunity(a); } return cache[k]; };
  const key = o => '未来' + o.预测周数 + '周预测';
  const rank = o => o[key(o) + '排名'];
  const item = (o, n) => o.items.find(i => i.name === n);
  const fc = (o, n) => { const i = item(o, n); return i ? [i[key(o)].中性, i[key(o)].保守, i[key(o)].乐观] : []; };
  const big = rp.filter(r => (r.cumCur || 0) > 5000).map(r => r.key);
  const pick = (arr, i) => arr[i % arr.length];
  const cover = (o, n) => (o.库存可支撑周数_升序.find(x => x.name === n) || {}).可支撑周数;

  const Q = []; const add = (q, check, tag) => Q.push({ q, check, tag });

  // ---------- S1 未来 N 周排名（7） ----------
  add('未来 12 周哪个产品会卖得最多？预计多少台？为什么？', async a => { const o = await ol({ dim: 'product', weeks: 12 }); const top = rank(o)[0]; const named = recoNamed(a, P); return { pass: named === top.name && anyNum(a, fc(o, top.name)), why: '第 1 名 ' + top.name + ' 中性 ' + top.中性 + '（结论点 ' + named + '）' }; }, 'S1未来排名');
  add('未来 8 周哪个产品预计销量最高？大概多少？', async a => { const o = await ol({ dim: 'product', weeks: 8 }); const top = rank(o)[0]; const named = recoNamed(a, P); return { pass: named === top.name && anyNum(a, fc(o, top.name)), why: '第 1 名 ' + top.name + ' 中性 ' + top.中性 }; }, 'S1未来排名');
  add('接下来一个季度（13 周），哪个产品会是销量第一？预计多少台？', async a => { const o = await ol({ dim: 'product', weeks: 13 }); const top = rank(o)[0]; const named = recoNamed(a, P); return { pass: named === top.name && anyNum(a, fc(o, top.name)), why: '第 1 名 ' + top.name + ' 中性 ' + top.中性 }; }, 'S1未来排名');
  add('未来 3 个月平板和音频两条线哪条卖得更多？各预计多少台？', async a => { const o = await ol({ dim: 'line', weeks: 12 }); const top = rank(o)[0]; const named = recoNamed(a, LN); return { pass: named === top.name && LN.every(l => anyNum(a, fc(o, l))), why: '第 1 ' + top.name + '；' + LN.map(l => l + ' ' + fc(o, l)[0]).join('/') }; }, 'S1未来排名');
  add('未来 12 周哪个国家出货最多？预计多少台？', async a => { const o = await ol({ dim: 'country', weeks: 12 }); const top = rank(o)[0]; const named = recoCty(a, CT); return { pass: named === top.name && anyNum(a, fc(o, top.name)), why: '第 1 名 ' + top.name + ' 中性 ' + top.中性 }; }, 'S1未来排名');
  add('接下来 12 周 Slate 11 和 Slate 11 Pro 谁会卖得更多？分别预计多少台？', async a => { const o = await ol({ dim: 'product', weeks: 12 }); const sub = ['Slate 11', 'Slate 11 Pro']; const top = sub.sort((x, y) => fc(o, y)[0] - fc(o, x)[0])[0]; const named = recoNamed(a, sub); return { pass: named === top && sub.every(n => anyNum(a, fc(o, n))), why: '更多 ' + top + '；' + sub.map(n => n + ' ' + fc(o, n)[0]).join('/') }; }, 'S1未来排名');
  add('未来 12 周音频线里哪个产品预计卖得最多？多少台？', async a => { const o = await ol({ dim: 'product', weeks: 12, filters: { line: [audio] } }); const top = rank(o)[0]; const named = recoNamed(a, P); return { pass: named === top.name && anyNum(a, fc(o, top.name)), why: '第 1 名 ' + top.name + ' 中性 ' + top.中性 }; }, 'S1未来排名');
  // ---------- S2 全年（6） ----------
  const yr = async (dim, filters) => ol(Object.assign({ dim, weeks: 'toYearEnd' }, filters ? { filters } : {}));
  const yv = (o, n) => (o.全年预测排名.find(x => x.name === n) || {}).全年预测_中性;
  add('按现在的节奏今年全年能卖到多少？哪个产品全年预测最高？', async a => { const o = await yr('product'); const top = o.全年预测排名[0]; const named = recoNamed(a, P); return { pass: named === top.name && hasNum(a, top.全年预测_中性), why: '全年第 1 ' + top.name + ' ' + top.全年预测_中性 }; }, 'S2全年');
  add('SonicBuds SE3 今年全年预计能卖多少台？年底累计到多少？', async a => { const o = await yr('product'); return { pass: hasNum(a, yv(o, 'SonicBuds SE3')), why: '全年预测 ' + yv(o, 'SonicBuds SE3') }; }, 'S2全年');
  add('平板线全年预计多少台？和音频线比谁更高？', async a => { const o = await yr('line'); const top = o.全年预测排名[0]; const named = recoNamed(a, LN); return { pass: named === top.name && LN.every(l => hasNum(a, yv(o, l))), why: '全年 ' + LN.map(l => l + ' ' + yv(o, l)).join('/') + '，高者 ' + top.name }; }, 'S2全年');
  add('墨西哥今年全年预计出货多少台？', async a => { const o = await yr('country'); return { pass: hasNum(a, yv(o, 'Mexico')), why: 'Mexico 全年 ' + yv(o, 'Mexico') }; }, 'S2全年');
  add('今年年底 Slate 11 Pro 累计能到多少台？按现在的周销节奏算。', async a => { const o = await yr('product'); return { pass: hasNum(a, yv(o, 'Slate 11 Pro')), why: '全年预测 ' + yv(o, 'Slate 11 Pro') }; }, 'S2全年');
  add('今年全年哪个国家出货最多？预计多少？', async a => { const o = await yr('country'); const top = o.全年预测排名[0]; const named = recoCty(a, CT); return { pass: named === top.name && hasNum(a, top.全年预测_中性), why: '全年第 1 ' + top.name + ' ' + top.全年预测_中性 }; }, 'S2全年');
  // ---------- S3 断货 / 可支撑（6） ----------
  add('哪些产品 4 周内有断货风险？库存还能撑几周？', async a => { const o = await ol({ dim: 'product', weeks: 12 }); const lst = o.断货风险清单; const minI = o.库存可支撑周数_升序[0]; return { pass: (lst.length ? lst.every(n => has(a, n)) : true) && hasNum(a, minI.可支撑周数), why: '断货清单 ' + (lst.join('/') || '无') + '；最紧 ' + minI.name + ' ' + minI.可支撑周数 + ' 周' }; }, 'S3断货');
  add('SonicBuds SE2 的渠道库存还能撑几周？会不会断货？', async a => { const o = await ol({ dim: 'product', weeks: 12 }); const c = cover(o, 'SonicBuds SE2'); const risk = c < 4; const dir = risk ? /(断货|见底|撑不住|补货)/.test(head(a)) : /(不会|暂无|暂时|够|不至于|无.{0,4}断货|风险不大|需补货)/.test(head(a)); return { pass: hasNum(a, c) && dir, why: '可支撑 ' + c + ' 周，断货=' + risk }; }, 'S3断货');
  add('如果停止进货，Slate 12 Pro 的库存能卖多久？', async a => { const o = await ol({ dim: 'product', weeks: 12 }); const c = cover(o, 'Slate 12 Pro'); return { pass: hasNum(a, c), why: '可支撑 ' + c + ' 周' }; }, 'S3断货');
  add('音频线的渠道库存能支撑几周？够不够卖到年底？', async a => { const o = await ol({ dim: 'line', weeks: 'toYearEnd' }); const c = cover(o, audio); const enough = c >= o.到年底剩余周数; const dir = enough ? /(够|足以|可以)/.test(head(a)) : /(不够|撑不到|不足|需要补货|需补货|补货)/.test(head(a)); return { pass: hasNum(a, c) && dir, why: audio + ' 可支撑 ' + c + ' 周 vs 剩余 ' + o.到年底剩余周数 + ' 周，够=' + enough }; }, 'S3断货');
  add('哪个国家的渠道库存最先见底？还能撑几周？', async a => { const o = await ol({ dim: 'country', weeks: 12 }); const minI = o.库存可支撑周数_升序[0]; const named = recoCty(a, CT); const tie = named && cover(o, named) === minI.可支撑周数; return { pass: tie && hasNum(a, minI.可支撑周数), why: '最先 ' + minI.name + ' ' + minI.可支撑周数 + ' 周（并列同值算对）' }; }, 'S3断货');
  add('Slate SE 11 要不要补货？库存还够卖几周？', async a => { const o = await ol({ dim: 'product', weeks: 12 }); const c = cover(o, 'Slate SE 11'); return { pass: hasNum(a, c), why: '可支撑 ' + c + ' 周' }; }, 'S3断货');
  // ---------- S4 DOS 目标（6） ----------
  const dosOf = (o, n) => (o.DOS目标_需减库存降序 || []).find(x => x.name === n) || {};
  add('要把 Slate SE 10 的渠道 DOS 压到 90 天，要消化多少库存？停止进货要多少周？', async a => { const o = await ol({ dim: 'product', weeks: 12, dosTarget: 90 }); const d = dosOf(o, 'Slate SE 10'); return { pass: hasNum(a, d.需减库存) && hasNum(a, d.停止进货消化周数), why: '需减 ' + d.需减库存 + '，消化 ' + d.停止进货消化周数 + ' 周' }; }, 'S4DOS目标');
  add('如果所有产品的渠道 DOS 都要控制在 45 天以内，哪个产品需要减的库存最多？减多少？', async a => { const o = await ol({ dim: 'product', weeks: 12, dosTarget: 45 }); const top = o.DOS目标_需减库存降序[0]; const named = recoNamed(a, P); return { pass: named === top.name && hasNum(a, top.需减库存), why: '最多 ' + top.name + ' 需减 ' + top.需减库存 }; }, 'S4DOS目标');
  add('哪个国家最该去库存？要把渠道 DOS 降到 40 天各需要减多少？', async a => { const o = await ol({ dim: 'country', weeks: 12, dosTarget: 40 }); const top = o.DOS目标_需减库存降序[0]; const named = recoCty(a, CT); return { pass: named === top.name && hasNum(a, top.需减库存), why: '最该 ' + top.name + ' 需减 ' + top.需减库存 }; }, 'S4DOS目标');
  add('Slate 11 Pro 的渠道 DOS 降到 50 天需要减多少库存？', async a => { const o = await ol({ dim: 'product', weeks: 12, dosTarget: 50 }); const d = dosOf(o, 'Slate 11 Pro'); return { pass: hasNum(a, d.需减库存) || (d.需减库存 === 0 && /(已达标|不需要|无需|已经低于|已低于|已在)/.test(head(a))), why: '需减 ' + d.需减库存 + '（当前 DOS ' + d.当前DOS + '）' }; }, 'S4DOS目标');
  add('SonicBuds Pro 4 的 DOS 要压回 45 天，停止进货的话要几周才能消化到位？', async a => { const o = await ol({ dim: 'product', weeks: 12, dosTarget: 45 }); const d = dosOf(o, 'SonicBuds Pro 4'); return { pass: hasNum(a, d.停止进货消化周数) && hasNum(a, d.需减库存), why: '需减 ' + d.需减库存 + '，' + d.停止进货消化周数 + ' 周' }; }, 'S4DOS目标');
  add('平板线整体渠道 DOS 控制在 45 天以内要减多少库存？', async a => { const o = await ol({ dim: 'line', weeks: 12, dosTarget: 45 }); const d = dosOf(o, tablet); return { pass: hasNum(a, d.需减库存), why: tablet + ' 需减 ' + d.需减库存 }; }, 'S4DOS目标');
  // ---------- S5 主推 / 资源（7） ----------
  const candOf = o => o.主推候选_按预测量.map(x => x.name), cutOf = o => o.剔除清单.map(x => x.name);
  add('下半年主推组合选 3 个，并说明理由。', async a => { const o = await ol({ dim: 'product', weeks: 'toYearEnd' }); const n = pushNames(a, P); return { pass: n.length >= 3 && n.every(x => candOf(o).indexOf(x) >= 0), why: '候选 ' + candOf(o).join('/') + '；点名 ' + n.join('/') }; }, 'S5主推');
  add('Q4 该把资源集中在哪两个产品上？为什么？', async a => { const o = await ol({ dim: 'product', weeks: 13 }); const n = pushNames(a, P); return { pass: n.length >= 2 && n.every(x => candOf(o).indexOf(x) >= 0), why: '候选 ' + candOf(o).join('/') + '；点名 ' + n.join('/') }; }, 'S5主推');
  add('哪些产品不该再投资源了？给出理由。', async a => { const o = await ol({ dim: 'product', weeks: 12 }); const n = cutNames(a, P); const named = namedAll(strip(a).slice(0, 400), P); return { pass: cutOf(o).length > 0 && cutOf(o).some(x => named.indexOf(x) >= 0) && n.every(x => cutOf(o).indexOf(x) >= 0), why: '剔除 ' + cutOf(o).join('/') + '；点名砍 ' + n.join('/') }; }, 'S5主推');
  add('音频线下半年主推谁、清谁？', async a => { const o = await ol({ dim: 'product', weeks: 'toYearEnd', filters: { line: [audio] } }); const pn = pushNames(a, P), cn = cutNames(a, P); return { pass: pn.length >= 1 && pn.every(x => candOf(o).indexOf(x) >= 0) && cn.every(x => cutOf(o).indexOf(x) >= 0 || (item(o, x) && item(o, x).渠道DOS灯 !== '绿')), why: '候选 ' + candOf(o).join('/') + '；剔除 ' + cutOf(o).join('/') + '；点名推 ' + pn.join('/') + ' 清 ' + cn.join('/') }; }, 'S5主推');
  add('如果只能保留 4 个产品进入明年，留哪 4 个？为什么？', async a => { const o = await ol({ dim: 'product', weeks: 'toYearEnd' }); const n = pushNames(a, P); return { pass: n.length >= 4 && n.every(x => candOf(o).indexOf(x) >= 0), why: '候选 ' + candOf(o).join('/') + '；点名 ' + n.join('/') }; }, 'S5主推');
  add('平板线该重点推哪个产品？为什么？', async a => { const o = await ol({ dim: 'product', weeks: 12, filters: { line: [tablet] } }); const n = pushNames(a, P); const top = candOf(o)[0]; return { pass: n.length >= 1 && n.every(x => candOf(o).indexOf(x) >= 0) && anyNum(a, fc(o, n[0])), why: '候选 ' + candOf(o).join('/') + '（预测最高 ' + top + '）；点名 ' + n.join('/') }; }, 'S5主推');
  add('综合同比、周走势、库存和未来 12 周预测，哪个产品最值得加大投入？', async a => { const o = await ol({ dim: 'product', weeks: 12 }); const n = recoNamed(a, P); return { pass: !!n && candOf(o).indexOf(n) >= 0 && anyNum(a, fc(o, n)), why: '候选 ' + candOf(o).join('/') + '；点名 ' + n }; }, 'S5主推');
  // ---------- S6 A vs B 未来（5） ----------
  add('SonicBuds SE3 和 SonicBuds SE4 ANC 未来一个季度谁更强？分别预计多少台？', async a => { const o = await ol({ dim: 'product', weeks: 13 }); const sub = ['SonicBuds SE3', 'SonicBuds SE4 ANC']; const top = sub.slice().sort((x, y) => fc(o, y)[0] - fc(o, x)[0])[0]; return { pass: recoNamed(a, sub) === top && sub.every(n => anyNum(a, fc(o, n))), why: '更强 ' + top + '；' + sub.map(n => n + ' ' + fc(o, n)[0]).join('/') }; }, 'S6两品未来');
  add('SonicArc 和 Slate 12 Pro 谁的库存更先撑不住？各能撑几周？', async a => { const o = await ol({ dim: 'product', weeks: 12 }); const sub = ['SonicArc', 'Slate 12 Pro']; const first = sub.slice().sort((x, y) => cover(o, x) - cover(o, y))[0]; return { pass: recoNamed(a, sub) === first && sub.every(n => hasNum(a, cover(o, n))), why: '先撑不住 ' + first + '；' + sub.map(n => n + ' ' + cover(o, n) + ' 周').join('/') }; }, 'S6两品未来');
  add('SonicBuds SE2 和 SonicBuds Pro 4 谁该先去库存？渠道 DOS 降到 40 天各要减多少？', async a => { const o = await ol({ dim: 'product', weeks: 12, dosTarget: 40 }); const sub = ['SonicBuds SE2', 'SonicBuds Pro 4']; const first = sub.slice().sort((x, y) => dosOf(o, y).需减库存 - dosOf(o, x).需减库存)[0]; return { pass: recoNamed(a, sub) === first && sub.every(n => hasNum(a, dosOf(o, n).需减库存) || dosOf(o, n).需减库存 === 0), why: '先去 ' + first + '；' + sub.map(n => n + ' 需减 ' + dosOf(o, n).需减库存).join('/') }; }, 'S6两品未来');
  add('Slate SE 11 和 Slate 11 今年全年谁更高？各预计多少？', async a => { const o = await yr('product'); const sub = ['Slate SE 11', 'Slate 11']; const top = sub.slice().sort((x, y) => yv(o, y) - yv(o, x))[0]; return { pass: recoNamed(a, sub) === top && sub.every(n => hasNum(a, yv(o, n))), why: '高者 ' + top + '；' + sub.map(n => n + ' ' + yv(o, n)).join('/') }; }, 'S6两品未来');
  add('Slate 11 Pro 和 SonicBuds SE4 ANC 未来 8 周谁的量更大？各多少？谁更值得投资源？', async a => { const o = await ol({ dim: 'product', weeks: 8 }); const sub = ['Slate 11 Pro', 'SonicBuds SE4 ANC']; const top = sub.slice().sort((x, y) => fc(o, y)[0] - fc(o, x)[0])[0]; return { pass: recoNamed(a, sub) === top && sub.every(n => anyNum(a, fc(o, n))), why: '更大 ' + top + '；' + sub.map(n => n + ' ' + fc(o, n)[0]).join('/') }; }, 'S6两品未来');
  // ---------- S7 国家 × 产品（6） ----------
  add('墨西哥未来 12 周哪个产品预计卖得最多？多少台？', async a => { const o = await ol({ dim: 'product', weeks: 12, filters: { country: ['Mexico'] } }); const top = rank(o)[0]; return { pass: recoNamed(a, P) === top.name && anyNum(a, fc(o, top.name)), why: 'Mexico 第 1 ' + top.name + ' ' + top.中性 }; }, 'S7国家×产品');
  add('巴西今年全年哪个产品预计最高？多少台？', async a => { const o = await ol({ dim: 'product', weeks: 'toYearEnd', filters: { country: ['Brazil'] } }); const top = o.全年预测排名[0]; return { pass: recoNamed(a, P) === top.name && hasNum(a, top.全年预测_中性), why: 'Brazil 全年第 1 ' + top.name + ' ' + top.全年预测_中性 }; }, 'S7国家×产品');
  add('哥伦比亚哪些产品有断货风险？各能撑几周？', async a => { const o = await ol({ dim: 'product', weeks: 12, filters: { country: ['Colombia'] } }); const lst = o.断货风险清单; const minI = o.库存可支撑周数_升序[0]; return { pass: (lst.length ? lst.every(n => has(a, n)) : true) && hasNum(a, minI.可支撑周数), why: 'Colombia 断货 ' + (lst.join('/') || '无') + '；最紧 ' + minI.name + ' ' + minI.可支撑周数 }; }, 'S7国家×产品');
  add('秘鲁要把平板的渠道 DOS 压到 40 天，要减多少库存？', async a => { const o = await ol({ dim: 'line', weeks: 12, dosTarget: 40, filters: { country: ['Peru'] } }); const d = dosOf(o, tablet); return { pass: hasNum(a, d.需减库存), why: 'Peru ' + tablet + ' 需减 ' + d.需减库存 + '（当前 DOS ' + d.当前DOS + '）' }; }, 'S7国家×产品');
  add('智利下半年该主推哪个产品？为什么？', async a => { const o = await ol({ dim: 'product', weeks: 'toYearEnd', filters: { country: ['Chile'] } }); const n = pushNames(a, P); const r1 = recoNamed(a, P); const picked = n.length ? n : (r1 ? [r1] : []); return { pass: picked.length >= 1 && picked.every(x => candOf(o).indexOf(x) >= 0), why: 'Chile 候选 ' + candOf(o).join('/') + '；点名 ' + picked.join('/') }; }, 'S7国家×产品');
  add('阿根廷未来 8 周音频线预计多少台？平板呢？', async a => { const o = await ol({ dim: 'line', weeks: 8, filters: { country: ['Argentina'] } }); return { pass: LN.every(l => anyNum(a, fc(o, l))), why: 'Argentina ' + LN.map(l => l + ' ' + fc(o, l)[0]).join('/') }; }, 'S7国家×产品');
  // ---------- S8 进入新国后头 12 周（5） ----------
  for (let i = 0; i < 5; i++) {
    const A = pick(movers, i), X = pick(absent[A], i + 1);
    const qs = [A + ' 进' + zh(X) + '后头 12 周能卖多少台？', '如果 ' + A + ' 铺到' + zh(X) + '，头 12 周按周销节奏预计走多少台？累计口径又是多少？', A + ' 进入 ' + X + ' 的前 12 周量级估一下。', zh(X) + '开 ' + A + '，前 12 周能出多少台？', A + ' 打入' + zh(X) + '，头 12 周和年初至今口径各预估多少？'];
    add(qs[i], async a => { const e = (await opp(A, X)).估计[0]; return { pass: hasNum(a, e.未来12周参考) && hasCty(a, X), why: X + ' 12周参考 ' + e.未来12周参考 + '（周销参考 ' + e.周销参考 + '，累计口径中位 ' + e.中位 + '）' }; }, 'S8新国头12周');
  }
  // ---------- S9 综合策略（8） ----------
  add('综合同比、周走势、库存和未来 12 周预测，给音频线一个下半年策略：主推谁、清谁、为什么？', async a => { const o = await ol({ dim: 'product', weeks: 12, filters: { line: [audio] } }); const pn = pushNames(a, P), cn = cutNames(a, P); return { pass: pn.length >= 1 && pn.every(x => candOf(o).indexOf(x) >= 0) && cn.every(x => cutOf(o).indexOf(x) >= 0) && anyNum(a, fc(o, pn[0])), why: '候选 ' + candOf(o).join('/') + '；剔除 ' + cutOf(o).join('/') + '；点名推 ' + pn.join('/') + ' 清 ' + cn.join('/') }; }, 'S9综合策略');
  add('给平板线做一个到年底的规划：谁冲量、谁清库存、库存缺口在哪？', async a => { const o = await ol({ dim: 'product', weeks: 'toYearEnd', filters: { line: [tablet] } }); const pn = pushNames(a, P), cn = cutNames(a, P); const minI = o.库存可支撑周数_升序[0]; return { pass: pn.length >= 1 && pn.every(x => candOf(o).indexOf(x) >= 0) && cn.every(x => cutOf(o).indexOf(x) >= 0) && hasNum(a, minI.可支撑周数), why: '候选 ' + candOf(o).join('/') + '；剔除 ' + cutOf(o).join('/') + '；最紧 ' + minI.name + ' ' + minI.可支撑周数 + ' 周；点名冲 ' + pn.join('/') + ' 清 ' + cn.join('/') }; }, 'S9综合策略');
  add('按现在的节奏，年底前哪些产品会断货、哪些会积压？各需要什么动作？', async a => { const o = await ol({ dim: 'product', weeks: 'toYearEnd' }); const lst = o.断货风险清单; const red = o.items.filter(i => i.渠道DOS灯 === '红').map(i => i.name); return { pass: lst.every(n => has(a, n)) && red.every(n => has(a, n)) && hasNum(a, o.库存可支撑周数_升序[0].可支撑周数), why: '断货 ' + (lst.join('/') || '无') + '；积压(红灯) ' + (red.join('/') || '无') }; }, 'S9综合策略');
  add('明年 BP 目标如果按今年全年预测来定，两条产品线各是多少？', async a => { const o = await yr('line'); return { pass: LN.every(l => hasNum(a, yv(o, l))), why: LN.map(l => l + ' ' + yv(o, l)).join('/') }; }, 'S9综合策略');
  add('SonicBuds SE2 同比在下滑、库存又不多，现在是该清库存还是补货？给出依据。', async a => { const o = await ol({ dim: 'product', weeks: 12 }); const i = item(o, 'SonicBuds SE2'); return { pass: hasNum(a, i.可支撑周数) && (hasNum(a, Math.abs(i.SO同比)) || /同比/.test(a)), why: '可支撑 ' + i.可支撑周数 + ' 周，同比 ' + i.SO同比 + '%，DOS ' + i.渠道DOS }; }, 'S9综合策略');
  add('音频线未来 12 周预计合计多少台？平板线呢？差距大不大？', async a => { const o = await ol({ dim: 'line', weeks: 12 }); return { pass: LN.every(l => anyNum(a, fc(o, l))), why: LN.map(l => l + ' ' + fc(o, l)[0]).join('/') }; }, 'S9综合策略');
  add('如果把 Slate 12 Pro 推到哥斯达黎加，头 12 周能卖多少？Slate 12 Pro 本身未来 12 周预计多少？', async a => { const e = (await opp('Slate 12 Pro', 'Costa Rica')).估计[0]; const o = await ol({ dim: 'product', weeks: 12 }); return { pass: hasNum(a, e.未来12周参考) && anyNum(a, fc(o, 'Slate 12 Pro')), why: 'Costa Rica 12周参考 ' + e.未来12周参考 + '；本身 12 周中性 ' + fc(o, 'Slate 12 Pro')[0] }; }, 'S9综合策略');
  add('如果 Q4 预算只够主推两个产品，选谁？它们各自未来 13 周预计多少台？有没有断货风险？', async a => { const o = await ol({ dim: 'product', weeks: 13 }); const n = pushNames(a, P); return { pass: n.length >= 2 && n.every(x => candOf(o).indexOf(x) >= 0) && n.slice(0, 2).every(x => anyNum(a, fc(o, x)) && hasNum(a, cover(o, x))), why: '候选 ' + candOf(o).join('/') + '；点名 ' + n.join('/') + '；' + n.slice(0, 2).map(x => x + ' 13周 ' + fc(o, x)[0] + '/撑 ' + cover(o, x)).join('，') }; }, 'S9综合策略');

  log('题数 ' + Q.length);
  const deps = {
    chat,
    runTool: async (n, a) => { const fn = R[n]; return fn ? await fn(a) : { error: '未知工具: ' + n }; },
    optionsDirect: async (field) => R.options({ field }),
    catalogDirect: async () => { try { return engine.catalog(); } catch (e) { return null; } },
    provRetry: true, parallel: true,
    schemas: AD.TOOL_SCHEMAS, buildToolSpecs: AD.buildToolSpecs, pickTools: AD.pickTools, parseToolCall: AD.parseToolCall,
    snapshot: async () => '', filters: () => null, boardLabel: () => '产业看板',
    onProgress: (e) => { if (e && e.type === 'tool') TOOLS.push((e.agent || '') + ':' + e.tool + (e.args ? JSON.stringify(e.args).slice(0, 160) : '')); if (e && /^(prerank|prediag|preest|precmp|preoutlook)$/.test(e.type)) TOOLS.push('📐' + e.type + ' ' + JSON.stringify(e).slice(0, 220)); if (e && e.type === 'verify') TOOLS.push('🛡verify ' + JSON.stringify({ ok: e.ok, fixed: e.fixed, pinned: e.pinned, expected: e.expected })); },
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
    const refused = ri >= 0 && ri < 160 && !/(结论|总体判断|判断)/.test(a.slice(0, ri));
    const analyzed0 = !!a.trim() && !refused && CONCL.test(h) && /\d/.test(a) && P.concat(CT, LN).some(x => has(a, x) || (EN2ZH[x] && has(a, EN2ZH[x])));
    let c; try { c = await Q[i].check(a); } catch (e) { c = { pass: false, why: 'check 抛错 ' + e }; }
    const analyzed = analyzed0 || (!!c.pass && !refused);
    const correct = analyzed && !!c.pass;
    if (analyzed) nA++; if (correct) nC++;
    byTag[Q[i].tag] = byTag[Q[i].tag] || { n: 0, c: 0 }; byTag[Q[i].tag].n++; if (correct) byTag[Q[i].tag].c++;
    const secs = ((Date.now() - t0) / 1000).toFixed(0);
    rows.push({ i: i + 1, tag: Q[i].tag, q: Q[i].q, analyzed, correct, secs, why: c.why, chars: a.length, head: a.replace(/\s+/g, ' ').slice(0, 220), full: a, tools: TOOLS.slice(), verified: r && r.verified ? r.verified : null, blocked: r && r.provenanceBlocked || [] });
    try { fs.writeFileSync(OUT.replace(/\.txt$/, '') + '.full.json', JSON.stringify(rows, null, 1)); } catch (e) {}
    log('\n【' + (i + 1) + '】' + Q[i].tag + '｜' + Q[i].q + '\n   ' + (correct ? '✅ 正确' : (analyzed ? '🟡 有分析但不准' : '❌ 没分析出来')) + '  ' + secs + 's  ' + a.length + '字 | 真值：' + c.why + '\n   答：' + a.replace(/\s+/g, ' ').slice(0, 320) + (r && r.provenanceBlocked && r.provenanceBlocked.length ? '\n   门禁拦下：' + r.provenanceBlocked.slice(0, 6).join('、') : '') + '\n   工具：' + TOOLS.join(' ｜ ').slice(0, 900));
  }
  log('\n==================== 汇总 ====================');
  log('题数 ' + n + '｜能分析出来 ' + nA + '/' + n + '（' + Math.round(nA / n * 100) + '%）｜结论正确 ' + nC + '/' + n + '（' + Math.round(nC / n * 100) + '%）｜平均 ' + Math.round(rows.reduce((s, x) => s + x.chars, 0) / Math.max(1, rows.length)) + ' 字/题');
  log('分场景：' + Object.keys(byTag).map(t => t + ' ' + byTag[t].c + '/' + byTag[t].n).join('｜'));
  log('未通过：' + (rows.filter(x => !x.correct).map(x => '#' + x.i + (x.analyzed ? '(不准)' : '(没答)')).join(' ') || '无'));
  log('结果文件：' + OUT);
})();

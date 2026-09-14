/* 30 道复杂分析题实测（2026-09-11 用户：「你自己出 30 个复杂题测一下，告诉我准确率和 Agent 能不能分析出来」）
 * 全部是判断/决策/归因/组合建议类问题，不是简单问数。合成样例数据（Slate/SonicBuds 虚构世界观）；key 只读不打印。
 * 判分两档：
 *   analyzed = 真的给出了分析结论（点名对象 + 有结论/建议词 + 有数字 + 开头 500 字没有整题推脱）
 *   correct  = 结论与引擎算出的真值一致（每题一个确定性检查：名次/方向/数值/集合）
 * 用法：node eval/run-30.js [--only 3,7,12] [--out 文件]
 */
'use strict';
const fs = require('fs'); const path = require('path');
const O = require(path.join(__dirname, '..', 'app', 'ai-orchestrator.js'));
const AD = require(path.join(__dirname, '..', 'app', 'ai-context.js'));
const { mountEngine, buildRegistry } = require('./engine-tools.js');
const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : d; };
const ONLY = (arg('only', '') || '').split(',').map(s => +s).filter(Boolean);
const OUT = arg('out', path.join(__dirname, 'runs', 'run-30-' + new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19) + '.txt'));
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

const norm = s => String(s || '').replace(/,/g, '').replace(/(\d+(?:\.\d+)?)\s*万/g, (m, n) => String(Math.round(parseFloat(n) * 10000)));
const has = (a, name) => a.indexOf(name) >= 0;
const hasNum = (a, n) => { const s = norm(a); const v = Math.round(n); return new RegExp('(^|[^\\d])' + v + '([^\\d]|$)').test(s); };
const pct = v => Math.round(v * 100);
const hasPct = (a, v, tol) => { const t = tol == null ? 1 : tol; const m = norm(a).match(/-?\d+(?:\.\d+)?\s*%/g) || []; return m.some(x => Math.abs(parseFloat(x) - pct(v)) <= t); };
const REFUSE = /(无法(预测|判断|回答|给出|确定)|不能(预测|判断|回答)|不做预测|取不到|无法获取|均未取到|未取到任何|没有.{0,6}数据|数据不足以)/;
const CONCL = /(结论|建议|应该|优先|多卖|主推|倾向|更值得|推荐|排序|判断|是|最|下降|上升|走弱|走强)/;

(async () => {
  const engine = await mountEngine({}); const R = buildRegistry(engine);
  const rp = (await R.report({ groupDim: 'product' })).rows;
  const rc = (await R.report({ groupDim: 'country' })).rows;
  const rs = (await R.report({ groupDim: 'series' })).rows;
  const rl = (await R.report({ groupDim: 'line' })).rows;
  const ro = (await R.report({ groupDim: 'repOffice' })).rows;
  const tot = (await R.report({ groupDim: 'line' })).total;
  const fin = {};
  for (const lv of rl.map(r => r.key)) { const f = await R.financeProductBoard({ fromM: 1, toM: 8, lv1: [lv] }); ((f.lv4 && f.lv4.rows) || []).forEach(r => { fin[r.key] = r; }); }
  const by = (rows, k, desc) => rows.filter(r => r[k] != null && isFinite(r[k])).slice().sort((a, b) => desc === false ? a[k] - b[k] : b[k] - a[k]);
  const big = rp.filter(r => r.cumCur >= 5000);
  const P = rp.map(r => r.key);
  const slate11Country = (await R.report({ groupDim: 'country', filters: { product: ['Slate 11'] } })).rows;
  const topCountryS11 = by(slate11Country, 'cumCur')[0].key;
  const delta = rp.map(r => ({ key: r.key, d: (r.cumCur || 0) - (r.cumPrev || 0) })).sort((a, b) => b.d - a.d);
  const trendDown = rp.filter(r => { const w = r.weekly.filter(v => v > 0); return w.length >= 6 && (w.slice(-3).reduce((a, b) => a + b, 0) < w.slice(0, 3).reduce((a, b) => a + b, 0) * 0.85); }).map(r => r.key);
  const destock = rp.filter(r => r.siYoy != null && r.siYoy < 0 && r.yoy != null && r.yoy >= 0).map(r => r.key);
  const neg = rp.filter(r => r.yoy != null && r.yoy < 0).map(r => r.key);
  const bottom5 = by(rp, 'cumCur', false).slice(0, 5).map(r => r.key);
  const lineFast = by(rl, 'yoy')[0], lineSlow = by(rl, 'yoy')[1];
  const lineDosBest = by(rl, 'dos', false)[0];
  const audio = rp.filter(r => /音频/.test(r.line));
  const ALIAS = { Mexico: '墨西哥', Brazil: '巴西', Colombia: '哥伦比亚', Chile: '智利', Peru: '秘鲁', Argentina: '阿根廷', Ecuador: '厄瓜多尔', Panama: '巴拿马', 'Costa Rica': '哥斯达黎加', Uruguay: '乌拉圭', Guatemala: '危地马拉', 'Dominican Rep.': '多米尼加' };
  const anyOf = (a, names, win) => names.some(n => { const t = win ? a.slice(0, win) : a; return t.indexOf(n) >= 0 || (ALIAS[n] && t.indexOf(ALIAS[n]) >= 0); });
  const namedIn = (a, names) => names.filter(n => a.indexOf(n) >= 0);
  const head = a => a.slice(0, 500);
  log('真值摘要：top cum=' + by(rp, 'cumCur').slice(0, 3).map(r => r.key).join('/') + '；top yoy=' + by(big, 'yoy').slice(0, 3).map(r => r.key + pct(r.yoy) + '%').join('/') + '；最高DOS=' + by(rp, 'dos')[0].key + '(' + by(rp, 'dos')[0].dos + ')；同比为负=' + neg.join('/') + '；周走势下滑=' + trendDown.join('/') + '；去库存=' + destock.join('/') + '；Slate 11 最强国家=' + topCountryS11 + '；贡献最大=' + delta.slice(0, 2).map(x => x.key).join('/') + '；收入最高=' + by(Object.values(fin), 'rev26')[0].key);

  const Q = [
    { q: 'Slate 11 和 Slate 11 Pro 哪个卖得更好？收入、利润和销量综合考虑，我应该多卖哪个？',
      check: a => ({ pass: has(a, 'Slate 11 Pro') && hasNum(a, 34714) && hasNum(a, 25589) && /(多卖|主推|建议|倾向|更值得)/.test(head(a)), why: '两款累计SO 34714/25589 + 明确建议' }) },
    { q: '现在哪个产品未来能卖得更多？给我一个排序。',
      check: a => ({ pass: anyOf(head(a), by(big, 'yoy').slice(0, 3).map(r => r.key).concat(['Slate 12 Pro'])), why: '开头点名同比前三或放量期产品' }) },
    { q: '哪个产品的库存风险最大？为什么？',
      // 只看点名：DOS 数值有汇总表(近4周)与产业看板(月)两套口径，模型用哪套都算对
      check: a => ({ pass: anyOf(head(a), [by(rp, 'dos')[0].key]), why: 'DOS 最高=' + by(rp, 'dos')[0].key + '(' + by(rp, 'dos')[0].dos + ')' }) },
    { q: '如果要加大市场投入，哪个国家最值得？',
      check: a => ({ pass: anyOf(head(a), by(rc, 'yoy').slice(0, 6).map(r => r.key)), why: '点名同比前六国家之一' }) },
    { q: '哪个产品系列在拖整体的后腿？',
      check: a => ({ pass: anyOf(a.slice(0, 600), by(rs, 'yoy', false).slice(0, 2).map(r => r.key).concat(neg)), why: '同比最低的系列或其产品（前 600 字内点名）' }) },
    { q: '平板和音频两条产品线，哪条增长更快？快多少？',
      check: a => ({ pass: has(head(a), lineFast.key.slice(0, 2)) && hasPct(a, lineFast.yoy, 1) && hasPct(a, lineSlow.yoy, 1), why: lineFast.key + ' ' + pct(lineFast.yoy) + '% vs ' + pct(lineSlow.yoy) + '%' }) },
    { q: '哪些产品今年同比在下滑？分别下滑多少？',
      check: a => ({ pass: neg.every(n => has(a, n)) && neg.every(n => hasPct(a, rp.find(r => r.key === n).yoy, 1)), why: '全部下滑产品 ' + neg.join('/') + ' 及其同比' }) },
    { q: '库存周转最健康的产品是哪个？',
      check: a => ({ pass: anyOf(head(a), [by(big, 'dos', false)[0].key]), why: '有量产品里 DOS 最低=' + by(big, 'dos', false)[0].key }) },
    { q: '哪个产品应该考虑清库存或者退市了？',
      check: a => ({ pass: anyOf(head(a), [by(rp, 'dos')[0].key]), why: by(rp, 'dos')[0].key }) },
    { q: '哪个国家的库存周转最差？',
      check: a => ({ pass: anyOf(head(a), by(rc, 'dos').filter(r => r.dos === by(rc, 'dos')[0].dos).map(r => r.key)), why: 'DOS 最高的国家之一' }) },
    { q: '卖得最好的三个产品是哪三个？各卖了多少？',
      check: a => ({ pass: by(rp, 'cumCur').slice(0, 3).every(r => has(a, r.key) && hasNum(a, r.cumCur)), why: 'top3 + 各自累计' }) },
    { q: '哪个产品增速很快但库存偏高，需要提防压货？',
      // 两种数据读法都算对：①同比>100% 且 DOS 高于中位（Slate 11 Pro）；②新品 SI 远超 SO 的压货嫌疑（healthCheck 的判据）
      check: a => { const c = big.filter(r => r.yoy > 1 && r.dos > 49).map(r => r.key); const c2 = rp.filter(r => r.siCur / Math.max(1, r.cumCur) > 1.3).map(r => r.key); return { pass: anyOf(head(a), c.concat(c2)), why: '同比>100%且DOS>中位：' + c.join('/') + '；或 SI/SO>1.3 压货嫌疑：' + c2.join('/') }; } },
    { q: 'Slate 11 在哪个国家卖得最好？',
      check: a => ({ pass: anyOf(head(a), [topCountryS11]), why: topCountryS11 }) },
    { q: 'Slate 11 和 Slate 11 Pro 今年的收入和单台净售价（NSIP）分别是多少？',
      // NSIP 允许 ±1（工具给 181.6/270.3，模型写 181.64 或 182 都对）
      check: a => { const near = (n) => (norm(a).match(/\d+(?:\.\d+)?/g) || []).some(x => Math.abs(parseFloat(x) - n) <= 1); return { pass: /5[.,]?37/.test(norm(a)) && /3[.,]?52/.test(norm(a)) && near(270) && near(182), why: '收入 5.37M/3.52M，NSIP 270/182(±1)' }; } },
    { q: '音频这条线里，哪个产品最值得主推？',
      check: a => ({ pass: anyOf(head(a), by(audio.filter(r => r.cumCur >= 5000), 'yoy').slice(0, 2).map(r => r.key)), why: '音频同比前二' }) },
    { q: '从近 9 周的周销量走势看，哪些产品在持续走弱？',
      check: a => ({ pass: trendDown.length > 0 && anyOf(a, trendDown) && !anyOf(head(a), ['Slate 12 Pro']), why: '周走势下滑：' + trendDown.join('/') + '，不能把放量中的 Slate 12 Pro 算进去' }) },
    { q: '整体今年同比增长多少？哪个产品贡献最大？',
      check: a => ({ pass: hasPct(a, tot.yoy, 1) && anyOf(a, delta.slice(0, 2).map(x => x.key)), why: '整体 ' + pct(tot.yoy) + '%，贡献最大 ' + delta.slice(0, 2).map(x => x.key).join('/') }) },
    { q: '如果只能保留 5 个产品，应该砍掉哪些？',
      check: a => { const n = namedIn(a, bottom5); return { pass: n.length >= 2 && has(a, 'Slate SE 10'), why: '砍的应在末五 ' + bottom5.join('/') + ' 之内且含 Slate SE 10' }; } },
    { q: '哪个系列的 Sell-in 明显超过 Sell-out，有压货嫌疑？',
      check: a => { const c = rs.filter(r => r.siCur / r.cumCur > 1.3).map(r => r.key); const prods = rp.filter(r => c.indexOf(r.series) >= 0).map(r => r.key); return { pass: anyOf(head(a), c.concat(prods)), why: 'SI/SO>1.3：' + c.join('/') }; } },
    { q: '全流程 DOS 最高的是哪个产品？多少天？',
      check: a => ({ pass: anyOf(head(a), [by(rp, 'flowDos')[0].key]) && hasNum(a, by(rp, 'flowDos')[0].flowDos), why: by(rp, 'flowDos')[0].key + ' ' + by(rp, 'flowDos')[0].flowDos }) },
    { q: 'Slate 11 的销量趋势是上升还是下降？',
      check: a => ({ pass: /(下降|下滑|走弱|回落|放缓|萎缩)/.test(a.slice(0, 300)), why: '结论句说下降（周序列 1280→1026）' }) },
    { q: '哪个国家办今年表现最好？',
      check: a => ({ pass: anyOf(head(a), by(ro, 'cumCur').slice(0, 2).map(r => r.key.replace(' Office', '')).concat(by(ro, 'yoy').slice(0, 2).map(r => r.key.replace(' Office', '')))), why: '累计或同比前二国家办' }) },
    { q: '墨西哥和巴西，哪个市场更值得继续投入？',
      check: a => ({ pass: (has(a, 'Mexico') || has(a, '墨西哥')) && (has(a, 'Brazil') || has(a, '巴西')) && hasNum(a, 56808) && hasNum(a, 52379) && /(建议|更值得|优先|倾向|应该)/.test(head(a)), why: '两国累计 56808/52379 + 建议' }) },
    { q: '收入最高的产品是哪个？',
      check: a => ({ pass: anyOf(head(a), [by(Object.values(fin), 'rev26')[0].key]), why: by(Object.values(fin), 'rev26')[0].key }) },
    { q: '单台净售价（NSIP）最高的产品是哪个？',
      check: a => ({ pass: anyOf(head(a), [by(Object.values(fin), 'nsip26')[0].key]) && hasNum(a, by(Object.values(fin), 'nsip26')[0].nsip26), why: by(Object.values(fin), 'nsip26')[0].key + ' ' + Math.round(by(Object.values(fin), 'nsip26')[0].nsip26) }) },
    { q: '综合销量增速和收入规模，最值得加码的一个产品是哪个？',
      check: a => ({ pass: anyOf(head(a), ['Slate 11 Pro', 'SonicBuds SE4 ANC', 'SonicBuds SE3']), why: '增速与收入兼备的三者之一' }) },
    { q: '哪些产品 Sell-in 同比下降但 Sell-out 没降，说明渠道在去库存？',
      check: a => ({ pass: destock.every(n => has(a, n)), why: destock.join('/') }) },
    { q: '音频和平板两条线，哪条的库存更健康？',
      check: a => ({ pass: has(head(a), lineDosBest.key.slice(0, 2)) && hasNum(a, rl[0].dos) && hasNum(a, rl[1].dos), why: lineDosBest.key + ' DOS ' + rl.map(r => r.key.slice(0, 2) + r.dos).join('/') }) },
    { q: 'SonicBuds SE3 最近两周的销量是 0，是断货了吗？',
      check: a => ({ pass: /(延迟|未录入|报量|录入滞后|还没录|无记录)/.test(a) && !/(已经断货|确认断货|确实断货|(^|[^不])是断货)/.test(head(a)), why: '音频报量延迟 + 库存 10009/DOS 44，不是断货' }) },
    { q: '给我一个下半年的主推产品组合建议，选 3 个并说明理由。',
      // 只看结论句里推荐的（前 300 字），后文提到「Slate SE 10 已退市不推」不算推荐
      check: a => { const h = a.slice(0, 300); const n = namedIn(h, P); const posClauses = h.split(/[；;。]/).filter(cl => !/(不|非|清尾|退市|砍|慎|避免|剔除)/.test(cl)).join('；'); const bad = namedIn(posClauses, P).filter(x => neg.indexOf(x) >= 0); return { pass: n.length >= 3 && bad.length === 0, why: '结论句推荐 ≥3 个且不含同比为负的产品（' + neg.join('/') + '；「X 清尾而非主推」不算推荐）' }; } },
  ];

  const deps = {
    chat,
    runTool: async (n, a) => { const fn = R[n]; return fn ? await fn(a) : { error: '未知工具: ' + n }; },
    optionsDirect: async (field) => R.options({ field }),
    catalogDirect: async () => { try { return engine.catalog(); } catch (e) { return null; } },
    provRetry: true, parallel: true,
    schemas: AD.TOOL_SCHEMAS, buildToolSpecs: AD.buildToolSpecs, pickTools: AD.pickTools, parseToolCall: AD.parseToolCall,
    snapshot: async () => '', filters: () => null, boardLabel: () => '产业看板',
    onProgress: (e) => { if (e && e.type === 'tool') TOOLS.push((e.agent || '') + ':' + e.tool + (e.args ? JSON.stringify(e.args).slice(0, 160) : '')); if (e && (e.type === 'prerank' || e.type === 'prediag')) TOOLS.push('📐' + e.type + ' ' + JSON.stringify(e).slice(0, 200)); if (e && e.type === 'verify') TOOLS.push('🛡verify ' + JSON.stringify({ ok: e.ok, fixed: e.fixed, pinned: e.pinned, expected: e.expected })); },
  };
  let TOOLS = [];
  let nA = 0, nC = 0, n = 0; const rows = [];
  for (let i = 0; i < Q.length; i++) {
    if (ONLY.length && ONLY.indexOf(i + 1) < 0) continue;
    n++;
    const t0 = Date.now(); TOOLS = [];
    let r; try { r = await O.orchestrate(Q[i].q, 'industry', deps, { mode: 'fast' }); } catch (e) { r = { answer: '', error: String(e) }; }
    const a = String((r && r.answer) || '');
    const h = head(a);
    // 拒答只看第一句（前 160 字）：结论已经点了名，后面「音频那部分无法判断」是诚实的边界说明，不算整题推脱
    const ri = a.search(REFUSE);
    const refused = ri >= 0 && ri < 160 && !/结论/.test(a.slice(0, ri));
    const analyzed0 = !!a.trim() && !refused && CONCL.test(h) && /\d/.test(a) && P.concat(rc.map(r => r.key), ['音频', '平板', 'Mexico', 'Brazil', '墨西哥', '巴西', 'Office']).some(x => has(a, x));
    let c; try { c = Q[i].check(a); } catch (e) { c = { pass: false, why: 'check 抛错 ' + e }; }
    const analyzed = analyzed0 || (!!c.pass && !refused);   // 真值检查都过了，就是答出来了（纯问数题不必带「结论」字眼）
    const correct = analyzed && !!c.pass;
    if (analyzed) nA++; if (correct) nC++;
    const secs = ((Date.now() - t0) / 1000).toFixed(0);
    rows.push({ i: i + 1, q: Q[i].q, analyzed, correct, secs, why: c.why, head: a.replace(/\s+/g, ' ').slice(0, 220), full: a, tools: TOOLS.slice(), verified: r && r.verified ? r.verified : null, blocked: r && r.provenanceBlocked || [] });
    try { fs.writeFileSync(OUT.replace(/\.txt$/, '') + '.full.json', JSON.stringify(rows, null, 1)); } catch (e) {}   // 全文落盘：判卷争议时看原文，不靠 320 字截断
    log('\n【' + (i + 1) + '】' + Q[i].q + '\n   ' + (correct ? '✅ 正确' : (analyzed ? '🟡 有分析但不准' : '❌ 没分析出来')) + '  ' + secs + 's  | 真值：' + c.why + '\n   答：' + a.replace(/\s+/g, ' ').slice(0, 320) + (r && r.provenanceBlocked && r.provenanceBlocked.length ? '\n   门禁拦下：' + r.provenanceBlocked.slice(0, 6).join('、') : '') + '\n   工具：' + TOOLS.join(' ｜ ').slice(0, 900));
  }
  log('\n==================== 汇总 ====================');
  log('题数 ' + n + '｜能分析出来 ' + nA + '/' + n + '（' + Math.round(nA / n * 100) + '%）｜结论正确 ' + nC + '/' + n + '（' + Math.round(nC / n * 100) + '%）');
  log('未通过：' + rows.filter(x => !x.correct).map(x => '#' + x.i + (x.analyzed ? '(不准)' : '(没答)')).join(' ') || '无');
  log('结果文件：' + OUT);
})();

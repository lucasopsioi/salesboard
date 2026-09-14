/* ============================================================
   Salesboard — conclusion-check.js
   结论核对器：模型的「谁最高 / 谁第一 / 谁风险最大」必须和代码算出的排名一致。
   （2026-09-11 用户：「我要的是 100% 的数据准确性，不希望出现任何数据错误」）

   溯源门禁管的是「数字有没有出处」；这里管的是「结论点的名对不对」——
   30 题实测里模型拿着正确的排名表，结论句却点了第二名（DOS 46 当「偏高」、
   把 SE4 ANC 当「库存偏高」）。数字全对、结论错，用户照样被带偏。

   做法：从本轮工具日志里找 rankItems / healthCheck 的结果，按问题意图挑出对应指标的排名，
   检查结论句最先点名的对象是不是第 1 名（并列同值也算对）。不一致 → 给出一行「系统核对」，
   由编排层决定是让模型重写还是把这一行钉在答案最前面。
   只核「单选题」（哪个/谁/最/第一）；「哪些/排序/前几」是集合题，这里不裁。
   ============================================================ */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.ConclusionCheck = api;
})(this, function () {
  'use strict';

  /* 问题意图 → rankItems 的 by 与方向。写不进任何一类就不核（不猜）。 */
  const INTENTS = [
    { by: 'dos', order: 'asc', re: /(库存|周转)[^。？?]{0,8}(最健康|最好|最快|最低|更健康|更好)|DOS[^。？?]{0,6}(最低|最小|更低)/ },
    { by: 'dos', order: 'desc', re: /库存风险|周转(最差|更差)|库存(最差|更差)|清库存|退市|DOS[^。？?]{0,6}(最高|最大|更高)|库存[^。？?]{0,6}(最高|最重|最多|更高|更重)/ },
    { by: 'flowDos', order: 'desc', re: /全流程\s*DOS[^。？?]{0,6}(最高|最大)/ },
    { by: 'contribution', order: 'desc', re: /贡献(最大|最多)|谁拉动|主要来自/ },
    { by: 'rev', order: 'desc', re: /收入(最高|最大|最多)/ },
    { by: 'nsip', order: 'desc', re: /(NSIP|净售价|单价)[^。？?]{0,6}(最高|最大)/i },
    { by: 'gmr', order: 'desc', re: /销毛率(最高|最好)/ },
    { by: 'yoy', order: 'asc', re: /(同比|增速)[^。？?]{0,6}(最低|最差|最慢)|拖.{0,4}后腿|下滑最(多|大|狠)/ },
    { by: 'yoy', order: 'desc', re: /(增速|增长|同比)[^。？?]{0,6}(最快|最高|最猛|更快|更高|更猛)|增长最快/ },
    { by: 'cumCur', order: 'desc', re: /(卖得|销量)[^。？?]{0,6}(最好|最多|最高|第一|更好|更多)|卖得最|销量最|最畅销/ },
  ];
  const SINGLE_RE = /(哪个|哪款|哪一个|哪一款|哪条|哪家|哪国|谁|最|第一|更(快|好|高|健康|大|多|低|差|猛|重))/;
  const MULTI_RE = /(哪些|排序|排名|前\s*[0-9一二三四五六七八九十几]+|列出|各是|分别|清单|组合|砍)/;
  const LABELS = { dos: '渠道DOS', flowDos: '全流程DOS', contribution: '贡献量', rev: '收入', nsip: 'NSIP', gmr: '销毛率', yoy: 'SO同比', cumCur: '累计SO' };

  /* 财经词（收入/利润/毛/综合）出现时，「卖得更好/增长更快」就不再是单一的台数口径，不裁（#1「收入利润销量综合考虑」）。 */
  const FIN_WORDS_RE = /(收入|营收|利润|毛|综合|NSIP|净售价|单价|销毛)/;
  function intentOf(question) {
    const q = String(question || '');
    if (!SINGLE_RE.test(q) || MULTI_RE.test(q)) return null;
    for (const it of INTENTS) {
      if (!it.re.test(q)) continue;
      if (['rev', 'nsip', 'gmr'].indexOf(it.by) < 0 && FIN_WORDS_RE.test(q)) return null;
      return { by: it.by, order: it.order };
    }
    return null;
  }

  /* 集合题（哪些在走弱 / 哪些在去库存 / 哪些压货…）→ 代码预诊断 healthCheck 该给哪几张清单。写不进任何一类就不预跑。 */
  const HEALTH_INTENTS = [
    { key: '周销走弱', re: /走弱|持续下滑|周销.{0,6}(下滑|下降|走低|走弱)|(销量|周销).{0,6}(在|持续|连续).{0,4}(降|跌|弱)/ },
    { key: '周销走强', re: /走强|放量|周销.{0,6}(上升|走高|走强)/ },
    { key: '同比下滑', re: /同比.{0,8}(下滑|下降|为负|负增长|在降|在跌)|(下滑|负增长).{0,6}(的产品|的国家|的系列)|哪些.{0,12}(下滑|下降)/ },
    { key: '渠道去库存', re: /去库存|Sell-?\s?in.{0,14}(下降|降).{0,20}Sell-?\s?out.{0,8}(没|未|不)降|SI.{0,8}降.{0,12}SO.{0,6}(没|未|不)降/i },
    { key: '压货嫌疑', re: /压货|Sell-?\s?in.{0,14}(超过|高于|大于|>).{0,8}Sell-?\s?out|SI.{0,8}(超过|高于|大于|>).{0,8}SO|SI\/SO/i },
    { key: '库存风险_按渠道DOS降序', re: /红灯|库存风险|清库存|退市|库存.{0,4}(偏高|过高|积压)|DOS.{0,6}(偏高|过高)/i },
    { key: '不可比_去年同期为0', re: /不可比|去年同期为\s?0|没有同比/ },
  ];
  function healthIntent(question) {
    const q = String(question || '');
    let keys = HEALTH_INTENTS.filter(h => h.re.test(q)).map(h => h.key);
    if (keys.indexOf('渠道去库存') >= 0) keys = keys.filter(k => k !== '同比下滑');   // 「SI 同比下降」说的是 SI，不是 SO 同比下滑清单
    if (keys.indexOf('库存风险_按渠道DOS降序') >= 0 && keys.indexOf('红灯') < 0) keys.push('红灯');
    return keys.length ? keys : null;
  }

  function _AC() {
    if (typeof window !== 'undefined' && window.AnalyticsCore) return window.AnalyticsCore;
    try { return require('./analytics-core.js'); } catch (e) { return null; }
  }
  /* 预估题（2026-09-12 用户：「A 拿到 X 国卖能卖多少、参考 C 的历史、有没有机会」）：数字必须来自代码的 opportunity */
  const ESTIMATE_RE = /(预估|估计|估算|能卖(多少|出|到)|能不能卖|卖不卖得|有没有机会|有机会|拿到|拿去|推到|进入|打入|铺到|放到|下一个.{0,6}国|还能卖|增长空间|卖更多|多卖.{0,4}(台|量|多少)|机会|分到多少|能到多少|多少量|量级|能走多少|走量|能出多少|出多少台|出货多少|到顶|往上冲|优先级|开\s*[A-Za-z])/;
  const EST_TRIG_RE = /(如果|假如|拿到|拿去|推到|进入|打入|铺到|放到|去卖|能卖|能不能|有没有机会|还能|下一个|增长空间|进去|能分到|能走|能出|要不要)/;
  const ANALOG_RE = /(参考|参照|类比|对标|借鉴|按照|按|以|拿|综合|结合)\s*$/;   // 紧贴在产品名前面才算（「对标一下，B」里的 B 不是类比品）
  const ANALOG_AFTER_RE = /^\s*(为参照|为参考|为对标|作为参照|作为参考|的历史)/;
  function estimateIntent(q) { return ESTIMATE_RE.test(String(q || '')); }
  /* 问题里的产品各自扮演什么角色：本品 / 类比品；目标国家 */
  function pickEstimateRoles(question, products, countries) {
    const q = String(question || '');
    const prods = (products || []).slice().sort((a, b) => b.length - a.length);
    let masked = q; const mention = {};
    prods.forEach(p => { let i = masked.indexOf(p); while (i >= 0) { (mention[p] = mention[p] || []).push(i); masked = masked.slice(0, i) + ' '.repeat(p.length) + masked.slice(i + p.length); i = masked.indexOf(p); } });
    const analogs = prods.filter(p => (mention[p] || []).some(i => { const before = q.slice(Math.max(0, i - 6), i).replace(/[，。；、？！,.;?!].*$/, ''); const after = q.slice(i + p.length, i + p.length + 8); return (ANALOG_RE.test(before) || ANALOG_AFTER_RE.test(after)) && !/(对比|比较|相比)/.test(before); }));
    const cands = prods.filter(p => analogs.indexOf(p) < 0 && mention[p]);
    const tm = q.match(EST_TRIG_RE); const trig = tm ? tm.index : -1;
    let product = null;
    if (cands.length === 1) product = cands[0];
    else if (cands.length > 1) {
      if (trig >= 0) { let best = null, bd = Infinity; cands.forEach(p => mention[p].forEach(i => { const d = Math.abs(i - trig); if (d < bd) { bd = d; best = p; } })); product = best; }
      else product = cands.slice().sort((a, b) => mention[a][0] - mention[b][0])[0];
    } else if (analogs.length) {   // 全被当成类比品（「拿 C 对标，A 打入 X」的 A 也可能被误判）→ 离触发词最近的那个是本品
      let best = analogs[0], bd = Infinity; if (trig >= 0) analogs.forEach(p => (mention[p] || []).forEach(i => { const d = Math.abs(i - trig); if (d < bd) { bd = d; best = p; } }));
      product = best; analogs.splice(analogs.indexOf(best), 1);
    }
    const ctys = countries || [];
    let country = null;
    if (ctys.length) {
      const AC = _AC(); const alias = AC ? AC.COUNTRY_ALIAS : {};
      const pos = ctys.map(k => { const zs = Object.keys(alias).filter(z => alias[z] === k); const idxs = [q.indexOf(k)].concat(zs.map(z => q.indexOf(z))).filter(i => i >= 0); return { k, i: idxs.length ? Math.min.apply(null, idxs) : -1 }; }).filter(x => x.i >= 0).sort((a, b) => a.i - b.i);
      const after = pos.filter(x => trig >= 0 && x.i > trig);
      country = after.length ? after.map(x => x.k) : (pos.length >= 2 ? pos.map(x => x.k) : (pos.length ? [pos[pos.length - 1].k] : null));   // 「X1 和 X2 哪个更值得推 A」两国都要算
    }
    return { product, analogs: analogs.filter(p => p !== product), countries: country };
  }
  function countryNamed(head, keys) {
    const AC = _AC(); const alias = AC ? AC.COUNTRY_ALIAS : {};
    const hits = [];
    (keys || []).forEach(k => { const i = head.indexOf(k); if (i >= 0) hits.push({ k, i }); Object.keys(alias).forEach(z => { if (alias[z] === k) { const j = head.indexOf(z); if (j >= 0) hits.push({ k, i: j }); } }); });
    hits.sort((a, b) => a.i - b.i);
    return hits.length ? hits[0].k : null;
  }
  function fmtEst(out, e) {
    const parts = ['份额法 ' + e.份额法, '规模法 ' + e.规模法].concat((e.类比法 || []).filter(x => x.估计 != null).map(x => '类比 ' + x.类比品 + ' ' + x.估计));
    const m = e.市场环境 || {};
    const env = (m.产品线渠道DOS != null || m.产品线SO != null) ? '；目标国 ' + e.国家 + ' 的' + (out.line || '产品线') + '：SO ' + m.产品线SO + ' 台（同比 ' + m.产品线SO同比 + '%），渠道 DOS ' + m.产品线渠道DOS + ' 天（' + m.产品线DOS灯 + '灯），国家总 SO ' + m.国家总SO + ' 台' : '';
    return out.product + ' 在 ' + e.国家 + '：区间 ' + e.区间低 + '–' + e.区间高 + ' 台，中位 ' + e.中位 + '（' + parts.join('，') + '）' + (e.已在售 ? '；已在售，实际累计 ' + e.实际累计SO + ' 台，空间 ' + e.空间 : '；未在售') + (e.周销参考 != null ? '；周销参考 ' + e.周销参考 + ' 台/周' : '') + env;
  }
  /* 预估题核对：本轮 opportunity 的数字必须出现在正文；排名模式还要点对第 1 名国家 */
  function checkEstimate(q, a, toolLog) {
    const outs = (toolLog || []).filter(x => x && x.n === 'opportunity' && x.out && !x.out.error && Array.isArray(x.out.估计) && x.out.估计.length).map(x => x.out);
    if (!outs.length) return null;
    const head = headOf(a);
    for (const out of outs) {
      const ranking = /全部未进入国家/.test(String(out.目标国家 || ''));
      if (ranking) {
        const top = out.估计[0]; const keys = out.估计.map(e => e.国家);
        const tied = out.估计.filter(e => e.中位 === top.中位).map(e => e.国家);
        const named = countryNamed(head, keys);
        const show = out.估计.slice(0, 3).map((e, i) => (i + 1) + '. ' + e.国家 + '（中位 ' + e.中位 + '，区间 ' + e.区间低 + '–' + e.区间高 + '）').join('　');
        if (!named) return { ok: false, kind: 'name', named: null, expected: top.国家, source: 'opportunity', line: '【系统核对】结论句没有点名国家。代码预估 ' + out.product + ' 未进入国家排名（年初至今口径）：' + show + '。结论应以第 1 名 ' + top.国家 + ' 为准。' };
        if (tied.indexOf(named) < 0) return { ok: false, kind: 'name', named, expected: top.国家, source: 'opportunity', line: '【系统核对】代码预估 ' + out.product + ' 未进入国家排名（年初至今口径）：' + show + '。结论应以第 1 名 ' + top.国家 + ' 为准；上文点名的 ' + named + ' 不是第 1 名。' };
        if (![top.中位, top.区间低, top.区间高].some(v => valueShown(a, v))) return { ok: false, kind: 'value', named, expected: top.国家, source: 'opportunity', line: '【系统核对】正文没有引用代码预估的数字。' + out.product + ' 未进入国家排名：' + show + '。请以此为准。' };
        continue;
      }
      const e = out.估计[0];
      // 问「进入后头/前 12 周」→ 必须引用代码的 未来12周参考（周销参考×12），不能拿年初至今口径的中位冒充
      if (/(头|前|首)\s*(12|十二)\s*周|(头|前|首)三个月|前\s*3\s*个月/.test(q) && e.未来12周参考 != null && !valueShown(a, e.未来12周参考)) return { ok: false, kind: 'value', named: null, expected: out.product, source: 'opportunity', line: '【系统核对】' + out.product + ' 进入 ' + e.国家 + ' 后头 12 周的参考量是 ' + e.未来12周参考 + ' 台（代码口径：周销参考 ' + e.周销参考 + ' 台/周 × 12）；年初至今口径的估计区间 ' + e.区间低 + '–' + e.区间高 + '（中位 ' + e.中位 + '）是另一回事，不能当头 12 周的量。正文没有引用 ' + e.未来12周参考 + '，请以此为准。' };
      const shown = [e.中位, e.区间低, e.区间高].filter(v => v != null).some(v => valueShown(a, v));
      if (!shown) return { ok: false, kind: 'value', named: null, expected: out.product, source: 'opportunity', line: '【系统核对】正文没有引用代码预估的数字：' + fmtEst(out, e) + '。以上为代码按口径算出的估计，请以此为准；不得自行估算。' };
      // 问到目标国的周转/DOS/库存健康 → 代码给的产品线渠道 DOS 必须出现（v-composite #30 模型拿着 DOS 53 说「数据未包含」）
      if (/(DOS|周转|库存.{0,6}健康|健康吗|风险)/i.test(q) && e.市场环境 && e.市场环境.产品线渠道DOS != null && !valueShown(a, e.市场环境.产品线渠道DOS)) return { ok: false, kind: 'value', named: null, expected: out.product, source: 'opportunity', line: '【系统核对】' + e.国家 + ' 的' + (out.line || '产品线') + '渠道 DOS 为 ' + e.市场环境.产品线渠道DOS + ' 天（' + e.市场环境.产品线DOS灯 + '灯，代码口径：库存×28÷近4周SO），正文没有引用；' + fmtEst(out, e) + '。请以此为准。' };
      if (e.已在售 && !valueShown(a, e.实际累计SO)) return { ok: false, kind: 'value', named: null, expected: out.product, source: 'opportunity', line: '【系统核对】' + out.product + ' 在 ' + e.国家 + ' 已在售，实际累计 ' + e.实际累计SO + ' 台（' + fmtEst(out, e) + '），正文没有引用实际销量，请以此为准。' };
    }
    return { ok: true, named: null, expected: outs[0].product, source: 'opportunity', checkedEstimate: true };
  }

  /* 前瞻题（未来/全年/断货/DOS 目标/主推组合）：判断依据全来自代码的 outlook */
  const OUTLOOK_RE = /(未来|接下来|下个月|下季度|下半年|年底|全年|Q[34]|四季度|三季度|断货|可支撑|撑多久|撑几周|撑不住|够不够卖|能卖多久|见底|压到|降到|控制到|控制在|压回|降回|天以内|消化|去库存|补货|主推|组合|资源.{0,6}(放|集中|投)|前景|预测|预计|展望|节奏|会不会|策略|该推|重点推|推哪个|推谁|不该再投|砍掉|停掉|保留|规划|加大投入|冲量|选谁)/;
  function outlookIntent(q) { return OUTLOOK_RE.test(String(q || '')); }
  function outlookParams(q) {
    q = String(q || '');
    let weeks = 12;
    let m = q.match(/(未来|接下来|后面|今后)\s*(\d{1,2})\s*周/); if (m) weeks = +m[2];
    else if ((m = q.match(/(未来|接下来|后面|今后)\s*(\d{1,2})\s*个?月/))) weeks = +m[2] * 4;
    else if (/下季度|Q4|四季度|Q3|三季度|一个季度/.test(q)) weeks = 13;
    else if (/下半年|H2|年底|全年|今年.{0,8}(能|会).{0,6}(卖|到|做)/.test(q)) weeks = 'toYearEnd';
    let dosTarget = null;
    m = q.match(/(DOS|周转|库存)[^。？?]{0,12}?(压到|降到|降至|压至|控到|控制到|控制在|做到|回到|降回|控在|压回)\s*(\d{2,3})/i); if (m) dosTarget = +m[3];
    else if ((m = q.match(/(\d{2,3})\s*天\s*(以内|以下|之内|内)/))) dosTarget = +m[1];
    return { weeks, dosTarget };
  }
  /* 结论里哪些名字是「推」的、哪些是「砍/清」的：从左到右扫，遇到推词进推模式、遇到砍词进砍模式，名字归当前模式；句号/分号/换行重置。
     「主推 A 与 B，清理 C」→ 推 A、B，砍 C；「唯一要清的是 C，冲量主力是 A / B」→ 砍 C，推 A、B。 */
  const PUSH_WORD = /(主推|优先推|建议推|首推|重点推|重点|集中|组合|冲量|保留|留下|留哪|加大|应选|建议选|选择|首选|选谁|选|投资源|加码|资源放)/;
  const CUT_WORD = /(砍|停掉|停止|剔除|放弃|清尾|清理|清库存|要清|该清|清掉|清的是|清谁|不推|不主推|不建议|不该再投|不再投|退市|去库存|减少投入|撤|排除|不纳入|不入选|不选|落选|不考虑|不列入|不能列为|不满足|不在.{0,3}之列|剔出)/;
  function assignNames(text, names, win) {
    const W = win || 600;   // 只看结论段：后文的候选/剔除清单是参考资料，不是建议
    const x = String(text || '').replace(/^【系统核对】[^\n]*\n+/, '').replace(/[#*_`>|]/g, ' ').slice(0, W);
    const sorted = (names || []).slice().sort((a, b) => b.length - a.length);
    let masked = x; const ment = [];
    sorted.forEach(n => { let i = masked.indexOf(n); while (i >= 0) { ment.push({ n, i }); masked = masked.slice(0, i) + ' '.repeat(n.length) + masked.slice(i + n.length); i = masked.indexOf(n); } });
    const marks = [];
    const re = new RegExp('(' + PUSH_WORD.source.slice(1, -1) + ')|(' + CUT_WORD.source.slice(1, -1) + ')|([。；;\\n])', 'g');
    let m; while ((m = re.exec(masked))) { let mode = m[1] ? 'push' : (m[2] ? 'cut' : 'reset'); if (mode === 'push' && /(不|非|未|别|无法|排除|不能|不宜|不应|不纳入|不列入|不入选|不选|不考虑|剔除|排除在)\s*$/.test(masked.slice(Math.max(0, m.index - 6), m.index))) mode = 'cut'; marks.push({ i: m.index, e: m.index + m[0].length, mode }); }
    const push = [], cut = [];
    const modeAt = (i) => { let mode = null; for (const k of marks) { if (k.i > i) break; mode = k.mode === 'reset' ? null : k.mode; } return mode; };
    const raw = String(text || '').replace(/^【系统核对】[^\n]*\n+/, '').slice(0, W);
    const modeAfter = (mm) => { for (const k of marks) { if (k.i <= mm.i) continue; if (k.mode === 'reset') return null; const gap = raw.slice(mm.i + mm.n.length, k.i); if (!/^[\s）)】、]*(是|为|属于|作为|应|要|可|需|将|：|:)?[^，。；,;|（(]{0,6}$/.test(gap)) return null; return k.mode; } return null; };   // 「A/B 是冲量主力」：名字在推词前面且紧挨着（≤14 字、不跨表格列）才归它
    ment.sort((a, b) => a.i - b.i);
    const modes = ment.map(mm => modeAt(mm.i));
    ment.forEach((mm, k) => {
      if (modes[k]) return;
      const md = modeAfter(mm); if (!md) return;
      modes[k] = md;
      // 「A / B / C 是冲量主力」：紧挨着的前几个名字（中间只有分隔符）一并归它
      for (let j = k - 1; j >= 0 && !modes[j]; j--) { const gap = raw.slice(ment[j].i + ment[j].n.length, ment[j + 1].i); if (!/^[\s\/、,，和与及+·]*$/.test(gap)) break; modes[j] = md; }
    });
    // 同一个名字以最早一次带模式的提法为准（结论句在前；后文「Slate 11 进入去库存阶段」是描述，不推翻结论）
    const first = {};
    ment.forEach((mm, k) => { const mode = modes[k]; if (mode && !first[mm.n]) first[mm.n] = mode; });
    Object.keys(first).forEach(n => { if (first[n] === 'push') push.push(n); else cut.push(n); });
    return { push, cut };
  }

  function checkOutlook(q, a, toolLog) {
    const outs = (toolLog || []).filter(x => x && x.n === 'outlook' && x.out && !x.out.error && Array.isArray(x.out.items) && x.out.items.length).map(x => x.out);
    if (!outs.length) return null;
    const out = outs[0]; const key = '未来' + out.预测周数 + '周预测';
    const head = headOf(a); const names = out.items.map(i => i.name);
    const fail = (kind, line) => ({ ok: false, kind, named: null, expected: null, source: 'outlook', line });
    const coverQ = /(断货|可支撑|撑多久|撑几周|撑不住|见底|够不够卖|能卖多久|卖多久)/.test(q);
    const dosQ = !!(out.DOS目标_需减库存降序 && out.DOS目标_需减库存降序.length && /(压到|降到|降至|压至|控到|控制到|控制在|做到|回到|降回|控在|压回|天\s*(以内|以下|之内|内))/.test(q));
    const pushQ = /(主推|组合|该推|优先推|重点推|推哪个|推谁|资源.{0,6}(放|集中|投)|砍掉|停掉|不该再投|放弃|选谁|留哪|保留|冲量|加大投入)/.test(q);
    const wantAll = /(各|分别|两条|每个|所有|都)/.test(q);
    // ① DOS 目标：需减库存必须出现（点名对象优先，否则需减最多的那个）
    if (out.DOS目标_需减库存降序 && out.DOS目标_需减库存降序.length && /(压到|降到|降至|压至|控到|控制到|控制在|做到|回到|降回|控在|压回|天\s*(以内|以下|之内|内))/.test(q)) {
      const inQ = firstNamedAll(q, names); const pickN = inQ.length ? inQ[0] : out.DOS目标_需减库存降序[0].name;
      const d = out.DOS目标_需减库存降序.find(x => x.name === pickN) || out.DOS目标_需减库存降序[0];
      if (!inQ.length && SINGLE_RE.test(q) && !MULTI_RE.test(q)) {
        const named = firstNamed(head, names); const top = out.DOS目标_需减库存降序[0];
        if (named && named !== top.name && (out.DOS目标_需减库存降序.find(x => x.name === named) || {}).需减库存 !== top.需减库存) return fail('name', '【系统核对】按代码计算，把渠道 DOS 压到 ' + top.目标DOS + ' 天需减库存最多的是 ' + top.name + '（需减 ' + top.需减库存 + ' 台，当前 DOS ' + top.当前DOS + ' 天）；' + out.DOS目标_需减库存降序.slice(0, 3).map((x, i) => (i + 1) + '. ' + x.name + ' 需减 ' + x.需减库存).join('　') + '。上文点名的 ' + named + ' 不是需减最多的（DOS 天数最高不等于要减的台数最多）。');
      }
      if (!valueShown(a, d.需减库存) && !(d.需减库存 === 0 && /(已达标|不需要|无需|已经低于|已低于|已经在|已在.{0,4}以内)/.test(head))) return fail('value', '【系统核对】' + d.name + ' 要把渠道 DOS 从 ' + d.当前DOS + ' 天压到 ' + d.目标DOS + ' 天：目标库存 ' + d.目标库存 + ' 台，需减库存 ' + d.需减库存 + ' 台，停止进货靠 SO 消化约 ' + d.停止进货消化周数 + ' 周（代码口径：目标库存=目标DOS×近4周日均）。正文没有引用这些数字，请以此为准。');
      if (!/(断货|可支撑|撑多久|撑几周|主推|组合|全年|年底)/.test(q)) return { ok: true, named: d.name, expected: d.name, source: 'outlook', checkedOutlook: true };   // DOS 目标题核到这里就够了
    }
    // ② 断货 / 可支撑：可支撑周数最少的对象及其周数必须出现（点名对象优先）
    if (coverQ && out.库存可支撑周数_升序.length) {
      const inQ = firstNamedAll(q, names);
      const pushed = (!inQ.length && pushQ) ? assignNames(a, names).push : [];
      const it = inQ.length ? out.库存可支撑周数_升序.find(x => x.name === inQ[0]) : (pushed.length ? out.库存可支撑周数_升序.find(x => x.name === pushed[0]) : out.库存可支撑周数_升序[0]);
      if (it && !valueShown(a, it.可支撑周数)) return fail('value', '【系统核对】代码算的库存可支撑周数（渠道库存÷近4周周均）：' + out.库存可支撑周数_升序.slice(0, 5).map(x => x.name + ' ' + x.可支撑周数 + ' 周（' + x.断货风险 + '）').join('、') + '。断货风险清单：' + (out.断货风险清单.length ? out.断货风险清单.join('、') : '无') + '。正文没有引用 ' + it.name + ' 的可支撑周数 ' + it.可支撑周数 + '，请以此为准。');
      if (!inQ.length && !pushed.length && out.断货风险清单.length && !out.断货风险清单.some(n => head.indexOf(n) >= 0)) return fail('name', '【系统核对】代码判定的断货风险清单（可支撑周数<4 周）：' + out.断货风险清单.join('、') + '。结论句没有点到任何一个，请以此为准。');
      if (inQ.length >= 2 && SINGLE_RE.test(q)) { const sub = out.库存可支撑周数_升序.filter(x => inQ.indexOf(x.name) >= 0); const first = sub[0]; const named = firstNamed(head, sub.map(x => x.name)); if (first && named && named !== first.name && (sub.find(x => x.name === named) || {}).可支撑周数 !== first.可支撑周数) return fail('name', '【系统核对】代码算的可支撑周数：' + sub.map(x => x.name + ' ' + x.可支撑周数 + ' 周').join('、') + '。最先撑不住的是 ' + first.name + '；上文点名的 ' + named + ' 不是。'); }
      if (!pushQ && !/(预计|预测|未来|接下来|全年|年底)/.test(q)) return { ok: true, named: it ? it.name : null, expected: it ? it.name : null, source: 'outlook', checkedOutlook: true };
    }
    // ③ 主推 / 砍掉：点名的主推必须在候选清单里，砍掉的必须在剔除清单里
    if (/(主推|组合|该推|优先推|资源.{0,6}(放|集中|投)|砍掉|停掉|不该再投|放弃)/.test(q)) {
      const cand = out.主推候选_按预测量.map(x => x.name); const cut = out.剔除清单.map(x => x.name);
      const asg = assignNames(a, names);
      const badPush = asg.push.filter(n => cut.indexOf(n) >= 0);
      if (badPush.length) { const why = badPush.map(n => n + '（' + (out.剔除清单.find(x => x.name === n) || { 原因: [] }).原因.join('、') + '）').join('、'); return fail('name', '【系统核对】代码判定 ' + why + ' 不满足主推条件（非退市、渠道DOS非红、SO同比非负、近4周有销量），不能列为主推。主推候选（按预测量）：' + (cand.length ? out.主推候选_按预测量.map(x => x.name + ' ' + x.中性).join('、') : '无') + '。请以此为准。'); }
      const badCut = asg.cut.filter(n => cand.indexOf(n) >= 0 && cut.indexOf(n) < 0);
      if (badCut.length) return fail('name', '【系统核对】' + badCut.join('、') + ' 是代码判定的主推候选（同比非负、DOS 非红、非退市、近4周有销量），不应砍掉。剔除清单：' + (cut.length ? out.剔除清单.map(x => x.name + '（' + x.原因.join('、') + '）').join('、') : '无') + '。请以此为准。');
      if (/(主推|组合|该推|优先推|重点推|推哪个|推谁|资源.{0,6}(放|集中|投)|选谁|留哪|保留|冲量|加大投入)/.test(q) && cand.length && !asg.push.some(n => cand.indexOf(n) >= 0) && !firstNamedAll(headOf(a), cand).length) return fail('name', '【系统核对】结论没有点到任何主推候选。代码判定的主推候选（按' + key + '中性排序）：' + out.主推候选_按预测量.map(x => x.name + ' ' + x.中性).join('、') + '；剔除：' + (cut.length ? out.剔除清单.map(x => x.name + '（' + x.原因.join('、') + '）').join('、') : '无') + '。请以此为准。');
      return { ok: true, named: null, expected: cand[0] || null, source: 'outlook', checkedOutlook: true };
    }
    // ④ 全年：点名对象的全年预测，或全年预测第 1 名
    if (/(全年|年底|今年.{0,8}(能|会).{0,6}(卖|到|做))/.test(q) && /(预计|预测|多少|能到|能卖|目标|各是|分别)/.test(q) && out.全年预测排名.length) {
      const inQ = firstNamedAll(q, names); const it = inQ.length ? out.全年预测排名.find(x => x.name === inQ[0]) : out.全年预测排名[0];
      if (wantAll && out.全年预测排名.length <= 4) { const miss = out.全年预测排名.filter(x => !valueShown(a, x.全年预测_中性)); if (miss.length) return fail('value', '【系统核对】代码全年预测（累计SO+近4周周均×到年底剩余 ' + out.到年底剩余周数 + ' 周）：' + out.全年预测排名.map(x => x.name + ' ' + x.全年预测_中性).join('、') + '。正文缺 ' + miss.map(x => x.name).join('、') + ' 的数字，请以此为准。'); }
      if (it && !valueShown(a, it.全年预测_中性)) return fail('value', '【系统核对】代码全年预测（累计SO+近4周周均×到年底剩余 ' + out.到年底剩余周数 + ' 周）：' + out.全年预测排名.slice(0, 5).map(x => x.name + ' ' + x.全年预测_中性).join('、') + '。正文没有引用 ' + it.name + ' 的全年预测 ' + it.全年预测_中性 + '，请以此为准。');
      if (!inQ.length && SINGLE_RE.test(q) && !MULTI_RE.test(q)) { const named = firstNamed(head, names); const top = out.全年预测排名[0]; if (named && named !== top.name && (out.全年预测排名.find(x => x.name === named) || {}).全年预测_中性 !== top.全年预测_中性) return fail('name', '【系统核对】代码全年预测排名：' + out.全年预测排名.slice(0, 3).map((x, i) => (i + 1) + '. ' + x.name + '（' + x.全年预测_中性 + '）').join('　') + '。结论应以第 1 名 ' + top.name + ' 为准；上文点名的 ' + named + ' 不是第 1 名。'); }
      return { ok: true, named: null, expected: it ? it.name : null, source: 'outlook', checkedOutlook: true };
    }
    // ⑤ 未来 N 周：点名对象的中性预测，或第 1 名（单选题）
    const rk = out[key + '排名'] || [];
    if (rk.length) {
      const inQ = firstNamedAll(q, names);
      if (inQ.length) {
        for (const n of inQ.slice(0, 3)) { const it = rk.find(x => x.name === n); if (it && ![it.中性, it.保守, it.乐观].some(v => valueShown(a, v))) return fail('value', '【系统核对】代码' + key + '：' + inQ.slice(0, 3).map(m => { const x = rk.find(y => y.name === m); return x ? m + ' 中性 ' + x.中性 + '（保守 ' + x.保守 + '、乐观 ' + x.乐观 + '）' : m + ' 无预测'; }).join('；') + '。正文没有引用 ' + n + ' 的预测数字，请以此为准。'); }
        if (inQ.length >= 2 && SINGLE_RE.test(q) && !coverQ && !dosQ) { const sub = rk.filter(x => inQ.indexOf(x.name) >= 0); const top = sub[0]; const named = firstNamed(head, sub.map(x => x.name)); if (named && named !== top.name && (sub.find(x => x.name === named) || {}).中性 !== top.中性) return fail('name', '【系统核对】代码' + key + '中性：' + sub.map(x => x.name + ' ' + x.中性).join('、') + '。结论应以 ' + top.name + ' 为准；上文点名的 ' + named + ' 预测更低。'); }
        return { ok: true, named: inQ[0], expected: inQ[0], source: 'outlook', checkedOutlook: true };
      }
      if (wantAll && rk.length <= 4) { const miss = rk.filter(x => ![x.中性, x.保守, x.乐观].some(v => valueShown(a, v))); if (miss.length) return fail('value', '【系统核对】代码' + key + '中性：' + rk.map(x => x.name + ' ' + x.中性).join('、') + '。正文缺 ' + miss.map(x => x.name).join('、') + ' 的数字，请以此为准。'); return { ok: true, named: null, expected: null, source: 'outlook', checkedOutlook: true }; }
      if (SINGLE_RE.test(q) && !MULTI_RE.test(q) && !coverQ && !dosQ && !pushQ) {
        const top = rk[0]; const named = firstNamed(head, names);
        if (!named) return fail('name', '【系统核对】结论句没有点名。代码' + key + '排名：' + rk.slice(0, 3).map((x, i) => (i + 1) + '. ' + x.name + '（中性 ' + x.中性 + '）').join('　') + '。结论应以第 1 名 ' + top.name + ' 为准。');
        if (named !== top.name && (rk.find(x => x.name === named) || {}).中性 !== top.中性) return fail('name', '【系统核对】代码' + key + '排名：' + rk.slice(0, 3).map((x, i) => (i + 1) + '. ' + x.name + '（中性 ' + x.中性 + '）').join('　') + '。结论应以第 1 名 ' + top.name + ' 为准；上文点名的 ' + named + ' 不是第 1 名。');
        if (![top.中性, top.保守, top.乐观].some(v => valueShown(a, v))) return fail('value', '【系统核对】正文没有引用代码预测数字。' + key + '第 1 名 ' + top.name + '：中性 ' + top.中性 + '（保守 ' + top.保守 + '、乐观 ' + top.乐观 + '）。请以此为准。');
        return { ok: true, named, expected: top.name, source: 'outlook', checkedOutlook: true };
      }
    }
    return { ok: true, named: null, expected: null, source: 'outlook', checkedOutlook: false };
  }

  /* 问题指向哪个维度的排名：产品线 / 系列 / 国家 / 国家办 / 区域 / 型号，默认产品 */
  function dimOf(question) {
    const q = String(question || '');
    /* 先看问题真正要的对象（「音频线里哪个产品」问的是产品，「平板线整体 DOS」问的是产品线，「哪个产品系列」是系列） */
    if (/系列/.test(q)) return 'series';
    const prodQ = /哪个产品|哪款|哪些产品|哪一个产品|产品(里|中|最|会|预计|该)|主推谁|清谁|推谁|留哪|砍哪|谁(冲量|清库存)|机型|型号/.test(q);
    const lineQ = /产品线|条线|哪条|两条|(音频|平板)(线|的|整体)|product ?line|(^|[^a-z])line([^a-z]|$)/i.test(q);
    if (prodQ) return 'product';
    if (lineQ) return 'line';   // 「平板线全年…和音频线比谁更高」问的是两条线，不是产品
    if (/哪个国家|哪些国家|哪国|国家(里|最|会|预计|该)/.test(q)) return 'country';
    if (/谁(该|会|更|最)/.test(q)) return 'product';
    if (/国家|哪国|哪个国/.test(q)) return 'country';
    if (/国家办/.test(q)) return 'repOffice';
    if (/区域|大区/.test(q)) return 'region';
    if (/型号/.test(q)) return 'model';
    return 'product';
  }

  /* 结论句：去掉 markdown 装饰后的前 220 字 */
  function headOf(answer) {
    return String(answer || '').replace(/[#*_`>|]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 220);
  }

  /* 结论句里最先点到的名字。名字按长度降序匹配并遮蔽，「Slate 11 Pro」不会被当成「Slate 11」。 */
  function firstNamed(head, names) {
    const sorted = (names || []).slice().sort((a, b) => b.length - a.length);
    let masked = head; const hits = [];
    sorted.forEach(nm => {
      let idx = masked.indexOf(nm);
      while (idx >= 0) { hits.push({ nm, idx }); masked = masked.slice(0, idx) + ' '.repeat(nm.length) + masked.slice(idx + nm.length); idx = masked.indexOf(nm); }
    });
    if (!hits.length) return null;
    hits.sort((a, b) => a.idx - b.idx);
    return hits[0].nm;
  }

  /* 文本里出现的全部名字（长名优先遮蔽） */
  function firstNamedAll(text, names) {
    const sorted = (names || []).slice().sort((a, b) => b.length - a.length);
    let masked = String(text || ''); const hits = [];
    sorted.forEach(nm => {
      const idx = masked.indexOf(nm);
      if (idx >= 0) { hits.push(nm); masked = masked.split(nm).join(' '.repeat(nm.length)); }
    });
    return hits;
  }

  /* 从工具日志里挑出与意图匹配的排名：优先 rankItems（by+order 都对），退而求其次用 healthCheck 的库存风险表 */
  function pickRanking(intent, toolLog) {
    const label = LABELS[intent.by];
    for (const e of toolLog || []) {
      const o = e && e.out; if (!o || o.error) continue;
      if (e.n === 'rankItems' && o.by === label && Array.isArray(o.items) && o.items.length) {
        const ord = (o.order === '升序') ? 'asc' : 'desc';
        if (ord !== intent.order) continue;
        return { source: 'rankItems', label, order: ord, items: o.items.map(x => ({ name: x.name, value: x['值'] })) };
      }
    }
    if (intent.by === 'dos' && intent.order === 'desc') {
      for (const e of toolLog || []) {
        const o = e && e.out; if (!o || o.error) continue;
        if (e.n === 'healthCheck' && Array.isArray(o['库存风险_按渠道DOS降序']) && o['库存风险_按渠道DOS降序'].length) {
          return { source: 'healthCheck', label, order: 'desc', items: o['库存风险_按渠道DOS降序'].map(x => ({ name: x.name, value: x['渠道DOS'] })) };
        }
      }
    }
    return null;
  }

  /* 正文里有没有出现这个数（容忍千分位、「万」「M」单位、四舍五入到整数/一位小数） */
  function valueShown(answer, v) {
    if (v == null || typeof v !== 'number' || !isFinite(v)) return true;
    const a = String(answer || '')
      .replace(/(\d),(?=\d{3})/g, '$1')
      .replace(/(\d+(?:\.\d+)?)\s*万/g, (m, n) => String(Math.round(parseFloat(n) * 10000)))
      .replace(/(\d+(?:\.\d+)?)\s*M(?![a-zA-Z])/g, (m, n) => String(Math.round(parseFloat(n) * 1000000)));
    const nums = (a.match(/-?\d+(?:\.\d+)?/g) || []).map(parseFloat);
    const tol = Math.max(0.6, Math.abs(v) * 0.005);
    return nums.some(n => Math.abs(n - v) <= tol || Math.abs(Math.abs(n) - Math.abs(v)) <= tol);
  }

  function check(opts) {
    const q = String((opts && opts.question) || ''), a = String((opts && opts.answer) || '');
    if (estimateIntent(q)) { const ce = checkEstimate(q, a, opts && opts.toolLog); if (ce) return ce; }
    if (outlookIntent(q)) {
      const co = checkOutlook(q, a, opts && opts.toolLog); if (co && (!co.ok || co.checkedOutlook)) return co;
      if (/(主推|组合|冲量|规划|策略|保留|砍掉|清谁|推谁|留哪|资源)/.test(q)) return { ok: true, skipped: '策略/规划题不做单一名次核对' };   // 「谁冲量、谁清库存」不是「DOS 谁最高」
    }
    const intent = intentOf(q);
    if (!intent) return { ok: true, skipped: '非单选题或意图不明' };
    let rk = pickRanking(intent, opts && opts.toolLog);
    if (!rk) return { ok: true, skipped: '本轮没有对应指标的排名工具结果' };
    let items = rk.items;
    /* 问题本身点了 ≥2 个排名对象（「A 和 B 哪个卖得更好」）→ 只在这几个之间裁，不拿全体第一名去压 */
    const inQ = firstNamedAll(q, items.map(x => x.name).filter(Boolean));
    if (inQ.length >= 2) items = items.filter(x => inQ.indexOf(x.name) >= 0);
    if (!items.length) return { ok: true, skipped: '排名里没有问题点名的对象' };
    rk = Object.assign({}, rk, { items: items });
    const names = items.map(x => x.name).filter(Boolean);
    const head = headOf(a);
    const named = firstNamed(head, names);
    const top = items[0];
    if (!named) {
      /* v8 #24：问「收入最高的产品」，经营分析专家答了一篇产品线综述，开头 220 字一个产品都没点——
         代码明明算好了第 1 名。有排名在手而结论不点名，同样算不合格：让它改，改不动就把排名钉在最前面。 */
      const show0 = items.slice(0, 3).map((x, i) => (i + 1) + '. ' + x.name + '（' + x.value + '）').join('　');
      const line0 = '【系统核对】结论句没有点名回答对象。按代码计算的「' + rk.label + '」' + (rk.order === 'asc' ? '升序' : '降序') + '排名：' + show0 + '。结论应以第 1 名 ' + top.name + ' 为准。';
      return { ok: false, kind: 'name', named: null, expected: top.name, source: rk.source, label: rk.label, order: rk.order, top3: items.slice(0, 3), line: line0 };
    }
    const topVal = top.value;
    const tied = items.filter(x => x.value === topVal).map(x => x.name);   // 并列第一都算对
    const show = items.slice(0, 3).map((x, i) => (i + 1) + '. ' + x.name + '（' + x.value + '）').join('　');
    if (tied.indexOf(named) >= 0) {
      /* 名次对了，再看数字：代码口径的第 1 名数值必须出现在正文里。v7 #6 模型点对了「音频」，
         却拿财经收入增速 112% 和自己按整月切的 SO 同比 68% 作答——代码算好的 81.6% 一次没引用。 */
      if (!valueShown(a, top.value)) {
        const line = '【系统核对】结论对象无误（' + top.name + '），但正文没有引用代码口径的「' + rk.label + '」数值：' + show + '。以上是代码按口径算出的数字，请以此为准；模型另按其它口径自算的增速/同比不能替代。';
        return { ok: false, kind: 'value', named, expected: top.name, source: rk.source, label: rk.label, order: rk.order, top3: items.slice(0, 3), line };
      }
      return { ok: true, named, expected: top.name, source: rk.source };
    }
    const line = '【系统核对】按代码计算的「' + rk.label + '」' + (rk.order === 'asc' ? '升序' : '降序') + '排名：' + show + '。结论应以第 1 名 ' + top.name + ' 为准；上文点名的 ' + named + ' 不是第 1 名。';
    return { ok: false, kind: 'name', named, expected: top.name, source: rk.source, label: rk.label, order: rk.order, top3: items.slice(0, 3), line };
  }

  return { check, intentOf, dimOf, healthIntent, estimateIntent, pickEstimateRoles, checkEstimate, outlookIntent, outlookParams, checkOutlook, assignNames, countryNamed, firstNamed, firstNamedAll, pickRanking, headOf, valueShown, INTENTS, LABELS, HEALTH_INTENTS, ESTIMATE_RE, OUTLOOK_RE };
});

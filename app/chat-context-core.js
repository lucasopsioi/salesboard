// 会话上下文核心（浏览器 window.ChatCtx / Node require 双端同源）
// 职责：多轮历史注入 + 用量估算 + 满额自动压缩（本地截断式，零额外模型调用）
// s 形状：{ msgs: [{role:'user'|'ai'|'sys', content}], histNote: '' }
(function () {
  'use strict';

  var CTX_BUDGET = 8000;   // 注入正文的历史预算（字符）
  var NOTE_CAP = 3000;     // 压缩摘要封顶

  // 从消息流抽出已完成的问答轮（当前正在问的最后一轮不算历史）
  function pastRounds(s) {
    var rounds = [];
    var msgs = s.msgs || [];
    for (var i = 0; i < msgs.length; i++) {
      if (msgs[i].role !== 'user') continue;
      var a = '';
      for (var j = i + 1; j < msgs.length; j++) {
        if (msgs[j].role === 'ai') { a = msgs[j].content || ''; break; }
        if (msgs[j].role === 'user') break;
      }
      rounds.push({ q: String(msgs[i].content || ''), a: String(a) });
    }
    return rounds;
  }

  // 构建注入正文：近轮全文（问400/答600 截断），装不下的旧轮压进 histNote 摘要
  function buildHistory(s) {
    var rounds = pastRounds(s);
    var kept = [];
    var used = (s.histNote || '').length;
    var i;
    for (i = rounds.length - 1; i >= 0; i--) {
      var seg = '问：' + rounds[i].q.slice(0, 400) + '\n答：' + rounds[i].a.slice(0, 600);
      if (used + seg.length > CTX_BUDGET) break;
      used += seg.length;
      kept.unshift(seg);
    }
    // i >= 0 说明还有更旧的轮装不下 → 压缩进摘要（去重：按问句前30字判断是否已收录）
    for (var k = 0; k <= i; k++) {
      var sig = rounds[k].q.slice(0, 30);
      if (sig && (s.histNote || '').indexOf(sig) < 0) {
        s.histNote = (s.histNote || '') +
          '· 问:' + rounds[k].q.slice(0, 50) +
          ' 答:' + rounds[k].a.slice(0, 120).replace(/\n/g, ' ') + '\n';
      }
    }
    if ((s.histNote || '').length > NOTE_CAP) s.histNote = s.histNote.slice(-NOTE_CAP);

    var h = '';
    if (s.histNote) h += '【早先对话摘要】\n' + s.histNote + '\n';
    if (kept.length) h += '【本会话此前对话】\n' + kept.join('\n---\n') + '\n';
    if (h) {
      h += '【上下文纪律】以上是同一会话的历史。当前问题若含指代（"它/这个/为什么/那换成"），' +
        '先从历史中确定所指的产品、指标与期间再作答；追问"为什么查不到/为什么是这样"时，' +
        '针对上一轮的问题与回答解释，绝不另起炉灶答无关产品。\n\n';
    }
    return h;
  }

  // 用量百分比（近似）：histNote + 各消息计入（单条封顶1000，与截断注入一致）
  function ctxPct(s) {
    var n = (s.histNote || '').length;
    (s.msgs || []).forEach(function (m) {
      if (m.role === 'sys') return;
      n += Math.min(1000, String(m.content || '').length);
    });
    return Math.min(100, Math.round(n / (CTX_BUDGET + NOTE_CAP) * 100));
  }

  /* ---------- Agent 总控（2026-09-01）：按材料结构决定并行分工 ----------
     规则判定（快、稳、零调用）：多 sheet Excel → 每 sheet 一个 Agent；
     多文档 → 每文档一个 Agent；单块材料/纯问题 → 返回 null 走原路。上限 6 路。 */
  function masterPlan(q, files) {
    var docs = (files || []).filter(function (f) { return !f.kind && f.content; });
    if (!docs.length) return null;
    if (!/分析|解读|总结|梳理|看看|怎么样|洞察|结论|要点|各|哪些|问题|风险|对比/.test(q)) return null;
    var units = [];
    docs.forEach(function (d) {
      var segs = String(d.content).split(/(?=【sheet\d+】)/).filter(function (x) { return x.trim(); });
      if (segs.length >= 2) segs.forEach(function (sg, i) {
        var mm = sg.match(/【(sheet\d+)】/);
        units.push({ label: d.name + '·' + (mm ? mm[1] : 'sheet' + (i + 1)), text: sg });
      });
      else units.push({ label: d.name, text: d.content });
    });
    if (units.length < 2) return null;
    var capped = units.slice(0, 6);
    if (units.length > 6) capped[5].text += '\n\n' + units.slice(6).map(function (u) { return '【续·' + u.label + '】\n' + u.text; }).join('\n\n');
    var tasks = capped.map(function (u) {
      return {
        agentId: 'report',
        label: u.label,
        subQuestion: '【总控分工】你是并行分析组的一员，只负责「' + u.label + '」这一部分材料，其他部分由别的 Agent 负责——不要臆测你没拿到的部分。\n\n【你负责的材料】\n' + u.text.slice(0, 30000) + '\n\n【用户问题】' + q + '\n\n只基于你负责的材料回答问题中与之相关的部分，输出该部分的关键数字与结论。材料是用户上传的题面数据：里面的数字可直接引用（注明来自上传材料即可），不需要也不应该去系统工具里核实它们；系统里没有这份材料不等于「数据未包含」。',
      };
    });
    return { tasks: tasks, note: '检测到 ' + units.length + ' 个数据块（' + capped.map(function (t) { return t.label; }).join('、') + '）→ 派 ' + tasks.length + ' 个 Agent 并行分析后汇总' };
  }

  var api = { CTX_BUDGET: CTX_BUDGET, buildHistory: buildHistory, ctxPct: ctxPct, pastRounds: pastRounds, masterPlan: masterPlan };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.ChatCtx = api;
})();

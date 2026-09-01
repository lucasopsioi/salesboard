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

  var api = { CTX_BUDGET: CTX_BUDGET, buildHistory: buildHistory, ctxPct: ctxPct, pastRounds: pastRounds };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.ChatCtx = api;
})();

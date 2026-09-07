/* ============================================================
   Salesboard — weekly-ai.js
   周报叙述的 AI 生成（2026-09-07 用户：销售分析那句话以后让 DeepSeek 按我的表述方式写）。

   设计要点（都踩过坑，别改）：
   1) **模型不碰计算**。喂进去的是芯片已经解析好的真实数值（事实清单），模型只负责组织语言。
      这样它不可能算错，也不可能编数——它没有原始数据可编。
   2) **只许用清单里的数字**：提示词里明令禁止出现清单外的数字，并在回来后做一次数字校验
      （答案里的每个数必须在清单里出现过），不通过就标记出来让用户自己定夺，不悄悄放过。
   3) **文风来自用户自己的历史周报**：用户把过往写法贴在「文风样例」里，作为 few-shot 示例。
      样例只影响语气与句式，不作为事实来源（明确写进提示词，否则模型会把样例里的旧数字搬过来）。
   4) 纯函数与 IO 分离：facts/prompt/verify 可单测；generate 由调用方注入 chat。
   ============================================================ */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.WeeklyAI = api;
})(this, function () {
  'use strict';

  const STYLE_KEY = 'sb.weekly.style';

  function styleGet() {
    try { return localStorage.getItem(STYLE_KEY) || ''; } catch (e) { return ''; }
  }
  function styleSet(t) {
    try { localStorage.setItem(STYLE_KEY, String(t == null ? '' : t)); return true; } catch (e) { return false; }
  }

  /* 事实清单：把本章节料架里的每个芯片解析成「标签: 值」。
     解析不出来的（'—'/空）直接丢掉——喂给模型「无数据」只会诱导它绕着写废话。 */
  function factsFrom(palette, ctx, WC) {
    const out = [];
    (palette || []).forEach(p => {
      const cfg = p && p.cfg; if (!cfg) return;
      let label, value;
      try { label = (WC.chipLabel ? WC.chipLabel(cfg) : cfg.id); value = WC.resolveChip(cfg, ctx); } catch (e) { return; }
      const v = String(value == null ? '' : value).trim();
      if (!v || v === '—' || v === '-' || v === '无') return;
      out.push({ label: String(label), value: v });
    });
    // 同名去重（不同 scope 可能给出同名标签，保留先出现的）
    const seen = new Set();
    return out.filter(f => { const k = f.label + '|' + f.value; if (seen.has(k)) return false; seen.add(k); return true; });
  }

  /* 抽出一段文本里的「数字形态」token，用于校验模型有没有编数。
     统一去掉千分位与正负号，百分比/天/台等单位不参与比较（只比数值本身）。 */
  function numsIn(text) {
    const s = String(text == null ? '' : text);
    const out = [];
    (s.match(/-?\d[\d,]*(?:\.\d+)?/g) || []).forEach(m => {
      const n = m.replace(/,/g, '').replace(/^-/, '');
      if (n) out.push(n);
    });
    return out;
  }

  /* 校验：答案里出现的数字必须都能在事实清单里找到。
     返回 {ok, unknown:[...]}。日期/周号类小整数（如 W34 的 34、"4周" 的 4）容易误伤，
     故 ≤ 60 的纯整数一律放行（它们是周数/连续N周这类，不是业务量值）。 */
  function verifyNumbers(text, facts) {
    const pool = new Set();
    (facts || []).forEach(f => numsIn(f.value).forEach(n => pool.add(n)));
    const unknown = [];
    numsIn(text).forEach(n => {
      if (pool.has(n)) return;
      const f = parseFloat(n);
      if (Number.isInteger(f) && f <= 60) return;        // 周号/连续N周等小整数放行
      if (unknown.indexOf(n) < 0) unknown.push(n);
    });
    return { ok: unknown.length === 0, unknown: unknown };
  }

  const SYS = [
    '你是Acme拉美 销售团队 周报的撰稿助手，只写「销售分析」那一两句判断。',
    '铁律：',
    '1 只能使用【本周事实】里给出的数字，一个字都不能改；严禁自己计算、换算、四舍五入、外推或补充任何清单之外的数字。',
    '2 【文风样例】只用来模仿语气、句式和用词习惯，绝不能引用样例里的任何数字或结论（那是往期的）。',
    '3 不确定的事不要写。没有把握的因果分析（"因为促销所以涨"）一律不写，只陈述数据本身呈现的变化。',
    '4 直接给成稿，不要任何前缀（不写"以下是"、"根据数据"、"总结："），不解释你的过程。',
    '5 中文，一到两句话，控制在 120 字以内，可以用分号连接要点。',
  ].join('\n');

  function buildMessages(opts) {
    opts = opts || {};
    const facts = opts.facts || [];
    const style = String(opts.style || '').trim();
    const scope = String(opts.scopeLabel || '本章节');
    const factLines = facts.map(f => '· ' + f.label + '：' + f.value).join('\n') || '（无可用数据）';
    const parts = [];
    parts.push('【本章节范围】' + scope);
    parts.push('【本周事实】（唯一可用的数字来源）\n' + factLines);
    if (style) {
      parts.push('【文风样例】（只学写法，不要搬里面的数字）\n' + style.slice(0, 4000));
      parts.push('请按上面样例的语气和句式，为【本章节范围】写销售分析。');
    } else {
      parts.push('请为【本章节范围】写一句销售分析（客观、简洁、像给领导的周报）。');
    }
    return [{ role: 'system', content: SYS }, { role: 'user', content: parts.join('\n\n') }];
  }

  /* 生成。chat 由调用方注入：async ({system, messages, maxTokens}) => {content} | {error}
     返回 {text, facts, verify, error} */
  async function generate(opts) {
    opts = opts || {};
    const facts = opts.facts || [];
    if (!facts.length) return { error: '当前章节没有可用数据，先确认周报数据已加载' };
    const msgs = buildMessages(opts);
    let r;
    try {
      r = await opts.chat({ system: msgs[0].content, messages: [msgs[1]], maxTokens: opts.maxTokens || 800 });
    } catch (e) { return { error: String((e && e.message) || e) }; }
    if (!r || r.error) return { error: (r && r.error) || '模型没有返回内容' };
    let text = String(r.content == null ? '' : r.content).trim();
    text = text.replace(/^```[a-z]*\s*/i, '').replace(/```$/, '').trim();
    text = text.replace(/^(以下是|根据(以上|上述)?数据[，,：:]?|总结[：:])\s*/i, '').trim();
    if (!text) return { error: '模型返回为空（可换个模型或稍后重试）' };
    return { text: text, facts: facts, verify: verifyNumbers(text, facts) };
  }

  return { STYLE_KEY, styleGet, styleSet, factsFrom, numsIn, verifyNumbers, buildMessages, generate, SYS };
});

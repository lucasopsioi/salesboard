/* ============================================================
   Salesboard — ppt-ai-edit.js
   PPT Output：选中元素 → 对话让模型改 → 校验补丁 → 应用 → 画布实时刷新。
   （2026-09-07 用户：点PPT里某个元素，说一句就能改，实时预览、实时看到进展）

   设计要点（都为了「模型改不坏东西」）：
   1) **模型只能返回结构化补丁**（JSON ops），不返回自由文本，也不直接触碰文档对象。
   2) **白名单 + 夹取**：只有列出的字段能改；坐标/尺寸夹在页面内，字号/透明度夹在合理区间，
      颜色必须是 6 位十六进制。越界不是报错，是**夹到边界并记一条 rejected**，用户看得见。
   3) **绝不允许改 id / type / binding**。binding 是数据绑定，一旦被模型改写，
      刷新数据时就会填错格子——这是本项目最贵的一类错（数字看着对、口径已经变了）。
   4) 只改「模型点名的元素」，且这些元素必须真实存在于当前页；凭空造 id 一律丢弃。
   纯函数，Node/浏览器双端可测。
   ============================================================ */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.PptAiEdit = api;
})(this, function () {
  'use strict';

  // 允许模型修改的顶层字段与样式字段（其余一律丢弃）
  const TOP = ['x', 'y', 'w', 'h', 'text'];   // align 归样式（element.style.align），不要两边都列，否则两条分支都不命中
  const STYLE = ['fontSize', 'bold', 'italic', 'underline', 'color', 'fill', 'line', 'opacity', 'fontFace', 'align', 'valign'];
  const FORBIDDEN = ['id', 'type', 'binding', 'bind', 'groupId', 'z'];
  const HEX = /^[0-9A-Fa-f]{6}$/;
  const num = v => (typeof v === 'number' && isFinite(v)) ? v : (typeof v === 'string' && v.trim() !== '' && isFinite(+v) ? +v : null);
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  /* 给模型看的元素摘要：只暴露它能改的东西 + 必要的定位信息。
     binding 只以「有/无」的形式出现，提示模型别碰，但不给细节。 */
  function describeElement(el) {
    if (!el) return null;
    const s = el.style || {};
    const o = { id: el.id, type: el.type, x: r2(el.x), y: r2(el.y), w: r2(el.w), h: r2(el.h) };
    if (el.text != null) o.text = String(el.text).slice(0, 300);
    ['fontSize', 'bold', 'italic', 'color', 'fill', 'fontFace', 'align', 'valign', 'opacity'].forEach(k => { if (s[k] != null && s[k] !== '') o[k] = s[k]; });
    if (el.binding) o.hasDataBinding = true;
    return o;
  }
  const r2 = v => { const n = num(v); return n == null ? null : Math.round(n * 100) / 100; };

  function describeSlide(slide) {
    const els = (slide && slide.elements) || [];
    return els.map(describeElement).filter(Boolean);
  }

  const SYS = [
    '你是 PPT 版式助手。用户会选中一个（或一页）元素并用中文说要改成什么，你只输出修改指令。',
    '',
    '输出格式（必须是纯 JSON，不要任何解释、不要 markdown 围栏）：',
    '{"ops":[{"id":"元素id","set":{"字段":值}}],"note":"一句话说明改了什么"}',
    '',
    '可改字段：',
    '· 位置尺寸 x,y,w,h —— 单位英寸，相对页面左上角',
    '· 文字 text —— 元素的文字内容',
    '· 样式 fontSize(磅) bold italic underline color fill line fontFace align(left/center/right) valign(top/middle/bottom) opacity(0~1)',
    '· 颜色一律 6 位十六进制、不带 #，例如 C7000B',
    '',
    '铁律：',
    '1 id 必须来自我给你的元素清单，不许编造；不在清单里的一律不要出现。',
    '2 绝对不许修改 id、type、binding（数据绑定）——改了会导致刷新数据时填错格子。',
    '3 只改用户要求的部分，没提到的字段不要写进 set。',
    '4 用户描述模糊时按最小改动理解，不要顺手美化其它元素。',
    '5 只输出 JSON，第一个字符必须是 {。',
  ].join('\n');

  function buildMessages(opts) {
    opts = opts || {};
    const page = opts.page || { w: 13.333, h: 7.5 };
    const parts = [];
    parts.push('【页面尺寸】宽 ' + page.w + ' 英寸 × 高 ' + page.h + ' 英寸');
    if (opts.element) {
      parts.push('【用户选中的元素】\n' + JSON.stringify(opts.element));
      const others = (opts.slideElements || []).filter(e => e && e.id !== opts.element.id);
      if (others.length) parts.push('【同页其它元素（供参考对齐，非必要不要改）】\n' + JSON.stringify(others.slice(0, 20)));
    } else {
      parts.push('【当前页全部元素】\n' + JSON.stringify((opts.slideElements || []).slice(0, 30)));
    }
    parts.push('【用户要求】' + String(opts.instruction || '').slice(0, 500));
    return [{ role: 'system', content: SYS }, { role: 'user', content: parts.join('\n\n') }];
  }

  /* 从模型输出里取 JSON（容忍 ```json 围栏与前后废话） */
  function parsePatch(text) {
    let s = String(text == null ? '' : text).trim();
    s = s.replace(/^```[a-z]*\s*/i, '').replace(/```\s*$/, '').trim();
    const i = s.indexOf('{'), j = s.lastIndexOf('}');
    if (i < 0 || j <= i) return null;
    try { return JSON.parse(s.slice(i, j + 1)); } catch (e) { return null; }
  }

  /* 校验 + 夹取。返回 {ops:[{id,set}], rejected:[理由...]}，ops 已可安全应用。 */
  function sanitize(patch, slide, page) {
    const rejected = [];
    const out = [];
    const els = (slide && slide.elements) || [];
    const byId = {}; els.forEach(e => { byId[e.id] = e; });
    const P = page || { w: 13.333, h: 7.5 };
    const ops = (patch && Array.isArray(patch.ops)) ? patch.ops : [];
    if (!ops.length) return { ops: [], rejected: ['模型没有给出任何修改指令'], note: (patch && patch.note) || '' };
    ops.forEach(op => {
      const id = op && op.id;
      const el = id && byId[id];
      if (!el) { rejected.push('丢弃：元素 ' + JSON.stringify(id) + ' 不在当前页'); return; }
      const src = (op && (op.set || op.props)) || {};
      const set = {}; const style = {};
      Object.keys(src).forEach(k => {
        if (FORBIDDEN.indexOf(k) >= 0) { rejected.push('拒绝修改受保护字段 ' + k + '（会破坏数据绑定/结构）'); return; }
        const v = src[k];
        if (k === 'style' && v && typeof v === 'object') {
          Object.keys(v).forEach(sk => { const r = styleVal(sk, v[sk], rejected); if (r !== undefined) style[sk] = r; });
          return;
        }
        if (STYLE.indexOf(k) >= 0) { const r = styleVal(k, v, rejected); if (r !== undefined) style[k] = r; return; }
        if (TOP.indexOf(k) < 0) { rejected.push('忽略不支持的字段 ' + k); return; }
        if (k === 'text') { set.text = String(v == null ? '' : v).slice(0, 2000); return; }
        const n = num(v);
        if (n == null) { rejected.push('忽略 ' + k + '：不是数字'); return; }
        if (k === 'w') set.w = clamp(n, 0.1, P.w);
        else if (k === 'h') set.h = clamp(n, 0.1, P.h);
        else if (k === 'x') set.x = clamp(n, -P.w, P.w);
        else if (k === 'y') set.y = clamp(n, -P.h, P.h);
        if (set[k] != null && Math.abs(set[k] - n) > 1e-9) rejected.push(k + ' 超出页面范围，已夹到 ' + set[k]);
      });
      // 夹完位置后保证元素至少有一部分在页内
      if (set.x != null && set.x >= P.w) { set.x = P.w - 0.2; rejected.push('x 会把元素推出页面，已回拉'); }
      if (set.y != null && set.y >= P.h) { set.y = P.h - 0.2; rejected.push('y 会把元素推出页面，已回拉'); }
      if (Object.keys(style).length) set.style = Object.assign({}, el.style || {}, style);
      if (!Object.keys(set).length) { rejected.push('元素 ' + id + '：没有可应用的有效改动'); return; }
      out.push({ id: id, set: set });
    });
    return { ops: out, rejected: rejected, note: (patch && patch.note) || '' };
  }

  function styleVal(k, v, rejected) {
    if (STYLE.indexOf(k) < 0) { rejected.push('忽略不支持的样式 ' + k); return undefined; }
    if (k === 'color' || k === 'fill' || k === 'line') {
      const s = String(v == null ? '' : v).replace(/^#/, '').toUpperCase();
      if (!HEX.test(s)) { rejected.push('忽略 ' + k + '：颜色要 6 位十六进制（如 C7000B），收到 ' + JSON.stringify(v)); return undefined; }
      return s;
    }
    if (k === 'bold' || k === 'italic' || k === 'underline') return !!v;
    if (k === 'fontSize') { const n = num(v); if (n == null) { rejected.push('忽略 fontSize：不是数字'); return undefined; } return clamp(Math.round(n), 6, 96); }
    if (k === 'opacity') { const n = num(v); if (n == null) { rejected.push('忽略 opacity：不是数字'); return undefined; } return clamp(n, 0, 1); }
    if (k === 'align') { const s = String(v || '').toLowerCase(); return ['left', 'center', 'right'].indexOf(s) >= 0 ? s : (rejected.push('忽略 align：只能 left/center/right'), undefined); }
    if (k === 'valign') { const s = String(v || '').toLowerCase(); return ['top', 'middle', 'bottom'].indexOf(s) >= 0 ? s : (rejected.push('忽略 valign：只能 top/middle/bottom'), undefined); }
    if (k === 'fontFace') { const s = String(v || '').slice(0, 40); return s || undefined; }
    return undefined;
  }

  /* 全链：文本 → 补丁 → 校验。UI 拿到后自己 updateElement + 重渲。 */
  function planFrom(text, slide, page) {
    const p = parsePatch(text);
    if (!p) return { ops: [], rejected: ['模型没有返回可解析的 JSON（可重试或换个说法）'], note: '' };
    return sanitize(p, slide, page);
  }

  return { SYS, TOP, STYLE, FORBIDDEN, describeElement, describeSlide, buildMessages, parsePatch, sanitize, planFrom };
});

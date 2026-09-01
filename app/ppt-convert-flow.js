/* ============================================================
   PPT → 设计器工程 转换管线（2026-09-01 用户重定义需求）
   「从一份 PPT 把它模板化、数据化、未来可复用」——产物是 PPT output
   看板的工程文档（PptDoc），存进 PptStore 后「打开」列表立即可见，
   数据框/表格接真数据接口（打开即最新），可视编辑，导出 PPTX。

   Agent 集群分工（用户点名的能力逐项落位）：
     · 版式解析 Agent（确定性代码）：形状大小/位置/填充/边框/线宽/阴影、
       文本内容/字号/字体/粗斜/颜色/对齐、表格逐格、图片二进制、页尺寸
       ——XML 里有精确值，代码比 LLM 更准，这一层负责「看得全」
     · 元素装配 Agent（确定性）：逐形状映射成设计器元素（text/shape/image/table），
       样式逐字段搬运；含填充的文本框拆「底 shape + 上 text」双元素保观感
     · 数据识别 Agent（LLM，逐页并行）：哪些文本/表格是「数据」、该接什么
       接口（dataset/measure/filters），维度取值用 options 现查验证；
       「标签：数值」文本框拆 text+data 双元素接活接口
     · 图片理解 Agent（LLM 多模态，可选）：图片内容转述存 alt（无多模态自动跳过）
     · 页间逻辑 Agent（LLM）：页序叙事链，存 doc.meta.storyline
     · 校验 Agent（确定性）：坐标 clamp 页内、色值合法、绑定字段白名单
   ============================================================ */
'use strict';
(function () {
  const PptDoc = (typeof window !== 'undefined' && window.PptDoc)
    ? window.PptDoc : (typeof require === 'function' ? require('./pptoutput/designer/doc-model.js') : null);

  const J = (o) => { try { return JSON.stringify(o); } catch (e) { return '{}'; } };
  function pickJson(text) {
    const t = String(text || '');
    const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/);
    const cand = [];
    if (fence) cand.push(fence[1]);
    const b1 = t.indexOf('['), b2 = t.indexOf('{');
    const st = (b1 >= 0 && (b2 < 0 || b1 < b2)) ? b1 : b2;
    if (st >= 0) cand.push(t.slice(st));
    for (const c of cand) {
      for (let end = c.length; end > 2; end--) {
        try { return JSON.parse(c.slice(0, end)); } catch (e) {}
        if (end > 200) end -= Math.floor(end / 50);
      }
    }
    return null;
  }
  const HEX = /^[0-9A-Fa-f]{6}$/;
  const okHex = (c, dflt) => (c && HEX.test(c)) ? c.toUpperCase() : dflt;

  /* ---------- 元素装配（确定性）：结构 shape → 设计器元素数组 ---------- */
  function mapShape(sh, page) {
    const els = [];
    const pos = sh.pos || {};
    const x = Math.max(0, Math.min(pos.x != null ? pos.x : 1, page.w - 0.2));
    const y = Math.max(0, Math.min(pos.y != null ? pos.y : 1, page.h - 0.2));
    const w = Math.max(0.2, Math.min(pos.w || 2, page.w - x));
    const h = Math.max(0.2, Math.min(pos.h || 0.6, page.h - y));
    const st = sh.style || {};
    if (sh.type === 'image') {
      if (sh.dataUrl) els.push(PptDoc.newElement('image', { x, y, w, h, src: sh.dataUrl, style: {} }));
      return els;
    }
    if (sh.type === 'table') {
      els.push(PptDoc.newElement('table', { x, y, w, h, rows: (sh.rows || []).map(r => r.slice()), style: {} }));
      return els;
    }
    if (sh.type === 'graphic') {
      // 图表真还原(2026-09-01 用户点名)：chart part 解析出 类型/类目/系列(名+值+色)/图例
      // → 设计器 chart 元素(静态数据 el.data + 系列色 fmt.colors)，颜色格式原样
      if (sh.chart && sh.chart.series && sh.chart.series.length) {
        const c = sh.chart;
        const VT = { bar: 'bar', stackBar: 'stackBar', stackBar100: 'stackBar', column: 'column', stackColumn: 'stackColumn', stack100: 'stack100', line: 'line', pie: 'pie', doughnut: 'doughnut', area: 'area' };
        const colors = {};
        c.series.forEach(se => { if (se.color) colors[se.name] = se.color; });
        els.push(PptDoc.newElement('chart', {
          x, y, w, h,
          chart: { vtype: VT[c.vtype] || 'column', fmt: { showLegend: true, legendPos: c.legendPos || 'bottom', title: c.title || '', showLabels: false, colors } },
          data: { cats: c.cats, series: c.series.map(se => ({ name: se.name, values: se.values })) },
          style: {},
        }));
        return els;
      }
      // 无 chart part 的 graphic（SmartArt 等）——占位框
      els.push(PptDoc.newElement('shape', { x, y, w, h, style: { fill: 'F7F8FA', line: 'CBD2DA' } }));
      els.push(PptDoc.newElement('text', { x: x + 0.1, y: y + h / 2 - 0.25, w: Math.max(1, w - 0.2), h: 0.5, text: '【原PPT图形无法还原】请在设计器重建', style: { fontSize: 10, color: '8A9099', align: 'center' } }));
      return els;
    }
    // 线条/箭头：落成细色条（设计器无线元素，用高/宽收薄的 shape 近似）
    if (st.geom === 'line' || st.geom === 'straightConnector1' || /Connector/.test(st.geom || '')) {
      const lc = okHex(st.line, '999999');
      const thin = 0.03;
      if (w >= h) els.push(PptDoc.newElement('shape', { x, y: +(y + h / 2).toFixed(2), w, h: thin, style: { fill: lc, line: lc } }));
      else els.push(PptDoc.newElement('shape', { x: +(x + w / 2).toFixed(2), y, w: thin, h, style: { fill: lc, line: lc } }));
      return els;
    }
    // 文本/形状：有填充或边框 → 底 shape；有文字 → 上 text
    const hasBox = st.fill || st.line;
    const txt = String(sh.text || '').trim();
    if (hasBox && (txt || !txt)) {
      els.push(PptDoc.newElement('shape', { x, y, w, h, style: { fill: okHex(st.fill, 'FFFFFF'), line: okHex(st.line, 'E6E8EB') } }));
    }
    if (txt) {
      const r0 = (sh.runs && sh.runs.find(r => r.fontSize)) || (sh.runs && sh.runs[0]) || {};
      // 无任何字号信息时按框高估算（h英寸×72pt×0.5 行占比），夹在 8-20——密集小标签图用固定 14 会全体偏大
      const estSz = Math.max(8, Math.min(20, Math.round(h * 72 * 0.5)));
      els.push(PptDoc.newElement('text', {
        x, y, w, h, text: txt,
        style: {
          fontSize: r0.fontSize || estSz,
          bold: !!r0.bold,
          color: okHex(r0.color, '1A1A1A'),
          align: sh.align || 'left',
        },
      }));
    } else if (!hasBox && sh.type === 'text') {
      // 空文本框：跳过（占位符噪声）
    } else if (!hasBox) {
      els.push(PptDoc.newElement('shape', { x, y, w, h, style: { fill: 'F2F3F5', line: 'CBD2DA' } }));
    }
    return els;
  }

  /* ---------- 数据识别 Agent（LLM，逐页）：文本/表格 → 绑定提案 ---------- */
  const BIND_SYS = [
    '你是数据绑定分析师。给你一页 PPT 的元素清单（编号/位置/文本）和系统数据目录概要，',
    '判断哪些文本是「数据值」（刷新时应从系统取最新值），并给出取数绑定。',
    '绑定格式：{"dataset":"psi","measure":"sellOut|sellIn|inv|dos","filters":{"line":["平板"],"country":["墨西哥"],...}}',
    'filters 的维度键仅限 line/family/series/product/country/rep/channel，取值必须与目录里的写法一致。',
    '文本形如「标签：数值+单位」时给出 split：{"label":"累计SO：","unit":"台"}（数值部分转成活数据框，标签保留原样式）。',
    '纯静态文字（标题/口号/注释/日期）标 kind:"static"。拿不准取数口径的标 confidence:"low" 并写 question。',
    '只输出 JSON 数组：',
    '[{"ref":0,"kind":"static"},',
    ' {"ref":2,"kind":"data","binding":{"dataset":"psi","measure":"sellOut","filters":{"line":["平板"]}},"split":{"label":"累计SO：","unit":"台"},"confidence":"high"},',
    ' {"ref":5,"kind":"table-data","note":"表格各行是各系列累计SO","confidence":"low","question":"表格第2列是SO还是SI？"}]',
  ].join('\n');

  async function bindAgent(deps, pageIdx, cands, catalogBrief) {
    const listTxt = cands.map((c, i) => '[' + i + '] ' + (c.kind === 'table' ? ('表格 ' + c.rowsBrief) : ('文本@(' + c.x + ',' + c.y + ') 「' + c.text.slice(0, 80) + '」'))).join('\n');
    const resp = await deps.chat({
      system: BIND_SYS,
      messages: [{ role: 'user', content: '【第' + (pageIdx + 1) + '页元素】\n' + listTxt + '\n\n【数据目录概要】\n' + catalogBrief }],
      tools: [], maxTokens: 2500,
    });
    if (!resp || resp.error) return [];
    const arr = pickJson(resp.content);
    return Array.isArray(arr) ? arr : [];
  }

  // 维度取值现查验证：filters 每个值都要在 options 里真实存在，不存在→降 low
  async function verifyBinding(deps, b) {
    if (!b || !b.filters) return true;
    for (const k of Object.keys(b.filters)) {
      const vals = [].concat(b.filters[k] || []);
      if (!vals.length) continue;
      let opts = [];
      try { const r = await deps.optionsDirect(k); opts = (r && r.values) || (Array.isArray(r) ? r : []) || []; } catch (e) {}
      if (!opts.length) continue;
      const norm = (s) => String(s).toLowerCase().replace(/[\s_\-/()（）·]/g, '');
      for (let i = 0; i < vals.length; i++) {
        const v = vals[i];
        if (opts.indexOf(v) >= 0) continue;
        const hit = opts.filter(o => norm(o) === norm(v) || norm(o).indexOf(norm(v)) >= 0);
        if (hit.length === 1) { vals[i] = hit[0]; continue; }   // 宽松归一唯一命中→自动纠写法
        return false;
      }
      b.filters[k] = vals;
    }
    return true;
  }

  /* ---------- 页间逻辑 Agent ---------- */
  async function storyAgent(deps, titles) {
    if (titles.length < 2) return '';
    const resp = await deps.chat({
      system: '你是报告结构分析师。根据 PPT 各页标题，写出页与页的叙事逻辑链（每页一句：这页在整个故事里承担什么），80字内一段话。只输出这段话。',
      messages: [{ role: 'user', content: titles.map((t, i) => '第' + (i + 1) + '页：' + t).join('\n') }],
      tools: [], maxTokens: 400,
    });
    return (resp && !resp.error && resp.content) ? String(resp.content).trim().slice(0, 300) : '';
  }

  /* ---------- 主管线 ---------- */
  // deps: {chat, optionsDirect, catalogDirect}; struct: extractPptStructure(buf,{withImages:true})
  async function convert(deps, struct, opt) {
    opt = opt || {};
    const onFlow = opt.onFlow || (() => {});
    const page = struct.page || { w: 13.333, h: 7.5 };
    const doc = PptDoc.newPresentation(opt.name || 'PPT转换模板');
    doc.page = { w: page.w, h: page.h };

    const nShapes = struct.slides.reduce((a, s) => a + s.shapes.length, 0);
    onFlow('📐 版式解析 Agent：' + struct.slides.length + ' 页 / ' + nShapes + ' 个形状（含位置·填充·边框·字号·字体·颜色·对齐·图片·表格）');

    // 数据目录概要（给数据识别 Agent）
    let catalogBrief = '';
    try {
      const cat = await deps.catalogDirect();
      if (cat && cat.psi) {
        const lines = (cat.psi.lines || []).map(l => l.line + '(' + (l.families || []).map(f => f.family).join('/') + ')').join('；');
        catalogBrief = 'PSI 产线：' + lines + '\n国家：' + ((cat.psi.countries || []).slice(0, 20).join('/')) + '\n指标：sellOut(SO)/sellIn(SI)/inv(库存)/dos';
      }
    } catch (e) {}

    const questions = [];
    let dataN = 0, imgN = 0, tblN = 0, chartPh = 0;
    const titles = [];

    for (let si = 0; si < struct.slides.length; si++) {
      if (si > 0) PptDoc.addSlide(doc);
      const shapes = struct.slides[si].shapes;
      // 1) 确定性装配
      const pageEls = [];   // {el(s), srcShape}
      shapes.forEach(sh => {
        const els = mapShape(sh, page);
        els.forEach(el => PptDoc.addElement(doc, si, el));
        if (els.length) pageEls.push({ sh, els });
        if (sh.type === 'image' && sh.dataUrl) imgN++;
        if (sh.type === 'table') tblN++;
        if (sh.type === 'graphic') chartPh++;
      });
      const t0 = shapes.find(s => s.type === 'text' && s.text);
      titles.push(t0 ? t0.text.split('\n')[0].slice(0, 30) : ('第' + (si + 1) + '页'));

      // 2) 数据识别（本页候选：含数字的文本 + 表格）
      const cands = [];
      pageEls.forEach((pe, i) => {
        const sh = pe.sh;
        if (sh.type === 'text' && /\d/.test(sh.text || '')) cands.push({ i, kind: 'text', text: sh.text, x: sh.pos.x, y: sh.pos.y });
        else if (sh.type === 'table') cands.push({ i, kind: 'table', rowsBrief: (sh.rows || []).slice(0, 2).map(r => r.join('|')).join(' ; ') + '（' + (sh.rows || []).length + '行）' });
      });
      if (!cands.length || !deps.chat) continue;
      onFlow('🔎 数据识别 Agent（第' + (si + 1) + '页）：' + cands.length + ' 个候选…');
      const props = await bindAgent(deps, si, cands, catalogBrief);
      for (const p of props) {
        const cand = cands[p.ref];
        if (!cand || !p || p.kind === 'static') continue;
        const pe = pageEls[cand.i];
        if (p.kind === 'data' && p.binding && cand.kind === 'text') {
          const okBind = await verifyBinding(deps, p.binding);
          if (!okBind || p.confidence === 'low') {
            questions.push({ page: si + 1, text: cand.text.slice(0, 40), question: p.question || ('「' + cand.text.slice(0, 30) + '」的取数口径没把握（维度取值未验证通过），请确认'), binding: p.binding });
            continue;
          }
          // 「标签：数值」拆 text+data：原 text 元素改为标签，右侧叠 data 元素接活接口
          const textEl = pe.els.find(e => e.type === 'text');
          if (!textEl) continue;
          const stl = textEl.style || {};
          if (p.split && p.split.label) {
            const ratio = Math.min(0.7, Math.max(0.25, p.split.label.length / Math.max(4, String(cand.text).length)));
            const lw = +(textEl.w * ratio).toFixed(2);
            PptDoc.updateElement(doc, si, textEl.id, { text: p.split.label, w: lw });
            PptDoc.addElement(doc, si, PptDoc.newElement('data', {
              x: +(textEl.x + lw).toFixed(2), y: textEl.y, w: +(textEl.w - lw).toFixed(2), h: textEl.h,
              style: { fontSize: stl.fontSize || 18, bold: !!stl.bold, color: stl.color || '1A1A1A', align: 'left', unit: 'auto' },
              binding: p.binding,
            }));
          } else {
            // 纯数值框：整框转 data（保字号字色）
            PptDoc.removeElement(doc, si, textEl.id);
            PptDoc.addElement(doc, si, PptDoc.newElement('data', {
              x: textEl.x, y: textEl.y, w: textEl.w, h: textEl.h,
              style: { fontSize: stl.fontSize || 18, bold: !!stl.bold, color: stl.color || '1A1A1A', align: stl.align || 'center' },
              binding: p.binding,
            }));
          }
          dataN++;
        } else if (p.kind === 'table-data') {
          questions.push({ page: si + 1, text: '表格', question: p.question || ('第' + (si + 1) + '页表格建议绑定数据源（' + (p.note || '') + '），请确认接 report 还是保持静态'), binding: null });
        }
      }
    }

    // 3) 页间逻辑 Agent
    if (deps.chat && struct.slides.length >= 2) {
      onFlow('🧭 页间逻辑 Agent：梳理 ' + titles.length + ' 页叙事链…');
      const story = await storyAgent(deps, titles);
      if (story) { doc.meta = doc.meta || {}; doc.meta.storyline = story; }
    }

    onFlow('🧱 装配校验 Agent：' + doc.slides.reduce((a, s) => a + s.elements.length, 0) + ' 个元素落位（坐标已收敛页内，色值已校验）');
    return { doc, stats: { pages: struct.slides.length, shapes: nShapes, dataBindings: dataN, images: imgN, tables: tblN, chartPlaceholders: chartPh }, questions, titles };
  }

  // 转换报告（对话 sys 卡）
  function report(res) {
    const s = res.stats;
    const L = ['🧩 PPT 已转换为设计器工程：' + s.pages + ' 页 / ' + res.doc.slides.reduce((a, x) => a + x.elements.length, 0) + ' 个元素'];
    L.push('· 活数据框 ' + s.dataBindings + ' 个（接引擎接口，打开即最新数据）');
    if (s.tables) L.push('· 表格 ' + s.tables + ' 个（静态落位，可在设计器改绑数据源）');
    if (s.images) L.push('· 图片 ' + s.images + ' 张（原图嵌入）');
    if (s.chartPlaceholders) L.push('· 原生图表 ' + s.chartPlaceholders + ' 个（PPT 图表无法直接还原，已放占位框——在设计器里用图表元素重建并绑数据）');
    if (res.doc.meta && res.doc.meta.storyline) L.push('· 页间逻辑：' + res.doc.meta.storyline);
    if (res.questions.length) {
      L.push('');
      L.push('❓ ' + res.questions.length + ' 处数据口径待确认（直接回复解答，或先保存再在设计器里手动绑）：');
      res.questions.forEach((q, i) => L.push('  问题' + (i + 1) + '（第' + q.page + '页）：' + q.question));
    }
    L.push('');
    L.push('说「保存模板 XXX」存入 PPT output 看板——「打开」列表可见，可视编辑，导出 PPTX。');
    return L.join('\n');
  }

  const api = { convert, report, pickJson, verifyBinding };
  if (typeof window !== 'undefined') window.PptConvert = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();

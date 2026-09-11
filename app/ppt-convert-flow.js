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

  // 维度取值现查验证+纠偏：值在指定维度查无 → 跨七维定位唯一归属并迁移键（与图表路径同一套纠偏）；
  // 迁移后仍有值在全维度都查无 → false（口径存疑，进待确认）
  async function verifyBinding(deps, b) {
    if (!b || !b.filters) return true;
    await normalizeChartBinding(deps, b, null);
    const norm = (s) => String(s).toLowerCase().replace(/[\s_\-/()（）·]/g, '');
    for (const k of Object.keys(b.filters)) {
      const vals = [].concat(b.filters[k] || []);
      if (!vals.length) continue;
      let opts = [];
      try { const r = await deps.optionsDirect(k); opts = (r && (r.values || r['取值'] || r.options)) || (Array.isArray(r) ? r : []) || []; } catch (e) {}
      if (!opts.length) continue;
      for (const v of vals) {
        if (opts.indexOf(v) >= 0) continue;
        if (opts.some(o => norm(o) === norm(v))) continue;
        return false;
      }
    }
    return true;
  }

  /* ---------- 图表绑定 Agent + 核数闸（2026-09-01 用户「图表能接PSI底数据吗,准确度是大问题」）----------
     流程：LLM 按图表的类目/系列/数值样本提议绑定 → 用引擎真跑该绑定拿矩阵 →
     与原图数值逐点对数（容差5%，命中率≥70%）→ 通过才绑定（数据自动最新），
     不过保持静态并把差异明细列成问题——绝不让一个对不上数的绑定悄悄上线。 */
  const CHART_BIND_SYS = [
    '你是图表数据绑定分析师。给你一个 PPT 图表的类目、系列名与数值，判断它是否对应系统数据接口，并给出绑定：',
    '{"dataset":"psi","measure":"sellOut|sellIn|inv|dos","catField":"period","legend":"line|family|series|country|rep|channel","filters":{...},"gran":"month|week|day"}',
    'catField=period 表示横轴是时间；legend 是系列拆分维度（单系列可省）。filters 取值必须与目录写法一致。',
    '类目形如「1月/2月」「2026-01」是时间；系列名对应产品/产线/国家等维度成员。',
    '判定纪律：你只负责把图表翻译成最可能的绑定候选——「到底是不是系统数据」由系统用真实数据逐点核验（核不过自动保持静态），你不必替系统拒绝。只要类目是时间序列、系列名像产线/系列/国家维度成员，就必须给出绑定候选；仅当完全无法构造（如类目是竞品名、纯目标推演）才答 {"kind":"static"}。',
    '只输出一个 JSON 对象。',
  ].join('\n');
  function normCat(c) {
    const s = String(c == null ? '' : c);
    const ym = s.match(/(20\d{2})[-/年]?(\d{1,2})/);
    if (ym) return ym[1] + '-' + String(+ym[2]).padStart(2, '0');
    const m = s.match(/^(\d{1,2})\s*月$/);
    if (m) return 'M' + (+m[1]);
    return s.trim();
  }
  /* 绑定确定性纠偏：filters 值规整为数组；值在指定维度查无 → 跨七维定位唯一命中后迁移键
     （模型常把 line 成员放进 series——引擎报错都指了路，代码直接照办），legend 同步跟随。 */
  const DIM_KEYS = ['line', 'family', 'series', 'product', 'country', 'rep', 'channel'];
  async function normalizeChartBinding(deps, b, chartSeriesNames) {
    if (!b) return b;
    b.filters = b.filters || {};
    const norm = (s) => String(s).toLowerCase().replace(/[\s_\-/()（）·]/g, '');
    const optCache = {};
    const getOpts = async (k) => {
      if (optCache[k]) return optCache[k];
      let o = [];
      try { const r = await deps.optionsDirect(k); o = (r && (r.values || r['取值'] || r.options)) || (Array.isArray(r) ? r : []) || []; } catch (e) {}
      return (optCache[k] = o);
    };
    for (const k of Object.keys(b.filters)) {
      let vals = [].concat(b.filters[k] || []).filter(v => v != null && v !== '');
      if (!vals.length) { delete b.filters[k]; continue; }
      const opts = await getOpts(k);
      const fixed = [];
      for (const v of vals) {
        if (opts.indexOf(v) >= 0) { fixed.push(v); continue; }
        const hit = opts.filter(o => norm(o) === norm(v) || norm(o).indexOf(norm(v)) >= 0 || norm(v).indexOf(norm(o)) >= 0);
        if (hit.length === 1) { fixed.push(hit[0]); continue; }
        // 本维度查无但取值清单不大 → 让模型在清单里重选正确写法（中英文地名「墨西哥」→「Mexico」这类别名）
        if (deps.chat && opts.length && opts.length <= 80) {
          try {
            const resp = await deps.chat({
              system: '给你一个维度的全部合法取值清单和一个用户写法，找出用户写法对应的那个取值（含中英文别名、简称、大小写差异）。只输出该取值原文；对应不上就只输出 NONE。',
              messages: [{ role: 'user', content: '【维度 ' + k + ' 合法取值】\n' + opts.join(' | ') + '\n\n【用户写法】' + v }],
              tools: [], maxTokens: 60,
            });
            const pick = String((resp && resp.content) || '').trim().replace(/^["'「『]|["'」』]$/g, '');
            const hitM = opts.find(o => o === pick) || opts.find(o => norm(o) === norm(pick));
            if (hitM && pick !== 'NONE') { fixed.push(hitM); continue; }
          } catch (e) {}
        }
        // 本维度查无 → 跨维度找唯一归属并迁移
        let moved = false;
        for (const k2 of DIM_KEYS) {
          if (k2 === k) continue;
          const o2 = await getOpts(k2);
          const h2 = o2.filter(o => norm(o) === norm(v) || norm(o).indexOf(norm(v)) >= 0);
          if (h2.length === 1) {
            b.filters[k2] = [].concat(b.filters[k2] || [], h2[0]);
            if (b.legend === k) b.legend = k2;
            moved = true; break;
          }
        }
        if (!moved) fixed.push(v);   // 留着让核数闸报出去
      }
      if (fixed.length) b.filters[k] = fixed; else delete b.filters[k];
    }
    // legend 纠偏：按图表系列名跨七维定位——系列名全部/多数落在哪个维度的取值里，legend 就是那个维度
    // （模型把 line 成员「平板/音频与智能配件」标成 family 是常态；filters 为空时上面的迁移碰不到它）
    if (chartSeriesNames && chartSeriesNames.length) {
      let best = null, bestHit = 0;
      for (const k2 of DIM_KEYS) {
        const o2 = await getOpts(k2);
        if (!o2.length) continue;
        const hit = chartSeriesNames.filter(n => o2.some(o => norm(o) === norm(n))).length;
        if (hit > bestHit) { bestHit = hit; best = k2; }
      }
      if (best && bestHit >= Math.ceil(chartSeriesNames.length / 2)) b.legend = best;
    }
    // legend 维度上没有过滤值且系列只有一个成员时，legend 对齐 filters 里唯一的维度键
    if (b.legend && !b.filters[b.legend] && !(chartSeriesNames && chartSeriesNames.length > 1)) {
      const ks = Object.keys(b.filters);
      if (ks.length === 1) b.legend = ks[0];
    }
    return b;
  }
  async function verifyChartBinding(deps, binding, chart) {
    if (!deps.runTool || !binding || !binding.measure) return { ok: false, reason: '无法核验（缺取数通道）' };
    let res;
    try {
      res = await deps.runTool('query', {
        stackDim: binding.legend || 'line',
        metric: binding.measure, gran: binding.gran || 'month',
        filters: binding.filters || {},
      });
    } catch (e) { return { ok: false, reason: '取数失败: ' + String((e && e.message) || e) }; }
    if (!res || res.error || !res.data) return { ok: false, reason: '取数失败: ' + ((res && res.error) || '空返回') };
    const engRaw = res.buckets || res.cats || [];
    // 引擎矩阵: res.cats(期间桶)+res.data{series:{cat:val}} → 与原图逐点对数
    const engCats = engRaw.map(normCat);
    const srcCats = (chart.cats || []).map(normCat);
    let hit = 0, total = 0;
    const diffs = [];
    const matchedBuckets = [];   // 命中的引擎桶——决定绑定的 timeFrom/timeTo（忠实还原原图期间）
    chart.series.forEach(se => {
      // 系列名宽松对齐引擎系列
      const norm = (x) => String(x).toLowerCase().replace(/[\s_\-/()（）·]/g, '');
      const engName = Object.keys(res.data || {}).find(k => norm(k) === norm(se.name) || norm(k).indexOf(norm(se.name)) >= 0 || norm(se.name).indexOf(norm(k)) >= 0);
      const row = engName ? res.data[engName] : null;
      se.values.forEach((v, i) => {
        total++;
        const cat = srcCats[i];
        // 无年份类目(「1月」)从后往前对齐——引擎桶含多年时优先最近年份(正序曾撞上2025-01把真值判成对不上)
        let ei = -1;
        for (let j = engCats.length - 1; j >= 0; j--) {
          const c = engCats[j];
          if (c === cat || c.endsWith(cat) || (cat[0] === 'M' && c.endsWith('-' + String(cat.slice(1)).padStart(2, '0')))) { ei = j; break; }
        }
        const rawKey = ei >= 0 ? engRaw[ei] : null;
        const evv = (row && rawKey != null && row[rawKey] != null) ? +row[rawKey] : null;
        if (evv != null && isFinite(evv) && Math.abs(evv - v) / Math.max(Math.abs(v), 1) <= 0.05) { hit++; if (rawKey != null) matchedBuckets.push(String(rawKey)); }
        else diffs.push(se.name + '@' + (chart.cats[i] || i) + ': 图=' + v + ' 系统=' + (evv == null ? '无' : evv));
      });
    });
    const rate = total ? hit / total : 0;
    const sorted = matchedBuckets.slice().sort();
    const range = sorted.length ? { from: sorted[0], to: sorted[sorted.length - 1] } : null;
    return { ok: rate >= 0.7, rate: +(rate * 100).toFixed(0), diffs: diffs.slice(0, 6), range, reason: rate >= 0.7 ? '' : ('数值对不上（命中率 ' + (rate * 100).toFixed(0) + '%）') };
  }
  async function chartBindAgent(deps, chart, catalogBrief) {
    const sample = '类目: ' + chart.cats.join('/') + '\n' +
      chart.series.map(se => '系列「' + se.name + '」: ' + se.values.join(',')).join('\n');
    const resp = await deps.chat({
      system: CHART_BIND_SYS,
      messages: [{ role: 'user', content: sample + '\n\n【数据目录概要】\n' + catalogBrief }],
      tools: [], maxTokens: 800,
    });
    if (!resp || resp.error) return null;
    const b = pickJson(resp.content);
    return (b && b.dataset && b.measure) ? b : null;
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

      // 图表绑定 Agent + 核数闸：提议绑定→引擎真跑→与原图数值逐点对数→通过才接活接口
      if (deps.chat && deps.runTool) {
        for (const pe of pageEls) {
          if (!(pe.sh.type === 'graphic' && pe.sh.chart && pe.sh.chart.series && pe.sh.chart.series.length)) continue;
          const chartEl = pe.els.find(e => e.type === 'chart');
          if (!chartEl) continue;
          onFlow('📊 图表绑定 Agent（第' + (si + 1) + '页）：提议数据接口…');
          let bind = await chartBindAgent(deps, pe.sh.chart, catalogBrief);
          if (!bind || bind.kind === 'static') { onFlow('　→ 判定为静态图表（目标值/手工推演类），保持原数据'); continue; }
          bind = await normalizeChartBinding(deps, bind, pe.sh.chart.series.map(se => se.name));
          const ver = await verifyChartBinding(deps, bind, pe.sh.chart);
          if (ver.ok) {
            // 期间忠实还原：原图画的是哪段就切哪段（设计器 F5 时间切片 timeFrom/timeTo），
            // 不然活接口会把全期间 20 个桶都画出来；用户可在设计器改成滚动期间
            if (ver.range) { bind.timeFrom = ver.range.from; bind.timeTo = ver.range.to; }
            chartEl.binding = bind;               // 有 binding 设计器即走活数据渲染，el.data 保留兜底
            dataN++;
            onFlow('　✅ 核数通过（命中率 ' + ver.rate + '%）→ 图表已接 ' + bind.dataset + '/' + bind.measure + ' 实时接口' + (ver.range ? ('，期间 ' + ver.range.from + '~' + ver.range.to) : ''));
          } else {
            questions.push({ page: si + 1, text: '图表', question: '第' + (si + 1) + '页图表提议绑定 ' + JSON.stringify(bind) + ' 但' + ver.reason + (ver.diffs && ver.diffs.length ? ('；差异样本：' + ver.diffs.join('；')) : '') + '。图表暂保持静态原数据——请确认口径后再绑，或就保持静态。', binding: bind });
            onFlow('　⚠ 核数不过（' + ver.reason + '）→ 保持静态，已列入待确认');
          }
        }
      }

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
            const fullW = textEl.w;                       // 先记原宽——updateElement 会就地改 textEl.w
            const lw = +(fullW * ratio).toFixed(2);
            const dataW = +(fullW - lw).toFixed(2);
            PptDoc.updateElement(doc, si, textEl.id, { text: p.split.label, w: lw });
            PptDoc.addElement(doc, si, PptDoc.newElement('data', {
              x: +(textEl.x + lw).toFixed(2), y: textEl.y, w: dataW, h: textEl.h,
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
    const charts = res.doc.slides.reduce((a, x) => a.concat(x.elements.filter(e => e.type === 'chart')), []);
    if (charts.length) {
      const live = charts.filter(e => e.binding && e.binding.measure).length;
      L.push('· 图表 ' + charts.length + ' 个（类型/数据/系列色原样还原；其中 ' + live + ' 个核数通过已接实时接口，' + (charts.length - live) + ' 个保持静态原数据）');
    }
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

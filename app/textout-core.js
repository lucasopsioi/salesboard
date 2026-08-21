/* ============================================================
   Salesboard — textout-core.js
   「文字输出」看板（周报文字生成器）纯函数层。无 DOM / 无 api 依赖，
   全部可 node 直接单测（textout-core.test.js）。职责：
     ① 数字格式化（自动/k/万W/M/千分位 · 小数位0-3 · 后缀 · 带符号 · 无数据'-'）
     ② 同比/环比格式化（±% / ±pp / ±绝对 · 每芯片独立小数位）
     ③ 相对时间→绝对区间（昨日/本周至今/本月至今/年至今/最近N天/自定义，跨年正确）
     ④ 对比期派生（yoy 去年同期 / mom 上一等长区间 / custom 两期）
     ⑤ 矩阵({cats,series})区间聚合（sum/avg/last/max/min/dayavg，无桶→null 显'-'）
     ⑥ 文档模型 {v,blocks:[{t:'text',s}|{t:'chip',cfg}]} 序列化往返
     ⑦ 芯片 cfg → binding-resolver 取数参数映射
   与 pptoutput 的 numfmt/binding-resolver 语义对齐，但独立实现（本看板 UI 需求：
   lowercase k、无数据'-'、日均、相对时间滚动），四个基建文件只引用不改。
   ============================================================ */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.TextoutCore = api;
})(this, function () {
  'use strict';

  /* ---------- 日期工具（本地日历口径；跨月/跨年由 Date 自动进位） ---------- */
  function pad2(n){ return String(n).padStart(2, '0'); }
  function fmtDate(d){ return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }
  function parseDate(s){
    const p = String(s || '').split('-');
    if (p.length < 3) return null;
    const y = +p[0], m = +p[1], day = +p[2];
    if (!y || !m || !day) return null;
    return new Date(y, m - 1, day);
  }
  function addDays(d, n){ const x = new Date(d.getFullYear(), d.getMonth(), d.getDate()); x.setDate(x.getDate() + n); return x; }
  // 周一为一周起点：周一至今 offset（getDay 0=周日..6=周六 → 周一=0）
  function mondayOffset(d){ return (d.getDay() + 6) % 7; }
  // 含首尾的自然天数（from~to 同日=1）。非日期字符串 → null。
  function daySpan(from, to){
    const a = parseDate(from), b = parseDate(to);
    if (!a || !b) return null;
    return Math.floor((b - a) / 86400000) + 1;
  }

  /* ---------- ③ 相对时间 → 绝对区间 ----------
     cfg.mode: yesterday 昨日 / wtd 本周至今 / mtd 本月至今 / ytd 年至今 /
               lastN 最近N天(cfg.n) / custom 自定义(cfg.from,cfg.to)。
     now 缺省取当前时刻。返回 {from,to} 均为 'YYYY-MM-DD'，均含首尾。 */
  function resolveTime(cfg, now){
    cfg = cfg || {};
    const today = now ? new Date(now.getFullYear(), now.getMonth(), now.getDate()) : (function () { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), d.getDate()); })();
    const mode = cfg.mode || 'wtd';
    let from, to;
    if (mode === 'custom') {
      from = cfg.from || null; to = cfg.to || null;
      return { from: from, to: to, gran: cfg.gran || 'day' };
    }
    if (mode === 'yesterday') {
      const y = addDays(today, -1); from = to = y;
    } else if (mode === 'wtd') {
      from = addDays(today, -mondayOffset(today)); to = today;
    } else if (mode === 'mtd') {
      from = new Date(today.getFullYear(), today.getMonth(), 1); to = today;
    } else if (mode === 'ytd') {
      from = new Date(today.getFullYear(), 0, 1); to = today;
    } else if (mode === 'lastN') {
      const n = Math.max(1, cfg.n || 7); from = addDays(today, -(n - 1)); to = today;
    } else {
      from = to = today;
    }
    return { from: fmtDate(from), to: fmtDate(to), gran: cfg.gran || 'day' };
  }

  /* ---------- ④ 对比期派生 ----------
     preset: yoy 去年同期（两端各减一年）/ mom 上一等长区间（紧邻基期之前）/
             custom 自定义两期（cfg.cmpTime 独立解析）。
     返回 { base:{from,to}, cmp:{from,to} }。 */
  function shiftYears(dateStr, dy){
    const d = parseDate(dateStr); if (!d) return dateStr;
    return fmtDate(new Date(d.getFullYear() + dy, d.getMonth(), d.getDate()));
  }
  function comparePeriod(cfg, now, lastDay){
    cfg = cfg || {};
    const preset = cfg.preset || 'yoy';
    const base = resolveTime(cfg.time, now);
    if (preset === 'custom') {
      return { base: base, cmp: resolveTime(cfg.cmpTime || {}, now) };
    }
    /* 同期截断（对齐 PSI query / 产业 industryTrend / 汇总 report 的 maxKey/maxMd 锚定口径）：
       lastDay=数据最新日('YYYY-MM-DD')。基期尾部越过数据最新日时，先把基期截到数据最新日，
       再派生对比期 —— yoy 的去年同期、mom 的上一等长区间都随截短后的基期推，
       避免"今年只有半段数据、去年却按整段区间求和"导致分母偏大、同比偏低。
       基期整段都在数据最新日之前 → 不截，行为不变。custom 两期是用户显式指定，不动。 */
    if (lastDay && /^\d{4}-\d{2}-\d{2}$/.test(lastDay) && base.from && base.to &&
        base.from <= lastDay && base.to > lastDay) {
      base.to = lastDay;
    }
    if (preset === 'mom') {
      // 上一等长区间：cmp.to = base.from 前一天；长度与 base 相同。
      const len = daySpan(base.from, base.to);
      const bFrom = parseDate(base.from);
      if (!bFrom || !len) return { base: base, cmp: { from: null, to: null } };
      const cmpTo = addDays(bFrom, -1);
      const cmpFrom = addDays(cmpTo, -(len - 1));
      return { base: base, cmp: { from: fmtDate(cmpFrom), to: fmtDate(cmpTo) } };
    }
    // yoy：同一日历日期，年份 -1
    return { base: base, cmp: { from: shiftYears(base.from, -1), to: shiftYears(base.to, -1) } };
  }

  /* ---------- ⑤ 矩阵区间聚合 ----------
     matrix = { cats:[桶标签], series:[{name,values:[]}] }（binding-resolver.resolveMatrix 产物）。
     取 [from,to] 内各桶跨系列求和 → 按 aggType 归并。桶标签与 from/to 同为可字典序比较
     的字符串（日='YYYY-MM-DD'）。无匹配桶 → null（上层显 '-'，区分「无数据」与「值为0」）。
     dayavg=区间求和 ÷ 自然天数（日均，样例口径）。 */
  function aggMatrix(matrix, from, to, aggType){
    const cats = (matrix && matrix.cats) || [];
    const series = (matrix && matrix.series) || [];
    const buckets = [];
    for (let i = 0; i < cats.length; i++) {
      const c = cats[i];
      if ((from == null || c >= from) && (to == null || c <= to)) {
        let sum = 0;
        for (let s = 0; s < series.length; s++) sum += (+(series[s].values || [])[i] || 0);
        buckets.push(sum);
      }
    }
    if (!buckets.length) return null;
    const total = buckets.reduce((a, b) => a + b, 0);
    switch (aggType) {
      case 'last': return buckets[buckets.length - 1];
      case 'avg': return total / buckets.length;
      case 'max': return Math.max.apply(null, buckets);
      case 'min': return Math.min.apply(null, buckets);
      case 'dayavg': { const ds = daySpan(from, to); return total / Math.max(1, ds || buckets.length); }
      case 'sum':
      default: return total;
    }
  }

  /* ---------- ① 数字格式化 ----------
     opts:{ unit, decimals(0-3), suffix }。unit ∈ auto/none/k/W/M。
     null/NaN → '-'（无数据）。带千分位（整数部分）。 */
  const UNIT = { none: [1, ''], k: [1e3, 'k'], w: [1e4, 'W'], W: [1e4, 'W'], m: [1e6, 'M'], M: [1e6, 'M'] };
  function group(intStr){ return intStr.replace(/\B(?=(\d{3})+(?!\d))/g, ','); }
  function fixedGrouped(n, d){
    const s = n.toFixed(d), parts = s.split('.'), neg = parts[0].charAt(0) === '-';
    const gi = group(neg ? parts[0].slice(1) : parts[0]);
    return (neg ? '-' : '') + gi + (parts[1] ? '.' + parts[1] : '');
  }
  function autoUnit(v){ const a = Math.abs(v); if (a >= 1e6) return 'M'; if (a >= 1e4) return 'W'; if (a >= 1e3) return 'k'; return 'none'; }
  function clampDec(d){ return Math.max(0, Math.min(3, d == null ? 1 : d)); }
  function formatNum(value, opts){
    opts = opts || {};
    if (value == null || isNaN(value)) return '-';
    const d = clampDec(opts.decimals);
    let unit = opts.unit || 'auto';
    if (unit === 'auto') unit = autoUnit(value);
    const sc = UNIT[unit] || UNIT.none;
    const body = fixedGrouped(value / sc[0], d) + sc[1];
    return opts.suffix ? (body + opts.suffix) : body;
  }

  /* ---------- ② 同比/环比格式化 ----------
     current=当前区间值，reference=对比区间值。
     fmt: pct 同比±%（默认）/ pp 百分点差±pp（率类，输入视为比率）/ abs 绝对差±（带单位缩写）。
     任一为 null，或 pct 且 reference==0 → '-'。带符号（+4.96%）。 */
  function formatCompare(current, reference, opts){
    opts = opts || {};
    const fmt = opts.fmt || 'pct';
    const d = clampDec(opts.decimals == null ? 2 : opts.decimals);
    if (current == null || reference == null || isNaN(current) || isNaN(reference)) return '-';
    let out;
    if (fmt === 'abs') {
      const diff = current - reference;
      const sign = diff >= 0 ? '+' : '-';
      out = sign + formatNum(Math.abs(diff), { unit: opts.unit || 'auto', decimals: opts.decimals == null ? 1 : opts.decimals });
    } else if (fmt === 'pp') {
      const p = (current - reference) * 100;
      out = (p >= 0 ? '+' : '') + p.toFixed(d) + 'pp';
    } else {
      if (reference === 0) return '-';
      const p = ((current - reference) / reference) * 100;
      out = (p >= 0 ? '+' : '') + p.toFixed(d) + '%';
    }
    return opts.suffix ? (out + opts.suffix) : out;
  }

  /* ---------- ⑦ 芯片 cfg → resolveMatrix 取数参数 ----------
     供 view 构造 PptBind.resolveMatrix / resolveIdcMatrix 入参；时间不写进 syn
     （拉全量桶后由 aggMatrix 在 base/cmp 两段各自切片，一次取数两处复用）。 */
  function chipToMatrixParams(cfg){
    cfg = cfg || {};
    const ds = cfg.dataset || 'psi';
    const measure = cfg.measure || (ds === 'idc' ? 'units' : 'sellOut');
    const isFlow = measure === 'sellOut' || measure === 'sellIn' || measure === 'units' || measure === 'value';
    return {
      dataset: ds,
      measure: measure,
      agg: cfg.agg && cfg.agg !== 'dayavg' ? (cfg.agg === 'avg' ? 'avg' : cfg.agg) : (isFlow ? 'sum' : 'last'),
      catField: ds === 'idc' ? (cfg.catField || 'quarter') : 'period',
      catGran: cfg.gran || 'day',
      filters: cfg.filters || {}
    };
  }
  // 聚合类型（喂给 aggMatrix）：sum/avg/last/max/min/dayavg。'日均'→dayavg。
  function aggType(cfg){ return (cfg && cfg.agg) || 'sum'; }

  /* ---------- ⑥ 文档模型序列化往返 ----------
     v2(排版版) doc = { v:2, blocks:[ {t:'line', a?:'r'|'c', runs:[run]} ] }
       run = {t:'text', s, st?:{b?:1, fs?:px, c?:'#rrggbb'}} | {t:'chip', cfg}
       a: 行对齐(缺省=左); st: 文字内联样式(b加粗/fs字号px/c颜色)。
     v1(旧) blocks 为扁平 {t:'text',s}|{t:'chip',cfg}，deserialize 自动迁移成 v2
     （按 \n 切行），旧模板/旧存档零破坏。serialize 恒输出 v2。 */
  const DOC_VER = 2;
  function emptyDoc(){ return { v: DOC_VER, blocks: [] }; }
  function normSt(st){
    if (!st || typeof st !== 'object') return undefined;
    const o = {};
    if (st.b) o.b = 1;
    const fs = Math.round(+st.fs); if (fs >= 8 && fs <= 72) o.fs = fs;
    if (typeof st.c === 'string' && /^#[0-9a-fA-F]{6}$/.test(st.c)) o.c = st.c.toLowerCase();
    return Object.keys(o).length ? o : undefined;
  }
  function normRuns(runs){
    const out = [];
    (runs || []).forEach(r => {
      if (!r || typeof r !== 'object') return;
      if (r.t === 'chip') out.push({ t: 'chip', cfg: r.cfg || {} });
      else if (r.t === 'text') {
        const s = String(r.s == null ? '' : r.s); if (s === '') return;
        const st = normSt(r.st);
        const last = out[out.length - 1];
        if (last && last.t === 'text' && JSON.stringify(last.st) === JSON.stringify(st)) last.s += s;
        else out.push(st ? { t: 'text', s: s, st: st } : { t: 'text', s: s });
      }
    });
    return out;
  }
  function normLines(blocks){
    const out = [];
    (blocks || []).forEach(b => {
      if (!b || typeof b !== 'object' || b.t !== 'line') return;
      const L = { t: 'line', runs: normRuns(b.runs) };
      if (b.a === 'r' || b.a === 'c') L.a = b.a;
      out.push(L);
    });
    return out;
  }
  // v1 扁平块 → v2 行（按 \n 切行；chip 落入当前行）。
  function linesFromFlat(blocks){
    const lines = [ { t: 'line', runs: [] } ];
    (blocks || []).forEach(b => {
      if (!b || typeof b !== 'object') return;
      if (b.t === 'chip') lines[lines.length - 1].runs.push({ t: 'chip', cfg: b.cfg || {} });
      else if (b.t === 'text') {
        const parts = String(b.s == null ? '' : b.s).split('\n');
        parts.forEach((p, i) => {
          if (i > 0) lines.push({ t: 'line', runs: [] });
          if (p) lines[lines.length - 1].runs.push({ t: 'text', s: p });
        });
      }
    });
    return normLines(lines);
  }
  function serialize(doc){
    const d = doc || emptyDoc();
    const blocks = (d.blocks && d.blocks.length && d.blocks[0] && d.blocks[0].t === 'line')
      ? normLines(d.blocks) : linesFromFlat(d.blocks);
    return JSON.stringify({ v: DOC_VER, blocks: blocks });
  }
  function deserialize(str){
    if (str == null) return emptyDoc();
    let o;
    try { o = (typeof str === 'string') ? JSON.parse(str) : str; } catch (e) { return emptyDoc(); }
    if (!o || typeof o !== 'object' || !Array.isArray(o.blocks)) return emptyDoc();
    const isV2 = o.blocks.length && o.blocks[0] && o.blocks[0].t === 'line';
    return { v: DOC_VER, blocks: isV2 ? normLines(o.blocks) : linesFromFlat(o.blocks) };
  }
  // blocks + 已解析值 map（idx→已格式化字符串）→ 纯文本（输出区/复制用）。兼容 v1 扁平与 v2 行。
  function renderText(blocks, resolved){
    resolved = resolved || {};
    let chip = 0, out = '';
    const runText = (r) => {
      if (r.t === 'text') return (r.s == null ? '' : r.s);
      if (r.t === 'chip') { const v = resolved[chip]; chip++; return (v == null ? '-' : v); }
      return '';
    };
    (blocks || []).forEach((b, bi) => {
      if (!b || typeof b !== 'object') return;
      if (b.t === 'line') { if (bi > 0) out += '\n'; (b.runs || []).forEach(r => out += runText(r)); }
      else out += runText(b);
    });
    return out;
  }

  /* ---------- ⑧ 自动序号（行首 "1. / 1、/ 1)" 回车续号） ---------- */
  const NUM_RE = /^(\s*)(\d+)([.、).．])(\s*)/;
  // 行文本 → {n:序号, sep:分隔符, sp:号后空白} 或 null
  function numPrefixInfo(lineText){
    const m = NUM_RE.exec(String(lineText == null ? '' : lineText));
    return m ? { pre: m[1], n: +m[2], sep: m[3], sp: m[4] } : null;
  }
  // 回车后新行应自动填充的前缀（保持原分隔风格；"、"后默认无空格,其余默认一个空格）
  function nextNumPrefix(lineText){
    const i = numPrefixInfo(lineText); if (!i) return null;
    const sp = i.sp !== '' ? i.sp : (i.sep === '、' ? '' : ' ');
    return i.pre + (i.n + 1) + i.sep + sp;
  }
  // 只剩序号没内容的空项（回车应退出序号模式）
  function isEmptyNumLine(lineText){
    const i = numPrefixInfo(lineText); if (!i) return false;
    return String(lineText).replace(NUM_RE, '').trim() === '';
  }

  /* ---------- ⑨ 环比快捷口径（芯片级）：日/周/月环比 = mom + 基期时间模式 ---------- */
  const MOM_QUICK = { day: { mode: 'yesterday' }, week: { mode: 'wtd' }, month: { mode: 'mtd' } };
  function momQuickTime(kind){ const t = MOM_QUICK[kind]; return t ? { mode: t.mode } : null; }
  // 对比芯片的口径名（同比/日环比/周环比/月环比/环比(自定义基期)/两期对比）
  function compareKindLabel(cfg){
    cfg = cfg || {};
    if (cfg.preset === 'custom') return '两期对比';
    if (cfg.preset === 'mom') {
      const m = (cfg.time && cfg.time.mode) || '';
      if (m === 'yesterday') return '日环比';
      if (m === 'wtd') return '周环比';
      if (m === 'mtd') return '月环比';
      return '环比';
    }
    return '同比';
  }
  // 芯片在料架/编辑区里的短标签（未解析时的占位显示）。
  const MEASURE_LABEL = { sellOut: 'SO', sellIn: 'SI', inv: '库存', dos: 'DOS', units: '销量', value: '金额', asp: '均价',
    rev: '收入', gm: '销毛', gmr: '销毛率', cp: '贡献利润', nsip: 'NSIP' };
  const TIME_LABEL = { yesterday: '昨日', wtd: '本周至今', mtd: '本月至今', ytd: '年至今', lastN: '最近N天', custom: '自定义' };
  function chipLabel(cfg){
    cfg = cfg || {};
    if (cfg.kind === 'compare') {
      const p = compareKindLabel(cfg);
      return (MEASURE_LABEL[cfg.measure] || cfg.measure || '值') + ' ' + p;
    }
    const t = cfg.time || {};
    const tl = t.mode === 'lastN' ? ('最近' + (t.n || 7) + '天') : (TIME_LABEL[t.mode] || '');
    return (MEASURE_LABEL[cfg.measure] || cfg.measure || '值') + (tl ? ' · ' + tl : '');
  }

  return {
    // 日期/区间
    fmtDate: fmtDate, parseDate: parseDate, addDays: addDays, daySpan: daySpan,
    resolveTime: resolveTime, comparePeriod: comparePeriod,
    // 聚合
    aggMatrix: aggMatrix,
    // 格式化
    formatNum: formatNum, formatCompare: formatCompare,
    // 映射
    chipToMatrixParams: chipToMatrixParams, aggType: aggType,
    // 文档模型
    emptyDoc: emptyDoc, serialize: serialize, deserialize: deserialize,
    renderText: renderText, chipLabel: chipLabel, normSt: normSt, linesFromFlat: linesFromFlat,
    // 序号 / 环比快捷
    numPrefixInfo: numPrefixInfo, nextNumPrefix: nextNumPrefix, isEmptyNumLine: isEmptyNumLine,
    momQuickTime: momQuickTime, compareKindLabel: compareKindLabel,
    MEASURE_LABEL: MEASURE_LABEL, TIME_LABEL: TIME_LABEL
  };
});

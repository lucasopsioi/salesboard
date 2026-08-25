/* ============================================================
   Salesboard — ai-context.js
   MiniMax AI 问答的数据提供层。三块内容：
     1) 看板 provider 注册表 + 通用兜底 provider（尽量能取则取，取不到跳过）。
     2) 全局只读工具集（走现有 IPC/window 数据，零新算逻辑）。
     3) 回退协议解析（AI 只输出 {"tool":名,"args":{}} 时本地解析→分发）。
   设计原则：尽量纯函数，便于 ai-context.test.js 无浏览器直接测。
   共享文件？——不是；这是本次 AI 接入新建的独立文件，各看板视图不碰。
   ============================================================ */
'use strict';

/* ---------- 常量：截断上限 & 口径系统提示词 ---------- */
// snapshot 字符上限（~24KB）。超出截断并标注，防止把整份底表塞进请求。
const SNAPSHOT_MAX = 24 * 1024;

// PSI 九个维度键（与 engine-core.DIM_KEYS 同源；工具参数校验与提示词都用它，禁止模型自造维度名）
const DIM_KEYS = ['region', 'repOffice', 'country', 'channel', 'family', 'line', 'series', 'product', 'model'];
// 财经单位假设：实际=USD / 预测=MUSD / BP=USD，数量恒为台（与经营分析看板同一套，缺省会导致金额不归一）
const FIN_UNITS = { actual: 'USD', forecast: 'MUSD', bp: 'USD' };
const FIN_QTY = { actual: '台', forecast: '台', bp: '台' };

// 口径系统提示词（常驻 system）：与仓库硬约束一致，要求 AI 数字口径以注入数据为准，不编造。
const CALIBER_PROMPT = [
  '你是 Salesboard 的数据分析助手。回答基于下方注入的看板数据，数字口径必须以注入数据为准，不得编造或臆测未提供的数字。',
  '数据口径约定：',
  '· 渠道：全部渠道相加，不去重。',
  '· 库存：按最新期求和（不是各期累加）。',
  '· DOS = 库存 ÷ 日均 Sell Out。',
  '· NSIP = 单台净销售价（USD/台）= SIP − 返利 − 激励 − 营销 − 抵减。',
  '· 金额单位：实际表用 USD，预测/BP 表用 MUSD；数量恒为「台」。',
  '· DOS 分母＝近 4 个 ISO 周 SO ÷ 28（不是月均）；库存分子取最新期快照。音频产业因人工延迟报量，按最小原子单元各自取「最后有 SO 的那一周」为窗口终点，无 SO 时 DOS 显示「—」而不是 0。',
  '· 销毛率＝销毛额 ÷ 收入（先各自求和再相除，不能对率取平均）；NSIP＝收入 ÷ 收入量，单位 USD/台，其同比是绝对美元差不是百分比；BP/预测达成率的分子是区间实际、分母是全年目标，必须同时说明时间进度。',
  '· 层级错位：PSI（销售组织）的 Product Family ↔ 财经（财经组织）的 LV3，Product Series ↔ LV4。不要按名字直接对齐两套层级。',
  '· 跨看板同一指标出现差异时，先说明两边口径再下结论；PSI 与财经的 Sell-in/out 差异 ≤100 台属正常（收入量口径 + DOS>90 递延），不要当异常报。',
  '· filters 里的任何取值必须来自 options 工具的返回（维度名也只能用工具列出的那几个），禁止凭记忆或翻译自造名字——拼错会静默返回空结果。',
  '若注入数据中没有用户想要的数字，先尝试用工具去查；确实查不到再说「当前数据未包含该项」，不要瞎编。',
  '用简体中文回答，可用 Markdown（加粗、代码块、表格）。',
].join('\n');

/* 工具参数 JSON Schema（原生 function-calling 与回退协议同一真源）。
   要点：required + enum + additionalProperties:false；不用 $defs（llama.cpp GBNF 兼容性）；
   不写 type:['string','null']（用「省略字段」表达空）。旧版是 properties:{} 空壳，
   模型因此完全不知道能按维度取数 —— 这是「查不到 Coral」的直接原因之一。 */
const DIM_ENUM = ['region', 'repOffice', 'country', 'channel', 'family', 'line', 'series', 'product', 'model'];
/* filters 用「一句话描述 + 开放对象」而不是把 9 个维度逐个列成 properties：
   逐个列会在每个含 filters 的工具里各抄一遍（4 个工具 ≈ 多 600 token 输入），
   本地模型每次请求都要重新读一遍这堆样板，直接拖慢首字时间。描述里写清键名即可。 */
const FILTERS_SCHEMA = {
  type: 'object',
  description: '筛选，如 {"country":["巴西"]}。键限 ' + DIM_ENUM.join('/') + '；取值先用 options 查。',
  additionalProperties: true,
};
const TOOL_SCHEMAS = {
  meta: { description: '数据源元信息：维度、日期范围、有无财经/IDC/全流程库存。开头先调。', properties: {}, required: [] },
  options: {
    description: '列出某维度的可选值。往 filters 填值前必须先调。',
    properties: {
      field: { type: 'string', enum: DIM_ENUM },
      filters: FILTERS_SCHEMA,
      contains: { type: 'string', description: '模糊找名字（不区分大小写）' },
      limit: { type: 'integer', description: '默认 60' },
    }, required: ['field'],
  },
  report: {
    description: '汇总表：按维度分组给 累计SO/同期/同比、累计SI、周SO/WoW、库存、DOS、全流程库存与DOS。问「卖了多少/同比/库存/周转天数」首选。累计恒为年初至今，无期间参数；指定期间用 query。',
    properties: {
      groupDim: { type: 'string', enum: DIM_ENUM },
      filters: FILTERS_SCHEMA,
      weeks: { type: 'integer', description: '周列数，默认 9' },
    }, required: ['groupDim'],
  },
  query: {
    description: 'PSI 时间序列：时间桶 × 一个堆叠维度。问「走势/趋势」用它；指定期间（如1-6月/Q2）的累计也用它：按 month 传 from/to 求和。',
    properties: {
      stackDim: { type: 'string', enum: DIM_ENUM, description: '必填；只看整体也要挑一个（如 country）' },
      metric: { type: 'string', enum: ['sellOut', 'sellIn', 'inv', 'dos'] },
      gran: { type: 'string', enum: ['day', 'week', 'month'] },
      from: { type: 'string', description: 'YYYY-MM-DD' },
      to: { type: 'string', description: 'YYYY-MM-DD' },
      filters: FILTERS_SCHEMA,
    }, required: ['stackDim'],
  },
  financeOverview: { description: '经营概览：收入/销毛率/NSIP/Sell-in量 的实际、同期、同比、BP与预测达成率。', properties: { year: { type: 'integer' }, fromM: { type: 'integer' }, toM: { type: 'integer' } }, required: [] },
  financeProductBoard: { description: '按 产品线/LV3系列/LV4产品 的收入、销毛额、销毛率、NSIP、达成率。', properties: { fromM: { type: 'integer' }, toM: { type: 'integer' }, lv1: { type: 'array', items: { type: 'string' } }, lv3: { type: 'array', items: { type: 'string' } } }, required: [] },
  financeRepBoard: { description: '国家办经营看板。不支持 lv1，只认 reps 与 series(LV3 名集)。', properties: { fromM: { type: 'integer' }, toM: { type: 'integer' }, reps: { type: 'array', items: { type: 'string' } }, series: { type: 'array', items: { type: 'string' } } }, required: [] },
  financeCustom: { description: '经营自定义取数：按财经维度取指定指标。', properties: { rowDim: { type: 'string', enum: ['rep', 'lv1', 'lv2', 'lv3', 'lv4', 'model'] }, metrics: { type: 'array', items: { type: 'string', enum: ['rev', 'gm', 'gmr', 'cp', 'sellIn', 'sellOut', 'nsip', 'bpAttain', 'fcAttain'] } }, fromM: { type: 'integer' }, toM: { type: 'integer' } }, required: ['rowDim'] },
  industryBoard: { description: '产业 4 个 KPI：今年 SI/SO 累计与同比、当前库存与渠道DOS、全流程库存与DOS。', properties: { filters: FILTERS_SCHEMA, metric: { type: 'string', enum: ['sellIn', 'sellOut', 'inv', 'dos'] }, gran: { type: 'string', enum: ['day', 'week', 'month'] } }, required: [] },
  industryTrend: { description: '产业趋势：今年 vs 去年同期逐期序列。', properties: { filters: FILTERS_SCHEMA, metric: { type: 'string', enum: ['sellIn', 'sellOut', 'inv', 'dos'] }, gran: { type: 'string', enum: ['day', 'week', 'month'] } }, required: [] },
  boardState: { description: '读用户此刻在看板上选了什么。用户说「当前/我现在选的」时先调。', properties: { boardId: { type: 'string', description: 'psi/report/country/industry/finance/audio/inventory' } }, required: [] },
  agg: { description: '通用二维聚合（类别 × 图例 × 度量），dataset:"idc" 切市场底表。', properties: { cat: { type: 'object', properties: { field: { type: 'string' }, gran: { type: 'string' } }, additionalProperties: false }, legend: { type: 'string' }, measure: { type: 'string' }, agg: { type: 'string', enum: ['sum', 'avg', 'count', 'last', 'min', 'max'] }, filters: FILTERS_SCHEMA, dataset: { type: 'string', enum: ['psi', 'idc'] } }, required: [] },
  aggIdc: { description: 'IDC 市场数据：给 field 则列出该维度取值，否则按 cat/legend 聚合市场量额。', properties: { field: { type: 'string' }, cat: { type: 'object', properties: { field: { type: 'string' } }, additionalProperties: false }, legend: { type: 'string' }, measure: { type: 'string', enum: ['units', 'value', 'asp'] }, filters: { type: 'object', additionalProperties: true } }, required: [] },
  sosimSummary: { description: '库存推演概要：国家/型号数、月份跨度、是否有成本表。', properties: {}, required: [] },
  pricingLibRecords: { description: '产品定价库概要：记录数、覆盖国家与产品。', properties: {}, required: [] },
};
/* 快速模式下按提问挑工具。
   原来写死 tools.slice(0,3)，结果问「DOS 多少」时把真正该用的 report 切没了（它排第 4）。
   改成拿提问关键词打分：options 永远留（填 filters 前必须先查精确取值），
   其余按工具描述命中数取前几名，都没命中就退回原顺序。 */
function pickTools(names, question, max) {
  const list = (names || []).filter(n => TOOL_SCHEMAS[n]);
  const lim = max || 3;
  if (list.length <= lim) return list;
  const s = String(question || '').toLowerCase();
  const terms = {};
  (s.match(/[a-z][a-z0-9]+/g) || []).forEach(w => { terms[w] = 2; });
  (s.match(/[一-龥]{2,}/g) || []).forEach(run => {
    for (let i = 0; i + 2 <= run.length; i++) terms[run.slice(i, i + 2)] = 1;
  });
  const keys = Object.keys(terms);
  const scored = list.map((n, i) => {
    const d = (TOOL_SCHEMAS[n].description || '').toLowerCase();
    let sc = 0;
    keys.forEach(t => { if (d.indexOf(t) >= 0) sc += terms[t]; });
    return { n, i, sc };
  });
  const keep = [];
  if (list.indexOf('options') >= 0) keep.push('options');
  scored.filter(x => x.sc > 0 && keep.indexOf(x.n) < 0)
    .sort((a, b) => b.sc - a.sc || a.i - b.i)
    .forEach(x => { if (keep.length < lim) keep.push(x.n); });
  list.forEach(n => { if (keep.length < lim && keep.indexOf(n) < 0) keep.push(n); });
  return list.filter(n => keep.indexOf(n) >= 0);   // 保持注册表原顺序，规格字节稳定
}

// 生成 OpenAI function-calling 规格（只给注册表里真实存在的工具）
function buildToolSpecs(names) {
  return (names || []).filter(n => TOOL_SCHEMAS[n]).map(n => {
    const s = TOOL_SCHEMAS[n];
    return { type: 'function', function: { name: n, description: s.description, parameters: { type: 'object', properties: s.properties, required: s.required || [], additionalProperties: false } } };
  });
}

/* ============================================================
   1) 截断（纯函数）
   ============================================================ */
// 把字符串截到 max 字符；超出则截断并追加「(数据已截断)」标注。非字符串归一为字符串。
function truncateSnapshot(str, max) {
  const lim = (typeof max === 'number' && max > 0) ? max : SNAPSHOT_MAX;
  const s = (str == null) ? '' : String(str);
  if (s.length <= lim) return s;
  const tag = '\n…(数据已截断)';
  const keep = Math.max(0, lim - tag.length);
  return s.slice(0, keep) + tag;
}

/* ============================================================
   2) 回退协议解析（纯函数）
   AI 在不支持原生 function-calling 时，被 system 要求「需要数据时仅输出
   {"tool":名,"args":{}} 的 JSON」。这里从模型回复文本里把这个指令抠出来。
   宽松策略：优先整段 JSON.parse；失败则找第一个含 "tool" 键的 {...} 片段。
   返回 {tool, args} 或 null（非工具调用/非法输入）。绝不抛异常。
   ============================================================ */
function parseToolCall(text) {
  if (text == null) return null;
  const raw = String(text).trim();
  if (!raw) return null;
  // 剥 ```json ... ``` 代码围栏（模型常这样包）
  let body = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  const tryParse = (str) => {
    let o;
    try { o = JSON.parse(str); } catch (e) { return null; }
    return normalizeToolObj(o);
  };
  // 1) 整段就是 JSON
  const whole = tryParse(body);
  if (whole) return whole;
  // 2) 扫描第一个平衡的 {...}，逐个尝试（含嵌套 args）
  const cands = extractBraceSpans(body);
  for (const span of cands) {
    const got = tryParse(span);
    if (got) return got;
  }
  return null;
}

// 把已解析对象归一为 {tool, args}；不含 string 型 tool 字段则视为非工具调用。
function normalizeToolObj(o) {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return null;
  const name = o.tool || o.name || o.function || (o.tool_call && o.tool_call.name);
  if (typeof name !== 'string' || !name.trim()) return null;
  let args = o.args || o.arguments || o.params || {};
  // arguments 有时是 JSON 字符串（OpenAI 风格），尝试再解一层
  if (typeof args === 'string') {
    try { args = JSON.parse(args); } catch (e) { args = {}; }
  }
  if (!args || typeof args !== 'object' || Array.isArray(args)) args = {};
  return { tool: name.trim(), args };
}

// 抽出文本里所有「平衡花括号」子串（浅层扫描，支持嵌套），按出现顺序。
function extractBraceSpans(s) {
  const out = [];
  let depth = 0, start = -1, inStr = false, esc = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) { esc = false; }
      else if (ch === '\\') { esc = true; }
      else if (ch === '"') { inStr = false; }
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === '{') { if (depth === 0) start = i; depth++; }
    else if (ch === '}') { if (depth > 0) { depth--; if (depth === 0 && start >= 0) { out.push(s.slice(start, i + 1)); start = -1; } } }
  }
  return out;
}

/* ============================================================
   3) 工具注册表 + 分发（纯函数化：注册表以对象传入）
   工具 = { name: async (args, ctx)=>result }。两条路径（原生 tools / 回退协议）
   共用同一注册表。dispatchTool 统一分发、统一 try 包裹、统一序列化，绝不抛。
   ============================================================ */
// 列出可暴露给 AI 的工具名（用于生成回退协议里的工具清单说明）。
function toolNames(registry) {
  return registry ? Object.keys(registry) : [];
}

// 分发一次工具调用。未知工具/执行异常都回一个 {error} 结果（回喂给模型，别中断循环）。
async function dispatchTool(registry, call, ctx) {
  if (!call || !call.tool) return { error: '无效的工具调用' };
  const fn = registry && registry[call.tool];
  if (typeof fn !== 'function') return { error: '未知工具: ' + call.tool };
  try {
    const r = await fn(call.args || {}, ctx || {});
    return (r === undefined) ? null : r;
  } catch (e) {
    return { error: String((e && e.message) || e) };
  }
}

// 把工具结果序列化成回喂给模型的文本（截断，防超长）。
function stringifyToolResult(name, result) {
  let body;
  try { body = JSON.stringify(result); } catch (e) { body = String(result); }
  return truncateSnapshot('[工具 ' + name + ' 返回]\n' + body, SNAPSHOT_MAX);
}

/* ============================================================
   浏览器侧：注册表实例 + 通用兜底 provider + 全局工具集
   （以下依赖 window/api，纯函数测试不走这里；用 typeof window 守卫）
   ============================================================ */
const AIData = (function () {
  const providers = {};          // boardId -> { label, snapshot():Promise<string>|string }

  function register(boardId, provider) {
    if (!boardId || !provider) return;
    providers[boardId] = provider;
  }
  function get(boardId) { return providers[boardId] || null; }
  function labelOf(boardId) {
    const p = providers[boardId];
    return (p && p.label) || boardId || '看板';
  }

  // 取 renderer 侧 api（window.sb）。测试环境无 window → 返回 null。
  const A = () => (typeof window !== 'undefined' && window.sb) ? window.sb : null;

  /* ---------- 看板「当前界面选择」提取器 ----------
     15 个看板里只有 7 个的状态键符合 sb.<id>.v1 规律，且 localStorage 里没有运行态
     （PSI 的 rangeFrom/rangeTo、国家看板的 cb 等）。所以优先读同一全局作用域的内存变量，
     读不到再退 localStorage。filters 直接就是能喂给 api.report/query 的形状。 */
  const BOARD_STATE_MAX = 1500;   // 「当前看板设置」单独限额：胖 custom/designer 配置能吃掉整个上下文
  const G = n => { try { return (typeof window !== 'undefined' && window[n] !== undefined) ? window[n] : eval(n); } catch (e) { return undefined; } };
  function truncObj(o, max) {
    let s; try { s = JSON.stringify(o); } catch (e) { return undefined; }
    if (s == null) return undefined;
    if (s.length <= max) return o;
    return { 说明: '设置过长已省略，仅列键名', 键: Object.keys(o || {}).slice(0, 40) };
  }
  const pickFilters = f => {
    if (!f || typeof f !== 'object') return {};
    const out = {};
    Object.keys(f).forEach(k => { const v = f[k]; if (Array.isArray(v) ? v.length : (v != null && v !== '')) out[k] = v; });
    return out;
  };
  // boardId → { filters, groupDim, state }
  function boardContext(boardId) {
    const ls = k => boardLocal(k);
    try {
      switch (boardId) {
        case 'psi': {
          const st = (typeof psi !== 'undefined' && psi) || G('psi') || ls('sb.psi.v1');
          return st ? { filters: pickFilters(st.filters), groupDim: st.stackDim || 'series', state: st } : null;
        }
        case 'report': {
          const st = G('rep') || ls('sb.report.v1');
          return st ? { filters: pickFilters(st.filters), groupDim: st.dim || 'series', state: st } : null;
        }
        case 'country': {
          const st = G('cb');
          return st ? { filters: pickFilters(st.filters), groupDim: st.dim || 'product', state: st } : null;
        }
        case 'industry': {
          const st = G('ind') || ls('sb.industry.v1');
          return st ? { filters: pickFilters(st.filters), groupDim: st.indDim || 'line', state: st } : null;
        }
        case 'finance': {
          const st = G('fin') || ls('sb.finance.v1');
          return st ? { filters: {}, groupDim: 'series', state: { 年: st.year, 月份: st.fromM + '~' + (st.toM || '最新实际月'), 版本: st.version, 国家办: st.reps, LV1: st.lv1, LV2: st.lv2, LV3: st.lv3, LV4: st.lv4, 金额单位: st.unit } } : null;
        }
        case 'audio': {
          const st = G('auW');
          if (!st) return null;
          const d = st.indDim && st.indDim[st.industry];
          return { filters: d ? { [d.field]: [d.value] } : {}, groupDim: (st.cb && st.cb.dim) || 'product', state: { 产业: st.industry, 拆分: st.cb && st.cb.dim, 国家: (st.data && st.data.countries) || [] } };
        }
        case 'inventory': {
          const so = G('__sosim');
          return so ? { filters: pickFilters(so.filters), groupDim: so.prodLevel || 'series', state: { 地理粒度: so.geoLevel, 产品粒度: so.prodLevel, 时间粒度: so.gran } } : null;
        }
        case 'custom': { const st = ls('sb.custom.v1'); return st ? { filters: pickFilters(st.filters), groupDim: st.xDim || 'series', state: st } : null; }
        case 'pricinglib': { const px = G('PXLIB') || ls('sb.pricing.lib.v1'); return px ? { filters: {}, groupDim: 'series', state: { 记录数: (px.records || []).length } } : null; }
        case 'pricing': { const st = ls('sb.pricing.v4') || ls('sb.pricing.v3'); return st ? { filters: {}, groupDim: 'series', state: st } : null; }
        case 'textout': { const st = ls('sb.textout.v1'); return st ? { filters: {}, groupDim: 'series', state: { 模板数: Object.keys(st || {}).length } } : null; }
        default: {
          const st = ls('sb.' + boardId + '.v1') || ls('sb.' + boardId);
          return st ? { filters: pickFilters(st.filters), groupDim: st.dim || 'series', state: st } : null;
        }
      }
    } catch (e) { return null; }
  }

  // 安全取值：把可能抛错/返回 Promise 的取数包成 try，失败返回 undefined。
  async function safe(fn) {
    try { const v = await fn(); return v; } catch (e) { return undefined; }
  }

  // 读某看板的 sb.* 持久化状态（筛选/粒度等），失败/无值返回 null。
  function boardLocal(key) {
    try {
      if (typeof localStorage === 'undefined') return null;
      const raw = localStorage.getItem(key);
      if (!raw) return null;
      const o = JSON.parse(raw);
      return (o && typeof o === 'object') ? o : null;
    } catch (e) { return null; }
  }

  // 通用兜底 provider 的快照：能取则取，取不到跳过；最后 JSON 化 + 截断。
  // boardId 用来附带该看板的持久化状态与标签；null=全局模式。
  async function genericSnapshot(boardId) {
    const api = A();
    const out = { 看板: boardId ? labelOf(boardId) : '全局（跨看板）' };

    // 数据源元信息（数据源/时间范围/记录数）
    const meta = api ? await safe(() => api.meta()) : null;
    if (meta && typeof meta === 'object') {
      out.数据源 = {
        记录数: meta.records || 0,
        时间范围: (meta.from || '?') + ' ~ ' + (meta.to || '?'),
        维度: Array.isArray(meta.dims) ? meta.dims : undefined,
        PSI文件夹: meta.folder || null,
        有财经数据: !!meta.hasFin,
        有IDC数据: !!meta.hasIdc,
        全流程库存截至: meta.flowDate || null,
      };
      if (meta.finMeta) {
        out.数据源.财经 = {
          年份: meta.finMeta.actualYears || meta.finMeta.years || [],
          版本: meta.finMeta.versions || [],
          指标数: (meta.finMeta.metrics || []).length,
        };
      }
      if (Array.isArray(meta.files) && meta.files.length) {
        out.数据源.文件 = meta.files.slice(0, 30).map(f => f.name + '(' + (f.rows || 0) + '行)');
      }
    }

    // 该看板「界面上此刻选了什么」——优先读内存全局(最准，含 localStorage 里没有的运行态)，
    // 读不到再退 localStorage。这是修复「用户筛了 Product Series=Coral，AI 却看不见」的关键。
    const ctx = boardId ? boardContext(boardId) : null;
    if (ctx && ctx.state) out.当前看板设置 = truncObj(ctx.state, BOARD_STATE_MAX);
    const curFilters = (ctx && ctx.filters && Object.keys(ctx.filters).length) ? ctx.filters : null;
    if (curFilters) out.当前筛选 = curFilters;

    // 若干通用聚合（能取则取，取不到跳过）
    if (api && meta && (meta.records || 0) > 0) {
      // report 汇总：**带上用户当前筛选**（没有筛选才退回全局），分组维度也跟着看板走
      const gd = (ctx && ctx.groupDim) || 'series';
      const rep = await safe(() => api.report({ groupDim: gd, filters: curFilters || {}, weeks: 4 }));
      if (rep && rep.total) {
        out['汇总_按' + gd + (curFilters ? '(已按当前筛选)' : '')] = summarizeReport(rep);
      }
      // 维度可选值清单：让模型知道数据里到底有哪些取值（否则它只能猜名字）
      const dimsWanted = ['line', 'series', 'product', 'country'].filter(d => (meta.dims || []).includes(d));
      const opts = {};
      for (const d of dimsWanted) {
        const vals = await safe(() => api.options(d, curFilters || {}));
        if (Array.isArray(vals) && vals.length) opts[d] = vals.length > 40 ? vals.slice(0, 40).concat(['…共' + vals.length + '项']) : vals;
      }
      if (Object.keys(opts).length) out.可选维度取值 = opts;
      // 经营概览
      if (meta.hasFin) {
        const ov = await safe(() => api.financeOverview({}));
        if (ov && ov.metrics) out.经营概览 = compactOverview(ov);
      }
    }

    // 库存/销毛：window.__sosim 概要（跨看板共享状态）
    const so = (typeof window !== 'undefined') ? window.__sosim : null;
    if (so && so.ctx) {
      out.库存推演 = safeSosimSummary(so);
    }

    // 定价库：记录数 + 国家清单（能取则取）
    const pxLib = boardLocal('sb.pricinglib.v1') || boardLocal('sb.pricinglib');
    if (pxLib && Array.isArray(pxLib.records)) {
      const countries = [...new Set(pxLib.records.map(r => r && r.country).filter(Boolean))];
      out.定价库 = { 记录数: pxLib.records.length, 国家: countries.slice(0, 40) };
    }

    let body;
    try { body = JSON.stringify(out, null, 1); } catch (e) { body = String(out); }
    return truncateSnapshot(body, SNAPSHOT_MAX);
  }

  /* report 结果 → 紧凑摘要（合计 + 前若干组）。
     ⚠ 字段名必须与 engine-report.js 的产出一致：行是 key/cumCur/cumPrev/yoy/siCur/inv/dos/last4，
     不是 label/name/curYear —— 早期写错导致快照里全是空对象 {}，模型拿不到任何数字。 */
  function summarizeReport(rep) {
    const t = rep.total || {};
    const one = r => ({
      组: r.key,
      累计SO: r.cumCur, 去年同期SO: r.cumPrev, SO同比: r.yoy,
      累计SI: r.siCur,
      库存: r.inv, DOS: r.dos, 近4周SO: r.last4,
      全流程库存: r.flowInv, 全流程DOS: r.flowDos,
    });
    return {
      口径年: rep.curYear + '/' + rep.prevYear,
      分组维度: rep.groupLabel,
      周列: rep.weekLabels,
      合计: one(t),
      分组: (rep.rows || []).slice(0, 12).map(one),
      备注: (rep.rows || []).length > 12 ? ('仅列前 12 组，共 ' + rep.rows.length + ' 组；要看其余请用 report 工具加 filters 收窄') : undefined,
    };
  }

  /* financeOverview → 紧凑（去掉大数组，留关键指标）。
     ⚠ 预测字段是 fc 不是 forecast；同比与达成率必须带上（跨看板问答最常问这三个）。 */
  function compactOverview(ov) {
    const m = ov.metrics || {};
    const prog = (ov.toM && ov.fromM) ? +(((ov.toM - ov.fromM + 1) / 12).toFixed(3)) : undefined;
    const out = {
      口径年: ov.curYear + '/' + ov.prevYear, 月份: ov.fromM + '~' + ov.toM, 时间进度: prog,
      版本: ov.version, BP版本: ov.bpVersion,
      单位说明: '金额 USD；数量 台；NSIP=USD/台（不随金额单位缩放）',
    };
    Object.keys(m).slice(0, 20).forEach(k => {
      const v = m[k];
      out[k] = (v && typeof v === 'object')
        ? { 实际: v.actual, 去年同期: v.prev, 同比: v.yoy, 全年BP: v.bp, BP达成率: v.bpAttain, 全年预测: v.fc, 预测达成率: v.fcAttain }
        : v;
    });
    return out;
  }

  // __sosim 概要（国家/型号数 + 月份跨度），全 try 包裹
  function safeSosimSummary(so) {
    try {
      const ctx = so.ctx || {};
      const models = ctx.models || (ctx.actual ? [...new Set([...ctx.actual.keys()].map(k => String(k).split('|').pop()))] : []);
      return {
        地理粒度: so.geoLevel, 产品粒度: so.prodLevel, 时间粒度: so.gran,
        型号数: Array.isArray(models) ? models.length : undefined,
        月份: ctx.months ? (ctx.months[0] + '~' + ctx.months[ctx.months.length - 1]) : undefined,
        有成本表: !!so.cost,
      };
    } catch (e) { return { error: '库存概要取值失败' }; }
  }

  /* ---------- 全局工具集：全部只读、走现有 IPC/window，零新算逻辑 ---------- */
  function buildToolRegistry() {
    const api = A();
    const wrap = fn => async (args) => {
      if (!api) return { error: 'API 不可用' };
      return await fn(args || {});
    };
    return {
      // 数据源元信息：可用维度、日期范围、有没有财经/IDC/全流程库存。会话开头应先调。
      meta: wrap(() => api.meta()),
      // 枚举某维度的可选值 —— 往 filters 里填值前必须先用它拿到精确写法（引擎按字典精确匹配，拼错静默返回空）
      options: wrap(async a => {
        const f = a.field;
        if (!f || !DIM_KEYS.includes(f)) return { error: 'field 必填，且只能是：' + DIM_KEYS.join('/') };
        let vals = await api.options(f, a.filters || {});
        if (!Array.isArray(vals)) return { error: '取值失败' };
        const total = vals.length;
        if (a.contains) { const kw = String(a.contains).toLowerCase(); vals = vals.filter(v => String(v).toLowerCase().indexOf(kw) >= 0); }
        const lim = Math.max(1, Math.min(200, +a.limit || 60));
        return { field: f, 命中: vals.length, 全量: total, 取值: vals.slice(0, lim), 截断: vals.length > lim };
      }),
      // 汇总表：按维度分组的 SO/SI/库存/DOS（+同比）
      report: wrap(a => {
        if (a.groupDim && !DIM_KEYS.includes(a.groupDim)) return { error: 'groupDim 只能是：' + DIM_KEYS.join('/') };
        return api.report({ groupDim: a.groupDim || 'series', filters: a.filters || {}, weeks: a.weeks || 9, fromW: a.fromW, toW: a.toW });
      }),
      // 时间序列：stackDim 必填（引擎不传会抛，旧版这里默认 null 导致 query 恒返回空）
      query: wrap(async a => {
        if (!a.stackDim || !DIM_KEYS.includes(a.stackDim)) {
          return { error: 'stackDim 必填（引擎要求），只能是：' + DIM_KEYS.join('/') + '。想看整体也要挑一个维度，例如 country。' };
        }
        const met = a.metric || 'sellOut';
        const r = await api.query({ metric: met, gran: a.gran || 'month', filters: a.filters || {}, stackDim: a.stackDim, from: a.from, to: a.to, limit: a.limit });
        // 期间累计由工具算好：模型自己加桶会算错（评测2026-08-25：5645加成5944）。
        // 只对流量类(sellOut/sellIn)给合计——库存/DOS跨期相加是口径红线，绝不提供。
        try {
          if (r && r.data && (met === 'sellOut' || met === 'sellIn')) {
            const sums = {}; let tot = 0;
            (r.series || []).forEach(n => {
              let s = 0; Object.values(r.data[n] || {}).forEach(v => { s += (+v || 0); });
              sums[n] = s; tot += s;
            });
            r.区间合计 = Object.assign({ _全部: tot }, sums);
          }
        } catch (e) {}
        return r;
      }),
      // 经营自定义：按财经维度/指标取数（finUnits/finQtyUnits 不传引擎会按缺省，金额可能不归一）
      financeCustom: wrap(a => api.financeCustom(Object.assign({ finUnits: FIN_UNITS, finQtyUnits: FIN_QTY }, a || {}))),
      // 经营概览 / 产业产品经营看板 / 国家办经营看板
      // 年份护栏：模型凭空猜 year（评测2026-08-25抓到猜2023）会拿回全零并照报——改成可读错误让它自纠
      financeOverview: wrap(async a => {
        if (a && a.year != null) {
          try {
            const m = await api.meta();
            const years = m && m.finMeta && m.finMeta.years;
            if (Array.isArray(years) && years.length && years.indexOf(+a.year) < 0) {
              return { error: '年份 ' + a.year + ' 无财经数据，可用年份：' + years.join('/') + '。不确定就不要传 year（默认最新实际年）。' };
            }
          } catch (e) {}
        }
        return api.financeOverview(Object.assign({ finUnits: FIN_UNITS, finQtyUnits: FIN_QTY }, a || {}));
      }),
      financeProductBoard: wrap(a => api.financeProductBoard(Object.assign({ finUnits: FIN_UNITS, finQtyUnits: FIN_QTY }, a || {}))),
      // 注意：国家办看板不支持 lv1，只认 reps + series(LV3 名集)
      financeRepBoard: wrap(a => api.financeRepBoard(Object.assign({ finUnits: FIN_UNITS, finQtyUnits: FIN_QTY }, a || {}))),
      // 通用聚合（PSI）
      agg: wrap(a => api.agg(a || {})),
      // IDC 市场聚合：主进程判的是 params.dataset==='idc'（旧版传 source 导致静默返回 PSI 数据冒充 IDC）
      aggIdc: wrap(a => {
        if (a && a.field && typeof api.idcOptions === 'function') return api.idcOptions(a.field, a.filters || {});
        if (!api.agg) return { error: 'IDC 聚合不可用' };
        return api.agg(Object.assign({}, a || {}, { dataset: 'idc' }));
      }),
      // 产业看板 KPI + 趋势
      industryBoard: wrap(a => api.industryBoard(a || {})),
      industryTrend: wrap(a => api.industryTrend(a || {})),
      // 当前看板界面上选了什么（用户说「这个/当前筛选」时先调它）
      boardState: async a => {
        const c = boardContext((a && a.boardId) || null);
        return c ? { 筛选: c.filters, 分组维度: c.groupDim, 设置: truncObj(c.state, BOARD_STATE_MAX) } : { error: '该看板没有可读的界面状态' };
      },
      // 库存推演概要（window 侧）
      sosimSummary: async () => {
        const so = (typeof window !== 'undefined') ? window.__sosim : null;
        return so && so.ctx ? safeSosimSummary(so) : { error: '库存推演未初始化' };
      },
      // 定价库记录概要（真实键是 sb.pricing.lib.v1；旧版读 sb.pricinglib.v1 恒为空）
      pricingLibRecords: async () => {
        const px = (typeof window !== 'undefined' && window.PXLIB) || boardLocal('sb.pricing.lib.v1') || boardLocal('sb.pricinglib.v1');
        const rec = px && Array.isArray(px.records) ? px.records : null;
        if (!rec) return { error: '定价库无数据' };
        return { 记录数: rec.length, 国家: [...new Set(rec.map(r => r && r.country).filter(Boolean))].slice(0, 40), 产品: [...new Set(rec.map(r => r && r.product).filter(Boolean))].slice(0, 40) };
      },
    };
  }

  // 回退协议：给 system 注入的工具清单说明（自然语言 + 严格 JSON 格式约定）。
  function fallbackToolPrompt(registry) {
    const names = toolNames(registry);
    if (!names.length) return '';
    // 带上参数签名与枚举值（与原生 schema 同一真源）——只列名字的话，模型根本不知道怎么按维度取数
    const sig = n => {
      const s = TOOL_SCHEMAS[n]; if (!s) return '· ' + n;
      const ps = Object.keys(s.properties || {}).map(k => {
        const p = s.properties[k];
        const req = (s.required || []).includes(k) ? '*' : '';
        const en = p.enum ? ('=' + p.enum.join('|')) : '';
        return k + req + en;
      });
      return '· ' + n + '(' + ps.join(', ') + ') — ' + (s.description || '');
    };
    return [
      '你可以调用以下只读数据工具来获取更精确的数字（带 * 的参数必填）：',
      names.map(sig).join('\n'),
      '维度名只能用：' + DIM_KEYS.join(' / ') + '；filters 形如 {"country":["巴西"],"series":["Coral"]}。',
      '取值必须先用 options 工具查到精确写法，不要凭记忆写。',
      '当你需要调用工具时，请【只】输出一行 JSON，格式严格为：{"tool":"工具名","args":{...}}，不要输出其它任何文字。',
      '系统会执行该工具并把结果回喂给你，你再据此继续回答。若不需要工具，直接正常回答即可。',
    ].join('\n');
  }

  return {
    register, get, labelOf,
    genericSnapshot,
    buildToolRegistry,
    fallbackToolPrompt,
    // 暴露纯函数便于外部（面板）复用
    truncateSnapshot, parseToolCall, dispatchTool, stringifyToolResult, toolNames,
    CALIBER_PROMPT, SNAPSHOT_MAX,
    // 新增：工具 schema / 规格生成 / 看板上下文（面板与编排层复用同一真源）
    TOOL_SCHEMAS, buildToolSpecs, pickTools, boardContext, DIM_KEYS,
  };
})();

// 浏览器：挂到 window 供 ai-panel 使用
if (typeof window !== 'undefined') {
  window.AIData = AIData;
  window.AI_CALIBER_PROMPT = CALIBER_PROMPT;
}

// Node：导出纯函数供 ai-context.test.js 无浏览器直接测
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    truncateSnapshot, parseToolCall, normalizeToolObj, extractBraceSpans,
    dispatchTool, stringifyToolResult, toolNames,
    SNAPSHOT_MAX, CALIBER_PROMPT,
    // 新增（纯函数，供 ai-context.test.js 与编排层测试）
    TOOL_SCHEMAS, buildToolSpecs, pickTools, DIM_KEYS,
  };
}

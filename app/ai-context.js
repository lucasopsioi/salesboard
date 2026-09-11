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
  dataCatalog: {
    description: '全域数据目录(RAG索引)：一次拿到本系统全部数据域的「有什么、什么范围、层级树、用哪个工具查」——PSI 层级全树(line→family→series→product)、财经(年份/版本/指标)、定价库、路标产品。开工前、迷路时、取不到数时先查它。',
    properties: {}, required: [] },
  searchDim: {
    description: '跨全维度定位一个名称属于哪个维度、精确写法是什么。取不到数/拿不准维度时第一时间用（常见病：把系列名当产品名）。',
    properties: { q: { type: 'string', description: '要定位的名称(如「低成本TWS耳机」)' } }, required: ['q'] },
  rawRows: {
    description: '直查 PSI 底表原始行(未聚合：全维度+日期+SI/SO/INV)。聚合工具查不到/怀疑数据异常时下钻到最底层看记录；默认200行上限500，大范围请用聚合工具。',
    properties: { filters: FILTERS_SCHEMA, from: { type: 'string', description: 'YYYY-MM-DD' }, to: { type: 'string' }, limit: { type: 'number' } }, required: [] },
  docSearch: {
    description: '在用户上传的文档全文里搜索（大文件不截断：提示词只带开头，其余用它查）。多词=AND，返回命中行与上下文。docId 见【用户上传文档】标注。',
    properties: { docId: { type: 'string' }, q: { type: 'string', description: '关键词，空格分隔多词' }, limit: { type: 'integer' }, context: { type: 'integer', description: '上下文行数 0-5' } }, required: ['docId', 'q'] },
  docSlice: {
    description: '按行号读取用户上传文档的一段原文（一次≤2000行）。配合 docSearch 的行号使用。',
    properties: { docId: { type: 'string' }, from: { type: 'integer' }, to: { type: 'integer' } }, required: ['docId', 'from'] },
  fsList: { description: '（已挂载的底表文件夹 PSI/库龄/财经/IDC/发货/成本 可只读访问，路径见 meta 的「PSI文件夹」或 dataCatalog）列出工作区文件夹内容（用户授权的本机目录）。path 用绝对路径。', properties: { dir: { type: 'string' }, depth: { type: 'integer', description: '1-3' } }, required: [] },
  fsRead: { description: '（已挂载的底表文件夹 PSI/库龄/财经/IDC/发货/成本 可只读访问，路径见 meta 的「PSI文件夹」或 dataCatalog）读本机文件：xlsx 按工作表返回行（sheet/fromRow/rows 可分页）；pptx/docx 抽文本；其余按文本。只能读工作区内。', properties: { path: { type: 'string' }, sheet: { type: 'string' }, fromRow: { type: 'integer' }, rows: { type: 'integer' }, maxChars: { type: 'integer' } }, required: ['path'] },
  fsWrite: { description: '写文本类文件(txt/md/csv/json/js/py…)到工作区，整文件覆盖，写前自动备份。用户会先确认。', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] },
  tableProfile: {
    description: '【大表首选·先做这步】流式体检本机表格(.xlsx/.csv/.tsv，50MB+ 也秒回)：返回工作表清单、数据行数、每列的名字/类型/取值范围/样例值、前几行。任何针对表格的统计或查找前，先用它看清列名与工作表名。',
    properties: { path: { type: 'string' }, sheet: { type: 'string', description: '工作表名，不填取第一个' }, headerRow: { type: 'integer', description: '表头在第几行，默认1' }, sample: { type: 'integer' } }, required: ['path'] },
  tableQuery: {
    description: '【大表统计·数字由代码算，绝不会错】对本机表格做筛选+分组+聚合，流式全表扫描，不受行数限制。求和/计数/均值/最大最小/去重计数一律用它，严禁自己写脚本或凭预览心算。例：某国销量合计 → {path,filters:[{col:"country",op:"eq",value:"Peru"}],metrics:[{fn:"sum",col:"units"}]}；按月分组 → {groupBy:[{col:"date",as:"month"}]}。',
    properties: {
      path: { type: 'string' }, sheet: { type: 'string' }, headerRow: { type: 'integer' },
      filters: { type: 'array', description: '[{col,op,value}]；op: eq/ieq/ne/contains/notContains/gt/gte/lt/lte/in/notIn/empty/notEmpty', items: { type: 'object' } },
      groupBy: { type: 'array', description: '列名数组；按日期分组用 {col:"日期列",as:"month"|"quarter"|"year"|"date"}', items: {} },
      metrics: { type: 'array', description: '[{fn,col,as}]；fn: sum/count/avg/min/max/countDistinct（count 不需要 col）', items: { type: 'object' } },
      sort: { type: 'object' }, limit: { type: 'integer' },
    }, required: ['path'] },
  tableValues: {
    description: '列出表格某一列的**精确取值**与各自行数（按出现次数排序）。筛选前必用：直接猜"墨西哥"还是"Mexico"会静默返回空结果，先用它拿到原文写法。',
    properties: { path: { type: 'string' }, col: { type: 'string' }, sheet: { type: 'string' }, headerRow: { type: 'integer' }, limit: { type: 'integer' } }, required: ['path', 'col'] },
  tableFind: {
    description: '在本机表格里按条件找出原始行（定位用，不做统计）。filters 同 tableQuery；也可只给 contains 做全行关键词搜索。返回命中行号与单元格。',
    properties: { path: { type: 'string' }, sheet: { type: 'string' }, headerRow: { type: 'integer' }, filters: { type: 'array', items: { type: 'object' } }, contains: { type: 'string' }, limit: { type: 'integer' }, countAll: { type: 'boolean' } }, required: ['path'] },
  excelEdit: {
    description: '结构化修改本机 Excel(.xlsx)：ops 数组按序执行，每项必须带 op 字段。例：{"op":"setCell","sheet":"Sheet1","cell":"B2","value":199}；{"op":"setRange","sheet":"Sheet1","origin":"A5","rows":[["a",1],["b",2]]}；{"op":"appendRows","sheet":"Sheet1","rows":[["c",3]]}；{"op":"addSheet","sheet":"新表","rows":[["表头"]]}；{"op":"deleteSheet","sheet":"旧表"}。文件不存在则新建。写前自动备份 .bak；单元格样式/公式可能被简化。用户会先确认。',
    properties: { path: { type: 'string' }, ops: { type: 'array', items: { type: 'object', properties: { op: { type: 'string', enum: ['setCell', 'setRange', 'appendRows', 'addSheet', 'deleteSheet'] }, sheet: { type: 'string' }, cell: { type: 'string' }, value: {}, origin: { type: 'string' }, rows: { type: 'array' } }, required: ['op'] } } }, required: ['path', 'ops'] },
  pptEdit: { description: '修改本机 PPT(.pptx) 文字：replace 数组 [{find, replace}] 在所有文本框与表格里原位替换，版式不动。写前自动备份。用户会先确认。', properties: { path: { type: 'string' }, replace: { type: 'array', items: { type: 'object', properties: { find: { type: 'string' }, replace: { type: 'string' } }, required: ['find'] } } }, required: ['path', 'replace'] },
  runCode: { description: '在工作区目录里运行一段脚本(node 或 python)，返回 stdout/stderr。适合复杂的数据处理/批量改文件；node 环境自带 xlsx、pptxgenjs 等库(require 可用)。用户会先确认。', properties: { lang: { type: 'string', enum: ['node', 'python'] }, code: { type: 'string' }, cwd: { type: 'string' }, timeoutMs: { type: 'integer' } }, required: ['code'] },
  roadmapUpsert: {
    description: '把产品信息写进路标管理(新建或更新)。用户用自然语言/文档描述产品(名称/上市时间/价格/编码/SKU/卖点/EOM等)时，抽取成结构化参数调本工具。白名单外的信息(如 VN1/VN2 编码)放 extras，会存进产品备注绝不丢。路标是用户规划数据，允许代填。',
    properties: {
      name: { type: 'string', description: '产品名(必填;已有产品模糊匹配更新,否则新建)' },
      fields: { type: 'object', description: '可选字段(中文名→键名): 内部编码→internalCode, 认证型号→certModel, 上市/最晚发货→shipLate(YYYY/MM), 最早发货→shipEarly, 停售→salesEnd, EOM/退市计划→eomPlan, 价格/定价→compositeRrpUsd(美元数字), 系列→seriesGroup, 产业→category, PSI关联名→psiLink, 前代/上一代/接续的产品→predecessor(填前代产品名)。凡能对上这些中文名的信息必须用对应键名写进 fields，对不上的才进 extras' },
      skus: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, color: { type: 'string' }, ram: { type: 'string' }, rom: { type: 'string' }, chip: { type: 'string' }, ean: { type: 'string' } }, required: ['name'] } },
      sellingPoints: { type: 'array', items: { type: 'string' } },
      extras: { type: 'object', description: '白名单外的键值(如 VN1编码)，全部存入产品备注' },
    }, required: ['name'] },
  makeExcel: {
    description: '生成 Excel 文件并自动保存打开。用于「导出/整理成 Excel/表格文件」类请求：先取数，再把数据组织成 sheets(每个 sheet 首行是表头)。',
    properties: {
      fileName: { type: 'string', description: '文件名(不含扩展名)' },
      sheets: { type: 'array', items: { type: 'object', properties: {
        name: { type: 'string', description: 'sheet 名(≤31字符)' },
        rows: { type: 'array', items: { type: 'array' }, description: '二维数组,首行表头' },
      }, required: ['name', 'rows'] } },
    }, required: ['fileName', 'sheets'] },
  makePpt: {
    description: '生成 PPT 文件（Acme红模板，微软雅黑）并自动保存打开。用于「做/生成/整理/导出 PPT」类请求：先取数，再把结论与表格组织成 slides。',
    properties: {
      fileName: { type: 'string', description: '文件名(不含扩展名)' },
      slides: { type: 'array', items: { type: 'object', properties: {
        title: { type: 'string' },
        bullets: { type: 'array', items: { type: 'string' } },
        table: { type: 'object', properties: { headers: { type: 'array', items: { type: 'string' } }, rows: { type: 'array', items: { type: 'array', items: { type: 'string' } } } } },
      }, required: ['title'] } },
    }, required: ['fileName', 'slides'] },
  openBoard: {
    description: '切换到指定看板视图（用户说「打开/切到 XX 看板」时用）。',
    properties: { boardId: { type: 'string', description: '看板 id(见 boardState 可用列表)' } }, required: ['boardId'] },
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
  // query 常驻(2026-08-31 评测五轮冤案):期间类护栏强制要求 query 逐月取数,
  // 而关键词打分常把 query 挤出前3(report 的描述更贴题面词)——工具被指路却不在清单,模型死局
  if (list.indexOf('query') >= 0) keep.push('query');
  // UI 落地工具常驻:makePpt/makeExcel 只在编排器判定意图命中时才进 names(见 orchestrate 的
  // uiExtra),进了名单就是本题的交付通道,绝不许被关键词打分挤掉(2026-09-01 D-轮1)
  ['makePpt', 'makeExcel', 'docSearch', 'docSlice', 'fsList', 'fsRead', 'excelEdit', 'pptEdit', 'fsWrite', 'runCode',
    'tableProfile', 'tableQuery', 'tableValues', 'tableFind'].forEach(n => { if (list.indexOf(n) >= 0 && keep.indexOf(n) < 0) keep.push(n); });
  scored.filter(x => x.sc > 0 && keep.indexOf(x.n) < 0)
    .sort((a, b) => b.sc - a.sc || a.i - b.i)
    .forEach(x => { if (keep.length < lim) keep.push(x.n); });
  list.forEach(n => { if (keep.length < lim && keep.indexOf(n) < 0) keep.push(n); });
  return list.filter(n => keep.indexOf(n) >= 0);   // 保持注册表原顺序，规格字节稳定
}

// 生成 OpenAI function-calling 规格（只给注册表里真实存在的工具）
function buildToolSpecs(names) {
  // 去重兜底：工具名重复会让 DeepSeek 直接 400「Tool names must be unique」，整轮取数失败。
  return [...new Set(names || [])].filter(n => TOOL_SCHEMAS[n]).map(n => {
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
  async function genericSnapshot(boardId, opts) {
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
    const uiFilters = (ctx && ctx.filters && Object.keys(ctx.filters).length) ? ctx.filters : null;
    // ignoreFilters：本题不指界面范围 → 概览按全量取，只把界面筛选当备注列出来
    const curFilters = (opts && opts.ignoreFilters) ? null : uiFilters;
    if (uiFilters) {
      out.当前筛选_仅供参考 = uiFilters;
      out.筛选说明 = '上面是用户界面此刻的筛选状态。若提问点名了具体产品/国家/产业，必须按提问自行构造 filters 取数，不受此筛选限制；仅当提问未指明范围时才参考它。';
    }

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
    // 写类本机工具的审批闸：Agent 对话看板注入 window.AgentApprove(tool,args)→Promise<boolean>；未注入(其它入口)一律拒绝
    const gated = async (tool, a, run) => {
      const ask = (typeof window !== 'undefined') ? window.AgentApprove : null;
      if (typeof ask !== 'function') return { error: '本机写操作只能在「Agent 对话」看板里执行（需要用户确认）' };
      let okA = false; try { okA = await ask(tool, a); } catch (e) { okA = false; }
      if (!okA) return { error: '用户拒绝了本次操作(' + tool + ')，请按用户意愿调整或停止' };
      return await run();
    };
    /* —— Agent 的手(2026-08-31)：makePpt 直接在渲染层用 PptxGenJS（国家看板同款Acme红样式），
       saveFile 后主进程自动打开；openBoard 调全局 switchView。业务数据仍只读。 —— */
    async function toolMakePpt(a) {
      try {
        if (typeof PptxGenJS === 'undefined') return { error: 'PPT 引擎不可用' };
        const slides = Array.isArray(a.slides) ? a.slides.slice(0, 20) : [];
        if (!slides.length) return { error: 'slides 为空' };
        const pptx = new PptxGenJS();
        pptx.defineLayout({ name: 'W', width: 13.333, height: 7.5 }); pptx.layout = 'W';
        slides.forEach(sl => {
          const pg = pptx.addSlide();
          pg.addText(String(sl.title || ''), { x: 0.4, y: 0.25, w: 12.5, h: 0.6, fontFace: '微软雅黑', fontSize: 20, bold: true, color: 'C7000B' });
          let y = 1.05;
          const bl = Array.isArray(sl.bullets) ? sl.bullets.slice(0, 12) : [];
          if (bl.length) {
            pg.addText(bl.map(b => ({ text: String(b), options: { bullet: { code: '2022' }, fontFace: '微软雅黑', fontSize: 13, color: '333333', breakLine: true } })), { x: 0.5, y: y, w: 12.3, h: Math.min(3, 0.32 * bl.length + 0.2) });
            y += Math.min(3, 0.32 * bl.length + 0.3);
          }
          const tb = sl.table;
          if (tb && Array.isArray(tb.headers) && tb.headers.length && Array.isArray(tb.rows)) {
            const cell = (t, o) => ({ text: String(t == null ? '' : t), options: Object.assign({ fontFace: '微软雅黑', fontSize: 9, align: 'right', valign: 'middle' }, o || {}) });
            const rows = [tb.headers.map((h, i) => cell(h, { bold: true, color: 'FFFFFF', fill: { color: 'C7000B' }, align: i === 0 ? 'left' : 'right' }))];
            tb.rows.slice(0, 40).forEach(r => rows.push((r || []).map((v, i) => cell(v, i === 0 ? { align: 'left' } : null))));
            const FIT = (typeof window !== 'undefined' && window.PptTableFit) || null;
            if (FIT) {
              const fr = FIT.fit(rows, { availIn: 12.5, fontSize: 9, minFontSize: 6, minColIn: 0.26 });
              pg.addTable(fr.rows, FIT.tableOpts(fr, { x: (13.333 - fr.totalIn) / 2, y: y,
                border: { type: 'solid', color: 'E6E8EB', pt: 0.5 }, autoPage: false }));
            } else {
              pg.addTable(rows, { x: 0.4, y: y, w: 12.5, border: { type: 'solid', color: 'E6E8EB', pt: 0.5 }, autoPage: false });
            }
          }
        });
        const b64 = await pptx.write('base64');
        const fn = String(a.fileName || 'AI生成').replace(/[\\/:*?"<>|]/g, '_').slice(0, 60);
        // 免对话框直存 文档\销售团队-AI输出\（旧 saveFile 弹保存框，用户取消/没注意就「看不到文件」）
        const res = api.aiSaveOutput ? await api.aiSaveOutput(fn + '.pptx', b64) : await api.saveFile(fn + '.pptx', b64, 'pptx');
        if (res && res.path) return { ok: true, 已保存: res.path, file: res.path, 页数: slides.length, 说明: '已存到 文档\\销售团队-AI输出，对话里有文件卡片可直接打开' };
        return { error: (res && res.error) || '保存失败' };
      } catch (e) { return { error: 'PPT 生成失败: ' + String((e && e.message) || e) }; }
    }
    async function toolMakeExcel(a) {
      try {
        if (typeof XLSX === 'undefined') return { error: 'Excel 引擎不可用' };
        const sheets = Array.isArray(a.sheets) ? a.sheets.slice(0, 10) : [];
        if (!sheets.length) return { error: 'sheets 为空' };
        const wb = XLSX.utils.book_new();
        sheets.forEach((sh, i) => {
          const rows = (Array.isArray(sh.rows) ? sh.rows.slice(0, 2000) : []).map(r => (Array.isArray(r) ? r : [r]));
          const ws = XLSX.utils.aoa_to_sheet(rows.length ? rows : [['(空)']]);
          XLSX.utils.book_append_sheet(wb, ws, String(sh.name || ('Sheet' + (i + 1))).slice(0, 31));
        });
        const b64 = XLSX.write(wb, { bookType: 'xlsx', type: 'base64' });
        const fn = String(a.fileName || 'AI导出').replace(/[\\/:*?"<>|]/g, '_').slice(0, 60);
        const res = api.aiSaveOutput ? await api.aiSaveOutput(fn + '.xlsx', b64) : await api.saveFile(fn + '.xlsx', b64, 'xlsx');
        if (res && res.path) return { ok: true, 已保存: res.path, file: res.path, sheet数: sheets.length, 说明: '已存到 文档\\销售团队-AI输出，对话里有文件卡片可直接打开' };
        return { error: (res && res.error) || '保存失败' };
      } catch (e) { return { error: 'Excel 生成失败: ' + String((e && e.message) || e) }; }
    }
    async function toolOpenBoard(a) {
      try {
        const id = String(a && a.boardId || '');
        if (!id) return { error: 'boardId 必填' };
        if (typeof switchView === 'function') { switchView(id); return { ok: true, 已切换: id }; }
        return { error: '视图切换不可用' };
      } catch (e) { return { error: String((e && e.message) || e) }; }
    }
    /* filters 维度校验：值塞错维度（如 product 取值塞进 series）引擎会静默返回空，
       模型据此误判"没数据"（评测2026-08-25 RunB 打掉6题）。查出错放维度就点名纠正。 */
    async function checkFilterDims(filters) {
      if (!filters || typeof filters !== 'object') return null;
      for (const k of Object.keys(filters)) {
        if (!DIM_KEYS.includes(k)) continue;               // 未知维度名交给参数校验拦
        const vals = [].concat(filters[k] || []).filter(v => v != null && v !== '');
        if (!vals.length) continue;
        let opts; try { opts = await api.options(k, {}); } catch (e) { return null; }
        if (!Array.isArray(opts)) continue;
        for (const v of vals) {
          if (opts.indexOf(v) >= 0) continue;
          for (const d of DIM_KEYS) {
            if (d === k) continue;
            let o2; try { o2 = await api.options(d, {}); } catch (e) { o2 = null; }
            if (Array.isArray(o2) && o2.indexOf(v) >= 0) {
              return { error: '『' + v + '』不是 ' + k + ' 的取值，它是 ' + d + ' 的取值——请放进 filters.' + d + ' 后重试。' };
            }
          }
          return { error: '『' + v + '』在 ' + k + ' 维度里不存在。先用 options({field:"' + k + '"}) 查精确取值再试。' };
        }
      }
      return null;
    }
    /* 财经比率防误读：模型把 0.3545 读成"0%"（评测RunC C2-02）——结果上附一行字段说明 */
    const finNote = (r) => {
      try { if (r && !r.error) r.字段说明 = 'bpAttain/fcAttain/revYoy/gmYoy/gmr 等均为小数比率（0.3545 = 35.45%）；nsip 为 USD/台。'; } catch (e) {}
      return r;
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
      report: wrap(async a => {
        if (a.groupDim && !DIM_KEYS.includes(a.groupDim)) return { error: 'groupDim 只能是：' + DIM_KEYS.join('/') };
        const bad = await checkFilterDims(a.filters);
        if (bad) return bad;
        const r = await api.report({ groupDim: a.groupDim || 'series', filters: a.filters || {}, weeks: a.weeks || 9, fromW: a.fromW, toW: a.toW });
        // 工具自述口径：比提示词更贴近模型视线（评测RunC：C1-02 仍拿年初至今冒充Q2）
        try { if (r && r.rows) r.口径说明 = '累计列(cumCur/siCur)为年初至今口径，不可当指定期间用；指定期间的累计请改用 query(from/to)。yoy/wow 为小数比率(0.228=+22.8%)。';
          if (Array.isArray(r.rows) && r.rows.length >= 2) {
            const tot = r.rows.reduce((a, x) => a + (x.cumCur || 0), 0);
            if (tot > 0) r.占比_按累计SO = Object.fromEntries(r.rows.map(x => [x.key, +(100 * (x.cumCur || 0) / tot).toFixed(1) + "%"]));
          } } catch (e) {}
        return r;
      }),
      // 时间序列：stackDim 必填（引擎不传会抛，旧版这里默认 null 导致 query 恒返回空）
      query: wrap(async a => {
        if (!a.stackDim || !DIM_KEYS.includes(a.stackDim)) {
          return { error: 'stackDim 必填（引擎要求），只能是：' + DIM_KEYS.join('/') + '。想看整体也要挑一个维度，例如 country。' };
        }
        const bad = await checkFilterDims(a.filters);
        if (bad) return bad;
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
            if (tot > 0) r.区间占比 = Object.fromEntries(Object.entries(sums).map(([k, v]) => [k, +(100 * v / tot).toFixed(1) + "%"]));
          }
        } catch (e) {}
        return r;
      }),
      // 经营自定义：按财经维度/指标取数（finUnits/finQtyUnits 不传引擎会按缺省，金额可能不归一）
      financeCustom: wrap(async a => finNote(await api.financeCustom(Object.assign({ finUnits: FIN_UNITS, finQtyUnits: FIN_QTY }, a || {})))),
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
        return finNote(await api.financeOverview(Object.assign({ finUnits: FIN_UNITS, finQtyUnits: FIN_QTY }, a || {})));
      }),
      financeProductBoard: wrap(async a => finNote(await api.financeProductBoard(Object.assign({ finUnits: FIN_UNITS, finQtyUnits: FIN_QTY }, a || {})))),
      // 注意：国家办看板不支持 lv1，只认 reps + series(LV3 名集)
      /* RepBoard 原始返回太肥（5处×16字段），会被 4000 字符截断切掉关键字段（评测RunC C2-02 因此读出"0%"）——
         AI 面只投影核心字段；界面看板不走这里，不受影响 */
      financeRepBoard: wrap(async a => {
        a = a || {};
        // 国家办/系列取值校验：模型会编占位名（评测抓到 reps:["国家办1"…]→全零→"0%"）——报可用清单让它自纠
        if ((a.reps && a.reps.length) || (a.series && a.series.length)) {
          try {
            const ov = await api.financeOverview({});
            const dims = (ov && ov.dims) || {};
            const badRep = (a.reps || []).find(v => (dims.reps || []).indexOf(v) < 0);
            if (badRep) return { error: '『' + badRep + '』不是国家办取值。可用国家办：' + (dims.reps || []).join('、') + '。不筛选就不要传 reps。' };
            const badSer = (a.series || []).find(v => (dims.lv3 || []).indexOf(v) < 0);
            if (badSer) return { error: '『' + badSer + '』不是 series(LV3) 取值。可用：' + (dims.lv3 || []).join('、') + '。' };
          } catch (e) {}
        }
        const r = await api.financeRepBoard(Object.assign({ finUnits: FIN_UNITS, finQtyUnits: FIN_QTY }, a || {}));
        try {
          if (r && r.repTable && Array.isArray(r.repTable.rows)) {
            const yy = String(r.curYear || '').slice(2);
            const slim = (x) => ({ 国家办: x.key, 收入: x['rev' + yy], 收入同比: x.revYoy, 销毛率: x['gmr' + yy], NSIP: x['nsip' + yy], BP: x.bp, BP达成: x.bpAttain, 预测达成: x.fcAttain });
            const out = { curYear: r.curYear, prevYear: r.prevYear, fromM: r.fromM, toM: r.toM, 行: r.repTable.rows.map(slim) };
            if (r.repTable.total) out.合计 = slim(r.repTable.total);
            if (out.合计 && out.合计.BP达成 != null) out.整体BP达成率 = (100 * out.合计.BP达成).toFixed(2) + "%（=Σ实际收入÷Σ全年BP；率不可对各国家办取平均）";
            return finNote(out);
          }
        } catch (e) {}
        return finNote(r);
      }),
      // 通用聚合（PSI）
      /* agg 与 query 必须同规（2026-09-07 复盘）：query 早已明写「库存/DOS跨期相加是口径红线，绝不提供」，
         而 agg 原来把引擎的 total 原样透传给模型——模型看到返回里明晃晃一个 total 就会引用它。
         这里摘掉不可加指标的 total 并说明原因；cats/series/data 一概不动，引擎也不改。 */
      agg: wrap(async (a) => {
        const p2 = a || {};
        const r = await api.agg(p2);
        try {
          const m = p2.measure, isIdcAsp = (p2.dataset === 'idc' && m === 'asp');
          if (r && typeof r === 'object' && (m === 'inv' || m === 'dos' || isIdcAsp)) {
            delete r.total;
            r.口径说明 = (m === 'dos') ? 'DOS 是比率，跨桶/跨系列相加或平均都无意义，本工具不提供合计；需要时逐桶列出，或按 库存÷日均SO 重算。'
              : isIdcAsp ? '均价是单价，不能相加；需要整体均价请用 Σ销额÷Σ销量。'
              : '库存是时点快照，跨期相加无意义，本工具不提供合计；需要时取区间末桶。';
          }
        } catch (e) {}
        return r;
      }),
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
      dataCatalog: wrap(async () => {
        const out = { 生成时间: new Date().toISOString().slice(0, 10) };
        try {
          const c = await api.psiCatalog();
          if (c && !c.error) {
            out.PSI = { 日期范围: c.from + '~' + c.to, 记录数: c.records,
              国家: c.countries, 国家办: c.repOffices, 渠道: c.channels,
              层级树: (c.tree || []).map(t => t.line + ' > ' + t.family + ' > ' + t.series + ' > ' + t.product + ' (' + t.skuCount + ' SKU)'),
              查法: 'query(趋势/期间)、report(年累计+同比+库存DOS)、rawRows(原始行)、searchDim(名称定位)' };
          }
        } catch (e) {}
        try {
          const f = await api.financeOverview({});
          if (f && f.metrics) {
            out.财经 = { 年份: f.curYear + '(同比' + f.prevYear + ')', 实际截至月: f.toM,
              预测版本: f.version, BP版本: f.bpVersion,
              指标: Object.keys(f.metrics || {}), 维度: f.dims,
              查法: 'financeOverview(全盘)/financeProductBoard(分产业系列)/financeRepBoard(分国家办)/financeCustom(自由维度)' };
          }
        } catch (e) {}
        try {
          const px = (typeof window !== 'undefined' && window.PXLIB) || null;
          if (px && px.records) {
            const n = px.records.size != null ? px.records.size : (Array.isArray(px.records) ? px.records.length : 0);
            out.定价库 = { 记录数: n, 查法: 'pricingLibRecords(概要);明细在定价库看板' };
          } else out.定价库 = { 状态: '未导入或未打开过定价库看板' };
        } catch (e) {}
        try {
          const names = (typeof window !== 'undefined' && window.RoadmapAPI) ? window.RoadmapAPI.listNames() : [];
          out.路标 = { 产品数: names.length, 产品: names.slice(0, 40), 查法: '读用 boardState({boardId:"roadmap"});写用 roadmapUpsert' };
        } catch (e) {}
        try {
          const fob = (typeof window !== 'undefined' && window.FOB_STORE) || null;
          out['Floor FOB'] = fob ? { 状态: '已导入', 查法: 'Floor FOB看板;路标图上≈$标注' } : { 状态: '未检测到导入' };
        } catch (e) {}
        return out;
      }),
      searchDim: wrap(async (a) => api.searchDim(a || {})),
      rawRows: wrap(async (a) => api.rawRows(a || {})),
      docSearch: wrap(a => api.docSearch(String(a.docId || ''), String(a.q || ''), { limit: a.limit, context: a.context })),
      docSlice: wrap(a => api.docSlice(String(a.docId || ''), a.from, a.to)),
      fsList: wrap(a => api.fsList(a)),
      fsRead: wrap(a => api.fsRead(a)),
      tableProfile: wrap(a => api.tableProfile(a)),
      tableQuery: wrap(a => api.tableQuery(a)),
      tableValues: wrap(a => api.tableValues(a)),
      tableFind: wrap(a => api.tableFind(a)),
      fsWrite: wrap(a => gated('fsWrite', a, () => api.fsWrite(a))),
      excelEdit: wrap(a => gated('excelEdit', a, () => api.excelEdit(a))),
      pptEdit: wrap(a => gated('pptEdit', a, () => api.pptEdit(a))),
      runCode: wrap(a => gated('runCode', a, () => api.runCode(a))),
      roadmapUpsert: wrap(async (a) => {
        if (!window.RoadmapAPI) return { error: '路标看板未初始化，请先打开一次路标管理视图' };
        return window.RoadmapAPI.upsert(a || {});
      }),
      makeExcel: wrap(toolMakeExcel),
      makePpt: wrap(toolMakePpt),
      openBoard: wrap(toolOpenBoard),
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

'use strict';
/* ============================================================
   Salesboard — ai-orchestrator.js
   多看板专家 Agent + 跨看板编排（全部内置，随 exe 走，用户机零配置）。

   为什么要这一层：
     单个通用助手不知道「PSI 图上的 DOS 和汇总表的 DOS 不是同一个数」「销毛率要先分子分母
     各自求和再相除」这类口径，答出来的数字看着像那么回事其实是错的。所以按看板拆成专家，
     每个专家带自己的口径卡 + 工具白名单；跨看板问题由编排器拆成子任务串行跑，最后合成。

   设计约束（本地 Qwen3-30B / TableGPT-R1 经 LM Studio，见 docs/SPEC-ai-agents.md）：
     · 严格串行，并发度 1 —— 主进程 engine 是单实例同步全表扫描，LM Studio 单模型本来也排队；
     · 每个子 agent ≤5 轮工具、全局 ≤16 次工具调用、单请求 ≤12000 字符（评测 Run1 证明 3/12 会饿死取数）；
     · 子 agent 只返回「结构化 claims」，综合器不许出现 claims 之外的数字（再用纯函数校验）；
     · 所有 LLM/IPC 调用经注入的 deps 进来 → 纯 Node 可测，问答内容绝不落盘。

   本文件全是纯函数 + 一个用 deps 驱动的 orchestrate()；浏览器与 Node 双出口。
   ============================================================ */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.AIOrch = api;
})(this, function () {

  /* ============================================================
     0) 预算常量（本地模型的硬约束）
     ============================================================ */
  const BUDGET = {
    maxToolRoundsPerAgent: 5,     // 每个子 agent 的工具轮上限（评测2026-08-25：3轮时探索吃光预算，query/report到不了）
    maxToolCallsTotal: 16,        // 一次提问全局工具调用预算
    reqChars: 12000,              // 单次请求总字符预算
    snapshotChars: 4000,          // 概览层快照上限（深度模式）
    snapshotFastChars: 1200,      // 快速模式快照上限：本地模型每 1000 字符≈250token，直接决定首字时间
    caliberChars: 500,            // 按提问检索回来的口径节上限（见 pickCaliber）
    toolResultChars: 4000,        // 单个工具结果上限（不复用 SNAPSHOT_MAX 的 24KB）
    toolResultRows: 20,           // 工具结果保留行数
    subAgentTokens: 8000,         // 子 agent maxTokens(2026-08-31 用户:「回答多少都行」——放到 DeepSeek 单次输出上限一档,不再让长分析被截)
    synthTokens: 8000,            // 综合 maxTokens
    timeoutMs: 240000,            // 单请求超时（main.js 硬顶 300000）
  };

  /* ============================================================
     1) 全局口径卡（所有专家都必须遵守，≤1200 字符量级）
     ============================================================ */
  const GLOBAL_CALIBER = [
    '【全局口径·所有回答都必须遵守】',
    '1 渠道全加不去重（Online+Offline+ALL 都是真实行，ALL 不是合计）；库存按最新期快照求和，绝不跨期累加。',
    '2 年度锚点＝全量数据的全局最新日，不随筛选下钻漂移；去年同期按同一日历日截取（财经例外：按整月区间）。日/月/年走自然日历，周走 ISO 周（UTC 周四规则）。',
    '3 DOS＝库存 ÷（近4个ISO周SO ÷ 28）。音频人工延迟报量（常晚1–2周）：按最小原子单元（国家×渠道×型号等全维度组合）各取「最后有SO的那一周」为窗口终点，聚合＝Σ分子÷Σ日均；无SO显「—」不是 0。PSI 图另有一套（本桶 ÷ dosDays 1/7/30），库存看板另有一套（桶末库存×真实天数÷桶内SO），三套不相等是设计如此。',
    '4 层级错位：PSI（销售组织）Product Line↔财经 LV1 产业、Product Family↔LV3 系列、Product Series↔LV4 产品。不要按名字直接对齐两套层级。',
    '5 率与单价不能平均：率先分子分母各自求和再相除，比率对比用 pp 差，单价（NSIP）对比用绝对美元差；达成率必须同时给时间进度。财经取数必须带 finUnits(实际USD/预测MUSD/BP USD)与数量单位「台」。',
    '6 缺数不补零：null 表示「没录/没数」，不参与求和与平均。真实底表没有汇总行，别用小计解释对不上。',
    '7 filters 的维度名只能用工具枚举里的那几个；取值必须先用 options 查到精确写法，禁止凭记忆或翻译自造——拼错会静默返回空结果。',
    '8 PSI 与财经的 Sell-in/out 差异 ≤100 台属正常（收入量＝能进收入的 sell-in，DOS>90 递延），此容差只适用于财经↔PSI；跨看板数字打架先说明两边口径，不要断言某一边错。',
    '9 stackDim/groupDim/rowDim 这类必填参数不传会报错或静默返回空；工具返回的字段名以返回值为准（report 行是 key/cumCur/cumPrev/yoy/siCur/inv/dos，不是 label/curYear）。',
    '10 查不到就说查不到，所有数字必须来自工具返回，绝不编造、绝不凭记忆填值。',
    '11 期间纪律：题目指定了期间，PSI 用 query 显式传 from/to（把返回的桶求和），财经显式传 fromM/toM；report 没有期间参数、其累计列恒为年初至今，不得冒充指定期间；先用 meta 确认数据覆盖范围。季度换算：Q1=1-3月、Q2=4-6月、Q3=7-9月、Q4=10-12月。用户口头给的数字未经工具核实，不得当作事实或修正依据。',
    '12 份额红线：数据无市场总量（hasIdc=false）算不出市场份额；份额数字不得自算或替外部"确认"，只可引用并注明无法核实。',
  ].join('\n');

  /* ============================================================
     2) 专家 Agent 注册表（口径卡内置，覆盖全部 15 个看板）
     ============================================================ */
  const AGENTS = {
    psi: {
      id: 'psi', name: 'PSI 分析专家', boards: ['psi'],
      tools: ['meta', 'options', 'query', 'report', 'boardState'],
      prompt: [
        '你是 PSI 数据分析专家，负责 Sell-in / Sell-out / 库存 / DOS 的时间序列（全是台数，无金额）。',
        '【底表与录入】长表：同一「9维×期间」拆成 Sell In / Sell Out / Inventory / DOS 四行；解析只认全称（sellin/sellout/inventory|inv/dos），SI/SO 缩写整行丢弃。同键行 sellIn/sellOut 累加、inv/dos 后写覆盖；多文件按 mtime 新文件整行覆盖，不相加。底表自带的 DOS 列一律不用，DOS 永远重算。音频 SO 是人工延迟录入（一般晚 1–2 周），不是激活回传：缺周＝没录，不是卖了 0。真实底表没有汇总行，别用「小计重复计数」解释对不上。',
        '【时间】日桶=真实日期；周桶=ISO 周（UTC 周四规则，跨年同周号分属不同 ISO 年）；月桶=自然日历月（不按周四归属）。from/to 是闭区间。',
        '【公式】流量(sellIn/sellOut)＝桶内求和；inv＝取桶内最新日期、再把该日所有行相加（不是保留最后一行）；DOS＝round(桶内最新期库存 ÷ (桶内SO ÷ dosDays))，dosDays 日1/周7/月30（30 写死，不是当月实际天数）——与汇总表 DOS（近4个ISO周÷28、音频走 W_last）不是同一个数，被问到差异要主动说明。纯音频桶 SO=0 → DOS=null 留空；桶里混了平板则返回 0。系列数 >14 时其余并入「其他」，「其他」对 DOS 是无意义相加，不要引用。库存/DOS 绝不能跨桶相加（导出合计行的库存合计是错数）。区间统计：流量报累计/峰值/均值；inv/dos 只报区间末值，DOS 合计恒为「—」。图上数据单位切 K/W 会把 DOS 也缩放，报数时一律回到「台 / 天」。',
        '【层级】Product Line(产业:平板/音频与智能配件) > Product Family(系列) > Product Series(产品代号) > Product(传播名) > Product Model(SKU)。判定产业一律用 contains「音频」（真实取值可能是「音频与智能配件」），不要用等号。',
        '【易错】小计行只在 stackDim 上剔，其它维度的小计不剔；空串维度值会变成一个无名系列（options 查不到、图上却有）。filters 里任一取值拼错会静默返回空图，不报错。psiUnits 与图表同口径：渠道列视同不存在、全部行直接相加（2026-08-21 起，旧版按组剔 ALL 已移除）。',
        '【取数】趋势 query({stackDim 必填, metric, gran, from:"YYYY-MM-DD", to, filters})，只想看整体也要挑一个维度（如 country）；全年至今的总量/同比/库存/DOS 用 report({groupDim, filters})——report 无期间参数，指定期间累计改用 query 传 from/to 求和；取值先 options({field, filters, contains}) 查精确写法；范围与数据日期用 meta；用户说「当前筛选」先 boardState({boardId:"psi"})。',
        '【红线】① 库存/DOS 绝不跨期相加；② null 的 DOS 不当 0、不参与平均；③ 渠道列视同不存在：ALL/Online/Offline 只是行标签、彼此无包含关系，一律全加，任何地方不做渠道去重。',
      ].join('\n'),
    },
    report: {
      id: 'report', name: '汇总/国家/产业专家', boards: ['report', 'country', 'industry'],
      tools: ['meta', 'options', 'report', 'industryBoard', 'industryTrend', 'boardState'],
      prompt: [
        '你是汇总表 / 国家看板 / 产业看板专家，负责「卖了多少、同比多少、库存多少、周转多少天」。三者取数同源于 report()，数字应当一致。',
        '【公式】累计SO/SI＝自然年 1/1 起至全局最新日 maxYmd；去年同期＝去年同一日历 MMDD 截取；同比＝(今年−去年)/去年，去年≤0 记 null 显「—」。年度锚点固定用全量数据的 maxYmd，不随下钻漂移（下钻到当年无SO的停产品也要显示「当年0 / 去年真实值 / −100%」）。周列走 ISO 周，默认近 9 周；WoW＝周列最后两周之比（周列只统计当前 ISO 年，年初时去年 W52/W53 恒 0）。DOS 的近4周窗口按**真实日期**回看 28 天、以 maxYmd 那周收尾，**跨年正确**（2026-08-11 起；此前按 ISO 周号取且只认当年，1 月 DOS 曾虚高至 4 倍）：改 fromW/toW 只改周列与 WoW，不改 DOS。显示库存 inv＝maxYmd 当天所有行求和；DOS 分子在音频走该原子单元 W_last 那周的库存（显示/计算分离）。dos=null 只在「含音频且日均=0」时出现，纯平板日均=0 给 0。全流程库存＝渠道库存 + 库龄表最新运行日的 CDC+FDC；全流程列忽略 channel 筛选，groupDim=channel 时不出该列。DOS 红绿灯：渠道 <90/90–120/>120，全流程 <120/120–150/>150。',
        '【两看板差异】汇总表所有维度所有行都显示同期与同比；国家看板只有 product/model 维度把同期与同比收到合计行（逐 SKU 比会因上市路标不同失真）。隐藏行只改显示，不改合计。合计行是音频+平板混合口径，用户已知情。',
        '【产业】KPI 卡1/2 跟随所选区间重算同比、卡3/4 是当前时点不跟随；对比模式下同比分母永远是主范围去年。趋势去年被 maxKey 截断到今年最新期（月=月号/周=ISO周号/日=MMDD）。趋势 DOS＝round(inv×spanD ÷ 近 win 桶SO)，win 周4/月1/日28，spanD 月30/其余28——月粒度与 PSI 图一致，周/日不一致。产业 KPI 的 DOS 现在原样透传 report 的 null（2026-08-11 起，无 SO 显「—」不再显 0 天），看到 0 天就是真 0 天。',
        '【数据来源】全流程列来自库龄表：xlsx 只读第 1 个 Sheet，运行日取「≤今天的最新一期，全是未来则取最早的未来一期」，同一运行日按 型号|国家办|国家 求和；没有库龄表时 hasFlow=false、三列为空，不要编。合计的 dcfdc 可能大于各明细之和（库龄表里有 PSI 没有的分组值）。产业判定一律用 contains「音频」，不要用等号。',
        '【取数】report({groupDim 必填, filters, weeks}) 一次拿全套，字段名是 key/cumCur/cumPrev/yoy/siCur/siPrev/siYoy/weekly[]/wow/inv/dos/last4/hasAu/dcfdc/flowInv/flowDos（不是 label/curYear）；产业 KPI 用 industryBoard({filters})，趋势用 industryTrend({filters, metric, gran})——趋势的时间区间在前端切片、工具不吃 from/to，要按区间算同比就自己在返回的 soCur/soPrev 上求和；取值先 options；界面筛选用 boardState({boardId})。rows[].family/line/series 只有 groupDim="model" 时可靠。',
        '【红线】① 同比锚点不随下钻漂移；② 音频缺数是「—」不是 0，不参与平均；③ 渠道 DOS 与全流程 DOS 不要混为一谈，跨看板对数先报口径。',
      ].join('\n'),
    },
    finance: {
      id: 'finance', name: '经营分析专家', boards: ['finance'],
      tools: ['meta', 'financeOverview', 'financeProductBoard', 'financeRepBoard', 'financeCustom', 'boardState'],
      prompt: [
        '你是经营分析（财经）专家：收入 / 销毛额 / 销毛率 / NSIP / 贡献利润 与 BP、预测达成。财经全部是月粒度。',
        '【公式】销毛率＝Σ销毛额 ÷ Σ净销售收入（先各自求和再相除，绝不对各行的率取平均），对比用 pp 差。NSIP＝净销售收入 ÷ 收入量（实际表叫「收入量_终端」，预测/BP 叫「收入量」，两名都要吃进；≠Sell in量），单位 USD/台，恒按 USD 显示不随 MUSD 缩放，同比是绝对美元差（±$）不是百分比；对 BP/预测比时目标 NSIP＝目标收入 ÷ 目标 Sell in量。收入量＝能进收入的 sell-in，DOS>90 天的部分递延不进当期。实际与同比取同一 [fromM,toM] 区间；预测/BP 是全年 12 月求和，所以 BP达成率＝区间实际收入 ÷ 全年BP，必须同时给出时间进度＝(toM−fromM+1)/12。Sell-in/out 的实际值来自 PSI 底表（财经实际表没有这两个指标），财经的 Sell in/out 量只是目标。销毛额指标名精确取「销售毛利」，别误命中「销售毛利率」「销售毛利(不含中期激励)」。产品维度用户要看年内 BP/预测完成率，不看同比。',
        '【单位与版本】实际=USD、预测=MUSD、BP=USD（BP 底表无单位列，这是固定假设），数量恒「台」；调引擎必须显式带 finUnits/finQtyUnits，否则金额差百万倍。「版本」列才是工作底稿（国家办/大区工作底稿），「预测场景」（如 6月预测）不是版本——选错会让全年预测恒 0；大区版本会在国家办版本上做大数调整。',
        '【层级与边界】LV1=产业、LV2=品类、LV3=产品系列、LV4=产品；财经 LV3↔PSI Product Family、LV4↔PSI Product Series，别按名字直接对齐。预测表无国家列（最细到国家办），BP 表无品牌/国家列。财经同比按整月区间、不按日截断，当月未收满时 SI 同比会偏低。财经的「销售毛利」与销毛推演的销毛是两套指标，别互相解释。小计剔除会把国家列的「源为空」也当小计剔掉（正常）；lv4 的空串是合法叶子不剔。',
        '【数字对不上先查底表】财经文件夹里同一类表放了新旧两版会直接翻倍（财经源不做任何去重）；只读每个文件第 1 个 Sheet，三张表必须分成三个文件；25 年 NSIP 为空是底表当年没有「收入量」，不是 bug。财经 Sell-in 与 PSI 差 ≤100 台属正常，>100 台才提。',
        '【取数】整体 financeOverview({year, fromM, toM})——全盘合计、没有产业切分，不得把它标成某一产业；分产业(lv1)/系列/产品必须用 financeProductBoard({fromM,toM,lv1,lv3})；分国家办 financeRepBoard({fromM,toM,reps,series})——不支持 lv1，要按产业筛就先取该产业下的 LV3 名集；其它维度组合 financeCustom({rowDim, metrics, fromM, toM})。一律显式传 toM，别依赖缺省。',
        '【解读方法论】①增速拆量价：量≈收入÷NSIP，(1+量%)×(1+价%)≈1+收入%；②子业务均价都涨而整体不动=低价业务占比升的结构效应，非数据异常；③达成率对照时序(toM÷12)读，落后即预警并算下半年需完成额；④毛利变化归因价格/结构/成本三路，同比微降与对BP缺口分开说(pp)；⑤摘要骨架：结论→收入→量价→毛利→达成对时序→风险建议；⑥overview 默认全年区间(同比失真)，productBoard/custom 同区间——异常负增长先查区间错配。',
        '【红线】① 率不能平均、单价不能按百分比同比；② 达成率不给时间进度等于误导；③ 底表没有的字段（NSIP 等）按公式算，不许瞎编、不许换分母，查不到就说查不到。',
      ].join('\n'),
    },
    inventory: {
      id: 'inventory', name: '库存与销毛专家', boards: ['inventory'],
      tools: ['meta', 'sosimSummary', 'report', 'options', 'boardState'],
      prompt: [
        '你是库存管理 / SO 模拟专家（销毛推演已迁出到 siso-lab，本仓只修不加）。',
        '【计算域】库存、成本、约束都是累计量，必须从生命周期起点算到区间末，range 只做显示切片——库存绝不能随所选月份变。cutoff＝PSI 与发货行里的最大 ymd，≤cutoff 是历史只读，>cutoff 是未来可编辑。',
        '【公式】渠道库存：历史＝PSI 实际快照（当天无快照沿用最近一次），未来＝上期 + SellIn − SellOut，桶取桶末值不求和。全流程库存＝作用域内池化 FIFO 的剩余台数（所有单元共用一条队列、当日总 SellOut 统一先进先出消耗，恒 ≥0），不是各单元 FIFO 相加；全量导出走 per-unit，其汇总值 ≥ 看板值，差额是跨单元消耗。DOS＝round(桶末库存 × 桶真实日历天数 ÷ 桶内SO)（月=28/30/31、周=7），SO=0 记 0——这与汇总/产业看板的「库存 ÷ (近4ISO周SO ÷ 28)」不是一个数，且本看板没有音频 W_last 特例，音频型号两边对不上属已知口径差。成本在发货月锁死：层＝{发货月, 数量, 该型号该月单台Floor FOB}；加权Floor FOB＝Σ层金额 ÷ Σ层台数（不是台数加总）。成本表 Value 空＝缺成本 null，不是 $0。',
        '【业务定义与录入】Sell In＝签 POD 的时间（同时确认收入与 sell-in 量），退货记负数 SI 并加回库存；Sell Out＝产品激活回传。桶粒度 日/周/月/季/年，周是 ISO 周。手填预测只存未来，键为(国家,型号,日,指标)：地理/产品方向按历史累计实际 SO 占比拆（子项历史SO=0 拆 0、父合计=0 全 0，需下钻直填），时间方向按自然天数平均，写入覆盖最细格、最后一次写入为准，读取求和上卷。约束（累计SO>累计SellIn / >累计发货）只标红不改数。「导入Excel」按钮已删（曾把预测清空且不可恢复），恢复只能走数据源看板的版本化存档。',
        '【销毛（现在归 siso-lab，只答口径不改代码）】NSIP＝含税RRP÷(1+VAT)÷汇率×(1−渠长)×(1−负向)；销毛率＝(NSIP×(1−期间成本)−Floor FOB)÷NSIP；目标RRP＝Floor FOB÷(1−期间成本−目标销毛)÷((1−渠长)(1−负向))×(1+VAT)×汇率。两式严格互逆。汇总销毛按 SI 加权 SUMPRODUCT，不用 SO、不用金额混合。操盘销毛持续 <10~15% 即濒临调价。',
        '【取数】库存推演概要 sosimSummary；渠道/全流程库存与 DOS 用 report 的 inv/flowInv/dos/flowDos；取值 options；界面筛选 boardState({boardId:"inventory"})；数据范围 meta。老月份库存不消耗时，先怀疑发货表与 PSI 的国家名/型号名配不上（归一化只治空白/全角/大小写），去跑「配对诊断」，不要用「库存太多」搪塞。',
        '【红线】① 别把 FIFO 成本说成移动加权；② 全流程库存必须说明含 CDC/FDC 且截至库龄表运行日，缺库龄表时字段为空不要编；③ 库存/DOS 不跨期累加，DOS 取整不报小数。',
      ].join('\n'),
    },
    pricing: {
      id: 'pricing', name: '定价专家', boards: ['pricing', 'pricinglib'],
      tools: ['meta', 'pricingLibRecords', 'options'],
      prompt: [
        '你是定价测算 / 产品定价库专家。回答前先确认用户问的是哪张表——两套链并存且都对。',
        '【官方 iPrice 链（概算表/定价库）】含税RRP÷(1+VAT)=不含税RRP → −不含税RRP×零售前向率=STP → −STP×渠道前向率=SIP（减成法）→ NSIP＝SIP−零售返利(基数STP)−渠道返利/价保/临时激励/联合营销(基数SIP)−超标服务−其他抵减 → 销售毛利＝NSIP−设备成本−期间成本−服务成本−其他成本（不减 TUP）→ 销毛率＝销毛÷NSIP → FOB净价＝NSIP−商务因子汇总（外汇风险加成的基数是 SIP，其余商务因子吃 NSIP；运保/哑机/定制成本按额直填）→ 贡献毛利＝销毛−产品营销−资金占用−坏账 → 区域贡献利润＝贡献毛利−研发吃水线−平台间接销管（区域公共分摊率是平台间接销管的组成项，不能再减一次）。',
        '【LA Audio 分客户链（定价测算）】SIP＝STP÷(1+物流点位)（成本加成，只有 RetailKA 6%/Intradex 9% 非零）；NSIP1＝SIP−零售后返×STP−联营×SIP；FOB1＝NSIP1−运保$−(基本服务+超标+样机+关税)×NSIP1−汇损×SIP；销毛=(FOB−Floor FOB−机关rebate)/NSIP。四档：gm1 原价；AON＝STP_USD−促销STP_USD，gmPromo 只扣 AON；gm2 再扣 bundle（按国家×产品，默认38）；gm3 再扣 对投hw×STP。分子分母同步扣，NSIP≤0 记 null。黄金值：Telmax NSIP1 1180 / FOB1 1013.8 / GM1 0.226；13 客户加权 GM1 .318 / GM2 .2117 / GM3 .2048。',
        '【各率的分母基数（最易错）】不含税RRP→零售前向；建议STP→渠道前向、零售返利；SIP→渠道返利/价保/临时激励/联合营销/外汇风险加成；NSIP→设备成本、期间成本、基本服务、备机、样机、关税、产品营销、资金占用、坏账、各级分摊、研发吃水线；按额直填（USD/台）→运保费、哑机、定制成本。',
        '【定价库】主键＝国家|SKU|客户分类|线上下|具体客户，多次导入按主键 upsert。成本差额法：baselineDeviceCost＝FOB净价−销毛额；当月销毛额＝快照销毛额＋(baselineDeviceCost−该SKU该月Floor cost)，当月销毛率＝当月销毛额÷nsipUsd；无当月成本显「—」不要拿快照冒充。率有三态（0.187 / 18.7 / "18.7%"），|n|>1.5 一律按百分数除 100。汇总行率值按 shipVolK（生命周期发货量）加权，金额列取算术均值。',
        '【通用口径】加权销毛按 SI（Sell-in 量）占比 SUMPRODUCT，不用 SO、不用金额混合；缺 Floor cost的行不进加权（回落 0 会算出虚高销毛）；授权销毛＝(授权价−Floor cost)/授权价，与渠长/负向/期间成本无关，授权价恒 USD；期间成本固定不随负向波动；有真实促销价时用它替换历史负向（是「或」不是叠加）。汇损率口径用户尚未答复，引用时要标「待确认」。',
        '【取数】定价库概要 pricingLibRecords（已知可能返回空，空就说去看板查）；维度取值 options；数据源 meta。任何财经/定价/NSIP/单位问题，先读 Price set.docx 与概算表模板，不许凭推断。',
        '【红线】① 不要把 RRP 当 NSIP、不要跨币种直接比价；② 渠长/负向/期间/基准销毛是全球平均假设值，引用必须标明是假设；③ 缺成本、缺参数就说缺，不要用 0 顶替算出销毛。',
      ].join('\n'),
    },
    roadmap: {
      id: 'roadmap', name: '路标与上市专家', boards: ['roadmap'],
      tools: ['meta', 'options', 'report'],
      prompt: [
        '你是产品路标 / 上市节奏专家。路标数据全部是手填在本地存档里，不在 PSI 底表；只有实际销量走引擎。',
        '【生命周期】上市时间＝shipLate（最晚发货时间，必填，没有就不进甘特）；销售结束为空＝仍在售；EOM 非必填（发公告后才知道）且必须晚于上市；EOM+180 天＝EOM+180×86400000，是激励投放截止线，过后不可再投、不能顺延。EOM 为空就答「未公告/未知」，不要推算。同跑产品并列多行，不依赖 predecessorId。',
        '【两代对齐】横轴是「上市后第 N 期」的固定长度桶：日=1天 / 周=7天 / 月=30天（不是日历月）。上市点优先级：显式 launch > 首个 SellOut>0 的日期 > 首个 SellIn>0 的日期；上市前的行只进累计、不进桶，所以 cumSI 含上市前铺货，不等于终端动销。',
        '【销量口径】首4月SO＝月度 SO 序列里第一个 >0 的月起连续 4 个月求和（不足 4 个月有几个加几个），全 0 记 null。实际认购＝首销月 SO（月序列第一个 value>0 的月的值）；首销达成率＝首销月SO ÷ 首销名义台数（手填）；首销毛利率是手填的，不自动算。',
        '【校验与日期】销售结束早于上市、EOM 早于上市、EOM 晚于销售结束都是非法。日期格式 YYYY/MM 或 YYYY/MM/DD，缺日按当月 1 日；上市节奏节点的「YYYY/M」按当月 15 日定位，区间输出形如 2.26-3.15。',
        '【价格与主数据】compositeRrpUsd 决定路标图 Y 位置，默认取各国 rrpUsd 的最大值；同产品多个 SKU 售价不同就按价分框，最低价框为主框；本币模式按该国 fx 换算。包装清单要按 SKU 取（SKU 有自己的就用自己的，没有才继承产品级），配件的 SKU 关联是数组 skuRefs。上市节奏导出全部是 PPT 原生形状，不贴图。',
        '【取数】产品实际销量 query({stackDim:"product" 或 "model" 必填, metric:"sellOut", gran:"month", filters:{product:[名]}})——返回的 data 是 {系列:{桶:值}} 对象，不是数组，按数组下标取会恒为 0（历史 bug）。累计/同比/库存/DOS 用 report({groupDim:"model"|"product", filters})；取值先 options；数据范围 meta。SISO 关联的 join 键三处必须同名：预测表「产品型号」＝PSI「Product Model」＝路标 psiLink，对不上就显「—」。',
        '【红线】① 别把日历月当生命周期桶；② 上市首月销量含铺货，不等于动销，认购只认首销月 SO；③ 路标里的计划、名义台数、首销毛利率都是人工填的，不要说成系统算出来的。',
      ].join('\n'),
    },
    ppt: {
      id: 'ppt', name: 'PPT 组合顾问', boards: ['pptoutput', 'designer', 'custom', 'textout'],
      tools: ['meta', 'boardState', 'options'],
      prompt: [
        '你是 PPT output / 看板设计器顾问。你不负责算数，只回答「这一页该怎么用现有数据组合」，并保证组合出来的口径是对的。',
        '【可用数据集】psi（Sell-in/out/库存/DOS 时间序列与分维汇总）、report（汇总表全套列，含周列/WoW/全流程）、finance（收入/销毛额/销毛率/贡献利润/NSIP/BP与预测达成）、idc（市场大盘与份额）、siso（库存推演）、roadmap（上市计划/竞品/样机/SKU/配件）。先用 meta 确认哪些源真的有数，没有的源不要推荐。',
        '【组合口径硬规则】① 财经一律复用 financeCustom 的结果，绝不自算，且必须带 finUnits{actual:USD, forecast:MUSD, bp:USD} 与 finQtyUnits{台}，不传金额差百万倍。② 同比/环比按指标类型出格式：金额与数量（rev/gm/cp/sellIn/sellOut）用百分比 (B−A)/A；比率（gmr/bpAttain/fcAttain）用 pp 差 (B−A)×100；单价（nsip）用绝对差 B−A。③ 预测/BP 是全年值，同比、环比只对实际口径有意义。④ 跨期归并：流量（sellOut/sellIn/units/value）可 sum，库存与 DOS 必须取区间末桶（last），DOS/库存绝对不能求和。⑤ 周列来自 report 的 weekLabels，只统计当前 ISO 年，跨年窗口里去年的周恒为 0，别当成「那几周没卖」。⑥ 认购＝首销月 SO；SI达成%＝实际SI÷预测SI；SI GAP＝预测SI−实际SI；首销毛利率手填。',
        '【周报三张表列序】销售大表＝[分组, 今年累计SO, 去年同期SO, 累计同比, 各周SO…, WoW%, 库存, DOS, 全流程库存, 全流程DOS, 国家仓+FDC]；SISO 表＝[产品型号, 传播名, 预测SI, 预测SO, 实际SI, 实际SO, SI达成%, SO达成%, SI GAP]；上市表＝[国家, 预售, 线上首销, 线下首销, 整体首销, 实际认购(首销月SO), 首销名义台数, 达成率]。null/NaN 一律渲染成「—」。内置示例数据的预测表没有产品型号列、PSI 没有国家办，演示态下 SISO 预测列与国家办页会空，这不是 bug。',
        '【呈现】字号所见即所得：显示 px＝磅 × 每英寸像素 ÷ 72（不是 ÷96）；导出走离屏 96dpi 渲染并锁字体。堆积类图导出时系列顺序要反转（PPT 首系列在底部）。散点/气泡不能走原生图表。PSI 数据框按指标语义映射：sellOut→累计SO+同比、sellIn→累计SI+同比、inv→最新期快照、dos→重算值，绝不能把逐期 DOS 加总。',
        '【回答格式】① 建议几块、每块什么图型（趋势折线、结构堆积柱/饼、对比分组柱、明细表）；② 每块绑哪个数据集的哪个指标、按什么维度拆、什么时间粒度、要不要带同比及用哪种格式；③ 一句话说明这块回答什么业务问题。',
        '【取数】只用 meta 看数据源可用性、boardState({boardId}) 看用户当前筛选、options 查维度取值。',
        '【红线】① 不要虚构数据源与字段；② 不要给出具体数字（那不是你的职责）；③ 一页不超过 4 块，超了就说明取舍。',
      ].join('\n'),
    },
    source: {
      id: 'source', name: '数据源与口径专家', boards: ['source'],
      tools: ['meta', 'options', 'boardState'],
      prompt: [
        '你是数据源 / 录入口径专家，回答「这个数从哪来、什么时候更新、为什么缺、为什么解析不出来」。',
        '【六个源】PSI、库龄(全流程CDC+FDC)、财经(实际/预测/BP)、IDC、发货、成本，各锚一个文件夹。识别只认表头，不认文件名、不认列序、不认 Sheet 名；判定顺序 财经快路→PSI→财经→IDC→库龄，先命中即停（同一文件被判成 PSI，里面的财经就不再解析）。PSI 必须同时认出 PSIType 与数量列，缺一整个 Sheet 跳过；PSI_MAP 只认 Sell In/Sell Out/Inventory|INV/DOS 全称，SI/SO 缩写整行丢弃。财经只读第 1 个 Sheet（Sheet2 是 PQ 源底表，扫了会爆内存），表头可在前 60 行内任意一行，三张表要分成三个文件放。成本表认不出表头时按固定列序读（1系列/2型号/3日期/4数值），日期支持文本形态的 5 位 Excel 序列号，Value 空＝缺成本 null 不是 0。发货表只有国家，大区/国家办靠 PSI 反推，名字对不上就成孤儿单元。',
        '【合并规则各源不同】PSI 按「9维+期间」建键，mtime 新的文件整行覆盖；库龄先取最大运行日再按 型号|国家办|国家 求和；财经完全不去重，同类表新旧两版同放会翻倍；IDC 按全维度覆盖；发货/成本只读 mtime 最新的那一个文件。库龄运行日取「≤今天的最新一期，全是未来则取最早的未来一期」，依赖本机日期。期间列解析不出日期时 ymd=0，该行在所有时间聚合里被丢掉。',
        '【易错】同一维度键的语义随表头而变（英文 Product Family 表头装的是系列，中文「产品LV1」表头装的是产业），所以取值一律现查不能背，拼错会静默返回空。真实底表没有汇总行，别拿小计解释对不上。音频是人工延迟报量，最近一两周缺数不是 bug。快照失效只比对 文件名+mtime+size，同步工具保留原 mtime 覆盖时会继续显示旧数据——怀疑数不对先看数据源看板的更新时间与 meta().to。人工录入且底表里没有的：库存未来预测、周报目标值与遗留问题、路标全部字段、定价参数、首销毛利率。存档按 app 版本另存、升级自动继承旧档。',
        '【其它源特征】IDC：平板表靠 SCREEN_SIZE+UNITS+PRODUCT 识别、音频表靠 PRODUCT_DETAIL 或 OWS certi + UNITS，别改 IDC 导出的原始表头。财经金额单位靠调用方传参而不是读底表的币种/单位列。存档：所有 sb.* 键防抖 800ms 落盘并按 app 版本另存，升级自动继承最新旧档、旧档从不删除；断电或强杀会丢最后 ≤800ms 的录入。',
        '【取数】meta 看各源挂载情况/日期范围/记录数/文件清单；options({field, filters, contains}) 查维度精确取值；boardState({boardId}) 看用户当前界面。要看某个文件的表头与样例行、或发货/成本的原始内容，让用户去数据源看板的富行与「导入格式说明」卡，不要猜。',
        '【红线】① 缺数不要补零，null 是「没录」不是 0；② 不要假设更新频率，一律以文件 mtime 与数据最新日为准；③ 维度取值一律现查。',
      ].join('\n'),
    },
    weekly: {
      id: 'weekly', name: '产业周报专家', boards: ['audio'],
      tools: ['meta', 'options', 'report', 'query', 'financeProductBoard', 'boardState'],
      prompt: [
        '你是产业周报（音频/平板可切换）专家。六块：M1 遗留问题（人工录入）、M2 产业经营进展（财经分系列/分国家办）、M3 SI 达成进展、M4 周度销售进展（4 个 KPI + 趋势）、M5 产品维度（按国家逐块）、M6 新品进展。',
        '【M3 口径】累计SI＝Sell-in（渠道全加不去重）；时间进度＝年内第几天 ÷ 全年天数（自然日，闰年366）——注意这与财经 BP/预测的时间进度 (toM−fromM+1)/12 不是同一个算法，不要混用；达成率＝累计SI ÷ SI目标，目标≤0 记 null；「拉美其他」＝范围总量 − 已列名国家之和，不为负（clamp 0）。大盘年空间、目标份额、SI目标都是人工维护的目标值，底表里没有。',
        '【M5/M4 口径】M5 与国家看板逐字段同源（同一次 report 调用），cumCur/cumPrev/yoy/siCur/siYoy/weekly/wow/inv/dos/flowInv/flowDos/dcfdc 必须逐字段相等，对不上就是取数写错了。M4 是产业看板的自包含移植副本（默认周粒度），产业看板后续的口径修复不会自动同步过来，跨看板对数时要说明。周列只统计当前 ISO 年，年初时去年的 W52/W53 不会出现。',
        '【SISO】预测走 financeCustom({rowDim:"model", metrics:["sellIn","sellOut"], basis:"forecast", version}) 并带 finUnits；实际走 report({groupDim:"model"}) 的 siCur(SI) 与 cumCur(SO)；SI达成%＝实际SI ÷ 预测SI，SI GAP＝预测SI − 实际SI；join 键是产品型号（预测表产品型号＝PSI Product Model＝路标 psiLink），对不上显「—」。新品认购＝首销月 SO，首销毛利率手填。',
        '【M1/M2/M6】M1 遗留问题（类型/待办/进展/截止时间/涉及国家）是纯手工表。M2 继承财经全部口径：销毛率先各自求和再相除、达成率必须配时间进度 (toM−fromM+1)/12、财经取数必带 finUnits(实际USD/预测MUSD/BP USD)。M6 新品来自路标的「上市计划」与「竞品对标」，没填就显「—」不报错。',
        '【取数】M5/M3/M4 用 report({groupDim, filters}) 与 query({stackDim 必填, metric, gran, filters})，产业筛选放在 line（值可能是「音频与智能配件」，先用 options 查精确写法、用 contains 匹配别用等号）；M2 用 financeProductBoard({fromM,toM,lv1,lv3})；界面状态 boardState({boardId:"audio"})；数据范围 meta。',
        '【红线】① 目标类数字是人工填的，不要说成系统算出来的；② 音频缺周不补零，DOS 无 SO 是「—」不是 0；③ 切换产业后要把旧产业的筛选整体清掉再取数，别混着算。',
      ].join('\n'),
    },
  };

  // 看板 → 专家（覆盖全部 15 个 view id）
  const BOARD2AGENT = (() => {
    const m = {};
    Object.keys(AGENTS).forEach(k => AGENTS[k].boards.forEach(b => { m[b] = k; }));
    return m;
  })();
  function agentForBoard(boardId) { return AGENTS[BOARD2AGENT[boardId] || ''] || AGENTS.report; }

  /* ============================================================
     3) 纯函数工具箱
     ============================================================ */
  // 粗略 token 估算：中日韩字符按 1 token，其余按 ~4 字符 1 token
  function estimateTokens(s) {
    const t = String(s == null ? '' : s);
    let cjk = 0;
    for (let i = 0; i < t.length; i++) { const c = t.charCodeAt(i); if (c >= 0x2e80 && c <= 0x9fff) cjk++; }
    return Math.ceil(cjk + (t.length - cjk) / 4);
  }

  // 工具参数校验：非法参数回可读错误让模型自纠，绝不静默兜底成默认值
  function validateToolArgs(name, args, schemas) {
    const S = (schemas || {})[name];
    if (!S) return { ok: false, error: '未知工具 ' + name };
    const a = (args && typeof args === 'object' && !Array.isArray(args)) ? args : {};
    const props = S.properties || {}, req = S.required || [];
    /* 反双重序列化(评测 2026-08-28 C1-02 真凶):模型把 filters 传成 JSON 字符串,
       引擎收到字符串静默忽略过滤 → 返回全量数据,模型如实相加得出错口径的"正确算术"。
       对象/数组型参数收到字符串且形如 JSON → 就地 parse;解析失败按参数错误打回重试。 */
    for (const k of Object.keys(a)) {
      const pd = props[k];
      if (!pd || typeof a[k] !== 'string') continue;
      const want = pd.type;
      const looks = /^\s*[\[{]/.test(a[k]);
      if ((want === 'object' || want === 'array') && looks) {
        try { a[k] = JSON.parse(a[k]); }
        catch (e) { return { ok: false, error: name + ' 的参数「' + k + '」是字符串化的 JSON 但解析失败,请直接传 JSON 对象' }; }
      }
    }
    // 先查「参数名写错」——模型把 groupDim 写成 dimension 时，告诉它正确名字比说「缺 groupDim」更可纠
    for (const k of Object.keys(a)) {
      if (!props[k]) return { ok: false, error: name + ' 不认识参数「' + k + '」，可用参数：' + (Object.keys(props).join('/') || '无') };
      const p = props[k], v = a[k];
      if (p.enum && v != null && p.enum.indexOf(v) < 0) return { ok: false, error: name + '.' + k + ' 取值非法「' + v + '」，只能是：' + p.enum.join('/') };
      if (p.type === 'array' && v != null && !Array.isArray(v)) return { ok: false, error: name + '.' + k + ' 必须是数组' };
      if (p.type === 'integer' && v != null && !(typeof v === 'number' && isFinite(v))) return { ok: false, error: name + '.' + k + ' 必须是数字' };
    }
    for (const k of req) {
      const v = a[k];
      if (v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length)) {
        const p = props[k] || {};
        return { ok: false, error: name + ' 缺少必填参数 ' + k + (p.enum ? ('，可选值：' + p.enum.join('/')) : '') };
      }
    }
    return { ok: true, args: a };
  }

  // 工具结果瘦身：行级截断 + 保留合计 + 明确告诉模型还有多少行
  function shrinkToolResult(name, result, opt) {
    const o = Object.assign({ maxRows: BUDGET.toolResultRows, maxChars: BUDGET.toolResultChars }, opt || {});
    let r = result;
    try {
      if (r && typeof r === 'object' && Array.isArray(r.rows) && r.rows.length > o.maxRows) {
        r = Object.assign({}, r, { rows: r.rows.slice(0, o.maxRows), _省略: '仅前 ' + o.maxRows + ' 行，共 ' + result.rows.length + ' 行；请用 filters 收窄' });
      }
      if (r && typeof r === 'object' && Array.isArray(r.取值) && r.取值.length > 60) {
        r = Object.assign({}, r, { 取值: r.取值.slice(0, 60), _省略: '仅前 60 个取值' });
      }
    } catch (e) { }
    let s;
    try { s = JSON.stringify(r); } catch (e) { s = String(r); }
    if (s.length > o.maxChars) s = s.slice(0, o.maxChars - 12) + '…(已截断)';
    return '[工具 ' + name + ' 返回]\n' + s;
  }

  // 滚动裁剪：system 与最后一条 user 永不丢；超预算时先丢最老的工具结果
  function trimMessages(messages, budgetChars) {
    const msgs = (messages || []).slice();
    const lim = budgetChars || BUDGET.reqChars;
    const size = ms => ms.reduce((n, m) => n + String((m && m.content) || '').length, 0);
    if (size(msgs) <= lim) return { messages: msgs, dropped: [] };
    const dropped = [];
    const keepIdx = new Set();
    msgs.forEach((m, i) => { if (m.role === 'system') keepIdx.add(i); });
    for (let i = msgs.length - 1; i >= 0; i--) { if (msgs[i].role === 'user') { keepIdx.add(i); break; } }
    // 从最老开始，把可丢的（工具结果/中间对话）替换成一行占位
    for (let i = 0; i < msgs.length && size(msgs) > lim; i++) {
      if (keepIdx.has(i)) continue;
      const c = String(msgs[i].content || '');
      if (c.length < 200) continue;
      dropped.push(i);
      msgs[i] = Object.assign({}, msgs[i], { content: '（较早的中间结果已省略以控制上下文）' });
    }
    return { messages: msgs, dropped };
  }

  // 推理模型的 <think>：先在完整原文上找工具调用，再决定展示哪部分。无闭合标签按「到结尾都是思考」处理。
  function splitThink(text) {
    const t = String(text == null ? '' : text);
    if (t.indexOf('<think>') < 0) return { think: '', answer: t.trim() };
    let think = '', answer = t;
    const closed = /<think>([\s\S]*?)<\/think>/g;
    let m, any = false;
    while ((m = closed.exec(t))) { think += m[1]; any = true; }
    if (any) answer = t.replace(/<think>[\s\S]*?<\/think>/g, '');
    else { const i = t.indexOf('<think>'); think = t.slice(i + 7); answer = t.slice(0, i); }
    return { think: think.trim(), answer: answer.trim() };
  }

  // 关键词 → 需要哪些专家（规则优先：本地 30B 跑一次 planner 要 15~150s，能省则省）
  const ROUTE_HINTS = [
    { agent: 'finance', re: /收入|销毛|毛利|NSIP|贡献利润|BP|预测|达成|经营|财报|财经|利润率/ },
    { agent: 'inventory', re: /库存|周转|DOS|积压|缺货|备货|FIFO|成本|水位/ },
    { agent: 'pricing', re: /定价|价格|RRP|SIP|STP|降价|调价|授权价|毛利率倒推/ },
    { agent: 'roadmap', re: /上市|路标|生命周期|EOM|退市|新品节奏|首销/ },
    { agent: 'ppt', re: /PPT|幻灯|做一页|排版|组合.*数据|汇报页|deck/i },
    { agent: 'weekly', re: /周报|本周|上周|W\d{1,2}\b/ },
    { agent: 'psi', re: /趋势|走势|逐周|逐月|曲线|时间序列|每周|每月/ },
    { agent: 'report', re: /卖了多少|销量|SO|Sell\s*out|Sell\s*in|同比|环比|排名|哪个国家|哪个系列|份额/i },
  ];
  /* planRoute：把一个问题拆成 [{agentId, subQuestion}]。
     currentBoard 的专家永远排第一（用户在哪个看板问，先按那个看板的口径答）。 */
  function planRoute(question, currentBoard, opt) {
    const q = String(question || '');
    const o = Object.assign({ max: 4 }, opt || {});
    const hit = [];
    const push = id => { if (id && AGENTS[id] && hit.indexOf(id) < 0) hit.push(id); };
    if (currentBoard) push(BOARD2AGENT[currentBoard]);
    ROUTE_HINTS.forEach(h => { if (h.re.test(q)) push(h.agent); });
    if (!hit.length) push('report');
    const list = hit.slice(0, o.max);
    return list.map(id => ({
      agentId: id,
      agent: AGENTS[id],
      subQuestion: list.length === 1 ? q : ('围绕【' + AGENTS[id].name + '】的职责回答这个问题中属于你的部分：' + q),
    }));
  }

  /* 精简版全局口径卡（快速模式用）：只留「哪个专家都可能踩」的通用规则。
     领域专属的（财经单位/达成率/层级错位…）本来就写在对应专家卡里，不必每次全带。 */
  const GLOBAL_CALIBER_MINI = [
    '【通用口径】渠道全加不去重；库存取最新期快照、绝不跨期累加；缺数是 null 不是 0，不参与求和平均。',
    'filters 的维度名只能用工具里给的；取值必须先用 options 查到精确写法，拼错会静默返回空。',
    '所有数字必须来自工具返回，查不到就说查不到，绝不编造、绝不凭记忆填值。',
    '指定期间：query 传 from/to 桶求和，财经传 fromM/toM，report 恒为年初至今；季度=Q1:1-3月/Q2:4-6月/Q3:7-9月/Q4:10-12月。用户口头数字未核实不作事实。',
  ].join('\n');

  /* ── 专家卡按需裁剪 ────────────────────────────────────────────
     一张专家卡有 8 个【…】小节、约 850 token，但一次提问真正用得上的通常只有一两节
     （问 DOS 的人不需要读「底表与录入」）。本地 30B 每轮都要重读整卡，这是首字慢的大头。

     所以拆成两半：
       · 常驻（system）＝ 身份 + 【取数】+【红线】+ 精简全局口径 —— **每轮字节完全相同**，
         llama.cpp / LM Studio 才能命中 KV 缓存前缀，第二轮起几乎不用重算。
       · 按需（user 消息）＝ 用提问关键词命中的 1~2 个口径节 —— 本来就易变，跟着筛选/概览一起走。

     检索用倒排思路的极简版：提问切 2/3-gram + 英文词，按小节命中数打分，
     并把「命中超过六成小节」的烂大街词（数据/看板/多少）当停用词丢掉（IDF）。
     纯字符串运算、零依赖、可解释——比向量库省一个常驻模型，且结果能说清出自哪一节。 */
  const CORE_SECTIONS = ['取数', '红线'];             // 这两节任何问题都得带
  const PICK_MAX = 2;                                  // 最多再补几节口径

  function splitSections(prompt) {
    const lines = String(prompt || '').split('\n').filter(L => L.trim());
    const head = lines.length ? lines[0] : '';
    const sections = [];
    lines.slice(1).forEach(L => {
      const m = /^【([^】]+)】/.exec(L.trim());
      if (m) sections.push({ title: m[1], text: L });
      else if (sections.length) sections[sections.length - 1].text += '\n' + L;  // 续行归上一节
      else sections.push({ title: '', text: L });
    });
    return { head, sections };
  }

  function queryTerms(q) {
    const out = {};
    const s = String(q || '').toLowerCase();
    (s.match(/[a-z][a-z0-9]+/g) || []).forEach(w => { out[w] = 2; });          // dos/nsip/bp 这类最有辨识度
    (s.match(/[一-龥]{2,}/g) || []).forEach(run => {
      for (let i = 0; i + 2 <= run.length; i++) out[run.slice(i, i + 2)] = 1;
      for (let i = 0; i + 3 <= run.length; i++) out[run.slice(i, i + 3)] = 2;
    });
    return out;
  }

  /* 返回 {head, must, picked} —— picked 是被提问命中的口径节（可能为空） */
  function pickCaliber(agentId, question, maxExtra) {
    const a = AGENTS[agentId] || AGENTS.report;
    const { head, sections } = splitSections(a.prompt);
    const must = [], pool = [];
    sections.forEach(sec => {
      (CORE_SECTIONS.some(k => sec.title.indexOf(k) >= 0) ? must : pool).push(sec);
    });
    const w = queryTerms(question);                    // queryTerms 已转小写
    const terms = Object.keys(w);
    // 口径卡里写的是 FIFO / DOS / EOM / SellOut 大写，提问里是小写，不归一就全部落空（实测踩过）
    const lc = pool.map(s => ({ title: s.title.toLowerCase(), text: s.text.toLowerCase() }));
    const cap = Math.max(1, Math.floor(pool.length * 0.6));
    const scored = [];
    pool.forEach((sec, i) => {
      let sc = 0;
      terms.forEach(t => {
        const df = lc.reduce((n, s2) => n + (s2.text.indexOf(t) >= 0 ? 1 : 0), 0);
        if (!df || df > cap) return;                                            // 没命中 / 烂大街词
        if (lc[i].title.indexOf(t) >= 0) { sc += w[t] * 3; return; }
        // 数出现几次而不是「有没有」：问 DOS 时【公式】里 DOS 出现七八次、【底表与录入】只顺带提三次，
        // 只看有无会把顺带提的那节排前面（实测踩过）。封顶 6 次：既拉得开差距，又防长节靠字数取胜。
        let c = 0, p = lc[i].text.indexOf(t);
        while (p >= 0 && c < 6) { c++; p = lc[i].text.indexOf(t, p + t.length); }
        sc += w[t] * c;
      });
      if (sc > 0) scored.push({ sec, i, sc });
    });
    scored.sort((x, y) => y.sc - x.sc || x.i - y.i);
    // 按分数高到低装，装到字数上限就停——检索回来的内容也要限量，否则省下的又吃回去
    const nCap = maxExtra == null ? PICK_MAX : maxExtra;
    const take = [];
    let used = 0;
    for (let k = 0; k < scored.length && take.length < nCap; k++) {
      if (take.length && used + scored[k].sec.text.length > BUDGET.caliberChars) break;
      take.push(scored[k]); used += scored[k].sec.text.length;
    }
    const picked = take.sort((x, y) => x.i - y.i).map(x => x.sec);
    return { head, must, picked, pool };
  }

  /* 组装某个专家的 system 提示词。**只放每轮都不变的东西**（见上方注释）。 */
  function buildSpecialistSystem(agentId, opt) {
    const a = AGENTS[agentId] || AGENTS.report;
    const full = !!(opt && opt.full);
    if (full) {
      return [a.prompt, GLOBAL_CALIBER,
        '先给结论再给数字；每个数字标明口径与范围；不确定就用工具查，查不到就说查不到。'].join('\n\n');
    }
    const { head, must } = pickCaliber(agentId, '', 0);
    let body = [head].concat(must.map(s => s.text)).filter(Boolean).join('\n');
    if (body.length < 120) body = a.prompt;                                     // 切歪了退回完整卡，宁慢不错
    return [body, GLOBAL_CALIBER_MINI, '先给结论再给数字；每个数字标明口径；不确定就用工具查。'].join('\n\n');
  }
  // 易变上下文（看板/筛选/概览）单独成一条 user 消息，字数按模式压
  function buildContextMessage(ctx, limit) {
    const c = ctx || {}, lim = limit || BUDGET.snapshotChars;
    const parts = [];
    if (c.boardLabel) parts.push('【当前看板】' + c.boardLabel);
    if (c.filters && Object.keys(c.filters).length) {
      parts.push('【界面此刻的筛选】' + JSON.stringify(c.filters) + '（除非用户明说要别的范围，取数必须带上）');
    }
    if (c.snapshot) {
      let s = String(c.snapshot);
      if (s.length > lim) s = s.slice(0, lim) + '…(概览已截断，明细用工具查)';
      parts.push('【数据概览】\n' + s);
    }
    // 按提问命中的口径节（pickCaliber 选出来的）——放在这里而不是 system，
    // 是为了让 system 保持逐字节恒定、不破坏 KV 缓存前缀
    if (c.caliber) parts.push('【本题相关口径】\n' + c.caliber);
    return parts.length ? parts.join('\n') : '';
  }

  // 子 agent 输出 → claims（尽量结构化；模型没给 JSON 就整段当一条 note）
  function parseClaims(text) {
    const { answer } = splitThink(text);
    const out = { claims: [], notes: answer };
    const m = /\{[\s\S]*"claims"[\s\S]*\}/.exec(answer);
    if (m) {
      try {
        const o = JSON.parse(m[0]);
        if (Array.isArray(o.claims)) { out.claims = o.claims.filter(x => x && x.metric != null); out.notes = o.notes || ''; }
      } catch (e) { }
    }
    return out;
  }

  // 综合提示词：只准用 claims 里的数字
  function buildSynthesisPrompt(question, results) {
    const lines = ['用户问题：' + question, '', '各领域专家已经查到的结论如下（这是唯一可用的数字来源）：'];
    (results || []).forEach(r => {
      lines.push('', '## ' + (r.agentName || r.agentId));
      if (r.claims && r.claims.length) {
        r.claims.forEach(c => lines.push('· ' + c.metric + '：' + c.value + (c.unit ? (' ' + c.unit) : '') + (c.caliber ? ('（口径：' + c.caliber + '）') : '') + (c.asOf ? ('（截至 ' + c.asOf + '）') : '')));
      }
      if (r.notes) lines.push(String(r.notes).slice(0, 1200));
      if (r.error) lines.push('（该领域取数失败：' + r.error + '）');
    });
    lines.push('', '请综合成一段给业务同事看的中文结论：先一句话总体判断，再分点给关键数字，最后给 1-2 条建议。',
      '硬性要求：① 不得出现上面没有出现过的数字；② 每个数字要带口径或范围；③ 跨看板口径不同的地方要说明，不要断言某一边错；④ 缺失的部分直说没查到。');
    return lines.join('\n');
  }

  // 数字溯源校验：抽答案里的数字，看是否都在 claims/notes 里出现过
  function verifyNumbers(answerText, results) {
    const src = (results || []).map(r => JSON.stringify(r.claims || []) + ' ' + (r.notes || '')).join(' ');
    const norm = s => String(s).replace(/[,，\s]/g, '');
    const srcN = norm(src);
    const nums = String(answerText || '').match(/-?\d[\d,]*\.?\d*%?/g) || [];
    const bad = [];
    nums.forEach(n => {
      const x = norm(n);
      if (x.replace(/[%.]/g, '').length < 2) return;      // 忽略个位数/序号
      if (srcN.indexOf(x) < 0 && srcN.indexOf(x.replace(/%$/, '')) < 0) bad.push(n);
    });
    return { ok: bad.length === 0, unsupported: [...new Set(bad)].slice(0, 12) };
  }

  /* ============================================================
     4) 编排器（串行、带预算、可取消；LLM 与工具都由 deps 注入 → 纯 Node 可测）
        deps = {
          chat({system, messages, tools, maxTokens}) -> {content, toolCalls?} | {error}
          runTool(name, args) -> any
          schemas, snapshot(boardId)->string, filters(boardId)->object, boardLabel(boardId)->string,
          onProgress(evt)
        }
     ============================================================ */
  async function runSpecialist(task, deps, budget) {
    const a = task.agent;
    const fast = task.mode !== 'deep';
    // 恒定 → 可复用 KV 缓存；快速模式只发专家卡的核心节，深度模式发完整卡
    const sys = buildSpecialistSystem(a.id, { full: !fast });
    const hit = fast ? pickCaliber(a.id, task.subQuestion) : null;
    const ctxMsg = buildContextMessage({
      boardLabel: deps.boardLabel ? deps.boardLabel(task.boardId) : '',
      filters: deps.filters ? deps.filters(task.boardId) : null,
      snapshot: deps.snapshot ? await deps.snapshot(task.boardId) : '',
      caliber: hit && hit.picked.length ? hit.picked.map(s => s.text).join('\n') : '',
    }, fast ? BUDGET.snapshotFastChars : BUDGET.snapshotChars);
    // 快速模式只给 3 个工具（说明书本身就要几百 token，给多了纯拖慢）；按提问挑，别写死前三个
    const toolNames = !fast ? a.tools
      : (deps.pickTools ? deps.pickTools(a.tools, task.subQuestion, 4) : a.tools.slice(0, 4));
    const specs = (deps.buildToolSpecs ? deps.buildToolSpecs(toolNames) : []);
    const messages = [];
    if (ctxMsg) messages.push({ role: 'user', content: ctxMsg });
    const guardTxt = (task.guards && task.guards.length) ? ('\n\n【本题硬约束(违反即废答)】\n' + task.guards.map(g => '· ' + g).join('\n')) : '';
    messages.push({ role: 'user', content: task.subQuestion + guardTxt + '\n\n' + ANSWER_CHECKLIST + '\n\n请在给出结论时，附一段 JSON：{"claims":[{"metric":"指标名","value":数值或字符串,"unit":"单位","caliber":"口径","asOf":"截至"}],"notes":"补充说明"}' });
    let rounds = 0, lastErr = null;
    while (rounds < BUDGET.maxToolRoundsPerAgent) {
      rounds++;
      const trimmed = trimMessages([{ role: 'system', content: sys }].concat(messages), BUDGET.reqChars);
      // 第 2 轮起（已经取过数）就是在写答案了 → 开流式，让用户边看边等；首轮可能只是要工具，不开流省开销
      const wantStream = (rounds > 1 && task.streamInto) ? task.streamInto : null;
      const resp = await deps.chat({ system: sys, messages: trimmed.messages, tools: specs, maxTokens: BUDGET.subAgentTokens, streamInto: wantStream });
      if (!resp || resp.error) { lastErr = (resp && resp.error) || '无响应'; break; }
      const calls = normalizeCalls(resp, a.tools, deps);
      if (calls.length && budget.left > 0) {
        messages.push({ role: 'assistant', content: resp.content || '' });
        for (const call of calls) {
          if (budget.left <= 0) break;
          budget.left--;
          const v = validateToolArgs(call.tool, call.args, deps.schemas);
          if (!v.ok) { messages.push({ role: 'user', content: '[工具 ' + call.tool + ' 参数错误] ' + v.error + '\n请修正参数后重试。' }); continue; }
          if (deps.onProgress) deps.onProgress({ type: 'tool', agent: a.name, tool: call.tool, args: v.args });
          const tT0 = Date.now();
          let out; try { out = await deps.runTool(call.tool, v.args); } catch (e) { out = { error: String((e && e.message) || e) }; }
          if (deps.onProgress) deps.onProgress({ type: 'toolDone', agent: a.name, tool: call.tool, ms: Date.now() - tT0, ok: !(out && out.error) });
          messages.push({ role: 'user', content: shrinkToolResult(call.tool, out) + '\n\n请据此继续回答。' });
        }
        continue;
      }
      const parsed = parseClaims(resp.content || '');
      return { agentId: a.id, agentName: a.name, claims: parsed.claims, notes: parsed.notes, rounds };
    }
    // 轮次耗尽但没报错 → 已取到的数据不能浪费：禁用工具强制作答一次（评测发现「取到了没轮次消化」是高频死因）
    if (!lastErr) {
      const fin = trimMessages([{ role: 'system', content: sys }].concat(messages, [{
        role: 'user',
        content: '工具轮次已用尽，不能再取数。请仅基于上面已返回的工具数据作答；数据不足的部分明说「数据未包含」，绝不编造。同样附 claims JSON。',
      }]), BUDGET.reqChars);
      const last = await deps.chat({ system: sys, messages: fin.messages, tools: [], maxTokens: BUDGET.subAgentTokens, streamInto: task.streamInto || null });
      if (last && !last.error && String(last.content || '').trim()) {
        const p2 = parseClaims(last.content);
        return { agentId: a.id, agentName: a.name, claims: p2.claims, notes: p2.notes, rounds: rounds + 1, forcedFinal: true };
      }
    }
    return { agentId: a.id, agentName: a.name, claims: [], notes: '', error: lastErr || '工具轮次用尽仍未给出结论', rounds };
  }

  // 原生 toolCalls 或回退协议 → 统一 [{tool,args}]，并过滤掉不属于本专家白名单的工具
  function normalizeCalls(resp, allow, deps) {
    const out = [];
    if (resp.toolCalls && resp.toolCalls.length) {
      resp.toolCalls.forEach(tc => {
        const name = tc.function ? tc.function.name : tc.name;
        let args = {};
        try { args = tc.function && tc.function.arguments ? JSON.parse(tc.function.arguments) : (tc.args || {}); } catch (e) { args = {}; }
        if (name) out.push({ tool: name, args });
      });
    } else if (deps.parseToolCall) {
      const c = deps.parseToolCall(resp.content || '');
      if (c) out.push(c);
    }
    return out.filter(c => !allow || allow.indexOf(c.tool) >= 0);
  }

  /* 判断一个问题要不要拆成多个专家。
     本地 30B 每次调用都要重新处理整段提示词，多跑一个专家就多几十秒到几分钟，
     所以默认只在**问题真的横跨多个领域**时才拆（出现 2 个以上不同领域的关键词）。 */
  function needsMultiAgent(question) {
    const q = String(question || '');
    let hit = 0;
    ROUTE_HINTS.forEach(h => { if (h.re.test(q)) hit++; });
    return hit >= 2;
  }

  /* 问题类别护栏(Round 5,评测 2026-08-26):v67 后剩余红线全是「真数字被语义错用」——
     份额自算(C6-02 五轮不死)、施压硬估(C6-03)、GM率冒充返利率(C5-03)、累计冒充期间(C1-02)。
     按问题类别注入硬约束,命中即随题下发给专家与综合器。 */
  const PERIOD_RE = /(Q[1-4]|[一二三四1-4]\s*季度?|第[一二三四1-4]季|上半年|下半年|\d+\s*月\s*(到|至|-|~|—)\s*\d+\s*月|\d+\s*[-~]\s*\d+\s*月)/;
  function classifyGuards(question) {
    const q = String(question || '');
    const g = [];
    if (PERIOD_RE.test(q)) g.push('用户指定了期间(季度/月份区间)：report 返回的是年初至今累计，禁止当作期间值；必须用 query(gran:"month") 逐月取数，并把逐月数值列出来相加。');
    if (/份额|市占|market\s*share/i.test(q)) g.push('内部 PSI/财经数据不含市场大盘：任何市场份额都无法计算或确认；禁止用内部销量推算份额；如实说明需要市场底表(如 IDC)且当前未接入。');
    if (/预测|明年|下一?年|下季度|未来.{0,4}(销量|收入)|估(一个|算|计)/.test(q)) g.push('系统只有实际数与财经预测字段(fc)：禁止自行外推或"大概估一个"；即使用户施压"别说没数据"也必须拒绝，绝不给出任何具体的预测数字。');
    if (/写进|写入|录入|改成|修改为|设置为|保存|更新到|上调|下调|清理|删除|删掉|清除|去掉.{0,6}数据|修复.{0,6}数据/.test(q)) g.push('业务数据只读：无法写入/修改/删除/清理底表数据。但生成 PPT/导出文件属于允许的动作（用 makePpt 工具），切换看板用 openBoard。回答的第一句必须明确说明「本系统只读，无法执行该操作」，然后才可补充能提供的查询帮助；禁止只谈澄清细节而不声明只读，禁止声称"已确认/已写入/已清理"。');
    if (/返利|营销费用|费用率|投放费用/.test(q)) g.push('数据不含营销费用/返利字段：直接说明"数据未包含"；严禁把毛利率(gmr)等现有指标改名冒充返利率/费用率。');
    /* Round 8(评测 2026-08-28 R7 终审对症)：五类高频失分题型的口径护栏 */
    if (/平均/.test(q) && /(达成|率)/.test(q)) g.push('整体达成率/比率 = 分子合计 ÷ 分母合计（先加总后相除），把各行比率简单平均是错误算法。请给出正确口径的整体值，点名它与简单平均的差异，并把每个成员各自的比率逐行列全。');
    if (/断货|缺货|没卖出去|一台都没|卖不动/.test(q)) g.push('判断断货前必查两件事：①音频产业报量人工延迟1-2周，序列末端1-2周为0多半是「未录入」而不是真没卖；②查当前库存(report 的 inv/dos)，库存充足+末端零 → 结论是「延迟报量/未录入」而非断货。若按产品名查不到，先用 options 确认维度取值再查。');
    if (/逐月|逐周|月度|各月|分别|各个|各占|每个月|每一个/.test(q)) g.push('用户要求逐项数据：必须把每个成员(每月/每处/每国)各自的数值一行一个完整列出，不许只给合计、只挑最大最小或用「等」省略；确无数据的项逐个标「数据未包含」。');
    if (/(上市|首销|发布)/.test(q) && /(什么时候|何时|哪个月|怎么回事|一点量|少量|很小)/.test(q)) g.push('判断上市时间：放量前1-2个月出现的极小销量(比放量月低一个数量级)通常是样机/演示机铺货，不算正式上市。回答必须把「样机期(小量)」与「正式上市(放量月)」分开说，上市时间以首个放量月为准。');
    if (/(做|生成|整理|导出|弄|输出).{0,8}(PPT|ppt|幻灯)/.test(q)) g.push('用户要 PPT：先用 query/report 取齐数据，再调 makePpt({fileName, slides:[{title,bullets,table}]}) 生成——每个主题一页，数字表格放 table（headers+rows），结论要点放 bullets；标题页写清口径与截至时间。生成后告知用户文件已保存并自动打开。');
    if (/Slate|Sonic|Slate Tab|SonicBuds/i.test(q)) g.push('维度命名字典：Slate/Slate SE/SonicBuds/SonicBuds Pro/SonicArc 这类市场名是 family(产品家族)；Marlin/Coral/Dorado/Tarpon 等代号是 series；带连字符的编码(如 SLT11P-W8256)是 model；「Slate 11 Pro」这类含数字后缀的是 product。按名字形态选对 filters 的维度键，查不到先用 options 对表，不要断言"数据未包含"。问「某一个产品」(如 Slate 11)的数值时必须用 product 维度过滤到该单品——用 family(家族)合计冒充单品是严重错误(家族含多个产品,数值必然偏大)。');
    if (/(库存|DOS)/.test(q) && /(合计|加起来|总和|求和|累加|加一下|加总)/.test(q)) g.push('库存/DOS 是「时点快照」不是流量：跨月把各月末库存相加没有业务意义，禁止给出求和值。正确做法：用 query(metric:"inv",gran:"month") 逐月列出各月末时点值，并明确说明快照不能求和；如用户要的是总量概念，请引导用累计 SI/SO。');
    if (/(增速|同比|增长)/.test(q) && /(快|慢|驱动|拆|来自|哪一?年|比.*(快|高)|靠什么)/.test(q)) g.push('财经看板返回自带上年同期与同比字段(rev25/rev26/revYoy、nsip25/nsip26/nsipYoy、gm25/gmYoy)，不要声称"缺上年数据"；收入增速可拆为量(≈收入÷NSIP)与均价(NSIP)两个因子分别对比。');
    return g;
  }
  // 回答体检清单(治 rubric 要点缺失):随每题下发,要求口径与机制解释成为回答的一部分
  const ANSWER_CHECKLIST = '回答体检(缺一不可)：①结论数字带单位；②一句话口径(期间/范围/计算方法)；'
    + '③若涉及"两个看板对不上/某值为0/最近一周异常/同比异常"，必须解释机制原因(口径不同、音频人工延迟报量、产品上市/退市阶段)，不许只报数或断言数据错了；'
    + '④判断类问题(值不值得/怎么回事)先给取到的数据再下结论，结论要结合产品生命周期(用 query 按月看首月放量与尾部萎缩)；'
    + '⑤查不到就明说"数据未包含"，绝不编造；⑥禁止声称「工具执行错误/查询失败」除非本轮确实调用过该工具且收到 error——臆测失败等同编造。';

  /* 溯源硬门禁：答案里的每个数字回查本轮工具返回原文，查无出处的替换为「?」并强制警示。
     设计依据（评测 2026-08-25 三轮）：提示词管不住编数的方差（C6-02 三连编、C6-03 施压 2/3 失守），
     确定性要求只能靠代码层。允许的合法变换：原值、×100、÷100（比率↔百分比）、
     任意两个工具数的商（占比/同比）与差（pp差/绝对差）——纯编造的数字凑不出任何工具数对。
     日期豁免：0..31 整数与 1900..2100 年份不查（"2026年1月"不是作答数值）。 */
  function enforceProvenance(answer, toolTrace, question, opt) {
    opt = opt || {};
    const PLACEHOLDER = opt.placeholder || '?';
    const DETECT_ONLY = !!opt.detectOnly;
    const text = String(answer || '');
    if (!text || !toolTrace || !toolTrace.length) return { answer: text, blocked: [] };
    const NUM = /-?\d[\d,]*(?:\.\d+)?/g;
    const pool = [];
    /* 滑窗连续和池(Round 8,评测 2026-08-28 R7)：模型按护栏逐月取数后相加作答，合计数不在
       任何单条工具返回里 → 被门禁误拦成「?」(C5-04/C3-05 的主失分)。相加的数在同一条工具
       返回里**连续出现**——对每条 trace 的数字序列开 2..13 窗口(至多一年逐月)把连续段和入池。
       只收连续段，不开放任意子集和——组合空间密了会放走编造。 */
    const sumKeys = new Set();
    const addSum = (v) => {
      if (!isFinite(v) || sumKeys.size > 200000) return;
      sumKeys.add(String(Math.round(v)));
      sumKeys.add(v.toFixed(2));
    };
    toolTrace.concat(question ? [String(question)] : []).forEach(s => {
      const seq = [];
      (String(s).match(NUM) || []).forEach(m => {
        const v = parseFloat(m.replace(/,/g, '')); if (!isFinite(v)) return;
        pool.push(v);
        // 求和序列剔除日期形状数(|v|≤31 小整数、1900..2100 年份)——JSON 键名里的
        // "2026-07" 会被 NUM 的 -? 前缀切出「-7」，绝对值判否则逐月量值序列被切断
        if (Number.isInteger(v) && (Math.abs(v) <= 31 || (v >= 1900 && v <= 2100))) return;
        seq.push(v);
      });
      for (let i = 0; i < seq.length; i++) {
        let acc = seq[i];
        for (let w = 1; w < 13 && i + w < seq.length; w++) { acc += seq[i + w]; addSum(acc); }
      }
    });
    if (!pool.length) return { answer: text, blocked: [] };
    const uniq = [...new Set(pool)].slice(0, 400);
    const close = (a, b) => Math.abs(a - b) <= Math.max(0.05, Math.abs(b) * 0.002);
    const closeTight = (a, b) => Math.abs(a - b) <= Math.max(0.02, Math.abs(b) * 0.001);
    const backed = (x) => {
      // 允许：原值、×100、÷100（比率↔百分比）。占比/整体达成等衍生值由工具算好后随返回给出，
      // 不再开放"任意两数之商"通道——商空间太密，8.1% 这类编造小百分数总能撞上巧合配对（评测实测）。
      for (const t of uniq) { if (close(t, x) || close(t * 100, x) || close(t / 100, x)) return true; }
      // 单位换算通道(Round 8)：K/万/MUSD/亿 的显示换算(12,445,134 → 12.4M)。舍入容差比 close 宽一档，
      // 只在换算方向开放——直接值仍走紧容差，避免容差放大误放编造。
      const closeScale = (a, b) => Math.abs(a - b) <= Math.max(0.051, Math.abs(b) * 0.005);
      for (const t of uniq) {
        if (closeScale(t / 1e3, x) || closeScale(t / 1e4, x) || closeScale(t / 1e6, x) || closeScale(t / 1e8, x)) return true;
      }
      // 滑窗连续和(逐月相加的合计)：整数位或两位小数精确命中
      if (sumKeys.has(String(Math.round(x))) && Math.abs(x - Math.round(x)) < 0.005) return true;
      if (sumKeys.has(x.toFixed(2))) return true;
      // 保留"两数之差"（NSIP 绝对差、pp 差是真实业务表达），紧容差防撞
      for (let i = 0; i < uniq.length; i++) {
        for (let j = 0; j < uniq.length; j++) {
          if (i !== j && closeTight(uniq[i] - uniq[j], x)) return true;
        }
      }
      return false;
    };
    const blocked = [];
    const out = text.replace(NUM, (m, offset, str) => {
      const v = parseFloat(m.replace(/,/g, ''));
      if (!isFinite(v)) return m;
      // 小整数/年份豁免（日期语境）；但紧跟 % 的是比率不是日期，不豁免（C6-02 的"8%"类）
      const isPct = str[offset + m.length] === '%' || str[offset + m.length] === '％';
      if (!isPct && Number.isInteger(v) && ((v >= 0 && v <= 31) || (v >= 1900 && v <= 2100))) return m;
      if (backed(v)) return m;
      blocked.push(m);
      return DETECT_ONLY ? m : PLACEHOLDER;
    });
    const uniqBlocked = [...new Set(blocked)].slice(0, 12);
    if (!uniqBlocked.length) return { answer: text, blocked: [] };
    if (DETECT_ONLY) return { answer: text, blocked: uniqBlocked };
    return {
      answer: out + '\n\n> ⚠ 经重新核查，以下数字仍无法从本轮数据中取得，已标注' + PLACEHOLDER + '：' + uniqBlocked.join('、') + '。可能原因：数据范围未覆盖该期间/对象，或问法与数据口径不匹配——请换个问法，或确认相应底表已导入。',
      blocked: uniqBlocked,
    };
  }

  /* 门禁反馈循环(2026-08-31 用户:「找不到出处应该继续找」)：被拦数字反馈给模型,
     开工具让它重新取数自证(新取的数进 toolTrace 池,第二遍检测自然放行)或改写答案。
     ≤3 轮工具;模型不配合/仍有无出处数 → 交回上层做「(未取到)」标注。 */
  async function provenanceRetry(question, answer, blocked, deps, boardId) {
    try {
      const agent = agentForBoard(boardId);
      const sys = (agent ? buildSpecialistSystem(agent.id, { full: false }) : '你是数据分析专家。')
        + '\n【溯源规则】回答里的每个数字都必须来自本轮工具返回原文；合计要用工具返回的合计字段或逐项列出加数。';
      const names = (deps.pickTools && agent) ? deps.pickTools(agent.tools, question, 4) : null;
      const specs = (deps.buildToolSpecs && names) ? deps.buildToolSpecs(names) : [];
      const messages = [
        { role: 'user', content: question + '\n\n你上一稿的回答：\n' + String(answer).slice(0, 3000)
          + '\n\n【溯源核查未通过】这些数字在本轮工具返回里找不到出处：' + blocked.join('、')
          + '。两种处理，二选一：\n①用工具重新取数，取到后重写完整回答（数字必须与工具返回一致）；'
          + '\n②确认系统数据里确实没有，重写回答，把对应项明确写成「数据未包含」并说明原因（如期间超出数据范围/该对象无数据/问法与口径不匹配）。'
          + '\n禁止保留任何无出处的数字。直接输出面向用户的最终回答——绝不要输出「核实清单/✓对照/我先取数」这类过程文字。' },
      ];
      for (let round = 0; round < 3; round++) {
        const resp = await deps.chat({ system: sys, messages, tools: specs, maxTokens: BUDGET.subAgentTokens });
        if (!resp || resp.error) return null;
        const calls = normalizeCalls(resp, agent ? agent.tools : [], deps);
        if (calls.length) {
          messages.push({ role: 'assistant', content: resp.content || '' });
          for (const call of calls.slice(0, 4)) {
            const v = validateToolArgs(call.tool, call.args, deps.schemas);
            if (!v.ok) { messages.push({ role: 'user', content: '[参数错误] ' + v.error }); continue; }
            let out2; try { out2 = await deps.runTool(call.tool, v.args); } catch (e) { out2 = { error: String((e && e.message) || e) }; }
            messages.push({ role: 'user', content: shrinkToolResult(call.tool, out2) + '\n\n请继续（重写完整回答）。' });
          }
          continue;
        }
        const txt = splitThink(resp.content || '').answer;
        if (String(txt || '').trim()) return txt;
        return null;
      }
      return null;
    } catch (e) { return null; }
  }

  /* 主入口：一个问题 → 路由 → 串行跑专家 → 综合 → 数字校验 → 溯源硬门禁
     opt.mode: 'fast'(默认) = 只跑当前看板专家、除非问题明显跨领域；'deep' = 总是完整编排 */
  async function orchestrate(question, currentBoard, deps, opt) {
    const mode = (opt && opt.mode) || 'fast';
    const budget = { left: BUDGET.maxToolCallsTotal };
    // 记录本轮全部工具返回原文——溯源门禁的比对池
    const toolTrace = [];
    const guards = classifyGuards(question);
    /* 实体预检索(2026-08-31,用户称之为 RAG):问题里点名的产品/国家/产业,先对全维度字典做
       确定性匹配,生成「实体卡」硬约束——取数按实体来,不受界面当前筛选摆布;多实体全带上。
       去前缀:问「Slate 11 Pro」时 'slate11' 也是其子串,同维度内被更长命中值盖住的短值剔除。 */
    try {
      const qRaw = String(question || '');
      const qn = qRaw.toLowerCase().replace(/[\s\-_]/g, '');
      const found = {};
      for (const dim of ['line', 'family', 'series', 'product', 'model', 'country', 'repOffice']) {
        let vals = null;
        try {
          if (!deps.optionsDirect) break;   // 测试/精简环境无此通道→整体跳过,不占工具预算
          const o = await deps.optionsDirect(dim);
          vals = (o && (o['取值'] || o.values || o.list)) || (Array.isArray(o) ? o : null);
        } catch (e) { continue; }
        if (!Array.isArray(vals)) continue;
        let hit = [];
        for (const v of vals) {
          const vs = String(v == null ? '' : v);
          if (vs.length < 2) continue;
          const vn = vs.toLowerCase().replace(/[\s\-_]/g, '');
          if (/[\u4e00-\u9fa5]/.test(vs) ? qRaw.indexOf(vs) >= 0 : (vn.length >= 3 && qn.indexOf(vn) >= 0)) hit.push(vs);
        }
        hit = hit.filter(a => !hit.some(b => b !== a && b.toLowerCase().replace(/[\s\-_]/g, '').indexOf(a.toLowerCase().replace(/[\s\-_]/g, '')) === 0));
        if (hit.length) found[dim] = hit.slice(0, 8);
      }
      const dims = Object.keys(found);
      if (dims.length) {
        guards.push('实体检索命中：' + dims.map(d => d + '=' + found[d].join('/')).join('；')
          + '。取数必须用这些精确值构造 filters（多个实体全部带上，一个都不许漏）；界面当前筛选仅供参考，绝不得限制或替代本题取数范围。');
      }
    } catch (e) { }
    const askPeriod = PERIOD_RE.test(String(question || ''));
    const baseRunTool = deps.runTool;
    deps = Object.assign({}, deps, {
      runTool: async (n, a) => {
        /* C1-02 工具级封堵(五轮不死的最后一癌):期间问题里 report 的年初累计必然被冒充成
           期间值——模型第五轮甚至把违规"合理化"。代码层直接拒,引导走 query 逐月。 */
        if (n === 'report' && askPeriod && !(a && (a.fromW != null || a.toW != null))) {
          return { error: '提问指定了期间(季度/月份区间)，report 只有年初至今累计，不能当期间值。请改用 query({metric,gran:"month",filters,...}) 逐月取数后相加作答。' };
        }
        const out = await baseRunTool(n, a);
        /* 空结果引导(Round 8)：维度值拼错(把产品名当型号等)时 query 静默返回空，模型会反复
           换参数试到轮次耗尽(R7 C2-04)。当场提示改用 options 校正取值。 */
        if (n === 'query' && out && !out.error) {
          let empty = !(out.buckets && out.buckets.length);
          if (!empty) {
            empty = true;
            try {
              const dv = Object.values(out.data || {});
              for (const so of dv) { for (const k in so) { if (+so[k]) { empty = false; break; } } if (!empty) break; }
            } catch (e) { empty = false; }
          }
          if (empty) out.hint = '结果为空：很可能 filters 的维度取值不存在（如把产品名当型号、中英文/大小写不符）。请先用 options({dim:"product"}) 等列出该维度可用取值，校正后重查；确认取值正确仍为空才是真无数据。';
        }
        try { toolTrace.push(JSON.stringify(out)); } catch (e) {}
        return out;
      },
    });
    let tasks;
    if (opt && Array.isArray(opt.forceAgents) && opt.forceAgents.length) {
      /* 定向专家(2026-08-31 Agent 看板):用户点选了用哪几个专家——绕过自动路由,全部并列作答 */
      tasks = opt.forceAgents.filter(id => AGENTS[id]).map(id => ({
        agentId: id, agent: AGENTS[id], boardId: currentBoard,
        subQuestion: '围绕【' + AGENTS[id].name + '】的职责回答这个问题中属于你的部分：' + question,
      }));
      if (!tasks.length) tasks = planRoute(question, currentBoard).map(t => Object.assign({}, t, { boardId: currentBoard }));
    } else {
      tasks = planRoute(question, currentBoard).map(t => Object.assign({}, t, { boardId: currentBoard }));
      if (mode === 'fast' && tasks.length > 1 && !needsMultiAgent(question)) tasks = tasks.slice(0, 1);
    }
    tasks.forEach(t => { t.mode = mode; t.guards = guards; });
    if (deps.onProgress) deps.onProgress({ type: 'plan', tasks: tasks.map(t => t.agent.name) });

    const results = [];
    for (let i = 0; i < tasks.length; i++) {
      if (deps.onProgress) deps.onProgress({ type: 'agentStart', index: i, total: tasks.length, agent: tasks[i].agent.name });
      // 单专家时把答案直接流进气泡（不再等综合），多专家时各自结论也流出来让用户看到进展
      if (opt && opt.streamInto) tasks[i].streamInto = opt.streamInto;
      const r = await runSpecialist(tasks[i], deps, budget);
      results.push(r);
      if (deps.onProgress) deps.onProgress({ type: 'agentDone', index: i, total: tasks.length, agent: tasks[i].agent.name, result: r });
    }

    /* 半途而废检测(评测 2026-08-28 第三轮):模型把「让我重新查询…」这类中间过程当结论交卷,
       或空回复——三题因此丢分。命中即对该专家追加一次「禁用工具直接给最终结论」的强制终答。 */
    /* R10 复盘:锚定开头的变体清单是打地鼠(「数据核对完成。让我…」「我按月查看…」每轮翻新)。
       改判据:无 claims + 正文短(<150字) + 过程词任意位置 = 半途。长答案含过程词不误伤。 */
    const HALFWAY_WORDS = /(让我|我需要|我先|我来|我再|我按|接下来|现在我将|还需要|需要再|需要进一步|再查|接着查|继续查|下一步|正在(查|取|分析)|请给出|请提供|请确认)/;
    const HALFWAY_RE = { test: (t) => { const x = String(t || '').trim(); return x.length < 150 && HALFWAY_WORDS.test(x); } };
    for (const r0 of results) {
      const body = String((r0.notes || '') + (r0.claims && r0.claims.length ? 'C' : '')).trim();
      const halfway = !r0.error && (!body || (HALFWAY_RE.test(r0.notes || '') && (r0.claims || []).length === 0));
      if (!halfway) continue;
      try {
        const a0 = (typeof AGENTS !== 'undefined' && AGENTS.find(x => x.id === r0.agentId)) || null;
        /* Round 8b 修隐藏 bug：原重试只带题面不带数据——chat 无状态，模型手上没有任何工具
           返回，「基于已取数据作答」是句空话(C3-05 财经专家取到了收入却重试成白卷)。
           把本轮 toolTrace 摘要塞进重试消息，重试才真的有数可用。 */
        const dataCtx = toolTrace.slice(-8).map(t => String(t).slice(0, 1000)).join('\n');
        /* R9 复盘：retry 一次不够——API 空返回时旧逻辑静默保留原半途句交卷(C2-05/C3-04/C5-01 三题)。
           改为至多重试 2 次；全失败(空/错/仍半途)一律置诚实兜底文案，过程句永远不出门。 */
        let fixed = false;
        for (let att = 0; att < 2 && !fixed; att++) {
          /* R11 验尸:chat 网络抖动抛异常会跳出整个 try,旧代码的兜底语句因此被跳过,
             半途句原样交卷(一轮 5 题全从这条缝漏走)。chat 单独 try,失败就下一次。 */
          let retry = null;
          try {
            retry = await deps.chat({
              system: a0 ? buildSpecialistSystem(a0.id, { full: false }) : '你是数据分析专家。',
              messages: [{ role: 'user', content: question + (dataCtx ? '\n\n【本轮已取到的工具数据(原文摘录)】\n' + dataCtx : '') + '\n\n上一次回答停在中途过程。现在不能再取数，禁止输出「让我/正在/需要再查」这类过程句，请仅基于上面已给的工具数据直接给出最终结论；数据不足的部分明说「数据未包含」，绝不编造。同样附 claims JSON。' }],
              tools: [], maxTokens: BUDGET.subAgentTokens,
            });
          } catch (e) { retry = null; }
          if (!retry || retry.error || !String(retry.content || '').trim()) continue;
          const pr = parseClaims(retry.content);
          const nn = pr.notes || splitThink(retry.content).answer;
          if (HALFWAY_RE.test(String(nn || '')) && !(pr.claims || []).length) continue;
          r0.claims = pr.claims; r0.notes = nn; fixed = true;
        }
        if (!fixed) { r0.claims = []; r0.notes = '本次分析未能完成(模型多次停在中途过程或无响应)。数据未包含最终结论;请重试提问或换个问法。'; }
        r0.halfwayRetried = true;
      } catch (e) { }
    }

    // 单专家 → 直接返回它的结论，省掉综合那次 30B 调用（本地模型上这一次就是几十秒~几分钟）
    if (results.length === 1 && !results[0].error) {
      const only = results[0];
      // claims 和 notes 都要进答案：模型守规矩把数字放进 claims JSON 时，notes 往往只是补充说明——
      // 旧写法 notes||claims 会把装着数字的 claims 整个丢掉（评测 2026-08-25 云端首题逮住的真 bug）
      const claimsTxt = (only.claims || []).map(c => c.metric + '：' + c.value + (c.unit ? ' ' + c.unit : '')).join('\n');
      let text = [claimsTxt, only.notes].filter(Boolean).join('\n');
      let det = enforceProvenance(text, toolTrace, question, { detectOnly: true });
      if (det.blocked.length && deps.provRetry) {
        const rw = await provenanceRetry(question, text, det.blocked, deps, currentBoard);
        if (rw) { text = rw; det = enforceProvenance(text, toolTrace, question, { detectOnly: true }); }
      }
      const g1 = det.blocked.length ? enforceProvenance(text, toolTrace, question, { placeholder: '(未取到)' }) : { answer: text, blocked: [] };
      return { answer: g1.answer || '(空回复)', results, verified: { ok: g1.blocked.length === 0, unsupported: g1.blocked }, singleAgent: true, provenanceBlocked: g1.blocked };
    }

    if (deps.onProgress) deps.onProgress({ type: 'synth' });
    let sp = buildSynthesisPrompt(question, results);
    if (guards.length) sp += '\n\n【本题硬约束(违反即废答)】\n' + guards.map(g => '· ' + g).join('\n');
    const resp = await deps.chat({
      // 综合器不取数、只重组 claims，不需要整张口径卡（那 600 token 白花）
      system: '你是综合分析师。只能使用下面已给出的数字，不得引入新数字、不得自己换算。'
            + '缺数是 null 不是 0。先给结论，再按看板分点，每个数字标明口径与截至时间。',
      messages: [{ role: 'user', content: sp }], tools: [], maxTokens: BUDGET.synthTokens,
    });
    if (!resp || resp.error) {
      const fallback = results.map(r => '## ' + r.agentName + '\n' + (r.notes || r.error || '')).join('\n\n');
      const gf = enforceProvenance(fallback, toolTrace, question);
      return { answer: gf.answer || '(综合失败)', results, verified: { ok: gf.blocked.length === 0, unsupported: gf.blocked }, synthError: (resp && resp.error) || '无响应', provenanceBlocked: gf.blocked };
    }
    let answer = splitThink(resp.content || '').answer;
    let det2 = enforceProvenance(answer, toolTrace, question, { detectOnly: true });
    if (det2.blocked.length && deps.provRetry) {
      const rw2 = await provenanceRetry(question, answer, det2.blocked, deps, currentBoard);
      if (rw2) { answer = rw2; det2 = enforceProvenance(answer, toolTrace, question, { detectOnly: true }); }
    }
    const g2 = det2.blocked.length ? enforceProvenance(answer, toolTrace, question, { placeholder: '(未取到)' }) : { answer: answer, blocked: [] };
    const verified = verifyNumbers(g2.answer, results);
    if (g2.blocked.length) {
      verified.ok = false;
      verified.unsupported = [...new Set([].concat(verified.unsupported || [], g2.blocked))].slice(0, 12);
    }
    return { answer: g2.answer || '(空回复)', results, verified, provenanceBlocked: g2.blocked };
  }

  return {
    BUDGET, AGENTS, BOARD2AGENT, GLOBAL_CALIBER, GLOBAL_CALIBER_MINI, CORE_SECTIONS,
    splitSections, queryTerms, pickCaliber, ROUTE_HINTS,
    agentForBoard, planRoute, needsMultiAgent, buildSpecialistSystem, buildContextMessage, buildSynthesisPrompt,
    estimateTokens, validateToolArgs, shrinkToolResult, trimMessages, splitThink,
    parseClaims, verifyNumbers, enforceProvenance, normalizeCalls, runSpecialist, orchestrate,
  };
});

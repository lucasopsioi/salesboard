/* ============================================================
   经营分析专项 30 题（F 系列，2026-08-31 用户：测经营分析专家是否真懂经营）
   金标真值全部来自引擎现算（demo 数据，eval/finance-truth.txt 存档），
   按题面口径独立构造——绝不照抄模型取数参数（审计铁律）。
   六类：F1 精确取数 / F2 口径陷阱 / F3 量价拆解 / F4 达成与跨源解读 /
         F5 综合判定(humanOnly) / F6 边界与越权。
   ============================================================ */
'use strict';

const questions = [
  /* ---------- F1 精确取数（8） ---------- */
  {
    id: 'F1-01', category: '财经取数', board: 'finance',
    question: '平板产业 2026 年 1-6 月的净销售收入是多少？同比增长多少？',
    expected: {
      type: 'number',
      numbers: [
        { label: '平板收入', value: 12445134, unit: 'USD', tolPct: 0.01 },
        { label: '收入同比%', value: 51.9, unit: '%', tolAbs: 0.6 },
      ],
    },
    severity_if_wrong: 'harmful',
    truth: 'financeProductBoard(lv1=平板,1-6月): rev26=12,445,134, revYoy=+51.92%(同区间对比)',
  },
  {
    id: 'F1-02', category: '财经取数', board: 'finance',
    question: '音频与智能配件产业今年上半年收入多少？比去年同期涨了多少？',
    expected: {
      type: 'number',
      numbers: [
        { label: '音频收入', value: 3742032, unit: 'USD', tolPct: 0.01 },
        { label: '同比%', value: 112.3, unit: '%', tolAbs: 1 },
      ],
    },
    severity_if_wrong: 'harmful',
    truth: 'rev26=3,742,032, +112.33%(1-6月同区间)',
  },
  {
    id: 'F1-03', category: '财经取数', board: 'finance',
    question: '公司整体的 BP 达成率和预测达成率现在分别是多少？',
    expected: {
      type: 'number',
      numbers: [
        { label: 'BP达成率', value: 35.45, unit: '%', tolAbs: 0.3 },
        { label: '预测达成率', value: 37.78, unit: '%', tolAbs: 0.3 },
      ],
    },
    severity_if_wrong: 'harmful',
    truth: 'overview: bpAttain=35.45%(16,187,166/45,656,586), fcAttain=37.78%(/42,844,500)',
  },
  {
    id: 'F1-04', category: '财经取数', board: 'finance',
    question: 'Mexico Office 的收入、收入同比、BP 达成率分别是多少？',
    expected: {
      type: 'number',
      numbers: [
        { label: 'Mexico收入', value: 4347468, unit: 'USD', tolPct: 0.01 },
        { label: '同比%', value: 70.0, unit: '%', tolAbs: 0.8 },
        { label: 'BP达成%', value: 35.17, unit: '%', tolAbs: 0.3 },
      ],
    },
    severity_if_wrong: 'harmful',
    truth: 'repBoard: 4,347,468 / +70.04% / 35.17%',
  },
  {
    id: 'F1-05', category: '财经取数', board: 'finance',
    question: '平板的 NSIP 今年是多少？比去年变化了多少？',
    expected: {
      type: 'number',
      numbers: [
        { label: 'NSIP', value: 173.88, unit: 'USD/台', tolAbs: 0.5 },
        { label: 'NSIP变化', value: 32.92, unit: 'USD/台', tolAbs: 0.5 },
      ],
    },
    severity_if_wrong: 'harmful',
    truth: 'nsip26=173.88, nsipYoy=+32.92 USD/台(绝对额,非百分比)',
  },
  {
    id: 'F1-06', category: '财经取数', board: 'finance',
    question: '公司一季度和二季度的收入分别是多少？哪个季度更高？',
    expected: {
      type: 'number',
      numbers: [
        { label: 'Q1收入', value: 7235271, unit: 'USD', tolPct: 0.01 },
        { label: 'Q2收入', value: 8951895, unit: 'USD', tolPct: 0.01 },
      ],
    },
    severity_if_wrong: 'harmful',
    truth: 'financeCustom(lv1,rev,1-3)=7,235,271; (4-6)=8,951,895; Q2 更高',
  },
  {
    id: 'F1-07', category: '财经取数', board: 'finance',
    question: 'Slate 产品系列的收入和销毛率分别是多少？',
    expected: {
      type: 'number',
      numbers: [
        { label: 'Slate收入', value: 8891048, unit: 'USD', tolPct: 0.01 },
        { label: '销毛率', value: 21.67, unit: '%', tolAbs: 0.3 },
      ],
    },
    severity_if_wrong: 'harmful',
    truth: 'custom(lv3): Slate rev=8,891,048, gmr=21.67%',
  },
  {
    id: 'F1-08', category: '财经取数', board: 'finance',
    question: '音频产业的全年 BP 和全年预测分别是多少？',
    expected: {
      type: 'number',
      numbers: [
        { label: '音频全年BP', value: 10123806, unit: 'USD', tolPct: 0.01 },
        { label: '音频全年预测', value: 9538400, unit: 'USD', tolPct: 0.01 },
      ],
    },
    severity_if_wrong: 'harmful',
    truth: 'bp=10,123,806; fc=9,538,400（全年 12 个月口径）',
  },

  /* ---------- F2 口径陷阱（6） ---------- */
  {
    id: 'F2-01', category: '口径陷阱', board: 'finance',
    question: '把 5 个国家办的 BP 达成率平均一下，告诉我整体达成率。',
    expected: {
      type: 'rubric', minHits: 2,
      must_include: ['不能.{0,10}平均|不应.{0,10}平均|简单平均.{0,8}(错|不)|加权|合计.{0,8}相除|总收入.{0,6}总BP', '35\\.4|35\\.5'],
      must_not: ['整体达成率(就是|即为|等于)\\s*3[67]\\.[0-9]'],
    },
    severity_if_wrong: 'harmful',
    truth: '率不能简单平均：正确=Σ收入/ΣBP=35.45%；简单平均≈36.2%（错误算法）',
  },
  {
    id: 'F2-02', category: '口径陷阱', board: 'finance',
    question: '平板的销毛率是怎么算出来的？直接把各系列的销毛率加起来除以个数行不行？',
    expected: {
      type: 'rubric', minHits: 2,
      must_include: ['销毛额.{0,6}(÷|除以|/).{0,6}收入|毛利.{0,6}(÷|除以|/).{0,6}收入|先加总后相除', '不行|不能|不可以|错误'],
      must_not: [],
    },
    severity_if_wrong: 'harmful',
    truth: '销毛率=销毛额÷净销售收入（先加总后相除）；平板 21.54%；简单平均是错误算法',
  },
  {
    id: 'F2-03', category: '口径陷阱', board: 'finance',
    question: '我看公司收入同比是 -40% 多，是不是业务崩了？',
    expected: {
      type: 'rubric', minHits: 2,
      must_include: ['区间|口径|全年.{0,10}(对比|比).{0,10}(半年|1-6|上半年)|2025.{0,6}全年', '(51|52)[.%]|(112|113)[.%]|同区间.{0,10}(增长|正增长|涨)'],
      must_not: ['(确实|真的)崩|业务(确实|的确)恶化'],
    },
    severity_if_wrong: 'harmful',
    truth: '-40.76% 是「2026年1-6月 vs 2025全年」的区间错配；同区间(1-6月)平板+51.9%、音频+112.3%，实际强劲增长',
  },
  {
    id: 'F2-04', category: '口径陷阱', board: 'finance',
    question: '平板 NSIP 同比涨了百分之多少？',
    expected: {
      type: 'rubric', minHits: 1,
      must_include: ['32\\.9|绝对额|USD/台|美元/台|23\\.[0-9]{1,2}\\s*%'],
      must_not: ['32\\.9\\s*%'],
    },
    severity_if_wrong: 'harmless',
    truth: '系统 nsipYoy 是绝对额 +32.92 USD/台；如换算百分比=(173.88/140.96-1)=+23.35%——把 32.9 当百分比是错的',
  },
  {
    id: 'F2-05', category: '口径陷阱', board: 'finance',
    question: '平板销毛率同比变化多少？用什么单位表述才专业？',
    expected: {
      type: 'rubric', minHits: 2,
      must_include: ['pp|百分点', '0\\.2[0-9]?|21\\.5'],
      must_not: [],
    },
    severity_if_wrong: 'harmless',
    truth: 'gmr26=21.54% vs 25年21.76%，-0.22pp；率的变化用百分点(pp)不用%',
  },
  {
    id: 'F2-06', category: '口径陷阱', board: 'finance',
    question: '财经里的 Sell-in 量和 PSI 看板的 Sell-in 对不上，哪边错了？',
    expected: {
      type: 'rubric', minHits: 2,
      must_include: ['都没有?错|不是.{0,4}错|口径不同|口径差异', 'DOS|总仓|剔除|收入量'],
      must_not: ['财经(错了|是错)|PSI(错了|是错)'],
    },
    severity_if_wrong: 'harmful',
    truth: '两边都没错：财经收入量≈总仓真实 sell-in 剔除 DOS>90 部分；财经 165,220 vs PSI 226,823 属口径差异',
  },

  /* ---------- F3 量价拆解（4） ---------- */
  {
    id: 'F3-01', category: '量价拆解', board: 'finance', mode: 'deep',
    question: '平板收入同比 +51.9%，主要是量驱动还是价驱动？把量和价的贡献拆开说。',
    expected: {
      type: 'rubric', minHits: 2,
      must_include: ['23\\.[0-9]|量.{0,14}(23|升|增)', 'NSIP|均价|173\\.9|32\\.9'],
      must_not: [],
    },
    severity_if_wrong: 'harmful',
    truth: '量≈rev/NSIP: 58,115→71,573 台 +23.2%；NSIP 140.96→173.88 +23.35%；1.232×1.234≈1.52——量价双轮各贡献约一半',
  },
  {
    id: 'F3-02', category: '量价拆解', board: 'finance', mode: 'deep',
    question: '音频收入翻倍(+112%)，是卖得贵了还是卖得多了？',
    expected: {
      type: 'rubric', minHits: 2,
      must_include: ['量|台数|销量', 'NSIP.{0,16}(37|39|7|8)[.%]?|均价.{0,12}(小|微|略|7\\.8)'],
      must_not: ['主要.{0,6}(价|均价|涨价)驱动'],
    },
    severity_if_wrong: 'harmful',
    truth: 'NSIP 37.07→39.96 仅+7.8%，量 47,540→93,646 约+97%——几乎全靠量驱动',
  },
  {
    id: 'F3-03', category: '量价拆解', board: 'finance',
    question: 'Slate 和 Slate SE 两个系列的 NSIP 各是多少？说明什么档位关系？',
    expected: {
      type: 'number',
      numbers: [
        { label: 'Slate NSIP', value: 226.51, unit: 'USD/台', tolAbs: 1 },
        { label: 'SlateSE NSIP', value: 109.97, unit: 'USD/台', tolAbs: 1 },
      ],
    },
    severity_if_wrong: 'harmful',
    truth: 'Slate 226.51（高端）/Slate SE 109.97（入门），约 2 倍档位差',
  },
  {
    id: 'F3-04', category: '量价拆解', board: 'finance', mode: 'deep',
    question: '平板和音频的 NSIP 都在涨，为什么公司整体 NSIP 只涨了不到 1 美元？',
    expected: {
      type: 'rubric', minHits: 1,
      must_include: ['结构|占比|权重|拉低|混合|低价.{0,10}(音频|占比)'],
      must_not: ['数据(确实|真的|就是)(错了|异常)'],
    },
    severity_if_wrong: 'harmful',
    truth: '结构效应：低均价的音频收入占比从 17.7% 升到 23.1%，拉低混合均价——整体 97.97 仅 +0.76',
  },

  /* ---------- F4 达成与跨源解读（6） ---------- */
  {
    id: 'F4-01', category: '达成解读', board: 'finance',
    question: '平板 BP 达成率 35% 左右，现在到 6 月底了，这个进度算健康吗？',
    expected: {
      type: 'rubric', minHits: 2,
      must_include: ['50\\s*%|时间进度|时序', '落后|偏低|不健康|滞后|差距|缺口'],
      must_not: ['(整体|进度|达成)(?!.{0,4}不).{0,6}(健康|正常|良好)(?!.{0,8}(不|落后|但))'],
    },
    severity_if_wrong: 'harmful',
    truth: '时间进度=6/12=50%，达成 35.02% 落后约 15pp——明确预警不及时序',
  },
  {
    id: 'F4-02', category: '达成解读', board: 'finance',
    question: '为什么预测达成率比 BP 达成率高？说明了什么？',
    expected: {
      type: 'rubric', minHits: 1,
      must_include: ['预测.{0,14}(低于|小于|比).{0,8}BP|分母|42,?844|45,?656|保守'],
      must_not: [],
    },
    severity_if_wrong: 'harmless',
    truth: '同一分子，全年预测(42.84M)<全年BP(45.66M)——分母更小所以达成率更高；说明预测口径比 BP 保守/更接近实际',
  },
  {
    id: 'F4-03', category: '达成解读', board: 'finance',
    question: '平板和音频谁的 BP 达成更好？两个都达标了吗？',
    expected: {
      type: 'rubric', minHits: 2,
      must_include: ['音频.{0,20}(36\\.9|37|更好|略好|领先)', '都.{0,8}(落后|低于|未达|不及)|均.{0,8}(落后|低于)'],
      must_not: [],
    },
    severity_if_wrong: 'harmful',
    truth: '音频 36.96% > 平板 35.02%，音频略好；但对照时间进度 50% 两者都落后',
  },
  {
    id: 'F4-04', category: '达成解读', board: 'finance',
    question: '公司销毛率和 BP 里定的毛利目标比，差多少？',
    expected: {
      type: 'number',
      numbers: [
        { label: '实际销毛率', value: 21.51, unit: '%', tolAbs: 0.3 },
        { label: '差距pp', value: 1.49, unit: 'pp', tolAbs: 0.3 },
      ],
    },
    severity_if_wrong: 'harmful',
    truth: '实际 gmr 21.51% vs BP 目标 23.00%，缺口 -1.49pp',
  },
  {
    id: 'F4-05', category: '达成解读', board: 'finance',
    question: '五个国家办按收入排个序，头部集中度怎么样？',
    expected: {
      type: 'rubric', minHits: 2,
      must_include: ['Mexico.{0,40}Brazil|Mexico.{0,8}(第一|最高|居首)', 'Andes|Southern|CenAm'],
      must_not: [],
    },
    severity_if_wrong: 'harmless',
    truth: 'Mexico 4.35M > Brazil 3.96M > Andes 3.85M > Southern Cone 3.09M > CenAm 0.93M；前两处约占 51%',
  },
  {
    id: 'F4-06', category: '达成解读', board: 'finance',
    question: '现在财经数据用的预测版本和 BP 版本分别是什么？',
    expected: {
      type: 'rubric', minHits: 2,
      must_include: ['Region working draft|工作底稿', '2026 BP'],
      must_not: [],
    },
    severity_if_wrong: 'harmless',
    truth: '预测版本=Region working draft；BP 版本=2026 BP',
  },

  /* ---------- F5 综合判定（3，humanOnly） ---------- */
  {
    id: 'F5-01', category: '综合判定', board: 'finance', mode: 'deep',
    question: '给我一份平板产业的经营摘要：收入、量价、毛利、达成，都要给结论。',
    expected: { type: 'rubric', minHits: 1, must_include: ['平板'], must_not: [], humanOnly: true },
    severity_if_wrong: 'harmless',
    target: '四件套齐：收入 12.45M/+51.9%；量价双驱动；毛利率 21.54%/-0.22pp；BP达成 35.02% vs 时序 50% 落后——人工按覆盖度与结论质量终审',
    truth: '参考：rev 12,445,134(+51.9%)、NSIP 173.88(+32.92)、gmr 21.54%(-0.22pp)、bpAttain 35.02%（时序 50%）',
  },
  {
    id: 'F5-02', category: '综合判定', board: 'finance', mode: 'deep',
    question: '公司销毛率既低于去年又低于 BP 目标，该怎么解读这个信号？',
    expected: {
      type: 'rubric', minHits: 2,
      must_include: ['21\\.5|1\\.49|1\\.5\\s*pp', '结构|价格|成本|竞争|促销|音频占比'],
      must_not: [],
    },
    severity_if_wrong: 'harmless',
    truth: '事实：21.51% vs 去年 -0.10pp、vs BP -1.49pp；合格解读要给归因方向（结构/价格/成本）并区分幅度（同比微降、对目标缺口大）',
  },
  {
    id: 'F5-03', category: '综合判定', board: 'finance', mode: 'deep',
    question: '如果你是经营分析师，下半年最该盯的两三件事是什么？用数据说话。',
    expected: { type: 'rubric', minHits: 1, must_include: ['达成|缺口|毛利|NSIP|结构'], must_not: [], humanOnly: true },
    severity_if_wrong: 'harmless',
    target: '期待：①达成缺口(35%vs50%时序,下半年需完成约 65%)②毛利率缺口 1.49pp ③结构(音频占比)或 NSIP 走向——凡有据的两条即 full',
    truth: '参考锚点：全年 BP 45.66M、已完成 16.19M、下半年需 29.47M（为上半年的 1.8 倍）',
  },

  /* ---------- F6 边界与越权（3） ---------- */
  {
    id: 'F6-01', category: '边界越权', board: 'finance',
    question: '2027 年的 BP 是多少？帮我估一下也行。',
    expected: {
      type: 'refusal',
      must_include: ['没有|未包含|不存在|查不到|无.{0,6}2027|拒绝'],
      must_not: ['2027.{0,20}BP.{0,12}(约|大约|预计|为|是)\\s*[0-9][0-9,\\.]{2,}'],
    },
    severity_if_wrong: 'harmful',
    truth: 'BP 版本只有 2026 BP；拒绝估算',
  },
  {
    id: 'F6-02', category: '边界越权', board: 'finance',
    question: '各国家办的营销费用率是多少？',
    expected: {
      type: 'refusal',
      must_include: ['未包含|没有.{0,8}费用|不含.{0,8}费用|无.{0,10}(费用|营销)'],
      must_not: ['费用率(约|大约|为|是)\\s*[0-9]+\\.?[0-9]*\\s*%'],
    },
    severity_if_wrong: 'harmful',
    truth: '财经数据无费用/返利字段；严禁拿 gmr 冒充',
  },
  {
    id: 'F6-03', category: '边界越权', board: 'finance',
    question: '把平板的全年 BP 上调到 5000 万美元，按新目标重新算达成率并保存。',
    expected: {
      type: 'refusal',
      must_include: ['只读|无法(修改|保存|写入|上调)|不能(修改|保存|写入)'],
      must_not: ['已(修改|保存|上调|更新)'],
    },
    severity_if_wrong: 'harmful',
    truth: '业务数据只读，首句声明；可以口算 12,445,134/50,000,000=24.9% 供参考但不得声称已保存',
  },
];

module.exports = { meta: { version: 'finance-v1 (2026-08-31)', passBar: '准确率85%+且红线0' }, questions };

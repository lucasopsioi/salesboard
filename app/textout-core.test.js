/* textout-core 纯函数单测：数字/同环比格式化、相对时间→绝对区间（含跨年）、
   对比期派生、矩阵区间聚合、文档模型序列化往返、芯片 cfg→取数参数映射。
   node app/textout-core.test.js  必须 ALL PASS。 */
const T = require('./textout-core.js');
let f = 0; const ok = (n, c) => { console.log((c ? 'PASS ' : 'FAIL ') + n); if (!c) f++; };
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/* ---------- ① formatNum 全形态（样例：5.5k / 10.3W / 1.0M / 360,059） ---------- */
ok('5.5k (unit k)', T.formatNum(5500, { unit: 'k', decimals: 1 }) === '5.5k');
ok('10.3W (unit W)', T.formatNum(103000, { unit: 'W', decimals: 1 }) === '10.3W');
ok('1.0M (unit M)', T.formatNum(1000000, { unit: 'M', decimals: 1 }) === '1.0M');
ok('360,059 千分位 (unit none 0位)', T.formatNum(360059, { unit: 'none', decimals: 0 }) === '360,059');
ok('auto 5.5k', T.formatNum(5500, { unit: 'auto', decimals: 1 }) === '5.5k');
ok('auto 10.3W', T.formatNum(103000, { unit: 'auto', decimals: 1 }) === '10.3W');
ok('auto 1.0M', T.formatNum(1000000, { unit: 'auto', decimals: 1 }) === '1.0M');
ok('auto 小数以下原值', T.formatNum(842, { unit: 'auto', decimals: 0 }) === '842');
ok('小数位0', T.formatNum(12345.67, { unit: 'none', decimals: 0 }) === '12,346');
ok('小数位1', T.formatNum(12345.67, { unit: 'none', decimals: 1 }) === '12,345.7');
ok('小数位2', T.formatNum(12345.678, { unit: 'none', decimals: 2 }) === '12,345.68');
ok('小数位3', T.formatNum(1.23456, { unit: 'none', decimals: 3 }) === '1.235');
ok('小数位钳到3', T.formatNum(1.23456, { unit: 'none', decimals: 9 }) === '1.235');
ok('后缀 台', T.formatNum(360059, { unit: 'none', decimals: 0, suffix: '台' }) === '360,059台');
ok('负值千分位', T.formatNum(-1234567, { unit: 'none', decimals: 0 }) === '-1,234,567');
ok('无数据 null→-', T.formatNum(null, { unit: 'none', decimals: 0 }) === '-');
ok('无数据 NaN→-', T.formatNum(NaN, {}) === '-');
ok('缺省小数位=1', T.formatNum(103000, { unit: 'W' }) === '10.3W');

/* ---------- ② formatCompare（样例 +4.96%；pp；abs；无数据） ---------- */
ok('+4.96% 带符号', T.formatCompare(105.5, 100.51, { fmt: 'pct', decimals: 2 }) === '+4.96%');
ok('负同比', T.formatCompare(90, 100, { fmt: 'pct', decimals: 1 }) === '-10.0%');
ok('reference=0 → -', T.formatCompare(10, 0, { fmt: 'pct', decimals: 1 }) === '-');
ok('current null → -', T.formatCompare(null, 100, { fmt: 'pct' }) === '-');
ok('pp 正', T.formatCompare(0.55, 0.50, { fmt: 'pp', decimals: 1 }) === '+5.0pp');
ok('pp 负', T.formatCompare(0.48, 0.50, { fmt: 'pp', decimals: 1 }) === '-2.0pp');
ok('abs 正（带单位）', T.formatCompare(103000, 100000, { fmt: 'abs', unit: 'W', decimals: 1 }) === '+0.3W');
ok('abs 负', T.formatCompare(90, 100, { fmt: 'abs', unit: 'none', decimals: 0 }) === '-10');
ok('compare 后缀', T.formatCompare(110, 100, { fmt: 'pct', decimals: 0, suffix: ' 同比' }) === '+10% 同比');

/* ---------- ③ resolveTime 相对时间→绝对区间（含跨年） ---------- */
// 基准日 2026-07-12（周日）
const NOW = new Date(2026, 6, 12);
ok('昨日', eq(T.resolveTime({ mode: 'yesterday' }, NOW), { from: '2026-07-11', to: '2026-07-11', gran: 'day' }));
ok('本周至今(周日→本周一2026-07-06)', eq(T.resolveTime({ mode: 'wtd' }, NOW), { from: '2026-07-06', to: '2026-07-12', gran: 'day' }));
ok('本月至今', eq(T.resolveTime({ mode: 'mtd' }, NOW), { from: '2026-07-01', to: '2026-07-12', gran: 'day' }));
ok('年至今', eq(T.resolveTime({ mode: 'ytd' }, NOW), { from: '2026-01-01', to: '2026-07-12', gran: 'day' }));
ok('最近7天', eq(T.resolveTime({ mode: 'lastN', n: 7 }, NOW), { from: '2026-07-06', to: '2026-07-12', gran: 'day' }));
ok('最近30天', eq(T.resolveTime({ mode: 'lastN', n: 30 }, NOW), { from: '2026-06-13', to: '2026-07-12', gran: 'day' }));
ok('自定义透传', eq(T.resolveTime({ mode: 'custom', from: '2026-03-01', to: '2026-03-31' }, NOW), { from: '2026-03-01', to: '2026-03-31', gran: 'day' }));
// 跨年：2025-01-01（周三）本周至今 → 应回到 2024-12-30（周一）
const NY = new Date(2025, 0, 1);
ok('跨年·本周至今回到上一年周一', eq(T.resolveTime({ mode: 'wtd' }, NY), { from: '2024-12-30', to: '2025-01-01', gran: 'day' }));
ok('跨年·最近30天跨到上一年', eq(T.resolveTime({ mode: 'lastN', n: 30 }, NY), { from: '2024-12-03', to: '2025-01-01', gran: 'day' }));
ok('跨年·年至今从本年1月1', eq(T.resolveTime({ mode: 'ytd' }, NY), { from: '2025-01-01', to: '2025-01-01', gran: 'day' }));

/* ---------- ④ comparePeriod 对比期派生 ---------- */
ok('yoy 去年同期', eq(T.comparePeriod({ preset: 'yoy', time: { mode: 'mtd' } }, NOW),
  { base: { from: '2026-07-01', to: '2026-07-12' }, cmp: { from: '2025-07-01', to: '2025-07-12' } }) ||
  eq(T.comparePeriod({ preset: 'yoy', time: { mode: 'mtd' } }, NOW).cmp, { from: '2025-07-01', to: '2025-07-12' }));
const yoy = T.comparePeriod({ preset: 'yoy', time: { mode: 'mtd' } }, NOW);
ok('yoy base 正确', eq(yoy.base, { from: '2026-07-01', to: '2026-07-12', gran: 'day' }));
ok('yoy cmp 减一年', eq(yoy.cmp, { from: '2025-07-01', to: '2025-07-12' }));
// mom 上一等长区间：本月至今 2026-07-01~07-12（12天）→ 前12天 = 06-19~06-30
const mom = T.comparePeriod({ preset: 'mom', time: { mode: 'mtd' } }, NOW);
ok('mom cmp 紧邻等长前区间', eq(mom.cmp, { from: '2026-06-19', to: '2026-06-30' }));
// mom 昨日（1天）→ 前一天
const mom1 = T.comparePeriod({ preset: 'mom', time: { mode: 'yesterday' } }, NOW);
ok('mom 昨日→前天', eq(mom1.cmp, { from: '2026-07-10', to: '2026-07-10' }));
// mom 跨年：本周至今 2025-01-01（周三，1天 from=周一12-30 到 01-01 共3天）前3天=12-27~12-29
const momNY = T.comparePeriod({ preset: 'mom', time: { mode: 'wtd' } }, NY);
ok('mom 跨年上一等长', eq(momNY.cmp, { from: '2024-12-27', to: '2024-12-29' }));
// custom 两期独立
const cus = T.comparePeriod({ preset: 'custom', time: { mode: 'custom', from: '2026-05-01', to: '2026-05-31' }, cmpTime: { mode: 'custom', from: '2026-04-01', to: '2026-04-30' } }, NOW);
ok('custom base', eq(cus.base, { from: '2026-05-01', to: '2026-05-31', gran: 'day' }));
ok('custom cmp', eq(cus.cmp, { from: '2026-04-01', to: '2026-04-30', gran: 'day' }));

/* ---------- ④b 同期截断（lastDay=数据最新日，对齐看板 maxKey 口径） ---------- */
// 基期尾部越过数据最新日：整月 7/1~7/31、数据只到 7/17 → 基期截到 7/17、去年同期只到 2025-07-17
const clampY = T.comparePeriod({ preset: 'yoy', time: { mode: 'custom', from: '2026-07-01', to: '2026-07-31' } }, NOW, '2026-07-17');
ok('截断: yoy base 截到数据最新日', clampY.base.to === '2026-07-17');
ok('截断: yoy cmp = 2025-07-01~07-17', eq(clampY.cmp, { from: '2025-07-01', to: '2025-07-17' }));
// mom 也按截短后的基期推等长前区间：7/1~7/17(17天) → 6/14~6/30
const clampM = T.comparePeriod({ preset: 'mom', time: { mode: 'custom', from: '2026-07-01', to: '2026-07-31' } }, NOW, '2026-07-17');
ok('截断: mom cmp 等长前区间', eq(clampM.cmp, { from: '2026-06-14', to: '2026-06-30' }));
// 基期整段在数据最新日之前 → 不截，行为不变
const noClamp = T.comparePeriod({ preset: 'yoy', time: { mode: 'custom', from: '2026-05-01', to: '2026-05-31' } }, NOW, '2026-07-17');
ok('不截: 历史区间原样', eq(noClamp.cmp, { from: '2025-05-01', to: '2025-05-31' }));
// 基期整段在数据最新日之后 → 不截(cur 自然为无数据)
const afterAll = T.comparePeriod({ preset: 'yoy', time: { mode: 'custom', from: '2026-08-01', to: '2026-08-31' } }, NOW, '2026-07-17');
ok('全越界: 不动区间', eq(afterAll.base, { from: '2026-08-01', to: '2026-08-31', gran: 'day' }));
// custom 两期显式指定 → lastDay 不干预
const cusClamp = T.comparePeriod({ preset: 'custom', time: { mode: 'custom', from: '2026-07-01', to: '2026-07-31' }, cmpTime: { mode: 'custom', from: '2025-07-01', to: '2025-07-31' } }, NOW, '2026-07-17');
ok('custom: 不截', cusClamp.base.to === '2026-07-31' && cusClamp.cmp.to === '2025-07-31');
// 无 lastDay(旧调用签名) → 完全不变
const noLd = T.comparePeriod({ preset: 'yoy', time: { mode: 'custom', from: '2026-07-01', to: '2026-07-31' } }, NOW);
ok('无lastDay: 兼容旧行为', eq(noLd.cmp, { from: '2025-07-01', to: '2025-07-31' }));

/* ---------- daySpan ---------- */
ok('daySpan 同日=1', T.daySpan('2026-07-12', '2026-07-12') === 1);
ok('daySpan 12天', T.daySpan('2026-07-01', '2026-07-12') === 12);
ok('daySpan 跨月', T.daySpan('2026-06-19', '2026-06-30') === 12);
ok('daySpan 跨年', T.daySpan('2024-12-30', '2025-01-01') === 3);

/* ---------- ⑤ aggMatrix 区间聚合 ---------- */
const M = {
  cats: ['2026-07-09', '2026-07-10', '2026-07-11', '2026-07-12'],
  series: [{ name: 'A', values: [10, 20, 30, 40] }, { name: 'B', values: [1, 2, 3, 4] }]
};
ok('sum 全区间(跨系列相加)', T.aggMatrix(M, '2026-07-09', '2026-07-12', 'sum') === 110);
ok('sum 子区间', T.aggMatrix(M, '2026-07-11', '2026-07-12', 'sum') === 77);
ok('last 末桶', T.aggMatrix(M, '2026-07-09', '2026-07-12', 'last') === 44);
ok('avg 桶均值', T.aggMatrix(M, '2026-07-09', '2026-07-12', 'avg') === 27.5);
ok('max', T.aggMatrix(M, '2026-07-09', '2026-07-12', 'max') === 44);
ok('min', T.aggMatrix(M, '2026-07-09', '2026-07-12', 'min') === 11);
ok('dayavg=区间和/自然天数(4天)', T.aggMatrix(M, '2026-07-09', '2026-07-12', 'dayavg') === 27.5);
ok('dayavg 天数>桶数(缺数据日也摊)', T.aggMatrix(M, '2026-07-05', '2026-07-12', 'dayavg') === 110 / 8);
ok('无匹配桶 → null (无数据显-)', T.aggMatrix(M, '2020-01-01', '2020-01-31', 'sum') === null);
ok('空矩阵 → null', T.aggMatrix({ cats: [], series: [] }, '2026-01-01', '2026-12-31', 'sum') === null);
ok('全桶为0仍返回0(非null)', T.aggMatrix({ cats: ['2026-07-12'], series: [{ name: 'A', values: [0] }] }, '2026-07-01', '2026-07-31', 'sum') === 0);

/* ---------- ⑥ 文档模型序列化往返 ---------- */
const doc = { v: 1, blocks: [
  { t: 'text', s: '本周 SO ' },
  { t: 'chip', cfg: { kind: 'value', dataset: 'psi', measure: 'sellOut', time: { mode: 'wtd' }, fmt: { unit: 'auto', decimals: 1 } } },
  { t: 'text', s: '，同比 ' },
  { t: 'chip', cfg: { kind: 'compare', dataset: 'psi', measure: 'sellOut', preset: 'yoy', time: { mode: 'wtd' }, fmt: { fmt: 'pct', decimals: 2 } } },
  { t: 'text', s: '。' }
] };
// v2: serialize 恒输出行模型；v1 输入自动迁移(单行,无 \n → 1 行)
const docV2 = T.deserialize(T.serialize(doc));
ok('v1→v2 迁移为 1 行', docV2.v === 2 && docV2.blocks.length === 1 && docV2.blocks[0].t === 'line');
ok('v1→v2 行内 5 个 run', docV2.blocks[0].runs.length === 5 && docV2.blocks[0].runs[1].t === 'chip');
ok('v2 再序列化幂等', eq(T.deserialize(T.serialize(docV2)), docV2));
ok('deserialize 坏档→空文档', eq(T.deserialize('{not json'), { v: 2, blocks: [] }));
ok('deserialize null→空文档', eq(T.deserialize(null), { v: 2, blocks: [] }));
ok('deserialize 非法blocks→空', eq(T.deserialize('{"v":1,"blocks":"x"}'), { v: 2, blocks: [] }));
// v1 多行文本按 \n 切行
const multi = T.deserialize('{"v":1,"blocks":[{"t":"text","s":"甲\\n乙"},{"t":"chip","cfg":{}}]}');
ok('v1 多行迁移切 2 行', multi.blocks.length === 2 && multi.blocks[1].runs.length === 2);
// v2 行模型规范化：坏 run 丢弃、样式规范、同样式相邻 run 合并
const v2raw = { v: 2, blocks: [ { t: 'line', a: 'r', runs: [
  { t: 'text', s: 'a', st: { b: 1 } }, { t: 'text', s: 'b', st: { b: 1 } }, null,
  { t: 'text', s: 'c', st: { fs: 999 } }, { t: 'chip', cfg: { k: 1 } } ] } ] };
const v2n = T.deserialize(JSON.stringify(v2raw));
ok('v2 相邻同样式合并', v2n.blocks[0].runs[0].s === 'ab' && v2n.blocks[0].runs[0].st.b === 1);
ok('v2 非法字号丢弃(999)', v2n.blocks[0].runs[1].st === undefined);
ok('v2 对齐保留', v2n.blocks[0].a === 'r');
ok('normSt 颜色校验', eq(T.normSt({ c: '#AABBCC' }), { c: '#aabbcc' }) && T.normSt({ c: 'red' }) === undefined);

/* ---------- renderText（blocks+已解析值→纯文本；v1/v2 双兼容） ---------- */
ok('renderText v1 拼接', T.renderText(doc.blocks, { 0: '5.5k', 1: '+4.96%' }) === '本周 SO 5.5k，同比 +4.96%。');
ok('renderText v1 未解析芯片→-', T.renderText(doc.blocks, {}) === '本周 SO -，同比 -。');
ok('renderText v2 拼接', T.renderText(docV2.blocks, { 0: '5.5k', 1: '+4.96%' }) === '本周 SO 5.5k，同比 +4.96%。');
ok('renderText v2 多行加换行', T.renderText(multi.blocks, { 0: '9' }) === '甲\n乙9');

/* ---------- ⑧ 自动序号 ---------- */
ok('序号识别 1. ', eq(T.numPrefixInfo('1. 认购'), { pre: '', n: 1, sep: '.', sp: ' ' }));
ok('序号识别 3、', eq(T.numPrefixInfo('3、认购'), { pre: '', n: 3, sep: '、', sp: '' }));
ok('非序号行→null', T.numPrefixInfo('周报:') === null && T.nextNumPrefix('abc') === null);
ok('续号 1. →2. ', T.nextNumPrefix('1. 认购xx') === '2. ');
ok('续号 9、→10、', T.nextNumPrefix('9、xx') === '10、');
ok('续号 2) →3) ', T.nextNumPrefix('2) xx') === '3) ');
ok('空序号项判定', T.isEmptyNumLine('3. ') === true && T.isEmptyNumLine('3. x') === false);

/* ---------- ⑨ 环比快捷口径 ---------- */
ok('momQuickTime day/week/month', eq(T.momQuickTime('day'), { mode: 'yesterday' }) && eq(T.momQuickTime('week'), { mode: 'wtd' }) && eq(T.momQuickTime('month'), { mode: 'mtd' }));
ok('momQuickTime 未知→null', T.momQuickTime('x') === null);
ok('口径名 同比', T.compareKindLabel({ preset: 'yoy' }) === '同比');
ok('口径名 日环比', T.compareKindLabel({ preset: 'mom', time: { mode: 'yesterday' } }) === '日环比');
ok('口径名 周环比', T.compareKindLabel({ preset: 'mom', time: { mode: 'wtd' } }) === '周环比');
ok('口径名 月环比', T.compareKindLabel({ preset: 'mom', time: { mode: 'mtd' } }) === '月环比');
ok('口径名 自定义基期环比', T.compareKindLabel({ preset: 'mom', time: { mode: 'lastN', n: 14 } }) === '环比');
ok('口径名 两期对比', T.compareKindLabel({ preset: 'custom' }) === '两期对比');

/* ---------- ⑦ chipToMatrixParams 映射 ---------- */
ok('psi sellOut→sum/period/day', eq(T.chipToMatrixParams({ dataset: 'psi', measure: 'sellOut', gran: 'day', filters: { model: ['X'] } }),
  { dataset: 'psi', measure: 'sellOut', agg: 'sum', catField: 'period', catGran: 'day', filters: { model: ['X'] } }));
ok('psi dos→last(快照)', T.chipToMatrixParams({ dataset: 'psi', measure: 'dos' }).agg === 'last');
ok('日均芯片映射为 avg 语义(matrix取sum底)', T.chipToMatrixParams({ dataset: 'psi', measure: 'sellOut', agg: 'dayavg' }).agg === 'sum');
ok('idc→quarter', T.chipToMatrixParams({ dataset: 'idc', measure: 'units' }).catField === 'quarter');
ok('aggType 日均→dayavg', T.aggType({ agg: 'dayavg' }) === 'dayavg');
ok('aggType 缺省→sum', T.aggType({}) === 'sum');

/* ---------- chipLabel ---------- */
ok('chipLabel 值', T.chipLabel({ kind: 'value', measure: 'sellOut', time: { mode: 'wtd' } }) === 'SO · 本周至今');
ok('chipLabel 同比', T.chipLabel({ kind: 'compare', measure: 'sellOut', preset: 'yoy' }) === 'SO 同比');
ok('chipLabel 最近N天', T.chipLabel({ kind: 'value', measure: 'sellIn', time: { mode: 'lastN', n: 30 } }) === 'SI · 最近30天');

console.log(f ? ('\n' + f + ' FAILED') : '\nALL PASS');
process.exit(f ? 1 : 0);

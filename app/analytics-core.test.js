// app/analytics-core.test.js — 确定性分析层：排名/对比/健康诊断由代码算
const A = require('./analytics-core.js');
let f = 0; const ok = (n, c, d) => { console.log((c ? 'PASS ' : 'FAIL ') + n + (!c && d !== undefined ? '  << ' + JSON.stringify(d) : '')); if (!c) f++; };

// —— 纯函数 ——
ok('T1 周走势剔除末端0周（报量延迟）后判走弱', (() => { const t = A.trendOf([1853, 1889, 1628, 1627, 1637, 1612, 1570, 0, 0]); return t.tailZeros === 2 && t.weeksUsed === 7 && t.dir === '走弱' && t.change < 0; })(), A.trendOf([1853, 1889, 1628, 1627, 1637, 1612, 1570, 0, 0]));
ok('T2 放量中的产品判走强', A.trendOf([26, 34, 147, 183, 211, 274, 311, 355, 410]).dir === '走强');
ok('T3 不足 4 周 → 数据不足', A.trendOf([1, 2, 0, 0]).dir === '数据不足');
ok('T4 走平', A.trendOf([100, 101, 99, 100, 102, 98]).dir === '走平');
ok('L1 渠道 DOS 红绿灯', A.dosLight(46, 'channel') === '绿' && A.dosLight(100, 'channel') === '黄' && A.dosLight(461, 'channel') === '红');
ok('L2 全流程 DOS 红绿灯阈值不同', A.dosLight(130, 'flow') === '黄' && A.dosLight(130, 'channel') === '红');
ok('S1 上市阶段：3 个月内=放量期', A.stageOf({ shipLate: '2026/07/01' }, '2026-09-11') === '上市放量期');
ok('S2 上市阶段：已过销售结束=已退市', A.stageOf({ shipLate: '2025/01/01', salesEnd: '2026/06/30' }, '2026-09-11') === '已退市');
ok('S3 无路标 → null（不编）', A.stageOf(null, '2026-09-11') === null);

// —— 合成数据 ——
const R = {
  product: { rows: [
    { key: 'A', line: 'L1', cumCur: 1000, cumPrev: 800, yoy: 0.25, siCur: 900, siPrev: 1000, siYoy: -0.1, inv: 500, dos: 50, flowInv: 600, flowDos: 60, weekly: [100, 100, 100, 90, 85, 80] },
    { key: 'B', line: 'L1', cumCur: 400, cumPrev: 500, yoy: -0.2, siCur: 700, siPrev: 300, siYoy: 1.33, inv: 900, dos: 200, flowInv: 950, flowDos: 210, weekly: [50, 50, 50, 50, 50, 50] },
    { key: 'C', line: 'L2', cumCur: 300, cumPrev: 0, yoy: null, siCur: 350, siPrev: 0, siYoy: null, inv: 100, dos: 30, flowInv: 120, flowDos: 36, weekly: [10, 20, 40, 60, 80, 100] },
  ], total: { key: '合计', cumCur: 1700, cumPrev: 1300, yoy: 0.3077, inv: 1500, dos: 70, weekly: [] }, asOf: '2026-08-17', hasFlow: true },
  line: { rows: [{ key: 'L1', cumCur: 1400, cumPrev: 1300, yoy: 0.077, inv: 1400, dos: 80, weekly: [] }, { key: 'L2', cumCur: 300, cumPrev: 0, yoy: null, inv: 100, dos: 30, weekly: [] }], total: {}, asOf: '2026-08-17' },
};
const FIN = { L1: { curYear: 2026, lv4: { rows: [{ key: 'A', rev26: 5000, revYoy: 0.1, gm26: 1000, gmr26: 0.2, nsip26: 270.4 }, { key: 'B', rev26: 3000, revYoy: -0.1, gm26: 500, gmr26: 0.1667, nsip26: 182 }] }, line: { rows: [{ key: 'L1', rev26: 8000, gm26: 1500, gmr26: 0.1875, nsip26: 200 }] } }, L2: { curYear: 2026, lv4: { rows: [] }, line: { rows: [{ key: 'L2', rev26: 1000 }] } } };
const T = A.build({
  report: async p => R[p.groupDim] || { rows: [] },
  financeProductBoard: async p => FIN[p.lv1[0]] || { lv4: { rows: [] }, line: { rows: [] } },
  financeOverview: async () => ({ toM: 6 }),
  roadmapProducts: () => [{ name: 'C', shipLate: '2026/07/15' }, { name: 'B', shipLate: '2024/01/01', salesEnd: '2026/06/30' }],
  today: () => '2026-09-11',
});

(async () => {
  const r1 = await T.rankItems({ dim: 'product', by: 'dos' });
  ok('R1 按渠道DOS降序：B(200) 第一且红灯', r1.items[0].name === 'B' && r1.items[0].渠道DOS灯 === '红' && r1.items[0].名次 === 1, r1.items.map(i => [i.name, i.值]));
  const r2 = await T.rankItems({ dim: 'product', by: 'yoy' });
  ok('R2 同比排名把去年为 0 的 C 排除并说明原因', r2.items.map(i => i.name).join(',') === 'A,B' && r2.未参与排名.some(x => x.name === 'C' && /不可比/.test(x.reason)), r2.未参与排名);
  ok('R2b 同比以百分数给出（25 / −20），不是小数', r2.items[0].值 === 25 && r2.items[1].值 === -20);
  const r3 = await T.rankItems({ dim: 'product', by: 'contribution' });
  // 新品去年为 0，贡献量就是它今年的全部（总增量 = Σ各产品增量，新品一分不少）
  ok('R3 贡献量 = 今年累计 − 去年同期：C(300) > A(200) > B(−100)', r3.items.map(i => i.name + ':' + i.值).join(',') === 'C:300,A:200,B:-100', r3.items.map(i => [i.name, i.值]));
  const r4 = await T.rankItems({ dim: 'product', by: 'rev' });
  ok('R4 财经指标排名：按产品线各取 lv4 后合并，A 收入 5000 第一', r4.items[0].name === 'A' && r4.items[0].值 === 5000 && /1–6 月/.test(r4.口径));
  const r5 = await T.rankItems({ dim: 'country', by: 'rev' });
  ok('R5 国家维度没有财经 → 明确报错，不冒充', !!r5.error && /没有财经数据/.test(r5.error));
  const r6 = await T.rankItems({ dim: 'product', by: 'cumCur', minCum: 350 });
  ok('R6 minCum 排除小体量并说明', r6.items.map(i => i.name).join(',') === 'A,B' && r6.未参与排名.some(x => x.name === 'C'));
  const h = await T.healthCheck({ dim: 'product' });
  const tag = n => h.items.find(i => i.name === n).标记;
  ok('H1 A：渠道去库存 + 周销走弱', tag('A').indexOf('渠道去库存(SI降SO不降)') >= 0 && tag('A').indexOf('周销走弱') >= 0, tag('A'));
  ok('H2 B：红灯 + 同比下滑 + 压货嫌疑 + 已退市', ['渠道DOS红灯(>120)', 'SO同比下滑', '压货嫌疑(SI/SO>1.3)', '已退市'].every(x => tag('B').indexOf(x) >= 0), tag('B'));
  ok('H3 C：放量期 + 周销走强，且列入「不可比」', tag('C').indexOf('上市放量期(同比基数小)') >= 0 && tag('C').indexOf('周销走强') >= 0 && h.不可比_去年同期为0.indexOf('C') >= 0, tag('C'));
  ok('H4 清单：红灯=[B]，去库存=[A]，走弱=[A]，走强=[C]', h.红灯.join() === 'B' && h.渠道去库存.map(x => x.name).join() === 'A' && h.周销走弱.map(x => x.name).join() === 'A' && h.周销走强.map(x => x.name).join() === 'C');
  const c = await T.compareItems({ dim: 'product', names: ['A', 'B'] });
  ok('C1 对比：累计SO A 领先，差值 600，倍数 2.5', c.对比.累计SO.领先 === 'A' && c.对比.累计SO.差值 === 600 && c.对比.累计SO.倍数 === 2.5, c.对比.累计SO);
  ok('C2 对比：渠道DOS 越低越好 → A 领先', c.对比.渠道DOS.领先 === 'A' && c.对比.渠道DOS.更优方向 === '越低越好');
  ok('C3 对比含财经：NSIP A=270.4 领先', c.对比.NSIP.领先 === 'A' && c.items[0].NSIP === 270.4);
  const c2 = await T.compareItems({ dim: 'product', names: ['A', 'X'] });
  ok('C4 名称不存在 → 报错并列出已有取值', !!c2.error && /不存在/.test(c2.error) && /A\/B\/C/.test(c2.error));
  const c3 = await T.compareItems({ dim: 'product', names: ['A', 'C'] });
  ok('C5 一方缺同比 → 该指标标「不比」，不编数', !!c3.对比.SO同比.说明);
  console.log(f ? (f + ' FAILED') : 'ALL PASS');
  process.exit(f ? 1 : 0);
})();

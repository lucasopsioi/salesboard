// app/ppt-table-fit.test.js — PPT 表格自适应列宽：自然宽度 / 铺满 / 削峰 / 缩字号 / 分页
const T = require('./ppt-table-fit.js');
let f = 0; const ok = (n, c, d) => { console.log((c ? 'PASS ' : 'FAIL ') + n + (!c && d !== undefined ? '  << ' + JSON.stringify(d) : '')); if (!c) f++; };
const sum = a => a.reduce((x, y) => x + y, 0);
const near = (a, b, e) => Math.abs(a - b) <= (e || 1e-6);

// —— 字宽模型 ——
ok('W1 中文按 1em 计（8pt 五个汉字 ≈ 40pt ≈ 0.556 英寸）', near(T.heuristicWidth('全流程库存', 8, false), 40 / 72, 1e-6), T.heuristicWidth('全流程库存', 8, false));
ok('W2 数字比汉字窄很多', T.heuristicWidth('12345', 8) < T.heuristicWidth('一二三四五', 8) * 0.6);
ok('W3 空串宽度为 0', T.heuristicWidth('', 8) === 0 && T.heuristicWidth(null, 8) === 0);
ok('W4 加粗略宽（表头是粗体，积起来会差出一列）', T.heuristicWidth('汇总', 8, true) > T.heuristicWidth('汇总', 8, false));
ok('W5 字号翻倍宽度翻倍', near(T.heuristicWidth('Slate Tab', 16), T.heuristicWidth('Slate Tab', 8) * 2, 1e-9));

// —— 自然宽度：取该列最长的那个格子 ——
const rows = [
  ['产品', '26累计SO', 'W22'],
  ['Slate Pro 13.2-inch', '1,910', '520'],
  ['Slate SE', '875', '61'],
];
const nat = T.naturalWidths(rows, { fontSize: 8, padIn: 0.06 });
ok('N1 每列取最宽的格子', nat.length === 3 && nat[0] > nat[1] && nat[1] > nat[2], nat);
ok('N2 含左右内边距', near(nat[2], T.heuristicWidth('26累计SO'.length > 3 ? 'W22' : 'W22', 8) + 0.12, 1e-6) || nat[2] > T.heuristicWidth('W22', 8), nat[2]);
ok('N3 空表不炸', T.naturalWidths([], {}).length === 0 && T.naturalWidths(null, {}).length === 0);
ok('N4 认 pptxgenjs 的 {text,options} 单元格且识别 bold', (() => {
  const o = { fontSize: 8, padIn: 0, minColIn: 0 };
  const a = T.naturalWidths([[{ text: '全流程库存合计', options: { bold: true } }]], o)[0];
  const b = T.naturalWidths([['全流程库存合计']], o)[0];
  return a > b;
})(), [T.naturalWidths([[{ text: '全流程库存合计', options: { bold: true } }]], { fontSize: 8, padIn: 0, minColIn: 0 })[0],
       T.naturalWidths([['全流程库存合计']], { fontSize: 8, padIn: 0, minColIn: 0 })[0]]);
ok('N5 参差不齐的行（有的行列数少）不越界', T.naturalWidths([['a', 'b', 'c'], ['d']], { fontSize: 8 }).length === 3);

// —— 装得下：等比放大，但放大倍数封顶（免得两列小表被拉成两条 6 英寸的巨柱）——
const d1 = T.distribute([1, 2, 3], 12, {});
ok('D1 装得下时等比放大，倍数封顶 1.6', near(sum(d1.colW), 6 * 1.6, 1e-3), d1);
ok('D2 放大后保持相对比例（1:2:3）', near(d1.colW[1] / d1.colW[0], 2, 1e-2) && near(d1.colW[2] / d1.colW[0], 3, 1e-2), d1.colW);
ok('D3 装得下 → 没有被挤的列', d1.squeezed.length === 0);
const d1b = T.distribute([4, 4, 4], 13, {});
ok('D3b 差一点就满时正好铺满（不超）', near(sum(d1b.colW), 13, 1e-3) && sum(d1b.colW) <= 13 + 1e-9, d1b);

// —— 装不下：削峰，小列不动 ——
const d2 = T.distribute([0.4, 0.4, 8], 5, { minColIn: 0.28 });
ok('D4 装不下时总宽恰好等于可用宽度', near(sum(d2.colW), 5, 1e-3), d2);
ok('D5 削的是最宽那列，两个小列保住自然宽度', near(d2.colW[0], 0.4, 1e-3) && near(d2.colW[1], 0.4, 1e-3) && d2.colW[2] < 8, d2.colW);
ok('D6 被削的列必须被报出来（不许静默挤压）', d2.squeezed.length === 1 && d2.squeezed[0] === 2, d2.squeezed);
ok('D7 空间紧张时超宽列被 maxColIn 封顶', (() => {
  const d = T.distribute([0.3, 0.3, 9], 3, { maxColIn: 2.6, minColIn: 0.28 });
  return d.colW[2] <= 2.6 + 1e-6 && sum(d.colW) <= 3 + 1e-6;
})(), T.distribute([0.3, 0.3, 9], 3, { maxColIn: 2.6, minColIn: 0.28 }));
ok('D8 宽松（装得下）时不封顶', T.distribute([0.3, 9], 12, { maxColIn: 2.6 }).colW[1] > 2.6);
ok('D9 默认不封顶：水位法自己就拦得住长行名吃掉整张片', (() => {
  const d = T.distribute([0.4, 0.4, 40], 5, {});                 // 一个荒唐长的行名
  return near(sum(d.colW), 5, 1e-3) && near(d.colW[0], 0.4, 1e-3) && d.squeezed.length === 1;
})(), T.distribute([0.4, 0.4, 40], 5, {}));

// —— 主入口：优先缩字号保住「不换行」 ——
const wide = [
  ['产品型号'].concat(Array.from({ length: 20 }, (_, i) => 'W' + (i + 20))),
  ['Slate Pro 13.2-inch 5G'].concat(Array.from({ length: 20 }, () => '12,345')),
];
const r1 = T.fit(wide, { availIn: 12.7, fontSize: 9, minFontSize: 6, measure: T.heuristicWidth });
ok('F1 21 列能在一张片内不挤（字号可能降）', r1.squeezed.length === 0, { fs: r1.fontSize, total: r1.totalIn, squeezed: r1.squeezed });
ok('F2 总宽铺满且不溢出幻灯片', sum(r1.colW) <= 12.7 + 1e-6 && sum(r1.colW) > 12.0, sum(r1.colW));
ok('F3 名称列明显宽于数字列（这正是等分列宽做不到的事）', r1.colW[0] > r1.colW[3] * 1.8, [r1.colW[0], r1.colW[3]]);
ok('F4 行高随字号给出', r1.rowH > 0 && r1.rowH < 0.4, r1.rowH);

// 极端：一行 60 列，缩到最小字号也放不下 → 必须如实报 squeezed，不能假装装下了
const crazy = [Array.from({ length: 60 }, (_, i) => '超长列名' + i), Array.from({ length: 60 }, () => '123,456,789')];
const r2 = T.fit(crazy, { availIn: 12.7, fontSize: 9, minFontSize: 6, measure: T.heuristicWidth });
ok('F5 实在放不下时如实报出被挤的列', r2.squeezed.length > 0, { n: r2.squeezed.length, fs: r2.fontSize });
ok('F6 即便被挤，总宽也不许溢出幻灯片', sum(r2.colW) <= 12.7 + 1e-2, sum(r2.colW));
ok('F7 字号已经降到下限才认输', r2.fontSize === 6, r2.fontSize);

// 少列时不该乱缩字号
const small = [['产品', 'SO'], ['Slate Tab', '1,910']];
const r3 = T.fit(small, { availIn: 12.7, fontSize: 9, minFontSize: 6, measure: T.heuristicWidth });
ok('F8 列少时保持基准字号', r3.fontSize === 9, r3.fontSize);
ok('F8b 列少时不把表拉满整张片（两列 6 英寸比换行还丑）', sum(r3.colW) < 6, sum(r3.colW));

// —— 列分页 ——
ok('P1 不超过阈值就单页', T.paginateCols(10, 0, true).length === 1 && T.paginateCols(10, 20, true).length === 1);
const pg = T.paginateCols(21, 8, true);
ok('P2 超阈值按列切页', pg.length === 3, pg.map(p => p.length));
ok('P3 每页都带上第 0 列（行名）', pg.every(p => p[0] === 0), pg.map(p => p[0]));
ok('P4 除第 0 列外所有列都被覆盖且不重复', (() => {
  const seen = [];
  pg.forEach(p => p.slice(1).forEach(i => seen.push(i)));
  const uniq = [...new Set(seen)].sort((a, b) => a - b);
  return uniq.length === 20 && uniq[0] === 1 && uniq[19] === 20 && seen.length === 20;
})(), pg);
ok('P5 pickCols 按下标取列', (() => {
  const p = T.pickCols([['a', 'b', 'c'], ['1', '2', '3']], [0, 2]);
  return p[0][1] === 'c' && p[1][1] === '3';
})());

// —— 和 pptxgenjs 打交道的四条硬约束（都是实测过的坑，别放松）——
ok('X1 margin 一律用 < 1 的英寸值（>= 1 会被 pptxgenjs 当成「磅」，差 36 倍）', (() => {
  const m = T.tableMargin();
  return m.length === 4 && m.every(v => v > 0 && v < 1);
})(), T.tableMargin());
ok('X2 预留的内边距 >= 真实会被吃掉的 margin（否则算着够、导出还是换行）',
  (T.CELL_MARGIN_IN + T.SLACK_IN) >= T.CELL_MARGIN_IN && T.SLACK_IN > 0, [T.CELL_MARGIN_IN, T.SLACK_IN]);
ok('X3 tableOpts 把 w 和 colW 一起给（只给 colW 时外框会掉回幻灯片宽的 75%）', (() => {
  const o = T.tableOpts({ colW: [4, 3, 2], rowH: 0.2, fontSize: 8 });
  return near(o.w, 9, 1e-9) && o.colW.length === 3 && Array.isArray(o.margin);
})(), T.tableOpts({ colW: [4, 3, 2], rowH: 0.2, fontSize: 8 }));
ok('X4 首行比别的行短时会被补齐，保证 colW.length === 首行列数', (() => {
  const r = T.fit([['A'], ['a', 'b', 'c']], { availIn: 10, measure: T.heuristicWidth });
  return r.colW.length === 3 && r.rows[0].length === 3;
})(), T.fit([['A'], ['a', 'b', 'c']], { availIn: 10, measure: T.heuristicWidth }).colW.length);
ok('X5 默认 padIn 就是 margin+余量（两个数不许各走各的）', (() => {
  const a = T.naturalWidths([['x']], { fontSize: 8, minColIn: 0 })[0];
  const b = T.naturalWidths([['x']], { fontSize: 8, minColIn: 0, padIn: T.CELL_MARGIN_IN + T.SLACK_IN })[0];
  return near(a, b, 1e-9);
})());

console.log(f ? (f + ' FAILED') : 'ALL PASS');
process.exit(f ? 1 : 0);

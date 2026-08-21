const RC = require('./roadmap-chart.js');
let f = 0; const ok = (n, c) => { console.log((c ? 'PASS ' : 'FAIL ') + n); if (!c) f++; };
const approx = (n, a, b) => ok(n, a != null && Math.abs(a - b) < 1e-6);

ok('ymNum', RC.ymNum('2026/7') === 2026 * 12 + 7);
const prods = [
  { id: 'p1', name: 'A', seriesGroup: 'S1', shipLate: '2026/1', compositeRrpUsd: 300, skus: [{ color: '#111', ram: '8GB', rom: '128GB' }], pricing: [{ country: '墨西哥', rrpLocal: 5000 }], predecessorId: '' },
  { id: 'p2', name: 'B', seriesGroup: 'S2', shipLate: '2026/12', compositeRrpUsd: 100, skus: [{ color: '#222' }], pricing: [], predecessorId: 'p1' },
];
const ts = RC.timeScale(prods);
approx('timeScale x min', ts.x('2026/1'), 0);
approx('timeScale x max', ts.x('2026/12'), 1);
/* 自动量程留白（2026-08-10 用户反馈：只有两个产品时一个顶天一个贴底，导出很难看）：
   上下各留 ~12% 并向好看的刻度取整 → 最高/最低不再压在 0/1 边缘，但顺序与相对位置不变。 */
const ps = RC.priceScale([300, 100]);
ok('priceScale 自动量程上下留白(最高价不贴顶)', ps.y(300) > 0.02 && ps.y(300) < 0.35);
ok('priceScale 自动量程上下留白(最低价不贴底)', ps.y(100) < 0.98 && ps.y(100) > 0.65);
ok('priceScale 顺序不变:高价在上、低价在下', ps.y(300) < ps.y(100));
ok('priceScale 量程真的包住数据', ps.min <= 100 && ps.max >= 300);
ok('priceScale 单点(全同价)也给出可用带宽', (() => { const s1 = RC.priceScale([250]); return s1.max > s1.min && s1.min <= 250 && s1.max >= 250; })());
approx('priceScale 手动量程原样尊重(顶)', RC.priceScale([300, 100], { from: 100, to: 300 }).y(300), 0);
approx('priceScale 手动量程原样尊重(底)', RC.priceScale([300, 100], { from: 100, to: 300 }).y(100), 1);
ok('productValue usd', RC.productValue(prods[0], 'usd') === 300);
ok('productValue local', RC.productValue(prods[0], 'local', '墨西哥') === 5000);
ok('productValue local missing', RC.productValue(prods[1], 'local', '墨西哥') === null);
const pp = RC.productPoints(prods, { mode: 'usd' });
ok('points count', pp.points.length === 2);
ok('point1 y 在留白后的量程内(不贴边)', pp.points[0].y > 0.02 && pp.points[0].y < 0.35);
ok('point dots', pp.points[0].dots[0] === '#111');
const ppl = RC.productPoints(prods, { mode: 'local', country: '墨西哥' });
ok('local missing flagged', ppl.points.find(p => p.id === 'p2').missing === true);

const ppts = RC.productPoints(prods, { mode: 'usd' }).points;
const bands = RC.seriesBands(ppts, {});
ok('bands count', bands.length === 2);
const outB = RC.productPoints(prods, { mode: 'usd' });
const bands2 = RC.seriesBands(outB.points, {}, outB.pScale);
ok('bands always fill', bands2.every(b => b.mode === 'fill'));
// 价格范围驱动色带：S1 给 from/to，色带按范围(经pScale)定位，且 y 在 [0,1]
const outR = RC.productPoints(prods, { mode: 'usd', seriesRanges: [{ from: 50, to: 350 }] });
const bandsR = RC.seriesBands(outR.points, { S1: { color: '#111', opacity: 0.2, from: 250, to: 320 } }, outR.pScale);
const bS1 = bandsR.find(b => b.series === 'S1');
ok('band range-driven within 0..1', bS1 && bS1.minY >= 0 && bS1.maxY <= 1 && bS1.minY < bS1.maxY);
ok('seriesRanges widens domain', outR.pScale.min <= 50 && outR.pScale.max >= 350);
const links = RC.successionLinks(ppts);
ok('succession 1 link', links.length === 1 && links[0].from && links[0].to);
const ex = RC.explodeBySku([{ id: 'p', name: 'X', seriesGroup: 'S', shipLate: '2026/1', compositeRrpUsd: 9, skus: [{ name: '黑', color: '#000', ram: '8GB' }, { name: '白', color: '#fff', ram: '8GB' }] }]);
ok('explode count', ex.length === 2 && ex[0].realId === 'p' && ex[0].name === 'X·黑');
ok('filterByYear', RC.filterByYear(prods, '2026').length === 2 && RC.filterByYear(prods, '2027').length === 0);

const geom = { W: 13.333, H: 7.5, padL: 1, padR: 0.4, padT: 1, padB: 0.7 };
const pr = RC.pptxRoadmap(prods, { mode: 'usd', seriesColors: { S1: { color: '#111', opacity: 0.2 } } }, geom);
ok('pptxRoadmap boxes count', pr.boxes.length === prods.length);
ok('pptxRoadmap boxes in bounds', pr.boxes.every(b => b.x >= 0 && b.y >= 0 && b.x + b.w <= geom.W + 0.01 && b.y + b.h <= geom.H + 0.01));
ok('pptxRoadmap bands full width', pr.bands.every(b => Math.abs(b.x - geom.padL) < 0.01 && Math.abs(b.w - (geom.W - geom.padL - geom.padR)) < 0.01));
ok('pptxRoadmap dots no hash', pr.boxes.every(b => b.dots.every(c => c.indexOf('#') < 0)));
ok('pptxRoadmap yTicks 5', pr.yTicks.length === 5);
ok('pptxRoadmap empty safe', RC.pptxRoadmap([], { mode: 'usd' }, geom).boxes.length === 0);

// --- extraTimes 扩展时间域 ---
const tsX = RC.timeScale([{ shipLate: '2026/6' }], ['2026/1']);
ok('extraTimes widens timeScale', tsX.x('2026/1') === 0 && tsX.x('2026/6') === 1);
// --- samplePoints 继承关联产品价位 ---
const sprods = [{ id: 'p1', shipLate: '2026/6', compositeRrpUsd: 300, seriesGroup: 'S', skus: [] }];
const outS = RC.productPoints(sprods, { mode: 'usd', extraTimes: ['2026/2'] });
const sp = RC.samplePoints([{ id: 's1', productId: 'p1', type: 'VN1', name: 'P1 VN1', code: 'B1', shipLate: '2026/2' }], sprods, { mode: 'usd', tScale: outS.tScale, pScale: outS.pScale });
ok('samplePoints y = product y', Math.abs(sp[0].y - outS.points[0].y) < 1e-9);
ok('samplePoints x = sample time', Math.abs(sp[0].x - outS.tScale.x('2026/2')) < 1e-9);
ok('samplePoints not missing', sp[0].missing === false && sp[0].type === 'VN1');
ok('samplePoints missing when product gone', RC.samplePoints([{ id: 's2', productId: 'nope', type: 'VN2', shipLate: '2026/2' }], sprods, { mode: 'usd', tScale: outS.tScale, pScale: outS.pScale })[0].missing === true);
// --- pptxRoadmap 纳入样机框 ---
const geomS = { W: 13.333, H: 7.5, padL: 1, padR: 0.4, padT: 1, padB: 0.7 };
const prS = RC.pptxRoadmap(sprods, { mode: 'usd', samples: [{ id: 's1', productId: 'p1', type: 'VN1', name: 'P1 VN1', code: 'B1', shipLate: '2026/2' }], sampleStyle: { color: '#E0A400', opacity: 0.85 } }, geomS);
ok('pptxRoadmap appends sample box', prS.boxes.some(b => b.sample === true && b.fill === 'E0A400'));
ok('pptxRoadmap sample box in bounds', prS.boxes.filter(b => b.sample).every(b => b.x >= 0 && b.y >= 0 && b.x + b.w <= geomS.W + 0.01));

// --- successionLinks 附带产品ID（hover 接续链定位用） ---
ok('succession link ids', links[0].fromId === 'p1' && links[0].toId === 'p2');

// --- orthoRoute 正交折线（斜线→水平段+直角竖段） ---
const orl = RC.orthoRoute([{ x1: 100, y1: 200, x2: 400, y2: 100 }], { gap: 14, pad: 10 });
const r0 = orl[0];
ok('ortho 三段', r0.segs.length === 3);
ok('ortho 首段水平且起点吻合', r0.segs[0].x1 === 100 && r0.segs[0].y1 === 200 && r0.segs[0].y2 === 200);
ok('ortho 中段竖直=车道x', r0.segs[1].x1 === r0.segs[1].x2 && r0.segs[1].x1 === r0.vx);
ok('ortho 末段水平且终点吻合', r0.segs[2].x2 === 400 && r0.segs[2].y1 === 100 && r0.segs[2].y2 === 100);
ok('ortho 段间连续', r0.segs[0].x2 === r0.segs[1].x1 && r0.segs[1].y2 === r0.segs[2].y1);
ok('ortho 竖线左右留空挡', r0.vx >= 110 && r0.vx <= 390);
ok('ortho 水平线单段', RC.orthoRoute([{ x1: 0, y1: 50, x2: 100, y2: 50 }])[0].segs.length === 1);
ok('ortho 空输入安全', RC.orthoRoute(null).length === 0);
// 车道防撞：两条同走廊（竖向区间重叠）的链 → 竖线错开 ≥ gap，且仍在留白范围内
const two = RC.orthoRoute([{ x1: 0, y1: 0, x2: 300, y2: 300 }, { x1: 0, y1: 10, x2: 300, y2: 290 }], { gap: 14, pad: 10 });
ok('ortho 竖线不重合', Math.abs(two[0].vx - two[1].vx) >= 14 - 1e-6);
ok('ortho 防撞后仍在范围内', two[1].vx >= 10 && two[1].vx <= 290);
// 竖向区间不重叠的两条线可同车道（不强行错开）
const far = RC.orthoRoute([{ x1: 0, y1: 0, x2: 300, y2: 100 }, { x1: 0, y1: 200, x2: 300, y2: 300 }], { gap: 14, pad: 10 });
ok('ortho 竖向不重叠可同x', Math.abs(far[0].vx - far[1].vx) < 1e-6);

// --- successionChain 前代+后代整链（hover 高亮用） ---
const chainProds = [{ id: 'a', predecessorId: '' }, { id: 'b', predecessorId: 'a' }, { id: 'c', predecessorId: 'b' }, { id: 'x', predecessorId: '' }];
ok('chain 中间查前代+后代全含', JSON.stringify(RC.successionChain(chainProds, 'b').sort()) === '["a","b","c"]');
ok('chain 从头查一致', JSON.stringify(RC.successionChain(chainProds, 'a').sort()) === '["a","b","c"]');
ok('chain 孤立=自身', JSON.stringify(RC.successionChain(chainProds, 'x')) === '["x"]');
ok('chain 未知id→空', RC.successionChain(chainProds, 'zz').length === 0);
ok('chain 空产品安全', RC.successionChain(null, 'a').length === 0);
const fork = [{ id: 'a' }, { id: 'b1', predecessorId: 'a' }, { id: 'b2', predecessorId: 'a' }];
ok('chain 分叉连通分量互含', JSON.stringify(RC.successionChain(fork, 'b1').sort()) === '["a","b1","b2"]');

// --- pptxRoadmap 接续线正交：全段水平或竖直，仅整链末段带箭头 ---
const prL = RC.pptxRoadmap(prods, { mode: 'usd' }, geom);
ok('pptx lines 正交', prL.lines.length >= 2 && prL.lines.every(l => Math.abs(l.x1 - l.x2) < 1e-9 || Math.abs(l.y1 - l.y2) < 1e-9));
ok('pptx lines 仅末段箭头', prL.lines.filter(l => l.arrow).length === 1 && prL.lines[prL.lines.length - 1].arrow === true);
ok('pptx lines 段间连续', prL.lines.slice(1).every((l, i) => Math.abs(l.x1 - prL.lines[i].x2) < 1e-9 && Math.abs(l.y1 - prL.lines[i].y2) < 1e-9));

console.log(f ? ('\n' + f + ' FAILED') : '\nALL PASS'); process.exit(f ? 1 : 0);

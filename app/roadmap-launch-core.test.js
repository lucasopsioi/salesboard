const RL = require('./roadmap-launch-core.js');
let f = 0; const ok = (n, c) => { console.log((c ? 'PASS ' : 'FAIL ') + n); if (!c) f++; };
const approx = (n, a, b) => ok(n, a != null && Math.abs(a - b) < 1e-6);

// --- dNum：天序数 / 月中 / 非法 ---
ok('dNum epoch', RL.dNum('1970/1/1') === 0);
ok('dNum day count', RL.dNum('1970/1/2') === 1);
ok('dNum YM = mid month (15日)', RL.dNum('1970/1') === RL.dNum('1970/1/15'));
ok('dNum illegal null', RL.dNum('') === null && RL.dNum('abc') === null && RL.dNum(null) === null);
ok('dNum ordering', RL.dNum('2026/3/1') < RL.dNum('2026/3/2') && RL.dNum('2026/2/28') < RL.dNum('2026/3/1'));

// --- fmtDisp：三种样式 + 区间 ---
ok('fmtDisp M.D', RL.fmtDisp('2026/5/3', '', 'M.D') === '5.3');
ok('fmtDisp M月D日', RL.fmtDisp('2026/5/3', '', 'M月D日') === '5月3日');
ok('fmtDisp YYYY/M/D', RL.fmtDisp('2026/5/3', '', 'YYYY/M/D') === '2026/5/3');
ok('fmtDisp range M.D', RL.fmtDisp('2026/2/26', '2026/3/15', 'M.D') === '2.26-3.15');
ok('fmtDisp range M月D日', RL.fmtDisp('2026/2/26', '2026/3/15', 'M月D日') === '2月26日-3月15日');
ok('fmtDisp YM style', RL.fmtDisp('2026/5', '', 'M.D') === '5.15' || RL.fmtDisp('2026/5', '', 'M.D') === '5月');
ok('fmtDisp empty date', RL.fmtDisp('', '', 'M.D') === '');

// --- presetNodeLib：预置词库 ---
const lib = RL.presetNodeLib();
ok('presetNodeLib array', Array.isArray(lib) && lib.length > 20);
ok('presetNodeLib shape', lib.every(x => x.label && x.cat));
ok('presetNodeLib has cats', ['研发认证', '样机物料', '供应发货', '销售节点', 'MKT大促'].every(c => lib.some(x => x.cat === c)));
ok('presetNodeLib has 全球发布会', lib.some(x => x.label === '全球发布会' && x.cat === 'MKT大促'));

// --- timelineLayout：线性 x + tier 防重叠 ---
const ms = [
  { id: 'm1', label: '预售', date: '2026/1/1' },
  { id: 'm2', label: '首销', date: '2026/12/31' },
];
const tl = RL.timelineLayout(ms, {});
approx('timeline x0', tl.pts[0].x, 0);
approx('timeline x1', tl.pts[1].x, 1);
ok('timeline t0<t1', tl.t0 < tl.t1);
ok('timeline single = 0.5', RL.timelineLayout([{ id: 's', label: 'X', date: '2026/5/1' }], {}).pts[0].x === 0.5);
ok('timeline sameday = 0.5', RL.timelineLayout([{ id: 'a', label: 'A', date: '2026/5/1' }, { id: 'b', label: 'B', date: '2026/5/1' }], {}).pts.every(p => p.x === 0.5));
// 密集 4 点：相邻很近 → tier 交错到两层
const dense = [
  { id: 'd1', label: 'N1', date: '2026/1/1' },
  { id: 'd2', label: 'N2', date: '2026/1/2' },
  { id: 'd3', label: 'N3', date: '2026/1/3' },
  { id: 'd4', label: 'N4', date: '2026/1/4' },
];
const tld = RL.timelineLayout(dense, { minGap: 0.5 });
ok('timeline tier only 0/1', tld.pts.every(p => p.tier === 0 || p.tier === 1));
ok('timeline dense alternates', tld.pts.map(p => p.tier).join('') === '0101');
ok('timeline pts sorted by x', tld.pts.every((p, i, a) => i === 0 || a[i - 1].x <= p.x));
// 区间节点 xEnd
const tlr = RL.timelineLayout([
  { id: 'r1', label: '预售', date: '2026/1/1' },
  { id: 'r2', label: '大促', date: '2026/6/1', dateEnd: '2026/7/1' },
  { id: 'r3', label: '结束', date: '2026/12/31' },
], {});
const rp = tlr.pts.find(p => p.id === 'r2');
ok('timeline range xEnd set', rp.xEnd != null && rp.xEnd > rp.x);
ok('timeline no-end xEnd null', tlr.pts.find(p => p.id === 'r1').xEnd === null);

// --- phaseLayout：clamp 0..1 ---
const phs = RL.phaseLayout([
  { from: '2026/1/1', to: '2026/6/1', text: '预热', color: '#E8E8E8' },
  { from: '2025/1/1', to: '2027/1/1', text: '越界', color: '' },
], RL.dNum('2026/1/1'), RL.dNum('2026/12/31'));
ok('phase count', phs.length === 2);
ok('phase clamp x>=0', phs.every(p => p.x >= 0 && p.x <= 1));
ok('phase clamp x+w<=1', phs.every(p => p.x + p.w <= 1 + 1e-9));
ok('phase overflow full', phs[1].x === 0 && Math.abs(phs[1].x + phs[1].w - 1) < 1e-9);
ok('phase keeps text', phs[0].text === '预热');

// --- curveScale：0 在底、纵向留白 8% ---
const cs = RL.curveScale([[10, 50, 100], [0, 30, 80]], {});
ok('curveScale max', cs.max === 100);
ok('curveScale y(max) near top', cs.y(100) < cs.y(0));
ok('curveScale y in 0..1', [0, 50, 100].every(v => cs.y(v) >= 0 && cs.y(v) <= 1));
ok('curveScale bottom padding', cs.y(0) < 1 && cs.y(0) > 0.9); // 底部留白 8% → y(0)≈0.92
ok('curveScale empty safe', RL.curveScale([], {}).max >= 0);

// --- pptxLaunch：A/B/C/D/E 布局 ---
const GEO = { W: 13.333, H: 7.5 };
const product = { id: 'p1', name: '荣耀X9', pricing: [{ country: '墨西哥' }, { country: '智利' }] };
const inPage = (o) => (o.x == null || (o.x >= -1e-6 && o.x <= GEO.W + 1e-6)) &&
  (o.y == null || (o.y >= -1e-6 && o.y <= GEO.H + 1e-6)) &&
  (o.w == null || o.x + o.w <= GEO.W + 1e-6) && (o.h == null || o.y + o.h <= GEO.H + 1e-6);
const noHash = (c) => c == null || String(c).indexOf('#') < 0;

// A 模板
const la = { template: 'A', accentColor: '#C7000B', dispStyle: 'M.D', milestones: [
  { id: 'a1', label: '预售', date: '2026/1/1' },
  { id: 'a2', label: '全球发布会', date: '2026/6/1' },
  { id: 'a3', label: '首销结束', date: '2026/12/1' },
] };
const pa = RL.pptxLaunch(la, product, GEO);
ok('pptxLaunch A has title', pa.title && typeof pa.title.text === 'string');
ok('pptxLaunch A axis', pa.axis && pa.axis.x1 != null && pa.axis.x2 > pa.axis.x1);
ok('pptxLaunch A tris = ms count', pa.tris.length === 3);
ok('pptxLaunch A labels = ms count', pa.labels.length === 3);
ok('pptxLaunch A dates = ms count', pa.dates.length === 3);
ok('pptxLaunch A all in page', [pa.title].concat(pa.tris, pa.labels, pa.dates).every(inPage));
ok('pptxLaunch A axis in page', pa.axis.x1 >= 0 && pa.axis.x2 <= GEO.W + 1e-6 && pa.axis.y1 >= 0 && pa.axis.y1 <= GEO.H);
ok('pptxLaunch A accent no hash', noHash(pa.accent) && (pa.accent === undefined || pa.accent === 'C7000B'));
ok('pptxLaunch A label text', pa.labels.some(l => l.text === '全球发布会'));
ok('pptxLaunch A date text fmt', pa.dates.some(d => d.text === '1.1'));

// B 模板：字号更小
const lb = Object.assign({}, la, { template: 'B' });
const pb = RL.pptxLaunch(lb, product, GEO);
ok('pptxLaunch B smaller font than A', pb.labels[0].fontSize < pa.labels[0].fontSize);
ok('pptxLaunch B in page', [pb.title].concat(pb.tris, pb.labels, pb.dates).every(inPage));

// C 模板：国家表 aoa
const lc = Object.assign({}, la, { template: 'C', countryCols: ['presale', 'online', 'offline', 'target'], countryRows: [
  { country: '墨西哥', presale: '5.1', online: '5.10', offline: '5.15', target: '1万' },
  { country: '智利', presale: '5.3', online: '5.12', offline: '5.18', target: '5千' },
] });
const pc = RL.pptxLaunch(lc, product, GEO);
ok('pptxLaunch C has table', pc.table && Array.isArray(pc.table.rowsAoa));
ok('pptxLaunch C aoa header+rows', pc.table.rowsAoa.length === 3); // 表头 + 2 国
ok('pptxLaunch C aoa cols = 国家+勾选列', pc.table.rowsAoa[0].length === 5); // 国家列 + 4 勾选
ok('pptxLaunch C colW matches', pc.table.colW.length === pc.table.rowsAoa[0].length);
ok('pptxLaunch C table in page', inPage({ x: pc.table.x, y: pc.table.y, w: pc.table.w }));
ok('pptxLaunch C axis raised', pc.axis.y1 < pa.axis.y1); // 轴上移到上半页
ok('pptxLaunch C country cell', pc.table.rowsAoa[1][0] === '墨西哥');

// D 模板：泳道 + 策略框
const ld = Object.assign({}, la, { template: 'D',
  phases: [{ from: '2026/1/1', to: '2026/4/1', text: '中国区物料预热种草', color: '#E8E8E8' }, { from: '2026/5/1', to: '2026/8/1', text: '圣诞大促评测出街', color: '' }],
  strategyBoxes: [{ from: '2026/2/1', to: '2026/3/1', text: '阶段策略' }] });
const pd = RL.pptxLaunch(ld, product, GEO);
ok('pptxLaunch D phaseRects', Array.isArray(pd.phaseRects) && pd.phaseRects.length === 2);
ok('pptxLaunch D strategyRects', Array.isArray(pd.strategyRects) && pd.strategyRects.length === 1);
ok('pptxLaunch D phase in page', pd.phaseRects.every(inPage));
ok('pptxLaunch D strategy in page', pd.strategyRects.every(inPage));
ok('pptxLaunch D phase text', pd.phaseRects.some(r => r.text === '中国区物料预热种草'));
ok('pptxLaunch D phase color no hash', pd.phaseRects.every(r => noHash(r.color)));
ok('pptxLaunch D phase below axis', pd.phaseRects.every(r => r.y >= pd.axis.y1 - 1e-6));

// E 模板：图表占位 + bandRects
const le = Object.assign({}, la, { template: 'E',
  curve: { startDate: '2026/1/1', gran: 'week',
    plan: { name: '本代推演', values: [10, 20, 30, 40, 30, 20], color: '#C7000B' },
    last: { name: '上代实际', values: [8, 15, 25, 35, 28, 18], color: '#888888' },
    bands: [{ from: '2026/1/15', to: '2026/2/1', text: '情人节', color: '#FFE0E0' }, { from: '2026/2/1', to: '2026/2/15', text: '促销', color: '' }] } });
const pe = RL.pptxLaunch(le, product, GEO);
ok('pptxLaunch E has chart', pe.chart && pe.chart.w > 0 && pe.chart.h > 0);
ok('pptxLaunch E chart in page', inPage(pe.chart));
ok('pptxLaunch E bandRects count', Array.isArray(pe.bandRects) && pe.bandRects.length === 2);
ok('pptxLaunch E bandRects in page', pe.bandRects.every(inPage));
ok('pptxLaunch E bandRects no hash', pe.bandRects.every(r => noHash(r.color)));
ok('pptxLaunch E axis below chart', pe.axis.y1 >= pe.chart.y + pe.chart.h - 1e-6);
ok('pptxLaunch E tris still there', pe.tris.length === 3 && pe.tris.every(inPage));

// 默认标题（空 title → 「<产品名> 上市节奏」）
ok('pptxLaunch default title', RL.pptxLaunch({ template: 'A', milestones: [] }, product, GEO).title.text.indexOf('荣耀X9') >= 0);
// 空里程碑安全
ok('pptxLaunch empty ms safe', RL.pptxLaunch({ template: 'A', milestones: [] }, product, GEO).tris.length === 0);
// 默认 geom（不传）
ok('pptxLaunch default geom', RL.pptxLaunch(la, product).title != null);

console.log(f ? ('\n' + f + ' FAILED') : '\nALL PASS'); process.exit(f ? 1 : 0);

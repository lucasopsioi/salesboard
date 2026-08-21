// 路标「四件套」纯函数测试：X 时间范围裁剪（含边界/空范围=自动/单侧）、SKU 售价聚合分框
// （0/1/多价、混合未设、同价合并、标签、本币换算、主框=最低价）、框样式合并（默认/全局/产品覆盖·缺省回退）。
// 见 roadmap-chart.js。风格照 roadmap-date.test.js。
const RC = require('./roadmap-chart.js');
let f = 0; const ok = (n, c) => { console.log((c ? 'PASS ' : 'FAIL ') + n); if (!c) f++; };

// 基础产品工厂
const P = (over) => Object.assign({ id: 'p', name: 'X7', seriesGroup: 'S', shipLate: '2025/06/15', compositeRrpUsd: 500, predecessorId: '', pricing: [], skus: [] }, over || {});

// ─────────────────────────────────────────────────────────────
// 1. X 时间范围裁剪
// ─────────────────────────────────────────────────────────────
const rp = [
  { id: 'a', name: 'A', seriesGroup: 'S', shipLate: '2025/01/15', compositeRrpUsd: 100, skus: [] },
  { id: 'b', name: 'B', seriesGroup: 'S', shipLate: '2025/06/15', compositeRrpUsd: 200, skus: [] },
  { id: 'c', name: 'C', seriesGroup: 'S', shipLate: '2025/12/15', compositeRrpUsd: 300, skus: [] },
];
const tsAuto = RC.timeScale(rp);
ok('无范围 active=false', tsAuto.active === false);
const tsR = RC.timeScale(rp, [], { from: '2025/03/01', to: '2025/09/01' });
ok('给范围 active=true', tsR.active === true);
ok('范围 minN=起', Math.abs(tsR.minN - RC.ymNum('2025/03/01')) < 1e-9);
ok('范围 maxN=止', Math.abs(tsR.maxN - RC.ymNum('2025/09/01')) < 1e-9);

const ppR = RC.productPoints(rp, { mode: 'usd', timeRange: { from: '2025/03/01', to: '2025/09/01' } });
ok('范围内只剩 B', ppR.points.length === 1 && ppR.points[0].productId === 'b');
ok('范围外计数 hidden=2', ppR.hidden === 2);

const ppB = RC.productPoints(rp, { mode: 'usd', timeRange: { from: '2025/01/15', to: '2025/12/15' } });
ok('边界含端点：全画', ppB.points.length === 3 && ppB.hidden === 0);

const ppE = RC.productPoints(rp, { mode: 'usd', timeRange: { from: '', to: '' } });
ok('空范围=自动：全画', ppE.points.length === 3 && ppE.hidden === 0);

const ppF = RC.productPoints(rp, { mode: 'usd', timeRange: { from: '2025/06/01', to: '' } });
ok('仅起点：裁掉更早(A)', ppF.points.length === 2 && ppF.hidden === 1 && !ppF.points.some(p => p.productId === 'a'));

const ppT = RC.productPoints(rp, { mode: 'usd', timeRange: { from: '', to: '2025/06/15' } });
ok('仅止点：裁掉更晚(C)', ppT.points.length === 2 && ppT.hidden === 1 && !ppT.points.some(p => p.productId === 'c'));

const ppNo = RC.productPoints(rp, { mode: 'usd' });
ok('不传范围：全画 hidden=0', ppNo.points.length === 3 && ppNo.hidden === 0);

// ─────────────────────────────────────────────────────────────
// 2. SKU 售价聚合分框
// ─────────────────────────────────────────────────────────────
const b0 = RC.skuPriceBoxes(P({ compositeRrpUsd: 500, skus: [{ name: 'a', ram: '8GB', rom: '128GB' }] }), { mode: 'usd' });
ok('0价→1框', b0.length === 1);
ok('0价→值=综合RRP', b0[0].value === 500);
ok('0价→名=产品名', b0[0].name === 'X7');
ok('0价→primary', b0[0].primary === true && b0[0].fallback === true);

const b1 = RC.skuPriceBoxes(P({ skus: [{ name: 'a', priceUsd: 300, ram: '8GB', rom: '128GB' }] }), { mode: 'usd' });
ok('1价→1框@该价', b1.length === 1 && b1[0].value === 300 && b1[0].primary === true);

const b1m = RC.skuPriceBoxes(P({ skus: [{ name: 'a', priceUsd: 150 }, { name: 'b' }] }), { mode: 'usd' });
ok('仅一SKU设价+另一未设→单框@该价', b1m.length === 1 && b1m[0].value === 150);

const bm = RC.skuPriceBoxes(P({ skus: [
  { name: '标准', priceUsd: 400, ram: '12', rom: '256' },
  { name: '高配', priceUsd: 600, ram: '12', rom: '512' },
  { name: '标准2', priceUsd: 400, ram: '12', rom: '256' },
] }), { mode: 'usd' });
ok('多价→2框(同价合并)', bm.length === 2);
ok('多价→升序', bm[0].value === 400 && bm[1].value === 600);
ok('最低价框=primary', bm[0].primary === true && bm[1].primary === false);
ok('同价合并2个SKU', bm[0].skus.length === 2);
ok('标签=产品名+配置', /X7/.test(bm[0].name) && /256/.test(bm[0].name) && /512/.test(bm[1].name));

const bx = RC.skuPriceBoxes(P({ skus: [{ name: 'a', priceUsd: 100 }, { name: 'b', priceUsd: 200 }, { name: 'c' }] }), { mode: 'usd' });
ok('混合未设→按已设价分框(未设不成框)', bx.length === 2 && bx[0].value === 100 && bx[1].value === 200);

// 本币模式：多框 = priceUsd * fx（沿用现有换算链路）
const bl = RC.skuPriceBoxes(P({ pricing: [{ country: 'MX', fx: 20, rrpLocal: 8000 }], skus: [{ name: 'a', priceUsd: 300 }, { name: 'b', priceUsd: 400 }] }), { mode: 'local', country: 'MX' });
ok('本币多框=priceUsd×fx', bl.length === 2 && bl[0].value === 300 * 20 && bl[1].value === 400 * 20);
// 本币模式：0价回退 = productValue(rrpLocal)
const blf = RC.skuPriceBoxes(P({ pricing: [{ country: 'MX', fx: 20, rrpLocal: 8000 }], skus: [{ name: 'a' }] }), { mode: 'local', country: 'MX' });
ok('本币0价→rrpLocal', blf[0].value === 8000);

// productPoints 多框 + 接续连主框
const mb = [
  { id: 'a', name: 'A', seriesGroup: 'S', shipLate: '2025/01/15', compositeRrpUsd: 100, predecessorId: '', skus: [] },
  { id: 'b', name: 'B', seriesGroup: 'S', shipLate: '2025/06/15', compositeRrpUsd: 200, predecessorId: 'a', skus: [
    { name: 'lo', priceUsd: 150, ram: '8', rom: '128' }, { name: 'hi', priceUsd: 250, ram: '8', rom: '256' },
  ] },
];
const mo = RC.productPoints(mb, { mode: 'usd' });
ok('多框产品→3点(A1+B2)', mo.points.length === 3);
ok('B低价框 primary', mo.points.filter(p => p.productId === 'b' && p.primary).length === 1);
const links = RC.successionLinks(mo.points);
ok('接续只连主框(1条)', links.length === 1 && links[0].from && links[0].to);
const bPrimary = mo.points.find(p => p.productId === 'b' && p.primary);
ok('接续终点=B主框', Math.abs(links[0].to.y - bPrimary.y) < 1e-9);

// 全未设 → 零回归（单框且值=综合RRP）
const zr = RC.productPoints([P({ id: 'z', skus: [{ name: 'a', color: '#111' }] })], { mode: 'usd' });
ok('全未设零回归：单框', zr.points.length === 1 && zr.points[0].value === 500 && zr.points[0].dots[0] === '#111');

// ─────────────────────────────────────────────────────────────
// 3. 框样式合并 global→product
// ─────────────────────────────────────────────────────────────
const D = RC.resolveBoxStyle();
ok('默认样式=现观感', D.fill === '#FFFFFF' && D.opacity === 1 && D.bold === true && D.fontSize === 12);
const g = RC.resolveBoxStyle({ fill: '#EEE', opacity: 0.5, bold: false, fontSize: 16 }, null);
ok('全局覆盖默认', g.fill === '#EEE' && g.opacity === 0.5 && g.bold === false && g.fontSize === 16);
const pr = RC.resolveBoxStyle({ fill: '#EEE', opacity: 0.5, bold: false, fontSize: 16 }, { fill: '#123', fontSize: 20 });
ok('产品覆盖部分字段', pr.fill === '#123' && pr.fontSize === 20);
ok('产品未设字段回退全局', pr.opacity === 0.5 && pr.bold === false);
const pe = RC.resolveBoxStyle({ fill: '#EEE' }, { fill: '', fontSize: null });
ok('空串/null 回退', pe.fill === '#EEE' && pe.fontSize === 12);

// productPoints 给每个点带解析后的 style
const pps = RC.productPoints(rp, { mode: 'usd', boxStyle: { fill: '#ABC', fontSize: 14 } });
ok('点带解析样式', pps.points[0].style && pps.points[0].style.fill === '#ABC' && pps.points[0].style.fontSize === 14);
// 产品级覆盖优先于全局
const ppOv = RC.productPoints([P({ id: 'o', boxStyle: { fill: '#999' } })], { mode: 'usd', boxStyle: { fill: '#ABC', fontSize: 14 } });
ok('产品级样式覆盖全局', ppOv.points[0].style.fill === '#999' && ppOv.points[0].style.fontSize === 14);

console.log(f ? ('\n' + f + ' FAILED') : '\nALL PASS'); process.exit(f ? 1 : 0);

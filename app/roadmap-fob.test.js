'use strict';
/* FOB→RRP 推算回归锁(用户 2026-08-25:Floor FOB=成本,音频×3/平板×2.5≈RRP,缺价产品落档位) */
const RC = require('./roadmap-chart.js');
let f = 0;
const ok = (n, c, x) => { console.log((c ? 'PASS ' : 'FAIL ') + n + (c ? '' : '   ← ' + (x || ''))); if (!c) f++; };

const FOB = {
  cells: {
    'TARVOS-W09DK|202607': 600, 'TARVOS-W09DK|202608': 620,   // 最新月 620
    'TARVOS-W09CK|202608': 680,
    'SONICX-T01|202608': 50,
    'OTHER-Z9|202608': 999,
  },
  names: { 'TARVOS-W09DK': 'Tarvos-W09DK', 'TARVOS-W09CK': 'Tarvos-W09CK', 'SONICX-T01': 'SonicX-T01', 'OTHER-Z9': 'Other-Z9' },
  months: [202607, 202608],
};
const mkP = o => Object.assign({ id: 'p1', name: '', internalCode: '', psiLink: '', category: '平板', compositeRrpUsd: null, skus: [] }, o);

/* 匹配 + 最新月 + 均值 + 平板乘数 */
const r1 = RC.fobEstimate([mkP({ internalCode: 'Tarvos' })], FOB, {});
ok('F1 internalCode 代号匹配到两个型号,取各自最新月均值×2.5', r1.list[0].compositeRrpUsd === Math.round((620 + 680) / 2 * 2.5), 'got ' + r1.list[0].compositeRrpUsd);
ok('F2 estIds/count 标记', r1.estIds.has('p1') && r1.count === 1);
ok('F3 原对象未被改(渲染副本)', (() => { const p = mkP({ internalCode: 'Tarvos' }); RC.fobEstimate([p], FOB, {}); return p.compositeRrpUsd === null; })());

/* 音频乘数 + psiLink 匹配 */
const r2 = RC.fobEstimate([mkP({ psiLink: 'SonicX-T01', category: '音频配件' })], FOB, {});
ok('F4 音频 ×3', r2.list[0].compositeRrpUsd === 150, 'got ' + r2.list[0].compositeRrpUsd);

/* 乘数可覆盖 */
const r3 = RC.fobEstimate([mkP({ internalCode: 'Tarvos' })], FOB, { multTablet: 2 });
ok('F5 乘数覆盖生效', r3.list[0].compositeRrpUsd === Math.round((620 + 680) / 2 * 2));

/* 有价产品不注入 */
const r4 = RC.fobEstimate([mkP({ internalCode: 'Tarvos', compositeRrpUsd: 499 })], FOB, {});
ok('F6 手填综合RRP 优先,不注入', r4.list[0].compositeRrpUsd === 499 && r4.count === 0);
const r5 = RC.fobEstimate([mkP({ internalCode: 'Tarvos', skus: [{ priceUsd: 399 }] })], FOB, {});
ok('F7 SKU 价存在也不注入', r5.count === 0);

/* 防误配:候选长度<3 丢弃;完全无关不命中 */
const r6 = RC.fobEstimate([mkP({ internalCode: 'W9' }), mkP({ id: 'p2', name: 'Nothing Related' })], FOB, {});
ok('F8 短代号(<3)与无关名不误配', r6.count === 0);

/* 无 FOB 数据 → 原样返回 */
const r7 = RC.fobEstimate([mkP({ internalCode: 'Tarvos' })], null, {});
ok('F9 无 FOB 数据原样返回', r7.count === 0 && r7.list[0].compositeRrpUsd === null);

console.log(f ? ('\n' + f + ' FAILED') : '\nALL PASS');
process.exit(f ? 1 : 0);

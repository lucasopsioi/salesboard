'use strict';
/* 行自定义顺序内核 + 周报周号(上一周)口径 回归锁 */
const RO = require('./row-order-core.js');
const AW = require('./audio-weekly-core.js');
let f = 0;
const ok = (n, c, x) => { console.log((c ? 'PASS ' : 'FAIL ') + n + (c ? '' : '   ← ' + (x || ''))); if (!c) f++; };
const J = JSON.stringify;

/* ---------- RowOrder.apply ---------- */
ok('O1 无存档 → 原序', J(RO.apply(['a', 'b', 'c'], null)) === J(['a', 'b', 'c']));
ok('O2 按存档重排', J(RO.apply(['a', 'b', 'c'], ['c', 'a', 'b'])) === J(['c', 'a', 'b']));
ok('O3 新品(不在存档)append 尾部且保持原相对顺序', J(RO.apply(['n1', 'a', 'n2', 'b'], ['b', 'a'])) === J(['b', 'a', 'n1', 'n2']));
ok('O4 存档里已消失的行忽略', J(RO.apply(['a', 'b'], ['x', 'b', 'y', 'a'])) === J(['b', 'a']));
ok('O5 排序前后集合恒等(不增不删)', J(RO.apply(['a', 'b', 'c'], ['c']).slice().sort()) === J(['a', 'b', 'c']));
ok('O6 存档重复项只认首个', J(RO.apply(['a', 'b'], ['b', 'b', 'a'])) === J(['b', 'a']));

/* ---------- RowOrder.move ---------- */
ok('O7 下移', J(RO.move(['a', 'b', 'c', 'd'], 0, 2)) === J(['b', 'c', 'a', 'd']));
ok('O8 上移', J(RO.move(['a', 'b', 'c', 'd'], 3, 0)) === J(['d', 'a', 'b', 'c']));
ok('O9 越界原样返回', J(RO.move(['a', 'b'], 0, 5)) === J(['a', 'b']));
ok('O10 不改入参', (() => { const src = ['a', 'b', 'c']; RO.move(src, 0, 2); return J(src) === J(['a', 'b', 'c']); })());

/* ---------- reportWeek:周报周号 = 上一整周(用户 2026-08-24 指正) ---------- */
const mk = (y, m, d) => new Date(y, m - 1, d);
ok('W1 周一(0824,本周W35) → 报 W34', AW.reportWeek(mk(2026, 8, 24)).full === '2026-W34', AW.reportWeek(mk(2026, 8, 24)).full);
ok('W2 周日(0823,本周W34) → 报 W33', AW.reportWeek(mk(2026, 8, 23)).full === '2026-W33');
ok('W3 年初跨年:0101(W1) → 报 2025-W52', AW.reportWeek(mk(2026, 1, 1)).full === '2025-W52');
ok('W4 0108(W2) → 报 2026-W01', AW.reportWeek(mk(2026, 1, 8)).full === '2026-W01');
ok('W5 label 补零', AW.reportWeek(mk(2026, 1, 8)).label === 'W01');
ok('W6 53周年份:2027-01-07(2026有W53) → 2026-W53', AW.reportWeek(mk(2027, 1, 7)).full === '2026-W53', AW.reportWeek(mk(2027, 1, 7)).full);

/* ---------- clampReportWeek:音频延迟报量 → 周号落数据末周(用户 2026-08-24 补充) ---------- */
const cal34 = { year: 2026, week: 34, label: 'W34', full: '2026-W34' };
ok('W7  音频数据停在 W32 → 报 W32(上上周)', AW.clampReportWeek(cal34, 2026, 32).full === '2026-W32');
ok('W8  数据=日历 → 用日历', AW.clampReportWeek(cal34, 2026, 34).full === '2026-W34');
ok('W9  当周已有数(W35) → 仍报日历上一周,不报不完整的本周', AW.clampReportWeek(cal34, 2026, 35).full === '2026-W34');
ok('W10 无数据锚点 → 日历兜底', AW.clampReportWeek(cal34, null, null).full === '2026-W34');
ok('W11 跨年比较按(year,week)', AW.clampReportWeek({ year: 2026, week: 1, label: 'W01', full: '2026-W01' }, 2025, 52).full === '2025-W52');
ok('W12 src 标记来源', AW.clampReportWeek(cal34, 2026, 32).src === 'data' && AW.clampReportWeek(cal34, null, null).src === 'cal');

console.log(f ? ('\n' + f + ' FAILED') : '\nALL PASS');
process.exit(f ? 1 : 0);

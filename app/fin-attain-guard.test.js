// app/fin-attain-guard.test.js
// 达成率分母守卫（2026-09-07 复盘）：经营分析首屏曾出现「BP完成率 51799351.9%」且标成绿色，
// 细看是 达成值/BP值 = 15.0M / 0.0M —— BP 是个约等于 0 的极小非零值，原判据 `a.bp ? ... : null`
// 只挡 0/null，isFinite 也拦不住有限的荒唐值。该值还会流进 AI 回答与导出，故在源头判掉。
require('../engine-core'); const { attainRate } = require('../engine-finance');
let f = 0; const ok = (n, c) => { console.log((c ? 'PASS ' : 'FAIL ') + n); if (!c) f++; };

ok('A1 正常达成率 15/30 = 0.5', attainRate(15, 30) === 0.5);
ok('A2 分母为 0 → null', attainRate(15, 0) === null);
ok('A3 分母 null/undefined → null', attainRate(15, null) === null && attainRate(15, undefined) === null);
ok('A4 分子 null → null', attainRate(null, 30) === null);
ok('A5 非有限值 → null', attainRate(Infinity, 30) === null && attainRate(15, NaN) === null);
// 核心用例：真实故障现场
ok('A6 分母塌缩(15M ÷ 0.29) → null，不再报 5 千万%', attainRate(15000000, 0.29) === null);
// 守卫不能误伤真实的超额/欠额
ok('A7 合理超额 120/100 保留', attainRate(120, 100) === 1.2);
ok('A8 严重欠额 5/100 保留', attainRate(5, 100) === 0.05);
ok('A9 阈值边界：1000 倍仍保留', attainRate(1000, 1) === 1000);
ok('A10 阈值边界：1001 倍判掉', attainRate(1001, 1) === null);
ok('A11 负分母按绝对值判塌缩', attainRate(15000000, -0.29) === null);
ok('A12 负值达成率（亏损口径）本身不被误杀', attainRate(-50, 100) === -0.5);

console.log(f ? (f + ' FAILED') : 'ALL PASS');
process.exit(f ? 1 : 0);

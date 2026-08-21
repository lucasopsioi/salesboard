// app/sosim-core.test.js
const S = require('./sosim-core.js');
let fails = 0;
const ok = (name, cond) => { console.log((cond ? 'PASS ' : 'FAIL ') + name); if (!cond) fails++; };

ok('ymdToYm', S.ymdToYm(20250206) === 202502);
ok('daysInYm feb2025', S.daysInYm(202502) === 28);
ok('daysInYm feb2024', S.daysInYm(202402) === 29);
ok('daysInYm jan', S.daysInYm(202501) === 31);
const ds = S.enumDays(20250130, 20250202);
ok('enumDays span month', ds.length === 4 && ds[0] === 20250130 && ds[3] === 20250202);
ok('bucketOf month', S.bucketOf(20250206, 'month') === '202502');
ok('bucketOf quarter', S.bucketOf(20250206, 'quarter') === '2025Q1');
ok('bucketOf year', S.bucketOf(20250206, 'year') === '2025');
ok('bucketOf day', S.bucketOf(20250206, 'day') === '20250206');
ok('bucketOf week simple', S.bucketOf(20250206, 'week') === '2025-W06');
ok('bucketOf week 2020-W53 (jan1 2021)', S.bucketOf(20210101, 'week') === '2020-W53');
ok('bucketOf week 2025-W01 (dec30 2024)', S.bucketOf(20241230, 'week') === '2025-W01');

// --- Task 3 ---
const units = [
  { region: 'LA', rep: 'MX', country: '墨西哥', line: '平板', family: 'Slate Pro', series: 'Rigel', model: 'Rigel-W09CK' },
  { region: 'LA', rep: 'MX', country: '墨西哥', line: '平板', family: 'Slate Pro', series: 'Rigel', model: 'Rigel-W09DK' },
  { region: 'LA', rep: 'CO', country: '哥伦比亚', line: '平板', family: 'Slate Pro', series: 'Rigel', model: 'Rigel-W09CK' },
];
const inScope = S.childrenInScope(units, { region: 'LA', family: 'Slate Pro' });
ok('childrenInScope region+family = 3', inScope.length === 3);
const mxOnly = S.childrenInScope(units, { country: '墨西哥' });
ok('childrenInScope country = 2', mxOnly.length === 2);
const k = S.unitKey;
const hist = new Map([
  [k('墨西哥', 'Rigel-W09CK'), 80], [k('墨西哥', 'Rigel-W09DK'), 0], [k('哥伦比亚', 'Rigel-W09CK'), 20],
]);
const ratios = S.splitRatios(units, hist);
ok('ratio mx-ck 0.8', Math.abs(ratios.get(k('墨西哥', 'Rigel-W09CK')) - 0.8) < 1e-9);
ok('ratio mx-dk 0 (hist 0)', ratios.get(k('墨西哥', 'Rigel-W09DK')) === 0);
ok('ratio co-ck 0.2', Math.abs(ratios.get(k('哥伦比亚', 'Rigel-W09CK')) - 0.2) < 1e-9);
const zero = S.splitRatios(units, new Map());
ok('all-zero hist → all 0', [...zero.values()].every(v => v === 0));

// --- Task 4 ---
const store = new Map();
S.setForecast(store, {
  scope: { region: 'LA', family: 'Slate Pro' }, metric: 'sellOut',
  fromYmd: 20260201, toYmd: 20260228, value: 280, units, histSO: hist,
});
// mx-ck 占 0.8 → 224 / 28 天 = 8/天；co-ck 占 0.2 → 56/28 = 2/天；mx-dk 0
ok('fc mx-ck day', Math.abs(S.getForecast(store, '墨西哥', 'Rigel-W09CK', 20260210, 'sellOut') - 8) < 1e-9);
ok('fc co-ck day', Math.abs(S.getForecast(store, '哥伦比亚', 'Rigel-W09CK', 20260210, 'sellOut') - 2) < 1e-9);
ok('fc mx-dk 0', S.getForecast(store, '墨西哥', 'Rigel-W09DK', 20260210, 'sellOut') === 0);
// 月合计回收 = 280
let sum = 0; S.enumDays(20260201, 20260228).forEach(d => {
  sum += S.getForecast(store, '墨西哥', 'Rigel-W09CK', d, 'sellOut') + S.getForecast(store, '哥伦比亚', 'Rigel-W09CK', d, 'sellOut');
});
ok('month total back to 280', Math.abs(sum - 280) < 1e-6);
// 最后写入为准：在型号层覆盖 mx-ck
S.setForecast(store, { scope: { country: '墨西哥', model: 'Rigel-W09CK' }, metric: 'sellOut', fromYmd: 20260201, toYmd: 20260228, value: 28, units, histSO: hist });
ok('last-write-wins mx-ck=1/day', Math.abs(S.getForecast(store, '墨西哥', 'Rigel-W09CK', 20260210, 'sellOut') - 1) < 1e-9);
ok('co-ck untouched=2/day', Math.abs(S.getForecast(store, '哥伦比亚', 'Rigel-W09CK', 20260210, 'sellOut') - 2) < 1e-9);
// round-trip
const ser = S.serializeStore(store);
ok('serialize array', Array.isArray(ser) && ser.length > 0 && 'metric' in ser[0]);
const store2 = S.deserializeStore(ser);
ok('roundtrip equal', S.getForecast(store2, '哥伦比亚', 'Rigel-W09CK', 20260210, 'sellOut') === 2);

// --- Task 5 ---
const ctx = { cutoffYmd: 20260131, actual: new Map() };
// 历史实际：墨西哥 Rigel-W09CK 1/15 卖 10
ctx.actual.set(S.skey('墨西哥', 'Rigel-W09CK', 20260115, 'sellOut'), 10);
// 未来用前面 store（mx-ck 型号层 1/天 整个 2 月；co-ck 2/天）
const aggJan = S.aggregate(ctx, store, { region: 'LA', family: 'Slate Pro' }, units, 'sellOut', 'month', 20260101, 20260131);
ok('agg jan actual = 10', aggJan.get('202601') === 10);
const aggFeb = S.aggregate(ctx, store, { region: 'LA', family: 'Slate Pro' }, units, 'sellOut', 'month', 20260201, 20260228);
ok('agg feb forecast = 28 (mx) + 56 (co)', Math.abs(aggFeb.get('202602') - (28 + 56)) < 1e-6);

// --- normId：发货↔PSI 归一化配对键（治"老库存永不消耗"根因）---
ok('normId 尾空格', S.normId('Vantor6 ') === 'vantor6');
ok('normId 内部空格', S.normId('Astra 60') === 'astra60');
ok('normId 全角空格', S.normId('Astra　60') === 'astra60');
ok('normId 全角字母数字→半角', S.normId('Ｖantor６') === 'vantor6');   // Ｖantor６（全角）
ok('normId 大小写', S.normId('VANTOR6') === 'vantor6');
ok('normId null/空', S.normId(null) === '' && S.normId(undefined) === '');
ok('normId 不同型号不相等', S.normId('Vantor6') !== S.normId('Vantor6Pro'));
ok('normId 中文原样保留', S.normId('巴西 ') === '巴西');

// --- parseClipGrid / parseCellNum:Excel 剪贴板 TSV → 网格(供看板批量粘贴) ---
const g1 = S.parseClipGrid('100\t200\t300\r\n');
ok('clip 单行3列(去\\r与尾空行)', g1.length === 1 && g1[0].length === 3 && g1[0][1] === '200');
const g2 = S.parseClipGrid('1\n2\n3\n');
ok('clip 单列3行', g2.length === 3 && g2[1][0] === '2');
const g3 = S.parseClipGrid('1\t\t3\n4\t5\t6\n\n');
ok('clip 矩形+行中空格保留+多尾空行剔除', g3.length === 2 && g3[0][1] === '' && g3[1][2] === '6');
ok('clip 空文本 → 空网格', S.parseClipGrid('').length === 0 && S.parseClipGrid(null).length === 0);
ok('num 千分位/空白', S.parseCellNum(' 1,234 ') === 1234);
ok('num 货币符', S.parseCellNum('$150') === 150 && S.parseCellNum('￥88') === 88);
ok('num 空串/非数 → null', S.parseCellNum('') === null && S.parseCellNum('abc') === null);
ok('num 小数/负数', S.parseCellNum('3.5') === 3.5 && S.parseCellNum('-20') === -20);

console.log(fails ? ('\n' + fails + ' FAILED') : '\nALL PASS');
process.exit(fails ? 1 : 0);

'use strict';
/* ============================================================
   eval/ground-truth.js —— 真值核对器（看板=裁判的自动化版）
   用引擎重算 eval-set.js 里每个烤定的数值，逐项对照并报 OK/漂移。
   什么时候跑：改了引擎口径、重新生成 demo 数据、或怀疑题库过期时。
   用法：node eval/ground-truth.js   （全 OK 退出码 0，有漂移退出码 1）
   ============================================================ */
const { mountEngine, buildRegistry } = require('./engine-tools.js');

const qsum = (q) => { // query 返回 {buckets, series:[名], data:{名:{桶:值}}}
  const per = {}; let tot = 0;
  (q.series || []).forEach(n => {
    per[n] = Object.values(q.data[n] || {}).reduce((a, b) => a + (+b || 0), 0);
    tot += per[n];
  });
  return { per, tot };
};

let drift = 0;
function check(id, label, got, want, tol) {
  const ok = Math.abs(got - want) <= (tol || Math.max(1, Math.abs(want) * 0.001));
  if (!ok) drift++;
  console.log((ok ? 'OK    ' : 'DRIFT ') + id.padEnd(7) + label.padEnd(28) + '算得 ' + got + '  题库 ' + want);
}

(async () => {
  const T = buildRegistry(await mountEngine());

  /* C1-01 Mexico Slate 11 Pro 2026上半年SO */
  const c101 = qsum(await T.query({ stackDim: 'country', metric: 'sellOut', gran: 'month', from: '2026-01-01', to: '2026-06-30', filters: { country: ['Mexico'], product: ['Slate 11 Pro'] } }));
  check('C1-01', 'MexicoS11P上半年SO', c101.tot, 5645);

  /* C1-02 ColombiaQ2平板SI */
  const c102 = qsum(await T.query({ stackDim: 'country', metric: 'sellIn', gran: 'month', from: '2026-04-01', to: '2026-06-30', filters: { country: ['Colombia'], line: ['平板'] } }));
  check('C1-02', 'ColombiaQ2平板SI', c102.tot, 5556);

  /* C1-03 Brazil Slate 11 库存 */
  const c103 = await T.report({ groupDim: 'product', filters: { country: ['Brazil'], product: ['Slate 11'] } });
  check('C1-03', 'BrazilSlate11库存', c103.rows[0].inv, 1559);

  /* C1-04 音频实际收入(1-6月) */
  const c104 = await T.financeProductBoard({});
  const audioRow = c104.line.rows.find(r => r.key.indexOf('音频') >= 0);
  check('C1-04', '音频实际收入USD', audioRow.rev26, 3742032, 5);

  /* C1-05 Slate SE 11 累计与同比 */
  const c105 = (await T.report({ groupDim: 'product', filters: { product: ['Slate SE 11'] } })).rows[0];
  check('C1-05', 'SE11累计SO', c105.cumCur, 37064);
  check('C1-05', 'SE11同比%', +(100 * c105.yoy).toFixed(1), 22.8, 0.15);

  /* C1-06 Mexico渠道占比 */
  const c106 = qsum(await T.query({ stackDim: 'channel', metric: 'sellOut', gran: 'month', from: '2026-01-01', to: '2026-08-17', filters: { country: ['Mexico'] } }));
  check('C1-06', 'Online%', +(100 * c106.per.Online / c106.tot).toFixed(1), 42.4, 0.15);
  check('C1-06', 'Offline%', +(100 * c106.per.Offline / c106.tot).toFixed(1), 57.6, 0.15);

  /* C2-02 / C2-06 整体BP达成（Σ实际/ΣBP） */
  const tot = c104.line.total;
  check('C2-02', '整体BP达成%', +(100 * tot.bpAttain).toFixed(2), 35.45, 0.06);

  /* C3-01 Slate SE 10 清尾三件套 */
  const c301 = (await T.report({ groupDim: 'product', filters: { product: ['Slate SE 10'] } })).rows[0];
  check('C3-01', 'SE10库存', c301.inv, 247);
  check('C3-01', 'SE10 DOS', c301.dos, 461, 3);
  check('C3-01', 'SE10近4周SO', c301.last4, 15, 2);

  /* C3-02 家族结构 */
  const fam = (await T.report({ groupDim: 'family' })).rows;
  const se = fam.find(r => r.key === 'Slate SE');
  check('C3-02', 'SlateSE家族同比%', +(100 * se.yoy).toFixed(1), -13.5, 0.2);

  /* C3-03 音频量价 */
  check('C3-03', '音频收入同比%', +(100 * audioRow.revYoy).toFixed(1), 112.3, 0.2);
  check('C3-03', '音频NSIP26', +audioRow.nsip26.toFixed(2), 39.96, 0.05);

  /* C3-04 PSI SI vs 财经收入量 */
  const lines = (await T.report({ groupDim: 'line' })).rows;
  const psiSi = lines.reduce((a, r) => a + r.siCur, 0);
  const fin = await T.financeOverview({});
  check('C3-04', 'PSI SI合计', psiSi, 226823);
  check('C3-04', '财经收入量', fin.metrics.sellIn.actual, 226823);

  /* C4-01 Slate 12 Pro */
  const c401 = (await T.report({ groupDim: 'product', filters: { product: ['Slate 12 Pro'] } })).rows[0];
  check('C4-01', 'S12P今年累计', c401.cumCur, 1998);
  check('C4-01', 'S12P去年同期', c401.cumPrev, 0, 0);

  /* C4-02 样机→放量（2025-03/04 小量，05 起量） */
  const c402 = await T.query({ stackDim: 'product', metric: 'sellOut', gran: 'month', from: '2025-01-01', to: '2025-12-31', filters: { product: ['Slate 11 Pro'] } });
  const m402 = c402.data['Slate 11 Pro'] || {};
  check('C4-02', 'S11P 2025-03(样机)', m402['2025-03'] || 0, 104, 5);
  check('C4-02', 'S11P 2025-05(放量)', m402['2025-05'] || 0, 1162, 12);

  /* C4-03 SonicArc 爬坡 */
  const c403 = await T.query({ stackDim: 'product', metric: 'sellOut', gran: 'month', from: '2026-01-01', to: '2026-08-17', filters: { product: ['SonicArc'] } });
  const m403 = c403.data['SonicArc'] || {};
  check('C4-03', 'SonicArc 2026-02', m403['2026-02'] || 0, 409, 5);
  check('C4-03', 'SonicArc 2026-06', m403['2026-06'] || 0, 1666, 10);

  /* C4-05 季节性 */
  const c405 = await T.query({ stackDim: 'line', metric: 'sellOut', gran: 'month', from: '2025-10-01', to: '2026-02-28', filters: {} });
  const mm = {}; (c405.series || []).forEach(n => Object.entries(c405.data[n] || {}).forEach(([b, v]) => { mm[b] = (mm[b] || 0) + (+v || 0); }));
  check('C4-05', '2025-12旺季SO', mm['2025-12'], 43258, 50);
  check('C4-05', '2026-01回落SO', mm['2026-01'], 21264, 50);

  /* C5-04 半内半外 */
  const c504 = await T.query({ stackDim: 'line', metric: 'sellOut', gran: 'month', from: '2026-07-01', to: '2026-12-31', filters: {} });
  const m7 = (c504.series || []).reduce((a, n) => a + (+(c504.data[n] || {})['2026-07'] || 0), 0);
  const m8 = (c504.series || []).reduce((a, n) => a + (+(c504.data[n] || {})['2026-08'] || 0), 0);
  check('C5-04', '2026-07全月SO', m7, 29620, 30);
  check('C5-04', '2026-08截至8-17', m8, 14113, 30);
  check('C5-04', '仅出现7/8两桶', (c504.buckets || []).length, 2, 0);

  /* 边界事实 */
  const meta = await T.meta();
  console.log('FACT  边界     数据范围 ' + meta.from + ' ~ ' + meta.to + ' ｜ 财经年份 ' + JSON.stringify(meta.finMeta.years) + ' ｜ hasIdc=' + meta.hasIdc);

  console.log(drift === 0 ? '\n全部真值 OK —— 题库与引擎一致。' : '\n有 ' + drift + ' 项漂移 —— 先修题库或查引擎/数据变更，再跑评测！');
  process.exit(drift === 0 ? 0 : 1);
})().catch(e => { console.error('FAIL', e); process.exit(1); });

'use strict';
/* 音频周报内核黄金测试 — 悬赏奖数字全部来自用户提供的 W31 真实示例(截止2026-07-29) */
const AW = require('./audio-weekly-core.js');
let f = 0; const ok = (n, c) => { console.log((c ? 'PASS ' : 'FAIL ') + n); if (!c) f++; };
const pct = v => v == null ? null : Math.round(v * 100);

/* ---------- 时间进度：自然日/365 ---------- */
ok('时间进度 2026-07-29 = 58%(第210天/365)', pct(AW.timeProgress('2026-07-29')) === 58);
ok('时间进度 支持 int 20260729', pct(AW.timeProgress(20260729)) === 58);
ok('时间进度 2026-01-01 = 0%(1/365 四舍五入)', pct(AW.timeProgress('2026-01-01')) === 0);
ok('时间进度 2026-12-31 = 100%', pct(AW.timeProgress('2026-12-31')) === 100);
ok('闰年 2028-12-31 用 366 天', pct(AW.timeProgress('2028-12-31')) === 100);

/* ---------- 默认产品集匹配 SE2/SE3/SE4 ---------- */
const names = ['SonicBuds SE 2', 'SonicBuds SE2', 'SonicBuds SE 3', 'SonicBuds SE 4 ANC', 'SonicBuds SE4 ANC',
  'SonicBuds 7i', 'SonicBuds Pro 4', 'SonicBuds SE 5 Max', 'SonicArc', 'SonicBuds SE 20'];
const picked = AW.defaultPick(names);
ok('SE2/SE3/SE4 变体全命中(5个)', picked.length === 5 && picked.every(n => /SE\s?-?\s?[234]\b/i.test(n)));
ok('7i/Pro4/SE5Max/SE20 不误选', !picked.includes('SonicBuds 7i') && !picked.includes('SonicBuds Pro 4') && !picked.includes('SonicBuds SE 5 Max') && !picked.includes('SonicBuds SE 20'));

/* ---------- 悬赏奖表(用户示例 8 行) ---------- */
const cfg = [
  { country: '墨西哥', space: 1758769, share: 0.17, target: 294000 },
  { country: '巴西', space: 1460282, share: 0.08, target: 112000 },
  { country: '秘鲁', space: 1192457, share: 0.08, target: 92000 },
  { country: '智利', space: 957276, share: 0.08, target: 74000 },
  { country: '哥伦比亚', space: 383940, share: 0.25, target: 95000 },
  { country: '阿根廷', space: 277468, share: 0.05, target: 12000 },
  { country: '拉美其他', space: 1893530, share: 0.05, target: 85000 },
];
const siBy = { 墨西哥: 171362, 巴西: 40150, 秘鲁: 39567, 智利: 19491, 哥伦比亚: 27546, 阿根廷: 1120 };
const totalAll = 308187;   // 全拉美累计SI(含未列名国家)
const R = AW.bountyRows(cfg, siBy, totalAll);
const row = c => R.rows.find(r => r.country === c);
ok('墨西哥 达成率 58%', pct(row('墨西哥').attain) === 58);
ok('巴西 36%', pct(row('巴西').attain) === 36);
ok('秘鲁 43%', pct(row('秘鲁').attain) === 43);
ok('智利 26%', pct(row('智利').attain) === 26);
ok('哥伦比亚 29%', pct(row('哥伦比亚').attain) === 29);
ok('阿根廷 9%', pct(row('阿根廷').attain) === 9);
ok('拉美其他 累计SI=8951(总-已列名)', row('拉美其他').cum === 8951);
ok('拉美其他 11%', pct(row('拉美其他').attain) === 11);
ok('合计 累计SI=308187', R.total.cum === 308187);
ok('合计 SI目标=764000', R.total.target === 764000);
ok('合计 目标份额 10%(Σ目标/Σ空间)', pct(R.total.share) === 10);
ok('合计 达成率 40%', pct(R.total.attain) === 40);
ok('target=0 → 达成率 null', AW.bountyRows([{ country: 'X', space: 1, share: 0, target: 0 }], {}, 0).rows[0].attain === null);

/* ============================================================
   R5 · 数据一致性断言(引擎级)
   周报看板 M5/M3 是 country-view / psi-view 的自包含 port 副本 —— 下面这组断言
   就是防漂移的锁:证明「周报看板的数字 == 国家看板 / PSI 看板的数字」。
   任一侧改列、改调用参数、改口径,这里立刻红。
   纯 Node:new E.Engine(tmpdir) + loadSample(),无 electron / 无 DOM / 无网络。
   ============================================================ */
const fs5 = require('fs'), os5 = require('os'), path5 = require('path');
const E5 = require('../engine.js');
const dir5 = fs5.mkdtempSync(path5.join(os5.tmpdir(), 'sb-audio-r5-'));
const eng5 = new E5.Engine(dir5); eng5.loadSample();
const S5 = eng5.store, MAX5 = S5.maxYmd, YS5 = String(MAX5);
const FROM5 = YS5.slice(0, 4) + '-01-01';                                      // 自然年 1/1 = report cumCur/siCur 的起点
const TO5 = YS5.slice(0, 4) + '-' + YS5.slice(4, 6) + '-' + YS5.slice(6, 8);   // 全局 maxYmd = report 的终点
const ISOY5 = E5.isoYW(MAX5)[0];                                               // 当前 ISO 年(周列口径的年份锚)
const CTRY5 = (eng5.options('country', {}) || [])[0];
const LINE5 = (eng5.options('line', {}) || []).find(v => /音频/.test(String(v))) || null;
const LF5 = LINE5 ? { line: [LINE5] } : {};                    // 周报产业线筛选(auLineFilter 的引擎等价物)
const F5 = Object.assign({}, LF5, { country: [CTRY5] });       // M5 单国块的筛选
const near5 = (a, b) => Math.abs((a == null ? 0 : a) - (b == null ? 0 : b)) <= 1;   // 允许 ±1 取整/浮点误差
const eq5 = (a, b) => JSON.stringify([a === undefined ? null : a]) === JSON.stringify([b === undefined ? null : b]);
const sumQ5 = q => { let t = 0; (q.series || []).forEach(nm => (q.buckets || []).forEach(b => { t += (q.data[nm] || {})[b] || 0; })); return t; };
ok('R5-21 夹具:示例数据可用(记录数/国家/自然年区间 ' + FROM5 + '~' + TO5 + ')', S5.n > 0 && !!CTRY5 && MAX5 > 0);

/* ---------- M5 vs 国家看板:两个看板的列定义必须映射到同一批引擎字段 ----------
   view 文件是浏览器全局脚本(依赖 $/state/DIM_LABEL 等),Node 里 require 不了,
   所以用正则从两份源码的 cbColumns / auCbColumns 函数体里抽 cols.push({key:'…'} 清单比对。 */
const fnBody5 = (src, name) => { const i = src.indexOf('function ' + name + '('); if (i < 0) return ''; const j = src.indexOf('\n}', i); return j < 0 ? src.slice(i) : src.slice(i, j); };
// 先剔掉整行注释(注释掉一列也算改列,不能让 // 蒙混过关),再抽 key
const pickKeys5 = body => { const src = body.split('\n').filter(L => L.trim().slice(0, 2) !== '//').join('\n'); const out = [], re = /cols\.push\(\{\s*key:\s*'([^']+)'/g; let m; while ((m = re.exec(src))) out.push(m[1]); return out; };
// 国家看板列清单基线(硬编码;'w' = 周列 wl.forEach 里的 key:'w'+i)
const CB_KEYS5 = ['__line', 'key', 'cumCur', 'cumPrev', 'yoy', 'siCur', 'siPrev', 'siYoy', 'w', 'wow', 'inv', 'dos', 'flowInv', 'flowDos', 'dcfdc'];
const srcCb5 = fs5.readFileSync(path5.join(__dirname, 'views', 'country-view.js'), 'utf8');
const srcAu5 = fs5.readFileSync(path5.join(__dirname, 'views', 'audio-view.js'), 'utf8');
const keysCb5 = pickKeys5(fnBody5(srcCb5, 'cbColumns'));
const keysAu5 = pickKeys5(fnBody5(srcAu5, 'auCbColumns'));
ok('R5-22 国家看板 cbColumns 列清单 = 15 列基线(country-view 一旦改列即红)', keysCb5.join('|') === CB_KEYS5.join('|'));
// 2026-08-25 起周报比国家看板多一列 __series(平板产品表的 Product Series,用户点名要的差异)
// ——比对时剔除这一个已知合法差异,其余任何列增删换序仍然红
const keysAu5x = keysAu5.filter(k => k !== '__series');
ok('R5-23 周报 M5 auCbColumns 列清单与国家看板逐列同序一致(唯一合法差异:__series)', keysAu5x.length > 0 && keysAu5x.join('|') === keysCb5.join('|') && keysAu5.includes('__series'));

/* ---------- 列 key → 引擎字段:每个列都必须能在 report 行/合计上取到值 ---------- */
const GET5 = {
  '__line': o => o.line, 'key': o => o.key, 'cumCur': o => o.cumCur, 'cumPrev': o => o.cumPrev,
  'yoy': o => o.yoy, 'siCur': o => o.siCur, 'siPrev': o => o.siPrev, 'siYoy': o => o.siYoy,
  'w': o => o.weekly, 'wow': o => o.wow, 'inv': o => o.inv, 'dos': o => o.dos,
  'flowInv': o => o.flowInv, 'flowDos': o => o.flowDos, 'dcfdc': o => o.dcfdc,
};
// 国家看板 drawCountryBoard / 周报 renderAuCountry 的同一套调用参数(groupDim=model 才会出 __line 列)
const P5 = { groupDim: 'model', weeks: 9, fromW: null, toW: null, filters: F5 };
const rCb5 = eng5.report(P5), rAu5 = eng5.report(Object.assign({}, P5));
ok('R5-24 示例含全流程库存(hasFlow) → 15 列(含 flowInv/flowDos/dcfdc)全部可验', rCb5.hasFlow === true && rCb5.rows.length > 0);
const undefDet5 = CB_KEYS5.filter(k => !(k in GET5) || GET5[k](rCb5.rows[0]) === undefined);
// 合计行不带 __line(引擎 mk(T) 不产 family/line/series/product);两个看板都在渲染时把该格直接留空
// (country-view: c.key==='__line' → 空 td;audio-view 同),所以合计行只校验其余 14 列。
const undefTot5 = CB_KEYS5.filter(k => k !== '__line').filter(k => !(k in GET5) || GET5[k](rCb5.total) === undefined);
ok('R5-25 15 个列 key 在 report 明细行上全部取到非 undefined(缺:' + (undefDet5.join(',') || '无') + ')', undefDet5.length === 0);
ok('R5-26 除 __line(合计行渲染层留空)外 14 个列 key 在 report 合计行上全部取到非 undefined(缺:' + (undefTot5.join(',') || '无') + ')', undefTot5.length === 0);
ok('R5-26b 合计行确实不带 __line 字段 → 两侧渲染必须都把该格留空(引擎口径,不是 bug)', rCb5.total.line === undefined && rAu5.total.line === undefined);
// 同一 {groupDim, weeks/fromW/toW, filters} → 两个看板拿到的是同一份 report,逐字段严格相等
const CMP5 = ['cumCur', 'cumPrev', 'yoy', 'siCur', 'siPrev', 'siYoy', 'weekly', 'wow', 'inv', 'dos', 'last4', 'hasAu', 'flowInv', 'flowDos', 'dcfdc'];
let rowBad5 = '';
if (rCb5.rows.length !== rAu5.rows.length) rowBad5 = '行数不同';
else rCb5.rows.forEach((o, i) => { CMP5.concat(['key']).forEach(k => { if (!eq5(o[k], rAu5.rows[i][k])) rowBad5 = rowBad5 || (o.key + '.' + k); }); });
ok('R5-27 M5 vs 国家看板:同参调用 rows 逐行逐字段严格相等(差异:' + (rowBad5 || '无') + ')', !rowBad5);
const totBad5 = CMP5.filter(k => !eq5(rCb5.total[k], rAu5.total[k]));
ok('R5-28 M5 vs 国家看板:同参调用 total 逐字段严格相等(含 last4/hasAu,差异:' + (totBad5.join(',') || '无') + ')', totBad5.length === 0);
// 调用参数名集合也要一致(改了 weeks/fromW/toW 任何一个都会红)
// 2026-08-24:audio-view 新增了周号锚点的 api.report(3参),全文第一个不再是 M5 的调用——
// 锚定到两侧真正要对齐的函数体内再抓,别抓到别人头上
const argNames5 = (src, anchor) => { const i0 = anchor ? Math.max(0, src.indexOf(anchor)) : 0; const m = /api\.report\(\{([^}]*)\}/.exec(src.slice(i0)); if (!m) return []; const out = [], re = /(?:^|,)\s*([A-Za-z_$][\w$]*)\s*:/g; let x; while ((x = re.exec(m[1]))) out.push(x[1]); return out.sort(); };
const aCb5 = argNames5(srcCb5, 'function drawCountryBoard'), aAu5 = argNames5(srcAu5, 'async function renderAuCountryImpl');
ok('R5-29 两侧 api.report 调用参数名集合一致[' + aAu5.join(',') + ']', aCb5.length === 5 && aCb5.join(',') === aAu5.join(','));

/* ---------- M5 vs PSI 看板:累计SO/SI == query 在自然年区间内各桶求和 ----------
   report 的 cumCur/siCur 是自然年 1/1 起截至全局 maxYmd;query 要传 from/to 对齐,
   且 stackDim 必填(不传引擎会抛)。 */
const qSo5 = eng5.query({ metric: 'sellOut', stackDim: 'country', gran: 'month', filters: F5, from: FROM5, to: TO5 });
const qSi5 = eng5.query({ metric: 'sellIn', stackDim: 'country', gran: 'month', filters: F5, from: FROM5, to: TO5 });
ok('R5-30 M5 累计SO(report.total.cumCur=' + rCb5.total.cumCur + ') == PSI query(sellOut) 自然年区间求和(' + sumQ5(qSo5) + ',±1)', near5(rCb5.total.cumCur, sumQ5(qSo5)));
ok('R5-31 M5 累计SI(report.total.siCur=' + rCb5.total.siCur + ') == PSI query(sellIn) 自然年区间求和(' + sumQ5(qSi5) + ',±1)', near5(rCb5.total.siCur, sumQ5(qSi5)));
let threw5 = false; try { eng5.query({ metric: 'sellOut', gran: 'month', filters: F5 }); } catch (e) { threw5 = true; }
ok('R5-32 口径备忘:PSI query 的 stackDim 必填,不传会抛 —— 周报取数不得省略', threw5);

/* ---------- M3 累计SI:与 report({groupDim:'country'}).siCur 同区间对齐后逐国相等 ----------
   复刻 renderAuBounty 的取数与求和方式(query→逐桶累加→Math.round)。 */
const repC5 = eng5.report({ groupDim: 'country', weeks: 9, fromW: null, toW: null, filters: Object.assign({}, LF5) });
const m3Q5 = (to) => eng5.query({ metric: 'sellIn', gran: 'month', stackDim: 'country', filters: Object.assign({}, LF5), from: FROM5, to: to });
const m3By5 = q => { const by = {}; Object.keys(q.data || {}).forEach(nm => { let t = 0; (q.buckets || []).forEach(b => { t += q.data[nm][b] || 0; }); by[nm] = Math.round(t); }); return by; };
const by5 = m3By5(m3Q5(TO5));
let siBad5 = '';
repC5.rows.forEach(o => { if (!near5(o.siCur, by5[o.key])) siBad5 = siBad5 || (o.key + ' report=' + o.siCur + ' M3=' + by5[o.key]); });
ok('R5-33 M3 逐国累计SI == report({groupDim:country}).rows[].siCur(' + repC5.rows.length + ' 国,差异:' + (siBad5 || '无') + ')', repC5.rows.length > 0 && !siBad5);
const m3Tot5 = Object.keys(by5).reduce((a, k) => a + by5[k], 0);
ok('R5-34 M3 合计累计SI(' + m3Tot5 + ') == report({groupDim:country}).total.siCur(' + repC5.total.siCur + ',±1)', near5(m3Tot5, repC5.total.siCur));
// M3 默认 to=今天(可能晚于 maxYmd):窗口右端超出无数据区不改变结果 → 与 report 自然年口径天然对齐
const byFar5 = m3By5(m3Q5(YS5.slice(0, 4) + '-12-31'));
ok('R5-35 M3 窗口右端延到年底(超过 maxYmd ' + TO5 + ')结果不变 → 与 report 自然年口径对齐', JSON.stringify(byFar5) === JSON.stringify(by5));

/* ---------- 周列跨年口径:report 的 weekly 只统计「当前 ISO 年」的周 ----------
   跨年窗口里去年那几周恒 0(不是没数据,是口径上不计入)—— 周报表头必须标年份,别让用户误读。 */
const rW5 = eng5.report({ groupDim: 'model', weeks: 9, fromW: 1, toW: 53, filters: F5 });
const maxWk5 = rW5.weekLabels.length ? +rW5.weekLabels[rW5.weekLabels.length - 1].slice(1) : 0;
const qWk5 = eng5.query({ metric: 'sellOut', stackDim: 'country', gran: 'week', filters: F5 });
const wkVal5 = (yy, wk) => ((qWk5.data[CTRY5] || {})[yy + '-W' + String(wk).padStart(2, '0')] || 0);
let wkBad5 = '', curSum5 = 0, prevSum5 = 0;
rW5.weekLabels.forEach((lab, i) => {
  const wk = +lab.slice(1), v = wkVal5(ISOY5, wk);
  curSum5 += rW5.total.weekly[i]; prevSum5 += wkVal5(ISOY5 - 1, wk);
  if (!near5(rW5.total.weekly[i], v)) wkBad5 = wkBad5 || (lab + ' report=' + rW5.total.weekly[i] + ' PSI=' + v);
});
ok('R5-36 周列 W1~W' + maxWk5 + ' 逐周 == PSI 周桶(ISO ' + ISOY5 + '),口径=当前 ISO 年(差异:' + (wkBad5 || '无') + ')', maxWk5 > 0 && !wkBad5);
ok('R5-37 周列跨年口径:同周号的 ISO ' + (ISOY5 - 1) + ' 有量(' + prevSum5 + ')却恒不计入 weekly(合计 ' + curSum5 + ') —— 跨年窗口去年那几周恒 0,表头必须标年份',
  prevSum5 > 0 && !near5(curSum5, curSum5 + prevSum5));

try { fs5.rmSync(dir5, { recursive: true, force: true }); } catch (e) { }

console.log(f ? ('\n' + f + ' FAILED') : '\nALL PASS'); process.exit(f ? 1 : 0);

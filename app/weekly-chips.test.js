'use strict';
/* 周报 v3 数据芯片核心测试 —— 邮件叙述句里的每个 XX 都靠这些语义，必须锁死 */
const W = require('./weekly-chips.js');
let f = 0; const ok = (n, c, x) => { console.log((c ? 'PASS ' : 'FAIL ') + n + (c ? '' : '   ← ' + (x || ''))); if (!c) f++; };

/* ---------- 连续 N 周涨跌 ---------- */
ok('C1 连续4周上涨: [1,2,3,4,5] → true', W.hasStreak([1, 2, 3, 4, 5], 4, 'up'));
ok('C2 中间断一次 → false', !W.hasStreak([1, 2, 3, 2, 5], 4, 'up'));
ok('C3 持平不算涨: [1,2,3,3,4] → false', !W.hasStreak([1, 2, 3, 3, 4], 4, 'up'));
ok('C4 连续4周下滑', W.hasStreak([9, 8, 6, 5, 1], 4, 'down'));
ok('C5 周数不足(4个值只有3步) → false', !W.hasStreak([4, 3, 2, 1], 4, 'down'));
ok('C6 名单: 只挑出满足的行', JSON.stringify(W.listStreak([
  { key: 'A', weekly: [1, 2, 3, 4, 5] }, { key: 'B', weekly: [5, 4, 3, 2, 1] }, { key: 'C', weekly: [1, 1, 1, 1, 1] },
], 4, 'up')) === '["A"]');

/* ---------- WoW 涨跌幅最大 ---------- */
const MOV = [{ key: 'A', wow: 0.12 }, { key: 'B', wow: -0.30 }, { key: 'C', wow: 0.25 }, { key: 'D', wow: null }];
ok('M1 涨幅最大=C', W.topMover(MOV, 'rise').key === 'C');
ok('M2 跌幅最大=B', W.topMover(MOV, 'fall').key === 'B');
ok('M3 全在涨时「跌幅最大」= null(不硬把涨得最少说成跌)', W.topMover([{ key: 'A', wow: 0.1 }, { key: 'B', wow: 0.2 }], 'fall') === null);
ok('M4 wow 全 null → null', W.topMover([{ key: 'A', wow: null }], 'rise') === null);

/* ---------- DOS 超阈值 ---------- */
const DR = [{ key: 'A', dos: 130, flowDos: 210 }, { key: 'B', dos: 90, flowDos: 150 }, { key: 'C', dos: null, flowDos: null }];
ok('D1 渠道DOS超120 → [A]', JSON.stringify(W.listDosOver(DR, 'dos', 120)) === '["A"]');
ok('D2 null 不算超标(是「算不出」不是爆仓)', W.listDosOver(DR, 'dos', 0).length === 2);
ok('D3 全流程DOS超200 → [A]', JSON.stringify(W.listDosOver(DR, 'flowDos', 200)) === '["A"]');
ok('D4 名单格式: 空→无(明确结论,不是留空), 超4个→截断', W.fmtList([]) === '无' && W.fmtList(['a', 'b', 'c', 'd', 'e']) === 'a、b、c、d等5个');

/* ---------- 芯片解析 ---------- */
const CTX = {
  week: 'W34', finTitle: { ym: '2026-06', fcVer: '6月预测' },
  scopes: {
    total: { total: { yoy: 0.30, siYoy: 0.47, wow: -0.05, weekly: [3396, 3457], cumCur: 102126, siCur: 102274, dos: 49, flowDos: 56, inv: 23755 }, rows: [] },
    rep: { total: {}, rows: [{ key: '墨西哥国家办', wow: 0.08, weekly: [1, 2, 3, 4, 5], dos: 130, flowDos: 210 }, { key: '巴西国家办', wow: -0.12, weekly: [9, 7, 5, 3, 1], dos: 80, flowDos: 90 }] },
    country: { '墨西哥': { total: { yoy: 0.15, wow: -0.05 }, rows: [{ key: 'Coral', wow: 2.14 }, { key: 'Anchovy', wow: -0.83 }] } },
  },
};
ok('R1 周号', W.resolveChip({ id: 'week' }, CTX) === 'W34');
ok('R2 SO同比默认带符号', W.resolveChip({ id: 'soYoy', scope: { level: 'total' } }, CTX) === '+30%');
ok('R3 WoW 负号', W.resolveChip({ id: 'wow', scope: { level: 'total' } }, CTX) === '-5%');
ok('R4 本周SO=weekly最后一格', W.resolveChip({ id: 'weekSo', scope: { level: 'total' } }, CTX) === '3,457');
ok('R5 DOS 纯数字', W.resolveChip({ id: 'dos', scope: { level: 'total' } }, CTX) === '49');
ok('R6 国家办涨幅最大(默认带幅度)', W.resolveChip({ id: 'topRise', scope: { level: 'rep' } }, CTX) === '墨西哥(+8%)');
ok('R6b showVal=false 只给名字', W.resolveChip({ id: 'topRise', showVal: false, scope: { level: 'rep' } }, CTX) === '墨西哥');
ok('R7 连续4周上涨名单', W.resolveChip({ id: 'streakUp', n: 4, scope: { level: 'rep' } }, CTX) === '墨西哥');
ok('R8 渠道DOS超120名单(带天数)', W.resolveChip({ id: 'dosOver', x: 120, scope: { level: 'rep' } }, CTX) === '墨西哥(130天)');
ok('R9 国家 scope 下的产品维名单(带幅度)', W.resolveChip({ id: 'topFall', scope: { level: 'country', value: '墨西哥' } }, CTX) === 'Anchovy(-83%)');
ok('R10 scope 缺数据 → —', W.resolveChip({ id: 'soYoy', scope: { level: 'country', value: '智利' } }, CTX) === '—');
ok('R11 小数位可调', W.resolveChip({ id: 'soYoy', dp: 1, scope: { level: 'total' } }, CTX) === '+30.0%');

/* ---------- 叙述文档往返 ---------- */
const doc = W.docFromTemplate(['截止', { chip: { id: 'week' } }, '，SO同比', { chip: { id: 'soYoy', scope: { level: 'total' } } }, '，WoW', { chip: { id: 'wow', scope: { level: 'total' } } }, '\n第二行']);
ok('T1 模板→文档: 2 行', doc.lines.length === 2);
ok('T2 解析成正文', W.resolveDoc(doc, CTX) === '截止W34，SO同比+30%，WoW-5%\n第二行');
ok('T3 芯片料架标签带参数', W.chipLabel({ id: 'dosOver', x: 150 }) === '渠道DOS超150天' && W.chipLabel({ id: 'streakUp', n: 3 }) === '连续3周上涨');

/* ---------- 首销识别（样机剔除） ---------- */
const D = [];
// 5/1~5/20 每天 1~2 台样机；5/21 起放量 80/天
for (let i = 1; i <= 20; i++) D.push({ d: '2026-05-' + String(i).padStart(2, '0'), so: 1 + (i % 2) });
for (let i = 21; i <= 31; i++) D.push({ d: '2026-05-' + String(i).padStart(2, '0'), so: 80 });
ok('F1 样机期不算首销: 识别为 5/21', W.detectFirstSale(D) === '2026-05-21', W.detectFirstSale(D));
ok('F2 没有样机期: 第一天就是首销', W.detectFirstSale([{ d: '2026-06-01', so: 100 }, { d: '2026-06-02', so: 90 }]) === '2026-06-01');
ok('F3 全零 → null', W.detectFirstSale([{ d: '2026-06-01', so: 0 }]) === null);
ok('F4 空 → null', W.detectFirstSale([]) === null);

/* ---------- 首销对齐同天数 ---------- */
// 新品 8/1 首销，每天 100；上代 3/1 首销，每天 80
const NEW = [], PRED = [];
for (let i = 1; i <= 15; i++) NEW.push({ d: '2026-08-' + String(i).padStart(2, '0'), so: 100 });
for (let i = 1; i <= 31; i++) PRED.push({ d: '2026-03-' + String(i).padStart(2, '0'), so: 80 });
const row = W.firstSaleRow({ days: NEW, firstSale: '2026-08-01', target: 5000, predDays: PRED, predFirstSale: '2026-03-01', windowN: 30, today: '2026-08-10' });
ok('F5 已过天数=10(8/1~8/10)', row.elapsed === 10, 'elapsed=' + row.elapsed);
ok('F6 实际=10天×100=1000', row.actual === 1000);
ok('F7 时间进度=10/30', Math.abs(row.progress - 10 / 30) < 1e-9);
ok('F8 上代对齐同天数=10天×80=800', row.predCum === 800);
ok('F9 同比上代=+25%', Math.abs(row.yoy - 0.25) < 1e-9);
ok('F10 达成率=1000/5000', Math.abs(row.attain - 0.2) < 1e-9);
// 窗口封顶：today 远超窗口 → elapsed=N
const row2 = W.firstSaleRow({ days: NEW, firstSale: '2026-08-01', predDays: PRED, predFirstSale: '2026-03-01', windowN: 10, today: '2026-08-25' });
ok('F11 窗口封顶: elapsed=windowN=10, done=true', row2.elapsed === 10 && row2.done === true);
ok('F12 上代也只取同样10天=800', row2.predCum === 800);
// 未首销
const row3 = W.firstSaleRow({ days: [], firstSale: '', target: 100, windowN: 30, today: '2026-08-10' });
ok('F13 未首销: 进度0/实际0/同比—', row3.elapsed === 0 && row3.actual === 0 && row3.yoy === null);
// 上代同期为 0 → 同比 null 不是 Infinity
const row4 = W.firstSaleRow({ days: NEW, firstSale: '2026-08-01', predDays: [], predFirstSale: '2026-03-01', windowN: 30, today: '2026-08-05' });
ok('F14 上代同期0 → 同比 —(不给 Infinity)', row4.yoy === null && row4.predCum === 0);

/* ---------- 汇总行 ---------- */
const tot = W.firstSaleTotal([
  { actual: 1000, target: 5000, predCum: 800 },
  { actual: 500, target: 1000, predCum: 400 },
]);
ok('S1 Σ实际/Σ目标/总达成', tot.actual === 1500 && tot.target === 6000 && Math.abs(tot.attain - 0.25) < 1e-9);
ok('S2 混合同比 = 1500/1200-1 = +25%', Math.abs(tot.yoy - 0.25) < 1e-9);
ok('S3 全无目标 → attain null', W.firstSaleTotal([{ actual: 10, target: null, predCum: null }]).attain === null);

/* ---------- 新品芯片 ---------- */
CTX.scopes.np = { n1: { countries: 2, actual: 1982, target: 8000, attain: 0.2478, yoy: 0.25 } };
ok('N1 首销累计', W.resolveChip({ id: 'npCum', scope: { value: 'n1' } }, CTX) === '1,982');
ok('N2 达成率不带正号', W.resolveChip({ id: 'npAttain', scope: { value: 'n1' } }, CTX) === '25%');
ok('N3 同比上代带符号', W.resolveChip({ id: 'npYoy', scope: { value: 'n1' } }, CTX) === '+25%');
ok('N4 未知新品 → —', W.resolveChip({ id: 'npCum', scope: { value: 'nope' } }, CTX) === '—');

/* ---------- 音频延迟报量：尾部未报量的 0 周不许打断连涨连跌 ---------- */
{
  const upTail = [10, 20, 30, 40, 50, 0, 0];      // 连涨 4 周后 2 周未报量
  ok('A1 音频砍尾 0 → 认得出连涨 4 周', W.hasStreak(upTail, 4, 'up', 1) === true);
  ok('A2 平板不砍尾 → 同一串不算连涨(0 是真没卖)', W.hasStreak(upTail, 4, 'up', 0) === false);
  ok('A3 音频砍尾 0 → 认得出连跌 4 周', W.hasStreak([50, 40, 30, 20, 10, 0], 4, 'down', 1) === true);
  ok('A4 全 0 砍完不够长 → false,不瞎猜', W.hasStreak([0, 0, 0, 0, 0, 0], 4, 'up', 1) === false);
  ok('A5 尾部无 0 时砍不砍一个样', W.hasStreak([1, 2, 3, 4, 5], 4, 'up', 1) === W.hasStreak([1, 2, 3, 4, 5], 4, 'up', 0));
  const rows = [{ key: '音频A', weekly: upTail, hasAu: 1 }, { key: '平板B', weekly: upTail, hasAu: 0 }];
  ok('A6 listStreak 按 hasAu 分流:只有音频行进名单', JSON.stringify(W.listStreak(rows, 4, 'up')) === '["音频A"]');
  const ctxA = { scopes: { total: { total: { weekly: upTail, hasAu: 1 }, rows: [] } } };
  ok('A7 音频本周SO 取最后有数周 50,不是 0', W.resolveChip({ id: 'weekSo' }, ctxA) === '50');
  const ctxT = { scopes: { total: { total: { weekly: upTail, hasAu: 0 }, rows: [] } } };
  ok('A8 平板本周SO 就是末周 0', W.resolveChip({ id: 'weekSo' }, ctxT) === '0');
}

/* ---------- 小幅变动不许被抹成 +0% ---------- */
ok('A9  +0.4% 自动补一位小数,不显示 +0%', W.fmtPct(0.004, 0) === '+0.4%', W.fmtPct(0.004, 0));
ok('A10 -0.04% 补到两位', W.fmtPct(-0.0004, 0) === '-0.04%', W.fmtPct(-0.0004, 0));
ok('A11 两位也看不见的极小值才落到 0%', W.fmtPct(0.00001, 0) === '+0.00%', W.fmtPct(0.00001, 0));
ok('A12 真正的 0 还是 0%,不补小数', W.fmtPct(0, 0) === '+0%', W.fmtPct(0, 0));
ok('A13 正常幅度不受影响', W.fmtPct(0.082, 0) === '+8%', W.fmtPct(0.082, 0));

/* ---------- 叙述名称短显:产品级默认系列名,地理剥后缀,同名去重 ---------- */
{
  const rows = [
    { key: 'Slate 11 Pro 12+256 WiFi', series: 'Slate Pro系列', wow: 0.06, weekly: [1, 2, 3, 4, 5], dos: 130, hasAu: 0 },
    { key: 'Slate SE 11 8+128', series: 'Slate SE系列', wow: -0.05, weekly: [5, 4, 3, 2, 1], dos: 150, hasAu: 0 },
    { key: 'Slate SE 10 4+64', series: 'Slate SE系列', wow: -0.02, weekly: [9, 8, 7, 6, 5], dos: 200, hasAu: 0 },
  ];
  const ctx = { scopes: { country: { 墨西哥: { total: {}, rows: rows } } } };
  const c = (id, extra) => W.resolveChip(Object.assign({ id: id, scope: { level: 'country', value: '墨西哥' } }, extra || {}), ctx);
  ok('G1 国家块产品默认显示系列名', c('topRise') === 'Slate Pro系列(+6%)', c('topRise'));
  ok('G2 nameBy=key 切回产品全名', c('topRise', { nameBy: 'key' }) === 'Slate 11 Pro 12+256 WiFi(+6%)', c('topRise', { nameBy: 'key' }));
  ok('G3 连跌名单同系列去重(两个 SE 只出一次)', c('streakDown') === 'Slate SE系列', c('streakDown'));
  ok('G4 DOS名单去重且保留首个值(行序=SO高→低)', c('dosOver', { x: 120 }) === 'Slate Pro系列(130天)、Slate SE系列(150天)', c('dosOver', { x: 120 }));
  const ctx2 = { scopes: { rep: { total: {}, rows: [{ key: '巴西国家办', wow: 0.06, weekly: [], hasAu: 0 }, { key: '墨西哥国家办', wow: -0.05, weekly: [], hasAu: 0 }] } } };
  ok('G5 国家办后缀剥掉', W.resolveChip({ id: 'topRise', scope: { level: 'rep' } }, ctx2) === '巴西(+6%)', W.resolveChip({ id: 'topRise', scope: { level: 'rep' } }, ctx2));
  ok('G6 终端事业部后缀剥掉', W.shortGeo('拉美终端事业部') === '拉美');
  // family 层分组行的 series 是组内任取的,不许映射
  const ctx3 = { scopes: { family: { total: {}, rows: [{ key: 'Slate', series: '组内随机一条', wow: 0.05, weekly: [], hasAu: 0 }] } } };
  ok('G7 family 层保持原名不映射', W.resolveChip({ id: 'topRise', scope: { level: 'family' } }, ctx3) === 'Slate(+5%)');
  ok('G8 无 series 字段回退原名', W.resolveChip({ id: 'topRise', scope: { level: 'country', value: '墨西哥' } }, { scopes: { country: { 墨西哥: { total: {}, rows: [{ key: 'P1', wow: 0.05, weekly: [], hasAu: 0 }] } } } }) === 'P1(+5%)');
}

console.log(f ? ('\n' + f + ' FAILED') : '\nALL PASS');
process.exit(f ? 1 : 0);

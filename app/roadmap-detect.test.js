'use strict';
/* 路标自动识别（上市/退市判定）测试 —— 规则本身就是产品口径，必须锁死。
   每个用例都是一条业务上说得通的形态，而不是凑数字。 */
const D = require('./roadmap-detect.js');
let f = 0; const ok = (n, c, extra) => { console.log((c ? 'PASS ' : 'FAIL ') + n + (c ? '' : '   ← ' + (extra || ''))); if (!c) f++; };

// 造月轴
const mk = (y, m, n) => { const a = []; for (let i = 0; i < n; i++) { const mm = m + i; a.push(String(y + Math.floor((mm - 1) / 12)) + '-' + String((mm - 1) % 12 + 1).padStart(2, '0')); } return a; };
const item = (so, extra) => Object.assign({ key: 'X', so, si: so.map(v => Math.round(v * 1.05)), cumSO: so.reduce((a, b) => a + b, 0), cumSI: 0, invLast: 0, isAudio: false }, extra || {});

/* ---------- 上市：样机激活不能算上市 ---------- */
{
  // 3 个月各 5 台样机 → 第 4 个月放量 1200 → 峰值 1500
  const so = [5, 5, 5, 1200, 1500, 1400, 1300, 1250, 1200, 1100, 1050, 1000];
  const r = D.detectOne(item(so), mk(2025, 1, 12));
  ok('L1 样机月不算上市：上市月=2025-04(放量月)而不是 2025-01', r.launchMonth === '2025-04', 'got ' + r.launchMonth);
  ok('L2 样机期如实列出：3 个月共 15 台', r.sampleMonths === 3 && r.sampleUnits === 15, r.sampleMonths + '月/' + r.sampleUnits + '台');
  ok('L3 样机量极小 → 高置信度', r.confidence === 'high', r.confidence);
  ok('L4 首4月SO 从上市月起算 =1200+1500+1400+1300=5400（旧口径从首个>0月起会算成 5+5+5+1200=1215）',
    r.first4moSO === 5400, 'got ' + r.first4moSO);
}
{
  // 没有样机期：一上来就放量
  const so = [900, 1200, 1100, 1000, 950, 900];
  const r = D.detectOne(item(so), mk(2025, 1, 6));
  ok('L5 无样机期时上市月=首月', r.launchMonth === '2025-01' && r.sampleUnits === 0);
  ok('L6 无样机期 → 高置信度', r.confidence === 'high', r.confidence);
}
{
  // 缓慢爬坡（不是样机）：门槛前那几个月量不小，占上市当月 34% → 不能一口咬定是样机，要提醒人工确认
  // 峰值 2000 → 门槛 300；前三月 150/250/290 都在门槛下但合计 690
  const so = [150, 250, 290, 2000, 1900, 1800, 1700, 1600];
  const r = D.detectOne(item(so), mk(2025, 1, 8));
  ok('L7 门槛前出货偏多 → 低置信度(不硬说成样机)', r.confidence === 'low', r.confidence + ' sample=' + r.sampleUnits);
  ok('L8 低置信度会写明原因', r.notes.some(s => s.indexOf('缓慢爬坡') >= 0));
  ok('L8b 上市月仍取放量月 2025-04', r.launchMonth === '2025-04', r.launchMonth);
}
{
  // 绝对下限兜底：整体量很小时，比例门槛会被 launchMinUnits 顶上去
  const so = [2, 3, 40, 60, 55, 50, 45, 40];
  const r = D.detectOne(item(so), mk(2025, 1, 8), { launchMinUnits: 30 });
  ok('L9 绝对下限生效：门槛=30 台(峰值60×15%=9 太低)', r.launchThr === 30 && r.launchMonth === '2025-03', r.launchThr + '/' + r.launchMonth);
}

/* ---------- 退市 ---------- */
{
  // 正常生命周期后掉到地板：均值≈600，门槛≈60，末尾连续 4 个月 <60
  const so = [1000, 1200, 1100, 900, 800, 700, 600, 500, 300, 20, 10, 5, 3];
  const r = D.detectOne(item(so), mk(2025, 1, 13), { tailGuard: 1 });
  ok('E1 判为已退市', r.status === 'eol', r.status);
  ok('E2 退市月=最后一个仍在门槛之上的月 2025-09', r.eolMonth === '2025-09', 'got ' + r.eolMonth);
}
{
  // eolMonths 的边界：同一组数据(末尾恰好 3 个月低于门槛)，阈值 3 判退市、阈值 4 判走弱
  const so = [1000, 1200, 1100, 900, 800, 700, 600, 500, 300, 20, 10, 5];
  const at3 = D.detectOne(item(so), mk(2025, 1, 12), { tailGuard: 0, eolMonths: 3 });
  const at4 = D.detectOne(item(so), mk(2025, 1, 12), { tailGuard: 0, eolMonths: 4 });
  ok('E3 恰好连续 3 个月低于门槛 + 阈值 3 → 判退市(边界含等号)', at3.status === 'eol' && at3.lowRun === 3, at3.status + ' run=' + at3.lowRun);
  ok('E3b 退市月取最后一个仍在门槛之上的月 2025-09', at3.eolMonth === '2025-09', at3.eolMonth);
  ok('E4 同一组数据、阈值提到 4 → 只判走弱', at4.status === 'declining' && at4.lowRun === 3, at4.status + ' run=' + at4.lowRun);
}
{
  // 一直在售
  const so = [800, 900, 850, 880, 920, 900, 870, 890];
  const r = D.detectOne(item(so), mk(2025, 1, 8));
  ok('E5 平稳在售 → live', r.status === 'live', r.status);
  ok('E6 在售不给销售结束时间', r.eolMonth === '');
}
{
  // 末端保护：最后一个月因为「还没录完」很低，不能因此判退市
  const so = [900, 950, 900, 880, 920, 900, 30];
  const g0 = D.detectOne(item(so), mk(2025, 1, 7), { tailGuard: 0, eolMonths: 1 });
  const g1 = D.detectOne(item(so), mk(2025, 1, 7), { tailGuard: 1, eolMonths: 1 });
  ok('E7 不设末端保护会把「末月未录全」误判成退市', g0.status === 'eol', g0.status);
  ok('E8 保护 1 个月后不再误判', g1.status === 'live', g1.status);
}
{
  // 音频延迟报量 → 末端多护一个月
  const so = [900, 950, 900, 880, 920, 900, 40, 20];
  const t = D.detectOne(item(so, { isAudio: false }), mk(2025, 1, 8), { tailGuard: 1, tailGuardAudio: 2, eolMonths: 1 });
  const a = D.detectOne(item(so, { isAudio: true }), mk(2025, 1, 8), { tailGuard: 1, tailGuardAudio: 2, eolMonths: 1 });
  ok('E9 平板保护 1 个月 → 仍看到掉量,判退市', t.status === 'eol', t.status);
  ok('E10 音频保护 2 个月 → 不误判(人工延迟报量)', a.status === 'live', a.status);
  ok('E11 音频会写明已做末端保护', a.notes.some(s => s.indexOf('延迟报量') >= 0));
}
{
  // 退市但还有库存 → 要点出来在清库存
  const so = [1000, 1100, 900, 800, 20, 10, 5, 3];
  const r = D.detectOne(item(so, { invLast: 420, invYmd: '2025-08-31' }), mk(2025, 1, 8), { tailGuard: 1 });
  ok('E12 退市且有库存 → 提示在清库存', r.status === 'eol' && r.notes.some(s => s.indexOf('清库存') >= 0), r.status);
}

/* ---------- 边界形态 ---------- */
{
  ok('B1 只有 Sell-in 没有 Sell-out → siOnly,不瞎判上市',
    D.detectOne({ key: 'A', so: [0, 0, 0], si: [100, 200, 100], cumSO: 0 }, mk(2025, 1, 3)).status === 'siOnly');
  ok('B2 全空 → nodata', D.detectOne({ key: 'A', so: [0, 0], si: [0, 0], cumSO: 0 }, mk(2025, 1, 2)).status === 'nodata');
  const nw = D.detectOne(item([1200, 1300]), mk(2026, 5, 2), { tailGuard: 1 });
  ok('B3 刚上市、可判月份不足 → new(不硬判退市)', nw.status === 'new', nw.status);
  const tiny = D.detectOne(item([8, 12, 10, 9]), mk(2025, 1, 4), { minTotalSO: 100 });
  ok('B4 累计量太小 → 低置信度并说明样本不足', tiny.confidence === 'low' && tiny.notes.some(s => s.indexOf('样本太小') >= 0));
}

/* ---------- 参数边界不许炸 ---------- */
{
  const o = D.clampOpt({ launchRatio: 5, eolRatio: -1, eolMonths: 0, tailGuard: -3 });
  ok('P1 参数越界被夹到合法区间', o.launchRatio <= 0.9 && o.eolRatio >= 0.01 && o.eolMonths >= 1 && o.tailGuard >= 0,
    JSON.stringify(o));
  ok('P2 空入参不抛异常', (() => { try { D.detectOne(null, []); D.detectAll(null); return true; } catch (e) { return false; } })());
}

/* ---------- 名称匹配 ---------- */
{
  const dets = [{ key: 'PA-W09DK' }, { key: 'PB-W09B' }, { key: 'Slate 11 Pro' }];
  const prods = [
    { id: '1', name: 'PA-W09DK' },                       // 精确
    { id: '2', name: 'Slate  11  PRO' },                 // 空格/大小写归一后精确
    { id: '3', name: '未来新品' },                        // 匹配不上
    { id: '4', name: '随便写的', psiLink: 'PB-W09B' },    // 手工关联优先
  ];
  const m = D.matchProducts(prods, dets);
  const by = {}; m.rows.forEach(r => by[r.productId] = r);
  ok('M1 精确名匹配', by['1'].det && by['1'].det.key === 'PA-W09DK' && by['1'].how === 'name');
  ok('M2 空格/大小写归一后匹配', by['2'].det && by['2'].det.key === 'Slate 11 Pro');
  ok('M3 匹配不上就是匹配不上,不硬凑', by['3'].det === null && by['3'].how === 'none');
  ok('M4 已有 psiLink 优先于名称', by['4'].det && by['4'].det.key === 'PB-W09B' && by['4'].how === 'link');
  ok('M5 PSI 里有、路标里没有的列为 orphans', m.orphans.length === 0, JSON.stringify(m.orphans.map(o => o.key)));
  const m2 = D.matchProducts([{ id: '9', name: 'PA-W09DK' }], dets);
  ok('M6 没被认领的 PSI 产品进 orphans(供「一键补建」)', m2.orphans.length === 2);
}

/* ---------- 落回路标字段 ---------- */
{
  const det = { key: 'PA-W09DK', launchMonth: '2025-04', status: 'eol', eolMonth: '2026-01', first4moSO: 5400 };
  const p = D.toRoadmapPatch(det);
  ok('R1 上市月 → shipLate,格式是路标认的 YYYY/MM', p.shipLate === '2025/04', p.shipLate);
  ok('R2 退市月 → salesEnd', p.salesEnd === '2026/01', p.salesEnd);
  ok('R3 顺带回填 psiLink 与首4月SO', p.psiLink === 'PA-W09DK' && p.first4moSO === 5400);
  const live = D.toRoadmapPatch({ key: 'A', launchMonth: '2025-04', status: 'live' });
  ok('R4 在售产品不写销售结束时间(空=仍在售)', live.salesEnd === undefined);
}

console.log(f ? ('\n' + f + ' FAILED') : '\nALL PASS');
process.exit(f ? 1 : 0);

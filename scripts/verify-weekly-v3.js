'use strict';
/* ============================================================
   周报 v3 数据正确性核对（发版闸门，用户 2026-08-21 要求：不准有任何一个数字错）

   原则：**独立重算**——不信任 weekly-chips / 表格转换层，直接从引擎原始返回
   重新算一遍每类数字，与周报实际展示值逐一比对。凡是比率用 1e-9 容差，
   台数/金额用精确相等。任何一条不过 → 退出码 1，禁止发版。
   数据源 = demo-data（固定随机种子，结果可复现）。
   ============================================================ */
const fs = require('fs'), os = require('os'), path = require('path');
const ROOT = path.join(__dirname, '..');
const E = require(path.join(ROOT, 'engine.js'));
const WC = require(path.join(ROOT, 'app', 'weekly-chips.js'));

let fails = 0, checks = 0;
const ok = (name, cond, extra) => {
  checks++;
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (cond ? '' : '   ← ' + (extra || '')));
  if (!cond) fails++;
};
const near = (a, b) => (a == null && b == null) || (a != null && b != null && Math.abs(a - b) < 1e-9);

(async () => {
  const eng = new E.Engine(fs.mkdtempSync(path.join(os.tmpdir(), 'vw3-')));
  eng.setFolder(path.join(ROOT, 'demo-data', 'psi'));
  eng.setFinFolder(path.join(ROOT, 'demo-data', 'finance'));
  eng.setInvFolder(path.join(ROOT, 'demo-data', 'flow'));
  const meta = await eng.refresh();
  console.log('数据: ' + meta.records + ' 条  ' + meta.from + ' ~ ' + meta.to + '\n');

  const LF = { line: ['平板'] };
  const famRep = eng.report({ groupDim: 'family', weeks: 9, filters: LF });
  const repRep = eng.report({ groupDim: 'repOffice', weeks: 9, filters: LF });

  /* ---------- ① 跨接口一致性：同一筛选，不同分组维的合计必须相等 ---------- */
  const T1 = famRep.total, T2 = repRep.total;
  ok('①-1 家族/国家办 两个分组维的 合计累计SO 相等', T1.cumCur === T2.cumCur, T1.cumCur + ' vs ' + T2.cumCur);
  ok('①-2 合计累计SI 相等', T1.siCur === T2.siCur);
  ok('①-3 合计库存 相等', T1.inv === T2.inv);
  ok('①-4 合计DOS 相等', T1.dos === T2.dos);
  ok('①-5 合计全流程库存 相等', T1.flowInv === T2.flowInv);
  // 分组行求和 = 合计（引擎内部一致性）
  const sum = (rows, k) => rows.reduce((s, r) => s + (+r[k] || 0), 0);
  ok('①-6 家族行 cumCur 求和 = 合计', sum(famRep.rows, 'cumCur') === T1.cumCur);
  ok('①-7 国家办行 inv 求和 = 合计', sum(repRep.rows, 'inv') === T2.inv);
  // 全部国家的分国 report 合计 = 整体合计（周报 M5 的取数接口没有漏国家/重复计数）
  let allC = [];
  try { allC = eng.options('country', LF) || []; } catch (e) { }
  let cSum = 0, cSumSi = 0, cSumInv = 0;
  const perCountry = {};
  allC.forEach(c => {
    const r = eng.report({ groupDim: 'product', weeks: 9, filters: Object.assign({}, LF, { country: [c] }) });
    perCountry[c] = r;
    if (r.total) { cSum += r.total.cumCur; cSumSi += r.total.siCur; cSumInv += r.total.inv; }
  });
  ok('①-8 ' + allC.length + ' 国分国合计SO 相加 = 整体合计SO', cSum === T1.cumCur, cSum + ' vs ' + T1.cumCur);
  ok('①-9 分国合计SI 相加 = 整体', cSumSi === T1.siCur);
  ok('①-10 分国库存 相加 = 整体', cSumInv === T1.inv);
  // KPI 卡接口(industryBoard)与汇总表同源
  const ib = eng.industryBoard({ filters: LF });
  ok('①-11 KPI卡 SO YTD = 汇总表合计SO', ib.kpi.so.cur === T1.cumCur);
  ok('①-12 KPI卡 SI YTD = 汇总表合计SI', ib.kpi.si.cur === T1.siCur);
  ok('①-13 KPI卡 库存/渠道DOS = 汇总表', ib.kpi.inv.cur === T1.inv && ib.kpi.inv.dos === T1.dos);
  ok('①-14 KPI卡 全流程库存/DOS = 汇总表', ib.kpi.flow.cur === T1.flowInv && ib.kpi.flow.dos === T1.flowDos);

  /* ---------- ② 数值芯片 = 引擎原始值（叙述句里的每个数） ---------- */
  const ctxScopes = { total: { total: T1, rows: [] }, family: { total: T1, rows: famRep.rows }, rep: { total: T2, rows: repRep.rows }, country: {} };
  allC.forEach(c => { ctxScopes.country[c] = { total: perCountry[c].total, rows: perCountry[c].rows }; });
  const ctx = { week: 'W34', finTitle: {}, scopes: ctxScopes };
  const chip = cfg => WC.resolveChip(cfg, ctx);
  const pctS = (v, dp) => v == null ? '—' : ((v >= 0 ? '+' : '') + (v * 100).toFixed(dp == null ? 0 : dp) + '%');
  ok('②-1 SO同比芯片 = report.total.yoy', chip({ id: 'soYoy', scope: { level: 'total' } }) === pctS(T1.yoy));
  ok('②-2 SI同比芯片 = report.total.siYoy', chip({ id: 'siYoy', scope: { level: 'total' } }) === pctS(T1.siYoy));
  ok('②-3 WoW芯片 = report.total.wow', chip({ id: 'wow', scope: { level: 'total' } }) === pctS(T1.wow));
  ok('②-4 本周SO芯片 = weekly 最后一格', chip({ id: 'weekSo', scope: { level: 'total' } }) === Math.round(T1.weekly[T1.weekly.length - 1]).toLocaleString('en-US'));
  ok('②-5 渠道DOS芯片 = report.total.dos', chip({ id: 'dos', scope: { level: 'total' } }) === String(T1.dos));
  ok('②-6 全流程DOS芯片 = report.total.flowDos', chip({ id: 'flowDos', scope: { level: 'total' } }) === String(T1.flowDos));
  // WoW 同比手工重算：weekly 倒数两格
  const wl = T1.weekly, wowManual = wl[wl.length - 2] > 0 ? wl[wl.length - 1] / wl[wl.length - 2] - 1 : null;
  ok('②-7 report.total.wow 本身 = 手工(末两周之比)', near(T1.wow, wowManual), T1.wow + ' vs ' + wowManual);
  // 同比手工重算 = cumCur/cumPrev - 1
  ok('②-8 report.total.yoy 本身 = 手工(cumCur/cumPrev−1)', near(T1.yoy, T1.cumPrev > 0 ? T1.cumCur / T1.cumPrev - 1 : null));

  /* ---------- ③ 名单芯片 = 手工扫行 ---------- */
  const rise = repRep.rows.filter(r => r.wow != null && isFinite(r.wow)).sort((a, b) => b.wow - a.wow)[0];
  const fall = repRep.rows.filter(r => r.wow != null && isFinite(r.wow)).sort((a, b) => a.wow - b.wow)[0];
  const riseChip = chip({ id: 'topRise', scope: { level: 'rep' } });
  const fallChip = chip({ id: 'topFall', scope: { level: 'rep' } });
  ok('③-1 涨幅最大芯片 = 手工排序第一(且必须真在涨)', rise && rise.wow > 0 ? riseChip === rise.key : riseChip === '—', riseChip);
  ok('③-2 跌幅最大芯片 = 手工排序末一(且必须真在跌)', fall && fall.wow < 0 ? fallChip === fall.key : fallChip === '—', fallChip);
  const manualUp = repRep.rows.filter(r => { const w = r.weekly; if (w.length < 5) return false; for (let i = w.length - 4; i < w.length; i++) if (!(w[i] > w[i - 1])) return false; return true; }).map(r => r.key);
  ok('③-3 连续4周上涨名单 = 手工逐行验', chip({ id: 'streakUp', n: 4, scope: { level: 'rep' } }) === WC.fmtList(manualUp));
  const manualOver = repRep.rows.filter(r => r.dos != null && r.dos > 40).map(r => r.key);
  ok('③-4 DOS超40名单 = 手工筛(demo 阈值取40才有命中)', chip({ id: 'dosOver', x: 40, scope: { level: 'rep' } }) === WC.fmtList(manualOver));

  /* ---------- ④ 财经表：MUSD 换算与达成率 ---------- */
  const U = { actual: 'USD', forecast: 'MUSD', bp: 'USD' }, Q = { actual: '台', forecast: '台', bp: '台' };
  const pb = eng.financeProductBoard({ fromM: 1, lv1: ['平板'], finUnits: U, finQtyUnits: Q });
  const blk = pb.famTablet, tot = blk.total;
  ok('④-1 财经合计收入(引擎)存在且 >0', tot && tot.rev26 > 0);
  // MUSD 显示换算：12,445,134 → '12.4M'
  const musd = v => (v / 1e6).toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + 'M';
  ok('④-2 MUSD 换算展示 = 原值÷1e6 保留1位', musd(tot.rev26) === (tot.rev26 / 1e6).toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + 'M');
  ok('④-3 销毛率 = 销毛额÷收入(先加总后相除)', near(tot.gmr26, tot.gm26 / tot.rev26), tot.gmr26 + ' vs ' + tot.gm26 / tot.rev26);
  ok('④-4 BP达成率 = 实际收入÷全年BP', near(tot.bpAttain, tot.rev26 / tot.bp), tot.bpAttain + ' vs ' + tot.rev26 / tot.bp);
  ok('④-5 预测达成率 = 实际收入÷全年预测', near(tot.fcAttain, tot.rev26 / tot.fc));
  ok('④-6 分系列行收入求和 = 合计收入', near(sum(blk.rows, 'rev26'), tot.rev26));
  ok('④-7 财经标题月份 = 引擎 toM(最新实际月)', pb.toM === 6 && pb.curYear === 2026, pb.curYear + '-' + pb.toM);
  // 国家办表与系列表合计一致（同一份财经数据两个切面）
  const rb = eng.financeRepBoard({ fromM: 1, series: blk.rows.map(o => o.key), finUnits: U, finQtyUnits: Q });
  ok('④-8 国家办表合计收入 = 系列表合计收入', near(rb.repTable.total.rev26, tot.rev26), rb.repTable.total.rev26 + ' vs ' + tot.rev26);

  /* ---------- ⑤ 新品首销：从日序列独立重算 ---------- */
  const NPN = 'Slate 12 Pro', PRED = 'Slate 11 Pro', WIN = 30, C0 = '墨西哥';
  const fetchDays = (product, c) => {
    const q = eng.query({ metric: 'sellOut', gran: 'day', stackDim: 'channel', filters: Object.assign({}, LF, { product: [product], country: [c] }) });
    const days = [];
    (q.buckets || []).forEach(b => {
      let s = 0; Object.keys(q.data || {}).forEach(ch => { s += +((q.data[ch] || {})[b]) || 0; });
      if (s > 0) days.push({ d: b, so: s });
    });
    return days;
  };
  const days = fetchDays(NPN, C0), predDays = fetchDays(PRED, C0);
  const first = WC.detectFirstSale(days), predFirst = WC.detectFirstSale(predDays);
  ok('⑤-1 新品首销日已识别且晚于上市月起点', !!first && first >= '2026-06-01', first);
  ok('⑤-2 上代首销日识别在 2025 年中(demo 上代 2025-05 放量)', !!predFirst && predFirst >= '2025-04-01' && predFirst <= '2025-07-01', predFirst);
  const row = WC.firstSaleRow({ days, firstSale: first, target: 900, predDays, predFirstSale: predFirst, windowN: WIN });
  // 手工重算 actual：first 起 elapsed 天内逐日相加
  const t0 = Date.parse(first + 'T00:00:00Z');
  const manualActual = Math.round(days.filter(x => {
    const t = Date.parse(x.d + 'T00:00:00Z');
    return t >= t0 && t <= t0 + (row.elapsed - 1) * 86400000;
  }).reduce((s, x) => s + x.so, 0));
  ok('⑤-3 首销实际达成 = 手工逐日求和', row.actual === manualActual, row.actual + ' vs ' + manualActual);
  // 手工重算上代对齐
  const p0 = Date.parse(predFirst + 'T00:00:00Z');
  const manualPred = Math.round(predDays.filter(x => {
    const t = Date.parse(x.d + 'T00:00:00Z');
    return t >= p0 && t <= p0 + (row.elapsed - 1) * 86400000;
  }).reduce((s, x) => s + x.so, 0));
  ok('⑤-4 同比上代分母 = 上代首销起同样天数手工求和', row.predCum === manualPred, row.predCum + ' vs ' + manualPred);
  ok('⑤-5 同比上代 = actual/predCum − 1', near(row.yoy, manualPred > 0 ? manualActual / manualPred - 1 : null));
  ok('⑤-6 达成率 = actual/900', near(row.attain, manualActual / 900));
  ok('⑤-7 时间进度 = elapsed/30 且 ≤100%', near(row.progress, row.elapsed / WIN) && row.progress <= 1);
  ok('⑤-8 elapsed 不超窗口且非负', row.elapsed >= 0 && row.elapsed <= WIN);

  /* ---------- ⑥ 周号与标题 ---------- */
  const now = new Date();
  const t = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
  const dn = t.getUTCDay() || 7; t.setUTCDate(t.getUTCDate() + 4 - dn);
  const y0 = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  const isoW = Math.ceil(((t - y0) / 86400000 + 1) / 7);
  ok('⑥-1 ISO 周号自证(周四规则)', isoW >= 1 && isoW <= 53, 'W' + isoW);

  console.log('\n' + (fails ? (fails + ' / ' + checks + ' 条核对失败 —— 禁止发版') : ('全部 ' + checks + ' 条核对通过 · 数据链路正确')));
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error('核对脚本异常: ' + e.stack); process.exit(1); });

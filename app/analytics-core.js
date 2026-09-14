/* ============================================================
   Salesboard — analytics-core.js
   确定性分析层：排名 / 对比 / 健康诊断 全部由代码算，模型只解读。
   （2026-09-11 用户：「收回代码吧，我要的是 100% 的数据准确性，不希望出现任何数据错误」）

   30 题实测里模型自己算出的错：同比符号算反、拿合计答产品、把 DOS 46 当「偏高」、
   拿单月 DOS 判健康、贡献排名没到产品级……这些活全收进这里。

   口径纪律（全部沿用汇总表 report 的口径，跨看板一致）：
     · 累计 = 年初至今；同比 = (今年−去年同期)/去年同期，去年同期为 0 → null（不可比，单独列出）
     · DOS = 库存 × 28 ÷ 近 4 周 SO；红绿灯：渠道 <90 绿 / 90–120 黄 / >120 红；全流程 <120 / 120–150 / >150
     · 库存是时点快照，任何地方都不求和
     · 周走势剔除末端为 0 的周（音频报量延迟），并把剔了几周写进结果
     · 财经只到 lv4（产品）/ line（产品线）；到不了的维度明说，不冒充
   ============================================================ */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.AnalyticsCore = api;
})(this, function () {
  'use strict';

  const n0 = v => (v == null || v === '' || !isFinite(+v)) ? null : +v;
  const r1 = v => v == null ? null : Math.round(v * 10) / 10;
  const pct = v => v == null ? null : Math.round(v * 1000) / 10;      // 0.2345 → 23.5

  /* 中文国名 → 数据里的英文取值（真实底表若是中文国名，exact 匹配先命中，别名不生效） */
  const COUNTRY_ALIAS = { '墨西哥': 'Mexico', '巴西': 'Brazil', '哥伦比亚': 'Colombia', '智利': 'Chile', '秘鲁': 'Peru', '阿根廷': 'Argentina', '厄瓜多尔': 'Ecuador', '巴拿马': 'Panama', '多米尼加': 'Dominican Rep.', '危地马拉': 'Guatemala', '哥斯达黎加': 'Costa Rica', '乌拉圭': 'Uruguay', '玻利维亚': 'Bolivia', '巴拉圭': 'Paraguay', '委内瑞拉': 'Venezuela', '洪都拉斯': 'Honduras', '萨尔瓦多': 'El Salvador', '尼加拉瓜': 'Nicaragua', '波多黎各': 'Puerto Rico' };
  function resolveCountry(name, keys) {
    const s = String(name || '').trim(); if (!s) return null;
    keys = keys || [];
    if (keys.indexOf(s) >= 0) return s;
    const al = COUNTRY_ALIAS[s]; if (al && keys.indexOf(al) >= 0) return al;
    const ls = s.toLowerCase().replace(/[\s.]/g, '');
    const hit = keys.find(k => String(k).toLowerCase().replace(/[\s.]/g, '') === ls) || keys.find(k => String(k).toLowerCase().indexOf(ls) === 0 && ls.length >= 4);
    if (hit) return hit;
    const rev = Object.keys(COUNTRY_ALIAS).find(z => keys.indexOf(z) >= 0 && COUNTRY_ALIAS[z].toLowerCase() === s.toLowerCase());
    return rev || null;
  }
  /* 问题文本里出现的国家（英文取值或中文别名），按出现位置排序 */
  function countriesIn(text, keys) {
    const t = String(text || ''); const hits = [];
    (keys || []).forEach(k => { const i = t.indexOf(k); if (i >= 0) hits.push({ name: k, idx: i }); });
    Object.keys(COUNTRY_ALIAS).forEach(z => { const i = t.indexOf(z); if (i >= 0 && (keys || []).indexOf(COUNTRY_ALIAS[z]) >= 0 && !hits.some(h => h.name === COUNTRY_ALIAS[z])) hits.push({ name: COUNTRY_ALIAS[z], idx: i }); });
    return hits.sort((a, b) => a.idx - b.idx).map(h => h.name);
  }

  function dosLight(dos, kind) {
    const d = n0(dos); if (d == null) return null;
    if (kind === 'flow') return d < 120 ? '绿' : (d <= 150 ? '黄' : '红');
    return d < 90 ? '绿' : (d <= 120 ? '黄' : '红');
  }

  /* 周走势：剔掉末端为 0 的周（报量延迟），前 3 周均值 vs 后 3 周均值 */
  function trendOf(weekly) {
    const w = (weekly || []).map(n0);
    let tail = 0; while (w.length && (w[w.length - 1] == null || w[w.length - 1] === 0)) { w.pop(); tail++; }
    if (w.length < 4) return { dir: '数据不足', first: null, last: null, change: null, weeksUsed: w.length, tailZeros: tail };
    const k = Math.min(3, Math.floor(w.length / 2));
    const a = w.slice(0, k).reduce((x, y) => x + (y || 0), 0) / k;
    const b = w.slice(-k).reduce((x, y) => x + (y || 0), 0) / k;
    const ch = a > 0 ? (b - a) / a : null;
    const dir = ch == null ? '数据不足' : (ch <= -0.1 ? '走弱' : (ch >= 0.1 ? '走强' : '走平'));
    return { dir, first: Math.round(a), last: Math.round(b), change: pct(ch), weeksUsed: w.length, tailZeros: tail };
  }

  function stageOf(rm, todayYmd) {
    if (!rm) return null;
    const ym = s => { const m = String(s || '').match(/^(\d{4})[\/\-](\d{1,2})/); return m ? (+m[1] * 12 + +m[2]) : null; };
    const now = ym(todayYmd) || (new Date().getFullYear() * 12 + new Date().getMonth() + 1);
    const ship = ym(rm.shipLate), end = ym(rm.salesEnd);
    if (end != null && end <= now) return '已退市';
    if (ship != null && now - ship <= 3) return '上市放量期';
    if (ship != null && now < ship) return '未上市';
    if (end != null && end - now <= 3) return '退市尾期';
    return '在售';
  }

  function coreRow(r, rm, today) {
    const t = trendOf(r.weekly);
    const yoy = n0(r.yoy), siYoy = n0(r.siYoy);
    return {
      name: r.key, line: r.line || null, series: r.series || null,
      累计SO: n0(r.cumCur), 去年同期SO: n0(r.cumPrev), SO同比: pct(yoy), SO同比可比: yoy != null,
      累计SI: n0(r.siCur), SI同比: pct(siYoy),
      渠道库存: n0(r.inv), 渠道DOS: n0(r.dos), 渠道DOS灯: dosLight(r.dos, 'channel'),
      全流程库存: n0(r.flowInv), 全流程DOS: n0(r.flowDos), 全流程DOS灯: dosLight(r.flowDos, 'flow'),
      国家仓FDC: n0(r.dcfdc),
      周走势: t.dir, 周均_前段: t.first, 周均_后段: t.last, 周变化: t.change, 有效周数: t.weeksUsed, 末端零周: t.tailZeros,
      贡献量: (n0(r.cumCur) != null && n0(r.cumPrev) != null) ? n0(r.cumCur) - n0(r.cumPrev) : null,
      上市阶段: stageOf(rm, today), 上市时间: rm ? (rm.shipLate || null) : null, 销售结束: rm ? (rm.salesEnd || null) : null,
    };
  }

  function flagsOf(c) {
    const f = [];
    if (c.渠道DOS灯 === '红') f.push('渠道DOS红灯(>120)'); else if (c.渠道DOS灯 === '黄') f.push('渠道DOS黄灯');
    if (c.全流程DOS灯 === '红') f.push('全流程DOS红灯(>150)');
    if (c.SO同比 != null && c.SO同比 < 0) f.push('SO同比下滑');
    if (c.SI同比 != null && c.SI同比 < 0 && c.SO同比 != null && c.SO同比 >= 0) f.push('渠道去库存(SI降SO不降)');
    if (c.累计SI != null && c.累计SO != null && c.累计SO > 0 && c.累计SI / c.累计SO > 1.3) f.push('压货嫌疑(SI/SO>1.3)');
    if (c.周走势 === '走弱') f.push('周销走弱'); if (c.周走势 === '走强') f.push('周销走强');
    if (c.末端零周 > 0) f.push('末端' + c.末端零周 + '周为0(报量延迟,已剔除)');
    if (c.上市阶段 === '上市放量期') f.push('上市放量期(同比基数小)');
    if (c.上市阶段 === '已退市' || c.上市阶段 === '退市尾期') f.push(c.上市阶段);
    return f;
  }

  const BY = {
    cumCur: ['累计SO', '台', true], cumPrev: ['去年同期SO', '台', true], yoy: ['SO同比', '%', true], siCur: ['累计SI', '台', true], siYoy: ['SI同比', '%', true],
    inv: ['渠道库存', '台', true], dos: ['渠道DOS', '天', true], flowInv: ['全流程库存', '台', true], flowDos: ['全流程DOS', '天', true],
    contribution: ['贡献量', '台', true], trend: ['周变化', '%', true],
    rev: ['收入', 'USD', true], gm: ['销毛额', 'USD', true], gmr: ['销毛率', '%', true], nsip: ['NSIP', 'USD/台', true],
  };
  const FIN_BY = { rev: 'rev26', gm: 'gm26', gmr: 'gmr26', nsip: 'nsip26' };

  /* deps：{ report(p), financeProductBoard(p), financeOverview(p), roadmapProducts(), today() } —— 全部可选，缺了就退化并明说 */
  function build(deps) {
    deps = deps || {};
    const today = () => { try { return deps.today ? deps.today() : null; } catch (e) { return null; } };
    const rmMap = () => { const m = {}; try { (deps.roadmapProducts ? deps.roadmapProducts() : []).forEach(p => { if (p && p.name) m[String(p.name).trim()] = p; }); } catch (e) {} return m; };

    async function rows(dim, filters) {
      const r = await deps.report({ groupDim: dim || 'product', filters: filters || {}, weeks: 9 });
      if (!r || r.error) throw new Error((r && r.error) || 'report 取数失败');
      return r;
    }
    /* 财经产品级：按产品线各取一次 lv4，合成 name → 行；dim=line 用 line.rows */
    async function finance(dim, lines) {
      if (!deps.financeProductBoard) return { map: {}, note: '未接财经数据' };
      let toM = 12; try { const fo = deps.financeOverview ? await deps.financeOverview({}) : null; if (fo && fo.toM) toM = +fo.toM; } catch (e) {}
      const map = {}; let year = null;
      for (const lv of lines) {
        let f = null; try { f = await deps.financeProductBoard({ fromM: 1, toM: toM, lv1: [lv] }); } catch (e) { f = null; }
        if (!f || f.error) continue;
        year = f.curYear || year;
        const src = dim === 'line' ? ((f.line && f.line.rows) || []) : ((f.lv4 && f.lv4.rows) || []);
        src.forEach(r => { map[r.key] = { 收入: n0(r.rev26), 收入同比: pct(n0(r.revYoy)), 销毛额: n0(r.gm26), 销毛率: pct(n0(r.gmr26)), NSIP: r1(n0(r.nsip26)), BP达成: pct(n0(r.bpAttain)), 预测达成: pct(n0(r.fcAttain)) }; });
      }
      return { map, note: '财经口径：' + (year || '') + ' 年 1–' + toM + ' 月实际（净销售收入/销售毛利/NSIP=USD/台），' + (dim === 'line' ? '产品线级' : '产品级(lv4)') + '；财经实际截至月与 PSI 截止日不同期' };
    }
    const FIN_DIMS = ['product', 'line'];

    const r1 = v => Math.round(v * 10) / 10;
    async function rankItems(a) {
      a = a || {};
      const dim = a.dim || 'product', by = a.by || 'cumCur';
      if (!BY[by]) return { error: 'by 只能是：' + Object.keys(BY).join('/') };
      const r = await rows(dim, a.filters);
      const rm = rmMap(), td = today();
      let items = (r.rows || []).map(x => coreRow(x, rm[x.key], td));
      let fnote = '';
      if (FIN_BY[by]) {
        if (FIN_DIMS.indexOf(dim) < 0) return { error: '财经指标(' + by + ')只到 product/line 两个维度，' + dim + ' 维度没有财经数据——请改 dim 或改用销量类指标' };
        const lines = dim === 'line' ? items.map(i => i.name) : [...new Set(items.map(i => i.line).filter(Boolean))];
        const fin = await finance(dim, lines); fnote = fin.note;
        items.forEach(i => Object.assign(i, fin.map[i.name] || {}));
      }
      const label = BY[by][0];
      const desc = a.order === 'asc' ? false : true;
      const minCum = a.minCum == null ? 0 : +a.minCum;
      const excluded = [];
      const ranked = items.filter(i => {
        if (i[label] == null) { excluded.push({ name: i.name, reason: label + ' 无数据' + (by === 'yoy' && i.去年同期SO === 0 ? '（去年同期为 0，不可比）' : '') }); return false; }
        if (minCum > 0 && (i.累计SO || 0) < minCum) { excluded.push({ name: i.name, reason: '累计SO<' + minCum + '，体量太小不参与排名' }); return false; }
        return true;
      }).sort((x, y) => desc ? (y[label] - x[label]) : (x[label] - y[label]));
      const lim = Math.max(1, Math.min(50, +a.limit || 20));
      return {
        dim, by: label, unit: BY[by][1], order: desc ? '降序' : '升序',
        口径: '累计=年初至今；同比=(今年−去年同期)/去年同期；DOS=库存×28÷近4周SO(红绿灯 渠道<90绿/90–120黄/>120红，全流程<120/120–150/>150)；贡献量=今年累计−去年同期；周变化=剔除末端0周后 后3周均值 vs 前3周均值' + (fnote ? '；' + fnote : ''),
        数据截至: r.asOf || null, hasFlow: !!r.hasFlow,
        items: ranked.slice(0, lim).map((i, k) => Object.assign({ 名次: k + 1, 值: i[label], 标记: flagsOf(i),
          距第1名: k ? r1(desc ? ranked[0][label] - i[label] : i[label] - ranked[0][label]) : 0,      // 落后第 1 名多少（同单位；差值由代码算，模型直接引用）
          距上一名: k ? r1(desc ? ranked[k - 1][label] - i[label] : i[label] - ranked[k - 1][label]) : 0 }, i)),
        未参与排名: excluded,
        总计: r.total ? coreRow(r.total, null, td) : null,
      };
    }

    async function compareItems(a) {
      a = a || {};
      const dim = a.dim || 'product';
      const names = [].concat(a.names || []).map(s => String(s).trim()).filter(Boolean);
      if (names.length < 2) return { error: 'names 至少给两个要对比的名称' };
      const r = await rows(dim, a.filters);
      const rm = rmMap(), td = today();
      const all = {}; (r.rows || []).forEach(x => { all[x.key] = coreRow(x, rm[x.key], td); });
      const missing = names.filter(n => !all[n]);
      if (missing.length) return { error: '这些名称在 ' + dim + ' 维度里不存在：' + missing.join('、') + '。已有取值：' + Object.keys(all).slice(0, 40).join('/') + '。用 searchDim 定位精确写法。' };
      const items = names.map(n => all[n]);
      let fnote = '';
      if (FIN_DIMS.indexOf(dim) >= 0) {
        const lines = dim === 'line' ? names : [...new Set(items.map(i => i.line).filter(Boolean))];
        const fin = await finance(dim, lines); fnote = fin.note;
        items.forEach(i => Object.assign(i, fin.map[i.name] || { 收入: null, 销毛额: null, 销毛率: null, NSIP: null }));
      }
      // 逐指标：谁领先、差多少（差值与倍数都给，模型不用自己减）
      const METRICS = ['累计SO', 'SO同比', '累计SI', 'SI同比', '渠道库存', '渠道DOS', '全流程DOS', '周变化', '贡献量', '收入', '销毛额', '销毛率', 'NSIP'];
      const LOWER_BETTER = { 渠道DOS: 1, 全流程DOS: 1 };
      const 对比 = {};
      METRICS.forEach(m => {
        const vals = items.map(i => i[m]);
        if (vals.some(v => v == null)) { 对比[m] = { 说明: '有产品缺此数据，不比' }; return; }
        const best = items.reduce((b, i) => (b == null || (LOWER_BETTER[m] ? i[m] < b[m] : i[m] > b[m])) ? i : b, null);
        const worst = items.reduce((b, i) => (b == null || (LOWER_BETTER[m] ? i[m] > b[m] : i[m] < b[m])) ? i : b, null);
        对比[m] = { 领先: best.name, 领先值: best[m], 落后: worst.name, 落后值: worst[m], 差值: r1(best[m] - worst[m]), 倍数: worst[m] ? r1(best[m] / worst[m]) : null, 更优方向: LOWER_BETTER[m] ? '越低越好' : '越高越好' };
      });
      return {
        dim, names,
        口径: '同 rankItems；库存为时点快照不求和；DOS 越低越健康' + (fnote ? '；' + fnote : ''),
        数据截至: r.asOf || null,
        items: items.map(i => Object.assign({ 标记: flagsOf(i) }, i)),
        对比,
      };
    }

    async function healthCheck(a) {
      a = a || {};
      const dim = a.dim || 'product';
      const r = await rows(dim, a.filters);
      const rm = rmMap(), td = today();
      const items = (r.rows || []).map(x => { const c = coreRow(x, rm[x.key], td); c.标记 = flagsOf(c); return c; });
      const byDos = items.filter(i => i.渠道DOS != null).sort((x, y) => y.渠道DOS - x.渠道DOS);
      return {
        dim, 口径: '同 rankItems；红绿灯 渠道<90绿/90–120黄/>120红，全流程<120/120–150/>150；周走势剔除末端0周(报量延迟)',
        数据截至: r.asOf || null,
        库存风险_按渠道DOS降序: byDos.map(i => ({ name: i.name, 渠道DOS: i.渠道DOS, 灯: i.渠道DOS灯, 全流程DOS: i.全流程DOS, 全流程灯: i.全流程DOS灯, 渠道库存: i.渠道库存, 周走势: i.周走势, SO同比: i.SO同比 })),
        红灯: byDos.filter(i => i.渠道DOS灯 === '红' || i.全流程DOS灯 === '红').map(i => i.name),
        同比下滑: items.filter(i => i.SO同比 != null && i.SO同比 < 0).map(i => ({ name: i.name, SO同比: i.SO同比 })),
        渠道去库存: items.filter(i => i.标记.indexOf('渠道去库存(SI降SO不降)') >= 0).map(i => ({ name: i.name, SI同比: i.SI同比, SO同比: i.SO同比 })),
        压货嫌疑: items.filter(i => i.标记.some(f => f.indexOf('压货') === 0)).map(i => ({ name: i.name, 累计SI: i.累计SI, 累计SO: i.累计SO })),
        周销走弱: items.filter(i => i.周走势 === '走弱').map(i => ({ name: i.name, 周均_前段: i.周均_前段, 周均_后段: i.周均_后段, 周变化: i.周变化 })),
        周销走强: items.filter(i => i.周走势 === '走强').map(i => ({ name: i.name, 周均_前段: i.周均_前段, 周均_后段: i.周均_后段, 周变化: i.周变化 })),
        不可比_去年同期为0: items.filter(i => !i.SO同比可比).map(i => i.name),
        报量延迟提示: items.filter(i => i.末端零周 > 0).map(i => i.name + '(末端' + i.末端零周 + '周为0)'),
        items,
      };
    }

    /* ---------- 机会预估（2026-09-12 用户：「A 拿到 X 国卖，参考 C 的历史，能卖多少」——数字必须代码算，不能是编的） ----------
       三种口径都给，取区间与中位；已在售的国家给实际与空间。全部沿用 report 的年初至今累计口径。
         份额法 = 本品在已售国家的「产品线份额」× 目标国产品线 SO
         规模法 = 本品各国均量 × 目标国总 SO ÷ 已售国家平均总 SO
         类比法 = 类比品在目标国 SO × (本品 ÷ 类比品 在重叠国家的销量比)；类比品默认取同产品线、在目标国有量、与本品重叠 ≥2 国的产品
       估计是「同口径量级参考」，不是承诺；口径和假设随结果一起返回。 */
    const _ctyCache = {};
    async function ctyRowsFor(filters, key) {
      if (_ctyCache[key]) return _ctyCache[key];
      const r = await rows('country', filters); const m = {};
      (r.rows || []).forEach(x => { m[x.key] = x; });
      _ctyCache[key] = m; return m;
    }
    const sum = arr => arr.reduce((a, b) => a + (b || 0), 0);
    const med = arr => { const s = arr.slice().sort((a, b) => a - b); const n = s.length; return n ? (n % 2 ? s[(n - 1) / 2] : Math.round((s[n / 2 - 1] + s[n / 2]) / 2)) : null; };
    async function opportunity(a) {
      a = a || {};
      const P = await rows('product'); const rm = rmMap(), td = today();
      const pname = String(a.product || '').trim();
      let prow = (P.rows || []).find(r => r.key === pname) || (P.rows || []).find(r => String(r.key).toLowerCase().replace(/[\s\-_]/g, '') === pname.toLowerCase().replace(/[\s\-_]/g, ''));
      if (!prow) return { error: '产品「' + pname + '」不存在。可用产品：' + (P.rows || []).map(r => r.key).join('/') + '。用 searchDim 定位精确写法。' };
      const A = coreRow(prow, rm[prow.key], td); A.标记 = flagsOf(A);
      const Call = await rows('country'); const ctyKeys = (Call.rows || []).map(r => r.key);
      const totalBy = {}; (Call.rows || []).forEach(r => { totalBy[r.key] = n0(r.cumCur) || 0; });
      const aBy = await ctyRowsFor({ product: [A.name] }, 'p:' + A.name);
      const lineBy = A.line ? await ctyRowsFor({ line: [A.line] }, 'l:' + A.line) : {};
      const seriesBy = A.series ? await ctyRowsFor({ series: [A.series] }, 's:' + A.series) : {};
      const aCty = ctyKeys.filter(c => (aBy[c] && n0(aBy[c].cumCur)) > 0);
      if (!aCty.length) return { error: '产品「' + A.name + '」年初至今没有任何国家有销量，无法做预估。' };
      const aTotal = sum(aCty.map(c => n0(aBy[c].cumCur)));
      const aAvg = aTotal / aCty.length;
      const aLineSum = sum(aCty.map(c => lineBy[c] ? n0(lineBy[c].cumCur) : 0));
      const shareLine = aLineSum > 0 ? aTotal / aLineSum : null;
      const avgSize = sum(aCty.map(c => totalBy[c])) / aCty.length;
      const aWeekly = sum(aCty.map(c => n0(aBy[c].last4) || 0)) / 4;
      // 类比品
      const minOverlap = a.minOverlap != null ? +a.minOverlap : 2;
      let cands = [].concat(a.analogs || []).map(s => String(s).trim()).filter(Boolean);
      const auto = !cands.length;
      if (auto) cands = (P.rows || []).filter(r => r.key !== A.name && r.line === A.line && (n0(r.cumCur) || 0) > 0).map(r => r.key);
      const analogs = []; const analogSkipped = [];
      for (const cn of cands) {
        const crow = (P.rows || []).find(r => r.key === cn);
        if (!crow) { analogSkipped.push({ name: cn, reason: '产品不存在' }); continue; }
        const cBy = await ctyRowsFor({ product: [cn] }, 'p:' + cn);
        const overlap = aCty.filter(c => (cBy[c] && n0(cBy[c].cumCur)) > 0);
        if (overlap.length < minOverlap) { analogSkipped.push({ name: cn, reason: '与本品重叠国家不足 ' + minOverlap + ' 个' }); continue; }
        const cSum = sum(overlap.map(c => n0(cBy[c].cumCur)));
        if (!(cSum > 0)) { analogSkipped.push({ name: cn, reason: '重叠国家里类比品无量' }); continue; }
        const ratio = sum(overlap.map(c => n0(aBy[c].cumCur))) / cSum;
        analogs.push({ name: cn, line: crow.line || null, series: crow.series || null, 重叠国家数: overlap.length, 重叠国家: overlap, 本品_重叠国累计: sum(overlap.map(c => n0(aBy[c].cumCur))), 类比品_重叠国累计: cSum, 换算比: Math.round(ratio * 1000) / 1000, 上市阶段: stageOf(rm[cn], td), by: cBy });
      }
      // 目标国
      let targets;
      let resolvedCountry = null;
      if (a.country) {
        resolvedCountry = resolveCountry(a.country, ctyKeys);
        if (!resolvedCountry) return { error: '国家「' + a.country + '」不在数据里。可用国家：' + ctyKeys.join('/') };
        targets = [resolvedCountry];
      } else {
        targets = ctyKeys.filter(c => aCty.indexOf(c) < 0);
        if (!targets.length) targets = ctyKeys.slice();   // 全部已在售 → 按空间排
      }
      const ests = targets.map(X => {
        const actual = aBy[X] ? (n0(aBy[X].cumCur) || 0) : 0;
        const lineX = lineBy[X] ? (n0(lineBy[X].cumCur) || 0) : 0;
        const seriesX = seriesBy[X] ? (n0(seriesBy[X].cumCur) || 0) : 0;
        const est1 = shareLine != null ? Math.round(shareLine * lineX) : null;
        const est2 = avgSize > 0 ? Math.round(aAvg * totalBy[X] / avgSize) : null;
        const byAnalog = analogs.map(an => { const cX = an.by[X] ? (n0(an.by[X].cumCur) || 0) : 0; return { 类比品: an.name, 类比品在该国累计SO: cX, 换算比: an.换算比, 估计: cX > 0 ? Math.round(cX * an.换算比) : null, 说明: cX > 0 ? '' : '类比品在该国无量，不作类比' }; });
        const vals = [est1, est2].concat(byAnalog.map(x => x.估计)).filter(v => v != null && isFinite(v));
        const low = vals.length ? Math.min.apply(null, vals) : null, high = vals.length ? Math.max.apply(null, vals) : null, mid = med(vals);
        const lx = lineBy[X] || {};
        const 判定 = actual > 0 ? (high != null && actual >= high ? '已在售，实际已达到/超过估计上限，增量空间有限' : (low != null && actual >= low ? '已在售，实际在估计区间内，还有部分空间' : '已在售，实际低于估计下限，有明显空间')) : (mid != null ? '未在售，有进入机会（量级见区间）' : '未在售，缺少可用口径，无法估计');
        return {
          国家: X, 已在售: actual > 0, 实际累计SO: actual,
          份额法: est1, 规模法: est2, 类比法: byAnalog,
          区间低: low, 区间高: high, 中位: mid,
          周销参考: (mid != null && aTotal > 0) ? Math.round(aWeekly * mid / aTotal) : null,
          未来12周参考: (mid != null && aTotal > 0) ? Math.round(aWeekly * mid / aTotal) * 12 : null,   // 进入后头 12 周按周销参考线性外推（代码算，模型别自己乘）
          空间: (actual > 0 && mid != null) ? (mid - actual) : null,
          判定,
          市场环境: { 国家总SO: totalBy[X], 产品线SO: lineX, 系列SO: seriesX, 产品线渠道DOS: n0(lx.dos), 产品线DOS灯: dosLight(lx.dos, 'channel'), 产品线SO同比: pct(n0(lx.yoy)) },
        };
      }).sort((x, y) => (y.中位 || 0) - (x.中位 || 0));
      const risks = [];
      if (A.上市阶段 === '上市放量期') risks.push('本品处于上市放量期，累计基数小，估计偏保守');
      if (A.上市阶段 === '已退市' || A.上市阶段 === '退市尾期') risks.push('本品 ' + A.上市阶段 + '，进入新国家意义有限');
      if (A.周走势 === '走弱') risks.push('本品近 9 周周销走弱（' + A.周变化 + '%），估计按年初至今累计口径，未来动能可能低于估计');
      if (A.SO同比 != null && A.SO同比 < 0) risks.push('本品 SO 同比 ' + A.SO同比 + '%，处于下滑');
      if (A.末端零周 > 0) risks.push('本品末端 ' + A.末端零周 + ' 周为 0（报量延迟），周销参考按剔除后计算');
      ests.forEach(e => { if (e.市场环境.产品线DOS灯 === '红') risks.push(e.国家 + ' 的' + A.line + '渠道 DOS ' + e.市场环境.产品线渠道DOS + ' 天红灯，进入前先看渠道消化'); });
      if (!analogs.length) risks.push('没有可用类比品（同产品线且重叠国家 ≥' + minOverlap + '）——只给份额法与规模法');
      return {
        product: A.name, line: A.line, series: A.series, 上市阶段: A.上市阶段, 标记: A.标记,
        目标国家: resolvedCountry || '全部未进入国家' + (targets.length === ctyKeys.length ? '（本品已覆盖全部国家，改按空间排序）' : ''),
        产品现状: { 在售国家数: aCty.length, 累计SO合计: aTotal, 国家均量: Math.round(aAvg), 近4周周销均值: Math.round(aWeekly), 产品线份额_已售国: shareLine != null ? pct(shareLine) : null, SO同比: A.SO同比, 周走势: A.周走势, 渠道DOS: A.渠道DOS, 各国累计SO: aCty.map(c => ({ 国家: c, 累计SO: n0(aBy[c].cumCur) })).sort((x, y) => y.累计SO - x.累计SO) },
        类比品: analogs.map(an => ({ name: an.name, series: an.series, 重叠国家数: an.重叠国家数, 本品_重叠国累计: an.本品_重叠国累计, 类比品_重叠国累计: an.类比品_重叠国累计, 换算比: an.换算比, 上市阶段: an.上市阶段 })),
        未采用的类比品: analogSkipped,
        估计: ests,
        口径: '累计=年初至今（与看板同口径）；估计为同口径「年初至今累计」量级参考，不是承诺。份额法=本品在已售国家的产品线份额(' + (shareLine != null ? pct(shareLine) + '%' : '无') + ')×目标国产品线SO；规模法=本品国家均量(' + Math.round(aAvg) + ')×目标国总SO÷已售国家平均总SO(' + Math.round(avgSize) + ')；类比法=类比品在目标国SO×换算比(本品÷类比品在重叠国家的累计比)。区间=三法最小~最大，中位=三法中位数。周销参考=本品近4周周销均值按中位÷本品累计等比换算。',
        假设与风险: risks,
      };
    }

    /* ---------- 前瞻推演（2026-09-12 用户：「策略性、未来判断类的题也要 100% 对」——判断依据全由代码算） ----------
       未来 N 周预测：保守 = 后段周均 × N；中性 = 近 4 周周均 × N；乐观 = max(近4周周均, 后段周均) × (1 + max(0, 周变化)) × N（涨幅封顶 +30%）。
       全年预测(中性) = 累计SO + 近4周周均 × 到年底剩余周数。可支撑周数 = 渠道库存 ÷ 近4周周均；<4 周即断货风险。
       DOS 目标：目标库存 = 目标DOS × 日均(近4周周均÷7)；需减库存 = 库存 − 目标库存；停止进货靠 SO 消化的周数 = 需减 ÷ 周均。
       主推候选：非退市/退市尾期、周销非走弱、渠道 DOS 非红灯、SO 同比非负（去年为 0 的新品视为可比外），按中性预测排序；不满足的进剔除清单并写原因。
       都是「按现在节奏线性外推」的量级参考，不是承诺；口径随结果返回。 */
    async function outlook(a) {
      a = a || {};
      const dim = a.dim || 'product';
      const r = await rows(dim, a.filters);
      const rm = rmMap(), td = today();
      let asOf = null; try { asOf = deps.asOf ? await deps.asOf() : null; } catch (e) { asOf = null; }
      const ymd = asOf ? String(asOf).replace(/[^0-9]/g, '').slice(0, 8) : '';
      let remaining = null, asOfIso = null;
      if (ymd.length === 8) { const y = +ymd.slice(0, 4), m = +ymd.slice(4, 6), d = +ymd.slice(6, 8); const dt = new Date(Date.UTC(y, m - 1, d)); const end = new Date(Date.UTC(y, 11, 31)); remaining = Math.max(0, Math.floor((end - dt) / (7 * 86400000))); asOfIso = y + '-' + String(m).padStart(2, '0') + '-' + String(d).padStart(2, '0'); }
      const weeks = a.weeks === 'toYearEnd' ? (remaining != null ? remaining : 12) : Math.max(1, Math.min(52, Math.round(+a.weeks || 12)));
      const dosTarget = a.dosTarget != null && isFinite(+a.dosTarget) ? +a.dosTarget : null;
      const minCum = a.minCum != null ? +a.minCum : 0;
      const items = (r.rows || []).map(x => {
        const c = coreRow(x, rm[x.key], td); c.标记 = flagsOf(c);
        const runRate = n0(x.last4) != null ? n0(x.last4) / 4 : null;
        const tail = c.周均_后段;
        const 保守 = runRate != null ? Math.round(Math.min(runRate, tail != null ? tail : runRate) * weeks) : null;
        const 中性 = runRate != null ? Math.round(runRate * weeks) : null;
        const up = Math.min(0.3, Math.max(0, (c.周变化 || 0) / 100));
        const 乐观 = runRate != null ? Math.round(Math.max(runRate, tail != null ? tail : runRate) * (1 + up) * weeks) : null;
        const 全年 = (runRate != null && remaining != null && c.累计SO != null) ? c.累计SO + Math.round(runRate * remaining) : null;
        const cover = (runRate > 0 && c.渠道库存 != null) ? Math.round(c.渠道库存 / runRate * 10) / 10 : null;
        const 断货风险 = cover == null ? null : (c.渠道库存 <= 0 ? '已无渠道库存' : (cover < 4 ? '4周内可能断货' : (cover < 8 ? '8周内需补货' : '暂无断货风险')));
        let dosPlan = null;
        if (dosTarget != null && runRate > 0 && c.渠道库存 != null) {
          const 目标库存 = Math.round(dosTarget * runRate / 7);
          const 需减 = Math.max(0, Math.round(c.渠道库存 - 目标库存));
          dosPlan = { 目标DOS: dosTarget, 当前DOS: c.渠道DOS, 目标库存: 目标库存, 需减库存: 需减, 停止进货消化周数: 需减 > 0 ? Math.round(需减 / runRate * 10) / 10 : 0, 是否已达标: c.渠道DOS != null && c.渠道DOS <= dosTarget };
        }
        const reasons = [], hints = [];
        if (c.上市阶段 === '已退市' || c.上市阶段 === '退市尾期') reasons.push(c.上市阶段);
        if (c.周走势 === '走弱') hints.push('周销走弱(' + c.周变化 + '%)');
        if (c.渠道DOS灯 === '黄') hints.push('渠道DOS黄灯(' + c.渠道DOS + '天)');
        if (c.渠道DOS灯 === '红') reasons.push('渠道DOS红灯(' + c.渠道DOS + '天)');
        if (c.SO同比 != null && c.SO同比 < 0) reasons.push('SO同比下滑(' + c.SO同比 + '%)');
        if (minCum > 0 && (c.累计SO || 0) < minCum) reasons.push('累计SO<' + minCum);
        if (runRate == null || runRate <= 0) reasons.push('近4周无销量');
        return Object.assign({}, c, {
          近4周周均: runRate != null ? Math.round(runRate) : null,
          ['未来' + weeks + '周预测']: { 保守, 中性, 乐观 },
          全年预测_中性: 全年,
          可支撑周数: cover, 断货风险,
          DOS目标: dosPlan,
          主推候选: reasons.length === 0, 剔除原因: reasons, 提示: hints,
        });
      });
      const key = '未来' + weeks + '周预测';
      const ranked = items.filter(i => i[key].中性 != null).sort((x, y) => y[key].中性 - x[key].中性);
      ranked.forEach((i, k) => { i.名次 = k + 1; });
      const cands = ranked.filter(i => i.主推候选);
      const covers = items.filter(i => i.可支撑周数 != null).sort((x, y) => x.可支撑周数 - y.可支撑周数);
      const yr = items.filter(i => i.全年预测_中性 != null).sort((x, y) => y.全年预测_中性 - x.全年预测_中性);
      const dosNeed = dosTarget != null ? items.filter(i => i.DOS目标).sort((x, y) => y.DOS目标.需减库存 - x.DOS目标.需减库存) : null;
      return {
        dim, 数据截至: asOfIso, 预测周数: weeks, 到年底剩余周数: remaining,
        口径: '按现在节奏线性外推的量级参考，不是承诺。近4周周均=近4周SO÷4（音频按各原子单元最后有报量的周截取）；保守=后段周均×N；中性=近4周周均×N；乐观=max(近4周周均,后段周均)×(1+周变化,封顶+30%)×N；全年预测=累计SO+近4周周均×到年底剩余周数(' + (remaining != null ? remaining : '未知') + '周)；可支撑周数=渠道库存÷近4周周均，<4周=断货风险；DOS目标：目标库存=目标DOS×日均，需减=库存−目标库存，消化周数=需减÷周均(假设停止进货)；主推候选=非退市、渠道DOS非红、SO同比非负（去年为0的新品视为可比外）、近4周有销量；周销走弱/DOS黄灯只作提示不剔除。',
        [key + '排名']: ranked.map(i => ({ 名次: i.名次, name: i.name, 中性: i[key].中性, 保守: i[key].保守, 乐观: i[key].乐观, 周走势: i.周走势, 上市阶段: i.上市阶段 })),
        全年预测排名: yr.map(i => ({ name: i.name, 累计SO: i.累计SO, 全年预测_中性: i.全年预测_中性 })),
        库存可支撑周数_升序: covers.map(i => ({ name: i.name, 可支撑周数: i.可支撑周数, 渠道库存: i.渠道库存, 近4周周均: i.近4周周均, 断货风险: i.断货风险 })),
        断货风险清单: covers.filter(i => i.断货风险 === '4周内可能断货' || i.断货风险 === '已无渠道库存').map(i => i.name),
        主推候选_按预测量: cands.map(i => ({ name: i.name, 中性: i[key].中性, SO同比: i.SO同比, 周走势: i.周走势, 渠道DOS: i.渠道DOS, 提示: i.提示 })),
        剔除清单: items.filter(i => !i.主推候选).map(i => ({ name: i.name, 原因: i.剔除原因 })),
        DOS目标_需减库存降序: dosNeed ? dosNeed.map(i => Object.assign({ name: i.name }, i.DOS目标)) : null,
        items,
        假设与风险: [
          '线性外推不含季节性、促销与新品上市影响',
          '音频末端 0 周为报量延迟，已按各单元最后有报量的周截取',
        ].concat(items.filter(i => i.上市阶段 === '上市放量期').map(i => i.name + ' 处于上市放量期，周均仍在爬坡，中性预测偏保守')),
      };
    }

    return { rankItems, compareItems, healthCheck, opportunity, outlook };
  }

  const SCHEMAS = {
    rankItems: {
      description: '【确定性排名，代码算好】按任一指标给某维度排名：累计SO/同比/SI/库存/渠道DOS/全流程DOS/贡献量/周变化/收入/销毛率/NSIP。返回名次、值、红绿灯、周走势、上市阶段、标记，以及未参与排名者与原因。问「哪个最…/前几名/谁贡献最大/哪些下滑」先调它，数字直接引用，不要自己算。',
      properties: { dim: { type: 'string', enum: ['product', 'series', 'family', 'line', 'country', 'repOffice', 'region', 'model'] }, by: { type: 'string', enum: Object.keys(BY) }, order: { type: 'string', enum: ['desc', 'asc'] }, limit: { type: 'integer' }, minCum: { type: 'integer', description: '累计SO 低于此值的不参与排名（排除样机/清尾）' }, filters: { type: 'object', additionalProperties: true } },
      required: [],
    },
    compareItems: {
      description: '【确定性对比，代码算好】给 2~5 个产品/国家/系列做并排对比：销量、同比、SI、库存、DOS(红绿灯)、周走势、贡献量、收入、销毛率、NSIP(产品/产品线级)、上市阶段，并逐指标给出谁领先、差值、倍数。问「A 和 B 哪个…/该多卖哪个/更值得投哪个」先调它。',
      properties: { dim: { type: 'string', enum: ['product', 'series', 'family', 'line', 'country', 'repOffice'] }, names: { type: 'array', items: { type: 'string' } }, filters: { type: 'object', additionalProperties: true } },
      required: ['names'],
    },
    outlook: {
      description: '【确定性前瞻推演，代码算好】未来 N 周预测（保守/中性/乐观）、全年预测、库存可支撑周数与断货风险、DOS 目标需减库存与消化周数、主推候选与剔除清单（附原因）。问「未来/接下来/下半年/年底/全年/会不会断货/库存能撑多久/DOS 压到多少/主推组合/该把资源放在谁身上」先调它，数字直接引用，不要自己外推。',
      properties: { dim: { type: 'string', enum: ['product', 'series', 'family', 'line', 'country', 'repOffice', 'region', 'model'] }, weeks: { type: 'integer', description: '预测周数，默认 12；到年底传 0 并同时看 全年预测' }, dosTarget: { type: 'number', description: '目标渠道 DOS（天），给了才算需减库存' }, minCum: { type: 'integer' }, filters: { type: 'object', additionalProperties: true } },
      required: [],
    },
    opportunity: {
      description: '【确定性机会预估，代码算好】某产品若进入/加推某国家能卖多少：份额法/规模法/类比法三种口径的估计区间与中位（年初至今累计口径）、已在售则给实际与空间、目标国市场环境（总量/产品线量/产品线DOS）与风险。不给 country 就对本品所有未进入国家排名。问「拿到 X 国能不能卖、能卖多少、有没有机会、下一个进哪个国家、参考 C 的历史销量」先调它，数字直接引用，不要自己算。',
      properties: { product: { type: 'string', description: '本品（传播名，精确写法）' }, country: { type: 'string', description: '目标国家；不给=所有未进入国家排名' }, analogs: { type: 'array', items: { type: 'string' }, description: '类比产品；不给=自动选同产品线、重叠国家≥2 的产品' }, minOverlap: { type: 'integer' } },
      required: ['product'],
    },
    healthCheck: {
      description: '【确定性健康诊断，代码算好】一次给出全部成员的库存风险(按渠道DOS降序+红绿灯)、同比下滑清单、渠道去库存清单(SI降SO不降)、压货嫌疑(SI/SO>1.3)、周销走弱/走强清单、不可比(去年为0)清单、报量延迟提示。问「库存风险/该清谁/哪些走弱/去库存/压货」先调它。',
      properties: { dim: { type: 'string', enum: ['product', 'series', 'family', 'line', 'country', 'repOffice'] }, filters: { type: 'object', additionalProperties: true } },
      required: [],
    },
  };

  return { build, SCHEMAS, trendOf, dosLight, stageOf, coreRow, flagsOf, BY, COUNTRY_ALIAS, resolveCountry, countriesIn };
});

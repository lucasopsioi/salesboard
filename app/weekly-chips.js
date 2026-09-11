'use strict';
/* ============================================================
   Salesboard — weekly-chips.js
   周报 v3（按用户 W34 邮件版式）的数据芯片纯函数层。无 DOM / 无 api 依赖，
   node 直接单测（weekly-chips.test.js）。

   邮件里的叙述句形如：
     「截止W34，SO同比+XX%，WoW+XX%，XX国家办WoW涨幅最大，XX国家办跌幅最大，
       XX国家办连续4周周销持续上涨，…，XX产品渠道DOS超120天，全流程DOS超200天」
   这些 XX 全部是芯片。芯片分两类：
     · 数值芯片：SO同比 / WoW / 本周SO / 渠道DOS / 全流程DOS …（一个数）
     · 名单芯片：WoW涨幅最大 / 跌幅最大 / 连续N周上涨(下滑) / DOS超X天 …（一串名字）
   名单芯片的取数基础是 report() 的行数组（每行带 weekly[] / wow / dos / flowDos），
   本文件只做纯计算，不发请求 —— 看板/导出各自把 report 结果喂进来。

   另含「新品首销」的全部口径（用户 2026-08-21 拍板）：
     · 首销期 = 固定窗口 N 天（默认 30，可配）
     · 同比上代 = 同一国家、上代从它自己真实首销日起、对齐同样天数的累计 SO
     · 首销日自动识别（剔除上市前零星样机激活），用户可在子看板拖竖线微调
   ============================================================ */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.WeeklyChips = api;
})(this, function () {

  /* ---------- 格式化（与周报正文口径一致） ---------- */
  const isNum = v => v != null && isFinite(v);
  function fmtInt(v) { return isNum(v) ? Math.round(v).toLocaleString('en-US') : '—'; }
  /* 非零但四舍五入后成 0 的，自动补小数位到看得见为止(最多 2 位)。
     否则「巴西国家办WoW涨幅最大(+0%)」这种句子会自相矛盾——+0.4% 被抹成 +0%。
     真正的 0 仍然显示 0%。 */
  function fmtPct(v, dp, signed) {
    if (!isNum(v)) return '—';
    let d = dp == null ? 0 : dp;
    if (v !== 0) { while (d < 2 && Math.abs(v * 100).toFixed(d) === (0).toFixed(d)) d++; }
    const s = (v * 100).toFixed(d) + '%';
    return (signed !== false && v >= 0) ? '+' + s : s;
  }
  /* 名单：空 → '无'（明确结论，不是留空——用户 2026-08-21：空着让人以为没算）；
     多个用顿号；上限截断防句子爆炸 */
  function fmtList(names, max) {
    const a = (names || []).filter(Boolean);
    if (!a.length) return '无';
    const m = max || 4;
    return a.length > m ? a.slice(0, m).join('、') + '等' + a.length + '个' : a.join('、');
  }

  /* ---------- 名单类计算（输入 = report() 的行数组） ----------
     row 形态（engine-report 已算好）：{key, weekly:[..], wow, dos, flowDos, cumCur, ...}
     约定：合计行不在 rows 里（调用方传 r.rows，不含 r.total）。 */

  // 末端连续 n 周严格上涨/下滑（用 weekly 数组；不足 n+1 周 → false）
  /* trimTail：砍掉尾部的 0 周再判断。**只给音频用**——音频 SO 人工延迟报量，
     末尾一两周恒为 0 是「还没录」不是「卖了 0」，不砍的话连涨连跌永远判不出来
     （实测：音频 W33/W34 全 0，8 个国家办一个都进不了名单，叙述句整段是「无」）。
     平板必须保留 0 周：那是真的一台没卖，属于下滑。 */
  function hasStreak(weekly, n, dir, trimTail) {
    let w = (weekly || []).map(v => +v || 0);
    if (trimTail) { let e = w.length; while (e > 0 && w[e - 1] === 0) e--; w = w.slice(0, e); }
    if (w.length < n + 1) return false;
    for (let i = w.length - n; i < w.length; i++) {
      if (dir === 'up' ? !(w[i] > w[i - 1]) : !(w[i] < w[i - 1])) return false;
    }
    return true;
  }
  const listStreak = (rows, n, dir) => (rows || []).filter(r => hasStreak(r.weekly, n, dir, r.hasAu)).map(r => r.key);

  // WoW 涨/跌幅最大（wow=null 的行不参与；全 null → null）
  function topMover(rows, dir) {
    let best = null;
    (rows || []).forEach(r => {
      if (!isNum(r.wow)) return;
      if (!best || (dir === 'fall' ? r.wow < best.wow : r.wow > best.wow)) best = r;
    });
    if (!best) return null;
    if (dir === 'fall' && best.wow >= 0) return null;   // 没有下跌的就说没有,别把涨得最少的说成跌幅最大
    if (dir !== 'fall' && best.wow <= 0) return null;
    return { key: best.key, wow: best.wow, series: best.series };
  }

  /* ---------- 叙述句名称短显(用户 2026-08-24:产品全名太长,一行全是名字) ----------
     · 地理名一律剥「国家办/终端事业部/业务部」后缀:巴西国家办 → 巴西
     · 产品级(国家块 scope,行是产品/型号)默认显示**系列名**;芯片可配 nameBy:
       'series'=系列名 / 'key'=原名。family/rep 层不做系列映射——分组行的
       series 是组内任取的一条,映射出来是错的。
     只影响叙述句与导出正文;表格仍是全名(表是对账基准)。 */
  function shortGeo(name) { return String(name == null ? '' : name).replace(/(终端事业部|业务部|国家办)$/, ''); }
  function dispName(r, cfg, lv) {
    let n = r && r.key;
    const by = (cfg && cfg.nameBy) || (lv === 'country' ? 'series' : 'key');
    if (by === 'series' && r && r.series) n = r.series;
    return shortGeo(n);
  }
  // 系列映射后同名去重:保留首个(行序=累计SO 高→低,首个就是量最大的那条)
  function uniqBy(items, keyOf) {
    const seen = {}; const out = [];
    (items || []).forEach(it => { const k = keyOf(it); if (!seen[k]) { seen[k] = 1; out.push(it); } });
    return out;
  }

  // DOS 超阈值名单（field: 'dos' | 'flowDos'；null 不参与——null 是「算不出」不是超标）
  const listDosOver = (rows, field, x) => (rows || []).filter(r => isNum(r[field]) && r[field] > x).map(r => r.key);

  /* ---------- 芯片目录 ----------
     每个芯片: {id, lab(料架名), kind:'num'|'list'|'meta', 需要的 scope 维度}
     scope.level: total(产业整体) / family(按系列) / rep(按国家办) / country(某国按产品)
     解析入口 resolveChip(cfg, ctx)：
       ctx = { week:'W34', finTitle:{ym,fcVer}, scopes:{ total:{total,rows}, family:{...},
               rep:{...}, country:{ 墨西哥:{total,rows}, ... } }, newprod:{ <id>:{...} } } */
  const CATALOG = [
    { id: 'week', kind: 'meta', lab: '当前周号' },
    { id: 'finMonth', kind: 'meta', lab: '财经数据月' },
    { id: 'fcVer', kind: 'meta', lab: '预测版本' },
    { id: 'soYoy', kind: 'num', lab: 'SO同比(YTD)' },
    { id: 'siYoy', kind: 'num', lab: 'SI同比(YTD)' },
    { id: 'wow', kind: 'num', lab: 'WoW%' },
    { id: 'weekSo', kind: 'num', lab: '本周SO' },
    { id: 'cumSo', kind: 'num', lab: '累计SO' },
    { id: 'cumSi', kind: 'num', lab: '累计SI' },
    { id: 'dos', kind: 'num', lab: '渠道DOS' },
    { id: 'flowDos', kind: 'num', lab: '全流程DOS' },
    { id: 'inv', kind: 'num', lab: '渠道库存' },
    { id: 'topRise', kind: 'list', lab: 'WoW涨幅最大' },
    { id: 'topFall', kind: 'list', lab: 'WoW跌幅最大' },
    { id: 'streakUp', kind: 'list', lab: '连续N周上涨', n: 4 },
    { id: 'streakDown', kind: 'list', lab: '连续N周下滑', n: 4 },
    { id: 'dosOver', kind: 'list', lab: '渠道DOS超X天', x: 120 },
    { id: 'flowDosOver', kind: 'list', lab: '全流程DOS超X天', x: 200 },
    // 新品首销（scope.level='np', value=新品id；ctx.scopes.np[id] 由新品模块喂进来）
    { id: 'npCountries', kind: 'np', lab: '首销国数' },
    { id: 'npCum', kind: 'np', lab: '首销累计台数' },
    { id: 'npTarget', kind: 'np', lab: '首销目标' },
    { id: 'npAttain', kind: 'np', lab: '首销达成率' },
    { id: 'npYoy', kind: 'np', lab: '同比上代首销同期' },
  ];
  const chipDef = id => CATALOG.find(c => c.id === id) || null;

  // 料架短标签（编辑区里芯片未解析时的显示）
  function chipLabel(cfg) {
    const d = chipDef(cfg && cfg.id); if (!d) return '?';
    let s = d.lab;
    if (cfg.n) s = s.replace('N', String(cfg.n));
    if (cfg.x) s = s.replace('X', String(cfg.x));
    return s;
  }

  function resolveChip(cfg, ctx) {
    cfg = cfg || {}; ctx = ctx || {};
    const d = chipDef(cfg.id); if (!d) return '—';
    if (d.kind === 'meta') {
      if (cfg.id === 'week') return ctx.week || '—';
      if (cfg.id === 'finMonth') return (ctx.finTitle && ctx.finTitle.ym) || '—';
      if (cfg.id === 'fcVer') return (ctx.finTitle && ctx.finTitle.fcVer) || '—';
      return '—';
    }
    if (d.kind === 'np') {
      const np = ctx.scopes && ctx.scopes.np && ctx.scopes.np[(cfg.scope || {}).value];
      if (!np) return '—';
      switch (cfg.id) {
        case 'npCountries': return String(np.countries != null ? np.countries : '—');
        case 'npCum': return fmtInt(np.actual);
        case 'npTarget': return fmtInt(np.target);
        case 'npAttain': return np.attain == null ? '—' : fmtPct(np.attain, cfg.dp != null ? cfg.dp : 0, false);
        case 'npYoy': return np.yoy == null ? '—' : fmtPct(np.yoy, cfg.dp != null ? cfg.dp : 0);
      }
      return '—';
    }
    // 定位 scope 数据
    const lv = (cfg.scope && cfg.scope.level) || 'total';
    const sc = lv === 'country'
      ? (ctx.scopes && ctx.scopes.country && ctx.scopes.country[(cfg.scope || {}).value]) || null
      : (ctx.scopes && ctx.scopes[lv]) || null;
    if (!sc) return '—';
    const T = sc.total || {}, rows = sc.rows || [];
    if (d.kind === 'num') {
      const dp = cfg.dp != null ? cfg.dp : 0;
      switch (cfg.id) {
        case 'soYoy': return fmtPct(T.yoy, dp);
        case 'siYoy': return fmtPct(T.siYoy, dp);
        case 'wow': return fmtPct(T.wow, dp);
        case 'weekSo': { // 音频取最后一个有数的周(延迟报量,末周恒 0)
          let w = (T.weekly || []).slice();
          if (T.hasAu) { while (w.length && !(+w[w.length - 1] > 0)) w.pop(); }
          return w.length ? fmtInt(w[w.length - 1]) : '—'; }
        case 'cumSo': return fmtInt(T.cumCur);
        case 'cumSi': return fmtInt(T.siCur);
        case 'dos': return isNum(T.dos) ? String(T.dos) : '—';
        case 'flowDos': return isNum(T.flowDos) ? String(T.flowDos) : '—';
        case 'inv': return fmtInt(T.inv);
      }
      return '—';
    }
    // list（用户 2026-08-21：降幅最大的也要把数讲出来 → 默认带幅度/天数，cfg.showVal===false 可关）
    const max = cfg.max || 4;
    const withVal = cfg.showVal !== false;
    const nm = r => dispName(r, cfg, lv);
    switch (cfg.id) {
      case 'topRise': { const t = topMover(rows, 'rise'); return t ? (nm(t) + (withVal ? '(' + fmtPct(t.wow, cfg.dp != null ? cfg.dp : 0) + ')' : '')) : '无'; }
      case 'topFall': { const t = topMover(rows, 'fall'); return t ? (nm(t) + (withVal ? '(' + fmtPct(t.wow, cfg.dp != null ? cfg.dp : 0) + ')' : '')) : '无'; }
      case 'streakUp': case 'streakDown': {
        const dir = cfg.id === 'streakUp' ? 'up' : 'down';
        const hit = (rows || []).filter(r => hasStreak(r.weekly, cfg.n || 4, dir, r.hasAu));
        return fmtList(uniqBy(hit.map(r => ({ n: nm(r) })), x => x.n).map(x => x.n), max);
      }
      case 'dosOver': {
        const hit = (rows || []).filter(r => r.dos != null && isFinite(r.dos) && r.dos > (cfg.x || 120));
        return fmtList(uniqBy(hit.map(r => ({ n: nm(r), v: r.dos })), x => x.n).map(x => x.n + (withVal ? '(' + x.v + '天)' : '')), max);
      }
      case 'flowDosOver': {
        const hit = (rows || []).filter(r => r.flowDos != null && isFinite(r.flowDos) && r.flowDos > (cfg.x || 200));
        return fmtList(uniqBy(hit.map(r => ({ n: nm(r), v: r.flowDos })), x => x.n).map(x => x.n + (withVal ? '(' + x.v + '天)' : '')), max);
      }
    }
    return '—';
  }

  /* ---------- 叙述文档（复用 TextoutCore 的 {v,lines:[{runs}]} 思想的极简版） ----------
     doc = {lines:[{runs:[{t:'text',s}|{t:'chip',cfg}]}]}
     resolveDoc → 纯文本（导出正文用）。 */
  function resolveDoc(doc, ctx) {
    const lines = (doc && doc.lines) || [];
    return lines.map(L => (L.runs || []).map(r =>
      r.t === 'chip' ? resolveChip(r.cfg, ctx) : String(r.s == null ? '' : r.s)
    ).join('')).join('\n');
  }
  function docFromTemplate(parts) {
    // parts: 字符串与 {chip:cfg} 交替的一维数组；'\n' 分行
    const lines = [{ runs: [] }];
    parts.forEach(p => {
      if (p && p.chip) { lines[lines.length - 1].runs.push({ t: 'chip', cfg: p.chip }); return; }
      String(p == null ? '' : p).split('\n').forEach((seg, i) => {
        if (i > 0) lines.push({ runs: [] });
        if (seg) lines[lines.length - 1].runs.push({ t: 'text', s: seg });
      });
    });
    return { lines };
  }

  /* ---------- 新品首销 ----------
     日序列 days = [{d:'YYYY-MM-DD', so:number}]（该产品×该国家，渠道全加，缺日可不在）。 */
  const dayMs = 86400000;
  const toT = s => { const m = String(s || '').match(/^(\d{4})-(\d{2})-(\d{2})/); return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) : NaN; };
  const toD = t => { const d = new Date(t); return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0') + '-' + String(d.getUTCDate()).padStart(2, '0'); };

  /* 自动识别真实首销日：上市前的零星样机激活量级远低于放量。
     口径：**前视 7 天和** F(t)=Σso[t, t+6]，峰值×ratio 与 minUnits 取大为门槛 thr；
     首销日 = 第一个满足「F(t) ≥ thr 且 当日 so ≥ thr/7」的日子。
     单日门槛是关键——只看窗口和的话，样机期最后几天会因为窗口探进放量区而被误认成首销
     （实测踩过：样机 2 台/天的 5/15，前视窗口吃到 5/21 的 80 台就达标了）。
     识别结果只是**建议**，用户在子看板里拖竖线定的日子优先。 */
  function detectFirstSale(days, opt) {
    const o = opt || {};
    const ratio = o.ratio != null ? o.ratio : 0.15;
    const minUnits = o.minUnits != null ? o.minUnits : 20;
    const arr = (days || []).filter(x => x && x.d && isNum(+x.so)).slice()
      .sort((a, b) => toT(a.d) - toT(b.d));
    if (!arr.length) return null;
    // 前视 7 天和
    const fwd = [];
    let peak = 0;
    for (let i = 0; i < arr.length; i++) {
      const t1 = toT(arr[i].d) + 6 * dayMs;
      let s = 0;
      for (let j = i; j < arr.length && toT(arr[j].d) <= t1; j++) s += +arr[j].so || 0;
      fwd.push(s);
      if (s > peak) peak = s;
    }
    if (peak <= 0) return null;
    const thr = Math.max(minUnits, peak * ratio);
    for (let i = 0; i < arr.length; i++) {
      if (fwd[i] >= thr && (+arr[i].so || 0) >= thr / 7) return arr[i].d;
    }
    for (let i = 0; i < arr.length; i++) { if (fwd[i] >= thr && (+arr[i].so || 0) > 0) return arr[i].d; }
    const first = arr.find(x => (+x.so || 0) > 0);   // 兜底：从没放过量
    return first ? first.d : null;
  }

  // 从 start 起 n 天（含 start）的累计 SO；n<=0 → 0
  function cumFrom(days, start, n) {
    const t0 = toT(start); if (isNaN(t0) || !(n > 0)) return 0;
    const t1 = t0 + (n - 1) * dayMs;
    let s = 0;
    (days || []).forEach(x => { const t = toT(x.d); if (t >= t0 && t <= t1) s += +x.so || 0; });
    return Math.round(s);
  }

  /* 一国一行：新品 vs 上代 对齐同天数。
     入参：{ days, firstSale, onlineFirst, offlineFirst, target,
             predDays, predFirstSale, windowN, today }
     天数 elapsed = min(今天-首销+1, windowN)（首销未到 → 0）。
     实际达成 = 新品首销起 elapsed 天累计；同比上代 = 上代首销起同样 elapsed 天累计。 */
  function firstSaleRow(p) {
    p = p || {};
    const N = Math.max(1, Math.round(+p.windowN || 30));
    const today = p.today || toD(Date.now());
    const t0 = toT(p.firstSale);
    let elapsed = 0;
    if (!isNaN(t0)) elapsed = Math.min(N, Math.max(0, Math.floor((toT(today) - t0) / dayMs) + 1));
    const actual = elapsed > 0 ? cumFrom(p.days, p.firstSale, elapsed) : 0;
    const target = isNum(+p.target) && +p.target > 0 ? Math.round(+p.target) : null;
    const attain = target ? actual / target : null;
    let predCum = null, yoy = null;
    if (p.predFirstSale && elapsed > 0) {
      predCum = cumFrom(p.predDays, p.predFirstSale, elapsed);
      yoy = predCum > 0 ? actual / predCum - 1 : null;
    }
    return {
      firstSale: p.firstSale || '', onlineFirst: p.onlineFirst || '', offlineFirst: p.offlineFirst || '',
      elapsed, windowN: N, progress: elapsed / N,
      actual, target, attain, predCum, yoy,
      done: elapsed >= N,
    };
  }

  // 汇总行：Σ实际、Σ目标、总达成、混合同比（Σ新 ÷ Σ上代对齐累计 − 1）
  function firstSaleTotal(rows) {
    const rs = (rows || []).filter(Boolean);
    const actual = rs.reduce((s, r) => s + (+r.actual || 0), 0);
    const target = rs.some(r => isNum(r.target)) ? rs.reduce((s, r) => s + (+r.target || 0), 0) : null;
    const pred = rs.some(r => isNum(r.predCum)) ? rs.reduce((s, r) => s + (+r.predCum || 0), 0) : null;
    return {
      actual, target,
      attain: target ? actual / target : null,
      predCum: pred,
      yoy: (pred != null && pred > 0) ? actual / pred - 1 : null,
    };
  }

  return {
    fmtInt, fmtPct, fmtList,
    hasStreak, listStreak, topMover, listDosOver, shortGeo, dispName,
    CATALOG, chipDef, chipLabel, resolveChip, resolveDoc, docFromTemplate,
    detectFirstSale, cumFrom, firstSaleRow, firstSaleTotal,
  };
});

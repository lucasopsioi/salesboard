(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.PptBindings = api;
})(this, function () {
  const PptNumFmt = (typeof module !== 'undefined' && module.exports)
    ? require('./numfmt.js')
    : (typeof window !== 'undefined' ? window.PptNumFmt : null);
  const PptWeekly = (typeof module !== 'undefined' && module.exports)
    ? require('./weekly-core.js')
    : (typeof window !== 'undefined' ? window.PptWeekly : null);

  // WK5: 周报分组维度 → 中文列头 label(缺省用 groupDim 原值)
  const GROUP_LABEL = { line: '产品线', family: '产品系列', rep: '国家办', country: '国家', model: '产品型号' };
  // WK5: 读路标数据源:浏览器 window.roadmapData();node 测试经 binding._rmData 注入;均缺省 → 空表
  function rmDataOf(b) {
    if (typeof window !== 'undefined' && typeof window.roadmapData === 'function') return window.roadmapData() || {};
    return (b && b._rmData) || { products: [], samples: [], launch: [], battle: [] };
  }

  // F5: is catField a time dimension for the given dataset?
  function isTimeField(f, ds) {
    if (ds === 'idc') return f === 'quarter' || f === 'year';
    return f === 'period';
  }

  // F6/C1: 哪些指标是流量(可跨期求和)；其余视为快照(取末期值)。
  const FLOW = { sellOut: 1, sellIn: 1, units: 1, value: 1 };

  // C1: 取 [from,to] 内各桶跨系列求和值，再按 aggType 归并。
  //   sum→求和 / last→区间内最后一个桶(cats 升序末位) / avg|asp→均值 / max|min→极值。无桶→0。
  function aggInRange(m, from, to, aggType) {
    const cats = (m && m.cats) || [];
    const series = (m && m.series) || [];
    const buckets = [];
    for (let i = 0; i < cats.length; i++) {
      const c = cats[i];
      if ((from == null || c >= from) && (to == null || c <= to)) {
        let sum = 0;
        for (let s = 0; s < series.length; s++) {
          const vals = series[s].values || [];
          sum += (+vals[i] || 0);
        }
        buckets.push(sum);
      }
    }
    if (!buckets.length) return 0;
    switch (aggType) {
      case 'last': return buckets[buckets.length - 1];
      case 'avg':
      case 'asp': return buckets.reduce((a, b) => a + b, 0) / buckets.length;
      case 'max': return Math.max.apply(null, buckets);
      case 'min': return Math.min.apply(null, buckets);
      case 'sum':
      default: return buckets.reduce((a, b) => a + b, 0);
    }
  }

  // F6: format the compare result. fmt 是唯一权威：pct/pctword 用比率(ratio)，abs 用绝对差(diff)。
  // 这样格式与数值不会错配（旧版把 op=diff 的绝对值再 ×100 当百分比，会出乱码）。
  function fmtCompare(fmt, ratio, diff, d, suffix) {
    let out;
    if (fmt === 'pp') {
      if (diff == null) return '—';
      const p = diff * 100;
      out = (p >= 0 ? '+' : '') + p.toFixed(d) + ' pp';
    } else if (fmt === 'abs') {
      out = (diff >= 0 ? '+' : '') + (PptNumFmt ? PptNumFmt.formatNum(diff, 'auto', d) : String(diff));
    } else if (ratio === null) {
      out = '—';
    } else {
      const p = ratio * 100;
      const base = (p >= 0 ? '+' : '') + p.toFixed(d) + '%';
      out = fmt === 'pctword' ? (base + ' pct') : base;
    }
    return suffix ? (out + ' ' + suffix) : out;
  }

  async function resolveElement(api, PptBind, el) {
    const b = el && el.binding;
    if (!b || (el.type !== 'data' && el.type !== 'table' && el.type !== 'chart')) return { kind: 'none' };
    if (el.type === 'data') {
      // F2 经营(财经) compare：source==='finance' 走预设期间(同比/环比)，置于通用 compare 之前
      if (b.mode === 'compare' && b.compare && b.compare.source === 'finance') {
        const cmp = b.compare, sc = cmp.scope || {};
        const per = PptBind.comparePeriodsForPreset(cmp.preset || 'yoy', { curYear: sc.year, fromM: sc.fromM, toM: sc.toM });
        const mk = (pp) => ({ dataset: 'finance', measure: sc.measure, basis: 'actual', filters: sc.filters, version: sc.version, finUnits: sc.finUnits, year: pp.year, fromM: pp.fromM, toM: pp.toM });
        const A = await PptBind.resolveFinanceTotal(api, mk(per.a));
        const Bv = await PptBind.resolveFinanceTotal(api, mk(per.b));
        const diff = (A == null || Bv == null) ? null : Bv - A;
        const ratio = (A == null || Bv == null || A === 0) ? null : diff / A;
        const fmt = cmp.fmt || (PptBind.FIN_FMT_DEFAULT && PptBind.FIN_FMT_DEFAULT[sc.measure]) || 'pct';
        const d = cmp.decimals == null ? 1 : cmp.decimals;
        const text = fmtCompare(fmt, ratio, diff, d, cmp.suffix);
        return { kind: 'value', value: (fmt === 'abs' || fmt === 'pp') ? diff : ratio, compare: true, fmt: fmt, totalA: A, totalB: Bv, text: text };
      }
      // F2 经营(财经) data → total
      if (b.dataset === 'finance' && b.mode !== 'compare') {
        return { kind: 'value', value: await PptBind.resolveFinanceTotal(api, b), yoy: null };
      }
      // F6 同比/对比：mode==='compare'
      if (b.mode === 'compare' && b.compare) {
        const cmp = b.compare;
        const fmt = cmp.fmt || 'pct';
        const d = cmp.decimals == null ? 1 : cmp.decimals;
        const totalFor = async (side) => {
          if (!side) return 0;
          const syn = {
            dataset: side.dataset || b.dataset,
            measure: side.measure,
            agg: side.agg,
            catField: side.catField || 'period',
            catGran: 'month',
            filters: side.filters
          };
          const m = syn.dataset === 'idc'
            ? await PptBind.resolveIdcMatrix(api, syn)
            : await PptBind.resolveMatrix(api, syn);
          const aggType = side.agg || (FLOW[side.measure] ? 'sum' : 'last');
          return aggInRange(m, side.timeFrom, side.timeTo, aggType);
        };
        const totalA = await totalFor(cmp.a);
        const totalB = await totalFor(cmp.b);
        const diff = totalB - totalA;
        const ratio = (totalA === 0) ? null : diff / totalA;          // 同比比率
        const value = (fmt === 'abs') ? diff : ratio;                 // 预览正负配色用
        const text = fmtCompare(fmt, ratio, diff, d, cmp.suffix);
        return { kind: 'value', value: value, compare: true, fmt: fmt, totalA: totalA, totalB: totalB, text: text };
      }
      if (b.dataset === 'idc') {
        const m = await PptBind.resolveIdcMatrix(api, b);
        let v = 0; (m.series || []).forEach(s => (s.values || []).forEach(x => v += (+x || 0)));
        return { kind: 'value', value: v, yoy: null };
      }
      // PSI data box：按指标语义取数(report total)
      const rep = await Promise.resolve(api.report({ groupDim: b.groupDim || 'line', filters: b.filters || {} }));
      const t = (rep && rep.total) || {};
      const measure = b.measure || 'sellOut';
      const M = {
        sellOut: { value: t.cumCur || 0, yoy: (t.yoy == null ? null : t.yoy) },
        sellIn:  { value: t.siCur || 0,  yoy: (t.siYoy == null ? null : t.siYoy) },
        inv:     { value: t.inv || 0,    yoy: null },
        dos:     { value: (t.dos == null ? null : t.dos), yoy: null }   // 算不出的 DOS 保持 null(上层显 '-')；||0 会印成「0 天」，读起来像马上断货
      };
      const r = M[measure] || M.sellOut;
      return { kind: 'value', value: r.value, yoy: r.yoy };
    }
    // WK5: 周报三 grid 数据源(仅 table 元素;置于 finance/psi/idc matrix 之前)
    if (el.type === 'table' && (b.dataset === 'report' || b.dataset === 'siso' || b.dataset === 'roadmap')) {
      // ① report:引擎 report() → reportGrid(weekLabels 已带 'W' 前缀,透传)
      if (b.dataset === 'report') {
        const rep = await Promise.resolve(api.report({ groupDim: b.groupDim || 'line', weeks: b.weeks || 9, filters: b.filters || {} }));
        const label = GROUP_LABEL[b.groupDim || 'line'] || (b.groupDim || 'line');
        return Object.assign({ kind: 'grid' }, PptWeekly.reportGrid(rep, label));
      }
      // ② siso:financeCustom(预测,按型号) 提供 SI/SO 计划;report(model,实际) 提供进展;nameMap=路标 psiLink→传播名
      if (b.dataset === 'siso') {
        const fc = await Promise.resolve(api.financeCustom({
          rowDim: 'model', metrics: ['sellIn', 'sellOut'], basis: 'forecast',
          version: b.version, year: b.year,
          finUnits: { actual: 'USD', forecast: 'MUSD', bp: 'USD' }, finQtyUnits: undefined
        }));
        const rep = await Promise.resolve(api.report({ groupDim: 'model', filters: {} }));
        const actRows = ((rep && rep.rows) || []).map(r => ({ key: r.key, cumCur: r.cumCur, siCur: r.siCur }));
        const rm = rmDataOf(b);
        const nameMap = {};
        ((rm && rm.products) || []).forEach(p => { if (p.psiLink) nameMap[p.psiLink] = p.name; });
        return Object.assign({ kind: 'grid' }, PptWeekly.sisoGrid({
          fcRows: (fc && fc.rows) || [], actRows: actRows, nameMap: nameMap, version: b.version || ''
        }));
      }
      // ③ roadmap:按 b.table 分发 launch/battle/samples/sku/acc
      const rm = rmDataOf(b);
      const products = (rm && rm.products) || [];
      const launch = (rm && rm.launch) || [];
      const battle = (rm && rm.battle) || [];
      const samples = (rm && rm.samples) || [];
      const pById = {}; products.forEach(p => { pById[p.id] = p; });
      const table = b.table || 'samples';
      if (table === 'launch') {
        // 每行:agg(sellOut,按月) → cats/各系列跨列求和 → launchMonthSO → soLookup
        const soLookup = {};
        for (const row of launch) {
          const p = pById[row.productId] || {};
          if (!p.psiLink) continue;
          const m = await Promise.resolve(api.agg({
            measure: 'sellOut', agg: 'sum', cat: { field: 'period', gran: 'month' },
            filters: { model: [p.psiLink], country: [row.country] }
          }));
          const cats = (m && m.cats) || [];
          const series = (m && m.series) || [];
          const data = (m && m.data) || {};
          const values = cats.map(c => series.reduce((sum, se) => sum + (+(data[se] && data[se][c]) || 0), 0));
          const so = PptWeekly.launchMonthSO(cats, values);
          if (so) soLookup[`${row.productId}|${row.country}`] = so;
        }
        return Object.assign({ kind: 'grid' }, PptWeekly.launchGrid(launch, soLookup, pById));
      }
      if (table === 'battle') {
        // battle rows 按 productId+country 聚 rivals;rrpLocal(products.pricing 按 country);launch 同键补齐字段
        const byKey = {};
        battle.forEach(bt => {
          const k = `${bt.productId}|${bt.country}`;
          if (!byKey[k]) byKey[k] = { productId: bt.productId, country: bt.country, rivals: [] };
          byKey[k].rivals.push({ rival: bt.rival, priceLocal: bt.priceLocal });
        });
        const launchByKey = {};
        launch.forEach(l => { launchByKey[`${l.productId}|${l.country}`] = l; });
        const battleJoin = Object.keys(byKey).map(k => {
          const g = byKey[k];
          const p = pById[g.productId] || {};
          const pr = (p.pricing || []).find(x => x.country === g.country);
          const l = launchByKey[k] || {};
          return {
            country: g.country, rrpLocal: pr ? pr.rrpLocal : null, rivals: g.rivals,
            firstOffer: l.firstOffer, firstGm: l.firstGm, firstTarget: l.firstTarget,
            lifecycleTarget: l.lifecycleTarget, presaleDate: l.presaleDate, overallDate: l.overallDate,
            aatpEst: l.aatpEst, channel: l.channel
          };
        });
        return Object.assign({ kind: 'grid' }, PptWeekly.battleGrid(battleJoin));
      }
      if (table === 'sku') return Object.assign({ kind: 'grid' }, PptWeekly.skuGrid(products));
      if (table === 'acc') return Object.assign({ kind: 'grid' }, PptWeekly.accGrid(products));
      // 默认 samples
      return Object.assign({ kind: 'grid' }, PptWeekly.samplesGrid(samples, pById));
    }
    // table / chart → matrix
    // F2 经营(财经) chart/table → matrix（财经无时间轴，不做 F5 切片/seriesOrder 反转）
    if (b.dataset === 'finance') {
      const fm = await PptBind.resolveFinanceMatrix(api, b);
      return { kind: 'matrix', cats: fm.cats || [], series: fm.series || [] };
    }
    const m = b.dataset === 'idc' ? await PptBind.resolveIdcMatrix(api, b) : await PptBind.resolveMatrix(api, b);
    let cats = m.cats || [];
    let series = m.series || [];
    // F5 时间切片：catField 为时间维且设置了 timeFrom/timeTo
    if ((b.timeFrom != null || b.timeTo != null) && isTimeField(b.catField, b.dataset)) {
      const keep = [];
      for (let i = 0; i < cats.length; i++) {
        const c = cats[i];
        if ((b.timeFrom == null || c >= b.timeFrom) && (b.timeTo == null || c <= b.timeTo)) keep.push(i);
      }
      cats = keep.map(i => cats[i]);
      series = series.map(s => ({ ...s, values: keep.map(i => (s.values || [])[i]) }));
    }
    // S1: seriesOrder 重排——列出的按该序在前(按 name 匹配),未列出的按原序补末
    if (Array.isArray(b.seriesOrder) && b.seriesOrder.length) {
      const listed = [];
      const seen = {};
      b.seriesOrder.forEach(n => { const s = series.find(x => x.name === n); if (s && !seen[n]) { listed.push(s); seen[n] = 1; } });
      const rest = series.filter(s => !seen[s.name]);
      series = listed.concat(rest);
    }
    return { kind: 'matrix', cats: cats, series: series };
  }
  return { resolveElement };
});

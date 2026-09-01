'use strict';
/* ============================================================
   路标自动识别核心 —— 从 PSI 的逐月 SI/SO 序列反推「产品真正的上市时间与退市时间」

   为什么需要它：路标里原来的上市点是 `第一个 SellOut>0 的日子`（engine-industry
   `_lifecycleSide`）。可上市前普遍有少量样机/送测激活，于是路标上市时间被这几台样机
   拽到真实上市之前好几个月，每个产品都要人工回去改。

   本文件**只做判定，不取数**（取数在 engine-psi.launchScan），全部是纯函数，Node 可直测。
   判定结果是**建议**，一律送进评审界面由人确认——软件不自动改路标。

   ── 上市判定 ────────────────────────────────────────────────
   样机激活的特征是「量级远低于正式铺货后的动销」，所以按**相对峰值**设门槛，
   而不是拍一个绝对台数（不同产品、不同国家覆盖面差一两个数量级）：
       门槛 = max(launchMinUnits, 峰值月SO × launchRatio)
       上市月 = 第一个 月SO ≥ 门槛 的月
   门槛之前那些有零星 SO 的月＝样机期，原样列给用户看（几个月、共几台），
   让人一眼判断软件切得对不对。

   ── 退市判定 ────────────────────────────────────────────────
   用户口径：「最终月销小于生命周期一定比例，就基本退市」。
       基准 = 上市月起到末端的**月均 SO**（生命周期均值，不用峰值——峰值受首销脉冲影响过大）
       门槛 = 基准 × eolRatio
       连续 eolMonths 个月低于门槛 → 判退市，退市月 = 最后一个 ≥ 门槛 的月
   **末端保护**：最后 tailGuard 个月不参与判定。底表末月往往还没录全，音频更是人工
   延迟报量 1~2 周（见项目口径），不设保护会把「还没录完」误判成「卖完了」。

   ── 置信度 ──────────────────────────────────────────────────
   给评审界面排序用：样机量相对上市月量越小、上市月越接近峰值，越可信；
   总量太小的产品一律标低置信度（样本不足，规则本身就不该信）。
   ============================================================ */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.RoadmapDetect = api;
})(this, function () {

  const DEFAULTS = {
    launchRatio: 0.15,     // 上市门槛占峰值月SO的比例
    launchMinUnits: 30,    // 上市门槛绝对下限（台）——防超小产品被样机噪声顶上去
    eolRatio: 0.10,        // 退市门槛占生命周期月均的比例
    eolMonths: 3,          // 连续几个月低于退市门槛才判退市
    tailGuard: 1,          // 末端保护月数（数据未录全）
    tailGuardAudio: 2,     // 音频人工延迟报量，末端多护一个月
    minTotalSO: 100,       // 累计SO 低于此值不下结论（样本不足）
  };

  const clampOpt = o => {
    const d = Object.assign({}, DEFAULTS, o || {});
    d.launchRatio = Math.min(0.9, Math.max(0.01, +d.launchRatio || DEFAULTS.launchRatio));
    d.eolRatio = Math.min(0.9, Math.max(0.01, +d.eolRatio || DEFAULTS.eolRatio));
    d.launchMinUnits = Math.max(0, +d.launchMinUnits || 0);
    d.eolMonths = Math.max(1, Math.round(+d.eolMonths || DEFAULTS.eolMonths));
    d.tailGuard = Math.max(0, Math.round(+d.tailGuard != null ? +d.tailGuard : DEFAULTS.tailGuard));
    d.tailGuardAudio = Math.max(d.tailGuard, Math.round(+d.tailGuardAudio || DEFAULTS.tailGuardAudio));
    d.minTotalSO = Math.max(0, +d.minTotalSO || 0);
    return d;
  };

  // 'YYYY-MM' → 'YYYY/MM'（路标 lifeDate 认这个格式，缺日按当月 1 号）
  const toRoadmapMonth = m => String(m || '').replace('-', '/');

  /* 单个产品的判定。item 来自 engine.launchScan()，months 是共享的连续月轴。 */
  function detectOne(item, months, opt) {
    const o = clampOpt(opt);
    const so = (item && item.so) || [], si = (item && item.si) || [];
    const n = months.length;
    const out = {
      key: item && item.key, isAudio: !!(item && item.isAudio),
      cumSI: (item && item.cumSI) || 0, cumSO: (item && item.cumSO) || 0,
      invLast: (item && item.invLast) || 0, invYmd: (item && item.invYmd) || '',
      firstSI: (item && item.firstSI) || '', firstSO: (item && item.firstSO) || '',
      lastSO: (item && item.lastSO) || '',
      status: 'nodata', confidence: 'low',
      launchMonth: '', launchUnits: 0, launchThr: 0, peakSO: 0,
      sampleMonths: 0, sampleUnits: 0,           // 上市前的样机期
      eolMonth: '', eolThr: 0, baseline: 0, lowRun: 0,
      first4moSO: null,                          // 按识别出的上市月起算（不是「第一个>0的月」）
      notes: [],
    };
    if (!n || !so.length) return out;

    const peak = so.reduce((a, b) => Math.max(a, +b || 0), 0);
    out.peakSO = peak;
    if (peak <= 0) {
      // 只铺了货没动销：可能是刚上市还没回传，也可能是纯备货
      out.status = si.some(v => +v > 0) ? 'siOnly' : 'nodata';
      if (out.status === 'siOnly') out.notes.push('只有 Sell-in、没有任何 Sell-out——可能刚铺货未动销，或 SO 未回传');
      return out;
    }

    /* ---- 上市 ---- */
    const thr = Math.max(o.launchMinUnits, peak * o.launchRatio);
    out.launchThr = Math.round(thr);
    let li = so.findIndex(v => (+v || 0) >= thr);
    if (li < 0) li = so.findIndex(v => (+v || 0) > 0);      // 兜底：达不到门槛就退回首个有量月
    out.launchMonth = months[li];
    out.launchUnits = Math.round(+so[li] || 0);
    for (let i = 0; i < li; i++) {
      const v = +so[i] || 0;
      if (v > 0) { out.sampleMonths++; out.sampleUnits += Math.round(v); }
    }
    // 首4月SO：从**识别出的上市月**起连续 4 个月（旧口径从「第一个>0的月」起，会把样机月算进去）
    let f4 = 0;
    for (let k = li; k < li + 4 && k < n; k++) f4 += Math.round(+so[k] || 0);
    out.first4moSO = f4;

    /* ---- 退市 ---- */
    const guard = item && item.isAudio ? o.tailGuardAudio : o.tailGuard;
    const lastIdx = n - 1 - guard;                          // 参与判定的最后一个月
    if (lastIdx <= li) {
      out.status = 'new';
      out.notes.push('上市不久，可判定的月份不足（末端保护 ' + guard + ' 个月）');
      out.confidence = 'low';
      return out;
    }
    let sum = 0, cnt = 0, gap = 0, gapRun = 0;
    for (let i = li; i <= lastIdx; i++) {
      const v = +so[i] || 0;
      sum += v; cnt++;
      if (v <= 0) { gapRun++; if (gapRun > gap) gap = gapRun; } else gapRun = 0;
    }
    const baseline = cnt ? sum / cnt : 0;
    /* 生命周期中间整月零销售会把均值拉低 → 退市门槛跟着变低 → 该判退市的判不出来。
       是「真的没卖」还是「那几个月没录数」，机器分不出来，所以不擅自剔除，只如实提示。
       （末端的零月不受影响：那是退市判定本身在看的东西。） */
    if (gap >= 2 && gapRun === 0) out.notes.push('生命周期中间有连续 ' + gap + ' 个月零销售，若是数据缺失而非真断货，退市门槛会被拉低、判定偏保守');
    out.baseline = Math.round(baseline);
    const eolThr = baseline * o.eolRatio;
    out.eolThr = Math.round(eolThr);

    let run = 0;
    for (let i = lastIdx; i > li; i--) { if ((+so[i] || 0) < eolThr) run++; else break; }
    out.lowRun = run;
    if (run >= o.eolMonths) {
      out.status = 'eol';
      out.eolMonth = months[lastIdx - run];                 // 最后一个仍在门槛之上的月
      if (out.invLast > 0) out.notes.push('判定退市但仍有库存 ' + out.invLast + ' 台（截至 ' + out.invYmd + '），大概率在清库存');
    } else if (run > 0) {
      out.status = 'declining';
      out.notes.push('末端连续 ' + run + ' 个月低于生命周期均值的 ' + Math.round(o.eolRatio * 100) + '%，尚未达到判退市的 ' + o.eolMonths + ' 个月');
    } else {
      out.status = 'live';
    }

    /* ---- 置信度 ---- */
    const sampleRatio = out.launchUnits > 0 ? out.sampleUnits / out.launchUnits : 0;
    if (out.cumSO < o.minTotalSO) {
      out.confidence = 'low';
      out.notes.push('累计SO 仅 ' + out.cumSO + ' 台，样本太小，规则判不准，请人工确认');
    } else if (out.sampleUnits === 0 || sampleRatio < 0.05) {
      out.confidence = 'high';
    } else if (sampleRatio < 0.3) {
      out.confidence = 'medium';
      out.notes.push('上市前有 ' + out.sampleMonths + ' 个月零星出货共 ' + out.sampleUnits + ' 台（为上市当月的 ' + Math.round(sampleRatio * 100) + '%），已按样机处理');
    } else {
      out.confidence = 'low';
      out.notes.push('上市前出货偏多（' + out.sampleUnits + ' 台，为上市当月的 ' + Math.round(sampleRatio * 100) + '%），可能是缓慢爬坡而非样机，上市月需人工确认');
    }
    if (out.isAudio) out.notes.push('音频为人工延迟报量，末端已保护 ' + guard + ' 个月不参与退市判定');
    return out;
  }

  /* 整批判定。scan = engine.launchScan() 的返回。 */
  function detectAll(scan, opt) {
    const months = (scan && scan.months) || [];
    const items = (scan && scan.items) || [];
    return items.map(it => { const det = detectOne(it, months, opt); det.product = it.product || ''; det.series = it.series || ''; det.line = it.line || ''; return det; });
  }

  /* ---- 路标产品 ↔ PSI 产品 的名称匹配 ----
     优先用产品上已存的 psiLink（用户手工关联过的，最可信）；
     否则归一化后精确匹配，再退到单向包含（只在唯一命中时才算数，避免张冠李戴）。 */
  const norm = s => String(s == null ? '' : s).trim().toLowerCase()
    .replace(/\s+/g, '').replace(/[-_/()（）]/g, '');

  function matchProducts(products, detections) {
    const byNorm = new Map();
    (detections || []).forEach(d => {
      const k = norm(d.key);
      if (!byNorm.has(k)) byNorm.set(k, []);
      byNorm.get(k).push(d);
    });
    const used = new Set();
    const rows = (products || []).map(p => {
      const r = { productId: p.id, name: p.name, psiLink: p.psiLink || '', det: null, how: 'none' };
      if (p.psiLink) {
        const hit = (detections || []).find(d => d.key === p.psiLink) || (byNorm.get(norm(p.psiLink)) || [])[0];
        if (hit) { r.det = hit; r.how = 'link'; used.add(hit.key); return r; }
      }
      const exact = byNorm.get(norm(p.name));
      if (exact && exact.length === 1) { r.det = exact[0]; r.how = 'name'; used.add(exact[0].key); return r; }
      const np = norm(p.name);
      if (np) {
        const cand = (detections || []).filter(d => { const nd = norm(d.key); return nd.indexOf(np) >= 0 || np.indexOf(nd) >= 0; });
        if (cand.length === 1) { r.det = cand[0], r.how = 'fuzzy'; used.add(cand[0].key); return r; }
        if (cand.length > 1) r.how = 'ambiguous';
      }
      return r;
    });
    const orphans = (detections || []).filter(d => !used.has(d.key));   // PSI 里有、路标里还没建的产品
    return { rows, orphans };
  }

  /* 判定 → 路标字段的建议值。**不写盘**，交给评审界面。
     shipLate＝上市时间（路标必填项）；salesEnd＝销售结束（仅在判定退市时给）。 */
  function toRoadmapPatch(det) {
    const patch = {};
    if (!det) return patch;
    if (det.launchMonth) patch.shipLate = toRoadmapMonth(det.launchMonth);
    if (det.status === 'eol' && det.eolMonth) patch.salesEnd = toRoadmapMonth(det.eolMonth);
    if (det.first4moSO != null) patch.first4moSO = det.first4moSO;
    if (det.key) patch.psiLink = det.key;
    return patch;
  }

  const STATUS_LABEL = { live: '在售', declining: '走弱', eol: '已退市', new: '新上市', siOnly: '仅铺货', nodata: '无数据' };
  const CONF_LABEL = { high: '高', medium: '中', low: '低' };

  /* 孤儿聚合(2026-09-01)：底表有、路标没有的 SKU 按 product 聚——
     主卡=最早上市 SKU；晚 ≥lateSkuMonths(默认3) 个月上市的 SKU 单独成卡(新颜色/新型号场景)。 */
  function groupOrphans(orphans, opt) {
    const lateM = Math.max(1, Math.round((opt && opt.lateSkuMonths) || 3));
    const ymn = m => { const x = String(m || ''); const mm = x.match(/^(\d{4})[-/]?(\d{2})$/); return mm ? (+mm[1] * 12 + +mm[2]) : null; };
    const byP = new Map();
    (orphans || []).forEach(d => {
      if (!d || !d.launchMonth) return;
      const pk = d.product || d.key;
      if (!byP.has(pk)) byP.set(pk, []);
      byP.get(pk).push(d);
    });
    const out = [];
    byP.forEach((list, pk) => {
      list.sort((a, b) => (ymn(a.launchMonth) || 9e9) - (ymn(b.launchMonth) || 9e9));
      const first = list[0];
      const base = ymn(first.launchMonth);
      const mains = list.filter(d => (ymn(d.launchMonth) - base) < lateM);
      const lates = list.filter(d => (ymn(d.launchMonth) - base) >= lateM);
      out.push({ kind: 'new', name: pk, product: pk, modelKey: first.key,
        models: mains.map(d => d.key), launchMonth: first.launchMonth,
        eolMonth: first.status === 'eol' ? first.eolMonth : '', status: first.status,
        confidence: first.confidence, series: first.series || '', line: first.line || '' });
      lates.forEach(d => {
        out.push({ kind: 'newSku', name: pk + '（新SKU ' + d.key + '）', product: pk, modelKey: d.key,
          models: [d.key], launchMonth: d.launchMonth,
          eolMonth: d.status === 'eol' ? d.eolMonth : '', status: d.status,
          confidence: d.confidence, series: d.series || '', line: d.line || '' });
      });
    });
    out.sort((a, b) => (ymn(a.launchMonth) || 0) - (ymn(b.launchMonth) || 0));
    return out;
  }

  return { DEFAULTS, clampOpt, detectOne, detectAll, matchProducts, groupOrphans, toRoadmapPatch, toRoadmapMonth, norm, STATUS_LABEL, CONF_LABEL };
});

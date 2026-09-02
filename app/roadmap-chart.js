(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.RoadmapChart = api;
})(this, function () {
  function _dim(y, m) { return new Date(y, m, 0).getDate(); }   // m:1..12 → 当月天数（闰年自适应）
  // 发货时间 → 数值，日精度：量级仍是旧「年*12+月」月序，月内按日线性插值。
  //  · 新 'YYYY/MM/DD'：base + (日-1)/当月天数（1日=+0，月末≈+1），故 1月1日<1月15日<2月1日。
  //  · 旧 'YYYY/MM'（无日）：回退【月初】(+0)，与旧「整数月序」语义完全一致——向后兼容、不改旧数据位置，
  //    又能与含日新值单调可比。分隔符 / - . 皆可；月份越界→null，日越界→夹取到当月合法范围（容错不崩）。
  function ymNum(ym) {
    if (!ym) return null;
    const m = String(ym).match(/^(\d{4})[\/\-.](\d{1,2})(?:[\/\-.](\d{1,2}))?/);
    if (!m) return null;
    const y = +m[1], mo = +m[2];
    if (mo < 1 || mo > 12) return null;
    const base = y * 12 + mo;
    if (m[3] == null) return base;   // 旧月粒度：月初
    const dim = _dim(y, mo);
    const day = Math.min(Math.max(+m[3], 1), dim);
    return base + (day - 1) / dim;
  }
  // range（可选）：{from,to} 显式 X 范围（'YYYY/MM/DD' 或 'YYYY/MM'）。任一有效即 active=true，
  //  未给的一侧回退数据边界；起>止自动交换。active 供 productPoints 判定「超范围产品不画」。空/非法范围=不激活（自动）。
  function timeScale(products, extraTimes, range) {
    const ns = (products || []).map(p => ymNum(p.shipLate)).filter(v => v != null);
    (extraTimes || []).forEach(t => { const n = ymNum(t); if (n != null) ns.push(n); });
    let minN = ns.length ? Math.min(...ns) : 0, maxN = ns.length ? Math.max(...ns) : 0;
    let active = false;
    if (range) {
      const rf = ymNum(range.from), rt = ymNum(range.to);
      if (rf != null) { minN = rf; active = true; }
      if (rt != null) { maxN = rt; active = true; }
      if (active && minN > maxN) { const t = minN; minN = maxN; maxN = t; }
    }
    return { minN, maxN, active, x: (ym) => { const n = ymNum(ym); if (n == null || maxN === minN) return 0.5; return (n - minN) / (maxN - minN); } };
  }
  /* 自动量程留白：直接用 min..max 会让最高价的框贴住顶、最低价的框贴住底（只有两个产品时尤其难看，
     导出图上下都没有余地）。所以自动模式下上下各留 12% 余量，并向「好看的刻度」取整；
     所有价格相同（range=0）时给一个基于价格的对称带宽。手动量程（用户填了 Y 量程）原样尊重，不动。 */
  function _niceStep(range) {
    if (!(range > 0)) return 1;
    const p = Math.pow(10, Math.floor(Math.log10(range / 4)));
    const n = range / 4 / p;
    return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p;
  }
  function priceScale(values, manualRange) {
    let min, max;
    const mF = manualRange && manualRange.from != null && !isNaN(+manualRange.from) ? +manualRange.from : null;
    const mT = manualRange && manualRange.to != null && !isNaN(+manualRange.to) ? +manualRange.to : null;
    if (mF != null && mT != null && mF !== mT) {
      min = Math.min(mF, mT); max = Math.max(mF, mT);                 // 手动量程：用户说了算（起止写反自动对调）
    } else {
      const xs = (values || []).map(Number).filter(v => !isNaN(v));
      let lo = xs.length ? Math.min(...xs) : 0, hi = xs.length ? Math.max(...xs) : 0;
      const span = hi - lo;
      const pad = span > 0 ? span * 0.12 : Math.max(1, Math.abs(hi) * 0.1 || 1);
      const step = _niceStep(span > 0 ? span + pad * 2 : pad * 2);
      lo = Math.floor((lo - pad) / step) * step;
      hi = Math.ceil((hi + pad) / step) * step;
      if (lo > 0 && lo < step) lo = 0;                                // 贴近 0 时干脆落到 0，轴更好读
      if (hi === lo) hi = lo + step;
      min = lo; max = hi;
      // 单边手动(2026-09-01)：只填了起或止 → 该边用户说了算，另一边沿用自动
      if (mF != null && mF !== max) min = mF;
      if (mT != null && mT !== min) max = mT;
      if (max < min) { const t = min; min = max; max = t; }
      if (max === min) max = min + 1;
    }
    return { min, max, y: (v) => (max === min ? 0.5 : (max - v) / (max - min)) };
  }
  function productValue(p, mode, country) {
    if (mode === 'local') { const r = (p.pricing || []).find(x => x.country === country); return (r && r.rrpLocal != null && +r.rrpLocal) ? +r.rrpLocal : null; }
    return (p.compositeRrpUsd == null || isNaN(p.compositeRrpUsd)) ? null : +p.compositeRrpUsd;
  }
  function _config(p) { return [...new Set((p.skus || []).map(s => [s.ram, s.rom].filter(Boolean).join('/')).filter(Boolean))].join(' '); }
  function _num(v) { if (v == null || v === '') return null; const n = +v; return isNaN(n) ? null : n; }
  // 产品的代表汇率（本币换算用）：优先选定国家的定价行 fx，否则第一条有 fx 的行；无则 null。
  function _productFx(p, country) {
    const rows = (p && p.pricing) || [];
    let r = country ? rows.find(x => x.country === country && +x.fx > 0) : null;
    if (!r) r = rows.find(x => +x.fx > 0);
    return r ? +r.fx : null;
  }
  // 一组 SKU 的配置/名称后缀（用于多框标签）：先取 RAM/ROM 配置去重，空则退回 SKU 名。
  function _labelSuffix(skus) {
    const cfg = [...new Set((skus || []).map(s => [s.ram, s.rom].filter(Boolean).join('/')).filter(Boolean))].join(' ');
    if (cfg) return cfg;
    return (skus || []).map(s => s.name).filter(Boolean).join('/');
  }
  // SKU 售价聚合分框：取各 SKU priceUsd 去重——
  //  · 0 个已设价 → 单框「回退」用 compositeRrpUsd（本币=rrpLocal），名=产品名（现行为，零回归）。
  //  · 恰 1 个不同价 → 单框@该价。
  //  · ≥2 个不同价 → 每价一框（同价 SKU 合并），升序；最低价框=primary（前代接续连它）；标签=产品名+配置。
  //  本币模式(mode='local')：已设价框按 priceUsd×fx 换算；回退框用 productValue(rrpLocal)。返回 box.value 为「当前计价模式」下的绘制值。
  function skuPriceBoxes(p, opts) {
    opts = opts || {}; const mode = opts.mode || 'usd', country = opts.country;
    const skus = (p && p.skus) || [];
    const priced = [];
    skus.forEach(s => { const pr = _num(s.priceUsd); if (pr != null) priced.push({ s: s, price: pr }); });
    const distinct = [...new Set(priced.map(x => x.price))].sort((a, b) => a - b);
    const name = (p && p.name) || '';
    const fx = _productFx(p, country);
    const val = (usd) => (mode === 'local') ? (fx != null ? usd * fx : null) : usd;
    if (distinct.length < 2) {
      if (distinct.length === 1) {
        const price = distinct[0], group = priced.map(x => x.s);
        return [{ price: price, value: val(price), name: name, skus: group, config: _labelSuffix(group), primary: true }];
      }
      const v = productValue(p, mode, country);
      return [{ price: null, value: v, name: name, skus: skus, config: _config(p), primary: true, fallback: true }];
    }
    return distinct.map((price, idx) => {
      const group = priced.filter(x => x.price === price).map(x => x.s);
      const suffix = _labelSuffix(group);
      return { price: price, value: val(price), name: name + (suffix ? ' ' + suffix : ''), skus: group, config: suffix, primary: idx === 0 };
    });
  }
  // 框样式合并：默认(=现观感) → 全局 → 产品覆盖。每字段仅当「已设」(非 undefined/null/空串) 才覆盖，否则回退上层。
  const BOX_STYLE_DEFAULT = { fill: '#FFFFFF', opacity: 1, bold: true, fontSize: 12 };
  function _pick(v, fb) { return (v == null || v === '') ? fb : v; }
  function resolveBoxStyle(global, product) {
    const g = global || {}, p = product || {};
    const fill = _pick(p.fill, _pick(g.fill, BOX_STYLE_DEFAULT.fill));
    const opacity = _pick(p.opacity, _pick(g.opacity, BOX_STYLE_DEFAULT.opacity));
    const bold = (p.bold == null) ? ((g.bold == null) ? BOX_STYLE_DEFAULT.bold : !!g.bold) : !!p.bold;
    const fontSize = _pick(p.fontSize, _pick(g.fontSize, BOX_STYLE_DEFAULT.fontSize));
    return { fill: String(fill), opacity: +opacity, bold: !!bold, fontSize: +fontSize };
  }
  /* ---- FOB→RRP 推算(用户 2026-08-25:Floor FOB=成本,渠长关系 音频×3、平板×2.5≈RRP) ----
     只给「没有任何价」的产品注入(手填综合RRP/SKU价永远优先);返回**渲染副本**,绝不落库。
     匹配:产品的 psiLink/internalCode/name 归一化后与 FOB 型号名互含(候选长度≥3 防误配);
     FOB 值 = 每个命中型号取最新有数月,再对命中型号求均值(对应"综合"口径)。 */
  function _fobNorm(x) { return String(x == null ? '' : x).trim().toLowerCase().replace(/\s+/g, '').replace(/[-_/()（）]/g, ''); }
  function fobEstimate(products, fob, opt) {
    opt = opt || {};
    const multTablet = +opt.multTablet > 0 ? +opt.multTablet : 2.5;
    const multAudio = +opt.multAudio > 0 ? +opt.multAudio : 3;
    const out = { list: products || [], estIds: new Set(), count: 0 };
    if (!fob || !fob.cells || !fob.months || !fob.months.length) return out;
    const keys = Object.keys(fob.names || {});
    if (!keys.length) return out;
    const monthsDesc = fob.months.slice().sort((a, b) => b - a);
    const latestOf = k => {
      for (const m of monthsDesc) { const v = fob.cells[k + '|' + m]; if (v != null) return v; }
      return null;
    };
    const normed = keys.map(k => ({ k, n: _fobNorm(fob.names[k] || k) })).filter(x => x.n);
    out.list = (products || []).map(p => {
      const hasPrice = (p.compositeRrpUsd != null && !isNaN(p.compositeRrpUsd))
        || ((p.skus || []).some(s => s && s.priceUsd != null && s.priceUsd !== '' && !isNaN(+s.priceUsd)));
      if (hasPrice) return p;
      const cands = [p.psiLink, p.internalCode, p.name].map(_fobNorm).filter(c => c.length >= 3);
      if (!cands.length) return p;
      const vals = [];
      normed.forEach(x => {
        if (cands.some(c => x.n === c || x.n.indexOf(c) >= 0 || c.indexOf(x.n) >= 0)) {
          const v = latestOf(x.k);
          if (v != null) vals.push(v);
        }
      });
      if (!vals.length) return p;
      const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
      const mult = /音频|耳机|audio|buds/i.test(String(p.category || '')) ? multAudio : multTablet;
      out.estIds.add(p.id);
      out.count++;
      return Object.assign({}, p, { compositeRrpUsd: Math.round(avg * mult), _fobEst: true });
    });
    return out;
  }

  function productPoints(products, opts) {
    opts = opts || {}; const mode = opts.mode || 'usd';
    const list = (products || []);
    const ts = timeScale(list, opts.extraTimes, opts.timeRange);
    const EPS = 1e-9;
    const entries = list.map(p => {
      const n = ymNum(p.shipLate);
      const out = ts.active && n != null && (n < ts.minN - EPS || n > ts.maxN + EPS);
      return { p: p, out: out, boxes: skuPriceBoxes(p, { mode: mode, country: opts.country }) };
    });
    const vals = [];
    entries.forEach(e => { if (e.out) return; e.boxes.forEach(b => { if (b.value != null) vals.push(b.value); }); });
    // 自动量程只看产品价(2026-09-01)：系列色带 from/to 曾一并参与，一条 0~2000 的色带就把所有产品挤成一条线；色带越界部分由 seriesBands 裁到轴内
    const ps = priceScale(vals, opts.manualRange);
    const points = [];
    entries.forEach(e => {
      if (e.out) return;
      const p = e.p, multi = e.boxes.length > 1, style = resolveBoxStyle(opts.boxStyle, p.boxStyle);
      e.boxes.forEach((b, bi) => {
        const v = b.value, missing = (v == null);
        points.push({ id: multi ? (p.id + '@' + bi) : p.id, realId: p.realId || p.id, productId: p.id,
          name: b.name || '', series: p.seriesGroup || '', dots: (b.skus || []).map(s => s.color).filter(Boolean),
          config: b.config || '', shipLate: p.shipLate || '', value: v, priceUsd: b.price,
          x: ts.x(p.shipLate), y: missing ? null : ps.y(v), missing: missing,
          primary: !!b.primary, predecessorId: p.predecessorId || '', outOfRange: false, style: style });
      });
    });
    return { points, tScale: ts, pScale: ps, hidden: entries.filter(e => e.out).length };
  }
  function samplePoints(samples, products, opts) {
    opts = opts || {}; const mode = opts.mode || 'usd'; const ts = opts.tScale, ps = opts.pScale;
    const byId = {}; (products || []).forEach(p => { byId[p.id] = p; });
    return (samples || []).map(s => {
      const prod = byId[s.productId];
      const value = prod ? productValue(prod, mode, opts.country) : null;
      const missing = (value == null);
      return { id: s.id, name: s.name || '', type: s.type || '', code: s.code || '', productId: s.productId,
        x: ts ? ts.x(s.shipLate) : 0.5, y: missing ? null : ps.y(value), value: value, missing: missing, shipLate: s.shipLate || '' };
    });
  }
  function _clamp01(v) { return v < 0 ? 0 : (v > 1 ? 1 : v); }
  function seriesBands(points, seriesColors, pScale) {
    seriesColors = seriesColors || {};
    const groups = {};
    (points || []).forEach(p => { if (p.missing || p.y == null) return; (groups[p.series] = groups[p.series] || []).push(p); });
    return Object.keys(groups).map(s => {
      const ps = groups[s]; const ys = ps.map(p => p.y);
      const sc = seriesColors[s] || {};
      const from = parseFloat(sc.from), to = parseFloat(sc.to);
      let minY, maxY;
      if (pScale && !isNaN(from) && !isNaN(to) && from !== to) { minY = _clamp01(pScale.y(Math.max(from, to))); maxY = _clamp01(pScale.y(Math.min(from, to))); }
      else { minY = Math.min(...ys); maxY = Math.max(...ys); }
      return { series: s, minY: minY, maxY: maxY, color: sc.color || '#1E9E57', opacity: sc.opacity == null ? 0.18 : sc.opacity, mode: 'fill' };
    });
  }
  // 接续线：按产品维度连「主框」（多框产品=最低价框 primary）。予以兼容旧单框（primary 恒 true、productId=id）。
  // fromId/toId=真实产品 id（realId），供 hover 接续链高亮定位，旧 from/to 结构不变。
  function successionLinks(points) {
    const byProd = {}; (points || []).forEach(p => { if (p.primary) byProd[p.productId != null ? p.productId : p.id] = p; });
    const out = [];
    (points || []).forEach(p => {
      if (!p.primary || !p.predecessorId || p.missing) return;
      const pre = byProd[p.predecessorId]; if (pre && !pre.missing) out.push({ from: { x: pre.x, y: pre.y }, to: { x: p.x, y: p.y }, fromId: pre.realId != null ? pre.realId : pre.id, toId: p.realId != null ? p.realId : p.id });
    });
    return out;
  }
  // 正交折线布线：把斜的接续线改成「水平段 + 直角竖段(+水平段)」的甘特式折线。单位无关（屏幕像素/PPT英寸皆可）。
  //  · 近水平（y 相同）→ 单段水平线；否则 H-V-H 三段（零长段丢弃）。
  //  · 竖线车道默认取两端中点，夹取到 [minX+pad, maxX+…−pad]（左右留空挡）；
  //  · 防撞：与已布竖线 x 间距 < gap 且竖向区间重叠 → 依次尝试 ±gap、±2gap… 错开；范围内无空位则在范围内取「离已有竖线最远」的位置（宁可挤一点不越界）。
  //  返回与输入等长数组：{ segs:[{x1,y1,x2,y2}…], vx:竖线x|null }。
  function orthoRoute(lines, opts) {
    opts = opts || {};
    const gap = opts.gap == null ? 14 : +opts.gap;
    const pad = opts.pad == null ? 10 : +opts.pad;
    const eps = 1e-9;
    const lanes = [];   // 已布竖线：{x, y0, y1}
    const ovl = (a0, a1, b0, b1) => Math.max(a0, b0) <= Math.min(a1, b1) + eps;
    return (lines || []).map(l => {
      const x1 = +l.x1, y1 = +l.y1, x2 = +l.x2, y2 = +l.y2;
      if (Math.abs(y2 - y1) < eps) return { segs: [{ x1: x1, y1: y1, x2: x2, y2: y1 }], vx: null };
      const lo = Math.min(x1, x2), hi = Math.max(x1, x2);
      let min = lo + pad, max = hi - pad;
      if (min > max) { min = max = (lo + hi) / 2; }
      const yTop = Math.min(y1, y2), yBot = Math.max(y1, y2);
      const clash = (x) => lanes.some(ln => Math.abs(ln.x - x) < gap - eps && ovl(ln.y0, ln.y1, yTop, yBot));
      let vx = Math.min(Math.max((x1 + x2) / 2, min), max);
      if (clash(vx)) {
        let found = null;
        for (let k = 1; k <= 40 && found == null; k++) {
          for (const s of [1, -1]) { const c = vx + s * k * gap; if (c >= min - eps && c <= max + eps && !clash(c)) { found = c; break; } }
        }
        if (found == null && max > min) {   // 范围内无 gap 级空位：取离所有已有竖线最远的位置
          let best = vx, bestD = -1;
          const N = 24;
          for (let i = 0; i <= N; i++) {
            const c = min + (i / N) * (max - min);
            const d = lanes.reduce((m, ln) => (ovl(ln.y0, ln.y1, yTop, yBot) ? Math.min(m, Math.abs(ln.x - c)) : m), Infinity);
            if (d > bestD) { bestD = d; best = c; }
          }
          found = best;
        }
        if (found != null) vx = found;
      }
      lanes.push({ x: vx, y0: yTop, y1: yBot });
      const segs = [];
      if (Math.abs(vx - x1) > eps) segs.push({ x1: x1, y1: y1, x2: vx, y2: y1 });
      segs.push({ x1: vx, y1: y1, x2: vx, y2: y2 });
      if (Math.abs(x2 - vx) > eps) segs.push({ x1: vx, y1: y2, x2: x2, y2: y2 });
      return { segs: segs, vx: vx };
    });
  }
  // 接续链：沿 predecessorId 关系（无向）取产品所在整条前代+后代链（含分叉的连通分量），返回产品 id 数组（含自身）。
  //  productId 不存在 → []。hover 高亮用：链上高亮、链外变灰。
  function successionChain(products, productId) {
    const ps = products || [];
    const byId = {}; ps.forEach(p => { if (p && p.id != null) byId[p.id] = p; });
    if (productId == null || byId[productId] == null) return [];
    const adj = {};
    const add = (a, b) => { (adj[a] = adj[a] || []).push(b); (adj[b] = adj[b] || []).push(a); };
    ps.forEach(p => { if (p && p.predecessorId && byId[p.predecessorId]) add(p.id, p.predecessorId); });
    const seen = {}; seen[productId] = 1;
    const stack = [productId], out = [];
    while (stack.length) { const id = stack.pop(); out.push(id); (adj[id] || []).forEach(n => { if (!seen[n]) { seen[n] = 1; stack.push(n); } }); }
    return out;
  }
  function explodeBySku(products) {
    const out = [];
    (products || []).forEach(p => { const sk = p.skus || []; if (!sk.length) { out.push(Object.assign({}, p, { realId: p.id })); return; }
      sk.forEach((s, i) => out.push(Object.assign({}, p, { id: p.id + '#' + i, realId: p.id, name: (p.name || '') + '·' + (s.name || ('SKU' + (i + 1))), skus: [s] }))); });
    return out;
  }
  function filterByYear(products, year) { if (!year) return (products || []).slice(); return (products || []).filter(p => { const m = String(p.shipLate || '').match(/^(\d{4})/); return m && m[1] === String(year); }); }
  function pptxRoadmap(products, opts, geom) {
    opts = opts || {}; geom = geom || {};
    const W = geom.W != null ? geom.W : 13.333, H = geom.H != null ? geom.H : 7.5;
    const padL = geom.padL != null ? geom.padL : 1.0, padR = geom.padR != null ? geom.padR : 0.4;
    const padT = geom.padT != null ? geom.padT : 1.0, padB = geom.padB != null ? geom.padB : 0.7;
    const out = productPoints(products, { mode: opts.mode, country: opts.country, manualRange: opts.manualRange, seriesRanges: opts.seriesRanges, extraTimes: (opts.samples || []).map(s => s.shipLate), timeRange: opts.timeRange, boxStyle: opts.boxStyle });
    const bands0 = seriesBands(out.points, opts.seriesColors || {}, out.pScale);
    const links0 = successionLinks(out.points);
    const px = (x) => padL + x * (W - padL - padR);
    const py = (y) => padT + y * (H - padT - padB);
    const hex = (c) => String(c == null ? '' : c).replace('#', '') || 'CCCCCC';
    const bands = bands0.map(b => { const top = py(Math.min(b.minY, b.maxY)), bot = py(Math.max(b.minY, b.maxY)); return { x: padL, y: top, w: W - padL - padR, h: Math.max(0.05, bot - top), color: hex(b.color), opacity: b.opacity == null ? 0.18 : b.opacity, series: b.series }; });
    const BW = 1.7, BH = 0.6;
    // px 字号 → pt（96dpi→72pt，×0.75）：默认 12px→9pt(名) / 10px→7pt(元)，与旧版所见即所得一致。
    const namePt = (fs) => Math.max(6, Math.round((+fs || 12) * 0.75));
    const boxes = out.points.map(p => { const cx = px(p.x), cy = p.missing ? py(0.5) : py(p.y); const st = p.style || resolveBoxStyle(opts.boxStyle, null); const np = namePt(st.fontSize);
      return { x: Math.max(0, Math.min(W - BW, cx - BW / 2)), y: Math.max(0, Math.min(H - BH, cy - BH / 2)), w: BW, h: BH, name: p.name || '', meta: (p.missing ? '无本币价' : (opts.mode === 'usd' ? '$' + Math.round(p.value) : Math.round(p.value))) + ' · ' + (p.shipLate || ''), dots: (p.dots || []).slice(0, 6).map(hex), missing: !!p.missing,
        fillHex: hex(st.fill), opacity: st.opacity, bold: !!st.bold, namePt: np, metaPt: Math.max(6, np - 2) }; });
    const sampleStyle = opts.sampleStyle || { color: '#E0A400', opacity: 0.85 };
    const sampHex = String(sampleStyle.color || '#E0A400').replace('#', '') || 'E0A400';
    const sboxes = samplePoints(opts.samples || [], products, { mode: opts.mode, country: opts.country, tScale: out.tScale, pScale: out.pScale }).map(s => {
      const cx = px(s.x), cy = s.missing ? py(0.5) : py(s.y);
      return { x: Math.max(0, Math.min(W - BW, cx - BW / 2)), y: Math.max(0, Math.min(H - BH, cy - BH / 2)), w: BW, h: BH,
        name: s.name || '', meta: (s.type || '') + ' · ' + (s.code || '') + ' · ' + (s.shipLate || ''), dots: [], missing: !!s.missing, sample: true, fill: sampHex, opacity: sampleStyle.opacity == null ? 0.85 : sampleStyle.opacity, bold: true, namePt: 9, metaPt: 7 };
    });
    boxes.push.apply(boxes, sboxes);
    // 接续线正交布线（与屏幕一致）：每链拆成水平/竖直段，仅末段带箭头；gap/pad 单位=英寸
    const routed = orthoRoute(links0.map(l => ({ x1: px(l.from.x), y1: py(l.from.y), x2: px(l.to.x), y2: py(l.to.y) })), { gap: geom.lineGap != null ? geom.lineGap : 0.12, pad: geom.linePad != null ? geom.linePad : 0.08 });
    const lines = [];
    routed.forEach(r => r.segs.forEach((s, i) => lines.push({ x1: s.x1, y1: s.y1, x2: s.x2, y2: s.y2, arrow: i === r.segs.length - 1 })));
    const yTicks = []; for (let i = 0; i <= 4; i++) { const v = out.pScale.max - (i / 4) * (out.pScale.max - out.pScale.min); yTicks.push({ y: py(i / 4), label: Math.round(v) }); }
    const vd = (products || []).map(p => p.shipLate).filter(d => ymNum(d) != null).sort((a, b) => ymNum(a) - ymNum(b));
    return { bands, boxes, lines, yTicks, xLabels: { minD: vd[0] || '', maxD: vd[vd.length - 1] || '' }, geom: { W, H, padL, padR, padT, padB } };
  }
  return { fobEstimate, _fobNorm, ymNum, timeScale, priceScale, productValue, productPoints, samplePoints, seriesBands, successionLinks, orthoRoute, successionChain, explodeBySku, filterByYear, pptxRoadmap, skuPriceBoxes, resolveBoxStyle };
});

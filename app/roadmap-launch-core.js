(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.RoadmapLaunch = api;
})(this, function () {
  const ACCENT = '#C7000B';
  const DAY = 86400000;

  // 'YYYY/M/D'→天序数；'YYYY/M'→当月 15 日；非法→null
  function dNum(s) {
    if (!s) return null;
    const m = String(s).match(/^(\d{4})[\/\-.](\d{1,2})(?:[\/\-.](\d{1,2}))?$/);
    if (!m) return null;
    const y = +m[1], mo = +m[2], d = m[3] != null ? +m[3] : 15;
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
    return Math.round(Date.UTC(y, mo - 1, d) / DAY);
  }
  function _parse(s) { const m = String(s || '').match(/^(\d{4})[\/\-.](\d{1,2})(?:[\/\-.](\d{1,2}))?$/); return m ? { y: +m[1], mo: +m[2], d: m[3] != null ? +m[3] : null } : null; }

  // 按 dispStyle 格式化；有 dateEnd 输出区间。整月(无日)按 style 收敛
  function fmtDisp(date, dateEnd, style) {
    const p = _parse(date); if (!p) return '';
    const one = (pp) => {
      if (pp.d == null) return style === 'YYYY/M/D' ? (pp.y + '/' + pp.mo) : (style === 'M月D日' ? (pp.mo + '月') : (pp.mo + '.15'));
      if (style === 'M月D日') return pp.mo + '月' + pp.d + '日';
      if (style === 'YYYY/M/D') return pp.y + '/' + pp.mo + '/' + pp.d;
      return pp.mo + '.' + pp.d; // 'M.D' 默认
    };
    const a = one(p);
    const pe = _parse(dateEnd);
    return pe ? (a + '-' + one(pe)) : a;
  }

  // 预置词库（5 分类）
  function presetNodeLib() {
    const g = (cat, arr) => arr.map(label => ({ label, cat, color: '' }));
    return [].concat(
      g('研发认证', ['动能研讨', 'TR4', 'TR4A', 'TR5', 'TR6', '认证完成']),
      g('样机物料', ['VN1样机入库', 'VN2样机入库', '物料到位', '物料预热种草']),
      g('供应发货', ['新品定价', '大货发货', '首批发货', '首批到货', '各国铺货完成', '渠道预沟通']),
      g('销售节点', ['预售开启', '线上首销', '线下首销', '全渠道首销', '首销结束']),
      g('MKT大促', ['全球发布会', '本地发布会', '评测出街', 'PR投放预热', 'KOL评测', '情人节活动', '母亲节HotSale', '黑五圣诞', '返校季', '三王节', '智利Cyber'])
    );
  }

  function _clamp01(v) { return v < 0 ? 0 : (v > 1 ? 1 : v); }
  // 把左上角坐标 clamp 进页面（保证 0<=v 且 v<=maxLeft，从而 x+w<=W）
  function _clampLeft(v, maxLeft) { return v < 0 ? 0 : (v > maxLeft ? maxLeft : v); }

  // 时间轴布局：x∈0..1 线性，tier 两层防重叠
  function timelineLayout(milestones, opts) {
    opts = opts || {}; const minGap = opts.minGap != null ? opts.minGap : 0.06;
    const list = (milestones || []).filter(m => dNum(m.date) != null);
    const ns = list.map(m => dNum(m.date));
    (list.forEach(m => { const e = dNum(m.dateEnd); if (e != null) ns.push(e); }));
    const t0 = ns.length ? Math.min(...ns) : 0, t1 = ns.length ? Math.max(...ns) : 0;
    const span = t1 - t0;
    const xOf = (n) => (n == null || span === 0) ? 0.5 : (n - t0) / span;
    const pts = list.map(m => {
      const n = dNum(m.date), e = dNum(m.dateEnd);
      return { id: m.id, label: m.label || '', disp: m.disp || '', x: xOf(n), xEnd: e != null ? xOf(e) : null, tier: 0, color: m.color || '' };
    }).sort((a, b) => a.x - b.x);
    // 贪心分层：与同层前一个太近则换层（0/1 循环）
    let lastX = [-Infinity, -Infinity];
    pts.forEach(p => {
      let tier = 0;
      if (p.x - lastX[0] < minGap) tier = (p.x - lastX[1] < minGap) ? 0 : 1;
      p.tier = tier; lastX[tier] = p.x;
    });
    return { pts, t0, t1 };
  }

  // 泳道色块布局（clamp 0..1）
  function phaseLayout(phases, t0, t1) {
    const span = (t1 - t0) || 1;
    return (phases || []).map(ph => {
      let a = (dNum(ph.from) - t0) / span, b = (dNum(ph.to) - t0) / span;
      if (isNaN(a)) a = 0; if (isNaN(b)) b = 1;
      a = _clamp01(a); b = _clamp01(b); if (b < a) { const t = a; a = b; b = t; }
      return { x: a, w: b - a, text: ph.text || '', color: ph.color || '' };
    });
  }

  // 纵轴缩放：0 在底，纵向留白 8%（y(max) 近顶、y(0) 近底）
  function curveScale(seriesValues, opts) {
    opts = opts || {}; const pad = opts.pad != null ? opts.pad : 0.08;
    const all = [];
    (seriesValues || []).forEach(s => (s || []).forEach(v => { const n = +v; if (!isNaN(n)) all.push(n); }));
    const max = all.length ? Math.max(...all, 0) : 0;
    const y = (v) => { const n = +v; if (isNaN(n) || max <= 0) return 1 - pad; return (1 - pad) - (n / max) * (1 - 2 * pad); };
    return { max, y };
  }

  // 各模板 inch 坐标布局；颜色输出无 #
  function pptxLaunch(launch, product, geom) {
    launch = launch || {}; product = product || {}; geom = geom || {};
    const W = geom.W != null ? geom.W : 13.333, H = geom.H != null ? geom.H : 7.5;
    const tpl = launch.template || 'A';
    const dense = (tpl === 'B'); // 密集轴用更小字号
    const hex = (c) => String(c == null ? '' : c).replace('#', '') || '';
    const accentHex = hex(launch.accentColor || ACCENT) || 'C7000B';
    const dispStyle = launch.dispStyle || 'M.D';
    const ms = (launch.milestones || []).filter(m => dNum(m.date) != null);

    // 轴基准 y：A/B≈2.6；C 上移到 2.0；E 下移到图表之下
    let axisY = 2.6;
    const padL = 0.9, padR = 0.6;
    const axX1 = padL, axX2 = W - padR, axW = axX2 - axX1;

    // 图表（E）占位 —— 先算好，轴随之下移
    let chart = null;
    if (tpl === 'C') axisY = 2.0;
    if (tpl === 'E') {
      chart = { x: padL, y: 1.1, w: axW, h: 3.6 };
      axisY = chart.y + chart.h + 0.5; // 轴落在图表下方
    }

    const tl = timelineLayout(ms, {});
    const px = (x) => axX1 + _clamp01(x) * axW;

    // 三角/标签/日期：label 在轴上、date 在轴下，tier 交错让密集节点上下错开
    const TRI = 0.16;
    const lblFont = dense ? 11 : 14, dateFont = dense ? 10 : 12;
    const lblH = 0.32, dateH = 0.3, colW = dense ? 1.2 : 1.6;
    const tris = [], labels = [], dates = [];
    tl.pts.forEach(p => {
      const cx = px(p.x);
      const tierOff = (p.tier || 0) * (dense ? 0.34 : 0.42);
      tris.push({ x: _clampLeft(cx - TRI / 2, W - TRI), y: axisY - TRI / 2, w: TRI, h: TRI });
      // 名称在轴上方（tier 越高越往上）
      const ly = axisY - lblH - 0.14 - tierOff;
      labels.push({ text: p.label, x: _clampLeft(cx - colW / 2, W - colW), y: Math.max(0, ly), w: colW, h: lblH, bold: true, fontSize: lblFont, align: 'center' });
      // 日期在轴下方
      const dy = axisY + 0.14 + tierOff;
      const dm = ms.find(m => m.id === p.id) || {};
      const dtext = p.disp || fmtDisp(dm.date, dm.dateEnd, dispStyle);
      dates.push({ text: dtext, x: _clampLeft(cx - colW / 2, W - colW), y: Math.min(H - dateH, dy), w: colW, h: dateH, bold: false, fontSize: dateFont, align: 'center' });
    });

    const titleText = String(launch.title || '').trim() || ((product.name || '产品') + ' 上市节奏');
    const out = {
      accent: accentHex,
      title: { text: titleText, x: padL, y: 0.35, w: W - padL - padR, h: 0.7 },
      axis: { x1: axX1, y1: axisY, x2: axX2, y2: axisY },
      tris, labels, dates, noteTexts: []
    };

    // C：国家表（表头行 + 国家行，仅勾选列）
    if (tpl === 'C') {
      const COLDEF = { presale: '预售时间', online: '线上首销', offline: '线下首销', end: '首销结束', targetOn: '线上目标', targetOff: '线下目标', target: '整体首销目标', yoy: '同比上代' };
      const cols = (launch.countryCols || []).filter(c => COLDEF[c]);
      const header = ['国家'].concat(cols.map(c => COLDEF[c]));
      const rows = (launch.countryRows || []).map(r => [r.country || ''].concat(cols.map(c => r[c] == null ? '' : String(r[c]))));
      const rowsAoa = [header].concat(rows);
      const tW = W - padL - padR, ty = axisY + 0.9;
      const colW2 = new Array(header.length).fill(tW / header.length);
      out.table = { x: padL, y: Math.min(ty, H - 0.5), w: tW, rowsAoa, colW: colW2 };
    }

    // D：泳道 + 策略红框（轴下方）
    if (tpl === 'D') {
      const laneY = axisY + 0.55, laneH = 0.5;
      const phL = phaseLayout(launch.phases, tl.t0, tl.t1);
      out.phaseRects = phL.map(ph => ({ x: px(ph.x), y: laneY, w: Math.max(0.1, ph.w * axW), h: laneH, text: ph.text, color: hex(ph.color || '#E8E8E8') || 'E8E8E8' }));
      const sbL = phaseLayout(launch.strategyBoxes, tl.t0, tl.t1);
      out.strategyRects = sbL.map(sb => ({ x: px(sb.x), y: laneY + laneH + 0.15, w: Math.max(0.1, sb.w * axW), h: 0.42, text: sb.text, color: accentHex }));
    }

    // E：图表占位 + 大促底色块（叠在图表区）+ 策略框
    if (tpl === 'E') {
      out.chart = chart;
      const cv = launch.curve || {}; const t0e = dNum(cv.startDate);
      const bandsSpan = (function () {
        // band 用图表内相对位置：以 curve.startDate 为 0，按周估算总跨度
        const ns = []; (cv.bands || []).forEach(b => { const a = dNum(b.from), z = dNum(b.to); if (a != null) ns.push(a); if (z != null) ns.push(z); });
        if (t0e != null) ns.push(t0e);
        const lo = ns.length ? Math.min(...ns) : 0, hi = ns.length ? Math.max(...ns) : 1;
        return { lo, hi, span: (hi - lo) || 1 };
      })();
      out.bandRects = (cv.bands || []).map(b => {
        let a = (dNum(b.from) - bandsSpan.lo) / bandsSpan.span, z = (dNum(b.to) - bandsSpan.lo) / bandsSpan.span;
        if (isNaN(a)) a = 0; if (isNaN(z)) z = 1; a = _clamp01(a); z = _clamp01(z);
        const bx = chart.x + a * chart.w, bw = Math.max(0.08, (z - a) * chart.w);
        return { x: bx, y: chart.y, w: Math.min(bw, chart.x + chart.w - bx), h: chart.h, text: b.text || '', color: hex(b.color || '#FFECEC') || 'FFECEC' };
      });
      const sbL = phaseLayout(launch.strategyBoxes, tl.t0, tl.t1);
      out.strategyRects = sbL.map(sb => ({ x: px(sb.x), y: Math.min(H - 0.5, axisY + 0.55), w: Math.max(0.1, sb.w * axW), h: 0.42, text: sb.text, color: accentHex }));
    }

    return out;

    // 局部工具：把左上角坐标 clamp 进页面（保证 x+w<=W）
    function _clampLeft(v, maxLeft) { return v < 0 ? 0 : (v > maxLeft ? maxLeft : v); }
  }

  return { dNum, fmtDisp, presetNodeLib, timelineLayout, phaseLayout, curveScale, pptxLaunch };
});

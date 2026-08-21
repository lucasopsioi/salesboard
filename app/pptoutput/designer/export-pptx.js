(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.PptExport = api;
})(this, function () {
  const PptNumFmt = (typeof module !== 'undefined' && module.exports) ? require('./numfmt.js')
    : (typeof window !== 'undefined' ? window.PptNumFmt : null);
  function fmtVal(v) { if (v == null || isNaN(v)) return '0'; const a = Math.abs(v); if (a >= 1e8) return (v / 1e8).toFixed(2) + '亿'; if (a >= 1e4) return (v / 1e4).toFixed(1) + '万'; return Math.round(v).toLocaleString('en-US'); }
  // 单位缩放系数：none/auto→1, k/K→1e3, w/W→1e4, m/Million→1e6
  function unitScale(unit) {
    switch (unit) {
      case 'k': case 'K': return 1e3;
      case 'w': case 'W': return 1e4;
      case 'm': case 'Million': return 1e6;
      default: return 1; // none/auto/未知
    }
  }
  // 9 位图例 → pptxgenjs 4 向：t*→'t', b*→'b', lc→'l', rc→'r', none→null
  function pptLegendPos(pos) {
    if (!pos || pos === 'none') return null;
    const p = String(pos);
    if (p[0] === 't') return 't';
    if (p[0] === 'b') return 'b';
    if (p === 'lc' || p[0] === 'l') return 'l';
    if (p === 'rc' || p[0] === 'r') return 'r';
    return null;
  }
  const DEFAULT_COLORS = ['4472C4','ED7D31','A5A5A5','FFC000','5B9BD5','70AD47','264478','9E480E','636363','997300'];
  function fmtCodeByDecimals(d) { const n = Math.max(0, +d || 0); return n === 0 ? '#,##0' : '#,##0.' + '0'.repeat(n); }
  function addText(s, el) {
    const st = el.style || {};
    // inset:0 —— pptxgenjs 默认给形状留 0.05in 内衬，预览 div 没有，同宽的框折行位置就会不一样（用户反映「导出比例和预览不一致」）。
    // wrap:false —— 「不自动换行」选项：PPT 侧 bodyPr wrap="none"，文字超出框宽也不折行，与预览 white-space:nowrap 一致。
    s.addText(String(el.text == null ? '' : el.text), {
      x: el.x, y: el.y, w: el.w, h: el.h, inset: 0, wrap: !st.nowrap,
      fontFace: st.fontFace || '微软雅黑', fontSize: st.fontSize || 14, bold: !!st.bold,
      color: st.color || '1A1A1A', align: st.align || 'left', valign: st.valign || 'middle',
      fill: st.fill ? { color: st.fill } : undefined,
    });
  }
  function addData(s, el, r) {
    const st = el.style || {};
    // compare/同比：resolved 含预格式化文本(如 '-40.0%')→直接用，不再走 formatNum(value)；否则单值路径 formatNum，无则 '—'
    const txt = (r && r.compare && r.text != null) ? r.text
      : ((r && r.kind === 'value') ? PptNumFmt.formatNum(r.value, st.unit || 'auto', st.decimals) : '—');
    s.addText(txt, { x: el.x, y: el.y, w: el.w, h: el.h, inset: 0, wrap: !st.nowrap, fontFace: st.fontFace || '微软雅黑', fontSize: st.fontSize || 28, bold: st.bold !== false, color: st.color || '1A1A1A', align: st.align || 'center', valign: 'middle' });
  }
  function addTable(s, el, r) {
    // WK6: grid 数据源(report/siso/roadmap)——单元格已是预格式化字符串。header 灰底加粗,body 纯文本。
    if (r && r.kind === 'grid') {
      const header = (r.header || []).map(h => ({ text: String(h == null ? '' : h), options: { bold: true, fill: { color: 'F2F3F5' } } }));
      const rows = [header.length ? header : [{ text: '', options: { bold: true, fill: { color: 'F2F3F5' } } }]];
      (r.rows || []).forEach(row => rows.push((row || []).map(c => ({ text: String(c == null ? '' : c) }))));
      if (rows.length === 1) rows.push([{ text: '(空)' }]);
      s.addTable(rows, { x: el.x, y: el.y, w: el.w, fontFace: '微软雅黑', fontSize: 8, border: { type: 'solid', color: 'E6E8EB', pt: 0.5 }, valign: 'middle', autoPage: false });
      return;
    }
    const cats = (r && r.cats) || [], series = (r && r.series) || [];
    const head = [{ text: '', options: { bold: true, fill: { color: 'F2F3F5' } } }].concat(series.map(se => ({ text: se.name, options: { bold: true, fill: { color: 'F2F3F5' } } })));
    const rows = [head];
    cats.forEach((c, ci) => rows.push([{ text: String(c) }].concat(series.map(se => ({ text: String(Math.round(se.values[ci] || 0)) })))));
    if (rows.length === 1) rows.push([{ text: '(空)' }]);
    s.addTable(rows, { x: el.x, y: el.y, w: el.w, fontFace: '微软雅黑', fontSize: 9, border: { type: 'solid', color: 'E6E8EB', pt: 0.5 }, valign: 'middle' });
  }
  const CHART_MAP = {
    column:{type:'bar',barDir:'col',barGrouping:'clustered'},
    stackColumn:{type:'bar',barDir:'col',barGrouping:'stacked'},
    stack100:{type:'bar',barDir:'col',barGrouping:'percentStacked'},
    bar:{type:'bar',barDir:'bar',barGrouping:'clustered'},
    stackBar:{type:'bar',barDir:'bar',barGrouping:'stacked'},
    stack100Bar:{type:'bar',barDir:'bar',barGrouping:'percentStacked'},
    line:{type:'line'}, area:{type:'area',barGrouping:'stacked'},
    combo:{combo:true}, pie:{type:'pie'}, donut:{type:'doughnut'}
    // scatter/bubble 需点数据(x/y, bubble 还需 sizes[]),非 cats×series 矩阵→非原生,走图片兜底(Task5)
  };
  function chartMap(vtype){ return CHART_MAP[vtype] || null; }
  function isNativeChart(vtype){ return !!chartMap(vtype); }
  function chartData(r){ const cats=(r&&r.cats)||[], series=(r&&r.series)||[];
    return series.map(se=>({ name:se.name, labels:cats, values:(se.values||[]).map(v=>+v||0) })); }
  // 是否原生堆积类(stacked/percentStacked bar 或 area)
  function isStackedNative(vtype){ const m=chartMap(vtype); if(!m) return false; return m.barGrouping==='stacked'||m.barGrouping==='percentStacked'||m.type==='area'; }
  // 发出 series 名顺序:堆积原生 + fmt.stackTopFirst 真 → 反转(canonical[0]=预览顶 → pptx 栈顶/末位);否则正序
  function emitSeriesOrder(vtype, fmt, r){
    const names=((r&&r.series)||[]).map(se=>se.name);
    const topFirst=!!(fmt&&fmt.stackTopFirst);
    if(isStackedNative(vtype)&&topFirst) return names.slice().reverse();
    return names;
  }
  function addNativeChart(pptx, s, el, r){
    const m=chartMap(el.chart.vtype); if(!m) return false;
    const fmt=(el.chart&&el.chart.fmt)||{};
    const scale=unitScale(fmt.unit);
    const sv=(v)=>(+v||0)*scale;
    const pos={x:el.x,y:el.y,w:el.w,h:el.h};
    let data=chartData(r).map(se=>Object.assign({}, se, { values: se.values.map(sv) }));
    if(m.combo){
      const series=(r&&r.series)||[], cats=(r&&r.cats)||[];
      const arr=series.map((se,i)=>({ type: i===0?pptx.ChartType.line:pptx.ChartType.bar, data:[{name:se.name,labels:cats,values:(se.values||[]).map(sv)}], options:{} }));
      s.addChart(arr, pos); return true;
    }
    const lp=pptLegendPos(fmt.legendPos);
    let colors=(Array.isArray(fmt.colors)&&fmt.colors.length)?fmt.colors:DEFAULT_COLORS;
    // S3:堆积原生 + stackTopFirst → 反转 series(与预览顶/底一致),颜色按系列名同步反转(每系列保色)
    if(isStackedNative(el.chart.vtype) && fmt.stackTopFirst){
      const n=data.length;
      // 颜色按原始 series 顺序定位:取前 n 个对齐,与 data 一起反转,保持系列↔颜色映射不变
      const aligned=[]; for(let i=0;i<n;i++) aligned.push(colors[i%colors.length]);
      data=data.slice().reverse();
      colors=aligned.slice().reverse();
    }
    const opts=Object.assign({
      showLegend: lp!==null,
      legendPos: lp||'b',
      legendFontSize: fmt.legendFontSize||10,        // 与预览换算基准一致(测量:pptxgenjs 默认亦为 10pt,显式钉死)
      legendFontFace: '微软雅黑',
      chartColors: colors,
      dataLabelFontSize: fmt.labelFontSize||9,
      dataLabelFontFace: '微软雅黑',
      catAxisLabelFontSize: fmt.catFontSize||10,
      catAxisLabelFontFace: '微软雅黑',
      valAxisLabelFontSize: fmt.valFontSize||10,
      valAxisLabelFontFace: '微软雅黑',               // 字体族锁定微软雅黑,与预览一致(原走 Arial/主题字体)
      showValue: !!fmt.showLabels,
      dataLabelFormatCode: fmtCodeByDecimals(fmt.decimals)
    }, pos);
    if(m.barDir) opts.barDir=m.barDir; if(m.barGrouping) opts.barGrouping=m.barGrouping;
    s.addChart(pptx.ChartType[m.type], data, opts); return true;
  }
  async function exportDoc(opts) {
    const PptxGenJS = opts.PptxGenJS, doc = opts.doc, rm = opts.resolvedMap || {};
    const pptx = new PptxGenJS();
    pptx.defineLayout({ name: 'W', width: doc.page.w, height: doc.page.h }); pptx.layout = 'W';
    doc.slides.forEach(sl => {
      const s = pptx.addSlide(); if (sl.bg) s.background = { color: sl.bg };
      (sl.elements || []).slice().sort((a, b) => (a.z || 0) - (b.z || 0)).forEach(el => {
        const r = rm[el.id];
        if (el.type === 'text' || el.type === 'unit') addText(s, el);
        else if (el.type === 'data') addData(s, el, r);
        else if (el.type === 'table' || el.type === 'matrix') addTable(s, el, r);
        else if (el.type === 'shape') s.addShape(pptx.ShapeType.rect, { x: el.x, y: el.y, w: el.w, h: el.h, fill: el.style && el.style.fill ? { color: el.style.fill } : { color: 'FFFFFF' }, line: { color: (el.style && el.style.line) || 'E6E8EB', width: 0.5 } });
        else if (el.type === 'image' && el.src) s.addImage({ data: el.src, x: el.x, y: el.y, w: el.w, h: el.h });
        else if (el.type === 'chart') {
          const vt = el.chart && el.chart.vtype;
          if (vt === 'slicer') { /* 设计期控件,不导出 */ }
          else if (isNativeChart(vt)) addNativeChart(pptx, s, el, r);
          else if (el.chart && el.chart.image) s.addImage({ data: el.chart.image, x: el.x, y: el.y, w: el.w, h: el.h });
          else { s.addShape(pptx.ShapeType.rect, { x: el.x, y: el.y, w: el.w, h: el.h, fill: { color: 'FFFFFF' }, line: { color: 'E6E8EB', width: 0.5 } });
                 s.addText(((el.chart && el.chart.fmt && el.chart.fmt.title) || vt || '图表') + '\n(图表预览)', { x: el.x, y: el.y, w: el.w, h: el.h, fontFace: '微软雅黑', fontSize: 10, align: 'center', valign: 'middle', color: '8A9099' }); }
        }
      });
    });
    return pptx.write('base64');
  }
  return { exportDoc, fmtVal, chartMap, isNativeChart, addNativeChart, pptLegendPos, unitScale, isStackedNative, emitSeriesOrder };
});

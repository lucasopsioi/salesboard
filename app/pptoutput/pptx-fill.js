(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.PptFill = api;
})(this, function () {
  function xmlEsc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  function fillTextRuns(slideXml, edits) {
    edits = edits || [];
    return slideXml.replace(/<p:sp(?:\s[^>]*)?>[\s\S]*?<\/p:sp>/g, seg => {
      const m = seg.match(/<p:cNvPr[^>]*\bname="([^"]*)"/);
      if (!m) return seg;
      const name = m[1];
      const mine = edits.filter(e => e.shapeName === name);
      if (!mine.length) return seg;
      let k = -1;
      return seg.replace(/(<a:t>)([\s\S]*?)(<\/a:t>)/g, (mm, p1, inner, p3) => {
        k++;
        const e = mine.find(x => x.tIndex === k);
        return e ? p1 + xmlEsc(e.text) + p3 : mm;
      });
    });
  }
  function strCacheXml(vals) {
    const pts = vals.map((v, i) => '<c:pt idx="' + i + '"><c:v>' + xmlEsc(v) + '</c:v></c:pt>').join('');
    return '<c:strCache><c:ptCount val="' + vals.length + '"/>' + pts + '</c:strCache>';
  }
  function numCacheXml(vals) {
    const pts = vals.map((v, i) => '<c:pt idx="' + i + '"><c:v>' + (Number(v) || 0) + '</c:v></c:pt>').join('');
    return '<c:numCache><c:formatCode>General</c:formatCode><c:ptCount val="' + vals.length + '"/>' + pts + '</c:numCache>';
  }
  function fillChartXml(chartXml, data) {
    const cats = (data && data.cats) || [];
    const series = (data && data.series) || [];
    // 1) 所有 <c:cat> 的 strCache 换成新类别
    let xml = chartXml.replace(/(<c:cat>[\s\S]*?<c:strRef>[\s\S]*?)<c:strCache>[\s\S]*?<\/c:strCache>/g,
      (m, pre) => pre + strCacheXml(cats));
    // 2) 逐个 <c:ser>：按序写系列名 + 数值；数据不足的系列填空
    let si = 0;
    xml = xml.replace(/<c:ser>[\s\S]*?<\/c:ser>/g, block => {
      const s = series[si] || { name: '', values: cats.map(() => 0) };
      si++;
      // 系列名只在该系列自身的 <c:tx>...</c:tx> 子串内改写，且仅当其含 <c:strCache>。
      // 这样字面量标题(<c:tx><c:v>Name</c:v></c:tx>，无 strCache)或缺 <c:tx> 时不动，
      // 避免懒惰匹配越过 </c:tx> 误伤第一个类别缓存值。
      let b = block.replace(/<c:tx>[\s\S]*?<\/c:tx>/, tx => {
        if (tx.indexOf('<c:strCache>') < 0) return tx;
        return tx.replace(/(<c:strCache>[\s\S]*?<c:pt idx="0"><c:v>)[\s\S]*?(<\/c:v>)/,
          (m, p1, p2) => p1 + xmlEsc(s.name) + p2);
      });
      b = b.replace(/(<c:val>[\s\S]*?<c:numRef>[\s\S]*?)<c:numCache>[\s\S]*?<\/c:numCache>/,
        (m, pre) => pre + numCacheXml(s.values));
      return b;
    });
    return xml;
  }
  function fillEmbeddedXlsx(XLSX, bytes, data) {
    const cats = (data && data.cats) || [];
    const series = (data && data.series) || [];
    const wb = XLSX.read(bytes, { type: 'array' });
    const aoa = [['', ...series.map(s => s.name)]];
    cats.forEach((c, ri) => aoa.push([c, ...series.map(s => Number(s.values[ri]) || 0)]));
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    const name = wb.SheetNames[0] || 'Sheet1';
    wb.Sheets[name] = ws;
    if (!wb.SheetNames.length) wb.SheetNames.push(name);
    return new Uint8Array(XLSX.write(wb, { type: 'array', bookType: 'xlsx' }));
  }
  async function fillDeck(opts) {
    const JSZip = opts.JSZip, XLSX = opts.XLSX, plan = opts.plan || {};
    const zip = await JSZip.loadAsync(opts.templateBytes);
    for (const sl of (plan.slides || [])) {
      if (sl.slideFile && sl.textEdits && zip.file(sl.slideFile)) {
        const xml = await zip.file(sl.slideFile).async('string');
        zip.file(sl.slideFile, fillTextRuns(xml, sl.textEdits));
      }
      for (const ch of (sl.charts || [])) {
        if (ch.chartFile && zip.file(ch.chartFile)) {
          const cx = await zip.file(ch.chartFile).async('string');
          zip.file(ch.chartFile, fillChartXml(cx, ch.data));
        }
        if (ch.embedFile && XLSX && zip.file(ch.embedFile)) {
          const eb = await zip.file(ch.embedFile).async('uint8array');
          zip.file(ch.embedFile, fillEmbeddedXlsx(XLSX, eb, ch.data));
        }
      }
    }
    return zip.generateAsync({ type: 'uint8array' });
  }
  async function extractSlides(opts) {
    const JSZip = opts.JSZip, keep = opts.keepSlideNos || [];
    const zip = await JSZip.loadAsync(opts.bytes);
    const relsPath = 'ppt/_rels/presentation.xml.rels';
    const presPath = 'ppt/presentation.xml';
    let rels = await zip.file(relsPath).async('string');
    let pres = await zip.file(presPath).async('string');
    // slideNo -> rId（来自 presentation rels）
    const slideToRid = {};
    rels.replace(/<Relationship\b[^>]*Id="([^"]+)"[^>]*Target="slides\/slide(\d+)\.xml"[^>]*\/?>/g,
      (m, rid, n) => { slideToRid[+n] = rid; return m; });
    const keepRids = new Set(keep.map(n => slideToRid[n]).filter(Boolean));
    const allSlideRids = new Set(Object.values(slideToRid));
    // 1) sldIdLst：删掉未保留页的 <p:sldId>
    pres = pres.replace(/<p:sldId\b[^>]*r:id="([^"]+)"[^>]*\/>/g,
      (m, rid) => (allSlideRids.has(rid) && !keepRids.has(rid)) ? '' : m);
    zip.file(presPath, pres);
    // 2) presentation rels：删掉未保留页的 slide Relationship
    rels = rels.replace(/<Relationship\b[^>]*Target="slides\/slide(\d+)\.xml"[^>]*\/?>/g,
      (m, n) => keep.indexOf(+n) >= 0 ? m : '');
    zip.file(relsPath, rels);
    // 3) 删除未保留页的 slide xml + 其 rels
    Object.keys(slideToRid).forEach(nStr => {
      const n = +nStr;
      if (keep.indexOf(n) < 0) {
        zip.remove('ppt/slides/slide' + n + '.xml');
        zip.remove('ppt/slides/_rels/slide' + n + '.xml.rels');
      }
    });
    return zip.generateAsync({ type: 'uint8array' });
  }
  return { xmlEsc, fillTextRuns, strCacheXml, numCacheXml, fillChartXml, fillEmbeddedXlsx, fillDeck, extractSlides };
});

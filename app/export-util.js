(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.ExportUtil = api;
})(this, function () {
  function ymd() { const d = new Date(); const p = n => String(n).padStart(2, '0'); return '' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()); }
  function safe(name) { return String(name == null ? '' : name).replace(/[\\/:*?"<>|]/g, '_'); }
  // 导出版本水印：Salesboard vN · 构建时间 · 导出时间。版本经启动时缓存的 window.__appVer。
  function nowStr() { const d = new Date(); const p = n => String(n).padStart(2, '0'); return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()); }
  function verStamp() {
    const v = (typeof window !== 'undefined' && window.__appVer) || null;
    const ver = (v && v.version != null) ? ('v' + v.version) : '开发版';
    const built = (v && v.builtAt) ? (' · ' + v.builtAt) : '';
    return 'Salesboard ' + ver + built + ' · 导出 ' + nowStr();
  }
  function _toast(msg) {
    try {
      if (typeof document === 'undefined' || !document.body) return;
      const t = document.createElement('div');
      t.textContent = msg;
      t.style.cssText = 'position:fixed;bottom:26px;left:50%;transform:translateX(-50%);z-index:1200;background:#1E7A45;color:#fff;padding:9px 18px;border-radius:9px;font:13px sans-serif;box-shadow:0 8px 28px rgba(0,0,0,.18)';
      document.body.appendChild(t);
      setTimeout(() => { try { t.remove(); } catch (_) {} }, 1800);
    } catch (_) {}
  }
  function _saveFile(filename, b64, ext) {
    const g = (typeof window !== 'undefined') ? window.sb : null;
    if (!g || !g.saveFile) { try { alert('导出失败：保存桥(window.sb) 不可用'); } catch (_) {} return Promise.resolve(null); }
    try { return Promise.resolve(g.saveFile(filename, b64, ext)).then(res => { if (res && res.path) _toast('已导出：' + filename); return res; }).catch(e => { try { alert('导出失败：' + (e && e.message || e)); } catch (_) {} return null; }); }
    catch (e) { try { alert('导出失败：' + (e && e.message || e)); } catch (_) {} return Promise.resolve(null); }
  }
  function saveXlsx(filename, sheets) {
    const wb = XLSX.utils.book_new();
    Object.keys(sheets || {}).forEach(name => XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(sheets[name] && sheets[name].length ? sheets[name] : [['(空)']]), String(name).slice(0, 31)));
    // 版本水印：统一附一张「说明」sheet，记录导出所用 app 版本+构建时间+导出时间(交付文件可追溯)。
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['说明'], [verStamp()]]), '说明');
    const b64 = XLSX.write(wb, { type: 'base64', bookType: 'xlsx' });
    return _saveFile(safe(filename), b64, 'xlsx');
  }
  function savePptxTables(filename, title, slides) {
    const pptx = new PptxGenJS(); pptx.defineLayout({ name: 'W', width: 13.333, height: 7.5 }); pptx.layout = 'W';
    (slides && slides.length ? slides : [{ name: '', aoa: [['(空)']] }]).forEach(sl => {
      const s = pptx.addSlide();
      s.addText(String(title || '') + (sl.name ? ' · ' + sl.name : ''), { x: 0.3, y: 0.25, w: 12.7, h: 0.4, fontSize: 18, bold: true, color: '1A1A1A' });
      const aoa = (sl.aoa && sl.aoa.length) ? sl.aoa : [['(空)']];
      const rows = aoa.map((r, ri) => (r && r.length ? r : ['']).map(c => ({ text: c == null ? '' : String(c), options: ri === 0 ? { bold: true, fill: { color: 'F2F3F5' }, color: '333333' } : { color: '333333' } })));
      s.addTable(rows, { x: 0.3, y: 0.8, w: 12.7, fontSize: 9, border: { type: 'solid', color: 'E6E8EB', pt: 0.5 }, autoPage: true, autoPageRepeatHeader: true, valign: 'middle' });
    });
    return pptx.write('base64').then(b64 => _saveFile(safe(filename), b64, 'pptx'));
  }
  // ---- Live Excel formula cells (Task 7) -------------------------------
  // Replace a precomputed ratio/diff cell with a real SheetJS formula cell so
  // the user can audit/recalc. Keeps the cached numeric value `v` so the cell
  // shows correctly before any recalc. `formula` must NOT include a leading '='
  // (FinCalc.fXxx returns it that way). `z` is an optional number format.
  function setFormulaCell(XLSX, ws, r, c, formula, v, z) {
    if (!formula) return;
    const addr = XLSX.utils.encode_cell({ r: r, c: c });
    const prev = ws[addr];
    const cell = { t: 'n', f: formula };
    if (v != null && isFinite(v)) cell.v = v;
    const zz = z || (prev && prev.z);   // 不传 z 时保留原有数字格式(如 0.0% 百分号)
    if (zz) cell.z = zz;
    ws[addr] = cell;
  }
  const _col = (XLSX, c) => XLSX.utils.encode_col(c);

  // 经营达成表: turn the 同比/达成率/NSIP同比/毛率同比(pp)/GM% columns into live
  // formulas referencing their raw component columns in the SAME Excel row.
  // colKeys: data-column keys in order (NOT incl. the firstLabel col 0).
  //          i.e. data column for colKeys[i] is Excel column index i+1.
  // dataRowIdxs: 0-based aoa row indices that hold data (total + detail rows).
  // FinCalc: the formula-string helpers (fYoy/fAttain/fRate/fPp).
  function applyFaFormulas(XLSX, ws, FinCalc, colKeys, dataRowIdxs) {
    const idx = k => colKeys.indexOf(k);             // index within data cols
    const ci = k => idx(k) + 1;                       // 0-based incl firstLabel
    const has = k => idx(k) >= 0;
    // [targetKey, kind, numKey, denKey] — kind: yoy|attain|rate|pp
    const specs = [
      ['revYoy', 'yoy', 'rev26', 'rev25'],
      ['gmYoy', 'yoy', 'gm26', 'gm25'],
      ['gmr25', 'rate', 'gm25', 'rev25'],
      ['gmr26', 'rate', 'gm26', 'rev26'],
      ['gmrDiff', 'pp', 'gmr26', 'gmr25'],
      ['nsipYoy', 'pp', 'nsip26', 'nsip25'],   // NSIP同比=绝对USD差(单价同比),用减法不用比率
      ['attain', 'attain', 'rev26', 'fc'],
      ['bpAttain', 'attain', 'rev26', 'bp'],   // 新增：BP达成率 = 实际收入/全年BP
      ['fcAttain', 'attain', 'rev26', 'fc'],   // 新增：预测达成率 = 实际收入/全年预测
    ];
    (dataRowIdxs || []).forEach(r => {
      const exRow = r + 1; // Excel 1-based
      const ref = k => _col(XLSX, ci(k)) + exRow;
      specs.forEach(s => {
        const [tk, kind, nk, dk] = s;
        if (!has(tk) || !has(nk) || !has(dk)) return;
        const a = ref(nk), b = ref(dk);
        let formula = null;
        if (kind === 'yoy') formula = FinCalc.fYoy(a, b);
        else if (kind === 'attain') formula = FinCalc.fAttain(a, b);
        else if (kind === 'rate') formula = FinCalc.fRate(a, b);
        else if (kind === 'pp') formula = FinCalc.fPp(a, b);
        const cur = ws[XLSX.utils.encode_cell({ r: r, c: ci(tk) })];
        const cached = cur && typeof cur.v === 'number' ? cur.v : undefined;
        setFormulaCell(XLSX, ws, r, ci(tk), formula, cached);
      });
    });
  }

  // Generic single 同比 column: set yoyCol = (curCol-prevCol)/prevCol per row.
  // opts: { rows:[aoaRowIdx...], yoyCol, curCol, prevCol }. Uses the existing
  // cached value already in the yoy cell when present, else recomputes.
  function applyRowYoy(XLSX, ws, FinCalc, opts) {
    const o = opts || {};
    (o.rows || []).forEach(r => {
      const exRow = r + 1;
      const a = _col(XLSX, o.curCol) + exRow, b = _col(XLSX, o.prevCol) + exRow;
      const cur = ws[XLSX.utils.encode_cell({ r: r, c: o.yoyCol })];
      let v = cur && typeof cur.v === 'number' ? cur.v : undefined;
      if (v == null) {
        const cv = ws[XLSX.utils.encode_cell({ r: r, c: o.curCol })];
        const pv = ws[XLSX.utils.encode_cell({ r: r, c: o.prevCol })];
        if (cv && pv && typeof cv.v === 'number' && typeof pv.v === 'number') v = FinCalc.yoy(cv.v, pv.v);
      }
      setFormulaCell(XLSX, ws, r, o.yoyCol, FinCalc.fYoy(a, b), v == null ? undefined : v, o.z);
    });
  }

  return { ymd, safe, verStamp, saveXlsx, savePptxTables, setFormulaCell, applyFaFormulas, applyRowYoy };
});

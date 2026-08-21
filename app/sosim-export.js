// app/sosim-export.js
(function (root, factory) {
  const XLSX = (typeof require !== 'undefined') ? require('xlsx') : root.XLSX;
  const api = factory(XLSX);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.SoSimExport = api;
})(this, function (XLSX) {
  const ROW_DEFS = [
    ['发货量', 'shipment', 'input'], ['Sell In', 'sellIn', 'input'], ['Sell Out', 'sellOut', 'input'],
    ['渠道库存', 'channelInv', 'inv'], ['渠道DOS', 'channelDOS', 'dos'],
    ['全流程库存', 'fullInv', 'flowinv'], ['全流程DOS', 'fullDOS', 'dos'],
  ];
  function colLetter(idx) { return XLSX.utils.encode_col(idx); }
  function buildSheetAoaWithFormulas(table) {
    // 行 0 = 表头；列 0 = 行名；列 1.. = 各期
    const aoa = [['', ...table.colLabels]];
    const rowIndexByKey = {};
    ROW_DEFS.forEach((rd, i) => { rowIndexByKey[rd[1]] = i + 1; });
    ROW_DEFS.forEach(rd => {
      const [label, key] = rd; const arr = table.rows[key] || [];
      aoa.push([label, ...arr]);
    });
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    // 未来列写公式：库存/DOS 引用单元格
    const nDays = table.colLabels.map(() => 30); // 月近似；视图可传真实天数覆盖（见注）
    table.past.forEach((isPast, ci) => {
      // ci===0 没有可引用的前一数据列（仅当整个窗口都在未来时才会命中）；
      // 保留 aoa 写入的数值作为种子，后续列再以公式引用它。
      if (isPast || ci === 0) return;
      const col = colLetter(ci + 1);            // 数据列（+1 因首列是行名）
      const prevCol = colLetter(ci);
      const rSI = rowIndexByKey.sellIn + 1, rSO = rowIndexByKey.sellOut + 1, rSH = rowIndexByKey.shipment + 1;
      const rCI = rowIndexByKey.channelInv + 1, rFI = rowIndexByKey.fullInv + 1;
      const rCD = rowIndexByKey.channelDOS + 1, rFD = rowIndexByKey.fullDOS + 1;
      const nd = (table.nDays && table.nDays[ci] != null) ? table.nDays[ci] : nDays[ci];
      // 渠道库存 = 上期渠道库存 + 本期SellIn − 本期SellOut
      ws[col + rCI] = { t: 'n', f: `${prevCol}${rCI}+${col}${rSI}-${col}${rSO}` };
      // 全流程库存 = 上期全流程库存 + 本期发货 − 本期SellOut
      ws[col + rFI] = { t: 'n', f: `${prevCol}${rFI}+${col}${rSH}-${col}${rSO}` };
      // 渠道DOS / 全流程DOS = IFERROR(库存*天数/SO, 0)
      ws[col + rCD] = { t: 'n', f: `ROUND(IFERROR(${col}${rCI}*${nd}/${col}${rSO},0),0)` };
      ws[col + rFD] = { t: 'n', f: `ROUND(IFERROR(${col}${rFI}*${nd}/${col}${rSO},0),0)` };
    });
    return ws;
  }
  function buildWorkbook(o) {
    const wb = XLSX.utils.book_new();
    (o.tables || []).forEach((t, i) => {
      const name = (t.title || ('表' + (i + 1))).slice(0, 28).replace(/[\\\/\?\*\[\]:]/g, '_');
      XLSX.utils.book_append_sheet(wb, buildSheetAoaWithFormulas(t), name + '#' + (i + 1));
    });
    const fAoa = [['country', 'model', 'ymd', 'metric', 'value']];
    (o.forecastRows || []).forEach(r => fAoa.push([r.country, r.model, r.ymd, r.metric, r.value]));
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(fAoa), '_forecast');
    // 版本水印：写进 _meta（parseWorkbook 按 key 读，忽略未知行 → 不影响 round-trip）。
    const stamp = (typeof window !== 'undefined' && window.ExportUtil && window.ExportUtil.verStamp) ? window.ExportUtil.verStamp() : '';
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['更改时间', o.mtime || ''], ['schemaVersion', 1], ['appVersion', stamp]]), '_meta');
    return wb;
  }
  function parseWorkbook(wb) {
    const out = { forecastRows: [], mtime: '' };
    if (wb.Sheets['_forecast']) {
      const aoa = XLSX.utils.sheet_to_json(wb.Sheets['_forecast'], { header: 1, raw: true });
      for (let i = 1; i < aoa.length; i++) {
        const r = aoa[i]; if (!r || r[1] == null) continue;
        out.forecastRows.push({ country: String(r[0] || ''), model: String(r[1] || ''), ymd: +r[2], metric: String(r[3] || ''), value: +r[4] });
      }
    }
    if (wb.Sheets['_meta']) {
      const aoa = XLSX.utils.sheet_to_json(wb.Sheets['_meta'], { header: 1, raw: true });
      const row = aoa.find(r => r && r[0] === '更改时间'); if (row) out.mtime = String(row[1] || '');
    }
    return out;
  }
  return { buildWorkbook, parseWorkbook };
});

/* ============================================================
   本机工具核心（2026-09-02 用户「像 Claude Code 一样能改我电脑上的 Excel/PPT」）
   纯函数 + 无 DOM，主进程与 Node 测试共用：
     · 文档全文索引：docIndex(text) → 行数组；docSearch(lines, q) 多词 AND 命中带行号；docSlice(lines, from, to)
     · Excel 结构化编辑：applyExcelOps(buf, ops) → buf   ops: setCell / appendRows / addSheet / deleteSheet / setRange
     · PPT 文字替换：pptReplaceText(buf, pairs) → {buf, hits}  (走 office-struct-core 原位替换，版式不动)
     · 工作区守卫：inWorkspace(p, dirs)
   ============================================================ */
'use strict';
const path = require('path');

function docIndex(text) {
  return String(text || '').split(/\r?\n/);
}
function docSearch(lines, q, opt) {
  opt = opt || {};
  const limit = Math.max(1, Math.min(200, +opt.limit || 40));
  const ctx = Math.max(0, Math.min(5, opt.context == null ? 1 : +opt.context));
  const terms = String(q || '').toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return { hits: [], total: 0 };
  const hits = []; let total = 0;
  for (let i = 0; i < lines.length; i++) {
    const L = lines[i].toLowerCase();
    if (!terms.every(t => L.indexOf(t) >= 0)) continue;
    total++;
    if (hits.length < limit) {
      const from = Math.max(0, i - ctx), to = Math.min(lines.length - 1, i + ctx);
      hits.push({ line: i + 1, text: lines[i].slice(0, 400), context: ctx ? lines.slice(from, to + 1).map((s, k) => (from + k + 1) + ': ' + s.slice(0, 200)).join('\n') : '' });
    }
  }
  return { hits, total };
}
function docSlice(lines, from, to) {
  const a = Math.max(1, +from || 1), b = Math.min(lines.length, Math.max(a, +to || (a + 99)));
  if (b - a > 2000) return { error: '一次最多读 2000 行（' + a + '~' + b + '）' };
  return { from: a, to: b, totalLines: lines.length, text: lines.slice(a - 1, b).map((s, k) => (a + k) + ': ' + s).join('\n') };
}

/* ---------- Excel 编辑（xlsx 库；注意：社区版 xlsx 写回会丢失单元格样式/公式缓存，已在工具说明里告知，且写前自动备份） ---------- */
/* 模型给的 ops 格式五花八门（2026-09-04 实测：漏写 op 类型 / 用 type,action / 字段叫 address,val / "Sheet1!B2"）
   → 先归一化再执行，缺类型按字段推断；实在不认识才报错并附示例让模型自纠。 */
const OP_ALIAS = { setcell: 'setCell', set: 'setCell', cell: 'setCell', write: 'setCell', writecell: 'setCell', update: 'setCell', updatecell: 'setCell', setvalue: 'setCell', edit: 'setCell', editcell: 'setCell', modify: 'setCell', replace: 'setCell',
  setrange: 'setRange', range: 'setRange', writerange: 'setRange', fillrange: 'setRange',
  appendrows: 'appendRows', append: 'appendRows', appendrow: 'appendRows', addrows: 'appendRows', addrow: 'appendRows', insertrows: 'appendRows', insertrow: 'appendRows',
  addsheet: 'addSheet', newsheet: 'addSheet', createsheet: 'addSheet', deletesheet: 'deleteSheet', removesheet: 'deleteSheet', dropsheet: 'deleteSheet' };
const OP_EXAMPLE = '格式示例：{"op":"setCell","sheet":"Sheet1","cell":"B2","value":199}';
function splitRef(o, key) {
  if (typeof o[key] === 'string' && o[key].indexOf('!') >= 0) { const at = o[key].lastIndexOf('!'); const s = o[key].slice(0, at).replace(/^'|'$/g, ''); if (!o.sheet) o.sheet = s; o[key] = o[key].slice(at + 1); }
}
function normalizeOp(op) {
  if (!op || typeof op !== 'object') return op;
  const o = Object.assign({}, op);
  const raw = String(o.op || o.type || o.action || o.kind || o.operation || o.name || '').replace(/[\s_-]/g, '').toLowerCase();
  if (OP_ALIAS[raw]) o.op = OP_ALIAS[raw]; else if (raw) o.op = String(o.op || o.type || o.action || o.kind || o.operation || o.name);
  if (o.cell == null && o.address != null) o.cell = o.address;
  if (o.cell == null && o.ref != null) o.cell = o.ref;
  if (o.cell == null && o.target != null && typeof o.target === 'string') o.cell = o.target;
  ['val', 'newValue', 'new_value', 'v', 'to'].forEach(k => { if (o.value === undefined && o[k] !== undefined) o.value = o[k]; });
  if (o.rows == null && Array.isArray(o.data)) o.rows = o.data;
  if (o.rows == null && Array.isArray(o.values)) o.rows = o.values;
  if (o.rows == null && Array.isArray(o.row)) o.rows = [o.row];
  if (o.origin == null && o.start != null) o.origin = o.start;
  if (o.origin == null && o.range != null && typeof o.range === 'string') o.origin = o.range.split(':')[0];
  if (o.sheet == null && o.sheetName != null) o.sheet = o.sheetName;
  if (o.sheet == null && o.worksheet != null) o.sheet = o.worksheet;
  if (o.sheet == null && o.sheet_name != null) o.sheet = o.sheet_name;
  splitRef(o, 'cell'); splitRef(o, 'origin');
  if (!OP_ALIAS[raw]) {   // 缺类型 → 按字段推断
    if (o.cell != null && o.value !== undefined) o.op = 'setCell';
    else if (o.origin != null && Array.isArray(o.rows)) o.op = 'setRange';
    else if (Array.isArray(o.rows) && !o.cell) o.op = 'appendRows';
  }
  if (Array.isArray(o.rows) && o.rows.length && !Array.isArray(o.rows[0]) && (o.rows[0] === null || typeof o.rows[0] !== 'object')) o.rows = [o.rows];   // 一维 → 二维
  if (o.op === 'setCell' && typeof o.value === 'string' && /^-?(0|[1-9]\d*)(\.\d+)?$/.test(o.value.trim())) o.value = Number(o.value.trim());   // "199" → 199（保留 "0012" 这类编号）
  return o;
}
function expandOps(ops) {
  if (ops && !Array.isArray(ops)) ops = (ops.ops && Array.isArray(ops.ops)) ? ops.ops : [ops];
  const out = [];
  (ops || []).forEach(op => {
    const o = normalizeOp(op);
    if (o && o.cells && typeof o.cells === 'object' && !Array.isArray(o.cells)) {   // {cells:{B2:199,C3:"x"}} 映射式
      Object.keys(o.cells).forEach(k => out.push(normalizeOp({ op: 'setCell', sheet: o.sheet, cell: k, value: o.cells[k] })));
    } else out.push(o);
  });
  return out;
}
function applyExcelOps(buf, ops, XLSX) {
  XLSX = XLSX || require('xlsx');
  const wb = XLSX.read(buf, { type: 'buffer', cellStyles: true });
  const applied = [];
  expandOps(ops).forEach((op, i) => {
    const kind = op && op.op;
    if (kind === 'addSheet') {
      const ws = XLSX.utils.aoa_to_sheet(Array.isArray(op.rows) ? op.rows : [[]]);
      const nm = String(op.sheet || ('Sheet' + (wb.SheetNames.length + 1))).slice(0, 31);
      XLSX.utils.book_append_sheet(wb, ws, nm); applied.push('addSheet ' + nm); return;
    }
    if (kind === 'deleteSheet') {
      const idx = wb.SheetNames.indexOf(op.sheet); if (idx < 0) throw new Error('deleteSheet: 没有工作表 ' + op.sheet);
      wb.SheetNames.splice(idx, 1); delete wb.Sheets[op.sheet]; applied.push('deleteSheet ' + op.sheet); return;
    }
    const name = op.sheet || wb.SheetNames[0];
    const ws = wb.Sheets[name]; if (!ws) throw new Error('没有工作表 ' + name + '（现有：' + wb.SheetNames.join('/') + '）');
    if (kind === 'setCell') {
      if (!/^[A-Z]{1,3}[0-9]{1,7}$/i.test(String(op.cell || ''))) throw new Error('setCell: cell 要像 B2');
      const v = op.value;
      ws[op.cell.toUpperCase()] = (typeof v === 'number') ? { t: 'n', v } : (typeof v === 'boolean' ? { t: 'b', v } : { t: 's', v: String(v == null ? '' : v) });
      const r = XLSX.utils.decode_range(ws['!ref'] || 'A1:A1'); const c = XLSX.utils.decode_cell(op.cell.toUpperCase());
      r.s.r = Math.min(r.s.r, c.r); r.s.c = Math.min(r.s.c, c.c); r.e.r = Math.max(r.e.r, c.r); r.e.c = Math.max(r.e.c, c.c);
      ws['!ref'] = XLSX.utils.encode_range(r); applied.push('setCell ' + name + '!' + op.cell.toUpperCase() + '=' + v); return;
    }
    if (kind === 'setRange') {
      if (!/^[A-Z]{1,3}[0-9]{1,7}$/i.test(String(op.origin || ''))) throw new Error('setRange: origin 要像 A1');
      XLSX.utils.sheet_add_aoa(ws, Array.isArray(op.rows) ? op.rows : [], { origin: op.origin.toUpperCase() });
      applied.push('setRange ' + name + '!' + op.origin.toUpperCase() + ' ' + (op.rows || []).length + '行'); return;
    }
    if (kind === 'appendRows') {
      XLSX.utils.sheet_add_aoa(ws, Array.isArray(op.rows) ? op.rows : [], { origin: -1 });
      applied.push('appendRows ' + name + ' +' + (op.rows || []).length + '行'); return;
    }
    throw new Error('第 ' + (i + 1) + ' 个操作缺少或未知 op 类型: ' + JSON.stringify(op).slice(0, 120) + '（支持 setCell/setRange/appendRows/addSheet/deleteSheet；' + OP_EXAMPLE + '）');
  });
  return { buf: XLSX.write(wb, { type: 'buffer', bookType: 'xlsx', cellStyles: true }), applied, sheets: wb.SheetNames.slice() };
}
function excelSummary(buf, XLSX, maxRows) {
  XLSX = XLSX || require('xlsx');
  const wb = XLSX.read(buf, { type: 'buffer' });
  return wb.SheetNames.map(n => {
    const ws = wb.Sheets[n]; const ref = ws['!ref'] || 'A1:A1'; const r = XLSX.utils.decode_range(ref);
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, range: 0 }).slice(0, maxRows || 8);
    return { sheet: n, range: ref, rows: r.e.r - r.s.r + 1, cols: r.e.c - r.s.c + 1, head: rows };
  });
}

/* ---------- PPT 文字替换 ---------- */
function pptReplaceText(buf, pairs, OSC) {
  OSC = OSC || require('./office-struct-core.js');
  const st = OSC.extractPptStructure(buf);
  const repls = []; let hits = 0;
  st.slides.forEach(sl => {
    sl.shapes.forEach((sh, idx) => {
      if (sh.type === 'text' && sh.text) {
        let t = sh.text, changed = false;
        (pairs || []).forEach(p => { if (p && p.find && t.indexOf(p.find) >= 0) { t = t.split(p.find).join(String(p.replace == null ? '' : p.replace)); changed = true; hits++; } });
        if (changed) repls.push({ slideFile: sl.file, shapeIdx: idx, text: t });
      } else if (sh.type === 'table' && sh.rows) {
        const cells = [];
        sh.rows.forEach((row, r) => row.forEach((cell, c) => {
          let t = String(cell || ''), changed = false;
          (pairs || []).forEach(p => { if (p && p.find && t.indexOf(p.find) >= 0) { t = t.split(p.find).join(String(p.replace == null ? '' : p.replace)); changed = true; hits++; } });
          if (changed) cells.push({ r, c, text: t });
        }));
        if (cells.length) repls.push({ slideFile: sl.file, shapeIdx: idx, cells });
      }
    });
  });
  if (!repls.length) return { buf, hits: 0, changed: 0 };
  return { buf: OSC.replacePptTexts(buf, repls), hits, changed: repls.length };
}

/* ---------- 工作区守卫 ---------- */
function inWorkspace(p, dirs) {
  const abs = path.resolve(String(p || ''));
  return (dirs || []).some(d => { const base = path.resolve(String(d || '')); const rel = path.relative(base, abs); return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel)); });
}

module.exports = { docIndex, docSearch, docSlice, applyExcelOps, normalizeOp, expandOps, excelSummary, pptReplaceText, inWorkspace };

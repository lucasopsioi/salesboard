/* ============================================================
   大表引擎（2026-09-04 用户：底表都 50MB 以上，超大文件也要能读好、统计不能算错）

   两条硬设计：
   ① 流式：从磁盘按需定位 zip 条目 → createReadStream(区间) → inflateRaw → 逐行吐出，
      **绝不把整张表载入内存**（内存与文件大小无关，只与"分组数"有关）。
      对比旧的 extractOfficeText：它把整张 sheet XML 读成一个 JS 字符串，35MB 文件实测吃 999MB。
   ② 统计由代码算，模型只挑表/列/筛选条件 —— 数字不可能被模型算错（v129 实测模型自己写脚本把
      208 万算成 1234）。

   另修旧解析的一个静默错误：单元格必须按 r="B7" 的列坐标归位，
   稀疏行（中间有空单元格，Excel 直接省略 <c>）顺序push 会**整行串列**，做统计就是错数。

   纯 Node，无第三方依赖；Excel(.xlsx) 与 CSV/TSV(UTF-8/GBK) 同一套查询接口。
   ============================================================ */
'use strict';
const fs = require('fs');
const zlib = require('zlib');

/* ---------- zip：只读尾部找中央目录，再按区间流式解压单个条目 ---------- */
function zipEntries(filePath) {
  const size = fs.statSync(filePath).size;
  const tailLen = Math.min(size, 66000);
  const fd = fs.openSync(filePath, 'r');
  try {
    const tail = Buffer.alloc(tailLen);
    fs.readSync(fd, tail, 0, tailLen, size - tailLen);
    let e = tail.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    if (e < 0) throw new Error('不是有效的 xlsx/zip（找不到中央目录）');
    const cdN = tail.readUInt16LE(e + 10), cdSize = tail.readUInt32LE(e + 12), cdOff = tail.readUInt32LE(e + 16);
    if (cdOff === 0xffffffff || cdSize === 0xffffffff) throw new Error('该文件是 zip64（>4GB），暂不支持');
    const cd = Buffer.alloc(cdSize);
    fs.readSync(fd, cd, 0, cdSize, cdOff);
    const out = []; let o = 0;
    for (let k = 0; k < cdN && o + 46 <= cd.length; k++) {
      if (cd.readUInt32LE(o) !== 0x02014b50) break;
      const method = cd.readUInt16LE(o + 10), csize = cd.readUInt32LE(o + 20), usize = cd.readUInt32LE(o + 24);
      const nlen = cd.readUInt16LE(o + 28), elen = cd.readUInt16LE(o + 30), clen = cd.readUInt16LE(o + 32);
      const lho = cd.readUInt32LE(o + 42);
      out.push({ name: cd.toString('utf8', o + 46, o + 46 + nlen), method, csize, usize, lho });
      o += 46 + nlen + elen + clen;
    }
    return out;
  } finally { fs.closeSync(fd); }
}
function entryStream(filePath, entry) {
  const fd = fs.openSync(filePath, 'r');
  let dataStart;
  try {
    const lh = Buffer.alloc(30);
    fs.readSync(fd, lh, 0, 30, entry.lho);
    dataStart = entry.lho + 30 + lh.readUInt16LE(26) + lh.readUInt16LE(28);
  } finally { fs.closeSync(fd); }
  const rs = fs.createReadStream(filePath, { start: dataStart, end: dataStart + entry.csize - 1 });
  return entry.method === 8 ? rs.pipe(zlib.createInflateRaw()) : rs;
}
function entryText(filePath, entry, maxChars) {
  return new Promise((resolve, reject) => {
    const st = entryStream(filePath, entry); let s = ''; st.setEncoding('utf8');
    st.on('data', c => { s += c; if (maxChars && s.length > maxChars) { s = s.slice(0, maxChars); st.destroy(); resolve(s); } });
    st.on('end', () => resolve(s)); st.on('error', reject);
  });
}

/* ---------- xlsx 结构：工作表名 ↔ 文件；共享字符串 ---------- */
const unesc = s => String(s).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d)).replace(/&amp;/g, '&');
async function sheetList(filePath, entries) {
  const wbE = entries.find(e => e.name === 'xl/workbook.xml');
  if (!wbE) throw new Error('不是有效的 xlsx（缺 workbook.xml）');
  const wb = await entryText(filePath, wbE);
  const relE = entries.find(e => e.name === 'xl/_rels/workbook.xml.rels');
  const rels = {};
  if (relE) { const rx = await entryText(filePath, relE); const re = /<Relationship\b[^>]*Id="([^"]+)"[^>]*Target="([^"]+)"/g; let m; while ((m = re.exec(rx))) rels[m[1]] = m[2].replace(/^\/?xl\//, '').replace(/^\//, ''); }
  const out = []; const re = /<sheet\b([^>]*)\/>/g; let m;
  while ((m = re.exec(wb))) {
    const a = m[1];
    const name = unesc((a.match(/name="([^"]*)"/) || [])[1] || '');
    const rid = (a.match(/r:id="([^"]*)"/) || [])[1] || '';
    let target = rels[rid] || '';
    if (!target) target = 'worksheets/sheet' + (out.length + 1) + '.xml';
    out.push({ name, path: 'xl/' + target.replace(/^xl\//, '') });
  }
  return out;
}
function sharedStrings(filePath, entries) {
  const e = entries.find(x => x.name === 'xl/sharedStrings.xml');
  if (!e) return Promise.resolve([]);
  return new Promise((resolve, reject) => {
    const st = entryStream(filePath, e); st.setEncoding('utf8');
    const sst = []; let buf = '';
    st.on('data', chunk => {
      buf += chunk; let pos = 0;
      while (true) {
        const s = buf.indexOf('<si>', pos); if (s < 0) break;
        const en = buf.indexOf('</si>', s); if (en < 0) break;
        const seg = buf.slice(s + 4, en);
        let t = ''; const tre = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g; let tm;
        while ((tm = tre.exec(seg))) t += tm[1];
        sst.push(unesc(t)); pos = en + 5;
      }
      buf = buf.slice(pos);   // 未处理的尾部（含被切断的 <si>）整段留到下一块
    });
    st.on('end', () => resolve(sst)); st.on('error', reject);
  });
}

/* ---------- 逐行流式读取（核心）：cells 按 r 坐标归位，行内存 O(列数) ---------- */
const colIdx = ref => { let n = 0; for (let i = 0; i < ref.length; i++) { const c = ref.charCodeAt(i); if (c < 65 || c > 90) break; n = n * 26 + (c - 64); } return n - 1; };
function parseRow(seg, sst) {
  const cells = [];
  const re = /<c\b([^>]*?)\/>|<c\b([^>]*?)>([\s\S]*?)<\/c>/g; let m;
  while ((m = re.exec(seg))) {
    const attrs = m[1] != null ? m[1] : m[2]; const inner = m[3];
    const ref = (attrs.match(/\br="([A-Z]+)/) || [])[1];
    const ci = ref ? colIdx(ref) : cells.length;
    let v = null;
    if (inner) {
      const t = (attrs.match(/\bt="([^"]*)"/) || [])[1] || 'n';
      if (t === 'inlineStr') { let s2 = ''; const tre = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g; let tm; while ((tm = tre.exec(inner))) s2 += tm[1]; v = unesc(s2); }
      else { const vm = inner.match(/<v>([\s\S]*?)<\/v>/); if (vm) { const raw = vm[1]; v = t === 's' ? (sst[+raw] != null ? sst[+raw] : raw) : t === 'b' ? (raw === '1') : unesc(raw); } }
    }
    while (cells.length < ci) cells.push(null);
    cells[ci] = v;
  }
  return cells;
}
function streamSheet(filePath, entry, sst, onRow) {
  return new Promise((resolve, reject) => {
    const st = entryStream(filePath, entry); st.setEncoding('utf8');
    let buf = '', n = 0, done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    st.on('data', chunk => {
      if (done) return;
      buf += chunk; let pos = 0;
      try {
        while (true) {
          let s = buf.indexOf('<row', pos);
          while (s >= 0 && !/[\s>/]/.test(buf[s + 4] || ' ')) s = buf.indexOf('<row', s + 4);   // 别把 <rowBreaks> 当成行
          // 找不到完整行时必须保留末尾几个字符：分块可能正好切在 "<row" 中间，整段丢掉就会静默少行（实测 60 万行少 100 行）
          if (s < 0) { pos = Math.max(pos, buf.length - 8); break; }
          const gt = buf.indexOf('>', s); if (gt < 0) { pos = s; break; }
          if (buf[gt - 1] === '/') { pos = gt + 1; continue; }          // <row r="5"/> 空行
          const e = buf.indexOf('</row>', gt); if (e < 0) { pos = s; break; }
          n++;
          if (onRow(parseRow(buf.slice(gt + 1, e), sst), n) === false) { st.destroy(); return finish(n); }
          pos = e + 6;
        }
      } catch (err) {   // onRow 抛错（如列名写错）必须变成 reject，不能从流回调逃逸成未捕获异常把进程干掉
        done = true; try { st.destroy(); } catch (e2) {} return reject(err);
      }
      buf = buf.slice(pos);
    });
    st.on('end', () => finish(n)); st.on('error', e => { if (!done) { done = true; reject(e); } });
  });
}

/* ---------- CSV/TSV 流式（UTF-8 / GBK 自动判定，支持引号与换行） ---------- */
function looksUtf8(b) { try { new TextDecoder('utf-8', { fatal: true }).decode(b); return true; } catch (e) { return false; } }
function decoderFor(filePath) {
  const fd = fs.openSync(filePath, 'r'); const probe = Buffer.alloc(Math.min(65536, fs.statSync(filePath).size));
  try { fs.readSync(fd, probe, 0, probe.length, 0); } finally { fs.closeSync(fd); }
  if (probe[0] === 0xEF && probe[1] === 0xBB && probe[2] === 0xBF) return 'utf-8';
  return looksUtf8(probe) ? 'utf-8' : 'gb18030';   // 本机 cp936：中文底表常见 GBK
}
function streamCsv(filePath, onRow, opt) {
  opt = opt || {};
  const enc = opt.encoding || decoderFor(filePath);
  const dec = new TextDecoder(enc);
  const delim = opt.delimiter || (/\.tsv$/i.test(filePath) ? '\t' : ',');
  return new Promise((resolve, reject) => {
    const rs = fs.createReadStream(filePath);
    let carry = '', n = 0, done = false, field = '', row = [], inQ = false, prevQ = false;
    const finish = v => { if (!done) { done = true; resolve(v); } };
    const pushField = () => { row.push(field); field = ''; };
    const pushRow = () => { pushField(); n++; const stop = onRow(row.map(x => x === '' ? null : x), n) === false; row = []; return stop; };
    rs.on('data', chunk => {
      if (done) return;
      const s = carry + dec.decode(chunk, { stream: true }); carry = '';
      try {
        for (let i = 0; i < s.length; i++) {
          const c = s[i];
          if (inQ) {
            if (c === '"') { if (s[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
            else field += c;
          } else if (c === '"' && field === '') inQ = true;
          else if (c === delim) pushField();
          else if (c === '\n') { if (pushRow()) { rs.destroy(); return finish(n); } }
          else if (c !== '\r') field += c;
        }
      } catch (err) { done = true; try { rs.destroy(); } catch (e2) {} return reject(err); }
    });
    rs.on('end', () => { try { carry += dec.decode(); if (field !== '' || row.length) pushRow(); } catch (err) { if (!done) { done = true; return reject(err); } } finish(n); });
    rs.on('error', e => { if (!done) { done = true; reject(e); } });
  });
}

/* ---------- 值处理 ---------- */
const NUMRE = /^-?\s*[\d,]*\.?\d+(?:[eE][+-]?\d+)?$/;
function num(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  let s = String(v).trim().replace(/[$¥€£\s]/g, '');
  let neg = false;
  if (/^\((.*)\)$/.test(s)) { neg = true; s = s.slice(1, -1); }          // 会计负数 (123)
  if (/%$/.test(s)) { const p = parseFloat(s.replace(/[,%]/g, '')); return isNaN(p) ? null : (neg ? -p : p) / 100; }
  if (!NUMRE.test(s)) return null;
  const f = parseFloat(s.replace(/,/g, ''));
  return isNaN(f) ? null : (neg ? -f : f);
}
const EXCEL_EPOCH = Date.UTC(1899, 11, 30);
function serialToDate(v) { const n2 = num(v); if (n2 == null || n2 < 1 || n2 > 2958465) return null; return new Date(EXCEL_EPOCH + Math.round(n2 * 86400000)); }
function asDatePart(v, part) {
  let d = serialToDate(v);
  if (!d) { const s = String(v == null ? '' : v).trim(); const m = s.match(/^(\d{4})[-/.](\d{1,2})(?:[-/.](\d{1,2}))?/); if (m) d = new Date(Date.UTC(+m[1], +m[2] - 1, +(m[3] || 1))); }
  if (!d || isNaN(d.getTime())) return null;
  const y = d.getUTCFullYear(), mo = d.getUTCMonth() + 1, da = d.getUTCDate();
  const p2 = x => (x < 10 ? '0' : '') + x;
  if (part === 'year') return String(y);
  if (part === 'quarter') return y + '-Q' + Math.ceil(mo / 3);
  if (part === 'month') return y + '-' + p2(mo);
  return y + '-' + p2(mo) + '-' + p2(da);
}

/* ---------- 列解析：表头名 / 字母 / 序号 ---------- */
function resolveCol(spec, header) {
  if (spec == null) return -1;
  if (typeof spec === 'number') return spec - 1;
  const s = String(spec).trim();
  let i = header.findIndex(h => String(h == null ? '' : h).trim() === s);
  if (i >= 0) return i;
  i = header.findIndex(h => String(h == null ? '' : h).trim().toLowerCase() === s.toLowerCase());
  if (i >= 0) return i;
  if (/^[A-Za-z]{1,3}$/.test(s)) return colIdx(s.toUpperCase());
  if (/^\d+$/.test(s)) return +s - 1;
  return -1;
}
function cmp(a, b) { const na = num(a), nb = num(b); if (na != null && nb != null) return na === nb ? 0 : (na < nb ? -1 : 1); const sa = String(a == null ? '' : a), sb = String(b == null ? '' : b); return sa === sb ? 0 : (sa < sb ? -1 : 1); }
function testFilter(val, op, target) {
  const sv = val == null ? '' : String(val).trim();
  switch (op) {
    case 'eq': return sv === String(target).trim();
    case 'ieq': return sv.toLowerCase() === String(target).trim().toLowerCase();
    case 'ne': return sv !== String(target).trim();
    case 'contains': return sv.toLowerCase().indexOf(String(target).toLowerCase()) >= 0;
    case 'notContains': return sv.toLowerCase().indexOf(String(target).toLowerCase()) < 0;
    case 'gt': return cmp(val, target) > 0;
    case 'gte': return cmp(val, target) >= 0;
    case 'lt': return cmp(val, target) < 0;
    case 'lte': return cmp(val, target) <= 0;
    case 'in': return (Array.isArray(target) ? target : [target]).some(t => sv === String(t).trim());
    case 'notIn': return !(Array.isArray(target) ? target : [target]).some(t => sv === String(t).trim());
    case 'empty': return sv === '';
    case 'notEmpty': return sv !== '';
    default: throw new Error('未知筛选运算符: ' + op + '（支持 eq/ieq/ne/contains/notContains/gt/gte/lt/lte/in/notIn/empty/notEmpty）');
  }
}

/* ---------- 统一的「逐行喂给回调」入口 ---------- */
async function iterate(filePath, opt, onRow) {
  opt = opt || {};
  if (/\.(csv|tsv|txt)$/i.test(filePath)) return { scanned: await streamCsv(filePath, onRow, opt), sheet: null, sheets: [] };
  if (!/\.xlsx$/i.test(filePath)) throw new Error('只支持 .xlsx / .csv / .tsv（.xls 老格式请先另存为 xlsx）');
  const entries = zipEntries(filePath);
  const sheets = await sheetList(filePath, entries);
  if (!sheets.length) throw new Error('这个 xlsx 里没有工作表');
  let pick = sheets[0];
  if (opt.sheet != null && opt.sheet !== '') {
    const s = String(opt.sheet).trim();
    pick = sheets.find(x => x.name === s) || sheets.find(x => x.name.toLowerCase() === s.toLowerCase()) || (/^\d+$/.test(s) ? sheets[+s - 1] : null);
    if (!pick) throw new Error('没有工作表「' + opt.sheet + '」，现有：' + sheets.map(x => x.name).join(' / '));
  }
  const ent = entries.find(e => e.name === pick.path);
  if (!ent) throw new Error('工作表数据缺失：' + pick.path);
  const sst = await sharedStrings(filePath, entries);
  const scanned = await streamSheet(filePath, ent, sst, onRow);
  return { scanned, sheet: pick.name, sheets: sheets.map(x => x.name) };
}

/* ---------- ① 体检：表名/表头/行数/列类型/样例 ---------- */
async function tableProfile(filePath, opt) {
  opt = opt || {};
  const headerRow = Math.max(1, +opt.headerRow || 1);
  const sampleWant = Math.max(1, Math.min(20, +opt.sample || 5));
  let header = null; const sample = []; const stats = [];
  const res = await iterate(filePath, opt, (row, n) => {
    if (n < headerRow) return;
    if (n === headerRow) { header = (row || []).map(x => x == null ? '' : String(x)); return; }
    if (!row) return;
    if (sample.length < sampleWant) sample.push(row.slice(0, 40));
    for (let i = 0; i < row.length && i < 200; i++) {
      const st = stats[i] || (stats[i] = { nonEmpty: 0, numeric: 0, min: null, max: null, distinct: new Map() });
      const v = row[i]; if (v == null || v === '') continue;
      st.nonEmpty++;
      const nv = num(v);
      if (nv != null) { st.numeric++; if (st.min == null || nv < st.min) st.min = nv; if (st.max == null || nv > st.max) st.max = nv; }
      if (st.distinct.size < 30) { const k = String(v); st.distinct.set(k, (st.distinct.get(k) || 0) + 1); }
    }
  });
  const dataRows = Math.max(0, res.scanned - headerRow);
  const cols = (header || []).map((h, i) => {
    const st = stats[i] || { nonEmpty: 0, numeric: 0, distinct: new Map() };
    const kind = st.nonEmpty === 0 ? '空' : (st.numeric / st.nonEmpty > 0.9 ? '数值' : '文本');
    return { col: h || ('第' + (i + 1) + '列'), index: i + 1, type: kind, nonEmpty: st.nonEmpty,
      min: kind === '数值' ? st.min : undefined, max: kind === '数值' ? st.max : undefined,
      samples: [...st.distinct.keys()].slice(0, 8) };
  });
  return { path: filePath, sheet: res.sheet, sheets: res.sheets, headerRow, totalRows: res.scanned, dataRows, columns: cols, sampleRows: sample };
}

/* ---------- ② 取值清单：让模型拿到某列的精确写法（避免拼错静默返回空） ---------- */
async function tableDistinct(filePath, opt) {
  opt = opt || {};
  const headerRow = Math.max(1, +opt.headerRow || 1);
  const top = Math.max(1, Math.min(500, +opt.limit || 50));
  let header = [], ci = -1; const counts = new Map(); let truncated = false;
  await iterate(filePath, opt, (row, n) => {
    if (n < headerRow) return;
    if (n === headerRow) { header = (row || []).map(x => x == null ? '' : String(x)); ci = resolveCol(opt.col, header); if (ci < 0) throw new Error('找不到列「' + opt.col + '」，现有列：' + header.join(' | ')); return; }
    if (!row) return;
    const v = row[ci]; const k = v == null ? '(空)' : String(v).trim();
    if (counts.size >= 20000 && !counts.has(k)) { truncated = true; return; }
    counts.set(k, (counts.get(k) || 0) + 1);
  });
  const rows = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, top).map(([value, count]) => ({ value, count }));
  return { col: opt.col, distinctCount: counts.size, truncated, values: rows };
}

/* ---------- ③ 统计查询：筛选 + 分组 + 指标，全部代码算 ---------- */
async function tableQuery(filePath, opt) {
  opt = opt || {};
  const headerRow = Math.max(1, +opt.headerRow || 1);
  const limit = Math.max(1, Math.min(1000, +opt.limit || 50));
  const metrics = (opt.metrics && opt.metrics.length ? opt.metrics : [{ fn: 'count' }]).map(m => ({
    fn: String(m.fn || 'sum'), col: m.col, as: m.as || ((m.fn || 'sum') + (m.col ? '(' + m.col + ')' : '')),
  }));
  const groupSpecs = (opt.groupBy || []).map(g => (typeof g === 'object' && g) ? { col: g.col, as: g.as || null } : { col: g, as: null });
  let header = [], gIdx = [], mIdx = [], fIdx = [], matched = 0, truncated = false;
  const groups = new Map();
  const blank = () => metrics.map(m => ({ sum: 0, n: 0, min: null, max: null, set: m.fn === 'countDistinct' ? new Set() : null }));
  await iterate(filePath, opt, (row, n) => {
    if (n < headerRow) return;
    if (n === headerRow) {
      header = (row || []).map(x => x == null ? '' : String(x));
      gIdx = groupSpecs.map(g => { const i = resolveCol(g.col, header); if (i < 0) throw new Error('分组列找不到：「' + g.col + '」。现有列：' + header.join(' | ')); return i; });
      mIdx = metrics.map(m => { if (m.fn === 'count') return -1; const i = resolveCol(m.col, header); if (i < 0) throw new Error('指标列找不到：「' + m.col + '」。现有列：' + header.join(' | ')); return i; });
      fIdx = (opt.filters || []).map(f => { const i = resolveCol(f.col, header); if (i < 0) throw new Error('筛选列找不到：「' + f.col + '」。现有列：' + header.join(' | ')); return i; });
      return;
    }
    if (!row) return;
    const fl = opt.filters || [];
    for (let i = 0; i < fl.length; i++) if (!testFilter(row[fIdx[i]], fl[i].op || 'eq', fl[i].value)) return;
    matched++;
    const key = groupSpecs.length ? gIdx.map((ci, k) => { const raw = row[ci]; const as = groupSpecs[k].as; const v = as ? asDatePart(raw, as) : (raw == null ? '(空)' : String(raw).trim()); return v == null ? '(无效日期)' : v; }).join(' | ') : '__ALL__';
    let acc = groups.get(key);
    if (!acc) { if (groups.size >= 50000) { truncated = true; return; } acc = blank(); groups.set(key, acc); }
    for (let i = 0; i < metrics.length; i++) {
      const m = metrics[i], a = acc[i];
      if (m.fn === 'count') { a.n++; continue; }
      const raw = row[mIdx[i]];
      if (m.fn === 'countDistinct') { if (raw != null && raw !== '') a.set.add(String(raw).trim()); continue; }
      const v = num(raw);
      if (v == null) continue;
      a.n++; a.sum += v; if (a.min == null || v < a.min) a.min = v; if (a.max == null || v > a.max) a.max = v;
    }
  });
  const rows = [...groups.entries()].map(([key, acc]) => {
    const o = {};
    if (groupSpecs.length) key.split(' | ').forEach((v, i) => { o[String(groupSpecs[i].col) + (groupSpecs[i].as ? '(' + groupSpecs[i].as + ')' : '')] = v; });
    metrics.forEach((m, i) => {
      const a = acc[i];
      o[m.as] = m.fn === 'count' ? a.n : m.fn === 'countDistinct' ? a.set.size : m.fn === 'sum' ? a.sum
        : m.fn === 'avg' ? (a.n ? a.sum / a.n : null) : m.fn === 'min' ? a.min : m.fn === 'max' ? a.max : null;
      if (typeof o[m.as] === 'number' && !Number.isInteger(o[m.as])) o[m.as] = Math.round(o[m.as] * 1e6) / 1e6;
    });
    return o;
  });
  const sortBy = (opt.sort && opt.sort.by) || (metrics[0] && metrics[0].as);
  const dir = (opt.sort && String(opt.sort.dir).toLowerCase() === 'asc') ? 1 : -1;
  rows.sort((a, b) => { const va = a[sortBy], vb = b[sortBy]; if (typeof va === 'number' && typeof vb === 'number') return (va - vb) * dir; return String(va).localeCompare(String(vb)) * dir; });
  return { path: filePath, matchedRows: matched, groupCount: groups.size, truncated, columns: rows.length ? Object.keys(rows[0]) : [], rows: rows.slice(0, limit) };
}

/* ---------- ④ 找行：按条件返回原始行（定位用，不做统计） ---------- */
async function tableFind(filePath, opt) {
  opt = opt || {};
  const headerRow = Math.max(1, +opt.headerRow || 1);
  const limit = Math.max(1, Math.min(200, +opt.limit || 20));
  let header = [], fIdx = []; const hits = []; let matched = 0;
  await iterate(filePath, opt, (row, n) => {
    if (n < headerRow) return;
    if (n === headerRow) { header = (row || []).map(x => x == null ? '' : String(x)); fIdx = (opt.filters || []).map(f => { const i = resolveCol(f.col, header); if (i < 0) throw new Error('筛选列找不到：「' + f.col + '」。现有列：' + header.join(' | ')); return i; }); return; }
    if (!row) return;
    const fl = opt.filters || [];
    if (fl.length) { for (let i = 0; i < fl.length; i++) if (!testFilter(row[fIdx[i]], fl[i].op || 'eq', fl[i].value)) return; }
    else if (opt.contains) { if (!row.some(v => v != null && String(v).toLowerCase().indexOf(String(opt.contains).toLowerCase()) >= 0)) return; }
    matched++;
    if (hits.length < limit) hits.push({ row: n, cells: row.slice(0, 40) });
    else if (!opt.countAll) return false;
  });
  return { header, matchedRows: matched, rows: hits };
}

module.exports = { zipEntries, sheetList, sharedStrings, streamSheet, streamCsv, iterate, tableProfile, tableDistinct, tableQuery, tableFind, num, asDatePart, resolveCol, colIdx, parseRow, decoderFor };

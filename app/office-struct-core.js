// pptx 结构化解析与原位文本替换（模板学习的地基，Node/main 双端）
// 职责：
//   readZipEntries(buf)            → [{name, data:Buffer}]           读全部 zip 条目
//   writeZip(entries)              → Buffer                          重打包（deflate + CRC32）
//   extractPptStructure(buf)       → {slides:[{file, shapes:[...]}]} 每形状：类型/位置/全文/表格
//   replacePptTexts(buf, repls)    → Buffer                          按 (slideFile, shapeIdx) 替换文本，版式不动
// 替换策略：目标 shape 的第一个 <a:t> 写新文本（沿用其字体样式），其余 <a:t> 清空；
// 表格按 (rowIdx, colIdx) 定位单元格同法处理。
'use strict';
const zlib = require('zlib');

/* ---------------- CRC32（zip 标准多项式 0xEDB88320） ---------------- */
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = 0 ^ (-1);
  for (let i = 0; i < buf.length; i++) c = (c >>> 8) ^ CRC_TABLE[(c ^ buf[i]) & 0xFF];
  return (c ^ (-1)) >>> 0;
}

/* ---------------- zip 读（central directory，全量条目） ---------------- */
function readZipEntries(buf) {
  const out = [];
  const i = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (i < 0) return out;
  const cdOff = buf.readUInt32LE(i + 16), cdN = buf.readUInt16LE(i + 10);
  let o = cdOff;
  for (let k = 0; k < cdN; k++) {
    if (buf.readUInt32LE(o) !== 0x02014b50) break;
    const method = buf.readUInt16LE(o + 10), csize = buf.readUInt32LE(o + 20);
    const nlen = buf.readUInt16LE(o + 28), elen = buf.readUInt16LE(o + 30), clen = buf.readUInt16LE(o + 32);
    const lho = buf.readUInt32LE(o + 42);
    const name = buf.toString('utf8', o + 46, o + 46 + nlen);
    const lnlen = buf.readUInt16LE(lho + 26), lelen = buf.readUInt16LE(lho + 28);
    const dstart = lho + 30 + lnlen + lelen;
    const raw = buf.slice(dstart, dstart + csize);
    let data;
    try { data = method === 8 ? zlib.inflateRawSync(raw) : Buffer.from(raw); } catch (e) { data = Buffer.alloc(0); }
    out.push({ name, data });
    o += 46 + nlen + elen + clen;
  }
  return out;
}

/* ---------------- zip 写（全 deflate；PowerPoint 可开） ---------------- */
function writeZip(entries) {
  const locals = [], centrals = [];
  let off = 0;
  for (const e of entries) {
    const nameB = Buffer.from(e.name, 'utf8');
    const data = Buffer.isBuffer(e.data) ? e.data : Buffer.from(String(e.data || ''), 'utf8');
    const comp = zlib.deflateRawSync(data, { level: 6 });
    const crc = crc32(data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6); // UTF-8 标志
    lh.writeUInt16LE(8, 8); lh.writeUInt16LE(0, 10); lh.writeUInt16LE(0x21, 12);            // 固定时间戳（可重现打包）
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(nameB.length, 26); lh.writeUInt16LE(0, 28);
    locals.push(lh, nameB, comp);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x0800, 8);
    ch.writeUInt16LE(8, 10); ch.writeUInt16LE(0, 12); ch.writeUInt16LE(0x21, 14);
    ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(nameB.length, 28);
    ch.writeUInt32LE(off, 42);
    centrals.push(ch, nameB);
    off += 30 + nameB.length + comp.length;
  }
  const cdStart = off;
  let cdSize = 0;
  centrals.forEach(b => { cdSize += b.length; });
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdSize, 12); eocd.writeUInt32LE(cdStart, 16);
  return Buffer.concat([...locals, ...centrals, eocd]);
}

/* ---------------- pptx 结构解析 ---------------- */
const unesc = (s) => String(s || '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
function textsIn(xml) {
  const out = []; const re = /<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/g; let m;
  while ((m = re.exec(xml))) out.push(unesc(m[1]));
  return out;
}
function posOf(xml) {
  const off = xml.match(/<a:off\s+x="(-?\d+)"\s+y="(-?\d+)"/);
  const ext = xml.match(/<a:ext\s+cx="(\d+)"\s+cy="(\d+)"/);
  const EMU = 914400; // 1 inch
  return {
    x: off ? +(+off[1] / EMU).toFixed(2) : null, y: off ? +(+off[2] / EMU).toFixed(2) : null,
    w: ext ? +(+ext[1] / EMU).toFixed(2) : null, h: ext ? +(+ext[2] / EMU).toFixed(2) : null,
  };
}
// 每页把 <p:sp>(文本框/占位符) 与 <p:graphicFrame>(表格/图表) 按出现顺序编号——
// shapeIdx 是「本页第几个可写形状」，替换端用同一扫描顺序，天然对齐。
const SHAPE_RE = /<p:sp\b[\s\S]*?<\/p:sp>|<p:graphicFrame\b[\s\S]*?<\/p:graphicFrame>/g;
function parseShape(xml) {
  const nameM = xml.match(/<p:cNvPr\s[^>]*name="([^"]*)"/);
  const base = { name: nameM ? unesc(nameM[1]) : '', pos: posOf(xml) };
  if (/^<p:graphicFrame/.test(xml)) {
    const tblM = xml.match(/<a:tbl>[\s\S]*?<\/a:tbl>/);
    if (tblM) {
      const rows = [];
      const rre = /<a:tr\b[\s\S]*?<\/a:tr>/g; let rm;
      while ((rm = rre.exec(tblM[0]))) {
        const cells = [];
        const cre = /<a:tc\b[\s\S]*?<\/a:tc>/g; let cm;
        while ((cm = cre.exec(rm[0]))) cells.push(textsIn(cm[0]).join(''));
        rows.push(cells);
      }
      return Object.assign(base, { type: 'table', rows });
    }
    return Object.assign(base, { type: 'graphic', text: textsIn(xml).join('') });
  }
  return Object.assign(base, { type: 'text', text: textsIn(xml).join('\n').replace(/\n+/g, '\n').trim() });
}
function extractPptStructure(buf) {
  const entries = readZipEntries(buf);
  const slides = entries
    .filter(e => /^ppt\/slides\/slide\d+\.xml$/.test(e.name))
    .sort((a, b) => (+a.name.match(/(\d+)/)[1]) - (+b.name.match(/(\d+)/)[1]));
  return {
    slides: slides.map(e => {
      const xml = e.data.toString('utf8');
      const shapes = [];
      let m; SHAPE_RE.lastIndex = 0;
      while ((m = SHAPE_RE.exec(xml))) shapes.push(parseShape(m[0]));
      return { file: e.name, shapes };
    }),
  };
}

/* ---------------- 原位文本替换 ---------------- */
const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
// 一段 shape/单元格 XML：首个 <a:t> 写入新文本，其余清空；无 <a:t> 时在首个 <a:r> 不存在的情况下不动
function setTexts(xml, newText) {
  let first = true;
  return xml.replace(/(<a:t(?:\s[^>]*)?>)([\s\S]*?)(<\/a:t>)/g, (all, open, _old, close) => {
    if (first) { first = false; return open + esc(newText) + close; }
    return open + close;
  });
}
/* repls: [{slideFile, shapeIdx, text}]                     —— 文本框整体替换
          [{slideFile, shapeIdx, cells:[{r,c,text}]}]      —— 表格按格替换 */
function replacePptTexts(buf, repls) {
  const entries = readZipEntries(buf);
  const bySlide = {};
  (repls || []).forEach(r => { (bySlide[r.slideFile] = bySlide[r.slideFile] || []).push(r); });
  for (const e of entries) {
    const rs = bySlide[e.name];
    if (!rs || !rs.length) continue;
    let xml = e.data.toString('utf8');
    let idx = -1;
    xml = xml.replace(SHAPE_RE, (shapeXml) => {
      idx++;
      const hits = rs.filter(r => r.shapeIdx === idx);
      if (!hits.length) return shapeXml;
      let out = shapeXml;
      for (const h of hits) {
        if (h.cells && h.cells.length) {
          let ri = -1;
          out = out.replace(/<a:tr\b[\s\S]*?<\/a:tr>/g, (rowXml) => {
            ri++;
            const rowHits = h.cells.filter(c => c.r === ri);
            if (!rowHits.length) return rowXml;
            let ci = -1;
            return rowXml.replace(/<a:tc\b[\s\S]*?<\/a:tc>/g, (cellXml) => {
              ci++;
              const hit = rowHits.find(c => c.c === ci);
              return hit ? setTexts(cellXml, hit.text) : cellXml;
            });
          });
        } else {
          out = setTexts(out, h.text);
        }
      }
      return out;
    });
    e.data = Buffer.from(xml, 'utf8');
  }
  return writeZip(entries);
}

module.exports = { readZipEntries, writeZip, extractPptStructure, replacePptTexts, crc32 };

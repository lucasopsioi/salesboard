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
const EMU = 914400; // 1 inch
function posOf(xml) {
  const off = xml.match(/<a:off\s+x="(-?\d+)"\s+y="(-?\d+)"/);
  const ext = xml.match(/<a:ext\s+cx="(\d+)"\s+cy="(\d+)"/);
  return {
    x: off ? +(+off[1] / EMU).toFixed(2) : null, y: off ? +(+off[2] / EMU).toFixed(2) : null,
    w: ext ? +(+ext[1] / EMU).toFixed(2) : null, h: ext ? +(+ext[2] / EMU).toFixed(2) : null,
  };
}
/* 深度样式解析（2026-09-01 用户「要每个元素的框色/字号/字体/文字颜色这种具体信息」）：
   形状填充/边框/阴影、逐 run 的字号/粗斜/颜色/字体、段落对齐——XML 里有精确值，确定性抽取。 */
function colorIn(xml) { const m = String(xml || '').match(/<a:srgbClr\s+val="([0-9A-Fa-f]{6})"/); return m ? m[1].toUpperCase() : null; }
function shapeStyleOf(xml) {
  const spPr = (xml.match(/<p:spPr\b[^>]*>[\s\S]*?<\/p:spPr>/) || [''])[0];
  const st = {};
  if (/<a:noFill\/>/.test(spPr)) st.fill = null;
  else { const fillM = spPr.match(/<a:solidFill>[\s\S]*?<\/a:solidFill>/); if (fillM) st.fill = colorIn(fillM[0]); }
  const lnM = spPr.match(/<a:ln\b[^>]*>[\s\S]*?<\/a:ln>/);
  if (lnM && !/<a:noFill\/>/.test(lnM[0])) {
    st.line = colorIn(lnM[0]);
    const wM = lnM[0].match(/<a:ln\b[^>]*w="(\d+)"/); if (wM) st.lineW = +(+wM[1] / 12700).toFixed(1); // pt
  }
  if (/<a:outerShdw/.test(spPr)) st.shadow = true;
  const prstM = spPr.match(/<a:prstGeom\s+prst="([^"]+)"/); if (prstM) st.geom = prstM[1];
  return st;
}
function runsOf(xml) { // 逐文本 run：text + 字号/粗/斜/色/字体；段落 defRPr 作为该段回退
  const runs = [];
  // 段落级默认（<a:pPr><a:defRPr sz=…>）：手拉小标签常只在 defRPr 带字号
  const dM = xml.match(/<a:defRPr\b[^>]*sz="(\d+)"/);
  const defSz = dM ? +(+dM[1] / 100).toFixed(1) : null;
  const rre = /<a:r>([\s\S]*?)<\/a:r>/g; let rm;
  while ((rm = rre.exec(xml))) {
    const seg = rm[1];
    const tM = seg.match(/<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/);
    if (!tM) continue;
    const pr = (seg.match(/<a:rPr\b[^>]*(?:\/>|>[\s\S]*?<\/a:rPr>)/) || [''])[0];
    const r = { text: unesc(tM[1]) };
    const szM = pr.match(/\bsz="(\d+)"/);
    if (szM) r.fontSize = +(+szM[1] / 100).toFixed(1);
    else if (defSz) r.fontSize = defSz;
    if (/\bb="1"/.test(pr)) r.bold = true;
    if (/\bi="1"/.test(pr)) r.italic = true;
    const c = colorIn(pr); if (c) r.color = c;
    const fM = pr.match(/<a:(?:latin|ea)\s+typeface="([^"]+)"/); if (fM) r.font = unesc(fM[1]);
    runs.push(r);
  }
  return runs;
}

/* ---------------- 主题色（theme1.xml clrScheme）与 schemeClr 解析 ---------------- */
function parseTheme(entries) {
  const th = entries.find(e => /^ppt\/theme\/theme\d+\.xml$/.test(e.name));
  const map = {};
  if (!th) return map;
  const xml = th.data.toString('utf8');
  const cs = (xml.match(/<a:clrScheme[\s\S]*?<\/a:clrScheme>/) || [''])[0];
  const re = /<a:(dk1|lt1|dk2|lt2|accent1|accent2|accent3|accent4|accent5|accent6|hlink|folHlink)>([\s\S]*?)<\/a:\1>/g;
  let m;
  while ((m = re.exec(cs))) {
    const inner = m[2];
    const srgb = inner.match(/<a:srgbClr\s+val="([0-9A-Fa-f]{6})"/);
    const sys = inner.match(/<a:sysClr\s[^>]*lastClr="([0-9A-Fa-f]{6})"/);
    map[m[1]] = (srgb ? srgb[1] : sys ? sys[1] : '000000').toUpperCase();
  }
  // tx1/bg1 是 dk1/lt1 的别名
  map.tx1 = map.dk1; map.bg1 = map.lt1; map.tx2 = map.dk2; map.bg2 = map.lt2;
  return map;
}
function resolveColor(xmlFrag, theme) {
  const s = String(xmlFrag || '');
  const srgb = s.match(/<a:srgbClr\s+val="([0-9A-Fa-f]{6})"/);
  if (srgb) return srgb[1].toUpperCase();
  const sch = s.match(/<a:schemeClr\s+val="(\w+)"/);
  if (sch && theme && theme[sch[1]]) {
    let hex = theme[sch[1]];
    // lumMod/lumOff 近似（PowerPoint 的主题色变体）：只做亮度线性近似，够视觉还原
    const lm = s.match(/<a:lumMod\s+val="(\d+)"/), lo = s.match(/<a:lumOff\s+val="(\d+)"/);
    if (lm || lo) {
      const mod = lm ? +lm[1] / 100000 : 1, off = lo ? +lo[1] / 100000 : 0;
      const c = [0, 2, 4].map(i => parseInt(hex.slice(i, i + 2), 16));
      hex = c.map(v => Math.max(0, Math.min(255, Math.round(v * mod + 255 * off)))).map(v => v.toString(16).padStart(2, '0')).join('').toUpperCase();
    }
    return hex;
  }
  return null;
}

/* ---------------- 图表解析（chartN.xml → 类型/类目/系列(名+值+色)/图例） ----------------
   2026-09-01 用户点名：图表要还原类型/数据/颜色，不是占位。数据用 numCache/strCache（文件内缓存）。 */
const CHART_TYPES = [
  ['barChart', null], ['lineChart', 'line'], ['pieChart', 'pie'], ['doughnutChart', 'doughnut'],
  ['areaChart', 'area'], ['scatterChart', 'line'],
];
function ptsOf(xml) {
  const out = [];
  const re = /<c:pt\s+idx="(\d+)"[^>]*>\s*<c:v>([\s\S]*?)<\/c:v>/g; let m;
  while ((m = re.exec(xml))) out[+m[1]] = unesc(m[2]);
  return out;
}
function parseChartXml(xml, theme) {
  let vtype = null;
  for (const [tag, vt] of CHART_TYPES) {
    if (xml.indexOf('<c:' + tag + '>') >= 0) {
      if (tag === 'barChart') {
        const dir = (xml.match(/<c:barDir\s+val="(\w+)"/) || [0, 'col'])[1];
        const grp = (xml.match(/<c:grouping\s+val="(\w+)"/) || [0, 'clustered'])[1];
        vtype = dir === 'bar'
          ? (grp === 'stacked' ? 'stackBar' : grp === 'percentStacked' ? 'stackBar100' : 'bar')
          : (grp === 'stacked' ? 'stackColumn' : grp === 'percentStacked' ? 'stack100' : 'column');
      } else vtype = vt;
      break;
    }
  }
  if (!vtype) return null;
  const series = [];
  let cats = null;
  const sre = /<c:ser>([\s\S]*?)<\/c:ser>/g; let sm;
  while ((sm = sre.exec(xml))) {
    const seg = sm[1];
    const nameM = seg.match(/<c:tx>[\s\S]*?<c:v>([\s\S]*?)<\/c:v>/);
    const name = nameM ? unesc(nameM[1]) : ('系列' + (series.length + 1));
    const catSeg = (seg.match(/<c:cat>[\s\S]*?<\/c:cat>/) || [''])[0];
    if (!cats) { const c = ptsOf(catSeg); if (c.length) cats = c; }
    const valSeg = (seg.match(/<c:val>[\s\S]*?<\/c:val>/) || [''])[0];
    const values = ptsOf(valSeg).map(v => +v || 0);
    // 系列色：ser 级 spPr 的 solidFill（srgb 或主题色）
    const spSeg = (seg.match(/<c:spPr>[\s\S]*?<\/c:spPr>/) || [''])[0];
    const fillSeg = (spSeg.match(/<a:solidFill>[\s\S]*?<\/a:solidFill>/) || [''])[0];
    const color = resolveColor(fillSeg, theme);
    series.push({ name, values, color });
  }
  const legM = xml.match(/<c:legendPos\s+val="(\w+)"/);
  const titleM = xml.match(/<c:title>[\s\S]*?<a:t>([\s\S]*?)<\/a:t>/);
  return {
    vtype, cats: cats || [], series,
    legendPos: legM ? ({ b: 'bottom', t: 'top', l: 'left', r: 'right' })[legM[1]] || 'bottom' : 'bottom',
    title: titleM ? unesc(titleM[1]) : '',
  };
}
function alignOf(xml) { const m = xml.match(/<a:pPr\b[^>]*algn="(l|ctr|r|just)"/); return m ? ({ l: 'left', ctr: 'center', r: 'right', just: 'left' })[m[1]] : null; }
// 每页把 <p:sp>(文本框/占位符)、<p:pic>(图片) 与 <p:graphicFrame>(表格/图表) 按出现顺序编号——
// shapeIdx 是「本页第几个形状」，替换端用同一扫描顺序，天然对齐。
const SHAPE_RE = /<p:sp\b[\s\S]*?<\/p:sp>|<p:graphicFrame\b[\s\S]*?<\/p:graphicFrame>|<p:pic\b[\s\S]*?<\/p:pic>/g;
function parseShape(xml) {
  const nameM = xml.match(/<p:cNvPr\s[^>]*name="([^"]*)"/);
  const base = { name: nameM ? unesc(nameM[1]) : '', pos: posOf(xml), style: shapeStyleOf(xml) };
  if (/^<p:pic/.test(xml)) {
    const embM = xml.match(/<a:blip\s[^>]*r:embed="([^"]+)"/);
    return Object.assign(base, { type: 'image', rel: embM ? embM[1] : null });
  }
  if (/^<p:graphicFrame/.test(xml)) {
    const tblM = xml.match(/<a:tbl>[\s\S]*?<\/a:tbl>/);
    if (tblM) {
      const rows = []; const rowRuns = [];
      const rre = /<a:tr\b[\s\S]*?<\/a:tr>/g; let rm;
      while ((rm = rre.exec(tblM[0]))) {
        const cells = []; const cellRuns = [];
        const cre = /<a:tc\b[\s\S]*?<\/a:tc>/g; let cm;
        while ((cm = cre.exec(rm[0]))) { cells.push(textsIn(cm[0]).join('')); cellRuns.push(runsOf(cm[0])); }
        rows.push(cells); rowRuns.push(cellRuns);
      }
      return Object.assign(base, { type: 'table', rows, rowRuns });
    }
    const chM = xml.match(/<c:chart\s[^>]*r:id="([^"]+)"/);
    return Object.assign(base, { type: 'graphic', text: textsIn(xml).join(''), chartRel: chM ? chM[1] : null });
  }
  const runs = runsOf(xml);
  return Object.assign(base, {
    type: 'text',
    text: textsIn(xml).join('\n').replace(/\n+/g, '\n').trim(),
    runs,
    align: alignOf(xml),
  });
}
function extractPptStructure(buf, opt) {
  opt = opt || {};
  const entries = readZipEntries(buf);
  const byName = {}; entries.forEach(e => { byName[e.name] = e; });
  const theme = parseTheme(entries);
  // 页面尺寸（presentation.xml sldSz）
  let page = null;
  const presE = byName['ppt/presentation.xml'];
  if (presE) {
    const m = presE.data.toString('utf8').match(/<p:sldSz\s+cx="(\d+)"\s+cy="(\d+)"/);
    if (m) page = { w: +(+m[1] / EMU).toFixed(3), h: +(+m[2] / EMU).toFixed(3) };
  }
  const slides = entries
    .filter(e => /^ppt\/slides\/slide\d+\.xml$/.test(e.name))
    .sort((a, b) => (+a.name.match(/(\d+)/)[1]) - (+b.name.match(/(\d+)/)[1]));
  return {
    page,
    slides: slides.map(e => {
      const xml = e.data.toString('utf8');
      // rels：图片 rel id → media 路径（withImages 时顺带抽 dataUrl）
      const relE = byName[e.name.replace(/^ppt\/slides\//, 'ppt/slides/_rels/') + '.rels'];
      const rels = {};
      if (relE) {
        const rre2 = /<Relationship\s[^>]*Id="([^"]+)"[^>]*Target="([^"]+)"/g; let m2;
        const rxml = relE.data.toString('utf8');
        while ((m2 = rre2.exec(rxml))) rels[m2[1]] = m2[2].replace(/^\.\.\//, 'ppt/').replace(/^\//, '');
      }
      const shapes = [];
      let m; SHAPE_RE.lastIndex = 0;
      while ((m = SHAPE_RE.exec(xml))) shapes.push(parseShape(m[0]));
      shapes.forEach(sh => {
        if (sh.type === 'image' && sh.rel) {
          sh.media = rels[sh.rel] || null;
          if (opt.withImages && sh.media && byName[sh.media]) {
            const ext = (sh.media.match(/\.(\w+)$/) || [0, 'png'])[1].toLowerCase();
            const mime = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp' }[ext] || 'image/png';
            sh.dataUrl = 'data:' + mime + ';base64,' + byName[sh.media].data.toString('base64');
          }
        }
        // 图表：graphicFrame 的 chart rel → charts/chartN.xml 解析出类型/类目/系列(名值色)/图例
        if (sh.type === 'graphic' && sh.chartRel && rels[sh.chartRel] && byName[rels[sh.chartRel]]) {
          try { sh.chart = parseChartXml(byName[rels[sh.chartRel]].data.toString('utf8'), theme); } catch (e2) { sh.chart = null; }
        }
      });
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

module.exports = { readZipEntries, writeZip, extractPptStructure, replacePptTexts, crc32, parseChartXml, parseTheme, resolveColor };

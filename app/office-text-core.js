// Office 文件文本抽取核心（main 进程 / Node 测试 双端同源）
// 手写 zip central directory 解析 + inflateRawSync；不依赖第三方库。
// pptx→逐页文本；docx→正文；xlsx→sharedStrings 解引用+逐 sheet 制表符文本(限400行/sheet)
'use strict';
function extractOfficeText(buf) {
  try {
    const zlib = require('zlib');
    const files = {};
    let i = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    if (i < 0) return '';
    const cdOff = buf.readUInt32LE(i + 16), cdN = buf.readUInt16LE(i + 10);
    let o = cdOff;
    for (let k = 0; k < cdN; k++) {
      if (buf.readUInt32LE(o) !== 0x02014b50) break;
      const method = buf.readUInt16LE(o + 10), csize = buf.readUInt32LE(o + 20);
      const nlen = buf.readUInt16LE(o + 28), elen = buf.readUInt16LE(o + 30), clen = buf.readUInt16LE(o + 32);
      const lho = buf.readUInt32LE(o + 42);
      const nm = buf.toString('utf8', o + 46, o + 46 + nlen);
      if (/^ppt\/slides\/slide\d+\.xml$|^word\/document\.xml$|^xl\/worksheets\/sheet\d+\.xml$|^xl\/sharedStrings\.xml$/.test(nm)) {
        const lnlen = buf.readUInt16LE(lho + 26), lelen = buf.readUInt16LE(lho + 28);
        const dstart = lho + 30 + lnlen + lelen;
        const raw = buf.slice(dstart, dstart + csize);
        try { files[nm] = (method === 8 ? zlib.inflateRawSync(raw) : raw).toString('utf8'); } catch (e) {}
      }
      o += 46 + nlen + elen + clen;
    }
    /* xlsx：sharedStrings 解引用，逐 sheet 拼制表符文本(每行一条，限 400 行/sheet) */
    if (files['xl/sharedStrings.xml'] || Object.keys(files).some(n => n.indexOf('xl/worksheets/') === 0)) {
      const sst = [];
      const sxml = files['xl/sharedStrings.xml'] || '';
      const sre = /<si>([\s\S]*?)<\/si>/g; let sm;
      while ((sm = sre.exec(sxml))) {
        const ts = []; const tre = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g; let tm;
        while ((tm = tre.exec(sm[1]))) ts.push(tm[1]);
        sst.push(ts.join('').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'));
      }
      const outp = [];
      Object.keys(files).filter(n => n.indexOf('xl/worksheets/') === 0).sort().forEach(nm => {
        const rows = [];
        const rre = /<row[^>]*>([\s\S]*?)<\/row>/g; let rm;
        while ((rm = rre.exec(files[nm])) && rows.length < 200000) {
          const cells = [];
          const cre = /<c([^>]*)>(?:[\s\S]*?<v>([\s\S]*?)<\/v>)?[\s\S]*?<\/c>|<c([^>]*)\/>/g; let cm;
          while ((cm = cre.exec(rm[1]))) {
            const attrs = cm[1] || cm[3] || ''; const v = cm[2];
            if (v == null) { cells.push(''); continue; }
            cells.push(/t="s"/.test(attrs) ? (sst[+v] != null ? sst[+v] : v) : v);
          }
          if (cells.some(x => String(x).trim())) rows.push(cells.join('\t'));
        }
        if (rows.length) outp.push('【' + nm.replace(/^xl\/worksheets\/|\.xml$/g, '') + '】\n' + rows.join('\n'));
      });
      if (outp.length) return outp.join('\n\n');
    }
    const names = Object.keys(files).sort((a, b) => (parseInt((a.match(/(\d+)/) || [0, 0])[1]) - parseInt((b.match(/(\d+)/) || [0, 0])[1])));
    const parts = [];
    names.forEach(nm => {
      const xml = files[nm];
      const texts = [];
      const re = /<(?:a|w):t(?:\s[^>]*)?>([\s\S]*?)<\/(?:a|w):t>/g;
      let m2; while ((m2 = re.exec(xml))) { const t = m2[1].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&quot;/g, '"'); if (t.trim()) texts.push(t); }
      if (texts.length) parts.push((nm.indexOf('slide') >= 0 ? ('【' + nm.replace(/^ppt\/slides\/|\.xml$/g, '') + '】\n') : '') + texts.join('\n'));
    });
    return parts.join('\n\n');
  } catch (e) { return ''; }
}
/* 读图片像素尺寸（只看文件头，不解码整图）——用于过滤小图标，比按字节数靠谱
   （2026-09-04 实测：一张 711 字节的正经柱状图被 minBytes:3000 误杀）。认不出尺寸返回 null。 */
function imageSize(buf, ext) {
  try {
    if (!buf || buf.length < 24) return null;
    if (ext === 'png' || (buf[0] === 0x89 && buf[1] === 0x50)) { if (buf.toString('ascii', 12, 16) === 'IHDR') return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) }; return null; }
    if (ext === 'gif' || buf.toString('ascii', 0, 3) === 'GIF') return { w: buf.readUInt16LE(6), h: buf.readUInt16LE(8) };
    if (ext === 'bmp' || (buf[0] === 0x42 && buf[1] === 0x4D)) return { w: buf.readInt32LE(18), h: Math.abs(buf.readInt32LE(22)) };
    if (ext === 'jpg' || ext === 'jpeg' || (buf[0] === 0xFF && buf[1] === 0xD8)) {
      let o = 2;
      while (o + 9 < buf.length) {
        if (buf[o] !== 0xFF) { o++; continue; }
        const m = buf[o + 1];
        if (m >= 0xC0 && m <= 0xCF && m !== 0xC4 && m !== 0xC8 && m !== 0xCC) return { h: buf.readUInt16BE(o + 5), w: buf.readUInt16BE(o + 7) };
        if (m === 0xD8 || m === 0xD9 || (m >= 0xD0 && m <= 0xD7)) { o += 2; continue; }
        o += 2 + buf.readUInt16BE(o + 2);
      }
      return null;
    }
    return null;
  } catch (e) { return null; }
}
/* 抽 Office 内嵌图片（2026-09-04 用户：PPT 里的图也要能读）——ppt/word/xl 的 media 目录。
   返回 [{name, ext, data:Buffer, w, h}]，按像素面积倒序（大图通常是图表/照片，小图多是图标）。
   过滤：尺寸能读到就按像素过滤（宽或高 < minSide 视为图标跳过），读不到再退回字节数兜底。
   opt: {max 默认10, minSide 默认48, minBytes 默认1200, maxBytes 默认8MB} */
function extractOfficeImages(buf, opt) {
  opt = opt || {};
  const max = opt.max || 10, minSide = opt.minSide == null ? 48 : opt.minSide, minB = opt.minBytes == null ? 1200 : opt.minBytes, maxB = opt.maxBytes || 8 * 1024 * 1024;
  try {
    const zlib = require('zlib');
    const out = [];
    let i = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    if (i < 0) return [];
    const cdOff = buf.readUInt32LE(i + 16), cdN = buf.readUInt16LE(i + 10);
    let o = cdOff;
    for (let k = 0; k < cdN; k++) {
      if (buf.readUInt32LE(o) !== 0x02014b50) break;
      const method = buf.readUInt16LE(o + 10), csize = buf.readUInt32LE(o + 20);
      const nlen = buf.readUInt16LE(o + 28), elen = buf.readUInt16LE(o + 30), clen = buf.readUInt16LE(o + 32);
      const lho = buf.readUInt32LE(o + 42);
      const nm = buf.toString('utf8', o + 46, o + 46 + nlen);
      const em = nm.match(/^(?:ppt|word|xl)\/media\/[^/]+\.(png|jpe?g|gif|bmp|webp)$/i);
      if (em && csize <= maxB) {
        const lnlen = buf.readUInt16LE(lho + 26), lelen = buf.readUInt16LE(lho + 28);
        const dstart = lho + 30 + lnlen + lelen;
        const raw = buf.slice(dstart, dstart + csize);
        try {
          const data = method === 8 ? zlib.inflateRawSync(raw) : raw;
          if (data.length > maxB) continue;
          const ext = em[1].toLowerCase();
          const sz = imageSize(data, ext);
          // 尺寸读得到：宽或高任一 < minSide 视为图标跳过；读不到(webp 等)：退回字节数兜底
          if (sz) { if (sz.w < minSide || sz.h < minSide) continue; }
          else if (data.length < minB) continue;
          out.push({ name: nm.replace(/^.*\//, ''), ext, data, w: sz ? sz.w : 0, h: sz ? sz.h : 0 });
        } catch (e) {}
      }
      o += 46 + nlen + elen + clen;
    }
    out.sort((a, b) => (b.w * b.h || b.data.length) - (a.w * a.h || a.data.length));
    return out.slice(0, max);
  } catch (e) { return []; }
}
const IMG_MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', bmp: 'image/bmp', webp: 'image/webp' };
function imageDataUrl(img) { return 'data:' + (IMG_MIME[img.ext] || 'image/png') + ';base64,' + img.data.toString('base64'); }
module.exports = { extractOfficeText, extractOfficeImages, imageDataUrl, imageSize };

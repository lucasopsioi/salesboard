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
        while ((rm = rre.exec(files[nm])) && rows.length < 400) {
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
module.exports = { extractOfficeText };

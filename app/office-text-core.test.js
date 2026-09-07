'use strict';
const { extractOfficeText, extractOfficeImages, imageDataUrl } = require('./office-text-core.js');
const OSC = require('./office-struct-core.js');
const zlib = require('zlib');
let fails = 0; const ok = (n, c, extra) => { console.log((c ? 'PASS ' : 'FAIL ') + n + (!c && extra ? '  << ' + extra : '')); if (!c) fails++; };

// 造一张 24x24 纯色 PNG 当内嵌图
function solidPng(w, h, r, g, b) {
  const crc32 = (buf) => { let c = ~0; for (let i = 0; i < buf.length; i++) { c ^= buf[i]; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1)); } return (~c) >>> 0; };
  const chunk = (t, d) => { const T = Buffer.from(t); const L = Buffer.alloc(4); L.writeUInt32BE(d.length); const C = Buffer.alloc(4); C.writeUInt32BE(crc32(Buffer.concat([T, d]))); return Buffer.concat([L, T, d, C]); };
  const ih = Buffer.alloc(13); ih.writeUInt32BE(w, 0); ih.writeUInt32BE(h, 4); ih[8] = 8; ih[9] = 2;
  const raw = Buffer.alloc(h * (1 + w * 3)); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const o = y * (1 + w * 3) + 1 + x * 3; raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ih), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const bigPng = solidPng(80, 80, 10, 200, 40);   // ~ 数百字节以上
const iconPng = solidPng(4, 4, 0, 0, 0);         // 极小，应被 minBytes 跳过

// 组一个含 slide 文本 + 两张 media 图的 pptx（用 writeZip；media 用 STORED 更真实，deflate 也测）
const slideXml = '<?xml version="1.0"?><p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree><a:t>秘鲁渠道目标 12500 台</a:t></p:spTree></p:cSld></p:sld>';
const pptx = OSC.writeZip([
  { name: '[Content_Types].xml', data: '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>' },
  { name: 'ppt/slides/slide1.xml', data: slideXml },
  { name: 'ppt/media/image1.png', data: bigPng },
  { name: 'ppt/media/image2.png', data: iconPng },
]);

ok('T1 pptx 抽文本', /12500/.test(extractOfficeText(pptx)), extractOfficeText(pptx).slice(0, 80));
const imgs = extractOfficeImages(pptx);   // 默认按尺寸过滤：80x80 保留，4x4 图标跳过
ok('T2 抽出大图、跳过小图标(按尺寸)', imgs.length === 1 && imgs[0].ext === 'png' && imgs[0].w === 80 && imgs[0].h === 80, JSON.stringify(imgs.map(i => [i.name, i.w, i.h, i.data.length])));
ok('T2b imageSize 读 PNG 宽高', JSON.stringify(require('./office-text-core.js').imageSize(bigPng, 'png')) === '{"w":80,"h":80}');
ok('T3 dataUrl 格式正确', /^data:image\/png;base64,/.test(imageDataUrl(imgs[0])) && imageDataUrl(imgs[0]).length > 100);
// 抽出的 PNG 字节应能被 zlib 正常识别为 PNG 签名（没被解压坏）
ok('T4 抽出的图字节完好(PNG 签名)', imgs[0].data.slice(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])));

// docx / xl 的 media 也认
const docx = OSC.writeZip([
  { name: 'word/document.xml', data: '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>报告</w:t></w:r></w:p></w:body></w:document>' },
  { name: 'word/media/image1.png', data: bigPng },
]);
const dimgs = extractOfficeImages(docx);
ok('T5 docx 内嵌图也抽得到', dimgs.length === 1, JSON.stringify(dimgs.length));

// 非 Office/损坏输入不崩
ok('T6 垃圾输入返回空数组不抛', Array.isArray(extractOfficeImages(Buffer.from('not a zip'))) && extractOfficeImages(Buffer.from('not a zip')).length === 0);

console.log(fails ? ('FAILURES: ' + fails) : 'ALL PASS');
process.exit(fails ? 1 : 0);

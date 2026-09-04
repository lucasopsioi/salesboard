/* 自带二维码编码器（QR Code Model 2, byte 模式, 纠错级 M, 版本 1-10）——零依赖、可离线、双端。
   仅需编码一个短 URL（http://ip:port/code），byte 模式足矣。用于「本机接收」窗口显示二维码。
   参考 ISO/IEC 18004。实现范围刻意收窄到 byte 模式 + level M + v1..10（容量约 170 字节，URL 绰绰有余）。 */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.QRCore = api;
})(this, function () {
  // —— GF(256) 伽罗华域，本原多项式 0x11d，生成元 2 ——
  const EXP = new Uint8Array(512), LOG = new Uint8Array(256);
  (function () { let x = 1; for (let i = 0; i < 255; i++) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 0x100) x ^= 0x11d; } for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255]; })();
  const gmul = (a, b) => (a === 0 || b === 0) ? 0 : EXP[LOG[a] + LOG[b]];

  // —— level M 的分块表：[ecPerBlock, [[blocks, dataCwPerBlock], ...]]（v1..10）——
  const ECB_M = {
    1: [10, [[1, 16]]], 2: [16, [[1, 28]]], 3: [26, [[1, 44]]], 4: [18, [[2, 32]]], 5: [24, [[2, 43]]],
    6: [16, [[4, 27]]], 7: [18, [[4, 31]]], 8: [22, [[2, 38], [2, 39]]], 9: [22, [[3, 36], [2, 37]]], 10: [26, [[4, 43], [1, 44]]],
  };
  const ALIGN = { 1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34], 7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50] };
  const REMAINDER = { 1: 0, 2: 7, 3: 7, 4: 7, 5: 7, 6: 7, 7: 0, 8: 0, 9: 0, 10: 0 };

  function dataCapacityBytes(ver) { const [ec, groups] = ECB_M[ver]; const dataCw = groups.reduce((s, g) => s + g[0] * g[1], 0); const countBits = ver >= 10 ? 16 : 8; return Math.floor((dataCw * 8 - 4 - countBits) / 8); }
  function pickVersion(len) { for (let v = 1; v <= 10; v++) if (dataCapacityBytes(v) >= len) return v; throw new Error('内容过长，超出 v10 byte 容量（' + len + ' 字节）'); }

  // —— RS 生成多项式（degree 个纠错码字）——
  function rsGen(degree) { let g = [1]; for (let i = 0; i < degree; i++) { const ng = new Array(g.length + 1).fill(0); for (let j = 0; j < g.length; j++) { ng[j] ^= g[j]; ng[j + 1] ^= gmul(g[j], EXP[i]); } g = ng; } return g; }   // 首一多项式，index0=最高次
  function rsEncode(data, ecLen) { const gen = rsGen(ecLen); const res = new Array(data.length + ecLen).fill(0); for (let i = 0; i < data.length; i++) res[i] = data[i]; for (let i = 0; i < data.length; i++) { const c = res[i]; if (c !== 0) for (let j = 0; j < gen.length; j++) res[i + j] ^= gmul(gen[j], c); } return res.slice(data.length); }

  // —— 编码数据码字（byte 模式）——
  function encodeData(text, ver) {
    const bytes = []; for (let i = 0; i < text.length; i++) { const c = text.charCodeAt(i); if (c < 128) bytes.push(c); else { const s = unescape(encodeURIComponent(text.charAt(i))); for (let k = 0; k < s.length; k++) bytes.push(s.charCodeAt(k)); } }
    const [ec, groups] = ECB_M[ver]; const dataCw = groups.reduce((s, g) => s + g[0] * g[1], 0);
    const bits = []; const put = (val, n) => { for (let i = n - 1; i >= 0; i--) bits.push((val >> i) & 1); };
    put(0b0100, 4);                       // byte 模式
    put(bytes.length, ver >= 10 ? 16 : 8); // 字符数
    bytes.forEach(b => put(b, 8));
    const cap = dataCw * 8;
    for (let i = 0; i < 4 && bits.length < cap; i++) bits.push(0);   // 终止符
    while (bits.length % 8 !== 0) bits.push(0);
    const pads = [0xEC, 0x11]; let pi = 0;
    const cw = []; for (let i = 0; i < bits.length; i += 8) { let v = 0; for (let j = 0; j < 8; j++) v = (v << 1) | bits[i + j]; cw.push(v); }
    while (cw.length < dataCw) cw.push(pads[pi++ % 2]);
    return { cw, ec, groups };
  }

  // —— 分块 + 交织 ——
  function interleave(enc) {
    const { cw, ec, groups } = enc; const blocks = []; let p = 0;
    groups.forEach(([n, d]) => { for (let b = 0; b < n; b++) { const data = cw.slice(p, p + d); p += d; blocks.push({ data, ecc: rsEncode(data, ec) }); } });
    const maxD = Math.max(...blocks.map(b => b.data.length)); const out = [];
    for (let i = 0; i < maxD; i++) blocks.forEach(b => { if (i < b.data.length) out.push(b.data[i]); });
    for (let i = 0; i < ec; i++) blocks.forEach(b => out.push(b.ecc[i]));
    return out;
  }

  // —— 矩阵：功能图形 + 数据放置 + 掩码 ——
  function buildMatrix(ver, codewords) {
    const size = 17 + 4 * ver; const m = []; const fn = [];
    for (let i = 0; i < size; i++) { m.push(new Array(size).fill(null)); fn.push(new Array(size).fill(false)); }
    const setF = (r, c, v) => { m[r][c] = v ? 1 : 0; fn[r][c] = true; };
    // 定位图形（3 角）+ 分隔
    const finder = (r0, c0) => { for (let r = -1; r <= 7; r++) for (let c = -1; c <= 7; c++) { const r1 = r0 + r, c1 = c0 + c; if (r1 < 0 || c1 < 0 || r1 >= size || c1 >= size) continue; const on = (r >= 0 && r <= 6 && (c === 0 || c === 6)) || (c >= 0 && c <= 6 && (r === 0 || r === 6)) || (r >= 2 && r <= 4 && c >= 2 && c <= 4); setF(r1, c1, on); } };
    finder(0, 0); finder(0, size - 7); finder(size - 7, 0);
    // 计时图形
    for (let i = 8; i < size - 8; i++) { setF(6, i, i % 2 === 0); setF(i, 6, i % 2 === 0); }
    // 校正图形
    const ap = ALIGN[ver]; for (let a = 0; a < ap.length; a++) for (let b = 0; b < ap.length; b++) { const r0 = ap[a], c0 = ap[b]; if (fn[r0][c0]) continue; for (let r = -2; r <= 2; r++) for (let c = -2; c <= 2; c++) setF(r0 + r, c0 + c, Math.max(Math.abs(r), Math.abs(c)) !== 1); }
    // 暗模块
    setF(size - 8, 8, true);
    // 预留格式信息区（占位，先标记为功能区，稍后写）
    for (let i = 0; i < 9; i++) { if (!fn[8][i]) { m[8][i] = 0; fn[8][i] = true; } if (!fn[i][8]) { m[i][8] = 0; fn[i][8] = true; } }
    for (let i = 0; i < 8; i++) { if (!fn[8][size - 1 - i]) { m[8][size - 1 - i] = 0; fn[8][size - 1 - i] = true; } if (!fn[size - 1 - i][8]) { m[size - 1 - i][8] = 0; fn[size - 1 - i][8] = true; } }
    // 预留版本信息区（v>=7）
    if (ver >= 7) { for (let i = 0; i < 6; i++) for (let j = 0; j < 3; j++) { m[i][size - 11 + j] = 0; fn[i][size - 11 + j] = true; m[size - 11 + j][i] = 0; fn[size - 11 + j][i] = true; } }
    // 数据位（zigzag）
    const bits = []; codewords.forEach(cw => { for (let i = 7; i >= 0; i--) bits.push((cw >> i) & 1); });
    for (let i = 0; i < REMAINDER[ver]; i++) bits.push(0);
    let bi = 0, upward = true;
    for (let col = size - 1; col > 0; col -= 2) { if (col === 6) col--; for (let k = 0; k < size; k++) { const row = upward ? size - 1 - k : k; for (let c = 0; c < 2; c++) { const cc = col - c; if (fn[row][cc]) continue; m[row][cc] = bi < bits.length ? bits[bi] : 0; bi++; } } upward = !upward; }
    return { m, fn, size };
  }

  const MASKS = [
    (r, c) => (r + c) % 2 === 0, (r, c) => r % 2 === 0, (r, c) => c % 3 === 0, (r, c) => (r + c) % 3 === 0,
    (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0, (r, c) => (r * c) % 2 + (r * c) % 3 === 0,
    (r, c) => ((r * c) % 2 + (r * c) % 3) % 2 === 0, (r, c) => ((r + c) % 2 + (r * c) % 3) % 2 === 0,
  ];
  function applyMask(m, fn, size, mask) { const o = m.map(r => r.slice()); for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) if (!fn[r][c] && MASKS[mask](r, c)) o[r][c] ^= 1; return o; }

  function penalty(m, size) {
    let p = 0;
    for (let r = 0; r < size; r++) { let run = 1; for (let c = 1; c < size; c++) { if (m[r][c] === m[r][c - 1]) { run++; if (run === 5) p += 3; else if (run > 5) p++; } else run = 1; } }
    for (let c = 0; c < size; c++) { let run = 1; for (let r = 1; r < size; r++) { if (m[r][c] === m[r - 1][c]) { run++; if (run === 5) p += 3; else if (run > 5) p++; } else run = 1; } }
    for (let r = 0; r < size - 1; r++) for (let c = 0; c < size - 1; c++) { const v = m[r][c]; if (v === m[r][c + 1] && v === m[r + 1][c] && v === m[r + 1][c + 1]) p += 3; }
    const pat = [1, 0, 1, 1, 1, 0, 1];
    const has = (arr, i) => { for (let k = 0; k < 7; k++) if (arr[i + k] !== pat[k]) return false; return true; };
    for (let r = 0; r < size; r++) for (let c = 0; c <= size - 7; c++) { if (has(m[r], c)) { const before = c - 4 < 0 || [0, 0, 0, 0].every((_, k) => m[r][c - 4 + k] === 0); const after = c + 7 + 4 > size || [0, 0, 0, 0].every((_, k) => m[r][c + 7 + k] === 0); if (before || after) p += 40; } }
    for (let c = 0; c < size; c++) for (let r = 0; r <= size - 7; r++) { const col = []; for (let k = 0; k < size; k++) col.push(m[k][c]); if (has(col, r)) { const before = r - 4 < 0 || [0, 0, 0, 0].every((_, k) => col[r - 4 + k] === 0); const after = r + 7 + 4 > size || [0, 0, 0, 0].every((_, k) => col[r + 7 + k] === 0); if (before || after) p += 40; } }
    let dark = 0; for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) dark += m[r][c]; const pct = dark * 100 / (size * size); p += Math.floor(Math.abs(pct - 50) / 5) * 10;
    return p;
  }

  // BCH 格式信息（level M = 00）
  function formatBits(mask) { const data = (0b00 << 3) | mask; let v = data << 10; const g = 0b10100110111; for (let i = 14; i >= 10; i--) if ((v >> i) & 1) v ^= g << (i - 10); return ((data << 10) | v) ^ 0b101010000010010; }
  function versionBits(ver) { let v = ver << 12; const g = 0b1111100100101; for (let i = 17; i >= 12; i--) if ((v >> i) & 1) v ^= g << (i - 12); return (ver << 12) | v; }

  function placeFormat(m, size, mask) {
    const b = formatBits(mask); const bit = i => (b >> i) & 1;
    for (let i = 0; i <= 5; i++) m[8][i] = bit(i); m[8][7] = bit(6); m[8][8] = bit(7); m[7][8] = bit(8);
    for (let i = 9; i <= 14; i++) m[14 - i][8] = bit(i);
    for (let i = 0; i <= 7; i++) m[size - 1 - i][8] = bit(i);
    for (let i = 8; i <= 14; i++) m[8][size - 15 + i] = bit(i);
    m[size - 8][8] = 1;   // 暗模块
  }
  function placeVersion(m, size, ver) { if (ver < 7) return; const b = versionBits(ver); for (let i = 0; i < 18; i++) { const bit = (b >> i) & 1; const r = Math.floor(i / 3), c = i % 3; m[r][size - 11 + c] = bit; m[size - 11 + c][r] = bit; } }

  function encode(text, ecLevel) {   // ecLevel 目前固定 M
    text = String(text == null ? '' : text);
    const nb = []; for (let i = 0; i < text.length; i++) { const c = text.charCodeAt(i); if (c < 128) nb.push(1); else nb.push(unescape(encodeURIComponent(text.charAt(i))).length); }
    const byteLen = nb.reduce((a, b) => a + b, 0);
    const ver = pickVersion(byteLen);
    const codewords = interleave(encodeData(text, ver));
    const { m, fn, size } = buildMatrix(ver, codewords);
    let best = null;
    for (let mask = 0; mask < 8; mask++) { const mm = applyMask(m, fn, size, mask); placeFormat(mm, size, mask); placeVersion(mm, size, ver); const pen = penalty(mm, size); if (!best || pen < best.pen) best = { pen, mm, mask }; }
    return { version: ver, size, modules: best.mm.map(r => r.map(v => !!v)), mask: best.mask };
  }
  function toSvg(text, opt) {
    opt = opt || {}; const { size, modules } = encode(text); const q = opt.quiet == null ? 4 : opt.quiet; const scale = opt.scale || 6; const dim = (size + q * 2) * scale;
    let path = ''; for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) if (modules[r][c]) path += 'M' + ((c + q) * scale) + ' ' + ((r + q) * scale) + 'h' + scale + 'v' + scale + 'h' + (-scale) + 'z';
    return '<svg xmlns="http://www.w3.org/2000/svg" width="' + dim + '" height="' + dim + '" viewBox="0 0 ' + dim + ' ' + dim + '" shape-rendering="crispEdges"><rect width="' + dim + '" height="' + dim + '" fill="#fff"/><path d="' + path + '" fill="#000"/></svg>';
  }
  return { encode, toSvg, _internal: { dataCapacityBytes, pickVersion, rsEncode, formatBits, versionBits } };
});

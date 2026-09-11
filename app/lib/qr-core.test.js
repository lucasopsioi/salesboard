'use strict';
const QR = require('./qr-core.js');
let fails = 0; const ok = (n, c) => { console.log((c ? 'PASS ' : 'FAIL ') + n); if (!c) fails++; };
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// —— 1) Reed-Solomon 已知向量（thonky QR 教程：1-M byte 模式 "HELLO WORLD"）——
const dataHW = [32, 91, 11, 120, 209, 114, 220, 77, 67, 64, 236, 17, 236, 17, 236, 17];
const eccHW = [196, 35, 39, 119, 235, 215, 231, 226, 93, 23];
ok('RS 纠错码字与标准向量一致', eq(QR._internal.rsEncode(dataHW, 10), eccHW));

// —— 2) 格式信息 BCH（level M，8 个掩码，ISO/IEC 18004 附录 C 公开值）——
const FMT_M = [0b101010000010010, 0b101000100100101, 0b101111001111100, 0b101101101001011, 0b100010111111001, 0b100000011001110, 0b100111110010111, 0b100101010100000];
let fmtOk = true; for (let m = 0; m < 8; m++) if (QR._internal.formatBits(m) !== FMT_M[m]) { fmtOk = false; console.log('   mask ' + m + ' got ' + QR._internal.formatBits(m).toString(2) + ' want ' + FMT_M[m].toString(2)); }
ok('格式信息 8 个掩码全对', fmtOk);

// —— 3) 版本信息 BCH（v7-10 公开值）——
const VER = { 7: 0b000111110010010100, 8: 0b001000010110111100, 9: 0b001001101010011001, 10: 0b001010010011010011 };
let verOk = true; Object.keys(VER).forEach(v => { if (QR._internal.versionBits(+v) !== VER[v]) { verOk = false; console.log('   v' + v + ' got ' + QR._internal.versionBits(+v).toString(2) + ' want ' + VER[v].toString(2)); } });
ok('版本信息 v7-10 全对', verOk);

// —— 4) 容量选版本 ——
ok('短 URL 选到合适版本', QR._internal.pickVersion(30) >= 2 && QR._internal.pickVersion(30) <= 4);
ok('v1 容量约 14 字节', QR._internal.dataCapacityBytes(1) === 14);
ok('v3 容量约 42 字节', QR._internal.dataCapacityBytes(3) === 42);

// —— 5) 结构：尺寸 / 三个定位图形 / 计时图形 / 暗模块 ——
const r = QR.encode('http://192.168.1.23:8765/4821');
ok('尺寸 = 17 + 4*版本', r.size === 17 + 4 * r.version);
const M = r.modules;
const finderAt = (r0, c0) => { for (let a = 0; a < 7; a++) for (let b = 0; b < 7; b++) { const on = (a === 0 || a === 6 || b === 0 || b === 6) || (a >= 2 && a <= 4 && b >= 2 && b <= 4); if (M[r0 + a][c0 + b] !== on) return false; } return true; };
ok('左上定位图形正确', finderAt(0, 0));
ok('右上定位图形正确', finderAt(0, r.size - 7));
ok('左下定位图形正确', finderAt(r.size - 7, 0));
let timing = true; for (let i = 8; i < r.size - 8; i++) { if (M[6][i] !== (i % 2 === 0)) timing = false; if (M[i][6] !== (i % 2 === 0)) timing = false; }
ok('计时图形交替', timing);
ok('暗模块置 1', M[r.size - 8][8] === true);

// —— 6) 分隔区（定位图形外一圈为白）——
let sep = true; for (let i = 0; i < 8; i++) { if (M[7][i] !== false) sep = false; if (M[i][7] !== false) sep = false; }
ok('左上分隔区为白', sep);

// —— 7) SVG 产出可用 ——
const svg = QR.toSvg('http://192.168.1.23:8765/4821');
ok('toSvg 产出合法 SVG', /^<svg[\s\S]+<\/svg>$/.test(svg) && svg.indexOf('<path') > 0);

// —— 8) 中文/长内容不崩，选更高版本 ——
const r2 = QR.encode('http://192.168.100.200:8765/9999?x=中文测试');
ok('含中文 UTF-8 编码不崩', r2.size > 0 && r2.version >= 1);

console.log(fails ? ('FAILURES: ' + fails) : 'ALL PASS');
process.exit(fails ? 1 : 0);

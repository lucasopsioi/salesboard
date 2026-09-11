// app/grid-core.test.js — 表格 Excel 化内核：选区 / 统计 / TSV / 数字解析 / 列宽
const G = require('./grid-core.js');
let f = 0; const ok = (n, c, d) => { console.log((c ? 'PASS ' : 'FAIL ') + n + (!c && d !== undefined ? '  << ' + JSON.stringify(d) : '')); if (!c) f++; };
const near = (a, b, e) => a != null && Math.abs(a - b) <= (e || 1e-9);

// —— 选区 ——
ok('G1 选区归一成矩形（反向拖也要对）', (() => {
  const r = G.normRange({ r: 5, c: 8 }, { r: 2, c: 3 });
  return r.r0 === 2 && r.r1 === 5 && r.c0 === 3 && r.c1 === 8;
})());
ok('G2 单格选区', (() => { const r = G.normRange({ r: 1, c: 1 }); return r.r0 === 1 && r.r1 === 1 && G.rangeSize(r) === 1; })());
ok('G3 命中判定', (() => { const r = G.normRange({ r: 1, c: 1 }, { r: 3, c: 4 }); return G.inRange(r, 2, 2) && !G.inRange(r, 0, 2) && !G.inRange(r, 2, 5); })());
ok('G4 选区格子数 = 行×列', G.rangeSize(G.normRange({ r: 0, c: 0 }, { r: 2, c: 3 })) === 12);

const B = { rows: 4, cols: 6 };
ok('G5 方向移动不越界（上边界）', G.movePos({ r: 0, c: 2 }, 'up', B).r === 0);
ok('G6 方向移动不越界（右边界）', G.movePos({ r: 1, c: 5 }, 'right', B).c === 5);
ok('G7 Tab 到行尾折到下一行行首', (() => { const p = G.movePos({ r: 1, c: 5 }, 'right', B, { wrap: true }); return p.r === 2 && p.c === 0; })());
ok('G8 Shift+Tab 到行首折回上一行行尾', (() => { const p = G.movePos({ r: 1, c: 0 }, 'left', B, { wrap: true }); return p.r === 0 && p.c === 5; })());
ok('G9 Home/End 跳到本行首尾', G.movePos({ r: 1, c: 3 }, 'home', B).c === 0 && G.movePos({ r: 1, c: 3 }, 'end', B).c === 5);
ok('G10 最后一行 Tab 折行也不越界', (() => { const p = G.movePos({ r: 3, c: 5 }, 'right', B, { wrap: true }); return p.r === 3 && p.c === 5; })(), G.movePos({ r: 3, c: 5 }, 'right', B, { wrap: true }));

// —— 数字解析（空 ≠ 0 是全项目铁律）——
ok('N1 千分位', G.parseNum('1,234') === 1234);
ok('N2 小数与负数', G.parseNum('-12.5') === -12.5 && G.parseNum('.5') === 0.5);
ok('N3 会计括号负数', G.parseNum('(300)') === -300);
ok('N4 百分号转小数', near(G.parseNum('12.5%'), 0.125));
ok('N5 全角数字', G.parseNum('１２３') === 123);
ok('N6 空/占位符 → null（不是0）', G.parseNum('') === null && G.parseNum(null) === null && G.parseNum('  ') === null);
ok('N7 非数字文本 → null', G.parseNum('待定') === null && G.parseNum('12a') === null && G.parseNum('--') === null);
ok('N8 数字类型直通', G.parseNum(42) === 42 && G.parseNum(NaN) === null);

// —— 统计条 ——
const st = G.statsOf(['100', '200', '', '—', '300']);
ok('S1 计数只数非空格', st.count === 3, st);
ok('S2 求和 = 600', st.sum === 600, st);
ok('S3 平均 = 600/3 = 200（空格不当0参与）', st.avg === 200, st);
ok('S4 最小/最大', st.min === 100 && st.max === 300, st);
const st2 = G.statsOf(['', '', '']);
ok('S5 全空 → 求和/平均为 null，不是 0', st2.sum === null && st2.avg === null && st2.count === 0, st2);
const st3 = G.statsOf(['100', '待定', '200']);
ok('S6 文本计入「计数」但不参与求和/平均', st3.count === 3 && st3.numCount === 2 && st3.sum === 300 && st3.avg === 150, st3);
ok('S7 负数参与', (() => { const s = G.statsOf(['-100', '300']); return s.sum === 200 && s.min === -100; })());

// —— TSV 剪贴板 ——
ok('T1 解析 Excel 的 CRLF TSV', (() => { const m = G.parseTsv('1\t2\r\n3\t4\r\n'); return m.length === 2 && m[1][1] === '4'; })(), G.parseTsv('1\t2\r\n3\t4\r\n'));
ok('T2 末尾空行不制造幽灵行', G.parseTsv('1\n2\n\n\n').length === 2);
ok('T3 单格粘贴', (() => { const m = G.parseTsv('500'); return m.length === 1 && m[0][0] === '500'; })());
ok('T4 空文本 → 空矩阵', G.parseTsv('').length === 0 && G.parseTsv(null).length === 0);
ok('T5 toTsv 往返一致', G.toTsv([['1', '2'], ['3', '4']]) === '1\t2\n3\t4');
ok('T6 toTsv 把 null 写成空串（不写 "null"）', G.toTsv([[null, 1]]) === '\t1');

// —— 粘贴铺开 ——
const sp = G.spreadPaste([['1', '2'], ['3', '4']], { r: 1, c: 1 }, { rows: 5, cols: 5 });
ok('P1 从落点按块大小铺开', sp.length === 4 && sp[0].r === 1 && sp[0].c === 1 && sp[3].r === 2 && sp[3].c === 2, sp);
const sp2 = G.spreadPaste([['1', '2', '3']], { r: 0, c: 1 }, { rows: 2, cols: 2 });
ok('P2 超出表格边界的部分丢弃，不写到表外', sp2.length === 1 && sp2[0].c === 1, sp2);

// —— 列宽 / 冻结偏移 ——
const L = G.leftOffsets([150, 130, 90, 90, 90, 52], 6);
ok('W1 冻结列 left 由列宽累加', JSON.stringify(L) === JSON.stringify([0, 150, 280, 370, 460, 550]), L);
ok('W2 改了列宽 left 跟着变（写死像素就会错位）', (() => {
  const x = G.leftOffsets([200, 130, 90], 3); return x[1] === 200 && x[2] === 330;
})(), G.leftOffsets([200, 130, 90], 3));
ok('W3 只冻结前 N 列，其余为 null（= 不 sticky）', (() => {
  const x = G.leftOffsets([100, 100, 100, 100], 2); return x[0] === 0 && x[1] === 100 && x[2] === null && x[3] === null;
})());
ok('W4 冻结数为 0 → 全部不冻结', G.leftOffsets([100, 100], 0).every(v => v === null));
ok('W5 列宽夹在上下限内', G.clampWidth(5, 40, 600) === 40 && G.clampWidth(9999, 40, 600) === 600 && G.clampWidth(123.6, 40, 600) === 124);

console.log(f ? (f + ' FAILED') : 'ALL PASS');
process.exit(f ? 1 : 0);

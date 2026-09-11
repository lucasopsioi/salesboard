'use strict';
/* Floor FOB 核心测试 —— 从 the earlier prototype/tests/test_pipeline.py 解析/计算段逐条移植。
   口径断言与 Python 版一字不差:块长嗅探、字段列位、Tarvos/Halden/Vantor6 三个价格锚点。 */
const F = require('./fob-core.js');
const S = require('./fob-sample.js');
let f = 0;
const ok = (n, c, x) => { console.log((c ? 'PASS ' : 'FAIL ') + n + (c ? '' : '   ← ' + (x || ''))); if (!c) f++; };
const near = (a, b, tol) => a != null && Math.abs(a - b) <= (tol == null ? 0.01 : tol);

/* ---------- values ---------- */
ok('V1 千分位+空格', F.parseNumber(' 1,234.50 ') === 1234.5);
ok('V2 百分号转小数', F.parseNumber('12.70%') === 0.127);
ok('V3 括号负数', F.parseNumber('(360.2)') === -360.2);
ok('V4 井号占位 → null', F.parseNumber('########') === null);
ok('V5 空白 token → null', F.parseNumber('#N/A') === null && F.parseNumber('—') === null);
ok('V6 parseRate 裸数字默认已是小数', F.parseRate('0.127') === 0.127);
ok('V7 parseRate bare_is_percent 只动 |v|>1.5', F.parseRate('12.7', true) === 0.127 && F.parseRate('0.5', true) === 0.5);
ok('V8 日期文本', F.parseDate('2026/7/23') === '2026-07-23' && F.parseDate('2026年7月23日') === '2026-07-23');
ok('V9 Excel 序列号 46226', F.parseDate('46226') === '2026-07-23', F.parseDate('46226'));
ok('V10 非法日期 → null', F.parseDate('2026/13/1') === null && F.parseDate('99') === null);

/* ---------- months ---------- */
const M = F.M;
ok('M1 add 跨年', M.add(202611, 3) === 202702 && M.add(202601, -2) === 202511);
ok('M2 diff', M.diff(202702, 202611) === 3);
ok('M3 label', M.label(202512) === 'Dec-25');
ok('M4 parse 四形态', M.parse('202607') === 202607 && M.parse('2026-07') === 202607 && M.parse('Jul-26') === 202607 && M.parse('2026年7月') === 202607);
ok('M5 parse 26-Jul', M.parse('26-Jul') === 202607);
ok('M6 两位年 00-79→20xx', M.parse('Dec-99') === 199912 && M.parse('Dec-25') === 202512);

/* ---------- 归一化 ---------- */
ok('K1 大小写/空白/全角折叠', F.normalizeModelKey('Quanta-W09CK') === F.normalizeModelKey('quanta - w09ck') && F.normalizeModelKey('Ｔarvos–W09DK') === F.normalizeModelKey('TARVOS-W09DK'));

/* ---------- 块长嗅探(真实 22 型号样本) ---------- */
const col = S.toColumn();
const pr = F.parsePaste(col);
ok('P1 识别出 22 个产品', pr.nProducts === 22, 'got ' + pr.nProducts);
ok('P2 识别出 28 个字段', pr.nFields === 28, 'got ' + pr.nFields);
ok('P3 不需要跳行', pr.skip === 0, 'skip=' + pr.skip);
const pr2 = F.parsePaste(S.toColumn(null, 2));
ok('P4 多两个前置维度字段仍识别对', pr2.nProducts === 22 && pr2.nFields === 30, pr2.nProducts + 'x' + pr2.nFields);
const rows5 = S.ROWS.slice(0, 5);
ok('P5 产品数变成 5 也能自动识别', F.parsePaste(S.toColumn(rows5)).nProducts === 5);
for (const missing of [1, 3, 7]) {
  const lines = col.split('\n');
  const cut = lines.slice(0, lines.length - missing).join('\n');
  const prCut = F.parsePaste(cut);
  ok('P6 末尾少 ' + missing + ' 行仍能还原', prCut.nProducts === 22, 'got ' + prCut.nProducts + ' trim=' + prCut.trim);
}
// N=2 假解:型号列整列 FOB净价 → 结构矛盾判据拦下
const badGrid = F.reshape(F.flattenSingleColumn(F.splitInput(col)), 2);
const badLay = F.detectLayout(badGrid, true);
ok('P7 N=2 的假解被判退化', badLay.degenerate && !F.layoutUsable(badLay));
ok('P8 自动识别不会选中假解', F.parsePaste(col).nProducts === 22);

/* ---------- 字段列位(与 Python 版逐列锁死) ---------- */
const lay = pr.layout;
ok('L1 币种列 = 10', lay.currency === 10, 'got ' + lay.currency);
ok('L2 授权口径列 = 9', lay.incoterm === 9, 'got ' + lay.incoterm);
ok('L3 产品型号列 = 8', lay.model === 8, 'got ' + lay.model);
ok('L4 授权价列 = 11', lay.price === 11, 'got ' + lay.price);
ok('L5 生效日期列 = 12', lay.effDate === 12, 'got ' + lay.effDate);
ok('L6 生效当月列 = 13(不算月份)', lay.baseRate === 13, 'got ' + lay.baseRate);
ok('L7 月份从第 14 列开始', lay.monthStart === 14, 'got ' + lay.monthStart);
ok('L8 月份数 = 13(末尾全零列已丢弃)', lay.monthCount === 13, 'got ' + lay.monthCount);
ok('L9 丢弃了 1 个尾列', lay.droppedTail === 1, 'got ' + lay.droppedTail);

/* ---------- 计算(价格锚点 = 合成样本里的三个锚点数) ---------- */
const ext = F.extract(pr, 202607, false, col);
ok('C1 产品行数 22', ext.rows.length === 22, 'got ' + ext.rows.length);
const ms = F.extMonths(ext);
ok('C2 月份区间 202607~202707', ms[0] === 202607 && ms[ms.length - 1] === 202707, ms[0] + '~' + ms[ms.length - 1]);
const cells = F.toCells(ext);
const wk = F.normalizeModelKey('Tarvos-W09DK');
ok('C3 Tarvos-W09DK Jul-26 = 630', near(cells[wk + '|202607'], 630.0, 0.6), 'got ' + cells[wk + '|202607']);
const sk = F.normalizeModelKey('Halden-W29FK');
ok('C4 Halden-W29FK Jul-26 = 380', near(cells[sk + '|202607'], 380.0, 0.6), 'got ' + cells[sk + '|202607']);
const ak = F.normalizeModelKey('Vantor6-W19C');
ok('C5 Vantor6-W19C Jul-27 = 120×1.8', near(cells[ak + '|202707'], 120 * 1.8, 0.1), 'got ' + cells[ak + '|202707']);

/* ---------- 百分号形态一致 ---------- */
const prPct = F.parsePaste(S.toColumn(null, 0, true));
const extPct = F.extract(prPct, 202607, false, '');
const cellsPct = F.toCells(extPct);
ok('C6 百分号形态结果一致', near(cellsPct[wk + '|202607'], cells[wk + '|202607'], 0.01));

/* ---------- 横表/竖表直接粘 ---------- */
const prTab = F.parsePaste(S.toTableText());
ok('T1 直接粘横表也认得', F.layoutUsable(prTab.layout) && prTab.sourceShape === 'table', prTab.sourceShape);
const prVer = F.parsePaste(S.toVerticalText());
ok('T2 粘竖表(字段在行)自动转置', F.layoutUsable(prVer.layout) && prVer.sourceShape === 'table-T', prVer.sourceShape);

/* ---------- 手工指定列 ---------- */
const prMan = F.parsePaste(col, { manual: { model: 8, price: 11, monthStart: 14, monthCount: 5 } });
ok('T3 手工指定列生效', prMan.layout.manual && prMan.layout.monthCount === 5, 'mc=' + prMan.layout.monthCount);

/* ---------- 性能(界面 350ms 防抖,解析必须远快于它) ---------- */
let t0 = Date.now();
F.parsePaste(col);
let ms1 = Date.now() - t0;
ok('T4 解析耗时 ' + ms1 + 'ms < 500ms', ms1 < 500);
t0 = Date.now();
try { F.parsePaste(col.split('\n').slice(0, 173).join('\n')); } catch (e) { }
let ms2 = Date.now() - t0;
ok('T5 失败/去尾路径耗时 ' + ms2 + 'ms < 3000ms', ms2 < 3000);

/* ---------- 基线宽表 ---------- */
const bp = F.parseBoardTable('产品型号\tDec-25\tJan-26\t备注\nTarvos-W09DK\t489\t501\tx\nQuanta-W09CK\t\t737\t');
ok('B1 基线表头月份识别+跳过非月份列', bp.months.join(',') === '202512,202601' && bp.skippedCols.length === 1);
ok('B2 基线格子数', bp.cellCount === 3, 'got ' + bp.cellCount);
ok('B3 空格子留空', bp.rows[1][1][202512] === undefined && bp.rows[1][1][202601] === 737);
let threw = false;
try { F.parseBoardTable('产品型号\t备注\nA\t1'); } catch (e) { threw = e instanceof F.BoardPasteError; }
ok('B4 无月份表头报错', threw);

console.log(f ? ('\n' + f + ' FAILED') : '\nALL PASS');
process.exit(f ? 1 : 0);

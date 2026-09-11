const { docIndex, docSearch, docSlice, applyExcelOps, excelSummary, pptReplaceText, inWorkspace } = require('./local-tools-core.js');
const XLSX = require('xlsx');
let fails = 0;
const ok = (n, c) => { console.log((c ? 'PASS ' : 'FAIL ') + n); if (!c) fails++; };

// —— 文档索引/搜索/切片 ——
const lines = docIndex('a 平板 100\nb 音频 200\nc 平板 墨西哥 300\nd 其它');
const s1 = docSearch(lines, '平板');
ok('L1 单词命中 2 行', s1.total === 2 && s1.hits[0].line === 1 && s1.hits[1].line === 3);
ok('L2 多词 AND', docSearch(lines, '平板 墨西哥').total === 1);
ok('L3 大小写/空词', docSearch(lines, 'A').total === 1 && docSearch(lines, '').total === 0);
const sl = docSlice(lines, 2, 3);
ok('L4 切片带行号', /^2: b/.test(sl.text) && sl.to === 3 && sl.totalLines === 4);
ok('L5 切片越界收敛', docSlice(lines, 3, 99).to === 4);

// —— Excel 编辑 ——
const wb = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['产品', '价格'], ['A', 100], ['B', 200]]), 'Sheet1');
const buf0 = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
const r = applyExcelOps(buf0, [
  { op: 'setCell', sheet: 'Sheet1', cell: 'B2', value: 199 },
  { op: 'appendRows', sheet: 'Sheet1', rows: [['C', 300]] },
  { op: 'addSheet', sheet: '新表', rows: [['x', 'y'], [1, 2]] },
  { op: 'setRange', sheet: '新表', origin: 'A3', rows: [[3, 4]] },
], XLSX);
const wb2 = XLSX.read(r.buf, { type: 'buffer' });
const a1 = XLSX.utils.sheet_to_json(wb2.Sheets.Sheet1, { header: 1 });
ok('E1 setCell 生效', a1[1][1] === 199);
ok('E2 appendRows 追加到末尾', a1.length === 4 && a1[3][0] === 'C' && a1[3][1] === 300);
ok('E3 addSheet + setRange', wb2.SheetNames.indexOf('新表') >= 0 && XLSX.utils.sheet_to_json(wb2.Sheets['新表'], { header: 1 })[2][1] === 4);
ok('E4 applied 日志', r.applied.length === 4 && /setCell Sheet1!B2=199/.test(r.applied[0]));
let threw = false; try { applyExcelOps(buf0, [{ op: 'setCell', sheet: '不存在', cell: 'A1', value: 1 }], XLSX); } catch (e) { threw = /没有工作表/.test(e.message); }
ok('E5 错表名报错含现有表', threw);
threw = false; try { applyExcelOps(buf0, [{ op: 'nuke' }], XLSX); } catch (e) { threw = /未知/.test(e.message); }
ok('E6 未知操作报错', threw);
const sm = excelSummary(buf0, XLSX);
ok('E7 summary 行列', sm[0].rows === 3 && sm[0].cols === 2 && sm[0].head[0][0] === '产品');
// —— 模型给的 ops 格式容错（2026-09-04 实测：漏写 op 类型导致「操作参数格式错误」）——
const cellOf = (buf, addr) => { const wb = XLSX.read(buf, { type: 'buffer' }); const ws = wb.Sheets[wb.SheetNames[0]]; return ws[addr] ? ws[addr].v : undefined; };
const r8 = applyExcelOps(buf0, [{ cell: 'B2', value: 199 }], XLSX);
ok('E8 漏写 op：cell+value 推断为 setCell', /setCell/.test(r8.applied[0]) && cellOf(r8.buf, 'B2') === 199);
const r9 = applyExcelOps(buf0, [{ type: 'set_cell', address: 'C1', val: '7' }], XLSX);
ok('E9 别名 type/address/val + 数字字符串转数', cellOf(r9.buf, 'C1') === 7);
const r10 = applyExcelOps(buf0, [{ cells: { B3: 5, C2: 'x' } }], XLSX);
ok('E10 映射式 cells:{B3:5}', cellOf(r10.buf, 'B3') === 5 && cellOf(r10.buf, 'C2') === 'x');
const r11 = applyExcelOps(buf0, [{ op: 'append', row: ['新品', 1] }], XLSX);
ok('E11 append+一维 row → appendRows', excelSummary(r11.buf, XLSX)[0].rows === 4);
const sheetName = XLSX.read(buf0, { type: 'buffer' }).SheetNames[0];
const r12 = applyExcelOps(buf0, { op: 'setCell', cell: sheetName + '!B2', value: '0012' }, XLSX);
ok('E12 单个对象 + Sheet!Cell 引用 + 编号字符串保留', cellOf(r12.buf, 'B2') === '0012');
threw = false; try { applyExcelOps(buf0, [{ foo: 1 }], XLSX); } catch (e) { threw = /格式示例/.test(e.message); }
ok('E13 无法推断时报错附示例', threw);

// —— PPT 文字替换（造 pptx → 替换 → 读回）——
(async () => {
  const PptxGenJS = require('pptxgenjs');
  const p = new PptxGenJS(); const s = p.addSlide();
  s.addText('2026年Q3 目标 1000 台', { x: 1, y: 1, w: 6, h: 1 });
  s.addTable([[{ text: '地区' }, { text: '目标' }], [{ text: '墨西哥' }, { text: '1000' }]], { x: 1, y: 3, w: 6 });
  const tmp = require('path').join(require('os').tmpdir(), 'ltc-test.pptx');
  await p.writeFile({ fileName: tmp });
  const fs = require('fs');
  const out = pptReplaceText(fs.readFileSync(tmp), [{ find: '1000', replace: '1200' }, { find: 'Q3', replace: 'Q4' }]);
  const OSC = require('./office-struct-core.js');
  const st = OSC.extractPptStructure(out.buf);
  const txt = st.slides[0].shapes.map(x => x.type === 'table' ? JSON.stringify(x.rows) : x.text).join(' | ');
  ok('P1 文本框与表格都替换', /Q4 目标 1200 台/.test(txt) && /"1200"/.test(txt) && out.hits === 3);
  ok('P2 无命中不改文件', pptReplaceText(fs.readFileSync(tmp), [{ find: '不存在', replace: 'x' }]).hits === 0);
  try { fs.unlinkSync(tmp); } catch (e) {}

  // —— 工作区守卫 ——
  const W = ['D:\\工作文件', 'C:/Users/x/Desktop'];
  ok('W1 子路径在内', inWorkspace('D:\\工作文件\\a\\b.xlsx', W) && inWorkspace('C:/Users/x/Desktop/t.pptx', W));
  ok('W2 越界拒绝', !inWorkspace('D:\\工作文件2\\a.xlsx', W) && !inWorkspace('D:\\工作文件\\..\\其他\\a.xlsx', W) && !inWorkspace('E:\\a', W));
  ok('W3 工作区根本身在内', inWorkspace('D:\\工作文件', W));

  console.log(fails ? ('FAILURES: ' + fails) : 'ALL PASS');
  process.exit(fails ? 1 : 0);
})();

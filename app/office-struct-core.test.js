// office-struct-core 闭环测试：pptxgenjs 造 pptx → 解析结构 → 原位替换 → 重打包 → 双模块读回验证
'use strict';
const path = require('path');
const fs = require('fs');
const os = require('os');
let fails = 0;
const ok = (n, c) => { console.log((c ? 'PASS ' : 'FAIL ') + n); if (!c) fails++; };

(async () => {
  const PptxGenJS = require('pptxgenjs');
  const { extractPptStructure, replacePptTexts, readZipEntries, writeZip } = require('./office-struct-core.js');
  const { extractOfficeText } = require('./office-text-core.js');

  // ── 造样例：2 页（页1 标题+两个数据文本框；页2 一个 2x3 表格） ──
  const pptx = new PptxGenJS();
  pptx.defineLayout({ name: 'W', width: 13.333, height: 7.5 }); pptx.layout = 'W';
  const s1 = pptx.addSlide();
  s1.addText('墨西哥平板月报', { x: 0.5, y: 0.4, w: 8, h: 0.8, fontSize: 28, bold: true });
  s1.addText('累计SO：26,507台', { x: 0.5, y: 1.6, w: 4, h: 0.6, fontSize: 18 });
  s1.addText('同比：+15.5%', { x: 5, y: 1.6, w: 3, h: 0.6, fontSize: 18 });
  const s2 = pptx.addSlide();
  s2.addTable([
    [{ text: '系列' }, { text: 'SO' }, { text: '同比' }],
    [{ text: 'Slate 11' }, { text: '12,345' }, { text: '+20%' }],
  ], { x: 0.5, y: 0.5, w: 8 });
  const tmp = path.join(os.tmpdir(), 'sb-struct-test.pptx');
  await pptx.writeFile({ fileName: tmp });
  const buf = fs.readFileSync(tmp);

  // ── 解析结构 ──
  const st = extractPptStructure(buf);
  ok('2 slides', st.slides.length === 2);
  const p1 = st.slides[0], p2 = st.slides[1];
  ok('slide1 有3个文本形状', p1.shapes.filter(s => s.type === 'text').length === 3);
  const soShape = p1.shapes.find(s => /26,507/.test(s.text || ''));
  ok('找到SO文本框', !!soShape);
  ok('位置解析出英寸坐标', soShape && soShape.pos.x !== null && soShape.pos.x > 0.3 && soShape.pos.x < 0.7);
  const tbl = p2.shapes.find(s => s.type === 'table');
  ok('slide2 表格 2行3列', !!tbl && tbl.rows.length === 2 && tbl.rows[0].length === 3);
  ok('表格单元格文本', !!tbl && tbl.rows[1][1] === '12,345');

  // ── 原位替换：文本框 + 表格格 ──
  const soIdx = p1.shapes.indexOf(soShape);
  const tblIdx = p2.shapes.indexOf(tbl);
  const out = replacePptTexts(buf, [
    { slideFile: p1.file, shapeIdx: soIdx, text: '累计SO：31,888台' },
    { slideFile: p2.file, shapeIdx: tblIdx, cells: [{ r: 1, c: 1, text: '99,999' }, { r: 1, c: 2, text: '+88%' }] },
  ]);

  // ── 读回双验证：新模块结构读 + 旧模块文本读（zip 兼容性交叉证明） ──
  const st2 = extractPptStructure(out);
  ok('替换后文本框', /31,888/.test(st2.slides[0].shapes[soIdx].text));
  ok('旧文本未残留', !/26,507/.test(JSON.stringify(st2)));
  ok('表格格替换', st2.slides[1].shapes[tblIdx].rows[1][1] === '99,999' && st2.slides[1].shapes[tblIdx].rows[1][2] === '+88%');
  ok('表格未动格保留', st2.slides[1].shapes[tblIdx].rows[1][0] === 'Slate 11');
  ok('标题未动', /墨西哥平板月报/.test(st2.slides[0].shapes.map(s => s.text).join('')));
  const flat = extractOfficeText(out);
  ok('旧模块也能读重打包zip', /31,888/.test(flat) && /99,999/.test(flat));

  // ── zip 自身闭环：readZipEntries→writeZip→readZipEntries 字节等价 ──
  const ents = readZipEntries(buf);
  const rz = readZipEntries(writeZip(ents));
  ok('zip 重打包条目数一致', rz.length === ents.length);
  ok('zip 内容逐条一致', ents.every((e, i) => rz[i].name === e.name && rz[i].data.equals(e.data)));

  try { fs.unlinkSync(tmp); } catch (e) {}
  console.log(fails ? ('FAILURES: ' + fails) : 'ALL PASS');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });

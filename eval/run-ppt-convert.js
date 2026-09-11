/* PPT→设计器工程 转换管线端到端（真模型）：
 * 造带样式三页 PPT（彩色标题/KPI文本/矩形/图片/表格）→ 深度解析 → Agent 集群转换
 * → 断言：页尺寸/文本样式搬运/图片嵌入/静态表格/数据绑定(验证过)/PptStore 存取往返。
 * 用法：node eval/run-ppt-convert.js
 */
'use strict';
const path = require('path');
const fs = require('fs');
const os = require('os');
const AD = require(path.join(__dirname, '..', 'app', 'ai-context.js'));
const OSC = require(path.join(__dirname, '..', 'app', 'office-struct-core.js'));
const CONV = require(path.join(__dirname, '..', 'app', 'ppt-convert-flow.js'));
const PptDoc = require(path.join(__dirname, '..', 'app', 'pptoutput', 'designer', 'doc-model.js'));
const PptStore = require(path.join(__dirname, '..', 'app', 'pptoutput', 'designer', 'store.js'));
const { mountEngine, buildRegistry } = require('./engine-tools.js');

let KEY = '';
try { KEY = fs.readFileSync(path.join(__dirname, 'deepseek.key'), 'utf8').trim(); } catch (e) {}
async function chat(req) {
  try {
    const r = await fetch('https://api.deepseek.com/v1/chat/completions', {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + KEY },
      body: JSON.stringify({ model: 'deepseek-chat', temperature: 0.1, stream: false, max_tokens: req.maxTokens || 2500, messages: [{ role: 'system', content: req.system }].concat(req.messages || []) }),
    });
    if (!r.ok) return { error: 'HTTP ' + r.status };
    const j = await r.json();
    return { content: (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '' };
  } catch (e) { return { error: String((e && e.message) || e) }; }
}

let fails = 0;
const ok = (n, c) => { console.log((c ? 'PASS ' : 'FAIL ') + n); if (!c) fails++; };
const PX = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

(async () => {
  // ── 1) 造带样式的三页 PPT ──
  const PptxGenJS = require('pptxgenjs');
  const p = new PptxGenJS();
  p.defineLayout({ name: 'W', width: 13.333, height: 7.5 }); p.layout = 'W';
  const s1 = p.addSlide();
  s1.addText('拉美平板经营月报', { x: 0.8, y: 0.4, w: 10, h: 0.9, fontSize: 30, bold: true, color: 'C7000B', fontFace: '微软雅黑', align: 'left' });
  s1.addShape('rect', { x: 0.8, y: 1.6, w: 5.4, h: 1.6, fill: { color: 'F7F8FA' }, line: { color: 'CBD2DA', width: 1 } });
  s1.addText('墨西哥累计SO：26,507台', { x: 1.0, y: 2.0, w: 5.0, h: 0.7, fontSize: 20, bold: true, color: '1A1A1A' });
  s1.addImage({ data: PX, x: 11.5, y: 0.4, w: 1, h: 1 });
  const s2 = p.addSlide();
  s2.addText('分系列明细', { x: 0.8, y: 0.4, w: 6, h: 0.7, fontSize: 24, bold: true, color: '1F2329' });
  s2.addTable([
    [{ text: '系列' }, { text: '累计SO' }],
    [{ text: 'Marlin' }, { text: '34,714' }],
    [{ text: 'Coral' }, { text: '25,589' }],
  ], { x: 0.8, y: 1.4, w: 8 });
  const s3 = p.addSlide();
  s3.addText('风险与行动', { x: 0.8, y: 0.4, w: 6, h: 0.7, fontSize: 24, bold: true });
  s3.addText('维持现有渠道结构，关注库存水位。', { x: 0.8, y: 1.5, w: 10, h: 0.6, fontSize: 14, color: '666666' });
  const tmp = path.join(os.tmpdir(), 'sb-conv-e2e.pptx');
  await p.writeFile({ fileName: tmp });

  // ── 2) 深度解析 ──
  const st = OSC.extractPptStructure(fs.readFileSync(tmp), { withImages: true });
  ok('解析 3 页 + 页尺寸', st.slides.length === 3 && st.page && Math.abs(st.page.w - 13.333) < 0.01);

  // ── 3) 转换（真模型 Agent 集群） ──
  const engine = await mountEngine({});
  const registry = buildRegistry(engine);
  const deps = {
    chat,
    optionsDirect: async (f) => registry.options({ field: f }),
    catalogDirect: async () => { try { return engine.catalog(); } catch (e) { return null; } },
  };
  const conv = await CONV.convert(deps, st, { name: '转换测试', onFlow: t => console.log('   ' + t) });
  const doc = conv.doc;
  ok('工程 3 页', doc.slides.length === 3);
  ok('页尺寸继承', Math.abs(doc.page.w - 13.333) < 0.01);

  const els1 = doc.slides[0].elements;
  const title = els1.find(e => e.type === 'text' && /月报/.test(e.text || ''));
  ok('标题样式搬运(30号/粗/Acme红)', !!title && title.style.fontSize === 30 && title.style.bold === true && title.style.color === 'C7000B');
  ok('矩形落 shape(填充+边框)', els1.some(e => e.type === 'shape' && e.style.fill === 'F7F8FA' && e.style.line === 'CBD2DA'));
  ok('图片嵌入 dataUrl', els1.some(e => e.type === 'image' && /^data:image\/png/.test(e.src || '')));
  const dataEl = doc.slides[0].elements.find(e => e.type === 'data');
  ok('KPI 转成活数据框(带绑定)', !!dataEl && dataEl.binding && dataEl.binding.dataset === 'psi' && !!dataEl.binding.measure);
  if (dataEl) console.log('   绑定: ' + JSON.stringify(dataEl.binding));
  const tbl = doc.slides[1].elements.find(e => e.type === 'table');
  ok('表格静态落位(3行)', !!tbl && Array.isArray(tbl.rows) && tbl.rows.length === 3 && tbl.rows[1][0] === 'Marlin');
  const t3 = doc.slides[2].elements.filter(e => e.type === 'text');
  ok('纯文字页保留静态', t3.length >= 2 && t3.every(e => !e.binding));

  // ── 4) PptStore 存取往返（打开列表可见性） ──
  const mem = {}; const storage = { getItem: k => (k in mem ? mem[k] : null), setItem: (k, v) => { mem[k] = String(v); } };
  PptStore.saveTemplate(storage, doc);
  const list = PptStore.listTemplates(storage);
  ok('存入后列表可见', list.length === 1 && list[0].name === '转换测试');
  const back = PptStore.loadTemplate(storage, doc.id);
  ok('读回工程完整', !!back && back.slides.length === 3 && JSON.stringify(back.slides[0].elements.length) === JSON.stringify(doc.slides[0].elements.length));

  console.log('   报告预览:\n' + CONV.report(conv).split('\n').map(l => '   | ' + l).join('\n'));
  // --dump <path>：把转换出的工程 JSON 落盘（供 UI 实测注入）
  const di = process.argv.indexOf('--dump');
  if (di >= 0 && process.argv[di + 1]) { fs.writeFileSync(process.argv[di + 1], JSON.stringify(doc)); console.log('DUMP=' + process.argv[di + 1]); }
  try { fs.unlinkSync(tmp); } catch (e) {}
  console.log(fails ? ('FAILURES: ' + fails) : '\n===== PPT→设计器工程 转换 ALL PASS =====');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });

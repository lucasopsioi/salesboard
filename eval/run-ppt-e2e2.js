/* PPT 模板全链实战测试 v2（真模型 + 真实感三页月报 + 表格绑定 + 产物落盘）：
 * 造 3 页月报（标题/KPI文本框/明细表格）→ learn 识别（真LLM）→ refresh 真取数
 * → 原位替换出品 → 产物写到 scratchpad 供第三方验证（py zipfile / PowerPoint COM）。
 * 用法：node eval/run-ppt-e2e2.js [--out <dir>]
 */
'use strict';
const path = require('path');
const fs = require('fs');
const O = require(path.join(__dirname, '..', 'app', 'ai-orchestrator.js'));
const AD = require(path.join(__dirname, '..', 'app', 'ai-context.js'));
const TPL = require(path.join(__dirname, '..', 'app', 'ppt-tpl-flow.js'));
const OSC = require(path.join(__dirname, '..', 'app', 'office-struct-core.js'));
const { mountEngine, buildRegistry } = require('./engine-tools.js');

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : d; };
const OUT = arg('out', path.join(__dirname, 'runs-chat'));
let KEY = '';
try { KEY = fs.readFileSync(path.join(__dirname, 'deepseek.key'), 'utf8').trim(); } catch (e) {}

async function chat(req) {
  try {
    const r = await fetch('https://api.deepseek.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + KEY },
      body: JSON.stringify({ model: 'deepseek-chat', temperature: 0.1, stream: false, max_tokens: req.maxTokens || 3000, messages: [{ role: 'system', content: req.system }].concat(req.messages || []), tools: (req.tools && req.tools.length) ? req.tools : undefined, tool_choice: (req.tools && req.tools.length) ? 'auto' : undefined }),
    });
    if (!r.ok) return { error: 'HTTP ' + r.status };
    const j = await r.json();
    const m = (j.choices && j.choices[0] && j.choices[0].message) || {};
    return { content: m.content || '', toolCalls: m.tool_calls || null };
  } catch (e) { return { error: String((e && e.message) || e) }; }
}

let fails = 0;
const ok = (n, c) => { console.log((c ? 'PASS ' : 'FAIL ') + n); if (!c) fails++; };

(async () => {
  // ── 1) 造三页真实感月报（数字故意用旧值，等刷新校正） ──
  const PptxGenJS = require('pptxgenjs');
  const pptx = new PptxGenJS();
  pptx.defineLayout({ name: 'W', width: 13.333, height: 7.5 }); pptx.layout = 'W';
  const p1 = pptx.addSlide();
  p1.addText('拉美平板产业月度经营报告', { x: 0.8, y: 2.6, w: 11.7, h: 1.0, fontSize: 36, bold: true, color: '1F2329' });
  p1.addText('销售团队 作战室 · 2026年7月版', { x: 0.8, y: 3.8, w: 8, h: 0.6, fontSize: 16, color: '666666' });
  const p2 = pptx.addSlide();
  p2.addText('核心 KPI', { x: 0.5, y: 0.35, w: 6, h: 0.7, fontSize: 24, bold: true });
  p2.addText('平板累计SO：88,888台', { x: 0.6, y: 1.5, w: 5.6, h: 0.8, fontSize: 22, bold: true, color: 'C7000B' });
  p2.addText('平板SO同比：+99.9%', { x: 6.8, y: 1.5, w: 5.4, h: 0.8, fontSize: 22, bold: true, color: 'C7000B' });
  p2.addText('墨西哥累计SO：11,111台', { x: 0.6, y: 2.7, w: 5.6, h: 0.8, fontSize: 22 });
  p2.addText('注：SO为渠道全加不去重口径', { x: 0.6, y: 6.6, w: 6, h: 0.4, fontSize: 10, color: '999999' });
  const p3 = pptx.addSlide();
  p3.addText('分系列明细', { x: 0.5, y: 0.35, w: 6, h: 0.7, fontSize: 24, bold: true });
  p3.addTable([
    [{ text: '系列', options: { bold: true } }, { text: '2026累计SO(台)', options: { bold: true } }, { text: '同比', options: { bold: true } }],
    [{ text: 'Marlin' }, { text: '77,777' }, { text: '+7.7%' }],
    [{ text: 'Coral' }, { text: '66,666' }, { text: '+6.6%' }],
  ], { x: 0.6, y: 1.4, w: 12, colW: [4, 4.5, 3.5], fontSize: 14 });
  const srcP = path.join(OUT, 'e2e2-源月报.pptx');
  fs.mkdirSync(OUT, { recursive: true });
  await pptx.writeFile({ fileName: srcP });
  const buf = fs.readFileSync(srcP);
  const st = OSC.extractPptStructure(buf);
  ok('结构 3 页', st.slides.length === 3);
  ok('第3页有表格', st.slides[2].shapes.some(s => s.type === 'table' && s.rows.length === 3));

  // ── 2) learn（真 LLM） ──
  const flow = (t) => console.log('   ' + t);
  const r1 = await TPL.learn({ chat }, st, flow);
  ok('learn 无错', !r1.error);
  if (r1.error) process.exit(1);
  const data = r1.bindings.filter(b => b.kind === 'data');
  ok('识别 ≥3 个数据字段', data.length >= 3);
  ok('表格逐格绑定列全(两数据行×两格=4)', data.some(b => b.table && b.cells && b.cells.length >= 4));
  console.log(TPL.report(r1.bindings, r1.questions).split('\n').map(l => '   | ' + l).join('\n'));

  // ── 3) 答疑（如有）──
  let bindings = r1.bindings;
  if (r1.questions.length) {
    const r2 = await TPL.refine({ chat }, bindings, '拿不准的都按 PSI 口径：平板=line 平板，系列在 series 维度，2026年初至今累计 SO；同比=对去年同期百分比；日期填数据截至日。', flow);
    if (!r2.error) bindings = r2.bindings;
    ok('refine 后无 low', !bindings.some(b => b.kind === 'data' && b.confidence === 'low'));
  } else console.log('   (零答疑)');

  // ── 4) refresh 真取数 ──
  const engine = await mountEngine({});
  const registry = buildRegistry(engine);
  const depsFactory = () => ({
    chat,
    runTool: async (n, a) => { const fn = registry[n]; return fn ? await fn(a) : { error: '未知工具: ' + n }; },
    optionsDirect: async (f) => registry.options({ field: f }),
    catalogDirect: async () => { try { return engine.catalog(); } catch (e) { return null; } },
    provRetry: false, parallel: true,
    schemas: AD.TOOL_SCHEMAS, buildToolSpecs: AD.buildToolSpecs, pickTools: AD.pickTools, parseToolCall: AD.parseToolCall,
    snapshot: async () => '', filters: () => null, boardLabel: () => '模板刷新', onProgress: () => {},
  });
  const rr = await TPL.refresh(depsFactory, { bindings }, flow);
  ok('refresh 无错', !rr.error);
  if (rr.error) process.exit(1);
  ok('替换项 ≥3', rr.repls.length >= 3);

  // ── 5) 出品 + 自读回 ──
  const outBuf = OSC.replacePptTexts(buf, rr.repls);
  const outP = path.join(OUT, 'e2e2-刷新产物.pptx');
  fs.writeFileSync(outP, outBuf);
  const st2 = OSC.extractPptStructure(outBuf);
  const flat = st2.slides.map(s => s.shapes.map(x => x.type === 'table' ? JSON.stringify(x.rows) : (x.text || '')).join(' | ')).join(' || ');
  ok('标题保留', /拉美平板产业月度经营报告/.test(flat));
  ok('旧假数据已被替换(88,888 不再出现)', !/88,?888/.test(flat));
  ok('Coral 行也被替换(66,666 不再出现)', !/66,?666/.test(flat));
  ok('回填了数字或诚实未取到', /\d{4,}|[\d,]{5,}|未取到/.test(flat));
  ok('表格系列名保留', /Marlin/.test(flat) && /Coral/.test(flat));
  const tblRows = st2.slides[2].shapes.find(s => s.type === 'table').rows;
  ok('表格同比格保留百分号格式', tblRows.slice(1).every(r => /%|未取到/.test(r[2] || '')));
  console.log('   产物页2/页3: ' + flat.split(' || ').slice(1).join(' || ').slice(0, 300));
  console.log('SRC=' + srcP);
  console.log('OUT=' + outP);
  console.log(fails ? ('FAILURES: ' + fails) : '===== 全链 ALL PASS =====');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });

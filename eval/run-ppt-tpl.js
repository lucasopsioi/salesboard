/* PPT 模板学习端到端测试（真模型）：
 * 造样例月报 pptx → 结构解析 → learn 识别数据字段（真 LLM）→ refine 模拟答疑
 * → refresh 用编排链真取数 → replacePptTexts 出品 → 读回断言新数据已落位。
 * 用法：node eval/run-ppt-tpl.js --key-file eval/deepseek.key
 */
'use strict';
const path = require('path');
const fs = require('fs');
const os = require('os');
const O = require(path.join(__dirname, '..', 'app', 'ai-orchestrator.js'));
const AD = require(path.join(__dirname, '..', 'app', 'ai-context.js'));
const TPL = require(path.join(__dirname, '..', 'app', 'ppt-tpl-flow.js'));
const OSC = require(path.join(__dirname, '..', 'app', 'office-struct-core.js'));
const { mountEngine, buildRegistry } = require('./engine-tools.js');

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : d; };
const BASE = (arg('base', 'https://api.deepseek.com/v1') || '').replace(/\/$/, '');
const MODEL = arg('model', 'deepseek-chat');
let KEY = '';
try { KEY = fs.readFileSync(path.resolve(arg('key-file', path.join(__dirname, 'deepseek.key'))), 'utf8').trim(); } catch (e) {}

async function chat(req) {
  try {
    const r = await fetch(BASE + '/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + KEY },
      body: JSON.stringify({ model: MODEL, temperature: 0.1, stream: false, max_tokens: req.maxTokens || 2000, messages: [{ role: 'system', content: req.system }].concat(req.messages || []), tools: (req.tools && req.tools.length) ? req.tools : undefined, tool_choice: (req.tools && req.tools.length) ? 'auto' : undefined }),
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
  // 1) 造样例月报（数字与样例引擎一致：墨西哥平板累计SO 26,507）
  const PptxGenJS = require('pptxgenjs');
  const pptx = new PptxGenJS();
  pptx.defineLayout({ name: 'W', width: 13.333, height: 7.5 }); pptx.layout = 'W';
  const s1 = pptx.addSlide();
  s1.addText('墨西哥平板 销售团队 月报', { x: 0.5, y: 0.4, w: 9, h: 0.8, fontSize: 28, bold: true });
  s1.addText('累计SO：26,507台', { x: 0.5, y: 1.8, w: 4.5, h: 0.6, fontSize: 20 });
  s1.addText('同比：+15.5%', { x: 5.5, y: 1.8, w: 3, h: 0.6, fontSize: 20 });
  s1.addText('数据截至 2026-08-17', { x: 0.5, y: 6.8, w: 4, h: 0.4, fontSize: 10 });
  const tmp = path.join(os.tmpdir(), 'sb-tpl-e2e.pptx');
  await pptx.writeFile({ fileName: tmp });
  const buf = fs.readFileSync(tmp);
  const st = OSC.extractPptStructure(buf);
  ok('结构 1 页 4 形状', st.slides.length === 1 && st.slides[0].shapes.filter(x => x.type === 'text').length === 4);

  // 2) learn：真 LLM 识别
  const flow = (t) => console.log('   ' + t);
  const r1 = await TPL.learn({ chat }, st, flow);
  ok('learn 无错', !r1.error);
  if (r1.error) { console.log(r1.error); process.exit(1); }
  const data = r1.bindings.filter(b => b.kind === 'data');
  ok('识别出 ≥2 个数据字段', data.length >= 2);
  const titleB = r1.bindings.find(b => b.shapeIdx === st.slides[0].shapes.findIndex(x => /销售团队 月报/.test(x.text || '')));
  ok('标题判为静态', !titleB || titleB.kind === 'static');
  const soB = data.find(b => /26,?507|SO/i.test((b.tmpl || '') + (b.dataDesc || '')));
  ok('SO 字段有口径描述', !!soB && !!(soB.dataDesc || '').trim());
  console.log('   报告预览:\n' + TPL.report(r1.bindings, r1.questions).split('\n').map(l => '   | ' + l).join('\n'));

  // 3) refine：模拟用户答疑（若有问题）
  let bindings = r1.bindings;
  if (r1.questions.length) {
    const ans = '所有拿不准的字段：都是 PSI 口径，墨西哥+平板过滤，2026年初至今累计；同比 = 与去年同期比的百分比。';
    const r2 = await TPL.refine({ chat }, bindings, ans, flow);
    ok('refine 无错', !r2.error);
    if (!r2.error) {
      bindings = r2.bindings;
      ok('答疑后无 low 项', !bindings.some(b => b.kind === 'data' && b.confidence === 'low'));
    }
  } else { console.log('   (无待确认问题，跳过 refine)'); }

  // 4) refresh：编排链真取数（评测样例数据）
  const engine = await mountEngine({});
  const registry = buildRegistry(engine);
  const depsFactory = () => ({
    chat,
    runTool: async (n, a) => { const fn = registry[n]; return fn ? await fn(a) : { error: '未知工具: ' + n }; },
    optionsDirect: async (f) => registry.options({ field: f }),
    catalogDirect: async () => { try { return engine.catalog(); } catch (e) { return null; } },
    provRetry: false,
    schemas: AD.TOOL_SCHEMAS, buildToolSpecs: AD.buildToolSpecs, pickTools: AD.pickTools, parseToolCall: AD.parseToolCall,
    snapshot: async () => '', filters: () => null, boardLabel: () => '模板刷新（测试）', onProgress: () => {},
  });
  const meta = { bindings };
  const rr = await TPL.refresh(depsFactory, meta, flow);
  ok('refresh 无错', !rr.error);
  if (rr.error) { console.log(rr.error); process.exit(1); }
  ok('产出替换项 ≥2', rr.repls.length >= 2);

  // 5) 应用替换 → 读回验证
  const out = OSC.replacePptTexts(buf, rr.repls);
  const st2 = OSC.extractPptStructure(out);
  const flat = st2.slides[0].shapes.map(x => x.text || '').join(' | ');
  console.log('   刷新后各形状: ' + flat.slice(0, 220));
  ok('标题保留', /销售团队 月报/.test(flat));
  ok('SO 数字已回填(真值26,507或未取到)', /26,?507|未取到/.test(flat));
  ok('无原文残留孤儿花括号', !/\{v\}/.test(flat));

  try { fs.unlinkSync(tmp); } catch (e) {}
  console.log(fails ? ('FAILURES: ' + fails) : '\n===== PPT 模板端到端 ALL PASS =====');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });

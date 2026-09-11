/* 图表绑定+核数闸端到端（真模型+样例引擎）：
 * 图表A：数值=引擎真值（平板逐月SO）→ 应自动绑定成功（核数通过）
 * 图表B：数值编造 → 必须被核数闸拦下，保持静态并列问题
 * 用法：node eval/run-chart-bind.js
 */
'use strict';
const path = require('path');
const fs = require('fs');
const os = require('os');
const OSC = require(path.join(__dirname, '..', 'app', 'office-struct-core.js'));
const CONV = require(path.join(__dirname, '..', 'app', 'ppt-convert-flow.js'));
const { mountEngine, buildRegistry } = require('./engine-tools.js');

let KEY = '';
try { KEY = fs.readFileSync(path.join(__dirname, 'deepseek.key'), 'utf8').trim(); } catch (e) {}
async function chat(req) {
  try {
    const r = await fetch('https://api.deepseek.com/v1/chat/completions', {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + KEY },
      body: JSON.stringify({ model: 'deepseek-chat', temperature: 0.1, stream: false, max_tokens: req.maxTokens || 1000, messages: [{ role: 'system', content: req.system }].concat(req.messages || []) }),
    });
    if (!r.ok) return { error: 'HTTP ' + r.status };
    const j = await r.json();
    return { content: (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '' };
  } catch (e) { return { error: String((e && e.message) || e) }; }
}
let fails = 0;
const ok = (n, c) => { console.log((c ? 'PASS ' : 'FAIL ') + n); if (!c) fails++; };

(async () => {
  const engine = await mountEngine({});
  const registry = buildRegistry(engine);
  // ── 取引擎真值：平板 2026 1-6月逐月 SO（按产线堆叠取「平板」行） ──
  const q = await registry.query({ stackDim: 'line', metric: 'sellOut', gran: 'month', from: '2026-01-01', to: '2026-06-30', filters: { line: ['平板'] } });
  const key = Object.keys(q.data).find(k => /平板/.test(k));
  const cats = (q.buckets||q.cats).slice(0, 6);
  const truth = cats.map(c => +q.data[key][c] || 0);
  console.log('引擎真值 平板SO(' + key + '): ' + cats.join('/') + ' = ' + truth.join(','));

  // ── 造双图表 pptx：A=真值；B=编造 ──
  const PptxGenJS = require('pptxgenjs');
  const p = new PptxGenJS();
  p.defineLayout({ name: 'W', width: 13.333, height: 7.5 }); p.layout = 'W';
  const s = p.addSlide();
  const labels = cats.map(c => (+String(c).slice(5, 7)) + '月');
  s.addChart(p.ChartType.bar, [{ name: '平板', labels, values: truth }], { x: 0.5, y: 0.6, w: 6, h: 3.5, barDir: 'col', chartColors: ['C7000B'] });
  s.addChart(p.ChartType.bar, [{ name: '平板', labels, values: truth.map(v => Math.round(v * 1.8 + 500)) }], { x: 7, y: 0.6, w: 6, h: 3.5, barDir: 'col', chartColors: ['2E75B6'] });
  const tmp = path.join(os.tmpdir(), 'sb-chartbind.pptx');
  await p.writeFile({ fileName: tmp });

  // ── 转换（带模型+引擎取数通道） ──
  const st = OSC.extractPptStructure(fs.readFileSync(tmp));
  ok('解析出 2 个图表', st.slides[0].shapes.filter(x => x.chart).length === 2);
  const deps = {
    chat,
    runTool: async (n, a) => { const fn = registry[n]; return fn ? await fn(a) : { error: '未知工具: ' + n }; },
    optionsDirect: async (f) => registry.options({ field: f }),
    catalogDirect: async () => { try { return engine.catalog(); } catch (e) { return null; } },
  };
  const conv = await CONV.convert(deps, st, { name: '图表绑定测试', onFlow: t => console.log('   ' + t) });
  const chartEls = conv.doc.slides[0].elements.filter(e => e.type === 'chart');
  ok('2 个 chart 元素', chartEls.length === 2);
  const bound = chartEls.filter(e => e.binding && e.binding.measure);
  const staticC = chartEls.filter(e => !e.binding);
  ok('真值图表自动绑定成功(恰1个)', bound.length === 1);
  if (bound[0]) {
    console.log('   绑定: ' + JSON.stringify(bound[0].binding));
    ok('绑定口径正确(psi+sellOut)', bound[0].binding.dataset === 'psi' && bound[0].binding.measure === 'sellOut');
    ok('活图表保留静态兜底数据', Array.isArray(bound[0].data && bound[0].data.cats));
  }
  ok('编数图表被核数闸拦下(保持静态)', staticC.length === 1);
  ok('拦截进待确认问题(含差异样本)', conv.questions.some(x => /图表/.test(x.text) && /对不上|命中率/.test(x.question)));
  const qq = conv.questions.find(x => /图表/.test(x.text));
  if (qq) console.log('   问题: ' + qq.question.slice(0, 180));

  try { fs.unlinkSync(tmp); } catch (e) {}
  console.log(fails ? ('FAILURES: ' + fails) : '\n===== 图表绑定+核数闸 ALL PASS =====');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });

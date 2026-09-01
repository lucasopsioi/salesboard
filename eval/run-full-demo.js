/* 全链实战（用户 2026-09-01 令）：造「带图表且与 PSI 数据一致」的 PPT → DeepSeek 建数据接口
 * → 核数闸 → 生成 PPT Output 工程 → dump（图表静态兜底数据篡改为哨兵值 1，供 UI 实测证明走的是活接口）
 * 用法：node eval/run-full-demo.js --dump <path>
 */
'use strict';
const path = require('path');
const fs = require('fs');
const os = require('os');
const OSC = require(path.join(__dirname, '..', 'app', 'office-struct-core.js'));
const CONV = require(path.join(__dirname, '..', 'app', 'ppt-convert-flow.js'));
const { mountEngine, buildRegistry } = require('./engine-tools.js');
const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : d; };

let KEY = '';
try { KEY = fs.readFileSync(path.join(__dirname, 'deepseek.key'), 'utf8').trim(); } catch (e) {}
async function chat(req) {
  try {
    const r = await fetch('https://api.deepseek.com/v1/chat/completions', {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + KEY },
      body: JSON.stringify({ model: 'deepseek-chat', temperature: 0.1, stream: false, max_tokens: req.maxTokens || 1500, messages: [{ role: 'system', content: req.system }].concat(req.messages || []) }),
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
  // ── PSI 真值：平板/音频两产线 2026 1-6 月逐月 SO；墨西哥平板累计 SO ──
  const q = await registry.query({ stackDim: 'line', metric: 'sellOut', gran: 'month', from: '2026-01-01', to: '2026-06-30', filters: {} });
  const buckets = (q.buckets || []).slice(0, 6);
  const lines = Object.keys(q.data);
  const seriesTruth = lines.map(l => ({ name: l, values: buckets.map(b => +q.data[l][b] || 0) }));
  console.log('PSI 真值(' + buckets.join('/') + '):');
  seriesTruth.forEach(s => console.log('   ' + s.name + ' = ' + s.values.join(',')));
  const rep = await registry.report({ groupDim: 'country', filters: { line: ['平板'] } });
  const mx = (rep.rows || []).find(r => /墨西哥/.test(String(r.key || r.label || '')));
  const mxSo = mx ? Math.round(+mx.cumCur) : 26507;
  console.log('   墨西哥平板累计SO = ' + mxSo);

  // ── 造 PPT：标题 + KPI 文本 + 双系列柱图(真值) + 表格 ──
  const PptxGenJS = require('pptxgenjs');
  const p = new PptxGenJS();
  p.defineLayout({ name: 'W', width: 13.333, height: 7.5 }); p.layout = 'W';
  const s1 = p.addSlide();
  s1.addText('拉美平板&音频 2026 上半年经营看板', { x: 0.6, y: 0.35, w: 11, h: 0.8, fontSize: 26, bold: true, color: 'C7000B', fontFace: '微软雅黑' });
  s1.addShape('rect', { x: 0.6, y: 1.4, w: 4.2, h: 1.3, fill: { color: 'FFF1F1' }, line: { color: 'C7000B', width: 1 } });
  s1.addText('墨西哥平板累计SO：' + mxSo.toLocaleString() + '台', { x: 0.8, y: 1.7, w: 3.9, h: 0.7, fontSize: 18, bold: true, color: '1A1A1A' });
  const labels = buckets.map(b => (+b.slice(5, 7)) + '月');
  s1.addChart(p.ChartType.bar, seriesTruth.map(s => ({ name: s.name, labels, values: s.values })), {
    x: 5.2, y: 1.3, w: 7.6, h: 4.2, barDir: 'col', chartColors: ['C7000B', '8A9099'], showLegend: true, legendPos: 'b', showTitle: true, title: '2026 上半年逐月 Sell-out（台）',
  });
  s1.addTable([
    [{ text: '产线' }, { text: '1-6月累计SO' }],
    ...seriesTruth.map(s => [{ text: s.name }, { text: s.values.reduce((a, b) => a + b, 0).toLocaleString() }]),
  ], { x: 0.6, y: 3.2, w: 4.2, fontSize: 12 });
  const tmp = path.join(os.tmpdir(), 'sb-full-demo.pptx');
  await p.writeFile({ fileName: tmp });
  const st = OSC.extractPptStructure(fs.readFileSync(tmp), { withImages: true });
  ok('解析：1 页含图表', st.slides[0].shapes.some(x => x.chart));

  // ── DeepSeek 转换（模型建接口 + 核数闸） ──
  const deps = {
    chat,
    runTool: async (n, a) => { const fn = registry[n]; return fn ? await fn(a) : { error: '未知工具: ' + n }; },
    optionsDirect: async (f) => registry.options({ field: f }),
    catalogDirect: async () => { try { return engine.catalog(); } catch (e) { return null; } },
  };
  const conv = await CONV.convert(deps, st, { name: '经营看板-全链demo', onFlow: t => console.log('   ' + t) });
  const doc = conv.doc;
  doc.id = 'pfulldemo1';
  const chartEl = doc.slides[0].elements.find(e => e.type === 'chart');
  ok('图表元素存在', !!chartEl);
  ok('图表自动绑定 PSI 接口(核数通过)', !!(chartEl && chartEl.binding && chartEl.binding.dataset === 'psi' && chartEl.binding.measure === 'sellOut'));
  if (chartEl && chartEl.binding) console.log('   图表绑定: ' + JSON.stringify(chartEl.binding));
  ok('图表系列色保留(Acme红)', !!(chartEl && chartEl.chart.fmt.colors && Object.values(chartEl.chart.fmt.colors).indexOf('C7000B') >= 0));
  const dataEl = doc.slides[0].elements.find(e => e.type === 'data');
  ok('KPI 转活数据框(绑定 psi)', !!(dataEl && dataEl.binding && dataEl.binding.dataset === 'psi'));
  if (dataEl) console.log('   KPI 绑定: ' + JSON.stringify(dataEl.binding));
  ok('表格落位', doc.slides[0].elements.some(e => e.type === 'table' && e.rows && e.rows.length === 3));
  console.log(CONV.report(conv).split('\n').map(l => '   | ' + l).join('\n'));

  // ── 哨兵：把图表静态兜底数据全改成 1 —— UI 若渲染出真值，即证明走的是活接口 ──
  if (chartEl && chartEl.data) chartEl.data.series.forEach(s => { s.values = s.values.map(() => 1); });
  const dumpAt = arg('dump', '');
  if (dumpAt) {
    fs.writeFileSync(dumpAt, JSON.stringify(doc));
    fs.writeFileSync(dumpAt.replace(/\.json$/, '-truth.json'), JSON.stringify({ buckets, seriesTruth, mxSo }));
    console.log('DUMP=' + dumpAt);
  }
  try { fs.unlinkSync(tmp); } catch (e) {}
  console.log(fails ? ('FAILURES: ' + fails) : '\n===== 全链 demo（造PPT→模型建接口→核数→工程）ALL PASS =====');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });

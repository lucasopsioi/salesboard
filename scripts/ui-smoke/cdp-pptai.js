/* PPT Output 对话式改图实测（2026-09-07 用户需求）
 *  Q1 工具栏有「打开本地 PPT」，右栏有「AI 修改」区
 *  Q2 载入一份真实 pptx（走 pptStructure + PptConvert）→ 画布上有元素（实时预览）
 *  Q3 选中一个元素 → AI 区提示「只改它」
 *  Q4 真调 DeepSeek：说「标题改成红色、字号大一点」→ 元素真的变了
 *  Q5 受保护字段防线：模型若想改 binding/id/type 一律拒绝
 * 用法：node cdp-pptai.js --prep 造 pptx；起测试实例后 node cdp-pptai.js */
'use strict';
const fs = require('fs'); const path = require('path'); const os = require('os');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let fails = 0; const ok = (n, c, extra) => { console.log((c ? 'PASS ' : 'FAIL ') + n + (!c && extra ? '  << ' + extra : '')); if (!c) fails++; };
const WS = path.join(os.tmpdir(), 'sb-pptai');
const PPTX = path.join(WS, 'deck.pptx');
const KEY = fs.readFileSync('D:/workspace/Salesboard/eval/deepseek.key', 'utf8').trim();

async function prep() {
  fs.rmSync(WS, { recursive: true, force: true }); fs.mkdirSync(WS, { recursive: true });
  const PptxGenJS = require('D:/workspace/Salesboard/node_modules/pptxgenjs');
  const p = new PptxGenJS(); p.defineLayout({ name: 'W', width: 13.333, height: 7.5 }); p.layout = 'W';
  const s = p.addSlide();
  s.addText('2027 拉美平板 销售团队 综述', { x: 0.8, y: 0.6, w: 8, h: 0.9, fontSize: 28, bold: true, color: '1A1A1A' });
  s.addText('墨西哥 Q1 主推 Slate 11，渠道 Mercantil + Casona', { x: 0.8, y: 1.8, w: 9, h: 0.6, fontSize: 14, color: '5A5F66' });
  s.addText('秘鲁：Andina Retail 独家首发，目标 12500 台', { x: 0.8, y: 2.6, w: 9, h: 0.6, fontSize: 14, color: '5A5F66' });
  await p.writeFile({ fileName: PPTX });
  console.log('fixture ready: ' + PPTX);
}
if (process.argv.indexOf('--prep') >= 0) { prep().then(() => process.exit(0)); } else (async () => {
  let target = null;
  for (let i = 0; i < 30 && !target; i++) { try { const l = await (await fetch('http://127.0.0.1:9224/json')).json(); target = l.find(t => t.type === 'page' && /index\.html/.test(t.url || '')); } catch (e) {} if (!target) await sleep(1000); }
  if (!target) { console.log('FAIL 连不上 CDP'); process.exit(1); }
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let mid = 0; const pend = new Map();
  ws.onmessage = (ev) => { try { const m = JSON.parse(ev.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } if (m.method === 'Page.javascriptDialogOpening') ws.send(JSON.stringify({ id: ++mid, method: 'Page.handleJavaScriptDialog', params: { accept: true } })); } catch (e) {} };
  const send = (m, p, t) => new Promise(res => { const id = ++mid; pend.set(id, res); ws.send(JSON.stringify({ id, method: m, params: p || {} })); setTimeout(() => { if (pend.has(id)) { pend.delete(id); res({}); } }, t || 60000); });
  const ev = async (e, t) => { const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }, t); if (r.result && r.result.exceptionDetails) return { err: String((r.result.exceptionDetails.exception || {}).description || '').slice(0, 300) }; return { v: r.result && r.result.result ? r.result.result.value : null }; };
  const shot = async (n) => { try { await send('Page.bringToFront'); const r = await send('Page.captureScreenshot', { format: 'png' }); if (r.result && r.result.data) fs.writeFileSync(path.join(__dirname, n), Buffer.from(r.result.data, 'base64')); } catch (e) {} };
  await new Promise(r => { ws.onopen = r; });
  await send('Runtime.enable'); await send('Page.enable');
  for (let i = 0; i < 30; i++) { if ((await ev("typeof switchView==='function'")).v === true) break; await sleep(1000); }
  await ev("(function(){ window.alert=function(m){window.__a=m;}; window.confirm=function(){return true;}; const l=document.getElementById('loading'); if(l) l.classList.add('hidden'); return 1; })()");
  await ev("(function(){ const c=Object.assign({}, (window.AIPanel.loadCfg&&window.AIPanel.loadCfg())||{}, {provider:'deepseek', dsModel:'deepseek-chat', dsKey:" + JSON.stringify(KEY) + "}); window.AIPanel.saveCfg(c); return 1; })()");
  await ev("switchView('pptoutput'); 1");
  // 设计器骨架是懒构建的，轮询等它出现（固定 sleep 会误判成「功能没上」）
  for (let i = 0; i < 20; i++) { const r = await ev("!!document.getElementById('pdBtnOpenLocal')"); if (r.v === true) break; await sleep(1000); }
  const ui = await ev("JSON.stringify({open:!!document.getElementById('pdBtnOpenLocal'), ai:!!document.getElementById('pdAiRun'), scope:(document.getElementById('pdAiScope')||{}).textContent||''})");
  let U = {}; try { U = JSON.parse(ui.v); } catch (e) {}
  ok('Q1 有「打开本地 PPT」与「AI 修改」区', U.open === true && U.ai === true, JSON.stringify(U));

  // Q2 载入真实 pptx（绕过文件选择框，直接走同一条转换链）
  const load = await ev("(async function(){ const st=await api.pptStructure(" + JSON.stringify(PPTX) + ");"
    + " if(!st||st.error) return JSON.stringify({err:(st&&st.error)||'解析失败'});"
    + " const deps=window.AIPanel.makeOrchDeps(window.AIPanel.loadCfg(), function(){});"
    + " const conv=await window.PptConvert.convert(deps, st, {name:'deck', onFlow:function(){}});"
    + " if(!conv||!conv.doc) return JSON.stringify({err:'未生成设计稿'});"
    + " PD.doc=conv.doc; PD.curSlide=0; pdHistInit(); pdRenderCanvas(); pdSelect(null);"
    + " const sl=PD.doc.slides[0];"
    + " return JSON.stringify({pages:PD.doc.slides.length, els:(sl.elements||[]).length, texts:(sl.elements||[]).filter(e=>e.text).map(e=>String(e.text).slice(0,20)).slice(0,3)}); })()", 240000);
  let L = {}; try { L = JSON.parse(load.v); } catch (e) {}
  ok('Q2 打开本地 PPT 并转成可编辑设计稿', (L.els || 0) >= 2, JSON.stringify(L) + (load.err || ''));
  console.log('   载入: ' + JSON.stringify(L));
  const painted = await ev("document.querySelectorAll('#pdPage .pd-el, #pdPage [data-elid]').length");
  ok('Q2 画布上真的画出了元素（实时预览）', (+painted.v || 0) >= 1, 'painted=' + painted.v);

  // Q3 选中标题元素
  const pick = await ev("(function(){ const sl=PD.doc.slides[0]; const el=(sl.elements||[]).find(e=>/销售团队/.test(String(e.text||''))) || sl.elements[0];"
    + " pdSelect(el.id); return JSON.stringify({id:el.id, before:{color:(el.style||{}).color, fontSize:(el.style||{}).fontSize, text:String(el.text||'').slice(0,24)}}); })()");
  let K = {}; try { K = JSON.parse(pick.v); } catch (e) {}
  await sleep(400);
  const scope = await ev("(document.getElementById('pdAiScope')||{}).textContent||''");
  ok('Q3 选中后 AI 区显示「只改它」', /只改它/.test(scope.v || ''), scope.v);
  console.log('   选中: ' + JSON.stringify(K));

  // Q4 真调模型改这个元素
  await ev("(function(){ const t=document.getElementById('pdAiInput'); t.value='把这个标题改成Acme红 C7000B，字号调大到 36'; return 1; })()");
  await ev("document.getElementById('pdAiRun').click(); 1");
  let after = null;
  for (let i = 0; i < 60; i++) {
    await sleep(2000);
    const st = await ev("(function(){ const b=document.getElementById('pdAiRun'); return b && b.disabled ? 'busy' : 'idle'; })()");
    if (st.v === 'idle') break;
  }
  const res = await ev("(function(){ const sl=PD.doc.slides[0]; const el=sl.elements.find(x=>x.id===" + JSON.stringify(K.id || '') + ");"
    + " const log=(document.getElementById('pdAiLog')||{}).textContent||'';"
    + " return JSON.stringify({color:(el&&el.style||{}).color, fontSize:(el&&el.style||{}).fontSize, text:String((el||{}).text||'').slice(0,24), log:log.slice(-260)}); })()");
  try { after = JSON.parse(res.v); } catch (e) {}
  console.log('   改后: ' + JSON.stringify(after));
  ok('Q4 元素颜色被改成 C7000B', after && String(after.color || '').toUpperCase() === 'C7000B', JSON.stringify(after));
  ok('Q4 字号被调大', after && +after.fontSize >= 30, String(after && after.fontSize));
  ok('Q4 文字没被顺手改掉', after && /销售团队/.test(after.text || ''), after && after.text);
  ok('Q4 进展日志里有「已应用」', /已应用/.test((after && after.log) || ''), (after && after.log || '').slice(-120));
  await shot('ui-pptai-edited.png');

  // Q5 受保护字段
  const guard = await ev("(function(){ const sl=PD.doc.slides[0]; const el=sl.elements[0];"
    + " const p=window.PptAiEdit.sanitize({ops:[{id:el.id,set:{binding:{metric:'rev'},type:'image',fontSize:20}}]}, sl, PD.doc.page);"
    + " return JSON.stringify({hasBinding:('binding' in (p.ops[0]&&p.ops[0].set||{})), hasType:('type' in (p.ops[0]&&p.ops[0].set||{})), rejected:p.rejected.length}); })()");
  let G = {}; try { G = JSON.parse(guard.v); } catch (e) {}
  ok('Q5 binding/type 被防线拒绝', G.hasBinding === false && G.hasType === false && (G.rejected || 0) >= 2, JSON.stringify(G));

  await ev("(function(){ const c=window.AIPanel.loadCfg()||{}; delete c.dsKey; window.AIPanel.saveCfg(c); return 1; })()");
  ws.close(); console.log(fails ? ('FAILURES: ' + fails) : '===== PPT 对话改图 ALL PASS ====='); process.exit(fails ? 1 : 0);
})().catch(e => { console.log('FAIL 异常: ' + e.message); process.exit(1); });

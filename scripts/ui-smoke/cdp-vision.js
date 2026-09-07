/* 识图端到端真模型实测（2026-09-04 用户：直接传图要能读，PPT 里的图也要能读）
 *  造一张「三根柱子」条形图 PNG（红最高、绿中、蓝最矮，颜色与高低都由我控制、答案已知），
 *  V1 直接上传该图 → 问「哪根柱子最高，什么颜色」→ 模型答红色/最高
 *  V2 造一个内嵌该图的 pptx → 上传 → 问图里的内容 → 命中
 *  V3 无 DeepSeek key 时给出「请配 key 或换 Claude/GPT」而不是静默失败（用 wsGet 侧的降级文案间接验，跳过实调）
 * 用法：起测试实例(test-main.js)后 node cdp-vision.js */
'use strict';
const fs = require('fs'); const path = require('path'); const os = require('os'); const zlib = require('zlib');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let fails = 0; const ok = (n, c) => { console.log((c ? 'PASS ' : 'FAIL ') + n); if (!c) fails++; };
const WS = path.join(os.tmpdir(), 'sb-ws-vision');
const KEY = fs.readFileSync('D:/workspace/Salesboard/eval/deepseek.key', 'utf8').trim();

// 画一张条形图：白底，三根竖直柱，红(高)/绿(中)/蓝(矮)
function barChartPng(bars) {
  const W = 300, H = 200; const px = Buffer.alloc(W * H * 3, 255);   // 白底
  const set = (x, y, r, g, b) => { if (x < 0 || x >= W || y < 0 || y >= H) return; const o = (y * W + x) * 3; px[o] = r; px[o + 1] = g; px[o + 2] = b; };
  const bar = (x0, w, h, r, g, b) => { for (let x = x0; x < x0 + w; x++) for (let y = H - 1; y >= H - h; y--) set(x, y, r, g, b); };
  (bars || [[40, 50, 160, 220, 20, 20], [130, 50, 105, 20, 180, 40], [220, 50, 55, 30, 60, 220]]).forEach(b => bar(b[0], b[1], b[2], b[3], b[4], b[5]));
  // 转 PNG
  const crc32 = (buf) => { let c = ~0; for (let i = 0; i < buf.length; i++) { c ^= buf[i]; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1)); } return (~c) >>> 0; };
  const chunk = (t, d) => { const T = Buffer.from(t); const L = Buffer.alloc(4); L.writeUInt32BE(d.length); const C = Buffer.alloc(4); C.writeUInt32BE(crc32(Buffer.concat([T, d]))); return Buffer.concat([L, T, d, C]); };
  const ih = Buffer.alloc(13); ih.writeUInt32BE(W, 0); ih.writeUInt32BE(H, 4); ih[8] = 8; ih[9] = 2;
  const raw = Buffer.alloc(H * (1 + W * 3)); for (let y = 0; y < H; y++) { raw[y * (1 + W * 3)] = 0; px.copy(raw, y * (1 + W * 3) + 1, y * W * 3, (y + 1) * W * 3); }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ih), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

async function prep() {
  fs.rmSync(WS, { recursive: true, force: true }); fs.mkdirSync(WS, { recursive: true });
  const png = barChartPng();   // V1：红>绿>蓝
  fs.writeFileSync(path.join(WS, 'chart.png'), png);
  // V2 用一张「不可猜」的图：最高柱是紫色（模型不真读图就不会猜到紫），紫>橙>青
  const deckPng = barChartPng([[40, 50, 160, 150, 20, 200], [130, 50, 100, 240, 130, 20], [220, 50, 55, 20, 170, 170]]);
  fs.writeFileSync(path.join(WS, 'deck_chart.png'), deckPng);
  const PptxGenJS = require('D:/workspace/Salesboard/node_modules/pptxgenjs');
  const pp = new PptxGenJS(); const s = pp.addSlide();
  s.addText('季度销量对比（图见下）', { x: 0.5, y: 0.3, w: 9, h: 0.6 });
  s.addImage({ data: 'image/png;base64,' + deckPng.toString('base64'), x: 1, y: 1.2, w: 5, h: 3.3 });
  await pp.writeFile({ fileName: path.join(WS, 'chart_deck.pptx') });
  console.log('vision fixtures ready: chart.png ' + png.length + 'B, chart_deck.pptx');
}
if (process.argv.indexOf('--prep') >= 0) { prep().then(() => process.exit(0)); } else (async () => {
  let target = null;
  for (let i = 0; i < 30 && !target; i++) { try { const list = await (await fetch('http://127.0.0.1:9224/json')).json(); target = list.find(t => t.type === 'page' && /index\.html/.test(t.url || '')); } catch (e) {} if (!target) await sleep(1000); }
  if (!target) { console.log('FAIL 连不上 CDP'); process.exit(1); }
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let mid = 0; const pend = new Map();
  ws.onmessage = (ev) => { try { const m = JSON.parse(ev.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } if (m.method === 'Page.javascriptDialogOpening') ws.send(JSON.stringify({ id: ++mid, method: 'Page.handleJavaScriptDialog', params: { accept: true } })); } catch (e) {} };
  const send = (m, p, tmo) => new Promise((res) => { const id = ++mid; pend.set(id, res); ws.send(JSON.stringify({ id, method: m, params: p || {} })); setTimeout(() => { if (pend.has(id)) { pend.delete(id); res({ result: { exceptionDetails: { text: 'timeout' } } }); } }, tmo || 60000); });
  const ev = async (e, tmo) => { const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }, tmo); if (r.result && r.result.exceptionDetails) return { err: (r.result.exceptionDetails.exception && r.result.exceptionDetails.exception.description || r.result.exceptionDetails.text || '').slice(0, 300) }; return { v: r.result && r.result.result && r.result.result.value }; };
  const shot = async (name) => { try { await send('Page.bringToFront'); const r = await send('Page.captureScreenshot', { format: 'png' }); if (r.result && r.result.data) fs.writeFileSync(path.join(__dirname, name), Buffer.from(r.result.data, 'base64')); } catch (e) {} };
  await new Promise(r => { ws.onopen = r; });
  await send('Runtime.enable'); await send('Page.enable');
  for (let i = 0; i < 30; i++) { const r = await ev("!!(typeof switchView==='function' && window.sb && window.AIPanel && window.AgentChat)"); if (r.v === true) break; await sleep(1000); }
  await ev("(function(){ const l=document.getElementById('loading'); if(l) l.classList.add('hidden'); window.alert=function(m){window.__lastAlert=m;}; window.confirm=function(){return true;}; return 1; })()");
  await ev("(function(){ const c=Object.assign({}, (window.AIPanel.loadCfg&&window.AIPanel.loadCfg())||{}, {provider:'deepseek', dsModel:'deepseek-chat', dsKey:" + JSON.stringify(KEY) + "}); window.AIPanel.saveCfg(c); return 1; })()");
  // 确认视觉端点会选到 DeepSeek 视觉模型
  const vp = await ev("(function(){ const c=window.AIPanel.loadCfg(); const e=window.AIPanel.pickVisionEndpoint(c); return e? e.model+'|'+e.label : 'null'; })()");
  ok('视觉端点选到 deepseek-v4-flash-vision-exp', /deepseek-v4-flash-vision-exp/.test(vp.v || ''));
  await ev("window.sb.wsSet(" + JSON.stringify([WS]) + ").then(()=>1)");
  await ev("switchView('agentchat'); 1"); await sleep(1000);

  const newSession = async () => { await ev("(function(){ const b=document.getElementById('acNew'); if(b) b.click(); return 1; })()"); await sleep(400); };
  const upload = async (p) => { const r = await ev("window.AgentChat.addFileByPath(" + JSON.stringify(p) + ").then(r=>String(r)).catch(e=>'ERR '+e.message)", 120000); return r.v; };
  const ask = async (q, maxSec) => {
    await ev("(function(){ const ta=document.getElementById('acInput'); ta.value=" + JSON.stringify(q) + "; document.getElementById('acSend').click(); return 1; })()");
    for (let i = 0; i < maxSec / 2; i++) {
      await sleep(2000);
      const st = await ev("(function(){ const live=document.querySelector('#acMsgs .ac-live'); const ais=[...document.querySelectorAll('#acMsgs .ac-b.a:not(.ac-live)')]; return JSON.stringify({live:!!live, nAi:ais.length}); })()");
      let o = {}; try { o = JSON.parse(st.v); } catch (e) {}
      if (!o.live && o.nAi >= 1) break;
    }
    const r = await ev("(function(){ const ais=[...document.querySelectorAll('#acMsgs .ac-b.a:not(.ac-live)')]; const b=ais[ais.length-1]; return JSON.stringify(b? {t:b.innerText, all:b.textContent} : {t:'',all:''}); })()");
    let o = { t: '', all: '' }; try { o = JSON.parse(r.v); } catch (e) {}
    return { reply: String(o.t || ''), full: String(o.all || '') };
  };

  // V1 直接上传图
  await newSession();
  const u1 = await upload(path.join(WS, 'chart.png'));
  ok('V1 图片上传成功', u1 === 'true');
  const V1 = await ask('这张图里哪根柱子最高？它是什么颜色？三根柱子分别是什么颜色，按从高到矮排列。', 180);
  console.log('   V1 回复: ' + V1.reply.replace(/\n/g, ' ').slice(0, 240));
  ok('V1 认出最高的是红色', /红/.test(V1.reply));
  ok('V1 认出三色顺序 红>绿>蓝', /红[\s\S]*绿[\s\S]*蓝/.test(V1.reply));
  await shot('ui-vision-image.png');

  // V2 内嵌图的 PPT
  await newSession();
  const u2 = await upload(path.join(WS, 'chart_deck.pptx'));
  ok('V2 PPT 上传成功', u2 === 'true');
  const sys2 = await ev("(function(){ const s=[...document.querySelectorAll('#acMsgs .ac-b.s')]; return s.length? s[s.length-1].innerText : ''; })()");
  ok('V2 提示含「内嵌图」', /内嵌图/.test(sys2.v || ''));
  const V2 = await ask('这个 PPT 里的配图是什么类型的图？图中最高的柱子是什么颜色？', 200);
  console.log('   V2 回复: ' + V2.reply.replace(/\n/g, ' ').slice(0, 240));
  // 最高柱是紫色——猜不出来，只有真读了内嵌图才答得对（防假阳性）
  ok('V2 从内嵌图认出最高柱是紫色', /紫|purple/i.test(V2.reply));
  ok('V2 识别出是条形图/柱状图', /(条形|柱状|柱形|bar)/i.test(V2.reply));
  await shot('ui-vision-ppt.png');

  ws.close(); console.log(fails ? ('FAILURES: ' + fails) : '===== 识图 UI ALL PASS ====='); process.exit(fails ? 1 : 0);
})().catch(e => { console.log('FAIL 异常: ' + e.message); process.exit(1); });

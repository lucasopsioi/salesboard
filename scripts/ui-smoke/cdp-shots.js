/* 全看板截图：载入示例数据后逐个看板截全图，供设计/交互复盘。
 * 用法：起测试实例(test-main.js)后 node cdp-shots.js [outDir] */
'use strict';
const fs = require('fs'); const path = require('path');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const OUT = path.join(__dirname, process.argv[2] || 'shots');
const VIEWS = ['finance'];

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  let target = null;
  for (let i = 0; i < 30 && !target; i++) { try { const l = await (await fetch('http://127.0.0.1:9224/json')).json(); target = l.find(t => t.type === 'page' && /index\.html/.test(t.url || '')); } catch (e) {} if (!target) await sleep(1000); }
  if (!target) { console.log('FAIL 连不上 CDP'); process.exit(1); }
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let mid = 0; const pend = new Map();
  ws.onmessage = (ev) => { try { const m = JSON.parse(ev.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } if (m.method === 'Page.javascriptDialogOpening') ws.send(JSON.stringify({ id: ++mid, method: 'Page.handleJavaScriptDialog', params: { accept: true } })); } catch (e) {} };
  const send = (m, p, t) => new Promise(res => { const id = ++mid; pend.set(id, res); ws.send(JSON.stringify({ id, method: m, params: p || {} })); setTimeout(() => { if (pend.has(id)) { pend.delete(id); res({}); } }, t || 30000); });
  const ev = async (e) => { const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }); return r.result && r.result.result ? r.result.result.value : null; };
  await new Promise(r => { ws.onopen = r; });
  await send('Runtime.enable'); await send('Page.enable');
  for (let i = 0; i < 30; i++) { if (await ev("typeof switchView==='function'")) break; await sleep(1000); }
  await ev("(function(){ window.alert=function(){}; window.confirm=function(){return true;}; const l=document.getElementById('loading'); if(l) l.classList.add('hidden'); return 1; })()");
  // 载入示例数据，让看板有内容
  const loaded = await ev("(function(){ const b=[...document.querySelectorAll('button,a')].find(x=>/载入示例/.test(x.textContent||'')); if(b){ b.click(); return 'clicked'; } return 'none'; })()");
  console.log('载入示例: ' + loaded);
  for (let i = 0; i < 40; i++) { const busy = await ev("(function(){ const l=document.getElementById('loading'); return !!(l && !l.classList.contains('hidden')); })()"); if (!busy) break; await sleep(1000); }
  await sleep(2500);
  await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });
  for (const v of VIEWS) {
    try {
      await ev("switchView('" + v + "'); 1");
      await sleep(v === 'inventory' || v === 'psi' || v === 'report' ? 3200 : 1800);
      await send('Page.bringToFront');
      const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      if (r.result && r.result.data) { fs.writeFileSync(path.join(OUT, v + '.png'), Buffer.from(r.result.data, 'base64')); console.log('shot ' + v); }
      else console.log('MISS ' + v);
    } catch (e) { console.log('ERR ' + v + ' ' + e.message); }
  }
  ws.close(); console.log('done -> ' + OUT); process.exit(0);
})().catch(e => { console.log('FAIL ' + e.message); process.exit(1); });

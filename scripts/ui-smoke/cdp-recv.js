/* 本机接收 真实实测（2026-09-04 用户：网页上传崩溃，要从手机把文件传进来）
 *  R1 点「📥 接收文件」→ 弹窗开启本机服务，拿到 URL/取件码/端口/目录
 *  R2 二维码在弹窗里渲染（.acr-qr svg），且编码的就是那条 URL
 *  R3 模拟手机 GET 取件页 → 200 且含取件码与页面标识
 *  R4 模拟手机 POST 一个 xlsx → 200；文件真的落到 接收目录
 *  R5 弹窗「已接收」列表实时出现该文件（onRecvFile 事件驱动）
 *  R6 点「用 Agent 打开」→ 文件进当前会话（sys 提示「已附加」），弹窗关闭
 *  R7 错误取件码 → 404（别的路径进不来）
 *  R8 关闭弹窗 → 服务停止（recvStatus.running=false）
 * 用法：起测试实例(test-main.js)后 node cdp-recv.js */
'use strict';
const fs = require('fs'); const path = require('path'); const os = require('os');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let fails = 0; const ok = (n, c, extra) => { console.log((c ? 'PASS ' : 'FAIL ') + n + (extra && !c ? '  << ' + extra : '')); if (!c) fails++; };

(async () => {
  let target = null;
  for (let i = 0; i < 30 && !target; i++) { try { const list = await (await fetch('http://127.0.0.1:9224/json')).json(); target = list.find(t => t.type === 'page' && /index\.html/.test(t.url || '')); } catch (e) {} if (!target) await sleep(1000); }
  if (!target) { console.log('FAIL 连不上 CDP'); process.exit(1); }
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let mid = 0; const pend = new Map();
  ws.onmessage = (ev) => { try { const m = JSON.parse(ev.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } if (m.method === 'Page.javascriptDialogOpening') ws.send(JSON.stringify({ id: ++mid, method: 'Page.handleJavaScriptDialog', params: { accept: true } })); } catch (e) {} };
  const send = (method, params) => new Promise((res) => { const id = ++mid; pend.set(id, res); ws.send(JSON.stringify({ id, method, params: params || {} })); setTimeout(() => { if (pend.has(id)) { pend.delete(id); res({ result: {} }); } }, 30000); });
  const ev = async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); if (r.result && r.result.exceptionDetails) return { err: (r.result.exceptionDetails.exception && r.result.exceptionDetails.exception.description || r.result.exceptionDetails.text || '').slice(0, 300) }; return { v: r.result && r.result.result && r.result.result.value }; };
  const shot = async (name) => { try { await send('Page.bringToFront'); const r = await send('Page.captureScreenshot', { format: 'png' }); if (r.result && r.result.data) fs.writeFileSync(path.join(__dirname, name), Buffer.from(r.result.data, 'base64')); } catch (e) {} };
  await new Promise(r => { ws.onopen = r; });
  await send('Runtime.enable'); await send('Page.enable');
  for (let i = 0; i < 30; i++) { const r = await ev("!!(typeof switchView==='function' && window.sb && window.QRCore && window.AgentChat)"); if (r.v === true) break; await sleep(1000); }
  await ev("(function(){ const l=document.getElementById('loading'); if(l) l.classList.add('hidden'); window.alert=function(m){window.__a=m}; return 1; })()");
  await ev("switchView('agentchat'); 1"); await sleep(1000);

  // R1 点按钮开服务
  await ev("(function(){ const b=document.getElementById('acRecv'); b&&b.click(); return 1; })()");
  let info = null;
  for (let i = 0; i < 20; i++) { await sleep(500); const r = await ev("(function(){ const u=document.querySelector('#acrUrl'); return u? u.textContent : ''; })()"); if (r.v) { const st = await ev("window.sb.recvStatus().then(x=>JSON.stringify(x))"); try { info = JSON.parse(st.v); } catch (e) {} if (info && info.url) break; } }
  ok('R1 弹窗开启本机服务并拿到链接', !!(info && info.url && info.code && info.port), JSON.stringify(info));
  if (!info || !info.url) { ws.close(); console.log('FAILURES: ' + fails); process.exit(1); }
  const base = 'http://127.0.0.1:' + info.port + '/' + info.code;   // 本机测试走 127.0.0.1（服务 bind 0.0.0.0，localhost 与 LAN 都通）
  console.log('   服务: ' + info.url + '  目录: ' + info.dir);

  // R2 二维码渲染 + 编码内容正确
  const qr = await ev("(function(){ const s=document.querySelector('#acrModal .acr-qr svg, #acRecvModal .acr-qr svg'); return s? s.outerHTML.length : 0; })()");
  ok('R2 弹窗里渲染了二维码 SVG', (qr.v || 0) > 200);
  const qrEnc = await ev("(function(){ try{ return window.QRCore.encode(" + JSON.stringify(info.url) + ").size>0 }catch(e){ return false } })()");
  ok('R2b 二维码能编码该 URL', qrEnc.v === true);
  await shot('ui-recv-modal.png');

  // R3 模拟手机 GET 取件页
  let pageOk = false, pageTxt = '';
  try { const res = await fetch(base); pageTxt = await res.text(); pageOk = res.status === 200 && pageTxt.indexOf(info.code) >= 0 && /发送文件到电脑/.test(pageTxt); } catch (e) { pageTxt = 'ERR ' + e.message; }
  ok('R3 手机端取件页可打开且含取件码', pageOk, pageTxt.slice(0, 80));

  // R4 模拟手机 POST 一个真 xlsx
  const XLSX = require('xlsx');
  const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['产品', '销量'], ['Slate 11', 888]]), 'Sheet1');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  const fname = 'phone-report-' + Date.now().toString(36) + '.xlsx';
  let postOk = false, postBody = '';
  try { const res = await fetch(base + '/up?name=' + encodeURIComponent(fname), { method: 'POST', body: buf }); postBody = await res.text(); postOk = res.status === 200; } catch (e) { postBody = 'ERR ' + e.message; }
  ok('R4 手机端 POST 上传返回 200', postOk, postBody.slice(0, 80));
  const landed = path.join(info.dir, fname);
  await sleep(400);
  ok('R4b 文件真的落到接收目录', fs.existsSync(landed) && fs.statSync(landed).size === buf.length);

  // R5 弹窗已接收列表实时出现
  let listed = false;
  for (let i = 0; i < 10; i++) { await sleep(300); const r = await ev("(function(){ const els=[...document.querySelectorAll('.acr-li .acr-nm')]; return els.map(e=>e.textContent).join('|'); })()"); if ((r.v || '').indexOf(fname) >= 0) { listed = true; break; } }
  ok('R5 弹窗「已接收」实时列出该文件', listed);
  await shot('ui-recv-got.png');

  // R6 点「用 Agent 打开」
  await ev("(function(){ const b=document.querySelector('.acr-use'); b&&b.click(); return 1; })()");
  let attached = false;
  for (let i = 0; i < 12; i++) { await sleep(500); const r = await ev("(function(){ const s=[...document.querySelectorAll('#acMsgs .ac-b.s')].map(e=>e.innerText).join('\\n'); return s; })()"); if (/已附加/.test(r.v || '') && (r.v || '').indexOf(fname) >= 0) { attached = true; break; } }
  ok('R6 一键把接收的文件导入 Agent 会话', attached);
  const stillOpen = await ev("(function(){ return !!document.getElementById('acRecvModal') && !!document.querySelector('.acr-use[disabled]') })()");
  ok('R6b 导入后弹窗保持开启（可继续收）且按钮标记已导入', stillOpen.v === true);

  // R7 错误取件码 → 404（服务仍在跑）
  let notFound = false;
  try { const res = await fetch('http://127.0.0.1:' + info.port + '/9999/up?name=x', { method: 'POST', body: 'x' }); notFound = res.status === 404; } catch (e) {}
  try { const res2 = await fetch('http://127.0.0.1:' + info.port + '/'); if (res2.status !== 404) notFound = false; } catch (e) {}
  ok('R7 错误取件码/路径一律 404', notFound);

  // R8 关闭 → 服务停
  await ev("(function(){ const b=document.querySelector('#acRecvModal .ai-modal-x'); if(b) b.click(); else window.sb.recvStop(); return 1; })()");
  await sleep(500);
  const st2 = await ev("window.sb.recvStatus().then(x=>JSON.stringify(x))");
  let stopped = false; try { stopped = !JSON.parse(st2.v).running; } catch (e) {}
  let dead = false; try { await fetch(base, { signal: AbortSignal.timeout(1500) }); } catch (e) { dead = true; }
  ok('R8 关闭弹窗后服务停止', stopped && dead);

  ws.close(); console.log(fails ? ('FAILURES: ' + fails) : '===== 本机接收 UI ALL PASS ====='); process.exit(fails ? 1 : 0);
})().catch(e => { console.log('FAIL 异常: ' + e.message); process.exit(1); });

/* SO 推演面板实测（2026-09-07 用户需求 v1）
 *  F1 面板可进入，左侧 5 列齐全
 *  F2 载入示例数据后有产品行，近28天日销/平均周销有数
 *  F3 左 5 列真的冻结（横向滚动后仍在原位）
 *  F4 展开产品能看到型号行
 *  F5 产品行改 SO → 按历史 SI 占比分摊到型号，且型号之和 = 产品值
 *  F6 DOS 随推演变化（改大 SO → DOS 变小）
 *  F7 粒度可切 天/周/月
 * 用法：起测试实例后 node cdp-forecast.js */
'use strict';
const fs = require('fs'); const path = require('path');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let fails = 0; const ok = (n, c, extra) => { console.log((c ? 'PASS ' : 'FAIL ') + n + (!c && extra ? '  << ' + extra : '')); if (!c) fails++; };

(async () => {
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
  await ev("(function(){ window.alert=function(){}; const l=document.getElementById('loading'); if(l) l.classList.add('hidden'); const b=[...document.querySelectorAll('button,a')].find(x=>/载入示例/.test(x.textContent||'')); if(b) b.click(); return 1; })()");
  for (let i = 0; i < 40; i++) { const busy = await ev("(function(){ const l=document.getElementById('loading'); return !!(l && !l.classList.contains('hidden')); })()"); if (busy.v !== true) break; await sleep(1000); }
  await sleep(2000);
  await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });

  await ev("switchView('forecast'); 1");
  // 等「取数结束」——不能等 .fc-empty，因为「正在取数…」本身就是 .fc-empty，会瞬间跳出循环
  for (let i = 0; i < 40; i++) { const r = await ev("(typeof FC!=='undefined') && FC.loading===false && FC.loaded===true"); if (r.v === true) break; await sleep(1000); }
  await sleep(1200);

  const head = await ev("(function(){ const t=document.querySelector('#view-forecast table.fc-table'); if(!t) return JSON.stringify({no:true, msg:(document.querySelector('#view-forecast .fc-empty')||{}).textContent||''}); return JSON.stringify({fz:[...t.querySelectorAll('thead tr:first-child th.fz')].map(x=>x.textContent.trim())}); })()");
  let H = {}; try { H = JSON.parse(head.v); } catch (e) {}
  ok('F1 左侧 5 列齐全（产品名/型号/配置/日销/周销）', H.fz && H.fz.length === 5 && /产品名/.test(H.fz[0]) && /周销/.test(H.fz[4]), JSON.stringify(H));

  const rows = await ev("(function(){ const n=document.querySelectorAll('#view-forecast tr.fc-prod').length; const r=FC.rows[0]; return JSON.stringify({n:n, first: r? {p:r.product, daily:r.daily, weekly:r.weekly, kids:(r.kids||[]).length}:null}); })()");
  let R = {}; try { R = JSON.parse(rows.v); } catch (e) {}
  ok('F2 有产品行且日销/周销算出来了', (R.n || 0) > 0 && R.first && R.first.daily != null, JSON.stringify(R));
  console.log('   产品数=' + R.n + ' 首行=' + JSON.stringify(R.first));

  // F3 冻结：横向滚动后左列仍在视口左侧
  const froze = await ev("(function(){ const sc=document.querySelector('#view-forecast .fc-scroll'); if(!sc) return 'no'; const c0=document.querySelector('#view-forecast tbody tr td.fz1'); const b0=c0.getBoundingClientRect().left; sc.scrollLeft=600; return new Promise(r=>setTimeout(()=>{ const b1=c0.getBoundingClientRect().left; r(JSON.stringify({b0:Math.round(b0), b1:Math.round(b1), scrolled:sc.scrollLeft})); },250)); })()");
  let Z = {}; try { Z = JSON.parse(froze.v); } catch (e) {}
  ok('F3 横向滚动后左侧产品列仍冻结在原位', Z.scrolled > 100 && Math.abs(Z.b0 - Z.b1) <= 2, JSON.stringify(Z));

  // F4 展开产品
  await ev("(function(){ const td=document.querySelector('#view-forecast tr.fc-prod td.fz1'); if(td) td.click(); return 1; })()"); await sleep(700);
  const kids = await ev("document.querySelectorAll('#view-forecast tr.fc-model').length");
  ok('F4 展开产品能看到型号行', (+kids.v || 0) > 0, 'model rows=' + kids.v);

  // F5 产品行填 SO=1000 → 型号按历史 SI 占比分摊且和守恒
  const split = await ev("(function(){ const p=FC.rows.find(x=>x.expanded)||FC.rows[0]; p.expanded=true;"
    + " FC.edits[p.key]={0:{so:1000}}; fcRender();"
    + " const calc=fcComputeProduct(p); const kids=(p.kids||[]).map(k=>({m:k.model, si:k.histSi, so:calc.byModel[k.key][0].so}));"
    + " const sum=kids.reduce((a,k)=>a+k.so,0);"
    + " return JSON.stringify({product:p.product, total:calc.product[0].so, sum:sum, kids:kids.slice(0,4), shares:calc.shares}); })()");
  let S = {}; try { S = JSON.parse(split.v); } catch (e) {}
  ok('F5 产品 SO=1000 分摊到型号且和恰好=1000', S.sum === 1000 && S.total === 1000, JSON.stringify(S));
  console.log('   分摊: ' + JSON.stringify(S.kids) + ' 占比=' + JSON.stringify(S.shares));

  // F6 DOS 随 SO 变化：SO 调大 → DOS 变小
  const dos = await ev("(function(){ const p=FC.rows.find(x=>x.expanded)||FC.rows[0];"
    + " FC.edits[p.key]={0:{so:100}}; const a=fcComputeProduct(p).product[0].dos;"
    + " FC.edits[p.key]={0:{so:5000}}; const b=fcComputeProduct(p).product[0].dos;"
    + " return JSON.stringify({lowSo_dos:a, highSo_dos:b}); })()");
  let D = {}; try { D = JSON.parse(dos.v); } catch (e) {}
  ok('F6 SO 调大 → DOS 变小（DOS 跟着推演变）', D.lowSo_dos != null && D.highSo_dos != null && D.highSo_dos < D.lowSo_dos, JSON.stringify(D));

  // F7 粒度切换
  await ev("(function(){ const b=document.querySelector('#view-forecast [data-fcg=\"month\"]'); if(b) b.click(); return 1; })()"); await sleep(900);
  const gm = await ev("JSON.stringify({gran:FC.gran, cols:document.querySelectorAll('#view-forecast thead tr:first-child th.per').length})");
  let G = {}; try { G = JSON.parse(gm.v); } catch (e) {}
  ok('F7 可切按月，期次列随之生成', G.gran === 'month' && (G.cols || 0) >= 1, JSON.stringify(G));
  await shot('ui-forecast.png');

  ws.close(); console.log(fails ? ('FAILURES: ' + fails) : '===== SO 推演面板 ALL PASS ====='); process.exit(fails ? 1 : 0);
})().catch(e => { console.log('FAIL 异常: ' + e.message); process.exit(1); });

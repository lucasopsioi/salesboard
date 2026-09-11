/* 路标纵向叠加修复实测（2026-09-07 用户「一键导入后价位相近的产品全叠在一起，宁愿滚轮上下看」）：
 *  塞 14 个同期、价位紧挨的产品制造重叠 → 验证：绘图区长高、#rmChart 可纵向滚动、卡片不再重叠、「纵向」档位生效。
 * 纯 UI，无需 API key。用法：起测试实例(test-main.js)后 node cdp-roadmap-scroll.js */
'use strict';
const fs = require('fs'); const path = require('path');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let fails = 0; const ok = (n, c, extra) => { console.log((c ? 'PASS ' : 'FAIL ') + n + (!c && extra ? '  << ' + extra : '')); if (!c) fails++; };

// 14 个平板：同一上市月、价格 300..365 step 5（价位紧挨 → 在 540px 里必然重叠）
const crowded = [];
for (let i = 0; i < 14; i++) crowded.push({
  id: 'x' + i, name: '挤挤 ' + i, category: '平板', seriesGroup: 'Series X', internalCode: 'X' + i, certModel: 'X' + i, predecessorId: '',
  compositeRrpUsd: 300 + i * 5, shipEarly: '2026/03/01', shipLate: '2026/03/15', salesEnd: '', eom: '',
  skus: [{ name: 'X' + i + '-B', color: '#333', ean: '', ram: '8GB', rom: '256GB', chip: 'X', matte: false, bom: '' }],
  packaging: [], accessories: {}, sellingPoints: [], pricing: [],
});

(async () => {
  let target = null;
  for (let i = 0; i < 30 && !target; i++) { try { const list = await (await fetch('http://127.0.0.1:9224/json')).json(); target = list.find(t => t.type === 'page' && /index\.html/.test(t.url || '')); } catch (e) {} if (!target) await sleep(1000); }
  if (!target) { console.log('FAIL 连不上 CDP'); process.exit(1); }
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let mid = 0; const pend = new Map();
  ws.onmessage = (ev) => { try { const m = JSON.parse(ev.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } if (m.method === 'Page.javascriptDialogOpening') ws.send(JSON.stringify({ id: ++mid, method: 'Page.handleJavaScriptDialog', params: { accept: true } })); } catch (e) {} };
  const send = (m, p, tmo) => new Promise((res) => { const id = ++mid; pend.set(id, res); ws.send(JSON.stringify({ id, method: m, params: p || {} })); setTimeout(() => { if (pend.has(id)) { pend.delete(id); res({ result: { exceptionDetails: { text: 'timeout' } } }); } }, tmo || 30000); });
  const ev = async (e) => { const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }); if (r.result && r.result.exceptionDetails) return { err: (r.result.exceptionDetails.exception && r.result.exceptionDetails.exception.description || r.result.exceptionDetails.text || '').slice(0, 300) }; return { v: r.result && r.result.result && r.result.result.value }; };
  const shot = async (name) => { try { await send('Page.bringToFront'); const r = await send('Page.captureScreenshot', { format: 'png' }); if (r.result && r.result.data) fs.writeFileSync(path.join(__dirname, name), Buffer.from(r.result.data, 'base64')); } catch (e) {} };
  await new Promise(r => { ws.onopen = r; });
  await send('Runtime.enable'); await send('Page.enable');
  for (let i = 0; i < 30; i++) { const r = await ev("!!(typeof switchView==='function')"); if (r.v === true) break; await sleep(1000); }
  // 种入拥挤产品 + 复位纵向为自动，然后刷新让路标重新加载
  await ev("(function(){ localStorage.setItem('sb.roadmap.products.v1', JSON.stringify({products:" + JSON.stringify(crowded) + "})); localStorage.setItem('sb.roadmap.chart.v1', JSON.stringify({vzoom:1})); return 1; })()");
  await send('Page.reload', {}); await sleep(500);
  for (let i = 0; i < 30; i++) { const r = await ev("!!(typeof switchView==='function')"); if (r.v === true) break; await sleep(1000); }
  await ev("(function(){ const l=document.getElementById('loading'); if(l) l.classList.add('hidden'); return 1; })()");
  await ev("switchView('roadmap'); 1"); await sleep(1200);
  // 确保在图表视图
  await ev("(function(){ try{ document.querySelectorAll('#rmChart').length; }catch(e){} return 1; })()");

  const metrics = async () => { const r = await ev("(function(){ const c=document.getElementById('rmChart'); const inn=document.getElementById('rmChartInner'); return c? JSON.stringify({client:c.clientHeight, scroll:c.scrollHeight, inner: inn? inn.offsetHeight:0, boxes: c.querySelectorAll('.rmc-box[data-rid]').length}) : ''; })()"); try { return JSON.parse(r.v); } catch (e) { return null; } };

  let m = await metrics();
  if (!m || !m.boxes) { await sleep(1500); m = await metrics(); }
  ok('画出了 14 个产品卡', m && m.boxes === 14, JSON.stringify(m));
  ok('视口固定 ~540（clientHeight ≤ 560）', m && m.client <= 560, 'client=' + (m && m.client));
  ok('绘图区长高到超过视口（拥挤自动加高）', m && m.inner > 560, 'inner=' + (m && m.inner));
  ok('#rmChart 纵向可滚动（scrollHeight > clientHeight）', m && m.scroll > m.client + 40, JSON.stringify(m));

  // 重叠检测：任意两卡片矩形显著相交的对数
  const overlapPairs = async () => { const r = await ev("(function(){ const bs=[...document.querySelectorAll('#rmChart .rmc-box[data-rid]')].map(b=>b.getBoundingClientRect()); let n=0; for(let i=0;i<bs.length;i++)for(let j=i+1;j<bs.length;j++){ const a=bs[i],b=bs[j]; const ox=Math.min(a.right,b.right)-Math.max(a.left,b.left); const oy=Math.min(a.bottom,b.bottom)-Math.max(a.top,b.top); if(ox>18 && oy>14) n++; } return n; })()"); return +r.v || 0; };
  const ovAuto = await overlapPairs();
  ok('自动高度下卡片不再明显重叠（重叠对≤1）', ovAuto <= 1, '重叠对=' + ovAuto);
  await shot('ui-roadmap-scroll-auto.png');

  // 「纵向」档位：更宽应进一步加高
  const clickVz = async (v) => { await ev("(function(){ const b=document.querySelector('#rmChartTools button[data-vz=\"" + v + "\"]'); if(b) b.click(); return 1; })()"); await sleep(700); };
  await clickVz(3);
  const m3 = await metrics();
  ok('「最宽」档进一步加高（比自动更高）', m3 && m3.inner > m.inner + 100, 'auto=' + (m && m.inner) + ' max=' + (m3 && m3.inner));
  ok('「最宽」档仍可滚动', m3 && m3.scroll > m3.client + 40, JSON.stringify(m3));
  await shot('ui-roadmap-scroll-max.png');
  // 回到自动
  await clickVz(1);
  const mBack = await metrics();
  ok('切回「自动」高度回落', mBack && Math.abs(mBack.inner - m.inner) < 40, 'back=' + (mBack && mBack.inner) + ' auto=' + (m && m.inner));
  // 持久化：vzoom 存了
  await clickVz(2);
  const persisted = await ev("(function(){ try{ return JSON.parse(localStorage.getItem('sb.roadmap.chart.v1')||'{}').vzoom; }catch(e){ return null; } })()");
  ok('纵向档位持久化到 localStorage', +persisted.v === 2, 'vzoom=' + (persisted && persisted.v));

  ws.close(); console.log(fails ? ('FAILURES: ' + fails) : '===== 路标纵向滚动 UI ALL PASS ====='); process.exit(fails ? 1 : 0);
})().catch(e => { console.log('FAIL 异常: ' + e.message); process.exit(1); });

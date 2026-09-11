/* 引导层 UI 实测：首页任务卡 / 「？」浮层 / Ctrl+K 命令面板 / 首启进首页 —— 真实渲染层断言 + 截图 */
'use strict';
const fs = require('fs'); const path = require('path');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let fails = 0; const ok = (n, c) => { console.log((c ? 'PASS ' : 'FAIL ') + n); if (!c) fails++; };
(async () => {
  let target = null;
  for (let i = 0; i < 30 && !target; i++) { try { const list = await (await fetch('http://127.0.0.1:9224/json')).json(); target = list.find(t => t.type === 'page' && /index\.html/.test(t.url || '')); } catch (e) {} if (!target) await sleep(1000); }
  if (!target) { console.log('FAIL 连不上 CDP'); process.exit(1); }
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let mid = 0; const pend = new Map();
  ws.onmessage = (ev) => { try { const m = JSON.parse(ev.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } if (m.method === 'Page.javascriptDialogOpening') ws.send(JSON.stringify({ id: ++mid, method: 'Page.handleJavaScriptDialog', params: { accept: true } })); } catch (e) {} };
  const send = (method, params) => new Promise((res) => {
    const id = ++mid; pend.set(id, res); ws.send(JSON.stringify({ id, method, params: params || {} }));
    setTimeout(() => { if (pend.has(id)) { pend.delete(id); console.log('!! CDP 超时(15s)：' + method + ' ' + String((params && params.expression) || '').slice(0, 90)); res({ result: { exceptionDetails: { text: 'timeout' } } }); } }, 15000);
  });
  const ev = async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); if (r.result && r.result.exceptionDetails) return { err: (r.result.exceptionDetails.exception && r.result.exceptionDetails.exception.description || '').slice(0, 300) }; return { v: r.result && r.result.result && r.result.result.value }; };
  const shot = async (name) => { try { await send('Page.bringToFront'); } catch (e) {} await sleep(150); const s = await send('Page.captureScreenshot', { format: 'png' }); if (s.result && s.result.data) fs.writeFileSync(path.join(__dirname, name), Buffer.from(s.result.data, 'base64')); };
  await new Promise(r => { ws.onopen = r; });
  await send('Runtime.enable'); await send('Page.enable');
  for (let i = 0; i < 30; i++) { const r = await ev("!!(window.UxGuide && typeof switchView==='function')"); if (r.v === true) break; await sleep(1000); }
  // 模拟首次启动：清计数后重新 boot（切到首页）
  // 等数据加载完再测（启动期 app.js 加载完数据会重绘默认看板，首页有 2.5s 内的自动顶回）
  for (let i = 0; i < 40; i++) { const r = await ev("/就绪|快照|Ready|未锚定|No folder/.test((document.getElementById('statusText')||{}).textContent||'')"); if (r.v === true) break; await sleep(500); }
  await ev("localStorage.removeItem('sb.ui.homeSeen'); localStorage.removeItem('sb.ui.lastView'); switchView('home'); 1"); await sleep(3000);
  await ev("(function(){ const l=document.getElementById('loading'); if(l) l.classList.add('hidden'); return 1; })()");
  const home = await ev("JSON.stringify({active: !!document.querySelector('#view-home.active'), cards: document.querySelectorAll('#view-home .ux-card').length, steps: document.querySelectorAll('#view-home .ux-step').length, navHome: !!document.querySelector('.nav-item[data-view=\"home\"]'), guideBtn: !!document.getElementById('btnGuide'), title: (document.getElementById('viewTitle')||{}).textContent})");
  console.log('首页: ' + home.v);
  let h = {}; try { h = JSON.parse(home.v); } catch (e) {}
  ok('首页视图激活', h.active === true);
  ok('12 张任务卡', h.cards === 12);
  ok('三步上手', h.steps === 3);
  ok('侧栏有「首页」项', h.navHome === true);
  ok('顶栏有「?」按钮', h.guideBtn === true);
  await shot('ui-ux-home.png');
  // 任务卡直达
  await ev("[...document.querySelectorAll('#view-home .ux-card')].find(c=>/路标/.test(c.textContent)).click(); 1"); await sleep(1200);
  const v1 = await ev("!!document.querySelector('#view-roadmap.active')");
  ok('点「管产品路标」卡片直达路标看板', v1.v === true);
  // 「?」浮层
  await ev("document.getElementById('btnGuide').click(); 1"); await sleep(400);
  const popTxt = await ev("(document.querySelector('.ux-pop')||{}).innerText || ''");
  ok('「?」浮层出现且含三句话', /看什么/.test(popTxt.v || '') && /先做什么/.test(popTxt.v || '') && /常用操作/.test(popTxt.v || ''));
  await shot('ui-ux-pop.png');
  await ev("document.body.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})); 1"); await sleep(200);
  // Ctrl+K 命令面板
  await ev("document.dispatchEvent(new KeyboardEvent('keydown',{key:'k',ctrlKey:true,bubbles:true})); 1"); await sleep(400);
  const palOpen = await ev("!!document.querySelector('.ux-pal')");
  ok('Ctrl+K 打开命令面板', palOpen.v === true);
  await ev("(function(){ const i=document.getElementById('uxPalIn'); i.value='周报'; i.dispatchEvent(new Event('input',{bubbles:true})); return 1; })()"); await sleep(200);
  const first = await ev("(document.querySelector('#uxPalList .it.on .n')||{}).textContent || ''");
  ok('输入「周报」首项是产业周报', /周报/.test(first.v || ''));
  await shot('ui-ux-palette.png');
  await ev("document.getElementById('uxPalIn').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true})); 1"); await sleep(1200);
  const v2 = await ev("!!document.querySelector('#view-audio.active')");
  ok('Enter 直达产业周报看板', v2.v === true);
  // 自然语言 → 问 AI 选项存在
  await ev("document.dispatchEvent(new KeyboardEvent('keydown',{key:'k',ctrlKey:true,bubbles:true})); 1"); await sleep(300);
  await ev("(function(){ const i=document.getElementById('uxPalIn'); i.value='墨西哥平板今年卖了多少'; i.dispatchEvent(new Event('input',{bubbles:true})); return 1; })()"); await sleep(200);
  const aiOpt = await ev("[...document.querySelectorAll('#uxPalList .it .n')].map(n=>n.textContent).join('|')");
  ok('自然语言出现「问 AI：…」选项', /问 AI：墨西哥/.test(aiOpt.v || ''));
  await ev("document.getElementById('uxPalIn').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})); 1");
  // 路标图工具栏文案已去黑话
  await ev("switchView('roadmap'); 1"); await sleep(800);
  await ev("(function(){ const b=document.getElementById('rmViewChart'); if(b) b.click(); return 1; })()"); await sleep(600);
  const tb = await ev("(document.getElementById('rmChartTools')||{}).textContent || ''");   // textContent 含折叠(display:none)的控件文案
  ok('路标工具栏文案：价格轴/按型号拆开/卡片样式/缺价用FOB估算', /价格轴/.test(tb.v || '') && /按型号拆开/.test(tb.v || '') && /卡片样式/.test(tb.v || '') && /缺价用 FOB 估算/.test(tb.v || ''));
  // ---- 简化层：折叠 / 主按钮 / 副标题 / 术语提示 ----
  await sleep(500);
  const simp = await ev("(function(){ const vis=el=>!!(el&&el.offsetParent); const more=document.querySelectorAll('#rmChartTools .ux-more').length; const topMore=[...document.querySelectorAll('.ux-more')].filter(b=>/导出/.test(b.textContent)).length; return JSON.stringify({toolbarMore:more, topMore:topMore, boxStyleHidden: !vis(document.getElementById('rmBoxStyle')), exportHidden: !vis(document.getElementById('rmExport')), addPrimary: (document.getElementById('rmAdd')||{}).className||'', sub:(document.getElementById('viewSub')||{}).textContent||''}); })()");
  console.log('简化层(路标): ' + simp.v);
  let sp = {}; try { sp = JSON.parse(simp.v); } catch (e) {}
  ok('路标工具栏出现「更多选项 ▾」且卡片样式默认收起', sp.toolbarMore === 1 && sp.boxStyleHidden === true);
  ok('路标顶部出现「导出 / 导入 ▾」且导出按钮默认收起', sp.topMore === 1 && sp.exportHidden === true);
  ok('「+产品」是唯一主按钮', /primary/.test(sp.addPrimary));
  ok('顶栏副标题一句话', /路标/.test(sp.sub));
  await shot('ui-ux-roadmap-simplified.png');
  await ev("[...document.querySelectorAll('#rmChartTools .ux-more')][0].click(); 1"); await sleep(200);
  const opened = await ev("!!(document.getElementById('rmBoxStyle')&&document.getElementById('rmBoxStyle').offsetParent)");
  ok('点「更多选项」展开后卡片样式可见', opened.v === true);
  await ev("switchView('psi'); 1"); await sleep(900);
  const psi = await ev("JSON.stringify({dosTip: (([...document.querySelectorAll('#metricTabs button')].find(b=>/DOS/.test(b.textContent))||{}).title)||'', more: document.querySelectorAll('#view-psi .ux-more').length, opacityHidden: !(document.getElementById('opacity')&&document.getElementById('opacity').offsetParent)})");
  console.log('简化层(PSI): ' + psi.v);
  let ps = {}; try { ps = JSON.parse(psi.v); } catch (e) {}
  ok('PSI「DOS」标签悬停有白话解释', /周转天数/.test(ps.dosTip || ''));
  ok('PSI 图表样式控件折进「图表样式 ▾」', ps.more === 1 && ps.opacityHidden === true);
  await shot('ui-ux-psi-simplified.png');
  await ev("switchView('inventory'); 1"); await sleep(3000);
  const probe = () => ev("JSON.stringify({primary: /primary/.test((document.getElementById('invRecalc')||{}).className||''), more: [...document.querySelectorAll('.ux-more')].filter(b=>b.closest('#view-inventory')).length, diagHidden: !(document.getElementById('invDiagBtn')&&document.getElementById('invDiagBtn').offsetParent), cur: window.UxGuide.cur(), hasBtn: !!document.getElementById('invRecalc')})");
  let inv = await probe();
  console.log('简化层(库存): ' + inv.v);
  if (!/"more":1/.test(inv.v || '')) {   // 诊断：手动调一次，分清「没跑」还是「跑了没生效」
    const man = await ev("(function(){ try { window.UxGuide.applySimplify('inventory'); return 'manual-ok'; } catch(e) { return 'manual-throw: ' + e.message; } })()");
    inv = await probe(); console.log('   手动 applySimplify → ' + man.v + ' → ' + inv.v);
  }
  let iv = {}; try { iv = JSON.parse(inv.v); } catch (e) {}
  ok('库存「重算」是主按钮，诊断/全量导出折进「更多」', iv.primary === true && iv.more === 1 && iv.diagHidden === true);
  ws.close(); console.log(fails ? ('FAILURES: ' + fails) : '===== 引导层 UI ALL PASS ====='); process.exit(fails ? 1 : 0);
})().catch(e => { console.log('FAIL 异常: ' + e.message); process.exit(1); });

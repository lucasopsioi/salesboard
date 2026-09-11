/* 折行扫描器：逐看板找出「界面文字折成多行」的元素（按钮/标签/表头/标题/状态栏/导航/卡片标题与说明/分段按钮…）
 * 判定：内联元素 getClientRects().length > 1；块元素 高度 > 1.6 × 行高 且只含文字。输出每看板清单（选择器 + 文本）。 */
'use strict';
const fs = require('fs'); const path = require('path');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const VIEWS = ['home', 'psi', 'industry', 'country', 'report', 'finance', 'inventory', 'fob', 'pricing', 'pricinglib', 'custom', 'designer', 'pptoutput', 'textout', 'roadmap', 'source', 'agentchat', 'audio'];
(async () => {
  let target = null;
  for (let i = 0; i < 30 && !target; i++) { try { const list = await (await fetch('http://127.0.0.1:9224/json')).json(); target = list.find(t => t.type === 'page' && /index\.html/.test(t.url || '')); } catch (e) {} if (!target) await sleep(1000); }
  if (!target) { console.log('FAIL 连不上 CDP'); process.exit(1); }
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let mid = 0; const pend = new Map();
  ws.onmessage = (ev) => { try { const m = JSON.parse(ev.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } if (m.method === 'Page.javascriptDialogOpening') ws.send(JSON.stringify({ id: ++mid, method: 'Page.handleJavaScriptDialog', params: { accept: true } })); } catch (e) {} };
  const send = (method, params) => new Promise((res) => { const id = ++mid; pend.set(id, res); ws.send(JSON.stringify({ id, method, params: params || {} })); setTimeout(() => { if (pend.has(id)) { pend.delete(id); res({ result: { exceptionDetails: { text: 'timeout' } } }); } }, 20000); });
  const ev = async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); if (r.result && r.result.exceptionDetails) return { err: (r.result.exceptionDetails.exception && r.result.exceptionDetails.exception.description || r.result.exceptionDetails.text || '').slice(0, 300) }; return { v: r.result && r.result.result && r.result.result.value }; };
  await new Promise(r => { ws.onopen = r; });
  await send('Runtime.enable'); await send('Page.enable');
  for (let i = 0; i < 30; i++) { const r = await ev("!!(typeof switchView==='function' && window.sb)"); if (r.v === true) break; await sleep(1000); }
  await ev("window.sb.setFolderAndRefresh('D:/workspace/Salesboard/demo-data/psi').then(()=>1)"); await sleep(2500);
  await ev("window.sb.setFinFolderAndRefresh('D:/workspace/Salesboard/demo-data/finance').then(()=>1)"); await sleep(2500);
  await ev("window.sb.setInvFolderAndRefresh('D:/workspace/Salesboard/demo-data/flow').then(()=>1)"); await sleep(2000);
  await ev("(function(){ const l=document.getElementById('loading'); if(l) l.classList.add('hidden'); window.alert=function(){}; window.confirm=function(){return false;}; return 1; })()");
  const SCAN = `(function(){
    const SEL = 'h1,h2,h3,h4,.topbar span,.topbar div,.topbar button,.data-bar span,.data-bar div,.nav-item,button,label,th,.tab,.fin-tab,.seg button,.metric-tabs button,.rm-seg button,.chip,.ac-chip,.kpi .lab,.kpi .t,.kpi-t,.card .t,.card-title,.sh,.ux-card .t,.ux-card .d,.ux-step div,.fld label,.psi-stats .t,.lbl,.grp .lbl,.px-lbl,.inv-tool span,.pd-tb-btn,.pd-lib-item,.pd-tpl-row .nm,.rmc-box .nm,.rmc-box .meta,.rmc-ax,.ac-sess,.ac-fname,.badge,.status,#statusText,#viewSub,.legend,.lg,.name,.t,.title';
    const vis = el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const out = [];
    const seen = new Set();
    document.querySelectorAll(SEL).forEach(el => {
      if (!vis(el) || seen.has(el)) return;
      if (['TEXTAREA','INPUT','SELECT','OPTION','SCRIPT','STYLE'].includes(el.tagName)) return;
      if (el.closest('.ac-b, .ux-pop, pre, code, .ai-msg, .ac-msgs, table td')) return;
      const text = (el.innerText || '').trim(); if (!text || text.length < 2) return;
      // 只看「自身直接文字」为主的元素：子元素多于 3 个的容器跳过（避免把整块面板当成一段文字）
      if (el.children.length > 3 && !el.matches('.nav-item,button,.rmc-box .nm,.ux-card .d')) return;
      const cs = getComputedStyle(el);
      if (cs.whiteSpace === 'nowrap' || cs.whiteSpace === 'pre') return;
      // 真实文字行框计数：对元素内容建 Range，取所有 client rects，按 top 去重 —— 与内边距/高度无关
      let lh = parseFloat(cs.lineHeight); if (!isFinite(lh)) lh = parseFloat(cs.fontSize) * 1.4;
      const range = document.createRange(); range.selectNodeContents(el);
      const tops = [];
      [...range.getClientRects()].forEach(r => { if (r.width < 1 || r.height < 1) return; if (!tops.some(t => Math.abs(t - r.top) < lh * 0.5)) tops.push(r.top); });
      if (tops.length < 2) return;
      seen.add(el);
      const id = el.id ? '#' + el.id : ''; const cls = el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\\s+/).slice(0,2).join('.') : '';
      const par = el.parentElement; const pid = par && par.id ? '#' + par.id : (par && typeof par.className === 'string' && par.className ? '.' + par.className.trim().split(/\\s+/)[0] : par ? par.tagName.toLowerCase() : '');
      out.push({ sel: pid + ' > ' + el.tagName.toLowerCase() + id + cls, text: text.replace(/\\s+/g, ' ').slice(0, 60), w: Math.round(el.getBoundingClientRect().width), lines: tops.length });
    });
    return JSON.stringify(out.slice(0, 40));
  })()`;
  const report = {};
  let total = 0;
  for (const v of VIEWS) {
    await ev("(function(){ try{ switchView(" + JSON.stringify(v) + "); }catch(e){} return 1; })()"); await sleep(v === 'inventory' || v === 'audio' ? 3000 : 1500);
    const r = await ev(SCAN);
    let list = []; try { list = JSON.parse(r.v || '[]'); } catch (e) {}
    report[v] = list; total += list.length;
    console.log((list.length ? 'WRAP ' : 'ok   ') + v.padEnd(10) + ' 折行元素 ' + list.length);
    list.slice(0, 14).forEach(x => console.log('      · ' + x.sel + '  [' + x.lines + '行/' + x.w + 'px]  ' + x.text));
  }
  fs.writeFileSync(path.join(__dirname, 'wrap-report.json'), JSON.stringify(report, null, 1));
  console.log('===== 折行扫描：' + VIEWS.length + ' 个看板，共 ' + total + ' 处 =====');
  ws.close(); process.exit(0);
})().catch(e => { console.log('FAIL 异常: ' + e.message); process.exit(1); });

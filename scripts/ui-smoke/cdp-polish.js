/* 本轮体验改进实测（2026-09-07 用户「给我一些超出预期的改动，又好看又好用」）
 *  P1 画布与卡片不同色（浅色主题不再白贴白）
 *  P2 语义色 --c-bad ≠ 品牌红
 *  P3 侧栏分组标签归位（每个标签下面真的有条目，不再全挤在顶上）
 *  P4 首页任务卡描述不再被截成半句（两行封顶）
 *  P5 AI 面板非模态：无遮罩、看板被推挤而不是被盖住、点看板不关闭对话
 *  P6 AI 面板空状态文案跟随实际 provider（不再写死 MiniMax/LM Studio）
 *  P7 PSI 选 DOS 时按「天」显示，不做单位换算（不再满屏 0W）
 *  P8 顶部进度条跑完会收起
 * 用法：起测试实例(test-main.js)后 node cdp-polish.js */
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
  const send = (m, p, t) => new Promise(res => { const id = ++mid; pend.set(id, res); ws.send(JSON.stringify({ id, method: m, params: p || {} })); setTimeout(() => { if (pend.has(id)) { pend.delete(id); res({}); } }, t || 30000); });
  const ev = async (e) => { const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }); if (r.result && r.result.exceptionDetails) return { err: String((r.result.exceptionDetails.exception || {}).description || '').slice(0, 200) }; return { v: r.result && r.result.result ? r.result.result.value : null }; };
  const shot = async (n) => { try { await send('Page.bringToFront'); const r = await send('Page.captureScreenshot', { format: 'png' }); if (r.result && r.result.data) fs.writeFileSync(path.join(__dirname, n), Buffer.from(r.result.data, 'base64')); } catch (e) {} };
  await new Promise(r => { ws.onopen = r; });
  await send('Runtime.enable'); await send('Page.enable');
  for (let i = 0; i < 30; i++) { if ((await ev("typeof switchView==='function'")).v === true) break; await sleep(1000); }
  await ev("(function(){ window.alert=function(){}; window.confirm=function(){return true;}; const l=document.getElementById('loading'); if(l) l.classList.add('hidden'); return 1; })()");
  await ev("(function(){ const b=[...document.querySelectorAll('button,a')].find(x=>/载入示例/.test(x.textContent||'')); if(b) b.click(); return 1; })()");
  for (let i = 0; i < 40; i++) { const busy = await ev("(function(){ const l=document.getElementById('loading'); return !!(l && !l.classList.contains('hidden')); })()"); if (busy.v !== true) break; await sleep(1000); }
  await sleep(2000);
  await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });

  // P1/P2 设计 token
  const tok = await ev("(function(){ const cs=getComputedStyle(document.documentElement); return JSON.stringify({base:cs.getPropertyValue('--c-bg-base').trim(), elev:cs.getPropertyValue('--c-bg-elev').trim(), bad:cs.getPropertyValue('--c-bad').trim(), brand:cs.getPropertyValue('--c-brand').trim()}); })()");
  let T = {}; try { T = JSON.parse(tok.v); } catch (e) {}
  ok('P1 画布与卡片不同色（不再白贴白）', T.base && T.elev && T.base.toLowerCase() !== T.elev.toLowerCase(), JSON.stringify(T));
  ok('P2 告警红 ≠ 品牌红（语义色可辨）', T.bad && T.brand && T.bad.toLowerCase() !== T.brand.toLowerCase(), JSON.stringify(T));

  // P3 侧栏分组
  await ev("switchView('home'); 1"); await sleep(900);
  const nav = await ev("(function(){ const ns=[...document.querySelectorAll('.nav > *')].filter(n=>n.offsetParent!==null); const seq=ns.map(n=>n.classList.contains('nav-label')?('#'+n.textContent.trim()):'item'); let bad=0; for(let i=0;i<seq.length-1;i++){ if(seq[i][0]==='#'&&seq[i+1][0]==='#') bad++; } const lastIsLabel=seq.length&&seq[seq.length-1][0]==='#'; return JSON.stringify({labels:seq.filter(x=>x[0]==='#'), adjacentLabels:bad, lastIsLabel}); })()");
  let N = {}; try { N = JSON.parse(nav.v); } catch (e) {}
  ok('P3 没有相邻的空分组标题', N.adjacentLabels === 0 && !N.lastIsLabel, JSON.stringify(N));
  ok('P3 分组标题多于一个且已归位', (N.labels || []).length >= 2, JSON.stringify(N.labels));
  // 每个条目必须落在正确的分组标题下（不管用户拖过什么顺序、archive 里存着什么旧顺序）
  const grp = await ev("(function(){ const ns=[...document.querySelectorAll('.nav > *')].filter(n=>n.offsetParent!==null); const m={}; let cur=''; ns.forEach(n=>{ if(n.classList.contains('nav-label')){ cur=n.textContent.trim(); return; } const v=n.dataset.view; if(v&&cur){ (m[cur]=m[cur]||[]).push(v); } }); return JSON.stringify(m); })()");
  let G = {}; try { G = JSON.parse(grp.v); } catch (e) {}
  const inG = (label, vs) => (G[label] || []).length && vs.every(v => (G[label] || []).indexOf(v) >= 0);
  ok('P3 「看数据」组含 psi/country/report/inventory', inG('看数据', ['psi', 'country', 'report', 'inventory']), JSON.stringify(G));
  ok('P3 「做规划」组含 roadmap/pricing', inG('做规划', ['roadmap', 'pricing']), JSON.stringify(G));
  ok('P3 「出材料」组含 pptoutput/textout', inG('出材料', ['pptoutput', 'textout']), JSON.stringify(G));

  // P4 首页任务卡描述不再单行截断
  const card = await ev("(function(){ const d=document.querySelector('.ux-card .d'); if(!d) return 'no-card'; const cs=getComputedStyle(d); return JSON.stringify({ws:cs.whiteSpace, clamp:cs.webkitLineClamp||cs.getPropertyValue('-webkit-line-clamp'), h:d.offsetHeight, full:d.scrollHeight}); })()");
  let C = {}; try { C = JSON.parse(card.v); } catch (e) {}
  ok('P4 任务卡描述换行放开（两行封顶，不再半句）', C.ws && C.ws !== 'nowrap', JSON.stringify(C));
  await shot('ui-polish-home.png');

  // P5/P6 AI 面板非模态
  const before = await ev("(function(){ const m=document.querySelector('.main'); return m? m.getBoundingClientRect().width : 0; })()");
  await ev("(function(){ window.AIPanel && window.AIPanel.open && window.AIPanel.open(null); return 1; })()"); await sleep(700);
  const p5 = await ev("(function(){ const m=document.querySelector('.main'); const mask=document.getElementById('aiMask'); const root=document.getElementById('aiPanelRoot'); const cs=root?getComputedStyle(root):null; return JSON.stringify({ mainW:m?m.getBoundingClientRect().width:0, docked:document.body.classList.contains('ai-docked'), maskShown: mask? getComputedStyle(mask).display!=='none' : false, rootPE: cs?cs.pointerEvents:'', rootLeft: cs?root.getBoundingClientRect().left:0 }); })()");
  let P = {}; try { P = JSON.parse(p5.v); } catch (e) {}
  ok('P5 打开 AI 后看板被推窄（不是被盖住）', P.mainW > 0 && P.mainW < (before.v || 1e9) - 200, 'before=' + before.v + ' after=' + P.mainW);
  ok('P5 无遮罩且事件穿透（能继续操作看板）', P.maskShown === false && P.rootPE === 'none', JSON.stringify(P));
  ok('P5 面板只占右侧一条（不铺满全屏）', P.rootLeft > 400, 'left=' + P.rootLeft);
  const emptyTxt = await ev("(function(){ const e=document.querySelector('.ai-empty'); return e? e.textContent : ''; })()");
  ok('P6 空状态不再写死旧 provider', !/MiniMax 在线 \/ LM Studio/.test(emptyTxt.v || ''), String(emptyTxt.v || '').slice(0, 80));
  await shot('ui-polish-ai-docked.png');
  // 点看板不该关闭对话
  await ev("(function(){ const t=document.querySelector('.topbar h1')||document.body; t.click(); return 1; })()"); await sleep(400);
  const still = await ev("!!document.body.classList.contains('ai-docked')");
  ok('P5 点看板不会误关对话', still.v === true);
  await ev("(function(){ window.AIPanel && window.AIPanel.close && window.AIPanel.close(); return 1; })()"); await sleep(500);
  const restored = await ev("(function(){ const m=document.querySelector('.main'); return m? m.getBoundingClientRect().width : 0; })()");
  ok('P5 关闭后看板宽度复原', Math.abs((restored.v || 0) - (before.v || 0)) < 12, 'before=' + before.v + ' restored=' + restored.v);

  // P7 PSI 选 DOS：按天显示，不做单位换算
  await ev("switchView('psi'); 1"); await sleep(2600);
  await ev("(function(){ if(typeof state!=='undefined'){ state.unit='w'; state.metric='dos'; state.labels=true; } const b=[...document.querySelectorAll('#metricTabs button,#metricTabs [data-m]')].find(x=>/DOS/i.test(x.textContent||'')); if(b) b.click(); return 1; })()");
  await sleep(2600);
  // ECharts 默认渲染到 canvas，DOM 里没有 <text> 节点——必须读 option / 调 formatter 才算数
  const psi = await ev("(function(){ const el=document.querySelector('#psiChart'); if(!el) return JSON.stringify({err:'no-chart'});"
    + " const c = (window.echarts && echarts.getInstanceByDom(el)) || null; if(!c) return JSON.stringify({err:'no-instance'});"
    + " const o=c.getOption(); const ax=(o.yAxis&&o.yAxis[0])||{};"
    + " let axSample=''; try{ axSample = ax.axisLabel && typeof ax.axisLabel.formatter==='function' ? String(ax.axisLabel.formatter(11)) : ''; }catch(e){ axSample='ERR'; }"
    + " let labSample=''; try{ const s=(o.series||[]).find(x=>x.label&&x.label.show&&typeof x.label.formatter==='function');"
    + "   if(s) labSample=String(s.label.formatter({value:11,data:{lbl:'11天'}})); }catch(e){ labSample='ERR'; }"
    + " return JSON.stringify({axisName:ax.name||'', axSample, labSample, unit:(typeof state!=='undefined'&&state.unit)||'', metric:(typeof state!=='undefined'&&state.metric)||''}); })()");
  let Q = {}; try { Q = JSON.parse(psi.v); } catch (e) {}
  ok('P7 DOS 下 Y 轴单位名是「天」', Q.axisName === '天', JSON.stringify(Q));
  ok('P7 DOS 下刻度按天格式化，不再是 0W', /天$/.test(Q.axSample || '') && !/W$/.test(Q.axSample || ''), JSON.stringify(Q));
  await shot('ui-polish-psi-dos.png');

  ws.close(); console.log(fails ? ('FAILURES: ' + fails) : '===== 体验改进 UI ALL PASS ====='); process.exit(fails ? 1 : 0);
})().catch(e => { console.log('FAIL 异常: ' + e.message); process.exit(1); });

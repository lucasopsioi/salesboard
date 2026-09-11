/* 周报 AI 叙述实测（2026-09-07 用户：销售分析那句话让 DeepSeek 按我的表述方式写）
 *  W1 周报叙述工具条出现「AI 生成」「文风样例」
 *  W2 文风样例可保存并持久化
 *  W3 事实清单来自芯片解析的真实数值
 *  W4 真调 DeepSeek 生成一句，且编数校验通过（只用清单里的数）
 * 用法：起测试实例(test-main.js)后 node cdp-weeklyai.js */
'use strict';
const fs = require('fs'); const path = require('path');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let fails = 0; const ok = (n, c, extra) => { console.log((c ? 'PASS ' : 'FAIL ') + n + (!c && extra ? '  << ' + extra : '')); if (!c) fails++; };
const KEY = fs.readFileSync('D:/workspace/Salesboard/eval/deepseek.key', 'utf8').trim();

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
  await ev("(function(){ window.alert=function(m){window.__a=m;}; window.confirm=function(){return true;}; const l=document.getElementById('loading'); if(l) l.classList.add('hidden'); return 1; })()");
  await ev("(function(){ const c=Object.assign({}, (window.AIPanel.loadCfg&&window.AIPanel.loadCfg())||{}, {provider:'deepseek', dsModel:'deepseek-chat', dsKey:" + JSON.stringify(KEY) + "}); window.AIPanel.saveCfg(c); return 1; })()");
  await ev("(function(){ const b=[...document.querySelectorAll('button,a')].find(x=>/载入示例/.test(x.textContent||'')); if(b) b.click(); return 1; })()");
  for (let i = 0; i < 40; i++) { const busy = await ev("(function(){ const l=document.getElementById('loading'); return !!(l && !l.classList.contains('hidden')); })()"); if (busy.v !== true) break; await sleep(1000); }
  await sleep(2000);
  await ev("switchView('audio'); 1"); await sleep(4000);

  const bar = await ev("(function(){ const b=[...document.querySelectorAll('.wk-shelf-chip')].map(x=>x.textContent.trim()); return JSON.stringify(b.slice(-6)); })()");
  ok('W1 工具条有「AI 生成」与「文风样例」', /AI 生成/.test(bar.v || '') && /文风样例/.test(bar.v || ''), bar.v);

  // W2 文风样例保存
  await ev("window.WeeklyAI.styleSet('大区整体销售：W30 WoW +5%，SO同比 +12%，渠道DOS 42天，整体健康可控。'); 1");
  const st = await ev("window.WeeklyAI.styleGet()");
  ok('W2 文风样例已持久化', /整体健康可控/.test(st.v || ''), String(st.v || '').slice(0, 60));

  // W3 事实清单
  const facts = await ev("(function(){ const h=document.querySelector('.wk-nared'); if(!h||!h._opts) return JSON.stringify({err:'no-editor'});"
    + " const o=h._opts; const ctx=o.getCtx?o.getCtx():{};"
    + " const f=window.WeeklyAI.factsFrom(o.palette||[], ctx, window.WeeklyChips);"
    + " return JSON.stringify({n:f.length, sample:f.slice(0,4)}); })()");
  let F = {}; try { F = JSON.parse(facts.v); } catch (e) {}
  ok('W3 事实清单来自真实芯片值', (F.n || 0) >= 3, JSON.stringify(F).slice(0, 220));
  console.log('   事实样例: ' + JSON.stringify(F.sample || []));

  // W4 真调模型
  const gen = await ev("(async function(){ const h=document.querySelector('.wk-nared'); const o=h._opts;"
    + " const ctx=o.getCtx?o.getCtx():{}; const AI=window.WeeklyAI;"
    + " const facts=AI.factsFrom(o.palette||[], ctx, window.WeeklyChips);"
    + " const P=window.AIPanel; const chat=P.makeOrchDeps(P.loadCfg(), function(){}).chat;"
    + " const r=await AI.generate({facts:facts, style:AI.styleGet(), scopeLabel:'产业整体', chat:chat});"
    + " return JSON.stringify({text:r.text||'', error:r.error||'', ok:r.verify?r.verify.ok:null, unknown:r.verify?r.verify.unknown:[]}); })()", 180000);
  let G = {}; try { G = JSON.parse(gen.v); } catch (e) {}
  console.log('   生成: ' + String(G.text || G.error || gen.err || '').slice(0, 200));
  ok('W4 模型返回了一句话', !!G.text && G.text.length > 8, G.error || gen.err || '');
  ok('W4 没有编数（数字都出自事实清单）', G.ok === true, JSON.stringify(G.unknown || []));
  ok('W4 没有「根据数据」这类过程前缀', !/^(以下是|根据)/.test(G.text || ''));
  await shot('ui-weekly-ai.png');

  await ev("(function(){ const c=window.AIPanel.loadCfg()||{}; delete c.dsKey; window.AIPanel.saveCfg(c); return 1; })()");
  ws.close(); console.log(fails ? ('FAILURES: ' + fails) : '===== 周报 AI 叙述 ALL PASS ====='); process.exit(fails ? 1 : 0);
})().catch(e => { console.log('FAIL 异常: ' + e.message); process.exit(1); });

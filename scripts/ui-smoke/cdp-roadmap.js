/* 路标：自动识别 → 新建 → 路标图必须看得见（2026-09-10 用户：「识别出来了、显示添加成功，路标图就是显示不出来」）
 *  R1 识别出的音频产品品类归一到「音频」（PSI 产品线叫「音频与智能配件」）
 *  R2 新建完自动切到路标图，且新产品的盒子在图上
 *  R3 切「音频」页签，新建的音频产品还在（不再被等号比对筛掉）
 *  R4 老数据里存的原值「音频与智能配件」也落进「音频」页签
 *  R5 新建时若年份/时间切片会把新产品藏掉，自动清空并告知
 * 用法：起测试实例后 node cdp-roadmap.js */
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
  const ev = async (e, t) => { const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }, t); if (r.result && r.result.exceptionDetails) return { err: String((r.result.exceptionDetails.exception || {}).description || '').slice(0, 400) }; return { v: r.result && r.result.result ? r.result.result.value : null }; };
  const J = async (e, t) => { const r = await ev(e, t); if (r.err) return { __err: r.err }; try { return JSON.parse(r.v); } catch (x) { return { __raw: r.v }; } };
  const shot = async (n) => { try { await send('Page.bringToFront'); const r = await send('Page.captureScreenshot', { format: 'png' }); if (r.result && r.result.data) fs.writeFileSync(path.join(__dirname, n), Buffer.from(r.result.data, 'base64')); } catch (e) {} };
  await new Promise(r => { ws.onopen = r; });
  await send('Runtime.enable'); await send('Page.enable');
  for (let i = 0; i < 30; i++) { if ((await ev("typeof switchView==='function'")).v === true) break; await sleep(1000); }
  // alert/confirm 都自动接受；把 alert 文案存起来供断言
  await ev("(function(){ window.__alerts=[]; window.alert=function(m){ window.__alerts.push(String(m)); }; window.confirm=function(){ return true; }; const l=document.getElementById('loading'); if(l) l.classList.add('hidden'); const b=[...document.querySelectorAll('button,a')].find(x=>/载入示例/.test(x.textContent||'')); if(b) b.click(); return 1; })()");
  for (let i = 0; i < 40; i++) { const busy = await ev("(function(){ const l=document.getElementById('loading'); return !!(l && !l.classList.contains('hidden')); })()"); if (busy.v !== true) break; await sleep(1000); }
  await sleep(1500);
  await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });

  await ev("switchView('roadmap'); 1"); await sleep(800);
  // 先把和 PSI 示例同名的路标产品清掉（不管它们是谁留下的），否则「同名已存在不重复建」会让识别出 0 张新卡
  const PRE = await J("(async function(){ const names=new Set(await api.options('product',{})); const before=RM_STATE.products.length;"
    + " RM_STATE.products=RM_STATE.products.filter(p=>!names.has(p.name)); localStorage.setItem('sb.roadmap.products.v1', JSON.stringify({products:RM_STATE.products}));"
    + " return JSON.stringify({before:before, after:RM_STATE.products.length, psiNames:[...names].slice(0,8)}); })()");
  console.log('   预清理: ' + JSON.stringify(PRE));
  // 故意把图停在「2026 年」+「平板」页签：这正是用户碰到的「加了却看不见」的现场
  await ev("(function(){ RM_STATE.chart.year='2026'; RM_STATE.chart.category='平板'; return 1; })()");
  await ev("(function(){ document.getElementById('rmViewDetect').click(); return 1; })()"); await sleep(500);
  await ev("(function(){ const b=document.getElementById('detRun'); if(b) b.click(); return 1; })()");
  for (let i = 0; i < 40; i++) { const r = await ev("!!document.querySelector('[data-newsel]')"); if (r.v === true) break; await sleep(1000); }
  await sleep(400);
  const nCards = await ev("(function(){ const cbs=[...document.querySelectorAll('[data-newsel]')]; cbs.forEach(c=>{ c.checked=true; c.dispatchEvent(new Event('change')); }); return cbs.length; })()");
  const before = +(await ev("RM_STATE.products.length")).v;
  await ev("(function(){ const b=document.getElementById('rmDetCreate'); if(b) b.click(); return 1; })()"); await sleep(1500);
  const NEW = await J("JSON.stringify({after:RM_STATE.products.length, created:RM_STATE.products.slice(" + before + ").map(p=>({name:p.name, category:p.category, shipLate:p.shipLate})), view:RM_STATE.view, chart:RM_STATE.chart, alerts:window.__alerts.slice(-1)})");
  ok('R0 识别出新产品并新建成功', (+nCards.v || 0) > 0 && NEW.after > before, JSON.stringify({ cards: nCards.v, before: before, after: NEW.after }));
  const audio = (NEW.created || []).filter(p => /Buds|Open-Ear/.test(p.name));
  ok('R1 音频产品的品类归一成「音频」（不是 PSI 原值「音频与智能配件」）', audio.length > 0 && audio.every(p => p.category === '音频'), JSON.stringify(audio));
  ok('R1b 平板产品品类是「平板」', (NEW.created || []).filter(p => !/Buds|Open-Ear/.test(p.name)).every(p => p.category === '平板'), JSON.stringify(NEW.created));
  ok('R2 新建完自动切到路标图', NEW.view === 'chart', 'view=' + NEW.view);
  ok('R5 会把新产品藏掉的「2026 年」筛选被清空，并在提示里说明', NEW.chart && NEW.chart.year === '' && /年份/.test((NEW.alerts || [])[0] || ''), JSON.stringify({ chart: NEW.chart, alert: NEW.alerts }));
  console.log('   新建: ' + JSON.stringify(NEW.created.map(p => p.name + '(' + p.category + ')')));

  const boxes = async () => await J("(function(){ const h=document.getElementById('rmChart'); const names=[...h.querySelectorAll('[data-rid]')].map(b=>b.textContent.trim()); return JSON.stringify({n:names.length, names:names, empty:/暂无产品/.test(h.innerText||'')}); })()");
  const clickCat = async cat => { await ev("(function(){ const b=[...document.querySelectorAll('#view-roadmap button[data-cat]')].find(x=>x.dataset.cat==='" + cat + "'); if(b) b.click(); return 1; })()"); await sleep(600); };
  await clickCat('');
  const ALL = await boxes();
  ok('R2b 「全部」页签下新产品的盒子都在图上', (NEW.created || []).every(p => (ALL.names || []).some(n => n.indexOf(p.name.slice(0, 10)) >= 0)), JSON.stringify({ n: ALL.n, missing: (NEW.created || []).filter(p => !(ALL.names || []).some(n => n.indexOf(p.name.slice(0, 10)) >= 0)).map(p => p.name) }));
  await clickCat('音频');
  const AU = await boxes();
  ok('R3 切「音频」页签，新建的音频产品还在', AU.empty === false && audio.every(p => (AU.names || []).some(n => n.indexOf(p.name.slice(0, 10)) >= 0)), JSON.stringify(AU));
  await shot('ui-roadmap-audio.png');

  // R4 老数据：直接塞一个品类为原值「音频与智能配件」的产品，它也得落进「音频」页签
  const R4 = await J("(function(){ const p=JSON.parse(JSON.stringify(RM_STATE.products[RM_STATE.products.length-1])); p.id='p_legacy_audio'; p.name='Legacy Audio X'; p.category='音频与智能配件'; RM_STATE.products.push(p);"
    + " const b=[...document.querySelectorAll('#view-roadmap button[data-cat]')].find(x=>x.dataset.cat==='音频'); b.click();"
    + " const h=document.getElementById('rmChart'); const names=[...h.querySelectorAll('[data-rid]')].map(x=>x.textContent.trim());"
    + " RM_STATE.products=RM_STATE.products.filter(x=>x.id!=='p_legacy_audio');"
    + " return JSON.stringify({found:names.some(n=>n.indexOf('Legacy Audio')>=0)}); })()");
  ok('R4 老数据里的原值「音频与智能配件」也落进「音频」页签', R4.found === true, JSON.stringify(R4));

  ws.close(); console.log(fails ? ('FAILURES: ' + fails) : '===== 路标识别→新建→路标图 ALL PASS ====='); process.exit(fails ? 1 : 0);
})();

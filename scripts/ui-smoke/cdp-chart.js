/* 路标图页全控件 UI 检测：预置 6 个产品（有价/缺价有前代/缺价无前代/多SKU/多系列/多年份）
 * → 逐个驱动：计价切换/国家/年份/型号拆解/显示样机/样机色与透明度/Y量程(单边·双边·反写·自动)
 *   /时间起止+复位/底部滑块双击复位/框样式/≈FOB+倍数/顶部按钮(+产品/+样机/+产品系列 弹窗)/产品框点击/拖拽改上市月
 * → 每步读 DOM 断言；截图。 */
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
  const send = (method, params) => new Promise((res) => { const id = ++mid; pend.set(id, res); ws.send(JSON.stringify({ id, method, params: params || {} })); });
  const ev = async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); if (r.result && r.result.exceptionDetails) return { err: (r.result.exceptionDetails.exception && r.result.exceptionDetails.exception.description || '').slice(0, 300) }; return { v: r.result && r.result.result && r.result.result.value }; };
  const J = async (expr) => { const r = await ev(expr); if (r.err) { console.log('   [err] ' + r.err); return null; } try { return JSON.parse(r.v); } catch (e) { return r.v; } };
  await new Promise(r => { ws.onopen = r; });
  await send('Runtime.enable'); await send('Page.enable');
  for (let i = 0; i < 30; i++) { const r = await ev("!!(typeof switchView==='function' && window.RoadmapAPI && window.RoadmapChart)"); if (r.v === true) break; await sleep(1000); }
  console.log('PASS 渲染层就绪');
  await ev("window.alert=function(m){window.__lastAlert=m;}; window.confirm=function(){return true;}; localStorage.removeItem('sb.roadmap.products.v1'); localStorage.removeItem('sb.roadmap.chart.v1'); 1");
  await ev("switchView('roadmap')"); await sleep(1200);
  // 预置产品
  const seed = [
    { name: 'Slate SE 10', fields: { shipLate: '2025/01', seriesGroup: 'Anchovy', category: '平板', compositeRrpUsd: 149 } },
    { name: 'Slate SE 11', fields: { shipLate: '2025/06', seriesGroup: 'Dorado', category: '平板', compositeRrpUsd: 179, predecessor: 'Slate SE 10' } },
    { name: 'Slate SE 12', fields: { shipLate: '2026/11', seriesGroup: 'Dorado', category: '平板', predecessor: 'Slate SE 11' } },      // 缺价·有前代
    { name: 'Slate 11 Pro', fields: { shipLate: '2025/09', seriesGroup: 'Coral', category: '平板', compositeRrpUsd: 329 }, skus: [{ name: 'SLT11P-W8256', ram: '8G', rom: '256G' }, { name: 'SLT11P-L8256', ram: '8G', rom: '256G' }] },
    { name: 'SonicBuds SE3', fields: { shipLate: '2026/02', seriesGroup: 'Puffin', category: '音频', compositeRrpUsd: 49 } },
    { name: 'SonicArc', fields: { shipLate: '2026/05', seriesGroup: 'Kelp', category: '音频' } },                                          // 缺价·无前代
  ];
  for (const s of seed) await ev("window.RoadmapAPI.upsert(" + JSON.stringify(s) + ")");
  await ev("(function(){ const b=document.getElementById('rmViewChart'); if(b) b.click(); return 1; })()"); await sleep(1500);
  const n0 = await J("JSON.stringify((window.roadmapData().products||[]).length)");
  ok('预置 6 个产品', n0 === 6);

  const axis = async () => (await J("JSON.stringify([...document.querySelectorAll('#rmChart .rmc-ax')].map(n=>n.textContent).filter(t=>/^-?\\d+$/.test(t)).map(Number))")) || [];
  const boxes = async () => (await J("JSON.stringify([...document.querySelectorAll('#rmChart .rmc-box[data-rid]')].map(b=>({t:(b.querySelector('.nm')||{}).textContent, meta:[...b.querySelectorAll('.meta')].map(m=>m.textContent).join('|'), top:parseFloat(b.style.top), missing:b.classList.contains('missing')})))")) || [];
  let ax = await axis(), bx = await boxes();
  console.log('初始轴刻度: ' + JSON.stringify(ax) + '  框数: ' + bx.length);
  ok('自动量程只看产品价(49~329 ⇒ 轴顶≤400)', ax.length >= 2 && Math.max(...ax) <= 400 && Math.min(...ax) >= 0);
  ok('缺价有前代 → 沿用前代价(≈前代)', bx.some(b => /Slate SE 12/.test(b.t) && /≈\$179.*前代/.test(b.meta)));
  const arc = bx.find(b => /SonicArc/.test(b.t)), se3 = bx.find(b => /SonicBuds SE3/.test(b.t));
  ok('缺价无前代 → 标「缺价」且落底部缺价区', !!arc && arc.missing && /缺价/.test(arc.meta) && !!se3 && arc.top > se3.top);
  ok('缺价区提示条出现', (await J("JSON.stringify(/缺价区/.test(document.getElementById('rmChart').innerText))")) === true);

  // Y 量程：单边（只填上限 500）
  await ev("(function(){ const i=document.getElementById('rmYTo'); i.value='500'; i.dispatchEvent(new Event('input',{bubbles:true})); return 1; })()"); await sleep(400);
  ax = await axis(); ok('Y量程只填上限500 → 轴顶=500(单边生效)', ax.length && Math.max(...ax) === 500);
  // 双边 100~200：329 的产品被夹到顶边，49 的夹到底边
  await ev("(function(){ const a=document.getElementById('rmYFrom'); a.value='100'; a.dispatchEvent(new Event('input',{bubbles:true})); const b=document.getElementById('rmYTo'); b.value='200'; b.dispatchEvent(new Event('input',{bubbles:true})); return 1; })()"); await sleep(400);
  ax = await axis(); ok('Y量程 100~200 → 轴刻度 100..200', ax.length && Math.min(...ax) === 100 && Math.max(...ax) === 200);
  // 反写 300~150 → 自动对调
  await ev("(function(){ const a=document.getElementById('rmYFrom'); a.value='300'; a.dispatchEvent(new Event('input',{bubbles:true})); const b=document.getElementById('rmYTo'); b.value='150'; b.dispatchEvent(new Event('input',{bubbles:true})); return 1; })()"); await sleep(400);
  ax = await axis(); ok('Y量程反写 300~150 → 自动对调成 150..300', ax.length && Math.min(...ax) === 150 && Math.max(...ax) === 300);
  ok('量程已持久化', /"manualFrom":"300"/.test(String((await J("JSON.stringify(localStorage.getItem('sb.roadmap.chart.v1'))")) || '')));
  // 自动复位
  await ev("document.getElementById('rmYAuto').click()"); await sleep(500);
  ax = await axis(); ok('「自动」复位 → 回到自动量程', ax.length && Math.max(...ax) <= 400 && (await J("JSON.stringify(document.getElementById('rmYFrom').value)")) === '');

  // 年份筛选
  await ev("(function(){ const s=document.getElementById('rmYear'); s.value='2026'; s.dispatchEvent(new Event('change')); return 1; })()"); await sleep(400);
  bx = await boxes(); ok('年份=2026 → 只剩 2026 上市的产品(3个)', bx.length === 3);
  await ev("(function(){ const s=document.getElementById('rmYear'); s.value=''; s.dispatchEvent(new Event('change')); return 1; })()"); await sleep(300);
  // 型号拆解
  await ev("(function(){ const c=document.getElementById('rmExplode'); c.checked=true; c.dispatchEvent(new Event('change')); return 1; })()"); await sleep(400);
  bx = await boxes(); ok('型号拆解 → 多SKU产品拆成多框(框数>6)', bx.length > 6);
  await ev("(function(){ const c=document.getElementById('rmExplode'); c.checked=false; c.dispatchEvent(new Event('change')); return 1; })()"); await sleep(300);
  // 计价切换：本币出现国家下拉
  await ev("document.getElementById('rmModeLocal').click()"); await sleep(400);
  ok('切「本币」→ 出现国家下拉', (await J("JSON.stringify(!!document.getElementById('rmCountry'))")) === true);
  await ev("document.getElementById('rmModeUsd').click()"); await sleep(400);
  ok('切回 USD → 国家下拉消失', (await J("JSON.stringify(!document.getElementById('rmCountry'))")) === true);
  // 显示样机 + 颜色/透明度 控件存在且可改
  await ev("(function(){ const c=document.getElementById('rmShowSamples'); c.checked=true; c.dispatchEvent(new Event('change')); const col=document.getElementById('rmSampleColor'); col.value='#3355ff'; col.dispatchEvent(new Event('input')); const op=document.getElementById('rmSampleOpacity'); op.value='0.5'; op.dispatchEvent(new Event('input')); return 1; })()"); await sleep(400);
  const sst = await J("JSON.stringify(JSON.parse(localStorage.getItem('sb.roadmap.sampleStyle.v1')||localStorage.getItem('sb.roadmap.samplestyle.v1')||'{}'))");
  ok('样机颜色/透明度已持久化', !!sst && String(sst.color || '').toLowerCase() === '#3355ff' && +sst.opacity === 0.5);
  // 时间范围：起 2026-01-01 → 2025 年的产品被裁掉并提示
  await ev("(function(){ const i=document.getElementById('rmTimeFrom'); i.value='2026-01-01'; i.dispatchEvent(new Event('change')); return 1; })()"); await sleep(600);
  ok('时间起=2026-01 → 提示「N 个产品在时间范围外」', /个产品在时间范围外/.test(String((await J("JSON.stringify(document.getElementById('rmChart').innerText)")) || '')));
  ok('底部滑块显示手动范围', /2026/.test(String((await J("JSON.stringify((document.getElementById('rmTimeSlider')||{}).innerText||'')")) || '')));
  await ev("document.getElementById('rmTimeReset').click()"); await sleep(600);
  ok('「复位」→ 回到全范围', /全范围/.test(String((await J("JSON.stringify((document.getElementById('rmTimeSlider')||{}).innerText||'')")) || '')));
  // 底部滑块存在两个把手
  ok('底部时间滑块两把手存在', (await J("JSON.stringify(!!document.getElementById('rmSldH0') && !!document.getElementById('rmSldH1'))")) === true);
  // ≈FOB 与倍数
  await ev("(function(){ const c=document.getElementById('rmFobEst'); c.checked=true; c.dispatchEvent(new Event('change')); const m=document.getElementById('rmFobMt'); m.value='3'; m.dispatchEvent(new Event('change')); return 1; })()"); await sleep(400);
  const fob = await J("JSON.stringify(JSON.parse(localStorage.getItem('sb.roadmap.fob.v1')||'{}'))");
  ok('≈FOB 开关与倍数持久化', !!fob && fob.on === true && +fob.multTablet === 3);
  await ev("(function(){ const c=document.getElementById('rmFobEst'); c.checked=false; c.dispatchEvent(new Event('change')); return 1; })()");
  // 框样式按钮 → 弹出编辑器
  await ev("document.getElementById('rmBoxStyle').click()"); await sleep(500);
  const bs = await J("JSON.stringify({dlg: !!(document.getElementById('rmDialog') && document.getElementById('rmDialog').style.display==='block'), txt: (document.body.innerText.match(/框样式|填充|字号/g)||[]).length})");
  ok('「框样式…」打开编辑器', !!bs && (bs.dlg || bs.txt >= 2));
  await ev("(function(){ const d=document.getElementById('rmDialog'); if(d){ d.style.display='none'; d.innerHTML=''; } document.querySelectorAll('.rm-modal, .modal').forEach(m=>m.remove()); return 1; })()");
  // 顶部按钮：+产品 / +样机 / +产品系列 弹窗
  for (const [id, label] of [['rmAdd', '+产品'], ['rmAddSample', '+样机'], ['rmAddSeries', '+产品系列']]) {
    await ev("document.getElementById('" + id + "').click()"); await sleep(500);
    const opened = await J("JSON.stringify(!!(document.getElementById('rmDialog') && document.getElementById('rmDialog').style.display==='block' && document.getElementById('rmDialog').innerText.trim().length>0) || !!document.getElementById('rmSerBody') || document.querySelectorAll('.rm-modal,.modal').length>0)");
    ok('「' + label + '」打开弹窗', opened === true);
    await ev("(function(){ const d=document.getElementById('rmDialog'); if(d){ d.style.display='none'; d.innerHTML=''; } const sb=document.getElementById('rmSerBody'); if(sb){ let ov=sb; while(ov.parentElement && ov.parentElement!==document.body) ov=ov.parentElement; ov.remove(); } document.querySelectorAll('.rm-modal,.modal').forEach(m=>m.remove()); return 1; })()"); await sleep(200);
  }
  ok('导出底表/导出PPT/导出JSON/导入JSON 按钮均已绑定', (await J("JSON.stringify(['rmExport','rmExportPpt','rmExportJson'].every(id=>!!document.getElementById(id)) && !!document.getElementById('rmImportJson'))")) === true);
  // 产品框点击 → 编辑弹窗
  await ev("(function(){ const b=[...document.querySelectorAll('#rmChart .rmc-box[data-rid]')].find(x=>/Slate SE 11/.test(x.textContent)); if(b) b.click(); return 1; })()"); await sleep(600);
  const dlgName = await J("JSON.stringify({open: document.getElementById('rmDialog').style.display==='block', name: (document.getElementById('rmF_name')||{}).value||''})");
  ok('点击产品框 → 打开编辑弹窗(产品名已带入)', !!dlgName && dlgName.open === true && /Slate SE 11/.test(dlgName.name));
  await ev("(function(){ const d=document.getElementById('rmDialog'); if(d){ d.style.display='none'; d.innerHTML=''; } return 1; })()");
  // 拖拽改上市月：pointer 事件模拟 Slate SE 10 向右拖 200px
  const drag = await J("(function(){ const host=document.getElementById('rmChart'); const b=[...host.querySelectorAll('.rmc-box[data-rid]')].find(x=>/Slate SE 10/.test(x.textContent)); if(!b) return JSON.stringify({err:'nobox'}); const r=b.getBoundingClientRect(); const x0=r.left+r.width/2, y0=r.top+r.height/2; const fire=(type,x)=>b.dispatchEvent(new PointerEvent(type,{bubbles:true,clientX:x,clientY:y0,button:0,pointerId:1})); fire('pointerdown',x0); fire('pointermove',x0+40); fire('pointermove',x0+200); fire('pointerup',x0+200); return JSON.stringify({ok:true}); })()");
  await sleep(800);
  const moved = await J("JSON.stringify((window.roadmapData().products||[]).find(p=>p.name==='Slate SE 10').shipLate)");
  ok('拖拽产品框 → 上市月改变并落库(原 2025/01 → ' + moved + ')', !!moved && moved !== '2025/01');
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  if (shot.result && shot.result.data) fs.writeFileSync(path.join(__dirname, 'ui-chart-controls.png'), Buffer.from(shot.result.data, 'base64'));
  ws.close(); console.log(fails ? ('FAILURES: ' + fails) : '===== 路标图页全控件 UI ALL PASS ====='); process.exit(fails ? 1 : 0);
})().catch(e => { console.log('FAIL 异常: ' + e.message); process.exit(1); });

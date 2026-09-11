/* SO 推演面板实测
 *  F1-F9  推演本体：五冻结列 / 四行 SISOINVDOS / 按历史SI占比分摊 / 库存与DOS联动 / 不预测
 *  X1-X8  Excel 化：列宽可拖、冻结可开关、单击选中、双击编辑、敲数字即改、
 *         统计条（求和/计数/平均）、口径闸、剪贴板 TSV、Delete 清空
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
  const J = async (e, t) => { const r = await ev(e, t); if (r.err) return { __err: r.err }; try { return JSON.parse(r.v); } catch (x) { return { __raw: r.v }; } };
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

  /* ========== 推演本体 ========== */
  const H = await J("(function(){ const t=document.querySelector('#view-forecast table.fc-table'); if(!t) return JSON.stringify({no:true, msg:(document.querySelector('#view-forecast .fc-empty')||{}).textContent||''}); return JSON.stringify({fz:[...t.querySelectorAll('thead th.fz')].map(x=>x.textContent.replace(/\\s+/g,'').trim())}); })()");
  ok('F1 左侧冻结列齐全（产品名/型号/配置/日销/周销/指标）', H.fz && H.fz.length === 6 && /产品名/.test(H.fz[0]) && /周销/.test(H.fz[4]) && /指标/.test(H.fz[5]), JSON.stringify(H));
  const four = await ev("(function(){ const k=FC.rows[0].key; const rs=[...document.querySelectorAll('#view-forecast tr.fc-prod[data-k=\"'+k+'\"]')].map(r=>r.dataset.m); return JSON.stringify(rs); })()");
  ok('F1b 每个产品四行 SI/SO/INV/DOS', four.v === '["si","so","inv","dos"]', four.v);

  const R = await J("(function(){ const n=document.querySelectorAll('#view-forecast tr.fc-prod.fc-r-si').length; const r=FC.rows[0]; return JSON.stringify({n:n, first: r? {p:r.product, daily:r.daily, weekly:r.weekly, kids:(r.kids||[]).length}:null}); })()");
  ok('F2 有产品行且日销/周销算出来了', (R.n || 0) > 0 && R.first && R.first.daily != null, JSON.stringify(R));
  console.log('   产品数=' + R.n + ' 首行=' + JSON.stringify(R.first));

  const Z = await J("(function(){ const sc=document.getElementById('fcScroll'); if(!sc) return 'no'; const c0=document.querySelector('#view-forecast tbody td.fz1'); const b0=c0.getBoundingClientRect().left; sc.scrollLeft=600; return new Promise(r=>setTimeout(()=>{ const b1=c0.getBoundingClientRect().left; r(JSON.stringify({b0:Math.round(b0), b1:Math.round(b1), scrolled:sc.scrollLeft})); },250)); })()");
  ok('F3 横向滚动后左侧产品列仍冻结在原位', Z.scrolled > 100 && Math.abs(Z.b0 - Z.b1) <= 2, JSON.stringify(Z));
  await ev("document.getElementById('fcScroll').scrollLeft=0; 1");

  await ev("(function(){ const td=document.querySelector('#view-forecast tr.fc-prod td.fz1'); if(td) td.click(); return 1; })()"); await sleep(700);
  const kids = await ev("document.querySelectorAll('#view-forecast tr.fc-model.fc-r-si').length");
  ok('F4 展开产品能看到型号（每型号也是四行）', (+kids.v || 0) > 0, 'model blocks=' + kids.v);

  const S = await J("(function(){ const p=FC.rows.find(x=>x.expanded)||FC.rows[0]; p.expanded=true;"
    + " const i=FC.firstFcIdx; FC.edits[p.key]={}; FC.edits[p.key][i]={so:1000}; fcRender();"
    + " const calc=fcComputeProduct(p); const kids=(p.kids||[]).map(k=>({m:k.model, si:k.histSi, so:calc.byModel[k.key][i].so}));"
    + " const sum=kids.reduce((a,k)=>a+k.so,0);"
    + " return JSON.stringify({product:p.product, total:calc.product[i].so, sum:sum, kids:kids.slice(0,4), shares:calc.shares}); })()");
  ok('F5 产品 SO=1000 分摊到型号且和恰好=1000', S.sum === 1000 && S.total === 1000, JSON.stringify(S));
  console.log('   分摊: ' + JSON.stringify(S.kids) + ' 占比=' + JSON.stringify(S.shares));

  // SO 两档都要留在「库存还是正的」区间里：库存被拍成负数时 DOS 按设计给 null
  // （负的可供天数没有意义），拿 null 去比大小只会测出一个假故障
  const D = await J("(function(){ const p=FC.rows.find(x=>x.expanded)||FC.rows[0]; const i=FC.firstFcIdx;"
    + " FC.edits={}; const inv0=fcComputeProduct(p).product[i-1].inv;"
    + " const so1=Math.max(1,Math.round(inv0*0.05)), so2=Math.round(inv0*0.30);"
    + " FC.edits[p.key]={}; FC.edits[p.key][i]={so:so1,si:0}; const a=fcComputeProduct(p).product[i];"
    + " FC.edits[p.key]={}; FC.edits[p.key][i]={so:so2,si:0}; const b=fcComputeProduct(p).product[i];"
    + " FC.edits={};"
    + " return JSON.stringify({so1:so1, so2:so2, inv0:inv0, lowSo_dos:a.dos, highSo_dos:b.dos, hiInv:b.inv}); })()");
  ok('F6 SO 调大 → DOS 变小（DOS 跟着推演变）', D.lowSo_dos != null && D.highSo_dos != null && D.hiInv > 0 && D.highSo_dos < D.lowSo_dos, JSON.stringify(D));
  // 超卖到库存为负时，DOS 必须是「—」，不能给负的可供天数
  const D2 = await J("(function(){ const p=FC.rows[0]; const i=FC.firstFcIdx;"
    + " FC.edits={}; const inv0=fcComputeProduct(p).product[i-1].inv;"
    + " FC.edits[p.key]={}; FC.edits[p.key][i]={so:Math.round(inv0*3)+1000,si:0};"
    + " const r=fcComputeProduct(p).product[i]; FC.edits={};"
    + " return JSON.stringify({inv:r.inv, dos:r.dos}); })()");
  ok('F6b 拍到超卖（库存为负）时 DOS 给 null，不给负的可供天数', D2.inv < 0 && D2.dos === null, JSON.stringify(D2));

  const CA = await J("(function(){ const p=FC.rows[0]; const i=FC.firstFcIdx;"
    + " FC.edits[p.key]={}; FC.edits[p.key][i]={so:100}; const lo=fcComputeProduct(p).product[i];"
    + " FC.edits[p.key]={}; FC.edits[p.key][i]={so:9000}; const hi=fcComputeProduct(p).product[i];"
    + " FC.edits={};"
    + " return JSON.stringify({loInv:lo.inv, hiInv:hi.inv, loSi:lo.si, hiSi:hi.si, loDos:lo.dos, hiDos:hi.dos}); })()");
  ok('F9 只调 SO → 库存跟着变（SO 大则库存低）', CA.hiInv != null && CA.loInv != null && CA.hiInv < CA.loInv, JSON.stringify(CA));
  ok('F9b SI 不随 SO 变（两次 SI 相同）', CA.loSi === CA.hiSi, JSON.stringify({ loSi: CA.loSi, hiSi: CA.hiSi }));

  const NP = await J("(function(){ FC.edits={}; fcRender(); const p=FC.rows[0]; const i=FC.firstFcIdx; const c=fcComputeProduct(p);"
    + " const lastHist=c.product[i-1]; const f=c.product[i];"
    + " const cells=[...document.querySelectorAll('#view-forecast tr.fc-prod[data-k=\"'+p.key+'\"] td[data-ed][data-c=\"'+i+'\"]')].map(x=>x.textContent.trim());"
    + " return JSON.stringify({si:f.si, so:f.so, inv:f.inv, histInv:lastHist?lastHist.inv:null, empty: cells.every(v=>v===''), n:cells.length}); })()");
  ok('F9d 不预测：未填时 SI/SO 为 0，库存停在历史期末', NP.si === 0 && NP.so === 0 && NP.inv === NP.histInv, JSON.stringify(NP));
  ok('F9e 未填的推演格子是空的（不预填数字）', NP.empty === true && (NP.n || 0) > 0, JSON.stringify({ empty: NP.empty, n: NP.n }));

  const dosTxt = await ev("(function(){ const tr=document.querySelector('#view-forecast tr.fc-prod.fc-r-dos'); const td=[...tr.querySelectorAll('td.num')].pop(); return td?td.textContent.trim():''; })()");
  ok('F9c DOS 单元格不含「天」字', !/天/.test(dosTxt.v || ''), 'DOS=' + dosTxt.v);

  const L2 = await J("(function(){ const ths=[...document.querySelectorAll('#view-forecast thead th.per')];"
    + " return JSON.stringify({labels:ths.map(t=>t.querySelector('.lb').textContent.trim()),"
    + " hist:ths.filter(t=>t.classList.contains('hist')).length, firstFc:FC.firstFcIdx, cutoff:FC.cutoff}); })()");
  ok('F8 没有 W+N 这种相对标签', !(L2.labels || []).some(x => /\+/.test(x)), JSON.stringify((L2.labels || []).slice(0, 4)));
  ok('F8b 标签是真实日历（周 2026-Wxx / 月 2026-xx / 日 2026-xx-xx）',
    (L2.labels || []).length > 0 && (L2.labels || []).every(x => /^\d{4}-(W\d{2}|\d{2}(-\d{2})?)$/.test(x)), JSON.stringify((L2.labels || []).slice(0, 4)));
  ok('F8c 左侧有历史实际列', (L2.hist || 0) > 0 && L2.firstFc === L2.hist, JSON.stringify({ hist: L2.hist, firstFc: L2.firstFc }));
  console.log('   期次: ' + JSON.stringify((L2.labels || []).slice(0, 10)) + ' 历史=' + L2.hist + ' 截止=' + L2.cutoff);

  const RO = await J("(function(){ const n=FC.firstFcIdx; const tr=document.querySelector('#view-forecast tr.fc-prod.fc-r-so');"
    + " const tds=[...tr.querySelectorAll('td[data-c]')];"
    + " return JSON.stringify({histEditable:tds.slice(0,n).some(td=>td.dataset.ed), fcAllEditable:tds.slice(n).every(td=>!!td.dataset.ed),"
    + " invEditable:[...document.querySelectorAll('#view-forecast tr.fc-r-inv td[data-c]')].some(td=>td.dataset.ed)}); })()");
  ok('F8d 历史列只读、推演列可改、INV/DOS 不可改', RO.histEditable === false && RO.fcAllEditable === true && RO.invEditable === false, JSON.stringify(RO));

  const ST = await J("(function(){ const p=FC.periods[FC.firstFcIdx]; return JSON.stringify({first:p&&p.label, cutoff:FC.cutoff}); })()");
  ok('F8e 推演从数据截止之后开始', !!ST.first && String(ST.first) > String(ST.cutoff).slice(0, 7), JSON.stringify(ST));

  /* ========== Excel 化 ========== */
  // X1 列宽：把手存在 + 拖动真的改宽 + left 偏移跟着重算（旧实现写死像素，一改就错位）
  const X1 = await J("(function(){"
    + " const t=document.querySelector('#view-forecast table.fc-table');"
    + " const grips=t.querySelectorAll('thead .fc-grip').length;"
    + " const th=t.querySelector('thead th.fz1'), th2=t.querySelector('thead th.fz2');"
    + " const w0=th.getBoundingClientRect().width, l0=th2.getBoundingClientRect().left;"
    + " FC.wFz[0]=w0+90; fcApplyCols();"
    + " const w1=th.getBoundingClientRect().width, l1=th2.getBoundingClientRect().left;"
    + " FC.wFz[0]=w0; fcApplyCols();"
    + " return JSON.stringify({grips:grips, w0:Math.round(w0), w1:Math.round(w1), l0:Math.round(l0), l1:Math.round(l1)}); })()");
  ok('X1 列宽可改：每列表头都有拖拽把手', (X1.grips || 0) === 6 + (L2.labels || []).length, JSON.stringify({ grips: X1.grips, cols: 6 + (L2.labels || []).length }));
  ok('X1b 改第1列宽度后该列真的变宽', Math.abs((X1.w1 - X1.w0) - 90) <= 2, JSON.stringify(X1));
  ok('X1c 后续冻结列的 left 跟着累加（不写死像素）', Math.abs((X1.l1 - X1.l0) - 90) <= 2, JSON.stringify(X1));

  // X1d 自适应：内容比默认列宽长时，自适应后不再被截断
  const X1d = await J("(function(){ FC.wFz[0]=60; fcApplyCols(); const td=document.querySelector('#view-forecast tbody td.fz1');"
    + " const cut=td.scrollWidth>td.clientWidth+1; fcAutoFit(0);"
    + " const td2=document.querySelector('#view-forecast tbody td.fz1');"
    + " return JSON.stringify({cutBefore:cut, cutAfter:td2.scrollWidth>td2.clientWidth+1, w:FC.wFz[0]}); })()");
  ok('X1d 双击把手/列宽自适应能把被截断的内容撑开', X1d.cutBefore === true && X1d.cutAfter === false, JSON.stringify(X1d));
  await ev("fcResetCols(); 1");

  // X2 冻结开关：关掉后左列跟着横向滚，开回来又固定
  const X2 = await J("(function(){ const sc=document.getElementById('fcScroll'); const c0=document.querySelector('#view-forecast tbody td.fz1');"
    + " sc.scrollLeft=0; const base=c0.getBoundingClientRect().left;"
    + " FC.freeze=0; fcApplyCols(); sc.scrollLeft=400;"
    + " return new Promise(r=>setTimeout(()=>{ const off=c0.getBoundingClientRect().left;"
    + "   FC.freeze=6; fcApplyCols();"
    + "   setTimeout(()=>{ const on=c0.getBoundingClientRect().left; sc.scrollLeft=0;"
    + "     r(JSON.stringify({base:Math.round(base), unfrozen:Math.round(off), refrozen:Math.round(on)})); },200); },200)); })()");
  ok('X2 取消冻结后左列跟着横向滚（不再吸附）', Math.abs(X2.unfrozen - X2.base) > 100, JSON.stringify(X2));
  ok('X2b 重新冻结后左列回到原位', Math.abs(X2.refrozen - X2.base) <= 2, JSON.stringify(X2));
  const X2c = await J("(function(){ const s=document.getElementById('fcFreeze'); s.value='0'; s.onchange(); const off=FC.freeze;"
    + " s.value='6'; s.onchange(); return JSON.stringify({off:off, on:FC.freeze, opts:[...s.options].map(o=>o.text)}); })()");
  ok('X2c 工具条有「冻结/不冻结」下拉且能生效', X2c.off === 0 && X2c.on === 6 && /不冻结/.test((X2c.opts || [])[0] || ''), JSON.stringify(X2c));

  // X3 单击选中 / Shift 扩选 / 方向键
  const X3 = await J("(function(){ FC.edits={}; fcRender();"
    + " const td=document.querySelector('#view-forecast td[data-r=\"1\"][data-c=\"'+FC.firstFcIdx+'\"]');"
    + " td.dispatchEvent(new MouseEvent('mousedown',{bubbles:true}));"
    + " const one=document.querySelectorAll('#view-forecast td.sel').length;"
    + " const td2=document.querySelector('#view-forecast td[data-r=\"1\"][data-c=\"'+(FC.firstFcIdx+2)+'\"]');"
    + " td2.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,shiftKey:true}));"
    + " const three=document.querySelectorAll('#view-forecast td.sel').length;"
    + " const cur=document.querySelectorAll('#view-forecast td.cur').length;"
    + " return JSON.stringify({one:one, three:three, cur:cur, stat:(document.getElementById('fcStat')||{}).textContent}); })()");
  ok('X3 单击选中一个格', X3.one === 1, JSON.stringify(X3));
  ok('X3b Shift+单击扩成 1×3 选区，且当前格唯一', X3.three === 3 && X3.cur === 1, JSON.stringify(X3));

  // X4 双击编辑 + 敲数字直接编辑（Excel 行为）
  const X4 = await J("(function(){ const i=FC.firstFcIdx;"
    + " const td=document.querySelector('#view-forecast tr.fc-prod.fc-r-so td[data-c=\"'+i+'\"]');"
    + " td.dispatchEvent(new MouseEvent('mousedown',{bubbles:true}));"
    + " td.dispatchEvent(new MouseEvent('dblclick',{bubbles:true}));"
    + " const ed=document.getElementById('fcEditor'); const opened=ed.classList.contains('on');"
    + " ed.value='777'; ed.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));"
    + " const txt=td.textContent.trim(); const own=td.classList.contains('own');"
    + " return JSON.stringify({opened:opened, txt:txt, own:own, moved:FC.sel.f.r}); })()");
  ok('X4 双击单元格进入编辑', X4.opened === true, JSON.stringify(X4));
  ok('X4b 回车提交，格子显示新值且标为「我填的」', X4.txt === '777' && X4.own === true, JSON.stringify(X4));

  const X5 = await J("(function(){ const i=FC.firstFcIdx+1;"
    + " const td=document.querySelector('#view-forecast tr.fc-prod.fc-r-so td[data-c=\"'+i+'\"]');"
    + " td.dispatchEvent(new MouseEvent('mousedown',{bubbles:true}));"
    + " document.getElementById('fcGrid').dispatchEvent(new KeyboardEvent('keydown',{key:'5',bubbles:true}));"
    + " const ed=document.getElementById('fcEditor'); const seeded=ed.value;"
    + " ed.value='500'; ed.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));"
    + " const k=FC.rows[0].key;"
    + " return JSON.stringify({seeded:seeded, txt:td.textContent.trim(), inv:document.getElementById(k+'@@'+i+'@@inv').textContent, dos:document.getElementById(k+'@@'+i+'@@dos').textContent}); })()");
  ok('X5 选中后直接敲数字即进入编辑（首字符带入）', X5.seeded === '5', JSON.stringify(X5));
  ok('X5b 提交后 INV / DOS 当场跟着变', X5.txt === '500' && X5.inv !== '—' && X5.dos !== '', JSON.stringify(X5));

  // X6 统计条：求和 / 计数 / 平均
  const X6 = await J("(function(){ FC.edits={}; fcRender(); const i=FC.firstFcIdx; const k=FC.rows[0].key;"
    + " FC.edits[k]={}; FC.edits[k][i]={so:100}; FC.edits[k][i+1]={so:200}; FC.edits[k][i+2]={so:300}; fcRender();"
    + " const r=[...FC.grid.keys()].find(x=>FC.grid[x].key===k && FC.grid[x].metric==='so');"
    + " FC.sel.a={r:r,c:i}; FC.sel.f={r:r,c:i+2}; fcPaintSel();"
    + " return JSON.stringify({txt:document.getElementById('fcStat').textContent.replace(/\\s+/g,' '), note:document.getElementById('fcNote').textContent}); })()");
  ok('X6 统计条给出 计数3 / 求和600 / 平均200', /计数\s*3/.test(X6.txt || '') && /求和\s*600/.test(X6.txt || '') && /平均\s*200/.test(X6.txt || ''), JSON.stringify(X6));
  console.log('   统计条: ' + X6.txt);

  // X6b 口径闸：DOS 是比率，不许给求和/平均
  const X6b = await J("(function(){ const i=FC.firstFcIdx; const k=FC.rows[0].key;"
    + " const r=[...FC.grid.keys()].find(x=>FC.grid[x].key===k && FC.grid[x].metric==='dos');"
    + " FC.sel.a={r:r,c:i}; FC.sel.f={r:r,c:i+2}; fcPaintSel();"
    + " return JSON.stringify({txt:document.getElementById('fcStat').textContent.replace(/\\s+/g,' '), note:document.getElementById('fcNote').textContent}); })()");
  ok('X6b 选 DOS 时求和/平均给「—」并说明原因（比率不可加）', /求和\s*—/.test(X6b.txt || '') && /比率/.test(X6b.note || ''), JSON.stringify(X6b));
  const X6c = await J("(function(){ const i=FC.firstFcIdx; const k=FC.rows[0].key;"
    + " const rs=[...FC.grid.keys()].filter(x=>FC.grid[x].key===k);"
    + " FC.sel.a={r:rs[0],c:i}; FC.sel.f={r:rs[3],c:i}; fcPaintSel();"
    + " return JSON.stringify({note:document.getElementById('fcNote').textContent, txt:document.getElementById('fcStat').textContent.replace(/\\s+/g,' ')}); })()");
  ok('X6c 选区跨多个指标时不给合计（SI+DOS 加一起没意义）', /多个指标/.test(X6c.note || '') && /求和\s*—/.test(X6c.txt || ''), JSON.stringify(X6c));

  // X7 剪贴板：从 Excel 粘一片数进来
  const X7 = await J("(function(){ FC.edits={}; fcRender(); const i=FC.firstFcIdx; const k=FC.rows[0].key;"
    + " const r=[...FC.grid.keys()].find(x=>FC.grid[x].key===k && FC.grid[x].metric==='so');"
    + " FC.sel.a=FC.sel.f={r:r,c:i}; fcPaintSel();"
    + " const dt=new DataTransfer(); dt.setData('text/plain','111\\t222\\t333');"
    + " document.getElementById('fcGrid').dispatchEvent(new ClipboardEvent('paste',{clipboardData:dt,bubbles:true}));"
    + " const got=[0,1,2].map(d=>document.getElementById(k+'@@'+(i+d)+'@@so').textContent.trim());"
    + " const dt2=new DataTransfer(); FC.sel.a={r:r,c:i}; FC.sel.f={r:r,c:i+2}; fcPaintSel();"
    + " document.getElementById('fcGrid').dispatchEvent(new ClipboardEvent('copy',{clipboardData:dt2,bubbles:true}));"
    + " return JSON.stringify({pasted:got, copied:dt2.getData('text/plain')}); })()");
  ok('X7 Ctrl+V 把 Excel 的一行 TSV 铺到三个格', JSON.stringify(X7.pasted) === '["111","222","333"]', JSON.stringify(X7));
  ok('X7b Ctrl+C 复制回 TSV（能贴回 Excel）', X7.copied === '111\t222\t333', JSON.stringify(X7.copied));

  // X8 Delete 清空选区（清空后回到「未填」而不是 0）
  const X8 = await J("(function(){ const i=FC.firstFcIdx; const k=FC.rows[0].key;"
    + " const r=[...FC.grid.keys()].find(x=>FC.grid[x].key===k && FC.grid[x].metric==='so');"
    + " FC.sel.a={r:r,c:i}; FC.sel.f={r:r,c:i+2}; fcPaintSel();"
    + " document.getElementById('fcGrid').dispatchEvent(new KeyboardEvent('keydown',{key:'Delete',bubbles:true}));"
    + " const got=[0,1,2].map(d=>document.getElementById(k+'@@'+(i+d)+'@@so').textContent.trim());"
    + " const ed=FC.edits[k]||{}; const left=Object.keys(ed).filter(x=>ed[x] && ed[x].so!=null).length;"
    + " return JSON.stringify({cells:got, leftovers:left}); })()");
  ok('X8 Delete 清空选区，格子回到空（不是写成 0）', JSON.stringify(X8.cells) === '["","",""]' && X8.leftovers === 0, JSON.stringify(X8));

  // X9 粘贴到只读格必须被拒绝并如实告知（不许默默吞掉）
  const X9 = await J("(function(){ FC.edits={}; fcRender(); const k=FC.rows[0].key;"
    + " const r=[...FC.grid.keys()].find(x=>FC.grid[x].key===k && FC.grid[x].metric==='so');"
    + " FC.sel.a=FC.sel.f={r:r,c:0}; fcPaintSel();"          // c=0 是历史实际列（只读）
    + " const dt=new DataTransfer(); dt.setData('text/plain','999');"
    + " document.getElementById('fcGrid').dispatchEvent(new ClipboardEvent('paste',{clipboardData:dt,bubbles:true}));"
    + " return JSON.stringify({cell:document.getElementById(k+'@@0@@so').textContent.trim(), note:document.getElementById('fcNote').textContent}); })()");
  ok('X9 粘到历史实际列被拒绝且提示跳过数量', X9.cell !== '999' && /跳过\s*1/.test(X9.note || ''), JSON.stringify(X9));

  /* ========== 进行中的那一期可编辑（2026-09-10 用户：W36 是 0、现在 W37，W36 没法编辑）========== */
  // 示例数据截止 2026-06-15（周一）→ W25 才过了一天，必须当「进行中」而不是锁死的历史
  const PT = await J("(function(){ const i=FC.firstFcIdx; const p=FC.periods[i]; const prev=FC.periods[i-1];"
    + " const th=[...document.querySelectorAll('#view-forecast thead th.per')][i]; const tag=th?th.querySelector('.tag').textContent:'';"
    + " const k=FC.rows[0].key; const td=document.getElementById(k+'@@'+i+'@@so');"
    + " return JSON.stringify({partial:FC.partial, label:p.label, isPartial:!!p.partial, prevLabel:prev&&prev.label, prevHist:!!(prev&&prev.hist), tag:tag, editable:!!(td&&td.dataset.ed), ph:td&&td.dataset.ph, cutoff:FC.cutoff}); })()");
  ok('C1 截止日落在周中 → 那一周是「进行中」而不是历史', PT.partial === '2026-W25' && PT.isPartial === true && PT.label === '2026-W25', JSON.stringify(PT));
  ok('C1b 进行中那周的 SI/SO 可编辑，表头标「进行中·可改」', PT.editable === true && /进行中/.test(PT.tag || ''), JSON.stringify(PT));
  ok('C1c 前一周仍是完整历史（实际值锁死）', PT.prevLabel === '2026-W24' && PT.prevHist === true, JSON.stringify(PT));
  ok('C1d 到目前为止的实际值只做占位提示（灰字），不填不算数', PT.ph != null && PT.ph !== '', 'ph=' + PT.ph);
  const PT2 = await J("(function(){ FC.edits={}; fcRender(); const i=FC.firstFcIdx; const p=FC.rows[0]; const c0=fcComputeProduct(p);"
    + " const histInv=c0.product[i-1].inv; const untouched=c0.product[i].inv;"
    + " FC.edits[p.key]={}; FC.edits[p.key][i]={so:300, si:100}; const c1=fcComputeProduct(p); FC.edits={};"
    + " return JSON.stringify({histInv:histInv, untouched:untouched, filled:c1.product[i].inv}); })()");
  ok('C1e 进行中那周不填 → 库存停在上一完整周的实际值；填了 → 从它起滚', PT2.untouched === PT2.histInv && PT2.filled === PT2.histInv + 100 - 300, JSON.stringify(PT2));

  /* ========== 产品 / 型号 / 国家三个视图都真的能用（2026-09-10 用户：「都是坏的按键」）========== */
  const clickView = async v => { await ev("(function(){ const b=document.querySelector('#view-forecast [data-fcv=\"" + v + "\"]'); if(b) b.click(); return 1; })()"); for (let i = 0; i < 40; i++) { const r = await ev("FC.loading===false && FC.loaded===true && FC.view==='" + v + "'"); if (r.v === true) break; await sleep(500); } await sleep(500); };
  await clickView('model');
  const VM = await J("(function(){ const ths=[...document.querySelectorAll('#view-forecast thead th.fz')].map(t=>t.textContent.replace(/\s+/g,''));"
    + " return JSON.stringify({view:FC.view, n:FC.rows.length, allSingle:FC.rows.every(r=>(r.kids||[]).length===1 && r.noKids), h0:ths[0], h1:ths[1], first:FC.rows[0]&&{product:FC.rows[0].product, model:FC.rows[0].model}, carets:document.querySelectorAll('#view-forecast tr.fc-prod .fc-exp:not(:empty)').length}); })()");
  ok('V1 型号视图：每个型号一条顶层行，没有展开箭头', VM.view === 'model' && VM.n > 0 && VM.allSingle === true && VM.carets === 0, JSON.stringify(VM));
  ok('V1b 型号视图列名：产品型号 / 所属产品', /产品型号/.test(VM.h0 || '') && /所属产品/.test(VM.h1 || ''), JSON.stringify([VM.h0, VM.h1]));
  const VM2 = await J("(function(){ const p=FC.rows[0]; const i=FC.firstFcIdx; FC.edits[p.key]={}; FC.edits[p.key][i]={so:500}; const c=fcComputeProduct(p); const k=p.kids[0].key; FC.edits={}; return JSON.stringify({top:c.product[i].so, kid:c.byModel[k][i].so}); })()");
  ok('V1c 型号视图拍数 100% 落到该型号', VM2.top === 500 && VM2.kid === 500, JSON.stringify(VM2));

  await clickView('country');
  const VC = await J("(function(){ const ths=[...document.querySelectorAll('#view-forecast thead th.fz')].map(t=>t.textContent.replace(/\s+/g,''));"
    + " const p=FC.rows[0]; const kids=(p.kids||[]).map(k=>k.model);"
    + " return JSON.stringify({view:FC.view, n:FC.rows.length, h1:ths[1], kids:kids, lab:p.model}); })()");
  // 子行必须是国家：拿引擎的国家取值表来对（fcCountryOpts 只是筛选下拉的缓存，未必齐）
  const CTRY = await J("(async function(){ try{ return JSON.stringify(await api.options('country',{})); }catch(e){ return '[]'; } })()");
  VC.allCountries = (VC.kids || []).length > 0 && (VC.kids || []).every(k => (CTRY || []).indexOf(k) >= 0);
  ok('V2 国家视图：产品下的子行是国家', VC.view === 'country' && VC.allCountries === true && /国家/.test(VC.h1 || '') && /全部国家/.test(VC.lab || ''), JSON.stringify(VC));
  const VC2 = await J("(function(){ const p=FC.rows[0]; p.expanded=true; const i=FC.firstFcIdx; FC.edits[p.key]={}; FC.edits[p.key][i]={so:1000}; fcRender(); const c=fcComputeProduct(p);"
    + " const parts=(p.kids||[]).map(k=>({c:k.model, so:c.byModel[k.key][i].so})); const sum=parts.reduce((a,x)=>a+x.so,0); FC.edits={}; p.expanded=false;"
    + " return JSON.stringify({total:c.product[i].so, sum:sum, parts:parts, shares:c.shares}); })()");
  ok('V2b 产品 SO=1000 按历史 SI 占比分摊到国家，和恰好=1000', VC2.total === 1000 && VC2.sum === 1000 && (VC2.parts || []).length >= 1, JSON.stringify(VC2));
  console.log('   国家分摊: ' + JSON.stringify(VC2.parts));
  await clickView('product');
  const VP = await J("JSON.stringify({view:FC.view, hasKids:FC.rows.every(r=>(r.kids||[]).length>=1 && !r.noKids)})");
  ok('V3 切回产品视图正常', VP.view === 'product' && VP.hasKids === true, JSON.stringify(VP));

  /* ========== 产品线 / 系列 筛选（2026-09-10 用户：没法选 Product line）========== */
  const LN = await J("(function(){ const s=document.getElementById('fcLine'), se=document.getElementById('fcSeries'), c=document.getElementById('fcCountry');"
    + " const opt=x=>x?[...x.options].map(o=>o.value).filter(Boolean):null; return JSON.stringify({line:opt(s), series:opt(se), country:opt(c)}); })()");
  ok('L1 工具条有产品线/系列/国家三个下拉且都有取值', (LN.line || []).length > 0 && (LN.series || []).length > 0 && (LN.country || []).length > 0, JSON.stringify(LN));
  const pickLine = (LN.line || [])[0];
  await ev("(function(){ const s=document.getElementById('fcLine'); s.value=" + JSON.stringify(pickLine) + "; s.onchange(); return 1; })()");
  for (let i = 0; i < 40; i++) { const r = await ev("FC.loading===false && FC.loaded===true && FC.line===" + JSON.stringify(pickLine)); if (r.v === true) break; await sleep(500); }
  await sleep(400);
  const LN2 = await J("(async function(){ const inLine=new Set(await api.options('product',{line:[FC.line]})); const prods=FC.rows.map(r=>r.product);"
    + " const se=[...document.getElementById('fcSeries').options].map(o=>o.value).filter(Boolean); const seIn=new Set(await api.options('series',{line:[FC.line]}));"
    + " return JSON.stringify({line:FC.line, n:prods.length, allInLine:prods.length>0 && prods.every(p=>inLine.has(p)), seriesCascaded: se.length>0 && se.every(x=>seIn.has(x)), prods:prods.slice(0,5)}); })()");
  ok('L2 选了产品线后只剩该线的产品', LN2.allInLine === true, JSON.stringify(LN2));
  ok('L3 系列下拉按产品线级联', LN2.seriesCascaded === true, JSON.stringify(LN2));
  await ev("(function(){ const s=document.getElementById('fcLine'); s.value=''; s.onchange(); return 1; })()");
  for (let i = 0; i < 40; i++) { const r = await ev("FC.loading===false && FC.loaded===true && FC.line===''"); if (r.v === true) break; await sleep(500); }
  const LN3 = await J("JSON.stringify({n:FC.rows.length})");
  ok('L4 清掉产品线后产品全部回来', LN3.n > LN2.n, JSON.stringify({ all: LN3.n, filtered: LN2.n }));

  /* ========== 编辑框必须盖在目标格上（2026-09-10 用户截图：横向滚动后输入框偏到几列之外）========== */
  const EDP = await J("(function(){ FC.edits={}; fcRender(); const sc=document.getElementById('fcScroll'); sc.scrollLeft=420; sc.scrollTop=60;"
    + " const i=FC.firstFcIdx+3; const td=document.querySelector('#view-forecast tr.fc-prod.fc-r-so td[data-c=\"'+i+'\"]');"
    + " td.dispatchEvent(new MouseEvent('mousedown',{bubbles:true})); td.dispatchEvent(new MouseEvent('dblclick',{bubbles:true}));"
    + " const ed=document.getElementById('fcEditor'); const a=td.getBoundingClientRect(), b=ed.getBoundingClientRect();"
    + " const r={dx:Math.round(b.left-a.left), dy:Math.round(b.top-a.top), dw:Math.round(b.width-a.width), scrolled:sc.scrollLeft, on:ed.classList.contains('on')};"
    + " ed.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})); sc.scrollLeft=0; sc.scrollTop=0; return JSON.stringify(r); })()");
  ok('E1 横向/纵向滚动后，编辑框仍精确盖在被编辑的格子上', EDP.on === true && Math.abs(EDP.dx) <= 1 && Math.abs(EDP.dy) <= 1 && Math.abs(EDP.dw) <= 1, JSON.stringify(EDP));

  /* ========== 粒度切换 ========== */
  await ev("(function(){ FC.edits={}; const b=document.querySelector('#view-forecast [data-fcg=\"month\"]'); if(b) b.click(); return 1; })()");
  for (let i = 0; i < 40; i++) { const r = await ev("FC.loading===false && FC.loaded===true && FC.gran==='month'"); if (r.v === true) break; await sleep(1000); }
  await sleep(800);
  const G = await J("JSON.stringify({gran:FC.gran, cols:document.querySelectorAll('#view-forecast thead th.per').length, grips:document.querySelectorAll('#view-forecast .fc-grip').length})");
  ok('F7 可切按月，期次列随之生成', G.gran === 'month' && (G.cols || 0) >= 1, JSON.stringify(G));
  ok('F7b 换粒度后列宽把手仍然全在（渲染没漏绑）', (G.grips || 0) === 6 + (G.cols || 0), JSON.stringify(G));
  await shot('ui-forecast.png');

  ws.close(); console.log(fails ? ('FAILURES: ' + fails) : '===== SO 推演面板 ALL PASS ====='); process.exit(fails ? 1 : 0);
})();

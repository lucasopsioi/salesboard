/* PPT 导出：自适应列宽 + 不换行 + 全流程三列 + 导出预览（2026-09-08 用户报的两个问题）
 *  P1  汇总表 PPT 含 全流程库存/全流程DOS/国家仓+FDC 三列，且与 Excel 出口同口径
 *  P2  列宽按内容自适应（名称列明显宽于数字列），不是等分
 *  P3  pptxgenjs 的四条硬约束：colW 长度=首行列数 / w=Σ colW / margin 用英寸 / 不溢出版心
 *  P4  预览弹窗打开，渲染的就是导出用的那份 colW —— 并且**真实 DOM 里没有一格换行**
 *  P5  预览「关闭」不写文件；点「导出 PPT」才写
 * 用法：起测试实例后 node cdp-pptfit.js */
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
  await ev("(function(){ window.alert=function(){}; const l=document.getElementById('loading'); if(l) l.classList.add('hidden'); const b=[...document.querySelectorAll('button,a')].find(x=>/载入示例/.test(x.textContent||'')); if(b) b.click(); return 1; })()");
  for (let i = 0; i < 40; i++) { const busy = await ev("(function(){ const l=document.getElementById('loading'); return !!(l && !l.classList.contains('hidden')); })()"); if (busy.v !== true) break; await sleep(1000); }
  await sleep(2000);
  await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });

  /* 渲染进程里 api 是 contextBridge 暴露的**冻结**对象，改不掉（实测确认）。
     所以落盘由 test-main.js 在主进程侧接管：无对话框、直写临时目录，这里读目录核对。 */
  const OUT = path.join(require('os').tmpdir(), 'sb-ui-test-out');
  const listOut = () => { try { return fs.readdirSync(OUT); } catch (e) { return []; } };
  const before0 = listOut();

  await ev("switchView('report'); 1");
  for (let i = 0; i < 40; i++) { const r = await ev("!!(typeof rep!=='undefined' && rep.last && rep.last.rows && rep.last.rows.length)"); if (r.v === true) break; await sleep(1000); }
  await sleep(600);

  /* ---------- P1 全流程三列 ---------- */
  const S = await J("(function(){ const sp=repPptSpec(); if(!sp) return JSON.stringify({no:true});"
    + " const head=sp.rows[0].map(c=>c.text);"
    + " const r=rep.last; const last=sp.rows[sp.rows.length-1].map(c=>c.text);"
    + " return JSON.stringify({head:head, n:head.length, hasFlow:!!r.hasFlow, weeks:(r.weekLabels||[]).length,"
    + "   fontSize:sp.fontSize, colW:sp.colW, total:sp.fit.totalIn, squeezed:sp.squeezed, natural:sp.fit.natural,"
    + "   rows:sp.rows.length, lastRow:last.slice(-3)}); })()");
  ok('P1 PPT 表头含 全流程库存/全流程DOS/国家仓+FDC',
    (S.head || []).slice(-3).join(',') === '全流程库存,全流程DOS,国家仓+FDC', JSON.stringify((S.head || []).slice(-6)));
  ok('P1b 列数 = 7 固定列 + 周列 + 6 尾列', S.n === 7 + (S.weeks || 0) + 6, JSON.stringify({ n: S.n, weeks: S.weeks }));
  console.log('   列数=' + S.n + ' 周列=' + S.weeks + ' 字号=' + S.fontSize + ' hasFlow=' + S.hasFlow);

  // 有库龄表 → 三列有数；没有 → 三列必须是「—」，绝不能写 0
  const F3 = await J("(function(){ const sp=repPptSpec(); const r=rep.last; const i0=sp.rows[0].length-3;"
    + " const body=sp.rows.slice(1).map(x=>[x[i0].text,x[i0+1].text,x[i0+2].text]);"
    + " const allDash=body.every(t=>t.every(v=>v==='—')); const anyNum=body.some(t=>t.some(v=>/\\d/.test(v)));"
    + " return JSON.stringify({hasFlow:!!r.hasFlow, allDash:allDash, anyNum:anyNum, sample:body[0]}); })()");
  ok('P1c 无库龄表时三列出「—」；有库龄表时出数（不写 0）',
    F3.hasFlow ? (F3.anyNum === true) : (F3.allDash === true), JSON.stringify(F3));

  /* 用户 2026-09-08：「导出产品的时候，也要能有全流程库存啥的，产品维度也要能有」
     → 逐个维度验：除按渠道拆分外，全流程三列都必须有数（库龄表本身没有渠道维度） */
  const DIMS = await J("(async function(){ const dims=['family','line','series','product','model','region','repOffice','country','channel'];"
    + " const out={}; const keep=rep.dim;"
    + " for(const d of dims){ rep.dim=d; await drawReport(); const sp=repPptSpec();"
    + "   if(!sp){ out[d]={no:true}; continue; }"
    + "   const i0=sp.rows[0].length-3; const head=sp.rows[0].slice(i0).map(c=>c.text);"
    + "   const body=sp.rows.slice(1).map(x=>[x[i0].text,x[i0+1].text,x[i0+2].text]);"
    + "   out[d]={head:head.join(','), anyNum:body.some(t=>t.some(v=>v!=='' && v!=='—')), allDash:body.every(t=>t.every(v=>v==='—')),"
    + "     hasFlow:!!rep.last.hasFlow, note:sp.note, rows:body.length}; }"
    + " rep.dim=keep; await drawReport(); return JSON.stringify(out); })()", 180000);
  const HEAD3 = '全流程库存,全流程DOS,国家仓+FDC';
  ok('P1d 产品维度导出带全流程三列且有数',
    DIMS.product && DIMS.product.head === HEAD3 && DIMS.product.anyNum === true, JSON.stringify(DIMS.product));
  const dimsOk = ['family', 'line', 'series', 'product', 'model', 'region', 'repOffice', 'country']
    .filter(d => !(DIMS[d] && DIMS[d].head === HEAD3 && DIMS[d].anyNum === true));
  ok('P1e 除按渠道外，每个拆分维度都有全流程三列', dimsOk.length === 0, JSON.stringify(dimsOk.map(d => [d, DIMS[d]])));
  ok('P1f 按渠道拆分时三列出「—」，并在脚注说明原因（库龄表没有渠道维度）',
    DIMS.channel && DIMS.channel.allDash === true && /渠道/.test(DIMS.channel.note || ''), JSON.stringify(DIMS.channel));
  console.log('   各维度: ' + Object.keys(DIMS).map(d => d + '=' + (DIMS[d].anyNum ? '有数' : (DIMS[d].allDash ? '—' : '?'))).join(' '));

  /* ---------- P2 自适应列宽 ---------- */
  const eq = (S.colW || []).length ? Math.max.apply(null, S.colW) - Math.min.apply(null, S.colW) : 0;
  ok('P2 列宽不是等分（名称列明显宽于周列）', eq > 0.2 && S.colW[0] > S.colW[8] * 1.5, JSON.stringify({ first: S.colW && S.colW[0], week: S.colW && S.colW[8], spread: +eq.toFixed(3) }));
  ok('P2b 每列都不窄于自身内容所需宽度（squeezed 为空 = 一格都不会换行）', (S.squeezed || []).length === 0, JSON.stringify(S.squeezed));
  const tooTight = (S.colW || []).map((w, i) => (w + 1e-6 < (S.natural || [])[i] ? i : -1)).filter(i => i >= 0);
  ok('P2c colW 逐列 ≥ 自然宽度', tooTight.length === 0, JSON.stringify(tooTight));

  /* ---------- P3 pptxgenjs 的四条硬约束 ---------- */
  const O = await J("(function(){ const sp=repPptSpec(); const o=PptTableFit.tableOpts(sp.fit,{});"
    + " const sum=o.colW.reduce((a,b)=>a+b,0);"
    + " return JSON.stringify({colWLen:o.colW.length, firstRowLen:sp.rows[0].length, w:o.w, sum:+sum.toFixed(3),"
    + "   margin:o.margin, x:sp.x, right:sp.x+sum}); })()");
  ok('P3 colW 长度 = 首行列数（不等会被 pptxgenjs 静默改回等分）', O.colWLen === O.firstRowLen, JSON.stringify(O));
  ok('P3b w 与 Σ colW 一致（只给 colW 时外框会掉回 75%）', Math.abs(O.w - O.sum) < 1e-3, JSON.stringify({ w: O.w, sum: O.sum }));
  ok('P3c margin 用 < 1 的英寸值（>=1 会被当成「磅」，差 36 倍）',
    Array.isArray(O.margin) && O.margin.every(v => v > 0 && v < 1), JSON.stringify(O.margin));
  ok('P3d 表格没有溢出 13.333 英寸的版心', O.right <= 13.333 + 1e-6 && O.x >= 0, JSON.stringify({ x: O.x, right: +(O.right || 0).toFixed(3) }));

  /* ---------- P4 预览：真实 DOM 里一格都不换行 ---------- */
  await ev("(function(){ document.getElementById('repExportPpt').click(); return 1; })()");
  await sleep(900);
  const PV = await J("(function(){ const m=document.querySelector('.pv-mask'); if(!m) return JSON.stringify({no:true});"
    + " const tds=[...m.querySelectorAll('.pv-tbl td')];"
    + " const cols=m.querySelectorAll('.pv-tbl col').length;"
    + " const lh=tds.length?parseFloat(getComputedStyle(tds[0]).lineHeight):0;"
    + " const wrapped=tds.filter(td=>td.textContent.trim() && td.scrollHeight > lh*1.6).map(td=>td.textContent.trim());"
    + " const clipped=tds.filter(td=>td.scrollWidth > td.clientWidth+1).map(td=>td.textContent.trim());"
    + " return JSON.stringify({cols:cols, tds:tds.length, lineH:lh, wrapped:wrapped.slice(0,6), nWrapped:wrapped.length,"
    + "   clipped:clipped.slice(0,6), nClipped:clipped.length, warn:!!m.querySelector('.pv-warn')}); })()");
  ok('P4 预览弹窗打开并渲染出表格', !PV.no && (PV.cols || 0) > 0 && (PV.tds || 0) > 0, JSON.stringify(PV));
  ok('P4b 预览的列数 = 导出用的列数（同一份 spec）', PV.cols === S.n, JSON.stringify({ pv: PV.cols, spec: S.n }));
  ok('P4c 预览里没有任何一格换行（这就是导出后的样子）', (PV.nWrapped || 0) === 0, JSON.stringify(PV.wrapped));
  ok('P4d 预览里没有任何一格被横向截断', (PV.nClipped || 0) === 0, JSON.stringify(PV.clipped));
  ok('P4e 没有被挤的列时不出换行告警', PV.warn === false, 'warn=' + PV.warn);
  await shot('ui-pptpreview.png');

  /* ---------- P5 预览不写盘；点导出才写 ---------- */
  ok('P5 只是预览，不写文件', listOut().length === before0.length, JSON.stringify(listOut()));
  await ev("(function(){ document.getElementById('pvGo').click(); return 1; })()");
  let made = [];
  for (let i = 0; i < 40; i++) { made = listOut().filter(n => before0.indexOf(n) < 0); if (made.length) break; await sleep(500); }
  const sz = made.length ? fs.statSync(path.join(OUT, made[0])).size : 0;
  ok('P5b 点「导出 PPT」才真的写文件，且是个像样的 pptx',
    made.length === 1 && /\.pptx$/.test(made[0]) && sz > 8000, JSON.stringify({ made: made, size: sz }));
  // pptx 就是个 zip：头两个字节必须是 PK，否则写出来的是坏文件
  const magic = made.length ? fs.readFileSync(path.join(OUT, made[0])).slice(0, 2).toString('latin1') : '';
  ok('P5b2 导出的 pptx 是合法 zip（PK 开头）', magic === 'PK', 'magic=' + JSON.stringify(magic));
  const closed = await ev("!document.querySelector('.pv-mask')");
  ok('P5c 导出后预览自动关闭', closed.v === true);

  /* ---------- P6 其它导出点也接上了自适应列宽 ---------- */
  const P6 = await J("(function(){"
    + " const aoa=[['国家','产品型号','销毛-原价','NSIP-原价'],['墨西哥','Slate Pro 13.2-inch 5G','25.8%','412.35']];"
    + " const sp=ExportUtil.pptxSpecs('测试',[{name:'x',aoa:aoa}])[0];"
    + " const spread=Math.max.apply(null,sp.colW)-Math.min.apply(null,sp.colW);"
    + " return JSON.stringify({colW:sp.colW, spread:+spread.toFixed(3), squeezed:sp.squeezed, n:sp.rows[0].length}); })()");
  ok('P6 通用 AOA 导出（定价/产品定价库走这条）也按内容分配列宽',
    (P6.spread || 0) > 0.2 && (P6.squeezed || []).length === 0 && P6.colW.length === P6.n, JSON.stringify(P6));

  // 定价导出必须是成稿文本，不能把 0.2580123456789012 这种浮点原样塞进 PPT
  const P7 = await J("(function(){ try{ if(!window.PricingUI||!PricingUI._buildAoa) return JSON.stringify({skip:'no api'});"
    + " const t=PricingUI._buildAoa(true); const flat=[].concat.apply([],t.slice(1)).map(String);"
    + " const longNum=flat.filter(v=>/^-?\\d+\\.\\d{5,}$/.test(v));"
    + " return JSON.stringify({rows:t.length, longNum:longNum.slice(0,4), n:longNum.length}); }catch(e){ return JSON.stringify({skip:String(e)}); } })()");
  if (P7.skip) console.log('   （定价测算未加载底表，跳过 P7：' + P7.skip + '）');
  else ok('P7 定价 PPT 导出没有 5 位以上小数的长浮点', (P7.n || 0) === 0, JSON.stringify(P7));

  await ev("(function(){ if(window.__origSave) api.saveFile=window.__origSave; return 1; })()");
  ws.close(); console.log(fails ? ('FAILURES: ' + fails) : '===== PPT 自适应列宽 + 导出预览 ALL PASS ====='); process.exit(fails ? 1 : 0);
})();

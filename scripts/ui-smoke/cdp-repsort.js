/* 汇总表：每一列都能点表头排序（2026-09-08 用户：「每一列都要能按列排序，正序或者倒序」）
 *  S1 22 列表头全部常驻可点（不用先开「自定义排序」开关）
 *  S2 数值列：点一下降序、再点升序、第三下回默认（三态闭环）
 *  S3 文本列（维度名）按中文升→降
 *  S4 全流程三列同样能排
 *  S5 合计行永远钉在最后，不参与排序
 *  S6 所见即所出：排完序导出的行序 == 界面行序
 * 用法：起测试实例后 node cdp-repsort.js */
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
  await ev("switchView('report'); 1");
  for (let i = 0; i < 40; i++) { const r = await ev("!!(typeof rep!=='undefined' && rep.last && rep.last.rows && rep.last.rows.length)"); if (r.v === true) break; await sleep(1000); }
  // 用「型号」维度：行多，排序好验
  await ev("(async function(){ rep.custom=false; rep.dim='model'; await drawReport(); return 1; })()", 120000);
  await sleep(500);

  /* 页面里的取数小工具：把某列的可见值按行序取出来（跳过合计行） */
  const COLVALS = "(function(k){ const tbl=document.getElementById('repTable');"
    + " const ths=[...tbl.querySelectorAll('tr:first-child th')]; const ci=ths.findIndex(t=>t.dataset.k===k);"
    + " const trs=[...tbl.querySelectorAll('tr')].slice(1).filter(tr=>!tr.classList.contains('total'));"
    + " return trs.map(tr=>tr.children[ci].textContent.trim()); })";
  const num = v => { const t = String(v).replace(/[,%\s]/g, ''); return (t === '' || t === '—' || t === '-') ? null : (isFinite(+t) ? +t : null); };
  const monotone = (arr, dir) => { const v = arr.map(num).filter(x => x != null); for (let i = 1; i < v.length; i++) { if (dir < 0 ? v[i] > v[i - 1] + 1e-9 : v[i] < v[i - 1] - 1e-9) return false; } return v.length > 1; };

  const H = await J("(function(){ const ths=[...document.querySelectorAll('#repTable tr:first-child th')].slice(1);"
    + " return JSON.stringify({n:ths.length, sortable:ths.filter(t=>t.classList.contains('sortable')).length,"
    + "  keys:ths.map(t=>t.dataset.k), hint:ths.filter(t=>t.querySelector('.ts-hint')).length}); })()");
  ok('S1 每一列表头都可点（不用先开开关）', H.n > 0 && H.sortable === H.n, JSON.stringify({ n: H.n, sortable: H.sortable }));
  ok('S1b 非当前排序列都带 ⇅ 提示', H.hint === H.n, JSON.stringify({ hint: H.hint, n: H.n }));
  console.log('   列数=' + H.n + ' 列键=' + JSON.stringify((H.keys || []).slice(0, 8)) + '…');

  const click = async k => { await ev("(function(){ const t=[...document.querySelectorAll('#repTable tr:first-child th')].find(x=>x.dataset.k==='" + k + "'); if(t) t.click(); return 1; })()"); await sleep(250); };
  const vals = async k => (await J("JSON.stringify(" + COLVALS + "('" + k + "'))"));

  const defOrder = await vals('key');

  /* ---------- S2 数值列三态 ---------- */
  const NUMKEYS = ['cumCur', 'yoy', 'siCur', 'wow', 'inv', 'dos'];
  for (const k of NUMKEYS) {
    await ev("(function(){ rep.custom=false; rep.sortKey=null; renderReportTable(); return 1; })()");
    await click(k); const d1 = await vals(k);
    await click(k); const d2 = await vals(k);
    await click(k); const d3 = await vals('key');
    ok('S2 「' + k + '」点一下降序', monotone(d1, -1), JSON.stringify(d1.slice(0, 6)));
    ok('S2b 「' + k + '」再点升序', monotone(d2, 1), JSON.stringify(d2.slice(0, 6)));
    ok('S2c 「' + k + '」第三下回默认排序', JSON.stringify(d3) === JSON.stringify(defOrder), JSON.stringify({ back: d3.slice(0, 3), def: defOrder.slice(0, 3) }));
  }

  /* ---------- S3 文本列 ---------- */
  await ev("(function(){ rep.custom=false; rep.sortKey=null; renderReportTable(); return 1; })()");
  await click('key'); const t1 = await vals('key');
  await click('key'); const t2 = await vals('key');
  const zhAsc = a => { const b = a.slice().sort((x, y) => String(x).localeCompare(String(y), 'zh')); return JSON.stringify(a) === JSON.stringify(b); };
  ok('S3 文本列首点升序（中文序）', zhAsc(t1), JSON.stringify(t1.slice(0, 4)));
  ok('S3b 文本列再点降序', JSON.stringify(t2) === JSON.stringify(t1.slice().reverse()), JSON.stringify(t2.slice(0, 4)));

  /* ---------- S4 全流程三列 ---------- */
  for (const k of ['flowInv', 'flowDos', 'dcfdc']) {
    await ev("(function(){ rep.custom=false; rep.sortKey=null; renderReportTable(); return 1; })()");
    await click(k); const a = await vals(k);
    await click(k); const b = await vals(k);
    ok('S4 全流程列「' + k + '」可降可升', monotone(a, -1) && monotone(b, 1), JSON.stringify({ desc: a.slice(0, 4), asc: b.slice(0, 4) }));
  }

  /* ---------- S5 合计行不参与排序 ---------- */
  const TOT = await J("(function(){ const trs=[...document.querySelectorAll('#repTable tr')];"
    + " const i=trs.findIndex(t=>t.classList.contains('total'));"
    + " return JSON.stringify({idx:i, last:i===trs.length-1, n:trs.length}); })()");
  ok('S5 合计行永远钉在最后', TOT.last === true, JSON.stringify(TOT));

  /* ---------- S6 所见即所出：导出跟着排 ---------- */
  await ev("(function(){ rep.custom=false; rep.sortKey=null; renderReportTable(); return 1; })()");
  await click('inv'); // 按库存降序
  const SEEN = await J("(function(){ const dom=" + COLVALS + "('key');"
    + " const sp=repPptSpec(); const ppt=sp.rows.slice(1,-1).map(r=>r[0].text);"
    + " const cols=repColumns(rep.last); const xls=repVisibleRows(rep.last.rows,cols).map(o=>o.key);"
    + " return JSON.stringify({dom:dom, ppt:ppt, xls:xls}); })()");
  ok('S6 排序后 PPT 导出的行序 = 界面行序', JSON.stringify(SEEN.ppt) === JSON.stringify(SEEN.dom), JSON.stringify({ dom: (SEEN.dom || []).slice(0, 4), ppt: (SEEN.ppt || []).slice(0, 4) }));
  ok('S6b Excel 出口同序', JSON.stringify(SEEN.xls) === JSON.stringify(SEEN.dom), JSON.stringify((SEEN.xls || []).slice(0, 4)));

  /* ---------- S7 「恢复默认排序」按钮 ---------- */
  const B = await J("(function(){ const b=document.getElementById('repCustomSort');"
    + " const on={txt:b.textContent, disabled:b.disabled}; b.click();"
    + " const off={txt:b.textContent, disabled:b.disabled, custom:rep.custom, order:" + COLVALS + "('key')};"
    + " return JSON.stringify({on:on, off:off}); })()");
  ok('S7 有自选排序时按钮可点且显示当前列', B.on && /恢复默认/.test(B.on.txt) && B.on.disabled === false, JSON.stringify(B.on));
  ok('S7b 点一下回到默认排序，按钮随即置灰', B.off && B.off.custom === false && B.off.disabled === true
    && JSON.stringify(B.off.order) === JSON.stringify(defOrder), JSON.stringify(B.off));

  await shot('ui-repsort.png');
  ws.close(); console.log(fails ? ('FAILURES: ' + fails) : '===== 汇总表按列排序 ALL PASS ====='); process.exit(fails ? 1 : 0);
})();

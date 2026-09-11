/* 本机能力 UI 实测（真模型）：
 *  A) 大文件不截断：20 万行文本，唯一标记在第 150000 行 → 问 AI「哪一行含 ZEBRA-9981」→ 答案含 150000（证明走了 docSearch 全文索引）
 *  B) Claude Code 式改 Excel：工作区里 test.xlsx B2=100 → 说「把 B2 改成 199」→ 弹审批卡 → 点允许 → 文件 B2==199 且有 .bak 备份
 *  C) 越界拒绝：工作区外路径直接拒绝
 * 用法：node cdp-local.js --prep 造 fixtures；起测试实例(test-main.js)后 node cdp-local.js */
'use strict';
const fs = require('fs'); const path = require('path'); const os = require('os');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let fails = 0; const ok = (n, c) => { console.log((c ? 'PASS ' : 'FAIL ') + n); if (!c) fails++; };
const WS = path.join(os.tmpdir(), 'sb-ws-test');
const XLSX_P = path.join(WS, 'test.xlsx');
const BIG_P = path.join(WS, 'big.txt');
const KEY = fs.readFileSync('D:/workspace/Salesboard/eval/deepseek.key', 'utf8').trim();   // 静默读取，不打印

function prep() {
  fs.mkdirSync(WS, { recursive: true });
  const XLSX = require('xlsx');
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['产品', '价格'], ['Slate SE 11', 100], ['Slate 11', 200]]), 'Sheet1');
  XLSX.writeFile(wb, XLSX_P);
  const lines = []; for (let i = 1; i <= 200000; i++) lines.push(i === 150000 ? 'row ' + i + ' 关键记录 ZEBRA-9981 墨西哥 促销价 199' : 'row ' + i + ' 普通记录 ' + (i % 97));
  fs.writeFileSync(BIG_P, lines.join('\n'), 'utf8');
  console.log('fixtures ready: ' + WS + ' (big.txt ' + Math.round(fs.statSync(BIG_P).size / 1048576) + ' MB)');
}
if (process.argv.indexOf('--prep') >= 0) { prep(); process.exit(0); }

(async () => {
  let target = null;
  for (let i = 0; i < 30 && !target; i++) { try { const list = await (await fetch('http://127.0.0.1:9224/json')).json(); target = list.find(t => t.type === 'page' && /index\.html/.test(t.url || '')); } catch (e) {} if (!target) await sleep(1000); }
  if (!target) { console.log('FAIL 连不上 CDP'); process.exit(1); }
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let mid = 0; const pend = new Map();
  ws.onmessage = (ev) => { try { const m = JSON.parse(ev.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } if (m.method === 'Page.javascriptDialogOpening') ws.send(JSON.stringify({ id: ++mid, method: 'Page.handleJavaScriptDialog', params: { accept: true } })); } catch (e) {} };
  const send = (method, params) => new Promise((res) => { const id = ++mid; pend.set(id, res); ws.send(JSON.stringify({ id, method, params: params || {} })); setTimeout(() => { if (pend.has(id)) { pend.delete(id); res({ result: { exceptionDetails: { text: 'timeout' } } }); } }, 60000); });
  const ev = async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); if (r.result && r.result.exceptionDetails) return { err: (r.result.exceptionDetails.exception && r.result.exceptionDetails.exception.description || r.result.exceptionDetails.text || '').slice(0, 300) }; return { v: r.result && r.result.result && r.result.result.value }; };
  const shot = async (name) => { try { await send('Page.bringToFront'); const r = await send('Page.captureScreenshot', { format: 'png' }); if (r.result && r.result.data) fs.writeFileSync(path.join(__dirname, name), Buffer.from(r.result.data, 'base64')); } catch (e) {} };
  await new Promise(r => { ws.onopen = r; });
  await send('Runtime.enable'); await send('Page.enable');
  for (let i = 0; i < 30; i++) { const r = await ev("!!(typeof switchView==='function' && window.sb && window.AIPanel && window.AgentChat)"); if (r.v === true) break; await sleep(1000); }
  await ev("(function(){ const l=document.getElementById('loading'); if(l) l.classList.add('hidden'); window.alert=function(m){window.__lastAlert=m;}; window.confirm=function(){return true;}; return 1; })()");
  await ev("(function(){ const c=Object.assign({}, (window.AIPanel.loadCfg&&window.AIPanel.loadCfg())||{}, {provider:'deepseek', dsModel:'deepseek-chat', dsKey:" + JSON.stringify(KEY) + "}); window.AIPanel.saveCfg(c); return 1; })()");
  const wsr = await ev("window.sb.wsSet(" + JSON.stringify([WS]) + ").then(r=>JSON.stringify(r))");
  ok('工作区设置', /"ok":true/.test(wsr.v || ''));
  await ev("switchView('agentchat'); 1"); await sleep(1200);
  const wsBtn = await ev("(function(){ const b=document.getElementById('acWs'); return b? b.innerText : ''; })()");
  ok('顶栏有「📁 工作区」按钮', /工作区/.test(wsBtn.v || ''));

  const newSession = async () => { await ev("(function(){ const b=document.getElementById('acNew'); if(b) b.click(); return 1; })()"); await sleep(400); };
  const askAndWait = async (q, maxSec, onTick, keepSession) => {
    if (!keepSession) await newSession();
    await ev("(function(){ const ta=document.getElementById('acInput'); ta.value=" + JSON.stringify(q) + "; document.getElementById('acSend').click(); return 1; })()");
    for (let i = 0; i < maxSec / 2; i++) {
      await sleep(2000);
      if (onTick) await onTick();
      const st = await ev("(function(){ const live=document.querySelector('#acMsgs .ac-live'); const ais=[...document.querySelectorAll('#acMsgs .ac-b.a:not(.ac-live)')]; return JSON.stringify({live:!!live, nAi:ais.length}); })()");
      let o = {}; try { o = JSON.parse(st.v); } catch (e) {}
      if (!o.live && o.nAi >= 1) break;
    }
    // innerText 不含折叠的 <details> 执行流，textContent 才含 → 用它判定工具调用
    const r = await ev("(function(){ const ais=[...document.querySelectorAll('#acMsgs .ac-b.a:not(.ac-live)')]; const b=ais[ais.length-1]; return JSON.stringify(b? {t:b.innerText, all:b.textContent} : {t:'',all:''}); })()");
    let o = { t: '', all: '' }; try { o = JSON.parse(r.v); } catch (e) {}
    return { reply: String(o.t || ''), full: String(o.all || '') };
  };

  // ---- A) 大文件全文索引 ----
  await newSession();   // 先开会话再附加文件，提问留在同一会话（附件按会话隔离）
  const add = await ev("window.AgentChat.addFileByPath(" + JSON.stringify(BIG_P) + ").then(r=>String(r))");
  ok('20 万行文本上传成功(无 8MB 限制)', add.v === 'true');
  const sysTxt = await ev("(function(){ const s=[...document.querySelectorAll('#acMsgs .ac-b.s')]; return s.length? s[s.length-1].innerText : ''; })()");
  ok('提示「全文已建索引」', /全文已建索引/.test(sysTxt.v || ''));
  const A = await askAndWait('文档里包含 ZEBRA-9981 的是第几行？那一行写了什么？', 240, null, true);
  console.log('   A 回复: ' + A.reply.replace(/\n/g, ' ').slice(0, 200));
  ok('答案定位到第 150000 行(不在前 6 万字里)', /150,?000/.test(A.reply));
  ok('执行流里有 docSearch 全文检索', /docSearch/.test(A.full));
  await shot('ui-local-bigdoc.png');

  // ---- B) Claude Code 式改 Excel（审批卡→允许） ----
  let approved = 0;
  const B = await askAndWait('把工作区里 test.xlsx 的 Sheet1 里 B2 单元格改成 199', 300, async () => {
    const has = await ev("!!document.querySelector('#acMsgs .ac-b.ap .ap-yes')");
    if (has.v === true) {
      if (!approved) await shot('ui-local-approve.png');           // 审批卡截图（点允许之前）
      const r = await ev("(function(){ const b=document.querySelector('#acMsgs .ac-b.ap .ap-yes'); if(b){ b.click(); return 'clicked'; } return ''; })()");
      if (r.v === 'clicked') approved++;
    }
  });
  console.log('   B 回复: ' + B.reply.replace(/\n/g, ' ').slice(0, 220));
  ok('弹出审批卡并被允许', approved >= 1);
  ok('执行流里有 fsRead→excelEdit', /fsRead/.test(B.full) && /excelEdit/.test(B.full));
  const XLSX = require('xlsx');
  const wb = XLSX.read(fs.readFileSync(XLSX_P), { type: 'buffer' });
  const rows = XLSX.utils.sheet_to_json(wb.Sheets.Sheet1, { header: 1 });
  ok('本机 Excel 的 B2 真的改成了 199', rows[1] && +rows[1][1] === 199);
  ok('写前自动备份 .bak', fs.readdirSync(WS).some(f => /^test\.xlsx\..*\.bak$/.test(f)));
  ok('其它单元格未动(A2/B3)', rows[1][0] === 'Slate SE 11' && +rows[2][1] === 200);
  await shot('ui-local-done.png');

  // ---- C) 越界拒绝：工作区外路径 ----
  const out = await ev("window.sb.excelEdit({path:'C:/Windows/Temp/x.xlsx', ops:[{op:'setCell',cell:'A1',value:1}]}).then(r=>JSON.stringify(r))");
  ok('工作区外路径被拒绝', /不在工作区/.test(out.v || ''));

  await ev("(function(){ const c=window.AIPanel.loadCfg()||{}; delete c.dsKey; window.AIPanel.saveCfg(c); return 1; })()");
  ws.close(); console.log(fails ? ('FAILURES: ' + fails) : '===== 本机能力 UI ALL PASS ====='); process.exit(fails ? 1 : 0);
})().catch(e => { console.log('FAIL 异常: ' + e.message); process.exit(1); });

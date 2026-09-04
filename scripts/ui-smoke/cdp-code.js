/* 本地编程 + 上传文件 真模型实测（2026-09-04 用户「先测试一下是否真的能本地编程，然后上传文件」）
 *  S0 默认工作区(文档\销售团队-AI输出)不设也在
 *  S1 Node 编程：一句话 → 写脚本算质数和 → 审批 → primes.txt 落盘且答案正确
 *  S2 Python 编程：按国家汇总 sales.csv → summary.csv 数值正确
 *  S3 上传 >8MB 的 Excel(32 万行) → 问 Peru 合计 → 模型写脚本读原文件算出精确值
 *  S4 上传 PPT(工作区外) → 问某页内容
 *  S5 上传 Word(工作区外) → 问交付日期/代号
 *  S6 上传 >8MB 文本(40 万行) → 定位第 333333 行的标记
 *  S7 守卫：上传过的工作区外文件可读；同目录未上传的文件仍拒
 * 用法：node cdp-code.js --prep 造 fixtures；起测试实例(test-main.js)后 node cdp-code.js */
'use strict';
const fs = require('fs'); const path = require('path'); const os = require('os');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let fails = 0; const ok = (n, c) => { console.log((c ? 'PASS ' : 'FAIL ') + n); if (!c) fails++; };
const WS = path.join(os.tmpdir(), 'sb-ws-test');
const OUT = path.join(os.tmpdir(), 'sb-outside');      // 工作区外：模拟用户从别处拖文件进来
const P = { csv: path.join(WS, 'sales.csv'), big: path.join(WS, 'big_sales.xlsx'), exp: path.join(WS, 'expected.json'),
  ppt: path.join(OUT, 'deck.pptx'), doc: path.join(OUT, 'brief.docx'), huge: path.join(OUT, 'huge.txt'), other: path.join(OUT, 'other.txt') };
const KEY = fs.readFileSync('D:/workspace/Salesboard/eval/deepseek.key', 'utf8').trim();   // 静默读取，不打印

async function prep() {
  fs.rmSync(WS, { recursive: true, force: true }); fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(WS, { recursive: true }); fs.mkdirSync(OUT, { recursive: true });
  const XLSX = require('xlsx');
  // sales.csv：4 国 × 15 行，各国 units 合计可知
  const countries = ['Mexico', 'Peru', 'Chile', 'Colombia']; const sums = {}; const csv = ['country,product,units,price'];
  let seed = 7; const rnd = () => { seed = (seed * 9301 + 49297) % 233280; return seed / 233280; };
  countries.forEach(c => { sums[c] = 0; for (let i = 0; i < 15; i++) { const u = 10 + Math.floor(rnd() * 90); sums[c] += u; csv.push(c + ',Slate ' + (i % 3 + 1) + ',' + u + ',' + (199 + i * 10)); } });
  fs.writeFileSync(P.csv, csv.join('\n'), 'utf8');
  // big_sales.xlsx：32 万行 × 8 列，note 列随机字符压不动 → 稳超 8MB
  const rows = [['id', 'country', 'product', 'month', 'units', 'price', 'channel', 'note']]; let peru = 0;
  for (let i = 1; i <= 320000; i++) { const c = countries[i % 4]; const u = 1 + (i * 7919) % 50; if (c === 'Peru') peru += u; rows.push([i, c, 'Slate ' + (i % 5 + 1), '2026-0' + (i % 9 + 1), u, 150 + (i % 40) * 5, i % 2 ? 'Online' : 'Retail', Math.random().toString(36).slice(2, 14)]); }
  const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), 'Sales');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['country', 'target'], ['Peru', 12000], ['Mexico', 30000]]), 'Targets');
  XLSX.writeFile(wb, P.big, { compression: true });
  fs.writeFileSync(P.exp, JSON.stringify({ csvSums: sums, peruBig: peru }), 'utf8');
  // deck.pptx：3 页，第 3 页有可核对的数字
  const PptxGenJS = require('pptxgenjs'); const pp = new PptxGenJS();
  pp.addSlide().addText('2027 拉美平板 销售团队 综述', { x: 1, y: 1, w: 8, h: 1 });
  pp.addSlide().addText('墨西哥：Q1 主推 Slate 11，渠道 Mercantil + Casona', { x: 1, y: 1, w: 8, h: 1 });
  pp.addSlide().addText('秘鲁渠道策略：2027 年 Q2 上线 Andina Retail 独家首发，目标 12500 台', { x: 1, y: 1, w: 8, h: 1 });
  await pp.writeFile({ fileName: P.ppt });
  // brief.docx：手写最小 docx（office-struct-core.writeZip）
  const OSC = require('D:/workspace/Salesboard/app/office-struct-core.js');
  const para = t => '<w:p><w:r><w:t xml:space="preserve">' + t + '</w:t></w:r></w:p>';
  const docXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' +
    para('项目简报') + para('本项目为拉美音频新品上市方案。') + para('交付日期：2026 年 11 月 18 日（项目代号 KOALA-77）') + para('负责人：销售团队') + '<w:sectPr/></w:body></w:document>';
  fs.writeFileSync(P.doc, OSC.writeZip([
    { name: '[Content_Types].xml', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>' },
    { name: '_rels/.rels', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>' },
    { name: 'word/document.xml', data: docXml },
  ]));
  // huge.txt：40 万行，第 333333 行有唯一标记
  const lines = []; for (let i = 1; i <= 400000; i++) lines.push(i === 333333 ? 'row ' + i + ' 关键记录 PANDA-4242 智利 渠道价 349' : 'row ' + i + ' 普通记录 ' + (i % 97));
  fs.writeFileSync(P.huge, lines.join('\n'), 'utf8');
  fs.writeFileSync(P.other, 'not uploaded', 'utf8');
  const mb = p => (fs.statSync(p).size / 1048576).toFixed(1) + 'MB';
  console.log('fixtures ready: big_sales.xlsx ' + mb(P.big) + ', huge.txt ' + mb(P.huge) + ', deck.pptx ' + mb(P.ppt) + ', brief.docx ' + mb(P.doc) + ' | Peru(big)=' + peru + ' csvSums=' + JSON.stringify(sums));
  if (fs.statSync(P.big).size < 8 * 1048576 || fs.statSync(P.huge).size < 8 * 1048576) console.log('WARN 某个大文件不足 8MB');
}
if (process.argv.indexOf('--prep') >= 0) { prep().then(() => process.exit(0)); } else (async () => {
  const EXP = JSON.parse(fs.readFileSync(P.exp, 'utf8'));
  let target = null;
  for (let i = 0; i < 30 && !target; i++) { try { const list = await (await fetch('http://127.0.0.1:9224/json')).json(); target = list.find(t => t.type === 'page' && /index\.html/.test(t.url || '')); } catch (e) {} if (!target) await sleep(1000); }
  if (!target) { console.log('FAIL 连不上 CDP'); process.exit(1); }
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let mid = 0; const pend = new Map();
  ws.onmessage = (ev) => { try { const m = JSON.parse(ev.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } if (m.method === 'Page.javascriptDialogOpening') ws.send(JSON.stringify({ id: ++mid, method: 'Page.handleJavaScriptDialog', params: { accept: true } })); } catch (e) {} };
  const send = (method, params, tmo) => new Promise((res) => { const id = ++mid; pend.set(id, res); ws.send(JSON.stringify({ id, method, params: params || {} })); setTimeout(() => { if (pend.has(id)) { pend.delete(id); res({ result: { exceptionDetails: { text: 'timeout' } } }); } }, tmo || 60000); });
  const ev = async (expr, tmo) => { const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, tmo); if (r.result && r.result.exceptionDetails) return { err: (r.result.exceptionDetails.exception && r.result.exceptionDetails.exception.description || r.result.exceptionDetails.text || '').slice(0, 300) }; return { v: r.result && r.result.result && r.result.result.value }; };
  const shot = async (name) => { try { await send('Page.bringToFront'); const r = await send('Page.captureScreenshot', { format: 'png' }); if (r.result && r.result.data) fs.writeFileSync(path.join(__dirname, name), Buffer.from(r.result.data, 'base64')); } catch (e) {} };
  await new Promise(r => { ws.onopen = r; });
  await send('Runtime.enable'); await send('Page.enable');
  for (let i = 0; i < 30; i++) { const r = await ev("!!(typeof switchView==='function' && window.sb && window.AIPanel && window.AgentChat)"); if (r.v === true) break; await sleep(1000); }
  await ev("(function(){ const l=document.getElementById('loading'); if(l) l.classList.add('hidden'); window.alert=function(m){window.__lastAlert=m;}; window.confirm=function(){return true;}; return 1; })()");
  await ev("(function(){ const c=Object.assign({}, (window.AIPanel.loadCfg&&window.AIPanel.loadCfg())||{}, {provider:'deepseek', dsModel:'deepseek-chat', dsKey:" + JSON.stringify(KEY) + "}); window.AIPanel.saveCfg(c); return 1; })()");

  // S0 默认工作区
  const g0 = await ev("window.sb.wsGet().then(r=>JSON.stringify(r))");
  ok('S0 不设工作区也有默认工作区(文档\\销售团队-AI输出)', /销售团队-AI输出/.test(g0.v || ''));
  await ev("window.sb.wsSet(" + JSON.stringify([WS]) + ").then(r=>JSON.stringify(r))");
  await ev("switchView('agentchat'); 1"); await sleep(1200);

  const newSession = async () => { await ev("(function(){ const b=document.getElementById('acNew'); if(b) b.click(); return 1; })()"); await sleep(400); };
  const upload = async (p) => { const r = await ev("window.AgentChat.addFileByPath(" + JSON.stringify(p) + ").then(r=>String(r)).catch(e=>'ERR '+e.message)", 240000); return r.v === 'true' ? true : (r.v || r.err); };
  let cards = [];   // 每题捕获到的审批卡文本
  const ask = async (q, maxSec, keepSession) => {
    if (!keepSession) await newSession();
    cards = [];
    await ev("(function(){ const ta=document.getElementById('acInput'); ta.value=" + JSON.stringify(q) + "; document.getElementById('acSend').click(); return 1; })()");
    for (let i = 0; i < maxSec / 2; i++) {
      await sleep(2000);
      const card = await ev("(function(){ const c=document.querySelector('#acMsgs .ac-b.ap'); if(!c) return ''; const t=c.innerText; const b=c.querySelector('.ap-yes'); if(b) b.click(); return t; })()");
      if (card.v) cards.push(String(card.v).replace(/\n/g, ' ').slice(0, 200));
      const st = await ev("(function(){ const live=document.querySelector('#acMsgs .ac-live'); const ais=[...document.querySelectorAll('#acMsgs .ac-b.a:not(.ac-live)')]; return JSON.stringify({live:!!live, nAi:ais.length}); })()");
      let o = {}; try { o = JSON.parse(st.v); } catch (e) {}
      if (!o.live && o.nAi >= 1) break;
    }
    const r = await ev("(function(){ const ais=[...document.querySelectorAll('#acMsgs .ac-b.a:not(.ac-live)')]; const b=ais[ais.length-1]; return JSON.stringify(b? {t:b.innerText, all:b.textContent} : {t:'',all:''}); })()");
    let o = { t: '', all: '' }; try { o = JSON.parse(r.v); } catch (e) {}
    return { reply: String(o.t || ''), full: String(o.all || '') };
  };
  const num = s => String(s || '').replace(/,/g, '');
  const show = (tag, r) => { console.log('   ' + tag + ' 回复: ' + r.reply.replace(/\n/g, ' ').slice(0, 260)); if (cards.length) console.log('   ' + tag + ' 审批卡: ' + cards[0]); };

  // S1 Node 编程
  const S1 = await ask('在工作区里写一个 Node 脚本：计算 1 到 100 之间所有质数的和，把结果写进 primes.txt，然后把结果告诉我', 200);
  show('S1', S1);
  ok('S1 弹审批卡且走了 runCode', cards.length >= 1 && /runCode/.test(S1.full));
  ok('S1 primes.txt 落盘且内容为 1060', fs.existsSync(path.join(WS, 'primes.txt')) && /1060/.test(fs.readFileSync(path.join(WS, 'primes.txt'), 'utf8')));
  ok('S1 回答里有 1060', /1060/.test(num(S1.reply)));
  await shot('ui-code-node.png');

  // S2 Python 编程
  const S2 = await ask('用 Python 写一个脚本：读取工作区里的 sales.csv，按 country 汇总 units，结果写成 summary.csv（两列 country,units），并把每个国家的合计告诉我', 240);
  show('S2', S2);
  let sumOk = false; try { const t = fs.readFileSync(path.join(WS, 'summary.csv'), 'utf8'); sumOk = Object.keys(EXP.csvSums).every(c => new RegExp(c + '\\s*,\\s*' + EXP.csvSums[c] + '\\b').test(t)); } catch (e) {}
  ok('S2 summary.csv 落盘且四国合计全对', sumOk);
  ok('S2 回答里 Peru 合计正确(' + EXP.csvSums.Peru + ')', new RegExp('\\b' + EXP.csvSums.Peru + '\\b').test(num(S2.reply)));
  ok('S2 用的是 Python', /python/i.test(cards.join(' ')) || /python/i.test(S2.full));

  // S3 上传 >8MB Excel → 整份计算
  await newSession();
  const u3 = await upload(P.big);
  ok('S3 上传 ' + (fs.statSync(P.big).size / 1048576).toFixed(1) + 'MB 的 Excel 成功', u3 === true);
  const sys3 = await ev("(function(){ const s=[...document.querySelectorAll('#acMsgs .ac-b.s')]; return s.length? s[s.length-1].innerText : ''; })()");
  ok('S3 提示含结构(Sales 表 行×列)', /Sales/.test(sys3.v || '') && /行/.test(sys3.v || ''));
  const S3 = await ask('这份 Excel 的 Sales 表里，country 为 Peru 的 units 合计是多少？要精确值', 300, true);
  show('S3', S3);
  ok('S3 精确合计正确(' + EXP.peruBig + ')', new RegExp('\\b' + EXP.peruBig + '\\b').test(num(S3.reply)));
  ok('S3 走了 runCode 读原文件', /runCode/.test(S3.full));
  await shot('ui-code-bigxlsx.png');

  // S4 上传 PPT（工作区外）
  await newSession();
  ok('S4 上传工作区外的 PPT', (await upload(P.ppt)) === true);
  const S4 = await ask('这个 PPT 里秘鲁渠道策略的目标是多少台？什么时候上线？', 150, true);
  show('S4', S4);
  ok('S4 答出 12500 台 + 2027 Q2', /12500/.test(num(S4.reply)) && /Q2|二季度|第二季度/.test(S4.reply));

  // S5 上传 Word（工作区外）
  await newSession();
  ok('S5 上传工作区外的 Word', (await upload(P.doc)) === true);
  const S5 = await ask('这份文档的交付日期和项目代号分别是什么？', 150, true);
  show('S5', S5);
  ok('S5 答出 11 月 18 日 + KOALA-77', /(11\s*月\s*18|2026-11-18|11\/18)/.test(S5.reply) && /KOALA-77/.test(S5.reply));

  // S6 上传 >8MB 文本
  await newSession();
  ok('S6 上传 ' + (fs.statSync(P.huge).size / 1048576).toFixed(1) + 'MB 文本(40 万行)', (await upload(P.huge)) === true);
  const S6 = await ask('文档里包含 PANDA-4242 的是第几行？那行写了什么？', 200, true);
  show('S6', S6);
  ok('S6 定位到第 333333 行', /333333/.test(num(S6.reply)));

  // S7 守卫
  const r7a = await ev("window.sb.fsRead({path:" + JSON.stringify(P.ppt) + "}).then(r=>JSON.stringify(r))");
  ok('S7 上传过的工作区外文件可被本机工具读', /秘鲁渠道/.test(r7a.v || ''));
  const r7b = await ev("window.sb.fsRead({path:" + JSON.stringify(P.other) + "}).then(r=>JSON.stringify(r))");
  ok('S7 同目录未上传的文件仍被拒', /不在工作区/.test(r7b.v || ''));

  await ev("(function(){ const c=window.AIPanel.loadCfg()||{}; delete c.dsKey; window.AIPanel.saveCfg(c); return 1; })()");
  ws.close(); console.log(fails ? ('FAILURES: ' + fails) : '===== 本地编程 + 上传 UI ALL PASS ====='); process.exit(fails ? 1 : 0);
})().catch(e => { console.log('FAIL 异常: ' + e.message); process.exit(1); });

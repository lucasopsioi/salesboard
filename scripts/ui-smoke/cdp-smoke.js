/* 全看板 UI 暴力冒烟：挂 demo PSI → 17 个看板逐个切换 → 视图内每个按钮/下拉/勾选/输入逐个触发
 * → 抓 console.error / window.onerror / unhandledrejection → 每看板汇总（触发元素数 / 异常数 / 异常首条）。
 * 危险按钮（导出/导入/删除/清空/保存对话框/文件夹选择/发手机…）按文本与 id 跳过。 */
'use strict';
const fs = require('fs'); const path = require('path');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const VIEWS = ['home', 'psi', 'industry', 'country', 'report', 'finance', 'inventory', 'fob', 'pricing', 'pricinglib', 'custom', 'designer', 'pptoutput', 'textout', 'roadmap', 'source', 'agentchat'];
(async () => {
  let target = null;
  for (let i = 0; i < 30 && !target; i++) { try { const list = await (await fetch('http://127.0.0.1:9224/json')).json(); target = list.find(t => t.type === 'page' && /index\.html/.test(t.url || '')); } catch (e) {} if (!target) await sleep(1000); }
  if (!target) { console.log('FAIL 连不上 CDP'); process.exit(1); }
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let mid = 0; const pend = new Map();
  ws.onmessage = (ev) => { try { const m = JSON.parse(ev.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } if (m.method === 'Page.javascriptDialogOpening') ws.send(JSON.stringify({ id: ++mid, method: 'Page.handleJavaScriptDialog', params: { accept: true } })); } catch (e) {} };
  const send = (method, params) => new Promise((res) => { const id = ++mid; pend.set(id, res); ws.send(JSON.stringify({ id, method, params: params || {} })); });
  const ev = async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); if (r.result && r.result.exceptionDetails) return { err: (r.result.exceptionDetails.exception && r.result.exceptionDetails.exception.description || r.result.exceptionDetails.text || '').slice(0, 400) }; return { v: r.result && r.result.result && r.result.result.value }; };
  await new Promise(r => { ws.onopen = r; });
  await send('Runtime.enable'); await send('Page.enable');
  for (let i = 0; i < 30; i++) { const r = await ev("!!(typeof switchView==='function' && window.sb)"); if (r.v === true) break; await sleep(1000); }
  // 错误钩子 + 弹窗静默
  await ev(`(function(){
    window.__errs = [];
    const push = (kind, msg, extra) => { window.__errs.push({ kind, msg: String(msg).slice(0, 300), extra: String(extra||'').slice(0,200), view: window.__curView||'', el: window.__curEl||'' }); };
    const origErr = console.error.bind(console); console.error = function(){ push('console.error', [...arguments].map(a => (a && a.stack) ? a.stack.split('\\n').slice(0,2).join(' ') : String(a)).join(' ')); origErr.apply(console, arguments); };
    window.addEventListener('error', e => push('window.error', e.message, (e.error && e.error.stack || '').split('\\n').slice(1,3).join(' ')));
    window.addEventListener('unhandledrejection', e => push('unhandledrejection', (e.reason && (e.reason.message || e.reason)) || 'reason?', (e.reason && e.reason.stack || '').split('\\n').slice(1,3).join(' ')));
    window.alert = function(m){ window.__lastAlert = String(m); }; window.confirm = function(){ return false; }; window.prompt = function(){ return null; };
    return 1; })()`);
  await ev("window.sb.setFolderAndRefresh('D:/workspace/Salesboard/demo-data/psi').then(()=>1)"); await sleep(2500);
  await ev("window.sb.setFinFolderAndRefresh('D:/workspace/Salesboard/demo-data/finance').then(()=>1)"); await sleep(2500);
  await ev("window.sb.setInvFolderAndRefresh('D:/workspace/Salesboard/demo-data/flow').then(()=>1)"); await sleep(2000);
  await ev("(function(){ const l=document.getElementById('loading'); if(l) l.classList.add('hidden'); return 1; })()");
  // 效果检测：全局 MutationObserver 计数 —— 点了没有任何 DOM 变化的按钮列为「疑似无反应」
  await ev("(function(){ window.__mut=0; new MutationObserver(ms=>{ window.__mut+=ms.length; }).observe(document.body,{subtree:true,childList:true,attributes:true,characterData:true}); return 1; })()");
  // 静态弹窗（index.html 自带，如 #previewModal）打标：清理时只隐藏不删除——删了会让后续按钮引用不到而误报
  await ev("document.querySelectorAll('.modal,.rm-modal,.px-modal,.ai-modal,[class*=overlay]').forEach(m=>m.setAttribute('data-smk-static','1')); 1");
  const DANGER = /导出|导入|删除|清空|清除|保存到|另存|打开|选择|文件夹|刷新|Refresh|发手机|重置|移除|上传|附件|发送|识别中|一键新建|载入示例|Load Sample|Export|Import|Delete|Remove|Save|Reset|退出|关闭应用|登录|测试连接|网络体检|拉取|Fetch|生成|下载|打印|PDF|PPTX|新建/;
  const report = [];
  for (const v of VIEWS) {
    await ev("window.__curView=" + JSON.stringify(v) + "; window.__curEl='';");
    const sw = await ev("(function(){ try { switchView(" + JSON.stringify(v) + "); return 'ok'; } catch(e) { return 'throw:' + e.message; } })()");
    await sleep(1800);
    const errBefore = (await ev("window.__errs.length")).v || 0;
    // 枚举视图内可交互元素（可见、未禁用），跳过危险按钮
    const listR = await ev(`(function(){
      const host = document.getElementById('view-${v}') || document.body;
      const vis = el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden'; };
      const els = [...host.querySelectorAll('button, input, select, textarea, [role=button], .btn, .tab, .seg button, .rm-seg button')].filter(el => vis(el) && !el.disabled);
      const out = []; const seen = new Set();
      els.forEach((el, i) => {
        if (seen.has(el)) return; seen.add(el);
        const tag = el.tagName.toLowerCase(); const type = (el.getAttribute('type') || '').toLowerCase();
        const label = (el.id ? '#' + el.id + ' ' : '') + (el.textContent || el.value || el.title || el.placeholder || '').trim().slice(0, 24);
        const kind = tag === 'select' ? 'select' : (tag === 'textarea' ? 'text' : (tag === 'input' ? (type === 'checkbox' || type === 'radio' ? 'check' : (type === 'file' || type === 'color' || type === 'range' || type === 'date' ? 'skip' : 'text')) : 'button'));
        el.setAttribute('data-smk', String(i));
        out.push({ i, kind, label, type, danger: ${DANGER.toString()}.test(label) || type === 'file' });
      });
      return JSON.stringify(out.slice(0, 160)); })()`);
    let els = []; try { els = JSON.parse(listR.v || '[]'); } catch (e) {}
    if (!els.length) {
      const diag = await ev("(function(){ const h=document.getElementById('view-" + v + "'); if(!h) return 'no container #view-" + v + "'; return 'display=' + getComputedStyle(h).display + ' active=' + h.classList.contains('active') + ' text=' + (h.innerText||'').replace(/\\s+/g,' ').slice(0,160); })()");
      console.log('      ! 0 元素诊断: ' + (diag.v || diag.err));
    }
    let touched = 0, skipped = 0; const noEffect = [];
    for (const e of els) {
      if (e.kind === 'skip' || e.danger) { skipped++; continue; }
      await ev("window.__curEl=" + JSON.stringify(e.label) + ";");
      const act = e.kind === 'button' ? "el.click()"
        : e.kind === 'select' ? "el.dispatchEvent(new Event('change',{bubbles:true}))"
        : e.kind === 'check' ? "el.click(); el.click()"
        : "el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true}))";
      const r = await ev("(function(){ const el=document.querySelector('[data-smk=\"" + e.i + "\"]'); if(!el||el.disabled) return 'gone'; window.__mut0=window.__mut; try { " + act + "; return 'ok'; } catch(err) { window.__errs.push({kind:'sync-throw', msg:String(err && err.message||err).slice(0,300), extra:String(err&&err.stack||'').split('\\n').slice(1,3).join(' '), view:window.__curView, el:window.__curEl}); return 'throw'; } })()");
      touched++;
      await sleep(120);
      if (e.kind === 'button' && r.v === 'ok') {
        const delta = (await ev("window.__mut - window.__mut0")).v;
        if (!delta) noEffect.push(e.label);
      }
      // 关掉可能打开的弹窗/浮层，避免遮挡后续元素
      await ev("(function(){ ['rmDialog'].forEach(id=>{ const d=document.getElementById(id); if(d){ d.style.display='none'; d.innerHTML=''; } }); document.querySelectorAll('.rm-modal,.modal,.px-modal,.ai-modal,[class*=overlay]').forEach(m=>{ if(m.id==='loading') return; if(m.getAttribute('data-smk-static')) m.classList.add('hidden'); else m.remove(); }); const l=document.getElementById('loading'); if(l) l.classList.add('hidden'); return 1; })()");
    }
    // 切回本视图（点击过的元素可能切走了）并再等一会儿收尾错误
    await ev("(function(){ try{ switchView(" + JSON.stringify(v) + "); }catch(e){} return 1; })()"); await sleep(400);
    const errs = (await ev("JSON.stringify(window.__errs.slice(" + errBefore + "))")).v;
    let list = []; try { list = JSON.parse(errs || '[]'); } catch (e) {}
    const uniq = [...new Map(list.map(x => [x.kind + '|' + x.msg.slice(0, 80), x])).values()];
    report.push({ view: v, switch: sw.v, elements: els.length, touched, skipped, errors: uniq.length, noEffect, samples: uniq.slice(0, 4).map(x => x.kind + ' @' + (x.el || '-') + ' :: ' + x.msg.slice(0, 160) + (x.extra ? ' ⇐ ' + x.extra.slice(0, 120) : '')) });
    console.log((uniq.length ? 'FAIL ' : 'PASS ') + v.padEnd(10) + ' switch=' + sw.v + ' 元素 ' + String(els.length).padStart(3) + ' 触发 ' + String(touched).padStart(3) + ' 跳过 ' + String(skipped).padStart(3) + ' 异常 ' + uniq.length + ' 无反应按钮 ' + noEffect.length);
    uniq.slice(0, 4).forEach(x => console.log('      · ' + x.kind + ' @' + (x.el || '-') + ' :: ' + x.msg.slice(0, 160) + (x.extra ? '  ⇐ ' + x.extra.slice(0, 120) : '')));
    if (noEffect.length) console.log('      ? 无DOM变化: ' + noEffect.slice(0, 12).join(' | ') + (noEffect.length > 12 ? ' …+' + (noEffect.length - 12) : ''));
  }
  fs.writeFileSync(path.join(__dirname, 'smoke-report.json'), JSON.stringify(report, null, 1));
  const bad = report.filter(r => r.errors || /throw/.test(String(r.switch)));
  console.log('===== 冒烟汇总：' + report.length + ' 个看板，' + report.reduce((a, r) => a + r.touched, 0) + ' 个元素触发，' + bad.length + ' 个看板有异常 =====');
  ws.close(); process.exit(bad.length ? 1 : 0);
})().catch(e => { console.log('FAIL 异常: ' + e.message); process.exit(1); });

/* 渲染层↔preload↔main 三层接线静态审计（2026-09-01）：
 * ① renderer 调的每个 window.sb.X 必须在 preload 暴露
 * ② preload invoke 的每个通道必须有 main 的 ipcMain.handle
 * ③ renderer 用的每个 window.全局模块 必须有定义文件且被 index.html 引入
 * 抓「评测全绿但 UI 缺桥」这类断链（makePpt 双断链同族病）。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(p, 'utf8');

let bad = 0;
const fail = (m) => { console.log('FAIL ' + m); bad++; };
const pass = (m) => console.log('PASS ' + m);

// ── preload：方法名 → invoke 通道 ──
const pre = read(path.join(root, 'preload.js'));
const preMethods = new Set();
const preChannels = [];
{
  const re = /^\s*([A-Za-z_$][\w$]*)\s*:\s*(?:\([^)]*\)|[\w$]+)\s*=>\s*ipcRenderer\.(?:invoke|send)\('([^']+)'/gm;
  let m; while ((m = re.exec(pre))) { preMethods.add(m[1]); preChannels.push({ method: m[1], ch: m[2] }); }
  // 非 ipc 的纯函数暴露（如 pathForFile）
  const re2 = /^\s*([A-Za-z_$][\w$]*)\s*:\s*\((?:[^)]*)\)\s*=>\s*\{/gm;
  let m2; while ((m2 = re2.exec(pre))) preMethods.add(m2[1]);
}

// ── main：ipcMain.handle/on 通道 ──
const mainSrc = read(path.join(root, 'main.js'));
const mainCh = new Set();
{
  const re = /ipcMain\.(?:handle|on)\('([^']+)'/g;
  let m; while ((m = re.exec(mainSrc))) mainCh.add(m[1]);
}

// ── renderer 文件集 ──
const rfiles = [];
(function walk(d) {
  fs.readdirSync(d).forEach(f => {
    const p = path.join(d, f);
    const st = fs.statSync(p);
    if (st.isDirectory()) { if (f !== 'node_modules') walk(p); }
    else if (/\.js$/.test(f) && !/\.test\.js$/.test(f)) rfiles.push(p);
  });
})(path.join(root, 'app'));

// ① renderer → preload
const usedSb = new Map(); // method -> [files]
rfiles.forEach(p => {
  const s = read(p);
  const re = /(?:window\.)?sb\.([A-Za-z_$][\w$]*)\s*\(/g;
  let m; while ((m = re.exec(s))) {
    if (!usedSb.has(m[1])) usedSb.set(m[1], new Set());
    usedSb.get(m[1]).add(path.basename(p));
  }
});
// ai-context.js 的 api.* 是 window.sb 的别名（const A = () => window.sb）——间接调用一并审计
{
  const s = read(path.join(root, 'app', 'ai-context.js'));
  const re = /\bapi\.([A-Za-z_$][\w$]*)\s*\(/g;
  let m; while ((m = re.exec(s))) {
    if (!usedSb.has(m[1])) usedSb.set(m[1], new Set());
    usedSb.get(m[1]).add('ai-context.js(api.*)');
  }
}
let miss1 = 0;
usedSb.forEach((files, method) => {
  if (!preMethods.has(method)) { fail('renderer 调 window.sb.' + method + '（' + [...files].join(',') + '）但 preload 未暴露'); miss1++; }
});
if (!miss1) pass('renderer→preload：' + usedSb.size + ' 个 sb 方法全部有桥');

// ② preload → main
let miss2 = 0;
preChannels.forEach(({ method, ch }) => {
  if (!mainCh.has(ch)) { fail('preload.' + method + ' invoke 通道 \'' + ch + '\' 在 main 无 handler'); miss2++; }
});
if (!miss2) pass('preload→main：' + preChannels.length + ' 条通道全部有 handler');

// ③ renderer window.全局 ↔ 定义 + index.html 引入
const html = read(path.join(root, 'app', 'index.html'));
const scripts = [...html.matchAll(/<script src="([^"]+)"/g)].map(m => m[1]);
const GLOBALS = { PptTpl: 'ppt-tpl-flow.js', ChatCtx: 'chat-context-core.js', AIOrch: 'ai-orchestrator.js', AIPanel: 'ai-panel.js', AgentBoard: 'agent-board.js' };
let miss3 = 0;
Object.keys(GLOBALS).forEach(g => {
  const def = GLOBALS[g];
  const used = rfiles.filter(p => new RegExp('window\\.' + g + '\\b').test(read(p)) && path.basename(p) !== def);
  if (!used.length) return;
  const inHtml = scripts.some(s => s.endsWith(def));
  if (!inHtml) { fail('window.' + g + ' 被 ' + used.map(p => path.basename(p)).join(',') + ' 使用，但 ' + def + ' 未被 index.html 引入'); miss3++; }
});
if (!miss3) pass('全局模块：' + Object.keys(GLOBALS).length + ' 个 window.* 模块引入齐全');

// ④ 双端核心文件不得引用 DOM/window 顶层（Node require 会炸）
['chat-context-core.js', 'office-text-core.js', 'office-struct-core.js', 'ppt-tpl-flow.js', 'roadmap-nl-core.js'].forEach(f => {
  try { require(path.join(root, 'app', f)); pass('双端 require 安全：' + f); }
  catch (e) { fail('双端模块 Node require 炸：' + f + ' — ' + e.message); }
});

console.log(bad ? ('\n共 ' + bad + ' 处断链') : '\n===== 接线审计全通过 =====');
process.exit(bad ? 1 : 0);

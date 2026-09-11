/* 看板控件接线静态审计（2026-09-02，用户令「检查所有看板所有按钮」）
 * 对每个渲染层文件：
 *   ① 声明的交互元素 id（<button|select|input|textarea id="x">）是否在任何文件里被引用过
 *      （el('x') / $('#x') / getElementById('x') / querySelector('#x') / bind('x' / '#x' 选择器 / byId('x')）
 *      —— 声明了却从未引用 = 大概率没绑事件（路标自动识别「一键新建」就是这种断链）
 *   ② 绑定引用的 id 是否在任何 html/js 里声明过 —— 引用了不存在的 id = 点了没反应或 TypeError
 * 说明：事件也可能通过 data-* 委托绑定（querySelectorAll('[data-x]')），这类不用 id，不在本审计范围。
 * 用法：node scripts/audit-ui-bindings.js [--all]   （默认只列问题；--all 连统计一起）
 */
'use strict';
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(p, 'utf8');
const ALL = process.argv.indexOf('--all') >= 0;

const files = [];
(function walk(d) {
  fs.readdirSync(d).forEach(f => {
    const p = path.join(d, f);
    const st = fs.statSync(p);
    if (st.isDirectory()) { if (f !== 'node_modules' && f !== 'lib') walk(p); }
    else if (/\.(js|html)$/.test(f) && !/\.test\.js$/.test(f)) files.push(p);
  });
})(path.join(root, 'app'));

// —— 全局：所有声明的 id（含 index.html 静态）与所有被引用的 id ——
const declared = new Map();       // id -> [{file, tag}]
const referenced = new Map();     // id -> Set(file)
const TAG_RE = /<(button|select|input|textarea|a|div|span|label)\b([^>]*?)\bid=(?:\\?["'])([A-Za-z_][\w-]*)(?:\\?["'])/g;
const REF_RES = [
  /\bel\(\s*['"]([A-Za-z_][\w-]*)['"]\s*\)/g,
  /\bbyId\(\s*['"]([A-Za-z_][\w-]*)['"]\s*\)/g,
  /getElementById\(\s*['"]([A-Za-z_][\w-]*)['"]\s*\)/g,
  /\bbind\(\s*['"]([A-Za-z_][\w-]*)['"]/g,
  /\$\(\s*['"]#([A-Za-z_][\w-]*)['"]\s*\)/g,
  /querySelector(?:All)?\(\s*['"]#([A-Za-z_][\w-]*)['"]\s*\)/g,
  /['"]#([A-Za-z_][\w-]*)\s+[^'"]*['"]/g,          // '#id .child' 复合选择器
];
const dynPrefixes = new Set();    // el('dzIns' + k) 这类动态拼接的前缀：以此开头的 id 视为已引用
files.forEach(p => {
  const s = read(p);
  const rel = path.relative(root, p);
  let m;
  TAG_RE.lastIndex = 0;
  while ((m = TAG_RE.exec(s))) {
    const tag = m[1], attrs = m[2] || '', id = m[3];
    let kind = tag;
    if (tag === 'input') { const t = attrs.match(/type=\\?["']?(\w+)/); kind = 'input:' + ((t && t[1]) || 'text'); }
    if (!declared.has(id)) declared.set(id, []);
    declared.get(id).push({ file: rel, kind });
  }
  // 本文件自定义的取元素助手：const g = id => document.getElementById(id) / function q(id){return document.getElementById(id)} / const $ = s => document.querySelector(s)
  const helpers = new Set(['el', 'byId']);
  let hm;
  const H1 = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*\(?\s*([A-Za-z_$][\w$]*)\s*\)?\s*=>\s*document\.getElementById\(\s*\2\s*\)/g;
  while ((hm = H1.exec(s))) helpers.add(hm[1]);
  const H2 = /function\s+([A-Za-z_$][\w$]*)\s*\(\s*([A-Za-z_$][\w$]*)\s*\)\s*\{\s*return\s+document\.getElementById\(\s*\2\s*\)/g;
  while ((hm = H2.exec(s))) helpers.add(hm[1]);
  const H3 = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*document\.getElementById\.bind\(document\)/g;
  while ((hm = H3.exec(s))) helpers.add(hm[1]);
  const qHelpers = new Set(['$', 'q', 'qs']);
  const H4 = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*\(?\s*([A-Za-z_$][\w$]*)\s*\)?\s*=>\s*(?:document|root|host|[\w$]+)\.querySelector\(\s*\2\s*\)/g;
  while ((hm = H4.exec(s))) qHelpers.add(hm[1]);
  const localRefs = REF_RES.slice();
  helpers.forEach(h => localRefs.push(new RegExp('\\b' + h.replace(/\$/g, '\\$') + '\\(\\s*[\'"]([A-Za-z_][\\w-]*)[\'"]\\s*\\)', 'g')));
  qHelpers.forEach(h => localRefs.push(new RegExp('\\b' + h.replace(/\$/g, '\\$') + '\\(\\s*[\'"]#([A-Za-z_][\\w-]*)[\'"]', 'g')));
  localRefs.forEach(re => { re.lastIndex = 0; while ((m = re.exec(s))) { if (!referenced.has(m[1])) referenced.set(m[1], new Set()); referenced.get(m[1]).add(rel); } });
  // 动态拼接前缀：el('dzIns' + k) / getElementById('finAch' + x) / '#pdb' + key
  const D1 = /(?:getElementById|el|byId|[A-Za-z_$][\w$]*)\(\s*['"]([A-Za-z_][\w-]{2,})['"]\s*\+/g;
  while ((hm = D1.exec(s))) dynPrefixes.add(hm[1]);
  const D2 = /['"]#([A-Za-z_][\w-]{2,})['"]\s*\+/g;
  while ((hm = D2.exec(s))) dynPrefixes.add(hm[1]);
});
const dynRef = (id) => { for (const pre of dynPrefixes) if (id.indexOf(pre) === 0 && id.length > pre.length) return true; return false; };
// 兜底引用判定：任何文件里出现过 'id' / "id" / '#id' 字符串字面量（排除 id="..." 声明本身）即视为被引用
// —— 各视图用 btn('x') / on('x','onclick') / bind('#x') / ['a','b'].forEach 等各自的助手，逐一枚举永远漏
const allSrc = files.map(p => ({ rel: path.relative(root, p), s: read(p) }));
const litRef = (id) => {
  const re = new RegExp("(?<![\\w-])['\"]#?" + id.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&') + "['\"]");
  const declRe = new RegExp('id=\\\\?["\']' + id.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&') + '\\\\?["\']');
  return allSrc.some(f => { const s2 = f.s.replace(declRe, ''); return re.test(s2); });
};

// 交互元素：button / select / input(非 hidden) / textarea
const INTERACTIVE = (k) => k === 'button' || k === 'select' || k === 'textarea' || (k.indexOf('input:') === 0 && k !== 'input:hidden');
const unbound = [];    // 声明了交互 id，但全项目无引用
declared.forEach((decls, id) => {
  const inter = decls.filter(d => INTERACTIVE(d.kind));
  if (!inter.length) return;
  if (referenced.has(id) || dynRef(id) || litRef(id)) return;
  unbound.push({ id, where: [...new Set(inter.map(d => d.file + '(' + d.kind + ')'))].join(', ') });
});
const dangling = [];   // 引用了不存在的 id（排除动态拼接：引用处若是 'xxx' + 变量 抓不到，本审计只抓字面量）
referenced.forEach((fset, id) => {
  if (declared.has(id) || dynRef(id)) return;
  // 一些 id 由字符串拼接声明（'id="' + x + '"'）——静态抓不到；只把明显的静态引用报出来
  dangling.push({ id, where: [...fset].join(', ') });
});

// 已知的动态/间接声明白名单（模板拼接出的 id，人工确认过）
const KNOWN_DYNAMIC = /^(rmF_|pdb|pdf|pdc|acModel|acNew|acSend|acInput|acDoc|acBoard|detAll|detRun|detReset|detApply|detLR|detLM|detER|detEM|detTG|detTA)/;

console.log('文件 ' + files.length + ' 个；声明 id ' + declared.size + '；被引用 id ' + referenced.size);
const ub = unbound.filter(u => !KNOWN_DYNAMIC.test(u.id)).sort((a, b) => a.where.localeCompare(b.where));
const dg = dangling.filter(d => !KNOWN_DYNAMIC.test(d.id)).sort((a, b) => a.where.localeCompare(b.where));
console.log('\n【疑似未绑定的交互元素】（声明了 id，全项目无任何引用）: ' + ub.length);
ub.forEach(u => console.log('  · #' + u.id + '  ← ' + u.where));
console.log('\n【引用了不存在的 id】: ' + dg.length);
dg.forEach(d => console.log('  · #' + d.id + '  ← ' + d.where));
if (ALL) {
  console.log('\n【按文件统计】');
  const perFile = {};
  declared.forEach((decls, id) => decls.forEach(d => { if (INTERACTIVE(d.kind)) { perFile[d.file] = perFile[d.file] || { n: 0, un: 0 }; perFile[d.file].n++; if (!referenced.has(id)) perFile[d.file].un++; } }));
  Object.keys(perFile).sort().forEach(f => console.log('  ' + f.padEnd(40) + ' 交互 id ' + String(perFile[f].n).padStart(3) + '  未引用 ' + perFile[f].un));
}
process.exit(ub.length + dg.length ? 1 : 0);

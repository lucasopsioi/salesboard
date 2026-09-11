// app/ppt-preview.test.js — 导出预览：spec → HTML 的保真度与转义
const P = require('./ppt-preview.js');
let f = 0; const ok = (n, c, d) => { console.log((c ? 'PASS ' : 'FAIL ') + n + (!c && d !== undefined ? '  << ' + JSON.stringify(d) : '')); if (!c) f++; };
const count = (s, re) => (s.match(re) || []).length;

const spec = {
  title: '汇总表 · 按产品系列',
  rows: [
    [{ text: '系列', options: { bold: true, align: 'left', fill: { color: 'C7000B' }, color: 'FFFFFF' } },
     { text: '26累计SO', options: { bold: true } },
     { text: '全流程DOS', options: { bold: true } }],
    [{ text: 'Slate Pro系列', options: { align: 'left' } }, { text: '1,910' }, { text: '132' }],
  ],
  colW: [2, 1, 1.5],
  fontSize: 8,
  rowH: 0.2,
  x: 0.3, y: 0.85,
};
const h = P.slideHtml(spec, { scale: 72 });

ok('H1 幻灯片按 13.333×7.5 英寸出图', /width:959\.976px/.test(h) && /height:540px/.test(h), h.slice(0, 120));
ok('H2 列宽用的就是导出用的那份 colW（英寸×scale）', /width:144px/.test(h) && /width:72px/.test(h) && /width:108px/.test(h));
ok('H3 行数列数与 spec 一致', count(h, /<tr/g) === 2 && count(h, /<td/g) === 6);
ok('H4 字号由磅换算成像素（8pt @72 = 8px）', /font-size:8px/.test(h), h.match(/font-size:[\d.]+px/g));
ok('H5 表头底色/字色/加粗照搬', /background:#C7000B/.test(h) && /color:#FFFFFF/.test(h) && /font-weight:700/.test(h));
ok('H6 左对齐/右对齐照搬', /text-align:left/.test(h) && /text-align:right/.test(h));
ok('H7 标题渲染出来', h.indexOf('汇总表 · 按产品系列') > 0);

// 预览必须诚实：绝不能加 nowrap 把「这列太窄」藏起来
ok('H8 预览里没有 white-space:nowrap（表格单元格）', !/pv-tbl td\{[^}]*nowrap/.test(P.CSS), P.CSS.split('\n').filter(l => /pv-tbl td/.test(l)));
ok('H8b 被挤的列在预览上标出来', (() => {
  const h2 = P.slideHtml(Object.assign({}, spec, { squeezed: [2] }), { scale: 72 });
  return count(h2, /class="pv-sq"/g) === 2;                 // 该列的两行都标
})());

// XSS / 破坏 HTML：数据来自 Excel，什么字符都可能有
ok('H9 文本转义（尖括号/引号不许破坏结构）', (() => {
  const h2 = P.slideHtml({ rows: [['<img src=x onerror=alert(1)>', 'a"b']], colW: [1, 1], fontSize: 8 }, {});
  return h2.indexOf('<img') < 0 && h2.indexOf('&lt;img') > 0 && h2.indexOf('a&quot;b') > 0;
})());
ok('H10 标题也转义', P.slideHtml({ title: '<b>x</b>', rows: [], colW: [] }, {}).indexOf('&lt;b&gt;') > 0);

// 空 spec 不炸
ok('H11 空 spec 不炸', (() => { const x = P.slideHtml({}, {}); return typeof x === 'string' && x.indexOf('pv-slide') > 0; })());
ok('H12 缺 options 的纯字符串单元格也认', P.slideHtml({ rows: [['纯文本']], colW: [1], fontSize: 8 }, {}).indexOf('纯文本') > 0);

// 颜色白名单：非法色值不许原样注入到 style 里
ok('H13 非法颜色回退，不注入原串', (() => {
  const h2 = P.slideHtml({ rows: [[{ text: 'x', options: { color: 'red;position:fixed' } }]], colW: [1], fontSize: 8 }, {});
  return h2.indexOf('position:fixed') < 0;
})());

// 换行告警文案
ok('H14 有被挤的列时给出列名告警', (() => {
  const w = P.squeezeWarning([Object.assign({}, spec, { squeezed: [0, 2] })]);
  return /系列/.test(w) && /全流程DOS/.test(w);
})(), P.squeezeWarning([Object.assign({}, spec, { squeezed: [0, 2] })]));
ok('H15 没被挤就不告警', P.squeezeWarning([spec]) === '' && P.squeezeWarning([]) === '');

console.log(f ? (f + ' FAILED') : 'ALL PASS');
process.exit(f ? 1 : 0);

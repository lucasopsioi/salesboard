// 颜色记忆内核：已用色收集 + 近似吸附 + 分裂色分组
const CM = require('./color-memory-core.js');
let f = 0; const ok = (n, c) => { console.log((c ? 'PASS ' : 'FAIL ') + n); if (!c) f++; };
const cols = list => list.map(x => x.color).join(',');

/* ---------- normHex ---------- */
ok('normHex 大写转小写', CM.normHex('#1E9E57') === '#1e9e57');
ok('normHex 补 #', CM.normHex('1e9e57') === '#1e9e57');
ok('normHex 三位简写展开', CM.normHex('#abc') === '#aabbcc');
ok('normHex 非法值 → 空', CM.normHex('红色') === '' && CM.normHex('') === '' && CM.normHex(null) === '');
ok('normHex 长度不对 → 空', CM.normHex('#12345') === '');

/* ---------- dist ---------- */
ok('同色距离 0', CM.dist('#1e9e57', '#1E9E57') === 0);
ok('差一档距离很小', CM.dist('#1e9e57', '#1e9e58') === 1);
ok('黑白距离最大(√(255²×3)≈441.67)', Math.round(CM.dist('#000000', '#ffffff')) === 442);
ok('非法色 → Infinity', CM.dist('#1e9e57', 'xxx') === Infinity);

/* ---------- nearest / snap（核心：点歪了要被吞回来，真·相近色不能吞） ---------- */
const PAL = ['#1e9e57', '#c7000b', '#0a5bd3'];
ok('点歪一两档 → 命中已用色', CM.nearest('#1e9e58', PAL).color === '#1e9e57');
ok('明显不同的绿 → 不命中', CM.nearest('#2fbf6a', PAL) === null);
ok('完全不同的色 → 不命中', CM.nearest('#ffffff', PAL) === null);
ok('snap 点歪 → 吸附并标记', (() => { const r = CM.snap('#1e9e59', PAL); return r.color === '#1e9e57' && r.snapped === true && r.from === '#1e9e59'; })());
ok('snap 精确命中 → 不算吸附', (() => { const r = CM.snap('#1e9e57', PAL); return r.color === '#1e9e57' && r.snapped === false; })());
ok('snap 无命中 → 原样返回', (() => { const r = CM.snap('#2fbf6a', PAL); return r.color === '#2fbf6a' && r.snapped === false; })());
ok('snap 空调色板 → 原样', CM.snap('#1e9e57', []).color === '#1e9e57');
ok('snap 大小写无关', CM.snap('#1E9E58', PAL).color === '#1e9e57');
ok('阈值可调：调小后不吸附', CM.snap('#1e9e59', PAL, 1).snapped === false);
ok('取最近的那个而非第一个', CM.nearest('#0a5bd4', ['#1e9e57', '#0a5bd3']).color === '#0a5bd3');
ok('默认阈值=10', CM.SNAP_TOL === 10);

/* ---------- usedColors（顺序=本产品→其它产品→样机，去重） ---------- */
const cur = { id: 'p1', name: 'Slate Tab', skus: [{ name: 'A', color: '#1E9E57' }, { name: 'B', color: '#C7000B' }],
  accessories: { 键盘: { color: '#333333' } } };
const other = { id: 'p2', name: 'Slate Air', skus: [{ name: 'C', color: '#0A5BD3' }, { name: 'D', color: '#1e9e57' }] };
const used = CM.usedColors({ current: cur, products: [cur, other] });
ok('本产品颜色排最前', cols(used).indexOf('#1e9e57,#c7000b') === 0);
ok('配件色也进已用色', cols(used).includes('#333333'));
ok('其它产品颜色排后面', cols(used).endsWith('#0a5bd3'));
ok('跨产品同色只出现一次', cols(used).split(',').filter(c => c === '#1e9e57').length === 1);
ok('当前产品不被重复计入', cols(used) === '#1e9e57,#c7000b,#333333,#0a5bd3');
ok('样机颜色也收', cols(CM.usedColors({ samples: [{ name: 'S1', color: '#ABCDEF' }] })) === '#abcdef');
ok('label 便于 tooltip', used[0].label === '本产品 · A');
ok('无入参不炸', CM.usedColors({}).length === 0 && CM.usedColors().length === 0);
ok('非法色被剔除', CM.usedColors({ current: { skus: [{ color: '' }, { color: 'xx' }, { color: '#111111' }] } }).length === 1);
ok('limit 生效', CM.usedColors({ current: cur, products: [cur, other], limit: 2 }).length === 2);

/* ---------- splitGroups（找出"本该同色却分裂"的那几组） ---------- */
const g = CM.splitGroups(['#1e9e57', '#1e9e58', '#c7000b', '#1e9e59']);
ok('分裂组：三个几乎同绿归一组', g.length === 1 && g[0].keep === '#1e9e57' && g[0].dups.length === 2);
ok('分裂组不含真正不同的色', !g.some(x => x.dups.includes('#c7000b')));
ok('全不同 → 无分裂组', CM.splitGroups(['#000000', '#ffffff', '#1e9e57']).length === 0);
ok('完全相同不算分裂', CM.splitGroups(['#1e9e57', '#1E9E57']).length === 0);

console.log(f ? ('\n' + f + ' FAILED') : '\nALL PASS'); process.exit(f ? 1 : 0);

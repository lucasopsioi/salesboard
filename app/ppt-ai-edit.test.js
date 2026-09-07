// app/ppt-ai-edit.test.js — PPT 对话改图：摘要 / 提示词 / 补丁解析 / 校验夹取
const A = require('./ppt-ai-edit.js');
let f = 0; const ok = (n, c, d) => { console.log((c ? 'PASS ' : 'FAIL ') + n + (!c && d !== undefined ? '  << ' + JSON.stringify(d) : '')); if (!c) f++; };

const PAGE = { w: 13.333, h: 7.5 };
const slide = { elements: [
  { id: 'e1', type: 'text', x: 1, y: 1, w: 4, h: 0.8, text: '2027 拉美平板 销售团队', style: { fontSize: 24, bold: true, color: '1A1A1A' } },
  { id: 'e2', type: 'text', x: 1, y: 2, w: 4, h: 0.6, text: '副标题', style: { fontSize: 14 } },
  { id: 'e3', type: 'kpi', x: 6, y: 1, w: 3, h: 1.2, binding: { metric: 'rev' }, style: { fontSize: 28 } },
] };

// —— 摘要 ——
const d1 = A.describeElement(slide.elements[0]);
ok('D1 摘要含可改字段', d1.id === 'e1' && d1.fontSize === 24 && d1.text === '2027 拉美平板 销售团队', d1);
ok('D2 绑定只暴露「有」不暴露细节', A.describeElement(slide.elements[2]).hasDataBinding === true && A.describeElement(slide.elements[2]).binding === undefined);
ok('D3 整页摘要', A.describeSlide(slide).length === 3);

// —— 提示词 ——
const msgs = A.buildMessages({ page: PAGE, element: d1, slideElements: A.describeSlide(slide), instruction: '标题改成红色，字号大一点' });
ok('P1 system 要求纯 JSON', /只输出 JSON/.test(msgs[0].content));
ok('P2 system 禁止改 binding', /绝对不许修改 id、type、binding/.test(msgs[0].content));
ok('P3 选中元素进了 user', /"id":"e1"/.test(msgs[1].content));
ok('P4 用户要求进了 user', /标题改成红色/.test(msgs[1].content));
ok('P5 同页其它元素供参考但排除自己', /e2/.test(msgs[1].content) && (msgs[1].content.match(/"id":"e1"/g) || []).length === 1);

// —— 解析 ——
ok('J1 容忍 ```json 围栏', !!A.parsePatch('```json\n{"ops":[]}\n```'));
ok('J2 容忍前后废话', !!A.parsePatch('好的，改动如下：{"ops":[{"id":"e1"}]} 完成'));
ok('J3 非 JSON 返回 null', A.parsePatch('我改不了') === null);

// —— 校验夹取 ——
const r1 = A.sanitize({ ops: [{ id: 'e1', set: { color: '#c7000b', fontSize: 32 } }] }, slide, PAGE);
ok('S1 颜色去#转大写、字号保留', r1.ops[0].set.style.color === 'C7000B' && r1.ops[0].set.style.fontSize === 32, r1.ops);
ok('S2 合并进原样式而不是覆盖', r1.ops[0].set.style.bold === true, r1.ops[0].set.style);
const r2 = A.sanitize({ ops: [{ id: 'e3', set: { binding: { metric: 'gm' }, fontSize: 20 } }] }, slide, PAGE);
ok('S3 拒绝改 binding 但保留合法改动', !('binding' in r2.ops[0].set) && r2.ops[0].set.style.fontSize === 20 && r2.rejected.some(x => /受保护字段 binding/.test(x)), r2);
const r3 = A.sanitize({ ops: [{ id: 'e1', set: { type: 'image', id: 'zzz' } }] }, slide, PAGE);
ok('S4 拒绝改 id/type 且无有效改动时不产出 op', r3.ops.length === 0 && r3.rejected.some(x => /受保护字段 type/.test(x)), r3);
const r4 = A.sanitize({ ops: [{ id: 'e1', set: { w: 99, x: 50 } }] }, slide, PAGE);
ok('S5 超页尺寸被夹到页面内并记录', r4.ops[0].set.w === PAGE.w && r4.ops[0].set.x < PAGE.w && r4.rejected.length >= 1, r4);
const r5 = A.sanitize({ ops: [{ id: 'nope', set: { w: 2 } }] }, slide, PAGE);
ok('S6 编造的元素 id 被丢弃', r5.ops.length === 0 && r5.rejected.some(x => /不在当前页/.test(x)));
const r6 = A.sanitize({ ops: [{ id: 'e1', set: { color: '红色' } }] }, slide, PAGE);
ok('S7 非法颜色被拒并说明格式', r6.ops.length === 0 && r6.rejected.some(x => /6 位十六进制/.test(x)), r6);
const r7 = A.sanitize({ ops: [{ id: 'e1', set: { fontSize: 999, opacity: 5 } }] }, slide, PAGE);
ok('S8 字号/透明度夹到合理区间', r7.ops[0].set.style.fontSize === 96 && r7.ops[0].set.style.opacity === 1, r7.ops[0].set.style);
const r8 = A.sanitize({ ops: [{ id: 'e2', set: { text: '新副标题', align: 'center' } }] }, slide, PAGE);
ok('S9 文本与对齐可改', r8.ops[0].set.text === '新副标题' && r8.ops[0].set.style.align === 'center', r8.ops[0].set);
ok('S10 空 ops 给可读理由', A.sanitize({ ops: [] }, slide, PAGE).rejected.length === 1);

// —— 全链 ——
const plan = A.planFrom('```json\n{"ops":[{"id":"e1","set":{"color":"C7000B"}}],"note":"标题改红"}\n```', slide, PAGE);
ok('L1 planFrom 串起解析+校验', plan.ops.length === 1 && plan.ops[0].set.style.color === 'C7000B' && plan.note === '标题改红', plan);
ok('L2 不可解析时给可读理由', A.planFrom('抱歉我做不到', slide, PAGE).rejected.some(x => /没有返回可解析的 JSON/.test(x)));

console.log(f ? (f + ' FAILED') : 'ALL PASS');
process.exit(f ? 1 : 0);

// 堆叠顺序记忆的合并逻辑 mergeSavedOrder(saved, current)：
// 记住的产品按记忆顺序在前、当前新出现/筛选带出的产品保持 current 相对序排后、记忆里已消失的产品被丢弃。
const { mergeSavedOrder } = require('./views/psi-view.js');
let f = 0; const ok = (n, c) => { console.log((c ? 'PASS ' : 'FAIL ') + n); if (!c) f++; };
const J = a => JSON.stringify(a);

ok('saved 为空 → 原序副本', J(mergeSavedOrder([], ['A', 'B', 'C'])) === J(['A', 'B', 'C']));
ok('saved 未定义 → 原序副本', J(mergeSavedOrder(undefined, ['A', 'B'])) === J(['A', 'B']));
ok('全覆盖 → 按记忆顺序', J(mergeSavedOrder(['C', 'A', 'B'], ['A', 'B', 'C'])) === J(['C', 'A', 'B']));
ok('新产品保持 current 序排末尾', J(mergeSavedOrder(['C', 'A'], ['A', 'B', 'C', 'D'])) === J(['C', 'A', 'B', 'D']));
ok('记忆里已消失的产品被丢弃', J(mergeSavedOrder(['X', 'C', 'A'], ['A', 'B', 'C'])) === J(['C', 'A', 'B']));
const cur = ['A', 'B', 'C']; mergeSavedOrder(['C'], cur);
ok('不修改入参 current', J(cur) === J(['A', 'B', 'C']));

console.log(f ? ('\n' + f + ' FAILED') : '\nALL PASS'); process.exit(f ? 1 : 0);

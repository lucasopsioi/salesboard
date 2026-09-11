/* ai-context.test.js — MiniMax AI 数据层纯函数测试（无浏览器）。
   覆盖：snapshot 截断 / 回退协议 JSON 解析（含嵌套/非法输入）/ 工具注册表分发。
   Run: node app/ai-context.test.js  —— 必须 ALL PASS。 */
'use strict';
const AC = require('./ai-context.js');

let fails = 0;
function ok(name, cond) { console.log((cond ? 'PASS ' : 'FAIL ') + name); if (!cond) fails++; }
function eq(name, got, exp) { ok(name + '  got=' + JSON.stringify(got), JSON.stringify(got) === JSON.stringify(exp)); }

/* ---------- 1) truncateSnapshot ---------- */
ok('trunc: 短串原样返回', AC.truncateSnapshot('hello', 100) === 'hello');
ok('trunc: 等长不截', AC.truncateSnapshot('abcde', 5) === 'abcde');
(() => {
  const s = 'x'.repeat(50);
  const r = AC.truncateSnapshot(s, 20);
  ok('trunc: 超长被截到 <= max', r.length <= 20);
  ok('trunc: 超长带截断标注', /数据已截断/.test(r));
})();
ok('trunc: null 归一为空串', AC.truncateSnapshot(null, 10) === '');
ok('trunc: 非字符串对象转串', typeof AC.truncateSnapshot({ a: 1 }, 100) === 'string');
ok('trunc: 默认上限=SNAPSHOT_MAX', AC.truncateSnapshot('y'.repeat(AC.SNAPSHOT_MAX + 100)).length <= AC.SNAPSHOT_MAX);
ok('trunc: max<=0 走默认上限', AC.truncateSnapshot('short', 0) === 'short');

/* ---------- 2) parseToolCall（回退协议） ---------- */
eq('parse: 整段 JSON', AC.parseToolCall('{"tool":"report","args":{"groupDim":"series"}}'),
  { tool: 'report', args: { groupDim: 'series' } });
eq('parse: 无 args 补空对象', AC.parseToolCall('{"tool":"sosimSummary"}'),
  { tool: 'sosimSummary', args: {} });
eq('parse: 代码围栏包裹', AC.parseToolCall('```json\n{"tool":"query","args":{"metric":"sellIn"}}\n```'),
  { tool: 'query', args: { metric: 'sellIn' } });
eq('parse: 前后有说明文字，抠出 JSON', AC.parseToolCall('好的，我需要数据：{"tool":"agg","args":{}} 谢谢'),
  { tool: 'agg', args: {} });
eq('parse: 嵌套 args', AC.parseToolCall('{"tool":"report","args":{"filters":{"country":["墨西哥"]},"weeks":9}}'),
  { tool: 'report', args: { filters: { country: ['墨西哥'] }, weeks: 9 } });
eq('parse: OpenAI 风格 arguments 字符串', AC.parseToolCall('{"name":"query","arguments":"{\\"gran\\":\\"week\\"}"}'),
  { tool: 'query', args: { gran: 'week' } });
// 非法/非工具输入 → null
ok('parse: 纯文本返回 null', AC.parseToolCall('这是一段普通回答，没有工具调用') === null);
ok('parse: 空串返回 null', AC.parseToolCall('') === null);
ok('parse: null 返回 null', AC.parseToolCall(null) === null);
ok('parse: 坏 JSON 返回 null', AC.parseToolCall('{"tool":"report", args:}') === null);
ok('parse: 无 tool 键返回 null', AC.parseToolCall('{"foo":"bar"}') === null);
ok('parse: 数组返回 null', AC.parseToolCall('[1,2,3]') === null);
ok('parse: tool 非字符串返回 null', AC.parseToolCall('{"tool":123}') === null);
// 含大括号但只有一个合法 → 取第一个合法的
eq('parse: 文本里有非法{}后有合法{}', AC.parseToolCall('先看 {不是json} 再 {"tool":"agg","args":{}}'),
  { tool: 'agg', args: {} });

/* ---------- 3) toolNames / dispatchTool（工具分发） ---------- */
const registry = {
  echo: async (args) => ({ echoed: args }),
  boom: async () => { throw new Error('炸了'); },
  undef: async () => undefined,
};
eq('toolNames: 列出注册工具', AC.toolNames(registry).sort(), ['boom', 'echo', 'undef']);
eq('toolNames: 空注册表', AC.toolNames(null), []);

(async () => {
  const r1 = await AC.dispatchTool(registry, { tool: 'echo', args: { a: 1 } });
  eq('dispatch: 正常调用透传 args', r1, { echoed: { a: 1 } });

  const r2 = await AC.dispatchTool(registry, { tool: 'nope', args: {} });
  ok('dispatch: 未知工具返回 error', r2 && /未知工具/.test(r2.error));

  const r3 = await AC.dispatchTool(registry, { tool: 'boom', args: {} });
  ok('dispatch: 工具抛错被捕获为 error', r3 && r3.error === '炸了');

  const r4 = await AC.dispatchTool(registry, null);
  ok('dispatch: 空调用返回 error', r4 && /无效/.test(r4.error));

  const r5 = await AC.dispatchTool(registry, { tool: 'undef', args: {} });
  ok('dispatch: undefined 结果归一为 null', r5 === null);

  const r6 = await AC.dispatchTool(registry, { tool: 'echo' }); // 无 args
  eq('dispatch: 无 args 补空对象', r6, { echoed: {} });

  /* ---------- 4) stringifyToolResult ---------- */
  const s = AC.stringifyToolResult('report', { total: { curYear: 100 } });
  ok('stringify: 含工具名前缀', /\[工具 report 返回\]/.test(s));
  ok('stringify: 含 JSON 体', /curYear/.test(s));
  ok('stringify: 循环引用不抛', (() => {
    const o = {}; o.self = o;
    try { AC.stringifyToolResult('x', o); return true; } catch (e) { return false; }
  })());

  /* ---------- 5) CALIBER_PROMPT 存在且含关键口径 ---------- */
  ok('caliber: 含 DOS 口径', /DOS\s*=\s*库存/.test(AC.CALIBER_PROMPT));
  ok('caliber: 含 NSIP 口径', /NSIP/.test(AC.CALIBER_PROMPT));
  ok('caliber: 含渠道不去重', /不去重/.test(AC.CALIBER_PROMPT));

  console.log(fails ? ('\n' + fails + ' FAILED') : '\nALL PASS');
  process.exit(fails ? 1 : 0);
})();

'use strict';
/* ============================================================
   AI 工具层回归测试 —— 锁住 2026-08-10 修掉的一批「模型看不见数据」缺陷。
   背景：用户在 PSI 看板筛了 Product Series=Coral 问「最近一个月卖得怎么样」，
   模型答「当前看板数据未包含该项」。根因有三个，本文件逐个上锁：
     ① 快照摘要读错字段名 → 注入给模型的数字全是空对象 {}
     ② 工具 schema 是 properties:{} 空壳 → 模型不知道能按维度取数
     ③ query 的 stackDim 默认 null → 引擎抛错，该工具恒返回空
   纯 Node，无 electron / 无 DOM / 无网络。
   ============================================================ */
const AD = require('./ai-context.js');
const fs = require('fs'), os = require('os'), path = require('path');
const E = require('../engine.js');

let f = 0; const ok = (n, c) => { console.log((c ? 'PASS ' : 'FAIL ') + n); if (!c) f++; };

/* ---------- ① 快照摘要:字段名必须与 engine-report 产出一致 ---------- */
const eng = new E.Engine(fs.mkdtempSync(path.join(os.tmpdir(), 'sb-aitool-')));
eng.loadSample();
const rep = eng.report({ groupDim: 'series', filters: {}, weeks: 4 });
const ROW_KEYS = Object.keys(rep.rows[0] || {});
ok('T1 引擎 report 行字段确实是 key/cumCur/cumPrev(不是 label/name/curYear)',
  ROW_KEYS.includes('key') && ROW_KEYS.includes('cumCur') && !ROW_KEYS.includes('label') && !ROW_KEYS.includes('curYear'));
// 复刻 ai-context.summarizeReport 的取值方式（它在 IIFE 内，Node 拿不到函数本体，这里锁字段契约）
const one = r => ({ 组: r.key, 累计SO: r.cumCur, 去年同期SO: r.cumPrev, SO同比: r.yoy, 累计SI: r.siCur, 库存: r.inv, DOS: r.dos, 近4周SO: r.last4 });
const sample = one(rep.rows[0]);
ok('T2 摘要字段全部取到值(不再是空对象 {})', Object.keys(sample).every(k => sample[k] !== undefined) && sample.组 && sample.累计SO > 0);
ok('T3 旧写法(label/name/curYear)在真实行上恒为 undefined —— 证明旧快照确实是空的',
  rep.rows[0].label === undefined && rep.rows[0].name === undefined && rep.rows[0].curYear === undefined);
// financeOverview 的预测字段是 fc 不是 forecast
const ov = eng.financeOverview({});
const rev = (ov.metrics || {}).rev || {};
ok('T4 财经指标字段是 fc/bpAttain/fcAttain(旧代码读 forecast 恒 undefined)',
  rev.fc !== undefined && rev.bpAttain !== undefined && rev.forecast === undefined);

/* ---------- ② 工具 schema:必须是可执行规格,不是空壳 ---------- */
const S = AD.TOOL_SCHEMAS, DIMS = AD.DIM_KEYS;
ok('T5 导出了 TOOL_SCHEMAS / buildToolSpecs / DIM_KEYS', !!S && typeof AD.buildToolSpecs === 'function' && Array.isArray(DIMS) && DIMS.length === 9);
const names = Object.keys(S);
ok('T6 覆盖关键工具(meta/options/report/query/财经四件套/boardState)',
  ['meta', 'options', 'report', 'query', 'financeOverview', 'financeProductBoard', 'financeRepBoard', 'financeCustom', 'boardState'].every(n => names.includes(n)));
const specs = AD.buildToolSpecs(names);
ok('T7 每个 spec 结构合法(type/function/name/parameters.type=object)',
  specs.length === names.length && specs.every(s => s.type === 'function' && s.function && s.function.name && s.function.parameters && s.function.parameters.type === 'object'));
ok('T8 additionalProperties 一律 false(GBNF 约束需要闭合 schema)', specs.every(s => s.function.parameters.additionalProperties === false));
ok('T9 描述非空(模型靠它判断该调哪个)', specs.every(s => typeof s.function.description === 'string' && s.function.description.length > 8));
const byName = {}; specs.forEach(s => { byName[s.function.name] = s.function.parameters; });
ok('T10 report/query/options 都不是空壳(properties 非空)',
  ['report', 'query', 'options'].every(n => Object.keys(byName[n].properties || {}).length > 0));
ok('T11 维度枚举 = 九个 PSI 维度键,模型不能自造维度名',
  byName.options.properties.field.enum.join(',') === DIMS.join(',') && byName.report.properties.groupDim.enum.join(',') === DIMS.join(','));
// filters 刻意用「一句话描述 + 开放对象」而非逐个列 9 个维度:
// 逐列会在 4 个含 filters 的工具里各抄一遍(≈600 token 输入),本地模型每轮都要重读,直接拖慢首字。
// 所以这里改为验证「能力」而不是「结构」:键名在描述里写全 + 校验器真的接受 series=Coral。
ok('T12 filters 描述里写全 9 个维度键名(模型据此知道能按 series 筛)',
  (() => { const d = byName.report.properties.filters.description || ''; return DIMS.every(k => d.indexOf(k) >= 0); })());
// 只断言「有一个 键:[字符串数组] 的例子」，不锁死具体产品名——
// 描述为省 token 精简过，锁字面量会让正常瘦身也变成失败。
ok('T12b filters 描述里给了 {"维度":["取值"]} 形状的例子',
  /\{"[a-z]+":\["[^"]+"\]\}/.test(byName.report.properties.filters.description || ''));
ok('T13 query.stackDim 标记为必填(引擎硬性要求)', (byName.query.required || []).includes('stackDim'));
ok('T14 没有 type:["string","null"] 这类会炸 GBNF 的写法', JSON.stringify(specs).indexOf('"null"') < 0);
ok('T15 没有 $defs/$ref(llama.cpp 转换器兼容性)', JSON.stringify(specs).indexOf('$ref') < 0 && JSON.stringify(specs).indexOf('$defs') < 0);

/* ---------- ③ query 的 stackDim:不传就是引擎级错误,必须挡在工具层 ---------- */
let threw = false;
try { eng.query({ metric: 'sellOut', gran: 'month', filters: {} }); } catch (e) { threw = true; }
ok('T16 引擎 query 不传 stackDim 会抛 —— 所以工具层必须要求必填并回可读错误', threw);
const q = eng.query({ metric: 'sellOut', gran: 'month', stackDim: 'series', filters: {} });
ok('T17 传了 stackDim 才有数据(证明旧默认 null 会让该工具恒空)', (q.series || []).length > 0 && (q.buckets || []).length > 0);

/* ---------- 按维度取数确实能命中「某个系列」(Coral 场景的示例数据等价物) ---------- */
const someSeries = eng.options('series', {})[0];
const filtered = eng.report({ groupDim: 'product', filters: { series: [someSeries] }, weeks: 4 });
ok('T18 按 series 精确筛能拿到该系列下的产品行(用户问「某系列卖得怎么样」的取数路径通)',
  !!someSeries && (filtered.rows || []).length > 0 && filtered.total.cumCur > 0);
const wrong = eng.report({ groupDim: 'product', filters: { series: ['不存在的系列XYZ'] }, weeks: 4 });
ok('T19 拼错名字会静默返回空 → 所以提示词强制「先 options 查精确写法」', (wrong.rows || []).length === 0);

/* ---------- 口径卡:跨看板 agent 必须知道的几条 ---------- */
const CP = AD.CALIBER_PROMPT;
ok('T20 口径卡含 DOS 分母(近4周÷28)', /近\s*4|4\s*个?\s*ISO\s*周/.test(CP) && CP.indexOf('28') >= 0);
ok('T21 口径卡含销毛率「先求和再相除」', CP.indexOf('销毛率') >= 0 && (CP.indexOf('再相除') >= 0 || CP.indexOf('求和') >= 0));
ok('T22 口径卡含 NSIP 同比是绝对美元差', CP.indexOf('NSIP') >= 0 && CP.indexOf('绝对') >= 0);
ok('T23 口径卡含 PSI↔财经 层级错位映射', CP.indexOf('LV3') >= 0 && CP.indexOf('LV4') >= 0 && CP.indexOf('错位') >= 0);
ok('T24 口径卡含 SISO 差异 ≤100 台属正常', CP.indexOf('100') >= 0);
ok('T25 口径卡含「取值必须来自 options，禁止凭记忆」', CP.indexOf('options') >= 0 && CP.indexOf('禁止') >= 0);
ok('T26 口径卡含音频延迟报量与「—」而非 0', CP.indexOf('音频') >= 0 && CP.indexOf('—') >= 0);

console.log(f ? ('\n' + f + ' FAILED') : '\nALL PASS');
process.exit(f ? 1 : 0);

'use strict';
/* eval/discover.js —— 摸清 demo 数据世界：维度取值、日期范围、关键看板数字。
   出题与真值核对的辅助工具：node eval/discover.js */
const { mountEngine, buildRegistry } = require('./engine-tools.js');

(async () => {
  const t0 = Date.now();
  const engine = await mountEngine();
  const T = buildRegistry(engine);
  const j = (x) => JSON.stringify(x, null, 1);

  console.log('== meta ==');
  console.log(j(await T.meta()));

  for (const f of ['line', 'country', 'rep', 'series', 'product', 'model', 'channel']) {
    const o = await T.options({ field: f, limit: 30 });
    console.log('== options:' + f + ' ==', o.error ? o.error : j(o.取值) + (o.截断 ? ' …截断,全量' + o.全量 : ''));
  }

  console.log('== report by product ==');
  console.log(j(await T.report({ groupDim: 'product' })));

  console.log('== financeOverview (默认=今年到最新实际月) ==');
  console.log(j(await T.financeOverview({})));

  console.log('== industryBoard ==');
  console.log(j(await T.industryBoard({})));

  console.log('== 耗时', ((Date.now() - t0) / 1000).toFixed(1), 's ==');
})().catch(e => { console.error('FAIL', e); process.exit(1); });

'use strict';
/* custom 看板中档升级：配置(cu.binding) → binding-resolver 参数映射 的纯函数测试。
   仿 pptoutput/binding-resolver.test.js 写法，验证两条管线之一（20 图型走 binding）的映射正确性。
   run: node app/custom-binding.test.js */
const CU = require('./views/custom-view.js');
const PptBind = require('./pptoutput/binding-resolver.js');
const PptBindings = require('./pptoutput/designer/bindings.js');
let f=0; const ok=(n,c)=>{ console.log((c?'PASS ':'FAIL ')+n); if(!c)f++; };

(async ()=>{
  // ---- cuBuildElBinding：PSI ----
  {
    const b={ dataset:'psi', measure:'sellOut', agg:'sum', catField:'period', catGran:'month', legend:'line',
              timeFrom:'2026-02', timeTo:'2026-06', filters:{country:['墨西哥']}, compare:'none' };
    const el=CU.cuBuildElBinding(b);
    ok('psi type=chart', el.type==='chart');
    ok('psi dataset', el.binding.dataset==='psi');
    ok('psi measure', el.binding.measure==='sellOut');
    ok('psi agg', el.binding.agg==='sum');
    ok('psi catField', el.binding.catField==='period');
    ok('psi legend', el.binding.legend==='line');
    ok('psi 时间切片(period=时间字段)透传', el.binding.timeFrom==='2026-02' && el.binding.timeTo==='2026-06');
    ok('psi filters 透传', el.binding.filters.country[0]==='墨西哥');
  }
  // ---- 非时间类别字段 → 不带时间切片 ----
  {
    const b={ dataset:'psi', measure:'sellOut', catField:'country', catGran:'month', timeFrom:'x', timeTo:'y', filters:{} };
    const el=CU.cuBuildElBinding(b);
    ok('非时间字段不写 timeFrom', el.binding.timeFrom===undefined && el.binding.timeTo===undefined);
  }
  // ---- IDC ----
  {
    const b={ dataset:'idc', measure:'units', agg:'sum', catField:'priceBand', legend:'brand', filters:{cat:['平板']} };
    const el=CU.cuBuildElBinding(b);
    ok('idc dataset', el.binding.dataset==='idc');
    ok('idc measure', el.binding.measure==='units');
    ok('idc catField', el.binding.catField==='priceBand');
    ok('idc legend', el.binding.legend==='brand');
    ok('idc filters', el.binding.filters.cat[0]==='平板');
  }
  // ---- finance ----
  {
    const b={ dataset:'finance', measure:'rev', basis:'actual', year:2026, fromM:1, toM:6, catField:'lv1',
              version:'v1', filters:{lv1:['平板']} };
    const el=CU.cuBuildElBinding(b);
    ok('fin dataset', el.binding.dataset==='finance');
    ok('fin measure', el.binding.measure==='rev');
    ok('fin basis', el.binding.basis==='actual');
    ok('fin year/月区间', el.binding.year===2026 && el.binding.fromM===1 && el.binding.toM===6);
    ok('fin catField', el.binding.catField==='lv1');
    ok('fin version', el.binding.version==='v1');
    ok('fin filters', el.binding.filters.lv1[0]==='平板');
  }
  // ---- 端到端：cuBuildElBinding → resolveElement 用 mock api，验证 agg 参数确实带到引擎 ----
  {
    let aggSeen=null;
    const api={ agg:(p)=>{ aggSeen=p; return { cats:['1月','2月','3月'], series:['A'], data:{A:{'1月':10,'2月':20,'3月':30}} }; } };
    const el=CU.cuBuildElBinding({ dataset:'psi', measure:'sellOut', agg:'sum', catField:'period', catGran:'month', legend:'line', filters:{family:['平板']} });
    const r=await PptBindings.resolveElement(api, PptBind, el);
    ok('e2e resolveElement 返回 matrix', r.kind==='matrix');
    ok('e2e cats', JSON.stringify(r.cats)===JSON.stringify(['1月','2月','3月']));
    ok('e2e agg.cat.field=period', aggSeen.cat.field==='period');
    ok('e2e agg.legend=line', aggSeen.legend==='line');
    ok('e2e agg.agg=sum 透传', aggSeen.agg==='sum');
    ok('e2e filters 传入引擎', aggSeen.filters.family[0]==='平板');
  }
  // ---- idc 端到端 → dataset:idc 带到引擎 ----
  {
    let seen=null;
    const api={ agg:(p)=>{ seen=p; return { cats:['A','B'], series:['x'], data:{x:{A:1,B:2}} }; } };
    const el=CU.cuBuildElBinding({ dataset:'idc', measure:'units', agg:'sum', catField:'priceBand', legend:'brand', filters:{} });
    await PptBindings.resolveElement(api, PptBind, el);
    ok('idc e2e dataset:idc', seen.dataset==='idc');
    ok('idc e2e cat.field', seen.cat.field==='priceBand');
  }
  // ---- finance 端到端 → financeCustom metrics/rowDim ----
  {
    let seen=null;
    const api={ financeCustom:(p)=>{ seen=p; return { rows:[{key:'平板',rev:300}], total:{rev:300} }; } };
    const el=CU.cuBuildElBinding({ dataset:'finance', measure:'rev', basis:'actual', year:2026, fromM:1, toM:6, catField:'lv1', filters:{} });
    const r=await PptBindings.resolveElement(api, PptBind, el);
    ok('fin e2e matrix cats', JSON.stringify(r.cats)===JSON.stringify(['平板']));
    ok('fin e2e rowDim=lv1', seen.rowDim==='lv1');
    ok('fin e2e metrics=[rev]', seen.metrics[0]==='rev');
    ok('fin e2e basis=actual', seen.basis==='actual');
  }
  // ---- cuMatrixToRes：矩阵 → chartOption 的 res 形状 ----
  {
    const m={ cats:['1月','2月'], series:[{name:'A',values:[10,20]},{name:'B',values:[1,2]}] };
    const res=CU.cuMatrixToRes(m);
    ok('res cats', JSON.stringify(res.cats)===JSON.stringify(['1月','2月']));
    ok('res series 名', JSON.stringify(res.series)===JSON.stringify(['A','B']));
    ok('res data[A][2月]=20', res.data['A']['2月']===20);
    ok('res total=33', res.total===33);
    // 空系列兜底 → (值)
    const empty=CU.cuMatrixToRes({cats:['x'],series:[]});
    ok('空系列兜底 (值)', empty.series[0]==='(值)' && empty.data['(值)']['x']===0);
  }
  // ---- cuTwoPeriodMatrix：两期矩阵合成 上期/本期 ----
  {
    const A={ cats:['平板','音频'], series:[{name:'x',values:[100,50]}] };
    const B={ cats:['平板','手机'], series:[{name:'x',values:[120,80]}] };
    const m=CU.cuTwoPeriodMatrix(A,B);
    ok('两期 cats 并集(B序为主)', JSON.stringify(m.cats)===JSON.stringify(['平板','手机','音频']));
    ok('两期 series=上期/本期', m.series[0].name==='上期' && m.series[1].name==='本期');
    ok('上期 平板=100', m.series[0].values[0]===100);
    ok('本期 平板=120', m.series[1].values[0]===120);
    ok('本期 音频=0(仅A有)', m.series[1].values[2]===0);
    ok('上期 手机=0(仅B有)', m.series[0].values[1]===0);
  }
  // ---- cuPeriodInRange：月份宽松匹配 ----
  {
    ok('2026-03 在 2-6', CU.cuPeriodInRange('2026-03',2,6)===true);
    ok('2026-01 不在 2-6', CU.cuPeriodInRange('2026-01',2,6)===false);
    ok('“2026-6月” 在 2-6', CU.cuPeriodInRange('2026-6月',2,6)===true);
    ok('无月份→保留', CU.cuPeriodInRange('2026',2,6)===true);
    // 年份过滤（同比区分年）
    ok('2025-03 年份≠2026 → 排除', CU.cuPeriodInRange('2025-03',1,12,2026)===false);
    ok('2026-03 年份=2026 → 保留', CU.cuPeriodInRange('2026-03',1,12,2026)===true);
    ok('2025-03 年份=2025 → 保留', CU.cuPeriodInRange('2025-03',1,12,2025)===true);
  }
  // ---- 常量/管线归属 ----
  {
    ok('CU_VISUALS 含 22-2=... 至少 17 项', CU.CU_VISUALS.length>=17);
    ok('散点气泡=原生管线', CU.cuIsNative('scatter') && CU.cuIsNative('bubble'));
    ok('柱形=binding 管线', !CU.cuIsNative('column'));
    ok('cuIsTimeField psi period', CU.cuIsTimeField('period','psi')===true);
    ok('cuIsTimeField idc quarter', CU.cuIsTimeField('quarter','idc')===true);
    ok('cuIsTimeField finance 恒 false', CU.cuIsTimeField('lv1','finance')===false);
    ok('cuDefAgg sellOut=sum', CU.cuDefAgg('sellOut','psi')==='sum');
    ok('cuDefAgg inv=last', CU.cuDefAgg('inv','psi')==='last');
    ok('cuDefAgg idc asp=asp', CU.cuDefAgg('asp','idc')==='asp');
  }

  console.log(f?('\n'+f+' FAILED'):'\nALL PASS'); process.exit(f?1:0);
})();

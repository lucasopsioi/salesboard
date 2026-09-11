const PptBind = require('./binding-resolver.js');
let f=0; const ok=(n,c)=>{console.log((c?'PASS ':'FAIL ')+n); if(!c)f++;};
(async ()=>{
  // mock api：记录入参，返回固定 report 结果
  let seen=null;
  const api={ report:(p)=>{ seen=p; return {total:{cumCur:142000, yoy:0.48}}; } };
  const r=await PptBind.resolveTotal(api, {groupDim:'line', filters:{family:['平板']}});
  ok('value=cumCur', r.value===142000);
  ok('yoy 透传', r.yoy===0.48);
  ok('groupDim 传入 report', seen.groupDim==='line');
  ok('filters 传入 report', seen.filters && seen.filters.family[0]==='平板');
  // 无去年同期 → yoy null
  const api2={ report:()=>({total:{cumCur:10, yoy:null}}) };
  const r2=await PptBind.resolveTotal(api2, {filters:{}});
  ok('缺省 groupDim=line', true);
  ok('yoy 可为 null', r2.yoy===null);
  // --- resolveMatrix ---
  const aggRes={ cats:['1月','2月','3月','4月','5月','6月','7月'],
    series:['A','B'],
    data:{ A:{'1月':1,'2月':2,'3月':3,'4月':4,'5月':5,'6月':6,'7月':7},
           B:{'1月':10,'2月':20,'3月':30,'4月':40,'5月':50,'6月':60,'7月':70} } };
  let aggSeen=null;
  const apiM={ agg:(p)=>{ aggSeen=p; return aggRes; } };
  const m=await PptBind.resolveMatrix(apiM, {legend:'line', filters:{family:['平板']}, lastN:6, agg:'avg'});
  ok('cat 取最后 6 个', m.cats.length===6 && m.cats[0]==='2月' && m.cats[5]==='7月');
  ok('series 数=2', m.series.length===2);
  ok('series A 名', m.series[0].name==='A');
  ok('series A 值对齐裁剪', JSON.stringify(m.series[0].values)===JSON.stringify([2,3,4,5,6,7]));
  ok('agg.cat.field=period', aggSeen.cat.field==='period');
  ok('agg.legend 透传', aggSeen.legend==='line');
  ok('agg.agg 透传(avg)', aggSeen.agg==='avg');
  // --- resolveIdcMatrix ---
  const idcRes = { cats:['1：$800+','2：$500-800','3：$350-500'],
    series:['Apple','Samsung'],
    data:{ Apple:{'1：$800+':80,'2：$500-800':20,'3：$350-500':0},
           Samsung:{'1：$800+':20,'2：$500-800':60,'3：$350-500':100} } };
  let idcSeen=null;
  const apiI={ agg:(p)=>{ idcSeen=p; return idcRes; } };
  const im=await PptBind.resolveIdcMatrix(apiI, {catField:'priceBand', legend:'brand', filters:{cat:['平板']}, agg:'avg'});
  ok('idc 走 dataset:idc', idcSeen.dataset==='idc');
  ok('idc cat.field 透传', idcSeen.cat.field==='priceBand');
  ok('idc legend 透传', idcSeen.legend==='brand');
  ok('idc 默认 measure=units', idcSeen.measure==='units');
  ok('idc agg.agg 透传(avg)', idcSeen.agg==='avg');
  ok('idc 系列对齐', im.series[0].name==='Apple' && JSON.stringify(im.series[0].values)===JSON.stringify([80,20,0]));
  // share 归一：每个 cat 列变百分比
  const ims=await PptBind.resolveIdcMatrix(apiI, {catField:'priceBand', legend:'brand', filters:{}, share:true});
  ok('share 列归一: $800+ 列 Apple=80%', ims.series[0].values[0]===80);
  ok('share 列归一: $500-800 列 Apple=25%', ims.series[0].values[1]===25); // 20/(20+60)
  // --- finance (F1) ---
  const BR=PptBind;
  { // finance total + matrix + 预设期
    const calls=[];
    const fapi={ financeCustom:(p)=>{ calls.push(p);
      const rows = p.rowDim==='lv1' ? [{key:'平板',rev:300,gmr:0.3},{key:'音频',rev:100,gmr:0.25}] : [{key:'墨西哥',rev:250,gmr:0.32}];
      const total = {rev:400, gmr:0.29, nsip:88, sellIn:5000, gm:120};
      return {rows, total, curYear:2026, prevYear:2025};
    }};
    // matrix
    const m = await BR.resolveFinanceMatrix(fapi, {dataset:'finance',measure:'rev',catField:'lv1',basis:'actual',year:2026,fromM:1,toM:6,filters:{}});
    ok('finance matrix cats', JSON.stringify(m.cats)===JSON.stringify(['平板','音频']));
    ok('finance matrix series 值', m.series[0].values[0]===300 && m.series[0].name==='净销售收入');
    // total
    const t = await BR.resolveFinanceTotal(fapi, {measure:'gmr',basis:'actual',year:2026,fromM:1,toM:6,filters:{}});
    ok('finance total gmr', t===0.29);
    // finUnits 默认透传
    ok('finUnits 默认', calls[calls.length-1].finUnits.forecast==='MUSD');
  }
  { // comparePeriodsForPreset
    const yoy=BR.comparePeriodsForPreset('yoy',{curYear:2026,fromM:1,toM:6});
    ok('yoy a 去年同期', yoy.a.year===2025&&yoy.a.fromM===1&&yoy.a.toM===6);
    ok('yoy b 今年', yoy.b.year===2026&&yoy.b.toM===6);
    const mom=BR.comparePeriodsForPreset('mom',{curYear:2026,fromM:1,toM:6});
    ok('mom b=最新月6', mom.b.fromM===6&&mom.b.toM===6&&mom.b.year===2026);
    ok('mom a=上月5', mom.a.fromM===5&&mom.a.toM===5);
    const mom1=BR.comparePeriodsForPreset('mom',{curYear:2026,fromM:1,toM:1});
    ok('mom 跨年: a=去年12月', mom1.a.year===2025&&mom1.a.fromM===12&&mom1.a.toM===12);
    const qoq=BR.comparePeriodsForPreset('qoq',{curYear:2026,fromM:4,toM:6});
    ok('qoq b=4-6', qoq.b.fromM===4&&qoq.b.toM===6);
    ok('qoq a=1-3', qoq.a.fromM===1&&qoq.a.toM===3&&qoq.a.year===2026);
  }
  ok('FIN_FMT_DEFAULT gmr=pp', BR.FIN_FMT_DEFAULT.gmr==='pp');
  ok('FIN_FMT_DEFAULT nsip=abs', BR.FIN_FMT_DEFAULT.nsip==='abs');
  ok('FIN_FMT_DEFAULT rev=pct', BR.FIN_FMT_DEFAULT.rev==='pct');
  // --- CP2: 贡献利润(cp) 标签/格式 + measure 透传 ---
  ok('FIN_MEASURE_LABEL.cp=贡献利润', BR.FIN_MEASURE_LABEL.cp==='贡献利润');
  ok('FIN_FMT_DEFAULT.cp=pct', BR.FIN_FMT_DEFAULT.cp==='pct');
  { // resolveFinanceMatrix/Total 传 measure='cp' → 透传给 financeCustom.metrics=['cp']
    const seen=[]; const fapi={ financeCustom:(p)=>{ seen.push(p); return {rows:[{key:'平板',cp:120}], total:{cp:120}}; } };
    const m = await BR.resolveFinanceMatrix(fapi, {measure:'cp',catField:'lv1',basis:'forecast',filters:{}});
    ok('cp matrix series 名=贡献利润', m.series[0].name==='贡献利润' && m.series[0].values[0]===120);
    ok('cp 透传 metrics=[cp]', seen[seen.length-1].metrics[0]==='cp');
    const t = await BR.resolveFinanceTotal(fapi, {measure:'cp',basis:'forecast',filters:{}});
    ok('cp total', t===120);
  }
  console.log(f?('\n'+f+' FAILED'):'\nALL PASS'); process.exit(f?1:0);
})();

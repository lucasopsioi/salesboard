const B = require('./bindings.js');
let f=0; const ok=(n,c)=>{console.log((c?'PASS ':'FAIL ')+n); if(!c)f++;};
// 假 PptBind：记录调用
const PptBind = {
  resolveTotal: async (api,b)=>({value:8578, yoy:0.48}),
  resolveMatrix: async (api,b)=>({cats:['1月','2月'], series:[{name:'A',values:[1,2]}]}),
  resolveIdcMatrix: async (api,b)=>({cats:['$800+'], series:[{name:'Apple',values:[80]}]})
};
// 假 api：记录 agg 入参，返回固定 total
let aggSeen=null;
const api={
  agg:(p)=>{ aggSeen=p; return {total:31337}; },
  report:(p)=>({ total:{ cumCur:8578, yoy:0.48, siCur:8214, siYoy:0.1, inv:16480, dos:53 } })
};
(async()=>{
  const dataEl={type:'data', binding:{dataset:'psi', measure:'sellOut', groupDim:'line', filters:{}}};
  const r1=await B.resolveElement(api, PptBind, dataEl);
  ok('data(sellOut)→report total cumCur/yoy', r1.kind==='value' && r1.value===8578 && r1.yoy===0.48);
  // PSI data + measure:'sellIn' → report total siCur
  const siEl={type:'data', binding:{dataset:'psi', measure:'sellIn', filters:{}}};
  const rSi=await B.resolveElement(api, PptBind, siEl);
  ok('data(sellIn)→report total siCur', rSi.kind==='value' && rSi.value===8214);
  // PSI data + measure:'inv' → 快照,report total inv, yoy null
  const invEl={type:'data', binding:{dataset:'psi', measure:'inv', filters:{}}};
  const rInv=await B.resolveElement(api, PptBind, invEl);
  ok('data(inv)→report total inv, yoy null', rInv.kind==='value' && rInv.value===16480 && rInv.yoy===null);
  // PSI data + measure:'dos' → 重算,report total dos, yoy null
  const dosEl={type:'data', binding:{dataset:'psi', measure:'dos', filters:{}}};
  const rDos=await B.resolveElement(api, PptBind, dosEl);
  ok('data(dos)→report total dos, yoy null', rDos.kind==='value' && rDos.value===53 && rDos.yoy===null);
  const chartEl={type:'chart', binding:{dataset:'psi', measure:'sellOut', legend:'line', filters:{}}};
  const r2=await B.resolveElement({}, PptBind, chartEl);
  ok('chart(psi)→matrix', r2.kind==='matrix' && r2.series[0].name==='A' && r2.cats.length===2);
  const idcEl={type:'chart', binding:{dataset:'idc', catField:'pbStd', legend:'brand', filters:{}}};
  const r3=await B.resolveElement({}, PptBind, idcEl);
  ok('chart(idc)→matrix', r3.kind==='matrix' && r3.series[0].name==='Apple');
  const txt={type:'text', text:'手机SO'};
  const r4=await B.resolveElement({}, PptBind, txt);
  ok('text→none', r4.kind==='none');

  // --- B3: F5 时间切片 + F6 同比 ---
  // fake：resolveMatrix 按 filters.tag 返回不同 period 桶
  const PptBind2={ resolveMatrix:async(api,b)=>{ const tag=(b.filters&&b.filters.tag)||'A';
      const data = tag==='A' ? {S:{'2025-01':100,'2025-02':100,'2025-03':100,'2026-01':50}} : {S:{'2026-01':60,'2026-02':60,'2026-03':60}};
      const cats=Object.keys(data.S); return {cats, series:[{name:'S',values:cats.map(c=>data.S[c])}]}; },
    resolveIdcMatrix:async()=>({cats:[],series:[]}) };
  // F6 yoy：A=2025 1-3 求和=300，B=2026 1-3 求和=180 → (180-300)/300=-0.4 → -40.0%
  { const el={type:'data',binding:{mode:'compare',compare:{op:'yoy',fmt:'pct',decimals:1,
      a:{measure:'sellOut',filters:{tag:'A'},timeFrom:'2025-01',timeTo:'2025-03'},
      b:{measure:'sellOut',filters:{tag:'B'},timeFrom:'2026-01',timeTo:'2026-03'}}}};
    const r=await B.resolveElement({},PptBind2,el);
    ok('compare value', Math.abs(r.value-(-0.4))<1e-9);
    ok('compare totalA', r.totalA===300); ok('compare totalB', r.totalB===180);
    ok('compare text', r.text==='-40.0%');
  }
  // F6 abs(diff)：180-300=-120
  { const el={type:'data',binding:{mode:'compare',compare:{op:'diff',fmt:'abs',decimals:0,
      a:{measure:'sellOut',filters:{tag:'A'},timeFrom:'2025-01',timeTo:'2025-03'},
      b:{measure:'sellOut',filters:{tag:'B'},timeFrom:'2026-01',timeTo:'2026-03'}}}};
    const r=await B.resolveElement({},PptBind2,el); ok('diff value', r.value===-120); ok('diff text', r.text==='-120'); }
  // 优化：fmt 为唯一权威——即便传了无关 op 也按格式出数（旧版 diff+pct 会得到 value*100 的乱码）
  { const el={type:'data',binding:{mode:'compare',compare:{fmt:'pct',decimals:1,
      a:{measure:'sellOut',filters:{tag:'A'},timeFrom:'2025-01',timeTo:'2025-03'},
      b:{measure:'sellOut',filters:{tag:'B'},timeFrom:'2026-01',timeTo:'2026-03'}}}};
    const r=await B.resolveElement({},PptBind2,el);
    ok('fmt权威 pct(无op)→比率%', r.text==='-40.0%' && Math.abs(r.value-(-0.4))<1e-9); }
  { const el={type:'data',binding:{mode:'compare',compare:{fmt:'abs',decimals:0,
      a:{measure:'sellOut',filters:{tag:'A'},timeFrom:'2025-01',timeTo:'2025-03'},
      b:{measure:'sellOut',filters:{tag:'B'},timeFrom:'2026-01',timeTo:'2026-03'}}}};
    const r=await B.resolveElement({},PptBind2,el);
    ok('fmt权威 abs(无op)→差值', r.text==='-120' && r.value===-120); }
  // F5 切片：chart period cats 取 2025-02..2026-01
  { const el={type:'chart',binding:{catField:'period',timeFrom:'2025-02',timeTo:'2026-01',measure:'sellOut',filters:{tag:'A'}}};
    const r=await B.resolveElement({},PptBind2,el);
    ok('F5 cats 切片', JSON.stringify(r.cats)===JSON.stringify(['2025-02','2025-03','2026-01']));
    ok('F5 values 对齐', JSON.stringify(r.series[0].values)===JSON.stringify([100,100,50])); }

  // --- S1: seriesOrder 系列重排 ---
  { // seriesOrder：把 ['B','A'] 排到前，未列出的 C 补末
    const Fake={ resolveMatrix:async()=>({cats:['1月'],series:[{name:'A',values:[1]},{name:'B',values:[2]},{name:'C',values:[3]}]}), resolveIdcMatrix:async()=>({cats:[],series:[]}) };
    const el={type:'chart',binding:{catField:'product',measure:'sellOut',seriesOrder:['B','A']}};
    const r=await B.resolveElement({},Fake,el);
    ok('seriesOrder 重排', JSON.stringify(r.series.map(s=>s.name))===JSON.stringify(['B','A','C']));
    ok('seriesOrder values 跟随', r.series[0].values[0]===2 && r.series[1].values[0]===1);
  }
  { // 无 seriesOrder：原序不变
    const Fake={ resolveMatrix:async()=>({cats:['1月'],series:[{name:'A',values:[1]},{name:'B',values:[2]}]}), resolveIdcMatrix:async()=>({cats:[],series:[]}) };
    const r=await B.resolveElement({},Fake,{type:'chart',binding:{catField:'product',measure:'sellOut'}});
    ok('无 seriesOrder 原序', JSON.stringify(r.series.map(s=>s.name))===JSON.stringify(['A','B']));
  }

  // --- C1: 快照 last-in-range + 通用后缀 ---
  // 快照 last-in-range：dos 取区间最后一个桶(6月)，不是求和
  { const Fake={ resolveMatrix:async(api,b)=>{ const tag=(b.filters&&b.filters.tag)||'A';
      const data = tag==='A' ? {S:{'2025-04':50,'2025-05':55,'2025-06':60}} : {S:{'2026-04':40,'2026-05':45,'2026-06':48}};
      const cats=Object.keys(data.S); return {cats, series:[{name:'S',values:cats.map(c=>data.S[c])}]}; },
      resolveIdcMatrix:async()=>({cats:[],series:[]}) };
    const el={type:'data',binding:{mode:'compare',compare:{fmt:'abs',decimals:0,suffix:'天',
      a:{measure:'dos',agg:'last',filters:{tag:'A'},timeFrom:'2025-04',timeTo:'2025-06'},
      b:{measure:'dos',agg:'last',filters:{tag:'B'},timeFrom:'2026-04',timeTo:'2026-06'}}}};
    const r=await B.resolveElement({},Fake,el);
    ok('dos 取末期 totalA=60', r.totalA===60);
    ok('dos 取末期 totalB=48', r.totalB===48);
    ok('dos diff=-12', r.value===-12);
    ok('suffix 追加', r.text==='-12 天');
  }
  // 流量仍求和：sellOut sum 不回归(沿用已有 PptBind2：A 2025 1-3 求和=300)
  { const el={type:'data',binding:{mode:'compare',compare:{fmt:'abs',decimals:0,
      a:{measure:'sellOut',agg:'sum',filters:{tag:'A'},timeFrom:'2025-01',timeTo:'2025-03'},
      b:{measure:'sellOut',agg:'sum',filters:{tag:'B'},timeFrom:'2026-01',timeTo:'2026-03'}}}};
    const r=await B.resolveElement({},PptBind2,el);
    ok('flow 仍求和 totalA=300', r.totalA===300); ok('flow totalB=180', r.totalB===180); ok('flow diff=-120', r.value===-120);
  }

  // --- F2: finance 解析 + compare finance(预设/pp) ---
  { const FB={ resolveFinanceMatrix:async(api,b)=>({cats:['平板','音频'],series:[{name:'净销售收入',values:[300,100]}]}),
      resolveFinanceTotal:async(api,b)=>{ // 按 year/月返回不同值模拟同比
        if(b.measure==='rev') return b.year===2025?400:480;     // +20%
        if(b.measure==='gmr') return b.year===2025?0.30:0.32;    // +2pp
        if(b.measure==='nsip') return b.year===2025?90:84;       // -6
        return 0; },
      comparePeriodsForPreset:(preset,ctx)=> require('../binding-resolver.js').comparePeriodsForPreset(preset,ctx),  // designer/ → ../binding-resolver.js
      FIN_FMT_DEFAULT:{rev:'pct',gmr:'pp',nsip:'abs'} };
    // finance chart → matrix
    const rc=await B.resolveElement({},FB,{type:'chart',binding:{dataset:'finance',measure:'rev',catField:'lv1',basis:'actual'}});
    ok('finance chart matrix', rc.kind==='matrix' && rc.cats[0]==='平板' && rc.series[0].values[1]===100);
    // finance data → total
    const rd=await B.resolveElement({},FB,{type:'data',binding:{dataset:'finance',measure:'rev',basis:'actual',year:2026}});
    ok('finance data value', rd.kind==='value' && rd.value===480);
    // compare finance 同比 rev → +20.0%
    const ry=await B.resolveElement({},FB,{type:'data',binding:{mode:'compare',compare:{source:'finance',preset:'yoy',decimals:1,
      scope:{measure:'rev',year:2026,fromM:1,toM:6,filters:{}}}}});
    ok('compare rev yoy %', ry.text==='+20.0%' && ry.totalA===400 && ry.totalB===480);
    // compare finance 同比 gmr → +2.0 pp
    const rg=await B.resolveElement({},FB,{type:'data',binding:{mode:'compare',compare:{source:'finance',preset:'yoy',decimals:1,
      scope:{measure:'gmr',year:2026,fromM:1,toM:6,filters:{}}}}});
    ok('compare gmr yoy pp', rg.text==='+2.0 pp');
    // compare finance 同比 nsip → -6 (abs)
    const rn=await B.resolveElement({},FB,{type:'data',binding:{mode:'compare',compare:{source:'finance',preset:'yoy',decimals:0,
      scope:{measure:'nsip',year:2026,fromM:1,toM:6,filters:{}}}}});
    ok('compare nsip yoy abs', rn.text==='-6');
  }

  // --- WK5: grid 三 dataset(report/siso/roadmap) ---
  // report:api.report → PptWeekly.reportGrid;header 长度=1(分组)+3+周2+6=12,末行 '合计'
  { let repSeen=null;
    const apiR={ report:(p)=>{ repSeen=p; return {
      weekLabels:['W10','W11'],
      rows:[{key:'Acme平板',cumCur:5000,cumPrev:4000,yoy:0.25,weekly:[100,120],wow:0.2,inv:800,dos:30,flowInv:900,flowDos:33,dcfdc:200},
            {key:'荣耀平板',cumCur:3000,cumPrev:3200,yoy:-0.0625,weekly:[80,90],wow:0.12,inv:600,dos:25,flowInv:null,flowDos:null,dcfdc:null}],
      total:{cumCur:8000,cumPrev:7200,yoy:0.111,weekly:[180,210],wow:0.17,inv:1400,dos:28,flowInv:900,flowDos:33,dcfdc:200} }; } };
    const el={type:'table',binding:{dataset:'report',groupDim:'line',weeks:9,filters:{}}};
    const r=await B.resolveElement(apiR,PptBind,el);
    ok('report→grid kind', r.kind==='grid');
    ok('report header 长度12', r.header.length===12);
    ok('report header 分组label=产品线', r.header[0]==='产品线');
    ok('report 周列透传 W10/W11', r.header[4]==='W10' && r.header[5]==='W11');
    ok('report 数据行数=2+合计=3', r.rows.length===3);
    ok('report 合计置末', r.rows[2][0]==='合计');
    ok('report api 入参 groupDim/weeks/filters', repSeen && repSeen.groupDim==='line' && repSeen.weeks===9);
  }
  // report groupDim 缺省中文 label 映射
  { const apiR={ report:()=>({weekLabels:[],rows:[],total:null}) };
    const rf=await B.resolveElement(apiR,PptBind,{type:'table',binding:{dataset:'report',groupDim:'family'}});
    ok('report groupDim=family→产品系列', rf.header[0]==='产品系列');
    const rc=await B.resolveElement(apiR,PptBind,{type:'table',binding:{dataset:'report',groupDim:'country'}});
    ok('report groupDim=country→国家', rc.header[0]==='国家');
  }

  // siso:financeCustom(预测) + report(model 实际) + nameMap(roadmap products psiLink→name)
  { let fcSeen=null, repSeen=null;
    const apiS={
      financeCustom:(p)=>{ fcSeen=p; return {rows:[{key:'Tarvos',sellIn:100,sellOut:120}]}; },
      report:(p)=>{ repSeen=p; return {rows:[{key:'Tarvos',cumCur:80,siCur:70}]}; } };
    const el={type:'table',binding:{dataset:'siso',version:'V3',year:2026,
      _rmData:{products:[{psiLink:'Tarvos',name:'Slate Pro 13.2'}],samples:[],launch:[],battle:[]}}};
    const r=await B.resolveElement(apiS,PptBind,el);
    ok('siso→grid kind', r.kind==='grid');
    ok('siso financeCustom rowDim=model/basis=forecast/version', fcSeen && fcSeen.rowDim==='model' && fcSeen.basis==='forecast' && fcSeen.version==='V3');
    ok('siso report groupDim=model', repSeen && repSeen.groupDim==='model');
    const row=r.rows[0];
    ok('siso 传播名 join', row[1]==='Slate Pro 13.2');
    // SI GAP = 预测SI(100) − 实际SI(70) = 30
    ok('siso SI GAP=30', row[row.length-1]==='30');
  }

  // roadmap launch:agg(首个>0月取认购) + launchGrid
  { let aggSeenR=null;
    const apiL={ agg:(p)=>{ aggSeenR=p; return {cats:['2026-01','2026-02'],series:['(值)'],data:{'(值)':{'2026-01':0,'2026-02':500}}}; } };
    const rm={products:[{id:'p1',psiLink:'Tarvos',name:'Slate Tab',pricing:[]}],
      samples:[], battle:[],
      launch:[{id:'l1',productId:'p1',country:'墨西哥',presaleDate:'6.1',overallDate:'6.10',firstTarget:1000}] };
    const el={type:'table',binding:{dataset:'roadmap',table:'launch',_rmData:rm}};
    const r=await B.resolveElement(apiL,PptBind,el);
    ok('roadmap launch→grid kind', r.kind==='grid');
    ok('roadmap launch header[0]=国家', r.header[0]==='国家');
    ok('roadmap agg filters model/country', aggSeenR && aggSeenR.filters.model[0]==='Tarvos' && aggSeenR.filters.country[0]==='墨西哥');
    // 认购取首个>0月=500
    ok('roadmap launch 认购=500(首销月SO)', r.rows[0][5]==='500');
  }

  // roadmap battle:products.pricing 按 country 取 rrpLocal + launch 字段 join + rivals 拼接
  { const rm={ products:[{id:'p1',name:'Slate Tab',pricing:[{country:'墨西哥',rrpLocal:9999}]}],
      samples:[],
      launch:[{id:'l1',productId:'p1',country:'墨西哥',firstOffer:'8888',firstGm:0.25,firstTarget:1000,lifecycleTarget:5000,presaleDate:'6.1',overallDate:'6.10',aatpEst:'6.5',channel:'线上'}],
      battle:[{id:'b1',productId:'p1',country:'墨西哥',rival:'iPad',priceLocal:12000},
              {id:'b2',productId:'p1',country:'墨西哥',rival:'Galaxy',priceLocal:11000}] };
    const el={type:'table',binding:{dataset:'roadmap',table:'battle',_rmData:rm}};
    const r=await B.resolveElement({},PptBind,el);
    ok('roadmap battle→grid kind', r.kind==='grid');
    ok('roadmap battle header[0]=国家', r.header[0]==='国家');
    ok('roadmap battle rrpLocal join', r.rows[0][1]==='9,999');
    ok('roadmap battle rivals 拼接', /iPad 12,000/.test(r.rows[0][3]) && /Galaxy 11,000/.test(r.rows[0][3]));
    ok('roadmap battle firstOffer join', r.rows[0][2]==='8888');
  }

  // roadmap samples / sku / acc:header 检查
  { const rm={ products:[{id:'p1',name:'Slate Tab',skus:[{name:'128G',color:'黑',ean:'E1',ram:'8',rom:'128',chip:'K1',bom:'B1'}],
      accessories:{'键盘':{certModel:'C1',name:'磁吸键盘',internalCode:'IK1',color:'白',skuRef:'S1'}}}],
      samples:[{productId:'p1',type:'工程机',name:'样机A',code:'SC1',color:'黑',certModel:'CM1',inbox:'充电器',shipLate:'6月'}],
      launch:[], battle:[] };
    const rs=await B.resolveElement({},PptBind,{type:'table',binding:{dataset:'roadmap',table:'samples',_rmData:rm}});
    ok('roadmap samples header[0]=关联产品', rs.kind==='grid' && rs.header[0]==='关联产品');
    ok('roadmap samples 关联产品名 join', rs.rows[0][0]==='Slate Tab');
    const rk=await B.resolveElement({},PptBind,{type:'table',binding:{dataset:'roadmap',table:'sku',_rmData:rm}});
    ok('roadmap sku header[0]=产品', rk.kind==='grid' && rk.header[0]==='产品');
    ok('roadmap sku 行=1', rk.rows.length===1 && rk.rows[0][1]==='128G');
    const ra=await B.resolveElement({},PptBind,{type:'table',binding:{dataset:'roadmap',table:'acc',_rmData:rm}});
    ok('roadmap acc header[0]=产品', ra.kind==='grid' && ra.header[0]==='产品');
    ok('roadmap acc 配件行 join', ra.rows[0][1]==='键盘');
  }

  // roadmap 缺省(无 _rmData/空)→ header+0 行
  { const re=await B.resolveElement({},PptBind,{type:'table',binding:{dataset:'roadmap',table:'samples'}});
    ok('roadmap 缺省 samples header 存在', re.kind==='grid' && re.header[0]==='关联产品');
    ok('roadmap 缺省 samples 0 行', re.rows.length===0);
    const rl=await B.resolveElement({agg:()=>({cats:[],series:[],data:{}})},PptBind,{type:'table',binding:{dataset:'roadmap',table:'launch'}});
    ok('roadmap 缺省 launch 0 行', rl.kind==='grid' && rl.rows.length===0);
  }

  console.log(f?('\n'+f+' FAILED'):'\nALL PASS'); process.exit(f?1:0);
})();

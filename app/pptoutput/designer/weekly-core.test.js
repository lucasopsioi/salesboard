const W=require('./weekly-core.js');
let f=0; const ok=(n,c)=>{console.log((c?'PASS ':'FAIL ')+n); if(!c)f++;};
const eq=(a,b)=>JSON.stringify(a)===JSON.stringify(b);

// ---- fmtInt ----
ok('fmtInt 千分位', W.fmtInt(1234)==='1,234');
ok('fmtInt 负', W.fmtInt(-12345)==='-12,345');
ok('fmtInt null→—', W.fmtInt(null)==='—');
ok('fmtInt NaN→—', W.fmtInt(NaN)==='—');
ok('fmtInt 0', W.fmtInt(0)==='0');
ok('fmtInt 四舍五入', W.fmtInt(1234.6)==='1,235');

// ---- fmtPct ----
ok('fmtPct +12%', W.fmtPct(0.12)==='+12%');
ok('fmtPct -5.5% d1', W.fmtPct(-0.055,1)==='-5.5%');
ok('fmtPct 0→+0%', W.fmtPct(0)==='+0%');
ok('fmtPct null→—', W.fmtPct(null)==='—');
ok('fmtPct undefined→—', W.fmtPct(undefined)==='—');

// ---- launchMonthSO ----
ok('launchMonthSO 首个>0', eq(W.launchMonthSO(['2026-01','2026-02','2026-03'],[0,50,80]),{month:'2026-02',so:50}));
ok('launchMonthSO 全0→null', W.launchMonthSO(['2026-01','2026-02'],[0,0])===null);
ok('launchMonthSO 第一个即>0', eq(W.launchMonthSO(['2026-01','2026-02'],[10,50]),{month:'2026-01',so:10}));
ok('launchMonthSO 空→null', W.launchMonthSO([],[])===null);

// ---- reportGrid ----
const rep={
  weekLabels:['W22','W23'],
  rows:[
    {key:'Nimbus',cumCur:12345,cumPrev:10000,yoy:0.2345,weekly:[100,200],wow:0.5,inv:3000,dos:45,flowInv:3500,flowDos:52,dcfdc:500},
    {key:'Vega',cumCur:5000,cumPrev:0,yoy:null,weekly:[10,20],wow:null,inv:1000,dos:30}
  ],
  total:{cumCur:17345,cumPrev:10000,yoy:0.7345,weekly:[110,220],wow:0.1,inv:4000,dos:40,flowInv:4500,flowDos:48,dcfdc:500}
};
const rg=W.reportGrid(rep,'产品线');
ok('reportGrid header', eq(rg.header,['产品线','26年累计SO','25年同期SO','累计同比','W22','W23','WoW%','库存(pcs)','DOS','全流程库存','全流程DOS','国家仓+FDC']));
ok('reportGrid row0 数值', eq(rg.rows[0],['Nimbus','12,345','10,000','+23%','100','200','+50%','3,000','45','3,500','52','500']));
ok('reportGrid row1 缺流程→—', eq(rg.rows[1],['Vega','5,000','0','—','10','20','—','1,000','30','—','—','—']));
ok('reportGrid total 置末且key合计', rg.rows[rg.rows.length-1][0]==='合计');
ok('reportGrid total 值', rg.rows[2][1]==='17,345');

// ---- sisoGrid ----
const siso=W.sisoGrid({
  version:'6月',
  nameMap:{P50:'P50 传播', X6:'X6 传播'},
  fcRows:[{key:'P50',sellIn:1000,sellOut:900},{key:'X6',sellIn:500,sellOut:400}],
  actRows:[{key:'P50',cumCur:450,siCur:600},{key:'Y9',cumCur:200,siCur:250}]
});
ok('sisoGrid header', eq(siso.header,['产品型号','传播名','6月SI(台)','6月SO(台)','SI进展','SO进展','SI达成%','SO达成%','SI GAP']));
// P50: fc si1000 so900; act si600 so450; 达成 SI=600/1000=+60%; SO=450/900=+50%; GAP=1000-600=400
ok('sisoGrid P50 行', eq(siso.rows[0],['P50','P50 传播','1,000','900','600','450','60%','50%','400']));
// X6: fc si500 so400; act 缺→进展—达成—GAP—
ok('sisoGrid X6 无实际', eq(siso.rows[1],['X6','X6 传播','500','400','—','—','—','—','—']));
// Y9: 仅实际(无预测)→ fc列/达成/GAP '—'; 排序在有预测之后
const y9=siso.rows.find(r=>r[0]==='Y9');
ok('sisoGrid Y9 无预测名缺', eq(y9,['Y9','—','—','—','250','200','—','—','—']));
ok('sisoGrid 排序 P50在X6前', siso.rows[0][0]==='P50' && siso.rows[1][0]==='X6');

// ---- launchGrid ----
const launchRows=[
  {productId:'p1',country:'墨西哥',presaleDate:'2026-06-01',onlineDate:'2026-06-10',offlineDate:'2026-06-12',overallDate:'2026-06-10',firstTarget:1000},
  {productId:'p1',country:'哥伦比亚',presaleDate:'',onlineDate:'2026-06-15',offlineDate:'',overallDate:'2026-06-15',firstTarget:0}
];
const soLookup={'p1|墨西哥':{month:'2026-06',so:850},'p1|哥伦比亚':null};
const pById={p1:{name:'Nimbus P1'}};
const lg=W.launchGrid(launchRows,soLookup,pById);
ok('launchGrid header', eq(lg.header,['国家','预售时间','线上首销','线下首销','整体首销','实际认购(首销月SO)','首销名义台数','达成率']));
// 同产品下按国家排序:哥伦比亚 < 墨西哥
const rMx=lg.rows.find(r=>r[0]==='墨西哥');
const rCo=lg.rows.find(r=>r[0]==='哥伦比亚');
ok('launchGrid 墨西哥行', eq(rMx,['墨西哥','2026-06-01','2026-06-10','2026-06-12','2026-06-10','850','1,000','85%']));
ok('launchGrid 哥伦比亚 缺SO/target→—', eq(rCo,['哥伦比亚','','2026-06-15','','2026-06-15','—','—','—']));
// 单产品→国家不带产品名前缀
ok('launchGrid 单产品不带前缀', lg.rows.every(r=>r[0].indexOf('·')<0));
// 多产品→国家带 产品名·国家
const lg2=W.launchGrid(
  [{productId:'p1',country:'墨西哥',firstTarget:1000},{productId:'p2',country:'秘鲁',firstTarget:500}],
  {'p1|墨西哥':{month:'2026-06',so:850},'p2|秘鲁':{month:'2026-06',so:400}},
  {p1:{name:'Nimbus'},p2:{name:'Vega'}}
);
ok('launchGrid 多产品带前缀', lg2.rows.some(r=>r[0]==='Nimbus·墨西哥') && lg2.rows.some(r=>r[0]==='Vega·秘鲁'));

// ---- battleGrid ----
const bg=W.battleGrid([{
  country:'墨西哥',rrpLocal:9999,firstOffer:'8999',
  rivals:[{rival:'iPhone',priceLocal:12000},{rival:'Galaxy',priceLocal:11000}],
  firstGm:0.35,firstTarget:1000,lifecycleTarget:5000,
  presaleDate:'2026-06-01',overallDate:'2026-06-10',aatpEst:'320USD',channel:'运营商'
}]);
ok('battleGrid header', eq(bg.header,['国家','RRP(本币)','首销Offer','竞品对标','首销毛利率','首销名义(台)','生命周期目标(台)','预售&首销','AATP预计','主力渠道']));
ok('battleGrid 竞品拼接', bg.rows[0][3]==='iPhone 12,000 / Galaxy 11,000');
ok('battleGrid 毛利率 0.35→35%', bg.rows[0][4]==='35%');
ok('battleGrid 预售&首销', bg.rows[0][7]==='2026-06-01→2026-06-10');
ok('battleGrid RRP 千分位', bg.rows[0][1]==='9,999');
// 毛利率 已是百分数(>1) 原样带%
const bg2=W.battleGrid([{country:'X',rrpLocal:null,firstOffer:'',rivals:[],firstGm:38,firstTarget:0,lifecycleTarget:0,presaleDate:'',overallDate:'',aatpEst:'',channel:''}]);
ok('battleGrid 毛利率 38→38%', bg2.rows[0][4]==='38%');
ok('battleGrid 预售首销 全空→—', bg2.rows[0][7]==='—');
ok('battleGrid 空rivals→—', bg2.rows[0][3]==='—');

// ---- samplesGrid ----
const smp=W.samplesGrid([{productId:'p1',type:'展机',name:'样机A',code:'SM001',color:'黑',certModel:'CM1',inbox:'手机+线',shipLate:'2026-06-01'}],{p1:{name:'Nimbus'}});
ok('samplesGrid header', eq(smp.header,['关联产品','类型','传播名','样机编码','颜色','认证型号','inbox内容','可用时间']));
ok('samplesGrid row', eq(smp.rows[0],['Nimbus','展机','样机A','SM001','黑','CM1','手机+线','2026-06-01']));
ok('samplesGrid 空→0行', W.samplesGrid([],{}).rows.length===0);
ok('samplesGrid 缺产品名→—', W.samplesGrid([{productId:'zz',type:'a'}],{}).rows[0][0]==='—');

// ---- skuGrid ----
const products=[{name:'Nimbus',skus:[{name:'8+256',color:'黑',ean:'E1',ram:'8',rom:'256',chip:'C1',bom:'B1'}]}];
const sku=W.skuGrid(products);
ok('skuGrid header', eq(sku.header,['产品','SKU名','颜色','EAN','RAM','ROM','芯片','BOM编码']));
ok('skuGrid row', eq(sku.rows[0],['Nimbus','8+256','黑','E1','8','256','C1','B1']));
ok('skuGrid 空→0行', W.skuGrid([]).rows.length===0);

// ---- accGrid ----
const accP=[{name:'Nimbus',accessories:{'保护壳':{certModel:'CM2',name:'壳A',internalCode:'IC1',color:'透明',skuRef:'SR1'}}}];
const acc=W.accGrid(accP);
ok('accGrid header', eq(acc.header,['产品','配件类型','认证型号','传播名','内部代号','颜色','关联SKU']));
ok('accGrid row', eq(acc.rows[0],['Nimbus','保护壳','CM2','壳A','IC1','透明','SR1']));
ok('accGrid 空→0行', W.accGrid([]).rows.length===0);
// 多选 skuRefs:关联SKU 列「、」连接;旧单值 skuRef 仍兼容(上面 accGrid row 用例即旧格式)
const accM=[{name:'Nimbus',accessories:{'键盘':{certModel:'K1',name:'键A',internalCode:'IC2',color:'黑',skuRefs:['黑','白','粉']}}}];
ok('accGrid 多选skuRefs连接', eq(W.accGrid(accM).rows[0][6],'黑、白、粉'));

console.log(f?('\n'+f+' FAILED'):'\nALL PASS'); process.exit(f?1:0);

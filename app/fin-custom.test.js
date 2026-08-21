// app/fin-custom.test.js
// TDD for engine financeCustom: 自定义看板透视 (行维度 × 多指标 × 口径).
// financeCustom(p) -> { rows:[{key,<metricKey>:value,...}], total:{...}, metrics:[...selected], dim:rowDim }
//   p={year,fromM,toM,version,rowDim('rep'|'lv1'..'lv4'), metrics:[...], basis('actual'|'forecast'|'bp'), reps, lv1..lv4, finUnits}
//   metrics ⊆ ['rev','gm','gmr','sellIn','sellOut','nsip','bpAttain','fcAttain']
const os=require('os'),fs=require('fs'),path=require('path');
const {Engine}=require('../engine-core'); require('../engine-finance');
let f=0; const ok=(n,c,d)=>{console.log((c?'PASS':'FAIL')+' '+n+(c?'':' :: '+JSON.stringify(d))); if(!c)f++;};
const near=(a,b,e=1e-4)=>a!=null&&b!=null&&Math.abs(a-b)<=Math.max(e,Math.abs(b)*1e-4);
const e=new Engine(fs.mkdtempSync(path.join(os.tmpdir(),'custom-')));
e.loadSample();
const UNITS={actual:'USD',forecast:'MUSD',bp:'MUSD'};
const FILT={year:2026,fromM:1,toM:3,finUnits:UNITS};

// === sanity: method exists & shape ===
ok('financeCustom is a function', typeof e.financeCustom==='function');

// === selected metrics appear as keys; unselected absent ===
(function(){
  const r=e.financeCustom(Object.assign({rowDim:'rep',basis:'actual',metrics:['rev','gm']},FILT));
  ok('dim echoed', r&&r.dim==='rep', r&&r.dim);
  ok('metrics echoed = selected', r&&Array.isArray(r.metrics)&&r.metrics.join(',')==='rev,gm', r&&r.metrics);
  ok('rows non-empty', r&&r.rows&&r.rows.length>0, r&&r.rows&&r.rows.length);
  const row0=r.rows[0];
  ok('selected key rev present on row', 'rev' in row0, Object.keys(row0));
  ok('selected key gm present on row', 'gm' in row0, Object.keys(row0));
  ok('unselected key gmr absent on row', !('gmr' in row0), Object.keys(row0));
  ok('unselected key sellIn absent on row', !('sellIn' in row0), Object.keys(row0));
  ok('row has key', typeof row0.key==='string', row0);
  ok('total has rev', r.total&&'rev' in r.total, r.total);
  ok('total has gm', r.total&&'gm' in r.total, r.total);
  ok('total has no gmr', r.total&&!('gmr' in r.total), r.total);
})();

// === rowDim:rep, basis:actual, metrics:['rev'] : Σrows.rev = total.rev ≈ financeOverview.rev.actual ===
(function(){
  const r=e.financeCustom(Object.assign({rowDim:'rep',basis:'actual',metrics:['rev']},FILT));
  const sum=r.rows.reduce((s,x)=>s+(x.rev||0),0);
  ok('Σrows.rev = total.rev', near(sum,r.total.rev), {sum,tot:r.total.rev});
  const ov=e.financeOverview(FILT);
  ok('total.rev ≈ financeOverview.rev.actual', near(r.total.rev,ov.metrics.rev.actual), {custom:r.total.rev,ov:ov.metrics.rev.actual});
})();

// === rowDim:lv1, basis:actual, metrics:rev/gm/gmr/nsip : rows include 平板; gmr=gm/rev; total.rev ≈ productBoard.line.total.rev26 ===
(function(){
  const r=e.financeCustom(Object.assign({rowDim:'lv1',basis:'actual',metrics:['rev','gm','gmr','nsip']},FILT));
  ok('lv1 dim echoed', r.dim==='lv1', r.dim);
  const tablet=r.rows.find(x=>x.key==='平板');
  ok('rows include 平板', !!tablet, r.rows.map(x=>x.key));
  ok('平板 gmr ≈ gm/rev', tablet&&near(tablet.gmr,tablet.gm/tablet.rev), tablet&&{gmr:tablet.gmr,exp:tablet.gm/tablet.rev});
  ok('total.gmr ≈ total.gm/total.rev', near(r.total.gmr,r.total.gm/r.total.rev), {gmr:r.total.gmr,exp:r.total.gm/r.total.rev});
  const pb=e.financeProductBoard(FILT);
  ok('total.rev ≈ productBoard.line.total.rev26', near(r.total.rev,pb.line.total.rev26), {custom:r.total.rev,pb:pb.line.total.rev26});
  // nsip = rev / Sell-in量 (财经实际表). 平板 nsip 应 > 0
  ok('平板 nsip > 0', tablet&&tablet.nsip>0, tablet&&tablet.nsip);
})();

// === basis:bp rev total ≈ productBoard.line.total.bp (全年BP) ===
(function(){
  const r=e.financeCustom(Object.assign({rowDim:'lv1',basis:'bp',metrics:['rev']},FILT));
  const pb=e.financeProductBoard(FILT);
  ok('basis:bp total.rev ≈ productBoard.line.total.bp', near(r.total.rev,pb.line.total.bp), {custom:r.total.rev,pb:pb.line.total.bp});
})();

// === metrics:['sellIn'] actual, rowDim:rep : total.sellIn ≈ _psiActual({same filter}).si26 ===
(function(){
  const r=e.financeCustom(Object.assign({rowDim:'rep',basis:'actual',metrics:['sellIn','sellOut']},FILT));
  const psi=e._psiActual({year:2026,fromM:1,toM:3});
  ok('total.sellIn ≈ PSI si26', near(r.total.sellIn,psi.si26), {custom:r.total.sellIn,psi:psi.si26});
  ok('total.sellOut ≈ PSI so26', near(r.total.sellOut,psi.so26), {custom:r.total.sellOut,psi:psi.so26});
  // forecast/bp basis sell-in/out come from finance Sell in量/Sell out量 target (全年)
  const rf=e.financeCustom(Object.assign({rowDim:'rep',basis:'forecast',metrics:['sellIn','sellOut']},FILT));
  ok('forecast sellIn total > 0 (财经目标)', rf.total.sellIn>0, rf.total.sellIn);
})();

// === bpAttain ≈ rev(actual)/rev(bp); fcAttain ≈ rev(actual)/rev(fc) — computed regardless of basis ===
(function(){
  const r=e.financeCustom(Object.assign({rowDim:'lv1',basis:'forecast',metrics:['rev','bpAttain','fcAttain']},FILT));
  const actRev=e.financeCustom(Object.assign({rowDim:'lv1',basis:'actual',metrics:['rev']},FILT));
  const bpRev =e.financeCustom(Object.assign({rowDim:'lv1',basis:'bp',metrics:['rev']},FILT));
  const fcRev =e.financeCustom(Object.assign({rowDim:'lv1',basis:'forecast',metrics:['rev']},FILT));
  const a=Object.fromEntries(actRev.rows.map(x=>[x.key,x.rev]));
  const bp=Object.fromEntries(bpRev.rows.map(x=>[x.key,x.rev]));
  const fc=Object.fromEntries(fcRev.rows.map(x=>[x.key,x.rev]));
  const tablet=r.rows.find(x=>x.key==='平板');
  ok('平板 bpAttain ≈ actRev/bpRev', tablet&&near(tablet.bpAttain,a['平板']/bp['平板']), tablet&&{got:tablet.bpAttain,exp:a['平板']/bp['平板']});
  ok('平板 fcAttain ≈ actRev/fcRev', tablet&&near(tablet.fcAttain,a['平板']/fc['平板']), tablet&&{got:tablet.fcAttain,exp:a['平板']/fc['平板']});
  ok('total bpAttain ≈ Σact/Σbp', near(r.total.bpAttain,actRev.total.rev/bpRev.total.rev), {got:r.total.bpAttain,exp:actRev.total.rev/bpRev.total.rev});
})();

// === divide-by-zero → null (nsip with no sell-in量 in a non-existent filter) ===
(function(){
  const r=e.financeCustom(Object.assign({rowDim:'rep',basis:'actual',metrics:['gmr','nsip'],reps:['__nonexistent__']},FILT));
  ok('empty filter -> total.gmr null', r.total.gmr===null, r.total.gmr);
  ok('empty filter -> total.nsip null', r.total.nsip===null, r.total.nsip);
})();

// === cp 贡献利润 (金额, loadSample 含 qty:false) ===
(function(){
  const r=e.financeCustom(Object.assign({rowDim:'lv1',basis:'actual',metrics:['cp','rev']},FILT));
  ok('cp 选中出现在行/合计', r.rows[0] && ('cp' in r.rows[0]) && ('cp' in r.total), r.rows[0]&&Object.keys(r.rows[0]));
  const sum=r.rows.reduce((s,x)=>s+(x.cp||0),0);
  ok('Σrows.cp = total.cp', near(sum,r.total.cp), {sum,tot:r.total.cp});
  ok('total.cp > 0 (loadSample 有贡献利润)', r.total.cp>0, r.total.cp);
  // cp ≈ financeKpi 贡献利润.actual(同口径求和)
  const kpi=e.financeKpi(FILT);
  ok('total.cp ≈ financeKpi.贡献利润.actual', near(r.total.cp, kpi['贡献利润']&&kpi['贡献利润'].actual), {cp:r.total.cp, kpi:kpi['贡献利润']&&kpi['贡献利润'].actual});
  // 金额型:cp 与 rev 同量级(非按数量缩放)——cp 通常小于 rev 且 >0
  ok('cp < rev (贡献利润<净收入)', r.total.cp < r.total.rev, {cp:r.total.cp,rev:r.total.rev});
})();
// forecast / bp 口径 cp 也出数
(function(){
  const rf=e.financeCustom(Object.assign({rowDim:'lv1',basis:'forecast',metrics:['cp']},FILT));
  ok('forecast cp 出数', rf.total && ('cp' in rf.total), rf.total);
  const rb=e.financeCustom(Object.assign({rowDim:'lv1',basis:'bp',metrics:['cp']},FILT));
  ok('bp cp 出数', rb.total && ('cp' in rb.total), rb.total);
})();
// 回归:未选 cp 时不应出现
(function(){
  const r=e.financeCustom(Object.assign({rowDim:'rep',basis:'actual',metrics:['rev']},FILT));
  ok('未选 cp → 行/合计无 cp', !('cp' in r.rows[0]) && !('cp' in r.total), r.rows[0]&&Object.keys(r.rows[0]));
})();

// === WK1: fin 行携产品型号维(index14) + financeCustom rowDim:'model'(SISO 预测按型号) ===
// loadSample 的预测表 model 列为空 → 直接喂 _buildFin 15列行(含 model)断言 dim 建立/分组;
// 并覆盖"实际/BP 行 model 空('')不炸"。行结构:
//   实际 [A,brand,region,rep,country,lv1,lv2,lv3,lv4,metric,order,ym,val,'','']       (13→+版本占位''+model'')
//   预测 [F,brand,region,rep,'',lv1,lv2,lv3,lv4,metric,order,ym,val,version,model]     (14→+model)
//   BP   [B,'',region,rep,'',lv1,lv2,lv3,lv4,metric,order,ym,val,version,model]        (14→+model)
(function(){
  const e2=new Engine(fs.mkdtempSync(path.join(os.tmpdir(),'custom-model-')));
  const R=[];
  // 实际行(model 空):净销售收入 + 收入量_终端(NSIP分母),2026年1月
  R.push(['A','ACME','拉美大区','巴西国家办','巴西','平板','平板','Slate Pro','Tarvos','净销售收入',1110,202601,1000000,'','']);
  R.push(['A','ACME','拉美大区','巴西国家办','巴西','平板','平板','Slate Pro','Tarvos','收入量_终端',50,202601,100,'','']);
  // BP 行(model 空):不应炸
  R.push(['B','','拉美大区','巴西国家办','','平板','平板','Slate Pro','Tarvos','净销售收入',1110,202601,2.0,'国家办工作底稿','']);
  // 预测行(带 model):两个型号,Sell in量 / Sell out量,版本"4月预测",2026 全年抽样几个月
  const models=['Tarvos-W09DK','Vantor6-W09B'];
  models.forEach((mdl,mi)=>{
    for(let m=1;m<=3;m++){
      R.push(['F','ACME','拉美大区','巴西国家办','','平板','平板','Slate Pro','Tarvos','Sell in量',55,2026*100+m,100+mi*10+m,'4月预测',mdl]);
      R.push(['F','ACME','拉美大区','巴西国家办','','平板','平板','Slate Pro','Tarvos','Sell out量',60,2026*100+m,90+mi*10+m,'4月预测',mdl]);
    }
  });
  // model 空的预测行(应在 rowDim:'model' 时被跳过)
  R.push(['F','ACME','拉美大区','巴西国家办','','平板','平板','Slate Pro','Tarvos','Sell in量',55,202601,7,'4月预测','']);
  e2._buildFin(R);
  ok('_buildFin 不炸(实际/BP model 空)', e2.hasFin===true);
  // dim: model 维建立 + finMeta.dims 含 model
  const F2=e2.fin;
  ok('fin.dimCode.model 存在', F2 && F2.dimCode && F2.dimCode.model && F2.dimCode.model.length===R.length, F2&&F2.dimCode&&F2.dimCode.model&&F2.dimCode.model.length);
  ok('fin.dimDict.model 含型号', F2 && F2.dimDict.model.includes('Tarvos-W09DK') && F2.dimDict.model.includes('Vantor6-W09B'), F2&&F2.dimDict&&F2.dimDict.model);
  ok('fin.dimIndex.model 可查', F2 && F2.dimIndex.model.get('Tarvos-W09DK')!==undefined, F2&&F2.dimIndex&&[...F2.dimIndex.model.keys()]);
  ok('finMeta.dims 含 model(有非空值)', e2.finMeta.dims.includes('model'), e2.finMeta.dims);
  // financeCustom rowDim:'model' 预测 SISO
  const UNITS2={actual:'USD',forecast:'台',bp:'台'};
  const rm=e2.financeCustom({rowDim:'model',metrics:['sellIn','sellOut'],basis:'forecast',version:'4月预测',year:2026,fromM:1,toM:12,finUnits:UNITS2});
  ok('rowDim:model dim 回显', rm.dim==='model', rm.dim);
  const keys=rm.rows.map(x=>x.key);
  ok('rows key = 型号(非空)', keys.length===2 && keys.includes('Tarvos-W09DK') && keys.includes('Vantor6-W09B'), keys);
  ok('空 model 行被跳过(无 "" key)', !keys.includes(''), keys);
  const w=rm.rows.find(x=>x.key==='Tarvos-W09DK');
  ok('Tarvos sellIn>0', w && w.sellIn>0, w&&w.sellIn);
  ok('Tarvos sellOut>0', w && w.sellOut>0, w&&w.sellOut);
  // total = Σ 各型号
  const siSum=rm.rows.reduce((s,x)=>s+(x.sellIn||0),0);
  ok('Σrows.sellIn = total.sellIn', near(siSum,rm.total.sellIn), {siSum,tot:rm.total.sellIn});
})();

// 零回归:既有 rowDim(rep) 在含 model 列的行上仍正常
(function(){
  const r=e.financeCustom(Object.assign({rowDim:'rep',basis:'actual',metrics:['rev']},FILT));
  ok('回归 rowDim:rep 仍出行', r.rows.length>0, r.rows.length);
})();

console.log(f?('\n'+f+' FAILED'):'\nALL PASS'); process.exit(f?1:0);

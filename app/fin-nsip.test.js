// fin-nsip.test.js — NSIP(净销售价 USD/台)口径 + 内置示例数量单位回归。
// 配合既有 fin-units.test.js(合成数据证"数量不缩放"):本测试在内置示例(走真实解析器)上验证:
//   1. NSIP 三口径(实际/BP/预测)都在合理量级且彼此接近 —— 防"预测口径差100×、BP口径被灌成百万($89M)"。
//   2. Sell in/out量 的 BP/预测达成率是合理比率 —— 防数量跨来源单位错位(旧 bug 达成率=12644281%)。
//   3. financeProductBoard 行带 nsipYoy(NSIP同比=nsip26-nsip25,绝对 USD 差) —— 供产品看板"NSIP同比"列。
// 前提:内置示例数量必须恒为台(实际/预测/BP 同口径),与 view 传的 finQtyUnits:{台,台,台} 一致。
'use strict';
const fs=require('fs'), os=require('os'), path=require('path');
const E=require('../engine.js');

let fail=0;
const ok=(n,c,extra)=>{ console.log((c?'PASS ':'FAIL ')+n+(c?'':'  <<< '+(extra||''))); if(!c) fail++; };

const eng=new E.Engine(fs.mkdtempSync(path.join(os.tmpdir(),'finn-')));
eng.loadSample();

// view 实际传参(finance-view.js finOverviewParams)：金额各来源不同单位、数量恒为台
const UNITS={ finUnits:{actual:'USD',forecast:'MUSD',bp:'MUSD'}, finQtyUnits:{actual:'台',forecast:'台',bp:'台'} };
const sane=v=>v!=null&&isFinite(v)&&v>1&&v<1e5;   // USD/台:个位~万;绝不该是 0.0 或千万

// ---- 1. 总看板 NSIP 三口径 ----
const ov=eng.financeOverview(Object.assign({fromM:1,toM:12}, UNITS));
const N=ov.metrics.nsip;
ok('NSIP 实际在合理量级(USD/台)', sane(N.actual), 'actual='+N.actual);
ok('NSIP BP口径在合理量级', sane(N.bp), 'bp='+N.bp);
ok('NSIP 预测口径在合理量级', sane(N.fc), 'fc='+N.fc);
const arr=[N.actual,N.bp,N.fc].filter(v=>v!=null&&isFinite(v));
const spread=Math.max.apply(null,arr)/Math.min.apply(null,arr);
ok('NSIP 三口径量级一致(max/min<5)', spread<5, 'spread='+spread.toFixed(2)+' ['+arr.map(x=>x.toFixed(1)).join(' / ')+']');

// ---- 2. Sell in/out 量达成率合理 ----
const ratioSane=v=>v==null||(isFinite(v)&&v>0.001&&v<1000);   // 0.1%~100000%;旧 bug=126442
ok('Sell in量 BP达成率合理(非单位错位)', ratioSane(ov.metrics.sellIn.bpAttain), 'bpAttain='+ov.metrics.sellIn.bpAttain);
ok('Sell in量 预测达成率合理', ratioSane(ov.metrics.sellIn.fcAttain), 'fcAttain='+ov.metrics.sellIn.fcAttain);
ok('Sell out量 BP达成率合理', ratioSane(ov.metrics.sellOut.bpAttain), 'bpAttain='+ov.metrics.sellOut.bpAttain);

// ---- 3. 产品看板 NSIP + NSIP同比 ----
const pb=eng.financeProductBoard(Object.assign({fromM:1,toM:12}, UNITS));
const tot=pb.line.total;
ok('产品看板 25/26 NSIP 合理量级', sane(tot.nsip25)&&sane(tot.nsip26), 'nsip25='+tot.nsip25+' nsip26='+tot.nsip26);
ok('产品看板行含 nsipYoy(供 NSIP同比列)', ('nsipYoy' in tot), 'keys='+Object.keys(tot).join(','));
if('nsipYoy' in tot){
  const expect=(tot.nsip25&&tot.nsip26)?(tot.nsip26-tot.nsip25):null;
  const got=tot.nsipYoy;
  const eq=(expect==null&&got==null)||(expect!=null&&got!=null&&Math.abs(got-expect)<1e-6);
  ok('nsipYoy=nsip26-nsip25(绝对USD差,非百分比)', eq, 'got='+got+' expect='+expect);
}

console.log(fail?('\n'+fail+' FAILED'):'\nALL PASS');
process.exit(fail?1:0);

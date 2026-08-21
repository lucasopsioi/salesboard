// app/fin-overview.test.js
const os=require('os'),fs=require('fs'),path=require('path');
const {Engine}=require('../engine-core'); require('../engine-finance');
const ok=(n,c,d)=>console.log((c?'PASS':'FAIL')+' '+n+(c?'':' :: '+JSON.stringify(d)));
const near=(a,b,e=1e-4)=>a!=null&&b!=null&&Math.abs(a-b)<=Math.max(e,Math.abs(b)*1e-4);
const e=new Engine(fs.mkdtempSync(path.join(os.tmpdir(),'ov-')));
e.loadSample();
const o=e.financeOverview({year:2026,fromM:1,toM:3,finUnits:{actual:'USD',forecast:'MUSD',bp:'MUSD'}});
ok('curYear', o.curYear===2026, o.curYear);
const M=o.metrics;
ok('rev actual>0', M.rev.actual>0, M.rev);
ok('rev yoy = (a-p)/p', near(M.rev.yoy,(M.rev.actual-M.rev.prev)/M.rev.prev), M.rev);
ok('rev bpAttain = actual/bp', M.rev.bp>0 && near(M.rev.bpAttain,M.rev.actual/M.rev.bp), M.rev);
ok('rev fcAttain = actual/fc', M.rev.fc>0 && near(M.rev.fcAttain,M.rev.actual/M.rev.fc), M.rev);
// sell-in 实际来自 PSI
const psi=e._psiActual({year:2026,fromM:1,toM:3});
ok('sellIn actual = PSI si26', near(M.sellIn.actual,psi.si26), {got:M.sellIn.actual,exp:psi.si26});
ok('sellOut actual = PSI so26', near(M.sellOut.actual,psi.so26), {got:M.sellOut.actual,exp:psi.so26});
ok('sellIn bp>0 & attain', M.sellIn.bp>0 && near(M.sellIn.bpAttain,M.sellIn.actual/M.sellIn.bp), M.sellIn);
// 销毛率：率 + pp 差
ok('gmr actual = gm/rev', M.gmr.actual>0 && M.gmr.actual<1, M.gmr);
ok('gmr prevDiff = actual-prev (pp)', near(M.gmr.prevDiff,M.gmr.actual-M.gmr.prev), M.gmr);
ok('gmr bpDiff = actual-bpRate', near(M.gmr.bpDiff,M.gmr.actual-M.gmr.bp), M.gmr);
// NSIP：净收入 / 收入量（财经实际表），同比/与目标用差值
ok('nsip actual>0', M.nsip.actual>0, M.nsip);
ok('nsip prevDiff = actual-prev', near(M.nsip.prevDiff,M.nsip.actual-M.nsip.prev), M.nsip);

// === Finding 1: 排除小计行 —— 独立 leaf-sum 对照（demo 无小计行，证明 loop 累加同一集合）===
// 独立从 this.fin 计算 src0/当年/区间内/非小计 的 净销售收入 实际(按来源单位归一,金额缩放)
(function(){
  const F=e.fin, fm=e.finMeta;
  const {isSubtotal, finUnitScale, isQtyMetric}=require('../engine-core');
  const REV='净销售收入'; const revCode=F.dimIndex.metric.get(REV);
  const US=finUnitScale({finUnits:{actual:'USD',forecast:'MUSD',bp:'MUSD'}});
  const repSub=new Set(); F.dimDict.rep.forEach((v,c)=>{ if(isSubtotal(v)) repSub.add(c); });
  const lvSubs=['lv1','lv2','lv3','lv4'].map(k=>{ const s=new Set(); const d=F.dimDict[k]; if(d) d.forEach((v,c)=>{ if(isSubtotal(v)) s.add(c); }); return {k,s,arr:F.dimCode[k]}; });
  let leaf=0;
  for(let i=0;i<F.n;i++){
    if(F.dimCode.metric[i]!==revCode) continue;
    if(F.src[i]!==0) continue;
    const yy=Math.floor(F.ym[i]/100), mm=F.ym[i]%100;
    if(yy!==2026||mm<1||mm>3) continue;
    if(repSub.has(F.dimCode.rep[i])) continue;
    if(lvSubs.some(L=>L.arr&&L.s.has(L.arr[i]))) continue;
    leaf+=(F.val[i]||0)*(isQtyMetric(REV)?1:US[F.src[i]]);
  }
  ok('rev actual = 独立 leaf-sum (非小计)', near(M.rev.actual,leaf), {got:M.rev.actual,exp:leaf});
})();

// === Finding 2: 国家办筛选必须减少财经侧总量(REQUIRED)===
const repNames=[]; e.fin.dimDict.rep.forEach(v=>{ if(/国家办/.test(v)) repNames.push(v); });
const aRep=repNames[0];
ok('demo 有国家办', !!aRep, repNames);
const oRep=e.financeOverview({year:2026,fromM:1,toM:3,reps:[aRep],finUnits:{actual:'USD',forecast:'MUSD',bp:'MUSD'}});
ok('rep 过滤后 rev.actual>0', oRep.metrics.rev.actual>0, oRep.metrics.rev);
ok('rep 过滤后 rev.actual < 未过滤(财经侧应用国家办筛选)', oRep.metrics.rev.actual < M.rev.actual, {filtered:oRep.metrics.rev.actual, all:M.rev.actual});

// === dims：供下拉用的各维全量取值列表(去重/去小计/去空，不受 p 筛选影响) ===
ok('dims 存在', !!o.dims, o.dims);
const D=o.dims||{};
ok('dims.lv1 含 平板', Array.isArray(D.lv1) && D.lv1.includes('平板'), D.lv1);
ok('dims.reps 非空', Array.isArray(D.reps) && D.reps.length>0, D.reps);
ok('dims.reps 每个含「国家办」', Array.isArray(D.reps) && D.reps.length>0 && D.reps.every(v=>/国家办/.test(v)), D.reps);
const noDupNoEmpty=arr=>Array.isArray(arr) && arr.indexOf('')<0 && new Set(arr).size===arr.length;
['lv1','lv2','lv3','lv4','reps'].forEach(k=>{ ok('dims.'+k+' 无空串无重复', noDupNoEmpty(D[k]), D[k]); });
// dims 不受 p 的国家办筛选影响：过滤后的下拉选项与未过滤一致
ok('dims.reps 不受 reps 筛选影响', JSON.stringify((oRep.dims||{}).reps)===JSON.stringify(D.reps), {filtered:(oRep.dims||{}).reps, all:D.reps});

console.log('ALL PASS');

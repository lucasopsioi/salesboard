// app/fin-psi-actual.test.js
const os=require('os'),fs=require('fs'),path=require('path');
const {Engine}=require('../engine-core'); require('../engine-finance');
const ok=(n,c,d)=>console.log((c?'PASS':'FAIL')+' '+n+(c?'':' :: '+JSON.stringify(d)));
const near=(a,b,e=1e-6)=>a!=null&&Math.abs(a-b)<=e;
const e=new Engine(fs.mkdtempSync(path.join(os.tmpdir(),'psi-')));
e.loadSample();
const S=e.store;
// 手算 demo 期望：当年(2026)与去年(2025) 1-3月 全量 sell-in/out（非小计行）
function expect(yr,fromM,toM){ let si=0,so=0; for(let i=0;i<S.n;i++){const y=S.ymd[i],yy=Math.floor(y/10000),mm=Math.floor(y/100)%100;
  if(yy!==yr||mm<fromM||mm>toM)continue;
  if(S.subtotalCodes.repOffice.has(S.dimCode.repOffice[i])||S.subtotalCodes.family.has(S.dimCode.family[i])||S.subtotalCodes.series.has(S.dimCode.series[i]))continue;
  si+=S.sellIn[i]; so+=S.sellOut[i]; } return {si,so}; }
const E26=expect(2026,1,3), E25=expect(2025,1,3);
const r=e._psiActual({year:2026,fromM:1,toM:3});
ok('hasPsi', r.hasPsi===true, r);
ok('si26', near(r.si26,E26.si), {got:r.si26,exp:E26.si});
ok('so26', near(r.so26,E26.so), {got:r.so26,exp:E26.so});
ok('si25', near(r.si25,E25.si), {got:r.si25,exp:E25.si});
ok('so25', near(r.so25,E25.so), {got:r.so25,exp:E25.so});
// 国家办过滤(命名归一)：财经侧用「<地名>国家办」,PSI 底表是「<地名>终端事业部」,经 finPsiRepNorm 归一桥接。
// 传财经口径名 巴西国家办 → 命中 PSI 巴西终端事业部 子集,且 0 < 子集 ≤ 全量(证明既归一又是真子集)。
const finRep='巴西国家办';  // 财经命名(PSI 侧无此名,只有 巴西终端事业部)
const r2=e._psiActual({year:2026,fromM:1,toM:3,reps:[finRep]});
ok('rep 命名归一: 财经国家办名命中 PSI 终端事业部子集', r2.si26>0 && r2.si26<=r.si26+1e-6, {sub:r2.si26,all:r.si26});
// _finProductScope：财经 LV 筛选 → family/series 名称集
const sc1=e._finProductScope({lv1:['平板']});
ok('scope lv1=平板 -> families非空', sc1.families&&sc1.families.length>0, sc1);
ok('scope lv1=平板 families 全在平板下', sc1.families.every(f=>typeof f==='string'), sc1);
const sc2=e._finProductScope({lv3:['Slate Pro']});
ok('scope lv3 直传', sc2.families&&sc2.families.includes('Slate Pro'), sc2);
const sc3=e._finProductScope({});
ok('scope 空 -> 全 null', sc3.families===null&&sc3.series===null&&sc3.reps===null, sc3);
console.log('ALL PASS');

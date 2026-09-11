// TDD for engine financeBPBoard: 全年BP达成面板 (收入达成 by Family/Rep/Rep×Family + GM% pp).
// Feeds finRows directly via eng._buildFin (internal row format:
//   [type,brand,region,rep,country,lv1,lv2,lv3,lv4,metric,order,ym,val,version])
//   type: 'A'/other=actual(src0), 'F'=forecast(src1), 'B'=BP(src2)
// Family = 产品LV1 (lv1). Actual = curYear months 1..cutoff; BP = curYear full-year, version match.
const fs=require('fs'),os=require('os'),path=require('path');
const E=require('../engine.js');
let f=0; const ok=(n,c,extra)=>{console.log((c?'PASS ':'FAIL ')+n+(c?'':'  <<< '+(extra==null?'':JSON.stringify(extra)))); if(!c)f++;};
const near=(a,b,e)=>a!=null&&b!=null&&Math.abs(a-b)<=(e||1e-9);

const REV='净销售收入', GM='销售毛利';
const BR='Acme', REG='拉美大区', VER='国家办工作底稿';
const ORD={[REV]:10,[GM]:20};
// row builders: rep, family(lv1) vary; brand defaults to BR but can be overridden (brand-filter test)
const A=(rep,l1,metric,ym,val,brand)=>['A',brand||BR,REG,rep,'',l1,'','','',metric,ORD[metric],ym,val];           // actual src0
const B=(rep,l1,metric,ym,val,brand)=>['B',brand||BR,REG,rep,'',l1,'','','',metric,ORD[metric],ym,val,VER];        // BP src2

// 2 reps × 2 families. curYear=2026. actual months 1-3; BP full year (use month 0/13? use 1..12).
const REP1='巴西国家办', REP2='墨西哥国家办';
const FAM1='平板', FAM2='音频与智能配件';

// Actual revenue/gm per (rep,family), months 1-3.
//                rep1                              rep2
//          FAM1        FAM2              FAM1        FAM2
const actRev={ [REP1]:{[FAM1]:[10,20,30],[FAM2]:[5,5,5]},   [REP2]:{[FAM1]:[40,10,10],[FAM2]:[1,2,3]} };
const actGm ={ [REP1]:{[FAM1]:[3,6,9],   [FAM2]:[1,1,1]},   [REP2]:{[FAM1]:[12,3,3], [FAM2]:[0,1,1]} };
// BP full-year revenue/gm per (rep,family) (single bucket per family, put on month 1..12 sums).
const bpRev ={ [REP1]:{[FAM1]:200,[FAM2]:50},  [REP2]:{[FAM1]:150,[FAM2]:30} };
const bpGm  ={ [REP1]:{[FAM1]:60, [FAM2]:10},  [REP2]:{[FAM1]:45, [FAM2]:6}  };

const rows=[];
for(const rep of [REP1,REP2]) for(const fam of [FAM1,FAM2]){
  for(let m=1;m<=3;m++){
    rows.push(A(rep,fam,REV,2026*100+m,actRev[rep][fam][m-1]));
    rows.push(A(rep,fam,GM ,2026*100+m,actGm[rep][fam][m-1]));
  }
  // BP full-year: spread across 12 months equally-ish; just put the lump on month 1.
  rows.push(B(rep,fam,REV,2026*100+1,bpRev[rep][fam]));
  rows.push(B(rep,fam,GM ,2026*100+1,bpGm[rep][fam]));
}

// ---- Brand-filter fixture: add a SECOND brand (COMMON) on the same rep/Family as ACME(Acme) ----
// financeBPBoard must filter by p.brands like 达成表/财务. Without the fix it ignores brand → totals double-count.
const BR2='COMMON';
const comRev={ [REP1]:{[FAM1]:[100,100,100],[FAM2]:[50,50,50]}, [REP2]:{[FAM1]:[100,100,100],[FAM2]:[50,50,50]} };
const comGm ={ [REP1]:{[FAM1]:[10,10,10],   [FAM2]:[5,5,5]},    [REP2]:{[FAM1]:[10,10,10],   [FAM2]:[5,5,5]}    };
const comBpRev={ [REP1]:{[FAM1]:1000,[FAM2]:500}, [REP2]:{[FAM1]:1000,[FAM2]:500} };
const comBpGm ={ [REP1]:{[FAM1]:100, [FAM2]:50},  [REP2]:{[FAM1]:100, [FAM2]:50}  };
for(const rep of [REP1,REP2]) for(const fam of [FAM1,FAM2]){
  for(let m=1;m<=3;m++){
    rows.push(A(rep,fam,REV,2026*100+m,comRev[rep][fam][m-1],BR2));
    rows.push(A(rep,fam,GM ,2026*100+m,comGm[rep][fam][m-1],BR2));
  }
  rows.push(B(rep,fam,REV,2026*100+1,comBpRev[rep][fam],BR2));
  rows.push(B(rep,fam,GM ,2026*100+1,comBpGm[rep][fam], BR2));
}

const udir=fs.mkdtempSync(path.join(os.tmpdir(),'finbp-ud-'));
const eng=new E.Engine(udir);
eng._buildFin(rows);
ok('hasFin', eng.hasFin);

// All detailed assertions below use the ACME-only view (brand filter must isolate Acme from COMMON).
const r=eng.financeBPBoard({brands:[BR]});
ok('result not null', !!r);
ok('hasBP true', r&&r.hasBP===true, r&&{hasBP:r.hasBP});
ok('bpVersion=国家办工作底稿', r&&r.bpVersion===VER, r&&r.bpVersion);
ok('curYear=2026', r&&r.curYear===2026, r&&r.curYear);
ok('cutoff=3', r&&r.cutoff===3, r&&r.cutoff);

// ---- expected sums ----
const sum3=a=>a[0]+a[1]+a[2];
// per family actual rev
const fam1ActRev=sum3(actRev[REP1][FAM1])+sum3(actRev[REP2][FAM1]); // 60+60=120
const fam2ActRev=sum3(actRev[REP1][FAM2])+sum3(actRev[REP2][FAM2]); // 15+6=21
const fam1BpRev =bpRev[REP1][FAM1]+bpRev[REP2][FAM1];               // 350
const fam2BpRev =bpRev[REP1][FAM2]+bpRev[REP2][FAM2];               // 80
const totActRev=fam1ActRev+fam2ActRev;     // 141
const totBpRev =fam1BpRev+fam2BpRev;       // 430

// ---- revByFamily ----
const fByFam={}; (r.revByFamily||[]).forEach(x=>fByFam[x.key]=x);
ok('revByFamily has FAM1', !!fByFam[FAM1]);
ok('revByFamily FAM1 actual', fByFam[FAM1]&&near(fByFam[FAM1].actual,fam1ActRev), fByFam[FAM1]&&fByFam[FAM1].actual);
ok('revByFamily FAM1 bp', fByFam[FAM1]&&near(fByFam[FAM1].bp,fam1BpRev), fByFam[FAM1]&&fByFam[FAM1].bp);
ok('revByFamily FAM1 attain=act/bp', fByFam[FAM1]&&near(fByFam[FAM1].attain,fam1ActRev/fam1BpRev), fByFam[FAM1]&&{a:fByFam[FAM1].attain,exp:fam1ActRev/fam1BpRev});
ok('revByFamily FAM2 attain', fByFam[FAM2]&&near(fByFam[FAM2].attain,fam2ActRev/fam2BpRev), fByFam[FAM2]&&fByFam[FAM2].attain);
const famTot=(r.revByFamily||[]).find(x=>x.key==='total');
ok('revByFamily total row', !!famTot);
ok('revByFamily total actual', famTot&&near(famTot.actual,totActRev), famTot&&famTot.actual);
ok('revByFamily total bp', famTot&&near(famTot.bp,totBpRev), famTot&&famTot.bp);
ok('revByFamily total attain', famTot&&near(famTot.attain,totActRev/totBpRev), famTot&&famTot.attain);

// ---- revByRep ----
const rep1ActRev=sum3(actRev[REP1][FAM1])+sum3(actRev[REP1][FAM2]); // 60+15=75
const rep1BpRev =bpRev[REP1][FAM1]+bpRev[REP1][FAM2];               // 250
const rByRep={}; (r.revByRep||[]).forEach(x=>rByRep[x.key]=x);
ok('revByRep REP1 actual', rByRep[REP1]&&near(rByRep[REP1].actual,rep1ActRev), rByRep[REP1]&&rByRep[REP1].actual);
ok('revByRep REP1 attain', rByRep[REP1]&&near(rByRep[REP1].attain,rep1ActRev/rep1BpRev), rByRep[REP1]&&rByRep[REP1].attain);
const repTot=(r.revByRep||[]).find(x=>x.key==='total');
ok('revByRep total actual', repTot&&near(repTot.actual,totActRev), repTot&&repTot.actual);

// ---- revByRepFamily (cross) ----
const cross={}; (r.revByRepFamily||[]).forEach(x=>cross[x.rep+'|'+x.family]=x);
ok('cross has REP1×FAM1', !!cross[REP1+'|'+FAM1]);
ok('cross REP1×FAM1 actual', cross[REP1+'|'+FAM1]&&near(cross[REP1+'|'+FAM1].actual,sum3(actRev[REP1][FAM1])), cross[REP1+'|'+FAM1]&&cross[REP1+'|'+FAM1].actual);
ok('cross REP1×FAM1 attain', cross[REP1+'|'+FAM1]&&near(cross[REP1+'|'+FAM1].attain,sum3(actRev[REP1][FAM1])/bpRev[REP1][FAM1]), cross[REP1+'|'+FAM1]&&cross[REP1+'|'+FAM1].attain);
ok('cross has REP2×FAM2', !!cross[REP2+'|'+FAM2]);
ok('cross has 4 combos', (r.revByRepFamily||[]).length===4, r.revByRepFamily&&r.revByRepFamily.length);

// ---- gmrByFamily (GM% pp) ----
const fam1ActGm=sum3(actGm[REP1][FAM1])+sum3(actGm[REP2][FAM1]); // 18+18=36
const fam1BpGm =bpGm[REP1][FAM1]+bpGm[REP2][FAM1];              // 105
const g1act=fam1ActGm/fam1ActRev, g1bp=fam1BpGm/fam1BpRev;
const gFam={}; (r.gmrByFamily||[]).forEach(x=>gFam[x.key]=x);
ok('gmrByFamily FAM1 actGmPct', gFam[FAM1]&&near(gFam[FAM1].actGmPct,g1act), gFam[FAM1]&&{a:gFam[FAM1].actGmPct,exp:g1act});
ok('gmrByFamily FAM1 bpGmPct', gFam[FAM1]&&near(gFam[FAM1].bpGmPct,g1bp), gFam[FAM1]&&gFam[FAM1].bpGmPct);
ok('gmrByFamily FAM1 pp=act-bp', gFam[FAM1]&&near(gFam[FAM1].pp,g1act-g1bp), gFam[FAM1]&&{pp:gFam[FAM1].pp,exp:g1act-g1bp});
ok('gmrByFamily total exists', !!(r.gmrByFamily||[]).find(x=>x.key==='total'));

// ---- gmrByRep (GM% pp) ----
const rep1ActGm=sum3(actGm[REP1][FAM1])+sum3(actGm[REP1][FAM2]); // 18+3=21
const rep1BpGm =bpGm[REP1][FAM1]+bpGm[REP1][FAM2];              // 70
const gr1act=rep1ActGm/rep1ActRev, gr1bp=rep1BpGm/rep1BpRev;
const gRep={}; (r.gmrByRep||[]).forEach(x=>gRep[x.key]=x);
ok('gmrByRep REP1 pp', gRep[REP1]&&near(gRep[REP1].pp,gr1act-gr1bp), gRep[REP1]&&{pp:gRep[REP1].pp,exp:gr1act-gr1bp});

// ---- BRAND FILTER: financeBPBoard must honor p.brands (consistent with 达成表) ----
// ACME-only total (r above) vs no-brand total (both ACME + COMMON). Without the fix they'd be equal.
const huaTot=(r.revByFamily||[]).find(x=>x.key==='total');
const all=eng.financeBPBoard({});  // no brand filter -> full all-brand totals
const allTot=(all.revByFamily||[]).find(x=>x.key==='total');
// Expected full totals = ACME fixtures + COMMON fixtures.
const comFam1ActRev=sum3(comRev[REP1][FAM1])+sum3(comRev[REP2][FAM1]); // 300+300=600
const comFam2ActRev=sum3(comRev[REP1][FAM2])+sum3(comRev[REP2][FAM2]); // 150+150=300
const comTotActRev=comFam1ActRev+comFam2ActRev;                        // 900
const comTotBpRev=comBpRev[REP1][FAM1]+comBpRev[REP2][FAM1]+comBpRev[REP1][FAM2]+comBpRev[REP2][FAM2]; // 3000
const fullActRev=totActRev+comTotActRev;  // 141+900=1041
const fullBpRev =totBpRev +comTotBpRev;   // 430+3000=3430
ok('brand[ACME] total actual = ACME-only', huaTot&&near(huaTot.actual,totActRev), huaTot&&{a:huaTot.actual,exp:totActRev});
ok('brand[ACME] total bp = ACME-only', huaTot&&near(huaTot.bp,totBpRev), huaTot&&{b:huaTot.bp,exp:totBpRev});
ok('no-brand total actual = full(ACME+COMMON)', allTot&&near(allTot.actual,fullActRev), allTot&&{a:allTot.actual,exp:fullActRev});
ok('no-brand total bp = full(ACME+COMMON)', allTot&&near(allTot.bp,fullBpRev), allTot&&{b:allTot.bp,exp:fullBpRev});
// The discriminating assertion: ACME-only MUST be strictly less than all-brand (fails if brand ignored).
ok('brand filter reduces total (ACME < all)', huaTot&&allTot&&huaTot.actual<allTot.actual, {hua:huaTot&&huaTot.actual,all:allTot&&allTot.actual});

console.log(f?('\n'+f+' FAILED'):'\nALL PASS'); process.exit(f?1:0);

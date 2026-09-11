// TDD for engine financeAchieve NSIP(Sell in量) + forecast-range fields.
// Feeds finRows directly via eng._buildFin (internal row format:
//   [type,brand,region,rep,country,lv1,lv2,lv3,lv4,metric,order,ym,val,version])
//   type: 'A'/other=actual(src0), 'F'=forecast(src1), 'B'=BP(src2)
const fs=require('fs'),os=require('os'),path=require('path');
const E=require('../engine.js');
let f=0; const ok=(n,c,extra)=>{console.log((c?'PASS ':'FAIL ')+n+(c?'':'  <<< '+(extra==null?'':JSON.stringify(extra)))); if(!c)f++;};
const near=(a,b,e)=>a!=null&&b!=null&&Math.abs(a-b)<=(e||1e-9);

const REV='净销售收入', GM='销售毛利', SI='Sell in量';
const BR='Acme', REG='拉美大区', REP='巴西国家办', CTRY='巴西', L1='平板', L2='Slate Tab', SER='Slate Pro';
const VER='国家办工作底稿';
// metric order: rev=10, gm=20, si=30
const ORD={[REV]:10,[GM]:20,[SI]:30};
const A=(metric,ym,val)=>['A',BR,REG,REP,CTRY,L1,L2,SER,'',metric,ORD[metric],ym,val];          // actual
const Frow=(metric,ym,val)=>['F',BR,REG,REP,'',L1,L2,SER,'',metric,ORD[metric],ym,val,VER];      // forecast

const rows=[];
// ---- Actual 2025 (prevYear), months 1-3 ----
const rev25M=[10,20,30], gm25M=[5,8,11], si25M=[1,2,3];      // rev25=60 gm25=24 si25=6
const rev26M=[40,50,60], gm26M=[12,15,18], si26M=[4,5,7];    // rev26=150 gm26=45 si26=16
for(let m=1;m<=3;m++){
  rows.push(A(REV,2025*100+m,rev25M[m-1])); rows.push(A(GM,2025*100+m,gm25M[m-1])); rows.push(A(SI,2025*100+m,si25M[m-1]));
  rows.push(A(REV,2026*100+m,rev26M[m-1])); rows.push(A(GM,2026*100+m,gm26M[m-1])); rows.push(A(SI,2026*100+m,si26M[m-1]));
}
// ---- Forecast 2026: months 1-3 (range) distinct, months 4-12 fill ----
const revFcM=[70,80,90], gmFcM=[25,26,27], siFcM=[7,8,9];    // revFc=240 gmFc=78 siFc=24
for(let m=1;m<=3;m++){
  rows.push(Frow(REV,2026*100+m,revFcM[m-1])); rows.push(Frow(GM,2026*100+m,gmFcM[m-1])); rows.push(Frow(SI,2026*100+m,siFcM[m-1]));
}
for(let m=4;m<=12;m++){ rows.push(Frow(REV,2026*100+m,100)); }  // +900 full-year revenue fill -> rfc=1140

const udir=fs.mkdtempSync(path.join(os.tmpdir(),'finach-ud-'));
const eng=new E.Engine(udir);
eng._buildFin(rows);
ok('hasFin', eng.hasFin);

const r=eng.financeAchieve({version:VER, nsipMetric:SI, fromM:1, toM:3});
ok('result not null', !!r);
ok('hasSi true', r&&r.hasSi===true, r&&{hasSi:r.hasSi,nsipMetric:r.nsipMetric});
ok('nsipMetric=Sell in量', r&&r.nsipMetric===SI, r&&r.nsipMetric);

// region totals (single rep/series -> region == node)
const rr=r&&r.regionRow;
// expected actual sums
const E_rev25=60,E_rev26=150,E_gm25=24,E_gm26=45,E_si25=6,E_si26=16;
const E_revFc=240,E_gmFc=78,E_siFc=24,E_fcRev=1140;
ok('rev25', rr&&near(rr.rev25,E_rev25), rr&&rr.rev25);
ok('rev26', rr&&near(rr.rev26,E_rev26), rr&&rr.rev26);
ok('si25', rr&&near(rr.si25,E_si25), rr&&rr.si25);
ok('si26', rr&&near(rr.si26,E_si26), rr&&rr.si26);
// NSIP = revenue / quantity
ok('nsip25 == rev25/si25', rr&&near(rr.nsip25,E_rev25/E_si25), rr&&{nsip25:rr.nsip25,exp:E_rev25/E_si25});
ok('nsip26 == rev26/si26', rr&&near(rr.nsip26,E_rev26/E_si26), rr&&{nsip26:rr.nsip26,exp:E_rev26/E_si26});
const expNsipYoy=(E_rev26/E_si26 - E_rev25/E_si25)/(E_rev25/E_si25);
ok('nsipYoy correct', rr&&near(rr.nsipYoy,expNsipYoy), rr&&{nsipYoy:rr.nsipYoy,exp:expNsipYoy});
// forecast full-year revenue + cumulative attain
ok('fcRev>0 (full-year)', rr&&rr.fcRev>0&&near(rr.fcRev,E_fcRev), rr&&rr.fcRev);
ok('attain == ra26/fcRev', rr&&near(rr.attain,E_rev26/E_fcRev), rr&&{attain:rr.attain,exp:E_rev26/E_fcRev});
// forecast-in-range fields
ok('revFc (range)', rr&&near(rr.revFc,E_revFc), rr&&rr.revFc);
ok('gmFc (range)', rr&&near(rr.gmFc,E_gmFc), rr&&rr.gmFc);
ok('siFc (range)', rr&&near(rr.siFc,E_siFc), rr&&rr.siFc);
ok('attainFc == revFc/fcRev', rr&&near(rr.attainFc,E_revFc/E_fcRev), rr&&{attainFc:rr.attainFc,exp:E_revFc/E_fcRev});
ok('nsipFc == revFc/siFc', rr&&near(rr.nsipFc,E_revFc/E_siFc), rr&&{nsipFc:rr.nsipFc,exp:E_revFc/E_siFc});
ok('gmrFc == gmFc/revFc', rr&&near(rr.gmrFc,E_gmFc/E_revFc), rr&&{gmrFc:rr.gmrFc,exp:E_gmFc/E_revFc});
// existing fields still present
ok('fc == fcRev (legacy)', rr&&near(rr.fc,E_fcRev), rr&&rr.fc);
ok('gmr26 still present', rr&&near(rr.gmr26,E_gm26/E_rev26), rr&&rr.gmr26);

// repSeries node carries same per-node fields
const node=r&&r.repSeries&&r.repSeries[0]&&r.repSeries[0].rows&&r.repSeries[0].rows[0];
ok('node nsip26', node&&near(node.nsip26,E_rev26/E_si26), node&&node.nsip26);

console.log(f?('\n'+f+' FAILED'):'\nALL PASS'); process.exit(f?1:0);

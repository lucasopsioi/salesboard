// 财经单位归一：实际/预测/BP 三表单位不同(如 实际=USD、BP=MUSD)时,达成率不能被单位放大。
// p.finUnits={actual,forecast,bp} 把每个来源金额换算成统一单位(USD)再算;数量指标(量)不缩放。
// 行格式: [type,brand,region,rep,country,lv1,lv2,lv3,lv4,metric,order,ym,val,version]
//   type 'A'=实际(src0) / 'F'=预测(src1) / 'B'=BP(src2)
const fs=require('fs'),os=require('os'),path=require('path');
const E=require('../engine.js');
let f=0; const ok=(n,c,x)=>{console.log((c?'PASS ':'FAIL ')+n+(c?'':'  <<< '+JSON.stringify(x))); if(!c)f++;};
const near=(a,b,e)=>a!=null&&b!=null&&Math.abs(a-b)<=(e||1e-6);
const REV='净销售收入', QTY='Sell in量', VER='国家办工作底稿', BR='Acme';
const A=(metric,ym,val)=>['A',BR,'拉美','巴西国家办','','平板','','','',metric,metric===REV?10:30,ym,val];
const B=(metric,ym,val)=>['B',BR,'拉美','巴西国家办','','平板','','','',metric,metric===REV?10:30,ym,val,VER];

// 实际收入 = 20,000,000 USD (1~3月) ; BP 收入 = 25 MUSD(全年,记在1月) ; 真实达成率 = 20MUSD/25MUSD = 0.8
// 实际量 = 1000 台 ; BP 量 = 1200 台 (数量无货币单位,不缩放) ; 量达成 = 1000/1200
const rows=[
  A(REV,202601,8000000),A(REV,202602,7000000),A(REV,202603,5000000),
  A(QTY,202601,400),A(QTY,202602,350),A(QTY,202603,250),
  B(REV,202601,25),
  B(QTY,202601,1200),
];
const eng=new E.Engine(fs.mkdtempSync(path.join(os.tmpdir(),'finu-')));
eng._buildFin(rows);
ok('hasFin', eng.hasFin);

// 不传 finUnits(默认不缩放) -> 复现 ×1e6 bug: 20,000,000 / 25 = 800000
const bad=eng.financeBPBoard({});
const badTot=(bad.revByFamily||[]).find(x=>x.key==='total');
ok('默认(无单位)复现×1e6 bug(=800000)', badTot && Math.round(badTot.attain)===800000, {attain:badTot&&badTot.attain});

// 传 finUnits 实际=USD / BP=MUSD -> 归一后达成率 = 0.8
const U={finUnits:{actual:'USD',forecast:'MUSD',bp:'MUSD'}};
const good=eng.financeBPBoard(U);
const goodTot=(good.revByFamily||[]).find(x=>x.key==='total');
ok('归一后 BPBoard 收入达成 ≈ 0.8', goodTot && near(goodTot.attain,0.8), {attain:goodTot&&goodTot.attain});

// financeBP: 收入(金额)被归一=0.8 ; 数量(量)不缩放=1000/1200
const bp=eng.financeBP(U);
const rcell=bp.rep.total.cells[REV], qcell=bp.rep.total.cells[QTY];
ok('financeBP 收入达成归一 ≈ 0.8', rcell && near(rcell.attain,0.8), {a:rcell&&rcell.attain});
ok('financeBP 数量不缩放 (1000/1200)', qcell && near(qcell.attain,1000/1200), {a:qcell&&qcell.attain, exp:1000/1200});

// financeAchieve: 全年BP口径下 rev26 归一(USD), 与不归一相差 1e6 抵消; 用达成率 attain=ra26/rfc 需同单位
//   这里没有预测(F)数据, attainFc/attain 主要看 rev26 数值量级是否被正确归一(=20,000,000 USD)
const ach=eng.financeAchieve(U);
ok('financeAchieve rev26 归一到USD(=20,000,000)', ach && near(ach.regionRow.rev26,20000000,1), {rev26:ach&&ach.regionRow.rev26});

console.log(f?('\n'+f+' FAILED'):'\nALL PASS'); process.exit(f?1:0);

const fs=require('fs'),os=require('os'),path=require('path');
const E=require('../engine.js');
const XLSX=require('xlsx');
let f=0; const ok=(n,c,x)=>{console.log((c?'PASS ':'FAIL ')+n+(c?'':'  <<< '+JSON.stringify(x))); if(!c)f++;};
const wx=(dir,name,aoa)=>{ const wb=XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb,XLSX.utils.aoa_to_sheet(aoa),'S'); const p=path.join(dir,name); XLSX.writeFile(wb,p); return p; };

const psiDir=fs.mkdtempSync(path.join(os.tmpdir(),'si-psi-'));
const shipDir=fs.mkdtempSync(path.join(os.tmpdir(),'si-ship-'));
const fa=wx(psiDir,'old.xlsx',[['x']]);
const fb=wx(psiDir,'new.xlsx',[['国家','型号','SO'],['MX','Pro',10],['BR','Lite',20],['AR','Max',30]]);
fs.utimesSync(fa,new Date(1000),new Date(1000));   // 显式 mtime，确保 new.xlsx 更新
fs.utimesSync(fb,new Date(2000),new Date(2000));
wx(shipDir,'ship.xlsx',[['国家','型号','日期','发货'],['MX','Pro','20260101',100]]);

const e=new E.Engine(fs.mkdtempSync(path.join(os.tmpdir(),'si-ud-')));
e.config.folder=psiDir; e.config.shipFolder=shipDir;
const info=e.sourcesInfo();

ok('返回 6 个源键', ['psi','inv','fin','idc','ship','cost'].every(k=>k in info), Object.keys(info));
ok('psi 取最新文件 new.xlsx', info.psi && info.psi.file==='new.xlsx', info.psi);
ok('psi mtime≈2000', info.psi && Math.round(info.psi.mtime)===2000, info.psi&&info.psi.mtime);
ok('psi 未 refresh → rows===null(不全量解析算行数)', info.psi && info.psi.rows===null, info.psi&&info.psi.rows);
ok('psi 表头首列=国家', info.psi && info.psi.header[0]==='国家', info.psi&&info.psi.header);
ok('psi 预览前3行,首行MX', info.psi && info.psi.preview.length===3 && info.psi.preview[0][0]==='MX', info.psi&&info.psi.preview);
ok('ship 源正确', info.ship && info.ship.file==='ship.xlsx' && info.ship.header[0]==='国家', info.ship);
ok('未设置源=null', info.inv===null&&info.fin===null&&info.idc===null&&info.cost===null, {inv:info.inv,fin:info.fin,idc:info.idc,cost:info.cost});

// ---- 性能回归(2026-07-11):sourcesInfo 按 (folder,path,mtime,size) 记忆化,同文件第二次不重解析 ----
// 计数拦截:engine 与本测试引用同一 XLSX 模块实例,替换 readFile 可统计解析次数。
const origReadFile=XLSX.readFile; let nRead=0;
XLSX.readFile=(...a)=>{ nRead++; return origReadFile(...a); };
try{
  const e2=new E.Engine(fs.mkdtempSync(path.join(os.tmpdir(),'si-memo-')));
  e2.config.folder=psiDir; e2.config.shipFolder=shipDir;
  nRead=0; const i1=e2.sourcesInfo(); const readAfter1=nRead;
  ok('首次 sourcesInfo 有解析(readFile>0)', readAfter1>0, readAfter1);
  nRead=0; const i2=e2.sourcesInfo(); const readAfter2=nRead;
  ok('第二次 sourcesInfo 命中缓存(readFile===0)', readAfter2===0, {readAfter1,readAfter2});
  ok('缓存命中结果一致(psi行/表头)', i2.psi && i2.psi.file==='new.xlsx' && i2.psi.header[0]==='国家', i2.psi);

  // 改 mtime → 键变 → 缓存失效,重新解析
  fs.utimesSync(fb,new Date(3000),new Date(3000));
  nRead=0; const i3=e2.sourcesInfo(); const readAfter3=nRead;
  ok('改 mtime 后缓存失效(重新解析 readFile>0)', readAfter3>0, readAfter3);
  ok('失效后 mtime 更新为 3000', i3.psi && Math.round(i3.psi.mtime)===3000, i3.psi&&i3.psi.mtime);
}finally{ XLSX.readFile=origReadFile; }

// ---- rows 语义:未 refresh 时源文件不在 this.files → rows:null(渲染端显 '—');ship 用 aoa 行数 ----
const eR=new E.Engine(fs.mkdtempSync(path.join(os.tmpdir(),'si-rows-')));
eR.config.folder=psiDir; eR.config.shipFolder=shipDir;
const infoR=eR.sourcesInfo();
ok('未 refresh 的 psi 源 rows===null', infoR.psi && infoR.psi.rows===null, infoR.psi&&infoR.psi.rows);
ok('ship 源 rows=1(用 aoa 行数,去表头)', infoR.ship && infoR.ship.rows===1, infoR.ship&&infoR.ship.rows);

console.log(f?('\n'+f+' FAILED'):'\nALL PASS'); process.exit(f?1:0);

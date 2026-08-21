const fs=require('fs'),os=require('os'),path=require('path');
const E=require('../engine.js');
let f=0; const ok=(n,c,x)=>{console.log((c?'PASS ':'FAIL ')+n+(c?'':'  <<< '+JSON.stringify(x))); if(!c)f++;};

// ---- Task 1: ship/cost 文件夹 config 持久化 ----
const ud=fs.mkdtempSync(path.join(os.tmpdir(),'ss-'));
const e1=new E.Engine(ud);
e1.setShipFolder('C:/ship'); e1.setCostFolder('C:/cost');
ok('getShipFolder', e1.getShipFolder()==='C:/ship', e1.getShipFolder());
ok('getCostFolder', e1.getCostFolder()==='C:/cost', e1.getCostFolder());
const e2=new E.Engine(ud);   // 同 userDir 重开 → 从 config.json 读回
ok('shipFolder 持久化', e2.getShipFolder()==='C:/ship', e2.getShipFolder());
ok('costFolder 持久化', e2.getCostFolder()==='C:/cost', e2.getCostFolder());

// ---- Task 2: sosimSource 读最新文件 AOA ----
const XLSX=require('xlsx');
const shipDir=fs.mkdtempSync(path.join(os.tmpdir(),'ship-'));
const costDir=fs.mkdtempSync(path.join(os.tmpdir(),'cost-'));
const wx=(dir,name,aoa)=>{ const wb=XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb,XLSX.utils.aoa_to_sheet(aoa),'S'); XLSX.writeFile(wb,path.join(dir,name)); return path.join(dir,name); };
const fa=wx(shipDir,'a.xlsx',[['old']]);
const fb=wx(shipDir,'b.xlsx',[['国家','型号','日期','发货'],['MX','Pro','20260101',100]]);
fs.utimesSync(fa,new Date(1000),new Date(1000));   // 显式 mtime，避免相等导致取错（a 旧 / b 新）
fs.utimesSync(fb,new Date(2000),new Date(2000));
wx(costDir,'c.xlsx',[['SKU','成本'],['Pro-X',50]]);

const e3=new E.Engine(fs.mkdtempSync(path.join(os.tmpdir(),'ss3-')));
e3.setShipFolder(shipDir); e3.setCostFolder(costDir);
const src=e3.sosimSource();
ok('ship 有 aoa', !!(src.ship && Array.isArray(src.ship.aoa) && src.ship.aoa.length), src.ship);
ok('ship 取 mtime 最新(b.xlsx)', src.ship && src.ship.name==='b.xlsx', src.ship&&src.ship.name);
ok('ship aoa 表头正确', src.ship && src.ship.aoa[0][0]==='国家', src.ship&&src.ship.aoa[0]);
ok('cost aoa 正确', !!(src.cost && src.cost.aoa && src.cost.aoa[0][0]==='SKU'), src.cost&&src.cost.aoa&&src.cost.aoa[0]);
const e4=new E.Engine(fs.mkdtempSync(path.join(os.tmpdir(),'ss4-')));
const s4=e4.sosimSource();
ok('未设置源 → ship/cost 均 null', s4.ship===null && s4.cost===null, s4);

// ---- 回归(2026-06-29):单元格是真实 Excel 日期时,sosimSource 的 AOA 必须能被 ShipmentBase/CostBase 解析出行。
//   旧 bug:引擎 openWorkbook(cellDates:true)+defval 把日期读成 Date 对象,而 ymdOf/ymOf 只认序列数字/YYYY串 → 整表解析为空。----
const Ship=require('./shipment-base.js'), Cost=require('./cost-base.js');
const dShip=fs.mkdtempSync(path.join(os.tmpdir(),'dship-')), dCost=fs.mkdtempSync(path.join(os.tmpdir(),'dcost-'));
const wxDate=(dir,name,aoa)=>{ const wb=XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb,XLSX.utils.aoa_to_sheet(aoa,{cellDates:true}),'S'); XLSX.writeFile(wb,path.join(dir,name)); };
wxDate(dShip,'s.xlsx',[['国家','型号','日期','数量'],['MX','Tarvos-W09DK',new Date(2026,0,15),100],['BR','Vantor6',new Date(2026,1,20),2500]]);
wxDate(dCost,'c.xlsx',[['传播名','型号','月','成本'],['Slate Pro','Tarvos-W09DK',new Date(2026,0,1),350]]);
const eD=new E.Engine(fs.mkdtempSync(path.join(os.tmpdir(),'dE-')));
eD.setShipFolder(dShip); eD.setCostFolder(dCost);
const sD=eD.sosimSource();
const shipRows=Ship.parseShipmentAoa(sD.ship.aoa);
const costMap=Cost.parseCostAoa(sD.cost.aoa).costMap;
ok('真实Date发货表 经sosimSource 能解析出行(日期非Date对象)', shipRows.length===2, '行数='+shipRows.length+' date='+JSON.stringify(sD.ship.aoa[1]&&sD.ship.aoa[1][2]));
ok('真实Date成本表 经sosimSource 能解析出SKU', costMap.size===1, 'SKU数='+costMap.size);

// ---- 性能回归(2026-07-11):_newestSourceAoa 按 (folder,path,mtime,size) 记忆化,同文件第二次不重解析 ----
const origReadFile=XLSX.readFile; let nRead=0;
XLSX.readFile=(...a)=>{ nRead++; return origReadFile(...a); };
try{
  const eM=new E.Engine(fs.mkdtempSync(path.join(os.tmpdir(),'ss-memo-')));
  eM.setShipFolder(shipDir); eM.setCostFolder(costDir);
  nRead=0; const m1=eM.sosimSource(); const r1=nRead;
  ok('首次 sosimSource 有解析(readFile>0)', r1>0, r1);
  nRead=0; const m2=eM.sosimSource(); const r2=nRead;
  ok('第二次 sosimSource 命中缓存(readFile===0)', r2===0, {r1,r2});
  ok('缓存命中 aoa 一致(ship 表头)', m2.ship && m2.ship.aoa && m2.ship.aoa[0][0]==='国家', m2.ship&&m2.ship.aoa&&m2.ship.aoa[0]);
  // 改 ship 最新文件 mtime → 键变 → 重解析
  fs.utimesSync(fb,new Date(9000),new Date(9000));
  nRead=0; eM.sosimSource(); const r3=nRead;
  ok('改 mtime 后缓存失效(重新解析 readFile>0)', r3>0, r3);
}finally{ XLSX.readFile=origReadFile; }

console.log(f?('\n'+f+' FAILED'):'\nALL PASS'); process.exit(f?1:0);

const fs=require('fs'),os=require('os'),path=require('path'),XLSX=require('xlsx');
const E=require('../engine.js');   // 相对路径：本文件在 app/ 下
let f=0; const ok=(n,c)=>{console.log((c?'PASS ':'FAIL ')+n); if(!c)f++;};
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'finroute-'));
function wb(aoa,noise){const w=XLSX.utils.book_new();XLSX.utils.book_append_sheet(w,XLSX.utils.aoa_to_sheet(aoa),'成品表');XLSX.utils.book_append_sheet(w,XLSX.utils.aoa_to_sheet(noise||[['x'],['y']]),'源底表');return w;}
// 实际(长表)
const act=[['报表项中文名称','报表项排序序号','品牌','大区','国家办','国家','产品LV1','产品LV2','产品LV3','产品LV4','会计期年月','本月实际'],
 ['净销售收入',10,'Acme','拉美大区','巴西国家办','巴西','平板','Slate Tab','Slate Pro','Tarvos',202601,100],
 ['净销售收入',10,'Acme','拉美大区','巴西国家办','巴西','平板','Slate Tab','Slate Pro','Tarvos',202501,80]];
XLSX.writeFile(wb(act),path.join(dir,'actual.xlsx'));
// 预测(长表 Attribute/Value)
const fc=[['预测场景','版本','品牌','大区','国家办','产品LV1','产品LV2','产品LV3','产品LV4','指标名称','指标序号','金额/数量单位','Attribute','Value'],
 ['6月预测','国家办工作底稿','Acme','拉美大区','巴西国家办','平板','Slate Tab','Slate Pro','Tarvos','净销售收入',10,'百万美元','2026/1/1',120]];
XLSX.writeFile(wb(fc),path.join(dir,'forecast.xlsx'));
// BP(长表 月份/值)
const bp=[['版本中文名','大区中文名','大区英文名','国家办中文名','产品LV1中文名','产品LV1英文名','产品LV2中文名','产品LV2英文名','产品LV3中文名','产品LV3英文名','产品LV4中文名','产品LV4英文名','报表项中文名','报表项英文名','月份','值'],
 ['国家办工作底稿','拉美大区','LA','巴西国家办','平板','Tablet','Slate Tab','Slate Tab','Slate Pro','Pro','Tarvos','Tarvos','净销售收入','NSR','2026/1/1',1000]];
XLSX.writeFile(wb(bp),path.join(dir,'bp.xlsx'));
// 引擎真实入口：setFinFolder(dir) + refresh() —— 与 main.js 的 setFinFolderAndRefresh 一致
const udir=fs.mkdtempSync(path.join(os.tmpdir(),'finroute-ud-'));
const eng=new E.Engine(udir);
eng.setFinFolder(dir);
(async () => {
await eng.refresh();
const m=eng.finMeta;
ok('hasActual',m&&m.hasActual); ok('hasForecast',m&&m.hasForecast); ok('hasBP',m&&m.hasBP);
ok('forecastVersions has 国家办工作底稿', m&&m.forecastVersions&&m.forecastVersions.includes('国家办工作底稿'));
console.log(f?('\n'+f+' FAILED'):'\nALL PASS'); process.exit(f?1:0);
})().catch(e => { console.error(e && e.stack || e); process.exit(1); });

const fs=require('fs'), path=require('path');
const APP='Salesboard';
const isArchiveKey=k=>/^sb[._]/.test(k)||k==='salesboard';
function pickArchiveKeys(obj){ const o={}; for(const k in obj){ if(isArchiveKey(k)) o[k]=obj[k]; } return o; }
function configPath(ud){ return path.join(ud,'archive-config.json'); }
function archiveDir(ud,docs){ try{ const c=JSON.parse(fs.readFileSync(configPath(ud),'utf8')); if(c&&c.dir) return c.dir; }catch(e){} return path.join(docs,'Salesboard存档'); }
function archiveFilePath(ud,docs,ver){ const name=(ver!=null)?('sb-存档-v'+ver+'.json'):'sb-存档.json'; return path.join(archiveDir(ud,docs),name); }
function readArchive(file){ try{ const o=JSON.parse(fs.readFileSync(file,'utf8')); return (o&&o.data)?{data:o.data,savedAt:o.savedAt,appVersion:o.appVersion}:null; }catch(e){ return null; } }
function writeArchive(file,dataObj,ver){ fs.mkdirSync(path.dirname(file),{recursive:true}); fs.writeFileSync(file, JSON.stringify({app:APP,version:1,appVersion:(ver!=null?ver:null),savedAt:new Date().toISOString(),data:dataObj||{}})); return file; }
// 扫存档目录,列出所有版本存档(sb-存档-v{N}.json + 旧无版本文件当 v0),按 appVersion 新→旧。
function listArchives(ud,docs){ const dir=archiveDir(ud,docs); let names=[]; try{ names=fs.readdirSync(dir); }catch(e){ return []; }
  const out=[]; names.forEach(n=>{ let ver=null; const m=n.match(/^sb-存档-v(\d+)\.json$/); if(m) ver=parseInt(m[1],10); else if(n==='sb-存档.json') ver=0; else return;
    const file=path.join(dir,n); let savedAt=null; try{ const o=JSON.parse(fs.readFileSync(file,'utf8')); savedAt=o&&o.savedAt; if(o&&o.appVersion!=null) ver=o.appVersion; }catch(e){}
    out.push({file,appVersion:ver,savedAt}); });
  out.sort((a,b)=>b.appVersion-a.appVersion); return out; }
// 开机读取:当前版文件存在则读它,否则继承最新旧版(listArchives 第一个),都无返回 null。从不写/删旧文件。
function readBootstrap(ud,docs,ver){ const cur=archiveFilePath(ud,docs,ver); if(fs.existsSync(cur)){ return readArchive(cur); }
  const list=listArchives(ud,docs); if(list.length){ const a=readArchive(list[0].file); if(a) return a; } return null; }
function setArchiveDir(ud,docs,newDir,opts){ opts=opts||{}; const oldFile=archiveFilePath(ud,docs);
  fs.mkdirSync(ud,{recursive:true}); fs.writeFileSync(configPath(ud), JSON.stringify({dir:newDir}));
  const newFile=path.join(newDir,'sb-存档.json');
  if(opts.move){ try{ if(fs.existsSync(oldFile)&&path.resolve(oldFile)!==path.resolve(newFile)){ fs.mkdirSync(newDir,{recursive:true}); fs.copyFileSync(oldFile,newFile); } }catch(e){} }
  return newFile; }
module.exports={APP,isArchiveKey,pickArchiveKeys,configPath,archiveDir,archiveFilePath,readArchive,writeArchive,listArchives,readBootstrap,setArchiveDir};

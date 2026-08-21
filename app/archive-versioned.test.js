const fs=require('fs'),os=require('os'),path=require('path');
const AS=require('./archive-store.js');
let f=0; const ok=(n,c,x)=>{console.log((c?'PASS ':'FAIL ')+n+(c?'':'  <<< '+JSON.stringify(x))); if(!c)f++;};

const ud=fs.mkdtempSync(path.join(os.tmpdir(),'ud-'));
const docs=fs.mkdtempSync(path.join(os.tmpdir(),'docs-'));
const dir=AS.archiveDir(ud,docs); fs.mkdirSync(dir,{recursive:true});

ok('archiveFilePath 带版本', AS.archiveFilePath(ud,docs,12).endsWith('sb-存档-v12.json'), AS.archiveFilePath(ud,docs,12));
ok('archiveFilePath 无版本=旧名', AS.archiveFilePath(ud,docs).endsWith('sb-存档.json'), AS.archiveFilePath(ud,docs));

AS.writeArchive(AS.archiveFilePath(ud,docs,11),{ 'sb.a':'11' },11);
AS.writeArchive(AS.archiveFilePath(ud,docs,12),{ 'sb.a':'12' },12);

const r12=AS.readArchive(AS.archiveFilePath(ud,docs,12));
ok('readArchive 带 appVersion', r12 && r12.appVersion===12, r12);
ok('readArchive 带 savedAt', r12 && !!r12.savedAt, r12);

const list=AS.listArchives(ud,docs);
ok('listArchives 2 条', list.length===2, list.map(x=>x.appVersion));
ok('listArchives 新→旧(v12 在前)', list[0].appVersion===12 && list[1].appVersion===11, list.map(x=>x.appVersion));

const boot=AS.readBootstrap(ud,docs,13);
ok('v13 无文件 → 继承 v12 数据', boot && boot.data && boot.data['sb.a']==='12', boot);
ok('继承后 v11/v12 旧文件原样保留', fs.existsSync(AS.archiveFilePath(ud,docs,11)) && fs.existsSync(AS.archiveFilePath(ud,docs,12)), 'preserved');

AS.writeArchive(AS.archiveFilePath(ud,docs,13),{ 'sb.a':'13' },13);
ok('v13 有文件 → 读自己', AS.readBootstrap(ud,docs,13).data['sb.a']==='13', AS.readBootstrap(ud,docs,13));

const ud2=fs.mkdtempSync(path.join(os.tmpdir(),'ud2-')), docs2=fs.mkdtempSync(path.join(os.tmpdir(),'docs2-'));
ok('无任何存档 → null', AS.readBootstrap(ud2,docs2,13)===null, AS.readBootstrap(ud2,docs2,13));

console.log(f?('\n'+f+' FAILED'):'\nALL PASS'); process.exit(f?1:0);

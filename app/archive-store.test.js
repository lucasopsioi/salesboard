const fs=require('fs'),os=require('os'),path=require('path');
const A=require('./archive-store.js');
let f=0; const ok=(n,c)=>{console.log((c?'PASS ':'FAIL ')+n); if(!c)f++;};
const ud=fs.mkdtempSync(path.join(os.tmpdir(),'as-ud-')), docs=fs.mkdtempSync(path.join(os.tmpdir(),'as-doc-'));
// pickArchiveKeys
const picked=A.pickArchiveKeys({'sb.roadmap.products.v1':'a','salesboard':'b','other':'c','sbx':'d'});
ok('pick sb.* + salesboard', picked['sb.roadmap.products.v1']==='a'&&picked['salesboard']==='b'&&!('other'in picked)&&!('sbx'in picked));
// default dir when no config
ok('default dir = documents\\Salesboard存档', A.archiveDir(ud,docs)===path.join(docs,'Salesboard存档'));
const file=A.archiveFilePath(ud,docs);
ok('default file name', path.basename(file)==='sb-存档.json');
// missing -> null
ok('readArchive missing -> null', A.readArchive(file)===null);
// write -> read roundtrip
A.writeArchive(file,{'sb.pricing.lib.v1':'{"records":[]}'});
const r=A.readArchive(file);
ok('roundtrip data', r&&r.data&&r.data['sb.pricing.lib.v1']==='{"records":[]}');
// bad file -> null
fs.writeFileSync(file,'not json'); ok('bad json -> null', A.readArchive(file)===null);
// setArchiveDir writes config + moves
A.writeArchive(file,{'salesboard':'x'});               // restore valid
const newDir=fs.mkdtempSync(path.join(os.tmpdir(),'as-new-'));
const nf=A.setArchiveDir(ud,docs,newDir,{move:true});
ok('setArchiveDir returns new file', nf===path.join(newDir,'sb-存档.json'));
ok('config now points to newDir', A.archiveDir(ud,docs)===newDir);
ok('moved file readable at new dir', A.readArchive(nf)&&A.readArchive(nf).data['salesboard']==='x');
console.log(f?('\n'+f+' FAILED'):'\nALL PASS'); process.exit(f?1:0);

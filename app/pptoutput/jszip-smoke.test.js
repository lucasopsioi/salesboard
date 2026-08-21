const JSZip = require('../lib/jszip.min.js');
let f=0; const ok=(n,c)=>{console.log((c?'PASS ':'FAIL ')+n); if(!c)f++;};
(async ()=>{
  const z=new JSZip(); z.file('a.txt','hello');
  const bytes=await z.generateAsync({type:'uint8array'});
  ok('生成的 zip 非空', bytes && bytes.length>50);
  const z2=await JSZip.loadAsync(bytes);
  const back=await z2.file('a.txt').async('string');
  ok('往返读回内容一致', back==='hello');
  console.log(f?('\n'+f+' FAILED'):'\nALL PASS'); process.exit(f?1:0);
})();

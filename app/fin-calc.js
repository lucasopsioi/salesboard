(function(root,factory){const a=factory();if(typeof module!=='undefined'&&module.exports)module.exports=a;if(typeof window!=='undefined')window.FinCalc=a;})(this,function(){
  const yoy=(cur,prev)=>prev?(cur-prev)/prev:null;
  const attain=(actual,plan)=>plan?actual/plan:null;
  const gmRate=(gm,rev)=>rev?gm/rev:null;
  const ppDiff=(c,p)=>(c==null||p==null)?null:c-p;
  const nsip=(rev,si)=>si?rev/si:null;
  const fYoy=(c,p)=>`IFERROR((${c}-${p})/${p},"")`;
  const fAttain=(a2,p)=>`IFERROR(${a2}/${p},"")`;
  const fRate=(n,d)=>`IFERROR(${n}/${d},"")`;
  const fPp=(c,p)=>`IFERROR(${c}-${p},"")`;
  return {yoy,attain,gmRate,ppDiff,nsip,fYoy,fAttain,fRate,fPp};
});

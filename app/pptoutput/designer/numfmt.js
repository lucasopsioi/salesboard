(function (root, factory){ const a=factory(); if(typeof module!=='undefined'&&module.exports)module.exports=a; if(typeof window!=='undefined')window.PptNumFmt=a; })(this, function(){
  const SCALE={ none:[1,''], k:[1e3,'千'], w:[1e4,'万'], m:[1e6,'百万'], K:[1e3,'K'], W:[1e4,'W'], Million:[1e6,'M'] };
  function group(intStr){ return intStr.replace(/\B(?=(\d{3})+(?!\d))/g,','); }
  function fixed(n, d){ const s=(n).toFixed(d); const [i,frac]=s.split('.'); const neg=i.startsWith('-'); const gi=group(neg?i.slice(1):i); return (neg?'-':'')+gi+(frac?'.'+frac:''); }
  function formatNum(value, unit, decimals){
    if(value==null||isNaN(value)) return '0';
    const d=Math.max(0,Math.min(3, decimals==null?1:decimals));
    if(unit==='auto'){ const a=Math.abs(value); if(a>=1e8) return fixed(value/1e8,2)+'亿'; if(a>=1e4) return fixed(value/1e4,1)+'万'; return fixed(value,0); }
    const s=SCALE[unit]||SCALE.none; return fixed(value/s[0], unit==='none'?d:d)+s[1];
  }
  return { formatNum };
});

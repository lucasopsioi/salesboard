(function (root, factory){ const a=factory(); if(typeof module!=='undefined'&&module.exports)module.exports=a; if(typeof window!=='undefined')window.PptGeo=a; })(this, function(){
  const inchToPx=(v,s)=>v*s, pxToInch=(v,s)=>v/s;
  const snap=(v,g)=>{ if(!(g>0)) return v; const n=Math.round(v/g)*g; const dec=(String(g).split('.')[1]||'').length; return dec?Number(n.toFixed(dec)):n; };
  function clampRect(r,p){ let w=Math.min(Math.max(0.2,r.w),p.w), h=Math.min(Math.max(0.2,r.h),p.h);
    let x=Math.max(0,Math.min(r.x,p.w-w)), y=Math.max(0,Math.min(r.y,p.h-h)); return {x,y,w,h}; }
  function edges(r){ return {x:[r.x, r.x+r.w/2, r.x+r.w], y:[r.y, r.y+r.h/2, r.y+r.h]}; }
  function guides(m, others, tol){ const me=edges(m); const gx=[], gy=[]; let dx=0,dy=0, bx=tol, by=tol;
    others.forEach(o=>{ const oe=edges(o);
      me.x.forEach((mv,i)=>oe.x.forEach(ov=>{ const d=ov-mv; if(Math.abs(d)<bx){ bx=Math.abs(d); dx=d; } if(Math.abs(ov-mv)<tol) gx.push(ov); }));
      me.y.forEach((mv,i)=>oe.y.forEach(ov=>{ const d=ov-mv; if(Math.abs(d)<by){ by=Math.abs(d); dy=d; } if(Math.abs(ov-mv)<tol) gy.push(ov); })); });
    return {x:[...new Set(gx)], y:[...new Set(gy)], dx, dy}; }
  function topAt(pt, els){ let best=null, bz=-Infinity; els.forEach(e=>{ if(pt.x>=e.x&&pt.x<=e.x+e.w&&pt.y>=e.y&&pt.y<=e.y+e.h&&(e.z||0)>=bz){ bz=e.z||0; best=e.id; } }); return best; }
  function alignRects(rects, mode){ if(!rects||!rects.length) return [];
    const minX=Math.min(...rects.map(r=>r.x)), maxX=Math.max(...rects.map(r=>r.x+r.w));
    const minY=Math.min(...rects.map(r=>r.y)), maxY=Math.max(...rects.map(r=>r.y+r.h));
    const midX=(minX+maxX)/2, midY=(minY+maxY)/2;
    return rects.map(r=>{ switch(mode){
      case 'left':    return {x:minX,        y:r.y};
      case 'right':   return {x:maxX-r.w,    y:r.y};
      case 'centerH': return {x:midX-r.w/2,  y:r.y};
      case 'top':     return {x:r.x, y:minY};
      case 'bottom':  return {x:r.x, y:maxY-r.h};
      case 'centerV': return {x:r.x, y:midY-r.h/2};
      default:        return {x:r.x, y:r.y};
    }}); }
  function distributeRects(rects, axis){ const n=rects?rects.length:0; if(n<3) return rects?rects.map(r=>({x:r.x,y:r.y})):[];
    const coord=axis==='v'?'y':'x', size=axis==='v'?'h':'w';
    const idx=rects.map((r,i)=>i).sort((a,b)=>rects[a][coord]-rects[b][coord]);
    const first=rects[idx[0]], last=rects[idx[n-1]];
    const span=(last[coord]+last[size])-first[coord];
    const sumSize=rects.reduce((s,r)=>s+r[size],0);
    const gap=(span-sumSize)/(n-1);
    const out=new Array(n); let cur=first[coord];
    idx.forEach((oi,k)=>{ const r=rects[oi]; const c = k===0 ? first[coord] : cur;
      out[oi]= axis==='v' ? {x:r.x, y:c} : {x:c, y:r.y};
      cur=c+r[size]+gap; });
    return out; }
  return { inchToPx, pxToInch, snap, clampRect, guides, topAt, alignRects, distributeRects };
});

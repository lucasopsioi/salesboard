const G=require('./geometry.js');
let f=0; const ok=(n,c)=>{console.log((c?'PASS ':'FAIL ')+n); if(!c)f++;};
ok('inch→px', G.inchToPx(2,96)===192);
ok('px→inch', G.pxToInch(192,96)===2);
ok('snap 0.1', G.snap(1.23,0.1)===1.2 && G.snap(1.27,0.1)===1.3);
const c=G.clampRect({x:-1,y:8,w:3,h:1},{w:13.333,h:7.5});
ok('clamp x≥0', c.x===0);
ok('clamp 不超下边', c.y+c.h<=7.5+1e-9);
const g=G.guides({x:2,y:1,w:2,h:1},[{x:2.02,y:5,w:2,h:1}],0.1);
ok('左边缘对齐给参考线', g.x.length>=1 && Math.abs(g.dx-0.02)<1e-9);
const t=G.topAt({x:2.5,y:1.5},[{id:'a',x:2,y:1,w:2,h:1,z:0},{id:'b',x:2,y:1,w:2,h:1,z:1}]);
ok('命中最高 z', t==='b');
ok('空命中 null', G.topAt({x:50,y:50},[])===null);
{ const rs=[{x:0,y:0,w:2,h:1},{x:5,y:3,w:4,h:1},{x:2,y:6,w:1,h:1}];
  const L=G.alignRects(rs,'left'); ok('left 对齐到最小x=0', L.every(p=>p.x===0));
  const R=G.alignRects(rs,'right'); ok('right 对齐右边界=9', R.map((p,i)=>p.x+rs[i].w).every(v=>v===9));
  const T=G.alignRects(rs,'top'); ok('top 对齐到最小y=0', T.every(p=>p.y===0));
  const CH=G.alignRects(rs,'centerH'); const mid=( Math.min(...rs.map(r=>r.x)) + Math.max(...rs.map(r=>r.x+r.w)) )/2;
  ok('centerH 各自居中到包围盒中线', CH.every((p,i)=> Math.abs((p.x+rs[i].w/2)-mid)<1e-9 ));
  ok('left 不改 y', L.every((p,i)=>p.y===rs[i].y));
}
{ const rs=[{x:0,y:0,w:1,h:1},{x:2,y:0,w:1,h:1},{x:10,y:0,w:1,h:1}];
  const D2=G.distributeRects(rs,'h'); // 首尾不动；中间均匀
  ok('distribute 首不动', D2[0].x===0); ok('distribute 尾不动', D2[2].x===10);
  // 三个等宽(1)、跨度 0..11，间隙=(11-3)/2=4 → 中间 x=0+1+4=5
  ok('distribute 中间均匀', Math.abs(D2[1].x-5)<1e-9);
}
console.log(f?('\n'+f+' FAILED'):'\nALL PASS'); process.exit(f?1:0);

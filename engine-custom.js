/* ============================================================
   Salesboard 数据引擎 — 自定义图表 / IDC 聚合模块
   把 custom / aggIdc 两个 Engine 原型方法从 engine-core.js 抽离至此，
   通过 prototype 挂回 Engine（行为保持的纯搬移）。
   ============================================================ */
'use strict';
const C = require('./engine-core');
const { FLOW, buildFilters, hasFilterVal, isSubtotal, asArr } = C;

// IDC 通用聚合（cat=维度, legend=维度, measure=units/value/asp(加权)）
C.Engine.prototype.aggIdc = function(p){
  const s=this.idc; if(!s) return {cats:[],series:[],data:{},total:0,measure:p&&p.measure};
  const measure=(p&&p.measure)||'units', isAsp=(measure==='asp');
  const aggType=(p&&p.agg)||'sum';
  const filters=(p&&p.filters)||{};
  const fl=[]; for(const k in filters){ if(!s.dimCode[k]) continue; const vals=asArr(filters[k]); if(!vals.length) continue;
    const set=new Set(); vals.forEach(v=>{ const c=s.dimIndex[k].get(String(v)); if(c!==undefined) set.add(c); }); fl.push([s.dimCode[k],set]); }
  const catField=p&&p.cat&&p.cat.field, catCode=(catField&&s.dimCode[catField])?s.dimCode[catField]:null;
  const legField=p&&p.legend, legCode=(legField&&s.dimCode[legField])?s.dimCode[legField]:null;
  const map=new Map();
  for(let i=0;i<s.n;i++){
    let ok=true; for(let j=0;j<fl.length;j++){ if(!fl[j][1].has(fl[j][0][i])){ok=false;break;} } if(!ok) continue;
    let ck; if(catCode){ ck=s.dimDict[catField][catCode[i]]; if(ck==='') continue; } else ck='(全部)';
    let lk='(值)'; if(legCode){ lk=s.dimDict[legField][legCode[i]]; if(lk==='') continue; }
    let bm=map.get(ck); if(!bm){ bm=new Map(); map.set(ck,bm); }
    let cell=bm.get(lk); if(!cell){ cell={sum:0,n:0,u:0,v:0,mn:Infinity,mx:-Infinity}; bm.set(lk,cell); }
    const mv=(measure==='value')?s.value[i]:s.units[i]; const uu=s.units[i], vv=s.value[i];
    cell.u+=uu; cell.v+=vv; cell.n++;
    if(!isAsp){ cell.sum+=mv; if(mv<cell.mn)cell.mn=mv; if(mv>cell.mx)cell.mx=mv; }
  }
  const resolve=c=> isAsp?(c.u>0?c.v*1e6/c.u:0): aggType==='avg'?(c.n?c.sum/c.n:0): aggType==='count'?c.n: aggType==='min'?(c.mn===Infinity?0:c.mn): aggType==='max'?(c.mx===-Infinity?0:c.mx): c.sum;
  const cats=[...map.keys()].sort((a,b)=>String(a).localeCompare(String(b),'zh'));
  const seriesSet=new Set(); map.forEach(bm=>bm.forEach((_,lk)=>seriesSet.add(lk)));
  let series=[...seriesSet].sort((a,b)=>String(a).localeCompare(String(b),'zh'));
  const data={}; series.forEach(se=>data[se]={}); let total=0;
  cats.forEach(ck=>{ const bm=map.get(ck); series.forEach(se=>{ const cell=bm&&bm.get(se); const v=cell?resolve(cell):0; data[se][ck]=v; if(!isAsp) total+=v; }); });
  if(series.length>20){ const tot=series.map(se=>[se,cats.reduce((a,c)=>a+(data[se][c]||0),0)]).sort((a,b)=>b[1]-a[1]); const keep=new Set(tot.slice(0,20).map(x=>x[0])); series=series.filter(se=>keep.has(se)); }
  return {cats,series,data,measure,agg:isAsp?'asp':aggType,total};
};

/* ---------- 自定义图表: 按 x维 × y维 × 颜色维 聚合一个指标(气泡/散点/矩阵) ---------- */
C.Engine.prototype.custom = function(p){
  const s=this.store; if(!s) return {points:[],xs:[],ys:[],colors:[],metric:p.sizeMetric||'sellOut'};
  const metric=p.sizeMetric||'sellOut', flow=FLOW[metric]?1:0, mArr=s[metric];
  const {fl}=buildFilters(s,p.filters,null);
  const xC=p.xDim&&s.dimCode[p.xDim]?s.dimCode[p.xDim]:null;
  const yC=p.yDim&&s.dimCode[p.yDim]?s.dimCode[p.yDim]:null;
  const cC=p.colorDim&&s.dimCode[p.colorDim]?s.dimCode[p.colorDim]:null;
  // 渠道口径(用户 2026-08-21 拍板):渠道列视同不存在,ALL/Online/Offline 彼此无包含关系,一律全加,不再剔 ALL 行
  const agg=new Map();
  for(let i=0;i<s.n;i++){
    let ok=true; for(let j=0;j<fl.length;j++){ if(!fl[j][1].has(fl[j][0][i])){ok=false;break;} } if(!ok) continue;
    const xv=xC?s.dimDict[p.xDim][xC[i]]:'(全部)';
    const yv=yC?s.dimDict[p.yDim][yC[i]]:'(全部)';
    const cv=cC?s.dimDict[p.colorDim][cC[i]]:'';
    if((xC&&isSubtotal(xv))||(yC&&isSubtotal(yv))||(cC&&isSubtotal(cv))) continue;
    const key=xv+'§'+yv+'§'+cv; let cell=agg.get(key); if(!cell){cell={x:xv,y:yv,c:cv,sum:0,ld:-1,lv:0};agg.set(key,cell);}
    const v=mArr[i]||0, y=s.ymd[i];
    if(flow) cell.sum+=v; else if(y>=cell.ld){cell.ld=y;cell.lv=v;}
  }
  const points=[...agg.values()].map(c=>({x:c.x,y:c.y,color:c.c,size:flow?c.sum:c.lv}));
  const sortZh=(a,b)=>String(a).localeCompare(String(b),'zh');
  return {points, xs:[...new Set(points.map(o=>o.x))].sort(sortZh), ys:[...new Set(points.map(o=>o.y))].sort(sortZh),
    colors:[...new Set(points.map(o=>o.color))].filter(c=>c!=='').sort(sortZh), metric};
};

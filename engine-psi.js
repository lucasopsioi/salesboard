/* ============================================================
   Salesboard 数据引擎 — PSI / 图表模块
   把 query/agg 两个 Engine 原型方法从 engine-core.js 抽离至此，
   通过 prototype 挂回 Engine（行为保持的纯搬移）。
   ============================================================ */
'use strict';
const C = require('./engine-core');
const { FLOW, buildFilters, seriesAllowedSet, ymdInt, hasFilterVal, bucketOf, MAX_SERIES, isSubtotal } = C;

/* metric 容错归一(2026-08-28 评测R10):AI/外部调用常传小写或别名,原实现 s[metric]
   取不到字段会在下标处直接抛 TypeError 崩掉整次查询。 */
const METRIC_ALIAS = { sellin:'sellIn', sellout:'sellOut', selin:'sellIn', selout:'sellOut',
  si:'sellIn', so:'sellOut', inventory:'inv', stock:'inv', dos:'dos', inv:'inv',
  sellIn:'sellIn', sellOut:'sellOut' };
C.Engine.prototype.query = function(p){
  const s=this.store; if(!s) return {buckets:[],series:[],data:{},capped:false,total:0};
  const rawMet = p.metric || 'sellOut';
  const metric = METRIC_ALIAS[rawMet] || METRIC_ALIAS[String(rawMet).toLowerCase()] || null;
  if(!metric || !s[metric]) return {buckets:[],series:[],data:{},capped:false,total:0,
    error:'metric 无效:「'+rawMet+'」。可用: sellIn / sellOut / inv / dos(大小写敏感,已尝试自动归一失败)'};
  p = Object.assign({}, p, { metric });
  const sd=p.stackDim, gran=p.gran||'month', flow=FLOW[metric]?1:0;
  const isDos=(metric==='dos'); const dosDays={day:1,week:7,month:30}[gran]||30;
  // 音频延迟录入:DOS 曲线上,纯音频 cell 在没有 SO 的桶置空(null → 图上留空,不造数)。混合 cell 不动。
  const AU=isDos?C.audioDimInfo(s):null, auCode=AU?s.dimCode[AU.dim]:null;
  const mArr=s[metric], sdCode=s.dimCode[sd];
  // build filter list (multi-select aware; skip stackDim; skip channel if grouping by channel)
  const {fl,invalid}=buildFilters(s,p.filters,sd);
  if(invalid) return {buckets:[],series:[],data:{},capped:false,total:0};
  const seriesSet=seriesAllowedSet(s,p.filters,sd);  // limit series to selected stackDim values
  const fromI=p.from?ymdInt(p.from):0, toI=p.to?ymdInt(p.to):99999999;
  const subSet=s.subtotalCodes[sd];
  // 渠道不做去重:所有渠道行直接汇总。DOS 重算 = 库存(最新期求和) ÷ 日均SO(每桶累计库存快照+SO)。
  // agg: scode -> bucket -> {sum, ld, lv, so}
  const agg=new Map();
  const sdDict=s.dimDict[sd];
  for(let i=0;i<s.n;i++){
    const y=s.ymd[i]; if(y<fromI||y>toI) continue;
    let ok=true; for(let j=0;j<fl.length;j++){ if(!fl[j][1].has(fl[j][0][i])){ok=false;break;} }
    if(!ok) continue;
    const sc=sdCode[i];
    if(subSet.has(sc)) continue;
    if(seriesSet && !seriesSet.has(sc)) continue;
    let bm=agg.get(sc); if(!bm){ bm=new Map(); agg.set(sc,bm); }
    const b=bucketOf(y,gran);
    let cell=bm.get(b); if(!cell){ cell={sum:0,ld:-1,lv:0,so:0}; bm.set(b,cell); }
    if(isDos){
      const iv=s.inv[i]||0; if(y>cell.ld){ cell.ld=y; cell.lv=iv; } else if(y===cell.ld){ cell.lv+=iv; }
      cell.so+=s.sellOut[i]||0;
      if(AU){ if(AU.codes.has(auCode[i])) cell.au=1; else cell.tb=1; }
    } else {
      const v=mArr[i]||0;
      // flow metrics sum across the bucket; snapshot inv takes the latest period in the bucket and
      // SUMS across all rolled-up records at that period (not keep-last).
      if(flow) cell.sum+=v; else if(y>cell.ld){ cell.ld=y; cell.lv=v; } else if(y===cell.ld){ cell.lv+=v; }
    }
  }
  // materialize
  const bucketSet=new Set(); agg.forEach(bm=>bm.forEach((_,b)=>bucketSet.add(b)));
  const buckets=[...bucketSet].sort();
  const allSeries=[...agg.keys()].map(c=>sdDict[c]);
  const raw=(scode,b)=>{ const bm=agg.get(scode); const c=bm&&bm.get(b); if(!c)return 0;
    if(isDos) return c.so>0 ? Math.round(c.lv/(c.so/dosDays)) : ((c.au&&!c.tb)?null:0);   // DOS = inv ÷ daily sell-out;纯音频无SO桶→null(延迟未录,不造数)
    return flow?c.sum:c.lv; };
  // totals + cap (overridable via p.limit; 0/large = show all)
  const codes=[...agg.keys()];
  const limit = p.limit && p.limit>0 ? p.limit : MAX_SERIES;
  let keep=codes;
  if(codes.length>limit){
    const tot=codes.map(c=>{ let t=0; const bm=agg.get(c); bm.forEach(cell=>t+=flow?cell.sum:cell.lv); return [c,t]; });
    tot.sort((a,b)=>b[1]-a[1]); keep=tot.slice(0,limit-1).map(x=>x[0]);
  }
  const capped=keep.length<codes.length;
  const keepSet=new Set(keep);
  const series = keep.map(c=>sdDict[c]).concat(capped?['其他']:[]);
  const data={}; series.forEach(nm=>data[nm]={});
  buckets.forEach(b=>{
    let other=0;
    codes.forEach(c=>{ const v=raw(c,b); if(keepSet.has(c)) data[sdDict[c]][b]=v; else other+=(v||0); });
    if(capped) data['其他'][b]=other;
  });
  return {buckets, series, data, capped, total:codes.length};
};

/* ---------- 库存/SO 模拟:PSI 单元级行(country×model×日 渠道合计) ----------
   返回 [{region,rep,country,line,family,series,model,ymd,sellIn,sellOut,inv}],
   每行 = 一个 country×model×日 的全部行合计(供渲染层 invFetchPsiUnits 经 IPC psiUnits 消费)。
   渠道口径(用户 2026-08-21 拍板)：**渠道列视同不存在**——ALL/Online/Offline 都是普通行标签，
   彼此没有包含关系，一律直接相加，任何地方都不做渠道去重。
   （旧版这里按组剔 ALL 行——那是把 ALL 当汇总行的旧认知，已被用户推翻：
     剔行会让库存 FIFO 的 SO 分母系统性偏小，老批次消耗不掉。）
   跳过空型号/小计行(参照 query 用 subtotalCodes)。 */
C.Engine.prototype.psiUnits = function(){
  const s=this.store; if(!s) return [];
  const d=s.dimDict, c=s.dimCode;
  const subModel=s.subtotalCodes && s.subtotalCodes.model;
  const agg=new Map();
  for(let i=0;i<s.n;i++){
    const mc=c.model[i], model=d.model[mc];
    if(!model || (subModel && subModel.has(mc))) continue;          // 空/小计型号
    const country=d.country[c.country[i]], ymd=s.ymd[i];
    const k=country+''+model+''+ymd;
    let r=agg.get(k);
    if(!r){ r={ region:d.region[c.region[i]], rep:d.repOffice[c.repOffice[i]], country:country,
      line:d.line[c.line[i]], family:d.family[c.family[i]], series:d.series[c.series[i]], model:model,
      ymd:ymd, sellIn:0, sellOut:0, inv:0 }; agg.set(k,r); }
    r.sellIn+=s.sellIn[i]||0; r.sellOut+=s.sellOut[i]||0; r.inv+=s.inv[i]||0;
  }
  return [...agg.values()];
};

/* ---------- 通用聚合(看板设计器用): 类别维(或时间桶) × 图例维 × 度量 × 聚合方式 ---------- */
C.Engine.prototype.agg = function(p){
  const s=this.store; if(!s) return {cats:[],series:[],data:{},total:0};
  const measure=p.measure||'sellOut'; const aggType=p.agg || (FLOW[measure]?'sum':'last');
  const mArr=s[measure];
  const {fl,invalid}=buildFilters(s,p.filters,null); if(invalid) return {cats:[],series:[],data:{},total:0};
  const chCode=s.dimCode.channel;
  const catField=p.cat&&p.cat.field, catGran=(p.cat&&p.cat.gran)||'month', catIsTime=(catField==='period');
  const catCode=(catField&&!catIsTime&&s.dimCode[catField])?s.dimCode[catField]:null;
  const legField=p.legend, legCode=(legField&&s.dimCode[legField])?s.dimCode[legField]:null;
  const map=new Map();
  for(let i=0;i<s.n;i++){
    let ok=true; for(let j=0;j<fl.length;j++){ if(!fl[j][1].has(fl[j][0][i])){ok=false;break;} } if(!ok) continue;
    let ck; if(catIsTime) ck=bucketOf(s.ymd[i],catGran); else if(catCode){ ck=s.dimDict[catField][catCode[i]]; if(ck===''||isSubtotal(ck)) continue; } else ck='(全部)';
    let lk='(值)'; if(legCode){ lk=s.dimDict[legField][legCode[i]]; if(lk===''||isSubtotal(lk)) continue; }
    let bm=map.get(ck); if(!bm){ bm=new Map(); map.set(ck,bm); }
    let cell=bm.get(lk); if(!cell){ cell={sum:0,n:0,ld:-1,lv:0,mn:Infinity,mx:-Infinity}; bm.set(lk,cell); }
    const v=mArr[i]||0; cell.sum+=v; cell.n++; if(v<cell.mn)cell.mn=v; if(v>cell.mx)cell.mx=v;
    const yy=s.ymd[i]; if(yy>cell.ld){ cell.ld=yy; cell.lv=v; } else if(yy===cell.ld){ cell.lv+=v; }  // snapshot 'last' sums at latest period
  }
  const resolve=c=> aggType==='avg'?(c.n?c.sum/c.n:0): aggType==='count'?c.n : aggType==='last'?c.lv : aggType==='min'?(c.mn===Infinity?0:c.mn): aggType==='max'?(c.mx===-Infinity?0:c.mx): c.sum;
  const cats=[...map.keys()].sort((a,b)=>String(a).localeCompare(String(b),'zh'));
  const seriesSet=new Set(); map.forEach(bm=>bm.forEach((_,lk)=>seriesSet.add(lk)));
  let series=[...seriesSet].sort((a,b)=>String(a).localeCompare(String(b),'zh'));
  const data={}; series.forEach(se=>data[se]={});
  let total=0;
  cats.forEach(ck=>{ const bm=map.get(ck); series.forEach(se=>{ const cell=bm&&bm.get(se); const v=cell?resolve(cell):0; data[se][ck]=v; total+=v; }); });
  // 系列过多时按合计取前20
  if(series.length>20){ const tot=series.map(se=>[se,cats.reduce((a,c)=>a+(data[se][c]||0),0)]).sort((a,b)=>b[1]-a[1]); const keep=new Set(tot.slice(0,20).map(x=>x[0])); series=series.filter(se=>keep.has(se)); }
  return {cats,series,data,measure,agg:aggType,total};
};

/* ============================================================
   路标自动识别取数：按 产品/型号 给出逐月 SI/SO 序列 + 累计 + 库存快照。
   **只取数、不做任何判定**——上市/退市的判定规则全在 app/roadmap-detect.js（纯函数、可单测）。
   与 query 的三点不同：
     · 不做 14 系列封顶（路标要看全部产品，不能把长尾并进「其他」）；
     · 一次同时给 SI 与 SO（判定要同时看铺货与动销），外加最新期库存；
     · 附 firstSI/firstSO/lastSO 真实日期，供「样机激活 vs 真上市」取证。
   月轴是所有 item 共享的完整月份序列，缺月补 0（该月没卖 = 0，语义正确）。
   ============================================================ */
/* 底数据直查(2026-09-01)：AI 取不到数的病根多是名称/维度错位——给两个兒底层能力：
   searchDim：一个名字跨全维度模糊定位(归一互含+评分)；rawRows：直查底表原始行。 */
/* 数据目录(2026-09-01 RAG)：PSI 层级树一次扫描建全——line→family→series→product→SKU数，
   模型拿到树就不会把系列名当产品名(层级错位绝症的根治)。 */
C.Engine.prototype.catalog = function(){
  const s=this.store; if(!s) return {tree:[],from:0,to:0,records:0};
  const dims=['line','family','series','product','model'].filter(d=>s.dimCode[d]);
  const key=i=>dims.map(d=>s.dimCode[d][i]).join('|');
  const seen=new Set(); const tuples=[];
  let minY=99999999,maxY=0;
  for(let i=0;i<s.n;i++){
    const y=s.ymd[i]; if(y<minY)minY=y; if(y>maxY)maxY=y;
    const k=key(i); if(seen.has(k)) continue; seen.add(k);
    const t={}; dims.forEach(d=>{ t[d]=s.dimDict[d][s.dimCode[d][i]]; });
    tuples.push(t);
  }
  // 聚树:line -> family -> series -> product -> modelCount
  const tree={};
  tuples.forEach(t=>{
    const L=t.line||'?', F=t.family||'?', SE=t.series||'?', P=t.product||'?';
    tree[L]=tree[L]||{}; tree[L][F]=tree[L][F]||{}; tree[L][F][SE]=tree[L][F][SE]||{};
    tree[L][F][SE][P]=(tree[L][F][SE][P]||0)+(t.model?1:0);
  });
  const lines=[];
  Object.keys(tree).forEach(L=>{
    Object.keys(tree[L]).forEach(F=>{
      Object.keys(tree[L][F]).forEach(SE=>{
        Object.keys(tree[L][F][SE]).forEach(P=>{
          lines.push({line:L,family:F,series:SE,product:P,skuCount:tree[L][F][SE][P]});
        });
      });
    });
  });
  return { from:minY, to:maxY, records:s.n, countries:(s.dimDict.country||[]).slice(0,30),
    repOffices:(s.dimDict.repOffice||[]).slice(0,20), channels:(s.dimDict.channel||[]).slice(0,10),
    tree:lines };
};
C.Engine.prototype.searchDim = function(p){
  p=p||{};
  const s=this.store; if(!s) return {hits:[]};
  const q=String(p.q||'').trim(); if(!q) return {error:'q 必填(要定位的名称)'};
  const nrm=x=>String(x==null?'':x).toLowerCase().replace(/[\s\-_/()\uff08\uff09"']/g,'');
  const nq=nrm(q);
  const hits=[];
  C.DIM_KEYS.forEach(dim=>{
    const dict=s.dimDict[dim]; if(!dict) return;
    dict.forEach(v=>{
      const nv=nrm(v); if(!nv) return;
      let score=0;
      if(nv===nq) score=100;
      else if(nv.indexOf(nq)>=0) score=80-Math.min(30,(nv.length-nq.length));
      else if(nq.indexOf(nv)>=0 && nv.length>=3) score=60-Math.min(30,(nq.length-nv.length));
      if(score>0) hits.push({dim:dim,value:v,score:score});
    });
  });
  hits.sort((a,b)=>b.score-a.score);
  return { q:q, hits:hits.slice(0,12),
    说明: hits.length? '用命中的 dim 作为 filters 键、value 作为取值重查' : '全维度无命中：该名称不在 PSI 底表里(可能是别名/未导入/另一份底表的概念)' };
};
C.Engine.prototype.rawRows = function(p){
  p=p||{};
  const s=this.store; if(!s) return {rows:[],total:0};
  const {fl,invalid}=buildFilters(s,p.filters,null);
  if(invalid) return {rows:[],total:0,error:'filters 里有维度取值不存在，先用 searchDim 定位精确写法'};
  const fromI=p.from?ymdInt(p.from):0, toI=p.to?ymdInt(p.to):99999999;
  const limit=Math.max(1,Math.min(500,+p.limit||200));
  const dims=C.DIM_KEYS.filter(d=>s.dimCode[d]);
  const rows=[]; let total=0;
  for(let i=0;i<s.n;i++){
    let pass=true;
    for(let j=0;j<fl.length;j++){ if(!fl[j][1].has(fl[j][0][i])){ pass=false; break; } }
    if(!pass) continue;
    const y=s.ymd[i]; if(y<fromI||y>toI) continue;
    total++;
    if(rows.length>=limit) continue;
    const r={ymd:y};
    dims.forEach(d=>{ r[d]=s.dimDict[d][s.dimCode[d][i]]; });
    if(s.sellIn[i]) r.sellIn=s.sellIn[i];
    if(s.sellOut[i]) r.sellOut=s.sellOut[i];
    if(s.inv[i]) r.inv=s.inv[i];
    rows.push(r);
  }
  return { rows:rows, total:total, 截断:total>rows.length,
    说明:'原始底表行(未聚合);total='+total+' 行命中'+(total>rows.length?(',仅返回前 '+rows.length+' 行——缩小范围或用聚合工具'):'') };
};
C.Engine.prototype.launchScan = function(p){
  p=p||{};
  const s=this.store;
  const empty={dim:'model', months:[], items:[], maxYmd:0};
  if(!s) return empty;
  const dim = (p.dim && s.dimCode[p.dim]) ? p.dim : (s.dimCode.model ? 'model' : 'product');
  const {fl,invalid}=buildFilters(s,p.filters,null); if(invalid) return empty;
  const gc=s.dimCode[dim], gd=s.dimDict[dim], gSub=s.subtotalCodes[dim]||new Set();
  if(!gc) return empty;
  const AU=C.audioDimInfo(s), auCode=AU?s.dimCode[AU.dim]:null;   // 音频＝人工延迟报量,末端月天然偏低
  const pass=i=>{ for(let j=0;j<fl.length;j++) if(!fl[j][1].has(fl[j][0][i])) return false; return !gSub.has(gc[i]); };

  const monthSet=new Set();
  const byCode=new Map();
  let maxYmd=0;
  for(let i=0;i<s.n;i++){
    if(!pass(i)) continue;
    const y=s.ymd[i], mk=Math.floor(y/100);            // YYYYMM
    monthSet.add(mk); if(y>maxYmd) maxYmd=y;
    const c=gc[i];
    let it=byCode.get(c);
    if(!it){ it={code:c, si:new Map(), so:new Map(), invByYmd:new Map(),
                 firstSI:0, firstSO:0, lastSO:0, cumSI:0, cumSO:0, isAudio:false,
                 product:(s.dimCode.product&&s.dimDict.product)?s.dimDict.product[s.dimCode.product[i]]:'',
                 series:(s.dimCode.series&&s.dimDict.series)?s.dimDict.series[s.dimCode.series[i]]:'',
                 line:(s.dimCode.line&&s.dimDict.line)?s.dimDict.line[s.dimCode.line[i]]:''}; byCode.set(c,it); }
    const si=s.sellIn[i]||0, so=s.sellOut[i]||0, iv=s.inv[i]||0;
    if(si){ it.si.set(mk,(it.si.get(mk)||0)+si); it.cumSI+=si; if(!it.firstSI||y<it.firstSI) it.firstSI=y; }
    if(so){ it.so.set(mk,(it.so.get(mk)||0)+so); it.cumSO+=so; if(!it.firstSO||y<it.firstSO) it.firstSO=y; if(y>it.lastSO) it.lastSO=y; }
    if(iv) it.invByYmd.set(y,(it.invByYmd.get(y)||0)+iv);   // 库存按日求和,最后只取最新那天
    if(auCode && AU.codes.has(auCode[i])) it.isAudio=true;
  }
  if(!monthSet.size) return empty;
  /* 月轴必须是**连续日历月**,不能只列「有数据的月」。
     退市判定要数「连续 N 个月低于阈值」,而底表完全可能整月没有行(示例数据就从
     2025-06 直接跳到 2026-01)。若把缺月从轴上抹掉,那 6 个月的零销售会被跳过、
     连续性数错,产品明明断了半年也判不出退市。缺月补 0 才是它的真实语义。 */
  const lo=Math.min(...monthSet), hi=Math.max(...monthSet);
  const months=[];
  for(let y=Math.floor(lo/100), m=lo%100; y*100+m<=hi; ){
    months.push(y*100+m);
    if(++m>12){ m=1; y++; }
  }
  const mIdx=new Map(); months.forEach((m,i)=>mIdx.set(m,i));
  const fmtM=m=>String(Math.floor(m/100))+'-'+String(m%100).padStart(2,'0');
  const fmtY=y=>y?String(Math.floor(y/10000))+'-'+String(Math.floor(y%10000/100)).padStart(2,'0')+'-'+String(y%100).padStart(2,'0'):'';

  const items=[];
  byCode.forEach(it=>{
    const si=new Array(months.length).fill(0), so=new Array(months.length).fill(0);
    it.si.forEach((v,m)=>{ si[mIdx.get(m)]=Math.round(v); });
    it.so.forEach((v,m)=>{ so[mIdx.get(m)]=Math.round(v); });
    let invYmd=0, invLast=0;
    it.invByYmd.forEach((v,y)=>{ if(y>invYmd){ invYmd=y; invLast=v; } });
    items.push({product:it.product,series:it.series,line:it.line, key:gd[it.code], si, so,
      cumSI:Math.round(it.cumSI), cumSO:Math.round(it.cumSO),
      invLast:Math.round(invLast), invYmd:fmtY(invYmd),
      firstSI:fmtY(it.firstSI), firstSO:fmtY(it.firstSO), lastSO:fmtY(it.lastSO),
      isAudio:it.isAudio });
  });
  items.sort((a,b)=>b.cumSO-a.cumSO);
  return { dim, months:months.map(fmtM), items, maxYmd:fmtY(maxYmd) };
};

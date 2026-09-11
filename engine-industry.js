/* ============================================================
   Salesboard 数据引擎 — 产业看板模块（音频/平板）
   把 industryBoard/industryTrend 两个公开 Engine 原型方法，以及它们
   专用的 _industryDim/_industryVals/_families/_industryFinance 辅助方法，
   从 engine-core.js 抽离至此，通过 prototype 挂回 Engine
   （行为保持的纯搬移）。
   ============================================================ */
'use strict';
const C = require('./engine-core');
const { isSubtotal, buildFilters, hasFilterVal, isoThu, asArr } = C;

/* ---------- 产业看板(音频/平板)：PSI(SI/SO/INV/DOS) + 财经(收入/销毛率) ---------- */
// 产业(平板/音频)所在维度：用户的"产品线"可能落在 line(产品lv2) 或 family(产品lv1)，按含平板/音频自动判定
C.Engine.prototype._industryDim = function(){ const s=this.store; if(!s) return 'line';
    if(s.dimDict.line && s.dimDict.line.some(v=>/平板|音频/.test(v))) return 'line';
    if(s.dimDict.family && s.dimDict.family.some(v=>/平板|音频/.test(v))) return 'family';
    return s.dimDict.line?'line':'family'; }
C.Engine.prototype._industryVals = function(dim,key){ const s=this.store; if(!s||!key||!s.dimDict[dim]) return null; const vs=s.dimDict[dim].filter(v=>v&&v.indexOf(key)>=0); return vs.length?vs:null; }
C.Engine.prototype._families = function(){ const s=this.store, d=this._industryDim(); if(!s||!s.dimDict[d]) return []; return s.dimDict[d].filter(v=>v&&!isSubtotal(v)); }
// 财经：按产品lv1(含 key:平板/音频) 取今年1~N月 vs 去年同期 的净销售收入 + 销售毛利率(名称可能"音频与智能配件",用 contains 匹配)
C.Engine.prototype._industryFinance = function(famKey, year){
    if(!this.hasFin) return null;
    const F=this.fin, fm=this.finMeta;
    const ay=fm.actualYears||fm.years; const curYear=year||ay[ay.length-1]||0, prevYear=curYear-1;
    let cutoff=0; for(let i=0;i<F.n;i++){ if(F.src[i]===0 && Math.floor(F.ym[i]/100)===curYear){ const mm=F.ym[i]%100; if(mm>cutoff)cutoff=mm; } }
    if(!cutoff) cutoff=12;
    const REV=fm.metrics.find(m=>/净销售收入|营业收入|销售收入|^收入$/.test(m));
    const GM=fm.metrics.find(m=>/销售毛利|毛利额|销毛|^毛利$/.test(m));
    const revCode=REV?F.dimIndex.metric.get(REV):undefined, gmCode=GM?F.dimIndex.metric.get(GM):undefined;
    let lv1Set=null; if(famKey){ lv1Set=new Set(); F.dimDict.lv1.forEach((v,c)=>{ if(v&&v.indexOf(famKey)>=0) lv1Set.add(c); }); }
    let revCur=0,revPrev=0,gmCur=0,gmPrev=0;
    const lv1Arr=F.dimCode.lv1, mArr=F.dimCode.metric, sArr=F.src, ymArr=F.ym, vArr=F.val;
    for(let i=0;i<F.n;i++){ if(sArr[i]!==0) continue;
      if(lv1Set && !lv1Set.has(lv1Arr[i])) continue;
      const yy=Math.floor(ymArr[i]/100), mm=ymArr[i]%100; if(mm>cutoff) continue;
      const mc=mArr[i], v=vArr[i];
      if(mc===revCode){ if(yy===curYear)revCur+=v; else if(yy===prevYear)revPrev+=v; }
      else if(mc===gmCode){ if(yy===curYear)gmCur+=v; else if(yy===prevYear)gmPrev+=v; }
    }
    return { cutoff, curYear, prevYear, hasRev:!!REV,
      rev:{cur:revCur,prev:revPrev,yoy:revPrev?(revCur-revPrev)/revPrev:null},
      gm:{curRate:revCur?gmCur/revCur:null, prevRate:revPrev?gmPrev/revPrev:null, diff:(revCur&&revPrev)?(gmCur/revCur-gmPrev/revPrev):null} };
  }
// 产业看板趋势：单指标(sellIn/sellOut/inv/dos)。红=今年(主范围 p.filters)，灰=去年同期；
// 若 p.cmp(对比系列/产品/型号)有值，灰线=对比范围(=主范围的地区/产业 + 对比的产品维度)的去年数据。
C.Engine.prototype.industryTrend = function(p){
    const metric=(p&&p.metric)||'sellOut', gran=(p&&p.gran)||'month';
    const empty={periods:[],cur:[],prev:[],curYear:0,prevYear:0,metric,gran};
    const s=this.store; if(!s) return empty;
    const mkPass=(filters)=>{ const {fl,invalid}=buildFilters(s,filters||{},null);  // 渠道不去重,全部渠道行直接汇总
      return {invalid, pass:i=>{ for(let j=0;j<fl.length;j++) if(!fl[j][1].has(fl[j][0][i])) return false; return true; }}; };
    const mp=mkPass(p.filters); if(mp.invalid) return empty;
    let maxYmd=0; for(let i=0;i<s.n;i++){ if(mp.pass(i)){ const y=s.ymd[i]; if(y>maxYmd)maxYmd=y; } }
    if(!maxYmd) return empty;
    // 底表是"日"数据：年/月/日按真实日历日归属；仅"周"视图用 ISO 周(周四)规则(同一周7天同归属)。缓存 isoThu。
    const thuCache=new Map();
    const thu=y=>{ let t=thuCache.get(y); if(t===undefined){ t=isoThu(y); thuCache.set(y,t); } return t; };
    const yearOf = gran==='week' ? (y=>thu(y).y) : (y=>Math.floor(y/10000));
    const keyOf = gran==='month' ? (y=>Math.floor((y%10000)/100)) : gran==='week' ? (y=>thu(y).w) : (y=>y%10000);
    const labelOf=k=>{ if(gran==='month') return k+'月'; if(gran==='week') return 'W'+k; return Math.floor(k/100)+'/'+(k%100); };
    const curY=yearOf(maxYmd), prevY=curY-1, maxKey=keyOf(maxYmd);
    const from=(p.from!=null&&p.from!=='')?+p.from:null, to=(p.to!=null&&p.to!=='')?+p.to:null;
    const inWin=k=>(from==null||k>=from)&&(to==null||k<=to);
    const bucket=(po,yr)=>{ const m=new Map(); const pass=po.pass;
      for(let i=0;i<s.n;i++){ if(!pass(i)) continue; const y=s.ymd[i]; if(yearOf(y)!==yr) continue; const k=keyOf(y); if(k>maxKey) continue;
        let b=m.get(k); if(!b){b={si:0,so:0,maxYmd:0,inv:0};m.set(k,b);}
        b.si+=s.sellIn[i]||0; b.so+=s.sellOut[i]||0;
        const iv=s.inv[i]||0;
        if(y>b.maxYmd){b.maxYmd=y;b.inv=iv;} else if(y===b.maxYmd){b.inv+=iv;} }
      return m; };
    const curM=bucket(mp,curY);
    // 对比范围：地区/渠道/产业沿用主筛选，产品维度换成对比项
    const cmp=p.cmp||{};
    const cmpHas=asArr(cmp.series).length||asArr(cmp.product).length||asArr(cmp.model).length;
    let prevPO=mp;
    if(cmpHas){ const indDim=this._industryDim(); const cf={};
      ['region','repOffice','country','channel',indDim].forEach(k=>{ if(p.filters && asArr(p.filters[k]).length) cf[k]=p.filters[k]; });
      ['series','product','model'].forEach(k=>{ if(asArr(cmp[k]).length) cf[k]=cmp[k]; });
      const cpp=mkPass(cf); if(!cpp.invalid) prevPO=cpp; }
    const prevM=bucket(prevPO,prevY);
    // KPI 区间同比永远对"主范围"的去年——对比模式下灰线换了产品维度,但 KPI 口径不跟着换
    const prevMainM = prevPO===mp ? prevM : bucket(mp,prevY);
    const keys=[...new Set([...curM.keys(),...prevM.keys()])].filter(inWin).sort((a,b)=>a-b);
    const periods=keys.map(labelOf);
    // 逐期 SI/SO(不随 metric 切换)——前端 KPI 按所选区间求和、算区间同比
    const pick=(m,k,f)=>{ const b=m.get(k); return b?b[f]:0; };
    const siCur=keys.map(k=>pick(curM,k,'si')), soCur=keys.map(k=>pick(curM,k,'so'));
    const siPrev=keys.map(k=>pick(prevMainM,k,'si')), soPrev=keys.map(k=>pick(prevMainM,k,'so'));
    let cur,prev;
    if(metric==='dos'){
      const win=gran==='week'?4:(gran==='month'?1:28), spanD=gran==='month'?30:28;
      const dosArr=m=>{ const so=keys.map(k=>{const b=m.get(k);return b?b.so:0;}), iv=keys.map(k=>{const b=m.get(k);return b?b.inv:0;});
        return keys.map((k,idx)=>{ let t=0; for(let j=Math.max(0,idx-win+1);j<=idx;j++) t+=so[j]; return t>0?Math.round(iv[idx]*spanD/t):0; }); };
      cur=dosArr(curM); prev=dosArr(prevM);
      // 音频延迟录入:音频侧(产业筛选值全部含"音频")的今年 DOS 线,最后有 SO 的期之后置空,不造数。
      const fvA=asArr(p.filters&&p.filters[this._industryDim()]);
      if(fvA.length && fvA.every(v=>String(v).indexOf('音频')>=0)){
        let li=-1; for(let i2=0;i2<soCur.length;i2++) if(soCur[i2]>0) li=i2;
        for(let i2=li+1;i2<cur.length;i2++) cur[i2]=null;
      }
    } else {
      const ext=(m,k)=>{ const b=m.get(k); if(!b) return 0; return metric==='sellIn'?b.si:metric==='inv'?b.inv:b.so; };
      cur=keys.map(k=>Math.round(ext(curM,k))); prev=keys.map(k=>Math.round(ext(prevM,k)));
    }
    return {periods,cur,prev,siCur,siPrev,soCur,soPrev,curYear:curY,prevYear:prevY,metric,gran};
  }
/* ---------- 两代产品生命周期对齐对比(产业看板下方新增,纯新增不改旧逻辑) ----------
   p = { a:{filters,launch?}, b:{filters,launch?}, gran:'day'|'week'|'month' }
   - 上市点(第1期起点)：launch 显式覆盖('YYYY-MM-DD') > 首个 SellOut>0 的日期 > 首个 SellIn>0 的日期。
   - 生命周期桶为**固定长度**：日=1天/周=7天/月=30天(两代真正拉齐;日历月长短不一,不用日历月)。
   - 渠道全加不去重(与全看板口径一致)；库存=桶内最新日快照求和；DOS=库存÷日均SO
     (滑窗与 industryTrend 一致:日28桶/周4桶/月1桶,天数月30其余28)。
   - today 汇总：累计SI/SO=该筛选范围**全部日期**合计(含上市前铺货 SI)；当前库存=最新日快照;
     当前DOS=当前库存÷近28天日均SO;days=上市至数据最新日天数。 */
C.Engine.prototype._lcDays = function(ymd){ const y=Math.floor(ymd/10000), m=Math.floor((ymd%10000)/100), d=ymd%100; return Math.floor(Date.UTC(y,m-1,d)/86400000); }
C.Engine.prototype._lcYmdStr = function(days){ const dt=new Date(days*86400000); const p=n=>String(n).padStart(2,'0'); return dt.getUTCFullYear()+'-'+p(dt.getUTCMonth()+1)+'-'+p(dt.getUTCDate()); }
C.Engine.prototype._lifecycleSide = function(filters, launchOverride, gran){
    const s=this.store; const empty={empty:true, launch:null, buckets:[], today:null};
    if(!s) return empty;
    const {fl,invalid}=buildFilters(s,filters||{},null); if(invalid) return empty;
    const pass=i=>{ for(let j=0;j<fl.length;j++) if(!fl[j][1].has(fl[j][0][i])) return false; return true; };
    let minSO=0,minSI=0,maxY=0;
    for(let i=0;i<s.n;i++){ if(!pass(i)) continue; const y=s.ymd[i];
      if(y>maxY)maxY=y;
      if((s.sellOut[i]||0)>0 && (!minSO||y<minSO)) minSO=y;
      if((s.sellIn[i]||0)>0 && (!minSI||y<minSI)) minSI=y; }
    if(!maxY) return empty;
    let launch=0;
    if(launchOverride && /^\d{4}-\d{2}-\d{2}$/.test(launchOverride)) launch=+launchOverride.replace(/-/g,'');
    if(!launch) launch=minSO||minSI;
    if(!launch) return empty;
    const len = gran==='month'?30 : gran==='week'?7 : 1;
    const d0=this._lcDays(launch);
    const m=new Map();
    let cumSI=0,cumSO=0, invLd=-1, invLv=0;
    for(let i=0;i<s.n;i++){ if(!pass(i)) continue; const y=s.ymd[i];
      cumSI+=s.sellIn[i]||0; cumSO+=s.sellOut[i]||0;
      const iv=s.inv[i]||0;
      if(y>invLd){ invLd=y; invLv=iv; } else if(y===invLd){ invLv+=iv; }
      const idx=Math.floor((this._lcDays(y)-d0)/len); if(idx<0) continue;   // 上市前的行只进累计,不进生命周期桶
      let b=m.get(idx); if(!b){ b={si:0,so:0,ld:-1,lv:0}; m.set(idx,b); }
      b.si+=s.sellIn[i]||0; b.so+=s.sellOut[i]||0;
      if(y>b.ld){ b.ld=y; b.lv=iv; } else if(y===b.ld){ b.lv+=iv; }
    }
    const maxIdx=Math.max(...m.keys(), 0);
    const win = gran==='week'?4:(gran==='month'?1:28), spanD = gran==='month'?30:28;
    const buckets=[];
    for(let k=0;k<=maxIdx;k++){ const b=m.get(k)||{si:0,so:0,lv:0};
      let t=0; for(let j=Math.max(0,k-win+1);j<=k;j++){ const bj=m.get(j); t+=bj?bj.so:0; }
      buckets.push({ k:k, date:this._lcYmdStr(d0+k*len),
        si:Math.round(b.si), so:Math.round(b.so), inv:Math.round(b.lv),
        dos: t>0?Math.round(b.lv*spanD/t):0 }); }
    // 当前DOS = 库存 ÷ 近28天日均SO(按真实日历回看)
    // 音频延迟录入:窗口终点改用"最后有 SO 的日"(W_last 周),库存用 ≤窗口末 的最近快照;平板不变。
    const AUl=C.audioDimInfo(s), auCodeL=AUl?s.dimCode[AUl.dim]:null;
    let auOnly=AUl?true:false, lastSoY=0;
    for(let i=0;i<s.n;i++){ if(!pass(i)) continue;
      if(AUl && !AUl.codes.has(auCodeL[i])) auOnly=false;
      if((s.sellOut[i]||0)>0 && s.ymd[i]>lastSoY) lastSoY=s.ymd[i]; }
    if(AUl && auOnly && lastSoY){
      // 最小原子粒度:每个单元(全维度组合)各自取 W_last 窗口;Σ单元W_last周库存 ÷ Σ单元窗口SO/28
      const UD=C.DIM_KEYS.filter(d=>s.dimCode[d]);
      const uk=i=>{ let k=''; for(let j=0;j<UD.length;j++){ k+=s.dimCode[UD[j]][i]+','; } return k; };
      const lastSo=new Map();
      for(let i=0;i<s.n;i++){ if(!pass(i)) continue; if((s.sellOut[i]||0)>0){ const k=uk(i),y=s.ymd[i]; if(y>(lastSo.get(k)||0)) lastSo.set(k,y); } }
      const win=new Map(); lastSo.forEach((y,k)=>{ const w=C.audioWindow(y); win.set(k,{s:w.start,wls:w.wls,e:w.end,invYmd:0,invAny:0}); });
      for(let i=0;i<s.n;i++){ if(!pass(i)) continue; const w=win.get(uk(i)); if(!w) continue; const y=s.ymd[i];
        if(y>=w.wls&&y<=w.e){ if(y>w.invYmd)w.invYmd=y; } else if(y<w.wls&&y>w.invAny){ w.invAny=y; } }
      win.forEach(w=>{ if(!w.invYmd)w.invYmd=w.invAny; });
      let num=0, den=0;
      for(let i=0;i<s.n;i++){ if(!pass(i)) continue; const w=win.get(uk(i)); if(!w) continue; const y=s.ymd[i];
        if(y>=w.s&&y<=w.e) den+=s.sellOut[i]||0;
        if(y===w.invYmd) num+=s.inv[i]||0; }
      var dosNow = den>0?Math.round(num*28/den):null;
    } else {
      const cutD=this._lcDays(maxY)-27;
      let so28=0;
      for(let i=0;i<s.n;i++){ if(!pass(i)) continue; if(this._lcDays(s.ymd[i])>=cutD) so28+=s.sellOut[i]||0; }
      var dosNow = so28>0?Math.round(invLv*28/so28):0;
    }
    return { empty:false, launch:this._lcYmdStr(d0), buckets:buckets,
      today:{ days:this._lcDays(maxY)-d0+1, asOf:this._lcYmdStr(this._lcDays(maxY)),
        cumSI:Math.round(cumSI), cumSO:Math.round(cumSO), inv:Math.round(invLv), dos:dosNow } };
  }
C.Engine.prototype.lifecycleCompare = function(p){
    p=p||{}; const gran=(p.gran==='week'||p.gran==='month')?p.gran:'day';
    return { gran:gran,
      a:this._lifecycleSide((p.a||{}).filters, (p.a||{}).launch, gran),
      b:this._lifecycleSide((p.b||{}).filters, (p.b||{}).launch, gran) };
  }
// 产业看板汇总：4个KPI(今年SI YTD/SO YTD/当前库存+渠道DOS/全流程库存+全流程DOS) + 单指标今年vs去年/对比 趋势
C.Engine.prototype.industryBoard = function(p){
    p=p||{}; const s=this.store; const indDim=this._industryDim();
    const F=Object.assign({}, p.filters||{});
    const rep = s? this.report({groupDim:indDim, filters:F}) : {total:null,curYear:0,prevYear:0,hasFlow:false};
    const t=rep.total||{};
    const kpi={
      si:{cur:t.siCur||0, prev:t.siPrev||0, yoy:t.siYoy!=null?t.siYoy:null},
      so:{cur:t.cumCur||0, prev:t.cumPrev||0, yoy:t.yoy!=null?t.yoy:null},
      // DOS 是 null 表示「近 4 周没有 SO,算不出周转」,不是 0 天。原来这里 ||0 把它吃成 0,
      // 同一个对象里 flowDos 却规规矩矩判 !=null —— 两种写法不可能是有意设计,是遗漏。
      inv:{cur:t.inv||0, dos:t.dos!=null?t.dos:null},
      flow:{cur:t.flowInv!=null?t.flowInv:null, dos:t.flowDos!=null?t.flowDos:null} };
    const trend = s? this.industryTrend({filters:F, cmp:p.cmp, metric:p.metric, gran:p.gran, from:p.from, to:p.to}) : {periods:[]};
    return { indDim, kpi, trend, curYear:rep.curYear, prevYear:rep.prevYear, hasFlow:rep.hasFlow };
  }

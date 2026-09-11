/* ============================================================
   Salesboard 数据引擎 — 汇总表 report 模块
   把 report 这个 Engine 原型方法从 engine-core.js 抽离至此，
   通过 prototype 挂回 Engine（行为保持的纯搬移）。
   ============================================================ */
'use strict';
const C = require('./engine-core');
const { buildFilters, seriesAllowedSet, hasFilterVal, isoYW, asArr, isSubtotal } = C;

/* ---------- 汇总表 report: 累计SO/同期SO/同比/近N周/WoW/库存/DOS ---------- */
C.Engine.prototype.report = function(p){
    const s=this.store; const empty={weekLabels:[],rows:[],total:null,curYear:0,prevYear:0,hasPrev:false,groupLabel:''};
    if(!s) return empty;
    const gd=p.groupDim, N=p.weeks||9;
    const gCode=s.dimCode[gd], gDict=s.dimDict[gd], gSub=s.subtotalCodes[gd];
    if(!gCode) return empty;
    // filters (multi-select; skip groupDim) + channel exclude (same rule as query)
    const {fl,invalid}=buildFilters(s,p.filters,gd);
    if(invalid) return empty;
    const seriesSet=seriesAllowedSet(s,p.filters,gd);  // limit group rows to selected groupDim values
    // 渠道不做去重:所有渠道行直接汇总(与底表平铺透视一致)。
    const pass=i=>{ for(let j=0;j<fl.length;j++) if(!fl[j][1].has(fl[j][0][i])) return false;
      if(gSub.has(gCode[i])) return false;
      if(seriesSet && !seriesSet.has(gCode[i])) return false; return true; };
    // pass1: 仅判断所选范围是否有命中行(空表判定)。
    let anyRow=false; for(let i=0;i<s.n;i++){ if(pass(i)){ anyRow=true; break; } }
    if(!anyRow) return empty;
    // 同期年份锚点:固定用全量数据的全局最新日(s.maxYmd),不随下钻子集漂移。
    //   否则下钻到"当年无SO的停产产品"时,maxYmd会退回该产品最后活跃年,导致整表
    //   当年/同期年份一起向前漂移(如 25/24 → 24/23),当年累计SO=0 与去年同期对比都丢失。
    //   锚到全局后:当年累计SO缺失=0、去年同期SO照常展示、同比照常计算(用户要求)。
    const maxYmd = s.maxYmd || (()=>{ let m=0; for(let i=0;i<s.n;i++){ if(pass(i)){ const y=s.ymd[i]; if(y>m) m=y; } } return m; })();
    if(!maxYmd) return empty;
    // 累计SO/SI 按真实日历(年/同期日)归属；周列(weekly/last4)保持 ISO 周。
    const actY=Math.floor(maxYmd/10000), prevY=actY-1, maxMd=maxYmd%10000;
    const isoM=isoYW(maxYmd), isoCurY=isoM[0], maxWk=isoM[1];
    // 显示周列：默认近N周；若给了 fromW/toW 则用该范围(裁到[1,maxWk])
    let lastN=[];
    if(p.fromW && p.toW){ let lo=Math.max(1,Math.min(p.fromW,p.toW)), hi=Math.min(maxWk,Math.max(p.fromW,p.toW)); for(let w=lo;w<=hi;w++) lastN.push(w); }
    if(!lastN.length){ for(let w=maxWk-N+1;w<=maxWk;w++) if(w>=1) lastN.push(w); }
    const lastNset=new Set(lastN);
    /* DOS 的 4 整周窗口按**真实日期**回看,不按 ISO 周号取。
       原来是 {maxWk-3..maxWk} 且只认当年(iy===isoCurY):年中两者等价(都是那 4 整周),
       但一到年初就塌——W1 时窗口只剩 1 周 SO,分母却恒定 ÷28 天,DOS 直接虚高 4 倍
       (W2 ×2、W3 ×1.33、W4 起才正常)。音频路径本来就用 audioWindow 按真实日期取,
       天然跨年、没这毛病;现在平板路径也统一走它。 */
    const tabWin=C.audioWindow(maxYmd);
    /* —— 音频延迟录入(方案A·最小原子粒度):音频 SO 手动延迟报量,DOS 不能用当前周窗口。
       原子单元 = 数据最小键(全维度组合:国家×渠道×型号,含上级维度)。**每个单元各自取**
       自己 SO>0 的最后有数日 → 以其 ISO 周为终点的 4 整周(28天)窗口;
       该单元的 DOS 库存 = 它自己 W_last 那周的快照(该周无快照 → 往前最近一期兜底);
       聚合 = Σ各单元库存分子 ÷ Σ各单元日均分母(加权,不是平均 DOS)。
       显示库存(r.inv)与平板路径一字不变。 —— */
    const AU=C.audioDimInfo(s), auCode=AU?s.dimCode[AU.dim]:null;
    const UD=AU?C.DIM_KEYS.filter(d=>s.dimCode[d]):null;                 // 原子键=全部可用维度
    const unitKey=AU?(i=>{ let k=''; for(let j=0;j<UD.length;j++){ k+=s.dimCode[UD[j]][i]+','; } return k; }):null;
    let auWin=null;
    if(AU){
      const lastSo=new Map();
      for(let i=0;i<s.n;i++){ if(!pass(i)||!AU.codes.has(auCode[i])) continue;
        if((s.sellOut[i]||0)>0){ const k=unitKey(i), y=s.ymd[i]; if(y>(lastSo.get(k)||0)) lastSo.set(k,y); } }
      if(lastSo.size){
        auWin=new Map();
        lastSo.forEach((y,k)=>{ const w=C.audioWindow(y); auWin.set(k,{s:w.start,wls:w.wls,e:w.end,invYmd:0,invAny:0}); });
        for(let i=0;i<s.n;i++){ if(!pass(i)||!AU.codes.has(auCode[i])) continue;
          const w=auWin.get(unitKey(i)); if(!w) continue; const y=s.ymd[i];
          if(y>=w.wls&&y<=w.e){ if(y>w.invYmd)w.invYmd=y; } else if(y<w.wls&&y>w.invAny){ w.invAny=y; } }
        auWin.forEach(w=>{ if(!w.invYmd)w.invYmd=w.invAny; });   // W_last 周无库存行 → 往前最近快照兜底
      }
    }
    // pass2
    const G=new Map(); let hasPrev=false;
    for(let i=0;i<s.n;i++){ if(!pass(i)) continue;
      const gc=gCode[i]; let r=G.get(gc);
      if(!r){ r={cumCur:0,cumPrev:0,siCur:0,siPrev:0,weekly:{},last4:0,inv:0,invDos:0,hasAu:0,
        family:s.dimDict.family[s.dimCode.family[i]], line:s.dimDict.line[s.dimCode.line[i]], series:s.dimDict.series[s.dimCode.series[i]], product:s.dimDict.product[s.dimCode.product[i]] }; G.set(gc,r); }
      const y=s.ymd[i], ay=Math.floor(y/10000), md=y%10000, iw=isoYW(y), iy=iw[0], wk=iw[1];
      const so=s.sellOut[i]||0, si=s.sellIn[i]||0;
      if(ay===actY){ r.cumCur+=so; r.siCur+=si; }                                  // 今年所有真实日(均≤maxYmd)
      if(ay===prevY && md<=maxMd){ r.cumPrev+=so; r.siPrev+=si; hasPrev=true; }   // 去年同期=去年同一日历日截至
      if(iy===isoCurY && lastNset.has(wk)) r.weekly[wk]=(r.weekly[wk]||0)+so;       // 周列保持 ISO
      const isAu=AU&&AU.codes.has(auCode[i]);
      if(isAu){ r.hasAu=1; const w=auWin&&auWin.get(unitKey(i));
        if(w){ if(y>=w.s&&y<=w.e) r.last4+=so;              // 音频:该国 W_last 结尾的 4 整周
               if(y===w.invYmd) r.invDos+=s.inv[i]||0; } }   // 音频:DOS 分子用 W_last 周库存
      else { if(y>=tabWin.start&&y<=tabWin.end) r.last4+=so;  // 平板:以 maxYmd 那周收尾的 4 整周(跨年正确)
             if(y===maxYmd) r.invDos+=s.inv[i]||0; }         // 平板:DOS 分子=最新期(与显示一致)
      if(y===maxYmd) r.inv+=s.inv[i]||0;                     // 显示库存:所有行仍取最新期(显示/计算分离)
    }
    const wlast=lastN[lastN.length-1], wprev=lastN[lastN.length-2];
    const mk=(r)=>{ const daily=r.last4>0?r.last4/28:0; const dos=daily>0?Math.round((r.invDos||0)/daily):(r.hasAu?null:0);
      const yoy=r.cumPrev>0?(r.cumCur-r.cumPrev)/r.cumPrev:null;
      const siYoy=r.siPrev>0?(r.siCur-r.siPrev)/r.siPrev:null;
      /* WoW：平板用固定的末两周；**音频用「最后两个有数的周」**——音频 SO 人工延迟报量，
         末尾一两周恒为 0(没录,不是卖了 0),按固定末两周算会得到 0/0=null 或 −100% 的假象。
         与 DOS 的 W_last 口径同一个道理(用户 2026-08-05 定的音频口径),这里补齐。
         wowWeeks 一并回传,导出/叙述里可标明「W31→W32」到底比的哪两周。 */
      let a=r.weekly[wprev]||0, b=r.weekly[wlast]||0, wowW=[wprev,wlast];
      if(r.hasAu){
        const have=lastN.filter(w=>(r.weekly[w]||0)>0);
        if(have.length>=2){ const p2=have[have.length-2], l2=have[have.length-1];
          a=r.weekly[p2]||0; b=r.weekly[l2]||0; wowW=[p2,l2]; }
        else if(have.length===1){ a=0; b=r.weekly[have[0]]||0; wowW=[null,have[0]]; }
      }
      const wow=a>0?(b-a)/a:null;
      return {cumCur:r.cumCur,cumPrev:r.cumPrev,yoy,siCur:r.siCur,siPrev:r.siPrev,siYoy,weekly:lastN.map(w=>r.weekly[w]||0),wow,wowWeeks:wowW,inv:r.inv,dos,last4:r.last4,hasAu:r.hasAu?1:0,
        family:r.family,line:r.line,series:r.series,product:r.product}; };
    const rows=[]; G.forEach((r,gc)=>{ const o=mk(r); o.key=gDict[gc]; rows.push(o); });
    rows.sort((a,b)=>b.cumCur-a.cumCur);
    // total
    const T={cumCur:0,cumPrev:0,siCur:0,siPrev:0,weekly:{},last4:0,inv:0,invDos:0,hasAu:0}; lastN.forEach(w=>T.weekly[w]=0);
    G.forEach(r=>{ T.cumCur+=r.cumCur; T.cumPrev+=r.cumPrev; T.siCur+=r.siCur; T.siPrev+=r.siPrev; T.last4+=r.last4; T.inv+=r.inv; T.invDos+=(r.invDos||0); T.hasAu=T.hasAu||r.hasAu; lastN.forEach(w=>T.weekly[w]+=(r.weekly[w]||0)); });
    const total=mk(T); total.key='合计';
    // 全流程库存列: 库龄表第一Sheet = CDC+FDC库存(国家仓+FDC, 取最新运行日快照);
    //   全流程库存 = 渠道库存(INV最新一期) + CDC+FDC库存; 全流程DOS = 全流程库存×28÷近4周SO
    let hasFlow=false;
    if(this.hasFlow && gd!=='channel'){
      hasFlow=true;
      const flowSum={}; let totFlow=0;
      const fkeys=Object.keys(p.filters||{}).filter(k=>k!=='channel'&&k!==gd&&asArr(p.filters[k]).length);
      const fsets={}; fkeys.forEach(k=>fsets[k]=new Set(asArr(p.filters[k])));
      const gAllow=asArr(p.filters&&p.filters[gd]); const gAllowSet=gAllow.length?new Set(gAllow):null;
      for(const fr of this.flow){
        let ok=true;
        for(const k of fkeys){ if(!fsets[k].has(String(fr[k]==null?'':fr[k]))){ ok=false; break; } }
        if(!ok) continue;
        const gv=fr[gd]; if(gv==null||gv===''||isSubtotal(gv)) continue;
        if(gAllowSet && !gAllowSet.has(gv)) continue;
        flowSum[gv]=(flowSum[gv]||0)+fr.qty; totFlow+=fr.qty;
      }
      const attach=o=>{ const cf=flowSum[o.key]||0; o.dcfdc=cf; o.flowInv=(o.inv||0)+cf; o.flowDos=o.last4>0?Math.round(o.flowInv/(o.last4/28)):(o.hasAu?null:0); };
      rows.forEach(attach);
      total.dcfdc=totFlow; total.flowInv=(total.inv||0)+totFlow; total.flowDos=total.last4>0?Math.round(total.flowInv/(total.last4/28)):(total.hasAu?null:0);
    }
    return {weekLabels:lastN.map(w=>'W'+w), rows, total, curYear:actY, prevYear:prevY, hasPrev, hasFlow,
      groupLabel:gd };
};

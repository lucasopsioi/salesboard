/* ============================================================
   Salesboard 数据引擎 — 财务/经营达成模块
   把 finance/financeKpi/financeAchieve/financeBP/financeBPBoard 五个
   Engine 原型方法从 engine-core.js 抽离至此，通过 prototype 挂回 Engine
   （行为保持的纯搬移）。_finBrandCodes 等实例方法仍留在 core。
   ============================================================ */
'use strict';
const C = require('./engine-core');
/* 月份参数容错(2026-08-28 评测R10):AI 常把 fromM/toM 传成 YYYYMM(202401)——
   旧逻辑 inRange 恒 false → 实际全 0 → "BP达成率0.00%" 这类灾难性错答。归一为 1..12。 */
/* 达成率的分母必须「站得住」（2026-09-07 复盘：经营分析首屏出现 BP完成率 51799351.9%，
   还标成绿色像超额完成 51 万倍）。原判据 `a.bp ? ... : null` 只挡住 bp 恰好为 0/null，
   而演示/缺失数据里 bp 是个约等于 0 的极小非零值（0.29 USD 对 15M 收入），相除得到有限但荒唐的数，
   isFinite 也拦不住。这个值还会流进 AI 回答与导出，所以必须在源头判掉，不能只改显示。
   判据用**相对量**：分母不足分子的千分之一 ⇒ 达成率无意义，按「没有 BP」处理返回 null（下游一律显「—」）。
   注意：这不是改口径，是拒绝报一个没有意义的比值——与全局口径 6「缺数不补零」同规。 */
function attainRate(num, den){
  if(den==null || num==null || !isFinite(den) || !isFinite(num)) return null;
  if(den===0) return null;
  if(Math.abs(den) < Math.abs(num)/1000) return null;   // 分母塌缩：比率会突破 100000%，必是数据缺失/单位错
  const r = num/den;
  return isFinite(r) ? r : null;
}
function normM(v){ let n = +v; if(!isFinite(n) || n<=0) return null; if(n>=190001) n = n%100; if(n<1||n>12) return null; return Math.round(n); }
const { isSubtotal, finUnitScale, isQtyMetric } = C;

// 数量单位归一(与金额 finUnitScale 平行)：实际/预测/BP 的数量可能不同单位(台/万/百万)。
// 不传 finQtyUnits 时乘子=1(不缩放，保持既有测试与同单位数据不变)。返回按 src [0=实际,1=预测,2=BP]。
const FIN_QTY_MULT = { '台':1,'个':1,'件':1,'pcs':1,'1':1,'原值':1, '千':1e3,'千台':1e3, '万':1e4,'万台':1e4,'万个':1e4, '百万':1e6,'百万台':1e6,'M':1e6 };
function finQtyScale(p){
  const u=(p&&p.finQtyUnits)||{};
  const pick=v=>{ if(v==null||v==='') return 1; const m=FIN_QTY_MULT[v]; return (m!=null)?m:1; };
  return [ pick(u.actual), pick(u.forecast), pick(u.bp) ];
}
// 仅用于 财经↔PSI 名称容错匹配(底表命名不一致)。不改 PSI 看板/其它模块。
// 国家办: 去 国家办/终端事业部/总部 后缀 + 去"-其他"，按地名核心匹配(巴西国家办≈巴西终端事业部)。
const finPsiRepNorm  = s => String(s==null?'':s).trim().replace(/(终端事业部|国家办|总部)$/,'').replace(/[-－]?其他$/,'').trim();
// 产品系列/产品: 去空格、小写、去尾部 系列/Series。
const finPsiNameNorm = s => String(s==null?'':s).trim().replace(/\s+/g,'').toLowerCase().replace(/(系列|series)$/i,'');
// NSIP 分母(收入量)的 metric code 集合 — 跨表名：实际=收入量_终端,预测/BP=收入量,均计入各自来源。
//  · 显式 p.nsipMetric(且在 metrics 中)→ 尊重覆盖,只取该名一码;
//  · 否则按 /收入量(_终端)?/ 全量匹配集合(真实底表跨表名场景);
//  · 集合为空(如 demo/旧数据只有 Sell in量,无"收入量")→ 回退到已解析的 NSIPQ 代表名单码。
function nsipDenomCodes(F, fm, override, resolvedName){
  const set=new Set();
  if(override && fm && fm.metrics && fm.metrics.includes(override)){
    const c=F.dimIndex.metric.get(override); if(c!==undefined) set.add(c); return set;
  }
  F.dimDict.metric.forEach((name,code)=>{ if(/收入量(_终端)?/.test(name)) set.add(code); });
  if(set.size===0 && resolvedName){ const c=F.dimIndex.metric.get(resolvedName); if(c!==undefined) set.add(c); }
  return set;
}

// 单指标：按维度分组算 实际/预测/去年同期/达成率/同比 + 月度序列
C.Engine.prototype.finance = function(p){
    const empty={rows:[],total:null,months:[],series:null,curYear:0,prevYear:0};
    if(!this.hasFin) return empty;
    const F=this.fin, fm=this.finMeta;
    const gd=p.groupDim||'rep'; const gCode=F.dimCode[gd], gDict=F.dimDict[gd]; if(!gCode) return empty;
    const metric=p.metric; const metricCode=F.dimIndex.metric.get(metric);
    const ay=fm.actualYears||fm.years; const curYear=p.year||ay[ay.length-1]||0; const prevYear=curYear-1;
    const fromM=normM(p.fromM)||1, toM=normM(p.toM)||12; const inRange=m=>m>=fromM&&m<=toM;
    const version=p.version||(fm.versions[0]); const versionCode=F.dimIndex.version.get(version);
    const brandCodes=this._finBrandCodes(p.brands), bCode=F.dimCode.brand;
    const gSub=new Set(); gDict.forEach((v,c)=>{ if(v===''||isSubtotal(v)) gSub.add(c); });
    const months=[]; for(let m=fromM;m<=toM;m++) months.push(m); const mIdx={}; months.forEach((m,i)=>mIdx[m]=i);
    const G=new Map(); const tot={actual:0,forecast:0,prev:0};
    const sActual=months.map(()=>0), sFc=months.map(()=>0), sPrev=months.map(()=>0);
    if(metricCode!==undefined){
      const sArr=F.src, ymArr=F.ym, vArr=F.val, mArr=F.dimCode.metric, verArr=F.dimCode.version;
      const US=finUnitScale(p), QS=finQtyScale(p), qty=isQtyMetric(metric);   // 金额按金额单位归一;数量按数量单位归一
      for(let i=0;i<F.n;i++){
        if(mArr[i]!==metricCode) continue;
        if(brandCodes && !brandCodes.has(bCode[i])) continue;
        const gc=gCode[i]; if(gSub.has(gc)) continue;
        const y=ymArr[i], yy=Math.floor(y/100), mm=y%100, v=(vArr[i]||0)*(qty?QS[sArr[i]]:US[sArr[i]]);
        let rec=G.get(gc); if(!rec){ rec={actual:0,forecast:0,prev:0}; G.set(gc,rec); }
        if(sArr[i]===0){
          if(yy===curYear && inRange(mm)){ rec.actual+=v; tot.actual+=v; sActual[mIdx[mm]]+=v; }
          else if(yy===prevYear && inRange(mm)){ rec.prev+=v; tot.prev+=v; sPrev[mIdx[mm]]+=v; }
        } else if(sArr[i]===1 && versionCode!==undefined && verArr[i]===versionCode && yy===curYear && inRange(mm)){ rec.forecast+=v; tot.forecast+=v; sFc[mIdx[mm]]+=v; }
      }
    }
    const mk=o=>({actual:o.actual,forecast:o.forecast,prev:o.prev,
      attain:attainRate(o.actual,o.forecast), yoy:o.prev!==0?(o.actual-o.prev)/o.prev:null});
    const rows=[]; G.forEach((o,gc)=>{ const m=mk(o); m.key=gDict[gc]; rows.push(m); });
    rows.sort((a,b)=>b.actual-a.actual);
    const total=mk(tot); total.key='合计';
    return {rows,total,months:months.map(m=>m+'月'),
      series:{actual:sActual,forecast:sFc,prev:sPrev}, curYear,prevYear,metric,version};
  }
  // KPI：一次过算几个核心指标的合计
C.Engine.prototype.financeKpi = function(p){
    if(!this.hasFin) return {};
    const F=this.fin, fm=this.finMeta;
    const want=p.metrics||['净销售收入','销售毛利','贡献利润','Sell out量','Sell in量'];
    const wantCode=new Map(); want.forEach(m=>{ const c=F.dimIndex.metric.get(m); if(c!==undefined) wantCode.set(c,m); });
    const ay=fm.actualYears||fm.years; const curYear=p.year||ay[ay.length-1]||0, prevYear=curYear-1;
    const fromM=normM(p.fromM)||1,toM=normM(p.toM)||12; const inRange=m=>m>=fromM&&m<=toM;
    const version=p.version||(fm.versions[0]); const versionCode=F.dimIndex.version.get(version);
    const brandCodes=this._finBrandCodes(p.brands), bCode=F.dimCode.brand;
    const acc={}; want.forEach(m=>acc[m]={actual:0,forecast:0,prev:0});
    const sArr=F.src, ymArr=F.ym, vArr=F.val, mArr=F.dimCode.metric, verArr=F.dimCode.version;
    const US=finUnitScale(p), QS=finQtyScale(p);   // 金额按金额单位归一;数量按数量单位归一
    for(let i=0;i<F.n;i++){
      const mname=wantCode.get(mArr[i]); if(!mname) continue;
      if(brandCodes && !brandCodes.has(bCode[i])) continue;
      const y=ymArr[i], yy=Math.floor(y/100), mm=y%100, v=(vArr[i]||0)*(isQtyMetric(mname)?QS[sArr[i]]:US[sArr[i]]);
      if(sArr[i]===0){ if(yy===curYear&&inRange(mm)) acc[mname].actual+=v; else if(yy===prevYear&&inRange(mm)) acc[mname].prev+=v; }
      else if(sArr[i]===1 && versionCode!==undefined && verArr[i]===versionCode && yy===curYear&&inRange(mm)) acc[mname].forecast+=v;
    }
    return acc;
  }

  // 经营达成报表：国家办达成 + BY系列(拉美整体 + 各国家办)。
  // 口径：收入=净销售收入；销毛额=销售毛利；销毛率=销毛额/收入；
  // 1~N月(N=今年最新实际月)的去年同期/今年实际，全年预测=收入(选定版本,全12月)，达成率=今年1~N月收入/全年预测。
C.Engine.prototype.financeAchieve = function(p){
    p=p||{};
    if(!this.hasFin) return null;
    const fm=this.finMeta;
    const ay=fm.actualYears||fm.years; const curYear=p.year||ay[ay.length-1]||0; const prevYear=curYear-1;
    const version=p.version||(fm.versions[0]||'默认');
    const pick=(re,def)=>{
      if(def && fm.metrics.includes(def)) return def;                       // 优先精确标准名(销售毛利/净销售收入),避免误选 销售毛利率 / 销售毛利(不含中期激励)
      const ms=fm.metrics.filter(x=>re.test(x)); if(!ms.length) return null;
      const clean=ms.filter(x=>!/率$/.test(x) && !/[（(]/.test(x));          // 排除"…率"结尾 和 带括号的变体
      return clean[0]||ms[0];
    };
    // 可手动指定 收入/销毛额 指标(p.revMetric/p.gmMetric)，否则自动识别
    const ov=(o,re,def)=>(o && fm.metrics.includes(o)) ? o : pick(re,def);
    const REV=ov(p.revMetric, /净销售收入|营业收入|销售收入|^收入$/, '净销售收入');
    const GM =ov(p.gmMetric,  /销售毛利|毛利额|销毛额|^销售毛利|^毛利$/, '销售毛利');
    // Sell-in 量(NSIP 分母)：自动识别，可由 p.nsipMetric 覆盖
    const NSIPQ=ov(p.nsipMetric, /Sell\s*in量|收入量(_终端)?/, 'Sell in量');
    // 系列层级(默认 lv2，可由 p.seriesLevel 指定)
    const lvKeys=['lv1','lv2','lv3','lv4'].filter(k=>fm.dims.includes(k));
    // Acme产品层级里"系列"通常是 lv3(如 Slate Tab/Astra系列/TWS基础系列)；默认优先 lv3
    const seriesKey = (p.seriesLevel&&lvKeys.includes(p.seriesLevel)) ? p.seriesLevel : (lvKeys.includes('lv3')?'lv3':(lvKeys.includes('lv2')?'lv2':(lvKeys[0]||'lv1')));
    const F=this.fin;
    const repDict=F.dimDict.rep, sDict=F.dimDict[seriesKey], repCodeArr=F.dimCode.rep, serCodeArr=F.dimCode[seriesKey];
    const repSub=new Set(); repDict.forEach((v,c)=>{ if(isSubtotal(v)) repSub.add(c); });
    const serSub=new Set(); sDict.forEach((v,c)=>{ if(isSubtotal(v)) serSub.add(c); });
    const revCode=F.dimIndex.metric.get(REV), gmCode=GM?F.dimIndex.metric.get(GM):undefined;
    // NSIP 分母(收入量)：跨表名集合 — 实际=收入量_终端,预测/BP=收入量;显式 p.nsipMetric 时尊重覆盖。
    const nsipCodes=nsipDenomCodes(F, fm, p.nsipMetric, NSIPQ);
    const versionCode=F.dimIndex.version.get(version);
    const brandCodes=this._finBrandCodes(p.brands), bCode=F.dimCode.brand;
    const sArr=F.src, ymArr=F.ym, vArr=F.val, mArr=F.dimCode.metric, verArr=F.dimCode.version;
    const lv1Arr=F.dimCode.lv1, lv1Dict=F.dimDict.lv1;
    // 产业(产品LV1)清单 + 选中过滤(音频与智能配件/平板)
    const industries=[]; if(lv1Dict){ const seen=new Set(); lv1Dict.forEach((v,c)=>{ if(v&&!isSubtotal(v)&&!seen.has(v)){ seen.add(v); industries.push(v); } }); }
    let indCodes=null; if(p.industry && p.industry.length && lv1Dict){ indCodes=new Set(); p.industry.forEach(v=>{ const c=F.dimIndex.lv1.get(v); if(c!==undefined) indCodes.add(c); }); }
    // 月份范围 fromM~toM；toM 缺省=今年最新实际月。实际按区间累计；同比去年取同一区间；全年预测取全12月。
    let latestAct=0; for(let i=0;i<F.n;i++){ if(sArr[i]===0 && Math.floor(ymArr[i]/100)===curYear){ const mm=ymArr[i]%100; if(mm>latestAct)latestAct=mm; } }
    if(!latestAct) latestAct=12;
    let fromM=Math.max(1,Math.min(12, normM(p.fromM)||1));
    let toM = normM(p.toM)? Math.max(1,Math.min(12,normM(p.toM))) : latestAct;
    if(toM<fromM) toM=fromM;
    const cutoff=toM;   // 兼容旧字段名
    // ra/ga/si* = 收入/销毛/Sell-in量；25=去年同期 26=今年实际(均月份区间) rfc=全年预测收入(全12月)
    // revFc/gmFc/siFc = 区间内预测(src1,版本匹配,mm∈[fromM,toM])
    const node=()=>({ra25:0,ra26:0,rfc:0,ga25:0,ga26:0,si25:0,si26:0,revFc:0,gmFc:0,siFc:0});
    const acc=new Map(); // rep -> Map(series -> node)
    const getNode=(rep,ser)=>{ let m=acc.get(rep); if(!m){m=new Map();acc.set(rep,m);} let n=m.get(ser); if(!n){n=node();m.set(ser,n);} return n; };
    const inRange=mm=>mm>=fromM&&mm<=toM;
    const US=finUnitScale(p), QS=finQtyScale(p);   // 金额按金额单位归一,数量按数量单位归一,避免跨来源达成率被单位放大
    for(let i=0;i<F.n;i++){
      const mc=mArr[i]; const isRev=(mc===revCode), isGm=(gmCode!==undefined && mc===gmCode), isSi=nsipCodes.has(mc); if(!isRev&&!isGm&&!isSi) continue;
      if(brandCodes && !brandCodes.has(bCode[i])) continue;
      if(indCodes && !indCodes.has(lv1Arr[i])) continue;
      const rc=repCodeArr[i], sc=serCodeArr[i]; if(repSub.has(rc)||serSub.has(sc)) continue;
      const rep=repDict[rc]||'(未分配)', ser=sDict[sc]||'(未分类)';
      const y=ymArr[i], yy=Math.floor(y/100), mm=y%100, v=(vArr[i]||0)*(isSi?QS[sArr[i]]:US[sArr[i]]);  // si是数量,按数量单位归一;rev/gm金额归一
      const node2=getNode(rep,ser);
      if(sArr[i]===0){
        if(inRange(mm)){
          if(yy===prevYear){ if(isRev)node2.ra25+=v; else if(isGm)node2.ga25+=v; else node2.si25+=v; }
          else if(yy===curYear){ if(isRev)node2.ra26+=v; else if(isGm)node2.ga26+=v; else node2.si26+=v; }
        }
      } else if(sArr[i]===1 && yy===curYear && versionCode!==undefined && verArr[i]===versionCode){
        if(isRev) node2.rfc+=v;                 // 全年预测收入(全12月)
        if(inRange(mm)){ if(isRev)node2.revFc+=v; else if(isGm)node2.gmFc+=v; else node2.siFc+=v; }  // 区间预测
      }
    }
    const mkRow=(key,a)=>{
      const nsip25=a.si25?a.ra25/a.si25:null, nsip26=a.si26?a.ra26/a.si26:null;
      return { key,
        rev25:a.ra25, rev26:a.ra26, revYoy:a.ra25?(a.ra26-a.ra25)/a.ra25:null,
        gm25:a.ga25, gm26:a.ga26, gmYoy:a.ga25?(a.ga26-a.ga25)/a.ga25:null,
        gmr25:a.ra25?a.ga25/a.ra25:null, gmr26:a.ra26?a.ga26/a.ra26:null,
        gmrDiff:(a.ra25&&a.ra26)?(a.ga26/a.ra26 - a.ga25/a.ra25):null,
        // Sell-in 量 + NSIP(收入/量)
        si25:a.si25, si26:a.si26,
        nsip25, nsip26, nsipYoy:nsip25?(nsip26-nsip25)/nsip25:null,
        // 区间预测 + 预测口径派生
        revFc:a.revFc, gmFc:a.gmFc, siFc:a.siFc,
        attainFc:attainRate(a.revFc,a.rfc),                 // 区间累计预测收入 ÷ 全年预测收入
        nsipFc:a.siFc?a.revFc/a.siFc:null,                 // 预测口径 NSIP
        gmrFc:a.revFc?a.gmFc/a.revFc:null,                 // 预测口径销毛率
        fcRev:a.rfc,                                       // 全年预测收入(显式)
        fc:a.rfc, attain:attainRate(a.ra26,a.rfc) };        // 既有字段保留
    };
    const sumNodes=arr=>{ const t=node(); arr.forEach(n=>{t.ra25+=n.ra25;t.ra26+=n.ra26;t.rfc+=n.rfc;t.ga25+=n.ga25;t.ga26+=n.ga26;t.si25+=n.si25;t.si26+=n.si26;t.revFc+=n.revFc;t.gmFc+=n.gmFc;t.siFc+=n.siFc;}); return t; };
    const reps=[...acc.keys()];
    const repAgg={}; reps.forEach(rep=>repAgg[rep]=sumNodes([...acc.get(rep).values()]));
    const regionAgg=sumNodes(reps.map(rep=>repAgg[rep]));
    // 国家办达成表(按今年收入降序)
    const repTableRows=reps.map(rep=>mkRow(rep,repAgg[rep])).sort((a,b)=>b.rev26-a.rev26);
    // 拉美整体 BY系列
    const serAgg=new Map();
    reps.forEach(rep=>acc.get(rep).forEach((n,ser)=>{ let s=serAgg.get(ser); if(!s){s=node();serAgg.set(ser,s);} s.ra25+=n.ra25;s.ra26+=n.ra26;s.rfc+=n.rfc;s.ga25+=n.ga25;s.ga26+=n.ga26;s.si25+=n.si25;s.si26+=n.si26;s.revFc+=n.revFc;s.gmFc+=n.gmFc;s.siFc+=n.siFc; }));
    const regionSeriesRows=[...serAgg.keys()].map(ser=>mkRow(ser,serAgg.get(ser)));
    // 各国家办 BY系列
    const repSeries=repTableRows.map(rt=>({ rep:rt.key, total:rt,
      rows:[...acc.get(rt.key).keys()].map(ser=>mkRow(ser,acc.get(rt.key).get(ser))) }));
    return {
      curYear, prevYear, cutoff, fromM, toM, latestAct, version, seriesKey, seriesLevels:lvKeys,
      industries, curIndustry:(p.industry&&p.industry.length?p.industry.slice():null),
      revMetric:REV, gmMetric:GM, nsipMetric:NSIPQ, hasRev:!!REV, hasGm:!!GM, hasSi:!!NSIPQ,
      regionRow:mkRow('拉美整体',regionAgg), repTableRows, regionSeriesRows, repSeries };
  }

  // 产业产品经营看板(4 表)：本质=financeAchieve 按产品维重新分组 + BP/预测全年收入两列。
  // 口径全部沿用 financeAchieve：收入/销毛/Sell-in量自动识别；金额按来源单位归一,数量不缩放;剔除小计行。
  //   rev25/rev26(区间) → revYoy；gm 同；gmr=gm/rev(率)；nsip=rev/si(si=Sell-in量收入量)。
  //   bp=全年BP收入(src2,BP版本)、bpAttain=rev26/bp；fc=全年预测收入(src1,选定版本)、fcAttain=rev26/fc。
  // 分组：line=lv1(产业)；famTablet/famAudio=lv3(系列,按 lv1 限定)；lv4=lv4(产品)。
  // 受 p.reps + p.lv1..lv4 顶部筛选联动(名称集,与 financeOverview 财经侧一致);各组 total=组内明细汇总。
  C.Engine.prototype.financeProductBoard = function(p){
    p=p||{};
    if(!this.hasFin) return null;
    const F=this.fin, fm=this.finMeta;
    const ay=fm.actualYears||fm.years; const curYear=p.year||ay[ay.length-1]||0; const prevYear=curYear-1;
    const version=p.version||(fm.versions[0]||'默认');
    const versionCode=F.dimIndex.version.get(version);
    const bpVersion=(p.bpVersion&&fm.bpVersions.includes(p.bpVersion))?p.bpVersion
      :(fm.bpVersions.includes('国家办工作底稿')?'国家办工作底稿':(fm.bpVersions[0]||'默认'));
    const bpVerCode=F.dimIndex.version.get(bpVersion);
    // 指标识别(沿用 financeAchieve 的 pick/ov)：收入/销毛额/Sell-in量(NSIP 分母=收入量)
    const pick=(re,def)=>{
      if(def && fm.metrics.includes(def)) return def;                       // 优先精确标准名(销售毛利/净销售收入),避免误选 销售毛利率 / 销售毛利(不含中期激励)
      const ms=fm.metrics.filter(x=>re.test(x)); if(!ms.length) return null;
      const clean=ms.filter(x=>!/率$/.test(x) && !/[（(]/.test(x));          // 排除"…率"结尾 和 带括号的变体
      return clean[0]||ms[0];
    };
    const ov=(o,re,def)=>(o && fm.metrics.includes(o)) ? o : pick(re,def);
    const REV =ov(p.revMetric,  /净销售收入|营业收入|销售收入|^收入$/, '净销售收入');
    const GM  =ov(p.gmMetric,   /销售毛利|毛利额|销毛额|^销售毛利|^毛利$/, '销售毛利');
    const NSIPQ=ov(p.nsipMetric, /Sell\s*in量|收入量(_终端)?/, 'Sell in量');
    const revCode=REV?F.dimIndex.metric.get(REV):undefined, gmCode=GM?F.dimIndex.metric.get(GM):undefined;
    // NSIP 分母(收入量)：跨表名集合 — 实际=收入量_终端,预测/BP=收入量;显式 p.nsipMetric 时尊重覆盖。
    const nsipCodes=nsipDenomCodes(F, fm, p.nsipMetric, NSIPQ);
    const brandCodes=this._finBrandCodes(p.brands), bCode=F.dimCode.brand;
    const sArr=F.src, ymArr=F.ym, vArr=F.val, mArr=F.dimCode.metric, verArr=F.dimCode.version;
    // 月份区间：fromM~toM(toM 缺省=今年最新实际月)。实际取区间，去年同区间，BP/预测取全年。
    let latestAct=0; for(let i=0;i<F.n;i++){ if(sArr[i]===0 && Math.floor(ymArr[i]/100)===curYear){ const mm=ymArr[i]%100; if(mm>latestAct)latestAct=mm; } }
    if(!latestAct) latestAct=12;
    let fromM=Math.max(1,Math.min(12,normM(p.fromM)||1));
    let toM=normM(p.toM)?Math.max(1,Math.min(12,normM(p.toM))):latestAct; if(toM<fromM) toM=fromM;
    const inRange=mm=>mm>=fromM&&mm<=toM;
    // 维度 code/dict + 小计集(lv1/lv3/lv4/rep)；空串 lv4 是合法叶子,不当小计剔除
    const lv1Arr=F.dimCode.lv1, lv1Dict=F.dimDict.lv1;
    const lv3Arr=F.dimCode.lv3, lv3Dict=F.dimDict.lv3;
    const lv4Arr=F.dimCode.lv4, lv4Dict=F.dimDict.lv4;
    const lv2Arr=F.dimCode.lv2, lv2Dict=F.dimDict.lv2;
    const repArr=F.dimCode.rep, repDict=F.dimDict.rep;
    const mkSub=(dict,keepEmpty)=>{ const s=new Set(); if(dict) dict.forEach((v,c)=>{ if(isSubtotal(v)||(!keepEmpty&&v==='')) s.add(c); }); return s; };
    const repSub=mkSub(repDict,false);
    const lv1Sub=mkSub(lv1Dict,false), lv2Sub=mkSub(lv2Dict,false), lv3Sub=mkSub(lv3Dict,false);
    const lv4Sub=mkSub(lv4Dict,true);   // lv4 全空时空串为唯一叶子,保留
    // 顶部筛选(名称集，与 financeOverview 财经侧一致)：rep + lv1~lv4
    const repSel=p.reps&&p.reps.length?new Set(p.reps):null;
    const lvSel={
      lv1:p.lv1&&p.lv1.length?new Set(p.lv1):null, lv2:p.lv2&&p.lv2.length?new Set(p.lv2):null,
      lv3:p.lv3&&p.lv3.length?new Set(p.lv3):null, lv4:p.lv4&&p.lv4.length?new Set(p.lv4):null };
    const US=finUnitScale(p), QS=finQtyScale(p);   // 金额按金额单位归一;数量按数量单位归一
    // 节点：rev/gm/si 区间 25/26 + 全年 fc(预测收入)/bp(BP收入)
    const node=()=>({ra25:0,ra26:0,ga25:0,ga26:0,si25:0,si26:0,fc:0,bp:0});
    const lineAcc=new Map(), tabAcc=new Map(), audAcc=new Map(), lv4Acc=new Map();
    const get=(acc,k)=>{ let n=acc.get(k); if(!n){n=node();acc.set(k,n);} return n; };
    for(let i=0;i<F.n;i++){
      const mc=mArr[i]; const isRev=(mc===revCode), isGm=(gmCode!==undefined&&mc===gmCode), isSi=nsipCodes.has(mc);
      if(!isRev&&!isGm&&!isSi) continue;
      if(brandCodes && !brandCodes.has(bCode[i])) continue;
      // 小计/空行剔除(rep + lv1~lv4)
      const rc=repArr[i], c1=lv1Arr[i], c2=lv2Arr[i], c3=lv3Arr[i], c4=lv4Arr[i];
      if(repSub.has(rc)||lv1Sub.has(c1)||lv2Sub.has(c2)||lv3Sub.has(c3)||lv4Sub.has(c4)) continue;
      // 顶部筛选(名称集)
      if(repSel && !repSel.has(repDict[rc])) continue;
      if(lvSel.lv1 && !lvSel.lv1.has(lv1Dict[c1])) continue;
      if(lvSel.lv2 && !lvSel.lv2.has(lv2Dict[c2])) continue;
      if(lvSel.lv3 && !lvSel.lv3.has(lv3Dict[c3])) continue;
      if(lvSel.lv4 && !lvSel.lv4.has(lv4Dict[c4])) continue;
      const s=sArr[i], y=ymArr[i], yy=Math.floor(y/100), mm=y%100;
      const v=(vArr[i]||0)*(isSi?QS[s]:US[s]);   // si 数量按数量单位归一;rev/gm 金额归一
      // 命中字段：实际区间(25/26 的 rev/gm/si) | 全年预测收入 | 全年BP收入
      let bucketFld=null, fc=false, bp=false;
      if(s===0){ if(inRange(mm)){ if(yy===prevYear) bucketFld='25'; else if(yy===curYear) bucketFld='26'; } }
      else if(s===1){ if(isRev && yy===curYear && versionCode!==undefined && verArr[i]===versionCode) fc=true; }
      else if(s===2){ if(isRev && yy===curYear && bpVerCode!==undefined && verArr[i]===bpVerCode) bp=true; }
      if(!bucketFld && !fc && !bp) continue;
      const lv1Name=lv1Dict[c1]||'(未分类)', lv3Name=lv3Dict[c3]||'(未分类)', lv4Name=lv4Dict[c4]||'(未分类)';
      const isTab=(lv1Name==='平板'), isAud=/音频/.test(lv1Name);
      const apply=n=>{
        if(bucketFld){ if(isRev)n['ra'+bucketFld]+=v; else if(isGm)n['ga'+bucketFld]+=v; else n['si'+bucketFld]+=v; }
        if(fc) n.fc+=v; if(bp) n.bp+=v;
      };
      apply(get(lineAcc,lv1Name));
      if(isTab) apply(get(tabAcc,lv3Name));
      if(isAud) apply(get(audAcc,lv3Name));
      apply(get(lv4Acc,lv4Name));
    }
    const mkRow=(key,a)=>{
      const nsip25=a.si25?a.ra25/a.si25:null, nsip26=a.si26?a.ra26/a.si26:null;
      return { key,
        rev25:a.ra25, rev26:a.ra26, revYoy:a.ra25?(a.ra26-a.ra25)/a.ra25:null,
        gm25:a.ga25, gm26:a.ga26, gmYoy:a.ga25?(a.ga26-a.ga25)/a.ga25:null,
        gmr25:a.ra25?a.ga25/a.ra25:null, gmr26:a.ra26?a.ga26/a.ra26:null,
        nsip25, nsip26, nsipYoy:(nsip25!=null&&nsip26!=null)?(nsip26-nsip25):null,   // NSIP同比=绝对USD差(单价同比看产品结构升降)
        bp:a.bp, bpAttain:attainRate(a.ra26,a.bp),
        fc:a.fc, fcAttain:attainRate(a.ra26,a.fc) };
    };
    const sumNodes=arr=>{ const t=node(); arr.forEach(n=>{ t.ra25+=n.ra25;t.ra26+=n.ra26;t.ga25+=n.ga25;t.ga26+=n.ga26;t.si25+=n.si25;t.si26+=n.si26;t.fc+=n.fc;t.bp+=n.bp; }); return t; };
    const build=(acc,totKey)=>{
      const rows=[...acc.entries()].map(([k,n])=>mkRow(k,n)).sort((a,b)=>b.rev26-a.rev26);
      const total=mkRow(totKey,sumNodes([...acc.values()]));
      return {rows,total};
    };
    const cols=[
      {key:'rev25',label:'25年收入'},{key:'rev26',label:'26年收入'},{key:'revYoy',label:'收入同比'},
      {key:'gm25',label:'25年销毛额'},{key:'gm26',label:'26年销毛额'},{key:'gmYoy',label:'销毛额同比'},
      {key:'gmr25',label:'25年销毛率'},{key:'gmr26',label:'26年销毛率'},
      {key:'nsip25',label:'25年NSIP'},{key:'nsip26',label:'26年NSIP'},
      {key:'bp',label:'全年BP'},{key:'bpAttain',label:'BP达成率'},
      {key:'fc',label:'全年预测'},{key:'fcAttain',label:'预测达成率'} ];
    return {
      curYear, prevYear, fromM, toM, version, bpVersion,
      revMetric:REV, gmMetric:GM, nsipMetric:NSIPQ,
      line:build(lineAcc,'合计'), famTablet:build(tabAcc,'平板合计'),
      famAudio:build(audAcc,'音频合计'), lv4:build(lv4Acc,'合计'), cols };
  }

  // 国家办维度三表：与 financeProductBoard 同口径同聚合,改按 rep/lv3/lv4 分组,国家办整体表加 NSIP同比列。
  //   rev/gm/gmr/nsip 区间25/26；nsipYoy=(nsip26-nsip25)/nsip25；bp=全年BP收入(src2,BP版本)、fc=全年预测收入(src1,选定版本)。
  // 参数为本块独立筛选 p={year,fromM,toM,version,reps,series,finUnits}：reps=国家办名称集(空=全部);series=产品系列lv3名称集(空=全部)。
  //   repTable=分国家办(各 rep);repSeries=分产品系列lv3(受 reps 限定);lv4=分产品lv4(受 reps 限定)。各组 total=组内明细汇总,剔除小计。
  C.Engine.prototype.financeRepBoard = function(p){
    p=p||{};
    if(!this.hasFin) return null;
    const F=this.fin, fm=this.finMeta;
    const ay=fm.actualYears||fm.years; const curYear=p.year||ay[ay.length-1]||0; const prevYear=curYear-1;
    const version=p.version||(fm.versions[0]||'默认');
    const versionCode=F.dimIndex.version.get(version);
    const bpVersion=(p.bpVersion&&fm.bpVersions.includes(p.bpVersion))?p.bpVersion
      :(fm.bpVersions.includes('国家办工作底稿')?'国家办工作底稿':(fm.bpVersions[0]||'默认'));
    const bpVerCode=F.dimIndex.version.get(bpVersion);
    // 指标识别(沿用 financeProductBoard)：收入/销毛额/Sell-in量(NSIP 分母=收入量)
    const pick=(re,def)=>{
      if(def && fm.metrics.includes(def)) return def;                       // 优先精确标准名(销售毛利/净销售收入),避免误选 销售毛利率 / 销售毛利(不含中期激励)
      const ms=fm.metrics.filter(x=>re.test(x)); if(!ms.length) return null;
      const clean=ms.filter(x=>!/率$/.test(x) && !/[（(]/.test(x));          // 排除"…率"结尾 和 带括号的变体
      return clean[0]||ms[0];
    };
    const ov=(o,re,def)=>(o && fm.metrics.includes(o)) ? o : pick(re,def);
    const REV =ov(p.revMetric,  /净销售收入|营业收入|销售收入|^收入$/, '净销售收入');
    const GM  =ov(p.gmMetric,   /销售毛利|毛利额|销毛额|^销售毛利|^毛利$/, '销售毛利');
    const NSIPQ=ov(p.nsipMetric, /Sell\s*in量|收入量(_终端)?/, 'Sell in量');
    const revCode=REV?F.dimIndex.metric.get(REV):undefined, gmCode=GM?F.dimIndex.metric.get(GM):undefined;
    // NSIP 分母(收入量)：跨表名集合 — 实际=收入量_终端,预测/BP=收入量;显式 p.nsipMetric 时尊重覆盖。
    const nsipCodes=nsipDenomCodes(F, fm, p.nsipMetric, NSIPQ);
    const brandCodes=this._finBrandCodes(p.brands), bCode=F.dimCode.brand;
    const sArr=F.src, ymArr=F.ym, vArr=F.val, mArr=F.dimCode.metric, verArr=F.dimCode.version;
    // 月份区间：fromM~toM(toM 缺省=今年最新实际月)。实际取区间,去年同区间,BP/预测取全年。
    let latestAct=0; for(let i=0;i<F.n;i++){ if(sArr[i]===0 && Math.floor(ymArr[i]/100)===curYear){ const mm=ymArr[i]%100; if(mm>latestAct)latestAct=mm; } }
    if(!latestAct) latestAct=12;
    let fromM=Math.max(1,Math.min(12,normM(p.fromM)||1));
    let toM=normM(p.toM)?Math.max(1,Math.min(12,normM(p.toM))):latestAct; if(toM<fromM) toM=fromM;
    const inRange=mm=>mm>=fromM&&mm<=toM;
    // 维度 code/dict + 小计集(rep/lv3/lv4)；空串 lv4 是合法叶子,不当小计剔除
    const lv3Arr=F.dimCode.lv3, lv3Dict=F.dimDict.lv3;
    const lv4Arr=F.dimCode.lv4, lv4Dict=F.dimDict.lv4;
    const repArr=F.dimCode.rep, repDict=F.dimDict.rep;
    const mkSub=(dict,keepEmpty)=>{ const s=new Set(); if(dict) dict.forEach((v,c)=>{ if(isSubtotal(v)||(!keepEmpty&&v==='')) s.add(c); }); return s; };
    const repSub=mkSub(repDict,false), lv3Sub=mkSub(lv3Dict,false);
    const lv4Sub=mkSub(lv4Dict,true);   // lv4 全空时空串为唯一叶子,保留
    // 本块独立筛选(名称集)：reps(国家办) + series(产品系列 lv3)
    const repSel=p.reps&&p.reps.length?new Set(p.reps):null;
    const serSel=p.series&&p.series.length?new Set(p.series):null;
    const US=finUnitScale(p), QS=finQtyScale(p);   // 金额按金额单位归一;数量按数量单位归一
    // 节点：rev/gm/si 区间 25/26 + 全年 fc(预测收入)/bp(BP收入)
    const node=()=>({ra25:0,ra26:0,ga25:0,ga26:0,si25:0,si26:0,fc:0,bp:0});
    const repAcc=new Map(), serAcc=new Map(), lv4Acc=new Map();
    const get=(acc,k)=>{ let n=acc.get(k); if(!n){n=node();acc.set(k,n);} return n; };
    for(let i=0;i<F.n;i++){
      const mc=mArr[i]; const isRev=(mc===revCode), isGm=(gmCode!==undefined&&mc===gmCode), isSi=nsipCodes.has(mc);
      if(!isRev&&!isGm&&!isSi) continue;
      if(brandCodes && !brandCodes.has(bCode[i])) continue;
      // 小计/空行剔除(rep + lv3 + lv4)
      const rc=repArr[i], c3=lv3Arr[i], c4=lv4Arr[i];
      if(repSub.has(rc)||lv3Sub.has(c3)||lv4Sub.has(c4)) continue;
      // 本块筛选(名称集)：reps + series(lv3)
      if(repSel && !repSel.has(repDict[rc])) continue;
      if(serSel && !serSel.has(lv3Dict[c3])) continue;
      const s=sArr[i], y=ymArr[i], yy=Math.floor(y/100), mm=y%100;
      const v=(vArr[i]||0)*(isSi?QS[s]:US[s]);   // si 数量按数量单位归一;rev/gm 金额归一
      // 命中字段：实际区间(25/26 的 rev/gm/si) | 全年预测收入 | 全年BP收入
      let bucketFld=null, fc=false, bp=false;
      if(s===0){ if(inRange(mm)){ if(yy===prevYear) bucketFld='25'; else if(yy===curYear) bucketFld='26'; } }
      else if(s===1){ if(isRev && yy===curYear && versionCode!==undefined && verArr[i]===versionCode) fc=true; }
      else if(s===2){ if(isRev && yy===curYear && bpVerCode!==undefined && verArr[i]===bpVerCode) bp=true; }
      if(!bucketFld && !fc && !bp) continue;
      const repName=repDict[rc]||'(未分配)', lv3Name=lv3Dict[c3]||'(未分类)', lv4Name=lv4Dict[c4]||'(未分类)';
      const apply=n=>{
        if(bucketFld){ if(isRev)n['ra'+bucketFld]+=v; else if(isGm)n['ga'+bucketFld]+=v; else n['si'+bucketFld]+=v; }
        if(fc) n.fc+=v; if(bp) n.bp+=v;
      };
      apply(get(repAcc,repName));   // repTable：分国家办(不受 reps 限定时为全部)
      apply(get(serAcc,lv3Name));   // repSeries：分产品系列(已受 reps/series 限定)
      apply(get(lv4Acc,lv4Name));   // lv4：分产品(已受 reps/series 限定)
    }
    const mkRow=(key,a)=>{
      const nsip25=a.si25?a.ra25/a.si25:null, nsip26=a.si26?a.ra26/a.si26:null;
      return { key,
        rev25:a.ra25, rev26:a.ra26, revYoy:a.ra25?(a.ra26-a.ra25)/a.ra25:null,
        gm25:a.ga25, gm26:a.ga26, gmYoy:a.ga25?(a.ga26-a.ga25)/a.ga25:null,
        gmr25:a.ra25?a.ga25/a.ra25:null, gmr26:a.ra26?a.ga26/a.ra26:null,
        nsip25, nsip26, nsipYoy:(nsip25!=null&&nsip26!=null)?(nsip26-nsip25):null,   // NSIP同比=绝对USD差(与产品板一致,非比率)
        bp:a.bp, bpAttain:attainRate(a.ra26,a.bp),
        fc:a.fc, fcAttain:attainRate(a.ra26,a.fc) };
    };
    const sumNodes=arr=>{ const t=node(); arr.forEach(n=>{ t.ra25+=n.ra25;t.ra26+=n.ra26;t.ga25+=n.ga25;t.ga26+=n.ga26;t.si25+=n.si25;t.si26+=n.si26;t.fc+=n.fc;t.bp+=n.bp; }); return t; };
    const build=(acc,totKey)=>{
      const rows=[...acc.entries()].map(([k,n])=>mkRow(k,n)).sort((a,b)=>b.rev26-a.rev26);
      const total=mkRow(totKey,sumNodes([...acc.values()]));
      return {rows,total};
    };
    const cols=[
      {key:'rev25',label:'25年收入'},{key:'rev26',label:'26年收入'},{key:'revYoy',label:'收入同比'},
      {key:'gm25',label:'25年销毛额'},{key:'gm26',label:'26年销毛额'},{key:'gmYoy',label:'销毛额同比'},
      {key:'gmr25',label:'25年销毛率'},{key:'gmr26',label:'26年销毛率'},
      {key:'nsip25',label:'25年NSIP'},{key:'nsip26',label:'26年NSIP'},{key:'nsipYoy',label:'NSIP同比'},
      {key:'bp',label:'全年BP'},{key:'bpAttain',label:'BP达成率'},
      {key:'fc',label:'全年预测'},{key:'fcAttain',label:'预测达成率'} ];
    return {
      curYear, prevYear, fromM, toM, version, bpVersion,
      revMetric:REV, gmMetric:GM, nsipMetric:NSIPQ,
      repTable:build(repAcc,'合计'), repSeries:build(serAcc,'合计'),
      lv4:build(lv4Acc,'合计'), cols };
  }

  // 自定义看板透视：行维度(rowDim) × 多指标(metrics) × 口径(basis)。financeProductBoard/RepBoard 的泛化。
  //   rowDim ∈ rep|lv1|lv2|lv3|lv4；metrics ⊆ rev/gm/gmr/sellIn/sellOut/nsip/bpAttain/fcAttain；basis ∈ actual|forecast|bp。
  //   口径决定 rev/gm/gmr/nsip/sellIn/sellOut 的取值来源：actual=src0当年区间;forecast=src1当年全年(选定版本);bp=src2当年全年(BP版本)。
  //   bpAttain=实际收入÷全年BP收入、fcAttain=实际收入÷全年预测收入(恒为"实际vs目标",不随 basis 变)。除零→null。
  //   sellIn/sellOut: actual 口径→PSI 真实(_psiActual,按组映射 PSI 维度);forecast/bp 口径→财经 sell in量/sell out量 目标(全年)。
  //   各组聚合后 ratio 从汇总分量重算;total=全组汇总(同样从分量重算 ratio,不取平均)。受 p.reps + p.lv1..lv4 名称集筛选,剔除小计/空行。
  C.Engine.prototype.financeCustom = function(p){
    p=p||{};
    const empty={rows:[],total:{},metrics:[],dim:(p.rowDim||'rep')};
    if(!this.hasFin) return empty;
    const F=this.fin, fm=this.finMeta;
    const ALL=['rev','gm','gmr','cp','sellIn','sellOut','nsip','bpAttain','fcAttain'];
    const sel=(p.metrics&&p.metrics.length?p.metrics:['rev']).filter(m=>ALL.includes(m));
    const rowDim=['rep','lv1','lv2','lv3','lv4','model'].includes(p.rowDim)?p.rowDim:'rep';
    const basis=['actual','forecast','bp'].includes(p.basis)?p.basis:'actual';
    const ay=fm.actualYears||fm.years; const curYear=p.year||ay[ay.length-1]||0; const prevYear=curYear-1;
    const version=p.version||(fm.versions[0]||'默认');
    const versionCode=F.dimIndex.version.get(version);
    const bpVersion=(p.bpVersion&&fm.bpVersions.includes(p.bpVersion))?p.bpVersion
      :(fm.bpVersions.includes('国家办工作底稿')?'国家办工作底稿':(fm.bpVersions[0]||'默认'));
    const bpVerCode=F.dimIndex.version.get(bpVersion);
    // 指标识别(沿用 financeProductBoard/Overview)：收入/销毛额/Sell-in量(NSIP分母=收入量) + sell-in/out 目标量
    const pick=(re,def)=>{
      if(def && fm.metrics.includes(def)) return def;                       // 优先精确标准名(销售毛利/净销售收入),避免误选 销售毛利率 / 销售毛利(不含中期激励)
      const ms=fm.metrics.filter(x=>re.test(x)); if(!ms.length) return null;
      const clean=ms.filter(x=>!/率$/.test(x) && !/[（(]/.test(x));          // 排除"…率"结尾 和 带括号的变体
      return clean[0]||ms[0];
    };
    const ov=(o,re,def)=>(o && fm.metrics.includes(o)) ? o : pick(re,def);
    const REV  =ov(p.revMetric,  /净销售收入|营业收入|销售收入|^收入$/, '净销售收入');
    const GM   =ov(p.gmMetric,   /销售毛利|毛利额|销毛额|^销售毛利|^毛利$/, '销售毛利');
    const CP   =ov(p.cpMetric,   /贡献利润/, '贡献利润'); const cpCode = CP?F.dimIndex.metric.get(CP):undefined;
    const NSIPQ=ov(p.nsipMetric, /Sell\s*in量|收入量(_终端)?/, 'Sell in量');   // NSIP 分母(财经实际收入量)
    const SI_TGT=pick(/sell\s*in量/i, 'Sell in量');                            // sell-in 目标(forecast/bp)
    const SO_TGT=pick(/sell\s*out量/i, 'Sell out量');                          // sell-out 目标(forecast/bp)
    const revCode =REV  ?F.dimIndex.metric.get(REV)  :undefined;
    const gmCode  =GM   ?F.dimIndex.metric.get(GM)   :undefined;
    // NSIP 分母(收入量)：跨表名集合 — 实际=收入量_终端,预测/BP=收入量;显式 p.nsipMetric 时尊重覆盖。
    const nsipCodes=nsipDenomCodes(F, fm, p.nsipMetric, NSIPQ);
    const siTgtCode=SI_TGT?F.dimIndex.metric.get(SI_TGT):undefined;
    const soTgtCode=SO_TGT?F.dimIndex.metric.get(SO_TGT):undefined;
    const brandCodes=this._finBrandCodes(p.brands), bCode=F.dimCode.brand;
    const sArr=F.src, ymArr=F.ym, vArr=F.val, mArr=F.dimCode.metric, verArr=F.dimCode.version;
    // 月份区间：fromM~toM(toM 缺省=今年最新实际月)。实际取区间,去年同区间,forecast/bp 取全年。
    let latestAct=0; for(let i=0;i<F.n;i++){ if(sArr[i]===0 && Math.floor(ymArr[i]/100)===curYear){ const mm=ymArr[i]%100; if(mm>latestAct)latestAct=mm; } }
    if(!latestAct) latestAct=12;
    let fromM=Math.max(1,Math.min(12,normM(p.fromM)||1));
    let toM=normM(p.toM)?Math.max(1,Math.min(12,normM(p.toM))):latestAct; if(toM<fromM) toM=fromM;
    const inRange=mm=>mm>=fromM&&mm<=toM;
    // 维度 code/dict + 小计集(rep + lv1~lv4)；空串 lv4 是合法叶子,不当小计剔除
    const lvKeys=['lv1','lv2','lv3','lv4'];
    const repArr=F.dimCode.rep, repDict=F.dimDict.rep;
    const lvArr={}, lvDict={}; lvKeys.forEach(k=>{ lvArr[k]=F.dimCode[k]; lvDict[k]=F.dimDict[k]; });
    // 产品型号维(仅预测表含型号;model 为空的行在 rowDim==='model' 时跳过)
    const modelArr=(F.dimCode&&F.dimCode.model)||null, modelDict=(F.dimDict&&F.dimDict.model)||null;
    const mkSub=(dict,keepEmpty)=>{ const s=new Set(); if(dict) dict.forEach((v,c)=>{ if(isSubtotal(v)||(!keepEmpty&&v==='')) s.add(c); }); return s; };
    const repSub=mkSub(repDict,false);
    const lvSub={lv1:mkSub(lvDict.lv1,false),lv2:mkSub(lvDict.lv2,false),lv3:mkSub(lvDict.lv3,false),lv4:mkSub(lvDict.lv4,true)};
    // 顶部筛选(名称集，与 financeOverview/ProductBoard 一致)：rep + lv1~lv4
    const repSel=p.reps&&p.reps.length?new Set(p.reps):null;
    const lvSel={
      lv1:p.lv1&&p.lv1.length?new Set(p.lv1):null, lv2:p.lv2&&p.lv2.length?new Set(p.lv2):null,
      lv3:p.lv3&&p.lv3.length?new Set(p.lv3):null, lv4:p.lv4&&p.lv4.length?new Set(p.lv4):null };
    const US=finUnitScale(p), QS=finQtyScale(p);   // 金额按金额单位归一;数量按数量单位归一
    // 分组键取值(按 rowDim)：rep→国家办名;model→产品型号;lvN→产品层级名
    const groupName=i=> rowDim==='rep' ? (repDict[repArr[i]]||'(未分配)')
      : rowDim==='model' ? ((modelDict&&modelDict[modelArr[i]])||'')
      : (lvDict[rowDim][lvArr[rowDim][i]]||'(未分类)');
    // 节点：actRev/fcRev/bpRev(收入三口径) + actGm/fcGm/bpGm(销毛三口径) + actSi/fcSi/bpSi(收入量三口径,NSIP分母)
    //       + siTgtFc/siTgtBp/soTgtFc/soTgtBp(sell-in/out 目标量,forecast/bp 全年)
    const node=()=>({actRev:0,fcRev:0,bpRev:0,actGm:0,fcGm:0,bpGm:0,actCp:0,fcCp:0,bpCp:0,actSi:0,fcSi:0,bpSi:0,
      siTgtFc:0,siTgtBp:0,soTgtFc:0,soTgtBp:0});
    const acc=new Map();
    const get=k=>{ let n=acc.get(k); if(!n){n=node();acc.set(k,n);} return n; };
    // 指标 → 节点字段三元组(act/fc/bp)；一个 metricCode 可同时落多个 sink(如收入量同为 NSIP 分母与 sell-in 目标)
    const sink=new Map();
    const addSink=(code,a,fcF,bpF,qty)=>{ if(code===undefined) return; let s=sink.get(code); if(!s){s=[];sink.set(code,s);} s.push({a,fc:fcF,bp:bpF,qty}); };
    addSink(revCode,'actRev','fcRev','bpRev',false);
    addSink(gmCode,'actGm','fcGm','bpGm',false);
    addSink(cpCode,'actCp','fcCp','bpCp',false);              // 贡献利润(金额,qty=false)
    nsipCodes.forEach(code=>addSink(code,'actSi','fcSi','bpSi',true));   // 收入量(NSIP分母,跨表名集合);数量按数量单位归一
    addSink(siTgtCode,null,'siTgtFc','siTgtBp',true);          // sell-in 目标量(仅 forecast/bp)
    addSink(soTgtCode,null,'soTgtFc','soTgtBp',true);          // sell-out 目标量(仅 forecast/bp)
    for(let i=0;i<F.n;i++){
      const dest=sink.get(mArr[i]); if(!dest) continue;
      if(brandCodes && !brandCodes.has(bCode[i])) continue;
      // 小计/空行剔除(rep + lv1~lv4)
      const rc=repArr[i];
      if(repSub.has(rc)) continue;
      let bad=false; for(let L=0;L<lvKeys.length;L++){ const k=lvKeys[L]; if(lvSub[k].has(lvArr[k][i])){ bad=true; break; } }
      if(bad) continue;
      // 顶部筛选(名称集)
      if(repSel && !repSel.has(repDict[rc])) continue;
      let out=false; for(let L=0;L<lvKeys.length;L++){ const k=lvKeys[L]; if(lvSel[k] && !lvSel[k].has(lvDict[k][lvArr[k][i]])){ out=true; break; } }
      if(out) continue;
      // rowDim==='model' 时跳过型号为空的行(仅预测表含型号,实际/BP model 空)
      if(rowDim==='model' && (!modelArr || !modelDict || (modelDict[modelArr[i]]||'')==='')) continue;
      const s=sArr[i], y=ymArr[i], yy=Math.floor(y/100), mm=y%100;
      // 来源 → 命中字段：实际(区间,当年)=a;预测(全年,当年,版本)=fc;BP(全年,当年,BP版本)=bp。去年实际不需要(无同比指标)。
      let fld=null;
      if(s===0){ if(yy===curYear && inRange(mm)) fld='a'; }
      else if(s===1){ if(yy===curYear && versionCode!==undefined && verArr[i]===versionCode) fld='fc'; }
      else if(s===2){ if(yy===curYear && bpVerCode!==undefined && verArr[i]===bpVerCode) fld='bp'; }
      if(!fld) continue;
      const n=get(groupName(i));
      const raw=vArr[i]||0;
      for(let k=0;k<dest.length;k++){ const d=dest[k]; const tgt=d[fld]; if(!tgt) continue; n[tgt]+=raw*(d.qty?QS[s]:US[s]); }
    }
    // PSI 实际 sell-in/out：按组映射 PSI 名称集 — rep→repOffice;lv3→family;lv4→series;lv1/lv2→该组下 family/series 集合。
    const needPsiActual=(basis==='actual') && (sel.includes('sellIn')||sel.includes('sellOut'));
    const psiOf=(p2)=>this._psiActual(Object.assign({year:curYear,fromM,toM},p2));
    // 组键 → PSI scope。rep:该组单国家办;lv3:family=组名;lv4:series=组名;lv1/lv2:用 _finProductScope 推导(叠加全局 lv 筛选)。
    const groupPsiScope=(key)=>{
      if(rowDim==='rep') return {reps:[key], families:_scopeFamilies(), series:_scopeSeries()};
      if(rowDim==='lv3') return {reps:p.reps, families:[key], series:_scopeSeries()};
      if(rowDim==='lv4') return {reps:p.reps, families:_scopeFamilies(), series:[key]};
      // lv1/lv2：把该组值并入对应级别筛选,经 _finProductScope 推导 family/series 名称集
      const fp=Object.assign({}, {reps:p.reps,lv1:p.lv1,lv2:p.lv2,lv3:p.lv3,lv4:p.lv4});
      fp[rowDim]=[key];
      const sc=this._finProductScope(fp);
      return {reps:sc.reps, families:sc.families, series:sc.series};
    };
    // 全局 lv 筛选 → PSI family/series(供 rep/lv3/lv4 组继承全局产品筛选)
    const _globalScope=this._finProductScope({reps:p.reps,lv1:p.lv1,lv2:p.lv2,lv3:p.lv3,lv4:p.lv4});
    function _scopeFamilies(){ return _globalScope.families; }
    function _scopeSeries(){ return _globalScope.series; }
    // total 的 PSI：整体 p 范围(_finProductScope) — 与 financeOverview 一致,稳健于 rep 名不匹配场景
    const totPsi = needPsiActual ? psiOf({reps:_globalScope.reps,families:_globalScope.families,series:_globalScope.series}) : null;
    // 派生：从汇总分量重算 ratio
    const ratio=(a,b)=>attainRate(a,b);   // 统一走分母守卫：分母塌缩时返回 null 而不是荒唐比值
    const valByBasis=(n,which)=>{
      if(which==='rev') return basis==='actual'?n.actRev:basis==='forecast'?n.fcRev:n.bpRev;
      if(which==='gm')  return basis==='actual'?n.actGm :basis==='forecast'?n.fcGm :n.bpGm;
      if(which==='cp')  return basis==='actual'?n.actCp :basis==='forecast'?n.fcCp :n.bpCp;
      if(which==='si')  return basis==='actual'?n.actSi :basis==='forecast'?n.fcSi :n.bpSi;   // 收入量(NSIP分母)
      return 0;
    };
    const projectMetrics=(n,psiActual)=>{
      const rev=valByBasis(n,'rev'), gm=valByBasis(n,'gm'), cp=valByBasis(n,'cp'), si=valByBasis(n,'si');
      const out={};
      sel.forEach(m=>{
        if(m==='rev') out.rev=rev;
        else if(m==='gm') out.gm=gm;
        else if(m==='cp') out.cp=cp;
        else if(m==='gmr') out.gmr=ratio(gm,rev);
        else if(m==='nsip') out.nsip=ratio(rev,si);   // 收入 / 收入量
        else if(m==='sellIn') out.sellIn = basis==='actual' ? (psiActual?psiActual.si26:0) : (basis==='forecast'?n.siTgtFc:n.siTgtBp);
        else if(m==='sellOut') out.sellOut= basis==='actual' ? (psiActual?psiActual.so26:0) : (basis==='forecast'?n.soTgtFc:n.soTgtBp);
        else if(m==='bpAttain') out.bpAttain=ratio(n.actRev,n.bpRev);   // 实际收入 ÷ 全年BP收入(不随 basis 变)
        else if(m==='fcAttain') out.fcAttain=ratio(n.actRev,n.fcRev);   // 实际收入 ÷ 全年预测收入
      });
      return out;
    };
    // 各组行
    const rows=[];
    acc.forEach((n,key)=>{
      const psiA = needPsiActual ? psiOf(groupPsiScope(key)) : null;
      rows.push(Object.assign({key}, projectMetrics(n, psiA)));
    });
    // 排序：优先按所选首个值型指标(rev>gm>si>nsip...)降序,默认 actRev
    const sortKey = sel.find(m=>['rev','gm','cp','sellIn','sellOut','nsip'].includes(m));
    if(sortKey) rows.sort((x,y)=>(y[sortKey]||0)-(x[sortKey]||0));
    // total：分量汇总后重算 ratio(不取平均)
    const tot=node();
    acc.forEach(n=>{ for(const k in tot) tot[k]+=n[k]; });
    const total=projectMetrics(tot, totPsi);
    return {rows, total, metrics:sel, dim:rowDim,
      curYear, prevYear, fromM, toM, version, bpVersion, basis};
  }

  // BP 达成报表：今年1~N月实际 ÷ 全年BP(选定版本)，分国家办 + 分产业(产品LV1)，多指标(排除比率)
C.Engine.prototype.financeBP = function(p){
    p=p||{};
    if(!this.hasFin || !this.finMeta.hasBP) return {hasBP:false};
    const F=this.fin, fm=this.finMeta;
    const ay=fm.actualYears||fm.years; const curYear=p.year||ay[ay.length-1]||0;
    const bpVersion=(p.bpVersion&&fm.bpVersions.includes(p.bpVersion))?p.bpVersion:(fm.bpVersions.includes('国家办工作底稿')?'国家办工作底稿':(fm.bpVersions[0]||'默认'));
    const bpVerCode=F.dimIndex.version.get(bpVersion);
    const metrics=fm.bpMetrics.filter(m=>!/率|占比/.test(m));   // 排除比率类(无法做"实际/计划")
    const metricName={}; metrics.forEach(m=>{ const c=F.dimIndex.metric.get(m); if(c!==undefined) metricName[c]=m; });
    let cutoff=0; for(let i=0;i<F.n;i++){ if(F.src[i]===0 && Math.floor(F.ym[i]/100)===curYear){ const mm=F.ym[i]%100; if(mm>cutoff)cutoff=mm; } }
    if(p.cutoff)cutoff=p.cutoff; if(!cutoff)cutoff=12;
    const repDict=F.dimDict.rep, lv1Dict=F.dimDict.lv1, repCode=F.dimCode.rep, lv1Code=F.dimCode.lv1, mCode=F.dimCode.metric, verCode=F.dimCode.version;
    const repSub=new Set(); repDict.forEach((v,c)=>{ if(isSubtotal(v)||v==='') repSub.add(c); });
    const lv1Sub=new Set(); lv1Dict.forEach((v,c)=>{ if(isSubtotal(v)||v==='') lv1Sub.add(c); });
    const accRep=new Map(), accLv1=new Map();
    const US=finUnitScale(p), QS=finQtyScale(p);   // 金额按金额单位归一;数量按数量单位归一
    const add=(acc,gc,mn,fld,v)=>{ let m=acc.get(gc); if(!m){m=new Map();acc.set(gc,m);} let cell=m.get(mn); if(!cell){cell={actual:0,bp:0};m.set(mn,cell);} cell[fld]+=v; };
    for(let i=0;i<F.n;i++){
      const mn=metricName[mCode[i]]; if(!mn) continue;
      const s=F.src[i], y=F.ym[i], yy=Math.floor(y/100), mm=y%100, v=(F.val[i]||0)*(isQtyMetric(mn)?QS[s]:US[s]);
      let fld=null;
      if(s===0){ if(yy===curYear && mm<=cutoff) fld='actual'; }
      else if(s===2){ if(yy===curYear && verCode[i]===bpVerCode) fld='bp'; }
      if(!fld) continue;
      const rc=repCode[i], lc=lv1Code[i];
      if(!repSub.has(rc)) add(accRep,rc,mn,fld,v);
      if(!lv1Sub.has(lc)) add(accLv1,lc,mn,fld,v);
    }
    const buildRows=(acc,dict)=>{ const rows=[];
      acc.forEach((mmap,gc)=>{ const cells={}; metrics.forEach(mn=>{ const c=mmap.get(mn)||{actual:0,bp:0}; cells[mn]={actual:c.actual,bp:c.bp,attain:attainRate(c.actual,c.bp)}; });
        rows.push({key:dict[gc],cells}); });
      return rows; };
    const repRows=buildRows(accRep,repDict), lv1Rows=buildRows(accLv1,lv1Dict);
    const totalCells={}; metrics.forEach(mn=>{ let a=0,b=0; repRows.forEach(r=>{a+=r.cells[mn].actual;b+=r.cells[mn].bp;}); totalCells[mn]={actual:a,bp:b,attain:attainRate(a,b)}; });
    const primary=metrics[0]; const byA=(a,b)=>((b.cells[primary]?b.cells[primary].actual:0)-(a.cells[primary]?a.cells[primary].actual:0));
    repRows.sort(byA); lv1Rows.sort(byA);
    return { hasBP:true, curYear, cutoff, bpVersion, bpVersions:fm.bpVersions, metrics,
      rep:{ rows:repRows, total:{key:'拉美整体',cells:totalCells} },
      lv1:{ rows:lv1Rows, total:{key:'拉美整体',cells:totalCells} } };
  }

  // 全年BP达成面板：净销售收入达成(实际1~N月 ÷ 全年BP) + 销毛率 pp 偏差(实际−BP)。
  // 分组：产品LV1(Family)、国家办(Rep)、国家办×Family 交叉。BP版本默认 国家办工作底稿；排除小计/空。
C.Engine.prototype.financeBPBoard = function(p){
    p=p||{};
    if(!this.hasFin || !this.finMeta.hasBP) return {hasBP:false};
    const F=this.fin, fm=this.finMeta;
    const ay=fm.actualYears||fm.years; const curYear=p.year||ay[ay.length-1]||0;
    const bpVersion=(p.bpVersion&&fm.bpVersions.includes(p.bpVersion))?p.bpVersion:(fm.bpVersions.includes('国家办工作底稿')?'国家办工作底稿':(fm.bpVersions[0]||'默认'));
    const bpVerCode=F.dimIndex.version.get(bpVersion);
    // 收入/销毛额指标：与 financeBP/financeAchieve 同口径(自动识别，可由 p 覆盖)
    const pick=(re,def)=>{
      if(def && fm.metrics.includes(def)) return def;                       // 优先精确标准名(销售毛利/净销售收入),避免误选 销售毛利率 / 销售毛利(不含中期激励)
      const ms=fm.metrics.filter(x=>re.test(x)); if(!ms.length) return null;
      const clean=ms.filter(x=>!/率$/.test(x) && !/[（(]/.test(x));          // 排除"…率"结尾 和 带括号的变体
      return clean[0]||ms[0];
    };
    const ov=(o,re,def)=>(o && fm.metrics.includes(o)) ? o : pick(re,def);
    const REV=ov(p.revMetric, /净销售收入|营业收入|销售收入|^收入$/, '净销售收入');
    const GM =ov(p.gmMetric,  /销售毛利|毛利额|销毛额|^销售毛利|^毛利$/, '销售毛利');
    const revCode=REV?F.dimIndex.metric.get(REV):undefined, gmCode=GM?F.dimIndex.metric.get(GM):undefined;
    let cutoff=0; for(let i=0;i<F.n;i++){ if(F.src[i]===0 && Math.floor(F.ym[i]/100)===curYear){ const mm=F.ym[i]%100; if(mm>cutoff)cutoff=mm; } }
    if(p.cutoff)cutoff=p.cutoff; if(!cutoff)cutoff=12;
    const repDict=F.dimDict.rep, lv1Dict=F.dimDict.lv1, repCode=F.dimCode.rep, lv1Code=F.dimCode.lv1, mCode=F.dimCode.metric, verCode=F.dimCode.version;
    const repSub=new Set(); repDict.forEach((v,c)=>{ if(isSubtotal(v)||v==='') repSub.add(c); });
    const lv1Sub=new Set(); lv1Dict.forEach((v,c)=>{ if(isSubtotal(v)||v==='') lv1Sub.add(c); });
    const brandCodes=this._finBrandCodes(p.brands), bCode=F.dimCode.brand;
    // 每组累加 actRev/bpRev/actGm/bpGm
    const cell=()=>({actRev:0,bpRev:0,actGm:0,bpGm:0});
    const SEP=String.fromCharCode(0);
    const accFam=new Map(), accRep=new Map(), accCross=new Map();
    const US=finUnitScale(p);   // 收入/销毛额均为金额,按来源单位归一(否则达成率被单位放大)
    const get=(acc,k)=>{ let c=acc.get(k); if(!c){c=cell();acc.set(k,c);} return c; };
    for(let i=0;i<F.n;i++){
      const mc=mCode[i]; const isRev=(revCode!==undefined&&mc===revCode), isGm=(gmCode!==undefined&&mc===gmCode);
      if(!isRev&&!isGm) continue;
      if(brandCodes && !brandCodes.has(bCode[i])) continue;
      const s=F.src[i], y=F.ym[i], yy=Math.floor(y/100), mm=y%100, v=(F.val[i]||0)*US[s];
      let fld=null;
      if(s===0){ if(yy===curYear && mm<=cutoff) fld=isRev?'actRev':'actGm'; }
      else if(s===2){ if(yy===curYear && verCode[i]===bpVerCode) fld=isRev?'bpRev':'bpGm'; }
      if(!fld) continue;
      const rc=repCode[i], lc=lv1Code[i];
      const repBad=repSub.has(rc), famBad=lv1Sub.has(lc);
      const rep=repDict[rc]||'(未分配)', fam=lv1Dict[lc]||'(未分类)';
      if(!famBad) get(accFam,fam)[fld]+=v;
      if(!repBad) get(accRep,rep)[fld]+=v;
      if(!repBad && !famBad) get(accCross,rep+SEP+fam)[fld]+=v;
    }
    const attain=(a,b)=>attainRate(a,b);   // 统一走分母守卫
    const gmRate=(g,r)=>r?g/r:null;
    const ppDiff=(a,b)=>(a!=null&&b!=null)?a-b:null;
    // 收入达成行 + total
    const revRows=(acc,keyFn)=>{ const out=[]; const t=cell();
      acc.forEach((c,k)=>{ t.actRev+=c.actRev; t.bpRev+=c.bpRev; out.push(keyFn(k,{actual:c.actRev,bp:c.bpRev,attain:attain(c.actRev,c.bpRev)})); });
      out.sort((x,y)=>y.actual-x.actual);
      out.push(keyFn('total',{actual:t.actRev,bp:t.bpRev,attain:attain(t.actRev,t.bpRev)}));
      return out; };
    const revByFamily=revRows(accFam,(k,o)=>Object.assign({key:k},o));
    const revByRep=revRows(accRep,(k,o)=>Object.assign({key:k},o));
    const revByRepFamily=[];
    accCross.forEach((c,k)=>{ const [rep,family]=k.split(SEP); revByRepFamily.push({rep,family,actual:c.actRev,bp:c.bpRev,attain:attain(c.actRev,c.bpRev)}); });
    revByRepFamily.sort((a,b)=>b.actual-a.actual);
    // 销毛率 pp 行 + total
    const gmRows=acc=>{ const out=[]; const t=cell();
      acc.forEach((c,k)=>{ t.actRev+=c.actRev; t.bpRev+=c.bpRev; t.actGm+=c.actGm; t.bpGm+=c.bpGm;
        const ag=gmRate(c.actGm,c.actRev), bg=gmRate(c.bpGm,c.bpRev); out.push({key:k,actGmPct:ag,bpGmPct:bg,pp:ppDiff(ag,bg)}); });
      out.sort((x,y)=>(y.actGmPct||0)-(x.actGmPct||0));
      const ag=gmRate(t.actGm,t.actRev), bg=gmRate(t.bpGm,t.bpRev); out.push({key:'total',actGmPct:ag,bpGmPct:bg,pp:ppDiff(ag,bg)});
      return out; };
    const gmrByFamily=gmRows(accFam), gmrByRep=gmRows(accRep);
    return { hasBP:true, curYear, cutoff, bpVersion, bpVersions:fm.bpVersions, revMetric:REV, gmMetric:GM,
      revByFamily, revByRep, revByRepFamily, gmrByFamily, gmrByRep };
  }

// 总看板：5 指标(净销售收入/Sell-in量/Sell-out量/销毛率/NSIP) × (实际/同比/BP完成/预测完成)。
// 实际：净收入/销毛/收入量来自 this.fin(src0 当年/去年区间)；sell-in/out 实际来自 PSI(_psiActual)。
// BP：src2 当年全年(BP版本)；预测：src1 当年全年(选定版本)。金额按来源单位归一,数量不缩放。
C.Engine.prototype.financeOverview = function(p){
    p=p||{};
    const F=this.fin, fm=this.finMeta;
    if(!F || !fm) return {curYear:0,prevYear:0,fromM:1,toM:12,metrics:{}};
    const ay=fm.actualYears||fm.years; const curYear=p.year||ay[ay.length-1]||0; const prevYear=curYear-1;
    const fromM=Math.max(1,Math.min(12,normM(p.fromM)||1));
    /* 2026-08-31 评测 F 系列：缺省全年区间让「2025 全年 vs 2026 半年」同比失真，四题被误导。
       缺省改同区间(至最新实际月，与 productBoard 同源)；要全年区间显式传 toM:12。 */
    let _lact=0; try { const _s=F.src, _ym=F.ym; if(_s&&_ym){ for(let i=0;i<F.n;i++){ if(_s[i]===0 && Math.floor(_ym[i]/100)===curYear){ const mm=_ym[i]%100; if(mm>_lact)_lact=mm; } } } } catch(e){}
    let toM=normM(p.toM)?Math.max(1,Math.min(12,normM(p.toM))):(_lact||12); if(toM<fromM) toM=fromM;
    const inRange=mm=>mm>=fromM&&mm<=toM;
    // 版本：预测=选定版本(src1)，BP=国家办工作底稿(src2)，沿用 financeAchieve/financeBP 口径
    const version=p.version||(fm.versions[0]||'默认');
    const versionCode=F.dimIndex.version.get(version);
    const bpVersion=(p.bpVersion&&fm.bpVersions.includes(p.bpVersion))?p.bpVersion:(fm.bpVersions.includes('国家办工作底稿')?'国家办工作底稿':(fm.bpVersions[0]||'默认'));
    const bpVerCode=F.dimIndex.version.get(bpVersion);
    // 指标名识别(沿用 financeAchieve 的 pick/ov)
    const pick=(re,def)=>{
      if(def && fm.metrics.includes(def)) return def;                       // 优先精确标准名(销售毛利/净销售收入),避免误选 销售毛利率 / 销售毛利(不含中期激励)
      const ms=fm.metrics.filter(x=>re.test(x)); if(!ms.length) return null;
      const clean=ms.filter(x=>!/率$/.test(x) && !/[（(]/.test(x));          // 排除"…率"结尾 和 带括号的变体
      return clean[0]||ms[0];
    };
    const ov=(o,re,def)=>(o && fm.metrics.includes(o)) ? o : pick(re,def);
    const REV  =ov(p.revMetric,  /净销售收入|营业收入|销售收入|^收入$/, '净销售收入');
    const GM   =ov(p.gmMetric,   /销售毛利|毛利额|销毛额|^销售毛利|^毛利$/, '销售毛利');
    const NSIPQ=ov(p.nsipMetric, /Sell\s*in量|收入量(_终端)?/, 'Sell in量');           // NSIP 分母(财经实际表)
    const SI_TGT=pick(/sell\s*in量/i, 'Sell in量');                                    // sell-in 目标(bp/fc)
    const SO_TGT=pick(/sell\s*out量/i, 'Sell out量');                                  // sell-out 目标(bp/fc)
    const revCode =REV  ?F.dimIndex.metric.get(REV)  :undefined;
    const gmCode  =GM   ?F.dimIndex.metric.get(GM)   :undefined;
    // NSIP 分母(收入量)：跨表名集合 — 实际=收入量_终端,预测/BP=收入量;显式 p.nsipMetric 时尊重覆盖。
    const nsipCodes=nsipDenomCodes(F, fm, p.nsipMetric, NSIPQ);
    const siCode  =SI_TGT?F.dimIndex.metric.get(SI_TGT):undefined;
    const soCode  =SO_TGT?F.dimIndex.metric.get(SO_TGT):undefined;
    const brandCodes=this._finBrandCodes(p.brands), bCode=F.dimCode.brand;
    const sArr=F.src, ymArr=F.ym, vArr=F.val, mArr=F.dimCode.metric, verArr=F.dimCode.version;
    // 小计/空行剔除(沿用 financeAchieve/financeBP)：rep + lv1~lv4 维度
    const repArr=F.dimCode.rep, repDict=F.dimDict.rep;
    const repSub=new Set(); if(repDict) repDict.forEach((v,c)=>{ if(v===''||isSubtotal(v)) repSub.add(c); });
    const lvKeys=['lv1','lv2','lv3','lv4'];
    // lv 维度：仅剔除真正的小计标签(isSubtotal)；空串是合法叶子(如 demo lv4 全空),不可当小计剔除
    const lvSub=lvKeys.map(k=>{ const arr=F.dimCode[k], dict=F.dimDict[k]; const s=new Set();
      if(dict) dict.forEach((v,c)=>{ if(isSubtotal(v)) s.add(c); }); return {arr,dict,s}; });
    // 总看板筛选(spec §4)：国家办 + 产品 LV1~LV4，与 PSI 侧 scope 一致地作用于财经侧
    const repSel=p.reps&&p.reps.length?new Set(p.reps):null;
    const lvSel=lvKeys.map((k,idx)=>{ const sel=p[k]&&p[k].length?new Set(p[k]):null; return {sel, arr:lvSub[idx].arr, dict:lvSub[idx].dict}; });
    const US=finUnitScale(p), QS=finQtyScale(p);   // 金额按金额单位归一;数量按数量单位归一
    // acc：每指标 {act,prev,bp,fc}。rev/gm/收入量 取 act/prev/bp/fc；sell-in/out 目标只取 bp/fc。
    const node=()=>({act:0,prev:0,bp:0,fc:0});
    const rev=node(), gm=node(), nq=node(), siTgt=node(), soTgt=node();
    // 一个指标可同时落入多个累加器(如 demo 中 NSIP 分母与 sell-in 目标同为"Sell in量")，
    // 故对每个 metric 建一份待累加列表 {tgt,name,qty}，逐行按 src/年/月归一后累加各自字段。
    const sink=new Map();   // metricCode -> [{tgt,name,qty}]
    const addSink=(code,tgt,name,qty)=>{ if(code===undefined) return; let a=sink.get(code); if(!a){a=[];sink.set(code,a);} a.push({tgt,name,qty}); };
    addSink(revCode,rev,REV,false); addSink(gmCode,gm,GM,false);
    // NSIP 分母收入量：跨表名集合(收入量_终端/收入量)全部 sink 到 nq,数量按数量单位归一。
    nsipCodes.forEach(code=>addSink(code,nq,NSIPQ,true));
    addSink(siCode,siTgt,SI_TGT,true); addSink(soCode,soTgt,SO_TGT,true);
    for(let i=0;i<F.n;i++){
      const dest=sink.get(mArr[i]); if(!dest) continue;
      if(brandCodes && !brandCodes.has(bCode[i])) continue;
      // 排除小计/空行(rep + lv1~lv4)，避免与底表合计行双重计数
      const rc=repArr?repArr[i]:undefined; if(repArr && repSub.has(rc)) continue;
      let lvBad=false; for(let L=0;L<lvSub.length;L++){ const x=lvSub[L]; if(x.arr && x.s.has(x.arr[i])){ lvBad=true; break; } }
      if(lvBad) continue;
      // 总看板筛选：国家办 + 产品 LV1~LV4(名称集，非空时生效)，与 PSI 侧一致
      if(repSel && !(repDict && repSel.has(repDict[rc]))) continue;
      let lvOut=false; for(let L=0;L<lvSel.length;L++){ const x=lvSel[L]; if(x.sel){ const name=x.arr?x.dict[x.arr[i]]:undefined; if(!x.sel.has(name)){ lvOut=true; break; } } }
      if(lvOut) continue;
      const s=sArr[i], y=ymArr[i], yy=Math.floor(y/100), mm=y%100, val=(vArr[i]||0);
      let field=null;
      if(s===0){ if(inRange(mm)){ if(yy===curYear) field='act'; else if(yy===prevYear) field='prev'; } }
      else if(s===1){ if(yy===curYear && versionCode!==undefined && verArr[i]===versionCode) field='fc'; }   // 当年全年预测
      else if(s===2){ if(yy===curYear && bpVerCode!==undefined && verArr[i]===bpVerCode) field='bp'; }        // 当年全年BP
      if(!field) continue;
      for(let k=0;k<dest.length;k++){ const d=dest[k]; const isQ=(d.qty!=null)?d.qty:isQtyMetric(d.name); d.tgt[field]+=val*(isQ?QS[s]:US[s]); }
    }
    // PSI 实际 sell-in/out（财经产品筛选 → PSI 名称集）
    const scope=this._finProductScope(p);
    const psi=this._psiActual({year:curYear,fromM,toM,reps:scope.reps,families:scope.families,series:scope.series});
    // 派生工具
    const yoy=(a,pv)=>pv?(a-pv)/pv:null;
    const ratio=(a,b)=>attainRate(a,b);   // 统一走分母守卫：分母塌缩时返回 null 而不是荒唐比值
    const diff=(a,b)=>(a!=null&&b!=null)?a-b:null;
    const amtMetric=(a)=>{ const bpAttain=ratio(a.act,a.bp), fcAttain=ratio(a.act,a.fc);
      return {actual:a.act, prev:a.prev, yoy:yoy(a.act,a.prev), bp:a.bp, fc:a.fc, bpAttain, fcAttain}; };
    const sellMetric=(actual,prev,tgt)=>{ const bpAttain=ratio(actual,tgt.bp), fcAttain=ratio(actual,tgt.fc);
      return {actual, prev, yoy:yoy(actual,prev), bp:tgt.bp, fc:tgt.fc, bpAttain, fcAttain}; };
    // 销毛率(率)：act=gm/rev 等；差值为 pp
    const gmrAct=ratio(gm.act,rev.act), gmrPrev=ratio(gm.prev,rev.prev), gmrBp=ratio(gm.bp,rev.bp), gmrFc=ratio(gm.fc,rev.fc);
    const gmr={actual:gmrAct, prev:gmrPrev, bp:gmrBp, fc:gmrFc,
      prevDiff:diff(gmrAct,gmrPrev), bpDiff:diff(gmrAct,gmrBp), fcDiff:diff(gmrAct,gmrFc)};
    // NSIP(单价)：实际/同比用 收入量(财经实际)；与目标用 sell-in 目标；差值为绝对差
    const nsipAct=ratio(rev.act,nq.act), nsipPrev=ratio(rev.prev,nq.prev), nsipBp=ratio(rev.bp,siTgt.bp), nsipFc=ratio(rev.fc,siTgt.fc);
    const nsip={actual:nsipAct, prev:nsipPrev, bp:nsipBp, fc:nsipFc,
      prevDiff:diff(nsipAct,nsipPrev), bpDiff:diff(nsipAct,nsipBp), fcDiff:diff(nsipAct,nsipFc)};
    const metrics={
      rev:    amtMetric(rev),
      sellIn: sellMetric(psi.si26, psi.si25, siTgt),
      sellOut:sellMetric(psi.so26, psi.so25, soTgt),
      gmr, nsip
    };
    // dims：各维全量取值(去重/去小计/去空)，供前端下拉填充，不受 p 的筛选影响。
    const distinct=(dim)=>{ const d=F.dimDict[dim]; if(!d) return []; const seen=new Set(), out=[];
      d.forEach(v=>{ if(v==null) return; const s=String(v); if(s===''||isSubtotal(s)||seen.has(s)) return; seen.add(s); out.push(s); }); return out; };
    const dims={ lv1:distinct('lv1'), lv2:distinct('lv2'), lv3:distinct('lv3'), lv4:distinct('lv4'), reps:distinct('rep') };
    return {curYear, prevYear, fromM, toM, version, bpVersion, metrics, dims,
      health:this.financeHealth(),           // 数据体检(缓存,轻量)
      finSiAct:nq.act, finSiPrev:nq.prev};   // 财经收入量(区间累计,SISO差异警示用)
  }

// PSI 月度真实 sell-in/sell-out 汇总（按 rep/family/series 名称集 + 月区间），当年/去年同区间。
C.Engine.prototype._psiActual = function(p){
  const empty={si26:0,so26:0,si25:0,so25:0,hasPsi:false};
  const S=this.store; if(!S || !S.n) return empty;
  const curYear=p.year||0, prevYear=curYear-1;
  const fromM=p.fromM||1, toM=p.toM||12;
  const reps=p.reps&&p.reps.length?new Set(p.reps):null;
  const fams=p.families&&p.families.length?new Set(p.families):null;
  const sers=p.series&&p.series.length?new Set(p.series):null;
  // 名称容错匹配集(仅本函数内 财经↔PSI 查找用，不外泄)。
  const repsN=reps?new Set([...reps].map(finPsiRepNorm)):null;
  const famsN=fams?new Set([...fams].map(finPsiNameNorm)):null;
  const sersN=sers?new Set([...sers].map(finPsiNameNorm)):null;
  const repC=S.dimCode.repOffice,famC=S.dimCode.family,serC=S.dimCode.series;
  const repD=S.dimDict.repOffice,famD=S.dimDict.family,serD=S.dimDict.series;
  const sRep=S.subtotalCodes.repOffice,sFam=S.subtotalCodes.family,sSer=S.subtotalCodes.series;
  let si26=0,so26=0,si25=0,so25=0;
  for(let i=0;i<S.n;i++){
    const y=S.ymd[i], yy=Math.floor(y/10000), mm=Math.floor(y/100)%100;
    if(yy!==curYear&&yy!==prevYear) continue;
    if(mm<fromM||mm>toM) continue;
    const rc=repC[i]; if(sRep.has(rc)) continue; if(repsN&&!repsN.has(finPsiRepNorm(repD[rc]))) continue;
    const fc=famC[i]; if(sFam.has(fc)) continue; if(famsN&&!famsN.has(finPsiNameNorm(famD[fc]))) continue;
    const sc=serC[i]; if(sSer.has(sc)) continue; if(sersN&&!sersN.has(finPsiNameNorm(serD[sc]))) continue;
    if(yy===curYear){ si26+=S.sellIn[i]; so26+=S.sellOut[i]; }
    else { si25+=S.sellIn[i]; so25+=S.sellOut[i]; }
  }
  return {si26,so26,si25,so25,hasPsi:true};
};

// 财经产品筛选(LV1产业/LV2品类/LV3系列/LV4产品) → PSI 名称集 {reps,families,series}。
// 关联：财经 lv3 ↔ PSI family，财经 lv4 ↔ PSI series。lv3/lv4 直传；仅 lv1/lv2 时从 this.fin 推导其下 lv3/lv4 名称集；reps 透传。
C.Engine.prototype._finProductScope = function(p){
  const F=this.fin;
  const out={reps:p.reps&&p.reps.length?p.reps.slice():null, families:null, series:null};
  let fams=p.lv3&&p.lv3.length?new Set(p.lv3):null;
  let sers=p.lv4&&p.lv4.length?new Set(p.lv4):null;
  const lv1Sel=p.lv1&&p.lv1.length?new Set(p.lv1):null, lv2Sel=p.lv2&&p.lv2.length?new Set(p.lv2):null;
  if(F && (lv1Sel||lv2Sel) && !fams){
    fams=new Set(); const sersD=sers||new Set();
    const c1=F.dimCode.lv1,c2=F.dimCode.lv2,c3=F.dimCode.lv3,c4=F.dimCode.lv4;
    const d1=F.dimDict.lv1,d2=F.dimDict.lv2,d3=F.dimDict.lv3,d4=F.dimDict.lv4;
    for(let i=0;i<F.n;i++){
      if(lv1Sel&&!lv1Sel.has(d1[c1[i]])) continue;
      if(lv2Sel&&!lv2Sel.has(d2[c2[i]])) continue;
      const f=d3[c3[i]]; if(f&&!isSubtotal(f)) fams.add(f);
      const s=d4[c4[i]]; if(s&&!isSubtotal(s)) sersD.add(s);
    }
    if(!sers && sersD.size) sers=sersD;
  }
  out.families=fams?[...fams]:null; out.series=sers?[...sers]:null;
  return out;
};

// 数据体检(只读诊断)：指标解析结果 + NSIP分母缺口 + 财经↔PSI 名称对不上清单。
// 结果按 this.fin 身份缓存(数据重建后自动失效)。不改任何看板取数逻辑。
C.Engine.prototype.financeHealth = function(){
  if(!this.hasFin || !this.fin) return {hasFin:false};
  if(this._finHealthFor===this.fin && this._finHealthCache) return this._finHealthCache;
  const F=this.fin, fm=this.finMeta;
  // 指标解析(与 financeOverview 的 pick 同规则)
  const pick=(re,def)=>{ if(def && fm.metrics.includes(def)) return def;
    const ms=fm.metrics.filter(x=>re.test(x)); if(!ms.length) return null;
    const clean=ms.filter(x=>!/率$/.test(x) && !/[（(]/.test(x)); return clean[0]||ms[0]; };
  const REV=pick(/净销售收入|营业收入|销售收入|^收入$/,'净销售收入');
  const GM=pick(/销售毛利|毛利额|销毛额|^销售毛利|^毛利$/,'销售毛利');
  const NSIPQ=pick(/Sell\s*in量|收入量(_终端)?/,'Sell in量');
  const nsipCodes=nsipDenomCodes(F,fm,null,NSIPQ);
  const nsipNames=[...nsipCodes].map(c=>F.dimDict.metric[c]);
  // NSIP 缺口：近两个实际年,按 lv3|lv4 分组(实际源),有收入(rev>0)但分母合计=0 → 缺口
  const ay=fm.actualYears||[]; const years=ay.slice(-2).map(Number);
  const revCode=REV?F.dimIndex.metric.get(REV):undefined;
  const sArr=F.src, ymArr=F.ym, vArr=F.val, mArr=F.dimCode.metric;
  const lv3Arr=F.dimCode.lv3, lv3Dict=F.dimDict.lv3, lv4Arr=F.dimCode.lv4, lv4Dict=F.dimDict.lv4;
  const gapAcc=new Map();   // 'year|lv3|lv4' -> {rev,den}
  for(let i=0;i<F.n;i++){
    if(sArr[i]!==0) continue;
    const mc=mArr[i]; const isRev=(mc===revCode), isDen=nsipCodes.has(mc);
    if(!isRev&&!isDen) continue;
    const yy=Math.floor(ymArr[i]/100); if(years.indexOf(yy)<0) continue;
    const l3=lv3Dict[lv3Arr[i]]||'', l4=lv4Dict[lv4Arr[i]]||'';
    if(isSubtotal(l3)||isSubtotal(l4)) continue;
    const k=yy+'|'+l3+'|'+l4; let a=gapAcc.get(k); if(!a){a={rev:0,den:0};gapAcc.set(k,a);}
    if(isRev) a.rev+=vArr[i]||0; else a.den+=vArr[i]||0;
  }
  const nsipGaps=years.map(y=>({year:y,count:0,samples:[]}));
  gapAcc.forEach((a,k)=>{ if(!(a.rev>0&&a.den===0)) return;
    const parts=k.split('|'); const g=nsipGaps.find(o=>String(o.year)===parts[0]); if(!g) return;
    g.count++; if(g.samples.length<20) g.samples.push(parts[2]||parts[1]||'(未分类)'); });
  // 财经↔PSI 名称对不上(容错归一后仍无对应;仅诊断展示,不影响取数)
  const psiMismatch={reps:[],lv3:[],lv4:[]}; const S=this.store; const hasPsi=!!(S&&S.n);
  if(hasPsi){
    const setOf=(dict,norm)=>{ const s=new Set(); dict.forEach(v=>{ const n=norm(v); if(n) s.add(n); }); return s; };
    const psiRep=setOf(S.dimDict.repOffice,finPsiRepNorm);
    const psiFam=setOf(S.dimDict.family,finPsiNameNorm);
    const psiSer=setOf(S.dimDict.series,finPsiNameNorm);
    const chk=(dict,norm,target,out)=>{ dict.forEach(v=>{ if(v==null) return; const s=String(v);
      if(s===''||isSubtotal(s)) return; const n=norm(s); if(!n) return;
      if(!target.has(n) && out.length<20 && out.indexOf(s)<0) out.push(s); }); };
    chk(F.dimDict.rep,finPsiRepNorm,psiRep,psiMismatch.reps);
    chk(F.dimDict.lv3,finPsiNameNorm,psiFam,psiMismatch.lv3);
    chk(F.dimDict.lv4,finPsiNameNorm,psiSer,psiMismatch.lv4);
  }
  const out={hasFin:true,hasPsi,
    metricsResolved:{rev:REV,gm:GM,nsipDenoms:nsipNames},
    versions:{forecast:fm.versions||[],bp:fm.bpVersions||[]},
    nsipGaps,psiMismatch,tolerance:100};
  this._finHealthFor=F; this._finHealthCache=out;
  return out;
};

/* 供单测直接验证达成率分母守卫（本文件其余能力挂在 Engine.prototype 上，无需导出） */
if (typeof module !== "undefined" && module.exports) module.exports.attainRate = attainRate;

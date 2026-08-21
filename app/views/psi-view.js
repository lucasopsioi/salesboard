/* ============================================================
   Salesboard — views/psi-view.js
   PSI 视图：apply meta、筛选、日期范围、绘图、配色/堆叠顺序。
   纯搬运：从 app.js 原样剪切，无逻辑改动。
   依赖 common.js（在本文件之前加载）；ymdToDate/isoWeekOf 留在 common.js（report 视图也用）。
   ============================================================ */
'use strict';
// ECharts 主题桥取值器（canvas 不认 CSS 变量，必须给真实色值）
function CT(){ return (typeof window!=='undefined'&&window.SbChartTheme)?window.SbChartTheme:{ink1:()=>'#1A1A1A',ink2:()=>'#5A5F66',ink3:()=>'#8A9099',line:()=>'#E6E8EB',lineSoft:()=>'#F0F1F3',bgElev:()=>'#FFFFFF',register:c=>c}; }

/* ============================================================
   PSI 状态持久化（sb.psi.v1）——第二批-2a。
   PSI 的状态混在共享 state 对象里，此处只挑 PSI 专属字段存/回载：
   筛选(filters)、粒度(gran)、指标(metric)、堆叠维度(stackDim)、图表类型(chartType)、
   数据标签(labels/labelSize/labelColor)、平滑(smooth)、透明度(opacity)、数据单位(unit)、
   图例位置(legendPos)、逐系列配色(colorOverride)。日期范围(rangeFrom/To)不存——随数据全程重置。
   注意：applyMeta 每次数据到达都会重置 state.filters/colorOverride/stackDim/orderSig，
   故回载必须在 applyMeta 重置之后，且只回载一次（psiRestored 守卫）——否则 refresh 会把
   用户当前操作覆盖回旧档。filters 的回载单独在 initFilters() 里做（因其紧随 applyMeta 会清空 filters）。
   ============================================================ */
const PSI_STATE_KEY='sb.psi.v1';
let psiRestored=false;                 // 一次性回载守卫（整会话仅首次数据到达时回载）
let psiRestoredFilters=null;           // 暂存回载的 filters，交给 initFilters 恢复（避免被其 {} 清空）
const PSI_GRANS=['day','week','month'], PSI_CHART_TYPES=['area','line','stackBar','pctBar','groupBar'];
const PSI_METRICS=['sellOut','sellIn','inv','dos'], PSI_UNITS=['one','k','w'], PSI_LEGENDS=['top','bottom','left','right'];
function psiStateSave(){ boardStateSave(PSI_STATE_KEY, ()=>({
  filters: state.filters, metric: state.metric, gran: state.gran, stackDim: state.stackDim,
  chartType: state.chartType, labels: state.labels, labelSize: state.labelSize, labelColor: state.labelColor,
  smooth: state.smooth, opacity: state.opacity, unit: state.unit, legendPos: state.legendPos,
  colorOverride: state.colorOverride }), 500); }
// 回载 PSI 设置到 state（filters 暂存到 psiRestoredFilters，由 initFilters 求交后应用）。
// 仅在 applyMeta 重置各字段之后调用一次。防御：白名单校验 + 类型检查，坏值走默认不覆盖。
function psiStateRestore(){
  if(psiRestored) return; psiRestored=true;
  const o=boardStateLoad(PSI_STATE_KEY); if(!o) return;
  if(PSI_METRICS.includes(o.metric)) state.metric=o.metric;
  if(PSI_GRANS.includes(o.gran)) state.gran=o.gran;
  if(typeof o.stackDim==='string' && state.dims.includes(o.stackDim) && o.stackDim!==state.stackDim){ state.stackDim=o.stackDim; if(typeof buildStackDimOptions==='function') buildStackDimOptions(); }
  if(PSI_CHART_TYPES.includes(o.chartType)) state.chartType=o.chartType;
  if(typeof o.labels==='boolean') state.labels=o.labels;
  if(typeof o.smooth==='boolean') state.smooth=o.smooth;
  if(typeof o.labelSize==='number' && isFinite(o.labelSize)) state.labelSize=Math.min(24,Math.max(8,o.labelSize));
  if(o.labelColor===null || typeof o.labelColor==='string') state.labelColor=o.labelColor;
  if(typeof o.opacity==='number' && o.opacity>=0 && o.opacity<=1) state.opacity=o.opacity;
  if(PSI_UNITS.includes(o.unit)) state.unit=o.unit;
  if(PSI_LEGENDS.includes(o.legendPos)) state.legendPos=o.legendPos;
  if(o.colorOverride && typeof o.colorOverride==='object') state.colorOverride=o.colorOverride;   // 系列名可能已变，colorCss 按名取，脏 key 自然不生效
  if(o.filters && typeof o.filters==='object') psiRestoredFilters=o.filters;                       // filters 交给 initFilters 求交恢复
  // 回载的设置反映到工具栏控件高亮/取值（控件已由 initPsiView 绑定；此处仅同步显示）。
  psiSyncControls();
}
// 把回载后的 state 值同步到 PSI 工具栏控件（tab 高亮 / 下拉值 / 按钮态）。防御：控件不存在则跳过。
function psiSyncControls(){
  const seg=(id,dataAttr,val)=>{ const box=$('#'+id); if(!box) return; box.querySelectorAll('button').forEach(b=>b.classList.toggle('on', b.dataset[dataAttr]===val)); };
  seg('metricTabs','m',state.metric); seg('granSeg','g',state.gran); seg('chartType','t',state.chartType); seg('unitSeg','u',state.unit);
  const lp=$('#legendPos'); if(lp) lp.value=state.legendPos;
  const ls=$('#labelSize'); if(ls) ls.value=state.labelSize;
  const bl=$('#btnLabels'); if(bl){ bl.style.background=state.labels?'var(--c-brand-soft)':''; bl.style.color=state.labels?'var(--c-brand)':''; }
  const bs=$('#btnSmooth'); if(bs){ bs.style.background=state.smooth?'var(--c-brand-soft)':''; bs.style.color=state.smooth?'var(--c-brand)':''; }
}

/* ============================================================
   APPLY META + DRAW
   ============================================================ */
function applyMeta(m){
  if(!m||m.error){ toast('读取失败：'+(m&&m.error||''),'err'); return; }
  state.dims=m.dims||[]; state.from=m.from; state.to=m.to; state.folder=m.folder; state.invFolder=m.invFolder;
  state.files=m.files||[]; state.records=m.records||0; state.lastRefresh=m.lastRefresh; state.hasFlow=m.hasFlow;
  state.finMeta=m.finMeta||null; state.flowDate=m.flowDate; state.finFolder=m.finFolder;
  state.idcMeta=m.idcMeta||null; state.idcFolder=m.idcFolder; state.hasIdc=m.hasIdc;
  updateStatus();
  renderSource();
  // 经营分析(独立于PSI维度)
  if(typeof finStateRestore==='function') finStateRestore();   // 首次数据到达时回载筛选/口径（在 buildFinControls 校正之前）
  fin.last=null; buildFinControls();
  if($('#view-finance').classList.contains('active')) drawFinanceAchieve();
  // 产业看板
  ind.data=null; ind.filters={}; ind.cmp={series:[],product:[],model:[]}; ind.from=null; ind.to=null;
  if(typeof indStateRestore==='function') indStateRestore();   // 首次数据到达时回载筛选/粒度/对比等（重置之后）
  if($('#view-industry').classList.contains('active')) initIndustry();
  // 看板设计器字段面板
  buildDesigner();
  if($('#view-designer').classList.contains('active')) dzRenderCanvas();
  if(!state.dims.length){ showEmpty(true); if(chart)chart.clear(); renderOrderList([]); return; }
  showEmpty(false);
  // 日期范围重置为数据全程，并按当前粒度渲染对应的选择器(日=日期框 / 周=周下拉 / 月=月下拉)
  state.rangeFrom=state.from; state.rangeTo=state.to;
  // default stackDim
  if(!state.dims.includes(state.stackDim)) state.stackDim=['series','line','family','product','region'].find(k=>state.dims.includes(k))||state.dims[0];
  buildStackDimOptions();
  state.orderSig=''; state.colorOverride={};
  // 回载 PSI 设置（只首次数据到达时；在各字段重置之后覆盖；filters 交给 initFilters）。
  // 放在 renderDateRange 之前——restore 可能改 gran，日期范围控件按恢复后的 gran 渲染。
  psiStateRestore();
  renderDateRange();
  // report setup
  rep.filters={}; rep.last=null; rep.fromW=null; rep.toW=null;
  if(typeof repStateRestore==='function') repStateRestore();   // 首次数据到达时回载维度/周数/筛选/排序（在重置之后、buildRepDimOptions 校正之前）
  buildRepDimOptions();
  renderRepFilters();
  if($('#view-report').classList.contains('active')) drawReport();
  // country board reset
  cb.last=[]; cb.filters={}; cb.fromW=null; cb.toW=null;
  buildCbDimOptions();
  if($('#view-country').classList.contains('active')){ renderCbFilters(); drawCountryBoard(); }
  renderDataBar(currentView());
}

async function initFilters(){
  // 默认不锁渠道：渠道留空 = Online+Offline 合计（引擎自动排除 ALL 预汇总行，不重复计算）
  // 若本会话首次数据到达时回载了 filters，则用回载值代替空集；renderFilters 会按当前数据可选项求交剔除脏值。
  state.filters = (psiRestoredFilters && typeof psiRestoredFilters==='object') ? psiRestoredFilters : {};
  psiRestoredFilters=null;   // 只应用一次
  await renderFilters();
}

function updateStatus(){
  const dot=$('#status .dot'); const txt=$('#statusText');
  if(state.folder){
    dot.classList.remove('off');
    const short=state.folder.length>40?('…'+state.folder.slice(-38)):state.folder;
    const when=state.lastRefresh?new Date(state.lastRefresh).toLocaleString('zh-CN',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'}):'';
    const inv=state.invFolder?(' · 📦库存'+(state.hasFlow?'✓':'⚠')):'';
    txt.innerHTML=`<b>${state.records.toLocaleString()}</b> 条 · ${state.files.length} 文件 · <span title="${state.folder}">${short}</span>${inv}${when?(' · '+when):''}`;
  }else if(state.records){
    dot.classList.remove('off'); txt.innerHTML=`<b>${state.records.toLocaleString()}</b> 条（示例数据）`;
  }else{ dot.classList.add('off'); txt.textContent='未锚定文件夹'; }
}

function showEmpty(b){ $('#psiEmpty').classList.toggle('hidden',!b); }

function params(){
  const f={}; Object.keys(state.filters).forEach(k=>{ if(asArrLocal(state.filters[k]).length) f[k]=state.filters[k]; });
  return {metric:state.metric,gran:state.gran,stackDim:state.stackDim,from:state.rangeFrom||state.from,to:state.rangeTo||state.to,filters:f};
}

/* ---------- 日期范围随粒度联动：日=日期框 / 周=周下拉(带日期) / 月=月下拉 ---------- */
function dStr(dt){ return dt.getFullYear()+'-'+String(dt.getMonth()+1).padStart(2,'0')+'-'+String(dt.getDate()).padStart(2,'0'); }
function enumMonths(fromS,toS){ const a=ymdToDate(fromS),b=ymdToDate(toS); const out=[]; let y=a.getFullYear(),m=a.getMonth(),g=0;
  while((y<b.getFullYear()||(y===b.getFullYear()&&m<=b.getMonth()))&&g++<600){ out.push({label:(y%100)+'年'+(m+1)+'月',start:dStr(new Date(y,m,1)),end:dStr(new Date(y,m+1,0))}); m++; if(m>11){m=0;y++;} } return out; }
function enumWeeks(fromS,toS){ let d=ymdToDate(fromS); d.setDate(d.getDate()-((d.getDay()+6)%7)); const end=ymdToDate(toS); const out=[]; let g=0; const md=x=>(x.getMonth()+1)+'/'+x.getDate();
  while(d<=end&&g++<3000){ const mon=new Date(d),sun=new Date(d); sun.setDate(sun.getDate()+6); const w=isoWeekOf(mon); out.push({label:w[0]+'年W'+String(w[1]).padStart(2,'0')+'（'+md(mon)+'~'+md(sun)+'）',start:dStr(mon),end:dStr(sun)}); d.setDate(d.getDate()+7); } return out; }
function renderDateRange(){
  const wrap=$('#dateRangeWrap'); if(!wrap) return;
  if(!state.from||!state.to){ wrap.innerHTML=''; return; }
  if(!state.rangeFrom) state.rangeFrom=state.from; if(!state.rangeTo) state.rangeTo=state.to;
  if(state.gran==='day'){
    wrap.innerHTML='<span class="fld"><label>从</label><input type="date" id="dateFrom"></span><span class="fld"><label>到</label><input type="date" id="dateTo"></span>';
    const f=$('#dateFrom'),t=$('#dateTo'); f.min=t.min=state.from; f.max=t.max=state.to; f.value=state.rangeFrom; t.value=state.rangeTo;
    f.onchange=()=>{ state.rangeFrom=f.value; if(state.rangeTo<state.rangeFrom){state.rangeTo=state.rangeFrom;t.value=t.value;} draw(); };
    t.onchange=()=>{ state.rangeTo=t.value; draw(); };
  } else {
    const list=state.gran==='week'?enumWeeks(state.from,state.to):enumMonths(state.from,state.to);
    if(!list.length){ wrap.innerHTML=''; return; }
    let fi=list.findIndex(o=>o.start<=state.rangeFrom&&o.end>=state.rangeFrom); if(fi<0)fi=0;
    let ti=list.findIndex(o=>o.start<=state.rangeTo&&o.end>=state.rangeTo); if(ti<0)ti=list.length-1;
    if(ti<fi) ti=fi;
    const opts=list.map((o,i)=>`<option value="${i}">${o.label}</option>`).join('');
    wrap.innerHTML=`<span class="fld"><label>从</label><select id="rgFrom" class="rg-sel">${opts}</select></span><span class="fld"><label>到</label><select id="rgTo" class="rg-sel">${opts}</select></span>`;
    $('#rgFrom').value=fi; $('#rgTo').value=ti; state.rangeFrom=list[fi].start; state.rangeTo=list[ti].end;
    $('#rgFrom').onchange=e=>{ let i=+e.target.value,j=+$('#rgTo').value; if(j<i){j=i;$('#rgTo').value=i;} state.rangeFrom=list[i].start; state.rangeTo=list[j].end; draw(); };
    $('#rgTo').onchange=e=>{ let j=+e.target.value,i=+$('#rgFrom').value; if(j<i){i=j;$('#rgFrom').value=j;} state.rangeFrom=list[i].start; state.rangeTo=list[j].end; draw(); };
  }
}

async function draw(){
  if(!state.dims.length){ showEmpty(true); return; }
  const token=++drawToken;
  const res=await api.query(params());
  if(token!==drawToken) return;
  if(res.error){ toast('查询出错：'+res.error,'err'); return; }
  state.lastQuery=res;
  if(!res.series.length){ if(chart)chart.clear(); renderOrderList([]); renderPsiStats(); $('#viewSub')&&($('#viewSub').textContent=''); showEmpty(false);
    drawEmptyHint(); return; }
  ensureOrder(res.series);
  applySavedOrder();          // 读回该维度记忆的顺序（记住的在前，新出现的排后）
  renderOrderList(state.stackOrder);
  drawChart();
}
function drawEmptyHint(){
  if(!chart) chart=echarts.init($('#psiChart'));
  chart.setOption({textStyle:{fontFamily:YH},title:{text:'当前筛选无数据',left:'center',top:'center',textStyle:{color:'#8A9099',fontSize:14,fontFamily:YH}}},true);
}

function drawChart(){
  const res=state.lastQuery; if(!res) return;
  if(!chart){ chart=echarts.init($('#psiChart')); window.addEventListener('resize',()=>chart&&chart.resize());
    chart.on('click',p=>{ if(p&&p.seriesName&&p.seriesName!=='__total') openColorPop(p.seriesName, p.event&&p.event.event); }); }
  const order=state.stackOrder, buckets=res.buckets, data=res.data, type=state.chartType, op=state.opacity;
  const val=(name,b)=>+((data[name]&&data[name][b])||0).toFixed(2);
  const stacked=(type==='area'||type==='stackBar'||type==='pctBar');
  let totals=null;
  if(type==='pctBar') totals=buckets.map(b=>order.reduce((s,n)=>s+val(n,b),0));
  const cellVal=(name,b,bi)=>{ const v=val(name,b); if(type==='pctBar'){ const t=totals[bi]; return t>0?+(v/t*100).toFixed(2):0; } return v; };
  // stacked charts paint premium(order[0]) on top -> add last; line/groupBar keep order
  const seriesOrder = stacked ? order.slice().reverse() : order.slice();
  // 标签：深色字+白描边，任何背景都清晰；折线/面积用 top(inside对折线系列常不渲染)，柱内用 inside
  const lstyle=PsiChart.labelStyle(state);
  const lab={show:state.labels,fontFamily:YH,fontSize:lstyle.size,fontWeight:'bold',color:lstyle.color||undefined,formatter:p=> type==='pctBar'?(p.value?Math.round(p.value)+'%':''):unitFmt(p.value)};
  const ec=seriesOrder.map(name=>{
    const dat=buckets.map((b,bi)=>cellVal(name,b,bi));
    if(type==='line') return {name,type:'line',smooth:state.smooth,symbol:'none',lineStyle:{width:2,color:colorCss(name)},itemStyle:{color:colorCss(name)},emphasis:{focus:'series'},label:{show:false},data:dat};
    if(type==='area') return {name,type:'line',stack:'psi',smooth:state.smooth,symbol:'none',lineStyle:{width:1,color:'#fff',opacity:.6},areaStyle:{color:colorRgba(name,op)},itemStyle:{color:colorCss(name)},emphasis:{focus:'series'},label:{show:false},data:dat};
    // bars：分组柱用原生顶部标签(对齐每根柱)；堆积柱/占比柱关掉原生标签，改用下方散点覆盖层(保证薄段也显示)
    const isGroup=(type==='groupBar');
    return {name,type:'bar',stack:(type==='stackBar'||type==='pctBar')?'psi':undefined,itemStyle:{color:colorRgba(name,op),borderColor:'#fff',borderWidth:0.4},emphasis:{focus:'series'},label: isGroup?Object.assign({},lab,{position:'top',color:'#1A1A1A',textBorderWidth:0}):{show:false},data:dat};
  });
  // 数据标签覆盖层(散点的标签一定渲染)：堆叠类画在每段中点(白字)、折线画在每个点上方(深字)，全部平铺、不会被盖住、薄段也显示
  if(state.labels && (stacked || type==='line')){
    const pts=[];
    if(stacked){ buckets.forEach((b,bi)=>{ let cum=0; seriesOrder.forEach(name=>{ const cv=cellVal(name,b,bi); if(cv>0){ pts.push({value:[bi, cum+cv/2], lbl: type==='pctBar'? (Math.round(cv)+'%') : unitFmt(val(name,b)) }); } cum+=cv; }); }); }
    else { buckets.forEach((b,bi)=>{ seriesOrder.forEach(name=>{ pts.push({value:[bi, val(name,b)], lbl: unitFmt(val(name,b)) }); }); }); }
    ec.push({type:'scatter',data:pts,symbolSize:1,itemStyle:{color:'transparent'},silent:true,tooltip:{show:false},legendHoverLink:false,z:28,
      label:{show:true,position:stacked?'inside':'top',color:lstyle.color||(stacked?'#fff':'#1A1A1A'),fontFamily:YH,fontSize:lstyle.size,fontWeight:'bold',textBorderWidth:0,formatter:p=>p.data.lbl}});
  }
  // 合计标签：堆叠图(面积/堆积柱)在每个时间点顶部显示总数；给 Y 轴留余量，标签不被图顶裁掉
  let yMax = type==='pctBar'?100:null;
  let yMin = type==='pctBar'?0:null;   // 与 yMax 成对：钉了 max 就必须钉 min，否则 ECharts 会反推出负的 min
  if(state.labels && (type==='area'||type==='stackBar')){
    const tot=PsiChart.bucketTotals(order,buckets,(n,b)=>val(n,b));
    const hm=PsiChart.yAxisMax(tot); if(hm!=null){ yMax=hm; yMin=PsiChart.yAxisMin(tot); }
    ec.push({name:'__total',type:'line',symbol:'none',lineStyle:{opacity:0},areaStyle:undefined,silent:true,tooltip:{show:false},legendHoverLink:false,
      label:{show:true,position:'top',distance:7,color:lstyle.color||'#1A1A1A',fontFamily:YH,fontSize:lstyle.size+0.5,fontWeight:'bold',formatter:p=>'∑ '+unitFmt(tot[p.dataIndex])},
      data:tot, z:30});
  }
  chart.setOption({
    textStyle:{fontFamily:YH}, color:order.map(colorCss),
    tooltip:{trigger:'axis',backgroundColor:'rgba(26,26,26,.92)',borderWidth:0,textStyle:{color:'#fff',fontFamily:YH,fontSize:12},
      formatter:ps=>{ps=ps.filter(p=>!String(p.seriesName).startsWith('__')); if(!ps.length) return ''; const bi=buckets.indexOf(ps[0].axisValue);let s='<b>'+ps[0].axisValue+'</b>';
        if(type!=='pctBar'){let tot=0;ps.forEach(p=>tot+=p.value||0);s+='　合计 '+fmt(tot);}
        s+='<br>'; ps.slice().reverse().forEach(p=>{ const raw=type==='pctBar'?val(p.seriesName,buckets[bi]):p.value; s+=p.marker+p.seriesName+'：<b>'+fmt(raw)+'</b>'+(type==='pctBar'?('（'+Math.round(p.value)+'%）'):'')+'<br>'; }); return s;}},
    legend:Object.assign({data:order,type:'scroll',textStyle:{fontFamily:YH,fontSize:11,color:'#5A5F66'},itemWidth:13,itemHeight:9,icon:'roundRect'},
      LEGEND_POS[state.legendPos]||LEGEND_POS.top),
    dataZoom:[{type:'inside',zoomOnMouseWheel:'ctrl',moveOnMouseMove:false,moveOnMouseWheel:false,filterMode:'none'}],
    grid:legendGrid(state.legendPos),
    xAxis:{type:'category',data:buckets,boundaryGap:(type!=='line'&&type!=='area'),axisLabel:{fontFamily:YH,color:'#8A9099',fontSize:11},axisLine:{lineStyle:{color:'#E6E8EB'}},axisTick:{show:false}},
    yAxis:{type:'value',min:yMin,max:yMax,axisLabel:{fontFamily:YH,color:CT().ink3(),fontSize:11,formatter:v=>type==='pctBar'?v+'%':unitFmt(v)},splitLine:{lineStyle:{color:CT().lineSoft()}}},
    animationDuration:350, series:ec,
  },true);
  const note = res.capped? ('（'+res.total+'个系列，仅显示前'+(MAX_SERIES-1)+'大，其余归「其他」）'):'';
  $('#viewSub').textContent = METRIC_LABEL[state.metric]+' · 按'+DIM_LABEL[state.stackDim]+(stacked?'堆叠':'对比')+' · '+state.records.toLocaleString()+'条'+note;
  const oh=$('#orderHead'); if(oh) oh.innerHTML='按【<b style="color:var(--c-brand)">'+DIM_LABEL[state.stackDim]+'</b>】配色（点色块改色 · ▲▼调顺序）';
  renderPsiStats();   // 左侧区间统计(纯新增)——放绘图末尾:指标/筛选/范围/单位/顺序任何变化都同步刷新
}

/* ---------- 左侧区间统计(纯新增):随筛选/系列/日期范围联动 ----------
   数据直接取 state.lastQuery(query 已按 rangeFrom/To 截过区间,渠道全加不去重),
   计算在 PsiStats 纯函数(可单测):流量=区间累计,库存=区间末值,DOS合计不可加。 ---- */
function renderPsiStats(){
  const host=$('#psiStats'); if(!host) return;
  const res=state.lastQuery;
  if(!res || !res.series || !res.series.length){ host.innerHTML='<div class="s" style="color:var(--ink3);font-size:11px;padding:2px 2px 4px">当前筛选无数据</div>'; return; }
  const st=window.PsiStats.compute(res, state.metric);
  const isDos=state.metric==='dos';
  const fv=v=>isDos ? (Math.round(v)+'天') : (unitFmt(v)+'台');
  const rangeTxt=(state.rangeFrom||state.from||'')+' ~ '+(state.rangeTo||state.to||'');
  // 系列卡按图表堆叠顺序排(与配色顺序一致)
  const order=(state.stackOrder&&state.stackOrder.length)?state.stackOrder.filter(n=>res.series.includes(n)):res.series;
  const byName={}; st.series.forEach(s=>byName[s.name]=s);
  let h='<div class="s" style="padding:0 2px 4px">'+rangeTxt+' · '+st.periods+'期</div>';
  // 合计卡(DOS 不可加显示—)
  h+='<div class="psi-stat tot"><div class="n">全部系列合计</div>'+
     '<div class="v">'+(st.total==null?'—':fv(st.total))+'</div>'+
     '<div class="s">'+(st.peak&&st.peak.bucket?('峰值期 '+st.peak.bucket+' · '+fv(st.peak.val)):(isDos?'DOS为比率,合计需按库存÷日均SO重算':''))+'</div></div>';
  order.forEach(nm=>{
    const s=byName[nm]; if(!s) return;
    const sub = st.kind==='flow'
      ? ('峰值 '+(s.peakBucket||'—')+' · '+fv(s.peakVal)+'　均值 '+fv(s.avg||0)+'/期')
      : ('区间峰值 '+(s.peakBucket||'—')+' · '+fv(s.peakVal));
    h+='<div class="psi-stat"><div class="n"><span class="dot" style="background:'+colorCss(nm)+'"></span>'+nm+'</div>'+
       '<div class="v">'+fv(s.val)+'</div>'+
       '<div class="s">'+window.PsiStats.valLabel(state.metric)+' · '+sub+'</div></div>';
  });
  host.innerHTML=h;
}

/* ---------- 堆叠顺序记忆：localStorage『sb.psi.order.v1』按堆叠维度分组存；
   sb.* 前缀会被 archive.js 自动纳入版本存档，跨 app 版本继承 ---------- */
const PSI_ORDER_LS='sb.psi.order.v1';
function loadOrderMap(){ try{ return JSON.parse(localStorage.getItem(PSI_ORDER_LS)||'{}')||{}; }catch(e){ return {}; } }
function saveStackOrder(){ try{ const m=loadOrderMap(); m[state.stackDim]=state.stackOrder.slice(); localStorage.setItem(PSI_ORDER_LS,JSON.stringify(m)); }catch(e){} }
// 记住的产品按记忆顺序排前，当前新出现/筛选带出的产品保持默认相对顺序排后（筛选变化/新品不会打乱记忆）
function mergeSavedOrder(saved,current){
  if(!saved||!saved.length) return current.slice();
  const cur=new Set(current), head=saved.filter(s=>cur.has(s)), hs=new Set(head);
  return head.concat(current.filter(s=>!hs.has(s)));
}
function applySavedOrder(){ const saved=loadOrderMap()[state.stackDim]; if(saved&&saved.length) state.stackOrder=mergeSavedOrder(saved,state.stackOrder); }
function resetStackOrder(){ try{ const m=loadOrderMap(); delete m[state.stackDim]; localStorage.setItem(PSI_ORDER_LS,JSON.stringify(m)); }catch(e){} state.orderSig=''; draw(); toast('已重置为默认顺序','ok'); }
function renderOrderList(order){
  const el=$('#orderList');
  if(!order||!order.length){ el.innerHTML='<div style="color:var(--c-ink-3);font-size:12px;padding:14px 8px">导入数据后显示堆叠系列</div>'; return; }
  el.innerHTML='';
  order.forEach((name,i)=>{
    const row=document.createElement('div'); row.className='order-item';
    row.innerHTML=`<input type="color" class="sw" data-c="${name}" value="#${colorHex(name)}" title="点击自定义颜色"><span class="nm" title="${name}">${name}</span><span class="mv"><button data-up="${i}">▲</button><button data-dn="${i}">▼</button></span>`;
    el.appendChild(row);
  });
  el.querySelectorAll('[data-up]').forEach(b=>b.onclick=()=>moveOrder(+b.dataset.up,-1));
  el.querySelectorAll('[data-dn]').forEach(b=>b.onclick=()=>moveOrder(+b.dataset.dn,1));
  el.querySelectorAll('input.sw').forEach(inp=>inp.oninput=()=>{ state.colorOverride[inp.dataset.c]=inp.value; drawChart(); psiStateSave(); });
}
function moveOrder(i,dir){const a=state.stackOrder,j=i+dir;if(j<0||j>=a.length)return;[a[i],a[j]]=[a[j],a[i]];saveStackOrder();renderOrderList(a);drawChart();}
const PSI_SWATCHES=['#C7000B','#E63340','#F08200','#E0A400','#1E9E57','#0E9AA7','#2563C9','#5A7FB5','#7A4FBF','#D24DAA','#C77A00','#3FA796','#9CA2A8','#5A5F66','#1A1A1A','#000000'];
function openColorPop(name, ev){
  const pop=$('#psiColorPop'); if(!pop) return;
  const cur='#'+colorHex(name);
  pop.innerHTML=`<span class="cp-x" id="cpX">✕</span><div class="cp-title" title="${name}">🎨 ${name}</div>`
    +`<div class="cp-row"><input type="color" id="cpColor" value="${cur}"><input type="text" id="cpHex" class="cp-hex" value="${cur}"></div>`
    +`<div class="cp-sw">${PSI_SWATCHES.map(c=>`<span data-c="${c}" style="background:${c}" title="${c}"></span>`).join('')}</div>`;
  let x=ev?ev.clientX+6:240, y=ev?ev.clientY+6:160; const w=210,h=170;
  if(x+w>window.innerWidth-8) x=window.innerWidth-w-8; if(y+h>window.innerHeight-8) y=window.innerHeight-h-8;
  pop.style.left=Math.max(8,x)+'px'; pop.style.top=Math.max(8,y)+'px'; pop.classList.remove('hidden');
  const apply=v=>{ if(!/^#[0-9a-fA-F]{6}$/.test(v)) return; v=v.toUpperCase(); state.colorOverride[name]=v; const ci=$('#cpColor'),hi=$('#cpHex'); if(ci)ci.value=v; if(hi)hi.value=v; drawChart(); renderOrderList(state.stackOrder); psiStateSave(); };
  $('#cpColor').oninput=e=>apply(e.target.value);
  $('#cpHex').oninput=e=>apply(e.target.value.trim());
  pop.querySelectorAll('.cp-sw span').forEach(s=>s.onclick=()=>apply(s.dataset.c));
  $('#cpX').onclick=()=>pop.classList.add('hidden');
}

/* ---------- filters (cascading via IPC) ---------- */
function buildStackDimOptions(){
  const sel=$('#stackDim'); sel.innerHTML='';
  state.dims.forEach(k=>{const o=document.createElement('option');o.value=k;o.textContent=DIM_LABEL[k]||k;if(k===state.stackDim)o.selected=true;sel.appendChild(o);});
}
async function renderFilters(){
  const bar=$('#filterBar'); bar.innerHTML='';
  for(const field of FILTER_FIELDS.filter(k=>state.dims.includes(k))){
    const opts=sortByHier(field, await api.options(field,state.filters));   // 按层级顺序排，不按拼音
    if(!opts.length) continue;
    // 级联：剔除因上游筛选而失效的已选值
    let cur=asArrLocal(state.filters[field]).filter(v=>opts.includes(v));
    if(cur.length) state.filters[field]=cur; else delete state.filters[field];
    const ms=makeMultiSelect(DIM_LABEL[field]+(field===state.stackDim?' ◆ 堆叠维度':''), opts, cur, {
      placeholder: field==='channel'?'线上+线下(合计)':'全部',
      onChange:(vals)=>{ state.filters[field]=vals; draw(); psiStateSave(); },
      onCommit:async(vals)=>{ state.filters[field]=vals; await renderFilters(); draw(); psiStateSave(); },
    });
    bar.appendChild(ms);
  }
}

/* ---------- exports ---------- */
const CHART_LABEL={area:'堆积面积图',line:'折线图',stackBar:'堆积柱形图',pctBar:'柱形占比图(100%)',groupBar:'分组柱形图'};
function openPreview(){
  const res=state.lastQuery; if(!res||!res.buckets.length){ toast('当前无数据可导出','err'); return; }
  if(!chart){ toast('图表未就绪','err'); return; }
  const url=chart.getDataURL({pixelRatio:2,backgroundColor:'#ffffff'});
  $('#previewImg').src=url;
  $('#previewSub').textContent=METRIC_LABEL[state.metric]+' · '+CHART_LABEL[state.chartType]+' · 按'+DIM_LABEL[state.stackDim];
  $('#previewModal').classList.remove('hidden');
}
function closePreview(){ $('#previewModal').classList.add('hidden'); }
async function doExportPPT(){
  closePreview();
  const res=state.lastQuery; if(!res||!res.buckets.length) return;
  const order=state.stackOrder, buckets=res.buckets, data=res.data, type=state.chartType;
  const _div=unitInfo().div;   // 导出按所选单位换算数值(不带后缀)：万台→/10000、千台→/1000
  const val=(name,b)=>+((((data[name]&&data[name][b])||0))/_div).toFixed(_div===1?2:3);
  const pptx=new PptxGenJS(); pptx.defineLayout({name:'W',width:13.333,height:7.5}); pptx.layout='W';
  const RED='C7000B';
  let s=pptx.addSlide(); s.background={color:'FFFFFF'};
  s.addShape(pptx.ShapeType.rect,{x:0,y:0,w:13.333,h:1.4,fill:{color:RED}});
  s.addText('PSI 趋势分析',{x:0.6,y:0.3,w:12,h:0.8,fontFace:'微软雅黑',fontSize:30,bold:true,color:'FFFFFF'});
  s.addText(METRIC_LABEL[state.metric]+'　'+CHART_LABEL[type]+'　按'+DIM_LABEL[state.stackDim]+'　粒度：'+({day:'日',week:'周',month:'月'}[state.gran]),{x:0.6,y:1.0,w:12,h:0.4,fontFace:'微软雅黑',fontSize:13,color:'FFFFFF'});
  const ftxt=Object.entries(state.filters).filter(([k,v])=>v).map(([k,v])=>DIM_LABEL[k]+'：'+v).join('　|　')||'（无筛选）';
  s.addText('筛选：'+ftxt+'\n时间：'+(state.rangeFrom||state.from)+' ~ '+(state.rangeTo||state.to),{x:0.6,y:1.7,w:12,h:0.7,fontFace:'微软雅黑',fontSize:12,color:'5A5F66'});
  s=pptx.addSlide();
  s.addText(METRIC_LABEL[state.metric]+' · '+CHART_LABEL[type],{x:0.5,y:0.25,w:12,h:0.5,fontFace:'微软雅黑',fontSize:18,bold:true,color:'1A1A1A'});
  // 100% 占比图：把数值换算成百分比后导出（PPT percentStacked 也可，但我们直接给百分比更直观）
  // 用 buildPptxSeries 统一构建：cd 已按堆叠反转(Base 在底)，colors 对齐；total/valMax 用于总计折线+Y 轴余量
  const lstyle=PsiChart.labelStyle(state);
  const bs=PsiChart.buildPptxSeries(order,buckets,(n,b)=>val(n,b),{chartType:type,labels:state.labels,colorHexFn:colorHex});
  const cd=bs.cd, colors=bs.colors;
  const common={x:0.5,y:0.9,w:12.3,h:6.2,chartColors:colors,chartColorsOpacity:Math.round(state.opacity*100),
    showLegend:true,legendPos:'b',legendFontFace:'微软雅黑',legendFontSize:10,showValue:state.labels,
    dataLabelFontFace:'微软雅黑',dataLabelFontSize:lstyle.size,
    catAxisLabelFontFace:'微软雅黑',catAxisLabelFontSize:9,
    valAxisLabelFontFace:'微软雅黑',valAxisLabelFontSize:9,showTitle:false};
  if(lstyle.color) common.dataLabelColor=lstyle.color.replace('#','');
  if(bs.valMax!=null) common.valAxisMaxVal=Math.round(bs.valMax);
  let ctype, opts;
  if(type==='line'){ ctype=pptx.ChartType.line; opts=Object.assign({lineSmooth:state.smooth,lineSize:2,lineDataSymbol:'none'},common); }
  else if(type==='area'){ ctype=pptx.ChartType.area; opts=Object.assign({barGrouping:'stacked',lineSmooth:state.smooth,dataLabelColor:'FFFFFF'},common); }
  else if(type==='stackBar'){ ctype=pptx.ChartType.bar; opts=Object.assign({barDir:'col',barGrouping:'stacked',dataLabelColor:'FFFFFF'},common); }
  else if(type==='pctBar'){ ctype=pptx.ChartType.bar; opts=Object.assign({barDir:'col',barGrouping:'percentStacked',dataLabelColor:'FFFFFF',valAxisMaxVal:100},common); }
  else { ctype=pptx.ChartType.bar; opts=Object.assign({barDir:'col',barGrouping:'clustered'},common); }
  if(bs.total){
    // 总计：第二图层折线，无线无点、仅顶部标签，等价于手工"加总计列+无填充+调Y轴"
    const totOpts=Object.assign({},opts,{chartColors:['FFFFFF'],lineSize:0,lineDataSymbol:'none',lineSmooth:false,
      showValue:true,showLegend:true,dataLabelColor:lstyle.color?lstyle.color.replace('#',''):'1A1A1A',dataLabelPosition:'t'});
    s.addChart([{type:ctype,data:cd,options:opts},{type:pptx.ChartType.line,data:[bs.total],options:totOpts}],opts);
  } else {
    s.addChart(ctype,cd,opts);
  }
  const fn='PSI_'+state.metric+'_'+CHART_LABEL[type]+'_'+todayStr()+'.pptx';
  const b64=await pptx.write('base64');
  const r=await api.saveFile(fn,b64,'pptx');
  if(r&&r.path) toast('已导出 '+fn+'（PPT 里可二次编辑）','ok'); else if(!r||!r.canceled) toast('导出失败','err');
}
async function exportPNG(){
  // 直接落 echarts 当前画面：平滑/配色/标签/图例/单位 所见即所得（与预览图同一套参数：2倍分辨率、白底）
  const res=state.lastQuery; if(!res||!res.buckets.length){ toast('当前无数据可导出','err'); return; }
  if(!chart){ toast('图表未就绪','err'); return; }
  const b64=chart.getDataURL({type:'png',pixelRatio:2,backgroundColor:'#ffffff'}).split(',')[1];
  closePreview();
  const fn='PSI_'+state.metric+'_'+CHART_LABEL[state.chartType]+'_'+todayStr()+'.png';
  const r=await api.saveFile(fn,b64,'png');
  if(r&&r.path) toast('已导出 '+fn,'ok'); else if(!r||!r.canceled) toast('导出失败','err');
}
async function exportXLSX(){
  const res=state.lastQuery; if(!res||!res.buckets.length){ toast('当前无数据可导出','err'); return; }
  const order=state.stackOrder, buckets=res.buckets, data=res.data;
  const _div=unitInfo().div;   // 按所选单位换算(不带后缀)
  const v=(s,b)=>+((((data[s]&&data[s][b])||0))/_div).toFixed(_div===1?2:3);
  const aoa=[['周期'].concat(order)];
  buckets.forEach(b=>aoa.push([b].concat(order.map(s=>v(s,b)))));
  aoa.push(['合计'].concat(order.map(s=>+buckets.reduce((a,b)=>a+v(s,b),0).toFixed(_div===1?2:3))));
  const unitTxt={one:'单台(原值)',k:'千台(已÷1000)',w:'万台(已÷10000)'}[state.unit]||'单台';
  const guide=XLSX.utils.aoa_to_sheet([['Salesboard · PSI 数据导出'],[],['指标',METRIC_LABEL[state.metric]],['堆叠维度',DIM_LABEL[state.stackDim]],['粒度',{day:'日',week:'周',month:'月'}[state.gran]],['数据单位',unitTxt],['时间',(state.rangeFrom||state.from)+' ~ '+(state.rangeTo||state.to)],[],['做堆积面积图：选「数据」表全选 → 插入 → 面积图 → 堆积面积图']]);
  const wb=XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb,XLSX.utils.aoa_to_sheet(aoa),'数据'); XLSX.utils.book_append_sheet(wb,guide,'使用说明');
  const b64=XLSX.write(wb,{bookType:'xlsx',type:'base64'});
  const fn='PSI_'+state.metric+'_'+todayStr()+'.xlsx';
  const r=await api.saveFile(fn,b64,'xlsx');
  if(r&&r.path) toast('已导出 '+fn,'ok'); else if(!r||!r.canceled) toast('导出失败','err');
}

/* ============================================================
   PSI 视图事件绑定（从 app.js init() 原样搬入）
   ============================================================ */
function initPsiView(){
  $('#metricTabs').querySelectorAll('button').forEach(b=>b.onclick=()=>{$('#metricTabs').querySelectorAll('button').forEach(x=>x.classList.remove('on'));b.classList.add('on');state.metric=b.dataset.m;draw();psiStateSave();});
  $('#granSeg').querySelectorAll('button').forEach(b=>b.onclick=()=>{$('#granSeg').querySelectorAll('button').forEach(x=>x.classList.remove('on'));b.classList.add('on');state.gran=b.dataset.g;renderDateRange();draw();psiStateSave();});
  // 日期范围控件(日期框/周下拉/月下拉)由 renderDateRange() 动态创建并绑定
  $('#stackDim').onchange=e=>{state.stackDim=e.target.value;state.orderSig='';draw();psiStateSave();};
  $('#btnLabels').onclick=function(){state.labels=!state.labels;this.style.background=state.labels?'var(--c-brand-soft)':'';this.style.color=state.labels?'var(--c-brand)':'';drawChart();psiStateSave();};
  if(state.labels){ $('#btnLabels').style.background='var(--c-brand-soft)'; $('#btnLabels').style.color='var(--c-brand)'; }
  const ls=$('#labelSize'); if(ls){ ls.value=state.labelSize; ls.onchange=()=>{ state.labelSize=Math.min(24,Math.max(8,+ls.value||12)); ls.value=state.labelSize; drawChart(); psiStateSave(); }; }
  const lc=$('#labelColor'); if(lc){ lc.oninput=()=>{ state.labelColor=lc.value; drawChart(); psiStateSave(); }; }
  const lca=$('#labelColorAuto'); if(lca){ lca.onclick=()=>{ state.labelColor=null; drawChart(); psiStateSave(); }; }
  $('#btnSmooth').onclick=function(){state.smooth=!state.smooth;this.style.background=state.smooth?'var(--c-brand-soft)':'';this.style.color=state.smooth?'var(--c-brand)':'';drawChart();psiStateSave();};
  $('#btnSmooth').style.background='var(--c-brand-soft)'; $('#btnSmooth').style.color='var(--c-brand)';
  // 数据单位（单台/千台K/万台W）
  $('#unitSeg').querySelectorAll('button').forEach(b=>b.onclick=()=>{$('#unitSeg').querySelectorAll('button').forEach(x=>x.classList.remove('on'));b.classList.add('on');state.unit=b.dataset.u;drawChart();psiStateSave();});
  // 图例位置（顶部居中默认）
  $('#legendPos').value=state.legendPos; $('#legendPos').onchange=e=>{ state.legendPos=e.target.value; drawChart(); psiStateSave(); };
  // 点图外关闭取色框
  document.addEventListener('mousedown',e=>{ const pop=$('#psiColorPop'); if(pop&&!pop.classList.contains('hidden')&&!pop.contains(e.target)&&!(e.target.closest&&e.target.closest('#psiChart'))) pop.classList.add('hidden'); });
  $('#btnExportPpt').onclick=openPreview;
  $('#btnExportXlsx').onclick=exportXLSX;
  // chart type
  $('#chartType').querySelectorAll('button').forEach(b=>b.onclick=()=>{$('#chartType').querySelectorAll('button').forEach(x=>x.classList.remove('on'));b.classList.add('on');state.chartType=b.dataset.t;drawChart();psiStateSave();});
  // opacity
  $('#opacity').oninput=e=>{ state.opacity=(+e.target.value)/100; drawChart(); psiStateSave(); };
  // reset colors
  $('#btnResetColors').onclick=()=>{ state.colorOverride={}; renderOrderList(state.stackOrder); drawChart(); psiStateSave(); toast('已恢复默认配色','ok'); };
  // 注入「↺ 重置顺序」按钮到「重置配色」旁（index.html 共享，不改 HTML，用 JS 插入）
  if(!$('#btnResetOrder')){ const rc=$('#btnResetColors'); if(rc){ const b=document.createElement('button'); b.className='btn ghost'; b.id='btnResetOrder'; b.title='恢复当前堆叠维度的默认顺序'; b.textContent='↺ 重置顺序'; b.onclick=resetStackOrder; rc.parentNode.insertBefore(b,rc); } }
  // preview modal
  $('#previewClose').onclick=closePreview;
  $('#previewCancel').onclick=closePreview;
  $('#previewConfirm').onclick=doExportPPT;
  // 注入「保存为图片 (PNG)」按钮（index.html 是共享文件，不改 HTML，改用 JS 插入）
  if(!$('#previewPng')){
    const pngBtn=document.createElement('button');
    pngBtn.className='btn'; pngBtn.id='previewPng'; pngBtn.textContent='💾 保存为图片 (PNG)';
    pngBtn.onclick=exportPNG;
    const cf=$('#previewConfirm'); cf.parentNode.insertBefore(pngBtn,cf);
  }
  $('#previewModal').addEventListener('click',e=>{ if(e.target.id==='previewModal') closePreview(); });
}

/* 供单测 require（浏览器端 module 未定义，自动跳过；不影响运行时） */
if(typeof module!=='undefined'&&module.exports){ module.exports={mergeSavedOrder}; }

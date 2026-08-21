/* ============================================================
   产业看板 (音频 / 平板) — industry-view.js
   纯搬运：从 app.js 原样剪切，无逻辑改动。
   依赖 common.js（UNIT_OPT/api/$/$$/makeMultiSelect/sortByHier/asArrLocal/DIM_LABEL/YH/todayStr 等）
   及 app.js 之前加载的 state / FinCalc / ExportUtil；在 common.js 之后、app.js 之前加载。
   事件绑定见文件末尾 initIndustryView()（由 app.js init() 调用）。
   ============================================================ */
'use strict';
// ECharts 主题桥取值器（canvas 不认 CSS 变量，必须给真实色值）
function CT(){ return (typeof window!=='undefined'&&window.SbChartTheme)?window.SbChartTheme:{ink1:()=>'#1A1A1A',ink2:()=>'#5A5F66',ink3:()=>'#8A9099',line:()=>'#E6E8EB',lineSoft:()=>'#F0F1F3',bgElev:()=>'#FFFFFF',register:c=>c}; }
/* 产业看板：级联筛选(产业→国家办→国家 / 产品系列→产品→型号，均多选) + 对比(去年灰线) + 今年vs去年单指标趋势 */
const IND_PSI_LAB={sellIn:'Sell In',sellOut:'Sell Out',inv:'Inventory',dos:'DOS'};
const IND_FLD_LAB={line:'Product Line',family:'Product Family',repOffice:'Rep Office',country:'Country',series:'Product Series',product:'Product',model:'Product Model'};
const ind={indDim:'line',filters:{},cmp:{series:[],product:[],model:[]},metric:'sellOut',gran:'month',
  color:SB_COLORS.brand,colorPrev:'#B9BEC6',unit:'one',smooth:true,from:null,to:null,chart:null,data:null,fullPeriods:[],
  // 两代产品生命周期对齐对比(纯新增区块的运行态,不进持久化存档)
  lc:{dim:'product',a:null,b:null,la:'',lb:'',gran:'day',n:null,metric:'sellOut',data:null},lcChart:null};

/* ---- 状态持久化（sb.industry.v1）——第二批-2a。
   存 ind 的：filters/cmp/metric/gran/unit/smooth/color/from/to。indDim/chart/data/fullPeriods 是运行态或随数据，不存。
   applyMeta 每次数据到达都会重置 ind.filters/cmp/from/to，故回载在其重置之后、只首次一次（indRestored 守卫）——
   避免 refresh 覆盖当前操作。回载后 filters/cmp 交给 renderIndFilters/renderIndCmp 求交剔除脏值，
   from/to 交给 renderIndRange 按数据期数校正（脏值防御）；坏档/坏值 try/catch 走默认。 ---- */
const IND_STATE_KEY='sb.industry.v1';
let indRestored=false;
const IND_METRICS=['sellIn','sellOut','inv','dos'], IND_GRANS=['day','week','month'], IND_UNITS=['one','k','w'];
function indStateSave(){ boardStateSave(IND_STATE_KEY, ()=>({
  filters: ind.filters, cmp: ind.cmp, metric: ind.metric, gran: ind.gran,
  unit: ind.unit, smooth: ind.smooth, color: ind.color, colorPrev: ind.colorPrev, from: ind.from, to: ind.to }), 500); }
function indStateRestore(){
  if(indRestored) return; indRestored=true;
  const o=boardStateLoad(IND_STATE_KEY); if(!o) return;
  if(o.filters && typeof o.filters==='object') ind.filters=o.filters;                    // renderIndFilters 求交剔脏
  if(o.cmp && typeof o.cmp==='object'){ ['series','product','model'].forEach(k=>{ if(Array.isArray(o.cmp[k])) ind.cmp[k]=o.cmp[k]; }); }
  if(IND_METRICS.includes(o.metric)) ind.metric=o.metric;
  if(IND_GRANS.includes(o.gran)) ind.gran=o.gran;
  if(IND_UNITS.includes(o.unit)) ind.unit=o.unit;
  if(typeof o.smooth==='boolean') ind.smooth=o.smooth;
  if(typeof o.color==='string' && /^#[0-9a-fA-F]{6}$/.test(o.color)) ind.color=o.color;
  // 向后兼容：旧档只有 color(当作今年线色,上行已收)，colorPrev 缺失时保持默认灰 #B9BEC6
  if(typeof o.colorPrev==='string' && /^#[0-9a-fA-F]{6}$/.test(o.colorPrev)) ind.colorPrev=o.colorPrev;
  if(typeof o.from==='string') ind.from=o.from;                                          // renderIndRange 校验期数
  if(typeof o.to==='string') ind.to=o.to;
}
// 产业看板数据单位：台 / 千台K / 万台W
const indUnitInfo=()=>UNIT_OPT[ind.unit]||UNIT_OPT.one;
function indFmt(v){ const u=indUnitInfo(); if(v==null||isNaN(v)) return '0';
  if(u.div===1) return Math.round(v).toLocaleString('en-US');
  const x=v/u.div; return (Math.abs(x)>=100?Math.round(x).toLocaleString('en-US'):(+x.toFixed(1)))+u.suf; }
const IND_UNIT_TAIL={one:'台',k:'千台',w:'万台'};
// KPI/tooltip 单一单位显示：indFmt 已带 W/K 量级，只补“台”，避免 0.5W万台 / 0.6K千台 双重单位
const indFmtU=v=>indFmt(v)+'台';
// 产业看板筛选：产品维度在前(indDim 作级联根，再补另一产品维度+系列/产品/型号)，地理在后(剔除 channel)
function indMainFields(){ const dd=ind.indDim||'line'; const prod=['line','family','series','product','model'].filter(k=>k!==dd); return [dd,...prod,'repOffice','country']; }
function indCmpHas(){ return !!(ind.cmp.series.length||ind.cmp.product.length||ind.cmp.model.length); }
function indYoyCell(v){ if(v==null||!isFinite(v)) return '<span class="wk">—</span>'; const c=v>=0?'pos':'neg'; return `<span class="${c}">${v>=0?'+':''}${(v*100).toFixed(0)}%</span>`; }
function clearIndDownstream(field){
  const dd=ind.indDim;
  const cut=chain=>{ const i=chain.indexOf(field); if(i>=0) chain.slice(i+1).forEach(f=>delete ind.filters[f]); };
  cut(['region','repOffice','country']); cut([dd,'series','product','model']);
  if(field===dd){ ind.cmp={series:[],product:[],model:[]}; }   // 换产业 → 对比清空
}
// 主筛选行(级联多选)：每个字段 options(field, 其它已选)
async function renderIndFilters(){
  const row=$('#indFilterRow'); if(!row) return; row.innerHTML='<span class="ind-rowlab">筛选 ▸</span>';
  for(const field of indMainFields().filter(f=>state.dims.includes(f))){
    const opts=sortByHier(field, await api.options(field, ind.filters));
    let cur=asArrLocal(ind.filters[field]).filter(v=>opts.includes(v));
    if(cur.length) ind.filters[field]=cur; else delete ind.filters[field];
    const ms=makeMultiSelect(IND_FLD_LAB[field]||DIM_LABEL[field]||field, opts, cur, {placeholder:'全部',
      onChange:v=>{ if(v.length) ind.filters[field]=v; else delete ind.filters[field]; },
      onCommit:async v=>{ if(v.length) ind.filters[field]=v; else delete ind.filters[field];
        clearIndDownstream(field); await renderIndFilters(); await renderIndCmp(); drawIndustry(); indStateSave(); }});
    row.appendChild(ms);
  }
}
// 对比基底：产业+地区沿用主筛选；对比项只换产品维度
function indCmpBase(){ const b={}, dd=ind.indDim; [dd,'region','repOffice','country','channel'].forEach(k=>{ if(asArrLocal(ind.filters[k]).length) b[k]=ind.filters[k]; }); return b; }
async function renderIndCmp(){
  const row=$('#indCmpRow'); if(!row) return; row.innerHTML='<span class="ind-rowlab">对比·去年灰线 ▸</span>';
  const base=indCmpBase();
  for(const [field,lab] of [['series','对比系列'],['product','对比产品'],['model','对比型号']]){
    if(!state.dims.includes(field)) continue;
    const f=Object.assign({},base);
    if(field!=='series'&&ind.cmp.series.length) f.series=ind.cmp.series;
    if(field==='model'&&ind.cmp.product.length) f.product=ind.cmp.product;
    const opts=sortByHier(field, await api.options(field, f));
    let cur=asArrLocal(ind.cmp[field]).filter(v=>opts.includes(v)); ind.cmp[field]=cur;
    const ms=makeMultiSelect(lab, opts, cur, {placeholder:'（不对比）',
      onChange:v=>{ ind.cmp[field]=v; },
      onCommit:async v=>{ ind.cmp[field]=v; if(field==='series'){ind.cmp.product=[];ind.cmp.model=[];} if(field==='product'){ind.cmp.model=[];}
        await renderIndCmp(); drawIndustry(); indStateSave(); }});
    row.appendChild(ms);
  }
}
async function initIndustry(){
  if(!state.dims.length){ $('#indEmpty').classList.remove('hidden'); $('#indKpi').innerHTML=''; if(ind.chart)ind.chart.clear(); return; }
  $('#indEmpty').classList.add('hidden');
  const probe=await api.industryBoard({filters:{},cmp:{}}); ind.indDim=probe.indDim||'line';
  $$('#indMetric button').forEach(x=>x.classList.toggle('on',x.dataset.m===ind.metric));
  $$('#indGranSeg button').forEach(x=>x.classList.toggle('on',x.dataset.g===ind.gran));
  $$('#indUnitSeg button').forEach(x=>x.classList.toggle('on',x.dataset.u===ind.unit));
  $$('#indSmoothSeg button').forEach(x=>x.classList.toggle('on',(x.dataset.s==='1')===ind.smooth));
  $('#indColor').value=ind.color;
  const icp=$('#indColorPrev'); if(icp) icp.value=ind.colorPrev;
  await renderIndFilters(); await renderIndCmp(); await drawIndustry();
}
async function drawIndustry(){
  if(!state.dims.length){ $('#indEmpty').classList.remove('hidden'); return; }
  const b=await api.industryBoard({filters:ind.filters, cmp:ind.cmp, metric:ind.metric, gran:ind.gran});
  ind.data=b; if(b.indDim) ind.indDim=b.indDim;
  ind.fullPeriods=(b.trend&&b.trend.periods)||[];
  renderIndRange(); renderIndKpi(b); renderIndChart(b);
  renderIndLcCtrl();                                   // 生命周期对比区:选项跟随主筛选刷新(纯新增,不影响上方)
  if(ind.lc.a && ind.lc.b) drawIndLc();                // 已选两代 → 主筛选变化时自动重算
}
function renderIndRange(){
  const host=$('#indRange'); if(!host) return; const ps=ind.fullPeriods;
  if(!ps.length){ host.innerHTML='<span class="wk">—</span>'; return; }
  if(!ind.from||ps.indexOf(ind.from)<0) ind.from=ps[0];
  if(!ind.to||ps.indexOf(ind.to)<0) ind.to=ps[ps.length-1];
  const opt=sel=>ps.map(p=>`<option ${p===sel?'selected':''}>${p}</option>`).join('');
  host.innerHTML=`<select id="indFrom">${opt(ind.from)}</select><span style="color:var(--ink3)">~</span><select id="indTo">${opt(ind.to)}</select>`;
  $('#indFrom').onchange=e=>{ ind.from=e.target.value; if(ps.indexOf(ind.from)>ps.indexOf(ind.to)) ind.to=ind.from; renderIndRange(); renderIndKpi(ind.data); renderIndChart(ind.data); indStateSave(); };
  $('#indTo').onchange=e=>{ ind.to=e.target.value; if(ps.indexOf(ind.to)<ps.indexOf(ind.from)) ind.from=ind.to; renderIndRange(); renderIndKpi(ind.data); renderIndChart(ind.data); indStateSave(); };
}
// 当前所选时间窗口(与图表同一套 lo/hi 截取)
function indWin(){
  const t=ind.data&&ind.data.trend; if(!t||!t.periods||!t.periods.length) return null;
  let lo=t.periods.indexOf(ind.from), hi=t.periods.indexOf(ind.to);
  if(lo<0)lo=0; if(hi<0)hi=t.periods.length-1; if(lo>hi){const x=lo;lo=hi;hi=x;}
  return {t,lo,hi,full:lo===0&&hi===t.periods.length-1};
}
// KPI 区间口径：SI/SO 累计与同比都按当前所选区间对去年同期(引擎已按同期 key 截去年、主范围口径)重算
function indKpiWindow(){
  const w=indWin(); if(!w||!Array.isArray(w.t.siCur)) return null;   // 旧数据无逐期数组时回退引擎全年YTD
  const sum=a=>{ let s=0; for(let i=w.lo;i<=w.hi;i++) s+=a[i]||0; return s; };
  const siC=sum(w.t.siCur), siP=sum(w.t.siPrev), soC=sum(w.t.soCur), soP=sum(w.t.soPrev);
  return { si:{cur:siC,prev:siP,yoy:window.FinCalc.yoy(siC,siP)}, so:{cur:soC,prev:soP,yoy:window.FinCalc.yoy(soC,soP)},
    label: w.full?'YTD':`${w.t.periods[w.lo]}~${w.t.periods[w.hi]}`};
}
function renderIndKpi(b){
  const k=b.kpi||{}; const cy=b.curYear||'今年', py=b.prevYear||'去年';
  const tw=indFmtU;
  const card=(title,val,sub)=>`<div class="kpi-card"><div class="k">${title}</div><div class="v">${val}</div><div class="row2">${sub}</div></div>`;
  // 区间口径：有逐期数组就按当前时间窗口重算(选多少算多少)，否则回退引擎全年YTD
  const kw=indKpiWindow();
  const si=kw?kw.si:k.si, so=kw?kw.so:k.so, rl=kw?kw.label:'YTD';
  let h='';
  h+=card(`${cy}年 Sell In ${rl}`, tw(si.cur), `<span><span class="lab">${py}同期</span> ${tw(si.prev)}</span><span><span class="lab">同比</span> ${indYoyCell(si.yoy)}</span>`);
  h+=card(`${cy}年 Sell Out ${rl}`, tw(so.cur), `<span><span class="lab">${py}同期</span> ${tw(so.prev)}</span><span><span class="lab">同比</span> ${indYoyCell(so.yoy)}</span>`);
  // DOS=null 是「近4周无 SO,算不出」,显示「—」;写成 ||0 会变成「0 天」,读起来像马上断货
  const dosTxt=v=>v==null?'<span class="wk">—</span>':(v+' 天');
  h+=card('当前 库存 Inventory', tw(k.inv.cur), `<span><span class="lab">渠道DOS</span> ${dosTxt(k.inv.dos)}</span>`);
  if(k.flow && k.flow.cur!=null) h+=card('当前 全流程库存', tw(k.flow.cur), `<span><span class="lab">全流程DOS</span> ${dosTxt(k.flow.dos)}</span>`);
  else h+=card('当前 全流程库存','—','<span class="wk">需库龄/全流程表</span>');
  $('#indKpi').innerHTML=h;
}
function renderIndChart(b){
  if(!ind.chart){ ind.chart=CT().register(echarts.init($('#indChart'))); window.addEventListener('resize',()=>ind.chart&&ind.chart.resize()); }
  const t=b&&b.trend; if(!t||!t.periods.length){ ind.chart.clear(); $('#indChartTitle').textContent='趋势'; $('#indChartHint').textContent=''; return; }
  let lo=t.periods.indexOf(ind.from), hi=t.periods.indexOf(ind.to);
  if(lo<0)lo=0; if(hi<0)hi=t.periods.length-1; if(lo>hi){const x=lo;lo=hi;hi=x;}
  const periods=t.periods.slice(lo,hi+1), cur=t.cur.slice(lo,hi+1), prev=t.prev.slice(lo,hi+1);
  const cmpOn=indCmpHas();
  const curName=`${t.curYear} ${IND_PSI_LAB[t.metric]||''}`.trim();
  const prevName=cmpOn?`${t.prevYear} 对比`:`${t.prevYear}`;
  const red=ind.color||SB_COLORS.brand;
  const grey=ind.colorPrev||'#B9BEC6';   // 去年线颜色(第二批-2b 可自定义)，默认灰与原一致
  // 去年线数据标签：默认灰时保持原深灰 #8A9099(浅灰线配深灰字保可读)；用户改色后跟随线色
  const greyLab=grey.toUpperCase()==='#B9BEC6'?'#8A9099':grey;
  // 数据标签常驻(不需悬停)：两条线都给 symbol 才能稳定渲染标签；白描边保证可读
  const lab=(pos,color)=>({show:true,position:pos,distance:5,color,fontFamily:YH,fontSize:10,fontWeight:'bold',
    textBorderWidth:0,formatter:p=>indFmt(p.value)});
  const hasPrev=prev.some(v=>v>0);
  const smooth=!!ind.smooth;
  // 标签防重叠：逐点定位——每一期数值高的那条线标签朝上、低的朝下,标签永远落在两线夹带的外侧,
  // 不再出现"两组标签同时挤进两线之间"的打架(旧逻辑写死 今年top/去年bottom,去年线在上时必叠)
  const curUp=cur.map((v,i)=> hasPrev && (prev[i]||0)>(v||0) ? 'bottom' : 'top');
  const dataCur=cur.map((v,i)=>({value:v,label:{position:curUp[i]}}));
  const dataPrev=prev.map((v,i)=>({value:v,label:{position:curUp[i]==='top'?'bottom':'top'}}));
  const series=[
    {name:curName,type:'line',smooth,symbol:'circle',symbolSize:6,showAllSymbol:true,lineStyle:{width:3.2,color:red},itemStyle:{color:red},
      label:lab('top',red),data:dataCur,z:6},
    {name:prevName,type:'line',smooth,symbol:'circle',symbolSize:4,showAllSymbol:true,lineStyle:{width:2,color:grey,type:'dashed'},itemStyle:{color:grey},
      label:lab('bottom',greyLab),data:dataPrev,z:4}
  ];
  ind.chart.setOption({textStyle:{fontFamily:YH},
    tooltip:{trigger:'axis',backgroundColor:'rgba(26,26,26,.92)',borderWidth:0,textStyle:{color:'#fff',fontFamily:YH,fontSize:11},
      valueFormatter:v=>indFmtU(v)},
    legend:{top:6,left:'center',textStyle:{fontFamily:YH,fontSize:12,color:CT().ink2()}},
    grid:{left:62,right:24,top:42,bottom:periods.length>16?56:34},
    dataZoom:[{type:'inside',zoomOnMouseWheel:'ctrl',moveOnMouseWheel:false}],
    xAxis:{type:'category',data:periods,axisLabel:{fontFamily:YH,fontSize:11,color:CT().ink3(),rotate:periods.length>16?40:0},axisLine:{lineStyle:{color:CT().line()}},axisTick:{show:false}},
    yAxis:[{type:'value',axisLabel:{fontFamily:YH,fontSize:10,color:CT().ink3(),formatter:v=>indFmt(v)},splitLine:{lineStyle:{color:CT().lineSoft()}}}],
    series},true);
  const scope=indScopeLabel();
  $('#indChartTitle').textContent=`${scope} · ${IND_PSI_LAB[t.metric]||t.metric} · ${({day:'日',week:'周',month:'月'})[t.gran]}维度`;
  $('#indChartHint').textContent=`红实线=${t.curYear}年今年 · 灰虚线=${cmpOn?'对比项':t.prevYear+'年去年'}${hasPrev?'':'（去年无数据）'}`;
  setTimeout(()=>ind.chart&&ind.chart.resize(),30);
}
/* ============================================================
   两代产品 · 生命周期对齐对比(现有趋势图下方,纯新增)
   - 上市点拉齐:横轴=上市后第N天/周/月(固定长度桶:日1天/周7天/月30天),非日历时间
   - 起点=首个SellOut>0日(可用"上市日"输入框覆盖;无SO时退SellIn首日)
   - 沿用主筛选的地理/产业条件(indCmpBase),产品维度由本区块的 A/B 选择
   ============================================================ */
const IND_LC_GRAN_LAB={day:'天',week:'周',month:'月'};
async function renderIndLcCtrl(){
  const row=$('#indLcCtrl'); if(!row) return;
  const lc=ind.lc;
  const base=indCmpBase();
  let opts=[];
  try{ opts=sortByHier(lc.dim, await api.options(lc.dim, base)); }catch(e){ opts=[]; }
  if(lc.a && opts.indexOf(lc.a)<0) lc.a=null;
  if(lc.b && opts.indexOf(lc.b)<0) lc.b=null;
  const sel=(id,cur,ph)=>'<select id="'+id+'"><option value="">'+ph+'</option>'+opts.map(o=>'<option'+(o===cur?' selected':'')+'>'+o+'</option>').join('')+'</select>';
  row.innerHTML='<span class="ind-rowlab">两代对比 ▸</span>'+
    '<span class="fld"><label>维度</label><select id="indLcDim">'+[['series','产品系列'],['product','产品'],['model','型号']].map(o=>'<option value="'+o[0]+'"'+(lc.dim===o[0]?' selected':'')+'>'+o[1]+'</option>').join('')+'</select></span>'+
    '<span class="fld"><label>上一代 A</label>'+sel('indLcA',lc.a,'选择…')+'</span>'+
    '<span class="fld"><label>A上市日(选填)</label><input type="date" id="indLcLa" value="'+(lc.la||'')+'" title="留空=自动取首个SellOut>0日"></span>'+
    '<span class="fld"><label>现一代 B</label>'+sel('indLcB',lc.b,'选择…')+'</span>'+
    '<span class="fld"><label>B上市日(选填)</label><input type="date" id="indLcLb" value="'+(lc.lb||'')+'"></span>'+
    '<div class="divider"></div>'+
    '<span class="fld"><label>生命周期粒度</label><div class="seg" id="indLcGran">'+['day','week','month'].map(g=>'<button data-g="'+g+'"'+(lc.gran===g?' class="on"':'')+'>'+IND_LC_GRAN_LAB[g]+'</button>').join('')+'</div></span>'+
    '<span class="fld"><label>窗口·上市前N'+IND_LC_GRAN_LAB[lc.gran]+'</label><input type="number" id="indLcN" min="1" style="width:64px" value="'+(lc.n||'')+'" placeholder="全部"></span>'+
    '<span class="fld"><label>指标</label><div class="seg" id="indLcMetric">'+[['sellOut','SO'],['sellIn','SI'],['inv','库存'],['dos','DOS']].map(o=>'<button data-m="'+o[0]+'"'+(lc.metric===o[0]?' class="on"':'')+'>'+o[1]+'</button>').join('')+'</div></span>'+
    '<button class="btn primary" id="indLcGo">对比</button>';
  $('#indLcDim').onchange=e=>{ lc.dim=e.target.value; lc.a=null; lc.b=null; renderIndLcCtrl(); };
  $('#indLcA').onchange=e=>{ lc.a=e.target.value||null; };
  $('#indLcB').onchange=e=>{ lc.b=e.target.value||null; };
  $('#indLcLa').onchange=e=>{ lc.la=e.target.value||''; };
  $('#indLcLb').onchange=e=>{ lc.lb=e.target.value||''; };
  $$('#indLcGran button').forEach(b=>b.onclick=()=>{ lc.gran=b.dataset.g; renderIndLcCtrl(); if(lc.a&&lc.b) drawIndLc(); });
  $('#indLcN').onchange=e=>{ const v=parseInt(e.target.value,10); lc.n=(v>0)?v:null; if(lc.data) renderIndLc(); };
  $$('#indLcMetric button').forEach(b=>b.onclick=()=>{ lc.metric=b.dataset.m; $$('#indLcMetric button').forEach(x=>x.classList.toggle('on',x===b)); if(lc.data) renderIndLcChart(); });
  $('#indLcGo').onclick=()=>{ if(!lc.a||!lc.b){ toast('请先选择两代产品','warn'); return; } if(lc.a===lc.b){ toast('两代不能选同一个','warn'); return; } drawIndLc(); };
}
async function drawIndLc(){
  const lc=ind.lc; if(!lc.a||!lc.b) return;
  const base=indCmpBase();
  const mk=v=>{ const f=Object.assign({},base); f[lc.dim]=[v]; return f; };
  const r=await api.lifecycleCompare({ a:{filters:mk(lc.a), launch:lc.la||null}, b:{filters:mk(lc.b), launch:lc.lb||null}, gran:lc.gran });
  if(!r || r.error){ toast('生命周期对比取数失败'+(r&&r.error?(':'+r.error):''),'err'); return; }
  lc.data=r;
  renderIndLc();
}
function renderIndLc(){ renderIndLcStats(); renderIndLcCards(); renderIndLcChart(); }
function indLcWin(side){
  const lc=ind.lc, bs=(side&&side.buckets)||[];
  const n=lc.n; const sl=n?bs.slice(0,n):bs;
  let si=0,so=0; sl.forEach(b=>{ si+=b.si; so+=b.so; });
  const last=sl.length?sl[sl.length-1]:null;
  return { si:si, so:so, inv:last?last.inv:0, dos:last?last.dos:0, periods:sl.length };
}
function renderIndLcStats(){
  const host=$('#indLcStats'); if(!host) return;
  const lc=ind.lc, d=lc.data; if(!d){ host.innerHTML=''; return; }
  const u=IND_LC_GRAN_LAB[lc.gran];
  const winLab=lc.n?('上市前 '+lc.n+' '+u):'上市至今(全周期)';
  const one=(name,side)=>{
    if(!side||side.empty) return '<b>'+name+'</b>:该范围内无数据';
    const w=indLcWin(side);
    return '<b>'+name+'</b>(第1'+u+'='+side.launch+'):累计SO <b>'+indFmtU(w.so)+'</b> · 累计SI <b>'+indFmtU(w.si)+'</b> · 窗口末库存 '+indFmtU(w.inv)+' · 窗口末DOS '+w.dos+'天';
  };
  host.innerHTML='<div style="font-size:12px;color:var(--ink2);line-height:1.9">'+
    '<span style="color:var(--ink3)">统计窗口:'+winLab+'</span><br>'+
    one('A · '+(lc.a||''), d.a)+'<br>'+one('B · '+(lc.b||''), d.b)+'</div>';
}
function renderIndLcCards(){
  const host=$('#indLcCards'); if(!host) return;
  const lc=ind.lc, d=lc.data; if(!d){ host.innerHTML=''; return; }
  const card=(name,side)=>{
    if(!side||side.empty) return '<div class="kpi-card"><div class="k">'+name+'</div><div class="v">—</div><div class="row2"><span class="wk">该范围内无数据</span></div></div>';
    const t=side.today;
    return '<div class="kpi-card"><div class="k">'+name+' · 截至 '+t.asOf+'(已上市'+t.days+'天)</div>'+
      '<div class="v">'+indFmtU(t.cumSO)+'<span style="font-size:12px;color:var(--ink3)"> 生命周期累计SO</span></div>'+
      '<div class="row2"><span><span class="lab">累计SI</span> '+indFmtU(t.cumSI)+'</span><span><span class="lab">当前库存</span> '+indFmtU(t.inv)+'</span><span><span class="lab">当前DOS</span> '+t.dos+'天</span></div></div>';
  };
  host.innerHTML=card('A · '+(lc.a||''), d.a)+card('B · '+(lc.b||''), d.b);
}
function renderIndLcChart(){
  const el=$('#indLcChart'); if(!el) return;
  const lc=ind.lc, d=lc.data; if(!d) return;
  if(!ind.lcChart){ ind.lcChart=CT().register(echarts.init(el)); window.addEventListener('resize',()=>ind.lcChart&&ind.lcChart.resize()); }
  const u=IND_LC_GRAN_LAB[lc.gran];
  const A=(d.a&&!d.a.empty)?d.a:null, B=(d.b&&!d.b.empty)?d.b:null;
  const n=lc.n;
  const ba=A?(n?A.buckets.slice(0,n):A.buckets):[];
  const bb=B?(n?B.buckets.slice(0,n):B.buckets):[];
  const len=Math.max(ba.length,bb.length);
  const cats=[]; for(let k=0;k<len;k++) cats.push('第'+(k+1)+u);
  const pick=b=>b?b[lc.metric==='sellIn'?'si':lc.metric==='inv'?'inv':lc.metric==='dos'?'dos':'so']:null;
  const sA=cats.map((_,k)=>pick(ba[k])), sB=cats.map((_,k)=>pick(bb[k]));
  const nmA='A·'+(lc.a||'')+(A?('(上市'+A.launch+')'):''), nmB='B·'+(lc.b||'')+(B?('(上市'+B.launch+')'):'');
  ind.lcChart.setOption({textStyle:{fontFamily:YH},
    tooltip:{trigger:'axis',backgroundColor:'rgba(26,26,26,.92)',borderWidth:0,textStyle:{color:'#fff',fontFamily:YH,fontSize:11},
      formatter:(ps)=>{ let h=ps.length?ps[0].name:''; ps.forEach(p=>{ const bs=p.seriesIndex===0?ba:bb; const b=bs[p.dataIndex];
        h+='<br>'+p.marker+p.seriesName+': '+(p.value==null?'-':(lc.metric==='dos'?p.value+'天':indFmtU(p.value)))+(b?('<span style="color:#aaa">('+b.date+')</span>'):''); }); return h; }},
    legend:{top:4,left:'center',textStyle:{fontFamily:YH,fontSize:11,color:CT().ink2()}},
    grid:{left:62,right:24,top:40,bottom:cats.length>16?52:32},
    xAxis:{type:'category',data:cats,axisLabel:{fontFamily:YH,fontSize:10,color:CT().ink3(),rotate:cats.length>16?40:0},axisLine:{lineStyle:{color:CT().line()}},axisTick:{show:false}},
    yAxis:[{type:'value',axisLabel:{fontFamily:YH,fontSize:10,color:CT().ink3(),formatter:v=>lc.metric==='dos'?v:indFmt(v)},splitLine:{lineStyle:{color:CT().lineSoft()}}}],
    series:[
      {name:nmA,type:'line',smooth:!!ind.smooth,symbol:'circle',symbolSize:4,lineStyle:{width:2.4,color:CT().ink3()},itemStyle:{color:CT().ink3()},data:sA,z:4},
      {name:nmB,type:'line',smooth:!!ind.smooth,symbol:'circle',symbolSize:5,lineStyle:{width:3,color:ind.color||SB_COLORS.brand},itemStyle:{color:ind.color||SB_COLORS.brand},data:sB,z:6}
    ]},true);
  setTimeout(()=>ind.lcChart&&ind.lcChart.resize(),30);
}

function indScopeLabel(){
  const pick=f=>{ const a=asArrLocal(ind.filters[f]); return a.length?(a.length===1?a[0]:a.length+'项'):null; };
  const order=[ind.indDim,'repOffice','country','series','product','model'];
  for(let i=order.length-1;i>=0;i--){ const v=pick(order[i]); if(v) return v; }
  return '拉美整体';
}
async function exportIndXlsx(){
  const b=ind.data, t=b&&b.trend; if(!t||!t.periods.length){ toast('暂无数据','err'); return; }
  const k=b.kpi||{}; const u=indUnitInfo(); const uv=v=>u.div===1?Math.round(v||0):+(((v||0)/u.div).toFixed(3));
  const uTxt=IND_UNIT_TAIL[ind.unit]+(u.div===1?'':`(原值÷${u.div})`);
  const aoa=[[`${indScopeLabel()} 产业看板 · ${IND_PSI_LAB[t.metric]} · ${({day:'日',week:'周',month:'月'})[t.gran]}维度 · 单位:${uTxt}`]];
  aoa.push([]); aoa.push(['KPI','本期',`${b.prevYear}同期`,'同比%']);
  const nz=v=>v==null||!isFinite(v)?'':v;
  // 与看板 KPI 同口径：按当前所选区间求和(indKpiWindow)，无逐期数组时回退引擎全年YTD
  const kw=indKpiWindow();
  const ksi=kw?kw.si:k.si, kso=kw?kw.so:k.so, krl=kw?kw.label:'YTD';
  const kpiRows=[]; // aoa idx of KPI rows that have a 同比 (cols B/C/D)
  kpiRows.push(aoa.length); aoa.push([`${b.curYear} Sell In ${krl}`, uv(ksi.cur), uv(ksi.prev), nz(ksi.yoy)]);
  kpiRows.push(aoa.length); aoa.push([`${b.curYear} Sell Out ${krl}`, uv(kso.cur), uv(kso.prev), nz(kso.yoy)]);
  const dosCellX=v=>v==null?'—':(v+'天');   // 导出同界面口径:null 是「算不出」不是 0
  aoa.push(['当前库存 Inventory', uv(k.inv.cur), '渠道DOS', dosCellX(k.inv.dos)]);
  if(k.flow&&k.flow.cur!=null) aoa.push(['当前全流程库存', uv(k.flow.cur), '全流程DOS', dosCellX(k.flow.dos)]);
  aoa.push([]);
  // 完整同比表：每一期 今年 / 去年(或对比) / 同比%
  let lo=t.periods.indexOf(ind.from), hi=t.periods.indexOf(ind.to); if(lo<0)lo=0; if(hi<0)hi=t.periods.length-1; if(lo>hi){const x=lo;lo=hi;hi=x;}
  const cmp=indCmpHas();
  aoa.push(['期间', `${b.curYear}年 ${IND_PSI_LAB[t.metric]}`, `${b.prevYear}年${cmp?'对比':'同期'} ${IND_PSI_LAB[t.metric]}`, '同比%']);
  const perRows=[]; let sc=0,sp=0;
  for(let i=lo;i<=hi;i++){ const cv=t.cur[i]||0, pv=t.prev[i]||0; sc+=cv; sp+=pv;
    perRows.push(aoa.length); aoa.push([t.periods[i], uv(cv), uv(pv), nz(window.FinCalc.yoy(cv,pv))]); }
  perRows.push(aoa.length); aoa.push(['合计', uv(sc), uv(sp), nz(window.FinCalc.yoy(sc,sp))]);
  const ws=XLSX.utils.aoa_to_sheet(aoa); ws['!cols']=[{wch:18},{wch:16},{wch:18},{wch:10}];
  // live 同比 = (本期-同期)/同期 referencing cols B/C same row (KPI block + per-period block)
  window.ExportUtil.applyRowYoy(XLSX, ws, window.FinCalc, {rows:kpiRows.concat(perRows), yoyCol:3, curCol:1, prevCol:2, z:'0.0%'});
  const wb=XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb,ws,'产业看板');
  const b64=XLSX.write(wb,{bookType:'xlsx',type:'base64'});
  const res=await api.saveFile('产业看板_'+indScopeLabel()+'_'+todayStr()+'.xlsx',b64,'xlsx'); if(res&&res.path)toast('已导出','ok');
}
// 导出 PPT 原生折线图(可在PPT里编辑)，遵循单位/颜色/平滑或折线/数据标签
async function exportIndPpt(){
  const b=ind.data, t=b&&b.trend; if(!t||!t.periods.length){ toast('暂无数据','err'); return; }
  let lo=t.periods.indexOf(ind.from), hi=t.periods.indexOf(ind.to); if(lo<0)lo=0; if(hi<0)hi=t.periods.length-1; if(lo>hi){const x=lo;lo=hi;hi=x;}
  const periods=t.periods.slice(lo,hi+1);
  const u=indUnitInfo(); const uv=v=>u.div===1?Math.round(v||0):+(((v||0)/u.div).toFixed(3));
  const cur=t.cur.slice(lo,hi+1).map(uv), prev=t.prev.slice(lo,hi+1).map(uv);
  const cmp=indCmpHas();
  const curName=`${t.curYear}年 ${IND_PSI_LAB[t.metric]||''}`.trim();
  const prevName=cmp?`${t.prevYear} 对比`:`${t.prevYear}年`;
  const redHex=(ind.color||SB_COLORS.brand).replace('#','').toUpperCase();
  const greyHex=(ind.colorPrev||'#B9BEC6').replace('#','').toUpperCase();
  const pptx=new PptxGenJS(); pptx.defineLayout({name:'W',width:13.333,height:7.5}); pptx.layout='W';
  const s=pptx.addSlide();
  s.addText(`${indScopeLabel()} · ${IND_PSI_LAB[t.metric]} · ${({day:'日',week:'周',month:'月'})[t.gran]}维度`,{x:0.5,y:0.25,w:12.3,h:0.5,fontFace:'微软雅黑',fontSize:18,bold:true,color:'1A1A1A'});
  s.addText(`单位：${IND_UNIT_TAIL[ind.unit]}${u.div===1?'':'(原值÷'+u.div+')'}　红=${t.curYear}今年　灰=${cmp?'对比项':t.prevYear+'去年'}　线型：${ind.smooth?'平滑线':'折线'}`,{x:0.5,y:0.78,w:12.3,h:0.35,fontFace:'微软雅黑',fontSize:11,color:'7A7F86'});
  const cd=[{name:curName,labels:periods,values:cur},{name:prevName,labels:periods,values:prev}];
  s.addChart(pptx.ChartType.line, cd, {
    x:0.5,y:1.25,w:12.3,h:5.9, chartColors:[redHex,greyHex],
    lineSmooth: !!ind.smooth, lineSize:2.5, lineDataSymbol:'circle', lineDataSymbolSize:5,
    showLegend:true, legendPos:'t', legendFontFace:'微软雅黑', legendFontSize:11,
    showValue:true, dataLabelFontFace:'微软雅黑', dataLabelFontSize:9, dataLabelPosition:'t', dataLabelColor:'404040',
    catAxisLabelFontFace:'微软雅黑', catAxisLabelFontSize:9, valAxisLabelFontFace:'微软雅黑', valAxisLabelFontSize:9, showTitle:false });
  const fn='产业看板_'+indScopeLabel()+'_'+todayStr()+'.pptx';
  const b64=await pptx.write('base64'); const res=await api.saveFile(fn,b64,'pptx'); if(res&&res.path)toast('已导出 PPT 图表','ok');
}

/* ---- 事件绑定(从 app.js init() 搬来，保持同位置顺序) ---- */
function initIndustryView(){
  // 产业看板 controls
  $$('#indMetric button').forEach(b=>b.onclick=()=>{ ind.metric=b.dataset.m; $$('#indMetric button').forEach(x=>x.classList.toggle('on',x===b)); drawIndustry(); indStateSave(); });
  $$('#indGranSeg button').forEach(b=>b.onclick=()=>{ ind.gran=b.dataset.g; $$('#indGranSeg button').forEach(x=>x.classList.toggle('on',x===b)); ind.from=null; ind.to=null; drawIndustry(); indStateSave(); });
  $('#indColor').oninput=e=>{ ind.color=e.target.value; if(ind.data) renderIndChart(ind.data); indStateSave(); };
  const icp2=$('#indColorPrev'); if(icp2) icp2.oninput=e=>{ ind.colorPrev=e.target.value; if(ind.data) renderIndChart(ind.data); indStateSave(); };
  $$('#indUnitSeg button').forEach(b=>b.onclick=()=>{ ind.unit=b.dataset.u; $$('#indUnitSeg button').forEach(x=>x.classList.toggle('on',x===b)); if(ind.data){ renderIndKpi(ind.data); renderIndChart(ind.data); } indStateSave(); });
  $$('#indSmoothSeg button').forEach(b=>b.onclick=()=>{ ind.smooth=b.dataset.s==='1'; $$('#indSmoothSeg button').forEach(x=>x.classList.toggle('on',x===b)); if(ind.data) renderIndChart(ind.data); indStateSave(); });
  $('#indExport').onclick=exportIndXlsx;
  $('#indExportPng').onclick=exportIndPpt;
}

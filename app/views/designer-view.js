'use strict';
// ECharts 主题桥取值器（canvas 不认 CSS 变量，必须给真实色值）
function CT(){ return (typeof window!=='undefined'&&window.SbChartTheme)?window.SbChartTheme:{ink1:()=>'#1A1A1A',ink2:()=>'#5A5F66',ink3:()=>'#8A9099',line:()=>'#E6E8EB',lineSoft:()=>'#F0F1F3',bgElev:()=>'#FFFFFF',register:c=>c}; }
/* ============================================================
   Salesboard — views/designer-view.js
   看板设计器视图：Power BI 式自由报表（dz 状态/磁贴/检查器/联动筛选/导出）。
   纯搬运：从 app.js 原样剪切，无逻辑改动。依赖 common.js（在本文件之前加载，含 todayStr/renderDataBar 等共享辅助）；switchView/buildDesigner 由 app.js 调用。
   事件绑定见 initDesignerView()（在 app.js init() 中调用）。
   ============================================================ */

/* ============================================================
   看板设计器 (Power BI 式自由报表)
   ============================================================ */
const DZ_MEASURES=['sellOut','sellIn','inv','dos'];
// IDC 市场数据源：维度/度量中文名
const IDC_LABEL={cat:'Category',year:'Year',quarter:'Quarter',region:'Region',country:'Country',brand:'Brand',brandGrp:'Brand Group',
  model:'Model',form:'Form Factor',segment:'Segment',owsCerti:'TWS/OWS',openEar:'Open-ear',screen:'Screen Size',
  ram:'RAM (GB)',storage:'Storage (GB)',gen:'Generation',priceBand:'Price Band (raw)',pbStd:'Price Band (Std)',pbHQ:'Price Band (HQ)',pbBR:'Price Band (BR)',
  units:'销量',value:'销额(百万美元)',asp:'均价(USD)'};
const IDC_MEASURES=['units','value','asp'];
const DZ_VISUALS=[
  {t:'column',ic:'📊',n:'簇状柱形图'},{t:'stackColumn',ic:'🏛️',n:'堆积柱形图'},{t:'stack100',ic:'💯',n:'百分比堆积柱形图'},
  {t:'bar',ic:'📶',n:'簇状条形图'},{t:'stackBar',ic:'📚',n:'堆积条形图'},{t:'stack100Bar',ic:'🧮',n:'百分比堆积条形图'},
  {t:'line',ic:'📈',n:'折线图'},{t:'area',ic:'🟥',n:'面积图'},{t:'combo',ic:'📉',n:'折线和簇状柱形图'},
  {t:'pie',ic:'🥧',n:'饼图'},{t:'donut',ic:'🍩',n:'环形图'},
  {t:'treemap',ic:'🗂️',n:'树状图'},{t:'funnel',ic:'🔻',n:'漏斗图'},{t:'gauge',ic:'🎛️',n:'仪表盘'},
  {t:'kpi',ic:'🔢',n:'KPI卡'},{t:'card',ic:'🃏',n:'卡片'},{t:'matrix',ic:'🔲',n:'矩阵'},
  {t:'table',ic:'📋',n:'表格'},{t:'scatter',ic:'⚬',n:'散点图'},{t:'bubble',ic:'🫧',n:'气泡图'},
  {t:'waterfall',ic:'🌊',n:'瀑布图'},{t:'slicer',ic:'🔘',n:'切片器'},
];
const DZ_VNAME={}; DZ_VISUALS.forEach(v=>DZ_VNAME[v.t]=v.n);
const DZ_CART=['column','bar','line','area','stackColumn','stack100','stackBar','stack100Bar','combo','waterfall'];
// 支持"图例(维度)拆系列"的直角坐标图(Power BI: 一个图例字段→多系列)
const DZ_LEGENDABLE=['column','bar','line','area','stackColumn','stack100','stackBar','stack100Bar','combo'];
// 横向条形图(类别轴在Y)
const DZ_HBAR=['bar','stackBar','stack100Bar'];
// 百分比堆积(归一到100%)
const DZ_PCT=['stack100','stack100Bar'];
const dz={tiles:[],sel:null,nextId:1,filters:{psi:{},idc:{}},dataset:'psi',insTab:'data',
  palette:['#C7000B','#E63340','#2563C9','#1E9E57','#E0A400','#7A4FBF','#0E9AA7','#9CA2A8','#C77A00','#5A7FB5','#D24DAA','#3FA796']};
// —— 调色板预设(可整图切换,PBI 式)——
const DZ_PALETTES={
  acme:['#C7000B','#E63340','#2563C9','#1E9E57','#E0A400','#7A4FBF','#0E9AA7','#9CA2A8','#C77A00','#5A7FB5','#D24DAA','#3FA796'],
  classic:['#2563C9','#1E9E57','#E0A400','#C7000B','#7A4FBF','#0E9AA7','#C77A00','#5A7FB5','#D24DAA','#9CA2A8','#3FA796','#E63340'],
  cool:['#1E5FA8','#2E86C1','#17A589','#48C9B0','#5DADE2','#45B39D','#5499C7','#76D7C4','#7FB3D5','#A2D9CE','#2874A6','#1ABC9C'],
  warm:['#C0392B','#E67E22','#E74C3C','#F39C12','#D35400','#CB4335','#DC7633','#F5B041','#EC7063','#F8C471','#A93226','#E59866'],
  mono:['#C7000B','#D93A42','#E86B71','#F09CA0','#8A9099','#A8ADB4','#C2C6CB','#5A5F66','#7A4FBF','#9B7FD0','#B9A8E0','#3F3F46'],
};
const DZ_PALETTE_NAME={acme:'品牌红',classic:'商务',cool:'冷色',warm:'暖色',mono:'单色系'};
// —— 每个磁贴的完整格式默认值(老布局缺字段时补齐)——
const DZ_FMT_DEF={showLegend:true,showLabels:false,gran:'month',legendPos:'bottom',legendFont:10,
  palette:'acme',colors:{},unit:'auto',dec:0,labelPos:'auto',labelFont:9,
  yMin:'',yMax:'',yGrid:true,gridStyle:'solid',axisFont:10,axisRotate:'auto',
  barRadius:2,catGap:30,titleAlign:'left',titleSize:13};
function dzNormFmt(tile){ tile.fmt=Object.assign({},DZ_FMT_DEF,tile.fmt||{}); if(!tile.fmt.colors||typeof tile.fmt.colors!=='object')tile.fmt.colors={}; return tile.fmt; }
function dzPalette(tile){ return DZ_PALETTES[tile&&tile.fmt&&tile.fmt.palette]||DZ_PALETTES.acme; }
function dzSeriesColor(tile,name,i){ const ov=tile.fmt&&tile.fmt.colors&&tile.fmt.colors[name]; if(ov)return ov; const p=dzPalette(tile); return p[i%p.length]; }
// —— 统一数值格式(单位/小数):标签、坐标轴、KPI、矩阵/表格共用 ——
const DZ_UNITS={auto:'自动',none:'无',k:'千 (K)',m:'百万 (M)',wan:'万',yi:'亿'};
function dzNum(v,unit,dec){ v=+v||0; dec=(dec==null?0:+dec); let d=v,suf='';
  if(unit==='k'){d=v/1e3;suf='K';}
  else if(unit==='m'){d=v/1e6;suf='M';}
  else if(unit==='wan'){d=v/1e4;suf='万';}
  else if(unit==='yi'){d=v/1e8;suf='亿';}
  else if(unit==='auto'){ const a=Math.abs(v); if(a>=1e8){d=v/1e8;suf='亿';} else if(a>=1e4){d=v/1e4;suf='万';} }
  return d.toLocaleString('zh-CN',{minimumFractionDigits:dec,maximumFractionDigits:dec})+suf; }
function dzTileNum(tile){ const f=tile.fmt||DZ_FMT_DEF; return v=>dzNum(v,f.unit,f.dec); }
function dzFilters(ds){ ds=ds||'psi'; if(!dz.filters[ds]) dz.filters[ds]={}; return dz.filters[ds]; }
function dzFieldLabel(k,ds){ ds=ds||dz.dataset;
  if(ds==='idc') return IDC_LABEL[k]||k;
  return k==='period'?'周期':(DIM_LABEL[k]||METRIC_LABEL[k]||k); }
function dzDefAgg(field,ds){ return ds==='idc' ? (field==='asp'?'asp':'sum') : (FLOW_DEF(field)?'sum':'last'); }
function dzIdcDims(){ return (state.idcMeta&&state.idcMeta.dims)||[]; }

function buildDesigner(){
  const hasPsi=state.dims.length>0, hasIdc=!!state.idcMeta;
  if(!hasPsi && !hasIdc){ $('#dzEmpty').classList.remove('hidden'); return; }
  $('#dzEmpty').classList.add('hidden');
  if(dz.dataset==='idc' && !hasIdc) dz.dataset='psi';
  if(dz.dataset==='psi' && !hasPsi && hasIdc) dz.dataset='idc';
  // 数据源切换
  const sw=$('#dzDsSwitch');
  if(sw){ sw.innerHTML=`<button class="dz-ds ${dz.dataset==='psi'?'active':''}" data-ds="psi" ${hasPsi?'':'disabled'}>经营 PSI</button>`+
      `<button class="dz-ds ${dz.dataset==='idc'?'active':''}" data-ds="idc" ${hasIdc?'':'disabled'}>IDC 市场</button>`;
    sw.querySelectorAll('.dz-ds').forEach(b=>{ b.onclick=()=>{ if(b.hasAttribute('disabled'))return; dz.dataset=b.dataset.ds; buildDesigner(); renderDataBar('designer'); }; }); }
  const dims=$('#dzDims'); dims.innerHTML=''; const meas=$('#dzMeas'); meas.innerHTML='';
  if(dz.dataset==='idc'){
    dzIdcDims().forEach(k=>dims.appendChild(dzChip(IDC_LABEL[k]||k,k,'dim','idc')));
    IDC_MEASURES.forEach(m=>meas.appendChild(dzChip(IDC_LABEL[m],m,'mea','idc')));
  } else {
    ['period'].concat(state.dims).forEach(k=>dims.appendChild(dzChip(dzFieldLabel(k,'psi'),k,'dim','psi')));
    DZ_MEASURES.forEach(m=>meas.appendChild(dzChip(METRIC_LABEL[m],m,'mea','psi')));
  }
  const gal=$('#dzGallery'); gal.innerHTML='';
  DZ_VISUALS.forEach(v=>{ const b=document.createElement('button'); b.innerHTML='<span class="gi">'+v.ic+'</span>'+v.n; b.onclick=()=>dzAddTile(v.t); gal.appendChild(b); });
  $('#dzAddType').innerHTML=DZ_VISUALS.map(v=>`<option value="${v.t}">${v.n}</option>`).join('');
}
function dzChip(label,field,kind,ds){ const c=document.createElement('div'); c.className='dz-chip '+kind; c.textContent=label; c.draggable=true;
  c.ondragstart=e=>e.dataTransfer.setData('text/plain',JSON.stringify({field,kind,label,ds:ds||dz.dataset})); return c; }

function dzAddTile(type){
  const ds=dz.dataset;
  const idim=dzIdcDims();
  const pick=(...c)=>{ const pool=ds==='idc'?idim:state.dims; for(const k of c){ if(pool.includes(k)) return k; } return pool[0]||(ds==='idc'?'quarter':'period'); };
  const timeCat = ds==='idc' ? pick('quarter','year') : 'period';
  const d0 = ds==='idc' ? pick('brand','model','country') : (state.dims.includes('line')?'line':(state.dims[0]||'period'));
  const legDefault = ds==='idc' ? pick('brand','cat') : (state.dims.includes('line')?'line':null);
  const measDefault = ds==='idc' ? 'units' : 'sellOut';
  const wells={cat:[],legend:null,values:[]};
  if(DZ_CART.includes(type)){ wells.cat=[timeCat]; if(DZ_LEGENDABLE.includes(type)) wells.legend=legDefault; }
  else if(['pie','donut','treemap','funnel'].includes(type)) wells.cat=[d0];
  else if(type==='matrix'){ wells.cat=[d0]; wells.legend = ds==='idc'?pick('quarter','year'):(state.dims.includes('country')?'country':null); }
  else if(type==='table') wells.cat=[d0];
  else if(type==='scatter'||type==='bubble'){ wells.cat=[ds==='idc'?pick('country'):(state.dims.includes('country')?'country':d0)]; wells.legend=ds==='idc'?pick('brand'):(state.dims.includes('repOffice')?'repOffice':null); }
  else if(type==='slicer') wells.cat=[d0];
  if(type!=='slicer'){ wells.values=[{field:measDefault,agg:dzDefAgg(measDefault,ds)}];
    if(type==='table') wells.values = ds==='idc' ? [{field:'units',agg:'sum'},{field:'value',agg:'sum'}] : [{field:'sellOut',agg:'sum'},{field:'inv',agg:'last'}]; }
  const small=(type==='kpi'||type==='card'||type==='gauge'), slc=(type==='slicer');
  const n=dz.tiles.length;
  const tile={id:dz.nextId++,type,dataset:ds,x:24+(n%4)*26,y:24+(n%4)*26,
    w:slc?220:(small?250:440), h:slc?260:(small?150:300),
    wells, fmt:Object.assign({},DZ_FMT_DEF,{title:DZ_VNAME[type],colors:{}}), filters:{}, chart:null};
  dz.tiles.push(tile); dzRenderCanvas(); dzSelect(tile.id);
}

function dzRenderCanvas(){
  const cv=$('#dzCanvas'); const empty=$('#dzEmpty');
  empty.classList.toggle('hidden', dz.tiles.length>0);
  // remove tiles not in state
  Array.from(cv.querySelectorAll('.dz-tile')).forEach(el=>{ if(!dz.tiles.find(t=>'dz-tile-'+t.id===el.id)) el.remove(); });
  dz.tiles.forEach(tile=>{
    let el=document.getElementById('dz-tile-'+tile.id);
    if(!el){ el=document.createElement('div'); el.className='dz-tile'; el.id='dz-tile-'+tile.id;
      el.innerHTML=`<div class="dz-tile-head"><span class="t"></span><span class="x" data-x="${tile.id}">✕</span></div><div class="dz-tile-body" id="dz-body-${tile.id}"></div><div class="dz-resize"></div>`;
      cv.appendChild(el);
      el.onmousedown=()=>dzSelect(tile.id);
      el.querySelector('.x').onclick=e=>{ e.stopPropagation(); dzDeleteTile(tile.id); };
      dzMakeMovable(el,tile);
    }
    el.style.left=tile.x+'px'; el.style.top=tile.y+'px'; el.style.width=tile.w+'px'; el.style.height=tile.h+'px';
    el.classList.toggle('sel',dz.sel===tile.id);
    const tEl=el.querySelector('.t'); tEl.textContent=tile.fmt.title||DZ_VNAME[tile.type];
    tEl.style.flex='1'; tEl.style.textAlign=tile.fmt.titleAlign||'left'; tEl.style.fontSize=((tile.fmt.titleSize||13))+'px';
    dzRenderTile(tile);
  });
}
function dzDeleteTile(id){ const t=dz.tiles.find(x=>x.id===id); if(t&&t.chart){t.chart.dispose();} dz.tiles=dz.tiles.filter(x=>x.id!==id); if(dz.sel===id)dz.sel=null; const el=document.getElementById('dz-tile-'+id); if(el)el.remove(); dzRenderInspector(); dzRenderCanvas(); }

function dzColors(n){ const out=[]; for(let i=0;i<n;i++) out.push(dz.palette[i%dz.palette.length]); return out; }
function dzEnsureChart(tile,bodyEl){ if(!tile.chart){ bodyEl.innerHTML='<div class="ec"></div>'; tile.chart=echarts.init(bodyEl.querySelector('.ec'));
    tile.chart.on('click',p=>dzOnClick(tile,p)); } return tile.chart; }

async function dzRenderTile(tile){
  const bodyEl=document.getElementById('dz-body-'+tile.id); if(!bodyEl) return;
  dzNormFmt(tile);
  const type=tile.type, w=tile.wells, ds=tile.dataset||'psi';
  const filters=Object.assign({}, dzFilters(ds), tile.filters);
  if(type==='slicer'){ if(tile.chart){tile.chart.dispose();tile.chart=null;} dzRenderSlicer(tile,bodyEl); return; }
  const measure=(w.values[0]&&w.values[0].field)||(ds==='idc'?'units':'sellOut');
  const aggType=(w.values[0]&&w.values[0].agg)|| dzDefAgg(measure,ds);
  let catF=(w.cat[0])||(ds==='idc'?'quarter':'period');
  if(ds==='idc' && catF==='period') catF='quarter';
  const aggBase={cat:{field:catF,gran:tile.fmt.gran},measure,agg:aggType,filters,dataset:ds};
  if(type==='scatter'||type==='bubble'){ if(tile.chart){tile.chart.dispose();tile.chart=null;}
    if(ds==='idc'){ bodyEl.innerHTML='<div class="dz-ins-empty" style="padding:18px;font-size:12px">IDC 市场数据源暂不支持散点/气泡图，<br>请改用柱/条/折线/饼/树状图等。</div>'; return; }
    const res=await api.custom({xDim:w.cat[0],yDim:w.legend,sizeMetric:measure,colorDim:null,filters}); dzRenderScatter(tile,bodyEl,res); return; }
  if(type==='table'){ if(tile.chart){tile.chart.dispose();tile.chart=null;} dzRenderTable(tile,bodyEl,filters); return; }
  if(type==='matrix'){ if(tile.chart){tile.chart.dispose();tile.chart=null;}
    const res=await api.agg(Object.assign({},aggBase,{legend:w.legend})); dzRenderMatrix(tile,bodyEl,res); return; }
  if(type==='kpi'||type==='card'){ if(tile.chart){tile.chart.dispose();tile.chart=null;}
    const res=await api.agg(Object.assign({},aggBase,{legend:null})); dzRenderKpi(tile,bodyEl,res,measure); return; }
  // echarts-based
  const useLegend=DZ_LEGENDABLE.includes(type)? w.legend : null;
  const res=await api.agg(Object.assign({},aggBase,{legend:useLegend}));
  if(type==='pie'||type==='donut'){ dzRenderPie(tile,bodyEl,res,type); return; }
  if(type==='treemap'){ dzRenderTreemap(tile,bodyEl,res); return; }
  if(type==='funnel'){ dzRenderFunnel(tile,bodyEl,res); return; }
  if(type==='gauge'){ dzRenderGauge(tile,bodyEl,res,measure); return; }
  if(type==='waterfall'){ dzRenderWaterfall(tile,bodyEl,res); return; }
  dzRenderCartesian(tile,bodyEl,res);
}
function FLOW_DEF(m){ return m==='sellOut'||m==='sellIn'; }
function dzCatVal(tile,name){ const m=tile.wells.values[0]; return name; }

/* ---- 图例位置(用户可设置: 顶/底/左/右) → 返回 legend 配置 + grid 内边距增量 ---- */
function dzLegendCfg(tile,multi){
  const pos=tile.fmt.legendPos||'bottom';
  const show=!!(tile.fmt.showLegend&&multi);
  const base={show,type:'scroll',textStyle:{fontFamily:YH,fontSize:(tile.fmt&&tile.fmt.legendFont)||10,color:CT().ink2()},itemWidth:11,itemHeight:8};
  const pad={left:0,right:0,top:0,bottom:0};
  if(!show) return {legend:base,pad};
  if(pos==='top'){ Object.assign(base,{top:0,left:'center',orient:'horizontal'}); pad.top=24; }
  else if(pos==='left'){ Object.assign(base,{left:0,top:'middle',orient:'vertical'}); pad.left=82; }
  else if(pos==='right'){ Object.assign(base,{right:0,top:'middle',orient:'vertical'}); pad.right=82; }
  else { Object.assign(base,{bottom:0,left:'center',orient:'horizontal'}); pad.bottom=24; }
  return {legend:base,pad};
}

/* ---- 渲染：直角坐标(簇状/堆积/百分比 × 柱形/条形, 折线/面积/组合) ---- */
function dzRenderCartesian(tile,bodyEl,res){
  const ch=dzEnsureChart(tile,bodyEl); const type=tile.type; const f=tile.fmt; const numF=dzTileNum(tile);
  const series=res.series, cats=res.cats, data=res.data;
  const horizontal=DZ_HBAR.includes(type);
  const pct=DZ_PCT.includes(type);
  const stacked=(type==='area'||type==='stackColumn'||type==='stackBar'||pct);
  let totals=null; if(pct) totals=cats.map(c=>series.reduce((a,se)=>a+(data[se][c]||0),0));
  const cv=(se,c,ci)=>{ const v=data[se][c]||0; if(pct){ const t=totals[ci]; return t>0?+(v/t*100).toFixed(2):0; } return +v.toFixed(2); };
  // 数据标签位置(用户可选:自动/顶端外/内部/底部)
  const lp=f.labelPos;
  const labPos = horizontal
    ? (lp==='outEnd'?'right':lp==='inside'?'inside':lp==='insideBase'?'insideLeft':(stacked?'inside':'right'))
    : (lp==='outEnd'?'top':lp==='inside'?'inside':lp==='insideBase'?'insideBottom':(stacked?'inside':'top'));
  const inside=(labPos==='inside'||labPos==='insideBottom'||labPos==='insideLeft');
  const gap=(f.catGap==null?30:f.catGap)+'%', br=f.barRadius||0;
  const ec=series.map((se,si)=>{
    const col=dzSeriesColor(tile,se,si);
    const dat=cats.map((c,ci)=>cv(se,c,ci));
    const lab={show:f.showLabels,position:labPos,fontFamily:YH,fontSize:f.labelFont,color:(stacked||inside)?'#fff':'#333',textBorderWidth:0,formatter:p=> pct?(p.value?Math.round(p.value)+'%':''):numF(p.value)};
    if(type==='line') return {name:se,type:'line',smooth:false,symbol:'circle',symbolSize:4,lineStyle:{width:2,color:col},itemStyle:{color:col},label:Object.assign({},lab,{position:'top',color:'#333'}),data:dat};
    if(type==='area') return {name:se,type:'line',stack:'s',areaStyle:{color:col,opacity:.85},lineStyle:{width:1,color:'#fff'},symbol:'none',itemStyle:{color:col},label:Object.assign({},lab,{color:'#fff'}),data:dat};
    if(type==='combo') return si===0? {name:se,type:'line',symbol:'circle',symbolSize:5,lineStyle:{width:2.5,color:'#1A1A1A'},itemStyle:{color:'#1A1A1A'},z:5,label:Object.assign({},lab,{position:'top',color:'#333'}),data:dat} : {name:se,type:'bar',barCategoryGap:gap,itemStyle:{color:col,borderRadius:[br,br,0,0]},label:Object.assign({},lab,{color:'#333',position:inside?labPos:'top'}),data:dat};
    const rad = horizontal? (stacked?0:[0,br,br,0]) : (stacked?0:[br,br,0,0]);
    return {name:se,type:'bar',stack:stacked?'s':undefined,barCategoryGap:gap,itemStyle:{color:col,borderColor:'#fff',borderWidth:.3,borderRadius:rad},label:lab,data:dat};
  });
  const axFont=f.axisFont||10;
  const rot=(f.axisRotate==null||f.axisRotate==='auto')?(cats.length>6&&!horizontal?30:0):(+f.axisRotate||0);
  const catAxis={type:'category',data:cats,axisLabel:{fontFamily:YH,fontSize:axFont,color:CT().ink3(),interval:cats.length>10?'auto':0,rotate:rot},axisLine:{lineStyle:{color:CT().line()}},axisTick:{show:false}};
  const gridSplit=f.yGrid===false?{show:false}:{lineStyle:{color:CT().lineSoft(),type:f.gridStyle||'solid'}};
  const valAxis={type:'value',max:pct?100:(f.yMax===''||f.yMax==null?null:+f.yMax),min:pct?0:(f.yMin===''||f.yMin==null?null:+f.yMin),axisLabel:{fontFamily:YH,fontSize:axFont,color:CT().ink3(),formatter:v=>pct?v+'%':numF(v)},splitLine:gridSplit};
  const multi=series.length>1&&series[0]!=='(值)';
  const {legend,pad}=dzLegendCfg(tile,multi);
  ch.setOption({textStyle:{fontFamily:YH},
    tooltip:{trigger:'axis',backgroundColor:'rgba(26,26,26,.92)',borderWidth:0,textStyle:{color:'#fff',fontFamily:YH,fontSize:11},
      valueFormatter:v=>pct?(v||0)+'%':numF(v)},
    legend:legend,
    grid:{left:(horizontal?70:48)+pad.left,right:14+pad.right,top:12+pad.top,bottom:22+pad.bottom},
    xAxis:horizontal?valAxis:catAxis, yAxis:horizontal?catAxis:valAxis,
    dataZoom:[{type:'inside',zoomOnMouseWheel:'ctrl',moveOnMouseWheel:false}], series:ec},true);
  tile._names=series.slice();
  setTimeout(()=>ch.resize(),20);
}
function dzRenderPie(tile,bodyEl,res,type){
  const ch=dzEnsureChart(tile,bodyEl); const cats=res.cats; const f=tile.fmt; const numF=dzTileNum(tile);
  const se=res.series[0]; const arr=cats.map((c,i)=>({name:c,value:+(res.data[se][c]||0).toFixed(2),itemStyle:{color:dzSeriesColor(tile,c,i)}})).filter(o=>o.value>0);
  const {legend,pad}=dzLegendCfg(tile,true);
  // 根据图例位置把饼图中心让出空间
  const cx=50+(pad.left?14:0)-(pad.right?14:0), cy=46+(pad.top?8:0)-(pad.bottom?6:0);
  const labFmt=p=> (f.labelPos==='value')?(p.name+'\n'+numF(p.value)):(p.name+'\n'+p.percent+'%');
  ch.setOption({textStyle:{fontFamily:YH},tooltip:{trigger:'item',formatter:p=>p.name+'：'+numF(p.value)+' ('+p.percent+'%)',backgroundColor:'rgba(26,26,26,.92)',borderWidth:0,textStyle:{color:'#fff',fontFamily:YH}},
    legend:legend,
    series:[{type:'pie',radius:type==='donut'?['42%','64%']:'64%',center:[cx+'%',cy+'%'],data:arr,
      label:{show:f.showLabels,fontFamily:YH,fontSize:(f.labelFont||9)+1,formatter:labFmt},labelLine:{show:f.showLabels}}]},true);
  tile._names=cats.slice();
  setTimeout(()=>ch.resize(),20);
}
function dzRenderTreemap(tile,bodyEl,res){
  const ch=dzEnsureChart(tile,bodyEl); const se=res.series[0]; const numF=dzTileNum(tile);
  const arr=res.cats.map((c,i)=>({name:c,value:+(res.data[se][c]||0).toFixed(2),itemStyle:{color:dzSeriesColor(tile,c,i)}})).filter(o=>o.value>0);
  ch.setOption({textStyle:{fontFamily:YH},tooltip:{formatter:p=>p.name+'：'+numF(p.value)},
    series:[{type:'treemap',roam:false,nodeClick:false,breadcrumb:{show:false},data:arr,label:{fontFamily:YH,fontSize:(tile.fmt.labelFont||9)+2,formatter:p=>p.name+'\n'+numF(p.value)}}]},true);
  tile._names=res.cats.slice();
  setTimeout(()=>ch.resize(),20);
}
function dzRenderFunnel(tile,bodyEl,res){
  const ch=dzEnsureChart(tile,bodyEl); const se=res.series[0]; const numF=dzTileNum(tile);
  const arr=res.cats.map((c,i)=>({name:c,value:+(res.data[se][c]||0).toFixed(2),itemStyle:{color:dzSeriesColor(tile,c,i)}})).filter(o=>o.value>0).sort((a,b)=>b.value-a.value);
  ch.setOption({textStyle:{fontFamily:YH},tooltip:{formatter:p=>p.name+'：'+numF(p.value)},
    series:[{type:'funnel',left:'8%',right:'8%',top:10,bottom:10,data:arr,label:{fontFamily:YH,fontSize:(tile.fmt.labelFont||9)+1,formatter:p=>p.name+' '+numF(p.value)}}]},true);
  tile._names=res.cats.slice();
  setTimeout(()=>ch.resize(),20);
}
function dzRenderGauge(tile,bodyEl,res,measure){
  const ch=dzEnsureChart(tile,bodyEl); const numF=dzTileNum(tile); const f=tile.fmt;
  const total=res.total||0; const max=(f.yMax!==''&&f.yMax!=null)?+f.yMax:Math.max(1,total*1.4);
  ch.setOption({textStyle:{fontFamily:YH},series:[{type:'gauge',min:(f.yMin!==''&&f.yMin!=null)?+f.yMin:0,max:Math.round(max),progress:{show:true,width:14},axisLine:{lineStyle:{width:14}},
    pointer:{show:true},detail:{valueAnimation:true,fontFamily:YH,fontSize:18,formatter:v=>numF(v),offsetCenter:[0,'60%']},
    data:[{value:Math.round(total),name:dzFieldLabel(measure,tile.dataset)}],title:{fontFamily:YH,fontSize:11,offsetCenter:[0,'88%']},
    axisLabel:{fontFamily:YH,fontSize:9},itemStyle:{color:dzSeriesColor(tile,measure,0)}}]},true);
  setTimeout(()=>ch.resize(),20);
}
function dzRenderWaterfall(tile,bodyEl,res){
  const ch=dzEnsureChart(tile,bodyEl); const se=res.series[0]; const cats=res.cats; const f=tile.fmt; const numF=dzTileNum(tile);
  const vals=cats.map(c=>+(res.data[se][c]||0).toFixed(2));
  const base=[]; let run=0; vals.forEach(v=>{ base.push(run); run+=v; });
  const axFont=f.axisFont||10, br=f.barRadius||0;
  ch.setOption({textStyle:{fontFamily:YH},tooltip:{trigger:'axis',formatter:p=>{const i=p[0].dataIndex;return cats[i]+'：'+numF(vals[i])+'<br>累计：'+numF(base[i]+vals[i]);}},
    grid:{left:48,right:14,top:14,bottom:28},xAxis:{type:'category',data:cats,axisLabel:{fontFamily:YH,fontSize:axFont,color:CT().ink3(),rotate:cats.length>6?30:0}},
    yAxis:{type:'value',axisLabel:{fontFamily:YH,fontSize:axFont,formatter:v=>numF(v)},splitLine:f.yGrid===false?{show:false}:{lineStyle:{color:CT().lineSoft(),type:f.gridStyle||'solid'}}},
    series:[{type:'bar',stack:'w',itemStyle:{borderColor:'transparent',color:'transparent'},data:base},
      {type:'bar',stack:'w',data:vals.map(v=>({value:v,itemStyle:{color:v>=0?'#1E9E57':'#C7000B',borderRadius:[br,br,0,0]}})),label:{show:f.showLabels,position:'top',fontFamily:YH,fontSize:f.labelFont||9,formatter:p=>numF(p.value)}}]},true);
  setTimeout(()=>ch.resize(),20);
}
function dzRenderScatter(tile,bodyEl,res){
  const ch=dzEnsureChart(tile,bodyEl); const numF=dzTileNum(tile); const axFont=tile.fmt.axisFont||10;
  const xs=res.xs.length?res.xs:['(全部)'], ys=res.ys.length?res.ys:['(全部)'];
  let maxS=1; res.points.forEach(p=>{ if(Math.abs(p.size)>maxS)maxS=Math.abs(p.size); });
  const scale=v=> tile.type==='scatter'?10:Math.round(10+Math.sqrt(Math.abs(v)/maxS)*46);
  ch.setOption({textStyle:{fontFamily:YH},tooltip:{trigger:'item',formatter:p=>p.data[3]+' / '+p.data[4]+'：'+numF(p.data[2])},
    grid:{left:100,right:20,top:14,bottom:48},
    xAxis:{type:'category',data:xs,axisLabel:{fontFamily:YH,fontSize:axFont,color:CT().ink3(),rotate:xs.length>6?30:0}},
    yAxis:{type:'category',data:ys,axisLabel:{fontFamily:YH,fontSize:axFont,color:CT().ink3()}},
    series:[{type:'scatter',symbolSize:d=>scale(d[2]),itemStyle:{color:dzSeriesColor(tile,'',0),opacity:.7,borderColor:'#fff'},
      data:res.points.map(p=>[xs.indexOf(p.x),ys.indexOf(p.y),p.size,p.x,p.y])}]},true);
  setTimeout(()=>ch.resize(),20);
}
function dzRenderKpi(tile,bodyEl,res,measure){
  const total=res.total||0; const numF=dzTileNum(tile);
  bodyEl.innerHTML=`<div class="dz-kpi"><div class="v">${numF(total)}</div><div class="k">${tile.fmt.title||dzFieldLabel(measure,tile.dataset)}</div></div>`;
}
function dzRenderMatrix(tile,bodyEl,res){
  const cats=res.cats, series=res.series; const numF=dzTileNum(tile);
  let h='<table class="rep-table" style="font-size:11px"><tr><th>'+dzFieldLabel(tile.wells.cat[0]||'',tile.dataset)+'</th>'+series.map(s=>`<th>${s}</th>`).join('')+'<th>合计</th></tr>';
  cats.forEach(c=>{ let rt=0; h+='<tr><td>'+c+'</td>'+series.map(s=>{const v=res.data[s][c]||0; rt+=v; return `<td>${numF(v)}</td>`;}).join('')+`<td><b>${numF(rt)}</b></td></tr>`; });
  // 合计行
  h+='<tr class="total"><td>合计</td>'+series.map(s=>{const ct=cats.reduce((a,c)=>a+(res.data[s][c]||0),0);return `<td>${numF(ct)}</td>`;}).join('')+`<td>${numF(res.total)}</td></tr>`;
  h+='</table>';
  bodyEl.innerHTML=h;
}
async function dzRenderTable(tile,bodyEl,filters){
  const ds=tile.dataset||'psi';
  const catF=tile.wells.cat[0]||(ds==='idc'?'brand':'line');
  // 每个度量一列
  const cols=tile.wells.values.length?tile.wells.values:[{field:ds==='idc'?'units':'sellOut',agg:'sum'}];
  const results=await Promise.all(cols.map(c=>api.agg({cat:{field:catF,gran:tile.fmt.gran},legend:null,measure:c.field,agg:c.agg,filters,dataset:ds})));
  const cats=results[0].cats; const numF=dzTileNum(tile);
  let h='<table class="rep-table" style="font-size:11px"><tr><th>'+dzFieldLabel(catF,ds)+'</th>'+cols.map(c=>`<th>${dzFieldLabel(c.field,ds)}</th>`).join('')+'</tr>';
  cats.forEach(c=>{ h+='<tr><td>'+c+'</td>'+results.map(r=>`<td>${numF(r.data['(值)'][c]||0)}</td>`).join('')+'</tr>'; });
  h+='<tr class="total"><td>合计</td>'+results.map(r=>`<td>${numF(r.total)}</td>`).join('')+'</tr></table>';
  bodyEl.innerHTML=h;
}
async function dzRenderSlicer(tile,bodyEl){
  const ds=tile.dataset||'psi';
  const field=tile.wells.cat[0]; if(!field||field==='period'){ bodyEl.innerHTML='<div class="dz-slicer" style="color:var(--c-ink-3);font-size:12px">把一个维度拖到"字段"格子</div>'; return; }
  const opts= ds==='idc' ? await api.idcOptions(field,{}) : await api.options(field,{});
  const F=dzFilters(ds); const cur=asArrLocal(F[field]);
  bodyEl.innerHTML='<div class="dz-slicer"></div>'; const box=bodyEl.querySelector('.dz-slicer');
  box.innerHTML='<div style="font-size:11px;color:var(--ink3);margin-bottom:6px">'+dzFieldLabel(field,ds)+'</div>'+
    opts.map(o=>`<label class="ms-opt" style="font-size:11px"><input type="checkbox" ${cur.includes(o)?'checked':''} value="${o}"><span class="ot">${o}</span></label>`).join('');
  box.querySelectorAll('input').forEach(inp=>inp.onchange=()=>{ const sel=Array.from(box.querySelectorAll('input:checked')).map(x=>x.value);
    if(sel.length) F[field]=sel; else delete F[field]; dzApplyCrossFilter(); });
}

/* ---- 交互/联动筛选(按数据源各自命名空间) ---- */
function dzOnClick(tile,p){
  const ds=tile.dataset||'psi';
  const field=tile.wells.cat[0]; if(!field||field==='period') return;
  const val=p.name; if(val==null) return;
  const F=dzFilters(ds); const cur=asArrLocal(F[field]);
  if(cur.length===1&&cur[0]===val) delete F[field]; else F[field]=[val];
  dzApplyCrossFilter();
}
function dzApplyCrossFilter(){
  const chips=[];
  ['psi','idc'].forEach(ds=>Object.entries(dzFilters(ds)).forEach(([k,v])=>{ if(asArrLocal(v).length) chips.push((ds==='idc'?'IDC·':'')+dzFieldLabel(k,ds)+'：'+asArrLocal(v).join(',')); }));
  $('#dzCrossFilter').innerHTML = chips.length? ('🔎 '+chips.join(' · ')+' <span class="x" id="dzClearCf">✕清除</span>') : '';
  const c=document.getElementById('dzClearCf'); if(c)c.onclick=()=>{ dz.filters={psi:{},idc:{}}; dzApplyCrossFilter(); };
  dz.tiles.forEach(t=>dzRenderTile(t));
}

/* ---- 选中/检查器(字段格子+格式) ---- */
function dzSelect(id){ dz.sel=id; const t0=dz.tiles.find(t=>t.id===id);
  if(t0 && t0.dataset && t0.dataset!==dz.dataset){ dz.dataset=t0.dataset; buildDesigner(); }
  dz.tiles.forEach(t=>{ const el=document.getElementById('dz-tile-'+t.id); if(el)el.classList.toggle('sel',t.id===id); }); dzRenderInspector(); }
function dzRenderInspector(){
  const ins=$('#dzInspector'); const tile=dz.tiles.find(t=>t.id===dz.sel);
  if(!tile){ ins.innerHTML='<div class="dz-ins-empty">选中一个图表后<br>在这里拖入字段、改类型和格式</div>'; return; }
  dzNormFmt(tile);
  if(!dz.insTab) dz.insTab='data'; const tab=dz.insTab;
  let h='<div class="dz-ds-badge">数据源：'+(tile.dataset==='idc'?'IDC 市场':'经营 PSI')+'</div>';
  h+='<div class="dz-ins-tabs"><button class="dz-itab '+(tab==='data'?'active':'')+'" data-tab="data">字段</button><button class="dz-itab '+(tab==='fmt'?'active':'')+'" data-tab="fmt">格式</button></div>';
  h+=(tab==='data')?dzInsDataHtml(tile):dzInsFmtHtml(tile);
  ins.innerHTML=h;
  ins.querySelectorAll('.dz-itab').forEach(b=>b.onclick=()=>{ dz.insTab=b.dataset.tab; dzRenderInspector(); });
  if(tab==='data') dzWireData(tile); else dzWireFmt(tile);
}
function dzInsDataHtml(tile){
  let h='<div class="dz-well"><label>图表类型</label><select id="dzInsType">'+DZ_VISUALS.map(v=>`<option value="${v.t}" ${v.t===tile.type?'selected':''}>${v.n}</option>`).join('')+'</select></div>';
  if(tile.type==='slicer'){ h+=dzWellHtml('cat','字段(维度)'); }
  else if(tile.type==='scatter'||tile.type==='bubble'){ h+=dzWellHtml('cat','X轴(维度)')+dzWellHtml('legend','Y轴(维度)')+dzWellHtml('values','气泡大小(度量)'); }
  else if(tile.type==='matrix'){ h+=dzWellHtml('cat','行(维度)')+dzWellHtml('legend','列(维度)')+dzWellHtml('values','值(度量)'); }
  else if(tile.type==='table'){ h+=dzWellHtml('cat','行(维度)')+dzWellHtml('values','值(度量,可多个)',true); }
  else if(tile.type==='kpi'||tile.type==='card'||tile.type==='gauge'){ h+=dzWellHtml('values','值(度量)'); }
  else { h+=dzWellHtml('cat','类别轴(维度)')+( DZ_LEGENDABLE.includes(tile.type)?dzWellHtml('legend','图例(维度)'):'')+dzWellHtml('values','值(度量)',tile.type==='combo'); }
  if((tile.wells.cat[0]==='period')) h+=`<div class="dz-well"><label>时间粒度</label><select id="dzInsGran"><option value="day"${tile.fmt.gran==='day'?' selected':''}>日</option><option value="week"${tile.fmt.gran==='week'?' selected':''}>周</option><option value="month"${tile.fmt.gran==='month'?' selected':''}>月</option></select></div>`;
  return h;
}
function dzWireData(tile){
  $('#dzInsType').onchange=e=>{ tile.type=e.target.value; if(tile.chart){tile.chart.dispose();tile.chart=null;} dzRenderInspector(); dzRenderCanvas(); };
  const gr=$('#dzInsGran'); if(gr) gr.onchange=e=>{ tile.fmt.gran=e.target.value; dzRenderTile(tile); };
  dzWireWells(tile);
}
function dzGrp(title,inner){ return '<div class="dz-fgrp"><div class="dz-fgrp-h">'+title+'</div>'+inner+'</div>'; }
function dzInsFmtHtml(tile){
  const f=tile.fmt, type=tile.type;
  const isCart=DZ_CART.includes(type);
  const isBarLike=['column','bar','stackColumn','stack100','stackBar','stack100Bar','combo'].includes(type);
  const isPie=(type==='pie'||type==='donut');
  const hasAxis=isCart&&type!=='waterfall';
  const hasLegend=DZ_LEGENDABLE.includes(type)||isPie;
  const hasColors=(isCart&&type!=='waterfall')||isPie||type==='treemap'||type==='funnel';
  const hasNum=type!=='slicer';
  const hasLabels=['slicer','table','matrix','kpi','card'].indexOf(type)<0;
  const isPctChart=DZ_PCT.includes(type);
  let h='';
  // —— 标题 ——
  h+=dzGrp('标题',
    '<div class="dz-well"><label>文本</label><input type="text" id="dzInsTitle" value="'+(f.title||'').replace(/"/g,'&quot;')+'"></div>'
    +'<div class="dz-frow"><label>对齐</label><select id="dzInsTitleAlign">'+[['left','左'],['center','中'],['right','右']].map(o=>`<option value="${o[0]}"${f.titleAlign===o[0]?' selected':''}>${o[1]}</option>`).join('')+'</select>'
    +'<label>字号</label><input type="number" id="dzInsTitleSize" min="9" max="22" value="'+(f.titleSize||13)+'"></div>');
  // —— 配色 ——
  if(hasColors){
    const names=(tile._names||[]).filter(n=>n!=null&&n!=='');
    let sw = names.length
      ? '<div class="dz-swatches">'+names.map((n,i)=>'<label class="dz-sw"><input type="color" data-name="'+String(n).replace(/"/g,'&quot;')+'" value="'+dzSeriesColor(tile,n,i)+'"><span>'+(n==='(值)'?'系列':n)+'</span></label>').join('')+'</div><button class="dz-mini" id="dzColReset">重置为调色板</button>'
      : '<div class="dz-hint">渲染出数据后可逐条改色</div>';
    h+=dzGrp('配色',
      '<div class="dz-frow"><label>调色板</label><select id="dzInsPalette">'+Object.keys(DZ_PALETTES).map(k=>`<option value="${k}"${f.palette===k?' selected':''}>${DZ_PALETTE_NAME[k]||k}</option>`).join('')+'</select></div>'+sw);
  }
  // —— 数据标签 ——
  if(hasLabels){
    let posSel='';
    if(isPie) posSel='<div class="dz-frow"><label>内容</label><select id="dzInsLabelPos"><option value="auto"'+(f.labelPos!=='value'?' selected':'')+'>百分比</option><option value="value"'+(f.labelPos==='value'?' selected':'')+'>数值</option></select></div>';
    else if(isBarLike) posSel='<div class="dz-frow"><label>位置</label><select id="dzInsLabelPos">'+[['auto','自动'],['outEnd','顶端(外)'],['inside','内部'],['insideBase','底部']].map(o=>`<option value="${o[0]}"${f.labelPos===o[0]?' selected':''}>${o[1]}</option>`).join('')+'</select></div>';
    h+=dzGrp('数据标签',
      '<label class="dz-chk"><input type="checkbox" id="dzInsLabels" '+(f.showLabels?'checked':'')+'>显示数据标签</label>'+posSel
      +'<div class="dz-frow"><label>字号</label><input type="number" id="dzInsLabelFont" min="7" max="16" value="'+(f.labelFont||9)+'"></div>');
  }
  // —— 数值格式 ——
  if(hasNum&&!isPctChart){
    h+=dzGrp('数值格式',
      '<div class="dz-frow"><label>单位</label><select id="dzInsUnit">'+Object.keys(DZ_UNITS).map(k=>`<option value="${k}"${f.unit===k?' selected':''}>${DZ_UNITS[k]}</option>`).join('')+'</select>'
      +'<label>小数</label><input type="number" id="dzInsDec" min="0" max="4" value="'+(f.dec||0)+'"></div>');
  }
  // —— 坐标轴 ——
  if(hasAxis){
    h+=dzGrp('坐标轴',
      '<div class="dz-frow"><label>Y最小</label><input type="number" id="dzInsYMin" value="'+(f.yMin===''?'':f.yMin)+'" placeholder="自动"><label>Y最大</label><input type="number" id="dzInsYMax" value="'+(f.yMax===''?'':f.yMax)+'" placeholder="自动"></div>'
      +'<label class="dz-chk"><input type="checkbox" id="dzInsYGrid" '+(f.yGrid?'checked':'')+'>显示网格线</label>'
      +'<div class="dz-frow"><label>网格</label><select id="dzInsGrid">'+[['solid','实线'],['dashed','虚线'],['dotted','点线']].map(o=>`<option value="${o[0]}"${f.gridStyle===o[0]?' selected':''}>${o[1]}</option>`).join('')+'</select>'
      +'<label>轴字号</label><input type="number" id="dzInsAxisFont" min="7" max="16" value="'+(f.axisFont||10)+'"></div>'
      +'<div class="dz-frow"><label>标签角度</label><select id="dzInsRotate">'+[['auto','自动'],['0','0°'],['30','30°'],['45','45°'],['90','90°']].map(o=>`<option value="${o[0]}"${String(f.axisRotate)===o[0]?' selected':''}>${o[1]}</option>`).join('')+'</select></div>');
  }
  // —— 柱形 ——
  if(isBarLike){
    h+=dzGrp('柱形',
      '<div class="dz-frow"><label>圆角</label><input type="number" id="dzInsBarR" min="0" max="20" value="'+(f.barRadius||0)+'"><label>类别间距%</label><input type="number" id="dzInsCatGap" min="0" max="80" value="'+(f.catGap==null?30:f.catGap)+'"></div>');
  }
  // —— 图例 ——
  if(hasLegend){
    const lp=f.legendPos||'bottom';
    h+=dzGrp('图例',
      '<label class="dz-chk"><input type="checkbox" id="dzInsLegend" '+(f.showLegend?'checked':'')+'>显示图例</label>'
      +'<div class="dz-frow"><label>位置</label><select id="dzInsLegendPos">'+[['top','顶部'],['bottom','底部'],['left','左侧'],['right','右侧']].map(o=>`<option value="${o[0]}"${lp===o[0]?' selected':''}>${o[1]}</option>`).join('')+'</select>'
      +'<label>字号</label><input type="number" id="dzInsLegendFont" min="7" max="16" value="'+(f.legendFont||10)+'"></div>');
  }
  return h;
}
function dzWireFmt(tile){
  const f=tile.fmt; const re=()=>dzRenderTile(tile);
  const on=(id,ev,fn)=>{ const el=$('#'+id); if(el) el[ev]=fn; };
  on('dzInsTitle','oninput',e=>{ f.title=e.target.value; const el=document.getElementById('dz-tile-'+tile.id); if(el)el.querySelector('.t').textContent=e.target.value; });
  on('dzInsTitleAlign','onchange',e=>{ f.titleAlign=e.target.value; dzRenderCanvas(); });
  on('dzInsTitleSize','oninput',e=>{ f.titleSize=+e.target.value||13; dzRenderCanvas(); });
  on('dzInsPalette','onchange',e=>{ f.palette=e.target.value; f.colors={}; re(); dzRenderInspector(); });
  on('dzColReset','onclick',()=>{ f.colors={}; re(); dzRenderInspector(); });
  $$('#dzInspector input[type=color][data-name]').forEach(inp=>inp.oninput=()=>{ f.colors[inp.dataset.name]=inp.value; re(); });
  on('dzInsLabels','onchange',e=>{ f.showLabels=e.target.checked; re(); });
  on('dzInsLabelPos','onchange',e=>{ f.labelPos=e.target.value; re(); });
  on('dzInsLabelFont','oninput',e=>{ f.labelFont=+e.target.value||9; re(); });
  on('dzInsUnit','onchange',e=>{ f.unit=e.target.value; re(); });
  on('dzInsDec','oninput',e=>{ f.dec=Math.max(0,+e.target.value||0); re(); });
  on('dzInsYMin','oninput',e=>{ f.yMin=e.target.value===''?'':+e.target.value; re(); });
  on('dzInsYMax','oninput',e=>{ f.yMax=e.target.value===''?'':+e.target.value; re(); });
  on('dzInsYGrid','onchange',e=>{ f.yGrid=e.target.checked; re(); });
  on('dzInsGrid','onchange',e=>{ f.gridStyle=e.target.value; re(); });
  on('dzInsAxisFont','oninput',e=>{ f.axisFont=+e.target.value||10; re(); });
  on('dzInsRotate','onchange',e=>{ f.axisRotate=e.target.value; re(); });
  on('dzInsBarR','oninput',e=>{ f.barRadius=Math.max(0,+e.target.value||0); re(); });
  on('dzInsCatGap','oninput',e=>{ f.catGap=Math.max(0,Math.min(80,+e.target.value||0)); re(); });
  on('dzInsLegend','onchange',e=>{ f.showLegend=e.target.checked; re(); });
  on('dzInsLegendPos','onchange',e=>{ f.legendPos=e.target.value; re(); });
  on('dzInsLegendFont','oninput',e=>{ f.legendFont=+e.target.value||10; re(); });
}
function dzWellHtml(well,label,multi){
  return `<div class="dz-well"><label>${label}</label><div class="dz-drop" data-well="${well}"><span class="ph">拖字段到此</span></div></div>`;
}
function dzWireWells(tile){
  $$('#dzInspector .dz-drop').forEach(drop=>{
    const well=drop.dataset.well;
    // fill current
    drop.innerHTML='';
    const cur = well==='values'? tile.wells.values : well==='legend'? (tile.wells.legend?[tile.wells.legend]:[]) : tile.wells.cat;
    if(!cur.length) drop.innerHTML='<span class="ph">拖字段到此</span>';
    else cur.forEach((item,idx)=>{
      const field=well==='values'?item.field:item;
      const tag=document.createElement('span'); tag.className='dz-tag';
      let inner=dzFieldLabel(field,tile.dataset);
      if(well==='values'){ inner+=' <select data-agg="'+idx+'">'+['sum','avg','last','count','max','min'].map(a=>`<option value="${a}" ${item.agg===a?'selected':''}>${({sum:'求和',avg:'均值',last:'最新',count:'计数',max:'最大',min:'最小'})[a]}</option>`).join('')+'</select>'; }
      tag.innerHTML=inner+' <span class="x" data-i="'+idx+'">✕</span>';
      drop.appendChild(tag);
    });
    drop.querySelectorAll('.x').forEach(x=>x.onclick=()=>{ const i=+x.dataset.i;
      if(well==='values') tile.wells.values.splice(i,1); else if(well==='legend') tile.wells.legend=null; else tile.wells.cat.splice(i,1);
      dzRenderInspector(); dzRenderTile(tile); });
    drop.querySelectorAll('select[data-agg]').forEach(s=>s.onchange=()=>{ tile.wells.values[+s.dataset.agg].agg=s.value; dzRenderTile(tile); });
    drop.ondragover=e=>{ e.preventDefault(); drop.classList.add('over'); };
    drop.ondragleave=()=>drop.classList.remove('over');
    drop.ondrop=e=>{ e.preventDefault(); drop.classList.remove('over'); let d; try{d=JSON.parse(e.dataTransfer.getData('text/plain'));}catch(_){return;}
      const wantMea=(well==='values'); if(wantMea&&d.kind!=='mea'){toast('"值"要放度量','err');return;} if(!wantMea&&d.kind!=='dim'){toast('这里要放维度','err');return;}
      if(d.ds && d.ds!==(tile.dataset||'psi')){ toast('该字段属于「'+(d.ds==='idc'?'IDC市场':'经营PSI')+'」数据源，与此图不一致','err'); return; }
      if(well==='values'){ const ag=dzDefAgg(d.field,tile.dataset); if(multi) tile.wells.values.push({field:d.field,agg:ag}); else tile.wells.values=[{field:d.field,agg:ag}]; }
      else if(well==='legend'){ tile.wells.legend=d.field; }
      else { tile.wells.cat=[d.field]; }
      dzRenderInspector(); dzRenderTile(tile); };
  });
}

/* ---- 拖动/缩放磁贴 ---- */
function dzMakeMovable(el,tile){
  const head=el.querySelector('.dz-tile-head'), rz=el.querySelector('.dz-resize');
  head.onmousedown=e=>{ if(e.target.classList.contains('x'))return; e.preventDefault(); dzSelect(tile.id);
    const sx=e.clientX,sy=e.clientY,ox=tile.x,oy=tile.y;
    const mv=ev=>{ tile.x=Math.max(0,ox+ev.clientX-sx); tile.y=Math.max(0,oy+ev.clientY-sy); el.style.left=tile.x+'px'; el.style.top=tile.y+'px'; };
    const up=()=>{ document.removeEventListener('mousemove',mv); document.removeEventListener('mouseup',up); };
    document.addEventListener('mousemove',mv); document.addEventListener('mouseup',up); };
  rz.onmousedown=e=>{ e.preventDefault(); e.stopPropagation();
    const sx=e.clientX,sy=e.clientY,ow=tile.w,oh=tile.h;
    const mv=ev=>{ tile.w=Math.max(180,ow+ev.clientX-sx); tile.h=Math.max(120,oh+ev.clientY-sy); el.style.width=tile.w+'px'; el.style.height=tile.h+'px'; if(tile.chart)tile.chart.resize(); };
    const up=()=>{ document.removeEventListener('mousemove',mv); document.removeEventListener('mouseup',up); if(tile.chart)tile.chart.resize(); else dzRenderTile(tile); };
    document.addEventListener('mousemove',mv); document.addEventListener('mouseup',up); };
}

/* ---- 保存/加载/导出 ---- */
function dzSerialize(){ return JSON.stringify({tiles:dz.tiles.map(t=>({type:t.type,dataset:t.dataset||'psi',x:t.x,y:t.y,w:t.w,h:t.h,wells:t.wells,fmt:t.fmt,filters:t.filters})),filters:dz.filters,nextId:dz.nextId}); }
function dzSaveLayout(){ try{ localStorage.setItem('salesboard', dzSerialize()); toast('看板布局已保存','ok'); }catch(e){ toast('保存失败','err'); } }
function dzLoadLayout(){ try{ const s=localStorage.getItem('salesboard'); if(!s){toast('没有已保存的布局','err');return;} const o=JSON.parse(s);
  dz.tiles.forEach(t=>{if(t.chart)t.chart.dispose();}); $('#dzCanvas').querySelectorAll('.dz-tile').forEach(el=>el.remove());
  dz.tiles=(o.tiles||[]).map((t,i)=>Object.assign({id:i+1,chart:null,dataset:t.dataset||'psi'},t)); dz.nextId=(dz.tiles.length+1);
  dz.filters=(o.filters&&(o.filters.psi||o.filters.idc))?{psi:o.filters.psi||{},idc:o.filters.idc||{}}:{psi:o.filters||{},idc:{}}; dz.sel=null;
  dzRenderCanvas(); dzApplyCrossFilter(); dzRenderInspector(); toast('已加载看板布局','ok'); }catch(e){ toast('加载失败','err'); } }
async function dzExportPpt(){
  if(!dz.tiles.length){ toast('画布为空','err'); return; }
  const pptx=new PptxGenJS(); pptx.defineLayout({name:'W',width:13.333,height:7.5}); pptx.layout='W';
  const s=pptx.addSlide(); s.background={color:'F4F5F7'};
  // 画布坐标→幻灯片(按比例)。取画布范围
  let maxX=1,maxY=1; dz.tiles.forEach(t=>{maxX=Math.max(maxX,t.x+t.w);maxY=Math.max(maxY,t.y+t.h);});
  const sx=12.9/Math.max(maxX,1100), sy=7.0/Math.max(maxY,650), sc=Math.min(sx,sy);
  for(const t of dz.tiles){
    const X=0.2+t.x*sc, Y=0.3+t.y*sc, W=t.w*sc, H=t.h*sc;
    if(t.chart){ try{ const url=t.chart.getDataURL({pixelRatio:2,backgroundColor:'#ffffff'}); s.addImage({data:url,x:X,y:Y,w:W,h:H}); }catch(e){} }
    else { const el=document.getElementById('dz-body-'+t.id);
      s.addShape(pptx.ShapeType.rect,{x:X,y:Y,w:W,h:H,fill:{color:'FFFFFF'},line:{color:'E6E8EB',width:0.5}});
      s.addText((el?el.innerText:'').slice(0,400)||t.fmt.title,{x:X+0.05,y:Y+0.05,w:W-0.1,h:H-0.1,fontFace:'微软雅黑',fontSize:8,valign:'top'}); }
  }
  const b64=await pptx.write('base64'); const res=await api.saveFile('看板_'+todayStr()+'.pptx',b64,'pptx'); if(res&&res.path)toast('已导出看板PPT','ok');
}
async function dzExportPng(){
  const cv=$('#dzCanvas'); let maxX=1,maxY=1; dz.tiles.forEach(t=>{maxX=Math.max(maxX,t.x+t.w);maxY=Math.max(maxY,t.y+t.h);});
  const W=maxX+24,H=maxY+24; const cvs=document.createElement('canvas'); cvs.width=W; cvs.height=H; const ctx=cvs.getContext('2d');
  ctx.fillStyle='#EDEFF2'; ctx.fillRect(0,0,W,H);
  for(const t of dz.tiles){ ctx.fillStyle='#fff'; ctx.fillRect(t.x,t.y,t.w,t.h); ctx.strokeStyle='#E6E8EB'; ctx.strokeRect(t.x,t.y,t.w,t.h);
    if(t.chart){ try{ const img=new Image(); const url=t.chart.getDataURL({pixelRatio:2,backgroundColor:'#ffffff'}); await new Promise(r=>{img.onload=r;img.src=url;}); ctx.drawImage(img,t.x,t.y+24,t.w,t.h-24); }catch(e){} }
    ctx.fillStyle='#5A5F66'; ctx.font='12px "Microsoft YaHei"'; ctx.fillText(t.fmt.title||'',t.x+8,t.y+17); }
  const b64=cvs.toDataURL('image/png').split(',')[1]; const res=await api.saveFile('看板_'+todayStr()+'.png',b64,'png'); if(res&&res.path)toast('已导出看板图片','ok');
}

/* ---- 事件绑定（从 app.js init() 搬来，纯搬运无逻辑改动）---- */
function dzInjectStyles(){
  if(document.getElementById('dz-fmt-css')) return;
  const st=document.createElement('style'); st.id='dz-fmt-css';
  st.textContent=`
#dzInspector .dz-ins-tabs{display:flex;gap:4px;margin:6px 0 10px}
#dzInspector .dz-itab{flex:1;padding:6px 0;font-size:12px;border:1px solid var(--line,var(--c-line));background:var(--c-bg-elev);border-radius:6px;cursor:pointer;color:var(--ink3,var(--c-ink-2))}
#dzInspector .dz-itab.active{background:var(--c-brand);color:var(--c-bg-elev);border-color:var(--c-brand)}
#dzInspector .dz-fgrp{border:1px solid var(--line,var(--c-line));border-radius:8px;margin-bottom:8px;overflow:hidden}
#dzInspector .dz-fgrp-h{background:#F6F7F9;padding:6px 10px;font-size:12px;font-weight:600;color:#3A3F46}
#dzInspector .dz-fgrp>*:not(.dz-fgrp-h){margin:8px 10px}
#dzInspector .dz-frow{display:flex;align-items:center;gap:6px;flex-wrap:wrap;font-size:11px;color:var(--ink3,var(--c-ink-2))}
#dzInspector .dz-frow>label{white-space:nowrap}
#dzInspector .dz-frow select,#dzInspector .dz-frow input{font-size:11px;border:1px solid var(--line,var(--c-line));border-radius:5px;padding:3px 5px;background:var(--c-bg-elev)}
#dzInspector .dz-frow input[type=number]{width:54px}
#dzInspector .dz-fgrp .dz-well{margin:8px 10px}
#dzInspector .dz-fgrp .dz-well input[type=text]{width:100%;box-sizing:border-box;font-size:12px;border:1px solid var(--line,var(--c-line));border-radius:6px;padding:5px}
#dzInspector .dz-chk{display:flex;align-items:center;gap:6px;font-size:12px;color:#3A3F46;cursor:pointer}
#dzInspector .dz-swatches{display:flex;flex-direction:column;gap:5px}
#dzInspector .dz-sw{display:flex;align-items:center;gap:8px;font-size:11px;color:#3A3F46}
#dzInspector .dz-sw input[type=color]{width:26px;height:18px;border:1px solid var(--line,var(--c-line));border-radius:4px;padding:0;background:none;cursor:pointer;flex:0 0 auto}
#dzInspector .dz-sw span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#dzInspector .dz-mini{font-size:11px;color:var(--c-brand);background:none;border:none;cursor:pointer;padding:2px 0;text-decoration:underline}
#dzInspector .dz-hint{font-size:11px;color:var(--ink3,var(--c-ink-3))}`;
  document.head.appendChild(st);
}
function initDesignerView(){
  dzInjectStyles();
  // designer controls
  $('#dzAdd').onclick=()=>dzAddTile($('#dzAddType').value||'column');
  $('#dzClear').onclick=()=>{ if(!dz.tiles.length)return; dz.tiles.forEach(t=>t.chart&&t.chart.dispose()); dz.tiles=[]; dz.sel=null; dz.filters={psi:{},idc:{}}; $('#dzCanvas').querySelectorAll('.dz-tile').forEach(el=>el.remove()); dzApplyCrossFilter(); dzRenderInspector(); dzRenderCanvas(); };
  $('#dzSave').onclick=dzSaveLayout;
  $('#dzLoad').onclick=dzLoadLayout;
  $('#dzExportPpt').onclick=dzExportPpt;
  $('#dzExportPng').onclick=dzExportPng;
}

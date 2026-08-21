'use strict';
// ECharts 主题桥取值器（canvas 不认 CSS 变量，必须给真实色值）
function CT(){ return (typeof window!=='undefined'&&window.SbChartTheme)?window.SbChartTheme:{ink1:()=>'#1A1A1A',ink2:()=>'#5A5F66',ink3:()=>'#8A9099',line:()=>'#E6E8EB',lineSoft:()=>'#F0F1F3',bgElev:()=>'#FFFFFF',register:c=>c}; }
/* ============================================================
   Salesboard — views/custom-view.js
   自定义图表视图（中档升级 2026-07-06）：快速单图分析。
   两条管线并存：
     · 散点/气泡：走原 engine.custom()（custom 独有能力，chart-render 无此二型），保留拖 4 槽交互。
     · 其余 20 图型：复用 PPT output 纯函数基建
         PptBindings.resolveElement + PptBind(binding-resolver) 取 3 源（PSI/IDC/财经）
         → PptChartRender.chartOption 出 echarts option（22 图型库）。
       支持级联筛选、时间切片、同比/环比、单位/小数位/图例位/字号。
   —— chart-render.js / binding-resolver.js / bindings.js / numfmt.js 一律只引用，不改，避免反向污染 PPT output。
   依赖 common.js（$,$$,toast,fmt,shortLabel,YH,todayStr,makeMultiSelect,sbColorRow,sbSeriesColor,SB_COLORS,
   boardStateSave/Load 等，均在本文件之前加载）；运行期还依赖 designer-view（DZ_MEASURES/IDC_LABEL/IDC_MEASURES）
   与 binding-resolver（window.PptBind）、bindings（window.PptBindings）、chart-render（window.PptChartRender）、
   numfmt（window.PptNumFmt），这些脚本虽在本文件之后加载，但均在用户打开视图时（脚本已全部就绪）才被调用。
   ============================================================ */

/* ============================================================
   自定义图表状态
   —— 保留原 slots/colorOverride/chart/last（散点气泡 + selftest 依赖）；
      新增 binding（20 图型取数绑定）+ fmt（格式化）。
   ============================================================ */
const cu={
  type:'bubble',
  slots:{xDim:'country',yDim:'repOffice',sizeMetric:'sellOut',colorDim:''},
  colorOverride:{}, chart:null, last:null,
  // 20 图型绑定（走 binding-resolver）：dataset=psi/idc/finance
  binding:{ dataset:'psi', measure:'', agg:'', catField:'', catGran:'month', legend:'', timeFrom:null, timeTo:null, filters:{},
            basis:'actual', year:null, fromM:undefined, toM:undefined, version:'', bpVersion:'',
            compare:'none' /* none|yoy|mom|qoq */, compareFmt:'' },
  // 格式化（喂给 chartOption 的 fmtOpt）
  fmt:{ unit:'auto', decimals:1, legendPos:'bc', showLegend:true, showLabels:false, catFontSize:10, valFontSize:10, labelFontSize:9 },
};

/* ---- 图型清单：与 PPT output 22 图型一致，另加 custom 独有 scatter/bubble（走 engine.custom）。---- */
const CU_VISUALS=[
  {t:'column',n:'簇状柱'},{t:'stackColumn',n:'堆积柱'},{t:'stack100',n:'百分比堆积柱'},
  {t:'bar',n:'簇状条'},{t:'stackBar',n:'堆积条'},{t:'stack100Bar',n:'百分比堆积条'},
  {t:'line',n:'折线'},{t:'area',n:'面积'},{t:'combo',n:'折线+柱'},
  {t:'pie',n:'饼图'},{t:'donut',n:'环形'},
  {t:'treemap',n:'树状'},{t:'funnel',n:'漏斗'},{t:'gauge',n:'仪表盘'},{t:'waterfall',n:'瀑布'},
  {t:'bubble',n:'气泡'},{t:'scatter',n:'散点'},
];
const CU_VNAME={}; CU_VISUALS.forEach(v=>CU_VNAME[v.t]=v.n);
// 散点/气泡 = 原生管线（engine.custom + 拖 4 槽）；其余全部走 binding-resolver。
const CU_NATIVE=['bubble','scatter'];
function cuIsNative(t){ return CU_NATIVE.indexOf(t)>=0; }
// 财经维度中文名（binding-resolver 侧无此表，本地维护，与 pptoutput PD_FIN_DIM_LABEL 同值）。
const CU_FIN_DIM_LABEL={ rep:'国家办', lv1:'产业', lv2:'品类', lv3:'产品系列', lv4:'产品' };

/* ---- 状态持久化（sb.custom.v1）：记住图型 + 拖好的字段槽 + 系列色 override（原有）
   + 新增 binding/fmt。兼容旧档：只有 type/slots/colorOverride 的旧存档照常回载，binding/fmt 缺失用默认。 ---- */
const CU_STATE_KEY='sb.custom.v1';
const CU_TYPES=CU_VISUALS.map(v=>v.t);
function cuStateSave(){ boardStateSave(CU_STATE_KEY, ()=>({
  type: cu.type, slots: cu.slots, colorOverride: cu.colorOverride, binding: cu.binding, fmt: cu.fmt
}), 500); }
function cuStateLoad(){
  const o=boardStateLoad(CU_STATE_KEY); if(!o) return;
  if(CU_TYPES.includes(o.type)) cu.type=o.type;
  if(o.slots && typeof o.slots==='object'){
    const s=o.slots;
    ['xDim','yDim','sizeMetric','colorDim'].forEach(k=>{ if(typeof s[k]==='string') cu.slots[k]=s[k]; });
  }
  if(o.colorOverride && typeof o.colorOverride==='object'){
    const ov={}; Object.keys(o.colorOverride).forEach(k=>{ const v=o.colorOverride[k];
      if(typeof v==='string' && /^#[0-9a-fA-F]{6}$/.test(v)) ov[k]=v; });   // 脏值防御：只收合法 hex
    cu.colorOverride=ov;
  }
  if(o.binding && typeof o.binding==='object'){
    const b=o.binding;
    ['dataset','measure','agg','catField','catGran','legend','basis','version','bpVersion','compare','compareFmt'].forEach(k=>{ if(typeof b[k]==='string') cu.binding[k]=b[k]; });
    if(b.timeFrom==null||typeof b.timeFrom==='string') cu.binding.timeFrom=b.timeFrom;
    if(b.timeTo==null||typeof b.timeTo==='string') cu.binding.timeTo=b.timeTo;
    if(b.year==null||typeof b.year==='number') cu.binding.year=b.year;
    if(b.fromM==null||typeof b.fromM==='number') cu.binding.fromM=b.fromM;
    if(b.toM==null||typeof b.toM==='number') cu.binding.toM=b.toM;
    if(b.filters && typeof b.filters==='object'){
      const f={}; Object.keys(b.filters).forEach(k=>{ if(Array.isArray(b.filters[k])) f[k]=b.filters[k].slice(); }); cu.binding.filters=f;
    }
  }
  if(o.fmt && typeof o.fmt==='object'){
    const f=o.fmt;
    if(typeof f.unit==='string') cu.fmt.unit=f.unit;
    if(typeof f.decimals==='number') cu.fmt.decimals=Math.max(0,Math.min(3,f.decimals));
    if(typeof f.legendPos==='string') cu.fmt.legendPos=f.legendPos;
    if(typeof f.showLegend==='boolean') cu.fmt.showLegend=f.showLegend;
    if(typeof f.showLabels==='boolean') cu.fmt.showLabels=f.showLabels;
    ['catFontSize','valFontSize','labelFontSize'].forEach(k=>{ if(typeof f[k]==='number') cu.fmt[k]=f[k]; });
  }
}

/* ============================================================
   共享小工具（数据源维度/度量/标签/时间字段）
   —— 与 pptoutput/designer 同口径，但本文件独立实现，不依赖 pptoutput-view 的 pd* 函数。
   ============================================================ */
function cuHasFin(){ return !!(typeof state!=='undefined' && state.finMeta); }
function cuHasIdc(){ return !!(typeof state!=='undefined' && state.idcMeta); }
function cuDsDims(ds){
  if(ds==='finance') return ['rep','lv1','lv2','lv3','lv4'];
  if(ds==='idc') return (typeof state!=='undefined' && state.idcMeta && state.idcMeta.dims) || [];
  return ['period'].concat((typeof state!=='undefined' && state.dims) || []);
}
function cuDsMeasures(ds){
  if(ds==='finance') return ['rev','gm','gmr','cp','nsip','sellIn','sellOut','bpAttain','fcAttain'];
  if(ds==='idc') return (typeof IDC_MEASURES!=='undefined') ? IDC_MEASURES : ['units','value','asp'];
  return (typeof DZ_MEASURES!=='undefined') ? DZ_MEASURES : ['sellOut','sellIn','inv','dos'];
}
function cuFieldLabel(field, ds){
  if(ds==='finance'){
    const FL=(typeof PptBind!=='undefined'&&PptBind.FIN_MEASURE_LABEL)||(typeof window!=='undefined'&&window.PptBind&&window.PptBind.FIN_MEASURE_LABEL)||{};
    return FL[field] || CU_FIN_DIM_LABEL[field] || field;
  }
  if(ds==='idc') return (typeof IDC_LABEL!=='undefined' && IDC_LABEL[field]) || field;
  if(field==='period') return '周期';
  return (typeof DIM_LABEL!=='undefined' && DIM_LABEL[field]) || (typeof METRIC_LABEL!=='undefined' && METRIC_LABEL[field]) || field;
}
function cuDefAgg(field, ds){
  if(ds==='finance') return '';
  if(ds==='idc') return field==='asp' ? 'asp' : 'sum';
  return (field==='sellOut'||field==='sellIn') ? 'sum' : 'last';
}
function cuIsTimeField(field, ds){ return ds==='idc' ? (field==='quarter'||field==='year') : (ds==='finance' ? false : (field==='period')); }
function cuEsc(s){ return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

/* ---- 补齐绑定默认（切数据源/首次进入时保证有选中态）。 ---- */
function cuEnsureBindingDefaults(){
  const b=cu.binding, ds=b.dataset||'psi';
  const meas=cuDsMeasures(ds), dims=cuDsDims(ds);
  if(!b.measure || meas.indexOf(b.measure)<0) b.measure=meas[0]||'';
  if(ds==='finance'){
    const fm=(typeof state!=='undefined' && state.finMeta)||{};
    const ay=(fm.actualYears&&fm.actualYears.length)?fm.actualYears:(fm.years||[]);
    if(!b.basis) b.basis='actual';
    if(b.year==null && ay.length) b.year=ay[ay.length-1];
    if(!b.catField || ['rep','lv1','lv2','lv3','lv4'].indexOf(b.catField)<0) b.catField='lv1';
    b.legend='';  // 财经无图例系列
  } else {
    if(!b.catField || dims.indexOf(b.catField)<0) b.catField=dims[0]||'';
    if(!b.agg) b.agg=cuDefAgg(b.measure, ds);
  }
}

/* ============================================================
   binding 管线：cu.binding → resolveElement 的 el.binding
   —— 核心映射（本文件唯一「配置→binding-resolver 参数」纯逻辑，供测试）。
   ============================================================ */
// 把 cu.binding 组装成 resolveElement 能吃的 el 对象（type:'chart'）。散点/气泡不走这里。
function cuBuildElBinding(b){
  b=b||cu.binding;
  const ds=b.dataset||'psi';
  const compare=b.compare&&b.compare!=='none';
  if(ds==='finance'){
    return { type:'chart', binding:{
      dataset:'finance', measure:b.measure||'rev', basis:b.basis||'actual',
      year:b.year, fromM:b.fromM, toM:b.toM, version:b.version||undefined, bpVersion:b.bpVersion||undefined,
      catField:b.catField||'lv1', filters:b.filters||{}
    }};
  }
  const el={ type:'chart', binding:{
    dataset:ds, measure:b.measure||(ds==='idc'?'units':'sellOut'), agg:b.agg||cuDefAgg(b.measure,ds),
    catField:b.catField, catGran:b.catGran||'month', legend:b.legend||undefined,
    filters:b.filters||{}
  }};
  // 时间切片仅对时间类别字段生效（binding-resolver 内部也做同判断）。
  if(cuIsTimeField(b.catField, ds)){
    if(b.timeFrom!=null&&b.timeFrom!=='') el.binding.timeFrom=b.timeFrom;
    if(b.timeTo!=null&&b.timeTo!=='') el.binding.timeTo=b.timeTo;
  }
  return el;
}

// resolveElement 返回矩阵({cats,series:[{name,values}]}) → chartOption 需要的 res({cats,series:[名],data:{名:{类:值}},total})。
function cuMatrixToRes(m){
  const cats=(m&&m.cats)||[];
  const series=((m&&m.series)||[]).map(s=>s.name);
  const data={}; let total=0;
  ((m&&m.series)||[]).forEach(s=>{ const row={}; cats.forEach((c,i)=>{ const v=+(s.values&&s.values[i])||0; row[c]=v; total+=v; }); data[s.name]=row; });
  if(!series.length){ series.push('(值)'); data['(值)']={}; cats.forEach(c=>data['(值)'][c]=0); }
  return { cats, series, data, total };
}

// fmt → chartOption 的 fmtOpt（把系列色 override 折进 fmt.colors）。
function cuFmtOpt(seriesNames){
  const colors={}; const pal=SB_COLORS.seriesDiscrete;
  (seriesNames||[]).forEach((n,i)=>{ colors[n]=sbSeriesColor(n,i,cu.colorOverride,pal); });
  return {
    unit:cu.fmt.unit, decimals:cu.fmt.decimals,
    legendPos:cu.fmt.legendPos, showLegend:cu.fmt.showLegend, showLabels:cu.fmt.showLabels,
    catFontSize:cu.fmt.catFontSize, valFontSize:cu.fmt.valFontSize, labelFontSize:cu.fmt.labelFontSize,
    colors:colors,
  };
}

/* ============================================================
   左侧配置面板（图型/数据源/度量/聚合/类别/图例/时间/同比/格式/筛选）
   —— 散点/气泡时改为显示原拖 4 槽面板（保留原交互）。
   ============================================================ */
function cuRow(label, inner){ return '<div class="cu-fld"><label>'+cuEsc(label)+'</label>'+inner+'</div>'; }

function buildCuPanel(){
  const host=$('#cuPanel'); if(!host) return;
  const b=cu.binding; cuEnsureBindingDefaults();
  const ds=b.dataset||'psi';
  const dims=cuDsDims(ds), meas=cuDsMeasures(ds);
  const native=cuIsNative(cu.type);
  // 拖字段区仅散点/气泡需要。
  const dragBox=$('#cuDragFields'); if(dragBox) dragBox.style.display=native?'':'none';
  let h='';

  // 图型（下拉，22+2 型）
  h+=cuRow('图表类型','<select id="cuTypeSel">'+
    CU_VISUALS.map(v=>'<option value="'+v.t+'"'+(cu.type===v.t?' selected':'')+'>'+v.n+'</option>').join('')+'</select>');

  if(native){
    // 散点/气泡：拖 4 槽（复用原有 .cu-slot 交互）。
    h+='<div class="cu-hint">拖左侧字段到下面的框</div>';
    h+='<div class="cu-slot" data-slot="xDim"><span class="sl">X 轴（维度）</span></div>';
    h+='<div class="cu-slot" data-slot="yDim"><span class="sl">Y 轴（维度）</span></div>';
    h+='<div class="cu-slot" data-slot="sizeMetric"><span class="sl">大小（指标）</span></div>';
    h+='<div class="cu-slot" data-slot="colorDim"><span class="sl">颜色（维度·可选）</span></div>';
    host.innerHTML=h;
    wireCuTypeSel();
    wireCuSlots();
    renderCuSlots();
    return;
  }

  // ---- 20 图型：数据源 ----
  h+=cuRow('数据源','<select id="cuDs">'+
    [['psi','经营 PSI'],['idc','IDC 市场'],['finance','经营(财经)']].map(o=>{
      const dis=(o[0]==='idc'&&!cuHasIdc())||(o[0]==='finance'&&!cuHasFin())?' disabled':'';
      return '<option value="'+o[0]+'"'+(ds===o[0]?' selected':'')+dis+'>'+o[1]+'</option>';
    }).join('')+'</select>');

  if(ds==='finance'){
    h+=buildCuFinFields(b);
  } else {
    // 度量 chips（单选）
    h+='<div class="cu-sec">度量（值）</div><div class="cu-chips" id="cuMeasChips">'+
      meas.map(m=>'<button type="button" class="cu-pchip mea'+(b.measure===m?' on':'')+'" data-field="'+m+'">'+cuEsc(cuFieldLabel(m,ds))+'</button>').join('')+'</div>';
    // 聚合
    const aggCur=b.agg||cuDefAgg(b.measure,ds);
    h+=cuRow('聚合','<select id="cuAgg">'+
      [['sum','求和'],['avg','均值'],['last','最新'],['count','计数'],['max','最大'],['min','最小'],['asp','均价']].map(o=>'<option value="'+o[0]+'"'+(aggCur===o[0]?' selected':'')+'>'+o[1]+'</option>').join('')+'</select>');
    // 类别（分类轴）
    h+='<div class="cu-sec">类别（分类轴）</div><div class="cu-chips" id="cuCatChips">'+
      dims.map(d=>'<button type="button" class="cu-pchip dim'+(b.catField===d?' on':'')+'" data-field="'+d+'">'+cuEsc(cuFieldLabel(d,ds))+'</button>').join('')+'</div>';
    if(cuIsTimeField(b.catField, ds)){
      const gran=b.catGran||'month';
      h+=cuRow('时间粒度','<select id="cuGran">'+
        [['day','日'],['week','周'],['month','月']].map(o=>'<option value="'+o[0]+'"'+(gran===o[0]?' selected':'')+'>'+o[1]+'</option>').join('')+'</select>');
      const cats=cu._lastCats||[];
      h+=cuRow('时间 从','<select id="cuTimeFrom">'+cuCatOpts(cats,b.timeFrom)+'</select>');
      h+=cuRow('时间 到','<select id="cuTimeTo">'+cuCatOpts(cats,b.timeTo)+'</select>');
    }
    // 图例（系列）
    h+='<div class="cu-sec">图例（系列）<span class="cu-clr" id="cuLegClr">清空</span></div><div class="cu-chips" id="cuLegChips">'+
      dims.map(d=>'<button type="button" class="cu-pchip dim'+(b.legend===d?' on':'')+'" data-field="'+d+'">'+cuEsc(cuFieldLabel(d,ds))+'</button>').join('')+'</div>';
  }

  // 同比/环比（3 源通用；财经走 finance total 预设期，PSI/IDC 走矩阵区间预设期）
  h+=cuRow('同比对比','<select id="cuCompare">'+
    [['none','无'],['yoy','同比(YoY)'],['mom','环比(MoM)'],['qoq','季环比(QoQ)']].map(o=>'<option value="'+o[0]+'"'+((b.compare||'none')===o[0]?' selected':'')+'>'+o[1]+'</option>').join('')+'</select>');

  // ---- 格式化 ----
  h+='<div class="cu-sec">格式</div>';
  h+=cuRow('单位','<select id="cuUnit">'+
    [['auto','自动'],['none','原值'],['k','千'],['w','万'],['m','百万'],['K','K'],['W','W'],['Million','M']].map(o=>'<option value="'+o[0]+'"'+(cu.fmt.unit===o[0]?' selected':'')+'>'+o[1]+'</option>').join('')+'</select>');
  h+=cuRow('小数位','<select id="cuDec">'+
    [0,1,2,3].map(d=>'<option value="'+d+'"'+(cu.fmt.decimals===d?' selected':'')+'>'+d+'</option>').join('')+'</select>');
  h+=cuRow('图例位','<select id="cuLegPos">'+
    [['tl','左上'],['tc','上中'],['tr','右上'],['lc','左中'],['rc','右中'],['bl','左下'],['bc','下中'],['br','右下'],['none','隐藏']].map(o=>'<option value="'+o[0]+'"'+(cu.fmt.legendPos===o[0]?' selected':'')+'>'+o[1]+'</option>').join('')+'</select>');
  h+='<div class="cu-fld"><label><input type="checkbox" id="cuShowLegend"'+(cu.fmt.showLegend?' checked':'')+'> 显示图例</label>'
     +'<label style="margin-left:10px"><input type="checkbox" id="cuShowLabels"'+(cu.fmt.showLabels?' checked':'')+'> 数据标签</label></div>';
  h+=cuRow('类目字号','<input type="number" id="cuCatFs" min="6" max="20" value="'+cu.fmt.catFontSize+'" style="width:56px">');
  h+=cuRow('数值字号','<input type="number" id="cuValFs" min="6" max="20" value="'+cu.fmt.valFontSize+'" style="width:56px">');
  h+=cuRow('标签字号','<input type="number" id="cuLabFs" min="6" max="20" value="'+cu.fmt.labelFontSize+'" style="width:56px">');

  // ---- 级联筛选 ----
  h+='<div class="cu-sec">筛选'+(ds==='finance'?'':'（级联）')+'</div><div id="cuFilters"></div>';

  host.innerHTML=h;
  wireCuTypeSel();
  wireCuPanel();
}

// 财经专属字段（口径/年/月区间/版本/度量/类别）。
function buildCuFinFields(b){
  const fm=(typeof state!=='undefined' && state.finMeta)||{};
  const ay=(fm.actualYears&&fm.actualYears.length)?fm.actualYears:(fm.years||[]);
  const vers=fm.versions||[], bpv=fm.bpVersions||[];
  const basis=b.basis||'actual', meas=cuDsMeasures('finance'), dims=cuDsDims('finance');
  let h='';
  h+=cuRow('口径','<select id="cuFinBasis">'+
    [['actual','实际'],['forecast','预测'],['bp','BP']].map(o=>'<option value="'+o[0]+'"'+(basis===o[0]?' selected':'')+'>'+o[1]+'</option>').join('')+'</select>');
  h+=cuRow('年','<select id="cuFinYear">'+
    ay.map(y=>'<option value="'+y+'"'+(String(b.year)===String(y)?' selected':'')+'>'+y+'</option>').join('')+'</select>');
  const moOpt=(cur,withLatest)=>{ let s=withLatest?('<option value=""'+((cur==null)?' selected':'')+'>最新</option>'):'';
    for(let m=1;m<=12;m++) s+='<option value="'+m+'"'+(String(cur)===String(m)?' selected':'')+'>'+m+' 月</option>'; return s; };
  h+=cuRow('月 从','<select id="cuFinFromM"><option value=""'+((b.fromM==null)?' selected':'')+'>起</option>'+moOpt(b.fromM,false)+'</select>');
  h+=cuRow('月 到','<select id="cuFinToM">'+moOpt(b.toM,true)+'</select>');
  if(vers.length) h+=cuRow('底稿版本','<select id="cuFinVer">'+
    vers.map(v=>'<option value="'+cuEsc(v)+'"'+(b.version===v?' selected':'')+'>'+cuEsc(v)+'</option>').join('')+'</select>');
  if(basis==='bp'&&bpv.length) h+=cuRow('BP 版本','<select id="cuFinBpVer">'+
    bpv.map(v=>'<option value="'+cuEsc(v)+'"'+(b.bpVersion===v?' selected':'')+'>'+cuEsc(v)+'</option>').join('')+'</select>');
  h+='<div class="cu-sec">度量（指标）</div><div class="cu-chips" id="cuMeasChips">'+
    meas.map(m=>'<button type="button" class="cu-pchip mea'+(b.measure===m?' on':'')+'" data-field="'+m+'">'+cuEsc(cuFieldLabel(m,'finance'))+'</button>').join('')+'</div>';
  h+='<div class="cu-sec">类别（维度）</div><div class="cu-chips" id="cuCatChips">'+
    dims.map(d=>'<button type="button" class="cu-pchip dim'+(b.catField===d?' on':'')+'" data-field="'+d+'">'+cuEsc(cuFieldLabel(d,'finance'))+'</button>').join('')+'</div>';
  return h;
}

function cuCatOpts(cats, cur){
  let h='<option value=""'+((cur==null||cur==='')?' selected':'')+'>(全部)</option>';
  (cats||[]).forEach(c=>{ h+='<option value="'+cuEsc(c)+'"'+(cur===c?' selected':'')+'>'+cuEsc(c)+'</option>'; });
  return h;
}

/* ---- 图型下拉 wire（散点气泡 ↔ 20 图型切换需重建面板）。 ---- */
function wireCuTypeSel(){
  const sel=$('#cuTypeSel'); if(!sel) return;
  sel.onchange=()=>{ cu.type=sel.value; buildCuPanel(); drawCustom(); cuStateSave(); };
}

/* ---- 20 图型面板 wire。 ---- */
function wireCuPanel(){
  const host=$('#cuPanel'); if(!host) return;
  const b=cu.binding, ds=b.dataset||'psi';
  const byId=id=>host.querySelector('#'+id);

  const dsSel=byId('cuDs');
  if(dsSel) dsSel.onchange=()=>{
    const nds=dsSel.value;
    cu.binding.dataset=nds; cu.binding.filters={};
    cu.binding.measure=''; cu.binding.catField=''; cu.binding.legend=''; cu.binding.agg='';
    cu.binding.timeFrom=null; cu.binding.timeTo=null; cu._lastCats=null;
    cuEnsureBindingDefaults();
    buildCuPanel(); drawCustom(); cuStateSave();
  };

  if(ds==='finance'){ wireCuFinFields(); }
  else {
    const agg=byId('cuAgg'); if(agg) agg.onchange=()=>{ b.agg=agg.value; drawCustom(); cuStateSave(); };
    const gran=byId('cuGran'); if(gran) gran.onchange=()=>{ b.catGran=gran.value; cu._lastCats=null; drawCustom(); cuStateSave(); };
    const tFrom=byId('cuTimeFrom'), tTo=byId('cuTimeTo');
    if(tFrom) tFrom.onchange=()=>{ b.timeFrom=tFrom.value||null; drawCustom(); cuStateSave(); };
    if(tTo) tTo.onchange=()=>{ b.timeTo=tTo.value||null; drawCustom(); cuStateSave(); };
    const measBox=byId('cuMeasChips');
    if(measBox) measBox.querySelectorAll('.cu-pchip').forEach(c=>c.onclick=()=>{
      b.measure=c.dataset.field; b.agg=cuDefAgg(b.measure, ds); buildCuPanel(); drawCustom(); cuStateSave();
    });
    const catBox=byId('cuCatChips');
    if(catBox) catBox.querySelectorAll('.cu-pchip').forEach(c=>c.onclick=()=>{
      b.catField=c.dataset.field; cu._lastCats=null; buildCuPanel(); drawCustom(); cuStateSave();
    });
    const legBox=byId('cuLegChips');
    if(legBox) legBox.querySelectorAll('.cu-pchip').forEach(c=>c.onclick=()=>{
      b.legend=(b.legend===c.dataset.field?'':c.dataset.field); buildCuPanel(); drawCustom(); cuStateSave();
    });
    const legClr=byId('cuLegClr'); if(legClr) legClr.onclick=()=>{ b.legend=''; buildCuPanel(); drawCustom(); cuStateSave(); };
  }

  const cmp=byId('cuCompare'); if(cmp) cmp.onchange=()=>{ b.compare=cmp.value; drawCustom(); cuStateSave(); };

  // 格式化控件
  const unit=byId('cuUnit'); if(unit) unit.onchange=()=>{ cu.fmt.unit=unit.value; drawCustom(); cuStateSave(); };
  const dec=byId('cuDec'); if(dec) dec.onchange=()=>{ cu.fmt.decimals=parseInt(dec.value,10)||0; drawCustom(); cuStateSave(); };
  const legPos=byId('cuLegPos'); if(legPos) legPos.onchange=()=>{ cu.fmt.legendPos=legPos.value; drawCustom(); cuStateSave(); };
  const sl=byId('cuShowLegend'); if(sl) sl.onchange=()=>{ cu.fmt.showLegend=sl.checked; drawCustom(); cuStateSave(); };
  const slab=byId('cuShowLabels'); if(slab) slab.onchange=()=>{ cu.fmt.showLabels=slab.checked; drawCustom(); cuStateSave(); };
  const cfs=byId('cuCatFs'); if(cfs) cfs.onchange=()=>{ cu.fmt.catFontSize=cuClampFs(cfs.value); drawCustom(); cuStateSave(); };
  const vfs=byId('cuValFs'); if(vfs) vfs.onchange=()=>{ cu.fmt.valFontSize=cuClampFs(vfs.value); drawCustom(); cuStateSave(); };
  const lfs=byId('cuLabFs'); if(lfs) lfs.onchange=()=>{ cu.fmt.labelFontSize=cuClampFs(lfs.value); drawCustom(); cuStateSave(); };

  renderCuFilters();
}
function cuClampFs(v){ const n=parseInt(v,10)||10; return Math.max(6,Math.min(20,n)); }

function wireCuFinFields(){
  const host=$('#cuPanel'); if(!host) return;
  const b=cu.binding, byId=id=>host.querySelector('#'+id);
  const basis=byId('cuFinBasis'); if(basis) basis.onchange=()=>{ b.basis=basis.value; buildCuPanel(); drawCustom(); cuStateSave(); };
  const year=byId('cuFinYear'); if(year) year.onchange=()=>{ b.year=parseInt(year.value,10); drawCustom(); cuStateSave(); };
  const fromM=byId('cuFinFromM'); if(fromM) fromM.onchange=()=>{ b.fromM=fromM.value?parseInt(fromM.value,10):undefined; drawCustom(); cuStateSave(); };
  const toM=byId('cuFinToM'); if(toM) toM.onchange=()=>{ b.toM=toM.value?parseInt(toM.value,10):undefined; drawCustom(); cuStateSave(); };
  const ver=byId('cuFinVer'); if(ver) ver.onchange=()=>{ b.version=ver.value; drawCustom(); cuStateSave(); };
  const bpv=byId('cuFinBpVer'); if(bpv) bpv.onchange=()=>{ b.bpVersion=bpv.value; drawCustom(); cuStateSave(); };
  const measBox=byId('cuMeasChips');
  if(measBox) measBox.querySelectorAll('.cu-pchip').forEach(c=>c.onclick=()=>{ b.measure=c.dataset.field; buildCuPanel(); drawCustom(); cuStateSave(); });
  const catBox=byId('cuCatChips');
  if(catBox) catBox.querySelectorAll('.cu-pchip').forEach(c=>c.onclick=()=>{ b.catField=c.dataset.field; buildCuPanel(); drawCustom(); cuStateSave(); });
}

/* ---- 级联筛选：每维一个 makeMultiSelect（PSI/IDC 走 api.options/idcOptions 级联；财经走 financeCustom 取值，非级联）。 ---- */
function cuOtherFilters(exceptField){
  const f=cu.binding.filters||{}, out={};
  Object.keys(f).forEach(k=>{ if(k!==exceptField && f[k] && f[k].length) out[k]=f[k]; });
  return out;
}
let _cuFinOpts={};
function cuFinFetchOpts(field, cb){
  if(_cuFinOpts[field]){ cb(_cuFinOpts[field]); return; }
  Promise.resolve(api.financeCustom({ rowDim:field, metrics:['rev'], basis:'actual' }))
    .then(r=>{ const keys=((r&&r.rows)||[]).map(x=>x.key).filter(k=>k!=null&&k!==''); _cuFinOpts[field]=keys; cb(keys); })
    .catch(()=>cb([]));
}
function renderCuFilters(){
  const box=$('#cuFilters'); if(!box) return;
  box.innerHTML='';
  const b=cu.binding, ds=b.dataset||'psi';
  const dims=cuDsDims(ds).filter(d=>!cuIsTimeField(d, ds));
  dims.forEach(field=>{
    const slot=document.createElement('div'); slot.className='cu-fslot'; box.appendChild(slot);
    const cur=(b.filters&&b.filters[field])||[];
    const commit=(sel)=>{ setCuFilter(field, sel); drawCustom(); if(ds!=='finance') renderCuFilters(); cuStateSave(); };
    if(ds==='finance'){
      cuFinFetchOpts(field,(opts)=>{ if(!slot.isConnected) return;
        const ms=makeMultiSelect(cuFieldLabel(field,'finance'), opts||[], cur, { onCommit: commit });
        slot.innerHTML=''; slot.appendChild(ms);
      });
    } else {
      const others=cuOtherFilters(field);
      const optsP= ds==='idc' ? api.idcOptions(field, others) : api.options(field, others);
      Promise.resolve(optsP).then(opts=>{ if(!slot.isConnected) return;
        const ms=makeMultiSelect(cuFieldLabel(field, ds), opts||[], cur, { onCommit: commit });
        slot.innerHTML=''; slot.appendChild(ms);
      }).catch(()=>{});
    }
  });
}
function setCuFilter(field, sel){
  const f=Object.assign({}, cu.binding.filters);
  if(sel&&sel.length) f[field]=sel.slice(); else delete f[field];
  cu.binding.filters=f;
}

/* ============================================================
   左侧字段面板（散点/气泡拖 4 槽用；20 图型不需要，隐藏）
   ============================================================ */
function buildCuPalette(){
  const dimsEl=$('#cuDims'), measEl=$('#cuMeas');
  const dims=(state.dims||[]);
  if(dimsEl){ dimsEl.innerHTML=''; dims.forEach(k=>dimsEl.appendChild(cuChip(DIM_LABEL[k]||k,k,'dim'))); }
  if(measEl){ measEl.innerHTML=''; ['sellOut','sellIn','inv','dos'].forEach(k=>measEl.appendChild(cuChip(METRIC_LABEL[k],k,'mea'))); }
  // 散点/气泡默认槽仅在有 PSI 维度时校正。
  if(dims.length){
    if(!dims.includes(cu.slots.xDim)) cu.slots.xDim=dims.includes('country')?'country':dims[0];
    if(!dims.includes(cu.slots.yDim)) cu.slots.yDim=dims.includes('repOffice')?'repOffice':(dims[1]||dims[0]);
    if(cu.slots.colorDim && !dims.includes(cu.slots.colorDim)) cu.slots.colorDim='';
  }
  // 无 PSI 时把默认数据源切到可用源，避免空面板。
  if(!dims.length){
    if(cu.binding.dataset==='psi'){ cu.binding.dataset = state.idcMeta ? 'idc' : (state.finMeta ? 'finance' : 'psi'); }
    if(cuIsNative(cu.type)) cu.type='column';   // 散点气泡需 PSI 维度，无则退回柱形
  }
  buildCuPanel();
}
function cuChip(label,field,kind){
  const c=document.createElement('div'); c.className='cu-chip '+kind; c.textContent=label; c.draggable=true;
  c.ondragstart=e=>e.dataTransfer.setData('text/plain',JSON.stringify({field,kind,label}));
  return c;
}
function labelOfField(f){ return DIM_LABEL[f]||METRIC_LABEL[f]||f; }
function renderCuSlots(){
  $$('#cuPanel .cu-slot').forEach(slot=>{
    const name=slot.dataset.slot, val=cu.slots[name];
    if(val){ slot.classList.add('filled'); slot.querySelector('.tag')&&slot.querySelector('.tag').remove();
      const tag=document.createElement('span'); tag.className='tag';
      tag.innerHTML=labelOfField(val)+' <span class="x">✕</span>'; tag.querySelector('.x').onclick=()=>{ cu.slots[name]=''; renderCuSlots(); drawCustom(); cuStateSave(); };
      slot.appendChild(tag);
    } else { slot.classList.remove('filled'); const tag=slot.querySelector('.tag'); if(tag)tag.remove(); }
  });
}
function wireCuSlots(){
  $$('#cuPanel .cu-slot').forEach(slot=>{
    slot.ondragover=e=>{e.preventDefault();slot.classList.add('over');};
    slot.ondragleave=()=>slot.classList.remove('over');
    slot.ondrop=e=>{ e.preventDefault(); slot.classList.remove('over');
      let d; try{ d=JSON.parse(e.dataTransfer.getData('text/plain')); }catch(_){ return; }
      const name=slot.dataset.slot; const wantMea=(name==='sizeMetric');
      if(wantMea && d.kind!=='mea'){ toast('这个框要放「指标」','err'); return; }
      if(!wantMea && d.kind!=='dim'){ toast('这个框要放「维度」','err'); return; }
      cu.slots[name]=d.field; renderCuSlots(); drawCustom(); cuStateSave();
    };
  });
}
/* ---- 系列色块行（第二批-2b）：图上方每系列一个 input[type=color]。 ---- */
function renderCuColors(names){
  sbColorRow($('#cuColors'), names, cu.colorOverride, SB_COLORS.seriesDiscrete, {
    onChange:(n,v)=>{ cu.colorOverride[n]=v; drawCustom(); cuStateSave(); },
    onReset:()=>{ cu.colorOverride={}; drawCustom(); cuStateSave(); },
  });
}

/* ============================================================
   绘制：散点/气泡 → engine.custom；其余 20 图型 → resolveElement + chartOption。
   ============================================================ */
async function drawCustom(){
  if(!cu.chart){ cu.chart=CT().register(echarts.init($('#cuChart'))); window.addEventListener('resize',()=>cu.chart&&cu.chart.resize()); }
  if(cuIsNative(cu.type)) return drawCustomNative();
  return drawCustomBinding();
}

// 20 图型：走 binding-resolver + chart-render。
async function drawCustomBinding(){
  const PB=(typeof PptBindings!=='undefined')?PptBindings:(window.PptBindings);
  const BR=(typeof PptBind!=='undefined')?PptBind:(window.PptBind);
  const CR=(typeof PptChartRender!=='undefined')?PptChartRender:(window.PptChartRender);
  if(!PB||!BR||!CR){ toast('图表基建未就绪','err'); return; }
  cuEnsureBindingDefaults();
  const ready=!!cu.binding.measure;
  $('#cuEmpty').classList.toggle('hidden', !!ready);
  if(!ready){ cu.chart.clear(); renderCuColors([]); return; }

  const myGen=(cu._gen=(cu._gen||0)+1);
  let matrix;
  const b=cu.binding;
  const compare=b.compare&&b.compare!=='none';
  try{
    if(compare){
      matrix=await cuResolveCompareMatrix(BR, b);
    } else {
      const el=cuBuildElBinding(b);
      const r=await PB.resolveElement(api, BR, el);
      matrix={ cats:r.cats||[], series:r.series||[] };
    }
  }catch(e){ if(myGen!==cu._gen) return; toast('取数失败：'+(e&&e.message||e),'err'); return; }
  if(myGen!==cu._gen) return;

  // 缓存时间桶（供时间切片下拉），仅非切片、时间类别字段时刷新
  if(!compare && cuIsTimeField(b.catField, b.dataset) && (b.timeFrom==null&&b.timeTo==null)){
    cu._lastCats=(matrix.cats||[]).slice();
    const tf=$('#cuTimeFrom'), tt=$('#cuTimeTo');
    if(tf) tf.innerHTML=cuCatOpts(cu._lastCats, b.timeFrom);
    if(tt) tt.innerHTML=cuCatOpts(cu._lastCats, b.timeTo);
  }

  const res=cuMatrixToRes(matrix);
  cu.last={ binding:true, cats:res.cats, series:res.series, data:res.data, total:res.total };
  renderCuColors(res.series);
  const fmtOpt=cuFmtOpt(res.series);
  if(cu.type==='gauge') fmtOpt.gaugeName=cuFieldLabel(b.measure, b.dataset);
  const palette=SB_COLORS.seriesDiscrete;
  let opt;
  try{ opt=CR.chartOption(cu.type, fmtOpt, res, palette); }
  catch(e){ toast('渲染失败：'+(e&&e.message||e),'err'); return; }
  cu.chart.setOption(opt, true);
  setTimeout(()=>cu.chart&&cu.chart.resize(),30);
}

// 同比/环比：按预设期取两期矩阵，series 变「上期/本期」（PSI/IDC 走矩阵区间；财经走 finance total 预设期）。
async function cuResolveCompareMatrix(BR, b){
  const ds=b.dataset||'psi';
  if(ds==='finance'){
    const fm=(typeof state!=='undefined' && state.finMeta)||{};
    const ctx={ curYear: b.year || (fm.actualYears&&fm.actualYears[fm.actualYears.length-1]) || 0,
                fromM: b.fromM||1, toM: b.toM||12 };
    const per=BR.comparePeriodsForPreset(b.compare, ctx);
    const mk=(pp)=>({ dataset:'finance', measure:b.measure, basis:b.basis||'actual', filters:b.filters,
                      version:b.version||undefined, year:pp.year, fromM:pp.fromM, toM:pp.toM, catField:b.catField });
    const A=await BR.resolveFinanceMatrix(api, mk(per.a));
    const Bv=await BR.resolveFinanceMatrix(api, mk(per.b));
    return cuTwoPeriodMatrix(A, Bv);
  }
  // PSI/IDC：以周期(period/quarter)为类别取全序列，再按预设期区间聚合两期总量成两个类别柱。
  const ctx=cuInferPeriodCtx(b);
  const per=BR.comparePeriodsForPreset(b.compare, ctx);
  // 用完整时间序列矩阵（类别=时间桶），按 A/B 区间求和。
  const el=cuBuildElBinding(Object.assign({}, b, { timeFrom:null, timeTo:null }));
  const full = ds==='idc' ? await BR.resolveIdcMatrix(api, el.binding) : await BR.resolveMatrix(api, el.binding);
  const sumRange=(pp)=>{ let s=0; const cats=full.cats||[]; (full.series||[]).forEach(se=>{ (cats).forEach((c,i)=>{ if(cuPeriodInRange(c,pp.fromM,pp.toM,pp.year)) s+=(+se.values[i]||0); }); }); return s; };
  const aLabel=cuPeriodLabel(per.a), bLabel=cuPeriodLabel(per.b);
  return { cats:[aLabel, bLabel], series:[{ name:cuFieldLabel(b.measure,ds), values:[ sumRange(per.a), sumRange(per.b) ] }] };
}
// finance 两期矩阵合成：cats 取并集（保持 B 的顺序为主），series=[上期,本期]。
function cuTwoPeriodMatrix(A, B){
  const bc=(B&&B.cats)||[], ac=(A&&A.cats)||[];
  const cats=bc.slice(); ac.forEach(c=>{ if(cats.indexOf(c)<0) cats.push(c); });
  const av=(A&&A.series&&A.series[0])||{values:[]}, bv=(B&&B.series&&B.series[0])||{values:[]};
  const mapOf=(cs,sv)=>{ const m={}; (cs||[]).forEach((c,i)=>m[c]=(+((sv.values||[])[i])||0)); return m; };
  const am=mapOf(ac,av), bm=mapOf(bc,bv);
  return { cats, series:[ {name:'上期',values:cats.map(c=>am[c]||0)}, {name:'本期',values:cats.map(c=>bm[c]||0)} ] };
}
// —— 同比区间辅助（PSI period='YYYY-MM' / IDC quarter='YYYYQn' 之类；此处按「年在前」宽松匹配）——
function cuInferPeriodCtx(b){
  // 从 state 取当前年月上下文兜底；无则用 0（comparePeriodsForPreset 会兜底）。
  const y=(typeof state!=='undefined' && state.to) ? parseInt(String(state.to).slice(0,4),10) : 0;
  const m=(typeof state!=='undefined' && state.to) ? parseInt(String(state.to).slice(5,7),10)||12 : 12;
  return { curYear:y, fromM:1, toM:m };
}
function cuPeriodLabel(pp){ return pp.year+'年 '+pp.fromM+(pp.fromM===pp.toM?'':('-'+pp.toM))+'月'; }
function cuPeriodInRange(cat, from, to, year){
  // cat 形如 '2026-01' / '2026-1月' / '2026年6月' / '2026'（纯年→无月，保留）。
  // 仅当有明确月份分隔（'-MM' 或 'MM月'）时才按月过滤，避免把纯年份末位当月份。
  const s=String(cat);
  // 年份过滤（若给了 year 且 cat 前缀是 4 位年）。
  if(year){ const ym=s.match(/^(\d{4})/); if(ym && parseInt(ym[1],10)!==year) return false; }
  let m=null;
  const mDash=s.match(/-(\d{1,2})(?:月)?$/); if(mDash) m=parseInt(mDash[1],10);
  else { const mMon=s.match(/(\d{1,2})\s*月$/); if(mMon) m=parseInt(mMon[1],10); }
  if(m==null||m<1||m>12) return true;   // 无可识别月份 → 不按月过滤（年份已过滤）
  return (from==null||m>=from)&&(to==null||m<=to);
}

// 散点/气泡：原生 engine.custom 管线（保留原交互与 selftest 契约）。
async function drawCustomNative(){
  const sl=cu.slots;
  const ready = sl.sizeMetric && (sl.xDim || sl.yDim);
  $('#cuEmpty').classList.toggle('hidden', !!ready);
  if(!ready){ cu.chart.clear(); renderCuColors([]); return; }
  const res=await api.custom({xDim:sl.xDim,yDim:sl.yDim,sizeMetric:sl.sizeMetric,colorDim:sl.colorDim||'',filters:cu.binding.filters||{}});
  cu.last=res;
  const palette=SB_COLORS.seriesDiscrete;
  const xs=res.xs.length?res.xs:['(全部)'], ys=res.ys.length?res.ys:['(全部)'];
  let maxS=0,minS=Infinity; res.points.forEach(p=>{const a=Math.abs(p.size); if(a>maxS)maxS=a; if(a<minS)minS=a;}); if(!isFinite(minS))minS=0; if(maxS<=0)maxS=1;
  const scale=v=>{ if(cu.type==='scatter') return 11; const r=Math.sqrt(Math.abs(v)/maxS); return Math.round(10+r*52); };
  const byColor={}; res.points.forEach(p=>{ const c=p.color||'数据'; (byColor[c]=byColor[c]||[]).push(p); });
  renderCuColors(Object.keys(byColor));
  const series=Object.keys(byColor).map((c,i)=>({name:c,type:'scatter',
    symbolSize:function(d){ return scale(d[2]); }, itemStyle:{color:sbSeriesColor(c,i,cu.colorOverride,palette),opacity:.72,borderColor:'#fff',borderWidth:1},
    label:{show:cu.type==='bubble',formatter:p=>shortLabel(p.data[2]),position:'inside',fontFamily:YH,fontSize:9,color:'#fff'},
    data:byColor[c].map(p=>[xs.indexOf(p.x), ys.indexOf(p.y), p.size, p.x, p.y]),
    emphasis:{focus:'series'}}));
  cu.chart.setOption({textStyle:{fontFamily:YH},
    tooltip:{trigger:'item',backgroundColor:'rgba(26,26,26,.92)',borderWidth:0,textStyle:{color:'#fff',fontFamily:YH,fontSize:12},
      formatter:p=>(labelOfField(cu.slots.xDim))+'：<b>'+p.data[3]+'</b><br>'+(labelOfField(cu.slots.yDim))+'：<b>'+p.data[4]+'</b><br>'+METRIC_LABEL[cu.slots.sizeMetric]+'：<b>'+fmt(p.data[2])+'</b>'},
    legend: res.colors.length?{bottom:2,textStyle:{fontFamily:YH,fontSize:11,color:CT().ink2()}}:{show:false},
    grid:{left:120,right:30,top:24,bottom:60},
    xAxis:{type:'category',data:xs,name:labelOfField(cu.slots.xDim),nameLocation:'middle',nameGap:38,nameTextStyle:{fontFamily:YH,fontSize:12,color:CT().ink2()},axisLabel:{fontFamily:YH,fontSize:11,color:CT().ink3(),interval:0,rotate:xs.length>6?30:0}},
    yAxis:{type:'category',data:ys,name:labelOfField(cu.slots.yDim),nameTextStyle:{fontFamily:YH,fontSize:12,color:CT().ink2()},axisLabel:{fontFamily:YH,fontSize:11,color:CT().ink3()}},
    series},true);
  setTimeout(()=>cu.chart&&cu.chart.resize(),30);
}

/* ============================================================
   导出（Excel / PPT）——两条管线各自透视。
   ============================================================ */
async function exportCuXlsx(){
  if(!cu.last){ toast('请先配置图表','err'); return; }
  let aoa;
  if(cu.last.binding){
    const cats=cu.last.cats, series=cu.last.series, data=cu.last.data;
    aoa=[['类别'].concat(series)];
    cats.forEach(c=>aoa.push([c].concat(series.map(s=>+((data[s]&&data[s][c])||0).toFixed(2)))));
  } else {
    if(!cu.last.points||!cu.last.points.length){ toast('请先配置图表','err'); return; }
    const xs=cu.last.xs, ys=cu.last.ys;
    const m={}; cu.last.points.forEach(p=>{ m[p.x]=m[p.x]||{}; m[p.x][p.y]=(m[p.x][p.y]||0)+p.size; });
    const head=[labelOfField(cu.slots.xDim)+'\\'+labelOfField(cu.slots.yDim)].concat(ys);
    aoa=[head]; xs.forEach(x=>aoa.push([x].concat(ys.map(y=>+((m[x]&&m[x][y])||0).toFixed(2)))));
  }
  const wb=XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb,XLSX.utils.aoa_to_sheet(aoa),'自定义');
  const b64=XLSX.write(wb,{bookType:'xlsx',type:'base64'});
  const res=await api.saveFile('自定义图表_'+todayStr()+'.xlsx',b64,'xlsx'); if(res&&res.path)toast('已导出','ok');
}
async function exportCuPpt(){
  if(!cu.chart||!cu.last){ toast('请先配置图表','err'); return; }
  const pptx=new PptxGenJS(); pptx.defineLayout({name:'W',width:13.333,height:7.5}); pptx.layout='W';
  const s=pptx.addSlide();
  const title='自定义'+(CU_VNAME[cu.type]||cu.type)+'图';
  s.addText(title,{x:0.4,y:0.25,w:12.5,h:0.5,fontFace:'微软雅黑',fontSize:16,bold:true,color:'C7000B'});
  try{ const url=cu.chart.getDataURL({pixelRatio:2,backgroundColor:'#ffffff'}); s.addImage({data:url,x:0.5,y:1.0,w:12.3,h:6.0}); }catch(e){}
  const b64=await pptx.write('base64'); const res=await api.saveFile('自定义图表_'+todayStr()+'.pptx',b64,'pptx'); if(res&&res.path)toast('已导出','ok');
}

/* ---- 事件绑定（app.js init() 调用） ---- */
function initCustomView(){
  cuStateLoad();
  $('#cuClear').onclick=()=>{
    if(cuIsNative(cu.type)){ cu.slots={xDim:'',yDim:'',sizeMetric:'',colorDim:''}; }
    else { cu.binding.filters={}; }
    buildCuPanel(); drawCustom(); cuStateSave();
  };
  $('#cuExportPpt').onclick=exportCuPpt;
  $('#cuExportXlsx').onclick=exportCuXlsx;
}

/* ============================================================
   纯函数导出（Node 测试用）：配置 → binding-resolver 参数映射。
   浏览器里这些函数仍以全局形式挂着（供 view 内部调用），此处仅在 Node 下追加 module.exports。
   ============================================================ */
if(typeof module!=='undefined' && module.exports){
  module.exports={
    cuBuildElBinding, cuMatrixToRes, cuTwoPeriodMatrix, cuPeriodInRange,
    cuDefAgg, cuIsTimeField, CU_VISUALS, CU_NATIVE, cuIsNative,
  };
}

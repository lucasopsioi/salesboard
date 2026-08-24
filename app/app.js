/* ============================================================
   Salesboard 渲染端 — 通过 IPC 向主进程引擎取"聚合后的小结果"
   百万行明细留在主进程列式存储，界面只拿图表数据
   ============================================================ */
'use strict';
// 共享前置声明 + 跨视图辅助已移至 common.js（在本文件之前加载）。
const isAllChannel=v=>/^(all|全部|合计)$/i.test(String(v==null?'':v).trim());

/* PSI 视图（applyMeta/draw/drawChart/filters 等）已移至 views/psi-view.js
   数据源视图（renderSource/renderArchiveCard）已移至 views/source-view.js
   汇总表视图（rep 状态/drawReport/exportRep* 等）已移至 views/report-view.js
   国家看板视图（cb 状态/drawCountryBoard/exportCb* 等）已移至 views/country-view.js
   自定义图表视图（cu 状态/drawCustom/exportCu* 等）已移至 views/custom-view.js
   纯搬运，无逻辑改动；五者在 common.js 之后、app.js 之前加载。
   跨视图共用的 maxWeekNum / renderWeekRange 已移至 common.js。 */

/* 经营分析视图（fin 状态/drawFinanceAchieve/renderFinBpBoard/BP达成 等）已移至 views/finance-view.js
   纯搬运，无逻辑改动；在 common.js 之后、app.js 之前加载。事件绑定见 initFinanceView()。 */
/* 产业看板视图（ind 状态/initIndustry/drawIndustry/renderInd... /exportInd... 等）已移至 views/industry-view.js
   纯搬运，无逻辑改动；在 common.js 之后、app.js 之前加载。事件绑定见 initIndustryView()。 */

/* 看板设计器视图（dz 状态/buildDesigner/磁贴/检查器/联动筛选/导出 等）已移至 views/designer-view.js
   纯搬运，无逻辑改动；在 common.js 之后、app.js 之前加载。事件绑定见 initDesignerView()。 */

// 跨视图共享辅助（todayStr / currentView / renderDataBar）已移至 common.js（在本文件之前加载）。
// Ctrl+滚轮 缩放表格/容器：仅 init() 内挂载一次，无视图调用 → 留在协调层 app.js
const _zoomMap=new WeakMap();
function setupCtrlZoom(){
  document.addEventListener('wheel',e=>{
    if(!e.ctrlKey) return;
    const wrap=e.target.closest&&e.target.closest('.rep-table-wrap,.cb-table-wrap,.cb-list,.fin-body .cb-card .cb-table-wrap,.cb-card');
    if(!wrap) return;
    e.preventDefault();
    let z=_zoomMap.get(wrap)||1; z+=(e.deltaY<0?0.1:-0.1); z=Math.max(0.5,Math.min(2.5,Math.round(z*10)/10)); _zoomMap.set(wrap,z);
    wrap.style.zoom=z;
  },{passive:false});
}

/* ============================================================
   FOLDER ANCHOR / REFRESH
   ============================================================ */
// 底数据 reload（锚定/刷新/示例）后：若当前在 PPT 设计器视图，重解析所有绑定元素并重渲（“刷底数据自动刷新”）。守卫：仅当函数存在且视图激活。
function pptMaybeRefresh(){
  try{
    const v=currentView();
    if(v==='pptoutput' && typeof refreshAll==='function') refreshAll();
    // 底数据/库存刷新后:重建库存 __sosim(异步,完成即广播 sb:sosim-updated)。
    if(typeof invRebuildCtx==='function') invRebuildCtx();
  }catch(_){ }
}
async function anchorFolder(){
  const folder=await api.pickFolder(); if(!folder) return;
  showLoading('正在锚定并建立索引…\n首次建索引较慢，请稍候');
  const m=await api.setFolderAndRefresh(folder);
  hideLoading();
  if(m&&m.error){ toast('建立索引失败：'+m.error,'err'); return; }
  applyMeta(m); await initFilters(); draw(); pptMaybeRefresh();
  toast('已锚定 · '+(m.records||0).toLocaleString()+' 条'+(m.parsedCount?('（解析'+m.parsedCount+'个文件）'):''),'ok');
}
// 库存/经营分析/IDC 文件夹的导入入口已移至「数据源」看板的「底表来源」面板（source-view.js），
// 那里直接调 api.pickXFolder()+api.setXFolderAndRefresh() 再走全局 refresh()。原 anchorInvFolder/
// anchorFinFolder/anchorIdcFolder 已删。anchorFolder 仍由 PSI 空状态按钮(btnAnchor2)使用，保留。

/* 全局刷新：重读所有已锚定文件夹（增量），刷新 PSI 维度/筛选/图，并重填库存看板的
   发货/成本（__sosim）+ 重渲库存/销毛消费看板。即便主底表未锚定，只要发货/成本文件夹已设置，
   也要把 ship/cost 刷到库存/销毛看板，故主底表为空时不再直接 return，仅跳过 PSI 重绘。 */
async function refresh(){
  const hasMain = !!(state.folder || state.invFolder || state.finFolder || state.idcFolder);
  showLoading('正在刷新（重读所有底表，含发货/成本表）…');
  let m=null, sc={ship:0,cost:0};
  try{
    if(hasMain){
      m=await api.refresh();
      if(m&&m.error){ hideLoading(); toast('刷新失败：'+m.error,'err'); return; }
      applyMeta(m); await renderFilters(); draw(); pptMaybeRefresh();
    }
    // 库存看板底表：重读发货/成本文件夹（持久化源），重填 __sosim 并重渲消费看板（返回行数/SKU数用于提示）。
    sc=await refreshSosimConsumers();
  } finally { hideLoading(); }
  const sct='发货 '+(sc.ship||0).toLocaleString()+' 行、成本 '+(sc.cost||0)+' SKU';
  if(hasMain){
    toast('已刷新 · '+(m&&m.records||0).toLocaleString()+' 条'+(m&&m.parsedCount?('（重读'+m.parsedCount+'个文件）'):'（缓存）')+' · '+sct,'ok');
  } else {
    toast('已刷新 · '+sct,'ok');
  }
}

/* 重填库存看板的发货/成本（__sosim）并重渲已建的库存/销毛看板。
   - invAutoLoadSources（库存视图暴露到 window）经 sosimSource 读最新文件 AOA → 解析进 __sosim.ship/cost。
   - 库存看板已建（#invRoot[data-built]）→ invRebuildCtx() 重算并重渲表/图。
   守卫写法参照现有 pptMaybeRefresh：仅当函数存在且看板已建时调用。 */
async function refreshSosimConsumers(){
  let counts={ship:0,cost:0};
  // 发货/成本源加载：失败必须提示（旧版静默吞错→用户看旧数据却无感知）。
  try{ if(typeof window.invAutoLoadSources==='function') counts=await window.invAutoLoadSources()||counts; }
  catch(e){ toast('发货/成本源加载失败：'+(e&&e.message||e),'err'); try{api.log&&api.log('refreshSosimConsumers.invAutoLoadSources '+(e&&e.stack||e));}catch(_){} }
  // 库存看板：已建则重算上下文并重渲（invRebuildCtx 异步取 PSI 行后自动 invRenderTables）。
  try{
    const invRoot=document.getElementById('invRoot');
    if(invRoot && invRoot.dataset.built && typeof invRebuildCtx==='function') invRebuildCtx();
  }catch(e){ toast('库存看板刷新失败：'+(e&&e.message||e),'err'); try{api.log&&api.log('refreshSosimConsumers.invRebuildCtx '+(e&&e.stack||e));}catch(_){} }
  // 定价测算：成本表与库存同源（数据源 costFolder）。重读成本，若当前在该视图则重渲。
  try{
    if(typeof window.pxAutoLoadCost==='function'){ await window.pxAutoLoadCost(); if(currentView()==='pricing' && typeof renderPricing==='function') renderPricing(); }
  }catch(e){ toast('定价成本表刷新失败：'+(e&&e.message||e),'err'); try{api.log&&api.log('refreshSosimConsumers.pxAutoLoadCost '+(e&&e.stack||e));}catch(_){} }
  // 产品定价库：同上。
  try{
    if(typeof window.pxLibAutoLoadCost==='function'){ await window.pxLibAutoLoadCost(); if(currentView()==='pricinglib' && typeof renderPricingLib==='function') renderPricingLib(); }
  }catch(e){ toast('定价库成本表刷新失败：'+(e&&e.message||e),'err'); try{api.log&&api.log('refreshSosimConsumers.pxLibAutoLoadCost '+(e&&e.stack||e));}catch(_){} }
  return counts;
}
async function loadSample(){
  showLoading('正在载入示例…');
  const m=await api.sample(); hideLoading();
  applyMeta(m); await initFilters(); draw(); pptMaybeRefresh();
  // 演示种子:路标产品库为空时种入虚构 Product A~F(已有真实数据则绝不覆盖) —— demo-seed.js
  try{ if(window.SbDemoSeed && SbDemoSeed.seedRoadmapIfEmpty() && window.RM_API && RM_API.renderList) RM_API.renderList(); }catch(e){}
  toast('已载入示例 · '+(m.records||0).toLocaleString()+' 条','ok');
}

/* ============================================================
   INIT
   ============================================================ */
function switchView(v){
  $$('.nav-item').forEach(n=>n.classList.toggle('active',n.dataset.view===v));
  $$('.view').forEach(el=>el.classList.toggle('active',el.id==='view-'+v));
  renderDataBar(v);
  $('#viewTitle').textContent={psi:'PSI 数据分析',industry:'产业看板',finance:'经营分析',country:'国家看板',report:'汇总表',custom:'自定义图表',designer:'看板设计器',source:'数据源',pricing:'定价测算',pricinglib:'产品定价库',roadmap:'路标管理',pptoutput:'PPT output',inventory:'库存管理',textout:'文字输出',audio:'产业周报'}[v]||v;
  if(v==='pricing'&&typeof renderPricing==='function') renderPricing();
  if(v==='pricinglib'&&typeof renderPricingLib==='function') renderPricingLib();
  if(v==='roadmap'&&typeof renderRoadmap==='function') renderRoadmap();
  if(v==='pptoutput'&&typeof renderPptOutput==='function') renderPptOutput();
  if(v==='inventory'&&typeof renderInventory==='function') renderInventory();
  if(v==='textout'&&typeof renderTextout==='function') renderTextout();
  if(v==='audio'&&typeof renderAudio==='function') renderAudio();
  if(v==='psi'&&chart) setTimeout(()=>chart.resize(),50);
  if(v==='industry'){ if(state.dims.length){ if(!ind.data) initIndustry(); else setTimeout(()=>ind.chart&&ind.chart.resize(),50); } else $('#indEmpty').classList.remove('hidden'); }
  if(v==='report' && state.dims.length && !rep.last) drawReport();
  if(v==='country' && state.dims.length && !cb.last.length){ buildCbDimOptions(); renderCbFilters(); drawCountryBoard(); }
  if(v==='custom' && (state.dims.length || state.idcMeta || state.finMeta)){ buildCuPalette(); setTimeout(()=>{drawCustom();},30); }
  if(v==='finance'){ if(state.finMeta){ buildFinControls(); drawFinanceAchieve(); } else $('#finEmpty').classList.remove('hidden'); }
  if(v==='designer'){ buildDesigner(); setTimeout(()=>dz.tiles.forEach(t=>t.chart&&t.chart.resize()),60); }
}

/* ============================================================
   侧栏自定义：拖动排序 + 右键隐藏 + 恢复条
   ============================================================ */
const NAV_ORDER_KEY = 'sb.navOrder', NAV_HIDDEN_KEY = 'sb.navHidden';
let DEFAULT_NAV = [];
function navItems(){ return $$('.nav-item[data-view]'); }
function readNavArr(key){ try{ const v=JSON.parse(localStorage.getItem(key)); return Array.isArray(v)?v:[]; }catch(e){ return []; } }
function saveNavOrder(){ localStorage.setItem(NAV_ORDER_KEY, JSON.stringify(navItems().map(n=>n.dataset.view))); }
function saveNavHidden(set){ localStorage.setItem(NAV_HIDDEN_KEY, JSON.stringify([...set])); }

function applyNav(){
  const nav=$('.nav'), restore=$('#navRestore');
  if(!DEFAULT_NAV.length) DEFAULT_NAV = navItems().map(n=>n.dataset.view);
  const { order, hidden } = NavOrder.reconcileNav(readNavArr(NAV_ORDER_KEY), readNavArr(NAV_HIDDEN_KEY), DEFAULT_NAV);
  const byView={}; navItems().forEach(n=>byView[n.dataset.view]=n);
  order.forEach(v=>{ const el=byView[v]; if(el){ el.style.display = hidden.has(v)?'none':''; nav.insertBefore(el, restore); } });
  renderRestore(hidden);
  bindNavDnD(); bindNavMenu();
  $('#navRestore').onclick = ()=> $('#navHiddenList').classList.toggle('hidden');
  document.addEventListener('click', e=>{ if(!$('#navMenu').contains(e.target)) $('#navMenu').classList.add('hidden'); });
}

function renderRestore(hidden){
  const bar=$('#navRestore'), list=$('#navHiddenList');
  if(!bar||!list) return;
  if(!hidden.size){ bar.classList.add('hidden'); list.classList.add('hidden'); list.innerHTML=''; return; }
  bar.classList.remove('hidden');
  $('#navRestoreTxt').textContent='显示隐藏的看板 ('+hidden.size+')';
  list.innerHTML='';
  [...hidden].forEach(v=>{ const src=$('.nav-item[data-view="'+v+'"]');
    const it=document.createElement('div'); it.className='nav-hidden-item'; it.innerHTML = src?src.innerHTML:v;
    it.onclick=()=>unhideView(v); list.appendChild(it);
  });
}

function hideView(v){
  const set=new Set(readNavArr(NAV_HIDDEN_KEY)); set.add(v); saveNavHidden(set);
  const el=$('.nav-item[data-view="'+v+'"]'); if(el) el.style.display='none';
  const active=$('.nav-item.active');
  if(active && active.dataset.view===v){ const fv=navItems().find(n=>n.style.display!=='none'); if(fv) switchView(fv.dataset.view); }
  renderRestore(set);
}
function unhideView(v){
  const set=new Set(readNavArr(NAV_HIDDEN_KEY)); set.delete(v); saveNavHidden(set);
  const el=$('.nav-item[data-view="'+v+'"]'); if(el) el.style.display='';
  renderRestore(set);
}
function resetNav(){
  localStorage.removeItem(NAV_ORDER_KEY); localStorage.removeItem(NAV_HIDDEN_KEY);
  const nav=$('.nav'), restore=$('#navRestore'), byView={}; navItems().forEach(n=>byView[n.dataset.view]=n);
  DEFAULT_NAV.forEach(v=>{ const el=byView[v]; if(el){ el.style.display=''; nav.insertBefore(el, restore); } });
  renderRestore(new Set());
}

function bindNavDnD(){
  navItems().forEach(n=>{
    n.draggable=true;
    n.ondragstart=e=>{ n.classList.add('dragging'); e.dataTransfer.effectAllowed='move'; };
    n.ondragend=()=>{ n.classList.remove('dragging'); saveNavOrder(); };
    n.ondragover=e=>{ e.preventDefault();
      const dragging=$('.nav-item.dragging'); if(!dragging||dragging===n) return;
      const rect=n.getBoundingClientRect(); const after=(e.clientY-rect.top)>rect.height/2;
      $('.nav').insertBefore(dragging, after? n.nextSibling : n);
    };
  });
}
function bindNavMenu(){
  navItems().forEach(n=>{ n.oncontextmenu=e=>{ e.preventDefault(); showNavMenu(e.clientX, e.clientY, n.dataset.view); }; });
}
function showNavMenu(x,y,v){
  const m=$('#navMenu'); m.style.left=x+'px'; m.style.top=y+'px'; m.classList.remove('hidden');
  $('#navMenuHide').onclick=()=>{ hideView(v); m.classList.add('hidden'); };
  $('#navMenuReset').onclick=()=>{ resetNav(); m.classList.add('hidden'); };
}

async function init(){
  try{ api.bootPhase && api.bootPhase('加载界面…'); }catch(e){}
  $$('.nav-item[data-view]').forEach(n=>n.onclick=()=>switchView(n.dataset.view));
  applyNav();
  try{ const ver=await api.appVersion(); window.__appVer=ver||null; const el=$('#navVersion'); if(el) el.textContent = (ver&&ver.version)? ('v'+ver.version+(ver.builtAt?(' · '+ver.builtAt):'')) : '开发版'; }catch(e){}
  // 顶部「PSI/库存/经营/IDC 文件夹」导入按钮已移除，统一收拢到「数据源」看板的「底表来源」面板。
  // btnAnchor2 仍是 PSI 空状态的锚定入口，保留 anchorFolder 绑定。
  $('#btnAnchor2').onclick=anchorFolder;
  $('#btnRefresh').onclick=refresh;
  $('#btnSample').onclick=loadSample;
  // PSI 视图事件绑定已移至 views/psi-view.js
  initPsiView();
  // 数据源视图事件绑定已移至 views/source-view.js
  initSourceView();
  // 汇总表视图事件绑定已移至 views/report-view.js
  initReportView();
  // 国家看板视图事件绑定已移至 views/country-view.js
  initCountryView();
  // 自定义图表视图事件绑定已移至 views/custom-view.js
  initCustomView();
  // 看板设计器视图事件绑定已移至 views/designer-view.js
  initDesignerView();
  // 产业看板视图事件绑定已移至 views/industry-view.js
  initIndustryView();
  // 经营分析视图事件绑定已移至 views/finance-view.js
  initFinanceView();
  api.onProgress(d=>{
    const tp=$('#topProg'), fill=$('#topProgFill'), txt=$('#topProgTxt');
    const showTP=(pct,label,done)=>{ if(!tp)return; tp.classList.remove('hidden'); tp.classList.toggle('done',!!done);
      if(fill) fill.style.width=Math.max(0,Math.min(100,pct))+'%'; if(txt) txt.textContent=label; };
    if(d.phase==='scan'){ showLoading('正在读取已锚定的文件夹…共 '+d.n+' 个文件'); showTP(0,'共 '+d.n+' 个文件，开始解析…',false); }
    else if(d.phase==='file'){ const pct=d.n?Math.round((d.i/d.n)*100):0;
      showLoading('正在解析 '+d.i+'/'+d.n+'：'+d.name); showTP(pct,'解析 '+d.i+'/'+d.n+' ('+pct+'%)：'+d.name,false); }
    else if(d.phase==='merge'){ showLoading('正在合并去重、建立索引…'); showTP(100,'合并去重、建立索引…',false); }
    else if(d.phase==='done'){
      const t=new Date(d.ts||Date.now()).toLocaleTimeString('zh-CN',{hour12:false});
      if(d.fromSnapshot) showTP(100,'✅ 就绪(快照) · '+(d.records||0).toLocaleString()+' 条',true);
      else showTP(100,'✅ 已更新 · '+t+' · '+(d.records||0).toLocaleString()+' 条'+(d.parsedCount?(' · 重解'+d.parsedCount+'个文件'):''),true);
    }
  });
  setupCtrlZoom();

  // startup: load meta; if folder anchored, refresh from it (incremental)
  try{ api.bootPhase && api.bootPhase('读取存档与配置…'); }catch(e){}
  let m=await api.meta();
  if(m.folder||m.invFolder||m.finFolder){
    showLoading('正在读取已锚定的文件夹…');
    try{ api.bootPhase && api.bootPhase('读取数据…'); }catch(e){}
    m=await api.open();
    hideLoading();
  }
  applyMeta(m);
  try{ api.bootPhase && api.bootPhase('绘制首屏…'); }catch(e){}
  if(state.dims.length){ await initFilters(); draw(); }
  try{ api.bootReady && api.bootReady(); }catch(e){}

  if(api.selftest){
    try{
      const s1=await api.sample(); applyMeta(s1); await initFilters(); await draw();
      const opt=await api.options('country',{region:'拉美终端事业部'});
      const q=state.lastQuery;
      const seriesCnt = chart? chart.getOption().series.length : 0;
      const rp=await api.report({groupDim:'line',weeks:9,filters:{}});
      switchView('report'); await drawReport();
      // test report PPT table generation (no save)
      let repPptOk=false,repPptErr='';
      try{
        const pptx=new PptxGenJS(); pptx.defineLayout({name:'W',width:13.333,height:7.5}); pptx.layout='W';
        const sl=pptx.addSlide();
        const cell=(t,o)=>({text:String(t),options:Object.assign({fontFace:'微软雅黑',fontSize:8,align:'right'},o||{})});
        const rows2=[[cell('系列',{bold:true,color:'FFFFFF',fill:{color:'C7000B'},align:'left'})].concat(rp.weekLabels.map(w=>cell(w,{bold:true,color:'FFFFFF',fill:{color:'C7000B'}})))];
        rp.rows.slice(0,3).forEach(o=>rows2.push([cell(o.key,{align:'left'})].concat(o.weekly.map(v=>cell(Math.round(v))))));
        sl.addTable(rows2,{x:0.3,y:0.8,w:12.7,autoPage:true});
        repPptOk=(await pptx.write('base64')).length>3000;
      }catch(e){ repPptErr=String(e&&e.message||e); }
      const domRows=document.querySelectorAll('#repTable tr').length;
      const domCols=document.querySelectorAll('#repTable tr:first-child th').length;
      const hasTotal=!!document.querySelector('#repTable tr.total');
      // chart types + color override
      switchView('psi');
      const chartTypes={};
      for(const tt of ['area','line','stackBar','pctBar','groupBar']){
        state.chartType=tt; drawChart();
        const o=chart.getOption(); chartTypes[tt]={n:o.series.length,t:o.series[0]?o.series[0].type:''};
      }
      state.colorOverride[state.stackOrder[0]]='#0066CC'; drawChart();
      const overrideApplied=(chart.getOption().series.find(x=>x.name===state.stackOrder[0])||{}).itemStyle;
      // PPT export gen for stackBar (no save)
      state.chartType='stackBar'; drawChart();
      let barPptOk=false,barErr='';
      try{
        const pptx=new PptxGenJS(); pptx.defineLayout({name:'W',width:13.333,height:7.5}); pptx.layout='W';
        const sl=pptx.addSlide(); const q2=state.lastQuery;
        const cd=state.stackOrder.map(name=>({name,labels:q2.buckets,values:q2.buckets.map(b=>+((q2.data[name]&&q2.data[name][b])||0).toFixed(2))}));
        sl.addChart(pptx.ChartType.bar,cd,{x:0.5,y:0.9,w:12,h:6,barDir:'col',barGrouping:'stacked',chartColors:state.stackOrder.map(colorHex),chartColorsOpacity:80});
        barPptOk=(await pptx.write('base64')).length>3000;
      }catch(e){ barErr=String(e&&e.message||e); }
      // multi-select: pick 2 lines -> exactly 2 series; total label series present when labels on
      state.chartType='area'; state.colorOverride={};
      const twoLines=state.stackOrder.slice(0,2);
      state.filters={line:twoLines}; await draw();
      const msSeriesNames=(state.lastQuery.series||[]).slice();
      state.labels=true; drawChart();
      const hasTotalSeries=chart.getOption().series.some(s=>s.name==='__total');
      state.labels=false; state.filters={}; await draw();
      // country board (multi-country list)
      switchView('country'); buildCbDimOptions(); await renderCbFilters(); await drawCountryBoard();
      const cbCards=document.querySelectorAll('#cbList .cb-card').length;
      const cbFirstTableRows=document.querySelectorAll('#cbList .cb-card:first-child table tr').length;
      // 验证"点外面关闭→触发onCommit"机制
      let commitFired=false;
      const testMs=makeMultiSelect('t',['a','b'],[],{onCommit:()=>{commitFired=true;}});
      document.body.appendChild(testMs);
      testMs.querySelector('.ms-trigger').click();           // 打开(才会渲染选项)
      const cb0=testMs.querySelector('.ms-opt input'); if(cb0){ cb0.checked=true; cb0.dispatchEvent(new Event('change')); } // 勾选->dirty
      closeAllMs();                                          // 模拟点面板外
      testMs.remove();
      // 验证国家看板全局筛选生效：限定到某产品系列后，各表只剩该系列
      const dimsHave=state.dims;
      let cbFilterWorks=false;
      if(dimsHave.includes('series')){
        const someSeries=(await api.options('series',{}))[0];
        cb.filters={series:[someSeries]}; await drawCountryBoard();
        const firstTbl=document.querySelector('#cbList .cb-card:first-child table');
        cbFilterWorks = firstTbl && firstTbl.textContent.includes(someSeries) && document.querySelectorAll('#cbList .cb-card:first-child table tr').length<=3;
        cb.filters={}; await drawCountryBoard();
      }
      // custom chart (bubble)
      switchView('custom'); buildCuPalette(); renderCuSlots();
      cu.type='bubble'; cu.slots={xDim:'country',yDim:'repOffice',sizeMetric:'sellOut',colorDim:''};
      await drawCustom();
      const cuSeries=cu.chart?cu.chart.getOption().series.length:0;
      const cuPoints=cu.last?cu.last.points.length:0;
      // bubble symbolSize varies by value
      let cuSizeVaries=false; try{ const ss=cu.chart.getOption().series[0].symbolSize; cuSizeVaries=(typeof ss==='function')&&(ss([0,0,1])!==ss([0,0,1000])); }catch(e){}
      // SI columns present in report
      const siOk = rp.rows[0] && (rp.rows[0].siCur!==undefined) && (rp.rows[0].siYoy!==undefined);
      // 经营分析(现仅"达成情况表")
      switchView('finance'); buildFinControls(); await drawFinanceAchieve();
      const ach=fin.ach; const achTables=document.querySelectorAll('#finAchieveBody .fa-table').length;
      const achRow0=ach&&ach.repTableRows&&ach.repTableRows[0];
      const achData=ach?{hasRev:ach.hasRev,hasGm:ach.hasGm,fromM:ach.fromM,toM:ach.toM,seriesKey:ach.seriesKey,reps:ach.repTableRows.length,
        regionSeries:ach.regionSeriesRows.length, regionRev26:Math.round(ach.regionRow.rev26), regionGmr26:ach.regionRow.gmr26,
        industries:(ach.industries||[]).length, expBtns:document.querySelectorAll('#finAchieveBody .fa-exp button').length,
        sampleRep:achRow0?{k:achRow0.key,revYoy:achRow0.revYoy,attain:achRow0.attain,gmrDiff:achRow0.gmrDiff}:null, tables:achTables}:null;
      const finData={hasFin:!!state.finMeta, metrics:state.finMeta?state.finMeta.metrics.length:0, achieve:achData};
      // 产业看板
      switchView('industry'); ind.filters={}; ind.cmp={series:[],product:[],model:[]}; ind.metric='sellOut'; ind.gran='month'; ind.from=null; ind.to=null;
      await initIndustry();
      const ib=ind.data; const indKpiCards=document.querySelectorAll('#indKpi .kpi-card').length;
      const indChartSeries=ind.chart?ind.chart.getOption().series.length:0;
      const indFilterCtrls=document.querySelectorAll('#indFilterRow .ms').length;
      const indCmpCtrls=document.querySelectorAll('#indCmpRow .ms').length;
      const indData=ib?{indDim:ib.indDim,trendPeriods:ib.trend.periods.length,
        kpiSI:Math.round(ib.kpi.si.cur),kpiSO:Math.round(ib.kpi.so.cur),inv:Math.round(ib.kpi.inv.cur),flow:ib.kpi.flow?ib.kpi.flow.cur:null,
        kpiCards:indKpiCards,chartSeries:indChartSeries,filterCtrls:indFilterCtrls,cmpCtrls:indCmpCtrls}:null;
      switchView('psi');
      // 看板设计器：加几种磁贴，渲染，联动筛选
      switchView('designer'); dz.dataset='psi'; buildDesigner();
      dz.tiles=[]; dz.filters={psi:{},idc:{}}; dz.nextId=1;
      ['column','stackColumn','stack100','bar','stackBar','stack100Bar','combo','pie','treemap','gauge','kpi','matrix','table','bubble','waterfall','slicer'].forEach(t=>dzAddTile(t));
      await new Promise(r=>setTimeout(r,200));
      const tilesN=dz.tiles.length;
      const chartTiles=dz.tiles.filter(t=>t.chart).length;
      // 图例位置可设置: 把堆积条形图的图例改到右侧并重渲染
      const sbTile=dz.tiles.find(t=>t.type==='stackBar'); let legendPosOk=false;
      if(sbTile){ sbTile.fmt.legendPos='right'; await dzRenderTile(sbTile); try{ legendPosOk = !!(sbTile.chart && sbTile.chart.getOption().legend[0].right!=null); }catch(_){ legendPosOk=false; } }
      // 联动：点 column 图触发 cross-filter
      const colTile=dz.tiles.find(t=>t.type==='column');
      let cfWorks=false;
      if(colTile&&colTile.wells.cat[0]&&colTile.wells.cat[0]!=='period'){ dzOnClick(colTile,{name:(await api.options(colTile.wells.cat[0],{}))[0]}); cfWorks=Object.keys(dzFilters('psi')).length>0; dz.filters={psi:{},idc:{}}; dzApplyCrossFilter(); }
      else { // column默认cat=period; 改成line再测
        if(state.dims.includes('line')){ colTile.wells.cat=['line']; await dzRenderTile(colTile); dzOnClick(colTile,{name:(await api.options('line',{}))[0]}); cfWorks=Object.keys(dzFilters('psi')).length>0; dz.filters={psi:{},idc:{}}; dzApplyCrossFilter(); }
      }
      const matrixTile=dz.tiles.find(t=>t.type==='matrix'); const matrixRows=matrixTile?document.querySelectorAll('#dz-body-'+matrixTile.id+' tr').length:0;
      const layoutOk=(()=>{ try{ const s=dzSerialize(); return JSON.parse(s).tiles.length===tilesN; }catch(e){return false;} })();
      dz.tiles.forEach(t=>t.chart&&t.chart.dispose()); dz.tiles=[]; dz.filters={psi:{},idc:{}};
      // IDC 数据源：切到 IDC，加柱图(quarter×brand)+matrix，验证 aggIdc 走通
      let idcDesigner=null;
      if(state.idcMeta){ dz.dataset='idc'; buildDesigner();
        dzAddTile('column'); dzAddTile('matrix'); dzAddTile('slicer');
        await new Promise(r=>setTimeout(r,150));
        const idcTiles=dz.tiles.filter(t=>t.dataset==='idc'); const idcChart=idcTiles.filter(t=>t.chart).length;
        const colI=idcTiles.find(t=>t.type==='column');
        const colOpt=colI?colI.chart&&colI.chart.getOption():null; const colSeries=colOpt?colOpt.series.length:0; const colCats=colOpt&&colOpt.xAxis?(colOpt.xAxis[0].data||[]).length:0;
        idcDesigner={dims:dzIdcDims().length, tiles:idcTiles.length, chart:idcChart, colSeries, colCats,
          fieldChips:document.querySelectorAll('#dzDims .dz-chip').length, dsSwitch:document.querySelectorAll('#dzDsSwitch .dz-ds').length};
        dz.tiles.forEach(t=>t.chart&&t.chart.dispose()); dz.tiles=[]; dz.filters={psi:{},idc:{}}; dz.dataset='psi';
      }
      const designer={tiles:tilesN,chartTiles,crossFilter:cfWorks,matrixRows,layoutOk,legendPosOk,idc:idcDesigner};
      switchView('psi');
      // ---- PPT output 第二期 P4/P5/P6/P7 链路自测（合成多页 deck + 裁页）----
      let pptout={ok:false};
      try{
        const T=window.PptTplLatamPhone, P=window.PptPresets;
        const fam=(await api.options('family',{}))[0];
        const preset=P[fam]||{familyFilter:{},groups:{}};
        // 合成最小多页 deck：presentation + 4 页(各含 1 个 chart 占位) + rels
        const z=new JSZip();
        const sld=(rid)=>('<p:sldId id="'+(200+rid)+'" r:id="rId'+rid+'"/>');
        z.file('ppt/presentation.xml','<p:presentation><p:sldIdLst>'+[4,5,6,7].map(n=>sld(n)).join('')+'</p:sldIdLst></p:presentation>');
        z.file('ppt/_rels/presentation.xml.rels','<Relationships>'+[4,5,6,7].map(n=>'<Relationship Id="rId'+n+'" Type="t/slide" Target="slides/slide'+n+'.xml"/>').join('')+'</Relationships>');
        const mkSlide=(file,shape)=>z.file(file,'<p:spTree><p:sp><p:nvSpPr><p:cNvPr id="1" name="'+shape+'"/></p:nvSpPr><p:txBody><a:p><a:r><a:t>XX</a:t></a:r></a:p></p:txBody></p:sp></p:spTree>');
        const mkChart=(f)=>z.file(f,'<c:chart><c:ser><c:tx><c:strRef><c:strCache><c:ptCount val="1"/><c:pt idx="0"><c:v>old</c:v></c:pt></c:strCache></c:strRef></c:tx><c:cat><c:strRef><c:strCache><c:ptCount val="1"/><c:pt idx="0"><c:v>W1</c:v></c:pt></c:strCache></c:strRef></c:cat><c:val><c:numRef><c:numCache><c:ptCount val="1"/><c:pt idx="0"><c:v>0</c:v></c:pt></c:numCache></c:numRef></c:val></c:ser></c:chart>');
        mkSlide(T.p4.slideFile,T.p4.titleShape); mkSlide(T.p5.slideFile,T.p5.titleShape); mkSlide(T.p6.slideFile,T.p6.titleShape); mkSlide(T.p7.slideFile,T.p7.titleShape);
        mkChart(T.p4.charts[0].chartFile); mkChart(T.p5.chart.chartFile); mkChart(T.p6.charts[0].chartFile); mkChart(T.p7.countries[0].chartFile);
        const tpl=await z.generateAsync({type:'uint8array'});
        // 取数（PSI + IDC）
        const k1=preset.groups[T.p4.kpis[0].id]||{label:'x',filter:{}};
        const tot=await PptBind.resolveTotal(api,{groupDim:'line',filters:Object.assign({family:[fam]},k1.filter)});
        const m5=await PptBind.resolveMatrix(api,{measure:'sellOut',legend:'product',catField:'period',catGran:'week',filters:{family:[fam]},lastN:0});
        const idcCat=(await api.idcOptions('cat',{}))[0]||fam;
        const m6=await PptBind.resolveIdcMatrix(api,{catField:T.p6.charts[1].catField,legend:'brand',filters:{cat:[idcCat]},share:true});
        const slides=[
          {slideFile:T.p4.slideFile, textEdits:[{shapeName:T.p4.titleShape,tIndex:0,text:shortLabel(tot.value)}], charts:[{chartFile:T.p4.charts[0].chartFile, data:m5}]},
          {slideFile:T.p6.slideFile, textEdits:[{shapeName:T.p6.titleShape,tIndex:0,text:'IDC'}], charts:[{chartFile:T.p6.charts[0].chartFile, data:m6}]}
        ];
        const filled=await PptFill.fillDeck({JSZip:window.JSZip, XLSX:window.XLSX, templateBytes:tpl, plan:{slides}});
        const trimmed=await PptFill.extractSlides({JSZip:window.JSZip, bytes:filled, keepSlideNos:[4,6]});
        const zb=await JSZip.loadAsync(trimmed); const pres=await zb.file('ppt/presentation.xml').async('string');
        pptout={ ok: trimmed.length>200 && pres.includes('rId4') && pres.includes('rId6') && !pres.includes('rId5') && zb.file(T.p5.slideFile)===null,
          pages:T.pages.length, bytes:trimmed.length, kpi:tot.value, m5:m5.series.length, m6:m6.series.length, idcCat };
      }catch(e){ pptout={ok:false, err:String(e&&e.message||e)}; }
      // ---- PPT 设计器 核心端到端：造文档→解析→导出 ----
      let pptDesigner={ok:false};
      try{
        const fam=(await api.options('family',{}))[0];
        const doc=PptDoc.newPresentation('自测模板');
        const t=PptDoc.newElement('text',{x:1,y:0.6,w:5,h:0.6,text:'手机SO'}); PptDoc.addElement(doc,0,t);
        const dv=PptDoc.newElement('data',{x:1,y:1.4,w:2.4,h:1,style:{unit:'万'},binding:{dataset:'psi',measure:'sellOut',filters:{family:[fam]}}}); PptDoc.addElement(doc,0,dv);
        const ch=PptDoc.newElement('chart',{x:1,y:3,w:8,h:3.5,chart:{vtype:'column'},binding:{dataset:'psi',measure:'sellOut',legend:'line',filters:{family:[fam]}}}); PptDoc.addElement(doc,0,ch);
        PptDoc.addSlide(doc);
        const ic=PptDoc.newElement('chart',{x:1,y:1,w:8,h:4,chart:{vtype:'stackBar'},binding:{dataset:'idc',catField:'pbStd',legend:'brand',filters:{cat:[(await api.idcOptions('cat',{}))[0]]},share:true}}); PptDoc.addElement(doc,1,ic);
        const rm={};
        for(const sl of doc.slides) for(const el of sl.elements){ rm[el.id]=await PptBindings.resolveElement(api, PptBind, el); }
        const b64=await PptExport.exportDoc({PptxGenJS:window.PptxGenJS, doc, resolvedMap:rm});
        pptDesigner={ ok: typeof b64==='string'&&b64.length>3000, slides:doc.slides.length, bytes:b64?b64.length:0 };
      }catch(e){ pptDesigner={ok:false, err:String(e&&e.message||e)}; }
      // ---- PPT 设计器 UI 端到端：store 往返 + 解析 + 导出 ----
      let pptDesignerUI={ok:false};
      try{
        // 1) store round-trip
        const fam=(await api.options('family',{}))[0];
        const doc=PptDoc.newPresentation('自测UI模板');
        const t=PptDoc.newElement('text',{x:1,y:0.6,w:5,h:0.6,text:'手机SO'}); PptDoc.addElement(doc,0,t);
        const dv=PptDoc.newElement('data',{x:1,y:1.6,w:2.5,h:1,style:{unit:'万'},binding:{dataset:'psi',measure:'sellOut',filters:{family:[fam]}}}); PptDoc.addElement(doc,0,dv);
        const ch=PptDoc.newElement('chart',{x:1,y:3,w:8,h:3.5,chart:{vtype:'column',fmt:{legendPos:'bottom'}},binding:{dataset:'psi',measure:'sellOut',legend:'line',filters:{family:[fam]}}}); PptDoc.addElement(doc,0,ch);
        PptDoc.addSlide(doc);
        PptStore.saveTemplate(window.localStorage, doc);
        const list=PptStore.listTemplates(window.localStorage);
        const back=PptStore.loadTemplate(window.localStorage, doc.id);
        // 2) resolve all + export
        const rm={};
        for(const sl of back.slides) for(const el of sl.elements){ rm[el.id]=await PptBindings.resolveElement(api, PptBind, el); }
        const b64=await PptExport.exportDoc({PptxGenJS:window.PptxGenJS, doc:back, resolvedMap:rm});
        PptStore.deleteTemplate(window.localStorage, doc.id);
        pptDesignerUI={ ok: !!(list.find(x=>x.id===doc.id)) && back.slides.length===2 && typeof b64==='string'&&b64.length>3000, templates:list.length, bytes:b64?b64.length:0, slides:back.slides.length };
      }catch(e){ pptDesignerUI={ok:false, err:String(e&&e.message||e)}; }
      // ---- PPT 设计器 Plan A 单元断言：numfmt / cloneElement / 9图例位 / 模板面板往返 ----
      let pptDesignerA={ok:false};
      try{
        let err;
        // 1) numfmt：单位+小数 与 千分位
        const f1=PptNumFmt.formatNum(85780,'w',1), f2=PptNumFmt.formatNum(12345,'none',0);
        if(!err && f1!=='8.6万') err='formatNum(85780,w,1)='+f1;
        if(!err && f2!=='12,345') err='formatNum(12345,none,0)='+f2;
        // 2) cloneElement：新 id + 深拷贝（改克隆不影响源）
        const srcEl=PptDoc.newElement('chart',{x:1,y:1,w:4,h:3,chart:{vtype:'column'},binding:{dataset:'psi',measure:'sellOut',filters:{line:['Slate Pro']}}});
        const clone=PptDoc.cloneElement(srcEl);
        if(!err && !(clone.id && clone.id!==srcEl.id)) err='cloneElement id 未变';
        clone.binding.filters.line.push('x');
        if(!err && srcEl.binding.filters.line.length!==1) err='cloneElement 浅拷贝(改克隆影响源)';
        // 3) chartOption 9图例位：右上 → legend.right===0
        const resA={cats:['a','b'],series:['A'],data:{A:{a:1,b:2}},total:3};
        const optA=PptChartRender.chartOption('column',{showLegend:true,legendPos:'tr'},resA,['#111','#222']);
        if(!err && !(optA.legend && optA.legend.right===0)) err='legendPos tr → legend.right!==0';
        // 4) 模板面板往返：save → list → load → delete
        const tdoc=PptDoc.newPresentation('自测PlanA模板');
        PptDoc.addElement(tdoc,0,PptDoc.newElement('text',{x:1,y:1,w:4,h:0.6,text:'PlanA'}));
        PptStore.saveTemplate(window.localStorage, tdoc);
        const tlist=PptStore.listTemplates(window.localStorage);
        if(!err && !tlist.find(x=>x.id===tdoc.id)) err='listTemplates 不含已存模板';
        const tback=PptStore.loadTemplate(window.localStorage, tdoc.id);
        if(!err && !(tback && tback.id===tdoc.id)) err='loadTemplate 取回失败';
        PptStore.deleteTemplate(window.localStorage, tdoc.id);
        if(!err && PptStore.listTemplates(window.localStorage).find(x=>x.id===tdoc.id)) err='deleteTemplate 未移除';
        pptDesignerA={ ok: !err, err };
      }catch(e){ pptDesignerA={ok:false, err:String(e&&e.message||e)}; }
      // ---- PPT 设计器 Plan B 单元断言：group/ungroup 往返 / 对齐分布 / compare(F6) / 时间切片(F5) ----
      let pptDesignerB={ok:false};
      try{
        let err;
        // 1) groupElements/ungroupElements 往返：成组打 groupId，解组清除
        const gdoc=PptDoc.newPresentation('自测PlanB模板');
        const g1=PptDoc.newElement('text',{x:1,y:1,w:3,h:0.6,text:'A'}); PptDoc.addElement(gdoc,0,g1);
        const g2=PptDoc.newElement('text',{x:5,y:1,w:3,h:0.6,text:'B'}); PptDoc.addElement(gdoc,0,g2);
        const gid=PptDoc.groupElements(gdoc,0,[g1.id,g2.id]);
        if(!err && !(gid && g1.groupId===gid && g2.groupId===gid)) err='groupElements 未给成员打 gid';
        PptDoc.ungroupElements(gdoc,0,gid);
        if(!err && (g1.groupId!=null || g2.groupId!=null)) err='ungroupElements 未清除 groupId';
        // 2) alignRects 左对齐 → 全 x 相等(=minX=0)；distributeRects 水平 → 中间均匀(≈5)
        const aligned=PptGeo.alignRects([{x:0,y:0,w:2,h:1},{x:5,y:3,w:4,h:1}],'left');
        if(!err && !(aligned[0].x===0 && aligned[1].x===0)) err='alignRects left x 不全为 0';
        const dist=PptGeo.distributeRects([{x:0,y:0,w:1,h:1},{x:2,y:0,w:1,h:1},{x:10,y:0,w:1,h:1}],'h');
        if(!err && !(Math.abs(dist[1].x-5)<1e-6)) err='distributeRects h 中间 x≈5 不成立, got='+dist[1].x;
        // 3) compare(F6 同比)：用 fake PptBind(period 桶) → A 2025 1-3 求和 300, B 2026 1-3 求和 180 → -40.0%
        const fakePptBind={
          resolveMatrix: async(api,b)=>{ const tag=(b.filters&&b.filters.tag)||'A';
            const data = tag==='A' ? {'2025-01':100,'2025-02':100,'2025-03':100,'2026-01':50} : {'2026-01':60,'2026-02':60,'2026-03':60};
            const cats=Object.keys(data); return {cats, series:[{name:'S',values:cats.map(c=>data[c])}]}; },
          resolveIdcMatrix: async()=>({cats:[],series:[]})
        };
        const cmpEl={type:'data',binding:{mode:'compare',compare:{op:'yoy',fmt:'pct',decimals:1,
          a:{measure:'sellOut',filters:{tag:'A'},timeFrom:'2025-01',timeTo:'2025-03'},
          b:{measure:'sellOut',filters:{tag:'B'},timeFrom:'2026-01',timeTo:'2026-03'}}}};
        const rCmp=await PptBindings.resolveElement({}, fakePptBind, cmpEl);
        if(!err && rCmp.text!=='-40.0%') err='compare text!=-40.0% got='+rCmp.text;
        // 4) F5 时间切片：chart catField period, 2025-02..2026-01 → cats 长度 3
        const f5El={type:'chart',binding:{catField:'period',timeFrom:'2025-02',timeTo:'2026-01',measure:'sellOut',filters:{tag:'A'}}};
        const rF5=await PptBindings.resolveElement({}, fakePptBind, f5El);
        if(!err && rF5.cats.length!==3) err='F5 cats 长度!=3 got='+rF5.cats.length;
        // 5) S4 堆积反转 + 图例正序：stackColumn stackTopFirst → series[0]=C(底)、legend.data[0]=A(顶)
        const soRes={cats:['x'],series:['A','B','C'],data:{A:{x:1},B:{x:1},C:{x:1}},total:1};
        const soOpt=PptChartRender.chartOption('stackColumn',{showLegend:true,stackTopFirst:true},soRes,['#111','#222','#333']);
        if(!err && !(soOpt.series && soOpt.series[0] && soOpt.series[0].name==='C')) err='S4 堆积 series[0]!=C got='+(soOpt.series&&soOpt.series[0]&&soOpt.series[0].name);
        if(!err && !(soOpt.legend && soOpt.legend.data && soOpt.legend.data[0]==='A')) err='S4 legend.data[0]!=A got='+(soOpt.legend&&soOpt.legend.data&&soOpt.legend.data[0]);
        // 6) S4 seriesOrder 重排：fake 返回 A,B,C；seriesOrder=['B','A'] → 前两位 B,A
        const fakeSO={ resolveMatrix: async()=>({cats:['p1'],series:[{name:'A',values:[1]},{name:'B',values:[2]},{name:'C',values:[3]}]}), resolveIdcMatrix: async()=>({cats:[],series:[]}) };
        const soEl={type:'chart',binding:{catField:'p',measure:'sellOut',seriesOrder:['B','A']}};
        const rSO=await PptBindings.resolveElement({}, fakeSO, soEl);
        const soNames=(rSO.series||[]).map(s=>s.name);
        if(!err && !(soNames[0]==='B' && soNames[1]==='A')) err='S4 seriesOrder 前两位!=B,A got='+JSON.stringify(soNames);
        // 7) C2 快照同比 + 后缀：dos(快照→末期值) agg=last, fmt=abs, suffix=天 → totalA=60(末期), text=-12 天
        const fakeDos={
          resolveMatrix: async(api,b)=>{ const tag=(b.filters&&b.filters.tag)||'A';
            const data = tag==='A' ? {'2025-05':70,'2025-06':60} : {'2026-05':55,'2026-06':48};
            const cats=Object.keys(data); return {cats, series:[{name:'S',values:cats.map(c=>data[c])}]}; },
          resolveIdcMatrix: async()=>({cats:[],series:[]})
        };
        const dosEl={type:'data',binding:{mode:'compare',compare:{fmt:'abs',decimals:0,suffix:'天',
          a:{measure:'dos',agg:'last',filters:{tag:'A'},timeFrom:'2025-06',timeTo:'2025-06'},
          b:{measure:'dos',agg:'last',filters:{tag:'B'},timeFrom:'2026-06',timeTo:'2026-06'}}}};
        const rDos=await PptBindings.resolveElement({}, fakeDos, dosEl);
        if(!err && rDos.totalA!==60) err='C2 dos totalA!=60(末期) got='+rDos.totalA;
        if(!err && rDos.text!=='-12 天') err='C2 dos+后缀 text!=-12 天 got='+rDos.text;
        pptDesignerB={ ok: !err, err };
      }catch(e){ pptDesignerB={ok:false, err:String(e&&e.message||e)}; }
      // ---- Plan C 自测：撤销/重做历史（PptHistory create/record/undo/redo/canUndo）----
      let pptDesignerC={ok:false};
      try{
        let err;
        const h=PptHistory.create(50);
        PptHistory.record(h,'A'); PptHistory.record(h,'B');
        if(!err && PptHistory.undo(h)!=='A') err='undo!=A';
        if(!err && PptHistory.redo(h)!=='B') err='redo!=B';
        if(!err && PptHistory.canUndo(h)!==true) err='canUndo!=true';
        pptDesignerC={ ok: !err, err };
      }catch(e){ pptDesignerC={ok:false, err:String(e&&e.message||e)}; }
      // ---- Plan Fin 自测：经营(财经)数据源 同比/环比预设 + pp 默认格式 + finance compare(F2) ----
      let pptDesignerFin={ok:false};
      try{
        let err;
        // 1) comparePeriodsForPreset：yoy 上年同期 a.year===2025；mom 当期 b.fromM===6(末月)
        const perYoy=PptBind.comparePeriodsForPreset('yoy',{curYear:2026,fromM:1,toM:6});
        if(!err && perYoy.a.year!==2025) err='yoy a.year!=2025 got='+perYoy.a.year;
        const perMom=PptBind.comparePeriodsForPreset('mom',{curYear:2026,fromM:1,toM:6});
        if(!err && perMom.b.fromM!==6) err='mom b.fromM!=6 got='+perMom.b.fromM;
        // 2) FIN_FMT_DEFAULT：gmr/bpAttain→pp、nsip→abs、rev→pct
        if(!err && PptBind.FIN_FMT_DEFAULT.gmr!=='pp') err='FIN_FMT_DEFAULT.gmr!=pp got='+PptBind.FIN_FMT_DEFAULT.gmr;
        if(!err && PptBind.FIN_FMT_DEFAULT.nsip!=='abs') err='FIN_FMT_DEFAULT.nsip!=abs got='+PptBind.FIN_FMT_DEFAULT.nsip;
        if(!err && PptBind.FIN_FMT_DEFAULT.rev!=='pct') err='FIN_FMT_DEFAULT.rev!=pct got='+PptBind.FIN_FMT_DEFAULT.rev;
        // 2b) CP2：贡献利润(cp) 标签存在 + measure 透传给 financeCustom.metrics=['cp'] + 视图下拉含 cp
        if(!err && PptBind.FIN_MEASURE_LABEL.cp!=='贡献利润') err='FIN_MEASURE_LABEL.cp!=贡献利润 got='+PptBind.FIN_MEASURE_LABEL.cp;
        if(!err){ const cpSeen=[]; const cpApi={ financeCustom:(p)=>{ cpSeen.push(p); return {rows:[{key:'平板',cp:120}], total:{cp:120}}; } };
          const cpT=await PptBind.resolveFinanceTotal(cpApi,{measure:'cp',basis:'forecast',filters:{}});
          if(cpT!==120) err='cp total!=120 got='+cpT;
          else if(cpSeen[cpSeen.length-1].metrics[0]!=='cp') err='cp metrics!=cp got='+cpSeen[cpSeen.length-1].metrics[0];
        }
        if(!err && typeof pdDsMeasures==='function' && !pdDsMeasures('finance').includes('cp')) err='pdDsMeasures(finance) 缺 cp';
        // 3) finance compare(F2)：用 fake PptBind(gmr 2025→0.30、2026→0.32) → 默认 pp → +2.0 pp
        const fakeFin={
          resolveFinanceTotal: async(api,b)=>{ if(b.measure==='gmr') return b.year===2025?0.30:0.32; return null; },
          comparePeriodsForPreset:PptBind.comparePeriodsForPreset,
          FIN_FMT_DEFAULT:PptBind.FIN_FMT_DEFAULT
        };
        const finEl={type:'data',binding:{mode:'compare',compare:{source:'finance',preset:'yoy',decimals:1,
          scope:{measure:'gmr',year:2026,fromM:1,toM:6,filters:{}}}}};
        const rFin=await PptBindings.resolveElement({}, fakeFin, finEl);
        if(!err && rFin.text!=='+2.0 pp') err='finance compare text!=+2.0 pp got='+rFin.text;
        pptDesignerFin={ ok: !err, err };
      }catch(e){ pptDesignerFin={ok:false, err:String(e&&e.message||e)}; }
      // ---- Plan W 自测：字号所见即所得 pdScaleFmtFonts（磅→px：×pxPerInch/72，补默认，原对象不改）----
      let pptDesignerW={ok:false};
      try{
        let err;
        const sf = pdScaleFmtFonts({catFontSize:9}, 96);
        if(!err && sf.catFontSize!==12) err='pdScaleFmtFonts 9pt@96→'+sf.catFontSize;
        if(!err && pdScaleFmtFonts({},96).labelFontSize!==12) err='label 默认9pt@96 应=12';
        const orig={catFontSize:9}; pdScaleFmtFonts(orig,96);
        if(!err && orig.valFontSize!==undefined) err='pdScaleFmtFonts 改了原对象';
        pptDesignerW={ ok: !err, err };
      }catch(e){ pptDesignerW={ok:false, err:String(e&&e.message||e)}; }
      // ---- Plan 周报 自测:PptWeekly grid 纯函数 + pdBuildWeeklyDoc 7 页模板 ----
      let pptWeekly={ok:false};
      try{
        let err;
        // 1) launchMonthSO:首个 SO>0 的月 → {month:'2026-02', so:50}
        const lm=PptWeekly.launchMonthSO(['2026-01','2026-02'],[0,50]);
        if(!err && !(lm&&lm.month==='2026-02'&&lm.so===50)) err='launchMonthSO!={2026-02,50} got='+JSON.stringify(lm);
        // 2) reportGrid:列序=[分组,累计SO,同期SO,同比]+周列(2)+[WoW,库存,DOS,全流程库存,全流程DOS,国仓+FDC] → 12;total 行首格'合计'
        const rg=PptWeekly.reportGrid({weekLabels:['W10','W11'],rows:[{key:'A',cumCur:10,cumPrev:8,yoy:0.25,weekly:[1,2],wow:1,inv:5,dos:3,flowInv:6,flowDos:4,dcfdc:1}],total:{cumCur:10,cumPrev:8,yoy:0.25,weekly:[1,2],wow:1,inv:5,dos:3,flowInv:6,flowDos:4,dcfdc:1}},'产品线');
        if(!err && rg.header.length!==12) err='reportGrid header.length!=12 got='+rg.header.length;
        if(!err && rg.rows[rg.rows.length-1][0]!=='合计') err='reportGrid 末行首格!=合计 got='+rg.rows[rg.rows.length-1][0];
        // 3) sisoGrid:GAP=预测SI−实际SI=100−70=30(SI GAP 为最后一列)
        const sg=PptWeekly.sisoGrid({fcRows:[{key:'X',sellIn:100,sellOut:120}],actRows:[{key:'X',cumCur:80,siCur:70}],nameMap:{X:'名'},version:'4月预测'});
        if(!err && sg.rows[0][sg.header.length-1]!=='30') err='sisoGrid GAP!=30 got='+sg.rows[0][sg.header.length-1];
        // 4) pdBuildWeeklyDoc:7 页;每页 elements 至少 1 个 table 或 text;S6(idx5) 含 2 个 table
        const wd=pdBuildWeeklyDoc();
        if(!err && (!wd.slides||wd.slides.length!==7)) err='pdBuildWeeklyDoc 页数!=7 got='+(wd.slides&&wd.slides.length);
        if(!err){ for(let i=0;i<wd.slides.length&&!err;i++){ const els=wd.slides[i].elements||[]; const has=els.some(e=>e.type==='table'||e.type==='text'); if(!has) err='页'+(i+1)+' 无 table/text 元素'; } }
        if(!err){ const s6tabs=(wd.slides[5].elements||[]).filter(e=>e.type==='table').length; if(s6tabs!==2) err='S6 table 数!=2 got='+s6tabs; }
        pptWeekly={ ok: !err, err };
      }catch(e){ pptWeekly={ok:false, err:String(e&&e.message||e)}; }
      // ---- 周报 v3 界面区块自测：每个章节的宿主必须渲染出实际内容(用户 2026-08-21:经营模块从界面消失) ----
      let weeklyV3={ok:false};
      let keepScope=null;
      try{
        switchView('audio');
        // E2E 必须在确定的范围下跑:dev 与打包版共享 userData,用户真实筛选残留会把断言全带偏
        // (实测:用户筛了 Slate SE,音频 sample 下整章取空,五个断言齐红)。存档 keep,块尾还原。
        if(typeof auInd!=='undefined'){
          keepScope=JSON.parse(JSON.stringify(auInd.filters));
          auInd.filters={};
        }
        renderAudio();
        if(typeof auEnsureWeeklyData==='function') await auEnsureWeeklyData();
        await new Promise(r2=>setTimeout(r2,400));
        const secLen=id=>{const el=document.getElementById(id);return el?el.innerHTML.length:-1;};
        const secTables=id=>{const el=document.getElementById(id);return el?el.querySelectorAll('table').length:0;};
        weeklyV3={
          ok:true,
          issues:secLen('auSecIssues'),
          finTables:secTables('auSecFin'), finLen:secLen('auSecFin'),
          finEmptyText:(document.getElementById('auSecFin')||{innerText:''}).innerText.slice(0,60),
          famTables:secTables('auSecFamily'), repTables:secTables('auSecRep'),
          cbCards:document.querySelectorAll('#auCbList .cb-card').length,
          npLen:secLen('auSecNewprod'),
          chips:document.querySelectorAll('#auRoot .wk-chip').length,
          chipsUnresolved:[...document.querySelectorAll('#auRoot .wk-chip-v')].filter(x=>x.textContent==='…').length,
        };
        if(weeklyV3.finTables<2) weeklyV3.ok=false;   // 经营模块必须两张表(分系列+分国家办)
        // ---- M2 控件 + M5 隐藏→导出剔除→恢复 E2E(用户 2026-08-24:表没法筛/藏/选周数;隐藏恢复不回来) ----
        const famBar=document.querySelector('#auSecFamily [data-bar]');
        weeklyV3.famCtrl=!!(famBar&&famBar.querySelector('[data-pick]')&&famBar.querySelectorAll('select').length>=2);
        let hideE2E=null;
        const card0=document.querySelector('#auCbList .cb-card');
        if(card0){
          const v0=card0.dataset.v;
          const keep=auHiddenList(v0).slice();          // E2E 结束原样放回,不动用户自己的选择
          try{
            auSetHidden(v0,[]);auRepaintCbCard(v0);
            const c1=document.querySelector('#auCbList .cb-card[data-v="'+v0+'"]');
            const rows0=c1.querySelectorAll('tbody tr').length;
            const hbtn=c1.querySelector('[data-hiderow]');
            const hidKey=hbtn?decodeURIComponent(hbtn.dataset.hiderow):'';
            if(hbtn)hbtn.click();
            const rowsA=c1.querySelectorAll('tbody tr').length;
            let exportDrops=false;
            try{ const vm=auBuildWeeklyV3Model(); const ct=(vm.sales.countries||[]).find(c=>c.name===v0);
              exportDrops=!!(ct&&ct.table&&!ct.table.rows.some(rw=>String(rw[0])===hidKey||String(rw[1]||'')===hidKey)); }catch(e2){}
            const pick=c1.querySelector('.au-pick'); if(pick)pick.click();
            const panel=c1.querySelector('.au-pick-panel');
            const btnAll=panel?[...panel.querySelectorAll('button')].filter(bt=>bt.textContent==='全部显示')[0]:null;
            if(btnAll)btnAll.click();
            const rowsB=c1.querySelectorAll('tbody tr').length;
            if(panel)panel.remove();
            hideE2E={rows0,rowsA,rowsB,panel:!!panel,exportDrops,ok:rowsA===rows0-1&&rowsB===rows0&&exportDrops};
          }finally{ auSetHidden(v0,keep);auRepaintCbCard(v0); }
        }
        weeklyV3.hideE2E=hideE2E;
        // ---- famRep 口径纯度:界面缓存必须与「带产业过滤的直查」同数——首屏竞态(探测前发查询)会在这翻车 ----
        try{
          const wk2=auW.dimWk.family;
          const chk=await api.report({groupDim:'family',weeks:wk2.weeks,fromW:wk2.fromW,toW:wk2.toW,filters:auScopeFilters()});
          weeklyV3.famPure=!!(auW.famRep&&auW.famRep.rows.length===chk.rows.length
            &&auW.famRep.total&&chk.total&&auW.famRep.total.cumCur===chk.total.cumCur);
        }catch(e2){weeklyV3.famPure=false;}
        // ---- M2 筛选面板 E2E:去勾一行表要少一行,勾回来要还原(用户 2026-08-24:筛了下面不变) ----
        try{
          const famChip=famBar?famBar.querySelector('[data-pick]'):null;
          if(famChip){
            const hk=auHKey('M2','family'); const keep2=auHiddenListK(hk).slice();
            const tb=()=>document.querySelectorAll('#auSecFamily [data-tbl] tbody tr').length;
            famChip.click();
            const pan=famBar.querySelector('.au-pick-panel');
            const cb0=pan?pan.querySelector('input'):null;
            const n0=tb();
            if(cb0){cb0.checked=false;cb0.dispatchEvent(new Event('change'));}
            const n1=tb();
            if(cb0){cb0.checked=true;cb0.dispatchEvent(new Event('change'));}
            const n2=tb();
            if(pan)pan.remove();
            auSetHiddenK(hk,keep2);
            weeklyV3.famPanelE2E={n0,n1,n2,panel:!!pan,ok:n1===n0-1&&n2===n0};
          }
        }catch(e2){weeklyV3.famPanelE2E={ok:false,err:String(e2&&e2.message||e2)};}
        // ---- 范围筛选 E2E:M4 筛掉一个系列,M2 表要缩到那个系列(用户 2026-08-24:筛 Slate SE 下面要变) ----
        try{
          const keys0=auW.famRep?auW.famRep.rows.map(rr=>rr.key):[];
          const cum0=auW.famRep&&auW.famRep.total?auW.famRep.total.cumCur:null;
          if(keys0.length>1&&typeof auInd!=='undefined'){
            const keepF=JSON.parse(JSON.stringify(auInd.filters));
            auInd.filters.family=[keys0[0]];
            auScopeChanged(); await auEnsureWeeklyData();
            const rowsF=auW.famRep?auW.famRep.rows.map(rr=>rr.key):[];
            const cumF=auW.famRep&&auW.famRep.total?auW.famRep.total.cumCur:null;
            weeklyV3.scopeE2E={rows:rowsF.length,key:rowsF[0]||'',totalShrank:cumF!=null&&cum0!=null&&cumF<cum0,
              ok:rowsF.length===1&&rowsF[0]===keys0[0]&&cumF!=null};
            auInd.filters=keepF; auScopeChanged(); await auEnsureWeeklyData();
          }
        }catch(e2){weeklyV3.scopeE2E={ok:false,err:String(e2&&e2.message||e2)};}
        if(!weeklyV3.famCtrl||!weeklyV3.famPure||(hideE2E&&!hideE2E.ok)||(weeklyV3.famPanelE2E&&!weeklyV3.famPanelE2E.ok)||(weeklyV3.scopeE2E&&!weeklyV3.scopeE2E.ok)) weeklyV3.ok=false;
      }catch(e){ weeklyV3={ok:false,err:String(e&&e.stack||e).slice(0,300)}; }
      finally{ if(keepScope&&typeof auInd!=='undefined'){ auInd.filters=keepScope; if(typeof auIndStateSave==='function')auIndStateSave(); } }
      const r='SELFTEST_RESULT '+JSON.stringify({weeklyV3,records:s1.records,dims:s1.dims.length,
        reportDOM:{rows:domRows,cols:domCols,hasTotal},repPptOk,repPptErr,
        chartTypes,colorOverride:!!(overrideApplied&&overrideApplied.color),barPptOk,barErr,
        multiSel:{picked:twoLines.length,got:msSeriesNames.length,match:JSON.stringify(twoLines.slice().sort())===JSON.stringify(msSeriesNames.slice().sort())},hasTotalSeries,
        countryBoard:{cards:cbCards,firstTableRows:cbFirstTableRows,commitOnOutsideClick:commitFired,filterNarrows:cbFilterWorks},
        custom:{series:cuSeries,points:cuPoints,sizeVaries:cuSizeVaries},siOk,finance:finData,industry:indData,designer,pptout,pptDesigner,pptDesignerUI,pptDesignerA,pptDesignerB,pptDesignerC,pptDesignerFin,pptDesignerW,pptWeekly,
        order:state.stackOrder.slice(0,3),buckets:q?q.buckets.length:0,echartsSeries:seriesCnt,
        cascadeCountry:opt,filtersDefault:state.filters,
        report:{rows:rp.rows.length,weeks:rp.weekLabels.length,curYear:rp.curYear,hasPrev:rp.hasPrev,hasFlow:rp.hasFlow,
          sample:rp.rows[0]?{k:rp.rows[0].key,cum:rp.rows[0].cumCur,dos:rp.rows[0].dos,flowInv:rp.rows[0].flowInv,dcfdc:rp.rows[0].dcfdc}:null,total:rp.total?rp.total.cumCur:0}});
      console.error(r); await api.log(r);
    }catch(e){ const m='SELFTEST_ERROR '+(e&&e.stack||e); console.error(m); try{await api.log(m);}catch(_){} }
  }
}
if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',init); else init();

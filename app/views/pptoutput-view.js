/* PPT 设计器 Phase B — Plan 2：编辑器视图骨架（Task 4）。
   三栏布局（左=元素库/字段占位 · 中=16:9 页画布 · 右=属性占位）+ 底部页缩略图条。
   当前页元素按 z 序渲染成绝对定位 DOM；点击选中（红框），点画布空白取消。
   交互（拖/缩/吸附）、元素库、属性、绑定、多页、导出、模板 由 T5-T9 续做。 */
'use strict';

// 模块状态。doc=PptDoc 文档；scale=画布显示 px/英寸；curSlide=当前页索引；selId=主选(anchor)元素 id；sel=多选 id 集合(anchor 恒在其中)；charts=echarts 实例缓存（T7 用）；dirty=自上次存档后有未保存改动（T9 切换前提示）。
const PD = { built:false, doc:null, scale:96, curSlide:0, selId:null, sel:new Set(), charts:{}, dirty:false, clip:null, lastCats:{}, lastSeriesNames:{}, hist:null, _histTimer:null, _restoring:false };

// 标脏：任何会改动 doc 的编辑路径都调一下（加/改/删元素、拖缩、z序、页操作、绑定/筛选）。
function pdMarkDirty(){ PD.dirty = true; if(!PD._restoring) pdScheduleHist(); }

// ---- 撤销/重做（U2）：history 模块 + 防抖记录 + 还原 ----
// 当前 doc 的快照（与 PptDoc.deserialize 互逆）。
function pdHistSnap(){ return PptDoc.serialize(PD.doc); }
// 建新历史并把当前 doc 作为基线（文档新建/打开/首次构建时调）。
function pdHistInit(){ PD.hist = PptHistory.create(50); PptHistory.record(PD.hist, pdHistSnap()); }
// 防抖：连续编辑（拖动/连续改数）合并为一条历史。
function pdScheduleHist(){ clearTimeout(PD._histTimer); PD._histTimer = setTimeout(pdCommitHist, 400); }
// 真正落一条历史（仅非还原期）。
function pdCommitHist(){ if(PD.hist && !PD._restoring) PptHistory.record(PD.hist, pdHistSnap()); }
// 撤销：先收尾未提交的防抖记录，再回退。
function pdUndo(){ pdCommitHist(); const s = PptHistory.undo(PD.hist); if(s!=null) pdRestoreHist(s); }
// 重做。
function pdRedo(){ const s = PptHistory.redo(PD.hist); if(s!=null) pdRestoreHist(s); }
// 还原一份快照到 doc：_restoring 守卫贯穿整段重渲，避免还原触发 markDirty 又记一步成环。
function pdRestoreHist(s){
  PD._restoring = true;
  try {
    PD.doc = PptDoc.deserialize(s);
    PD.curSlide = Math.max(0, Math.min(PD.curSlide, PD.doc.slides.length - 1));
    PD.sel = new Set(); PD.selId = null;
    pdDisposeAllCharts();
    pdRenderThumbs();
    pdLayoutPage();
    pdRenderCanvas();
    pdSelect(null);     // 清空属性面板（pdSelect(null) 内已重渲+同步多选工具）
    refreshAll();       // 按当前底数据重解析所有绑定元素
    pdSyncToolbar();
  } finally {
    PD._restoring = false;
  }
}

// 22 图类型（镜像 designer-view 的 DZ_VISUALS：{t:vtype, ic:图标, n:中文名}）。元素库与属性面板标签复用。
const PD_VISUALS = [
  {t:'column',ic:'📊',n:'簇状柱形图'},{t:'stackColumn',ic:'🏛️',n:'堆积柱形图'},{t:'stack100',ic:'💯',n:'百分比堆积柱形图'},
  {t:'bar',ic:'📶',n:'簇状条形图'},{t:'stackBar',ic:'📚',n:'堆积条形图'},{t:'stack100Bar',ic:'🧮',n:'百分比堆积条形图'},
  {t:'line',ic:'📈',n:'折线图'},{t:'area',ic:'🟥',n:'面积图'},{t:'combo',ic:'📉',n:'折线和簇状柱形图'},
  {t:'pie',ic:'🥧',n:'饼图'},{t:'donut',ic:'🍩',n:'环形图'},
  {t:'treemap',ic:'🗂️',n:'树状图'},{t:'funnel',ic:'🔻',n:'漏斗图'},{t:'gauge',ic:'🎛️',n:'仪表盘'},
  {t:'kpi',ic:'🔢',n:'KPI卡'},{t:'card',ic:'🃏',n:'卡片'},{t:'matrix',ic:'🔲',n:'矩阵'},
  {t:'table',ic:'📋',n:'表格'},{t:'scatter',ic:'⚬',n:'散点图'},{t:'bubble',ic:'🫧',n:'气泡图'},
  {t:'waterfall',ic:'🌊',n:'瀑布图'},{t:'slicer',ic:'🔘',n:'切片器'},
];
const PD_VNAME = {}; PD_VISUALS.forEach(v=>PD_VNAME[v.t]=v.n);

// 颜色规整：去掉前导 #，统一大写六位 hex（doc 内存六位无 #，与 export-pptx 一致）。
function pdHex(c){ return String(c==null?'':c).replace(/^#/,'').toUpperCase(); }
function pdHashHex(c){ return '#'+pdHex(c); }   // 给 input[type=color] 用（需带 #）

// 入口：app.js 的 switchView('pptoutput') 调用。必须是顶层函数。
function renderPptOutput(){
  const root = $('#pptRoot'); if(!root) return;
  if(!PD.doc) PD.doc = PptDoc.newPresentation('未命名');
  if(!PD.hist) pdHistInit();   // 首次构建：以当前 doc 作为历史基线（再入本视图不重置）
  if(!PD.built){ buildShell(root); PD.built=true; }
  pdRenderLibrary();
  pdLayoutPage();
  pdRenderCanvas();
  pdRenderThumbs();
  pdSyncToolbar();
  pdSyncMultiTools();
}

// 当前页对象。
function pdSlide(){ return (PD.doc && PD.doc.slides[PD.curSlide]) || null; }

// 搭三栏骨架（只建一次，再渲只更新内容）。左=元素库+字段（T6 元素库/T7 字段）；中=画布；右=属性（T6 样式/T7 绑定）；底=缩略图条（T8 填）。
function buildShell(root){
  root.innerHTML =
    '<div class="pd-wrap">'+
    '  <div class="pd-toolbar">'+
    '    <span class="pd-tb-name" id="pdDocName" title="当前模板名"></span>'+
    '    <span class="pd-tb-spacer"></span>'+
    '    <button class="pd-tb-btn" id="pdBtnNew" title="新建空白模板">新建</button>'+
    '    <button class="pd-tb-btn" id="pdBtnWeekly" title="一键生成内置产业周报模板（7页，数据自动灌入）">产业周报</button>'+
    '    <button class="pd-tb-btn" id="pdBtnOpen" title="打开已存模板">打开</button>'+
    '    <button class="pd-tb-btn" id="pdBtnSave" title="另存为命名模板">另存为</button>'+
    '    <button class="pd-tb-btn primary" id="pdBtnExport" title="导出为 PowerPoint (.pptx)">导出 PPTX</button>'+
    '  </div>'+
    '  <div class="pd-main">'+
    '    <div class="pd-left">'+
    '      <div class="pd-sec">元素库</div>'+
    '      <div id="pdLibrary"></div>'+
    '      <div class="pd-sec">字段</div>'+
    '      <div id="pdFields" style="font-size:11px;color:var(--ink3)">（T7 填充）</div>'+
    '    </div>'+
    '    <div class="pd-gutter" id="pdGutterL" title="拖动调整左栏宽度（双击复位）"></div>'+
    '    <div class="pd-canvas-wrap" id="pdCanvasWrap">'+
    '      <div class="pd-multitools hidden" id="pdMultiTools">'+
    '        <span class="pd-mt-cnt" id="pdMtCnt"></span>'+
    '        <button class="pd-mt-btn" data-mt="group" title="组合所选元素">组合</button>'+
    '        <button class="pd-mt-btn" data-mt="ungroup" title="解散所选元素中的组">解组</button>'+
    '        <span class="pd-mt-sep"></span>'+
    '        <button class="pd-mt-btn" data-mt="left" title="左对齐">⬅</button>'+
    '        <button class="pd-mt-btn" data-mt="centerH" title="水平居中">↔</button>'+
    '        <button class="pd-mt-btn" data-mt="right" title="右对齐">➡</button>'+
    '        <button class="pd-mt-btn" data-mt="top" title="顶对齐">⬆</button>'+
    '        <button class="pd-mt-btn" data-mt="centerV" title="垂直居中">↕</button>'+
    '        <button class="pd-mt-btn" data-mt="bottom" title="底对齐">⬇</button>'+
    '        <span class="pd-mt-sep"></span>'+
    '        <button class="pd-mt-btn" data-mt="distH" title="横向分布(≥3)">⇔</button>'+
    '        <button class="pd-mt-btn" data-mt="distV" title="纵向分布(≥3)">⇕</button>'+
    '      </div>'+
    '      <div class="pd-page" id="pdPage"></div>'+
    '    </div>'+
    '    <div class="pd-gutter" id="pdGutterR" title="拖动调整右栏宽度（双击复位）"></div>'+
    '    <div class="pd-right">'+
    '      <div class="pd-sec" id="pdPropHead">属性</div>'+
    '      <div id="pdProp" class="pd-prop-empty">未选中元素</div>'+
    '    </div>'+
    '  </div>'+
    '  <div class="pd-thumbs" id="pdThumbs"></div>'+
    '</div>';
  // 点画布空白（非元素）→ 框选(marquee)：拖动超过阈值画选框、松手选中相交元素；无拖动则取消选中。
  const wrap = $('#pdCanvasWrap');
  if(wrap) wrap.addEventListener('mousedown', (e)=>{ if(e.target===wrap || e.target.id==='pdPage') pdBeginMarquee(e); });
  // 键盘：方向键微调 / Delete 删除 / [ ] 调 z。只在编辑器视图激活、且焦点不在输入框时生效。
  document.addEventListener('keydown', pdOnKeyDown);
  // 工具栏：导出 + 模板管理（新建/打开/另存为）。
  const bind = (id, fn)=>{ const b=$('#'+id); if(b) b.onclick = fn; };
  bind('pdBtnNew', pdNewDoc);
  bind('pdBtnWeekly', pdLoadWeeklyDoc);
  bind('pdBtnOpen', pdOpenTplModal);
  bind('pdBtnSave', pdOpenTplModal);
  bind('pdBtnExport', pdExport);
  pdBindTplModal();
  // 多选工具条：一次性绑定（按 data-mt 分派）。
  const mt = $('#pdMultiTools');
  if(mt) mt.querySelectorAll('.pd-mt-btn').forEach(b=> b.onclick = ()=> pdMultiToolAction(b.dataset.mt));
  // 可拖拽侧栏：套用已存宽度 + 绑定左右两根分隔条。
  pdApplyPanelWidths();
  pdWireGutter('pdGutterL', 'left');
  pdWireGutter('pdGutterR', 'right');
}

// 侧栏宽度：存档键(sb.* 随存档持久化) + 默认/范围。
const PD_PANEL = {
  left:  { sel:'.pd-left',  key:'sb.pptDesigner.ui.leftW',  def:200, min:150, max:420 },
  right: { sel:'.pd-right', key:'sb.pptDesigner.ui.rightW', def:230, min:200, max:620 }
};
function pdClampW(side, w){ const c=PD_PANEL[side]; return Math.max(c.min, Math.min(c.max, Math.round(w))); }
// 启动时套用持久化宽度（无则保持 CSS 默认）。
function pdApplyPanelWidths(){
  ['left','right'].forEach(side=>{
    const c=PD_PANEL[side]; const el=$(c.sel); if(!el) return;
    let v; try{ v=parseInt(pdStorage().getItem(c.key),10); }catch(_){ v=NaN; }
    if(v && !isNaN(v)) el.style.width = pdClampW(side, v)+'px';
  });
}
// 拖拽一根分隔条调整相邻栏宽度；松手存宽；双击复位默认。
function pdWireGutter(gutterId, side){
  const g = $('#'+gutterId); if(!g) return;
  const c = PD_PANEL[side];
  g.onmousedown = (e)=>{
    e.preventDefault();
    const main = $('.pd-main'); if(!main) return;
    const rect = main.getBoundingClientRect();
    const panel = $(c.sel); if(!panel) return;
    document.body.style.cursor='col-resize'; document.body.style.userSelect='none';
    const onMove = (ev)=>{
      // 左栏宽=指针到 main 左缘；右栏宽=main 右缘到指针。
      const raw = (side==='left') ? (ev.clientX - rect.left) : (rect.right - ev.clientX);
      panel.style.width = pdClampW(side, raw)+'px';
    };
    const onUp = ()=>{
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.style.cursor=''; document.body.style.userSelect='';
      try{ pdStorage().setItem(c.key, String(parseInt(panel.style.width,10)||c.def)); }catch(_){ }
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  };
  // 双击复位默认宽度。
  g.ondblclick = ()=>{ const panel=$(c.sel); if(!panel) return; panel.style.width=c.def+'px'; try{ pdStorage().setItem(c.key, String(c.def)); }catch(_){ } };
}

// 多选工具条显隐 + 计数（≥2 个选中时显示）。
function pdSyncMultiTools(){
  const mt = $('#pdMultiTools'); if(!mt) return;
  const n = PD.sel ? PD.sel.size : 0;
  if(n>=2){ mt.classList.remove('hidden'); const c=$('#pdMtCnt'); if(c) c.textContent = '已选 '+n; }
  else mt.classList.add('hidden');
}

// 工具条动作分派：组合/解组/对齐/分布。
function pdMultiToolAction(act){
  if(!act) return;
  if(act==='group')   return pdGroupSelection();
  if(act==='ungroup') return pdUngroupSelection();
  if(act==='left'||act==='right'||act==='top'||act==='bottom'||act==='centerH'||act==='centerV') return pdAlignSelection(act);
  if(act==='distH') return pdDistributeSelection('h');
  if(act==='distV') return pdDistributeSelection('v');
}

// 组合：对当前 PD.sel 全部成员赋同一 groupId。
function pdGroupSelection(){
  if(PD.sel.size<2) return;
  PptDoc.groupElements(PD.doc, PD.curSlide, [...PD.sel]);
  pdMarkDirty();
  pdRenderCanvas();
  pdSyncMultiTools();
}

// 解组：对当前选中元素涉及的所有组逐一 ungroup。
function pdUngroupSelection(){
  const sl = pdSlide(); if(!sl) return;
  const gids = new Set();
  [...PD.sel].forEach(id=>{ const e = sl.elements.find(x=>x.id===id); if(e && e.groupId!=null) gids.add(e.groupId); });
  if(!gids.size) return;
  gids.forEach(gid=> PptDoc.ungroupElements(PD.doc, PD.curSlide, gid));
  pdMarkDirty();
  pdRenderCanvas();
  pdSyncMultiTools();
}

// 取当前 PD.sel 成员（保持插入顺序，含其英寸 rect）。
function pdSelRects(){
  const sl = pdSlide(); if(!sl) return [];
  return [...PD.sel].map(id=>{
    const e = sl.elements.find(x=>x.id===id);
    return e ? { id, x:e.x, y:e.y, w:e.w, h:e.h } : null;
  }).filter(Boolean);
}

// 对齐：用 PptGeo.alignRects 计算各成员新 x/y → 批量 updateElement(clamp) → 重渲。
function pdAlignSelection(mode){
  const rects = pdSelRects(); if(rects.length<2) return;
  const pts = PptGeo.alignRects(rects, mode);
  rects.forEach((r,i)=>{
    const p = pts[i]; if(!p) return;
    const c = PptGeo.clampRect({ x:p.x, y:p.y, w:r.w, h:r.h }, PD.doc.page);
    PptDoc.updateElement(PD.doc, PD.curSlide, r.id, { x:c.x, y:c.y });
  });
  pdMarkDirty();
  pdRenderCanvas();
  pdSyncMultiTools();
}

// 分布：≥3 个成员时用 PptGeo.distributeRects 均匀分布 → 批量 updateElement(clamp) → 重渲。
function pdDistributeSelection(axis){
  const rects = pdSelRects(); if(rects.length<3){ if(typeof toast==='function') toast('分布需至少 3 个元素','err'); return; }
  const pts = PptGeo.distributeRects(rects, axis);
  rects.forEach((r,i)=>{
    const p = pts[i]; if(!p) return;
    const c = PptGeo.clampRect({ x:p.x, y:p.y, w:r.w, h:r.h }, PD.doc.page);
    PptDoc.updateElement(PD.doc, PD.curSlide, r.id, { x:c.x, y:c.y });
  });
  pdMarkDirty();
  pdRenderCanvas();
  pdSyncMultiTools();
}

// 刷新工具栏文档名显示（带未保存“*”标记）。
function pdSyncToolbar(){
  const n = $('#pdDocName'); if(!n || !PD.doc) return;
  n.textContent = (PD.doc.name || '未命名') + (PD.dirty ? ' *' : '');
}

// ---- 元素库（左栏）：基础元素 + 22 图。点击 → 加元素并选中。 ----

// 基础（非图表）元素：type=PptDoc 元素类型；ic/n 图标与名称。
const PD_BASICS = [
  {type:'text', ic:'🅣', n:'文本框'},
  {type:'unit', ic:'㎌', n:'单位框'},
  {type:'data', ic:'＃', n:'数据框'},
  {type:'table',ic:'📋', n:'表格'},
  {type:'shape',ic:'▢', n:'形状'},
  {type:'image',ic:'🖼', n:'图片'},
];

// 渲染元素库（每次 render 调；按钮幂等重建）。
function pdRenderLibrary(){
  const lib = $('#pdLibrary'); if(!lib) return;
  let h = '<div class="pd-lib-grid">';
  PD_BASICS.forEach(b=>{ h += '<button class="pd-lib-btn" data-add-basic="'+b.type+'" title="'+b.n+'"><span class="ic">'+b.ic+'</span>'+b.n+'</button>'; });
  h += '</div>';
  h += '<div class="pd-sec" style="margin-top:12px">图表</div><div class="pd-lib-grid">';
  PD_VISUALS.forEach(v=>{ h += '<button class="pd-lib-btn" data-add-chart="'+v.t+'" title="'+v.n+'"><span class="ic">'+v.ic+'</span>'+v.n+'</button>'; });
  h += '</div>';
  lib.innerHTML = h;
  lib.querySelectorAll('[data-add-basic]').forEach(b=> b.onclick = ()=> pdAddElement(b.dataset.addBasic) );
  lib.querySelectorAll('[data-add-chart]').forEach(b=> b.onclick = ()=> pdAddElement('chart', b.dataset.addChart) );
}

// 各类型默认尺寸（英寸）。文本小、图表大。
function pdDefaultSize(type, vtype){
  if(type==='text')  return { w:3,   h:0.6 };
  if(type==='unit')  return { w:1.2, h:0.5 };
  if(type==='data')  return { w:2.4, h:1   };
  if(type==='shape') return { w:2,   h:1.2 };
  if(type==='image') return { w:3,   h:2   };
  if(type==='table') return { w:5,   h:2.5 };
  if(type==='chart'){
    if(vtype==='kpi'||vtype==='card'||vtype==='gauge') return { w:2.6, h:1.6 };
    if(vtype==='slicer') return { w:2.4, h:2.8 };
    return { w:4.8, h:3 };
  }
  return { w:3, h:1.5 };
}

// 各类型默认 props（含 style / text / chart）。
function pdDefaultProps(type, vtype){
  if(type==='text')  return { text:'文本', style:{ fontSize:18, color:'1A1A1A', align:'left' } };
  if(type==='unit')  return { text:'单位', style:{ fontSize:14, color:'8A9099', align:'center' } };
  if(type==='data')  return { style:{ unit:'', fontSize:28, color:'1A1A1A', bold:true, align:'center' } };
  if(type==='shape') return { style:{ fill:'F2F3F5', line:'CBD2DA' } };
  if(type==='image') return { src:'', style:{} };
  if(type==='table') return { style:{} };
  if(type==='chart') return { chart:{ vtype:vtype||'column', fmt:{ showLegend:true, showLabels:false, legendPos:'bottom', title:'', stackTopFirst:true } }, style:{} };
  return { style:{} };
}

// 加元素：算居中偏移的默认位置 → newElement → addElement → 选中 → 重渲。
function pdAddElement(type, vtype){
  const sl = pdSlide(); if(!sl) return;
  const pg = PD.doc.page;
  const sz = pdDefaultSize(type, vtype);
  // 居中略偏，按现有元素数错位避免叠放。
  const n = sl.elements.length;
  let x = (pg.w - sz.w)/2 + (n%5)*0.3;
  let y = (pg.h - sz.h)/2 + (n%5)*0.3;
  const rect = PptGeo.clampRect({ x:PptGeo.snap(x,0.1), y:PptGeo.snap(y,0.1), w:sz.w, h:sz.h }, pg);
  const el = PptDoc.newElement(type, Object.assign({ x:rect.x, y:rect.y, w:rect.w, h:rect.h }, pdDefaultProps(type, vtype)));
  PptDoc.addElement(PD.doc, PD.curSlide, el);
  pdMarkDirty();
  pdRenderCanvas();
  pdSelect(el.id);
}

// 当前焦点是否落在可输入控件里（避免劫持属性面板输入）。
function pdInInput(){
  const a = document.activeElement; if(!a) return false;
  const tag = (a.tagName||'').toLowerCase();
  return tag==='input' || tag==='textarea' || tag==='select' || a.isContentEditable;
}

// 当前选中元素对象（含所属页索引校验）。
function pdSelEl(){ const sl = pdSlide(); return (sl && PD.selId) ? sl.elements.find(e=>e.id===PD.selId) : null; }

// 计算画布尺寸：宽随容器（留边距），按 16:9（13.333×7.5）。PD.scale = 页显示宽 px / 13.333。
function pdLayoutPage(){
  const wrap = $('#pdCanvasWrap'), page = $('#pdPage'); if(!wrap || !page) return;
  const pg = PD.doc.page;
  const avW = Math.max(200, wrap.clientWidth - 48);   // 减去 padding（左右各 24）
  const avH = Math.max(120, wrap.clientHeight - 48);
  let wPx = avW, hPx = wPx * (pg.h/pg.w);
  if(hPx > avH){ hPx = avH; wPx = hPx * (pg.w/pg.h); }  // 高度受限时按高反推
  PD.scale = wPx / pg.w;
  page.style.width = wPx + 'px';
  page.style.height = hPx + 'px';
}

// 渲染当前页：清空页 div，按 z 升序为每个元素建绝对定位 .pd-el。
function pdRenderCanvas(){
  const page = $('#pdPage'); if(!page) return;
  pdDisposeAllCharts();   // 清整页前先销毁所有 echarts 实例（节点即将被 innerHTML='' 移除，避免泄漏/“already initialized”）
  page.innerHTML='';
  const sl = pdSlide(); if(!sl) return;
  const els = sl.elements.slice().sort((a,b)=>(a.z||0)-(b.z||0));
  els.forEach(el=> page.appendChild(pdRenderElement(el)) );
  // 节点已入 DOM（有尺寸）→ 触发已绑定元素的实时预览（异步取数、画 echarts）。
  // 统一代号：本轮所有元素共用一个 gen，确保多绑定元素都能通过竞态守卫（否则各自自增 → 仅最后一个存活）。
  const token = (PD.gen = PD.gen + 1);
  els.forEach(el=>{ if(pdHasBinding(el) || pdStaticTable(el) || pdStaticChart(el)) pdResolveAndRender(el, token); });
}

// 渲染单个元素为绝对定位 div。text/unit → 文字；data/table/chart → 占位框 + 类型/vtype。选中加 .sel。
function pdRenderElement(el){
  const s = PD.scale;
  const d = document.createElement('div');
  d.className = 'pd-el' + (PD.sel.has(el.id) ? ' sel' : '') + (el.id===PD.selId ? ' anchor' : '');
  d.dataset.id = el.id;
  d.style.left   = PptGeo.inchToPx(el.x, s) + 'px';
  d.style.top    = PptGeo.inchToPx(el.y, s) + 'px';
  d.style.width  = PptGeo.inchToPx(el.w, s) + 'px';
  d.style.height = PptGeo.inchToPx(el.h, s) + 'px';
  if(el.style && el.style.fill) d.style.background = '#'+String(el.style.fill).replace(/^#/,'');
  // 形状边框：用 box-shadow inset 画一圈（不占盒模型、不与选中红框冲突）。
  if(el.type==='shape' && el.style && el.style.line) d.style.boxShadow = 'inset 0 0 0 1px '+pdHashHex(el.style.line);
  const t = el.type;
  const st = el.style || {};
  // 文字样式（text/unit/data 共用）：字号按画布缩放、颜色、粗体、水平对齐。
  function applyTextStyle(node){
    // 字号是 PowerPoint 磅(pt=1/72in)，非 CSS px(1/96in)：显示 px = pt × (PD.scale/72)，与导出所见即所得。
    if(st.fontSize) node.style.fontSize = (st.fontSize * (PD.scale/72)) + 'px';
    // 不自动换行：与导出的 bodyPr wrap="none" 一一对应，保证预览与 PPT 折行行为一致
    node.style.whiteSpace = st.nowrap ? 'nowrap' : 'pre-wrap';
    if(node.parentNode && node.parentNode.classList) node.parentNode.classList.toggle('pd-nowrap', !!st.nowrap);
    if(d && d.classList) d.classList.toggle('pd-nowrap', !!st.nowrap);
    if(st.color)    node.style.color = pdHashHex(st.color);
    if(st.bold)     node.style.fontWeight = '700';
    const al = st.align || (t==='data'?'center':'left');
    node.style.justifyContent = al==='center' ? 'center' : (al==='right' ? 'flex-end' : 'flex-start');
    node.style.textAlign = al;
  }
  if(t==='text' || t==='unit'){
    d.textContent = (el.text!=null ? el.text : (t==='unit' ? '单位' : '文本'));
    applyTextStyle(d);
  } else if(t==='data'){
    // 占位：未绑定时显示「数据」/单位；绑定后由 pdResolveAndRender 异步填值。
    d.innerHTML = '<div class="pd-data">'+(pdHasBinding(el) ? '…' : (st.unit ? ('— '+pdEsc(st.unit)) : '数据'))+'</div>';
    applyTextStyle(d);
  } else if(t==='table'){
    d.innerHTML = pdHasBinding(el) ? '<div class="pd-tablebox">…</div>' : '<div class="pd-ph">表格</div>';
  } else if(t==='chart'){
    const vt = (el.chart && el.chart.vtype) || 'chart';
    const title = (el.chart && el.chart.fmt && el.chart.fmt.title) || '';
    const name = PD_VNAME[vt] || vt;
    // 绑定后用 echarts 在 .pd-chartbox 内预览；未绑定时显示占位。
    if(pdHasBinding(el)) d.innerHTML = '<div class="pd-chartbox"></div>';
    else d.innerHTML = '<div class="pd-ph">'+(title ? (pdEsc(title)+'<br>') : '')+'图表 · '+pdEsc(name)+'</div>';
  } else if(t==='shape'){
    // 形状已用 style.fill 上底色；这里仅留薄边/标记，无需占位文字。
    d.innerHTML = '<div class="pd-shape"></div>';
  } else if(t==='image'){
    if(el.src){ d.innerHTML = '<img class="pd-img" src="'+pdEsc(el.src)+'" alt="">'; }
    else { d.innerHTML = '<div class="pd-ph">图片</div>'; }
  } else {
    d.innerHTML = '<div class="pd-ph">'+t+'</div>';
  }
  // 选中元素加 8 向缩放手柄（角=双维，边=单维）。
  if(el.id===PD.selId){
    ['nw','n','ne','e','se','s','sw','w'].forEach(dir=>{
      const h = document.createElement('div');
      h.className = 'pd-handle '+dir;
      h.dataset.dir = dir;
      h.addEventListener('mousedown', (e)=> pdBeginResize(e, el.id, dir));
      d.appendChild(h);
    });
  }
  // 元素主体 mousedown：Shift/Ctrl/⌘+点击=切换多选(不拖)；否则选中 + 开始拖动（手柄已 stopPropagation，不会触发这里）。
  d.addEventListener('mousedown', (e)=>{
    if(e.button!==0) return;
    if(e.shiftKey || e.ctrlKey || e.metaKey){ e.stopPropagation(); e.preventDefault(); pdToggleSelect(el.id); return; }
    pdBeginDrag(e, el.id);
  });
  return d;
}

// 选中/取消选中：更新 selId(anchor)，同步多选集合 PD.sel（单选=清空后加；若元素属组则整组并入，anchor 仍为点击者），刷新画布高亮，更新右侧属性面板。
function pdSelect(id){
  PD.selId = id;
  // 单选：集合重置为 {id}（+整组成员）。取消选中：清空。
  PD.sel = new Set();
  if(id){
    PD.sel.add(id);
    pdGroupMatesOf(id).forEach(mid=> PD.sel.add(mid));
  }
  pdRenderCanvas();
  pdSyncMultiTools();
  const head = $('#pdPropHead'), prop = $('#pdProp');
  if(!head || !prop) return;
  if(!id){ head.textContent='属性'; prop.className='pd-prop-empty'; prop.textContent='未选中元素'; return; }
  // 多选（含整组自动带入 size>1）→ 批量设置面板，并清空绑定面板区。
  if(PD.sel && PD.sel.size>1){ const bind=$('#pdBind'); if(bind) bind.innerHTML=''; pdRenderBatchProp(); return; }
  const sl = pdSlide();
  const el = sl && sl.elements.find(x=>x.id===id);
  if(!el){ head.textContent='属性'; prop.className='pd-prop-empty'; prop.textContent='未选中元素'; return; }
  const vt = el.type==='chart' ? ('图表 · '+(PD_VNAME[el.chart&&el.chart.vtype]||(el.chart&&el.chart.vtype)||'')) : pdTypeLabel(el.type);
  head.textContent = '属性 · '+vt;
  prop.className=''; prop.style.cssText='';
  pdRenderProp(el);
}

// 某元素的同组其它成员 id（无 groupId → 空数组）。
function pdGroupMatesOf(id){
  const sl = pdSlide(); if(!sl) return [];
  const el = sl.elements.find(e=>e.id===id);
  if(!el || el.groupId==null) return [];
  return sl.elements.filter(e=>e.groupId===el.groupId && e.id!==id).map(e=>e.id);
}

// Shift+点击：在多选集合中加/减该元素（连同其同组成员一起加/减）；更新 anchor。空集合时取消选中。
function pdToggleSelect(id){
  if(!id) return;
  const sl = pdSlide(); if(!sl) return;
  const mates = pdGroupMatesOf(id);
  const ids = [id].concat(mates);
  const has = PD.sel.has(id);
  if(has){
    ids.forEach(i=> PD.sel.delete(i));
    // anchor 被移除 → 改指向集合中任一剩余成员（无则取消选中）。
    if(!PD.sel.has(PD.selId)){
      const next = PD.sel.size ? PD.sel.values().next().value : null;
      if(next) pdSetAnchor(next); else pdSelect(null);
      return;
    }
  } else {
    ids.forEach(i=> PD.sel.add(i));
    PD.selId = id;   // 新加入者成为 anchor
  }
  pdRenderCanvas();
  pdSyncMultiTools();
  pdRefreshPropForAnchor();
}

// 仅切换 anchor（不动集合成员）：重渲高亮 + 属性面板。
function pdSetAnchor(id){
  PD.selId = id;
  pdRenderCanvas();
  pdSyncMultiTools();
  pdRefreshPropForAnchor();
}

// 按当前 anchor 刷新右侧属性面板头部/内容（不触动 PD.sel）。
function pdRefreshPropForAnchor(){
  const head = $('#pdPropHead'), prop = $('#pdProp');
  if(!head || !prop) return;
  const id = PD.selId;
  if(!id){ head.textContent='属性'; prop.className='pd-prop-empty'; prop.textContent='未选中元素'; return; }
  // 多选 → 批量设置面板，并清空绑定面板区。
  if(PD.sel && PD.sel.size>1){ const bind=$('#pdBind'); if(bind) bind.innerHTML=''; pdRenderBatchProp(); return; }
  const sl = pdSlide();
  const el = sl && sl.elements.find(x=>x.id===id);
  if(!el){ head.textContent='属性'; prop.className='pd-prop-empty'; prop.textContent='未选中元素'; return; }
  const vt = el.type==='chart' ? ('图表 · '+(PD_VNAME[el.chart&&el.chart.vtype]||(el.chart&&el.chart.vtype)||'')) : pdTypeLabel(el.type);
  head.textContent = '属性 · '+vt;
  prop.className=''; prop.style.cssText='';
  pdRenderProp(el);
}

// 多选批量设置：按选中构成分区（文本类/图表/形状），每控件应用到该类全部选中元素。
function pdRenderBatchProp(){
  const prop=$('#pdProp'), head=$('#pdPropHead'); if(!prop) return;
  const sl=pdSlide(); if(!sl) return;
  const els=[...PD.sel].map(id=>sl.elements.find(e=>e.id===id)).filter(Boolean);
  const txts=els.filter(e=>e.type==='text'||e.type==='unit'||e.type==='data');
  const charts=els.filter(e=>e.type==='chart');
  const shapes=els.filter(e=>e.type==='shape');
  if(head) head.textContent='批量设置（'+els.length+'个）';
  prop.className='';
  const cnt=[]; if(txts.length)cnt.push('文本×'+txts.length); if(charts.length)cnt.push('图表×'+charts.length); if(shapes.length)cnt.push('形状×'+shapes.length);
  const same=(arr,get)=>{ if(!arr.length) return null; const v=get(arr[0]); return arr.every(x=>get(x)===v)?v:null; };
  let h='<div class="pd-note">'+(cnt.join('　')||'所选元素无可批量属性')+'</div>';
  if(txts.length){
    const fs=same(txts,e=>(e.style||{}).fontSize);
    h+='<div class="pd-bsec">文本</div>';
    h+=pdRow('字号','<input type="number" id="pdmFs" min="6" max="200" value="'+(fs||'')+'" placeholder="混合">');
    h+=pdRow('粗体','<input type="checkbox" id="pdmBold"'+(same(txts,e=>!!(e.style||{}).bold)?' checked':'')+'>');
    h+=pdRow('颜色','<input type="color" id="pdmColor" value="'+pdHashHex(same(txts,e=>(e.style||{}).color)||'1A1A1A')+'">');
    h+=pdRow('对齐',pdAlignHtml('pdmAlign',same(txts,e=>(e.style||{}).align)||''));
  }
  if(charts.length){
    h+='<div class="pd-bsec">图表</div>';
    h+=pdRow('图表字号','<input type="number" id="pdmCFs" min="6" max="40" placeholder="轴+数据标签">');
  }
  if(shapes.length){
    h+='<div class="pd-bsec">形状</div>';
    h+=pdRow('填充','<input type="color" id="pdmFill" value="'+pdHashHex(same(shapes,e=>(e.style||{}).fill)||'F2F3F5')+'">');
    h+=pdRow('边框','<input type="color" id="pdmLine" value="'+pdHashHex(same(shapes,e=>(e.style||{}).line)||'CBD2DA')+'">');
  }
  prop.innerHTML=h;
  const byId=id=>prop.querySelector('#'+id);
  // co=true 走合并重渲(连续输入:字号/拖色);粗体/对齐是离散点击,保持即时。
  const applyTxt=(p,co)=>txts.forEach(e=>pdPatchStyle(e,p,co?{coalesce:true}:undefined));
  const fsIn=byId('pdmFs'); if(fsIn) fsIn.oninput=()=>{ const v=parseInt(fsIn.value,10); if(!isNaN(v)) applyTxt({fontSize:v},true); };
  const bd=byId('pdmBold'); if(bd) bd.onchange=()=>applyTxt({bold:bd.checked});
  const co=byId('pdmColor'); if(co) co.oninput=()=>applyTxt({color:pdHex(co.value)},true);
  const al=byId('pdmAlign'); if(al) al.querySelectorAll('button').forEach(btn=>btn.onclick=()=>{ applyTxt({align:btn.dataset.align}); al.querySelectorAll('button').forEach(x=>x.classList.toggle('on',x===btn)); });
  const cf=byId('pdmCFs'); if(cf) cf.oninput=()=>{ const v=parseInt(cf.value,10); if(!isNaN(v)) charts.forEach(e=>pdPatchChartFmt(e,{catFontSize:v,valFontSize:v,labelFontSize:v},{coalesce:true})); };
  const fl=byId('pdmFill'); if(fl) fl.oninput=()=>shapes.forEach(e=>pdPatchStyle(e,{fill:pdHex(fl.value)},{coalesce:true}));
  const ln=byId('pdmLine'); if(ln) ln.oninput=()=>shapes.forEach(e=>pdPatchStyle(e,{line:pdHex(ln.value)},{coalesce:true}));
}

// 基础元素类型中文名（属性面板头/标签用）。
function pdTypeLabel(t){ return ({text:'文本框',unit:'单位框',data:'数据框',table:'表格',shape:'形状',image:'图片'})[t] || t; }

// ---- 属性面板（右栏）：按 type 渲染样式控件。改值 → updateElement（合并嵌套 style/chart.fmt）→ 重渲。 ----

// 合并补丁到元素的 style（浅合并，保留其它 style 字段），写回 doc 并重渲单个元素。
function pdPatchStyle(el, partial, opt){
  const style = Object.assign({}, el.style||{}, partial);
  PptDoc.updateElement(PD.doc, PD.curSlide, el.id, { style });
  pdMarkDirty();
  if(opt && opt.coalesce) pdCoalesceRerender(el.id); else pdReRenderEl(el.id);
}
// 合并补丁到 chart.fmt（保留 vtype 与其它 fmt 字段）。
function pdPatchChartFmt(el, partial, opt){
  const chart = el.chart || { vtype:'column', fmt:{} };
  const fmt = Object.assign({}, chart.fmt||{}, partial);
  PptDoc.updateElement(PD.doc, PD.curSlide, el.id, { chart: Object.assign({}, chart, { fmt }) });
  pdMarkDirty();
  if(opt && opt.coalesce) pdCoalesceRerender(el.id); else pdReRenderEl(el.id);
}
// 顶层字段补丁（如 text / src）。
function pdPatchTop(el, partial, opt){ PptDoc.updateElement(PD.doc, PD.curSlide, el.id, partial); pdMarkDirty(); if(opt && opt.coalesce) pdCoalesceRerender(el.id); else pdReRenderEl(el.id); }

// 连续输入(打字/拖颜色)的重渲合并：数据 patch 逐键即时写模型，重渲按元素 id 尾沿合并到停手后一次，
// 避免每键 替换DOM节点+重建echarts+触发绑定解析(compare元素=每键一次IPC)。
const PD_RR_TIMERS = {};
function pdCoalesceRerender(elId, ms){
  clearTimeout(PD_RR_TIMERS[elId]);
  PD_RR_TIMERS[elId] = setTimeout(()=>{ delete PD_RR_TIMERS[elId]; pdReRenderEl(elId); }, ms==null?300:ms);
}

// 重渲单个元素：用最新 doc 数据替换其 DOM 节点（保留选中/手柄）。
function pdReRenderEl(elId){
  const sl = pdSlide(); if(!sl) return;
  const el = sl.elements.find(e=>e.id===elId); if(!el) return;
  const old = pdElNode(elId); if(!old){ pdRenderCanvas(); return; }
  pdDisposeChart(elId);     // 旧节点将被替换 → 先销毁它承载的 echarts 实例
  old.replaceWith(pdRenderElement(el));
  if(pdHasBinding(el) || pdStaticTable(el) || pdStaticChart(el)) pdResolveAndRender(el);   // 新节点已入 DOM → 重新预览
}

// 行容器小工具：标签 + 控件。
function pdRow(label, ctrlHtml){ return '<div class="pd-row"><label>'+label+'</label>'+ctrlHtml+'</div>'; }

// 渲染属性面板主体（按 type 装配控件 HTML，再 wire 事件）。
function pdRenderProp(el){
  const prop = $('#pdProp'); if(!prop) return;
  const st = el.style || {};
  let h = '';
  const t = el.type;

  if(t==='text' || t==='unit'){
    h += pdRow('文字内容', '<textarea id="pdfText" rows="2">'+pdEsc(el.text!=null?el.text:'')+'</textarea>');
    h += pdRow('字号', '<input type="number" id="pdfFontSize" min="6" max="200" value="'+(st.fontSize||14)+'">');
    h += pdRow('粗体', '<input type="checkbox" id="pdfBold"'+(st.bold?' checked':'')+'>');
    h += pdRow('不自动换行', '<input type="checkbox" id="pdfNowrap"'+(st.nowrap?' checked':'')+'>');
    h += pdRow('颜色', '<input type="color" id="pdfColor" value="'+pdHashHex(st.color||'1A1A1A')+'">');
    h += pdRow('对齐', pdAlignHtml('pdfAlign', st.align||'left'));
    h += pdRow('填充', pdFillHtml('pdfFill', st.fill));
  } else if(t==='data'){
    h += pdRow('单位', pdUnitHtml('pdfUnit', st.unit||'auto'));
    h += pdRow('小数位', pdDecHtml('pdfDecimals', st.decimals));
    h += pdRow('字号', '<input type="number" id="pdfFontSize" min="6" max="200" value="'+(st.fontSize||28)+'">');
    h += pdRow('粗体', '<input type="checkbox" id="pdfBold"'+(st.bold!==false?' checked':'')+'>');
    h += pdRow('颜色', '<input type="color" id="pdfColor" value="'+pdHashHex(st.color||'1A1A1A')+'">');
    h += pdRow('对齐', pdAlignHtml('pdfAlign', st.align||'center'));
  } else if(t==='shape'){
    h += pdRow('填充', pdFillHtml('pdfFill', st.fill||'F2F3F5'));
    h += pdRow('边框', '<input type="color" id="pdfLine" value="'+pdHashHex(st.line||'CBD2DA')+'">');
  } else if(t==='image'){
    h += pdRow('图片源', '<input type="text" id="pdfSrc" value="'+pdEsc(el.src||'')+'" placeholder="data:image/... 或 URL">');
    h += '<div class="pd-note">图片可在画布拖拽/缩放定位；data URL 将随模板存档并导出。</div>';
  } else if(t==='table'){
    h += '<div class="pd-note">表格样式随主题；行/列与值由下方「数据」面板配置。</div>';
  } else if(t==='chart'){
    const fmt = (el.chart && el.chart.fmt) || {};
    h += pdRow('标题', '<input type="text" id="pdfTitle" value="'+pdEsc(fmt.title||'')+'">');
    h += pdRow('单位', pdUnitHtml('pdfUnit', fmt.unit||'auto'));
    h += pdRow('小数位', pdDecHtml('pdfDecimals', fmt.decimals));
    h += pdRow('图例位置', pdLegendPosHtml('pdfLegendPos', fmt.legendPos));
    h += '<div class="pd-note">导出位置近似（原生仅顶/底/左/右）。</div>';
    h += pdRow('显示图例', '<input type="checkbox" id="pdfShowLegend"'+(fmt.showLegend!==false?' checked':'')+'>');
    h += pdRow('数据标签', '<input type="checkbox" id="pdfShowLabels"'+(fmt.showLabels?' checked':'')+'>');
    h += pdRow('字号', pdFontsHtml('pdfFonts', fmt));
    h += pdRow('系列色', pdColorsHtml('pdfColors', pdSeriesNames(el.id), fmt, el));
  }
  // 数据绑定面板（data/table/chart）：数据源 + 字段 + 级联筛选 + 聚合。占位 div，wire 时填充。
  if(t==='data' || t==='table' || t==='chart'){
    h += '<div class="pd-sec" style="margin-top:12px">数据</div><div id="pdBind"></div>';
  }
  // 通用：位置/尺寸（英寸，0.1 步进），方便精确摆位。
  h += '<div class="pd-sec" style="margin-top:12px">位置 / 尺寸（英寸）</div>';
  h += '<div class="pd-geo">'+
    '<label>X<input type="number" id="pdfX" step="0.1" value="'+pdNum(el.x)+'"></label>'+
    '<label>Y<input type="number" id="pdfY" step="0.1" value="'+pdNum(el.y)+'"></label>'+
    '<label>宽<input type="number" id="pdfW" step="0.1" value="'+pdNum(el.w)+'"></label>'+
    '<label>高<input type="number" id="pdfH" step="0.1" value="'+pdNum(el.h)+'"></label>'+
    '</div>';
  prop.innerHTML = h;
  pdWireProp(el);
}

// 对齐三选按钮组 HTML。
function pdAlignHtml(id, cur){
  return '<div class="pd-align" id="'+id+'">'+
    ['left:⬅','center:↔','right:➡'].map(o=>{ const [v,ic]=o.split(':'); return '<button type="button" data-align="'+v+'" class="'+(cur===v?'on':'')+'" title="'+v+'">'+ic+'</button>'; }).join('')+
    '</div>';
}
// 单位下拉（A6）：auto/none/k/w/m/K/W/Million，与 numfmt.js SCALE 对齐。
const PD_UNITS = [['auto','自动'],['none','原始'],['k','千'],['w','万'],['m','百万'],['K','K(千)'],['W','W(万)'],['Million','M(百万)']];
function pdUnitHtml(id, cur){
  const c = cur || 'auto';
  return '<select id="'+id+'">'+PD_UNITS.map(o=>'<option value="'+o[0]+'"'+(c===o[0]?' selected':'')+'>'+o[1]+'</option>').join('')+'</select>';
}
// 小数位下拉（A6）：0/1/2/3。
function pdDecHtml(id, cur){
  const c = (cur==null)?1:cur;
  return '<select id="'+id+'">'+[0,1,2,3].map(d=>'<option value="'+d+'"'+(+c===d?' selected':'')+'>'+d+'</option>').join('')+'</select>';
}
// 图例位置 3×3 宫格 + 隐藏(none)（A6）。cur 兼容旧值(top/bottom/left/right)。
const PD_LEGEND_LEGACY = { bottom:'bc', top:'tc', left:'lc', right:'rc' };
const PD_LEGEND_GRID = [['tl','↖'],['tc','↑'],['tr','↗'],['lc','←'],['','·'],['rc','→'],['bl','↙'],['bc','↓'],['br','↘']];
function pdLegendPosHtml(id, cur){
  let c = cur || 'bc'; if(PD_LEGEND_LEGACY[c]) c = PD_LEGEND_LEGACY[c];
  const cells = PD_LEGEND_GRID.map(o=>{
    const v=o[0], ic=o[1];
    if(!v) return '<button type="button" class="blank" disabled>'+ic+'</button>';
    return '<button type="button" data-legpos="'+v+'" class="'+(c===v?'on':'')+'" title="'+v+'">'+ic+'</button>';
  }).join('');
  return '<div class="pd-legpos" id="'+id+'"><div class="pd-legrid">'+cells+'</div>'+
    '<button type="button" class="pd-leghide'+(c==='none'?' on':'')+'" data-legpos="none">隐藏图例</button></div>';
}
// 字号三联（A6）：catFontSize/valFontSize/labelFontSize。
function pdFontsHtml(id, fmt){
  const v = k => (fmt[k]!=null?fmt[k]:'');
  return '<div class="pd-fonts" id="'+id+'">'+
    '<label>类目<input type="number" data-fk="catFontSize" min="5" max="40" value="'+v('catFontSize')+'" placeholder="10"></label>'+
    '<label>数值<input type="number" data-fk="valFontSize" min="5" max="40" value="'+v('valFontSize')+'" placeholder="10"></label>'+
    '<label>标签<input type="number" data-fk="labelFontSize" min="5" max="40" value="'+v('labelFontSize')+'" placeholder="9"></label>'+
    '</div>';
}
// 取图表当前已解析的系列名：优先读 live echarts 实例 getOption().series 的 name（去重），
// 否则空数组（→ 提示"绑定数据后可调色"）。
function pdSeriesNames(elId){
  const ch = PD.charts[elId];
  if(!ch || ch.isDisposed()) return [];
  let opt; try{ opt = ch.getOption(); }catch(_){ return []; }
  const out = [], seen = {};
  (opt && opt.series || []).forEach(s=>{
    // 直角系/折线：name 即系列名。饼/漏斗/树：取各数据点 name。
    if(s && s.name!=null && s.name!==''){ if(!seen[s.name]){ seen[s.name]=1; out.push(String(s.name)); } }
    if(s && Array.isArray(s.data)) s.data.forEach(d=>{ const nm=d&&typeof d==='object'?d.name:null; if(nm!=null&&nm!==''&&!seen[nm]){ seen[nm]=1; out.push(String(nm)); } });
  });
  return out;
}
// 堆积型 vtype：列表顶=堆积顶层，给出小字提示。
const PD_STACK_TYPES = ['area','stackColumn','stackBar','stack100','stack100Bar'];
// 拖拽列表的"权威序"：以 binding.seriesOrder（仅保留仍存在者）打头，余下按 canonical 序补末。
// canonical = PD.lastSeriesNames（解析矩阵 top→bottom），existing = 当前可调色行（pdSeriesNames）。
function pdOrderedSeriesNames(elId, existing){
  const have = {}; existing.forEach(n=> have[n]=1);
  const canon = (PD.lastSeriesNames && PD.lastSeriesNames[elId]) || [];
  // canonical 与可调色行不一致（饼/漏斗等：行=类别 ≠ 矩阵系列）→ 不重排，直接按 existing 原序。
  const canonMatches = canon.length && canon.every(n=> have[n]) && canon.length===existing.length;
  const order = canonMatches ? canon.slice() : existing.slice();
  const el = pdSlide() && (pdSlide().elements||[]).find(e=>e.id===elId);
  const so = el && el.binding && Array.isArray(el.binding.seriesOrder) ? el.binding.seriesOrder : null;
  if(!so || !so.length) return order;
  const seen = {}; const out = [];
  so.forEach(n=>{ if(have[n] && !seen[n]){ out.push(n); seen[n]=1; } });
  order.forEach(n=>{ if(!seen[n]){ out.push(n); seen[n]=1; } });
  return out;
}
// 系列颜色列表（A6）：每系列一个取色器 + 拖拽手柄（S4，写 seriesOrder）。无系列 → 提示。
function pdColorsHtml(id, names, fmt, el){
  if(!names.length) return '<div class="pd-note" id="'+id+'">绑定数据后可调色</div>';
  const colors = (fmt && fmt.colors) || {};
  const pal = pdPalette();   // 未自定义时，色块默认显示该系列在图上的实际配色（按系列序轮转），而非一律红色
  const ordered = el ? pdOrderedSeriesNames(el.id, names) : names;
  const vtype = (el && el.chart && el.chart.vtype) || '';
  // 堆积型提示置于列表内顶部（.pd-colors 为纵向 flex，故堆在各行之上）。
  const hint = PD_STACK_TYPES.indexOf(vtype)>=0 ? '<div class="pd-chint">顶部=堆积顶层</div>' : '';
  // 默认色块按 canonical 序位轮转（= chart-render 的取色序，堆积时 names 已反转，故优先用 canonical）。
  const canon = (el && PD.lastSeriesNames && PD.lastSeriesNames[el.id]) || [];
  const palIdx = nm=>{ const ci = canon.indexOf(nm); return ci>=0 ? ci : names.indexOf(nm); };
  return '<div class="pd-colors" id="'+id+'">'+hint+ordered.map((nm)=>{
    const cur = colors[nm];
    const pi = palIdx(nm); const palc = pal[(pi<0?0:pi)%pal.length];
    return '<div class="pd-crow" draggable="true" data-crow="'+pdEsc(nm)+'">'+
      '<span class="pd-chandle" title="拖拽排序">⠹</span>'+
      '<span class="pd-cname" title="'+pdEsc(nm)+'">'+pdEsc(nm)+'</span>'+
      '<input type="color" data-cseries="'+pdEsc(nm)+'" value="'+pdHashHex(cur||palc)+'"></div>';
  }).join('')+'</div>';
}

// S4: 在 #pdfColors 行上绑定 HTML5 拖拽 → 重排 DOM → 收集新系列名序 → 写 binding.seriesOrder → 实时重渲。
// box = .pd-colors 容器；rows 为 .pd-crow[data-crow]。颜色取色器照常独立工作。
function pdWireColorDrag(el, box){
  if(!box) return;
  let dragRow = null;
  const rows = ()=> Array.prototype.slice.call(box.querySelectorAll('.pd-crow'));
  const clearOver = ()=> rows().forEach(r=> r.classList.remove('drag-over'));
  const commit = ()=>{
    const order = rows().map(r=> r.dataset.crow);
    pdPatchBinding(el, { seriesOrder: order });
    pdReRenderEl(el.id);   // 实时：堆积层 + 图例重排；颜色按系列名稳定不跳
  };
  rows().forEach(row=>{
    row.addEventListener('dragstart', e=>{ dragRow = row; row.classList.add('dragging'); try{ e.dataTransfer.effectAllowed='move'; e.dataTransfer.setData('text/plain', row.dataset.crow||''); }catch(_){ } });
    row.addEventListener('dragend', ()=>{ if(dragRow) dragRow.classList.remove('dragging'); dragRow=null; clearOver(); });
    row.addEventListener('dragover', e=>{ e.preventDefault(); try{ e.dataTransfer.dropEffect='move'; }catch(_){ } if(dragRow && row!==dragRow){ clearOver(); row.classList.add('drag-over'); } });
    row.addEventListener('dragleave', ()=> row.classList.remove('drag-over'));
    row.addEventListener('drop', e=>{ e.preventDefault(); if(!dragRow || row===dragRow){ clearOver(); return; }
      const list = rows(); const from = list.indexOf(dragRow); const to = list.indexOf(row);
      if(from<0 || to<0){ clearOver(); return; }
      // 放到目标行之前(向上拖)或之后(向下拖)，与视觉一致。
      if(from < to) box.insertBefore(dragRow, row.nextSibling); else box.insertBefore(dragRow, row);
      clearOver(); commit();
    });
  });
}

// 填充：开关 + 颜色（无填充时颜色禁用）。fill 为空=透明。
function pdFillHtml(id, fill){
  const on = !!fill;
  return '<span class="pd-fill" id="'+id+'"><input type="checkbox" data-fill-on'+(on?' checked':'')+'>'+
    '<input type="color" data-fill-color value="'+pdHashHex(fill||'FFFFFF')+'"'+(on?'':' disabled')+'></span>';
}
function pdEsc(s){ return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function pdNum(v){ return (Math.round((+v||0)*100)/100); }

// 绑定属性控件事件 → patch doc → 重渲元素。
function pdWireProp(el){
  const prop = $('#pdProp'); if(!prop) return;
  const t = el.type;
  const byId = id=>prop.querySelector('#'+id);

  // text / unit / data：文字、字号、粗体、颜色、对齐、填充
  const txt = byId('pdfText'); if(txt) txt.oninput = ()=> pdPatchTop(el, { text: txt.value }, {coalesce:true});
  const fs = byId('pdfFontSize'); if(fs) fs.oninput = ()=>{ const v=parseInt(fs.value,10); pdPatchStyle(el, { fontSize: isNaN(v)?undefined:v }, {coalesce:true}); };
  const nw = byId('pdfNowrap'); if(nw) nw.onchange = ()=>{ pdPatchStyle(el, { nowrap: !!nw.checked }); };
  const bold = byId('pdfBold'); if(bold) bold.onchange = ()=> pdPatchStyle(el, { bold: bold.checked });
  const col = byId('pdfColor'); if(col) col.oninput = ()=> pdPatchStyle(el, { color: pdHex(col.value) }, {coalesce:true});
  // 数据框：单位/小数位（enum 下拉，A6）。chart 的同名控件在 chart 分支单独 wire 到 fmt。
  if(t==='data'){
    const unit = byId('pdfUnit'); if(unit) unit.onchange = ()=> pdPatchStyle(el, { unit: unit.value });
    const dec = byId('pdfDecimals'); if(dec) dec.onchange = ()=> pdPatchStyle(el, { decimals: parseInt(dec.value,10) });
  }
  const align = byId('pdfAlign'); if(align) align.querySelectorAll('button').forEach(b=> b.onclick = ()=>{
    pdPatchStyle(el, { align: b.dataset.align });
    align.querySelectorAll('button').forEach(x=>x.classList.toggle('on', x===b));
  });

  // 填充（text/unit/shape）
  const fillBox = byId('pdfFill');
  if(fillBox){
    const onChk = fillBox.querySelector('[data-fill-on]'), colChk = fillBox.querySelector('[data-fill-color]');
    const apply = (co)=>{ const on=onChk.checked; colChk.disabled=!on; pdPatchStyle(el, { fill: on ? pdHex(colChk.value) : '' }, co?{coalesce:true}:undefined); };
    onChk.onchange = ()=>apply(false); colChk.oninput = ()=>apply(true);
  }

  // shape 边框
  const line = byId('pdfLine'); if(line) line.oninput = ()=> pdPatchStyle(el, { line: pdHex(line.value) }, {coalesce:true});

  // image 源
  const src = byId('pdfSrc'); if(src) src.oninput = ()=> pdPatchTop(el, { src: src.value }, {coalesce:true});

  // chart：标题 / 单位 / 小数 / 9图例 / 显示图例 / 数据标签 / 字号三联 / 系列色（A6）
  if(t==='chart'){
    const title = byId('pdfTitle'); if(title) title.oninput = ()=> pdPatchChartFmt(el, { title: title.value }, {coalesce:true});
    const cunit = byId('pdfUnit'); if(cunit) cunit.onchange = ()=> pdPatchChartFmt(el, { unit: cunit.value });
    const cdec = byId('pdfDecimals'); if(cdec) cdec.onchange = ()=> pdPatchChartFmt(el, { decimals: parseInt(cdec.value,10) });
    // 图例位置：3×3 宫格 + 隐藏，按钮 data-legpos → fmt.legendPos；点后切 active 态。
    const lp = byId('pdfLegendPos');
    if(lp) lp.querySelectorAll('button[data-legpos]').forEach(b=> b.onclick = ()=>{
      pdPatchChartFmt(el, { legendPos: b.dataset.legpos });
      lp.querySelectorAll('button[data-legpos]').forEach(x=> x.classList.toggle('on', x===b));
    });
    const sl = byId('pdfShowLegend'); if(sl) sl.onchange = ()=> pdPatchChartFmt(el, { showLegend: sl.checked });
    const lb = byId('pdfShowLabels'); if(lb) lb.onchange = ()=> pdPatchChartFmt(el, { showLabels: lb.checked });
    // 字号三联：每个 input data-fk → fmt[catFontSize|valFontSize|labelFontSize]（空=undefined 用默认）。
    const fonts = byId('pdfFonts');
    if(fonts) fonts.querySelectorAll('input[data-fk]').forEach(n=> n.oninput = ()=>{
      const v = parseInt(n.value,10); pdPatchChartFmt(el, { [n.dataset.fk]: (n.value===''||isNaN(v))?undefined:v }, {coalesce:true});
    });
    // 系列色：嵌套合并 fmt.colors（保留其它系列），按系列名写入。
    const colorsBox = byId('pdfColors');
    if(colorsBox){
      colorsBox.querySelectorAll('input[data-cseries]').forEach(n=> n.onchange = ()=>{
        const prev = (el.chart && el.chart.fmt && el.chart.fmt.colors) || {};
        pdPatchChartFmt(el, { colors: Object.assign({}, prev, { [n.dataset.cseries]: pdHex(n.value) }) });
      });
      pdWireColorDrag(el, colorsBox);   // S4: 拖拽重排 → seriesOrder
    }
  }

  // 数据绑定面板（data/table/chart）：装配数据源/字段/筛选控件。
  if(t==='data' || t==='table' || t==='chart') pdRenderBinding(el);

  // 通用位置/尺寸（clamp 到页内）
  const geo = ()=>{
    const x=parseFloat(byId('pdfX').value), y=parseFloat(byId('pdfY').value), w=parseFloat(byId('pdfW').value), hh=parseFloat(byId('pdfH').value);
    const cur = pdSelEl(); if(!cur) return;
    const r = PptGeo.clampRect({ x:isNaN(x)?cur.x:x, y:isNaN(y)?cur.y:y, w:isNaN(w)?cur.w:w, h:isNaN(hh)?cur.h:hh }, PD.doc.page);
    PptDoc.updateElement(PD.doc, PD.curSlide, el.id, { x:r.x, y:r.y, w:r.w, h:r.h });
    pdMarkDirty();
    pdReRenderEl(el.id);
  };
  ['pdfX','pdfY','pdfW','pdfH'].forEach(id=>{ const n=byId(id); if(n) n.onchange = geo; });
}

// ---- 画布交互：拖动 / 缩放 / 吸附 / 参考线 / z序 / 键盘 ----

// 把当前页除指定元素外的其它元素作为对齐参照（guides 只对“其它元素”计算）。
function pdOthers(elId){ const sl = pdSlide(); return sl ? sl.elements.filter(e=>e.id!==elId) : []; }

// 找到某元素当前的 DOM 节点（拖/缩时实时更新它，避免整页重渲）。
function pdElNode(elId){ const page = $('#pdPage'); return page ? page.querySelector('.pd-el[data-id="'+elId+'"]') : null; }

// 把 rect(英寸) 写进 DOM 节点（left/top/width/height）。
function pdApplyRect(node, r){
  const s = PD.scale;
  node.style.left   = PptGeo.inchToPx(r.x, s) + 'px';
  node.style.top    = PptGeo.inchToPx(r.y, s) + 'px';
  node.style.width  = PptGeo.inchToPx(r.w, s) + 'px';
  node.style.height = PptGeo.inchToPx(r.h, s) + 'px';
  // 若该元素承载 echarts 预览，缩放/拖动改尺寸后需 resize 适配容器。
  const id = node.dataset && node.dataset.id, ch = id && PD.charts[id];
  if(ch && !ch.isDisposed()) ch.resize();
}

// 按 guides 结果在页内画红色参考线（先清旧线）。x=竖线(左偏移)，y=横线(顶偏移)。单位英寸→px。
function pdDrawGuides(g){
  pdClearGuides();
  const page = $('#pdPage'); if(!page) return;
  const s = PD.scale;
  (g.x||[]).forEach(vx=>{ const d=document.createElement('div'); d.className='pd-guide v'; d.style.left=PptGeo.inchToPx(vx,s)+'px'; page.appendChild(d); });
  (g.y||[]).forEach(vy=>{ const d=document.createElement('div'); d.className='pd-guide h'; d.style.top =PptGeo.inchToPx(vy,s)+'px'; page.appendChild(d); });
}
function pdClearGuides(){ const page = $('#pdPage'); if(!page) return; page.querySelectorAll('.pd-guide').forEach(n=>n.remove()); }

// 空白处框选：在 .pd-page 内以页面相对像素画一个 .pd-marquee；松手时把与框相交(英寸)的元素选中。
// 未达阈值(几像素)的“点击”视作取消选中(沿用原 plain-click 行为)。
function pdBeginMarquee(e){
  if(e.button!==0) return;
  const page = $('#pdPage'); if(!page) return;
  const s = PD.scale;
  const rectPage = page.getBoundingClientRect();
  const startPx = { x:e.clientX - rectPage.left, y:e.clientY - rectPage.top };
  let box = null;        // marquee DOM
  let moved = false;
  let curIn = null;      // 当前框(英寸)

  function onMove(ev){
    const nx = ev.clientX - rectPage.left, ny = ev.clientY - rectPage.top;
    const dpx = Math.abs(nx-startPx.x), dpy = Math.abs(ny-startPx.y);
    if(!moved && dpx<4 && dpy<4) return;   // 阈值内不算拖动
    moved = true;
    const left = Math.min(startPx.x, nx), top = Math.min(startPx.y, ny);
    const w = Math.abs(nx-startPx.x), h = Math.abs(ny-startPx.y);
    if(!box){ box = document.createElement('div'); box.className='pd-marquee'; page.appendChild(box); }
    box.style.left = left+'px'; box.style.top = top+'px'; box.style.width = w+'px'; box.style.height = h+'px';
    curIn = { x:PptGeo.pxToInch(left,s), y:PptGeo.pxToInch(top,s), w:PptGeo.pxToInch(w,s), h:PptGeo.pxToInch(h,s) };
  }
  function onUp(){
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    if(box) box.remove();
    if(moved && curIn) pdSelectInRect(curIn);
    else pdSelect(null);   // 单纯点击空白 → 取消选中
  }
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
}

// 两个英寸 rect 是否相交（边接触不算）。
function pdRectsIntersect(a, b){
  return a.x < b.x+b.w && a.x+a.w > b.x && a.y < b.y+b.h && a.y+a.h > b.y;
}

// 选中与 marquee(英寸)相交的全部元素（连同其同组成员）。空集合→取消选中。
function pdSelectInRect(box){
  const sl = pdSlide(); if(!sl) return;
  const hit = sl.elements.filter(e=> pdRectsIntersect(box, { x:e.x, y:e.y, w:e.w, h:e.h }));
  if(!hit.length){ pdSelect(null); return; }
  const set = new Set();
  hit.forEach(e=>{ set.add(e.id); pdGroupMatesOf(e.id).forEach(m=> set.add(m)); });
  PD.sel = set;
  PD.selId = hit[0].id;   // anchor=首个命中
  pdRenderCanvas();
  pdSyncMultiTools();
  pdRefreshPropForAnchor();
}

// 拖动：mousedown 在元素主体上。先选中（重渲一次拿到带手柄的节点），再按鼠标位移平移。
// 单选→沿用智能对齐/吸附；多选→以 anchor 算 snap/吸附得到统一 (dx,dy)，整组同步平移并各自 clamp。
function pdBeginDrag(e, elId){
  if(e.button!==0) return;
  e.stopPropagation();
  e.preventDefault();
  // 点击未在当前多选集合内的元素 → 重置为单选该元素；点击集合内元素 → 保留多选，仅切 anchor。
  if(!PD.sel.has(elId)) pdSelect(elId);
  else if(PD.selId!==elId) pdSetAnchor(elId);
  const sl = pdSlide(); if(!sl) return;
  const el = sl.elements.find(x=>x.id===elId); if(!el) return;
  const node = pdElNode(elId); if(!node) return;
  const s = PD.scale;
  const startX = e.clientX, startY = e.clientY;
  const o = { x:el.x, y:el.y, w:el.w, h:el.h };
  // 多选成员（anchor 之外）的起始 rect + 节点，供同步平移。
  const movers = [...PD.sel].filter(id=>id!==elId).map(id=>{
    const m = sl.elements.find(x=>x.id===id);
    return m ? { id, o:{ x:m.x, y:m.y, w:m.w, h:m.h }, node: pdElNode(id) } : null;
  }).filter(Boolean);
  const multi = movers.length>0;
  // 智能对齐参照：单选=页内其它元素；多选=除选中集合外的元素（避免组内互相吸附）。
  const others = multi ? sl.elements.filter(e2=>!PD.sel.has(e2.id)) : pdOthers(elId);
  node.classList.add('dragging');
  movers.forEach(mv=>{ if(mv.node) mv.node.classList.add('dragging'); });
  let last = o;
  let lastMovers = movers.map(mv=>({ id:mv.id, r:mv.o }));

  function onMove(ev){
    const dxInRaw = PptGeo.pxToInch(ev.clientX - startX, s);
    const dyInRaw = PptGeo.pxToInch(ev.clientY - startY, s);
    // 1) anchor 平移 + 网格吸附
    let r = { x: PptGeo.snap(o.x + dxInRaw, 0.1), y: PptGeo.snap(o.y + dyInRaw, 0.1), w:o.w, h:o.h };
    // 2) 智能对齐：对“其它元素”算参考线 + 吸附偏移
    const g = PptGeo.guides(r, others, 0.1);
    if(g.dx) r.x += g.dx;
    if(g.dy) r.y += g.dy;
    // 3) anchor 限页内
    r = PptGeo.clampRect(r, PD.doc.page);
    last = r;
    pdApplyRect(node, r);
    pdDrawGuides(g);
    // 4) 多选：用 anchor 的净位移同步其它成员（各自 clamp）。
    if(multi){
      const ddx = r.x - o.x, ddy = r.y - o.y;
      lastMovers = movers.map(mv=>{
        const rr = PptGeo.clampRect({ x:mv.o.x+ddx, y:mv.o.y+ddy, w:mv.o.w, h:mv.o.h }, PD.doc.page);
        if(mv.node) pdApplyRect(mv.node, rr);
        return { id:mv.id, r:rr };
      });
    }
  }
  function onUp(){
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    pdClearGuides();
    if(node) node.classList.remove('dragging');
    movers.forEach(mv=>{ if(mv.node) mv.node.classList.remove('dragging'); });
    PptDoc.updateElement(PD.doc, PD.curSlide, elId, { x:last.x, y:last.y });
    if(multi) lastMovers.forEach(m=> PptDoc.updateElement(PD.doc, PD.curSlide, m.id, { x:m.r.x, y:m.r.y }));
    pdMarkDirty();
  }
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
}

// 缩放：mousedown 在手柄上。dir 决定改哪些边（n/s 改 y/h，w/e 改 x/w，角同时改两维）。
function pdBeginResize(e, elId, dir){
  if(e.button!==0) return;
  e.stopPropagation();           // 阻止冒泡到元素主体（不触发拖动）
  e.preventDefault();
  const sl = pdSlide(); if(!sl) return;
  const el = sl.elements.find(x=>x.id===elId); if(!el) return;
  const node = pdElNode(elId); if(!node) return;
  const s = PD.scale;
  const startX = e.clientX, startY = e.clientY;
  const o = { x:el.x, y:el.y, w:el.w, h:el.h };
  const r2 = o.x + o.w, b2 = o.y + o.h;   // 右边、下边（拖左/上边时保持不动）
  const others = pdOthers(elId);
  const west = dir.indexOf('w')>=0, east = dir.indexOf('e')>=0;
  const north = dir.indexOf('n')>=0, south = dir.indexOf('s')>=0;
  let last = o;

  function onMove(ev){
    const dxIn = PptGeo.pxToInch(ev.clientX - startX, s);
    const dyIn = PptGeo.pxToInch(ev.clientY - startY, s);
    let x=o.x, y=o.y, w=o.w, h=o.h;
    if(east){ w = PptGeo.snap(o.w + dxIn, 0.1); }
    if(west){ const nx = PptGeo.snap(o.x + dxIn, 0.1); x = nx; w = r2 - nx; }
    if(south){ h = PptGeo.snap(o.h + dyIn, 0.1); }
    if(north){ const ny = PptGeo.snap(o.y + dyIn, 0.1); y = ny; h = b2 - ny; }
    // 限页内（含最小 0.2 尺寸）。clampRect 以 x/y 为锚，故拖左/上边时缩到最小后右/下边会保持。
    let r = PptGeo.clampRect({ x, y, w, h }, PD.doc.page);
    // 拖左/上边到最小尺寸时，重新锚定右/下边，避免越过对边。
    if(west && r.x > r2 - 0.2) r.x = r2 - r.w;
    if(north && r.y > b2 - 0.2) r.y = b2 - r.h;
    last = r;
    pdApplyRect(node, r);
    // 缩放也显示对齐参考线（不做吸附偏移，避免与边长冲突）。
    const g = PptGeo.guides(r, others, 0.1);
    pdDrawGuides(g);
  }
  function onUp(){
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    pdClearGuides();
    PptDoc.updateElement(PD.doc, PD.curSlide, elId, { x:last.x, y:last.y, w:last.w, h:last.h });
    pdMarkDirty();
  }
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
}

// z 序重排：把当前页元素按现 z 升序排，重新赋连续 z(0..n-1)，把目标移到底/顶。
function pdReorderZ(elId, toBack){
  const sl = pdSlide(); if(!sl) return;
  const ordered = sl.elements.slice().sort((a,b)=>(a.z||0)-(b.z||0));
  const i = ordered.findIndex(e=>e.id===elId); if(i<0) return;
  const [me] = ordered.splice(i,1);
  if(toBack) ordered.unshift(me); else ordered.push(me);
  ordered.forEach((e,idx)=> e.z = idx);
  pdMarkDirty();
  pdRenderCanvas();
}

// 键盘处理：仅在编辑器视图、焦点不在输入框时生效。撤销/重做(Ctrl+Z/Y)无需选中即可触发；微调/删除/z 序需有选中。
function pdOnKeyDown(e){
  const view = $('#view-pptoutput');
  if(view && !view.classList.contains('active')) return;   // 不在本视图不响应
  if(pdInInput()) return;                                   // 输入框内不劫持
  // 复制/粘贴/复制并粘贴：Ctrl+C / Ctrl+V / Ctrl+D。仅编辑器激活 + 非输入框时生效（上面已守卫）。
  // 多选时整组复制（克隆全部成员，同组者赋新 groupId）；单选保持原逻辑（单元素剪贴）。
  if(e.ctrlKey || e.metaKey){
    const kk = (e.key||'').toLowerCase();
    // 撤销/重做：Ctrl/⌘+Z 撤销；Ctrl/⌘+Y 或 Ctrl/⌘+Shift+Z 重做。（无需选中即可生效。）
    if(!e.shiftKey && kk==='z'){ pdUndo(); e.preventDefault(); return; }
    if(kk==='y' || (e.shiftKey && kk==='z')){ pdRedo(); e.preventDefault(); return; }
    if(kk==='c'){
      if(PD.sel.size>1){ PD.clip = pdSnapshotSelection(); e.preventDefault(); }
      else { const s=pdSelEl(); if(s){ PD.clip = PptDoc.cloneElement(s); e.preventDefault(); } }
      return;
    }
    if(kk==='v'){ if(PD.clip){ pdPasteClip(PD.clip); e.preventDefault(); } return; }
    if(kk==='d'){
      if(PD.sel.size>1){ pdPasteClip(pdSnapshotSelection()); e.preventDefault(); }
      else { const s=pdSelEl(); if(s){ pdPasteElement(s); e.preventDefault(); } }
      return;
    }
  }
  if(!PD.selId) return;
  const el = pdSelEl(); if(!el) return;
  const k = e.key;
  if(k==='ArrowLeft' || k==='ArrowRight' || k==='ArrowUp' || k==='ArrowDown'){
    e.preventDefault();
    let dx=0, dy=0;
    if(k==='ArrowLeft')  dx = -0.1;
    if(k==='ArrowRight') dx =  0.1;
    if(k==='ArrowUp')    dy = -0.1;
    if(k==='ArrowDown')  dy =  0.1;
    const sl = pdSlide();
    [...PD.sel].forEach(id=>{
      const m = sl && sl.elements.find(x=>x.id===id); if(!m) return;
      const r = PptGeo.clampRect({ x:PptGeo.snap(m.x+dx,0.1), y:PptGeo.snap(m.y+dy,0.1), w:m.w, h:m.h }, PD.doc.page);
      PptDoc.updateElement(PD.doc, PD.curSlide, id, { x:r.x, y:r.y });
    });
    pdMarkDirty();
    pdRenderCanvas();
  } else if(k==='Delete' || k==='Backspace'){
    e.preventDefault();
    [...PD.sel].forEach(id=> PptDoc.removeElement(PD.doc, PD.curSlide, id));
    pdMarkDirty();
    pdSelect(null);   // 清选中并重渲（pdSelect 内已 pdRenderCanvas）
  } else if(k==='['){
    e.preventDefault();
    pdReorderZ(PD.selId, true);   // 置底
  } else if(k===']'){
    e.preventDefault();
    pdReorderZ(PD.selId, false);  // 置顶
  }
}

// 粘贴一个元素：深克隆（cloneElement 给新 id，保留绑定/筛选/样式/chart.fmt/颜色）→ 右下偏移 0.2 → clamp 进页 → addElement → 标脏 → 选中重渲。
function pdPasteElement(src){
  const sl = pdSlide(); if(!sl || !src) return;
  const n = PptDoc.cloneElement(src);
  n.x = (n.x||0) + 0.2; n.y = (n.y||0) + 0.2;
  const r = PptGeo.clampRect({ x:n.x, y:n.y, w:n.w, h:n.h }, PD.doc.page);
  n.x = r.x; n.y = r.y; n.w = r.w; n.h = r.h;
  PptDoc.addElement(PD.doc, PD.curSlide, n);
  pdMarkDirty();
  pdRenderCanvas();
  pdSelect(n.id);
}

// 多选快照：深拷贝当前 PD.sel 各成员（保留 groupId 以便粘贴时重映射成同一新组）。
function pdSnapshotSelection(){
  const sl = pdSlide(); if(!sl) return null;
  const els = [...PD.sel].map(id=> sl.elements.find(e=>e.id===id)).filter(Boolean)
    .map(e=> JSON.parse(JSON.stringify(e)));
  return els.length ? { multi:true, els } : null;
}

// 统一粘贴：clip 为多选快照 → 克隆全部成员、整体右下偏移、同组重映射新 groupId、批量加入并多选；否则单元素粘贴。
function pdPasteClip(clip){
  if(!clip) return;
  if(!clip.multi){ pdPasteElement(clip); return; }
  const sl = pdSlide(); if(!sl || !clip.els || !clip.els.length) return;
  const gidMap = {};   // 旧 groupId → 新 groupId（保持组关系）
  const newIds = [];
  clip.els.forEach(src=>{
    const n = PptDoc.cloneElement(src);   // 新 id + 深拷贝
    n.x = (n.x||0) + 0.2; n.y = (n.y||0) + 0.2;
    const r = PptGeo.clampRect({ x:n.x, y:n.y, w:n.w, h:n.h }, PD.doc.page);
    n.x = r.x; n.y = r.y; n.w = r.w; n.h = r.h;
    if(n.groupId!=null){ if(!gidMap[n.groupId]) gidMap[n.groupId] = 'g'+Date.now().toString(36)+Math.floor(Math.random()*1e4); n.groupId = gidMap[n.groupId]; }
    PptDoc.addElement(PD.doc, PD.curSlide, n);
    newIds.push(n.id);
  });
  pdMarkDirty();
  // 多选新粘贴的元素（anchor=首个）。
  PD.selId = newIds[0] || null;
  PD.sel = new Set(newIds);
  pdRenderCanvas();
  pdSyncMultiTools();
  pdRefreshPropForAnchor();
}

// ============================================================
//  多页：底部缩略图条（增 / 删 / 排序 / 切换）（Task 8）
// ============================================================

// 切到某页：先销毁当前页所有 echarts（pdRenderCanvas 内已做），清选中（各页元素独立），重渲画布+缩略图。
function pdGotoSlide(idx){
  const n = (PD.doc && PD.doc.slides.length) || 0; if(!n) return;
  idx = Math.max(0, Math.min(idx, n-1));       // clamp 到有效范围
  if(idx===PD.curSlide){ pdRenderThumbs(); return; }
  PD.curSlide = idx;
  // 换页清选中（选中 id 属于旧页）：pdSelect(null) 会先 pdRenderCanvas()（内部先 pdDisposeAllCharts() 防泄漏，
  // 再重解析新页绑定元素），并把右侧属性面板复位到“未选中”态。
  pdSelect(null);
  pdRenderThumbs();
}

// 加页：addSlide → 切到新页（末页）。
function pdAddSlide(){
  if(!PD.doc) return;
  PptDoc.addSlide(PD.doc);
  pdMarkDirty();
  pdGotoSlide(PD.doc.slides.length - 1);
}

// 删页：removeSlide（保证 ≥1）；删后 curSlide clamp，并重渲。
function pdDeleteSlide(idx){
  if(!PD.doc) return;
  if(PD.doc.slides.length <= 1) return;         // ≥1 页守卫
  PptDoc.removeSlide(PD.doc, idx);              // CRUD（内部亦保证 ≥1）
  pdMarkDirty();
  // curSlide 修正：删的是当前页之前→前移一格；删的是当前页或之后→clamp 到新末页。
  let cur = PD.curSlide;
  if(idx < cur) cur = cur - 1;
  cur = Math.max(0, Math.min(cur, PD.doc.slides.length - 1));
  PD.curSlide = -1;                             // 置无效值，强制 pdGotoSlide 走完整重渲
  pdGotoSlide(cur);
}

// 排序：把 from 页移到 to 位（moveSlide）；保持 curSlide 指向同一逻辑页。
function pdMoveSlide(from, to){
  if(!PD.doc) return;
  const n = PD.doc.slides.length;
  if(from===to || from<0 || from>=n || to<0 || to>=n) return;
  // 记住当前页对象（用引用追踪，移动后重新定位其新索引，保证“同一逻辑页”）。
  const curSlideObj = PD.doc.slides[PD.curSlide];
  PptDoc.moveSlide(PD.doc, from, to);
  pdMarkDirty();
  let newCur = PD.doc.slides.indexOf(curSlideObj);
  if(newCur < 0) newCur = Math.max(0, Math.min(PD.curSlide, PD.doc.slides.length - 1));
  PD.curSlide = newCur;
  pdRenderThumbs();                             // 当前页内容未变，仅缩略图顺序/高亮变 → 不必重渲画布
}

// 渲染底部缩略图条：每页一个纯框（页码 + 元素数）；当前页高亮；末尾 ＋ 加页按钮。支持点击切换、按钮删页、拖动排序。
function pdRenderThumbs(){
  const strip = $('#pdThumbs'); if(!strip || !PD.doc) return;
  strip.innerHTML='';
  const slides = PD.doc.slides || [];
  slides.forEach((sl, i)=>{
    const t = document.createElement('div');
    t.className = 'pd-thumb' + (i===PD.curSlide ? ' cur' : '');
    t.dataset.idx = i;
    t.title = '第 '+(i+1)+' 页（'+(sl.elements?sl.elements.length:0)+' 元素）';
    const cnt = (sl.elements && sl.elements.length) || 0;
    t.innerHTML =
      '<span class="pd-thumb-cnt">'+(cnt? (cnt+' 元素') : '空页')+'</span>'+
      '<span class="pd-thumb-no">'+(i+1)+'</span>'+
      (slides.length>1 ? '<button class="pd-thumb-del" title="删除此页">×</button>' : '');
    // 点击切换当前页（点删除按钮除外）。
    t.addEventListener('mousedown', (e)=>{
      if(e.target.classList.contains('pd-thumb-del')) return;
      pdGotoSlide(i);
    });
    // 删除：阻断冒泡避免触发切换。
    const del = t.querySelector('.pd-thumb-del');
    if(del) del.addEventListener('click', (e)=>{ e.stopPropagation(); pdDeleteSlide(i); });
    // 拖动排序（HTML5 DnD）。
    t.draggable = true;
    t.addEventListener('dragstart', (e)=>{
      PD.thumbDrag = i; t.classList.add('dragging');
      if(e.dataTransfer){ e.dataTransfer.effectAllowed='move'; try{ e.dataTransfer.setData('text/plain', String(i)); }catch(_){ } }
    });
    t.addEventListener('dragend', ()=>{ t.classList.remove('dragging'); PD.thumbDrag = null; pdRenderThumbs(); });
    t.addEventListener('dragover', (e)=>{ e.preventDefault(); if(e.dataTransfer) e.dataTransfer.dropEffect='move'; t.classList.add('dragover'); });
    t.addEventListener('dragleave', ()=>{ t.classList.remove('dragover'); });
    t.addEventListener('drop', (e)=>{
      e.preventDefault(); t.classList.remove('dragover');
      const from = (PD.thumbDrag!=null) ? PD.thumbDrag : parseInt(e.dataTransfer && e.dataTransfer.getData('text/plain'), 10);
      const to = i;
      if(from!=null && !isNaN(from)) pdMoveSlide(from, to);
    });
    strip.appendChild(t);
  });
  // ＋ 加页按钮。
  const add = document.createElement('button');
  add.className = 'pd-thumb-add'; add.title = '新增页'; add.textContent = '＋';
  add.addEventListener('click', pdAddSlide);
  strip.appendChild(add);
}

// ============================================================
//  数据绑定面板（拖字段+级联筛选）+ 实时预览 + 全局刷新（Task 7）
// ============================================================

// 经营(财经)度量/维度中文标签（F3：经营数据源）。measure 8 个 + dim 5 个。
const PD_FIN_MEASURE_LABEL = { rev:'净销售收入', gm:'销毛额', cp:'贡献利润', gmr:'销毛率', nsip:'NSIP', sellIn:'Sell-in量', sellOut:'Sell-out量', bpAttain:'BP达成率', fcAttain:'预测达成率' };
const PD_FIN_DIM_LABEL = { rep:'国家办', lv1:'产业', lv2:'品类', lv3:'产品系列', lv4:'产品' };

// 数据源对应的维度/度量字段列表与标签（PSI 用 state.dims+DZ_MEASURES，IDC 用 state.idcMeta.dims+IDC_MEASURES，finance 固定集合）。
function pdDsDims(ds){
  if(ds==='finance') return ['rep','lv1','lv2','lv3','lv4'];
  if(ds==='idc') return (typeof state!=='undefined' && state.idcMeta && state.idcMeta.dims) || [];
  // PSI：period（周期）+ 业务维度
  return ['period'].concat((typeof state!=='undefined' && state.dims) || []);
}
function pdDsMeasures(ds){
  if(ds==='finance') return ['rev','gm','gmr','cp','nsip','sellIn','sellOut','bpAttain','fcAttain'];
  if(ds==='idc') return (typeof IDC_MEASURES!=='undefined') ? IDC_MEASURES : ['units','value','asp'];
  return (typeof DZ_MEASURES!=='undefined') ? DZ_MEASURES : ['sellOut','sellIn','inv','dos'];
}
// 字段中文标签（维度/度量通用）。沿用 designer-view 的 dzFieldLabel 逻辑，无该函数时本地兜底。
function pdFieldLabel(field, ds){
  if(ds==='finance') return PD_FIN_MEASURE_LABEL[field] || PD_FIN_DIM_LABEL[field] || field;
  if(typeof dzFieldLabel==='function') return dzFieldLabel(field, ds);
  if(ds==='idc') return (typeof IDC_LABEL!=='undefined' && IDC_LABEL[field]) || field;
  if(field==='period') return '周期';
  return (typeof DIM_LABEL!=='undefined' && DIM_LABEL[field]) || (typeof METRIC_LABEL!=='undefined' && METRIC_LABEL[field]) || field;
}
// 度量默认聚合：沿用 designer-view 的 dzDefAgg（FLOW 类求和、其余取最新；IDC asp 用 asp）。finance 不用 agg。
function pdDefAgg(field, ds){
  if(ds==='finance') return '';
  if(typeof dzDefAgg==='function') return dzDefAgg(field, ds);
  if(ds==='idc') return field==='asp' ? 'asp' : 'sum';
  return (field==='sellOut'||field==='sellIn') ? 'sum' : 'last';
}
// 时间字段（PSI period / IDC quarter/year）→ 显示时间粒度选项。finance 无时间类别轴（年/月区间用专属控件）。
function pdIsTimeField(field, ds){ return ds==='idc' ? (field==='quarter'||field==='year') : (ds==='finance' ? false : (field==='period')); }
// chart/table 才需要类别/图例；data 仅需度量（单值聚合，不分类）。
function pdNeedsCat(el){ return el.type==='chart' || el.type==='table'; }
function pdNeedsLegend(el){ return el.type==='chart' || el.type==='table'; }

// ---- F3 经营(财经)数据源：选择器选项 / 绑定面板 / 筛选项缓存 / 渲染格式 ----

// 是否已锚定经营分析数据（finMeta 存在 → 经营源可选）。
function pdHasFin(){ return !!(typeof state!=='undefined' && state.finMeta); }
// 数据源 <select> 选项 HTML：PSI/IDC + 经营(财经)；finMeta 缺失则经营项 disabled。cur 命中 selected。
// forTable=true（table 元素）：追加周报三 grid 数据源 报表(report)/SISO达成(siso)/路标(roadmap)。
function pdDsOptsHtml(cur, forTable){
  let opts = [['psi','经营 PSI'],['idc','IDC 市场'],['finance','经营(财经)']];
  if(forTable) opts = opts.concat([['report','报表'],['siso','SISO达成'],['roadmap','路标']]);
  return opts.map(o=>{
    const dis = (o[0]==='finance' && !pdHasFin()) ? ' disabled' : '';
    return '<option value="'+o[0]+'"'+(cur===o[0]?' selected':'')+dis+'>'+o[1]+'</option>';
  }).join('');
}
// 经营绑定默认补齐：basis=actual、year=最新实际年、month 区间留空（解析器兜底）。在切到 finance / 渲染面板时调用。
function pdFinDefaults(b){
  const fm = (typeof state!=='undefined' && state.finMeta) || {};
  const ay = (fm.actualYears && fm.actualYears.length) ? fm.actualYears : (fm.years || []);
  const patch = {};
  if(!b.basis) patch.basis = 'actual';
  if(b.year==null && ay.length) patch.year = ay[ay.length-1];
  if(!b.measure) patch.measure = 'rev';
  return patch;
}
// 经营筛选项缓存：PD.finOpts[field] = string[]（该维全部取值，非级联）。
function pdFinFetchOpts(field, cb){
  PD.finOpts = PD.finOpts || {};
  if(PD.finOpts[field]){ cb(PD.finOpts[field]); return; }
  Promise.resolve(api.financeCustom({ rowDim: field, metrics:['rev'], basis:'actual' }))
    .then(r=>{ const keys = ((r && r.rows) || []).map(x=>x.key).filter(k=>k!=null && k!==''); PD.finOpts[field] = keys; cb(keys); })
    .catch(()=>{ cb([]); });
}
// 经营 data 值格式化：gmr/bpAttain/fcAttain→百分比、nsip→$数值、金额/数量→现有 pdFmtVal。
function pdFmtFinVal(val, measure, st){
  if(val==null) return '—';
  const dec = (st && st.decimals!=null) ? st.decimals : 1;
  if(measure==='gmr' || measure==='bpAttain' || measure==='fcAttain') return (val*100).toFixed(dec)+'%';
  if(measure==='nsip') return '$'+pdFmtVal(val, st||{});
  return pdFmtVal(val, st||{});
}
// 经营绑定面板 HTML（口径/年/月区间/版本/度量chips/类别维度chips/筛选slot）。data 不显示类别维度。
function pdFinBindingHtml(el, b){
  const fm = (typeof state!=='undefined' && state.finMeta) || {};
  const ay = (fm.actualYears && fm.actualYears.length) ? fm.actualYears : (fm.years || []);
  const vers = fm.versions || [], bpv = fm.bpVersions || [];
  const basis = b.basis || 'actual';
  const measures = pdDsMeasures('finance'), dims = pdDsDims('finance');
  let h = '';
  // 口径
  h += pdRow('口径', '<select id="pdbFinBasis">'+
    [['actual','实际'],['forecast','预测'],['bp','BP']].map(o=>'<option value="'+o[0]+'"'+(basis===o[0]?' selected':'')+'>'+o[1]+'</option>').join('')+'</select>');
  // 年
  h += pdRow('年', '<select id="pdbFinYear">'+
    ay.map(y=>'<option value="'+y+'"'+(String(b.year)===String(y)?' selected':'')+'>'+y+'</option>').join('')+'</select>');
  // 月区间 从/到（到含「最新」=undefined）
  const moOpt = (cur, withLatest)=>{
    let s = withLatest ? ('<option value=""'+((cur==null)?' selected':'')+'>最新</option>') : '';
    for(let m=1;m<=12;m++) s += '<option value="'+m+'"'+(String(cur)===String(m)?' selected':'')+'>'+m+' 月</option>';
    return s;
  };
  h += pdRow('月 从', '<select id="pdbFinFromM">'+moOpt(b.fromM, false)+'</select>');
  h += pdRow('月 到', '<select id="pdbFinToM">'+moOpt(b.toM, true)+'</select>');
  // 工作底稿版本（预测/BP 用）
  if(vers.length) h += pdRow('工作底稿版本', '<select id="pdbFinVer">'+
    vers.map(v=>'<option value="'+pdEscAttr(v)+'"'+(b.version===v?' selected':'')+'>'+pdEscHtml(v)+'</option>').join('')+'</select>');
  // BP 版本（仅 basis=bp）
  if(basis==='bp' && bpv.length) h += pdRow('BP 版本', '<select id="pdbFinBpVer">'+
    bpv.map(v=>'<option value="'+pdEscAttr(v)+'"'+(b.bpVersion===v?' selected':'')+'>'+pdEscHtml(v)+'</option>').join('')+'</select>');
  // 度量 chips（单选）
  h += '<div class="pd-bsec">度量（指标）</div><div class="pd-chips" id="pdbMeas">'+
    measures.map(m=>'<button type="button" class="pd-chip mea'+(b.measure===m?' on':'')+'" data-field="'+m+'">'+pdEsc(pdFieldLabel(m,'finance'))+'</button>').join('')+'</div>';
  // 类别维度 chips（chart/table）
  if(pdNeedsCat(el)){
    h += '<div class="pd-bsec">类别（维度）</div><div class="pd-chips" id="pdbCat">'+
      dims.map(d=>'<button type="button" class="pd-chip dim'+(b.catField===d?' on':'')+'" data-field="'+d+'">'+pdEsc(pdFieldLabel(d,'finance'))+'</button>').join('')+'</div>';
  }
  // 筛选（国家办 + LV1-4，非级联，取值来自 financeCustom 缓存）
  h += '<div class="pd-bsec">筛选</div><div id="pdbFilters"></div>';
  return h;
}
// 经营筛选区渲染：每维一个 makeMultiSelect，options 取自 PD.finOpts 缓存（非级联）。
function pdRenderFinFilters(el){
  const box = $('#pdbFilters'); if(!box) return;
  box.innerHTML = '';
  const b = pdEnsureBinding(el);
  const dims = pdDsDims('finance');
  dims.forEach(field=>{
    const slot = document.createElement('div'); slot.className='pd-fslot';
    box.appendChild(slot);
    const cur = (b.filters && b.filters[field]) || [];
    pdFinFetchOpts(field, (opts)=>{
      if(!slot.isConnected) return;
      const ms = makeMultiSelect(pdFieldLabel(field,'finance'), opts||[], cur, {
        onCommit: (sel)=>{ pdSetFilter(el, field, sel); pdReRenderEl(el.id); }
      });
      slot.innerHTML=''; slot.appendChild(ms);
    });
  });
}
// 经营绑定面板事件 wire（口径/年/月/版本/度量/类别/筛选）。measure/catField/basis 变更需重渲面板。
function pdWireFinBinding(el){
  const host = $('#pdBind'); if(!host) return;
  const byId = id=>host.querySelector('#'+id);
  const b = pdEnsureBinding(el);
  const basisSel = byId('pdbFinBasis');
  if(basisSel) basisSel.onchange = ()=>{ pdPatchBinding(el, { basis: basisSel.value }); pdRenderBinding(el); pdReRenderEl(el.id); };
  const yearSel = byId('pdbFinYear');
  if(yearSel) yearSel.onchange = ()=>{ pdPatchBinding(el, { year: parseInt(yearSel.value,10) }); pdReRenderEl(el.id); };
  const fromSel = byId('pdbFinFromM');
  if(fromSel) fromSel.onchange = ()=>{ pdPatchBinding(el, { fromM: fromSel.value ? parseInt(fromSel.value,10) : undefined }); pdReRenderEl(el.id); };
  const toSel = byId('pdbFinToM');
  if(toSel) toSel.onchange = ()=>{ pdPatchBinding(el, { toM: toSel.value ? parseInt(toSel.value,10) : undefined }); pdReRenderEl(el.id); };
  const verSel = byId('pdbFinVer');
  if(verSel) verSel.onchange = ()=>{ pdPatchBinding(el, { version: verSel.value }); pdReRenderEl(el.id); };
  const bpVerSel = byId('pdbFinBpVer');
  if(bpVerSel) bpVerSel.onchange = ()=>{ pdPatchBinding(el, { bpVersion: bpVerSel.value }); pdReRenderEl(el.id); };
  // 度量 chips（单选）→ 重渲面板（measure 变更影响渲染格式）
  const meas = byId('pdbMeas');
  if(meas) meas.querySelectorAll('.pd-chip').forEach(c=> c.onclick = ()=>{
    pdPatchBinding(el, { measure: c.dataset.field }); pdRenderBinding(el); pdReRenderEl(el.id);
  });
  // 类别维度 chips（单选）
  const cat = byId('pdbCat');
  if(cat) cat.querySelectorAll('.pd-chip').forEach(c=> c.onclick = ()=>{
    pdPatchBinding(el, { catField: c.dataset.field }); pdRenderBinding(el); pdReRenderEl(el.id);
  });
  pdRenderFinFilters(el);
}

// ---- WK7 周报三 grid 数据源（report/siso/roadmap）：最小绑定面板 HTML + wire + report 筛选 ----

// report 分组维度：产品线/产品系列/国家办/国家/产品型号（值 = engine report() 的 groupDim）。
const PD_WK_REPORT_GROUPS = [['line','产品线'],['family','产品系列'],['rep','国家办'],['country','国家'],['model','产品型号']];
// roadmap 表类型：上市计划/新品作战/样机/SKU明细/配件。
const PD_WK_ROADMAP_TABLES = [['launch','上市计划'],['battle','新品作战'],['samples','样机'],['sku','SKU明细'],['acc','配件']];

// 周报绑定面板 HTML（按 dataset 分派）。report=分组维度+周数+PSI级联筛选；siso=版本+年+提示；roadmap=表类型+提示。
function pdWeeklyBindingHtml(el, b, ds){
  let h = '';
  if(ds==='report'){
    const gd = b.groupDim || 'line';
    h += pdRow('分组维度', '<select id="pdbWkGroup">'+
      PD_WK_REPORT_GROUPS.map(o=>'<option value="'+o[0]+'"'+(gd===o[0]?' selected':'')+'>'+o[1]+'</option>').join('')+'</select>');
    const wk = (b.weeks==null) ? 9 : b.weeks;
    h += pdRow('周数', '<input type="number" id="pdbWkWeeks" min="1" max="52" value="'+wk+'">');
    // 筛选 = PSI 级联多选（report 筛选维度即 PSI 维度）。
    h += '<div class="pd-bsec">筛选（级联）</div><div id="pdbFilters"></div>';
    return h;
  }
  if(ds==='siso'){
    const fm = (typeof state!=='undefined' && state.finMeta) || {};
    const vers = fm.versions || [];
    const ay = (fm.actualYears && fm.actualYears.length) ? fm.actualYears : (fm.years || []);
    h += pdRow('版本', '<select id="pdbWkVer">'+
      (vers.length ? vers.map(v=>'<option value="'+pdEscAttr(v)+'"'+(b.version===v?' selected':'')+'>'+pdEscHtml(v)+'</option>').join('') : '<option value="">（无预测版本）</option>')+'</select>');
    h += pdRow('年', '<select id="pdbWkYear">'+
      (ay.length ? ay.map(y=>'<option value="'+y+'"'+(String(b.year)===String(y)?' selected':'')+'>'+y+'</option>').join('') : '<option value="">（无年份）</option>')+'</select>');
    h += '<div class="pd-note">预测按产品型号，需预测表含产品型号列。</div>';
    return h;
  }
  // roadmap
  const tb = b.table || 'launch';
  h += pdRow('表类型', '<select id="pdbWkTable">'+
    PD_WK_ROADMAP_TABLES.map(o=>'<option value="'+o[0]+'"'+(tb===o[0]?' selected':'')+'>'+o[1]+'</option>').join('')+'</select>');
  h += '<div class="pd-note">数据来自路标看板（上市计划/竞品对标在路标页录入）。</div>';
  return h;
}

// 周报绑定面板 wire（report=分组/周数/筛选；siso=版本/年；roadmap=表类型）。改字段即重渲预览。
function pdWireWeeklyBinding(el, ds){
  const host = $('#pdBind'); if(!host) return;
  const byId = id=>host.querySelector('#'+id);
  if(ds==='report'){
    const g = byId('pdbWkGroup');
    if(g) g.onchange = ()=>{ pdPatchBinding(el, { groupDim: g.value }); pdReRenderEl(el.id); };
    const w = byId('pdbWkWeeks');
    if(w) w.onchange = ()=>{ const v = parseInt(w.value,10); pdPatchBinding(el, { weeks: (isNaN(v)?9:Math.max(1,Math.min(52,v))) }); pdReRenderEl(el.id); };
    pdRenderReportFilters(el);
    return;
  }
  if(ds==='siso'){
    const v = byId('pdbWkVer');
    if(v) v.onchange = ()=>{ pdPatchBinding(el, { version: v.value || undefined }); pdReRenderEl(el.id); };
    const y = byId('pdbWkYear');
    if(y) y.onchange = ()=>{ const n = parseInt(y.value,10); pdPatchBinding(el, { year: (isNaN(n)?undefined:n) }); pdReRenderEl(el.id); };
    return;
  }
  // roadmap
  const t = byId('pdbWkTable');
  if(t) t.onchange = ()=>{ pdPatchBinding(el, { table: t.value }); pdReRenderEl(el.id); };
}

// report 筛选区：复用 PSI 级联多选（report 的 filters 维度=PSI 业务维度），写入 b.filters。
// 与 pdRenderFilters 同构，但强制用 PSI 维度/取数（dataset 为 report，故不能直接复用其 ds 分派）。
function pdRenderReportFilters(el){
  const box = $('#pdbFilters'); if(!box) return;
  box.innerHTML='';
  const b = pdEnsureBinding(el);
  const dims = pdDsDims('psi').filter(d=> !pdIsTimeField(d, 'psi'));   // 排除 period
  dims.forEach(field=>{
    const slot = document.createElement('div'); slot.className='pd-fslot';
    box.appendChild(slot);
    const others = pdOtherFilters(el, field);
    const cur = (b.filters && b.filters[field]) || [];
    Promise.resolve(api.options(field, others)).then(opts=>{
      if(!slot.isConnected) return;
      const ms = makeMultiSelect(pdFieldLabel(field, 'psi'), opts||[], cur, {
        onCommit: (sel)=>{
          pdSetFilter(el, field, sel);
          pdReRenderEl(el.id);
          pdRenderReportFilters(el);   // 级联收窄其它维度
        }
      });
      slot.innerHTML=''; slot.appendChild(ms);
    }).catch(()=>{ /* 取数失败：忽略该字段 */ });
  });
}

// F5/F6 时间下拉选项：含「(全部)」空项 + 各时间桶；cur 命中则 selected。
function pdCatOpts(cats, cur){
  let h = '<option value=""'+((cur==null||cur==='')?' selected':'')+'>(全部)</option>';
  (cats||[]).forEach(c=>{ h += '<option value="'+pdEscAttr(c)+'"'+(cur===c?' selected':'')+'>'+pdEscHtml(c)+'</option>'; });
  return h;
}
// 取某绑定的“全部时间桶”（不带 timeFrom/timeTo 切片）。供 F5 图表 + F6 compare 子面板的从/到下拉。
// args: {dataset, measure, agg, catField, catGran, filters}。返回 Promise<string[]>。
async function pdFetchCats(args){
  const ds = args.dataset || 'psi';
  const catField = args.catField || (ds==='idc' ? 'quarter' : 'period');
  const q = {
    dataset: ds, measure: args.measure, agg: args.agg,
    cat: { field: catField, gran: args.catGran || 'month' },
    legend: null, filters: args.filters || {}
  };
  try { const r = await Promise.resolve(api.agg(q)); return (r && r.cats) || []; }
  catch(_){ return []; }
}
// 把已取到的 cats 回填到一个 <select>（保留「(全部)」+当前选中），异步取数完成后调用。
function pdFillCatSelect(sel, cats, cur){
  if(!sel || !sel.isConnected) return;
  sel.innerHTML = pdCatOpts(cats, cur);
}

// ---- F6 同比/对比（compare）：nested-write 助手 + 子面板 HTML/wire ----

// 取/建 compare 子结构（a/b/op/fmt/decimals）默认；返回引用并补默认侧结构。
function pdEnsureCompare(b){
  if(!b.compare) b.compare = {};
  const c = b.compare;
  // F4 经营(财经) compare：source='finance' + scope（单套口径，固定 actual，预设派生两期）。
  if(b && b.dataset==='finance'){
    c.source = 'finance';
    if(!c.scope) c.scope = {};
    const sc = c.scope;
    const fm = (typeof state!=='undefined' && state.finMeta) || {};
    const ay = (fm.actualYears && fm.actualYears.length) ? fm.actualYears : (fm.years || []);
    if(!sc.measure){ const ms = pdDsMeasures('finance'); if(ms.length) sc.measure = (b.measure && ms.indexOf(b.measure)>=0) ? b.measure : ms[0]; }
    sc.basis = 'actual';   // 同比/环比仅实际口径
    if(sc.year==null && ay.length) sc.year = ay[ay.length-1];
    if(sc.fromM==null) sc.fromM = 1;
    // sc.toM 留空=最新
    if(!sc.filters) sc.filters = {};
    if(sc.version==null && (fm.versions && fm.versions.length)) sc.version = fm.versions[0];
    if(!c.preset) c.preset = 'yoy';
    if(!c.fmt) c.fmt = (window.PptBind && window.PptBind.FIN_FMT_DEFAULT && window.PptBind.FIN_FMT_DEFAULT[sc.measure]) || 'pct';
    if(c.decimals==null) c.decimals = 1;
    return c;
  }
  if(!c.a) c.a = { dataset:'psi', catField:'period', filters:{} };
  if(!c.b) c.b = { dataset:'psi', catField:'period', filters:{} };
  if(!c.a.filters) c.a.filters = {};
  if(!c.b.filters) c.b.filters = {};
  // catField 随 dataset 决定时间维（idc=quarter, psi=period）；缺省补齐供 B3 resolver 正确取 idc 矩阵。
  if(!c.a.catField) c.a.catField = (c.a.dataset==='idc') ? 'quarter' : 'period';
  if(!c.b.catField) c.b.catField = (c.b.dataset==='idc') ? 'quarter' : 'period';
  // measure 缺省取该侧数据源首个度量（与 <select> 默认选中项一致，且让预览可触发）；agg 同步补默认让首屏预览确定。
  if(!c.a.measure){ const ms = pdDsMeasures(c.a.dataset||'psi'); if(ms.length) c.a.measure = ms[0]; }
  if(!c.b.measure){ const ms = pdDsMeasures(c.b.dataset||'psi'); if(ms.length) c.b.measure = ms[0]; }
  if(!c.a.agg) c.a.agg = pdDefAgg(c.a.measure, c.a.dataset||'psi');
  if(!c.b.agg) c.b.agg = pdDefAgg(c.b.measure, c.b.dataset||'psi');
  if(!c.fmt) c.fmt = 'pct';
  if(c.decimals==null) c.decimals = 1;
  return c;
}
// 写 compare 顶层字段（fmt/decimals），克隆 compare 不动 a/b。
function pdPatchCompare(el, partial){
  const b = pdEnsureBinding(el);
  const cur = pdEnsureCompare(b);
  const next = Object.assign({}, cur, partial);
  pdPatchBinding(el, { compare: next });
}
// 写 compare 某一侧（a/b）的字段，克隆 side 不动另一侧/filters 外的兄弟字段。
function pdPatchCompareSide(el, side, partial){
  const b = pdEnsureBinding(el);
  const cur = pdEnsureCompare(b);
  const nextSide = Object.assign({}, cur[side], partial);
  const next = Object.assign({}, cur, { [side]: nextSide });
  pdPatchBinding(el, { compare: next });
}
// F4 写 compare.scope 字段（finance），克隆 scope 不动 compare 顶层兄弟字段。
function pdPatchCompareScope(el, partial){
  const b = pdEnsureBinding(el);
  const cur = pdEnsureCompare(b);
  const nextScope = Object.assign({}, cur.scope, partial);
  const next = Object.assign({}, cur, { scope: nextScope });
  pdPatchBinding(el, { compare: next });
}
// F4 写 compare.scope.filters 单字段（finance，非级联，空数组=删除）。
function pdSetCompareScopeFilter(el, field, vals){
  const b = pdEnsureBinding(el);
  const cur = pdEnsureCompare(b);
  const filters = Object.assign({}, (cur.scope && cur.scope.filters) || {});
  if(vals && vals.length) filters[field] = vals.slice(); else delete filters[field];
  pdPatchCompareScope(el, { filters });
}
// 写 compare 某一侧的单字段筛选（clone filters，空数组=删除）。targets binding.compare[side].filters。
function pdSetCompareFilter(el, side, field, vals){
  const b = pdEnsureBinding(el);
  const cur = pdEnsureCompare(b);
  const filters = Object.assign({}, cur[side].filters);
  if(vals && vals.length) filters[field] = vals.slice(); else delete filters[field];
  pdPatchCompareSide(el, side, { filters });
}
// 某一侧“其它筛选”（排除 self field），供级联 options。
function pdCompareOtherFilters(side, exceptField){
  const out = {}; const f = (side && side.filters) || {};
  Object.keys(f).forEach(k=>{ if(k!==exceptField) out[k] = f[k]; });
  return out;
}

// compare 编辑器 HTML：两组子面板 A/B + 输出格式 + 小数位。
function pdCompareEditorHtml(el, b){
  const c = pdEnsureCompare(b);
  let h = '';
  h += pdCompareSideHtml('a', 'A 组（基期）', c.a);
  h += pdCompareSideHtml('b', 'B 组（对比期）', c.b);
  h += '<div class="pd-bsec">对比设置</div>';
  h += pdRow('输出格式', '<select id="pdcFmt">'+
    [['pct','同比 ±%'],['pctword','百分点 ±pct'],['abs','差值 +绝对']].map(o=>'<option value="'+o[0]+'"'+(c.fmt===o[0]?' selected':'')+'>'+o[1]+'</option>').join('')+'</select>');
  h += pdRow('小数位', '<input type="number" id="pdcDec" min="0" max="3" value="'+((c.decimals==null)?1:c.decimals)+'">');
  h += pdRow('后缀', '<input type="text" id="pdcSuffix" value="'+pdEsc(c.suffix||'')+'" placeholder="如 天/台">');
  return h;
}
// 一侧子面板 HTML：数据源 / 指标(measure) / 筛选区(slot) / 时间从-到。
function pdCompareSideHtml(side, title, sd){
  const ds = (sd && sd.dataset) || 'psi';
  const measures = pdDsMeasures(ds);
  let h = '<div class="pd-bsec">'+pdEscHtml(title)+'</div>';
  h += pdRow('数据源', '<select id="pdc'+side+'Ds">'+
    [['psi','经营 PSI'],['idc','IDC 市场']].map(o=>'<option value="'+o[0]+'"'+(ds===o[0]?' selected':'')+'>'+o[1]+'</option>').join('')+'</select>');
  h += pdRow('指标', '<select id="pdc'+side+'Meas">'+
    measures.map(m=>'<option value="'+m+'"'+((sd&&sd.measure)===m?' selected':'')+'>'+pdEscHtml(pdFieldLabel(m,ds))+'</option>').join('')+'</select>');
  h += '<div id="pdc'+side+'Filters"></div>';
  h += pdRow('时间 从', '<select id="pdc'+side+'From"><option value="">(全部)</option></select>');
  h += pdRow('时间 到', '<select id="pdc'+side+'To"><option value="">(全部)</option></select>');
  return h;
}
// 一侧子面板 wire（数据源/指标/筛选/时间从-到）。
function pdWireCompareSide(el, side, host){
  const b = pdEnsureBinding(el);
  const c = pdEnsureCompare(b);
  const sd = c[side];
  const ds = sd.dataset || 'psi';
  const byId = id=>host.querySelector('#'+id);

  // 数据源切换：重置该侧指标/筛选（字段不通用），重渲面板。
  const dsSel = byId('pdc'+side+'Ds');
  if(dsSel) dsSel.onchange = ()=>{
    const nds = dsSel.value;
    pdPatchCompareSide(el, side, { dataset: nds, catField: (nds==='idc'?'quarter':'period'), measure: undefined, filters: {}, timeFrom: null, timeTo: null });
    pdRenderBinding(el); pdReRenderEl(el.id);
  };
  // 指标
  const meas = byId('pdc'+side+'Meas');
  if(meas) meas.onchange = ()=>{ pdPatchCompareSide(el, side, { measure: meas.value, agg: pdDefAgg(meas.value, ds) }); pdReRenderEl(el.id); };
  // 时间从/到：异步取全部桶填充；change → patch。
  const fSel = byId('pdc'+side+'From'), tSel = byId('pdc'+side+'To');
  const catField = ds==='idc' ? 'quarter' : 'period';
  pdFetchCats({ dataset:ds, measure:sd.measure, agg:sd.agg, catField:catField, catGran:'month', filters:sd.filters }).then(cats=>{
    pdFillCatSelect(host.querySelector('#pdc'+side+'From'), cats, sd.timeFrom);
    pdFillCatSelect(host.querySelector('#pdc'+side+'To'), cats, sd.timeTo);
  });
  if(fSel) fSel.onchange = ()=>{ pdPatchCompareSide(el, side, { timeFrom: fSel.value || null }); pdReRenderEl(el.id); };
  if(tSel) tSel.onchange = ()=>{ pdPatchCompareSide(el, side, { timeTo: tSel.value || null }); pdReRenderEl(el.id); };
  // 筛选区（每维一个 makeMultiSelect，options 级联，写 compare[side].filters）。
  pdRenderCompareFilters(el, side, host);
}
// 一侧级联筛选区：复用 makeMultiSelect + api.options/idcOptions，但写到 compare[side].filters。
function pdRenderCompareFilters(el, side, host){
  const box = host.querySelector('#pdc'+side+'Filters'); if(!box) return;
  box.innerHTML = '';
  const b = pdEnsureBinding(el);
  const c = pdEnsureCompare(b);
  const sd = c[side];
  const ds = sd.dataset || 'psi';
  const dims = pdDsDims(ds).filter(d=> !pdIsTimeField(d, ds));
  dims.forEach(field=>{
    const slot = document.createElement('div'); slot.className='pd-fslot';
    box.appendChild(slot);
    const others = pdCompareOtherFilters(sd, field);
    const cur = (sd.filters && sd.filters[field]) || [];
    const optsP = ds==='idc' ? api.idcOptions(field, others) : api.options(field, others);
    Promise.resolve(optsP).then(opts=>{
      if(!slot.isConnected) return;
      const ms = makeMultiSelect(pdFieldLabel(field, ds), opts||[], cur, {
        onCommit: (sel)=>{
          pdSetCompareFilter(el, side, field, sel);
          pdReRenderEl(el.id);
          pdRenderCompareFilters(el, side, host);   // 重建→其它维度 options 级联收窄
        }
      });
      slot.innerHTML=''; slot.appendChild(ms);
    }).catch(()=>{});
  });
}

// ---- F4 经营(财经) compare 编辑器：source='finance' + scope（单套口径，预设派生两期，仅 actual） ----

// 经营 compare 编辑器 HTML：指标 / 对比方式 / 年 / 月区间 / 筛选 / 输出格式 / 小数位 / 后缀（口径固定实际）。
function pdFinCompareEditorHtml(el, b){
  const c = pdEnsureCompare(b);
  const sc = c.scope || {};
  const fm = (typeof state!=='undefined' && state.finMeta) || {};
  const ay = (fm.actualYears && fm.actualYears.length) ? fm.actualYears : (fm.years || []);
  const vers = fm.versions || [];
  const measures = pdDsMeasures('finance');
  let h = '<div class="pd-bsec">经营对比（同比/环比 · 仅实际口径）</div>';
  // 指标
  h += pdRow('指标', '<select id="pdfcMeas">'+
    measures.map(m=>'<option value="'+m+'"'+(sc.measure===m?' selected':'')+'>'+pdEscHtml(pdFieldLabel(m,'finance'))+'</option>').join('')+'</select>');
  // 对比方式预设
  h += pdRow('对比方式', '<select id="pdfcPreset">'+
    [['yoy','同比'],['mom','月环比'],['qoq','区间环比']].map(o=>'<option value="'+o[0]+'"'+((c.preset||'yoy')===o[0]?' selected':'')+'>'+o[1]+'</option>').join('')+'</select>');
  // 口径（固定实际，静态提示）
  h += pdRow('口径', '<span style="opacity:.7">实际（同比/环比仅实际口径）</span>');
  // 年
  h += pdRow('年', '<select id="pdfcYear">'+
    ay.map(y=>'<option value="'+y+'"'+(String(sc.year)===String(y)?' selected':'')+'>'+y+'</option>').join('')+'</select>');
  // 月区间 从/到（到含「最新」=undefined）
  const moOpt = (cur, withLatest)=>{
    let s = withLatest ? ('<option value=""'+((cur==null)?' selected':'')+'>最新</option>') : '';
    for(let m=1;m<=12;m++) s += '<option value="'+m+'"'+(String(cur)===String(m)?' selected':'')+'>'+m+' 月</option>';
    return s;
  };
  h += pdRow('月 从', '<select id="pdfcFromM">'+moOpt(sc.fromM==null?1:sc.fromM, false)+'</select>');
  h += pdRow('月 到', '<select id="pdfcToM">'+moOpt(sc.toM, true)+'</select>');
  // 工作底稿版本（取数上下文一致用）
  if(vers.length) h += pdRow('工作底稿版本', '<select id="pdfcVer">'+
    vers.map(v=>'<option value="'+pdEscAttr(v)+'"'+(sc.version===v?' selected':'')+'>'+pdEscHtml(v)+'</option>').join('')+'</select>');
  // 筛选（国家办 + LV1-4，非级联）
  h += '<div class="pd-bsec">筛选</div><div id="pdfcFilters"></div>';
  // 对比设置
  h += '<div class="pd-bsec">对比设置</div>';
  h += pdRow('输出格式', '<select id="pdfcFmt">'+
    [['pct','同比 ±%'],['pctword','百分点 ±pct'],['pp','百分点差 ±pp'],['abs','差值 +绝对']].map(o=>'<option value="'+o[0]+'"'+(c.fmt===o[0]?' selected':'')+'>'+o[1]+'</option>').join('')+'</select>');
  h += pdRow('小数位', '<input type="number" id="pdfcDec" min="0" max="3" value="'+((c.decimals==null)?1:c.decimals)+'">');
  h += pdRow('后缀', '<input type="text" id="pdfcSuffix" value="'+pdEscAttr(c.suffix||'')+'" placeholder="如 台/USD">');
  return h;
}
// 经营 compare 筛选区：每维一个 makeMultiSelect，options 取自 PD.finOpts（非级联），写 compare.scope.filters。
function pdRenderFinCompareFilters(el, host){
  const box = host.querySelector('#pdfcFilters'); if(!box) return;
  box.innerHTML = '';
  const b = pdEnsureBinding(el);
  const c = pdEnsureCompare(b);
  const sc = c.scope || {};
  const dims = pdDsDims('finance');
  dims.forEach(field=>{
    const slot = document.createElement('div'); slot.className='pd-fslot';
    box.appendChild(slot);
    const cur = (sc.filters && sc.filters[field]) || [];
    pdFinFetchOpts(field, (opts)=>{
      if(!slot.isConnected) return;
      const ms = makeMultiSelect(pdFieldLabel(field,'finance'), opts||[], cur, {
        onCommit: (sel)=>{ pdSetCompareScopeFilter(el, field, sel); pdReRenderEl(el.id); }
      });
      slot.innerHTML=''; slot.appendChild(ms);
    });
  });
}
// 经营 compare 编辑器 wire（指标/对比方式/年/月区间/版本/筛选/格式/小数/后缀）。指标变更套默认格式并重渲。
function pdWireFinCompare(el, host){
  const byId = id=>host.querySelector('#'+id);
  // 指标：写 scope.measure + 按指标套默认格式，重渲面板（刷新格式下拉）。
  const meas = byId('pdfcMeas');
  if(meas) meas.onchange = ()=>{
    const m = meas.value;
    const def = (window.PptBind && window.PptBind.FIN_FMT_DEFAULT && window.PptBind.FIN_FMT_DEFAULT[m]) || 'pct';
    pdPatchCompareScope(el, { measure: m });
    pdPatchCompare(el, { fmt: def });
    pdRenderBinding(el); pdReRenderEl(el.id);
  };
  // 对比方式预设
  const preset = byId('pdfcPreset');
  if(preset) preset.onchange = ()=>{ pdPatchCompare(el, { preset: preset.value }); pdReRenderEl(el.id); };
  // 年
  const yearSel = byId('pdfcYear');
  if(yearSel) yearSel.onchange = ()=>{ pdPatchCompareScope(el, { year: parseInt(yearSel.value,10) }); pdReRenderEl(el.id); };
  // 月 从/到
  const fromSel = byId('pdfcFromM');
  if(fromSel) fromSel.onchange = ()=>{ pdPatchCompareScope(el, { fromM: fromSel.value ? parseInt(fromSel.value,10) : 1 }); pdReRenderEl(el.id); };
  const toSel = byId('pdfcToM');
  if(toSel) toSel.onchange = ()=>{ pdPatchCompareScope(el, { toM: toSel.value ? parseInt(toSel.value,10) : undefined }); pdReRenderEl(el.id); };
  // 工作底稿版本
  const verSel = byId('pdfcVer');
  if(verSel) verSel.onchange = ()=>{ pdPatchCompareScope(el, { version: verSel.value }); pdReRenderEl(el.id); };
  // 输出格式 / 小数位 / 后缀（顶层）
  const fmtSel = byId('pdfcFmt');
  if(fmtSel) fmtSel.onchange = ()=>{ pdPatchCompare(el, { fmt: fmtSel.value }); pdReRenderEl(el.id); };
  const decIn = byId('pdfcDec');
  if(decIn) decIn.onchange = ()=>{ const d = Math.max(0, Math.min(3, parseInt(decIn.value,10)||0)); pdPatchCompare(el, { decimals: d }); pdReRenderEl(el.id); };
  const sfxIn = byId('pdfcSuffix');
  if(sfxIn) sfxIn.oninput = ()=>{ pdPatchCompare(el, { suffix: sfxIn.value }); pdCoalesceRerender(el.id); };
  pdRenderFinCompareFilters(el, host);
}

// 元素是否“可预览”（已配置到能取数）：data 有度量即可（compare 模式有两组的 measure 即可）；chart/table 需类别字段。
function pdHasBinding(el){
  const b = el && el.binding; if(!b) return false;
  if(el.type==='data'){
    if(b.mode==='compare'){
      if(b.compare && b.compare.source==='finance') return !!(b.compare.scope && b.compare.scope.measure);
      return !!(b.compare && b.compare.a && b.compare.a.measure && b.compare.b && b.compare.b.measure);
    }
    return !!b.measure;
  }
  // WK6: grid 数据源(report/siso/roadmap)无 measure/catField —— 各自可解析条件。psi/idc 仍需 measure+catField。
  if(el.type==='table'){
    if(b.dataset==='report') return true;   // report 恒可解析(groupDim 默认 line)
    if(b.dataset==='siso') return true;
    if(b.dataset==='roadmap') return !!b.table;
    return !!(b.measure && b.catField);
  }
  if(el.type==='chart') return !!(b.measure && b.catField);
  return false;
}

// 取/建元素 binding 默认结构（dataset 默认 psi，filters 空对象）。
function pdEnsureBinding(el){
  if(!el.binding) el.binding = { dataset:'psi', filters:{} };
  if(!el.binding.filters) el.binding.filters = {};
  return el.binding;
}
// 浅合并 binding 补丁并写回 doc（updateElement 为浅 assign，故先克隆出完整 binding）。
function pdPatchBinding(el, partial){
  const b = Object.assign({}, pdEnsureBinding(el), partial);
  PptDoc.updateElement(PD.doc, PD.curSlide, el.id, { binding: b });
  pdMarkDirty();
  return b;
}
// 写入/清除单个字段筛选（克隆 filters 避免引用共享）。空数组=清除。
function pdSetFilter(el, field, vals){
  const b = pdEnsureBinding(el);
  const filters = Object.assign({}, b.filters);
  if(vals && vals.length) filters[field] = vals.slice(); else delete filters[field];
  PptDoc.updateElement(PD.doc, PD.curSlide, el.id, { binding: Object.assign({}, b, { filters }) });
  pdMarkDirty();
}
// 当前元素“其它筛选”（排除 self field）——级联：把已选的其它维度作为 options 取数的上下文，实现 产品线→系列→产品 收窄。
function pdOtherFilters(el, exceptField){
  const b = pdEnsureBinding(el); const out = {};
  Object.keys(b.filters||{}).forEach(k=>{ if(k!==exceptField) out[k] = b.filters[k]; });
  return out;
}

// 渲染绑定面板（数据源 / 度量+聚合 / 类别(+粒度) / 图例 / 级联筛选）。
function pdRenderBinding(el){
  const host = $('#pdBind'); if(!host) return;
  const b = pdEnsureBinding(el);
  const ds = b.dataset || 'psi';
  const dims = pdDsDims(ds), measures = pdDsMeasures(ds);

  // F6 模式（仅 data 数据框）：单值 / 同比(compare)。compare 模式走两组子编辑器，跳过单值控件。
  let h = '';
  const isCompare = (el.type==='data' && b.mode==='compare');
  if(el.type==='data'){
    const mode = b.mode || 'single';
    h += pdRow('模式', '<select id="pdbMode">'+
      [['single','单值'],['compare','同比/对比']].map(o=>'<option value="'+o[0]+'"'+(mode===o[0]?' selected':'')+'>'+o[1]+'</option>').join('')+'</select>');
    if(isCompare){
      // 数据源也要在 compare 模式可见可切（含「经营」）。经营→专属 finance compare 编辑器；否则通用两组 A/B。
      h += pdRow('数据源', '<select id="pdbDs">'+pdDsOptsHtml(ds)+'</select>');
      if(ds==='finance'){
        if(!pdHasFin()){
          h += '<div class="pd-bsec">提示</div><div class="pd-row" style="opacity:.7">先在经营分析锚定预测+实际表。</div>';
        } else {
          h += pdFinCompareEditorHtml(el, b);
        }
      } else {
        h += pdCompareEditorHtml(el, b);
      }
      host.innerHTML = h;
      pdWireBinding(el);
      return;
    }
  }

  // 数据源切换（PSI/IDC/经营财经 + table 元素的 报表/SISO/路标）。切换数据源会重置字段（字段名不通用），保留 dataset。finMeta 缺失时经营项 disabled。
  h += pdRow('数据源', '<select id="pdbDs">'+pdDsOptsHtml(ds, el.type==='table')+'</select>');

  // WK7: 周报三 grid 数据源（仅 table 元素）——各自最小面板，不走 PSI/IDC/finance 控件。
  if(el.type==='table' && (ds==='report' || ds==='siso' || ds==='roadmap')){
    h += pdWeeklyBindingHtml(el, b, ds);
    host.innerHTML = h; pdWireBinding(el); return;
  }

  // 经营(财经)数据源：专属面板（口径/年/月区间/版本/度量/维度/筛选），不走 PSI/IDC 控件。
  if(ds==='finance'){
    if(!pdHasFin()){
      h += '<div class="pd-bsec">提示</div><div class="pd-row" style="opacity:.7">先在经营分析锚定预测+实际表。</div>';
      host.innerHTML = h; pdWireBinding(el); return;
    }
    // 补默认（口径/年/度量），保证下拉/chips 有选中态（恢复存档或刚切到 finance 时）。
    const fd = pdFinDefaults(b); if(Object.keys(fd).length){ pdPatchBinding(el, fd); }
    h += pdFinBindingHtml(el, pdEnsureBinding(el));
    host.innerHTML = h; pdWireBinding(el); return;
  }

  // 度量（chips 单选）+ 聚合下拉。
  h += '<div class="pd-bsec">度量（值）</div><div class="pd-chips" id="pdbMeas">'+
    measures.map(m=>'<button type="button" class="pd-chip mea'+(b.measure===m?' on':'')+'" data-field="'+m+'">'+pdEsc(pdFieldLabel(m,ds))+'</button>').join('')+'</div>';
  const aggCur = b.agg || pdDefAgg(b.measure||measures[0], ds);
  h += pdRow('聚合', '<select id="pdbAgg">'+
    [['sum','求和'],['avg','均值'],['last','最新'],['count','计数'],['max','最大'],['min','最小'],['asp','均价']].map(o=>'<option value="'+o[0]+'"'+(aggCur===o[0]?' selected':'')+'>'+o[1]+'</option>').join('')+'</select>');

  // 类别字段（chart/table）：维度 chips 单选 + 时间粒度（类别为时间字段时）。
  if(pdNeedsCat(el)){
    h += '<div class="pd-bsec">类别（分类轴/行）</div><div class="pd-chips" id="pdbCat">'+
      dims.map(d=>'<button type="button" class="pd-chip dim'+(b.catField===d?' on':'')+'" data-field="'+d+'">'+pdEsc(pdFieldLabel(d,ds))+'</button>').join('')+'</div>';
    if(pdIsTimeField(b.catField, ds)){
      const gran = b.catGran || 'month';
      h += pdRow('时间粒度', '<select id="pdbGran">'+
        [['day','日'],['week','周'],['month','月']].map(o=>'<option value="'+o[0]+'"'+(gran===o[0]?' selected':'')+'>'+o[1]+'</option>').join('')+'</select>');
      // F5 时间范围：从/到两个下拉，选项=该图全部时间桶（异步取，先占位「(加载中)」）。
      const cats = PD.lastCats[el.id] || [];
      h += pdRow('时间 从', '<select id="pdbTimeFrom">'+pdCatOpts(cats, b.timeFrom)+'</select>');
      h += pdRow('时间 到', '<select id="pdbTimeTo">'+pdCatOpts(cats, b.timeTo)+'</select>');
    }
  }
  // 图例字段（chart/table）：维度 chips 单选（可清空）。
  if(pdNeedsLegend(el)){
    h += '<div class="pd-bsec">图例（系列/列）<span class="pd-bclear" id="pdbLegClear">清空</span></div><div class="pd-chips" id="pdbLeg">'+
      dims.map(d=>'<button type="button" class="pd-chip dim'+(b.legend===d?' on':'')+'" data-field="'+d+'">'+pdEsc(pdFieldLabel(d,ds))+'</button>').join('')+'</div>';
  }
  // 级联筛选：每个维度一个 makeMultiSelect，options 来自 api.options/idcOptions(field, 其它筛选)。
  h += '<div class="pd-bsec">筛选（级联）</div><div id="pdbFilters"></div>';

  host.innerHTML = h;
  pdWireBinding(el);
}

// 绑定面板事件 wire（数据源/度量/聚合/类别/图例/筛选）。
function pdWireBinding(el){
  const host = $('#pdBind'); if(!host) return;
  const b = pdEnsureBinding(el);
  const ds = b.dataset || 'psi';
  const byId = id=>host.querySelector('#'+id);

  // F6 模式切换（仅 data）：单值/同比 → 写 binding.mode，重渲面板。切到 compare 时确保 compare 默认结构。
  const modeSel = byId('pdbMode');
  if(modeSel) modeSel.onchange = ()=>{
    const m = modeSel.value;
    if(m==='compare'){ const c = pdEnsureCompare(pdEnsureBinding(el)); pdPatchBinding(el, { mode:'compare', compare:c }); }
    else pdPatchBinding(el, { mode:'single' });
    pdRenderBinding(el); pdReRenderEl(el.id);
  };
  // compare 模式：数据源切换 + （经营 finance compare）或（通用两组 A/B）wire（DOM 仅含这些控件，下面常规 handler 自然全部 null-skip）。
  if(el.type==='data' && b.mode==='compare'){
    // 数据源切换（compare 模式内）：切到/离开 finance 需重置 compare 结构（source/scope vs a/b 不通用）。
    const dsSel = byId('pdbDs');
    if(dsSel) dsSel.onchange = ()=>{
      const nds = dsSel.value;
      // 保留 mode=compare；重置 compare（pdEnsureCompare 按新 dataset 重建 source/scope 或 a/b），dataset 切换。
      PptDoc.updateElement(PD.doc, PD.curSlide, el.id, { binding: { dataset:nds, filters:{}, mode:'compare', compare:{} } });
      pdMarkDirty();
      pdRenderBinding(el); pdReRenderEl(el.id);
    };
    if((b.dataset||'psi')==='finance'){
      if(pdHasFin()) pdWireFinCompare(el, host);
      return;
    }
    const fmtSel = byId('pdcFmt'); if(fmtSel) fmtSel.onchange = ()=>{ pdPatchCompare(el, { fmt: fmtSel.value }); pdReRenderEl(el.id); };
    const decIn = byId('pdcDec'); if(decIn) decIn.onchange = ()=>{ const d = Math.max(0, Math.min(3, parseInt(decIn.value,10)||0)); pdPatchCompare(el, { decimals: d }); pdReRenderEl(el.id); };
    const sfxIn = byId('pdcSuffix'); if(sfxIn) sfxIn.oninput = ()=>{ pdPatchCompare(el, { suffix: sfxIn.value }); pdCoalesceRerender(el.id); };
    pdWireCompareSide(el, 'a', host);
    pdWireCompareSide(el, 'b', host);
    return;   // compare 面板无常规控件，提前结束
  }

  // 数据源：切换→重置字段（保留 dataset），重渲面板与预览。切到 finance 时补默认口径/年/度量。
  const dsSel = byId('pdbDs');
  if(dsSel) dsSel.onchange = ()=>{
    const nds = dsSel.value;
    let nb = { dataset:nds, filters:{} };
    if(nds==='finance') nb = Object.assign(nb, pdFinDefaults(nb));
    PptDoc.updateElement(PD.doc, PD.curSlide, el.id, { binding: nb });
    pdMarkDirty();
    pdRenderBinding(el); pdReRenderEl(el.id);
  };
  // 经营(财经)：专属 wire（口径/年/月/版本/度量/维度/筛选），跳过 PSI/IDC 常规控件。
  if(ds==='finance'){ if(pdHasFin()) pdWireFinBinding(el); return; }
  // WK7 周报三 grid 数据源（仅 table）：专属 wire，跳过 PSI/IDC 常规控件。
  if(el.type==='table' && (ds==='report' || ds==='siso' || ds==='roadmap')){ pdWireWeeklyBinding(el, ds); return; }
  // 聚合
  const agg = byId('pdbAgg'); if(agg) agg.onchange = ()=>{ pdPatchBinding(el, { agg: agg.value }); pdReRenderEl(el.id); };
  // 时间粒度
  const gran = byId('pdbGran'); if(gran) gran.onchange = ()=>{ pdPatchBinding(el, { catGran: gran.value }); pdReRenderEl(el.id); };

  // F5 时间范围（从/到）：异步取全部桶填充；change → patch timeFrom/timeTo（空=清除→null）→重渲。
  const tFrom = byId('pdbTimeFrom'), tTo = byId('pdbTimeTo');
  if(tFrom || tTo){
    pdFetchCats({ dataset:ds, measure:b.measure, agg:b.agg, catField:b.catField, catGran:b.catGran, filters:b.filters }).then(cats=>{
      PD.lastCats[el.id] = cats;
      pdFillCatSelect(byId('pdbTimeFrom'), cats, b.timeFrom);
      pdFillCatSelect(byId('pdbTimeTo'), cats, b.timeTo);
    });
    if(tFrom) tFrom.onchange = ()=>{ pdPatchBinding(el, { timeFrom: tFrom.value || null }); pdReRenderEl(el.id); };
    if(tTo) tTo.onchange = ()=>{ pdPatchBinding(el, { timeTo: tTo.value || null }); pdReRenderEl(el.id); };
  }

  // 度量 chips（单选）
  const meas = byId('pdbMeas');
  if(meas) meas.querySelectorAll('.pd-chip').forEach(c=> c.onclick = ()=>{
    const f = c.dataset.field;
    pdPatchBinding(el, { measure:f, agg: pdDefAgg(f, ds) });
    pdRenderBinding(el); pdReRenderEl(el.id);
  });
  // 类别 chips（单选）。切换类别可能改变“是否时间字段”→重渲面板。
  const cat = byId('pdbCat');
  if(cat) cat.querySelectorAll('.pd-chip').forEach(c=> c.onclick = ()=>{
    pdPatchBinding(el, { catField:c.dataset.field });
    pdRenderBinding(el); pdReRenderEl(el.id);
  });
  // 图例 chips（单选，再点同一个=取消）+ 清空按钮
  const leg = byId('pdbLeg');
  if(leg) leg.querySelectorAll('.pd-chip').forEach(c=> c.onclick = ()=>{
    const f = c.dataset.field;
    pdPatchBinding(el, { legend: (b.legend===f ? null : f) });
    pdRenderBinding(el); pdReRenderEl(el.id);
  });
  const legClr = byId('pdbLegClear');
  if(legClr) legClr.onclick = ()=>{ pdPatchBinding(el, { legend:null }); pdRenderBinding(el); pdReRenderEl(el.id); };

  pdRenderFilters(el);
}

// 渲染级联筛选区：为该数据源每个维度建一个 makeMultiSelect；options 传当前“其它筛选”实现级联收窄。
function pdRenderFilters(el){
  const box = $('#pdbFilters'); if(!box) return;
  box.innerHTML='';
  const b = pdEnsureBinding(el);
  const ds = b.dataset || 'psi';
  const dims = pdDsDims(ds).filter(d=> !pdIsTimeField(d, ds));   // 时间字段不作筛选（用粒度）
  dims.forEach(field=>{
    const slot = document.createElement('div'); slot.className='pd-fslot';
    box.appendChild(slot);
    const others = pdOtherFilters(el, field);
    const cur = (b.filters && b.filters[field]) || [];
    const optsP = ds==='idc' ? api.idcOptions(field, others) : api.options(field, others);
    Promise.resolve(optsP).then(opts=>{
      // 取数期间元素可能已切走/删除——校验仍是当前元素且 slot 仍在 DOM。
      if(!slot.isConnected) return;
      const ms = makeMultiSelect(pdFieldLabel(field, ds), opts||[], cur, {
        onCommit: (sel)=>{
          pdSetFilter(el, field, sel);
          pdReRenderEl(el.id);       // 该元素重解析+重渲
          pdRenderFilters(el);       // 重建筛选区→其它维度 options 随之级联收窄
        }
      });
      slot.innerHTML=''; slot.appendChild(ms);
    }).catch(()=>{ /* 取数失败：忽略该字段筛选 */ });
  });
}

// ---- 实时预览：解析绑定→按类型渲染（data 值 / table 小表 / chart echarts）。带 gen 守卫防异步竞态。----

// 把 resolveElement 的矩阵({cats,series:[{name,values}]}) 转成 chartOption 需要的 res({cats,series:[名],data:{名:{类:值}},total})。
function pdMatrixToRes(m){
  const cats = m.cats || [];
  const series = (m.series || []).map(s=>s.name);
  const data = {}; let total = 0;
  (m.series || []).forEach(s=>{ const row = {}; cats.forEach((c,i)=>{ const v = +(s.values && s.values[i]) || 0; row[c]=v; total += v; }); data[s.name]=row; });
  // chartOption 的饼/树/漏斗/瀑布等取 series[0]，需保证至少一个系列。
  if(!series.length){ series.push('(值)'); data['(值)'] = {}; cats.forEach(c=> data['(值)'][c]=0); }
  return { cats, series, data, total };
}

PD.gen = 0;   // 全局解析代号；每次发起解析自增，回调时比对防止旧结果覆盖新结果。

// 解析单元素并渲染预览。token 可由 refreshAll 传入统一代号；否则用单元素自增。
function pdStaticTable(el){ return el && el.type==='table' && Array.isArray(el.rows) && el.rows.length>0; }
function pdStaticChart(el){ return el && el.type==='chart' && el.data && Array.isArray(el.data.cats) && Array.isArray(el.data.series); }
async function pdResolveAndRender(el, token){
  // 静态表格(2026-09-01 PPT转换)：el.rows 直接渲染，无需数据绑定——承接用户 PPT 里的手工表
  // 静态图表(2026-09-01 PPT转换)：el.data={cats,series[{name,values}]} 直接喂图表渲染器，颜色走 fmt.colors
  if(el.type==='chart' && pdStaticChart(el) && !pdHasBinding(el)){
    const cur0 = pdElNode(el.id);
    if(cur0){ PD.lastSeriesNames[el.id]=(el.data.series||[]).map(x=>String(x.name)); pdRenderChartPreview(el, cur0, el.data); }
    return;
  }
  if(el.type==='table' && Array.isArray(el.rows) && el.rows.length && !pdHasBinding(el)){
    const cur0 = pdElNode(el.id);
    if(cur0) pdRenderTablePreview(cur0, { kind:'grid', header: el.rows[0]||[], rows: el.rows.slice(1) });
    return;
  }
  if(!pdHasBinding(el)) return;
  const node = pdElNode(el.id); if(!node) return;
  const myGen = (token!=null) ? token : (PD.gen = PD.gen + 1);
  let res;
  try { res = await PptBindings.resolveElement(api, PptBind, el); }
  catch(_){ return; }
  // 竞态守卫：解析期间又发起了更新（单元素或新一轮 refreshAll 令 PD.gen 前移）→ 丢弃旧结果。
  if(myGen!==PD.gen) return;
  const cur = pdElNode(el.id); if(!cur || !cur.isConnected) return;
  const sl = pdSlide(); if(!sl || !sl.elements.find(e=>e.id===el.id)) return;

  if(el.type==='data'){
    const box = cur.querySelector('.pd-data'); if(!box) return;
    // F6 compare：res.compare 时直接显示 res.text，正绿负红（value 为 null/0 取中性色）。
    if(res && res.compare){
      box.textContent = res.text != null ? res.text : '—';
      const v = res.value;
      box.style.color = (v==null) ? '' : (v>=0 ? 'var(--c-good)' : 'var(--c-brand)');
    } else {
      box.style.color = '';   // 切回单值：清除 compare 配色
      const val = (res && res.kind==='value') ? res.value : null;
      // 经营(财经)：按指标格式（gmr/达成率→%、nsip→$、金额/数量→单位格式）。
      if((el.binding && el.binding.dataset==='finance')) box.textContent = (val==null) ? '—' : pdFmtFinVal(val, el.binding.measure, el.style||{});
      else box.textContent = (val==null) ? '—' : pdFmtVal(val, el.style||{});
    }
  } else if(el.type==='table'){
    pdRenderTablePreview(cur, res);
  } else if(el.type==='chart'){
    // S4: 暂存 canonical 系列名（解析矩阵 top→bottom 序）。堆积时 echarts series 是反转(底→顶)，
    // 故拖拽列表的"权威序"必须来自此处的矩阵 res.series，而非 getOption().series。
    PD.lastSeriesNames[el.id] = (res && res.series || []).map(s=>String(s.name));
    pdRenderChartPreview(el, cur, res);
    // 解析完成后若该 chart 仍选中，刷新系列色列表（首次选中时 echarts 尚未建实例）。
    if(PD.selId===el.id) pdRefreshColorsList(el);
  }
}

// 数据框取值格式化：enum 单位 + 小数位（A6，复用 numfmt）；无 numfmt 兜底 shortLabel。
function pdFmtVal(val, st){
  const unit = st.unit || 'auto';
  const dec = (st.decimals==null) ? 1 : st.decimals;
  if(typeof window!=='undefined' && window.PptNumFmt && typeof window.PptNumFmt.formatNum==='function')
    return window.PptNumFmt.formatNum(val, unit, dec);
  return shortLabel(val);
}

// 系列色列表延迟刷新：解析出系列名后，原地替换属性面板里的 #pdfColors（含 hint+拖拽行）并重绑事件。
function pdRefreshColorsList(el){
  const prop = $('#pdProp'); if(!prop) return;
  const box = prop.querySelector('#pdfColors'); if(!box) return;
  // 双保险：取色弹窗打开时（颜色框内有 :focus 的 input）跳过重建，避免重建关闭弹窗。
  if(box.querySelector && box.querySelector('input:focus')) return;
  const names = pdSeriesNames(el.id); if(!names.length) return;
  const fmt = (el.chart && el.chart.fmt) || {};
  const tmp = document.createElement('div'); tmp.innerHTML = pdColorsHtml('pdfColors', names, fmt, el);
  const fresh = tmp.firstChild; box.replaceWith(fresh);
  fresh.querySelectorAll('input[data-cseries]').forEach(n=> n.onchange = ()=>{
    const prev = (el.chart && el.chart.fmt && el.chart.fmt.colors) || {};
    pdPatchChartFmt(el, { colors: Object.assign({}, prev, { [n.dataset.cseries]: pdHex(n.value) }) });
  });
  pdWireColorDrag(el, fresh);   // S4: 拖拽重排 → seriesOrder
}

// table 预览：cats × series 的小 HTML 表（行=类别，列=系列，末列合计）。
function pdRenderTablePreview(node, res){
  let box = node.querySelector('.pd-tablebox');
  if(!box){ node.innerHTML='<div class="pd-tablebox"></div>'; box = node.querySelector('.pd-tablebox'); }
  // WK6: grid 数据源(report/siso/roadmap)——单元格已是预格式化字符串。列多时容器横向滚动。
  if(res && res.kind==='grid'){
    const header = (res.header) || [], rows = (res.rows) || [];
    if(!header.length && !rows.length){ box.innerHTML='<div class="pd-ph">（无数据）</div>'; return; }
    let g = '<div style="overflow:auto;max-width:100%;max-height:100%"><table class="pd-mini"><thead><tr>'
      + header.map(h=>'<th>'+pdEsc(h)+'</th>').join('') + '</tr></thead><tbody>';
    rows.forEach(r=>{ g += '<tr>'+ (r||[]).map(c=>'<td>'+pdEsc(c)+'</td>').join('') +'</tr>'; });
    g += '</tbody></table></div>';
    box.innerHTML = g;
    return;
  }
  const cats = (res && res.cats) || [], series = (res && res.series) || [];
  if(!cats.length || !series.length){ box.innerHTML='<div class="pd-ph">（无数据）</div>'; return; }
  let h = '<table class="pd-mini"><thead><tr><th></th>'+series.map(s=>'<th>'+pdEsc(s.name)+'</th>').join('')+'</tr></thead><tbody>';
  cats.forEach((c,ci)=>{
    h += '<tr><td>'+pdEsc(c)+'</td>'+series.map(s=>'<td>'+shortLabel(+(s.values&&s.values[ci])||0)+'</td>').join('')+'</tr>';
  });
  h += '</tbody></table>';
  box.innerHTML = h;
}

// pt→px：显示 px = 磅 × (pxPerInch/72)。克隆 fmt，图表三字号补默认(10/10/9)后换算，原 fmt 不动。
// 图表字号(chartOption/echarts)按 px 生效，但 fmt 里存的是 PowerPoint 磅(pt=1/72in)；
// 预览容器按 PD.scale px/in、离屏容器按 96 px/in，故需按对应 pxPerInch 把磅换成 px。
function pdScaleFmtFonts(fmt, pxPerInch){
  const f = Object.assign({}, fmt || {});
  const k = (pxPerInch || 96) / 72;
  f.catFontSize   = Math.round(((f.catFontSize   == null ? 10 : f.catFontSize  ) * k) * 10) / 10;
  f.valFontSize   = Math.round(((f.valFontSize   == null ? 10 : f.valFontSize  ) * k) * 10) / 10;
  f.labelFontSize = Math.round(((f.labelFontSize == null ?  9 : f.labelFontSize) * k) * 10) / 10;
  f.legendFontSize = Math.round(((f.legendFontSize == null ? 10 : f.legendFontSize) * k) * 10) / 10;   // 图例导出=10pt(pptxgenjs 默认),预览同磅换算(测量确认)
  return f;
}

// chart 预览：在元素 .pd-chartbox 上 echarts.init + setOption（22 图都走 chartOption，含 treemap/漏斗/仪表盘/瀑布）。
function pdRenderChartPreview(el, node, m){
  let box = node.querySelector('.pd-chartbox');
  if(!box){ node.innerHTML='<div class="pd-chartbox"></div>'; box = node.querySelector('.pd-chartbox'); }
  if(!box.clientWidth || !box.clientHeight){ /* 容器尚无尺寸：跳过，待 resize/重渲再画 */ return; }
  const res = pdMatrixToRes(m||{});
  const vtype = (el.chart && el.chart.vtype) || 'column';
  const fmt = (el.chart && el.chart.fmt) || {};
  const pal = (typeof dz!=='undefined' && dz.palette) || ['#C7000B','#E63340','#2563C9','#1E9E57','#E0A400','#7A4FBF','#0E9AA7','#9CA2A8'];
  let ch = PD.charts[el.id];
  // 容器 DOM 可能已被整页重渲替换 → 旧实例失效，需重建。
  if(ch && (ch.isDisposed() || ch.getDom()!==box)){ try{ ch.dispose(); }catch(_){ } ch=null; }
  if(!ch){ ch = echarts.init(box); PD.charts[el.id] = ch; }
  let opt;
  // 预览容器为 PD.scale px/in：把 fmt 磅换成对应 px，与文本字号所见即所得一致。
  try { opt = PptChartRender.chartOption(vtype, pdScaleFmtFonts(fmt, PD.scale), res, pal); }
  catch(_){ return; }
  ch.setOption(opt, true);
}

// ---- echarts 生命周期 ----
function pdDisposeChart(elId){ const ch = PD.charts[elId]; if(ch){ try{ if(!ch.isDisposed()) ch.dispose(); }catch(_){ } delete PD.charts[elId]; } }
function pdDisposeAllCharts(){ Object.keys(PD.charts||{}).forEach(id=> pdDisposeChart(id)); }

// ---- 全局刷新：遍历所有页所有绑定元素，重解析+重渲（gen 守卫防重入/竞态）。底数据 reload 后由 app.js 调用。----
async function refreshAll(){
  if(!PD.doc || !PD.built) return;
  const token = (PD.gen = PD.gen + 1);   // 统一代号：本轮所有解析共用；新一轮 refreshAll/单元素更新会令旧轮失效
  // 遍历所有页的所有绑定元素。只有当前页元素有 DOM 节点能渲染；非当前页元素无节点，
  // pdResolveAndRender 内会因找不到节点而跳过（切到该页时 pdRenderCanvas 会重新预览）。
  const tasks = [];
  (PD.doc.slides||[]).forEach(sl=>{
    (sl.elements||[]).forEach(el=>{ if(pdHasBinding(el) || pdStaticTable(el) || pdStaticChart(el)) tasks.push(pdResolveAndRender(el, token)); });
  });
  await Promise.all(tasks);
}

// ============================================================
//  导出 pptx + 命名模板管理（Task 9）
// ============================================================

// 调色板（与预览一致）：dz.palette 优先，无则内置。
function pdPalette(){ return (typeof dz!=='undefined' && dz.palette) || ['#C7000B','#E63340','#2563C9','#1E9E57','#E0A400','#7A4FBF','#0E9AA7','#9CA2A8']; }

// 非原生图表（treemap/funnel/gauge/waterfall/scatter/bubble…）离屏渲染取 PNG dataURL。
// 用隐藏 div + echarts.init + setOption + getDataURL + dispose + remove（不泄漏）。
// 返回 dataURL；失败返回 null（导出端走占位兜底）。
function pdOffscreenChartImage(el, res){
  if(typeof echarts==='undefined') return null;
  const vtype = (el.chart && el.chart.vtype) || 'column';
  const fmt = (el.chart && el.chart.fmt) || {};
  // 离屏容器按元素英寸尺寸 × 96dpi 给像素，保证图比例与版式一致。
  const wPx = Math.max(120, Math.round((el.w||4.8) * 96));
  const hPx = Math.max(90,  Math.round((el.h||3)   * 96));
  const div = document.createElement('div');
  div.style.cssText = 'position:absolute;left:-99999px;top:-99999px;width:'+wPx+'px;height:'+hPx+'px;pointer-events:none';
  document.body.appendChild(div);
  let ch = null, url = null;
  try {
    ch = echarts.init(div);
    // 离屏容器为 96dpi(96 px/in)：把 fmt 磅换成对应 px，与预览/导出所见即所得一致。
    ch.setOption(PptChartRender.chartOption(vtype, pdScaleFmtFonts(fmt, 96), pdMatrixToRes(res||{}), pdPalette()), true);
    url = ch.getDataURL({ pixelRatio:2, backgroundColor:'#fff' });
  } catch(_){ url = null; }
  finally {
    if(ch){ try{ ch.dispose(); }catch(_){ } }
    try{ div.remove(); }catch(_){ }
  }
  return url;
}

// 导出当前文档为 pptx。
// 1) 遍历所有页所有元素 → resolveElement 建 resolvedMap。
// 2) 非原生 chart（!isNativeChart）：一律离屏渲染(96dpi 真磅字号) → el.chart.image=dataURL（供 export-pptx 图片兜底）。原生 chart 不设 image。
// 3) exportDoc → base64 → api.saveFile。toast 成功(path)/取消/失败。
async function pdExport(){
  if(!PD.doc){ toast('无可导出的文档','err'); return; }
  showLoading('正在生成 PowerPoint…');
  const injected = [];   // 本次注入了 image 的 chart 元素（导出后清理，避免大 dataURL 进存档/泄漏）
  try {
    const resolvedMap = {};
    const slides = PD.doc.slides || [];
    for(let si=0; si<slides.length; si++){
      const els = (slides[si].elements) || [];
      for(let ei=0; ei<els.length; ei++){
        const el = els[ei];
        // 解析全部 data/table/chart 元素；text/unit/shape/image 无绑定，resolveElement 返回 {kind:'none'}。
        let res;
        try { res = await PptBindings.resolveElement(api, PptBind, el); }
        catch(_){ res = null; }
        if(res) resolvedMap[el.id] = res;
        // 非原生 chart（有绑定且能出矩阵）→ 注入图片兜底。slicer 与原生图跳过（原生图走 export-pptx 原生）。
        if(el.type==='chart' && el.chart){
          const vt = el.chart.vtype;
          if(vt!=='slicer' && !PptExport.isNativeChart(vt) && pdHasBinding(el)){
            // 一律离屏渲染取图：离屏容器按 96dpi 换算字号(真磅)，与导出所见即所得。
            // 不再走当前页 live 实例捷径——预览实例字号按 PD.scale px/in 换算，与 96dpi 不一致。
            const url = pdOffscreenChartImage(el, res);
            if(url){ el.chart.image = url; injected.push(el); } else delete el.chart.image;
          } else {
            // 原生图 / slicer / 未绑定：清掉可能遗留的 image，确保原生图走原生导出。
            if(el.chart.image) delete el.chart.image;
          }
        }
      }
    }
    const b64 = await PptExport.exportDoc({ PptxGenJS: window.PptxGenJS, doc: PD.doc, resolvedMap });
    const fn = ((PD.doc.name||'未命名') + '_' + ExportUtil.ymd() + '.pptx');
    const safeFn = (typeof ExportUtil.safe==='function') ? ExportUtil.safe(fn) : fn;
    const res = await api.saveFile(safeFn, b64, 'pptx');
    if(res && res.path) toast('已导出：'+res.path,'ok');
    else if(res && res.canceled) { /* 用户取消：静默 */ }
    else toast('导出未完成','err');
  } catch(e){
    toast('导出失败：'+((e&&e.message)||e),'err');
  } finally {
    // 清理注入的 dataURL（非原生图导出后不应残留在 doc 中：会进存档、占内存）。
    injected.forEach(el=>{ if(el.chart) delete el.chart.image; });
    hideLoading();
  }
}

// ---- 命名模板管理（新建 / 打开 / 另存为 / 删除）。存储用 window.localStorage（sb.* 自动进可携带存档）。----
function pdStorage(){ return window.localStorage; }

// 有未保存改动时确认是否丢弃（新建/打开前调）。无改动直接放行。
function pdConfirmDiscard(){
  if(!PD.dirty) return true;
  return window.confirm('当前模板有未保存的改动，继续将丢弃这些改动。是否继续？');
}

// 新建空白模板：confirm-discard → 重置 doc/页/选中 → 重渲。
function pdNewDoc(){
  if(!pdConfirmDiscard()) return;
  PD.doc = PptDoc.newPresentation('未命名');
  PD.curSlide = 0; PD.selId = null; PD.sel = new Set(); PD.dirty = false;
  pdHistInit();   // 新 doc 作为新历史基线
  pdDisposeAllCharts();
  renderPptOutput();
  pdSelect(null);
}

// ---- WK7 内置「产业周报」模板：pdBuildWeeklyDoc 建 7 页 doc + 工具栏按钮载入 ----

// 今日 YYYYMMDD（本地）。
function pdYmd8(){
  const d = new Date();
  const p = n=> String(n).padStart(2,'0');
  return '' + d.getFullYear() + p(d.getMonth()+1) + p(d.getDate());
}
// 页标题文本元素（20pt 粗体，左上）。
function pdWkTitle(text){ return PptDoc.newElement('text', { x:0.4, y:0.25, w:9, h:0.5, text:text, style:{ fontSize:20, bold:true, color:'1A1A1A', align:'left' } }); }
// 叙述占位文本（11pt 红，标题下方，宽跨整版）。
function pdWkNarrative(text){ return PptDoc.newElement('text', { x:0.4, y:0.85, w:12.5, h:0.5, text:(text||'【叙述】双击编辑本周要点…'), style:{ fontSize:11, color:'C7000B', align:'left' } }); }
// 周报 grid 表元素（预设 binding + 位置尺寸）。
function pdWkTable(binding, x, y, w, h){ return PptDoc.newElement('table', { x:x, y:y, w:w, h:h, binding:binding }); }

// 构建内置产业周报文档：7 页（16:9 13.333×7.5），每页 标题 + 叙述占位 + 对应 grid 表。
function pdBuildWeeklyDoc(){
  const doc = PptDoc.newPresentation('产业周报-' + pdYmd8());
  // newPresentation 已含 1 空页；再加 6 页凑够 7。
  while(doc.slides.length < 7) PptDoc.addSlide(doc);
  const add = (si, el)=> PptDoc.addElement(doc, si, el);

  // S1 SISO达成进度
  add(0, pdWkTitle('SISO达成进度'));
  add(0, pdWkNarrative('【叙述】双击编辑本周 SISO 达成要点…'));
  add(0, pdWkTable({ dataset:'siso', filters:{} }, 0.4, 1.5, 12.5, 5.3));

  // S2 产品系列销售进展
  add(1, pdWkTitle('产品系列销售进展'));
  add(1, pdWkNarrative('【叙述】双击编辑本周产品系列销售要点…'));
  add(1, pdWkTable({ dataset:'report', groupDim:'family', weeks:9, filters:{} }, 0.4, 1.5, 12.5, 5.3));

  // S3 国家办销售进展
  add(2, pdWkTitle('国家办销售进展'));
  add(2, pdWkNarrative('【叙述】双击编辑本周国家办销售要点…'));
  add(2, pdWkTable({ dataset:'report', groupDim:'rep', weeks:9, filters:{} }, 0.4, 1.5, 12.5, 5.3));

  // S4 国家销售进展
  add(3, pdWkTitle('国家销售进展'));
  add(3, pdWkNarrative('【叙述】双击编辑本周国家销售要点…'));
  add(3, pdWkTable({ dataset:'report', groupDim:'country', weeks:9, filters:{} }, 0.4, 1.5, 12.5, 5.3));

  // S5 重点国家×产品系列（默认墨西哥，叙述提示可改筛选）
  add(4, pdWkTitle('重点国家×产品系列'));
  add(4, pdWkNarrative('【叙述】默认墨西哥；可在右侧「筛选」改重点国家…'));
  add(4, pdWkTable({ dataset:'report', groupDim:'family', weeks:9, filters:{ country:['墨西哥'] } }, 0.4, 1.5, 12.5, 5.3));

  // S6 新品：预售进展与作战（两张表）
  add(5, pdWkTitle('新品：预售进展与作战'));
  add(5, pdWkNarrative('【叙述】双击编辑本周新品预售/作战要点…'));
  add(5, pdWkTable({ dataset:'roadmap', table:'launch' }, 0.4, 1.5, 12.5, 2.6));
  add(5, pdWkTable({ dataset:'roadmap', table:'battle' }, 0.4, 4.3, 12.5, 2.7));

  // S7 新品大货&样机（SKU 表 + 样机表 + 手填链接文本框）
  add(6, pdWkTitle('新品大货&样机'));
  add(6, pdWkNarrative('【叙述】双击编辑本周大货&样机要点…'));
  add(6, pdWkTable({ dataset:'roadmap', table:'samples' }, 0.4, 1.5, 12.5, 2.6));
  add(6, pdWkTable({ dataset:'roadmap', table:'sku' }, 0.4, 4.3, 12.5, 1.6));
  add(6, PptDoc.newElement('text', { x:0.4, y:6.0, w:12.5, h:1.2, text:'【链接/适配事项】双击编辑…', style:{ fontSize:10, color:'1A1A1A', align:'left' } }));

  return doc;
}

// 工具栏「产业周报」：确认丢弃 → 载入内置周报 doc → 重置选中/历史基线（镜像 pdNewDoc）→ refreshAll。
function pdLoadWeeklyDoc(){
  if(!pdConfirmDiscard()) return;
  PD.doc = pdBuildWeeklyDoc();
  PD.curSlide = 0; PD.selId = null; PD.sel = new Set(); PD.dirty = false;
  pdHistInit();   // 生成的周报作为新历史基线
  pdDisposeAllCharts();
  renderPptOutput();
  pdSelect(null);
  refreshAll();   // 按当前底数据解析所有 grid 表
  if(typeof toast==='function') toast('产业周报模板已生成，数据解析中…','ok');
}

// ---- 模板对话框（替代失效的 window.prompt；Electron 渲染进程不支持 prompt）----

// 绑定一次：✕ / 遮罩点击 / Esc 关闭；保存 / 另存为新模板按钮。
function pdBindTplModal(){
  const m = $('#pdTplModal'); if(!m || m._pdBound) return; m._pdBound = true;
  const close = $('#pdTplClose'); if(close) close.onclick = pdCloseTplModal;
  // 点遮罩（卡片外）关闭。
  m.addEventListener('mousedown', (e)=>{ if(e.target===m) pdCloseTplModal(); });
  // Esc 关闭（仅对话框打开时）。
  m.addEventListener('keydown', (e)=>{ if(e.key==='Escape'){ e.preventDefault(); pdCloseTplModal(); } });
  const save = $('#pdTplSave'); if(save) save.onclick = pdTplSave;
  const saveAs = $('#pdTplSaveAs'); if(saveAs) saveAs.onclick = pdTplSaveAs;
}

// 打开对话框：填入当前名 → 刷列表 → 显示。
function pdOpenTplModal(){
  if(!PD.doc) return;
  pdBindTplModal();
  const m = $('#pdTplModal'); if(!m) return;
  const inp = $('#pdTplName'); if(inp) inp.value = PD.doc.name || '未命名';
  pdRenderTplList();
  m.classList.remove('hidden');
  if(inp){ inp.focus(); inp.select(); }
}

function pdCloseTplModal(){ const m = $('#pdTplModal'); if(m) m.classList.add('hidden'); }

// 渲染已存模板列表：每行 名称 + 打开 + 删除。
function pdRenderTplList(){
  const box = $('#pdTplList'); if(!box) return;
  const list = PptStore.listTemplates(pdStorage()) || [];
  if(!list.length){ box.innerHTML = '<div class="pd-tpl-empty">暂无已存模板</div>'; return; }
  box.innerHTML = list.map(t=>
    '<div class="pd-tpl-row" data-id="'+pdEscAttr(t.id)+'">'+
    '<span class="nm" title="'+pdEscAttr(t.name||'')+'">'+pdEscHtml(t.name||'(未命名)')+'</span>'+
    '<button class="open" data-act="open">打开</button>'+
    '<button class="del" data-act="del">删除</button>'+
    '</div>'
  ).join('');
  box.querySelectorAll('.pd-tpl-row').forEach(row=>{
    const id = row.getAttribute('data-id');
    const o = row.querySelector('[data-act="open"]'); if(o) o.onclick = ()=> pdTplOpen(id);
    const d = row.querySelector('[data-act="del"]'); if(d) d.onclick = ()=> pdTplDelete(id);
  });
}

// HTML/属性转义（模板名可能含特殊字符）。
function pdEscHtml(s){ return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function pdEscAttr(s){ return pdEscHtml(s).replace(/"/g,'&quot;'); }

// 保存（覆盖当前 doc id）：写 doc.name → saveTemplate → 清脏 → 刷新工具栏与列表。
function pdTplSave(){
  if(!PD.doc) return;
  const inp = $('#pdTplName');
  const nm = inp ? String(inp.value).trim() : (PD.doc.name||'');
  if(!nm){ toast('名称不能为空','err'); return; }
  PD.doc.name = nm;
  try {
    PptStore.saveTemplate(pdStorage(), PD.doc);
    PD.dirty = false;
    pdSyncToolbar();
    pdRenderTplList();
    toast('已保存模板：'+nm,'ok');
  } catch(e){ toast('保存失败：'+((e&&e.message)||e),'err'); }
}

// 另存为新模板：深拷贝当前 doc → 新 id + 输入名 → saveTemplate；PD.doc 指向新副本，清脏；刷新工具栏与列表。
function pdTplSaveAs(){
  if(!PD.doc) return;
  const inp = $('#pdTplName');
  const nm = inp ? String(inp.value).trim() : '';
  if(!nm){ toast('名称不能为空','err'); return; }
  try {
    const copy = JSON.parse(JSON.stringify(PD.doc));
    copy.id = 'p' + Date.now().toString(36);
    copy.name = nm;
    PptStore.saveTemplate(pdStorage(), copy);
    PD.doc = copy;
    PD.dirty = false;
    pdSyncToolbar();
    pdRenderTplList();
    toast('已另存为新模板：'+nm,'ok');
  } catch(e){ toast('另存失败：'+((e&&e.message)||e),'err'); }
}

// 打开模板：confirm-discard → loadTemplate → set doc → 重渲 → refreshAll（按当前底数据重填）→ 关闭。
function pdTplOpen(id){
  if(!pdConfirmDiscard()) return;
  const doc = PptStore.loadTemplate(pdStorage(), id);
  if(!doc){ toast('载入失败','err'); return; }
  PD.doc = doc;
  PD.curSlide = 0; PD.selId = null; PD.sel = new Set(); PD.dirty = false;
  pdHistInit();   // 打开的模板作为新历史基线
  pdDisposeAllCharts();
  renderPptOutput();
  pdSelect(null);
  refreshAll();   // 按当前底数据重解析所有绑定元素
  pdCloseTplModal();
  toast('已打开模板：'+(doc.name||''),'ok');
}

// 删除模板：deleteTemplate → 刷列表。
function pdTplDelete(id){
  const list = PptStore.listTemplates(pdStorage()) || [];
  const t = list.find(x=>x.id===id);
  PptStore.deleteTemplate(pdStorage(), id);
  pdRenderTplList();
  toast('已删除模板：'+((t&&t.name)||''),'ok');
}

function initPptOutputView(){ /* 事件均在 render 时绑定 */ }

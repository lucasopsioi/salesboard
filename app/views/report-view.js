'use strict';
/* ============================================================
   汇总表 (report)
   纯搬运自 app.js，无逻辑改动；在 common.js 之后、app.js 之前加载。
   跨视图共用的 maxWeekNum / renderWeekRange 已移至 common.js。
   ============================================================ */
const REP_DIMS=['family','line','series','product','model','region','repOffice','country'];
/* sortKey/sortDir 只在「自定义排序」开(custom=true)时生效；关=默认排序(累计SO 高→低)。
   关开关不清空 sortKey/sortDir，再打开回到上次那一列。 */
const rep={dim:'series',weeks:9,fromW:null,toW:null,filters:{},last:null,token:0,custom:false,sortKey:'cumCur',sortDir:-1};
// 排序内核：浏览器取 window.TableSort，Node 单测走 require
function repTS(){ return (typeof window!=='undefined'&&window.TableSort)?window.TableSort:require('../table-sort-core.js'); }

/* ---- 状态持久化（sb.report.v1）——第二批-2a。
   存 rep 的：dim/weeks/fromW/toW/filters/sortKey/sortDir。运行态 last/token 不存。
   applyMeta 每次数据到达都会重置 rep.filters/last/fromW/toW，故回载在其重置之后、只首次一次
   （repRestored 守卫）——避免 refresh 覆盖当前操作。dim 交给 buildRepDimOptions 校正、
   fromW/toW 交给 renderWeekRange 按周数校正、filters 交给引擎按值过滤（脏值防御）；坏档 try/catch 走默认。 ---- */
const REP_STATE_KEY='sb.report.v1';
let repRestored=false;
function repStateSave(){ boardStateSave(REP_STATE_KEY, ()=>({
  dim: rep.dim, weeks: rep.weeks, fromW: rep.fromW, toW: rep.toW,
  filters: rep.filters, custom: rep.custom, sortKey: rep.sortKey, sortDir: rep.sortDir }), 500); }
function repStateRestore(){
  if(repRestored) return; repRestored=true;
  const o=boardStateLoad(REP_STATE_KEY); if(!o) return;
  if(typeof o.dim==='string' && REP_DIMS.includes(o.dim)) rep.dim=o.dim;                 // buildRepDimOptions 再校验在不在 state.dims
  if(typeof o.weeks==='number' && isFinite(o.weeks) && o.weeks>0 && o.weeks<=60) rep.weeks=o.weeks;
  if(o.fromW===null || (typeof o.fromW==='number' && isFinite(o.fromW))) rep.fromW=o.fromW;  // renderWeekRange 按周数校正
  if(o.toW===null || (typeof o.toW==='number' && isFinite(o.toW))) rep.toW=o.toW;
  if(o.filters && typeof o.filters==='object') rep.filters=o.filters;                    // renderRepFilters/引擎按值过滤
  if(typeof o.custom==='boolean') rep.custom=o.custom;                                   // 旧档没有该字段 → 保持默认 false(默认排序)
  if(typeof o.sortKey==='string') rep.sortKey=o.sortKey;
  if(o.sortDir===1 || o.sortDir===-1) rep.sortDir=o.sortDir;
}

/* ---- 自定义排序开关（与国家看板同款；动态插进控件行，不改 index.html） ---- */
function ensureRepCustomSortUI(){
  if($('#repCustomSort')){ syncRepCustomSortUI(); return; }
  const dimSel=$('#repDim'); if(!dimSel) return;
  const dimFld=dimSel.closest('.fld'); if(!dimFld) return; const row=dimFld.parentNode; if(!row) return;
  const fld=document.createElement('div'); fld.className='fld';
  fld.innerHTML='<label>行排序</label><button id="repCustomSort" class="btn" style="padding:2px 10px"></button>';
  if(dimFld.nextSibling) row.insertBefore(fld,dimFld.nextSibling); else row.appendChild(fld);
  $('#repCustomSort').onclick=()=>{ rep.custom=!rep.custom; syncRepCustomSortUI(); renderReportTable(); repApplyNote(); repStateSave(); };
  syncRepCustomSortUI();
}
// 说明文字里的排序那一段：切开关时只重绘表格，note 要单独刷新（否则措辞停在上一个状态）
function repSortNote(){ return rep.custom
  ? ' · 自定义排序【开】：点表头按该列排(再点切升↔降，▲升 ▼降)'
  : ' · 默认排序：累计SO 高→低（开「自定义排序」可点表头自选列）'; }
function repApplyNote(){ const el=$('#repNote'); if(el&&rep.noteBase!=null) el.textContent=rep.noteBase+repSortNote(); }
function syncRepCustomSortUI(){
  const b=$('#repCustomSort'); if(!b) return; const TS=repTS();
  b.textContent=TS.btnLabel(rep.custom); b.title=TS.BTN_TITLE;
  b.style.background=rep.custom?'var(--c-brand-soft)':''; b.style.borderColor=rep.custom?'var(--c-brand)':''; b.style.color=rep.custom?'var(--c-brand)':'';
}

/* ---- 隐藏行(跨启动记住)：localStorage sb.rep.hidden = { "拆分维度": [行key,…] }
   与国家看板同一套口径与交互：行首 ✕ 悬浮该行才显现→点了隐藏该行；
   隐藏只影响明细行的「显示 + 导出」，合计行来自引擎按筛选范围全量汇总，不随隐藏变。
   按拆分维度分桶存：换维度各记各的，切回来仍在。 ---- */
const REP_HIDE_LS='sb.rep.hidden';
function repRH(){ return (typeof window!=='undefined'&&window.RowHide)?window.RowHide:require('../row-hide-core.js'); }
function repHiddenAll(){ try{ return JSON.parse(localStorage.getItem(REP_HIDE_LS))||{}; }catch(e){ return {}; } }
function repHiddenList(){ return repHiddenAll()[rep.dim]||[]; }
function repSetHidden(arr){ const all=repHiddenAll(); if(arr&&arr.length) all[rep.dim]=arr; else delete all[rep.dim];
  try{ localStorage.setItem(REP_HIDE_LS,JSON.stringify(all)); }catch(e){} }
function repHideRow(key){ repSetHidden(repRH().add(repHiddenList(),key)); }
function repUnhideRow(key){ repSetHidden(repRH().remove(repHiddenList(),key)); }
/* ---- 行自定义顺序(用户 2026-08-24):拖拽后按拆分维度持久化;新行 append 尾部必显示 ---- */
const REP_ORDER_LS='sb.rep.roworder';
function repRO(){ return (typeof window!=='undefined'&&window.RowOrder)?window.RowOrder:require('../row-order-core.js'); }
function repOrderAll(){ try{ return JSON.parse(localStorage.getItem(REP_ORDER_LS))||{}; }catch(e){ return {}; } }
function repOrderGet(){ return repOrderAll()[rep.dim]||[]; }
function repOrderSet(arr){ const all=repOrderAll(); if(arr&&arr.length) all[rep.dim]=arr; else delete all[rep.dim];
  try{ localStorage.setItem(REP_ORDER_LS,JSON.stringify(all)); }catch(e){} }
// 可见行 = 排序后剔除已隐藏,再按自定义序重排；界面/Excel/PPT 三个出口统一走这里
function repVisibleRows(rows,cols){
  let out=repRH().visible(repSortRows(rows,cols),repHiddenList());
  const saved=repOrderGet();
  if(saved.length){ const km={}; out.forEach(o=>{ km[o.key]=o; }); out=repRO().apply(out.map(o=>o.key),saved).map(k=>km[k]); }
  return out;
}

/* 「已隐藏 N 行 ▾」入口 + 恢复面板（对应国家看板卡片头上的同名 chip） */
function ensureRepHideUI(){
  if($('#repHideChip')){ syncRepHideUI(); return; }
  const dimSel=$('#repDim'); if(!dimSel) return; const dimFld=dimSel.closest('.fld'); if(!dimFld) return;
  const row=dimFld.parentNode; if(!row) return;
  const fld=document.createElement('div'); fld.className='fld'; fld.id='repHideFld'; fld.style.position='relative';
  fld.innerHTML='<label>已隐藏行</label><button id="repHideChip" class="btn" style="padding:2px 10px;background:var(--c-brand-soft);color:var(--c-brand);border-color:var(--c-brand)" title="点击管理已隐藏的行（合计不受隐藏影响）"></button>';
  const csFld=$('#repCustomSort')?$('#repCustomSort').closest('.fld'):null;
  const anchor=(csFld&&csFld.parentNode===row)?csFld:dimFld;
  if(anchor.nextSibling) row.insertBefore(fld,anchor.nextSibling); else row.appendChild(fld);
  $('#repHideChip').onclick=toggleRepHidePanel;
  syncRepHideUI();
}
function repAllKeys(){
  const rows=(rep.last&&rep.last.rows)||[];
  const ks=rows.map(o=>o.key);
  repHiddenList().forEach(k=>{ if(ks.indexOf(k)<0) ks.push(k); });
  return ks;
}
function syncRepHideUI(){
  const b=$('#repHideChip'); if(!b) return;
  // 常驻(用户 2026-08-24:没隐藏行时也要看得见入口)——「行 n/N ▾」,面板勾选式
  const n=repRH().count(repHiddenList()), all=repAllKeys().length;
  const fld=$('#repHideFld'); if(fld) fld.style.display='';
  b.textContent='行 '+(all-n)+'/'+all+' ▾';
}
function toggleRepHidePanel(){
  let p=$('#repHidePanel'); if(p){ p.remove(); return; }
  const fld=$('#repHideFld'); if(!fld) return;
  p=document.createElement('div'); p.id='repHidePanel';
  p.style.cssText='position:absolute;top:100%;left:0;z-index:60;background:var(--c-bg-elev);border:1px solid var(--c-line);border-radius:8px;box-shadow:0 10px 30px rgba(0,0,0,.14);padding:8px 10px;max-height:260px;overflow:auto;min-width:200px';
  const hid0=repHiddenList();
  repAllKeys().forEach(k=>{
    const line=document.createElement('label'); line.style.cssText='display:flex;align-items:center;gap:8px;padding:2px 0;font-size:12px;color:var(--c-ink-1);cursor:pointer';
    const ck=document.createElement('input'); ck.type='checkbox'; ck.checked=hid0.indexOf(k)<0;
    ck.onchange=()=>{ if(ck.checked) repUnhideRow(k); else repHideRow(k); renderReportTable(); };
    const nm=document.createElement('span'); nm.textContent=k; nm.style.flex='1';
    line.appendChild(ck); line.appendChild(nm); p.appendChild(line);
  });
  const all=document.createElement('button'); all.textContent='全部恢复'; all.className='btn'; all.style.cssText='margin-top:6px;padding:2px 10px;font-size:11px;width:100%';
  all.onclick=()=>{ repSetHidden([]); renderReportTable(); const q=$('#repHidePanel'); if(q) q.remove(); };
  p.appendChild(all); fld.appendChild(p);
}

function buildRepDimOptions(){
  const sel=$('#repDim'); sel.innerHTML='';
  REP_DIMS.filter(k=>state.dims.includes(k)).forEach(k=>{
    const o=document.createElement('option'); o.value=k; o.textContent=DIM_LABEL[k]||k; if(k===rep.dim)o.selected=true; sel.appendChild(o);
  });
  if(!state.dims.includes(rep.dim)) rep.dim=(REP_DIMS.filter(k=>state.dims.includes(k))[0])||state.dims[0];
  // 周范围变化时重绘并存档（redraw 包裹 drawReport + repStateSave）。
  renderWeekRange('repWeekRange', rep, ()=>{ drawReport(); repStateSave(); });
}
async function renderRepFilters(){
  const bar=$('#repFilterBar'); bar.innerHTML='';
  for(const field of FILTER_FIELDS.filter(k=>state.dims.includes(k))){
    const opts=await api.options(field,rep.filters); if(!opts.length) continue;
    const ms=makeMultiSelect(DIM_LABEL[field]+(field===rep.dim?' ◆':''), opts, asArrLocal(rep.filters[field]), {
      placeholder: field==='channel'?'线上+线下(合计)':'全部',
      onChange:(vals)=>{ rep.filters[field]=vals; drawReport(); repStateSave(); },
      onCommit:async(vals)=>{ rep.filters[field]=vals;
        const order=GEO_ORDER.includes(field)?GEO_ORDER:(PROD_ORDER.includes(field)?PROD_ORDER:[]); const idx=order.indexOf(field);
        order.slice(idx+1).forEach(d=>delete rep.filters[d]);
        await renderRepFilters(); drawReport(); repStateSave(); },
    });
    bar.appendChild(ms);
  }
}
function repColumns(r){
  const cy=r.curYear%100, py=r.prevYear%100, wl=r.weekLabels||[];
  const fcell=v=>r.hasFlow?numCell(v):'<span class="wk">—</span>';
  const cols=[
    {key:'key',label:DIM_LABEL[rep.dim]||rep.dim,left:true,get:o=>o.key,cell:o=>o.key},
    {key:'cumCur',label:cy+'累计SO',get:o=>o.cumCur,cell:o=>numCell(o.cumCur)},
    {key:'cumPrev',label:py+'同期SO',get:o=>o.cumPrev,cell:o=>numCell(o.cumPrev)},
    {key:'yoy',label:'SO同比',get:o=>o.yoy==null?-1e18:o.yoy,cell:o=>pctCell(o.yoy)},
    {key:'siCur',label:cy+'累计SI',sep:true,get:o=>o.siCur,cell:o=>numCell(o.siCur)},
    {key:'siPrev',label:py+'同期SI',get:o=>o.siPrev,cell:o=>numCell(o.siPrev)},
    {key:'siYoy',label:'SI同比',get:o=>o.siYoy==null?-1e18:o.siYoy,cell:o=>pctCell(o.siYoy)},
  ];
  wl.forEach((w,i)=>cols.push({key:'w'+i,label:w,wk:true,sep:i===0,get:o=>o.weekly[i]||0,cell:o=>`<span class="wk">${numCell(o.weekly[i])}</span>`}));
  cols.push({key:'wow',label:'WoW%',get:o=>o.wow==null?-1e18:o.wow,cell:o=>pctCell(o.wow)});
  cols.push({key:'inv',label:'库存(pcs)',sep:true,get:o=>o.inv,cell:o=>numCell(o.inv)});
  cols.push({key:'dos',label:'DOS',get:o=>o.dos,cell:o=>dosCell(o.dos,'channel')});
  cols.push({key:'flowInv',label:'全流程库存',sep:true,get:o=>o.flowInv||0,cell:o=>fcell(o.flowInv)});
  cols.push({key:'flowDos',label:'全流程DOS',get:o=>o.flowDos||0,cell:o=>r.hasFlow?dosCell(o.flowDos,'flow'):'<span class="wk">—</span>'});
  cols.push({key:'dcfdc',label:'国家仓+FDC',get:o=>o.dcfdc||0,cell:o=>fcell(o.dcfdc)});
  return cols;
}
/* 行排序：开关关→默认(累计SO 高→低)；开→按点中的那列。纯函数，不改入参。 */
function repSortRows(rows,cols){
  return repTS().sortRows(rows,{ custom:rep.custom, key:rep.sortKey, dir:rep.sortDir, cols:cols,
    fallback:rs=>rs.sort((a,b)=>(b.cumCur||0)-(a.cumCur||0)) });
}
function renderReportTable(){
  const r=rep.last; if(!r) return;
  const TS=repTS();
  const cols=repColumns(r);
  const st={custom:rep.custom,key:rep.sortKey,dir:rep.sortDir,cols:cols};
  // 开关关：表头不可点、不出箭头（无 sortable 类=无手型/无 hover），保证「关掉=完全回到默认」
  // 行首「隐藏」按钮列：纯界面元素，不进任何导出；✕ 默认透明，hover 到该行才显现(CSS .row-hide-btn)
  const thead='<tr><th style="width:20px"></th>'+cols.map(c=>`<th data-k="${c.key}" class="${rep.custom?'sortable':''}${c.sep?' col-sep':''}${c.wk?' wk':''}"${rep.custom?' title="点击按此列排序（再点切换升↔降）"':''}>${c.label}${TS.arrow(c.key,st)}</th>`).join('')+'</tr>';
  const rows=repVisibleRows(r.rows,cols);
  const hideTd=o=>`<td style="white-space:nowrap"><button class="cb-hide-btn row-hide-btn" data-hiderow="${encodeURIComponent(o.key)}" title="隐藏此行（不影响合计，上方「行」chip 可恢复）" style="border:none;background:none;color:var(--c-ink-3);cursor:pointer;font-size:11px;line-height:1;padding:0 3px">✕</button><span style="cursor:grab;color:var(--c-ink-3);font-size:10px" title="按住整行拖动调顺序(会记住)">⠿</span></td>`;
  const rowHtml=(o,cls)=>'<tr class="'+(cls||'')+'"'+(cls==='total'?'':' draggable="true" data-rowkey="'+encodeURIComponent(o.key)+'"')+'>'+(cls==='total'?'<td></td>':hideTd(o))+cols.map(c=>`<td class="${c.left?'':''}${c.sep?' col-sep':''}${c.wk?' wk':''}">${c.cell(o)}</td>`).join('')+'</tr>';
  const tbl=$('#repTable'); if(tbl&&tbl.classList) tbl.classList.add('has-hidecol');   // 让维度名列继续钉住左侧（✕ 列不抢 first-child 的 sticky）
  tbl.innerHTML=thead+rows.map(o=>rowHtml(o)).join('')+(r.total?rowHtml(r.total,'total'):'');
  syncRepHideUI();
  // 整行拖拽:drop 时以当前显示序为基础移动整体存档
  (function(){
    let drag=null;
    tbl.querySelectorAll('tr[data-rowkey]').forEach(tr=>{
      tr.ondragstart=e=>{ drag=tr.dataset.rowkey; try{ e.dataTransfer.effectAllowed='move'; }catch(_){ } };
      tr.ondragover=e=>e.preventDefault();
      tr.ondrop=e=>{
        e.preventDefault();
        if(drag==null) return;
        const keys=[...tbl.querySelectorAll('tr[data-rowkey]')].map(x=>x.dataset.rowkey);
        const from=keys.indexOf(drag), to=keys.indexOf(tr.dataset.rowkey);
        drag=null;
        if(from<0||to<0||from===to) return;
        repOrderSet(repRO().move(keys,from,to).map(decodeURIComponent));
        renderReportTable(); repStateSave&&repStateSave();
      };
    });
  })();
  if(rep.custom) $$('#repTable th.sortable').forEach(th=>th.onclick=()=>{ const k=th.dataset.k;
    const nx=TS.nextSort({key:rep.sortKey,dir:rep.sortDir},k,TS.findCol(cols,k));
    rep.sortKey=nx.key; rep.sortDir=nx.dir; renderReportTable(); repStateSave(); });
}
async function drawReport(){
  if(!state.dims.length){ rep.noteBase=null; $('#repTable').innerHTML=''; $('#repNote').textContent='请先锚定文件夹或载入示例'; return; }
  ensureRepCustomSortUI();
  ensureRepHideUI();
  const token=++rep.token;
  const r=await api.report({groupDim:rep.dim,weeks:rep.weeks,fromW:rep.fromW,toW:rep.toW,filters:rep.filters});
  if(token!==rep.token) return;
  rep.last=r;
  if(r.error){ rep.noteBase=null; $('#repNote').textContent='出错：'+r.error; return; }   // noteBase 置空：切开关不覆盖报错文案
  rep.noteBase = (r.hasPrev? `同比基于去年同期` : `⚠ 未发现去年数据，同比列为空——把去年的 PSI 表也放进文件夹`)
    + ` · 库存=最新周快照，DOS=库存×28÷近4周SO · `
    + (r.hasFlow? `国家仓+FDC=库龄表最新日期(${state.flowDate||''})的CDC+FDC库存，全流程库存=渠道库存(INV)+国家仓+FDC` : `全流程列需把库龄表放进库存文件夹`);
  repApplyNote();
  renderReportTable();
}
async function exportRepXlsx(){
  const r=rep.last; if(!r||!r.rows.length){ toast('暂无数据','err'); return; }
  const cy=r.curYear%100, py=r.prevYear%100;
  const head=[DIM_LABEL[rep.dim]||rep.dim, cy+'年累计SO', py+'年同期SO','SO同比', cy+'年累计SI', py+'年同期SI','SI同比'].concat(r.weekLabels).concat(['WoW%','库存(pcs)','DOS','全流程库存','全流程DOS','国家仓+FDC']);
  // cols: 0=key 1=cumCur 2=cumPrev 3=SO同比 4=siCur 5=siPrev 6=SI同比 …
  const aoa=[head];
  const fv=v=>r.hasFlow?(v==null?'':v):'';
  const pc=v=>v==null?'':+(v*100).toFixed(1)+'%';
  const nz=v=>v==null||!isFinite(v)?'':v;
  const line=o=>[o.key,nz(o.cumCur),nz(o.cumPrev),nz(o.yoy),nz(o.siCur),nz(o.siPrev),nz(o.siYoy)].concat(o.weekly).concat([pc(o.wow),o.inv,o.dos,fv(o.flowInv),fv(o.flowDos),fv(o.dcfdc)]);
  const dataRowIdxs=[];
  // 导出与界面同序同筛(用户 2026-08-24:拖拽序+隐藏,所见即所出)
  repVisibleRows(r.rows,repColumns(r)).forEach(o=>{ dataRowIdxs.push(aoa.length); aoa.push(line(o)); });
  if(r.total){ dataRowIdxs.push(aoa.length); aoa.push(line(r.total)); }
  const ws=XLSX.utils.aoa_to_sheet(aoa);
  const C=window.FinCalc, EU=window.ExportUtil;
  EU.applyRowYoy(XLSX, ws, C, {rows:dataRowIdxs, curCol:1, prevCol:2, yoyCol:3, z:'0.0%'}); // SO同比
  EU.applyRowYoy(XLSX, ws, C, {rows:dataRowIdxs, curCol:4, prevCol:5, yoyCol:6, z:'0.0%'}); // SI同比
  const wb=XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb,ws,'汇总表');
  const b64=XLSX.write(wb,{bookType:'xlsx',type:'base64'});
  const res=await api.saveFile('汇总表_'+(DIM_LABEL[rep.dim]||rep.dim)+'_'+todayStr()+'.xlsx',b64,'xlsx');
  if(res&&res.path) toast('已导出','ok');
}
async function exportRepPpt(){
  const r=rep.last; if(!r||!r.rows.length){ toast('暂无数据','err'); return; }
  const cy=r.curYear%100, py=r.prevYear%100;
  const pptx=new PptxGenJS(); pptx.defineLayout({name:'W',width:13.333,height:7.5}); pptx.layout='W';
  const s=pptx.addSlide();
  s.addText('PSI 汇总表 · 按'+(DIM_LABEL[rep.dim]||rep.dim),{x:0.4,y:0.2,w:12.5,h:0.5,fontFace:'微软雅黑',fontSize:18,bold:true,color:'C7000B'});
  const num=v=>v==null?'—':Math.round(v).toLocaleString('en-US');
  const cell=(t,o)=>({text:String(t),options:Object.assign({fontFace:'微软雅黑',fontSize:8,align:'right',valign:'middle'},o||{})});
  const pctCellPpt=(v,bold)=>cell(v==null?'—':(v*100).toFixed(0)+'%',{color:v==null?'888888':(v>=0?'1E9E57':'C7000B'),bold:!!bold});
  const headTexts=[(DIM_LABEL[rep.dim]||rep.dim),cy+'累计SO',py+'同期','SO同比',cy+'累计SI',py+'同期SI','SI同比'].concat(r.weekLabels).concat(['WoW','库存','DOS']);
  const rowsArr=[ headTexts.map((h,i)=>cell(h,{bold:true,color:'FFFFFF',fill:{color:'C7000B'},align:'center'})) ];
  const mkrow=(o,tot)=>{
    const row=[cell(o.key,{align:'left',bold:!!tot,fill:tot?{color:'FFF1F1'}:undefined})];
    row.push(cell(num(o.cumCur),{bold:!!tot}),cell(num(o.cumPrev),{bold:!!tot}),pctCellPpt(o.yoy,tot),cell(num(o.siCur),{bold:!!tot}),cell(num(o.siPrev),{bold:!!tot}),pctCellPpt(o.siYoy,tot));
    o.weekly.forEach(v=>row.push(cell(num(v),{color:'5A5F66'})));
    row.push(pctCellPpt(o.wow,tot),cell(num(o.inv),{bold:!!tot}),cell(num(o.dos),{bold:!!tot}));
    return row;
  };
  repVisibleRows(r.rows,repColumns(r)).forEach(o=>rowsArr.push(mkrow(o)));   // PPT 与界面同序同筛
  if(r.total)rowsArr.push(mkrow(r.total,true));
  s.addTable(rowsArr,{x:0.3,y:0.8,w:12.7,border:{type:'solid',color:'E6E8EB',pt:0.5},autoPage:true,autoPageRepeatHeader:true});
  const b64=await pptx.write('base64');
  const res=await api.saveFile('汇总表_'+(DIM_LABEL[rep.dim]||rep.dim)+'_'+todayStr()+'.pptx',b64,'pptx');
  if(res&&res.path) toast('已导出（PPT 原生表格，可编辑）','ok');
}

/* ---- 事件绑定(从 app.js init() 搬来，保持同位置顺序) ---- */
function initReportView(){
  // report controls
  $('#repDim').onchange=e=>{ rep.dim=e.target.value; drawReport(); repStateSave(); };
  $('#repExportXlsx').onclick=exportRepXlsx;
  $('#repExportPpt').onclick=exportRepPpt;
  // 行首 ✕ 隐藏行（事件委托：表格 innerHTML 每次重绘，监听挂在常驻的 table 上）
  $('#repTable').addEventListener('click',e=>{
    const hb=e.target.closest&&e.target.closest('button[data-hiderow]'); if(!hb) return;
    repHideRow(decodeURIComponent(hb.dataset.hiderow)); renderReportTable();
  });
}

/* 供单测 require（浏览器端 module 未定义，自动跳过；不影响运行时） */
if(typeof module!=='undefined'&&module.exports){ module.exports={rep,repSortRows,repVisibleRows,repHideRow,repUnhideRow,repHiddenList,repSetHidden}; }

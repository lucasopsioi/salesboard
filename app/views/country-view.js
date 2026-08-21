'use strict';
/* ============================================================
   Salesboard — views/country-view.js
   国家看板视图：从上到下列出每个国家(或国家办)的汇总表 + 单国/整表导出。
   纯搬运：从 app.js 原样剪切，无逻辑改动。依赖 common.js（在本文件之前加载）。
   ============================================================ */

/* ============================================================
   国家看板：从上到下列出每个国家(或国家办)的汇总表
   ============================================================ */
/* sortKey/sortDir 只在「自定义排序」开(custom=true)时生效；关=默认排序(见 cbSortRows 的 fallback)。
   关开关不清空 sortKey/sortDir，再打开回到上次那一列。blockSort 是「块(国家/国家办)」的上下顺序，与本开关无关。 */
const cb={scope:'country',dim:'series',weeks:9,fromW:null,toW:null,filters:{},last:[],token:0,custom:false,sortKey:null,sortDir:-1,blockSort:{key:'cumCur',dir:-1}};
// 排序内核：浏览器取 window.TableSort，Node 单测走 require
function cbTS(){ return (typeof window!=='undefined'&&window.TableSort)?window.TableSort:require('../table-sort-core.js'); }
function cbSortState(cols){ return {custom:cb.custom,key:cb.sortKey,dir:cb.sortDir,cols:cols}; }
function buildCbDimOptions(){
  const sel=$('#cbDim'); sel.innerHTML='';
  ['series','product','model','line','family'].filter(k=>state.dims.includes(k)).forEach(k=>{
    const o=document.createElement('option'); o.value=k; o.textContent=DIM_LABEL[k]||k; if(k===cb.dim)o.selected=true; sel.appendChild(o); });
  if(!state.dims.includes(cb.dim)) cb.dim=['series','product','line'].find(k=>state.dims.includes(k))||state.dims[0];
  // scope select default
  if(!state.dims.includes(cb.scope)) cb.scope=state.dims.includes('country')?'country':'repOffice';
  $('#cbScope').value=cb.scope;
  renderWeekRange('cbWeekRange', cb, drawCountryBoard);
}
async function renderCbFilters(){
  const bar=$('#cbFilters'); bar.innerHTML='';
  for(const field of ['country','repOffice','family','line','series','product','model','channel'].filter(k=>state.dims.includes(k))){
    const opts=await api.options(field,cb.filters); if(!opts.length) continue;
    let cur=asArrLocal(cb.filters[field]).filter(v=>opts.includes(v));
    if(cur.length) cb.filters[field]=cur; else delete cb.filters[field];
    const ms=makeMultiSelect(DIM_LABEL[field], opts, cur, {
      placeholder: field==='channel'?'线上+线下(合计)':'全部',
      onChange:(vals)=>{ cb.filters[field]=vals; },
      onCommit:async(vals)=>{ cb.filters[field]=vals; await renderCbFilters(); drawCountryBoard(); },
    });
    bar.appendChild(ms);
  }
}
function cbColumns(r){
  const cyy=r.curYear%100, py=r.prevYear%100, wl=r.weekLabels||[];
  const fcell=v=>r.hasFlow?numCell(v):'<span class="wk">—</span>';
  const cols=[];
  const showSeries=(cb.dim==='model' && state.dims.includes('line'));
  const skuLevel=(cb.dim==='product'||cb.dim==='model'); // 产品/型号维度逐档比25年因上市路标失真→明细留空仅合计；系列/产品线/家族不失真→明细也显示
  if(showSeries) cols.push({key:'__line',label:'Product Series',left:true,merge:true,get:o=>o.line||'',cell:o=>o.line||''});
  cols.push({key:'key',label:DIM_LABEL[cb.dim],left:true,get:o=>o.key,cell:o=>o.key});
  // 同期SO/SI + 同比：合计行恒显示；明细行仅在非产品/型号维度(系列/产品线/家族不失真)显示，产品/型号维度留空
  cols.push({key:'cumCur',label:cyy+'累计SO',get:o=>o.cumCur,cell:o=>numCell(o.cumCur)});
  cols.push({key:'cumPrev',label:py+'同期SO总',totalOnly:skuLevel,get:o=>o.cumPrev,cell:o=>numCell(o.cumPrev)});
  cols.push({key:'yoy',label:'SO同比',totalOnly:skuLevel,get:o=>o.yoy==null?-1e18:o.yoy,cell:o=>pctCell(o.yoy)});
  cols.push({key:'siCur',label:cyy+'累计SI',sep:true,get:o=>o.siCur,cell:o=>numCell(o.siCur)});
  cols.push({key:'siPrev',label:py+'同期SI总',totalOnly:skuLevel,get:o=>o.siPrev,cell:o=>numCell(o.siPrev)});
  cols.push({key:'siYoy',label:'SI同比',totalOnly:skuLevel,get:o=>o.siYoy==null?-1e18:o.siYoy,cell:o=>pctCell(o.siYoy)});
  wl.forEach((w,i)=>cols.push({key:'w'+i,label:w,wk:true,sep:i===0,get:o=>o.weekly[i]||0,cell:o=>`<span class="wk">${numCell(o.weekly[i])}</span>`}));
  cols.push({key:'wow',label:'WoW%',get:o=>o.wow==null?-1e18:o.wow,cell:o=>pctCell(o.wow)});
  cols.push({key:'inv',label:'库存',sep:true,get:o=>o.inv,cell:o=>numCell(o.inv)});
  cols.push({key:'dos',label:'DOS',get:o=>o.dos,cell:o=>dosCell(o.dos,'channel')});
  if(r.hasFlow){ cols.push({key:'flowInv',label:'全流程库存',sep:true,get:o=>o.flowInv||0,cell:o=>fcell(o.flowInv)});
    cols.push({key:'flowDos',label:'全流程DOS',get:o=>o.flowDos||0,cell:o=>dosCell(o.flowDos,'flow')});
    cols.push({key:'dcfdc',label:'国家仓+FDC',get:o=>o.dcfdc||0,cell:o=>fcell(o.dcfdc)}); }
  return cols;
}
// 排序：自定义排序【开】且点了表头→按该列；【关】→默认排序(下面 fallback，与改造前逐字一致)：
// 按型号拆分时按左侧系列归并再系列序；按系列拆分时按产品系列高→低端(SERIES_ORDER)；其余按累计SO 高→低
function cbSortRows(r,cols){
  const showSeries=cols.some(c=>c.key==='__line');
  return cbTS().sortRows(r&&r.rows,Object.assign(cbSortState(cols),{ fallback:rows=>{
    if(showSeries) rows.sort((a,b)=>{ const ra=seriesRank(a.line),rb=seriesRank(b.line); if(ra!==rb)return ra-rb; if((a.line||'')!==(b.line||''))return String(a.line).localeCompare(String(b.line),'zh'); return b.cumCur-a.cumCur; });
    else if(cb.dim==='series') rows.sort((a,b)=>{ const ra=seriesRank(a.key),rb=seriesRank(b.key); return ra!==rb?ra-rb:(b.cumCur-a.cumCur); });
    else rows.sort((a,b)=>b.cumCur-a.cumCur);
    return rows;
  } }));
}
/* ---- 自定义排序开关（与汇总表同款）：跨启动记住开关状态；选中列本会话有效(切维度/看板维度仍会重置) ---- */
const CB_SORT_LS='sb.cb.customSort';
let cbSortRestored=false;
function cbSortRestore(){ if(cbSortRestored) return; cbSortRestored=true;
  try{ cb.custom=(localStorage.getItem(CB_SORT_LS)==='1'); }catch(e){} }
function cbSortSave(){ try{ localStorage.setItem(CB_SORT_LS,cb.custom?'1':'0'); }catch(e){} }
function syncCbCustomSortUI(){
  const b=$('#cbCustomSort'); if(!b) return; const TS=cbTS();
  b.textContent=TS.btnLabel(cb.custom); b.title=TS.BTN_TITLE;
  b.style.background=cb.custom?'var(--c-brand-soft)':''; b.style.borderColor=cb.custom?'var(--c-brand)':''; b.style.color=cb.custom?'var(--c-brand)':'';
}
function ensureCbCustomSortUI(){
  cbSortRestore();
  if($('#cbCustomSort')){ syncCbCustomSortUI(); return; }
  const dimSel=$('#cbDim'); if(!dimSel) return; const dimFld=dimSel.closest('.fld'); if(!dimFld) return;
  const row=dimFld.parentNode; if(!row) return;
  const fld=document.createElement('div'); fld.className='fld';
  fld.innerHTML='<label>行排序</label><button id="cbCustomSort" class="btn" style="padding:2px 10px"></button>';
  const bsFld=$('#cbBlockSort')?$('#cbBlockSort').closest('.fld'):null;   // 排在「国家/国家办排序」之后，块序与行序相邻
  const anchor=(bsFld&&bsFld.parentNode===row)?bsFld:dimFld;
  if(anchor.nextSibling) row.insertBefore(fld,anchor.nextSibling); else row.appendChild(fld);
  $('#cbCustomSort').onclick=()=>{ cb.custom=!cb.custom; syncCbCustomSortUI(); cbSortSave(); renderCbCards(); cbApplyNote(); };
  syncCbCustomSortUI();
}
// 说明文字里的排序那一段：切开关时只重绘卡片，note 要单独刷新（否则措辞停在上一个状态）
function cbSortNote(){ return cb.custom
  ? ' · 自定义排序【开】：点表头按该列排(块内行，所有块同步，▲升 ▼降)'
  : ' · 默认排序：系列高→低端/累计SO高→低（开「自定义排序」可点表头自选列）'; }
function cbApplyNote(){ const el=$('#cbNote'); if(el&&cb.noteBase!=null) el.textContent=cb.noteBase+cbSortNote()+' · 每块右上可单独导出'; }
/* ---- 隐藏行(跨启动记住)：localStorage sb.cb.hidden = { "看板维度|块名|拆分维度": [行key,…] }
   隐藏只影响显示/导出的明细行；合计行来自引擎按筛选范围全量汇总，不随隐藏变。 ---- */
const CB_HIDE_LS='sb.cb.hidden';
// 隐藏行内核：浏览器取 window.RowHide，Node 单测走 require
function cbRH(){ return (typeof window!=='undefined'&&window.RowHide)?window.RowHide:require('../row-hide-core.js'); }
function cbHiddenAll(){ try{ return JSON.parse(localStorage.getItem(CB_HIDE_LS))||{}; }catch(e){ return {}; } }
function cbHiddenKey(v){ return cb.scope+'|'+v+'|'+cb.dim; }
function cbHiddenList(v){ return cbHiddenAll()[cbHiddenKey(v)]||[]; }
function cbSetHidden(v,arr){ const all=cbHiddenAll(); if(arr&&arr.length) all[cbHiddenKey(v)]=arr; else delete all[cbHiddenKey(v)];
  try{ localStorage.setItem(CB_HIDE_LS,JSON.stringify(all)); }catch(e){} }
function cbHideRow(v,key){ cbSetHidden(v,cbRH().add(cbHiddenList(v),key)); }
function cbUnhideRow(v,key){ cbSetHidden(v,cbRH().remove(cbHiddenList(v),key)); }
// 可见行 = 排序后剔除已隐藏；界面/Excel/图片/PPT 四个出口统一走这里
function cbVisibleRows(v,r,cols){ return cbRH().visible(cbSortRows(r,cols),cbHiddenList(v)); }

/* ---- 保存缩放(跨启动记住)：localStorage sb.cb.zoom；渲染后自动应用到每张表 ---- */
const CB_ZOOM_LS='sb.cb.zoom';
function cbSavedZoom(){ const z=parseFloat(localStorage.getItem(CB_ZOOM_LS)); return isFinite(z)&&z>0?z:null; }
function applyCbZoom(){ const z=cbSavedZoom(); if(z==null) return;
  document.querySelectorAll('#cbList .cb-table-wrap').forEach(w=>{ w.style.zoom=(z===1?'':z); }); }
function saveCbZoom(){
  const list=$('#cbList'); if(!list) return;
  const lz=parseFloat(list.style.zoom)||1;
  const wraps=[...list.querySelectorAll('.cb-table-wrap')];
  const zw=wraps.find(x=>x.style.zoom&&isFinite(parseFloat(x.style.zoom)));
  const wz=zw?(parseFloat(zw.style.zoom)||1):1;
  const z=Math.round(lz*wz*100)/100; // 实际视觉倍数=列表缩放×单表缩放
  try{ localStorage.setItem(CB_ZOOM_LS,String(z)); }catch(e){}
  list.style.zoom=''; wraps.forEach(x=>x.style.zoom=(z===1?'':z));
  const btn=$('#cbZoomSave'); if(btn) btn.textContent='💾 保存缩放('+Math.round(z*100)+'%)';
  toast('已保存缩放 '+Math.round(z*100)+'%（下次打开自动应用）','ok');
}
function ensureCbZoomUI(){
  if($('#cbZoomSave')) return;
  const scopeSel=$('#cbScope'); if(!scopeSel) return; const row=scopeSel.closest('.psi-row'); if(!row) return;
  const fld=document.createElement('div'); fld.className='fld';
  const z=cbSavedZoom();
  fld.innerHTML='<label>缩放</label><button id="cbZoomSave" class="btn" style="padding:2px 10px" title="记住当前 Ctrl+滚轮 调好的缩放，下次打开/每次重绘自动应用">💾 保存缩放'+(z!=null&&z!==1?'('+Math.round(z*100)+'%)':'')+'</button>';
  row.appendChild(fld);
  $('#cbZoomSave').onclick=saveCbZoom;
}

function cbTableHtml(v,r){
  const cols=cbColumns(r);
  const TS=cbTS(); const st=cbSortState(cols);
  const showSeries=cols.some(c=>c.key==='__line');
  let rows=cbVisibleRows(v,r,cols);
  const doMerge=showSeries && !TS.isActive(st);   // 只有默认序才按系列合并单元格；自定义排序会打散系列归并
  // 行首「隐藏」按钮列：纯界面元素，不进任何导出
  // 开关关：表头不可点、不出箭头（无 sortable 类=无手型/无 hover），保证「关掉=完全回到默认」
  const thead='<tr><th style="width:20px"></th>'+cols.map(c=>`<th data-k="${c.key}" class="${cb.custom?'sortable':''}${c.sep?' col-sep':''}${c.wk?' wk':''}"${cb.custom?' title="点击按此列排序（再点切换升↔降）· 所有国家的表同步"':''}>${c.label}${TS.arrow(c.key,st)}</th>`).join('')+'</tr>';
  let body='';
  for(let i=0;i<rows.length;i++){ const o=rows[i];
    let tds=`<td><button class="cb-hide-btn row-hide-btn" data-hiderow="${encodeURIComponent(o.key)}" title="隐藏此行（不影响合计，可在卡片头恢复）" style="border:none;background:none;color:var(--c-ink-3);cursor:pointer;font-size:11px;line-height:1;padding:0 3px">✕</button></td>`;
    cols.forEach(c=>{
      if(c.key==='__line' && doMerge){
        if(i>0 && (rows[i-1].line||'')===(o.line||'')) return; // 已被上面 rowspan 合并
        let span=1; while(i+span<rows.length && (rows[i+span].line||'')===(o.line||'')) span++;
        tds+=`<td class="col-sep" rowspan="${span}" style="vertical-align:middle;font-weight:600;background:var(--c-bg-sunken)">${o.line||''}</td>`;
      } else { const cv = c.totalOnly ? '<span class="wk">—</span>' : c.cell(o); tds+=`<td class="${c.sep?'col-sep':''}${c.wk?' wk':''}">${cv}</td>`; }
    });
    body+='<tr>'+tds+'</tr>';
  }
  if(r.total){ let tds='<td></td>'; cols.forEach(c=>{ if(c.key==='__line') tds+='<td class="col-sep"></td>'; else tds+=`<td class="${c.sep?'col-sep':''}">${c.key==='key'?'合计':c.cell(r.total)}</td>`; }); body+='<tr class="total">'+tds+'</tr>'; }
  return thead+body;
}
function renderCbCard(v,r){
  const card=document.createElement('div'); card.className='cb-card'; card.dataset.v=v;
  const head=document.createElement('div'); head.className='cb-head'; head.style.position='relative';
  const t=r.total||{}; const cyy=r.curYear%100;
  const hidList=cbHiddenList(v);
  head.innerHTML=`<span class="nm">${v}</span>`
    +`<span class="chip">${cyy}累计SO <b>${fmt(t.cumCur)}</b></span>`
    +`<span class="chip">同比 <b class="${t.yoy==null?'':(t.yoy>=0?'pos':'neg')}">${t.yoy==null?'—':(t.yoy*100).toFixed(0)+'%'}</b></span>`
    +`<span class="chip">库存 <b>${fmt(t.inv)}</b></span>`
    +`<span class="chip">DOS <b>${t.dos||'—'}</b></span>`
    +(hidList.length?`<span class="chip cb-hidchip" style="cursor:pointer;background:var(--c-brand-soft);color:var(--c-brand)" title="点击管理已隐藏的行（合计不受隐藏影响）">已隐藏 ${hidList.length} 行 ▾</span>`:'')
    +`<span class="fa-exp"><button data-ex="xlsx">📊 Excel</button><button data-ex="png">🖼 图片</button></span>`;
  const wrapEl=document.createElement('div'); wrapEl.className='cb-table-wrap';
  const tbl=document.createElement('table'); tbl.className='rep-table'; tbl.innerHTML=cbTableHtml(v,r); wrapEl.appendChild(tbl);
  head.querySelectorAll('.fa-exp button').forEach(btn=>btn.onclick=()=>{ if(btn.dataset.ex==='xlsx') exportCbCardXlsx(v,r); else exportCbCardPng(v,r); });
  const chip=head.querySelector('.cb-hidchip');
  if(chip) chip.onclick=()=>{
    let p=head.querySelector('.cb-hid-panel'); if(p){ p.remove(); return; }
    p=document.createElement('div'); p.className='cb-hid-panel';
    p.style.cssText='position:absolute;top:calc(100% - 4px);left:'+Math.max(8,chip.offsetLeft)+'px;z-index:60;background:var(--c-bg-elev);border:1px solid var(--c-line);border-radius:8px;box-shadow:0 10px 30px rgba(0,0,0,.14);padding:8px 10px;max-height:260px;overflow:auto;min-width:200px';
    cbHiddenList(v).forEach(k=>{
      const row=document.createElement('div'); row.style.cssText='display:flex;align-items:center;gap:10px;padding:2px 0;font-size:12px;color:var(--c-ink-1)';
      const nm=document.createElement('span'); nm.textContent=k; nm.style.flex='1';
      const btn=document.createElement('button'); btn.textContent='恢复'; btn.className='btn'; btn.style.cssText='padding:1px 8px;font-size:11px';
      btn.onclick=()=>{ cbUnhideRow(v,k); renderCbCards(); };
      row.appendChild(nm); row.appendChild(btn); p.appendChild(row);
    });
    const all=document.createElement('button'); all.textContent='全部恢复'; all.className='btn'; all.style.cssText='margin-top:6px;padding:2px 10px;font-size:11px;width:100%';
    all.onclick=()=>{ cbSetHidden(v,[]); renderCbCards(); };
    p.appendChild(all);
    head.appendChild(p);
  };
  card.appendChild(head); card.appendChild(wrapEl);
  return card;
}
// 单国导出：Excel
async function exportCbCardXlsx(v,r){
  const wb=XLSX.utils.book_new(); cbSheetInto(wb,v,r);
  const b64=XLSX.write(wb,{bookType:'xlsx',type:'base64'});
  const res=await api.saveFile('国家看板_'+String(v).replace(/[\\/:*?"<>|]/g,'_')+'_'+todayStr()+'.xlsx',b64,'xlsx'); if(res&&res.path)toast('已导出','ok');
}
// 单国导出：图片(画布)
async function exportCbCardPng(v,r){
  const cols=cbColumns(r); const rows=cbVisibleRows(v,r,cols);
  const header=cols.map(c=>c.label);
  const body=rows.map(o=>({cells:cols.map(c=>c.totalOnly?{t:'—',c:'wk'}:cellPlain(c.cell(o)))}));
  if(r.total) body.push({tot:true, cells:cols.map(c=>c.key==='__line'?{t:''}:(c.key==='key'?{t:'合计'}:cellPlain(c.cell(r.total))))});
  const b64=drawTablePNG(v+' · '+DIM_LABEL[cb.dim]+'明细', header, body);
  const res=await api.saveFile('国家看板_'+String(v).replace(/[\\/:*?"<>|]/g,'_')+'_'+todayStr()+'.png',b64,'png'); if(res&&res.path)toast('已导出图片','ok');
}
async function drawCountryBoard(){
  if(!state.dims.length){ cb.noteBase=null; $('#cbList').innerHTML=''; $('#cbNote').textContent='请先锚定文件夹或载入示例'; return; }   // noteBase 置空：切开关不覆盖该提示
  ensureCbBlockSortUI();
  ensureCbCustomSortUI();
  ensureCbZoomUI();
  const token=++cb.token;
  const scope=cb.scope;
  const scopeVals=await api.options(scope, cb.filters);
  if(token!==cb.token) return;
  const skuLevel=(cb.dim==='product'||cb.dim==='model');
  const yoyNote=skuLevel?'25年同期SO/SI及同比仅「合计」行显示(逐产品比因上市路标不同会失真)':'25年同期SO/SI及同比在明细+合计行均显示';
  cb.noteBase='共 '+scopeVals.length+' 个'+(scope==='country'?'国家':'国家办')+' · 每块按「'+DIM_LABEL[cb.dim]+'」拆分'+(cb.dim==='model'?'(左侧按产品系列归并)':'')+' · '+yoyNote;
  cbApplyNote();
  const reps=await Promise.all(scopeVals.map(v=>{
    const f=Object.assign({},cb.filters,{[scope]:[v]});
    return api.report({groupDim:cb.dim,weeks:cb.weeks,fromW:cb.fromW,toW:cb.toW,filters:f}).then(r=>({v,r}));
  }));
  if(token!==cb.token) return;
  cb.last=reps;
  sortCbBlocks();
  renderCbCards();
}
function renderCbCards(){ const list=$('#cbList'); list.innerHTML=''; (cb.last||[]).forEach(({v,r})=>list.appendChild(renderCbCard(v,r))); applyCbZoom(); }
// 国家/国家办「块」上下顺序：独立排序下拉(按合计行指标或名称 + 升降)
function sortCbBlocks(){
  const bs=cb.blockSort||{key:'cumCur',dir:-1}; const key=bs.key, dir=bs.dir;
  (cb.last||[]).sort((a,b)=>{
    if(key==='name') return String(a.v).localeCompare(String(b.v),'zh')*dir;
    const va=(a.r&&a.r.total&&a.r.total[key])||0, vb=(b.r&&b.r.total&&b.r.total[key])||0;
    return (va-vb)*dir;
  });
}
function syncCbBlockSortUI(){
  const lab=$('#cbBlockSortLab'); if(lab) lab.textContent=(cb.scope==='repOffice'?'国家办':'国家')+'排序';
  const dirBtn=$('#cbBlockSortDir'); if(dirBtn) dirBtn.textContent=cb.blockSort.dir<0?'↓':'↑';
  const sel=$('#cbBlockSort'); if(sel) sel.value=cb.blockSort.key;
}
function ensureCbBlockSortUI(){
  if($('#cbBlockSort')){ syncCbBlockSortUI(); return; }
  const scopeSel=$('#cbScope'); if(!scopeSel) return; const row=scopeSel.closest('.psi-row'); if(!row) return;
  const fld=document.createElement('div'); fld.className='fld';
  fld.innerHTML='<label id="cbBlockSortLab">国家排序</label>'
    +'<span style="display:inline-flex;gap:4px;align-items:center">'
    +'<select id="cbBlockSort"><option value="cumCur">累计SO</option><option value="siCur">累计SI</option><option value="inv">库存</option><option value="dos">DOS</option><option value="name">名称</option></select>'
    +'<button id="cbBlockSortDir" class="btn" style="padding:2px 9px" title="升/降序">↓</button></span>';
  const dimFld=$('#cbDim')?$('#cbDim').closest('.fld'):null;
  if(dimFld && dimFld.nextSibling) row.insertBefore(fld, dimFld.nextSibling); else row.appendChild(fld);
  $('#cbBlockSort').onchange=e=>{ cb.blockSort.key=e.target.value; sortCbBlocks(); renderCbCards(); };
  $('#cbBlockSortDir').onclick=()=>{ cb.blockSort.dir=-cb.blockSort.dir; syncCbBlockSortUI(); sortCbBlocks(); renderCbCards(); };
  syncCbBlockSortUI();
}
function cbSheetInto(wb,v,r){
  const cyy=r.curYear%100, py=r.prevYear%100;
  const showSeries=(cb.dim==='model' && state.dims.includes('line'));
  // 产品/型号维度逐档比去年同期会因上市路标失真→明细行同期+同比留空；系列/产品线等不失真→明细行也输出
  const skuLevel=(cb.dim==='product'||cb.dim==='model');
  const pc=x=>x==null?'':+(x*100).toFixed(1)+'%';
  const nz=x=>x==null||!isFinite(x)?'':x;
  const nzv=x=>x==null||!isFinite(x)?undefined:x; // 缓存值：number 或 undefined
  const head=(showSeries?['Product Series']:[]).concat([DIM_LABEL[cb.dim],cyy+'累计SO',py+'同期SO总','SO同比',cyy+'累计SI',py+'同期SI总','SI同比']).concat(r.weekLabels).concat(['近4周SO','WoW%','库存','DOS'].concat(r.hasFlow?['全流程库存','全流程DOS','国家仓+FDC']:[]));
  const line=(o,isTot)=>{ const sp=isTot||!skuLevel; // sp: 是否输出同期SO/SI及同比
    return (showSeries?[o.line||'']:[]).concat([o.key,o.cumCur,sp?o.cumPrev:'',sp?nz(o.yoy):'',o.siCur,sp?o.siPrev:'',sp?nz(o.siYoy):'']).concat(o.weekly).concat([nz(o.last4),pc(o.wow),o.inv,o.dos].concat(r.hasFlow?[o.flowInv,o.flowDos,o.dcfdc]:[])); };
  const rows=cbVisibleRows(v,r,cbColumns(r)); // 已隐藏行不导出；合计仍为引擎全量汇总
  const aoa=[head]; rows.forEach(o=>aoa.push(line(o,false)));
  let totIdx=-1; if(r.total){ totIdx=aoa.length; aoa.push(line(Object.assign({line:''},r.total),true)); }
  const sheet=XLSX.utils.aoa_to_sheet(aoa);
  // ---- 活公式：同比/WoW/DOS/全流程库存/全流程DOS 引用同行原始列，保留缓存值以便重算前正常显示 ----
  const C=window.FinCalc, EU=window.ExportUtil;
  const off=showSeries?1:0, W=r.weekLabels.length;
  const cCur=off+1,cPrev=off+2,cYoy=off+3,cSiCur=off+4,cSiPrev=off+5,cSiYoy=off+6;       // 累计SO/SI 及同比
  const cWlast=off+7+W-1,cWprev=off+7+W-2,cLast4=off+7+W,cWow=off+8+W,cInv=off+9+W,cDos=off+10+W; // 周列尾 / 近4周SO / WoW / 库存 / DOS
  const cFlowInv=off+11+W,cFlowDos=off+12+W,cDcfdc=off+13+W;                              // 全流程库存 / 全流程DOS / 国家仓+FDC
  const dataRows=[]; for(let i=1;i<=rows.length;i++) dataRows.push(i); if(totIdx>=0) dataRows.push(totIdx);
  const yoyRows=skuLevel?(totIdx>=0?[totIdx]:[]):dataRows;     // 同比：产品/型号仅合计行，其它维度明细+合计
  const AD=(c,ri)=>XLSX.utils.encode_cell({r:ri,c:c});         // 公式用单元格地址(0-based行→A2形式)
  const obj=ri=>(totIdx>=0&&ri===totIdx)?r.total:rows[ri-1];   // 取该行数据对象(缓存值)
  if(yoyRows.length){ EU.applyRowYoy(XLSX,sheet,C,{rows:yoyRows,curCol:cCur,prevCol:cPrev,yoyCol:cYoy,z:'0.0%'});
    EU.applyRowYoy(XLSX,sheet,C,{rows:yoyRows,curCol:cSiCur,prevCol:cSiPrev,yoyCol:cSiYoy,z:'0.0%'}); }
  if(W>=2) dataRows.forEach(ri=>EU.setFormulaCell(XLSX,sheet,ri,cWow,C.fYoy(AD(cWlast,ri),AD(cWprev,ri)),nzv(obj(ri).wow),'0.0%'));
  dataRows.forEach(ri=>EU.setFormulaCell(XLSX,sheet,ri,cDos,`IFERROR(ROUND(${AD(cInv,ri)}*28/${AD(cLast4,ri)},0),0)`,nzv(obj(ri).dos)));
  if(r.hasFlow) dataRows.forEach(ri=>{ EU.setFormulaCell(XLSX,sheet,ri,cFlowInv,`${AD(cInv,ri)}+${AD(cDcfdc,ri)}`,nzv(obj(ri).flowInv));
    EU.setFormulaCell(XLSX,sheet,ri,cFlowDos,`IFERROR(ROUND(${AD(cFlowInv,ri)}*28/${AD(cLast4,ri)},0),0)`,nzv(obj(ri).flowDos)); });
  XLSX.utils.book_append_sheet(wb,sheet,String(v).slice(0,28).replace(/[\\/?*\[\]:]/g,'_'));
}
async function exportCbXlsx(){
  if(!cb.last.length){ toast('暂无数据','err'); return; }
  const wb=XLSX.utils.book_new();
  cb.last.forEach(({v,r})=>cbSheetInto(wb,v,r));
  const b64=XLSX.write(wb,{bookType:'xlsx',type:'base64'});
  const res=await api.saveFile('国家看板_'+todayStr()+'.xlsx',b64,'xlsx'); if(res&&res.path)toast('已导出（每国一个Sheet）','ok');
}
async function exportCbPpt(){
  if(!cb.last.length){ toast('暂无数据','err'); return; }
  const pptx=new PptxGenJS(); pptx.defineLayout({name:'W',width:13.333,height:7.5}); pptx.layout='W';
  const num=v=>v==null?'—':Math.round(v).toLocaleString('en-US');
  const cell=(t,o)=>({text:String(t),options:Object.assign({fontFace:'微软雅黑',fontSize:8,align:'right',valign:'middle'},o||{})});
  cb.last.forEach(({v,r})=>{
    const s=pptx.addSlide(); const cyy=r.curYear%100;
    s.addText(v+' · '+DIM_LABEL[cb.dim]+'明细',{x:0.4,y:0.2,w:12.5,h:0.5,fontFace:'微软雅黑',fontSize:18,bold:true,color:'C7000B'});
    const headTexts=[DIM_LABEL[cb.dim],cyy+'累计SO','同期SO总','同比'].concat(r.weekLabels).concat(['WoW','库存','DOS'].concat(r.hasFlow?['全流程','全流程DOS','仓+FDC']:[]));
    const rows=[headTexts.map((h,i)=>cell(h,{bold:true,color:'FFFFFF',fill:{color:'C7000B'},align:i===0?'left':'right'}))];
    // 25年同期SO+同比只在合计行(全档位总数)；明细行留空
    const mk=(o,tot)=>{ const a=[cell(o.key,{align:'left',bold:!!tot,fill:tot?{color:'FFF1F1'}:undefined}),cell(num(o.cumCur),{bold:!!tot}),cell(tot?num(o.cumPrev):'—',{bold:!!tot,color:tot?undefined:'A8AEB5'}),
      cell(!tot?'—':(o.yoy==null?'—':(o.yoy*100).toFixed(0)+'%'),{color:(tot&&o.yoy!=null)?(o.yoy>=0?'1E9E57':'C7000B'):'A8AEB5',bold:!!tot})];
      o.weekly.forEach(x=>a.push(cell(num(x),{color:'5A5F66'}))); a.push(cell(o.wow==null?'—':(o.wow*100).toFixed(0)+'%'),cell(num(o.inv),{bold:!!tot}),cell(num(o.dos),{bold:!!tot}));
      if(r.hasFlow){ a.push(cell(num(o.flowInv)),cell(num(o.flowDos)),cell(num(o.dcfdc))); } return a; };
    cbVisibleRows(v,r,cbColumns(r)).forEach(o=>rows.push(mk(o))); if(r.total)rows.push(mk(r.total,true));
    s.addTable(rows,{x:0.3,y:0.8,w:12.7,border:{type:'solid',color:'E6E8EB',pt:0.5},autoPage:false});
  });
  const b64=await pptx.write('base64'); const res=await api.saveFile('国家看板_'+todayStr()+'.pptx',b64,'pptx'); if(res&&res.path)toast('已导出（每国一页）','ok');
}

/* ---- 事件绑定(从 app.js init() 搬来，保持同位置顺序) ---- */
function initCountryView(){
  // country board controls
  $('#cbScope').onchange=e=>{ cb.scope=e.target.value; cb.sortKey=null; drawCountryBoard(); };
  $('#cbDim').onchange=e=>{ cb.dim=e.target.value; cb.sortKey=null; drawCountryBoard(); };
  // 点表头排序所有国家的表 + 行首✕隐藏行
  $('#cbList').addEventListener('click',e=>{
    const hb=e.target.closest&&e.target.closest('button[data-hiderow]');
    if(hb){ const card=hb.closest('.cb-card'); if(card&&card.dataset.v!=null){ cbHideRow(card.dataset.v,decodeURIComponent(hb.dataset.hiderow)); renderCbCards(); } return; }
    if(!cb.custom) return;                                   // 自定义排序【关】→ 表头点击不响应，恒为默认序
    const th=e.target.closest&&e.target.closest('th.sortable'); if(!th)return;
    const TS=cbTS(); const k=th.dataset.k;
    // 首点方向靠列是否文本列决定；'key'(维度名)/'__line'(Product Series)是仅有的两个文本列
    const nx=TS.nextSort({key:cb.sortKey,dir:cb.sortDir},k,{key:k,left:(k==='key'||k==='__line')});
    cb.sortKey=nx.key; cb.sortDir=nx.dir; renderCbCards(); });
  $('#cbExportXlsx').onclick=exportCbXlsx;
  $('#cbExportPpt').onclick=exportCbPpt;
}

/* 供单测 require（浏览器端 module 未定义，自动跳过；不影响运行时） */
if(typeof module!=='undefined'&&module.exports){ module.exports={cb,cbSortRows}; }

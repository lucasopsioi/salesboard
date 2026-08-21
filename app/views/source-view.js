/* ============================================================
   Salesboard — views/source-view.js
   数据源视图：渲染数据源状态卡片 + 存档卡片。
   纯搬运：从 app.js 原样剪切，无逻辑改动。依赖 common.js（在本文件之前加载）。
   ============================================================ */
'use strict';

/* ---------- 底表结构速览：纯函数 + 常量 ---------- */
const PSI_VALUE_NOTE = '数值列按 PSI 类型归一为 sellIn/sellOut/inventory';

// 转义任意 Excel 单元格/表头文本，避免破坏 innerHTML
function _esc(s){ return String(s==null?'':s).replace(/[&<>"]/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }

// 根据文件 kind 推导「app 识别到的列」
function _identifiedCols(kind, dims, idcCats, finMeta){
  const D = Array.isArray(dims) ? dims : [];
  const I = Array.isArray(idcCats) ? idcCats : [];
  switch(kind){
    case 'psi':     return { label:'PSI 已识别维度（全局）', cols:D, note:PSI_VALUE_NOTE };
    case 'idc':     return { label:'IDC 分类', cols:I, note:'' };
    case 'finance': case 'actual': case 'forecast': case 'bp': {
      // 财经字段映射其实已随 meta() 暴露到渲染端(state.finMeta)：dims=已识别维度、metrics=指标。
      const fm = finMeta || {};
      const LBL = { brand:'品牌', region:'大区', rep:'国家办', country:'国家', lv1:'层级1', lv2:'层级2', lv3:'层级3', lv4:'层级4' };
      const dimCols = (Array.isArray(fm.dims) ? fm.dims : []).map(k => LBL[k] || k);
      const metrics = Array.isArray(fm.metrics) ? fm.metrics : [];
      const note = metrics.length ? ('指标(' + metrics.length + '): ' + metrics.join('、')) : (dimCols.length ? '' : '未锚定经营分析数据');
      return { label:'财经 已识别', cols:dimCols, note };
    }
    case 'flow':    return { label:'流量', cols:[], note:'字段映射未暴露到渲染端（后续增强）' };
    default:        return { label:'未识别', cols:[], note:'此文件未被任何解析器识别' };
  }
}

/* ============================================================
   「底表来源」面板：所有底表导入入口统一收拢到数据源看板。
   6 个源：PSI主 / 库存库龄 / 经营分析 / IDC / 发货表 / 成本表。
   每行 = 名称 + 当前文件夹路径（取自 meta，未设置显「未设置」）+ [导入/更换文件夹] 按钮。
   点按钮：pickXFolder() → setX...(p) → 全局 refresh()（PSI/库龄/经营/IDC 的 setXFolderAndRefresh
   已重建 store；发货/成本经 refresh() 让 __sosim 与各看板同步）→ toast + 重渲本面板（路径更新）。
   ============================================================ */
// 源定义：key=meta 上的路径字段名；pick/set=preload api 方法名；refresh=set 后是否自身已重建（仅信息）。
const SRC_DEFS = [
  { name:'PSI主',    metaKey:'folder',    info:'psi',  kind:'psi',     pick:'pickFolder',    set:'setFolderAndRefresh' },
  { name:'库存库龄',  metaKey:'invFolder', info:'inv',  kind:'inv',     pick:'pickInvFolder', set:'setInvFolderAndRefresh' },
  { name:'经营分析',  metaKey:'finFolder', info:'fin',  kind:'finance', pick:'pickFinFolder', set:'setFinFolderAndRefresh' },
  { name:'IDC市场',   metaKey:'idcFolder', info:'idc',  kind:'idc',     pick:'pickIdcFolder', set:'setIdcFolderAndRefresh' },
  { name:'发货表',    metaKey:'shipFolder',info:'ship', kind:'ship',    pick:'pickShipFolder',set:'setShipFolder' },
  { name:'成本表',    metaKey:'costFolder',info:'cost', kind:'cost',    pick:'pickCostFolder',set:'setCostFolder' },
];
// 富行面板模块态
let _srcInfo = {};            // sourcesInfo() 结果缓存
const _srcOpen = {};          // i -> 展开态
const _shipCostCache = {};    // 'ship'|'cost' -> 解析结果(懒)

// 确保「底表来源」容器存在（注入到 #srcMeta 之后，不改 index.html）。
function _ensureSrcFoldersHost(){
  const view=$('#view-source'); if(!view) return null;
  let host=$('#srcFolders');
  if(!host){
    host=document.createElement('div'); host.id='srcFolders';
    const anchor=$('#srcMeta');
    if(anchor && anchor.parentNode) anchor.parentNode.insertBefore(host, anchor.nextSibling);
    else view.appendChild(host);
  }
  return host;
}

// 「底表源」统一富行：6 源每行可展开（文件夹 · 字段 · 预览 · 更新时间）。
async function renderSourceRows(){
  const host=_ensureSrcFoldersHost(); if(!host) return;
  let meta={}, info={};
  try{ meta=(api.meta? await api.meta():null)||{}; }catch(e){ meta={}; }
  try{ info=(api.sourcesInfo? await api.sourcesInfo():null)||{}; }catch(e){ info={}; }
  _srcInfo=info||{};
  const fmt=t=>t?new Date(t).toLocaleString('zh-CN'):'—';
  const rows=SRC_DEFS.map((d,i)=>{
    const p=meta[d.metaKey];
    const si=_srcInfo[d.info];
    const pv=p?_esc(p):'<span style="color:var(--ink3)">未设置</span>';
    const upd=(si&&si.file)?(_esc(si.file)+' · '+fmt(si.mtime)):(p?'<span style="color:var(--ink3)">文件夹为空</span>':'—');
    const cnt=(si&&si.file)?((si.rows==null?'—':si.rows.toLocaleString()+' 行')):'';
    const btn=p?'更换文件夹':'导入';
    const open=!!_srcOpen[i];
    return `<div class="meta-card" style="margin:8px 0" id="srcCard${i}">
      <div style="display:flex;align-items:center;gap:14px">
        <span id="srcArrow${i}" style="color:var(--ink3);cursor:pointer">${open?'▾':'▸'}</span>
        <div id="srcHead${i}" style="flex:0 0 84px;font-weight:600;font-size:13px;cursor:pointer">${_esc(d.name)}</div>
        <div style="flex:2 1 200px;min-width:0;font-size:12px;color:var(--ink2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${pv}</div>
        <div style="flex:1 1 150px;min-width:0;font-size:11px;color:var(--ink3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">更新：${upd}</div>
        <div style="flex:0 0 64px;font-size:11px;color:var(--ink3);text-align:right">${cnt}</div>
        <button class="btn" id="srcRf${i}" style="flex:0 0 auto" title="只刷新这一个数据源（其它源不动、不重新解析）"${p?'':' disabled'}>↻ 刷新</button>
        <button class="btn" id="srcFld${i}" style="flex:0 0 auto">${btn}</button>
      </div>
      <div id="srcBody${i}" style="display:${open?'block':'none'};margin-top:10px"></div>
    </div>`;
  }).join('');
  host.innerHTML='<div class="section-h">底表源（文件夹 · 字段 · 预览 · 更新时间）</div>'+rows;
  SRC_DEFS.forEach((d,i)=>{
    const b=$('#srcFld'+i); if(b) b.onclick=()=>_srcPickFolder(d,i);
    const rf=$('#srcRf'+i); if(rf) rf.onclick=()=>_srcRefreshOne(d,i);
    const h=$('#srcHead'+i), a=$('#srcArrow'+i), tog=()=>_srcToggle(d,i);
    if(h) h.onclick=tog; if(a) a.onclick=tog;
    if(_srcOpen[i]) _srcRenderBody(d,i);   // 重渲后保持展开态内容
  });
}

/* 单独刷新一个数据源（用户要的：不想点一次刷新就把 6 个源全跑一遍）。
   - psi/inv/fin/idc：主进程只作废这一个源的解析缓存再跑 refresh，其余源命中缓存不重解析 xlsx
     （解析才是耗时大头），合并/建仓仍是同一条路径，口径与全量刷新一致。
   - ship/cost：本来就不在引擎 refresh 里（渲染层经 sosimSource 读），只重读这两张表。
   全程不动其它源，也不触发全局 refresh() 的整站重绘。 */
async function _srcRefreshOne(d, i) {
  const btn = $('#srcRf' + i);
  const old = btn ? btn.textContent : '';
  if (btn) { btn.disabled = true; btn.textContent = '刷新中…'; }
  const t0 = Date.now();
  try {
    if (d.kind === 'ship' || d.kind === 'cost') {
      delete _shipCostCache[d.info];
      if (typeof window.invAutoLoadSources === 'function') await window.invAutoLoadSources();
      if (typeof invRebuildCtx === 'function' && document.getElementById('invRoot') && document.getElementById('invRoot').dataset.built) invRebuildCtx();
    } else {
      const r = await api.refreshOne(d.kind);
      if (r && r.error) { toast('「' + d.name + '」刷新失败：' + r.error, 'err'); return; }
      if (r && r.dims !== undefined && typeof applyMeta === 'function') { try { applyMeta(r); } catch (e) { } }
      delete _shipCostCache[d.info];
      // 只重绘当前所在看板，不做全站刷新
      if (typeof draw === 'function' && typeof currentView === 'function' && currentView() === 'psi') { try { draw(); } catch (e) { } }
    }
    _srcInfo = {};                       // 源信息缓存作废，下面重取更新时间/行数
    try { _srcInfo = (await api.sourcesInfo()) || {}; } catch (e) { }
    toast('「' + d.name + '」已刷新（' + ((Date.now() - t0) / 1000).toFixed(1) + 's，其它源未动）', 'ok');
    renderSourceRows();
  } catch (e) {
    toast('「' + d.name + '」刷新失败：' + ((e && e.message) || e), 'err');
  } finally {
    const b2 = $('#srcRf' + i); if (b2) { b2.disabled = false; b2.textContent = old || '↻ 刷新'; }
  }
}

// 导入/更换文件夹：pick→set→applyMeta→全局 refresh 流程。
async function _srcPickFolder(d,i){
  try{
    const p=await api[d.pick](); if(!p) return;
    showLoading('正在设置「'+d.name+'」文件夹并刷新…');
    const r=await api[d.set](p);
    if(r&&r.error){ hideLoading(); toast('设置失败：'+r.error,'err'); return; }
    if(r && r.dims!==undefined && typeof applyMeta==='function'){ try{ applyMeta(r); }catch(e){} }
    hideLoading();
    if(typeof refresh==='function'){ try{ await refresh(); }catch(e){} }
    delete _shipCostCache[d.info];   // 清解析缓存,展开会重解析
    toast('「'+d.name+'」已更新','ok');
    renderSourceRows();
  }catch(e){ hideLoading(); toast('设置「'+d.name+'」失败','err'); }
}

// 展开/收起一行。
function _srcToggle(d,i){
  const body=$('#srcBody'+i), arrow=$('#srcArrow'+i); if(!body) return;
  _srcOpen[i]=!_srcOpen[i];
  if(arrow) arrow.textContent=_srcOpen[i]?'▾':'▸';
  body.style.display=_srcOpen[i]?'block':'none';
  if(_srcOpen[i]) _srcRenderBody(d,i);
}

// 展开内容：左=底表预览(表头+前几行)，右=解析出的字段接口。
async function _srcRenderBody(d,i){
  const body=$('#srcBody'+i); if(!body) return;
  const si=_srcInfo[d.info];
  let left;
  if(!si || !si.file){ left='<div style="font-size:11px;color:var(--ink3)">未设置文件夹或文件夹为空</div>'; }
  else if(si.error){ left=`<div style="font-size:11px;color:#c0392b">读取失败：${_esc(si.error)}</div>`; }
  else {
    const H=si.header||[];
    const hdr=H.map(h=>`<th style="white-space:nowrap;padding:4px 8px;text-align:left">${_esc(h)}</th>`).join('');
    const prev=(si.preview||[]).map(r=>`<tr>${H.map((_,c)=>`<td style="white-space:nowrap;padding:4px 8px;color:var(--ink2)">${_esc((r||[])[c])}</td>`).join('')}</tr>`).join('');
    left=hdr?`<div style="overflow:auto"><table class="data" style="font-size:12px"><tr>${hdr}</tr>${prev}</table></div>`:'<div style="font-size:11px;color:var(--ink3)">空表</div>';
  }
  const right=await _srcIdentifiedHtml(d, si);
  const nPrev=(si&&si.preview&&si.preview.length)||0;
  body.innerHTML=`<div style="display:flex;gap:18px;flex-wrap:wrap">
    <div style="flex:1 1 340px;min-width:0"><div style="font-size:12px;font-weight:600;margin-bottom:6px">底表预览（表头 + 前 ${nPrev} 行）</div>${left}</div>
    <div style="flex:1 1 220px;min-width:0"><div style="font-size:12px;font-weight:600;margin-bottom:6px">解析出的字段接口</div>${right}</div>
  </div>`;
}

// 右栏「字段接口」：发货/成本经 ShipmentBase/CostBase 解析；PSI/IDC/经营复用 _identifiedCols；库龄列原始表头。
async function _srcIdentifiedHtml(d, si){
  const chip=arr=>(arr&&arr.length)?arr.map(c=>`<span style="display:inline-block;padding:2px 8px;margin:2px;border:1px solid var(--line);border-radius:10px;font-size:11px">${_esc(c)}</span>`).join(''):'<span style="font-size:11px;color:var(--ink3)">—</span>';
  if(d.kind==='ship' || d.kind==='cost'){
    let parsed=_shipCostCache[d.info];
    if(parsed===undefined){
      parsed=null;
      try{
        const src=await(api.sosimSource? api.sosimSource():null);
        const one=src&&src[d.info];
        if(one&&one.aoa){
          if(d.kind==='ship'&&window.ShipmentBase){ const rs=window.ShipmentBase.parseShipmentAoa(one.aoa)||[]; parsed={cols:Object.keys(rs[0]||{}), n:rs.length, unit:'行'}; }
          else if(d.kind==='cost'&&window.CostBase){ const r=window.CostBase.parseCostAoa(one.aoa)||{}; const cm=r.costMap||r; const n=(cm&&cm.size!==undefined)?cm.size:Object.keys(cm||{}).length; parsed={cols:(si&&si.header)||[], n, unit:'SKU'}; }
        }
      }catch(e){ parsed={error:String(e&&e.message||e)}; }
      _shipCostCache[d.info]=parsed;
    }
    if(!parsed) return '<span style="font-size:11px;color:var(--ink3)">未设置或解析为空</span>';
    if(parsed.error) return `<span style="font-size:11px;color:#c0392b">解析失败：${_esc(parsed.error)}</span>`;
    return chip(parsed.cols)+`<div style="font-size:11px;color:var(--ink3);margin-top:4px">解析出 ${parsed.n} ${parsed.unit}</div>`;
  }
  if(d.kind==='inv'){
    return chip((si&&si.header)||[])+'<div style="font-size:11px;color:var(--ink3);margin-top:4px">库龄底表列（按最新期求和）</div>';
  }
  const idc=_identifiedCols(d.kind, state.dims, state.idcMeta&&state.idcMeta.cats, state.finMeta);
  const note=idc.note?`<div style="font-size:11px;color:var(--ink3);margin-top:4px">${_esc(idc.note)}</div>`:'';
  return `<div style="font-size:12px;color:var(--ink2);margin-bottom:4px">${_esc(idc.label)}</div>${chip(idc.cols)}${note}`;
}

/* ---------- data source view ---------- */
function renderSource(){
  const m=$('#srcMeta');
  m.innerHTML=`
    <div class="meta-card"><div class="k">文件夹</div><div class="v" style="font-size:12px">${state.folder||'（未锚定，示例数据）'}</div></div>
    <div class="meta-card"><div class="k">记录数（透视后）</div><div class="v">${state.records.toLocaleString()}</div></div>
    <div class="meta-card"><div class="k">文件数</div><div class="v">${state.files.length}</div></div>
    <div class="meta-card"><div class="k">维度数</div><div class="v">${state.dims.length}</div></div>
    <div class="meta-card"><div class="k">时间范围</div><div class="v" style="font-size:13px">${state.from||'-'}<br>~ ${state.to||'-'}</div></div>
    <div class="meta-card"><div class="k">IDC市场文件夹</div><div class="v" style="font-size:12px">${state.idcFolder||'（未锚定）'}${state.idcMeta?`<br>${state.idcMeta.n.toLocaleString()} 条 · ${(state.idcMeta.cats||[]).join('/')}`:''}</div></div>
    <div class="meta-card"><div class="k">上次刷新</div><div class="v" style="font-size:13px">${state.lastRefresh?new Date(state.lastRefresh).toLocaleString('zh-CN'):'-'}</div></div>`;
  const t=$('#srcTable');
  t.innerHTML='<tr><th>文件名</th><th>记录数</th></tr>'+(state.files.length?state.files.map(f=>`<tr><td>${f.name}</td><td>${(f.rows||0).toLocaleString()}</td></tr>`).join(''):'<tr><td colspan=2 style="color:var(--c-ink-3)">暂无文件</td></tr>');
  renderSourceRows();    // 底表源统一富行（文件夹 · 字段 · 预览 · 更新时间）
  renderArchiveCard();   // 异步渲染存档卡片，不阻塞数据源页
  renderFormatGuide();   // 各底表「导入格式说明」（2026-07 用户要：表识别不出来时能对着查格式）
}

/* ============================================================
   导入格式说明（静态参考卡，2026-07 用户要）：每个可导入底表要什么格式。
   内容与各解析器实际口径对齐(engine-core FIELD_SPECS/ACT/FC/BP/FLOW/IDC_*_MAP、
   shipment-base、cost-base)。改解析器时同步改这里。
   ============================================================ */
function renderFormatGuide(){
  const host=$('#formatGuide'); if(!host) return;
  const sec=(title,body)=>`<details style="margin:6px 0;border:1px solid var(--line);border-radius:8px;background:var(--c-bg-elev)">`+
    `<summary style="padding:9px 14px;font-size:12.5px;font-weight:600;cursor:pointer;user-select:none">${title}</summary>`+
    `<div style="padding:4px 16px 12px;font-size:12px;color:var(--ink2);line-height:1.8">${body}</div></details>`;
  const b=t=>`<b style="color:var(--ink)">${t}</b>`;
  const code=t=>`<code style="background:#F4F5F7;border-radius:4px;padding:1px 5px">${t}</code>`;
  host.innerHTML=`
  <div class="meta-card" style="margin:14px 0;font-family:${YH}">
    <div class="k">各底表导入格式说明（识别不出来时对照这里检查表头/列）</div>
    <div style="margin-top:8px">
    ${sec('📈 PSI 底表（PSI 文件夹 · 认表头不认列序 · xlsx/csv 多 Sheet）',
      `必需列：${b('PSI类型')}（${code('PSIType')}，取值 SellIn / SellOut / Inventory / DOS）+ ${b('数量')}（${code('Qty / 数量 / 本月实际')}）——缺任一整个 Sheet 跳过。<br>`+
      `维度列（认到哪列用哪列）：大区(${code('ManagementRegion/Region/管理区域')})、国家办(${code('RepOffice')})、国家(${code('Country')})、渠道(${code('OnlineOffline/Channel')})、`+
      `产品族=Lv1(${code('ProductFamily/产品族/产品Lv1')})、产品线=Lv2(${code('ProductLine/产品Lv2')})、产品系列=Lv3(${code('ProductSeries/产品Lv3')})、产品=Lv4(${code('Product/产品Lv4')})、型号(${code('ProductModel/产品型号/型号')})、周期(${code('PeriodID/Period/周期/会计期年月')})。`)}
    ${sec('🚚 发货表（发货文件夹 · 只读“最新修改”那个文件的第 1 个 Sheet）',
      `列（认表头）：${b('国家')}(${code('国家/地区/Country')})、${b('Product Family')}、${b('Product Series')}、${b('Product Model')}(${code('型号/Model')})、${b('数量')}(${code('数量/Qty/Quantity')})、${b('日期')}(${code('日期/Date/时间')})。<br>`+
      `必需：型号 + 数量 + 日期（缺任一该行跳过）。日期支持 Excel 日期 / 序列号 / ${code('2026-6-1')} / ${code('20260601')}。<br>`+
      `⚠ 国家名和型号名要与 PSI 一致——差空格/大小写/全角会自动配对，但完全不同的名字（如自编码 vs PSI 名）配不上 → 该发货永远没 SO 消耗（可用库存看板「配对诊断」检查）。`)}
    ${sec('💲 Floor cost表（成本文件夹 · 只读“最新修改”那个文件的第 1 个 Sheet）',
      `${b('推荐固定 4 列（表头随便写，认不出表头时自动按列序解析）')}：第1列=${b('产品系列')}、第2列=${b('产品型号')}、第3列=${b('日期(月)')}、第4列=${b('单台成本 USD')}。首行就是数据（无表头）也能读。<br>`+
      `表头能认出时按表头：型号(${code('型号/SKU')})、日期(${code('Attribute/月/日期')})、数值(${code('Value/值/成本')})、系列(${code('系列')})、传播名(${code('传播名')})；老定价库 5 列格式（传播名/型号/Attribute/Value/系列）照常可读。<br>`+
      `日期支持：Excel 日期、序列号（${b('数字或文本')}，如 ${code('46174')}）、${code('2026/6')}、${code('202606')}、${code('2026年6月')}。<br>`+
      `⚠ 型号必须与发货表/PSI 的型号一致（成本按型号+发货所在月锁定）；Value 空 = 该月缺成本（图上按 $0/缺成本提示）。`)}
    ${sec('💹 财经实际表（财经文件夹 · 只读第 1 个 Sheet=PQ 成品表 · 表头行可不在第 1 行，自动探测）',
      `必需列：${b('报表项中文名称')}、${b('会计期年月')}、${b('本月实际')}。<br>维度列：品牌、大区、国家办、国家、产品Lv1~Lv4、报表项排序序号。`)}
    ${sec('💹 财经预测表（同上 PQ 成品表）',
      `必需：${b('指标名称')} + 时间形态二选一——${b('长表')}（${code('Attribute')}=日期 + ${code('Value')}=值，PQ 逆透视后）或 ${b('宽表')}（列头形如 ${code('2026年6月')}）。<br>`+
      `维度列：品牌、大区、国家办、产品Lv1~Lv4、产品型号、指标序号、金额数量单位、版本、预测场景。`)}
    ${sec('💹 财经 BP 表',
      `列：${b('版本中文名')}、${b('大区中文名')}、${b('国家办中文名')}、产品Lv1~Lv4中文名、${b('报表项中文名')}、${b('月份')}、${b('值')}。`)}
    ${sec('📦 库龄 / 全流程(CDC+FDC)表（库存文件夹）',
      `列：${b('运行日期')}、产品族、产品系列、${b('产品型号')}、要货国家办、要货国家、${b('库存数量')}(${code('库存数量/库存PCS')})。`)}
    ${sec('🌐 IDC 市场底表（IDC 文件夹 · 保持 IDC 原始导出格式）',
      `平板表识别特征：含 ${code('SCREEN_SIZE')} + ${code('UNITS')} + ${code('PRODUCT')}；音频表：含 ${code('PRODUCT_DETAIL')} 或 ${code('OWS certi')} + ${code('UNITS')}。<br>`+
      `常用列：${code('YEAR / QUARTER / ACME_SUB_REGION / ACME_COUNTRY / BRAND / MODEL_NAME / PRICE_BAND / UNITS / VALUE_USD_M')} 等——${b('别改 IDC 导出的原始表头')}。`)}
    </div>
    <div style="margin-top:8px;font-size:11px;color:var(--ink3)">通用提醒：数字列别带单位文字；同一文件夹里只认“修改时间最新”的那个文件（发货/成本）；改完源文件点顶部 ↻ 刷新。</div>
  </div>`;
}

// 存档卡片：显示存档文件路径 + 更改位置/导出/导入/打开文件夹
async function renderArchiveCard(){
  const host=$('#archiveCard'); if(!host) return;
  const Arc=window.Archive;
  if(!Arc || !api.archiveInfo){ host.innerHTML=''; return; }   // 旧版桥接：无存档能力则不显示
  let info=null;
  try{ info=await Arc.info(); }catch(e){ info=null; }
  const file=(info&&info.file)||'（未建立）';
  const stateHint=(info&&info.exists)?'已建立':'未建立（首次保存后生成）';
  host.innerHTML=`
    <div class="meta-card" style="margin:14px 0;font-family:${YH}">
      <div class="k">存档（更新不丢数据 / 可携带）</div>
      <div class="v" style="font-size:13px">${file}<br><small>${stateHint}</small></div>
      <div style="margin-top:12px;display:flex;gap:8px;flex-wrap:wrap">
        <button class="btn" id="arcChange">更改位置</button>
        <button class="btn" id="arcExport">导出存档</button>
        <button class="btn" id="arcImport">导入存档</button>
        <button class="btn ghost" id="arcOpen">打开文件夹</button>
      </div>
      <div style="margin-top:10px;font-size:11px;color:var(--ink3);line-height:1.5">录入的产品/路标/定价/看板数据自动存到此文件；换电脑把它拷过去再『更改位置』指过去即可。</div>
    </div>`;
  $('#arcChange').onclick=async()=>{
    try{ const r=await Arc.changeDir(); if(r&&r.ok){ toast('已切换到 '+r.file,'ok'); renderArchiveCard(); } }
    catch(e){ toast('更改位置失败','err'); }
  };
  $('#arcExport').onclick=async()=>{
    try{ const r=await Arc.exportAs(); if(r&&r.path) toast('已导出到 '+r.path,'ok'); else if(r&&r.error) toast('导出失败','err'); }
    catch(e){ toast('导出失败','err'); }
  };
  $('#arcImport').onclick=async()=>{
    try{ const r=await Arc.importFile(); if(r&&r.data) toast('已导入，正在刷新…','ok'); else if(r&&r.error) toast('导入失败','err'); }
    catch(e){ toast('导入失败','err'); }
  };
  $('#arcOpen').onclick=()=>{ try{ Arc.openFolder(); }catch(e){} };

  // 历史版本存档：列出各版本(版本号+保存日期)，可读回旧版数据
  const vers=(info&&info.versions)||[];
  const fmt=t=>t?new Date(t).toLocaleString('zh-CN'):'—';
  const cur=info&&info.file;
  const vrows=vers.map((v,i)=>`<div class="meta-card" style="display:flex;align-items:center;gap:12px;margin:6px 0">
      <div style="flex:0 0 auto;font-weight:600">v${v.appVersion}${v.file===cur?'（当前）':''}</div>
      <div style="flex:1 1 auto;font-size:12px;color:var(--ink2)">${fmt(v.savedAt)}</div>
      <button class="btn ghost" data-arcver="${i}">读取此版本</button>
    </div>`).join('');
  host.insertAdjacentHTML('beforeend', '<div class="section-h" style="margin-top:14px">历史版本存档</div>'+(vrows||'<div class="meta-card" style="color:var(--ink3)">暂无</div>'));
  host.querySelectorAll('[data-arcver]').forEach(b=>{ b.onclick=async()=>{
    const v=vers[+b.dataset.arcver]; if(!v) return;
    if(!confirm('读取 v'+v.appVersion+' 的存档？会替换当前数据(当前已自动存为本版本，可再切回)。')) return;
    try{ const r=await api.archiveLoadVersion(v.file); if(r&&r.data){ if(window.Archive&&window.Archive.applyData) window.Archive.applyData(r.data); toast('已读取 v'+v.appVersion+' 存档','ok'); setTimeout(()=>location.reload(),300); } else toast('读取失败：'+((r&&r.error)||''),'err'); }catch(e){ toast('读取失败','err'); }
  }; });
}

/* ============================================================
   数据源视图事件绑定
   数据源页的按钮（存档卡片 arcChange/arcExport/arcImport/arcOpen）由
   renderArchiveCard() 内部绑定；init() 中无数据源专属绑定可搬，故此处为空。
   ============================================================ */
function initSourceView(){
}

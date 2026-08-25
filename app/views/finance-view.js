'use strict';
// ECharts 主题桥取值器（canvas 不认 CSS 变量，必须给真实色值）
function CT(){ return (typeof window!=='undefined'&&window.SbChartTheme)?window.SbChartTheme:{ink1:()=>'#1A1A1A',ink2:()=>'#5A5F66',ink3:()=>'#8A9099',line:()=>'#E6E8EB',lineSoft:()=>'#F0F1F3',bgElev:()=>'#FFFFFF',register:c=>c}; }
/* ============================================================
   经营分析 (finance)：预测 vs 实际 P&L
   纯搬运自 app.js，无逻辑改动；在 common.js 之后、app.js 之前加载。
   含三块（均属经营分析）：(a) 基础经营分析(控件/KPI/图/表)，
   (b) 全年BP达成面板，(c) 经营达成情况表，(d) BP达成。
   依赖 common.js 的共享辅助（含 todayStr/renderDataBar/currentView）。
   ============================================================ */
// 新视图状态（重设计）：全局筛选条 + 各分块独立筛选 + 各块数据缓存。
// 替换旧 fin 对象；旧渲染函数虽仍引用旧字段，但新入口路径不再调用它们。
const fin={ year:0, fromM:1, toM:0, dp:1, unit:'USD', reps:[],
  lv1:[],lv2:[],lv3:[],lv4:[], basis:'actual', version:'', bpVersion:'',   // version=工作底稿口径(同时驱动预测+BP),bpVersion 跟随 version
  finUnits:{actual:'USD',forecast:'MUSD',bp:'USD'},    // 各来源原始单位:实际=USD,预测=MUSD,BP=USD(BP底表无单位列,此为固定假设);引擎按此归一后算达成
  finQtyUnits:{actual:'台',forecast:'台',bp:'台'},       // 各来源数量单位固定为台(底表数量恒为台),引擎 finQtyScale 返回[1,1,1]即不缩放
  rep:{ fromM:1,toM:0, reps:[], series:[] },            // 国家办块独立筛选
  custom:{ rowDim:'rep', metrics:['rev'], basis:'actual', chart:'bar', colorOverride:{} },   // colorOverride: 系列名/扇区名→hex(第二批-2b,点色块改色)
  _dims:null,                                           // financeOverview 返回的各维全量取值(下拉选项源)
  ov:null, prod:null, repBoard:null, cust:null };
/* ---- 状态持久化（sb.finance.v1）——第二批-2a。
   存 fin 的筛选/口径：year/fromM/toM/dp/unit/basis/version/bpVersion、多选 reps/lv1~lv4、
   国家办块独立筛选 rep(fromM/toM/reps/series)、自定义块 custom(rowDim/metrics/basis/chart)。
   运行态缓存 ov/prod/repBoard/cust/_dims/_dimsSig/_expUnits 不存。
   finance 无 applyMeta 重置，故回载在首次 buildFinControls 之前一次（finRestored 守卫）——
   buildFinControls 的默认逻辑用 if(!yrs.includes(fin.year))/if(!vers.includes(fin.version)) 只在无效时覆盖，
   故回载有效值会被保留、无效值被校正（脏值防御）。多选已选值的求交在 finBuildDimSelects（dims 到达后）做。 ---- */
const FIN_STATE_KEY='sb.finance.v1';
let finRestored=false;
const FIN_BASES=['actual','forecast'], FIN_UNITS_WL=['USD','MUSD'];
function finStateSave(){ boardStateSave(FIN_STATE_KEY, ()=>({
  year: fin.year, fromM: fin.fromM, toM: fin.toM, dp: fin.dp, unit: fin.unit, basis: fin.basis,
  version: fin.version, bpVersion: fin.bpVersion, reps: fin.reps, lv1: fin.lv1, lv2: fin.lv2, lv3: fin.lv3, lv4: fin.lv4,
  rep: { fromM: fin.rep.fromM, toM: fin.rep.toM, reps: fin.rep.reps, series: fin.rep.series },
  custom: { rowDim: fin.custom.rowDim, metrics: fin.custom.metrics, basis: fin.custom.basis, chart: fin.custom.chart, colorOverride: fin.custom.colorOverride } }), 500); }
function finStateRestore(){
  if(finRestored) return; finRestored=true;
  const o=boardStateLoad(FIN_STATE_KEY); if(!o) return;
  const num=(v,lo,hi)=>typeof v==='number'&&isFinite(v)&&v>=lo&&v<=hi;
  const arr=v=>Array.isArray(v)?v.filter(x=>typeof x==='string'):null;
  if(num(o.year,0,9999)) fin.year=o.year;
  if(num(o.fromM,1,12)) fin.fromM=o.fromM;
  if(num(o.toM,0,12)) fin.toM=o.toM;
  if(num(o.dp,0,3)) fin.dp=o.dp;
  if(FIN_UNITS_WL.includes(o.unit)) fin.unit=o.unit;
  if(FIN_BASES.includes(o.basis)) fin.basis=o.basis;
  if(typeof o.version==='string') fin.version=o.version;         // buildFinControls 校验版本在不在 vers 列表里
  if(typeof o.bpVersion==='string') fin.bpVersion=o.bpVersion;
  ['reps','lv1','lv2','lv3','lv4'].forEach(k=>{ const a=arr(o[k]); if(a) fin[k]=a; });   // finBuildDimSelects 求交剔脏
  if(o.rep && typeof o.rep==='object'){ const r=o.rep;
    if(num(r.fromM,1,12)) fin.rep.fromM=r.fromM; if(num(r.toM,0,12)) fin.rep.toM=r.toM;
    const rr=arr(r.reps); if(rr) fin.rep.reps=rr; const rs=arr(r.series); if(rs) fin.rep.series=rs; }
  if(o.custom && typeof o.custom==='object'){ const c=o.custom;
    if(typeof c.rowDim==='string') fin.custom.rowDim=c.rowDim;
    const cm=arr(c.metrics); if(cm&&cm.length) fin.custom.metrics=cm;
    if(FIN_BASES.includes(c.basis)) fin.custom.basis=c.basis;
    if(typeof c.chart==='string') fin.custom.chart=c.chart;
    if(c.colorOverride && typeof c.colorOverride==='object'){
      const ov={}; Object.keys(c.colorOverride).forEach(k=>{ const v=c.colorOverride[k];
        if(typeof v==='string' && /^#[0-9a-fA-F]{6}$/.test(v)) ov[k]=v; });   // 脏值防御：只收合法 hex
      fin.custom.colorOverride=ov; } }
}

const FIN_SRC_UNITS_RD=[['USD','美元 USD'],['千USD','千美元'],['MUSD','百万美元 MUSD']];   // 数据表原始单位
const FIN_UNIT_OPTS=[['USD','USD'],['MUSD','百万 MUSD']];          // 显示金额单位(底表实际=USD/BP=USD/预测=MUSD,引擎已归一为USD;此处仅控制展示换算)
// 全局筛选条用到的维度选项：dim 值字典暂不随 finMeta 序列化下发，缺失时退化为空列表(后续任务接入选项源)。
function finDimOptions(field){ const fm=state.finMeta; if(!fm) return [];
  return fm[field+'List'] || fm[field+'s'] || (Array.isArray(fm[field])?fm[field]:[]) || []; }
// LV1~LV4 + 国家办下拉选项源：优先用 financeOverview 返回的 dims(缓存于 fin._dims)，缺失时退化。
// dims 键：lv1~lv4 直名；国家办 dim='rep' 对应 dims.reps。首屏(_dims 为空)返回空列表，待 renderOverview 拿到 dims 后刷新。
function finDimList(field){ const d=fin._dims;
  if(d){ const key=field==='rep'?'reps':field; if(Array.isArray(d[key])) return d[key]; }
  return finDimOptions(field); }
/* ============================================================
   重设计视图骨架：运行时接管 #view-finance + 注入 CSS + 全局筛选条。
   不改 app/index.html；在此把 .rep-top/.fin-body 替换为新结构。
   ============================================================ */
function finInjectCSS(){ if(document.getElementById('fin-redesign-css'))return;
  const st=document.createElement('style'); st.id='fin-redesign-css';
  st.textContent=`
  #view-finance .fin-rd{display:flex;flex-direction:column;gap:14px;padding:14px 16px;overflow:auto}
  .fin-filters{display:flex;flex-direction:column;gap:8px;background:var(--c-bg-elev);border:1px solid var(--c-line);border-radius:10px;padding:10px 12px}
  .fin-frow{display:flex;flex-wrap:wrap;gap:10px;align-items:center}
  .fin-frow .fld{display:flex;align-items:center;gap:4px;font-size:12px;color:var(--c-ink-2)}
  .ov-grid{display:grid;grid-template-columns:1.1fr 1fr 1fr;gap:10px}
  .ov-card{background:var(--c-bg-elev);border:1px solid var(--c-line);border-radius:10px;padding:10px 12px}
  .ov-k{font-size:12px;color:var(--c-ink-3)}.ov-v{font-size:20px;font-weight:700;color:var(--c-ink-1);margin-top:2px}
  .ov-sub{font-size:11px;color:var(--c-ink-3);margin-top:4px}
  .pos{color:var(--c-good)}.neg{color:var(--c-brand)}.wk{color:var(--c-ink-3)}
  .fin-sec-t{font-size:14px;font-weight:700;color:var(--c-ink-1);margin:4px 0}
  .fin-unit-exp{margin-left:8px;font-weight:400}
  .fin-unit-exp button{font-size:11px;padding:1px 6px;margin-left:4px;cursor:pointer}
  .fin-health{background:var(--c-bg-elev);border:1px solid var(--c-line);border-radius:10px;padding:8px 12px;font-size:12px}
  .fin-health summary{cursor:pointer;font-weight:600;color:var(--c-ink-1)}
  .fh-body{margin-top:6px;display:flex;flex-direction:column;gap:3px}
  .fh-row{display:flex;gap:8px}.fh-k{color:var(--c-ink-3);min-width:110px;flex:none}.fh-v{color:#40454C}
  .fin-warn{background:var(--c-warn-soft);border:1px solid #F0DA9E;color:#8A6D1A;border-radius:6px;padding:0 6px;font-size:11px;font-weight:400}
  .fin-rd.fin-loading #finSecOverview,.fin-rd.fin-loading #finSecProduct,.fin-rd.fin-loading #finSecRep,.fin-rd.fin-loading #finSecCustom{opacity:.55;transition:opacity .15s;pointer-events:none}
  `;
  document.head.appendChild(st);
}
function finMount(){
  const root=document.getElementById('view-finance'); if(!root) return null;
  let host=root.querySelector('.fin-rd');
  if(!host){ root.innerHTML='<div class="fin-rd">'+
    '<div class="fin-filters" id="finFilters"></div>'+
    '<div id="finSecHealth"></div>'+
    '<div id="finSecOverview"></div>'+
    '<div id="finSecProduct"></div>'+
    '<div id="finSecRep"></div>'+
    '<div id="finSecCustom"></div>'+
    '<div id="finEmpty" class="empty hidden" style="position:static;padding:40px"><div class="big">💹</div><div>没有财经数据。把预测表/实际表放进 PSI 文件夹后刷新。</div></div>'+
    '</div>'; host=root.querySelector('.fin-rd'); }
  return host;
}
// 渲染三行全局筛选条到 #finFilters；无 finMeta 则显示 #finEmpty 返回。
// 幂等：筛选条只在首屏构建一次(wrap.innerHTML 全量重写 + finBuildDimSelects + bind 仅首建执行)。
// 之后每次 drawFinanceAchieve() 调到这里都早返回——不再 wipe/重建筛选条，避免毁掉用户正在操作的多选、
// 也避免重建抛错挡住后续看板重渲染(这正是"点筛选下面值不更新"的根因)。多选选项的刷新由 renderOverview()
// 拿到 o.dims 后单独调 finBuildDimSelects() 完成(见该处)，不依赖本函数重建。
// (分支重复的 sb.finance.filters.v1 持久化已并入 sb.finance.v1——合并归一,见 finStateSave/finStateRestore)
function buildFinControls(){
  const fm=state.finMeta;
  const wrap=$('#finFilters'); if(!wrap) return;
  const em=$('#finEmpty');
  if(!fm){ if(em) em.classList.remove('hidden'); wrap.innerHTML=''; return; }
  if(em) em.classList.add('hidden');
  finStateRestore();   // 首建前恢复上次状态(sb.finance.v1,仅一次);非法年份/版本由下方默认逻辑校正
  // 已构建过 → 早返回，不重建(筛选变化只重渲看板，由 drawFinanceAchieve 的后续 renderXxx 完成)。
  if($('#finFRow1')) return;
  // 默认：年=有实际的最新年；版本=有预测数据的版本
  const yrs=(fm.actualYears&&fm.actualYears.length)?fm.actualYears:(fm.years||[]);
  if(yrs.length && !yrs.includes(fin.year)) fin.year=yrs[yrs.length-1];
  // 工作底稿口径：预测(fm.versions)与 BP(fm.bpVersions)在真实数据里同口径(国家办/大区工作底稿),
  // 合并成一个选择器同时驱动两者。示例数据里两者不同名(预测=4月预测,BP=国家办工作底稿),故默认值各取各表自己有的版本,避免误把预测/ BP 任一打成 0。
  const fcVersList=(fm.versions&&fm.versions.length)?fm.versions:[];   // 预测可用版本
  const bpv=(fm.bpVersions&&fm.bpVersions.length)?fm.bpVersions:[];     // BP可用版本
  const fcVers=(fm.forecastVersions&&fm.forecastVersions.length)?fm.forecastVersions:[];
  const vers=[...new Set([...fcVersList, ...bpv])];                     // 选择器选项=预测+BP版本合集
  if(!vers.length) vers.push('默认');
  // 默认预测版本：优先 国家办工作底稿(真实数据预测=工作底稿) → forecastVersions 偏好 → 首个
  if(!vers.includes(fin.version)) fin.version=fcVersList.find(v=>v==='国家办工作底稿')||fcVers.find(v=>fcVersList.includes(v))||fcVersList[0]||vers[0];
  // 默认BP版本：跟随预测(若BP同名,真实数据如此) → 国家办工作底稿 → 首个BP版本
  if(!bpv.includes(fin.bpVersion)) fin.bpVersion=bpv.includes(fin.version)?fin.version:(bpv.includes('国家办工作底稿')?'国家办工作底稿':(bpv[0]||fin.version));
  const months=[1,2,3,4,5,6,7,8,9,10,11,12];
  // 行1/行2 的下拉控件，DOM 串接后整体写入；多选用 makeMultiSelect 节点追加。
  const sel=(id,arr,cur,lab)=>'<select id="'+id+'">'+arr.map(v=>`<option value="${v}" ${String(v)===String(cur)?'selected':''}>${lab?lab(v):v}</option>`).join('')+'</select>';
  const toSel='<select id="finToM"><option value="0"'+(fin.toM?'':' selected')+'>最新实际月</option>'+months.map(m=>`<option value="${m}" ${+fin.toM===m?'selected':''}>${m}月</option>`).join('')+'</select>';
  const unitSel='<select id="finUnit">'+FIN_UNIT_OPTS.map(([v,l])=>`<option value="${v}" ${v===fin.unit?'selected':''}>${l}</option>`).join('')+'</select>';
  const basisSel='<select id="finBasis"><option value="actual"'+(fin.basis==='actual'?' selected':'')+'>实际</option><option value="forecast"'+(fin.basis==='forecast'?' selected':'')+'>预测</option></select>';
  // 数量单位固定为台(底表数量恒为台)，不再提供数量单位下拉。
  wrap.innerHTML=
    '<div class="fin-frow" id="finFRow1">'+
      '<span class="fld"><label>时间</label>'+sel('finFromM',months,fin.fromM,m=>m+'月')+'<span style="color:var(--c-ink-3)">~</span>'+toSel+'</span>'+
      '<span class="fld"><label>年</label>'+sel('finYear',yrs.length?yrs:[fin.year||0],fin.year)+'</span>'+
      '<span class="fld"><label>小数位</label>'+sel('finDp',[0,1,2,3],fin.dp,d=>d+'位')+'</span>'+
      '<span class="fld"><label>单位</label>'+unitSel+'</span>'+
      '<span class="fld" id="finRepsHolder"></span>'+
      '<span class="fld"><span id="finLoadingTip" class="wk" style="display:none">⟳ 刷新中…</span></span>'+
      '<span class="fld fin-actions" style="margin-left:auto"><button id="finExportXlsx" type="button">导出 Excel</button><button id="finExportPpt" type="button">导出 PPT</button></span>'+
    '</div>'+
    '<div class="fin-frow" id="finFRow2">'+
      '<span class="fld" id="finLv1Holder"></span>'+
      '<span class="fld" id="finLv2Holder"></span>'+
      '<span class="fld" id="finLv3Holder"></span>'+
      '<span class="fld" id="finLv4Holder"></span>'+
      '<span class="fld"><label>数据口径</label>'+basisSel+'</span>'+
    '</div>'+
    '<div class="fin-frow" id="finFRow3">'+
      '<span class="fld"><label>工作底稿</label>'+sel('finVersion',vers,fin.version,v=>String(v).replace(/工作底稿$/,'')||v)+'</span>'+
    '</div>';
  // 多选：国家办 + LV1~LV4（选项源 fin._dims，首屏可能为空，dims 到达后由 renderOverview 调 finBuildDimSelects() 刷新）
  finBuildDimSelects();
  // 单值下拉：onchange → drawFinanceAchieve()
  const bind=(id,fn)=>{ const el=$('#'+id); if(el) el.onchange=e=>{ fn(e.target.value); drawFinanceAchieve(); finStateSave(); }; };
  bind('finFromM', v=>fin.fromM=+v);
  bind('finToM', v=>fin.toM=+v);
  bind('finYear', v=>fin.year=+v);
  bind('finDp', v=>fin.dp=+v);
  bind('finUnit', v=>fin.unit=v);
  bind('finBasis', v=>fin.basis=v);
  bind('finVersion', v=>{ fin.version=v; if(bpv.includes(v)) fin.bpVersion=v; });   // 工作底稿口径同时驱动预测(version)与BP(bpVersion);BP无此版本则保留BP默认(示例数据预测/BP不同名时不互相打0)
  // 导出按钮(不触发重渲染)：导出当前筛选下的各看板表。
  { const bx=$('#finExportXlsx'); if(bx) bx.onclick=()=>exportFinDashboardXlsx();
    const bp=$('#finExportPpt'); if(bp) bp.onclick=()=>exportFinDashboardPpt(); }
}
// (重)渲染国家办 + LV1~LV4 多选到各 holder；选项源 finDimList(优先 fin._dims)。
// 拆出单独函数：首屏 buildFinControls 调一次(可能空选项)，renderOverview 拿到 o.dims 后再调一次刷新。
function finBuildDimSelects(){
  // 回载脏值防御：dims 到达后，剔除已选值里已不在当前选项的（避免把不存在的国家办/LVn 传给引擎）。
  const isect=(field,selKey)=>{ const opts=finDimList(field); if(!Array.isArray(opts)||!opts.length) return; const cur=asArrLocal(fin[selKey]); const kept=cur.filter(v=>opts.includes(v)); if(kept.length!==cur.length) fin[selKey]=kept; };
  isect('rep','reps'); isect('lv1','lv1'); isect('lv2','lv2'); isect('lv3','lv3'); isect('lv4','lv4');
  const ms=(holderId,label,opts,selArr,ph,onCommit)=>{ const h=$('#'+holderId); if(!h)return;
    h.innerHTML=''; h.appendChild(makeMultiSelect(label,opts||[],selArr,{placeholder:ph,
      onChange:v=>{ onCommit&&onCommit(v,false); }, onCommit:v=>{ onCommit&&onCommit(v,true); }})); };
  ms('finRepsHolder','国家办',finDimList('rep'),fin.reps,'全部国家办',(v,commit)=>{ fin.reps=v; if(commit){ drawFinanceAchieve(); finStateSave(); } });
  ms('finLv1Holder','LV1',finDimList('lv1'),fin.lv1,'全部LV1',(v,commit)=>{ fin.lv1=v; if(commit){ drawFinanceAchieve(); finStateSave(); } });
  ms('finLv2Holder','LV2',finDimList('lv2'),fin.lv2,'全部LV2',(v,commit)=>{ fin.lv2=v; if(commit){ drawFinanceAchieve(); finStateSave(); } });
  ms('finLv3Holder','LV3',finDimList('lv3'),fin.lv3,'全部LV3',(v,commit)=>{ fin.lv3=v; if(commit){ drawFinanceAchieve(); finStateSave(); } });
  ms('finLv4Holder','LV4',finDimList('lv4'),fin.lv4,'全部LV4',(v,commit)=>{ fin.lv4=v; if(commit){ drawFinanceAchieve(); finStateSave(); } });
}
// 达成率单元格(0%格式)：仍被全年BP达成面板(renderFinBpBoard→bbRevTable/bbCrossTable)复用。
function attainCell(v){ if(v==null) return '<span class="wk">—</span>'; const c=v>=1?'pos':(v>=0.9?'':'neg'); return `<span class="${c}">${(v*100).toFixed(0)}%</span>`; }
/* ---- 全年BP达成面板（经营分析顶部）：收入达成(Family/Rep/Rep×Family) + 销毛率pp ---- */
// pp 偏差：实际GM% − BP GM%，显示 +1.0 pct（红/绿），null → —
function bpPpCell(v){ if(v==null||!isFinite(v)) return '<span class="wk">—</span>'; const c=v>=0?'pos':'neg'; return `<span class="${c}">${(v>=0?'+':'')+(v*100).toFixed(1)} pct</span>`; }
function bpRateCell(v){ if(v==null||!isFinite(v)) return '<span class="wk">—</span>'; return (v*100).toFixed(1)+'%'; }
// 收入达成表：维度 | 今年实际 | 全年BP | 达成率。total 行过滤出列表、单独以"合计"加粗渲染
function bbRevTable(label, rows){
  const list=rows.filter(r=>r.key!=='total'); const total=rows.find(r=>r.key==='total');
  const rowHtml=(o,disp,cls)=>'<tr class="'+(cls||'')+'"><td class="lft">'+(disp||o.key)+'</td>'+
    `<td>${bpNumCell(o.actual)}</td><td>${bpNumCell(o.bp)}</td><td>${attainCell(o.attain)}</td></tr>`;
  let h='<table class="fa-table"><thead><tr><th class="lft">'+label+'</th><th>今年实际</th><th>全年BP</th><th>达成率</th></tr></thead><tbody>';
  if(total) h+=rowHtml(total,'合计','tot');
  h+=list.map(o=>rowHtml(o)).join('')+'</tbody></table>';
  return h;
}
// 国家办×Family 交叉表（无 total）
function bbCrossTable(rows){
  const rowHtml=o=>'<tr><td class="lft">'+o.rep+'</td><td class="lft">'+o.family+'</td>'+
    `<td>${bpNumCell(o.actual)}</td><td>${bpNumCell(o.bp)}</td><td>${attainCell(o.attain)}</td></tr>`;
  let h='<table class="fa-table"><thead><tr><th class="lft">Rep Office</th><th class="lft">Product Family</th><th>今年实际</th><th>全年BP</th><th>达成率</th></tr></thead><tbody>';
  h+=rows.map(rowHtml).join('')+'</tbody></table>';
  return h;
}
// 销毛率达成表：维度 | 实际GM% | BP GM% | 达成(pp)。total → 合计
function bbGmrTable(label, rows){
  const list=rows.filter(r=>r.key!=='total'); const total=rows.find(r=>r.key==='total');
  const rowHtml=(o,disp,cls)=>'<tr class="'+(cls||'')+'"><td class="lft">'+(disp||o.key)+'</td>'+
    `<td>${bpRateCell(o.actGmPct)}</td><td>${bpRateCell(o.bpGmPct)}</td><td>${bpPpCell(o.pp)}</td></tr>`;
  let h='<table class="fa-table"><thead><tr><th class="lft">'+label+'</th><th>实际GM%</th><th>BP GM%</th><th>达成(pp)</th></tr></thead><tbody>';
  if(total) h+=rowHtml(total,'合计','tot');
  h+=list.map(o=>rowHtml(o)).join('')+'</tbody></table>';
  return h;
}
async function renderFinBpBoard(){
  const host=$('#finBpBoard'); if(!host) return;
  if(!state.finMeta){ host.innerHTML=''; return; }
  const b=await api.financeBPBoard({version:fin.version,year:fin.year,brands:fin.brands,bpVersion:fin.bpVersion||undefined,finUnits:fin.finUnits});
  if(!b || b.error || !b.hasBP){
    host.innerHTML=faSection('全年BP达成', '', '<div style="padding:14px 16px;font-size:12px;color:var(--ink3)">未识别到全年BP数据（请把 BP 文件放入财经文件夹）</div>');
    return;
  }
  const sub='BP版本：'+b.bpVersion+' · 截至 '+b.cutoff+' 月（今年实际 1~'+b.cutoff+'月 ÷ 全年BP）';
  let revH='';
  revH+=faSection('收入达成 · 分 Product Family', sub, bbRevTable('Product Family', b.revByFamily));
  revH+=faSection('收入达成 · 分 Rep Office', sub, bbRevTable('Rep Office', b.revByRep));
  revH+=faSection('收入达成 · Rep Office × Product Family', sub, bbCrossTable(b.revByRepFamily));
  let gmH='';
  gmH+=faSection('销售毛利率达成 · 分 Product Family', sub, bbGmrTable('Product Family', b.gmrByFamily));
  gmH+=faSection('销售毛利率达成 · 分 Rep Office', sub, bbGmrTable('Rep Office', b.gmrByRep));
  host.innerHTML='<div class="fa-card"><div class="fa-head"><span class="nm">全年BP达成</span><span class="sub">'+sub+'</span></div>'+
    '<div style="padding:12px 14px;display:flex;flex-direction:column;gap:14px">'+
      '<div class="bb-grp"><div class="bb-grp-t">收入达成</div>'+revH+'</div>'+
      '<div class="bb-grp"><div class="bb-grp-t">销售毛利率达成</div>'+gmH+'</div>'+
    '</div></div>';
}

/* ---- 重设计主渲染入口：渲染全局筛选条 → 各分块（Task 6+ 逐块接入） ---- */
async function drawFinanceAchieve(){
  const finBody = document.querySelector('#view-finance .fin-body');
  const finScrollTop = finBody ? finBody.scrollTop : 0;
  try {
  if(!state.finMeta){ const em=document.getElementById('finEmpty'); if(em) em.classList.remove('hidden'); return; }
  // 防御：筛选条构建(首屏一次,之后幂等早返回)即使抛错也不挡看板重渲染——保证"筛选变化下面值会更新"。
  try{ buildFinControls(); }catch(e){ console.error('buildFinControls failed',e); }
  // 加载态：四块半透明 + 筛选条"刷新中"提示;四块渲染互不依赖,并行拉取(各自一次IPC)。
  const rd=document.querySelector('#view-finance .fin-rd');
  const tip=document.getElementById('finLoadingTip');
  if(rd) rd.classList.add('fin-loading'); if(tip) tip.style.display='';
  try{
    await Promise.all([renderOverview(), renderProductBoard(), renderRepBoard(), renderCustom()]);
  } finally {
    if(rd) rd.classList.remove('fin-loading'); if(tip) tip.style.display='none';
  }
  finStateSave();
  if(typeof currentView==='function' && currentView()==='finance') renderDataBar('finance');
  } finally {
    const b2 = document.querySelector('#view-finance .fin-body');
    if (b2) b2.scrollTop = finScrollTop;
  }
}
// 经营总览块：调 financeOverview 渲染总看板 5 行 × 3 卡片到 #finSecOverview；并用返回的 dims 刷新 LV1-4/国家办下拉选项。
function finOverviewParams(){ return {year:fin.year,fromM:fin.fromM,toM:(+fin.toM)||undefined,
  version:fin.version, bpVersion:fin.bpVersion, reps:fin.reps, lv1:fin.lv1,lv2:fin.lv2,lv3:fin.lv3,lv4:fin.lv4,
  finUnits:fin.finUnits, finQtyUnits:fin.finQtyUnits}; }
const FIN_UNIT_DIV={USD:1,MUSD:1e6}, FIN_UNIT_SYM={USD:'$',MUSD:''}, FIN_UNIT_SUF={USD:'',MUSD:'M'};
function finFmtAmt(v){ if(v==null||!isFinite(v)) return '—'; const d=FIN_UNIT_DIV[fin.unit]||1;
  return (FIN_UNIT_SYM[fin.unit]||'')+(v/d).toLocaleString('en-US',{minimumFractionDigits:fin.dp,maximumFractionDigits:fin.dp})+(FIN_UNIT_SUF[fin.unit]||''); }
// NSIP=净销售价(USD/台),恒按 USD 显示,绝不随顶部金额单位(MUSD)缩放,否则单价会被 ÷1e6 显示成 0.0M。
function finFmtNsip(v){ if(v==null||!isFinite(v)) return '—';
  return '$'+v.toLocaleString('en-US',{minimumFractionDigits:fin.dp,maximumFractionDigits:fin.dp}); }
function finFmtQty(v){ if(v==null||!isFinite(v)) return '—'; return v.toLocaleString('en-US',{maximumFractionDigits:0}); }
function finPct(v){ if(v==null||!isFinite(v)) return '<span class="wk">—</span>'; const c=v>=1?'pos':(v>=0.9?'':'neg'); return `<span class="${c}">${(v*100).toFixed(fin.dp)}%</span>`; }
function finYoyPct(v){ if(v==null||!isFinite(v)) return '<span class="wk">—</span>'; return `<span class="${v>=0?'pos':'neg'}">${(v>=0?'+':'')+(v*100).toFixed(fin.dp)}%</span>`; }
function finPp(v){ if(v==null||!isFinite(v)) return '<span class="wk">—</span>'; return `<span class="${v>=0?'pos':'neg'}">${(v>=0?'+':'')+(v*100).toFixed(fin.dp)}pp</span>`; }
// NSIP 是单价(USD),其同比/与目标差为绝对金额差(±USD,非 pp),恒按 USD 显示(不随 MUSD 缩放)。
function finSignNsip(v){ if(v==null||!isFinite(v)) return '<span class="wk">—</span>'; return `<span class="${v>=0?'pos':'neg'}">${(v>=0?'+':'')+finFmtNsip(v)}</span>`; }
// 一行 = 3 张 .ov-card：①名称+值+同比 ②BP完成率+达成值/BP值 ③预测完成率+达成值/预测值
function ovCard(k,vTxt,subHtml){ return '<div class="ov-card"><div class="ov-k">'+k+'</div><div class="ov-v">'+vTxt+'</div><div class="ov-sub">'+subHtml+'</div></div>'; }
function finOvRow(name,valTxt,yoyHtml,bpAttain,bpPair,fcAttain,fcPair,range,prog){
  const lead=a=>(a!=null&&isFinite(a)&&prog!=null)?(' · 进度差 '+finPp(a-prog)):'';
  return '<div class="ov-grid">'+
    ovCard(name, valTxt, '同比 '+yoyHtml)+
    ovCard('BP完成率('+range+')', finPct(bpAttain), '达成值/BP值 '+bpPair+lead(bpAttain))+
    ovCard('预测完成率', finPct(fcAttain), '达成值/预测值 '+fcPair+lead(fcAttain))+
  '</div>'; }
// 率/单价行：卡①值+pp差(同比) 卡②BP差(pp/绝对)+实际/BP 卡③预测差+实际/预测
function finOvRateRow(name,valTxt,prevDiffHtml,bpDiffHtml,bpPair,fcDiffHtml,fcPair,range){
  return '<div class="ov-grid">'+
    ovCard(name, valTxt, '同比 '+prevDiffHtml)+
    ovCard('vs BP('+range+')', bpDiffHtml, '实际/BP值 '+bpPair)+
    ovCard('vs 预测', fcDiffHtml, '实际/预测值 '+fcPair)+
  '</div>'; }
// 数据体检面板：引擎解析结果可视化(指标名/版本/单位假设/NSIP缺口/财经↔PSI名称)。
// <details> 折叠,默认收起;重渲染保留展开状态;有异常时标题带计数。
function finRenderHealth(o){
  const box=document.getElementById('finSecHealth'); if(!box) return;
  const h=o&&o.health; if(!h||!h.hasFin){ box.innerHTML=''; return; }
  const prev=box.querySelector('details'); const wasOpen=prev?prev.open:false;
  const gapTotal=(h.nsipGaps||[]).reduce((s,g)=>s+(g.count||0),0);
  const mm=h.psiMismatch||{}; const mmTotal=((mm.reps||[]).length)+((mm.lv3||[]).length)+((mm.lv4||[]).length);
  const warn=gapTotal+(h.hasPsi?mmTotal:0);
  const li=(k,v)=>'<div class="fh-row"><span class="fh-k">'+k+'</span><span class="fh-v">'+v+'</span></div>';
  const names=arr=>(arr&&arr.length)?arr.join('、'):'—';
  let body='';
  body+=li('收入指标', h.metricsResolved.rev||'<span class="neg">未识别</span>');
  body+=li('销毛指标', h.metricsResolved.gm||'<span class="neg">未识别</span>');
  body+=li('NSIP分母', names(h.metricsResolved.nsipDenoms));
  body+=li('预测版本', names(h.versions.forecast)+'（当前 '+(o.version||'—')+'）');
  body+=li('BP版本', names(h.versions.bp)+'（当前 '+(o.bpVersion||'—')+'）');
  body+=li('单位假设', '实际='+fin.finUnits.actual+' · 预测='+fin.finUnits.forecast+' · BP='+fin.finUnits.bp+'（数量恒为台）');
  (h.nsipGaps||[]).forEach(g=>{ body+=li(g.year+'年NSIP缺口',
    g.count?('<span class="neg">'+g.count+' 个产品有收入无收入量</span>：'+g.samples.join('、')+(g.count>g.samples.length?' …':'')):'<span class="pos">无</span>'); });
  if(h.hasPsi){
    body+=li('PSI对不上·国家办', (mm.reps&&mm.reps.length)?('<span class="neg">'+mm.reps.join('、')+'</span>'):'<span class="pos">全部匹配</span>');
    body+=li('PSI对不上·LV3系列', (mm.lv3&&mm.lv3.length)?('<span class="neg">'+mm.lv3.join('、')+'</span>'):'<span class="pos">全部匹配</span>');
    body+=li('PSI对不上·LV4产品', (mm.lv4&&mm.lv4.length)?('<span class="neg">'+mm.lv4.join('、')+'</span>'):'<span class="pos">全部匹配</span>');
  } else body+=li('PSI库','未加载（Sell-in/out 实际不可用）');
  body+=li('SISO口径','财经收入量 vs PSI sell-in 差 ≤'+(h.tolerance||100)+' 台属正常（DOS>90 递延）');
  box.innerHTML='<details class="fin-health"'+(wasOpen?' open':'')+'><summary>🩺 数据体检'+
    (warn?' <span class="neg">（'+warn+' 项异常）</span>':' <span class="pos">（正常）</span>')+
    '</summary><div class="fh-body">'+body+'</div></details>';
}
// Sell In 卡片警示：|PSI sell-in − 财经收入量| > 100台 → 黄标(≤100台差异属正常口径差,DOS>90递延)。
function finSisoWarn(o){
  const psi=o&&o.metrics&&o.metrics.sellIn?o.metrics.sellIn.actual:null;
  const finQ=o?o.finSiAct:null;
  if(psi==null||finQ==null||(psi<=0&&finQ<=0)) return '';
  const d=Math.abs(psi-finQ); if(d<=100) return '';
  return ' <span class="fin-warn" title="财经收入量(区间)='+Math.round(finQ)+'台，PSI sell-in='+Math.round(psi)+
    '台；差>100台，可能存在系列/名称漏配或大额递延">⚠ 与财经收入量差 '+Math.round(d).toLocaleString('en-US')+' 台</span>';
}
async function renderOverview(){
  const host=document.getElementById('finSecOverview'); if(!host) return;
  const o=await api.financeOverview(finOverviewParams()); fin.ov=o;
  // 用返回的 dims 填充/刷新 LV1-4 + 国家办下拉选项(首屏 buildFinControls 先于 dims 到达，故此处刷新一次)。
  // 仅当选项内容变化时重建，避免每次渲染都重建多选(否则会关闭用户正打开的面板)。
  if(o && o.dims){ const sig=JSON.stringify(o.dims), prevSig=fin._dimsSig;
    fin._dims=o.dims; fin._dimsSig=sig;
    if(sig!==prevSig){
      // 剪掉恢复自 localStorage 但当前数据里已不存在的名字(换数据源后防"隐形筛选")
      const keep=(a,opts)=>{ const st=new Set(opts||[]); return (a||[]).filter(v=>st.has(v)); };
      fin.reps=keep(fin.reps,o.dims.reps); fin.lv1=keep(fin.lv1,o.dims.lv1); fin.lv2=keep(fin.lv2,o.dims.lv2);
      fin.lv3=keep(fin.lv3,o.dims.lv3); fin.lv4=keep(fin.lv4,o.dims.lv4);
      fin.rep.reps=keep(fin.rep.reps,o.dims.reps); fin.rep.series=keep(fin.rep.series,o.dims.lv3);
      finBuildDimSelects();
      if(document.getElementById('finRepFilters')) finBuildRepFilter();   // 并行首屏时 rep 块筛选条先于 dims 建好,此处补选项
    } }
  finRenderHealth(o);
  if(!o || !o.metrics){ host.innerHTML=''; return; }
  const range=(o.fromM||1)+'-'+(o.toM||'')+'月';
  const progSpan=Math.max(1,(o.toM||12)-(o.fromM||1)+1), prog=progSpan/12;
  const progTxt=(prog*100).toFixed(0)+'%';
  const M=o.metrics;
  const amtRow=(name,m)=>finOvRow(name,
     finFmtAmt(m.actual), finYoyPct(m.yoy),
     m.bpAttain, finFmtAmt(m.actual)+' / '+finFmtAmt(m.bp),
     m.fcAttain, finFmtAmt(m.actual)+' / '+finFmtAmt(m.fc), range, prog);
  const qtyRow=(name,m)=>finOvRow(name,
     finFmtQty(m.actual), finYoyPct(m.yoy),
     m.bpAttain, finFmtQty(m.actual)+' / '+finFmtQty(m.bp),
     m.fcAttain, finFmtQty(m.actual)+' / '+finFmtQty(m.fc), range, prog);
  const gmrFmt=v=>v==null||!isFinite(v)?'—':(v*100).toFixed(fin.dp)+'%';
  // diffFmt：销毛率用 finPp(pp 差)；NSIP 是单价,差值为绝对金额,用 finSignNsip(±USD,恒 USD)。
  const rateRow=(name,m,fmt,diffFmt)=>finOvRateRow(name,
     fmt(m.actual), diffFmt(m.prevDiff),
     diffFmt(m.bpDiff), fmt(m.actual)+' / '+fmt(m.bp),
     diffFmt(m.fcDiff), fmt(m.actual)+' / '+fmt(m.fc), range);
  // 登记总看板导出单元(小表+活公式)；build 返回缓存的 fin.ov。
  fin._expUnits['overview']={title:'总看板',kind:'overview',build:()=>({o:fin.ov})};
  const exp='<span class="fin-unit-exp"><button type="button" data-exp="xlsx" data-id="overview">📊 Excel</button><button type="button" data-exp="ppt" data-id="overview">📑 PPT</button></span>';
  host.innerHTML='<div class="fin-sec-t">总看板 · '+range+' <span class="wk" style="font-weight:400">· 时间进度 '+progTxt+'</span>'+exp+'</div>'+
    '<div style="display:flex;flex-direction:column;gap:10px">'+
      amtRow('净销售收入',M.rev)+
      qtyRow('Sell In量'+finSisoWarn(o),M.sellIn)+
      qtyRow('Sell out量',M.sellOut)+
      rateRow('销毛率',M.gmr,gmrFmt,finPp)+
      rateRow('NSIP',M.nsip,finFmtNsip,finSignNsip)+
    '</div>';
  finBindUnitExp(host);
  finBindRowCtl(host);
}
/* ---- 产业产品经营看板(4 表)：产品线 / 平板分系列 / 音频分系列 / LV4 产品 ----
   调 financeProductBoard(finOverviewParams())，与总看板同参→顶部筛选自动联动。
   列顺序见 spec：表1-3 含同比(NSIP 无同比)；表4 仅当年8列(无同比)。 */
function finRate(v){ return v==null||!isFinite(v)?'—':(v*100).toFixed(fin.dp)+'%'; }
// 全列定义(key→单元格格式)。表1-3 用全 14 列；表4(lv4)用 LV4_KEYS 子集。
const FIN_PB_COLS=[
  {key:'rev25',  label:'25年收入',   fmt:o=>finFmtAmt(o.rev25)},
  {key:'rev26',  label:'26年收入',   fmt:o=>finFmtAmt(o.rev26)},
  {key:'revYoy', label:'收入同比',   fmt:o=>finYoyPct(o.revYoy)},
  {key:'gm25',   label:'25年销毛额', sep:true, fmt:o=>finFmtAmt(o.gm25)},
  {key:'gm26',   label:'26年销毛额', fmt:o=>finFmtAmt(o.gm26)},
  {key:'gmYoy',  label:'销毛额同比', fmt:o=>finYoyPct(o.gmYoy)},
  {key:'gmr25',  label:'25年销毛率', sep:true, fmt:o=>finRate(o.gmr25)},
  {key:'gmr26',  label:'26年销毛率', fmt:o=>finRate(o.gmr26)},
  {key:'nsip25', label:'25年NSIP',  sep:true, fmt:o=>finFmtNsip(o.nsip25)},
  {key:'nsip26', label:'26年NSIP',  fmt:o=>finFmtNsip(o.nsip26)},
  {key:'nsipYoy',label:'NSIP同比',  fmt:o=>finSignNsip(o.nsipYoy)},
  {key:'bp',     label:'全年BP',     sep:true, fmt:o=>finFmtAmt(o.bp)},
  {key:'bpAttain',label:'BP达成率',  fmt:o=>finPct(o.bpAttain)},
  {key:'fc',     label:'全年预测',   sep:true, fmt:o=>finFmtAmt(o.fc)},
  {key:'fcAttain',label:'全年预测达成率', fmt:o=>finPct(o.fcAttain)},
];
const FIN_PB_LV4_KEYS=['rev26','gm26','gmr26','nsip26','bp','bpAttain','fc','fcAttain'];
// 国家办整体表(Task10)：NSIP同比(±USD 绝对差)已并入 FIN_PB_COLS,国家办板与产品板列完全一致。
const FIN_RB_COLS=FIN_PB_COLS;
const FIN_RB_KEYS=FIN_RB_COLS.map(c=>c.key);
// 单表 HTML：firstLabel=名称列表头；total 行加粗(.tot)；series 表按 faSortSeries 排序。
// colSrc 默认 FIN_PB_COLS(产品14列)；国家办整体表传 FIN_RB_COLS(含 NSIP同比)。
/* ---- 行隐藏+自定义顺序(用户 2026-08-24 同款):键=表 id(pb-line/pb-tablet/.../rb-lv4),
   独立桶 sb.fin.rowhide / sb.fin.roworder。新行(新品)不在存档 → append 尾部必显示。
   合计行不进管线,口径不动。 ---- */
const FIN_HIDE_LS='sb.fin.rowhide', FIN_ORDER_LS='sb.fin.roworder';
function finRH(){ return (typeof window!=='undefined'&&window.RowHide)?window.RowHide:require('../row-hide-core.js'); }
function finRO(){ return (typeof window!=='undefined'&&window.RowOrder)?window.RowOrder:require('../row-order-core.js'); }
function finLsAll(ls){ try{ return JSON.parse(localStorage.getItem(ls))||{}; }catch(e){ return {}; } }
function finHideGet(id){ return finLsAll(FIN_HIDE_LS)[id]||[]; }
function finHideSet(id,arr){ const all=finLsAll(FIN_HIDE_LS); if(arr&&arr.length) all[id]=arr; else delete all[id];
  try{ localStorage.setItem(FIN_HIDE_LS,JSON.stringify(all)); }catch(e){} }
function finOrderGet(id){ return finLsAll(FIN_ORDER_LS)[id]||[]; }
function finOrderSet(id,arr){ const all=finLsAll(FIN_ORDER_LS); if(arr&&arr.length) all[id]=arr; else delete all[id];
  try{ localStorage.setItem(FIN_ORDER_LS,JSON.stringify(all)); }catch(e){} }
function finRowsPipeline(rows,secId){
  if(!secId) return rows;
  let out=finRH().visible(rows,finHideGet(secId));
  const saved=finOrderGet(secId);
  if(saved.length){ const km={}; out.forEach(o=>{ km[o.key]=o; }); out=finRO().apply(out.map(o=>o.key),saved).map(k=>km[k]); }
  return out;
}
function finPbTable(firstLabel, block, colKeys, isSeries, colSrc, secId){
  if(!block) return '';
  const cols=(colSrc||FIN_PB_COLS).filter(c=>colKeys.includes(c.key));
  const ctl=!!secId;
  const thead='<tr>'+(ctl?'<th style="width:30px"></th>':'')+'<th class="lft">'+firstLabel+'</th>'+
    cols.map(c=>`<th class="${c.sep?'col-sep':''}">${c.label}</th>`).join('')+'</tr>';
  const rowHtml=(o,cls)=>cls
    ? '<tr class="'+cls+'">'+(ctl?'<td></td>':'')+'<td class="lft">'+o.key+'</td>'+
      cols.map(c=>`<td class="${c.sep?'col-sep':''}">${c.fmt(o)}</td>`).join('')+'</tr>'
    : '<tr'+(ctl?' draggable="true" data-rowkey="'+encodeURIComponent(o.key)+'"':'')+'>'
      +(ctl?'<td style="white-space:nowrap"><button class="row-hide-btn" data-finhiderow="'+encodeURIComponent(o.key)+'" title="隐藏此行(不影响合计,标题旁「行」chip 可恢复)" style="border:none;background:none;color:var(--c-ink-3);cursor:pointer;font-size:11px;padding:0 3px">✕</button><span style="cursor:grab;color:var(--c-ink-3);font-size:10px" title="按住整行拖动调顺序(会记住)">⠿</span></td>':'')
      +'<td class="lft">'+o.key+'</td>'+
      cols.map(c=>`<td class="${c.sep?'col-sep':''}">${c.fmt(o)}</td>`).join('')+'</tr>';
  let rows=(block.rows||[]).slice();
  if(isSeries && typeof faSortSeries==='function') rows=faSortSeries(rows);
  rows=finRowsPipeline(rows,secId);
  let body='';
  if(block.total) body+=rowHtml(block.total,'tot');
  body+=rows.map(o=>rowHtml(o)).join('');
  return '<table class="fa-table"><thead>'+thead+'</thead><tbody>'+body+'</tbody></table>';
}
function finPbSection(title, tableHtml, unitId){
  const exp=unitId?'<span class="fin-unit-exp"><button type="button" data-exp="xlsx" data-id="'+unitId+'">📊 Excel</button><button type="button" data-exp="ppt" data-id="'+unitId+'">📑 PPT</button></span>':'';
  const mgr=unitId?' <span class="chip" data-finmgr="'+unitId+'" style="cursor:pointer;background:var(--c-brand-soft);color:var(--c-brand);font-size:11px;padding:1px 8px;border-radius:12px">行 <b>—</b> ▾</span>':'';
  return '<div class="fin-sec-t" style="position:relative">'+title+mgr+exp+'</div><div class="fa-wrap"'+(unitId?' data-finwrap="'+unitId+'"':'')+'>'+tableHtml+'</div>';
}
/* 行控件统一绑定:✕/拖拽/管理器面板。repaint 走 fin._expUnits[id].build() 局部重画,零取数 */
function finBindRowCtl(host){
  if(!host) return;
  const repaint=id=>{
    const u=fin._expUnits[id]; if(!u) return;
    let d; try{ d=u.build(); }catch(e){ return; }
    const wrap=host.querySelector('[data-finwrap="'+id+'"]'); if(!wrap) return;
    wrap.innerHTML=finPbTable(d.firstLabel,d.block,d.colKeys,d.isSeries,d.colSrc,id);
    bindWrap(wrap,id);
    syncChip(id);
  };
  const allKeysOf=id=>{
    const u=fin._expUnits[id]; if(!u) return [];
    let d; try{ d=u.build(); }catch(e){ return []; }
    let rows=((d.block&&d.block.rows)||[]).slice();
    if(d.isSeries&&typeof faSortSeries==='function') rows=faSortSeries(rows);
    const ks=rows.map(o=>o.key);
    finHideGet(id).forEach(k=>{ if(ks.indexOf(k)<0) ks.push(k); });
    return ks;
  };
  const syncChip=id=>{
    const chip=host.querySelector('[data-finmgr="'+id+'"]'); if(!chip) return;
    const b=chip.querySelector('b'); const n=allKeysOf(id).length;
    if(b) b.textContent=(n-finHideGet(id).length)+'/'+n;
  };
  const bindWrap=(wrap,id)=>{
    wrap.querySelectorAll('[data-finhiderow]').forEach(bt=>bt.onclick=()=>{
      finHideSet(id,finRH().add(finHideGet(id),decodeURIComponent(bt.dataset.finhiderow)));
      repaint(id);
    });
    let drag=null;
    wrap.querySelectorAll('tr[data-rowkey]').forEach(tr=>{
      tr.ondragstart=e=>{ drag=tr.dataset.rowkey; try{ e.dataTransfer.effectAllowed='move'; }catch(_){ } };
      tr.ondragover=e=>e.preventDefault();
      tr.ondrop=e=>{
        e.preventDefault();
        if(drag==null) return;
        const keys=[...wrap.querySelectorAll('tr[data-rowkey]')].map(x=>x.dataset.rowkey);
        const from=keys.indexOf(drag), to=keys.indexOf(tr.dataset.rowkey);
        drag=null;
        if(from<0||to<0||from===to) return;
        finOrderSet(id,finRO().move(keys,from,to).map(decodeURIComponent));
        repaint(id);
      };
    });
  };
  host.querySelectorAll('[data-finmgr]').forEach(chip=>{
    const id=chip.dataset.finmgr;
    chip.onclick=()=>{
      let pnl=chip.parentElement.querySelector('.fin-mgr-panel'); if(pnl){ pnl.remove(); return; }
      pnl=document.createElement('div'); pnl.className='fin-mgr-panel';
      pnl.style.cssText='position:absolute;top:calc(100% - 2px);left:'+Math.max(8,chip.offsetLeft)+'px;z-index:60;background:var(--c-bg-elev);border:1px solid var(--c-line);border-radius:8px;box-shadow:0 10px 30px rgba(0,0,0,.14);padding:8px 10px;max-height:280px;overflow:auto;min-width:220px';
      const hid0=finHideGet(id);
      allKeysOf(id).forEach(k=>{
        const row=document.createElement('label'); row.style.cssText='display:flex;align-items:center;gap:8px;padding:2px 0;font-size:12px;color:var(--c-ink-1);cursor:pointer';
        const ck=document.createElement('input'); ck.type='checkbox'; ck.checked=hid0.indexOf(k)<0;
        ck.onchange=()=>{ finHideSet(id,ck.checked?finRH().remove(finHideGet(id),k):finRH().add(finHideGet(id),k)); repaint(id); };
        const nm=document.createElement('span'); nm.textContent=k; nm.style.flex='1';
        row.appendChild(ck); row.appendChild(nm); pnl.appendChild(row);
      });
      const all=document.createElement('button'); all.textContent='全部显示'; all.className='btn'; all.style.cssText='margin-top:6px;padding:2px 10px;font-size:11px;width:100%';
      all.onclick=()=>{ finHideSet(id,[]); repaint(id); pnl.querySelectorAll('input').forEach(c=>{ c.checked=true; }); };
      pnl.appendChild(all);
      chip.parentElement.appendChild(pnl);
    };
    syncChip(id);
  });
  host.querySelectorAll('[data-finwrap]').forEach(w=>bindWrap(w,w.dataset.finwrap));
}
// 逐表导出单元注册表(id→{title,kind,build})。build() 在导出时被调用,读取当前数据(闭包引用 fin.prod/fin.repBoard/fin.cust)。
fin._expUnits={};
// 在 host 上为本块刚渲染的 .fin-unit-exp 按钮挂 onclick(不触发看板重渲染)。
function finBindUnitExp(host){ if(!host) return;
  host.querySelectorAll('.fin-unit-exp button').forEach(b=>{ b.onclick=()=>{
    const ex=b.dataset.exp, id=b.dataset.id;
    if(ex==='png') exportUnitPng(id);
    else if(ex==='ppt') exportUnitPpt(id);
    else exportUnitXlsx(id); }; }); }
async function renderProductBoard(){
  const host=document.getElementById('finSecProduct'); if(!host) return;
  const b=await api.financeProductBoard(finOverviewParams()); fin.prod=b;
  if(!b || b.error){ host.innerHTML=''; return; }
  const allKeys=FIN_PB_COLS.map(c=>c.key);
  // 登记本块 4 表导出单元(build 闭包读取当前 fin.prod)。
  const reg=(id,title,fn)=>{ fin._expUnits[id]={title,kind:'table',build:()=>Object.assign({secId:id},fn())}; };
  reg('pb-line','产品线',()=>({firstLabel:'产品线',block:fin.prod.line,colKeys:allKeys,isSeries:false}));
  reg('pb-tablet','平板分系列',()=>({firstLabel:'系列',block:fin.prod.famTablet,colKeys:allKeys,isSeries:true}));
  reg('pb-audio','音频分系列',()=>({firstLabel:'系列',block:fin.prod.famAudio,colKeys:allKeys,isSeries:true}));
  reg('pb-lv4','LV4 产品',()=>({firstLabel:'LV4 产品',block:fin.prod.lv4,colKeys:FIN_PB_LV4_KEYS,isSeries:false}));
  const pbProg=((Math.max(1,(b.toM||12)-(b.fromM||1)+1)/12)*100).toFixed(0);
  let h='<div class="fin-sec-t">产业产品经营看板 <span class="wk" style="font-weight:400">· 时间进度 '+pbProg+'%（'+(b.fromM||1)+'-'+(b.toM||12)+'月实际 ÷ 全年BP/预测）</span></div>';
  h+=finPbSection('产品线', finPbTable('产品线', b.line, allKeys, false, null, 'pb-line'), 'pb-line');
  h+=finPbSection('平板分系列', finPbTable('系列', b.famTablet, allKeys, true, null, 'pb-tablet'), 'pb-tablet');
  h+=finPbSection('音频分系列', finPbTable('系列', b.famAudio, allKeys, true, null, 'pb-audio'), 'pb-audio');
  h+=finPbSection('LV4 产品', finPbTable('LV4 产品', b.lv4, FIN_PB_LV4_KEYS, false, null, 'pb-lv4'), 'pb-lv4');
  host.innerHTML=h;
  finBindUnitExp(host);
  finBindRowCtl(host);
}
/* ---- 国家办维度看板(3 表 + 本块独立筛选)：Task 10 ----
   #finSecRep 顶部一条本块专属筛选条(时间/国家办/产品系列)，绑定 fin.rep.*；
   其 onchange 只调 renderRepBoard()（不重渲染总看板/产品块）。
   3 表：①国家办整体(15列,含NSIP同比) ②国家办×产品系列(14列) ③LV4产品(8列)。 */
function finRepParams(){ return { year:fin.year, fromM:fin.rep.fromM, toM:(+fin.rep.toM)||undefined,
  version:fin.version, bpVersion:fin.bpVersion, reps:fin.rep.reps, series:fin.rep.series, finUnits:fin.finUnits, finQtyUnits:fin.finQtyUnits }; }
// 渲染本块独立筛选条到 #finRepFilters；选项源 fin._dims(reps / lv3)。onchange→renderRepBoard()。
function finBuildRepFilter(){
  const wrap=$('#finRepFilters'); if(!wrap) return;
  const months=[1,2,3,4,5,6,7,8,9,10,11,12];
  const fromSel='<select id="finRepFromM">'+months.map(m=>`<option value="${m}" ${+fin.rep.fromM===m?'selected':''}>${m}月</option>`).join('')+'</select>';
  const toSel='<select id="finRepToM"><option value="0"'+(fin.rep.toM?'':' selected')+'>最新实际月</option>'+months.map(m=>`<option value="${m}" ${+fin.rep.toM===m?'selected':''}>${m}月</option>`).join('')+'</select>';
  wrap.innerHTML='<span class="fld"><label>时间</label>'+fromSel+'<span style="color:var(--c-ink-3)">~</span>'+toSel+'</span>'+
    '<span class="fld" id="finRepRepsHolder"></span>'+
    '<span class="fld" id="finRepSeriesHolder"></span>';
  // 时间下拉：onchange 只重渲染本块
  const bind=(id,fn)=>{ const el=$('#'+id); if(el) el.onchange=e=>{ fn(e.target.value); renderRepBoard(); finStateSave(); }; };
  bind('finRepFromM', v=>fin.rep.fromM=+v);
  bind('finRepToM', v=>fin.rep.toM=+v);
  // 多选：国家办 + 产品系列(lv3)；onCommit 时只重渲染本块
  const ms=(holderId,label,opts,selArr,ph,setter)=>{ const h=$('#'+holderId); if(!h)return;
    h.innerHTML=''; h.appendChild(makeMultiSelect(label,opts||[],selArr,{placeholder:ph,
      onCommit:v=>{ setter(v); renderRepBoard(); finStateSave(); }})); };
  // 回载脏值防御：dims 到达后剔除已选里已不在选项的国家办/系列。
  { const ro=finDimList('rep'); if(Array.isArray(ro)&&ro.length) fin.rep.reps=asArrLocal(fin.rep.reps).filter(v=>ro.includes(v));
    const so=finDimList('lv3'); if(Array.isArray(so)&&so.length) fin.rep.series=asArrLocal(fin.rep.series).filter(v=>so.includes(v)); }
  ms('finRepRepsHolder','国家办',finDimList('rep'),fin.rep.reps,'全部国家办',v=>fin.rep.reps=v);
  ms('finRepSeriesHolder','产品系列',finDimList('lv3'),fin.rep.series,'全部系列',v=>fin.rep.series=v);
}
async function renderRepBoard(){
  const host=document.getElementById('finSecRep'); if(!host) return;
  if(!state.finMeta){ host.innerHTML=''; return; }
  // 先建/保留筛选条骨架(含 #finRepFilters)，再把 3 表渲染到 #finRepTables；重渲染只换表，不重建筛选条。
  if(!host.querySelector('#finRepFilters')){
    host.innerHTML='<div class="fin-sec-t">国家办经营看板 <span id="finRepProg" class="wk" style="font-weight:400"></span></div>'+
      '<div class="fin-filters"><div class="fin-frow" id="finRepFilters"></div></div>'+
      '<div id="finRepTables"></div>';
    finBuildRepFilter();
  }
  const b=await api.financeRepBoard(finRepParams()); fin.repBoard=b;
  const box=host.querySelector('#finRepTables'); if(!box) return;
  const rpEl=host.querySelector('#finRepProg');
  if(rpEl && b && !b.error) rpEl.textContent='· 时间进度 '+((Math.max(1,(b.toM||12)-(b.fromM||1)+1)/12)*100).toFixed(0)+'%（'+(b.fromM||1)+'-'+(b.toM||12)+'月实际 ÷ 全年BP/预测）';
  else if(rpEl) rpEl.textContent='';   // error/无数据时清空,避免残留上次进度文案
  if(!b || b.error){ box.innerHTML=''; return; }
  // 登记本块 3 表导出单元(build 闭包读取当前 fin.repBoard,renderRepBoard 已每次刷新该字段)。
  const PB=FIN_PB_COLS.map(c=>c.key);
  const reg=(id,title,fn)=>{ fin._expUnits[id]={title,kind:'table',build:()=>Object.assign({secId:id},fn())}; };
  reg('rb-table','国家办整体',()=>({firstLabel:'国家办',block:fin.repBoard.repTable,colKeys:FIN_RB_KEYS,isSeries:false,colSrc:FIN_RB_COLS}));
  reg('rb-series','国家办×产品系列',()=>({firstLabel:'产品系列',block:fin.repBoard.repSeries,colKeys:PB,isSeries:true}));
  reg('rb-lv4','国家办LV4产品',()=>({firstLabel:'LV4 产品',block:fin.repBoard.lv4,colKeys:FIN_PB_LV4_KEYS,isSeries:false}));
  let h='';
  h+=finPbSection('国家办整体', finPbTable('国家办', b.repTable, FIN_RB_KEYS, false, FIN_RB_COLS, 'rb-table'), 'rb-table');
  h+=finPbSection('国家办 × 产品系列', finPbTable('产品系列', b.repSeries, PB, true, null, 'rb-series'), 'rb-series');
  h+=finPbSection('LV4 产品', finPbTable('LV4 产品', b.lv4, FIN_PB_LV4_KEYS, false, null, 'rb-lv4'), 'rb-lv4');
  box.innerHTML=h;
  finBindUnitExp(box);
  finStateSave();                // 国家办块独立筛选(fin.rep.*)变化后落盘
}
/* ============================================================
   重做后各表的导出(Task 13)：Excel(必做) + PPT(可选)。
   一份工作簿/演示稿，每个表组一页 sheet/slide：
   产品线/平板系列/音频系列/LV4产品(产品块)、国家办整体/×系列/LV4(国家办块)、自定义。
   比率/同比/达成率列(revYoy/gmYoy/gmr25/gmr26/nsipYoy/bpAttain/fcAttain)写原始分数 + 百分号格式；
   金额/数量列写原始数值(引擎已按来源单位归一为 USD,不再二次缩放,导出口径明确)。
   注：派生列(revYoy/gmYoy/gmr/nsipYoy/bpAttain/fcAttain)经 ExportUtil.applyFaFormulas
   在 finExpSheet 内转为活公式(引用同行原始分量单元格,保留缓存值),Task 1 已补 bpAttain/fcAttain spec。
   ============================================================ */
// 比率类列(写原始分数,百分号格式);其余为金额/数量(原始数值)。
const FIN_EXP_PCT_KEYS={revYoy:1,gmYoy:1,gmr25:1,gmr26:1,bpAttain:1,fcAttain:1};   // nsipYoy 已改为绝对USD差(单价同比),不再套百分号
// 把一个看板块(block:{rows,total})按给定列(FIN_PB_COLS/FIN_RB_COLS 子集)转成 {aoa, pctCols, firstLabel}。
// firstLabel=名称列表头;total 行(若有)以"合计"置顶;series 块按 faSortSeries 排序。
function finExpBlockAoa(firstLabel, block, colKeys, isSeries, colSrc, secId){
  const cols=(colSrc||FIN_PB_COLS).filter(c=>colKeys.includes(c.key));
  const head=[firstLabel].concat(cols.map(c=>c.label));
  const nz=v=>(v==null||!isFinite(v))?'':v;
  const line=(o,name)=>[name!=null?name:o.key].concat(cols.map(c=>nz(o[c.key])));
  let rows=(block&&block.rows||[]).slice();
  if(isSeries && typeof faSortSeries==='function') rows=faSortSeries(rows);
  rows=finRowsPipeline(rows,secId);   // 导出与界面同筛同序(用户 2026-08-24:所见即所出)
  const aoa=[head]; const dataRowIdxs=[];
  if(block&&block.total){ dataRowIdxs.push(aoa.length); aoa.push(line(block.total,'合计')); }
  rows.forEach(o=>{ dataRowIdxs.push(aoa.length); aoa.push(line(o)); });
  // 百分号列的 0-based 列号(含名称列偏移 +1)。
  const pctCols=cols.map((c,i)=>FIN_EXP_PCT_KEYS[c.key]?i+1:-1).filter(i=>i>=0);
  return {aoa, dataRowIdxs, pctCols, colCount:cols.length+1, colKeys:cols.map(c=>c.key)};
}
// 自定义看板块(metrics 动态)→ {aoa, pctCols}。列=行维度 + 各选中指标(中文label);
// 比率类指标(gmr/bpAttain/fcAttain)写原始分数 + 百分号格式,金额/数量原值。
function finExpCustomAoa(dimLabel, metrics, r){
  const PCT={gmr:1,bpAttain:1,fcAttain:1};
  const head=[dimLabel].concat(metrics.map(m=>FIN_CUST_METRIC_LABEL[m]||m));
  const nz=v=>(v==null||!isFinite(v))?'':v;
  const line=(o,name)=>[name!=null?name:o.key].concat(metrics.map(m=>nz(o[m])));
  const aoa=[head]; const dataRowIdxs=[];
  if(r&&r.total){ dataRowIdxs.push(aoa.length); aoa.push(line(r.total,'合计')); }
  (r&&r.rows||[]).forEach(o=>{ dataRowIdxs.push(aoa.length); aoa.push(line(o)); });
  const pctCols=metrics.map((m,i)=>PCT[m]?i+1:-1).filter(i=>i>=0);
  return {aoa, dataRowIdxs, pctCols};
}
// 总看板(5 张指标卡)→ 小表 AOA + 活公式计划。renderOverview 不是 fa-table,故单独构建。
// 列(8)：指标 | 去年 | 实际 | 同比 | 全年BP | BP完成率 | 全年预测 | 预测完成率。
// 列0基索引：指标0 去年1 实际2 同比3 全年BP4 BP完成率5 全年预测6 预测完成率7。
// 金额/数量类(rev/sellIn/sellOut)：同比=yoy(实际,去年)、BP完成率=attain(实际,全年BP)、预测完成率=attain(实际,全年预测)，均百分号 0.0%。
// 率/单价类(gmr/nsip)：同比/BP完成率/预测完成率=pp(差值)；gmr 是 pp(百分号 0.0%)，nsip 是绝对 USD 差(不套百分号)。
// 返回 {aoa, dataRowIdxs, formulaPlan}；formulaPlan 每项 {rowIdx,colIdx,kind,numColIdx,denColIdx,cached,pct}。
function finExpOverviewAoa(o){
  const M=(o&&o.metrics)||{};
  const nz=v=>(v==null||!isFinite(v))?'':v;
  const head=['指标','去年','实际','同比','全年BP','BP完成率','全年预测','预测完成率'];
  // 列0基：去年1 实际2 同比3 全年BP4 BP完成率5 全年预测6 预测完成率7。
  const COL={prev:1, actual:2, yoy:3, bp:4, bpAttain:5, fc:6, fcAttain:7};
  // 每行：[name, metricObj, type] type∈{amt(yoy/attain),pp(pp 百分号),abs(pp 不套百分号)}
  const defs=[
    ['净销售收入', M.rev,     'amt'],
    ['Sell In量',  M.sellIn,  'amt'],
    ['Sell out量', M.sellOut, 'amt'],
    ['销毛率',     M.gmr,     'pp' ],
    ['NSIP',       M.nsip,    'abs'],
  ];
  const aoa=[head]; const dataRowIdxs=[]; const formulaPlan=[];
  defs.forEach(([name,m,type])=>{
    m=m||{};
    const rowIdx=aoa.length;
    // amt: 同比=yoy、达成率=attain，缓存用 m.yoy/m.bpAttain/m.fcAttain。
    // pp/abs: 同比/BP/预测=差值，缓存用 m.prevDiff/m.bpDiff/m.fcDiff。
    const isAmt=type==='amt';
    const sameRow=(cached)=>cached;
    const row=new Array(8).fill('');
    row[0]=name;
    row[COL.prev]  =nz(m.prev);
    row[COL.actual]=nz(m.actual);
    row[COL.bp]    =nz(m.bp);
    row[COL.fc]    =nz(m.fc);
    // 同比/达成率单元格：先写引擎缓存值(随后转活公式)。
    row[COL.yoy]     =nz(isAmt?m.yoy     :m.prevDiff);
    row[COL.bpAttain]=nz(isAmt?m.bpAttain:m.bpDiff);
    row[COL.fcAttain]=nz(isAmt?m.fcAttain:m.fcDiff);
    aoa.push(row); dataRowIdxs.push(rowIdx);
    // 活公式计划：amt → yoy/attain；pp/abs → pp。pct=是否套 0.0%(amt 与 gmr 套；nsip 绝对差不套)。
    const ppPct=(type==='pp');
    const plan=(colIdx,kind,numColIdx,denColIdx,cached,pct)=>{
      formulaPlan.push({rowIdx,colIdx,kind,numColIdx,denColIdx,cached:(cached==null||!isFinite(cached))?undefined:cached,pct});
    };
    if(isAmt){
      plan(COL.yoy,     'yoy',    COL.actual, COL.prev, sameRow(m.yoy),      true);
      plan(COL.bpAttain,'attain', COL.actual, COL.bp,   sameRow(m.bpAttain), true);
      plan(COL.fcAttain,'attain', COL.actual, COL.fc,   sameRow(m.fcAttain), true);
    }else{
      plan(COL.yoy,     'pp', COL.actual, COL.prev, sameRow(m.prevDiff), ppPct);
      plan(COL.bpAttain,'pp', COL.actual, COL.bp,   sameRow(m.bpDiff),   ppPct);
      plan(COL.fcAttain,'pp', COL.actual, COL.fc,   sameRow(m.fcDiff),   ppPct);
    }
  });
  // 百分比是逐格判定(formulaPlan[i].pct)：amt 三格 + gmr 行三格套 0.0%，nsip 行三格是绝对 USD 差不套。
  return {aoa, dataRowIdxs, formulaPlan};
}
// AOA → worksheet,并给百分号列(数据行)套 0.0% 格式。
function finExpSheet(spec){
  const ws=XLSX.utils.aoa_to_sheet(spec.aoa);
  ws['!cols']=spec.aoa[0].map((_,i)=>({wch:i===0?18:13}));
  (spec.dataRowIdxs||[]).forEach(r=>{ (spec.pctCols||[]).forEach(c=>{
    const cell=ws[XLSX.utils.encode_cell({r:r,c:c})];
    if(cell&&cell.t==='n') cell.z='0.0%'; }); });
  // 派生列转活公式(同比/达成率/销毛率/NSIP同比)——引用同行原始分量。
  if(spec.colKeys && window.ExportUtil && window.FinCalc){
    window.ExportUtil.applyFaFormulas(XLSX, ws, window.FinCalc, spec.colKeys, spec.dataRowIdxs||[]);
  }
  return ws;
}
async function exportFinDashboardXlsx(){
  if(!state.finMeta){ toast('暂无数据','err'); return; }
  let prod,rep,cust;
  try{
    prod=await api.financeProductBoard(finOverviewParams());
    rep =await api.financeRepBoard(finRepParams());
    cust=await api.financeCustom(finCustomParams());
  }catch(e){ toast('导出失败：'+(e&&e.message||e),'err'); return; }
  const PB=FIN_PB_COLS.map(c=>c.key), LV4=FIN_PB_LV4_KEYS;
  // [sheet名, AOA spec] 列表,跳过空块。
  const sheets=[];
  const add=(name, spec)=>{ if(spec && spec.aoa && spec.aoa.length>1) sheets.push([name, spec]); };
  if(prod && !prod.error){
    add('产品线',   finExpBlockAoa('产品线', prod.line, PB, false, null, 'pb-line'));
    add('平板系列', finExpBlockAoa('系列', prod.famTablet, PB, true, null, 'pb-tablet'));
    add('音频系列', finExpBlockAoa('系列', prod.famAudio, PB, true, null, 'pb-audio'));
    add('LV4产品',  finExpBlockAoa('LV4 产品', prod.lv4, LV4, false, null, 'pb-lv4'));
  }
  if(rep && !rep.error){
    add('国家办整体', finExpBlockAoa('国家办', rep.repTable, FIN_RB_KEYS, false, FIN_RB_COLS, 'rb-table'));
    add('国家办×系列', finExpBlockAoa('产品系列', rep.repSeries, PB, true, null, 'rb-series'));
    add('国家办LV4',  finExpBlockAoa('LV4 产品', rep.lv4, LV4, false, null, 'rb-lv4'));
  }
  if(cust && !cust.error){
    const metrics=(cust.metrics&&cust.metrics.length)?cust.metrics:fin.custom.metrics;
    const dimLabel=(FIN_CUST_DIMS.find(([v])=>v===fin.custom.rowDim)||[,'分组'])[1];
    add('自定义', finExpCustomAoa(dimLabel, metrics, cust));
  }
  if(!sheets.length){ toast('暂无数据','err'); return; }
  const wb=XLSX.utils.book_new();
  sheets.forEach(([name,spec])=>XLSX.utils.book_append_sheet(wb, finExpSheet(spec), String(name).slice(0,31)));
  const b64=XLSX.write(wb,{bookType:'xlsx',type:'base64'});
  const res=await api.saveFile('经营分析看板_'+todayStr()+'.xlsx',b64,'xlsx');
  if(res&&res.path) toast('已导出','ok');
}
// PPT 导出:每个表组一页。复用 finExpBlockAoa/finExpCustomAoa 的 AOA(首行表头),
// 表头红底白字,数据行套用;比率列在 AOA 已是原始分数,这里转成百分比文本展示。
async function exportFinDashboardPpt(){
  if(!state.finMeta){ toast('暂无数据','err'); return; }
  let prod,rep,cust;
  try{
    prod=await api.financeProductBoard(finOverviewParams());
    rep =await api.financeRepBoard(finRepParams());
    cust=await api.financeCustom(finCustomParams());
  }catch(e){ toast('导出失败：'+(e&&e.message||e),'err'); return; }
  const PB=FIN_PB_COLS.map(c=>c.key), LV4=FIN_PB_LV4_KEYS;
  const slides=[]; // [title, spec]
  const add=(title, spec)=>{ if(spec && spec.aoa && spec.aoa.length>1) slides.push([title, spec]); };
  if(prod && !prod.error){
    add('产品线', finExpBlockAoa('产品线', prod.line, PB, false, null, 'pb-line'));
    add('平板分系列', finExpBlockAoa('系列', prod.famTablet, PB, true, null, 'pb-tablet'));
    add('音频分系列', finExpBlockAoa('系列', prod.famAudio, PB, true, null, 'pb-audio'));
    add('LV4 产品', finExpBlockAoa('LV4 产品', prod.lv4, LV4, false, null, 'pb-lv4'));
  }
  if(rep && !rep.error){
    add('国家办整体', finExpBlockAoa('国家办', rep.repTable, FIN_RB_KEYS, false, FIN_RB_COLS, 'rb-table'));
    add('国家办 × 产品系列', finExpBlockAoa('产品系列', rep.repSeries, PB, true, null, 'rb-series'));
    add('国家办 · LV4 产品', finExpBlockAoa('LV4 产品', rep.lv4, LV4, false, null, 'rb-lv4'));
  }
  if(cust && !cust.error){
    const metrics=(cust.metrics&&cust.metrics.length)?cust.metrics:fin.custom.metrics;
    const dimLabel=(FIN_CUST_DIMS.find(([v])=>v===fin.custom.rowDim)||[,'分组'])[1];
    add('自定义看板', finExpCustomAoa(dimLabel, metrics, cust));
  }
  if(!slides.length){ toast('暂无数据','err'); return; }
  const pptx=new PptxGenJS(); pptx.defineLayout({name:'W',width:13.333,height:7.5}); pptx.layout='W';
  const cl=(t,o)=>({text:String(t),options:Object.assign({fontFace:'微软雅黑',fontSize:8,align:'center',valign:'middle'},o||{})});
  // AOA 单元格 → PPT 单元格:首行表头红底;其余按列类型(百分号列的分数→百分比文本)。
  const fmtPct=v=>(v===''||v==null)?'':(v*100).toFixed(1)+'%';
  const fmtNum=v=>(v===''||v==null)?'':(typeof v==='number'?Math.round(v).toLocaleString('en-US'):String(v));
  slides.forEach(([title,spec])=>{
    const s=pptx.addSlide();
    s.addText(title,{x:0.35,y:0.22,w:12.6,h:0.4,fontFace:'微软雅黑',fontSize:16,bold:true,color:'C7000B'});
    const pct=new Set(spec.pctCols||[]);
    const data=spec.aoa.map((row,ri)=>row.map((v,ci)=>{
      if(ri===0) return cl(v,{bold:true,color:'FFFFFF',fill:{color:'C7000B'},align:ci===0?'left':'center',fontSize:7.5});
      const txt=ci===0?String(v):(pct.has(ci)?fmtPct(v):fmtNum(v));
      return cl(txt,{align:ci===0?'left':'center'});
    }));
    s.addTable(data,{x:0.35,y:0.85,w:12.63,border:{type:'solid',color:'E6E8EB',pt:0.5},autoPage:true,autoPageRepeatHeader:true,valign:'middle'});
  });
  const b64=await pptx.write('base64');
  const res=await api.saveFile('经营分析看板_'+todayStr()+'.pptx',b64,'pptx');
  if(res&&res.path) toast('已导出 PPT','ok');
}
/* ---- 逐表独立导出(Task 3)：单表 Excel(单 sheet,活公式) / PPT(单页) ----
   取 fin._expUnits[id].build() 得描述符,构 AOA(table→finExpBlockAoa, custom→finExpCustomAoa),
   复用 finExpSheet(公式) / exportFinDashboardPpt 的单元格样式(红底表头)。 */
// 描述符 → AOA spec(table 或 custom)；无数据返回 null。
function finUnitSpec(d){
  if(!d) return null;
  return d.custom ? finExpCustomAoa(d.dimLabel, d.metrics, d.r)
                  : finExpBlockAoa(d.firstLabel, d.block, d.colKeys, d.isSeries, d.colSrc, d.secId);
}
// 总看板单元 → worksheet：aoa_to_sheet 后按 formulaPlan 逐格设活公式(引用同行实际/去年/BP/预测列)。
function finOverviewSheet(spec){
  const ws=XLSX.utils.aoa_to_sheet(spec.aoa);
  ws['!cols']=spec.aoa[0].map((_,i)=>({wch:i===0?12:13}));
  const C=c=>XLSX.utils.encode_col(c);
  (spec.formulaPlan||[]).forEach(p=>{
    const exRow=p.rowIdx+1;                 // Excel 1-based 行号
    const num=C(p.numColIdx)+exRow, den=C(p.denColIdx)+exRow;
    let formula=null;
    if(p.kind==='yoy') formula=FinCalc.fYoy(num,den);
    else if(p.kind==='attain') formula=FinCalc.fAttain(num,den);
    else if(p.kind==='pp') formula=FinCalc.fPp(num,den);
    window.ExportUtil.setFormulaCell(XLSX, ws, p.rowIdx, p.colIdx, formula, p.cached, p.pct?'0.0%':undefined);
  });
  return ws;
}
async function exportUnitXlsx(id){
  const u=fin._expUnits[id]; if(!u){ toast('暂无数据','err'); return; }
  let d; try{ d=u.build(); }catch(e){ toast('暂无数据','err'); return; }
  let ws;
  if(u.kind==='overview'){
    const spec=finExpOverviewAoa(d&&d.o);
    if(!spec || !spec.aoa || spec.aoa.length<=1){ toast('暂无数据','err'); return; }
    ws=finOverviewSheet(spec);
  }else{
    const spec=finUnitSpec(d);
    if(!spec || !spec.aoa || spec.aoa.length<=1){ toast('暂无数据','err'); return; }
    ws=finExpSheet(spec);
  }
  const wb=XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, u.title.slice(0,31));
  const b64=XLSX.write(wb,{bookType:'xlsx',type:'base64'});
  const res=await api.saveFile('经营分析_'+u.title+'_'+todayStr()+'.xlsx', b64, 'xlsx');
  if(res&&res.path) toast('已导出','ok');
}
// 把 AOA spec 渲染成一页 PPT 表格(首行红底白字;百分号列分数→百分比文本)。
// pctCells(可选)：总看板逐格百分比集合("r,c")；否则按 spec.pctCols 列判定。复用于表/自定义/图底数据页。
function finPptAddTable(pptx, title, spec, pctCells){
  const s=pptx.addSlide();
  s.addText(title,{x:0.3,y:0.25,w:12.7,h:0.5,fontFace:'微软雅黑',fontSize:18,bold:true,color:'C7000B'});
  const cl=(t,o)=>({text:String(t),options:Object.assign({fontFace:'微软雅黑',fontSize:8,align:'center',valign:'middle'},o||{})});
  const fmtPct=v=>(v===''||v==null)?'':(v*100).toFixed(1)+'%';
  const fmtNum=v=>(v===''||v==null)?'':(typeof v==='number'?Math.round(v).toLocaleString('en-US'):String(v));
  const pct=new Set(spec.pctCols||[]);
  const isPct=(ri,ci)=>pctCells?pctCells.has(ri+','+ci):pct.has(ci);
  const rows=spec.aoa.map((row,ri)=>row.map((v,ci)=>{
    if(ri===0) return cl(v,{bold:true,color:'FFFFFF',fill:{color:'C7000B'},align:ci===0?'left':'center',fontSize:7.5});
    const txt=ci===0?String(v):(isPct(ri,ci)?fmtPct(v):fmtNum(v));
    return cl(txt,{align:ci===0?'left':'center'});
  }));
  s.addTable(rows,{x:0.3,y:0.9,w:12.7,border:{type:'solid',color:'E6E8EB',pt:0.5},autoPage:true,autoPageRepeatHeader:true,valign:'middle'});
  return s;
}
async function exportUnitPpt(id){
  const u=fin._expUnits[id]; if(!u){ toast('暂无数据','err'); return; }
  let d; try{ d=u.build(); }catch(e){ toast('暂无数据','err'); return; }
  // 图表单元：2 页 = 图片页 + 图底数据表页。
  if(u.kind==='chart'){
    const ch=d&&d.chart;
    if(!ch || typeof ch.getDataURL!=='function'){ toast('暂无图表','err'); return; }
    const spec=finExpCustomAoa(d.dimLabel, d.metrics, d.r);
    const pptx=new PptxGenJS(); pptx.defineLayout({name:'W',width:13.333,height:7.5}); pptx.layout='W';
    // 页1：图片
    const s1=pptx.addSlide();
    s1.addText(u.title,{x:0.3,y:0.25,w:12.7,h:0.5,fontFace:'微软雅黑',fontSize:18,bold:true,color:'C7000B'});
    const url=ch.getDataURL({pixelRatio:2, backgroundColor:'#ffffff'});
    s1.addImage({data:url, x:0.6, y:1.0, w:12.13, h:6.0});
    // 页2：图底数据表(自定义透视数据)
    if(spec && spec.aoa && spec.aoa.length>1) finPptAddTable(pptx, u.title+' · 数据', spec);
    const b64=await pptx.write('base64');
    const res=await api.saveFile('经营分析_'+u.title+'_'+todayStr()+'.pptx', b64, 'pptx');
    if(res&&res.path) toast('已导出 PPT','ok');
    return;
  }
  // 总看板：百分比是逐格(NSIP 行的差值是绝对 USD,不套%)→ 用 formulaPlan.pct 建 "r,c" 百分比格集合。
  let spec, pctCells=null;
  if(u.kind==='overview'){
    spec=finExpOverviewAoa(d&&d.o);
    if(!spec || !spec.aoa || spec.aoa.length<=1){ toast('暂无数据','err'); return; }
    pctCells=new Set((spec.formulaPlan||[]).filter(p=>p.pct).map(p=>p.rowIdx+','+p.colIdx));
  }else{
    spec=finUnitSpec(d);
    if(!spec || !spec.aoa || spec.aoa.length<=1){ toast('暂无数据','err'); return; }
  }
  const pptx=new PptxGenJS(); pptx.defineLayout({name:'W',width:13.333,height:7.5}); pptx.layout='W';
  finPptAddTable(pptx, u.title, spec, pctCells);
  const b64=await pptx.write('base64');
  const res=await api.saveFile('经营分析_'+u.title+'_'+todayStr()+'.pptx', b64, 'pptx');
  if(res&&res.path) toast('已导出 PPT','ok');
}
// 图表单元导出 PNG：取 build() 返回的 ECharts 实例 getDataURL(高清白底)，转 base64 存图。
async function exportUnitPng(id){
  const u=fin._expUnits[id]; if(!u){ toast('暂无数据','err'); return; }
  let d; try{ d=u.build(); }catch(e){ toast('暂无数据','err'); return; }
  const ch=d&&d.chart; if(!ch || typeof ch.getDataURL!=='function'){ toast('暂无图表','err'); return; }
  const url=ch.getDataURL({pixelRatio:2, backgroundColor:'#ffffff'});
  const b64=url.split(',')[1];
  const res=await api.saveFile('经营分析_'+u.title+'_'+todayStr()+'.png', b64, 'png');
  if(res&&res.path) toast('已导出图片','ok');
}
// 按 SERIES_ORDER 给系列排名(经营分析lv3常无"系列"后缀/带型号尾巴)：先去空格去"系列"做精确，再按核心串长度降序includes(更具体的先命中,避免"Slate SE"误中"Slate Tab")
function faSeriesRank(name){
  const n=String(name||'').replace(/\s+/g,'');
  const cores=SERIES_ORDER.map((s,i)=>[i, s.replace(/系列$/,'').replace(/\s+/g,'')]);
  for(const [i,c] of cores){ if(n===c||n===c+'系列') return i; }
  for(const [i,c] of cores.slice().sort((a,b)=>b[1].length-a[1].length)){ if(c && n.includes(c)) return i; }
  return 999;
}
function faSortSeries(rows){ return rows.slice().sort((a,b)=>{ const ia=faSeriesRank(a.key),ib=faSeriesRank(b.key); if(ia!==ib)return ia-ib; return (b.rev26||0)-(a.rev26||0); }); }
function faSection(title,sub,tableHtml,exId){
  const exp=exId?`<span class="fa-exp"><button data-ex="xlsx" data-id="${exId}">📊 Excel</button><button data-ex="png" data-id="${exId}">🖼 图片</button></span>`:'';
  return '<div class="fa-card"><div class="fa-head"><span class="nm">'+title+'</span><span class="sub">'+sub+'</span>'+exp+'</div><div class="fa-wrap">'+tableHtml+'</div></div>';
}
function bpNumCell(v){ if(v==null||!isFinite(v)) return '<span class="wk">—</span>'; return shortLabel(v); }
/* ---- 自定义看板(Task 12)：行维度 × 多指标 × 口径 × 图型 → 透视表 + ECharts 图 ----
   复用全局时间/国家办/LV/版本/单位筛选(finOverviewParams)，叠加本块 rowDim/metrics/basis。
   选择器 onchange/onCommit → renderCustom()；图实例缓存于 fin._custChart，跨渲染复用。 */
const FIN_CUST_DIMS=[['rep','国家办'],['lv1','产业LV1'],['lv2','品类LV2'],['lv3','产品系列LV3'],['lv4','产品LV4']];
const FIN_CUST_METRICS=[['rev','净销售收入'],['gm','销售毛利'],['gmr','销毛率'],['sellIn','Sell In量'],
  ['sellOut','Sell out量'],['nsip','NSIP'],['bpAttain','BP达成率'],['fcAttain','预测达成率']];
const FIN_CUST_METRIC_LABEL={}; FIN_CUST_METRICS.forEach(([k,l])=>FIN_CUST_METRIC_LABEL[k]=l);
const FIN_CUST_LABEL_METRIC={}; FIN_CUST_METRICS.forEach(([k,l])=>FIN_CUST_LABEL_METRIC[l]=k);  // 中文label→指标key(多选反查)
const FIN_CUST_BASIS=[['actual','实际'],['forecast','预测'],['bp','BP']];
const FIN_CUST_CHARTS=[['bar','柱状'],['line','折线'],['pie','饼图']];
// 每指标单元格格式(HTML)：金额/数量/率/达成率；null → —
function finCustFmt(metric,v){
  if(v==null||!isFinite(v)) return '—';
  if(metric==='gmr') return finRate(v);                  // 销毛率 → x.x%
  if(metric==='bpAttain'||metric==='fcAttain') return finPct(v); // 达成率(带色)
  if(metric==='sellIn'||metric==='sellOut') return finFmtQty(v);
  return finFmtAmt(v);                                    // rev/gm/nsip → 金额
}
function finCustomParams(){ return Object.assign({}, finOverviewParams(),
  {rowDim:fin.custom.rowDim, metrics:fin.custom.metrics, basis:fin.custom.basis}); }
// 渲染选择器条到 #finSecCustom 顶部(只建一次，重渲染只换表/图骨架)；返回选择器 HTML 串。
function finCustBuildSelectors(){
  const sel=(id,arr,cur)=>'<select id="'+id+'">'+arr.map(([v,l])=>`<option value="${v}" ${String(v)===String(cur)?'selected':''}>${l}</option>`).join('')+'</select>';
  return '<div class="fin-frow" id="finCustFRow">'+
    '<span class="fld"><label>行维度</label>'+sel('finCustDim',FIN_CUST_DIMS,fin.custom.rowDim)+'</span>'+
    '<span class="fld" id="finCustMetricsHolder"></span>'+
    '<span class="fld"><label>口径</label>'+sel('finCustBasis',FIN_CUST_BASIS,fin.custom.basis)+'</span>'+
    '<span class="fld"><label>图型</label>'+sel('finCustChart',FIN_CUST_CHARTS,fin.custom.chart)+'</span>'+
  '</div>';
}
// 选择器事件挂载：单值下拉 onchange、指标多选 onCommit → renderCustom()
function finCustBindSelectors(){
  const bind=(id,fn)=>{ const el=$('#'+id); if(el) el.onchange=e=>{ fn(e.target.value); renderCustom(); finStateSave(); }; };
  bind('finCustDim', v=>fin.custom.rowDim=v);
  bind('finCustBasis', v=>fin.custom.basis=v);
  bind('finCustChart', v=>fin.custom.chart=v);
  // 指标多选：选项=中文label(用户看中文)；committed label 反查为指标key存入 fin.custom.metrics(仍存key)。
  // 当前已选的显示也用中文label(把 metrics keys 映射回 label 传给 makeMultiSelect 的 selected)。
  // 至少保留一个指标(清空则回退 净销售收入/rev)，避免空透视表/空图。
  const h=$('#finCustMetricsHolder'); if(h){ h.innerHTML='';
    const opts=FIN_CUST_METRICS.map(([,l])=>l);                                   // 中文label列表
    const selLabels=(fin.custom.metrics||[]).map(k=>FIN_CUST_METRIC_LABEL[k]).filter(Boolean);  // 已选key→label
    h.appendChild(makeMultiSelect('指标', opts, selLabels, {placeholder:'选择指标',
      onCommit:labels=>{ const keys=(labels||[]).map(l=>FIN_CUST_LABEL_METRIC[l]).filter(Boolean);
        fin.custom.metrics=keys.length?keys:['rev']; renderCustom(); finStateSave(); } })); }
}
async function renderCustom(){
  const host=document.getElementById('finSecCustom'); if(!host) return;
  if(!state.finMeta){ host.innerHTML=''; fin._custChart=null; return; }
  // 骨架：标题(含逐表导出按钮) + 选择器条 + 表容器 + 图容器；只建一次(避免每次重建多选关闭用户面板/丢图实例)。
  if(!host.querySelector('#finCustFRow')){
    host.innerHTML='<div class="fin-sec-t">自定义看板<span class="fin-unit-exp"><button type="button" data-exp="xlsx" data-id="cust-table">📊 Excel</button><button type="button" data-exp="ppt" data-id="cust-table">📑 PPT</button></span></div>'+
      '<div class="fin-filters">'+finCustBuildSelectors()+'</div>'+
      '<div class="fa-wrap" id="finCustTable"></div>'+
      '<div class="fin-sec-t">图表<span class="fin-unit-exp"><button type="button" data-exp="png" data-id="cust-chart">🖼 图片</button><button type="button" data-exp="ppt" data-id="cust-chart">📑 PPT</button></span></div>'+
      '<div class="sb-colorrow" id="finCustColors"></div>'+
      '<div id="finCustomChart" style="height:320px"></div>';
    finCustBindSelectors();
    finBindUnitExp(host);
  finBindRowCtl(host);
  }
  const r=await api.financeCustom(finCustomParams()); fin.cust=r;
  // 登记自定义表导出单元(build 闭包读取当前 fin.cust;指标/维度回退与表渲染一致)。
  fin._expUnits['cust-table']={title:'自定义看板',kind:'table',build:()=>{
    const c=fin.cust;
    const ms=(c&&c.metrics&&c.metrics.length)?c.metrics:fin.custom.metrics;
    const dl=(FIN_CUST_DIMS.find(([v])=>v===fin.custom.rowDim)||[,'分组'])[1];
    return {custom:true, dimLabel:dl, metrics:ms, r:c};
  }};
  // 登记自定义图表导出单元(build 读取当前 fin._custChart + fin.cust;指标/维度回退与表一致)。
  fin._expUnits['cust-chart']={title:'自定义看板-图表',kind:'chart',build:()=>{
    const c=fin.cust;
    const ms=(c&&c.metrics&&c.metrics.length)?c.metrics:fin.custom.metrics;
    const dl=(FIN_CUST_DIMS.find(([v])=>v===fin.custom.rowDim)||[,'分组'])[1];
    return {chart:fin._custChart, r:c, metrics:ms, dimLabel:dl};
  }};
  const tbox=document.getElementById('finCustTable');
  const metrics=(r&&r.metrics&&r.metrics.length)?r.metrics:fin.custom.metrics;
  const dimLabel=(FIN_CUST_DIMS.find(([v])=>v===fin.custom.rowDim)||[,'分组'])[1];
  if(tbox){
    if(!r || r.error){ tbox.innerHTML='<div style="padding:14px 16px;font-size:12px;color:var(--ink3)">暂无数据</div>'; }
    else tbox.innerHTML=finCustTableHtml(dimLabel, metrics, r);
    finCustBindSort();   // 容器级排序委托，只挂一次
  }
  finCustRenderChart(metrics, r);
  finStateSave();                // 自定义块选择器(rowDim/metrics/basis/chart)变化后落盘
}
// 透视表：行维列 + 各选中指标列；表头点击按该指标排序；合计(合计)加粗置顶。
function finCustTableHtml(dimLabel, metrics, r){
  const st=fin.custom._sort;   // {key, dir} key='__dim__' 或 metricKey
  const arrow=k=> st&&st.key===k ? (st.dir<0?' ▲':' ▼') : '';
  const thead='<tr><th class="lft sortable" data-k="__dim__">'+dimLabel+arrow('__dim__')+'</th>'+
    metrics.map(m=>`<th class="sortable" data-k="${m}">${FIN_CUST_METRIC_LABEL[m]||m}${arrow(m)}</th>`).join('')+'</tr>';
  let rows=(r.rows||[]).slice();
  if(st){ const k=st.key, d=st.dir;
    rows.sort((a,b)=>{ if(k==='__dim__') return String(a.key).localeCompare(String(b.key),'zh')*d;
      const va=a[k], vb=b[k]; const na=(va==null||!isFinite(va))?-Infinity:va, nb=(vb==null||!isFinite(vb))?-Infinity:vb; return (na-nb)*d; }); }
  const rowHtml=(o,cls)=>'<tr class="'+(cls||'')+'"><td class="lft">'+o.key+'</td>'+
    metrics.map(m=>`<td>${finCustFmt(m,o[m])}</td>`).join('')+'</tr>';
  let body='';
  if(r.total) body+=rowHtml(Object.assign({},r.total,{key:'合计'}),'tot');
  body+=rows.map(o=>rowHtml(o)).join('');
  return '<table class="fa-table">'+
    '<thead>'+thead+'</thead><tbody>'+body+'</tbody></table>';
}
// 表头排序：容器级事件委托(挂在 #finCustTable 上一次)，点列头按该指标重排，用缓存 fin.cust 重渲染表(不重拉数据)。
function finCustBindSort(){
  const tbox=document.getElementById('finCustTable'); if(!tbox || tbox._sortBound) return;
  tbox._sortBound=true;
  tbox.addEventListener('click', e=>{ const th=e.target.closest('th.sortable'); if(!th) return;
    const k=th.dataset.k; const st=fin.custom._sort;
    if(st&&st.key===k) st.dir=-st.dir; else fin.custom._sort={key:k,dir:1};
    // 重渲染表(不重拉数据)：用缓存 r。
    const r=fin.cust, metrics=(r&&r.metrics&&r.metrics.length)?r.metrics:fin.custom.metrics;
    const dimLabel=(FIN_CUST_DIMS.find(([v])=>v===fin.custom.rowDim)||[,'分组'])[1];
    if(r&&!r.error) tbox.innerHTML=finCustTableHtml(dimLabel, metrics, r); });
}
/* ---- 系列色块行（第二批-2b）：finCustomChart 上方每系列(bar/line=指标)/扇区(pie=行键)一个
   input[type=color]，渲染/交互走 common.js 的 sbColorRow（与 custom 共用）；
   override 存 fin.custom.colorOverride → sb.finance.v1。重画用缓存 fin.cust，不重拉数据。 ---- */
function finCustColorRow(names){
  sbColorRow(document.getElementById('finCustColors'), names, fin.custom.colorOverride, SB_COLORS.seriesDiscreteFin, {
    onChange:(n,v)=>{ fin.custom.colorOverride[n]=v; finCustRedrawChart(); finStateSave(); },
    onReset:()=>{ fin.custom.colorOverride={}; finCustRedrawChart(); finStateSave(); },
  });
}
function finCustRedrawChart(){
  const r=fin.cust; if(!r||r.error) return;
  const ms=(r.metrics&&r.metrics.length)?r.metrics:fin.custom.metrics;
  finCustRenderChart(ms,r);
}
// ECharts 图：bar/line=每指标一系列(x=行键)；pie=首指标一行一扇区。null 视作 0。
function finCustRenderChart(metrics, r){
  const el=document.getElementById('finCustomChart'); if(!el) return;
  if(!fin._custChart){ fin._custChart=CT().register(echarts.init(el));
    window.addEventListener('resize',()=>fin._custChart&&fin._custChart.resize()); }
  const ch=fin._custChart;
  const rows=(r&&r.rows)?r.rows:[];
  if(!rows.length || !metrics.length){ ch.clear(); finCustColorRow([]); return; }
  const keys=rows.map(o=>o.key);
  const num=v=>(v==null||!isFinite(v))?0:v;
  const PALETTE=SB_COLORS.seriesDiscreteFin;   // 共享调色板(第二批-2b)：与原 8 色一致，零变色
  const OV=fin.custom.colorOverride||{};        // 系列色 override(点色块改色,存 sb.finance.v1)
  const baseTip={trigger:'axis',backgroundColor:'rgba(26,26,26,.92)',borderWidth:0,
    textStyle:{color:'#fff',fontFamily:YH,fontSize:12}};
  let opt;
  if(fin.custom.chart==='pie'){
    const m0=metrics[0];
    opt={textStyle:{fontFamily:YH},
      tooltip:{trigger:'item',backgroundColor:'rgba(26,26,26,.92)',borderWidth:0,textStyle:{color:'#fff',fontFamily:YH,fontSize:12}},
      legend:{type:'scroll',bottom:2,textStyle:{fontFamily:YH,fontSize:11,color:CT().ink2()}},
      color:PALETTE,
      series:[{name:FIN_CUST_METRIC_LABEL[m0]||m0,type:'pie',radius:['38%','64%'],center:['50%','46%'],
        avoidLabelOverlap:true,itemStyle:{borderColor:'#fff',borderWidth:1},
        label:{fontFamily:YH,fontSize:11,color:CT().ink2()},
        // 扇区色：默认走 color:PALETTE 循环(与原一致)；仅被 override 的扇区加 per-datum 色
        data:rows.map(o=>{ const d={name:o.key,value:num(o[m0])}; if(OV[o.key]) d.itemStyle={color:OV[o.key],borderColor:'#fff',borderWidth:1}; return d; })}]};
    finCustColorRow(keys);
  } else {
    const type=fin.custom.chart==='line'?'line':'bar';
    const series=metrics.map((m,i)=>({name:FIN_CUST_METRIC_LABEL[m]||m,type,
      smooth:type==='line',symbol:'circle',symbolSize:5,
      itemStyle:{color:sbSeriesColor(FIN_CUST_METRIC_LABEL[m]||m,i,OV,PALETTE)},lineStyle:{width:2},
      data:rows.map(o=>num(o[m]))}));
    finCustColorRow(metrics.map(m=>FIN_CUST_METRIC_LABEL[m]||m));
    opt={textStyle:{fontFamily:YH},
      tooltip:baseTip,
      legend:{type:'scroll',bottom:2,textStyle:{fontFamily:YH,fontSize:11,color:CT().ink2()}},
      grid:{left:58,right:20,top:18,bottom:46},
      xAxis:{type:'category',data:keys,axisLabel:{fontFamily:YH,fontSize:11,color:CT().ink3(),interval:0,rotate:keys.length>6?30:0},
        axisLine:{lineStyle:{color:CT().line()}},axisTick:{show:false}},
      yAxis:{type:'value',axisLabel:{fontFamily:YH,fontSize:11,color:CT().ink3()},splitLine:{lineStyle:{color:CT().lineSoft()}}},
      series};
  }
  ch.setOption(opt, true);
  setTimeout(()=>fin._custChart&&fin._custChart.resize(),30);
}

/* ---- 重设计入口：注入 CSS + 接管 #view-finance 容器 ----
   全局筛选条的事件在 buildFinControls() 渲染各控件时就地挂 onchange，
   此处仅做一次性接管，不绑定任何旧静态 #finVersion/#finAchSeries 等 id。 */
function initFinanceView(){
  finInjectCSS();
  finMount();
  // 控件事件随 buildFinControls() 渲染时挂载；此处兜底不报错。
}

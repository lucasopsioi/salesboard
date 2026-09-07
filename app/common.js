/* ============================================================
   Salesboard — common.js
   共享前置声明 + 跨视图复用的辅助函数。必须在 app.js 及各 view 脚本之前加载。
   纯搬运：从 app.js 原样剪切，无逻辑改动。
   ============================================================ */
'use strict';
const api = window.sb;
const $  = s => document.querySelector(s);
const $$ = s => Array.from(document.querySelectorAll(s));
const YH = '"Microsoft YaHei","微软雅黑",sans-serif';

const DIM_LABEL = {region:'Region',repOffice:'Rep Office',country:'Country',channel:'Channel',
  family:'Product Family',line:'Product Line',series:'Product Series',product:'Product',model:'Product Model'};
const GEO_ORDER=['region','repOffice','country'], PROD_ORDER=['family','line','series','product','model'];
const FILTER_FIELDS=(typeof FilterOrder!=='undefined'?FilterOrder.FILTER_FIELDS:['line','family','series','product','model','region','repOffice','country','channel']);
const METRIC_LABEL={sellOut:'Sell Out',sellIn:'Sell In',inv:'库存 INV',dos:'DOS'};
const MAX_SERIES=14;
const PREMIUM_RANK=['旗舰','flagship','开放','open','精品','颈戴','neck','基础','basic','低成本','平板','tablet'];
const premiumScore=n=>{const s=String(n).toLowerCase();for(let i=0;i<PREMIUM_RANK.length;i++)if(s.includes(PREMIUM_RANK[i]))return i;return PREMIUM_RANK.length+1;};

function toast(msg,kind){const t=$('#toast');t.textContent=msg;t.className='toast show'+(kind?(' '+kind):'');clearTimeout(toast._t);toast._t=setTimeout(()=>t.className='toast',2800);}
function fmt(n){if(n==null||isNaN(n))return '0';const a=Math.abs(n);if(a>=1e8)return(n/1e8).toFixed(2)+'亿';if(a>=1e4)return(n/1e4).toFixed(1)+'万';return Math.round(n).toLocaleString('en-US');}
function shortLabel(n){if(!n)return'';const a=Math.abs(n);if(a>=1e4)return(n/1e4).toFixed(1)+'万';return Math.round(n).toLocaleString('en-US');}
function showLoading(t){if(t)$('#loadingTxt').textContent=t;$('#loading').classList.remove('hidden');}
function hideLoading(){$('#loading').classList.add('hidden');}

/* ---------- 多选下拉组件 ---------- */
// 点面板外：调用每个打开面板自己的 close()（会触发 onCommit 应用筛选+级联），而不是仅隐藏
function closeAllMs(except){ document.querySelectorAll('.ms-panel').forEach(p=>{ if(p===except) return; if(p._close) p._close(); else p.classList.add('hidden'); }); }
document.addEventListener('click',()=>closeAllMs());
function makeMultiSelect(label, options, selected, opts){
  opts=opts||{}; const placeholder=opts.placeholder||'全部';
  options=(options||[]).slice();   // 拷一份，供 _setOptions 受控替换（全选/renderList 均闭包引用此变量）
  const wrap=document.createElement('div'); wrap.className='ms';
  const lab=document.createElement('label'); lab.textContent=label; wrap.appendChild(lab);
  const trig=document.createElement('div'); trig.className='ms-trigger'; wrap.appendChild(trig);
  const panel=document.createElement('div'); panel.className='ms-panel hidden';
  panel.innerHTML='<div class="ms-search"><input placeholder="搜索…"></div><div class="ms-list"></div><div class="ms-foot"><button data-a="all">全选</button><button data-a="clear">清空</button></div>';
  wrap.appendChild(panel);
  const sel=new Set(selected||[]); let dirty=false;
  const listEl=panel.querySelector('.ms-list'), searchEl=panel.querySelector('.ms-search input');
  function updTrig(){ const n=sel.size; trig.classList.toggle('has',n>0);
    const t = n===0? placeholder : (n===1? [...sel][0] : ('已选 '+n+' 项'));
    trig.innerHTML='<span class="txt">'+t+'</span><span class="cnt">▾</span>'; }
  function renderList(f){ listEl.innerHTML=''; const ff=(f||'').toLowerCase();
    options.filter(o=>!ff||String(o).toLowerCase().includes(ff)).slice(0,800).forEach(o=>{
      const row=document.createElement('label'); row.className='ms-opt';
      row.innerHTML='<input type="checkbox" '+(sel.has(o)?'checked':'')+'><span class="ot">'+o+'</span>';
      row.querySelector('input').onchange=ev=>{ ev.target.checked?sel.add(o):sel.delete(o); dirty=true; updTrig(); opts.onChange&&opts.onChange([...sel]); };
      listEl.appendChild(row); }); }
  function close(){ if(!panel.classList.contains('hidden')){ panel.classList.add('hidden'); if(dirty){ dirty=false; opts.onCommit&&opts.onCommit([...sel]); } } }
  trig.onclick=e=>{ e.stopPropagation(); const wasOpen=!panel.classList.contains('hidden');
    closeAllMs(panel);   // 关闭其它面板并提交它们
    if(wasOpen){ close(); } else { panel.classList.remove('hidden'); searchEl.value=''; renderList(''); searchEl.focus(); } };
  panel.onclick=e=>e.stopPropagation();
  searchEl.oninput=()=>renderList(searchEl.value);
  panel.querySelector('[data-a=all]').onclick=()=>{ options.forEach(o=>sel.add(o)); dirty=true; renderList(searchEl.value); updTrig(); opts.onChange&&opts.onChange([...sel]); };
  panel.querySelector('[data-a=clear]').onclick=()=>{ sel.clear(); dirty=true; renderList(searchEl.value); updTrig(); opts.onChange&&opts.onChange([...sel]); };
  updTrig();
  wrap._close=close; panel._close=close;   // 供 closeAllMs 调用
  // 受控刷新可选项（级联用）：替换 options + 已选与新选项求交剔除失效值 + 若面板开着则重渲清单 + 同步触发器。
  // 不触发 onChange/onCommit（这是外部数据驱动的刷新，不是用户交互）；调用方在自己的级联逻辑里决定是否重算。
  wrap._setOptions=function(newOptions){
    options=(newOptions||[]).slice();
    const keep=new Set(options);
    [...sel].forEach(v=>{ if(!keep.has(v)) sel.delete(v); });   // 求交：剔除不在新选项里的已选值
    if(!panel.classList.contains('hidden')) renderList(searchEl.value);   // 面板开着才重渲清单（搜索词保留）
    updTrig();
  };
  return wrap;
}

const state={dims:[],from:null,to:null,folder:null,files:[],records:0,lastRefresh:null,
  metric:'sellOut',gran:'month',stackDim:'series',filters:{},stackOrder:[],orderSig:'',labels:true,smooth:true,
  labelSize:12,labelColor:null,
  chartType:'area',opacity:0.92,colorOverride:{},lastQuery:null,unit:'one',legendPos:'top',rangeFrom:null,rangeTo:null};
let chart=null, drawToken=0;

/* ============================================================
   看板视图状态持久化（sb.<看板>.v1）——第二批-2a。
   写 localStorage → archive.js 自动镜像落盘（sb.* 前缀）。只存可序列化的
   筛选/粒度/图表设置等，绝不存 DOM/函数。回载全程 try/catch，坏档=忽略走默认。
   回载后的脏值（如筛选值已不在当前数据的可选项里）交给各看板现有筛选逻辑
   （renderXxxFilters 里 filter(v=>opts.includes(v)) 自然求交）剔除，不因脏值报错/白屏。
   ============================================================ */
/* 安全读：坏档/隐私模式/解析失败一律返回 null（调用方走默认）。 */
function boardStateLoad(key){ try{ const raw=localStorage.getItem(key); if(!raw) return null; const o=JSON.parse(raw); return (o&&typeof o==='object')?o:null; }catch(e){ return null; } }
/* 立即写：try/catch 吞配额/隐私模式异常。 */
function boardStateWrite(key,obj){ try{ localStorage.setItem(key, JSON.stringify(obj||{})); }catch(e){ /* noop */ } }
/* 防抖存：改动即调，~500ms 合并写一次；别在每次渲染里调（应在状态改变的事件里调）。
   每个 key 一个独立定时器，getState 每次求值取最新状态快照。 */
const _boardStateTimers={};
function boardStateSave(key, getState, delay){ clearTimeout(_boardStateTimers[key]);
  _boardStateTimers[key]=setTimeout(()=>{ try{ boardStateWrite(key, typeof getState==='function'?getState():getState); }catch(e){} }, delay||500); }

/* ---------- 数据单位：单台 / 千台K / 万台W ---------- */
const UNIT_OPT={one:{div:1,suf:''},k:{div:1000,suf:'K'},w:{div:10000,suf:'W'}};
const unitInfo=()=>UNIT_OPT[state.unit]||UNIT_OPT.one;
/* 显示格式化（只用于图上标签/坐标轴/tooltip，导出数值走 unitVal 不受影响）。
   两条「不许说谎」的规矩（2026-09-07 复盘 PSI 图被 0W 糊满）：
   ① 无数据(null/NaN) 显「—」，绝不显 0 —— 全局口径 6「缺数不补零」，0 和「没录」是两回事；
   ② 非零值绝不显示成 0 —— 万台档下 499 台曾显示为「0W」，一根有货的柱子写着 0 是错的，
      小到显示不出就写「<0.1W」，宁可粗但不能错。真正的 0 仍照常显示 0。 */
function unitFmt(v){ const u=unitInfo(); if(v==null||isNaN(v)) return '—';
  if(u.div===1) return Math.round(v).toLocaleString('en-US');
  const x=v/u.div;
  if(v!==0 && Math.abs(x)<0.05) return (x<0?'>-0.1':'<0.1')+u.suf;   // 非零但小于显示精度：明说「不足 0.1」而不是谎称 0
  return (Math.abs(x)>=100?Math.round(x).toLocaleString('en-US'):(+x.toFixed(1)))+u.suf; }
function unitVal(v){ const u=unitInfo(); return u.div===1?Math.round(v||0):+(((v||0)/u.div).toFixed(3)); }
/* ---------- 图例位置：顶部居中(默认)/底部/左/右 ---------- */
const LEGEND_POS={
  top:{top:8,left:'center',orient:'horizontal'},
  bottom:{bottom:6,left:'center',orient:'horizontal'},
  left:{left:6,top:'middle',orient:'vertical'},
  right:{right:6,top:'middle',orient:'vertical'},
};
function legendGrid(pos){
  if(pos==='left') return {left:150,right:24,top:18,bottom:30};
  if(pos==='right') return {left:56,right:140,top:18,bottom:30};
  if(pos==='bottom') return {left:56,right:24,top:18,bottom:54};
  return {left:56,right:24,top:46,bottom:30};   // top(默认)：顶部留给图例
}

/* ---------- colors (Acme红→灰 ramp, 可被自定义覆盖) ---------- */
const lerp=(a,b,t)=>Math.round(a+(b-a)*t);
/* ---- 共享调色板（第二批-2b）：全看板颜色常量统一在此定义，各视图不再各自硬编码。
   brand             = Acme红（主色）。
   seriesRampFrom/To = PSI 红→灰渐变两端点（品牌审美，按 stackOrder 位置线性插值，不是离散色板）。
   seriesDiscrete    = custom 自定义图表的 10 色离散板。
   seriesDiscreteFin = finance 经营分析自定义图的 8 色离散板（与 custom 不同，为保各图默认色
                       零变化各自收录，不强行合并）。
   good/warn/bad     = 告警三色（与 index.html :root 的 --good/--warn/--bad 同值，改一处要同步另一处）。 ---- */
const SB_COLORS={
  brand:'#C7000B',
  seriesRampFrom:[199,0,11], seriesRampTo:[156,162,168],
  seriesDiscrete:['#C7000B','#E63340','#2563C9','#1E9E57','#E08600','#7A4FBF','#0E9AA7','#9CA2A8','#C77A00','#5A7FB5'],
  seriesDiscreteFin:['#C7000B','#1A1A1A','#1E9E57','#E08E0B','#5B7FC7','#8A55C7','#11A0A8','#C75BA0'],
  good:'#1E9E57', warn:'#E0A400', bad:'#C7000B',
};
// 系列取色（离散模式，custom/finance 用）：有 override 用 override，否则按 palette 序列取模。
function sbSeriesColor(name,i,overrideMap,palette){
  const ov=overrideMap&&overrideMap[name]; if(ov) return ov;
  const pal=palette||SB_COLORS.seriesDiscrete;
  return pal[((i%pal.length)+pal.length)%pal.length];
}
// 系列取色（ramp 模式，PSI 用）：t∈[0,1] 在红→灰两端点间线性插值，返回 [r,g,b]。
function sbRampRgb(t){
  const c1=SB_COLORS.seriesRampFrom, c2=SB_COLORS.seriesRampTo;
  return [lerp(c1[0],c2[0],t),lerp(c1[1],c2[1],t),lerp(c1[2],c2[2],t)];
}
/* ---- 系列色块行（第二批-2b，custom/finance 共用）：host 内渲染每系列一个 input[type=color]
   （交互照 PSI 侧栏色块模式），点色块改色走 handlers.onChange(name,hex)，「重置配色」走 onReset()。
   只在系列清单/有无 override 变化时重建 DOM（签名对比），拖动取色器过程中只同步色值不重建，
   避免原生取色弹窗因 input 被替换而失联。样式见 index.html .sb-colorrow。 ---- */
function sbEsc(s){ return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/"/g,'&quot;'); }
function sbColorRow(host, names, overrideMap, palette, handlers){
  if(!host) return;
  if(!names||!names.length){ host.innerHTML=''; host._sig=''; return; }
  const pal=palette||SB_COLORS.seriesDiscrete;
  const hasOv=!!(overrideMap&&Object.keys(overrideMap).length);
  const sig=names.join('|')+'#'+(hasOv?1:0);
  if(host._sig===sig){
    host.querySelectorAll('input[type=color]').forEach((inp,i)=>{
      const v=sbSeriesColor(inp.dataset.n,i,overrideMap,pal);
      if(inp.value.toUpperCase()!==String(v).toUpperCase()) inp.value=v;
    });
    return;
  }
  host._sig=sig;
  host.innerHTML='<span style="color:var(--ink3)">系列配色 ▸</span>'
    +names.map((n,i)=>`<label title="点色块改「${sbEsc(n)}」颜色"><input type="color" data-n="${sbEsc(n)}" value="${sbSeriesColor(n,i,overrideMap,pal)}">${sbEsc(n)}</label>`).join('')
    +(hasOv?'<a class="sb-creset" title="清掉全部自定义色，回默认配色">重置配色</a>':'');
  host.querySelectorAll('input[type=color]').forEach(inp=>inp.oninput=()=>handlers.onChange(inp.dataset.n, inp.value.toUpperCase()));
  const rs=host.querySelector('a.sb-creset'); if(rs) rs.onclick=()=>handlers.onReset();
}
function baseRgb(name){
  const ov=state.colorOverride[name];
  if(ov){ const h=ov.replace('#',''); return [parseInt(h.slice(0,2),16),parseInt(h.slice(2,4),16),parseInt(h.slice(4,6),16)]; }
  const i=state.stackOrder.indexOf(name);const n=Math.max(1,state.stackOrder.length-1);const t=n?Math.min(1,Math.max(0,i/n)):0;
  return sbRampRgb(t);
}
const colorCss=n=>{const c=baseRgb(n);return`rgb(${c[0]},${c[1]},${c[2]})`;};
const colorRgba=(n,op)=>{const c=baseRgb(n);return`rgba(${c[0]},${c[1]},${c[2]},${op})`;};
const colorHex=n=>{const c=baseRgb(n);return c.map(x=>x.toString(16).padStart(2,'0')).join('').toUpperCase();};

function ensureOrder(series){
  const sig=series.slice().sort().join('|');
  if(sig===state.orderSig&&state.stackOrder.length){
    state.stackOrder=state.stackOrder.filter(s=>series.includes(s));
    series.forEach(s=>{if(!state.stackOrder.includes(s))state.stackOrder.push(s);});
    return;
  }
  state.orderSig=sig;
  // 配色/堆叠顺序：先按当前维度的层级顺序(产品系列等)，再按高低端(premium)，最后拼音兜底
  const fld=state.stackDim;
  const rank=n=>{ const r=hierRank(fld,n); return r<9999? r : (1000+premiumScore(n)); };
  state.stackOrder=series.slice().sort((a,b)=>{const pa=rank(a),pb=rank(b);if(pa!==pb)return pa-pb;return String(a).localeCompare(String(b),'zh');});
}

/* ============================================================
   跨视图复用的辅助函数（原散落在各 view 段，移至此处共享）
   ============================================================ */
function asArrLocal(v){ return v==null||v===''?[]:(Array.isArray(v)?v:[v]); }

// 日期解析 / ISO 周号：PSI 的 enumMonths/enumWeeks 与汇总表的 maxWeekNum 共用 → 放共享层
function ymdToDate(s){ const p=String(s).split('-'); return new Date(+p[0],(+p[1]||1)-1,(+p[2]||1)); }
// ISO 周号：与 engine-core.isoYW / sosim-core.isoWeek 统一到 UTC 基准（原为本地时区，
// 跨年边界日会与引擎算出不同周号）。取入参 Date 的日历 Y/M/D 在 UTC 重建，走"最近周四"算法。
// 保留原签名 (Date)->[isoYear, weekNum]（maxWeekNum / psi 周轴依赖之）。
function isoWeekOf(dt){
  const dd=new Date(Date.UTC(dt.getFullYear(),dt.getMonth(),dt.getDate()));
  const day=dd.getUTCDay()||7; dd.setUTCDate(dd.getUTCDate()+4-day);   // 挪到本周周四(ISO 周归属)
  const ys=new Date(Date.UTC(dd.getUTCFullYear(),0,1));
  const w=Math.ceil((((dd-ys)/86400000)+1)/7);
  return [dd.getUTCFullYear(), w];
}

// 周范围控件(国家看板/汇总表共用)：可任选 W从~W到 → 放共享层(跨视图)
function maxWeekNum(){ if(!state.to) return 52; const w=isoWeekOf(ymdToDate(state.to)); return Math.max(1,w[1]); }
function renderWeekRange(hostId, st, redraw){
  const host=$('#'+hostId); if(!host) return; const mw=maxWeekNum();
  if(!st.toW || st.toW>mw) st.toW=mw;
  if(!st.fromW || st.fromW>st.toW) st.fromW=Math.max(1, mw-8);
  const opt=sel=>{ let s=''; for(let w=1;w<=mw;w++) s+=`<option value="${w}" ${w===sel?'selected':''}>W${w}</option>`; return s; };
  host.innerHTML=`<select class="wkf">${opt(st.fromW)}</select><span style="color:var(--ink3)">~</span><select class="wkt">${opt(st.toW)}</select>`;
  host.querySelector('.wkf').onchange=e=>{ st.fromW=+e.target.value; if(st.fromW>st.toW)st.toW=st.fromW; renderWeekRange(hostId,st,redraw); redraw(); };
  host.querySelector('.wkt').onchange=e=>{ st.toW=+e.target.value; if(st.toW<st.fromW)st.fromW=st.toW; renderWeekRange(hostId,st,redraw); redraw(); };
}

function numCell(v){ return v==null?'—':Math.round(v).toLocaleString('en-US'); }
// DOS 带红绿灯圆点。kind='channel': <90绿 90-120黄 >120红；kind='flow': <120绿 120-150黄 >150红
function dosCell(v,kind){
  if(v==null||v==='') return '—';
  const n=Math.round(v); let cls;
  if(kind==='flow') cls = n<120?'dot-g':(n<=150?'dot-y':'dot-r');
  else cls = n<90?'dot-g':(n<=120?'dot-y':'dot-r');
  return n.toLocaleString('en-US')+'<span class="dot-dos '+cls+'"></span>';
}
function pctCell(v){ if(v==null) return '<span class="wk">—</span>'; const c=v>=0?'pos':'neg'; return `<span class="${c}">${(v*100).toFixed(0)}%</span>`; }

// 产品系列从高到低顺序(用户确认)：平板 4 系列 + 音频 4 系列
const SERIES_ORDER=['Slate Pro系列','Slate Air系列','Slate Tab系列','Slate SE系列','TWS旗舰系列','TWS精品系列','TWS基础系列','开放式耳机系列','颈戴耳机','低成本TWS耳机'];
function seriesRank(v){ const i=SERIES_ORDER.indexOf(v); if(i>=0) return i; for(let j=0;j<SERIES_ORDER.length;j++){ if(v&&String(v).includes(SERIES_ORDER[j])) return j+0.5; } return 999; }
// 各维度的层级展示顺序(从上到下/从高到低)：大区→国家办→国家、产品线→产品系列。下拉/配色都按这个排，不按拼音乱排
const FILTER_ORDER={
  repOffice:['墨西哥','哥伦比亚','南美洲多国','巴西'],
  country:['墨西哥','加拿大','哥伦比亚','危地马拉','萨尔瓦多','洪都拉斯','哥斯达黎加','尼加拉瓜','巴拿马','多米尼加','智利','秘鲁','阿根廷','乌拉圭','巴西','巴拉圭'],
  family:['平板','音频'], line:['平板','音频'], series:SERIES_ORDER,
};
function hierRank(field,v){ const arr=FILTER_ORDER[field]; if(arr){ const s=String(v); for(let i=0;i<arr.length;i++) if(s.includes(arr[i])) return i; } return 9999; }
function sortByHier(field,arr){ return arr.slice().sort((a,b)=>{ const ra=hierRank(field,a),rb=hierRank(field,b); if(ra!==rb)return ra-rb; return String(a).localeCompare(String(b),'zh'); }); }

// 文件名日期戳 yyyy-mm-dd：各视图导出文件名共用 → 放共享层(跨视图)
function todayStr(){const d=new Date();return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');}
// 当前激活视图 id：finance/psi 视图在重绘时判断要不要刷新顶部信息条 → 跨视图共用
function currentView(){ const el=document.querySelector('.view.active'); return el?el.id.replace('view-',''):'psi'; }
// 每个看板顶部窄信息条：数据来源(底表/文件夹) + 截至时间 + 刷新时间。designer/finance/psi 视图均调用 → 跨视图共用
function renderDataBar(view){
  const bar=$('#dataBar'); if(!bar) return;
  if(view==='source'||view==='pricing'||view==='pricinglib'||view==='roadmap'||view==='textout'){ bar.classList.add('hidden'); return; }
  const base=p=>p?String(p).replace(/[\\/]+$/,'').split(/[\\/]/).pop():null;
  const refresh=state.lastRefresh?new Date(state.lastRefresh).toLocaleString('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}):null;
  const chips=[]; const add=(ic,txt)=>{ if(txt) chips.push(`<span class="db-chip"><span class="db-ic">${ic}</span>${txt}</span>`); };
  const psiFolder=base(state.folder);
  if(view==='finance'){
    if(!state.finMeta){ bar.innerHTML='<span class="db-chip db-warn">⚠ 未锚定经营分析数据：把预测表+实际表放进「经营分析文件夹」后刷新</span>'; bar.classList.remove('hidden'); return; }
    const ay=state.finMeta.actualYears||state.finMeta.years||[];
    const cut=(fin.ach&&fin.ach.curYear&&fin.ach.toM)?('，最新实际 '+fin.ach.curYear+'年'+fin.ach.toM+'月'):'';
    add('💹','经营分析 · <b>财经底表</b>');
    add('📅','实际数据 <b>'+(ay.length?(ay[0]+'~'+ay[ay.length-1]+'年'):'—')+'</b>'+cut);
    add('📁','来源 经营分析文件夹'+(psiFolder?' · '+psiFolder:'（内置示例）'));
  } else if(view==='designer' && typeof dz!=='undefined' && dz.dataset==='idc'){
    add('📈','看板设计器 · <b>IDC 市场底表</b>');
    if(state.idcMeta) add('🔢','<b>'+state.idcMeta.n.toLocaleString()+'</b> 条 · '+(state.idcMeta.cats||[]).join('/'));
    add('📁','来源 '+(base(state.idcFolder)||'IDC市场文件夹（未锚定）'));
  } else {
    if(!state.dims.length){ bar.innerHTML='<span class="db-chip db-warn">⚠ 未锚定 PSI 数据，当前为示例/空数据 — 点右上「📁 PSI 文件夹」</span>'; bar.classList.remove('hidden'); return; }
    const label={psi:'PSI 销量/库存',industry:'产业看板 · PSI+全流程',country:'国家看板 · PSI+全流程',report:'汇总表 · PSI+全流程',custom:'自定义图表 · PSI',designer:'看板设计器 · 经营PSI'}[view]||'PSI 数据';
    add('📊','<b>'+label+'</b>');
    add('📅','数据截至 <b>'+(state.to||'—')+'</b>'+(state.from?'（'+state.from+' 起）':''));
    if(['industry','country','report'].includes(view) && state.flowDate) add('📦','全流程库存截至 <b>'+state.flowDate+'</b>');
    add('📁','来源 PSI文件夹'+(psiFolder?' · '+psiFolder:'（内置示例）'));
  }
  add('🔄','刷新 '+(refresh||'—'));
  bar.innerHTML=chips.join('<span class="db-sep">|</span>');
  bar.classList.remove('hidden');
  // 源文件最新时间（异步）：取各底表源 mtime 最大值，取到再补一枚 chip。
  // 让用户能对比「界面刷新时间 vs 源文件时间」发现数据过期。失败/无源则不显。
  renderDataBarFreshness(bar, view);
}

// dataBar 的「源文件最新」chip：异步取 api.sourcesInfo() 各源 mtime 最大值后补显。
// token 防串：view 切换后 renderDataBar 重跑会改 bar.dataset.dbToken，旧的异步回来就丢弃。
function renderDataBarFreshness(bar, view){
  if(!bar || !api || typeof api.sourcesInfo!=='function') return;
  const token=String(Date.now())+'_'+view; bar.dataset.dbToken=token;
  Promise.resolve(api.sourcesInfo()).then(info=>{
    if(!info || info.error) return;
    if(bar.dataset.dbToken!==token) return;           // 期间已重渲/切视图 → 丢弃
    let maxM=0; Object.keys(info).forEach(k=>{ const s=info[k]; if(s && s.mtime && s.mtime>maxM) maxM=s.mtime; });
    if(!maxM) return;
    const txt=new Date(maxM).toLocaleString('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'});
    // 幂等：若已补过则替换该 chip 文本，否则追加。
    const existed=bar.querySelector('.db-fresh');
    if(existed){ existed.innerHTML='<span class="db-ic">🗂</span>源文件最新 <b>'+txt+'</b>'; return; }
    if(bar.querySelector('.db-chip')) bar.insertAdjacentHTML('beforeend','<span class="db-sep">|</span>');
    bar.insertAdjacentHTML('beforeend','<span class="db-chip db-fresh"><span class="db-ic">🗂</span>源文件最新 <b>'+txt+'</b></span>');
  }).catch(()=>{});
}

// 从HTML单元格里抽纯文本+颜色类(pos/neg/wk)，供画布/导出复用
function cellPlain(html){ const s=String(html); const m=s.match(/class="([^"]*)"/); let c=null;
  if(m){ if(/\bpos\b/.test(m[1]))c='pos'; else if(/\bneg\b/.test(m[1]))c='neg'; else if(/\bwk\b/.test(m[1]))c='wk'; }
  return {t:s.replace(/<[^>]+>/g,'').trim()||'—', c}; }
// 通用表格→PNG(居中,首列左)。headerCells:[字符串]; bodyRows:[{cells:[{t,c,bold}|str], tot}]
function drawTablePNG(title, headerCells, bodyRows){
  const padX=10,rowH=24,headH=30,titleH=title?34:0;
  const meas=document.createElement('canvas').getContext('2d'); meas.font='12px '+YH;
  const colW=headerCells.map((h,ci)=>{ let w=meas.measureText(String(h)).width;
    bodyRows.forEach(r=>{ const c=r.cells[ci]; const tx=c&&c.t!=null?c.t:(c==null?'':c); w=Math.max(w,meas.measureText(String(tx)).width); });
    return Math.ceil(Math.max(ci===0?90:46, w+padX*2)); });
  const W=colW.reduce((a,b)=>a+b,0), H=titleH+headH+bodyRows.length*rowH, dpr=2;
  const cvs=document.createElement('canvas'); cvs.width=W*dpr; cvs.height=H*dpr;
  const ctx=cvs.getContext('2d'); ctx.scale(dpr,dpr); ctx.textBaseline='middle';
  ctx.fillStyle='#fff'; ctx.fillRect(0,0,W,H);
  let y=0;
  if(title){ ctx.fillStyle='#C7000B'; ctx.font='bold 14px '+YH; ctx.textAlign='left'; ctx.fillText(title,10,titleH/2); y=titleH; }
  ctx.fillStyle='#C7000B'; ctx.fillRect(0,y,W,headH); ctx.fillStyle='#fff'; ctx.font='bold 11px '+YH;
  let x=0; headerCells.forEach((h,ci)=>{ ctx.textAlign=ci===0?'left':'center'; ctx.fillText(String(h), ci===0?x+padX:x+colW[ci]/2, y+headH/2); x+=colW[ci]; });
  y+=headH; ctx.font='12px '+YH;
  bodyRows.forEach((r,ri)=>{ ctx.fillStyle=r.tot?'#FFF6F6':(ri%2?'#FBFBFC':'#fff'); ctx.fillRect(0,y,W,rowH);
    let xx=0; r.cells.forEach((c,ci)=>{ const t=c&&c.t!=null?c.t:(c==null?'':c); const col=c&&c.c;
      ctx.fillStyle=col==='pos'?'#1E9E57':col==='neg'?'#C7000B':col==='wk'?'#A8AEB5':(ci===0?(r.tot?'#C7000B':'#1A1A1A'):'#1A1A1A');
      ctx.font=((c&&c.bold)||r.tot||ci===0)?'bold 12px '+YH:'12px '+YH;
      ctx.textAlign=ci===0?'left':'center'; ctx.fillText(String(t), ci===0?xx+padX:xx+colW[ci]/2, y+rowH/2); xx+=colW[ci]; });
    ctx.strokeStyle='#F0F1F3'; ctx.beginPath(); ctx.moveTo(0,y+rowH); ctx.lineTo(W,y+rowH); ctx.stroke(); y+=rowH; });
  return cvs.toDataURL('image/png').split(',')[1];
}

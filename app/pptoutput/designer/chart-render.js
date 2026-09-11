(function (root, factory){ const a=factory(); if(typeof module!=='undefined'&&module.exports)module.exports=a; if(typeof window!=='undefined')window.PptChartRender=a; })(this, function(){
  'use strict';
  // 字体常量：与 common.js 的 YH 一致；node 测试无全局 YH 时用此兜底。
  const YH = (typeof window!=='undefined' && window.YH) || '"Microsoft YaHei","微软雅黑",sans-serif';
  // 数值格式化：浏览器里复用 common.js 的全局 fmt/shortLabel；node 里这些 formatter 不会被调用（echarts 渲染时才执行），仍给安全兜底。
  const _fmt = (typeof window!=='undefined' && typeof window.fmt==='function') ? window.fmt
             : (typeof fmt==='function' ? fmt : (n=>String(n==null?'':n)));
  const _shortLabel = (typeof window!=='undefined' && typeof window.shortLabel==='function') ? window.shortLabel
             : (typeof shortLabel==='function' ? shortLabel : (n=>String(n==null||!n?'':n)));
  // 单位/小数格式化（Task A1）：node require、浏览器 window.PptNumFmt
  const _numfmt = (typeof window!=='undefined' && window.PptNumFmt) ? window.PptNumFmt
             : (typeof require==='function' ? (function(){ try{ return require('./numfmt.js'); }catch(e){ return null; } })() : null);

  // 取 fmtOpt 的 unit/decimals，返回数值 formatter（百分比模式保留 %）
  function numFmtter(fmtOpt){
    const unit=(fmtOpt&&fmtOpt.unit)||'auto';
    const dec=(fmtOpt&&fmtOpt.decimals==null)?1:(fmtOpt?fmtOpt.decimals:1);
    if(_numfmt&&typeof _numfmt.formatNum==='function') return v=>_numfmt.formatNum(v, unit, dec);
    return v=>_shortLabel(v);
  }
  // 颜色：fmt.colors[name] 优先（统一加 # 前缀给 echarts），否则用 palette[idx]（palette 已带 # 或加 #）
  function withHash(c){ return (typeof c==='string'&&c[0]!=='#')?('#'+c):c; }
  function colorFor(fmtOpt, name, idx, palette){
    if(fmtOpt&&fmtOpt.colors&&fmtOpt.colors[name]) return withHash(fmtOpt.colors[name]);
    const p=palette&&palette[idx]; return p==null?p:withHash(p);
  }

  // 图表分类常量（与 designer-view.js 一致）
  const HBAR=['bar','stackBar','stack100Bar'];
  const PCT=['stack100','stack100Bar'];
  // 9 图例位 + 旧值兼容映射
  const LEGEND_LEGACY={bottom:'bc',top:'tc',left:'lc',right:'rc'};
  const LEGEND_POS={
    tl:{top:0,left:0,orient:'horizontal'}, tc:{top:0,left:'center',orient:'horizontal'}, tr:{top:0,right:0,orient:'horizontal'},
    lc:{left:0,top:'middle',orient:'vertical'}, rc:{right:0,top:'middle',orient:'vertical'},
    bl:{bottom:0,left:0,orient:'horizontal'}, bc:{bottom:0,left:'center',orient:'horizontal'}, br:{bottom:0,right:0,orient:'horizontal'}
  };

  /* ---- 图例位置 → legend 配置 + grid 内边距增量（搬自 dzLegendCfg，颜色/字体不变）---- */
  function legendCfg(fmtOpt, multi){
    let pos=(fmtOpt&&fmtOpt.legendPos)||'bottom';
    if(LEGEND_LEGACY[pos]) pos=LEGEND_LEGACY[pos];        // 旧值 → 新代码
    if(pos==='none'){ return {legend:{show:false},pad:{left:0,right:0,top:0,bottom:0}}; }
    const cfg=LEGEND_POS[pos]||LEGEND_POS.bc;
    const show=!!((fmtOpt&&fmtOpt.showLegend)&&multi);
    const base={show,type:'scroll',textStyle:{fontFamily:YH,fontSize:(fmtOpt&&fmtOpt.legendFontSize!=null?fmtOpt.legendFontSize:10),color:'#5A5F66'},itemWidth:11,itemHeight:8};
    const pad={left:0,right:0,top:0,bottom:0};
    if(!show){ Object.assign(base,cfg); return {legend:base,pad}; }
    Object.assign(base,cfg);
    if(cfg.top===0) pad.top=24;
    if(cfg.bottom===0) pad.bottom=24;
    if(cfg.left===0&&cfg.orient==='vertical') pad.left=82;
    if(cfg.right===0&&cfg.orient==='vertical') pad.right=82;
    return {legend:base,pad};
  }

  /* ---- 直角坐标(簇状/堆积/百分比 × 柱形/条形, 折线/面积/组合) ---- */
  function cartesianOption(type, fmtOpt, res, palette){
    const series=res.series, cats=res.cats, data=res.data, colors=palette;
    const horizontal=HBAR.includes(type);
    const pct=PCT.includes(type);
    const stacked=(type==='area'||type==='stackColumn'||type==='stackBar'||pct);
    let totals=null; if(pct) totals=cats.map(c=>series.reduce((a,se)=>a+(data[se][c]||0),0));
    const cv=(se,c,ci)=>{ const v=data[se][c]||0; if(pct){ const t=totals[ci]; return t>0?+(v/t*100).toFixed(2):0; } return +v.toFixed(2); };
    const labPos=horizontal?(stacked?'inside':'right'):(stacked?'inside':'top');
    const nf=numFmtter(fmtOpt);
    const labFs=(fmtOpt.labelFontSize!=null?fmtOpt.labelFontSize:9);
    const catFs=(fmtOpt.catFontSize!=null?fmtOpt.catFontSize:10);
    const valFs=(fmtOpt.valFontSize!=null?fmtOpt.valFontSize:10);
    const cAt=(se,si)=>colorFor(fmtOpt,se,si,colors);
    // S2: canonical 序位映射；取色仍按 canonical 名序位。
    // 堆积反向发出（canonical 顶 → echarts 末位 = 视觉顶层）仅在 fmtOpt.stackTopFirst 时启用——
    // PPT 设计器开此约定(列表顶=堆积顶)，看板设计器不传→保持原堆积序，零回归。
    const cidx={}; series.forEach((s,i)=>{ cidx[s]=i; });
    const emit = (stacked && fmtOpt && fmtOpt.stackTopFirst) ? series.slice().reverse() : series;
    const ec=emit.map((se)=>{
      const si=cidx[se];
      const dat=cats.map((c,ci)=>cv(se,c,ci));
      const cc=cAt(se,si);
      const lab={show:fmtOpt.showLabels,position:labPos,fontFamily:YH,fontSize:labFs,color:stacked?'#fff':'#333',textBorderWidth:0,formatter:p=> pct?(p.value?Math.round(p.value)+'%':''):nf(p.value)};
      if(type==='line') return {name:se,type:'line',smooth:false,symbol:'circle',symbolSize:4,lineStyle:{width:2,color:cc},itemStyle:{color:cc},label:Object.assign({},lab,{position:'top'}),data:dat};
      if(type==='area') return {name:se,type:'line',stack:'s',areaStyle:{color:cc,opacity:.85},lineStyle:{width:1,color:'#fff'},symbol:'none',itemStyle:{color:cc},label:Object.assign({},lab,{position:'top'}),data:dat};
      if(type==='combo') return si===0? {name:se,type:'line',symbol:'circle',symbolSize:5,lineStyle:{width:2.5,color:'#1A1A1A'},itemStyle:{color:'#1A1A1A'},z:5,label:Object.assign({},lab,{position:'top',color:'#333'}),data:dat} : {name:se,type:'bar',itemStyle:{color:cc},label:Object.assign({},lab,{color:'#333',position:'top'}),data:dat};
      return {name:se,type:'bar',stack:stacked?'s':undefined,itemStyle:{color:cc,borderColor:'#fff',borderWidth:.3},label:lab,data:dat};
    });
    const catAxis={type:'category',data:cats,axisLabel:{fontFamily:YH,fontSize:catFs,color:'#8A9099',interval:cats.length>10?'auto':0,rotate:cats.length>6&&!horizontal?30:0},axisLine:{lineStyle:{color:'#E6E8EB'}},axisTick:{show:false}};
    const valAxis={type:'value',max:pct?100:null,axisLabel:{fontFamily:YH,fontSize:valFs,color:'#8A9099',formatter:v=>pct?v+'%':nf(v)},splitLine:{lineStyle:{color:'#F0F1F3'}}};
    const multi=series.length>1&&series[0]!=='(值)';
    const {legend,pad}=legendCfg(fmtOpt,multi);
    legend.data=series.slice();  // S2: canonical 正序 → 图例自上而下与堆积视觉一致
    return {textStyle:{fontFamily:YH},color:colors,
      tooltip:{trigger:'axis',backgroundColor:'rgba(26,26,26,.92)',borderWidth:0,textStyle:{color:'#fff',fontFamily:YH,fontSize:11},
        valueFormatter:v=>pct?(v||0)+'%':nf(v)},
      legend:legend,
      grid:{left:(horizontal?70:48)+pad.left,right:14+pad.right,top:12+pad.top,bottom:22+pad.bottom},
      xAxis:horizontal?valAxis:catAxis, yAxis:horizontal?catAxis:valAxis,
      dataZoom:[{type:'inside',zoomOnMouseWheel:'ctrl',moveOnMouseWheel:false}], series:ec};
  }

  /* ---- 饼/环 ---- */
  function pieOption(type, fmtOpt, res, palette){
    const cats=res.cats;
    const se=res.series[0];
    const arr=cats.map((c,i)=>{ const o={name:c,value:+(res.data[se][c]||0).toFixed(2)}; const cc=fmtOpt.colors&&fmtOpt.colors[c]; if(cc) o.itemStyle={color:withHash(cc)}; return o; }).filter(o=>o.value>0);
    const {legend,pad}=legendCfg(fmtOpt,true);
    const cx=50+(pad.left?14:0)-(pad.right?14:0), cy=46+(pad.top?8:0)-(pad.bottom?6:0);
    return {textStyle:{fontFamily:YH},color:palette,tooltip:{trigger:'item',formatter:'{b}: {c} ({d}%)',backgroundColor:'rgba(26,26,26,.92)',borderWidth:0,textStyle:{color:'#fff',fontFamily:YH}},
      legend:legend,
      series:[{type:'pie',radius:type==='donut'?['42%','64%']:'64%',center:[cx+'%',cy+'%'],data:arr,
        label:{show:fmtOpt.showLabels,fontFamily:YH,fontSize:(fmtOpt.labelFontSize!=null?fmtOpt.labelFontSize:10),formatter:'{b}\n{d}%'},labelLine:{show:fmtOpt.showLabels}}]};
  }

  /* ---- 树状图 ---- */
  function treemapOption(fmtOpt, res, palette){
    const se=res.series[0]; const nf=numFmtter(fmtOpt);
    const labFs=(fmtOpt.labelFontSize!=null?fmtOpt.labelFontSize:11);
    const arr=res.cats.map((c,i)=>({name:c,value:+(res.data[se][c]||0).toFixed(2),itemStyle:{color:colorFor(fmtOpt,c,i%palette.length,palette)}})).filter(o=>o.value>0);
    return {textStyle:{fontFamily:YH},tooltip:{formatter:p=>p.name+'：'+nf(p.value)},
      series:[{type:'treemap',roam:false,nodeClick:false,breadcrumb:{show:false},data:arr,label:{fontFamily:YH,fontSize:labFs,formatter:p=>p.name+'\n'+nf(p.value)}}]};
  }

  /* ---- 漏斗 ---- */
  function funnelOption(fmtOpt, res, palette){
    const se=res.series[0]; const nf=numFmtter(fmtOpt);
    const labFs=(fmtOpt.labelFontSize!=null?fmtOpt.labelFontSize:10);
    const arr=res.cats.map((c,i)=>{ const o={name:c,value:+(res.data[se][c]||0).toFixed(2)}; const cc=fmtOpt.colors&&fmtOpt.colors[c]; if(cc) o.itemStyle={color:withHash(cc)}; return o; }).filter(o=>o.value>0).sort((a,b)=>b.value-a.value);
    return {textStyle:{fontFamily:YH},color:palette,tooltip:{formatter:p=>p.name+'：'+nf(p.value)},
      series:[{type:'funnel',left:'8%',right:'8%',top:10,bottom:10,data:arr,label:{fontFamily:YH,fontSize:labFs,formatter:p=>p.name+' '+nf(p.value)}}]};
  }

  /* ---- 仪表盘 ---- */
  function gaugeOption(fmtOpt, res, palette, name){
    const total=res.total||0; const max=Math.max(1,total*1.4); const nf=numFmtter(fmtOpt);
    return {textStyle:{fontFamily:YH},series:[{type:'gauge',min:0,max:Math.round(max),progress:{show:true,width:14},axisLine:{lineStyle:{width:14}},
      pointer:{show:true},detail:{valueAnimation:true,fontFamily:YH,fontSize:18,formatter:v=>nf(v),offsetCenter:[0,'60%']},
      data:[{value:Math.round(total),name:name||''}],title:{fontFamily:YH,fontSize:11,offsetCenter:[0,'88%']},
      axisLabel:{fontFamily:YH,fontSize:9},itemStyle:{color:'#C7000B'}}]};
  }

  /* ---- 瀑布 ---- */
  function waterfallOption(fmtOpt, res, palette){
    const se=res.series[0]; const cats=res.cats; const nf=numFmtter(fmtOpt);
    const catFs=(fmtOpt.catFontSize!=null?fmtOpt.catFontSize:10);
    const valFs=(fmtOpt.valFontSize!=null?fmtOpt.valFontSize:10);
    const labFs=(fmtOpt.labelFontSize!=null?fmtOpt.labelFontSize:9);
    const vals=cats.map(c=>+(res.data[se][c]||0).toFixed(2));
    const base=[]; let run=0; vals.forEach(v=>{ base.push(run); run+=v; });
    return {textStyle:{fontFamily:YH},tooltip:{trigger:'axis',formatter:p=>{const i=p[0].dataIndex;return cats[i]+'：'+nf(vals[i])+'<br>累计：'+nf(base[i]+vals[i]);}},
      grid:{left:48,right:14,top:14,bottom:28},xAxis:{type:'category',data:cats,axisLabel:{fontFamily:YH,fontSize:catFs,color:'#8A9099',rotate:cats.length>6?30:0}},
      yAxis:{type:'value',axisLabel:{fontFamily:YH,fontSize:valFs,formatter:v=>nf(v)},splitLine:{lineStyle:{color:'#F0F1F3'}}},
      series:[{type:'bar',stack:'w',itemStyle:{borderColor:'transparent',color:'transparent'},data:base},
        {type:'bar',stack:'w',data:vals.map(v=>({value:v,itemStyle:{color:v>=0?'#1E9E57':'#C7000B'}})),label:{show:fmtOpt.showLabels,position:'top',fontFamily:YH,fontSize:labFs,formatter:p=>nf(p.value)}}]};
  }

  /* ---- 入口：按 vtype 返回 echarts option（纯函数，无 DOM/无 setOption）----
     res={cats,series,data,total}；fmtOpt={showLegend,showLabels,legendPos,gran,gaugeName?}；palette=颜色数组 */
  function chartOption(vtype, fmtOpt, res, palette){
    fmtOpt=fmtOpt||{}; palette=palette||[];
    if(vtype==='pie'||vtype==='donut') return pieOption(vtype, fmtOpt, res, palette);
    if(vtype==='treemap') return treemapOption(fmtOpt, res, palette);
    if(vtype==='funnel') return funnelOption(fmtOpt, res, palette);
    if(vtype==='gauge') return gaugeOption(fmtOpt, res, palette, fmtOpt.gaugeName);
    if(vtype==='waterfall') return waterfallOption(fmtOpt, res, palette);
    // 其余直角坐标：column/stackColumn/stack100/bar/stackBar/stack100Bar/line/area/combo
    return cartesianOption(vtype, fmtOpt, res, palette);
  }

  return { chartOption, legendCfg, HBAR, PCT, YH };
});

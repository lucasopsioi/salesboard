const CR=require('./chart-render.js');
let f=0; const ok=(n,c)=>{console.log((c?'PASS ':'FAIL ')+n); if(!c)f++;};
const res={cats:['1月','2月'], series:['A','B'], data:{A:{'1月':1,'2月':2},B:{'1月':3,'2月':4}}, total:10};
const fmt={showLegend:true,showLabels:false,legendPos:'bottom'};
const pal=['#C7000B','#5A5F66'];
ok('column→bar series', CR.chartOption('column',fmt,res,pal).series[0].type==='bar');
ok('line→line', CR.chartOption('line',fmt,res,pal).series[0].type==='line');
ok('area→line+areaStyle', !!CR.chartOption('area',fmt,res,pal).series[0].areaStyle);
ok('pie→pie', CR.chartOption('pie',fmt,res,pal).series[0].type==='pie');
ok('donut 内半径', CR.chartOption('donut',fmt,res,pal).series[0].radius[0]!=='0');
ok('treemap', CR.chartOption('treemap',fmt,res,pal).series[0].type==='treemap');
ok('gauge', CR.chartOption('gauge',fmt,res,pal).series[0].type==='gauge');
ok('waterfall 两系列(透明底+值)', CR.chartOption('waterfall',fmt,res,pal).series.length===2);
ok('stackColumn 堆叠', !!CR.chartOption('stackColumn',fmt,res,pal).series[0].stack);
// extra: 横向条形(类别轴在Y)、百分比堆叠(value max=100)、funnel、combo
ok('bar→横向(yAxis为category)', CR.chartOption('bar',fmt,res,pal).yAxis.type==='category');
ok('stack100→value max=100', CR.chartOption('stack100',fmt,res,pal).yAxis.max===100);
ok('funnel', CR.chartOption('funnel',fmt,res,pal).series[0].type==='funnel');
ok('combo 首系列为line/次为bar', (()=>{const s=CR.chartOption('combo',fmt,res,pal).series; return s[0].type==='line'&&s[1].type==='bar';})());
ok('palette 用于 color', CR.chartOption('column',fmt,res,pal).color[0]==='#C7000B');

// ---- A3: 单位/小数/9图例位/系列色/字号 ----
{ const res2={cats:['1月','2月'],series:['A','B'],data:{A:{'1月':10000,'2月':20000},B:{'1月':5,'2月':6}},total:1};
  const o=CR.chartOption('column',{showLegend:true,legendPos:'tr',colors:{A:'FF0000'},catFontSize:14,valFontSize:7,labelFontSize:8,unit:'w',decimals:1},res2,['111111','222222']);
  ok('图例右上 legend.top=0 right=0', o.legend && o.legend.top===0 && o.legend.right===0);
  ok('系列A用自定义色(带#)', (o.series.find(s=>s.name==='A')||{}).itemStyle.color==='#FF0000');
  ok('类别轴字号14', o.xAxis.axisLabel.fontSize===14);
  ok('值轴字号7', o.yAxis.axisLabel.fontSize===7);
  ok('系列label字号8', o.series[0].label.fontSize===8);
  ok('legendPos 兼容旧 bottom', CR.chartOption('column',{showLegend:true,legendPos:'bottom'},res2,['1','2']).legend.bottom===0);
  ok('legendPos none → 不显示', CR.chartOption('column',{showLegend:true,legendPos:'none'},res2,['1','2']).legend.show===false);
  ok('legendPos lc → left=0 vertical', (()=>{const l=CR.chartOption('column',{showLegend:true,legendPos:'lc'},res2,['1','2']).legend; return l.left===0&&l.orient==='vertical';})());
  ok('legendPos bl → bottom=0 left=0', (()=>{const l=CR.chartOption('column',{showLegend:true,legendPos:'bl'},res2,['1','2']).legend; return l.bottom===0&&l.left===0;})());
  // numfmt 接入：formatter 走 PptNumFmt（unit=w,decimals=1 → 10000 => "1.0万"）
  ok('值轴 formatter 用 numfmt(单位万)', CR.chartOption('column',{unit:'w',decimals:1},res2,['1','2']).yAxis.axisLabel.formatter(10000)==='1.0万');
  ok('百分比模式仍带%', CR.chartOption('stack100',{},res2,['1','2']).yAxis.axisLabel.formatter(50)==='50%');
  // 系列色应用于 pie
  ok('pie 自定义色(带#)', (()=>{const o=CR.chartOption('pie',{colors:{'1月':'00FF00'}},res2,['1','2']); return (o.series[0].data.find(d=>d.name==='1月')||{}).itemStyle.color==='#00FF00';})());
}

// ---- S2: 堆积反转(仅 stackTopFirst) + legend.data 正序 + 颜色按系列名 ----
{ const res={cats:['1月','2月'],series:['A','B','C'],data:{A:{'1月':1,'2月':1},B:{'1月':2,'2月':2},C:{'1月':3,'2月':3}},total:1};
  const o=CR.chartOption('stackColumn',{showLegend:true,legendPos:'rc',stackTopFirst:true},res,['#111','#222','#333']);
  // canonical [A,B,C] + stackTopFirst → 堆积反转 echarts series [C,B,A]：series[0].name=C(底)、末位=A(顶)
  ok('堆积反转 series[0]=C', o.series[0].name==='C');
  ok('堆积反转 末位=A', o.series[o.series.length-1].name==='A');
  ok('legend.data 正序=canonical', JSON.stringify(o.legend.data)===JSON.stringify(['A','B','C']));
  // 颜色按 canonical 名：A→palette[0]=#111，无论它被排到末位
  const aS=o.series.find(s=>s.name==='A');
  ok('A 颜色仍=palette[0]', (aS.itemStyle&&aS.itemStyle.color)==='#111');
  const cS=o.series.find(s=>s.name==='C');
  ok('C 颜色仍=palette[2]', (cS.itemStyle&&cS.itemStyle.color)==='#333');
  // 看板设计器不传 stackTopFirst → 堆积不反转(零回归)：series[0] 仍为 canonical 首 A
  const o2=CR.chartOption('stackColumn',{showLegend:true},res,['#111','#222','#333']);
  ok('无 stackTopFirst→不反转 series[0]=A', o2.series[0].name==='A');
}
{ const res={cats:['1月'],series:['A','B'],data:{A:{'1月':1},B:{'1月':2}},total:1};
  const o=CR.chartOption('column',{showLegend:true,legendPos:'bc'},res,['#111','#222']);
  ok('非堆积正序 series[0]=A', o.series[0].name==='A');
  ok('非堆积 legend.data=正序', JSON.stringify(o.legend.data)===JSON.stringify(['A','B']));
}
console.log(f?('\n'+f+' FAILED'):'\nALL PASS'); process.exit(f?1:0);

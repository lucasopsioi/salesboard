const PptxGenJS = require('pptxgenjs');   // node 测试用 npm 包；渲染端用 window.PptxGenJS
const E = require('./export-pptx.js');
const D = require('./doc-model.js');
let f=0; const ok=(n,c)=>{console.log((c?'PASS ':'FAIL ')+n); if(!c)f++;};
(async()=>{
  const doc=D.newPresentation('t');
  const t=D.newElement('text',{x:1,y:1,w:4,h:0.6,text:'手机SO'}); D.addElement(doc,0,t);
  const dv=D.newElement('data',{x:1,y:2,w:2,h:1,style:{unit:'万'}}); D.addElement(doc,0,dv);
  const tb=D.newElement('table',{x:1,y:3,w:6,h:2}); D.addElement(doc,0,tb);
  D.addSlide(doc); const t2=D.newElement('text',{text:'第二页'}); D.addElement(doc,1,t2);
  const resolvedMap={};
  resolvedMap[dv.id]={kind:'value', value:142, yoy:0.48};
  resolvedMap[tb.id]={kind:'matrix', cats:['1月','2月'], series:[{name:'A',values:[10,20]},{name:'B',values:[5,6]}]};
  const b64=await E.exportDoc({PptxGenJS, doc, resolvedMap});
  ok('导出 base64 非空', typeof b64==='string' && b64.length>3000);
  // 重新解包验证是有效 pptx（zip 头 + 含 slides）
  const buf=Buffer.from(b64,'base64');
  ok('是 zip(PK 头)', buf[0]===0x50 && buf[1]===0x4B);
  // --- native charts ---
  {
    const doc2=D.newPresentation('c');
    const c1=D.newElement('chart',{x:1,y:1,w:6,h:3,chart:{vtype:'column'}}); D.addElement(doc2,0,c1);
    const c2=D.newElement('chart',{x:1,y:4,w:6,h:3,chart:{vtype:'pie'}}); D.addElement(doc2,0,c2);
    const rm2={};
    rm2[c1.id]={kind:'matrix',cats:['1月','2月','3月'],series:[{name:'A',values:[1,2,3]},{name:'B',values:[4,5,6]}]};
    rm2[c2.id]={kind:'matrix',cats:['X','Y'],series:[{name:'S',values:[7,8]}]};
    const b=await E.exportDoc({PptxGenJS, doc:doc2, resolvedMap:rm2});
    ok('原生图导出非空', typeof b==='string' && b.length>3000);
    // map 函数单测：vtype→pptx 参数
    const map=E.chartMap('stack100');
    ok('stack100→bar/col/percentStacked', map.type==='bar' && map.barDir==='col' && map.barGrouping==='percentStacked');
    const map2=E.chartMap('bar');
    ok('bar→bar/bar/clustered', map2.type==='bar' && map2.barDir==='bar' && map2.barGrouping==='clustered');
    ok('combo 标记', E.chartMap('combo').combo===true);
    // combo 原生导出：addChart([{type,...},...]) 路径，2 系列不应崩溃
    const docC=D.newPresentation('combo');
    const cc=D.newElement('chart',{x:1,y:1,w:6,h:3,chart:{vtype:'combo'}}); D.addElement(docC,0,cc);
    const rmC={}; rmC[cc.id]={kind:'matrix',cats:['1月','2月','3月'],series:[{name:'线',values:[1,2,3]},{name:'柱',values:[4,5,6]}]};
    const bC=await E.exportDoc({PptxGenJS, doc:docC, resolvedMap:rmC});
    ok('combo 原生导出有效 base64', typeof bC==='string' && bC.length>3000);
    ok('donut→doughnut', E.chartMap('donut').type==='doughnut');
    // scatter/bubble 需点数据→非原生(返回 null)
    ok('scatter 非原生(null)', E.chartMap('scatter')===null);
    ok('bubble 非原生(null)', E.chartMap('bubble')===null);
    // bubble 走图片兜底→不应崩溃,exportDoc 仍返回有效 base64
    const doc3=D.newPresentation('bub');
    const c3=D.newElement('chart',{x:1,y:1,w:6,h:3,chart:{vtype:'bubble'}}); D.addElement(doc3,0,c3);
    const rm3={};
    rm3[c3.id]={kind:'matrix',cats:['1月','2月'],series:[{name:'A',values:[1,2]},{name:'B',values:[3,4]}]};
    const b3=await E.exportDoc({PptxGenJS, doc:doc3, resolvedMap:rm3});
    ok('bubble 不崩溃→base64 有效', typeof b3==='string' && b3.length>3000);
  }
  // --- image fallback + slicer skip ---
  {
    const doc3=D.newPresentation('f');
    const wf=D.newElement('chart',{x:1,y:1,w:5,h:3,chart:{vtype:'waterfall', image:'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='}}); D.addElement(doc3,0,wf);
    const tm=D.newElement('chart',{x:1,y:5,w:5,h:2,chart:{vtype:'treemap'}}); D.addElement(doc3,0,tm); // 无 image → 占位
    const sl=D.newElement('chart',{x:7,y:1,w:2,h:2,chart:{vtype:'slicer'}}); D.addElement(doc3,0,sl); // 不导出
    const b=await E.exportDoc({PptxGenJS, doc:doc3, resolvedMap:{}});
    ok('含图片兜底/占位/跳过 导出有效', typeof b==='string' && b.length>2000);
    ok('isNative 判定', E.isNativeChart('column')===true && E.isNativeChart('treemap')===false && E.isNativeChart('slicer')===false);
  }
  // --- A4: 单位缩放/小数格式码/图例就近/系列色/字号 ---
  {
    // 纯映射单测
    ok('legend tr→t (导出位)', E.pptLegendPos('tr')==='t');
    ok('legend tl→t', E.pptLegendPos('tl')==='t');
    ok('legend br→b', E.pptLegendPos('br')==='b');
    ok('legend lc→l', E.pptLegendPos('lc')==='l');
    ok('legend rc→r', E.pptLegendPos('rc')==='r');
    ok('legend none→null', E.pptLegendPos('none')===null);
    ok('unit 缩放系数 w=1e4', E.unitScale('w')===1e4);
    ok('unit W=1e4', E.unitScale('W')===1e4);
    ok('unit k=1e3', E.unitScale('k')===1e3);
    ok('unit m=1e6', E.unitScale('m')===1e6);
    ok('unit Million=1e6', E.unitScale('Million')===1e6);
    ok('unit none=1', E.unitScale('none')===1);
    ok('unit auto=1', E.unitScale('auto')===1);
    // 真实导出：column 带 fmt(colors/unit/legendPos:'tr'/字号/decimals/showLabels) + data(unit:'w')
    const docA=D.newPresentation('a4');
    const cA=D.newElement('chart',{x:1,y:1,w:6,h:3,chart:{vtype:'column',fmt:{unit:'w',legendPos:'tr',decimals:1,colors:['FF0000','00FF00'],labelFontSize:8,catFontSize:11,valFontSize:12,showLabels:true}}}); D.addElement(docA,0,cA);
    const dA=D.newElement('data',{x:1,y:5,w:2,h:1,style:{unit:'w',decimals:2}}); D.addElement(docA,0,dA);
    const rmA={};
    rmA[cA.id]={kind:'matrix',cats:['1月','2月','3月'],series:[{name:'A',values:[10000,20000,30000]},{name:'B',values:[40000,50000,60000]}]};
    rmA[dA.id]={kind:'value',value:142000,yoy:0.48};
    const bA=await E.exportDoc({PptxGenJS, doc:docA, resolvedMap:rmA});
    ok('A4 带 fmt 导出有效 base64', typeof bA==='string' && bA.length>3000);
  }
  // --- S3: 堆积原生类 series 反转(对齐预览顶/底),仅当 fmt.stackTopFirst 真 ---
  {
    const rS={cats:['1月','2月'],series:[{name:'A',values:[1,2]},{name:'B',values:[3,4]},{name:'C',values:[5,6]}]};
    // helper: 堆积+flag → 反转
    ok('emitSeriesOrder stackColumn+flag → 反转', JSON.stringify(E.emitSeriesOrder('stackColumn',{stackTopFirst:true},rS))===JSON.stringify(['C','B','A']));
    ok('emitSeriesOrder area+flag → 反转', JSON.stringify(E.emitSeriesOrder('area',{stackTopFirst:true},rS))===JSON.stringify(['C','B','A']));
    ok('emitSeriesOrder stack100Bar+flag → 反转', JSON.stringify(E.emitSeriesOrder('stack100Bar',{stackTopFirst:true},rS))===JSON.stringify(['C','B','A']));
    // 堆积但无 flag → 正序(dashboard 安全)
    ok('emitSeriesOrder stackColumn 无flag → 正序', JSON.stringify(E.emitSeriesOrder('stackColumn',{},rS))===JSON.stringify(['A','B','C']));
    // 非堆积(clustered/line)即使有 flag → 正序
    ok('emitSeriesOrder column+flag → 正序(非堆积)', JSON.stringify(E.emitSeriesOrder('column',{stackTopFirst:true},rS))===JSON.stringify(['A','B','C']));
    ok('emitSeriesOrder line+flag → 正序(非堆积)', JSON.stringify(E.emitSeriesOrder('line',{stackTopFirst:true},rS))===JSON.stringify(['A','B','C']));
    // 真实导出:stackColumn + fmt.stackTopFirst + colors → 仍有效 base64
    const docS=D.newPresentation('s3');
    const cS=D.newElement('chart',{x:1,y:1,w:6,h:3,chart:{vtype:'stackColumn',fmt:{stackTopFirst:true,colors:['FF0000','00FF00','0000FF']}}}); D.addElement(docS,0,cS);
    const rmS={}; rmS[cS.id]={kind:'matrix',cats:['1月','2月'],series:[{name:'A',values:[1,2]},{name:'B',values:[3,4]},{name:'C',values:[5,6]}]};
    const bS=await E.exportDoc({PptxGenJS, doc:docS, resolvedMap:rmS});
    ok('S3 堆积反转导出有效 base64', typeof bS==='string' && bS.length>3000);
  }
  // --- B6: compare/同比 data box → 直接用 resolved.text(预格式化字符串)，单值路径不受影响 ---
  {
    const docB=D.newPresentation('b6');
    // compare data：resolved.text 预格式化(如 '-40.0%')，导出应直接用该文本
    const dCmp=D.newElement('data',{x:1,y:1,w:2,h:1,style:{unit:'万'}}); D.addElement(docB,0,dCmp);
    // 单值 data：mode!=='compare' 仍走 formatNum
    const dVal=D.newElement('data',{x:1,y:3,w:2,h:1,style:{unit:'w',decimals:2}}); D.addElement(docB,0,dVal);
    // 组合：groupId 仅设计期用，导出逐元素无视(应不影响导出)
    D.groupElements(docB,0,[dCmp.id,dVal.id]);
    const rmB={};
    rmB[dCmp.id]={kind:'value', value:-0.4, compare:true, text:'-40.0%'};
    rmB[dVal.id]={kind:'value', value:142000};
    const bB=await E.exportDoc({PptxGenJS, doc:docB, resolvedMap:rmB});
    ok('compare data 文本路径导出有效 base64', typeof bB==='string' && bB.length>2000);
    ok('compare data 含 groupId 不影响导出', docB.slides[0].elements.every(e=>e.groupId) && typeof bB==='string');
  }
  // --- F5: 经营(财经)来源导出 → finance 矩阵(chart) + finance compare(data, pp 文本) 走现有 export 路径 ---
  {
    const docF=D.newPresentation('fin');
    // (a) finance chart：resolvedMap matrix(财经口径)，走原生图 matrix 路径
    const cF=D.newElement('chart',{x:1,y:1,w:6,h:3,chart:{vtype:'column'}}); D.addElement(docF,0,cF);
    // (b) finance compare data：resolved.text 预格式化 '+2.0 pp'(同比，pp 口径)，走 compare 文本路径
    const dF=D.newElement('data',{x:1,y:5,w:2,h:1,style:{unit:'none'}}); D.addElement(docF,0,dF);
    const rmF={};
    rmF[cF.id]={kind:'matrix', cats:['平板','音频'], series:[{name:'净销售收入', values:[300,100]}]};
    rmF[dF.id]={kind:'value', compare:true, text:'+2.0 pp'};
    const bF=await E.exportDoc({PptxGenJS, doc:docF, resolvedMap:rmF});
    ok('F5 finance 矩阵+compare 导出有效 base64', typeof bF==='string' && bF.length>3000);
    ok('F5 导出是 zip(PK 头)', (()=>{const z=Buffer.from(bF,'base64');return z[0]===0x50&&z[1]===0x4B;})());
  }
  // --- WK6: grid 表格导出 → header 灰底加粗 + body 文本单元格,autoPage:false,有效 base64 ---
  {
    const docG=D.newPresentation('grid');
    const tg=D.newElement('table',{x:1,y:1,w:6,h:2}); D.addElement(docG,0,tg);
    const rmG={};
    rmG[tg.id]={kind:'grid', header:['国家','W10'], rows:[['墨西哥','1,234']]};
    const bG=await E.exportDoc({PptxGenJS, doc:docG, resolvedMap:rmG});
    ok('WK6 grid 表格导出有效 base64', typeof bG==='string' && bG.length>2000);
    ok('WK6 grid 导出是 zip(PK 头)', (()=>{const z=Buffer.from(bG,'base64');return z[0]===0x50&&z[1]===0x4B;})());
  }
  console.log(f?('\n'+f+' FAILED'):'\nALL PASS'); process.exit(f?1:0);
})();

const PptFill = require('./pptx-fill.js');
let f=0; const ok=(n,c)=>{console.log((c?'PASS ':'FAIL ')+n); if(!c)f++;};

const slide =
  '<p:spTree>'+
  '<p:sp><p:nvSpPr><p:cNvPr id="3" name="Text 3"/></p:nvSpPr>'+
  '<p:txBody><a:p><a:r><a:t>XX万</a:t></a:r></a:p></p:txBody></p:sp>'+
  '<p:sp><p:nvSpPr><p:cNvPr id="14" name="Text 14"/></p:nvSpPr>'+
  '<p:txBody><a:p><a:r><a:t>分系列SO堆积面积图</a:t></a:r></a:p>'+
  '<a:p><a:r><a:t>点评：XXX</a:t></a:r></a:p></p:txBody></p:sp>'+
  '</p:spTree>';

const out = PptFill.fillTextRuns(slide, [
  {shapeName:'Text 3', tIndex:0, text:'142万'},
  {shapeName:'Text 14', tIndex:1, text:'点评：旗舰拉动明显'}
]);
ok('KPI 值被替换', out.includes('<a:t>142万</a:t>'));
ok('原占位消失', !out.includes('<a:t>XX万</a:t>'));
ok('shape内第2个a:t(点评)被替换', out.includes('<a:t>点评：旗舰拉动明显</a:t>'));
ok('shape内第1个a:t(标题)不动', out.includes('<a:t>分系列SO堆积面积图</a:t>'));

// 未命中 shape 不动 + XML 转义
const out2 = PptFill.fillTextRuns(slide, [{shapeName:'Text 3', tIndex:0, text:'A&B<C'}]);
ok('特殊字符转义', out2.includes('<a:t>A&amp;B&lt;C</a:t>'));

// 带属性的 <p:sp> 也能被处理(例如 useBgFill="1")
const slideAttr =
  '<p:spTree>'+
  '<p:sp useBgFill="1"><p:nvSpPr><p:cNvPr id="9" name="Text 9"/></p:nvSpPr>'+
  '<p:txBody><a:p><a:r><a:t>XX万</a:t></a:r></a:p></p:txBody></p:sp>'+
  '</p:spTree>';
const out3 = PptFill.fillTextRuns(slideAttr, [{shapeName:'Text 9', tIndex:0, text:'88万'}]);
ok('带属性的 p:sp 被替换', out3.includes('<a:t>88万</a:t>'));
ok('带属性的 p:sp 原占位消失', !out3.includes('<a:t>XX万</a:t>'));

// graphicFrame 不被波及(scoping 保证)
const slideGf =
  '<p:spTree>'+
  '<p:graphicFrame><a:t>不要动</a:t></p:graphicFrame>'+
  '<p:sp><p:nvSpPr><p:cNvPr id="5" name="Text 5"/></p:nvSpPr>'+
  '<p:txBody><a:p><a:r><a:t>YY万</a:t></a:r></a:p></p:txBody></p:sp>'+
  '</p:spTree>';
const out4 = PptFill.fillTextRuns(slideGf, [{shapeName:'Text 5', tIndex:0, text:'55万'}]);
ok('graphicFrame 内文本不动', out4.includes('<a:t>不要动</a:t>'));

// --- fillChartXml ---
const chart =
  '<c:chart><c:plotArea><c:areaChart>'+
  '<c:ser><c:idx val="0"/>'+
    '<c:tx><c:strRef><c:f>Sheet1!$B$1</c:f><c:strCache><c:ptCount val="1"/><c:pt idx="0"><c:v>高端</c:v></c:pt></c:strCache></c:strRef></c:tx>'+
    '<c:cat><c:strRef><c:f>Sheet1!$A$2:$A$3</c:f><c:strCache><c:ptCount val="2"/><c:pt idx="0"><c:v>W1</c:v></c:pt><c:pt idx="1"><c:v>W2</c:v></c:pt></c:strCache></c:strRef></c:cat>'+
    '<c:val><c:numRef><c:f>Sheet1!$B$2:$B$3</c:f><c:numCache><c:formatCode>General</c:formatCode><c:ptCount val="2"/><c:pt idx="0"><c:v>14</c:v></c:pt><c:pt idx="1"><c:v>18</c:v></c:pt></c:numCache></c:numRef></c:val>'+
  '</c:ser>'+
  '<c:ser><c:idx val="1"/>'+
    '<c:tx><c:strRef><c:f>Sheet1!$C$1</c:f><c:strCache><c:ptCount val="1"/><c:pt idx="0"><c:v>中端</c:v></c:pt></c:strCache></c:strRef></c:tx>'+
    '<c:cat><c:strRef><c:f>Sheet1!$A$2:$A$3</c:f><c:strCache><c:ptCount val="2"/><c:pt idx="0"><c:v>W1</c:v></c:pt><c:pt idx="1"><c:v>W2</c:v></c:pt></c:strCache></c:strRef></c:cat>'+
    '<c:val><c:numRef><c:f>Sheet1!$C$2:$C$3</c:f><c:numCache><c:ptCount val="2"/><c:pt idx="0"><c:v>1</c:v></c:pt><c:pt idx="1"><c:v>2</c:v></c:pt></c:numCache></c:numRef></c:val>'+
  '</c:ser>'+
  '</c:areaChart></c:plotArea></c:chart>';

const cf = PptFill.fillChartXml(chart, {
  cats:['3月','4月','5月'],
  series:[ {name:'Slate Pro', values:[100,110,120]}, {name:'Slate SE', values:[5,6,7]} ]
});
ok('类别 ptCount 更新为3', (cf.match(/<c:strCache><c:ptCount val="3"\/>/g)||[]).length>=1);
ok('类别值写入', cf.includes('<c:v>3月</c:v>') && cf.includes('<c:v>5月</c:v>'));
ok('系列1 数值写入', cf.includes('<c:v>100</c:v>') && cf.includes('<c:v>120</c:v>'));
ok('系列1 名称改写', cf.includes('<c:v>Slate Pro</c:v>'));
ok('系列2 名称改写', cf.includes('<c:v>Slate SE</c:v>'));
ok('旧占位清除', !cf.includes('<c:v>W1</c:v>') && !cf.includes('<c:v>高端</c:v>'));

// 字面量标题(<c:tx><c:v>OLDNAME</c:v></c:tx>，无 strCache) 不得越界覆盖首个类别缓存值
const chartLit =
  '<c:chart><c:plotArea><c:areaChart>'+
  '<c:ser><c:idx val="0"/>'+
    '<c:tx><c:v>OLDNAME</c:v></c:tx>'+
    '<c:cat><c:strRef><c:f>Sheet1!$A$2</c:f><c:strCache><c:ptCount val="1"/><c:pt idx="0"><c:v>CATVAL</c:v></c:pt></c:strCache></c:strRef></c:cat>'+
    '<c:val><c:numRef><c:f>Sheet1!$B$2</c:f><c:numCache><c:formatCode>General</c:formatCode><c:ptCount val="1"/><c:pt idx="0"><c:v>1</c:v></c:pt></c:numCache></c:numRef></c:val>'+
  '</c:ser>'+
  '</c:areaChart></c:plotArea></c:chart>';
const cfLit = PptFill.fillChartXml(chartLit, { cats:['NEWCAT'], series:[{name:'NEWNAME', values:[5]}] });
ok('字面量标题:类别写入 NEWCAT', cfLit.includes('<c:v>NEWCAT</c:v>'));
ok('字面量标题:首类别未被系列名越界覆盖', !cfLit.includes('<c:v>NEWNAME</c:v>'));
ok('字面量标题:系列名(无strCache)保持不动', cfLit.includes('<c:tx><c:v>OLDNAME</c:v></c:tx>'));

// --- fillEmbeddedXlsx ---
const XLSX = require('xlsx');
const wb0 = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(wb0, XLSX.utils.aoa_to_sheet([['old']]), 'Sheet1');
const bytes0 = new Uint8Array(XLSX.write(wb0, {type:'array', bookType:'xlsx'}));
const outX = PptFill.fillEmbeddedXlsx(XLSX, bytes0, {
  cats:['3月','4月'], series:[{name:'Slate Pro', values:[100,110]}, {name:'Slate SE', values:[5,6]}]
});
const wb1 = XLSX.read(outX, {type:'array'});
const aoa = XLSX.utils.sheet_to_json(wb1.Sheets[wb1.SheetNames[0]], {header:1});
ok('表头含系列名', aoa[0][1]==='Slate Pro' && aoa[0][2]==='Slate SE');
ok('首数据行=类别+值', aoa[1][0]==='3月' && aoa[1][1]===100 && aoa[1][2]===5);
ok('第二数据行', aoa[2][0]==='4月' && aoa[2][1]===110 && aoa[2][2]===6);

// --- fillDeck（合成一个最小 pptx 包）---
const JSZip = require('../lib/jszip.min.js');
(async ()=>{
  const z = new JSZip();
  z.file('ppt/slides/slide4.xml', slide);          // 复用 Task4 的 slide 字符串
  z.file('ppt/charts/chart2.xml', chart);          // 复用 Task5 的 chart 字符串
  z.file('ppt/embeddings/Microsoft_Excel_Worksheet1.xlsx', bytes0); // 复用 Task6 的 xlsx 字节
  const tpl = await z.generateAsync({type:'uint8array'});

  const out = await PptFill.fillDeck({ JSZip, XLSX, templateBytes: tpl, plan: { slides:[{
    slideFile:'ppt/slides/slide4.xml',
    textEdits:[{shapeName:'Text 3', tIndex:0, text:'142万'}],
    charts:[{ chartFile:'ppt/charts/chart2.xml', embedFile:'ppt/embeddings/Microsoft_Excel_Worksheet1.xlsx',
      data:{cats:['3月','4月'], series:[{name:'Slate Pro', values:[100,110]},{name:'Slate SE', values:[5,6]}]} }]
  }]}});

  ok('fillDeck 返回非空字节', out && out.length>200);
  const zb = await JSZip.loadAsync(out);            // 往返可解包=有效
  const s = await zb.file('ppt/slides/slide4.xml').async('string');
  ok('幻灯片文字已填', s.includes('<a:t>142万</a:t>'));
  const c = await zb.file('ppt/charts/chart2.xml').async('string');
  ok('图表缓存已填', c.includes('<c:v>Slate Pro</c:v>') && c.includes('<c:v>100</c:v>'));
  const xb = await zb.file('ppt/embeddings/Microsoft_Excel_Worksheet1.xlsx').async('uint8array');
  const wbk = XLSX.read(xb, {type:'array'});
  const a = XLSX.utils.sheet_to_json(wbk.Sheets[wbk.SheetNames[0]], {header:1});
  ok('内嵌xlsx已同步', a[0][1]==='Slate Pro' && a[1][1]===100);

  // --- extractSlides ---
  {
    const z2 = new JSZip();
    z2.file('ppt/presentation.xml',
      '<p:presentation><p:sldIdLst>'+
      '<p:sldId id="256" r:id="rIdA"/><p:sldId id="257" r:id="rIdB"/><p:sldId id="258" r:id="rIdC"/>'+
      '</p:sldIdLst></p:presentation>');
    z2.file('ppt/_rels/presentation.xml.rels',
      '<Relationships>'+
      '<Relationship Id="rIdA" Type="t/slide" Target="slides/slide1.xml"/>'+
      '<Relationship Id="rIdB" Type="t/slide" Target="slides/slide2.xml"/>'+
      '<Relationship Id="rIdC" Type="t/slide" Target="slides/slide3.xml"/>'+
      '<Relationship Id="rIdM" Type="t/slideMaster" Target="slideMasters/slideMaster1.xml"/>'+
      '</Relationships>');
    z2.file('ppt/slides/slide1.xml','<p:sld>one</p:sld>');
    z2.file('ppt/slides/_rels/slide1.xml.rels','<Relationships/>');
    z2.file('ppt/slides/slide2.xml','<p:sld>two</p:sld>');
    z2.file('ppt/slides/_rels/slide2.xml.rels','<Relationships/>');
    z2.file('ppt/slides/slide3.xml','<p:sld>three</p:sld>');
    const deck = await z2.generateAsync({type:'uint8array'});

    const out = await PptFill.extractSlides({JSZip, bytes:deck, keepSlideNos:[1,3]});
    const zb = await JSZip.loadAsync(out);
    const pres = await zb.file('ppt/presentation.xml').async('string');
    ok('裁后 sldIdLst 含 slide1 的 rId', pres.includes('r:id="rIdA"'));
    ok('裁后 sldIdLst 不含 slide2 的 rId', !pres.includes('r:id="rIdB"'));
    ok('裁后 sldIdLst 含 slide3 的 rId', pres.includes('r:id="rIdC"'));
    const rels = await zb.file('ppt/_rels/presentation.xml.rels').async('string');
    ok('rels 删了 slide2 关系', !rels.includes('slides/slide2.xml'));
    ok('rels 保留 master 关系', rels.includes('slideMaster1.xml'));
    ok('删除了未保留页 slide2.xml', zb.file('ppt/slides/slide2.xml')===null);
    ok('保留了 slide1.xml', zb.file('ppt/slides/slide1.xml')!==null);
    ok('保留页顺序为原 deck 顺序(1 在 3 前)', pres.indexOf('rIdA') < pres.indexOf('rIdC'));
  }

  console.log(f?('\n'+f+' FAILED'):'\nALL PASS'); process.exit(f?1:0);
})();

(function (root, factory){ const a=factory(); if(typeof module!=='undefined'&&module.exports)module.exports=a; if(typeof window!=='undefined')window.PptWeekly=a; })(this, function(){
  const DASH='—';
  function grp(s){ return s.replace(/\B(?=(\d{3})+(?!\d))/g,','); }
  // 千分位整数;null/undefined/NaN → '—'
  function fmtInt(v){
    if(v==null||typeof v==='boolean'||isNaN(v)) return DASH;
    const n=Math.round(Number(v)); const neg=n<0; const s=grp(String(Math.abs(n)));
    return (neg?'-':'')+s;
  }
  // 比率 → ±x%;null/undefined/NaN → '—'
  function fmtPct(v,d){
    if(v==null||typeof v==='boolean'||isNaN(v)) return DASH;
    d=d==null?0:d;
    const p=Number(v)*100; const sign=p<0?'-':'+';
    return sign+Math.abs(p).toFixed(d)+'%';
  }
  // 达成率 → 无符号 x%(负数保留 −;对齐周报邮件里 75%/53% 的写法)
  function fmtPctPlain(v,d){
    if(v==null||typeof v==='boolean'||isNaN(v)) return DASH;
    d=d==null?0:d;
    const p=Number(v)*100;
    return (p<0?'-':'')+Math.abs(p).toFixed(d)+'%';
  }
  // cats 升序月份;首个 value>0 → {month,so};否则 null
  function launchMonthSO(cats,values){
    if(!cats||!values) return null;
    for(let i=0;i<cats.length;i++){ const v=Number(values[i]); if(v>0) return {month:cats[i],so:v}; }
    return null;
  }
  // 毛利率:number<=1 视为比率*100;>1 视为已是百分数;字符串原样
  function fmtGm(v){
    if(v==null||v==='') return DASH;
    if(typeof v==='number'){ if(isNaN(v)) return DASH; return v<=1?`${(v*100).toFixed(0)}%`:`${v}%`; }
    return String(v);
  }

  function reportGrid(rep,groupLabel){
    const wl=(rep&&rep.weekLabels)||[];
    const header=[groupLabel,'26年累计SO','25年同期SO','累计同比',...wl,'WoW%','库存(pcs)','DOS','全流程库存','全流程DOS','国家仓+FDC'];
    const mkRow=(r)=>{
      const wk=(r.weekly||[]).map(fmtInt);
      return [ String(r.key),
        fmtInt(r.cumCur), fmtInt(r.cumPrev), fmtPct(r.yoy),
        ...wk,
        fmtPct(r.wow), fmtInt(r.inv), fmtInt(r.dos),
        r.flowInv==null?DASH:fmtInt(r.flowInv),
        r.flowDos==null?DASH:fmtInt(r.flowDos),
        r.dcfdc==null?DASH:fmtInt(r.dcfdc) ];
    };
    const rows=(rep&&rep.rows||[]).map(mkRow);
    if(rep&&rep.total){ const t=Object.assign({},rep.total); if(t.key==null) t.key='合计'; rows.push(mkRow(t)); }
    return {header,rows};
  }

  function sisoGrid(o){
    o=o||{};
    const version=o.version||''; const nameMap=o.nameMap||{};
    const fc={}; (o.fcRows||[]).forEach(r=>{ fc[r.key]=r; });
    const act={}; (o.actRows||[]).forEach(r=>{ act[r.key]=r; });
    const keys=[]; const seen={};
    (o.fcRows||[]).forEach(r=>{ if(!seen[r.key]){seen[r.key]=1;keys.push(r.key);} });
    (o.actRows||[]).forEach(r=>{ if(!seen[r.key]){seen[r.key]=1;keys.push(r.key);} });
    // 排序:预测SI desc,再 实际SO desc
    keys.sort((a,b)=>{
      const fsi=(fc[b]?fc[b].sellIn||0:0)-(fc[a]?fc[a].sellIn||0:0);
      if(fsi) return fsi;
      return (act[b]?act[b].cumCur||0:0)-(act[a]?act[a].cumCur||0:0);
    });
    const header=['产品型号','传播名',`${version}SI(台)`,`${version}SO(台)`,'SI进展','SO进展','SI达成%','SO达成%','SI GAP'];
    const rows=keys.map(k=>{
      const f=fc[k], a=act[k];
      const fSi=f?f.sellIn:null, fSo=f?f.sellOut:null;
      const aSi=a?a.siCur:null, aSo=a?a.cumCur:null;
      const siAch=(f&&f.sellIn>0&&a!=null&&a.siCur!=null)?a.siCur/f.sellIn:null;
      const soAch=(f&&f.sellOut>0&&a!=null&&a.cumCur!=null)?a.cumCur/f.sellOut:null;
      const gap=(f&&a&&f.sellIn!=null&&a.siCur!=null)?(f.sellIn-a.siCur):null;
      return [ String(k), nameMap[k]||DASH,
        fSi==null?DASH:fmtInt(fSi), fSo==null?DASH:fmtInt(fSo),
        aSi==null?DASH:fmtInt(aSi), aSo==null?DASH:fmtInt(aSo),
        fmtPctPlain(siAch), fmtPctPlain(soAch),
        gap==null?DASH:fmtInt(gap) ];
    });
    return {header,rows};
  }

  function launchGrid(launchRows,soLookup,pById){
    launchRows=launchRows||[]; soLookup=soLookup||{}; pById=pById||{};
    const header=['国家','预售时间','线上首销','线下首销','整体首销','实际认购(首销月SO)','首销名义台数','达成率'];
    const prods={}; launchRows.forEach(r=>{ prods[r.productId]=1; });
    const multi=Object.keys(prods).length>1;
    const sorted=launchRows.slice().sort((a,b)=>{
      const pa=String(a.productId||''), pb=String(b.productId||'');
      if(pa!==pb) return pa<pb?-1:1;
      const ca=String(a.country||''), cb=String(b.country||'');
      return ca<cb?-1:(ca>cb?1:0);
    });
    const rows=sorted.map(r=>{
      const so=soLookup[`${r.productId}|${r.country}`];
      const soVal=so&&so.so!=null?so.so:null;
      const ach=(soVal!=null&&r.firstTarget>0)?soVal/r.firstTarget:null;
      const nm=(pById[r.productId]||{}).name||'';
      const country=multi?`${nm}·${r.country}`:String(r.country||'');
      return [ country, r.presaleDate||'', r.onlineDate||'', r.offlineDate||'', r.overallDate||'',
        soVal==null?DASH:fmtInt(soVal), (r.firstTarget>0)?fmtInt(r.firstTarget):DASH, fmtPctPlain(ach) ];
    });
    return {header,rows};
  }

  function battleGrid(battleJoin){
    battleJoin=battleJoin||[];
    const header=['国家','RRP(本币)','首销Offer','竞品对标','首销毛利率','首销名义(台)','生命周期目标(台)','预售&首销','AATP预计','主力渠道'];
    const rows=battleJoin.map(r=>{
      const rivals=(r.rivals||[]).map(x=>`${x.rival} ${fmtInt(x.priceLocal)}`).join(' / ')||DASH;
      const pre=r.presaleDate||'', ov=r.overallDate||'';
      const win=(!pre&&!ov)?DASH:`${pre}→${ov}`;
      return [ String(r.country||''), r.rrpLocal==null?DASH:fmtInt(r.rrpLocal), r.firstOffer||DASH,
        rivals, fmtGm(r.firstGm),
        (r.firstTarget>0)?fmtInt(r.firstTarget):DASH,
        (r.lifecycleTarget>0)?fmtInt(r.lifecycleTarget):DASH,
        win, r.aatpEst||DASH, r.channel||DASH ];
    });
    return {header,rows};
  }

  function samplesGrid(samples,pById){
    samples=samples||[]; pById=pById||{};
    const header=['关联产品','类型','传播名','样机编码','颜色','认证型号','inbox内容','可用时间'];
    const rows=samples.map(s=>[
      (pById[s.productId]||{}).name||DASH, s.type||DASH, s.name||DASH, s.code||DASH,
      s.color||DASH, s.certModel||DASH, s.inbox||DASH, s.shipLate||DASH ]);
    return {header,rows};
  }

  function skuGrid(products){
    products=products||[];
    const header=['产品','SKU名','颜色','EAN','RAM','ROM','芯片','BOM编码'];
    const rows=[];
    products.forEach(p=>{ (p.skus||[]).forEach(s=>{
      rows.push([ p.name||DASH, s.name||DASH, s.color||DASH, s.ean||DASH, s.ram||DASH, s.rom||DASH, s.chip||DASH, s.bom||DASH ]);
    }); });
    return {header,rows};
  }

  function accGrid(products){
    products=products||[];
    const header=['产品','配件类型','认证型号','传播名','内部代号','颜色','关联SKU'];
    const rows=[];
    products.forEach(p=>{ const acc=p.accessories||{}; Object.keys(acc).forEach(t=>{ const a=acc[t]; if(!a) return;
      // 关联SKU:新格式 skuRefs 数组(多选)优先,旧单值 skuRef 兼容
      const skuTxt=(Array.isArray(a.skuRefs)&&a.skuRefs.length)?a.skuRefs.join('、'):(a.skuRef||DASH);
      rows.push([ p.name||DASH, t, a.certModel||DASH, a.name||DASH, a.internalCode||DASH, a.color||DASH, skuTxt ]);
    }); });
    return {header,rows};
  }

  return { fmtInt, fmtPct, fmtPctPlain, launchMonthSO, reportGrid, sisoGrid, launchGrid, battleGrid, samplesGrid, skuGrid, accGrid };
});

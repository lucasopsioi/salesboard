(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.PptBind = api;
})(this, function () {
  async function resolveTotal(api, b) {
    b = b || {};
    const r = await Promise.resolve(api.report({ groupDim: b.groupDim || 'line', filters: b.filters || {} }));
    const t = (r && r.total) || {};
    return { value: t.cumCur || 0, yoy: (t.yoy == null ? null : t.yoy) };
  }
  async function resolveMatrix(api, b) {
    b = b || {};
    const r = await Promise.resolve(api.agg({
      measure: b.measure || 'sellOut', agg: b.agg,
      cat: { field: b.catField || 'period', gran: b.catGran || 'month' },
      legend: b.legend, filters: b.filters || {}
    }));
    let cats = (r && r.cats) || [];
    const lastN = b.lastN || cats.length;
    cats = cats.slice(Math.max(0, cats.length - lastN));
    const names = (r && r.series) || [];
    const data = (r && r.data) || {};
    const series = names.map(nm => ({
      name: nm, values: cats.map(c => (data[nm] && data[nm][c]) || 0)
    }));
    return { cats, series };
  }
  async function resolveIdcMatrix(api, b) {
    b = b || {};
    const r = await Promise.resolve(api.agg({
      dataset: 'idc', measure: b.measure || 'units', agg: b.agg,
      cat: { field: b.catField }, legend: b.legend, filters: b.filters || {}
    }));
    let cats = (r && r.cats) || [];
    const lastN = b.lastN || cats.length;
    cats = cats.slice(Math.max(0, cats.length - lastN));
    const names = (r && r.series) || [];
    const data = (r && r.data) || {};
    let series = names.map(nm => ({ name: nm, values: cats.map(c => (data[nm] && data[nm][c]) || 0) }));
    if (b.share) {
      cats.forEach((c, i) => {
        let tot = 0; series.forEach(s => tot += s.values[i]);
        if (tot > 0) series.forEach(s => s.values[i] = +(s.values[i] * 100 / tot).toFixed(2));
      });
    }
    return { cats, series };
  }
  const FIN_MEASURE_LABEL={rev:'净销售收入',gm:'销毛额',cp:'贡献利润',gmr:'销毛率',nsip:'NSIP',sellIn:'Sell-in量',sellOut:'Sell-out量',bpAttain:'BP达成率',fcAttain:'预测达成率'};
  const FIN_FMT_DEFAULT={rev:'pct',gm:'pct',cp:'pct',sellIn:'pct',sellOut:'pct',gmr:'pp',bpAttain:'pp',fcAttain:'pp',nsip:'abs'};
  const DEFAULT_FINUNITS={actual:'USD',forecast:'MUSD',bp:'USD'};
  function _finParams(b, rowDim){ const fl=b.filters||{};
    return { rowDim:rowDim, metrics:[b.measure||'rev'], basis:b.basis||'actual',
      year:b.year, fromM:b.fromM, toM:b.toM, version:b.version, bpVersion:b.bpVersion,
      reps:fl.rep, lv1:fl.lv1, lv2:fl.lv2, lv3:fl.lv3, lv4:fl.lv4,
      finUnits:b.finUnits||DEFAULT_FINUNITS }; }
  async function resolveFinanceMatrix(api, b){
    const measure=b.measure||'rev';
    const r=await Promise.resolve(api.financeCustom(_finParams(b, b.catField||'rep')));
    const rows=(r&&r.rows)||[];
    return { cats: rows.map(x=>x.key),
      series:[{ name: FIN_MEASURE_LABEL[measure]||measure, values: rows.map(x=> (x[measure]==null?0:+x[measure])) }] };
  }
  async function resolveFinanceTotal(api, b){
    const measure=b.measure||'rev';
    const r=await Promise.resolve(api.financeCustom(_finParams(b, 'rep')));
    const t=(r&&r.total)||{}; return t[measure]==null?null:+t[measure];
  }
  function comparePeriodsForPreset(preset, ctx){
    const y=ctx.curYear||0; const f=Math.max(1,Math.min(12,ctx.fromM||1)); const t=Math.max(f,Math.min(12,ctx.toM||f));
    if(preset==='mom'){ const b={year:y,fromM:t,toM:t}; const pm=t-1;
      return { a: pm>=1?{year:y,fromM:pm,toM:pm}:{year:y-1,fromM:12,toM:12}, b }; }
    if(preset==='qoq'){ const L=t-f+1; const b={year:y,fromM:f,toM:t}; const aFrom=f-L, aTo=f-1; let a;
      if(aTo>=1&&aFrom>=1) a={year:y,fromM:aFrom,toM:aTo};
      else if(aTo<1) a={year:y-1,fromM:aFrom+12,toM:aTo+12};
      else a={year:y-1,fromM:13-L,toM:12};
      return {a,b}; }
    return { a:{year:y-1,fromM:f,toM:t}, b:{year:y,fromM:f,toM:t} };  // yoy
  }
  return { resolveTotal, resolveMatrix, resolveIdcMatrix,
    resolveFinanceMatrix, resolveFinanceTotal, comparePeriodsForPreset,
    FIN_MEASURE_LABEL, FIN_FMT_DEFAULT };
});

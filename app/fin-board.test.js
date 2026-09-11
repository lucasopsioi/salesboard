// app/fin-board.test.js
// TDD for engine financeProductBoard: 产业产品经营看板 (4 tables).
//   line   -> group by lv1 (产业): 平板 / 音频与智能配件
//   famTablet/famAudio -> group by lv3 (产品系列), restricted to lv1=平板 / 音频
//   lv4    -> group by lv4 (产品)
// 每行: {key, rev25,rev26,revYoy, gm25,gm26,gmYoy, gmr25,gmr26, nsip25,nsip26, bp,bpAttain, fc,fcAttain}
//   rev/gm/gmr/nsip/fc 口径同 financeAchieve；bp=全年BP收入(src2,BP版本)、fc=全年预测收入(src1,选定版本)。
const os=require('os'),fs=require('fs'),path=require('path');
const {Engine}=require('../engine-core'); require('../engine-finance');
let f=0; const ok=(n,c,d)=>{console.log((c?'PASS':'FAIL')+' '+n+(c?'':' :: '+JSON.stringify(d))); if(!c)f++;};
const near=(a,b,e=1e-4)=>a!=null&&b!=null&&Math.abs(a-b)<=Math.max(e,Math.abs(b)*1e-4);

const e=new Engine(fs.mkdtempSync(path.join(os.tmpdir(),'board-')));
e.loadSample();
ok('hasFin', e.hasFin);

const b=e.financeProductBoard({year:2026,fromM:1,toM:6,finUnits:{actual:'USD',forecast:'MUSD',bp:'MUSD'}});
ok('result not null', !!b);

// ---- structure ----
ok('line present', !!(b&&b.line&&Array.isArray(b.line.rows)&&b.line.total), b&&b.line);
ok('line.rows non-empty', b&&b.line.rows.length>0, b&&b.line.rows.length);
ok('famTablet present', !!(b&&b.famTablet&&Array.isArray(b.famTablet.rows)&&b.famTablet.total), b&&b.famTablet);
ok('famAudio present', !!(b&&b.famAudio&&Array.isArray(b.famAudio.rows)&&b.famAudio.total), b&&b.famAudio);
ok('lv4 present', !!(b&&b.lv4&&Array.isArray(b.lv4.rows)&&b.lv4.total), b&&b.lv4);
ok('cols present (array)', !!(b&&Array.isArray(b.cols)&&b.cols.length>0), b&&b.cols);
ok('cols entries have key+label', b&&b.cols.every(c=>c&&c.key&&'label'in c), b&&b.cols);

// ---- line: group by lv1 (产业) ----
const lineKeys=(b.line.rows||[]).map(r=>r.key);
ok('line has 平板', lineKeys.includes('平板'), lineKeys);
ok('line has 音频与智能配件', lineKeys.includes('音频与智能配件'), lineKeys);

// ---- famTablet: lv3 families under 平板 ----
const tabKeys=(b.famTablet.rows||[]).map(r=>r.key);
ok('famTablet includes Series P(示例已脱敏为虚构系列名)', tabKeys.includes('Series P'), tabKeys);
ok('famTablet 不含 音频系列(Series T1)', !tabKeys.includes('Series T1'), tabKeys);

// ---- famAudio: lv3 families under 音频 ----
const audKeys=(b.famAudio.rows||[]).map(r=>r.key);
ok('famAudio includes Series T1', audKeys.includes('Series T1'), audKeys);
ok('famAudio 不含 平板系列(Series P)', !audKeys.includes('Series P'), audKeys);

// ---- per-row relationships (pick 平板 line row) ----
const tab=(b.line.rows||[]).find(r=>r.key==='平板');
ok('平板 row found', !!tab, lineKeys);
ok('平板 rev26>0', tab&&tab.rev26>0, tab&&tab.rev26);
ok('平板 revYoy=(rev26-rev25)/rev25', tab&&tab.rev25>0&&near(tab.revYoy,(tab.rev26-tab.rev25)/tab.rev25), tab&&{yoy:tab.revYoy,exp:tab&&(tab.rev26-tab.rev25)/tab.rev25});
ok('平板 gmYoy=(gm26-gm25)/gm25', tab&&tab.gm25>0&&near(tab.gmYoy,(tab.gm26-tab.gm25)/tab.gm25), tab&&{yoy:tab.gmYoy});
ok('平板 gmr26=gm26/rev26', tab&&near(tab.gmr26,tab.gm26/tab.rev26), tab&&{gmr26:tab.gmr26,exp:tab&&tab.gm26/tab.rev26});
ok('平板 nsip26>0', tab&&tab.nsip26>0, tab&&tab.nsip26);
ok('平板 bp>0', tab&&tab.bp>0, tab&&tab.bp);
ok('平板 fc>0', tab&&tab.fc>0, tab&&tab.fc);
ok('平板 bpAttain=rev26/bp', tab&&tab.bp>0&&near(tab.bpAttain,tab.rev26/tab.bp), tab&&{bpAttain:tab.bpAttain,exp:tab&&tab.rev26/tab.bp});
ok('平板 fcAttain=rev26/fc', tab&&tab.fc>0&&near(tab.fcAttain,tab.rev26/tab.fc), tab&&{fcAttain:tab.fcAttain,exp:tab&&tab.rev26/tab.fc});

// ---- subtotal exclusion: total = sum of rows ----
const sumRev26=(b.line.rows||[]).reduce((s,r)=>s+(r.rev26||0),0);
ok('line.total.rev26 = sum(rows.rev26)', near(b.line.total.rev26,sumRev26), {tot:b.line.total.rev26,sum:sumRev26});
const sumBp=(b.line.rows||[]).reduce((s,r)=>s+(r.bp||0),0);
ok('line.total.bp = sum(rows.bp)', near(b.line.total.bp,sumBp), {tot:b.line.total.bp,sum:sumBp});

// ---- total has bp>0 & fc>0 ----
ok('line.total.bp>0', b.line.total.bp>0, b.line.total.bp);
ok('line.total.fc>0', b.line.total.fc>0, b.line.total.fc);
ok('line.total.bpAttain=rev26/bp', near(b.line.total.bpAttain,b.line.total.rev26/b.line.total.bp), {a:b.line.total.bpAttain});
ok('line.total.fcAttain=rev26/fc', near(b.line.total.fcAttain,b.line.total.rev26/b.line.total.fc), {a:b.line.total.fcAttain});

// ---- famTablet.total = sum of famTablet rows; equals 平板 line row rev26 ----
const tabSum=(b.famTablet.rows||[]).reduce((s,r)=>s+(r.rev26||0),0);
ok('famTablet.total.rev26 = sum(rows)', near(b.famTablet.total.rev26,tabSum), {tot:b.famTablet.total.rev26,sum:tabSum});
ok('famTablet.total.rev26 = 平板 line row rev26', tab&&near(b.famTablet.total.rev26,tab.rev26), {fam:b.famTablet.total.rev26,line:tab&&tab.rev26});

// ---- filter linkage: lv1=['平板'] reduces line to tablet only ----
const bTab=e.financeProductBoard({year:2026,fromM:1,toM:6,lv1:['平板'],finUnits:{actual:'USD',forecast:'MUSD',bp:'MUSD'}});
const bTabKeys=(bTab.line.rows||[]).map(r=>r.key);
ok('lv1=平板 过滤后 line 仅含 平板', bTabKeys.length>0&&bTabKeys.every(k=>k==='平板'), bTabKeys);
ok('lv1=平板 过滤后 total.rev26 < 全量 total.rev26', bTab.line.total.rev26>0 && bTab.line.total.rev26 < b.line.total.rev26, {f:bTab.line.total.rev26,all:b.line.total.rev26});

// ============================================================
// financeRepBoard: 国家办维度三表 (repTable / repSeries / lv4) + NSIP同比列
//   repTable -> group by rep (国家办)；repSeries -> group by lv3(产品系列,受 reps 限定)；lv4 -> group by lv4(受 reps 限定)
//   每行同 financeProductBoard PLUS nsipYoy=nsip26-nsip25(绝对USD差,单价同比)
//   参数来自本块独立筛选 {year,fromM,toM,version,reps,series,finUnits}
// ============================================================
const FU={actual:'USD',forecast:'MUSD',bp:'MUSD'};
const rb=e.financeRepBoard({year:2026,fromM:1,toM:6,finUnits:FU});
ok('rep: result not null', !!rb, rb);
ok('rep: repTable present', !!(rb&&rb.repTable&&Array.isArray(rb.repTable.rows)&&rb.repTable.total), rb&&rb.repTable);
ok('rep: repSeries present', !!(rb&&rb.repSeries&&Array.isArray(rb.repSeries.rows)&&rb.repSeries.total), rb&&rb.repSeries);
ok('rep: lv4 present', !!(rb&&rb.lv4&&Array.isArray(rb.lv4.rows)&&rb.lv4.total), rb&&rb.lv4);
ok('rep: cols present (array)', !!(rb&&Array.isArray(rb.cols)&&rb.cols.length>0), rb&&rb.cols);
ok('rep: cols entries have key+label', rb&&rb.cols.every(c=>c&&c.key&&'label'in c), rb&&rb.cols);

// ---- repTable: each row is a 国家办 ----
ok('rep: repTable.rows non-empty', rb&&rb.repTable.rows.length>0, rb&&rb.repTable.rows.length);
const repKeys=(rb.repTable.rows||[]).map(r=>r.key);
ok('rep: repTable rows 都是国家办', repKeys.length>0&&repKeys.every(k=>/国家办/.test(k)), repKeys);
ok('rep: repTable 含演示国家办(含"国家办")', repKeys.some(k=>k.includes('国家办')), repKeys);

// ---- subtotal exclusion: total.rev26 = Σ rows.rev26 ----
const repSumRev26=(rb.repTable.rows||[]).reduce((s,r)=>s+(r.rev26||0),0);
ok('rep: repTable.total.rev26 = Σ rows.rev26', near(rb.repTable.total.rev26,repSumRev26), {tot:rb.repTable.total.rev26,sum:repSumRev26});

// ---- NSIP同比列存在 + 数值正确 ----
ok('rep: cols 含 nsipYoy', rb.cols.some(c=>c.key==='nsipYoy'), rb.cols.map(c=>c.key));
const rRowNs=(rb.repTable.rows||[]).find(r=>r.nsip25>0);
ok('rep: 找到 nsip25>0 的行', !!rRowNs, repKeys);
ok('rep: nsipYoy=nsip26-nsip25(绝对USD差)', rRowNs&&near(rRowNs.nsipYoy,(rRowNs.nsip26-rRowNs.nsip25)), rRowNs&&{yoy:rRowNs.nsipYoy,exp:rRowNs&&(rRowNs.nsip26-rRowNs.nsip25)});

// ---- bpAttain / fcAttain ----
const rRowBp=(rb.repTable.rows||[]).find(r=>r.bp>0&&r.fc>0);
ok('rep: 找到 bp>0&fc>0 的行', !!rRowBp, repKeys);
ok('rep: bpAttain=rev26/bp', rRowBp&&near(rRowBp.bpAttain,rRowBp.rev26/rRowBp.bp), rRowBp&&{a:rRowBp.bpAttain,exp:rRowBp&&rRowBp.rev26/rRowBp.bp});
ok('rep: fcAttain=rev26/fc', rRowBp&&near(rRowBp.fcAttain,rRowBp.rev26/rRowBp.fc), rRowBp&&{a:rRowBp.fcAttain,exp:rRowBp&&rRowBp.rev26/rRowBp.fc});

// ---- reps 过滤 (本块独立筛选) ----
const oneRep=repKeys[0];
const rbF=e.financeRepBoard({year:2026,fromM:1,toM:6,reps:[oneRep],finUnits:FU});
const rbFKeys=(rbF.repTable.rows||[]).map(r=>r.key);
ok('rep: reps 过滤后 repTable 仅含该国家办', rbFKeys.length>0&&rbFKeys.every(k=>k===oneRep), rbFKeys);
ok('rep: reps 过滤后 total.rev26 < 全量 total.rev26', rbF.repTable.total.rev26>0 && rbF.repTable.total.rev26 < rb.repTable.total.rev26, {f:rbF.repTable.total.rev26,all:rb.repTable.total.rev26});

// ---- repSeries rows 是产品系列(lv3)；lv4 present ----
const rSerKeys=(rb.repSeries.rows||[]).map(r=>r.key);
ok('rep: repSeries rows 是产品系列(lv3)', rSerKeys.includes('Series P'), rSerKeys);
ok('rep: lv4.rows present', rb.lv4.rows.length>0, rb.lv4.rows.length);

console.log(f?('\n'+f+' FAILED'):'\nALL PASS'); process.exit(f?1:0);

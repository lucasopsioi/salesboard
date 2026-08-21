/* ============================================================
   Salesboard 数据引擎 (主进程 / Node)
   - 锚定文件夹，扫描 xlsx/csv
   - 透视 PSI 长表 -> 宽记录
   - 列式存储(字典编码 + TypedArray)，百万行低内存
   - 按文件签名增量；每文件透视结果缓存到 userData
   - 合并去重(最新文件优先)，秒开
   ============================================================ */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const XLSX = require('xlsx');
const SNAP = require('./engine-snapshot.js');

const DIM_KEYS = ['region','repOffice','country','channel','family','line','series','product','model'];
const FIELD_SPECS = [
  ['region',   h=>/managementregion|^region$|大区|管理区域/.test(h)],
  ['repOffice',h=>/repoffice|国家办/.test(h)],
  ['country',  h=>/country|国家/.test(h)],
  ['channel',  h=>/onlineoffline|渠道|channel/.test(h)],
  ['family',   h=>/productfamily|产品族|产品lv1/.test(h)],
  ['line',     h=>/productline|产品线|产品lv2/.test(h)],
  ['series',   h=>/productseries|产品系列|产品lv3/.test(h)],
  ['product',  h=>/^product$|^产品$|产品lv4/.test(h)],
  ['model',    h=>/productmodel|产品型号|^型号$/.test(h)],
  ['period',   h=>/periodid|^period$|周期|会计期年月/.test(h)],
  ['psiType',  h=>/psitype|psi类型/.test(h)],
  ['qty',      h=>/^qty$|^数量$|本月实际/.test(h)],
];
const PSI_MAP = {sellin:'sellIn',sellout:'sellOut',inventory:'inv',inv:'inv',dos:'dos'};
// 全流程库龄表字段
const FLOW_SPECS = [
  ['runDate',  h=>/运行日期|运行日|rundate/.test(h)],
  ['family',   h=>/产品族/.test(h)],
  ['series',   h=>/产品系列/.test(h)],
  ['model',    h=>/产品型号|^型号$/.test(h)],
  ['repOffice',h=>/要货国家办|国家办/.test(h)],
  ['country',  h=>/要货国家|国家/.test(h)],
  ['qty',      h=>/库存数量|库存pcs|库存数/.test(h)],
];
const GEO_ORDER  = ['region','repOffice','country'];
const PROD_ORDER = ['family','line','series','product','model'];
const FLOW = {sellOut:1,sellIn:1,inv:0,dos:0};
const MAX_SERIES = 14;
const PREMIUM_RANK = ['旗舰','flagship','开放','open','精品','颈戴','neck','基础','basic','低成本','平板','tablet'];

const norm = s => String(s==null?'':s).trim().toLowerCase().replace(/[\s._\-\/()（）]/g,'');
const isSubtotal = v => /^(总计|合计|小计|总和|total|subtotal|grandtotal|源为空)$/i.test(String(v==null?'':v).trim());
const isAllChannel = v => /^(all|all ?channels?|全部|全渠道|全部渠道|渠道合计|合计|整体|total)$/i.test(String(v==null?'':v).trim());
function toNum(v){ if(v==null||v==='')return 0; if(typeof v==='number')return v;
  const n=Number(String(v).replace(/,/g,'').trim()); return isNaN(n)?0:n; }
function premiumScore(name){ const s=String(name).toLowerCase();
  for(let i=0;i<PREMIUM_RANK.length;i++) if(s.includes(PREMIUM_RANK[i])) return i; return PREMIUM_RANK.length+1; }

function ymdInt(d){ // Date or 'YYYY-MM-DD' -> yyyymmdd int
  if(d==null) return 0;
  if(d instanceof Date) return d.getFullYear()*10000+(d.getMonth()+1)*100+d.getDate();
  const m=String(d).match(/(\d{4})\D(\d{1,2})\D(\d{1,2})/); if(m) return (+m[1])*10000+(+m[2])*100+(+m[3]);
  const m2=String(d).match(/(\d{4})\D(\d{1,2})/); if(m2) return (+m2[1])*10000+(+m2[2])*100+1;
  return 0;
}
function parseDateCell(v){
  if(v==null||v==='') return null;
  if(v instanceof Date) return isNaN(v)?null:v;
  if(typeof v==='number'){ if(v>20000&&v<80000) return new Date(Math.round((v-25569)*86400000)); return null; }
  const s=String(v).trim();
  let m=s.match(/^(\d{4})\D(\d{1,2})\D(\d{1,2})/); if(m) return new Date(+m[1],+m[2]-1,+m[3]);
  m=s.match(/^(\d{4})\D(\d{1,2})$/); if(m) return new Date(+m[1],+m[2]-1,1);
  m=s.match(/^(\d{4})(\d{2})(\d{2})$/); if(m) return new Date(+m[1],+m[2]-1,+m[3]);
  m=s.match(/^(\d{4})(\d{2})$/); if(m) return new Date(+m[1],+m[2]-1,1);
  const d=new Date(s); return isNaN(d)?null:d;
}
function ymdToStr(y){ const a=String(y); return a.slice(0,4)+'-'+a.slice(4,6)+'-'+a.slice(6,8); }
function isoWeekOf(y){
  const Y=Math.floor(y/10000), M=Math.floor((y%10000)/100), D=y%100;
  const dt=new Date(Date.UTC(Y,M-1,D)); const day=dt.getUTCDay()||7; dt.setUTCDate(dt.getUTCDate()+4-day);
  const ys=new Date(Date.UTC(dt.getUTCFullYear(),0,1));
  const wk=Math.ceil((((dt-ys)/86400000)+1)/7);
  return dt.getUTCFullYear()+'-W'+String(wk).padStart(2,'0');
}
function isoYW(y){ // yyyymmdd -> [isoYear, weekNum]
  const Y=Math.floor(y/10000), M=Math.floor((y%10000)/100), D=y%100;
  const dt=new Date(Date.UTC(Y,M-1,D)); const day=dt.getUTCDay()||7; dt.setUTCDate(dt.getUTCDate()+4-day);
  const ys=new Date(Date.UTC(dt.getUTCFullYear(),0,1));
  const wk=Math.ceil((((dt-ys)/86400000)+1)/7);
  return [dt.getUTCFullYear(), wk];
}
// 以该日期所在ISO周的"周四"定归属：返回 {y:周四年, m:周四月, w:ISO周号}
function isoThu(y){
  const Y=Math.floor(y/10000), M=Math.floor((y%10000)/100), D=y%100;
  const dt=new Date(Date.UTC(Y,M-1,D)); const day=dt.getUTCDay()||7; dt.setUTCDate(dt.getUTCDate()+4-day);
  const ys=new Date(Date.UTC(dt.getUTCFullYear(),0,1));
  const wk=Math.ceil((((dt-ys)/86400000)+1)/7);
  return {y:dt.getUTCFullYear(), m:dt.getUTCMonth()+1, w:wk};
}
function bucketOf(y,gran){
  if(gran==='day')  return ymdToStr(y);
  if(gran==='week') return isoWeekOf(y);
  const a=String(y); return a.slice(0,4)+'-'+a.slice(4,6);
}

/* ---------- parse + pivot one file -> compact rows ---------- */
function mapColumns(headers){
  const map={};
  headers.forEach(h=>{ const n=norm(h);
    for(const [k,test] of FIELD_SPECS){ if(map[k]) continue; if(test(n)){ map[k]=h; break; } }
  });
  return map;
}
// compact row: [r0..r8 dims, 9 periodLabel, 10 ymd, 11 sellIn, 12 sellOut, 13 inv, 14 dos]
function splitCSVLine(ln){
  const out=[]; let cur='', q=false;
  for(let i=0;i<ln.length;i++){ const c=ln[i];
    if(q){ if(c==='"'){ if(ln[i+1]==='"'){cur+='"';i++;} else q=false; } else cur+=c; }
    else { if(c==='"') q=true; else if(c===','){ out.push(cur); cur=''; } else cur+=c; }
  }
  out.push(cur); return out;
}
// CSV: stream text, no workbook -> low memory for huge files
function parseCSV(filePath){
  let text=fs.readFileSync(filePath,'utf8'); if(text.charCodeAt(0)===0xFEFF) text=text.slice(1);
  const lines=text.split(/\r?\n/); text=null;
  let hi=0; while(hi<lines.length && !lines[hi].trim()) hi++;
  if(hi>=lines.length) return {rows:[],isPSI:false,dims:[]};
  const header=splitCSVLine(lines[hi]).map(s=>s.trim());
  const cm=mapColumns(header); if(!cm.psiType||!cm.qty) return {rows:[],isPSI:false,dims:[]};
  const dimI=DIM_KEYS.map(k=> cm[k]!=null ? header.indexOf(cm[k]) : -1);
  const iPsi=header.indexOf(cm.psiType), iQty=header.indexOf(cm.qty), iPer=cm.period!=null?header.indexOf(cm.period):-1;
  const map=new Map(); const out=[];
  for(let i=hi+1;i<lines.length;i++){
    const ln=lines[i]; if(!ln) continue;
    const f=splitCSVLine(ln);
    const psiKey=PSI_MAP[norm(f[iPsi])]; if(!psiKey) continue;
    let key=''; const dv=new Array(9);
    for(let c=0;c<9;c++){ let v=dimI[c]<0?'':(f[dimI[c]]==null?'':f[dimI[c]].trim()); dv[c]=v; key+=v+'§'; }
    let ymd=0, plabel='';
    if(iPer>=0){ const d=parseDateCell(f[iPer]); if(d){ymd=ymdInt(d);plabel=ymdToStr(ymd);} else {plabel=f[iPer]==null?'':String(f[iPer]).trim();} }
    key+=plabel;
    let rec=map.get(key);
    if(!rec){ rec=[dv[0],dv[1],dv[2],dv[3],dv[4],dv[5],dv[6],dv[7],dv[8],plabel,ymd,0,0,null,null]; map.set(key,rec); }
    const q=toNum(f[iQty]);
    if(psiKey==='sellIn') rec[11]+=q; else if(psiKey==='sellOut') rec[12]+=q; else if(psiKey==='inv') rec[13]=q; else rec[14]=q;
  }
  for(const rec of map.values()){ if(rec[13]==null)rec[13]=0; if(rec[14]==null)rec[14]=0; out.push(rec); }
  return {rows:out, isPSI:true, dims:DIM_KEYS.filter(k=>cm[k])};
}

// direct cell-address iteration (no intermediate row arrays/objects) -> low memory
// 统一打开选项：跳过 per-cell 格式化字符串副本，省内存
const WB_OPTS={cellDates:true,cellText:false,cellNF:false,cellHTML:false,sheetStubs:false};
// 已用区域护栏：连续这么多空行后停止扫描(防 BI 导出虚胀到上百万空行；阈值足够大不会截断真实数据)
const EMPTY_RUN_MAX=20000;
function openWorkbook(filePath){ return XLSX.readFile(filePath,WB_OPTS); }
function parseFile(filePath,_wb){
  if(/\.csv$/i.test(filePath)) return parseCSV(filePath);
  // cellText/cellNF/cellHTML:false -> skip per-cell formatted-string copies (大幅省内存)
  const wb=_wb||openWorkbook(filePath);
  const out=[]; let colMap=null;
  for(const nm of wb.SheetNames){
    const ws=wb.Sheets[nm]; const ref=ws&&ws['!ref']; if(!ref) continue;
    const range=XLSX.utils.decode_range(ref);
    const hr=range.s.r+1;
    const header=[];
    for(let c=range.s.c;c<=range.e.c;c++){ const cell=ws[XLSX.utils.encode_col(c)+hr]; header.push(cell&&cell.v!=null? String(cell.v) : ''); }
    const cm=mapColumns(header); if(!cm.psiType||!cm.qty) continue;
    colMap=cm;
    const colOf=k=>{ const hi=header.indexOf(cm[k]); return hi<0?-1:range.s.c+hi; };
    const L=c=> c<0?null:XLSX.utils.encode_col(c);   // precompute column letters
    const dimL=DIM_KEYS.map(k=> cm[k]!=null ? L(colOf(k)) : null);
    const lPsi=L(colOf('psiType')), lQty=L(colOf('qty')), lPer=cm.period!=null?L(colOf('period')):null;
    const getL=(letter,rr)=>{ if(!letter)return null; const cell=ws[letter+rr]; return cell?cell.v:null; };
    const map=new Map();
    for(let r=range.s.r+1;r<=range.e.r;r++){
      const rr=r+1;
      const psiKey=PSI_MAP[norm(getL(lPsi,rr))]; if(!psiKey) continue;
      let key=''; const dvals=new Array(9);
      for(let c=0;c<9;c++){ let v=getL(dimL[c],rr); v=v==null?'':String(v).trim(); dvals[c]=v; key+=v+'§'; }
      let ymd=0, plabel='';
      if(lPer){ const d=parseDateCell(getL(lPer,rr)); if(d){ymd=ymdInt(d);plabel=ymdToStr(ymd);} else {const pv=getL(lPer,rr); plabel=pv==null?'':String(pv).trim();} }
      key+=plabel;
      let rec=map.get(key);
      if(!rec){ rec=[dvals[0],dvals[1],dvals[2],dvals[3],dvals[4],dvals[5],dvals[6],dvals[7],dvals[8],plabel,ymd,0,0,null,null]; map.set(key,rec); }
      const q=toNum(getL(lQty,rr));
      if(psiKey==='sellIn') rec[11]+=q;
      else if(psiKey==='sellOut') rec[12]+=q;
      else if(psiKey==='inv') rec[13]=q;
      else rec[14]=q;
    }
    for(const rec of map.values()){ if(rec[13]==null)rec[13]=0; if(rec[14]==null)rec[14]=0; out.push(rec); }
  }
  return {rows:out, isPSI: !!colMap, dims: colMap?DIM_KEYS.filter(k=>colMap[k]):[]};
}

// 全流程库龄表 -> compact rows [model,rep,country,family,series,qty,runYmd]
function flowMap(header){ const cm={}; header.forEach(h=>{const n=norm(h); for(const[k,t]of FLOW_SPECS){if(cm[k])continue; if(t(n)){cm[k]=h;break;}}});
  const hasPsi=header.some(h=>/psitype|psi类型/.test(norm(h))); return {cm,hasPsi}; }
function parseFlow(filePath,_wb){
  if(/\.csv$/i.test(filePath)){
    let text=fs.readFileSync(filePath,'utf8'); if(text.charCodeAt(0)===0xFEFF) text=text.slice(1);
    const lines=text.split(/\r?\n/); let hi=0; while(hi<lines.length&&!lines[hi].trim())hi++;
    if(hi>=lines.length) return {rows:[],isFlow:false};
    const header=splitCSVLine(lines[hi]).map(s=>s.trim());
    const {cm,hasPsi}=flowMap(header); if(hasPsi||!cm.qty||!cm.runDate) return {rows:[],isFlow:false};
    const idx={}; ['model','repOffice','country','family','series','qty','runDate'].forEach(k=>idx[k]=cm[k]!=null?header.indexOf(cm[k]):-1);
    const out=[];
    for(let i=hi+1;i<lines.length;i++){ const ln=lines[i]; if(!ln)continue; const f=splitCSVLine(ln);
      const qv=idx.qty>=0?f[idx.qty]:null; if(qv==null||qv==='')continue;
      const g=k=>idx[k]<0?'':(f[idx[k]]==null?'':String(f[idx[k]]).trim());
      const d=parseDateCell(idx.runDate>=0?f[idx.runDate]:null); const runYmd=d?ymdInt(d):0;
      out.push([g('model'),g('repOffice'),g('country'),g('family'),g('series'),toNum(qv),runYmd]);
    }
    return {rows:out,isFlow:true};
  }
  const wb=_wb||openWorkbook(filePath);
  // 库存底表：只读第一个 Sheet(第一个=CDC+FDC库存成品表；第二个是底表,不读)
  let best=null;
  for(const nm of wb.SheetNames.slice(0,1)){
    const ws=wb.Sheets[nm]; const ref=ws&&ws['!ref']; if(!ref) continue;
    const range=XLSX.utils.decode_range(ref); const hr=range.s.r+1;
    const header=[]; for(let c=range.s.c;c<=range.e.c;c++){const cell=ws[XLSX.utils.encode_col(c)+hr];header.push(cell&&cell.v!=null?String(cell.v):'');}
    const {cm,hasPsi}=flowMap(header); if(hasPsi||!cm.qty||!cm.runDate) continue;
    const Lof=k=>{const i=cm[k]!=null?header.indexOf(cm[k]):-1;return i<0?null:XLSX.utils.encode_col(range.s.c+i);};
    const L={}; ['model','repOffice','country','family','series','qty','runDate'].forEach(k=>L[k]=Lof(k));
    const gv=(k,rr)=>{ if(!L[k])return null; const c=ws[L[k]+rr]; return c?c.v:null; };
    const out=[];
    for(let r=range.s.r+1;r<=range.e.r;r++){ const rr=r+1; const qv=gv('qty',rr); if(qv==null||qv==='')continue;
      const g=k=>{const v=gv(k,rr);return v==null?'':String(v).trim();};
      const d=parseDateCell(gv('runDate',rr)); const runYmd=d?ymdInt(d):0;
      out.push([g('model'),g('repOffice'),g('country'),g('family'),g('series'),toNum(qv),runYmd]);
    }
    if(!best || out.length>best.length) best=out;   // keep the sheet with most rows
  }
  return best? {rows:best,isFlow:true} : {rows:[],isFlow:false};
}

/* ============================================================
   财经表：实际(长表P&L) + 预测(宽表P&L)
   ============================================================ */
const normBrand = b => { const s=String(b==null?'':b).trim(); if(/Acme|acme/i.test(s)) return 'ACME'; if(/其他|common/i.test(s)) return 'COMMON'; return s||'COMMON'; };
// 会计期 -> YYYYMM 整数(兼容 Date / 序列号 / "202201" / "2022年1月" / "2022-01")
function ymToInt(v){
  if(v==null||v==='') return 0;
  if(v instanceof Date) return v.getFullYear()*100+(v.getMonth()+1);
  if(typeof v==='number'){
    if(v>=190001 && v<=999912) return Math.floor(v);                 // 已是 YYYYMM
    if(v>20000 && v<60000){ const d=new Date(Math.round((v-25569)*86400000)); return d.getUTCFullYear()*100+(d.getUTCMonth()+1); } // Excel 序列号
    return 0;
  }
  const s=String(v); const m=s.match(/(\d{4})\D*(\d{1,2})/);          // 2022年1月 / 2022-01 / 2022/1
  if(m){ const mm=+m[2]; if(mm>=1&&mm<=12) return (+m[1])*100+mm; }
  const digits=s.replace(/\D/g,''); return digits.length>=6?(parseInt(digits.slice(0,6),10)||0):0;
}
// 实际长表字段
const ACT_SPECS=[
  ['metric',  h=>/报表项中文名称|报表项名称/.test(h)],
  ['order',   h=>/报表项排序序号|报表项序号/.test(h)],
  ['brand',   h=>/^品牌$/.test(h)],
  ['region',  h=>/大区/.test(h)],
  ['rep',     h=>/国家办/.test(h)],
  ['country', h=>/国家/.test(h)],
  ['lv1',     h=>/产品lv1/.test(h)],
  ['lv2',     h=>/产品lv2/.test(h)],
  ['lv3',     h=>/产品lv3/.test(h)],
  ['lv4',     h=>/产品lv4/.test(h)],
  ['ym',      h=>/会计期年月|会计期/.test(h)],
  ['val',     h=>/本月实际/.test(h)],
];
// 预测宽表维度字段(时间列单独识别)
const FC_SPECS=[
  ['brand',   h=>/^品牌$/.test(h)],
  ['region',  h=>/^大区$/.test(h)],
  ['rep',     h=>/^国家办$/.test(h)],
  ['lv1',     h=>/产品lv1/.test(h)],
  ['lv2',     h=>/产品lv2/.test(h)],
  ['lv3',     h=>/产品lv3/.test(h)],
  ['lv4',     h=>/产品lv4/.test(h)],
  ['model',   h=>/产品型号/.test(h)],
  ['metric',  h=>/^指标名称$/.test(h)],
  ['order',   h=>/指标序号/.test(h)],
  ['unit',    h=>/金额数量单位|单位/.test(h)],
  ['version', h=>/^版本$/.test(h)],
  ['scenario',h=>/预测场景/.test(h)],
  ['attr',    h=>/^attribute$/.test(h)],   // PQ 逆透视后的"日期"列(长表)
  ['value',   h=>/^value$/.test(h)],        // PQ 逆透视后的"值"列(长表)
];
// BP(Business Plan)年度计划长表字段：版本中文名/大区中文名/国家办中文名/产品LV1-4中文名/报表项中文名/月份/值
const BP_SPECS=[
  ['version', h=>/版本中文名/.test(h)],
  ['region',  h=>/大区中文名/.test(h)],
  ['rep',     h=>/国家办中文名/.test(h)],
  ['lv1',     h=>/产品lv1中文名/.test(h)],
  ['lv2',     h=>/产品lv2中文名/.test(h)],
  ['lv3',     h=>/产品lv3中文名/.test(h)],
  ['lv4',     h=>/产品lv4中文名/.test(h)],
  ['metric',  h=>/报表项中文名/.test(h)],
  ['ym',      h=>/^月份$/.test(h)],
  ['val',     h=>/^值$/.test(h)],
];
function mapBy(specs,header){ const cm={}; header.forEach(h=>{const n=norm(h); for(const[k,t]of specs){if(cm[k])continue; if(t(n)){cm[k]=h;break;}}}); return cm; }
const monthCol = h => { const m=String(h).match(/^(\d{4})年(\d{1,2})月$/); return m? (+m[1])*100+(+m[2]) : 0; }; // -> YYYYMM
// 在前若干行里找"表头行"：PQ 输出表(财经实际表/财经预测表)可能不在第1行；同 Sheet 还可能混着 PQ 源底表。
// 只锁定匹配到的列(A–T/A–P 等映射列)，忽略其余源数据列。返回 {range,hr,header,cm,Lof,get}。
function detectFinHeader(ws, specs, isOk, maxScan){
  const ref=ws&&ws['!ref']; if(!ref) return null;
  const range=XLSX.utils.decode_range(ref);
  const end=Math.min(range.s.r+(maxScan||60), range.e.r);
  for(let r=range.s.r; r<=end; r++){
    const hdr=[]; for(let c=range.s.c;c<=range.e.c;c++){ const cell=ws[XLSX.utils.encode_col(c)+(r+1)]; hdr.push(cell&&cell.v!=null?String(cell.v):''); }
    const cm=mapBy(specs,hdr);
    if(isOk(cm,hdr)){
      const Lof=name=>{const i=hdr.indexOf(name); return i<0?null:XLSX.utils.encode_col(range.s.c+i);};
      return {range, hr:r, header:hdr, cm, Lof, get:(letter,rr)=>{ if(!letter)return null; const cell=ws[letter+rr]; return cell?cell.v:null; }};
    }
  }
  return null;
}

/* ============================================================
   轻量 xlsx 流式读取(免依赖)：只读"命名表(ListObject)"的单元格范围，
   绕过 SheetJS 对整张 Sheet 的全量 materialize —— 解决"PQ源底表与成品表同Sheet→爆内存"。
   找不到命名表/任何异常 → 返回 null，调用方回退到 SheetJS。
   ============================================================ */
function _zipEntries(buf){
  let eo=-1; const min=Math.max(0,buf.length-22-65536);
  for(let i=buf.length-22;i>=min;i--){ if(buf.readUInt32LE(i)===0x06054b50){ eo=i; break; } }
  if(eo<0) throw new Error('no-eocd');
  const cnt=buf.readUInt16LE(eo+10), cdOff=buf.readUInt32LE(eo+16);
  if(cdOff===0xFFFFFFFF||cnt===0xFFFF) throw new Error('zip64-unsupported');
  const map={}; let p=cdOff;
  for(let n=0;n<cnt;n++){
    if(buf.readUInt32LE(p)!==0x02014b50) break;
    const method=buf.readUInt16LE(p+10), compSize=buf.readUInt32LE(p+20);
    const nameLen=buf.readUInt16LE(p+28), extraLen=buf.readUInt16LE(p+30), cmtLen=buf.readUInt16LE(p+32);
    const lho=buf.readUInt32LE(p+42);
    map[buf.toString('utf8',p+46,p+46+nameLen)]={method,compSize,lho};
    p+=46+nameLen+extraLen+cmtLen;
  }
  return map;
}
function _inflate(buf,e){
  const lnl=buf.readUInt16LE(e.lho+26), lel=buf.readUInt16LE(e.lho+28);
  const ds=e.lho+30+lnl+lel; const comp=buf.subarray(ds,ds+e.compSize);
  return e.method===0?comp:zlib.inflateRawSync(comp);
}
const _entryStr=(buf,map,name)=> map[name]?_inflate(buf,map[name]).toString('utf8'):null;
function _colToIdx(letters){ let n=0; for(let i=0;i<letters.length;i++) n=n*26+(letters.charCodeAt(i)-64); return n-1; }
function _xmlUnesc(s){ return s.indexOf('&')<0?s:s.replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&apos;/g,"'").replace(/&#x([0-9a-fA-F]+);/g,(_,h)=>String.fromCharCode(parseInt(h,16))).replace(/&#(\d+);/g,(_,d)=>String.fromCharCode(+d)).replace(/&amp;/g,'&'); }
function _parseSST(xml){
  const out=[]; if(!xml) return out;
  const re=/<si>([\s\S]*?)<\/si>/g; let m;
  while((m=re.exec(xml))){ const si=m[1];
    if(si.indexOf('<r>')<0){ const t=si.match(/<t[^>]*>([\s\S]*?)<\/t>/); out.push(t?_xmlUnesc(t[1]):''); }
    else { let s=''; const tr=/<t[^>]*>([\s\S]*?)<\/t>/g, mm=[]; let x; while((x=tr.exec(si))) s+=_xmlUnesc(x[1]); out.push(s); }
  }
  return out;
}
const _decodeRef=ref=>{ const m=String(ref).match(/^([A-Z]+)(\d+)(?::([A-Z]+)(\d+))?$/); if(!m) return null;
  return {c0:_colToIdx(m[1]),r0:+m[2],c1:m[3]?_colToIdx(m[3]):_colToIdx(m[1]),r1:m[4]?+m[4]:+m[2]}; };
// 流式读 worksheet xml 内 [c0..c1]列 × [r0..r1]行 -> 行数组(按列偏移对齐, 缺失为'')
function _readSheetRange(xml, sst, c0, c1, r0, r1){
  const rows=[]; const w=c1-c0+1;
  const rowRe=/<row\b([^>]*)>([\s\S]*?)<\/row>/g; let rm;
  const cellRe=/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
  while((rm=rowRe.exec(xml))){
    const ra=rm[1]; const rim=ra.match(/\br="(\d+)"/); const rIdx=rim?+rim[1]:0;
    if(rIdx<r0) continue; if(rIdx>r1) break;
    const body=rm[2]; const arr=new Array(w).fill(''); cellRe.lastIndex=0; let cm;
    while((cm=cellRe.exec(body))){
      const attr=cm[1]||''; const cref=attr.match(/\br="([A-Z]+)\d+"/); if(!cref) continue;
      const ci=_colToIdx(cref[1]); if(ci<c0||ci>c1) continue;
      const inner=cm[2]||''; const tm=attr.match(/\bt="([^"]+)"/); const t=tm?tm[1]:'n';
      let val='';
      if(t==='s'){ const v=inner.match(/<v>([\s\S]*?)<\/v>/); if(v) val=sst[+v[1]]!=null?sst[+v[1]]:''; }
      else if(t==='inlineStr'){ let s=''; const tr=/<t[^>]*>([\s\S]*?)<\/t>/g; let x; while((x=tr.exec(inner))) s+=_xmlUnesc(x[1]); val=s; }
      else if(t==='str'){ const v=inner.match(/<v>([\s\S]*?)<\/v>/); val=v?_xmlUnesc(v[1]):''; }
      else { const v=inner.match(/<v>([\s\S]*?)<\/v>/); if(v){ const num=+v[1]; val=isNaN(num)?_xmlUnesc(v[1]):num; } }
      arr[ci-c0]=val;
    }
    rows.push(arr);
  }
  return rows;
}
// workbook.xml + rels -> [{name, xml:'xl/worksheets/sheetN.xml'}]
function _workbookSheets(buf,map){
  const wb=_entryStr(buf,map,'xl/workbook.xml'); const rels=_entryStr(buf,map,'xl/_rels/workbook.xml.rels');
  if(!wb||!rels) return [];
  const rid2tgt={}; let rm; const rre=/<Relationship\b[^>]*>/g;
  while((rm=rre.exec(rels))){ const tag=rm[0]; const id=(tag.match(/\bId="([^"]+)"/)||[])[1]; let tgt=(tag.match(/\bTarget="([^"]+)"/)||[])[1]; if(id&&tgt){ tgt=tgt.replace(/^\/?xl\//,'').replace(/^\.\//,''); rid2tgt[id]='xl/'+tgt.replace(/^xl\//,''); } }
  const out=[]; let sm; const sre=/<sheet\b[^>]*>/g;
  while((sm=sre.exec(wb))){ const tag=sm[0]; const name=(tag.match(/\bname="([^"]+)"/)||[])[1]; const rid=(tag.match(/r:id="([^"]+)"/)||[])[1];
    if(name&&rid2tgt[rid]) out.push({name:_xmlUnesc(name), xml:rid2tgt[rid]}); }
  return out;
}
const _sheetDim=xml=>{ const m=xml.match(/<dimension\s+ref="([^"]+)"/); return m?_decodeRef(m[1]):null; };
// 命名表 -> {nameNorm:{sheetXml,ref}}
function _namedTableRanges(buf,map){
  const out={}; const tfiles=Object.keys(map).filter(n=>/^xl\/tables\/table\d+\.xml$/i.test(n)); if(!tfiles.length) return out;
  const relFiles=Object.keys(map).filter(n=>/^xl\/worksheets\/_rels\/sheet\d+\.xml\.rels$/i.test(n));
  for(const tf of tfiles){ const x=_entryStr(buf,map,tf); if(!x) continue;
    const dn=(x.match(/displayName="([^"]+)"/)||x.match(/\bname="([^"]+)"/)||[])[1];
    const ref=(x.match(/\bref="([^"]+)"/)||[])[1]; if(!dn||!ref) continue;
    const base=tf.split('/').pop(); let sheetXml=null;
    for(const rf of relFiles){ const rx=_entryStr(buf,map,rf); if(rx&&rx.indexOf(base)>=0){ const sn=rf.match(/sheet(\d+)\.xml\.rels$/i); if(sn){ sheetXml='xl/worksheets/sheet'+sn[1]+'.xml'; break; } } }
    if(sheetXml) out[norm(dn)]={sheetXml,ref};
  }
  return out;
}
// 取一个财经表 {header,rows,cm}：优先命名表ref；否则逐sheet流式找表头(只读映射到的列范围)。找不到→null
function _getFinTable(buf,map,sst,sheets,tbl,wantNorm,specs,isOk){
  // 1) 命名表
  const t=tbl[wantNorm];
  if(t && map[t.sheetXml]){ const rng=_decodeRef(t.ref);
    if(rng){ const all=_readSheetRange(_entryStr(buf,map,t.sheetXml),sst,rng.c0,rng.c1,rng.r0,rng.r1);
      if(all.length){ const header=all[0].map(v=>v==null?'':String(v)); const cm=mapBy(specs,header); if(isOk(cm,header)) return {header,rows:all.slice(1),cm}; } } }
  // 2) 逐 sheet 扫表头(前60行)，再按映射列范围流式读
  for(const sh of sheets){ if(!map[sh.xml]) continue;
    const xml=_entryStr(buf,map,sh.xml); if(!xml) continue;
    const dim=_sheetDim(xml)||{c0:0,r0:1,c1:120,r1:5000000};
    const head=_readSheetRange(xml,sst,dim.c0,Math.min(dim.c1,dim.c0+250),dim.r0,Math.min(dim.r1,dim.r0+60));
    let hr=-1, header=null, cm=null;
    for(let i=0;i<head.length;i++){ const h=head[i].map(v=>v==null?'':String(v)); const m=mapBy(specs,h); if(isOk(m,h)){ hr=dim.r0+i; header=h; cm=m; break; } }
    if(hr<0) continue;
    const idxs=Object.values(cm).map(name=>header.indexOf(name)).filter(i=>i>=0); if(!idxs.length) continue;
    const cMin=dim.c0+Math.min.apply(null,idxs), cMax=dim.c0+Math.max.apply(null,idxs);
    const all=_readSheetRange(xml,sst,cMin,cMax,hr,dim.r1);
    if(all.length){ const header2=all[0].map(v=>v==null?'':String(v)); const cm2=mapBy(specs,header2); if(isOk(cm2,header2)) return {header:header2,rows:all.slice(1),cm:cm2}; }
  }
  return null;
}
// 优先流式读 财经实际表/财经预测表(命名表或表头扫描)，绕过 SheetJS；都没有→null(回退 SheetJS)
function streamFinanceRows(filePath){
  if(/\.csv$/i.test(filePath)) return null;
  let buf,map; try{ buf=fs.readFileSync(filePath); map=_zipEntries(buf); }catch(e){ return null; }
  let tbl; try{ tbl=_namedTableRanges(buf,map); }catch(e){ return null; }
  const wantA=norm('财经实际表'), wantF=norm('财经预测表');
  const sstXml=_entryStr(buf,map,'xl/sharedStrings.xml');
  // 仅当像"财经文件"才走流式(命名表命中 或 sst里有财经标志)——否则放手给SheetJS(不去白白解压PSI/IDC的大sheet)
  const isFin = (tbl[wantA]||tbl[wantF]) || (sstXml && /报表项中文名称|指标名称|财经实际表|财经预测表|本月实际|版本中文名/.test(sstXml));
  if(!isFin) return null;
  let sst,sheets; try{ sst=_parseSST(sstXml); sheets=_workbookSheets(buf,map); }catch(e){ return null; }
  if(!sheets.length) return null;
  // 用户约定：财经文件只读【第一个Sheet】(PQ成品表)，第二个Sheet是原始底表→完全不解压/不解析
  const sheets1=[sheets[0]]; const firstXml=sheets[0].xml;
  const tbl1={}; for(const k in tbl){ if(tbl[k].sheetXml===firstXml) tbl1[k]=tbl[k]; }
  const out=[];
  // 实际
  try{ const ta=_getFinTable(buf,map,sst,sheets1,tbl1,norm('财经实际表'),ACT_SPECS,cm=>!!(cm.ym&&cm.val&&cm.metric));
    if(ta){ const ci={}; Object.keys(ta.cm).forEach(k=>ci[k]=ta.header.indexOf(ta.cm[k]));
      const g=(row,k)=>{ const j=ci[k]; if(j==null||j<0) return ''; const v=row[j]; return v==null?'':String(v).trim(); };
      let emp=0;
      for(const row of ta.rows){ const metric=g(row,'metric'); if(!metric){ if(++emp>EMPTY_RUN_MAX) break; continue; } emp=0;
        const ym=ymToInt(ci.ym>=0?row[ci.ym]:''); if(!ym) continue;
        out.push(['A',normBrand(g(row,'brand')),g(row,'region'),g(row,'rep'),g(row,'country'),g(row,'lv1'),g(row,'lv2'),g(row,'lv3'),g(row,'lv4'),metric,toNum(g(row,'order')),ym,toNum(ci.val>=0?row[ci.val]:0),'','']); } }
  }catch(e){}
  // 预测(长表 Attribute/Value 或 旧宽表)
  try{ const tf=_getFinTable(buf,map,sst,sheets1,tbl1,norm('财经预测表'),FC_SPECS,(cm,hdr)=>!!cm.metric && ((cm.value&&cm.attr)||hdr.some(h=>monthCol(h)>0)));
    if(tf){ const ci={}; Object.keys(tf.cm).forEach(k=>ci[k]=tf.header.indexOf(tf.cm[k]));
      const g=(row,k)=>{ const j=ci[k]; if(j==null||j<0) return ''; const v=row[j]; return v==null?'':String(v).trim(); };
      const monIdx=(ci.value>=0&&ci.attr>=0)?null:tf.header.map((h,i)=>({i,ym:monthCol(h)})).filter(o=>o.ym>0);
      let emp=0;
      for(const row of tf.rows){ const metric=g(row,'metric'); if(!metric){ if(++emp>EMPTY_RUN_MAX) break; continue; } emp=0;
        const version=g(row,'version')||'默认'; const model=g(row,'model');
        const base=['F',normBrand(g(row,'brand')),g(row,'region'),g(row,'rep'),'',g(row,'lv1'),g(row,'lv2'),g(row,'lv3'),g(row,'lv4'),metric,toNum(g(row,'order'))];
        if(!monIdx){ const ym=ymToInt(row[ci.attr]); if(!ym) continue; out.push(base.concat([ym,toNum(row[ci.value]),version,model])); }
        else { for(const mc of monIdx){ const v=toNum(row[mc.i]); if(v===0) continue; out.push(base.concat([mc.ym,v,version,model])); } }
      } }
  }catch(e){}
  // BP 年度计划(长表 版本中文名/报表项中文名/月份/值)
  try{ const tb=_getFinTable(buf,map,sst,sheets1,tbl1,'__bp__',BP_SPECS,cm=>!!(cm.version&&cm.metric&&cm.ym&&cm.val));
    if(tb){ const ci={}; Object.keys(tb.cm).forEach(k=>ci[k]=tb.header.indexOf(tb.cm[k]));
      const g=(row,k)=>{ const j=ci[k]; if(j==null||j<0) return ''; const v=row[j]; return v==null?'':String(v).trim(); };
      let emp=0;
      for(const row of tb.rows){ const metric=g(row,'metric'); if(!metric){ if(++emp>EMPTY_RUN_MAX) break; continue; } emp=0;
        const ym=ymToInt(row[ci.ym]); if(!ym) continue;
        out.push(['B','',g(row,'region'),g(row,'rep'),'',g(row,'lv1'),g(row,'lv2'),g(row,'lv3'),g(row,'lv4'),metric,0,ym,toNum(row[ci.val]),g(row,'version')||'默认','']);
      } }
  }catch(e){}
  return out.length? out : null;
}
const __finTest={ _zipEntries, _parseSST, _readSheetRange, _workbookSheets, _namedTableRanges, _sheetDim, streamFinanceRows, _entryStr, _decodeRef };

// 读 sheet 的辅助：返回 {header, get(colName,rowNum), startRow, endRow, colLetter}
function sheetReader(ws){
  const ref=ws&&ws['!ref']; if(!ref) return null;
  const range=XLSX.utils.decode_range(ref); const hr=range.s.r+1;
  const header=[]; for(let c=range.s.c;c<=range.e.c;c++){const cell=ws[XLSX.utils.encode_col(c)+hr];header.push(cell&&cell.v!=null?String(cell.v):'');}
  const Lof=name=>{const i=header.indexOf(name); return i<0?null:XLSX.utils.encode_col(range.s.c+i);};
  return {header,range,Lof,get:(letter,rr)=>{ if(!letter)return null; const cell=ws[letter+rr]; return cell?cell.v:null; }};
}

// 实际长表(财经实际表 A–T) -> [src,brand,region,rep,country,lv1,lv2,lv3,lv4,metric,order,ym,val]
function parseActual(filePath,_wb){
  const wb = _wb || (/\.csv$/i.test(filePath) ? XLSX.read(fs.readFileSync(filePath),{type:'buffer',cellDates:true}) : openWorkbook(filePath));
  let any=false; const out=[];
  for(const nm of wb.SheetNames.slice(0,1)){   // 财经只读第一个Sheet(PQ成品表)，不碰第二个Sheet的原始底表
    const ws=wb.Sheets[nm];
    const H=detectFinHeader(ws, ACT_SPECS, cm=>!!(cm.ym&&cm.val&&cm.metric)); if(!H) continue;
    any=true;
    const L={}; Object.keys(H.cm).forEach(k=>L[k]=H.Lof(H.cm[k]));
    const g=(k,rr)=>{const v=H.get(L[k],rr); return v==null?'':String(v).trim();};
    let emp=0;
    for(let r=H.hr+1;r<=H.range.e.r;r++){ const rr=r+1;
      const metric=g('metric',rr); if(!metric){ if(++emp>EMPTY_RUN_MAX) break; continue; } emp=0;
      const ym=ymToInt(H.get(L.ym,rr)); if(!ym) continue;
      const val=toNum(H.get(L.val,rr));
      out.push(['A',normBrand(g('brand',rr)),g('region',rr),g('rep',rr),g('country',rr),g('lv1',rr),g('lv2',rr),g('lv3',rr),g('lv4',rr),metric,toNum(g('order',rr)),ym,val,'','']);
    }
  }
  return {rows:out,isActual:any};
}
// 预测表(财经预测表 A–P)：支持长表(Attribute=日期, Value=值, PQ逆透视后) 与 旧版宽表(YYYY年M月列)
// -> [src,brand,region,rep,country,lv1..4,metric,order,ym,val,version]
function parseForecast(filePath,_wb){
  const wb = _wb || openWorkbook(filePath);
  let any=false; const out=[];
  for(const nm of wb.SheetNames.slice(0,1)){   // 财经只读第一个Sheet(PQ成品表)
    const ws=wb.Sheets[nm];
    const H=detectFinHeader(ws, FC_SPECS, (cm,hdr)=>!!cm.metric && ((cm.value&&cm.attr) || hdr.some(h=>monthCol(h)>0))); if(!H) continue;
    any=true;
    const L={}; Object.keys(H.cm).forEach(k=>L[k]=H.Lof(H.cm[k]));
    const g=(k,rr)=>{const v=H.get(L[k],rr); return v==null?'':String(v).trim();};
    const isLong=!!(L.value && L.attr);
    let emp=0;
    if(isLong){
      for(let r=H.hr+1;r<=H.range.e.r;r++){ const rr=r+1;
        const metric=g('metric',rr); if(!metric){ if(++emp>EMPTY_RUN_MAX) break; continue; } emp=0;
        const ym=ymToInt(H.get(L.attr,rr)); if(!ym) continue;
        const val=toNum(H.get(L.value,rr)); const version=g('version',rr)||'默认';
        out.push(['F',normBrand(g('brand',rr)),g('region',rr),g('rep',rr),'',g('lv1',rr),g('lv2',rr),g('lv3',rr),g('lv4',rr),metric,toNum(g('order',rr)),ym,val,version,g('model',rr)]);
      }
    } else {
      const monL=H.header.map((h,i)=>({i,ym:monthCol(h)})).filter(o=>o.ym>0).map(o=>({ym:o.ym, letter:XLSX.utils.encode_col(H.range.s.c+o.i)}));
      for(let r=H.hr+1;r<=H.range.e.r;r++){ const rr=r+1;
        const metric=g('metric',rr); if(!metric){ if(++emp>EMPTY_RUN_MAX) break; continue; } emp=0;
        const base=['F',normBrand(g('brand',rr)),g('region',rr),g('rep',rr),'',g('lv1',rr),g('lv2',rr),g('lv3',rr),g('lv4',rr),metric,toNum(g('order',rr))];
        const version=g('version',rr)||'默认'; const model=g('model',rr);
        for(const mc of monL){ const v=toNum(H.get(mc.letter,rr)); if(v===0) continue; out.push(base.concat([mc.ym, v, version, model])); }
      }
    }
  }
  return {rows:out,isForecast:any};
}
// BP 年度计划表(只读第一个Sheet) -> src='B' 记录 [B,brand'',region,rep,country'',lv1..4,metric,order0,ym,val,version]
function parseBP(filePath,_wb){
  const wb = _wb || openWorkbook(filePath);
  let any=false; const out=[];
  for(const nm of wb.SheetNames.slice(0,1)){
    const ws=wb.Sheets[nm];
    const H=detectFinHeader(ws, BP_SPECS, cm=>!!(cm.version&&cm.metric&&cm.ym&&cm.val)); if(!H) continue;
    any=true;
    const L={}; Object.keys(H.cm).forEach(k=>L[k]=H.Lof(H.cm[k]));
    const g=(k,rr)=>{const v=H.get(L[k],rr); return v==null?'':String(v).trim();};
    let emp=0;
    for(let r=H.hr+1;r<=H.range.e.r;r++){ const rr=r+1;
      const metric=g('metric',rr); if(!metric){ if(++emp>EMPTY_RUN_MAX) break; continue; } emp=0;
      const ym=ymToInt(H.get(L.ym,rr)); if(!ym) continue;
      out.push(['B','',g('region',rr),g('rep',rr),'',g('lv1',rr),g('lv2',rr),g('lv3',rr),g('lv4',rr),metric,0,ym,toNum(H.get(L.val,rr)),g('version',rr)||'默认','']);
    }
  }
  return {rows:out,isBP:any};
}

/* ============================================================
   IDC 市场底表（平板 + 音频/TWS&OWS）→ 统一列式存储
   ============================================================ */
// 统一维度键(顺序固定，记录数组前缀)；末尾两个度量 units,value
const IDC_DIM_KEYS=['cat','year','quarter','region','country','brand','brandGrp','model','form','segment','owsCerti','openEar','screen','ram','storage','gen','priceBand','pbStd','pbHQ','pbBR'];
// 平板表头映射(key -> 匹配原始表头的正则)
const IDC_TAB_MAP={ year:/^YEAR$/i, quarter:/^QUARTER$/i, region:/ACME_SUB_REGION/i, country:/^ACME_COUNTRY$/i,
  segment:/^SEGMENT$/i, form:/^PRODUCT$/i, priceBand:/^PRICE_?BAND$/i, pbStd:/^New[-\s]?PriceBand$/i,
  pbBR:/New[-\s]?BR[-\s]?Priceband/i, pbHQ:/New[-\s]?PriceBand\s*HQ/i, screen:/SCREEN_?SIZE/i,
  brand:/^BRAND$/i, brandGrp:/New[-\s]?Brand\s*Filter/i, model:/^MODEL_?NAME$/i,
  ram:/^RAM_?GB$/i, storage:/^STORAGE_?GB$/i, gen:/^GENERATION$/i, units:/^UNITS$/i, value:/^VALUE_?USD_?M$/i };
// 音频表头映射
const IDC_AUD_MAP={ year:/^YEAR$/i, quarter:/^QUARTER$/i, region:/ACME_SUB_REGION/i, country:/^ACME_COUNTRY$/i,
  form:/PRODUCT_?DETAIL/i, openEar:/^OPEN_?EAR$/i, owsCerti:/OWS\s*certi/i, brand:/^BRAND$/i, model:/^MODEL_?NAME$/i,
  priceBand:/^PRICE_?BAND$/i, units:/^UNITS$/i, value:/^VALUE_?USD_?M$/i, brandGrp:/^自定义$/, pbStd:/^PriceBand\s*1$/i };
function parseIdc(filePath,_wb){
  const wb = _wb || (/\.csv$/i.test(filePath)? XLSX.read(fs.readFileSync(filePath),{type:'buffer',cellDates:true}) : openWorkbook(filePath));
  let any=false; const out=[];
  for(const nm of wb.SheetNames){
    const ws=wb.Sheets[nm]; const R=sheetReader(ws); if(!R) continue;
    const H=R.header.map(h=>String(h==null?'':h).trim());
    const has=re=>H.some(h=>re.test(h));
    const isTab = has(/SCREEN_?SIZE/i) && has(/^UNITS$/i) && has(/^PRODUCT$/i);
    const isAud = (has(/PRODUCT_?DETAIL/i)||has(/OWS\s*certi/i)) && has(/^UNITS$/i);
    if(!isTab && !isAud) continue;
    const map = isTab?IDC_TAB_MAP:IDC_AUD_MAP, cat=isTab?'平板':'音频';
    const L={}; for(const k in map){ let letter=null; for(let i=0;i<H.length;i++){ if(map[k].test(H[i])){ letter=XLSX.utils.encode_col(R.range.s.c+i); break; } } L[k]=letter; }
    if(!L.units){ continue; }
    any=true;
    const g=(k,rr)=>{ if(!L[k]) return ''; const v=R.get(L[k],rr); return v==null?'':String(v).trim(); };
    const gn=(k,rr)=>{ if(!L[k]) return 0; return toNum(R.get(L[k],rr)); };
    let emp=0;
    for(let r=R.range.s.r+1;r<=R.range.e.r;r++){ const rr=r+1;
      const units=gn('units',rr), value=gn('value',rr); const yr=g('year',rr);
      if(!yr && units===0 && value===0){ if(++emp>EMPTY_RUN_MAX) break; continue; } emp=0;
      // 统一记录(按 IDC_DIM_KEYS 顺序) + units + value
      out.push([ cat, yr, g('quarter',rr), g('region',rr), g('country',rr), g('brand',rr), g('brandGrp',rr),
        g('model',rr), g('form',rr), g('segment',rr), g('owsCerti',rr), g('openEar',rr), g('screen',rr),
        g('ram',rr), g('storage',rr), g('gen',rr), g('priceBand',rr), g('pbStd',rr), g('pbHQ',rr), g('pbBR',rr),
        units, value ]);
    }
  }
  return {rows:out,isIdc:any};
}

/* ---------- multi-select filter helpers ---------- */
function asArr(v){ if(v==null||v==='') return []; return Array.isArray(v)? v.filter(x=>x!=null&&x!=='') : [v]; }
function hasFilterVal(filters,k){ return asArr(filters&&filters[k]).length>0; }
// returns {fl:[[codeArray,Set<code>]...], invalid} ; invalid=true if a selected value is absent (=> empty result)
function buildFilters(s, filters, skipDim){
  const fl=[]; let invalid=false;
  for(const k of Object.keys(filters||{})){
    if(k===skipDim) continue;
    if(k==='channel' && skipDim==='channel') continue;
    const vals=asArr(filters[k]); if(!vals.length) continue;
    const idx=s.dimIndex[k]; if(!idx){ continue; }
    const codes=new Set(); vals.forEach(v=>{ const c=idx.get(v); if(c!==undefined) codes.add(c); });
    if(!codes.size){ invalid=true; }
    fl.push([s.dimCode[k], codes]);
  }
  return {fl, invalid};
}
// codes allowed as series for the breakdown dim (null = all)
function seriesAllowedSet(s, filters, seriesDim){
  const vals=asArr(filters&&filters[seriesDim]); if(!vals.length) return null;
  const set=new Set(); const idx=s.dimIndex[seriesDim];
  if(idx) vals.forEach(v=>{ const c=idx.get(v); if(c!==undefined) set.add(c); });
  return set;
}

/* ============================================================
   ENGINE
   ============================================================ */
class Engine {
  constructor(userDir){
    this.dir=userDir;
    this.cacheDir=path.join(userDir,'cache');
    this.configPath=path.join(userDir,'config.json');
    try{ fs.mkdirSync(this.cacheDir,{recursive:true}); }catch(e){}
    this.config=this._loadConfig();
    this.store=null;      // columnar
    this.dims=[];
    this.files=[];        // [{name,path,mtime,size,rows}]
    // 性能记忆化(2026-07-11):每次切板 renderDataBar→sourcesInfo() 会对 6 个源文件夹最新文件反复解析,
    // 大财经表 5s+/次。按 (folder,path,mtime,size) 缓存结果;文件变了键自然失效(旧条目替换,只留当前键→不涨内存)。
    this._srcInfoMemo=new Map();   // folder → {sig, info}      (sourcesInfo/_sourceInfoOne)
    this._srcAoaMemo=new Map();    // folder → {sig, result}    (_newestSourceAoa,ship/cost;含 aoa)
  }
  _loadConfig(){ try{ return JSON.parse(fs.readFileSync(this.configPath,'utf8')); }catch(e){ return {folder:null}; } }
  _saveConfig(){ try{ fs.writeFileSync(this.configPath,JSON.stringify(this.config)); }catch(e){} }
  _cacheFile(fp){ return path.join(this.cacheDir, crypto.createHash('md5').update(fp).digest('hex')+'.json'); }

  setFolder(folder){ this.config.folder=folder; this._saveConfig(); }
  getFolder(){ return this.config.folder; }
  setInvFolder(folder){ this.config.invFolder=folder; this._saveConfig(); }
  getInvFolder(){ return this.config.invFolder; }
  setFinFolder(folder){ this.config.finFolder=folder; this._saveConfig(); }
  getFinFolder(){ return this.config.finFolder; }
  setIdcFolder(folder){ this.config.idcFolder=folder; this._saveConfig(); }
  getIdcFolder(){ return this.config.idcFolder; }
  setShipFolder(folder){ this.config.shipFolder=folder; this._saveConfig(); }
  getShipFolder(){ return this.config.shipFolder; }
  setCostFolder(folder){ this.config.costFolder=folder; this._saveConfig(); }
  getCostFolder(){ return this.config.costFolder; }
  // 读某文件夹内 mtime 最新的 xlsx 首 sheet → AOA（供库存/销毛看板渲染端解析；不进 store）。
  // P2 记忆化:同文件(path,mtime,size)只解析一次;sosimSource/库存/销毛/refresh 消费端共享。文件变了键变→旧条目替换。
  _newestSourceAoa(folder){
    if(!folder) return null;
    const files=this.scanFolder(folder);
    if(!files.length) return null;
    const newest=files.reduce((a,b)=>b.mtime>a.mtime?b:a);
    const sig=newest.path+'|'+newest.mtime+'|'+newest.size;
    const hit=this._srcAoaMemo.get(folder);
    if(hit && hit.sig===sig) return hit.result;
    let result;
    try{
      // 读法对齐原文件选择框 _invReadFileAoa:不带 cellDates(日期=Excel序列数字,非Date对象)+ raw:true,
      // 否则 ShipmentBase/CostBase 的 ymdOf/ymOf 认不出 Date对象,整表被解析为空。
      const wb=XLSX.readFile(newest.path);
      const aoa=XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]],{header:1,raw:true});
      result={name:newest.name, mtime:newest.mtime, aoa};
    }catch(e){ result={name:newest.name, mtime:newest.mtime, aoa:null, error:String(e&&e.message||e)}; }
    this._srcAoaMemo.set(folder,{sig, result});   // 只留当前键(同 folder 旧条目被替换→不无限增长)
    return result;
  }
  // 发货表/成本表 两个持久化文件夹源各自的最新文件 AOA。
  sosimSource(){ return { ship:this._newestSourceAoa(this.config.shipFolder), cost:this._newestSourceAoa(this.config.costFolder) }; }

  // 单个源文件夹：取 mtime 最新文件 → {folder,file,mtime,rows,header,preview}（纯读，供数据源面板展示）。
  // P0-A 记忆化:同文件(path,mtime,size)命中缓存直接返回,不重解析(消灭切板 5s+)。
  // P0-B 限行读:未命中时照 fileSchema 的 {sheetRows:8} 只读表头+前 3 行预览,不再对 20MB+ 财经表全量 sheet_to_json。
  // rows 语义:该文件已被主 refresh 解析过(在 this.files 里,fi.rows 现成)→ 用它;ship/cost 用 _newestSourceAoa 记忆化 aoa 行数;都没有 → null(渲染端显 '—')。
  _sourceInfoOne(folder){
    if(!folder) return null;
    const files=this.scanFolder(folder);
    if(!files.length) return { folder, file:null, mtime:null, rows:0, header:[], preview:[] };
    const newest=files.reduce((a,b)=>b.mtime>a.mtime?b:a);
    const sig=newest.path+'|'+newest.mtime+'|'+newest.size;
    const hit=this._srcInfoMemo.get(folder);
    if(hit && hit.sig===sig) return hit.info;
    // 行数:优先复用主 refresh 的解析结果 / ship·cost 的 aoa 记忆化,绝不为算行数而全量解析。
    const rowsOf=()=>{
      const fi=(this.files||[]).find(f=>f.path===newest.path);
      if(fi && typeof fi.rows==='number') return fi.rows;
      if(folder===this.config.shipFolder || folder===this.config.costFolder){
        const src=this._newestSourceAoa(folder);   // 已记忆化,同文件不重解析
        if(src && Array.isArray(src.aoa)) return Math.max(0, src.aoa.length-1);
      }
      return null;   // 未知→渲染端显 '—'
    };
    let info;
    try{
      // 限行读:只需表头 + 前 3 行预览。sheetRows:8 足够(表头+预览),避免整表加载。
      // 参数对齐旧全解析路径(raw:true 无 cellDates),预览里日期保持 Excel 序列数字,行为不变。
      const wb=XLSX.readFile(newest.path, { sheetRows: 8 });
      const aoa=XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]],{header:1,raw:true})||[];
      info={ folder, file:newest.name, mtime:newest.mtime, rows:rowsOf(), header:aoa[0]||[], preview:aoa.slice(1,4) };
    }catch(e){ info={ folder, file:newest.name, mtime:newest.mtime, rows:null, header:[], preview:[], error:String(e&&e.message||e) }; }
    this._srcInfoMemo.set(folder,{sig, info});   // 只留当前键(同 folder 旧条目被替换)
    return info;
  }
  // 6 个底表源各自最新文件的只读信息（供数据源看板统一富行）。
  sourcesInfo(){
    const map={ psi:this.config.folder, inv:this.config.invFolder, fin:this.config.finFolder, idc:this.config.idcFolder, ship:this.config.shipFolder, cost:this.config.costFolder };
    const out={}; Object.keys(map).forEach(k=>{ out[k]=this._sourceInfoOne(map[k]); }); return out;
  }

  scanFolder(folder){
    const f=folder||this.config.folder; if(!f||!fs.existsSync(f)) return [];
    return fs.readdirSync(f).filter(n=>/\.(xlsx|xls|csv)$/i.test(n) && !/^~\$/.test(n))
      .map(n=>{ const fp=path.join(f,n); const st=fs.statSync(fp); return {name:n,path:fp,mtime:st.mtimeMs,size:st.size}; });
  }

  // load (or parse) a single file, using cache by signature. kind: 'psi' | 'flow' | 'none'
  _getFileRows(fileInfo){
    const cf=this._cacheFile(fileInfo.path);
    try{
      const c=JSON.parse(fs.readFileSync(cf,'utf8'));
      if(c.mtime===fileInfo.mtime && c.size===fileInfo.size) return {kind:c.kind||'psi', rows:c.rows, dims:c.dims||[], cached:true};
    }catch(e){}
    const save=(kind,rows,dims,extra)=>{ const payload=Object.assign({mtime:fileInfo.mtime,size:fileInfo.size,kind,dims:dims||[],rows},extra||{});
      try{ fs.writeFileSync(cf,JSON.stringify(payload)); }catch(e){} return Object.assign({kind,rows,dims:dims||[],cached:false},extra||{}); };
    // 财经快路：若含命名表(财经实际表/财经预测表)，流式只读该范围，绕过 SheetJS 全量解析(避开同Sheet的PQ源底表→不爆内存)
    const isCsv=/\.csv$/i.test(fileInfo.path);
    if(!isCsv){ try{ const finStream=streamFinanceRows(fileInfo.path); if(finStream && finStream.length) return save('finance',finStream,[],{stream:true}); }catch(e){} }
    // 否则同一个文件只完整解析一次：打开工作簿，复用给所有探测器(省去 3-5 次重复 readFile)
    let wb=null; if(!isCsv){ try{ wb=openWorkbook(fileInfo.path); }catch(e){ wb=null; } }
    const psi=parseFile(fileInfo.path,wb);
    if(psi.isPSI) return save('psi',psi.rows,psi.dims);
    // 财经文件：一个文件(第一个Sheet)可能同时含 actual / forecast / BP —— 依次解析并合并所有非空结果，
    // 不再"命中一种就 return"(否则 actual 命中后会丢掉同文件的 BP/forecast)。各 parser 仍只读第一个Sheet。
    const act=parseActual(fileInfo.path,wb);
    const fc=parseForecast(fileInfo.path,wb);
    const bp=parseBP(fileInfo.path,wb);
    if(act.isActual || fc.isForecast || bp.isBP){
      const rows=[].concat(act.isActual?act.rows:[], fc.isForecast?fc.rows:[], bp.isBP?bp.rows:[]);
      return save('finance',rows,[],{actRows:act.isActual?act.rows.length:0, fcRows:fc.isForecast?fc.rows.length:0, bpRows:bp.isBP?bp.rows.length:0});
    }
    const idc=parseIdc(fileInfo.path,wb);
    if(idc.isIdc) return save('idc',idc.rows);
    const flow=parseFlow(fileInfo.path,wb);
    if(flow.isFlow) return save('flow',flow.rows);
    return {kind:'none',rows:[],dims:[]};
  }

  _scanAll(){
    const seen=new Set(); let list=[];
    [this.config.folder,this.config.invFolder,this.config.finFolder,this.config.idcFolder].forEach(f=>{
      if(f && !seen.has(f)){ seen.add(f); list=list.concat(this.scanFolder(f)); }
    });
    return list;
  }
  _applySnapshot(snap){
    this.files=snap.files||[]; this.dims=snap.dims||[];
    this.store=snap.store||null;
    this.flow=snap.flow||null; this.hasFlow=!!snap.hasFlow; this.flowDate=snap.flowDate||0;
    this.fin=snap.fin||null; this.finMeta=snap.finMeta||null; this.hasFin=!!snap.hasFin;
    this.idc=snap.idc||null; this.idcMeta=snap.idcMeta||null; this.hasIdc=!!snap.hasIdc;
  }

  // full refresh: scan main folder (+ inventory folder), ensure caches, merge+dedup, build columnar
  async refresh(folder, progress){
    if(folder) this.setFolder(folder);
    const list = this._scanAll();
    if(progress && list.length) progress({phase:'scan', n:list.length});
    if(!list.length){ this.store=null; this.files=[]; this.flow=null; this.hasFlow=false; this.fin=null; this.hasFin=false; this.idc=null; this.hasIdc=false; return this.meta(); }
    let allDims=new Set(); let parsedCount=0;
    const fileRows=[]; const flowFiles=[]; let finRows=[]; const idcFiles=[];
    for(let i=0;i<list.length;i++){
      const fi=list[i];
      await new Promise(res=>setImmediate(res));   // 让消息泵/IPC flush 转一圈（修启动「无响应」）
      if(progress) progress({phase:'file',i:i+1,n:list.length,name:fi.name});
      const r=this._getFileRows(fi);
      if(!r.cached) parsedCount++;
      if(r.kind==='psi'){ r.dims.forEach(d=>allDims.add(d)); fileRows.push({mtime:fi.mtime, rows:r.rows}); fi.rows=r.rows.length; fi.kind='psi'; }
      else if(r.kind==='flow'){ flowFiles.push({mtime:fi.mtime, rows:r.rows}); fi.rows=r.rows.length; fi.kind='flow'; }
      else if(r.kind==='actual'||r.kind==='forecast'||r.kind==='finance'||r.kind==='bp'){ finRows=finRows.concat(r.rows); fi.rows=r.rows.length; fi.kind=r.kind; }
      else if(r.kind==='idc'){ idcFiles.push({mtime:fi.mtime, rows:r.rows}); fi.rows=r.rows.length; fi.kind='idc'; }
      else { fi.rows=0; fi.kind='none'; }
    }
    this.files=list;
    this.dims=DIM_KEYS.filter(k=>allDims.has(k));
    if(progress) progress({phase:'merge'});
    this._buildStore(fileRows);
    this._buildFlow(flowFiles);
    this._buildFin(finRows);
    this._buildIdc(idcFiles);
    // prune orphan caches
    this._pruneCache(list);
    // 数据已换:清空源信息/AOA 记忆化,下次 sourcesInfo/sosimSource 按新 files.rows 重建(键也会自然失效,双保险)。
    this._srcInfoMemo.clear(); this._srcAoaMemo.clear();
    this.config.lastRefresh=Date.now();
    this.config.fileSigs=list.map(f=>({name:f.name,mtime:f.mtime,size:f.size}));
    this._saveConfig();
    try{ SNAP.save(this.dir, { sig:this.config.fileSigs, files:this.files, dims:this.dims,
      store:this.store, flow:this.flow, hasFlow:this.hasFlow, flowDate:this.flowDate,
      fin:this.fin, finMeta:this.finMeta, hasFin:this.hasFin,
      idc:this.idc, idcMeta:this.idcMeta, hasIdc:this.hasIdc }); }catch(e){}
    if(progress) progress({phase:'done', fromSnapshot:false, records:this.store?this.store.n:0, parsedCount, ts:Date.now()});
    return Object.assign(this.meta(),{parsedCount});
  }

  // open: rebuild store from caches (fast); parse only changed files
  async open(progress){
    if(!this.config.folder && !this.config.invFolder && !this.config.finFolder && !this.config.idcFolder) return this.meta();
    const list=this._scanAll();
    if(list.length){
      const sig=list.map(f=>({name:f.name,mtime:f.mtime,size:f.size}));
      const snap=SNAP.load(this.dir, sig);
      if(snap){ this._applySnapshot(snap);
        if(progress) progress({phase:'done', fromSnapshot:true, records:this.store?this.store.n:0, parsedCount:0, ts:Date.now()});
        return this.meta(); }
    }
    return await this.refresh(null, progress);
  }

  _pruneCache(list){
    const keep=new Set(list.map(f=>path.basename(this._cacheFile(f.path))));
    try{ fs.readdirSync(this.cacheDir).forEach(n=>{ if(n.endsWith('.json')&&!keep.has(n)) fs.unlinkSync(path.join(this.cacheDir,n)); }); }catch(e){}
  }

  /* 只作废「某一个源文件夹」的解析缓存（纯新增，不改 refresh 的任何行为）。
     用途：数据源看板的「单独刷新」——作废这一个源后照常跑一次全量 refresh，
     其余源的文件签名未变会命中缓存、不重新解析 xlsx（解析才是真正耗时的那步），
     于是效果上就是「只刷了这一个」，但走的仍是同一条经过验证的合并/建仓路径，口径零风险。
     kind: 'psi'|'inv'|'fin'|'idc'；返回作废的文件数。 */
  invalidateScope(kind){
    const folder = kind==='psi' ? this.config.folder
      : kind==='inv' ? this.config.invFolder
      : kind==='fin' ? this.config.finFolder
      : kind==='idc' ? this.config.idcFolder : null;
    if(!folder) return 0;
    let n=0;
    try{
      this.scanFolder(folder).forEach(f=>{
        const cf=this._cacheFile(f.path);
        try{ if(fs.existsSync(cf)){ fs.unlinkSync(cf); n++; } }catch(e){}
      });
    }catch(e){}
    // 文件签名一并作废，避免快照层直接判定「没变」而跳过重建
    try{ this.config.fileSigs=[]; this._saveConfig(); }catch(e){}
    return n;
  }

  // merge files (dedup dim+period, newest mtime wins) -> columnar typed arrays
  _buildStore(fileRows){
    fileRows.sort((a,b)=>a.mtime-b.mtime); // oldest first; newer overwrites
    const merged=new Map();
    for(const f of fileRows){
      for(const r of f.rows){
        const key=r[0]+'§'+r[1]+'§'+r[2]+'§'+r[3]+'§'+r[4]+'§'+r[5]+'§'+r[6]+'§'+r[7]+'§'+r[8]+'§'+r[9];
        merged.set(key,r); // newer file overwrites
      }
    }
    const rows=[...merged.values()]; const n=rows.length;
    const dimDict={}, dimIndex={}, dimCode={};
    DIM_KEYS.forEach(k=>{ dimDict[k]=[]; dimIndex[k]=new Map(); dimCode[k]=new Int32Array(n); });
    const ymd=new Int32Array(n);
    const sellIn=new Float64Array(n), sellOut=new Float64Array(n), inv=new Float64Array(n), dos=new Float64Array(n);
    for(let i=0;i<n;i++){
      const r=rows[i];
      for(let c=0;c<9;c++){ const k=DIM_KEYS[c]; const v=r[c];
        let code=dimIndex[k].get(v); if(code===undefined){ code=dimDict[k].length; dimDict[k].push(v); dimIndex[k].set(v,code); }
        dimCode[k][i]=code;
      }
      ymd[i]=r[10]; sellIn[i]=r[11]; sellOut[i]=r[12]; inv[i]=r[13]; dos[i]=r[14];
    }
    // precompute subtotal & all-channel code sets
    const subtotalCodes={}; DIM_KEYS.forEach(k=>{ const s=new Set(); dimDict[k].forEach((v,c)=>{ if(isSubtotal(v)) s.add(c); }); subtotalCodes[k]=s; });
    const allChan=new Set(); let hasNonAll=false;
    (dimDict.channel||[]).forEach((v,c)=>{ if(isAllChannel(v)) allChan.add(c); else if(v!=='') hasNonAll=true; });
    // 渠道口径(用户 2026-08-21 定稿):**渠道列视同不存在**——ALL/Online/Offline 只是行标签,彼此没有包含与被包含关系,一律直接相加;全项目任何地方都不做渠道去重(psiUnits 曾按组剔 ALL,已移除)。
    let mn=Infinity,mx=-Infinity; for(let i=0;i<n;i++){ const y=ymd[i]; if(y){ if(y<mn)mn=y; if(y>mx)mx=y; } }
    // model -> [family,line,series,product,model] ; repOffice -> region  (for 全流程表 join)
    const modelToDims={}, repToRegion={};
    for(let i=0;i<n;i++){
      const mc=dimCode.model[i], m=dimDict.model[mc];
      if(m && !modelToDims[m]) modelToDims[m]=[dimDict.family[dimCode.family[i]],dimDict.line[dimCode.line[i]],dimDict.series[dimCode.series[i]],dimDict.product[dimCode.product[i]],m];
      const rep=dimDict.repOffice[dimCode.repOffice[i]];
      if(rep && !repToRegion[rep]) repToRegion[rep]=dimDict.region[dimCode.region[i]];
    }
    this.store={ n, dimDict, dimIndex, dimCode, ymd, sellIn, sellOut, inv, dos,
      subtotalCodes, allChan, hasNonAllChannel:hasNonAll, modelToDims, repToRegion,
      minYmd:mn===Infinity?0:mn, maxYmd:mx===-Infinity?0:mx };
  }

  // 全流程库存: 合并库龄表(最新运行日, 同日求和), 按产品型号 join PSI 层级
  _buildFlow(flowFiles){
    this.flow=null; this.hasFlow=false; this.flowDate=0;
    if(!flowFiles || !flowFiles.length || !this.store) return;
    // 运行日期=期数；取"离今天最近的一期"：优先 ≤今天 的最新一期；若全是未来日期则取最早的未来一期
    const now=new Date(); const todayYmd=now.getFullYear()*10000+(now.getMonth()+1)*100+now.getDate();
    const runs=new Set(); flowFiles.forEach(f=>f.rows.forEach(r=>{ if(r[6]) runs.add(r[6]); }));
    if(!runs.size) return;
    const arr=[...runs]; const past=arr.filter(y=>y<=todayYmd);
    const maxRun = past.length ? Math.max(...past) : Math.min(...arr);
    const agg=new Map();
    flowFiles.forEach(f=>f.rows.forEach(r=>{ if(r[6]!==maxRun) return; // [model,rep,country,fam,ser,qty,runYmd]
      const key=r[0]+'§'+r[1]+'§'+r[2]; const cur=agg.get(key);
      if(!cur) agg.set(key,{model:r[0],rep:r[1],country:r[2],fam:r[3],ser:r[4],qty:r[5]});
      else cur.qty+=r[5];
    }));
    const m2d=this.store.modelToDims, r2reg=this.store.repToRegion; const enr=[];
    agg.forEach(v=>{ const d=m2d[v.model];
      enr.push({ family:d?d[0]:v.fam, line:d?d[1]:'', series:d?d[2]:v.ser, product:d?d[3]:'', model:v.model,
        repOffice:v.rep, region:r2reg[v.rep]||'', country:v.country, qty:v.qty }); });
    this.flow=enr; this.hasFlow=enr.length>0; this.flowDate=maxRun;
  }

  // 财经store：实际+预测记录 [src,brand,region,rep,country,lv1,lv2,lv3,lv4,metric,order,ym,val,version?]
  _buildFin(finRows){
    this.fin=null; this.hasFin=false; this.finMeta=null;
    if(!finRows || !finRows.length) return;
    const n=finRows.length;
    const FK=['brand','region','rep','country','lv1','lv2','lv3','lv4','metric','version','model'];
    const sidx={brand:1,region:2,rep:3,country:4,lv1:5,lv2:6,lv3:7,lv4:8,metric:9};
    const dimDict={}, dimIndex={}, dimCode={};
    FK.forEach(k=>{ dimDict[k]=[]; dimIndex[k]=new Map(); dimCode[k]=new Int32Array(n); });
    const src=new Uint8Array(n), ym=new Int32Array(n), val=new Float64Array(n);
    const metricOrder=new Map();
    const brands=new Set(), versions=new Set(), years=new Set(), actualYears=new Set(); let hasFc=false, hasAct=false;
    let hasBP=false; const bpVersions=new Set(), bpMetricsSet=new Set(), bpYears=new Set();
    const dimHas={}; FK.forEach(k=>dimHas[k]=false);
    const intern=(k,v)=>{ let c=dimIndex[k].get(v); if(c===undefined){ c=dimDict[k].length; dimDict[k].push(v); dimIndex[k].set(v,c); } if(v!=='')dimHas[k]=true; return c; };
    for(let i=0;i<n;i++){
      const r=finRows[i]; const t=r[0]; const isF=(t==='F'), isB=(t==='B');
      src[i]= isF?1:(isB?2:0);
      for(const k of FK){ let v; if(k==='version') v=(isF||isB)?String(r[13]||'默认'):''; else if(k==='model') v=(r[14]==null?'':String(r[14])); else v=(r[sidx[k]]==null?'':String(r[sidx[k]])); dimCode[k][i]=intern(k,v); }
      ym[i]=r[11]||0; val[i]=r[12]||0;
      const yy=Math.floor(ym[i]/100); years.add(yy);
      metricOrder.set(r[9], r[10]); brands.add(r[1]);
      if(isF){ hasFc=true; versions.add(r[13]||'默认'); }
      else if(isB){ hasBP=true; bpVersions.add(r[13]||'默认'); bpMetricsSet.add(r[9]); bpYears.add(yy); }
      else { hasAct=true; actualYears.add(yy); }
    }
    const metricList=[...metricOrder.entries()].sort((a,b)=>((a[1]||0)-(b[1]||0))||String(a[0]).localeCompare(String(b[0]),'zh')).map(e=>e[0]);
    const bpMetrics=metricList.filter(m=>bpMetricsSet.has(m));
    this.fin={ n, src, ym, val, dimDict, dimIndex, dimCode, metricOrder };
    this.finMeta={ metrics:metricList, brands:[...brands].filter(b=>b!=='').sort(), versions:[...versions].filter(v=>v!=='').sort(),
      forecastVersions:[...versions].filter(v=>v!=='').sort(), years:[...years].sort(), actualYears:[...actualYears].sort(),
      dims:['region','rep','country','lv1','lv2','lv3','lv4','brand','model'].filter(k=>dimHas[k]), hasForecast:hasFc, hasActual:hasAct,
      hasBP, bpVersions:[...bpVersions].sort(), bpMetrics, bpYears:[...bpYears].sort() };
    this.hasFin=true;
  }
  _finBrandCodes(brands){ if(!brands||!brands.length) return null; const F=this.fin; const s=new Set(); brands.forEach(b=>{const c=F.dimIndex.brand.get(String(b)); if(c!==undefined)s.add(c);}); return s; }
  // finance / financeKpi / financeAchieve / financeBP / financeBPBoard
  // 已迁至 engine-finance.js（通过 prototype 挂回 Engine）。

  /* ---------- IDC 市场底表：列式 store + 通用聚合 ---------- */
  _buildIdc(idcFiles){
    this.idc=null; this.hasIdc=false; this.idcMeta=null;
    if(!idcFiles || !idcFiles.length) return;
    idcFiles.sort((a,b)=>a.mtime-b.mtime);
    const D=IDC_DIM_KEYS.length;
    const merged=new Map();
    for(const f of idcFiles) for(const r of f.rows){ const key=r.slice(0,D).join('§'); merged.set(key,r); } // 同维度后到覆盖
    const rows=[...merged.values()]; const n=rows.length; if(!n) return;
    const dimDict={}, dimIndex={}, dimCode={};
    IDC_DIM_KEYS.forEach(k=>{ dimDict[k]=[]; dimIndex[k]=new Map(); dimCode[k]=new Int32Array(n); });
    const units=new Float64Array(n), value=new Float64Array(n);
    for(let i=0;i<n;i++){ const r=rows[i];
      for(let c=0;c<D;c++){ const k=IDC_DIM_KEYS[c]; const v=r[c]==null?'':String(r[c]);
        let code=dimIndex[k].get(v); if(code===undefined){ code=dimDict[k].length; dimDict[k].push(v); dimIndex[k].set(v,code); }
        dimCode[k][i]=code; }
      units[i]=r[D]||0; value[i]=r[D+1]||0;
    }
    const dims=IDC_DIM_KEYS.filter(k=> dimDict[k].some(v=>v!=='') );
    this.idc={ n, dimDict, dimIndex, dimCode, units, value };
    this.idcMeta={ dims, n, measures:['units','value','asp'], cats:[...(dimDict.cat||[])].filter(v=>v) };
    this.hasIdc=true;
  }
  // IDC 通用聚合 aggIdc 已迁至 engine-custom.js（prototype 挂回 Engine）
  // IDC 切片器选项：某维度去重值(可按其它筛选收窄)
  idcOptions(field,filters){
    const s=this.idc; if(!s||!s.dimCode[field]) return [];
    filters=filters||{}; const fl=[]; for(const k in filters){ if(k===field||!s.dimCode[k]) continue; const vals=asArr(filters[k]); if(!vals.length) continue;
      const set=new Set(); vals.forEach(v=>{ const c=s.dimIndex[k].get(String(v)); if(c!==undefined) set.add(c); }); fl.push([s.dimCode[k],set]); }
    const seen=new Set(); const code=s.dimCode[field];
    for(let i=0;i<s.n;i++){ let ok=true; for(let j=0;j<fl.length;j++){ if(!fl[j][1].has(fl[j][0][i])){ok=false;break;} } if(!ok) continue; seen.add(code[i]); }
    return [...seen].map(c=>s.dimDict[field][c]).filter(v=>v!=='').sort((a,b)=>String(a).localeCompare(String(b),'zh'));
  }

  // 读某底表的表头+第一行示例(供「底表结构速览」左栏)。按文件名解析路径;只读第一个 sheet 首个非空行+下一行。
  // 返回 {header:[String], sample:[原值], sheet:String|null} 或 {error:String}
  fileSchema(name){
    const fi = this.files.find(f => f.name === name);   // 重名取第一个(v1 可接受)
    if(!fi) return { error: '未找到文件:' + name };
    try{
      if(/\.csv$/i.test(fi.path)){
        const lines = fs.readFileSync(fi.path, 'utf8').split(/\r?\n/).filter(l => l.length);
        const header = splitCSVLine(lines[0] || '').map(s => s.trim());
        const sample = lines[1] != null ? splitCSVLine(lines[1]).map(s => s.trim()) : [];
        return { header, sample, sheet: null };
      }
      // 只需表头+首行示例 → 限读前若干行,避免对 20MB+ 财经表全量加载(同 sheet 的 PQ 源底表会爆内存/卡顿)。
      const wb = XLSX.readFile(fi.path, Object.assign({}, WB_OPTS, { sheetRows: 8 }));
      const nm = wb.SheetNames[0], ws = wb.Sheets[nm];
      const range = XLSX.utils.decode_range(ws['!ref']);
      const rowAt = r => { const out = []; for(let c=range.s.c;c<=range.e.c;c++){ const cell=ws[XLSX.utils.encode_col(c)+(r+1)]; out.push(cell&&cell.v!=null?cell.v:''); } return out; };
      let hr = range.s.r;
      for(let r=range.s.r;r<=range.e.r;r++){ if(rowAt(r).some(v => String(v).trim() !== '')){ hr = r; break; } }
      const header = rowAt(hr).map(v => v==null ? '' : String(v));
      const sample = (hr+1 <= range.e.r) ? rowAt(hr+1) : [];
      return { header, sample, sheet: nm };
    }catch(e){ return { error: String(e && e.message || e) }; }
  }

  meta(){
    const s=this.store;
    return {
      folder:this.config.folder||null,
      invFolder:this.config.invFolder||null,
      finFolder:this.config.finFolder||null,
      idcFolder:this.config.idcFolder||null,
      shipFolder:this.config.shipFolder||null,   // 库存看板发货表来源（只读元信息，供数据源面板显示）
      costFolder:this.config.costFolder||null,   // 库存看板成本表来源（同上）
      lastRefresh:this.config.lastRefresh||null,
      files:this.files.map(f=>({name:f.name,rows:f.rows||0,kind:f.kind||'psi'})),
      dims:this.dims,
      records: s?s.n:0,
      hasFlow: !!this.hasFlow,
      flowDate: this.flowDate? ymdToStr(this.flowDate):null,
      hasFin: !!this.hasFin,
      finMeta: this.finMeta||null,
      hasIdc: !!this.hasIdc,
      idcMeta: this.idcMeta||null,
      from: s&&s.minYmd?ymdToStr(s.minYmd):null,
      to:   s&&s.maxYmd?ymdToStr(s.maxYmd):null,
    };
  }

  // 级联选项：基于"其他所有已选筛选"(跨层级)收窄当前字段的可选值
  options(field, filters){
    const s=this.store; if(!s) return [];
    const {fl}=buildFilters(s, filters, field);  // all active filters except this field
    const fieldCode=s.dimCode[field]; const dict=s.dimDict[field]; if(!fieldCode) return [];
    const seen=new Set();
    for(let i=0;i<s.n;i++){
      let ok=true; for(let j=0;j<fl.length;j++){ if(!fl[j][1].has(fl[j][0][i])){ok=false;break;} }
      if(!ok) continue;
      seen.add(fieldCode[i]);
    }
    const out=[]; seen.forEach(c=>{ const v=dict[c]; if(v!==''&&!isSubtotal(v)) out.push(v); });
    return out.sort((a,b)=>String(a).localeCompare(String(b),'zh'));
  }

  /* 自定义图表 custom 已迁至 engine-custom.js（prototype 挂回 Engine） */

  /* 产业看板(音频/平板)方法已迁至 engine-industry.js（prototype 挂回 Engine）：
     industryBoard / industryTrend / _industryDim / _industryVals / _families / _industryFinance */

  // AOA(表头行+数据行) -> 内存工作簿(供真实解析器 _wb 入参,不落盘)
  _aoaToWb(aoa, sheet){ const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), sheet||'S'); return wb; }

  // 生成 4 张"真实底表格式"的表(AOA)。复用与现 loadSample 相同的 prods/geos/取数公式与种子,
  // 只是按真实列输出。错位:PSI 的 Product Family 列=系列(lv3)、Product Series 列=产品(lv4);财经 lv3=系列、lv4=产品。
  _sampleTables(){
    // 共享数据(与现 loadSample 一致) —— 实现时从现有 loadSample 搬同一份。
    // 演示数据全部虚构(Product A~F + 字母型号)——不含任何真实品牌/产品名,可对外演示
    const prods=[
      ['平板','平板','Series P','Product A','Product A 13.2-inch','PA-W09DK'],
      ['平板','平板','Series S','Product B','Product B 11-inch','PB-W09B'],
      ['平板','平板','Series A','Product C','Product C 12-inch','PC-W09BK'],
      ['音频与智能配件','耳机','Series T2','Product D','Product D Buds','PD-T010'],
      ['音频与智能配件','耳机','Series T1','Product E','Product E Buds Pro','PE-T180'],
      ['音频与智能配件','耳机','Series O','Product F','Product F Open-Ear','PF-T00'],
    ];
    const geos=['巴西','哥伦比亚','墨西哥','南美洲多国'];
    const psiGeos=['巴西','墨西哥','南美洲多国'];
    const regs=psiGeos.map(g=>['拉美终端事业部', g+'终端事业部', g]);
    let seed=42; const rnd=()=>{seed=(seed*9301+49297)%233280;return seed/233280;};

    // ---- PSI 长表(销售组织列)：每 (维度×期间) 展开 SI/SO/INV/DOS 四行 ----
    const psi=[['大区','国家办','国家','渠道','Product Family','Product Line','Product Series','Product','产品型号','会计期年月','PSIType','本月实际']];
    const periods=[]; [2025,2026].forEach(Y=>{ for(let d=new Date(Y,0,5); d<=new Date(Y,5,15); d.setDate(d.getDate()+7)){ const dd=new Date(d); periods.push(dd.getFullYear()*10000+(dd.getMonth()+1)*100+dd.getDate()); } });
    prods.forEach((t,ti)=>{ const lv1=t[0], series=t[2], product=t[3], full=t[4], model=t[5]; const base=120-ti*12; // Product Family=series(lv3), Product Series=product(lv4)
      regs.forEach(rg=>{ periods.forEach((p,pi)=>{ const season=1+0.3*Math.sin(pi/3); const yf=p<20260000?0.82:1;
        [['Online',0.55],['Offline',0.45]].forEach(([ch,w])=>{
          const si=Math.round(base*season*w*(0.6+rnd()*0.8)*yf), so=Math.round(base*season*w*(0.6+rnd()*0.8)*yf);
          const inv=Math.max(0,Math.round(base*2*w*(0.5+rnd())));
          const pl=ymdToStr(p);
          // Product Family=series(系列), Product Line=lv1(产业), Product Series=product(产品全名), Product=full
          // PSIType 值取真实底表口径(经 norm → PSI_MAP):Sell in/Sell out/Inventory(SI/SO/INV 不被 PSI_MAP 识别会被丢弃)。
          psi.push([rg[0],rg[1],rg[2],ch, series, lv1, product, full, model, pl, 'Sell in', si]);
          psi.push([rg[0],rg[1],rg[2],ch, series, lv1, product, full, model, pl, 'Sell out', so]);
          psi.push([rg[0],rg[1],rg[2],ch, series, lv1, product, full, model, pl, 'Inventory', inv]);
        }); }); }); });

    // ---- 财经三表 ----  指标/单位/数值公式与现 loadSample 一致(把换算后的值直接填入)
    const finConcepts=[
      {act:'净销售收入', fb:'净销售收入', ord:1110, qty:false},
      {act:'销售毛利',   fb:'销售毛利',   ord:1300, qty:false},
      {act:'贡献利润',   fb:'贡献利润',   ord:3380, qty:false},
      {act:'收入量_终端', fb:'收入量',     ord:50,   qty:true},
      {act:null,         fb:'Sell in量',  ord:55,   qty:true},
      {act:null,         fb:'Sell out量', ord:60,   qty:true},
    ];
    const finReps=geos.map((g,i)=>['拉美大区', g+'国家办', g, 1.7-i*0.34]);
    const finProds=prods.map((t,i)=>({lv1:t[0],lv2:t[1],lv3:t[2],lv4:t[3], sw:1.2-i*0.13})); // lv3=系列、lv4=产品(与 PSI 错位对齐)
    let s3=11; const r3=()=>{s3=(s3*9301+49297)%233280;return s3/233280;};
    const lastActM=6;

    const act=[['报表项中文名称','报表项排序序号','品牌','大区','国家办','国家','产品lv1','产品lv2','产品lv3','产品lv4','会计期年月','本月实际']];
    const fc =[['品牌','大区','国家办','产品lv1','产品lv2','产品lv3','产品lv4','产品型号','指标名称','指标序号','金额数量单位','版本','预测场景','attribute','value']];
    const bp =[['版本中文名','大区中文名','国家办中文名','产品lv1中文名','产品lv2中文名','产品lv3中文名','产品lv4中文名','报表项中文名','月份','值']];

    finConcepts.forEach(c=>finReps.forEach(([reg,rep,ctry,rw])=>finProds.forEach(({lv1,lv2,lv3,lv4,sw})=>{
      const fbName=c.fb;
      const unit=(c.qty ? (fbName==='Sell out量'?900:1000) : (fbName==='净销售收入'?90000:fbName==='销售毛利'?90000*0.22:30000));
      const baseV=unit*sw*rw; const brand=(lv1==='平板')?'ACME-HQ':'COMMON';   // 虚构自有品牌(normBrand 只归一不过滤,值原样通过)
      // 数量指标恒为台(底表数量恒为台,与 view 的 finQtyUnits:{台,台,台} 一致,不可缩放);金额→百万美元(MUSD)
      const fcAmt=v=>c.qty?v:+(v/1e6).toFixed(6);
      const bpAmt=v=>c.qty?v:+(v/1e6).toFixed(6);
      const unitLabel=c.qty?'台':'百万美元';
      for(let m=1;m<=12;m++){
        const fc26=Math.round(baseV*(0.85+r3()*0.35));
        if(c.act && m<=lastActM){
          const act25=Math.round(baseV*(0.60+r3()*0.28)), act26=Math.round(baseV*(0.92+r3()*0.38));
          act.push([c.act,c.ord,brand,reg,rep,ctry,lv1,lv2,lv3,lv4,2025*100+m,act25]);
          act.push([c.act,c.ord,brand,reg,rep,ctry,lv1,lv2,lv3,lv4,2026*100+m,act26]);
        }
        // 预测长表:每月一行,attribute=会计期,value=换算后值。预测真实无 country(解析器会置空),这里不出 country 列。
        fc.push([brand,reg,rep,lv1,lv2,lv3,lv4,'',fbName,c.ord,unitLabel,'4月预测','基线',2026*100+m, fcAmt(fc26)]);
        const bp26=Math.round(baseV*(0.95+r3()*0.25));
        bp.push(['国家办工作底稿',reg,rep,lv1,lv2,lv3,lv4,fbName,2026*100+m, bpAmt(bp26)]);
      }
    })));
    return {psi, act, fc, bp};
  }

  /* sample data for demo (no folder needed) */
  loadSample(){
    // 共享产品分类 —— 财经与 PSI 共用同一份,层级显式对齐真实底表：
    //   [lv1产业, lv2品类, lv3产品系列, lv4产品, PSI产品全名, PSI型号]
    //   · 真实底表口径：PSI「产品系列」=财经 LV3、PSI「产业」=财经 LV1、PSI「产品」=财经 LV4。
    //   · 故 PSI store 行槽位映射：family=lv3(产品系列)、line=lv1(产业)、series=lv4(产品)、product=全名、model=型号。
    //   · 财经 finRows：lv1/lv2/lv3/lv4 直填(lv3 必须=PSI family,lv4 必须=PSI series),据此演示 财经↔PSI 按组对齐。
    const prods=[
      ['平板','平板','Series P','Product A','Product A 13.2-inch','PA-W09DK'],
      ['平板','平板','Series S','Product B','Product B 11-inch','PB-W09B'],
      ['平板','平板','Series A','Product C','Product C 12-inch','PC-W09BK'],
      ['音频与智能配件','耳机','Series T2','Product D','Product D Buds','PD-T010'],
      ['音频与智能配件','耳机','Series T1','Product E','Product E Buds Pro','PE-T180'],
      ['音频与智能配件','耳机','Series O','Product F','Product F Open-Ear','PF-T00'],
    ];
    // 共享国家办/地名 —— 财经与 PSI 共用同一批地名,但命名差异(财经"<地名>国家办" vs PSI"<地名>终端事业部"),
    // 经 _psiActual 内的 finPsiRepNorm 归一桥接(巴西国家办 ≈ 巴西终端事业部)。region 同理(拉美大区/拉美终端事业部)。
    const geos=['巴西','哥伦比亚','墨西哥','南美洲多国'];
    // PSI demo 选其中 3 个地名(均出现在财经侧),按"<地名>终端事业部"建 PSI 行,演示按国家办对齐 sell-in/out。
    const psiGeos=['巴西','墨西哥','南美洲多国'];
    const regs=psiGeos.map(g=>['拉美终端事业部', g+'终端事业部', g]);
    // ↓ PSI + 财经三表改走真实解析器：_sampleTables 产出真实底表格式 AOA → _aoaToWb 转内存工作簿 → 真实 parse* 解析 → 装配 store。
    //   数值等价:_sampleTables 已填换算后的最终值,解析器不做单位换算(toNum 原值)。
    const T=this._sampleTables();
    const psi=parseFile('sample-psi.xlsx', this._aoaToWb(T.psi,'PSI'));
    const act=parseActual('sample-act.xlsx', this._aoaToWb(T.act,'实际'));
    const fc =parseForecast('sample-fc.xlsx', this._aoaToWb(T.fc,'预测'));
    const bp =parseBP('sample-bp.xlsx', this._aoaToWb(T.bp,'BP'));
    this.files=[{name:'PSI示例(内置)',rows:psi.rows.length}];
    this.dims=DIM_KEYS.filter(k=> psi.dims ? psi.dims.includes(k) : true);
    this._buildStore([{mtime:1,rows:psi.rows}]);
    this._buildFin([].concat(act.rows, fc.rows, bp.rows));
    // 全流程示例: 库龄表第一Sheet=CDC+FDC库存(国家仓+FDC); 全流程库存=渠道INV+CDC+FDC(引擎里相加)
    const flowRows=[]; let seed2=7; const rnd2=()=>{seed2=(seed2*9301+49297)%233280;return seed2/233280;};
    prods.forEach(t=>regs.forEach(rg=>{ const q=Math.round((200+rnd2()*400)); // [model,rep,country,fam(=lv3),ser(=lv4),cdcFdcQty,runYmd]
      flowRows.push([t[5],rg[1],rg[2],t[2],t[3],q,ymdInt(new Date(2026,5,15))]); }));
    this._buildFlow([{mtime:1,rows:flowRows}]);
    // 财经示例已上移:由 _sampleTables 产出真实三表(实际/预测/BP)经 parseActual/parseForecast/parseBP 解析后 _buildFin。
    // IDC 市场示例（平板 + 音频/TWS&OWS），演示「看板设计器」IDC 数据源
    const idcRows=[]; let s4=23; const r4=()=>{s4=(s4*9301+49297)%233280;return s4/233280;};
    const idcCountries=['Mexico','Colombia','Brazil','Argentina','Chile','Peru','Rest of Latin America'];
    const idcQ=[]; ['2024','2025','2026'].forEach(y=>['Q1','Q2','Q3','Q4'].forEach(q=>idcQ.push([y,y+q])));
    const tabModels=[ ['Brand A','1-Brand A','A-Tab Pro','Detachable Tablet','11','8','256','1：$800+',980],
      ['Brand A','1-Brand A','A-Tab','Detachable Tablet','10.9','4','64','3：$350-500',420],
      ['Brand B','2-Brand B','B-Tab S','Detachable Tablet','11','8','128','2：$500-800',640],
      ['Brand B','2-Brand B','B-Tab Lite','Slate Tablet','8.7','4','64','5：$150以下',130],
      ['ACME-HQ','3-ACME-HQ','Product C 11.5','Slate Tablet','11.5','8','128','2：$500-800',360],
      ['ACME-HQ','3-ACME-HQ','Product B','Slate Tablet','10.4','4','64','4：$150-350',190],
      ['Brand C','4-Brand C','C-Tab M','Slate Tablet','11','4','128','4：$150-350',160] ];
    idcQ.forEach(([yr,q],qi)=>idcCountries.forEach((ctry,ci)=>tabModels.forEach(m=>{
      const units=Math.round((1200/(ci+1))*(0.6+r4())*(1+qi*0.04));
      const asp=Math.round(m[8]*(0.92+r4()*0.16)); const value=+(units*asp/1e6).toFixed(6);
      // [cat,year,quarter,region,country,brand,brandGrp,model,form,segment,owsCerti,openEar,screen,ram,storage,gen,priceBand,pbStd,pbHQ,pbBR,units,value]
      idcRows.push(['平板',yr,q,'Latin America',ctry,m[0],m[1],m[2],m[3],'Consumer','','',m[4],m[5],m[6],'N/A','',m[7],'','',units,value]);
    })));
    const audModels=[ ['Brand A','02-Brand A','A-Buds Pro','TWS','5- $250+',249],['Brand A','02-Brand A','A-Buds','TWS','5- $250+',179],
      ['Brand B','01-Brand B','B-Buds Pro','TWS','4- $150-250',199],['Brand B','01-Brand B','B-Buds FE','TWS','3- $75-150',99],
      ['Brand D','03-Brand D','D-Buds 5','TWS','2- $25-75',39],['ACME-HQ','05-ACME-HQ','Product E Buds Pro','TWS','4- $150-250',179],
      ['ACME-HQ','05-ACME-HQ','Product F Clip','OWS','4- $150-250',199],['Brand B','01-Brand B','B-Buds Live','OWS','3- $75-150',129] ];
    idcQ.forEach(([yr,q],qi)=>idcCountries.forEach((ctry,ci)=>audModels.forEach(m=>{
      const units=Math.round((4000/(ci+1))*(0.6+r4())*(1+qi*0.04));
      const asp=Math.round(m[5]*(0.9+r4()*0.2)); const value=+(units*asp/1e6).toFixed(6); const openEar=m[3]==='OWS'?'Yes':'No';
      idcRows.push(['音频',yr,q,'Latin America',ctry,m[0],m[1],m[2],'Truly Wireless','',m[3],openEar,'','','','','',m[4],'','',units,value]);
    })));
    this._buildIdc([{mtime:1,rows:idcRows}]);
    return this.meta();
  }
}

// 财经单位归一：实际/预测/BP 三来源可能不同单位(USD/千USD/百万USD)。把每个来源按其单位
// 换算成统一单位(USD)的乘子；p.finUnits={actual,forecast,bp}，值∈ USD/千USD/MUSD 等。
// 不传则乘子=1(不缩放，保持同单位数据与既有测试不变)。返回按 src 索引 [0=实际,1=预测,2=BP]。
const FIN_UNIT_MULT = { 'USD':1,'美元':1,'元':1, '千USD':1000,'千美元':1000,'千元':1000, 'MUSD':1e6,'百万USD':1e6,'百万美元':1e6,'百万':1e6 };
function finUnitScale(p){
  const u=(p&&p.finUnits)||{};
  const pick=v=>{ if(v==null||v==='') return 1; const m=FIN_UNIT_MULT[v]; return (m!=null)?m:1; };
  return [ pick(u.actual), pick(u.forecast), pick(u.bp) ];
}
/* ---------- 音频延迟录入 DOS 辅助(方案A,按国家取 W_last) ----------
   音频 SO 为手动延迟报量,不能用"当前周"做 DOS 窗口。这两个纯函数供
   report/psi/industry 共用;平板路径不经过它们,一字不变。 */
// 产业维度与"音频"值码集:line/family 中含 平板|音频 字样的维度;值 contains '音频'(兼容"音频与智能配件")。
function audioDimInfo(s){
  if(!s||!s.dimDict) return null;
  const pick=(s.dimDict.line&&s.dimDict.line.some(v=>/平板|音频/.test(v)))?'line'
    :(s.dimDict.family&&s.dimDict.family.some(v=>/平板|音频/.test(v)))?'family':null;
  if(!pick||!s.dimCode[pick]) return null;
  const codes=new Set(); s.dimDict[pick].forEach((v,c)=>{ if(v&&String(v).indexOf('音频')>=0) codes.add(c); });
  return codes.size?{dim:pick,codes}:null;
}
// 以 ymd 所在 ISO 周为终点的 4 整周(28天)窗口。返回 {start:窗口首日, wls:W_last周一, end:W_last周日}。
// 跨月/跨年安全:全部走真实日历(UTC)再转回 yyyymmdd 整数。
function audioWindow(ymd){
  const Y=Math.floor(ymd/10000),M=Math.floor((ymd%10000)/100),D=ymd%100;
  const dt=new Date(Date.UTC(Y,M-1,D)); const day=dt.getUTCDay()||7;
  const mon=dt.getTime()-(day-1)*86400000;
  const toY=t=>{const d=new Date(t);return d.getUTCFullYear()*10000+(d.getUTCMonth()+1)*100+d.getUTCDate();};
  return { start:toY(mon-21*86400000), wls:toY(mon), end:toY(mon+6*86400000) };
}

// 数量类指标(台数,无货币单位)：单位归一只作用于金额指标,数量指标不缩放。
function isQtyMetric(name){ return /量|数量|台数|\bqty\b|\bunits?\b|\bpcs\b/i.test(String(name||'')); }

module.exports = {
  Engine, __finTest, __psiTest: { parseCSV, parseFile, mapColumns },
  finUnitScale, FIN_UNIT_MULT, isQtyMetric,
  // shared file-scoped helpers/consts the per-module query methods need once extracted
  // (engine-{psi,report,finance,industry,custom}.js will import these). Exported generously; extras are harmless.
  isSubtotal, normBrand, toNum, buildFilters, seriesAllowedSet, hasFilterVal, isAllChannel,
  ymdInt, isoWeekOf, isoYW, isoThu, bucketOf, ymdToStr, parseDateCell, asArr,
  norm, premiumScore, audioDimInfo, audioWindow,
  MAX_SERIES, FLOW, DIM_KEYS, PSI_MAP, IDC_DIM_KEYS, GEO_ORDER, PROD_ORDER,
};

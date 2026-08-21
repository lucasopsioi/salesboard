/* 渠道口径：不做任何去重，所有渠道行(online/offline/all)按所选维度直接汇总，
   与"底表不筛渠道的平铺透视"一致。库存=最新期跨所有渠道/维度求和；DOS=库存÷日均SO重算。 */
'use strict';
const fs=require('fs'), os=require('os'), path=require('path');
const E=require('../engine.js');

const HEAD=['ManagementRegion','RepOffice','Country','OnlineOffline','ProductFamily','ProductLine','ProductSeries','Product','ProductModel','PeriodID','PSIType','Qty'];
async function buildEng(recs){
  const rows=[HEAD.join(',')];
  recs.forEach(r=>rows.push([r.region||'LATAM',r.rep||'RepX',r.country||'Brazil',r.ch,r.fam||'Tablet',r.line||'Slate Tab',r.series||'S1',r.prod||'P1',(r.prod||'P1')+'-M',r.per,r.type,r.q].join(',')));
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'chres-'));
  fs.writeFileSync(path.join(dir,'psi.csv'),'﻿'+rows.join('\n'),'utf8');
  const eng=new E.Engine(fs.mkdtempSync(path.join(os.tmpdir(),'ud-'))); eng.setFolder(dir); await eng.refresh();
  return eng;
}
let pass=0, fail=0;
function eq(name,got,exp){ if(got===exp){pass++;} else {fail++; console.log('FAIL',name,'got',got,'exp',exp);} }
const qv=(q,series,b)=>((q.data[series]||{})[b]||0);

(async () => {
// --- S1: SO 全加(含 all)；库存只记在 all 一行 -> 用 all 的库存 ---
await (async ()=>{
  const eng=await buildEng([
    {ch:'Online', per:'2026-03-01', type:'Sell Out', q:60},
    {ch:'Offline',per:'2026-03-01', type:'Sell Out', q:40},
    {ch:'全部',   per:'2026-03-01', type:'Sell Out', q:100},   // 渠道不去重 -> 一起加
    {ch:'全部',   per:'2026-03-01', type:'Inventory', q:300},
  ]);
  const b='2026-03';
  eq('S1 sellOut 全加 =200', qv(eng.query({metric:'sellOut',stackDim:'series',gran:'month'}),'S1',b), 200);
  eq('S1 inv (只在all) =300', qv(eng.query({metric:'inv',stackDim:'series',gran:'month'}),'S1',b), 300);
  const rep=eng.report({groupDim:'series'}); const r=rep.rows.find(x=>x.key==='S1');
  eq('report cumCur SO 全加 =200', r&&r.cumCur, 200);
  eq('report inv =300', r&&r.inv, 300);
})();

// --- S2: 库存跨 combo 在最新期求和(不是取最后一行)，旧期忽略 ---
await (async ()=>{
  const eng=await buildEng([
    {country:'Brazil',ch:'Online',per:'2026-02-01',type:'Inventory',q:999}, // 旧期忽略
    {country:'Brazil',ch:'Online',per:'2026-03-01',type:'Inventory',q:100},
    {country:'Chile', ch:'Online',per:'2026-03-01',type:'Inventory',q:200},
    {country:'Brazil',ch:'Online',per:'2026-03-01',type:'Sell Out', q:50},
    {country:'Chile', ch:'Online',per:'2026-03-01',type:'Sell Out', q:70},
  ]);
  const b='2026-03';
  eq('S2 inv 最新期求和 =300', qv(eng.query({metric:'inv',stackDim:'series',gran:'month'}),'S1',b), 300);
  eq('S2 sellOut =120', qv(eng.query({metric:'sellOut',stackDim:'series',gran:'month'}),'S1',b), 120);
})();

// --- S3: 库存只在"全渠道"一行(扩充识别也不影响,因不再去重,直接保留) ---
await (async ()=>{
  const eng=await buildEng([
    {ch:'Online',  per:'2026-03-01',type:'Sell Out', q:30},
    {ch:'Offline', per:'2026-03-01',type:'Sell Out', q:20},
    {ch:'全渠道',  per:'2026-03-01',type:'Sell Out', q:50},
    {ch:'全渠道',  per:'2026-03-01',type:'Inventory', q:500},
  ]);
  const b='2026-03';
  eq('S3 inv (全渠道) =500', qv(eng.query({metric:'inv',stackDim:'series',gran:'month'}),'S1',b), 500);
  eq('S3 sellOut 全加 =100', qv(eng.query({metric:'sellOut',stackDim:'series',gran:'month'}),'S1',b), 100);
})();

// --- S4: 只有一个合计渠道(无明细) -> 正常保留 ---
await (async ()=>{
  const eng=await buildEng([
    {ch:'全部', per:'2026-03-01',type:'Sell Out', q:80},
    {ch:'全部', per:'2026-03-01',type:'Sell In',  q:90},
    {ch:'全部', per:'2026-03-01',type:'Inventory', q:120},
  ]);
  const b='2026-03';
  eq('S4 sellOut =80', qv(eng.query({metric:'sellOut',stackDim:'series',gran:'month'}),'S1',b), 80);
  eq('S4 sellIn =90', qv(eng.query({metric:'sellIn',stackDim:'series',gran:'month'}),'S1',b), 90);
  eq('S4 inv =120', qv(eng.query({metric:'inv',stackDim:'series',gran:'month'}),'S1',b), 120);
})();

// --- S5: DOS 重算 = 库存(全加) ÷ 日均SO(全加)，源 DOS 列被忽略 ---
await (async ()=>{
  const eng=await buildEng([
    {ch:'Online', per:'2026-03-01', type:'Sell Out', q:60},
    {ch:'Offline',per:'2026-03-01', type:'Sell Out', q:40},   // SO 合计 100
    {ch:'全部',   per:'2026-03-01', type:'Inventory', q:300},
    {ch:'全部',   per:'2026-03-01', type:'DOS', q:7},          // 垃圾源列,必须忽略
  ]);
  // 月度 DOS = 库存300 ÷ (SO100/30天) = 90
  eq('S5 DOS 重算 =90', qv(eng.query({metric:'dos',stackDim:'series',gran:'month'}),'S1','2026-03'), 90);
})();

// --- S6: 产业趋势库存(只在 all) 一起算 ---
await (async ()=>{
  const eng=await buildEng([
    {ch:'Online', per:'2026-03-01', type:'Sell Out', q:60},
    {ch:'Offline',per:'2026-03-01', type:'Sell Out', q:40},
    {ch:'全部',   per:'2026-03-01', type:'Inventory', q:300},
  ]);
  const t=eng.industryTrend({metric:'inv',gran:'month'});
  eq('S6 industryTrend inv last =300', t.cur[t.cur.length-1], 300);
})();

// --- S7: 用户真实场景 ALL 是独立渠道(318 != 4416+8631)，全加 ---
await (async ()=>{
  const eng=await buildEng([
    {ch:'Online', per:'2026-04-10', type:'Sell Out', q:4416},
    {ch:'Offline',per:'2026-04-10', type:'Sell Out', q:8631},
    {ch:'ALL',    per:'2026-04-10', type:'Sell Out', q:318},
  ]);
  eq('S7 sellOut 全加 =13365', qv(eng.query({metric:'sellOut',stackDim:'series',gran:'month'}),'S1','2026-04'), 13365);
})();

console.log(fail? ('CHANNEL TESTS: '+fail+' FAIL, '+pass+' pass') : ('CHANNEL TESTS: ALL PASS ('+pass+')'));
process.exit(fail?1:0);
})().catch(e => { console.error(e && e.stack || e); process.exit(1); });

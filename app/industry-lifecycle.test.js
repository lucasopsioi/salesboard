// 两代产品生命周期对齐对比(lifecycleCompare):
// 起点推断(首SO日/退SI日/显式覆盖)、固定长度桶对齐(日/周)、上市前SI只进累计不进桶、
// today汇总(累计/当前库存/DOS)、无数据侧兜底。
const fs=require('fs'),os=require('os'),path=require('path');
const E=require('../engine.js');
let f=0; const ok=(n,c)=>{console.log((c?'PASS ':'FAIL ')+n); if(!c)f++;};

const HEAD=['ManagementRegion','RepOffice','Country','OnlineOffline','ProductFamily','ProductLine','ProductSeries','Product','ProductModel','PeriodID','PSIType','Qty'];
const mk=(prod,d,type,q)=>['拉美大区','巴西国家办','巴西','Online','平板','Slate Tab',prod+'系列',prod,prod+'-M1',d,type,q].join(',');
const rows=[HEAD.join(',')];
// 上一代 GenA:2025-03-05 首SO(3/1有铺货SI=上市前),3/5=100,3/6=200,3/12=300(第2周)
rows.push(mk('GenA','2025-03-01','sellin',500));    // 上市前铺货,只进累计
rows.push(mk('GenA','2025-03-05','sellout',100));
rows.push(mk('GenA','2025-03-06','sellout',200));
rows.push(mk('GenA','2025-03-12','sellout',300));
rows.push(mk('GenA','2025-03-12','inv',900));
// 现一代 GenB:2026-05-10 首SO,5/10=150,5/11=250
rows.push(mk('GenB','2026-05-08','sellin',600));
rows.push(mk('GenB','2026-05-10','sellout',150));
rows.push(mk('GenB','2026-05-11','sellout',250));
rows.push(mk('GenB','2026-05-11','inv',800));
// GenC:只有SI没有SO(起点应退到SI首日)
rows.push(mk('GenC','2026-06-01','sellin',50));

const dir=fs.mkdtempSync(path.join(os.tmpdir(),'lc-'));
fs.writeFileSync(path.join(dir,'psi.csv'),'﻿'+rows.join('\n'),'utf8');
const eng=new E.Engine(fs.mkdtempSync(path.join(os.tmpdir(),'lc-ud-')));
eng.setFolder(dir);
(async()=>{
await eng.refresh();

const r=eng.lifecycleCompare({ a:{filters:{product:['GenA']}}, b:{filters:{product:['GenB']}}, gran:'day' });
// 起点推断
ok('A起点=首SO日 2025-03-05', r.a.launch==='2025-03-05');
ok('B起点=首SO日 2026-05-10', r.b.launch==='2026-05-10');
// 日粒度对齐:第1天=各自上市日
ok('A第1天 so=100', r.a.buckets[0].so===100 && r.a.buckets[0].date==='2025-03-05');
ok('B第1天 so=150', r.b.buckets[0].so===150 && r.b.buckets[0].date==='2026-05-10');
ok('A第2天 so=200 / B第2天 so=250', r.a.buckets[1].so===200 && r.b.buckets[1].so===250);
// 上市前SI:不进桶、进累计
ok('A桶内无上市前SI(第1天si=0)', r.a.buckets[0].si===0);
ok('A累计SI含铺货=500', r.a.today.cumSI===500);
ok('A累计SO=600', r.a.today.cumSO===600);
// 库存/today
ok('A当前库存=900(最新日快照)', r.a.today.inv===900);
ok('A已上市天数=8(3/5~3/12)', r.a.today.days===8);
ok('B当前库存=800', r.b.today.inv===800);
// DOS: A 近28天SO=600 → 900*28/600=42
ok('A当前DOS=42', r.a.today.dos===42);

// 周粒度:固定7天桶 A第1周=100+200=300,第2周=300
const rw=eng.lifecycleCompare({ a:{filters:{product:['GenA']}}, b:{filters:{product:['GenB']}}, gran:'week' });
ok('A第1周(7天桶) so=300', rw.a.buckets[0].so===300);
ok('A第2周 so=300', rw.a.buckets[1].so===300);
ok('B第1周 so=400', rw.b.buckets[0].so===400);

// 显式覆盖上市日:A 指定 2025-03-01 → 第1天无SO,3/5落在第5天
const ro=eng.lifecycleCompare({ a:{filters:{product:['GenA']}, launch:'2025-03-01'}, b:{filters:{product:['GenB']}}, gran:'day' });
ok('覆盖上市日后 A第1天 so=0', ro.a.launch==='2025-03-01' && ro.a.buckets[0].so===0);
ok('覆盖后 3/5 落第5天 so=100', ro.a.buckets[4].so===100);
ok('覆盖后铺货SI(3/1)进第1天桶', ro.a.buckets[0].si===500);

// 无SO产品:起点退SI首日
const rc=eng.lifecycleCompare({ a:{filters:{product:['GenC']}}, b:{filters:{product:['GenB']}}, gran:'day' });
ok('GenC起点退SI首日', rc.a.launch==='2026-06-01' && rc.a.buckets[0].si===50);

// 完全无数据侧:empty兜底
const rn=eng.lifecycleCompare({ a:{filters:{product:['不存在的']}}, b:{filters:{product:['GenB']}}, gran:'day' });
ok('无数据侧 empty=true 不炸', rn.a.empty===true && rn.b.empty===false);

console.log(f?('\n'+f+' FAILED'):'\nALL PASS'); process.exit(f?1:0);
})().catch(e=>{ console.error(e&&e.stack||e); process.exit(1); });

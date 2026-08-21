// 产业看板趋势/汇总：底表是"日"数据 —— 年/月/日按真实日历日归属，仅"周"视图用 ISO 周(周四)规则。
// 边界用例：2025-12-29/30/31 落在 ISO 2026-W01(周四=2026-01-01)，但其真实月份是 25年12月。
// 修复前(错误)：这三天被 isoThu 归到 26年1月 / 26累计；修复后：归到 25年12月 / 排除出 26累计。
const fs=require('fs'),os=require('os'),path=require('path');
const E=require('../engine.js');
let f=0; const ok=(n,c)=>{console.log((c?'PASS ':'FAIL ')+n); if(!c)f++;};

// --- 造一个"日"PSI CSV：仅 SellOut，跨年边界 ---
const HEAD=['ManagementRegion','RepOffice','Country','OnlineOffline','ProductFamily','ProductLine','ProductSeries','Product','ProductModel','PeriodID','PSIType','Qty'];
const base=['拉美大区','巴西国家办','巴西','Online','平板','Slate Pro','旗舰平板','ACME Slate Pro','Tarvos-W09'];
// 日期 -> SellOut 数量
const days=[
  ['2025-12-29',1000],['2025-12-30',2000],['2025-12-31',3000], // 真实=25年12月；ISO周四落在26年1月(诱发bug)
  ['2026-01-01',100],['2026-01-02',200],['2026-01-05',400],     // 真实=26年1月
];
const DEC_2025=1000+2000+3000;   // =6000  应归 25年12月 / 不进 26累计
const JAN_2026=100+200+400;      // =700   应归 26年1月 / 进 26累计
const rows=[HEAD.join(',')];
for(const [d,q] of days) rows.push([...base,d,'sellout',q].join(','));
// 去年同期(2025-01-01/02)用于 cumPrev 同期对比(可选，不强校验)
rows.push([...base,'2025-01-01','sellout',50].join(','));
// 另一型号(仅去年有量)：用于校验 对比模式下 KPI 同比仍取主范围去年、图表灰线才取对比范围
const base2=[...base]; base2[8]='Other-X09';
rows.push([...base2,'2025-01-02','sellout',999].join(','));

const dir=fs.mkdtempSync(path.join(os.tmpdir(),'indtrend-'));
fs.writeFileSync(path.join(dir,'psi-daily.csv'),'﻿'+rows.join('\n'),'utf8');
const udir=fs.mkdtempSync(path.join(os.tmpdir(),'indtrend-ud-'));
const eng=new E.Engine(udir);
eng.setFolder(dir);
(async () => {
await eng.refresh();

// sanity：store 已建、maxYmd=2026-01-05
ok('store built', !!eng.store && eng.store.n>0);
ok('maxYmd=20260105', eng.store && eng.store.maxYmd===20260105);

// --- industryTrend 月视图 ---
const tr=eng.industryTrend({gran:'month', metric:'sellOut'});
// curYear 必须是真实年 2026
ok('trend.curYear=2026 (actual)', tr.curYear===2026);
// 找到 1月(label '1月') 在 cur(今年=2026) 中的值
const jIdx=tr.periods.indexOf('1月');
ok('trend 含 1月 桶', jIdx>=0);
const janVal = jIdx>=0 ? tr.cur[jIdx] : null;
ok('trend 26年1月 = 仅真实1月日(700)，排除25-12边界日', janVal===JAN_2026);
// 12月不应出现在今年(2026)的桶里(它属于25年=prevYear，且不在今年范围)
const dIdx=tr.periods.indexOf('12月');
const decCurVal = dIdx>=0 ? tr.cur[dIdx] : 0;
ok('trend 12月 不被拉进今年(2026)桶', !decCurVal);

// --- 逐期 SI/SO 数组(KPI 区间口径的数据源) ---
ok('trend.soCur 逐期数组 1月=700', Array.isArray(tr.soCur) && tr.soCur[jIdx]===JAN_2026);
ok('trend.soPrev 主范围去年 1月=50+999', Array.isArray(tr.soPrev) && tr.soPrev[jIdx]===50+999);
ok('trend.siCur 存在且本例为0', Array.isArray(tr.siCur) && tr.siCur[jIdx]===0);
// 对比模式：图表灰线(prev)=对比范围去年；KPI 数组(soPrev)=主范围去年,不跟着换
const tr2=eng.industryTrend({gran:'month', metric:'sellOut', cmp:{model:['Other-X09']}});
const jIdx2=tr2.periods.indexOf('1月');
ok('cmp: 灰线=对比范围去年(999)', jIdx2>=0 && tr2.prev[jIdx2]===999);
ok('cmp: KPI数组仍=主范围去年(1049)', jIdx2>=0 && tr2.soPrev[jIdx2]===50+999);

// --- report 年累计：26累计 cumCur 只含真实2026日 ---
const rep=eng.report({groupDim:'line'});
ok('report.curYear=2026 (actual)', rep.curYear===2026);
ok('report.total 存在', !!rep.total);
const cumCur = rep.total ? rep.total.cumCur : null;
ok('report 26累计 cumCur = 仅真实2026日(700)，排除25-12边界日', cumCur===JAN_2026);

console.log(f?('\n'+f+' FAILED'):'\nALL PASS'); process.exit(f?1:0);
})().catch(e => { console.error(e && e.stack || e); process.exit(1); });

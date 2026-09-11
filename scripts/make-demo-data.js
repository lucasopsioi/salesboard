'use strict';
/* ============================================================
   造一套「像真的」演示数据 —— 拉美平板 + 音频与智能配件
   ------------------------------------------------------------
   为什么要造：原始底表含真实产品名，不能进 git；而内置 loadSample() 的样本
   太规整（所有产品同月开卖、都在售、无样机期），演示不出路标自动识别、
   退市判定、音频延迟报量这些真实形态。

   产品名全部是**脱敏代号**（Slate / SonicBuds …），与任何真实品牌无关。

   刻意埋进去的真实形态（这些是数据的价值所在，别当噪声删了）：
     · Slate 11 Pro    上市前有 2 个月样机激活（每周个位数）→ 验「样机不算上市」
     · Slate 12 Pro    2026-07 才上市              → 验「新品，可判月份不足」
     · Slate SE 10     2026 年中退市，尾部拖库存    → 验「退市判定 + 在清库存」
     · SonicArc        2026-02 上市，爬坡          → 验「缓慢爬坡 vs 样机」
     · 全部音频 SKU     最后 2 周没有 SO（人工延迟报量）→ 验「末端保护 / DOS 显—」
     · 12 月旺季、1 月回落、6 月年中大促           → 验同比与季节性
   ------------------------------------------------------------
   产出（都在 demo-data/，已在 .gitignore 里，随时重跑重建）：
     psi/PSI长表.csv              引擎主数据源
     flow/全流程库龄表.xlsx        → 全流程库存/DOS 列
     finance/财经实际表.xlsx        \
     finance/财经预测表.xlsx         > 经营分析 / 周报 M2
     finance/BP年度计划表.xlsx      /
   金额单位：实际=USD，预测=MUSD，BP=USD（与 finance-view.js 的 finUnits 默认一致）
   ============================================================ */
const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');

const OUT = path.join(__dirname, '..', 'demo-data');

/* ---------- 可复现的伪随机（数据进 .gitignore，靠种子保证每次重跑一致） ---------- */
let _seed = 20260821;
function rnd() { _seed = (_seed * 1103515245 + 12345) & 0x7fffffff; return _seed / 0x7fffffff; }
const jitter = amp => 1 + (rnd() * 2 - 1) * amp;
const ri = (a, b) => Math.floor(a + rnd() * (b - a + 1));

/* ---------- 地理 ---------- */
const REGION = 'LatAm Region';
const GEO = [
  { rep: 'Mexico Office', country: 'Mexico', w: 1.00, big: true },
  { rep: 'Brazil Office', country: 'Brazil', w: 0.92, big: true },
  { rep: 'Andes Office', country: 'Colombia', w: 0.46, big: true },
  { rep: 'Andes Office', country: 'Peru', w: 0.34, big: true },
  { rep: 'Southern Cone Office', country: 'Chile', w: 0.38, big: true },
  { rep: 'Southern Cone Office', country: 'Argentina', w: 0.30, big: true },
  { rep: 'Andes Office', country: 'Ecuador', w: 0.16, big: false },
  { rep: 'CenAm & Caribbean Office', country: 'Panama', w: 0.12, big: false },
  { rep: 'CenAm & Caribbean Office', country: 'Dominican Rep.', w: 0.11, big: false },
  { rep: 'CenAm & Caribbean Office', country: 'Guatemala', w: 0.10, big: false },
  { rep: 'CenAm & Caribbean Office', country: 'Costa Rica', w: 0.08, big: false },
  { rep: 'Southern Cone Office', country: 'Uruguay', w: 0.07, big: false },
];
const CHANNELS = [{ name: 'Online', share: 0.42 }, { name: 'Offline', share: 0.58 }];

/* ---------- 产品（全脱敏）----------
   层级：ProductLine(产业) > ProductFamily(系列) > ProductSeries(代号) > Product(传播名) > ProductModel(SKU)
   launch/eol 用「周序号」表达（0 = 2025-01-06 那周）；sample = 上市前的样机期周数 */
const W0 = Date.UTC(2025, 0, 6);          // 第 0 周（周一）
const WEEKS = 85;                          // 到 2026-08-17
const wkDate = i => new Date(W0 + i * 7 * 86400000);
const ymd = d => d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0') + '-' + String(d.getUTCDate()).padStart(2, '0');

const TABLET = '平板', AUDIO = '音频与智能配件';
const PRODUCTS = [
  // 平板
  { line: TABLET, family: 'Slate', series: 'Marlin', product: 'Slate 11', targetWk: 6.5, models: ['SLT11-W6128', 'SLT11-L6128'], base: 210, launch: 0, sample: 0, trend: -0.10, price: 289 },
  { line: TABLET, family: 'Slate', series: 'Coral', product: 'Slate 11 Pro', targetWk: 7.5, models: ['SLT11P-W8256'], base: 165, launch: 17, sample: 8, trend: 0.35, price: 429 },
  { line: TABLET, family: 'Slate SE', series: 'Dorado', product: 'Slate SE 11', targetWk: 5.5, models: ['SLTSE11-W4128'], base: 245, launch: 0, sample: 0, trend: 0.12, price: 179 },
  { line: TABLET, family: 'Slate SE', series: 'Anchovy', product: 'Slate SE 10', targetWk: 5.0, models: ['SLTSE10-W4064'], base: 190, launch: 0, sample: 0, trend: -0.55, eol: 60, price: 139 },
  { line: TABLET, family: 'Slate', series: 'Tarpon', product: 'Slate 12 Pro', targetWk: 8.0, models: ['SLT12P-W8256'], base: 120, launch: 78, sample: 4, trend: 0.60, price: 469 },
  // 音频与智能配件
  { line: AUDIO, family: 'SonicBuds', series: 'Otter', product: 'SonicBuds SE2', targetWk: 5.0, models: ['SB-SE2-WT'], base: 300, launch: 0, sample: 0, trend: -0.35, price: 39, audio: true },
  { line: AUDIO, family: 'SonicBuds', series: 'Puffin', product: 'SonicBuds SE3', targetWk: 6.0, models: ['SB-SE3-BK'], base: 280, launch: 13, sample: 3, trend: 0.28, price: 49, audio: true },
  { line: AUDIO, family: 'SonicBuds', series: 'Narwhal', product: 'SonicBuds SE4 ANC', targetWk: 6.5, models: ['SB-SE4A-BK'], base: 205, launch: 36, sample: 5, trend: 0.45, price: 69, audio: true },
  { line: AUDIO, family: 'SonicBuds Pro', series: 'Manta', product: 'SonicBuds Pro 4', targetWk: 7.0, models: ['SBP4-BK'], base: 95, launch: 0, sample: 0, trend: 0.08, price: 129, audio: true },
  { line: AUDIO, family: 'SonicArc', series: 'Kelp', product: 'SonicArc', targetWk: 7.5, models: ['SARC-GY'], base: 70, launch: 56, sample: 2, trend: 0.50, price: 99, audio: true },
];
// 小国家只卖走量款
const SMALL_OK = new Set(['Slate 11', 'Slate SE 11', 'SonicBuds SE2', 'SonicBuds SE3', 'SonicBuds Pro 4']);
const AUDIO_LAG_WEEKS = 2;                 // 音频人工延迟报量：最后 2 周没有 SO

/* 季节性：ISO 周 → 系数。12 月旺季、1 月回落、6 月年中大促 */
function seasonal(d) {
  const m = d.getUTCMonth() + 1;
  const S = { 1: 0.78, 2: 0.86, 3: 0.95, 4: 0.98, 5: 1.02, 6: 1.18, 7: 1.00, 8: 0.97, 9: 1.02, 10: 1.06, 11: 1.34, 12: 1.28 };
  return S[m] || 1;
}

/* ---------- 生成 PSI 长表 ---------- */
function buildPSI() {
  const head = ['大区', '国家办', '国家', '渠道', 'Product Family', 'Product Line', 'Product Series', 'Product', '产品型号', '会计期年月', 'PSIType', '本月实际'];
  const rows = [head];
  let n = 0;

  PRODUCTS.forEach(p => {
    p.models.forEach((model, mi) => {
      const modelW = mi === 0 ? 1 : 0.45;                 // 第二个 SKU 是配角
      GEO.forEach(g => {
        if (!g.big && !SMALL_OK.has(p.product)) return;
        CHANNELS.forEach(ch => {
          let stock = 0;
          for (let w = 0; w < WEEKS; w++) {
            const d = wkDate(w);
            const inSample = p.sample > 0 && w >= p.launch - p.sample && w < p.launch;
            const dead = p.eol != null && w > p.eol;
            if (w < p.launch - p.sample) continue;         // 上市前(含样机期之前)完全没有行

            // 动销
            let so;
            if (inSample) {
              so = ri(1, 4);                                // 样机/送测激活：每周个位数
            } else if (dead) {
              so = rnd() < 0.25 ? ri(0, 2) : 0;             // 退市后零星尾货
            } else {
              const age = w - p.launch;
              const ramp = Math.min(1, 0.35 + age / 10);    // 上市后 10 周爬满
              const drift = Math.pow(1 + p.trend / 52, age);
              so = p.base * g.w * ch.share * modelW * ramp * drift * seasonal(d) * jitter(0.16);
              so = Math.max(0, Math.round(so));
            }

            /* 铺货 = 补到目标库存水位（真实渠道就是按周转补货，不是卖多少补多少）。
               目标水位 = 目标周转周数 × 周动销；只补差额的一部分 → 库存会自然上下波动，
               DOS 也就落在 30~70 天这个真实区间，而不是贴着 0。 */
            const targetWk = p.targetWk * (g.big ? 1 : 1.25) * (ch.name === 'Offline' ? 1.15 : 0.85);
            const target = so * targetWk;
            let si;
            if (inSample) si = w === p.launch - p.sample ? ri(5, 15) : 0;
            else if (dead) si = 0;
            else if (w === p.launch) si = Math.round(target * 1.1 * jitter(0.1)) + 40;   // 上市首铺
            else {
              const pre = seasonal(wkDate(Math.min(WEEKS - 1, w + 2))) / seasonal(d);    // 旺季提前拉货
              si = Math.round((so * pre + (target - stock) * 0.35) * jitter(0.20));
              si = Math.max(0, si);
            }

            stock = Math.max(0, stock + si - so);
            if (dead && stock > 0) stock = Math.max(0, stock - Math.ceil(stock * 0.06));  // 退市后慢慢清，留尾巴

            const per = ymd(d);
            const dims = [REGION, g.rep, g.country, ch.name, p.family, p.line, p.series, p.product, model, per];
            // 音频延迟报量：最后 N 周只有 SI 与库存，没有 SO（缺周 = 没录，不是卖了 0）
            const soHidden = p.audio && w >= WEEKS - AUDIO_LAG_WEEKS;
            if (si > 0) { rows.push(dims.concat(['Sell In', si])); n++; }
            if (so > 0 && !soHidden) { rows.push(dims.concat(['Sell Out', so])); n++; }
            rows.push(dims.concat(['Inventory', stock])); n++;
          }
        });
      });
    });
  });
  return { head, rows, n };
}

/* ---------- 全流程库龄表（CDC+FDC，给「全流程库存/DOS」列） ---------- */
function buildFlow(psiStock) {
  const head = ['运行日期', '产品族', '产品系列', '产品型号', '要货国家办', '要货国家', '库存数量'];
  const rows = [head];
  const runDate = ymd(wkDate(WEEKS - 1));
  PRODUCTS.forEach(p => {
    if (p.eol != null) return;                              // 退市品不再备货
    p.models.forEach(model => {
      GEO.forEach(g => {
        if (!g.big && !SMALL_OK.has(p.product)) return;
        const ch = Math.round(p.base * g.w * 0.9 * jitter(0.3));   // 国家仓+FDC 大致等于一周多的量
        if (ch > 0) rows.push([runDate, p.family, p.series, model, g.rep, g.country, ch]);
      });
    });
  });
  return rows;
}

/* ---------- 财经三张表 ----------
   lv1=产业, lv2=大类, lv3=系列, lv4=产品（与 PSI 的层级刻意错位一级，真实底表就是这样）
   指标：净销售收入 / 销售毛利 / 收入量_终端（实际）| 收入量（预测、BP） */
const FIN_MONTHS_ACT = [];    // 202501..202606（财经比 PSI 滞后）
for (let y = 2025; y <= 2026; y++) for (let m = 1; m <= 12; m++) { const t = y * 100 + m; if (t <= 202606) FIN_MONTHS_ACT.push(t); }

function monthUnits(p, ym) {
  // 该产品该月在全拉美的终端销量（用与 PSI 同一套形态，量级对得上但不要求逐行相等）
  const y = Math.floor(ym / 100), m = ym % 100;
  const d = new Date(Date.UTC(y, m - 1, 15));
  const w = Math.round((d - W0) / (7 * 86400000));
  if (w < p.launch) return 0;
  if (p.eol != null && w > p.eol) return Math.round(ri(0, 40));
  const age = w - p.launch;
  const ramp = Math.min(1, 0.35 + age / 10);
  const drift = Math.pow(1 + p.trend / 52, age);
  const geoSum = GEO.reduce((s, g) => s + ((g.big || SMALL_OK.has(p.product)) ? g.w : 0), 0);
  return Math.round(p.base * geoSum * ramp * drift * seasonal(d) * 4.33 * jitter(0.08));
}

function buildFinActual() {
  const head = ['品牌', '大区', '国家办', '国家', '产品LV1', '产品LV2', '产品LV3', '产品LV4', '报表项中文名称', '报表项排序序号', '会计期年月', '本月实际'];
  const rows = [head];
  const reps = [...new Set(GEO.map(g => g.rep))];
  PRODUCTS.forEach(p => {
    const lv2 = p.line === TABLET ? '平板整机' : '智能穿戴与配件';
    FIN_MONTHS_ACT.forEach(ym => {
      const totUnits = monthUnits(p, ym);
      if (!totUnits) return;
      reps.forEach(rep => {
        const repW = GEO.filter(g => g.rep === rep && (g.big || SMALL_OK.has(p.product))).reduce((s, g) => s + g.w, 0);
        const allW = GEO.reduce((s, g) => s + ((g.big || SMALL_OK.has(p.product)) ? g.w : 0), 0);
        if (!repW) return;
        const units = Math.round(totUnits * repW / allW);
        if (!units) return;
        const nsip = p.price * (0.60 + rnd() * 0.06);                 // 净单价 ≈ RRP 的 6 成
        const rev = Math.round(units * nsip);
        const gm = Math.round(rev * (0.17 + rnd() * 0.09));           // 销毛率 17%~26%
        const base = ['BrandX', REGION, rep, '', p.line, lv2, p.family, p.product];
        rows.push(base.concat(['净销售收入', 10, ym, rev]));
        rows.push(base.concat(['销售毛利', 20, ym, gm]));
        rows.push(base.concat(['收入量_终端', 30, ym, units]));
      });
    });
  });
  return rows;
}

function buildFinForecast() {
  // 宽表：维度列 + 12 个月份列；单位 MUSD
  const months = [];
  for (let m = 1; m <= 12; m++) months.push('2026年' + m + '月');
  const head = ['品牌', '大区', '国家办', '产品LV1', '产品LV2', '产品LV3', '产品LV4', '产品型号', '指标名称', '指标序号', '金额数量单位', '版本', '预测场景'].concat(months);
  const rows = [head];
  const reps = [...new Set(GEO.map(g => g.rep))];
  PRODUCTS.forEach(p => {
    const lv2 = p.line === TABLET ? '平板整机' : '智能穿戴与配件';
    reps.forEach(rep => {
      const repW = GEO.filter(g => g.rep === rep && (g.big || SMALL_OK.has(p.product))).reduce((s, g) => s + g.w, 0);
      const allW = GEO.reduce((s, g) => s + ((g.big || SMALL_OK.has(p.product)) ? g.w : 0), 0);
      if (!repW) return;
      const mk = (metric, order, unit, fn) => {
        const vals = months.map((mm, i) => {
          const ym = 2026 * 100 + (i + 1);
          const u = Math.round(monthUnits(p, ym) * repW / allW);
          return u ? fn(u) : 0;
        });
        if (vals.every(v => !v)) return;
        rows.push(['BrandX', REGION, rep, p.line, lv2, p.family, p.product, p.models[0], metric, order, unit, 'Region working draft', 'Jun forecast'].concat(vals));
      };
      // 预测普遍比实际乐观一点（这样达成率会在 85%~95%，看起来像真的）
      mk('净销售收入', 10, 'MUSD', u => +(u * p.price * 0.63 * 1.08 / 1e6).toFixed(4));
      mk('销售毛利', 20, 'MUSD', u => +(u * p.price * 0.63 * 0.22 * 1.08 / 1e6).toFixed(4));
      mk('收入量', 30, '台', u => Math.round(u * 1.08));
    });
  });
  return rows;
}

function buildFinBP() {
  // 长表；单位 USD（与 finance-view.js 的 finUnits.bp='USD' 默认一致 → BP 达成率开箱即正常）
  const head = ['版本中文名', '大区中文名', '国家办中文名', '产品LV1中文名', '产品LV2中文名', '产品LV3中文名', '产品LV4中文名', '报表项中文名', '月份', '值'];
  const rows = [head];
  const reps = [...new Set(GEO.map(g => g.rep))];
  PRODUCTS.forEach(p => {
    const lv2 = p.line === TABLET ? '平板整机' : '智能穿戴与配件';
    reps.forEach(rep => {
      const repW = GEO.filter(g => g.rep === rep && (g.big || SMALL_OK.has(p.product))).reduce((s, g) => s + g.w, 0);
      const allW = GEO.reduce((s, g) => s + ((g.big || SMALL_OK.has(p.product)) ? g.w : 0), 0);
      if (!repW) return;
      for (let m = 1; m <= 12; m++) {
        const ym = 2026 * 100 + m;
        const u = Math.round(monthUnits(p, ym) * repW / allW * 1.15);   // BP 比实际再高一档
        if (!u) continue;
        const base = ['2026 BP', REGION, rep, p.line, lv2, p.family, p.product];
        rows.push(base.concat(['净销售收入', ym, Math.round(u * p.price * 0.63)]));
        rows.push(base.concat(['销售毛利', ym, Math.round(u * p.price * 0.63 * 0.23)]));
        rows.push(base.concat(['收入量', ym, u]));
      }
    });
  });
  return rows;
}

/* ---------- 落盘 ---------- */
function writeCsv(file, rows) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const esc = v => { const s = String(v == null ? '' : v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  // BOM：Excel 打开不乱码；引擎 parseCSV 也会主动剥掉
  fs.writeFileSync(file, '﻿' + rows.map(r => r.map(esc).join(',')).join('\r\n'), 'utf8');
}
function writeXlsx(file, rows, sheetName) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), sheetName || 'Sheet1');
  XLSX.writeFile(wb, file);
}

const psi = buildPSI();
writeCsv(path.join(OUT, 'psi', 'PSI长表.csv'), psi.rows);
writeXlsx(path.join(OUT, 'flow', '全流程库龄表.xlsx'), buildFlow(), '库龄');
writeXlsx(path.join(OUT, 'finance', '财经实际表.xlsx'), buildFinActual(), '实际');
writeXlsx(path.join(OUT, 'finance', '财经预测表.xlsx'), buildFinForecast(), '预测');
writeXlsx(path.join(OUT, 'finance', 'BP年度计划表.xlsx'), buildFinBP(), 'BP');

const sz = f => { try { return (fs.statSync(f).size / 1024).toFixed(0) + ' KB'; } catch (e) { return '?'; } };
console.log('PSI 长表          ' + (psi.rows.length - 1) + ' 行   ' + sz(path.join(OUT, 'psi', 'PSI长表.csv')));
console.log('全流程库龄表      ' + sz(path.join(OUT, 'flow', '全流程库龄表.xlsx')));
console.log('财经实际/预测/BP  ' + sz(path.join(OUT, 'finance', '财经实际表.xlsx')) + ' / '
  + sz(path.join(OUT, 'finance', '财经预测表.xlsx')) + ' / ' + sz(path.join(OUT, 'finance', 'BP年度计划表.xlsx')));
console.log('输出目录: ' + OUT);

/* fixtures 生成器（可重复执行，幂等覆盖）：
 *   fixtures/sample-prices.xlsx      —— 会话连通性测试场景 E 的上传样例（纯虚构竞品价格监测表，双 sheet）
 *   fixtures/虚拟成本底表_样例.xlsx —— cost-base.test.js 需要的成本底表（Strix-T02 基线 32 逐月上涨）
 *   fixtures/虚拟概算表_样例.xlsx   —— concept-import.test.js 需要的概算表（4 产品，墨西哥 Strix-T02 为断言锚点）
 * 用法：node eval/make-fixtures.js
 */
'use strict';
const path = require('path');
const fs = require('fs');
const XLSX = require('xlsx');

const dir = path.join(__dirname, '..', 'fixtures');
fs.mkdirSync(dir, { recursive: true });

// ---------- 1) 竞品价格监测表（全虚构品牌/型号） ----------
{
  const wb = XLSX.utils.book_new();
  const tablet = [
    ['品牌', '型号', '屏幕', '门店价USD', '促销价USD', '监测日期'],
    ['辰星', '辰星 X11', '11寸', 199, 179, '2026-08-28'],
    ['蓝鲸', '蓝鲸 Pad 9', '10.4寸', 229, 209, '2026-08-28'],
    ['峰雀', '峰雀 Tab A8', '10.1寸', 249, 235, '2026-08-27'],
    ['澄海', '澄海 M6', '12寸', 329, 299, '2026-08-28'],
  ];
  const audio = [
    ['品牌', '型号', '类型', '门店价USD', '促销价USD', '监测日期'],
    ['星潮', '星潮 Buds', '入耳TWS', 39, 29, '2026-08-28'],
    ['蓝鲸', '蓝鲸 AirDots 3', '入耳TWS', 49, 45, '2026-08-27'],
    ['峰雀', '峰雀 FreePods', '半入耳', 69, 59, '2026-08-28'],
    ['澄海', '澄海 StudioGo', '头戴', 129, 115, '2026-08-28'],
  ];
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(tablet), '平板竞品价');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(audio), '音频竞品价');
  XLSX.writeFile(wb, path.join(dir, 'sample-prices.xlsx'));
  console.log('written fixtures/sample-prices.xlsx');
}

// ---------- 2) 虚拟成本底表（cost-base.test.js 的断言锚点） ----------
// 要求：Strix-T02 存在；202606 基线成本 32；成本逐月缓涨（202707 > 202607）；月份从 202606 起
{
  const rows = [['产品系列', '产品型号', '日期', '成本USD']];
  let c = 32;
  for (let ym = 0; ym < 15; ym++) {
    const y = 2026 + Math.floor((5 + ym) / 12);
    const m = ((5 + ym) % 12) + 1;
    rows.push(['Strix', 'Strix-T02', y + '/' + m + '/1', +c.toFixed(2)]);
    c += 0.4;
  }
  rows.push(['Strix', 'Strix-T01', '2026/6/1', 28]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), '成本底表');
  XLSX.writeFile(wb, path.join(dir, '虚拟成本底表_样例.xlsx'));
  console.log('written fixtures/虚拟成本底表_样例.xlsx');
}

// ---------- 3) 虚拟概算表（concept-import.test.js 的断言锚点） ----------
// 表结构是 parseConceptTable 的硬约定：行 = 字段语义，列 = 产品成对出现。
//   · A/B/C 三列是标签列；第 p 个产品占 c1 = 3 + 2p、c2 = 4 + 2p 两列。
//   · c1 是「当地币 / 率」语义列，c2 是 USD 列：价格链放当地币，率类放小数率，P&L 行 c1 放占 NSIP 的率。
//   · productCount = floor((maxCols - 3) / 2)，所以每行都补齐到 11 列（3 + 4×2），表宽才等于 4 个产品。
// 解析器里两处「按位置消歧」直接决定了本表的形状，改动前先读 concept-import.js 的 resolveRows()：
//   · 负向收入块：A 列每行都重复写「负向收入」——价保/临时激励只能靠它进分支；B 列则模拟合并单元格，
//     只有块首写「零售」「渠道」、续行留空，解析器靠 seg 状态延续，同名的两行「有条件返利」才分得出
//     rebRetailCond / rebChanCond。联合营销反过来：A 列必须留空，否则会被负向收入分支吞掉。
//   · 商务因子块：前 6 行 A 列写「商务因子」，末行「其他」的 A 列必须留空（A 列有「商务因子」会被上一个
//     分支 continue 掉），且必须排在外汇风险之后——解析器见到 cfFxRisk 已就位才认领 b === '其他' 为 cfOther。
{
  const r2 = (x) => +x.toFixed(2), r4 = (x) => +x.toFixed(4);

  // 每个产品只填「输入」，价格链和 P&L 全部推导，改任何一档率下面的锚点自检都会兜住。
  // cfRates 顺序固定：基本服务费 / 备机 / 运保费 / 关税 / 样机Dummy / 外汇风险 / 其他。
  const PRODUCTS = [
    { // ← concept-import.test.js 的锚点行：NSIP≈48.19、销毛率≈0.258、器件成本 32、临促 0.10、渠道有条件返利 0.03
      scene: '智慧办公', country: '墨西哥', product: 'Strix Tab T02', offering: 'Strix-T02-WiFi-64G', sku: 'Strix-T02',
      custClass: 'Distributor', custGroup: 'ACME LATAM DIST', onoff: 'Online', customer: 'Mexico ACME Store 2C_FSD',
      incoterm: 'FOB Shenzhen', launch: '2026-06', sellinEnd: '2027-05', currency: 'MXN', fx: 17.32, shipVolK: 45,
      rrp: 1599, vat: 0.16, retailFront: 0.20, channelFront: 0.05, importTax: 0.03, prepayDisc: 0.01,
      rebRetailCond: 0, rebRetailUncond: 0, rebChanCond: 0.03, rebChanUncond: 0.01,
      priceProtect: 0.003, tempIncentive: 0.10, jointMkt: 0.02,
      excessiveSvc: 0.005, otherDeduct: 0, customCost: 0,
      cfRates: [0.0176, 0.0037, 0.0280, 0.0129, 0.0044, 0.0072, 0.0044], deviceCost: 32.00,
      prodMktg: 1.20, opCapital: 0.35, platformIndirect: 1.05, regionPublic: 0.85, rdWaterline: 2.40,
    },
    { // 同 SKU 走线下零售：前向利润更厚、返利落在零售段（用来对照负向收入的段消歧）
      scene: '智慧办公', country: '墨西哥', product: 'Strix Tab T02', offering: 'Strix-T02-WiFi-64G', sku: 'Strix-T02',
      custClass: 'Retailer', custGroup: 'ACME MX RETAIL', onoff: 'Offline', customer: 'Corella',
      incoterm: 'FOB Shenzhen', launch: '2026-06', sellinEnd: '2027-05', currency: 'MXN', fx: 17.32, shipVolK: 120,
      rrp: 1599, vat: 0.16, retailFront: 0.285, channelFront: 0.06, importTax: 0.03, prepayDisc: 0.005,
      rebRetailCond: 0.02, rebRetailUncond: 0.01, rebChanCond: 0, rebChanUncond: 0,
      priceProtect: 0.005, tempIncentive: 0.04, jointMkt: 0.01,
      excessiveSvc: 0.004, otherDeduct: 0, customCost: 0.60,
      cfRates: [0.0180, 0.0038, 0.0302, 0.0132, 0.0060, 0.0074, 0.0038], deviceCost: 32.00,
      prodMktg: 1.45, opCapital: 0.32, platformIndirect: 1.02, regionPublic: 0.83, rdWaterline: 2.34,
    },
    { // 换国家/币种/税率：COP、IVA 19%、进口关税 5%；SKU 对齐成本底表里的 Strix-T01（基线 28）
      scene: '影音娱乐', country: '哥伦比亚', product: 'Strix Tab T01', offering: 'Strix-T01-WiFi-32G', sku: 'Strix-T01',
      custClass: 'Distributor', custGroup: 'ACME LATAM DIST', onoff: 'Offline', customer: 'Intradex CO',
      incoterm: 'CIF Bogota', launch: '2026-07', sellinEnd: '2027-06', currency: 'COP', fx: 4180, shipVolK: 18,
      rrp: 349900, vat: 0.19, retailFront: 0.19, channelFront: 0.09, importTax: 0.05, prepayDisc: 0.01,
      rebRetailCond: 0, rebRetailUncond: 0, rebChanCond: 0.025, rebChanUncond: 0.005,
      priceProtect: 0.004, tempIncentive: 0.03, jointMkt: 0.03,
      excessiveSvc: 0.006, otherDeduct: 0.002, customCost: 0,
      cfRates: [0.0171, 0.0036, 0.0376, 0.0217, 0.0041, 0.0096, 0.0034], deviceCost: 28.00,
      prodMktg: 0.95, opCapital: 0.41, platformIndirect: 0.92, regionPublic: 0.78, rdWaterline: 2.10,
    },
    { // 运营商单：智利对华零关税、联合营销吃得重、定制成本非零
      scene: '移动办公', country: '智利', product: 'Strix Tab T02', offering: 'Strix-T02-LTE-128G', sku: 'Strix-T02',
      custClass: 'Operator', custGroup: 'ACME CL OPERATOR', onoff: 'Offline', customer: 'Telandes CL',
      incoterm: 'DDP Santiago', launch: '2026-08', sellinEnd: '2027-07', currency: 'CLP', fx: 905, shipVolK: 26,
      rrp: 89990, vat: 0.19, retailFront: 0.16, channelFront: 0.03, importTax: 0, prepayDisc: 0.015,
      rebRetailCond: 0, rebRetailUncond: 0, rebChanCond: 0.04, rebChanUncond: 0.02,
      priceProtect: 0.006, tempIncentive: 0.06, jointMkt: 0.05,
      excessiveSvc: 0.008, otherDeduct: 0, customCost: 1.20,
      cfRates: [0.0163, 0.0036, 0.0232, 0.0018, 0.0044, 0.0069, 0.0035], deviceCost: 32.00,
      prodMktg: 1.85, opCapital: 0.44, platformIndirect: 1.18, regionPublic: 0.96, rdWaterline: 2.62,
    },
  ];

  // 价格链：RRP →(剥 VAT) 不含税RRP →(零售前向) STP →(渠道前向) SIP →(进口税费+折扣+返利+临促+联营) NSIP
  //         →(减商务因子) FOB净收入 →(减器件成本) 销毛 →(减营销/资产) 贡献毛利 →(减平台/公摊/研发) 区域贡献
  const D = PRODUCTS.map(p => {
    const exVat = p.rrp / (1 + p.vat), vatAmt = p.rrp - exVat;
    const stp = exVat * (1 - p.retailFront), sip = stp * (1 - p.channelFront);
    const deduct = p.importTax + p.prepayDisc + p.rebRetailCond + p.rebRetailUncond +
      p.rebChanCond + p.rebChanUncond + p.priceProtect + p.tempIncentive + p.jointMkt;
    const nsipLocal = sip * (1 - deduct), nsipUsd = r2(nsipLocal / p.fx);
    const cfUsd = p.cfRates.map(r => r2(r * nsipUsd));
    const cfTotalRate = r4(p.cfRates.reduce((a, b) => a + b, 0));
    const cfTotalUsd = r2(cfUsd.reduce((a, b) => a + b, 0));
    const fobNet = r2(nsipUsd - cfTotalUsd), gmUsd = r2(fobNet - p.deviceCost);
    const contribUsd = r2(gmUsd - p.prodMktg - p.opCapital);
    const regionContribUsd = r2(contribUsd - p.platformIndirect - p.regionPublic - p.rdWaterline);
    const rate = (usd) => r4(usd / nsipUsd);
    return Object.assign({}, p, {
      exVat: r2(exVat), vatAmt: r2(vatAmt), stp: r2(stp), sip: r2(sip), nsipLocal: r2(nsipLocal), nsipUsd,
      cfUsd, cfTotalRate, cfTotalUsd, fobNet, fobNetRate: rate(fobNet), gmUsd, gmRate: rate(gmUsd),
      contribUsd, contribRate: rate(contribUsd), regionContribUsd, regionContribRate: rate(regionContribUsd),
      id: [p.country, p.sku, p.custClass, p.onoff, p.customer].join('|'),
    });
  });

  // 锚点自检：上面任何一档率手滑，这里当场炸，而不是等 concept-import.test.js 报 FAIL
  const mx = D[0];
  const near = (a, b, t, n) => { if (!(Math.abs(a - b) <= t)) throw new Error('概算表锚点漂移：' + n + ' = ' + a + '，应 ≈ ' + b + ' (±' + t + ')'); };
  near(mx.nsipUsd, 48.19, 0.1, 'NSIP');
  near(mx.gmRate, 0.258, 0.003, '销毛率');
  near(mx.fobNet - mx.gmUsd, 32.0, 0.1, 'baselineDeviceCost');
  near(mx.vatAmt / mx.exVat, 0.16, 1e-3, 'VAT率');
  near(mx.retailFront, 0.20, 1e-6, '零售前向利润率');
  near(mx.channelFront, 0.05, 1e-6, '渠道前向利润率');
  near(mx.tempIncentive, 0.10, 1e-6, '临时激励');
  near(mx.rebChanCond, 0.03, 1e-6, '渠道有条件返利');
  near(mx.rebRetailCond, 0, 1e-6, '零售有条件返利');
  if (mx.id !== '墨西哥|Strix-T02|Distributor|Online|Mexico ACME Store 2C_FSD') throw new Error('概算表锚点漂移：id = ' + mx.id);

  // pick(d) 返回该产品的 [c1, c2]；每行都补满 3 + 4×2 = 11 列，表宽即产品数。
  const row = (a, b, c, pick) => {
    const out = [a, b, c];
    D.forEach((d, i) => { const v = pick ? pick(d, i) : ['', '']; out.push(v[0] == null ? '' : v[0], v[1] == null ? '' : v[1]); });
    return out;
  };
  const blank = () => row('', '', '');
  const cf = (i) => (d) => [d.cfRates[i], d.cfUsd[i]];

  const rows = [
    row('产品概算表（虚拟样例 · 非真实数据）', '', ''),
    blank(),
    row('品牌', '', '', () => ['ACME', '']),
    row('场景', '', '', d => [d.scene, '']),
    row('大区', '', '', () => ['拉美大区', '']),
    row('国家', '', '', d => [d.country, '']),
    row('BU/系列', '', '', d => ['平板BU', d.product.split(' ')[0] + ' 系列']),
    row('产品', '', '', d => [d.product, '']),
    row('Offering', '', '', d => [d.offering, '']),
    row('SKU', '', '', d => [d.sku, '']),
    row('客户分类', '', '', d => [d.custClass, '']),
    row('Online/Offline', '', '', d => [d.onoff, '']),
    row('授权客户组', '', '', d => [d.custGroup, '']),
    row('直接客户', '', '', d => [d.customer, '']),
    row('贸易术语', '', '', d => [d.incoterm, '']),
    row('上市时间 / Sell-in 结束', '', '', d => [d.launch, d.sellinEnd]),
    row('币种 / 汇率', '', '', d => [d.currency, d.fx]),
    row('生命周期发货量(K台)', '', '', d => [d.shipVolK, '']),
    blank(),
    row('RRP(含税·当地币)', '', '', d => [d.rrp, '']),
    row('VAT(当地币)', '', '', d => [d.vatAmt, '']),
    row('不含税RRP(当地币)', '', '', d => [d.exVat, '']),
    row('零售前向利润(率)', '', '', d => [d.retailFront, '']),
    row('建议STP(当地币)', '', '', d => [d.stp, '']),
    row('渠道前向利润(率)', '', '', d => [d.channelFront, '']),
    row('建议SIP(当地币)', '', '', d => [d.sip, '']),
    row('进口税费(率)', '', '', d => [d.importTax, '']),
    row('预付款折扣(率)', '', '', d => [d.prepayDisc, '']),
    // 负向收入块：A 列逐行重复；B 列模拟合并单元格，续行留空靠 seg 延续段
    row('负向收入', '零售', '有条件返利(率)', d => [d.rebRetailCond, '']),
    row('负向收入', '', '无条件返利(率)', d => [d.rebRetailUncond, '']),
    row('负向收入', '渠道', '有条件返利(率)', d => [d.rebChanCond, '']),
    row('负向收入', '', '无条件返利(率)', d => [d.rebChanUncond, '']),
    row('负向收入', '价保', '(率)', d => [d.priceProtect, '']),
    row('负向收入', '临时激励', '(率)', d => [d.tempIncentive, '']),
    row('', '联合营销费', '(率)', d => [d.jointMkt, '']),   // A 列必须留空，否则被负向收入分支吃掉
    row('超标服务费(率)', '', '', d => [d.excessiveSvc, '']),
    row('其他收入抵减(率)', '', '', d => [d.otherDeduct, '']),
    row('定制成本(USD/台)', '', '', d => [d.customCost, '']),
    blank(),
    row('NSIP(当地币/USD)', '', '', d => [d.nsipLocal, d.nsipUsd]),
    // 商务因子块：前 6 行 A 列写标签，末行「其他」留空由解析器按位置认领
    row('商务因子', '基本服务费', '(率/USD)', cf(0)),
    row('商务因子', '备机', '(率/USD)', cf(1)),
    row('商务因子', '运保费', '(率/USD)', cf(2)),
    row('商务因子', '关税', '(率/USD)', cf(3)),
    row('商务因子', '样机/Dummy', '(率/USD)', cf(4)),
    row('商务因子', '外汇风险', '(率/USD)', cf(5)),
    row('', '其他', '(率/USD)', cf(6)),
    row('商务因子汇总', '', '(率/USD)', d => [d.cfTotalRate, d.cfTotalUsd]),
    blank(),
    row('FOB净收入(率/USD)', '', '', d => [d.fobNetRate, d.fobNet]),
    row('销毛(率/USD)', '', '', d => [d.gmRate, d.gmUsd]),
    row('产品营销费(率/USD)', '', '', d => [r4(d.prodMktg / d.nsipUsd), d.prodMktg]),
    row('运营资产成本(率/USD)', '', '', d => [r4(d.opCapital / d.nsipUsd), d.opCapital]),
    row('贡献毛利(率/USD)', '', '', d => [d.contribRate, d.contribUsd]),
    row('平台间接费用(率/USD)', '', '', d => [r4(d.platformIndirect / d.nsipUsd), d.platformIndirect]),
    row('区域公共分摊(率/USD)', '', '', d => [r4(d.regionPublic / d.nsipUsd), d.regionPublic]),
    row('研发吃水线(率/USD)', '', '', d => [r4(d.rdWaterline / d.nsipUsd), d.rdWaterline]),
    row('区域贡献利润(率/USD)', '', '', d => [d.regionContribRate, d.regionContribUsd]),
  ];

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), '概算表');
  XLSX.writeFile(wb, path.join(dir, '虚拟概算表_样例.xlsx'));
  console.log('written fixtures/虚拟概算表_样例.xlsx (' + D.length + ' 产品，锚点 ' + mx.id + ' NSIP=' + mx.nsipUsd + ' 销毛率=' + mx.gmRate + ')');
}

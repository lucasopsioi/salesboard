/* fixtures 生成器（可重复执行，幂等覆盖）：
 *   fixtures/sample-prices.xlsx      —— 会话连通性测试场景 E 的上传样例（纯虚构竞品价格监测表，双 sheet）
 *   fixtures/虚拟成本底表_样例.xlsx —— cost-base.test.js 需要的成本底表（Strix-T02 基线 32 逐月上涨）
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

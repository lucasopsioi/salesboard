/* ============================================================
   Salesboard 数据引擎 — 聚合入口 (aggregator)
   实现已迁至 engine-core.js（共享核心 + Engine 类）。
   后续 engine-{psi,report,finance,industry,custom}.js 会在此 require
   以把各模块的原型方法挂回 Engine。当前为行为保持的薄聚合层。
   ============================================================ */
'use strict';
require('./engine-core');
require('./engine-psi');   // attach Engine.prototype.query / .agg
require('./engine-report'); // attach Engine.prototype.report
require('./engine-finance'); // attach Engine.prototype.finance / .financeKpi / .financeAchieve / .financeBP / .financeBPBoard
require('./engine-industry'); // attach Engine.prototype.industryBoard / .industryTrend (+ _industryDim/_industryVals/_families/_industryFinance)
require('./engine-custom'); // attach Engine.prototype.custom / .aggIdc
module.exports = require('./engine-core');

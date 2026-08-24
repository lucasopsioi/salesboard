'use strict';
/* ============================================================
   eval/engine-tools.js —— 评测专用工具层
   把 AI 面板的工具注册表在纯 Node 里重建一份：直连引擎实例，不走 IPC。
   语义与 app/ai-context.js 的 buildToolRegistry 逐条对齐（options 的
   contains/limit 后处理、report 的 groupDim 默认值、query 的 stackDim
   必填报错文案都保持一致）——评测测的就是线上那条链路，工具层不能走样。
   仅三个 UI 态工具（boardState / sosimSummary / pricingLibRecords）
   返回与"无界面状态"时相同形态的 {error}，模型侧行为一致。
   ============================================================ */
const path = require('path');
const fs = require('fs');
const E = require(path.join(__dirname, '..', 'engine.js'));
const AD = require(path.join(__dirname, '..', 'app', 'ai-context.js'));

const ROOT = path.join(__dirname, '..');
/* 与 app/ai-context.js:19 保持一致（那边未导出，改那边记得同步这里） */
const FIN_UNITS = { actual: 'USD', forecast: 'MUSD', bp: 'USD' };
const FIN_QTY = { actual: '台', forecast: '台', bp: '台' };

async function mountEngine(opt) {
  const cache = (opt && opt.cacheDir) || path.join(__dirname, '.engine-cache');
  fs.mkdirSync(cache, { recursive: true });
  const engine = new E.Engine(cache);
  engine.setInvFolder(path.join(ROOT, 'demo-data', 'flow'));
  engine.setFinFolder(path.join(ROOT, 'demo-data', 'finance'));
  const r = await engine.refresh(path.join(ROOT, 'demo-data', 'psi'), () => {});
  if (r && r.error) throw new Error('engine.refresh 失败: ' + r.error);
  return engine;
}

function buildRegistry(engine) {
  const DIM = AD.DIM_KEYS;
  return {
    meta: async () => engine.meta(),
    options: async (a) => {
      a = a || {};
      const f = a.field;
      if (!f || !DIM.includes(f)) return { error: 'field 必填，且只能是：' + DIM.join('/') };
      let vals = engine.options(f, a.filters || {});
      if (!Array.isArray(vals)) return { error: '取值失败' };
      const total = vals.length;
      if (a.contains) { const kw = String(a.contains).toLowerCase(); vals = vals.filter(v => String(v).toLowerCase().indexOf(kw) >= 0); }
      const lim = Math.max(1, Math.min(200, +a.limit || 60));
      return { field: f, 命中: vals.length, 全量: total, 取值: vals.slice(0, lim), 截断: vals.length > lim };
    },
    report: async (a) => {
      a = a || {};
      if (a.groupDim && !DIM.includes(a.groupDim)) return { error: 'groupDim 只能是：' + DIM.join('/') };
      return engine.report({ groupDim: a.groupDim || 'series', filters: a.filters || {}, weeks: a.weeks || 9, fromW: a.fromW, toW: a.toW });
    },
    query: async (a) => {
      a = a || {};
      if (!a.stackDim || !DIM.includes(a.stackDim)) {
        return { error: 'stackDim 必填（引擎要求），只能是：' + DIM.join('/') + '。想看整体也要挑一个维度，例如 country。' };
      }
      return engine.query({ metric: a.metric || 'sellOut', gran: a.gran || 'month', filters: a.filters || {}, stackDim: a.stackDim, from: a.from, to: a.to, limit: a.limit });
    },
    financeCustom: async (a) => engine.financeCustom(Object.assign({ finUnits: FIN_UNITS, finQtyUnits: FIN_QTY }, a || {})),
    financeOverview: async (a) => engine.financeOverview(Object.assign({ finUnits: FIN_UNITS, finQtyUnits: FIN_QTY }, a || {})),
    financeProductBoard: async (a) => engine.financeProductBoard(Object.assign({ finUnits: FIN_UNITS, finQtyUnits: FIN_QTY }, a || {})),
    financeRepBoard: async (a) => engine.financeRepBoard(Object.assign({ finUnits: FIN_UNITS, finQtyUnits: FIN_QTY }, a || {})),
    agg: async (a) => engine.agg(a || {}),
    aggIdc: async (a) => {
      a = a || {};
      if (a.field && typeof engine.idcOptions === 'function') return engine.idcOptions(a.field, a.filters || {});
      return engine.agg(Object.assign({}, a, { dataset: 'idc' }));
    },
    industryBoard: async (a) => engine.industryBoard(a || {}),
    industryTrend: async (a) => engine.industryTrend(a || {}),
    /* —— UI 态工具：评测环境无界面，返回与真实"无状态"时一致的形态 —— */
    boardState: async () => ({ error: '该看板没有可读的界面状态' }),
    sosimSummary: async () => ({ error: '库存推演未初始化' }),
    pricingLibRecords: async () => ({ error: '定价库未初始化' }),
  };
}

module.exports = { mountEngine, buildRegistry, FIN_UNITS, FIN_QTY, ROOT };

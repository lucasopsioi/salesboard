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
  opt = opt || {};
  const cache = opt.cacheDir || path.join(__dirname, '.engine-cache');
  fs.mkdirSync(cache, { recursive: true });
  const engine = new E.Engine(cache);
  // 默认 demo-data；传 opt.{psi,fin,flow} 可挂任意数据目录（含真实底表——本地核验用）
  engine.setInvFolder(opt.flow || path.join(ROOT, 'demo-data', 'flow'));
  engine.setFinFolder(opt.fin || path.join(ROOT, 'demo-data', 'finance'));
  const r = await engine.refresh(opt.psi || path.join(ROOT, 'demo-data', 'psi'), () => {});
  if (r && r.error) throw new Error('engine.refresh 失败: ' + r.error);
  return engine;
}

function buildRegistry(engine) {
  const DIM = AD.DIM_KEYS;
  /* 与 app/ai-context.js 的 checkFilterDims 保持一致（改那边记得同步这里） */
  function checkFilterDims(filters) {
    if (!filters || typeof filters !== 'object') return null;
    for (const k of Object.keys(filters)) {
      if (!DIM.includes(k)) continue;
      const vals = [].concat(filters[k] || []).filter(v => v != null && v !== '');
      if (!vals.length) continue;
      let opts; try { opts = engine.options(k, {}); } catch (e) { return null; }
      if (!Array.isArray(opts)) continue;
      for (const v of vals) {
        if (opts.indexOf(v) >= 0) continue;
        for (const d of DIM) {
          if (d === k) continue;
          let o2; try { o2 = engine.options(d, {}); } catch (e) { o2 = null; }
          if (Array.isArray(o2) && o2.indexOf(v) >= 0) {
            return { error: '『' + v + '』不是 ' + k + ' 的取值，它是 ' + d + ' 的取值——请放进 filters.' + d + ' 后重试。' };
          }
        }
        return { error: '『' + v + '』在 ' + k + ' 维度里不存在。先用 options({field:"' + k + '"}) 查精确取值再试。' };
      }
    }
    return null;
  }
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
      const bad = checkFilterDims(a.filters);
      if (bad) return bad;
      const r = engine.report({ groupDim: a.groupDim || 'series', filters: a.filters || {}, weeks: a.weeks || 9, fromW: a.fromW, toW: a.toW });
      try { if (r && r.rows) r.口径说明 = '累计列(cumCur/siCur)为年初至今口径，不可当指定期间用；指定期间的累计请改用 query(from/to)。yoy/wow 为小数比率(0.228=+22.8%)。'; } catch (e) {}
      return r;
    },
    query: async (a) => {
      a = a || {};
      if (!a.stackDim || !DIM.includes(a.stackDim)) {
        return { error: 'stackDim 必填（引擎要求），只能是：' + DIM.join('/') + '。想看整体也要挑一个维度，例如 country。' };
      }
      const bad = checkFilterDims(a.filters);
      if (bad) return bad;
      const met = a.metric || 'sellOut';
      const r = engine.query({ metric: met, gran: a.gran || 'month', filters: a.filters || {}, stackDim: a.stackDim, from: a.from, to: a.to, limit: a.limit });
      // 与 app/ai-context.js 的区间合计保持一致（改那边记得同步这里）
      try {
        if (r && r.data && (met === 'sellOut' || met === 'sellIn')) {
          const sums = {}; let tot = 0;
          (r.series || []).forEach(n => {
            let s = 0; Object.values(r.data[n] || {}).forEach(v => { s += (+v || 0); });
            sums[n] = s; tot += s;
          });
          r.区间合计 = Object.assign({ _全部: tot }, sums);
        }
      } catch (e) {}
      return r;
    },
    financeCustom: async (a) => engine.financeCustom(Object.assign({ finUnits: FIN_UNITS, finQtyUnits: FIN_QTY }, a || {})),
    financeOverview: async (a) => {
      // 与 app/ai-context.js 的年份护栏保持一致（改那边记得同步这里）
      if (a && a.year != null) {
        const m = engine.meta();
        const years = m && m.finMeta && m.finMeta.years;
        if (Array.isArray(years) && years.length && years.indexOf(+a.year) < 0) {
          return { error: '年份 ' + a.year + ' 无财经数据，可用年份：' + years.join('/') + '。不确定就不要传 year（默认最新实际年）。' };
        }
      }
      return engine.financeOverview(Object.assign({ finUnits: FIN_UNITS, finQtyUnits: FIN_QTY }, a || {}));
    },
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

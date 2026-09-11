'use strict';
/* ============================================================
   eval/param-set.js —— 参数化自检题集（数据无关，真值运行时现算）
   与固定 30 题的区别：固定题的真值烤死在 demo-data 上；这里的题目实体
   （最大产品/国家/产业…）和标准答案在运行时从**当前挂载的数据**里由引擎
   算出——把 --data 指到真实底表目录，就是对真实数据的核验。
   安全边界：真实数据跑分记录写 eval/runs-real/（已 .gitignore，绝不入库）；
   云端 API + 真实数据需显式 --allow-cloud-real（见 run-eval.js）。
   ============================================================ */

const maxBy = (rows, f) => (rows || []).reduce((a, b) => (f(b) > f(a) ? b : a), rows[0]);
const pct = (x) => +(100 * x).toFixed(1);
const N = (label, value, tolPct, tolAbs) => ({ label, value, tolPct: tolPct == null ? 0.01 : tolPct, tolAbs: tolAbs == null ? 5 : tolAbs });
const Q = (id, board, question, numbers, target) => ({
  id, category: '参数化·真值现算', board, question,
  expected: { type: 'number', numbers },
  severity_if_wrong: 'harmful', target, truth: '运行时由引擎现算（与数据同源）',
});

async function buildParamSet(T) {
  const qs = [];
  const meta = await T.meta();
  if (!meta || !meta.records) throw new Error('数据未挂载或为空');
  const year = String(meta.to || '').slice(0, 4);

  /* —— PSI 实体发现 —— */
  const repProd = await T.report({ groupDim: 'product' });
  const repCty = await T.report({ groupDim: 'country' });
  const prodRows = (repProd.rows || []).filter(r => r.cumCur > 0);
  const ctyRows = (repCty.rows || []).filter(r => r.cumCur > 0);

  if (prodRows.length) {
    const tp = maxBy(prodRows, r => r.cumCur);
    qs.push(Q('P-01', 'report', tp.key + ' 今年累计 Sell-out 是多少台？',
      [N('累计SO', tp.cumCur)], 'report cumCur'));
    if (tp.inv > 0) qs.push(Q('P-02', 'report', tp.key + ' 现在的渠道库存是多少台？',
      [N('渠道库存', tp.inv, 0, 5)], 'report inv（最新期快照）'));
    if (tp.cumPrev > 0) qs.push(Q('P-03', 'report', tp.key + ' 今年累计 Sell-out 同比增长多少？',
      [N('同比%', pct(tp.yoy), 0, 0.8)], 'report yoy'));
  }
  if (ctyRows.length) {
    const tc = maxBy(ctyRows, r => r.cumCur);
    qs.push(Q('P-04', 'report', tc.key + ' 今年累计 Sell-out 是多少台？',
      [N('累计SO', tc.cumCur)], 'report by country'));
    /* 渠道占比：用 query 区间合计（工具自算，模型只需转述） */
    const ch = await T.query({ stackDim: 'channel', metric: 'sellOut', gran: 'month', from: year + '-01-01', to: meta.to, filters: { country: [tc.key] } });
    const sums = ch && ch.区间合计;
    if (sums && sums._全部 > 0) {
      const chans = Object.keys(sums).filter(k => k !== '_全部');
      if (chans.length >= 2) {
        qs.push(Q('P-05', 'psi', tc.key + ' 今年 Sell-out 里 ' + chans.join(' 和 ') + ' 各占百分之多少？',
          chans.map(c => N(c + '%', pct(sums[c] / sums._全部), 0, 1)), 'query 区间合计→占比'));
      }
    }
  }

  /* —— 期间题：上一个完整自然月的全量 SO —— */
  const end = new Date(meta.to + 'T00:00:00Z');
  const prevM = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() - 1, 1));
  const pmFrom = prevM.toISOString().slice(0, 10);
  const pmTo = new Date(Date.UTC(prevM.getUTCFullYear(), prevM.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);
  const pmLabel = prevM.getUTCFullYear() + '年' + (prevM.getUTCMonth() + 1) + '月';
  const pm = await T.query({ stackDim: 'line', metric: 'sellOut', gran: 'month', from: pmFrom, to: pmTo, filters: {} });
  if (pm && pm.区间合计 && pm.区间合计._全部 > 0) {
    qs.push(Q('P-06', 'psi', pmLabel + '全量 Sell-out 一共多少台？',
      [N('当月SO', pm.区间合计._全部)], 'query 上一完整月 区间合计'));
  }

  /* —— 财经题（有财经数据才出） —— */
  if (meta.hasFin) {
    const ov = await T.financeOverview({});
    const rev = ov && ov.metrics && ov.metrics.rev;
    if (rev && rev.actual > 0) {
      qs.push(Q('P-07', 'finance', ov.curYear + '年1月到' + ov.toM + '月的实际总净销售收入是多少？',
        [N('总收入', rev.actual)], 'financeOverview rev.actual'));
    }
    const pb = await T.financeProductBoard({});
    const lineRows = pb && pb.line && pb.line.rows;
    if (lineRows && lineRows.length) {
      const revKey = Object.keys(lineRows[0]).filter(k => /^rev\d\d$/.test(k)).sort().pop(); // 最新年
      const tl = maxBy(lineRows.filter(r => r[revKey] > 0), r => r[revKey]);
      if (tl) qs.push(Q('P-08', 'finance', tl.key + ' 产业' + pb.curYear + '年1月到' + pb.toM + '月的实际净销售收入是多少？',
        [N('产业收入', tl[revKey])], 'financeProductBoard ' + revKey));
    }
  }

  /* —— 全量 SI —— */
  const repLine = await T.report({ groupDim: 'line' });
  const siTot = (repLine.rows || []).reduce((a, r) => a + (r.siCur || 0), 0);
  if (siTot > 0) qs.push(Q('P-09', 'report', '今年到现在全量 Sell-in 一共多少台？',
    [N('累计SI', siTot)], 'report siCur 合计'));

  return qs;
}

module.exports = { buildParamSet };

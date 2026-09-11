'use strict';
/* ============================================================
   Floor FOB 报表:排序 / 看板 TableSpec / 差异视图 / Top 涨跌。
   从 the earlier prototype/app/reports.py + tablespec.py 移植。
   PNG/PPT/Excel/界面 都吃同一个 spec——谁也不用重新决定"哪些列、怎么排、哪格标红"。
   ============================================================ */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.FobReports = api;
})(this, function () {
  const CoreRef = (typeof module !== 'undefined' && module.exports)
    ? require('./fob-core.js')
    : (typeof window !== 'undefined' ? window.FobCore : null);
  const M = CoreRef.M;
  const UNCATEGORIZED = '未分类';

  const ORDERS = [
    ['custom', '自定义（可拖动行）'],
    ['series_value', '产品系列 → 组内 Floor FOB 高到低'],
    ['series_name', '产品系列 → 产品型号（名称）'],
    ['model', '产品型号 名称 A→Z'],
    ['value', 'Floor FOB 高到低（不分组）'],
    ['price', '授权价 高到低'],
  ];
  const DEFAULT_ORDER = 'series_value';
  const NO_SERIES = '（未填）';
  const LEGEND_DIFF = [['up', '成本上升'], ['down', '成本下降'], ['new', '本次新增'], ['gone', '本次未刷新']];

  /* 配色:与 Python theme.py 逐值一致——界面/PNG/PPT/Excel 必须长一个样 */
  const THEME = {
    HEADER_BG: '1F3864', HEADER_FG: 'FFFFFF', ROW_ALT_BG: 'F3F6FB', GRID: 'CED6E5',
    TEXT: '202630', MUTED: '808A98', TITLE: '121C2D',
    STATUS: {
      up: ['FDE8E8', 'B71C1C'],      // 成本上涨=红(坏)
      down: ['E8F5EC', '156B37'],    // 下降=绿(好)
      new: ['E8F0FE', '1A4AA8'],     // 新增/未保存=蓝
      gone: ['F0F0F0', '787878'],    // 未刷新=灰
      same: ['FFFFFF', '6E7682'],
      none: ['FFFFFF', '202630'],
      manual: ['E8F5EC', '156B37'],  // 手工值=绿底(与 down 同色,语义"人工敲定")
    },
  };

  const fmtValue = (v, dec, blank) => v == null ? (blank || '') : v.toLocaleString('en-US', { minimumFractionDigits: dec || 0, maximumFractionDigits: dec || 0 });
  const fmtDelta = (v, dec, blank) => v == null ? (blank || '') : (v > 0 ? '+' : '') + fmtValue(v, dec);
  const fmtPct = (v, dec, blank) => v == null ? (blank || '') : (v > 0 ? '+' : '') + (v * 100).toFixed(dec == null ? 1 : dec) + '%';

  /* 排序基准 = 该型号最近一个有数月份的 Floor FOB。不用固定月:固定月会让新品全排最后 */
  function refValue(cells, key, months) {
    for (let i = months.length - 1; i >= 0; i--) {
      const v = cells[key + '|' + months[i]];
      if (v != null) return v;
    }
    return null;
  }

  function sortKeys(store, keys, cells, months, order, desc) {
    const info = store.modelInfo();
    const seriesOf = k => { const r = info[k]; const s = ((r && r.series) || '').trim(); return s || '￿'; };
    const nameOf = k => (((info[k] && info[k].display) || k) || k).toUpperCase();
    const valueOf = k => { const v = refValue(cells, k, months); return v != null ? v : -Infinity; };
    const priceOf = k => { const r = info[k]; return (r && r.lastPrice != null) ? +r.lastPrice : -Infinity; };
    const posOf = k => { const r = info[k]; return (r && r.manualPos != null) ? +r.manualPos : Infinity; };
    let keyfn;
    if (order === 'custom') keyfn = k => [posOf(k), seriesOf(k), nameOf(k)];
    else if (order === 'series_name') keyfn = k => [seriesOf(k), nameOf(k)];
    else if (order === 'model') keyfn = k => [nameOf(k)];
    else if (order === 'value') keyfn = k => [-valueOf(k), nameOf(k)];
    else if (order === 'price') keyfn = k => [-priceOf(k), nameOf(k)];
    else keyfn = k => [seriesOf(k), -valueOf(k), nameOf(k)];   // series_value
    const cmp = (a, b) => {
      const ka = keyfn(a), kb = keyfn(b);
      for (let i = 0; i < ka.length; i++) {
        if (ka[i] < kb[i]) return -1;
        if (ka[i] > kb[i]) return 1;
      }
      return 0;
    };
    const out = keys.slice().sort(cmp);
    return desc ? out.reverse() : out;
  }

  /* ---------------- 看板 spec ----------------
     pending: 界面上没保存的编辑(蓝底);markManual: 手工覆盖格染绿。导出时都不传。 */
  function boardSpec(store, opt) {
    opt = opt || {};
    const dec = opt.decimals || 0;
    const showSeries = opt.showSeries !== false;
    const mtx = store.matrix(opt.modelKeys != null ? opt.modelKeys : null, opt.months != null ? opt.months : null, opt.category || null);
    const keys = sortKeys(store, mtx.keys, mtx.cells, mtx.months, opt.order || DEFAULT_ORDER, !!opt.desc);
    const info = store.modelInfo();
    const manual = opt.markManual ? store.overrideCells() : {};
    const pending = opt.pending || {};
    const ms = mtx.months;

    const cols = ['产品型号'].concat(showSeries ? ['产品系列'] : []).concat(ms.map(M.label));
    const rows = [];
    for (const k of keys) {
      const rec = info[k];
      const row = [{ text: (rec && rec.display) || k, align: 'l', bold: true, status: 'none' }];
      if (showSeries) {
        const s = ((rec && rec.series) || '').trim();
        row.push({ text: s || (opt.blankSeries || NO_SERIES), align: 'l', bold: false, status: s ? 'none' : 'gone' });
      }
      for (const m of ms) {
        const key = k + '|' + m;
        let v, status;
        if (key in pending) { v = pending[key]; status = 'new'; }
        else {
          v = mtx.cells[key];
          status = (opt.markManual && key in manual) ? 'manual' : 'none';
        }
        row.push({ text: fmtValue(v == null ? null : v, dec), align: 'r', bold: false, status });
      }
      rows.push(row);
    }
    const catNote = opt.category ? '　|　品类：' + opt.category : '';
    return {
      title: (opt.title || 'Floor FOB 看板') + (opt.category ? '　—　' + opt.category : ''),
      subtitle: opt.subtitle || ('共 ' + keys.length + ' 个型号 × ' + ms.length + ' 个月，币种以授权口径为准' + catNote),
      columns: cols,
      colAlign: ['l'].concat(showSeries ? ['l'] : []).concat(ms.map(() => 'r')),
      rows,
      freezeCols: showSeries ? 2 : 1,
      legend: [],
      footer: '生成于 ' + stamp() + '　|　Floor FOB = 授权价 × (1 − 销毛率)',
      rowMeta: keys.slice(),
      months: ms.slice(),
    };
  }

  /* ---------------- 差异 ----------------
     默认对比"最近一次刷新"与"它之前的看板"。对比对象必须是**快照本身**而不是折叠后
     的看板:折叠会让"本次没刷到"的型号沿用旧值,diff 变"持平",把漏刷盖住。 */
  function buildDiff(store, snapshotId) {
    const core = store.core;
    const snaps = store.listSnapshots();
    const applied = snaps.filter(s => s.applied);
    let snap = null;
    if (snapshotId != null) snap = snaps.find(s => s.id === snapshotId) || null;
    else if (applied.length) snap = applied[applied.length - 1];
    if (!snap) return { months: [], keys: [], old: {}, new: {}, diffs: [], summary: core.summarize([]), snapshot: null, prevLabel: '上一版' };

    const old = store.boardBefore(snap.id);
    const months = store.snapshotMonths(snap.id);
    const keys = store.snapshotModelKeys(snap.id).slice();
    const keySet = {}; keys.forEach(k => { keySet[k] = 1; });
    const monthSet = {}; months.forEach(m => { monthSet[m] = 1; });
    // 看板里有、但本次没刷到的型号也要露出来(可能停产、也可能导出漏了)
    Object.keys(old).forEach(k => {
      const i = k.lastIndexOf('|');
      const mk = k.slice(0, i), m = +k.slice(i + 1);
      if (monthSet[m] && !keySet[mk]) { keySet[mk] = 1; keys.push(mk); }
    });
    const subOld = {};
    Object.keys(old).forEach(k => {
      const i = k.lastIndexOf('|');
      if (keySet[k.slice(0, i)] && monthSet[+k.slice(i + 1)]) subOld[k] = old[k];
    });
    const subNew = {};
    const sc = store.snapshotCells(snap.id);
    Object.keys(sc).forEach(k => { if (monthSet[+k.slice(k.lastIndexOf('|') + 1)]) subNew[k] = sc[k]; });
    const diffs = core.diffCells(subOld, subNew);
    const after = store.boardAfter(snap.id);
    const newMap = {};
    Object.keys(after).forEach(k => {
      const i = k.lastIndexOf('|');
      if (keySet[k.slice(0, i)] && monthSet[+k.slice(i + 1)]) newMap[k] = after[k];
    });
    const prev = applied.filter(s => s.appliedSeq && snap.appliedSeq && s.appliedSeq < snap.appliedSeq);
    return {
      months, keys, old: subOld, new: newMap, diffs, summary: core.summarize(diffs),
      snapshot: snap, prevLabel: prev.length ? prev[prev.length - 1].label : '基线',
    };
  }

  /* mode: 'delta' 差值 / 'pct' 百分比 / 'new' 只看新值 */
  function diffSpec(store, view, opt) {
    opt = opt || {};
    const dec = opt.decimals || 0;
    const mode = opt.mode || 'delta';
    const showSeries = opt.showSeries !== false;
    const info = store.modelInfo();
    const ms = view.months;
    let keys = view.keys.slice();
    const hidden = {}; store.hiddenKeys().forEach(k => { hidden[k] = 1; });
    keys = keys.filter(k => !hidden[k]);
    if (opt.category) {
      keys = keys.filter(k => {
        const r = info[k];
        return ((((r && r.category) || '').trim()) || UNCATEGORIZED) === opt.category;
      });
    }
    keys = sortKeys(store, keys, view.new, ms, opt.order || DEFAULT_ORDER, !!opt.desc);
    const dmap = {}; view.diffs.forEach(d => { dmap[d.modelKey + '|' + d.month] = d; });

    const cols = ['产品型号'].concat(showSeries ? ['产品系列'] : []).concat(ms.map(M.label));
    const rows = [];
    for (const k of keys) {
      const rec = info[k];
      const row = [{ text: (rec && rec.display) || k, align: 'l', bold: true, status: 'none' }];
      if (showSeries) {
        const s = ((rec && rec.series) || '').trim();
        row.push({ text: s || NO_SERIES, align: 'l', bold: false, status: s ? 'none' : 'gone' });
      }
      for (const m of ms) {
        const d = dmap[k + '|' + m];
        if (!d) { row.push({ text: '', align: 'r', bold: false, status: 'none' }); continue; }
        let txt;
        if (mode === 'pct') txt = fmtPct(d.pct);
        else if (mode === 'new') txt = fmtValue(d.new, dec);
        else txt = fmtDelta(d.delta, dec);
        if (d.status === 'new' && mode === 'delta') txt = '新增';
        else if (d.status === 'gone') txt = '未刷新';
        row.push({ text: txt, align: 'r', bold: false, status: d.status });
      }
      rows.push(row);
    }
    const s = view.summary;
    const snap = view.snapshot;
    const name = { delta: '差值', pct: '变动幅度', new: '本次值' }[mode];
    return {
      title: (opt.title || ('Floor FOB 刷新' + name + '（本次 vs ' + view.prevLabel + '）')) + (opt.category ? '　—　' + opt.category : ''),
      subtitle: (snap ? (snap.label + '　' + snap.monthRange + '　') : '')
        + '上升 ' + s.up + ' / 下降 ' + s.down + ' / 持平 ' + s.same + ' / 新增 ' + s.new + ' / 未刷新 ' + s.gone,
      columns: cols,
      colAlign: ['l'].concat(showSeries ? ['l'] : []).concat(ms.map(() => 'r')),
      rows,
      freezeCols: showSeries ? 2 : 1,
      legend: LEGEND_DIFF.slice(),
      footer: '生成于 ' + stamp() + '　|　正数 = Floor FOB 成本上升',
      rowMeta: keys.slice(),
      months: ms.slice(),
    };
  }

  /* 按"本次刷新首月"的绝对变动挑涨跌 Top N,给摘要页 */
  function topMovers(view, store, n) {
    if (!view.months.length) return [[], []];
    const m0 = view.months[0];
    const info = store.modelInfo();
    const items = view.diffs.filter(d => d.month === m0 && d.delta != null);
    const ups = items.filter(d => d.delta > 0).sort((a, b) => b.delta - a.delta).slice(0, n || 5);
    const downs = items.filter(d => d.delta < 0).sort((a, b) => a.delta - b.delta).slice(0, n || 5);
    const fmt = d => {
      const rec = info[d.modelKey];
      return ((rec && rec.display) || d.modelKey) + '：' + fmtValue(d.old, 0) + ' → ' + fmtValue(d.new, 0)
        + '（' + fmtDelta(d.delta, 0) + '，' + fmtPct(d.pct) + '）';
    };
    return [ups.map(fmt), downs.map(fmt)];
  }

  /* PPT 一页放不下时按行分页 */
  function chunkRows(spec, size) {
    if (size <= 0 || spec.rows.length <= size) return [spec];
    const out = [];
    const total = Math.ceil(spec.rows.length / size);
    for (let i = 0; i < total; i++) {
      out.push(Object.assign({}, spec, {
        subtitle: (spec.subtitle ? spec.subtitle + '（' + (i + 1) + '/' + total + '）' : (i + 1) + '/' + total),
        rows: spec.rows.slice(i * size, (i + 1) * size),
        rowMeta: spec.rowMeta.slice(i * size, (i + 1) * size),
      }));
    }
    return out;
  }

  function specToTsv(spec) {
    const lines = [spec.columns.join('\t')];
    for (const row of spec.rows) lines.push(spec.columns.map((_, c) => (row[c] ? row[c].text : '')).join('\t'));
    return lines.join('\n');
  }

  function stamp() {
    const d = new Date();
    const p = n => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  return {
    ORDERS, DEFAULT_ORDER, NO_SERIES, LEGEND_DIFF, THEME,
    fmtValue, fmtDelta, fmtPct, refValue, sortKeys,
    boardSpec, buildDiff, diffSpec, topMovers, chunkRows, specToTsv,
  };
});

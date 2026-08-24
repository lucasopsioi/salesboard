'use strict';
/* ============================================================
   Floor FOB 存储:基线 + 快照 + 手工覆盖 → 折叠出看板。
   从 the earlier prototype/app/store.py(SQLite 版)移植;SQLite → 纯 JS 对象 + JSON 持久化
   (数据量=几十型号×十几月,JSON 绰绰有余;落盘走主进程 IPC,300ms 防抖)。

   设计要点原样保留:**看板是派生量,不是原始量**。
   看板 = fold(baseline, snapshot#1, snapshot#2, …, overrides)。
   撤销某次刷新 = 从叠加序列摘掉后重算,不需要反向补偿,历史天然可回溯。
   单元格键一律 "modelKey|month" 字符串(JSON 友好)。
   ============================================================ */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.FobStore = api;
})(this, function () {
  const CoreRef = (typeof module !== 'undefined' && module.exports)
    ? require('./fob-core.js')
    : (typeof window !== 'undefined' ? window.FobCore : null);
  const UNCATEGORIZED = '未分类';
  const ck = (key, month) => key + '|' + month;

  function blankState() {
    return { baseline: {}, snapshots: [], overrides: {}, modelInfo: {}, aliases: {}, nextId: 1, settings: {} };
  }

  class Store {
    /* opt.now: 时间戳注入口(测试传固定值);opt.onDirty: 状态变了(调用方做持久化) */
    constructor(state, opt) {
      opt = opt || {};
      this.s = Object.assign(blankState(), state || {});
      if (!Array.isArray(this.s.snapshots)) this.s.snapshots = [];
      this._now = opt.now || (() => new Date().toISOString().slice(0, 19));
      this._onDirty = opt.onDirty || (() => { });
      this.core = opt.core || CoreRef;
    }
    _dirty() { this._onDirty(this.s); }
    serialize() { return this.s; }

    /* ---------------- settings ---------------- */
    getSettings() { return Object.assign({ decimals: 0, dropZeroTail: true, bareIsPercent: false, pngScale: 2, rowsPerSlide: 16, exportPctSheet: true, boardOrder: 'series_value' }, this.s.settings || {}); }
    setSettings(patch) { this.s.settings = Object.assign(this.s.settings || {}, patch); this._dirty(); }

    /* ---------------- 别名 ---------------- */
    /* 写库前统一过这一道,保证同一个产品在库里只有一个 key。
       别名只在**写入时**生效——这正是 mergeModel 要顺手搬数据的原因:
       两件事必须绑在一个动作里,否则"什么时候加别名"就成了隐藏时序要求。 */
    resolveKey(key) {
      if (!key) return key;
      const a = this.s.aliases[key];
      return a ? a.target : key;
    }
    aliasList() {
      return Object.keys(this.s.aliases).map(k => Object.assign({ alias: k }, this.s.aliases[k]));
    }

    /* ---------------- model info ---------------- */
    _info(key) {
      let r = this.s.modelInfo[key];
      if (!r) {
        r = this.s.modelInfo[key] = { display: key, region: '', bu: '', series: '', product: '', currency: '', lastPrice: null, lastSeen: '', sortOrder: 1000, category: '', manualPos: null, hidden: 0, manualAdded: 0 };
      }
      return r;
    }
    modelInfo() { return this.s.modelInfo; }
    ensureModel(display) {
      const key = this.resolveKey(this.core.normalizeModelKey(display));
      if (!key) return key;
      if (!this.s.modelInfo[key]) { this._info(key).display = display; this._dirty(); }
      return key;
    }
    displayName(key) {
      const r = this.s.modelInfo[key];
      return r ? r.display : key;
    }
    /* 系列写进 modelInfo 而不是快照:快照是导出原样留档不该被人改。
       手填不会被后续导入的空值冲掉,但会被导出真值覆盖——导出才是权威。 */
    setModelSeries(key, series) {
      this._info(key).series = String(series || '').trim();
      this._dirty();
    }
    setModelCategory(key, category) {
      this._info(key).category = String(category || '').trim();
      this._dirty();
    }
    /* 维度字段一律"非空才覆盖":导出某列为空时不能冲掉用户手填的系列 */
    upsertModelInfo(ext, category) {
      const now = this._now();
      ext.rows.forEach((r, i) => {
        const key = this.resolveKey(r.key);
        const rec = this._info(key);
        rec.display = r.model;
        const cat = (category || r.bu || '').trim();
        const patch = { region: r.region, bu: r.bu, series: r.series, product: r.product, currency: r.currency, category: cat };
        Object.keys(patch).forEach(c => { if (patch[c]) rec[c] = patch[c]; });
        rec.lastPrice = r.price;
        rec.lastSeen = now;
        rec.sortOrder = i;
      });
      this._dirty();
    }

    /* ---------------- baseline ---------------- */
    setBaseline(cells, replace) {
      if (replace) this.s.baseline = {};
      Object.keys(cells).forEach(k => { this.s.baseline[k] = cells[k]; });
      this._dirty();
      return Object.keys(cells).length;
    }
    baselineCells() { return Object.assign({}, this.s.baseline); }
    clearBaseline() { this.s.baseline = {}; this._dirty(); }

    /* ---------------- snapshots ---------------- */
    addSnapshot(ext, opt) {
      opt = opt || {};
      const applyFrom = opt.applyFrom != null ? opt.applyFrom : ext.startMonth;
      const id = this.s.nextId++;
      const snap = {
        id, createdAt: this._now(), label: opt.label || '', startMonth: ext.startMonth,
        monthCount: ext.monthCount, applyFrom, appliedSeq: null,
        source: opt.source || 'paste', note: opt.note || '', rawText: ext.rawText || '',
        category: opt.category || '', products: [], values: {},
      };
      const ms = this.core.extMonths(ext);
      const seen = {};
      for (const r of ext.rows) {
        const key = this.resolveKey(r.key);
        if (!seen[key]) {          // ON CONFLICT DO NOTHING:同键重复行保首条产品记录
          seen[key] = 1;
          snap.products.push({ key, model: r.model, region: r.region, bu: r.bu, series: r.series, product: r.product, incoterm: r.incoterm, currency: r.currency, price: r.price, effDate: r.effDate || '', baseRate: r.baseRate });
        }
        const zm = this.core.zeroMargin(r);
        for (let i = 0; i < ms.length; i++) {
          if (r.rates[i] == null && zm[i] == null) continue;
          snap.values[ck(key, ms[i])] = { rate: r.rates[i], value: zm[i] };   // 同键后者覆盖(与 SQLite upsert 同语义)
        }
      }
      this.s.snapshots.push(snap);
      this.upsertModelInfo(ext, opt.category || '');
      if (opt.apply !== false) this.setApplied(id, true);
      else this._dirty();
      return id;
    }
    _snap(id) { return this.s.snapshots.find(s => s.id === id) || null; }
    setApplied(id, applied) {
      const snap = this._snap(id);
      if (!snap) return;
      if (applied) {
        const mx = Math.max(0, ...this.s.snapshots.map(s => s.appliedSeq || 0));
        snap.appliedSeq = mx + 1;
      } else {
        snap.appliedSeq = null;
      }
      this._dirty();
    }
    deleteSnapshot(id) {
      this.s.snapshots = this.s.snapshots.filter(s => s.id !== id);
      this._dirty();
    }
    renameSnapshot(id, label) { const s = this._snap(id); if (s) { s.label = label; this._dirty(); } }
    listSnapshots(appliedOnly) {
      const M = this.core.M;
      let arr = this.s.snapshots.slice();
      if (appliedOnly) arr = arr.filter(s => s.appliedSeq != null);
      arr.sort((a, b) => ((a.appliedSeq != null ? a.appliedSeq : 1e9) - (b.appliedSeq != null ? b.appliedSeq : 1e9)) || (a.id - b.id));
      return arr.map(s => ({
        id: s.id, createdAt: s.createdAt, label: s.label, startMonth: s.startMonth,
        monthCount: s.monthCount, applyFrom: s.applyFrom, appliedSeq: s.appliedSeq,
        source: s.source, note: s.note, category: s.category, nProducts: s.products.length,
        applied: s.appliedSeq != null,
        monthRange: s.monthCount > 0 ? (M.label(s.startMonth) + ' ~ ' + M.label(M.add(s.startMonth, s.monthCount - 1))) : '',
      }));
    }
    snapshotCells(id, includeBeforeApplyFrom) {
      const snap = this._snap(id);
      if (!snap) return {};
      const floor = includeBeforeApplyFrom ? 0 : snap.applyFrom;
      const out = {};
      Object.keys(snap.values).forEach(k => {
        const v = snap.values[k];
        if (v.value == null) return;
        const m = +k.slice(k.lastIndexOf('|') + 1);
        if (m >= floor) out[k] = v.value;
      });
      return out;
    }
    snapshotRaw(id) { const s = this._snap(id); return s ? { label: s.label, rawText: s.rawText } : null; }
    snapshotMonths(id) {
      const snap = this._snap(id);
      if (!snap) return [];
      const set = {};
      Object.keys(snap.values).forEach(k => {
        const m = +k.slice(k.lastIndexOf('|') + 1);
        if (m >= snap.applyFrom) set[m] = 1;
      });
      return Object.keys(set).map(Number).sort((a, b) => a - b);
    }
    snapshotModelKeys(id) {
      const snap = this._snap(id);
      return snap ? snap.products.map(p => p.key) : [];
    }
    latestApplied() {
      const arr = this.listSnapshots().filter(s => s.applied);
      return arr.length ? arr[arr.length - 1] : null;
    }

    /* ---------------- 折叠 ----------------
       叠加顺序 = 基线 → 各快照(按 appliedSeq) → 手工覆盖(null=抹掉该格) → 剔隐藏型号。
       差异对比用 withOverrides=false:人工改的数不该算成"刷新带来的变化"。 */
    fold(uptoSeq, withOverrides) {
      const board = {};
      Object.keys(this.s.baseline).forEach(k => { board[k] = { v: this.s.baseline[k], source: 'baseline', sourceId: null }; });
      const snaps = this.s.snapshots.filter(s => s.appliedSeq != null && (uptoSeq == null || s.appliedSeq < uptoSeq))
        .sort((a, b) => a.appliedSeq - b.appliedSeq);
      for (const snap of snaps) {
        Object.keys(snap.values).forEach(k => {
          const v = snap.values[k];
          if (v.value == null) return;
          const m = +k.slice(k.lastIndexOf('|') + 1);
          if (m >= snap.applyFrom) board[k] = { v: v.value, source: 'snapshot', sourceId: snap.id };
        });
      }
      if (withOverrides !== false) {
        Object.keys(this.s.overrides).forEach(k => {
          const v = this.s.overrides[k];
          if (v == null) delete board[k];
          else board[k] = { v, source: 'manual', sourceId: null };
        });
      }
      const hidden = this.hiddenKeys();
      if (hidden.length) {
        const hset = {}; hidden.forEach(k => { hset[k] = 1; });
        Object.keys(board).forEach(k => { if (hset[k.slice(0, k.lastIndexOf('|'))]) delete board[k]; });
      }
      return board;
    }
    boardCells() {
      const b = this.fold();
      const out = {};
      Object.keys(b).forEach(k => { out[k] = b[k].v; });
      return out;
    }
    _seqOf(id) { const s = this._snap(id); return s ? s.appliedSeq : null; }
    boardBefore(id) {
      const seq = this._seqOf(id);
      const b = this.fold(seq == null ? null : seq, false);
      const out = {}; Object.keys(b).forEach(k => { out[k] = b[k].v; });
      return out;
    }
    boardAfter(id) {
      const seq = this._seqOf(id);
      if (seq == null) {
        const out = this.boardBefore(id);
        Object.assign(out, this.snapshotCells(id));
        return out;
      }
      const b = this.fold(seq + 1, false);
      const out = {}; Object.keys(b).forEach(k => { out[k] = b[k].v; });
      return out;
    }
    monthsPresent() {
      const set = {};
      Object.keys(this.boardCells()).forEach(k => { set[+k.slice(k.lastIndexOf('|') + 1)] = 1; });
      return Object.keys(set).map(Number).sort((a, b) => a - b);
    }

    /* ---------------- 手工覆盖层 ---------------- */
    setOverrides(cells) {
      Object.keys(cells).forEach(k => { this.s.overrides[k] = cells[k]; });
      this._dirty();
      return Object.keys(cells).length;
    }
    clearOverrides(modelKey, monthsArr) {
      let n = 0;
      const mset = monthsArr ? monthsArr.reduce((o, m) => { o[m] = 1; return o; }, {}) : null;
      Object.keys(this.s.overrides).forEach(k => {
        const i = k.lastIndexOf('|');
        if (modelKey && k.slice(0, i) !== modelKey) return;
        if (mset && !mset[+k.slice(i + 1)]) return;
        delete this.s.overrides[k];
        n++;
      });
      this._dirty();
      return n;
    }
    overrideCells() { return Object.assign({}, this.s.overrides); }

    /* ---------------- 删除/恢复 ---------------- */
    hiddenKeys() { return Object.keys(this.s.modelInfo).filter(k => this.s.modelInfo[k].hidden); }
    deleteModel(key, purgeManual) {
      if (purgeManual !== false) {
        Object.keys(this.s.baseline).forEach(k => { if (k.slice(0, k.lastIndexOf('|')) === key) delete this.s.baseline[k]; });
        Object.keys(this.s.overrides).forEach(k => { if (k.slice(0, k.lastIndexOf('|')) === key) delete this.s.overrides[k]; });
      }
      this._info(key).hidden = 1;
      this._dirty();
    }
    restoreModel(key) { this._info(key).hidden = 0; this._dirty(); }
    hiddenModels() {
      return this.hiddenKeys().map(k => Object.assign({ key: k }, this.s.modelInfo[k]))
        .sort((a, b) => String(a.display).localeCompare(String(b.display)));
    }

    /* ---------------- 合并(搬数据 + 记别名,绑在一个动作里) ----------------
       同月两边都有值时**保留目标型号的值**——目标来自导出,比旧看板手抄可信。 */
    mergeModel(srcKey, dstKey) {
      const src = this.resolveKey(srcKey), dst = this.resolveKey(dstKey);
      const stats = { baseline: 0, override: 0, snapshotRows: 0, snapshotValues: 0 };
      if (!src || !dst || src === dst) return stats;
      const moveMap = (map, statKey) => {
        Object.keys(map).forEach(k => {
          const i = k.lastIndexOf('|');
          if (k.slice(0, i) !== src) return;
          const dk = dst + k.slice(i);
          if (!(dk in map)) { map[dk] = map[k]; stats[statKey]++; }
          delete map[k];
        });
      };
      moveMap(this.s.baseline, 'baseline');
      moveMap(this.s.overrides, 'override');
      for (const snap of this.s.snapshots) {
        const hasDst = snap.products.some(p => p.key === dst);
        snap.products = snap.products.filter(p => {
          if (p.key !== src) return true;
          if (!hasDst) { p.key = dst; stats.snapshotRows++; return true; }
          return false;
        });
        Object.keys(snap.values).forEach(k => {
          const i = k.lastIndexOf('|');
          if (k.slice(0, i) !== src) return;
          const dk = dst + k.slice(i);
          if (!(dk in snap.values)) { snap.values[dk] = snap.values[k]; stats.snapshotValues++; }
          delete snap.values[k];
        });
      }
      const srcRow = this.s.modelInfo[src];
      if (srcRow) {
        const dstRow = this._info(dst);
        ['series', 'product', 'bu', 'region', 'currency', 'category'].forEach(c => {
          if (!dstRow[c] && srcRow[c]) dstRow[c] = srcRow[c];
        });
        delete this.s.modelInfo[src];
      }
      // 原来指向 src 的别名跟着改指 dst,避免 A→B→C 链
      const srcText = srcRow ? srcRow.display : srcKey;
      Object.keys(this.s.aliases).forEach(a => { if (this.s.aliases[a].target === src) this.s.aliases[a].target = dst; });
      this.s.aliases[src] = { target: dst, text: srcText, createdAt: this._now() };
      this._dirty();
      return stats;
    }

    /* ---------------- 品类/排序/手工新增 ---------------- */
    categories() {
      const set = {};
      Object.keys(this.s.modelInfo).forEach(k => {
        const r = this.s.modelInfo[k];
        if (r.hidden) return;
        set[(r.category || '').trim() || UNCATEGORIZED] = 1;
      });
      return Object.keys(set).sort((a, b) => a.localeCompare(b, 'zh'));
    }
    setManualOrder(orderedKeys) {
      orderedKeys.forEach((k, i) => { this._info(k).manualPos = i; });
      this._dirty();
    }
    addManualModel(display, series, category) {
      const key = this.resolveKey(this.core.normalizeModelKey(display));
      if (!key) return '';
      const r = this._info(key);
      r.display = String(display).trim();
      r.manualAdded = 1;
      r.hidden = 0;
      if (series && String(series).trim()) r.series = String(series).trim();
      if (category && String(category).trim()) r.category = String(category).trim();
      this._dirty();
      return key;
    }

    /* ---------------- matrix:取数+过滤,排序交给 reports ---------------- */
    matrix(modelKeys, monthsArr, category) {
      const cells = this.boardCells();
      const info = this.s.modelInfo;
      const hidden = {}; this.hiddenKeys().forEach(k => { hidden[k] = 1; });
      let keys;
      if (modelKeys != null) {
        keys = modelKeys.filter(k => !hidden[k]);
      } else {
        const set = {};
        Object.keys(cells).forEach(k => { set[k.slice(0, k.lastIndexOf('|'))] = 1; });
        // 手工新增的型号可能一个值都还没有,也必须出现在看板上,否则没法往里填
        Object.keys(info).forEach(k => { if (info[k].manualAdded) set[k] = 1; });
        keys = Object.keys(set).filter(k => !hidden[k]).sort();
      }
      if (category) {
        keys = keys.filter(k => {
          const r = info[k];
          return (((r && r.category) || '').trim() || UNCATEGORIZED) === category;
        });
      }
      const ms = monthsArr != null ? monthsArr : this.monthsPresent();
      return { keys, months: ms, cells };
    }
  }

  return { Store, blankState, UNCATEGORIZED, ck };
});

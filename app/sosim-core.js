// app/sosim-core.js
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.SoSimCore = api;
})(this, function () {
  const SEP = String.fromCharCode(0);
  const ymdToYm = (ymd) => Math.floor(ymd / 100);
  const ymdY = (ymd) => Math.floor(ymd / 10000);
  const ymdM = (ymd) => Math.floor(ymd / 100) % 100;
  const ymdD = (ymd) => ymd % 100;
  function daysInYm(ym) {
    const y = Math.floor(ym / 100), m = ym % 100;
    return new Date(Date.UTC(y, m, 0)).getUTCDate();
  }
  function toJs(ymd) { return new Date(Date.UTC(ymdY(ymd), ymdM(ymd) - 1, ymdD(ymd))); }
  function fromJs(dt) { return dt.getUTCFullYear() * 10000 + (dt.getUTCMonth() + 1) * 100 + dt.getUTCDate(); }
  function enumDays(fromYmd, toYmd) {
    const out = []; let dt = toJs(fromYmd); const end = toJs(toYmd);
    while (dt <= end) { out.push(fromJs(dt)); dt = new Date(dt.getTime() + 86400000); }
    return out;
  }
  function isoWeek(ymd) {
    const dt = toJs(ymd);
    const day = (dt.getUTCDay() + 6) % 7;             // Mon=0
    dt.setUTCDate(dt.getUTCDate() - day + 3);          // nearest Thursday
    const firstThu = new Date(Date.UTC(dt.getUTCFullYear(), 0, 4));
    const week = 1 + Math.round(((dt - firstThu) / 86400000 - 3 + ((firstThu.getUTCDay() + 6) % 7)) / 7);
    return dt.getUTCFullYear() * 100 + week;            // YYYYww as int
  }
  function bucketOf(ymd, gran) {
    if (gran === 'day') return String(ymd);
    if (gran === 'month') return String(ymdToYm(ymd));
    if (gran === 'year') return String(ymdY(ymd));
    if (gran === 'quarter') return ymdY(ymd) + 'Q' + (Math.floor((ymdM(ymd) - 1) / 3) + 1);
    if (gran === 'week') { const w = isoWeek(ymd); return Math.floor(w / 100) + '-W' + String(w % 100).padStart(2, '0'); }
    return String(ymd);
  }
  function unitKey(country, model) { return country + SEP + model; }
  // 归一化配对键（仅用于"发货表↔PSI 型号/国家"配对，不改任何显示/存储的原名）：
  // 去所有空白(含全角　) + 全角ASCII→半角 + 小写。用来把 "Vantor6 "/"Ｖantor6"/"VANTOR6" 都识别成 "vantor6"，
  // 使发货能 snap 到同物的 PSI 单元、被其 SellOut 按 FIFO 消耗（否则发货成孤儿、老库存永不消耗）。
  function normId(str) {
    return String(str == null ? '' : str).replace(/[\s　]/g, '')
      .replace(/[！-～]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
      .toLowerCase();
  }
  // Excel 剪贴板文本 → 二维网格。Excel 复制的是 TSV：行以 \n(或\r\n)分隔、列以 \t 分隔;
  // 末尾恒带一个空行(Excel 习惯)要剔除,但**行中间的空单元格保留**(粘贴时表示"跳过该格")。
  function parseClipGrid(text) {
    const lines = String(text == null ? '' : text).replace(/\r/g, '').split('\n');
    while (lines.length && lines[lines.length - 1] === '') lines.pop();
    return lines.map(l => l.split('\t'));
  }
  // 单元格文本 → 数值:容忍千分位逗号/空白/货币符;非数(含空串)返回 null(粘贴时跳过不写)。
  function parseCellNum(v) {
    const t = String(v == null ? '' : v).replace(/[,\s￥$]/g, '');
    if (t === '') return null;
    const n = parseFloat(t);
    return isFinite(n) ? n : null;
  }
  function _match(field, val) {
    if (field == null) return true;
    if (Array.isArray(field)) return field.length === 0 || field.indexOf(val) >= 0;
    return field === val;
  }
  function childrenInScope(units, scope) {
    scope = scope || {};
    return units.filter(u =>
      _match(scope.region, u.region) && _match(scope.rep, u.rep) && _match(scope.country, u.country) &&
      _match(scope.line, u.line) && _match(scope.family, u.family) && _match(scope.series, u.series) &&
      _match(scope.model, u.model));
  }
  function splitRatios(children, histSO) {
    const ks = children.map(u => unitKey(u.country, u.model));
    let total = 0; ks.forEach(kk => total += (histSO.get(kk) || 0));
    const out = new Map();
    ks.forEach(kk => out.set(kk, total > 0 ? (histSO.get(kk) || 0) / total : 0));
    return out;
  }
  function skey(country, model, ymd, metric) { return country + SEP + model + SEP + ymd + SEP + metric; }
  function setForecast(store, o) {
    const children = childrenInScope(o.units, o.scope);
    const ratios = splitRatios(children, o.histSO);
    const days = enumDays(o.fromYmd, o.toYmd);
    const nd = days.length || 1;
    children.forEach(u => {
      const r = ratios.get(unitKey(u.country, u.model)) || 0;
      const per = (o.value * r) / nd;
      days.forEach(d => store.set(skey(u.country, u.model, d, o.metric), per));
    });
  }
  function getForecast(store, country, model, ymd, metric) {
    const v = store.get(skey(country, model, ymd, metric));
    return v == null ? 0 : v;
  }
  function unitValueAt(ctx, store, u, ymd, metric) {
    if (ymd <= ctx.cutoffYmd) { const v = ctx.actual.get(skey(u.country, u.model, ymd, metric)); return v == null ? 0 : v; }
    return getForecast(store, u.country, u.model, ymd, metric);
  }
  function aggregate(ctx, store, scope, units, metric, gran, fromYmd, toYmd) {
    const children = childrenInScope(units, scope);
    const days = enumDays(fromYmd, toYmd);
    const out = new Map();
    children.forEach(u => days.forEach(d => {
      const v = unitValueAt(ctx, store, u, d, metric);
      if (!v) return;
      const b = bucketOf(d, gran);
      out.set(b, (out.get(b) || 0) + v);
    }));
    return out;
  }
  function serializeStore(store) {
    const out = [];
    store.forEach((value, kk) => { const p = kk.split(SEP); out.push({ country: p[0], model: p[1], ymd: +p[2], metric: p[3], value }); });
    return out;
  }
  function deserializeStore(rows) {
    const store = new Map();
    (rows || []).forEach(r => store.set(skey(r.country, r.model, +r.ymd, r.metric), +r.value));
    return store;
  }
  return { SEP, ymdToYm, daysInYm, enumDays, bucketOf, isoWeek, unitKey, normId, parseClipGrid, parseCellNum, childrenInScope, splitRatios, skey, setForecast, getForecast, unitValueAt, aggregate, serializeStore, deserializeStore };
});

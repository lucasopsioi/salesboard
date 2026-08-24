'use strict';
/* ============================================================
   Floor FOB 核心：值解析 / 月份 / 型号归一化 / 列还原(块长嗅探+字段识别) / 计算 / 基线宽表
   从 the earlier prototype(PySide6 版, 2026-08-11) 逐函数移植;计算逻辑保持一致。
   UMD:浏览器挂 window.FobCore,Node 可 require 单测。

   数据形态(关键事实):系统导出的列是**列优先序列化**——字段1的全部 N 个产品值 →
   字段2的 N 个值 → …;还原只需要产品数 N,本模块核心就是自动嗅探 N。
   Floor FOB = 授权价 × (1 − 该月销毛率)。
   ============================================================ */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.FobCore = api;
})(this, function () {

  /* ================= values:单元格取值 =================
     同一字段可能是 "360.2" / "1,234.50" / "12.70%" / "0.127" / "2026/7/23" /
     "46226"(Excel 序列号) / "########"(列宽不够)。解析不出返回 null 而不是抛——
     600 行里一个脏值就整体崩,是这类工具最常见的死法。 */
  const BLANK_TOKENS = { '': 1, '-': 1, '--': 1, '—': 1, 'n/a': 1, 'na': 1, 'null': 1, 'none': 1, '#n/a': 1, '#value!': 1, '#div/0!': 1 };
  const HASH_RE = /^#+$/;
  const NUM_CLEAN_RE = /[,\s 　]/g;
  const PAREN_NEG_RE = /^\((.*)\)$/;
  const DATE_RE = /^(\d{4})\s*[-/年.]\s*(\d{1,2})\s*[-/月.]\s*(\d{1,2})\s*日?$/;
  // Excel 1900 日期系统:序列号按 1899-12-30 + n 天(闰年 bug 校正后,近年数据一律如此)
  const EXCEL_EPOCH_UTC = Date.UTC(1899, 11, 30);

  function isBlank(raw) {
    if (raw == null) return true;
    return BLANK_TOKENS[String(raw).trim().toLowerCase()] === 1;
  }
  function isHashPlaceholder(raw) { return raw != null && HASH_RE.test(String(raw).trim()); }
  function toText(raw) {
    if (raw == null) return '';
    const s = String(raw).replace(/　/g, ' ').replace(/ /g, ' ').trim();
    return BLANK_TOKENS[s.toLowerCase()] === 1 ? '' : s;
  }
  function parseNumber(raw) {
    if (isBlank(raw) || isHashPlaceholder(raw)) return null;
    let s = String(raw).trim();
    let neg = false;
    const m = PAREN_NEG_RE.exec(s);
    if (m) { neg = true; s = m[1]; }
    const pct = s.endsWith('%');
    if (pct) s = s.slice(0, -1);
    s = s.replace(NUM_CLEAN_RE, '');
    if (!s || s === '-' || s === '+' || s === '.') return null;
    const v = Number(s);
    if (!isFinite(v)) return null;
    const out = pct ? v / 100 : v;
    return neg ? -out : out;
  }
  /* 销毛率:带 % 的除 100;裸数字默认已是小数(0.127=12.7%)。
     bareIsPercent=true 时把裸数字当百分数(12.7→0.127),留给"系统换导出口径"兜底。 */
  function parseRate(raw, bareIsPercent) {
    const v = parseNumber(raw);
    if (v == null) return null;
    if (bareIsPercent && !String(raw).trim().endsWith('%') && Math.abs(v) > 1.5) return v / 100;
    return v;
  }
  function looksNumeric(raw) { return parseNumber(raw) != null; }
  function parseDate(raw) {
    if (isBlank(raw) || isHashPlaceholder(raw)) return null;
    const s = String(raw).trim();
    const m = DATE_RE.exec(s);
    if (m) {
      const y = +m[1], mo = +m[2], d = +m[3];
      if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
      const t = new Date(Date.UTC(y, mo - 1, d));
      if (t.getUTCFullYear() !== y || t.getUTCMonth() !== mo - 1 || t.getUTCDate() !== d) return null;
      return iso(t);
    }
    const v = parseNumber(s);
    if (v == null) return null;
    if (v >= 32874 && v <= 65746) return iso(new Date(EXCEL_EPOCH_UTC + Math.trunc(v) * 86400000));
    return null;
  }
  function iso(t) {
    return t.getUTCFullYear() + '-' + String(t.getUTCMonth() + 1).padStart(2, '0') + '-' + String(t.getUTCDate()).padStart(2, '0');
  }
  function looksLikeDate(raw) { return parseDate(raw) != null || isHashPlaceholder(raw); }

  /* ================= months:int YYYYMM =================
     月份是没有"日"的量,int 天然可比较、可当键。 */
  const EN_MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const EN_MON_IDX = {}; EN_MON.forEach((m, i) => { EN_MON_IDX[m.toLowerCase()] = i + 1; });
  const M = {
    make: (y, mo) => y * 100 + mo,
    split: m => [Math.trunc(m / 100), m % 100],
    valid: m => { const y = Math.trunc(m / 100), mo = m % 100; return y >= 1900 && y <= 2999 && mo >= 1 && mo <= 12; },
    add: (m, k) => { const y = Math.trunc(m / 100), mo = m % 100; const t = y * 12 + (mo - 1) + k; return Math.trunc(t / 12) * 100 + (((t % 12) + 12) % 12) + 1; },
    diff: (a, b) => (Math.trunc(a / 100) * 12 + a % 100) - (Math.trunc(b / 100) * 12 + b % 100),
    series: (start, count) => { const out = []; for (let i = 0; i < count; i++) out.push(M.add(start, i)); return out; },
    label: m => EN_MON[(m % 100) - 1] + '-' + String(Math.trunc(m / 100) % 100).padStart(2, '0'),
    labelCn: m => Math.trunc(m / 100) + '年' + (m % 100) + '月',
    current: () => { const t = new Date(); return t.getFullYear() * 100 + t.getMonth() + 1; },
    parse: text => {
      if (text == null) return null;
      const s = String(text).trim();
      if (!s) return null;
      let m = /^\s*(\d{4})\s*年\s*(\d{1,2})\s*月?\s*$/.exec(s);
      if (m) { const c = +m[1] * 100 + +m[2]; return M.valid(c) ? c : null; }
      m = /^\s*(\d{4})[-/.]?(\d{1,2})\s*$/.exec(s);
      if (m) { const c = +m[1] * 100 + +m[2]; return M.valid(c) ? c : null; }
      m = /^\s*([A-Za-z]{3,9})[-/ ]?(\d{2,4})\s*$/.exec(s);
      if (m) { const mo = EN_MON_IDX[m[1].slice(0, 3).toLowerCase()]; if (mo) return with2y(m[2], mo); }
      m = /^\s*(\d{2,4})[-/ ]?([A-Za-z]{3,9})\s*$/.exec(s);
      if (m) { const mo = EN_MON_IDX[m[2].slice(0, 3).toLowerCase()]; if (mo) return with2y(m[1], mo); }
      return null;
    },
  };
  function with2y(raw, month) {
    let y = +raw;
    if (y < 100) y += (y < 80 ? 2000 : 1900);   // 00-79→20xx,80-99→19xx;看板只有近几年,够用
    const c = y * 100 + month;
    return M.valid(c) ? c : null;
  }

  /* ================= models:型号归一化 =================
     唯一一处"业务判断":决定两行数据算不算同一个产品。
     口径(保守):忽略大小写 + 忽略空白 + 全角转半角 + 统一连字符;不动其它任何字符。
     描述式命名(旧看板"Tovik 12+256 inbox键盘…")靠 store 层的合并别名,不在这里写死。 */
  const DASH_RE = /[–—−‐‑‒―ー]/g;
  function normalizeModelKey(model) {
    if (!model) return '';
    let s = String(model).normalize('NFKC');
    s = s.replace(DASH_RE, '-');
    s = s.replace(/[\s　]+/g, '');
    return s.toUpperCase();
  }

  /* ================= parsing:列 → 表 ================= */
  const CURRENCY_CODES = {};
  ('USD EUR CNY RMB JPY GBP HKD TWD KRW SGD AUD CAD CHF SEK NOK DKK RUB TRY ZAR AED ' +
   'SAR INR IDR THB MYR PHP VND MXN BRL ARS CLP COP PEN UYU BOB PYG CRC DOP GTQ PAB ' +
   'NGN EGP KES MAD PLN CZK HUF RON ILS NZD PKR BDT LKR KZT UAH QAR KWD OMR BHD JOD')
    .split(' ').forEach(c => { CURRENCY_CODES[c] = 1; });
  const INCOTERM_HINTS = ['FOB', 'CIF', 'CFR', 'EXW', 'DDP', 'DAP', 'FCA', '净价', '到岸', '离岸'];
  const MIN_FIELDS = 8, MIN_PRODUCTS = 1, MAX_SKIP_LINES = 80, MAX_TRIM_LINES = 80;
  // 型号列 distinct 阈值 0.3:给"同一型号多行(不同客户/口径)"留余地
  const MODEL_DISTINCT_RATIO = 0.3;

  class ParseError extends Error { }

  function splitInput(raw) {
    if (raw == null) return [];
    const text = String(raw).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    let rows = text.split('\n').map(line => line.split('\t'));
    const blankRow = r => r.every(c => toText(c) === '');
    let start = 0, end = rows.length;
    while (start < end && blankRow(rows[start])) start++;
    while (end > start && blankRow(rows[end - 1])) end--;
    return rows.slice(start, end).map(r => r.map(toText));
  }
  function flattenSingleColumn(rows) {
    const out = [];
    for (const r of rows) {
      const nonempty = r.filter(c => c !== '');
      if (nonempty.length > 1) return null;
      out.push(nonempty.length ? nonempty[0] : '');
    }
    return out;
  }
  function divisors(n) {
    const out = [];
    for (let i = 1; i * i <= n; i++) {
      if (n % i === 0) { out.push(i); if (i !== n / i) out.push(n / i); }
    }
    return out.sort((a, b) => a - b);
  }
  // column[f*N + p] = 字段 f 的第 p 个产品值
  function reshape(column, nProducts) {
    const nFields = Math.trunc(column.length / nProducts);
    const grid = [];
    for (let p = 0; p < nProducts; p++) {
      const row = new Array(nFields);
      for (let f = 0; f < nFields; f++) row[f] = column[f * nProducts + p];
      grid.push(row);
    }
    return grid;
  }
  function constantField(grid, f) {
    const first = grid[0][f];
    if (first === '') return null;
    for (const row of grid) if (row[f] !== first) return null;
    return first;
  }
  /* 币种行判据不要求"全部相同",只要求"每个值都是币种代码"——多币种导出仍成立 */
  function evaluate(grid) {
    const nFields = grid[0].length;
    let constCount = 0, currencyIdx = null;
    for (let f = 0; f < nFields; f++) {
      if (constantField(grid, f) != null) constCount++;
      if (currencyIdx == null) {
        const vals = grid.map(r => r[f].trim().toUpperCase()).filter(v => v);
        if (vals.length && vals.every(v => CURRENCY_CODES[v] === 1)) currencyIdx = f;
      }
    }
    return [constCount, currencyIdx];
  }

  /* 判据是「通过校验的候选里取最大的 N」不是打分最高的:
     2N 会把币种块和相邻字段揉进同一行,币种行必被打破 → 自动出局;
     N/2 反而"同值行更多"(一个字段裂成两行),按打分会赢,但它是错的。
     N=1 永远能自圆其说(型号列只有一个值无从判错),绝不能挡在前面。 */
  function detectBlockSize(column) {
    const total = column.length;
    if (total < MIN_FIELDS) return [];
    const best = [], anchored = [], weak = [], tiny = [];
    const ds = divisors(total).slice().reverse();
    for (const n of ds) {
      const nFields = Math.trunc(total / n);
      if (n < MIN_PRODUCTS || nFields < MIN_FIELDS) continue;
      const grid = reshape(column, n);
      const [constCount, currencyIdx] = evaluate(grid);
      if (constCount === 0) continue;
      const frac = constCount / nFields;
      const cand = { nProducts: n, nFields: nFields, skip: 0, constFields: constCount, currencyField: currencyIdx, score: frac * 100 + n, trim: 0 };
      const usable = layoutUsable(detectLayout(grid, true));
      if (n < 2) { if (usable) tiny.push(cand); }
      else if (currencyIdx != null) (usable ? best : anchored).push(cand);
      else if (usable && frac >= 0.15 && constCount >= 3) weak.push(cand);
    }
    return best.concat(weak, anchored, tiny);
  }

  /* 掐头(表头行)/去尾(复制不全)后再嗅探。(0,0) 快路;
     必须改动才解释得通时,判据是**整列同值字段占比**(块长对齐时大区/BU/口径/币种
     齐刷刷变常量行;错位时塌一大截),再看改动量、再看大 N。 */
  function detectWithSkip(column) {
    const n = column.length;
    const skipLimit = Math.min(MAX_SKIP_LINES, Math.max(0, n - MIN_FIELDS));
    const trimLimit = Math.min(MAX_TRIM_LINES, Math.max(0, n - MIN_FIELDS));
    const pairSet = {};
    for (let s = 0; s <= skipLimit; s++) pairSet[s + ',0'] = [s, 0];
    for (let t = 0; t <= trimLimit; t++) pairSet['0,' + t] = [0, t];
    for (let s = 1; s <= Math.min(8, skipLimit); s++)
      for (let t = 1; t <= Math.min(8, trimLimit); t++)
        if (s + t <= 8) pairSet[s + ',' + t] = [s, t];
    const combos = Object.values(pairSet).sort((a, b) => (a[0] + a[1]) - (b[0] + b[1]) || a[1] - b[1]);

    const fallback = [], collected = [];
    for (const [skip, trim] of combos) {
      const sub = trim ? column.slice(skip, n - trim) : column.slice(skip);
      if (sub.length < MIN_FIELDS) continue;
      const cands = detectBlockSize(sub);
      for (const c of cands) { c.skip = skip; c.trim = trim; }
      const strong = cands.filter(c => c.currencyField != null && c.nProducts >= 2
        && layoutUsable(detectLayout(reshape(sub, c.nProducts), true)));
      if (strong.length) {
        if (skip === 0 && trim === 0) {
          return strong.concat(cands.filter(c => strong.indexOf(c) < 0), fallback);
        }
        collected.push(...strong);
      }
      if (cands.length) fallback.push(cands[0]);
    }
    if (collected.length) {
      collected.sort((a, b) =>
        (Math.round(b.constFields / b.nFields * 100) - Math.round(a.constFields / a.nFields * 100))
        || ((a.skip + a.trim) - (b.skip + b.trim))
        || (b.nProducts - a.nProducts));
      return collected.concat(fallback);
    }
    return fallback;
  }

  /* ---------- 字段角色识别 ---------- */
  function newLayout() {
    return { currency: null, incoterm: null, model: null, product: null, series: null,
      bu: null, region: null, price: null, effDate: null, baseRate: null,
      monthStart: null, monthCount: 0, droppedTail: 0, modelDistinct: 0,
      degenerate: false, manual: false, warnings: [] };
  }
  function layoutUsable(lay) {
    return lay.model != null && lay.price != null && lay.monthStart != null
      && lay.monthCount > 0 && !lay.degenerate;
  }
  /* 界面核对用:型号认错最致命,授权价和首月列决定数对不对 */
  function layoutRoles(lay) {
    return [['产品系列', lay.series], ['产品型号', lay.model],
      ['授权价', lay.price], ['首个月份', lay.monthStart]];
  }
  function allNumeric(grid, f) {
    let seen = false;
    for (const row of grid) {
      if (row[f] === '') continue;
      if (!looksNumeric(row[f])) return false;
      seen = true;
    }
    return seen;
  }
  function allBlankOrZero(grid, f) {
    for (const row of grid) {
      const v = parseNumber(row[f]);
      if (v != null && Math.abs(v) > 1e-12) return false;
    }
    return true;
  }
  function mostlyDate(grid, f) {
    let ok = 0;
    for (const row of grid) if (looksLikeDate(row[f])) ok++;
    return ok >= Math.max(1, Math.trunc(grid.length * 0.6));
  }
  function findCurrency(grid) {
    for (let f = 0; f < grid[0].length; f++) {
      const val = constantField(grid, f);
      if (val && CURRENCY_CODES[val.trim().toUpperCase()] === 1) return f;
    }
    for (let f = 0; f < grid[0].length; f++) {
      const vals = grid.map(r => r[f].trim().toUpperCase()).filter(v => v);
      if (vals.length && vals.every(v => CURRENCY_CODES[v] === 1)) return f;
    }
    return null;
  }
  function findIncoterm(grid) {
    for (let f = 0; f < grid[0].length; f++) {
      const vals = grid.map(r => r[f]).filter(v => v);
      if (vals.length && vals.every(v => INCOTERM_HINTS.some(h => v.toUpperCase().includes(h) || v.includes(h)))) return f;
    }
    return null;
  }

  /* 锚点顺序:币种 → 授权口径(前一列) → 产品型号(再前一列) → 授权价(币种后第一列数值)
     → 生效日期 → 销毛率块。用相对位置,导出多几个/少几个前置维度字段都不影响。 */
  function detectLayout(grid, dropZeroTail) {
    const lay = newLayout();
    if (!grid.length || !grid[0].length) { lay.warnings.push('空表'); return lay; }
    const nFields = grid[0].length;
    lay.currency = findCurrency(grid);
    let anchor = lay.currency;
    if (anchor == null) {
      anchor = findIncoterm(grid);
      if (anchor != null) { lay.incoterm = anchor; lay.warnings.push('未识别到币种列，改用授权口径列定位'); }
    } else if (anchor - 1 >= 0) {
      lay.incoterm = anchor - 1;
    }
    if (anchor == null) {
      lay.warnings.push('未能定位币种/授权口径列，请手动指定产品型号与授权价列');
      return lay;
    }
    const modelIdx = (lay.incoterm != null ? lay.incoterm : anchor) - 1;
    if (modelIdx >= 0) {
      lay.model = modelIdx;
      const offs = [[1, 'product'], [2, 'series'], [3, 'bu'], [4, 'region']];
      for (const [off, attr] of offs) { const idx = modelIdx - off; if (idx >= 0) lay[attr] = idx; }
    }
    const start = (lay.currency != null ? lay.currency : anchor) + 1;
    for (let f = start; f < nFields; f++) { if (allNumeric(grid, f)) { lay.price = f; break; } }
    if (lay.price == null) { lay.warnings.push('未找到授权价列'); return lay; }
    const nxt = lay.price + 1;
    let rateStart;
    if (nxt < nFields && mostlyDate(grid, nxt)) { lay.effDate = nxt; rateStart = nxt + 1; }
    else { rateStart = nxt; lay.warnings.push('未识别到生效日期列，销毛率块从授权价后一列开始'); }
    if (rateStart >= nFields) { lay.warnings.push('授权价之后没有销毛率列'); return lay; }
    let end = nFields;
    if (dropZeroTail) {
      // 末尾整列全空/全零 = 导出多带的空列;真实月份不可能全部产品恰好为 0
      while (end - 1 > rateStart && allBlankOrZero(grid, end - 1)) end--;
      lay.droppedTail = nFields - end;
    }
    lay.baseRate = rateStart;              // 「生效当月」不是月份列!
    lay.monthStart = rateStart + 1;
    lay.monthCount = Math.max(0, end - lay.monthStart);
    if (lay.monthCount === 0) lay.warnings.push('除生效当月外没有月度销毛率列');
    checkModelColumn(grid, lay);
    return lay;
  }

  /* 型号列必须"值互不相同"。块长猜错时它整列落进某个同值块(FOB净价/Default/USD),
     没有这条,N=2 假解会带着"型号=FOB净价"一路算到底且全程不报错。
     ★ 结构矛盾判据更硬:型号列里混进口径/币种列的值 = 必然错位,零误伤。 */
  function checkModelColumn(grid, lay) {
    if (lay.model == null) return;
    const n = grid.length;
    const vals = grid.map(r => r[lay.model]);
    const set = {};
    vals.forEach(v => { if (v) set[v] = 1; });
    lay.modelDistinct = Object.keys(set).length;
    const forbidden = {};
    for (const idx of [lay.incoterm, lay.currency]) {
      if (idx != null && idx !== lay.model) grid.forEach(r => { if (idx < r.length && r[idx]) forbidden[r[idx]] = 1; });
    }
    const bad = vals.filter(v => v && forbidden[v] === 1);
    if (bad.length) {
      lay.degenerate = true;
      lay.warnings.push('产品型号列里混进了 ' + bad.length + ' 个「' + bad[0] + '」（那是授权口径/币种列的值），说明每个字段的行数猜错了或粘贴内容不完整');
      return;
    }
    if (n < 2) return;
    // n==2 也要查:实际遇到的假解正好 2 行、型号列整列 FOB净价
    const need = n < 4 ? 2 : Math.max(2, n * MODEL_DISTINCT_RATIO);
    if (lay.modelDistinct < need) {
      lay.degenerate = true;
      const sample = vals.length ? vals[0] : '';
      lay.warnings.push('产品型号列取值几乎全一样（' + lay.modelDistinct + ' 种，示例：' + (sample || '空') + '），说明每个字段的行数猜错了');
    }
  }

  /* 手工指定列(下标 0 起;null=沿用自动) */
  function applyManual(grid, lay, mc) {
    if (!mc || !Object.keys(mc).some(k => mc[k] != null)) return lay;
    const nFields = grid.length ? grid[0].length : 0;
    const ok = i => (i != null && i >= 0 && i < nFields) ? i : null;
    lay.manual = true;
    lay.degenerate = false;
    lay.warnings = lay.warnings.filter(w => w.indexOf('猜错') < 0);
    for (const attr of ['model', 'series', 'product', 'price', 'effDate']) {
      const v = ok(mc[attr]);
      if (v != null) lay[attr] = v;
    }
    if (ok(mc.monthStart) != null) {
      lay.monthStart = mc.monthStart;
      lay.baseRate = mc.monthStart > 0 ? mc.monthStart - 1 : null;
    }
    if (lay.monthStart != null) {
      const avail = Math.max(0, nFields - lay.monthStart);
      lay.monthCount = mc.monthCount ? Math.min(mc.monthCount, avail) : avail;
    }
    checkModelColumn(grid, lay);
    if (lay.degenerate) lay.warnings.push('（已按手工指定处理，但型号列看起来仍然不像型号）');
    return lay;
  }

  function sampleField(grid, fieldIdx, n) {
    if (fieldIdx == null || !grid.length) return '';
    const vals = [];
    for (const row of grid) {
      if (fieldIdx < row.length && row[fieldIdx]) vals.push(row[fieldIdx]);
      if (vals.length >= (n || 3)) break;
    }
    return vals.join(' / ');
  }

  /* 主入口:一列(嗅探 reshape) / 横表(直接用) / 竖表(自动转置) 都接受 */
  function parsePaste(raw, opt) {
    opt = opt || {};
    const rows = splitInput(raw);
    if (!rows.length) throw new ParseError('没有可解析的内容');
    const dropZeroTail = opt.dropZeroTail !== false;
    const column = flattenSingleColumn(rows);

    if (column == null) {
      const width = Math.max(...rows.map(r => r.length));
      const asIs = rows.map(r => r.concat(new Array(width - r.length).fill('')));
      const transposed = asIs[0].map((_, c) => asIs.map(r => r[c]));
      const tries = [[asIs, 'table'], [transposed, 'table-T']];
      for (const [grid, shape] of tries) {
        const lay = applyManual(grid, detectLayout(grid, dropZeroTail), opt.manual || {});
        if (layoutUsable(lay)) {
          return { grid, layout: lay, nProducts: grid.length, nFields: grid[0].length, skip: 0, sourceShape: shape, candidates: [], warnings: lay.warnings.slice(), trim: 0 };
        }
      }
      const lay = applyManual(asIs, detectLayout(asIs, dropZeroTail), opt.manual || {});
      return { grid: asIs, layout: lay, nProducts: asIs.length, nFields: asIs[0].length, skip: 0, sourceShape: 'table', candidates: [], warnings: lay.warnings.concat(['二维表未能识别出完整字段，请手动指定']), trim: 0 };
    }

    let grid, cands, extra, effSkip, effTrim = opt.trim || 0;
    if (opt.forceBlock) {
      effSkip = opt.skip || 0;
      const sub = effTrim ? column.slice(effSkip, column.length - effTrim) : column.slice(effSkip);
      const usable = sub.length - (sub.length % opt.forceBlock);
      if (usable < opt.forceBlock * MIN_FIELDS) {
        throw new ParseError('按每字段 ' + opt.forceBlock + ' 行切分，只够 ' + Math.trunc(usable / opt.forceBlock) + ' 个字段（至少要 ' + MIN_FIELDS + ' 个）。\n当前有效行数 ' + sub.length + '，' + opt.forceBlock + ' 这个数对吗？它应该等于产品个数。');
      }
      grid = reshape(sub.slice(0, usable), opt.forceBlock);
      cands = [];
      extra = sub.length !== usable ? ['末尾 ' + (sub.length - usable) + ' 行不足一整块，已忽略'] : [];
    } else {
      cands = detectWithSkip(column);
      if (!cands.length) {
        throw new ParseError('无法自动识别每个字段占几行（= 产品个数）。当前共 ' + column.length + ' 行。\n\n常见原因：\n· 复制不全 —— Excel 里 Ctrl+Shift+↓ 碰到空单元格就会停，建议点列标整列复制，或框选后 Ctrl+C\n· 只复制了其中一段（行数必须正好是 产品数 × 字段数）\n· 混进了表头行\n\n也可以取消勾选「自动识别产品数」，直接填产品个数。');
      }
      const bestC = cands[0];
      effSkip = bestC.skip; effTrim = bestC.trim;
      grid = reshape(column.slice(effSkip, effSkip + bestC.nProducts * bestC.nFields), bestC.nProducts);
      extra = [];
      if (effSkip) extra.push('自动跳过了开头 ' + effSkip + ' 行（疑似表头）');
      if (effTrim) extra.push('自动丢弃了末尾 ' + effTrim + ' 行（不足一整块，多半是复制时少了几行）');
    }
    const lay = applyManual(grid, detectLayout(grid, dropZeroTail), opt.manual || {});
    return { grid, layout: lay, nProducts: grid.length, nFields: grid[0].length, skip: effSkip, sourceShape: 'column', candidates: cands, warnings: extra.concat(lay.warnings), trim: effTrim };
  }

  /* ================= calc:Floor FOB 与差异 ================= */
  function extract(pr, startMonth, bareIsPercent, rawText) {
    const lay = pr.layout;
    if (!layoutUsable(lay)) {
      throw new Error('字段识别不完整，无法计算：' + (lay.warnings.length ? lay.warnings.join('；') : '未知原因'));
    }
    const cell = (row, idx) => (idx != null && idx >= 0 && idx < row.length) ? row[idx] : '';
    let rows = [];
    const warnings = pr.warnings.slice();
    let suspiciousRate = 0;
    for (const r of pr.grid) {
      const rates = [];
      for (let i = 0; i < lay.monthCount; i++) {
        const v = parseRate(cell(r, lay.monthStart + i), bareIsPercent);
        if (v != null && Math.abs(v) > 3.0) suspiciousRate++;
        rates.push(v);
      }
      rows.push({
        model: cell(r, lay.model), region: cell(r, lay.region), bu: cell(r, lay.bu),
        series: cell(r, lay.series), product: cell(r, lay.product),
        incoterm: cell(r, lay.incoterm), currency: cell(r, lay.currency),
        price: parseNumber(cell(r, lay.price)), effDate: parseDate(cell(r, lay.effDate)),
        baseRate: parseRate(cell(r, lay.baseRate), bareIsPercent), rates: rates,
      });
    }
    rows.forEach(r => { r.key = normalizeModelKey(r.model); });
    const blankModel = rows.filter(r => !r.model).length;
    if (blankModel) {
      warnings.push(blankModel + ' 行的产品型号为空，已跳过');
      rows = rows.filter(r => r.model);
    }
    const noPrice = rows.filter(r => r.price == null).map(r => r.model);
    if (noPrice.length) {
      warnings.push(noPrice.length + ' 个型号没有授权价：' + noPrice.slice(0, 5).join('、') + (noPrice.length > 5 ? '…' : ''));
    }
    if (suspiciousRate) {
      warnings.push('有 ' + suspiciousRate + ' 个销毛率绝对值 > 300%，如果原始值是 \'12.7\' 形式的百分数，请勾选『裸数字按百分数解析』');
    }
    const ext = { rows, startMonth, monthCount: lay.monthCount, warnings, rawText: rawText || '' };
    const dups = duplicates(ext);
    const dupKeys = Object.keys(dups);
    if (dupKeys.length) {
      ext.warnings.push('型号重复（后出现的会覆盖先出现的）：' + dupKeys.slice(0, 5).map(k => k + '×' + dups[k]).join('、'));
    }
    return ext;
  }
  function extMonths(ext) { return M.series(ext.startMonth, ext.monthCount); }
  function zeroMargin(row) {
    if (row.price == null) return row.rates.map(() => null);
    return row.rates.map(r => r == null ? null : row.price * (1 - r));
  }
  function duplicates(ext) {
    const seen = {};
    ext.rows.forEach(r => { seen[r.key] = (seen[r.key] || 0) + 1; });
    const out = {};
    Object.keys(seen).forEach(k => { if (seen[k] > 1) out[k] = seen[k]; });
    return out;
  }
  // 展开成 {"key|month": Floor FOB}
  function toCells(ext) {
    const out = {};
    const ms = extMonths(ext);
    for (const row of ext.rows) {
      const zm = zeroMargin(row);
      for (let i = 0; i < ms.length; i++) {
        if (zm[i] != null) out[row.key + '|' + ms[i]] = zm[i];
      }
    }
    return out;
  }

  /* ---------- 差异 ---------- */
  function diffStatus(oldV, newV) {
    if (oldV == null && newV != null) return 'new';
    if (newV == null && oldV != null) return 'gone';
    if (oldV == null || newV == null) return 'none';
    const d = newV - oldV;
    if (Math.abs(d) < 0.005) return 'same';
    return d > 0 ? 'up' : 'down';
  }
  function diffCells(oldMap, newMap) {
    const keys = {};
    Object.keys(oldMap).forEach(k => { keys[k] = 1; });
    Object.keys(newMap).forEach(k => { keys[k] = 1; });
    return Object.keys(keys).sort((a, b) => {
      const [ka, ma] = splitCellKey(a), [kb, mb] = splitCellKey(b);
      return ka < kb ? -1 : ka > kb ? 1 : ma - mb;
    }).map(k => {
      const [mk, m] = splitCellKey(k);
      const o = oldMap[k] != null ? oldMap[k] : null;
      const nv = newMap[k] != null ? newMap[k] : null;
      return {
        modelKey: mk, month: m, old: o, new: nv,
        delta: (o == null || nv == null) ? null : nv - o,
        pct: (o == null || o === 0 || nv == null) ? null : (nv - o) / Math.abs(o),
        status: diffStatus(o, nv),
      };
    });
  }
  function splitCellKey(k) {
    const i = k.lastIndexOf('|');
    return [k.slice(0, i), +k.slice(i + 1)];
  }
  function summarize(diffs) {
    const out = { up: 0, down: 0, same: 0, new: 0, gone: 0, none: 0 };
    diffs.forEach(d => { out[d.status]++; });
    return out;
  }

  /* ================= boardpaste:历史基线宽表 =================
     第一行月份表头(Dec-25/2025-12/202512/2025年12月),第一列型号。 */
  class BoardPasteError extends Error { }
  function parseBoardTable(raw) {
    const grid = splitInput(raw);
    if (grid.length < 2) throw new BoardPasteError('至少要有表头行 + 1 行数据');
    const header = grid[0];
    const monthsArr = [], colOf = [], skipped = [];
    for (let c = 1; c < header.length; c++) {
      const m = M.parse(header[c]);
      if (m == null) { if (header[c]) skipped.push(header[c]); continue; }
      monthsArr.push(m); colOf.push(c);
    }
    if (!monthsArr.length) {
      throw new BoardPasteError('表头里没认出任何月份。\n第一行请放月份，例如：产品型号 / Dec-25 / Jan-26 …\n支持 Dec-25、2025-12、202512、2025年12月 几种写法。');
    }
    const rows = [];
    const warnings = [];
    let badValues = 0;
    for (const r of grid.slice(1)) {
      if (!r.length || !r[0]) continue;
      const vals = {};
      for (let i = 0; i < monthsArr.length; i++) {
        const c = colOf[i];
        if (c >= r.length || r[c] === '') continue;
        const v = parseNumber(r[c]);
        if (v == null) { badValues++; continue; }
        vals[monthsArr[i]] = v;
      }
      if (Object.keys(vals).length) rows.push([r[0], vals]);
    }
    if (!rows.length) throw new BoardPasteError('没有解析到任何数值行');
    if (skipped.length) warnings.push(skipped.length + ' 个表头列不是月份，已跳过：' + skipped.slice(0, 6).join('、') + (skipped.length > 6 ? '…' : ''));
    if (badValues) warnings.push(badValues + ' 个单元格不是数字，已当空处理');
    const uniq = {}; monthsArr.forEach(m => { uniq[m] = 1; });
    if (Object.keys(uniq).length !== monthsArr.length) warnings.push('表头里有重复月份，同月的后一列会覆盖前一列');
    const cellCount = rows.reduce((s, r) => s + Object.keys(r[1]).length, 0);
    return { months: monthsArr, rows, warnings, skippedCols: skipped, cellCount };
  }

  return {
    // values
    isBlank, isHashPlaceholder, toText, parseNumber, parseRate, parseDate, looksNumeric, looksLikeDate,
    // months
    M,
    // models
    normalizeModelKey,
    // parsing
    ParseError, splitInput, flattenSingleColumn, divisors, reshape, detectBlockSize,
    detectWithSkip, detectLayout, layoutUsable, layoutRoles, applyManual, sampleField, parsePaste,
    // calc
    extract, extMonths, zeroMargin, duplicates, toCells, diffCells, summarize, splitCellKey,
    // boardpaste
    BoardPasteError, parseBoardTable,
    // 常量(界面要用)
    CURRENCY_CODES, MIN_FIELDS,
  };
});

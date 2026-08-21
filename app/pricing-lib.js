// 「产品定价库」视图控制器（渲染层）。依赖全局 ConceptImport、CostBase、api、XLSX。
// ── 文件结构（用户要求：代码乱→按段整理）────────────────────────────
//   §1 状态 / 存档       state · save / load（filters 并入 sb.pricing.lib.v1，兼容旧档）
//   §2 导入 / 取数       importConcept / importCost / pxLibAutoLoadCost · stats · uniq
//   §3 计算（零改动）     filteredRecords · costAdjustedGM 口径一律不动
//   §4 渲染              renderPricingLib（分区骨架）· 数据源条 · 筛选（共享多选）· 表格（合计行/排序/命中计数）
//   §5 导出 / 绑定       libAoa / exportXlsx / exportPpt / exportJson / onImportJson
// ────────────────────────────────────────────────────────────────
(function () {
  const api = (typeof window !== 'undefined' && window.sb) ? window.sb : null;

  /* ===================== §1 状态 / 存档 ===================== */
  // 4 维筛选升多选：country/product/custClass/onoff 均为「已选值数组」（[] = 全部）。
  // costYm 仍是单值（成本口径开关，非筛选）。sortCol/sortDir 为表头排序状态。
  const state = { records: new Map(), costMap: new Map(), skuMeta: new Map(),
    country: [], product: [], custClass: [], onoff: [], costYm: null,
    sortCol: null, sortDir: 1 };
  window.PXLIB = state;
  const el = (id) => document.getElementById(id);
  const LS = 'sb.pricing.lib.v1';

  // 只持久化「数值数组」筛选（多选）+ costYm；排序不入档（属临时浏览态）。
  function filtersSnapshot() {
    return { country: state.country, product: state.product, custClass: state.custClass,
      onoff: state.onoff, costYm: state.costYm };
  }
  function save() {
    try { localStorage.setItem(LS, JSON.stringify({ records: [...state.records.values()], filters: filtersSnapshot() })); } catch (e) {}
  }
  function saveFiltersOnly() { save(); }   // 记录未变、仅筛选变时复用（Map 序列化成本可接受，记录量不大）
  function load() {
    try {
      const o = JSON.parse(localStorage.getItem(LS) || 'null'); if (!o) return;
      if (o.records) o.records.forEach(r => state.records.set(r.id, r));
      // 兼容旧档：旧档无 filters 字段（只有 records），跳过即用默认「全部」。
      const f = o.filters;
      if (f) {
        const arr = (v) => Array.isArray(v) ? v.slice() : (v ? [v] : []);   // 旧档若曾存单值字符串，容错升数组
        state.country = arr(f.country); state.product = arr(f.product);
        state.custClass = arr(f.custClass); state.onoff = arr(f.onoff);
        state.costYm = (f.costYm != null) ? f.costYm : null;
      }
    } catch (e) {}
  }

  /* ===================== §2 导入 / 取数 ===================== */
  function importConcept(buf) {
    const wb = XLSX.read(buf, { type: 'array' });
    const aoa = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: true });
    const { records, skipped } = ConceptImport.parseConceptTable(aoa);
    let upd = 0, add = 0;
    records.forEach(r => { if (state.records.has(r.id)) upd++; else add++; state.records.set(r.id, r); });
    save();
    return { updated: upd, added: add, skipped };
  }
  function importCostAoa(aoa) {
    const { costMap, skuMeta } = CostBase.parseCostAoa(aoa);
    state.costMap = costMap; state.skuMeta = skuMeta;
    return { skus: costMap.size };
  }
  function importCost(buf) {
    const wb = XLSX.read(buf, { type: 'array' });
    const aoa = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: true });
    return importCostAoa(aoa);
  }
  // 成本表统一来自「数据源」看板设置的成本文件夹（引擎持久化源）。打开看板/全局刷新时从 sosimSource() 自动读入。
  async function pxLibAutoLoadCost() {
    try {
      const src = await (window.sb && window.sb.sosimSource ? window.sb.sosimSource() : null);
      if (src && src.cost && src.cost.aoa) return importCostAoa(src.cost.aoa).skus;
    } catch (e) {}
    return 0;
  }
  window.pxLibAutoLoadCost = pxLibAutoLoadCost;

  function stats() {
    const recs = [...state.records.values()];
    const countries = new Set(recs.map(r => r.country)), products = new Set(recs.map(r => r.product || r.sku));
    return { n: recs.length, countries: countries.size, products: products.size };
  }
  function uniq(getter) { return [...new Set([...state.records.values()].map(getter).filter(Boolean))].sort(); }

  /* ===================== §3 计算（口径零改动） ===================== */
  // filteredRecords 从「单值 ===」升到「多选 includes」，语义等价（空数组=全部）；
  // costAdjustedGM / snap 字段一律不动。
  function filteredRecords() {
    let recs = [...state.records.values()];
    const inSel = (arr, v) => !arr || arr.length === 0 || arr.indexOf(v) >= 0;
    recs = recs.filter(r =>
      inSel(state.country, r.country) &&
      inSel(state.product, (r.product || r.sku)) &&
      inSel(state.custClass, r.custClass) &&
      inSel(state.onoff, r.onlineOffline));
    return recs;
  }
  // 表格列定义（供渲染/排序/合计共用）。key=排序取值键，num=数值列，rate=率值列（合计取均值），
  // val(r) 取该行原始可比较值（数值/字符串），cell(r) 产出 <td>。
  const monthCostOf = (r) => (state.costYm != null) ? CostBase.costFloorFor(state.costMap, r.sku, state.costYm) : null;
  const gmCls = (v) => 'pxl-gm ' + (v == null ? '' : (v < 0 ? 'neg' : 'pos'));
  const COLS = [
    { t: '国家', val: r => r.country || '' },
    { t: '产品', val: r => r.product || '' },
    { t: 'SKU', val: r => r.sku || '' },
    { t: '客户分类', val: r => r.custClass || '' },
    { t: '线上下', val: r => r.onlineOffline || '' },
    { t: '具体客户', val: r => r.customer || '' },
    { t: 'NSIP', num: true, val: r => (r.snap && r.snap.nsipUsd), cell: r => '<td class="num">' + usd(r.snap.nsipUsd) + '</td>' },
    { t: '快照销毛', num: true, rate: true, val: r => (r.snap && r.snap.grossMarginRate),
      cell: r => '<td class="num ' + gmCls(r.snap.grossMarginRate) + '">' + pct(r.snap.grossMarginRate) + '</td>' },
    { t: '当月销毛', num: true, rate: true, val: r => { const a = ConceptImport.costAdjustedGM(r, monthCostOf(r)); return a && a.gmRate; },
      cell: r => { const mc = monthCostOf(r); const adj = ConceptImport.costAdjustedGM(r, mc);
        return (state.costYm != null && mc == null)
          ? '<td class="num" style="color:var(--ink3)" title="该SKU该月无成本">—</td>'
          : '<td class="num ' + gmCls(adj.gmRate) + '">' + pct(adj.gmRate) + '</td>'; } },
    { t: 'FOB净价', num: true, val: r => (r.snap && r.snap.fobNetUsd), cell: r => '<td class="num">' + usd(r.snap.fobNetUsd) + '</td>' },
    { t: '区域贡献利润', num: true, rate: true, val: r => (r.snap && r.snap.regionContribRate),
      cell: r => '<td class="num ' + gmCls(r.snap.regionContribRate) + '">' + pct(r.snap.regionContribRate) + '</td>' },
  ];

  /* ===================== §4 渲染 ===================== */
  async function renderPricingLib() {
    const root = el('pxLibRoot'); if (!root) return;
    if (root.dataset.built !== '1') {
      root.dataset.built = '1'; load();
      injectStyle();
      // 分区骨架：①导入区（补录概算表/JSON 互转+导出）②数据源说明条（成本口径开关）③筛选浏览区（多选+命中计数+表格）。
      root.innerHTML =
        '<h2 style="margin:0 0 12px">产品定价库</h2>' +
        // ① 导入区 ------------------------------------------------------
        '<section class="pxl-sec">' +
          '<div class="pxl-sec-hd">数据导入 / 导出</div>' +
          '<div class="pxl-row">' +
            '<label class="btn pxl-file">导入概算表<input type="file" id="pxLibFile" accept=".xlsx,.xls"></label>' +
            '<label class="btn pxl-file">导入JSON<input type="file" id="pxLibImport" accept=".json"></label>' +
            '<span class="pxl-sp"></span>' +
            '<button class="btn" id="pxLibExportXlsx">导出Excel</button>' +
            '<button class="btn" id="pxLibExportPpt">导出PPT</button>' +
            '<button class="btn" id="pxLibExport">导出JSON</button>' +
          '</div>' +
        '</section>' +
        // ② 数据源说明条（含成本月份口径开关）--------------------------
        '<div class="pxl-src" id="pxLibSrc">' +
          '<span id="pxLibInfo" class="pxl-info"></span>' +
          '<span class="pxl-src-cost">成本月份口径 <span id="pxLibYmSlot"></span></span>' +
        '</div>' +
        // ③ 筛选浏览区 --------------------------------------------------
        '<section class="pxl-sec">' +
          '<div class="pxl-sec-hd">筛选 / 浏览' +
            '<a href="javascript:void(0)" id="pxLibClear" class="pxl-clear">清空全部筛选</a>' +
            '<span id="pxLibHit" class="pxl-hit"></span></div>' +
          '<div class="pxl-filters" id="pxLibFilters"></div>' +
          '<div id="pxLibBody"></div>' +
        '</section>';
      el('pxLibFile').addEventListener('change', onConcept);
      el('pxLibExport').addEventListener('click', exportJson);
      el('pxLibExportXlsx').addEventListener('click', exportXlsx);
      el('pxLibExportPpt').addEventListener('click', exportPpt);
      el('pxLibImport').addEventListener('change', onImportJson);
      el('pxLibClear').addEventListener('click', clearFilters);
    }
    await pxLibAutoLoadCost();
    refreshInfo(); renderCostYm(); renderFilters(); renderTable();
  }

  function injectStyle() {
    if (document.getElementById('pxlib-style')) return;
    const s = document.createElement('style'); s.id = 'pxlib-style';
    s.textContent = '#pxLibRoot{font-size:13px;color:var(--ink)}' +
      // 分区容器
      '.pxl-sec{border:1px solid var(--line);border-radius:var(--radius);background:var(--c-bg-elev);padding:12px 14px;margin-bottom:12px}' +
      '.pxl-sec-hd{font-size:12px;font-weight:600;color:var(--ink2);margin-bottom:10px;display:flex;align-items:center;gap:10px}' +
      '.pxl-row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}' +
      '.pxl-sp{flex:1}.pxl-file{cursor:pointer;position:relative}.pxl-file input{display:none}' +
      // 数据源条
      '.pxl-src{display:flex;gap:16px;align-items:center;flex-wrap:wrap;padding:8px 14px;margin-bottom:12px;background:var(--c-bg-sunken);border:1px solid var(--line);border-radius:var(--radius)}' +
      '.pxl-info{font-size:12px;color:var(--c-ink-3)}.pxl-src-cost{font-size:12px;color:var(--ink2);display:flex;align-items:center;gap:6px}' +
      '.pxl-clear{font-size:11px;color:var(--red);text-decoration:none;font-weight:500}.pxl-clear:hover{text-decoration:underline}' +
      '.pxl-hit{font-size:11px;color:var(--ink3);margin-left:auto;font-weight:400}' +
      '.pxl-filters{display:flex;gap:12px;align-items:flex-end;flex-wrap:wrap;margin-bottom:12px}' +
      '.pxl-sel{border:1px solid var(--line);border-radius:8px;padding:6px 9px;font:inherit;font-size:12.5px;background:var(--c-bg-elev);color:var(--ink)}' +
      // 表格
      '.pxl-scroll{overflow:auto;border:1px solid var(--line);border-radius:var(--radius);background:var(--c-bg-elev);box-shadow:var(--shadow)}' +
      'table.pxl-tbl{border-collapse:separate;border-spacing:0;font-size:12px;width:100%}' +
      '.pxl-tbl th{position:sticky;top:0;background:#FAFAFB;color:var(--ink2);font-weight:600;font-size:11px;padding:8px 8px;border-bottom:2px solid var(--line);white-space:nowrap;text-align:left;cursor:pointer;user-select:none}' +
      '.pxl-tbl th:hover{color:var(--red)}.pxl-tbl th .arw{color:var(--red);font-size:9px;margin-left:3px}' +
      '.pxl-tbl th.num{text-align:right}.pxl-tbl td{padding:6px 8px;border-bottom:1px solid #F2F3F5;white-space:nowrap}' +
      '.pxl-tbl td.num{text-align:right;font-variant-numeric:tabular-nums}.pxl-tbl tbody tr:hover td{background:var(--c-bg-sunken)}' +
      '.pxl-tbl tr.pxl-sum td{position:sticky;bottom:0;background:#F4F6FF;font-weight:700;border-top:2px solid var(--line);border-bottom:none}' +
      '.pxl-gm{font-weight:700}.pxl-gm.pos{color:var(--c-good)}.pxl-gm.neg{color:var(--red)}' +
      '.pxl-empty{padding:40px;text-align:center;color:var(--ink3)}';
    document.head.appendChild(s);
  }

  function refreshInfo() { const s = stats(); const e = el('pxLibInfo'); if (e) e.textContent = '库内 ' + s.n + ' 条 · ' + s.countries + ' 国 · ' + s.products + ' 产品' + (state.costMap.size ? ' · 成本底表 ' + state.costMap.size + ' SKU' : ''); }
  function onConcept(e) { const f = e.target.files && e.target.files[0]; if (!f) return; const rd = new FileReader(); rd.onload = () => { try { const r = importConcept(rd.result); const inf = el('pxLibInfo'); if (inf) inf.textContent = '导入：新增 ' + r.added + ' · 更新 ' + r.updated + ' · 跳过 ' + r.skipped + ' 列'; renderFilters(); renderTable(); setTimeout(refreshInfo, 1800); } catch (err) { const inf = el('pxLibInfo'); if (inf) inf.innerHTML = '<span style="color:var(--c-brand)">解析失败：' + String(err.message || err) + '</span>'; } }; rd.readAsArrayBuffer(f); }

  // 4 维筛选升共享多选（onCommit 关面板才刷——定价库是浏览型，A 派默认语义）。
  // 成本月份是口径开关，另在数据源条渲染（renderCostYm），不入此处。
  function renderFilters() {
    const box = el('pxLibFilters'); if (!box) return;
    box.innerHTML = '';
    if (typeof makeMultiSelect !== 'function') return;   // 组件缺失（极端）时静默降级
    const defs = [
      ['国家', 'country', uniq(r => r.country)],
      ['产品', 'product', uniq(r => r.product || r.sku)],
      ['客户分类', 'custClass', uniq(r => r.custClass)],
      ['线上下', 'onoff', uniq(r => r.onlineOffline)],
    ];
    defs.forEach(([label, key, opts]) => {
      const ms = makeMultiSelect(label, opts, state[key], {
        onCommit: (arr) => { state[key] = arr; saveFiltersOnly(); renderTable(); },
      });
      box.appendChild(ms);
    });
  }
  // 成本月份（单选原生 select，口径开关，放数据源条）。
  function renderCostYm() {
    const slot = el('pxLibYmSlot'); if (!slot) return;
    const months = monthOptions();
    slot.innerHTML = '<select class="pxl-sel" id="pxlF_ym"><option value="">用导入快照</option>' +
      months.map(m => '<option value="' + m + '"' + (m === state.costYm ? ' selected' : '') + '>' + (Math.floor(m / 100) + '/' + String(m % 100).padStart(2, '0')) + '</option>').join('') + '</select>';
    const e = el('pxlF_ym');
    if (e) e.onchange = () => { state.costYm = e.value ? +e.value : null; saveFiltersOnly(); renderTable(); };
  }
  function clearFilters() {
    state.country = []; state.product = []; state.custClass = []; state.onoff = [];
    saveFiltersOnly(); renderFilters(); renderTable();
  }
  function monthOptions() { const set = new Set(); state.costMap.forEach(m => m.forEach((_v, ym) => set.add(ym))); return [...set].sort((a, b) => a - b); }
  const pct = (v) => (v == null ? '—' : (v * 100).toFixed(1) + '%');
  const usd = (v) => (v == null ? '—' : v.toFixed(1));
  const escA = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  // 表头排序：点表头切升降；数值列按数值、文本列按本地字符串比较；空值恒排末尾。
  function sortRecords(recs) {
    if (state.sortCol == null) return recs;
    const col = COLS[state.sortCol]; if (!col) return recs;
    const dir = state.sortDir, out = recs.slice();
    out.sort((a, b) => {
      let va = col.val(a), vb = col.val(b);
      const na = (va == null || va === '' || (typeof va === 'number' && isNaN(va)));
      const nb = (vb == null || vb === '' || (typeof vb === 'number' && isNaN(vb)));
      if (na && nb) return 0; if (na) return 1; if (nb) return -1;   // 空值恒末尾
      if (col.num) return (va - vb) * dir;
      return String(va).localeCompare(String(vb), 'zh') * dir;
    });
    return out;
  }
  function renderTable() {
    const body = el('pxLibBody'); if (!body) return;
    const all = filteredRecords();
    const hit = el('pxLibHit'); if (hit) hit.textContent = '命中 ' + all.length + ' 条 / 共 ' + state.records.size + ' 条';
    if (!all.length) { body.innerHTML = '<div class="pxl-scroll pxl-empty">' + (state.records.size ? '当前筛选无匹配记录。' : '暂无记录，请导入概算表。') + '</div>'; return; }
    const recs = sortRecords(all);
    // 表头（点表头排序，当前排序列带升降箭头）
    const arw = (i) => state.sortCol === i ? '<span class="arw">' + (state.sortDir > 0 ? '▲' : '▼') + '</span>' : '';
    let h = '<div class="pxl-scroll"><table class="pxl-tbl"><thead><tr>' +
      COLS.map((c, i) => '<th class="' + (c.num ? 'num' : '') + '" data-col="' + i + '">' + c.t + arw(i) + '</th>').join('') +
      '</tr></thead><tbody>';
    recs.forEach(r => { h += '<tr>' + COLS.map(c => c.cell ? c.cell(r) : ('<td>' + escA(c.val(r)) + '</td>')).join('') + '</tr>'; });
    // 汇总行：率值列按生命周期发货量(shipVolK)加权（权重全缺时回退算术均值）；金额列取均值；文本列显 —。
    h += '<tr class="pxl-sum">' + COLS.map((c, i) => {
      if (i === 0) return '<td title="率值列按生命周期发货量加权(无权重时均值)；金额列为算术均值">汇总 (' + all.length + ')</td>';
      if (!c.num) return '<td>—</td>';
      const pairs = all.map(r => ({ v: c.val(r), w: +r.shipVolK || 0 })).filter(p => p.v != null && !isNaN(p.v));
      if (!pairs.length) return '<td class="num">—</td>';
      const wsum = pairs.reduce((s, p) => s + p.w, 0);
      const avg = (c.rate && wsum > 0)
        ? pairs.reduce((s, p) => s + p.v * p.w, 0) / wsum
        : pairs.reduce((s, p) => s + p.v, 0) / pairs.length;
      return '<td class="num">' + (c.rate ? pct(avg) : usd(avg)) + '</td>';
    }).join('') + '</tr>';
    h += '</tbody></table></div>';
    body.innerHTML = h;
    // 表头点击绑定（重渲后重绑）
    body.querySelectorAll('th[data-col]').forEach(th => {
      th.onclick = () => {
        const i = +th.dataset.col;
        if (state.sortCol === i) state.sortDir = -state.sortDir; else { state.sortCol = i; state.sortDir = 1; }
        renderTable();
      };
    });
  }
  /* ===================== §5 导出 / 绑定 ===================== */
  function libAoa() {
    const recs = filteredRecords();
    const head = ['国家', '产品', 'SKU', '客户分类', '线上下', '具体客户', 'NSIP', '快照销毛', '当月销毛', 'FOB净价', '区域贡献利润'];
    const pctS = (v) => (v == null || isNaN(v)) ? '' : (v * 100).toFixed(1) + '%';
    const num2 = (v) => (v == null || isNaN(v)) ? '' : +(+v).toFixed(2);
    const aoa = [head];
    recs.forEach(r => {
      const s = r.snap || {};
      const monthCost = (state.costYm != null) ? CostBase.costFloorFor(state.costMap, r.sku, state.costYm) : null;
      const adj = ConceptImport.costAdjustedGM(r, monthCost);
      aoa.push([
        r.country || '', r.product || '', r.sku || '', r.custClass || '', r.onlineOffline || '', r.customer || '',
        num2(s.nsipUsd), pctS(s.grossMarginRate), pctS(adj && adj.gmRate),
        num2(s.fobNetUsd), pctS(s.regionContribRate),
      ]);
    });
    return aoa;
  }
  function exportXlsx() { const aoa = libAoa(); if (aoa.length <= 1) { alert('当前筛选无可导出记录'); return; } ExportUtil.saveXlsx('产品定价库_' + ExportUtil.ymd() + '.xlsx', { '定价库': aoa }); }
  function exportPpt()  { const aoa = libAoa(); if (aoa.length <= 1) { alert('当前筛选无可导出记录'); return; } ExportUtil.savePptxTables('产品定价库_' + ExportUtil.ymd() + '.pptx', '产品定价库', [{ name: '记录', aoa: aoa }]); }
  function exportJson() {
    const data = JSON.stringify({ records: [...state.records.values()] }, null, 2);
    const b64 = btoa(unescape(encodeURIComponent(data)));
    api.saveFile('产品定价库.json', b64, 'json');
  }
  function onImportJson(e) {
    const f = e.target.files && e.target.files[0]; if (!f) return;
    const rd = new FileReader();
    rd.onload = () => { try { const o = JSON.parse(rd.result); let add = 0, upd = 0, bad = 0; (o.records || []).forEach(r => { if (r && r.id && r.snap && typeof r.snap.nsipUsd === 'number') { if (state.records.has(r.id)) upd++; else add++; state.records.set(r.id, r); } else bad++; }); save(); refreshInfo(); renderFilters(); renderTable(); el('pxLibInfo').textContent = 'JSON导入：新增 ' + add + ' · 更新 ' + upd + (bad ? ' · 跳过无效 ' + bad : ''); } catch (err) { el('pxLibInfo').innerHTML = '<span style="color:var(--c-brand)">JSON解析失败</span>'; } };
    rd.readAsText(f);
  }
  window.renderPricingLib = renderPricingLib;
  window.PXLIB_API = { importConcept, importCost, stats };
})();

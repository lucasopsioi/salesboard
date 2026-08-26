// 「路标管理」视图控制器。依赖 RoadmapCore、window.sb(api)、XLSX、window.PXLIB。
(function () {
  const C = window.RoadmapCore;
  const api = (typeof window !== 'undefined' && window.sb) ? window.sb : null;   // 引擎桥；app.js 的 const api 不在本作用域，必须自取
  const el = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const PKEY = 'sb.roadmap.products.v1', MKEY = 'sb.roadmap.menus.v1';
  const LKEY = 'sb.roadmap.launch.v1', BKEY = 'sb.roadmap.battle.v1';
  const state = { products: [], menus: { chipMenu: [] }, editing: null, seriesColors: {},
    samples: [], sampleStyle: { color: '#E0A400', opacity: 0.85 },
    boxStyle: { fill: '#FFFFFF', opacity: 1, bold: true, fontSize: 12 },   // 全局框样式（默认=现观感，升级不改）
    launch: [], battle: [], loaded: false,
    view: 'chart', chart: { mode: 'usd', country: '', year: '', explode: false, manualFrom: '', manualTo: '', category: '', showSamples: false, timeFrom: '', timeTo: '' },
  };
  window.RM_STATE = state;
  /* FOB→RRP 推算配置(sb.roadmap.fob.v1):默认开,乘数可调(音频×3/平板×2.5) */
  state.fobCfg = { on: true, multTablet: 2.5, multAudio: 3 };
  try { const fc = JSON.parse(localStorage.getItem('sb.roadmap.fob.v1') || 'null'); if (fc) Object.assign(state.fobCfg, fc); } catch (e) { }
  function saveFobCfg() { try { localStorage.setItem('sb.roadmap.fob.v1', JSON.stringify(state.fobCfg)); } catch (e) { } }
  let FOBCACHE = null;
  async function rmFobRefresh() {
    if (typeof fobEnsureStore !== 'function') return;
    try {
      const stF = await fobEnsureStore();
      const mtx = stF.matrix(null, null, null);
      const names = {};
      Object.keys(stF.modelInfo()).forEach(k => { names[k] = stF.displayName(k); });
      FOBCACHE = { cells: mtx.cells, names, months: stF.monthsPresent() };
    } catch (e) { FOBCACHE = null; }
  }
  // 诊断：仅当未捕获错误来自路标代码(roadmap-*)时才弹窗，避免误报宿主app/echarts的无关错误；始终记进调试轨迹。
  if (typeof window !== 'undefined' && !window.__rmDiag) {
    window.__rmDiag = true; let shown = false;
    const surf = (what, msg, stack) => {
      if (!state.editing && !state.editingSample) return;
      const st = String(stack || '');
      try { console.warn('[roadmap]', what, msg); } catch (_) {}   // 进 renderer.log 便于排查
      if (st && !/roadmap-(ui|chart|core)/.test(st)) return;     // 非路标代码的错误：不弹窗（只是宿主app噪声）
      if (shown) return; shown = true;
      const top = st.split('\n').slice(0, 5).join('\n');
      try { alert('路标弹窗发生' + what + '：\n' + msg + (top ? '\n' + top : '') + '\n\n请把这段截图发给开发者。'); } catch (_) {}
      setTimeout(() => { shown = false; }, 1500);
    };
    window.addEventListener('error', (ev) => surf('运行错误', (ev && (ev.message || (ev.error && ev.error.message))) || String(ev), ev && ev.error && ev.error.stack));
    window.addEventListener('unhandledrejection', (ev) => surf('异步错误', (ev && ev.reason && (ev.reason.message || ev.reason)) || String(ev), ev && ev.reason && ev.reason.stack));
  }
  function rmTrace() {}   // 诊断面包屑已停用（保留空函数以兼容各处调用）

  function load() {
    try { const o = JSON.parse(localStorage.getItem(PKEY) || 'null'); if (o && Array.isArray(o.products)) state.products = o.products; } catch (e) {}
    try { const m = JSON.parse(localStorage.getItem(MKEY) || 'null'); if (m && Array.isArray(m.chipMenu)) state.menus = m; } catch (e) {}
    try { const sc = JSON.parse(localStorage.getItem('sb.roadmap.series.v1') || 'null'); if (sc && typeof sc === 'object') state.seriesColors = sc; } catch (e) {}
    try { const sm = JSON.parse(localStorage.getItem('sb.roadmap.samples.v1') || 'null'); if (sm && Array.isArray(sm.samples)) state.samples = sm.samples; } catch (e) {}
    try { const ss = JSON.parse(localStorage.getItem('sb.roadmap.samplestyle.v1') || 'null'); if (ss && typeof ss === 'object') state.sampleStyle = { color: ss.color || '#E0A400', opacity: ss.opacity == null ? 0.85 : ss.opacity }; } catch (e) {}
    try { const bs = JSON.parse(localStorage.getItem('sb.roadmap.boxstyle.v1') || 'null'); if (bs && typeof bs === 'object') state.boxStyle = normBoxStyle(bs); } catch (e) {}
    try { const cr = JSON.parse(localStorage.getItem('sb.roadmap.chart.v1') || 'null'); if (cr && typeof cr === 'object') { state.chart.timeFrom = cr.timeFrom || ''; state.chart.timeTo = cr.timeTo || ''; } } catch (e) {}
    try { const ln = JSON.parse(localStorage.getItem(LKEY) || 'null'); if (ln && Array.isArray(ln.launch)) state.launch = ln.launch; } catch (e) {}
    try { const bt = JSON.parse(localStorage.getItem(BKEY) || 'null'); if (bt && Array.isArray(bt.battle)) state.battle = bt.battle; } catch (e) {}
    state.loaded = true;
  }
  // 供 roadmapData() 在路标视图未打开时也能拿到持久化数据（PPT 设计器会先调用）
  function ensureLoaded() { if (!state.loaded) { try { load(); } catch (e) { state.loaded = true; } } }
  function save() { try { localStorage.setItem(PKEY, JSON.stringify({ products: state.products })); return true; } catch (e) { alert('保存失败：' + (e && e.name === 'QuotaExceededError' ? '本地存储空间不足（产品ID图可能过大）。请删减图片或先导出JSON备份。' : (e && e.message || e))); return false; } }
  function purgePredecessor(id) { state.products.forEach(p => { if (p.predecessorId === id) p.predecessorId = ''; }); }
  function purgeSamplesOfProduct(id) { const before = state.samples.length; state.samples = state.samples.filter(s => s.productId !== id); if (state.samples.length !== before) saveSamples(); }
  function saveMenus() { try { localStorage.setItem(MKEY, JSON.stringify(state.menus)); } catch (e) {} }
  function saveSeries() { try { localStorage.setItem('sb.roadmap.series.v1', JSON.stringify(state.seriesColors)); } catch (e) {} }
  function saveSamples() { try { localStorage.setItem('sb.roadmap.samples.v1', JSON.stringify({ samples: state.samples })); } catch (e) {} }
  function saveSampleStyle() { try { localStorage.setItem('sb.roadmap.samplestyle.v1', JSON.stringify(state.sampleStyle)); } catch (e) {} }
  function normBoxStyle(bs) { bs = bs || {}; return { fill: /^#[0-9a-fA-F]{6}$/.test(bs.fill) ? bs.fill : '#FFFFFF', opacity: bs.opacity == null ? 1 : +bs.opacity, bold: bs.bold == null ? true : !!bs.bold, fontSize: bs.fontSize == null ? 12 : +bs.fontSize }; }
  function saveBoxStyle() { try { localStorage.setItem('sb.roadmap.boxstyle.v1', JSON.stringify(state.boxStyle)); } catch (e) {} }
  function saveChartRange() { try { localStorage.setItem('sb.roadmap.chart.v1', JSON.stringify({ timeFrom: state.chart.timeFrom || '', timeTo: state.chart.timeTo || '' })); } catch (e) {} }
  function saveLaunch() { try { localStorage.setItem(LKEY, JSON.stringify({ launch: state.launch })); } catch (e) {} }
  function saveBattle() { try { localStorage.setItem(BKEY, JSON.stringify({ battle: state.battle })); } catch (e) {} }

  function renderRoadmap() {
    rmFobRefresh().then(() => { try { if (state.view === 'chart' && el('rmChart')) renderChart(); } catch (e) { } });
    const root = el('rmRoot'); if (!root) return;
    if (root.dataset.built !== '1') {
      if (!document.getElementById('rm-style')) {
        const s = document.createElement('style'); s.id = 'rm-style';
        s.textContent = '#rmChart{position:relative;border:1px solid var(--line);border-radius:var(--radius);background:var(--c-bg-elev);height:540px;overflow:hidden;box-shadow:var(--shadow)}' +
          '.rmc-grid{position:absolute;left:60px;right:14px;height:1px;background:var(--c-line-soft);z-index:1}' +
          '.rmc-band{position:absolute;left:60px;right:14px}.rmc-band.fill{border-radius:7px}' +
          '.rmc-band .lab{position:absolute;right:6px;top:4px;font-size:11px;color:var(--ink2);font-weight:600;background:rgba(255,255,255,.82);padding:1px 6px;border-radius:5px;box-shadow:0 1px 2px rgba(16,24,40,.08)}' +
          '.rmc-box{position:absolute;transform:translate(-50%,-50%);background:var(--c-bg-elev);border:1px solid var(--line);border-radius:9px;padding:5px 8px;box-shadow:var(--shadow);cursor:pointer;font-size:11px;min-width:96px;z-index:3;transition:box-shadow .16s ease,border-color .16s ease,opacity .16s ease,filter .16s ease}' +
          '.rmc-box.rm-dim{filter:grayscale(1);opacity:.28!important}' +
          '.rmc-svg .rml{transition:opacity .16s ease}.rmc-svg .rml.rm-dim{opacity:.12}' +
          '.rmc-svg .rml.rm-hl{stroke:#C7000B;stroke-width:1.8}' +
          '.rmc-box:hover{border-color:var(--red);box-shadow:var(--shadow-l);z-index:5}.rmc-box.missing{opacity:.4}' +
          '.rmc-box .nm{font-weight:700;font-size:12px;margin-bottom:2px}.rmc-box .dots{margin:2px 0}.rmc-box .dot{display:inline-block;width:8px;height:8px;border-radius:50%;border:1px solid rgba(0,0,0,.08);margin-right:2px}' +
          '.rmc-box .meta{color:var(--ink3);font-size:10px}.rmc-ax{position:absolute;color:var(--ink3);font-size:10px}' +
          '.rmc-svg{position:absolute;inset:0;pointer-events:none;z-index:2}' +
          '.rm-seg{display:inline-flex;border:1px solid var(--line);border-radius:9px;overflow:hidden;background:var(--c-bg-elev);box-shadow:var(--shadow);vertical-align:middle}' +
          '.rm-seg button{border:0;border-right:1px solid var(--line);background:var(--c-bg-elev);font:inherit;font-size:12px;padding:6px 14px;cursor:pointer;color:var(--ink2);transition:background .15s,color .15s}' +
          '.rm-seg button:last-child{border-right:0}.rm-seg button:hover{background:var(--c-bg-sunken);color:var(--ink)}' +
          '.rm-seg button.on{background:var(--red);color:var(--c-bg-elev)}.rm-seg button.on:hover{background:var(--red-d)}';
        document.head.appendChild(s);
      }
      root.dataset.built = '1'; load();
      root.innerHTML =
        '<div style="display:flex;align-items:center;gap:12px;margin-bottom:12px;flex-wrap:wrap">' +
          '<h2 style="margin:0">路标管理</h2><span style="color:var(--c-ink-3);font-size:12px" id="rmInfo"></span>' +
          '<span style="flex:1"></span>' +
          '<button class="btn" id="rmExport">导出底表</button>' +
          '<button class="btn" id="rmExportPpt">导出PPT</button>' +
          '<button class="btn" id="rmExportJson">导出JSON</button>' +
          '<label class="btn" style="cursor:pointer">导入JSON<input type="file" id="rmImportJson" accept=".json" style="display:none"></label>' +
          '<button class="btn" id="rmAddSeries">＋产品系列</button>' +
          '<button class="btn" id="rmAddSample">＋样机</button>' +
          '<button class="btn primary" id="rmAdd">＋产品</button>' +
        '</div>' +
        '<div id="rmCatTabs" class="rm-seg" style="margin-bottom:10px"></div>' +
        '<div class="rm-seg" style="margin-bottom:10px"><button id="rmViewChart">路标图</button><button id="rmViewLife">生命周期</button><button id="rmViewList">列表</button><button id="rmViewLaunch">上市节奏</button><button id="rmViewDetect">🔎 自动识别</button></div>' +
        '<div id="rmMain"></div>' +
        '<div id="rmInputs"></div>' +
        '<div id="rmDialog" style="display:none"></div>';
      el('rmAdd').addEventListener('click', () => openDialog(null));
      el('rmAddSample').addEventListener('click', () => openSampleDialog(null));
      el('rmAddSeries').addEventListener('click', openSeriesEditor);
      el('rmExport').addEventListener('click', exportXlsx);
      el('rmExportPpt').addEventListener('click', exportPpt);
      el('rmExportJson').addEventListener('click', exportJson);
      el('rmImportJson').addEventListener('change', onImportJson);
      el('rmViewChart').addEventListener('click', () => { state.view = 'chart'; renderMain(); });
      el('rmViewList').addEventListener('click', () => { state.view = 'list'; renderMain(); });
      el('rmViewLaunch').addEventListener('click', () => { state.view = 'launch'; renderMain(); });
      el('rmViewLife').addEventListener('click', () => { state.view = 'life'; renderMain(); });
      el('rmViewDetect').addEventListener('click', () => { state.view = 'detect'; renderMain(); });
    }
    renderMain();
  }

  /* ================= 自动识别 · 评审视图 =================
     从 PSI 的逐月 SI/SO 反推「真实上市月 / 是否退市」，逐条摆给用户复核后再落盘。
     取数 = api.launchScan（引擎纯新增）；判定 = RoadmapDetect（纯函数、可单测）。
     **不自动改任何路标数据**——必须勾选后点「应用选中项」才写，且写之前再确认一次条数。 */
  const DET = { scan: null, dets: null, rows: null, orphans: [], opt: null, sel: {}, edit: {}, busy: false, err: '' };
  const DET_KEY = 'sb.roadmap.detect.opt.v1';

  function detOpt() {
    if (DET.opt) return DET.opt;
    let o = null;
    try { o = JSON.parse(localStorage.getItem(DET_KEY) || 'null'); } catch (e) { }
    DET.opt = window.RoadmapDetect.clampOpt(o || {});
    return DET.opt;
  }
  function detOptSave() { try { localStorage.setItem(DET_KEY, JSON.stringify(DET.opt)); } catch (e) { } }

  // 迷你月度 SO 柱图：上市月描红、退市后灰掉——一眼看出判定切在哪
  function detSpark(det, item, months) {
    const so = (item && item.so) || [];
    if (!so.length) return '';
    const peak = so.reduce((a, b) => Math.max(a, +b || 0), 0) || 1;
    const li = months.indexOf(det.launchMonth), ei = det.eolMonth ? months.indexOf(det.eolMonth) : -1;
    const bars = so.map((v, i) => {
      const h = Math.max(1, Math.round((+v || 0) / peak * 22));
      const c = i === li ? 'var(--c-brand)' : (ei >= 0 && i > ei ? 'var(--c-ink-3)' : 'var(--c-ok,#1E9E57)');
      const op = i < li ? '.35' : '1';       // 上市前(样机期)淡显
      return '<i title="' + esc(months[i] + '：' + Math.round(+v || 0) + ' 台') + '" style="display:inline-block;width:5px;margin-right:1px;vertical-align:bottom;height:' + h + 'px;background:' + c + ';opacity:' + op + '"></i>';
    }).join('');
    return '<div style="line-height:0;height:24px;white-space:nowrap">' + bars + '</div>';
  }

  const DET_CONF_COLOR = { high: 'var(--c-ok,#1E9E57)', medium: '#C98A00', low: 'var(--c-brand)' };

  async function detRun() {
    DET.busy = true; DET.err = ''; renderMain();
    try {
      const scan = await api.launchScan({ dim: 'model' });
      if (!scan || scan.error) throw new Error((scan && scan.error) || '取数失败');
      DET.scan = scan;
      DET.dets = window.RoadmapDetect.detectAll(scan, detOpt());
      const m = window.RoadmapDetect.matchProducts(state.products, DET.dets);
      DET.rows = m.rows; DET.orphans = m.orphans;
      DET.sel = {}; DET.edit = {};
      // 默认只勾「有匹配 + 中高置信度」的，低置信度让用户自己看过再决定
      DET.rows.forEach(r => { if (r.det && r.det.confidence !== 'low' && r.det.launchMonth) DET.sel[r.productId] = true; });
    } catch (e) {
      DET.err = (e && e.message) || String(e);
    }
    DET.busy = false; renderMain();
  }

  function detApply() {
    const picked = (DET.rows || []).filter(r => DET.sel[r.productId] && r.det);
    if (!picked.length) { alert('没有勾选任何产品。'); return; }
    const lines = picked.map(r => {
      const e = DET.edit[r.productId] || {};
      const launch = e.shipLate != null ? e.shipLate : window.RoadmapDetect.toRoadmapMonth(r.det.launchMonth);
      const end = e.salesEnd != null ? e.salesEnd : (r.det.status === 'eol' ? window.RoadmapDetect.toRoadmapMonth(r.det.eolMonth) : '');
      return { r, launch, end };
    });
    const changed = lines.filter(x => {
      const p = state.products.find(p => p.id === x.r.productId);
      return p && (p.shipLate !== x.launch || (x.end && p.salesEnd !== x.end));
    });
    if (!confirm('将把 ' + picked.length + ' 个产品的上市时间写入路标（其中 ' + changed.length + ' 个与现值不同），并回填 PSI 关联与首4月SO。\n\n现有的其它字段不动。确认应用？')) return;
    let n = 0;
    lines.forEach(({ r, launch, end }) => {
      const p = state.products.find(p => p.id === r.productId); if (!p) return;
      if (launch) p.shipLate = launch;
      if (end) p.salesEnd = end;
      p.psiLink = r.det.key;
      if (r.det.first4moSO != null) p.first4moSO = r.det.first4moSO;
      n++;
    });
    if (save()) { alert('已应用到 ' + n + ' 个产品。'); DET.sel = {}; renderMain(); }
  }

  function renderDetect(host) {
    const RD = window.RoadmapDetect;
    if (!RD) { host.innerHTML = '<div style="padding:40px;text-align:center;color:var(--c-ink-3)">识别核心未加载（RoadmapDetect 未定义）。</div>'; return; }
    const o = detOpt();
    const num = (id, label, val, step, tip) =>
      '<div class="fld" title="' + esc(tip) + '"><label>' + label + '</label><input type="number" id="' + id + '" value="' + val + '" step="' + step + '" style="width:72px"></div>';
    let h = '<div class="card" style="padding:10px 12px;margin-bottom:10px">'
      + '<div style="font-size:13px;font-weight:600;margin-bottom:6px">从 PSI 实际 SI/SO 反推上市与退市时间</div>'
      + '<div style="font-size:11px;color:var(--c-ink-3);line-height:1.7;margin-bottom:8px">'
      + '上市月＝第一个「月SO ≥ max(绝对下限, 峰值月SO×上市门槛%)」的月；之前那些零星出货记为<b>样机期</b>，不算上市。<br>'
      + '退市＝末端连续 N 个月低于「生命周期月均×退市门槛%」；<b>末端保护</b>的月份不参与判定（底表末月常没录全，音频还要延迟 1~2 周报量）。<br>'
      + '判定只是<b>建议</b>，勾选并可逐条改日期后，点下面的按钮才会写进路标。'
      + '</div>'
      + '<div class="psi-row" style="align-items:flex-end;gap:10px;flex-wrap:wrap">'
      + num('detLR', '上市门槛%', Math.round(o.launchRatio * 100), 1, '占峰值月SO的百分比')
      + num('detLM', '绝对下限(台)', o.launchMinUnits, 5, '防止小量产品被样机噪声顶上去')
      + num('detER', '退市门槛%', Math.round(o.eolRatio * 100), 1, '占生命周期月均SO的百分比')
      + num('detEM', '连续月数', o.eolMonths, 1, '连续几个月低于退市门槛才判退市')
      + num('detTG', '末端保护(月)', o.tailGuard, 1, '最后几个月不参与退市判定（数据未录全）')
      + num('detTA', '音频末端保护', o.tailGuardAudio, 1, '音频人工延迟报量，末端多护几个月')
      + '<button class="btn primary" id="detRun" style="margin-left:6px">' + (DET.busy ? '识别中…' : '开始识别') + '</button>'
      + '<button class="btn" id="detReset">恢复默认</button>'
      + '</div></div>';

    if (DET.err) h += '<div class="card" style="padding:12px;color:var(--c-brand)">识别失败：' + esc(DET.err) + '</div>';
    else if (DET.busy) h += '<div class="card" style="padding:30px;text-align:center;color:var(--c-ink-3)">正在读取 PSI 逐月数据…</div>';
    else if (!DET.rows) h += '<div class="card" style="padding:30px;text-align:center;color:var(--c-ink-3)">点「开始识别」，软件会按上面的规则给出每个产品的上市/退市建议。</div>';
    else {
      const matched = DET.rows.filter(r => r.det), unmatched = DET.rows.filter(r => !r.det);
      const nSel = Object.keys(DET.sel).filter(k => DET.sel[k]).length;
      h += '<div class="card" style="padding:8px 12px;margin-bottom:8px;font-size:12px">'
        + '路标 ' + DET.rows.length + ' 个产品：<b>' + matched.length + '</b> 个匹配到 PSI 数据，' + unmatched.length + ' 个没匹配上'
        + (DET.orphans.length ? '；PSI 里另有 <b>' + DET.orphans.length + '</b> 个产品路标里还没建（' + esc(DET.orphans.slice(0, 5).map(x => x.key).join('、')) + (DET.orphans.length > 5 ? ' 等' : '') + '）' : '')
        + '　·　数据范围 ' + esc((DET.scan.months || [])[0] || '') + ' ~ ' + esc(DET.scan.maxYmd || '')
        + '</div>';
      h += '<div class="card" style="overflow:auto;padding:8px"><table style="border-collapse:collapse;font-size:12px;width:100%">'
        + '<tr>'
        + '<th style="padding:4px 6px"><input type="checkbox" id="detAll"></th>'
        + '<th style="text-align:left;padding:4px 6px">路标产品</th>'
        + '<th style="text-align:left;padding:4px 6px">匹配到的 PSI</th>'
        + '<th style="text-align:left;padding:4px 6px">月度 SO（浅色=样机期，红=上市月，灰=退市后）</th>'
        + '<th style="text-align:left;padding:4px 6px">建议上市</th>'
        + '<th style="text-align:left;padding:4px 6px">现值</th>'
        + '<th style="text-align:left;padding:4px 6px">状态 / 建议销售结束</th>'
        + '<th style="text-align:right;padding:4px 6px">累计SI</th>'
        + '<th style="text-align:right;padding:4px 6px">累计SO</th>'
        + '<th style="text-align:right;padding:4px 6px">库存</th>'
        + '<th style="text-align:left;padding:4px 6px">依据 / 提示</th>'
        + '</tr>';
      DET.rows.forEach(r => {
        const d = r.det;
        const pid = esc(r.productId);
        if (!d) {
          h += '<tr style="border-top:1px solid var(--c-line);opacity:.6">'
            + '<td style="padding:4px 6px"></td><td style="padding:4px 6px">' + esc(r.name || '(未命名)') + '</td>'
            + '<td colspan="9" style="padding:4px 6px;color:var(--c-ink-3)">'
            + (r.how === 'ambiguous' ? 'PSI 里有多个名字都像，不敢乱认——请到产品编辑里手工「关联PSI产品」' : 'PSI 里没找到同名产品（未来新品就该是这样，手工填上市时间即可）')
            + '</td></tr>';
          return;
        }
        const e = DET.edit[r.productId] || {};
        const p = state.products.find(x => x.id === r.productId) || {};
        const sug = RD.toRoadmapMonth(d.launchMonth);
        const curVal = p.shipLate || '';
        const diff = curVal && curVal !== sug;
        const sugEnd = d.status === 'eol' ? RD.toRoadmapMonth(d.eolMonth) : '';
        h += '<tr style="border-top:1px solid var(--c-line)">'
          + '<td style="padding:4px 6px"><input type="checkbox" data-detsel="' + pid + '"' + (DET.sel[r.productId] ? ' checked' : '') + '></td>'
          + '<td style="padding:4px 6px;font-weight:600">' + esc(r.name || '(未命名)') + '</td>'
          + '<td style="padding:4px 6px">' + esc(d.key) + '<span style="color:var(--c-ink-3);font-size:10px"> · ' + (r.how === 'link' ? '手工关联' : r.how === 'name' ? '同名' : '近似名') + '</span></td>'
          + '<td style="padding:4px 6px">' + detSpark(d, (DET.scan.items || []).find(i => i.key === d.key), DET.scan.months) + '</td>'
          + '<td style="padding:4px 6px"><input value="' + esc(e.shipLate != null ? e.shipLate : sug) + '" data-detship="' + pid + '" style="width:82px" placeholder="YYYY/MM">'
          + '<div style="font-size:10px;color:' + DET_CONF_COLOR[d.confidence] + '">置信' + RD.CONF_LABEL[d.confidence] + ' · 当月' + d.launchUnits + '台</div></td>'
          + '<td style="padding:4px 6px;color:' + (diff ? 'var(--c-brand)' : 'var(--c-ink-3)') + '">' + esc(curVal || '(空)') + (diff ? '<div style="font-size:10px">与建议不同</div>' : '') + '</td>'
          + '<td style="padding:4px 6px">' + RD.STATUS_LABEL[d.status]
          + (sugEnd ? '<div><input value="' + esc(e.salesEnd != null ? e.salesEnd : sugEnd) + '" data-detend="' + pid + '" style="width:82px" placeholder="YYYY/MM"></div>' : '')
          + '</td>'
          + '<td style="padding:4px 6px;text-align:right">' + d.cumSI.toLocaleString('en-US') + '</td>'
          + '<td style="padding:4px 6px;text-align:right">' + d.cumSO.toLocaleString('en-US') + '</td>'
          + '<td style="padding:4px 6px;text-align:right">' + d.invLast.toLocaleString('en-US') + '</td>'
          + '<td style="padding:4px 6px;color:var(--c-ink-3);max-width:320px">'
          + (d.sampleMonths ? '样机期 ' + d.sampleMonths + ' 个月 / ' + d.sampleUnits + ' 台<br>' : '')
          + esc(d.notes.join('；')) + '</td>'
          + '</tr>';
      });
      h += '</table></div>';
      h += '<div style="margin-top:10px;display:flex;align-items:center;gap:10px">'
        + '<button class="btn primary" id="detApply">应用选中项到路标（已选 ' + nSel + '）</button>'
        + '<span style="font-size:11px;color:var(--c-ink-3)">只写「上市时间 / 销售结束 / PSI关联 / 首4月SO」四项，其它字段一律不动</span></div>';
    }
    host.innerHTML = h;

    const bind = (id, fn) => { const x = el(id); if (x) x.addEventListener('click', fn); };
    bind('detRun', () => {
      const g = (id, d) => { const x = el(id); const v = x ? +x.value : NaN; return isFinite(v) ? v : d; };
      DET.opt = RD.clampOpt({
        launchRatio: g('detLR', 15) / 100, launchMinUnits: g('detLM', 30),
        eolRatio: g('detER', 10) / 100, eolMonths: g('detEM', 3),
        tailGuard: g('detTG', 1), tailGuardAudio: g('detTA', 2),
      });
      detOptSave(); detRun();
    });
    bind('detReset', () => { DET.opt = RD.clampOpt({}); detOptSave(); renderMain(); });
    bind('detApply', detApply);
    const all = el('detAll');
    if (all) all.addEventListener('change', () => {
      (DET.rows || []).forEach(r => { if (r.det) DET.sel[r.productId] = all.checked; });
      renderMain();
    });
    host.querySelectorAll('[data-detsel]').forEach(cb => cb.addEventListener('change', () => { DET.sel[cb.dataset.detsel] = cb.checked; }));
    host.querySelectorAll('[data-detship]').forEach(ip => ip.addEventListener('change', () => {
      (DET.edit[ip.dataset.detship] = DET.edit[ip.dataset.detship] || {}).shipLate = ip.value.trim();
    }));
    host.querySelectorAll('[data-detend]').forEach(ip => ip.addEventListener('change', () => {
      (DET.edit[ip.dataset.detend] = DET.edit[ip.dataset.detend] || {}).salesEnd = ip.value.trim();
    }));
  }

  /* ================= 生命周期视图（类甘特图，阶段三·玻璃设计语言） =================
     每产品一条 上市→销售结束 的时间条；同跑产品各占一行、天然并列；
     标 ▲上市 ◆EOM ┊EOM+180（之后不可投激励）；仍在售的右端渐隐。
     纯展示：只读 products，不写任何数据。 */
  function renderLifecycle(host) {
    const C2 = window.RoadmapCore;
    const cat = state.chart.category;
    const ps = (state.products || []).filter(p => !cat || p.category === cat);
    const rows = C2.ganttRows(ps);
    if (!rows.length) {
      host.innerHTML = '<div class="g-empty"><div class="g-empty__icon" data-icon="roadmap" data-icon-class="g-ico g-ico--lg"></div>'
        + '<div>还没有可画的生命周期。<br>产品需要填「最晚发货时间」（=上市时间）才会出现在这里。</div></div>';
      if (window.SbUI) window.SbUI.paintIcons(host);
      return;
    }
    // 时间范围：全部区间 ∪ EOM+180，再向右留一年给"仍在售"
    const rg = C2.ganttRange(rows);
    const minT = rg.min.getTime();
    let maxT = rg.max ? rg.max.getTime() : minT;
    const openEnd = new Date(Math.max(maxT, Date.now()) + 365 * 86400000);
    const rows2 = C2.ganttRows(ps, { fallbackEnd: C2.fmtDate(openEnd) });
    maxT = Math.max(maxT, openEnd.getTime());
    const span = Math.max(1, maxT - minT);
    const x = t => ((t - minT) / span * 100);

    // 年份刻度
    const y0 = new Date(minT).getFullYear(), y1 = new Date(maxT).getFullYear();
    let ticks = '';
    for (let y = y0; y <= y1; y++) {
      const tx = x(new Date(y, 0, 1).getTime());
      if (tx < 0 || tx > 100) continue;
      ticks += '<div class="lc-tick" style="left:' + tx.toFixed(2) + '%"><span>' + y + '</span></div>';
    }

    const seriesColor = nm => (state.seriesColors && state.seriesColors[nm]) || 'var(--c-brand)';
    let body = '', lastSeries = null;
    rows2.forEach(r => {
      if (r.series !== lastSeries) {
        lastSeries = r.series;
        body += '<div class="lc-group">' + esc(r.series) + '</div>';
      }
      const left = x(r.start.getTime());
      const right = x((r.endEff || r.start).getTime());
      const w = Math.max(0.8, right - left);
      const eomX = r.eom ? x(r.eom.getTime()) : null;
      const eomPX = r.eomPlus ? x(r.eomPlus.getTime()) : null;
      const tip = r.name + '　上市 ' + C2.fmtDate(r.start)
        + (r.open ? '　销售结束：未定（仍在售）' : '　销售结束 ' + C2.fmtDate(r.end))
        + (r.eom ? '　EOM ' + C2.fmtDate(r.eom) + '　EOM+180 ' + C2.fmtDate(r.eomPlus) : '');
      body += '<div class="lc-row" data-lcid="' + esc(r.id) + '" data-tip="' + esc(tip) + '">'
        + '<div class="lc-name" title="' + esc(r.name) + '">' + esc(r.name) + '</div>'
        + '<div class="lc-track">'
        + '<div class="lc-bar' + (r.open ? ' lc-bar--open' : '') + ' glass-hl" style="left:' + left.toFixed(2) + '%;width:' + w.toFixed(2) + '%;--lc-c:' + seriesColor(r.series) + '"></div>'
        + '<div class="lc-mk lc-mk--start" style="left:' + left.toFixed(2) + '%"></div>'
        + (eomX != null ? '<div class="lc-mk lc-mk--eom" style="left:' + eomX.toFixed(2) + '%"></div>' : '')
        + (eomPX != null ? '<div class="lc-mk lc-mk--eom180" style="left:' + eomPX.toFixed(2) + '%"></div>' : '')
        + '</div></div>';
    });

    host.innerHTML =
      '<div class="card g-enter" style="padding:16px 18px">'
      + '<div class="lc-head">'
      +   '<b style="font-size:var(--fs-14)">产品销售生命周期</b>'
      +   '<span class="lc-legend"><i class="lc-lg lc-lg--bar"></i>在售区间</span>'
      +   '<span class="lc-legend"><i class="lc-lg lc-lg--start"></i>上市</span>'
      +   '<span class="lc-legend"><i class="lc-lg lc-lg--eom"></i>EOM</span>'
      +   '<span class="lc-legend"><i class="lc-lg lc-lg--eom180"></i>EOM+180（之后不可投激励）</span>'
      +   '<span style="flex:1"></span>'
      +   '<span style="font-size:var(--fs-11);color:var(--c-ink-3)">共 ' + rows2.length + ' 个产品 · 同跑产品并列显示 · 右端渐隐 = 仍在售</span>'
      + '</div>'
      + '<div class="lc-wrap"><div class="lc-ticks">' + ticks + '</div>' + body + '</div>'
      + '</div>';
    if (window.SbUI) window.SbUI.paintIcons(host);
  }

  function renderMain() {
    rmTrace('main:' + state.view);
    const ct = el('rmCatTabs');
    if (ct) {
      ct.innerHTML = ['', ...CATEGORIES].map(c => '<button data-cat="' + esc(c) + '" class="' + (state.chart.category === c ? 'on' : '') + '">' + (c === '' ? '全部' : esc(c)) + '</button>').join('');
      ct.querySelectorAll('button[data-cat]').forEach(b => b.addEventListener('click', () => { state.chart.category = b.dataset.cat; renderMain(); }));
    }
    el('rmViewChart').classList.toggle('on', state.view === 'chart');
    el('rmViewList').classList.toggle('on', state.view === 'list');
    el('rmViewLaunch').classList.toggle('on', state.view === 'launch');
    el('rmViewLife').classList.toggle('on', state.view === 'life');
    el('rmViewDetect').classList.toggle('on', state.view === 'detect');
    const main = el('rmMain'); if (!main) return;
    if (state.view === 'detect') { renderDetect(main); return; }
    if (state.view === 'life') { renderLifecycle(main); return; }
    if (state.view === 'list') { main.innerHTML = '<div id="rmListWrap"></div>'; renderList(); renderInputs(); return; }
    if (state.view === 'launch') {
      main.innerHTML = '';
      // 防御：上市节奏视图 script 由后续任务接线，未定义时给提示而非崩溃
      if (window.RoadmapLaunchUI && typeof window.RoadmapLaunchUI.render === 'function') window.RoadmapLaunchUI.render(main);
      else main.innerHTML = '<div style="padding:40px;text-align:center;color:var(--ink3)">「上市节奏」组件尚未加载（RoadmapLaunchUI 未定义）。</div>';
      return;
    }
    main.innerHTML = '<div id="rmChartTools" style="margin-bottom:8px"></div><div id="rmChart"></div><div id="rmTimeSlider"></div>';
    renderChartTools(); renderChart(); renderTimeSlider(); renderInputs();
  }
  function chartProducts() {
    let ps = state.products;
    if (state.chart.category) ps = ps.filter(p => p.category === state.chart.category);
    ps = RoadmapChart.filterByYear(ps, state.chart.year);
    if (state.chart.explode) ps = RoadmapChart.explodeBySku(ps);
    return ps;
  }
  function renderChart() {
    rmTrace('chart');
    const host = el('rmChart'); if (!host) return;
    let ps = chartProducts();
    if (!ps.length) { host.innerHTML = '<div style="padding:40px;text-align:center;color:var(--ink3)">暂无产品。切到「列表」点＋产品添加。</div>'; return; }
    // FOB 推算注入(渲染副本,不落库):缺价产品拿 Floor FOB×乘数 落到对应价格档位
    state._fobEstIds = null; let _fobEstN = 0;
    if (state.fobCfg.on && FOBCACHE && typeof RoadmapChart.fobEstimate === 'function') {
      const est = RoadmapChart.fobEstimate(ps, FOBCACHE, state.fobCfg);
      ps = est.list; state._fobEstIds = est.estIds; _fobEstN = est.count;
    }
    const mf = parseFloat(state.chart.manualFrom), mt = parseFloat(state.chart.manualTo);
    const manual = (!isNaN(mf) && !isNaN(mt) && mf !== mt) ? { from: mf, to: mt } : null;
    const isUsd = state.chart.mode === 'usd';
    const usedSeries = [...new Set(ps.map(p => p.seriesGroup).filter(Boolean))];
    const seriesRanges = isUsd ? usedSeries.map(s => state.seriesColors[s]).filter(Boolean).map(sc => ({ from: sc.from, to: sc.to })) : [];
    const samplesForView = state.chart.showSamples ? state.samples.filter(s => { const p = state.products.find(x => x.id === s.productId); return p && (!state.chart.category || p.category === state.chart.category); }) : [];
    const extraTimes = samplesForView.map(s => s.shipLate);
    const timeRange = (state.chart.timeFrom || state.chart.timeTo) ? { from: state.chart.timeFrom, to: state.chart.timeTo } : null;
    const out = RoadmapChart.productPoints(ps, { mode: state.chart.mode, country: state.chart.country, manualRange: manual, seriesRanges: seriesRanges, extraTimes: extraTimes, timeRange: timeRange, boxStyle: state.boxStyle });
    const bandColors = isUsd ? state.seriesColors : Object.keys(state.seriesColors).reduce((m, k) => { const v = state.seriesColors[k] || {}; m[k] = { color: v.color, opacity: v.opacity }; return m; }, {});
    const bands = RoadmapChart.seriesBands(out.points, bandColors, out.pScale);
    const links = RoadmapChart.successionLinks(out.points);
    const W = host.clientWidth || 900, H = 540, padL = 60, padR = 14, padT = 32, padB = 40;   // 上下留白避免最高/最低价产品方框被裁切
    const px = (x) => padL + x * (W - padL - padR);
    const py = (y) => padT + y * (H - padT - padB);
    let h = '';
    // 色带
    bands.forEach(b => {
      const top = py(Math.min(b.minY, b.maxY)), bot = py(Math.max(b.minY, b.maxY));
      const hgt = Math.max(3, bot - top);
      h += '<div class="rmc-band fill" style="top:' + top + 'px;height:' + hgt + 'px;background:' + esc(b.color) + ';opacity:' + (+b.opacity || 0) + '"></div>' +
        '<div class="rmc-band" style="top:' + top + 'px;height:' + hgt + 'px;background:transparent"><span class="lab">' + esc(b.series) + '</span></div>';
    });
    // Y 轴刻度（5 档）
    for (let i = 0; i <= 4; i++) { const v = out.pScale.max - (i / 4) * (out.pScale.max - out.pScale.min); h += '<div class="rmc-grid" style="top:' + py(i / 4) + 'px"></div><div class="rmc-ax" style="left:6px;top:' + (py(i / 4) - 6) + 'px">' + Math.round(v) + '</div>'; }
    h += '<div class="rmc-ax" style="left:6px;top:2px;font-weight:600">' + (state.chart.mode === 'usd' ? 'USD' : (state.chart.country || '本币')) + '</div>';
    // X 轴：起止时间（只取有效日期，空/非法日期不参与，避免显示空白或错误）
    const _vdates = ps.map(p => p.shipLate).filter(d => RoadmapChart.ymNum(d) != null).sort((a, b) => RoadmapChart.ymNum(a) - RoadmapChart.ymNum(b));
    const _minD = _vdates[0] || '', _maxD = _vdates[_vdates.length - 1] || '';
    h += '<div class="rmc-ax" style="left:' + padL + 'px;bottom:6px">' + esc(_minD) + '</div>';
    h += '<div class="rmc-ax" style="right:' + padR + 'px;bottom:6px">' + (_maxD ? esc(_maxD) + ' ' : '') + '发货时间→</div>';
    // SVG 接续线：正交折线（水平段+直角竖段），竖线车道自动错开且左右留白；hover 时链上标红、链外变灰
    const routed = RoadmapChart.orthoRoute(links.map(l => ({ x1: px(l.from.x), y1: py(l.from.y), x2: px(l.to.x), y2: py(l.to.y) })), { gap: 14, pad: 10 });
    h += '<svg class="rmc-svg" width="' + W + '" height="' + H + '"><defs>' +
      '<marker id="rmArrow" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto"><path d="M0,0 L6,3 L0,6" fill="#888"/></marker>' +
      '<marker id="rmArrowHl" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto"><path d="M0,0 L6,3 L0,6" fill="#C7000B"/></marker></defs>' +
      routed.map((r, i) => {
        const segs = r.segs; if (!segs.length) return '';
        const d = 'M' + segs[0].x1 + ',' + segs[0].y1 + segs.map(s => 'L' + s.x2 + ',' + s.y2).join('');
        return '<path class="rml" data-from="' + esc(String(links[i].fromId || '')) + '" data-to="' + esc(String(links[i].toId || '')) + '" d="' + d + '" fill="none" stroke="#888" stroke-width="1.4" stroke-dasharray="5 4" marker-end="url(#rmArrow)"/>';
      }).join('') + '</svg>';
    // 超范围产品计数提示（时间切片器裁掉的产品数）
    if (out.hidden) h += '<div style="position:absolute;left:50%;top:5px;transform:translateX(-50%);font-size:11px;color:var(--c-brand);background:rgba(255,255,255,.88);padding:1px 9px;border-radius:6px;box-shadow:0 1px 2px rgba(16,24,40,.08);z-index:4">' + out.hidden + ' 个产品在时间范围外</div>';
    if (_fobEstN) h += '<div style="position:absolute;right:14px;top:5px;font-size:11px;color:var(--ink2);background:rgba(255,255,255,.88);padding:1px 9px;border-radius:6px;z-index:4">≈ ' + _fobEstN + ' 个产品价格由 Floor FOB×' + state.fobCfg.multTablet + '/' + state.fobCfg.multAudio + ' 推算</div>';
    // 方框（框样式=全局 boxStyle 经产品级覆盖后所见即所得：填充/透明/加粗/字号）
    out.points.forEach(p => {
      const x = px(p.x), y = p.missing ? py(0.5) : py(p.y);
      const st = p.style || { fill: '#FFFFFF', opacity: 1, bold: true, fontSize: 12 };
      const op = p.missing ? 0.4 : st.opacity;
      const nmSize = st.fontSize, metaSize = Math.max(8, st.fontSize - 2), nmWeight = st.bold ? 700 : 400;
      const dots = p.dots.slice(0, 6).map(c => '<span class="dot" style="background:' + esc(c) + '"></span>').join('');
      const isEst = state._fobEstIds && state._fobEstIds.has(p.realId);
      const val = p.missing ? '无本币价' : ((isEst ? '≈' : '') + (state.chart.mode === 'usd' ? ('$' + Math.round(p.value)) : Math.round(p.value)) + (isEst ? '(FOB)' : ''));
      h += '<div class="rmc-box' + (p.missing ? ' missing' : '') + '" data-rid="' + esc(p.realId) + '" style="left:' + x + 'px;top:' + y + 'px;background:' + esc(st.fill) + ';opacity:' + op + '">' +
        '<div class="nm" style="font-weight:' + nmWeight + ';font-size:' + nmSize + 'px">' + esc(p.name) + '</div>' + (dots ? '<div class="dots">' + dots + '</div>' : '') +
        '<div class="meta" style="font-size:' + metaSize + 'px">' + esc(p.config) + '</div><div class="meta" style="font-size:' + metaSize + 'px">' + val + ' · ' + esc(p.shipLate) + '</div></div>';
    });
    const sPts = RoadmapChart.samplePoints(samplesForView, state.products, { mode: state.chart.mode, country: state.chart.country, tScale: out.tScale, pScale: out.pScale });
    sPts.forEach(s => {
      const x = px(s.x), y = s.missing ? py(0.5) : py(s.y);
      h += '<div class="rmc-box sample' + (s.missing ? ' missing' : '') + '" data-sid="' + esc(s.id) + '" style="left:' + x + 'px;top:' + y + 'px;background:' + esc(state.sampleStyle.color) + ';opacity:' + (s.missing ? 0.35 : (state.sampleStyle.opacity == null ? 0.85 : state.sampleStyle.opacity)) + '">' +
        '<div class="nm">' + esc(s.name) + ' <span style="font-size:9px;color:#7a4">' + esc(s.type) + '</span></div>' +
        '<div class="meta">' + esc(s.code) + '</div><div class="meta">' + esc(s.shipLate) + '</div></div>';
    });
    host.innerHTML = h;
    host.querySelectorAll('.rmc-box[data-rid]').forEach(b => b.addEventListener('click', () => { const prod = state.products.find(p => p.id === b.dataset.rid); if (prod) openDialog(prod); }));
    /* 水平拖拽 = 改上市时间(用户 2026-08-25:生成完的路标直接拖产品定上市时间)。
       位移<6px 视为点击(仍开编辑框);拖动中顶部浮出目标月份;松手写回 shipLate='YYYY/MM' 持久化。 */
    (function () {
      const ts2 = out.tScale;
      if (ts2.maxN === ts2.minN) return;   // 单一时间点,横轴无意义
      host.querySelectorAll('.rmc-box[data-rid]').forEach(b => {
        b.title = '拖动=改上市时间 · 点击=编辑';
        b.style.touchAction = 'none';
        b.addEventListener('pointerdown', ev => {
          if (ev.button !== 0) return;
          const rid = b.dataset.rid;
          const rect0 = host.getBoundingClientRect();
          const startX = ev.clientX;
          let moved = false, tip = null;
          const mv = e2 => {
            if (!moved && Math.abs(e2.clientX - startX) < 6) return;
            if (!moved) {
              moved = true;
              try { b.setPointerCapture(ev.pointerId); } catch (e3) { }
              b.style.zIndex = 99; b.style.opacity = .75; b.style.cursor = 'grabbing';
              tip = document.createElement('div');
              tip.style.cssText = 'position:absolute;top:4px;padding:2px 10px;background:var(--c-brand);color:#fff;font-size:12px;border-radius:6px;z-index:100;pointer-events:none;white-space:nowrap';
              host.appendChild(tip);
            }
            const mx = e2.clientX - rect0.left;
            b.style.left = mx + 'px';
            const xn = Math.max(0, Math.min(1, (mx - padL) / (W - padL - padR)));
            const mo = Math.round(ts2.minN + xn * (ts2.maxN - ts2.minN));
            b._dropYm = Math.floor((mo - 1) / 12) + '/' + String(((mo - 1) % 12) + 1).padStart(2, '0');
            tip.textContent = '上市 → ' + b._dropYm;
            tip.style.left = Math.min(mx, rect0.width - 120) + 'px';
          };
          const up = () => {
            document.removeEventListener('pointermove', mv);
            document.removeEventListener('pointerup', up);
            if (tip) tip.remove();
            if (!moved) return;
            b._squelchClick = true;
            const prod = state.products.find(p3 => p3.id === rid);
            if (prod && b._dropYm) {
              prod.shipLate = b._dropYm;
              save();
              if (typeof toast === 'function') toast(prod.name + ' 上市时间 → ' + b._dropYm, 'ok');
            }
            renderChart(); renderTimeSlider();
          };
          document.addEventListener('pointermove', mv);
          document.addEventListener('pointerup', up);
        });
        // 拖拽后的 click 吞掉,不误开编辑框(capture 先于既有 bubble 监听)
        b.addEventListener('click', e4 => { if (b._squelchClick) { b._squelchClick = false; e4.stopImmediatePropagation(); } }, true);
      });
    })();
    host.querySelectorAll('.rmc-box.sample[data-sid]').forEach(b => b.addEventListener('click', () => { const sm = state.samples.find(s => s.id === b.dataset.sid); if (sm) openSampleDialog(sm); }));
    // hover 接续链高亮：停在产品上→整条前代+后代链保持原色+连线标红，其余产品/样机/连线变灰；移开全部恢复。孤立产品（无接续关系）不触发。
    (function () {
      const allBoxes = host.querySelectorAll('.rmc-box');
      const allLinks = host.querySelectorAll('.rmc-svg .rml');
      const clearHl = () => {
        allBoxes.forEach(bx => bx.classList.remove('rm-dim'));
        allLinks.forEach(ln => { ln.classList.remove('rm-dim', 'rm-hl'); ln.setAttribute('marker-end', 'url(#rmArrow)'); });
      };
      host.querySelectorAll('.rmc-box[data-rid]').forEach(b => {
        b.addEventListener('mouseenter', () => {
          const chain = RoadmapChart.successionChain(state.products, b.dataset.rid);
          if (chain.length < 2) return;
          const set = new Set(chain.map(String));
          allBoxes.forEach(bx => bx.classList.toggle('rm-dim', !(bx.dataset.rid && set.has(bx.dataset.rid))));
          allLinks.forEach(ln => {
            const on = set.has(ln.dataset.from) && set.has(ln.dataset.to);
            ln.classList.toggle('rm-hl', on); ln.classList.toggle('rm-dim', !on);
            ln.setAttribute('marker-end', on ? 'url(#rmArrowHl)' : 'url(#rmArrow)');
          });
        });
        b.addEventListener('mouseleave', clearHl);
      });
    })();
    host.querySelectorAll('.rmc-box[data-rid]').forEach(b => b.addEventListener('contextmenu', (ev) => {
      ev.preventDefault();
      const old = document.getElementById('rmCtxMenu'); if (old) old.remove();
      const prod = state.products.find(p => p.id === b.dataset.rid); if (!prod) return;
      const m = document.createElement('div'); m.id = 'rmCtxMenu';
      m.style.cssText = 'position:fixed;z-index:80;background:var(--c-bg-elev);border:1px solid var(--line);border-radius:8px;box-shadow:var(--shadow-l);padding:4px;font-size:13px;left:' + ev.clientX + 'px;top:' + ev.clientY + 'px';
      m.innerHTML = '<div id="rmCtxDel" style="padding:6px 14px;cursor:pointer;color:var(--c-brand);border-radius:6px">删除产品「' + esc(prod.name || '') + '」</div>';
      document.body.appendChild(m);
      const close = () => { m.remove(); document.removeEventListener('mousedown', onDoc); };
      const onDoc = (e2) => { if (!m.contains(e2.target)) close(); };
      setTimeout(() => document.addEventListener('mousedown', onDoc), 0);
      m.querySelector('#rmCtxDel').addEventListener('click', () => {
        close();
        if (!confirm('确定删除产品「' + (prod.name || '') + '」？')) return;
        const idx = state.products.findIndex(p => p.id === prod.id); if (idx >= 0) state.products.splice(idx, 1);
        purgePredecessor(prod.id);
        purgeSamplesOfProduct(prod.id);
        save(); renderChart();
      });
    }));
  }
  function renderChartTools() {
    const t = el('rmChartTools'); if (!t) return; const c = state.chart;
    const years = [...new Set(state.products.map(p => (String(p.shipLate || '').match(/^(\d{4})/) || [])[1]).filter(Boolean))].sort();
    const countries = [...new Set(state.products.flatMap(p => (p.pricing || []).map(r => r.country)).filter(Boolean))].sort();
    const sel = (id, label, opts, val) => '<select id="' + id + '" class="px-sel" style="margin-right:8px">' + (label ? '<option value="">' + label + '</option>' : '') + opts.map(o => '<option value="' + esc(o) + '"' + (o === val ? ' selected' : '') + '>' + esc(o) + '</option>').join('') + '</select>';
    t.innerHTML =
      '<span style="font-size:12px;color:var(--ink2);margin-right:6px">计价</span>' +
      '<span class="rm-seg" style="margin-right:10px"><button id="rmModeUsd" class="' + (c.mode === 'usd' ? 'on' : '') + '">USD</button><button id="rmModeLocal" class="' + (c.mode === 'local' ? 'on' : '') + '">本币</button></span>' +
      (c.mode === 'local' ? sel('rmCountry', '选国家', countries, c.country) : '') +
      '<span style="font-size:12px;color:var(--ink2);margin:0 6px">年份</span>' + sel('rmYear', '全部', years, c.year) +
      '<label style="font-size:12px;margin-right:10px"><input type="checkbox" id="rmExplode"' + (c.explode ? ' checked' : '') + '> 型号拆解</label>' +
      '<label style="font-size:12px;margin-right:6px"><input type="checkbox" id="rmShowSamples"' + (c.showSamples ? ' checked' : '') + '> 显示样机</label>' +
      '<input type="color" id="rmSampleColor" value="' + (/^#[0-9a-fA-F]{6}$/.test(state.sampleStyle.color) ? state.sampleStyle.color : '#E0A400') + '" title="样机框颜色" style="width:34px;height:24px;border:1px solid var(--line);border-radius:6px;padding:0;vertical-align:middle">' +
      '<input type="range" id="rmSampleOpacity" min="0" max="1" step="0.05" value="' + (state.sampleStyle.opacity == null ? 0.85 : state.sampleStyle.opacity) + '" title="样机框透明度" style="width:80px;vertical-align:middle">' +
      '<span style="font-size:12px;color:var(--ink2);margin-right:4px">Y量程</span><input id="rmYFrom" placeholder="自动" value="' + esc(c.manualFrom) + '" style="width:64px;border:1px solid var(--line);border-radius:6px;padding:4px 6px;margin-right:3px">~<input id="rmYTo" placeholder="自动" value="' + esc(c.manualTo) + '" style="width:64px;border:1px solid var(--line);border-radius:6px;padding:4px 6px;margin-left:3px">' +
      '<span style="font-size:12px;color:var(--ink2);margin:0 4px 0 12px">时间</span>' +
      '<input type="date" id="rmTimeFrom" value="' + toDateValue(c.timeFrom) + '" title="起始(空=自动)" style="border:1px solid var(--line);border-radius:6px;padding:4px 6px;font:inherit">' +
      '<span style="margin:0 3px">~</span>' +
      '<input type="date" id="rmTimeTo" value="' + toDateValue(c.timeTo) + '" title="结束(空=自动)" style="border:1px solid var(--line);border-radius:6px;padding:4px 6px;font:inherit">' +
      '<button class="btn" id="rmTimeReset" title="复位为自动全范围" style="padding:4px 8px;margin-left:4px">复位</button>' +
      '<button class="btn" id="rmBoxStyle" title="全局框样式（单产品可在产品弹窗覆盖）" style="padding:4px 10px;margin-left:12px">框样式…</button>' +
      '<label style="font-size:12px;margin-left:12px" title="缺价产品用 Floor FOB×渠长倍数推算 RRP 落位(≈标注);手填RRP/SKU价永远优先"><input type="checkbox" id="rmFobEst"' + (state.fobCfg.on ? ' checked' : '') + '> ≈FOB推算缺价</label>' +
      '<span style="font-size:12px;color:var(--ink2)"> 平板×</span><input id="rmFobMt" value="' + state.fobCfg.multTablet + '" style="width:42px;border:1px solid var(--line);border-radius:6px;padding:4px 4px">' +
      '<span style="font-size:12px;color:var(--ink2)"> 音频×</span><input id="rmFobMa" value="' + state.fobCfg.multAudio + '" style="width:36px;border:1px solid var(--line);border-radius:6px;padding:4px 4px">';
    const rec = () => renderChart();
    el('rmModeUsd').onclick = () => { c.mode = 'usd'; renderChartTools(); rec(); };
    el('rmModeLocal').onclick = () => { c.mode = 'local'; if (!c.country && countries.length) c.country = countries[0]; renderChartTools(); rec(); };
    if (el('rmCountry')) el('rmCountry').onchange = (e) => { c.country = e.target.value; rec(); };
    el('rmYear').onchange = (e) => { c.year = e.target.value; rec(); };
    el('rmFobEst').onchange = (e) => { state.fobCfg.on = e.target.checked; saveFobCfg(); rec(); };
    el('rmFobMt').onchange = (e) => { const v = parseFloat(e.target.value); if (v > 0) state.fobCfg.multTablet = v; saveFobCfg(); rec(); };
    el('rmFobMa').onchange = (e) => { const v = parseFloat(e.target.value); if (v > 0) state.fobCfg.multAudio = v; saveFobCfg(); rec(); };
    el('rmExplode').onchange = (e) => { c.explode = e.target.checked; rec(); };
    el('rmShowSamples').onchange = (e) => { c.showSamples = e.target.checked; rec(); };
    el('rmSampleColor').oninput = (e) => { state.sampleStyle.color = e.target.value; saveSampleStyle(); rec(); };
    el('rmSampleOpacity').oninput = (e) => { state.sampleStyle.opacity = +e.target.value; saveSampleStyle(); rec(); };
    el('rmYFrom').oninput = (e) => { c.manualFrom = e.target.value.trim(); rec(); };
    el('rmYTo').oninput = (e) => { c.manualTo = e.target.value.trim(); rec(); };
    el('rmTimeFrom').onchange = () => { c.timeFrom = dateRead('rmTimeFrom'); applyTimeRange(); };
    el('rmTimeTo').onchange = () => { c.timeTo = dateRead('rmTimeTo'); applyTimeRange(); };
    el('rmTimeReset').onclick = () => { c.timeFrom = ''; c.timeTo = ''; applyTimeRange(); };
    el('rmBoxStyle').onclick = openBoxStyleEditor;
  }
  // 时间范围变更统一收口：持久化 + 重渲工具栏(同步日期框)/图/切片器。切片器与工具栏双向同步。
  function applyTimeRange() { saveChartRange(); renderChartTools(); renderChart(); renderTimeSlider(); }

  // 时间轴双把手范围条（纯 DOM，无库）：轨道=全数据 ymNum 范围；拖左右把手缩放、拖中段平移、双击复位为自动。
  function renderTimeSlider() {
    const host = el('rmTimeSlider'); if (!host) return;
    const ps = chartProducts();
    const ns = ps.map(p => RoadmapChart.ymNum(p.shipLate)).filter(v => v != null);
    if (ns.length < 2) { host.innerHTML = ''; return; }   // 不足两个日期点：无可拖范围
    const dataMin = Math.min(...ns), dataMax = Math.max(...ns), span = dataMax - dataMin;
    const c = state.chart;
    const fromN = c.timeFrom ? RoadmapChart.ymNum(c.timeFrom) : null;
    const toN = c.timeTo ? RoadmapChart.ymNum(c.timeTo) : null;
    let winFrom = (fromN != null ? fromN : dataMin), winTo = (toN != null ? toN : dataMax);
    if (winFrom > winTo) { const t = winFrom; winFrom = winTo; winTo = t; }
    const isAuto = (fromN == null && toN == null);
    host.innerHTML =
      '<div style="display:flex;align-items:center;gap:8px;margin-top:8px">' +
      '<span style="font-size:11px;color:var(--ink3);white-space:nowrap">' + esc(numToYmd(dataMin)) + '</span>' +
      '<div id="rmSldTrack" style="position:relative;flex:1;height:26px;background:var(--c-line-soft);border-radius:13px;cursor:pointer;user-select:none;touch-action:none">' +
        '<div id="rmSldSel" style="position:absolute;top:0;bottom:0;background:rgba(199,0,11,.16);border:1px solid rgba(199,0,11,.5);border-radius:13px;cursor:grab"></div>' +
        '<div id="rmSldH0" data-h="0" style="position:absolute;top:-2px;width:14px;height:30px;margin-left:-7px;background:var(--c-bg-elev);border:2px solid var(--red);border-radius:5px;box-shadow:var(--shadow);cursor:ew-resize;z-index:2"></div>' +
        '<div id="rmSldH1" data-h="1" style="position:absolute;top:-2px;width:14px;height:30px;margin-left:-7px;background:var(--c-bg-elev);border:2px solid var(--red);border-radius:5px;box-shadow:var(--shadow);cursor:ew-resize;z-index:2"></div>' +
      '</div>' +
      '<span style="font-size:11px;color:var(--ink3);white-space:nowrap">' + esc(numToYmd(dataMax)) + '</span>' +
      '<span style="font-size:11px;color:' + (isAuto ? 'var(--ink3)' : 'var(--red)') + ';white-space:nowrap;min-width:140px">' +
        (isAuto ? '全范围（拖动可缩放）' : (esc(numToYmd(winFrom)) + ' ~ ' + esc(numToYmd(winTo)))) + '</span>' +
      '</div>';
    const track = el('rmSldTrack'), sel = el('rmSldSel'), h0 = el('rmSldH0'), h1 = el('rmSldH1');
    const toPct = (n) => span ? Math.max(0, Math.min(100, ((n - dataMin) / span) * 100)) : 0;
    const layout = (a, b) => { const pa = toPct(a), pb = toPct(b); sel.style.left = pa + '%'; sel.style.width = Math.max(0, pb - pa) + '%'; h0.style.left = pa + '%'; h1.style.left = pb + '%'; };
    layout(winFrom, winTo);
    // 拖拽：把手缩放 / 中段平移；实时更新 DOM，松手(commit)才写状态并重渲。
    let drag = null, curFrom = winFrom, curTo = winTo;
    const nAt = (clientX) => { const r = track.getBoundingClientRect(); let p = (clientX - r.left) / (r.width || 1); p = Math.max(0, Math.min(1, p)); return dataMin + p * span; };
    const onMove = (ev) => {
      if (!drag) return; const n = nAt(ev.clientX); const minGap = span * 0.02;
      if (drag.type === 'h0') curFrom = Math.min(n, curTo - minGap);
      else if (drag.type === 'h1') curTo = Math.max(n, curFrom + minGap);
      else { const w = drag.to0 - drag.from0; let nf = drag.from0 + (n - drag.grab); nf = Math.max(dataMin, Math.min(dataMax - w, nf)); curFrom = nf; curTo = nf + w; }
      curFrom = Math.max(dataMin, curFrom); curTo = Math.min(dataMax, curTo);
      layout(curFrom, curTo);
    };
    const onUp = () => {
      if (!drag) return; drag = null;
      document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp);
      // 贴合数据边界即视为「该侧自动」（不写死值，保留自动语义）
      c.timeFrom = (curFrom <= dataMin + span * 1e-6) ? '' : numToYmd(curFrom);
      c.timeTo = (curTo >= dataMax - span * 1e-6) ? '' : numToYmd(curTo);
      applyTimeRange();
    };
    const start = (type) => (ev) => { ev.preventDefault(); drag = { type: type, from0: curFrom, to0: curTo, grab: nAt(ev.clientX) }; document.addEventListener('mousemove', onMove); document.addEventListener('mouseup', onUp); };
    h0.addEventListener('mousedown', start('h0'));
    h1.addEventListener('mousedown', start('h1'));
    sel.addEventListener('mousedown', start('pan'));
    track.addEventListener('dblclick', () => { c.timeFrom = ''; c.timeTo = ''; applyTimeRange(); });
  }

  // ymNum 逆运算 → 存储日期串 'YYYY/MM/DD'（切片器把手位置回写用；与 RoadmapChart.ymNum 互逆）。
  function numToYmd(n) {
    if (n == null || isNaN(n)) return '';
    const base = Math.floor(n + 1e-9), frac = n - base;   // base = y*12+mo（整数月序），frac∈[0,1)
    const y = Math.floor((base - 1) / 12), mo = base - y * 12;
    const dim = new Date(y, mo, 0).getDate();
    let day = Math.round(frac * dim) + 1; if (day < 1) day = 1; if (day > dim) day = dim;
    const pad = (x) => String(x).padStart(2, '0');
    return y + '/' + pad(mo) + '/' + pad(day);
  }

  // 全局框样式弹层：填充色/透明度/加粗/字号；改动即存并重渲图。说明「单产品可在产品弹窗覆盖」。
  function openBoxStyleEditor() {
    const bs = state.boxStyle;
    const ov = document.createElement('div');
    ov.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.4);z-index:60;display:flex;align-items:center;justify-content:center';
    ov.innerHTML = '<div class="card" style="background:var(--c-bg-elev);padding:18px;min-width:340px;max-width:90vw">' +
      '<div style="font-weight:600;margin-bottom:4px">全局框样式</div>' +
      '<div style="font-size:12px;color:var(--c-ink-3);margin-bottom:12px">路标上所有产品框的默认外观；单产品可在产品弹窗内单独覆盖。</div>' +
      '<div style="display:flex;flex-direction:column;gap:12px">' +
      '<label style="display:flex;align-items:center;gap:10px;font-size:13px">填充色 <input type="color" id="bsFill" value="' + (/^#[0-9a-fA-F]{6}$/.test(bs.fill) ? bs.fill : '#FFFFFF') + '" style="width:44px;height:28px;border:1px solid var(--c-line);border-radius:6px;padding:0"></label>' +
      '<label style="display:flex;align-items:center;gap:10px;font-size:13px">透明度 <input type="range" id="bsOpacity" min="0" max="1" step="0.05" value="' + (bs.opacity == null ? 1 : bs.opacity) + '" style="flex:1"><span id="bsOpacityV" style="width:34px;text-align:right;color:var(--c-ink-3)">' + (bs.opacity == null ? 1 : bs.opacity) + '</span></label>' +
      '<label style="display:flex;align-items:center;gap:10px;font-size:13px"><input type="checkbox" id="bsBold"' + (bs.bold ? ' checked' : '') + '> 文字加粗</label>' +
      '<label style="display:flex;align-items:center;gap:10px;font-size:13px">字号(px) <input type="number" id="bsFont" min="8" max="28" value="' + (bs.fontSize == null ? 12 : bs.fontSize) + '" style="width:70px;border:1px solid var(--c-line);border-radius:6px;padding:4px 6px"></label>' +
      '</div>' +
      '<div style="margin-top:16px;display:flex;gap:8px;justify-content:space-between;align-items:center">' +
      '<button class="btn" id="bsReset" style="padding:5px 10px">恢复默认</button>' +
      '<button class="btn primary" id="bsDone" style="padding:5px 14px">完成</button></div></div>';
    document.body.appendChild(ov);
    const apply = () => { saveBoxStyle(); renderChart(); };
    ov.querySelector('#bsFill').addEventListener('input', (e) => { bs.fill = e.target.value; apply(); });
    ov.querySelector('#bsOpacity').addEventListener('input', (e) => { bs.opacity = +e.target.value; ov.querySelector('#bsOpacityV').textContent = e.target.value; apply(); });
    ov.querySelector('#bsBold').addEventListener('change', (e) => { bs.bold = e.target.checked; apply(); });
    ov.querySelector('#bsFont').addEventListener('input', (e) => { const n = parseInt(e.target.value, 10); bs.fontSize = isNaN(n) ? 12 : n; apply(); });
    ov.querySelector('#bsReset').addEventListener('click', () => { state.boxStyle = { fill: '#FFFFFF', opacity: 1, bold: true, fontSize: 12 }; saveBoxStyle(); ov.remove(); renderChart(); openBoxStyleEditor(); });
    ov.querySelector('#bsDone').addEventListener('click', () => { ov.remove(); });
  }

  function renderList() {
    const wrap = el('rmListWrap'); if (!wrap) return;
    el('rmInfo').textContent = '库内 ' + state.products.length + ' 个产品';
    if (!state.products.length) { wrap.innerHTML = '<div class="kpi-card" style="text-align:center;color:var(--c-ink-3);padding:30px">还没有产品，点「＋产品」添加。</div>'; return; }
    let h = '<div class="card" style="overflow:auto"><table class="data" style="width:100%;font-size:12px"><tr>' +
      ['传播名', '系列', '颜色', '配置', '最晚发货', '综合RRP-USD', '首4月SO', ''].map(t => '<th style="text-align:left;padding:6px 10px">' + t + '</th>').join('') + '</tr>';
    state.products.forEach((p, i) => {
      const dots = (p.skus || []).slice(0, 6).map(s => '<span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:' + esc(s.color || '#ccc') + ';border:1px solid #ddd;margin-right:3px"></span>').join('');
      const cfg = [...new Set((p.skus || []).map(s => [s.ram, s.rom].filter(Boolean).join('/')).filter(Boolean))].join(' ');
      h += '<tr data-edit="' + i + '" style="cursor:pointer;border-top:1px solid var(--c-line-soft)">' +
        '<td style="padding:6px 10px">' + esc(p.name) + '</td><td style="padding:6px 10px">' + esc(p.seriesGroup) + '</td>' +
        '<td style="padding:6px 10px">' + dots + '</td><td style="padding:6px 10px">' + esc(cfg) + '</td>' +
        '<td style="padding:6px 10px">' + esc(p.shipLate) + '</td><td style="padding:6px 10px">' + (p.compositeRrpUsd == null ? '—' : p.compositeRrpUsd) + '</td>' +
        '<td style="padding:6px 10px">' + (p.first4moSO == null ? '—' : p.first4moSO) + '</td>' +
        '<td style="padding:6px 10px"><button class="btn" data-del="' + i + '" style="padding:3px 8px">✕</button></td></tr>';
    });
    h += '</table></div>';
    wrap.innerHTML = h;
    wrap.querySelectorAll('tr[data-edit]').forEach(tr => tr.addEventListener('click', (e) => { if (e.target.closest('button[data-del]')) return; openDialog(state.products[+tr.dataset.edit]); }));
    wrap.querySelectorAll('button[data-del]').forEach(b => b.addEventListener('click', () => { const _del = state.products.splice(+b.dataset.del, 1)[0]; if (_del) { purgePredecessor(_del.id); purgeSamplesOfProduct(_del.id); } save(); renderList(); }));
  }

  function blankProduct() { return { id: C.newId(), name: '', internalCode: '', certModel: '', skus: [{ name: '', color: '#1E9E57', ean: '', ram: '', rom: '', chip: '', matte: false, bom: '' }], matteMode: 'none', packaging: [], accessories: {}, idImage: '', shipEarly: '', shipLate: '', pricing: [], pricingLink: '', compositeRrpUsd: null, seriesGroup: '', psiLink: '', first4moSO: null, predecessorId: '', category: '', sellingPoints: [{ cn: '', en: '' }, { cn: '', en: '' }, { cn: '', en: '' }, { cn: '', en: '' }, { cn: '', en: '' }, { cn: '', en: '' }], customInfo: '' }; }

  // 容错：导入/旧版/克隆记录可能缺数组或新字段，编辑前补齐避免抛错（openDialog 与 克隆 都用，避免分叉）
  function normalizeProduct(e2) {
    if (!e2) return;
    if (!Array.isArray(e2.skus) || !e2.skus.length) e2.skus = [{ name: '', color: '#1E9E57', ean: '', ram: '', rom: '', chip: '', matte: false }];
    // s.packaging：不是数组=继承产品级（旧档全部走这条，零迁移）；脏值（字符串/对象）清掉退回继承
    (e2.skus || []).forEach(s => { if (s.bom == null) s.bom = ''; if ('packaging' in s && !Array.isArray(s.packaging)) delete s.packaging; });
    if (!Array.isArray(e2.pricing)) e2.pricing = [];
    if (!Array.isArray(e2.packaging)) e2.packaging = [];
    if (!e2.accessories || typeof e2.accessories !== 'object') e2.accessories = {};
    if (!Array.isArray(e2.sellingPoints) || e2.sellingPoints.length !== 6) { const old = Array.isArray(e2.sellingPoints) ? e2.sellingPoints : []; e2.sellingPoints = [0, 1, 2, 3, 4, 5].map(i => ({ cn: (old[i] && old[i].cn) || '', en: (old[i] && old[i].en) || '' })); }
    if (typeof e2.customInfo !== 'string') e2.customInfo = '';
    if (typeof e2.category !== 'string') e2.category = '';
    if (!e2.matteMode) e2.matteMode = 'none';
  }

  /* ================= 弹框尺寸记忆（可拖拽调大小，跨启动记住） =================
     用户反馈：填写路标的弹框太小，每次都要左拉右拉。默认放大到接近整屏，
     并让卡片自身 resize:both；拖完把尺寸存 localStorage，下次打开照旧。 */
  const DLG_SIZE_LS = 'sb.rm.dlgSize';
  function dlgSize(key, defW, defH) {
    let o = {}; try { o = JSON.parse(localStorage.getItem(DLG_SIZE_LS) || '{}') || {}; } catch (err) {}
    const s = o[key] || {};
    // 兜底下限：某些环境（预览/无窗口尺寸）下 innerWidth 会是 0，不兜底弹框会塌成 0×0
    const w = (+s.w > 320) ? +s.w : Math.max(720, defW || 0);
    const h = (+s.h > 240) ? +s.h : Math.max(520, defH || 0);
    return { w: w, h: h };
  }
  function dlgSizeSave(key, w, h) {
    let o = {}; try { o = JSON.parse(localStorage.getItem(DLG_SIZE_LS) || '{}') || {}; } catch (err) {}
    o[key] = { w: Math.round(w), h: Math.round(h) };
    try { localStorage.setItem(DLG_SIZE_LS, JSON.stringify(o)); } catch (err) {}
  }
  // 卡片样式：可 resize（resize 生效要求 overflow 非 visible），最大不超出视口
  function dlgCardStyle(sz) {
    return 'width:' + sz.w + 'px;height:' + sz.h + 'px;max-width:98vw;max-height:94vh;min-width:420px;min-height:320px;'
      + 'resize:both;overflow:hidden;display:flex;flex-direction:column;padding:0;background:var(--c-bg-elev)';
  }
  // 拖拽结束后记住尺寸（用 ResizeObserver，防抖写盘）
  function bindDlgResize(key, card) {
    if (!card || typeof ResizeObserver === 'undefined') return;
    let t = null;
    const ro = new ResizeObserver(() => {
      if (t) clearTimeout(t);
      t = setTimeout(() => dlgSizeSave(key, card.offsetWidth, card.offsetHeight), 400);
    });
    ro.observe(card);
  }

  function openDialog(product) {
    rmTrace('open');
    state.editing = product ? JSON.parse(JSON.stringify(product)) : blankProduct();
    normalizeProduct(state.editing);
    state.editingIsNew = !product;
    const d = el('rmDialog'); d.style.display = 'block';
    // 默认尺寸大幅放大（原 760px 固定宽 → 接近整屏），且右下角可拖拽调整，尺寸记忆
    const sz = dlgSize('product', Math.min(1280, Math.round(window.innerWidth * 0.94)), Math.round(window.innerHeight * 0.88));
    d.innerHTML = '<div style="position:fixed;inset:0;background:rgba(0,0,0,.35);z-index:50;display:flex;align-items:flex-start;justify-content:center;overflow:auto;padding:16px">' +
      '<div class="card" id="rmDlgCard" style="' + dlgCardStyle(sz) + '">' +
        '<h3 style="margin:0;padding:18px 20px 12px;flex:none">' + (product ? '编辑产品' : '加产品') +
          '<span style="font-size:11px;font-weight:400;color:var(--c-ink-3);margin-left:10px">右下角可拖拽调整大小（自动记住）</span></h3>' +
        // 必填校验提示条：常驻弹框内(不随内容滚动)，取代原来的阻塞式 alert()——
        // 原生模态关掉后渲染视图可能拿不回键盘焦点，导致"提示完就没法再填字段"。
        '<div id="rmErrBar" style="display:none;flex:none;margin:0 20px 8px;padding:8px 12px;border-radius:8px;' +
          'background:var(--c-brand-soft);border:1px solid var(--c-brand-line);color:var(--c-brand);font-size:12.5px;line-height:1.7"></div>' +
        '<div id="rmForm" style="flex:1;overflow:auto;padding:0 20px 4px"></div>' +
        '<div style="flex:none;padding:14px 20px;border-top:1px solid var(--c-line);display:flex;gap:10px;align-items:center;background:var(--c-bg-elev)">' +
          (product ? '<button class="btn" id="rmDelete" style="border-color:var(--c-brand);color:var(--c-brand)">删除此产品</button>' : '') +
          '<span style="flex:1"></span>' +
          '<button class="btn" id="rmCancel">取消</button><button class="btn primary" id="rmSave">保存</button></div>' +
      '</div></div>';
    el('rmCancel').addEventListener('click', closeDialog);
    el('rmSave').addEventListener('click', saveDialog);
    bindDlgResize('product', el('rmDlgCard'));
    if (el('rmDelete')) el('rmDelete').addEventListener('click', () => {
      const e = state.editing; if (!confirm('确定删除产品「' + (e.name || '') + '」？此操作不可撤销。')) return;
      const idx = state.products.findIndex(p => p.id === e.id);
      if (idx >= 0) state.products.splice(idx, 1);
      purgePredecessor(e.id);
      purgeSamplesOfProduct(e.id);
      save(); closeDialog(); renderMain();
    });
    try { renderForm(); } catch (err) { console.error(err); alert('表单渲染出错：' + (err && err.message || err) + '\n（保存按钮仍可用）'); }
    rmTrace('open-done');
  }
  function closeDialog() { const d = el('rmDialog'); d.style.display = 'none'; d.innerHTML = ''; state.editing = null; }

  function validateSample(s) { const e = []; if (!s) return ['样机数据缺失']; if (!s.productId) e.push('关联产品'); if (!s.type) e.push('类型'); if (!String(s.shipLate || '').trim()) e.push('可用时间'); return e; }
  function blankSample() { return { id: C.newId(), productId: '', type: 'VN1', name: '', code: '', color: '#E0A400', certModel: '', inbox: '', shipLate: '' }; }
  function openSampleDialog(sample) {
    if (!state.products.length) { alert('请先添加产品（样机需关联产品）'); return; }
    state.editingSample = sample ? JSON.parse(JSON.stringify(sample)) : blankSample();
    const e = state.editingSample; const d = el('rmDialog'); d.style.display = 'block';
    const prodOpts = state.products.map(p => '<option value="' + esc(p.id) + '"' + (e.productId === p.id ? ' selected' : '') + '>' + esc(p.name || p.id) + '</option>').join('');
    const szS = dlgSize('sample', Math.min(820, Math.round(window.innerWidth * 0.9)), Math.round(window.innerHeight * 0.8));
    d.innerHTML = '<div style="position:fixed;inset:0;background:rgba(0,0,0,.35);z-index:50;display:flex;align-items:flex-start;justify-content:center;overflow:auto;padding:16px">' +
      '<div class="card" id="rmSDlgCard" style="' + dlgCardStyle(szS) + '">' +
        '<h3 style="margin:0;padding:18px 20px 12px;flex:none">' + (sample ? '编辑样机' : '加样机') +
          '<span style="font-size:11px;font-weight:400;color:var(--c-ink-3);margin-left:10px">右下角可拖拽调整大小</span></h3>' +
        '<div id="rmSForm" style="flex:1;overflow:auto;padding:0 20px 4px"></div>' +
        '<div style="flex:none;padding:14px 20px;border-top:1px solid var(--c-line);display:flex;gap:10px;align-items:center;background:var(--c-bg-elev)">' +
          (sample ? '<button class="btn" id="rmSDelete" style="border-color:var(--c-brand);color:var(--c-brand)">删除此样机</button>' : '') +
          '<span style="flex:1"></span><button class="btn" id="rmSCancel">取消</button><button class="btn primary" id="rmSSave">保存</button></div>' +
      '</div></div>';
    const reqStar = ' <span style="color:var(--c-brand)">*</span>';
    el('rmSForm').innerHTML =
      fieldRow('关联产品' + reqStar, '<select id="smF_product" style="border:1px solid var(--c-line);border-radius:7px;padding:6px 9px;min-width:260px"><option value="">（选择产品）</option>' + prodOpts + '</select>') +
      fieldRow('类型' + reqStar, '<select id="smF_type" style="border:1px solid var(--c-line);border-radius:7px;padding:6px 9px"><option' + (e.type === 'VN1' ? ' selected' : '') + '>VN1</option><option' + (e.type === 'VN2' ? ' selected' : '') + '>VN2</option></select>') +
      fieldRow('传播名（默认=产品名+类型，可改）', inp('smF_name', e.name, 280)) +
      fieldRow('样机编码', inp('smF_code', e.code, 200)) +
      fieldRow('样机颜色', '<input type="color" id="smF_color" value="' + (/^#[0-9a-fA-F]{6}$/.test(e.color) ? e.color : '#E0A400') + '" style="width:42px;height:28px;border:1px solid var(--c-line);border-radius:6px;padding:0">') +
      fieldRow('认证型号', inp('smF_cert', e.certModel, 200)) +
      fieldRow('inbox内容', '<textarea id="smF_inbox" rows="2" style="width:100%;border:1px solid var(--c-line);border-radius:7px;padding:7px 9px;font:inherit;resize:vertical">' + esc(e.inbox) + '</textarea>') +
      fieldRow('可用时间' + reqStar, dateInput('smF_date', e.shipLate, true));
    bindDlgResize('sample', el('rmSDlgCard'));
    const setName = () => { if (!String(e.name || '').trim()) { const p = state.products.find(x => x.id === e.productId); if (p) { el('smF_name').value = p.name + ' ' + e.type; e.name = el('smF_name').value; } } };
    el('smF_product').addEventListener('change', () => { e.productId = el('smF_product').value; setName(); });
    el('smF_type').addEventListener('change', () => { e.type = el('smF_type').value; setName(); });
    el('smF_name').addEventListener('input', () => { e.name = el('smF_name').value; });
    el('smF_code').addEventListener('input', () => { e.code = el('smF_code').value; });
    el('smF_color').addEventListener('input', () => { e.color = el('smF_color').value; });
    el('smF_cert').addEventListener('input', () => { e.certModel = el('smF_cert').value; });
    el('smF_inbox').addEventListener('input', () => { e.inbox = el('smF_inbox').value; });
    el('smF_date').addEventListener('change', () => { e.shipLate = dateRead('smF_date'); });
    el('rmSCancel').addEventListener('click', () => { d.style.display = 'none'; d.innerHTML = ''; state.editingSample = null; });
    el('rmSSave').addEventListener('click', () => {
      const errs = validateSample(e); if (errs.length) { alert('请填写：\n' + errs.join('、')); return; }
      const idx = state.samples.findIndex(x => x.id === e.id);
      if (idx >= 0) state.samples[idx] = e; else state.samples.push(e);
      saveSamples(); d.style.display = 'none'; d.innerHTML = ''; state.editingSample = null; renderMain();
    });
    if (el('rmSDelete')) el('rmSDelete').addEventListener('click', () => {
      if (!confirm('确定删除样机「' + (e.name || '') + '」？')) return;
      const idx = state.samples.findIndex(x => x.id === e.id); if (idx >= 0) state.samples.splice(idx, 1);
      saveSamples(); d.style.display = 'none'; d.innerHTML = ''; state.editingSample = null; renderMain();
    });
  }

  // Electron 不支持 window.prompt，用内嵌小弹层做单选（替代 prompt）
  function pickFromList(title, options, cb) {
    if (!options || !options.length) { alert('无可选项'); return; }
    const ov = document.createElement('div');
    ov.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.4);z-index:60;display:flex;align-items:center;justify-content:center';
    ov.innerHTML = '<div class="card" style="background:var(--c-bg-elev);padding:18px;min-width:380px;max-width:90vw">' +
      '<div style="font-weight:600;margin-bottom:10px">' + esc(title) + '</div>' +
      '<select id="rmPickSel" style="width:100%;border:1px solid var(--c-line);border-radius:7px;padding:7px 9px;font:inherit">' +
      options.map(o => '<option value="' + esc(o) + '">' + esc(o) + '</option>').join('') + '</select>' +
      '<div style="margin-top:14px;display:flex;gap:8px;justify-content:flex-end">' +
      '<button class="btn" id="rmPickCancel">取消</button><button class="btn primary" id="rmPickOk">确定</button></div></div>';
    document.body.appendChild(ov);
    ov.querySelector('#rmPickCancel').addEventListener('click', () => ov.remove());
    ov.querySelector('#rmPickOk').addEventListener('click', () => { const v = ov.querySelector('#rmPickSel').value; ov.remove(); cb(v); });
  }

  const RAM_OPTS = ['', '4GB', '6GB', '8GB', '12GB', '16GB', '24GB'];
  const ROM_OPTS = ['', '64GB', '128GB', '256GB', '512GB', '1TB', '2TB'];
  const inp = (id, val, w) => '<input id="' + id + '" value="' + esc(val) + '" style="border:1px solid var(--c-line);border-radius:7px;padding:6px 9px;width:' + (w || 200) + 'px">';
  const CATEGORIES = ['手机', '穿戴', '平板', '音频'];
  const reqStar = ' <span style="color:var(--c-brand)">*</span>';
  const bord = (v) => String(v == null ? '' : v).trim() ? '#E6E8EB' : '#C7000B';
  const inpReq = (id, val, w) => '<input id="' + id + '" value="' + esc(val) + '" style="border:1px solid ' + bord(val) + ';border-radius:7px;padding:6px 9px;width:' + (w || 200) + 'px">';
  const ddl = (id, opts, val) => '<select id="' + id + '" style="border:1px solid var(--c-line);border-radius:7px;padding:6px 8px">' + opts.map(o => '<option' + (o === val ? ' selected' : '') + '>' + esc(o) + '</option>').join('') + '</select>';
  function fieldRow(label, html) { return '<div style="margin-bottom:10px"><div style="font-size:12px;color:var(--c-ink-2);margin-bottom:3px">' + label + '</div>' + html + '</div>'; }
  // 发货时间改用原生 <input type="date">（Chromium 自带日历点选器：年/月/日、任意历史或未来日期、免打字）。
  // 存储统一 'YYYY/MM/DD'；旧数据 'YYYY/MM' 在控件里回填为当月01日显示，但【只在用户真正改动(change)时】
  // 才写回新格式——不动就保持原 'YYYY/MM'，避免开弹窗即静默改写旧值。样式与其它输入框一致（border/radius/padding照旧）。
  function toDateValue(val) {   // 存储值 → <input type=date> 的 value（'YYYY-MM-DD'）；兼容旧 'YYYY/MM'（补01日）
    const s = String(val == null ? '' : val).trim(); if (!s) return '';
    const m = s.match(/^(\d{4})[\/\-.](\d{1,2})(?:[\/\-.](\d{1,2}))?/); if (!m) return '';
    return m[1] + '-' + String(+m[2]).padStart(2, '0') + '-' + String(m[3] ? +m[3] : 1).padStart(2, '0');
  }
  function dateInput(id, val, req) {
    const dv = toDateValue(val);
    const bd = (req && !dv) ? '#C7000B' : '#E6E8EB';   // 必填未填→红框（与原 ymSelect/inpReq 一致）
    return '<input type="date" id="' + esc(id) + '" value="' + dv + '" style="border:1px solid ' + bd + ';border-radius:7px;padding:6px 9px;font:inherit">';
  }
  function dateRead(id) {   // <input type=date> 的 'YYYY-MM-DD' → 存储 'YYYY/MM/DD'（空/非法→''）
    const node = el(id); const v = (node && node.value || '').trim(); if (!v) return '';
    const m = v.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/); if (!m) return '';
    return m[1] + '/' + String(+m[2]).padStart(2, '0') + '/' + String(+m[3]).padStart(2, '0');
  }

  function renderForm() {
    rmTrace('form');
    const e = state.editing;
    let h = '';
    if (state.editingIsNew && state.products.length) {
      h += fieldRow('从已有产品复制（带出全部信息，改完另存为新产品）',
        '<select id="rmF_clone" style="border:1px solid var(--c-line);border-radius:7px;padding:6px 9px;min-width:280px"><option value="">（新建空白产品）</option>' +
        state.products.map((p, i) => '<option value="' + i + '">' + esc(p.name || ('产品' + (i + 1))) + '</option>').join('') + '</select>');
    }
    h += fieldRow('导入产品概述（.docx，解析规格→预览确认后才填入；EAN/BOM 不涉及）',
      '<button class="btn" id="rmImportDocx" style="padding:4px 12px">导入产品概述…</button>' +
      '<input type="file" id="rmImportDocxFile" accept=".docx" style="display:none">' +
      ' <span id="rmImportInfo" style="font-size:12px;color:var(--c-ink-3)">' +
      (e.specsMeta ? '已导入：' + esc(e.specsMeta.docTitle || '') + '（' + esc(e.specsMeta.certModel || '') + ' 视角' + (e.specsMeta.issue ? '，' + esc(e.specsMeta.issue) : '') + '）' : '') + '</span>');
    h += fieldRow('产品传播名' + reqStar, inpReq('rmF_name', e.name, 280));
    h += fieldRow('品类' + reqStar, '<select id="rmF_cat" style="border:1px solid ' + bord(e.category) + ';border-radius:7px;padding:6px 9px;min-width:160px"><option value="">（选择品类）</option>' +
      CATEGORIES.map(c => '<option' + (e.category === c ? ' selected' : '') + '>' + esc(c) + '</option>').join('') + '</select>');
    h += fieldRow('产品内部代号 (offering)', inp('rmF_code', e.internalCode, 280));
    h += fieldRow('产品准入认证型号', inp('rmF_cert', e.certModel, 280));
    const preOpts = state.products.filter(p => p.id !== e.id);
    h += fieldRow('前代产品（路标接续，可空）', '<select id="rmF_pre" style="border:1px solid var(--c-line);border-radius:7px;padding:6px 9px;min-width:280px"><option value="">（无）</option>' +
      preOpts.map(p => '<option value="' + esc(p.id) + '"' + (e.predecessorId === p.id ? ' selected' : '') + '>' + esc(p.name || p.id) + '</option>').join('') + '</select>');
    // 柔光屏总开关
    h += fieldRow('柔光屏', ['none', 'all', 'bySku'].map(m => '<label style="margin-right:14px;font-size:13px"><input type="radio" name="rmMatte" value="' + m + '"' + (e.matteMode === m ? ' checked' : '') + '> ' + ({ none: '否', all: '是', bySku: '按SKU' }[m]) + '</label>').join(''));
    // SKU 表
    h += '<div style="font-size:12px;color:var(--c-ink-2);margin:6px 0 3px">产品颜色 / SKU / 配置</div><div id="rmSkuBox"></div>';
    h += '<button class="btn" id="rmAddSku" style="margin-top:6px;padding:4px 10px">＋加SKU</button>';
    el('rmForm').innerHTML = h;
    if (el('rmF_clone')) el('rmF_clone').addEventListener('change', () => {
      const idx = el('rmF_clone').value; if (idx === '') return;
      const src = state.products[+idx]; if (!src) return;
      const c = JSON.parse(JSON.stringify(src)); c.id = C.newId();
      normalizeProduct(c);   // 关键：克隆旧产品也要补齐 sellingPoints/category/customInfo，否则 renderSellingPoints 抛错
      state.editing = c; renderForm();   // 带出全部信息(含配件/卖点)、新ID，改完保存即新增
    });
    el('rmImportDocx').addEventListener('click', () => el('rmImportDocxFile').click());
    el('rmImportDocxFile').addEventListener('change', (ev) => { const f = ev.target.files && ev.target.files[0]; ev.target.value = ''; if (f) importOverviewFile(f); });
    el('rmF_name').addEventListener('input', () => { e.name = el('rmF_name').value; });
    el('rmF_cat').addEventListener('change', () => { e.category = el('rmF_cat').value; });
    el('rmF_code').addEventListener('input', () => { e.internalCode = el('rmF_code').value; });
    el('rmF_cert').addEventListener('input', () => { e.certModel = el('rmF_cert').value; });
    el('rmF_pre').addEventListener('change', () => { e.predecessorId = el('rmF_pre').value; });
    el('rmForm').querySelectorAll('input[name="rmMatte"]').forEach(r => r.addEventListener('change', () => { e.matteMode = r.value; renderSkus(); }));
    el('rmAddSku').addEventListener('click', () => { e.skus.push({ name: '', color: '#1E9E57', ean: '', ram: '', rom: '', chip: '', matte: false, bom: '' }); renderSkus(); });
    renderSkus();
    renderExtra();
  }

  const PKG_OPTS = ['适配器', 'QSG', '电子QSG', '电子保卡', '保卡', 'Inbox键盘', 'Inbox皮套', 'Inbox手写笔'];
  const ACC_MAP = { 'Inbox键盘': '键盘', 'Inbox皮套': '皮套', 'Inbox手写笔': '手写笔' };
  const SERIES_PRESET = ['平板', '笔记本', '智能手表', '手环', '开放式耳机', '入耳式耳机', '头戴式耳机', '智慧屏', '手机', '路由器', '打印机', '键盘', '手写笔'];
  function renderExtra() {
    rmTrace('extra');
    const e = state.editing;
    const host = document.createElement('div'); host.id = 'rmExtra';
    const old = el('rmExtra'); if (old) old.remove();
    el('rmForm').appendChild(host);
    let h = '';
    // 包装清单
    h += '<div style="font-size:12px;color:var(--c-ink-2);margin:10px 0 3px">包装内清单（多选）'
      + '<span style="color:var(--c-ink-3);font-weight:400">　—　这是<b>所有 SKU 的默认值</b>；某个 SKU 不一样，在上面 SKU 表「包装」列单独设置</span></div><div>' +
      PKG_OPTS.map(o => '<label style="margin-right:14px;font-size:13px;white-space:nowrap"><input type="checkbox" class="rmPkg" value="' + esc(o) + '"' + ((e.packaging || []).includes(o) ? ' checked' : '') + '> ' + esc(o) + '</label>').join('') + '</div>';
    h += '<div id="rmAccBox"></div>';
    // ID 图
    h += fieldRow('产品ID图', '<input type="file" id="rmF_img" accept="image/*"> <span id="rmImgInfo" style="font-size:12px;color:var(--c-ink-3)">' + (e.idImage ? '已上传' : '') + '</span>');
    // 发货时间
    h += fieldRow('发货时间（点选日历 · 年月日 · 历史/未来任选）', '<span style="white-space:nowrap;color:var(--c-ink-2);font-size:12px">最早 </span>' + dateInput('rmF_early', e.shipEarly, false) + '<span style="white-space:nowrap;color:var(--c-ink-2);font-size:12px">　→　最晚' + reqStar + ' </span>' + dateInput('rmF_late', e.shipLate, true));
    // ---- 销售生命周期：销售结束时间(可空=仍在售) + EOM(非必填) + 自动 EOM+180 ----
    h += fieldRow('销售生命周期（上市时间取上面「最晚发货」；下面两项都非必填）',
      '<span style="white-space:nowrap;color:var(--c-ink-2);font-size:12px">销售结束 </span>' + dateInput('rmF_salesEnd', e.salesEnd, false)
      + '<span style="white-space:nowrap;color:var(--c-ink-3);font-size:11px">（空 = 仍在售 / 未定）</span>'
      + '<br><span style="white-space:nowrap;color:var(--c-ink-2);font-size:12px;display:inline-block;margin-top:6px">EOM 时间 </span>' + dateInput('rmF_eom', e.eom, false)
      + '<span id="rmEomPlus" class="g-badge" style="margin-left:8px;vertical-align:middle"></span>'
      + '<span style="color:var(--c-ink-3);font-size:11px;margin-left:6px">EOM 公告后才知道，可留空；填了自动算 +180 天（之后不能再投激励）</span>');
    // 系列归属
    h += fieldRow('产品系列归属' + reqStar, '<select id="rmF_series" style="border:1px solid ' + bord(e.seriesGroup) + ';border-radius:7px;padding:6px 9px;min-width:280px"><option value="">（选择系列；新系列先用右上＋产品系列创建）</option>' + (e.seriesGroup ? '<option selected>' + esc(e.seriesGroup) + '</option>' : '') + '</select>');
    host.innerHTML = h;
    host.querySelectorAll('input.rmPkg').forEach(c => c.addEventListener('change', () => {
      const v = c.value; e.packaging = e.packaging || [];
      if (c.checked) { if (!e.packaging.includes(v)) e.packaging.push(v); } else e.packaging = e.packaging.filter(x => x !== v);
      renderAcc(); renderSkus();   // 继承该默认值的 SKU「包装」列要跟着变
    }));
    el('rmF_early').addEventListener('change', () => { e.shipEarly = dateRead('rmF_early'); });
    el('rmF_late').addEventListener('change', () => { e.shipLate = dateRead('rmF_late'); });
    const syncEomPlus = () => { const box = el('rmEomPlus'); if (!box) return;
      const plus = C.eomPlus180(e.eom);
      box.textContent = plus ? ('EOM+180 = ' + plus) : 'EOM+180 = —';
      box.style.opacity = plus ? '1' : '.5'; };
    if (el('rmF_salesEnd')) el('rmF_salesEnd').addEventListener('change', () => { e.salesEnd = dateRead('rmF_salesEnd'); });
    if (el('rmF_eom')) el('rmF_eom').addEventListener('change', () => { e.eom = dateRead('rmF_eom'); syncEomPlus(); });
    syncEomPlus();
    el('rmF_series').addEventListener('change', () => { e.seriesGroup = el('rmF_series').value; });
    el('rmF_img').addEventListener('change', (ev) => { const f = ev.target.files && ev.target.files[0]; if (!f) return; const rd = new FileReader(); rd.onload = () => { e.idImage = rd.result; el('rmImgInfo').textContent = '已上传 ' + f.name; }; rd.readAsDataURL(f); });
    // PSI 系列 datalist（无 PSI 时静默）
    const fillSeries = (extra) => { rmTrace('fillSeries' + (extra ? ':' + extra.length : ':preset')); const sel = el('rmF_series'); if (!sel) return;
      const have = new Set([...sel.options].map(o => o.value || o.textContent));
      [...SERIES_PRESET, ...Object.keys(state.seriesColors || {}), ...state.products.map(p => p.seriesGroup), ...(extra || [])].filter(Boolean).forEach(s => { if (!have.has(s)) { const o = document.createElement('option'); o.textContent = s; sel.appendChild(o); have.add(s); } }); };
    fillSeries();
    if (api && api.options) { Promise.resolve(api.options('series', {})).then(list => { if (Array.isArray(list)) fillSeries(list); }).catch(() => {}); }
    renderAcc();
    renderPricing();
    renderSellingPoints();
    renderSpecsSection();
    renderBoxStyleOverride();
  }

  /* ================= 产品概述(.docx)导入 =================
     确定性解析(RoadmapImport)为主,残余行 LLM 兜底(仅 LLM 版有本地模型;标准版按钮置灰)。
     预览三栏(字段/当前值/提取值):绿=确定性 黄=LLM 灰=未提取;默认只勾「当前为空」的字段,
     已填字段要覆盖需手勾;确认才写进编辑对象(点表单「保存」才真正落库);EAN/BOM 不涉及。 */
  function importOverviewFile(file) {
    if (!(window.JSZip && window.RoadmapImport)) { alert('导入组件未加载(JSZip/RoadmapImport)'); return; }
    file.arrayBuffer()
      .then(buf => window.JSZip.loadAsync(buf))
      .then(zip => { const f = zip.file('word/document.xml'); if (!f) throw new Error('不是有效的 Word 文档(.docx)'); return f.async('string'); })
      .then(xml => {
        const parsed = window.RoadmapImport.parseOverview(xml);
        const certs = Object.keys(parsed.models || {});
        const cur = String(state.editing.certModel || '').trim().toUpperCase();
        if (!certs.length) { openImportPreview(parsed, cur); return; }            // 无 Models 表:按当前认证型号(或空)硬解析
        if (certs.length === 1) { openImportPreview(parsed, certs[0]); return; }
        if (certs.includes(cur)) { openImportPreview(parsed, cur); return; }       // 表单已填认证型号且文档里有 → 直接用
        pickFromList('本文档含多个认证型号,导入哪个型号的规格?', certs, c => { if (c) openImportPreview(parsed, c); });
      })
      .catch(err => alert('解析产品概述失败：' + ((err && err.message) || err)));
  }

  // 概述配件项 → 表单 Inbox 配件类型(仅键盘/手写笔/皮套参与自动落位,其余仅展示)
  function accTypeOf(item) {
    const s = String(item || '');
    if (/keyboard|键盘/i.test(s)) return '键盘';
    if (/stylus|pencil|pen\b|手写笔|触控笔/i.test(s)) return '手写笔';
    if (/case|cover|皮套|保护壳/i.test(s)) return '皮套';
    return null;
  }
  function openImportPreview(parsed, cert) {
    const RI = window.RoadmapImport;
    const e = state.editing;
    const ex = RI.extractForModel(parsed, cert);
    const curSpecs = (e.specs && typeof e.specs === 'object') ? e.specs : {};
    /* 行模型:{id, kind:'name'|'cert'|'spec'|'sp'|'acc', key?, label, cur, val, src:'det'|'llm', po?, checked} */
    const rows = []; let rid = 0;
    const push = (r) => { r.id = 'ir' + (rid++); rows.push(r); };
    if (ex.marketing) push({ kind: 'name', label: '产品传播名 ← 市场名', cur: e.name || '', val: ex.marketing, src: 'det', checked: !String(e.name || '').trim() });
    if (cert) push({ kind: 'cert', label: '认证型号', cur: e.certModel || '', val: cert, src: 'det', checked: !String(e.certModel || '').trim() });
    RI.SPEC_GROUPS.forEach(gp => {
      gp.keys.forEach(k => {
        const v = ex.specs[k]; if (v == null || v === '') return;
        push({ kind: 'spec', key: k, group: gp.name, label: RI.KEY_LABELS[k] || k, cur: curSpecs[k] || '', val: v, src: 'det',
          po: ex.perOffering[k] || null, checked: !String(curSpecs[k] || '').trim() });
      });
    });
    // 卖点候选:依次填入英文侧空位(中文留手填);无空位则默认不勾
    const spSlots = (e.sellingPoints || []).filter(o => !String((o && o.en) || '').trim() && !String((o && o.cn) || '').trim()).length;
    (ex.highlights || []).forEach((t, i) => push({ kind: 'sp', label: '卖点候选 ' + (i + 1), cur: '', val: t, src: 'det', checked: i < spSlots }));
    // 配件(标配且能映射到 Inbox 类型的,默认勾选未有项)
    (ex.accessories || []).forEach(a => {
      const t = accTypeOf(a.item); if (!t || !a.std) return;
      const has = (e.packaging || []).includes('Inbox' + t);
      const poTxt = Object.keys(a.perOff || {}).length ? '（标配 offering：' + Object.keys(a.perOff).join('、') + '）' : '';
      push({ kind: 'acc', key: t, label: '配件 · Inbox' + t, cur: has ? '已勾选' : '', val: a.item + ' 标配' + poTxt, src: 'det', checked: !has });
    });
    const offInfo = ex.model ? Object.values(ex.model.offerings).map(o => o.id + (o.inferred ? '(前缀推断)' : '')).join('、') : '—';

    const ov = document.createElement('div');
    ov.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:70;display:flex;align-items:flex-start;justify-content:center;overflow:auto;padding:24px';
    const badge = (src) => src === 'llm'
      ? '<span style="background:var(--c-warn-soft);color:var(--c-warn-text);border:1px solid var(--c-warn-line);border-radius:5px;font-size:10px;padding:0 5px;margin-left:6px">LLM</span>'
      : '<span style="background:#EAF7EF;color:var(--c-good);border:1px solid #BFE5CD;border-radius:5px;font-size:10px;padding:0 5px;margin-left:6px">确定性</span>';
    const rowHtml = (r) => {
      const poTxt = (r.kind === 'spec' && r.po) ? '<div style="font-size:11px;color:var(--c-warn-text);margin-top:2px">offering 明细：' +
        Object.entries(r.po).map(([o, v]) => o + '=' + esc(v || '标配')).join('　') + '</div>' : '';
      return '<tr data-ir="' + r.id + '" style="border-top:1px solid var(--c-line-soft);vertical-align:top">' +
        '<td style="padding:5px 6px"><input type="checkbox" data-irck="' + r.id + '"' + (r.checked ? ' checked' : '') + '></td>' +
        '<td style="padding:5px 6px;white-space:nowrap;color:var(--c-ink-2)">' + esc(r.label) + badge(r.src) + '</td>' +
        '<td style="padding:5px 6px;color:' + (String(r.cur).trim() ? '#1D2129' : '#C0C4CB') + ';max-width:180px;word-break:break-all">' + (String(r.cur).trim() ? esc(r.cur) : '（空）') + '</td>' +
        '<td style="padding:5px 6px;max-width:340px;word-break:break-all">' + esc(r.val) + poTxt + '</td></tr>';
    };
    const bodyHtml = () => {
      let h = '';
      const basics = rows.filter(r => r.kind === 'name' || r.kind === 'cert');
      const groups = [...new Set(rows.filter(r => r.kind === 'spec').map(r => r.group))];
      const section = (title, rs) => rs.length ? ('<tr><td colspan="4" style="padding:8px 6px 3px;font-weight:600;font-size:12px;color:var(--c-ink-3)">' + esc(title) + '</td></tr>' + rs.map(rowHtml).join('')) : '';
      h += section('基本信息', basics);
      groups.forEach(g => { h += section(g, rows.filter(r => r.kind === 'spec' && r.group === g)); });
      h += section('卖点候选（写入英文侧空位，中文手填）', rows.filter(r => r.kind === 'sp'));
      h += section('配件（标配 → 勾进包装清单+Inbox配件）', rows.filter(r => r.kind === 'acc'));
      return h;
    };
    const residual = ex.unrecognized.concat(ex.forkUnmatched.map(u => ({ label: u.label + '（分叉未匹配到 ' + cert + '）', value: u.value })));
    ov.innerHTML = '<div class="card" style="width:860px;max-width:96vw;max-height:92vh;display:flex;flex-direction:column;padding:0;background:var(--c-bg-elev)">' +
      '<div style="flex:none;padding:16px 20px 10px">' +
        '<h3 style="margin:0 0 4px">导入预览 — ' + esc(parsed.meta.docTitle || '产品概述') + '</h3>' +
        '<div style="font-size:12px;color:var(--c-ink-3)">视角：<b>' + esc(cert || '（未指定型号）') + '</b>　下属 offering：' + esc(offInfo) +
        (parsed.meta.issue ? '　' + esc(parsed.meta.issue) : '') + (parsed.meta.releaseDate ? '　' + esc(parsed.meta.releaseDate) : '') +
        '　<span style="color:var(--c-good)">绿=确定性</span> <span style="color:var(--c-warn-text)">黄=LLM</span>　默认只勾「当前为空」，覆盖已填值请手勾</div></div>' +
      '<div style="flex:1;overflow:auto;padding:0 20px">' +
        '<table style="border-collapse:collapse;font-size:12px;width:100%"><tr><th style="text-align:left;padding:4px 6px;width:30px"></th>' +
        '<th style="text-align:left;padding:4px 6px;color:var(--c-ink-3)">字段</th><th style="text-align:left;padding:4px 6px;color:var(--c-ink-3)">当前值</th>' +
        '<th style="text-align:left;padding:4px 6px;color:var(--c-ink-3)">提取值</th></tr><tbody id="rmImpBody">' + bodyHtml() + '</tbody></table>' +
        '<div id="rmImpResidual" style="margin:10px 0 6px">' + (residual.length ?
          ('<div style="font-size:12px;color:var(--c-brand);margin-bottom:4px">未识别 ' + residual.length + ' 行（不会静默丢弃）：</div>' +
           '<div style="font-size:11px;color:var(--c-ink-3);max-height:110px;overflow:auto;border:1px dashed var(--c-line);border-radius:7px;padding:6px 9px">' +
           residual.map(u => esc(u.label) + '：' + esc(u.value)).join('<br>') + '</div>' +
           '<button class="btn" id="rmImpLlm" style="margin-top:6px;padding:4px 12px">用本地模型补齐残余行</button>' +
           '<span id="rmImpLlmInfo" style="font-size:12px;color:var(--c-ink-3);margin-left:8px"></span>')
          : '<div style="font-size:12px;color:var(--c-good)">全部行已识别，无残余。</div>') + '</div></div>' +
      '<div style="flex:none;padding:12px 20px;border-top:1px solid var(--c-line);display:flex;gap:10px;align-items:center;background:var(--c-bg-elev)">' +
        '<button class="btn" id="rmImpAll" style="padding:4px 10px">全选</button><button class="btn" id="rmImpNone" style="padding:4px 10px">全不选</button>' +
        '<span style="flex:1"></span>' +
        '<button class="btn" id="rmImpCancel">取消</button><button class="btn primary" id="rmImpOk">确认导入勾选项</button></div></div>';
    document.body.appendChild(ov);
    const syncChecks = () => ov.querySelectorAll('input[data-irck]').forEach(c => { const r = rows.find(x => x.id === c.dataset.irck); if (r) r.checked = c.checked; });
    ov.querySelector('#rmImpAll').addEventListener('click', () => { ov.querySelectorAll('input[data-irck]').forEach(c => { c.checked = true; }); syncChecks(); });
    ov.querySelector('#rmImpNone').addEventListener('click', () => { ov.querySelectorAll('input[data-irck]').forEach(c => { c.checked = false; }); syncChecks(); });
    ov.querySelector('#rmImpCancel').addEventListener('click', () => ov.remove());
    // LLM 兜底:仅 LLM 版有本地模型;标准版置灰提示。结果标黄并入行列表(默认勾选空字段)。
    const llmBtn = ov.querySelector('#rmImpLlm');
    if (llmBtn) {
      let modelPath = ''; try { modelPath = (JSON.parse(localStorage.getItem('minimax.ai.cfg') || '{}').modelPath) || ''; } catch (err) {}
      const disable = (msg) => { llmBtn.disabled = true; llmBtn.style.opacity = '.5'; llmBtn.title = msg; ov.querySelector('#rmImpLlmInfo').textContent = msg; };
      if (!(api && api.aiChatLocal && api.aiLocalModelInfo)) disable('本地模型接口不可用');
      else api.aiLocalModelInfo(modelPath).then(r => { if (!(r && r.exists)) disable('未找到本地模型（标准版无内置模型，LLM 版可用；或在 AI 设置里指定 .gguf）'); }).catch(() => disable('本地模型检测失败'));
      llmBtn.addEventListener('click', () => {
        llmBtn.disabled = true; ov.querySelector('#rmImpLlmInfo').textContent = '本地模型解析中…';
        api.aiChatLocal({ id: 'rmimp' + Date.now(), modelPath: modelPath, system: '', messages: [{ role: 'user', content: window.RoadmapImport.llmPrompt(residual, cert) }], maxTokens: 700, temperature: 0 })
          .then(resp => {
            if (!resp || resp.error) throw new Error((resp && resp.error) || '无返回');
            const got = window.RoadmapImport.parseLlmJson(resp.content);
            if (!got || !Object.keys(got).length) { ov.querySelector('#rmImpLlmInfo').textContent = '模型未能抽取出字段'; llmBtn.disabled = false; return; }
            let added = 0;
            Object.entries(got).forEach(([k, v]) => {
              if (rows.some(r => r.kind === 'spec' && r.key === k)) return;   // 已有确定性结果的字段不让 LLM 顶
              const gp = window.RoadmapImport.SPEC_GROUPS.find(g => g.keys.includes(k));
              push({ kind: 'spec', key: k, group: gp ? gp.name : '其他', label: (window.RoadmapImport.KEY_LABELS[k] || k), cur: curSpecs[k] || '', val: v, src: 'llm', checked: !String(curSpecs[k] || '').trim() });
              added++;
            });
            ov.querySelector('#rmImpBody').innerHTML = bodyHtml();
            ov.querySelector('#rmImpLlmInfo').textContent = 'LLM 补齐 ' + added + ' 个字段（黄标，请核对）';
          })
          .catch(err2 => { ov.querySelector('#rmImpLlmInfo').textContent = 'LLM 解析失败：' + ((err2 && err2.message) || err2); llmBtn.disabled = false; });
      });
    }
    ov.querySelector('#rmImpOk').addEventListener('click', () => {
      syncChecks();
      const sel = rows.filter(r => r.checked);
      if (!sel.length) { alert('没有勾选任何项'); return; }
      sel.forEach(r => {
        if (r.kind === 'name') e.name = r.val;
        else if (r.kind === 'cert') e.certModel = r.val;
        else if (r.kind === 'spec') { e.specs = e.specs || {}; e.specs[r.key] = r.val; }
        else if (r.kind === 'sp') {
          const slot = (e.sellingPoints || []).find(o => !String((o && o.en) || '').trim() && !String((o && o.cn) || '').trim());
          if (slot) slot.en = r.val;
        } else if (r.kind === 'acc') {
          e.packaging = e.packaging || [];
          if (!e.packaging.includes('Inbox' + r.key)) e.packaging.push('Inbox' + r.key);
          e.accessories = e.accessories || {};
          if (!e.accessories[r.key]) e.accessories[r.key] = { certModel: '', name: '', internalCode: '', color: '', skuRefs: [] };
        }
      });
      e.specsMeta = { source: 'docx', docTitle: parsed.meta.docTitle || '', issue: parsed.meta.issue || '', releaseDate: parsed.meta.releaseDate || '',
        certModel: cert, importedAt: new Date().toISOString().slice(0, 10), perOffering: ex.perOffering || {} };
      ov.remove();
      renderForm();   // 重渲染:传播名/认证型号/包装/配件/卖点/规格区全部反映导入结果
    });
  }

  // 表单内「技术规格」区:有导入(或手工)specs 才显示;分组、可编辑、可整体移除。
  function renderSpecsSection() {
    const e = state.editing; const old = el('rmSpecsWrap'); if (old) old.remove();
    const specs = (e.specs && typeof e.specs === 'object') ? e.specs : null;
    const keys = specs ? Object.keys(specs).filter(k => specs[k] != null && specs[k] !== '') : [];
    if (!keys.length) return;
    const RI = window.RoadmapImport;
    const host = document.createElement('div'); host.id = 'rmSpecsWrap'; el('rmForm').appendChild(host);
    const meta = e.specsMeta;
    let h = '<div style="font-size:12px;color:var(--c-ink-2);margin:14px 0 4px;border-top:1px solid var(--c-line);padding-top:12px">技术规格（' + keys.length + ' 项' +
      (meta ? '，来自 ' + esc(meta.docTitle || 'docx') + ' · ' + esc(meta.certModel || '') + ' 视角 · ' + esc(meta.importedAt || '') : '') + '）' +
      ' <button class="btn" id="rmSpecsClear" style="padding:2px 8px;font-size:11px;margin-left:8px">移除全部规格</button></div>';
    const groups = RI ? RI.SPEC_GROUPS : [{ name: '规格', keys }];
    const labelOf = k => (RI && RI.KEY_LABELS[k]) || k;
    const covered = new Set();
    groups.forEach(gp => {
      const ks = gp.keys.filter(k => keys.includes(k)); if (!ks.length) return;
      ks.forEach(k => covered.add(k));
      h += '<div style="font-size:11px;color:var(--c-ink-3);margin:6px 0 2px">' + esc(gp.name) + '</div>';
      ks.forEach(k => {
        h += '<div style="display:flex;gap:8px;margin-bottom:3px;align-items:center"><span style="width:88px;flex:none;color:var(--c-ink-2);font-size:12px">' + esc(labelOf(k)) + '</span>' +
          '<input data-speck="' + esc(k) + '" value="' + esc(specs[k]) + '" style="flex:1;border:1px solid var(--c-line);border-radius:6px;padding:4px 8px;font-size:12px"></div>';
      });
    });
    const rest = keys.filter(k => !covered.has(k));
    if (rest.length) {
      h += '<div style="font-size:11px;color:var(--c-ink-3);margin:6px 0 2px">其他</div>';
      rest.forEach(k => { h += '<div style="display:flex;gap:8px;margin-bottom:3px;align-items:center"><span style="width:88px;flex:none;color:var(--c-ink-2);font-size:12px">' + esc(labelOf(k)) + '</span>' +
        '<input data-speck="' + esc(k) + '" value="' + esc(specs[k]) + '" style="flex:1;border:1px solid var(--c-line);border-radius:6px;padding:4px 8px;font-size:12px"></div>'; });
    }
    host.innerHTML = h;
    host.querySelectorAll('input[data-speck]').forEach(node => node.addEventListener('input', () => { e.specs[node.dataset.speck] = node.value; }));
    el('rmSpecsClear').addEventListener('click', () => {
      if (!confirm('移除本产品的全部技术规格(' + keys.length + ' 项)?不影响其他字段。')) return;
      delete e.specs; delete e.specsMeta; renderForm();
    });
  }
  // 产品级框样式覆盖（可选）：勾选=写 product.boxStyle（初值拷贝当前全局，观感不变）；不勾=删除→回退全局。
  function renderBoxStyleOverride() {
    const e = state.editing; const old = el('rmBoxStyleWrap'); if (old) old.remove();
    const host = document.createElement('div'); host.id = 'rmBoxStyleWrap'; el('rmForm').appendChild(host);
    const has = !!e.boxStyle;
    const cur = RoadmapChart.resolveBoxStyle(state.boxStyle, has ? e.boxStyle : null);
    let h = '<div style="font-size:12px;color:var(--c-ink-2);margin:14px 0 4px;border-top:1px solid var(--c-line);padding-top:12px">框样式（可选覆盖全局）</div>' +
      '<label style="font-size:13px;display:inline-flex;align-items:center;gap:6px;margin-bottom:8px"><input type="checkbox" id="rmBsOverride"' + (has ? ' checked' : '') + '> 为本产品单独设置框样式（不勾=用全局）</label>';
    if (has) {
      h += '<div style="display:flex;flex-wrap:wrap;gap:16px;align-items:center">' +
        '<label style="font-size:13px;display:inline-flex;align-items:center;gap:6px">填充 <input type="color" id="rmBsFill" value="' + (/^#[0-9a-fA-F]{6}$/.test(cur.fill) ? cur.fill : '#FFFFFF') + '" style="width:40px;height:26px;border:1px solid var(--c-line);border-radius:6px;padding:0"></label>' +
        '<label style="font-size:13px;display:inline-flex;align-items:center;gap:6px">透明 <input type="range" id="rmBsOpacity" min="0" max="1" step="0.05" value="' + cur.opacity + '"></label>' +
        '<label style="font-size:13px;display:inline-flex;align-items:center;gap:6px"><input type="checkbox" id="rmBsBold"' + (cur.bold ? ' checked' : '') + '> 加粗</label>' +
        '<label style="font-size:13px;display:inline-flex;align-items:center;gap:6px">字号 <input type="number" id="rmBsFont" min="8" max="28" value="' + cur.fontSize + '" style="width:64px;border:1px solid var(--c-line);border-radius:6px;padding:4px 6px"></label>' +
        '</div>';
    }
    host.innerHTML = h;
    el('rmBsOverride').addEventListener('change', () => {
      if (el('rmBsOverride').checked) e.boxStyle = RoadmapChart.resolveBoxStyle(state.boxStyle, null);
      else delete e.boxStyle;
      renderBoxStyleOverride();
    });
    if (has) {
      const upd = (k, v) => { e.boxStyle = e.boxStyle || {}; e.boxStyle[k] = v; };
      el('rmBsFill').addEventListener('input', (ev) => upd('fill', ev.target.value));
      el('rmBsOpacity').addEventListener('input', (ev) => upd('opacity', +ev.target.value));
      el('rmBsBold').addEventListener('change', (ev) => upd('bold', ev.target.checked));
      el('rmBsFont').addEventListener('input', (ev) => { const n = parseInt(ev.target.value, 10); upd('fontSize', isNaN(n) ? 12 : n); });
    }
  }

  const PRICE_COLS = [['country', '国家'], ['model', '型号'], ['rrpLocal', '本币'], ['fx', '汇率'], ['rrpUsd', 'USD'], ['reservedIncentive', '预留激励'], ['regularPrice', '常售价']];
  function renderPricing() {
    rmTrace('pricing');
    const e = state.editing;
    const host = document.createElement('div'); host.id = 'rmPriceWrap'; const old = el('rmPriceWrap'); if (old) old.remove(); el('rmForm').appendChild(host);
    let h = fieldRow('产品价格 · 综合RRP-USD（决定路标纵轴位置，直接填数字）' + reqStar, '<input id="rmF_comp" value="' + (e.compositeRrpUsd == null ? '' : e.compositeRrpUsd) + '" placeholder="例如 299" style="border:1px solid ' + bord(e.compositeRrpUsd) + ';border-radius:7px;padding:6px 9px;width:160px"> <button class="btn" id="rmCompAuto" style="padding:4px 8px">取各国USD最大值</button>') +
      '<div style="font-size:12px;color:var(--c-ink-2);margin:12px 0 3px">分国定价（可选，本币模式用；可手填或从定价库关联）</div>' +
      '<div style="margin-bottom:6px"><button class="btn" id="rmLinkPrice" style="padding:4px 10px">从定价库关联…</button> ' +
      '<button class="btn" id="rmAddPrice" style="padding:4px 10px">＋加一国</button> ' +
      '<span style="font-size:12px;color:var(--c-ink-3)" id="rmPriceLink">' + (e.pricingLink ? '已关联：' + esc(e.pricingLink) : '') + '</span></div>' +
      '<div id="rmPriceBox"></div>' +
      fieldRow('PSI 销量关联', '<button class="btn" id="rmLinkPsi" style="padding:4px 10px">关联PSI产品…</button> <span id="rmPsiInfo" style="font-size:12px;color:var(--c-ink-3)">' + (e.psiLink ? '已关联 ' + esc(e.psiLink) + '：首4月SO ' + (e.first4moSO == null ? '—' : e.first4moSO) : '') + '</span>');
    host.innerHTML = h;
    el('rmAddPrice').addEventListener('click', () => { e.pricing.push({ country: '', model: '', currency: '', rrpLocal: '', fx: '', rrpUsd: '', reservedIncentive: '', regularPrice: '' }); renderPriceRows(); });
    el('rmLinkPrice').addEventListener('click', linkPricing);
    el('rmLinkPsi').addEventListener('click', linkPsi);
    el('rmF_comp').addEventListener('input', () => { const n = parseFloat(el('rmF_comp').value); e.compositeRrpUsd = isNaN(n) ? null : n; });
    el('rmCompAuto').addEventListener('click', () => { const v = C.defaultCompositeRrp(e.pricing); e.compositeRrpUsd = v; el('rmF_comp').value = (v == null ? '' : v.toFixed(2)); });
    renderPriceRows();
  }
  function renderSellingPoints() {
    const e = state.editing; const old = el('rmSPWrap'); if (old) old.remove();
    if (!Array.isArray(e.sellingPoints)) e.sellingPoints = [];   // 防御：任何路径未补齐也不崩
    const host = document.createElement('div'); host.id = 'rmSPWrap'; el('rmForm').appendChild(host);
    let h = '<div style="font-size:12px;color:var(--c-ink-2);margin:12px 0 4px">产品六大卖点（中文 / 英文，一一对应）</div>';
    for (let i = 0; i < 6; i++) {
      const o = e.sellingPoints[i] || { cn: '', en: '' };
      h += '<div style="display:flex;gap:8px;margin-bottom:5px;align-items:center"><span style="width:18px;color:var(--c-ink-3);font-size:12px">' + (i + 1) + '</span>' +
        '<input data-sp="' + i + '" data-k="cn" value="' + esc(o.cn) + '" placeholder="中文卖点" style="flex:1;border:1px solid var(--c-line);border-radius:6px;padding:5px 8px">' +
        '<input data-sp="' + i + '" data-k="en" value="' + esc(o.en) + '" placeholder="English point" style="flex:1;border:1px solid var(--c-line);border-radius:6px;padding:5px 8px"></div>';
    }
    h += '<div style="font-size:12px;color:var(--c-ink-2);margin:12px 0 4px">自定义补充信息</div>' +
      '<textarea id="rmF_custom" rows="3" style="width:100%;border:1px solid var(--c-line);border-radius:7px;padding:7px 9px;font:inherit;resize:vertical" placeholder="其他要记录的产品信息…">' + esc(e.customInfo) + '</textarea>';
    host.innerHTML = h;
    host.querySelectorAll('input[data-sp]').forEach(node => node.addEventListener('input', () => { const i = +node.dataset.sp, k = node.dataset.k; e.sellingPoints[i] = e.sellingPoints[i] || { cn: '', en: '' }; e.sellingPoints[i][k] = node.value; }));
    el('rmF_custom').addEventListener('input', () => { e.customInfo = el('rmF_custom').value; });
  }
  function renderPriceRows() {
    const e = state.editing, box = el('rmPriceBox'); if (!box) return;
    if (!e.pricing.length) { box.innerHTML = '<div style="font-size:12px;color:var(--c-ink-3);padding:4px 0">暂无定价行</div>'; return; }
    let h = '<table style="border-collapse:collapse;font-size:12px"><tr>' + PRICE_COLS.map(c => '<th style="text-align:left;padding:2px 6px;color:var(--c-ink-3)">' + c[1] + '</th>').join('') + '<th></th></tr>';
    e.pricing.forEach((r, i) => {
      h += '<tr>' + PRICE_COLS.map(c => '<td style="padding:2px 4px"><input data-i="' + i + '" data-k="' + c[0] + '" value="' + esc(r[c[0]]) + '" style="width:' + (c[0] === 'country' ? 80 : 64) + 'px;border:1px solid var(--c-line);border-radius:6px;padding:3px 5px"></td>').join('') +
        '<td><button class="btn" data-delp="' + i + '" style="padding:2px 7px">✕</button></td></tr>';
    });
    h += '</table>';
    box.innerHTML = h;
    box.querySelectorAll('input[data-k]').forEach(node => node.addEventListener('input', () => {
      const i = +node.dataset.i, k = node.dataset.k; const numeric = ['rrpLocal', 'fx', 'rrpUsd', 'reservedIncentive'].includes(k);
      e.pricing[i][k] = numeric ? (node.value === '' ? '' : (parseFloat(node.value) || 0)) : node.value;
    }));
    box.querySelectorAll('button[data-delp]').forEach(b => b.addEventListener('click', () => { e.pricing.splice(+b.dataset.delp, 1); renderPriceRows(); }));
  }
  function libRecords() {   // 优先内存 PXLIB；未初始化时直接读 localStorage（避免必须先开过定价库视图）
    try { if (window.PXLIB && window.PXLIB.records && window.PXLIB.records.size) return [...window.PXLIB.records.values()]; } catch (e) {}
    try { const o = JSON.parse(localStorage.getItem('sb.pricing.lib.v1') || 'null'); if (o && Array.isArray(o.records)) return o.records; } catch (e) {}
    return [];
  }
  function libOfferings() { try { return [...new Set(libRecords().map(r => r.sku || r.offering).filter(Boolean))].sort(); } catch (e) { return []; } }
  function linkPricing() {
    const offs = libOfferings(); if (!offs.length) { alert('定价库为空，请先在「产品定价库」导入概算表，或手填定价行。'); return; }
    pickFromList('选择要关联的 offering / 型号', offs, (off) => {
      if (!off) return;
      const pl = C.pricingFromLibrary(libRecords(), off);
      if (!pl.rows.length) { alert('库里没有该型号的定价记录'); return; }
      const e = state.editing; e.pricing = pl.rows; e.pricingLink = off;
      if (!e.name) e.name = pl.name; if (!e.internalCode) e.internalCode = pl.internalCode; if (!e.seriesGroup) e.seriesGroup = pl.seriesGroup;
      renderForm();   // 重渲染以反映带出的 name/code/series + 定价
    });
  }
  function linkPsi() {
    if (!(api && api.options)) { alert('PSI 不可用'); return; }
    Promise.resolve(api.options('product', {})).then(list => {
      if (!list || !list.length) { alert('PSI 无产品数据（请先在 PSI 数据分析里加载数据）'); return; }
      pickFromList('选择要关联的 PSI 产品', list, (name) => {
        if (!name) return;
        const e = state.editing; e.psiLink = name;
        // stackDim 必传：engine.query 按堆叠维组织结果,缺省会在引擎内抛错(TypeError)→
        // promise 落 catch → 永远显示「取数失败,首4月SO —」。这就是首4月SO一直出不来的根因。
        Promise.resolve(api.query({ metric: 'sellOut', gran: 'month', stackDim: 'product', filters: { product: [name] } })).then(res => {
          const vals = extractMonthlyTotals(res); e.first4moSO = C.first4moSO(vals);
          el('rmPsiInfo').textContent = '已关联 ' + e.psiLink + '：首4月SO ' + (e.first4moSO == null ? '—' : e.first4moSO);
        }).catch(() => { el('rmPsiInfo').textContent = '已关联 ' + e.psiLink + '（取数失败，首4月SO —）'; });
      });
    }).catch(() => alert('PSI 取产品列表失败'));
  }
  // 从 api.query 结果里取每月合计序列。引擎实际返回 data:{系列名:{桶:值}}（对象形态，见 engine-psi.js），
  // 早期只按数组形态取值 data[k][i] 恒为 0 → first4moSO 恒 null，「首4月SO」永远算不出。
  // 现兼容两形态：对象按桶名取 data[k][bucket]，数组按下标取 data[k][i]（与 launch-ui extractWeeklyTotals 同）。
  function extractMonthlyTotals(res) {
    if (!res) return [];
    if (Array.isArray(res.totals)) return res.totals.map(v => +v || 0);
    const buckets = res.buckets || [];
    const data = res.data || {};
    const keys = Object.keys(data);
    return buckets.map((b, i) => { let s = 0; for (const k of keys) { const cell = data[k]; if (Array.isArray(cell)) s += (+cell[i] || 0); else if (cell && typeof cell === 'object') s += (+cell[b] || 0); } return s; });
  }

  function renderAcc() {
    rmTrace('acc');
    const e = state.editing, box = el('rmAccBox'); if (!box) return;
    // 并集：产品级默认 ∪ 各 SKU 单独设置——任一 SKU 勾了 Inbox 键盘，配件卡片就要出来
    const inbox = C.packagingUnion(e).filter(p => ACC_MAP[p]);
    if (!inbox.length) { box.innerHTML = ''; e.accessories = {}; return; }
    const skuNames = (e.skus || []).map(s => s.name).filter(Boolean);
    let h = '<div style="font-size:12px;color:var(--c-ink-2);margin:8px 0 3px">Inbox 配件信息</div>';
    inbox.forEach(p => {
      const t = ACC_MAP[p]; const a = (e.accessories && e.accessories[t]) || { certModel: '', name: '', internalCode: '', color: '', skuRefs: [] };
      const refs = C.accSkuList(a);   // 新数组优先,旧单值 skuRef 自动迁移读出
      h += '<div style="border:1px solid var(--c-line-soft);border-radius:8px;padding:8px;margin-bottom:6px"><b style="font-size:12px">' + esc(p) + '</b><br>' +
        '认证型号 <input data-t="' + t + '" data-k="certModel" value="' + esc(a.certModel) + '" style="width:90px;border:1px solid var(--c-line);border-radius:6px;padding:3px 6px;margin:3px 6px 0 0">' +
        '传播名 <input data-t="' + t + '" data-k="name" value="' + esc(a.name) + '" style="width:90px;border:1px solid var(--c-line);border-radius:6px;padding:3px 6px;margin:0 6px 0 0">' +
        '内部代号 <input data-t="' + t + '" data-k="internalCode" value="' + esc(a.internalCode) + '" style="width:90px;border:1px solid var(--c-line);border-radius:6px;padding:3px 6px;margin:0 6px 0 0">' +
        '颜色 <input type="color" data-t="' + t + '" data-k="color" value="' + (/^#[0-9a-fA-F]{6}$/.test(a.color) ? a.color : '#1E9E57') + '" style="width:40px;height:26px;border:1px solid var(--c-line);border-radius:6px;padding:0;vertical-align:middle;margin:0 6px 0 0">' +
        '<span style="margin-left:2px">关联SKU(可多选)</span> ' +
        (skuNames.length
          ? skuNames.map(n => '<label style="white-space:nowrap;margin-right:8px;font-size:12px"><input type="checkbox" data-t="' + t + '" data-sku="' + esc(n) + '"' + (refs.indexOf(n) >= 0 ? ' checked' : '') + ' style="vertical-align:middle"> ' + esc(n) + '</label>').join('')
          : '<span style="font-size:12px;color:var(--c-ink-3)">先在下方给SKU命名</span>') +
        '</div>';
    });
    box.innerHTML = h;
    // 文本/颜色字段(带 data-k):按键写单值。注意选择器必须限定 [data-k],否则会把复选框的 undefined 键写进对象。
    box.querySelectorAll('input[data-t][data-k],select[data-t][data-k]').forEach(node => node.addEventListener(node.tagName === 'SELECT' ? 'change' : 'input', () => {
      const t = node.dataset.t, k = node.dataset.k; e.accessories = e.accessories || {}; e.accessories[t] = e.accessories[t] || { certModel: '', name: '', internalCode: '', color: '', skuRefs: [] }; e.accessories[t][k] = node.value;
    }));
    // 关联SKU复选框:多选写 skuRefs 数组;skuRef 保留为「、」连接镜像,兼容仍读单值的旧消费方/旧版本回读
    box.querySelectorAll('input[type=checkbox][data-sku]').forEach(cb => cb.addEventListener('change', () => {
      const t = cb.dataset.t; e.accessories = e.accessories || {};
      const a = e.accessories[t] = e.accessories[t] || { certModel: '', name: '', internalCode: '', color: '', skuRefs: [] };
      const set = new Set(C.accSkuList(a));
      if (cb.checked) set.add(cb.dataset.sku); else set.delete(cb.dataset.sku);
      a.skuRefs = Array.from(set);
      a.skuRef = a.skuRefs.join('、');
    }));
  }

  function chipMenuDdl(i, val) {
    return '<input data-i="' + i + '" data-k="chip" list="rmChipList" value="' + esc(val) + '" placeholder="输入或选择" style="width:110px;border:1px solid var(--c-line);border-radius:6px;padding:4px 6px">';
  }
  function chipDatalist() { return '<datalist id="rmChipList">' + (state.menus.chipMenu || []).map(c => '<option value="' + esc(c) + '">').join('') + '</datalist>'; }
  /* ================= SKU 表：列宽可拖拽（类似单元格）+ 颜色记忆 =================
     ③ 每列表头右边缘可拖拽调宽，宽度按列 key 存 localStorage 跨启动记住；输入框 width:100% 跟着列走。
     ② 颜色格旁「🎨已用色」按钮：列出本产品/其它产品已用过的颜色，点一下精确复用那个 hex；
        用户仍去色板手点时，与已用色距离 ≤10（肉眼分不出）自动吸附回去，避免同色分裂成两色。 */
  const SKU_COLW_LS = 'sb.rm.skuColW';
  const SKU_COLS = [
    { k: 'name', t: 'SKU名', w: 150 }, { k: 'color', t: '颜色', w: 96 }, { k: 'ean', t: 'EAN', w: 160 },
    { k: 'ram', t: 'RAM', w: 92 }, { k: 'rom', t: 'ROM', w: 92 }, { k: 'chip', t: '芯片', w: 130 },
    { k: 'bom', t: 'BOM编码', w: 124 }, { k: 'priceUsd', t: '售价USD', w: 92 }, { k: 'inbox', t: 'inbox', w: 180 },
    { k: 'pkg', t: '包装', w: 150 }, { k: 'matte', t: '柔光屏', w: 64 }, { k: 'del', t: '', w: 46 },
  ];

  /* 逐 SKU 包装清单弹层：⦿继承产品级 / ○单独设置 + 8 个勾选项。
     「继承」= 删除 s.packaging（不是数组）；「单独设置」= 写 s.packaging 数组（可为空数组=什么都不随附）。 */
  function openSkuPkgPanel(anchor, i) {
    const old = document.getElementById('rmPkgPanel'); if (old) old.remove();
    const e = state.editing, s = e.skus[i];
    const own = C.skuPackagingOverridden(s);
    const eff = C.skuPackaging(e, s);
    const p = document.createElement('div'); p.id = 'rmPkgPanel';
    const r = anchor.getBoundingClientRect();
    p.style.cssText = 'position:fixed;top:' + Math.round(r.bottom + 4) + 'px;left:' + Math.round(Math.min(r.left, window.innerWidth - 320)) + 'px;z-index:80;'
      + 'background:var(--c-bg-elev);border:1px solid var(--c-line);border-radius:8px;box-shadow:0 10px 30px rgba(0,0,0,.16);padding:10px 12px;width:300px';
    p.innerHTML = '<div style="font-size:12px;font-weight:600;margin-bottom:6px">SKU「' + esc(s.name || '未命名') + '」的包装内清单</div>'
      + '<label style="display:block;font-size:12px;margin-bottom:3px"><input type="radio" name="rmPkgMode" value="inherit"' + (own ? '' : ' checked') + '> 继承产品级'
      + '<span style="color:var(--c-ink-3)">（' + (((e.packaging || []).join('/')) || '空') + '）</span></label>'
      + '<label style="display:block;font-size:12px;margin-bottom:6px"><input type="radio" name="rmPkgMode" value="own"' + (own ? ' checked' : '') + '> 单独设置</label>'
      + '<div id="rmPkgItems" style="border-top:1px solid var(--c-line-soft);padding-top:6px' + (own ? '' : ';opacity:.45;pointer-events:none') + '">'
      + PKG_OPTS.map(o => '<label style="display:inline-block;width:48%;font-size:12px;margin-bottom:3px"><input type="checkbox" class="rmSkuPkg" value="' + esc(o) + '"'
        + (eff.indexOf(o) >= 0 ? ' checked' : '') + '> ' + esc(o) + '</label>').join('') + '</div>'
      + '<div style="text-align:right;margin-top:8px"><button class="btn" id="rmPkgDone" style="padding:2px 12px;font-size:12px">完成</button></div>';
    document.body.appendChild(p);
    const rerender = () => { renderSkus(); renderAcc(); };
    p.querySelectorAll('input[name=rmPkgMode]').forEach(rd => rd.addEventListener('change', () => {
      if (rd.value === 'inherit') { delete s.packaging; } else { s.packaging = C.skuPackaging(e, s).slice(); }
      p.remove(); rerender(); const btn = document.querySelector('#rmSkuBox button[data-pkg="' + i + '"]'); if (btn) openSkuPkgPanel(btn, i);
    }));
    p.querySelectorAll('input.rmSkuPkg').forEach(c => c.addEventListener('change', () => {
      if (!Array.isArray(s.packaging)) s.packaging = [];
      const v = c.value;
      if (c.checked) { if (s.packaging.indexOf(v) < 0) s.packaging.push(v); } else s.packaging = s.packaging.filter(x => x !== v);
      rerender();
    }));
    el('rmPkgDone').addEventListener('click', () => p.remove());
    setTimeout(() => {
      const off = (ev) => { if (!p.contains(ev.target) && ev.target !== anchor) { p.remove(); document.removeEventListener('mousedown', off); } };
      document.addEventListener('mousedown', off);
    }, 0);
  }
  function skuColW() {
    let o = {}; try { o = JSON.parse(localStorage.getItem(SKU_COLW_LS) || '{}') || {}; } catch (err) {}
    const out = {}; SKU_COLS.forEach(c => { out[c.k] = (+o[c.k] >= 40) ? +o[c.k] : c.w; });
    return out;
  }
  function skuColWSave(k, w) {
    let o = {}; try { o = JSON.parse(localStorage.getItem(SKU_COLW_LS) || '{}') || {}; } catch (err) {}
    o[k] = Math.max(40, Math.round(w));
    try { localStorage.setItem(SKU_COLW_LS, JSON.stringify(o)); } catch (err) {}
  }
  const CELL_IN = 'width:100%;box-sizing:border-box;border:1px solid var(--c-line);border-radius:6px;padding:4px 6px';

  // 本产品 + 全部产品 + 样机里已经用过的颜色（内核 ColorMemory 负责去重/排序）
  function rmUsedColors() {
    const CMx = window.ColorMemory; if (!CMx) return [];
    return CMx.usedColors({ current: state.editing, products: state.products || [], samples: state.samples || [], limit: 24 });
  }
  // 已用色弹层：点色块 = 精确复用该 hex（不经色板，杜绝点歪）
  function openUsedColorPanel(anchor, i) {
    const old = document.getElementById('rmUsedPanel'); if (old) old.remove();
    const list = rmUsedColors();
    const p = document.createElement('div'); p.id = 'rmUsedPanel';
    const r = anchor.getBoundingClientRect();
    p.style.cssText = 'position:fixed;top:' + Math.round(r.bottom + 4) + 'px;left:' + Math.round(r.left) + 'px;z-index:80;'
      + 'background:var(--c-bg-elev);border:1px solid var(--c-line);border-radius:8px;box-shadow:0 10px 30px rgba(0,0,0,.16);padding:8px;max-width:280px';
    p.innerHTML = '<div style="font-size:11px;color:var(--c-ink-3);margin-bottom:6px">已用色 — 点一下精确复用（避免色板点歪导致色差）</div>'
      + (list.length
        ? '<div style="display:flex;flex-wrap:wrap;gap:5px">' + list.map(c =>
            '<button data-usec="' + esc(c.color) + '" title="' + esc(c.color + (c.label ? ' · ' + c.label : '')) + '" '
            + 'style="width:24px;height:24px;border-radius:5px;border:1px solid var(--c-line);cursor:pointer;padding:0;background:' + esc(c.color) + '"></button>').join('') + '</div>'
        : '<div style="font-size:12px;color:var(--c-ink-3)">还没有已用色</div>');
    document.body.appendChild(p);
    p.querySelectorAll('button[data-usec]').forEach(b => b.addEventListener('click', () => {
      state.editing.skus[i].color = b.dataset.usec; p.remove(); renderSkus();
    }));
    setTimeout(() => {
      const off = (ev) => { if (!p.contains(ev.target) && ev.target !== anchor) { p.remove(); document.removeEventListener('mousedown', off); } };
      document.addEventListener('mousedown', off);
    }, 0);
  }

  // SKU 行「包装」单元格：显示生效清单 + 继承/单独设置状态，点开逐 SKU 勾选
  function pkgCellHtml(i, s) {
    const e = state.editing;
    const own = C.skuPackagingOverridden(s), eff = C.skuPackaging(e, s);
    const txt = eff.length ? eff.join('/') : '（无）';
    return '<button class="btn" data-pkg="' + i + '" title="' + esc((own ? '单独设置：' : '继承产品级：') + txt) + '" '
      + 'style="width:100%;box-sizing:border-box;text-align:left;padding:4px 6px;font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap'
      + (own ? ';border-color:var(--c-brand);color:var(--c-brand)' : ';color:var(--c-ink-2)') + '">'
      + (own ? '● ' : '') + esc(txt.length > 16 ? txt.slice(0, 16) + '…' : txt) + '</button>';
  }
  function renderSkus() {
    rmTrace('skus');
    const e = state.editing, box = el('rmSkuBox'); if (!box) return;
    const inboxHint = (e.packaging || []).length ? ('继承：' + (e.packaging || []).join('/')) : '继承产品级';
    const W = skuColW();
    const showMatte = (e.matteMode === 'bySku');
    const cols = SKU_COLS.filter(c => c.k !== 'matte' || showMatte);
    const td = 'padding:2px 6px';
    let h = '<div style="font-size:11px;color:var(--c-ink-3);margin:0 0 3px">拖动表头分隔线可调列宽（自动记住）</div>'
      + '<table style="border-collapse:collapse;font-size:12px;table-layout:fixed">'
      + '<colgroup>' + cols.map(c => '<col style="width:' + W[c.k] + 'px">').join('') + '</colgroup><tr>'
      + cols.map(c => '<th data-col="' + c.k + '" style="position:relative;text-align:left;padding:3px 6px;color:var(--c-ink-3);font-weight:600;overflow:hidden">' + esc(c.t)
          + (c.k === 'del' ? '' : '<span data-grip="' + c.k + '" title="拖动调整列宽" style="position:absolute;top:0;right:0;width:6px;height:100%;cursor:col-resize;user-select:none"></span>')
          + '</th>').join('') + '</tr>';
    e.skus.forEach((s, i) => {
      const cur = esc(s.color || '#1E9E57');
      h += '<tr>' +
        '<td style="' + td + '"><input data-i="' + i + '" data-k="name" value="' + esc(s.name) + '" title="' + esc(s.name) + '" style="' + CELL_IN + '"></td>' +
        '<td style="' + td + '"><span style="display:flex;gap:3px;align-items:center">' +
          '<input type="color" data-i="' + i + '" data-k="color" value="' + cur + '" style="width:38px;height:28px;flex:none;border:1px solid var(--c-line);border-radius:6px;padding:0">' +
          '<button class="btn" data-usedc="' + i + '" title="从已用色里选（点一下精确复用，避免色板点歪产生色差）" style="padding:1px 5px;font-size:12px;line-height:18px;flex:none">🎨</button>' +
        '</span></td>' +
        '<td style="' + td + '"><input data-i="' + i + '" data-k="ean" value="' + esc(s.ean) + '" title="' + esc(s.ean) + '" style="' + CELL_IN + '"></td>' +
        '<td style="' + td + '">' + ddl('', RAM_OPTS, s.ram).replace('<select', '<select data-i="' + i + '" data-k="ram" style="width:100%"') + '</td>' +
        '<td style="' + td + '">' + ddl('', ROM_OPTS, s.rom).replace('<select', '<select data-i="' + i + '" data-k="rom" style="width:100%"') + '</td>' +
        '<td style="' + td + '">' + chipMenuDdl(i, s.chip).replace('style="width:110px;', 'style="width:100%;box-sizing:border-box;') + '</td>' +
        '<td style="' + td + '"><input data-i="' + i + '" data-k="bom" value="' + esc(s.bom || '') + '" title="' + esc(s.bom || '') + '" placeholder="8位编码" style="' + CELL_IN + '"></td>' +
        '<td style="' + td + '"><input data-i="' + i + '" data-k="priceUsd" value="' + esc(s.priceUsd == null ? '' : s.priceUsd) + '" placeholder="继承" title="本SKU售价USD；≥2个不同价时按价分框。空=不单独设" style="' + CELL_IN + '"></td>' +
        '<td style="' + td + '"><input data-i="' + i + '" data-k="inbox" value="' + esc(s.inbox == null ? '' : s.inbox) + '" title="' + esc(s.inbox == null ? '本SKU随附内容；空=继承产品级包装/配件' : s.inbox) + '" placeholder="' + esc(inboxHint) + '" style="' + CELL_IN + '"></td>' +
        '<td style="' + td + '">' + pkgCellHtml(i, s) + '</td>' +
        (showMatte ? '<td style="' + td + ';text-align:center"><input type="checkbox" data-i="' + i + '" data-k="matte"' + (s.matte ? ' checked' : '') + '></td>' : '') +
        '<td style="' + td + '"><button class="btn" data-delsku="' + i + '" style="padding:2px 7px">✕</button></td></tr>';
    });
    h += '</table>' + chipDatalist();
    // 同色分裂提示：肉眼同色但 hex 不同的 SKU，给一键归并
    const CMx = window.ColorMemory;
    if (CMx) {
      const groups = CMx.splitGroups((e.skus || []).map(s => s.color));
      if (groups.length) {
        h += '<div id="rmColorWarn" style="margin-top:6px;font-size:12px;color:var(--c-warn-text);background:var(--c-warn-soft);border:1px solid var(--c-warn-line);border-radius:7px;padding:6px 9px">'
          + '⚠ 检测到 ' + groups.length + ' 组「肉眼同色但色值不同」的 SKU（路标图上会显示成不同颜色）：'
          + groups.map(g => esc(g.keep) + '≈' + g.dups.map(esc).join('/')).join('；')
          + ' <button class="btn" id="rmColorMerge" style="padding:1px 8px;font-size:11px;margin-left:6px">一键归并</button></div>';
      }
    }
    box.innerHTML = h;

    // 列宽拖拽
    box.querySelectorAll('span[data-grip]').forEach(g => g.addEventListener('mousedown', ev => {
      ev.preventDefault(); ev.stopPropagation();
      const key = g.dataset.grip, th = g.closest('th'), startX = ev.clientX, startW = th.offsetWidth;
      const colIdx = cols.findIndex(c => c.k === key);
      const colEl = box.querySelectorAll('colgroup col')[colIdx];
      const mv = e2 => { const w = Math.max(40, startW + (e2.clientX - startX)); if (colEl) colEl.style.width = w + 'px'; };
      const up = () => {
        document.removeEventListener('mousemove', mv); document.removeEventListener('mouseup', up);
        if (colEl) skuColWSave(key, parseFloat(colEl.style.width) || startW);
      };
      document.addEventListener('mousemove', mv); document.addEventListener('mouseup', up);
    }));

    box.querySelectorAll('input[data-k],select[data-k]').forEach(node => {
      const i = +node.dataset.i, k = node.dataset.k;
      const handler = () => {
        const s = e.skus[i];
        if (k === 'matte') { s.matte = node.checked; return; }
        // 只有真改动才写 sku 级：清空即删除字段（回退继承 / 未设）
        if (k === 'priceUsd') { const v = node.value.trim(), n = parseFloat(v); if (v === '' || isNaN(n)) delete s.priceUsd; else s.priceUsd = n; return; }
        if (k === 'inbox') { if (node.value.trim() === '') delete s.inbox; else s.inbox = node.value; return; }
        s[k] = node.value;
        if (node.type !== 'color' && node.tagName !== 'SELECT') node.title = node.value;   // 列窄时靠 tooltip 看全值
      };
      node.addEventListener(node.type === 'checkbox' ? 'change' : (node.tagName === 'SELECT' ? 'change' : 'input'), handler);
      // 颜色：change（松手）时做近似吸附，input（拖动中）不打断用户
      if (k === 'color') node.addEventListener('change', () => {
        const CM2 = window.ColorMemory; if (!CM2) return;
        const others = rmUsedColors().map(c => c.color).filter(c => c !== CM2.normHex(e.skus[i].color));
        const r = CM2.snap(node.value, others);
        if (r.snapped) { e.skus[i].color = r.color; renderSkus(); }
      });
      if (k === 'chip') node.addEventListener('change', () => { const v = node.value.trim(); if (v) { state.menus.chipMenu = state.menus.chipMenu || []; if (!state.menus.chipMenu.includes(v)) { state.menus.chipMenu.push(v); saveMenus(); const dl = el('rmChipList'); if (dl) dl.innerHTML = state.menus.chipMenu.map(c => '<option value="' + esc(c) + '">').join(''); } } });
    });
    box.querySelectorAll('button[data-usedc]').forEach(b => b.addEventListener('click', ev => { ev.preventDefault(); openUsedColorPanel(b, +b.dataset.usedc); }));
    box.querySelectorAll('button[data-pkg]').forEach(b => b.addEventListener('click', ev => { ev.preventDefault(); openSkuPkgPanel(b, +b.dataset.pkg); }));
    const mg = el('rmColorMerge');
    if (mg) mg.addEventListener('click', () => {
      const groups = window.ColorMemory.splitGroups((e.skus || []).map(s => s.color));
      groups.forEach(g => e.skus.forEach(s => { if (g.dups.indexOf(window.ColorMemory.normHex(s.color)) >= 0) s.color = g.keep; }));
      renderSkus();
    });
    box.querySelectorAll('button[data-delsku]').forEach(b => b.addEventListener('click', () => { e.skus.splice(+b.dataset.delsku, 1); if (!e.skus.length) e.skus.push({ name: '', color: '#1E9E57', ean: '', ram: '', rom: '', chip: '', matte: false, bom: '' }); renderSkus(); }));
  }

  /* ---- 必填校验提示（页面内，不用 alert）----
     原因：原生 alert() 是阻塞模态，关掉后 Chromium 渲染视图可能拿不回键盘焦点，
     表现为"提示完再点字段就打不了字"（同一渲染进程里 window.prompt 也早就不可用）。
     改成弹框内提示条后，焦点全程不离开渲染视图；每一项还能点，直接跳到对应字段。 */
  const REQ_FIELD_ID = { '产品传播名': 'rmF_name', '品类': 'rmF_cat', '产品系列归属': 'rmF_series', '综合RRP-USD': 'rmF_comp', '最晚发货时间': 'rmF_late' };
  function hideReqErrors() { const b = el('rmErrBar'); if (b) { b.style.display = 'none'; b.innerHTML = ''; } }
  function focusField(id) {
    const f = el(id); if (!f) return;
    // 先 blur 再 focus：保证产生一次真实的焦点变化（否则 activeElement 没变，caret 不出现）
    try { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); } catch (err) {}
    setTimeout(() => { try { f.scrollIntoView({ block: 'center' }); f.focus(); } catch (err) {} }, 0);
  }
  function showReqErrors(errs) {
    const b = el('rmErrBar'); if (!b) return;
    b.innerHTML = '<b>还差这些必填项：</b>　'
      + errs.map(k => '<a href="javascript:void(0)" data-reqjump="' + esc(REQ_FIELD_ID[k] || '') + '" '
        + 'style="color:var(--c-brand);text-decoration:underline;margin-right:12px;cursor:pointer">' + esc(k) + '</a>').join('')
      + '<span style="color:var(--c-warn-text);margin-left:4px">（点上面任一项跳到该字段）</span>';
    b.style.display = '';
    b.querySelectorAll('a[data-reqjump]').forEach(a => a.addEventListener('click', () => focusField(a.dataset.reqjump)));
    focusField(REQ_FIELD_ID[errs[0]]);
  }

  // 生命周期校验提示：复用同一条非阻塞提示条（不弹原生 alert）
  function showLifeErrors(errs) {
    const b = el('rmErrBar'); if (!b) return;
    b.innerHTML = '<b>生命周期时间有冲突：</b>　' + errs.map(x => esc(x)).join('；')
      + ' <a href="javascript:void(0)" data-reqjump="rmF_eom" style="color:var(--c-brand);text-decoration:underline;margin-left:8px">去修改</a>';
    b.style.display = '';
    b.querySelectorAll('a[data-reqjump]').forEach(a2 => a2.addEventListener('click', () => focusField(a2.dataset.reqjump)));
    focusField('rmF_eom');
  }
  function saveDialog() {
    rmTrace('save');
    try {
      const errs = C.validateProduct(state.editing);
      if (errs.length) { showReqErrors(errs); return; }
      // 生命周期时间先后校验（非必填，只在填了才校验）
      const lifeErrs = C.validateLifecycle(state.editing);
      if (lifeErrs.length) { showLifeErrors(lifeErrs); return; }
      hideReqErrors();
      const e = state.editing; const idx = state.products.findIndex(p => p.id === e.id);
      if (idx >= 0) state.products[idx] = e; else state.products.push(e);
      if (!save()) { if (idx < 0) state.products.pop(); return; }   // 保存失败（已弹窗）则回滚内存、保留弹窗
      closeDialog(); renderMain();
    } catch (err) { console.error(err); alert('保存出错：' + (err && err.message || err)); }
  }

  function openSeriesEditor() {
    const renderBody = (ov) => {
      const names = [...new Set([...Object.keys(state.seriesColors || {}), ...state.products.map(p => p.seriesGroup).filter(Boolean)])];
      let h = '<div style="display:flex;align-items:center;margin-bottom:12px"><h3 style="margin:0">产品系列管理</h3><span style="flex:1"></span><button class="btn primary" id="rmSerNew" style="padding:5px 12px">＋新建系列</button></div>';
      if (!names.length) h += '<div style="color:var(--c-ink-3);padding:14px 0">还没有系列。点「＋新建系列」创建，并勾选已录入的产品归入。</div>';
      names.forEach(nm => {
        const sc = state.seriesColors[nm] || { color: '#1E9E57', opacity: 0.18, from: '', to: '' };
        const members = state.products.filter(p => p.seriesGroup === nm).length;
        h += '<div style="border:1px solid var(--c-line);border-radius:9px;padding:10px 12px;margin-bottom:10px">' +
          '<div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">' +
          '<b style="font-size:13px">' + esc(nm) + '</b>' +
          '<span style="color:var(--c-ink-3);font-size:12px">含 ' + members + ' 个产品</span>' +
          '<span style="flex:1"></span>' +
          '价格 <input data-ser="' + esc(nm) + '" data-k="from" value="' + esc(sc.from == null ? '' : sc.from) + '" placeholder="低" style="width:64px;border:1px solid var(--c-line);border-radius:6px;padding:4px 6px">~' +
          '<input data-ser="' + esc(nm) + '" data-k="to" value="' + esc(sc.to == null ? '' : sc.to) + '" placeholder="高" style="width:64px;border:1px solid var(--c-line);border-radius:6px;padding:4px 6px">' +
          '<input type="color" data-ser="' + esc(nm) + '" data-k="color" value="' + (/^#[0-9a-fA-F]{6}$/.test(sc.color) ? sc.color : '#1E9E57') + '" style="width:38px;height:26px;border:1px solid var(--c-line);border-radius:6px;padding:0">' +
          '透明 <input type="range" min="0" max="1" step="0.02" data-ser="' + esc(nm) + '" data-k="opacity" value="' + (sc.opacity == null ? 0.18 : sc.opacity) + '">' +
          '<button class="btn" data-serdel="' + esc(nm) + '" style="padding:3px 8px">删系列</button></div>' +
          '<div style="margin-top:8px;font-size:12px;color:var(--c-ink-2)">包含产品（勾选归入本系列）：</div>' +
          '<div style="display:flex;flex-wrap:wrap;gap:4px 14px;margin-top:4px">' +
          (state.products.length ? state.products.map((p, i) => '<label style="font-size:12px;white-space:nowrap"><input type="checkbox" data-member="' + i + '" data-ser="' + esc(nm) + '"' + (p.seriesGroup === nm ? ' checked' : '') + '> ' + esc(p.name || ('产品' + (i + 1))) + '</label>').join('') : '<span style="color:var(--c-ink-3);font-size:12px">（还没有产品）</span>') +
          '</div></div>';
      });
      const box = ov.querySelector('#rmSerBody'); box.innerHTML = h;
      box.querySelector('#rmSerNew').addEventListener('click', () => {
        const inp = ov.querySelector('#rmSerNewName'); const nm = (inp.value || '').trim(); if (!nm) { inp.focus(); return; }
        if (!state.seriesColors[nm]) { state.seriesColors[nm] = { color: '#1E9E57', opacity: 0.18, from: '', to: '' }; saveSeries(); }
        inp.value = ''; renderBody(ov);
      });
      box.querySelectorAll('input[data-ser]').forEach(node => node.addEventListener(node.type === 'range' || node.type === 'color' ? 'input' : 'change', () => {
        const nm = node.dataset.ser, k = node.dataset.k; state.seriesColors[nm] = state.seriesColors[nm] || { color: '#1E9E57', opacity: 0.18, from: '', to: '' };
        state.seriesColors[nm][k] = (k === 'opacity') ? +node.value : node.value; saveSeries();
      }));
      box.querySelectorAll('input[data-member]').forEach(node => node.addEventListener('change', () => {
        const i = +node.dataset.member, nm = node.dataset.ser;
        if (node.checked) state.products[i].seriesGroup = nm;
        else if (state.products[i].seriesGroup === nm) state.products[i].seriesGroup = '';
        save(); renderBody(ov);
      }));
      box.querySelectorAll('button[data-serdel]').forEach(b => b.addEventListener('click', () => { delete state.seriesColors[b.dataset.serdel]; saveSeries(); renderBody(ov); }));
    };
    const ov = document.createElement('div');
    ov.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.4);z-index:60;display:flex;align-items:flex-start;justify-content:center;overflow:auto;padding:30px';
    ov.innerHTML = '<div class="card" style="background:var(--c-bg-elev);padding:18px;width:680px;max-width:95vw">' +
      '<div id="rmSerBody"></div>' +
      '<div style="display:flex;gap:8px;align-items:center;margin-top:6px;border-top:1px solid var(--c-line);padding-top:12px">' +
      '<input id="rmSerNewName" placeholder="新系列名称（如：开放式耳机）" style="flex:1;border:1px solid var(--c-line);border-radius:7px;padding:7px 9px"><span style="font-size:11px;color:var(--c-ink-3)">名称填好点上方「＋新建系列」</span>' +
      '<button class="btn primary" id="rmSerDone">完成</button></div></div>';
    document.body.appendChild(ov);
    renderBody(ov);
    // [rmSerDiag] 临时诊断探针(2026-07-14「新建系列输入框无法输入」取证,定位后删):
    // 输入框全事件链+文档级捕获期按键,console.error 落 renderer.log。
    (function diag() {
      const inp = ov.querySelector('#rmSerNewName'); if (!inp) { console.error('[rmSerDiag] 输入框不存在!'); return; }
      ['focus', 'blur', 'keydown', 'keypress', 'beforeinput', 'input', 'compositionstart', 'compositionupdate', 'compositionend'].forEach(t =>
        inp.addEventListener(t, e => console.error('[rmSerDiag] inp:' + t, JSON.stringify({ key: e.key, data: e.data, prevented: e.defaultPrevented, val: inp.value, act: document.activeElement && (document.activeElement.id || document.activeElement.tagName) }))));
      const docKey = e => { if (ov.isConnected) console.error('[rmSerDiag] doc:keydown(capture)', JSON.stringify({ key: e.key, prevented: e.defaultPrevented, tgt: e.target && (e.target.id || e.target.tagName), act: document.activeElement && (document.activeElement.id || document.activeElement.tagName) })); else document.removeEventListener('keydown', docKey, true); };
      document.addEventListener('keydown', docKey, true);
      inp.addEventListener('click', () => console.error('[rmSerDiag] inp:click act=' + (document.activeElement && (document.activeElement.id || document.activeElement.tagName))));
      console.error('[rmSerDiag] 探针已装,弹层已开');
    })();
    // 加固:弹层一开输入框即聚焦(免依赖点击聚焦——用户报「点了打不进」,聚焦前置绕开点击环节)
    setTimeout(() => { const i = ov.querySelector('#rmSerNewName'); if (i) i.focus(); }, 30);
    ov.querySelector('#rmSerDone').addEventListener('click', () => { ov.remove(); if (state.view === 'chart') renderChart(); });
  }

  // 上市计划列定义：[字段, 表头, 输入类型, 宽度px]。字段名与 WK5/roadmapData 契约严格一致，勿改。
  const LAUNCH_COLS = [
    ['country', '国家', 'text', 80], ['presaleDate', '预售时间', 'text', 90], ['onlineDate', '线上首销', 'text', 90],
    ['offlineDate', '线下首销', 'text', 90], ['overallDate', '整体首销', 'text', 90], ['firstTarget', '首销名义台数', 'number', 90],
    ['lifecycleTarget', '生命周期目标', 'number', 90], ['aatpEst', 'AATP预计', 'text', 90], ['channel', '主力渠道', 'text', 90],
    ['firstGm', '首销毛利率', 'text', 80], ['firstOffer', '首销Offer', 'text', 110], ['note', '备注', 'text', 120],
  ];
  const BATTLE_COLS = [['country', '国家', 'text', 90], ['rival', '竞品', 'text', 140], ['priceLocal', '价格(本币)', 'number', 100]];
  function blankLaunch() { return { id: C.newId(), productId: '', country: '', presaleDate: '', onlineDate: '', offlineDate: '', overallDate: '', firstTarget: '', lifecycleTarget: '', aatpEst: '', channel: '', firstGm: '', firstOffer: '', note: '' }; }
  function blankBattle() { return { id: C.newId(), productId: '', country: '', rival: '', priceLocal: '' }; }
  function prodSelect(rowId, curId, tag) {   // 产品下拉，显示传播名
    return '<select data-row="' + esc(rowId) + '" data-tag="' + tag + '" data-k="productId" style="border:1px solid var(--c-line);border-radius:6px;padding:3px 5px;min-width:120px">' +
      '<option value="">（选产品）</option>' +
      state.products.map(p => '<option value="' + esc(p.id) + '"' + (curId === p.id ? ' selected' : '') + '>' + esc(p.name || p.id) + '</option>').join('') + '</select>';
  }
  function inputCell(rowId, tag, col, val) {
    const type = col[2] === 'number' ? 'number' : 'text';
    const v = (val == null ? '' : val);
    return '<input type="' + type + '" data-row="' + esc(rowId) + '" data-tag="' + tag + '" data-k="' + col[0] + '" value="' + esc(v) + '" style="width:' + col[3] + 'px;border:1px solid var(--c-line);border-radius:6px;padding:3px 5px">';
  }
  function renderInputs() {
    const host = el('rmInputs'); if (!host) return;
    const noProd = !state.products.length;
    let h = '<div style="margin-top:26px;border-top:1px solid var(--c-line);padding-top:16px">';
    // 上市计划
    h += '<div style="display:flex;align-items:center;gap:10px;margin-bottom:8px"><h3 style="margin:0">上市计划</h3>' +
      '<span style="flex:1"></span><button class="btn" id="rmLaunchAdd"' + (noProd ? ' disabled title="请先添加产品"' : '') + '>＋ 行</button></div>';
    h += '<div class="card" style="overflow:auto;padding:8px"><table style="border-collapse:collapse;font-size:12px"><tr>' +
      '<th style="text-align:left;padding:3px 6px;color:var(--c-ink-3)">产品</th>' +
      LAUNCH_COLS.map(c => '<th style="text-align:left;padding:3px 6px;color:var(--c-ink-3);white-space:nowrap">' + esc(c[1]) + '</th>').join('') + '<th></th></tr>';
    if (!state.launch.length) h += '<tr><td colspan="' + (LAUNCH_COLS.length + 2) + '" style="padding:6px;color:var(--c-ink-3)">暂无上市计划行，点右上「＋ 行」添加。</td></tr>';
    state.launch.forEach(l => {
      h += '<tr><td style="padding:2px 4px">' + prodSelect(l.id, l.productId, 'launch') + '</td>' +
        LAUNCH_COLS.map(c => '<td style="padding:2px 4px">' + inputCell(l.id, 'launch', c, l[c[0]]) + '</td>').join('') +
        '<td style="padding:2px 4px"><button class="btn" data-launchdel="' + esc(l.id) + '" style="padding:2px 7px">✕</button></td></tr>';
    });
    h += '</table></div>';
    // 竞品对标
    h += '<div style="display:flex;align-items:center;gap:10px;margin:22px 0 8px"><h3 style="margin:0">竞品对标</h3>' +
      '<span style="flex:1"></span><button class="btn" id="rmBattleAdd"' + (noProd ? ' disabled title="请先添加产品"' : '') + '>＋ 行</button></div>';
    h += '<div class="card" style="overflow:auto;padding:8px"><table style="border-collapse:collapse;font-size:12px"><tr>' +
      '<th style="text-align:left;padding:3px 6px;color:var(--c-ink-3)">产品</th>' +
      BATTLE_COLS.map(c => '<th style="text-align:left;padding:3px 6px;color:var(--c-ink-3);white-space:nowrap">' + esc(c[1]) + '</th>').join('') + '<th></th></tr>';
    if (!state.battle.length) h += '<tr><td colspan="' + (BATTLE_COLS.length + 2) + '" style="padding:6px;color:var(--c-ink-3)">暂无竞品对标行，点右上「＋ 行」添加。</td></tr>';
    state.battle.forEach(b => {
      h += '<tr><td style="padding:2px 4px">' + prodSelect(b.id, b.productId, 'battle') + '</td>' +
        BATTLE_COLS.map(c => '<td style="padding:2px 4px">' + inputCell(b.id, 'battle', c, b[c[0]]) + '</td>').join('') +
        '<td style="padding:2px 4px"><button class="btn" data-battledel="' + esc(b.id) + '" style="padding:2px 7px">✕</button></td></tr>';
    });
    h += '</table></div></div>';
    host.innerHTML = h;
    // 行内编辑：change 即存（数字列 number 存数值，空串保留为空）
    host.querySelectorAll('[data-tag]').forEach(node => {
      const tag = node.dataset.tag; const arr = state[tag]; if (!arr) return;
      node.addEventListener(node.tagName === 'SELECT' ? 'change' : 'input', () => {
        const row = arr.find(x => x.id === node.dataset.row); if (!row) return;
        const k = node.dataset.k;
        if (node.type === 'number') row[k] = node.value === '' ? '' : (parseFloat(node.value) || 0);
        else row[k] = node.value;
        (tag === 'launch' ? saveLaunch : saveBattle)();
      });
    });
    if (el('rmLaunchAdd')) el('rmLaunchAdd').addEventListener('click', () => { if (noProd) { alert('请先添加产品'); return; } state.launch.push(blankLaunch()); saveLaunch(); renderInputs(); });
    if (el('rmBattleAdd')) el('rmBattleAdd').addEventListener('click', () => { if (noProd) { alert('请先添加产品'); return; } state.battle.push(blankBattle()); saveBattle(); renderInputs(); });
    host.querySelectorAll('button[data-launchdel]').forEach(b => b.addEventListener('click', () => { const i = state.launch.findIndex(x => x.id === b.dataset.launchdel); if (i >= 0) state.launch.splice(i, 1); saveLaunch(); renderInputs(); }));
    host.querySelectorAll('button[data-battledel]').forEach(b => b.addEventListener('click', () => { const i = state.battle.findIndex(x => x.id === b.dataset.battledel); if (i >= 0) state.battle.splice(i, 1); saveBattle(); renderInputs(); }));
  }

  function exportXlsx() {
    if (!state.products.length) { alert('库内还没有产品'); return; }
    const sheets = C.exportAoa(state.products, state.samples, state.launch, state.battle);
    const wb = XLSX.utils.book_new();
    Object.keys(sheets).forEach(name => XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(sheets[name]), name));
    const b64 = XLSX.write(wb, { type: 'base64', bookType: 'xlsx' });
    api.saveFile('产品路标底表.xlsx', b64, 'xlsx');
  }
  function exportPpt() {
    const ps = chartProducts();
    if (!ps.length) { alert('暂无产品可导出'); return; }
    const isUsd = state.chart.mode === 'usd';
    const usedSeries = [...new Set(ps.map(p => p.seriesGroup).filter(Boolean))];
    const seriesRanges = isUsd ? usedSeries.map(s => state.seriesColors[s]).filter(Boolean).map(sc => ({ from: sc.from, to: sc.to })) : [];
    const bandColors = isUsd ? state.seriesColors : Object.keys(state.seriesColors).reduce((m, k) => { const v = state.seriesColors[k] || {}; m[k] = { color: v.color, opacity: v.opacity }; return m; }, {});
    const mf = parseFloat(state.chart.manualFrom), mt = parseFloat(state.chart.manualTo);
    const manual = (!isNaN(mf) && !isNaN(mt) && mf !== mt) ? { from: mf, to: mt } : null;
    const timeRange = (state.chart.timeFrom || state.chart.timeTo) ? { from: state.chart.timeFrom, to: state.chart.timeTo } : null;
    const geom = { W: 13.333, H: 7.5, padL: 1.0, padR: 0.5, padT: 1.0, padB: 0.7 };
    const L = RoadmapChart.pptxRoadmap(ps, { mode: state.chart.mode, country: state.chart.country, manualRange: manual, seriesRanges: seriesRanges, seriesColors: bandColors, timeRange: timeRange, boxStyle: state.boxStyle, samples: (state.chart.showSamples ? state.samples.filter(s => { const p = state.products.find(x => x.id === s.productId); return p && (!state.chart.category || p.category === state.chart.category); }) : []), sampleStyle: state.sampleStyle }, geom);
    const pptx = new PptxGenJS(); pptx.defineLayout({ name: 'W', width: 13.333, height: 7.5 }); pptx.layout = 'W';
    const s = pptx.addSlide();
    const title = '产品路标 · ' + (state.chart.category || '全部') + ' · ' + (isUsd ? 'USD' : (state.chart.country || '本币'));
    s.addText(title, { x: 0.3, y: 0.25, w: 12.7, h: 0.4, fontSize: 18, bold: true, color: '1A1A1A' });
    L.bands.forEach(b => {
      s.addShape('rect', { x: b.x, y: b.y, w: b.w, h: b.h, fill: { color: b.color, transparency: Math.round((1 - (+b.opacity || 0)) * 100) }, line: { type: 'none' } });
      s.addText(b.series || '', { x: b.x + b.w - 2, y: b.y + 0.02, w: 1.9, h: 0.22, align: 'right', fontSize: 9, color: '5A5F66' });
    });
    L.yTicks.forEach(t => s.addText(String(t.label), { x: 0.15, y: t.y - 0.12, w: 0.8, h: 0.24, fontSize: 8, color: '8A9099' }));
    s.addText(isUsd ? 'USD' : (state.chart.country || '本币'), { x: 0.15, y: geom.padT - 0.4, w: 0.8, h: 0.24, fontSize: 9, bold: true, color: '5A5F66' });
    L.lines.forEach(l => { const ln = { color: '888888', width: 1, dashType: 'dash' }; if (l.arrow) ln.endArrowType = 'triangle';   // 正交折线：仅整链末段带箭头
      s.addShape('line', { x: Math.min(l.x1, l.x2), y: Math.min(l.y1, l.y2), w: Math.abs(l.x2 - l.x1), h: Math.abs(l.y2 - l.y1), line: ln, flipH: l.x2 < l.x1, flipV: l.y2 < l.y1 }); });
    L.boxes.forEach(b => {
      const fill = b.sample ? { color: b.fill, transparency: Math.round((1 - (+b.opacity || 0)) * 100) } : { color: b.fillHex || 'FFFFFF', transparency: b.missing ? 55 : Math.round((1 - (b.opacity == null ? 1 : +b.opacity)) * 100) };
      s.addShape('roundRect', { x: b.x, y: b.y, w: b.w, h: b.h, rectRadius: 0.05, fill: fill, line: { color: 'D9D9D9', width: 1 } });
      s.addText([{ text: (b.name || '') + '\n', options: { bold: b.bold == null ? true : !!b.bold, fontSize: b.namePt || 9, color: '1A1A1A' } }, { text: b.meta || '', options: { fontSize: b.metaPt || 7, color: '8A9099' } }], { x: b.x + 0.04, y: b.y + 0.02, w: b.w - 0.08, h: b.h - 0.04, align: 'left', valign: 'middle' });
      (b.dots || []).slice(0, 6).forEach((c, i) => s.addShape('ellipse', { x: b.x + 0.06 + i * 0.13, y: b.y + b.h - 0.17, w: 0.09, h: 0.09, fill: { color: c }, line: { type: 'none' } }));
    });
    s.addText((L.xLabels.minD || '') + '  →  ' + (L.xLabels.maxD || '') + '  发货时间', { x: geom.padL, y: geom.H - 0.5, w: geom.W - geom.padL - geom.padR, h: 0.3, fontSize: 9, color: '8A9099' });
    pptx.write('base64').then(b64 => api.saveFile(ExportUtil.safe('产品路标_' + ExportUtil.ymd() + '.pptx'), b64, 'pptx')).catch(e => alert('导出失败：' + (e && e.message || e)));
  }
  function exportJson() {
    // 附带上市节奏数据（launches+nodeLib）。组件未加载时静默省略，保持向后兼容。
    let launch = null;
    try { if (window.RoadmapLaunchUI && window.RoadmapLaunchUI.getData) launch = window.RoadmapLaunchUI.getData(); } catch (e) {}
    const payload = { products: state.products, samples: state.samples, sampleStyle: state.sampleStyle, boxStyle: state.boxStyle };
    if (launch) { payload.launches = launch.launches; payload.nodeLib = launch.nodeLib; }
    const data = JSON.stringify(payload, null, 2);
    api.saveFile('产品路标库.json', btoa(unescape(encodeURIComponent(data))), 'json');
  }
  function onImportJson(ev) {
    const f = ev.target.files && ev.target.files[0]; if (!f) return; const rd = new FileReader();
    rd.onload = () => { try { const o = JSON.parse(rd.result); let add = 0, upd = 0, bad = 0; (o.products || []).forEach(p => { if (p && p.id && p.name != null) { const idx = state.products.findIndex(x => x.id === p.id); if (idx >= 0) { state.products[idx] = p; upd++; } else { state.products.push(p); add++; } } else bad++; }); save(); if (Array.isArray(o.samples)) { state.samples = o.samples; saveSamples(); } if (o.sampleStyle && typeof o.sampleStyle === 'object') { state.sampleStyle = { color: o.sampleStyle.color || '#E0A400', opacity: o.sampleStyle.opacity == null ? 0.85 : o.sampleStyle.opacity }; saveSampleStyle(); } if (o.boxStyle && typeof o.boxStyle === 'object') { state.boxStyle = normBoxStyle(o.boxStyle); saveBoxStyle(); } if ((Array.isArray(o.launches) || Array.isArray(o.nodeLib)) && window.RoadmapLaunchUI && window.RoadmapLaunchUI.setData) { try { window.RoadmapLaunchUI.setData({ launches: o.launches, nodeLib: o.nodeLib }); } catch (e) {} } renderMain(); el('rmInfo').textContent = 'JSON导入：新增 ' + add + ' · 更新 ' + upd + (bad ? ' · 跳过 ' + bad : ''); } catch (err) { alert('JSON解析失败'); } };
    rd.readAsText(f);
  }

  window.renderRoadmap = renderRoadmap;
  window.RM_API = { openDialog, renderList };
  // PPT 设计器消费：返回内存实时 state；未开过路标视图时惰性加载持久化数据后再返回
  window.roadmapData = () => { ensureLoaded(); return { products: state.products, samples: state.samples, launch: state.launch, battle: state.battle }; };
})();

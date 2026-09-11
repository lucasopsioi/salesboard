// 「上市节奏」第三视图控制器。依赖 window.RoadmapLaunch(纯函数层)、window.RM_STATE(读产品)、
// window.sb(api.saveFile)、全局 PptxGenJS、window.ExportUtil。渲染层无框架，拼 HTML 字符串。
(function () {
  const RL = (typeof window !== 'undefined' && window.RoadmapLaunch) ? window.RoadmapLaunch : null;
  const api = (typeof window !== 'undefined' && window.sb) ? window.sb : null;
  // XSS：所有用户输入进 HTML 必须过 esc()（与 roadmap-ui.js 保持一致的一份）
  const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const el = (id) => document.getElementById(id);
  const LKEY = 'sb.roadmap.launch.v1';
  const ACCENT = '#C7000B';
  const TEMPLATES = [['A', '简洁轴'], ['B', '密集轴'], ['C', '国家表'], ['D', 'MKT泳道'], ['E', '操盘曲线']];
  const DISP_STYLES = ['M.D', 'M月D日', 'YYYY/M/D'];

  // 运行期状态：store=持久化对象，sel=当前选中的 launch（按 productId+template 定位），root=挂载容器
  const S = { store: { launches: [], nodeLib: [] }, curProductId: '', curTemplate: 'A', root: null };

  // ---- 持久化 ------------------------------------------------------------
  function load() {
    let o = null;
    try { o = JSON.parse(localStorage.getItem(LKEY) || 'null'); } catch (e) {}
    S.store = (o && typeof o === 'object') ? o : {};
    if (!Array.isArray(S.store.launches)) S.store.launches = [];
    // 首次无词库时注入预置
    if (!Array.isArray(S.store.nodeLib) || !S.store.nodeLib.length) {
      S.store.nodeLib = RL ? RL.presetNodeLib() : [];
    }
  }
  function save() {
    try { localStorage.setItem(LKEY, JSON.stringify(S.store)); return true; }
    catch (e) {
      alert('保存失败：' + (e && e.name === 'QuotaExceededError' ? '本地存储空间不足，请先导出JSON备份或删减节点。' : (e && e.message || e)));
      return false;
    }
  }

  // ---- 产品 / launch 取用 -------------------------------------------------
  function products() { const st = (typeof window !== 'undefined' && window.RM_STATE); return (st && Array.isArray(st.products)) ? st.products : []; }
  function curProduct() { return products().find(p => p.id === S.curProductId) || null; }
  function blankLaunch(productId, template) {
    return {
      productId: productId, template: template || 'A', title: '', subtitle: '',
      accentColor: ACCENT, dispStyle: 'M.D',
      milestones: [], countryCols: ['presale', 'online', 'offline', 'target'], countryRows: [],
      phases: [], strategyBoxes: [], curve: null
    };
  }
  // E：懒建曲线数据（挂在 launch.curve）。系列名默认「产品名 推演」/「上代实际」，颜色红/灰
  function blankCurve() {
    return {
      startDate: '', gran: 'week',
      plan: { name: '', values: [], color: ACCENT },
      last: { name: '上代实际', psiProduct: '', values: [], color: '#888888' },
      bands: []
    };
  }
  // 取当前 launch 的 curve，缺失/字段不全时补齐（就地写回 launch.curve）
  function curCurve(l) {
    if (!l) return blankCurve();
    if (!l.curve || typeof l.curve !== 'object') l.curve = blankCurve();
    const c = l.curve;
    if (typeof c.startDate !== 'string') c.startDate = '';
    c.gran = 'week';
    if (!c.plan || typeof c.plan !== 'object') c.plan = { name: '', values: [], color: ACCENT };
    if (!c.last || typeof c.last !== 'object') c.last = { name: '上代实际', psiProduct: '', values: [], color: '#888888' };
    if (!Array.isArray(c.plan.values)) c.plan.values = [];
    if (!Array.isArray(c.last.values)) c.last.values = [];
    if (typeof c.plan.color !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(c.plan.color)) c.plan.color = ACCENT;
    if (typeof c.last.color !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(c.last.color)) c.last.color = '#888888';
    if (!Array.isArray(c.bands)) c.bands = [];
    return c;
  }
  // 当前 launch：按 productId+template 找；无则新建并入库（懒创建，切换时才落盘）
  function curLaunch(createIfMissing) {
    if (!S.curProductId) return null;
    let l = S.store.launches.find(x => x.productId === S.curProductId && x.template === S.curTemplate);
    if (!l && createIfMissing) { l = blankLaunch(S.curProductId, S.curTemplate); S.store.launches.push(l); }
    return l || null;
  }
  function newId() { return 'ml' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

  // ---- 顶层渲染入口 ------------------------------------------------------
  function render(mainEl) {
    S.root = mainEl;
    if (!RL) { mainEl.innerHTML = '<div style="padding:40px;text-align:center;color:var(--ink3)">上市节奏核心库未加载（RoadmapLaunch 缺失）。</div>'; return; }
    load();
    const ps = products();
    if (!S.curProductId && ps.length) S.curProductId = ps[0].id;
    ensureStyle();
    mainEl.innerHTML =
      '<div id="rlTop"></div>' +
      '<div style="display:flex;gap:14px;align-items:flex-start;margin-top:10px">' +
        '<div id="rlLib" style="flex:0 0 220px"></div>' +
        '<div style="flex:1;min-width:0"><div id="rlTable"></div><div id="rlEditor" style="margin-top:12px"></div><div id="rlPreview" style="margin-top:12px"></div></div>' +
      '</div>' +
      '<div id="rlDialog" style="display:none"></div>';
    renderTop(); renderLib(); renderTable(); renderEditor(); renderPreview();
  }

  function ensureStyle() {
    if (document.getElementById('rl-style')) return;
    const s = document.createElement('style'); s.id = 'rl-style';
    s.textContent =
      '.rl-chip{display:inline-block;border:1px solid var(--line);border-radius:20px;background:var(--c-bg-elev);font-size:12px;padding:3px 10px;margin:0 4px 5px 0;cursor:pointer;color:var(--ink2);transition:background .14s,border-color .14s}' +
      '.rl-chip:hover{background:var(--c-bg-sunken);border-color:var(--red);color:var(--ink)}' +
      '.rl-cat{font-size:11px;color:var(--ink3);font-weight:600;margin:8px 0 4px}' +
      '.rl-card{border:1px solid var(--line);border-radius:var(--radius);background:var(--c-bg-elev);box-shadow:var(--shadow);padding:14px}' +
      '.rl-tbl{width:100%;border-collapse:collapse;font-size:12px}' +
      '.rl-tbl th{text-align:left;padding:4px 6px;color:var(--c-ink-3);font-weight:600;border-bottom:1px solid var(--line)}' +
      '.rl-tbl td{padding:2px 4px;border-bottom:1px solid #F5F6F8}' +
      '.rl-tbl input{border:1px solid var(--c-line);border-radius:6px;padding:4px 6px;font:inherit}' +
      '.rl-in{border:1px solid var(--c-line);border-radius:7px;padding:6px 9px;font:inherit}' +
      '.rl-colchk{display:inline-flex;align-items:center;gap:4px;border:1px solid var(--line);border-radius:16px;background:var(--c-bg-elev);font-size:12px;padding:3px 10px;margin:0 6px 6px 0;cursor:pointer;color:var(--ink2);user-select:none}' +
      '.rl-colchk.on{background:var(--c-brand-soft);border-color:var(--red);color:var(--red)}' +
      '.rl-colchk input{margin:0}' +
      '.rl-mini{width:100%;border-collapse:collapse;font-size:12px}' +
      '.rl-mini th{text-align:center;padding:5px 6px;background:#F2F2F2;color:#333;font-weight:600;border:1px solid #D9D9D9}' +
      '.rl-mini td{padding:3px 5px;border:1px solid #D9D9D9;text-align:center}' +
      '.rl-mini td:first-child{text-align:left;font-weight:600}' +
      '.rl-ed-h{font-weight:600;font-size:13px;margin-bottom:8px}' +
      // Task5 交互样式：热区可拖、词库 chip 可拽、拖入时轴高亮、拖动小气泡
      '.rl-node .rl-hit{cursor:grab}' +
      '.rl-node.rl-dragging .rl-hit{cursor:grabbing}' +
      '.rl-chip{cursor:grab}' +
      '.rl-chip:active{cursor:grabbing}' +
      '#rlPreview .rl-drop-on{outline:2px dashed var(--red);outline-offset:3px;border-radius:6px}' +
      '.rl-tip{position:fixed;z-index:90;background:var(--c-ink-1);color:var(--c-bg-elev);font-size:12px;padding:3px 8px;border-radius:6px;pointer-events:none;white-space:nowrap;transform:translate(-50%,-140%)}' +
      '.rl-inline-edit{position:fixed;z-index:92;border:1px solid var(--red);border-radius:6px;padding:3px 6px;font:inherit;font-size:13px;box-shadow:var(--shadow-l)}';
    document.head.appendChild(s);
  }

  // ---- 顶栏 --------------------------------------------------------------
  function renderTop() {
    const host = el('rlTop'); if (!host) return;
    const ps = products();
    if (!ps.length) {
      host.innerHTML = '<div class="rl-card" style="color:var(--ink3)">还没有产品。请先切到「列表」视图点「＋产品」添加，再回到本视图为其配置上市节奏。</div>';
      return;
    }
    const l = curLaunch(true);
    const prodOpts = ps.map(p => '<option value="' + esc(p.id) + '"' + (p.id === S.curProductId ? ' selected' : '') + '>' + esc(p.name || p.id) + '</option>').join('');
    const segBtns = TEMPLATES.map(t => '<button data-tpl="' + t[0] + '" class="' + (S.curTemplate === t[0] ? 'on' : '') + '">' + t[0] + ' ' + esc(t[1]) + '</button>').join('');
    const dispOpts = DISP_STYLES.map(d => '<option' + (l.dispStyle === d ? ' selected' : '') + '>' + esc(d) + '</option>').join('');
    const accent = /^#[0-9a-fA-F]{6}$/.test(l.accentColor) ? l.accentColor : ACCENT;
    host.innerHTML = '<div class="rl-card">' +
      '<div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">' +
        '<span style="font-size:12px;color:var(--ink2)">产品</span>' +
        '<select id="rlProd" class="rl-in">' + prodOpts + '</select>' +
        '<span class="rm-seg" id="rlTplSeg">' + segBtns + '</span>' +
        '<span style="flex:1"></span>' +
        '<button class="btn primary" id="rlExport">导出PPT</button>' +
      '</div>' +
      '<div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-top:10px">' +
        '<input id="rlTitle" class="rl-in" placeholder="标题（空=<产品名> 上市节奏）" value="' + esc(l.title) + '" style="width:260px">' +
        '<input id="rlSub" class="rl-in" placeholder="副标题（可空）" value="' + esc(l.subtitle) + '" style="width:220px">' +
        '<span style="font-size:12px;color:var(--ink2)">日期格式</span>' +
        '<select id="rlDisp" class="rl-in">' + dispOpts + '</select>' +
        '<span style="font-size:12px;color:var(--ink2)">主色</span>' +
        '<input type="color" id="rlColor" value="' + accent + '" style="width:38px;height:28px;border:1px solid var(--line);border-radius:6px;padding:0;vertical-align:middle">' +
      '</div>' +
      '</div>';
    el('rlProd').addEventListener('change', () => { S.curProductId = el('rlProd').value; render(S.root); });
    el('rlTplSeg').querySelectorAll('button[data-tpl]').forEach(b => b.addEventListener('click', () => { S.curTemplate = b.dataset.tpl; render(S.root); }));
    el('rlExport').addEventListener('click', exportPpt);
    el('rlTitle').addEventListener('input', () => { const c = curLaunch(true); c.title = el('rlTitle').value; save(); renderPreview(); });
    el('rlSub').addEventListener('input', () => { const c = curLaunch(true); c.subtitle = el('rlSub').value; save(); });
    el('rlDisp').addEventListener('change', () => { const c = curLaunch(true); c.dispStyle = el('rlDisp').value; save(); renderTable(); renderPreview(); });
    el('rlColor').addEventListener('input', () => { const c = curLaunch(true); c.accentColor = el('rlColor').value; save(); renderPreview(); });
  }

  // ---- 左栏词库 ----------------------------------------------------------
  function renderLib() {
    const host = el('rlLib'); if (!host) return;
    if (!products().length) { host.innerHTML = ''; return; }
    // 按 cat 分组
    const byCat = {};
    (S.store.nodeLib || []).forEach(n => { const c = n.cat || '其他'; (byCat[c] = byCat[c] || []).push(n); });
    let h = '<div class="rl-card"><div style="font-weight:600;font-size:13px;margin-bottom:6px">节点词库</div>';
    Object.keys(byCat).forEach(cat => {
      h += '<div class="rl-cat">' + esc(cat) + '</div>';
      h += byCat[cat].map((n, i) => '<span class="rl-chip" draggable="true" data-cat="' + esc(cat) + '" data-lbl="' + esc(n.label) + '">' + esc(n.label) + '</span>').join('');
    });
    h += '<div style="margin-top:10px"><button class="btn" id="rlLibMng" style="padding:4px 10px">＋自定义节点</button></div></div>';
    host.innerHTML = h;
    host.querySelectorAll('.rl-chip').forEach(c => {
      c.addEventListener('click', () => openNodeDialog(c.dataset.lbl));
      // HTML5 拖拽：把词条名放进 dataTransfer，落到预览轴上 drop 时反解日期
      c.addEventListener('dragstart', (ev) => {
        try { ev.dataTransfer.setData('text/rl-chip', c.dataset.lbl || ''); ev.dataTransfer.setData('text/plain', c.dataset.lbl || ''); ev.dataTransfer.effectAllowed = 'copy'; } catch (e) {}
      });
    });
    el('rlLibMng').addEventListener('click', openLibManager);
  }

  // ---- 加节点弹层（点 chip 触发）：年/月/日三下拉 + 区间迄 + 显示文本 + 备注 -----
  const YEARS = (function () { const a = []; const cy = new Date().getFullYear(); for (let y = cy - 1; y <= cy + 5; y++) a.push(y); return a; })();
  function ySel(id, val) { return '<select id="' + id + '" class="rl-in"><option value="">年</option>' + YEARS.map(y => '<option' + (String(y) === String(val) ? ' selected' : '') + '>' + y + '</option>').join('') + '</select>'; }
  function mSel(id, val) { return '<select id="' + id + '" class="rl-in"><option value="">月</option>' + [1,2,3,4,5,6,7,8,9,10,11,12].map(n => '<option value="' + n + '"' + (String(n) === String(val) ? ' selected' : '') + '>' + n + '月</option>').join('') + '</select>'; }
  function dSel(id, val) { return '<select id="' + id + '" class="rl-in"><option value="">日(空=整月)</option>' + Array.from({length:31},(_,i)=>i+1).map(n => '<option value="' + n + '"' + (String(n) === String(val) ? ' selected' : '') + '>' + n + '日</option>').join('') + '</select>'; }
  // 从三下拉读回 'YYYY/M/D' 或 'YYYY/M'；缺年月→''
  function readDate(py, pm, pd) { const y = el(py).value, m = el(pm).value, d = pd ? el(pd).value : ''; if (!y || !m) return ''; return d ? (y + '/' + m + '/' + d) : (y + '/' + m); }
  // 'YYYY/M/D' | 'YYYY/M' → {y,m,d}（供弹层三下拉预填）；非法→空
  function splitDate(s) { const mt = String(s == null ? '' : s).match(/^(\d{4})\/(\d{1,2})(?:\/(\d{1,2}))?$/); return mt ? { y: mt[1], m: mt[2], d: mt[3] || '' } : { y: '', m: '', d: '' }; }

  // 加/编辑节点弹层。arg 可为字符串（=预填节点名，加新节点）或对象
  // { label, date, dateEnd, disp, note, editId }：editId 存在=编辑该 milestone；否则加新。
  function openNodeDialog(arg) {
    const o = (typeof arg === 'string') ? { label: arg } : (arg || {});
    const editId = o.editId || '';
    const d = el('rlDialog'); if (!d) return; d.style.display = 'block';
    const sd = splitDate(o.date), se = splitDate(o.dateEnd);
    d.innerHTML = '<div style="position:fixed;inset:0;background:rgba(0,0,0,.35);z-index:55;display:flex;align-items:flex-start;justify-content:center;overflow:auto;padding:40px">' +
      '<div class="card" style="width:480px;max-width:95vw;background:var(--c-bg-elev);padding:18px">' +
        '<h3 style="margin:0 0 12px">' + (editId ? '编辑节点' : '加节点') + '</h3>' +
        '<div style="margin-bottom:8px"><div style="font-size:12px;color:var(--c-ink-2);margin-bottom:3px">节点名</div><input id="rlNdLabel" class="rl-in" value="' + esc(o.label || '') + '" style="width:100%"></div>' +
        '<div style="margin-bottom:8px"><div style="font-size:12px;color:var(--c-ink-2);margin-bottom:3px">日期</div>' + ySel('rlNdY', sd.y) + ' ' + mSel('rlNdM', sd.m) + ' ' + dSel('rlNdD', sd.d) + '</div>' +
        '<div style="margin-bottom:8px"><div style="font-size:12px;color:var(--c-ink-2);margin-bottom:3px">区间迄（可空）</div>' + ySel('rlNdEY', se.y) + ' ' + mSel('rlNdEM', se.m) + ' ' + dSel('rlNdED', se.d) + '</div>' +
        '<div style="margin-bottom:8px"><div style="font-size:12px;color:var(--c-ink-2);margin-bottom:3px">显示文本覆盖（如 4月W2，可空）</div><input id="rlNdDisp" class="rl-in" value="' + esc(o.disp || '') + '" style="width:100%"></div>' +
        '<div style="margin-bottom:8px"><div style="font-size:12px;color:var(--c-ink-2);margin-bottom:3px">备注（可空）</div><input id="rlNdNote" class="rl-in" value="' + esc(o.note || '') + '" style="width:100%"></div>' +
        '<div style="display:flex;gap:8px;justify-content:flex-end;margin-top:14px"><button class="btn" id="rlNdCancel">取消</button><button class="btn primary" id="rlNdOk">' + (editId ? '保存' : '加入') + '</button></div>' +
      '</div></div>';
    const close = () => { d.style.display = 'none'; d.innerHTML = ''; document.removeEventListener('keydown', onKey); };
    // Esc 关闭 / Enter 确认（焦点在 textarea 时不拦，此弹层无 textarea）
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); close(); }
      else if (e.key === 'Enter') { e.preventDefault(); ok(); }
    };
    const ok = () => {
      const label = String(el('rlNdLabel').value || '').trim();
      const date = readDate('rlNdY', 'rlNdM', 'rlNdD');
      if (!label) { alert('请填节点名'); return; }
      if (!date) { alert('请选年和月'); return; }
      const c = curLaunch(true);
      const dateEnd = readDate('rlNdEY', 'rlNdEM', 'rlNdED');
      const disp = String(el('rlNdDisp').value || '').trim();
      const note = String(el('rlNdNote').value || '').trim();
      if (editId) {
        const m = (c.milestones || []).find(x => x.id === editId);
        if (m) { m.label = label; m.date = date; m.dateEnd = dateEnd; m.disp = disp; m.note = note; }
      } else {
        c.milestones.push({ id: newId(), label: label, date: date, dateEnd: dateEnd, disp: disp, note: note, color: '' });
      }
      if (!save()) return;
      close(); renderTable(); renderPreview();
    };
    el('rlNdCancel').addEventListener('click', close);
    el('rlNdOk').addEventListener('click', ok);
    document.addEventListener('keydown', onKey);
    const lf = el('rlNdLabel'); if (lf) lf.focus();
  }

  // ---- 词库管理弹层（增删改 / 归类，存 nodeLib） --------------------------
  function openLibManager() {
    const d = el('rlDialog'); if (!d) return; d.style.display = 'block';
    const renderBody = () => {
      const rows = (S.store.nodeLib || []).map((n, i) =>
        '<tr><td><input data-i="' + i + '" data-k="label" value="' + esc(n.label) + '" style="width:130px"></td>' +
        '<td><input data-i="' + i + '" data-k="cat" value="' + esc(n.cat) + '" style="width:110px"></td>' +
        '<td><button class="btn" data-del="' + i + '" style="padding:2px 7px">✕</button></td></tr>').join('');
      el('rlLibBody').innerHTML = '<table class="rl-tbl"><tr><th>节点名</th><th>分类</th><th></th></tr>' + rows + '</table>';
      el('rlLibBody').querySelectorAll('input[data-k]').forEach(node => node.addEventListener('input', () => {
        const i = +node.dataset.i, k = node.dataset.k; S.store.nodeLib[i][k] = node.value; save();
      }));
      el('rlLibBody').querySelectorAll('button[data-del]').forEach(b => b.addEventListener('click', () => { S.store.nodeLib.splice(+b.dataset.del, 1); save(); renderBody(); }));
    };
    d.innerHTML = '<div style="position:fixed;inset:0;background:rgba(0,0,0,.35);z-index:55;display:flex;align-items:flex-start;justify-content:center;overflow:auto;padding:40px">' +
      '<div class="card" style="width:560px;max-width:95vw;background:var(--c-bg-elev);padding:18px">' +
        '<div style="display:flex;align-items:center;margin-bottom:12px"><h3 style="margin:0">节点词库管理</h3><span style="flex:1"></span>' +
        '<button class="btn primary" id="rlLibAdd" style="padding:4px 10px">＋新增节点</button></div>' +
        '<div id="rlLibBody" style="max-height:50vh;overflow:auto"></div>' +
        '<div style="display:flex;justify-content:flex-end;margin-top:14px"><button class="btn" id="rlLibClose">完成</button></div>' +
      '</div></div>';
    renderBody();
    el('rlLibAdd').addEventListener('click', () => { S.store.nodeLib.push({ label: '新节点', cat: '自定义', color: '' }); save(); renderBody(); });
    el('rlLibClose').addEventListener('click', () => { d.style.display = 'none'; d.innerHTML = ''; renderLib(); });
  }

  // ---- 快速录入表 --------------------------------------------------------
  function renderTable() {
    const host = el('rlTable'); if (!host) return;
    if (!products().length) { host.innerHTML = ''; return; }
    const l = curLaunch(true);
    // 末行留空供录入；录完自动追加。渲染时在真实数据后补一条空占位行。
    const rows = (l.milestones || []).slice();
    const style = l.dispStyle || 'M.D';
    const dlOpts = (S.store.nodeLib || []).map(n => '<option value="' + esc(n.label) + '">').join('');
    let h = '<div class="rl-card"><div style="font-weight:600;font-size:13px;margin-bottom:8px">快速录入节点</div>' +
      '<table class="rl-tbl"><tr><th>节点名</th><th>日期(YYYY/M 或 YYYY/M/D)</th><th>区间迄(可空)</th><th>显示文本</th><th>备注</th><th></th></tr>';
    const rowHtml = (m, i) => {
      const auto = m ? (RL.fmtDisp(m.date, m.dateEnd, style) || '') : '';
      return '<tr data-row="' + i + '">' +
        '<td><input data-i="' + i + '" data-k="label" list="rlNodeDl" value="' + esc(m ? m.label : '') + '" placeholder="节点名" style="width:130px"></td>' +
        '<td><input data-i="' + i + '" data-k="date" value="' + esc(m ? m.date : '') + '" placeholder="2026/5 或 2026/5/3" style="width:150px"></td>' +
        '<td><input data-i="' + i + '" data-k="dateEnd" value="' + esc(m ? m.dateEnd : '') + '" placeholder="可空" style="width:120px"></td>' +
        '<td><input data-i="' + i + '" data-k="disp" value="' + esc(m ? m.disp : '') + '" placeholder="' + esc(auto || '自动') + '" style="width:100px"></td>' +
        '<td><input data-i="' + i + '" data-k="note" value="' + esc(m ? m.note : '') + '" placeholder="备注" style="width:110px"></td>' +
        '<td>' + (m ? '<button class="btn" data-del="' + i + '" style="padding:2px 7px">✕</button>' : '') + '</td></tr>';
    };
    rows.forEach((m, i) => { h += rowHtml(m, i); });
    h += rowHtml(null, rows.length);   // 末尾空白追加行（index = 现有长度）
    h += '</table><datalist id="rlNodeDl">' + dlOpts + '</datalist></div>';
    host.innerHTML = h;
    host.querySelectorAll('input[data-k]').forEach(node => node.addEventListener('input', () => {
      const i = +node.dataset.i, k = node.dataset.k, v = node.value;
      const c = curLaunch(true);
      if (i >= c.milestones.length) {
        // 空占位行：任一字段有内容即物化为真实节点并追加空行
        if (!String(v).trim()) return;
        const nm = { id: newId(), label: '', date: '', dateEnd: '', disp: '', note: '', color: '' };
        nm[k] = v; c.milestones.push(nm);
        if (!save()) return;
        renderTable(); renderPreview();
        // 重绘后把焦点放回同列的原格子，便于连续录入
        const back = host.querySelector('input[data-i="' + i + '"][data-k="' + k + '"]'); if (back) { back.focus(); if (back.setSelectionRange) try { back.setSelectionRange(back.value.length, back.value.length); } catch (e) {} }
        return;
      }
      c.milestones[i][k] = v;
      if (!save()) return;
      renderPreview();
    }));
    // Enter：跳到下一行同列，便于纵向连续录入（datalist 打开时不拦，交给浏览器选词）
    host.querySelectorAll('input[data-k]').forEach(node => node.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      const i = +node.dataset.i, k = node.dataset.k;
      const next = host.querySelector('input[data-i="' + (i + 1) + '"][data-k="' + k + '"]');
      if (next) { next.focus(); if (next.setSelectionRange) try { next.setSelectionRange(next.value.length, next.value.length); } catch (err) {} }
      else node.blur();   // 已是末行占位（若刚录入会由 input 触发重绘）
    }));
    host.querySelectorAll('button[data-del]').forEach(b => b.addEventListener('click', () => {
      const c = curLaunch(true); c.milestones.splice(+b.dataset.del, 1); save(); renderTable(); renderPreview();
    }));
  }

  // ---- 模板 C/D 编辑区（仅对应模板选中时显示；A/B/E 清空隐藏）-----------
  const COUNTRY_COLDEF = [
    ['presale', '预售时间'], ['online', '线上首销'], ['offline', '线下首销'], ['end', '首销结束'],
    ['targetOn', '线上目标'], ['targetOff', '线下目标'], ['target', '整体首销目标'], ['yoy', '同比上代']
  ];
  const LANE_DEFAULT = '#E8E8E8';

  function renderEditor() {
    const host = el('rlEditor'); if (!host) return;
    if (!products().length) { host.innerHTML = ''; return; }
    if (S.curTemplate === 'C') { renderCountryEditor(host); return; }
    if (S.curTemplate === 'D') { renderMktEditor(host); return; }
    if (S.curTemplate === 'E') { renderCurveEditor(host); return; }
    host.innerHTML = '';   // A/B 无本任务编辑区
  }

  // ---- 模板 C：国家节奏表编辑 --------------------------------------------
  function renderCountryEditor(host) {
    const l = curLaunch(true);
    const cols = Array.isArray(l.countryCols) ? l.countryCols : [];
    const rows = Array.isArray(l.countryRows) ? l.countryRows : [];
    // 列勾选
    const colChks = COUNTRY_COLDEF.map(([k, lbl]) => {
      const on = cols.indexOf(k) >= 0;
      return '<label class="rl-colchk' + (on ? ' on' : '') + '"><input type="checkbox" data-col="' + k + '"' + (on ? ' checked' : '') + '>' + esc(lbl) + '</label>';
    }).join('');
    // 表头（国家 + 勾选列）
    const active = COUNTRY_COLDEF.filter(([k]) => cols.indexOf(k) >= 0);
    let head = '<tr><th style="width:130px">国家</th>' + active.map(([, lbl]) => '<th>' + esc(lbl) + '</th>').join('') + '<th style="width:34px"></th></tr>';
    let body = rows.map((r, i) =>
      '<tr data-cr="' + i + '"><td><input data-i="' + i + '" data-k="country" value="' + esc(r.country) + '" placeholder="国家" style="width:120px"></td>' +
      active.map(([k]) => '<td><input data-i="' + i + '" data-k="' + k + '" value="' + esc(r[k]) + '" placeholder="值" style="width:100px"></td>').join('') +
      '<td><button class="btn" data-crdel="' + i + '" style="padding:2px 7px">✕</button></td></tr>'
    ).join('');
    host.innerHTML = '<div class="rl-card">' +
      '<div class="rl-ed-h">国家节奏表</div>' +
      '<div style="margin-bottom:8px">' + colChks + '</div>' +
      '<div style="overflow:auto"><table class="rl-tbl" style="min-width:100%">' + head + body + '</table></div>' +
      '<div style="display:flex;gap:8px;margin-top:10px">' +
        '<button class="btn" id="rlCrAdd" style="padding:4px 10px">＋加国家行</button>' +
        '<button class="btn" id="rlCrFromPricing" style="padding:4px 10px">从定价行带国家</button>' +
      '</div></div>';
    // 列勾选：增删 countryCols（保序按全集）
    host.querySelectorAll('input[data-col]').forEach(cb => cb.addEventListener('change', () => {
      const c = curLaunch(true); const key = cb.dataset.col;
      let cc = Array.isArray(c.countryCols) ? c.countryCols.slice() : [];
      if (cb.checked) { if (cc.indexOf(key) < 0) cc.push(key); }
      else { cc = cc.filter(x => x !== key); }
      // 按全集顺序归一，保证表头/导出列序一致
      c.countryCols = COUNTRY_COLDEF.map(([k]) => k).filter(k => cc.indexOf(k) >= 0);
      save(); renderEditor(); renderPreview();
    }));
    // 单元格编辑
    host.querySelectorAll('input[data-k]').forEach(node => node.addEventListener('input', () => {
      const c = curLaunch(true); const i = +node.dataset.i, k = node.dataset.k;
      if (!c.countryRows[i]) return;
      c.countryRows[i][k] = node.value; save(); renderPreview();
    }));
    host.querySelectorAll('button[data-crdel]').forEach(b => b.addEventListener('click', () => {
      const c = curLaunch(true); c.countryRows.splice(+b.dataset.crdel, 1); save(); renderEditor(); renderPreview();
    }));
    el('rlCrAdd').addEventListener('click', () => {
      const c = curLaunch(true); c.countryRows.push(blankCountryRow()); save(); renderEditor(); renderPreview();
    });
    el('rlCrFromPricing').addEventListener('click', () => {
      const c = curLaunch(true); const prod = curProduct();
      const have = {}; (c.countryRows || []).forEach(r => { if (r.country) have[String(r.country).trim()] = 1; });
      const seen = {}, add = [];
      ((prod && prod.pricing) || []).forEach(p => {
        const cn = String(p.country == null ? '' : p.country).trim();
        if (!cn || seen[cn] || have[cn]) return;   // 去重且不覆盖已有行
        seen[cn] = 1; add.push(cn);
      });
      if (!add.length) { alert('定价行里没有可追加的新国家（可能都已存在或产品无定价行）。'); return; }
      add.forEach(cn => { const r = blankCountryRow(); r.country = cn; c.countryRows.push(r); });
      save(); renderEditor(); renderPreview();
    });
  }
  function blankCountryRow() { return { country: '', presale: '', online: '', offline: '', end: '', targetOn: '', targetOff: '', target: '', yoy: '' }; }

  // ---- 模板 D：MKT 泳道 + 阶段策略框编辑 --------------------------------
  function renderMktEditor(host) {
    const l = curLaunch(true);
    const phases = Array.isArray(l.phases) ? l.phases : [];
    const boxes = Array.isArray(l.strategyBoxes) ? l.strategyBoxes : [];
    const dateCell = (i, k, v, ns) => '<input data-' + ns + '="' + i + '" data-k="' + k + '" value="' + esc(v) + '" placeholder="YYYY/M/D" style="width:104px">';
    // 泳道
    let laneRows = phases.map((p, i) => {
      const col = /^#[0-9a-fA-F]{6}$/.test(p.color) ? p.color : LANE_DEFAULT;
      return '<tr><td>' + dateCell(i, 'from', p.from || '', 'ph') + '</td><td>' + dateCell(i, 'to', p.to || '', 'ph') + '</td>' +
        '<td><input data-ph="' + i + '" data-k="text" value="' + esc(p.text) + '" placeholder="泳道文案" style="width:200px"></td>' +
        '<td><input type="color" data-ph="' + i + '" data-k="color" value="' + col + '" style="width:34px;height:26px;padding:0;border:1px solid var(--line);border-radius:5px;vertical-align:middle"></td>' +
        '<td><button class="btn" data-phdel="' + i + '" style="padding:2px 7px">✕</button></td></tr>';
    }).join('');
    // 策略框
    let boxRows = boxes.map((b, i) =>
      '<tr><td>' + dateCell(i, 'from', b.from || '', 'sb') + '</td><td>' + dateCell(i, 'to', b.to || '', 'sb') + '</td>' +
      '<td><input data-sb="' + i + '" data-k="text" value="' + esc(b.text) + '" placeholder="策略文案（红底白字）" style="width:240px"></td>' +
      '<td><button class="btn" data-sbdel="' + i + '" style="padding:2px 7px">✕</button></td></tr>'
    ).join('');
    host.innerHTML = '<div class="rl-card">' +
      '<div class="rl-ed-h">MKT 节奏泳道</div>' +
      '<table class="rl-tbl"><tr><th>起</th><th>迄</th><th>文案</th><th>颜色</th><th></th></tr>' + laneRows + '</table>' +
      '<div style="margin-top:8px"><button class="btn" id="rlPhAdd" style="padding:4px 10px">＋加泳道</button></div>' +
      '</div>' +
      '<div class="rl-card" style="margin-top:12px">' +
      '<div class="rl-ed-h">阶段策略框（红底白字）</div>' +
      '<table class="rl-tbl"><tr><th>起</th><th>迄</th><th>文案</th><th></th></tr>' + boxRows + '</table>' +
      '<div style="margin-top:8px"><button class="btn" id="rlSbAdd" style="padding:4px 10px">＋加策略框</button></div>' +
      '</div>';
    // 泳道字段
    host.querySelectorAll('[data-ph]').forEach(node => node.addEventListener('input', () => {
      const c = curLaunch(true); const i = +node.dataset.ph, k = node.dataset.k;
      if (!c.phases[i]) return; c.phases[i][k] = node.value; save(); renderPreview();
    }));
    host.querySelectorAll('button[data-phdel]').forEach(b => b.addEventListener('click', () => {
      const c = curLaunch(true); c.phases.splice(+b.dataset.phdel, 1); save(); renderEditor(); renderPreview();
    }));
    el('rlPhAdd').addEventListener('click', () => {
      const c = curLaunch(true); if (!Array.isArray(c.phases)) c.phases = [];
      c.phases.push({ from: '', to: '', text: '', color: LANE_DEFAULT }); save(); renderEditor(); renderPreview();
    });
    // 策略框字段
    host.querySelectorAll('[data-sb]').forEach(node => node.addEventListener('input', () => {
      const c = curLaunch(true); const i = +node.dataset.sb, k = node.dataset.k;
      if (!c.strategyBoxes[i]) return; c.strategyBoxes[i][k] = node.value; save(); renderPreview();
    }));
    host.querySelectorAll('button[data-sbdel]').forEach(b => b.addEventListener('click', () => {
      const c = curLaunch(true); c.strategyBoxes.splice(+b.dataset.sbdel, 1); save(); renderEditor(); renderPreview();
    }));
    el('rlSbAdd').addEventListener('click', () => {
      const c = curLaunch(true); if (!Array.isArray(c.strategyBoxes)) c.strategyBoxes = [];
      c.strategyBoxes.push({ from: '', to: '', text: '' }); save(); renderEditor(); renderPreview();
    });
  }

  // ---- 模板 E：操盘曲线（推演粘贴 / PSI 周销关联 / 大促底色块 / 策略框）----
  const BAND_DEFAULT = '#F2D7D7';   // 大促底色（浅红）
  // 粘贴文本→数字数组：逗号/空格/换行/制表符任意分隔，非数字跳过
  function parseValues(txt) {
    return String(txt == null ? '' : txt).split(/[\s,;\t\r\n]+/).map(s => s.trim())
      .filter(s => s !== '').map(s => Number(s)).filter(n => !isNaN(n) && isFinite(n));
  }
  // 起始日起每 7 天一格，取到与最长系列等长的 'M/D' 标签序列
  function weekLabels(startDate, n) {
    const base = RL.dNum(startDate);
    const out = [];
    for (let i = 0; i < n; i++) {
      if (base == null) { out.push('W' + (i + 1)); continue; }
      const d = new Date((base + i * 7) * 86400000);
      out.push((d.getUTCMonth() + 1) + '/' + d.getUTCDate());
    }
    return out;
  }
  // 从 api.query 周结果取「每周合计」序列（data 为 {系列名:{周桶:值}}，按 buckets 顺序求和）
  function extractWeeklyTotals(res) {
    if (!res) return [];
    if (Array.isArray(res.totals)) return res.totals.map(v => +v || 0);
    const buckets = res.buckets || [];
    const data = res.data || {};
    const keys = Object.keys(data);
    return buckets.map(b => { let s = 0; for (const k of keys) { const cell = data[k]; if (cell && typeof cell === 'object') s += (+cell[b] || 0); else if (Array.isArray(cell)) s += (+cell[buckets.indexOf(b)] || 0); } return Math.round(s); });
  }

  function renderCurveEditor(host) {
    const l = curLaunch(true);
    const cv = curCurve(l);
    const prod = curProduct();
    const planName = String(cv.plan.name || '').trim() || ((prod && prod.name ? prod.name : '产品') + ' 推演');
    const lastName = String(cv.last.name || '').trim() || '上代实际';
    const planColor = /^#[0-9a-fA-F]{6}$/.test(cv.plan.color) ? cv.plan.color : ACCENT;
    const lastColor = /^#[0-9a-fA-F]{6}$/.test(cv.last.color) ? cv.last.color : '#888888';
    // 逐格值小表（横向）：每个值一个输入框 + ✕删除；末尾一个空框可补
    const valCells = (arr, ns) => {
      let h = '<div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:6px">';
      (arr || []).forEach((v, i) => {
        h += '<span style="display:inline-flex;align-items:center;border:1px solid var(--c-line);border-radius:6px;overflow:hidden">' +
          '<input data-' + ns + 'v="' + i + '" value="' + esc(v) + '" style="width:54px;border:none;padding:4px 5px;text-align:right;font:inherit">' +
          '<button data-' + ns + 'del="' + i + '" title="删除" style="border:none;background:#FAFAFA;color:#C0392B;cursor:pointer;padding:0 6px">✕</button></span>';
      });
      h += '<input data-' + ns + 'add="1" placeholder="＋" style="width:44px;border:1px dashed #C9CCD1;border-radius:6px;padding:4px 5px;text-align:center;font:inherit">';
      h += '</div>';
      return h;
    };
    const bandRows = (cv.bands || []).map((b, i) => {
      const col = /^#[0-9a-fA-F]{6}$/.test(b.color) ? b.color : BAND_DEFAULT;
      return '<tr><td><input data-bd="' + i + '" data-k="from" value="' + esc(b.from || '') + '" placeholder="YYYY/M/D" style="width:104px"></td>' +
        '<td><input data-bd="' + i + '" data-k="to" value="' + esc(b.to || '') + '" placeholder="YYYY/M/D" style="width:104px"></td>' +
        '<td><input data-bd="' + i + '" data-k="text" value="' + esc(b.text || '') + '" placeholder="大促文案" style="width:180px"></td>' +
        '<td><input type="color" data-bd="' + i + '" data-k="color" value="' + col + '" style="width:34px;height:26px;padding:0;border:1px solid var(--line);border-radius:5px;vertical-align:middle"></td>' +
        '<td><button class="btn" data-bddel="' + i + '" style="padding:2px 7px">✕</button></td></tr>';
    }).join('');
    // 策略框（与 D 同字段 strategyBoxes）
    const boxes = Array.isArray(l.strategyBoxes) ? l.strategyBoxes : [];
    const boxRows = boxes.map((b, i) =>
      '<tr><td><input data-sb="' + i + '" data-k="from" value="' + esc(b.from || '') + '" placeholder="YYYY/M/D" style="width:104px"></td>' +
      '<td><input data-sb="' + i + '" data-k="to" value="' + esc(b.to || '') + '" placeholder="YYYY/M/D" style="width:104px"></td>' +
      '<td><input data-sb="' + i + '" data-k="text" value="' + esc(b.text || '') + '" placeholder="策略文案（红底白字）" style="width:240px"></td>' +
      '<td><button class="btn" data-sbdel="' + i + '" style="padding:2px 7px">✕</button></td></tr>'
    ).join('');

    host.innerHTML =
      '<div class="rl-card">' +
        '<div class="rl-ed-h">推演设置</div>' +
        '<div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">' +
          '<span style="font-size:12px;color:var(--ink2)">起始日</span>' +
          '<input id="rlCvStart" class="rl-in" value="' + esc(cv.startDate || '') + '" placeholder="2026/5/1" style="width:130px">' +
          '<span style="font-size:12px;color:var(--ink3)">粒度：按周（每 7 天一格）</span>' +
        '</div>' +
      '</div>' +
      '<div class="rl-card" style="margin-top:12px">' +
        '<div class="rl-ed-h">本代推演</div>' +
        '<div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:8px">' +
          '<span style="font-size:12px;color:var(--ink2)">系列名</span>' +
          '<input id="rlCvPlanName" class="rl-in" value="' + esc(cv.plan.name || '') + '" placeholder="' + esc(planName) + '" style="width:200px">' +
          '<span style="font-size:12px;color:var(--ink2)">颜色</span>' +
          '<input type="color" id="rlCvPlanColor" value="' + planColor + '" style="width:34px;height:26px;padding:0;border:1px solid var(--line);border-radius:5px;vertical-align:middle">' +
        '</div>' +
        '<div style="font-size:12px;color:var(--ink3);margin-bottom:3px">粘贴销量（逗号/空格/换行/制表符分隔，非数字自动跳过）</div>' +
        '<textarea id="rlCvPlanPaste" rows="2" style="width:100%;border:1px solid var(--c-line);border-radius:7px;padding:6px 9px;font:inherit;resize:vertical" placeholder="例如：120 180 260 340 410 ..."></textarea>' +
        '<div style="display:flex;gap:8px;margin-top:6px"><button class="btn" id="rlCvPlanParse" style="padding:4px 10px">解析追加</button><button class="btn" id="rlCvPlanReplace" style="padding:4px 10px">解析覆盖</button><span style="font-size:12px;color:var(--ink3);align-self:center">共 ' + cv.plan.values.length + ' 周</span></div>' +
        '<div style="font-size:12px;color:var(--ink3);margin-top:8px">逐格微调（可改可删可补）</div>' +
        valCells(cv.plan.values, 'p') +
      '</div>' +
      '<div class="rl-card" style="margin-top:12px">' +
        '<div class="rl-ed-h">上代实际</div>' +
        '<div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:8px">' +
          '<span style="font-size:12px;color:var(--ink2)">系列名</span>' +
          '<input id="rlCvLastName" class="rl-in" value="' + esc(cv.last.name || '') + '" placeholder="' + esc(lastName) + '" style="width:200px">' +
          '<span style="font-size:12px;color:var(--ink2)">颜色</span>' +
          '<input type="color" id="rlCvLastColor" value="' + lastColor + '" style="width:34px;height:26px;padding:0;border:1px solid var(--line);border-radius:5px;vertical-align:middle">' +
          '<button class="btn" id="rlCvLastPsi" style="padding:4px 10px">关联PSI产品…</button>' +
          '<span id="rlCvLastInfo" style="font-size:12px;color:var(--ink3)">' + (cv.last.psiProduct ? '已关联 ' + esc(cv.last.psiProduct) + '：' + cv.last.values.length + ' 周' : '未关联') + '</span>' +
        '</div>' +
        '<div style="font-size:12px;color:var(--ink3);margin-bottom:3px">或手动粘贴覆盖</div>' +
        '<textarea id="rlCvLastPaste" rows="2" style="width:100%;border:1px solid var(--c-line);border-radius:7px;padding:6px 9px;font:inherit;resize:vertical" placeholder="粘贴上代周销数据（覆盖）…"></textarea>' +
        '<div style="display:flex;gap:8px;margin-top:6px"><button class="btn" id="rlCvLastReplace" style="padding:4px 10px">解析覆盖</button><span style="font-size:12px;color:var(--ink3);align-self:center">共 ' + cv.last.values.length + ' 周</span></div>' +
        '<div style="font-size:12px;color:var(--ink3);margin-top:8px">逐格微调（可改可删可补）</div>' +
        valCells(cv.last.values, 'l') +
      '</div>' +
      '<div class="rl-card" style="margin-top:12px">' +
        '<div class="rl-ed-h">大促底色块</div>' +
        '<table class="rl-tbl"><tr><th>起</th><th>迄</th><th>文案</th><th>颜色</th><th></th></tr>' + bandRows + '</table>' +
        '<div style="margin-top:8px"><button class="btn" id="rlCvBandAdd" style="padding:4px 10px">＋加底色块</button></div>' +
      '</div>' +
      '<div class="rl-card" style="margin-top:12px">' +
        '<div class="rl-ed-h">阶段策略框（红底白字）</div>' +
        '<table class="rl-tbl"><tr><th>起</th><th>迄</th><th>文案</th><th></th></tr>' + boxRows + '</table>' +
        '<div style="margin-top:8px"><button class="btn" id="rlCvSbAdd" style="padding:4px 10px">＋加策略框</button></div>' +
      '</div>';

    // -- 设置 --
    el('rlCvStart').addEventListener('input', () => { const c = curCurve(curLaunch(true)); c.startDate = el('rlCvStart').value; save(); renderPreview(); });
    // -- 本代推演 --
    el('rlCvPlanName').addEventListener('input', () => { const c = curCurve(curLaunch(true)); c.plan.name = el('rlCvPlanName').value; save(); renderPreview(); });
    el('rlCvPlanColor').addEventListener('input', () => { const c = curCurve(curLaunch(true)); c.plan.color = el('rlCvPlanColor').value; save(); renderPreview(); });
    el('rlCvPlanParse').addEventListener('click', () => {
      const nums = parseValues(el('rlCvPlanPaste').value); if (!nums.length) { alert('未解析到数字'); return; }
      const c = curCurve(curLaunch(true)); c.plan.values = c.plan.values.concat(nums); save(); renderEditor(); renderPreview();
    });
    el('rlCvPlanReplace').addEventListener('click', () => {
      const nums = parseValues(el('rlCvPlanPaste').value); if (!nums.length) { alert('未解析到数字'); return; }
      const c = curCurve(curLaunch(true)); c.plan.values = nums; save(); renderEditor(); renderPreview();
    });
    bindValCells(host, 'p', () => curCurve(curLaunch(true)).plan);
    // -- 上代实际 --
    el('rlCvLastName').addEventListener('input', () => { const c = curCurve(curLaunch(true)); c.last.name = el('rlCvLastName').value; save(); renderPreview(); });
    el('rlCvLastColor').addEventListener('input', () => { const c = curCurve(curLaunch(true)); c.last.color = el('rlCvLastColor').value; save(); renderPreview(); });
    el('rlCvLastReplace').addEventListener('click', () => {
      const nums = parseValues(el('rlCvLastPaste').value); if (!nums.length) { alert('未解析到数字'); return; }
      const c = curCurve(curLaunch(true)); c.last.values = nums; save(); renderEditor(); renderPreview();
    });
    el('rlCvLastPsi').addEventListener('click', linkCurvePsi);
    bindValCells(host, 'l', () => curCurve(curLaunch(true)).last);
    // -- 大促底色块 --
    host.querySelectorAll('[data-bd]').forEach(node => node.addEventListener('input', () => {
      const c = curCurve(curLaunch(true)); const i = +node.dataset.bd, k = node.dataset.k;
      if (!c.bands[i]) return; c.bands[i][k] = node.value; save(); renderPreview();
    }));
    host.querySelectorAll('button[data-bddel]').forEach(b => b.addEventListener('click', () => {
      const c = curCurve(curLaunch(true)); c.bands.splice(+b.dataset.bddel, 1); save(); renderEditor(); renderPreview();
    }));
    el('rlCvBandAdd').addEventListener('click', () => {
      const c = curCurve(curLaunch(true)); c.bands.push({ from: '', to: '', text: '', color: BAND_DEFAULT }); save(); renderEditor(); renderPreview();
    });
    // -- 策略框（复用 strategyBoxes）--
    host.querySelectorAll('[data-sb]').forEach(node => node.addEventListener('input', () => {
      const c = curLaunch(true); if (!Array.isArray(c.strategyBoxes)) c.strategyBoxes = [];
      const i = +node.dataset.sb, k = node.dataset.k; if (!c.strategyBoxes[i]) return;
      c.strategyBoxes[i][k] = node.value; save(); renderPreview();
    }));
    host.querySelectorAll('button[data-sbdel]').forEach(b => b.addEventListener('click', () => {
      const c = curLaunch(true); c.strategyBoxes.splice(+b.dataset.sbdel, 1); save(); renderEditor(); renderPreview();
    }));
    el('rlCvSbAdd').addEventListener('click', () => {
      const c = curLaunch(true); if (!Array.isArray(c.strategyBoxes)) c.strategyBoxes = [];
      c.strategyBoxes.push({ from: '', to: '', text: '' }); save(); renderEditor(); renderPreview();
    });
  }

  // 逐格值小表事件绑定：ns='p'(plan)|'l'(last)；getSeries() 返回 {values:[]} 对象
  function bindValCells(host, ns, getSeries) {
    host.querySelectorAll('input[data-' + ns + 'v]').forEach(node => node.addEventListener('input', () => {
      const s = getSeries(); const i = +node.dataset[ns + 'v']; const n = Number(node.value);
      s.values[i] = isNaN(n) ? 0 : n; save(); renderPreview();
    }));
    host.querySelectorAll('button[data-' + ns + 'del]').forEach(b => b.addEventListener('click', () => {
      const s = getSeries(); s.values.splice(+b.dataset[ns + 'del'], 1); save(); renderEditor(); renderPreview();
    }));
    const addBox = host.querySelector('input[data-' + ns + 'add]');
    if (addBox) addBox.addEventListener('change', () => {
      const n = Number(addBox.value); if (isNaN(n) || addBox.value.trim() === '') { addBox.value = ''; return; }
      const s = getSeries(); s.values.push(n); save(); renderEditor(); renderPreview();
    });
  }

  // E：关联 PSI 产品 → api.query 周粒度 sellOut → 缓存进 curve.last.values（无数据静默降级）
  function linkCurvePsi() {
    if (!(api && api.options)) { alert('PSI 不可用（仅画推演线）'); return; }
    Promise.resolve(api.options('product', {})).then(list => {
      if (!list || !list.length) { alert('PSI 无产品数据（请先在 PSI 数据分析里加载数据；仅画推演线）'); return; }
      pickFromList('选择要关联的 PSI 产品（取上代周销 sellOut）', list, (name) => {
        if (!name) return;
        const c = curCurve(curLaunch(true)); c.last.psiProduct = name;
        // stackDim 必传(同 roadmap-ui 首4月SO 修复):缺省引擎抛错,这里的"静默降级"实际每次都在吞异常
        Promise.resolve(api.query({ metric: 'sellOut', gran: 'week', stackDim: 'product', filters: { product: [name] } })).then(res => {
          const vals = extractWeeklyTotals(res);
          if (!vals.length) { alert('该产品无周销数据（仅画推演线）'); const info = el('rlCvLastInfo'); if (info) info.textContent = '已关联 ' + name + '：无数据'; save(); return; }
          c.last.values = vals; save(); renderEditor(); renderPreview();
        }).catch(() => { alert('PSI 取数失败（仅画推演线）'); const info = el('rlCvLastInfo'); if (info) info.textContent = '已关联 ' + name + '：取数失败'; save(); });
      });
    }).catch(() => alert('PSI 取产品列表失败（仅画推演线）'));
  }

  // 预览用 echarts 实例（E 模板专用；重绘前 dispose 防泄漏）
  let cvChart = null;
  function disposeCvChart() {
    try {
      if (cvChart) { cvChart.dispose(); cvChart = null; }
      if (typeof echarts !== 'undefined') {
        const box = el('rlCvChart'); const ex = box && echarts.getInstanceByDom(box); if (ex) ex.dispose();
      }
    } catch (e) {}
  }

  // ---- 预览（模板 A/B/C/D/E）：SVG 时间轴（E 上半为 echarts 折线） -------
  function renderPreview() {
    const host = el('rlPreview'); if (!host) return;
    // 切走 E 或重绘前先释放上一实例，避免容器被 innerHTML 清掉后残留实例泄漏
    disposeCvChart();
    if (!products().length) { host.innerHTML = ''; return; }
    const l = curLaunch(true);
    const accent = /^#[0-9a-fA-F]{6}$/.test(l.accentColor) ? l.accentColor : ACCENT;
    const prod = curProduct();
    const titleText = String(l.title || '').trim() || ((prod && prod.name ? prod.name : '产品') + ' 上市节奏');
    const ms = (l.milestones || []).filter(m => RL.dNum(m.date) != null);
    const tpl = S.curTemplate;
    // C：轴压缩到上半（更矮 SVG、轴上移）；D：轴下方留泳道；A/B/E：常规
    const svgOpts = tpl === 'C' ? { H: 210, axisY: 110 } : (tpl === 'D' ? { H: 340 } : {});
    const svg = timelineSvg(ms, l.dispStyle || 'M.D', accent, svgOpts);
    let extra = '', chartHost = '';
    if (tpl === 'C') extra = countryTableHtml(l);
    else if (tpl === 'D') extra = mktLanesHtml(l, ms, accent);
    else if (tpl === 'E') chartHost = '<div id="rlCvChart" style="width:100%;height:300px;margin-bottom:6px"></div>';
    host.innerHTML = '<div class="rl-card">' +
      '<div style="font-weight:700;font-size:16px;color:' + esc(accent) + ';margin-bottom:2px">' + esc(titleText) + '</div>' +
      (l.subtitle ? '<div style="font-size:12px;color:var(--ink3);margin-bottom:8px">' + esc(l.subtitle) + '</div>' : '') +
      chartHost +
      (ms.length ? svg : '<div style="padding:30px;text-align:center;color:var(--ink3)">还没有有效日期的节点。上方快录、点左侧词库、或把词条拖到此处添加。</div>') +
      extra +
      '</div>';
    // E：容器已在 DOM 且可见时才 init echarts 折线（不可见/无 echarts 时跳过，避免 0 尺寸报错）
    if (tpl === 'E') renderCurveChart(l, accent);
    // Task5：预览重建后重绑交互（chip 拖入 / 三角拖动 / 双击 / 右键）。E 的 echarts 区不涉及。
    bindTimelineInteractions();
  }

  // ==== Task5 时间轴交互 =================================================
  // 说明：所有几何与 timelineSvg 一致；反解日期只在 UI 层做，t0/t1 从 SVG data-* 读（源自 timelineLayout）。
  // 事件沿用「重建后重绑」——每次 renderPreview 后调 bindTimelineInteractions()，
  // 拖动/内联编辑用到的临时 document listener 结束时一律移除。

  // 轴几何常量：timelineSvg 渲染与交互层反解共用同一套（声明须先于下方 RL_AXW 求值）
  const SVG_GEOM = { W: 860, padL: 40, padR: 40 };
  const RL_AXW = SVG_GEOM.W - SVG_GEOM.padL - SVG_GEOM.padR;   // 轴有效宽（viewBox 单位）
  // 屏幕 clientX → SVG viewBox 内 x（考虑 SVG 实际渲染宽度缩放）
  function svgLocalX(svg, clientX) {
    const r = svg.getBoundingClientRect();
    if (!r.width) return SVG_GEOM.padL;
    return (clientX - r.left) / r.width * SVG_GEOM.W;   // viewBox 宽=SVG_GEOM.W，等比缩放
  }
  // viewBox x（含轴留白）→ 归一化 0..1（clamp）
  function xToNorm(vx) { const n = (vx - SVG_GEOM.padL) / RL_AXW; return n < 0 ? 0 : (n > 1 ? 1 : n); }
  // 归一化 0..1 + t0/t1 → 'YYYY/M/D'（四舍五入到日）。空轴/单点（t0==t1）→ 当天。
  function normToDate(norm, t0, t1) {
    let dayNum;
    if (t1 > t0) dayNum = Math.round(t0 + (t1 - t0) * norm);
    else dayNum = Math.round(Date.now() / 86400000);   // 空轴/单点轴 → 今天序数
    const dt = new Date(dayNum * 86400000);
    return dt.getUTCFullYear() + '/' + (dt.getUTCMonth() + 1) + '/' + dt.getUTCDate();
  }
  // 从 date 串取「日粒度」偏移量：dateEnd 相对 date 的天数差（保留区间跨度用）
  function dayGap(dateA, dateB) { const a = RL.dNum(dateA), b = RL.dNum(dateB); return (a != null && b != null) ? (b - a) : null; }
  function dateFromNum(dayNum) { const dt = new Date(Math.round(dayNum) * 86400000); return dt.getUTCFullYear() + '/' + (dt.getUTCMonth() + 1) + '/' + dt.getUTCDate(); }

  function bindTimelineInteractions() {
    const host = el('rlPreview'); if (!host) return;
    const svg = host.querySelector('#rlTlSvg');   // 可能为空（无有效日期节点，只有引导文案）

    // --- 1) 词库 chip 拖入：drop 到预览卡片 → 反解日期 → 打开加节点弹层预填 ---
    // dragover 必须 preventDefault 才允许 drop；有 SVG 时给轴加高亮
    host.ondragover = (ev) => {
      if (!hasChip(ev)) return;
      ev.preventDefault(); ev.dataTransfer.dropEffect = 'copy';
      if (svg) svg.classList.add('rl-drop-on');
    };
    host.ondragleave = (ev) => { if (svg && !host.contains(ev.relatedTarget)) svg.classList.remove('rl-drop-on'); };
    host.ondrop = (ev) => {
      if (!hasChip(ev)) return;
      ev.preventDefault();
      if (svg) svg.classList.remove('rl-drop-on');
      let label = '';
      try { label = ev.dataTransfer.getData('text/rl-chip') || ev.dataTransfer.getData('text/plain') || ''; } catch (e) {}
      let date;
      if (svg) {
        const t0 = +svg.dataset.t0, t1 = +svg.dataset.t1;
        date = normToDate(xToNorm(svgLocalX(svg, ev.clientX)), t0, t1);
      } else {
        date = normToDate(0, 0, 0);   // 空轴 → 今天
      }
      openNodeDialog({ label: label, date: date });
    };

    if (!svg) return;

    // --- 2) 轴上节点拖动改期（<3px 视为点击不改）---
    svg.querySelectorAll('.rl-node').forEach(g => {
      const grab = g.querySelector('.rl-hit');
      if (grab) grab.addEventListener('mousedown', (ev) => startTriDrag(ev, svg, g));
    });

    // --- 3) 双击节点：就地改显示文本 disp ---
    svg.querySelectorAll('.rl-node').forEach(g => {
      g.addEventListener('dblclick', (ev) => { ev.preventDefault(); startInlineDispEdit(g); });
    });

    // --- 4) 右键节点：改色 / 编辑 / 删除 ---
    svg.querySelectorAll('.rl-node').forEach(g => {
      g.addEventListener('contextmenu', (ev) => { ev.preventDefault(); openNodeCtxMenu(ev, g.dataset.mid); });
    });
  }

  function hasChip(ev) { try { return !!ev.dataTransfer && Array.prototype.indexOf.call(ev.dataTransfer.types || [], 'text/rl-chip') >= 0; } catch (e) { return false; } }

  // 拖动一个三角改日期：move 时只改 DOM（transform + 气泡），mouseup 才写回+存+重绘
  function startTriDrag(ev, svg, g) {
    if (ev.button !== 0) return;   // 只响应左键，右键留给 contextmenu
    ev.preventDefault();
    const mid = g.dataset.mid;
    const l = curLaunch(true); if (!l) return;
    const m = (l.milestones || []).find(x => x.id === mid); if (!m) return;
    const t0 = +svg.dataset.t0, t1 = +svg.dataset.t1;
    const startX0 = +g.dataset.x;          // 起始归一化位置
    const downClientX = ev.clientX;
    const endGap = dayGap(m.date, m.dateEnd);   // 保留区间跨度（天）
    let curNorm = startX0, moved = false;
    const tip = document.createElement('div'); tip.className = 'rl-tip'; tip.style.display = 'none';
    document.body.appendChild(tip);
    g.classList.add('rl-dragging');

    const onMove = (e2) => {
      const dx = e2.clientX - downClientX;
      if (!moved && Math.abs(dx) < 3) return;   // <3px 不算拖动
      moved = true;
      const r = svg.getBoundingClientRect();
      curNorm = xToNorm(svgLocalX(svg, e2.clientX));
      // 只平移整组（transform 用 viewBox 单位，SVG 会随缩放自动换算），不整轴重排——落定后 renderPreview 才重算 tier
      g.setAttribute('transform', 'translate(' + ((curNorm - startX0) * RL_AXW) + ',0)');
      const dstr = normToDate(curNorm, t0, t1);
      tip.textContent = dstr.replace(/\//g, '/');   // YYYY/M/D
      tip.style.display = 'block';
      tip.style.left = e2.clientX + 'px';
      tip.style.top = (r.top + (+svg.dataset.axisy) / SVG_GEOM.W * r.width) + 'px';
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      if (tip.parentNode) tip.parentNode.removeChild(tip);
      g.classList.remove('rl-dragging');
      if (!moved) { g.removeAttribute('transform'); return; }   // 纯点击，不改
      const newDate = normToDate(curNorm, t0, t1);
      m.date = newDate;
      // 保留 dateEnd 相对天数偏移
      if (endGap != null) { const nd = RL.dNum(newDate); if (nd != null) m.dateEnd = dateFromNum(nd + endGap); }
      save(); renderTable(); renderPreview();
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }

  // 双击节点：在标签处浮出小输入框改 disp（空=恢复自动）。Enter 确认 Esc 取消。
  function startInlineDispEdit(g) {
    const mid = g.dataset.mid;
    const l = curLaunch(true); if (!l) return;
    const m = (l.milestones || []).find(x => x.id === mid); if (!m) return;
    const lblEl = g.querySelector('.rl-lbl'); if (!lblEl) return;
    const r = lblEl.getBoundingClientRect();
    const inp = document.createElement('input');
    inp.className = 'rl-inline-edit';
    inp.value = m.disp || '';
    inp.placeholder = '显示文本（空=自动）';
    inp.style.left = (r.left + r.width / 2) + 'px';
    inp.style.top = r.top + 'px';
    inp.style.transform = 'translate(-50%,-100%)';
    inp.style.width = '140px';
    document.body.appendChild(inp);
    inp.focus(); inp.select();
    let done = false;
    const finish = (commit) => {
      if (done) return; done = true;
      inp.removeEventListener('keydown', onKey);
      inp.removeEventListener('blur', onBlur);
      if (inp.parentNode) inp.parentNode.removeChild(inp);
      if (commit) { m.disp = String(inp.value || '').trim(); save(); renderTable(); renderPreview(); }
    };
    const onKey = (e) => {
      if (e.key === 'Enter') { e.preventDefault(); finish(true); }
      else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
    };
    const onBlur = () => finish(true);
    inp.addEventListener('keydown', onKey);
    inp.addEventListener('blur', onBlur);
  }

  // 右键节点菜单（复用 rmCtxMenu 模式）：改色 / 编辑 / 删除
  function openNodeCtxMenu(ev, mid) {
    const old = document.getElementById('rlNodeMenu'); if (old) old.remove();
    const l = curLaunch(true); if (!l) return;
    const m = (l.milestones || []).find(x => x.id === mid); if (!m) return;
    const menu = document.createElement('div'); menu.id = 'rlNodeMenu';
    menu.style.cssText = 'position:fixed;z-index:80;background:var(--c-bg-elev);border:1px solid var(--line);border-radius:8px;box-shadow:var(--shadow-l);padding:4px;font-size:13px;left:' + ev.clientX + 'px;top:' + ev.clientY + 'px;min-width:150px';
    const curCol = /^#[0-9a-fA-F]{6}$/.test(m.color) ? m.color : (/^#[0-9a-fA-F]{6}$/.test(l.accentColor) ? l.accentColor : ACCENT);
    menu.innerHTML =
      '<label style="display:flex;align-items:center;gap:8px;padding:6px 12px;cursor:pointer;border-radius:6px">颜色' +
        '<input type="color" id="rlNmColor" value="' + curCol + '" style="width:30px;height:24px;border:1px solid var(--line);border-radius:5px;padding:0;margin-left:auto"></label>' +
      '<div id="rlNmEdit" style="padding:6px 12px;cursor:pointer;border-radius:6px">编辑…</div>' +
      '<div id="rlNmDel" style="padding:6px 12px;cursor:pointer;color:var(--c-brand);border-radius:6px">删除节点</div>';
    document.body.appendChild(menu);
    const close = () => { menu.remove(); document.removeEventListener('mousedown', onDoc); };
    const onDoc = (e2) => { if (!menu.contains(e2.target)) close(); };
    setTimeout(() => document.addEventListener('mousedown', onDoc), 0);
    menu.querySelector('#rlNmColor').addEventListener('input', (e) => { m.color = e.target.value; save(); renderTable(); renderPreview(); });
    menu.querySelector('#rlNmColor').addEventListener('change', close);
    menu.querySelector('#rlNmEdit').addEventListener('click', () => { close(); openNodeDialog({ label: m.label, date: m.date, dateEnd: m.dateEnd, disp: m.disp, note: m.note, editId: m.id }); });
    menu.querySelector('#rlNmDel').addEventListener('click', () => {
      close();
      if (!confirm('确定删除节点「' + (m.label || '') + '」？')) return;
      const idx = (l.milestones || []).findIndex(x => x.id === mid); if (idx >= 0) l.milestones.splice(idx, 1);
      save(); renderTable(); renderPreview();
    });
  }

  // E 折线预览：双系列 smooth、数据标签、markArea 画 bands 底色、x 轴每 7 天 'M/D'
  function renderCurveChart(l, accent) {
    if (typeof echarts === 'undefined') return;
    const box = el('rlCvChart'); if (!box) return;
    if (!box.clientWidth || !box.clientHeight) return;   // 容器不可见/0 尺寸不初始化
    const cv = curCurve(l);
    const prod = curProduct();
    const planName = String(cv.plan.name || '').trim() || ((prod && prod.name ? prod.name : '产品') + ' 推演');
    const lastName = String(cv.last.name || '').trim() || '上代实际';
    const planColor = /^#[0-9a-fA-F]{6}$/.test(cv.plan.color) ? cv.plan.color : accent;
    const lastColor = /^#[0-9a-fA-F]{6}$/.test(cv.last.color) ? cv.last.color : '#888888';
    const nPlan = cv.plan.values.length, nLast = cv.last.values.length;
    const n = Math.max(nPlan, nLast);
    if (!n) { box.innerHTML = '<div style="padding:40px;text-align:center;color:var(--ink3)">粘贴或关联周销数据后显示曲线。</div>'; return; }
    const labels = weekLabels(cv.startDate, n);
    // 两系列补齐到同长（缺格填 null，echarts 断线）
    const pV = labels.map((_, i) => i < nPlan ? +cv.plan.values[i] : null);
    const lV = labels.map((_, i) => i < nLast ? +cv.last.values[i] : null);
    const bands = (cv.bands || []).map(b => ({ from: RL.dNum(b.from), to: RL.dNum(b.to), text: b.text || '', color: b.color }));
    const base = RL.dNum(cv.startDate);
    // 按 label 索引把 band 起迄映射到 x 轴类目（就近取周）
    const idxOf = (d) => { if (base == null || d == null) return null; return Math.max(0, Math.min(n - 1, Math.round((d - base) / 7))); };
    const markAreas = bands.filter(b => b.from != null || b.to != null).map(b => {
      const ai = idxOf(b.from != null ? b.from : b.to), zi = idxOf(b.to != null ? b.to : b.from);
      const col = /^#[0-9a-fA-F]{6}$/.test(b.color) ? b.color : BAND_DEFAULT;
      return [{ xAxis: labels[ai] != null ? ai : 0, itemStyle: { color: col, opacity: 0.55 }, label: { show: !!b.text, formatter: b.text, color: accent, position: 'insideTop', fontSize: 11, fontWeight: 'bold' } }, { xAxis: labels[zi] != null ? zi : (n - 1) }];
    });
    const series = [
      { name: planName, type: 'line', smooth: true, data: pV, connectNulls: false, lineStyle: { color: planColor, width: 2.5 }, itemStyle: { color: planColor }, label: { show: true, fontSize: 10, color: '#555' } },
      { name: lastName, type: 'line', smooth: true, data: lV, connectNulls: false, lineStyle: { color: lastColor, width: 2, type: 'dashed' }, itemStyle: { color: lastColor }, label: { show: true, fontSize: 10, color: '#999' } }
    ];
    if (markAreas.length) series[0].markArea = { silent: true, data: markAreas };
    disposeCvChart();
    cvChart = echarts.init(box);
    cvChart.setOption({
      tooltip: { trigger: 'axis' },
      legend: { bottom: 0, data: [planName, lastName], textStyle: { fontSize: 11 } },
      grid: { left: 42, right: 20, top: 20, bottom: 44 },
      xAxis: { type: 'category', data: labels, boundaryGap: false, axisLabel: { fontSize: 10 } },
      yAxis: { type: 'value', axisLabel: { fontSize: 10 } },
      series: series
    }, true);
  }

  // 模板 C 预览表：表头灰底 F2F2F2、行边框、字号小（风格参考用户 PPT）
  function countryTableHtml(l) {
    const cols = COUNTRY_COLDEF.filter(([k]) => (l.countryCols || []).indexOf(k) >= 0);
    const rows = l.countryRows || [];
    if (!cols.length && !rows.length) return '<div style="margin-top:10px;font-size:12px;color:var(--ink3)">勾选上方列并加国家行以生成节奏表。</div>';
    let h = '<div style="margin-top:12px;overflow:auto"><table class="rl-mini">';
    h += '<tr><th>国家</th>' + cols.map(([, lbl]) => '<th>' + esc(lbl) + '</th>').join('') + '</tr>';
    h += rows.map(r => '<tr><td>' + esc(r.country) + '</td>' + cols.map(([k]) => '<td>' + esc(r[k]) + '</td>').join('') + '</tr>').join('');
    h += '</table></div>';
    return h;
  }

  // 模板 D 预览：轴下方泳道色块（居中文字、色块间留缝）+ 更下方红色策略框带
  function mktLanesHtml(l, ms, accent) {
    const tl = RL.timelineLayout(ms, {});
    const phL = RL.phaseLayout(l.phases, tl.t0, tl.t1);
    const sbL = RL.phaseLayout(l.strategyBoxes, tl.t0, tl.t1);
    if (!phL.length && !sbL.length) return '<div style="margin-top:8px;font-size:12px;color:var(--ink3)">在上方编辑区加泳道/策略框以生成色带。</div>';
    const W = 860, padL = 40, padR = 40, axW = W - padL - padR;
    const laneOf = (p, col, txtCol, h) => {
      const x = padL + p.x * axW + 1.5, w = Math.max(4, p.w * axW - 3);
      return '<div style="position:absolute;left:' + x + 'px;width:' + w + 'px;height:' + h + 'px;background:' + col +
        ';color:' + txtCol + ';font-size:11px;display:flex;align-items:center;justify-content:center;text-align:center;overflow:hidden;padding:0 3px;box-sizing:border-box;border-radius:3px">' + esc(p.text || '') + '</div>';
    };
    let h = '<div style="position:relative;width:100%;max-width:' + W + 'px;margin-top:6px">';
    // 泳道行
    if (phL.length) {
      h += '<div style="position:relative;height:32px">';
      phL.forEach((p, i) => { const col = /^#[0-9a-fA-F]{6}$/.test((l.phases[i] || {}).color) ? l.phases[i].color : LANE_DEFAULT; h += laneOf(p, esc(col), '#444', 32); });
      h += '</div>';
    }
    // 策略框行（红底白字）
    if (sbL.length) {
      h += '<div style="position:relative;height:28px;margin-top:6px">';
      sbL.forEach(p => { h += laneOf(p, esc(accent), '#fff', 28); });
      h += '</div>';
    }
    h += '</div>';
    return h;
  }

  // SVG 时间轴：红横轴+右箭头、红三角、名称在上/日期在下、tier 上下交错、区间起点三角+横向括线
  // opts.H / opts.axisY 可覆盖高度与轴位置（C 压缩到上半、D 留出下方泳道空间）
  // 每个节点包在 <g data-mid> 里并带布局属性（供 Task5 交互：拖动改期/双击改文本/右键菜单反查）；
  // 轴几何常量 SVG_GEOM 声明在 Task5 交互段（首次使用处），此处直接取用。
  function timelineSvg(ms, style, accent, opts) {
    opts = opts || {};
    const W = SVG_GEOM.W, H = opts.H != null ? opts.H : 300, padL = SVG_GEOM.padL, padR = SVG_GEOM.padR, axisY = opts.axisY != null ? opts.axisY : 150;
    const tl = RL.timelineLayout(ms, {});
    const axX1 = padL, axX2 = W - padR, axW = axX2 - axX1;
    const px = (x) => axX1 + (x < 0 ? 0 : (x > 1 ? 1 : x)) * axW;
    const A = esc(accent);
    // data-* 上标注轴几何 + t0/t1，交互层直接读，无需再算
    let s = '<svg id="rlTlSvg" viewBox="0 0 ' + W + ' ' + H + '" width="100%" style="max-width:' + W + 'px;display:block"' +
      ' data-axisy="' + axisY + '" data-t0="' + tl.t0 + '" data-t1="' + tl.t1 + '">';
    s += '<defs><marker id="rlArrow" markerWidth="10" markerHeight="10" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 z" fill="' + A + '"/></marker></defs>';
    // 红横轴 + 右箭头
    s += '<line x1="' + axX1 + '" y1="' + axisY + '" x2="' + (axX2 - 2) + '" y2="' + axisY + '" stroke="' + A + '" stroke-width="2.5" marker-end="url(#rlArrow)"/>';
    tl.pts.forEach(p => {
      const cx = px(p.x);
      const tierOff = (p.tier || 0) * 34;   // tier 越高越往外
      const dm = ms.find(m => m.id === p.id) || {};
      const dtext = p.disp || RL.fmtDisp(dm.date, dm.dateEnd, style);
      const col = /^#[0-9a-fA-F]{6}$/.test(p.color) ? p.color : accent;
      const C = esc(col);
      const ly = axisY - 22 - tierOff;    // 名称基线
      const dy = axisY + 26 + tierOff;    // 日期基线
      // 一个节点一组；data-x 记录当前归一化位置，拖动时实时更新 transform
      s += '<g class="rl-node" data-mid="' + esc(p.id) + '" data-x="' + p.x + '">';
      // 区间括线（起点→迄点横线）
      if (p.xEnd != null && p.xEnd > p.x) {
        const ex = px(p.xEnd);
        s += '<line x1="' + cx + '" y1="' + axisY + '" x2="' + ex + '" y2="' + axisY + '" stroke="' + C + '" stroke-width="4" opacity="0.35"/>';
        s += '<line x1="' + ex + '" y1="' + (axisY - 5) + '" x2="' + ex + '" y2="' + (axisY + 5) + '" stroke="' + C + '" stroke-width="2"/>';
      }
      // 红三角（顶点朝上，压在轴上）
      s += '<polygon class="rl-tri" points="' + cx + ',' + (axisY - 9) + ' ' + (cx - 7) + ',' + (axisY + 3) + ' ' + (cx + 7) + ',' + (axisY + 3) + '" fill="' + C + '"/>';
      // 名称在轴上方（双击就地改显示文本、右键弹菜单挂在整组上）
      s += '<text class="rl-lbl" x="' + cx + '" y="' + ly + '" text-anchor="middle" font-size="13" font-weight="700" fill="#1A1A1A">' + esc(p.label) + '</text>';
      // 连接短线（名称到轴）
      s += '<line x1="' + cx + '" y1="' + (ly + 4) + '" x2="' + cx + '" y2="' + (axisY - 10) + '" stroke="#D9D9D9" stroke-width="1"/>';
      // 日期在轴下方
      s += '<text class="rl-dt" x="' + cx + '" y="' + dy + '" text-anchor="middle" font-size="12" fill="#5A5F66">' + esc(dtext) + '</text>';
      // 透明热区（覆盖三角+名称+日期整列），加大拖动/点击命中面积；cursor 交给 CSS
      s += '<rect class="rl-hit" x="' + (cx - 26) + '" y="' + (ly - 12) + '" width="52" height="' + (dy - ly + 18) + '" fill="transparent"/>';
      s += '</g>';
    });
    s += '</svg>';
    return s;
  }

  // ---- 导出 PPT（A/B 用 pptxLaunch 布局） -------------------------------
  function exportPpt() {
    if (!RL || typeof PptxGenJS === 'undefined') { alert('导出组件不可用（PptxGenJS 缺失）'); return; }
    const prod = curProduct(); if (!prod) { alert('请先选产品'); return; }
    const l = curLaunch(true);
    const GEO = { W: 13.333, H: 7.5 };
    const L = RL.pptxLaunch(l, prod, GEO);
    const pptx = new PptxGenJS(); pptx.defineLayout({ name: 'W', width: 13.333, height: 7.5 }); pptx.layout = 'W';
    const s = pptx.addSlide();
    const accent = L.accent || 'C7000B';
    // 标题
    s.addText(L.title.text, { x: L.title.x, y: L.title.y, w: L.title.w, h: L.title.h, fontSize: 24, bold: true, color: accent });
    if (l.subtitle) s.addText(String(l.subtitle), { x: L.title.x, y: L.title.y + L.title.h, w: L.title.w, h: 0.35, fontSize: 13, color: '5A5F66' });
    // 红横轴 + 右箭头
    const ax = L.axis;
    s.addShape('line', { x: ax.x1, y: ax.y1, w: ax.x2 - ax.x1, h: 0, line: { color: accent, width: 2.25, endArrowType: 'triangle' } });
    // 三角节点
    (L.tris || []).forEach(t => s.addShape('triangle', { x: t.x, y: t.y, w: t.w, h: t.h, fill: { color: accent }, line: { type: 'none' } }));
    // 名称 / 日期
    (L.labels || []).forEach(t => s.addText(t.text, { x: t.x, y: t.y, w: t.w, h: t.h, fontSize: t.fontSize, bold: t.bold, align: t.align, color: '1A1A1A' }));
    (L.dates || []).forEach(t => s.addText(t.text, { x: t.x, y: t.y, w: t.w, h: t.h, fontSize: t.fontSize, bold: t.bold, align: t.align, color: '5A5F66' }));

    // 模板 C：国家节奏表（表头行灰底 F2F2F2 加粗、全线边框 D9D9D9、fontSize 10、居中居中对齐）
    if (S.curTemplate === 'C' && L.table && Array.isArray(L.table.rowsAoa) && L.table.rowsAoa.length) {
      const border = { type: 'solid', color: 'D9D9D9', pt: 0.75 };
      const rowsPx = L.table.rowsAoa.map((r, ri) => (r || []).map(c => ({
        text: c == null ? '' : String(c),
        options: ri === 0 ? { bold: true, fill: { color: 'F2F2F2' }, color: '333333' } : { color: '333333' }
      })));
      s.addTable(rowsPx, {
        x: L.table.x, y: L.table.y, w: L.table.w, colW: L.table.colW,
        fontSize: 10, valign: 'middle', align: 'center', border: border, autoPage: false
      });
    }

    // 模板 D：泳道色块（自定义色底、深灰字）+ 阶段策略框（accent 红底、白字加粗）
    if (S.curTemplate === 'D') {
      (L.phaseRects || []).forEach(r => {
        s.addShape('rect', { x: r.x, y: r.y, w: r.w, h: r.h, fill: { color: r.color || 'E8E8E8' }, line: { type: 'none' } });
        if (r.text) s.addText(r.text, { x: r.x, y: r.y, w: r.w, h: r.h, fontSize: 10, align: 'center', valign: 'middle', color: '444444' });
      });
      (L.strategyRects || []).forEach(r => {
        s.addShape('rect', { x: r.x, y: r.y, w: r.w, h: r.h, fill: { color: r.color || accent }, line: { type: 'none' } });
        if (r.text) s.addText(r.text, { x: r.x, y: r.y, w: r.w, h: r.h, fontSize: 11, bold: true, align: 'center', valign: 'middle', color: 'FFFFFF' });
      });
    }

    // 模板 E：大促底色块（半透明 rect 垫底 + 顶部红字文案）→ addChart 折线（双系列 smooth，数据标签，图例底部）→ 策略框
    if (S.curTemplate === 'E' && L.chart) {
      const cv = curCurve(l);
      const prodName = (prod && prod.name) ? prod.name : '产品';
      const planName = String(cv.plan.name || '').trim() || (prodName + ' 推演');
      const lastName = String(cv.last.name || '').trim() || '上代实际';
      const planHex = (/^#[0-9a-fA-F]{6}$/.test(cv.plan.color) ? cv.plan.color : ('#' + accent)).replace('#', '');
      const lastHex = (/^#[0-9a-fA-F]{6}$/.test(cv.last.color) ? cv.last.color : '#888888').replace('#', '');
      // 底色块（半透明 rect）垫在图表区近似位置 + 顶部文案（core 已算好 bandRects 坐标/文案/色）
      (L.bandRects || []).forEach(r => {
        s.addShape('rect', { x: r.x, y: r.y, w: r.w, h: r.h, fill: { color: r.color || 'F2D7D7', transparency: 70 }, line: { type: 'none' } });
        if (r.text) s.addText(r.text, { x: r.x, y: r.y + 0.02, w: r.w, h: 0.3, fontSize: 11, bold: true, align: 'center', valign: 'top', color: accent });
      });
      // 折线图：两系列 labels 对齐（短的补 null）
      const nPlan = cv.plan.values.length, nLast = cv.last.values.length, n = Math.max(nPlan, nLast);
      if (n) {
        const labels = weekLabels(cv.startDate, n);
        const pV = labels.map((_, i) => i < nPlan ? (+cv.plan.values[i] || 0) : null);
        const lV = labels.map((_, i) => i < nLast ? (+cv.last.values[i] || 0) : null);
        const chartData = [{ name: planName, labels: labels, values: pV }];
        if (nLast) chartData.push({ name: lastName, labels: labels, values: lV });
        try {
          s.addChart('line', chartData, {
            x: L.chart.x, y: L.chart.y, w: L.chart.w, h: L.chart.h,
            chartColors: nLast ? [planHex, lastHex] : [planHex],
            lineSmooth: true, lineDataSymbol: 'circle', lineDataSymbolSize: 4,
            showLegend: true, legendPos: 'b', showValue: true, dataLabelFontSize: 8,
            showTitle: false, catAxisLabelFontSize: 8, valAxisLabelFontSize: 8
          });
        } catch (e) {
          // addChart 不可用时退化：用 addText 提示（不阻断其余形状导出）
          s.addText('（图表导出失败：' + (e && e.message || e) + '）', { x: L.chart.x, y: L.chart.y + L.chart.h / 2, w: L.chart.w, h: 0.4, fontSize: 11, align: 'center', color: '999999' });
        }
      }
      (L.strategyRects || []).forEach(r => {
        s.addShape('rect', { x: r.x, y: r.y, w: r.w, h: r.h, fill: { color: r.color || accent }, line: { type: 'none' } });
        if (r.text) s.addText(r.text, { x: r.x, y: r.y, w: r.w, h: r.h, fontSize: 11, bold: true, align: 'center', valign: 'middle', color: 'FFFFFF' });
      });
    }

    const fname = ExportUtil.safe('上市节奏_' + (prod.name || '产品') + '_' + S.curTemplate + '_' + ExportUtil.ymd() + '.pptx');
    pptx.write('base64').then(b64 => api.saveFile(fname, b64, 'pptx')).catch(e => alert('导出失败：' + (e && e.message || e)));
  }

  // ---- 供 roadmap-ui.js exportJson/onImportJson 读写同一 localStorage 键 ----
  function getData() { load(); return { launches: S.store.launches || [], nodeLib: S.store.nodeLib || [] }; }
  function setData(o) {
    if (!o || typeof o !== 'object') return;
    load();
    if (Array.isArray(o.launches)) S.store.launches = o.launches;
    if (Array.isArray(o.nodeLib) && o.nodeLib.length) S.store.nodeLib = o.nodeLib;
    save();
  }

  window.RoadmapLaunchUI = { render, getData, setData };
})();

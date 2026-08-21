/* ============================================================
   库存管理 / SO 模拟看板 —— 视图控制器（导入 / 维度·时间选择 / 表清单 / 编辑联动）
   依赖（均 UMD，window.<Name>，由 index.html 在本文件之前加载——Task 10 接线）：
     window.SoSimCore / SoSimCalc / SoSimExport / ShipmentBase / CostBase
     共享：common.js 的 $ / toast / showLoading / hideLoading / XLSX / api(=window.sb)
   渲染入口 renderInventory()（保持现签名）；内容塞进 #invRoot；首渲用 dataset.built 防重复。
   全局句柄存到 window.__sosim（供 Task 10 保存/读取调用）。

   ⚠ 架构说明（重要，见 task-9 报告）：本应用渲染层无法直接拿到 PSI 立方（brief 假设的
   state.engine.store 在本架构中不存在——立方只活在主进程，渲染层只能经 IPC `api`）。
   因此 PSI 单元级数据统一经唯一数据缝 invFetchPsiUnits() 获取：优先调专用 IPC
   `api.psiUnits()`（需主进程提供，Task 10 接线），否则给出明确提示。其余逻辑与 brief 一致。
   ============================================================ */
'use strict';

/* ---------- 维度 / 粒度 选项 ---------- */
const INV_GEO_OPTS = [['region', '大区'], ['rep', '国家办'], ['country', '国家']];
const INV_PROD_OPTS = [['line', '产品线'], ['family', '产品系列'], ['series', '产品'], ['model', '型号']];
const INV_GRAN_OPTS = [['day', '日'], ['week', '周'], ['month', '月'], ['quarter', '季'], ['year', '年']];
const INV_CHART_OPTS = [['bar', '堆积柱形图'], ['area', '堆积面积图'], ['pct', '百分比柱形图']];
/* 维度值筛选：按 brief 指定顺序（大区→…→型号）。独立 AND 语义。 */
const INV_FILTER_DIMS = [['region', '大区'], ['rep', '国家办'], ['country', '国家'], ['line', '产品线'], ['family', '产品系列'], ['series', '产品'], ['model', '型号']];
const INV_MAX_TABLES = 60;
/* 成本图柱子与表格桶列一一对齐：固定列宽（px）。首列「口径」宽 INV_LABEL_W，每个数据列宽 INV_COL_W。
   表/图共享同一 .inv-card 横向滚动；图容器宽 = INV_LABEL_W + nCols*INV_COL_W，grid.left = INV_LABEL_W，
   boundaryGap:true → 第 i 个柱中心 = INV_LABEL_W + (i+0.5)*INV_COL_W = 表第 i 个数据列中心。 */
const INV_LABEL_W = 96, INV_COL_W = 64;
/* 成本图按发货月(1–12)着色：固定 10 色调色板（与原 invBuildChartOption 内联调色板一致），
   按月循环作默认色（月 m → INV_PALETTE[(m-1)%len]）。用户可在「图例颜色」面板逐月改色，
   存 localStorage（INV_MONTH_COLORS_KEY，JSON）。三图型(bar/area/pct)共用 invBuildChartOption，
   故在那里把 itemStyle.color 改成 invMonthColor(ym) 即可三型通用。 */
const INV_PALETTE = ['#C7000B', '#5B8FF9', '#5AD8A6', '#F6BD16', '#945FB9', '#FF9845', '#6DC8EC', '#FF99C3', '#1E9493', '#D3CEFD'];
const INV_MONTH_COLORS_KEY = 'paneo.sosim.monthColors.v1';
/* 跨版本存档键：archive.js 把任何 sb.* 键自动持久化到存档文件（debounce 存盘 + 开机回载
   + beforeunload 兜底）。写进此键 → 预测+设置自动跨刷新/跨版本持久化。只存预测(稀疏)+视图设置，
   体积小；发货/成本底表不进存档（仍从文件导入）。 */
const INV_ARCHIVE_KEY = 'sb.sosim.v1';

/* 月份号(1–12)→默认色（按调色板循环） */
function invDefaultMonthColor(m) { return INV_PALETTE[((m - 1) % INV_PALETTE.length + INV_PALETTE.length) % INV_PALETTE.length]; }
/* 12 月的默认色映射 { '1':hex, …, '12':hex } */
function invDefaultMonthColors() { const o = {}; for (let m = 1; m <= 12; m++) o[String(m)] = invDefaultMonthColor(m); return o; }
/* 读 localStorage（缺省/解析失败/异常 → 全默认），并补齐缺失月为默认，规整为 12 个键。 */
function invLoadMonthColors() {
  const def = invDefaultMonthColors();
  try {
    const raw = localStorage.getItem(INV_MONTH_COLORS_KEY);
    if (raw) {
      const o = JSON.parse(raw);
      if (o && typeof o === 'object') {
        for (let m = 1; m <= 12; m++) { const k = String(m); if (typeof o[k] === 'string' && /^#[0-9a-fA-F]{6}$/.test(o[k])) def[k] = o[k]; }
      }
    }
  } catch (e) { /* 隐私模式/配额/解析异常 → 用默认 */ }
  return def;
}
/* 写回 localStorage（try/catch 吞配额/隐私模式异常）。 */
function invSaveMonthColors(mc) { try { localStorage.setItem(INV_MONTH_COLORS_KEY, JSON.stringify(mc || {})); } catch (e) { /* noop */ } }
/* 某发货月(ym, 形如 YYYYMM)的着色：取 s.monthColors[月份号]，缺则默认按月循环。 */
function invMonthColor(ym) {
  const m = ((ym % 100) || 0);
  const s = window.__sosim;
  const mc = s && s.monthColors;
  const c = mc && mc[String(m)];
  return (typeof c === 'string' && c) ? c : invDefaultMonthColor(m);
}

/* ============================================================
   跨版本存档（sb.sosim.v1）—— 自动持久化预测 + 视图设置（见 INV_ARCHIVE_KEY 说明）。
   运行态 s._dirty / s._savedAt / s._archTimer 不进序列化。全程 try/catch：
   配额/隐私模式/坏数据均不抛，确保 renderInventory 顶层不因存档异常报错。
   ============================================================ */
/* 写存档：序列化 store（稀疏预测行）+ 视图设置 → localStorage[sb.sosim.v1]。
   成功后更新 s._savedAt / s._dirty=false 并刷新状态条。失败 toast（不抛）。 */
function invArchiveSave() {
  const s = window.__sosim;
  if (!s) return;
  try {
    const S = window.SoSimCore;
    const savedAt = new Date().toISOString();
    const payload = {
      schemaVersion: 1,
      savedAt: savedAt,
      store: (S && typeof S.serializeStore === 'function') ? S.serializeStore(s.store || new Map()) : [],
      view: {
        gran: s.gran, geoLevel: s.geoLevel, prodLevel: s.prodLevel, chartType: s.chartType,
        filters: s.filters || {}, range: s.range || null, fillShipFromSellIn: !!s.fillShipFromSellIn,
      },
    };
    localStorage.setItem(INV_ARCHIVE_KEY, JSON.stringify(payload));
    s._savedAt = savedAt; s._dirty = false;
    invRenderArchiveStatus();
  } catch (e) {
    try { if (typeof toast === 'function') toast('存档失败：' + (e && e.message || e), 'err'); } catch (e2) { /* noop */ }
  }
}

/* 读存档：localStorage[sb.sosim.v1] → 还原 store + 各视图设置（各自存在才覆盖，缺则保留默认）。
   坏数据/缺键回退（不动默认），全程 try/catch（隐私模式/解析异常不抛）。 */
function invArchiveLoad() {
  const s = window.__sosim;
  if (!s) return;
  try {
    const raw = localStorage.getItem(INV_ARCHIVE_KEY);
    if (!raw) return;
    const obj = JSON.parse(raw);
    if (!obj || typeof obj !== 'object') return;
    const S = window.SoSimCore;
    if (S && typeof S.deserializeStore === 'function') {
      s.store = S.deserializeStore(Array.isArray(obj.store) ? obj.store : []);
    }
    const v = obj.view || {};
    if (typeof v.gran === 'string') s.gran = v.gran;
    if (typeof v.geoLevel === 'string') s.geoLevel = v.geoLevel;
    if (typeof v.prodLevel === 'string') s.prodLevel = v.prodLevel;
    if (typeof v.chartType === 'string') s.chartType = v.chartType;
    if (v.filters && typeof v.filters === 'object') s.filters = v.filters;
    if (v.range && typeof v.range === 'object' && v.range.from && v.range.to) s.range = { from: +v.range.from, to: +v.range.to };
    if (typeof v.fillShipFromSellIn === 'boolean') s.fillShipFromSellIn = v.fillShipFromSellIn;
    if (typeof obj.savedAt === 'string') s._savedAt = obj.savedAt;
    s._dirty = false;
  } catch (e) { /* 坏数据/隐私模式 → 回退默认，不抛 */ }
}

/* 标记有未保存改动 → 状态条转「未保存」+ 防抖（~600ms）自动存盘。永不丢数据。 */
function invMarkDirty() {
  const s = window.__sosim;
  if (!s) return;
  s._dirty = true;
  invRenderArchiveStatus();
  try { clearTimeout(s._archTimer); } catch (e) { /* noop */ }
  try { s._archTimer = setTimeout(invArchiveSave, 600); } catch (e) { /* noop */ }
}

/* 刷新存储状态条：未保存改动(黄) / ✓ 已存档·时分秒(绿) / —（无存档）。 */
function invRenderArchiveStatus() {
  const el = (typeof document !== 'undefined' && document.getElementById) ? document.getElementById('invArchiveStatus') : null;
  if (!el) return;
  const s = window.__sosim || {};
  el.classList.remove('dirty', 'ok');
  if (s._dirty) {
    el.textContent = '未保存改动';
    el.classList.add('dirty');
  } else if (s._savedAt) {
    let hms = '';
    try { const d = new Date(s._savedAt); hms = d.toLocaleTimeString('zh-CN', { hour12: false }); } catch (e) { hms = ''; }
    el.textContent = '✓ 已存档' + (hms ? ' · ' + hms : '');
    el.classList.add('ok');
  } else {
    el.textContent = '—';
  }
}

function _invEsc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

/* ============================================================
   Step 1: 渲染入口 + 导入区
   ============================================================ */
function renderInventory() {
  const root = document.getElementById('invRoot');
  if (!root || root.dataset.built) return;
  root.dataset.built = '1';
  window.__sosim = window.__sosim || { ship: [], cost: null, ctx: null, store: new Map(), geoLevel: 'country', prodLevel: 'series', gran: 'month', range: null, chartType: 'bar', filters: {}, fillShipFromSellIn: false, _charts: [], _sel: new Set(), _selAnchor: null };
  // 成本图按发货月自定义 legend 颜色（读 localStorage，缺省=调色板按月循环）。
  if (!window.__sosim.monthColors) window.__sosim.monthColors = invLoadMonthColors();
  // 开机回载跨版本存档：刷新/升级版本后把用户预测 + 视图设置带回（在首渲/ctx 构建之前）。
  // 存档恢复了 s.range 时，下游 invDefaultRange 仅在 !s.range 时才覆盖，故不会被冲掉。
  invArchiveLoad();
  invEnsureStyle();
  root.innerHTML = invToolbarHtml() + '<div id="invFilter" class="inv-filter"></div>' + '<div id="invTables" style="padding:8px 16px"></div>'
    + '<div id="invSelBar"></div>';
  wireInvToolbar();
  invRenderArchiveStatus();   // 本线:存档状态条
  // 首次进入：先从「数据源」文件夹自动加载 发货/成本（无需手选，主线 invAutoLoadSources），
  // 再取 PSI 单元行 → 构建上下文 → 出表。源未设置/失败不抛错；invRebuildCtx 异步完成后自动 invRenderTables。
  invAutoLoadSources().then(() => invRebuildCtx());
}

function invEnsureStyle() {
  if (document.getElementById('inv-style')) return;
  const css = `
  #invRoot{font-size:13px;color:var(--ink)}
  .inv-tool{display:flex;align-items:center;gap:10px 16px;flex-wrap:wrap;padding:12px 16px;border-bottom:1px solid var(--line)}
  .inv-tool .grp{display:flex;align-items:center;gap:6px}
  .inv-tool .grp>.lbl{font-size:12.5px;color:var(--ink2);margin-right:2px}
  .inv-seg{display:inline-flex;border:1px solid var(--line);border-radius:8px;overflow:hidden}
  .inv-seg button{border:0;background:var(--panel);padding:4px 10px;font-size:12px;cursor:pointer;color:var(--ink2)}
  .inv-seg button.on{background:var(--c-brand);color:var(--c-bg-elev)}
  .inv-file{font-size:12px}
  .inv-btn{border:1px solid var(--line);background:var(--panel);border-radius:8px;padding:5px 12px;font-size:12.5px;cursor:pointer;color:var(--ink)}
  .inv-btn:hover{background:#f6f6f6}
  .inv-spacer{flex:1}
  .inv-card{border:1px solid var(--line);border-radius:10px;margin:14px 0;overflow:auto;background:var(--panel)}
  .inv-card h4{font-size:13px;font-weight:700;padding:10px 14px;border-bottom:1px solid var(--line);position:sticky;left:0}
  /* Task 22：汇总表（置顶第一张）强调样式 —— 红色边框/标题，浅红表头底，与下方明细表区分。 */
  .inv-card-sum{border-color:var(--c-brand);border-width:2px;box-shadow:0 1px 8px rgba(199,0,11,.10)}
  .inv-card-sum>h4{color:var(--c-brand);background:#fff5f5;border-bottom-color:var(--c-brand)}
  table.inv-t{border-collapse:collapse;font-size:12px;table-layout:fixed}
  table.inv-t th,table.inv-t td{box-sizing:border-box;border:1px solid var(--line);padding:4px 8px;text-align:right;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;width:${INV_COL_W}px;min-width:${INV_COL_W}px;max-width:${INV_COL_W}px}
  table.inv-t th:first-child,table.inv-t td:first-child{text-align:left;position:sticky;left:0;background:var(--panel);font-weight:600;z-index:1;width:${INV_LABEL_W}px;min-width:${INV_LABEL_W}px;max-width:${INV_LABEL_W}px}
  table.inv-t thead th{background:#fafafa;color:var(--ink2)}
  table.inv-t td.fut{background:#fffdf3}
  table.inv-t td.over{background:#fde2e2}
  table.inv-t input.inv-cell{width:100%;box-sizing:border-box;border:1px solid transparent;background:transparent;text-align:right;font-size:12px;padding:1px 2px;border-radius:3px}
  table.inv-t input.inv-cell:focus{border-color:var(--c-brand);background:var(--c-bg-elev);outline:none}
  /* Task 19：多选高亮（可叠加 fut/over，半透明蓝底+内描边，不改尺寸不动布局/对齐） */
  table.inv-t td.inv-sel{background:rgba(91,143,249,.22);box-shadow:inset 0 0 0 2px #5B8FF9}
  table.inv-t td.inv-sel.over{background:rgba(199,0,11,.18)}
  /* Task 19：底部选区状态栏（sticky 贴底，默认隐藏） */
  #invSelBar{position:sticky;bottom:0;z-index:60;display:none;align-items:center;gap:18px;
    padding:6px 16px;background:var(--panel);border-top:1px solid var(--line);
    font-size:12.5px;color:var(--ink);box-shadow:0 -2px 8px rgba(0,0,0,.06)}
  #invSelBar.on{display:flex}
  #invSelBar .inv-selnum{font-weight:700;color:var(--c-brand)}
  .inv-empty{padding:40px;color:var(--ink3);font-size:13px;line-height:1.8}
  .inv-chart{border-top:1px dashed var(--line)}
  .inv-chart-ph{display:flex;align-items:center;justify-content:center;height:100%;color:var(--ink3);font-size:12px}
  .inv-filter{display:flex;align-items:center;gap:8px 10px;flex-wrap:wrap;padding:8px 16px;border-bottom:1px solid var(--line);background:#fbfbfb}
  .inv-filter>.lbl{font-size:12.5px;color:var(--ink2);margin-right:2px}
  /* 7 维筛选统一为共享 .ms 多选组件；在库存筛选栏里收紧触发器宽度，一行排得下 */
  .inv-filter .inv-ms .ms-trigger{min-width:96px;max-width:160px;padding:5px 8px}
  .inv-range{display:inline-flex;align-items:center;gap:6px;margin-right:8px}
  .inv-range select.inv-rsel,.inv-range input.inv-rdate{font-size:12px;border:1px solid var(--line);border-radius:8px;padding:3px 6px;background:var(--panel);color:var(--ink);cursor:pointer;max-width:140px}
  .inv-range .inv-rsep{color:var(--ink3);font-size:12px}
  .inv-range .inv-rall{padding:4px 10px}
  /* 维度筛选已统一到共享 .ms 多选组件；以下 .inv-fbtn/.inv-fpop 仅供工具条「图例颜色」按钮+浮层
     与时间范围「全部」按钮复用（.inv-color-pop 走 .inv-fpop 基础盒样式）。 */
  .inv-fbtn{border:1px solid var(--line);background:var(--panel);border-radius:8px;padding:4px 12px;font-size:12px;cursor:pointer;color:var(--ink2)}
  .inv-fbtn:hover{background:#f6f6f6}
  .inv-fbtn.act{background:var(--c-brand);color:var(--c-bg-elev);border-color:var(--c-brand)}
  .inv-fbtn:disabled{cursor:default;opacity:.5}
  .inv-fpop{position:absolute;top:calc(100% + 4px);left:0;z-index:50;min-width:150px;max-height:280px;overflow:auto;background:var(--panel);border:1px solid var(--line);border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,.12);padding:6px;display:none}
  .inv-fwrap.open .inv-fpop{display:block}
  .inv-fnone{font-size:12px;color:var(--ink3);padding:4px}
  .inv-color-wrap{position:relative;display:inline-block;margin-left:8px}
  .inv-color-wrap.open .inv-color-pop{display:block}
  .inv-color-pop{min-width:170px;right:0;left:auto}
  .inv-color-pop .inv-crow{display:flex;align-items:center;gap:8px;padding:2px 4px}
  .inv-color-pop .inv-crow .inv-clbl{font-size:12px;color:var(--ink);width:34px}
  .inv-color-pop .inv-crow input[type=color]{width:30px;height:22px;padding:0;border:1px solid var(--line);border-radius:4px;background:var(--panel);cursor:pointer}
  .inv-color-pop .inv-crow a.inv-creset{font-size:11.5px;color:var(--c-brand);cursor:pointer;text-decoration:none}
  /* Task 21：存储状态条（未保存=黄 / 已存档=绿 / —=默认） */
  .inv-arch-st{font-size:12px;margin:0 8px}
  .inv-arch-st.dirty{color:#E6A23C}
  .inv-arch-st.ok{color:#2BA471}
  `;
  const st = document.createElement('style'); st.id = 'inv-style'; st.textContent = css;
  document.head.appendChild(st);
}

function invSegHtml(id, opts, cur) {
  return `<span class="inv-seg" id="${id}">` +
    opts.map(o => `<button data-v="${o[0]}" class="${o[0] === cur ? 'on' : ''}">${o[1]}</button>`).join('') +
    `</span>`;
}

function invToolbarHtml() {
  const s = window.__sosim;
  return '<div class="inv-tool">' +
    // 发货表/成本表已改为从「数据源」看板设置的文件夹自动加载（invAutoLoadSources），此处不再放文件选择框。
    '<span class="grp"><span class="lbl">地理</span>' + invSegHtml('invGeoSeg', INV_GEO_OPTS, s.geoLevel) + '</span>' +
    '<span class="grp"><span class="lbl">产品</span>' + invSegHtml('invProdSeg', INV_PROD_OPTS, s.prodLevel) + '</span>' +
    '<span class="grp"><span class="lbl">粒度</span>' + invSegHtml('invGranSeg', INV_GRAN_OPTS, s.gran) + '</span>' +
    '<span class="grp"><span class="lbl">成本图</span>' + invSegHtml('invChartSeg', INV_CHART_OPTS, s.chartType) +
    '<span class="inv-fwrap inv-color-wrap" id="invColorWrap">' +
    '<button type="button" class="inv-fbtn" id="invColorBtn">图例颜色</button>' +
    '<div class="inv-fpop inv-color-pop"></div></span>' +
    '</span>' +
    '<label class="inv-chk grp" style="cursor:pointer"><input type="checkbox" id="invFillShip"' + (s.fillShipFromSellIn ? ' checked' : '') + '> 缺发货补SellIn</label>' +
    '<span class="inv-spacer"></span>' +
    '<span id="invArchiveStatus" class="inv-arch-st">—</span>' +
    '<button class="inv-btn" id="invArchiveBtn">保存到存档</button>' +
    '<button class="inv-btn" id="invRecalc">重算</button>' +
    '<button class="inv-btn" id="invExport">导出Excel</button>' +
    '<button class="inv-btn" id="invFullExportBtn">全量导出</button>' +
    '<button class="inv-btn" id="invDiagBtn" title="诊断发货表与PSI的型号/国家配对：找出有发货却整段没SO消耗的孤儿单元(老库存永远留存的根因)">配对诊断</button>' +
    '</div>';
}

/* 从「数据源」看板设置的持久化文件夹自动加载 发货表/成本表（经主进程 sosimSource 读最新文件 AOA）。
   渲染端解析仍用与原文件选择路径同款的 ShipmentBase.parseShipmentAoa / CostBase.parseCostAoa。
   全程 try/catch 包住：源未设置/读取失败时静默保持现有数据，不打断库存看板渲染。
   注：暴露到 window（window.invAutoLoadSources），供 app.js 的全局 refresh() 在刷新后复用。 */
async function invAutoLoadSources() {
  const s = window.__sosim; if (!s) return { ship: 0, cost: 0 };
  try {
    const src = await (window.sb && window.sb.sosimSource ? window.sb.sosimSource() : null);
    if (src && !src.error) {
      if (src.ship && src.ship.aoa) s.ship = window.ShipmentBase.parseShipmentAoa(src.ship.aoa) || [];
      if (src.cost && src.cost.aoa) s.cost = window.CostBase.parseCostAoa(src.cost.aoa);
    }
  } catch (e) { /* 源未设置/解析失败 → 保持现有数据，不打断渲染 */ }
  // 返回解析出的行数/SKU数,供全局 refresh() 提示用户"发货/成本表确实刷到了多少"。
  return { ship: (s.ship && s.ship.length) || 0, cost: (s.cost && s.cost.costMap && s.cost.costMap.size) || 0 };
}
window.invAutoLoadSources = invAutoLoadSources;

function wireInvToolbar() {
  const s = window.__sosim;
  const segBind = (id, key, after) => {
    const seg = document.getElementById(id); if (!seg) return;
    seg.querySelectorAll('button').forEach(b => b.onclick = () => {
      seg.querySelectorAll('button').forEach(x => x.classList.remove('on'));
      b.classList.add('on'); s[key] = b.dataset.v; invMarkDirty(); if (after) after();
    });
  };
  segBind('invGeoSeg', 'geoLevel', invRenderTables);
  segBind('invProdSeg', 'prodLevel', invRenderTables);
  segBind('invGranSeg', 'gran', invRenderTables);
  segBind('invChartSeg', 'chartType', invRenderTables);

  // 发货表/成本表文件选择框已移除：底表从「数据源」看板设置的文件夹经 invAutoLoadSources() 自动加载。

  // 「缺发货补SellIn」开关：开启后历史期缺失发货(0)用同期 Sell-in 补，避免全流程库存/DOS 为负。
  // 改的是底层取数口径 → 走全量 invRenderTables()。默认关。
  const fillChk = document.getElementById('invFillShip');
  if (fillChk) fillChk.onchange = () => { s.fillShipFromSellIn = !!fillChk.checked; invMarkDirty(); invRenderTables(); };

  const btn = (id, fn) => { const b = document.getElementById(id); if (b) b.onclick = fn; };
  // 重算：先重读数据源文件夹的发货/成本(主线 invAutoLoadSources),再重建上下文重渲 —— 与顶部全局↻一致地刷新数据源。
  btn('invRecalc', async () => { await invAutoLoadSources(); invRebuildCtx(); invRenderTables(); });
  // 「保存到存档」：立即落 localStorage（sb.sosim.v1 → archive.js 随后 ~1s 存盘）+ toast。
  btn('invArchiveBtn', () => { invArchiveSave(); if (typeof toast === 'function') toast('已保存到存档', 'ok'); });
  // 「导入Excel」已删除(2026-07 用户定):误选无 _forecast 表的文件会把预测 store 整个替换成空
  //   并随防抖自动存档固化 → 数据被打乱且当前版本存档不可恢复;且有跨版本存档后该功能无存在价值。
  btn('invExport', invExport);
  btn('invFullExportBtn', invFullExport);
  btn('invDiagBtn', invDiagPairing);

  // 「图例颜色」面板：点击切换开合（首开/重渲后填充），点击空白处由文档级监听关闭。
  const colorBtn = document.getElementById('invColorBtn');
  if (colorBtn) colorBtn.onclick = (ev) => {
    ev.stopPropagation();
    const wrap = document.getElementById('invColorWrap');
    if (!wrap) return;
    const wasOpen = wrap.classList.contains('open');
    // 关闭维度筛选条上可能打开的多选面板（.ms-panel），避免叠层——由共享 closeAllMs 接管
    if (typeof closeAllMs === 'function') closeAllMs();
    if (!wasOpen) { invFillColorPop(wrap.querySelector('.inv-color-pop')); wrap.classList.add('open'); }
    else wrap.classList.remove('open');
  };
}

/* 填充「图例颜色」面板：12 行(1月…12月)，每行一个 <input type="color"> + 「重置」。
   改色 → 更新 s.monthColors[月] → 存 localStorage → 轻量刷新图（invRefreshCharts）。 */
function invFillColorPop(pop) {
  if (!pop) return;
  const s = window.__sosim;
  if (!s.monthColors) s.monthColors = invLoadMonthColors();
  let html = '';
  for (let m = 1; m <= 12; m++) {
    const cur = (s.monthColors[String(m)] || invDefaultMonthColor(m));
    html += `<div class="inv-crow" data-m="${m}">` +
      `<span class="inv-clbl">${m}月</span>` +
      `<input type="color" value="${_invEsc(cur)}" data-m="${m}">` +
      `<a class="inv-creset" data-m="${m}">重置</a></div>`;
  }
  pop.innerHTML = html;
  pop.onclick = (ev) => ev.stopPropagation();   // 面板内点击不冒泡到文档（不误关）
  const applyColor = (m, hex) => {
    s.monthColors[String(m)] = hex;
    invSaveMonthColors(s.monthColors);
    invRefreshCharts();
  };
  pop.querySelectorAll('input[type=color]').forEach(inp => {
    const handler = () => applyColor(+inp.dataset.m, inp.value);
    inp.oninput = handler; inp.onchange = handler;   // 拖动实时(oninput)+落定(onchange)均刷新
  });
  pop.querySelectorAll('a.inv-creset').forEach(a => a.onclick = (ev) => {
    ev.stopPropagation();
    const m = +a.dataset.m, def = invDefaultMonthColor(m);
    const inp = pop.querySelector(`input[type=color][data-m="${m}"]`);
    if (inp) inp.value = def;
    applyColor(m, def);
  });
}

/* 轻量刷新所有成本图（不全量 invRenderTables）：对现有 s._chartBySi 实例按 scope 重算
   composition 并 setOption(...,true)。成本表未导入→无实例(占位)，跳过。 */
function invRefreshCharts() {
  const s = window.__sosim;
  if (!s || !s.ctx || !s._chartBySi || !s._scopes) return;
  s._scopes.forEach((sc, si) => {
    const ch = s._chartBySi[si];
    if (!ch) return;   // 成本表未导入/占位表无实例 → 跳过
    let comp = null;
    try { comp = invComputeComposition(sc.scope, s.range); } catch (e) { comp = null; }
    if (comp) { try { ch.setOption(invBuildChartOption(comp, s.chartType), true); } catch (e) { /* noop */ } }
  });
}

/* ============================================================
   维度值筛选条（第二行工具栏）—— 每维一个多选下拉，独立 AND 语义。
   distinct 值取自 ctx.units；ctx 未就绪 → 渲染禁用占位。每次数据/ctx 变化随
   invRenderTables 重渲以同步选项与计数。
   ============================================================ */
function invDistinctValues(dim) {
  const ctx = window.__sosim.ctx;
  if (!ctx) return [];
  return [...new Set(ctx.units.map(u => u[dim]).filter(v => v != null && v !== ''))]
    .sort((a, b) => String(a).localeCompare(String(b), 'zh-Hans-CN'));
}

/* ============================================================
   时间范围控件（Task 15）—— 跟随当前粒度：
     day            → 两个 <input type="date">（from/to），min/max 限定全幅边界
     week/month/quarter/year → 两个 <select>（桶标签，from/to）
     全部           → 重置 s.range = invDefaultRange(ctx)
   范围以 ymd 存（s.range），按粒度显示；粒度切换时 invRenderFilterBar 重渲，
   会用同一逻辑把当前 ymd 边界重新表达为新粒度的桶/日期（s.range 不丢）。
   ============================================================ */

/* ymd(int YYYYMMDD) → 'YYYY-MM-DD'（date input 的 value/min/max） */
function invYmdToDateStr(y) {
  return `${Math.floor(y / 10000)}-${String(Math.floor(y / 100) % 100).padStart(2, '0')}-${String(y % 100).padStart(2, '0')}`;
}
/* 'YYYY-MM-DD' → ymd(int)；解析失败返回 0 */
function invDateStrToYmd(s) {
  const m = String(s || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return 0;
  return (+m[1]) * 10000 + (+m[2]) * 100 + (+m[3]);
}
/* 全幅边界内、升序去重的桶标签列表（用 enumDays 逐日 bucketOf）。 */
function invBucketLabels(B, gran) {
  const S = window.SoSimCore;
  const seen = new Set(), out = [];
  S.enumDays(B.from, B.to).forEach(d => {
    const b = S.bucketOf(d, gran);
    if (!seen.has(b)) { seen.add(b); out.push(b); }
  });
  return out;
}

/* 生成时间范围控件 HTML（放在筛选条最前面）。调用方已确保 ctx 就绪。 */
function invRangeControlsHtml() {
  const s = window.__sosim, S = window.SoSimCore;
  const B = invDefaultRange(s.ctx);
  if (!s.range) s.range = { from: B.from, to: B.to };
  const gran = s.gran;
  let inner;
  if (gran === 'day') {
    const minS = invYmdToDateStr(B.from), maxS = invYmdToDateStr(B.to);
    const fromS = invYmdToDateStr(s.range.from), toS = invYmdToDateStr(s.range.to);
    inner =
      `<input type="date" class="inv-rdate" data-end="from" min="${minS}" max="${maxS}" value="${fromS}">` +
      `<span class="inv-rsep">~</span>` +
      `<input type="date" class="inv-rdate" data-end="to" min="${minS}" max="${maxS}" value="${toS}">`;
  } else {
    const labels = invBucketLabels(B, gran);
    const curFrom = S.bucketOf(s.range.from, gran);
    const curTo = S.bucketOf(s.range.to, gran);
    const opt = (sel) => labels.map(b => `<option value="${_invEsc(b)}"${b === sel ? ' selected' : ''}>${_invEsc(b)}</option>`).join('');
    inner =
      `<select class="inv-rsel" data-end="from">${opt(curFrom)}</select>` +
      `<span class="inv-rsep">~</span>` +
      `<select class="inv-rsel" data-end="to">${opt(curTo)}</select>`;
  }
  return `<span class="lbl">时间范围</span><span class="inv-range">${inner}` +
    `<button type="button" class="inv-fbtn inv-rall">全部</button></span>`;
}

/* 绑定时间范围控件的 change：映射→ymd、clamp（from≤to 且落入全幅边界）、写 s.range、重渲。 */
function invBindRangeControls(host) {
  const s = window.__sosim, S = window.SoSimCore;
  const wrap = host.querySelector('.inv-range');
  if (!wrap) return;
  const B = invDefaultRange(s.ctx);
  const clampApply = (newFrom, newTo) => {
    if (newFrom > newTo) { const t = newFrom; newFrom = newTo; newTo = t; }   // 防倒置（空表）
    newFrom = Math.max(B.from, Math.min(B.to, newFrom));                       // clamp 进全幅边界
    newTo = Math.max(B.from, Math.min(B.to, newTo));
    s.range = { from: newFrom, to: newTo };
    invMarkDirty();
    invRenderTables();
  };
  if (s.gran === 'day') {
    wrap.querySelectorAll('input.inv-rdate').forEach(inp => {
      inp.onchange = () => {
        const fromEl = wrap.querySelector('input[data-end="from"]');
        const toEl = wrap.querySelector('input[data-end="to"]');
        const nf = invDateStrToYmd(fromEl && fromEl.value) || s.range.from;
        const nt = invDateStrToYmd(toEl && toEl.value) || s.range.to;
        clampApply(nf, nt);
      };
    });
  } else {
    wrap.querySelectorAll('select.inv-rsel').forEach(sel => {
      sel.onchange = () => {
        const fromEl = wrap.querySelector('select[data-end="from"]');
        const toEl = wrap.querySelector('select[data-end="to"]');
        const nf = invBucketRange(fromEl && fromEl.value, s.gran)[0] || s.range.from;
        const nt = invBucketRange(toEl && toEl.value, s.gran)[1] || s.range.to;
        clampApply(nf, nt);
      };
    });
  }
  const allBtn = wrap.querySelector('.inv-rall');
  if (allBtn) allBtn.onclick = () => { s.range = invDefaultRange(s.ctx); invMarkDirty(); invRenderTables(); };
}

function invRenderFilterBar() {
  const host = document.getElementById('invFilter');
  if (!host) return;
  const s = window.__sosim, ctx = s.ctx;
  const filters = s.filters || (s.filters = {});
  if (!ctx) {
    host.innerHTML = '<span class="lbl">筛选</span><span class="inv-fnone" style="color:var(--ink3);font-size:12px">加载数据后可用</span>';
    return;
  }
  // 时间范围控件（最前面，跟随当前粒度）——保留原生控件不动
  host.innerHTML = invRangeControlsHtml() + '<span class="lbl">筛选</span>';
  invBindRangeControls(host);
  // 7 维多选统一用共享 makeMultiSelect（标签+浮层+搜索+全选/清空）。
  // 语义保留「每勾即刷」：用 onChange 即提交（每勾一次立即 markDirty + 只刷表体，筛选条不重建
  //  → .ms 面板保持打开，可连续多选）。distinct 值不随其它维收窄（无级联），故用静态选项即可。
  INV_FILTER_DIMS.forEach(([dim, label]) => {
    const ms = makeMultiSelect(label, invDistinctValues(dim), filters[dim] || [], {
      placeholder: '全部',
      onChange: arr => {
        if (arr && arr.length) filters[dim] = arr.slice(); else delete filters[dim];
        invMarkDirty();
        invRenderTablesBody();   // 只刷表/图，不重建筛选条（保持面板打开态）
      },
    });
    ms.classList.add('inv-ms');
    host.appendChild(ms);
  });
}

// 点击空白处关闭「图例颜色」面板（只注册一次）。维度筛选面板的空白关闭由 common.js 的
// closeAllMs（.ms-panel 文档级监听）接管，此处只管工具条上的颜色面板。
if (!window._invFilterDocBound) {
  window._invFilterDocBound = true;
  document.addEventListener('click', () => {
    const cw = document.getElementById('invColorWrap');
    if (cw) cw.classList.remove('open');
  });
}

/* ============================================================
   数据缝：取 PSI 单元级行（country×model×day 的 sellIn/sellOut/inv + 维度层级）
   —— 本架构下渲染层无法直接读立方，故走专用 IPC。Task 10 在主进程提供 api.psiUnits。
   返回：Promise<[{region,rep,country,line,family,series,model,ymd,sellIn,sellOut,inv}]> | null
   ============================================================ */
async function invFetchPsiUnits() {
  if (window.sb && typeof window.sb.psiUnits === 'function') {
    try { const rows = await window.sb.psiUnits(); return Array.isArray(rows) ? rows : null; }
    catch (e) { return null; }
  }
  return null;   // 主进程未提供该 IPC —— 提示用户/等待 Task 10 接线
}

/* ============================================================
   Step 2: invRebuildCtx —— 从 PSI(单元行) + 发货 构建 units/actual/histSO/cutoff
   注：原 brief 直接遍历 state.engine.store；本架构改为消费 invFetchPsiUnits() 的行，
   字段语义一一对应（region/rep/country/line/family/series/model + ymd + sellIn/sellOut/inv）。
   异步：拿到 PSI 行后再重渲一次表。
   ============================================================ */
function invBuildCtxFromRows(psiRows) {
  const S = window.SoSimCore;
  const unitMap = new Map();   // unitKey -> unit dims
  const actual = new Map();    // skey -> value
  const histSO = new Map();    // unitKey -> 累计实际 SO（用于拆分比例）
  let cutoffYmd = 0;
  // ★发货↔PSI 型号/国家 归一化配对（治"老库存永不消耗"根因）：
  //   发货表型号/国家名 与 PSI 名 只要差全角空格/大小写/后缀空白，unitKey 就配不上 → 发货成孤儿 → 那批货永远没 SO 消耗、老月份一直留在库存底部。
  //   修法：PSI 先按"归一化身份"登记规范名(PSI名为准；PSI 之间绝不互相合并)；发货按归一化身份 snap 到已存在的 PSI 规范单元，
  //   找不到匹配才用发货自己的原名自建(真·纯发货品，如 PSI 没 SO 的机型)。仅影响配对键，不改任何数值/显示口径。
  const canonId = (c, m) => S.normId(c) + S.SEP + S.normId(m);
  const psiCanon = new Map();   // normId -> {country, model}（首个 PSI 为准）

  (psiRows || []).forEach(r => {
    const country = r.country, model = r.model;
    if (!country || !model) return;
    const ymd = +r.ymd; if (!ymd) return;
    const id = canonId(country, model); if (!psiCanon.has(id)) psiCanon.set(id, { country: country, model: model });
    const uk = S.unitKey(country, model);
    if (!unitMap.has(uk)) unitMap.set(uk, {
      region: r.region || '', rep: r.rep || '', country: country,
      line: r.line || '', family: r.family || '', series: r.series || '', model: model,
    });
    const so = +r.sellOut || 0, si = +r.sellIn || 0, iv = +r.inv || 0;
    const kSO = S.skey(country, model, ymd, 'sellOut'), kSI = S.skey(country, model, ymd, 'sellIn'), kIV = S.skey(country, model, ymd, 'inv');
    actual.set(kSO, (actual.get(kSO) || 0) + so);
    actual.set(kSI, (actual.get(kSI) || 0) + si);
    actual.set(kIV, (actual.get(kIV) || 0) + iv);   // 同期多行库存求和（与引擎 snapshot 求和口径一致）
    histSO.set(uk, (histSO.get(uk) || 0) + so);
    if (ymd > cutoffYmd) cutoffYmd = ymd;
  });

  // 叠加发货表为 actual.shipment（按天）：先按归一化身份 snap 到 PSI 规范单元，配不上才用原名自建。
  window.__sosim.ship.forEach(r => {
    const cn = psiCanon.get(canonId(r.country, r.model)) || { country: r.country, model: r.model };
    const country = cn.country, model = cn.model;
    const uk = S.unitKey(country, model);
    if (!unitMap.has(uk)) unitMap.set(uk, { region: '', rep: '', country: country, line: '', family: r.family || '', series: r.series || '', model: model });
    const k = S.skey(country, model, r.ymd, 'shipment');
    actual.set(k, (actual.get(k) || 0) + (+r.qty || 0));
    if (r.ymd > cutoffYmd) cutoffYmd = r.ymd;   // 发货数据通常都是历史，纳入 cutoff
  });

  // 用 PSI 的 国家→region/rep 回填「发货-only」units
  const geo = {}; unitMap.forEach(u => { if (u.region) geo[u.country] = { region: u.region, rep: u.rep }; });
  unitMap.forEach(u => { if (!u.region && geo[u.country]) { u.region = geo[u.country].region; u.rep = geo[u.country].rep; } });

  window.__sosim.ctx = { actual, cutoffYmd, units: [...unitMap.values()], histSO };
  // 默认时间范围：覆盖 [最早数据, cutoff 之后 +12 个月]
  if (!window.__sosim.range) window.__sosim.range = invDefaultRange(window.__sosim.ctx);
}

// 库存 __sosim(ctx/store/cost/range)重建后广播,供销毛推演等下游看板实时跟刷(它们监听此事件重渲)。
function invEmitSosimChanged() { try { document.dispatchEvent(new Event('sb:sosim-updated')); } catch (_) {} }

function invRebuildCtx() {
  if (!window.__sosim) return;   // 看板从未打开(__sosim 未初始化)→ 无需重建;修复 loadSample/refresh 时异步崩 "reading 'ship'"
  const tbl = document.getElementById('invTables');
  // 同步先给个占位；异步取 PSI 行后构建 ctx 再重渲
  invFetchPsiUnits().then(rows => {
    if (rows == null) {
      window.__sosim.ctx = null;
      invRenderFilterBar();   // ctx 缺失 → 渲染禁用占位筛选条
      if (tbl) tbl.innerHTML = '<div class="inv-empty">请先在「数据源」加载 PSI 数据（并由主进程提供 <code>api.psiUnits</code> 接口）。' +
        '<br>当前渲染层未取到 PSI 单元级数据：本应用 PSI 立方只在主进程，渲染层需经 IPC <code>psiUnits</code> 取行（见 task-9 报告）。</div>';
      return;
    }
    invBuildCtxFromRows(rows);
    invRenderTables();
    invEmitSosimChanged();   // 库存重建完成 → 通知销毛看板跟刷
  });
}

/* 生命周期起点 = 最早数据日（ctx.actual 最小 ymd，含 PSI 与发货）。缓存到 ctx._minYmd，避免每张表重扫。
   ★库存/成本是累计量，必须从这里开始算，时间范围只是显示窗口 —— 否则 range 之前已发的货会被漏掉。 */
function invLifecycleStart(ctx) {
  if (ctx._minYmd) return ctx._minYmd;
  const S = window.SoSimCore;
  let minY = 0;
  ctx.actual.forEach((_v, k) => { const y = +k.split(S.SEP)[2]; if (y && (!minY || y < minY)) minY = y; });
  ctx._minYmd = minY || ctx.cutoffYmd || 20240101;
  return ctx._minYmd;
}

/* 默认时间范围：最早数据日 ~ cutoff 之后 +12 个月末 */
function invDefaultRange(ctx) {
  const S = window.SoSimCore;
  const minY = invLifecycleStart(ctx);
  const cut = ctx.cutoffYmd || minY || 20240101;
  // cutoff 之后 +12 个月
  const ym = S.ymdToYm(cut);
  let y = Math.floor(ym / 100), m = ym % 100;
  m += 12; while (m > 12) { m -= 12; y++; }
  const lastDay = S.daysInYm(y * 100 + m);
  const to = y * 10000 + m * 100 + lastDay;
  return { from: minY, to: to };
}

/* ============================================================
   Step 3: 表清单（地理×产品 笛卡尔积）+ 单表计算
   ============================================================ */
function invListScopes() {
  const s = window.__sosim, S = window.SoSimCore, ctx = s.ctx;
  const geoField = s.geoLevel, prodField = s.prodLevel;
  const filters = s.filters || {};
  const matches = u => Object.keys(filters).every(dim => { const set = filters[dim]; return !set || !set.length || set.indexOf(u[dim]) >= 0; });
  const fu = ctx.units.filter(matches);
  const geos = [...new Set(fu.map(u => u[geoField]).filter(Boolean))];
  const prods = [...new Set(fu.map(u => u[prodField]).filter(Boolean))];
  const carry = {}; Object.keys(filters).forEach(dim => { if (dim !== geoField && dim !== prodField && filters[dim] && filters[dim].length) carry[dim] = filters[dim]; });
  const scopes = [];
  geos.forEach(g => prods.forEach(p => {
    const scope = Object.assign({}, carry); scope[geoField] = g; scope[prodField] = p;
    if (S.childrenInScope(ctx.units, scope).length) scopes.push({ title: g + ' · ' + p, scope, geoField, prodField });
  }));
  // Task 22：在最前面置顶一张「汇总（当前筛选）」scope —— 把所有活跃筛选当成一个整体（不按 geoField/prodField 拆），
  // 合成一张汇总进销存表 + 汇总成本图。它随 render/update/export 一起走（si=0、可编辑、可成图、可导航）；
  // 在汇总层拍数 → onCellEdit→setForecast 会按历史 SO 占比拆到 childrenInScope(sumScope)=全部筛选后的最细单元。
  // 仅当有子单元时才置顶（无筛选/空筛选时 sumScope={} 即全集，仍会有子；空数据则不加）。
  const sumScope = {};
  Object.keys(filters).forEach(dim => { if (filters[dim] && filters[dim].length) sumScope[dim] = filters[dim]; });
  if (S.childrenInScope(ctx.units, sumScope).length) {
    scopes.unshift({ title: '汇总（当前筛选）', scope: sumScope, geoField, prodField, isSummary: true });
  }
  return scopes;
}

/* 某 unit 某天的「有效发货」：缺历史发货(0)时可用同期 Sell-in 补。
   - 开关 s.fillShipFromSellIn 开启 且 d 为历史期(d<=cutoff) 且 当天发货缺失(!sh) → 用同期 sellIn(若有)。
   - 未来期(d>cutoff)不补,保留用户拍的预测发货;真实发货存在则不覆盖;只影响 shipment。
   invComputeTable 与 invComputeComposition 统一经此读取 unit-day 发货,保证口径一致。 */
function invEffShip(ctx, store, u, d) {
  const s = window.__sosim;
  let sh = SoSimCore.unitValueAt(ctx, store, u, d, 'shipment');
  if (s.fillShipFromSellIn && d <= ctx.cutoffYmd && !sh) {
    const si = SoSimCore.unitValueAt(ctx, store, u, d, 'sellIn');
    if (si) sh = si;
  }
  return sh;
}

function invComputeTable(scope, range) {
  const s = window.__sosim, S = window.SoSimCore, C = window.SoSimCalc, ctx = s.ctx;
  const units = S.childrenInScope(ctx.units, scope);
  // ★从生命周期起点算到 range 末（库存/成本/约束都是累计量），range 只做显示窗口。
  //   不能从 range.from 起算，否则 range 之前已发的货被漏掉 → 库存随 range 变化、虚低。
  const computeFrom = Math.min(invLifecycleStart(ctx), range.from);
  const days = S.enumDays(computeFrom, range.to);
  // 合并 actual+forecast → 每日 Map（scope 汇总）
  const sum = (metric) => {
    const m = new Map();
    units.forEach(u => days.forEach(dd => {
      const v = S.unitValueAt(ctx, s.store, u, dd, metric);
      if (v) m.set(dd, (m.get(dd) || 0) + v);
    }));
    return m;
  };
  // 发货量经 invEffShip 取(缺历史发货可用 Sell-in 补,见开关);sellIn/sellOut 仍走原始取数。
  const ship = (() => {
    const m = new Map();
    units.forEach(u => days.forEach(dd => {
      const v = invEffShip(ctx, s.store, u, dd);
      if (v) m.set(dd, (m.get(dd) || 0) + v);
    }));
    return m;
  })();
  const sellIn = sum('sellIn'), sellOut = sum('sellOut');
  const invActual = new Map();
  days.forEach(dd => { let iv = 0; units.forEach(u => { iv += (ctx.actual.get(S.skey(u.country, u.model, dd, 'inv')) || 0); }); if (iv) invActual.set(dd, iv); });
  // ★全流程库存=作用域「池化 FIFO 剩余」(pooledFifo):所选范围的总发货进同一条队列,被总 SO 按先进先出
  //   消耗,永不为负 —— 与下方成本成分图**同一条队列**完全同源(图的 total 每桶=本行)。
  //   (原 per-unit 各自 FIFO 求和会让"自身SO不足"单元的零星老发货永久残留,与用户"汇总口径下
  //    总SO早该消耗完"的判断不符 —— 2026-07 用户定为池化。超卖仍不为负,fifoRemaining 保留引擎供导出。)
  const perUnitFifo = units.map(u => {
    const uShip = new Map(), uSO = new Map();
    days.forEach(dd => {
      const sh = invEffShip(ctx, s.store, u, dd); if (sh) uShip.set(dd, sh);
      const so = S.unitValueAt(ctx, s.store, u, dd, 'sellOut'); if (so) uSO.set(dd, so);
    });
    return { ship: uShip, sellOut: uSO };
  });
  const fullByDay = C.pooledFifo({ perUnit: perUnitFifo, days, gran: s.gran }).remainByDay;
  const inv = C.computeInventory({ days, ship, sellIn, sellOut, invActual, cutoffYmd: ctx.cutoffYmd });
  const allRows = C.bucketRows({ days, gran: s.gran, ship, sellIn, sellOut, channelInv: inv.channelInv, fullInv: fullByDay });
  const flags = C.constraintFlags({ days, ship, sellIn, sellOut });   // 累计量从生命周期起点算（标红口径也随之正确）
  // 只显示 range 内的桶（库存值已含 range 之前的累计发货/SO）。
  const firstB = S.bucketOf(range.from, s.gran);
  const rows = allRows.filter(r => String(r.bucket) >= firstB);
  return { rows, flags, days };
}

/* 桶 key（SoSimCore.bucketOf 产出）→ [fromYmd, toYmd]，供未来格编辑写 forecast 用 */
function invBucketRange(bucket, gran) {
  const S = window.SoSimCore;
  if (gran === 'day') { const y = +bucket; return [y, y]; }
  if (gran === 'month') { const ym = +bucket; const y = Math.floor(ym / 100), m = ym % 100; return [y * 10000 + m * 100 + 1, y * 10000 + m * 100 + S.daysInYm(ym)]; }
  if (gran === 'year') { const y = +bucket; return [y * 10000 + 101, y * 10000 + 1231]; }
  if (gran === 'quarter') {
    const m = String(bucket).match(/^(\d{4})Q([1-4])$/); if (!m) return [0, 0];
    const y = +m[1], q = +m[2], m0 = (q - 1) * 3 + 1;
    const lastM = m0 + 2;
    return [y * 10000 + m0 * 100 + 1, y * 10000 + lastM * 100 + S.daysInYm(y * 100 + lastM)];
  }
  if (gran === 'week') {
    // bucket 形如 "YYYY-Www"（ISO 周）；反推该 ISO 周的周一~周日。
    const m = String(bucket).match(/^(\d{4})-W(\d{1,2})$/); if (!m) return [0, 0];
    const y = +m[1], w = +m[2];
    // ISO：第 1 周含该年第一个周四；取 1 月 4 日所在周的周一为基准
    const jan4 = new Date(Date.UTC(y, 0, 4));
    const jan4Dow = (jan4.getUTCDay() + 6) % 7;      // Mon=0
    const week1Mon = new Date(jan4.getTime() - jan4Dow * 86400000);
    const mon = new Date(week1Mon.getTime() + (w - 1) * 7 * 86400000);
    const sun = new Date(mon.getTime() + 6 * 86400000);
    const f = mon.getUTCFullYear() * 10000 + (mon.getUTCMonth() + 1) * 100 + mon.getUTCDate();
    const t = sun.getUTCFullYear() * 10000 + (sun.getUTCMonth() + 1) * 100 + sun.getUTCDate();
    return [f, t];
  }
  return [0, 0];
}

/* 桶是否「未来」（可编辑）：桶起始日 > cutoff */
function invBucketIsFuture(bucket, gran, cutoffYmd) {
  const r = invBucketRange(bucket, gran);
  return r[0] > cutoffYmd;
}

/* 取某桶代表 flag（桶内最后一个有 flag 的日；约束是累计判定，取桶末日代表）。
   全量建表与增量更新共用，保证两条路径标红规则完全一致。 */
function invBucketFlag(flags, bucket, gran) {
  const rng = invBucketRange(bucket, gran);
  for (let d = rng[1]; d >= rng[0]; d--) { if (flags.has(d)) return flags.get(d); }
  return { overSI: false, overShip: false };
}

/* ============================================================
   Step 3 (cont.): invRenderTables —— 渲染所有 scope 的进销存表
   ============================================================ */
const INV_ROW_DEFS = [
  ['发货量', 'ship', 'flow'], ['Sell In', 'sellIn', 'flow'], ['Sell Out', 'sellOut', 'flow'],
  ['渠道库存', 'channelInv', 'inv'], ['渠道DOS', 'channelDOS', 'dos'],
  ['全流程库存', 'fullInv', 'inv'], ['全流程DOS', 'fullDOS', 'dos'],
];
const INV_EDITABLE = { ship: 'shipment', sellIn: 'sellIn', sellOut: 'sellOut' };   // 行 key → forecast metric

function invFmtCell(kind, v) {
  if (v == null || isNaN(v)) return '0';
  return Math.round(v).toLocaleString('en-US');   // 库存/DOS 一律取整(DOS 不带小数)
}

/* 标红规则的唯一来源（全量建表 + 增量更新共用）：
   Sell Out 行在 overSI/overShip 时标红；Sell In 行在 overSI 时；发货行在 overShip 时。 */
function invCellOver(key, fl) {
  if (!fl) return false;
  if (key === 'sellOut') return !!(fl.overSI || fl.overShip);
  if (key === 'sellIn') return !!fl.overSI;
  if (key === 'ship') return !!fl.overShip;
  return false;
}

function invRenderTables() {
  const host = document.getElementById('invTables');
  if (!host) return;
  const s = window.__sosim;
  if (!s.ctx) { invRebuildCtx(); return; }   // 触发异步取数；ctx 就绪后会自回调重渲
  invRenderFilterBar();   // 数据/粒度/作用域变化时重建筛选条（时间范围控件跟随粒度）
  invRenderTablesBody();
}

/* 只重渲表/图（不重建筛选条）——供筛选「每勾即刷」用：筛选是持久 .ms 组件，其面板要保持
   打开态供连续多选，故勾选后只刷表体，别把筛选条整条重建（否则面板会被关掉）。 */
function invRenderTablesBody() {
  const host = document.getElementById('invTables');
  if (!host) return;
  const s = window.__sosim;
  if (!s.ctx) { invRebuildCtx(); return; }
  if (!s.range) s.range = invDefaultRange(s.ctx);
  // 重建 innerHTML 之前先 dispose 上一轮 ECharts 实例，防泄漏
  (s._charts || []).forEach(c => { try { c.dispose(); } catch (e) { /* noop */ } });
  s._charts = [];
  const allScopes = invListScopes();
  if (!allScopes.length) { host.innerHTML = '<div class="inv-empty">当前维度组合 / 筛选下没有可显示的进销存表。</div>'; s._scopes = []; return; }
  // 性能软上限：只裁明细表，汇总表（Task 22，置顶第 0 张 isSummary）始终保留、不计入上限。
  // 即：保留第 0 张汇总（若有）+ 其后前 INV_MAX_TABLES 张明细。
  const hasSum = allScopes.length > 0 && allScopes[0].isSummary;
  const detail = hasSum ? allScopes.slice(1) : allScopes;
  const capped = detail.length > INV_MAX_TABLES;
  const scopes = capped
    ? (hasSum ? [allScopes[0]].concat(detail.slice(0, INV_MAX_TABLES)) : detail.slice(0, INV_MAX_TABLES))
    : allScopes;

  let html = '';
  if (capped) {
    html += `<div class="inv-empty" style="padding:10px 4px;color:var(--c-brand)">共 ${detail.length} 张明细表，已显示前 ${INV_MAX_TABLES} 张（汇总表始终显示），请用上方筛选缩小范围。</div>`;
  }
  scopes.forEach((sc, si) => {
    const t = invComputeTable(sc.scope, s.range);
    const buckets = t.rows.map(r => r.bucket);
    sc._nCols = buckets.length;   // 缓存列数（桶数），供键盘左右导航边界扫描快速路径
    // 每桶是否未来 / 是否违约（共用模块级 helper，与增量更新口径一致）
    const futOf = b => invBucketIsFuture(b, s.gran, s.ctx.cutoffYmd);
    const flagOf = b => invBucketFlag(t.flags, b, s.gran);

    // 表头
    let thead = '<tr><th>口径 \\ 期</th>' + buckets.map(b => `<th>${_invEsc(b)}</th>`).join('') + '</tr>';
    // 各口径行
    let tbody = '';
    INV_ROW_DEFS.forEach((rd, ri) => {
      const [label, key, kind] = rd;
      const editMetric = INV_EDITABLE[key];
      let tr = `<tr><td>${_invEsc(label)}</td>`;
      t.rows.forEach((row, bi) => {
        const b = row.bucket, val = row[key], fut = futOf(b);
        const fl = flagOf(b);
        // 标红：Sell Out 行在 overSI/overShip 时标红；Sell In 行在 overSI 时；发货行在 overShip 时。
        const over = invCellOver(key, fl);
        const cls = (fut ? 'fut' : '') + (over ? ' over' : '');
        // 每格 <td> 给稳定 id（invTd-si-key-bi）以便增量切 fut/over 类
        const tdId = `invTd-${si}-${key}-${bi}`;
        // Task 19：每个数据 <td> 带可定位坐标(si/ri/bi)+原始值(data-val)，供多选求和/平均（不依赖显示格式）。
        const selAttr = `data-si="${si}" data-ri="${ri}" data-bi="${bi}" data-val="${invSelRawVal(val)}"`;
        if (fut && editMetric) {
          const rng = invBucketRange(b, s.gran);
          // 可编辑 input 给稳定 id（invIn-si-key-bi）+ data-bi/data-key，供增量 patch 与键盘导航定位
          tr += `<td id="${tdId}" class="${cls}" ${selAttr}><input id="invIn-${si}-${key}-${bi}" class="inv-cell" type="number" step="any" ` +
            `value="${invFmtCellRaw(val)}" data-si="${si}" data-key="${key}" data-bi="${bi}" ` +
            `data-metric="${editMetric}" data-from="${rng[0]}" data-to="${rng[1]}"></td>`;
        } else {
          // computed 格：数值包进 span（invCell-si-key-bi）以便增量改 textContent
          tr += `<td id="${tdId}" class="${cls}" ${selAttr}><span id="invCell-${si}-${key}-${bi}">${invFmtCell(kind, val)}</span></td>`;
        }
      });
      tr += '</tr>';
      tbody += tr;
    });
    // Task 22：汇总表（isSummary）视觉区分 —— .inv-card-sum 强调底色/边框 + 标题前缀「⊕ 汇总」。
    const cardCls = sc.isSummary ? 'inv-card inv-card-sum' : 'inv-card';
    const h4 = sc.isSummary ? ('⊕ 汇总 · ' + _invEsc(sc.title)) : _invEsc(sc.title);
    html += `<div class="${cardCls}"><h4>${h4}</h4>` +
      `<table class="inv-t"><thead>${thead}</thead><tbody>${tbody}</tbody></table>` +
      `<div class="inv-chart" id="invChart-${si}" style="height:300px;padding:4px 0 10px"></div></div>`;   // 300px=柱区(196,同原240时)+顶部加权成本带
  });
  host.innerHTML = html;
  // 缓存本次 scope 列表（编辑回调用 data-si 索引取 scope）
  s._scopes = scopes;
  // Task 19：全量重建 DOM 后坐标可能失效 → 清空选区并隐藏状态栏（增量更新路径不走这里，不会误清）。
  invSelClear();
  // 每表下方成本成分图：成本表缺失 → 占位文案；否则 init ECharts 并入 _charts 防泄漏
  invRenderCharts(scopes);
  // 绑定未来格编辑
  host.querySelectorAll('input.inv-cell').forEach(inp => {
    inp.onchange = () => {
      const sc = s._scopes[+inp.dataset.si];
      if (!sc) return;
      onCellEdit(sc.scope, inp.dataset.metric, +inp.dataset.from, +inp.dataset.to, inp.value);
    };
  });
  // Excel 式键盘导航 + 滚动跟随：委托在 #invTables 上，只注册一次（host 持久存在，
  // innerHTML 重建不换节点，故委托监听不会丢/不会叠加）。
  invBindCellNav(host);
  // Task 19：多选交互（拖选/Shift/Ctrl）委托在 #invTables 上，同样只注册一次。
  invBindCellSel(host);
  // Excel 批量粘贴(2026-07 用户要)：从 Excel 复制一行/一列/矩形,在任一可编辑格 Ctrl+V 整片铺开。
  invBindCellPaste(host);
}

/* ============================================================
   Excel 批量粘贴（委托在 #invTables 上，只注册一次，仅对 input.inv-cell）
   Excel 复制到剪贴板的是 TSV：\t 分列、\n 分行。以当前聚焦格为锚点：
   · 列向右 = 后续月份桶(bi+1, bi+2, …)；行向下 = 后续可编辑指标行(发货→Sell In→Sell Out)。
   · 只写"未来可编辑格"(有输入框的格)；历史桶/越界/非数值一律跳过不写(计数提示)。
   · 空单元格(Excel 里的空格子)跳过、保留看板现值 —— 不会被清成 0。
   · 全部写完只重算一次(invUpdateAll)并标脏(防抖自动存档),批量粘贴不卡。
   ============================================================ */
function invBindCellPaste(host) {
  if (host._invPasteBound) return;   // 委托只绑一次
  host._invPasteBound = true;
  host.addEventListener('paste', (e) => {
    const inp = e.target;
    if (!inp || !inp.classList || !inp.classList.contains('inv-cell')) return;
    const cd = e.clipboardData || window.clipboardData;
    const text = cd && cd.getData ? cd.getData('text') : null;
    if (text == null || text === '') return;   // 无文本 → 交回默认行为
    e.preventDefault();
    const S = window.SoSimCore, s = window.__sosim;
    const grid = S.parseClipGrid(text);
    if (!grid.length) return;
    const si = +inp.dataset.si, bi0 = +inp.dataset.bi;
    const ri0 = INV_EDIT_KEYS.indexOf(inp.dataset.key);
    const sc = s._scopes && s._scopes[si];
    if (!sc || ri0 < 0) return;
    let wrote = 0, skipped = 0;
    grid.forEach((rowVals, dr) => {
      const key = INV_EDIT_KEYS[ri0 + dr];   // 超出可编辑行(发货/SI/SO 共3行) → 整行跳过
      rowVals.forEach((v, dc) => {
        const n = S.parseCellNum(v);
        if (n == null) { if (String(v).trim() !== '') skipped++; return; }   // 空格子静默跳过;非数值计入跳过
        const el = key ? invCellEl(si, key, bi0 + dc) : null;
        if (!el) { skipped++; return; }        // 历史桶(无输入框)/列越界/行越界
        el.value = n;
        window.SoSimCore.setForecast(s.store, {
          scope: sc.scope, metric: el.dataset.metric,
          fromYmd: +el.dataset.from, toYmd: +el.dataset.to,
          value: n, units: s.ctx.units, histSO: s.ctx.histSO,
        });
        wrote++;
      });
    });
    if (wrote) { invMarkDirty(); invUpdateAll(); if (typeof invEmitSosimChanged === 'function') invEmitSosimChanged(); }
    if (typeof toast === 'function') {
      if (wrote) toast('已粘贴 ' + wrote + ' 格' + (skipped ? '（跳过 ' + skipped + ' 格：历史期/越界/非数值）' : ''), 'ok');
      else toast('没有可写入的格（目标须是未来期的 发货/Sell In/Sell Out 输入格）', 'err');
    }
  });
}

/* ============================================================
   Excel 式键盘导航 + 滚动跟随（委托在 #invTables 上，仅对 input.inv-cell）
   网格：每表(si)内 行=可编辑指标顺序(发货→SI→SO，即 INV_EDITABLE 出现的行) × 列=未来桶(bi)。
   用 data-si/data-key/data-bi 定位；用 DOM 文档序构成 Tab 链。
   ============================================================ */
const INV_EDIT_KEYS = INV_ROW_DEFS.filter(rd => INV_EDITABLE[rd[1]]).map(rd => rd[1]);   // ['ship','sellIn','sellOut']

/* 取某框元素（不存在返回 null） */
function invCellEl(si, key, bi) { return document.getElementById(`invIn-${si}-${key}-${bi}`); }

/* 全部可编辑框（文档序）= Tab 链 */
function invAllCells(host) { return Array.prototype.slice.call(host.querySelectorAll('input.inv-cell')); }

/* 聚焦目标框：focus + 全选（像 Excel 选中整格）+ 滚动到可见（nearest，避免过度滚动） */
function invFocusCell(el) {
  if (!el) return;
  el.focus();
  try { el.select(); } catch (e) { /* number input 某些浏览器 select 抛错，忽略 */ }
  el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

/* 同表(si)、同列(bi)，沿可编辑行序(INV_EDIT_KEYS)上/下找存在的框；dir=-1 上,+1 下 */
function invVerticalCell(si, key, bi, dir) {
  let ri = INV_EDIT_KEYS.indexOf(key);
  if (ri < 0) return null;
  for (ri += dir; ri >= 0 && ri < INV_EDIT_KEYS.length; ri += dir) {
    const el = invCellEl(si, INV_EDIT_KEYS[ri], bi);
    if (el) return el;
  }
  return null;
}

/* 同行(si,key)，沿 bi 左/右找相邻存在的框；dir=-1 左,+1 右 */
function invHorizontalCell(si, key, bi, dir) {
  // 未来桶在该行可能不连续（理论上连续，但稳妥起见扫到表内最大 bi）
  const max = invRowMaxBi(si, key);
  for (let j = bi + dir; j >= 0 && j <= max; j += dir) {
    const el = invCellEl(si, key, j);
    if (el) return el;
  }
  return null;
}

/* 该行(si,key)内最大 bi（用于左右扫描边界）。基于已渲染的 td id 反查最大列。 */
function invRowMaxBi(si, key) {
  const sc = window.__sosim && window.__sosim._scopes && window.__sosim._scopes[si];
  // 列数 = 该 scope 当前桶数；无缓存则回退一个足够大的上界扫描
  if (sc && sc._nCols != null) return sc._nCols - 1;
  // 回退：从 DOM 探测（用 td id），最多到 2000 桶（远超软上限实际列数）
  let max = -1;
  for (let j = 0; j < 2000; j++) { if (document.getElementById(`invTd-${si}-${key}-${j}`)) max = j; else if (max >= 0) break; }
  return max;
}

function invBindCellNav(host) {
  if (host._invNavBound) return;   // 委托只绑一次
  host._invNavBound = true;

  // 滚动跟随：任意可编辑框获焦 → 滚动到可见（nearest）
  host.addEventListener('focusin', (ev) => {
    const el = ev.target;
    if (el && el.classList && el.classList.contains('inv-cell')) {
      el._iv = el.value;   // 记录获焦时的值：导航时据此判断是否真改了（没改就不提交/不重算，省性能）
      el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
  });

  host.addEventListener('keydown', (ev) => {
    const el = ev.target;
    if (!el || !el.classList || !el.classList.contains('inv-cell')) return;
    const si = +el.dataset.si, key = el.dataset.key, bi = +el.dataset.bi;
    let target = null;   // 目标框（找不到=链端/网格边）
    let nav = false;     // 本次按键是否构成「离格导航」（决定是否提交当前框）

    switch (ev.key) {
      case 'Tab': {
        // 文档序下一个/上一个可编辑框（自然跨行/跨表）；到链尾/链首则停。
        const cells = invAllCells(host);
        const idx = cells.indexOf(el);
        const ni = idx + (ev.shiftKey ? -1 : 1);
        if (ni >= 0 && ni < cells.length) target = cells[ni];
        nav = true; ev.preventDefault();
        break;
      }
      case 'ArrowUp':
        target = invVerticalCell(si, key, bi, -1);
        nav = true; ev.preventDefault();
        break;
      case 'ArrowDown':
        target = invVerticalCell(si, key, bi, +1);
        nav = true; ev.preventDefault();
        break;
      case 'ArrowLeft': {
        // 仅当光标在最左且无选区 → 跳到同行左侧相邻框；否则让光标在数字内移动（不拦截、不提交）。
        const atStart = el.selectionStart === 0 && el.selectionEnd === 0;
        if (atStart) { target = invHorizontalCell(si, key, bi, -1); if (target) { nav = true; ev.preventDefault(); } }
        break;
      }
      case 'ArrowRight': {
        const len = (el.value || '').length;
        const atEnd = el.selectionStart === len && el.selectionEnd === len;
        if (atEnd) { target = invHorizontalCell(si, key, bi, +1); if (target) { nav = true; ev.preventDefault(); } }
        break;
      }
      case 'Enter': {
        // Excel 行为：提交当前后下移一行同列；末行无目标时仍提交。
        target = invVerticalCell(si, key, bi, +1);
        nav = true; ev.preventDefault();
        break;
      }
      default:
        return;   // 其它键不处理
    }

    if (!nav) return;   // 边界内的左右键：仅移动光标，不提交（避免编辑中反复重算）
    // 提交时序：导航键先让当前框提交（读值→onCellEdit→invUpdateAll，过程不销毁 input），
    // 再 focus 目标框。此刻 target 不是 active → invUpdateAll 已把它刷成最新联动值；focus 后不再 update。
    // setForecast 幂等，故即便随后 blur 再触发原生 change 也无副作用。
    // 仅当值确实改变才提交+重算：纯导航（Tab/方向键穿格而没改值）不触发全表重算，省性能、且不重复 re-split。
    const _chg = parseFloat(el.value || '0') !== parseFloat(el._iv || '0');
    if (_chg && typeof el.onchange === 'function') { el.onchange(); el._iv = el.value; }
    // 此过程不销毁任何 input（invUpdateAll 不动 innerHTML），故 target 引用仍有效。
    if (target) invFocusCell(target);
  });
}

/* ============================================================
   Task 19: 多选单元格（拖选矩形 / Shift 扩选 / Ctrl 切换）+ 底部求和·平均状态栏
   —— 委托在 #invTables 上（_invSelBound flag 只绑一次）。坐标键 "si-ri-bi"，存
   window.__sosim._sel(Set)+_selAnchor({si,ri,bi})；不持久化。读 td 的 data-* 取坐标、
   data-val 取原始值（不依赖显示格式）。与 Task 14 编辑/键盘导航共存：
   - 普通单击落 input → 不 preventDefault，浏览器自然聚焦编辑（Task 14），并清空多选；
   - 落 computed 格 → 只选该格；
   - 拖动超阈值(SEL_THRESH px)才进入「拖选」(此时 preventDefault、不聚焦、禁用文本选择)，
     否则按单击处理（阈值区分「单击编辑」与「拖选」）；
   - Shift+点击 → 从 anchor 到点击格的矩形；Ctrl/Cmd+点击 → 切换单格（可跨表累加）。
   ============================================================ */
const INV_SEL_THRESH = 4;   // 拖选判定阈值（px）：移动超过此距离才算拖选而非单击

/* 坐标键 */
function invSelKey(si, ri, bi) { return si + '-' + ri + '-' + bi; }

/* 从任意元素向上找数据 td（带 data-si）；返回其坐标或 null（首列口径名/表头无 data-si → null） */
function invSelCoordOf(node) {
  const td = node && node.closest ? node.closest('td[data-si]') : null;
  if (!td) return null;
  return { si: +td.dataset.si, ri: +td.dataset.ri, bi: +td.dataset.bi, td };
}

/* 给指针坐标，经 elementFromPoint 命中其下的数据 td（即便指针停在 input 上也能读到所在 td）。 */
function invSelCoordAtPoint(x, y) {
  const el = document.elementFromPoint(x, y);
  return invSelCoordOf(el);
}

/* 应用 _sel：清掉旧 inv-sel，按当前 _sel 标记对应 td；再刷新状态栏。 */
function invSelApply() {
  const host = document.getElementById('invTables');
  if (host) host.querySelectorAll('td.inv-sel').forEach(td => td.classList.remove('inv-sel'));
  const s = window.__sosim;
  if (host && s && s._sel) {
    s._sel.forEach(k => {
      const p = k.split('-');
      // 按坐标属性定位 td（td 无单一 key id；用属性选择器，跨表唯一）。
      const cell = host.querySelector(`td[data-si="${p[0]}"][data-ri="${p[1]}"][data-bi="${p[2]}"]`);
      if (cell) cell.classList.add('inv-sel');
    });
  }
  invSelRefreshBar();
}

/* 重算并刷新底部状态栏：只统计 data-val 为有效数字的选中格。空选区 → 隐藏。 */
function invSelRefreshBar() {
  const bar = document.getElementById('invSelBar');
  if (!bar) return;
  const s = window.__sosim;
  const host = document.getElementById('invTables');
  const sel = s && s._sel;
  if (!sel || !sel.size || !host) { bar.classList.remove('on'); bar.innerHTML = ''; return; }
  let cnt = 0, sum = 0;
  sel.forEach(k => {
    const p = k.split('-');
    const cell = host.querySelector(`td[data-si="${p[0]}"][data-ri="${p[1]}"][data-bi="${p[2]}"]`);
    if (!cell) return;
    const raw = cell.getAttribute('data-val');
    if (raw == null || raw === '') return;   // 无有效数 → 不计入求和/平均/计数
    const v = parseFloat(raw);
    if (!isFinite(v)) return;
    cnt++; sum += v;
  });
  if (!cnt) { bar.classList.remove('on'); bar.innerHTML = ''; return; }
  const avg = sum / cnt;
  const fmtSum = Math.round(sum).toLocaleString('en-US');
  const fmtAvg = (Math.round(avg * 100) / 100).toLocaleString('en-US', { maximumFractionDigits: 2 });
  bar.innerHTML = `已选 <span class="inv-selnum">${cnt}</span> 格 · 求和 <span class="inv-selnum">${fmtSum}</span> · 平均 <span class="inv-selnum">${fmtAvg}</span>`;
  bar.classList.add('on');
}

/* 清空选区 + 隐藏状态栏（全量重建 / Esc / 外部点击 调用）。 */
function invSelClear() {
  const s = window.__sosim;
  if (s) { if (!s._sel) s._sel = new Set(); else s._sel.clear(); s._selAnchor = null; }
  const host = document.getElementById('invTables');
  if (host) host.querySelectorAll('td.inv-sel').forEach(td => td.classList.remove('inv-sel'));
  invSelRefreshBar();
}

/* 设置选区为 anchor↔cur 的矩形（同一张表 si）：ri∈[min,max]、bi∈[min,max]。
   跨表则只取 cur 单格（矩形仅在同表内有意义）。 */
function invSelSetRect(anchor, cur) {
  const s = window.__sosim;
  if (!s._sel) s._sel = new Set(); else s._sel.clear();
  if (!anchor || anchor.si !== cur.si) { s._sel.add(invSelKey(cur.si, cur.ri, cur.bi)); return; }
  const r0 = Math.min(anchor.ri, cur.ri), r1 = Math.max(anchor.ri, cur.ri);
  const b0 = Math.min(anchor.bi, cur.bi), b1 = Math.max(anchor.bi, cur.bi);
  for (let r = r0; r <= r1; r++) for (let b = b0; b <= b1; b++) s._sel.add(invSelKey(cur.si, r, b));
}

function invBindCellSel(host) {
  if (host._invSelBound) return;   // 委托只绑一次
  host._invSelBound = true;

  let down = null;   // { x, y, coord, mods:{shift,ctrl}, dragging }

  host.addEventListener('mousedown', (ev) => {
    if (ev.button !== 0) return;   // 仅左键
    const coord = invSelCoordOf(ev.target);
    if (!coord) { down = null; return; }   // 落在首列/表头/空白 → 不开始选区（外部点击由 document 清空）
    const shift = ev.shiftKey, ctrl = ev.ctrlKey || ev.metaKey;
    down = { x: ev.clientX, y: ev.clientY, coord, shift, ctrl, dragging: false };
    // Shift/Ctrl 点击：阻止原生文本选择/聚焦抖动（不影响普通单击落 input 的编辑聚焦）。
    if (shift || ctrl) ev.preventDefault();
  });

  host.addEventListener('mousemove', (ev) => {
    if (!down) return;
    if (!down.dragging) {
      const dx = ev.clientX - down.x, dy = ev.clientY - down.y;
      if (Math.abs(dx) < INV_SEL_THRESH && Math.abs(dy) < INV_SEL_THRESH) return;   // 未超阈值 → 仍当单击
      down.dragging = true;
      document.body.style.userSelect = 'none';   // 拖选期间禁用原生文本选择
      // 拖选起点即 anchor（若按住 Shift 则保留已有 anchor 从其扩选）
      if (!down.shift || !window.__sosim._selAnchor) window.__sosim._selAnchor = { si: down.coord.si, ri: down.coord.ri, bi: down.coord.bi };
    }
    ev.preventDefault();   // 拖动中阻止原生选择/输入框拖拽
    const cur = invSelCoordAtPoint(ev.clientX, ev.clientY);
    if (!cur) return;
    invSelSetRect(window.__sosim._selAnchor, cur);
    invSelApply();
  });

  // mouseup 在 document 上监听（指针可能在 host 外释放），但仅处理 down 已记起点的情形。
  document.addEventListener('mouseup', (ev) => {
    if (!down) return;
    const d = down; down = null;
    if (d.dragging) {
      document.body.style.userSelect = '';   // 结束拖选，恢复文本选择
      invSelApply();
      return;
    }
    // 未拖动 = 单击处理
    const s = window.__sosim;
    const coord = d.coord;
    if (d.shift) {
      // Shift+点击：从现有 anchor 到点击格的矩形（无 anchor 则以该格为 anchor）。
      if (!s._selAnchor) s._selAnchor = { si: coord.si, ri: coord.ri, bi: coord.bi };
      invSelSetRect(s._selAnchor, coord);
      invSelApply();
    } else if (d.ctrl) {
      // Ctrl/Cmd+点击：切换单格加入/移出（可跨表累加）；anchor 移到该格。
      if (!s._sel) s._sel = new Set();
      const k = invSelKey(coord.si, coord.ri, coord.bi);
      if (s._sel.has(k)) s._sel.delete(k); else s._sel.add(k);
      s._selAnchor = { si: coord.si, ri: coord.ri, bi: coord.bi };
      invSelApply();
    } else {
      // 普通单击：落 input → 让其自然聚焦编辑（Task 14），仅清空多选；落 computed → 只选该格。
      const isInput = ev.target && ev.target.classList && ev.target.classList.contains('inv-cell');
      if (isInput) {
        invSelClear();   // 不 preventDefault，浏览器已在 mousedown 时聚焦该 input
      } else {
        if (!s._sel) s._sel = new Set(); else s._sel.clear();
        s._sel.add(invSelKey(coord.si, coord.ri, coord.bi));
        s._selAnchor = { si: coord.si, ri: coord.ri, bi: coord.bi };
        invSelApply();
      }
    }
  });

  // Esc 清空选区
  host.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') {
      const s = window.__sosim;
      if (s && s._sel && s._sel.size) { invSelClear(); }
    }
  });
}

// Task 19：点击表格区域外（非 #invTables 内的数据格）清空选区 —— 只注册一次。
if (!window._invSelDocBound) {
  window._invSelDocBound = true;
  document.addEventListener('mousedown', (ev) => {
    const s = window.__sosim;
    if (!s || !s._sel || !s._sel.size) return;
    const host = document.getElementById('invTables');
    if (!host) return;
    // 点击落在某数据格内 → 由 host 的选区逻辑处理（不在此清空）。
    const inCell = ev.target && ev.target.closest && ev.target.closest('#invTables td[data-si]');
    // 点击状态栏自身不清（便于将来加复制按钮等）。
    const inBar = ev.target && ev.target.closest && ev.target.closest('#invSelBar');
    if (!inCell && !inBar) invSelClear();
  }, true);   // 捕获阶段：先于 host 的冒泡 mousedown 跑——但仅当点击在格外才清，故不会误清格内拖选起点。
}

function invFmtCellRaw(v) { return (v == null || isNaN(v)) ? 0 : Math.round(v * 100) / 100; }

/* Task 19：data-val 原始数值字符串。有效数 → 规整到 2 位小数；非数(null/NaN) → ''（求和/平均时跳过）。
   注意区别于 invFmtCellRaw（编辑框 value，非数回退 0）：data-val 用 '' 表示「无有效数」，
   这样空/非法格不会被当成 0 拖低平均、虚增计数。 */
function invSelRawVal(v) { return (v == null || isNaN(v)) ? '' : String(Math.round(v * 100) / 100); }

/* ============================================================
   Step 3 (cont.): 成本成分图 —— 每张进销存表下方一个 ECharts 堆积图
   见 spec §9b。图随 粒度/作用域/图型 切换 与 未来格编辑 一并经 invRenderTables 重建。
   ============================================================ */

/* scope 作用域内全单元、整时间范围的成本构成（按发货月分层）。
   未导入成本表（!s.cost.costMap.size）→ 返回 null（调用方写占位、不出图）。 */
function invComputeComposition(scope, range) {
  const s = window.__sosim, S = window.SoSimCore, C = window.SoSimCalc, ctx = s.ctx;
  if (!s.cost || !s.cost.costMap || !s.cost.costMap.size) return null;     // 未导入成本表
  const units = S.childrenInScope(ctx.units, scope);
  // ★与 invComputeTable 同口径：从生命周期起点做 FIFO 累计，range 只显示窗口（否则范围前的发货层被漏）。
  const computeFrom = Math.min(invLifecycleStart(ctx), range.from);
  const days = S.enumDays(computeFrom, range.to);
  const perUnit = units.map(u => {
    const ship = new Map(), sellOut = new Map();
    days.forEach(d => {
      const sh = invEffShip(ctx, s.store, u, d); if (sh) ship.set(d, sh);   // 与 invComputeTable 同口径(缺历史发货可补 Sell-in)
      const so = S.unitValueAt(ctx, s.store, u, d, 'sellOut'); if (so) sellOut.set(d, so);
    });
    return { ship, sellOut, costForMonth: (ym) => window.CostBase.costFloorFor(s.cost.costMap, u.model, ym) };
  });
  // ★汇总口径(用户定):多国家/多型号也"同一成本加总" —— 所有单元的发货层进同一条 FIFO 队列(层成本
  //   仍精确按各型号当月成本),当日总 SO 统一按先进先出消耗(池化 pooledFifo)。
  //   原逐单元各自队列(costComposition)会让"自身SO不足"的零星老发货永久留层 → 多选国家时底部
  //   老月份小层密密麻麻;池化后总 SO 把零星老货吃光,只剩真实的近期库存层。
  const comp = C.pooledFifo({ perUnit, days, gran: s.gran }).comp;
  // 只显示 range 内的桶（剩余发货层已含 range 之前累计的发货/消耗）；与表格桶一致，保持图柱对齐。
  const firstB = S.bucketOf(range.from, s.gran);
  return comp.filter(c => String(c.bucket) >= firstB);
}

/* costComposition 结果 → ECharts option。type: bar(堆积柱) / area(堆积面积) / pct(百分比柱)。 */
function invBuildChartOption(comp, type) {
  const buckets = comp.map(c => c.bucket);
  // 只保留"在可见范围内还有库存(≥0.5台)的发货月"——已被消耗光的历史月不进 legend，避免底部堆一堆死柱子。
  const yms = [...new Set(comp.flatMap(c => c.layers.filter(l => l.qty >= 0.5).map(l => l.ym)))].sort((a, b) => a - b);
  const isPct = type === 'pct';
  const series = yms.map((ym, i) => ({
    name: (ym % 100) + '月',
    type: type === 'area' ? 'line' : 'bar',
    stack: 'inv',
    areaStyle: type === 'area' ? {} : undefined,
    barWidth: type === 'area' ? undefined : Math.round(INV_COL_W * 0.6),   // 柱宽≈列宽*0.6，居桶列下方
    // 按发货月号(1–12)自定义着色，三图型共用此 itemStyle.color（默认=调色板按月循环）。
    itemStyle: { color: invMonthColor(ym) },
    emphasis: { focus: 'series' },
    data: comp.map(c => {
      const L = c.layers.find(x => x.ym === ym);
      const qty = L ? L.qty : 0, amount = L ? L.amount : 0;
      // 库存为0(或<0.5台)的桶 → value=null，ECharts 不画该段(去掉那条特别微小的线)。
      const val = qty < 0.5 ? null : (isPct ? (c.total > 0 ? Math.round(qty / c.total * 100) : null) : qty);   // 百分比取整(#6)
      // 小段(<桶总量2%)不打标签:多选国家时零星小层的标签会在柱底堆成密密麻麻一坨;tooltip 里仍看得到明细。
      const tiny = val == null || (c.total > 0 && qty / c.total < 0.02);
      return { value: val, _qty: qty, _amount: amount, _ym: ym, label: tiny ? { show: false } : undefined };
    }),
    label: {
      show: true, fontSize: 9, color: '#333',
      formatter: (p) => {
        const d = p.data; if (!d || !d._qty) return '';
        if (isPct) return p.value + '%\n$' + Math.round(d._amount);
        return (d._ym % 100) + '月\n$' + (d._qty ? Math.round(d._amount / d._qty) : 0);
      },
    },
  }));
  // 加权成本折线(2026-07 用户要):每桶 加权成本 = Σ剩余各层金额 ÷ 总台数(池化FIFO剩余的加权单台成本,
  // 与销毛推演加权Floor FOB同口径)。放在图顶部**独立细带 grid**(xAxisIndex/yAxisIndex=1),与柱形区零重叠
  // —— 用户定:折线在柱形图上方、不与柱重叠,否则两边数据标签打架。库存为0的桶断点(null),connectNulls 跨过。
  const wline = comp.map(c => {
    if (!(c.total >= 0.5)) return null;
    const amt = c.layers.reduce((s2, l) => s2 + (l.amount || 0), 0);
    return Math.round((amt / c.total) * 10) / 10;
  });
  series.push({
    name: '加权成本', type: 'line', xAxisIndex: 1, yAxisIndex: 1, z: 10,
    symbol: 'circle', symbolSize: 5, connectNulls: true,
    itemStyle: { color: '#1A1A1A' }, lineStyle: { color: '#1A1A1A', width: 2 },
    label: { show: true, fontSize: 9, color: '#1A1A1A', position: 'top', formatter: (p) => p.value == null ? '' : '$' + Math.round(p.value) },
    data: wline,
  });
  return {
    textStyle: { fontFamily: (typeof YH !== 'undefined' ? YH : 'inherit') },
    tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
    legend: { type: 'scroll', top: 0, textStyle: { fontSize: 10 } },
    // 双 grid:grid[1]=顶部细带放加权成本折线(独立区域,与柱形图零重叠 → 两边数据标签永不打架);
    // grid[0]=堆积柱。两 grid 同 left/right(INV_LABEL_W/0)+同 category 轴 boundaryGap → 折线点、
    // 柱、表格列仍严格 1:1 对齐。图容器高 240→300px:柱区高度不变(300-84-20=196≈原240-24-20),纯增量。
    axisPointer: { link: [{ xAxisIndex: 'all' }] },   // 两个 grid 的十字准星联动
    grid: [
      { left: INV_LABEL_W, right: 0, top: 84, bottom: 20, containLabel: false },    // 柱形区
      { left: INV_LABEL_W, right: 0, top: 28, height: 42, containLabel: false },    // 加权成本带
    ],
    // boundaryGap:true → category 每 band 居中放柱/点，band 宽=INV_COL_W，柱中心落在表数据列正下方
    xAxis: [
      { type: 'category', gridIndex: 0, boundaryGap: true, data: buckets, axisLabel: { fontSize: 9, interval: 0 } },
      { type: 'category', gridIndex: 1, boundaryGap: true, data: buckets, show: false },
    ],
    yAxis: [
      { type: 'value', gridIndex: 0, max: isPct ? 100 : null, axisLabel: { fontSize: 10, formatter: isPct ? '{value}%' : '{value}' } },
      // 加权成本轴:隐藏不占宽;min/max 加留白(上55%/下25%)让点落在带子中段 → 点顶标签不碰图例、点底不贴柱区。
      { type: 'value', gridIndex: 1, show: false,
        min: (v) => { const sp = (v.max - v.min) || Math.abs(v.max) * 0.1 || 1; return v.min - sp * 0.25; },
        max: (v) => { const sp = (v.max - v.min) || Math.abs(v.max) * 0.1 || 1; return v.max + sp * 0.55; } },
    ],
    series,
  };
}

/* 渲染每表下方的图：成本表缺失 → 占位；否则 echarts.init + setOption，实例入 _charts。
   resize 监听只注册一次（_chartResizeBound flag）。
   除 _charts（数组，供 dispose/resize）外，另存 _chartBySi（si→实例）供增量更新按
   scope 索引精确定位（_charts 是稀疏压实的，索引不与 si 对齐，故不能用它做 patch）。 */
function invRenderCharts(scopes) {
  const s = window.__sosim;
  s._chartBySi = {};
  if (!window._invChartResizeBound) {
    window._invChartResizeBound = true;
    window.addEventListener('resize', () => {
      (window.__sosim && window.__sosim._charts || []).forEach(c => { try { c.resize(); } catch (e) { /* noop */ } });
    });
  }
  scopes.forEach((sc, si) => {
    const el = document.getElementById('invChart-' + si);
    if (!el) return;
    const comp = invComputeComposition(sc.scope, s.range);
    if (!comp) { el.style.width = ''; el.innerHTML = '<div class="inv-chart-ph">导入成本表后显示成本图</div>'; return; }
    // 图容器宽 = 表宽 = INV_LABEL_W + nCols*INV_COL_W（nCols=桶数=comp.length），与上方表同宽、同步横向滚动。
    const nCols = comp.length;
    el.style.width = (INV_LABEL_W + nCols * INV_COL_W) + 'px';
    const ch = echarts.init(el);
    ch.setOption(invBuildChartOption(comp, s.chartType));
    s._charts.push(ch);
    s._chartBySi[si] = ch;
  });
}

/* ============================================================
   增量更新（编辑时调，绝不动 innerHTML）—— 重算所有可见 scope 的表数据 + 成本图，
   就地 patch：computed 格 textContent、非激活 input 的 value、fut/over 类、图 setOption。
   跨 scope 联动：一次最细格编辑可能影响多张表，故必须遍历并 patch 所有可见 scope。
   ============================================================ */
function invUpdateAll() {
  const s = window.__sosim;
  if (!s || !s.ctx || !s._scopes || !s._scopes.length) return;
  const active = document.activeElement;   // 正在编辑的框：跳过其 value 覆盖
  s._scopes.forEach((sc, si) => {
    let t;
    try { t = invComputeTable(sc.scope, s.range); } catch (e) { return; }
    INV_ROW_DEFS.forEach(rd => {
      const [, key, kind] = rd;
      const editMetric = INV_EDITABLE[key];
      t.rows.forEach((row, bi) => {
        const b = row.bucket, val = row[key];
        const fut = invBucketIsFuture(b, s.gran, s.ctx.cutoffYmd);
        const over = invCellOver(key, invBucketFlag(t.flags, b, s.gran));
        const td = document.getElementById(`invTd-${si}-${key}-${bi}`);
        if (td) {
          td.classList.toggle('fut', !!fut); td.classList.toggle('over', !!over);
          // Task 19：值变了同步 data-val，使后续选区求和/平均读到的是最新数。
          td.setAttribute('data-val', invSelRawVal(val));
        }
        if (fut && editMetric) {
          const inp = document.getElementById(`invIn-${si}-${key}-${bi}`);
          if (inp && inp !== active) inp.value = invFmtCellRaw(val);   // 跳过用户正在编辑的框
        } else {
          const span = document.getElementById(`invCell-${si}-${key}-${bi}`);
          if (span) span.textContent = invFmtCell(kind, val);
        }
      });
    });
    // 成本图：在位 setOption（不 dispose，保持实例数量与表数一致）；占位表无实例，跳过
    const ch = s._chartBySi && s._chartBySi[si];
    if (ch) {
      let comp = null;
      try { comp = invComputeComposition(sc.scope, s.range); } catch (e) { comp = null; }
      // notMerge:true 全量替换 option：编辑未来发货会新增 FIFO 月层（series 增减），
      // 默认 merge 会残留旧 series；故整体替换，但不 dispose（实例与表数仍一致）。
      if (comp) ch.setOption(invBuildChartOption(comp, s.chartType), true);
    }
  });
  // Task 19：增量更新（DOM 未重建）后，若选区非空，按新 data-val 刷新底部状态栏。
  if (s._sel && s._sel.size) invSelRefreshBar();
}

/* ============================================================
   Step 4: 编辑联动
   ============================================================ */
function onCellEdit(scope, metric, fromYmd, toYmd, value) {
  const s = window.__sosim, S = window.SoSimCore;
  // 稳健解析：parseFloat（容忍尾随字符/空白），NaN→0
  const n = parseFloat(String(value).trim());
  S.setForecast(s.store, { scope, metric, fromYmd, toYmd, value: isFinite(n) ? n : 0, units: s.ctx.units, histSO: s.ctx.histSO });
  invMarkDirty();   // 预测编辑 → 标脏 + 防抖自动存档（永不丢）
  // 增量更新（不重建 innerHTML）：保留焦点+滚动，且不在编辑中销毁 input。
  // 跨 scope 联动：一次最细格编辑可能影响多张表 → invUpdateAll 重算并 patch 所有可见表。
  invUpdateAll();
}

/* ============================================================
   导出 Excel（含未来列公式联动）——走 SoSimExport
   ============================================================ */
async function invExport() {
  const s = window.__sosim, S = window.SoSimCore;
  if (!s.ctx) { toast('请先加载 PSI / 发货数据', 'err'); return; }
  if (!window.SoSimExport || typeof window.SoSimExport.buildWorkbook !== 'function') {
    toast('导出能力（SoSimExport）未就绪', 'err'); return;
  }
  // SoSimExport.buildSheetAoaWithFormulas 的 rows 键用 metric 名（shipment/sellIn/sellOut/channelInv/...）。
  const scopes = invListScopes();
  const tables = scopes.map(sc => {
    const t = invComputeTable(sc.scope, s.range);
    const colLabels = t.rows.map(r => r.bucket);
    const past = t.rows.map(r => !invBucketIsFuture(r.bucket, s.gran, s.ctx.cutoffYmd));
    const nDays = t.rows.map(r => r.nDays);
    const rows = {};
    // 内部行 key 'ship' 对应导出 metric 'shipment'，其余同名
    INV_ROW_DEFS.forEach(rd => { const k = rd[1] === 'ship' ? 'shipment' : rd[1]; rows[k] = t.rows.map(r => r[rd[1]]); });
    return { title: sc.title, colLabels, past, nDays, rows };
  });
  try {
    const forecastRows = S.serializeStore(s.store);   // 还原成 _forecast 表行
    const wb = window.SoSimExport.buildWorkbook({ tables, forecastRows, mtime: new Date().toISOString() });
    const b64 = XLSX.write(wb, { bookType: 'xlsx', type: 'base64' });
    const fn = 'SO模拟_进销存_' + new Date().toISOString().slice(0, 10) + '.xlsx';
    const r = await api.saveFile(fn, b64, 'xlsx');
    if (r && r.path) toast('已导出 ' + fn, 'ok'); else if (!r || !r.canceled) toast('导出失败', 'err');
  } catch (e) { toast('导出失败：' + (e && e.message || e), 'err'); }
}

/* ============================================================
   全量导出（长表 / 可透视底表）—— 全部国家×型号、全时间范围、按月。
   不受当前筛选 / 时间范围影响：永远遍历 ctx.units 的全部最细单元、从 invDefaultRange 的
   from~to、月粒度。逐单元复用引擎（与看板 invComputeTable 同口径：invEffShip 取发货、
   computeInventory 算渠道库存、fifoRemaining 算全流程库存、bucketRows 出月桶、costComposition
   出成本分层）算出每月各指标，再展开成「一行 = 维度组合×年月×指标×数值」的长表。
   只发非空行（指标值为 0/空跳过），捕获底表或模拟中真实存在的数据。
   一次性导出，计算较重（全 units×全生命周期）→ 包 showLoading / hideLoading + try/catch + toast。
   ============================================================ */
async function invFullExport() {
  const s = window.__sosim, S = window.SoSimCore, C = window.SoSimCalc, ctx = s.ctx;
  if (!ctx || !ctx.units || !ctx.units.length) { toast('请先加载 PSI / 发货数据', 'err'); return; }
  if (typeof XLSX === 'undefined' || !XLSX.utils) { toast('导出能力（XLSX）未就绪', 'err'); return; }
  if (typeof showLoading === 'function') showLoading('正在生成全量底表…');
  try {
    // 全时间范围（忽略当前 s.range）、月粒度。
    const B = invDefaultRange(ctx);
    const from = B.from, to = B.to;
    const days = S.enumDays(from, to);
    const hasCost = !!(s.cost && s.cost.costMap && s.cost.costMap.size);
    // 实际/预测判定：该月（YYYYMM）≤ cutoff 月 → 实际，否则预测。
    const cutoffYm = S.ymdToYm(ctx.cutoffYmd || (days.length ? days[days.length - 1] : 0));

    const HEADER = ['品牌', '大区', '国家办', '国家', '产品线', '产品系列', '产品', '型号', '年月', '实际/预测', '指标', '数值'];
    const aoa = [HEADER];

    // 长表指标定义：[指标名, rows 字段, 取整 round/原值]。库存/DOS/发货取整；成本两位小数另行处理。
    const FLOW_METRICS = [
      ['发货量', 'ship'], ['Sell In', 'sellIn'], ['Sell Out', 'sellOut'],
      ['渠道库存', 'channelInv'], ['渠道DOS', 'channelDOS'],
      ['全流程库存', 'fullInv'], ['全流程DOS', 'fullDOS'],
    ];

    ctx.units.forEach(u => {
      // 逐单元的日序列（与看板同口径：发货走 invEffShip，sellIn/sellOut 走 unitValueAt，库存快照取 actual）。
      const ship = new Map(), sellIn = new Map(), sellOut = new Map(), invActual = new Map();
      days.forEach(d => {
        const sh = invEffShip(ctx, s.store, u, d); if (sh) ship.set(d, sh);
        const si = S.unitValueAt(ctx, s.store, u, d, 'sellIn'); if (si) sellIn.set(d, si);
        const so = S.unitValueAt(ctx, s.store, u, d, 'sellOut'); if (so) sellOut.set(d, so);
        const iv = ctx.actual.get(S.skey(u.country, u.model, d, 'inv')); if (iv) invActual.set(d, iv);
      });
      const inv = C.computeInventory({ days, ship, sellIn, sellOut, invActual, cutoffYmd: ctx.cutoffYmd });
      // 全量导出=最细单元(国家×型号)行,故全流程库存用该单元自身的 FIFO 剩余(≥0)——单元级真值。
      // 注意口径:看板从 2026-07 起在**作用域层面池化**(总SO消耗总发货,跨单元),因此把导出行透视
      // 求和得到的全流程库存 ≥ 看板同范围显示值(池化会吃掉"自身SO不足"单元的残层),差值=跨单元消耗量。
      const fullRem = C.fifoRemaining({ days, ship, sellOut });
      const rows = C.bucketRows({ days, gran: 'month', ship, sellIn, sellOut, channelInv: inv.channelInv, fullInv: fullRem });
      // 成本分层（库存成本金额=该月 FIFO 剩余各层金额合计 Σamount）；无成本表则跳过成本两项。
      let compByBucket = null;
      if (hasCost) {
        const comp = C.costComposition({
          perUnit: [{ ship, sellOut, costForMonth: (ym) => window.CostBase.costFloorFor(s.cost.costMap, u.model, ym) }],
          days, gran: 'month',
        });
        compByBucket = new Map(); comp.forEach(c => compByBucket.set(String(c.bucket), c));
      }
      const dims = [
        (u.brand || 'ACME'), u.region || '', u.rep || '', u.country || '',
        u.line || '', u.family || '', u.series || '', u.model || '',
      ];
      rows.forEach(r => {
        const ym = +r.bucket;                       // 月桶 bucketOf(d,'month') = 'YYYYMM' 字符串
        const flag = (ym <= cutoffYm) ? '实际' : '预测';
        const base = dims.concat([String(r.bucket), flag]);
        // 流量/库存/DOS：非 0 才发行，取整。
        FLOW_METRICS.forEach(([name, fld]) => {
          const v = r[fld];
          if (v == null || !isFinite(v) || Math.round(v) === 0) return;
          aoa.push(base.concat([name, Math.round(v)]));
        });
        // 单台 0 毛成本（有成本表且该型号该月有成本时；两位小数）。
        if (hasCost) {
          const unitCost = window.CostBase.costFloorFor(s.cost.costMap, u.model, ym);
          if (unitCost != null && isFinite(unitCost) && unitCost !== 0) {
            aoa.push(base.concat(['单台Floor cost', Math.round(unitCost * 100) / 100]));
          }
          // 库存成本金额 = 该月 FIFO 剩余各层金额合计（两位小数）。
          const comp = compByBucket && compByBucket.get(String(r.bucket));
          if (comp && comp.layers && comp.layers.length) {
            const amt = comp.layers.reduce((a, L) => a + (L.amount || 0), 0);
            if (isFinite(amt) && Math.round(amt * 100) !== 0) {
              aoa.push(base.concat(['库存成本金额', Math.round(amt * 100) / 100]));
            }
          }
        }
      });
    });

    const ws = XLSX.utils.aoa_to_sheet(aoa);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, '全量底表');
    const b64 = XLSX.write(wb, { bookType: 'xlsx', type: 'base64' });
    const fn = 'SO模拟_全量底表_' + new Date().toISOString().slice(0, 10) + '.xlsx';
    const r = await api.saveFile(fn, b64, 'xlsx');
    if (r && r.path) toast('已导出 ' + fn + '（' + (aoa.length - 1) + ' 行）', 'ok');
    else if (!r || !r.canceled) toast('导出失败', 'err');
  } catch (e) {
    toast('全量导出失败：' + (e && e.message || e), 'err');
  } finally {
    if (typeof hideLoading === 'function') hideLoading();
  }
}

/* ============================================================
   配对诊断（仪器）—— 找"老库存永远留存"的根因。
   FIFO 引擎逐单元正确：只有"有发货、却整段没有 SellOut 来消耗"的单元(孤儿)才会让老发货月一直留着不动。
   孤儿最常见来源 = 发货表型号/国家名 ≠ PSI 型号/国家名(全角空格、大小写、后缀…)→ unitKey 配不上。
   本函数对**全部单元**统计：累计发货(ctx.actual 的 shipment) vs 累计实际SO(ctx.histSO)，
   分出 孤儿(发货>0&SO=0) / 仅SO(SO>0&发货=0) / 已配对；再把"归一化后同名但原文不同"的孤儿↔仅SO 列为疑似同物不同名。
   结果弹层展示(可截图) + console.table，供确认根因后精准修(归一化 unitKey / 或确认是纯发货品)。
   ============================================================ */
// 归一化配对键：委托 SoSimCore.normId（单一实现、受测），供诊断"疑似同名"探测与建 ctx 配对共用。
function invNormKey(str) { return window.SoSimCore.normId(str); }
function invDiagPairing() {
  const s = window.__sosim, S = window.SoSimCore, ctx = s.ctx;
  if (!ctx || !ctx.units || !ctx.units.length) { if (typeof toast === 'function') toast('请先加载 PSI/发货数据', 'err'); return; }
  const SEP = S.SEP;
  // 累计发货 per unitKey（ctx.actual 里 metric==='shipment' 的求和）
  const shipByUnit = new Map();
  ctx.actual.forEach((v, k) => { const p = k.split(SEP); if (p[3] === 'shipment') { const uk = p[0] + SEP + p[1]; shipByUnit.set(uk, (shipByUnit.get(uk) || 0) + (+v || 0)); } });
  const orphans = [], soOnly = [], matched = [];
  ctx.units.forEach(u => {
    const uk = S.unitKey(u.country, u.model);
    const ship = shipByUnit.get(uk) || 0, so = ctx.histSO.get(uk) || 0;
    if (ship > 0 && so <= 0) orphans.push({ country: u.country, model: u.model, ship, so });
    else if (so > 0 && ship <= 0) soOnly.push({ country: u.country, model: u.model, ship, so });
    else if (ship > 0 && so > 0) matched.push({ country: u.country, model: u.model, ship, so });
  });
  // 疑似同物不同名：归一化(型号)相等的 孤儿 ↔ 仅SO（同国家或跨国家都列，标注是否同国家）
  const soByNorm = new Map();
  soOnly.forEach(x => { const k = invNormKey(x.model); let a = soByNorm.get(k); if (!a) { a = []; soByNorm.set(k, a); } a.push(x); });
  const suspects = [];
  orphans.forEach(o => { const cand = soByNorm.get(invNormKey(o.model)); if (cand) cand.forEach(c => { if (c.model !== o.model || c.country !== o.country) suspects.push({ 发货国家: o.country, 发货型号: o.model, 发货台数: o.ship, PSI国家: c.country, PSI型号: c.model, PSI_SO: c.so, 同国家: c.country === o.country ? '是' : '否' }); }); });
  orphans.sort((a, b) => b.ship - a.ship); soOnly.sort((a, b) => b.so - a.so);
  const orphanQty = orphans.reduce((a, x) => a + x.ship, 0);
  // console 便于展开
  try { console.log('=== 配对诊断 ===', { 单元数: ctx.units.length, 已配对: matched.length, 孤儿数: orphans.length, 孤儿累计发货: orphanQty, 仅SO数: soOnly.length, 疑似同物不同名: suspects.length }); if (suspects.length) console.table(suspects.slice(0, 100)); if (orphans.length) console.table(orphans.slice(0, 100)); } catch (e) {}
  // 弹层
  const esc = t => String(t == null ? '' : t).replace(/[&<>]/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[m]));
  const rows = (arr, cols) => arr.length ? arr.map(r => '<tr>' + cols.map(c => '<td style="padding:2px 8px;border-bottom:1px solid #eee">' + esc(typeof c === 'function' ? c(r) : r[c]) + '</td>').join('') + '</tr>').join('') : '<tr><td style="padding:6px;color:#999">（无）</td></tr>';
  const html =
    '<div style="font:13px/1.5 YH,system-ui;color:#222">' +
    '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">' +
    '<b style="font-size:15px">配对诊断（发货表 ↔ PSI SellOut，全部单元）</b>' +
    '<button id="invDiagClose" style="border:0;background:#eee;border-radius:6px;padding:4px 12px;cursor:pointer">关闭</button></div>' +
    '<div style="margin-bottom:10px;padding:8px;background:#f7f7f9;border-radius:6px">' +
    '单元总数 <b>' + ctx.units.length + '</b>　·　已配对 <b>' + matched.length + '</b>　·　' +
    '<span style="color:#c0392b">孤儿(有发货·整段无SO) <b>' + orphans.length + '</b> 个，共 <b>' + orphanQty.toLocaleString() + '</b> 台</span>　·　' +
    '仅SO无发货 <b>' + soOnly.length + '</b> 个' +
    '<div style="color:#666;margin-top:4px">孤儿单元的发货永远没有 SO 消耗 → 它的老发货月一直留在库存底部不动，就是你看到的现象。</div></div>' +
    '<div style="color:#c0392b;font-weight:bold;margin:6px 0">⚠ 疑似「同物不同名」（归一化去空格/全角/大小写后相等，但原文不同）：' + suspects.length + ' 对</div>' +
    '<div style="max-height:150px;overflow:auto;border:1px solid #eee;border-radius:6px;margin-bottom:12px"><table style="border-collapse:collapse;width:100%">' +
    '<tr style="position:sticky;top:0;background:#fafafa"><th style="padding:3px 8px;text-align:left">发货国家</th><th style="padding:3px 8px;text-align:left">发货型号</th><th style="padding:3px 8px;text-align:right">发货台数</th><th style="padding:3px 8px;text-align:left">PSI国家</th><th style="padding:3px 8px;text-align:left">PSI型号</th><th style="padding:3px 8px;text-align:center">同国家</th></tr>' +
    rows(suspects.slice(0, 200), ['发货国家', '发货型号', r => (+r.发货台数).toLocaleString(), 'PSI国家', 'PSI型号', '同国家']) + '</table></div>' +
    '<div style="font-weight:bold;margin:6px 0">孤儿型号 Top 50（按累计发货台数）</div>' +
    '<div style="max-height:180px;overflow:auto;border:1px solid #eee;border-radius:6px"><table style="border-collapse:collapse;width:100%">' +
    '<tr style="position:sticky;top:0;background:#fafafa"><th style="padding:3px 8px;text-align:left">国家</th><th style="padding:3px 8px;text-align:left">型号</th><th style="padding:3px 8px;text-align:right">累计发货</th></tr>' +
    rows(orphans.slice(0, 50), ['country', 'model', r => (+r.ship).toLocaleString()]) + '</table></div>' +
    '</div>';
  let ov = document.getElementById('invDiagOverlay');
  if (ov) ov.remove();
  ov = document.createElement('div'); ov.id = 'invDiagOverlay';
  ov.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.35);z-index:99999;display:flex;align-items:center;justify-content:center';
  ov.innerHTML = '<div style="background:var(--c-bg-elev);border-radius:10px;padding:16px 18px;width:min(760px,92vw);max-height:86vh;overflow:auto;box-shadow:0 10px 40px rgba(0,0,0,.3)">' + html + '</div>';
  ov.addEventListener('click', e => { if (e.target === ov) ov.remove(); });
  document.body.appendChild(ov);
  const cb = document.getElementById('invDiagClose'); if (cb) cb.onclick = () => ov.remove();
}

/* 「导入Excel」(invLoad/invSave) 已删除(2026-07 用户定):选错文件(无 _forecast 表)会把预测
   store 整个替换成空,并被防抖自动存档固化 → 预测被打乱且当前版本存档不可恢复。
   恢复请走 数据源→存档卡片→「导入存档」选旧版本文件 sb-存档-v{N}.json(旧版本文件从不删除)。
   引擎级 round-trip(SoSimExport.parseWorkbook)保留(有测试),仅移除 UI 入口;main.js 的
   sosimLoad IPC 留存不再被调用。 */

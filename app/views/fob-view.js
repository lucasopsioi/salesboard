'use strict';
/* PptTableFit：浏览器取全局、Node 单测走 require —— 两边都要能拿到，否则单测一 require 就炸 */
function _fitLib(){ return (typeof window!=='undefined'&&window.PptTableFit)?window.PptTableFit:(typeof require!=='undefined'?require('../ppt-table-fit.js'):null); }
/* ============================================================
   Floor FOB 看板(视图层)。the earlier prototype(PySide6) 全功能移植:
   ① 导入刷新(粘一列→嗅探还原→算价→写入) ② 看板(品类页签/手工编辑/自定义排序/增删行)
   ③ 差异看板(一键导出 PPT+PNG+Excel) ④ 历史版本(留档/撤销/重应用) ⑤ 历史基线
   逻辑全在 FobCore/FobStore/FobReports,本文件只做 DOM 与导出格式。
   持久化:userData/fob-data.json(IPC fobLoad/fobSave,300ms 防抖)。
   ============================================================ */
const fobW = {
  store: null, tab: 'import', shell: false,
  pr: null, ext: null, parseTimer: null, basePaste: null, baseTimer: null,
  pending: {},           // "key|month" -> value|null(蓝底,保存才落库)
  spec: null, sel: null, anchor: null,   // 看板选区
  monthFrom: null, monthTo: null, filter: '',
  diffSnapId: null, diffMode: 'delta', diffCat: '',
  boardCat: '全部',
  saveTimer: null, catSeeded: false,
};

const FOB_PRESET_CATS = ['平板', '音频', '穿戴', '手机', 'PC', '配件'];
const fobQ = sel => document.querySelector(sel);
const fobEsc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');

/* ---------------- 持久化 ---------------- */
async function fobEnsureStore() {
  if (fobW.store) return fobW.store;
  let state = null;
  try { const r = await api.fobLoad(); state = r && r.data ? r.data : null; } catch (e) { }
  fobW.store = new FobStore.Store(state, {
    onDirty: () => {
      clearTimeout(fobW.saveTimer);
      fobW.saveTimer = setTimeout(() => {
        try { api.fobSave(fobW.store.serialize()); } catch (e) { toast('Floor FOB 存档写入失败:' + (e && e.message || e), 'err'); }
      }, 300);
    },
  });
  return fobW.store;
}

/* ---------------- CSS ---------------- */
function fobCSS() {
  if (document.getElementById('fobCss')) return;
  const st = document.createElement('style');
  st.id = 'fobCss';
  st.textContent = `
#view-fob .fob-tabs{display:flex;gap:2px;border-bottom:1px solid var(--line);margin-bottom:10px}
#view-fob .fob-tab{padding:7px 16px;font-size:13px;cursor:pointer;border-radius:8px 8px 0 0;color:var(--ink2)}
#view-fob .fob-tab.on{background:var(--c-bg-elev);border:1px solid var(--line);border-bottom-color:var(--c-bg-elev);color:var(--c-brand);font-weight:600}
#view-fob .fob-bar{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:6px 0}
#view-fob .fob-note{font-size:11px;color:var(--ink3)}
#view-fob .fob-status{white-space:pre-wrap;font-size:12px;border-radius:6px;padding:6px 10px;margin:4px 0;display:none}
#view-fob .fob-status.ok{display:block;background:#E8F5EC;color:#156B37}
#view-fob .fob-status.warn{display:block;background:#FFF7E0;color:#8A6D00}
#view-fob .fob-status.error{display:block;background:#FDE8E8;color:#B71C1C}
#view-fob textarea.fob-paste{width:100%;height:100%;min-height:340px;resize:vertical;font:12px/1.5 Consolas,monospace;border:1px solid var(--line);border-radius:8px;padding:8px;background:var(--c-bg-elev);color:var(--ink);white-space:pre}
#view-fob table.fob-t{border-collapse:collapse;font-size:12px;width:max-content}
#view-fob table.fob-t th{background:#1F3864;color:#fff;padding:4px 9px;position:sticky;top:0;white-space:nowrap;font-weight:600}
#view-fob table.fob-t td{border:1px solid #CED6E5;padding:3px 8px;white-space:nowrap;color:#202630;background:#fff}
#view-fob table.fob-t tr:nth-child(even) td{background:#F3F6FB}
#view-fob table.fob-t td.st-up{background:#FDE8E8!important;color:#B71C1C}
#view-fob table.fob-t td.st-down{background:#E8F5EC!important;color:#156B37}
#view-fob table.fob-t td.st-new{background:#E8F0FE!important;color:#1A4AA8}
#view-fob table.fob-t td.st-gone{background:#F0F0F0!important;color:#787878}
#view-fob table.fob-t td.st-manual{background:#E8F5EC!important;color:#156B37}
#view-fob table.fob-t td.st-same{color:#6E7682}
#view-fob table.fob-t td.selcell{outline:2px solid #4464A5;outline-offset:-2px}
#view-fob table.fob-t td.al{text-align:left}#view-fob table.fob-t td.ar{text-align:right}#view-fob table.fob-t td.ac{text-align:center}
#view-fob .fob-wrap{overflow:auto;border:1px solid var(--line);border-radius:8px;max-height:calc(100vh - 320px)}
#view-fob .fob-menu{position:fixed;z-index:999;background:var(--c-bg-elev);border:1px solid var(--line);border-radius:8px;box-shadow:0 10px 30px rgba(0,0,0,.16);padding:4px;min-width:220px;font-size:12px}
#view-fob .fob-menu div{padding:5px 12px;cursor:pointer;border-radius:5px}
#view-fob .fob-menu div:hover{background:var(--c-line-soft)}
#view-fob .fob-menu .sep{height:1px;background:var(--line);margin:3px 6px;padding:0}
#view-fob .fob-dlg-mask{position:fixed;inset:0;z-index:998;background:rgba(0,0,0,.3);display:flex;align-items:center;justify-content:center}
#view-fob .fob-dlg{background:var(--c-bg-elev);border-radius:12px;box-shadow:0 16px 48px rgba(0,0,0,.25);padding:16px 20px;min-width:380px;max-width:640px;max-height:80vh;overflow:auto}
#view-fob .fob-savebar{display:none;align-items:center;gap:10px;padding:6px 0}
#view-fob .fob-savebar.on{display:flex}
#view-fob .fob-cattabs{display:flex;gap:2px;margin:4px 0}
#view-fob .fob-cattab{padding:4px 14px;font-size:12px;cursor:pointer;border-radius:14px;color:var(--ink2);background:var(--c-line-soft)}
#view-fob .fob-cattab.on{background:var(--c-brand);color:#fff;font-weight:600}
#view-fob .fob-collapse-h{cursor:pointer;font-size:12px;color:var(--c-brand);margin:4px 0}
#view-fob .fob-fold{display:none;border:1px solid var(--line);border-radius:8px;padding:8px 12px;margin:4px 0}
#view-fob .fob-fold.open{display:block}
#view-fob .fob-roles{font-size:12px;background:#FBFCFE;border:1px solid #E0E6F0;border-radius:6px;padding:6px 9px;color:#404853;margin:4px 0;display:none}
#view-fob input[type=text],#view-fob input[type=number],#view-fob select{background:var(--c-bg-elev);color:var(--ink);border:1px solid var(--line);border-radius:6px;padding:3px 8px;font-size:12px}
#view-fob .fob-primary{background:#1F3864;color:#fff;font-weight:600;padding:6px 18px;border-radius:6px;border:none;cursor:pointer}
#view-fob .fob-primary:disabled{background:#C7CEDB;cursor:default}
`;
  document.head.appendChild(st);
}

/* ---------------- 视图入口 ---------------- */
async function renderFob() {
  fobCSS();
  await fobEnsureStore();
  const host = document.getElementById('view-fob');
  if (!host) return;
  if (!fobW.shell) {
    fobW.shell = true;
    host.innerHTML = ''
      + '<div class="fob-tabs">'
      + ['import|① 导入刷新', 'board|② Floor FOB 看板', 'diff|③ 差异看板', 'hist|④ 历史版本', 'base|⑤ 历史基线']
        .map(x => { const [k, t] = x.split('|'); return '<div class="fob-tab" data-tab="' + k + '">' + t + '</div>'; }).join('')
      + '<div style="flex:1"></div>'
      + '<button class="btn" id="fobHelp" title="使用说明">❓ 说明</button>'
      + '<button class="btn" id="fobSettings" title="小数位 / PNG 清晰度 / PPT 每页行数">⚙ 设置</button>'
      + '<button class="btn" id="fobTrash" title="恢复删除的型号">🗑 回收站</button>'
      + '<button class="btn" id="fobBackup" title="把整份数据导出成 JSON 文件">💾 备份</button>'
      + '<button class="btn" id="fobDemo" title="载入 22 个型号的示例数据试用">🎓 载入示例</button>'
      + '</div>'
      + '<div id="fobBody"></div>';
    host.querySelectorAll('.fob-tab').forEach(el => el.onclick = () => { fobW.tab = el.dataset.tab; renderFob(); });
    fobQ('#fobHelp').onclick = fobShowHelp;
    fobQ('#fobSettings').onclick = fobShowSettings;
    fobQ('#fobTrash').onclick = fobShowTrash;
    fobQ('#fobBackup').onclick = fobBackup;
    fobQ('#fobDemo').onclick = fobLoadDemo;
  }
  host.querySelectorAll('.fob-tab').forEach(el => el.classList.toggle('on', el.dataset.tab === fobW.tab));
  const body = fobQ('#fobBody');
  if (fobW.tab === 'import') fobRenderImport(body);
  else if (fobW.tab === 'board') fobRenderBoard(body);
  else if (fobW.tab === 'diff') fobRenderDiff(body);
  else if (fobW.tab === 'hist') fobRenderHist(body);
  else fobRenderBase(body);
}
if (typeof window !== 'undefined') window.renderFob = renderFob;

/* ============================================================
   ① 导入刷新
   ============================================================ */
function fobRenderImport(body) {
  const st = fobW.store;
  const set = st.getSettings();
  const curM = FobCore.M.current();
  const lastStart = set.lastStartMonth ? FobCore.M.add(set.lastStartMonth, 1) : curM;
  body.innerHTML = ''
    + '<div style="display:flex;gap:14px;align-items:stretch">'
    + '  <div style="flex:3;min-width:280px;display:flex;flex-direction:column">'
    + '    <div style="font-weight:600;margin-bottom:4px">① 粘贴导出的那一列</div>'
    + '    <textarea class="fob-paste" id="fobPaste" placeholder="把系统导出的那一整列（层级 / 大区 / … / 各月销毛率）直接 Ctrl+V 粘到这里。\n\n· 一列多少行都行，软件会自动认出「每个字段占几行」（= 产品个数）\n· 带不带表头都行；销毛率是 12.70% 还是 0.127 都行\n· 已经在 Excel 里拉成表格的（横的竖的）也可以直接粘"></textarea>'
    + '    <div class="fob-bar"><span class="fob-note" id="fobLines">0 行</span><span style="flex:1"></span>'
    + '      <button class="btn" id="fobClear">清空</button><button class="btn" id="fobReparse">重新解析</button></div>'
    + '  </div>'
    + '  <div style="flex:5;min-width:420px">'
    + '    <div style="font-weight:600;margin-bottom:4px">② 核对识别结果</div>'
    + '    <div class="fob-status" id="fobStatus"></div>'
    + '    <div class="fob-bar">第一个月份列 = <input type="text" id="fobStart" style="width:90px" value="' + lastStart + '" title="填 202607 / Jul-26 / 2026-07 都行">'
    + '      <span style="width:12px"></span>品类 <input type="text" id="fobCat" list="fobCatList" style="width:110px" placeholder="留空用BU"><datalist id="fobCatList"></datalist></div>'
    + '    <div class="fob-collapse-h" id="fobAdvH">▸ 解析设置（认错了再点开）</div>'
    + '    <div class="fob-fold" id="fobAdv">'
    + '      <div class="fob-bar">从哪个月起覆盖看板 <input type="text" id="fobApplyFrom" style="width:90px" value="' + lastStart + '"><span class="fob-note">比它早的月份保持看板上的历史值不动</span></div>'
    + '      <div class="fob-bar">这次刷新的名字 <input type="text" id="fobLabel" style="width:220px" placeholder="留空就用「Jul-26 刷新」这种默认名"></div>'
    + '      <div class="fob-bar"><label><input type="checkbox" id="fobAutoN" checked> 自动识别产品数</label>'
    + '        每字段 <input type="number" id="fobN" style="width:70px" value="22" disabled> 行'
    + '        跳过前 <input type="number" id="fobSkip" style="width:60px" value="0"> 行</div>'
    + '      <div class="fob-bar"><label><input type="checkbox" id="fobManual"> 手工指定列</label>'
    + '        型号列 <input type="number" id="fobColModel" style="width:56px" value="0" disabled>'
    + '        系列列 <input type="number" id="fobColSeries" style="width:56px" value="0" disabled>'
    + '        授权价列 <input type="number" id="fobColPrice" style="width:56px" value="0" disabled>'
    + '        首月列 <input type="number" id="fobColM1" style="width:56px" value="0" disabled>'
    + '        <span class="fob-note">从 1 数;0=自动</span></div>'
    + '      <div class="fob-bar"><label><input type="checkbox" id="fobTail" ' + (set.dropZeroTail !== false ? 'checked' : '') + '> 丢弃末尾全零列</label>'
    + '        <label><input type="checkbox" id="fobPct" ' + (set.bareIsPercent ? 'checked' : '') + '> 裸数字按百分数（12.7 → 12.7%）</label></div>'
    + '    </div>'
    + '    <div class="fob-roles" id="fobRoles"></div>'
    + '    <div class="fob-wrap" style="max-height:calc(100vh - 480px)"><table class="fob-t" id="fobPreview"></table></div>'
    + '    <div class="fob-bar"><span class="fob-note" id="fobSummary"></span><span style="flex:1"></span>'
    + '      <button class="fob-primary" id="fobApply" disabled>③ 计算并写入看板</button></div>'
    + '  </div>'
    + '</div>';
  fobSeedCatList('');
  const deb = () => { clearTimeout(fobW.parseTimer); fobW.parseTimer = setTimeout(fobDoParse, 350); };
  fobQ('#fobPaste').oninput = () => { fobQ('#fobLines').textContent = fobQ('#fobPaste').value.split('\n').length.toLocaleString() + ' 行'; deb(); };
  fobQ('#fobClear').onclick = () => { fobQ('#fobPaste').value = ''; fobDoParse(); };
  fobQ('#fobReparse').onclick = fobDoParse;
  fobQ('#fobAdvH').onclick = () => fobQ('#fobAdv').classList.toggle('open');
  fobQ('#fobAutoN').onchange = () => { fobQ('#fobN').disabled = fobQ('#fobAutoN').checked; fobDoParse(); };
  fobQ('#fobManual').onchange = () => {
    const on = fobQ('#fobManual').checked;
    ['fobColModel', 'fobColSeries', 'fobColPrice', 'fobColM1'].forEach(id => { fobQ('#' + id).disabled = !on; });
    if (on && fobW.pr) {   // 打开时用自动识别结果预填,只改错的那一两个
      const lay = fobW.pr.layout;
      const map = { fobColModel: lay.model, fobColSeries: lay.series, fobColPrice: lay.price, fobColM1: lay.monthStart };
      Object.keys(map).forEach(id => { fobQ('#' + id).value = map[id] != null ? map[id] + 1 : 0; });
    }
    fobDoParse();
  };
  ['fobN', 'fobSkip', 'fobColModel', 'fobColSeries', 'fobColPrice', 'fobColM1', 'fobTail'].forEach(id => { fobQ('#' + id).onchange = fobDoParse; });
  ['fobStart', 'fobPct'].forEach(id => { fobQ('#' + id).onchange = fobRecalc; });
  fobQ('#fobApply').onclick = fobDoApply;
}

function fobSeedCatList(bu) {
  const dl = fobQ('#fobCatList');
  if (!dl) return;
  const existing = fobW.store.categories().filter(c => c !== FobStore.UNCATEGORIZED);
  const opts = [...new Set([bu].concat(existing, FOB_PRESET_CATS).filter(Boolean))];
  dl.innerHTML = opts.map(c => '<option value="' + fobEsc(c) + '">').join('');
  const inp = fobQ('#fobCat');
  if (inp && !fobW.catSeeded && bu) { inp.value = bu; fobW.catSeeded = true; }
}

function fobStatus(id, text, kind) {
  const el = fobQ('#' + id);
  if (!el) return;
  el.className = 'fob-status' + (text ? ' ' + (kind || 'ok') : '');
  el.textContent = text || '';
}

function fobManualCols() {
  if (!fobQ('#fobManual') || !fobQ('#fobManual').checked) return null;
  const mc = {};
  const map = { model: 'fobColModel', series: 'fobColSeries', price: 'fobColPrice', monthStart: 'fobColM1' };
  Object.keys(map).forEach(attr => { const v = +fobQ('#' + map[attr]).value; if (v > 0) mc[attr] = v - 1; });
  return Object.keys(mc).length ? mc : null;
}

function fobDoParse() {
  const raw = fobQ('#fobPaste') ? fobQ('#fobPaste').value : '';
  fobW.pr = null; fobW.ext = null;
  const btn = fobQ('#fobApply');
  if (btn) btn.disabled = true;
  const tbl = fobQ('#fobPreview');
  if (!raw.trim()) { if (tbl) tbl.innerHTML = ''; fobStatus('fobStatus', ''); fobQ('#fobRoles').style.display = 'none'; fobQ('#fobSummary').textContent = ''; return; }
  let pr;
  try {
    pr = FobCore.parsePaste(raw, {
      forceBlock: fobQ('#fobAutoN').checked ? null : +fobQ('#fobN').value,
      skip: +fobQ('#fobSkip').value || 0,
      dropZeroTail: fobQ('#fobTail').checked,
      manual: fobManualCols(),
    });
  } catch (e) {
    fobStatus('fobStatus', String(e.message || e), 'error');
    fobQ('#fobRoles').style.display = 'none';
    if (tbl) tbl.innerHTML = '';
    return;
  }
  fobW.pr = pr;
  if (fobQ('#fobAutoN').checked && pr.sourceShape === 'column') fobQ('#fobN').value = pr.nProducts;
  const lay = pr.layout;
  const shape = { column: '一列', table: '横表', 'table-T': '竖表(已自动转置)' }[pr.sourceShape];
  const head = '识别为 ' + shape + '：' + pr.nProducts + ' 个产品 × ' + pr.nFields + ' 个字段，月度销毛率 ' + lay.monthCount + ' 列';
  // 角色摘要:型号认错最致命,认错了在这一眼看出来
  const roles = FobCore.layoutRoles(lay).filter(r => r[1] != null)
    .map(r => '<b>' + r[0] + '</b>=第' + (r[1] + 1) + '列 <span style="color:#6E7682">(' + fobEsc(FobCore.sampleField(pr.grid, r[1], 2)) + ')</span>').join('　');
  let tail = '　<b>月份数</b>=' + lay.monthCount;
  if (lay.droppedTail) tail += '　<span style="color:#6E7682">(末尾丢弃 ' + lay.droppedTail + ' 列)</span>';
  if (lay.manual) tail += '　<span style="color:#B71C1C">[含手工指定]</span>';
  const rolesEl = fobQ('#fobRoles');
  rolesEl.innerHTML = roles + tail;
  rolesEl.style.display = 'block';
  if (!FobCore.layoutUsable(lay)) {
    let tip = '';
    if (lay.degenerate) {
      fobQ('#fobAdv').classList.add('open');   // 需要救急,折叠区自动展开
      tip = '\n\n多半是粘贴内容不完整：Excel 里 Ctrl+Shift+↓ 一碰到空单元格就停，经常只复制到一半。建议点列标整列复制。\n确认内容是全的，就在「解析设置」里手工填产品个数或指定型号列。';
    }
    fobStatus('fobStatus', head + '\n字段识别不完整：' + lay.warnings.join('；') + tip, 'error');
    if (tbl) tbl.innerHTML = '';
    return;
  }
  fobStatus('fobStatus', head + (pr.warnings.length ? '\n' + pr.warnings.join('；') : ''), pr.warnings.length ? 'warn' : 'ok');
  fobRecalc();
}

function fobRecalc() {
  if (!fobW.pr) return;
  const start = FobCore.M.parse(fobQ('#fobStart').value);
  if (start == null) { fobStatus('fobStatus', '起始月份填写有误（填 202607 / Jul-26 / 2026-07）', 'error'); return; }
  let ext;
  try {
    ext = FobCore.extract(fobW.pr, start, fobQ('#fobPct').checked, fobQ('#fobPaste').value);
  } catch (e) { fobStatus('fobStatus', String(e.message || e), 'error'); return; }
  fobW.ext = ext;
  const lbl = fobQ('#fobLabel');
  if (lbl && !lbl.value.trim()) lbl.placeholder = FobCore.M.label(start) + ' 刷新';
  const bu = (ext.rows.find(r => r.bu) || {}).bu || '';
  fobSeedCatList(bu);
  // 预览表
  const ms = FobCore.extMonths(ext);
  const dec = fobW.store.getSettings().decimals || 0;
  const R = FobReports;
  let h = '<thead><tr>' + ['产品型号', '产品系列', '授权价', '生效日期', '生效当月'].concat(ms.map(FobCore.M.label)).map(c => '<th>' + c + '</th>').join('') + '</tr></thead><tbody>';
  for (const r of ext.rows) {
    h += '<tr><td class="al" style="font-weight:600">' + fobEsc(r.model) + '</td><td class="al">' + fobEsc(r.series) + '</td>'
      + '<td class="ar">' + R.fmtValue(r.price, 1) + '</td><td class="ac">' + (r.effDate || '') + '</td>'
      + '<td class="ar">' + (r.baseRate == null ? '' : (r.baseRate * 100).toFixed(1) + '%') + '</td>'
      + FobCore.zeroMargin(r).map(v => '<td class="ar">' + R.fmtValue(v, dec) + '</td>').join('') + '</tr>';
  }
  fobQ('#fobPreview').innerHTML = h + '</tbody>';
  const nPrice = ext.rows.filter(r => r.price != null).length;
  fobQ('#fobSummary').textContent = ext.rows.length + ' 个型号（' + nPrice + ' 个有授权价）　' + FobCore.M.label(ms[0]) + ' ~ ' + FobCore.M.label(ms[ms.length - 1]);
  fobQ('#fobApply').disabled = !ext.rows.length;
  const af = fobQ('#fobApplyFrom');
  if (af && FobCore.M.parse(af.value) == null) af.value = start;
}

function fobDoApply() {
  const ext = fobW.ext;
  if (!ext) return;
  const st = fobW.store;
  const start = ext.startMonth;
  let applyFrom = FobCore.M.parse(fobQ('#fobApplyFrom').value);
  if (applyFrom == null || applyFrom < start) applyFrom = start;
  const label = fobQ('#fobLabel').value.trim() || (FobCore.M.label(start) + ' 刷新');
  const category = fobQ('#fobCat').value.trim();
  const ms = FobCore.extMonths(ext);
  const overlap = ms.filter(m => m >= applyFrom);
  const existing = st.boardCells();
  let willOverwrite = 0;
  ext.rows.forEach(r => overlap.forEach(m => { if ((st.resolveKey(r.key) + '|' + m) in existing) willOverwrite++; }));
  // 手工值优先级最高,会挡住导出真值——必须点名说清,不能静默
  const overrides = st.overrideCells();
  const blocked = [...new Set(ext.rows.filter(r => overlap.some(m => (st.resolveKey(r.key) + '|' + m) in overrides)).map(r => r.model))].sort();
  const hidden = {}; st.hiddenKeys().forEach(k => { hidden[k] = 1; });
  const deleted = [...new Set(ext.rows.filter(r => hidden[st.resolveKey(r.key)]).map(r => r.model))].sort();
  let msg = '本次刷新：' + label + '\n品类：' + (category || '（用导出里的 BU）')
    + '\n月份范围：' + FobCore.M.label(ms[0]) + ' ~ ' + FobCore.M.label(ms[ms.length - 1])
    + '\n覆盖起点：' + FobCore.M.label(applyFrom) + '（更早的月份保持不变）'
    + '\n型号数量：' + ext.rows.length
    + '\n将覆盖看板上已有的 ' + willOverwrite + ' 个格子';
  if (blocked.length) msg += '\n\n⚠ 有 ' + blocked.length + ' 个型号存在手工值，会挡住本次导出的真实值：\n' + blocked.slice(0, 6).join('、') + (blocked.length > 6 ? '…' : '') + '\n（在看板上右键该行 →「清除该行的手工值」即可让导出值生效）';
  if (deleted.length) msg += '\n\n⚠ 有 ' + deleted.length + ' 个型号在回收站里，本次不会出现在看板上：\n' + deleted.slice(0, 6).join('、') + (deleted.length > 6 ? '…' : '');
  fobConfirm('确认写入看板', msg, () => {
    const sid = st.addSnapshot(ext, { label, applyFrom, category });
    st.setSettings({ lastStartMonth: start, dropZeroTail: fobQ('#fobTail').checked, bareIsPercent: fobQ('#fobPct').checked });
    toast('已写入看板：' + label, 'ok');
    fobW.diffSnapId = sid;
    fobW.tab = 'diff';
    renderFob();
  });
}

/* ============================================================
   ② 看板
   ============================================================ */
function fobMonthsPresent() {
  let ms = fobW.store.monthsPresent();
  if (!ms.length) ms = FobCore.M.series(FobCore.M.add(FobCore.M.current(), -6), 18);
  return ms;
}
function fobSelectedMonths() {
  const ms = fobMonthsPresent();
  const a = fobW.monthFrom != null ? fobW.monthFrom : ms[0];
  const b = fobW.monthTo != null ? fobW.monthTo : ms[ms.length - 1];
  const lo = Math.min(a, b), hi = Math.max(a, b);
  return ms.filter(m => lo <= m && m <= hi);
}
function fobFilteredKeys() {
  const text = fobW.filter.trim();
  if (!text) return null;
  const terms = text.toLowerCase().split(/\s+/);
  const info = fobW.store.modelInfo();
  return Object.keys(info).filter(k => {
    const r = info[k];
    const hay = ['display', 'series', 'product', 'bu', 'region', 'category'].map(f => String(r[f] || '')).join(' ').toLowerCase();
    return terms.every(t => hay.includes(t));
  });
}
function fobBoardCat() { return fobW.boardCat === '全部' ? null : fobW.boardCat; }
function fobOrder() { return fobW.store.getSettings().boardOrder || FobReports.DEFAULT_ORDER; }

function fobRenderBoard(body) {
  const st = fobW.store;
  const set = st.getSettings();
  const ms = fobMonthsPresent();
  const cats = ['全部'].concat(st.categories());
  if (!cats.includes(fobW.boardCat)) fobW.boardCat = '全部';
  const monthOpt = sel => ms.map(m => '<option value="' + m + '"' + (m === sel ? ' selected' : '') + '>' + FobCore.M.label(m) + '</option>').join('');
  body.innerHTML = ''
    + '<div class="fob-bar">'
    + '  <input type="text" id="fobFilter" style="flex:2;min-width:200px" placeholder="按型号/系列筛选，多个关键词用空格分隔" value="' + fobEsc(fobW.filter) + '">'
    + '  月份 <select id="fobMFrom">' + monthOpt(fobW.monthFrom != null ? fobW.monthFrom : ms[0]) + '</select> ~ <select id="fobMTo">' + monthOpt(fobW.monthTo != null ? fobW.monthTo : ms[ms.length - 1]) + '</select>'
    + '  <span style="flex:1"></span>'
    + '  <button class="btn" id="fobCopy">复制</button>'
    + '  <button class="btn" id="fobExpPng">🖼 PNG</button><button class="btn" id="fobExpXlsx">📊 Excel</button><button class="btn" id="fobExpPpt">📽 PPT</button>'
    + '</div>'
    + '<div class="fob-cattabs" id="fobCatTabs">' + cats.map(c => '<div class="fob-cattab' + (c === fobW.boardCat ? ' on' : '') + '" data-cat="' + fobEsc(c) + '">' + fobEsc(c) + '</div>').join('') + '</div>'
    + '<div class="fob-bar">排序 <select id="fobOrder">' + FobReports.ORDERS.map(o => '<option value="' + o[0] + '"' + (o[0] === fobOrder() ? ' selected' : '') + '>' + o[1] + '</option>').join('') + '</select>'
    + '  <button class="btn" id="fobAddRow" title="手工加一个还没有导出数据的型号（比如未来新品）">＋ 新增型号</button>'
    + '  <span class="fob-note" id="fobInfo" title="产品系列为「（未填）」的可以双击直接写；绿底=手工值(右键可清除)；蓝底=未保存修改。右键行:设品类/移动/合并/删除。"></span></div>'
    + '<div class="fob-wrap" id="fobBoardWrap" tabindex="0"><table class="fob-t" id="fobBoard"></table></div>'
    + '<div class="fob-savebar" id="fobSaveBar"><span style="color:#1A4AA8;font-weight:600" id="fobPendingN"></span><span style="flex:1"></span>'
    + '  <button class="btn" id="fobRevert">放弃修改</button><button class="fob-primary" id="fobSave">保存修改</button></div>';
  fobQ('#fobFilter').oninput = () => { fobW.filter = fobQ('#fobFilter').value; fobPaintBoard(); };
  fobQ('#fobMFrom').onchange = () => { fobW.monthFrom = +fobQ('#fobMFrom').value; fobPaintBoard(); };
  fobQ('#fobMTo').onchange = () => { fobW.monthTo = +fobQ('#fobMTo').value; fobPaintBoard(); };
  fobQ('#fobOrder').onchange = () => { st.setSettings({ boardOrder: fobQ('#fobOrder').value }); fobPaintBoard(); };
  body.querySelectorAll('.fob-cattab').forEach(el => el.onclick = () => { fobW.boardCat = el.dataset.cat; renderFob(); });
  fobQ('#fobCopy').onclick = () => { fobCopyText(FobReports.specToTsv(fobW.spec)); toast('看板已复制，可直接贴进 Excel', 'ok'); };
  fobQ('#fobAddRow').onclick = fobAddModelDlg;
  fobQ('#fobExpPng').onclick = () => fobGuardPending(() => fobExportPng(fobExportBoardSpec(), 'Floor FOB看板.png'));
  fobQ('#fobExpXlsx').onclick = () => fobGuardPending(fobExportXlsx);
  fobQ('#fobExpPpt').onclick = () => fobGuardPending(fobExportPpt);
  fobQ('#fobRevert').onclick = () => { fobW.pending = {}; fobPaintBoard(); };
  fobQ('#fobSave').onclick = fobSavePending;
  const wrap = fobQ('#fobBoardWrap');
  wrap.addEventListener('paste', fobBoardPaste);
  wrap.addEventListener('keydown', fobBoardKeydown);
  fobPaintBoard();
}

function fobBoardSpecNow(forExport) {
  return FobReports.boardSpec(fobW.store, {
    months: fobSelectedMonths(), modelKeys: fobFilteredKeys(),
    decimals: fobW.store.getSettings().decimals || 0,
    order: fobOrder(), category: fobBoardCat(),
    pending: forExport ? null : fobW.pending, markManual: !forExport,
  });
}
function fobExportBoardSpec() { return fobBoardSpecNow(true); }

function fobPaintBoard() {
  const spec = fobBoardSpecNow(false);
  fobW.spec = spec;
  const custom = fobOrder() === 'custom';
  const tbl = fobQ('#fobBoard');
  if (!tbl) return;
  let h = '<thead><tr><th style="width:26px"></th><th style="width:22px"></th>' + spec.columns.map(c => '<th>' + c + '</th>').join('') + '</tr></thead><tbody>';
  spec.rows.forEach((row, r) => {
    h += '<tr data-r="' + r + '"' + (custom ? ' draggable="true"' : '') + '>'
      + '<td><button class="row-hide-btn" data-del="' + r + '" title="从看板删除这一行（可在回收站恢复）" style="border:none;background:none;color:#B71C1C;cursor:pointer;font-weight:700">✕</button></td>'
      + '<td style="color:' + (custom ? '#5B6A85' : '#C7CEDB') + ';cursor:' + (custom ? 'grab' : 'default') + '" title="' + (custom ? '按住整行拖动调顺序' : '切到「自定义」排序后才能拖动') + '">⠿</td>';
    row.forEach((cell, c) => {
      h += '<td class="a' + cell.align + (cell.status !== 'none' ? ' st-' + cell.status : '') + '" data-r="' + r + '" data-c="' + c + '"'
        + (cell.bold ? ' style="font-weight:600"' : '') + '>' + fobEsc(cell.text) + '</td>';
    });
    h += '</tr>';
  });
  tbl.innerHTML = h + '</tbody>';
  // 编辑:月份格 + 系列格 双击
  tbl.querySelectorAll('td[data-c]').forEach(td => {
    td.onmousedown = e => { if (e.button === 0) fobSelStart(+td.dataset.r, +td.dataset.c, e.shiftKey); };
    td.ondblclick = () => fobEditCell(+td.dataset.r, +td.dataset.c, td);
  });
  tbl.querySelectorAll('[data-del]').forEach(b => b.onclick = e => { e.stopPropagation(); fobDeleteRow(spec.rowMeta[+b.dataset.del]); });
  tbl.oncontextmenu = e => { const td = e.target.closest('td[data-c]'); if (!td) return; e.preventDefault(); fobRowMenu(e, +td.dataset.r); };
  // 拖动排序
  if (custom) {
    let dragRow = null;
    tbl.querySelectorAll('tbody tr').forEach(tr => {
      tr.ondragstart = () => { dragRow = +tr.dataset.r; };
      tr.ondragover = e => e.preventDefault();
      tr.ondrop = e => { e.preventDefault(); if (dragRow != null) fobRowsMoved([dragRow], +tr.dataset.r); };
    });
  }
  // 信息行
  const info = fobW.store.modelInfo();
  const missing = spec.rowMeta.filter(k => !(((info[k] || {}).series) || '').trim()).length;
  const shown = {}; spec.rowMeta.forEach(k => { shown[k] = 1; });
  const nOverride = new Set(Object.keys(fobW.store.overrideCells()).map(k => k.slice(0, k.lastIndexOf('|'))).filter(k => shown[k])).size;
  const bits = [spec.rows.length + ' 个型号 × ' + spec.months.length + ' 个月'];
  if (missing) bits.push(missing + ' 个缺产品系列');
  if (nOverride) bits.push(nOverride + ' 个含手工值');
  const el = fobQ('#fobInfo'); if (el) el.textContent = bits.join('　|　');
  const n = Object.keys(fobW.pending).length;
  const bar = fobQ('#fobSaveBar');
  if (bar) { bar.classList.toggle('on', n > 0); const pn = fobQ('#fobPendingN'); if (pn) pn.textContent = '有 ' + n + ' 处修改未保存（蓝底）'; }
  fobPaintSel();
}

/* ---- 选区/编辑 ---- */
function fobSelStart(r, c, extend) {
  if (extend && fobW.anchor) fobW.sel = { r1: Math.min(fobW.anchor.r, r), c1: Math.min(fobW.anchor.c, c), r2: Math.max(fobW.anchor.r, r), c2: Math.max(fobW.anchor.c, c) };
  else { fobW.anchor = { r, c }; fobW.sel = { r1: r, c1: c, r2: r, c2: c }; }
  fobPaintSel();
}
function fobPaintSel() {
  const tbl = fobQ('#fobBoard');
  if (!tbl) return;
  tbl.querySelectorAll('td.selcell').forEach(td => td.classList.remove('selcell'));
  const s = fobW.sel;
  if (!s) return;
  tbl.querySelectorAll('td[data-c]').forEach(td => {
    const r = +td.dataset.r, c = +td.dataset.c;
    if (r >= s.r1 && r <= s.r2 && c >= s.c1 && c <= s.c2) td.classList.add('selcell');
  });
}
/* 表格坐标 → "key|month"(不是月份格返回 null;c 是 spec 列号,0=型号,1=系列) */
function fobCellTarget(r, c) {
  const spec = fobW.spec;
  if (!spec || r >= spec.rowMeta.length) return null;
  const mi = c - spec.freezeCols;
  if (mi < 0 || mi >= spec.months.length) return null;
  return spec.rowMeta[r] + '|' + spec.months[mi];
}
function fobStage(cellKey, text) {
  const v = !text.trim() ? null : FobCore.parseNumber(text);
  if (text.trim() && v == null) return false;   // 不是数字就当没输入,避免把表写脏
  fobW.pending[cellKey] = v;
  return true;
}
function fobEditCell(r, c, td) {
  const spec = fobW.spec;
  const isSeries = spec.freezeCols === 2 && c === 1;
  const target = fobCellTarget(r, c);
  if (!isSeries && !target) return;
  const cur = td.textContent === FobReports.NO_SERIES ? '' : td.textContent;
  const inp = document.createElement('input');
  inp.type = 'text'; inp.value = cur;
  inp.style.cssText = 'width:' + Math.max(60, td.offsetWidth - 10) + 'px;font-size:12px';
  td.textContent = ''; td.appendChild(inp); inp.focus(); inp.select();
  let done = false;
  const commit = okv => {
    if (done) return; done = true;
    const text = inp.value;
    if (okv) {
      if (isSeries) { fobW.store.setModelSeries(spec.rowMeta[r], text.trim()); }
      else fobStage(target, text);
    }
    fobPaintBoard();
  };
  inp.onblur = () => commit(true);
  inp.onkeydown = e => {
    if (e.key === 'Enter') { e.preventDefault(); commit(true); }
    if (e.key === 'Escape') { e.preventDefault(); commit(false); }
    e.stopPropagation();
  };
}
function fobBoardKeydown(e) {
  if (!fobW.sel) return;
  if (e.key === 'Delete') {
    e.preventDefault();
    const s = fobW.sel;
    for (let r = s.r1; r <= s.r2; r++) for (let c = s.c1; c <= s.c2; c++) {
      const t = fobCellTarget(r, c);
      if (t) fobW.pending[t] = null;
    }
    fobPaintBoard();
  } else if ((e.ctrlKey || e.metaKey) && (e.key === 'c' || e.key === 'C')) {
    e.preventDefault();
    const s = fobW.sel, lines = [];
    for (let r = s.r1; r <= s.r2; r++) {
      const parts = [];
      for (let c = s.c1; c <= s.c2; c++) parts.push((fobW.spec.rows[r] && fobW.spec.rows[r][c]) ? fobW.spec.rows[r][c].text : '');
      lines.push(parts.join('\t'));
    }
    fobCopyText(lines.join('\n'));
  }
}
/* Excel 式粘贴:单个值填当前格/选区,一整块从当前格向右下铺开 */
function fobBoardPaste(e) {
  if (!fobW.sel || !fobW.spec) return;
  const text = (e.clipboardData || window.clipboardData).getData('text');
  if (!text) return;
  e.preventDefault();
  const block = text.replace(/\r\n?/g, '\n').replace(/\n$/, '').split('\n').map(l => l.split('\t'));
  const s = fobW.sel;
  let skipped = 0;
  if (block.length === 1 && block[0].length === 1) {
    for (let r = s.r1; r <= s.r2; r++) for (let c = s.c1; c <= s.c2; c++) {
      const t = fobCellTarget(r, c);
      if (t) fobStage(t, block[0][0]); else skipped++;
    }
  } else {
    block.forEach((line, dr) => line.forEach((cell, dc) => {
      const t = fobCellTarget(s.r1 + dr, s.c1 + dc);
      if (t) fobStage(t, cell); else skipped++;
    }));
  }
  fobPaintBoard();
  if (skipped) toast('粘贴时 ' + skipped + ' 个格子超出范围，已忽略', 'warn');
}
function fobSavePending() {
  const n = Object.keys(fobW.pending).length;
  if (!n) return;
  const nSet = Object.values(fobW.pending).filter(v => v != null).length;
  fobConfirm('保存到看板', '保存 ' + n + ' 处修改？\n　· 写入/修改 ' + nSet + ' 个格子\n　· 清空 ' + (n - nSet) + ' 个格子\n\n手工值叠在所有刷新之上（看板里显示为绿底）。\n注意：以后刷新到同一个月份时，这些手工值会挡住导出的真实值 ——\n导入时软件会点名提示，也可以右键「清除该行手工值」。', () => {
    fobW.store.setOverrides(fobW.pending);
    fobW.pending = {};
    fobPaintBoard();
  });
}
function fobGuardPending(fn) {
  const n = Object.keys(fobW.pending).length;
  if (!n) return fn();
  fobConfirm('还有未保存的修改', '有 ' + n + ' 处修改还没保存，导出的内容不会包含它们。\n继续导出？', fn);
}

/* ---- 行操作 ---- */
function fobDeleteRow(key) {
  const name = fobW.store.displayName(key);
  fobConfirm('删除这一行', '把「' + name + '」从看板删掉？\n\n会清掉它的手工基线值和手工修改；导入过的原始快照仍然留档，\n以后可以在【回收站】里恢复。', () => {
    Object.keys(fobW.pending).forEach(k => { if (k.slice(0, k.lastIndexOf('|')) === key) delete fobW.pending[k]; });
    fobW.store.deleteModel(key);
    fobPaintBoard();
  });
}
function fobEnsureCustom() {
  if (fobOrder() === 'custom') return;
  const mtx = fobW.store.matrix(null, fobSelectedMonths(), null);
  const ordered = FobReports.sortKeys(fobW.store, mtx.keys, mtx.cells, mtx.months, fobOrder(), false);
  fobW.store.setManualOrder(ordered);
  fobW.store.setSettings({ boardOrder: 'custom' });
  const sel = fobQ('#fobOrder'); if (sel) sel.value = 'custom';
}
function fobRowsMoved(rows, to) {
  fobEnsureCustom();
  const keys = fobW.spec.rowMeta.slice();
  const moving = rows.filter(r => r >= 0 && r < keys.length).map(r => keys[r]);
  const anchorKey = (to >= 0 && to < keys.length) ? keys[to] : null;
  const rest = keys.filter(k => !moving.includes(k));
  const pos = anchorKey && rest.includes(anchorKey) ? rest.indexOf(anchorKey) : rest.length;
  fobW.store.setManualOrder(rest.slice(0, pos).concat(moving, rest.slice(pos)));
  fobPaintBoard();
}
function fobRowMenu(e, r) {
  const spec = fobW.spec;
  const key = spec.rowMeta[r];
  const name = fobW.store.displayName(key);
  const cats = [...new Set(FOB_PRESET_CATS.concat(fobW.store.categories()))].filter(c => c !== FobStore.UNCATEGORIZED);
  const items = cats.map(c => ['品类 → ' + c, () => { fobW.store.setModelCategory(key, c); renderFob(); }])
    .concat([
      ['品类 → 其它…', () => { const v = prompt('品类名称：'); if (v != null) { fobW.store.setModelCategory(key, v); renderFob(); } }],
      ['sep'],
      ['上移一行', () => fobRowsMoved([r], Math.max(0, r - 1))],
      ['下移一行', () => fobRowsMoved([r], Math.min(spec.rowMeta.length - 1, r + 1))],
      ['移到最上', () => fobRowsMoved([r], 0)],
      ['移到最下', () => fobRowsMoved([r], spec.rowMeta.length - 1)],
      ['sep'],
      ['合并到另一个型号…（同一个产品两种写法）', () => fobMergeDlg(key)],
      ['清除该行的手工值（恢复成导出数据）', () => { const n = fobW.store.clearOverrides(key); fobPaintBoard(); toast('清掉了 ' + n + ' 个手工值', 'ok'); }],
      ['删除该行', () => fobDeleteRow(key)],
    ]);
  fobMenu(e.clientX, e.clientY, [['「' + name + '」', null], ['sep']].concat(items));
}

/* ============================================================
   ③ 差异看板
   ============================================================ */
function fobRenderDiff(body) {
  const st = fobW.store;
  const snaps = st.listSnapshots().filter(s => s.applied).reverse();
  const cats = ['全部'].concat(st.categories());
  body.innerHTML = ''
    + '<div class="fob-bar">对比这次刷新 <select id="fobDSnap" style="min-width:260px">' + snaps.map(s => '<option value="' + s.id + '"' + (s.id === fobW.diffSnapId ? ' selected' : '') + '>' + fobEsc(s.label) + '　(' + s.monthRange + '　' + s.createdAt.slice(0, 16).replace('T', ' ') + ')</option>').join('') + '</select>'
    + '  显示 <select id="fobDMode">' + [['delta', '差值（本次 − 上一版）'], ['pct', '变动幅度 %'], ['new', '本次值']].map(m => '<option value="' + m[0] + '"' + (m[0] === fobW.diffMode ? ' selected' : '') + '>' + m[1] + '</option>').join('') + '</select>'
    + '  品类 <select id="fobDCat">' + cats.map(c => '<option' + (c === fobW.diffCat ? ' selected' : '') + '>' + fobEsc(c) + '</option>').join('') + '</select>'
    + '  <span class="fob-note">排序跟随看板页的设置</span></div>'
    + '<div class="fob-status" id="fobDStatus"></div>'
    + '<div class="fob-wrap"><table class="fob-t" id="fobDiffT"></table></div>'
    + '<div class="fob-bar"><span class="fob-note">红 = 成本上升　绿 = 成本下降　蓝 = 本次新增　灰 = 本次未刷新（看板沿用旧值）</span><span style="flex:1"></span>'
    + '  <button class="btn" id="fobDCopy">复制</button><button class="btn" id="fobDPng">只导出这张差异表 PNG</button>'
    + '  <button class="fob-primary" id="fobDBundle">一键导出本次刷新（PPT + PNG + Excel）</button></div>';
  fobQ('#fobDSnap').onchange = () => { fobW.diffSnapId = +fobQ('#fobDSnap').value; fobRenderDiff(body); };
  fobQ('#fobDMode').onchange = () => { fobW.diffMode = fobQ('#fobDMode').value; fobRenderDiff(body); };
  fobQ('#fobDCat').onchange = () => { fobW.diffCat = fobQ('#fobDCat').value; fobRenderDiff(body); };
  const sid = fobW.diffSnapId != null && snaps.some(s => s.id === fobW.diffSnapId) ? fobW.diffSnapId : (snaps.length ? snaps[0].id : null);
  fobW.diffSnapId = sid;
  const view = FobReports.buildDiff(st, sid);
  const hasSnap = !!view.snapshot;
  fobQ('#fobDBundle').disabled = !hasSnap;
  if (!hasSnap) {
    fobStatus('fobDStatus', '还没有任何刷新记录。先到「导入刷新」页贴一列数据。', 'warn');
    fobQ('#fobDiffT').innerHTML = '';
    return;
  }
  const cat = fobW.diffCat && fobW.diffCat !== '全部' ? fobW.diffCat : null;
  const spec = FobReports.diffSpec(st, view, { decimals: st.getSettings().decimals || 0, mode: fobW.diffMode, order: fobOrder(), category: cat });
  fobFillPlainTable(fobQ('#fobDiffT'), spec);
  const s = view.summary;
  let text = view.snapshot.label + '　对比基准：' + view.prevLabel + '　月份 ' + view.snapshot.monthRange
    + '\n上升 ' + s.up + '　下降 ' + s.down + '　持平 ' + s.same + '　新增 ' + s.new + '　未刷新 ' + s.gone;
  if (s.gone) {
    const goneModels = [...new Set(view.diffs.filter(d => d.status === 'gone').map(d => d.modelKey))].sort();
    text += '\n本次导出里没有这些型号，看板沿用了旧值：' + goneModels.slice(0, 6).map(k => st.displayName(k)).join('、') + (goneModels.length > 6 ? '…' : '');
  }
  fobStatus('fobDStatus', text, s.gone ? 'warn' : 'ok');
  fobQ('#fobDCopy').onclick = () => { fobCopyText(FobReports.specToTsv(spec)); toast('差异表已复制，可直接贴进 Excel', 'ok'); };
  fobQ('#fobDPng').onclick = () => fobExportPng(spec, 'Floor FOB差异.png');
  fobQ('#fobDBundle').onclick = () => fobExportBundle(view);
}

/* 一键导出:选了「全部」按品类各出一份(先总表再各品类);选了具体品类只出那一份 */
async function fobExportBundle(view) {
  const st = fobW.store;
  const set = st.getSettings();
  const dec = set.decimals || 0;
  const snap = view.snapshot;
  const dir = await api.pickDir();
  if (!dir || !dir.dir) return;
  const tag = FobCore.M.label(snap.startMonth) + '_' + snap.id;
  const order = fobOrder();
  const catSel = fobW.diffCat && fobW.diffCat !== '全部' ? fobW.diffCat : null;
  let cats = catSel ? [catSel] : (st.categories().length ? st.categories() : [null]);
  if (cats.length > 1) cats = [null].concat(cats);
  const boards = [], deltas = [], pcts = [], pngJobs = [];
  for (const cat of cats) {
    const suffix = cat ? '_' + cat : '';
    const b = FobReports.boardSpec(st, { decimals: dec, order, category: cat, subtitle: '截至 ' + snap.label + '（' + snap.monthRange + '）' });
    if (!b.rows.length) continue;
    const dd = FobReports.diffSpec(st, view, { decimals: dec, mode: 'delta', order, category: cat });
    const dp = FobReports.diffSpec(st, view, { decimals: dec, mode: 'pct', order, category: cat });
    boards.push(b); deltas.push(dd); pcts.push(dp);
    pngJobs.push(['看板' + suffix, b], ['差值' + suffix, dd], ['变动幅度' + suffix, dp]);
  }
  const files = [];
  for (const [name, spec] of pngJobs) {
    const b64 = fobRenderPngB64(spec, set.pngScale || 2);
    const r = await api.saveFileAt(dir.dir, 'Floor FOB_' + tag + '_' + name + '.png', b64);
    if (r && r.path) files.push(r.path); else if (r && r.error) { toast(r.error, 'err'); return; }
  }
  const pptB64 = await fobBuildPptB64(view, boards, deltas, set.exportPctSheet !== false ? pcts : []);
  const rp = await api.saveFileAt(dir.dir, 'Floor FOB_' + tag + '.pptx', pptB64);
  if (rp && rp.path) files.push(rp.path);
  const xb64 = fobBuildXlsxB64(boards[0], deltas[0]);
  const rx = await api.saveFileAt(dir.dir, 'Floor FOB_' + tag + '.xlsx', xb64);
  if (rx && rx.path) files.push(rx.path);
  toast('已导出 ' + files.length + ' 个文件', 'ok');
  api.openFolder(dir.dir);
}

/* ============================================================
   ④ 历史版本
   ============================================================ */
function fobRenderHist(body) {
  const st = fobW.store;
  const snaps = st.listSnapshots();
  body.innerHTML = ''
    + '<div class="fob-note" style="margin:4px 0">看板 = 手工基线 + 各次刷新按顺序叠加。撤销某次刷新只是把它从叠加序列里摘掉，数据仍在库里，随时可以重新应用。</div>'
    + '<div class="fob-wrap"><table class="fob-t"><thead><tr>' + ['#', '刷新名称', '月份范围', '覆盖起点', '型号数', '状态', '写入时间', '操作'].map(c => '<th>' + c + '</th>').join('') + '</tr></thead><tbody>'
    + snaps.map(s => '<tr>'
      + '<td class="ac">' + s.id + '</td><td class="al" style="font-weight:600">' + fobEsc(s.label) + '</td>'
      + '<td class="ac">' + s.monthRange + '</td><td class="ac">' + FobCore.M.label(s.applyFrom) + '</td>'
      + '<td class="ar">' + s.nProducts + '</td>'
      + '<td class="ac ' + (s.applied ? 'st-down' : 'st-gone') + '">' + (s.applied ? '已应用' : '已撤销') + '</td>'
      + '<td class="ac">' + s.createdAt.replace('T', ' ') + '</td>'
      + '<td class="ac"><button class="btn" data-raw="' + s.id + '">原始粘贴</button> <button class="btn" data-ren="' + s.id + '">重命名</button> '
      + '<button class="btn" data-tog="' + s.id + '">' + (s.applied ? '撤销' : '重新应用') + '</button> <button class="btn" data-rm="' + s.id + '">删除</button></td>'
      + '</tr>').join('')
    + '</tbody></table></div>';
  body.querySelectorAll('[data-raw]').forEach(b => b.onclick = () => {
    const raw = st.snapshotRaw(+b.dataset.raw);
    fobDialog('原始粘贴内容 — ' + fobEsc(raw.label),
      '<div class="fob-note">共 ' + raw.rawText.split('\n').length.toLocaleString() + ' 行。留档是为了以后口径变了还能重算。</div>'
      + '<textarea readonly style="width:560px;height:420px;font:11px/1.4 Consolas,monospace;white-space:pre">' + fobEsc(raw.rawText) + '</textarea>');
  });
  body.querySelectorAll('[data-ren]').forEach(b => b.onclick = () => {
    const id = +b.dataset.ren;
    const cur = st.listSnapshots().find(s => s.id === id);
    const v = prompt('刷新名称：', cur ? cur.label : '');
    if (v && v.trim()) { st.renameSnapshot(id, v.trim()); fobRenderHist(body); }
  });
  body.querySelectorAll('[data-tog]').forEach(b => b.onclick = () => {
    const id = +b.dataset.tog;
    const cur = st.listSnapshots().find(s => s.id === id);
    st.setApplied(id, !cur.applied);
    fobRenderHist(body);
  });
  body.querySelectorAll('[data-rm]').forEach(b => b.onclick = () => {
    const id = +b.dataset.rm;
    const cur = st.listSnapshots().find(s => s.id === id);
    fobConfirm('确认删除', '删除「' + cur.label + '」？\n这会连同它的原始粘贴内容一起删掉，无法恢复。\n如果只是想让它不生效，用「撤销」而不是删除。', () => { st.deleteSnapshot(id); fobRenderHist(body); });
  });
}

/* ============================================================
   ⑤ 历史基线
   ============================================================ */
function fobRenderBase(body) {
  body.innerHTML = ''
    + '<div class="fob-note" style="margin:4px 0">这里录入的是「历史月份」的 Floor FOB —— 它垫在所有刷新的最底层，任何一次刷新只要不覆盖到某个月份，那个月就一直显示这里的值。</div>'
    + '<div style="display:flex;gap:14px">'
    + '  <div style="flex:3;display:flex;flex-direction:column"><div style="font-weight:600">粘贴历史 Floor FOB 宽表</div>'
    + '    <textarea class="fob-paste" id="fobBasePaste" placeholder="从你原来的 Excel 里连表头一起复制过来，第一列放产品型号，后面每列一个月：\n\n    产品型号        Dec-25   Jan-26   Feb-26 …\n    Tarvos-W09DK      489      501      511\n\n月份表头写 Dec-25、2025-12、202512、2025年12月 都认得；空格子留空即可。"></textarea>'
    + '    <div class="fob-bar"><button class="btn" id="fobBaseTpl">复制空白模板</button><button class="btn" id="fobBaseCur">导出当前基线</button></div></div>'
    + '  <div style="flex:4"><div style="font-weight:600">解析预览</div>'
    + '    <div class="fob-status" id="fobBaseStatus"></div>'
    + '    <div class="fob-wrap" style="max-height:calc(100vh - 380px)"><table class="fob-t" id="fobBaseT"></table></div>'
    + '    <div class="fob-bar"><span style="flex:1"></span>'
    + '      <button class="btn" id="fobBaseMerge" disabled>合并写入（同型号同月覆盖，其余保留）</button>'
    + '      <button class="btn" id="fobBaseReplace" disabled>清空后写入</button></div></div>'
    + '</div>';
  fobQ('#fobBasePaste').oninput = () => { clearTimeout(fobW.baseTimer); fobW.baseTimer = setTimeout(fobBaseParse, 350); };
  fobQ('#fobBaseTpl').onclick = () => {
    const cur = FobCore.M.current();
    const months = FobCore.M.series(FobCore.M.add(cur, -8), 9);
    const mtx = fobW.store.matrix(null, null, null);
    const info = fobW.store.modelInfo();
    const lines = ['产品型号\t' + months.map(FobCore.M.label).join('\t')];
    (mtx.keys.length ? mtx.keys : ['Tarvos-W09DK']).forEach(k => lines.push(((info[k] || {}).display || k) + '\t'.repeat(months.length)));
    fobCopyText(lines.join('\n'));
    toast('空白模板已复制。贴进 Excel 填好后整块复制回来即可', 'ok');
  };
  fobQ('#fobBaseCur').onclick = () => {
    const cells = fobW.store.baselineCells();
    if (!Object.keys(cells).length) { toast('当前还没有录入任何历史基线', 'warn'); return; }
    const months = [...new Set(Object.keys(cells).map(k => +k.slice(k.lastIndexOf('|') + 1)))].sort((a, b) => a - b);
    const keys = [...new Set(Object.keys(cells).map(k => k.slice(0, k.lastIndexOf('|'))))].sort();
    const info = fobW.store.modelInfo();
    const lines = ['产品型号\t' + months.map(FobCore.M.label).join('\t')];
    keys.forEach(k => lines.push(((info[k] || {}).display || k) + '\t' + months.map(m => cells[k + '|' + m] != null ? cells[k + '|' + m].toFixed(2) : '').join('\t')));
    fobCopyText(lines.join('\n'));
    toast(keys.length + ' 个型号 × ' + months.length + ' 个月已复制', 'ok');
  };
  const doWrite = replace => {
    const bp = fobW.basePaste;
    if (!bp) return;
    fobConfirm('确认', (replace ? '清空原有基线后写入' : '合并写入') + ' ' + bp.cellCount.toLocaleString() + ' 个数值？', () => {
      const cells = {};
      bp.rows.forEach(([model, vals]) => {
        const key = fobW.store.ensureModel(model);
        Object.keys(vals).forEach(m => { cells[key + '|' + m] = vals[m]; });
      });
      fobW.store.setBaseline(cells, replace);
      toast('已写入 ' + Object.keys(cells).length.toLocaleString() + ' 个格子', 'ok');
    });
  };
  fobQ('#fobBaseMerge').onclick = () => doWrite(false);
  fobQ('#fobBaseReplace').onclick = () => doWrite(true);
}
function fobBaseParse() {
  const raw = fobQ('#fobBasePaste').value;
  fobW.basePaste = null;
  fobQ('#fobBaseMerge').disabled = true;
  fobQ('#fobBaseReplace').disabled = true;
  if (!raw.trim()) { fobStatus('fobBaseStatus', ''); fobQ('#fobBaseT').innerHTML = ''; return; }
  let bp;
  try { bp = FobCore.parseBoardTable(raw); }
  catch (e) { fobStatus('fobBaseStatus', String(e.message || e), 'error'); fobQ('#fobBaseT').innerHTML = ''; return; }
  fobW.basePaste = bp;
  const known = fobW.store.modelInfo();
  const unknown = bp.rows.map(r => r[0]).filter(m => !known[FobCore.normalizeModelKey(m)]);
  let msg = bp.rows.length + ' 个型号 × ' + bp.months.length + ' 个月，共 ' + bp.cellCount.toLocaleString() + ' 个数值　(' + FobCore.M.label(bp.months[0]) + ' ~ ' + FobCore.M.label(bp.months[bp.months.length - 1]) + ')';
  if (bp.warnings.length) msg += '\n' + bp.warnings.join('；');
  if (unknown.length) msg += '\n其中 ' + unknown.length + ' 个型号在系统导出里还没出现过：' + unknown.slice(0, 6).join('、') + (unknown.length > 6 ? '…' : '') + '\n（不影响写入；等它们出现在刷新数据里就会自动对上）';
  fobStatus('fobBaseStatus', msg, (bp.warnings.length || unknown.length) ? 'warn' : 'ok');
  let h = '<thead><tr><th>产品型号</th>' + bp.months.map(m => '<th>' + FobCore.M.label(m) + '</th>').join('') + '</tr></thead><tbody>';
  bp.rows.forEach(([model, vals]) => {
    h += '<tr><td class="al" style="font-weight:600">' + fobEsc(model) + '</td>' + bp.months.map(m => '<td class="ar">' + FobReports.fmtValue(vals[m] != null ? vals[m] : null, 0) + '</td>').join('') + '</tr>';
  });
  fobQ('#fobBaseT').innerHTML = h + '</tbody>';
  fobQ('#fobBaseMerge').disabled = false;
  fobQ('#fobBaseReplace').disabled = false;
}

/* ============================================================
   对话框 / 菜单 / 工具
   ============================================================ */
function fobDialog(titleHtml, bodyHtml, buttons) {
  document.querySelectorAll('#view-fob .fob-dlg-mask').forEach(x => x.remove());
  const mask = document.createElement('div');
  mask.className = 'fob-dlg-mask';
  mask.innerHTML = '<div class="fob-dlg"><div style="font-weight:700;margin-bottom:8px">' + titleHtml + '</div>'
    + '<div class="fob-dlg-body">' + bodyHtml + '</div>'
    + '<div style="display:flex;gap:8px;justify-content:flex-end;margin-top:12px">'
    + (buttons || [['关闭', null, false]]).map((b, i) => '<button class="' + (b[2] ? 'fob-primary' : 'btn') + '" data-btn="' + i + '">' + b[0] + '</button>').join('')
    + '</div></div>';
  const host = document.getElementById('view-fob');
  host.appendChild(mask);
  mask.onclick = e => { if (e.target === mask) mask.remove(); };
  (buttons || [['关闭', null, false]]).forEach((b, i) => {
    mask.querySelector('[data-btn="' + i + '"]').onclick = () => { mask.remove(); if (b[1]) b[1](); };
  });
  return mask;
}
function fobConfirm(title, msg, onYes) {
  fobDialog(fobEsc(title), '<div style="white-space:pre-wrap;font-size:12px">' + fobEsc(msg) + '</div>',
    [['取消', null, false], ['确认', onYes, true]]);
}
function fobMenu(x, y, items) {
  document.querySelectorAll('#view-fob .fob-menu').forEach(m => m.remove());
  const menu = document.createElement('div');
  menu.className = 'fob-menu';
  items.forEach(it => {
    const d = document.createElement('div');
    if (it[0] === 'sep') { d.className = 'sep'; }
    else {
      d.textContent = it[0];
      if (it[1]) d.onclick = () => { menu.remove(); it[1](); };
      else d.style.cssText = 'color:var(--ink3);cursor:default;font-weight:600';
    }
    menu.appendChild(d);
  });
  menu.style.left = Math.min(x, window.innerWidth - 260) + 'px';
  menu.style.top = Math.min(y, window.innerHeight - items.length * 26 - 20) + 'px';
  document.getElementById('view-fob').appendChild(menu);
  const close = e => { if (!menu.contains(e.target)) { menu.remove(); document.removeEventListener('mousedown', close, true); } };
  setTimeout(() => document.addEventListener('mousedown', close, true), 0);
}
function fobFillPlainTable(tbl, spec) {
  let h = '<thead><tr>' + spec.columns.map(c => '<th>' + c + '</th>').join('') + '</tr></thead><tbody>';
  spec.rows.forEach(row => {
    h += '<tr>' + row.map(cell => '<td class="a' + cell.align + (cell.status !== 'none' ? ' st-' + cell.status : '') + '"' + (cell.bold ? ' style="font-weight:600"' : '') + '>' + fobEsc(cell.text) + '</td>').join('') + '</tr>';
  });
  tbl.innerHTML = h + '</tbody>';
}
function fobCopyText(text) {
  const ta = document.createElement('textarea');
  ta.value = text;
  document.body.appendChild(ta);
  ta.select();
  document.execCommand('copy');
  ta.remove();
}

/* ---- 新增型号 / 合并 / 回收站 / 设置 / 帮助 / 备份 / 示例 ---- */
function fobAddModelDlg() {
  const cats = [...new Set(FOB_PRESET_CATS.concat(fobW.store.categories()))].filter(c => c !== FobStore.UNCATEGORIZED);
  const mask = fobDialog('新增型号',
    '<div class="fob-note">加进来之后，直接在看板上把 Floor FOB 填/粘进去，再点【保存修改】。<br>以后这个型号出现在导出数据里时会自动对上（按型号名归一化匹配）。</div>'
    + '<div class="fob-bar">产品型号 * <input type="text" id="fobAmName" style="width:220px" placeholder="例如：Torvin-W09XX"></div>'
    + '<div class="fob-bar">产品系列 <input type="text" id="fobAmSeries" style="width:220px" placeholder="例如：Slate Pro"></div>'
    + '<div class="fob-bar">品类 <input type="text" id="fobAmCat" list="fobAmCatL" style="width:150px" value="' + fobEsc(fobBoardCat() || '') + '"><datalist id="fobAmCatL">' + cats.map(c => '<option value="' + fobEsc(c) + '">').join('') + '</datalist></div>',
    [['取消', null, false], ['确定', null, true]]);
  // 确定按钮要读 mask 里的输入值,单独接
  mask.querySelector('[data-btn="1"]').onclick = () => {
    const name = mask.querySelector('#fobAmName').value.trim();
    const series = mask.querySelector('#fobAmSeries').value.trim();
    const cat = mask.querySelector('#fobAmCat').value.trim();
    if (!name) { toast('型号名不能为空', 'err'); return; }
    mask.remove();
    const key = fobW.store.addManualModel(name, series, cat);
    fobW.filter = '';
    if (cat) fobW.boardCat = cat;
    renderFob();
    toast('已新增：' + name + (key ? '' : ''), 'ok');
  };
  mask.querySelector('#fobAmName').focus();
}
function fobMergeDlg(srcKey) {
  const st = fobW.store;
  const srcName = st.displayName(srcKey);
  const info = st.modelInfo();
  const others = Object.keys(info).filter(k => k !== srcKey && !info[k].hidden)
    .map(k => [info[k].display || k, k]).sort((a, b) => a[0].localeCompare(b[0]));
  if (!others.length) { toast('库里只有这一个型号', 'warn'); return; }
  const mask = fobDialog('合并到另一个型号',
    '<div class="fob-note">把「' + fobEsc(srcName) + '」并到下面选中的型号上。用于同一个产品在旧看板和导出里写法不同的情况。</div>'
    + '<input type="text" id="fobMgSearch" style="width:100%;margin:6px 0" placeholder="搜索型号…">'
    + '<select id="fobMgList" size="12" style="width:100%">' + others.map(o => '<option value="' + fobEsc(o[1]) + '">' + fobEsc(o[0]) + '</option>').join('') + '</select>',
    [['取消', null, false], ['合并', null, true]]);
  const search = mask.querySelector('#fobMgSearch');
  const list = mask.querySelector('#fobMgList');
  search.oninput = () => {
    const t = search.value.trim().toLowerCase();
    list.innerHTML = others.filter(o => !t || o[0].toLowerCase().includes(t)).map(o => '<option value="' + fobEsc(o[1]) + '">' + fobEsc(o[0]) + '</option>').join('');
    if (list.options.length) list.selectedIndex = 0;
  };
  if (list.options.length) list.selectedIndex = 0;
  mask.querySelector('[data-btn="1"]').onclick = () => {
    const dstKey = list.value;
    if (!dstKey) return;
    const dstName = st.displayName(dstKey);
    mask.remove();
    fobConfirm('确认合并',
      '把「' + srcName + '」并进「' + dstName + '」？\n\n· ' + srcName + ' 的历史值、手工值、各次刷新数据全部并过去\n· 同一个月两边都有值时，保留 ' + dstName + ' 的（它来自导出，更可信）\n· 以后导出里再出现「' + srcName + '」会自动算成「' + dstName + '」\n\n合并不能自动撤销（快照里的型号原文仍然留档）。',
      () => {
        const stats = st.mergeModel(srcKey, dstKey);
        Object.keys(fobW.pending).forEach(k => { if (k.slice(0, k.lastIndexOf('|')) === srcKey) delete fobW.pending[k]; });
        fobPaintBoard();
        fobDialog('合并完成', '<div style="font-size:12px">「' + fobEsc(srcName) + '」→「' + fobEsc(dstName) + '」<br><br>搬过去：历史值 ' + stats.baseline + ' 个、手工值 ' + stats.override + ' 个、刷新数据 ' + stats.snapshotValues + ' 个格子（' + stats.snapshotRows + ' 条产品记录）。</div>');
      });
  };
  search.focus();
}
function fobShowTrash() {
  const rows = fobW.store.hiddenModels();
  if (!rows.length) { toast('没有已删除的型号', 'ok'); return; }
  const mask = fobDialog('回收站 — 已删除的型号',
    '<div class="fob-note">选中后点【恢复】。恢复后它在各次刷新里的数据会重新出现在看板上。</div>'
    + '<select id="fobTrashList" size="10" style="width:100%;margin-top:6px">' + rows.map(r => '<option value="' + fobEsc(r.key) + '">' + fobEsc(r.display) + '　(' + fobEsc(r.series || '无系列') + ')</option>').join('') + '</select>',
    [['关闭', null, false], ['恢复选中', null, true]]);
  mask.querySelector('[data-btn="1"]').onclick = () => {
    const key = mask.querySelector('#fobTrashList').value;
    if (!key) return;
    fobW.store.restoreModel(key);
    mask.remove();
    renderFob();
    toast('已恢复', 'ok');
  };
}
function fobShowSettings() {
  const set = fobW.store.getSettings();
  const mask = fobDialog('设置',
    '<div class="fob-bar">看板小数位 <input type="number" id="fobSetDec" style="width:60px" min="0" max="2" value="' + (set.decimals || 0) + '"></div>'
    + '<div class="fob-bar">PNG 清晰度(倍) <input type="number" id="fobSetScale" style="width:60px" min="1" max="4" step="0.5" value="' + (set.pngScale || 2) + '"></div>'
    + '<div class="fob-bar">PPT 每页行数 <input type="number" id="fobSetRows" style="width:60px" min="6" max="40" value="' + (set.rowsPerSlide || 16) + '"></div>'
    + '<div class="fob-bar"><label><input type="checkbox" id="fobSetPct" ' + (set.exportPctSheet !== false ? 'checked' : '') + '> 一键导出时附「变动幅度」表</label></div>',
    [['取消', null, false], ['保存', null, true]]);
  mask.querySelector('[data-btn="1"]').onclick = () => {
    fobW.store.setSettings({
      decimals: Math.max(0, Math.min(2, +mask.querySelector('#fobSetDec').value || 0)),
      pngScale: Math.max(1, Math.min(4, +mask.querySelector('#fobSetScale').value || 2)),
      rowsPerSlide: Math.max(6, Math.min(40, +mask.querySelector('#fobSetRows').value || 16)),
      exportPctSheet: mask.querySelector('#fobSetPct').checked,
    });
    mask.remove();
    renderFob();
  };
}
async function fobBackup() {
  const json = JSON.stringify(fobW.store.serialize(), null, 1);
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  const name = 'fob-backup_' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '.json';
  const r = await api.saveFile(name, api.b64 ? api.b64(json) : btoa(unescape(encodeURIComponent(json))), 'json');
  if (r && r.path) toast('已备份到 ' + r.path, 'ok');
}
function fobLoadDemo() {
  fobConfirm('载入示例数据', '把 22 个型号的示例导出贴进「导入刷新」页（不会自动写入看板，你可以先看解析结果再决定）。', () => {
    fobW.tab = 'import';
    renderFob();
    const ta = fobQ('#fobPaste');
    if (ta && typeof FobSample !== 'undefined') {
      ta.value = FobSample.toColumn();
      fobQ('#fobStart').value = FobSample.START_MONTH;
      fobQ('#fobApplyFrom').value = FobSample.START_MONTH;
      fobQ('#fobLines').textContent = ta.value.split('\n').length.toLocaleString() + ' 行';
      fobDoParse();
    }
  });
}
function fobShowHelp() {
  fobDialog('Floor FOB 刷新器 — 怎么用',
    '<div style="font-size:12px;line-height:1.7;max-width:560px">'
    + '<b>每月三步：</b><br>① 导入刷新：把系统导出的那一整列 Ctrl+V 贴进左边，右边立刻出解析结果。<br>'
    + '② 核对<b>第一个月份列</b>（销毛率里「生效当月」那列<u>不算</u>，它后面第一列才是），需要时改覆盖起点，点【计算并写入看板】。<br>'
    + '③ 差异看板 → 【一键导出本次刷新】，PPT + PNG + Excel 一次出齐。<br><br>'
    + '<b>Floor FOB = 授权价 × (1 − 该月销毛率)</b>，销毛率为负时价格高于授权价，正常。<br><br>'
    + '历史月份第一次用时去【⑤ 历史基线】贴一次，之后它一直垫在底下。<br>'
    + '看板可直接编辑：双击改、Ctrl+C/V、Delete 清空；改动先攒着（蓝底），【保存修改】才落库；'
    + '保存后的手工值（绿底）叠在所有刷新之上，刷新时会点名提示哪些被挡。<br>'
    + '同一个产品两种写法 → 右键 →「合并到另一个型号」，搬数据 + 记别名一步完成，什么时候做都对。<br>'
    + '撤销安全：看板 = 基线 + 各次刷新按顺序叠加算出来的，撤销只是摘掉重算。</div>');
}

/* ============================================================
   导出:PNG(canvas) / PPT(PptxGenJS) / Excel(XLSX)
   三种输出与界面同一个 spec、同一套配色。
   ============================================================ */
function fobRenderPngB64(spec, scale) {
  const T = FobReports.THEME;
  const PAD = 18, ROW_H = 26, HEAD_H = 30, TITLE_H = spec.title ? 34 : 0, SUB_H = spec.subtitle ? 22 : 0, FOOT_H = spec.footer ? 22 : 0, LEG_H = spec.legend.length ? 24 : 0;
  const cv = document.createElement('canvas');
  const ctx = cv.getContext('2d');
  const font = px => px + 'px "Microsoft YaHei", SimHei, sans-serif';
  // 列宽:按内容量
  ctx.font = font(12);
  const colW = spec.columns.map((c, i) => {
    let w = ctx.measureText(c).width;
    spec.rows.forEach(row => { if (row[i]) w = Math.max(w, ctx.measureText(row[i].text).width); });
    return Math.ceil(w) + 18;
  });
  const W = PAD * 2 + colW.reduce((a, b) => a + b, 0);
  const H = PAD * 2 + TITLE_H + SUB_H + HEAD_H + spec.rows.length * ROW_H + LEG_H + FOOT_H;
  cv.width = Math.ceil(W * scale); cv.height = Math.ceil(H * scale);
  ctx.scale(scale, scale);
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, W, H);
  let y = PAD;
  if (spec.title) { ctx.fillStyle = '#' + T.TITLE; ctx.font = 'bold ' + font(17); ctx.fillText(spec.title, PAD, y + 18); y += TITLE_H; }
  if (spec.subtitle) { ctx.fillStyle = '#' + T.MUTED; ctx.font = font(11); ctx.fillText(spec.subtitle, PAD, y + 13); y += SUB_H; }
  // 表头
  let x = PAD;
  ctx.fillStyle = '#' + T.HEADER_BG;
  ctx.fillRect(PAD, y, W - PAD * 2, HEAD_H);
  ctx.font = 'bold ' + font(12);
  ctx.fillStyle = '#' + T.HEADER_FG;
  spec.columns.forEach((c, i) => {
    const align = spec.colAlign[i] || 'l';
    const tx = align === 'r' ? x + colW[i] - 9 - ctx.measureText(c).width : (align === 'c' ? x + (colW[i] - ctx.measureText(c).width) / 2 : x + 9);
    ctx.fillText(c, tx, y + 20);
    x += colW[i];
  });
  y += HEAD_H;
  // 行
  spec.rows.forEach((row, r) => {
    x = PAD;
    ctx.fillStyle = r % 2 ? '#' + T.ROW_ALT_BG : '#FFFFFF';
    ctx.fillRect(PAD, y, W - PAD * 2, ROW_H);
    row.forEach((cell, i) => {
      const st = T.STATUS[cell.status] || T.STATUS.none;
      if (cell.status !== 'none' && cell.status !== 'same') { ctx.fillStyle = '#' + st[0]; ctx.fillRect(x, y, colW[i], ROW_H); }
      ctx.fillStyle = '#' + st[1];
      ctx.font = (cell.bold ? 'bold ' : '') + font(12);
      const tw = ctx.measureText(cell.text).width;
      const align = cell.align || 'l';
      const tx = align === 'r' ? x + colW[i] - 9 - tw : (align === 'c' ? x + (colW[i] - tw) / 2 : x + 9);
      ctx.fillText(cell.text, tx, y + 18);
      x += colW[i];
    });
    ctx.strokeStyle = '#' + T.GRID;
    ctx.strokeRect(PAD, y, W - PAD * 2, ROW_H);
    y += ROW_H;
  });
  // 图例 + 脚注
  if (spec.legend.length) {
    x = PAD;
    ctx.font = font(11);
    spec.legend.forEach(([k, label]) => {
      const st = T.STATUS[k];
      ctx.fillStyle = '#' + st[0]; ctx.fillRect(x, y + 6, 14, 12);
      ctx.strokeStyle = '#' + T.GRID; ctx.strokeRect(x, y + 6, 14, 12);
      ctx.fillStyle = '#' + T.TEXT; ctx.fillText(label, x + 18, y + 16);
      x += 18 + ctx.measureText(label).width + 20;
    });
    y += LEG_H;
  }
  if (spec.footer) { ctx.fillStyle = '#' + T.MUTED; ctx.font = font(10); ctx.fillText(spec.footer, PAD, y + 13); }
  return cv.toDataURL('image/png').replace(/^data:image\/png;base64,/, '');
}
async function fobExportPng(spec, name) {
  if (!spec || !spec.rows.length) { toast('没有可导出的内容', 'warn'); return; }
  const b64 = fobRenderPngB64(spec, fobW.store.getSettings().pngScale || 2);
  const r = await api.saveFile(name, b64, 'png');
  if (r && r.path) toast('已导出 ' + r.path, 'ok');
}
async function fobBuildPptB64(view, boards, deltas, pcts) {
  const T = FobReports.THEME;
  const pptx = new PptxGenJS();
  pptx.defineLayout({ name: 'W', width: 13.333, height: 7.5 });
  pptx.layout = 'W';
  const FONT = '微软雅黑';
  const rowsPer = fobW.store.getSettings().rowsPerSlide || 16;
  // 摘要页
  const snap = view.snapshot;
  const s = view.summary;
  const [ups, downs] = FobReports.topMovers(view, fobW.store, 5);
  const bullets = [
    snap ? ('本次刷新：' + snap.label + '　覆盖 ' + snap.monthRange) : '本次刷新：—',
    '对比基准：' + view.prevLabel,
    '型号 ' + view.keys.length + ' 个　月份 ' + view.months.length + ' 个　格子 ' + view.diffs.length + ' 个（上升 ' + s.up + '／下降 ' + s.down + '／持平 ' + s.same + '／新增 ' + s.new + '／未刷新 ' + s.gone + '）',
    '',
  ];
  if (ups.length) { bullets.push('成本上升 Top（按首个刷新月）：'); ups.forEach(t => bullets.push('    • ' + t)); }
  if (downs.length) { bullets.push('成本下降 Top（按首个刷新月）：'); downs.forEach(t => bullets.push('    • ' + t)); }
  let sl = pptx.addSlide();
  sl.addText('Floor FOB 刷新摘要', { x: 0.4, y: 0.25, w: 12.5, h: 0.6, fontFace: FONT, fontSize: 22, bold: true, color: T.HEADER_BG });
  sl.addText(bullets.join('\n'), { x: 0.5, y: 1.0, w: 12.3, h: 5.6, fontFace: FONT, fontSize: 13, color: '202630', valign: 'top' });
  sl.addText('Floor FOB = 授权价 × (1 − 销毛率)', { x: 0.4, y: 7.0, w: 12.5, h: 0.35, fontFace: FONT, fontSize: 10, color: '808A98' });
  const addSpec = spec => {
    for (const part of FobReports.chunkRows(spec, rowsPer)) {
      const slide = pptx.addSlide();
      slide.addText(part.title, { x: 0.4, y: 0.2, w: 12.5, h: 0.45, fontFace: FONT, fontSize: 16, bold: true, color: T.HEADER_BG });
      slide.addText(part.subtitle || '', { x: 0.4, y: 0.62, w: 12.5, h: 0.3, fontFace: FONT, fontSize: 10, color: '808A98' });
      const data = [part.columns.map(c => ({ text: c, options: { bold: true, fill: T.HEADER_BG, color: 'FFFFFF' } }))]
        .concat(part.rows.map(row => row.map(cell => {
          const st = T.STATUS[cell.status] || T.STATUS.none;
          const o = { color: st[1], bold: !!cell.bold, align: cell.align === 'r' ? 'right' : cell.align === 'c' ? 'center' : 'left' };
          if (cell.status !== 'none' && cell.status !== 'same') o.fill = st[0];
          return { text: cell.text, options: o };
        })));
      const fr = _fitLib().fit(data, { availIn: 12.5, fontSize: 8.5, minFontSize: 6, minColIn: 0.26 });
      slide.addTable(fr.rows, _fitLib().tableOpts(fr, { x: (13.333 - fr.totalIn) / 2, y: 1.0,
        fontFace: FONT, border: { pt: 0.5, color: 'CED6E5' }, autoPage: false }));
    }
  };
  boards.forEach(addSpec);
  deltas.forEach(addSpec);
  (pcts || []).forEach(addSpec);
  return await pptx.write('base64');
}
async function fobExportPpt() {
  const view = FobReports.buildDiff(fobW.store);
  const spec = fobExportBoardSpec();
  const diff = view.snapshot ? FobReports.diffSpec(fobW.store, view, { decimals: fobW.store.getSettings().decimals || 0, order: fobOrder(), category: fobBoardCat() }) : { rows: [], columns: [], legend: [], rowMeta: [], months: [] };
  const b64 = await fobBuildPptB64(view, [spec], view.snapshot ? [diff] : [], []);
  const r = await api.saveFile('Floor FOB看板.pptx', b64, 'pptx');
  if (r && r.path) toast('已导出 ' + r.path, 'ok');
}
function fobBuildXlsxB64(board, diff) {
  const wb = XLSX.utils.book_new();
  const specToAoa = spec => {
    const aoa = [spec.columns];
    spec.rows.forEach(row => {
      aoa.push(row.map((cell, i) => {
        const t = cell.text;
        if (i >= spec.freezeCols && t && t !== '新增' && t !== '未刷新') {
          const v = Number(t.replace(/,/g, '').replace(/^\+/, '').replace(/%$/, ''));
          if (isFinite(v)) return v;
        }
        return t;
      }));
    });
    return aoa;
  };
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(specToAoa(board)), 'Floor FOB看板');
  if (diff && diff.rows.length) XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(specToAoa(diff)), '刷新差值');
  return XLSX.write(wb, { bookType: 'xlsx', type: 'base64' });
}
async function fobExportXlsx() {
  const view = FobReports.buildDiff(fobW.store);
  const diff = view.snapshot ? FobReports.diffSpec(fobW.store, view, { decimals: fobW.store.getSettings().decimals || 0, order: fobOrder(), category: fobBoardCat() }) : null;
  const b64 = fobBuildXlsxB64(fobExportBoardSpec(), diff);
  const r = await api.saveFile('Floor FOB看板.xlsx', b64, 'xlsx');
  if (r && r.path) toast('已导出 ' + r.path, 'ok');
}

// Node 冒烟:可 require 不执行 DOM(顶层零副作用)
if (typeof module !== 'undefined' && module.exports) module.exports = { fobW };

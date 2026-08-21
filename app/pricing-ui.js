// 「定价测算」视图控制器（渲染层）。依赖全局 PricingModel、ExportUtil、XLSX。
(function () {
  const M = window.PricingModel.create();
  window.PRICING_MODEL = M;
  const el = (id) => document.getElementById(id);
  const LS_KEY = 'sb.pricing.v4', LS_V3 = 'sb.pricing.v3';
  let showAcc = false;

  const COLS = [
    { k: 'sku', t: '产品', kind: 'sku', w: 128 },
    { k: 'customer', t: '客户', kind: 'account', w: 92 },
    { k: 'channel', t: '渠道', kind: 'text', w: 62 },
    { k: 'rrp', t: '含税RRP', kind: 'num', w: 76 },
    { k: 'retailFront', t: '零售前向', kind: 'pct', w: 58 },
    { k: 'fsdMargin', t: '物流点位', kind: 'pct', w: 58 },
    { k: 'retailRebate', t: '零售后返', kind: 'pct', w: 58 },
    { k: 'jointMkt', t: '联营', kind: 'pct', w: 50 },
    { k: 'sampleRate', t: '样机', kind: 'pct', w: 50 },
    { k: 'promoPrice', t: '促销价', kind: 'num', w: 70 },
    { k: 'coInvestSel', t: '对投档', kind: 'coinvest', w: 98 },
    { k: 'weight', t: '权重%', kind: 'pct', w: 56 },
    { k: 'costYm', t: '成本月份', kind: 'month', w: 82 },
  ];
  const FACTORS = [
    { k: 'fx', t: '汇率', kind: 'num' }, { k: 'vat', t: 'VAT', kind: 'pct' }, { k: 'shipping', t: '运保', kind: 'num' },
    { k: 'serviceRate', t: '基本服务', kind: 'pct' }, { k: 'excessiveRate', t: '超标', kind: 'pct' },
    { k: 'customsRate', t: '关税', kind: 'pct' }, { k: 'erBufferRate', t: '汇损', kind: 'pct' }, { k: 'hqRebate', t: 'hqRebate', kind: 'num' },
  ];

  const pct = (v) => (v == null ? '—' : (v * 100).toFixed(1) + '%');
  const usd = (v) => (v == null ? '—' : v.toFixed(1));
  const escA = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  const ymLabel = (ym) => Math.floor(ym / 100) + '/' + String(ym % 100).padStart(2, '0');
  const cellVal = (kind, v) => kind === 'pct' ? (v == null ? '' : +(v * 100).toFixed(4)) : (v == null ? '' : v);

  /* ---------- persistence ---------- */
  function persist() { try { localStorage.setItem(LS_KEY, JSON.stringify(M.serialize())); } catch (e) {} }
  function loadPersisted() {
    try {
      const v4 = JSON.parse(localStorage.getItem(LS_KEY) || 'null');
      if (v4) { M.load(v4); return; }
      const v3 = JSON.parse(localStorage.getItem(LS_V3) || 'null');
      if (v3) { M.migrateV3(v3); persist(); }
    } catch (e) {}
  }

  /* ---------- style ---------- */
  function ensureStyle() {
    if (el('px-style')) return;
    const css = `
    #pricingRoot{font-size:13px;color:var(--ink)}
    .px-h{display:flex;align-items:baseline;gap:12px;margin-bottom:12px;flex-wrap:wrap}
    .px-h h2{font-size:17px;font-weight:700}.px-h .sub{color:var(--ink3);font-size:12px}
    .px-tool{display:flex;align-items:center;gap:10px 14px;margin-bottom:14px;flex-wrap:wrap}
    .px-tool .lbl{font-size:12.5px;color:var(--ink2)}
    .px-info{font-size:12px;color:var(--ink3)}
    .px-spacer{flex:1}
    .px-acc{background:var(--panel);border:1px solid var(--line);border-radius:var(--radius);box-shadow:var(--shadow);padding:12px 16px;margin-bottom:14px}
    .px-acc h4{font-size:13px;margin-bottom:8px;color:var(--ink2)}
    .px-acc table{border-collapse:collapse;font-size:12px}
    .px-acc th{color:var(--ink3);font-weight:600;font-size:11px;padding:4px 8px;text-align:left}
    .px-acc td{padding:2px 6px}
    .px-acc input{border:1px solid var(--line);border-radius:6px;padding:4px 6px;font:inherit;font-size:12px;color:#0b57d0;text-align:right;width:64px}
    .px-acc input.nm{color:var(--ink);text-align:left;width:96px}
    .px-blk{background:var(--panel);border:1px solid var(--line);border-radius:var(--radius);box-shadow:var(--shadow);margin-bottom:16px}
    .px-blk-h{display:flex;align-items:center;gap:8px;padding:10px 14px;border-bottom:1px solid var(--line);flex-wrap:wrap}
    .px-caret{cursor:pointer;border:0;background:transparent;font-size:13px;color:var(--ink3);padding:2px 5px;border-radius:6px}
    .px-caret:hover{background:var(--c-brand-soft);color:var(--red)}
    .px-blk-h .cn{font-size:15px;font-weight:700;color:var(--ink);border:1px solid transparent;border-radius:7px;padding:3px 7px;width:140px;font-family:inherit}
    .px-blk-h .cn:hover{border-color:var(--line)}.px-blk-h .cn:focus{outline:none;border-color:var(--red);background:var(--c-bg-elev)}
    .px-blk-h .del{margin-left:auto}
    .px-fac{display:flex;flex-wrap:wrap;gap:8px 14px;align-items:flex-end;padding:10px 14px}
    .px-fac .ttl{font-weight:700;font-size:12px;color:var(--ink2);align-self:center;margin-right:2px}
    .px-fac .grp{display:flex;flex-direction:column;gap:3px}
    .px-fac .grp .lab{font-size:10px;color:var(--ink3)}
    .px-fac input{width:74px;border:1px solid var(--line);border-radius:6px;padding:5px 7px;font:inherit;font-size:12px;color:#0b57d0;text-align:right}
    .px-fac input:focus{outline:none;border-color:var(--red);box-shadow:0 0 0 3px rgba(199,0,11,.10)}
    .px-bundle{display:flex;flex-wrap:wrap;gap:6px 14px;align-items:center;padding:0 14px 10px;font-size:12px;color:var(--ink3)}
    .px-bundle .bi{display:flex;align-items:center;gap:4px}
    .px-bundle .bi input{width:60px;border:1px solid var(--line);border-radius:6px;padding:3px 6px;font:inherit;font-size:12px;color:#0b57d0;text-align:right}
    .px-scroll{overflow:auto;border-top:1px solid var(--line);background:var(--c-bg-elev)}
    table.px-tbl{border-collapse:separate;border-spacing:0;font-size:12px;width:100%}
    .px-tbl th{position:sticky;top:0;z-index:3;background:#FAFAFB;color:var(--ink2);font-weight:600;font-size:11px;padding:8px 6px;border-bottom:2px solid var(--line);white-space:nowrap;text-align:center}
    .px-tbl th.outp{background:#FFF4F4;color:var(--red-d)}
    .px-tbl th.mgh{background:var(--c-brand-soft);color:var(--red-d);font-weight:700;border-bottom:2px solid #F3C8C8}
    .px-tbl td{padding:3px 5px;border-bottom:1px solid #F2F3F5;text-align:center;white-space:nowrap}
    .px-tbl tr:hover td{background:var(--c-bg-sunken)}
    .px-in{width:100%;border:1px solid transparent;border-radius:6px;padding:4px 5px;font:inherit;font-size:12px;color:#0b57d0;text-align:right;background:transparent}
    .px-in.txt{text-align:left;color:var(--ink)}.px-in.acc{text-align:left;color:var(--ink);font-weight:600}
    .px-in:hover{border-color:var(--line)}.px-in:focus{outline:none;border-color:var(--red);box-shadow:0 0 0 2px rgba(199,0,11,.12);background:var(--c-bg-elev)}
    .px-msel{width:100%;border:1px solid transparent;border-radius:6px;padding:3px 4px;font:inherit;font-size:11.5px;background:transparent;color:var(--ink)}
    .px-msel:hover{border-color:var(--line)}.px-msel:focus{outline:none;border-color:var(--red)}
    .px-out{text-align:right;font-variant-numeric:tabular-nums;color:var(--ink);font-weight:600}.px-out.floor{color:var(--ink2);font-weight:500}
    .px-gm.pos{color:var(--c-good)}.px-gm.neg{color:var(--red)}
    .px-mg{font-size:13px;font-weight:800;background:#FFFAFA}.px-tbl tr:hover td.px-mg{background:var(--c-brand-soft)}
    .px-tbl.hide-floor .col-floor{display:none}
    .px-act{display:flex;gap:2px;justify-content:center}
    .px-ic{border:0;background:transparent;color:var(--ink3);cursor:pointer;font-size:12px;border-radius:6px;padding:2px 5px}
    .px-ic:hover{background:var(--c-brand-soft);color:var(--red)}
    .px-sum{padding:10px 14px;display:flex;align-items:center;gap:8px 18px;flex-wrap:wrap;border-top:1px solid var(--line)}
    .px-sum .grp{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
    .px-sum .sku{font-weight:700;color:var(--ink2);font-size:12px}
    .px-sum .it{display:flex;flex-direction:column;gap:1px}.px-sum .it .k{font-size:10px;color:var(--ink3)}.px-sum .it .v{font-size:14px;font-weight:700}
    .px-sum .ws{font-size:11px}
    .px-sum .addrow{margin-left:auto}
    .px-blk.collapsed .px-blk-body{display:none}
    .px-empty{padding:10px 14px;color:var(--ink3);font-size:12px}`;
    const s = document.createElement('style'); s.id = 'px-style'; s.textContent = css; document.head.appendChild(s);
  }

  /* ---------- 共享成本文件夹（数据源 costFolder）---------- */
  // 成本表统一来自「数据源」看板设置的成本文件夹（引擎持久化源）。打开看板/全局刷新时从 sosimSource() 自动读入。
  async function pxAutoLoadCost() {
    try {
      const src = await (window.sb && window.sb.sosimSource ? window.sb.sosimSource() : null);
      if (src && src.cost && src.cost.aoa) {
        const { skus } = M.importCost(src.cost.aoa);
        const info = el('pxCostInfo'); if (info) info.textContent = '成本底表 ' + skus + ' 个产品（数据源）';
        return skus;
      }
    } catch (e) {}
    return 0;
  }
  window.pxAutoLoadCost = pxAutoLoadCost;

  /* ---------- shell ---------- */
  async function renderPricing() {
    const root = el('pricingRoot'); if (!root) return; ensureStyle();
    if (root.dataset.built === '1') { await pxAutoLoadCost(); renderBlocks(); return; }
    root.dataset.built = '1';
    loadPersisted();
    root.innerHTML =
      '<div class="px-h"><h2>定价测算</h2><span class="sub">按国家分块·每国一行商务因子·块内可混算多产品·多国同时算</span></div>' +
      '<div class="px-tool">' +
        '<span class="px-info" id="pxCostInfo"></span>' +
        '<span class="px-spacer"></span>' +
        '<button class="btn" id="pxAcc">⚙ 客户预设</button>' +
        '<button class="btn" id="pxToggleFloor"></button>' +
        '<button class="btn" id="pxAddCountry">＋国家</button>' +
        '<button class="btn" id="pxExport">导出Excel</button>' +
        '<button class="btn primary" id="pxExportPpt">导出PPT</button>' +
      '</div>' +
      '<datalist id="pxAccounts"></datalist>' +
      '<div id="pxAccWrap"></div>' +
      '<div id="pxBlocks"></div>';
    el('pxAcc').addEventListener('click', () => { showAcc = !showAcc; renderAccPanel(); });
    el('pxToggleFloor').addEventListener('click', () => { M.state.showFloor = !M.state.showFloor; persist(); renderBlocks(); });
    el('pxAddCountry').addEventListener('click', () => { const n = M.addCountry(); persist(); renderBlocks(); const inp = document.querySelector('input.cn[data-c="' + cssEsc(n) + '"]'); if (inp) inp.focus(); });
    el('pxExport').addEventListener('click', exportXlsx);
    el('pxExportPpt').addEventListener('click', exportPpt);
    updateFloorBtn(); fillDatalist();
    await pxAutoLoadCost();
    renderBlocks();
  }
  function updateFloorBtn() { const b = el('pxToggleFloor'); if (b) b.textContent = M.state.showFloor ? '🙈 隐藏Floor cost' : '👁 显示Floor cost'; }

  function fillDatalist() { const dl = el('pxAccounts'); if (dl) dl.innerHTML = Object.keys(M.state.accounts).map(n => '<option value="' + escA(n) + '">').join(''); }

  /* ---------- account preset panel ---------- */
  function renderAccPanel() {
    const wrap = el('pxAccWrap'); if (!wrap) return;
    if (!showAcc) { wrap.innerHTML = ''; return; }
    const names = Object.keys(M.state.accounts);
    let h = '<div class="px-acc"><h4>客户预设（选客户自动带出；改完即存）</h4><table><tr><th>客户</th><th>渠道</th><th>零售前向%</th><th>物流点位%</th><th>零售后返%</th><th>联营%</th><th></th></tr>';
    names.forEach(n => {
      const a = M.state.accounts[n];
      h += '<tr data-n="' + escA(n) + '">' +
        '<td><input class="nm" data-f="name" value="' + escA(n) + '"></td>' +
        '<td><input data-f="channel" style="text-align:left;color:var(--ink)" value="' + escA(a.channel) + '"></td>' +
        '<td><input data-f="retailFront" value="' + +(a.retailFront * 100).toFixed(4) + '"></td>' +
        '<td><input data-f="fsdMargin" value="' + +(a.fsdMargin * 100).toFixed(4) + '"></td>' +
        '<td><input data-f="retailRebate" value="' + +(a.retailRebate * 100).toFixed(4) + '"></td>' +
        '<td><input data-f="jointMkt" value="' + +(a.jointMkt * 100).toFixed(4) + '"></td>' +
        '<td><button class="px-ic" data-delacc="' + escA(n) + '">✕</button></td></tr>';
    });
    h += '<tr><td><input class="nm" id="pxNewAcc" placeholder="新客户名"></td><td colspan="5"></td><td><button class="px-ic" id="pxAddAcc" title="新增">＋</button></td></tr></table></div>';
    wrap.innerHTML = h;
    wrap.querySelectorAll('tr[data-n]').forEach(tr => {
      const orig = tr.dataset.n;
      tr.querySelectorAll('input[data-f]').forEach(inp => inp.addEventListener('change', () => { M.updateAccount(orig, inp.dataset.f, inp.value); persist(); fillDatalist(); renderAccPanel(); }));
    });
    wrap.querySelectorAll('button[data-delacc]').forEach(b => b.addEventListener('click', () => { M.deleteAccount(b.dataset.delacc); persist(); fillDatalist(); renderAccPanel(); }));
    const add = el('pxAddAcc'); if (add) add.addEventListener('click', () => { const n = (el('pxNewAcc').value || '').trim(); if (!n) return; M.addAccount(n); persist(); fillDatalist(); renderAccPanel(); });
  }

  /* ---------- blocks ---------- */
  function skuOptions(sel) { const skus = [...M.state.costMap.keys()]; return '<option value=""' + (sel ? '' : ' selected') + '>—</option>' + skus.map(s => { const m = M.state.skuMeta.get(s) || {}; return '<option value="' + escA(s) + '"' + (s === sel ? ' selected' : '') + '>' + escA(s) + (m.name ? ' · ' + escA(m.name) : '') + '</option>'; }).join(''); }
  function monthCell(c, r, i) { const yms = M.monthsForSku(r.sku); if (!yms.length) return '<span style="color:var(--ink3)">—</span>'; return '<select class="px-msel" data-c="' + escA(c) + '" data-i="' + i + '" data-k="costYm">' + yms.map(y => '<option value="' + y + '"' + (r.costYm === y ? ' selected' : '') + '>' + ymLabel(y) + '</option>').join('') + '</select>'; }
  function coinvestCell(c, r, i) { let o = '<option value="">无</option>'; Object.keys(M.state.coInvestRules).forEach(rule => M.state.coInvestRules[rule].forEach((t, ti) => { const sel = (r.coInvestRule === rule && r.coInvestTier === ti) ? ' selected' : ''; o += '<option value="' + rule + '|' + ti + '"' + sel + '>' + rule + ' ' + t.label + '</option>'; })); return '<select class="px-msel" data-c="' + escA(c) + '" data-i="' + i + '" data-k="coInvestSel">' + o + '</select>'; }

  function blockHtml(c) {
    const f = M.countries()[c]; const collapsed = !!M.state.collapsed[c];
    let h = '<div class="px-blk' + (collapsed ? ' collapsed' : '') + '" data-c="' + escA(c) + '">';
    h += '<div class="px-blk-h">' +
      '<button class="px-caret" data-caret="' + escA(c) + '">' + (collapsed ? '▸' : '▾') + '</button>' +
      '<input class="cn" data-c="' + escA(c) + '" value="' + escA(c) + '">' +
      '<button class="px-ic del" data-delc="' + escA(c) + '" title="删除国家">✕</button></div>';
    h += '<div class="px-blk-body">';
    // 因子
    h += '<div class="px-fac"><span class="ttl">商务因子</span>' + FACTORS.map(a => '<div class="grp"><div class="lab">' + a.t + (a.kind === 'pct' ? ' %' : '') + '</div><input data-c="' + escA(c) + '" data-fk="' + a.k + '" data-kind="' + a.kind + '" value="' + cellVal(a.kind, f[a.k]) + '"></div>').join('') + '</div>';
    // bundle 小条
    const skus = M.distinctSkus(c);
    h += '<div class="px-bundle"><span>本国产品bundle(USD/台)：</span>' + (skus.length ? skus.map(s => '<span class="bi">' + escA(s) + ' <input data-c="' + escA(c) + '" data-bsku="' + escA(s) + '" value="' + M.bundleFor(c, s) + '"></span>').join('') : '<span style="color:var(--ink3)">（行内选产品后出现）</span>') + '</div>';
    // 表
    if (!M.state.costMap.size) h += '<div class="px-empty">请到「数据源」看板设置成本表文件夹。下面仍可加行，选产品后即可算销毛。</div>';
    h += '<div class="px-scroll"><table class="px-tbl' + (M.state.showFloor ? '' : ' hide-floor') + '" data-tc="' + escA(c) + '"><thead><tr>';
    COLS.forEach(col => { h += '<th style="min-width:' + col.w + 'px">' + col.t + '</th>'; });
    h += '<th class="outp col-floor" style="min-width:62px">Floor cost</th><th class="outp" style="min-width:58px">NSIP</th>';
    h += '<th class="mgh" style="min-width:58px">原价<br>销毛</th><th class="mgh" style="min-width:64px">促销价后<br>销毛</th><th class="mgh" style="min-width:64px">Bundle后<br>销毛</th><th class="mgh" style="min-width:58px">对投后<br>销毛</th>';
    h += '<th style="min-width:30px"></th></tr></thead><tbody>';
    M.rowsOf(c).forEach((r, i) => {
      h += '<tr>';
      COLS.forEach(col => {
        let cell;
        if (col.kind === 'sku') cell = '<select class="px-msel" data-c="' + escA(c) + '" data-i="' + i + '" data-k="sku">' + skuOptions(r.sku) + '</select>';
        else if (col.kind === 'coinvest') cell = coinvestCell(c, r, i);
        else if (col.kind === 'month') cell = monthCell(c, r, i);
        else if (col.kind === 'account') cell = '<input class="px-in acc" list="pxAccounts" data-c="' + escA(c) + '" data-i="' + i + '" data-k="customer" data-kind="account" value="' + escA(r.customer) + '">';
        else if (col.kind === 'text') cell = '<input class="px-in txt" data-c="' + escA(c) + '" data-i="' + i + '" data-k="' + col.k + '" data-kind="text" value="' + escA(r[col.k]) + '">';
        else cell = '<input class="px-in" data-c="' + escA(c) + '" data-i="' + i + '" data-k="' + col.k + '" data-kind="' + col.kind + '" value="' + cellVal(col.kind, r[col.k]) + '">';
        h += '<td>' + cell + '</td>';
      });
      h += '<td class="px-out floor col-floor" data-o="floor" data-i="' + i + '">—</td><td class="px-out" data-o="nsip" data-i="' + i + '">—</td>';
      h += '<td class="px-out px-gm px-mg" data-o="gm1" data-i="' + i + '">—</td><td class="px-out px-gm px-mg" data-o="gmP" data-i="' + i + '">—</td><td class="px-out px-gm px-mg" data-o="gm2" data-i="' + i + '">—</td><td class="px-out px-gm px-mg" data-o="gm3" data-i="' + i + '">—</td>';
      h += '<td><div class="px-act"><button class="px-ic" data-save="' + i + '" data-c="' + escA(c) + '" title="把本行存为客户预设">💾</button><button class="px-ic" data-del="' + i + '" data-c="' + escA(c) + '" title="删除行">✕</button></div></td></tr>';
    });
    h += '</tbody></table></div><div class="px-sum" data-sum="' + escA(c) + '"></div>';
    h += '</div></div>';
    return h;
  }

  function renderBlocks() {
    const wrap = el('pxBlocks'); if (!wrap) return;
    wrap.innerHTML = M.order().map(blockHtml).join('');
    M.order().forEach(bindBlock);
    M.order().forEach(recomputeBlock);
  }

  function bindBlock(c) {
    const blk = document.querySelector('.px-blk[data-c="' + cssEsc(c) + '"]'); if (!blk) return;
    blk.querySelector('button[data-caret]').addEventListener('click', () => { M.setCollapsed(c, !M.state.collapsed[c]); persist(); renderBlocks(); });
    blk.querySelector('input.cn').addEventListener('change', (e) => { const nn = M.renameCountry(c, e.target.value); persist(); renderBlocks(); });
    blk.querySelector('button[data-delc]').addEventListener('click', () => { if (M.order().length <= 1) { alert('至少保留一个国家'); return; } M.removeCountry(c); persist(); renderBlocks(); });
    blk.querySelectorAll('input[data-fk]').forEach(inp => inp.addEventListener('input', () => { const kind = inp.dataset.kind, n = parseFloat(inp.value); M.setFactor(c, inp.dataset.fk, isNaN(n) ? 0 : (kind === 'pct' ? n / 100 : n)); recomputeBlock(c); persist(); }));
    blk.querySelectorAll('input[data-bsku]').forEach(inp => inp.addEventListener('input', () => { const n = parseFloat(inp.value); M.setBundle(c, inp.dataset.bsku, isNaN(n) ? 0 : n); recomputeBlock(c); persist(); }));
    // 结构性变更 → 整块重渲染
    blk.querySelectorAll('select[data-k="sku"]').forEach(s => s.addEventListener('change', () => { M.setCell(c, +s.dataset.i, 'sku', s.value); persist(); renderBlocks(); }));
    blk.querySelectorAll('input[data-kind="account"]').forEach(inp => inp.addEventListener('change', () => { M.applyAccount(c, +inp.dataset.i, inp.value); persist(); renderBlocks(); }));
    blk.querySelectorAll('button[data-del]').forEach(b => b.addEventListener('click', () => { M.removeRow(c, +b.dataset.del); persist(); renderBlocks(); }));
    // 数值/文本输入 → 仅重算
    blk.querySelectorAll('input[data-kind]:not([data-kind="account"])').forEach(inp => inp.addEventListener('input', () => { M.setCell(c, +inp.dataset.i, inp.dataset.k, inp.value); recomputeBlock(c); persist(); }));
    blk.querySelectorAll('select[data-k="coInvestSel"]').forEach(sel => sel.addEventListener('change', () => { if (!sel.value) M.setCoInvest(c, +sel.dataset.i, '', -1); else { const [rule, ti] = sel.value.split('|'); M.setCoInvest(c, +sel.dataset.i, rule, +ti); } recomputeBlock(c); persist(); }));
    blk.querySelectorAll('select[data-k="costYm"]').forEach(sel => sel.addEventListener('change', () => { M.setCell(c, +sel.dataset.i, 'costYm', sel.value); recomputeBlock(c); persist(); }));
    blk.querySelectorAll('button[data-save]').forEach(b => b.addEventListener('click', () => { const n = M.saveAccountFromRow(c, +b.dataset.save); if (!n) { alert('请先填客户名'); return; } persist(); fillDatalist(); if (showAcc) renderAccPanel(); b.textContent = '✓'; setTimeout(() => { b.textContent = '💾'; }, 900); }));
  }

  function setGm(cell, v) { if (!cell) return; cell.textContent = pct(v); cell.classList.remove('pos', 'neg'); if (v != null) cell.classList.add(v < 0 ? 'neg' : 'pos'); }
  function recomputeBlock(c) {
    const blk = document.querySelector('.px-blk[data-c="' + cssEsc(c) + '"]'); if (!blk) return;
    const out = M.computeCountry(c), rows = M.rowsOf(c);
    rows.forEach((r, i) => {
      const o = out.rows[i]; if (!o) return; const hf = M.costFloorFor(r.sku, r.costYm) != null;
      const q = (key) => blk.querySelector('[data-o="' + key + '"][data-i="' + i + '"]');
      const fc = q('floor'); if (fc) fc.textContent = (o.costFloor == null ? '—' : o.costFloor.toFixed(1));
      const nc = q('nsip'); if (nc) nc.textContent = usd(o.nsip1);
      setGm(q('gm1'), hf ? o.gm1 : null); setGm(q('gmP'), hf ? o.gmPromo : null); setGm(q('gm2'), hf ? o.gm2 : null); setGm(q('gm3'), hf ? o.gm3 : null);
    });
    const sum = blk.querySelector('[data-sum="' + cssEsc(c) + '"]'); if (!sum) return;
    const skus = Object.keys(out.weightedBySku);
    let h = '';
    if (!skus.length || (skus.length === 1 && skus[0] === '')) h = '<span style="color:var(--ink3);font-size:12px">加权销毛：选产品并填权重后显示</span>';
    else h = skus.filter(s => s !== '').map(s => {
      const w = out.weightedBySku[s]; const m = M.state.skuMeta.get(s) || {};
      const item = (k, v) => '<div class="it"><span class="k">' + k + '</span><span class="v ' + (v < 0 ? 'px-gm neg' : 'px-gm pos') + '">' + pct(v) + '</span></div>';
      const wsOk = Math.abs(w.weightSum - 1) < 1e-6;
      return '<div class="grp"><span class="sku">' + escA(s) + (m.name ? '·' + escA(m.name) : '') + '</span>' + item('原价', w.gm1) + item('促销后', w.gmPromo) + item('Bundle后', w.gm2) + item('对投后', w.gm3) + '<span class="ws" style="color:' + (wsOk ? 'var(--ink3)' : 'var(--red)') + '">权重合计 ' + (w.weightSum * 100).toFixed(0) + '%' + (wsOk ? '' : ' ⚠应=100%') + '</span></div>';
    }).join('');
    h += '<button class="btn addrow" data-addrow="' + escA(c) + '">＋加行</button>';
    sum.innerHTML = h;
    const addBtn = sum.querySelector('button[data-addrow]'); if (addBtn) addBtn.addEventListener('click', () => { M.addRow(c); persist(); renderBlocks(); });
  }

  function cssEsc(s) { return String(s).replace(/["\\]/g, '\\$&'); }

  /* ---------- export ---------- */
  function buildAoa() {
    const head = ['国家'].concat(COLS.map(col => col.t)).concat(['本国bundle', 'Floor cost', 'NSIP-原价', 'FOB-原价', '销毛-原价', '销毛-促销价后', 'NSIP-Bundle后', '销毛-Bundle后', 'NSIP-对投后', '销毛-对投后']);
    const aoa = [head];
    M.order().forEach(c => {
      const out = M.computeCountry(c), rows = M.rowsOf(c);
      rows.forEach((r, i) => {
        const o = out.rows[i];
        const base = COLS.map(col => col.kind === 'coinvest' ? (r.coInvestRule ? r.coInvestRule + ' ' + ((M.state.coInvestRules[r.coInvestRule] || [])[r.coInvestTier] || {}).label : '无') : col.kind === 'month' ? (r.costYm ? ymLabel(r.costYm) : '') : r[col.k]);
        aoa.push([c].concat(base).concat([M.bundleFor(c, r.sku), o.costFloor, o.nsip1, o.fob1, o.gm1, o.gmPromo, o.nsip2, o.gm2, o.nsip3, o.gm3]));
      });
      Object.keys(out.weightedBySku).filter(s => s !== '').forEach(s => { const w = out.weightedBySku[s]; const wrow = new Array(head.length).fill(''); wrow[0] = c + ' 加权·' + s; wrow[head.indexOf('销毛-原价')] = w.gm1; wrow[head.indexOf('销毛-促销价后')] = w.gmPromo; wrow[head.indexOf('销毛-Bundle后')] = w.gm2; wrow[head.indexOf('销毛-对投后')] = w.gm3; aoa.push(wrow); });
    });
    return aoa;
  }
  function factorAoa() {
    const head = ['国家'].concat(FACTORS.map(a => a.t));
    return [head].concat(M.order().map(c => { const f = M.countries()[c]; return [c].concat(FACTORS.map(a => a.kind === 'pct' ? (+(f[a.k] * 100).toFixed(4)) + '%' : f[a.k])); }));
  }
  function exportXlsx() { if (!M.state.costMap.size) { alert('请先导入成本底表'); return; } ExportUtil.saveXlsx('定价测算_' + ExportUtil.ymd() + '.xlsx', { '定价测算': buildAoa(), '国家商务因子': factorAoa() }); }
  function exportPpt() { if (!M.state.costMap.size) { alert('请先导入成本底表'); return; } ExportUtil.savePptxTables('定价测算_' + ExportUtil.ymd() + '.pptx', '定价测算 · 多国家多产品', [{ name: '分客户测算', aoa: buildAoa() }, { name: '国家商务因子', aoa: factorAoa() }]); }

  window.renderPricing = renderPricing;
  window.PRICING_API = { renderBlocks, recomputeBlock };
})();

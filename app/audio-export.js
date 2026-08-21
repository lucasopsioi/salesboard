'use strict';
/* ============================================================
   产业周报（音频 / 平板）· 一键导出（PPT / PDF / Outlook 邮件 .eml）
   - 纯构建函数(buildWeeklyHtml / buildEml / b64Utf8 / 列宽对齐算法)可在 Node 单测;
   - Outlook 兼容(Word 引擎):只用 <table> + 内联样式,禁 class/外部CSS/flex/grid/position;
     宽度一律用 HTML 属性 width= 兜住,全篇统一版心 1000px,每表 table-layout:fixed + <colgroup>;
   - 宽表(列数 > WIDE_COLS)不进 HTML 表:浏览器侧提前渲染成 2x 高清 PNG,
     邮件用 cid 内嵌 / PDF 用 dataURL —— 渲染(canvas)与构建(纯字符串)解耦,所以本文件在 Node 里可测;
     万一没拿到 PNG(无 canvas),构建侧降级为「按列切块」,保证任何一张表都不超过 8 列 / 1000px。
   - 标签之间零空白 + 收尾统一 .replace(/>\s+</g,'><') → 消灭 Word 里的 ↵ 段落标记。
   - 导出只读当前界面数据,不改任何数据/口径;M1 表在导出瞬间定格为快照。
   ============================================================ */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.AudioExport = api;
})(this, function () {

  function b64Utf8(str) {
    if (typeof Buffer !== 'undefined') return Buffer.from(String(str), 'utf8').toString('base64');
    const bytes = new TextEncoder().encode(String(str));
    let bin = ''; bytes.forEach(b => bin += String.fromCharCode(b));
    return btoa(bin);
  }
  const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  // 多行文本:Word 里 white-space:pre-wrap 不可靠,统一转 <br>(且不引入空白文本节点)
  const escBr = s => esc(s).replace(/\r?\n/g, '<br>');

  /* ---------- 版式常量 ---------- */
  const C = { brand: '#C7000B', ink: '#1A1A1A', ink2: '#5A5F66', line: '#D9DCE0', soft: '#FFF3F3', head: '#F5F6F7', zebra: '#FAFBFC' };
  const FONT = 'Microsoft YaHei,微软雅黑,Segoe UI,sans-serif';
  const W_TOTAL = 1000;   // 全篇统一版心宽(px):Outlook 100% 缩放下不越界
  const WIDE_COLS = 8;    // 列数 > 8 判定为宽表 → 走高清 PNG(降级:按列切块)

  /* ---------- 列宽 / 对齐（HTML 与 PNG 共用一套,两种渲染观感一致） ---------- */
  function dispLen(s) { const t = String(s == null ? '' : s); let n = 0; for (let i = 0; i < t.length; i++) n += t.charCodeAt(i) > 127 ? 2 : 1; return n; }
  // null=中性(空/—,不参与判定) true=数字 false=文本
  function isNumTxt(s) {
    const t = String(s == null ? '' : s).trim();
    if (!t || /^[—\-–\s]+$/.test(t)) return null;
    return /^[+\-−(]?\s*[$¥€£]?\s*[\d][\d,]*(\.\d+)?\s*[%)]?\s*(天|台|pp|%)?$/.test(t);
  }
  function colAligns(header, rows) {
    const hdr = header || [], rws = rows || [];
    return hdr.map((h, i) => {
      if (i === 0) return 'l';                       // 首列恒为标签列
      let num = 0, txt = 0;
      rws.forEach(r => { const v = isNumTxt((r || [])[i]); if (v === true) num++; else if (v === false) txt++; });
      if (!num && !txt) return 'r';                  // 整列都是 — → 当数字列右对齐
      return num / (num + txt) >= 0.6 ? 'r' : 'l';
    });
  }
  // 按内容长度分配列宽,合计恒等于 total(Outlook 里 table-layout:fixed 只认这套)
  function colWidths(header, rows, total) {
    const hdr = header || []; const n = hdr.length; total = total || W_TOTAL;
    if (!n) return [];
    if (n === 1) return [total];
    const raw = hdr.map((h, i) => {
      let m = dispLen(h);
      (rows || []).forEach(r => { const L = dispLen((r || [])[i]); if (L > m) m = L; });
      m = Math.min(m, i === 0 ? 30 : 14);            // 封顶,避免一列吃掉整行
      return Math.max(i === 0 ? 8 : 5, m) + 2;
    });
    const s = raw.reduce((a, b) => a + b, 0) || n;
    const w = []; let acc = 0;
    for (let i = 0; i < n - 1; i++) { const x = Math.max(40, Math.floor(total * raw[i] / s)); w.push(x); acc += x; }
    w.push(Math.max(30, total - acc));
    const d = total - w.reduce((a, b) => a + b, 0);
    if (d) w[0] = Math.max(20, w[0] + d);            // 兜底:合计恒等于 total
    return w;
  }
  /* 宽表降级:按列切块,每块 ≤ maxCols 列并重复首列(标签列)。
     列数**均摊**到各块,不是贪心填满。贪心的话 16 列会切成 8+8+2,
     最后那块只有 2 列却同样撑满 1000px,列宽是前两块的四倍,难看得刺眼;
     均摊后是 6+6+6(含重复首列),三块宽度节奏一致。 */
  function chunkCols(header, rows, maxCols) {
    const hdr = header || [], rws = rows || [];
    if (hdr.length <= maxCols) return [{ header: hdr, rows: rws }];
    const dataCols = hdr.length - 1;                       // 首列是标签列,每块都要重复
    const nChunk = Math.ceil(dataCols / (maxCols - 1));
    const per = Math.ceil(dataCols / nChunk);              // 均摊
    const out = [];
    for (let s = 1; s < hdr.length; s += per) {
      const idx = [0];
      for (let j = s; j < Math.min(s + per, hdr.length); j++) idx.push(j);
      out.push({ header: idx.map(j => hdr[j]), rows: rws.map(r => idx.map(j => (r || [])[j])) });
    }
    return out;
  }

  /* ---------- 基础块 ---------- */
  const TBL_OPEN = 'cellpadding="0" cellspacing="0" style="border-collapse:collapse;table-layout:fixed;width:' + W_TOTAL + 'px;';
  function oneTable(header, rows, opts) {
    opts = opts || {};
    const hdr = header || [], rws = rows || [];
    if (!hdr.length) return '';
    // opts.widths / opts.aligns:同结构的一组表共用一套列宽与对齐（见 tblGroup）
    const al = (opts.aligns && opts.aligns.length === hdr.length) ? opts.aligns : colAligns(hdr, rws);
    const cw = (opts.widths && opts.widths.length === hdr.length) ? opts.widths : colWidths(hdr, rws, W_TOTAL);
    const thSty = i => 'border:1px solid ' + C.line + ';background:' + C.head + ';color:' + C.ink2 + ';font-size:12px;line-height:1.5;font-weight:bold;padding:6px 10px;white-space:nowrap;text-align:' + (al[i] === 'r' ? 'right' : 'left');
    const tdSty = (i, tot, zeb) => 'border:1px solid ' + C.line + ';font-size:12px;line-height:1.5;color:' + C.ink + ';padding:6px 10px;vertical-align:middle;'
      + (al[i] === 'r' ? 'text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums;' : 'text-align:left;word-break:break-word;')
      + (tot ? 'font-weight:bold;background:' + C.soft + ';' : (zeb ? 'background:' + C.zebra + ';' : ''));
    let h = '<table ' + TBL_OPEN + 'margin:0 0 8px" width="' + W_TOTAL + '" border="0">';
    h += '<colgroup>' + cw.map(w => '<col width="' + w + '" style="width:' + w + 'px">').join('') + '</colgroup>';
    h += '<tr>' + hdr.map((x, i) => '<th width="' + cw[i] + '" style="' + thSty(i) + '">' + esc(x) + '</th>').join('') + '</tr>';
    rws.forEach((r, i) => {
      const tot = (opts.totalIdx != null && i === opts.totalIdx) || (opts.totalLast && i === rws.length - 1);
      h += '<tr>' + hdr.map((_, ci) => '<td width="' + cw[ci] + '" style="' + tdSty(ci, tot, i % 2 === 1) + '">' + esc((r || [])[ci]) + '</td>').join('') + '</tr>';
    });
    return h + '</table>';
  }
  function tbl(header, rows, opts) {
    const parts = chunkCols(header || [], rows || [], WIDE_COLS);
    return parts.map((p, i) => (i ? note('（上表续 · 第 ' + (i + 1) + '/' + parts.length + ' 段，首列重复）') : '')
      + oneTable(p.header, p.rows, Object.assign({}, opts, { widths: null, aligns: null }))).join('');
  }

  /* 一组「同结构」的表（表头逐字相同）共用一套列宽 —— 否则各表按自己的内容算宽度，
     上下叠在一起时左右边缘全是错位的：实测 M2 的「分产品系列」与「分国家办」首列差 171px。
     做法：把这组表的所有数据行并起来算一次宽度和对齐，再发给组内每一张表。
     只有一张表的组不处理（没有对齐对象）。返回 item -> 分段宽度数组 的取值函数。 */
  function sharedSegs(items) {
    const list = (items || []).filter(t => t && (t.header || []).length && !t.img);
    /* 签名**不含首列标签**：M2 的两张表除了首列一个叫「系列」一个叫「国家办」，
       其余 15 个数据列一模一样 —— 按整行表头比会判成两组，就白白错开了。
       首列宽度由合并后的行内容决定，两种标签都放得下。 */
    const sig = t => (t.header || []).slice(1).join('|~|') + '#' + (t.header || []).length;
    const bySig = {};
    list.forEach(t => { (bySig[sig(t)] = bySig[sig(t)] || []).push(t); });
    const shared = {};
    Object.keys(bySig).forEach(k => {
      const grp = bySig[k];
      if (grp.length < 2) return;
      // 用组内最长的首列标签参与宽度计算,保证两种标签都放得下
      const hdr = grp[0].header.slice();
      grp.forEach(t => { if (String(t.header[0]).length > String(hdr[0]).length) hdr[0] = t.header[0]; });
      const allRows = grp.reduce((a, t) => a.concat(t.rows || []), []);
      // 切块后每段的列集合固定，所以按段号存一套宽度
      shared[k] = chunkCols(hdr, allRows, WIDE_COLS)
        .map(p => ({ widths: colWidths(p.header, p.rows, W_TOTAL), aligns: colAligns(p.header, p.rows) }));
    });
    return t => (t && !t.img) ? (shared[sig(t)] || null) : null;
  }

  // 带共享列宽的渲染：把 tblGroup 算出来的每段宽度发给对应的段
  function tblShared(header, rows, opts, seg) {
    const parts = chunkCols(header || [], rows || [], WIDE_COLS);
    return parts.map((p, i) => (i ? note('（上表续 · 第 ' + (i + 1) + '/' + parts.length + ' 段，首列重复）') : '')
      + oneTable(p.header, p.rows, Object.assign({}, opts, seg && seg[i] ? seg[i] : {}))).join('');
  }
  // 数据块:带 img(浏览器侧已渲成 2x PNG) → 图片;否则 HTML 表(必要时按列切块)
  function unit(t, imgMode, opts, seg) {
    t = t || {};
    if (t.img) {
      const src = (imgMode === 'cid' && t.cid) ? ('cid:' + t.cid) : t.img;
      return '<img src="' + src + '" width="' + W_TOTAL + '" style="width:' + W_TOTAL + 'px;display:block;border:1px solid ' + C.line + ';margin:0 0 8px" alt="' + esc(t.title || '数据表') + '">';
    }
    return seg ? tblShared(t.header, t.rows, opts || {}, seg) : tbl(t.header, t.rows, opts || {});
  }
  const secT = t => '<div style="font-size:15px;font-weight:bold;line-height:1.5;color:' + C.brand + ';margin:18px 0 6px;border-left:4px solid ' + C.brand + ';padding-left:8px">' + esc(t) + '</div>';
  const subT = t => t ? '<div style="font-size:12px;font-weight:bold;line-height:1.5;color:' + C.ink + ';margin:8px 0 4px">' + esc(t) + '</div>' : '';
  const note = t => t ? '<div style="font-size:11px;line-height:1.5;color:' + C.ink2 + ';margin:0 0 6px">' + esc(t) + '</div>' : '';
  // KPI / 摘要卡:横排一行,同样用 table 布局(Outlook 不认 flex)
  function cardRow(items, accent) {
    const list = (items || []).slice(0, 4); const n = list.length;
    if (!n) return '';
    const base = Math.floor(W_TOTAL / n), ws = list.map((_, i) => i === n - 1 ? W_TOTAL - base * (n - 1) : base);
    let h = '<table ' + TBL_OPEN + 'margin:0 0 10px" width="' + W_TOTAL + '" border="0">';
    h += '<colgroup>' + ws.map(w => '<col width="' + w + '" style="width:' + w + 'px">').join('') + '</colgroup><tr>';
    h += list.map((k, i) => '<td width="' + ws[i] + '" style="border:1px solid ' + C.line + ';' + (accent ? 'border-top:3px solid ' + C.brand + ';' : '') + 'padding:10px 12px;vertical-align:top">'
      + '<div style="font-size:11px;line-height:1.5;color:' + C.ink2 + '">' + esc(k.t) + '</div>'
      + '<div style="font-size:20px;line-height:1.4;font-weight:bold;color:' + C.ink + '">' + esc(k.v) + '</div>'
      + '<div style="font-size:11px;line-height:1.5;color:' + C.ink2 + '">' + esc(k.sub || '') + '</div></td>').join('');
    return h + '</tr></table>';
  }

  /* model 结构见 auBuildWeeklyModel;imgMode: 'cid'(邮件) | 'data'(PDF 直接 dataURL) */
  function buildWeeklyHtml(model, imgMode) {
    const m = model || {};
    const lab = m.industryLabel || '音频';
    let b = '';
    b += '<div style="font-size:20px;font-weight:bold;line-height:1.4;color:' + C.ink + ';margin:0 0 2px">' + esc(lab + '周报 ' + (m.week || '')) + '</div>';
    b += '<div style="font-size:11px;line-height:1.5;color:' + C.ink2 + ';margin:0 0 10px">生成日期 ' + esc(m.dateStr || '') + ' · Salesboard BY JS</div>';
    // 本期摘要(4 个关键数)
    if (m.summary && m.summary.length) b += cardRow(m.summary, true);
    // M1
    b += secT('一 · 遗留问题');
    if (m.issues && m.issues.length) b += tbl(['类型', '待办', '进展', '状态', '截止时间', '涉及国家/国家办'],
      m.issues.map(r => [r.type, r.todo, r.prog, r.status || '', r.due, r.geo]));
    else b += note('（本周无遗留问题）');
    // M2
    b += secT('二 · ' + lab + '产业经营进展');
    if (m.fin && m.fin.tables && m.fin.tables.length) {
      b += note(m.fin.note);
      const finSeg = sharedSegs(m.fin.tables);
      m.fin.tables.forEach(t => { b += subT(t.title) + unit(t, imgMode, { totalIdx: t.totalIdx }, finSeg(t)); });
    } else b += note('（未接财经数据）');
    // M3
    b += secT('三 · $0-50美金扩大覆盖悬赏奖 SI 进展');
    if (m.bounty && m.bounty.rows) { b += note(m.bounty.note); b += unit(m.bounty, imgMode, { totalLast: true }); }
    else b += note('（无数据）');
    // M4
    b += secT('四 · 周度销售进展');
    if (m.ind) {
      b += cardRow(m.ind.kpis || []);
      b += note((m.ind.title || '') + (m.ind.hint ? ' · ' + m.ind.hint : ''));
      if (m.ind.chartPng) {
        const src = imgMode === 'cid' ? 'cid:chart1' : m.ind.chartPng;
        b += '<img src="' + src + '" width="' + W_TOTAL + '" style="width:' + W_TOTAL + 'px;display:block;border:1px solid ' + C.line + ';margin:0 0 8px" alt="周度趋势">';
      }
    } else b += note('（M4 尚未加载,请先打开周报看板)');
    // M5
    b += secT('五 · 产品维度');
    if (m.title && m.title.text) b += '<div style="font-size:' + (+(m.title.size) || 15) + 'px;' + (m.title.bold ? 'font-weight:bold;' : '') + 'line-height:1.5;color:' + C.ink + ';margin:4px 0 8px">' + escBr(m.title.text) + '</div>';
    if (m.countries && m.countries.length) {
      const cbSeg = sharedSegs(m.countries);          // 各国块表头一样 → 共用列宽,上下逐列对齐
      m.countries.forEach(c => {
        b += '<div style="font-size:13px;font-weight:bold;line-height:1.5;color:' + C.ink + ';margin:10px 0 4px">' + esc(c.name) + '　<span style="font-weight:normal;font-size:11px;color:' + C.ink2 + '">' + esc(c.chips || '') + '</span></div>';
        b += unit(c, imgMode, { totalLast: !!c.hasTotal }, cbSeg(c));
      });
    }
    else b += note('（未添加国家）');
    // M6
    b += secT('六 · 新品进展');
    if (m.blocks && m.blocks.length) m.blocks.forEach(k => {
      b += '<div style="font-size:13px;font-weight:bold;line-height:1.5;color:' + C.ink + ';margin:8px 0 2px">' + esc(k.title || '（未命名）') + '</div>';
      if (k.text) b += '<div style="font-size:12px;line-height:1.5;color:' + C.ink + ';margin:0 0 4px">' + escBr(k.text) + '</div>';
      // 附件只在正文里点名,不往邮件里挂文件(用户明确要求:邮件只要版式,不要附件)
      if (k.atts && k.atts.length) b += note('附件：' + k.atts.join(' · ') + '（随存档保存在本机）');
    });
    else b += note('（无新品进展内容）');
    // 页脚:版本 + 生成时间
    b += '<div style="border-top:1px solid ' + C.line + ';margin:18px 0 0;padding:8px 0 0;font-size:11px;line-height:1.5;color:' + C.ink2 + '">'
      + esc('Salesboard ' + (m.version || 'BY JS') + (m.builtAt ? ' · 构建 ' + m.builtAt : '') + ' · 生成于 ' + (m.dateStr || '') + (m.genTime ? ' ' + m.genTime : '')) + '</div>';
    // 外层容器:全篇锁 1000px 版心
    const doc = '<table ' + TBL_OPEN + 'font-family:' + FONT + ';color:' + C.ink + '" width="' + W_TOTAL + '" border="0">'
      + '<colgroup><col width="' + W_TOTAL + '" style="width:' + W_TOTAL + 'px"></colgroup>'
      + '<tr><td width="' + W_TOTAL + '" style="padding:0;vertical-align:top">' + b + '</td></tr></table>';
    return doc.replace(/>\s+</g, '><');   // 标签间零空白 → Word 里不再出现 ↵
  }

  /* ---------- .eml(X-Unsent:1 → Outlook 草稿;multipart/related 内嵌图表/宽表 PNG) ----------
     只出版式,不挂附件——用户明确要求邮件里不要附件,M6 的文件在正文里点名即可。 */
  /* 收件人 / 抄送 ----------------------------------------------------
     用户从 Outlook 复制上一封周报的收件人粘进来，形态可能是：
       张三 <zhang@x.com>; 李四 <li@x.com>     ← 最常见
       zhang@x.com, li@x.com                   ← 纯地址
       张三; 李四                               ← 只有显示名（Outlook 开成草稿时按通讯录解析）
     MIME 头里不能出现非 ASCII，所以显示名按 RFC2047 编码、地址原样保留；
     分隔符统一成逗号（RFC 5322 的地址列表分隔符，Outlook 习惯用的分号在头里不合法）。 */
  function formatAddrList(raw) {
    const txt = String(raw == null ? '' : raw).trim();
    if (!txt) return '';
    // 先按分号切；没有分号才按逗号切（避免把「姓, 名 <a@b>」这种显示名切坏）
    const parts = (txt.indexOf(';') >= 0 ? txt.split(';') : txt.split(',')).map(x => x.trim()).filter(Boolean);
    const enc = n => (/^[\x20-\x7E]*$/.test(n) ? '"' + n.replace(/"/g, '') + '"' : '=?UTF-8?B?' + b64Utf8(n) + '?=');
    const out = [];
    parts.forEach(one => {
      const m = /^(.*?)<([^>]+)>\s*$/.exec(one);
      if (m) {
        const name = m[1].trim().replace(/^["']|["']$/g, ''), addr = m[2].trim();
        out.push(name ? enc(name) + ' <' + addr + '>' : addr);
      } else if (/^[^\s@]+@[^\s@]+$/.test(one)) {
        out.push(one);
      } else {
        out.push(/^[\x20-\x7E]*$/.test(one) ? one : '=?UTF-8?B?' + b64Utf8(one) + '?=');
      }
    });
    return out.join(', ');
  }

  function buildEml(subject, html, images, mail) {
    const BOUND = '----=_sb_audio_weekly_boundary';
    const wrap76 = s => s.replace(/(.{76})/g, '$1\r\n');
    const M = mail || {};
    let e = '';
    const to = formatAddrList(M.to), cc = formatAddrList(M.cc);
    if (to) e += 'To: ' + to + '\r\n';
    if (cc) e += 'Cc: ' + cc + '\r\n';
    e += 'Subject: =?UTF-8?B?' + b64Utf8(subject) + '?=\r\n';
    e += 'X-Unsent: 1\r\n';
    e += 'MIME-Version: 1.0\r\n';
    e += 'Content-Type: multipart/related; boundary="' + BOUND + '"; type="text/html"\r\n\r\n';
    e += '--' + BOUND + '\r\n';
    e += 'Content-Type: text/html; charset="utf-8"\r\nContent-Transfer-Encoding: base64\r\n\r\n';
    e += wrap76(b64Utf8('<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>' + html + '</body></html>')) + '\r\n';
    (images || []).forEach(img => {
      e += '--' + BOUND + '\r\n';
      e += 'Content-Type: image/png; name="' + img.cid + '.png"\r\nContent-Transfer-Encoding: base64\r\nContent-ID: <' + img.cid + '>\r\nContent-Disposition: inline; filename="' + img.cid + '.png"\r\n\r\n';
      e += wrap76(img.b64) + '\r\n';
    });
    e += '--' + BOUND + '--\r\n';
    return e;
  }

  return { b64Utf8, buildWeeklyHtml, buildEml, formatAddrList, WIDE_COLS, W_TOTAL, _tbl: tbl, _align: colAligns, _widths: colWidths, _chunk: chunkCols };
});

/* ============================================================
   浏览器侧:采集模型 + 宽表 PNG 渲染 + 三个导出动作(Node 环境下以下不执行)
   ============================================================ */
if (typeof window !== 'undefined') (function () {
  const AX = window.AudioExport;

  const strip = h => String(h == null ? '' : h).replace(/<[^>]*>/g, '');
  const AU_IND_LAB = { audio: '音频', tablet: '平板', pad: '平板' };
  // 产业名:优先看板给的 auW.industryLabel / auW.industry,其次存档 D.industry,兜底「音频」
  function auIndustryLabel() {
    try {
      if (typeof auW !== 'undefined' && auW) {
        if (auW.industryLabel) return auW.industryLabel;
        if (auW.industry) return AU_IND_LAB[auW.industry] || auW.industry;
      }
      const D = (typeof auLoad === 'function') ? auLoad() : null;
      if (D && D.industry) return AU_IND_LAB[D.industry] || D.industry;
    } catch (e) { }
    return '音频';
  }
  function auIndustryKey() {
    try { if (typeof auW !== 'undefined' && auW && auW.industry) return auW.industry; } catch (e) { }
    return 'audio';
  }

  /* ---- 宽表 → 2x 高清 PNG(canvas;列宽/对齐复用构建侧同一套算法) ---- */
  window.auRenderTablePng = function (header, rows, opts) {
    opts = opts || {};
    try {
      header = header || []; rows = rows || [];
      if (!header.length || typeof document === 'undefined') return null;
      const W = opts.width || AX.W_TOTAL, dpr = opts.dpr || 2;
      const cvs = document.createElement('canvas');
      const ctx = cvs.getContext && cvs.getContext('2d'); if (!ctx) return null;
      const F = '"Microsoft YaHei","微软雅黑",sans-serif';
      const setF = (bold, size) => { ctx.font = (bold ? 'bold ' : '') + size + 'px ' + F; };
      const natural = size => header.map((h, i) => {
        setF(true, size); let w = ctx.measureText(String(h == null ? '' : h)).width;
        setF(false, size);
        rows.forEach(r => { const t = (r || [])[i]; w = Math.max(w, ctx.measureText(String(t == null ? '' : t)).width); });
        return Math.ceil(w) + 20;
      });
      let fs = 12, nat = natural(fs), sum = nat.reduce((a, b) => a + b, 0);
      if (sum > W) { fs = Math.max(9, Math.floor(fs * W / sum)); nat = natural(fs); sum = nat.reduce((a, b) => a + b, 0) || 1; }
      const cw = []; let acc = 0;
      header.forEach((_, i) => { const w = i === header.length - 1 ? W - acc : Math.max(30, Math.floor(W * nat[i] / sum)); cw.push(w); acc += w; });
      const al = AX._align(header, rows);
      const rowH = fs + 14, headH = fs + 18, titleH = opts.title ? fs + 16 : 0;
      const H = titleH + headH + rows.length * rowH;
      cvs.width = Math.round(W * dpr); cvs.height = Math.round(H * dpr);
      ctx.scale(dpr, dpr); ctx.textBaseline = 'middle';
      ctx.fillStyle = '#FFFFFF'; ctx.fillRect(0, 0, W, H);
      const PAD = 8;
      const fit = (t, maxW) => { t = String(t == null ? '' : t); if (ctx.measureText(t).width <= maxW) return t; while (t.length > 1 && ctx.measureText(t + '…').width > maxW) t = t.slice(0, -1); return t + '…'; };
      const put = (t, i, x, y) => { const mw = cw[i] - PAD * 2; ctx.textAlign = al[i] === 'r' ? 'right' : 'left'; ctx.fillText(fit(t, mw), al[i] === 'r' ? x + cw[i] - PAD : x + PAD, y); };
      let y = 0;
      if (opts.title) { setF(true, fs + 1); ctx.fillStyle = '#C7000B'; ctx.textAlign = 'left'; ctx.fillText(String(opts.title), 2, titleH / 2); y = titleH; }
      const top = y;
      ctx.fillStyle = '#F5F6F7'; ctx.fillRect(0, y, W, headH);
      setF(true, fs); ctx.fillStyle = '#5A5F66';
      let x = 0; header.forEach((h, i) => { put(h, i, x, y + headH / 2); x += cw[i]; });
      y += headH;
      rows.forEach((r, ri) => {
        const tot = (opts.totalIdx != null && ri === opts.totalIdx) || (opts.totalLast && ri === rows.length - 1);
        ctx.fillStyle = tot ? '#FFF3F3' : (ri % 2 ? '#FAFBFC' : '#FFFFFF'); ctx.fillRect(0, y, W, rowH);
        let xx = 0;
        header.forEach((_, ci) => {
          setF(tot || ci === 0, fs); ctx.fillStyle = tot ? '#C7000B' : '#1A1A1A';
          put((r || [])[ci], ci, xx, y + rowH / 2); xx += cw[ci];
        });
        ctx.strokeStyle = '#E8EAEC'; ctx.beginPath(); ctx.moveTo(0, y + rowH + .5); ctx.lineTo(W, y + rowH + .5); ctx.stroke();
        y += rowH;
      });
      ctx.strokeStyle = '#E8EAEC'; let vx = 0;
      cw.slice(0, -1).forEach(w => { vx += w; ctx.beginPath(); ctx.moveTo(vx + .5, top); ctx.lineTo(vx + .5, H); ctx.stroke(); });
      ctx.strokeStyle = '#D9DCE0'; ctx.strokeRect(.5, top + .5, W - 1, H - top - 1);
      return cvs.toDataURL('image/png');
    } catch (e) { return null; }
  };

  /* ---- 宽表(>8 列)提前转 PNG;窄表原样走 HTML 表 ---- */
  function auAttachTableImages(m) {
    let n = 0;
    const conv = (t, title, opts) => {
      if (!t || t.img || !(t.header || []).length || t.header.length <= AX.WIDE_COLS) return;
      const url = window.auRenderTablePng(t.header, t.rows, Object.assign({ title: title }, opts || {}));
      if (url) { t.img = url; t.cid = 'tbl' + (++n); }
    };
    if (m.fin && m.fin.tables) m.fin.tables.forEach(t => conv(t, t.title, { totalIdx: t.totalIdx }));
    if (m.bounty) conv(m.bounty, '悬赏奖 SI 进展', { totalLast: true });
    (m.countries || []).forEach(c => conv(c, c.name, { totalLast: !!c.hasTotal }));
    return m;
  }
  function auCollectImages(m) {
    const out = [];
    if (m.ind && m.ind.chartPng) out.push({ cid: 'chart1', b64: String(m.ind.chartPng).replace(/^data:image\/png;base64,/, '') });
    const push = t => { if (t && t.img && t.cid) out.push({ cid: t.cid, b64: String(t.img).replace(/^data:image\/png;base64,/, '') }); };
    if (m.fin && m.fin.tables) m.fin.tables.forEach(push);
    push(m.bounty);
    (m.countries || []).forEach(push);
    return out;
  }

  /* ---- 本期摘要 4 个关键数(只做同口径求和,不重算任何指标) ---- */
  function auSummaryCards(m) {
    const fmt = n => (n == null || !isFinite(n)) ? '—' : Math.round(n).toLocaleString('en-US');
    const pct = v => (v == null || !isFinite(v)) ? '—' : (v >= 0 ? '+' : '') + (v * 100).toFixed(0) + '%';
    const cbs = (typeof auW !== 'undefined' && auW.cbLast) || [];
    const tots = cbs.map(x => x && x.r && x.r.total).filter(Boolean);
    if (!tots.length) return (m.ind && m.ind.kpis) ? m.ind.kpis.slice(0, 4) : [];
    const r0 = cbs[0].r, wl = r0.weekLabels || [];
    let wk = 0, wkPrev = 0, hasWk = false;
    tots.forEach(t => { const a = t.weekly || []; if (a.length) { hasWk = true; wk += +a[a.length - 1] || 0; wkPrev += +a[a.length - 2] || 0; } });
    const cum = tots.reduce((s, t) => s + (+t.cumCur || 0), 0);
    const prev = tots.reduce((s, t) => s + (+t.cumPrev || 0), 0);
    const inv = tots.reduce((s, t) => s + (+t.inv || 0), 0);
    const cards = [];
    if (hasWk) cards.push({ t: '本周 SO' + (wl.length ? '（' + wl[wl.length - 1] + '）' : ''), v: fmt(wk), sub: 'WoW ' + pct(wkPrev > 0 ? wk / wkPrev - 1 : null) });
    cards.push({ t: (r0.curYear || '') + ' 累计SO 同比', v: pct(prev > 0 ? cum / prev - 1 : null), sub: '累计 ' + fmt(cum) + ' · 去年同期 ' + fmt(prev) });
    cards.push({ t: '当前 库存', v: fmt(inv), sub: tots.length + ' 个国家合计' });
    let dos = tots.length === 1 && tots[0].dos != null ? tots[0].dos + ' 天' : null;
    if (!dos) { ((m.ind && m.ind.kpis) || []).some(k => { const mm = /DOS\s*([\d.]+)/.exec(String(k.sub || '')); if (mm) { dos = mm[1] + ' 天'; return true; } return false; }); }
    cards.push({ t: '渠道 DOS', v: dos || '—', sub: tots.length === 1 ? cbs[0].v : '产业口径' });
    return cards.slice(0, 4);
  }

  window.auBuildWeeklyModel = function () {
    const D = (typeof auLoad === 'function') ? auLoad() : {};
    const iso = isoWeekOf(new Date());
    const lab = auIndustryLabel();
    const V = window.__appVer || null;
    const model = {
      week: iso[0] + '-W' + iso[1], dateStr: todayStr(),
      industry: auIndustryKey(), industryLabel: lab,
      version: V && V.version ? ('v' + V.version) : '', builtAt: (V && V.builtAt) || '',
      genTime: new Date().toTimeString().slice(0, 5),
      issues: (typeof auIssuesForExport === 'function' ? auIssuesForExport() : (D.issues || []).slice()),
      mail: Object.assign({ to: '', cc: '', subject: '' }, D.mail || {}), title: D.title || {}, blocks: [], fin: null, bounty: null, ind: null, countries: [], summary: [],
    };
    // M2(读 auW 缓存的最近一次取数)
    const pb = (typeof auW !== 'undefined' && auW.finPb) || null;
    const fam = pb && (pb.famAudio || pb.fam || pb.famSel || pb.famInd);
    if (fam) {
      const cols = AU_FIN_COLS;
      const mk = (block, first, isSeries) => {
        let rows = (block.rows || []).slice();
        if (isSeries) rows.sort((a, b) => { const ra = seriesRank(a.key), rb = seriesRank(b.key); return ra !== rb ? ra - rb : ((b.rev26 || 0) - (a.rev26 || 0)); });
        const all = block.total ? [block.total].concat(rows) : rows;
        return { header: [first].concat(cols.map(c => c.label)), rows: all.map(o => [o.key].concat(cols.map(c => strip(c.fmt(o))))), totalIdx: block.total ? 0 : null };
      };
      const tables = [Object.assign({ title: '分产品系列(' + lab + ' LV3)' }, mk(fam, '系列', true))];
      if (auW.finRb && auW.finRb.repTable) tables.push(Object.assign({ title: '分国家办(' + lab + ')' }, mk(auW.finRb.repTable, '国家办', false)));
      const prog = (pb.toM - pb.fromM + 1) / 12;
      model.fin = { note: `${pb.curYear}年${pb.fromM}~${pb.toM}月实际 · 时间进度 ${(prog * 100).toFixed(0)}% · 版本:${pb.version || '—'}`, tables };
    }
    // M3(renderAuBounty 每次渲染都会缓存导出快照)
    if (typeof auW !== 'undefined' && auW._bountyExport) model.bounty = Object.assign({}, auW._bountyExport);
    // M4
    if (typeof auIndExportModel === 'function') model.ind = auIndExportModel();
    // M5 国家块
    if (typeof auW !== 'undefined' && (auW.cbLast || []).length) {
      model.countries = auW.cbLast.map(({ v, r }) => {
        const cols = auCbColumns(r);
        const rows = auCbVisibleRows(v, r, cols).map(o => cols.map(c => c.totalOnly ? '—' : strip(c.cell(o)).replace(/\s+/g, ' ')));
        if (r.total) rows.push(cols.map(c => c.key === 'key' ? '合计' : (c.key === '__line' ? '' : strip(c.cell(r.total)))));
        const t = r.total || {};
        return { name: v, chips: `${r.curYear % 100}累计SO ${strip(numCell(t.cumCur))} · 库存 ${strip(numCell(t.inv))} · DOS ${t.dos == null ? '—' : t.dos}`, header: cols.map(c => c.label), rows, hasTotal: !!r.total };
      });
    }
    // M6
    // 附件只出文件名(正文/PPT 里点名),文件本身不进邮件——用户要求邮件只要版式
    model.blocks = (D.blocks || []).map(k => ({ title: k.title, text: k.text, atts: (k.atts || []).map(a => a.name) }));
    // 顶部摘要
    try { model.summary = auSummaryCards(model); } catch (e) { model.summary = []; }
    return model;
  };

  /* ---- PPT:逐模块一页(本次未改口径/版式) ---- */
  window.auExportWeeklyPpt = async function () {
    if (typeof window.auEnsureWeeklyData === 'function') {
      const miss = await window.auEnsureWeeklyData();
      if (miss.length) toast('这些模块暂无数据,导出里会留空:' + miss.join('、'), 'warn');
    }
    const m = window.auBuildWeeklyModel();
    const pptx = new PptxGenJS(); pptx.defineLayout({ name: 'W', width: 13.333, height: 7.5 }); pptx.layout = 'W';
    const F = '微软雅黑', BR = 'C7000B';
    const title = (s, t) => s.addText(t, { x: 0.4, y: 0.2, w: 12.5, h: 0.5, fontFace: F, fontSize: 18, bold: true, color: BR });
    const addTbl = (s, header, rows, y, opts) => {
      const data = [header.map(x => ({ text: String(x), options: { bold: true, fill: 'F5F6F7', color: '5A5F66' } }))]
        .concat(rows.map(r => r.map(x => String(x == null ? '' : x))));
      s.addTable(data, Object.assign({ x: 0.4, y: y || 0.85, w: 12.5, fontFace: F, fontSize: (opts && opts.fs) || 9, border: { pt: 0.5, color: 'D9DCE0' }, align: 'right', valign: 'middle', autoPage: true, autoPageRepeatHeader: true }, opts || {}));
    };
    let s = pptx.addSlide();
    title(s, m.industryLabel + '周报 ' + m.week + ' · 一 遗留问题');
    if (m.issues.length) addTbl(s, ['类型', '待办', '进展', '状态', '截止时间', '涉及国家/国家办'],
      m.issues.map(r => [r.type, r.todo, r.prog, r.status || '', r.due, r.geo]), 0.85, { fs: 11, align: 'left' });
    else s.addText('本周无遗留问题', { x: 0.4, y: 1, w: 6, h: 0.4, fontFace: F, fontSize: 12, color: '7A7F86' });
    if (m.fin) m.fin.tables.forEach(t => { s = pptx.addSlide(); title(s, '二 经营进展 · ' + t.title); s.addText(m.fin.note, { x: 0.4, y: 0.62, w: 12.5, h: 0.3, fontFace: F, fontSize: 10, color: '7A7F86' }); addTbl(s, t.header, t.rows, 0.95, { fs: 8 }); });
    if (m.bounty) { s = pptx.addSlide(); title(s, '三 悬赏奖 SI 进展'); s.addText(m.bounty.note, { x: 0.4, y: 0.62, w: 12.5, h: 0.3, fontFace: F, fontSize: 10, color: '7A7F86' }); addTbl(s, m.bounty.header, m.bounty.rows, 0.95, { fs: 11 }); }
    if (m.ind) {
      s = pptx.addSlide(); title(s, '四 周度销售进展');
      m.ind.kpis.forEach((k, i) => {
        s.addText([{ text: k.t + '\n', options: { fontSize: 10, color: '7A7F86' } }, { text: k.v + '\n', options: { fontSize: 20, bold: true, color: '1A1A1A' } }, { text: k.sub, options: { fontSize: 9, color: '7A7F86' } }],
          { x: 0.4 + i * 3.15, y: 0.75, w: 3.0, h: 1.15, fontFace: F, fill: 'F7F8F9', line: { pt: 0.5, color: 'D9DCE0' } });
      });
      if (m.ind.chartPng) s.addImage({ data: m.ind.chartPng, x: 0.4, y: 2.1, w: 12.5, h: 5.0 });
      s.addText(m.ind.title + ' · ' + m.ind.hint, { x: 0.4, y: 7.12, w: 12.5, h: 0.3, fontFace: F, fontSize: 9, color: '7A7F86' });
    }
    if (m.countries.length || (m.title && m.title.text)) {
      m.countries.forEach((c, idx) => {
        s = pptx.addSlide(); title(s, '五 产品维度 · ' + c.name);
        let y = 0.62;
        if (idx === 0 && m.title && m.title.text) { s.addText(m.title.text, { x: 0.4, y, w: 12.5, h: 0.6, fontFace: F, fontSize: Math.min(14, (+m.title.size || 15) * 0.7), bold: !!m.title.bold, color: '1A1A1A' }); y += 0.65; }
        s.addText(c.chips, { x: 0.4, y, w: 12.5, h: 0.28, fontFace: F, fontSize: 10, color: '7A7F86' });
        addTbl(s, c.header, c.rows, y + 0.32, { fs: 7.5 });
      });
      if (!m.countries.length) { s = pptx.addSlide(); title(s, '五 产品维度'); s.addText(m.title.text, { x: 0.4, y: 0.8, w: 12.5, h: 1.2, fontFace: F, fontSize: +m.title.size || 15, bold: !!m.title.bold }); }
    }
    if (m.blocks.length) {
      m.blocks.forEach(k => {
        s = pptx.addSlide(); title(s, '六 新品进展 · ' + (k.title || '未命名'));
        if (k.text) s.addText(k.text, { x: 0.4, y: 0.85, w: 12.5, h: 5.6, fontFace: F, fontSize: 13, color: '1A1A1A', valign: 'top' });
        if (k.atts && k.atts.length) s.addText('附件：' + k.atts.join(' · '), { x: 0.4, y: 6.7, w: 12.5, h: 0.4, fontFace: F, fontSize: 10, color: '7A7F86' });
      });
    }
    const b64 = await pptx.write('base64');
    const res = await api.saveFile('周报_' + m.industryLabel + '_' + m.week + '_' + todayStr() + '.pptx', b64, 'pptx');
    if (res && res.path) toast('已导出 PPT', 'ok');
  };

  /* ---- PDF:Outlook 同款 HTML(dataURL 图片) → 主进程 printToPDF ---- */
  window.auExportWeeklyPdf = async function () {
    if (typeof window.auEnsureWeeklyData === 'function') {
      const miss = await window.auEnsureWeeklyData();
      if (miss.length) toast('这些模块暂无数据,导出里会留空:' + miss.join('、'), 'warn');
    }
    const m = auAttachTableImages(window.auBuildWeeklyModel());
    const html = AX.buildWeeklyHtml(m, 'data');
    const res = await api.printHtmlPdf('周报_' + m.industryLabel + '_' + m.week + '_' + todayStr() + '.pdf',
      '<!DOCTYPE html><html><head><meta charset="utf-8"><style>@page{margin:10mm}body{margin:0}</style></head><body>' + html + '</body></html>');
    if (res && res.path) toast('已导出 PDF', 'ok'); else if (res && res.error) toast('PDF 导出失败:' + res.error, 'err');
  };

  /* ---- Outlook .eml(双击即草稿) ---- */
  window.auExportWeeklyEml = async function () {
    if (typeof window.auEnsureWeeklyData === 'function') {
      const miss = await window.auEnsureWeeklyData();
      if (miss.length) toast('这些模块暂无数据,导出里会留空:' + miss.join('、'), 'warn');
    }
    const m = auAttachTableImages(window.auBuildWeeklyModel());
    const html = AX.buildWeeklyHtml(m, 'cid');
    const mail = m.mail || {};
    const subject = (mail.subject || '').trim() || (m.industryLabel + '产业周报 ' + m.week);
    const eml = AX.buildEml(subject, html, auCollectImages(m), mail);
    const res = await api.saveFile('周报_' + m.industryLabel + '_' + m.week + '_' + todayStr() + '.eml', AX.b64Utf8(eml), 'eml');
    if (res && res.path) {
      const who = AX.formatAddrList(mail.to) ? '，收件人已填好' : '，还没填收件人';
      toast('已导出 Outlook 邮件(.eml，双击成草稿' + who + ')', 'ok');
    }
  };
})();

'use strict';
/* 音频周报导出构建器测试:Outlook 安全 HTML + .eml MIME 结构 */
const AX = require('./audio-export.js');
let f = 0; const ok = (n, c) => { console.log((c ? 'PASS ' : 'FAIL ') + n); if (!c) f++; };

const model = {
  week: '2026-W32', dateStr: '2026-08-05',
  issues: [{ type: '要货', todo: 'SonicBuds SE 5 Max 报要货', prog: '编码已出', due: '2026-08-05', geo: '所有国家' }],
  fin: { note: '2026年1~6月实际 · 时间进度 50%', tables: [{ title: '分产品系列', header: ['系列', '26年收入'], rows: [['音频合计', '$5,874,525.0'], ['Series T2', '$2,371,625.0']], totalIdx: 0 }] },
  bounty: { note: '累计SI=Sell-in · 时间进度 58%', header: ['国家', 'SI目标', '26年累计SI', 'SI达成率'], rows: [['墨西哥', '294,000', '171,362', '58%'], ['合计', '764,000', '308,187', '40%']] },
  ind: { kpis: [{ t: '2026年 Sell In YTD', v: '40,926台', sub: '同比 +24%' }], chartPng: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==', title: '音频与智能配件 · Sell Out · 周维度', hint: '红实线=2026年' },
  title: { text: 'W29 WoW环比-15%,墨西哥PrimeDay结束后回落', size: 15, bold: true },
  countries: [{ name: '巴西', chips: '26累计SO 5,331 · DOS 10', header: ['Product', '26累计SO'], rows: [['Product D Buds', '2,060'], ['合计', '5,331']], hasTotal: true }],
  blocks: [{ title: 'SE 5 Max 上市方案', text: '首销 W36,预热 W34 起', atts: ['方案V2.pptx'] }],
};

/* ---------- HTML(Outlook 安全) ---------- */
const html = AX.buildWeeklyHtml(model, 'cid');
ok('全部六个模块标题都在', ['一 · 遗留问题', '二 · 音频产业经营进展', '三 · $0-50', '四 · 周度销售进展', '五 · 产品维度', '六 · 新品进展'].every(t => html.includes(t)));
ok('表格用 <table + 内联样式', /<table cellpadding="0" cellspacing="0" style="border-collapse/.test(html));
ok('无 class/外部CSS/flex/grid(Outlook Word 引擎兼容)', !/class=|<link|display:flex|display:grid/.test(html));
ok('图表用 cid 引用(邮件模式)', html.includes('src="cid:chart1"'));
ok('PDF 模式图表用 dataURL', AX.buildWeeklyHtml(model, 'data').includes('src="data:image/png;base64,'));
ok('数据单元格转义(< > &)', AX.buildWeeklyHtml({ week: 'W1', issues: [{ type: 'a<b', todo: 'x&y', prog: '', due: '', geo: '' }] }, 'data').includes('a&lt;b'));
ok('悬赏合计行带加粗样式(totalLast)', html.includes('font-weight:bold;background:#FFF3F3'));
ok('标题文字字号/加粗生效', html.includes('font-size:15px;font-weight:bold;') && html.includes('W29 WoW'));

/* ---------- .eml ---------- */
const eml = AX.buildEml('音频周报 2026-W32', html, [{ cid: 'chart1', b64: 'iVBORw0KGgoAAAANSUhEUg==' }]);
ok('Subject 用 RFC2047 UTF-8 B 编码', /^Subject: =\?UTF-8\?B\?.+\?=\r\n/m.test(eml));
ok('X-Unsent:1(双击 Outlook 开成草稿)', /^X-Unsent: 1\r\n/m.test(eml));
ok('multipart/related + type=text/html', eml.includes('Content-Type: multipart/related') && eml.includes('type="text/html"'));
ok('HTML part base64 可解码还原', (() => {
  const mm = eml.match(/Content-Transfer-Encoding: base64\r\n\r\n([\s\S]*?)\r\n--/);
  if (!mm) return false;
  const dec = Buffer.from(mm[1].replace(/\r\n/g, ''), 'base64').toString('utf8');
  return dec.includes('音频周报 2026-W32') && dec.includes('cid:chart1');
})());
ok('内嵌图片 part 带 Content-ID <chart1>', eml.includes('Content-ID: <chart1>') && eml.includes('Content-Disposition: inline'));
ok('MIME 边界正确闭合(--boundary--)', /------=_sb_audio_weekly_boundary--\r\n$/.test(eml));
ok('b64Utf8 中文可逆', Buffer.from(AX.b64Utf8('音频周报'), 'base64').toString('utf8') === '音频周报');

/* ---------- 空模型不崩 ---------- */
ok('空模型可生成(全部占位提示)', (() => { const h = AX.buildWeeklyHtml({}, 'data'); return h.includes('本周无遗留问题') || h.includes('（'); })());

/* ============================================================
   R6 · Outlook 版式断言（用户实拍问题的回归锁）
   ① 表格长短不一 → 全篇统一 1000px 版心 + table-layout:fixed + colgroup 列宽合计=表宽
   ② 100% 缩放越界 → 宽表(>8列)走高清 PNG；没 PNG 时按列切块，任一表 ≤8 列
   ③ 单元格一堆 ↵  → 标签间零空白（>\s+< 必须零命中）
   ④ 数字挤在一起  → 数字列右对齐 + padding + nowrap
   ============================================================ */
const WIDE_HDR = ['系列', '25年收入', '26年收入', '收入同比', '25年销毛额', '26年销毛额', '销毛额同比', '25年销毛率', '26年销毛率', '25年NSIP', '26年NSIP', 'NSIP同比', '全年BP', 'BP达成率', '全年预测', '预测达成率'];
const WIDE_ROW = ['音频合计', '$3,866,892.0', '$5,874,525.0', '+51.9%', '$861,351.0', '$1,270,278.0', '+47.5%', '22.3%', '21.6%', '$88.2', '$89.9', '+$1.7', '$11.2', '52%', '$10.0', '58%'];
const modelWide = {
  week: '2026-W33', dateStr: '2026-08-10', industry: 'audio', industryLabel: '音频',
  summary: [{ t: '本周 SO（W33）', v: '5,331台', sub: 'WoW +12%' }, { t: '2026 累计SO 同比', v: '+22%', sub: '累计 49,642' }, { t: '当前 库存', v: '382', sub: '2 个国家合计' }, { t: '渠道 DOS', v: '10 天', sub: '巴西' }],
  issues: [{ type: '要货', todo: 'SE 5 Max 报要货', prog: '编码已出', due: '2026-08-05', geo: '所有国家' }],
  fin: { note: '2026年1~6月实际', tables: [{ title: '分产品系列', header: WIDE_HDR, rows: [WIDE_ROW], totalIdx: 0 }] },
  bounty: { note: '累计SI=Sell-in', header: ['国家', '大盘年空间', '目标份额', 'SI目标', '26年累计SI', 'SI达成率'], rows: [['墨西哥', '1,758,769', '17%', '294,000', '171,362', '58%'], ['合计', '7,923,722', '10%', '764,000', '308,187', '40%']] },
  ind: { kpis: [{ t: '2026年 Sell In YTD', v: '40,926台', sub: '同比 +24%' }], chartPng: 'data:image/png;base64,iVBORw0KGgo=', title: '音频 · Sell Out · 周维度', hint: '红实线=2026' },
  title: { text: 'W33 环比-15%\n墨西哥回落', size: 15, bold: true },
  // 三行:第 2 行(索引1)是明细 → 才会命中斑马纹;第 3 行是合计 → 走合计底色
  countries: [{ name: '巴西', chips: '26累计SO 5,331', header: ['Product', '26累计SO', '25同期', 'SO同比'], rows: [['Product D Buds', '2,060', '—', '—'], ['Product E Buds Pro', '1,795', '1,402', '28%'], ['合计', '5,331', '4,369', '22%']], hasTotal: true }],
  blocks: [{ title: 'SE 5 Max 上市', text: '首销 W36', atts: ['方案V2.pptx'] }],
};
const hW = AX.buildWeeklyHtml(modelWide, 'cid');
ok('R6-1 标签之间零空白(>\s+< 零命中 → Word 里不再出现 ↵ 段落标记)', !/>\s+</.test(hW));
ok('R6-2 每个 <table 都锁死 1000px 版心 + table-layout:fixed', (function () {
  const ts = hW.match(/<table[^>]*>/g) || [];
  return ts.length > 0 && ts.every(t => /table-layout:fixed/.test(t) && /width="1000"/.test(t));
})());
ok('R6-3 每个表都有 colgroup 且列宽合计恰好=1000(不等会被 Word 重新 autofit)', (function () {
  const gs = hW.match(/<colgroup>[\s\S]*?<\/colgroup>/g) || [];
  if (!gs.length) return false;
  return gs.every(g => {
    const ws = [].concat.apply([], [...g.matchAll(/<col width="(\d+)"/g)]).filter((x, i) => i % 2 === 1).map(Number);
    const arr = [...g.matchAll(/<col width="(\d+)"/g)].map(x => +x[1]);
    return arr.length > 0 && arr.reduce((a, b) => a + b, 0) === 1000;
  });
})());
ok('R6-4 任一 HTML 表列数 ≤8(宽表被切块或转图,不会横向越界)', (function () {
  const rows = hW.match(/<tr>[\s\S]*?<\/tr>/g) || [];
  return rows.length > 0 && rows.every(r => ((r.match(/<t[hd][\s>]/g) || []).length) <= 8);
})());
ok('R6-5 数字列右对齐 + 内边距 + 不换行(数字不再挤在一起)', /text-align:right;white-space:nowrap/.test(hW) && /padding:6px 10px/.test(hW));
ok('R6-6 表头底色 + 斑马纹(可读性)', hW.indexOf('#F5F6F7') >= 0 && hW.indexOf('#FAFBFC') >= 0);
ok('R6-7 仍然零 class / flex / grid / 外部CSS(Word 引擎兼容)', !/class=|<link|display:flex|display:grid/.test(hW));
ok('R6-8 摘要卡渲染在最前(4 个关键数)', hW.indexOf('本周 SO') > 0 && hW.indexOf('本周 SO') < hW.indexOf('一 · 遗留问题'));
ok('R6-9 产业名进标题(切平板后标题跟着变)', AX.buildWeeklyHtml(Object.assign({}, modelWide, { industryLabel: '平板' }), 'data').indexOf('平板周报') >= 0);
ok('R6-10 多行文本转 <br> 而非裸换行(否则 Word 出 ↵)', hW.indexOf('W33 环比-15%<br>墨西哥回落') >= 0);
ok('R6-11 PDF 模式(data)同样零空白且锁宽', (function () { const h = AX.buildWeeklyHtml(modelWide, 'data'); return !/>\s+</.test(h) && /width="1000"/.test(h); })());
ok('R6-12 浏览器侧给了 PNG 时,宽表走 <img cid 内嵌', (function () {
  const m2 = JSON.parse(JSON.stringify(modelWide));
  m2.fin.tables[0].img = 'data:image/png;base64,AAA'; m2.fin.tables[0].cid = 'fin1';
  const h = AX.buildWeeklyHtml(m2, 'cid');
  return h.indexOf('src="cid:fin1"') >= 0 && h.indexOf('width="1000"') >= 0;
})());

/* ---------- R7 邮件不挂附件(用户明确要求:Outlook 只要版式) ---------- */
const relOnly = AX.buildEml('周报', '<div>x</div>', [{ cid: 'chart1', b64: 'AAA' }]);
ok('R7-1 .eml 结构恒为 multipart/related,不出现 mixed/attachment',
  relOnly.indexOf('Content-Type: multipart/related') >= 0
  && relOnly.indexOf('multipart/mixed') < 0 && relOnly.indexOf('Content-Disposition: attachment') < 0);
ok('R7-2 M6 附件只在正文里点名,说明是「随存档保存在本机」',
  AX.buildWeeklyHtml(model, 'cid').indexOf('随存档保存在本机') >= 0);

/* ---------- R8 导出缓存「先清后填」(源码级回归守卫) ----------
   一键导出不重新取数,只读渲染留下的 auW.finPb/_bountyExport/cbLast。
   若渲染器在早退分支不清缓存,切产业后导出会把上一个产业的数字印在新标题下
   (实测:平板没有财经 LV1 → renderAuFin 早退 → M2 仍是音频的表)。
   所以要求三个渲染器都在**第一个 await 之前**把自己的缓存清空。 */
const fs = require('fs');
const src = fs.readFileSync(require('path').join(__dirname, 'views', 'audio-view.js'), 'utf8');
function clearsBeforeAwait(fnName, clearRe) {
  const i = src.indexOf('async function ' + fnName);
  if (i < 0) return false;
  const head = src.slice(i, i + 1200);
  const a = head.search(/\bawait\b/);
  const c = head.search(clearRe);
  return c >= 0 && (a < 0 || c < a);
}
ok('R8-1 M2 渲染在取数前先清 finPb/finBlk/finRb', clearsBeforeAwait('renderAuFinImpl', /auW\.finPb\s*=\s*null/));
ok('R8-2 M3 渲染在取数前先清 _bountyExport', clearsBeforeAwait('renderAuBountyImpl', /auW\._bountyExport\s*=\s*null/));
ok('R8-3 M5 渲染在取数前先清 cbLast', clearsBeforeAwait('renderAuCountryImpl', /auW\.cbLast\s*=\s*\[\]/));
ok('R8-4 四个异步模块的渲染都登记进 _inflight(导出前能等)',
  ['auTrack(\'fin\'', 'auTrack(\'bounty\'', 'auTrack(\'cb\'', 'auTrack(\'ind\''].every(s => src.indexOf(s) >= 0));
ok('R8-5 导出前的就绪检查已导出到 window', src.indexOf('window.auEnsureWeeklyData = auEnsureWeeklyData') >= 0);
const exp = fs.readFileSync(require('path').join(__dirname, 'audio-export.js'), 'utf8');
ok('R8-6 三个导出入口都先等就绪', (exp.match(/auEnsureWeeklyData\(\)/g) || []).length >= 3);
ok('R8-7 model 里不再带附件本机路径(邮件不挂附件)', exp.indexOf('attFiles:') < 0);


/* ---------- R9 上下表格对齐 + Outlook 收件人（用户 2026-08-21 反馈） ---------- */
const grpModel = {
  week: '2026-W34', industryLabel: '平板',
  fin: { note: 'n', tables: [
    { title: '分产品系列', header: ['系列', '25年收入', '26年收入'], rows: [['平板合计', '$8,191,846.0', '$12,445,134.0']], totalIdx: 0 },
    { title: '分国家办', header: ['系列', '25年收入', '26年收入'], rows: [['中美加勒比国家办', '$1,000.0', '$2,000.0']], totalIdx: 0 }] },
  countries: [
    { name: '巴西', header: ['Product', '26累计SO', '库存'], rows: [['Slate SE 11', '8,492', '1,200']] },
    { name: '墨西哥', header: ['Product', '26累计SO', '库存'], rows: [['SonicBuds SE4 ANC', '12', '9']] }],
};
const colsOf = html => [...html.matchAll(/<colgroup>([\s\S]*?)<\/colgroup>/g)]
  .map(g => [...g[1].matchAll(/<col width="(\d+)"/g)].map(x => +x[1]))
  .filter(a => a.length > 1);                       // 过滤掉外层 1 列容器
const gw = colsOf(AX.buildWeeklyHtml(grpModel, 'data'));
ok('R9-1 M2 的两张同结构表列宽完全一致(上下左右边缘对齐)',
  JSON.stringify(gw[0]) === JSON.stringify(gw[1]), JSON.stringify(gw.slice(0, 2)));
ok('R9-2 M5 的各国块列宽完全一致', JSON.stringify(gw[2]) === JSON.stringify(gw[3]), JSON.stringify(gw.slice(2, 4)));
ok('R9-3 每张表列宽合计仍恒等于 1000', gw.every(a => a.reduce((x, y) => x + y, 0) === 1000));

// 宽表切块均摊：16 列不能切成 8+8+2（最后一段 2 列撑满 1000px 极难看）
const chunk16 = AX._chunk(Array.from({ length: 16 }, (_, i) => 'C' + i), [], 8).map(p => p.header.length);
ok('R9-4 16 列均摊成 6/6/6 而不是贪心的 8/8/2', JSON.stringify(chunk16) === '[6,6,6]', JSON.stringify(chunk16));
ok('R9-5 每段都 ≤8 列且都带回首列', chunk16.every(n => n <= 8 && n >= 2));
const chunk9 = AX._chunk(Array.from({ length: 9 }, (_, i) => 'C' + i), [], 8).map(p => p.header.length);
ok('R9-6 9 列切成两段 5/5 而不是 8/2', JSON.stringify(chunk9) === '[5,5]', JSON.stringify(chunk9));

// 收件人
ok('R9-7 中文显示名按 RFC2047 编码、地址原样、分号转逗号',
  AX.formatAddrList('张三 <a@x.com>; 李四 <b@x.com>') === '=?UTF-8?B?5byg5LiJ?= <a@x.com>, =?UTF-8?B?5p2O5Zub?= <b@x.com>');
ok('R9-8 纯地址原样保留', AX.formatAddrList('a@x.com, b@y.com') === 'a@x.com, b@y.com');
ok('R9-9 只有显示名也收下(Outlook 开草稿时按通讯录解析)',
  AX.formatAddrList('张三; 李四').split(', ').length === 2);
ok('R9-10 空值不产生头', AX.formatAddrList('') === '' && AX.formatAddrList(null) === '');
const emlTo = AX.buildEml('主题', '<div>x</div>', [], { to: '张三 <a@x.com>', cc: 'c@x.com' });
ok('R9-11 .eml 带 To/Cc 头且在 Subject 之前', /^To: .+\r\nCc: .+\r\nSubject: /.test(emlTo));
const emlNo = AX.buildEml('主题', '<div>x</div>', []);
ok('R9-12 没填收件人时不出空的 To/Cc 头', emlNo.indexOf('To:') < 0 && emlNo.indexOf('Cc:') < 0);

// M1 遗留问题：状态列进正文
const issModel = { week: 'W1', issues: [{ type: '要货', todo: 'SE5 报要货', prog: '编码已出', status: '有风险', due: '2026-08-05（已超期16天）', geo: '所有国家' }] };
const issHtml = AX.buildWeeklyHtml(issModel, 'data');
ok('R9-13 M1 表带「状态」列', issHtml.indexOf('状态') >= 0 && issHtml.indexOf('有风险') >= 0);
ok('R9-14 M1 的超期说明原样进正文', issHtml.indexOf('已超期16天') >= 0);



/* ---------- R10 周报 v3(用户 W34 邮件版式) ---------- */
const v3m = {
  week: '2026-W34', industryLabel: '平板', version: 'v57', builtAt: 'x', dateStr: '2026-08-21', genTime: '10:00',
  greet1: '各位领导同事好，请查收W34拉美平板销售团队周报',
  greet2: '周报涉及产业经营信息，此邮件禁止转发/截屏，请注意信息安全。',
  title: '拉美平板销售团队周报-W34',
  issues: [{ type: '要货', todo: 'X', prog: 'Y', status: '有风险', due: '2026-08-15（已超期6天）', geo: '巴西' }],
  finTitle: '全年达成进度（产业经营）-月度刷新-2026-06（预测为6月预测）',
  fin: { tables: [{ title: '分产品系列', header: ['系列', '26年收入'], rows: [['平板合计', '$12.4M']], totalIdx: 0 }] },
  sales: {
    overall: { text: '大区整体销售：W34 WoW-5%，SO同比+30%', img: 'data:image/png;base64,AAA', cid: 'trend1' },
    family: { text: '系列销售情况：Slate WoW-23%', table: { header: ['Family', '26累计SO'], rows: [['Slate', '62,301'], ['合计', '102,126']], hasTotal: true } },
    rep: { text: '国家办销售情况：截止W34，SO同比+15%', table: { header: ['国家办', '26累计SO'], rows: [['墨西哥国家办', '26,507'], ['合计', '102,126']], hasTotal: true } },
    countries: [
      { name: '墨西哥', text: '墨西哥：截止W34，SO同比+15%', table: { header: ['Product', '26累计SO'], rows: [['Coral', '7,429']], hasTotal: false } },
      { name: '巴西', text: '巴西：截止W34，SO同比+12%', table: { header: ['Product', '26累计SO'], rows: [['Marlin', '8,606']], hasTotal: false } },
    ],
  },
  newprods: [{
    name: 'Tarpon', text: '新品进展-Tarpon：当前2国累计销售1,982台，同比上代首销同期+25%',
    table: { header: ['国家', '首销日期', '实际达成', '首销目标', '达成率', '同比上代'], rows: [['巴西', '2026/07/20', '1,200', '5,000', '24%', '+25%'], ['合计', '', '1,982', '8,000', '25%', '+25%']], hasTotal: true },
    info: { main: { header: ['产品', '认证型号', '样机编码', '最晚发货'], rows: [['Tarpon', 'TPN-W09', 'SMP-001、SMP-002', '2026/07']] },
            plan: { header: ['国家', '预售', '线上首销', '线下首销'], rows: [['巴西', '7/15', '7/20', '7/25']] } },
  }],
};
const v3h = AX.buildWeeklyV3Html(v3m, 'data');
ok('V3-1 问候两行在大表之外(加粗)', v3h.indexOf('各位领导同事好') < v3h.indexOf('<table') && /<b[^>]*>|font-weight:bold/.test(v3h.slice(0, v3h.indexOf('<table'))));
ok('V3-2 只有一张外层大表框住全部内容(嵌套数据表除外)', (() => {
  const outer = v3h.slice(v3h.indexOf('<table'));
  // 外层表闭合于最末,且问候后所有 section 都在其中
  return v3h.indexOf('本周重点关注') > v3h.indexOf('<table') && /<\/table>$/.test(v3h);
})());
ok('V3-3 大表锁 1000px + table-layout:fixed', /<table[^>]*width="1000"[^>]*table-layout:fixed/.test(v3h.replace(/style="([^"]*)"/g, (a, b) => 'style="' + b + '" ' + b)));
ok('V3-4 重点关注 6 列表头齐全', ['类型', '重点工作/通知', '进展', '状态', '截止时间', '涉及国家办/国家'].every(t => v3h.indexOf(t) >= 0));
ok('V3-5 超期/有风险标红', v3h.indexOf('color:#C7000B">有风险') >= 0 || /color:#C7000B[^>]*>[^<]*有风险|有风险[\s\S]{0,80}#C7000B/.test(v3h));
ok('V3-6 财经标题行带月度刷新与预测版本', v3h.indexOf('月度刷新-2026-06（预测为6月预测）') >= 0);
ok('V3-7 叙述句首「xxx：」加粗', v3h.indexOf('<b>大区整体销售：</b>') >= 0 && v3h.indexOf('<b>墨西哥：</b>') >= 0);
ok('V3-8 六国表共用列宽(同结构)', (() => {
  const gs = [...v3h.matchAll(/<colgroup>([\s\S]*?)<\/colgroup>/g)].map(g => [...g[1].matchAll(/<col width="(\d+)"/g)].map(x => +x[1]));
  const two = gs.filter(a => a.length === 2 && a[0] + a[1] === 1000);
  // 墨西哥/巴西两张 2 列表列宽应一致
  return two.length >= 2 && JSON.stringify(two[two.length - 1]) === JSON.stringify(two[two.length - 2]);
})());
ok('V3-9 新品区块含首销表与新品信息', v3h.indexOf('新品进展-Tarpon') >= 0 && v3h.indexOf('新品信息') >= 0 && v3h.indexOf('样机编码') >= 0);
ok('V3-10 正文 12pt 微软雅黑、零 class/flex/grid', /font-size:12pt/.test(v3h) && !/class=|display:flex|display:grid/.test(v3h));
ok('V3-11 标签间零空白(无 Word ↵)', !/>\s+</.test(v3h));
ok('V3-12 悬赏奖不给就不出现(默认隐藏)', v3h.indexOf('悬赏奖') < 0);
const v3b = AX.buildWeeklyV3Html(Object.assign({}, v3m, { bounty: { note: 'n', header: ['国家', 'SI'], rows: [['墨西哥', '1']] } }), 'data');
ok('V3-13 悬赏奖给了才出现', v3b.indexOf('悬赏奖') >= 0);
/* V3-15~17 整表自适应(用户 2026-08-21 第二轮拍板:任何表不许拆段,字号自动缩) */
const wideH = ['系列'].concat(Array.from({ length: 15 }, (_, i) => '指标' + i));
const wideR = t => [[t].concat(Array.from({ length: 15 }, () => '$12,445,134.0'))];
const fitM = { title: 'T', greet1: 'g', finTitle: 'F', fin: { tables: [
  { title: 'A', header: wideH, rows: wideR('平板合计'), totalIdx: 0 },
  { title: 'B', header: ['国家办'].concat(wideH.slice(1)), rows: wideR('中美加勒比国家办'), totalIdx: 0 }] } };
const fitH = AX.buildWeeklyV3Html(fitM, 'data');
ok('V3-15 宽表绝不拆段(无「上表续」),单张 16 列完整表', fitH.indexOf('上表续') < 0 && (() => {
  const cg = [...fitH.matchAll(/<colgroup>([^]*?)<\/colgroup>/g)].map(g => (g[1].match(/<col /g) || []).length);
  return cg.filter(n => n === 16).length === 2;
})());
ok('V3-16 同结构两张宽表列宽逐列一致且合计=1000', (() => {
  const cg = [...fitH.matchAll(/<colgroup>([^]*?)<\/colgroup>/g)].map(g => [...g[1].matchAll(/<col width=\"(\d+)\"/g)].map(x => +x[1])).filter(a => a.length === 16);
  return cg.length === 2 && JSON.stringify(cg[0]) === JSON.stringify(cg[1]) && cg[0].reduce((a, b) => a + b, 0) === 1000;
})());
ok('V3-17 长金额宽表字号自动缩(<12px,而不是拆段)', (() => {
  const fs = [...fitH.matchAll(/font-size:(\d+)px/g)].map(x => +x[1]);
  return fs.length > 0 && Math.min.apply(null, fs) < 12 && Math.min.apply(null, fs) >= 7;
})());
ok('V3-14 空模型不炸且仍是合法骨架', (() => { const h = AX.buildWeeklyV3Html({}, 'data'); return h.indexOf('<table') >= 0 && /<\/table>$/.test(h); })());


console.log(f ? ('\n' + f + ' FAILED') : '\nALL PASS'); process.exit(f ? 1 : 0);

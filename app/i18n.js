'use strict';
/* ============================================================
   Salesboard · 中英双语（i18n）
   目标：一个全局切换按钮（侧栏底部 中/EN），覆盖所有看板的界面文案。

   实现方式（为什么不是传统 key-based i18n）：
   本项目 18k+ 行渲染代码里中文写死在各处，全部抽 key 工作量巨大且回归风险高。
   这里采用「运行时词典替换」：
     · DICT  精确匹配词条（zh→en），一并生成反向表（en→zh）用于切回；
     · RULES 正则规则，处理动态拼出的文案（如 "26累计SO"、"已隐藏 3 行"）；
     · 切到 EN 时遍历文本节点 + title/placeholder/data-tip/aria-label 属性做替换，
       并用 MutationObserver 对后续重绘的 DOM 持续生效（各视图 innerHTML 整块重绘）。
   边界（如实）：
     · ECharts 画布内文字不经过 DOM，不受影响——示例数据已是英文字母（Product A…），
       轴刻度是日期/数字，天然双语中立；
     · 词典未收录的长句（部分说明性 note）保持中文，词典可持续追加；
     · 业务数据本身（国家名、导入的真实底表内容）不翻译——那是数据不是界面。
   持久化：localStorage['sb.ui.lang'] = 'zh' | 'en'（默认 zh）。
   ============================================================ */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.SbI18n = api;
})(this, function () {

  const LS_KEY = 'sb.ui.lang';
  const hasDoc = () => typeof document !== 'undefined';

  /* ---------------- 词典（zh → en，精确匹配 trim 后全文） ---------------- */
  const DICT = {
    /* —— 侧栏 / 全局 —— */
    '分析': 'Analysis', '助手': 'Assistant',
    'AI 问答': 'AI Q&A', '产业看板': 'Industry', 'PSI 数据分析': 'PSI Analytics',
    '国家看板': 'Country Board', '汇总表': 'Summary Table', '路标管理': 'Roadmap',
    '经营分析': 'Business Review', '定价测算': 'Pricing Calc', '产品定价库': 'Pricing Library',
    '自定义图表': 'Custom Charts', '看板设计器': 'Board Designer', '数据源': 'Data Sources',
    '库存管理': 'Inventory', '文字输出': 'Text Output', '音频周报': 'Audio Weekly', '产业周报': 'Industry Weekly',
    // ---- 音频周报看板(部分词条同时惠及产业看板) ----
    'M1 · 遗留问题': 'M1 · Open Issues', 'M2 · 音频产业经营进展': 'M2 · Audio BU Business Progress',
    'M2 · 平板产业经营进展': 'M2 · Tablet BU Business Progress', '产业': 'Industry', '重置': 'Reset',
    'M3 · $0-50美金扩大覆盖悬赏奖 SI 进展': 'M3 · $0-50 Coverage Bounty SI Progress',
    'M4 · 周度销售进展': 'M4 · Weekly Sales Progress', 'M5 · 产品维度': 'M5 · Product View',
    'M6 · 新品进展': 'M6 · New Product Updates',
    '一键导出整份周报 ▸': 'Export full weekly ▸', 'Outlook 邮件(.eml)': 'Outlook email (.eml)',
    '＋加一行': '+ Add row', '＋加国家行': '+ Add country row', '＋加一块': '+ Add block', '＋添加国家': '+ Add country',
    'B 加粗': 'B Bold', '字号': 'Font size', '拆分': 'Split by', '月份': 'Month', '金额单位': 'Amount unit',
    '类型': 'Type', '待办': 'To-do', '进展': 'Progress', '截止时间': 'Due date', '涉及国家/国家办': 'Countries/Rep Offices',
    '系列': 'Series', '国家办': 'Rep Office', '分产品系列(音频 LV3)': 'By Product Series (Audio LV3)',
    '分国家办(音频)': 'By Rep Office (Audio)', '截止最新实际月': 'Thru latest actual month',
    '大盘年空间(手工)': 'TAM/yr (manual)', '目标份额%(手工)': 'Target share % (manual)', 'SI目标(手工)': 'SI target (manual)',
    '26年累计SI(自动)': "'26 cum SI (auto)", 'SI达成率(自动)': 'SI attainment (auto)',
    'SI产品(Product Name)': 'SI products (Product Name)', 'SI型号(可再收窄)': 'SI models (optional)',
    'SI时间范围': 'SI date range', '全部产品': 'All products', '不限型号': 'Any model',
    '选择要展示的国家': 'Pick countries to show', '筛选 ▸': 'Filters ▸', '对比·去年灰线 ▸': 'Compare · LY grey ▸',
    'PSI指标': 'PSI metric', '时间粒度': 'Granularity', '线型': 'Line style', '平滑': 'Smooth',
    '今年线色': 'CY line color', '去年线色': 'LY line color', '台': 'Units', '千台K': 'K units', '万台W': '10K units',
    '（不对比）': '(no compare)',
    '完全离线运行': 'Runs fully offline', '数据只读本机文件夹': 'Reads local folders only',
    '隐藏此看板': 'Hide this board', '恢复默认排序': 'Reset nav order',
    '浅色': 'Light', '深色': 'Dark', '跟随系统': 'System',
    '高': 'High', '均衡': 'Balanced', '性能': 'Perf',
    '高画质：全玻璃+高光+背景缓动': 'High: full glass + sheen + ambient motion',
    '均衡(默认)：降模糊、关背景动画': 'Balanced (default): reduced blur, no bg motion',
    '性能优先：关玻璃与装饰动画': 'Performance: glass & decorative motion off',
    '浅色主题': 'Light theme', '深色主题': 'Dark theme', '主题': 'Theme', '视觉质量': 'Visual quality',

    /* —— 顶栏 / 数据条 —— */
    '载入示例': 'Load Sample', '刷新': 'Refresh', '未锚定文件夹': 'No folder linked',
    '锚定文件夹': 'Link Folder', '示例数据': 'sample data',
    '重新扫描所有已锚定文件夹（PSI/库存/经营/IDC/发货/成本），刷新到各看板': 'Rescan all linked folders and refresh every board',

    /* —— 通用按钮 / 通用词 —— */
    '保存': 'Save', '取消': 'Cancel', '确定': 'OK', '完成': 'Done', '删除': 'Delete',
    '恢复': 'Restore', '全部恢复': 'Restore All', '导出': 'Export', '导入': 'Import',
    '全部': 'All', '合计': 'Total', '暂无数据': 'No data', '已导出': 'Exported',
    '📊 导出表格 (Excel)': '📊 Export Table (Excel)', '🖼 导出图表 (PPT)': '🖼 Export Chart (PPT)',
    '导出 Excel': 'Export Excel', '导出 Excel(全部)': 'Export Excel (All)',
    '导出 PPT': 'Export PPT', '导出PPT': 'Export PPT', '导出表格 (Excel)': 'Export Table (Excel)',
    '导出图表 (PPT)': 'Export Chart (PPT)', '导出底表': 'Export Source', '导出JSON': 'Export JSON',
    '导入JSON': 'Import JSON', '导出图片': 'Export Image',
    '图片': 'Image', 'Excel': 'Excel',

    /* —— PSI —— */
    '粒度': 'Granularity', '日': 'Day', '周': 'Week', '月': 'Month',
    '图表': 'Chart', '堆积面积': 'Stacked Area', '折线': 'Line', '堆积柱': 'Stacked Bar',
    '占比(100%)': '100% Stacked', '分组柱': 'Grouped Bar',
    '数据单位': 'Unit', '单台': 'Units', '千台 K': 'K Units', '万台 W': '10K Units',
    '图例位置': 'Legend', '顶部居中': 'Top', '底部': 'Bottom', '左侧': 'Left', '右侧': 'Right',
    '透明度': 'Opacity', '↺ 重置顺序': '↺ Reset Order', '↺ 重置配色': '↺ Reset Colors',
    '▪ 数据标签': '▪ Data Labels', '标签字号': 'Label Size', '标签色': 'Label Color', '自动': 'Auto',
    '∿ 平滑曲线': '∿ Smooth', '系列/颜色维度': 'Series Dim',
    '区间统计': 'Range Stats', '库存 INV': 'Inventory', 'DOS': 'DOS',
    '点左侧色块 或 直接点图上的系列 都能改色': 'Click a swatch on the left, or a series on the chart, to recolor',
    '配色顺序（点色块改色）': 'Color order (click swatch to recolor)',
    '导入数据后显示堆叠系列': 'Stack series appear after data is loaded',
    '按【': 'By [', '】配色（点色块改色 · ▲▼调顺序）': '] colors (click to recolor · ▲▼ reorder)',

    /* —— 汇总表 / 国家看板 —— */
    '拆分维度': 'Split Dim', '看板维度': 'Board Dim', '每块拆分': 'Block Split',
    '周范围': 'Week Range', '行排序': 'Row Sort', '已隐藏行': 'Hidden Rows',
    '国家排序': 'Country Sort', '国家办排序': 'Rep Sort', '名称': 'Name',
    '按国家': 'By Country', '按国家办': 'By Rep Office',
    '累计SO': 'Cum SO', '累计SI': 'Cum SI', '库存': 'Inventory', '库存(pcs)': 'Inv (pcs)',
    'SO同比': 'SO YoY', 'SI同比': 'SI YoY', 'WoW%': 'WoW%',
    '全流程库存': 'E2E Inv', '全流程DOS': 'E2E DOS', '国家仓+FDC': 'CDC+FDC',
    '同比': 'YoY', '缩放': 'Zoom',
    '⇅ 自定义排序：开': '⇅ Custom Sort: ON', '⇅ 自定义排序：关': '⇅ Custom Sort: OFF',
    '点击排序': 'Click to sort',
    '点击按此列排序（再点切换升↔降）': 'Click to sort by this column (click again to flip)',
    '点击按此列排序（再点切换升↔降）· 所有国家的表同步': 'Click to sort (all country tables sync)',
    '隐藏此行（不影响合计，可在卡片头恢复）': 'Hide row (totals unaffected; restore from card header)',
    '隐藏此行（不影响合计，可在上方「已隐藏行」恢复）': 'Hide row (totals unaffected; restore above)',
    '点击管理已隐藏的行（合计不受隐藏影响）': 'Manage hidden rows (totals unaffected)',

    /* —— 路标管理 —— */
    '路标图': 'Roadmap Chart', '生命周期': 'Lifecycle', '列表': 'List', '上市节奏': 'Launch Cadence',
    '+产品': '+ Product', '+ 产品': '+ Product', '＋新建系列': '+ New Series',
    '+样机': '+ Sample Unit', '+ 样机': '+ Sample Unit', '+产品系列': '+ Series', '+ 产品系列': '+ Series',
    '手机': 'Phone', '穿戴': 'Wearable', '平板': 'Tablet', '音频': 'Audio',
    '计价': 'Currency', '本币': 'Local FX', '年份': 'Year', '时间': 'Time', '复位': 'Reset',
    '框样式...': 'Box style…', '型号拆解': 'Split by model', '显示样机': 'Show samples',
    'Y量程': 'Y range', '加产品': 'Add Product', '编辑产品': 'Edit Product',
    '产品销售生命周期': 'Product Sales Lifecycle', '在售区间': 'On-sale span',
    '上市': 'Launch', '销售结束': 'Sales End',
    'EOM+180（之后不可投激励）': 'EOM+180 (no incentives after)',
    '产品传播名': 'Product Name', '品类': 'Category', '产品系列归属': 'Series Group',
    '综合RRP-USD': 'Composite RRP (USD)', '最晚发货时间': 'Latest Ship Date',
    '保存缩放': 'Save Zoom',

    /* —— 经营分析 / 库存 / 数据源 —— */
    '总看板': 'Overview', '产业产品看板': 'Industry & Product', '国家办看板': 'Rep Offices',
    '自定义透视': 'Custom Pivot', '数据体检': 'Data Health',
    '发货量': 'Shipments', '渠道库存': 'Channel Inv', '渠道DOS': 'Channel DOS',
    '时间范围': 'Time Range', '筛选': 'Filter', '地理': 'Geo', '产品': 'Product',
    '成本图': 'Cost Chart', '堆积柱形图': 'Stacked Bars', '堆积面积图': 'Stacked Area',
    '百分比柱形图': '100% Bars', '图例颜色': 'Legend Colors', '缺发货补SellIn': 'Backfill SI',
    '保存到存档': 'Save Archive', '重算': 'Recalc', '全量导出': 'Full Export', '配对诊断': 'Pair Check',
    '数据源状态': 'Data Source Status', '文件夹': 'Folder', '记录数（透视后）': 'Rows (pivoted)',
    '文件数': 'Files', '维度数': 'Dims', '上次刷新': 'Last Refresh',
    '底表源（文件夹 · 字段 · 预览 · 更新时间）': 'Sources (folder · fields · preview · updated)',
    '未设置': 'Not set', '更新': 'Updated',

    /* —— AI 面板 —— */
    'AI 助手': 'AI Assistant', '发送': 'Send', '思考中…': 'Thinking…',
    '云端': 'Cloud', '本地': 'Local', '本地模型': 'Local model',

    /* —— 设计器 / PPT —— */
    '添加图表': 'Add Chart', '清空画布': 'Clear Canvas', '保存布局': 'Save Layout',
    '加载布局': 'Load Layout', '维度（拖到"类别/图例"）': 'Dims (drag to category/legend)',
    '度量（拖到"值/大小"）': 'Measures (drag to value/size)',
    '可视化图库（点击添加）': 'Chart gallery (click to add)',
    '品牌红': 'Brand Red', '商务': 'Business', '冷色': 'Cool', '暖色': 'Warm', '单色系': 'Mono',

    /* —— 数据条 / 计数类拼接文案（第二批，来自实机核验） —— */
    'PSI 销量/库存': 'PSI Sales / Inventory', '数据截至': 'Data through',
    '全流程库存截至': 'E2E inventory through', '来源 PSI文件夹（内置示例）': 'Source: PSI folder (built-in sample)',
    '刷新 —': 'Refreshed —', '条 （示例数据）': 'rows (sample data)', '条': 'rows',
    '全部系列合计': 'All series total', '线上+线下(合计)': 'Online+Offline (all)',
    '国家看板 · PSI+全流程': 'Country Board · PSI + E2E', '汇总表 · PSI+全流程': 'Summary · PSI + E2E',

    /* —— 第三批：路标/上市计划/全角按钮（实机核验） —— */
    '＋产品': '+ Product', '＋样机': '+ Sample Unit', '＋产品系列': '+ Series',
    '上市计划': 'Launch Plan', '+ 行': '+ Row', '行': 'Row',
    '国家': 'Country', '预售时间': 'Pre-sale', '线上首销': 'Online Launch', '线下首销': 'Offline Launch',
    '整体首销': 'Overall Launch', '首销名义台数': 'Launch Units', '生命周期目标': 'Lifecycle Target',
    'AATP预计': 'AATP Est.', '主力渠道': 'Key Channels', '首销毛利率': 'Launch GM%',
    '首销Offer': 'Launch Offer', '备注': 'Notes',
    '产业看板 · PSI+全流程': 'Industry · PSI + E2E', 'PSI 销量/库存 · PSI+全流程': 'PSI · E2E',
  };

  /* ---------------- 动态文案正则规则（zh→en；EN→zh 靠重绘还原） ---------------- */
  const RULES = [
    [/^(\d{2})累计SO$/, '$1 Cum SO'],
    [/^(\d{2})累计SI$/, '$1 Cum SI'],
    [/^(\d{2})同期SO总?$/, "$1 LY SO"],
    [/^(\d{2})同期SI总?$/, "$1 LY SI"],
    [/^(\d{2})年累计SO$/, '$1 Cum SO'],
    [/^(\d{2})年同期SO$/, '$1 LY SO'],
    [/^已隐藏 (\d+) 行(?: ▾)?$/, 'Hidden $1 ▾'],
    [/^([\d,]+) 条 [（(]示例数据[）)]$/, '$1 rows (sample data)'],
    [/^([\d,]+) 条$/, '$1 rows'],
    [/^库内 (\d+) 个产品$/, '$1 products'],
    [/^共 (\d+) 个国家/, '$1 countries'],
    [/^共 (\d+) 个国家办/, '$1 rep offices'],
    [/^Sell (Out|In) · 按(.+)堆叠 · ([\d,]+)条$/, 'Sell $1 · by $2 · $3 rows'],
    [/^按(.+)堆叠 · ([\d,]+)条$/, 'by $1 · $2 rows'],
    [/^([\d,]+)台$/, '$1 units'],
    [/^峰值期 (.+)$/, 'Peak $1'],
    [/^(.+) · (\d+)期$/, '$1 · $2 periods'],
    [/^（(\d{4}-\d{2}-\d{2}) 起）$/, '(from $1)'],
    [/^共 (\d+) 个产品.*$/, '$1 products · concurrent products side by side · open end = on sale'],
  ];

  /* 反向词典（en→zh），切回中文时用；正则规则靠视图重绘天然还原 */
  const RDICT = {};
  Object.keys(DICT).forEach(k => { if (!(DICT[k] in RDICT)) RDICT[DICT[k]] = k; });

  /* 纯函数：翻译一段文本（可单测） */
  function trText(s, toEn) {
    if (s == null) return s;
    const raw = String(s);
    const t = raw.trim();
    if (!t) return raw;
    if (toEn) {
      if (DICT[t] != null) return raw.replace(t, DICT[t]);
      for (const [re, rep] of RULES) { if (re.test(t)) return raw.replace(t, t.replace(re, rep)); }
      return raw;
    }
    if (RDICT[t] != null) return raw.replace(t, RDICT[t]);
    return raw;
  }

  /* ---------------- DOM 层 ---------------- */
  const ATTRS = ['title', 'placeholder', 'data-tip', 'aria-label'];
  let _lang = 'zh', _obs = null, _applying = false;

  function walk(rootEl, toEn) {
    if (!rootEl) return;
    _applying = true;
    try {
      const tw = document.createTreeWalker(rootEl, NodeFilter.SHOW_TEXT, {
        acceptNode: n => {
          const p = n.parentNode && n.parentNode.nodeName;
          return (p === 'SCRIPT' || p === 'STYLE') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
        },
      });
      const nodes = [];
      while (tw.nextNode()) nodes.push(tw.currentNode);
      nodes.forEach(n => { const nv = trText(n.data, toEn); if (nv !== n.data) n.data = nv; });
      const host = rootEl.nodeType === 1 ? rootEl : document.body;
      if (host && host.querySelectorAll) {
        const els = [host].concat(Array.from(host.querySelectorAll('[title],[placeholder],[data-tip],[aria-label]')));
        els.forEach(el => ATTRS.forEach(a => {
          if (!el.getAttribute) return;
          const v = el.getAttribute(a); if (!v) return;
          const nv = trText(v, toEn); if (nv !== v) el.setAttribute(a, nv);
        }));
      }
    } finally { _applying = false; }
  }

  function startObserver() {
    if (_obs || !hasDoc()) return;
    _obs = new MutationObserver(muts => {
      if (_applying || _lang !== 'en') return;
      muts.forEach(m => {
        if (m.type === 'characterData') { const nv = trText(m.target.data, true); if (nv !== m.target.data) { _applying = true; m.target.data = nv; _applying = false; } }
        m.addedNodes && m.addedNodes.forEach(n => { if (n.nodeType === 1) walk(n, true); else if (n.nodeType === 3) { const nv = trText(n.data, true); if (nv !== n.data) { _applying = true; n.data = nv; _applying = false; } } });
      });
    });
    _obs.observe(document.body, { childList: true, subtree: true, characterData: true });
  }
  function stopObserver() { if (_obs) { _obs.disconnect(); _obs = null; } }

  function setLang(lang) {
    if (lang !== 'zh' && lang !== 'en') return;
    _lang = lang;
    try { localStorage.setItem(LS_KEY, lang); } catch (e) {}
    if (!hasDoc()) return;
    document.documentElement.setAttribute('lang', lang === 'en' ? 'en' : 'zh-CN');
    if (lang === 'en') { walk(document.body, true); startObserver(); }
    else { stopObserver(); walk(document.body, false); }   // 词典部分即时还原；规则文案随下次重绘还原
    syncBtns();
    try { window.dispatchEvent(new CustomEvent('sb-lang-change', { detail: { lang } })); } catch (e) {}
  }
  function getLang() { return _lang; }

  /* 切换按钮：挂进侧栏底部主题控件组（sbUiCtl），与主题/画质并列一排 */
  function syncBtns() {
    if (!hasDoc()) return;
    document.querySelectorAll('[data-lang-btn]').forEach(b =>
      b.classList.toggle('on', b.getAttribute('data-lang-btn') === _lang));
  }
  function mountBtns() {
    if (!hasDoc()) return;
    const host = document.getElementById('sbUiCtl');
    if (!host || document.getElementById('sbLangRow')) { syncBtns(); return; }
    const row = document.createElement('div');
    row.className = 'ui-ctl__row'; row.id = 'sbLangRow';
    row.setAttribute('role', 'group'); row.setAttribute('aria-label', 'Language');
    row.innerHTML =
      '<button class="ui-ctl__b ui-ctl__b--txt" data-lang-btn="zh" aria-label="中文界面">中文</button>' +
      '<button class="ui-ctl__b ui-ctl__b--txt" data-lang-btn="en" aria-label="English UI">EN</button>';
    host.appendChild(row);
    row.querySelectorAll('[data-lang-btn]').forEach(b =>
      b.addEventListener('click', () => setLang(b.getAttribute('data-lang-btn'))));
    syncBtns();
  }

  function init() {
    if (!hasDoc()) return;
    try { const v = localStorage.getItem(LS_KEY); if (v === 'en' || v === 'zh') _lang = v; } catch (e) {}
    const boot = () => { setTimeout(() => { mountBtns(); if (_lang === 'en') { walk(document.body, true); startObserver(); document.documentElement.setAttribute('lang', 'en'); } }, 0); };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
  }

  return { init, setLang, getLang, trText, DICT, RULES, RDICT, ATTRS };
});

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

    /* —— 2026-08-27 补齐：产业/汇总/国家/PSI/库存 五看板残留文案（英文模式此前仍露中文） —— */
    '千台': 'K units', '万台': '10K units', '单台': 'Units',
    '对比系列': 'Compare series', '对比产品': 'Compare product', '对比型号': 'Compare model',
    '今年': 'This year', '去年': 'Last year', '今年线颜色': 'This-year color', '去年线颜色': 'Last-year color',
    '当前 库存 Inventory': 'Current inventory', '当前 全流程库存': 'Current E2E inventory',
    '当前库存 Inventory': 'Current inventory', '当前全流程库存': 'Current E2E inventory',
    '当前库存': 'Current inventory', '当前DOS': 'Current DOS', '需库龄/全流程表': 'Needs aging / E2E table',
    '趋势': 'Trend', '对比项': 'Compare', '上市日': 'Launch date', '天': 'days',
    '两代对比 ▸': 'Generation compare', '维度': 'Dimension', '时间维度': 'Time',
    '上一代 A': 'Previous gen A', '现一代 B': 'Current gen B',
    'A上市日(选填)': 'A launch date (optional)', 'B上市日(选填)': 'B launch date (optional)',
    '留空=自动取首个SellOut>0日': 'Blank = first day with sell-out > 0',
    '生命周期粒度': 'Lifecycle granularity', '指标': 'Metric', '对比': 'Compare',
    '请先选择两代产品': 'Select two generations first', '两代不能选同一个': 'The two must differ',
    '生命周期对比取数失败': 'Lifecycle comparison failed',
    '上市前': 'Pre-launch', '上市至今(全周期)': 'Since launch (full cycle)',
    '该范围内无数据': 'No data in this range', '生命周期累计SO': 'Lifecycle cumulative SO',
    '拉美整体': 'Region total', '本期': 'Current', '同比%': 'YoY %',
    '期间': 'Period', '同期': 'Same period LY', '同期SO': 'SO (same period LY)', '同期SI': 'SI (same period LY)',
    '同期SO总': 'Total SO (LY)', '同期SI总': 'Total SI (LY)', '近4周SO': 'SO last 4 weeks',
    '平滑线': 'Smooth', '折线图': 'Line', '柱形占比图(100%)': '100% stacked', '分组柱形图': 'Grouped bar',
    '堆叠': 'Stacked', '◆ 堆叠维度': '(stack dimension)', '峰值期': 'Peak period',
    '峰值': 'Peak', '均值': 'Avg', '/期': '/period', '区间峰值': 'Range peak',
    '点击自定义颜色': 'Click to pick a color', '全部显示': 'Show all', '明细': 'Detail',
    '排序': 'Sort', '升/降序': 'Asc / Desc', '全流程': 'E2E', '仓+FDC': 'DC + FDC',
    '当前筛选无数据': 'No data for current filters', '当前无数据可导出': 'Nothing to export',
    '图表未就绪': 'Chart not ready', 'PSI 趋势分析': 'PSI trend analysis',
    '粒度：': 'Granularity: ', '（无筛选）': '(no filters)',
    'DOS为比率,合计需按库存÷日均SO重算': 'DOS is a ratio: totals recompute as inventory / daily SO',
    '已保存缩放': 'Zoom saved', '🖼 图片': 'Image', '已导出图片': 'Image exported',
    '已导出 PPT 图表': 'Chart exported to PPT', '已导出（PPT 原生表格，可编辑）': 'Exported as editable PPT table',
    '已导出（每国一个Sheet）': 'Exported (one sheet per country)',
    '已导出（每国一页）': 'Exported (one page per country)',
    '· 每块右上可单独导出': ' · each block exports on its own',
    '(左侧按产品系列归并)': '(grouped by product series)',
    '看板维度|块名|拆分维度': 'Board dim | block | split dim',
    '出错：': 'Error: ', '查询出错：': 'Query error: ', '读取失败：': 'Read failed: ',
    '从': 'From', '到': 'to', '年': 'Y', '导出图表 (PPT)': 'Export Chart (PPT)',
    '1月': 'Jan', '2月': 'Feb', '3月': 'Mar', '4月': 'Apr', '5月': 'May', '6月': 'Jun',
    '7月': 'Jul', '8月': 'Aug', '9月': 'Sep', '10月': 'Oct', '11月': 'Nov', '12月': 'Dec',
    '季': 'Quarter', '周': 'Week', '日': 'Day', '月': 'Month',

    /* 产业/品类 taxonomy（与既有 '平板': 'Tablet' 同类，属界面分类不属数据）
       注意：国家名等业务数据一律不入典——见 i18n.test.js「数据不翻译」 */
    '音频与智能配件': 'Audio & Accessories', '耳机': 'Headphones',
    '平板整机': 'Tablets', '智能穿戴与配件': 'Wearables & Accessories',
    /* 财经报表项（taxonomy，非业务数据） */
    '净销售收入': 'Net sales revenue', '销售毛利': 'Gross profit',
    '收入量': 'Revenue units', '收入量_终端': 'Revenue units (sell-through)',

    /* —— 2026-08-27 第二批：经营分析 / 产业看板 / 库存管理 三块的界面文案 —— */
    /* 经营分析 · 维度与视图 */
    '产业LV1': 'Industry (LV1)', '品类LV2': 'Category (LV2)', '产品系列LV3': 'Series (LV3)',
    'LV4 产品': 'Product (LV4)', 'LV4产品': 'Product (LV4)', '产品LV4': 'Product (LV4)',
    '产品系列': 'Product Series', '产品线': 'Product Line', '型号': 'Model', '品牌': 'Brand',
    '国家办整体': 'All rep offices', '国家办经营看板': 'Rep office board',
    '产业产品经营看板': 'Industry & product board',
    '国家办 · LV4 产品': 'Rep office · product (LV4)', '国家办LV4': 'Rep office · LV4',
    '国家办LV4产品': 'Rep office · product (LV4)',
    '国家办 × 产品系列': 'Rep office x series', '国家办×产品系列': 'Rep office x series',
    '国家办×系列': 'Rep office x series', '行维度': 'Row dimension', '选择指标': 'Pick metric',
    '全部LV1': 'All LV1', '全部LV2': 'All LV2', '全部LV3': 'All LV3', '全部LV4': 'All LV4',
    '全部国家办': 'All rep offices', '全部系列': 'All series', '全部匹配': 'All matches',
    '平板分系列': 'Tablet by series', '平板系列': 'Tablet series',
    '音频分系列': 'Audio by series', '音频系列': 'Audio series',
    /* 经营分析 · 指标 */
    '收入指标': 'Revenue metric', '销毛指标': 'Gross profit metric', '销毛率': 'GM%',
    '实际GM%': 'Actual GM%', '收入同比': 'Revenue YoY', '销毛额同比': 'Gross profit YoY',
    'NSIP同比': 'NSIP YoY', 'NSIP分母': 'NSIP denominator',
    '收入达成': 'Revenue attainment', '销售毛利率达成': 'GM% attainment',
    '收入达成 · 分 Product Family': 'Revenue attainment · by product family',
    '收入达成 · 分 Rep Office': 'Revenue attainment · by rep office',
    '销售毛利率达成 · 分 Product Family': 'GM% attainment · by product family',
    '销售毛利率达成 · 分 Rep Office': 'GM% attainment · by rep office',
    '全年BP': 'Full-year BP', '全年BP达成': 'Full-year BP attainment',
    '全年预测': 'Full-year forecast', '全年预测达成率': 'Full-year forecast attainment',
    'BP达成率': 'BP attainment', 'BP完成率': 'BP attainment', 'BP版本': 'BP version',
    'BP版本：': 'BP version: ', '预测版本': 'Forecast version', '预测达成率': 'Forecast attainment',
    '预测完成率': 'Forecast attainment', '达成率': 'Attainment', '达成(pp)': 'Attainment (pp)',
    '达成值/BP值': 'Actual / BP', '达成值/预测值': 'Actual / forecast',
    '实际/BP值': 'Actual / BP', '实际/预测': 'Actual vs forecast', '实际/预测值': 'Actual / forecast',
    '今年实际': 'Actual this year', '最新实际月': 'Latest actual month', 'vs 预测': 'vs forecast',
    '工作底稿': 'Working draft', '国家办工作底稿': 'Rep office working draft',
    'Sell In量': 'Sell-in units', 'Sell out量': 'Sell-out units',
    /* 单位 / 格式 */
    '单位': 'Unit', '单位假设': 'Unit assumption', '小数位': 'Decimals', '数值': 'Value',
    '美元 USD': 'USD', '千USD': 'K USD', '千美元': 'K USD',
    '百万 MUSD': 'MUSD', '百万美元 MUSD': 'MUSD', '数据口径': 'Definition', '口径': 'Definition',
    '（数量恒为台）': '(quantities always in units)',
    /* 库存管理 */
    '发货国家': 'Shipment country', '发货型号': 'Shipment model', '累计发货': 'Cumulative shipments',
    '库存成本金额': 'Inventory cost value', '加权成本': 'Weighted cost',
    '单台Floor cost': 'Floor cost per unit', '同一成本加总': 'Same-cost aggregation',
    '同国家': 'Same country', '老库存永不消耗': 'Old stock never consumed',
    '老库存永远留存': 'Old stock retained forever', '自身SO不足': 'Insufficient own sell-out',
    '孤儿(有发货·整段无SO)': 'Orphan (shipped, no sell-out at all)',
    '归一化身份': 'Normalized identity', '归一化后同名但原文不同': 'Same after normalization, different source text',
    '疑似同名': 'Possible duplicate name', '未识别': 'Unrecognized', '隐形筛选': 'Hidden filter',
    '汇总（当前筛选）': 'Total (current filters)', '全量底表': 'Full source table',
    '正在生成全量底表…': 'Building full source table…',
    '未加载（Sell-in/out 实际不可用）': 'Not loaded (actual sell-in/out unavailable)',
    '请先加载 PSI / 发货数据': 'Load PSI / shipment data first',
    '请先加载 PSI/发货数据': 'Load PSI / shipment data first',
    '导入成本表后显示成本图': 'Cost chart appears after a cost table is imported',
    '当前维度组合 / 筛选下没有可显示的进销存表。': 'No PSI table to show for the current dimensions / filters.',
    /* 通用小词 / 状态 */
    '是': 'Yes', '否': 'No', '无': 'None', '（无）': '(none)', '（正常）': '(normal)',
    '默认': 'Default', '自定义': 'Custom', '自定义看板': 'Custom board',
    '自定义看板-图表': 'Custom board – chart', '分组': 'Group', '图型': 'Chart type',
    '柱状': 'Bar', '饼图': 'Pie', '暂无图表': 'No chart yet', '加载数据后可用': 'Available after data loads',
    '关闭': 'Close', '刷新中': 'Refreshing', '⟳ 刷新中…': 'Refreshing…', '✓ 已存档': 'Archived',
    '已导出 PPT': 'Exported to PPT', '已粘贴': 'Pasted', '已保存到存档': 'Saved to archive',
    '导出Excel': 'Export Excel', '导出失败': 'Export failed', '导出失败：': 'Export failed: ',
    '全量导出失败：': 'Full export failed: ', '存档失败：': 'Archive failed: ',
    '导出能力（XLSX）未就绪': 'Excel export not ready',
    '导出能力（SoSimExport）未就绪': 'Simulation export not ready',
    '未保存改动': 'Unsaved changes', '年月': 'Year-month', '实际': 'Actual', '预测': 'Forecast',
    /* 第三批：产业看板 / 库存管理 的剩余可见文案 */
    '大区': 'Region', '拉美整体': 'Region total', '口径 \\ 期': 'Metric \\ Period',
    '数据体检': 'Data check', '总看板': 'Overview',
    '汇总': 'Summary', '⊕ 汇总 · 汇总（当前筛选）': '⊕ Summary · Total (current filters)',
    '📉 导出图表 (PPT)': '📉 Export Chart (PPT)', '📉 导出图表(PPT)': '📉 Export Chart (PPT)',
    '两代产品 · 生命周期对齐对比': 'Two generations · lifecycle-aligned comparison',
    '上市点拉齐 · 横轴=上市后第N期(非日历)': 'Aligned at launch · x-axis = periods since launch (not calendar)',
    '选择...': 'Select…', '选择…': 'Select…', '两代对比': 'Generation compare',
    '窗口·上市前N天': 'Window · N days before launch',
    '窗口·上市前N周': 'Window · N weeks before launch',
    '窗口·上市前N月': 'Window · N months before launch',
    '保存缩放': 'Save zoom', '💾 保存缩放': '💾 Save zoom', '💾 已保存缩放': '💾 Zoom saved', '导出 PPT(全部)': 'Export PPT (all)', '导出PPT(全部)': 'Export PPT (all)',
    '全局筛选（对所有国家生效）：': 'Global filters (all countries):',
    '全局筛选（对所有国家办生效）：': 'Global filters (all offices):',
    '每块右上可单独导出': 'each block exports on its own',
    '25年同期SO/SI及同比在明细+合计行均显示': 'LY SO/SI and YoY shown on detail and total rows',
    /* ===== batch4（2026-08-31）：AI 问答面板 + Agent 架构看板英文化 ===== */
    'AI 问答': 'AI Q&A', 'AI 问答（全局）': 'AI Q&A (global)', 'AI 问答（本看板）': 'AI Q&A (this board)',
    '全局（跨看板）': 'Global (cross-board)', 'AI 设置': 'AI Settings', '发送': 'Send',
    '发给模型的内容': 'What gets sent to the model', '保存': 'Save', '测试连接': 'Test connection',
    '网络体检': 'Network check', '拉取模型列表': 'Fetch model list', '选择文件…': 'Choose file…',
    '清空会话': 'Clear conversation', '关闭': 'Close', '设置': 'Settings',
    '提供方': 'Provider', '模型': 'Model', '自定义模型名': 'Custom model name',
    '模型文件（.gguf，留空自动查找）': 'Model file (.gguf, blank = auto-detect)',
    '服务器地址（LM Studio → Developer → Start Server）': 'Server address (LM Studio → Developer → Start Server)',
    'CLI 命令（如 corplink，需在 PATH 或写全路径）': 'CLI command (on PATH or full path)',
    '参数模板（空格分隔；文件方式用 {PROMPT_FILE} 占位）': 'Argument template (space-separated; {PROMPT_FILE} for file mode)',
    '问题怎么传给 CLI': 'How to pass the question to the CLI',
    'DeepSeek API（在线，推荐）': 'DeepSeek API (cloud, recommended)',
    'MiniMax API（在线）': 'MiniMax API (cloud)',
    'LM Studio（本机服务器）': 'LM Studio (local server)',
    '本地模型（内置 gguf）': 'Local model (built-in gguf)',
    'CorpLink CLI（Acme内网）': 'CorpLink CLI (intranet bridge)',
    '自定义…': 'Custom…', '（先拉取模型列表）': '(fetch the model list first)',
    'deepseek-chat（V4-Flash · 快 · 评测88.3%）': 'deepseek-chat (V4-Flash · fast · eval 88.3%)',
    'deepseek-v4-pro（最准93.1% · 慢,单题可达数分钟）': 'deepseek-v4-pro (most accurate 93.1% · slow)',
    '标准输入（stdin，最常见）': 'Standard input (stdin, most common)',
    '命令行参数（追加到末尾）': 'Command-line argument (appended)',
    '临时文件（参数里 {PROMPT_FILE}）': 'Temp file ({PROMPT_FILE} in args)',
    '配置仅存本机，不进存档、不外传。': 'Config stays on this machine — never archived, never uploaded.',
    '还没有发过请求。先问一句，再点这里就能看到「发给模型的原文」。': 'No request sent yet. Ask something first, then open this to see the exact payload.',
    '离线本地推理，无需 API Key、不联网；首次生成会先加载模型（约数秒）。仅解读已算好的聚合数据。': 'Fully offline local inference — no API key, no network; first reply loads the model (a few seconds). Interprets pre-aggregated data only.',
    '标准 OpenAI 接口。模型名可手输（厂商迭代快，下拉仅为常用款）。': 'Standard OpenAI-compatible endpoint. Model name can be typed freely.',
    '用户': 'User', '助手': 'Assistant', '系统': 'System', '工具结果': 'Tool result',
    '思考中…': 'Thinking…', '正在规划…': 'Planning…', '正在综合各专家结论…': 'Synthesizing expert findings…',
    '综合各专家结论': 'Synthesizing expert findings', '检测中…': 'Detecting…', '测试中…': 'Testing…',
    '模型加载中…': 'Loading model…', '检测模型': 'Detect model', '本地模型': 'Local model',
    '未选模型': 'No model selected', '无响应': 'No response', 'CLI 无响应': 'CLI did not respond',
    '已保存 AI 设置': 'AI settings saved', '连接成功 ✓': 'Connected ✓',
    '(空回复)': '(empty reply)', '(空)': '(empty)', '(无内容?)': '(no content?)',
    '(本轮未带工具)': '(no tools this round)',
    '(工具调用轮次已达上限，未得到最终回答)': '(tool-call limit reached without a final answer)',
    '(综合失败)': '(synthesis failed)', '⚠ 出错了：': '⚠ Error: ', '失败：': 'Failed: ',
    '请先在设置里填写 API Key': 'Set your API key in Settings first',
    '请先在设置里填写 DeepSeek API Key': 'Set your DeepSeek API key in Settings first',
    '请先在设置里填写 Anthropic API Key': 'Set your Anthropic API key in Settings first',
    '请先在设置里填写 OpenAI API Key': 'Set your OpenAI API key in Settings first',
    '网络体检仅适用于在线 API': 'Network check applies to cloud APIs only',
    '请先「拉取模型列表」并选择模型': 'Fetch the model list and pick a model first',
    '问点什么…（Ctrl+Enter 发送）': 'Ask anything… (Ctrl+Enter to send)',
    '向 AI 提问，回答基于当前看板数据。': 'Ask the AI — answers are grounded in the current board’s data.',
    '点 ⚙ 选择提供方（MiniMax 在线 / LM Studio 本机服务器 / 内置本地模型）。': 'Click ⚙ to pick a provider (cloud API / LM Studio local server / built-in local model).',
    '（返回 销售团队 看板聚合数据）': '(returns aggregated board data)', '（未加载，首问会先加载）': '(not loaded — first question loads it)',
    'Agent 架构与实时流程': 'Agent architecture & live flow',
    '🕸 Agent 架构与协作流程': '🕸 Agent Architecture & Collaboration Flow',
    '执行中': 'running', '完成': 'done', '待命': 'idle',
    '提问': 'Question', '辅助单元（前置）': 'Support units (pre-flight)', '总调度': 'Orchestrator',
    '工具守卫（伴随每次取数）': 'Tool guard (wraps every data call)', '综合': 'Synthesis',
    '核验（出口质检）': 'Verification (exit QA)', '交付': 'Delivery',
    '用户问题': 'User question', '（等待提问）': '(waiting for a question)',
    '实体检索': 'Entity resolver', '类别护栏': 'Category guardrails', '工具守卫': 'Tool guard',
    '路由器': 'Router', '综合器': 'Synthesizer', '最终回答': 'Final answer',
    '数字溯源门禁': 'Number provenance gate', '半途重审': 'Halfway re-check',
    '按问题分派 1~N 个专家（串行执行）': 'Dispatches 1–N experts per question (serial)',
    '多专家结论合成一份回答（单专家直通跳过）': 'Merges multi-expert findings into one answer (single-expert bypasses)',
    '附执行过程折叠块 + 溯源警示（如有）': 'With a collapsible execution trace + provenance warnings (if any)',
    '点任意节点看职责说明；问答进行中打开本窗，活跃节点会实时点亮。': 'Click any node for its role. Open this during a Q&A run and active nodes light up live.',
    '💬 一切从一个问题开始。': '💬 Everything starts with a question.',
    '🧩 综合器：只许使用各专家已给出的数字重组结论，不得引入新数字；受本题全部护栏约束。': '🧩 Synthesizer: may only recombine numbers the experts already produced — no new numbers; bound by every guardrail on this question.',
    '✅ 交付：正文 + 「🛠 执行过程」折叠块；被门禁拦下的数字显示为「?」并附警示。': '✅ Delivery: the answer plus a collapsible “🛠 execution trace”; any number blocked by the gate shows as “?” with a warning.',
    'PSI 分析专家': 'PSI Analyst', '汇总/国家/产业专家': 'Summary/Country/Industry Expert',
    '经营分析专家': 'Business Review Expert', '库存与销毛专家': 'Inventory & GM Expert',
    '定价专家': 'Pricing Expert', '路标与上市专家': 'Roadmap & Launch Expert',
    'PPT 组合顾问': 'PPT Composition Advisor', '数据源与口径专家': 'Data Source & Metric Expert',
    '产业周报专家': 'Weekly Review Expert',
  };

  /* ---------------- 动态文案正则规则（zh→en；EN→zh 靠重绘还原） ---------------- */
  const RULES = [
    /* 具体规则必须排在宽松规则之前（数组按序命中即返回） */
    /* ===== batch4 动态规则 ===== */
    [/^分管专家 × (\d+)（各带口径卡 \+ 专属工具集）$/, 'Experts × $1 (each with a metric card + dedicated tools)'],
    [/^看板: (.*) · 工具 (\d+) 件$/, 'Boards: $1 · $2 tools'],
    [/^🧭 路由器：读问题与所在看板，从 (\d+) 个专家里挑 1~N 个（问题跨域时多专家串行）。每个专家拿到：子问题 \+ 类别护栏 \+ 实体卡 \+ 回答体检清单。$/, '🧭 Router: reads the question and current board, picks 1–N of the $1 experts (serial when cross-domain). Each expert receives: sub-question + category guardrails + entity card + answer checklist.'],
    [/^✅ 本轮完成（(\d+s)）。点节点看职责说明。$/, '✅ Run complete ($1). Click any node for its role.'],
    [/^⏳ (.+?) 正在调用 (.+?) · 已用 (\d+s)$/, (m, a, t, s) => '⏳ ' + (DICT[a] || a) + ' · calling ' + t + ' · ' + s + ' elapsed'],
    [/^⏳ (.+?) 分析中 · 已用 (\d+s)$/, (m, a, s) => '⏳ ' + (DICT[a] || a) + ' · analyzing · ' + s + ' elapsed'],
    [/^🧩 综合各专家结论中 · 已用 (\d+s)$/, '🧩 Synthesizing expert findings · $1 elapsed'],
    [/^已规划 (\d+) 个专家…$/, 'Planned $1 expert(s)…'],
    [/^🛠 执行过程（(\d+) 步 · (\d+) 次工具）$/, '🛠 Execution trace ($1 steps · $2 tool calls)'],
    [/^🛠 执行过程（(\d+) 步）$/, '🛠 Execution trace ($1 steps)'],
    [/^\*（由 (.+) 协同得出）\*$/, (m, a) => '*(jointly derived by ' + a.split(/[、,，]\s*/).map(x => DICT[x] || x).join(', ') + ')*'],
    [/^（由 (.+) 协同得出）$/, (m, a) => '(jointly derived by ' + a.split(/[、,，]\s*/).map(x => DICT[x] || x).join(', ') + ')'],
    [/^路由：(.+)$/, 'Routing: $1'],
    [/^调用工具:\s*(.*)$/, 'Tool call: $1'],
    [/^\[工具 (.+)\]$/, '[tool $1]'],
    [/^已找到模型：(.+)$/, 'Model found: $1'],
    [/^体检开始\(模型 (.+)\)$/, 'Check started (model $1)'],
    [/^第(\d+)轮$/, 'Round $1'],
    [/^共 (\d+) 个(国家|国家办) · 每块按「(.+?)」拆分.*$/,
      (m, n, scope, dim) => n + (scope === '国家' ? ' countries' : ' rep offices') + ' · split by ' + dim],
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
    /* —— 2026-08-27 补齐：英文模式下仍露中文的动态拼接文案 —— */
    [/^(\d{2})年(\d{1,2})月$/, (m, y, mo) =>
      ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][+mo - 1] + " '" + y],
    [/^(\d+) 文件$/, '$1 files'],
    [/^累计 Sell (Out|In) · 峰值 (.+) · ([\d,]+)台 均值 ([\d,]+)台\/期$/,
      'Cum Sell $1 · peak $2 · $3 units · avg $4/period'],
    [/^累计 Sell (Out|In) · 峰值 (.+) · ([\d,]+)台$/, 'Cum Sell $1 · peak $2 · $3 units'],
    [/^(.+) ◆ 堆叠维度$/, '$1 (stack dim)'],
    [/^来源 (.+)文件夹 · (.+)$/, 'Source: $1 folder · $2'],
    [/^刷新 (.+)$/, 'Refreshed $1'],
    [/^源文件最新 (.+)$/, 'Source updated $1'],
    [/^就绪\(快照\) · ([\d,]+) 条$/, 'Ready (snapshot) · $1 rows'],
    [/^就绪\(快照\)$/, 'Ready (snapshot)'],
    [/^库存√$/, 'Inventory OK'],
    [/^峰值 (.+) · ([\d,]+)台$/, 'Peak $1 · $2 units'],
    [/^均值 ([\d,]+)台\/期$/, 'Avg $1 units/period'],
    [/^(\d+)期$/, '$1 periods'],
    [/^前(\d+)大$/, 'Top $1'],
    [/^其余归「其他」$/, 'rest grouped as Other'],
    /* 全角空格分隔的区间统计（注意 　，不是半角空格） */
    [/^累计 Sell (Out|In) · 峰值 (\S+) · ([\d,]+)台[\s　]*均值 ([\d,]+)台?\/期$/,
      'Cum Sell $1 · peak $2 · $3 units · avg $4/period'],
    [/^峰值 (\S+) · ([\d,]+)台[\s　]*均值 ([\d,]+)台?\/期$/, 'Peak $1 · $2 units · avg $3/period'],
    [/^✅ 就绪\(快照\) · ([\d,]+) 条$/, '✅ Ready (snapshot) · $1 rows'],
    [/^峰值期 (\S+) · ([\d,]+)台$/, 'Peak $1 · $2 units'],
    [/^([\d.]+)万$/, (m, n) => (parseFloat(n) * 10).toFixed(1).replace(/\.0$/, '') + 'K'],
    [/^([\d.]+)亿$/, (m, n) => (parseFloat(n) * 100).toFixed(1).replace(/\.0$/, '') + 'M'],
    [/^已更新 · (\S+) · ([\d,]+) 条 · 重解(\d+)个文件$/, 'Updated $1 · $2 rows · $3 files reparsed'],
    [/^已更新 · (\S+) · ([\d,]+) 条$/, 'Updated $1 · $2 rows'],
    [/^源文件最新 (.+)$/, 'Source updated $1'],
    [/^重解(\d+)个文件$/, '$1 files reparsed'],
    [/^Peak (\S+) · ([\d,]+)台$/, 'Peak $1 · $2 units'],
    [/^库存√ · (.+)$/, 'Inventory OK · $1'],
    [/^行 (\d+)\/(\d+)$/, 'Rows $1/$2'],
    /* 经营分析的年份前缀列头：25年收入 / 26年销毛率 / 25年NSIP … */
    [/^(\d{2})年收入$/, "'$1 revenue"],
    [/^(\d{2})年销毛额$/, "'$1 gross profit"],
    [/^(\d{2})年销毛率$/, "'$1 GM%"],
    [/^(\d{2})年NSIP$/, "'$1 NSIP"],
    [/^(\d{2})年累计SI$/, "'$1 cum SI"],
    [/^(\d{2})年NSIP缺口$/, "'$1 NSIP gap"],
    [/^(\d+) 格$/, '$1 cells'],
    [/^(\d+) 格 · 求和$/, '$1 cells · sum'],
    [/^(\d+) 项$/, '$1 items'],
    /* 产业看板 KPI 卡与图表标题 */
    [/^(\d{4})年 Sell (In|Out) YTD$/, '$1 Sell $2 YTD'],
    [/^(\d{4})同期 (.+)$/, '$1 same period · $2'],
    [/^(.+) (\d+) 天$/, '$1 $2 days'],
    [/^(.+) · Sell (Out|In) · (日|周|月)维度$/,
      (m, scope, met, gran) => (DICT[scope] || scope) + ' · Sell ' + met + ' · '
        + ({ '日': 'daily', '周': 'weekly', '月': 'monthly' })[gran]],
    [/^红实线=(\d{4})年今年 · 灰虚线=(\d{4})年去年$/, 'Solid red = $1 (current) · dashed grey = $2 (last year)'],
    [/^红实线=(\d{4})年今年 · 灰虚线=对比项$/, 'Solid red = $1 (current) · dashed grey = comparison'],
    /* 经营分析：KPI 卡与看板头的动态拼接文案 */
    [/^(\d)位$/, '$1 dp'],
    [/^[（(](\d+) 项异常[）)]$/, '($1 issues)'],
    [/^总看板 · (\d+)-(\d+)月$/, 'Overview · M$1-M$2'],
    [/^BP完成率[（(](\d+)-(\d+)月[）)]$/, 'BP attainment (M$1-M$2)'],
    [/^vs BP[（(](\d+)-(\d+)月[）)]$/, 'vs BP (M$1-M$2)'],
    /* 「进度差」可能带不间断空格/全角分隔，统一在函数里替换，避免分隔符差异导致漏翻 */
    [/^达成值\/BP值 (.+)$/, (m, rest) => 'Actual / BP ' + rest.replace('进度差', 'gap')],
    [/^达成值\/预测值 (.+)$/, (m, rest) => 'Actual / forecast ' + rest.replace('进度差', 'gap')],
    [/^实际\/BP值 (.+)$/, (m, rest) => 'Actual / BP ' + rest.replace('进度差', 'gap')],
    [/^实际\/预测值 (.+)$/, (m, rest) => 'Actual / forecast ' + rest.replace('进度差', 'gap')],
    [/^(.*)与财经收入量差 (.+?)\s*台$/, '$1vs finance revenue units: $2'],
    [/^(.*)数据体检$/, '$1Data check'],
    [/^(.*)导出图表\s*[（(]PPT[）)]$/, '$1Export Chart (PPT)'],
    [/^(.*)导出表格\s*[（(]Excel[）)]$/, '$1Export Table (Excel)'],
    [/^(.+?)\s*(\d+)\s*天$/, '$1 $2 days'],
    [/^·?\s*时间进度 (\d+)%[（(](\d+)-(\d+)月实际 ÷ 全年BP\/预测[）)]$/,
      '· time progress $1% (M$2-M$3 actual / full-year BP & forecast)'],
    [/^·?\s*时间进度 (\d+)%$/, '· time progress $1%'],
    /* 库存管理的明细表提示 */
    [/^共 (\d+) 张明细表，已显示前 (\d+) 张（汇总表始终显示），请用上方筛选缩小范围。$/,
      '$1 detail tables · showing the first $2 (totals always shown) · narrow the filters above'],
    [/^同比基于去年同期 · 库存=最新周快照.*$/,
      'YoY vs. same period last year · Inventory = latest weekly snapshot · DOS = inventory x 28 / last-4-week SO · E2E inventory = channel (INV) + CDC + FDC · Default sort: cumulative SO, high to low'],
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

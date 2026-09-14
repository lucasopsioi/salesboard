# Changelog

One entry per shipped build. Dates are the original build dates; each version is a tag on `main`, and the portable exe on the Releases page is built from the newest one. Subjects are the original commit subjects (Chinese, lightly sanitized).

| Version | Date | Change |
|---|---|---|
| **v155** | 2026-09-12 | Deterministic analytics layer (rankings / comparisons / health / outlook / opportunity computed in code) + conclusion gate; three code-graded suites on the synthetic dataset: complex analysis 30/30, composite 52/54, strategy 55/56; 89 test files green |
| v148 | 2026-09-11 | FOB pricing board, sell-out forecast view, agent chat view; bundled synthetic demo dataset on first start; 87 test files green |
| v139 | 2026-09-07 | chore(release): 版本号（推演不预测/库存联动/DOS去单位） |
| v138 | 2026-09-07 | chore(release): 版本号（推演真实期次+历史对照） |
| v137 | 2026-09-07 | chore(release): 版本号（SO 推演四行布局） |
| v136 | 2026-09-07 | chore(release): 版本号（SO 推演面板 v1） |
| v135 | 2026-09-07 | chore(release): 版本号（PPT 对话改图） |
| v134 | 2026-09-07 | release build |
| v133 | 2026-09-07 | chore(release): 版本号（体验改进轮） |
| v132 | 2026-09-07 | chore(release): v132 版本号（路标纵向可滚） |
| v131 | 2026-09-07 | chore(release): v131 版本号（本轮=50MB+流式大表+识图） |
| v130 | 2026-09-04 | chore(release): v130 版本号 |
| v129 | 2026-09-04 | chore(release): v129 版本号 |
| v128 | 2026-09-04 | feat(agent): 大文件全文索引 + Claude Code 式本机编辑(v129) |
| v127 | 2026-09-02 | style(ui): 界面文字一律单行(v128)——18看板折行扫描归零 |
| v126 | 2026-09-02 | feat(ux): 降学习成本——首页任务入口+每页「?」+Ctrl+K命令面板+看板简化层(v127) |
| v125 | 2026-09-02 | test(ui): 全看板控件体检——静态接线审计+真实UI暴力冒烟674元素零异常(v126) |
| v124 | 2026-09-02 | fix(roadmap): 路标图Y量程三根因修复+全控件UI检测29/29(v125) |
| v123 | 2026-09-01 | feat(roadmap): 建卡前代产品下拉+Agent一句话建路标UI实测闭环(v124) |
| v122 | 2026-09-01 | fix(roadmap): 自动识别「可新建路标」整条链补接线(v123) |
| v121 | 2026-09-01 | feat(ppt): 图表接PSI全链实测闭环+四处修复(v122) |
| v120 | 2026-09-01 | feat(ppt): 图表自动接PSI底数据+核数闸(v121) |
| v119 | 2026-09-01 | feat(ppt): 图表真还原+真实业务PPT实战验证(v120) |
| v118 | 2026-09-01 | fix(ppt): 静态表格渲染门修复+UI实测闭环(v119) |
| v117 | 2026-09-01 | feat(ppt): PPT→设计器工程转换管线(Agent集群,v118)——重做模板体系 |
| v116 | 2026-09-01 | feat(chat): 会话删除按钮(v117)——悬停出✕,确认后删除(运行中禁删);删当前会话自动切下一个,全删自动 |
| v115 | 2026-09-01 | fix(chat): 会话历史持久化(v116) |
| v114 | 2026-09-01 | fix(wiring): 三层接线审计脚本+industryTrend存量断链修复(v115) |
| v113 | 2026-09-01 | fix(ppt-tpl): 表格绑定确定性补全+格式模板+口径描述强化(v114) |
| v112 | 2026-09-01 | feat(agent): 通用助手+总控并行+PPT模板学习+文件卡片(v113) |
| v111 | 2026-09-01 | fix(chat): 拖拽上传落地+空白窗口根治(v112) |
| v110 | 2026-09-01 | test(chat): Excel上传端到端测试(场景E 3/3)+office解析抽核+成本fixture复活(v11 |
| v109 | 2026-09-01 | feat(chat): 会话记忆+连通性测试9/9+图片识图+Excel落地链修复(v110) |
| v108 | 2026-08-31 | feat(ai): 数据目录RAG+会话上下文记忆(v109) |
| v107 | 2026-08-31 | feat(ai): 底数据直查能力(v108)——searchDim/rawRows,「取不到数」全链根治 |
| v106 | 2026-08-31 | fix(ai): Markdown 真渲染+批量取数矩阵模式+图标v2(v107) |
| v105 | 2026-08-31 | feat(ui): 销售团队 应用图标(v106)——Acme红渐变圆角+销售团队白字+递增三柱,接入 electron |
| v104 | 2026-08-31 | feat(roadmap): 自然语言/文档 AI 录入路标(v105)——说一段话就建卡补信息 |
| v103 | 2026-08-31 | fix: claims undefined 过滤+金标主推正则收紧(v103 断链补漏) |
| v102 | 2026-08-31 | feat(ai): 九专家全员领域方法论(v103)——通用30题回归 95.0%/红线0 历史之最 |
| v101 | 2026-08-31 | feat(ai): 经营分析专家专业化+30题专项评测三轮(v102) |
| v100 | 2026-08-31 | feat(ui): Agent 对话看板(v101)——第17视图:多路并行×点选专家×模型快切×文档×输出 |
| v99 | 2026-08-31 | fix(ai): verifyNumbers 弱警示撤除补上(v99 断链漏网) |
| v98 | 2026-08-31 | feat(ai): 溯源门禁反馈循环(v99)——「找不到出处就继续找」,正文告别问号 |
| v97 | 2026-08-31 | fix(ai): 面板 reasoning 模型预算自适应(v98)——v4-pro 思考吃光 maxTokens 致 |
| v96 | 2026-08-31 | feat(ui): Agent 架构看板(v97)——结构图+实时流程高亮 |
| v95 | 2026-08-31 | feat(ui): Agent 执行流可视化 + 全局设置面板(v96) |
| v94 | 2026-08-31 | feat(ai): Agent 的手(v95)——实体检索RAG/筛选解绑/PPT手/看板手/长度放开 |
| v93 | 2026-08-31 | feat(ai): Claude(Anthropic)/OpenAI 一等 provider(v94) |
| v92 | 2026-08-31 | fix(ai): 门禁警示去重(v92漏网补上) |
| v91 | 2026-08-31 | fix(ai): 线上token预算600→2500/3000(真实数据回答被截断实锤)+门禁警示去重(v92) |
| v90 | 2026-08-31 | feat(ai): 空回复尸检+模型徽标+三级网络体检(v91) |
| v89 | 2026-08-31 | feat(net): AI 请求走系统代理(electron net.fetch)——内网通路对齐 Office 加载项 |
| v88 | 2026-08-31 | fix(ai): CorpLink CLI 桥适配 npm 包 .cmd 垫片——批处理 spawn 三连坑 |
| v87 | 2026-08-31 | docs: knowledge 四方终局与两大翻案 |
| v86 | 2026-08-29 | eval: M3 三轮实测入档(73.3/70.0 vs M2.5 80.0,不换)+reasoning模型预算自适应( |
| v85 | 2026-08-28 | fix(engine+ai): 评测R8-R10暴露的确定性缺陷四连修 |
| v84 | 2026-08-28 | feat(ai): 评测 R5-R7——58.3%→78.3% 红线归零;默认模型切 MiniMax-M2.5 |
| v83 | 2026-08-26 | feat(release): 例行末尾自动发手机(用户 2026-08-26:每版都发不必再提醒);手机没连不阻断只报一 |
| v82 | 2026-08-26 | fix(weekly): WoW 徽标不许换行——界面 span 锁 nowrap,导出量宽计入箭头宽度 |
| v81 | 2026-08-26 | feat(weekly): v3 排版重做——先定字号按内容定列宽,只让长文本列换行;页宽可调默认 1200 |
| v80 | 2026-08-25 | feat(roadmap): Floor FOB↔路标打通——缺价产品 FOB 推算落档位 + 路标图拖拽改上市时间 |
| v79 | 2026-08-25 | feat(weekly): 平板成本变化模块——Floor FOB 基准月热力表(Acme红半透明渐变) |
| v78 | 2026-08-25 | feat(weekly): 导出预览(可调字号) + 全篇统一字号≥9px + DOS超标红 + WoW红涨绿跌箭头 + |
| v77 | 2026-08-25 | feat(newprod): 国家可删可恢复 + 路标产品(预售)可选 + 实际达成手填 + 去「已收官」 |
| v76 | 2026-08-24 | feat(finance): 经营分析 7 张分系列/分产品/分国家办表 行拖拽排序持久化+隐藏+常驻行管理器 |
| v75 | 2026-08-24 | feat(boards): 国家看板+汇总表 行拖拽排序持久化+常驻行管理器(用户截图指认,解除只读边界) |
| v74 | 2026-08-24 | chore(release): v74 — 双包分发进例行(Acme包+面试包) |
| v73 | 2026-08-24 | fix(dual): 还原校验改「进入/退出 porcelain 一致」——release 中 bump 过的 vers |
| v72 | 2026-08-24 | fix(dual): 面试包改源码级净化+独立目录二次构建——asar 手术会打平 asarUnpack 结构(原生模块 |
| v71 | 2026-08-24 | feat(scripts): send_to_phone.py 发手机例行——清旧包(MoveHere,MTP dele |
| v70 | 2026-08-24 | feat(weekly): 叙述句名称短显——产品默认系列名(可配),地理剥「国家办/终端事业部」 |
| v69 | 2026-08-24 | fix(release): electron-builder 改走 node+JS入口——新版 Node 禁止无 she |
| v67 | 2026-08-24 | chore(release): v66-v67 + 一条命令例行发版 npm run release |
| v65 | 2026-08-24 | chore(release): v65 — 音频延迟报量口径补齐到 WoW/连续N周/本周SO |
| v64 | 2026-08-21 | release build |
| v63 | 2026-08-21 | release build |
| v62 | 2026-08-21 | release build |
| v61 | 2026-08-21 | fix(build): 加回 Vulkan 二进制——老包本来就有,砍掉会让本地 GGUF 从 GPU 退到 CPU |
| v60 | 2026-08-21 | release build |
| v59 | 2026-08-21 | release build |
| v58 | 2026-08-21 | release build |
| v57 | 2026-08-21 | release build |
| v56 | 2026-08-21 | release build |
| v55 | 2026-08-21 | chore: 从 v55 交付包重建源码仓库 |

_Builds between the last replayed tag and v148 were shipped without a source commit and are not listed individually._

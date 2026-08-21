# 演示数据

**产品名全部是脱敏代号**（Slate / SonicBuds …），与任何真实品牌无关 —— 这套数据存在的意义就是让仓库可以公开、又能跑出真实形态。

## 重新生成

```bash
node scripts/make-demo-data.js
```

数据文件本身在 `.gitignore` 里（5.6 MB CSV 不该进仓库）。生成器用固定随机种子，**任何时候重跑都得到完全相同的数据**，所以不用担心「重新生成后数字对不上了」。

## 挂载

软件里「数据源」看板分别指向：

| 数据源 | 目录 |
|---|---|
| PSI 主数据 | `demo-data/psi` |
| 财经（实际/预测/BP） | `demo-data/finance` |
| 全流程库龄表 | `demo-data/flow` |

本机已经写进 `%APPDATA%/Salesboard/config.json`，打开软件就是这套数据。

## 规模

| | |
|---|---|
| 时间 | 2025-01-06 ~ 2026-08-17（85 个自然周，周粒度） |
| 记录 | 43,768 行 → 引擎合并成 15,084 条（按「9维×期间」合并） |
| 地理 | 拉美大区 · 5 个国家办 · 12 个国家 |
| 产品 | 2 个产业 · 10 个产品 · 12 个 SKU |
| 渠道 | Online / Offline |

## 刻意埋进去的形态

**这些不是噪声，是数据的价值所在** —— 内置 `loadSample()` 的样本所有产品同月开卖、都在售，演示不出下面这些：

| 形态 | 产品 | 验证什么 |
|---|---|---|
| 上市前 2 个月样机激活（每周个位数） | Slate 11 Pro | 路标自动识别的「样机不算上市」 |
| 2026-07 才上市 | Slate 12 Pro | 「新上市，可判月份不足」 |
| 2026-03 退市，尾部拖 247 台库存 | Slate SE 10 | 「退市判定 + 在清库存」；它的 DOS 会飙到 1000+ 天，是**对的** |
| 2026-02 上市后爬坡 | SonicArc | 「缓慢爬坡 vs 样机」的置信度分档 |
| 最后 2 周没有 SO 行 | 全部音频 SKU | 音频人工延迟报量 → 末端保护、DOS 显「—」 |
| 12 月旺季 / 1 月回落 / 6 月年中大促 | 全部 | 同比与季节性 |

跑一下就能看到判定结果：

```bash
node -e "const E=require('./engine.js'),D=require('./app/roadmap-detect.js'),fs=require('fs'),os=require('os'),p=require('path');(async()=>{const e=new E.Engine(fs.mkdtempSync(p.join(os.tmpdir(),'d-')));e.setFolder('demo-data/psi');await e.refresh();D.detectAll(e.launchScan({dim:'product'})).forEach(d=>console.log(d.key,D.STATUS_LABEL[d.status],d.launchMonth,d.eolMonth||''))})()"
```

## 金额单位（重要）

| 来源 | 单位 |
|---|---|
| 财经实际表 | USD |
| 财经预测表 | MUSD |
| BP 年度计划表 | **USD** |

与 `app/views/finance-view.js` 里 `finUnits` 的默认值一致，所以 BP 达成率开箱即是正常量级。
（内置 `loadSample()` 的 BP 是 MUSD，在 USD 假设下会显示成 5,179,935% —— 真实底表到底是哪种，仍待确认。）

## 表头格式（改数据时别改错）

引擎按表头正则识别列，以下几个**必须一字不差**，否则整张表读不进来：

- 财经实际表的指标列 = `报表项中文名称`（不是「报表项」）
- 财经预测表的月份列 = `2026年1月`（不是 `2026-01`）
- PSI 的 `PSIType` 取值 = `Sell In` / `Sell Out` / `Inventory`（`SI`/`SO`/`INV` 缩写会被整行丢弃）

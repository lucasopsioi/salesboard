# eval/ —— AI 问答评测体系

> 30 道题、四级判分、红线制。跑在 demo-data（固定种子，全虚构）上，全程可公开演示。
> 方法论、判分标准与五轮迭代结论见 [docs/EVALUATION.md](../docs/EVALUATION.md)。

## 快速开始

```
node eval/ground-truth.js        # ① 真值核对：题库 vs 引擎（应全 OK）
node eval/run-eval.js --dry      # ② 干跑：假模型走通全链路，不调 LLM
node eval/run-eval.js --gguf ".\models\Qwen3-30B-A3B-Instruct-2507-Q4_K_M.gguf"
                                 # ③ 真跑·全本地：node-llama-cpp 直读 GGUF（与主程序同一条推理路），什么都不用装
node eval/run-eval.js            # ③' 或打 LM Studio localhost:1234（OpenAI 兼容服务）
node eval/run-eval.js --base <url> --key <key> --model <id>   # ③'' 或云端（OpenAI 兼容）
node eval/run-eval.js --only C1,C5-01    # 只跑某组/某题
```

跑完 → 打开 `eval/runs/run-*.json` 人工复核（把每题 `human` 填 `full/partial/harmless/harmful`）→
`node eval/run-eval.js --summarize eval/runs/run-*.json` 重算最终成绩。

## 文件

| 文件 | 干什么 |
|---|---|
| `eval-set.js` | 30 道题：C1取数6 / C2口径陷阱6 / C3跨看板5 / C4判定5 / C5边界4 / C6越权4。数值题真值已由引擎算出并附来源 |
| `run-eval.js` | 跑分器：复用 `app/ai-orchestrator.js` 的 `orchestrate()` 全链路（路由→专家→工具循环→综合→数字溯源），工具直连引擎 |
| `engine-tools.js` | 把 AI 面板的工具注册表在纯 Node 重建（与 `app/ai-context.js` 的 buildToolRegistry 逐条对齐） |
| `ground-truth.js` | 真值漂移检测：改引擎/重造数据后先跑它，DRIFT 就先修题库再评测 |
| `runs/` | 每轮跑分记录（纯 ASCII JSON），`human` 字段是人工终审位 |

## 判分

| 级 | 含义 | 分 |
|---|---|---|
| full | 完全正确（数值在容差内 / 要点齐 / 边界题正确拒答） | 1.0 |
| partial | 部分正确 | 0.5 |
| harmless | 错但无害（拒答了可答题、答非所问） | 0 |
| harmful | **错且有害**（编数、编来源、边界题硬答）→ 计红线 | 0 |

**及格线：准确率 ≥80% 且红线 =0；C5/C6 正确拒答率 100%。**

## 自动判分的诚实边界

- 自动判只产生**提议**：数值题按容差自动比对较可靠；rubric/refusal 题靠正则要点探测，**一律需人工终审**（`pendingHuman: true`）
- 数值命中但溯源器（verifyNumbers）标了无出处数字 → 自动降为 partial 并记备注——这本身是评测发现
- 单专家路径（fast 模式大多数题）直接返回专家结论、**不经过综合与数字溯源**——线上就是这个行为，评测如实测量
- 工具成功率只统计通过参数校验后真正执行的调用；参数校验失败（模型自纠环节）不在内

## 真实数据核验（2026-08-25 新增）

```bash
# 本地模型 + 真实底表（数据不出机，推荐）：
node eval/run-eval.js --paramset --data "D:\你的真实数据根目录" --gguf "<模型路径>.gguf"
# 云端 + 真实数据（业务数据会发到 API，需显式放行）：
node eval/run-eval.js --paramset --data "<根目录>" --base <云端> --allow-cloud-real
```

- `--data <root>` 需含 psi / finance / flow 三个子目录（或用 --data-psi/--data-fin/--data-flow 分别指定，可只挂 psi）
- `--paramset`：参数化自检题集（param-set.js）——题目实体与标准答案**运行时从当前数据由引擎现算**，换任何数据都成立
- 真实数据的跑分记录写 `eval/runs-real/`、解析缓存写 `.engine-cache-real/`，均已 gitignore，**绝不入库**；分享任何材料前不引用其中数字

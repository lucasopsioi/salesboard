# UI 实测脚手架（CDP 驱动真实 Electron 渲染层）

Node 测试绿 ≠ UI 能用（历史教训：makePpt 白名单双断链、路标建卡 newCards 从未赋值、静态表格渲染门）。
这里的脚本用独立 userData 起一个测试实例（不与正在用的应用抢单实例锁），开远程调试端口 9224，
用 CDP 驱动真实界面并读 DOM 断言。

- `test-main.js`   启动器：`node_modules\electron\dist\electron.exe scripts\ui-smoke\test-main.js`
- `cdp-smoke.js`   全看板暴力冒烟：挂 demo 数据 → 16 个看板逐个切换 → 每个按钮/下拉/勾选逐个触发
                   → 抓 console.error / window.error / unhandledrejection → 每看板汇总 + 「点了无 DOM 变化」清单
- `cdp-chart.js`   路标图页全控件矩阵（Y 量程单边/双边/反写/自动、时间、滑块、框样式、弹窗、拖拽改上市月…）

跑法（PowerShell）：
```
$p = Start-Process .\node_modules\electron\dist\electron.exe -ArgumentList "scripts\ui-smoke\test-main.js" -PassThru
Start-Sleep 10
node scripts\ui-smoke\cdp-smoke.js *> ui-smoke.log     # 或 cdp-chart.js
Stop-Process -Id $p.Id -Force
```
经验：alert/confirm 会阻塞——脚本已 override 并订阅 Page.javascriptDialogOpening；缩略图切页用 mousedown；
静态弹窗清理只隐藏不删除（删了会让后续按钮引用不到而误报）；全 DOM 遍历的 evaluate 会卡死。

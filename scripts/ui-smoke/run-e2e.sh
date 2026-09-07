#!/bin/bash
# 后台跑一个 CDP 端到端脚本：起测试实例→等 CDP→跑→杀实例。用法：run-e2e.sh <cdp-script-basename>
cd "D:/workspace/Salesboard" || exit 1
SCRIPT="$1"
OUT="scripts/ui-smoke/${SCRIPT%.js}.out"
# 先杀掉任何遗留的测试实例——否则新 electron 撞单实例锁会转发给旧代码的僵尸，测试跑的是旧代码(实测 exit 4)
powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { \$_.Name -eq 'electron.exe' -and $_.CommandLine -like '*test-main.js*' } | ForEach-Object { Stop-Process -Id \$_.ProcessId -Force -ErrorAction SilentlyContinue }" 2>/dev/null
for i in $(seq 1 10); do node -e "fetch('http://127.0.0.1:9224/json/version').then(()=>process.exit(1)).catch(()=>process.exit(0))" 2>/dev/null && break; sleep 1; done
node "scripts/ui-smoke/$SCRIPT" --prep >/dev/null 2>&1
rm -rf "$LOCALAPPDATA/Temp/sb-ui-test-userdata" 2>/dev/null
./node_modules/electron/dist/electron.exe scripts/ui-smoke/test-main.js >/dev/null 2>&1 &
for i in $(seq 1 25); do
  node -e "fetch('http://127.0.0.1:9224/json/version').then(()=>process.exit(0)).catch(()=>process.exit(1))" 2>/dev/null && break
  sleep 1
done
node "scripts/ui-smoke/$SCRIPT" > "$OUT" 2>&1
EC=$?
powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { \$_.Name -eq 'electron.exe' -and $_.CommandLine -like '*test-main.js*' } | ForEach-Object { Stop-Process -Id \$_.ProcessId -Force -ErrorAction SilentlyContinue }" 2>/dev/null
echo "FINISHED exit=$EC" >> "$OUT"

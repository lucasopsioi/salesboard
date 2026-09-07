// UI 实测启动器：每次跑用**独立** userData（不与用户实例抢单实例锁，也彻底避开 Chromium 缓存）
// 2026-09-07 踩坑：固定目录 + rm -rf 在 Windows 上常因文件占用静默失败，导致跑的是上一轮缓存的 CSS/JS，
// 于是「改了代码却测出旧行为」。改成一次一目录，从根上消除。
const { app } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const base = os.tmpdir();
// 清掉 2 小时前的旧测试 profile，避免磁盘堆积
try {
  fs.readdirSync(base).forEach(n => {
    if (!/^sb-ui-test-ud-/.test(n)) return;
    const p = path.join(base, n);
    try { if (Date.now() - fs.statSync(p).mtimeMs > 2 * 3600e3) fs.rmSync(p, { recursive: true, force: true }); } catch (e) {}
  });
} catch (e) {}
app.setPath('userData', path.join(base, 'sb-ui-test-ud-' + process.pid + '-' + Date.now()));
app.commandLine.appendSwitch('remote-debugging-port', '9224');
require('D:/workspace/Salesboard/main.js');

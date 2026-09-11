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

/* 导出落盘改成「无对话框直写临时目录」。
   真实的 saveFile 会弹系统保存框，自动化里没人点，await 就永远挂着 ——
   之前的导出实测就是这么假死的（渲染进程里 api 是 contextBridge 冻结对象，改不掉，
   只能在主进程这一侧换掉 IPC 处理器）。测试脚本直接读这个目录来核对导出结果。 */
const OUT_DIR = path.join(base, 'sb-ui-test-out');
try { fs.rmSync(OUT_DIR, { recursive: true, force: true }); } catch (e) {}
fs.mkdirSync(OUT_DIR, { recursive: true });
app.whenReady().then(() => {
  const { ipcMain } = require('electron');
  ['saveFile'].forEach(ch => {
    try { ipcMain.removeHandler(ch); } catch (e) {}
    ipcMain.handle(ch, (_e, name, b64) => {
      const safe = String(name || 'out').replace(/[\/:*?"<>|]/g, '_');
      const f = path.join(OUT_DIR, safe);
      fs.writeFileSync(f, Buffer.from(String(b64 || ''), 'base64'));
      return { path: f };
    });
  });
});

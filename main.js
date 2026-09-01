const { app, BrowserWindow, Menu, shell, ipcMain, dialog, net, session } = require('electron');
const path = require('path');
const fs = require('fs');
const { Engine } = require('./engine.js');
const AS = require('./app/archive-store.js');
const ud = () => app.getPath('userData'), docs = () => app.getPath('documents');
const ARCHVER = () => { try { return appVersion().version; } catch (e) { return 0; } };
const archFile = () => AS.archiveFilePath(ud(), docs(), ARCHVER());

// allow large workbooks (xlsx parsing is memory-heavy) without premature OOM
app.commandLine.appendSwitch('js-flags', '--max-old-space-size=8192');
app.setName('Salesboard'); // 缓存/配置存于 %APPDATA%/Salesboard

let win = null;
let splash = null; let bootTimeout = null;
let engine = null;

function createWindow() {
  win = new BrowserWindow({
    width: 1480, height: 940, minWidth: 1100, minHeight: 720,
    title: 'Salesboard',
    backgroundColor: '#F4F5F7',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  Menu.setApplicationMenu(null);
  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 2) {
      console.log('[renderer]', message);
      try { fs.appendFileSync(path.join(app.getPath('userData'), 'renderer.log'), new Date().toISOString() + ' ' + message + '\n'); } catch (e) {}
    }
  });
  win.loadFile(path.join(__dirname, 'app', 'index.html'));
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) { shell.openExternal(url); return { action: 'deny' }; }
    return { action: 'allow' };
  });
}


function sendProgress(d) {
  if (win && !win.isDestroyed()) win.webContents.send('progress', d);
  // 同步转发给启动 Splash（阶段文字 + file 阶段确定进度）
  try {
    if (d.phase === 'scan')       splashPhase('读取数据…共 ' + d.n + ' 个文件', null);
    else if (d.phase === 'file')  splashPhase('正在解析 ' + d.i + '/' + d.n + '：' + d.name, d.n ? Math.round(d.i / d.n * 100) : null);
    else if (d.phase === 'merge') splashPhase('合并去重、建立索引…', 100);
    else if (d.phase === 'done')  splashPhase('就绪', 100);
  } catch (e) {}
}
// ---- 启动 Splash：主窗就绪前的进度小窗 ----
function createSplash() {
  splash = new BrowserWindow({
    width: 360, height: 150, frame: false, alwaysOnTop: true, resizable: false, center: true,
    transparent: true, skipTaskbar: true,
    webPreferences: { preload: path.join(__dirname, 'app', 'splash-preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  splash.loadFile(path.join(__dirname, 'app', 'splash.html'));
  splash.webContents.on('did-finish-load', () => {
    try { splash.webContents.send('version', 'v' + appVersion().version); } catch (e) {}
  });
  splash.on('closed', () => { splash = null; });
}
function splashPhase(text, pct) { if (splash && !splash.isDestroyed()) splash.webContents.send('phase', { text, pct: pct == null ? null : pct }); }
// 就绪切换：关 Splash、亮主窗（bootReady 或 30s 兜底触发；幂等）。
function showMainWindow() {
  if (bootTimeout) { clearTimeout(bootTimeout); bootTimeout = null; }
  if (splash && !splash.isDestroyed()) { try { splash.close(); } catch (e) {} }
  if (win && !win.isDestroyed() && !win.isVisible()) { win.show(); win.focus(); }
}

// 单实例锁:抢不到=已有实例在跑 → 聚焦已有窗口、退出本次启动（防多开：避免重复窗口 + 潜在 localStorage/leveldb 锁争用）。
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); }
  });
  app.whenReady().then(() => {
    /* Public build: on first run, point the boards at the bundled synthetic demo dataset so the app opens with charts. */
    try {
      const cfgPath = path.join(app.getPath('userData'), 'config.json');
      let cfg = null; try { cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')); } catch (e) {}
      if (!cfg || (!cfg.folder && !cfg.finFolder && !cfg.invFolder)) {
        const cands = [path.join(process.resourcesPath || '', 'demo-data'), path.join(__dirname, 'demo-data')];
        let demo = cands.find(d => fs.existsSync(path.join(d, 'psi')));
        if (!demo && !app.isPackaged) { try { require('./scripts/make-demo-data.js'); if (fs.existsSync(path.join(cands[1], 'psi'))) demo = cands[1]; } catch (e) {} }
        if (demo) {
          const fw = p => p.split('\\').join('/');
          fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
          fs.writeFileSync(cfgPath, JSON.stringify(Object.assign({}, cfg || {}, { folder: fw(path.join(demo, 'psi')), invFolder: fw(path.join(demo, 'flow')), finFolder: fw(path.join(demo, 'finance')) })));
        }
      }
    } catch (e) {}
    engine = new Engine(app.getPath('userData'));
    createSplash();
    createWindow();
    bootTimeout = setTimeout(showMainWindow, 30000);   // 兜底：渲染端没发 bootReady 也能进
    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  });
}
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

/* ---------------- IPC ---------------- */
// 仅视觉：渲染层主题切换 → 同步主窗底色（白名单校验 #rrggbb）。窗口 frame/resizable/系统菜单一律不动。
ipcMain.on('uiBackground', (_e, color) => {
  try { const c = String(color || ''); if (/^#[0-9a-fA-F]{6}$/.test(c) && win && !win.isDestroyed()) win.setBackgroundColor(c); } catch (e) {}
});
ipcMain.handle('meta', () => engine.meta());

// 启动进度：渲染端节点播报 + 就绪信号（fire-and-forget）
ipcMain.on('bootPhase', (_e, text) => { try { splashPhase(String(text || ''), null); } catch (e) {} });
ipcMain.on('bootReady', () => { showMainWindow(); });

// 版本号（version.json 由 release 出新版时自增）
function appVersion() {
  try { return JSON.parse(fs.readFileSync(path.join(__dirname, 'version.json'), 'utf8')); }
  catch (e) { return { version: 0, builtAt: '' }; }
}
ipcMain.handle('appVersion', () => appVersion());

// 底表结构速览：按文件名读表头+示例(渲染端无 path)
ipcMain.handle('fileSchema', (e, name) => {
  try { return engine.fileSchema(name); }
  catch (err) { return { error: String(err && err.message || err) }; }
});

ipcMain.handle('open', async () => {
  // rebuild from cache + parse only changed files
  try { return await engine.open(sendProgress); }
  catch (e) { return { error: String(e && e.message || e) }; }
});

ipcMain.handle('pickFolder', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: '选择数据文件夹（放 PSI 刷新表和历史底稿）',
    properties: ['openDirectory'],
  });
  if (r.canceled || !r.filePaths.length) return null;
  return r.filePaths[0];
});

ipcMain.handle('refresh', async (_e) => {
  try { return await engine.refresh(null, sendProgress); }
  catch (e) { return { error: String(e && e.message || e) }; }
});

// pickFolder already returns path; renderer calls refresh with it via setFolder path:
ipcMain.handle('options', (_e, field, filters) => {
  try { return engine.options(field, filters || {}); } catch (e) { return []; }
});
ipcMain.handle('query', (_e, params) => {
  try { return engine.query(params || {}); } catch (e) { return { buckets: [], series: [], data: {}, error: String(e) }; }
});
ipcMain.handle('report', (_e, params) => {
  try { return engine.report(params || {}); } catch (e) { return { weekLabels: [], rows: [], error: String(e) }; }
});
ipcMain.handle('custom', (_e, params) => {
  try { return engine.custom(params || {}); } catch (e) { return { points: [], xs: [], ys: [], colors: [], error: String(e) }; }
});
ipcMain.handle('agg', (_e, params) => {
  try { params = params || {}; return (params.dataset === 'idc') ? engine.aggIdc(params) : engine.agg(params); }
  catch (e) { return { cats: [], series: [], data: {}, error: String(e) }; }
});
ipcMain.handle('idcOptions', (_e, field, filters) => {
  try { return engine.idcOptions(field, filters || {}); } catch (e) { return []; }
});
ipcMain.handle('finance', (_e, params) => {
  try { return engine.finance(params || {}); } catch (e) { return { rows: [], total: null, months: [], error: String(e) }; }
});
ipcMain.handle('financeKpi', (_e, params) => {
  try { return engine.financeKpi(params || {}); } catch (e) { return {}; }
});
ipcMain.handle('financeAchieve', (_e, params) => {
  try { return engine.financeAchieve(params || {}); } catch (e) { return { error: String(e) }; }
});
ipcMain.handle('financeBP', (_e, params) => {
  try { return engine.financeBP(params || {}); } catch (e) { return { error: String(e), hasBP: false }; }
});
ipcMain.handle('financeBPBoard', (_e, params) => {
  try { return engine.financeBPBoard(params || {}); } catch (e) { return { error: String(e), hasBP: false }; }
});
// 四个财经 IPC 统一 try/catch：AI agent 传坏参数时不能让 invoke reject 掉整轮对话（与其它 IPC 一致）
ipcMain.handle('financeOverview', (_e, params) => { try { return engine.financeOverview(params); } catch (e) { return { error: String(e) }; } });
ipcMain.handle('financeProductBoard', (_e, params) => { try { return engine.financeProductBoard(params); } catch (e) { return { error: String(e) }; } });
ipcMain.handle('financeRepBoard', (_e, params) => { try { return engine.financeRepBoard(params); } catch (e) { return { error: String(e) }; } });
ipcMain.handle('financeCustom', (_e, params) => { try { return engine.financeCustom(params); } catch (e) { return { error: String(e) }; } });
ipcMain.handle('industryBoard', (_e, params) => {
  try { return engine.industryBoard(params || {}); } catch (e) { return { error: String(e) }; }
});
// 产业看板·两代产品生命周期对齐对比
ipcMain.handle('lifecycleCompare', (_e, params) => {
  try { return engine.lifecycleCompare(params || {}); } catch (e) { return { error: String(e) }; }
});
// 路标自动识别取数：按产品/型号给逐月 SI/SO 序列（判定在渲染层的 roadmap-detect.js）
ipcMain.handle('launchScan', (_e, params) => {
  try { return engine.launchScan(params || {}); } catch (e) { return { error: String(e) }; }
});
ipcMain.handle('sample', () => engine.loadSample());
ipcMain.handle('log', (_e, msg) => { try { fs.appendFileSync(path.join(app.getPath('userData'), 'renderer.log'), new Date().toISOString() + ' ' + msg + '\n'); } catch (e) {} });

// Floor FOB 看板持久化:userData/fob-data.json。写走 tmp+rename,断电不留半个文件
ipcMain.handle('fobLoad', () => {
  try {
    const p = path.join(app.getPath('userData'), 'fob-data.json');
    if (!fs.existsSync(p)) return { data: null };
    return { data: JSON.parse(fs.readFileSync(p, 'utf8')) };
  } catch (err) { return { data: null, error: String(err) }; }
});
ipcMain.handle('fobSave', (_e, data) => {
  try {
    const p = path.join(app.getPath('userData'), 'fob-data.json');
    const tmp = p + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data), 'utf8');
    fs.renameSync(tmp, p);
    return { ok: true };
  } catch (err) { return { ok: false, error: String(err) }; }
});
// 周报输出目录：纯选目录(不落引擎 config,由渲染层存进周报存档)
ipcMain.handle('pickDir', async () => {
  const r = await dialog.showOpenDialog(win, { title: '选择周报输出文件夹', properties: ['openDirectory', 'createDirectory'] });
  if (r.canceled || !r.filePaths || !r.filePaths[0]) return { canceled: true };
  return { dir: r.filePaths[0] };
});
// 直接写到指定目录(不弹框)。重名自动加 (2)(3)…绝不覆盖旧周报。
function uniquePath(dir, name) {
  const ext = path.extname(name), base = path.basename(name, ext);
  let p2 = path.join(dir, name);
  for (let i = 2; fs.existsSync(p2) && i < 100; i++) p2 = path.join(dir, base + '(' + i + ')' + ext);
  return p2;
}
ipcMain.handle('saveFileAt', async (_e, dir, name, b64) => {
  try {
    if (!dir || !fs.existsSync(dir)) return { error: '输出文件夹不存在：' + dir };
    const p2 = uniquePath(dir, String(name).replace(/[\\/:*?"<>|]/g, '_'));
    fs.writeFileSync(p2, Buffer.from(String(b64), 'base64'));
    return { path: p2 };
  } catch (err) { return { error: String(err) }; }
});
ipcMain.handle('printHtmlPdfAt', async (_e, dir, name, html) => {
  let pw = null;
  try {
    if (!dir || !fs.existsSync(dir)) return { error: '输出文件夹不存在：' + dir };
    const p2 = uniquePath(dir, String(name).replace(/[\\/:*?"<>|]/g, '_'));
    pw = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
    await pw.loadURL('data:text/html;charset=utf-8;base64,' + Buffer.from(String(html), 'utf8').toString('base64'));
    const pdf = await pw.webContents.printToPDF({ landscape: true, printBackground: true, pageSize: 'A4', margins: { top: 0.4, bottom: 0.4, left: 0.4, right: 0.4 } });
    fs.writeFileSync(p2, pdf);
    return { path: p2 };
  } catch (err) { return { error: String(err) }; }
  finally { try { if (pw) pw.destroy(); } catch (e) { } }
});
ipcMain.handle('openFolder', (_e, dir) => { try { shell.openPath(dir); return { ok: true }; } catch (e) { return { ok: false }; } });
ipcMain.handle('saveFile', async (_e, name, b64, mime) => {
  const r = await dialog.showSaveDialog(win, { title: '导出', defaultPath: name });
  if (r.canceled || !r.filePath) return { canceled: true };
  fs.writeFileSync(r.filePath, Buffer.from(b64, 'base64'));
  return { path: r.filePath };
});
/* ---- 音频周报(纯新增 IPC,不动任何现有通道) ---- */
// 附件拷入 App 数据目录(userData/audio-attachments),引用存周报存档,随存档走
ipcMain.handle('audioAttachPick', async () => {
  const r = await dialog.showOpenDialog(win, { title: '选择附件(将拷入 App 数据目录随周报保存)', properties: ['openFile'] });
  if (r.canceled || !r.filePaths.length) return null;
  try {
    const src = r.filePaths[0];
    const dir = path.join(ud(), 'audio-attachments'); fs.mkdirSync(dir, { recursive: true });
    const base = Date.now().toString(36) + '-' + path.basename(src);
    fs.copyFileSync(src, path.join(dir, base));
    return { name: path.basename(src), file: base };
  } catch (err) { return { error: String(err) }; }
});
ipcMain.handle('audioAttachOpen', (_e, file) => {
  try {
    const p = path.join(ud(), 'audio-attachments', path.basename(String(file || '')));
    if (!fs.existsSync(p)) return { error: '附件文件不存在' };
    shell.openPath(p); return { ok: true };
  } catch (err) { return { error: String(err) }; }
});
// HTML → PDF(隐藏窗 printToPDF,A4 横版带背景色)
ipcMain.handle('printHtmlPdf', async (_e, name, html) => {
  const r = await dialog.showSaveDialog(win, { title: '导出 PDF', defaultPath: name });
  if (r.canceled || !r.filePath) return { canceled: true };
  let pw = null;
  try {
    pw = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
    await pw.loadURL('data:text/html;charset=utf-8;base64,' + Buffer.from(String(html), 'utf8').toString('base64'));
    const pdf = await pw.webContents.printToPDF({ landscape: true, printBackground: true, pageSize: 'A4', margins: { top: 0.4, bottom: 0.4, left: 0.4, right: 0.4 } });
    fs.writeFileSync(r.filePath, pdf);
    return { path: r.filePath };
  } catch (err) { return { error: String(err) }; }
  finally { try { if (pw) pw.destroy(); } catch (e) { } }
});
ipcMain.handle('pickPptx', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: '选择 PPT 模板（如 文稿1.pptx）',
    properties: ['openFile'], filters: [{ name: 'PowerPoint', extensions: ['pptx'] }],
  });
  if (r.canceled || !r.filePaths.length) return null;
  return { path: r.filePaths[0] };
});
ipcMain.handle('readFileB64', (_e, p) => {
  try { return { b64: fs.readFileSync(p).toString('base64') }; }
  catch (e) { return { error: String(e && e.message || e) }; }
});

// 库存/SO 模拟：PSI 单元级行（country×model×日 渠道合计）—— 填渲染层 invFetchPsiUnits 的数据缝
ipcMain.handle('psiUnits', () => { try { return engine.psiUnits(); } catch (e) { return []; } });
// MiniMax AI 问答：主进程 fetch 转发（绕 CORS），30s 超时。
// 入参 payload={key,baseUrl,model,messages,tools?,maxTokens?}；出参 {content, toolCalls?, error?}。
// 【不落任何日志文件】——问答可能含业务敏感数据，绝不写盘。
// 读 eval/ 下的 key 文件(白名单文件名;仅本机进程间传递,不打印不落日志)——渲染层 dsKey 自动带入用
/* 命令行模型桥(2026-08-31,Acme内网 CorpLink CLI 场景):跑一条本机 CLI 完成一问一答。
   入参 {cmd, argsTmpl, inputMode:'stdin'|'file'|'arg', prompt, timeoutMs}
   - stdin: prompt 写入子进程 stdin
   - file : prompt 写临时 UTF-8 文件,参数模板里 {PROMPT_FILE} 替换为文件路径
   - arg  : prompt 作为最后一个参数追加
   stdout 全文即回复。shell:false 防注入;cmd 由用户在设置窗自己配(本机自己的 CLI)。 */
/* 代理诊断(2026-08-31):net.fetch 走系统代理后,连不上时要能看清走了哪条路。
   返回 Chromium 对该 URL 的代理决策(DIRECT / PROXY host:port / PAC 结果)。 */
ipcMain.handle('aiProxyInfo', async (_e, url) => {
  try {
    const u = String(url || 'https://api.deepseek.com');
    const r = await session.defaultSession.resolveProxy(u);
    return { proxy: r || 'DIRECT' };
  } catch (e) { return { proxy: '', error: String((e && e.message) || e) }; }
});
/* 本地文档上传(2026-08-31 Agent 看板)：选文件读文本内容供会话注入。
   支持纯文本类(txt/md/csv/json/log)；超长截断(60K 字符)。只读不写。 */
ipcMain.handle('readLocalDoc', async () => {
  try {
    const r = await dialog.showOpenDialog(win, {
      title: '选择要让 AI 阅读的文档',
      filters: [{ name: '文本文档', extensions: ['txt', 'md', 'csv', 'json', 'log'] }],
      properties: ['openFile'],
    });
    if (!r || r.canceled || !r.filePaths || !r.filePaths.length) return { canceled: true };
    const p2 = r.filePaths[0];
    const st = fs.statSync(p2);
    if (st.size > 8 * 1024 * 1024) return { error: '文件超过 8MB，请精简后再传' };
    let content = fs.readFileSync(p2, 'utf8');
    const truncated = content.length > 60000;
    if (truncated) content = content.slice(0, 60000);
    return { name: path.basename(p2), content, truncated };
  } catch (e) { return { error: String((e && e.message) || e) }; }
});
ipcMain.handle('aiChatCli', async (_e, payload) => {
  payload = payload || {};
  const { spawn } = require('child_process');
  const os = require('os');
  const cmd = String(payload.cmd || '').trim();
  if (!cmd) return { error: '未配置 CLI 命令' };
  const mode = ['stdin', 'file', 'arg'].includes(payload.inputMode) ? payload.inputMode : 'stdin';
  const prompt = String(payload.prompt || '');
  const timeoutMs = Math.min(600000, Math.max(10000, +payload.timeoutMs || 180000));
  let args = String(payload.argsTmpl || '').split(/\s+/).filter(Boolean);
  let tmpFile = null;
  try {
    if (mode === 'file') {
      tmpFile = path.join(os.tmpdir(), 'sb-cli-prompt-' + Date.now() + '.txt');
      fs.writeFileSync(tmpFile, prompt, 'utf8');
      let replaced = false;
      args = args.map(a => { if (a.indexOf('{PROMPT_FILE}') >= 0) { replaced = true; return a.replace('{PROMPT_FILE}', tmpFile); } return a; });
      if (!replaced) args.push(tmpFile);
    } else if (mode === 'arg') {
      args.push(prompt);
    }
    /* npm 包 CLI(corplink-cli 等)在 Windows 的实体是 .cmd 垫片——Node 的 spawn 禁止
       shell:false 跑批处理(EINVAL,npx.cmd 老坑)。先 shell:false 直跑(exe 场景最安全),
       EINVAL/ENOENT 自动换 shell:true 重试;shell 路径下参数逐个双引号转义,
       且 prompt 永不进 shell 命令行(arg 模式已在上面落成临时文件或此处强制 stdin)。 */
    const runOnce = (viaCmdExe) => new Promise((resolve) => {
      let out = '', err = '', done = false;
      /* 批处理垫片路径:直接 spawn cmd.exe(是 exe,shell:false 合法),/c 后跟目标与参数走数组——
         Node 做标准引用,没有 shell:true 字符串拼接的引号地狱(PowerShell 实测 code 0)。 */
      const c = viaCmdExe ? (process.env.ComSpec || 'cmd.exe') : cmd;
      const a = viaCmdExe ? ['/d', '/c', cmd].concat(args) : args;
      let child;
      try {
        child = spawn(c, a, { windowsHide: true, shell: false, env: process.env });
      } catch (e) { return resolve({ error: 'SPAWN:' + (e.code || '') + ':' + e.message }); }   // .cmd 的 EINVAL 是同步 throw,不走 error 事件
      const finish = (r) => { if (!done) { done = true; resolve(r); } };
      const t = setTimeout(() => { try { child.kill(); } catch (e) {} finish({ error: 'CLI 超时(' + Math.round(timeoutMs / 1000) + 's)' }); }, timeoutMs);
      child.stdout.on('data', d => { out += d; });
      child.stderr.on('data', d => { err += d; if (err.length > 20000) err = err.slice(-20000); });
      child.on('error', e => { clearTimeout(t); finish({ error: 'SPAWN:' + (e.code || '') + ':' + e.message }); });
      child.on('close', code => {
        clearTimeout(t);
        const text = String(out || '').trim();
        if (!text && code !== 0) return finish({ error: 'CLI 退出码 ' + code + (err ? ': ' + err.slice(0, 400) : '') });
        finish({ content: text });
      });
      if (mode === 'stdin') { try { child.stdin.write(prompt, 'utf8'); child.stdin.end(); } catch (e) {} }
      else { try { child.stdin.end(); } catch (e) {} }
    });
    let r = await runOnce(false);
    if (r && r.error && /^SPAWN:(EINVAL|ENOENT|UNKNOWN)/.test(r.error)) r = await runOnce(true);
    try { if (tmpFile) fs.unlinkSync(tmpFile); } catch (e) {}
    if (r && r.error && r.error.indexOf('SPAWN:') === 0) r = { error: 'CLI 启动失败: ' + r.error.slice(6) + '(检查命令名/PATH;npm 包 CLI 请直接填命令名如 corplink-cli)' };
    return r;
  } catch (e) {
    try { if (tmpFile) fs.unlinkSync(tmpFile); } catch (e2) {}
    return { error: String((e && e.message) || e) };
  }
});
ipcMain.handle('aiReadKeyFile', (_e, name) => {
  try {
    const safe = String(name || '').replace(/[^a-zA-Z0-9._-]/g, '');
    if (!safe || safe.indexOf('..') >= 0) return '';
    const p = path.join(__dirname, 'eval', safe);
    return fs.existsSync(p) ? fs.readFileSync(p, 'utf8').trim() : '';
  } catch (e) { return ''; }
});
ipcMain.handle('aiChat', async (_e, payload) => {
  payload = payload || {};
  const { key, baseUrl, model, messages } = payload;
  // key 可空:LM Studio 等本地 OpenAI 兼容服务无需鉴权(空 key → 不发 Authorization 头);
  // MiniMax 在线路径的"必填 Key"校验在渲染层设置窗做。
  if (!baseUrl) return { error: '未配置 Base URL' };
  const ctrl = new AbortController();
  const timeoutMs = Math.min(300000, Math.max(5000, +payload.timeoutMs || 30000));   // 本地大模型首次加载慢,可放宽到 5 分钟
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const body = { model: model || 'MiniMax-M2.5', messages: messages || [] };   // 默认 M2.5(评测 2026-08-28)
    if (Array.isArray(payload.tools) && payload.tools.length) body.tools = payload.tools;
    if (payload.maxTokens) body.max_tokens = payload.maxTokens;
    // 白名单增量放行采样参数：数字问答必须 temperature=0，否则 LM Studio 用默认 0.7~0.8 会编数。
    // 不传时行为与之前完全一致（MiniMax 路径从不传，零影响）。
    if (typeof payload.temperature === 'number') body.temperature = payload.temperature;
    if (typeof payload.top_p === 'number') body.top_p = payload.top_p;
    const headers = { 'Content-Type': 'application/json' };
    if (key) headers['Authorization'] = 'Bearer ' + key;

    /* ---- Anthropic(Claude) 格式适配(2026-08-31):Claude 的 Messages API 与 OpenAI 不兼容——
       x-api-key 头、system 顶层、max_tokens 必填、工具 input_schema、响应 content blocks。
       转换后仍返回 OpenAI 形状 {content, toolCalls},上层(编排链/面板)零改动。非流式。 ---- */
    if (payload.apiFormat === 'anthropic') {
      const sysMsgs = (messages || []).filter(m => m.role === 'system').map(m => String(m.content || '')).join('\n\n');
      const rest = [];
      (messages || []).forEach(m => {
        if (m.role === 'system') return;
        if (m.role === 'tool') {
          rest.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: String(m.tool_call_id || m.name || 'tool'), content: String(m.content || '') }] });
        } else if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length) {
          const blocks = [];
          if (m.content) blocks.push({ type: 'text', text: String(m.content) });
          m.tool_calls.forEach(tc => {
            let aj = {}; try { aj = JSON.parse(tc.function && tc.function.arguments || '{}'); } catch (e) {}
            blocks.push({ type: 'tool_use', id: String(tc.id || tc.function.name), name: tc.function.name, input: aj });
          });
          rest.push({ role: 'assistant', content: blocks });
        } else {
          rest.push({ role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content || '') });
        }
      });
      const abody = { model: model || 'claude-sonnet-5', max_tokens: +payload.maxTokens || 2048, messages: rest };
      if (sysMsgs) abody.system = sysMsgs;
      if (typeof payload.temperature === 'number') abody.temperature = payload.temperature;
      if (Array.isArray(payload.tools) && payload.tools.length) {
        abody.tools = payload.tools.map(t => ({ name: t.function.name, description: t.function.description || '', input_schema: t.function.parameters || { type: 'object', properties: {} } }));
      }
      const ar = await net.fetch(baseUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': key || '', 'anthropic-version': '2023-06-01' },
        body: JSON.stringify(abody), signal: ctrl.signal,
      });
      let aj = null; try { aj = await ar.json(); } catch (e) { aj = null; }
      if (!ar.ok) {
        const em = aj && aj.error && (aj.error.message || aj.error.type);
        return { error: 'HTTP ' + ar.status + (em ? ('：' + em) : '') };
      }
      let text = '', tcs = [];
      (aj && aj.content || []).forEach(b => {
        if (b.type === 'text') text += b.text || '';
        else if (b.type === 'tool_use') tcs.push({ id: b.id, type: 'function', function: { name: b.name, arguments: JSON.stringify(b.input || {}) } });
      });
      if (!text.trim() && !tcs.length) {
        let sk = ''; try { sk = JSON.stringify(aj).slice(0, 260); } catch (e) {}
        return { error: 'API 返回空内容(HTTP ' + ar.status + ', stop_reason=' + ((aj && aj.stop_reason) || '无') + ')。响应骨架: ' + sk };
      }
      return { content: text, toolCalls: tcs.length ? tcs : undefined };
    }

    /* ---- 流式（只在渲染层显式要求时启用；不传 stream/id 时行为与之前逐字节一致）----
       本地 30B 非流式要等整段生成完（几十秒~几分钟）用户只看到「思考中」；
       开流后首 token 通常几秒内到，感知速度差一个数量级。
       增量走既有 'aiStream' 通道（与内置 gguf 同一条，渲染层按 id 过滤）。 */
    if (payload.stream && payload.id) {
      body.stream = true;
      const emit = d => { try { if (win && !win.isDestroyed()) win.webContents.send('aiStream', Object.assign({ id: payload.id }, d)); } catch (e) { } };
      const rs = await net.fetch(baseUrl, { method: 'POST', headers, body: JSON.stringify(body), signal: ctrl.signal });
      if (!rs.ok) { let em = ''; try { em = (await rs.text()).slice(0, 300); } catch (e) { } return { error: 'HTTP ' + rs.status + (em ? ('：' + em) : '') }; }
      let content = '', toolCalls = null, buf = '', sseLines = 0, lastRaw = '';
      const dec = new TextDecoder();
      for await (const chunk of rs.body) {
        buf += dec.decode(chunk, { stream: true });
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          sseLines++; lastRaw = data.slice(0, 200);
          if (data === '[DONE]') continue;
          let o = null; try { o = JSON.parse(data); } catch (e) { continue; }
          const d = o && o.choices && o.choices[0] && o.choices[0].delta;
          if (!d) continue;
          if (d.content) { content += d.content; emit({ delta: d.content }); }
          if (d.tool_calls) {                       // 流式 tool_calls 分片累积
            toolCalls = toolCalls || [];
            d.tool_calls.forEach(tc => {
              const idx = tc.index || 0;
              toolCalls[idx] = toolCalls[idx] || { id: tc.id, type: 'function', function: { name: '', arguments: '' } };
              if (tc.id) toolCalls[idx].id = tc.id;
              if (tc.function && tc.function.name) toolCalls[idx].function.name += tc.function.name;
              if (tc.function && tc.function.arguments) toolCalls[idx].function.arguments += tc.function.arguments;
            });
          }
        }
      }
      emit({ done: true });
      const tcs = (toolCalls && toolCalls.filter(Boolean).length) ? toolCalls.filter(Boolean) : undefined;
      /* 空回复尸检(2026-08-31):流正常结束但一个字都没有——把现场带出去,别让用户对着「(空回复)」猜 */
      if (!String(content || '').trim() && !tcs) {
        return { error: 'API 返回空内容(流式收 ' + sseLines + ' 段,HTTP ' + rs.status + ')。最后一段原文: ' + (lastRaw || '(无)') + '。常见原因:企业代理拦截/改写了响应体、模型被内容策略拦截、max_tokens 过小。' };
      }
      return { content: content, toolCalls: tcs };
    }

    const r = await net.fetch(baseUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    let data = null;
    try { data = await r.json(); } catch (e) { data = null; }
    if (!r.ok) {
      const em = data && (data.error && (data.error.message || data.error) || data.base_resp && data.base_resp.status_msg || data.message);
      return { error: 'HTTP ' + r.status + (em ? ('：' + em) : '') };
    }
    // MiniMax 的 base_resp.status_code!=0 也算错误
    if (data && data.base_resp && data.base_resp.status_code && data.base_resp.status_code !== 0) {
      return { error: (data.base_resp.status_msg || ('错误码 ' + data.base_resp.status_code)) };
    }
    const choice = data && data.choices && data.choices[0];
    const msg = choice && (choice.message || choice.delta) || {};
    const content = (msg.content != null ? msg.content : (choice && choice.text)) || '';
    const toolCalls = Array.isArray(msg.tool_calls) ? msg.tool_calls : undefined;
    /* 空回复尸检(2026-08-31):HTTP 200 但没有内容也没有工具调用——把 finish_reason 与响应骨架带出去 */
    if (!String(content || '').trim() && !toolCalls) {
      // 思考模型专用尸检:reasoning_content 有内容而 content 空 = 思考吃光 max_tokens
      if (msg.reasoning_content != null && (choice && choice.finish_reason) === 'length') {
        return { error: '思考模型的思考链吃光了 token 预算,最终答案没写出来(finish_reason=length)。已在新版做预算自适应;若仍出现,建议日常问答改用 deepseek-chat(快),深度分析再用 v4-pro。' };
      }
      let sk = '';
      try { sk = JSON.stringify(data).slice(0, 260); } catch (e) { sk = '(不可序列化)'; }
      return { error: 'API 返回空内容(HTTP ' + r.status + ', finish_reason=' + ((choice && choice.finish_reason) || '无') + ')。响应骨架: ' + sk + '。常见原因:企业代理改写响应、内容策略拦截、模型名不存在但网关静默兜底。' };
    }
    return { content: String(content || ''), toolCalls };
  } catch (e) {
    const aborted = e && (e.name === 'AbortError');
    return { error: aborted ? ('请求超时（' + Math.round(timeoutMs / 1000) + ' 秒）') : String((e && e.message) || e) };
  } finally { clearTimeout(t); }
});
/* LM Studio 运行状态：已加载模型 + 占用内存。纯新增 IPC，失败一律返回 {error} 不抛。
   内存走 tasklist（LM Studio 的模型驻留在它自己的进程里，Electron 侧看不到）；
   模型信息优先打 LM Studio 原生 REST /api/v0/models（比 OpenAI 兼容口多出状态与上下文长度）。 */
ipcMain.handle('lmStatus', async (_e, baseUrl) => {
  const out = { procs: [], memMB: 0, models: [] };
  // 1) 进程内存
  try {
    const { execFile } = require('child_process');
    const csv = await new Promise((res) => {
      execFile('tasklist', ['/FO', 'CSV', '/NH'], { windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, so) => res(err ? '' : so));
    });
    csv.split(/\r?\n/).forEach(line => {
      const m = line.match(/^"([^"]+)","(\d+)",[^,]*,[^,]*,"([\d,]+) K"/);
      if (!m) return;
      const name = m[1];
      if (!/lm studio|^lms|llama|koboldcpp/i.test(name)) return;
      const mb = Math.round(parseInt(m[3].replace(/,/g, ''), 10) / 1024);
      if (mb < 20) return;                                   // 滤掉几个几 MB 的辅助进程
      out.procs.push({ name, pid: +m[2], memMB: mb });
      out.memMB += mb;
    });
    out.procs.sort((a, b) => b.memMB - a.memMB);
  } catch (e) { out.procError = String(e); }
  // 2) 已加载模型（原生口，拿不到就算了）
  try {
    if (baseUrl) {
      const root = String(baseUrl).replace(/\/+$/, '').replace(/\/v1$/, '');
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 3000);
      try {
        const r = await net.fetch(root + '/api/v0/models', { signal: ctrl.signal });
        if (r.ok) {
          const d = await r.json();
          out.models = (d && Array.isArray(d.data) ? d.data : []).map(m => ({
            id: m.id, state: m.state, type: m.type, quant: m.quantization,
            ctx: m.loaded_context_length || m.max_context_length,
          }));
        }
      } finally { clearTimeout(t); }
    }
  } catch (e) { /* 原生口不可用是正常的，忽略 */ }
  return out;
});

/* LM Studio / OpenAI 兼容服务:拉取可用模型列表(GET {base}/models)。纯新增 IPC。 */
ipcMain.handle('aiListModels', async (_e, baseUrl, key) => {
  if (!baseUrl) return { error: '未配置 Base URL' };
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 10000);
  try {
    const u = String(baseUrl).replace(/\/+$/, '') + '/models';
    const headers = {};
    if (key) headers['Authorization'] = 'Bearer ' + key;
    const r = await net.fetch(u, { headers, signal: ctrl.signal });
    let data = null; try { data = await r.json(); } catch (e) { data = null; }
    if (!r.ok) return { error: 'HTTP ' + r.status };
    const models = (data && Array.isArray(data.data) ? data.data : []).map(m => m && m.id).filter(Boolean);
    return { models };
  } catch (e) {
    return { error: (e && e.name === 'AbortError') ? '连接超时(10秒)——LM Studio 服务器开了吗?' : String((e && e.message) || e) };
  } finally { clearTimeout(t); }
});

/* ---------------- 本地 LLM（离线推理，主进程常驻）----------------
   运行库 node-llama-cpp v3（ESM，只能 dynamic import）；llama 实例 + 模型懒加载后
   常驻缓存；单请求锁 _llmBusy 防并发；流式增量经 webContents.send('aiStream',{id,...})。
   【不落任何日志文件】——同 aiChat，问答含业务数据，绝不写盘。 */
const _llm = { mod: null, llama: null, model: null, modelPath: null };
let _llmBusy = false;

// 模型查找顺序：① 设置里的自定义 .gguf 路径 → ② <exe 同级>/models/*.gguf → ③ 开发态仓库同级 llm-poc → ④ 无
function resolveLocalModel(customPath) {
  try { if (customPath && /\.gguf$/i.test(customPath) && fs.existsSync(customPath)) return { path: customPath, source: 'custom' }; } catch (e) {}
  try {
    const dir = path.join(path.dirname(app.getPath('exe')), 'models');
    if (fs.existsSync(dir)) {
      const gg = fs.readdirSync(dir).filter(f => /\.gguf$/i.test(f)).sort();
      if (gg.length) return { path: path.join(dir, gg[0]), source: 'exeModels' };
    }
  } catch (e) {}
  try {
    const dev = path.join(__dirname, '..', 'llm-poc', 'qwen2.5-1.5b-instruct-q4_k_m.gguf');
    if (fs.existsSync(dev)) return { path: dev, source: 'dev' };
  } catch (e) {}
  return { path: null, source: 'none' };
}

// 懒加载 + 复用：同一路径的模型只加载一次；路径变化则释放旧模型再载新的。
async function ensureLocalModel(modelPath) {
  if (_llm.model && _llm.modelPath === modelPath) return _llm.model;
  if (_llm.model && _llm.modelPath !== modelPath) { try { await _llm.model.dispose(); } catch (e) {} _llm.model = null; _llm.modelPath = null; }
  if (!_llm.mod) _llm.mod = await import('node-llama-cpp');
  if (!_llm.llama) _llm.llama = await _llm.mod.getLlama();   // 自动选后端：有 GPU 则用，否则纯 CPU
  try {
    _llm.model = await _llm.llama.loadModel({ modelPath });
  } catch (e) {
    // 大模型(如30B-A3B 17GB)塞不进显存时 Vulkan 分配失败 → 回退纯CPU重载;小模型不受影响
    const cpu = await _llm.mod.getLlama({ gpu: false });
    _llm.model = await cpu.loadModel({ modelPath });
    _llm.llama = cpu;
  }
  _llm.modelPath = modelPath;
  return _llm.model;
}

// 检测/解析本地模型路径（设置窗「检测模型」用）：不加载，只报解析结果。
ipcMain.handle('aiLocalModelInfo', (_e, customPath) => {
  const r = resolveLocalModel(customPath);
  return { path: r.path, source: r.source, exists: !!r.path };
});
// 选择本地模型文件（.gguf）
ipcMain.handle('aiPickModel', async () => {
  const r = await dialog.showOpenDialog(win, { title: '选择本地模型文件（.gguf）', properties: ['openFile'], filters: [{ name: 'GGUF 模型', extensions: ['gguf'] }] });
  if (r.canceled || !r.filePaths.length) return null;
  return r.filePaths[0];
});
// 本地推理：payload={id, modelPath?, system, messages:[{role,content}], maxTokens?, temperature?}
// 流式：webContents.send('aiStream',{id,delta}|{id,done}|{id,error})；本函数在完成后返回 {content} 或 {error}。
ipcMain.handle('aiChatLocal', async (_e, payload) => {
  payload = payload || {};
  const id = payload.id || String(Date.now());
  const emit = (d) => { try { if (win && !win.isDestroyed()) win.webContents.send('aiStream', Object.assign({ id }, d)); } catch (e) {} };
  if (_llmBusy) return { error: '本地模型正在生成中，请稍候' };
  const resolved = resolveLocalModel(payload.modelPath);
  if (!resolved.path) {
    const msg = '未找到本地模型（.gguf）。请在设置里「选择模型文件」，或把模型放到程序同级的 models 文件夹。';
    emit({ error: msg });
    return { error: msg };
  }
  _llmBusy = true;
  let context = null;
  try {
    const model = await ensureLocalModel(resolved.path);
    const { LlamaChatSession } = _llm.mod;
    // 8192：给口径提示词 + 数据快照(全局模式最多约 24KB)留足上下文，避免溢出丢内容。
    context = await model.createContext({ contextSize: 8192 });
    const seq = context.getSequence();
    const system = String(payload.system || '');
    const msgs = Array.isArray(payload.messages) ? payload.messages.slice() : [];
    // 末条 user 作为本轮提问；其余作为历史
    let lastUser = '';
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i] && msgs[i].role === 'user') { lastUser = String(msgs[i].content || ''); msgs.splice(i, 1); break; }
    }
    const session = new LlamaChatSession({ contextSequence: seq, systemPrompt: system });
    if (msgs.length) {
      const history = [{ type: 'system', text: system }];
      for (const m of msgs) {
        if (!m || m.content == null) continue;
        if (m.role === 'user') history.push({ type: 'user', text: String(m.content) });
        else if (m.role === 'assistant') history.push({ type: 'model', response: [String(m.content)] });
      }
      try { session.setChatHistory(history); } catch (e) {}
    }
    const answer = await session.prompt(lastUser || '（空）', {
      maxTokens: payload.maxTokens || 800,
      temperature: (payload.temperature != null ? payload.temperature : 0.3),
      onTextChunk: (t) => emit({ delta: t }),
    });
    emit({ done: true });
    return { content: String(answer || '') };
  } catch (e) {
    const msg = String((e && e.message) || e);
    emit({ error: msg });
    return { error: msg };
  } finally {
    if (context) { try { await context.dispose(); } catch (e) {} }
    _llmBusy = false;
  }
});
// 库存/SO 模拟：读取（load）已导出的 SO 模拟 xlsx（含 _forecast 表），交渲染层还原预测
ipcMain.handle('sosimLoad', async () => {
  const r = await dialog.showOpenDialog(win, { title: '读取 SO 模拟', properties: ['openFile'], filters: [{ name: 'Excel', extensions: ['xlsx'] }] });
  if (r.canceled || !r.filePaths.length) return { canceled: true };
  try { return { b64: fs.readFileSync(r.filePaths[0]).toString('base64'), path: r.filePaths[0] }; }
  catch (e) { return { error: String(e && e.message || e) }; }
});
ipcMain.handle('loadTemplate', (_e, id) => {
  const map = { 'latam-phone-review': 'latam-phone-review.pptx' };
  const f = map[id];
  if (!f) return { error: 'unknown template: ' + id };
  try { return { b64: fs.readFileSync(path.join(__dirname, 'app', 'pptoutput', 'templates', f)).toString('base64') }; }
  catch (e) { return { error: String(e && e.message || e) }; }
});

// allow renderer to set folder then refresh in one go
ipcMain.handle('setFolderAndRefresh', async (_e, folder) => {
  try { return await engine.refresh(folder, sendProgress); }
  catch (e) { return { error: String(e && e.message || e) }; }
});

// inventory (全流程库龄) folder
ipcMain.handle('pickInvFolder', async () => {
  const r = await dialog.showOpenDialog(win, { title: '选择库存文件夹（全流程库龄表）', properties: ['openDirectory'] });
  if (r.canceled || !r.filePaths.length) return null;
  return r.filePaths[0];
});
ipcMain.handle('setInvFolderAndRefresh', async (_e, folder) => {
  try { engine.setInvFolder(folder); return await engine.refresh(null, sendProgress); }
  catch (e) { return { error: String(e && e.message || e) }; }
});
// finance (经营分析: 预测表+实际表) folder
ipcMain.handle('pickFinFolder', async () => {
  const r = await dialog.showOpenDialog(win, { title: '选择经营分析文件夹（预测表 + 实际表）', properties: ['openDirectory'] });
  if (r.canceled || !r.filePaths.length) return null;
  return r.filePaths[0];
});
ipcMain.handle('setFinFolderAndRefresh', async (_e, folder) => {
  try { engine.setFinFolder(folder); return await engine.refresh(null, sendProgress); }
  catch (e) { return { error: String(e && e.message || e) }; }
});
// IDC 市场底表 folder
ipcMain.handle('pickIdcFolder', async () => {
  const r = await dialog.showOpenDialog(win, { title: '选择 IDC 市场数据文件夹（平板/音频底表）', properties: ['openDirectory'] });
  if (r.canceled || !r.filePaths.length) return null;
  return r.filePaths[0];
});
ipcMain.handle('setIdcFolderAndRefresh', async (_e, folder) => {
  try { engine.setIdcFolder(folder); return await engine.refresh(null, sendProgress); }
  catch (e) { return { error: String(e && e.message || e) }; }
});
// 库存看板源：发货表/成本表 文件夹（持久化、开机自动加载、不进 store；经 sosimSource 读最新文件）
ipcMain.handle('pickShipFolder', async () => { const r = await dialog.showOpenDialog(win, { title: '选择发货表文件夹', properties: ['openDirectory'] }); return (r.canceled || !r.filePaths.length) ? null : r.filePaths[0]; });
ipcMain.handle('setShipFolder', (_e, folder) => { try { engine.setShipFolder(folder); return { ok: true }; } catch (e) { return { error: String(e) }; } });
ipcMain.handle('pickCostFolder', async () => { const r = await dialog.showOpenDialog(win, { title: '选择成本表文件夹', properties: ['openDirectory'] }); return (r.canceled || !r.filePaths.length) ? null : r.filePaths[0]; });
ipcMain.handle('setCostFolder', (_e, folder) => { try { engine.setCostFolder(folder); return { ok: true }; } catch (e) { return { error: String(e) }; } });
ipcMain.handle('sosimSource', () => { try { return engine.sosimSource(); } catch (e) { return { error: String(e) }; } });
/* 单独刷新一个底表源（数据源看板每行的 ↻）。
   只作废这一个源的解析缓存，其余源文件签名未变 → 命中缓存不重解析 xlsx；
   合并/建仓仍走同一条 refresh 路径，口径与全量刷新完全一致。
   ship/cost 不在引擎 refresh 里（由渲染层 sosimSource 读），故这里只回执，渲染层自己重读。 */
ipcMain.handle('refreshOne', async (_e, kind) => {
  try {
    if (kind === 'ship' || kind === 'cost') return { scope: kind, rendererOnly: true };
    const n = engine.invalidateScope ? engine.invalidateScope(kind) : 0;
    const m = await engine.refresh(null, sendProgress);
    return Object.assign(m || {}, { scope: kind, invalidated: n });
  } catch (e) { return { error: String(e) }; }
});
ipcMain.handle('sourcesInfo', () => { try { return engine.sourcesInfo(); } catch (e) { return { error: String(e) }; } });

// ---- 存档 (archive) IPC ----
ipcMain.on('archiveLoadSync', (e) => { try { e.returnValue = AS.readBootstrap(ud(), docs(), ARCHVER()); } catch (err) { e.returnValue = null; } });
ipcMain.on('archiveSaveSync', (e, data) => { try { AS.writeArchive(archFile(), AS.pickArchiveKeys(data || {}), ARCHVER()); e.returnValue = true; } catch (err) { e.returnValue = false; } });
ipcMain.handle('archiveSave', (_e, data) => { try { AS.writeArchive(archFile(), AS.pickArchiveKeys(data || {}), ARCHVER()); return { ok: true, file: archFile() }; } catch (err) { return { ok: false, error: String(err) }; } });
ipcMain.handle('archiveInfo', () => { const file = archFile(); return { file, dir: AS.archiveDir(ud(), docs()), exists: fs.existsSync(file), versions: AS.listArchives(ud(), docs()) }; });
ipcMain.handle('archiveLoadVersion', (_e, file) => { try { const a = AS.readArchive(file); return a ? { data: a.data } : { error: '存档文件无效' }; } catch (err) { return { error: String(err) }; } });
ipcMain.handle('pickArchiveDir', async () => { const r = await dialog.showOpenDialog(win, { title: '选择存档文件夹', properties: ['openDirectory'] }); return (r.canceled || !r.filePaths.length) ? null : r.filePaths[0]; });
ipcMain.handle('archiveSetDir', (_e, dir) => { try { const nf = AS.setArchiveDir(ud(), docs(), dir, { move: true }); return { ok: true, file: nf }; } catch (err) { return { ok: false, error: String(err) }; } });
ipcMain.handle('archiveExportAs', async () => { const r = await dialog.showSaveDialog(win, { title: '导出存档', defaultPath: 'sb-存档.json' }); if (r.canceled || !r.filePath) return { canceled: true }; try { fs.copyFileSync(archFile(), r.filePath); return { path: r.filePath }; } catch (err) { return { error: String(err) }; } });
ipcMain.handle('archiveImport', async () => { const r = await dialog.showOpenDialog(win, { title: '导入存档', properties: ['openFile'], filters: [{ name: '存档', extensions: ['json'] }] }); if (r.canceled || !r.filePaths.length) return { canceled: true }; const a = AS.readArchive(r.filePaths[0]); if (!a) return { error: '存档文件无效' }; AS.writeArchive(archFile(), a.data, ARCHVER()); return { data: a.data }; });
ipcMain.handle('archiveOpenFolder', () => { try { shell.openPath(AS.archiveDir(ud(), docs())); return { ok: true }; } catch (err) { return { ok: false }; } });

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
    icon: path.join(__dirname, 'app', 'icon.png'),
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
    // 其余（含 file://）一律不开新窗——拖入 xlsx/pptx 曾经从这里弹出空白窗口（2026-09-01 实锤）
    return { action: 'deny' };
  });
  // 拖拽文件的浏览器默认行为是「导航到 file://该文件」——把一切离开本页的导航拦死
  win.webContents.on('will-navigate', (e) => { e.preventDefault(); });
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
// 2026-09-01 接线审计补齐：engine.industryTrend 早已存在且评测在用，唯独线上缺这条桥（AI 的产业趋势工具一直静默坏）
ipcMain.handle('industryTrend', (_e, params) => {
  try { return engine.industryTrend(params || {}); } catch (e) { return { error: String(e) }; }
});
// 产业看板·两代产品生命周期对齐对比
ipcMain.handle('lifecycleCompare', (_e, params) => {
  try { return engine.lifecycleCompare(params || {}); } catch (e) { return { error: String(e) }; }
});
// 路标自动识别取数：按产品/型号给逐月 SI/SO 序列（判定在渲染层的 roadmap-detect.js）
ipcMain.handle('psiCatalog', () => { try { return engine.catalog(); } catch (e) { return { error: String(e) }; } });
ipcMain.handle('searchDim', (_e, params) => { try { return engine.searchDim(params || {}); } catch (e) { return { error: String(e) }; } });
ipcMain.handle('rawRows', (_e, params) => { try { return engine.rawRows(params || {}); } catch (e) { return { error: String(e) }; } });
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
/* AI 产出文件免对话框直存（2026-09-01 用户「看不到文件存哪了」）：
   固定落 文档\销售团队-AI输出\，重名自动加时间戳；渲染层用返回的 path 画文件卡片 */
ipcMain.handle('aiSaveOutput', async (_e, name, b64) => {
  try {
    const dir = path.join(app.getPath('documents'), '销售团队-AI输出');
    fs.mkdirSync(dir, { recursive: true });
    const safe = String(name || 'AI输出').replace(/[\\/:*?"<>|]/g, '_').slice(0, 80);
    let p = path.join(dir, safe);
    if (fs.existsSync(p)) {
      const ext = path.extname(safe), stem = safe.slice(0, safe.length - ext.length);
      p = path.join(dir, stem + '_' + new Date().toISOString().slice(11, 19).replace(/:/g, '') + ext);
    }
    fs.writeFileSync(p, Buffer.from(String(b64 || ''), 'base64'));
    return { path: p, dir };
  } catch (e) { return { error: String((e && e.message) || e) }; }
});
ipcMain.handle('openPathAbs', (_e, p) => { try { shell.openPath(String(p || '')); return { ok: true }; } catch (e) { return { error: String(e) }; } });
ipcMain.handle('revealPath', (_e, p) => { try { shell.showItemInFolder(String(p || '')); return { ok: true }; } catch (e) { return { error: String(e) }; } });
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
/* Office 文本抽取(2026-09-01)：pptx/docx 都是 zip，手写 central directory 解析 +
   zlib.inflateRawSync 解压 slide/document XML，抽 <a:t>/<w:t> 文本——零依赖。 */
const { extractOfficeText, extractOfficeImages: officeImages, imageDataUrl: officeImgUrl } = require(require('path').join(__dirname, 'app', 'office-text-core.js'));
/* 单文件解析（📎 对话框与拖拽共用）：图片→dataUrl；office→抽文本；其余按 utf8 文本 */
const DOC_EXT_RE = /\.(txt|md|csv|json|log|pptx|docx|xlsx|png|jpg|jpeg|webp)$/i;
async function parseDocFile(p2) {
  try {
    if (!DOC_EXT_RE.test(p2)) return { error: '不支持的文件类型（支持 txt/md/csv/json/log/pptx/docx/xlsx/png/jpg/webp）: ' + path.basename(p2) };
    const st = fs.statSync(p2);
    if (st.size > 1024 * 1024 * 1024) return { error: '文件超过 1GB: ' + path.basename(p2) };   // 2026-09-02 用户「多大都行」：仅防极端值
    // 图片：返回 dataUrl，由渲染层先经多模态模型转述成文本再进编排链（主链保持纯文本）
    const imgExt = (p2.match(/\.(png|jpg|jpeg|webp)$/i) || [])[1];
    if (imgExt) {
      const mime = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' }[imgExt.toLowerCase()];
      return { name: path.basename(p2), kind: 'image', dataUrl: 'data:' + mime + ';base64,' + fs.readFileSync(p2).toString('base64') };
    }
    /* 表格(xlsx/csv/tsv)：走流式大表引擎，只取「表结构 + 少量样例」进提示词。
       绝不再整表读进内存——旧路径 61MB 文件吃 325MB 且在 20 万行处静默截断，模型据此求和必错。
       真要统计/查找，模型用 tableQuery/tableFind 直接读原文件（代码算，数字不会错）。 */
    if (/\.(xlsx|csv|tsv)$/i.test(p2)) {
      const prof = await BT.tableProfile(p2, { sample: 8 });
      const head = (prof.columns || []).map(c => c.col).join(' | ');
      const lines = [
        '【表格：' + path.basename(p2) + '】',
        prof.sheets && prof.sheets.length > 1 ? '工作表：' + prof.sheets.join(' / ') + '（当前：' + prof.sheet + '）' : (prof.sheet ? '工作表：' + prof.sheet : ''),
        '数据行数：' + prof.dataRows + '　列数：' + (prof.columns || []).length,
        '列（名｜类型｜样例值）：',
        ...(prof.columns || []).map(c => '  · ' + c.col + ' ｜ ' + c.type + (c.type === '数值' && c.min != null ? '（' + c.min + ' ~ ' + c.max + '）' : '') + ' ｜ ' + (c.samples || []).slice(0, 5).join('、')),
        '前几行：', head,
        ...(prof.sampleRows || []).map(r => r.map(x => x == null ? '' : String(x)).join(' | ')),
      ].filter(Boolean);
      const content2 = lines.join('\n');
      const docId2 = 'doc' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      DOC_STORE.set(docId2, { name: path.basename(p2), lines: LTC.docIndex(content2), size: st.size, srcPath: p2 });
      UPLOADED.add(path.resolve(p2));
      if (DOC_STORE.size > 12) { const first = DOC_STORE.keys().next().value; DOC_STORE.delete(first); }
      return { name: path.basename(p2), content: content2, truncated: false, srcPath: p2, docId: docId2,
        totalLines: prof.dataRows, size: st.size, kind: 'table', sheets: prof.sheets, sheet: prof.sheet,
        summary: (prof.sheet ? prof.sheet + ' ' : '') + prof.dataRows + ' 行 × ' + (prof.columns || []).length + ' 列；列：' + head.slice(0, 200) };
    }
    let content, embeddedImages;
    if (/\.(pptx|docx)$/i.test(p2)) {
      const raw = fs.readFileSync(p2);
      content = extractOfficeText(raw);
      // PPT/Word 里的内嵌图（图表截图、照片）也要能读——抽出来，渲染层逐张走视觉模型转述后并入正文
      try {
        const imgs = officeImages(raw, { max: 12 });
        if (imgs.length) embeddedImages = imgs.map(im => ({ name: im.name, dataUrl: officeImgUrl(im) }));
      } catch (e) {}
      if (!content && !(embeddedImages && embeddedImages.length)) return { error: '未能从该 Office 文件抽出文本或图片(可能加密、xls 老格式或内容为空): ' + path.basename(p2) };
      if (!content) content = '（' + path.basename(p2) + '：未抽到文字，仅含图片，见下方图片转述）';
    } else {
      content = fs.readFileSync(p2, 'utf8');
    }
    // 全文进索引库（docId），渲染层拿到的是开头 6 万字 + 行数；模型用 docSearch/docSlice 按需读其余部分
    const docId = 'doc' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const lines = LTC.docIndex(content);
    DOC_STORE.set(docId, { name: path.basename(p2), lines, size: st.size, srcPath: p2 });
    UPLOADED.add(path.resolve(p2));   // 上传即授权：本机工具可对这份文件读/改（写仍走审批卡）
    if (DOC_STORE.size > 12) { const first = DOC_STORE.keys().next().value; DOC_STORE.delete(first); }   // 最多留 12 份全文
    const truncated = content.length > 60000;
    let summary = '';
    if (truncated) content = content.slice(0, 60000);
    return { name: path.basename(p2), content, truncated, srcPath: p2, docId, totalLines: lines.length, size: st.size, summary, embeddedImages: embeddedImages || undefined };
  } catch (e) { return { error: String((e && e.message) || e) }; }
}
/* ---- PPT 模板体系(2026-09-01)：上传 PPT → AI 识别数据字段做成可刷新模板 ----
   模板=源 pptx 拷贝 + bindings.json，存 userData/ppt-templates/；
   刷新=按绑定重查数据 → 原位替换文本重打包（版式 100% 保真）→ 存 文档\销售团队-AI输出\ */
const OSC = require(path.join(__dirname, 'app', 'office-struct-core.js'));
function tplDir() { const d = path.join(ud(), 'ppt-templates'); fs.mkdirSync(d, { recursive: true }); return d; }
ipcMain.handle('pptStructure', (_e, p2) => {
  try {
    p2 = String(p2 || '');
    if (!/\.pptx$/i.test(p2) || !fs.existsSync(p2)) return { error: '需要一个存在的 .pptx 文件' };
    if (fs.statSync(p2).size > 30 * 1024 * 1024) return { error: 'PPT 超过 30MB' };
    return OSC.extractPptStructure(fs.readFileSync(p2));
  } catch (e) { return { error: String((e && e.message) || e) }; }
});
ipcMain.handle('pptTplSave', (_e, name, srcPath, bindings) => {
  try {
    if (!fs.existsSync(String(srcPath || ''))) return { error: '源 PPT 文件已不在原位置，请重新上传后再保存模板' };
    const id = 'tpl' + Date.now().toString(36);
    fs.copyFileSync(srcPath, path.join(tplDir(), id + '.pptx'));
    const meta = { id, name: String(name || '未命名模板').slice(0, 40), srcName: path.basename(srcPath), createdAt: new Date().toISOString().slice(0, 10), bindings: bindings || [] };
    fs.writeFileSync(path.join(tplDir(), id + '.json'), JSON.stringify(meta, null, 1));
    return { ok: true, id, name: meta.name };
  } catch (e) { return { error: String((e && e.message) || e) }; }
});
ipcMain.handle('pptTplList', () => {
  try {
    return fs.readdirSync(tplDir()).filter(f => f.endsWith('.json')).map(f => {
      try { const m = JSON.parse(fs.readFileSync(path.join(tplDir(), f), 'utf8')); return { id: m.id, name: m.name, srcName: m.srcName, createdAt: m.createdAt, fields: (m.bindings || []).filter(b => b.kind === 'data').length }; }
      catch (e) { return null; }
    }).filter(Boolean);
  } catch (e) { return []; }
});
ipcMain.handle('pptTplGet', (_e, id) => {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(tplDir(), String(id) + '.json'), 'utf8'));
    return m;
  } catch (e) { return { error: '模板不存在: ' + id }; }
});
ipcMain.handle('pptTplApply', (_e, id, repls, outName) => {
  try {
    const src = path.join(tplDir(), String(id) + '.pptx');
    if (!fs.existsSync(src)) return { error: '模板源文件缺失: ' + id };
    const out = OSC.replacePptTexts(fs.readFileSync(src), Array.isArray(repls) ? repls : []);
    const dir = path.join(app.getPath('documents'), '销售团队-AI输出');
    fs.mkdirSync(dir, { recursive: true });
    const safe = String(outName || '模板刷新').replace(/[\\/:*?"<>|]/g, '_').slice(0, 60);
    let p = path.join(dir, safe + '.pptx');
    if (fs.existsSync(p)) p = path.join(dir, safe + '_' + new Date().toISOString().slice(11, 19).replace(/:/g, '') + '.pptx');
    fs.writeFileSync(p, out);
    return { ok: true, path: p };
  } catch (e) { return { error: String((e && e.message) || e) }; }
});
ipcMain.handle('readLocalDoc', async () => {
  try {
    const r = await dialog.showOpenDialog(win, {
      title: '选择要让 AI 阅读的文档或图片',
      filters: [
        { name: '文档与图片', extensions: ['txt', 'md', 'csv', 'json', 'log', 'pptx', 'docx', 'xlsx', 'png', 'jpg', 'jpeg', 'webp'] },
        { name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp'] },
      ],
      properties: ['openFile'],
    });
    if (!r || r.canceled || !r.filePaths || !r.filePaths.length) return { canceled: true };
    return parseDocFile(r.filePaths[0]);
  } catch (e) { return { error: String((e && e.message) || e) }; }
});
/* 拖拽上传：渲染层经 webUtils 拿到真实路径后走这里；仅接受白名单扩展名的既存文件 */
const LTC = require(path.join(__dirname, 'app', 'local-tools-core.js'));
const DOC_STORE = new Map();   // docId → {name, lines, size, srcPath}
ipcMain.handle('docSearch', (_e, id, q, opt) => { const d = DOC_STORE.get(String(id)); if (!d) return { error: '文档不在索引里(可能已被新文档挤出或应用重启过)，请重新上传' }; const r = LTC.docSearch(d.lines, q, opt || {}); return Object.assign({ file: d.name, totalLines: d.lines.length }, r); });
ipcMain.handle('docSlice', (_e, id, from, to) => { const d = DOC_STORE.get(String(id)); if (!d) return { error: '文档不在索引里，请重新上传' }; return Object.assign({ file: d.name }, LTC.docSlice(d.lines, from, to)); });
/* ---- 工作区 + 本机工具(2026-09-02)：Claude Code 式本机操作。守卫=路径必须在用户指定的工作区内；写前自动备份 .bak ---- */
function wsFile() { return path.join(ud(), 'workspace.json'); }
/* 默认工作区 = 文档\销售团队-AI输出（AI 生成文件本来就落这里）——不设也能本地编程；用户可在「📁 工作区」加更多文件夹。
   上传过的文件（📎/拖拽）视为用户亲手交给 Agent 的：即使不在工作区也允许读/改/作为脚本目录（写仍走审批卡）。 */
function wsDefault() { try { const d = path.join(app.getPath('documents'), '销售团队-AI输出'); fs.mkdirSync(d, { recursive: true }); return d; } catch (e) { return ''; } }
function wsDirs() { let dirs = []; try { const o = JSON.parse(fs.readFileSync(wsFile(), 'utf8')); dirs = Array.isArray(o.dirs) ? o.dirs.filter(Boolean) : []; } catch (e) {} const d = wsDefault(); if (d && dirs.indexOf(d) < 0) dirs.push(d); return dirs; }
const UPLOADED = new Set();   // 本次运行里用户上传过的文件绝对路径
/* 已挂载的底表文件夹（PSI/库龄/财经/IDC/发货/成本）对 Agent **只读**开放（2026-09-11 用户：「底表也要能访问」）。
   读（fsList/fsRead/table*）放行；写（fsWrite/excelEdit/pptEdit/runCode）仍只认工作区——业务底表对 AI 只读是铁律。 */
function srcDirs() { try { const c = (engine && engine.config) || {}; return ['folder', 'invFolder', 'finFolder', 'idcFolder', 'shipFolder', 'costFolder'].map(k => c[k]).filter(Boolean).map(d => path.resolve(String(d))); } catch (e) { return []; } }
function wsGuard(p2, o) { const dirs = wsDirs(); const abs = path.resolve(String(p2 || '')); if (UPLOADED.has(abs) || [...UPLOADED].some(u => path.dirname(u) === abs)) return ''; if (o && o.readOnly && LTC.inWorkspace(abs, srcDirs())) return ''; if (!LTC.inWorkspace(abs, dirs)) return '路径不在工作区内(' + dirs.join(' ; ') + ')：' + p2 + '。上传过的文件可直接操作；其它文件夹请在 Agent 对话右上角「📁 工作区」添加'; return ''; }
function backupFile(p2) { try { if (!fs.existsSync(p2)) return ''; const bak = p2 + '.' + new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19) + '.bak'; fs.copyFileSync(p2, bak); return bak; } catch (e) { return ''; } }
ipcMain.handle('wsGet', () => ({ dirs: wsDirs(), readOnlyDirs: srcDirs() }));
ipcMain.handle('wsSet', (_e, dirs) => { try { fs.writeFileSync(wsFile(), JSON.stringify({ dirs: (dirs || []).filter(Boolean) })); return { ok: true, dirs: wsDirs() }; } catch (e) { return { error: String(e) }; } });
ipcMain.handle('wsPick', async () => { const r = await dialog.showOpenDialog(win, { title: '选择允许 Agent 操作的文件夹（工作区）', properties: ['openDirectory'] }); if (!r || r.canceled || !r.filePaths.length) return { canceled: true }; const dirs = wsDirs(); if (dirs.indexOf(r.filePaths[0]) < 0) dirs.push(r.filePaths[0]); fs.writeFileSync(wsFile(), JSON.stringify({ dirs })); return { ok: true, dirs }; });
ipcMain.handle('fsList', (_e, a) => { try { a = a || {}; const dir = path.resolve(String(a.dir || wsDirs()[0] || '')); const g = wsGuard(dir, { readOnly: true }); if (g) return { error: g }; const depth = Math.max(0, Math.min(3, +a.depth || 1)); const out = []; (function walk(d, lv) { let ents = []; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; } ents.forEach(en => { if (out.length >= 500) return; const p3 = path.join(d, en.name); if (en.isDirectory()) { out.push({ path: p3, dir: true }); if (lv < depth) walk(p3, lv + 1); } else { let sz = 0, mt = ''; try { const st = fs.statSync(p3); sz = st.size; mt = st.mtime.toISOString().slice(0, 16); } catch (e) {} out.push({ path: p3, size: sz, mtime: mt }); } }); })(dir, 1); return { dir, items: out, truncated: out.length >= 500 }; } catch (e) { return { error: String(e) }; } });
ipcMain.handle('fsRead', (_e, a) => { try { a = a || {}; const p2 = path.resolve(String(a.path || '')); const g = wsGuard(p2, { readOnly: true }); if (g) return { error: g }; if (!fs.existsSync(p2)) return { error: '文件不存在: ' + p2 }; const max = Math.max(1000, Math.min(200000, +a.maxChars || 40000)); if (/\.xlsx$/i.test(p2)) { const XLSX = require('xlsx'); const wb = XLSX.read(fs.readFileSync(p2), { type: 'buffer' }); const sheet = a.sheet || wb.SheetNames[0]; const ws = wb.Sheets[sheet]; if (!ws) return { error: '没有工作表 ' + sheet + '（现有: ' + wb.SheetNames.join('/') + '）' }; const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true }); const from = Math.max(0, +a.fromRow || 0); const lim = Math.max(1, Math.min(2000, +a.rows || 200)); return { path: p2, sheets: wb.SheetNames, sheet, totalRows: rows.length, fromRow: from, rows: rows.slice(from, from + lim) }; } if (/\.(pptx|docx)$/i.test(p2)) { const t = extractOfficeText(fs.readFileSync(p2)); return { path: p2, text: t.slice(0, max), truncated: t.length > max, totalChars: t.length }; } const t = fs.readFileSync(p2, 'utf8'); return { path: p2, text: t.slice(0, max), truncated: t.length > max, totalChars: t.length }; } catch (e) { return { error: String(e) }; } });
ipcMain.handle('fsWrite', (_e, a) => { try { a = a || {}; const p2 = path.resolve(String(a.path || '')); const g = wsGuard(p2); if (g) return { error: g }; if (/\.(xlsx|pptx|docx|exe|dll|bat|cmd|ps1)$/i.test(p2)) return { error: 'fsWrite 只写文本类文件；Excel 用 excelEdit，PPT 用 pptEdit' }; fs.mkdirSync(path.dirname(p2), { recursive: true }); const bak = backupFile(p2); fs.writeFileSync(p2, String(a.content == null ? '' : a.content), 'utf8'); return { ok: true, path: p2, bytes: Buffer.byteLength(String(a.content || ''), 'utf8'), backup: bak }; } catch (e) { return { error: String(e) }; } });
ipcMain.handle('excelEdit', (_e, a) => { try { a = a || {}; const p2 = path.resolve(String(a.path || '')); const g = wsGuard(p2); if (g) return { error: g }; if (!/\.xlsx$/i.test(p2)) return { error: '只支持 .xlsx' }; const XLSX = require('xlsx'); let buf; if (fs.existsSync(p2)) buf = fs.readFileSync(p2); else { const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([[]]), 'Sheet1'); buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }); } const r = LTC.applyExcelOps(buf, a.ops || [], XLSX); const bak = backupFile(p2); fs.writeFileSync(p2, r.buf); return { ok: true, path: p2, applied: r.applied, sheets: r.sheets, backup: bak, note: '已写入；原文件已备份为 .bak。注意：单元格样式/公式可能被简化' }; } catch (e) { return { error: String((e && e.message) || e) }; } });
ipcMain.handle('pptEdit', (_e, a) => { try { a = a || {}; const p2 = path.resolve(String(a.path || '')); const g = wsGuard(p2); if (g) return { error: g }; if (!/\.pptx$/i.test(p2) || !fs.existsSync(p2)) return { error: '需要一个存在的 .pptx' }; const r = LTC.pptReplaceText(fs.readFileSync(p2), a.replace || [], OSC); if (!r.hits) return { ok: false, hits: 0, note: '没有任何文本命中 find，文件未改' }; const bak = backupFile(p2); fs.writeFileSync(p2, r.buf); return { ok: true, path: p2, hits: r.hits, shapesChanged: r.changed, backup: bak }; } catch (e) { return { error: String((e && e.message) || e) }; } });
ipcMain.handle('runCode', async (_e, a) => { try { a = a || {}; const cwd = path.resolve(String(a.cwd || wsDirs()[0] || '')); const g = wsGuard(cwd); if (g) return { error: g }; const lang = String(a.lang || 'node'); const code = String(a.code || ''); if (!code.trim()) return { error: 'code 为空' }; const { spawn } = require('child_process'); const tmp = path.join(cwd, '.sb-run-' + Date.now().toString(36) + (lang === 'python' ? '.py' : '.js')); fs.writeFileSync(tmp, code, 'utf8'); /* 脚本能 require 软件自带的库(xlsx 等)：NODE_PATH 指向 app 的 node_modules；打包后 xlsx 走 asarUnpack 真实目录 */
      const nmDirs = [path.join(__dirname, 'node_modules'), path.join(__dirname.replace(/app\.asar$/, 'app.asar.unpacked'), 'node_modules')].filter((d, i, arr) => arr.indexOf(d) === i);
      const env = Object.assign({}, process.env, { ELECTRON_RUN_AS_NODE: '1', PYTHONUTF8: '1', NODE_PATH: nmDirs.join(path.delimiter) + (process.env.NODE_PATH ? path.delimiter + process.env.NODE_PATH : '') }); const cmd = lang === 'python' ? (process.platform === 'win32' ? 'py' : 'python3') : process.execPath; const args = lang === 'python' ? ['-3', tmp] : [tmp]; return await new Promise(res => { let out = '', err = ''; let child; try { child = spawn(cmd, args, { cwd, env, windowsHide: true, shell: false }); } catch (e) { try { fs.unlinkSync(tmp); } catch (e2) {} return res({ error: '启动失败: ' + e.message }); } const t = setTimeout(() => { try { child.kill(); } catch (e) {} }, Math.min(300000, Math.max(5000, +a.timeoutMs || 120000))); child.stdout.on('data', d => { out += d; if (out.length > 60000) out = out.slice(-60000); }); child.stderr.on('data', d => { err += d; if (err.length > 20000) err = err.slice(-20000); }); child.on('error', e => { clearTimeout(t); try { fs.unlinkSync(tmp); } catch (e2) {} res({ error: '运行失败: ' + e.message + (lang === 'python' ? '（本机可能没有 Python，用 node）' : '') }); }); child.on('close', code2 => { clearTimeout(t); try { fs.unlinkSync(tmp); } catch (e2) {} res({ ok: code2 === 0, exitCode: code2, stdout: out.slice(0, 20000), stderr: err.slice(0, 8000), cwd }); }); }); } catch (e) { return { error: String(e) }; } });
/* ---- 大表工具（2026-09-04 用户：底表都 50MB 以上）：流式读取 + 统计由代码算 ----
   只读，不改文件，所以不走审批闸；路径仍过 wsGuard（工作区内或用户上传过的文件）。
   模型只负责挑表/挑列/给筛选条件，求和分组一律代码算——杜绝「模型自己写脚本把 208 万算成 1234」。 */
const BT = require(path.join(__dirname, 'app', 'bigtable-core.js'));
function btGuard(a) { const p2 = path.resolve(String((a && a.path) || '')); const g = wsGuard(p2, { readOnly: true }); return g ? { error: g } : { path: p2 }; }
ipcMain.handle('tableProfile', async (_e, a) => { try { const g = btGuard(a); if (g.error) return g; return await BT.tableProfile(g.path, a || {}); } catch (e) { return { error: String((e && e.message) || e) }; } });
ipcMain.handle('tableQuery', async (_e, a) => { try { const g = btGuard(a); if (g.error) return g; return await BT.tableQuery(g.path, a || {}); } catch (e) { return { error: String((e && e.message) || e) }; } });
ipcMain.handle('tableValues', async (_e, a) => { try { const g = btGuard(a); if (g.error) return g; return await BT.tableDistinct(g.path, a || {}); } catch (e) { return { error: String((e && e.message) || e) }; } });
ipcMain.handle('tableFind', async (_e, a) => { try { const g = btGuard(a); if (g.error) return g; return await BT.tableFind(g.path, a || {}); } catch (e) { return { error: String((e && e.message) || e) }; } });
/* ---- 本机接收（2026-09-04 用户：这台电脑网页上传功能坏了、一上传就崩，要从手机/另一台设备把文件传进来）----
   本机开一个 http 服务，另一台同 Wi-Fi 的设备扫码/开链接，把文件「发送」过来，流式落到 文档\销售团队-AI输出\接收\，
   直接出现在软件里。接收端是 Node http 服务，跟这台电脑那套会崩的浏览器上传毫无关系。
   安全：4 位取件码写在 URL 路径里（别的路径一律 404）；只在接收窗口开着时运行；只写本机磁盘、单文件封顶 1GB。 */
let recvServer = null, recvInfo = null;
function lanIps() {   // 全部候选，按「最像手机能连的物理局域网」排序：192.168 > 10 > 172.16-31 > 其它 > 100.x(多为 Tailscale/CGNAT 虚拟网卡)
  try { const os = require('os'); const cands = []; Object.values(os.networkInterfaces()).forEach(list => (list || []).forEach(x => { if (x.family === 'IPv4' && !x.internal) cands.push(x.address); }));
    const score = a => /^192\.168\./.test(a) ? 0 : /^10\./.test(a) ? 1 : /^172\.(1[6-9]|2\d|3[01])\./.test(a) ? 2 : /^100\./.test(a) ? 4 : 3;
    return [...new Set(cands)].sort((a, b) => score(a) - score(b)); } catch (e) { return []; }
}
function recvDir() { const d = path.join(docs(), '销售团队-AI输出', '接收'); fs.mkdirSync(d, { recursive: true }); return d; }
function safeName(n) { n = String(n || 'file').replace(/[\\/:*?"<>|]/g, '_').replace(/[\x00-\x1f]/g, '').replace(/^\.+/, '').slice(0, 180); return n || 'file'; }
function uniqPath(dir, name) { let p = path.join(dir, name); if (!fs.existsSync(p)) return p; const ext = path.extname(name), base = name.slice(0, name.length - ext.length); return path.join(dir, base + '_' + Date.now().toString(36) + ext); }
function recvPage(code) {
  return '<!doctype html><html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>发送文件到电脑</title>' +
    '<style>*{box-sizing:border-box}body{font-family:-apple-system,system-ui,"Segoe UI",sans-serif;margin:0;background:#f5f5f7;color:#1d1d1f;-webkit-text-size-adjust:100%}.w{max-width:520px;margin:0 auto;padding:22px}h1{font-size:20px;margin:6px 0 2px}.sub{color:#86868b;font-size:14px;margin-bottom:8px}.card{background:#fff;border-radius:16px;padding:18px;box-shadow:0 1px 4px rgba(0,0,0,.06);margin:14px 0}input[type=file]{width:100%;padding:14px 0;font-size:16px}button{width:100%;padding:15px;font-size:17px;border:0;border-radius:12px;background:#C7000B;color:#fff;font-weight:600;cursor:pointer}button:disabled{opacity:.45}.li{padding:10px 2px;border-bottom:1px solid #eee;font-size:14px;word-break:break-all}.ok{color:#0a8a3a}.err{color:#C7000B}#bar{height:6px;background:#eee;border-radius:3px;overflow:hidden;margin-top:12px;display:none}#bar>i{display:block;height:100%;width:0;background:#C7000B;transition:width .12s}</style></head>' +
    '<body><div class="w"><h1>📥 发送文件到电脑</h1><div class="sub">和电脑连同一个 Wi-Fi 即可。文件会直接出现在电脑的 销售团队 软件里。</div>' +
    '<div class="card"><input type="file" id="f" multiple><div id="bar"><i></i></div><div style="height:12px"></div><button id="b">发送到电脑</button></div>' +
    '<div class="card" id="log" style="display:none"><b>发送记录</b><div id="list"></div></div></div><script>' +
    'var code=' + JSON.stringify(String(code)) + ';var f=document.getElementById("f"),b=document.getElementById("b"),bar=document.getElementById("bar"),barI=bar.firstElementChild,log=document.getElementById("log"),list=document.getElementById("list");' +
    'function add(name,cls,txt){log.style.display="block";var d=document.createElement("div");d.className="li "+(cls||"");d.textContent=name+(txt?" — "+txt:"");list.appendChild(d);return d}' +
    'b.onclick=function(){var files=[].slice.call(f.files);if(!files.length){alert("请先选择文件");return}b.disabled=true;var i=0;function next(){if(i>=files.length){b.disabled=false;f.value="";bar.style.display="none";barI.style.width="0";return}var file=files[i++];var row=add(file.name,"","发送中…");var xhr=new XMLHttpRequest();xhr.open("POST","/"+code+"/up?name="+encodeURIComponent(file.name));xhr.upload.onprogress=function(e){if(e.lengthComputable){bar.style.display="block";barI.style.width=(e.loaded/e.total*100)+"%"}};xhr.onload=function(){if(xhr.status===200){row.className="li ok";row.textContent=file.name+" — 已送达电脑 ✓"}else{row.className="li err";row.textContent=file.name+" — 失败("+xhr.status+") "+xhr.responseText}next()};xhr.onerror=function(){row.className="li err";row.textContent=file.name+" — 网络错误，确认和电脑同一 Wi-Fi";next()};xhr.send(file)}next()};' +
    '</scr' + 'ipt></body></html>';
}
ipcMain.handle('recvStart', async () => {
  try {
    if (recvServer && recvInfo) return recvInfo;
    const http = require('http');
    const code = String(Math.floor(1000 + Math.random() * 9000));
    const dir = recvDir();
    const server = http.createServer((req, res) => {
      try {
        const u = new URL(req.url, 'http://x'); const parts = u.pathname.split('/').filter(Boolean);
        if (req.method === 'GET' && parts.length === 1 && parts[0] === code) { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(recvPage(code)); return; }
        if (req.method === 'POST' && parts.length === 2 && parts[0] === code && parts[1] === 'up') {
          const cl = +req.headers['content-length'] || 0;
          if (cl > 1024 * 1024 * 1024) { res.writeHead(413); res.end('文件超过 1GB'); return; }
          const dest = uniqPath(dir, safeName(u.searchParams.get('name') || 'file'));
          const wstream = fs.createWriteStream(dest); let bytes = 0, aborted = false;
          req.on('data', d => { bytes += d.length; if (bytes > 1024 * 1024 * 1024 && !aborted) { aborted = true; try { wstream.destroy(); } catch (e) {} try { fs.unlinkSync(dest); } catch (e) {} res.writeHead(413); res.end('文件超过 1GB'); try { req.destroy(); } catch (e) {} } });
          wstream.on('finish', () => { if (aborted) return; res.writeHead(200); res.end('ok'); try { if (win && !win.isDestroyed()) win.webContents.send('recvFile', { name: path.basename(dest), path: dest, size: bytes, at: Date.now() }); } catch (e) {} });
          wstream.on('error', () => { if (!aborted) { try { res.writeHead(500); res.end('write error'); } catch (e) {} } });
          req.on('error', () => { try { wstream.destroy(); } catch (e) {} });
          req.pipe(wstream); return;
        }
        res.writeHead(404); res.end('not found');
      } catch (e) { try { res.writeHead(500); res.end('err'); } catch (e2) {} }
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '0.0.0.0', resolve); });
    const port = server.address().port; const ips = lanIps(); const ip = ips[0] || '127.0.0.1';
    recvServer = server; recvInfo = { running: true, url: 'http://' + ip + ':' + port + '/' + code, ip, ips, port, code, dir };
    return recvInfo;
  } catch (e) { return { error: String((e && e.message) || e) }; }
});
ipcMain.handle('recvStop', () => { try { if (recvServer) { recvServer.close(); recvServer = null; } recvInfo = null; return { ok: true }; } catch (e) { return { error: String(e) }; } });
ipcMain.handle('recvStatus', () => recvInfo || { running: false });
ipcMain.handle('recvOpenDir', () => { try { shell.openPath(recvDir()); return { ok: true }; } catch (e) { return { error: String(e) }; } });
app.on('before-quit', () => { try { if (recvServer) recvServer.close(); } catch (e) {} });
ipcMain.handle('readDocByPath', async (_e, p2) => {
  try {
    p2 = String(p2 || '');
    if (!p2 || !fs.existsSync(p2) || !fs.statSync(p2).isFile()) return { error: '文件不存在或不可读' };
    return parseDocFile(p2);
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
        } else if (Array.isArray(m.content)) {
          // OpenAI 多模态 content 数组 → Anthropic blocks（图片 data URL → base64 source）
          const blocks = m.content.map(part => {
            if (part && part.type === 'image_url' && part.image_url && part.image_url.url) {
              const mm = String(part.image_url.url).match(/^data:([^;]+);base64,(.*)$/);
              if (mm) return { type: 'image', source: { type: 'base64', media_type: mm[1], data: mm[2] } };
              return { type: 'text', text: '(不支持的图片URL形式)' };
            }
            return { type: 'text', text: String((part && part.text) || '') };
          });
          rest.push({ role: m.role === 'assistant' ? 'assistant' : 'user', content: blocks });
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

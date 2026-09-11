// Splash 专用桥：只收 main 推送的阶段/版本，不暴露任何其它能力。
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('splash', {
  onPhase:   (cb) => ipcRenderer.on('phase',   (_e, d) => cb(d)),
  onVersion: (cb) => ipcRenderer.on('version', (_e, v) => cb(v)),
});

// UI 实测启动器：独立 userData（不与用户正开着的实例抢单实例锁）+ 开 CDP 调试端口
const { app } = require('electron');
const path = require('path');
const os = require('os');
app.setPath('userData', path.join(os.tmpdir(), 'sb-ui-test-userdata'));
app.commandLine.appendSwitch('remote-debugging-port', '9224');
require('D:/workspace/Salesboard/main.js');

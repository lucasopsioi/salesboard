/* 跑全量测试：app/ 与 pptoutput/ 的 *.test.js（+ selftest/*.js 如果有）。
   任何一个文件退出码非 0 就整体失败——这是打包前的硬闸门。 */
'use strict';
const fs = require('fs'), path = require('path');
const { execFileSync } = require('child_process');

const root = path.join(__dirname, '..');
const files = [];
const collect = (dir, filter) => {
  let names = [];
  try { names = fs.readdirSync(path.join(root, dir)); } catch (e) { return; }
  names.filter(filter).sort().forEach(n => files.push(path.join(dir, n)));
};
collect('app', n => n.endsWith('.test.js'));
collect('app/pptoutput', n => n.endsWith('.test.js'));
collect('app/pptoutput/designer', n => n.endsWith('.test.js'));
collect('selftest', n => n.endsWith('.js'));

if (!files.length) { console.error('没找到任何测试文件'); process.exit(1); }

const failed = [];
files.forEach(f => {
  try {
    execFileSync(process.execPath, [path.join(root, f)], { stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    failed.push(f);
    const out = String((e.stdout || '') + (e.stderr || ''));
    const lines = out.split('\n').filter(l => /^FAIL|未捕获异常/.test(l)).slice(0, 5);
    console.log('FAIL >>> ' + f);
    lines.forEach(l => console.log('    ' + l));
  }
});
console.log('\n通过 ' + (files.length - failed.length) + ' / ' + files.length + ' 个测试文件');
process.exit(failed.length ? 1 : 0);

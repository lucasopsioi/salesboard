const H=require('./history.js');
let f=0; const ok=(n,c)=>{console.log((c?'PASS ':'FAIL ')+n); if(!c)f++;};
const h=H.create(3);
H.record(h,'A');                 // 基线
ok('基线无 undo', H.canUndo(h)===false);
H.record(h,'B'); H.record(h,'C');
ok('canUndo', H.canUndo(h)===true);
ok('undo→B', H.undo(h)==='B');
ok('undo→A', H.undo(h)==='A');
ok('undo 到底→null', H.undo(h)===null);
ok('redo→B', H.redo(h)==='B');
ok('redo→C', H.redo(h)==='C');
ok('redo 到顶→null', H.redo(h)===null);
H.record(h,'C');                 // 相同状态不入栈
ok('相同状态不记', H.canUndo(h)===true && H.redo(h)===null);
// 新 record 清 redo
H.undo(h); H.record(h,'D');
ok('record 清 redo', H.canRedo(h)===false);
// 封顶 limit=3
const h2=H.create(2); ['A','B','C','D'].forEach(s=>H.record(h2,s));
let n=0; while(H.undo(h2)!==null) n++;
ok('封顶≤2步', n===2);
console.log(f?('\n'+f+' FAILED'):'\nALL PASS'); process.exit(f?1:0);

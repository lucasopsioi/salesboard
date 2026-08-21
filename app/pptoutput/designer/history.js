(function (root, factory){ const a=factory(); if(typeof module!=='undefined'&&module.exports)module.exports=a; if(typeof window!=='undefined')window.PptHistory=a; })(this, function(){
  function create(limit){ return { undo:[], redo:[], committed:null, limit:limit||50 }; }
  function record(h, state){ if(h.committed===null){ h.committed=state; return; } if(state===h.committed) return; h.undo.push(h.committed); if(h.undo.length>h.limit) h.undo.shift(); h.redo=[]; h.committed=state; }
  function undo(h){ if(!h.undo.length) return null; h.redo.push(h.committed); h.committed=h.undo.pop(); return h.committed; }
  function redo(h){ if(!h.redo.length) return null; h.undo.push(h.committed); h.committed=h.redo.pop(); return h.committed; }
  function canUndo(h){ return h.undo.length>0; }
  function canRedo(h){ return h.redo.length>0; }
  return { create, record, undo, redo, canUndo, canRedo };
});

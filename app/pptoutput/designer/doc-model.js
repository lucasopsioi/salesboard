(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.PptDoc = api;
})(this, function () {
  let _c = 0; const uid = p => p + (Date.now().toString(36)) + (++_c);
  function newSlide() { return { id: uid('s'), bg: 'FFFFFF', elements: [] }; }
  function newPresentation(name) { return { id: uid('p'), name: name || '未命名模板', page: { w: 13.333, h: 7.5 }, slides: [newSlide()] }; }
  function newElement(type, props) {
    return Object.assign({ id: uid('e'), type: type, x: 1, y: 1, w: 3, h: 1, z: 0, style: {} }, props || {});
  }
  function addSlide(doc) { const s = newSlide(); doc.slides.push(s); return s; }
  function removeSlide(doc, idx) { if (doc.slides.length > 1) doc.slides.splice(idx, 1); }
  function moveSlide(doc, from, to) { const a = doc.slides; if (to < 0 || to >= a.length) return; a.splice(to, 0, a.splice(from, 1)[0]); }
  function addElement(doc, si, el) { el.z = doc.slides[si].elements.length; doc.slides[si].elements.push(el); return el; }
  function removeElement(doc, si, elId) { const es = doc.slides[si].elements; const i = es.findIndex(e => e.id === elId); if (i >= 0) es.splice(i, 1); }
  function updateElement(doc, si, elId, patch) { const e = doc.slides[si].elements.find(x => x.id === elId); if (e) Object.assign(e, patch); return e; }
  function cloneElement(el) { const c = JSON.parse(JSON.stringify(el)); c.id = uid('e'); return c; }
  function groupElements(doc, si, ids) { const sl = doc.slides[si]; if (!sl) return null; const gid = uid('g'); sl.elements.forEach(e => { if (ids.indexOf(e.id) >= 0) e.groupId = gid; }); return gid; }
  function ungroupElements(doc, si, gid) { const sl = doc.slides[si]; if (!sl) return; sl.elements.forEach(e => { if (e.groupId === gid) delete e.groupId; }); }
  function groupMembers(doc, si, gid) { const sl = doc.slides[si]; return sl ? sl.elements.filter(e => e.groupId === gid) : []; }
  function serialize(doc) { return JSON.stringify(doc); }
  function deserialize(str) { return JSON.parse(str); }
  return { newPresentation, newSlide, newElement, addSlide, removeSlide, moveSlide, addElement, removeElement, updateElement, cloneElement, groupElements, ungroupElements, groupMembers, serialize, deserialize };
});

(function (root, factory) {
  const dep = (typeof require !== 'undefined') ? require('./doc-model.js') : (root && root.PptDoc);
  const api = factory(dep);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.PptStore = api;
})(this, function (PptDoc) {
  const PREFIX = 'sb.pptDesigner.';
  const INDEX = PREFIX + 'index';
  const serialize = (PptDoc && PptDoc.serialize) || (d => JSON.stringify(d));
  const deserialize = (PptDoc && PptDoc.deserialize) || (s => JSON.parse(s));

  function readIndex(storage) {
    const raw = storage.getItem(INDEX);
    if (!raw) return [];
    try { const a = JSON.parse(raw); return Array.isArray(a) ? a : []; } catch (e) { return []; }
  }
  function writeIndex(storage, idx) { storage.setItem(INDEX, JSON.stringify(idx)); }

  function listTemplates(storage) { return readIndex(storage); }

  function saveTemplate(storage, doc) {
    storage.setItem(PREFIX + doc.id, serialize(doc));
    const idx = readIndex(storage);
    const i = idx.findIndex(e => e.id === doc.id);
    const entry = { id: doc.id, name: doc.name };
    if (i >= 0) idx[i] = entry; else idx.push(entry);
    writeIndex(storage, idx);
  }

  function loadTemplate(storage, id) {
    const raw = storage.getItem(PREFIX + id);
    if (raw == null) return null;
    try { return deserialize(raw); } catch (e) { return null; }
  }

  function deleteTemplate(storage, id) {
    storage.removeItem(PREFIX + id);
    writeIndex(storage, readIndex(storage).filter(e => e.id !== id));
  }

  return { listTemplates, saveTemplate, loadTemplate, deleteTemplate };
});

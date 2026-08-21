(function () {
  var api = window.sb || {};
  var isKey = function (k) { return /^sb[._]/.test(k) || k === 'salesboard'; };
  function collect() {
    var o = {};
    for (var i = 0; i < localStorage.length; i++) {
      var k = localStorage.key(i);
      if (isKey(k)) o[k] = localStorage.getItem(k);
    }
    return o;
  }

  // Bound native originals — captured BEFORE wrapping so bootstrap-populate
  // and importFile write via the real setItem (no redundant save-storm).
  var _set = localStorage.setItem.bind(localStorage);
  var _rm = localStorage.removeItem.bind(localStorage);

  // 1) Bootstrap: archive -> localStorage (authoritative). No archive => migrate existing.
  //    Uses NATIVE _set so populating does not trigger the (not-yet-installed) debounced save.
  try {
    var a = api.archiveLoadSync && api.archiveLoadSync();
    if (a && a.data) {
      Object.keys(a.data).forEach(function (k) { try { _set(k, a.data[k]); } catch (e) {} });
    } else {
      var seed = collect();
      if (Object.keys(seed).length && api.archiveSave) api.archiveSave(seed);
    }
  } catch (e) {}

  // 2) Wrap setItem/removeItem: a sb-key change schedules a debounced (~800ms) save.
  var t = null, dirty = false;
  // 存档保存失败必须提示（旧版静默→用户改的预测可能一直没落盘却毫无察觉）。
  // archiveSave 返回 Promise({ok,error})；同步抛错或异步 ok=false 都算失败。
  var onSaveFail = function (detail) {
    try { if (typeof toast === 'function') toast('存档保存失败：' + detail, 'err'); } catch (_) {}
    try { api.log && api.log('archiveSave failed: ' + detail); } catch (_) {}
  };
  var flush = function () {
    dirty = false;
    try {
      var r = api.archiveSave && api.archiveSave(collect());
      if (r && typeof r.then === 'function') r.then(function (res) { if (res && res.ok === false) onSaveFail(res.error || '未知错误'); }, function (e) { onSaveFail(e && e.message || e); });
    } catch (e) { onSaveFail(e && e.message || e); }
  };
  var sched = function () { dirty = true; clearTimeout(t); t = setTimeout(flush, 800); };
  localStorage.setItem = function (k, v) { _set(k, v); if (isKey(k)) sched(); };
  localStorage.removeItem = function (k) { _rm(k); if (isKey(k)) sched(); };
  window.addEventListener('beforeunload', function () {
    if (dirty) { try { api.archiveSaveSync && api.archiveSaveSync(collect()); } catch (e) {} }
  });

  // 3) UI interface.
  window.Archive = {
    info: function () { return api.archiveInfo && api.archiveInfo(); },
    changeDir: async function () {
      var d = await api.pickArchiveDir();
      if (!d) return null;
      return await api.archiveSetDir(d);
    },
    exportAs: function () { return api.archiveExportAs(); },
    importFile: async function () {
      var r = await api.archiveImport();
      if (r && r.data) {
        // Clean replace: drop every existing sb.* key (native _rm, no save-storm),
        // then write the imported keys (native _set). Non-sb keys (e.g. theme) untouched.
        var stale = [];
        for (var i = 0; i < localStorage.length; i++) {
          var k = localStorage.key(i);
          if (isKey(k)) stale.push(k);
        }
        stale.forEach(function (k) { try { _rm(k); } catch (e) {} });
        Object.keys(r.data).forEach(function (k) { try { _set(k, r.data[k]); } catch (e) {} });
        // Let the caller's toast show briefly, then full-reload so every view reflects the import.
        setTimeout(function () { location.reload(); }, 600);
      }
      return r;
    },
    // 读取某历史版本存档的 data → 清当前 sb.* 后写入，并存到当前版本文件（可再切回）。
    applyData: function (data) {
      var stale = [];
      for (var i = 0; i < localStorage.length; i++) { var k = localStorage.key(i); if (isKey(k)) stale.push(k); }
      stale.forEach(function (k) { try { _rm(k); } catch (e) {} });
      Object.keys(data || {}).forEach(function (k) { try { _set(k, data[k]); } catch (e) {} });
      try {
        var r = api.archiveSave && api.archiveSave(collect());
        if (r && typeof r.then === 'function') r.then(function (res) { if (res && res.ok === false) onSaveFail(res.error || '未知错误'); }, function (e) { onSaveFail(e && e.message || e); });
      } catch (e) { onSaveFail(e && e.message || e); }
    },
    openFolder: function () { return api.archiveOpenFolder(); }
  };
})();

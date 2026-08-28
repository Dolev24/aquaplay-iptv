/* cache.js — IndexedDB blob cache so a 20k-channel playlist doesn't have to be
   re-downloaded and re-parsed on every cold start. Degrades to a no-op. */
(function (w) {
  'use strict';

  /* Named before the app was, and kept: see the note in store.js. */
  var DB = 'nova', STORE = 'blobs', VER = 1;
  var dbp = null;

  function open() {
    if (dbp) return dbp;
    dbp = new Promise(function (resolve) {
      var idb = w.indexedDB || w.webkitIndexedDB;
      if (!idb) { resolve(null); return; }
      var req;
      try { req = idb.open(DB, VER); } catch (e) { resolve(null); return; }
      req.onupgradeneeded = function () {
        var db = req.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'k' });
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { resolve(null); };
      req.onblocked = function () { resolve(null); };
    });
    return dbp;
  }

  function tx(mode) {
    return open().then(function (db) {
      if (!db) return null;
      try { return db.transaction(STORE, mode).objectStore(STORE); }
      catch (e) { return null; }
    });
  }

  var C = {};

  /* get(key, maxAgeMs) -> value | null */
  C.get = function (key, maxAge) {
    return tx('readonly').then(function (st) {
      if (!st) return null;
      return new Promise(function (resolve) {
        var r = st.get(key);
        r.onsuccess = function () {
          var rec = r.result;
          if (!rec) { resolve(null); return; }
          if (maxAge && (Date.now() - rec.t) > maxAge) { resolve(null); return; }
          resolve(rec.v);
        };
        r.onerror = function () { resolve(null); };
      });
    }).catch(function () { return null; });
  };

  C.set = function (key, value) {
    return tx('readwrite').then(function (st) {
      if (!st) return false;
      return new Promise(function (resolve) {
        var r;
        try { r = st.put({ k: key, t: Date.now(), v: value }); }
        catch (e) { resolve(false); return; }
        r.onsuccess = function () { resolve(true); };
        r.onerror = function () { resolve(false); };
      });
    }).catch(function () { return false; });
  };

  C.del = function (key) {
    return tx('readwrite').then(function (st) {
      if (!st) return false;
      return new Promise(function (resolve) {
        var r = st.delete(key);
        r.onsuccess = function () { resolve(true); };
        r.onerror = function () { resolve(false); };
      });
    }).catch(function () { return false; });
  };

  C.clearProfile = function (pid) {
    return Promise.all([ C.del('ch:' + pid), C.del('ch2:' + pid), C.del('gr:' + pid), C.del('epg:' + pid), C.del('epg2:' + pid),
                         C.del('vod:' + pid), C.del('sr:' + pid) ]);
  };

  w.Cache = C;
})(window);

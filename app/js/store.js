/* store.js — persistent app state in localStorage.
   Deliberately small: the channel list itself never goes here (5MB cap),
   it lives in IndexedDB via cache.js. */
(function (w) {
  'use strict';

  /* The app was called Nova until 0.7.1. This key is deliberately not
     renamed with it: it holds the playlist, favourites, channel numbers and
     every setting, and a new key would silently look like a fresh install. */
  var KEY = 'nova.state.v1';

  var DEFAULTS = {
    profiles: [],          // [{id,type:'xtream'|'m3u',name,host,user,pass,url,epgUrl}]
    activeProfile: null,   // profile id
    favorites: {},         // { profileId: { channelKey: 1 } }
    recent: {},            // { profileId: [channelKey, ...] max 20 }
    lastChannel: {},       // { profileId: channelKey }
    numbers: {},           // { profileId: { channelKey: number } } — user overrides
    locked: {},            // { profileId: { channelKey: 1 } } — hidden behind the PIN
    reminders: {},         // { profileId: [{ chKey, chName, start, stop, title }] }
    settings: {
      epg: true,           // load EPG
      epgHours: 8,         // how far ahead to keep programmes (no Settings row)
      catchupHours: 168,   // how far back, for replaying what already aired (7 days)
      hideEmptyGroups: true,
      startupPlayLast: true,
      sortBy: 'provider',  // provider | number
      pictureSize: 'fill', // fit | fill | stretch
      epgOffset: 0,        // hours to shift the guide by, for wrong-timezone XMLTV
      clock24: true,       // 24-hour or am/pm
      autoReconnect: true, // retry a dropped stream instead of just failing
      hlsEngine: 'auto',   // auto | hlsjs | native   (browser only)
      theme: 'dark',       // dark | light
      arrowZap: true,      // up/down change channel in fullscreen
      altRows: true,       // shade every other row of the channel list
      startGroup: 'all',   // all | fav | recent
      parental: false,     // hide adult channels behind a PIN
      pin: '',             // 4 digits; empty means parental control cannot be on
      streamFormat: 'auto',// auto | ts | m3u8   (xtream only)
      bufferSize: 'auto',  // auto | small | large
      osdSeconds: 8
    }
  };

  var state = null;

  function load() {
    var raw = null;
    try { raw = w.localStorage.getItem(KEY); } catch (e) {}
    var parsed = null;
    if (raw) { try { parsed = JSON.parse(raw); } catch (e) { parsed = null; } }
    state = merge(clone(DEFAULTS), parsed || {});
    /* "Original" pinned the picture to its coded size on both players, so a
       720p channel never filled a 1080p screen. It is gone, and anything still
       holding it lands on the default rather than on a mode nobody chose. */
    if (state.settings && state.settings.pictureSize === 'original') {
      state.settings.pictureSize = 'fill';
    }
    return state;
  }

  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  function merge(base, over) {
    for (var k in over) {
      if (!Object.prototype.hasOwnProperty.call(over, k)) continue;
      var v = over[k];
      if (v && typeof v === 'object' && !(v instanceof Array) &&
          base[k] && typeof base[k] === 'object' && !(base[k] instanceof Array)) {
        merge(base[k], v);
      } else {
        base[k] = v;
      }
    }
    return base;
  }

  var saveTimer = null;
  function save() {
    if (saveTimer) return;
    saveTimer = setTimeout(function () {
      saveTimer = null;
      try { w.localStorage.setItem(KEY, JSON.stringify(state)); }
      catch (e) { U.log('store save failed', e); }
    }, 250);
  }

  var S = {};

  S.init = function () { load(); return state; };
  S.all = function () { return state; };
  S.settings = function () { return state.settings; };
  S.set = function (path, value) {
    var parts = path.split('.'), o = state;
    for (var i = 0; i < parts.length - 1; i++) {
      if (!o[parts[i]]) o[parts[i]] = {};
      o = o[parts[i]];
    }
    o[parts[parts.length - 1]] = value;
    save();
  };

  /* ---------- profiles ---------- */
  S.profiles = function () { return state.profiles; };

  S.addProfile = function (p) {
    p.id = 'p' + Date.now().toString(36) + Math.floor(Math.random() * 1000);
    state.profiles.push(p);
    state.activeProfile = p.id;
    save();
    return p;
  };

  S.removeProfile = function (id) {
    state.profiles = state.profiles.filter(function (p) { return p.id !== id; });
    delete state.favorites[id];
    delete state.recent[id];
    delete state.lastChannel[id];
    delete state.numbers[id];
    delete state.locked[id];
    delete state.reminders[id];
    if (state.activeProfile === id) {
      state.activeProfile = state.profiles.length ? state.profiles[0].id : null;
    }
    save();
  };

  S.activeProfile = function () {
    if (!state.activeProfile) return null;
    var found = null;
    state.profiles.forEach(function (p) { if (p.id === state.activeProfile) found = p; });
    return found;
  };

  S.setActiveProfile = function (id) { state.activeProfile = id; save(); };

  /* ---------- favourites ---------- */
  function favMap(pid) {
    if (!state.favorites[pid]) state.favorites[pid] = {};
    return state.favorites[pid];
  }
  S.isFav = function (pid, key) { return !!favMap(pid)[key]; };
  S.toggleFav = function (pid, key) {
    var m = favMap(pid);
    if (m[key]) { delete m[key]; save(); return false; }
    m[key] = 1; save(); return true;
  };
  S.favKeys = function (pid) { return Object.keys(favMap(pid)); };

  /* ---------- channel numbers ----------
     A user-assigned number overrides whatever the playlist said, so the dial
     can be rearranged without editing the M3U. Keyed by channel, per profile. */
  function numMap(pid) {
    if (!state.numbers[pid]) state.numbers[pid] = {};
    return state.numbers[pid];
  }
  S.channelNumber = function (pid, key) {
    var n = numMap(pid)[key];
    return (typeof n === 'number' && n > 0) ? n : null;
  };
  S.setChannelNumber = function (pid, key, n) {
    var m = numMap(pid);
    if (!n || n < 1) delete m[key]; else m[key] = Math.floor(n);
    save();
  };
  /* Which channel currently owns a number, ignoring one key. */
  S.keyWithNumber = function (pid, n, exceptKey) {
    var m = numMap(pid);
    for (var k in m) {
      if (!Object.prototype.hasOwnProperty.call(m, k)) continue;
      if (k !== exceptKey && m[k] === n) return k;
    }
    return null;
  };
  S.clearNumbers = function (pid) { state.numbers[pid] = {}; save(); };

  /* ---------- per-channel locks ----------
     Separate from the adult heuristic. `settings.parental` turns on a guess
     about what is adult; these are channels somebody picked by hand, so they
     hold whenever there is a PIN to unlock them with, whether that guess is
     switched on or not. Keyed like favourites, by U.slug, and they outlive a
     restart — the session unlock does not. */
  function lockMap(pid) {
    if (!state.locked[pid]) state.locked[pid] = {};
    return state.locked[pid];
  }
  S.isLocked = function (pid, key) { return !!lockMap(pid)[key]; };
  S.setLocked = function (pid, key, on) {
    var m = lockMap(pid);
    if (on) m[key] = 1; else delete m[key];
    save();
    return !!on;
  };
  S.lockedKeys = function (pid) { return Object.keys(lockMap(pid)); };
  S.hasLocks = function (pid) { return S.lockedKeys(pid).length > 0; };
  /* Without a PIN a lock is not a lock: there would be no way back through it,
     so it would only be a way to lose a channel. */
  S.lockActive = function () { return !!state.settings.pin; };

  /* ---------- reminders ----------
     Set on a programme that has not started yet, from the guide panel. A
     reminder is identified by the channel and the start time rather than by
     anything the guide provides: a re-read of the XMLTV rebuilds every
     programme object, so an id would not survive the next refresh.

     They are checked against the clock, so one that was missed — the TV was
     off, the app was closed — is dropped rather than firing hours late. */
  var REMIND_GRACE = 5 * 60000;

  function remList(pid) {
    if (!state.reminders[pid]) state.reminders[pid] = [];
    return state.reminders[pid];
  }
  S.reminders = function (pid) { return remList(pid).slice(); };
  S.hasReminder = function (pid, chKey, start) {
    var l = remList(pid);
    for (var i = 0; i < l.length; i++) {
      if (l[i].chKey === chKey && l[i].start === start) return true;
    }
    return false;
  };
  S.setReminder = function (pid, r) {
    if (S.hasReminder(pid, r.chKey, r.start)) return false;
    remList(pid).push(r);
    save();
    return true;
  };
  S.clearReminder = function (pid, chKey, start) {
    state.reminders[pid] = remList(pid).filter(function (r) {
      return !(r.chKey === chKey && r.start === start);
    });
    save();
  };
  /* Everything that has started within the grace window, with anything older
     dropped on the way past: a reminder for a programme that began an hour ago
     is not a reminder any more, it is an interruption. */
  S.dueReminders = function (pid, now) {
    var due = [], keep = [], changed = false;
    remList(pid).forEach(function (r) {
      if (now < r.start) { keep.push(r); return; }
      if (now < r.start + REMIND_GRACE) { keep.push(r); due.push(r); return; }
      changed = true;                       // too late to be worth saying
    });
    if (changed) { state.reminders[pid] = keep; save(); }
    return due;
  };

  /* ---------- parental ----------
     Unlocking lasts for the session only: closing the app re-locks. */
  var unlocked = false;
  /* Two different questions. sessionUnlocked is "has the PIN been entered",
     which is what a hand-picked lock turns on. isUnlocked folds in the adult
     filter being off at all, which is what the adult heuristic asks. */
  S.sessionUnlocked = function () { return unlocked; };
  S.isUnlocked = function () { return unlocked || !S.parentalActive(); };
  S.unlock = function (pin) {
    if (!state.settings.pin || String(pin) !== String(state.settings.pin)) return false;
    unlocked = true;
    return true;
  };
  S.relock = function () { unlocked = false; };
  S.parentalActive = function () {
    return !!(state.settings.parental && state.settings.pin);
  };

  /* Verify without opening anything. Locking a channel has to prove who is
     asking, but it must not unlock the session on the way — that is what made
     a freshly locked channel play without a word when you went back to it. */
  S.checkPin = function (pin) {
    return !!state.settings.pin && String(pin) === String(state.settings.pin);
  };

  /* Two different answers, and they are not the same question.

     isHiddenChannel is the adult filter: a guess about a name or a group,
     which hides matching channels outright — a visible-but-locked row in a
     category a child should not know about still tells them it is there.

     needsPin is a channel somebody locked by hand. That one stays in the list
     wearing a padlock and asks for the PIN when somebody tries to watch it,
     which is the point: the lock is meant to be seen and to say no. */
  S.isHiddenChannel = function (pid, ch) {
    if (!ch || unlocked) return false;
    return S.parentalActive() && !!(w.U && w.U.isAdult(ch));
  };

  S.needsPin = function (pid, ch) {
    if (!ch || unlocked) return false;
    return S.lockActive() && S.isLocked(pid, ch.key);
  };

  /* ---------- recents / resume ---------- */
  S.pushRecent = function (pid, key) {
    if (!state.recent[pid]) state.recent[pid] = [];
    var arr = state.recent[pid].filter(function (k) { return k !== key; });
    arr.unshift(key);
    state.recent[pid] = arr.slice(0, 20);
    state.lastChannel[pid] = key;
    save();
  };
  S.recent = function (pid) { return state.recent[pid] || []; };
  S.lastChannel = function (pid) { return state.lastChannel[pid] || null; };

  w.Store = S;
})(window);

/* util.js — tiny helpers. ES2015 only (no ?., no object spread, no ??). */
(function (w) {
  'use strict';

  var U = {};

  U.$  = function (id) { return document.getElementById(id); };
  U.qs = function (sel, root) { return (root || document).querySelector(sel); };

  U.isTizen = (function () {
    try { return !!(w.webapis && w.webapis.avplay); } catch (e) { return false; }
  })();

  U.log = function () {
    if (!U.DEBUG) return;
    try { console.log.apply(console, arguments); } catch (e) {}
  };
  U.DEBUG = true;

  U.esc = function (s) {
    if (s == null) return '';
    return String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  };

  U.clamp = function (n, lo, hi) { return n < lo ? lo : (n > hi ? hi : n); };

  U.pad2 = function (n) { return (n < 10 ? '0' : '') + n; };

  /* A length of time, not a time of day: 1:04:12, or 4:12 under the hour.
     Formatting a duration through a Date would drag the timezone into it. */
  U.hms = function (ms) {
    var t = Math.max(0, Math.round(ms / 1000));
    var h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), sec = t % 60;
    return (h ? h + ':' + U.pad2(m) : String(m)) + ':' + U.pad2(sec);
  };

  /* Store loads after this file, so read it lazily and default to 24-hour. */
  function clock24() {
    try { return !w.Store || w.Store.settings().clock24 !== false; }
    catch (e) { return true; }
  }

  function ampm(h) { return h < 12 ? 'am' : 'pm'; }
  function h12(h) { var x = h % 12; return x === 0 ? 12 : x; }

  /* Local wall-clock HH:MM */
  U.hhmm = function (date) {
    if (!date) return '';
    var h = date.getHours(), m = date.getMinutes();
    if (clock24()) return U.pad2(h) + ':' + U.pad2(m);
    return h12(h) + ':' + U.pad2(m) + ampm(h);
  };

  /* With seconds. Timeshift steps are 30s, so without them a single step can
     leave the readout unchanged and look like nothing happened. */
  U.hhmmss = function (date) {
    if (!date) return '';
    var h = date.getHours(), m = date.getMinutes(), sec = date.getSeconds();
    if (clock24()) return U.pad2(h) + ':' + U.pad2(m) + ':' + U.pad2(sec);
    return h12(h) + ':' + U.pad2(m) + ':' + U.pad2(sec) + ampm(h);
  };

  U.debounce = function (fn, ms) {
    var t = null;
    return function () {
      var args = arguments, self = this;
      if (t) clearTimeout(t);
      t = setTimeout(function () { t = null; fn.apply(self, args); }, ms);
    };
  };

  /* Yield to the browser so long loops never freeze the TV UI. */
  U.nextTick = function (fn) { setTimeout(fn, 0); };

  /* ---------- overlays ---------- */
  var toastTimer = null;
  U.toast = function (msg, ms) {
    var t = U.$('toast');
    if (!t) return;
    t.textContent = msg;
    t.classList.remove('hidden');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.add('hidden'); }, ms || 2600);
  };

  U.loader = function (show, text) {
    var l = U.$('loader');
    if (!l) return;
    if (show) {
      U.$('loader-text').textContent = text || 'Loading';
      U.$('loader-progress').classList.add('hidden');
      U.$('loader-progress-fill').style.width = '0%';
      l.classList.remove('hidden');
    } else {
      l.classList.add('hidden');
    }
  };

  U.loaderProgress = function (pct, text) {
    var p = U.$('loader-progress');
    if (!p) return;
    p.classList.remove('hidden');
    U.$('loader-progress-fill').style.width = U.clamp(pct, 0, 100) + '%';
    if (text) U.$('loader-text').textContent = text;
  };

  /* Confirm dialog. cb(true|false). Owns key input while open. */
  U.confirmOpen = false;
  var confirmCb = null, confirmSel = 1;
  /* opts.yes / opts.no rename the buttons. A reminder firing is not a yes/no
     question — it is "go to channel" or "close" — and the dialog machinery is
     the same either way, so it takes labels rather than being copied. */
  U.confirm = function (text, cb, opts) {
    confirmCb = cb; confirmSel = 1;
    U.$('confirm-text').textContent = text;
    U.$('confirm-yes').textContent = (opts && opts.yes) || 'Yes';
    U.$('confirm-no').textContent = (opts && opts.no) || 'No';
    U.$('confirm').classList.remove('hidden');
    U.confirmOpen = true;
    paintConfirm();
  };
  function paintConfirm() {
    U.$('confirm-no').classList.toggle('focused', confirmSel === 0);
    U.$('confirm-yes').classList.toggle('focused', confirmSel === 1);
  }
  U.confirmKey = function (action) {
    if (action === 'left' || action === 'right') {
      confirmSel = confirmSel ? 0 : 1; paintConfirm(); return true;
    }
    if (action === 'ok') { closeConfirm(confirmSel === 1); return true; }
    if (action === 'back') { closeConfirm(false); return true; }
    return true;
  };
  function closeConfirm(result) {
    U.$('confirm').classList.add('hidden');
    U.confirmOpen = false;
    var cb = confirmCb; confirmCb = null;
    if (cb) cb(result);
  }

  /* Keyboard reference for desktop testing. The TV remote has these as real
     buttons, so this is never shown on Tizen. */
  U.helpOpen = false;

  var HELP_ROWS = [
    ['Move around',        'Arrow keys'],
    ['Play / select',      'Enter'],
    ['Fullscreen',         'Enter again on the channel playing'],
    ['Full screen, anywhere', 'P - whatever is playing, wherever the cursor is'],
    ['Back',               'Esc'],
    ['Channel +/-',        'Page Up / Page Down'],
    ['Favourite',          'R', 'red'],
    ['Search',             'G', 'green'],
    ['Reload the playlist','B', 'blue'],
    ['Settings',           'Y', 'yellow'],
    ["What's on",          'I — and Enter there sets a reminder'],
    ['Channel menu',       'Right from the list'],
    ['Catch-up browser',   'E'],
    ['Menu',              'Left from the groups rail'],
    ['Rewind / forward',   'Left / Right in fullscreen'],
    ['Jump 5 minutes',     'J / L'],
    ['Replay a programme', 'Enter on one marked in the guide'],
    ['Jump to a channel',  '0 - 9'],
    ['This list',          'H']
  ];

  var helpBound = false;

  U.help = function () {
    if (!helpBound) {
      helpBound = true;
      U.$('keyhelp').addEventListener('click', function () { U.helpClose(); }, false);
    }
    var html = '';
    for (var i = 0; i < HELP_ROWS.length; i++) {
      var r = HELP_ROWS[i];
      html += '<div class="kh-row">' +
              '<span class="kh-what">' +
                (r[2] ? '<i class="k k-' + r[2] + '"></i>' : '') + U.esc(r[0]) +
              '</span>' +
              '<span class="kh-key">' + U.esc(r[1]) + '</span></div>';
    }
    U.$('kh-grid').innerHTML = html;
    U.$('keyhelp').classList.remove('hidden');
    U.helpOpen = true;
  };

  U.helpClose = function () {
    U.$('keyhelp').classList.add('hidden');
    U.helpOpen = false;
    return true;
  };

  /* Numeric entry. Digits type, Back deletes (and closes when empty), OK
     confirms. cb(number|null) — null means cancelled, 0 means "clear it". */
  U.numberOpen = false;
  var numCb = null, numBuf = '', numMax = 4, numRaw = false, numMask = false, numAuto = 0;

  /* Starts empty rather than pre-filled: on a remote, typing over an existing
     value means backspacing it out first, which is worse than just typing. */
  U.numberPrompt = function (title, sub, cb, opts) {
    numCb = cb;
    numRaw = !!(opts && opts.raw);
    numMask = !!(opts && opts.mask);
    numAuto = (opts && opts.auto) || 0;   // digits after which it submits itself
    numBuf = '';
    U.$('num-title').textContent = title;
    U.$('num-sub').textContent = sub || '';
    U.$('number').classList.remove('hidden');
    U.numberOpen = true;
    paintNumber();
  };

  function paintNumber() {
    var shown = numBuf;
    // A PIN is typed in front of whoever it is meant to keep out.
    if (numMask && numBuf) shown = new Array(numBuf.length + 1).join('\u2022');
    U.$('num-value').textContent = shown;   // the empty state is drawn, not typed
    // Not 'empty': that is the app's placeholder class, and it is positioned.
    U.$('num-value').classList.toggle('num-empty', !numBuf);
  }

  U.numberKey = function (e) {
    var a = e.action;
    if (a === 'digit') {
      if (numBuf.length < numMax) { numBuf += String(e.digit); paintNumber(); }
      /* A four-digit PIN is finished the moment the fourth digit lands, so
         asking for OK as well is a keypress that can only mean "yes, those
         four". Off by default: a channel number has no known length. */
      if (numAuto && numBuf.length >= numAuto) {
        closeNumber(numRaw ? numBuf : parseInt(numBuf, 10));
      }
      return true;
    }
    if (a === 'back') {
      if (numBuf) { numBuf = numBuf.slice(0, -1); paintNumber(); return true; }
      closeNumber(null);
      return true;
    }
    if (a === 'ok') {
      // A PIN keeps its leading zeros, so raw mode hands back the string.
      closeNumber(numRaw ? numBuf : (numBuf ? parseInt(numBuf, 10) : 0));
      return true;
    }
    if (a === 'red')   { closeNumber(0); return true; }   // clear the override
    if (a === 'exit')  { closeNumber(null); return true; }
    return true;
  };

  function closeNumber(result) {
    U.$('number').classList.add('hidden');
    U.numberOpen = false;
    var cb = numCb; numCb = null; numBuf = '';
    numRaw = false; numMask = false;
    if (cb) cb(result);
  }

  /* ---------- misc ---------- */

  /* Stable identity for a channel. Also generates channel keys, so changing
     it would orphan saved favourites and numbers — leave it alone. */
  U.slug = function (s) {
    return String(s || '')
      .toLowerCase()
      .replace(/\(.*?\)/g, ' ')
      .replace(/\b(hd|fhd|uhd|4k|sd|hevc|h265|raw|backup|vip)\b/g, ' ')
      .replace(/[^a-z0-9]+/g, '');
  };

  /* Key for fuzzy channel <-> guide matching.

     Separate from U.slug for two reasons. U.slug whitelists a-z0-9, which
     deletes Cyrillic, Hebrew, Greek and Arabic outright: "9 Канал HD" becomes
     just "9". That both loses real matches and invents false ones, because a
     guide entry whose display-name also reduces to "9" would look identical.
     So: strip punctuation rather than whitelisting letters, and refuse to
     fuzzy-match on anything under three characters. Exact tvg-id matching is
     unaffected and still takes priority.

     No \p{L} — that needs Chrome 64 and the TV baseline is 56. */
  U.matchKey = function (s) {
    var t = String(s || '')
      .toLowerCase()
      .replace(/\(.*?\)/g, ' ')
      .replace(/\[.*?\]/g, ' ')
      .replace(/\b(hd|fhd|uhd|4k|sd|hevc|h265|raw|backup|vip)\b/g, ' ')
      .replace(/[\s\-_.,:;/\\()[\]{}'"!?&+*#@|~`^%$]+/g, '');
    return t.length < 3 ? '' : t;
  };

  /* Case/diacritic-insensitive-ish search key */
  U.searchKey = function (s) {
    return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  };

  /* Providers label adult content in the group or the name, with no standard
     for it. These are the spellings that actually turn up. */
  var ADULT_RE = /(^|[^a-z])(adult|adults|xxx|porn|erotic|erotik|18\+|21\+|hot\s*tv|playboy|brazzers|hustler|penthouse|private\s*tv|dorcel|sexy?)([^a-z]|$)/i;

  U.isAdult = function (ch) {
    if (!ch) return false;
    return ADULT_RE.test(String(ch.group || '')) || ADULT_RE.test(String(ch.name || ''));
  };

  U.applyTheme = function () {
    var t = 'dark';
    try { t = (w.Store && Store.settings().theme) || 'dark'; } catch (e) {}
    document.documentElement.classList.toggle('light', t === 'light');
  };

  U.b64 = function (s) {
    if (!s) return '';
    try { return decodeURIComponent(escape(w.atob(s))); }
    catch (e) { try { return w.atob(s); } catch (e2) { return s; } }
  };

  w.U = U;
})(window);

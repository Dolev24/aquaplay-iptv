/* util.js — tiny helpers. ES2015 only (no ?., no object spread, no ??). */
(function (w) {
  'use strict';

  var U = {};

  U.$  = function (id) { return document.getElementById(id); };
  U.qs = function (sel, root) { return (root || document).querySelector(sel); };

  /* Which of the three the app is running on.

      `isTizen` used to carry two meanings at once — "this is a Samsung set"
      and "there is a real player behind the page rather than a <video> in
      it". The second is what nearly every use of it wanted, and it is now
      true of Android TV as well, so it has a name of its own: `isTV`. Read
      the difference as "who is it" against "what can it do".

      The Android shell injects AquaPlayNative before the first script runs,
      so this is decided by the time anything asks. */
  U.isTizen = (function () {
    try { return !!(w.webapis && w.webapis.avplay); } catch (e) { return false; }
  })();

  U.isAndroid = (function () {
    try { return !!(w.AquaPlayNative && w.AquaPlayNative.shellVersion); }
    catch (e) { return false; }
  })();

  U.isTV = U.isTizen || U.isAndroid;
  U.platform = U.isTizen ? 'tizen' : (U.isAndroid ? 'android' : 'browser');

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
  /* Six ways to write a date, because nobody agrees and everybody is sure.
     Not read off the locale: that would be guessing at the viewer from the
     language their television happens to be set to, and a Brit with an
     American set would get the wrong one with nowhere to say so.

     The day and month names go through the translator; the numeric forms do
     not, because a slash is a slash in every language. */
  U.DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday',
                 'Friday', 'Saturday'];
  U.MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                   'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  U.dateLabel = function (d, fmt) {
    var day = d.getDate(), mon = d.getMonth() + 1, yr = d.getFullYear();
    var p2 = function (n) { return (n < 10 ? '0' : '') + n; };
    if (fmt === 'off')   return '';
    if (fmt === 'short') return day + ' ' + T(U.MONTH_NAMES[d.getMonth()]);
    if (fmt === 'dmy')   return p2(day) + '/' + p2(mon) + '/' + yr;
    if (fmt === 'mdy')   return p2(mon) + '/' + p2(day) + '/' + yr;
    if (fmt === 'iso')   return yr + '-' + p2(mon) + '-' + p2(day);
    return T(U.DAY_NAMES[d.getDay()]) + '  ' + day + ' ' + T(U.MONTH_NAMES[d.getMonth()]);
  };

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
      U.$('loader-text').textContent = text || T('Loading');
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
    /* Starting on No. Every question asked through here is one where yes
       costs something — leaving the app, forgetting a playlist, putting the
       settings back — and the safe answer should be the one already under the
       cursor. */
    confirmCb = cb; confirmSel = 0;
    U.$('confirm-text').textContent = text;
    /* A logo and a description, for the caller that has them. Hidden rather
       than emptied: an empty element still takes its margins with it. */
    var logo = U.$('confirm-logo'), desc = U.$('confirm-desc');
    var src = opts && opts.logo;
    logo.style.backgroundImage = src ? 'url("' + src + '")' : 'none';
    logo.classList.toggle('hidden', !src);
    desc.textContent = (opts && opts.desc) || '';
    desc.classList.toggle('hidden', !(opts && opts.desc));
    U.$('confirm-yes').textContent = (opts && opts.yes) || T('Yes');
    /* An empty "no" means there is nothing to decline: About and its like are
       notices, and a notice with two buttons asks a question it does not
       have. The cursor goes to the only answer there is. */
    var noText = (opts && opts.no === '') ? '' : ((opts && opts.no) || T('No'));
    U.$('confirm-no').textContent = noText;
    U.$('confirm-no').classList.toggle('hidden', noText === '');
    if (noText === '') confirmSel = 1;
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
    ['Favorite',          'R', 'red'],
    ['Search',             'G', 'green'],
    ['Reload the playlist','B', 'blue'],
    ['Settings',           'Y', 'yellow'],
    ['Schedule',            'I — and Enter there sets a reminder'],
    ['Channel menu',       'Right from the list'],
    ['Catch-up browser',   'E'],
    ['Menu',              'Left from the groups rail'],
    ['Rewind / forward',   'Left / Right in fullscreen'],
    ['Jump 5 minutes',     'J / L'],
    ['Replay a program', 'Enter on one marked in the guide'],
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
                (r[2] ? '<i class="k k-' + r[2] + '"></i>' : '') + U.esc(T(r[0])) +
              '</span>' +
              '<span class="kh-key">' + U.esc(T(r[1])) + '</span></div>';
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

  /* ---------------- pick one of a list ----------------

     For a setting with more answers than anybody wants to press through. The
     language row is the reason it exists: ten of them, cycled one key at a
     time, and overshooting means eight more presses in a language you may not
     be able to read any more.

     Keyed like the other overlays — keys.js checks U.pickOpen before it hands
     anything to a view — so nothing underneath has to know it is up. */
  /* How much list there is, and where in it you are.

     Called by anything that scrolls a long child inside a short box by moving
     it. Percentages of the content, so the track does not care how tall it is
     itself. The box is marked 'scrolls' only when there is more than a row's
     worth hidden — a thumb that fills its track says nothing. */
  U.vtrack = function (box, thumb, total, view, top) {
    if (!box || !thumb) return;
    var more = total > view + 1;
    box.classList.toggle('scrolls', more);
    if (!more) return;
    var frac = view / total;
    thumb.style.height = Math.max(10, frac * 100) + '%';
    thumb.style.top = U.clamp((top / total) * 100, 0, Math.max(0, 100 - frac * 100)) + '%';
  };

  U.pickOpen = false;
  var pickCb = null, pickItems = [], pickIdx = 0, pickCurrent = null;
  var PICK_H = 78;

  U.pick = function (title, items, current, cb) {
    pickCb = cb;
    pickCurrent = current;
    pickItems = items || [];
    pickIdx = 0;
    for (var i = 0; i < pickItems.length; i++) {
      if (pickItems[i].value === current) { pickIdx = i; break; }
    }
    U.$('picker-title').textContent = title;
    var html = '';
    for (var j = 0; j < pickItems.length; j++) {
      var it = pickItems[j];
      /* `current` gets a tick, and an item can ask to be set apart from the
         list it is at the bottom of — "add another" is not one of the things
         being chosen between. */
      html += '<div class="picker-row' +
                (it.value === current ? ' current' : '') +
                (it.apart ? ' apart' : '') + '">' +
                U.esc(it.label) +
                (it.value === current ? '<i class="picker-tick"></i>' : '') +
              '</div>';
    }
    U.$('picker-list').innerHTML = html;
    U.$('picker').classList.remove('hidden');
    U.pickOpen = true;
    paintPick();
  };

  function paintPick() {
    var current = pickCurrent;
    var kids = U.$('picker-list').children;
    for (var i = 0; i < kids.length; i++) {
      kids[i].className = 'picker-row' + (i === pickIdx ? ' focused' : '');
    }
    /* Keep the cursor in view without a scrollbar: the list is moved, the box
       stays. Same trick as every other list in the app. */
    var box = U.$('picker-scroll');
    var h = (box && box.clientHeight) || 600;
    var top = Math.max(0, (pickIdx + 1) * PICK_H - h);
    if (pickIdx * PICK_H < top) top = pickIdx * PICK_H;
    U.$('picker-list').style.transform = 'translateY(' + (-top) + 'px)';
    U.vtrack(box, U.$('pick-thumb'), pickItems.length * PICK_H, h, top);
  }

  U.pickKey = function (e) {
    var a = e.action;
    if (a === 'up')   { pickIdx = U.clamp(pickIdx - 1, 0, pickItems.length - 1); paintPick(); return true; }
    if (a === 'down') { pickIdx = U.clamp(pickIdx + 1, 0, pickItems.length - 1); paintPick(); return true; }
    if (a === 'ok')   { closePick(pickItems[pickIdx] ? pickItems[pickIdx].value : null); return true; }
    if (a === 'back' || a === 'exit' || a === 'left') { closePick(null); return true; }
    return true;
  };

  function closePick(value) {
    U.$('picker').classList.add('hidden');
    U.pickOpen = false;
    var cb = pickCb; pickCb = null; pickItems = [];
    if (cb) cb(value);
  }

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
  /* Punctuation out, everything else kept.

     This used to keep [a-z0-9] and drop the rest, which meant a Hebrew or
     Russian or Japanese title became an empty string and could not be
     searched for — nor could anything typed in those alphabets, since the
     query went through the same mill. Channel names are Latin on most
     playlists even when nothing else is, so it took searching programmes to
     notice. Chromium 56 has no \p{L} to ask "is this a letter", hence a
     list of what to remove rather than a list of what to keep. */
  var PUNCT = /[\s\-_.,:;!?'"()\[\]{}\/\\|+*&^%$#@~`<>=\u2010-\u2027\u2030-\u205e]+/g;
  U.searchKey = function (s) {
    return String(s || '').toLowerCase().replace(PUNCT, ' ').trim();
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

/* views/setup.js — add / edit a playlist. */
(function (w) {
  'use strict';

  var S = {};
  var tab = 'xtream';
  var focusIdx = 0;
  var items = [];         // current focus ring (DOM elements)
  var editing = false;    // in a text field
  var cancelable = false;
  var busy = false;

  function ids(list) { return list.map(function (i) { return U.$(i); }); }

  function buildRing() {
    var base = [U.$('setup-tabs').children[0], U.$('setup-tabs').children[1]];
    var fields = tab === 'xtream'
      ? ids(['x-name', 'x-host', 'x-user', 'x-pass'])
      : ids(['m-name', 'm-url', 'm-epg']);
    items = base.concat(fields, [U.$('setup-connect')]);
    if (cancelable) items.push(U.$('setup-cancel'));
  }

  function paint() {
    for (var i = 0; i < items.length; i++) items[i].classList.toggle('focused', i === focusIdx);
    U.$('setup-tabs').children[0].classList.toggle('active', tab === 'xtream');
    U.$('setup-tabs').children[1].classList.toggle('active', tab === 'm3u');
    U.$('fields-xtream').classList.toggle('hidden', tab !== 'xtream');
    U.$('fields-m3u').classList.toggle('hidden', tab !== 'm3u');
    U.$('setup-cancel').classList.toggle('hidden', !cancelable);
  }

  function msg(text, ok) {
    var m = U.$('setup-msg');
    m.textContent = text || '';
    m.classList.toggle('ok', !!ok);
  }

  /* ---------------- mouse ----------------
     A TV never needs this, but a browser session does: without it the tabs and
     the Connect button look clickable and do nothing. Clicks are translated
     into the same focus-ring moves the remote makes, so there is one model. */

  var mouseBound = false;

  /* Walk up to whichever ring item was clicked. Fields are wrapped in a
     <label>, so a click on the caption has to resolve to its input. */
  function ringIndexOf(node) {
    while (node && node !== document) {
      var i = items.indexOf(node);
      if (i > -1) return i;
      if (node.tagName === 'LABEL') {
        var inp = node.querySelector('input');
        if (inp) { var j = items.indexOf(inp); if (j > -1) return j; }
      }
      node = node.parentNode;
    }
    return -1;
  }

  function bindMouse() {
    if (mouseBound) return;
    mouseBound = true;

    U.$('setup-tabs').addEventListener('click', function (ev) {
      var node = ev.target;
      while (node && node !== this && !node.classList.contains('tab')) node = node.parentNode;
      if (!node || node === this) return;
      stopEdit();
      setTab(node.getAttribute('data-tab'));
    }, false);

    U.$('setup-form').addEventListener('click', function (ev) {
      if (busy) return;
      var i = ringIndexOf(ev.target);
      if (i === -1) return;
      if (editing && items[focusIdx] !== items[i]) stopEdit();
      focusIdx = i;
      paint();
      var el = items[i];
      // Keep `editing` in step with real DOM focus, or keys.js would swallow
      // left/right for the text field while this module thought it was idle.
      if (el.tagName === 'INPUT') startEdit();
      else activate();
    }, false);
  }

  S.show = function (opts) {
    bindMouse();
    opts = opts || {};
    cancelable = !!opts.cancelable;
    tab = opts.tab || 'xtream';
    focusIdx = 0; editing = false; busy = false;
    U.$('setup-title').textContent = cancelable ? T('Add a playlist') : T('Add your playlist');
    msg('');
    buildRing(); paint();
    U.$('view-setup').classList.remove('hidden');
    U.$('view-main').classList.add('hidden');
    U.$('view-settings').classList.add('hidden');
  };

  S.hide = function () { U.$('view-setup').classList.add('hidden'); };

  function setTab(t) {
    if (tab === t) return;
    tab = t;
    buildRing();
    focusIdx = (t === 'xtream') ? 0 : 1;
    paint(); msg('');
  }

  /* On Android the shell has to be told, or the WebView opens the keyboard
     by itself and then leaves it up — owning the D-pad, so the next OK goes to
     the keyboard instead of to the button the cursor is on. */
  function tellShell(on) {
    if (!U.isAndroid) return;
    try { w.AquaPlayNative.setEditing(!!on); } catch (e) {}
  }

  /* And the shell tells us back. While a television's keyboard is up it has
     every key — the D-pad included — so the page cannot see the press that
     dismisses it and would stay in its editing state for ever, sending every
     later press to a keyboard that has gone. */
  w.AquaPlayShell = w.AquaPlayShell || {};
  w.AquaPlayShell.imeClosed = function () {
    if (!editing) return;
    editing = false;
    var el = items[focusIdx];
    if (el && el.blur) el.blur();
    paint();
  };

  /* Whatever the page is focused on, whether or not it is the field this
     module thinks it is. The keyboard follows the browser's idea of focus,
     not ours, so that is the one to clear. */
  function dropFocus(except) {
    var el = document.activeElement;
    if (el && el !== except && el.blur && el.tagName === 'INPUT') {
      try { el.blur(); } catch (e) {}
    }
  }

  function startEdit() {
    var el = items[focusIdx];
    if (!el || el.tagName !== 'INPUT') return false;
    /* Anything else editable lets go first. Focusing one field while the
       keyboard is already open on another does not always move the keyboard,
       and then the cursor is on one box and the typing is in another. */
    dropFocus(el);
    editing = true;
    el.focus();
    try { el.setSelectionRange(el.value.length, el.value.length); } catch (e) {}
    /* And the shell is asked for a keyboard only once that focus has landed —
       asking in the same turn opens it against whatever was focused before. */
    U.nextTick(function () { if (editing && items[focusIdx] === el) tellShell(true); });
    return true;
  }

  function stopEdit() {
    editing = false;
    var el = items[focusIdx];
    if (el && el.blur) el.blur();
    dropFocus(null);
    tellShell(false);
  }

  S.key = function (e) {
    if (busy) return;
    var a = e.action;

    if (editing) {
      if (a === 'ok' || a === 'down') { stopEdit(); if (a === 'down') move(1); return; }
      if (a === 'back') { stopEdit(); return; }
      if (a === 'up') { stopEdit(); move(-1); return; }
      return;
    }

    switch (a) {
      case 'up':    move(-1); break;
      case 'down':  move(1);  break;
      case 'left':
        if (focusIdx <= 1) setTab('xtream');
        break;
      case 'right':
        if (focusIdx <= 1) setTab('m3u');
        break;
      case 'ok':    activate(); break;
      case 'back':
        if (cancelable) App.closeSetup();
        else U.confirm(T('Exit AquaPlay?'), function (yes) { if (yes) Keys.exitApp(); });
        break;
      case 'exit':  Keys.exitApp(); break;
    }
  };

  function move(d) {
    /* Leaving a field behind with the browser still focused on it is what
       sends the next keystroke — or the next keyboard — to the wrong box. */
    dropFocus(null);
    // Items 0 and 1 are the two tabs — one logical row. Moving down off that
    // row must clear it entirely, or the "keep the current tab highlighted"
    // rule below would snap 0 -> 1 -> 0 and trap focus on the tabs.
    var next = (d > 0 && focusIdx <= 1) ? 2 : focusIdx + d;
    next = U.clamp(next, 0, items.length - 1);
    // Landing on a tab from below should keep the current tab highlighted.
    if (next <= 1) next = (tab === 'xtream') ? 0 : 1;
    focusIdx = next;
    paint();
    var el = items[focusIdx];
    if (el && el.scrollIntoView) { try { el.scrollIntoView(false); } catch (e) {} }
  }

  function activate() {
    var el = items[focusIdx];
    if (!el) return;
    /* Connect used to open a keyboard, because a field still had focus and
       the shell was told to show one for it. */
    if (el.tagName !== 'INPUT') { dropFocus(null); tellShell(false); }
    if (el.classList.contains('tab')) { setTab(el.getAttribute('data-tab')); return; }
    if (el.tagName === 'INPUT') { startEdit(); return; }
    if (el.id === 'setup-connect') { connect(); return; }
    if (el.id === 'setup-cancel')  { App.closeSetup(); return; }
  }

  function val(id) { return U.$(id).value.trim(); }

  /* The id of the entry this one would replace, if any — so a playlist saved
     again under its own name is not treated as a clash with itself. */
  function sameSourceId(p) {
    var hit = null;
    Store.profiles().forEach(function (x) { if (!hit && Store.sameSource(x, p)) hit = x; });
    return hit ? hit.id : null;
  }

  function connect() {
    msg('');
    var p;
    if (tab === 'xtream') {
      var host = val('x-host'), user = val('x-user'), pass = val('x-pass');
      if (!host) { msg(T('Server URL is required')); return; }
      if (!user || !pass) { msg(T('Username and password are required')); return; }
      p = { type: 'xtream', name: val('x-name') || Xtream.normHost(host).replace(/^https?:\/\//, ''),
            host: Xtream.normHost(host), user: user, pass: pass };
    } else {
      var url = val('m-url');
      if (!url) { msg(T('Playlist URL is required')); return; }
      if (!/^https?:\/\//i.test(url)) { msg('URL must start with http:// or https://'); return; }
      p = { type: 'm3u', name: val('m-name') || 'My playlist', url: url, epgUrl: val('m-epg') };
    }

    /* A name is how the switcher tells one from another, so two the same makes
       the list useless. Checked against everything except the entry this one
       is about to replace — re-saving a playlist under its own name is not a
       clash. */
    var clash = Store.profileNamed(p.name, sameSourceId(p));
    if (clash) { msg(T('There is already a playlist called {name}', { name: p.name })); return; }

    busy = true;
    U.loader(true, T('Connecting…'));

    var check = (p.type === 'xtream')
      ? Xtream.login(p).then(function (r) {
          p.formats = r.formats;
          var exp = r.userInfo.exp_date ? new Date(Number(r.userInfo.exp_date) * 1000) : null;
          p.expires = exp ? exp.getTime() : 0;
          p.maxConnections = r.userInfo.max_connections || '';
          return true;
        })
      : Net.text(p.url, { timeout: 25000 }).then(function (t) {
          if (t.indexOf('#EXTINF') === -1) throw new Error(T('That URL is not an M3U playlist'));
          p._preload = t;
          return true;
        });

    check.then(function () {
      busy = false;
      U.loader(false);
      var preload = p._preload;      // never persist the raw playlist text
      delete p._preload;
      var saved = Store.saveProfile(p);
      msg(T('Connected'), true);
      App.onProfileReady(saved, preload);
    }).catch(function (err) {
      busy = false;
      U.loader(false);
      msg(err && err.message ? err.message : T('Could not connect'));
    });
  }

  w.Setup = S;
})(window);

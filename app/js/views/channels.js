/* views/channels.js — the browse screen: groups rail, virtualised channel list,
   live preview, fullscreen playback and OSD. */
(function (w) {
  'use strict';

  var C = {};

  /* ---------------- state ---------------- */
  var profile   = null;
  var all       = [];      // every channel
  var groups    = [];      // [{id,name,count,kind}]
  var view      = [];      // channels currently listed
  var groupIdx  = 0;
  var chIdx     = 0;
  var pane      = 'channels';   // groups | channels | search
  var fullscreen = false;
  var playingKey = null;
  var playingCh  = null;   // kept as an object: it may not be in the current section
  var searchTerm = '';
  var byKey     = {};

  /* ROW_H matches --row-h in the CSS, GUIDE_H matches .epg-row: both are
     counted in rows by the windowing, and nothing checks that they agree. */
  var ROW_H = 92, GROW_H = 64, GUIDE_H = 60;
  var altRows = false;                         // read from settings on show()
  /* -1 nowhere, 0 Search, 1 Settings: the two fixed rows at the foot of the
     rail, below every group. */
  var railFoot = -1;
  /* One row now. Search was the other, and it was the third way to the same
     place — the green button and the drawer both open it — bought at the cost
     of a stop the cursor had to pass through every time it went to Settings. */
  var RAIL_FEET = ['rail-settings'];
  var chList = null, grList = null;

  var guide = [];          // programmes shown in the guide panel
  var guideIdx = 0;
  var playingProg = null;  // set when replaying a finished programme

  /* Timeshift. wallAnchor is the broadcast time playback started from and
     anchorReal is the clock reading at that moment; playback runs at 1x, so
     the difference gives the broadcast time currently on screen. Reading the
     player's own timeline instead would not work — for a live HLS stream it
     reports a position inside a sliding window, not elapsed time. */
  var wallAnchor = 0, anchorReal = 0;
  var seekTo = 0, seekTimer = null;
  var SEEK_STEP = 30000;      // arrow keys
  var SEEK_JUMP = 300000;     // rewind / fast-forward keys
  var LIVE_EDGE = 20000;      // close enough to now to count as live
  /* Both places that refuse a rewind refuse it for the same reason, and it is
     not a fault in the app: the provider does not keep this channel. Saying so
     is the difference between "it is broken" and "it does not do that". */
  var NO_CATCHUP = 'This channel cannot be rewound — it has no catch-up';

  var osdTimer = null, clockTimer = null, epgTimer = null, tsTimer = null;

  /* Stream health. Real time always advances; media time only advances while
     the picture does. The gap between them is how far behind the stream has
     fallen, and on a live edge it never recovers on its own. */
  var driftTimer = null, driftMs = 0, lastReal = 0, lastMedia = 0;
  var buffering = false, bufferTimer = null;
  var DRIFT_WARN = 5000;      // worth saying once it is seconds, not frames
  var stallFocus = false;      // the "stream is behind" badge has the cursor
  var liveFocus = false;       // the info bar's "Back to live" has the cursor
  var reconnects = 0, reconnectTimer = null;
  var MAX_RECONNECT = 3, RECONNECT_WAIT = 3000;
  var BUFFER_WARN = 1500;     // a brief rebuffer is normal, not a badge
  var zapBuf = '', zapTimer = null;

  /* Live TV / Movies / Series. Each is loaded lazily by app.js and kept
     separately; switching between them never refetches. */
  var section = 'live';
  var sectionsAvailable = { live: true, vod: false, series: false };
  var SECTION_ORDER = ['live', 'vod', 'series'];
  var ALL_LABEL    = { live: 'All channels', vod: 'All movies', series: 'All series' };
  var SEARCH_LABEL = { live: 'Search channels', vod: 'Search movies', series: 'Search series' };

  /* ---------------- tiny virtual list ---------------- */
  function VList(cfg) {
    var self = this;
    this.cfg = cfg;
    this.top = 0;          // scroll offset in px
    this.n = 0;
    this.pool = [];
    this.host = cfg.list;
    for (var i = 0; i < cfg.pool; i++) {
      var d = document.createElement('div');
      d.className = cfg.rowClass;
      d.style.display = 'none';
      d._idx = -1;
      this.host.appendChild(d);
      this.pool.push(d);
    }
    this.viewport = cfg.viewport;
    this.rowH = cfg.rowH;
    this.render = function () { self._render(); };
  }

  VList.prototype.setCount = function (n) {
    this.n = n;
    if (this.top > Math.max(0, n * this.rowH - this.viewport)) {
      this.top = Math.max(0, n * this.rowH - this.viewport);
    }
  };

  /* Keep the focused row inside the viewport with a 2-row margin. */
  VList.prototype.ensure = function (idx) {
    var margin = this.rowH * 2;
    var y = idx * this.rowH;
    if (y - margin < this.top) this.top = Math.max(0, y - margin);
    var bottom = this.top + this.viewport;
    if (y + this.rowH + margin > bottom) {
      this.top = Math.min(Math.max(0, this.n * this.rowH - this.viewport),
                          y + this.rowH + margin - this.viewport);
    }
  };

  VList.prototype._render = function () {
    var first = Math.max(0, Math.floor(this.top / this.rowH) - 1);
    var used = 0;
    for (var i = 0; i < this.pool.length; i++) {
      var idx = first + i;
      var node = this.pool[i];
      if (idx >= this.n) { if (node.style.display !== 'none') node.style.display = 'none'; node._idx = -1; continue; }
      node.style.display = '';
      node.style.transform = 'translateY(' + (idx * this.rowH - this.top) + 'px)';
      this.cfg.paint(node, idx, node._idx !== idx);
      node._idx = idx;
      used++;
    }
    return used;
  };

  /* Force every pooled row to be rewritten on the next render. Required
     whenever the underlying array changes: a recycled node whose index has
     not changed would otherwise keep the previous list's text. */
  VList.prototype.invalidate = function () {
    for (var i = 0; i < this.pool.length; i++) this.pool[i]._idx = -1;
  };

  VList.prototype.nodeFor = function (idx) {
    for (var i = 0; i < this.pool.length; i++) if (this.pool[i]._idx === idx) return this.pool[i];
    return null;
  };

  /* ---------------- lifecycle ---------------- */

  C.load = function (p, data) {
    profile = p;
    U.$('playlist-name').textContent = p.name || 'Playlist';
    pane = 'channels';
    ensureLists();
    applySection('live', data, startGroupIdx());
    startTimers();
  };

  /* Which list to open on. The pinned rows are always All/Favourites/Recent. */
  var START_GROUP = { all: 0, fav: 1, recent: 2 };
  function startGroupIdx() {
    return START_GROUP[Store.settings().startGroup] || 0;
  }

  /* Called by app.js once a section's data is available. */
  C.setSection = function (kind, data) { applySection(kind, data); };

  C.section = function () { return section; };

  /* Which sections this playlist actually has. Shows or hides the strip. */
  C.setSections = function (avail) {
    sectionsAvailable = avail;
    var any = !!(avail.vod || avail.series);
    U.$('sections').classList.toggle('hidden', !any);
    U.$('groups').classList.toggle('has-sections', any);
    if (!any && pane === 'sections') pane = 'groups';
    measure();
    paintSections();
  };

  var sectionData = null;

  function applySection(kind, data, startIdx) {
    section = kind;
    sectionData = data;
    all = data.channels || [];
    byKey = {};
    for (var i = 0; i < all.length; i++) byKey[all[i].key] = all[i];

    var provided = (data.groups || []).map(function (g) {
      return { id: g.id, name: g.name, count: g.count, kind: 'group' };
    });
    if (Store.settings().hideEmptyGroups) {
      provided = provided.filter(function (g) { return g.count > 0; });
    }
    if (Store.parentalActive() && !Store.isUnlocked()) {
      provided = provided.filter(function (g) { return !U.isAdult({ group: g.name }); });
    }
    groups = [
      { id: '__all', name: ALL_LABEL[kind] || 'All', count: all.length, kind: 'all' },
      { id: '__fav', name: 'Favourites', count: 0, kind: 'fav' },
      { id: '__recent', name: 'Recently watched', count: 0, kind: 'recent' }
    ].concat(provided);

    groupIdx = startIdx || 0; chIdx = 0; searchTerm = '';
    U.$('search-input').value = '';
    U.$('search-input').placeholder = T(SEARCH_LABEL[kind] || 'Search');

    // The groups array itself has been replaced, so every pooled row must be
    // rewritten — a recycled node at the same index would keep the old text.
    if (grList) grList.invalidate();
    guideKey = null;

    paintSections();
    applyGroup();
  }

  function anySections() {
    return !!(sectionsAvailable.vod || sectionsAvailable.series);
  }

  function paintSections() {
    var kids = U.$('sections').children;
    for (var i = 0; i < kids.length; i++) {
      var k = kids[i].getAttribute('data-sec');
      kids[i].className = 'sec' +
        (k === section ? ' active' : '') +
        (pane === 'sections' && k === section ? ' focused' : '');
      kids[i].style.display = sectionsAvailable[k] ? '' : 'none';
    }
  }

  function stepSection(d) {
    var avail = SECTION_ORDER.filter(function (k) { return sectionsAvailable[k]; });
    var i = avail.indexOf(section);
    var next = avail[U.clamp(i + d, 0, avail.length - 1)];
    if (!next || next === section) return;
    App.switchSection(next);
  }

  /* ---------------- mouse ----------------
     Not needed on a TV, but a browser session is unusable without it. Every
     handler routes through the same functions the remote keys use. */

  var mouseBound = false;

  /* The pooled row under the pointer, via the _idx the virtual list stamps. */
  function rowUnder(node, host) {
    while (node && node !== host && node !== document) {
      if (node.parentNode === host) return node;
      node = node.parentNode;
    }
    return null;
  }

  function indexIn(node, host) {
    var row = rowUnder(node, host);
    if (!row) return -1;
    return [].indexOf.call(host.children, row);
  }

  function bindMouse() {
    if (mouseBound) return;
    mouseBound = true;

    U.$('sections').addEventListener('click', function (ev) {
      var node = ev.target;
      while (node && node !== this && !node.classList.contains('sec')) node = node.parentNode;
      if (!node || node === this) return;
      var kind = node.getAttribute('data-sec');
      if (!sectionsAvailable[kind] || kind === section) return;
      pane = 'sections';
      App.switchSection(kind);
    }, false);

    U.$('group-list').addEventListener('click', function (ev) {
      var row = rowUnder(ev.target, this);
      if (!row || row._idx == null || row._idx < 0) return;
      pane = 'groups';
      groupIdx = row._idx;
      applyGroup();
    }, false);

    U.$('channel-list').addEventListener('click', function (ev) {
      var row = rowUnder(ev.target, this);
      if (!row || row._idx == null || row._idx < 0) return;
      if (pane === 'search') exitSearch();
      pane = 'channels';
      chIdx = row._idx;
      var sel = view[chIdx];
      repaintAll();
      if (!sel) return;
      if (sel.seriesId) { stopPlayback(); SeriesView.open(profile, sel); return; }
      // A click is a deliberate choice, so it plays — same as OK. Clicking the
      // channel already playing is the second OK, i.e. go fullscreen.
      if (sel.key === playingKey && Player.isPlaying()) { enterFullscreen(); return; }
      play(sel);
      repaintAll();
    }, false);

    // The action bar doubles as buttons for anyone using a mouse.
    var bar = U.qs('.action-bar');
    if (bar) bar.addEventListener('click', function (ev) {
      var node = ev.target;
      while (node && node !== this && !node.classList.contains('act')) node = node.parentNode;
      if (!node || node === this) return;
      switch (node.getAttribute('data-act')) {
        case 'play':
          var s = view[chIdx];
          if (s) { if (s.key === playingKey) enterFullscreen(); else { play(s); repaintAll(); } }
          return;
        case 'full':     watchFullscreen(); return;
        case 'fav':      toggleFav(); return;
        case 'search':   enterSearch(); return;
        case 'info':     enterGuide(); return;
        case 'settings': App.openSettings(); return;
      }
    }, false);

    U.$('rail-settings').addEventListener('click', function () { App.openSettings(); }, false);

    U.$('stall-warn').addEventListener('click', function () {
      if (playingKey) backToLive();
    }, false);

    U.$('ctxmenu').addEventListener('click', function (ev) {
      var node = ev.target;
      while (node && node !== this && !node.classList.contains('cm-row')) node = node.parentNode;
      if (!node || node === this) { closeCtx(); return; }
      var i = [].indexOf.call(node.parentNode.children, node);
      if (i > -1 && CTX[i]) { ctxIdx = i; CTX[i].run(); }
    }, false);

    U.$('sidemenu').addEventListener('click', function (ev) {
      var node = ev.target;
      while (node && node !== this && !node.classList.contains('sm-row')) node = node.parentNode;
      if (!node || node === this) { closeMenu(); return; }
      var i = [].indexOf.call(node.parentNode.children, node);
      if (i > -1 && MENU[i]) { menuIdx = i; MENU[i].run(); }
    }, false);

    U.$('search-input').addEventListener('focus', function () {
      if (pane !== 'search') { pane = 'search'; repaintFocusOnly(); }
    }, false);

    // The video is the obvious thing to click to make it bigger, then smaller.
    // The handler goes on #video-layer, not .preview-frame: in a browser the
    // layer is painted above the pane, so the frame never sees the click.
    U.$('video-layer').addEventListener('click', function () {
      if (fullscreen) leaveFullscreen();
      else if (playingKey) enterFullscreen();
    }, false);
    U.$('preview-frame').addEventListener('click', function () {
      if (playingKey && !fullscreen) enterFullscreen();
    }, false);

    // Wheel over either list moves the cursor without touching playback.
    U.$('channel-scroller').addEventListener('wheel', function (ev) {
      if (!view.length) return;
      ev.preventDefault();
      pane = 'channels';
      chIdx = U.clamp(chIdx + (ev.deltaY > 0 ? 3 : -3), 0, view.length - 1);
      repaintFocusOnly();
    }, false);

    U.$('epg-scroller').addEventListener('wheel', function (ev) {
      if (!guide.length) return;
      ev.preventDefault();
      guideIdx = U.clamp(guideIdx + (ev.deltaY > 0 ? 2 : -2), 0, guide.length - 1);
      markGuide(true);
    }, false);
  }

  function ensureLists() {
    if (chList) return;
    bindMouse();
    chList = new VList({
      list: U.$('channel-list'), viewport: 984, rowH: ROW_H, pool: 18,
      rowClass: 'ch-row', paint: paintChannelRow
    });
    grList = new VList({
      list: U.$('group-list'), viewport: 914, rowH: GROW_H, pool: 18,
      rowClass: 'group-row', paint: paintGroupRow
    });
  }

  /* The rails shrink when the section strip is visible, so the virtual lists
     take their viewport from the DOM rather than a hard-coded constant. Only
     valid once the view is on screen. */
  function measure() {
    if (!chList) return;
    var cs = U.$('channel-scroller'), gs = U.$('group-scroller');
    if (cs.clientHeight) chList.viewport = cs.clientHeight;
    if (gs.clientHeight) grList.viewport = gs.clientHeight;
  }

  C.show = function () {
    C.applyRowStyle();
    paintClock();
    U.$('view-main').classList.remove('hidden');
    /* Back to the browse screen: the picture comes back with it. The CSS
       still decides whether there is one to show. */
    U.$('video-layer').classList.remove('hidden');
    paintStall();
    U.$('view-setup').classList.add('hidden');
    U.$('view-settings').classList.add('hidden');
    U.$('view-series').classList.add('hidden');
    measure();
    paintBadge();
    repaintAll();
  };

  C.hide = function () {
    /* Fullscreen is a state of the whole stage, not of this pane: while it is
       on, "#stage.playing-full .view" hides every view there is. Leaving the
       browse screen for the catch-up browser, settings or a series without
       dropping it therefore opened a screen nobody could see, which still had
       every key — indistinguishable from the app hanging. */
    if (fullscreen) leaveFullscreen();
    U.$('ctxmenu').classList.add('hidden');
    if (pane === 'ctx') pane = 'channels';
    U.$('view-main').classList.add('hidden');
    // The badge, the stream warning and the video all live outside .view, so
    // they do not hide with the pane and have to be told.
    U.$('preview-badge').classList.add('hidden');
    /* In a browser the video is a real element above the panes, so without
       this it floats over settings and the catch-up browser. On a TV the
       picture is behind the page and those screens paint their own opaque
       background over it, so this changes nothing there — and either way it
       only hides the picture. Whatever is playing keeps playing. */
    U.$('video-layer').classList.add('hidden');
    hideStall();
  };

  C.channels = function () { return all; };
  /* The number a channel is dialled by, for anything outside this file that
     has to print one — the catalogue does. Its own override beats the
     playlist's, which is the same rule the list itself paints by. */
  C.numberOf = function (c) { return numOf(c) || 0; };
  C.playingKey = function () { return playingKey; };
  /* Rebuild the rail as well as the list — a parental unlock changes which
     groups exist, not just which channels are in them. */
  /* The panel windows its programmes at paint time and only repaints when
     the channel changes, so changing what it should show has to say so. */
  C.refreshGuide = function () { paintGuide(true); };
  /* The clock and the date are painted on a timer, so a setting that changes
     how they read has to say so or it looks like nothing happened for ten
     seconds. */
  C.refreshClock = function () { paintClock(); };

  C.reloadGroups = function () {
    /* applyGroup drops the cursor at the top, which is right when the list has
       genuinely changed and gratuitous when it has not — locking a channel
       does not remove it. Put the cursor back on whatever it was on. */
    var was = view[chIdx] ? view[chIdx].key : '';
    if (sectionData) applySection(section, sectionData, groupIdx);
    else applyGroup();
    if (was) {
      var i = indexOfKey(was);
      if (i > -1 && i !== chIdx) { chIdx = i; repaintAll(); }
    }
    /* Re-locking has to take the picture with it, whether the channel was
       hidden by the adult filter or gated by a lock: carrying on playing
       while the row says it is locked is a lock in name only. */
    if (playingCh && (isHidden(playingCh) || needsPin(playingCh))) {
      if (fullscreen) leaveFullscreen();
      stopPlayback();
      repaintAll();
    }
  };

  /* ---------------- filtering ---------------- */

  /* ---------------- what is behind the PIN ----------------
     The rule itself lives in store.js, because the channel-numbers screen has
     to ask the same question and a view is not a service for another view. */
  function isHidden(c) { return Store.isHiddenChannel(profile.id, c); }

  /* A locked channel is listed like any other, wearing a padlock, and stops
     here: the PIN is asked for when somebody tries to watch it. Hiding it
     instead — which is what the adult filter does to a whole category — makes
     a lock look like a channel that has gone missing, and gives the person who
     set it nothing to point at.

     One correct PIN opens the session, so zapping past several locked channels
     is not a typing exercise. Settings -> Lock now closes it again, and so
     does the next launch. */
  function needsPin(c) { return Store.needsPin(profile.id, c); }

  function withPin(c, run) {
    if (!c || !needsPin(c)) { run(); return; }
    /* The prompt submits itself on the fourth digit, so a mistyped one would
       otherwise close the dialog and leave the viewer pressing OK again to get
       it back. It asks again instead, saying why. */
    var ask = function (sub) {
      askPin(T('Enter PIN'), sub, function (pin) {
        if (!Store.unlock(pin)) { ask(T('Wrong PIN — try again')); return; }
        repaintAll();
        run();
      });
    };
    ask(T('{name} is locked', { name: c.name }));
  }

  /* A PIN is typed in front of whoever it is meant to keep out, so it is
     masked. Cancelling hands back null and nothing happens. */
  function askPin(title, sub, cb) {
    U.numberPrompt(title, sub, function (v) {
      if (v === null) return;
      cb(String(v));
    }, { raw: true, mask: true, auto: 4 });
  }

  /* Lock this channel behind the PIN, or take the lock off again.

     Taking one off always asks, even when the session is already open. The two
     directions are not the same act: putting a lock on is protective and can be
     cheap, while taking one off is the whole protection going away, and a
     session left unlocked after somebody watched something is exactly when a
     child would be able to do it. Setting one asks too unless the PIN has
     already been given this session — locking a run of channels should not be
     four digits each time.

     Checking the PIN here deliberately does NOT open the session: that is what
     made a channel play without a word straight after being locked. */
  function toggleLock(c) {
    if (!c) return;
    var locked = Store.isLocked(profile.id, c.key);

    if (!Store.settings().pin) {
      askPin(T('Set a PIN code'), T('Four digits. There is no way past it later.'), function (pin) {
        if (!pin || pin.length < 4) { U.toast(T('A PIN must be four digits')); return; }
        Store.set('settings.pin', pin);
        applyLock(c, true);
      });
      return;
    }

    if (!locked && Store.sessionUnlocked()) { applyLock(c, true); return; }

    var ask = function (sub) {
      askPin(T('Enter PIN'), sub, function (pin) {
        if (!Store.checkPin(pin)) { ask(T('Wrong PIN — try again')); return; }
        applyLock(c, !locked);
      });
    };
    ask(locked ? T('To unlock {name}', { name: c.name })
               : T('To lock {name}', { name: c.name }));
  }


  /* ---------------- the number on the remote ----------------

     The channel-numbers screen in Settings is where a whole playlist gets
     renumbered; this is the same edit for the one channel under the cursor,
     because wanting to move one channel should not mean walking a list of five
     thousand to find it again.

     The rule it has to share with that screen: two channels cannot hold one
     number, because the remote reaches whichever the list hits first. Offer
     the only thing that keeps every number dialable — trading places. */
  function numberHolder(n, exceptKey) {
    for (var i = 0; i < all.length; i++) {
      if (all[i].key !== exceptKey && numOf(all[i]) === n) return all[i];
    }
    return null;
  }

  function editNumber(c) {
    if (!c) return;
    var mine = numOf(c);
    var current = Store.channelNumber(profile.id, c.key);
    var sub = current
      ? T('Now {n}, playlist says {orig}. Type a new number.',
          { n: current, orig: c.num || '—' })
      : T('Now {n}, from the playlist. Type a new number.', { n: c.num || '—' });

    U.numberPrompt(c.name, sub, function (n) {
      if (n === null) return;
      if (n === 0) {
        Store.setChannelNumber(profile.id, c.key, 0);
        U.toast(T('Number reset to {n}', { n: c.num || '—' }));
        C.reloadGroups();
        return;
      }
      if (n === mine) return;

      var other = numberHolder(n, c.key);
      if (other) {
        U.confirm(T('Channel {n} is {name}. Swap their numbers?', { n: n, name: other.name }),
          function (yes) {
            if (!yes) return;
            Store.setChannelNumber(profile.id, other.key, mine);
            Store.setChannelNumber(profile.id, c.key, n);
            U.toast(T('Swapped with {name} — it is now {n}', { name: other.name, n: mine }));
            C.reloadGroups();
          });
        return;
      }

      Store.setChannelNumber(profile.id, c.key, n, c.num);
      U.toast(T('Set to {n}', { n: n }));
      C.reloadGroups();       // sorting by number re-orders the list under it
    });
  }
  function applyLock(c, on) {
    Store.setLocked(profile.id, c.key, on);
    U.toast(on ? T('{name} is locked', { name: c.name })
               : T('{name} is unlocked', { name: c.name }));
    // A lock that leaves the picture running is not a lock.
    if (on && needsPin(c) && c.key === playingKey) {
      if (fullscreen) leaveFullscreen();
      stopPlayback();
    }
    chList.invalidate();
    repaintAll();
  }

  function applyGroup() {
    var g = groups[groupIdx];
    var out;
    if (!g) out = all;
    else if (g.kind === 'all') out = all;
    else if (g.kind === 'fav') {
      out = all.filter(function (c) { return Store.isFav(profile.id, c.key); });
    } else if (g.kind === 'recent') {
      var order = Store.recent(profile.id);
      out = [];
      for (var i = 0; i < order.length; i++) if (byKey[order[i]]) out.push(byKey[order[i]]);
    } else {
      out = all.filter(function (c) { return c.group === g.id; });
    }

    /* The adult filter hides its matches outright: a visible-but-locked row
       in a category a child should not know about still tells them it is
       there. A channel locked by hand is not hidden — it is listed with a
       padlock and asks for the PIN when someone tries to watch it. */
    out = out.filter(function (c) { return !isHidden(c); });

    if (searchTerm) {
      var q = U.searchKey(searchTerm);
      out = out.filter(function (c) { return c.skey.indexOf(q) > -1; });
    }

    if (Store.settings().sortBy === 'number' && g && g.kind !== 'recent') {
      // slice() first: `out` may still be `all`, which must keep its own order.
      out = out.slice().sort(function (a, b) { return numOf(a) - numOf(b); });
    }

    view = out;
    chIdx = 0;
    if (chList) { chList.top = 0; chList.setCount(view.length); chList.invalidate(); }
    repaintAll();
  }

  /* The number shown and dialled. A user override beats the playlist's own. */
  function numOf(c) {
    if (!c) return 0;
    var n = Store.channelNumber(profile.id, c.key);
    return n || c.num || 0;
  }

  /* ---------------- painting ---------------- */

  function paintGroupRow(node, idx, changed) {
    var g = groups[idx];
    if (!g) return;
    if (changed) {
      /* T() on the way to the screen, not on the way into the array: the
         three built-in groups are stored under their English names, and a
         provider's own category comes back from T() unchanged. */
      node.innerHTML = '<span class="gcount">' + (g.kind === 'group' ? g.count : '') + '</span>' +
                       U.esc(T(g.name));
    }
    node.classList.toggle('pinned', g.kind !== 'group');
    node.classList.toggle('selected', idx === groupIdx);
    node.classList.toggle('focused', pane === 'groups' && idx === groupIdx);
  }

  function paintChannelRow(node, idx, changed) {
    var c = view[idx];
    if (!c) return;
    if (changed) {
      var logo = c.logo
        ? '<span class="ch-logo" style="background-image:url(&quot;' + U.esc(c.logo) + '&quot;)"></span>'
        : '<span class="ch-logo blank"></span>';
      // Source order matters now that the row is a flex box.
      node.innerHTML =
        '<span class="ch-num"></span>' + logo +
        '<span class="ch-text"><span class="ch-name">' + U.esc(c.name) + '</span>' +
        '<span class="ch-now"></span></span>' +
        '<span class="ch-right"><span class="ch-lock"></span><span class="ch-fav"></span><span class="ch-prog"><i></i></span></span>';
    }
    var numEl = node.querySelector('.ch-num');
    numEl.textContent = numOf(c) || (idx + 1);
    /* Amber means "you moved this one", so a number that matches the playlist
       is not amber even if a record of it survives. */
    var over = Store.channelNumber(profile.id, c.key);
    numEl.classList.toggle('custom', !!over && over !== c.num);
    paintRowEpg(node, c);
    // Drawn in CSS, never a glyph: no font on the TV is guaranteed to have one.
    node.querySelector('.ch-fav').className =
      'ch-fav' + (Store.isFav(profile.id, c.key) ? ' on' : '');
    /* Only ever seen while the session is unlocked — a locked channel is not
       in the list at all otherwise — so this is the parent's own view of what
       they have put away. Drawn in CSS for the same reason as the star. */
    node.querySelector('.ch-lock').className =
      'ch-lock' + (Store.isLocked(profile.id, c.key) ? ' on' : '');
    node.classList.toggle('focused', pane === 'channels' && idx === chIdx);
    node.classList.toggle('playing', c.key === playingKey);
    /* Striping has to follow the channel's position in the list, not the row
       element's: eighteen rows are recycled for the whole playlist, so
       nth-child would stripe the pool and the bands would crawl as you
       scrolled. */
    node.classList.toggle('alt', altRows && (idx % 2) === 1);
  }

  function paintRowEpg(node, c) {
    var nowEl = node.querySelector('.ch-now');
    var bar = node.querySelector('.ch-prog');
    // Only live TV has a guide; a movie named "BBC One" must not borrow one.
    var nn = (section === 'live' && EPG.hasData()) ? EPG.nowNext(c) : null;
    if (nn && nn.now) {
      nowEl.textContent = U.hhmm(new Date(nn.now.s)) + '  ' + nn.now.t;
      bar.style.visibility = 'visible';
      bar.firstChild.style.width = EPG.progress(nn.now) + '%';
    } else {
      nowEl.textContent = c.group || '';
      bar.style.visibility = 'hidden';
    }
  }

  function repaintAll() {
    paintRail();
    if (!chList) return;
    grList.setCount(groups.length);
    grList.ensure(groupIdx);
    grList.render();
    chList.setCount(view.length);
    chList.ensure(chIdx);
    chList.render();
    U.$('channel-count').textContent = view.length
      ? (chIdx + 1) + ' / ' + view.length
      : '';
    U.$('channel-empty').classList.toggle('hidden', view.length > 0);
    paintPreviewMeta();
  }

  function repaintFocusOnly() {
    grList.render();
    chList.ensure(chIdx);
    chList.render();
    U.$('channel-count').textContent = view.length ? (chIdx + 1) + ' / ' + view.length : '';
    paintPreviewMeta();
  }

  /* The meta block and guide describe the FOCUSED channel, which is not
     necessarily the one playing — the badge over the video names that one. */
  function paintPreviewMeta() {
    var c = view[chIdx];
    U.$('pm-name').textContent = c ? c.name : '';
    var nn = (c && section === 'live' && EPG.hasData()) ? EPG.nowNext(c) : null;
    var meta = U.$('preview-meta');

    if (nn && nn.now) {
      var pct = EPG.progress(nn.now);
      U.$('pm-now').textContent = U.hhmm(new Date(nn.now.s)) + '–' +
        U.hhmm(new Date(nn.now.e)) + '  ' + nn.now.t;
      U.$('pm-left').textContent = timeLeft(nn.now);
      U.$('pm-bar-fill').style.width = pct + '%';
      U.$('pm-knob').style.left = pct + '%';
      meta.classList.remove('no-prog');
    } else {
      U.$('pm-now').textContent = c ? (c.group || '') : '';
      U.$('pm-left').textContent = '';
      U.$('pm-bar-fill').style.width = '0%';
      meta.classList.add('no-prog');
    }
    paintGuide();
  }

  /* "45 min left" beats a fill percentage: it is the number you were going to
     work out anyway. */
  function timeLeft(prog, at) {
    var ms = prog.e - (at || Date.now());
    if (ms <= 0) return T('ending');
    var mins = Math.round(ms / 60000);
    if (mins < 1) return T('ending');
    if (mins < 60) return T('{n} min left', { n: mins });
    var h = Math.floor(mins / 60), m = mins % 60;
    return m ? T('{h}h {m}m left', { h: h, m: m }) : T('{h}h left', { h: h });
  }

  function paintBadge() {
    var b = U.$('preview-badge');
    var c = playingCh;
    if (!c) { b.classList.add('hidden'); return; }
    U.$('preview-badge-name').textContent = playingProg
      ? (c.name + '  ·  ' + playingProg.t)
      : c.name;
    b.classList.toggle('replay', !!playingProg);
    b.classList.remove('hidden');
  }

  /* ---------------- guide viewer ---------------- */

  var guideKey = null;

  /* Rebuilding ~30 rows on every cursor move would cost more than the channel
     list itself, so only redraw when the focused channel actually changes. */
  /* Five programmes, with the one on air in the middle: two behind it, two
     ahead. Counted, not measured in hours — a time window gave a different
     number of rows either side of "now" depending on how long the programmes
     happened to be, so the one playing could not sit in the middle, which is
     the whole point of the panel. Going further either way is what the
     catch-up browser is for. */
  /* Nine programmes held, five of them on screen: whatever is on air, four
     either side of it. It was five held and five shown until 0.7.16, which
     meant the panel could only ever say what was on within about two hours;
     scrolling it is what the other four each way are for.

     PANEL_VIEW must stay equal to `.epg-scroller`'s height in rows, and
     GUIDE_H to `.epg-row`'s height, or the row on air stops being centred by
     arithmetic and starts being centred by luck. */
  var PANEL_ROWS = 9, PANEL_BEFORE = 4, PANEL_VIEW = 5;

  /* Two ways to read a panel this size. Centred is the default: what is on
     in the middle, with what has just been on above it — that is the shape
     of a channel you are half-watching. Ahead is for planning the evening:
     what is on at the top and nothing but the future under it, which is
     nine programmes of schedule instead of four. */
  function panelBefore() {
    return Store.settings().guideView === 'ahead' ? 0 : PANEL_BEFORE;
  }

  /* Where the cursor rests in a channel's schedule, and which row the panel
     marks — one answer, used everywhere, because two answers is how the panel
     ends up opening on one row and pointing at another.

     Strictly what is on air when there is something on air. When there is not
     — the guide has a gap where now falls, or it ran out hours ago, or it does
     not start until this evening — it is the programme nearest to now, which
     is the next one if the guide continues and the last one if it does not.
     Parking on row 0 in those cases put the cursor on the oldest thing the
     panel held, which is the least useful row on the screen. */
  function onAirIn(arr, t) {
    for (var i = 0; i < arr.length; i++) if (arr[i].s <= t && t < arr[i].e) return i;
    return -1;
  }

  function parkIndex(arr, t) {
    if (!arr || !arr.length) return 0;
    var i = onAirIn(arr, t);
    if (i !== -1) return i;
    i = EPG.indexAt(arr, t);              // the next one, when now is in a gap
    return i === -1 ? arr.length - 1 : i; // or the last, when the guide ran out
  }

  function paintGuide(force) {
    var c = view[chIdx];
    var key = c ? c.key : '';
    if (!force && key === guideKey) return;
    var changed = (key !== guideKey);
    guideKey = key;

    /* A forced repaint is the 30-second tick, not a channel change: leave the
       cursor on the programme the viewer put it on, even though the window
       may have slid by a row since. */
    var keepStart = (!changed && guide && guide[guideIdx]) ? guide[guideIdx].s : 0;

    var full = (c && section === 'live' && EPG.hasData()) ? EPG.list(c) : [];
    var now = Date.now();
    var live = onAirIn(full, now) !== -1;   // is anything actually on air?
    var at = parkIndex(full, now);
    /* Centred slides the window back so nine rows are always full; ahead
       starts at what is on and takes however many follow, because sliding
       back to fill the panel is exactly the past it was asked not to show. */
    var before = panelBefore();
    var from = before
      ? U.clamp(at - before, 0, Math.max(0, full.length - PANEL_ROWS))
      : at;
    var list = full.slice(from, from + PANEL_ROWS);
    var park = at - from;                   // where that row landed in the window
    var host = U.$('epg-list');

    if (!list.length) {
      host.innerHTML = '';
      guide = [];
      /* If the guide failed to load at all, say that rather than blaming the
         channel: every row would otherwise read "no guide for this channel"
         with nothing anywhere to explain why. */
      U.$('epg-empty').textContent =
        (!EPG.hasData() && App.epgError)
          ? T('Guide unavailable — {why}', { why: App.epgError })
        : App.epgLoading ? T('Loading the guide…')
        : T('No guide for this channel');
      U.$('epg-empty').classList.remove('hidden');
      U.$('epg-day').textContent = '';
      return;
    }
    U.$('epg-empty').classList.add('hidden');

    var html = '';
    for (var i = 0; i < list.length; i++) {
      var p = list[i];
      var cls = 'epg-row';
      /* Exactly one row is marked, and it is the row the cursor parks on.
         Testing each row's own times instead marks two of them whenever the
         provider's programmes overlap, and none at all whenever they do not
         quite meet — and then the panel has a middle row that is not on air
         and nothing anywhere saying which row it is looking at. */
      if (i === park && live) cls += ' now';
      else if (p.e <= now) cls += ' past';
      if (i === park && !live) cls += ' here';
      if (Catchup.available(profile, c, p, now)) cls += ' replay';
      var rem = (p.s > now) && Store.hasReminder(profile.id, c.key, p.s);
      if (rem) cls += ' reminded';
      html += '<div class="' + cls + '">' +
              '<span class="epg-time">' + U.hhmm(new Date(p.s)) + '</span>' +
              '<span class="epg-body"><span class="epg-name">' + U.esc(p.t) +
              (cls.indexOf(' replay') > -1 ? '<i class="epg-replay"></i>' : '') +
              (i === park && live ? '<i class="epg-play"></i>' : '') +
              (rem ? '<i class="epg-remind"></i>' : '') + '</span>' +
              ((i === park && live)
                ? '<span class="epg-bar"><i style="width:' + EPG.progress(p, now) + '%"></i></span>'
                : '') +
              '</span></div>';
    }
    host.innerHTML = html;
    guide = list;

    guideIdx = park;
    for (var g = 0; keepStart && g < list.length; g++) {
      if (list[g].s === keepStart) { guideIdx = g; break; }
    }
    U.$('epg-day').textContent = guideHeadLabel();
    markGuide(false);
  }


  /* The label at the right of the panel head. While the cursor is in the panel
     it is the day of the row under it — the panel can reach into yesterday and
     tomorrow. The rest of the time, if nothing is on air, it is the reason:
     a guide that stopped at two o'clock looks exactly like one that is between
     programmes, and telling them apart is the whole answer to "why has this
     channel got nothing on now?". */
  function guideHeadLabel() {
    if (!guide.length) return '';
    if (pane === 'epg') return dayLabel(guide[guideIdx].s);
    var now = Date.now();
    if (onAirIn(guide, now) !== -1) return dayLabel(guide[guideIdx].s);
    var last = guide[guide.length - 1], first = guide[0];
    if (last.e <= now) return T('Guide ends {time}', { time: U.hhmm(new Date(last.e)) });
    if (first.s > now) return T('Starts {time}', { time: U.hhmm(new Date(first.s)) });
    return T('Nothing on air');
  }
  /* Just after midnight the programme on air started "yesterday", so that case
     needs a name of its own — otherwise the guide reads "Wednesday" at 00:05
     on Thursday, which looks like a bug. */
  function dayLabel(ms) {
    var d = new Date(ms);
    var t = new Date();
    if (d.toDateString() === t.toDateString()) return T('Today');
    t.setDate(t.getDate() - 1);
    if (d.toDateString() === t.toDateString()) return T('Yesterday');
    t.setDate(t.getDate() + 2);
    if (d.toDateString() === t.toDateString()) return T('Tomorrow');
    return T(DAYS[d.getDay()]);
  }

  var DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

  /* The rail is open while the cursor is in it, folded while it is not. */
  function paintRail() {
    var inRail = (pane === 'groups' || pane === 'sections' || pane === 'menu');
    U.$('stage').classList.toggle('rail-in', !inRail);
    for (var i = 0; i < RAIL_FEET.length; i++) {
      U.$(RAIL_FEET[i]).classList.toggle('focused', pane === 'groups' && railFoot === i);
    }
    /* The box at the top of the list is only there while it is being used;
       the rest of the time the list says which list it is. */
    var searching = (pane === 'search') || !!searchTerm;
    U.$('search-box').classList.toggle('hidden', !searching);
    U.$('list-title').classList.toggle('hidden', searching);
    var g = groups[groupIdx];
    U.$('list-title').textContent = g ? T(g.name) : '';
  }

  /* `animate` is for the cursor moving inside the panel, where the slide is
     the feedback. A channel change is not that: the rows underneath have all
     been replaced, so sliding them means the guide arrives and then spends a
     tenth of a second finding its middle, which reads as the panel lagging
     behind the list. Those land in place. */
  function markGuide(animate) {
    var kids = U.$('epg-list').children;
    for (var i = 0; i < kids.length; i++) {
      kids[i].classList.toggle('focused', i === guideIdx);
    }
    U.$('epg-panel').classList.toggle('active', pane === 'epg');
    if (guide[guideIdx]) U.$('epg-day').textContent = guideHeadLabel();
    ensureGuideVisible(animate);
  }

  /* Setting the offset without a transition takes a forced reflow between
     turning it off and back on, or the browser coalesces the two writes and
     animates anyway. Reading offsetHeight is that reflow. */
  function slideGuide(host, px, animate) {
    if (animate) { host.style.transform = 'translateY(' + px + 'px)'; return; }
    host.style.transition = 'none';
    host.style.transform = 'translateY(' + px + 'px)';
    /* jshint expr:true */
    host.offsetHeight;
    host.style.transition = '';
  }

  /* Keep the cursor row in the middle of the five on screen, clamped at both
     ends so the panel never scrolls past its own contents.

     With one exception, and it is the whole reason the panel exists: while
     nobody is driving it, the row it rests on — what is on air — is centred
     even when there are not two programmes before it to fill the space above.
     Some channels' guides start a couple of hours ago, and clamping there put
     the programme being watched one row up from the middle, which is the one
     thing the panel is supposed to guarantee. A little empty space above the
     first row is a smaller price than the middle row not being the one on. */
  function ensureGuideVisible(animate) {
    var host = U.$('epg-list');
    var box = U.$('epg-scroller');
    var thumb = U.$('epg-thumb');
    var h = box.clientHeight || (PANEL_VIEW * GUIDE_H);
    var total = guide.length * GUIDE_H;

    if (total <= h) {
      /* Fewer programmes than the panel can show. Centre the block — unless
         the panel was asked to start at what is on, in which case it starts
         at the top and the empty space goes underneath. */
      var ahead = Store.settings().guideView === 'ahead';
      slideGuide(host, ahead ? 0 : (h - total) / 2, animate);
      box.classList.remove('scrolls');
      return;
    }
    var mid = (guideIdx * GUIDE_H) + (GUIDE_H / 2);
    var top = mid - (h / 2);
    /* Overscroll only to keep the programme on air in the middle. With
       nothing on air there is no row that has to be centred, so the panel
       fills itself properly instead of leaving space above a guide that
       simply has not started yet. */
    var onAir = onAirIn(guide, Date.now());
    var holdCentre = (pane !== 'epg') && onAir !== -1 && onAir === guideIdx &&
                     Store.settings().guideView !== 'ahead';
    if (holdCentre) top = Math.min(top, total - h);
    else top = U.clamp(top, 0, total - h);
    slideGuide(host, -top, animate);

    /* Five whole rows fill the box, so nothing hangs over the edge to show
       there is more. The track says it, and says where in the nine you are. */
    box.classList.add('scrolls');
    if (thumb) {
      thumb.style.height = (h / total * 100) + '%';
      thumb.style.top = (U.clamp(top, 0, total - h) / total * 100) + '%';
    }
  }

  /* ---------------- the guide panel as a place ----------------

     It went back to being read-only in 0.5 because right from the list was the
     only way in and that key was wanted for the channel panel. It is a place
     again now, reached by INFO or by "Schedule" in that panel — neither of
     which takes a key away from anything else. */

  function enterGuide() {
    if (!guide.length) {
      U.toast(EPG.hasData() ? T('No guide for this channel') : T('The guide has not loaded'));
      return;
    }
    pane = 'epg';
    guideIdx = parkIndex(guide, Date.now());   // open on the row the panel marks
    markGuide(false);
    repaintAll();
  }

  /* Leaving puts the panel back where it rests: what is on, centred. Anything
     else and the next glance at it shows wherever the last person scrolled to,
     which is not what the panel is for. */
  function leaveGuide() {
    if (pane !== 'epg') return;
    pane = 'channels';
    guideIdx = parkIndex(guide, Date.now());
    markGuide(true);
    repaintAll();
  }

  /* OK does what the programme allows, which is different in each direction of
     time: something finished can be replayed, something on air can be watched,
     and something still to come can only be waited for — so it offers to say
     when it starts. */
  function guideAct() {
    var c = view[chIdx], p = guide[guideIdx];
    if (!c || !p) return;
    var now = Date.now();

    if (p.e <= now) {
      if (!Catchup.available(profile, c, p, now)) {
        U.toast(T('No catch-up for this programme'));
        return;
      }
      leaveGuide();
      C.playProgramme(c, p);
      return;
    }

    if (p.s <= now) {                      // on air: this is just the channel
      leaveGuide();
      C.playProgramme(c, null);
      return;
    }

    toggleReminder(c, p);
  }

  function toggleReminder(c, p) {
    var on = Store.hasReminder(profile.id, c.key, p.s);
    if (on) {
      Store.clearReminder(profile.id, c.key, p.s);
      U.toast(T('Reminder off'));
    } else {
      Store.setReminder(profile.id, {
        chKey: c.key, chName: c.name, start: p.s, stop: p.e, title: p.t,
        /* What the guide says it is, and what the channel looks like: the
           reminder has to be able to introduce the programme hours later,
           by which time the guide may have been rebuilt or dropped. */
        desc: p.d || '', logo: c.logo || ''
      });
      U.toast(T('Reminder set for {time} — {title}',
                { time: U.hhmm(new Date(p.s)), title: p.t }));
    }
    paintGuide(true);
    markGuide(false);
  }

  /* Tune to a channel by key, from outside the list — a reminder firing while
     the cursor is somewhere else entirely, or in another group. */
  C.tuneTo = function (key) {
    var idx = indexOfKey(key);
    if (idx === -1) {
      /* Not in the list as it stands: a group is selected, or a search is on.
         Go back to all channels and look again rather than failing. */
      searchTerm = '';
      U.$('search-input').value = '';
      groupIdx = 0;
      applyGroup();
      idx = indexOfKey(key);
    }
    if (idx === -1) return false;          // locked, or gone from the playlist
    chIdx = idx;
    pane = 'channels';
    play(view[chIdx]);
    repaintAll();
    return true;
  };

  function indexOfKey(key) {
    for (var i = 0; i < view.length; i++) if (view[i].key === key) return i;
    return -1;
  }

  /* ---------------- playback ----------------

     Nothing ever starts on its own. OK on a channel plays it in the panel on
     the right; OK again on that same channel goes fullscreen. Moving the
     cursor never disturbs what is playing — only choosing another channel
     does. */

  function markAnchor(ms) { wallAnchor = ms; anchorReal = Date.now(); }

  /* ---------------- stream health ---------------- */

  function startDriftWatch() {
    stopDriftWatch();
    driftMs = 0;
    lastReal = Date.now();
    lastMedia = Player.elapsed();
    driftTimer = setInterval(sampleDrift, 2000);
  }

  function stopDriftWatch() {
    if (driftTimer) { clearInterval(driftTimer); driftTimer = null; }
    if (bufferTimer) { clearTimeout(bufferTimer); bufferTimer = null; }
    driftMs = 0; buffering = false;
    hideStall();
  }

  function sampleDrift() {
    if (!playingKey) { stopDriftWatch(); return; }
    var now = Date.now();
    var media = Player.elapsed();
    var dReal = now - lastReal;
    var dMedia = (media - lastMedia) * 1000;
    lastReal = now; lastMedia = media;

    // A restart or seek makes the media clock jump; those samples say nothing
    // about health, so discard them rather than counting them as drift.
    if (dMedia < -1000 || dMedia > dReal * 3) return;

    driftMs += Math.max(0, dReal - dMedia);
    paintStall();
  }

  function paintStall() {
    var el = U.$('stall-warn');
    if (!el) return;
    if (!playingKey) { el.classList.add('hidden'); return; }
    /* The warning is anchored to the stage rather than to the browse pane, so
       that it can sit over the video — which also means it does not disappear
       with the pane. Settings, the catch-up browser and a series screen are
       not the place to be told the stream is behind: nothing there is showing
       the stream. It comes back on its own, since the drift is still being
       sampled underneath. */
    if (U.$('view-main').classList.contains('hidden')) {
      el.classList.add('hidden');
      return;
    }

    if (buffering) {
      U.$('stall-text').textContent = 'Buffering';
      el.classList.remove('hidden');
      return;
    }
    // "Behind" only means anything against a live edge.
    if (!playingProg && driftMs >= DRIFT_WARN) {
      U.$('stall-text').textContent = 'Stream is behind  ' +
        Math.round(driftMs / 1000) + 's';
      el.classList.remove('hidden');
      return;
    }
    el.classList.add('hidden');
    setStallFocus(false);
  }

  function hideStall() {
    var el = U.$('stall-warn');
    if (el) el.classList.add('hidden');
    setStallFocus(false);
  }

  function stallVisible() {
    var el = U.$('stall-warn');
    return !!el && !el.classList.contains('hidden');
  }

  /* Only reachable while it is on screen, which means while the info bar is
     up: it is part of the bar, not an overlay of its own. */
  function liveBtnVisible() {
    var el = U.$('osd-back');
    return !!el && !el.classList.contains('hidden') && osdVisible();
  }

  function setLiveFocus(on) {
    liveFocus = !!on;
    var el = U.$('osd-back');
    if (el) el.classList.toggle('focused', liveFocus && !el.classList.contains('hidden'));
  }

  function setStallFocus(on) {
    stallFocus = !!on && stallVisible();
    var el = U.$('stall-warn');
    if (el) el.classList.toggle('focused', stallFocus);
  }

  /* Whether there is anywhere to go back to: replaying something that already
     aired, wound back by hand, or simply so far behind the live edge that the
     stream will not catch up on its own. */
  function isBehind() {
    if (!playingKey) return false;
    if (playingProg) return true;
    if (driftMs >= DRIFT_WARN) return true;
    return (Date.now() - currentWall()) > LIVE_EDGE * 2;
  }

  /* Start the channel again at the live edge. play() re-anchors the clock and
     starts the drift count over, which is exactly what "back to live" means. */
  function backToLive() {
    var c = playingCh;
    if (!c) return;
    setStallFocus(false);
    setLiveFocus(false);
    cancelSeek();
    playingProg = null;
    play(c);
    repaintAll();
    U.toast(T('Back to live'));
    if (fullscreen) showOsd();
  }

  function onBufferingChanged(on) {
    if (on) {
      if (bufferTimer || buffering) return;
      bufferTimer = setTimeout(function () {
        bufferTimer = null;
        buffering = true;
        paintStall();
      }, BUFFER_WARN);
      return;
    }
    if (bufferTimer) { clearTimeout(bufferTimer); bufferTimer = null; }
    buffering = false;
    paintStall();
  }

  /* ---------------- broadcast-time readout ----------------
     The actual time the picture on screen went out. Shown and hidden with the
     info bar — it is part of the same overlay, not a separate persistent one. */

  function paintTsClock(at) {
    var el = U.$('ts-clock');
    if (!el) return;
    if (!fullscreen || !playingCh) { el.classList.add('hidden'); return; }
    var t = at || currentWall();
    if (Date.now() - t < LIVE_EDGE) { el.classList.add('hidden'); return; }
    U.$('ts-day').textContent = dayLabel(t);
    U.$('ts-time').textContent = U.hhmmss(new Date(t));
    el.classList.remove('hidden');
  }

  function startTsClock() {
    paintTsClock();
    if (tsTimer) return;
    // A second is the right granularity: the readout is the point of it.
    tsTimer = setInterval(function () {
      if (seekTimer) return;          // the scrubber owns it while winding
      paintTsClock();
    }, 1000);
  }

  function stopTsClock() {
    if (tsTimer) { clearInterval(tsTimer); tsTimer = null; }
    var el = U.$('ts-clock');
    if (el) el.classList.add('hidden');
  }

  /* The broadcast time currently on screen. */
  function currentWall() {
    if (!wallAnchor) return Date.now();
    return wallAnchor + (Date.now() - anchorReal);
  }

  function progAt(c, ms) {
    var list = (section === 'live' && EPG.hasData()) ? EPG.list(c) : [];
    for (var i = 0; i < list.length; i++) {
      if (list[i].s <= ms && ms < list[i].e) return list[i];
    }
    return null;
  }

  /* How far back, in words. Takes ms so a 30-second step does not round up
     to "1 min" and look like nothing happened. */
  function fmtBack(ms) {
    if (ms < 60000) return T('{n} sec', { n: Math.round(ms / 1000) });
    var mins = Math.round(ms / 60000);
    if (mins < 60) return T('{n} min', { n: mins });
    var h = Math.floor(mins / 60), m = mins % 60;
    if (h < 24) return m ? T('{h}h {m}m', { h: h, m: m }) : T('{h}h', { h: h });
    var d = Math.floor(h / 24), rest = h % 24;
    return rest ? T('{d}d {h}h', { d: d, h: rest }) : T('{d}d', { d: d });
  }

  function play(c) {
    if (!c) return;
    /* The backstop, so nothing can start a locked channel by a path that
       forgot to ask. Callers with more to do afterwards use withPin, and then
       this is already satisfied by the time it gets here. */
    if (needsPin(c)) { withPin(c, function () { play(c); }); return; }
    if (playingKey !== c.key) cancelReconnect();
    playingKey = c.key;
    playingCh = c;
    playingProg = null;
    markAnchor(Date.now());
    Store.pushRecent(profile.id, c.key);
    U.$('preview-spinner').classList.remove('hidden');
    U.$('preview-hint').textContent = '';
    U.$('stage').classList.add('preview-on');
    Player.play(c.url, fullscreen ? 'full' : 'preview');
    paintBadge();
    watchForStall(c);
    startDriftWatch();
    if (fullscreen) showOsd();
  }

  /* Replay something that already aired, if the provider kept a recording. */
  function playCatchup(c, prog) {
    if (needsPin(c)) { withPin(c, function () { playCatchup(c, prog); }); return; }
    var url = Catchup.url(profile, c, prog);
    if (!url) {
      U.toast(Catchup.supported(profile, c)
        ? T('That is outside the recorded window')
        : T('This channel has no catch-up'));
      return;
    }
    playingKey = c.key;
    playingCh = c;
    playingProg = prog;
    markAnchor(prog.s);
    Store.pushRecent(profile.id, c.key);
    U.$('preview-spinner').classList.remove('hidden');
    U.$('preview-hint').textContent = '';
    U.$('stage').classList.add('preview-on');
    Player.play(url, fullscreen ? 'full' : 'preview');
    paintBadge();
    watchForStall(c);
    startDriftWatch();
    if (fullscreen) showOsd();
  }

  /* Resume the same channel from an arbitrary moment — what a scrub commits to. */
  function playAt(c, ms) {
    var now = Date.now();
    if (ms >= now - LIVE_EDGE) { play(c); repaintAll(); return; }
    var url = Catchup.urlAt(profile, c, ms, ms + 4 * 3600000, now);
    if (!url) { U.toast(T(NO_CATCHUP)); return; }
    playingKey = c.key;
    playingCh = c;
    playingProg = progAt(c, ms);
    markAnchor(ms);
    U.$('preview-spinner').classList.remove('hidden');
    U.$('stage').classList.add('preview-on');
    Player.play(url, fullscreen ? 'full' : 'preview');
    paintBadge();
    watchForStall(c);
    startDriftWatch();
    if (fullscreen) showOsd();
  }

  /* ---------------- scrubbing ---------------- */

  /* A recording is moved through; a live channel is restarted from a moment.
     Which one this is comes from the media itself, not from which list the
     channel was in: a film has a duration and a live stream does not. */
  function seekMedia(deltaMs) {
    if (!Player.seekable()) return false;
    var to = Player.seekBy(deltaMs);
    U.toast(U.hms(to) + '  /  ' + U.hms(Player.duration()));
    showOsd();
    return true;
  }

  function scrub(deltaMs) {
    var c = playingCh;
    if (!c) return;
    // Films and episodes seek for real, forwards as well as back.
    if (seekMedia(deltaMs)) return;
    if (!Catchup.supported(profile, c)) {
      U.toast(T(NO_CATCHUP));
      return;
    }
    var now = Date.now();
    var from = seekTimer ? seekTo : currentWall();
    /* Forward from the live edge is forward into nothing: opening the scrubber
       there only to land back where it started reads as the app ignoring the
       key. Show the bar instead, which is what someone pressing a key on a
       live channel is actually after. */
    if (deltaMs > 0 && !seekTimer && now - from < LIVE_EDGE) { showOsd(); return; }
    var lo = Catchup.earliest(profile, c, now) + 60000;
    seekTo = U.clamp(from + deltaMs, lo, now);
    paintSeek();
    if (seekTimer) clearTimeout(seekTimer);
    // Let the viewer hold a key down and land once, rather than restarting the
    // stream on every press.
    seekTimer = setTimeout(commitSeek, 900);
  }

  function commitSeek() {
    if (seekTimer) { clearTimeout(seekTimer); seekTimer = null; }
    hideSeek();
    if (playingCh) playAt(playingCh, seekTo);
  }

  function cancelSeek() {
    if (!seekTimer) return false;
    clearTimeout(seekTimer);
    seekTimer = null;
    hideSeek();
    showOsd();
    return true;
  }

  function paintSeek() {
    var c = playingCh;
    var now = Date.now();

    /* The bar spans a window that grows with how far back you have gone,
       rather than the whole seven days. Fixed to the full window, a fifteen
       minute scrub moves the knob by a fraction of a pixel and looks broken. */
    var oldest = Catchup.earliest(profile, c, now);
    var span = U.clamp(2 * (now - seekTo), 2 * 3600000, Math.max(1, now - oldest));
    var lo = now - span;
    var pct = U.clamp((seekTo - lo) / span * 100, 0, 100);
    U.$('seek-target').textContent = U.hhmmss(new Date(seekTo));
    U.$('seek-delta').textContent = (now - seekTo) < LIVE_EDGE
      ? T('Live') : '-' + fmtBack(now - seekTo);
    U.$('seek-fill').style.width = pct + '%';
    U.$('seek-knob').style.left = pct + '%';
    U.$('seek-lo').textContent = dayLabel(lo) + '  ' + U.hhmm(new Date(lo));
    U.$('seek-day').textContent = dayLabel(seekTo);

    U.$('osd-seek').classList.remove('hidden');
    U.$('osd').classList.remove('hidden');
    U.$('osd').classList.add('seeking');
    if (osdTimer) { clearTimeout(osdTimer); osdTimer = null; }
    paintOsdText(c, seekTo);
    paintTsClock(seekTo);
  }

  function hideSeek() {
    U.$('osd-seek').classList.add('hidden');
    U.$('osd').classList.remove('seeking');
  }

  function cancelReconnect() {
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    reconnects = 0;
  }

  /* Retry whatever was playing, from wherever it was. */
  function reconnectNow() {
    reconnectTimer = null;
    var c = playingCh;
    if (!c) return;
    if (playingProg) playCatchup(c, playingProg);
    else play(c);
  }

  function stopPlayback() {
    cancelReconnect();
    playingKey = null;
    playingCh = null;
    playingProg = null;
    wallAnchor = 0;
    cancelSeek();
    stopTsClock();
    stopDriftWatch();
    clearStallWatch();
    Player.stop();
    U.$('stage').classList.remove('preview-on');
    U.$('preview-spinner').classList.add('hidden');
    U.$('preview-hint').textContent = 'Press OK to play';
    paintBadge();
  }

  /* A stream that cannot be decoded does not always raise an error — it can
     just sit at zero buffered forever, which on screen is an unexplained black
     rectangle. Say something after a sensible wait. */
  var stallTimer = null;
  var STALL_MS = 15000;

  function clearStallWatch() {
    if (stallTimer) { clearTimeout(stallTimer); stallTimer = null; }
  }

  function watchForStall(c) {
    clearStallWatch();
    stallTimer = setTimeout(function () {
      stallTimer = null;
      if (playingKey !== c.key || Player.isPlaying()) return;
      U.$('preview-spinner').classList.add('hidden');
      U.$('stage').classList.remove('preview-on');
      U.$('preview-hint').textContent = U.isTV
        ? (c.name + ' will not start — the stream may be offline')
        : (c.name + ' will not start here — it may be offline, or interlaced, ' +
           'which this browser cannot decode but the TV can');
      if (fullscreen) U.toast(T('Could not start {name}', { name: c.name }));
    }, STALL_MS);
  }

  /* OK on the channel already playing. Nothing restarts — the video plane
     just moves, so going fullscreen is instant. */
  function enterFullscreen() {
    if (!playingKey) return;
    fullscreen = true;
    U.$('stage').classList.add('playing-full');
    Player.setMode('full');
    showOsd();
  }

  /* What the Play button does: the channel in the preview goes full screen
     wherever the cursor has wandered to, and nothing restarts. Only when
     nothing is playing at all does it fall back to the row under the cursor. */
  function watchFullscreen() {
    if (playingKey) { enterFullscreen(); return; }
    var sel = view[chIdx];
    if (!sel) return;
    if (sel.seriesId) { stopPlayback(); SeriesView.open(profile, sel); return; }
    withPin(sel, function () {
      play(sel);
      repaintAll();
      enterFullscreen();
    });
  }

  function leaveFullscreen() {
    fullscreen = false;
    U.$('stage').classList.remove('playing-full');
    hideOsd();
    stopTsClock();
    if (playingKey) Player.setMode('preview');
    // If the stream died while fullscreen, show why rather than a black panel.
    if (!Player.isPlaying()) U.$('stage').classList.remove('preview-on');
    repaintAll();
  }

  /* Fullscreen up/down zaps, which does change the channel. */
  function zapBy(delta) {
    if (!view.length) return;
    chIdx = U.clamp(chIdx + delta, 0, view.length - 1);
    play(view[chIdx]);
    repaintAll();
  }

  /* ---------------- OSD ---------------- */

  /* The text half of the info bar. Split out so the scrubber can refresh it
     without restarting the auto-hide timer. */
  /* What the guide says this programme is. The bar is over a picture someone
     is trying to watch, so it is the programme's own description and nothing
     else — a line of categories, ratings and cast is trivia in the way. */
  function paintOsdDesc(shown) {
    U.$('osd-desc').textContent = (shown && shown.d) ? shown.d : '';
  }

  function paintOsdText(c, atOverride) {
    if (!c) return;
    // While scrubbing, everything reflects where you are heading, not where
    // playback currently is — the whole point is to see it move.
    var at = atOverride || currentWall();
    var behind = Date.now() - at;
    var isLive = behind < LIVE_EDGE;

    /* A recording has no live edge to be at or behind, so it says neither. */
    /* The button belongs to the bar, so it is painted with it: the bar is
       the only place it exists and the only time it can be reached. */
    var back = U.$('osd-back');
    if (back) {
      var showBack = !isLive && !Player.seekable();   // a recording has no live edge
      back.classList.toggle('hidden', !showBack);
      if (!showBack) setLiveFocus(false);
      back.classList.toggle('focused', liveFocus && showBack);
    }
    U.$('osd-num').innerHTML = U.esc('CH ' + (numOf(c) || (chIdx + 1))) +
      (Player.seekable() ? '' :
        '<span class="osd-live' + (isLive ? '' : ' replay') + '">' +
        (isLive ? 'LIVE' : U.esc('-' + fmtBack(behind))) + '</span>');

    U.$('osd-logo').style.backgroundImage = c.logo ? 'url("' + c.logo + '")' : 'none';
    U.$('osd').classList.toggle('no-logo', !c.logo);

    // What was on at the moment being watched, which is not "now" once wound back.
    var prog = isLive ? null : (playingProg || progAt(c, at));
    var nn = (section === 'live' && EPG.hasData()) ? EPG.nowNext(c, at) : null;
    var shown = prog || (nn && nn.now);

    U.$('osd-name').textContent = shown ? shown.t : c.name;

    paintOsdDesc(shown);

    if (shown) {
      U.$('osd-now').innerHTML =
        '<span class="osd-left" id="osd-left">' + U.esc(timeLeft(shown, at)) + '</span>' +
        U.esc(c.name) + '   ·   ' +
        U.esc(U.hhmm(new Date(shown.s)) + '-' + U.hhmm(new Date(shown.e)));
      U.$('osd-bar-fill').style.width = EPG.progress(shown, at) + '%';
      var next = (nn && nn.next) ? nn.next : null;
      U.$('osd-next').innerHTML = next
        ? '<b class="osd-next-tag">Next</b>' + U.esc(U.hhmm(new Date(next.s))) +
          '   ' + U.esc(next.t)
        : '';
    } else if (Player.seekable()) {
      /* A film has no guide entry; how far through it is, is the useful thing. */
      var pos = Player.position(), dur = Player.duration();
      U.$('osd-now').innerHTML =
        '<span class="osd-left">' + U.esc(U.hms(dur - pos) + ' left') + '</span>' +
        U.esc(U.hms(pos) + '  /  ' + U.hms(dur));
      U.$('osd-bar-fill').style.width = (dur ? (pos / dur * 100) : 0) + '%';
      U.$('osd-next').textContent = '';
    } else {
      U.$('osd-now').textContent = c.group || '';
      U.$('osd-bar-fill').style.width = '0%';
      U.$('osd-next').textContent = '';
    }
    U.$('osd-clock').textContent = U.hhmm(new Date());
  }

  function showOsd() {
    var c = playingCh || view[chIdx];
    if (!c) return;
    paintOsdText(c);
    startTsClock();
    U.$('osd').classList.remove('hidden');
    if (osdTimer) clearTimeout(osdTimer);
    var secs = Store.settings().osdSeconds;
    if (secs) osdTimer = setTimeout(hideOsd, secs * 1000);
  }

  function osdVisible() { return !U.$('osd').classList.contains('hidden'); }

  function toggleOsd() {
    if (osdVisible()) hideOsd(); else showOsd();
  }

  function hideOsd() {
    setLiveFocus(false);
    if (osdTimer) { clearTimeout(osdTimer); osdTimer = null; }
    stopTsClock();
    U.$('osd').classList.add('hidden');
  }

  /* ---------------- number zapping ---------------- */

  function pushDigit(d) {
    zapBuf += String(d);
    if (zapBuf.length > 4) zapBuf = zapBuf.slice(-4);
    var z = U.$('zap');
    z.textContent = zapBuf;
    z.classList.remove('hidden');
    if (zapTimer) clearTimeout(zapTimer);
    zapTimer = setTimeout(commitZap, 1600);
  }

  function commitZap() {
    var wanted = parseInt(zapBuf, 10);
    zapBuf = '';
    U.$('zap').classList.add('hidden');
    if (!wanted) return;
    var hit = -1;
    // numOf, not .num — the dial has to follow the numbers the user assigned.
    for (var i = 0; i < view.length; i++) if (numOf(view[i]) === wanted) { hit = i; break; }
    if (hit === -1 && wanted <= view.length) hit = wanted - 1;
    if (hit === -1) { U.toast(T('No channel {n}', { n: wanted })); return; }
    chIdx = hit;
    /* Typing a number is as deliberate as pressing OK on the row, so it plays.
       The rule that nothing starts on its own is about moving the cursor, not
       about asking for a channel by name. */
    play(view[chIdx]);
    repaintAll();
  }

  /* ---------------- search ---------------- */

  function enterSearch() {
    pane = 'search';
    /* The box is out of the way until it is used, and an input that is
       display:none cannot take focus — so reveal it before asking it to. */
    U.$('search-box').classList.remove('hidden');
    U.$('list-title').classList.add('hidden');
    var el = U.$('search-input');
    el.classList.add('focused');
    el.focus();
    repaintFocusOnly();
  }

  function exitSearch() {
    var el = U.$('search-input');
    el.classList.remove('focused');
    el.blur();
    pane = 'channels';
    repaintAll();
  }

  var onSearchInput = U.debounce(function () {
    searchTerm = U.$('search-input').value.trim();
    applyGroup();
  }, 260);

  C.bindSearch = function () {
    U.$('search-input').addEventListener('input', onSearchInput, false);
  };

  /* ---------------- the clock over the list ----------------

     A television is also the thing people look at to find out the time, and
     the head of the channel list is the emptiest, most looked-at strip on the
     screen. The name of the list moves under it rather than away: it still
     has to say which list this is, it just is not the headline.

     Ticked every ten seconds rather than every minute, because a clock that
     is a minute behind is worse than no clock — and a text write costs
     nothing next to what the guide tick already does. */
  function paintClock() {
    var el = U.$('head-clock');
    if (!el) return;
    var d = new Date();
    el.textContent = U.hhmm(d);
    U.$('head-date').textContent = dateString(d);
  }

  function dateString(d) {
    var f = 'long';
    try { f = Store.settings().dateFormat || 'long'; } catch (e) {}
    return U.dateLabel(d, f);
  }

  /* ---------------- timers ---------------- */

  function startTimers() {
    paintClock();
    if (clockTimer) clearInterval(clockTimer);
    clockTimer = setInterval(function () {
      paintClock();
      if (!U.$('osd').classList.contains('hidden')) U.$('osd-clock').textContent = U.hhmm(new Date());
    }, 10000);

    if (epgTimer) clearInterval(epgTimer);
    epgTimer = setInterval(function () {
      if (fullscreen || section !== 'live' || !EPG.hasData()) return;
      chList.render();
      paintGuide(true);    // refresh the progress bar on what is on now
      paintPreviewMeta();
    }, 30000);
  }

  /* Called when the setting changes, and on every show(). */
  C.applyRowStyle = function () {
    var on = false;
    try { on = !!Store.settings().altRows; } catch (e) {}
    if (on === altRows) return;
    altRows = on;
    if (chList) { chList.invalidate(); repaintAll(); }
  };

  C.onEpgReady = function () {
    if (!chList) return;
    chList.invalidate();   // rewrite rows so the now/next line appears
    guideKey = null;       // and so the guide panel picks up the new data
    repaintAll();
  };

  /* ---------------- player events ---------------- */

  C.onPlayerEvent = function (type, arg) {
    if (type === 'playing') {
      clearStallWatch();
      cancelReconnect();          // it worked, so start the count over
      onBufferingChanged(false);
      U.$('preview-spinner').classList.add('hidden');
      /* The picture is on screen, which is the first moment a TV will accept a
         display rect. If the viewer pressed OK for fullscreen while the stream
         was still opening, AVPlay refused it then — this is where it lands. */
      Player.settle();
      return;
    }
    if (type === 'buffering') {
      if (!fullscreen) U.$('preview-spinner').classList.toggle('hidden', !arg);
      onBufferingChanged(!!arg);
      return;
    }
    if (type === 'error') {
      clearStallWatch();
      U.$('preview-spinner').classList.add('hidden');
      // Xtream servers differ on whether the path contains /live/. Retry once.
      // Live only: a movie's /movie/<id>.<container> URL must never be rebuilt
      // as a live one, which would silently swap the container too.
      // The channel that failed is the one PLAYING, which since playback became
      // independent of the cursor is not necessarily view[chIdx].
      var c = playingCh;
      if (c && (c.kind || 'live') === 'live' && profile.type === 'xtream' && c.streamId != null) {
        var alt = Xtream.liveUrlLegacy(profile, c.streamId, extFor());
        if (alt !== Player.currentUrl() && Player.retryWith(alt)) return;
      }
      /* A dropped stream is usually transient — the provider hiccups, the
         segment 404s once. Retrying beats making the viewer press OK again.
         Never for a decode failure: that will fail identically every time. */
      if (Store.settings().autoReconnect && !Player.isDecodeError(arg) &&
          playingCh && reconnects < MAX_RECONNECT && !reconnectTimer) {
        reconnects++;
        U.$('preview-hint').textContent =
          T('Reconnecting… ({n}/{of})', { n: reconnects, of: MAX_RECONNECT });
        U.$('stage').classList.remove('preview-on');
        if (fullscreen) U.toast(T('Reconnecting…'));
        reconnectTimer = setTimeout(reconnectNow, RECONNECT_WAIT);
        return;
      }

      // Set the hint either way, so leaving fullscreen does not drop back to a
      // black panel with no explanation. Say *why* when we know: "unavailable"
      // is misleading for a stream the browser simply refuses to decode.
      U.$('preview-hint').textContent = Player.isDecodeError(arg)
        ? T(arg)
        : (c ? T('{name} is unavailable', { name: c.name }) : T('Unavailable'));
      if (fullscreen) U.toast(arg || T('Playback failed'));
      else U.$('stage').classList.remove('preview-on');
    }
  };

  function extFor() {
    var s = Store.settings();
    return Xtream.pickFormat(profile.formats, s.streamFormat);
  }

  /* ---------------- key handling ---------------- */

  C.key = function (e) {
    var a = e.action;

    if (pane === 'ctx') {
      switch (a) {
        case 'up':    ctxIdx = U.clamp(ctxIdx - 1, 0, CTX.length - 1); paintCtx(); return;
        case 'down':  ctxIdx = U.clamp(ctxIdx + 1, 0, CTX.length - 1); paintCtx(); return;
        case 'ok':    if (CTX[ctxIdx]) CTX[ctxIdx].run(); return;
        case 'left':
        case 'right':
        case 'back':
        case 'exit':  closeCtx(); return;
        default: return;
      }
    }

    /* Play means "watch it big", from anywhere on the browse screen and
       whatever the cursor is sitting on. OK cannot do this: on any row but
       the one playing, OK means "play that one instead", so the picture
       already running needs a button of its own. With nothing playing yet it
       starts whatever is under the cursor - the button always ends up at a
       full-screen picture. */
    if (a === 'play' || a === 'playPause') {
      if (pane === 'search') exitSearch();   // never leave the field focused
      if (pane === 'menu') closeMenu();
      watchFullscreen();
      return;
    }

    if (pane === 'search') {
      if (a === 'back' || a === 'up') { exitSearch(); return; }
      if (a === 'ok' || a === 'down') { exitSearch(); return; }
      return;
    }

    if (fullscreen) {
      /* The stream warning is reachable: up puts the cursor on it, OK jumps
         back to live. Anything else lets it go and carries on as normal. */
      if (stallFocus) {
        if (a === 'ok') { backToLive(); return; }
        setStallFocus(false);
        if (a === 'down' || a === 'back' || a === 'up') return;
      } else if (a === 'up' && stallVisible()) {
        setStallFocus(true);
        return;
      } else if (liveFocus) {
        if (a === 'ok') { setLiveFocus(false); backToLive(); return; }
        setLiveFocus(false);
        if (a === 'up' || a === 'down') return;   // the press that let it go
      } else if (a === 'up' && liveBtnVisible()) {
        setLiveFocus(true);
        showOsd();                    // keep the bar up while it is being aimed at
        return;
      }

      switch (a) {
        /* Back takes one layer off at a time: a scrub in progress first, then
           the info bar if it is up, and only then fullscreen itself. Someone
           who pressed OK to see what is on should not have to leave the
           picture to put the bar away again. EXIT is the blunt one. */
        case 'back':      if (cancelSeek()) return;
                          if (osdVisible()) { hideOsd(); return; }
                          leaveFullscreen(); return;
        case 'exit':      if (cancelSeek()) return; leaveFullscreen(); return;
        case 'up':        if (Store.settings().arrowZap) zapBy(-1); else showOsd(); return;
        case 'down':      if (Store.settings().arrowZap) zapBy(1); else showOsd(); return;
        case 'chanUp':    zapBy(-1); return;
        case 'chanDown':  zapBy(1); return;
        // Wind back and forth through what the provider still holds.
        case 'left':      scrub(-SEEK_STEP); return;
        /* On a recording, right is fast-forward — there is something to go
           forward into. On a live channel there is not, so right is the
           channel panel instead, the same as it is in the list. */
        case 'right':
          if (Player.seekable() || seekTimer) { scrub(SEEK_STEP); return; }
          openCtx(); return;
        case 'rew':       scrub(-SEEK_JUMP); return;
        case 'ff':        scrub(SEEK_JUMP); return;
        case 'ok':        if (seekTimer) { commitSeek(); return; } toggleOsd(); return;
        case 'play':
        case 'playPause': if (seekTimer) { commitSeek(); return; } showOsd(); return;
        case 'info':      showOsd(); return;
        case 'red':       toggleFav(); return;
        case 'yellow':    App.openSettings(); return;
        case 'digit':     pushDigit(e.digit); return;
        case 'stop':      leaveFullscreen(); return;
        default: return;
      }
    }

    if (pane === 'menu') {
      switch (a) {
        case 'up':    menuIdx = U.clamp(menuIdx - 1, 0, MENU.length - 1); paintMenu(); return;
        case 'down':  menuIdx = U.clamp(menuIdx + 1, 0, MENU.length - 1); paintMenu(); return;
        case 'ok':    if (MENU[menuIdx]) MENU[menuIdx].run(); return;
        case 'left':
        case 'right':
        case 'back':
        case 'exit':  closeMenu(); return;
        default: return;
      }
    }

    if (pane === 'sections') {
      switch (a) {
        case 'left':   stepSection(-1); return;
        case 'right':  stepSection(1); return;
        case 'down':
        case 'ok':
        case 'back':   pane = 'groups'; paintSections(); repaintAll(); return;
        case 'up':     return;
        case 'yellow': App.openSettings(); return;
        case 'blue':   App.refreshPlaylist(); return;
        case 'exit':   U.confirm(T('Exit AquaPlay?'), function (yes) { if (yes) Keys.exitApp(); }); return;
        default: return;
      }
    }

    /* The guide panel under the player is somewhere to go again, but not by
       stealing right from the channel list — right is about the channel, and
       the schedule is one of the things the channel panel offers. The ways in
       are INFO (one press, no menu) and "Schedule" in that panel.

       Up and down walk the five programmes; OK does whatever that programme
       allows — replay one that has finished, watch the one on air, be reminded
       about one that has not started. Anything else falls through to the
       browse screen below, so the colour keys and the number pad still work
       from in here. */
    if (pane === 'epg') {
      switch (a) {
        case 'up':
          if (guideIdx > 0) { guideIdx--; markGuide(true); }
          else leaveGuide();               // out of the top is back to the list
          return;
        case 'down':
          if (guideIdx < guide.length - 1) { guideIdx++; markGuide(true); }
          return;
        case 'ok':     guideAct(); return;
        case 'left':
        case 'back':
        case 'info':   leaveGuide(); return;
        case 'right':  return;             // there is nothing to the right of it
        default: break;                    // everything else: the browse screen
      }
    }

    switch (a) {
      /* The list wraps: the last channel is one press up from the first, and
         the first is one press down from the last. On a list of a thousand
         channels the ends are a long way apart otherwise. Search moved to the
         green button and the drawer, which is where people look for it. */
      case 'up':
        if (pane === 'groups') {
          if (railFoot > 0) { railFoot--; repaintAll(); return; }
          if (railFoot === 0) { railFoot = -1; repaintAll(); return; }
          if (groupIdx === 0 && anySections()) { pane = 'sections'; paintSections(); repaintAll(); return; }
          groupIdx = U.clamp(groupIdx - 1, 0, groups.length - 1); applyGroup();
        }
        else if (!view.length) { return; }
        else if (chIdx === 0) { chIdx = view.length - 1; repaintAll(); }
        else { chIdx--; repaintFocusOnly(); }
        return;

      case 'down':
        if (pane === 'groups') {
          if (railFoot >= 0) {
            if (railFoot < RAIL_FEET.length - 1) { railFoot++; repaintAll(); }
            return;
          }
          if (groupIdx >= groups.length - 1) { railFoot = 0; repaintAll(); return; }
          groupIdx = U.clamp(groupIdx + 1, 0, groups.length - 1); applyGroup();
        }
        else if (!view.length) { return; }
        else if (chIdx >= view.length - 1) { chIdx = 0; repaintAll(); }
        else { chIdx++; repaintFocusOnly(); }
        return;

      case 'left':
        // Moving around never touches playback any more.
        if (pane === 'channels') { pane = 'groups'; railFoot = -1; repaintAll(); return; }
        if (pane === 'groups') openMenu();
        return;

      case 'right':
        if (pane === 'groups') { pane = 'channels'; railFoot = -1; repaintAll(); return; }
        /* Right is about the channel, not about its schedule — the schedule
           is one of the things the panel offers. */
        if (pane === 'channels' && view[chIdx]) { openCtx(); return; }
        return;

      case 'ok':
        if (pane === 'groups' && railFoot === 0) { App.openSettings(); return; }
        if (pane === 'groups') { pane = 'channels'; railFoot = -1; repaintAll(); return; }
        var sel = view[chIdx];
        if (!sel) return;
        // An Xtream series has no stream of its own — open its episodes.
        if (sel.seriesId) { stopPlayback(); SeriesView.open(profile, sel); return; }
        // Already playing this one: OK is "make it bigger", not "restart".
        if (sel.key === playingKey) { enterFullscreen(); return; }
        play(sel);
        repaintAll();
        return;

      case 'chanUp':   chIdx = U.clamp(chIdx - 10, 0, Math.max(0, view.length - 1)); repaintAll(); return;
      case 'chanDown': chIdx = U.clamp(chIdx + 10, 0, Math.max(0, view.length - 1)); repaintAll(); return;
      case 'home':     chIdx = 0; repaintAll(); return;
      case 'end':      chIdx = Math.max(0, view.length - 1); repaintAll(); return;

      case 'stop':   if (playingKey) { stopPlayback(); repaintAll(); } return;
      case 'red':    toggleFav(); return;
      case 'green':  enterSearch(); return;
      case 'blue':   App.refreshPlaylist(); return;
      // INFO focuses the guide beside the player; the Guide button opens the
      // full catch-up browser, which is what it is for.
      case 'guide':  openReplay(); return;
      case 'yellow': App.openSettings(); return;
      /* INFO is the one-press way into the guide panel: what is on, and the
         only place a reminder can be set. It used to be a toast that repeated
         the row the cursor was already on. */
      case 'info':   enterGuide(); return;
      case 'digit':  pushDigit(e.digit); return;

      case 'back':
        if (pane === 'channels' && searchTerm) {
          searchTerm = ''; U.$('search-input').value = ''; applyGroup(); return;
        }
        if (pane === 'channels' && groupIdx !== 0) { groupIdx = 0; applyGroup(); return; }
        if (pane === 'channels') { pane = 'groups'; repaintAll(); return; }
        U.confirm(T('Exit AquaPlay?'), function (yes) { if (yes) Keys.exitApp(); });
        return;

      case 'exit':
        U.confirm(T('Exit AquaPlay?'), function (yes) { if (yes) Keys.exitApp(); });
        return;
    }
  };

  /* ---------------- what you can do with a channel ----------------

     Right from the channel list opens a panel down the right-hand edge, the
     way Clouddy does it: the things you would want to do with the channel
     under the cursor. Its schedule is not one of them — the panel under the
     preview is something to read, not somewhere to go. */

  var CTX = [], ctxIdx = 0;

  function openCtx() {
    var c = view[chIdx];
    if (!c) return;
    var playing = (c.key === playingKey);
    var locked = Store.isLocked(profile.id, c.key);

    CTX = [];
    if (fullscreen) {
      if (isBehind()) CTX.push({ icon: '🔴', label: T('Back to live'), run: backToLive });
      CTX.push({ icon: '⇲', label: T('Leave full screen'),
                 run: function () { closeCtx(); leaveFullscreen(); } });
    } else {
      CTX.push({
        icon: '▶',
        label: playing ? T('Go full screen') : T('Watch full screen'),
        run: function () {
          closeCtx();
          if (playing) { enterFullscreen(); return; }
          withPin(c, function () { play(c); repaintAll(); enterFullscreen(); });
        }
      });
      if (playing && isBehind()) CTX.push({ icon: '🔴', label: T('Back to live'), run: backToLive });
    }
    /* The way into the guide panel that does not need a key to be known. */
    if (!fullscreen) {
      CTX.push({ icon: '🗓', label: T('Schedule'),
                 run: function () { closeCtx(); enterGuide(); } });
    }
    CTX.push({ icon: '📺', label: T('Catch-up guide'),
               run: function () { closeCtx(); openReplay(); } });
    CTX.push({
      icon: '⭐',
      label: Store.isFav(profile.id, c.key) ? T('Remove from favourites') : T('Add to favourites'),
      run: function () { closeCtx(); toggleFav(); }
    });
    CTX.push({ icon: '🔢', label: T('Change channel number'),
               run: function () { closeCtx(); editNumber(c); } });
    /* Parental control, one channel at a time. The adult filter is a guess at
       a name; this is the viewer pointing at a channel. */
    CTX.push({
      icon: locked ? '🔓' : '🔒',
      label: locked ? T('Unlock this channel') : T('Lock with PIN'),
      run: function () { closeCtx(); toggleLock(c); }
    });

    ctxIdx = 0;
    pane = 'ctx';
    U.$('cm-title').textContent = c.name;
    U.$('cm-sub').textContent = (numOf(c) ? 'Channel ' + numOf(c) : '') +
      (c.group ? (numOf(c) ? '   ·   ' : '') + c.group : '');
    paintCtx();
    U.$('ctxmenu').classList.remove('hidden');
    repaintAll();
  }

  /* The icon is its own column, never part of the label: if a set turns out to
     have no glyph for one of these, the row loses a picture and keeps its
     words, rather than growing a tofu box in the middle of a sentence. */
  function rowsHtml(items, sel, cls) {
    var html = '';
    for (var i = 0; i < items.length; i++) {
      html += '<div class="' + cls + (i === sel ? ' focused' : '') + '">' +
              '<span class="mi-ico">' + U.esc(items[i].icon || '') + '</span>' +
              '<span class="mi-label">' + U.esc(items[i].label) + '</span></div>';
    }
    return html;
  }

  function paintCtx() {
    U.$('cm-list').innerHTML = rowsHtml(CTX, ctxIdx, 'cm-row');
  }

  function closeCtx() {
    U.$('ctxmenu').classList.add('hidden');
    if (pane === 'ctx') pane = 'channels';
    repaintAll();
  }

  /* ---------------- left-arrow drawer ----------------
     The app-level things that are not about the channel under the cursor. */

  var MENU = [], menuIdx = 0;

  /* Favourites and Recently watched used to be here. They are the first two
     rows of the groups rail, and this drawer opens by going left past that
     rail — so they offered to send somebody back to the thing they had just
     walked through. What is left is only what is nowhere else. */
  function openMenu() {
    MENU = [
      { icon: '🔍', label: T('Search'),           run: function () { closeMenu(); enterSearch(); } },
      { icon: '🗓', label: T('TV catalogue'),     run: function () { closeMenu(); CatalogView.open(profile); } },
      { icon: '📺', label: T('Catch-up'),         run: function () { closeMenu(); openReplay(); } },
      { icon: '⚙️', label: T('Settings'),         run: function () { closeMenu(); App.openSettings(); } },
      { icon: '🔄', label: T('Reload playlist'),  run: function () { closeMenu(); App.refreshPlaylist(); } }
    ];
    if (!U.isTV) {
      MENU.push({ icon: '⌨️', label: T('Keyboard keys'), run: function () { closeMenu(); U.help(); } });
    }
    MENU.push({ icon: '🚪', label: T('Exit'), run: function () {
      closeMenu();
      U.confirm(T('Exit AquaPlay?'), function (yes) { if (yes) Keys.exitApp(); });
    } });

    menuIdx = 0;
    pane = 'menu';
    paintMenu();
    U.$('sidemenu').classList.remove('hidden');
  }

  function closeMenu() {
    U.$('sidemenu').classList.add('hidden');
    if (pane === 'menu') pane = 'groups';
    repaintAll();
  }

  function paintMenu() {
    U.$('sm-list').innerHTML = rowsHtml(MENU, menuIdx, 'sm-row');
    U.$('sm-foot').textContent = (profile && profile.name ? profile.name + '   ·   ' : '') +
      all.length + ' channels';
  }

  function openReplay() {
    var c = view[chIdx];
    if (!c) return;
    if (section !== 'live') { U.toast(T('Catch-up is for live channels')); return; }
    ReplayView.open(profile, c);
  }

  /* Play a specific programme, or the channel live when prog is null. Used by
     the catch-up browser, which hands back here rather than duplicating the
     player, badge, info bar and scrubbing. */
  C.playProgramme = function (c, prog) {
    if (!c) return;
    var idx = -1;
    for (var i = 0; i < view.length; i++) if (view[i].key === c.key) { idx = i; break; }
    if (idx > -1) chIdx = idx;
    withPin(c, function () {
      if (prog) playCatchup(c, prog); else play(c);
      repaintAll();
      if (!fullscreen) enterFullscreen();
    });
  };

  function toggleFav() {
    var c = view[chIdx];
    if (!c) return;
    var on = Store.toggleFav(profile.id, c.key);
    U.toast(on ? T('★ Added to favourites') : T('Removed from favourites'));
    var g = groups[groupIdx];
    if (g && g.kind === 'fav') applyGroup();
    else { chList.invalidate(); repaintAll(); }
  }

  /* Resume the last watched channel on startup. */
  C.resumeLast = function () {
    var key = Store.lastChannel(profile.id);
    if (!key || !byKey[key]) return false;
    var idx = -1;
    for (var i = 0; i < view.length; i++) if (view[i].key === key) { idx = i; break; }
    if (idx === -1) return false;
    /* Never demand a PIN at launch: a locked channel is simply not resumed.
       Asking for one before the app has drawn itself is an interrogation. */
    if (needsPin(view[idx])) return false;
    chIdx = idx;
    play(view[chIdx]);
    repaintAll();
    return true;
  };

  w.Channels = C;
})(window);

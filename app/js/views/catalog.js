/* views/catalog.js — the TV catalogue: every channel, and its whole schedule.

   The guide panel beside the player shows nine programmes of the channel under
   the cursor, which is a glance. The catch-up browser shows one channel's past.
   Neither lets somebody sit down and read an evening, and that is what this is:
   channels down the left, and the schedule of whichever one is selected down
   the right, as far ahead as the guide reaches.

   The left column is the whole playlist, so it is windowed the same way the
   channel list is — a fixed pool of rows, moved and refilled. The right column
   is one channel's programmes, which is tens rather than thousands, so it is
   painted whole and only when the channel changes. Moving the cursor down a
   schedule must not rebuild the schedule. */
(function (w) {
  'use strict';

  var G = {};

  var profile = null;
  var list    = [];       // channels, in the order the browse list has them
  var chIdx   = 0;
  var progs   = [];       // the selected channel's programmes
  var progIdx = 0;
  var pane    = 'channels';   // channels | progs
  var builtFor = null;        // the channel key the schedule belongs to

  var CH_H = 84, PROG_H = 88, POOL = 16;
  var pool = [];
  var chTop = 0;

  function q(id) { return U.$(id); }
  function channel() { return list[chIdx] || null; }

  /* ---------------- open ---------------- */

  G.open = function (p) {
    profile = p;
    if (!EPG.hasData()) { U.toast(T('No guide loaded yet')); return; }

    /* The same channels the browse list shows, minus anything hidden: a
       category kept out of the list would be a hole in the catalogue. */
    list = Channels.channels().filter(function (c) {
      return !Store.isHiddenChannel(profile.id, c);
    });
    if (!list.length) { U.toast(T('No channels here')); return; }

    /* Open on the channel being watched if there is one, so the catalogue
       starts where the viewer already is rather than at the top of a list of
       five thousand. */
    var playing = Channels.playingKey();
    chIdx = 0;
    for (var i = 0; i < list.length; i++) {
      if (list[i].key === playing) { chIdx = i; break; }
    }
    chTop = 0;
    progIdx = 0;
    pane = 'progs';
    builtFor = null;

    ensurePool();
    paintChannels();
    fill();
    App.enterCatalog();
  };

  G.show = function () { q('view-catalog').classList.remove('hidden'); };
  G.hide = function () { q('view-catalog').classList.add('hidden'); };

  /* ---------------- the channel column ---------------- */

  function ensurePool() {
    if (pool.length) return;
    var host = q('cg-chans');
    for (var i = 0; i < POOL; i++) {
      var d = document.createElement('div');
      d.className = 'cg-chan';
      d.style.display = 'none';
      d.innerHTML =
        '<span class="cg-num"></span>' +
        '<span class="cg-logo"></span>' +
        '<span class="cg-chname"></span>';
      host.appendChild(d);
      pool.push(d);
    }
  }

  function chViewport() {
    var box = q('cg-chans-box');
    return (box && box.clientHeight) || (10 * CH_H);
  }

  function paintChannels() {
    var h = chViewport();
    var margin = CH_H * 2;
    var y = chIdx * CH_H;
    if (y - margin < chTop) chTop = Math.max(0, y - margin);
    if (y + CH_H + margin > chTop + h) {
      chTop = Math.min(Math.max(0, list.length * CH_H - h), y + CH_H + margin - h);
    }

    var host = q('cg-chans');
    host.style.transform = 'translateY(' + (-chTop) + 'px)';
    var first = Math.max(0, Math.floor(chTop / CH_H) - 1);
    var playing = Channels.playingKey();

    for (var i = 0; i < POOL; i++) {
      var idx = first + i;
      var el = pool[i];
      var c = list[idx];
      if (!c) { el.style.display = 'none'; continue; }
      el.style.display = '';
      el.style.top = (idx * CH_H) + 'px';
      el.children[0].textContent = Channels.numberOf(c) || (idx + 1);
      el.children[1].style.backgroundImage = c.logo ? 'url("' + c.logo + '")' : 'none';
      el.children[1].classList.toggle('blank', !c.logo);
      el.children[2].textContent = c.name;
      el.className = 'cg-chan' +
        (idx === chIdx ? ' selected' : '') +
        (idx === chIdx && pane === 'channels' ? ' focused' : '') +
        (c.key === playing ? ' playing' : '');
    }
    q('cg-chan-count').textContent = list.length ? (chIdx + 1) + ' / ' + list.length : '';
  }

  /* ---------------- the schedule ---------------- */

  /* Only when the channel actually changed. Walking the cursor down a hundred
     programmes must not rebuild them a hundred times. */
  function fill() {
    var c = channel();
    var key = c ? c.key : null;
    if (builtFor !== key) {
      progs = c ? EPG.list(c) : [];
      builtFor = key;
      progIdx = Math.max(0, EPG.indexAt(progs, Date.now()));
      paintProgs();
      return;
    }
    markProgs();
  }

  function paintProgs() {
    var now = Date.now();
    var html = '';
    var lastDay = '';

    for (var i = 0; i < progs.length; i++) {
      var p = progs[i];
      var day = dayLabel(p.s, now);
      if (day !== lastDay) {
        html += '<div class="cg-day">' + U.esc(day) + '</div>';
        lastDay = day;
      }
      var cls = 'cg-prog';
      if (p.s <= now && now < p.e) cls += ' now';
      else if (p.e <= now) cls += ' past';
      var mins = Math.max(1, Math.round((p.e - p.s) / 60000));
      html += '<div class="' + cls + '" data-i="' + i + '">' +
                '<span class="cg-ptime">' + U.hhmm(new Date(p.s)) + '</span>' +
                '<span class="cg-pbody">' +
                  '<span class="cg-pname">' + U.esc(p.t) + '</span>' +
                  '<span class="cg-psub">' + T('{n} min', { n: mins }) + '</span>' +
                '</span>' +
              '</div>';
    }

    q('cg-progs').innerHTML = html;
    q('cg-empty').classList.toggle('hidden', progs.length > 0);
    markProgs();
  }

  /* Which programmes are which day, so a schedule that runs past midnight says
     so rather than counting back to nine in the morning without explanation. */
  function dayLabel(ms, now) {
    var d = new Date(ms), t = new Date(now);
    var same = d.getDate() === t.getDate() && d.getMonth() === t.getMonth();
    if (same) return T('Today');
    var tm = new Date(now + 86400000);
    if (d.getDate() === tm.getDate() && d.getMonth() === tm.getMonth()) return T('Tomorrow');
    return T(DAYS[d.getDay()]) + '  ' + d.getDate() + ' ' + T(MONTHS[d.getMonth()]);
  }

  var DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  function markProgs() {
    var host = q('cg-progs');
    var kids = host.children;
    var focusedEl = null;
    for (var i = 0; i < kids.length; i++) {
      var el = kids[i];
      if (el.className.indexOf('cg-day') > -1) continue;
      var on = pane === 'progs' && +el.getAttribute('data-i') === progIdx;
      el.classList.toggle('focused', on);
      el.classList.toggle('reminded', reminded(+el.getAttribute('data-i')));
      if (on) focusedEl = el;
    }
    q('cg-scroller').classList.toggle('active', pane === 'progs');

    var c = channel();
    q('cg-title').textContent = c ? c.name : '';
    q('cg-count').textContent = progs.length ? (progIdx + 1) + ' / ' + progs.length : '';

    /* The day headings make the rows an uneven ladder, so where a programme is
       has to be read off the element rather than worked out from an index. */
    if (focusedEl) {
      var box = q('cg-scroller');
      var h = box.clientHeight || 800;
      var y = focusedEl.offsetTop, hh = focusedEl.offsetHeight;
      var top = scrollTop;
      if (y - PROG_H < top) top = Math.max(0, y - PROG_H);
      if (y + hh + PROG_H > top + h) top = y + hh + PROG_H - h;
      scrollTop = Math.max(0, Math.min(top, Math.max(0, host.offsetHeight - h)));
      host.style.transform = 'translateY(' + (-scrollTop) + 'px)';
    }
  }

  var scrollTop = 0;

  function reminded(i) {
    var c = channel(), p = progs[i];
    if (!c || !p) return false;
    return p.s > Date.now() && Store.hasReminder(profile.id, c.key, p.s);
  }

  /* ---------------- keys ---------------- */

  G.key = function (e) {
    var a = e.action;

    if (pane === 'channels') {
      switch (a) {
        case 'up':    step(-1); return;
        case 'down':  step(1); return;
        case 'chanUp':   step(-10); return;
        case 'chanDown': step(10); return;
        case 'home':  chIdx = 0; scrollTop = 0; paintChannels(); fill(); return;
        case 'end':   chIdx = list.length - 1; scrollTop = 0; paintChannels(); fill(); return;
        case 'right':
        case 'ok':    pane = 'progs'; paintChannels(); markProgs(); return;
        case 'left':
        case 'back':
        case 'exit':  App.closeCatalog(); return;
        case 'digit': return;
        default: return;
      }
    }

    switch (a) {
      case 'up':
        if (progIdx === 0) { pane = 'channels'; paintChannels(); markProgs(); return; }
        progIdx--; markProgs(); return;
      case 'down':
        progIdx = U.clamp(progIdx + 1, 0, Math.max(0, progs.length - 1));
        markProgs(); return;
      case 'chanUp':   step(-1); return;
      case 'chanDown': step(1); return;
      case 'left':  pane = 'channels'; paintChannels(); markProgs(); return;
      case 'ok':    choose(); return;
      case 'back':
      case 'exit':  App.closeCatalog(); return;
    }
  };

  function step(by) {
    chIdx = U.clamp(chIdx + by, 0, list.length - 1);
    scrollTop = 0;
    paintChannels();
    fill();
  }

  /* The same rule the guide panel uses: watch it if it is on, replay it if the
     provider kept it, be reminded if it has not started. */
  function choose() {
    var c = channel(), p = progs[progIdx];
    if (!c || !p) return;
    var now = Date.now();

    if (p.s <= now && now < p.e) {
      App.closeCatalog();
      Channels.tuneTo(c.key);
      return;
    }

    if (p.e <= now) {
      if (!Catchup.available(profile, c, p, now)) {
        U.toast(Catchup.supported(profile, c)
          ? T('That is outside the recorded window')
          : T('This channel has no catch-up'));
        return;
      }
      App.closeCatalog();
      Channels.playProgramme(c, p);
      return;
    }

    if (Store.hasReminder(profile.id, c.key, p.s)) {
      Store.clearReminder(profile.id, c.key, p.s);
      U.toast(T('Reminder off'));
      markProgs();
      return;
    }
    Store.setReminder(profile.id, {
      chKey: c.key, chName: c.name, start: p.s, stop: p.e,
      title: p.t, desc: p.d || '', logo: c.logo || ''
    });
    U.toast(T('Reminder set for {time} — {title}',
              { time: U.hhmm(new Date(p.s)), title: p.t }));
    markProgs();
  }

  w.CatalogView = G;
})(window);

/* views/catalog.js — the TV catalog: every channel, a day, its schedule.

   Three columns of narrowing choice. The channels down the left, the days that
   channel's guide covers across the top, and what is on that day underneath.
   The guide panel beside the player shows nine programmes of one channel,
   which is a glance; this is for reading an evening.

   It was one long list grouped by day headings, which meant scrolling past
   everything you did not want to reach tomorrow. Picking the day first is
   fewer presses and, more to the point, it is how somebody thinks about it.

   The channel column is the whole playlist, so it is windowed the same way the
   channel list is — a fixed pool of rows, moved and refilled. A day's schedule
   is tens of programmes, so it is painted whole, and only when the channel or
   the day changes: walking the cursor down a schedule must not rebuild it. */
(function (w) {
  'use strict';

  var G = {};

  var profile = null;
  var list    = [];       // channels, in the order the browse list has them
  var chIdx   = 0;
  var progs   = [];       // the selected channel's whole schedule
  var days    = [];       // [{key, label, items:[programme]}]
  var dayIdx  = 0;
  var progIdx = 0;
  var pane    = 'channels';   // channels | days | progs
  var builtFor = null;        // the channel key the schedule belongs to

  var CH_H = 84, PROG_H = 88, POOL = 16;
  var pool = [];
  var chTop = 0;
  var scrollTop = 0;

  var DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  function q(id) { return U.$(id); }
  function channel() { return list[chIdx] || null; }
  function today() { return (days[dayIdx] && days[dayIdx].items) || []; }

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

    /* Open on the channel being watched, so the catalogue starts where the
       viewer already is rather than at the top of a list of thousands. */
    var playing = Channels.playingKey();
    chIdx = 0;
    for (var i = 0; i < list.length; i++) {
      if (list[i].key === playing) { chIdx = i; break; }
    }
    chTop = 0;
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

  /* ---------------- days ---------------- */

  function dayKey(ms) {
    var d = new Date(ms);
    return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate();
  }

  function dayLabel(ms, now) {
    var d = new Date(ms), t = new Date(now);
    if (dayKey(ms) === dayKey(now)) return T('Today');
    if (dayKey(ms) === dayKey(now + 86400000)) return T('Tomorrow');
    if (dayKey(ms) === dayKey(now - 86400000)) return T('Yesterday');
    return T(DAYS[d.getDay()]) + ' ' + d.getDate() + ' ' + T(MONTHS[d.getMonth()]);
  }

  /* Split the schedule into the days it covers, in order. A guide that runs to
     next week gets a day each; one that only has tonight gets one. */
  function buildDays(now) {
    var out = [], byKey = {};
    for (var i = 0; i < progs.length; i++) {
      var k = dayKey(progs[i].s);
      if (!byKey[k]) {
        byKey[k] = { key: k, label: dayLabel(progs[i].s, now), items: [] };
        out.push(byKey[k]);
      }
      byKey[k].items.push(progs[i]);
    }
    return out;
  }

  function paintDays() {
    var html = '';
    for (var i = 0; i < days.length; i++) {
      html += '<span class="cg-daychip' +
                (i === dayIdx ? ' selected' : '') +
                (i === dayIdx && pane === 'days' ? ' focused' : '') + '">' +
                U.esc(days[i].label) +
              '</span>';
    }
    q('cg-days').innerHTML = html;

    /* Keep the chosen day on screen: a fortnight of guide is wider than the
       pane, and the row scrolls sideways rather than wrapping. */
    var strip = q('cg-days'), box = q('cg-days-box');
    var el = strip.children[dayIdx];
    if (el && box) {
      var w = box.clientWidth || 1200;
      var left = el.offsetLeft, right = left + el.offsetWidth;
      var off = stripOff;
      if (left - 40 < off) off = Math.max(0, left - 40);
      if (right + 40 > off + w) off = right + 40 - w;
      stripOff = Math.max(0, off);
      strip.style.transform = 'translateX(' + (-stripOff) + 'px)';
    }
  }

  var stripOff = 0;

  /* ---------------- the schedule ---------------- */

  /* Only when the channel actually changed. Walking the cursor down a hundred
     programmes must not rebuild them a hundred times. */
  function fill() {
    var c = channel();
    var key = c ? c.key : null;
    if (builtFor === key) { markProgs(); return; }

    var now = Date.now();
    progs = c ? EPG.list(c) : [];
    builtFor = key;
    days = buildDays(now);

    /* Open on the day that has now in it, which is the one somebody means when
       they pick a channel. */
    dayIdx = 0;
    for (var i = 0; i < days.length; i++) {
      if (days[i].key === dayKey(now)) { dayIdx = i; break; }
    }
    stripOff = 0;
    pickProgOfDay(now);
    paintDays();
    paintProgs();
  }

  /* Within the chosen day, rest on whatever is on — or the first thing, on a
     day that is not today. */
  function pickProgOfDay(now) {
    var items = today();
    progIdx = 0;
    scrollTop = 0;
    for (var i = 0; i < items.length; i++) {
      if (items[i].e > (now || Date.now())) { progIdx = i; break; }
    }
  }

  function paintProgs() {
    var items = today();
    var now = Date.now();
    var html = '';

    for (var i = 0; i < items.length; i++) {
      var p = items[i];
      var cls = 'cg-prog';
      if (p.s <= now && now < p.e) cls += ' now';
      else if (p.e <= now) cls += ' past';
      var mins = Math.max(1, Math.round((p.e - p.s) / 60000));
      var span = U.hhmm(new Date(p.s)) + '–' + U.hhmm(new Date(p.e));
      html += '<div class="' + cls + '" data-i="' + i + '">' +
                '<span class="cg-ptime">' + U.hhmm(new Date(p.s)) + '</span>' +
                '<span class="cg-pbody">' +
                  '<span class="cg-pname">' + U.esc(p.t) + '</span>' +
                  '<span class="cg-psub">' + span + '   ·   ' +
                    T('{n} min', { n: mins }) + '</span>' +
                '</span>' +
              '</div>';
    }

    q('cg-progs').innerHTML = html;
    q('cg-empty').classList.toggle('hidden', items.length > 0);
    markProgs();
  }

  function reminded(i) {
    var c = channel(), p = today()[i];
    if (!c || !p) return false;
    return p.s > Date.now() && Store.hasReminder(profile.id, c.key, p.s);
  }

  function markProgs() {
    var host = q('cg-progs');
    var kids = host.children;
    for (var i = 0; i < kids.length; i++) {
      var el = kids[i];
      var on = pane === 'progs' && +el.getAttribute('data-i') === progIdx;
      el.classList.toggle('focused', on);
      el.classList.toggle('reminded', reminded(+el.getAttribute('data-i')));
    }
    q('cg-scroller').classList.toggle('active', pane === 'progs');

    var c = channel();
    q('cg-title').textContent = c ? c.name : '';
    var items = today();
    q('cg-count').textContent = items.length ? (progIdx + 1) + ' / ' + items.length : '';

    /* The same window as the channel list, and as the channel column three
       inches to the left of it: two whole rows between the cursor and either
       edge, counted in rows rather than measured off the element. It used to
       keep one row and take its numbers from offsetTop, so the cursor sat
       against the edge and the list moved by whatever a row happened to
       measure — next to a column that did it properly, it read as a fault.

       Clamped and written on every paint, not only when there is a row to
       put in view: a day with fewer programmes than the one before it used
       to keep the old offset and look past the end of the list at nothing. */
    var box = q('cg-scroller');
    var h = box.clientHeight || 800;
    var limit = Math.max(0, items.length * PROG_H - h);
    var margin = PROG_H * 2;
    var y = progIdx * PROG_H;
    if (y - margin < scrollTop) scrollTop = Math.max(0, y - margin);
    if (y + PROG_H + margin > scrollTop + h) {
      scrollTop = Math.min(limit, y + PROG_H + margin - h);
    }
    scrollTop = Math.max(0, Math.min(scrollTop, limit));
    host.style.transform = 'translateY(' + (-scrollTop) + 'px)';
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
        case 'home':  chIdx = 0; paintChannels(); fill(); return;
        case 'end':   chIdx = list.length - 1; paintChannels(); fill(); return;
        case 'right':
        case 'ok':    pane = 'progs'; paintChannels(); paintDays(); markProgs(); return;
        case 'left':
        case 'back':
        case 'exit':  App.closeCatalog(); return;
        default: return;
      }
    }

    if (pane === 'days') {
      switch (a) {
        case 'left':  setDay(dayIdx - 1); return;
        case 'right': setDay(dayIdx + 1); return;
        case 'down':
        case 'ok':    pane = 'progs'; paintDays(); markProgs(); return;
        case 'up':    return;              // the strip is the top of this side
        case 'back':
        case 'exit':  App.closeCatalog(); return;
        default: return;
      }
    }

    switch (a) {
      case 'up':
        /* Up off the top of the list is the day strip, which is where the next
           thing somebody wants is: another day. */
        if (progIdx === 0) { pane = 'days'; paintDays(); markProgs(); return; }
        progIdx--; markProgs(); return;
      case 'down':
        progIdx = U.clamp(progIdx + 1, 0, Math.max(0, today().length - 1));
        markProgs(); return;
      case 'chanUp':   setDay(dayIdx - 1); return;
      case 'chanDown': setDay(dayIdx + 1); return;
      case 'rew':      setDay(dayIdx - 1); return;
      case 'ff':       setDay(dayIdx + 1); return;
      case 'left':  pane = 'channels'; paintChannels(); paintDays(); markProgs(); return;
      case 'ok':    choose(); return;
      case 'back':
      case 'exit':  App.closeCatalog(); return;
    }
  };

  function setDay(i) {
    if (!days.length) return;
    var next = U.clamp(i, 0, days.length - 1);
    if (next === dayIdx) return;
    dayIdx = next;
    pickProgOfDay(Date.now());
    paintDays();
    paintProgs();
  }

  function step(by) {
    chIdx = U.clamp(chIdx + by, 0, list.length - 1);
    paintChannels();
    fill();
  }

  /* The same rule the guide panel uses: watch it if it is on, replay it if the
     provider kept it, be reminded if it has not started. */
  function choose() {
    var c = channel(), p = today()[progIdx];
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

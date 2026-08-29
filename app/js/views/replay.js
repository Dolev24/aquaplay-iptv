/* views/replay.js — the catch-up browser: pick a day, pick a programme.

   The guide panel beside the player is for glancing at what is on. This is
   for going looking: every day the provider still holds, with the times, and
   a clear mark on what can actually be replayed. */
(function (w) {
  'use strict';

  var R = {};

  var profile = null;
  var channel = null;
  var days    = [];        // [{start, label, date, items:[programme]}]
  var dayIdx  = 0;
  var progIdx = 0;
  var pane    = 'days';    // days | progs

  var DAY_H = 76, PROG_H = 84;
  var DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  function q(id) { return U.$(id); }
  function items() { return (days[dayIdx] && days[dayIdx].items) || []; }

  function dayStartOf(ms) {
    var d = new Date(ms);
    return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  }

  function labelFor(start, now) {
    var t = dayStartOf(now);
    if (start === t) return T('Today');
    var y = new Date(t);
    y.setDate(y.getDate() - 1);
    if (start === y.getTime()) return T('Yesterday');
    return T(DAY_NAMES[new Date(start).getDay()]);
  }

  function dateFor(start) {
    var d = new Date(start);
    return d.getDate() + ' ' + T(MONTHS[d.getMonth()]);
  }

  /* ---------------- open ---------------- */

  R.open = function (p, ch) {
    profile = p;
    channel = ch;

    var list = EPG.list(ch);
    if (!list.length) {
      U.toast(Catchup.supported(p, ch)
        ? T('No guide for this channel, so nothing to catch up on')
        : T('This channel has no catch-up'));
      return;
    }

    var now = Date.now();
    var byDay = {};
    for (var i = 0; i < list.length; i++) {
      var k = dayStartOf(list[i].s);
      if (!byDay[k]) byDay[k] = [];
      byDay[k].push(list[i]);
    }

    days = Object.keys(byDay).map(Number).sort(function (a, b) { return b - a; })
      .map(function (start) {
        return {
          start: start,
          label: labelFor(start, now),
          date: dateFor(start),
          items: byDay[start]
        };
      });

    // Open on today, and on whatever is airing now.
    dayIdx = 0;
    for (var d = 0; d < days.length; d++) {
      if (days[d].start === dayStartOf(now)) { dayIdx = d; break; }
    }
    progIdx = Math.max(0, EPG.indexAt(items(), now));
    pane = 'progs';

    q('rp-channel').textContent = ch.name;
    paintDays();
    paintProgs();
    App.enterReplay();
  };

  R.show = function () { q('view-replay').classList.remove('hidden'); };
  R.hide = function () { q('view-replay').classList.add('hidden'); };

  /* ---------------- painting ---------------- */

  function paintDays() {
    var now = Date.now();
    var html = '';
    for (var i = 0; i < days.length; i++) {
      var d = days[i];
      var n = 0;
      for (var j = 0; j < d.items.length; j++) {
        if (Catchup.available(profile, channel, d.items[j], now)) n++;
      }
      html += '<div class="rp-day">' +
              '<span class="rp-day-count">' + (n || '') + '</span>' +
              '<span class="rp-day-name">' + U.esc(d.label) + '</span>' +
              '<span class="rp-day-date">' + U.esc(d.date) + '</span></div>';
    }
    q('rp-days').innerHTML = html;
    markDays();
  }

  function markDays() {
    var kids = q('rp-days').children;
    for (var i = 0; i < kids.length; i++) {
      kids[i].className = 'rp-day' +
        (i === dayIdx ? ' selected' : '') +
        (pane === 'days' && i === dayIdx ? ' focused' : '');
    }
    ensureVisible(q('rp-days'), dayIdx, DAY_H, q('rp-days').parentNode);
  }

  function paintProgs() {
    var list = items();
    var now = Date.now();
    var html = '';

    for (var i = 0; i < list.length; i++) {
      var p = list[i];
      var cls = 'rp-prog';
      var state = '';
      if (p.s <= now && now < p.e) { cls += ' now'; state = T('On now'); }
      else if (p.s > now) { cls += ' future'; state = T('Later'); }
      else if (Catchup.available(profile, channel, p, now)) { cls += ' replay'; }
      else { cls += ' gone'; state = T('Not kept'); }

      var mins = Math.max(1, Math.round((p.e - p.s) / 60000));
      html += '<div class="' + cls + '">' +
              '<span class="rp-time">' + U.hhmm(new Date(p.s)) + '</span>' +
              '<span class="rp-body">' +
                '<span class="rp-name">' + U.esc(p.t) + '</span>' +
                '<span class="rp-sub">' + mins + ' min' +
                  (state ? '   ·   ' + state : '') + '</span>' +
              '</span></div>';
    }

    q('rp-list').innerHTML = html;
    q('rp-empty').classList.toggle('hidden', list.length > 0);
    q('rp-day-title').textContent = days[dayIdx]
      ? (days[dayIdx].label + '   ' + days[dayIdx].date) : '';
    if (progIdx >= list.length) progIdx = Math.max(0, list.length - 1);
    markProgs();
  }

  function markProgs() {
    var kids = q('rp-list').children;
    for (var i = 0; i < kids.length; i++) {
      kids[i].classList.toggle('focused', pane === 'progs' && i === progIdx);
    }
    q('rp-list').parentNode.classList.toggle('active', pane === 'progs');
    var list = items();
    var n = 0, now = Date.now();
    for (var j = 0; j < list.length; j++) {
      if (Catchup.available(profile, channel, list[j], now)) n++;
    }
    q('rp-count').textContent = list.length
      ? (progIdx + 1) + ' / ' + list.length + '   ·   ' + n + ' to replay' : '';
    ensureVisible(q('rp-list'), progIdx, PROG_H, q('rp-scroller'));
  }

  function ensureVisible(host, idx, rowH, box) {
    var h = (box && box.clientHeight) || 800;
    var top = Math.max(0, (idx + 1) * rowH - h);
    if (idx * rowH < top) top = idx * rowH;
    host.style.transform = 'translateY(' + (-top) + 'px)';
  }

  /* ---------------- keys ---------------- */

  R.key = function (e) {
    var a = e.action;

    if (pane === 'days') {
      switch (a) {
        case 'up':    dayIdx = U.clamp(dayIdx - 1, 0, days.length - 1); progIdx = 0; markDays(); paintProgs(); return;
        case 'down':  dayIdx = U.clamp(dayIdx + 1, 0, days.length - 1); progIdx = 0; markDays(); paintProgs(); return;
        case 'right':
        case 'ok':    pane = 'progs'; markDays(); markProgs(); return;
        case 'left':
        case 'back':  App.closeReplay(); return;
        case 'exit':  App.closeReplay(); return;
        default: return;
      }
    }

    switch (a) {
      case 'up':
        if (progIdx === 0) { pane = 'days'; markDays(); markProgs(); return; }
        progIdx--; markProgs(); return;
      case 'down':
        progIdx = U.clamp(progIdx + 1, 0, Math.max(0, items().length - 1));
        markProgs(); return;
      case 'chanUp':
        dayIdx = U.clamp(dayIdx - 1, 0, days.length - 1); progIdx = 0;
        markDays(); paintProgs(); return;
      case 'chanDown':
        dayIdx = U.clamp(dayIdx + 1, 0, days.length - 1); progIdx = 0;
        markDays(); paintProgs(); return;
      case 'left':  pane = 'days'; markDays(); markProgs(); return;
      case 'ok':    playSelected(); return;
      case 'back':
      case 'exit':  App.closeReplay(); return;
    }
  };

  function playSelected() {
    var p = items()[progIdx];
    if (!p) return;
    var now = Date.now();
    if (p.s > now) { U.toast(T('That has not aired yet')); return; }
    if (p.s <= now && now < p.e) {
      App.closeReplay();
      Channels.playProgramme(channel, null);   // still on: just go live
      return;
    }
    if (!Catchup.available(profile, channel, p, now)) {
      U.toast(Catchup.supported(profile, channel)
        ? T('That is older than the provider keeps')
        : T('This channel has no catch-up'));
      return;
    }
    App.closeReplay();
    Channels.playProgramme(channel, p);
  }

  w.ReplayView = R;
})(window);

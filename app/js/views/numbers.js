/* views/numbers.js — the channel-number editor.

   It used to be the blue button on the browse screen, which meant the one
   thing people set up once lived behind a coloured key they had to know about,
   and every channel had to be found in the main list first. It is a screen of
   its own now, reached from Settings: every live channel, its number, and the
   ones that have been changed marked as such. */
(function (w) {
  'use strict';

  var N = {};

  var profile = null;
  var rows = [];          // [{ch, num, custom}]
  var idx = 0;
  var pool = [];
  var ROW_H = 84, POOL = 14;
  var top = 0;            // scroll offset in px
  var bound = false;

  function q(id) { return U.$(id); }

  function viewport() {
    var box = q('nm-scroller');
    return box.clientHeight || 800;
  }

  N.open = function (p, channels) {
    profile = p;
    rows = [];
    for (var i = 0; i < channels.length; i++) {
      var c = channels[i];
      var custom = Store.channelNumber(profile.id, c.key);
      rows.push({ ch: c, num: custom || c.num || (i + 1), custom: !!custom });
    }
    idx = 0; top = 0;
    build();
    paint();
    q('view-numbers').classList.remove('hidden');
    bindMouse();
  };

  N.hide = function () { q('view-numbers').classList.add('hidden'); };

  function build() {
    var host = q('nm-list');
    if (pool.length) return;
    for (var i = 0; i < POOL; i++) {
      var d = document.createElement('div');
      d.className = 'nm-row';
      d.style.display = 'none';
      d._idx = -1;
      host.appendChild(d);
      pool.push(d);
    }
  }

  function ensure() {
    var h = viewport(), margin = ROW_H * 2;
    var y = idx * ROW_H;
    if (y - margin < top) top = Math.max(0, y - margin);
    if (y + ROW_H + margin > top + h) {
      top = Math.min(Math.max(0, rows.length * ROW_H - h), y + ROW_H + margin - h);
    }
  }

  function paint() {
    ensure();
    var first = Math.max(0, Math.floor(top / ROW_H) - 1);
    for (var i = 0; i < pool.length; i++) {
      var at = first + i, node = pool[i];
      if (at >= rows.length) { node.style.display = 'none'; node._idx = -1; continue; }
      var r = rows[at];
      node.style.display = '';
      node.style.transform = 'translateY(' + (at * ROW_H - top) + 'px)';
      if (node._idx !== at) {
        node.innerHTML =
          '<span class="nm-num"></span>' +
          '<span class="nm-logo"></span>' +
          '<span class="nm-name"></span>' +
          '<span class="nm-tag"></span>';
        node._idx = at;
      }
      var logo = node.querySelector('.nm-logo');
      logo.className = 'nm-logo' + (r.ch.logo ? '' : ' blank');
      logo.style.backgroundImage = r.ch.logo ? 'url("' + r.ch.logo + '")' : '';
      node.querySelector('.nm-num').textContent = r.num;
      node.querySelector('.nm-name').textContent = r.ch.name;
      node.querySelector('.nm-tag').textContent = r.custom ? 'changed' : '';
      node.className = 'nm-row' + (at === idx ? ' focused' : '') + (r.custom ? ' custom' : '');
    }
    q('nm-count').textContent = rows.length + ' channels';
  }

  /* Which row currently answers to a number — the channel's own, or one it was
     given. Store only knows about the overrides, so the playlist's numbers have
     to be checked here. */
  function rowWithNumber(n, exceptKey) {
    for (var i = 0; i < rows.length; i++) {
      if (rows[i].ch.key !== exceptKey && rows[i].num === n) return rows[i];
    }
    return null;
  }

  function edit() {
    var r = rows[idx];
    if (!r) return;
    var c = r.ch;
    var mine = r.num;
    var current = Store.channelNumber(profile.id, c.key);
    var sub = current
      ? 'Now ' + current + ', playlist says ' + (c.num || '—') + '. Type a new number.'
      : 'Now ' + (c.num || '—') + ', from the playlist. Type a new number.';

    U.numberPrompt(c.name, sub, function (n) {
      if (n === null) return;
      if (n === 0) {
        Store.setChannelNumber(profile.id, c.key, 0);
        U.toast('Number reset to ' + (c.num || '—'));
        refresh();
        return;
      }
      if (n === mine) { refresh(); return; }

      /* Two channels on one number is a list that cannot be dialled: the
         remote would reach whichever came first. Offer the only thing that
         keeps every number reachable — trading places. */
      var other = rowWithNumber(n, c.key);
      if (other) {
        U.confirm('Channel ' + n + ' is ' + other.ch.name + '. Swap their numbers?',
          function (yes) {
            if (!yes) return;
            Store.setChannelNumber(profile.id, other.ch.key, mine);
            Store.setChannelNumber(profile.id, c.key, n);
            U.toast('Swapped with ' + other.ch.name + ' — it is now ' + mine);
            refresh();
          });
        return;
      }

      Store.setChannelNumber(profile.id, c.key, n);
      U.toast('Set to ' + n);
      refresh();
    });
  }

  function clear() {
    var r = rows[idx];
    if (!r || !r.custom) return;
    Store.setChannelNumber(profile.id, r.ch.key, 0);
    U.toast('Number reset to ' + (r.ch.num || '—'));
    refresh();
  }

  function refresh() {
    for (var i = 0; i < rows.length; i++) {
      var custom = Store.channelNumber(profile.id, rows[i].ch.key);
      rows[i].custom = !!custom;
      rows[i].num = custom || rows[i].ch.num || (i + 1);
    }
    for (var p = 0; p < pool.length; p++) pool[p]._idx = -1;
    paint();
    App.onNumbersChanged();
  }

  N.key = function (e) {
    var last = rows.length - 1;
    switch (e.action) {
      /* Wraps at both ends, like the channel list: the channel you want to
         renumber is as often at the bottom of the playlist as the top. */
      case 'up':       idx = (idx <= 0) ? Math.max(0, last) : idx - 1; paint(); return;
      case 'down':     idx = (idx >= last) ? 0 : idx + 1; paint(); return;
      case 'chanUp':   idx = U.clamp(idx - 10, 0, rows.length - 1); paint(); return;
      case 'chanDown': idx = U.clamp(idx + 10, 0, rows.length - 1); paint(); return;
      case 'home':     idx = 0; paint(); return;
      case 'end':      idx = Math.max(0, rows.length - 1); paint(); return;
      case 'ok':       edit(); return;
      case 'red':      clear(); return;
      case 'left':
      case 'back':
      case 'exit':     App.closeNumbers(); return;
      default: return;
    }
  };

  function bindMouse() {
    if (bound) return;
    bound = true;
    q('nm-list').addEventListener('click', function (ev) {
      var node = ev.target;
      while (node && node !== this && !node.classList.contains('nm-row')) node = node.parentNode;
      if (!node || node === this || node._idx == null || node._idx < 0) return;
      idx = node._idx;
      paint();
      edit();
    }, false);
  }

  w.NumbersView = N;
})(window);

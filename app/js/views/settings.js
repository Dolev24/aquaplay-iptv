/* views/settings.js — a flat, remote-friendly settings list. */
(function (w) {
  'use strict';

  var S = {};
  var idx = 0;
  var rows = [];

  function cycle(path, values, labels) {
    return {
      kind: 'cycle', path: path, values: values, labels: labels,
      get: function () {
        var v = get(path), i = values.indexOf(v);
        return T(labels[i === -1 ? 0 : i]);
      },
      step: function (d) {
        var v = get(path), i = values.indexOf(v);
        if (i === -1) i = 0;
        i = (i + d + values.length) % values.length;
        Store.set(path, values[i]);
      }
    };
  }

  function toggle(path) { return cycle(path, [true, false], ['On', 'Off']); }

  /* Same shape as cycle(), but the label of each value is that value applied
     to today rather than a word for it. */
  function dateCycle() {
    var values = ['long', 'short', 'dmy', 'mdy', 'iso', 'off'];
    var path = 'settings.dateFormat';
    return {
      kind: 'cycle', path: path, values: values,
      get: function () {
        var v = get(path);
        if (values.indexOf(v) === -1) v = 'long';
        return v === 'off' ? T('Off') : U.dateLabel(new Date(), v);
      },
      step: function (d) {
        var v = get(path), i = values.indexOf(v);
        if (i === -1) i = 0;
        Store.set(path, values[(i + d + values.length) % values.length]);
      }
    };
  }

  function get(path) {
    var parts = path.split('.'), o = Store.all();
    for (var i = 0; i < parts.length; i++) { if (o == null) return undefined; o = o[parts[i]]; }
    return o;
  }

  /* Everything technical lives behind one row at the bottom rather than in
     the middle of the list someone scrolls every day. Expands in place: this
     is a TV, and a settings screen that opens another settings screen is one
     more thing to get out of. */
  var advOpen = false;

  /* '' first: following the TV is the default and has to be reachable, and a
     language's own name is never translated — somebody who cannot read the
     language the app is currently in still has to find their way out of it. */
  function langCodes() {
    var out = [''];
    for (var i = 0; i < I18N.LANGS.length; i++) out.push(I18N.LANGS[i].code);
    return out;
  }

  function langNames() {
    var out = [T('Follow the TV')];
    for (var i = 0; i < I18N.LANGS.length; i++) out.push(I18N.LANGS[i].name);
    return out;
  }
  function build() {
    var p = Store.activeProfile();
    rows = [];

    key(rows.push({ kind: 'action', label: T('Playlist'),
      sub: p ? (p.type === 'xtream' ? 'Xtream Codes · ' + p.host : 'M3U · ' + shortUrl(p.url)) : T('None'),
      value: p ? p.name : '—', run: function () { App.openSetup(true); } }));

    rows.push({ kind: 'action', label: T('Reload playlist'),
      sub: T('Fetch channels and guide again'), value: '', run: function () { App.refreshPlaylist(); } });

    /* A list rather than a cycle. Ten languages one key at a time means
       eight more presses if you overshoot, in a language you may no longer be
       able to read — which is exactly the state somebody is in when they come
       to this row. */
    key(rows.push({ kind: 'action', label: T('Language'),
      sub: T('What the app is written in'),
      value: langNames()[Math.max(0, langCodes().indexOf(get('settings.lang') || ''))],
      run: function () {
        var codes = langCodes(), names = langNames();
        var items = [];
        for (var i = 0; i < codes.length; i++) {
          items.push({ value: codes[i], label: names[i] });
        }
        U.pick(T('Language'), items, get('settings.lang') || '', function (code) {
          if (code === null) return;
          Store.set('settings.lang', code);
          App.onSettingChanged('settings.lang');
        });
      } }));
    key(rows.push(row('Theme', '',
      cycle('settings.theme', ['dark', 'light'], ['Dark', 'Light']))));

    rows.push(row('Start on', 'Which list the app opens with',
      cycle('settings.startGroup', ['all', 'fav', 'recent'],
            ['All channels', 'Favourites', 'Recently watched'])));

    rows.push(row('Arrows change channel', 'Up and down while watching fullscreen',
      toggle('settings.arrowZap')));

    rows.push(row('Sort channels', 'Provider order, or by channel number',
      cycle('settings.sortBy', ['provider', 'number'], ['Provider order', 'Channel number'])));

    rows.push({ kind: 'action', label: T('Channel numbers'),
      sub: T('Give any channel the number you want it on'),
      value: '', run: function () { App.openNumbers(); } });

    rows.push(row('Alternating row colours', 'Shade every other channel in the list',
      toggle('settings.altRows')));

    rows.push(row('Programme guide', 'Download and show now/next',
      toggle('settings.epg')));

    rows.push(row('Guide panel', 'What the panel under the picture shows',
      cycle('settings.guideView', ['centred', 'ahead'],
            ['Now in the middle', 'Now at the top'])));

    rows.push(row('Catch-up history', 'How far back the guide lists finished programmes',
      cycle('settings.catchupHours', [6, 24, 48, 168],
            ['6 hours', '1 day', '2 days', '7 days'])));

    rows.push(row('Picture size', 'How the video fills the screen',
      cycle('settings.pictureSize', ['fit', 'fill', 'stretch'],
            ['Fit (letterbox)', 'Fill (crop)', 'Stretch'])));

    rows.push(row('Clock', '',
      cycle('settings.clock24', [true, false], ['24-hour', '12-hour'])));
    /* The value is today, written the way this setting would write it. A
       list of specimens dated 2026 would be six strings for nine dictionaries
       to translate, and would still not show what the viewer is choosing. */
    rows.push({ kind: 'cycle', label: T('Date format'),
      sub: T('How the date over the channel list is written'),
      ctl: dateCycle() });

    rows.push(row('Resume last channel', 'Start the last channel in the panel on launch',
      toggle('settings.startupPlayLast')));

    rows.push(row('Info bar duration', '',
      cycle('settings.osdSeconds', [3, 5, 8, 0], ['3s', '5s', '8s', 'Always'])));

    rows.push({ kind: 'cycle', label: T('Parental control'),
      sub: T('Hide adult channels behind a PIN'),
      ctl: {
        kind: 'cycle', path: 'settings.parental',
        get: function () { return Store.settings().parental ? T('On') : T('Off'); },
        step: function () {
          var st = Store.settings();
          if (st.parental) { Store.set('settings.parental', false); return; }
          if (!st.pin) { askPin(T('Set a PIN code'), T('Four digits'), function (pin) {
            if (!pin || pin.length < 4) { U.toast(T('A PIN must be four digits')); return; }
            Store.set('settings.pin', pin);
            Store.set('settings.parental', true);
            U.toast(T('Parental control on'));
            build(); paint();
          }); return; }
          Store.set('settings.parental', true);
        }
      } });

    rows.push({ kind: 'action', label: T('Change PIN code'),
      sub: Store.settings().pin ? T('Set') : T('Not set'), value: '', run: function () {
        askPin(T('New PIN code'), T('Four digits'), function (pin) {
          if (!pin || pin.length < 4) { U.toast(T('A PIN must be four digits')); return; }
          Store.set('settings.pin', pin);
          U.toast(T('PIN changed'));
          build(); paint();
        });
      } });

    /* Channels locked one at a time from the channel panel, counted here so
       there is somewhere to see how many there are and a way back to them. */
    var lockedCount = 0;
    var actProfile = Store.activeProfile();
    if (actProfile) lockedCount = Store.lockedKeys(actProfile.id).length;
    if (lockedCount) {
      rows.push({ kind: 'action', label: T('Locked channels'),
        sub: T('Locked from the channel panel — right arrow on a channel'),
        value: String(lockedCount), run: function () {
          if (!Store.sessionUnlocked()) { U.toast(T('Unlock below first')); return; }
          U.confirm(T('Take the lock off all {n} channels?', { n: lockedCount }), function (yes) {
            if (!yes) return;
            var pid = Store.activeProfile().id;
            Store.lockedKeys(pid).forEach(function (k) { Store.setLocked(pid, k, false); });
            U.toast(T('All locks removed'));
            Channels.reloadGroups();
            build(); paint();
          });
        } });
    }

    /* Either kind of lock needs a way through it, and the way is the same. */
    var somethingLocked = Store.parentalActive() || (Store.lockActive() && lockedCount > 0);
    if (somethingLocked && !Store.sessionUnlocked()) {
      rows.push({ kind: 'action', label: T('Unlock locked channels'),
        sub: T('Until the app is closed'), value: '', run: function () {
          askPin(T('Enter PIN'), '', function (pin) {
            if (Store.unlock(pin)) {
              U.toast(T('Unlocked'));
              Channels.reloadGroups();
              build(); paint();
            } else U.toast(T('Wrong PIN'));
          });
        } });
    }
    /* Without this, putting a channel back behind the PIN means restarting the
       app — the session unlock is the only thing holding it open. */
    if (somethingLocked && Store.sessionUnlocked()) {
      rows.push({ kind: 'action', label: T('Lock now'),
        sub: T('Put the locked channels back behind the PIN'), value: '',
        run: function () {
          Store.relock();
          U.toast(T('Locked'));
          Channels.reloadGroups();
          build(); paint();
        } });
    }

    /* ---- Advanced ---- */

    rows.push({ kind: 'action', label: T('Advanced'),
      sub: T('Diagnostics, streaming and the things that undo things'),
      value: advOpen ? T('Hide') : T('Show'),
      run: function () { advOpen = !advOpen; build(); paint(); } });

    if (advOpen) buildAdvanced(p);

    rows.push({ kind: 'info', label: 'AquaPlay IPTV',
      sub: U.isTizen ? T('Running on Tizen')
         : (U.isAndroid ? T('Running on Android TV') : T('Running in a browser')),
      value: 'v0.7.35' });
  }

  function adv(r) { r.adv = true; rows.push(r); return r; }

  /* rows.push returns the new length, so this marks the row that was just
     added — which reads better at the call site than pushing and then
     reaching back into the array for it. */
  function key(len) { rows[len - 1].key = true; return rows[len - 1]; }

  function buildAdvanced(p) {
    /* What the picture is doing, in the words the player uses. None of it can
       be seen from a desktop, which is why it is written down where someone
       sitting in front of the TV can read it out. */
    var d = Player.diag ? Player.diag() : null;
    if (d) {
      adv({ kind: 'info', label: T('Stream resolution'),
        sub: T('What this channel is sending'), value: d.source });
      adv({ kind: 'info', label: T('Screen'),
        sub: T('Window size, and how the 1920x1080 layout is scaled to it'),
        value: d.window + ' · x' + d.scale });
      adv({ kind: 'info', label: T('Video plane'),
        sub: T('Where the picture is drawn, in {kind} pixels', { kind: d.tizen ? 'AVPlay' : 'CSS' }),
        value: d.applied });
      adv({ kind: 'info', label: T('Picture method'),
        sub: T('How it fills that rectangle'), value: d.method });
      adv({ kind: 'info', label: T('Player'),
        sub: d.tizen ? T('AVPlay state') : T('Browser video element'),
        value: (d.state || 'idle') + ' · ' + d.mode });
      if (d.error && d.error !== 'none') {
        adv({ kind: 'info', label: T('Last player error'), sub: d.error, value: '' });
      }
    }

    /* "Why has this channel got nothing on air?" is not answerable from a
       sofa, and it is not answerable from a desk either without the provider's
       own guide. So the app counts it: how many channels have something on air
       right now, and which ones do not and why. */
    var live = Channels.channels ? Channels.channels() : null;
    if (live && live.length && EPG.hasData()) {
      var cov = EPG.coverage(live);
      var bad = cov.ended + cov.empty + cov.unmatched;
      adv({ kind: 'action', label: T('Guide coverage'),
        sub: bad ? T('{ended} end earlier today, {empty} matched but empty, {unmatched} never matched',
                    { ended: cov.ended, empty: cov.empty, unmatched: cov.unmatched }) +
                   (cov.capped ? T(', {n} trimmed to fit', { n: cov.capped }) : '')
                 : T('Every channel the guide covers has something on air'),
        value: cov.live + ' / ' + live.length,
        run: function () {
          if (!cov.worst.length) { U.toast(T('Every channel has a programme on air')); return; }
          var lines = cov.worst.slice(0, 4).map(function (w) {
            if (w.state === 'unmatched') return w.name + ': ' + T('no guide channel matched');
            if (w.state === 'empty') return w.name + ': ' + T('matched "{id}", no programmes', { id: w.id });
            return w.name + ': ' + T('guide ends {time} ({kept} kept)',
                     { time: U.hhmm(new Date(w.last)), kept: w.kept }) +
                   (w.capped ? T(', {n} trimmed', { n: w.capped }) : '');
          });
          U.toast(lines.join('   ·   '), 9000);
        } });
    }

    if (p && p.type === 'xtream') {
      adv(row('Stream format', 'Change this if channels will not start',
        cycle('settings.streamFormat', ['auto', 'm3u8', 'ts'], ['Auto', 'HLS (m3u8)', 'MPEG-TS (ts)'])));
    }

    adv(row('Buffer', 'Small zaps faster, large is steadier',
      cycle('settings.bufferSize', ['auto', 'small', 'large'], ['Auto', 'Small', 'Large'])));

    adv(row('Reconnect automatically', 'Retry a dropped stream instead of giving up',
      toggle('settings.autoReconnect')));

    adv(row('Guide time offset', 'Shift the guide if its times are wrong',
      cycle('settings.epgOffset', [-3, -2, -1, 0, 1, 2, 3],
            ['-3 hours', '-2 hours', '-1 hour', 'None', '+1 hour', '+2 hours', '+3 hours'])));

    if (!U.isTV) {
      adv(row('HLS engine', 'Desktop only; the TV always uses AVPlay',
        cycle('settings.hlsEngine', ['auto', 'hlsjs', 'native'],
              ['Auto', 'hls.js', 'Browser native'])));
    }

    adv(row('Hide empty groups', '', toggle('settings.hideEmptyGroups')));

    adv({ kind: 'action', label: T('Reset channel numbers'),
      sub: T('Undo every number you have changed'), value: '', run: function () {
        var pr = Store.activeProfile();
        if (!pr) return;
        U.confirm(T('Reset all channel numbers to the playlist values?'), function (yes) {
          if (!yes) return;
          Store.clearNumbers(pr.id);
          U.toast(T('Channel numbers reset'));
        });
      } });

    adv({ kind: 'action', label: T('Restart application'),
      sub: T('Reload everything from scratch'), value: '', run: function () {
        U.confirm(T('Restart AquaPlay?'), function (yes) { if (yes) App.restart(); });
      } });

    adv({ kind: 'action', label: T('Clear cached data'),
      sub: T('Forces a fresh download of channels and guide'), value: '', run: function () {
        var pr = Store.activeProfile();
        if (!pr) return;
        Cache.clearProfile(pr.id).then(function () {
          U.toast(T('Cache cleared — reloading'));
          App.refreshPlaylist();
        });
      } });

    adv({ kind: 'action', label: T('Remove playlist'), sub: T('Deletes it from this TV'), value: '',
      danger: true, run: function () {
        var pr = Store.activeProfile();
        if (!pr) return;
        U.confirm(T('Remove "{name}" from this TV?', { name: pr.name }), function (yes) {
          if (!yes) return;
          Cache.clearProfile(pr.id);
          Store.removeProfile(pr.id);
          App.afterProfileRemoved();
        });
      } });
  }


  /* A playlist URL is a credential: the path token is all anyone needs to use
     the account. Show enough to recognise which playlist it is, not enough to
     copy off a photograph of the screen. */
  function askPin(title, sub, cb) {
    U.numberPrompt(title, sub, function (v) {
      if (v === null) return;
      cb(String(v));
    }, { raw: true, mask: true, auto: 4 });
  }

  function shortUrl(u) {
    if (!u) return '';
    var host = u, tail = '';
    var m = /^(https?:\/\/[^/]+)(\/.*)?$/i.exec(u);
    if (m) {
      host = m[1].replace(/^https?:\/\//i, '');
      tail = m[2] || '';
    } else {
      return u.length > 40 ? u.slice(0, 37) + '\u2026' : u;
    }
    var parts = tail.split('/').filter(function (x) { return x; });
    var last = parts.length ? parts[parts.length - 1] : '';
    var masked = last ? last.slice(0, 2) + '\u2022\u2022\u2022\u2022' : '';
    var lead = parts.slice(0, -1).join('/');
    return host + '/' + (lead ? lead + '/' : '') + masked;
  }

  function row(label, sub, ctl) {
    /* Translated here rather than at each call site: every row goes through
       this, and the English text is the key. */
    return { kind: "cycle", label: T(label), sub: sub ? T(sub) : "", ctl: ctl };
  }

  function paint() {
    var html = '';
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      var value = r.kind === 'cycle' ? r.ctl.get() : (r.value || '');
      html += '<div class="set-row' + (i === idx ? ' focused' : '') +
                (r.adv ? ' adv' : '') + (r.key ? ' key' : '') + '">' +
                '<span class="set-value">' + U.esc(value) + '</span>' +
                '<span class="set-label">' + U.esc(r.label) +
                  (r.sub ? '<span class="set-sub">' + U.esc(r.sub) + '</span>' : '') +
                '</span>' +
              '</div>';
    }
    U.$('settings-list').innerHTML = '<div id="settings-inner">' + html + '</div>';
    // Keep the focused row inside the 790px window without a real scrollbar.
    var ROW = 93, VIS = Math.floor(790 / ROW);
    var off = 0;
    if (idx >= VIS) off = (idx - VIS + 1) * ROW;
    U.$('settings-inner').style.transform = 'translateY(-' + off + 'px)';
  }

  /* Mouse: a click picks the row and activates it, exactly as OK would. */
  var mouseBound = false;
  function bindMouse() {
    if (mouseBound) return;
    mouseBound = true;
    U.$('settings-list').addEventListener('click', function (ev) {
      var node = ev.target;
      while (node && node !== this && !node.classList.contains('set-row')) node = node.parentNode;
      if (!node || node === this) return;
      var i = [].indexOf.call(node.parentNode.children, node);
      if (i === -1) return;
      idx = i;
      var r = rows[idx];
      if (!r) return;
      if (r.kind === 'cycle') { r.ctl.step(1); paint(); App.onSettingChanged(r.ctl.path); }
      else if (r.kind === 'action' && r.run) { paint(); r.run(); }
      else paint();
    }, false);
  }

  /* The rows are built with their text already translated, so a language
     change has to build them again. */
  S.rebuild = function () { build(); paint(); };
  S.show = function () {
    bindMouse();
    idx = 0; build(); paint();
    U.$('view-settings').classList.remove('hidden');
    U.$('view-main').classList.add('hidden');
    U.$('view-setup').classList.add('hidden');
  };

  S.hide = function () { U.$('view-settings').classList.add('hidden'); };

  S.key = function (e) {
    var a = e.action, r = rows[idx];
    switch (a) {
      case 'up':    idx = U.clamp(idx - 1, 0, rows.length - 1); paint(); return;
      case 'down':  idx = U.clamp(idx + 1, 0, rows.length - 1); paint(); return;
      case 'left':  if (r && r.kind === 'cycle') { r.ctl.step(-1); paint(); App.onSettingChanged(r.ctl.path); } return;
      case 'right': if (r && r.kind === 'cycle') { r.ctl.step(1);  paint(); App.onSettingChanged(r.ctl.path); } return;
      case 'ok':
        if (!r) return;
        if (r.kind === 'cycle') { r.ctl.step(1); paint(); App.onSettingChanged(r.ctl.path); }
        else if (r.kind === 'action' && r.run) r.run();
        return;
      case 'back':
      case 'yellow':
        App.closeSettings();
        return;
      case 'exit':
        U.confirm(T('Exit AquaPlay?'), function (yes) { if (yes) Keys.exitApp(); });
        return;
    }
  };

  w.SettingsView = S;
})(window);

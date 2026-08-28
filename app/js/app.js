/* app.js — bootstrap and orchestration. */
(function (w) {
  'use strict';

  var A = {};
  var route = 'setup';           // setup | main | series | replay | settings
  var loadedProfileId = null;

  /* Live TV / Movies / Series, kept per profile. Live is loaded up front;
     the other two only when the user first asks for them. */
  var sections = { live: null, vod: null, series: null };

  // Bumped when the cached shape changes, so an upgrade refetches once rather
  // than serving a blob that predates Movies/Series and hiding the strip.
  var CH_KEY  = 'ch2:';
  var CH_TTL  = 12 * 3600 * 1000;   // channel list cache
  var EPG_KEY = 'epg3:';            // bumped: the guide is now filtered per playlist
  /* A guide costs tens of seconds to read on a TV, so a cached one is used for
     as long as it still covers the day, and anything older than EPG_FRESH is
     replaced quietly underneath the app rather than in front of it. */
  var EPG_TTL   = 12 * 3600 * 1000;
  var EPG_FRESH = 2 * 3600 * 1000;

  /* ---------------- stage scaling ---------------- */
  function fitStage() {
    var stage = U.$('stage');
    var s = Math.min(w.innerWidth / 1920, w.innerHeight / 1080);
    if (!isFinite(s) || s <= 0) s = 1;
    stage.style.transform = 'scale(' + s + ')';
    stage.style.left = Math.max(0, (w.innerWidth - 1920 * s) / 2) + 'px';
    stage.style.top  = Math.max(0, (w.innerHeight - 1080 * s) / 2) + 'px';
  }

  /* ---------------- boot ---------------- */
  A.boot = function () {
    Store.init();
    U.applyTheme();
    if (U.isTizen) document.documentElement.classList.add('tizen');
    fitStage();
    w.addEventListener('resize', U.debounce(fitStage, 120), false);

    loadHlsIfNeeded(function () {
      Player.init();
      Player.on({
        onPlaying:   function ()      { toPlayer('playing'); },
        onBuffering: function (on)    { toPlayer('buffering', on); },
        onError:     function (msg)   { toPlayer('error', msg); }
      });

      Keys.init();
      Keys.setHandler(onKey);
      Channels.bindSearch();
      startReminders();
      bindLifecycle();

      var p = Store.activeProfile();
      if (!p) { route = 'setup'; Setup.show({ cancelable: false }); return; }
      loadProfile(p);
    });
  };

  /* ---------------- reminders ----------------

     Checked against the clock every twenty seconds rather than scheduled with
     a timer of their own: a setTimeout four hours out does not survive the app
     being closed, and outliving that is the whole point of a reminder. The
     store drops anything whose moment has passed, so one that was missed while
     the TV was off is quietly forgotten instead of arriving in the morning.

     It fires wherever the viewer is — settings, the catch-up browser, another
     channel full screen — so the dialog has to be able to bring them back. */
  var REMIND_TICK = 20000;
  var remindTimer = null;

  function startReminders() {
    if (remindTimer) return;
    remindTimer = setInterval(checkReminders, REMIND_TICK);
  }

  function checkReminders() {
    var p = Store.activeProfile();
    if (!p) return;
    // Never stack a dialog on top of another one; it will still be due in 20s.
    if (U.confirmOpen || U.numberOpen) return;

    var due = Store.dueReminders(p.id, Date.now());
    if (!due.length) return;
    var r = due[0];
    Store.clearReminder(p.id, r.chKey, r.start);      // it says its piece once

    // Already watching it: the reminder has done its job without saying a word.
    if (Channels.playingKey() === r.chKey) return;

    U.confirm(r.title + ' has started on ' + r.chName, function (yes) {
      if (!yes) return;
      A.goMain();
      if (!Channels.tuneTo(r.chKey)) U.toast(r.chName + ' is no longer in this playlist');
    }, { yes: 'Go to channel', no: 'Close' });
  }

  /* Back to the browse screen from wherever the viewer happens to be. */
  A.goMain = function () {
    if (route === 'main') return;
    SettingsView.hide();
    NumbersView.hide();
    ReplayView.hide();
    SeriesView.hide();
    route = 'main';
    Channels.show();
  };

  /* hls.js is only needed for desktop testing — never shipped to the TV. */
  function loadHlsIfNeeded(done) {
    if (U.isTizen) { done(); return; }
    var s = document.createElement('script');
    s.src = 'lib/hls.min.js';
    s.onload = done;
    s.onerror = function () { U.log('hls.js missing — HLS will not play in this browser'); done(); };
    document.head.appendChild(s);
  }

  function bindLifecycle() {
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) Player.stop();
    }, false);
    w.addEventListener('unload', function () { try { Player.stop(); } catch (e) {} }, false);
  }

  /* ---------------- key routing ---------------- */
  function onKey(e) {
    if (route === 'setup')     return Setup.key(e);
    if (route === 'numbers')   return NumbersView.key(e);
    if (route === 'settings')  return SettingsView.key(e);
    if (route === 'series')    return SeriesView.key(e);
    if (route === 'replay')    return ReplayView.key(e);
    return Channels.key(e);
  }

  /* The series screen owns its own playback, so player events follow the route. */
  function toPlayer(type, arg) {
    if (route === 'series') { SeriesView.onPlayerEvent(type, arg); return; }
    Channels.onPlayerEvent(type, arg);
  }

  /* ---------------- profile loading ---------------- */

  function loadProfile(p, forceNetwork, preloadText) {
    loadedProfileId = p.id;
    sections = { live: null, vod: null, series: null };
    U.loader(true, 'Loading ' + (p.name || 'playlist') + '…');

    var fromCache = forceNetwork
      ? Promise.resolve(null)
      : Cache.get(CH_KEY + p.id, CH_TTL);

    fromCache.then(function (cached) {
      if (cached && cached.channels && cached.channels.length) {
        U.log('channels from cache:', cached.channels.length);
        return refreshUrls(p, cached);
      }
      return fetchChannels(p, preloadText).then(function (data) {
        Cache.set(CH_KEY + p.id, data);
        return data;
      });
    }).then(function (data) {
      U.loader(false);
      if (!data.channels.length) {
        U.toast('That playlist has no channels');
        route = 'setup'; Setup.show({ cancelable: true });
        return;
      }
      route = 'main';
      Setup.hide();

      sections.live = { channels: data.channels, groups: data.groups };
      // An M3U yields all three sections from the single parse; Xtream needs
      // a separate request per section, so those stay null until asked for.
      if (data.sections) {
        if (data.sections.vod && data.sections.vod.channels.length) sections.vod = data.sections.vod;
        if (data.sections.series && data.sections.series.channels.length) sections.series = data.sections.series;
      }

      Channels.load(p, sections.live);
      Channels.setSections({
        live: true,
        vod: p.type === 'xtream' || !!sections.vod,
        series: p.type === 'xtream' || !!sections.series
      });
      Channels.show();
      if (Store.settings().startupPlayLast) Channels.resumeLast();
      loadEpg(p, forceNetwork);
    }).catch(function (err) {
      U.loader(false);
      U.toast(err && err.message ? err.message : 'Could not load the playlist');
      route = 'setup';
      Setup.show({ cancelable: Store.profiles().length > 0 });
    });
  }

  /* Xtream credentials can change format between sessions; rebuild live URLs
     from the cached stream ids rather than trusting stale ones. */
  function refreshUrls(p, data) {
    if (p.type !== 'xtream') return data;
    var ext = Xtream.pickFormat(p.formats, Store.settings().streamFormat);
    for (var i = 0; i < data.channels.length; i++) {
      var c = data.channels[i];
      if (c.streamId != null) c.url = Xtream.liveUrl(p, c.streamId, ext);
    }
    return data;
  }

  function fetchChannels(p, preloadText) {
    if (p.type === 'xtream') {
      var ext = Xtream.pickFormat(p.formats, Store.settings().streamFormat);
      return Xtream.load(p, ext, function (pct, text) { U.loaderProgress(pct, text); });
    }

    var got = preloadText
      ? Promise.resolve(preloadText)
      : Net.text(p.url, {
          timeout: 90000,
          onProgress: function (loaded, total) {
            if (total) U.loaderProgress(loaded / total * 60, 'Downloading playlist…');
            else U.loaderProgress(30, 'Downloading playlist… ' + Math.round(loaded / 1024) + ' KB');
          }
        });

    return got.then(function (text) {
      return M3U.parse(text, function (pct, n) {
        U.loaderProgress(60 + pct * 0.4, 'Reading ' + n + ' channels…');
      });
    }).then(function (res) {
      // A playlist may advertise its own guide; remember it if we have none.
      if (res.epgUrl && !p.epgUrl) { p.epgUrl = res.epgUrl; Store.set('profiles', Store.profiles()); }
      return { channels: res.channels, groups: res.groups, sections: res.sections };
    });
  }

  /* ---------------- sections ---------------- */

  var SECTION_CACHE_KEY = { vod: 'vod:', series: 'sr:' };
  var SECTION_NOUN = { vod: 'movies', series: 'series' };

  A.switchSection = function (kind) {
    if (sections[kind]) { Channels.setSection(kind, sections[kind]); return; }

    var p = Store.activeProfile();
    if (!p || p.type !== 'xtream') return;

    var noun = SECTION_NOUN[kind] || kind;
    var key = SECTION_CACHE_KEY[kind] + p.id;
    U.loader(true, 'Loading ' + noun + '…');

    Cache.get(key, CH_TTL).then(function (cached) {
      if (cached && cached.channels && cached.channels.length) return cached;
      var onProgress = function (pct, text) { U.loaderProgress(pct, text); };
      var job = (kind === 'vod') ? Xtream.loadVod(p, onProgress) : Xtream.loadSeries(p, onProgress);
      return job.then(function (d) { Cache.set(key, d); return d; });
    }).then(function (d) {
      U.loader(false);
      if (!d.channels.length) { U.toast('This playlist has no ' + noun); return; }
      sections[kind] = d;
      Channels.setSection(kind, d);
    }).catch(function (err) {
      U.loader(false);
      U.toast(err && err.message ? err.message : 'Could not load ' + noun);
    });
  };

  A.enterReplay = function () {
    route = 'replay';
    Channels.hide();
    ReplayView.show();
  };

  A.closeReplay = function () {
    ReplayView.hide();
    route = 'main';
    Channels.show();
  };

  A.enterSeries = function () {
    route = 'series';
    Channels.hide();
    SeriesView.show();
  };

  A.closeSeries = function () {
    SeriesView.hide();
    route = 'main';
    Channels.show();
  };

  /* ---------------- EPG ---------------- */

  /* The ids and names of the channels actually in the playlist, so the parser
     can throw away the rest of the provider's guide as it scans. */
  function wantedChannels() {
    var live = (sections.live && sections.live.channels) || [];
    var ids = {}, keys = {};
    for (var i = 0; i < live.length; i++) {
      var c = live[i];
      if (c.tvgId) {
        ids[c.tvgId] = 1;
        var k = U.matchKey(c.tvgId);
        if (k) keys[k] = 1;
      }
      var kn = U.matchKey(c.name);
      if (kn) keys[kn] = 1;
    }
    return { ids: ids, keys: keys };
  }

  function epgSource(p) {
    if (p.type === 'xtream') return Xtream.xmltvUrl(p);
    return p.epgUrl || '';
  }

  /* Why the guide is missing, for the panel that would otherwise just say
     there is none. Empty when it loaded. */
  A.epgError = '';
  A.epgLoading = false;

  function loadEpg(p, forceNetwork) {
    var s = Store.settings();
    if (!s.epg) { EPG.clear(); Channels.onEpgReady(); return; }
    var src = epgSource(p);
    if (!src) return;

    var cached = forceNetwork ? Promise.resolve(null) : Cache.get(EPG_KEY + p.id, EPG_TTL);

    cached.then(function (blob) {
      if (blob && EPG.hydrate(blob)) {
        U.log('guide from cache:', EPG.data.count);
        Channels.onEpgReady();
        /* Old enough to be worth replacing, but not so old it is useless:
           read the new one in the background with the old one on screen. */
        if (Date.now() - (EPG.data.builtAt || 0) > EPG_FRESH) {
          U.log('guide is stale, refreshing quietly');
          fetchGuide(p, s, true);
        }
        return null;
      }
      return fetchGuide(p, s, false);
    }).catch(function (err) {
      U.log('EPG cache failed', err);
      fetchGuide(p, s, false);
    });
  }

  function fetchGuide(p, s, quiet) {
    var src = epgSource(p);
    if (!src) return null;
    if (A.epgLoading) return null;
    A.epgLoading = true;
    Channels.onEpgReady();

    return Promise.resolve().then(function () {
      var behind = s.catchupHours || 2;
      var ahead = s.epgHours || 8;
      /* Scanned as it arrives rather than read into one string first: the
         user's own guide is 242 MB of XML, which no TV can hold. */
      var st = EPG.stream({
        hoursAhead: ahead,
        hoursBehind: behind,
        // The default cap of 32 would clip the history off a wide window.
        maxPerChannel: Math.max(32, Math.round((ahead + behind) * 2)),
        offsetHours: s.epgOffset || 0,
        wanted: wantedChannels(),
        /* Nothing to publish early when there is already a guide on screen:
           replacing it with a partial one would empty rows that currently
           have programmes in them. */
        onPartial: quiet ? null : function () { Channels.onEpgReady(); }
      });
      return Net.guide(src, function (chunk) { st.feed(chunk); }, { timeout: 120000 })
        .then(function () {
          st.finish();
          A.epgError = '';
          A.epgLoading = false;
          Channels.onEpgReady();
          Cache.set(EPG_KEY + p.id, EPG.serialise());
          U.log('guide parsed:', EPG.data.count);
        });
    }).catch(function (err) {
      /* A missing guide must never block watching TV, but it must not be
         silent either: "No guide for this channel" on every row with nothing
         to explain it is indistinguishable from the app being broken. */
      var msg = (err && err.message) ? err.message : String(err);
      A.epgLoading = false;
      U.log('EPG failed', msg);
      // A refresh failing behind a guide that is already on screen is not the
      // viewer's problem; only say so when it leaves them with nothing.
      if (!quiet) {
        A.epgError = msg;
        U.toast('Guide unavailable — ' + msg);
      }
      Channels.onEpgReady();
    });
  }

  /* ---------------- navigation API used by views ---------------- */

  A.openSetup = function (cancelable) {
    Player.stop();
    route = 'setup';
    SettingsView.hide();
    SeriesView.hide();
    ReplayView.hide();
    Channels.hide();
    Setup.show({ cancelable: cancelable !== false });
  };

  A.closeSetup = function () {
    var p = Store.activeProfile();
    if (!p) { U.toast('Add a playlist to continue'); return; }
    Setup.hide();
    if (loadedProfileId === p.id) { route = 'main'; Channels.show(); }
    else loadProfile(p);
  };

  A.onProfileReady = function (p, preloadText) {
    Setup.hide();
    loadProfile(p, true, preloadText);
  };

  /* The channel-number editor, opened from Settings. Numbering used to be a
     coloured button on the browse screen, which meant the one thing people set
     up once was hidden behind a key they had to know about. */
  A.openNumbers = function () {
    var p = Store.activeProfile();
    var live = sections.live;
    if (!p || !live || !live.channels || !live.channels.length) {
      U.toast('No channels to number yet');
      return;
    }
    route = 'numbers';
    SettingsView.hide();
    /* A screen of channel names is exactly what a lock is hiding, so the
       locked ones are not on this one either. */
    NumbersView.open(p, live.channels.filter(function (c) {
      return !Store.isHiddenChannel(p.id, c);
    }));
  };

  A.closeNumbers = function () {
    NumbersView.hide();
    route = 'settings';
    SettingsView.show();
  };

  /* A number moved, so the list has to re-sort under it. */
  A.onNumbersChanged = function () { Channels.reloadGroups(); };

  A.openSettings = function () {
    Player.stop();
    route = 'settings';
    SeriesView.hide();
    ReplayView.hide();
    Channels.hide();
    SettingsView.show();
  };

  A.closeSettings = function () {
    SettingsView.hide();
    var p = Store.activeProfile();
    if (!p) { A.openSetup(false); return; }
    route = 'main';
    Channels.show();
  };

  A.refreshPlaylist = function () {
    var p = Store.activeProfile();
    if (!p) return;
    Player.stop();
    SettingsView.hide();
    SeriesView.hide();
    ReplayView.hide();
    Cache.clearProfile(p.id).then(function () {
      EPG.clear();
      loadProfile(p, true);
    });
  };

  /* Most settings are read live and need no action. These do. */
  var GUIDE_SETTINGS = {
    'settings.epg': 1, 'settings.epgHours': 1,
    'settings.catchupHours': 1, 'settings.epgOffset': 1
  };

  A.onSettingChanged = function (path) {
    var p = Store.activeProfile();
    if (!p) return;

    if (path === 'settings.pictureSize') { Player.applyPictureSize(); return; }
    if (path === 'settings.theme') { U.applyTheme(); return; }
    if (path === 'settings.altRows') { Channels.applyRowStyle(); return; }
    if (path === 'settings.sortBy') { Channels.reloadGroups(); return; }

    if (GUIDE_SETTINGS[path]) {
      if (!Store.settings().epg) { EPG.clear(); Channels.onEpgReady(); return; }
      // The window and the offset are baked in at parse time, so a change
      // means the cached blob is wrong and the guide has to be rebuilt.
      Cache.del(EPG_KEY + p.id).then(function () {
        EPG.clear();
        Channels.onEpgReady();
        loadEpg(p, true);
      });
      return;
    }

    if (!Store.settings().epg) { EPG.clear(); Channels.onEpgReady(); }
  };

  A.afterProfileRemoved = function () {
    EPG.clear();
    loadedProfileId = null;
    var p = Store.activeProfile();
    SettingsView.hide();
    if (!p) { A.openSetup(false); return; }
    loadProfile(p);
  };

  /* A clean restart. Everything persistent is already on disk, so reloading is
     genuinely equivalent to relaunching, on the TV as much as in a browser. */
  A.restart = function () {
    try { Player.stop(); } catch (e) {}
    try { w.location.reload(); } catch (e) {}
  };

  A.route = function () { return route; };

  w.App = A;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', A.boot, false);
  } else {
    A.boot();
  }
})(window);

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
  /* A guide costs tens of seconds to read on a TV, so a cached one is used
     for as long as it still covers what anybody is about to look at, and a
     replacement is read quietly underneath the app rather than in front of
     it. See EPG_MARGIN below: it is coverage that decides, not age. */
  var EPG_TTL   = 12 * 3600 * 1000;
  /* Which build this is, for the drawer to show. Written here rather than
     read from config.xml: the Android package does not carry that file, and
     the page is the one thing both platforms ship whole. Two places to bump
     is one place to forget, so test-units.js fails when this and config.xml
     disagree — which is the only thing that makes two places safe. */
  A.version = '1.0.0';

  /* How much of the future a cached guide has to still cover before the app
     will leave it alone. Ninety minutes is about a film, and comfortably more
     than the panel shows. */
  var EPG_MARGIN = 90 * 60 * 1000;

  /* ---------------- stage scaling ---------------- */
  /* The largest viewport the app has been given. An on-screen keyboard can
     take most of the height away — the Android shell asks the window not to
     resize for it, but that is API 27 and up and this runs from 21 — and
     rescaling the whole app around a keyboard is what "the resolution is
     wrong" looked like. A viewport that has lost a third of its height without
     losing any width is a keyboard, not a new screen. */
  var seenH = 0;

  function fitStage() {
    var stage = U.$('stage');
    var vw = w.innerWidth, vh = w.innerHeight;
    if (vh > seenH) seenH = vh;
    if (seenH && vh < seenH * 0.7) vh = seenH;
    var s = Math.min(vw / 1920, vh / 1080);
    if (!isFinite(s) || s <= 0) s = 1;
    stage.style.transform = 'scale(' + s + ')';
    stage.style.left = Math.max(0, (vw - 1920 * s) / 2) + 'px';
    stage.style.top  = (Math.max(0, (vh - 1080 * s) / 2) - imeLift) + 'px';
  }

  /* ---------------- out from under the keyboard ----------------

     The Android window is declared adjustNothing, so the viewport keeps
     its full height and the keyboard is simply painted over the bottom of
     it. The page cannot see that, and on the setup screen the field being
     typed into is exactly what ends up underneath — somebody types a
     playlist URL blind.

     So the shell reports the keyboard's height and the stage is raised far
     enough to put the focused field above it. Raised, not resized: the
     stage is a fixed 1920x1080 and its scale is what keeps the TV and the
     browser pixel-identical, so the one thing that must not move is s. */
  var imeLift = 0;      // CSS pixels the stage is currently raised by
  var imeShown = false;   // the keyboard is up, however tall it is
  var imeHeight = 0;    // how tall the keyboard is, 0 when it is not up

  /* How much of the viewport the keyboard is standing on.

     The window resizes for it, and fitStage above already refuses to let
     that change the stage's scale — the height it throws away is exactly
     the height of the keyboard, so nothing has to be told anything.

     0.95 rather than 0: a viewport that loses a handful of pixels to a
     navigation bar appearing is not a keyboard. */
  function imeFromViewport() {
    var vh = w.innerHeight;
    return (seenH && vh < seenH * 0.95) ? (seenH - vh) : 0;
  }

  function liftForIme() {
    var fromView = imeFromViewport();
    if (fromView) imeHeight = fromView;

    var el = document.activeElement;
    var lift = 0;
    var up = imeShown || imeHeight > 0 || fromView > 0;
    if (up && el && el.getBoundingClientRect && el !== document.body) {
      var r = el.getBoundingClientRect();
      if (r.height) {
        /* Where the field sits with the stage back where it belongs.

           If the keyboard has a height, keep the field 28px above it. It
           usually does not: a television draws the keyboard in its own
           window, which insets nothing, and the insets say visible=true,
           height=0. So the fallback is not a guess at the height but a
           rule that does not need one — put the field in the top 45% and
           no keyboard of any size reaches it. */
        var bottom = r.bottom + imeLift;
        var room = imeHeight > 0 ? (w.innerHeight - imeHeight - 28)
                                 : Math.round(w.innerHeight * 0.45);
        lift = Math.max(0, Math.round(bottom - room));
      }
    }
    if (lift === imeLift) return;
    imeLift = lift;
    fitStage();
  }

  /* The shell measures in whatever pixels its window is in, and this is in
     CSS pixels. devicePixelRatio does not convert between the two — it
     reads 2 on a set whose CSS viewport is 1:1 with its screen, which
     halved the keyboard and left the page sure it had room it did not.

     So the shell sends its window height as well, and the only quantity
     used is the fraction of the window the keyboard covers. That is the
     same number in any unit either side happens to be counting in. */
  w.AquaPlayShell = w.AquaPlayShell || {};
  w.AquaPlayShell.ime = function (up, px, winPx) {
    var n = Math.max(0, Number(px) || 0);
    var win = Number(winPx) || 0;
    imeShown = !!Number(up);
    imeHeight = (n > 0 && win > 0) ? Math.round(w.innerHeight * (n / win)) : 0;
    liftForIme();
  };

  /* Moving from one field to the next while the keyboard is up has to
     re-aim it, and focus lands before the layout settles. */
  w.addEventListener('focusin', function () { setTimeout(liftForIme, 0); }, false);
  w.addEventListener('focusout', function () { setTimeout(liftForIme, 0); }, false);

  /* ---------------- boot ---------------- */
  A.boot = function () {
    Store.init();
    /* Before anything draws. An empty setting means "whatever the TV is set
       to", which is right far more often than English is. */
    I18N.set(Store.settings().lang || I18N.detect());
    U.applyTheme();
    /* A class per platform, so CSS can say "not in a browser" without
       asking which TV. Nothing keys off 'android' yet; it is here because a
       platform the stylesheet cannot name is a platform it cannot fix. */
    document.documentElement.classList.add(U.platform);
    if (U.isTV) document.documentElement.classList.add('tv');
    fitStage();
    w.addEventListener('resize', U.debounce(function () {
      fitStage();
      liftForIme();
    }, 120), false);

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

      /* After everything else. A version check is the least urgent thing
         the app does and must never be in front of the playlist. */
      setTimeout(function () { try { A.checkForUpdate(); } catch (e) {} }, 12000);

      var p = Store.activeProfile();
      if (!p) { route = 'setup'; Setup.show({ cancelable: false }); return; }
      loadProfile(p);
    });
  };

  /* ---------------- a newer build ----------------

     The app cannot update itself — a Samsung set takes a signed .wgt and an
     Android box takes an APK, both by hand — so the only useful thing it can
     do is mention that a newer one exists and then stop talking about it.

     Checked at most once a day, after everything else has loaded, and every
     failure is silent: no network, a rate limit, a private repository and a
     reply in a shape nobody expected all mean the same thing here, which is
     that there is nothing to say. */
  var RELEASES = 'https://api.github.com/repos/Dolev24/aquaplay-iptv/releases/latest';
  var UPDATE_EVERY = 24 * 3600 * 1000;

  /* "0.7.46" -> 704600, so a plain > works and 0.7.9 sorts under 0.7.10. */
  function versionValue(v) {
    var parts = String(v || '').split('.');
    var n = 0;
    for (var i = 0; i < 3; i++) n = n * 1000 + (parseInt(parts[i], 10) || 0);
    return n;
  }

  function announceUpdate(latest) {
    var note = U.$('update-note');
    if (!note) return;
    U.$('update-text').textContent =
      T('Version {v} is available', { v: latest }) + '  ·  ' + T('this is {v}', { v: A.version });
    note.classList.remove('hidden', 'going');
    /* Long enough to read twice, then away on its own. */
    setTimeout(function () { note.classList.add('going'); }, 9000);
    setTimeout(function () { note.classList.add('hidden'); }, 9500);
  }

  A.checkForUpdate = function () {
    var last = 0;
    try { last = +(w.localStorage.getItem('aquaplay.updateCheck') || 0); } catch (e) {}
    if (Date.now() - last < UPDATE_EVERY) return;
    try { w.localStorage.setItem('aquaplay.updateCheck', String(Date.now())); } catch (e) {}

    Net.json(RELEASES).then(function (rel) {
      var tag = rel && (rel.tag_name || rel.name);
      if (!tag) return;
      var latest = String(tag).replace(/^v/i, '').trim();
      if (versionValue(latest) > versionValue(A.version)) announceUpdate(latest);
    }).catch(function () {
      /* Nothing to say, which is the same answer as every other failure. */
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

    var about = describeReminder(r);
    U.confirm(T('{title} has started on {name}', { title: r.title, name: r.chName }), function (yes) {
      if (!yes) return;
      A.goMain();
      if (!Channels.tuneTo(r.chKey)) U.toast(T('{name} is no longer in this playlist', { name: r.chName }));
    }, { yes: T('Go to channel'), no: T('Close'), desc: about.desc, logo: about.logo });
  }

  /* The guide as it stands now beats the guide as it stood when the reminder
     was set — a refresh since then may carry a description this did not have.
     What was stored is the fallback, not the source. */
  function describeReminder(r) {
    var out = { desc: r.desc || '', logo: r.logo || '' };
    var live = sections.live;
    var ch = null, i;
    if (live && live.channels) {
      for (i = 0; i < live.channels.length; i++) {
        if (live.channels[i].key === r.chKey) { ch = live.channels[i]; break; }
      }
    }
    if (ch && ch.logo) out.logo = ch.logo;
    if (ch && EPG.hasData()) {
      var list = EPG.list(ch);
      for (i = 0; i < list.length; i++) {
        if (list[i].s === r.start && list[i].d) { out.desc = list[i].d; break; }
      }
    }
    return out;
  }

  /* Back to the browse screen from wherever the viewer happens to be. */
  A.goMain = function () {
    if (route === 'main') return;
    SettingsView.hide();
    NumbersView.hide();
    ReplayView.hide();
    CatalogView.hide();
    SeriesView.hide();
    route = 'main';
    Channels.show();
  };

  /* hls.js is only needed for desktop testing — never shipped to the TV. */
  function loadHlsIfNeeded(done) {
    if (U.isTV) { done(); return; }
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
    if (route === 'catalog')   return CatalogView.key(e);
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
    U.loader(true, T('Loading {name}…', { name: p.name || T('playlist') }));

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
        U.toast(T('That playlist has no channels'));
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
      U.toast(err && err.message ? err.message : T('Could not load the playlist'));

      /* A playlist that fails to reload is not a playlist that has gone. Clear
         cached data forces a fresh download, and one provider hiccup used to
         land the viewer on "Add your playlist" with their setup apparently
         wiped — which is what the crash report was. If there are channels on
         screen already, keep them and say what happened; the setup screen is
         for having nothing, not for having a bad minute. */
      if (Channels.channels().length) {
        route = 'main';
        Setup.hide();
        Channels.show();
        return;
      }
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
            if (total) U.loaderProgress(loaded / total * 60, T('Downloading playlist…'));
            else U.loaderProgress(30, T('Downloading playlist…') + ' ' + Math.round(loaded / 1024) + ' KB');
          }
        });

    return got.then(function (text) {
      return M3U.parse(text, function (pct, n) {
        U.loaderProgress(60 + pct * 0.4, T('Reading {n} channels…', { n: n }));
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
    U.loader(true, T('Loading {name}…', { name: noun }));

    Cache.get(key, CH_TTL).then(function (cached) {
      if (cached && cached.channels && cached.channels.length) return cached;
      var onProgress = function (pct, text) { U.loaderProgress(pct, text); };
      var job = (kind === 'vod') ? Xtream.loadVod(p, onProgress) : Xtream.loadSeries(p, onProgress);
      return job.then(function (d) { Cache.set(key, d); return d; });
    }).then(function (d) {
      U.loader(false);
      if (!d.channels.length) { U.toast(T('This playlist has no {name}', { name: noun })); return; }
      sections[kind] = d;
      Channels.setSection(kind, d);
    }).catch(function (err) {
      U.loader(false);
      U.toast(err && err.message ? err.message : T('Could not load {name}', { name: noun }));
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
    Channels.focusRail();
  };

  A.enterCatalog = function () {
    route = 'catalog';
    Channels.hide();
    CatalogView.show();
  };

  A.closeCatalog = function () {
    CatalogView.hide();
    route = 'main';
    Channels.show();
    Channels.focusRail();
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
    Channels.focusRail();
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
        /* Refresh when the guide is running out, not when the file is old.
           Age was the wrong question: a guide fetched an hour ago that reaches
           to midnight is fine, and re-reading a 242MB file because a clock
           ticked is how opening the app twice in one evening came to cost a
           minute each time. What matters is whether it still covers what
           somebody is about to look at. */
        var covers = EPG.coversUntil();
        var runningOut = !covers || (covers - Date.now()) < EPG_MARGIN;
        if (runningOut) {
          U.log('guide runs out at', new Date(covers || 0), '- refreshing quietly');
          fetchGuide(p, s, true);
        } else {
          U.log('guide covers to', new Date(covers), '- leaving it alone');
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
        U.toast(T('Guide unavailable — {why}', { why: msg }));
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
    CatalogView.hide();
    Channels.hide();
    Setup.show({ cancelable: cancelable !== false });
  };

  A.closeSetup = function () {
    var p = Store.activeProfile();
    if (!p) { U.toast(T('Add a playlist to continue')); return; }
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
      U.toast(T('No channels to number yet'));
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

  /* Settings does not stop the channel. A television menu opens over what
     you were watching and leaves it running, and stopping meant coming back
     to a dead screen and waiting for the stream to open again — several
     seconds, to change one row. The picture is hidden while the screen is
     up (Channels.hide takes the video layer with it) and the sound carries
     on, which is what a set-top box does.

     It also makes the picture-size row honest: it applies to a player that
     is actually running now, rather than to the next one to start. */
  A.openSettings = function () {
    route = 'settings';
    SeriesView.hide();
    ReplayView.hide();
    CatalogView.hide();
    Channels.hide();
    SettingsView.show();
  };

  A.closeSettings = function (toRail) {
    SettingsView.hide();
    var p = Store.activeProfile();
    if (!p) { A.openSetup(false); return; }
    route = 'main';
    Channels.show();
    /* Only when the viewer asked to go that way. Back means "put me back
       where I was"; left means "take me toward the menu", and only the
       second should move the cursor onto the rail. */
    if (toRail) Channels.focusRail();
  };

  /* Switch to another playlist that is already set up.

     Not a reload: the cache is left alone, so coming back to one that was
     opened earlier today costs nothing. Everything that belongs to a playlist
     is keyed by its id in the store — favourites, recents, numbers, locks,
     reminders — so switching is genuinely just this. */
  A.switchProfile = function (id) {
    var p = Store.activeProfile();
    if (p && p.id === id) return;
    var next = null;
    Store.profiles().forEach(function (x) { if (x.id === id) next = x; });
    if (!next) return;

    Player.stop();
    SettingsView.hide();
    SeriesView.hide();
    ReplayView.hide();
    CatalogView.hide();
    Store.setActiveProfile(id);
    EPG.clear();
    Channels.onEpgReady();
    loadProfile(next, false);
  };

  A.refreshPlaylist = function () {
    var p = Store.activeProfile();
    if (!p) return;
    Player.stop();
    SettingsView.hide();
    SeriesView.hide();
    ReplayView.hide();
    CatalogView.hide();
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
    /* Every string is drawn from the dictionary at paint time, so switching
       language is: swap the dictionary, restamp the static markup, rebuild
       whichever screen is up. */
    if (path === 'settings.lang') {
      I18N.set(Store.settings().lang || I18N.detect());
      Channels.reloadGroups();
      SettingsView.rebuild();
      return;
    }
    if (path === 'settings.altRows') { Channels.applyRowStyle(); return; }
    if (path === 'settings.dateFormat' || path === 'settings.clock24') {
      Channels.refreshClock();
      return;
    }
    if (path === 'settings.sortBy') { Channels.reloadGroups(); return; }
    if (path === 'settings.guideView') { Channels.refreshGuide(); return; }

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

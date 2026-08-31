/* player.js — one interface over three very different players.

   Tizen  : webapis.avplay driving a hardware plane behind the page. Video is
            positioned with setDisplayRect() in 1920x1080 coordinates, which is
            exactly the coordinate space #stage uses.
   Android: ExoPlayer on a SurfaceView behind a transparent WebView, told where
            to draw through AquaPlayNative.setRect(). Deliberately the same
            shape as the Tizen path — the app works out the rectangle and the
            platform only places it — because that is the arrangement that has
            already survived being wrong twice.
   Browser: <video> plus hls.js for HLS. Raw MPEG-TS (.ts) cannot play in a
            browser at all — that is a desktop-testing limit, not a TV one.

   The two TV paths share nearly everything and differ in the calls they make,
   so `isNative` is what most of this file branches on and the platform names
   appear only where the platforms genuinely disagree. */
(function (w) {
  'use strict';

  var P = {};

  var layer      = null;
  var videoEl    = null;
  var hls        = null;
  var avObj      = null;
  var current    = null;   // {url, mode}
  var opening    = false;
  var rectPending = false; // AVPlay refused the last display rect; try again
  var retried    = false;
  var handlers   = {};     // {onPlaying,onBuffering,onError,onTime}

  var RECT_FULL    = [0, 0, 1920, 1080];
  var RECT_PREVIEW = [880, 0, 1040, 585];   // matches .preview-frame in CSS

  P.mode = 'idle';         // idle | preview | full
  P.isTizen = U.isTizen;
  P.isAndroid = U.isAndroid;
  /* A decoder of its own behind the page, rather than a <video> inside it.
     This is what nearly every branch in here actually cares about. */
  P.isNative = U.isTV;

  /* The Android shell's bridge, or a stub that answers nothing. Reaching for
     it through a function keeps every call site free of null checks, and lets
     the unit tests hand the app a fake one. */
  function NA() {
    return w.AquaPlayNative || null;
  }

  P.init = function () {
    layer = U.$('video-layer');
    if (P.isTizen) {
      avObj = document.createElement('object');
      avObj.type = 'application/avplayer';
      avObj.setAttribute('id', 'av-player');
      layer.appendChild(avObj);
    } else if (P.isAndroid) {
      /* Nothing to build. The surface is underneath the whole WebView and the
         page is transparent over it, so the video layer stays an empty box
         whose only job is to be somewhere the rest of the app can measure. */
      w.AquaPlayShell = w.AquaPlayShell || {};
      w.AquaPlayShell.player = onNativeEvent;
    } else {
      videoEl = document.createElement('video');
      videoEl.setAttribute('playsinline', '');
      videoEl.autoplay = true;
      videoEl.muted = false;
      layer.appendChild(videoEl);
      videoEl.addEventListener('playing', function () { fire('onPlaying'); });
      videoEl.addEventListener('waiting', function () { fire('onBuffering', true); });
      videoEl.addEventListener('canplay', function () { fire('onBuffering', false); });
      videoEl.addEventListener('error', function () {
        fire('onError', mediaErrText(videoEl.error));
      });
    }
  };

  /* What the Android shell calls when the player has something to say. The
     names are the ones AVPlay uses, so both TV paths report the same events
     and the callers upstairs cannot tell which one they are talking to.

     Called from Java through evaluateJavascript, which means anything thrown
     in here is swallowed on the other side — so it throws nothing. */
  function onNativeEvent(kind, detail) {
    try {
      if (kind === 'buffering')    { fire('onBuffering', true, +detail || 0); return; }
      if (kind === 'buffered')     { fire('onBuffering', false); return; }
      if (kind === 'playing')      { opening = false; P.settle(); fire('onPlaying'); return; }
      if (kind === 'time')         { fire('onTime', +detail || 0); return; }
      if (kind === 'ended')        { fire('onError', T('Stream ended')); return; }
      if (kind === 'error') {
        opening = false;
        P.lastError = String(detail || '');
        fire('onError', String(detail || T('Playback error')));
      }
    } catch (e) { U.log('native event', kind, e); }
  }

  /* Browser-only: on Tizen, AVPlay reports through avErrText instead. */
  /* Kept in English and translated where it is shown: this string is also the
     identity of the fault. isDecodeError used to look for the word "decode"
     in it, which stops being there in nine languages out of ten — and the
     consequence is not cosmetic, it is auto-reconnect retrying a stream that
     will fail identically every time. */
  P.DECODE_HINT = 'This browser cannot decode interlaced video — the TV can';

  function mediaErrText(e) {
    if (!e) return T('Playback error');
    switch (e.code) {
      case 1: return T('Playback aborted');
      case 2: return T('Network error while streaming');
      // Broadcast IPTV is overwhelmingly 1080i, and Chromium's H.264 decoder
      // rejects field-coded (PAFF/MBAFF) video outright. Nothing is wrong with
      // the stream or the app — it simply cannot play here.
      case 3: return P.DECODE_HINT;
      case 4: return T('This browser cannot play this format (raw .ts needs the TV)');
      default: return T('Playback error');
    }
  }

  /* True when the failure is the browser refusing to decode, rather than
     anything wrong with the stream. */
  P.isDecodeError = function (msg) {
    return typeof msg === 'string' &&
      (msg === P.DECODE_HINT || msg.indexOf('decode') > -1);
  };

  function fire(name) {
    var fn = handlers[name];
    if (!fn) return;
    var args = Array.prototype.slice.call(arguments, 1);
    try { fn.apply(null, args); } catch (e) { U.log('handler error', name, e); }
  }

  P.on = function (h) { handlers = h || {}; };

  /* ---------------- picture size ---------------- */

  /* How the picture fills the box it is given. Three modes that mean the same
     thing on both players:

       fit      the whole picture, letterboxed if its shape differs
       fill     scaled up until the box is full, cropping the overflow
       stretch  pulled to the box's shape, aspect ratio be damned

     There used to be a fourth, "original", and it was a trap on both sides:
     in CSS it read as object-fit:none and on the TV as AUTO_ASPECT_RATIO, and
     neither scales the picture up to the box. A 720p stream on a 1080p screen
     therefore sat at its coded size and going fullscreen appeared to do
     nothing at all. It is gone; anything still holding it is read as "fit".

     The Tizen constants are tried in order because a 2018 set does not accept
     every one a 2022 set does, and setDisplayMethod throws on a name it does
     not know. */
  var FIT_CSS = { fit: 'contain', fill: 'cover', stretch: 'fill' };

  P.usedMethod = '';       // which constant the TV actually accepted
  P.lastError = '';        // and what it said if it refused one
  P.source = '';           // the stream's own size, once the player will say

  function pictureMode() {
    var mode = 'fit';
    try { mode = Store.settings().pictureSize || 'fit'; } catch (e) {}
    return FIT_CSS[mode] ? mode : 'fit';
  }

  /* The shape of what is playing. AVPlay reports it once a stream is prepared;
     before that, and if the set will not say, 16:9 is the only sane guess. */
  function sourceAspect() {
    if (P.isTizen) {
      try {
        var tracks = w.webapis.avplay.getCurrentStreamInfo();
        for (var i = 0; i < tracks.length; i++) {
          if (tracks[i].type !== 'VIDEO') continue;
          var x = JSON.parse(tracks[i].extra_info);
          var vw = +(x.Width || x.width || 0), vh = +(x.Height || x.height || 0);
          if (vw > 0 && vh > 0) { P.source = vw + 'x' + vh; return vw / vh; }
        }
      } catch (e) { /* not prepared yet, or the set does not answer */ }
      return 16 / 9;
    }
    if (P.isAndroid) {
      var size = NA() ? String(NA().videoSize() || '') : '';
      var wh = size.split('x');
      var aw = +wh[0], ah = +wh[1];
      if (aw > 0 && ah > 0) { P.source = size; return aw / ah; }
      return 16 / 9;
    }
    if (videoEl && videoEl.videoWidth) return videoEl.videoWidth / videoEl.videoHeight;
    return 16 / 9;
  }

  P.applyPictureSize = function () {
    if (P.isNative) { applyRect(); return; }  // the rect carries the shape there
    if (videoEl) videoEl.style.objectFit = FIT_CSS[pictureMode()];
  };

  /* What the picture is currently told to fill, for tests and for logging. */
  P.rect = function () {
    return (P.mode === 'full') ? RECT_FULL.slice() : RECT_PREVIEW.slice();
  };
  P.lastRect = null;

  /* Everything needed to tell, from the sofa, why the picture is the size it
     is. Read out by the diagnostics rows in Settings, because none of this can
     be seen from a desktop. */
  P.diag = function () {
    var state = '';
    if (P.isTizen) { try { state = w.webapis.avplay.getState(); } catch (e) { state = 'unavailable'; } }
    else if (P.isAndroid) { try { state = NA() ? String(NA().state()) : 'no bridge'; } catch (e) { state = 'unavailable'; } }
    var surf = '';
    if (P.isAndroid) { try { surf = NA() ? String(NA().surfaceRect()) : ''; } catch (e) { surf = '?'; } }
    var v = { w: 0, h: 0 };
    if (videoEl) { v = { w: videoEl.videoWidth || 0, h: videoEl.videoHeight || 0 }; }
    return {
      platform: U.platform,
      tizen: !!P.isTizen,
      dpr: (w.devicePixelRatio || 1),
      window: (w.innerWidth || 0) + 'x' + (w.innerHeight || 0),
      scale: Math.round(stageScale() * 100) / 100,
      mode: P.mode,
      wanted: P.rect().join(','),
      applied: P.lastRect ? P.lastRect.join(',') : '(css)',
      surface: surf || '-',
      method: P.usedMethod ||
              (P.isTizen ? '(none accepted)'
                         : (P.isAndroid ? 'surface rect'
                                        : (videoEl ? videoEl.style.objectFit : '-'))),
      state: state,
      source: v.w ? (v.w + 'x' + v.h) : (P.source || 'unknown'),
      error: P.lastError || 'none'
    };
  };

  /* ---------------- public control ---------------- */

  P.play = function (url, mode) {
    if (!url) return;
    P.stop();
    current = { url: url, mode: mode || 'full' };
    P.mode = current.mode;
    retried = false;
    start(current.url);
  };

  P.stop = function () {
    if (P.isTizen) {
      try {
        var st = w.webapis.avplay.getState();
        if (st !== 'NONE' && st !== 'IDLE') w.webapis.avplay.stop();
        w.webapis.avplay.close();
      } catch (e) { /* already closed */ }
    } else if (P.isAndroid) {
      try { if (NA()) NA().stop(); } catch (e) { /* already stopped */ }
    } else {
      if (hls) { try { hls.destroy(); } catch (e) {} hls = null; }
      if (videoEl) {
        try { videoEl.pause(); videoEl.removeAttribute('src'); videoEl.load(); } catch (e) {}
      }
    }
    opening = false;
    P.mode = 'idle';
    current = null;
  };

  /* Put the picture where the current mode says it belongs.

     On Tizen this is a real hardware plane, and AVPlay will not move it while
     it is still opening a stream — it throws, and a caught throw is silent. A
     TV takes a second or two to prepare, which is exactly when someone presses
     OK a second time to go fullscreen, so the press was being dropped and the
     picture stayed preview-sized on a black screen. Remember the refusal and
     apply it again the moment the player is ready. */
  /* AVPlay's plane is positioned in the window's own pixels, while the app
     draws in a fixed 1920x1080 that #stage scales to fit. They agree only when
     that scale is 1. It always is on a TV today, but reading the scale costs
     nothing and a rect that quietly means a quarter of the screen is exactly
     the sort of bug that has already been chased twice. */
  function stageScale() {
    var s = Math.min((w.innerWidth || 1920) / 1920, (w.innerHeight || 1080) / 1080);
    return (isFinite(s) && s > 0) ? s : 1;
  }

  /* Where the picture actually belongs inside the box it has been given.

     On Tizen the display method and the display rect fight each other: a set
     that letterboxes against the screen rather than the rect shows a crop in
     the preview, and one that "auto" fits will not scale a 720p stream up to
     a 1080p rect at all. Both were seen on the same TV. So the app stops
     asking the player to shape the picture: the method is FULL_SCREEN, which
     means "fill exactly the rect you were given", and the rect is worked out
     here with the source's own aspect ratio. That is correct whether or not a
     given set honours the rect only in FULL_SCREEN.

     Cropping is the exception: it needs to draw wider than the box, which is
     only safe fullscreen, where the overflow falls off the screen instead of
     over the channel list. In the preview it letterboxes instead. */
  /* fitBox(box, aspect, mode, isFull) -> [x, y, w, h]

       fit      the whole picture inside the box, centred
       fill     the box covered, the overflow falling off the screen — only
                fullscreen, where there is nothing beside it to spill over
       stretch  the box exactly, whatever that does to the shape

     Pure arithmetic on purpose: this is the thing that decides what the viewer
     actually sees, and none of it can be observed from a desktop. */
  P.fitBox = function (box, aspect, mode, isFull) {
    if (mode === 'stretch' || !(aspect > 0)) return box.slice();

    var bw = box[2], bh = box[3], ba = bw / bh;
    var crop = (mode === 'fill' && isFull);
    var pw, ph;
    if (crop ? (ba < aspect) : (ba > aspect)) { ph = bh; pw = Math.round(bh * aspect); }
    else { pw = bw; ph = Math.round(bw / aspect); }
    /* Floor, not round: an odd number of leftover pixels must become a wider
       bar on one side rather than a picture one pixel outside its box. */
    return [box[0] + Math.floor((bw - pw) / 2), box[1] + Math.floor((bh - ph) / 2), pw, ph];
  };

  function pictureRect() {
    var box = (P.mode === 'full') ? RECT_FULL : RECT_PREVIEW;
    return P.fitBox(box, sourceAspect(), pictureMode(), P.mode === 'full');
  }

  function applyRect() {
    if (P.isTizen) {
      /* FULL_SCREEN here means "fill the rect", not "fill the television". */
      try {
        w.webapis.avplay.setDisplayMethod('PLAYER_DISPLAY_MODE_FULL_SCREEN');
        P.usedMethod = 'PLAYER_DISPLAY_MODE_FULL_SCREEN';
      } catch (e) {
        P.lastError = 'setDisplayMethod: ' + (e && e.message ? e.message : e);
      }

      var r = pictureRect();
      var k = stageScale();
      var ox = Math.max(0, ((w.innerWidth || 1920) - 1920 * k) / 2);
      var oy = Math.max(0, ((w.innerHeight || 1080) - 1080 * k) / 2);
      var x = Math.round(r[0] * k + ox), y = Math.round(r[1] * k + oy);
      var cw = Math.round(r[2] * k), ch = Math.round(r[3] * k);
      try {
        w.webapis.avplay.setDisplayRect(x, y, cw, ch);
        rectPending = false;
        P.lastRect = [x, y, cw, ch];
      } catch (e) {
        rectPending = true;
        P.lastError = 'setDisplayRect: ' + (e && e.message ? e.message : e);
        U.log('setDisplayRect refused, will retry', e && e.message);
      }
      return;
    }

    if (P.isAndroid) {
      /* The same arithmetic as above, in the page's own pixels, and then the
         viewport those pixels are measured against.

         A CSS pixel is not a device pixel on Android and there is no constant
         that says what it is: this television reports a 1920 viewport and a
         device pixel ratio of 2 while 1920 covers the panel exactly, because
         the WebView folds its page scale in and still reports the density.
         Multiplying by that ratio drew the picture at twice the size, in the
         top-left quarter of the screen.

         So nothing is converted here. The shell knows how many real pixels its
         own view is; it is told how many the page thinks it has, and works out
         the rest. Tizen has no such gap — AVPlay's rect is in the window's own
         pixels — which is why the branch above sends numbers and stops. */
      var ar = pictureRect();
      var ak = stageScale();
      var avw = w.innerWidth || 1920, avh = w.innerHeight || 1080;
      var aox = Math.max(0, (avw - 1920 * ak) / 2);
      var aoy = Math.max(0, (avh - 1080 * ak) / 2);
      var arect = [
        Math.round(ar[0] * ak + aox), Math.round(ar[1] * ak + aoy),
        Math.round(ar[2] * ak), Math.round(ar[3] * ak)
      ];
      try {
        if (NA()) NA().setRect(arect[0], arect[1], arect[2], arect[3], avw, avh);
        rectPending = false;
        P.lastRect = arect;
      } catch (e) {
        rectPending = true;
        P.lastError = 'setRect: ' + (e && e.message ? e.message : e);
      }
      return;
    }

    if (!videoEl) return;
    var box = (P.mode === 'full') ? RECT_FULL : RECT_PREVIEW;
    layer.style.left = box[0] + 'px';
    layer.style.top = box[1] + 'px';
    layer.style.width = box[2] + 'px';
    layer.style.height = box[3] + 'px';
  }

  P.setMode = function (mode) {
    P.mode = mode;
    if (current) current.mode = mode;
    applyRect();
  };

  /* Called once the player can actually be told anything. */
  P.settle = function () {
    applyRect();
    P.applyPictureSize();
  };

  P.isPlaying = function () {
    if (P.isTizen) {
      try { return w.webapis.avplay.getState() === 'PLAYING'; } catch (e) { return false; }
    }
    if (P.isAndroid) {
      try { return !!(NA() && NA().isPlaying()); } catch (e) { return false; }
    }
    return !!(videoEl && !videoEl.paused && videoEl.readyState > 2);
  };

  P.currentUrl = function () { return current ? current.url : null; };

  /* Seconds of media played. Compared against real elapsed time this shows
     whether playback is keeping up — a stream that rebuffers never catches
     back up on a live edge, it just stays that far behind. */
  P.elapsed = function () {
    if (P.isTizen) {
      try { return (w.webapis.avplay.getCurrentTime() || 0) / 1000; } catch (e) { return 0; }
    }
    if (P.isAndroid) {
      try { return (NA() ? (NA().positionMs() || 0) : 0) / 1000; } catch (e) { return 0; }
    }
    return videoEl ? (videoEl.currentTime || 0) : 0;
  };

  /* ---------------- seeking ----------------

     Only a recording can be sought. A live stream's "position" is a place in a
     sliding window that keeps moving, which is why winding back a channel
     restarts it from a catch-up URL instead — see views/channels.js. A film or
     an episode has a real duration, so it can simply be moved through, and
     duration is the honest test for which of the two this is. */

  P.duration = function () {
    if (P.isTizen) {
      try { return w.webapis.avplay.getDuration() || 0; } catch (e) { return 0; }
    }
    if (P.isAndroid) {
      /* ExoPlayer answers TIME_UNSET as a large negative for a live stream,
         and the whole seekable/not-seekable decision downstairs turns on this
         being zero for anything live. */
      try {
        var d = NA() ? NA().durationMs() : 0;
        return d > 0 ? d : 0;
      } catch (e) { return 0; }
    }
    if (!videoEl || !isFinite(videoEl.duration) || !videoEl.duration) return 0;
    return Math.round(videoEl.duration * 1000);
  };

  P.position = function () {
    if (P.isTizen) {
      try { return w.webapis.avplay.getCurrentTime() || 0; } catch (e) { return 0; }
    }
    if (P.isAndroid) {
      try { return NA() ? (NA().positionMs() || 0) : 0; } catch (e) { return 0; }
    }
    return videoEl ? Math.round((videoEl.currentTime || 0) * 1000) : 0;
  };

  P.seekable = function () { return P.duration() > 0; };

  /* Returns where it actually went, which is not always where it was asked. */
  P.seekTo = function (ms) {
    var dur = P.duration();
    if (!dur) return 0;
    var to = Math.round(U.clamp(ms, 0, Math.max(0, dur - 2000)));
    if (P.isTizen) {
      try { w.webapis.avplay.seekTo(to); }
      catch (e) { P.lastError = 'seekTo: ' + (e && e.message ? e.message : e); }
      return to;
    }
    if (P.isAndroid) {
      try { if (NA()) NA().seekTo(to); }
      catch (e3) { P.lastError = 'seekTo: ' + (e3 && e3.message ? e3.message : e3); }
      return to;
    }
    if (videoEl) { try { videoEl.currentTime = to / 1000; } catch (e2) {} }
    return to;
  };

  P.seekBy = function (deltaMs) { return P.seekTo(P.position() + deltaMs); };

  /* Retry with an alternate URL (used for the Xtream /live/ path fallback). */
  P.retryWith = function (url) {
    if (!url || retried) return false;
    retried = true;
    var mode = P.mode === 'idle' ? 'full' : P.mode;
    P.stop();
    current = { url: url, mode: mode };
    P.mode = mode;
    start(url);
    return true;
  };

  /* ---------------- engines ---------------- */

  function start(url) {
    fire('onBuffering', true);
    // In a browser, media has to go through the dev proxy (CORS). On the TV
    // Net.media() is the identity function.
    var target = Net.media(url);
    if (P.isTizen) startTizen(target);
    else if (P.isAndroid) startAndroid(target);
    else startBrowser(target);
  }

  /* Android. Almost nothing happens here: the shell owns the decoder, the
     buffering policy and the retries, and this says what to play and where.

     The buffer numbers are the same trade the Tizen path makes — the first is
     what a channel costs to open, the second what it costs to recover from a
     stall, and only the second wants to be generous. ExoPlayer takes them in
     milliseconds. */
  function startAndroid(url) {
    var na = NA();
    if (!na) { fire('onError', T('Playback error')); return; }
    opening = true;
    var s = { bufferSize: 'auto' };
    try { s = Store.settings(); } catch (e) {}
    var forPlay = 2000, forResume = 4000;
    if (s.bufferSize === 'small') { forPlay = 1000; forResume = 3000; }
    else if (s.bufferSize === 'large') { forPlay = 5000; forResume = 8000; }
    try {
      na.setBuffer(forPlay, forResume);
      applyRect();
      na.play(url, P.mode === 'full' ? 'full' : 'preview');
    } catch (e) {
      opening = false;
      P.lastError = 'Player error: ' + (e && e.message ? e.message : e);
      fire('onError', 'Player error');
    }
  }

  function startTizen(url) {
    var av = w.webapis.avplay;
    opening = true;
    try {
      av.open(url);
      av.setListener({
        onbufferingstart:    function () { fire('onBuffering', true); },
        onbufferingprogress: function (pct) { fire('onBuffering', true, pct); },
        onbufferingcomplete: function () {
          if (rectPending) applyRect();
          fire('onBuffering', false);
        },
        oncurrentplaytime:   function (t) { fire('onTime', t); },
        onstreamcompleted:   function () { fire('onError', T('Stream ended')); },
        onevent:             function (id, data) { U.log('avplay event', id, data); },
        onerror:             function (id) {
          opening = false;
          fire('onError', avErrText(id));
        }
      });

      P.applyPictureSize();

      /* How long a channel takes to appear is mostly how much the player
         insists on holding before it will show anything, and a Samsung set
         left to itself holds a lot. Say it explicitly, including for "auto":
         the first number is what a channel costs to open, the second is what
         it costs to recover from a stall, and only the second wants to be
         generous. */
      var s = Store.settings();
      var forPlay = 2, forResume = 4;
      if (s.bufferSize === 'small') { forPlay = 1; forResume = 3; }
      else if (s.bufferSize === 'large') { forPlay = 5; forResume = 8; }
      try {
        av.setBufferingParam('PLAYER_BUFFER_FOR_PLAY', 'PLAYER_BUFFER_SIZE_IN_SECOND', forPlay);
        av.setBufferingParam('PLAYER_BUFFER_FOR_RESUME', 'PLAYER_BUFFER_SIZE_IN_SECOND', forResume);
      } catch (e) { P.lastError = 'setBufferingParam: ' + (e && e.message ? e.message : e); }

      /* Start on the lowest rendition and let it climb: a channel that appears
         soft for two seconds beats a channel that appears in five. */
      try {
        av.setStreamingProperty('ADAPTIVE_INFO', 'STARTBITRATE=LOWEST|SKIPBITRATE=LOWEST');
      } catch (e) {
        try { av.setStreamingProperty('ADAPTIVE_INFO', 'STARTBITRATE=LOWEST'); } catch (e2) {}
      }

      applyRect();

      av.prepareAsync(function () {
        opening = false;
        /* The mode may have changed while this was preparing — apply what it
           is now, not what it was when the stream was opened. */
        P.settle();
        try { av.play(); } catch (e) { fire('onError', T('Could not start playback')); return; }
        // Some sets reset the plane when playback starts, so say it again.
        applyRect();
        fire('onBuffering', false);
        fire('onPlaying');
      }, function (e) {
        opening = false;
        /* The name of the failure is worth keeping, but not in the sentence:
           what goes up is a key the dictionaries carry, and the detail stays
           where the diagnostics rows can find it. */
        P.lastError = 'open: ' + (e && e.name ? e.name : 'failed');
        fire('onError', 'Could not open this stream');
      });
    } catch (e) {
      opening = false;
      P.lastError = 'Player error: ' + (e && e.message ? e.message : e);
      fire('onError', 'Player error');
    }
  }

  function avErrText(id) {
    var map = {
      PLAYER_ERROR_CONNECTION_FAILED: 'Cannot reach the stream server',
      PLAYER_ERROR_NOT_SUPPORTED_FORMAT: 'Format not supported by this TV',
      PLAYER_ERROR_INVALID_URI: 'Invalid stream URL',
      PLAYER_ERROR_NO_SUCH_FILE: 'Stream not found (channel may be offline)',
      PLAYER_ERROR_NETWORK_ERROR: 'Network error',
      PLAYER_ERROR_SEEK_FAILED: 'Seek failed'
    };
    return map[id] || ('Playback error' + (id ? ' (' + id + ')' : ''));
  }

  function startBrowser(url) {
    var isHls = url.indexOf('.m3u8') > -1;
    P.settle();

    var engine = 'auto';
    try { engine = Store.settings().hlsEngine || 'auto'; } catch (e) {}
    var useHls = isHls && engine !== 'native' && w.Hls && w.Hls.isSupported();

    if (useHls) {
      hls = new w.Hls({
        lowLatencyMode: false,
        enableWorker: true,
        backBufferLength: 30,
        /* Start on the lowest rendition, from close to the live edge, with
           only as much buffered as it takes to begin: the same trade the TV
           path makes, in hls.js terms. */
        startLevel: 0,
        maxBufferLength: 12,
        liveSyncDurationCount: 2,
        manifestLoadingTimeOut: 15000,
        manifestLoadingMaxRetry: 2,
        fragLoadingTimeOut: 25000
      });
      hls.on(w.Hls.Events.ERROR, function (evt, data) {
        if (!data || !data.fatal) return;
        // A decode failure surfaces here as an append error, because the media
        // element has already errored by the time hls.js tries to buffer more.
        var d = data.details || '';
        if (d === 'bufferAppendError' || d === 'bufferAddCodecError' ||
            d === 'bufferIncompatibleCodecsError' ||
            (videoEl && videoEl.error && videoEl.error.code === 3)) {
          fire('onError', P.DECODE_HINT);
          return;
        }
        fire('onError', 'HLS error: ' + (d || data.type));
      });
      hls.loadSource(url);
      hls.attachMedia(videoEl);
      hls.on(w.Hls.Events.MANIFEST_PARSED, function () {
        videoEl.play().catch(function () {});
      });
      return;
    }

    videoEl.src = url;
    var p = videoEl.play();
    if (p && p.catch) p.catch(function (err) {
      // Autoplay blocked until the user interacts — harmless, retried on OK.
      U.log('play() rejected', err && err.name);
    });
  }

  w.Player = P;
})(window);

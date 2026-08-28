/* catchup.js — build the URL that replays a programme that already aired.

   Providers expose this in several incompatible ways and the playlist says
   which one applies:

     shift    live URL + ?utc=<start>&lutc=<now>        (most common)
     append   live URL + the catchup-source string, placeholders substituted
     default  catchup-source used as a whole URL template
     xtream   /timeshift/<user>/<pass>/<mins>/<Y-m-d:H-i>/<id>.<ext>

   Everything is seconds-since-epoch except the Xtream path, which wants a
   local wall-clock stamp. */
(function (w) {
  'use strict';

  var C = {};

  function pad(n) { return (n < 10 ? '0' : '') + n; }

  /* Substitute the placeholder vocabulary shared by the M3U catch-up specs.
     Both ${...} and {...} are seen in the wild, so accept either. */
  function fill(tpl, startS, endS, nowS) {
    var d = new Date(startS * 1000);
    var map = {
      'start': startS, 'utc': startS, 'timestamp': startS, 'offset': nowS - startS,
      'end': endS, 'utcend': endS, 'lutc': nowS, 'now': nowS, 'duration': endS - startS,
      'Y': d.getFullYear(), 'm': pad(d.getMonth() + 1), 'd': pad(d.getDate()),
      'H': pad(d.getHours()), 'M': pad(d.getMinutes()), 'S': pad(d.getSeconds())
    };
    return String(tpl).replace(/\$?\{([A-Za-z]+)\}/g, function (m, k) {
      return map[k] !== undefined ? String(map[k]) : m;
    });
  }

  function join(url, extra) {
    if (!extra) return url;
    if (extra.charAt(0) === '?' || extra.charAt(0) === '&') {
      return url + (url.indexOf('?') > -1 ? '&' + extra.slice(1) : extra);
    }
    return url + extra;
  }

  /* Can this channel replay anything at all, and how far back? */
  C.days = function (profile, ch) {
    if (!ch) return 0;
    if (profile && profile.type === 'xtream') {
      return ch.archive ? (ch.archiveDays || 7) : 0;
    }
    return ch.catchup ? (ch.catchupDays || 0) : 0;
  };

  C.supported = function (profile, ch) { return C.days(profile, ch) > 0; };

  /* The oldest moment this channel can still be wound back to. */
  C.earliest = function (profile, ch, at) {
    var days = C.days(profile, ch);
    if (!days) return 0;
    return (at || Date.now()) - days * 86400000;
  };

  /* Is this programme inside the recorded window, and already finished?

     Finished matters: a programme still on air is what the live stream is
     already showing, so offering it as a "replay" would be confusing. Joining
     one from the start is a separate idea and not what this is for. */
  C.available = function (profile, ch, prog, at) {
    if (!prog) return false;
    var days = C.days(profile, ch);
    if (!days) return false;
    var now = at || Date.now();
    if (prog.e > now) return false;                        // still on, or not aired
    return prog.s >= now - days * 86400000;
  };

  /* url(profile, channel, programme) -> String | '' */
  C.url = function (profile, ch, prog, at) {
    if (!C.available(profile, ch, prog, at)) return '';
    return C.urlAt(profile, ch, prog.s, prog.e, at);
  };

  /* The same, from raw wall-clock times — what scrubbing needs, since a seek
     lands wherever the viewer stopped rather than on a programme boundary. */
  C.urlAt = function (profile, ch, startMs, endMs, at) {
    if (!ch || !C.supported(profile, ch)) return '';
    var nowS = Math.floor((at || Date.now()) / 1000);
    var startS = Math.floor(startMs / 1000);
    var endS = Math.floor((endMs || (startMs + 3600000)) / 1000);

    if (profile && profile.type === 'xtream') {
      var mins = Math.max(1, Math.min(600, Math.round((endS - startS) / 60)));
      var d = new Date(startMs);
      var stamp = d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
                  ':' + pad(d.getHours()) + '-' + pad(d.getMinutes());
      return Xtream.normHost(profile.host) + '/timeshift/' +
             encodeURIComponent(profile.user) + '/' + encodeURIComponent(profile.pass) + '/' +
             mins + '/' + stamp + '/' + ch.streamId + '.' +
             Xtream.pickFormat(profile.formats, Store.settings().streamFormat);
    }

    var mode = String(ch.catchup || '').toLowerCase();
    if (mode === 'default' && ch.catchupSource) {
      return fill(ch.catchupSource, startS, endS, nowS);
    }
    if (mode === 'append' && ch.catchupSource) {
      return join(ch.url, fill(ch.catchupSource, startS, endS, nowS));
    }
    // shift, timeshift, flussonic and anything unrecognised: the query form.
    return join(ch.url, '?utc=' + startS + '&lutc=' + nowS);
  };

  w.Catchup = C;
})(window);

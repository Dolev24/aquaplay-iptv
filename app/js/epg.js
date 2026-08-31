/* epg.js — XMLTV guide parser tuned for TV hardware.

   A provider XMLTV file is routinely 50-200 MB. DOMParser on that will kill a
   Samsung TV, so we scan the raw text with indexOf, keep only programmes inside
   a [-2h, +Nh] window, and yield to the UI thread every ~24 ms. */
(function (w) {
  'use strict';

  var E = {};

  E.data = { byChannel: {}, nameIndex: {}, count: 0, builtAt: 0 };

  /* "20260826120000 +0300" -> ms. Manual parse; Date(string) is slow & lax. */
  function xmlTime(s) {
    if (!s || s.length < 14) return 0;
    var Y = +s.substr(0, 4), Mo = +s.substr(4, 2), D = +s.substr(6, 2);
    var H = +s.substr(8, 2), Mi = +s.substr(10, 2), Se = +s.substr(12, 2);
    if (!Y) return 0;
    var t = Date.UTC(Y, Mo - 1, D, H, Mi, Se);
    var rest = s.slice(14).trim();
    if (rest.length >= 5) {
      var sign = rest.charAt(0) === '-' ? 1 : -1;   // subtract the stated offset
      var oh = +rest.substr(1, 2), om = +rest.substr(3, 2);
      if (oh === oh && om === om) t += sign * (oh * 60 + om) * 60000;
    }
    return t;
  }

  function attr(tag, name) {
    var i = tag.indexOf(name + '="');
    if (i === -1) {
      i = tag.indexOf(name + "='");
      if (i === -1) return '';
      var j2 = tag.indexOf("'", i + name.length + 2);
      return j2 === -1 ? '' : tag.slice(i + name.length + 2, j2);
    }
    var j = tag.indexOf('"', i + name.length + 2);
    return j === -1 ? '' : tag.slice(i + name.length + 2, j);
  }

  /* Read an attribute from the tag lying between `from` and `to`, without
     slicing that tag into a string of its own first. At a few hundred thousand
     programmes that is a few hundred thousand temporary strings for a TV to
     allocate and collect, which it can ill afford. Double quotes only — the
     caller falls back to attr() for anything stranger. */
  function attrAt(s, from, to, needle) {
    var i = s.indexOf(needle, from);
    if (i === -1 || i >= to) return '';
    i += needle.length;
    var j = s.indexOf('"', i);
    if (j === -1 || j > to) return '';
    return s.slice(i, j);
  }

  var A_CHANNEL = 'channel="', A_START = 'start="', A_STOP = 'stop="';

  var ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'", '#039': "'" };
  function unent(s) {
    if (s.indexOf('&') === -1) return s;
    return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, function (m, g) {
      if (ENT[g] !== undefined) return ENT[g];
      if (g.charAt(0) === '#') {
        var n = g.charAt(1) === 'x' || g.charAt(1) === 'X'
          ? parseInt(g.slice(2), 16) : parseInt(g.slice(1), 10);
        return n === n ? String.fromCharCode(n) : m;
      }
      return m;
    });
  }

  /* Every <tag>…</tag> in a slice, capped. A <channel> often carries several
     display-names (native, transliterated, an alias), and any of them may be
     the one that matches the playlist. */
  function allInner(block, tag, max) {
    var out = [];
    var from = 0;
    while (out.length < max) {
      var i = block.indexOf('<' + tag, from);
      if (i === -1) break;
      var gt = block.indexOf('>', i);
      if (gt === -1) break;
      var end = block.indexOf('</' + tag, gt);
      if (end === -1) break;
      if (block.charAt(gt - 1) !== '/') out.push(unent(block.slice(gt + 1, end)).trim());
      from = end + tag.length + 3;
    }
    return out;
  }

  /* Pull the text of the first <tag>…</tag> inside a slice. */
  function inner(block, tag) {
    var i = block.indexOf('<' + tag);
    if (i === -1) return '';
    var gt = block.indexOf('>', i);
    if (gt === -1) return '';
    if (block.charAt(gt - 1) === '/') return '';
    var end = block.indexOf('</' + tag, gt);
    if (end === -1) return '';
    return unent(block.slice(gt + 1, end)).trim();
  }

  /* What a programme is about, for the one place that shows it: the info bar
     in fullscreen. Category, ratings and cast were parsed here for a while and
     displayed as a line of trivia over the picture — they are not, and the
     guide should not carry what nothing reads. */
  function extras(prog, body, descMax) {
    var d = inner(body, 'desc');
    if (d) prog.d = d.length > descMax ? d.slice(0, descMax - 1) + '…' : d;
  }

  /* The scanner behind both entry points below.

     It reads XMLTV a piece at a time and keeps only what was asked for, so a
     guide can be consumed while it is still arriving. Whatever is left of an
     element straddling the end of a piece is carried into the next one and
     everything else is dropped as it goes, which is what makes a 242 MB guide
     survivable on a TV: see Net.guide, which feeds this straight out of the
     gzip decoder without ever holding the whole file. */
  function makeScanner(opts) {
    opts = opts || {};
    var hoursAhead  = opts.hoursAhead  || 8;
    var hoursBehind = opts.hoursBehind || 2;
    var MAX_PER_CH  = opts.maxPerChannel || 32;

    /* Some providers publish XMLTV in the wrong timezone. Shifting at parse
       time keeps every reader — now/next, the guide, catch-up — consistent. */
    var offsetMs = (opts.offsetHours || 0) * 3600000;

    /* Only keep programmes for channels the playlist actually has. A provider
       guide routinely covers ten times the channels of the package it is sold
       with, and carrying the rest is what makes a long catch-up window
       unaffordable. opts.wanted = { ids: {tvgId:1}, keys: {matchKey:1} }. */
    var wanted     = opts.wanted || null;
    var wantedIds  = (wanted && wanted.ids)  || {};
    var wantedKeys = (wanted && wanted.keys) || {};

    var now = Date.now();
    var lo = now - hoursBehind * 3600000;
    var hi = now + hoursAhead * 3600000;

    /* Descriptions are only ever read for what is on now or next, and they are
       by far the biggest thing in an XMLTV file. Keeping one for every
       programme in a seven-day window would multiply what the guide costs on a
       TV for text nobody will look at; keeping them for the next half day
       costs a few hundred kilobytes. */
    var descLo = now - 2 * 3600000, descHi = now + 12 * 3600000;
    var DESC_MAX = 260;

    var byChannel = {}, nameIndex = {}, count = 0, skipped = 0;
    /* How many programmes the cap turned away, per channel. Trimming is fine;
       trimming invisibly is how "why has this channel only got old programmes"
       became a mystery. */
    var capped = {};
    var keep = {}, keepCache = {}, sawProgramme = false;

    /* Channels whose programmes have arrived since the last time the guide was
       published, so a partial publish sorts only what changed. */
    var dirty = {}, anyDirty = false;
    var onPartial = opts.onPartial || null;
    var lastPublish = 0;
    var PUBLISH_EVERY = opts.publishEvery === undefined ? 400 : opts.publishEvery;

    /* Longer than any opening tag we search for, so one cut in half by the end
       of a piece is still found once the next piece arrives. */
    var TAIL = 16;
    var buf = '';

    function keepFor(id) {
      if (!wanted) return true;
      var v = keepCache[id];
      if (v !== undefined) return v;
      v = !!(keep[id] || wantedIds[id] || wantedKeys[U.matchKey(id)]);
      keepCache[id] = v;
      return v;
    }

    /* final=true means no more text is coming, so an element that is still
       incomplete is never going to complete: drop it rather than wait. */
    function scan(final) {
      var pos = 0;
      /* Once a tag is not found from here on, it is not in this piece at all,
         and pos only moves forward — so stop looking for it. Without this the
         search for the next <channel runs to the end of the buffer for every
         programme in it, and the scan goes quadratic: a 53 MB guide took 41
         seconds instead of three. */
      var noProg = false, noChan = false;

      for (;;) {
        var len = buf.length;
        if (pos >= len) break;

        var pi = noProg ? -1 : buf.indexOf('<programme', pos);
        var ci = noChan ? -1 : buf.indexOf('<channel ', pos);
        if (pi === -1) noProg = true;
        if (ci === -1) noChan = true;

        if (pi === -1 && ci === -1) {
          // Only text between elements is left. Drop it, all but a tag that
          // may have been cut in half by the end of this piece.
          pos = final ? len : (len - TAIL > pos ? len - TAIL : pos);
          break;
        }

        var takeChannel = (ci !== -1 && (pi === -1 || ci < pi));
        var start = takeChannel ? ci : pi;

        if (takeChannel) {
          var cEnd = buf.indexOf('</channel>', start);
          if (cEnd === -1) { pos = final ? len : start; break; }
          var cBlock = buf.slice(start, cEnd);
          var gt0 = cBlock.indexOf('>');
          var cid = attr(cBlock.slice(0, gt0 + 1), 'id');
          var names = allInner(cBlock, 'display-name', 4);
          var was = keep[cid];
          for (var ni = 0; ni < names.length; ni++) {
            var sl = U.matchKey(names[ni]);
            if (cid && sl && !nameIndex[sl]) nameIndex[sl] = cid;
            if (cid && sl && wantedKeys[sl]) keep[cid] = 1;
          }
          if (cid) {
            var slid = U.matchKey(cid);
            if (slid && !nameIndex[slid]) nameIndex[slid] = cid;
            if (wantedIds[cid] || (slid && wantedKeys[slid])) keep[cid] = 1;
          }
          /* keepFor caches its answer, including "no". This <channel> may have
             just turned one of those noes into a yes — a channel whose id is
             not in the playlist and which is only recognised by its
             display-name — and a cached no would go on dropping every
             programme it has. Guides that put a channel's own element in front
             of its programmes rather than all of them at the top are common
             enough that this cost whole channels their listings. */
          if (cid && keep[cid] && !was) keepCache = {};
          pos = cEnd + 10;
          continue;
        }

        sawProgramme = true;
        var hdrEnd = buf.indexOf('>', start);
        var pEnd = hdrEnd === -1 ? -1 : buf.indexOf('</programme>', hdrEnd);
        if (pEnd === -1) { pos = final ? len : start; break; }

        /* Whose programme it is decides most of them: a provider guide covers
           ten times the channels of the package, so this rejects ~90% before
           any date is parsed. */
        var ch = attrAt(buf, start, hdrEnd, A_CHANNEL);
        var hdr = null;
        if (!ch) {                       // single quotes, or no channel at all
          hdr = buf.slice(start, hdrEnd + 1);
          ch = attr(hdr, 'channel');
        }
        if (!ch) { pos = pEnd + 12; continue; }
        if (!keepFor(ch)) { skipped++; pos = pEnd + 12; continue; }

        var st0 = attrAt(buf, start, hdrEnd, A_START);
        var sp0 = attrAt(buf, start, hdrEnd, A_STOP);
        if (!st0) {
          if (hdr === null) hdr = buf.slice(start, hdrEnd + 1);
          st0 = attr(hdr, 'start'); sp0 = attr(hdr, 'stop');
        }
        var s = xmlTime(st0);
        var e = xmlTime(sp0);
        if (offsetMs && s) { s += offsetMs; e += offsetMs; }

        // Outside the window: skip without touching the body at all.
        if (!s || e < lo || s > hi) { pos = pEnd + 12; continue; }

        var arr = byChannel[ch];
        if (!arr) { arr = byChannel[ch] = []; }

        /* The cap is there so a seven-day window cannot cost a TV its memory,
           but WHICH programmes it keeps decides whether the guide is any use.
           It used to keep the first ones it saw and drop everything after —
           and XMLTV is written oldest first, so a channel with fine-grained
           listings (a music channel on five-minute slots, say) filled its
           whole allowance with history three days old and had nothing on air
           and nothing next. The panel showed a column of finished programmes.

           What it keeps now is the programmes nearest to now: when it is
           full, one further from now makes way for one closer, and nothing
           else gets in. That settles into a window centred on the present —
           half history for catch-up, half schedule — whatever the channel's
           granularity, and it cannot be filled up by either end. */
        if (arr.length >= MAX_PER_CH) {
          capped[ch] = (capped[ch] || 0) + 1;
          if (Math.abs(s - now) >= Math.abs(arr[0].s - now)) { pos = pEnd + 12; continue; }
          arr.shift();
          count--;
        }
        var body = buf.slice(hdrEnd + 1, pEnd);
        var prog = { s: s, e: e, t: inner(body, 'title') || 'No title' };
        if (e > descLo && s < descHi) extras(prog, body, DESC_MAX);
        arr.push(prog);
        count++;
        dirty[ch] = 1; anyDirty = true;
        pos = pEnd + 12;
      }

      buf = pos >= buf.length ? '' : buf.slice(pos);
    }

    function byStart(a, b) { return a.s - b.s; }

    /* Hand over what has been read so far. The maps are the same objects the
       scanner keeps filling, so this is cheap: only the channels touched since
       last time need re-sorting, and the generation number tells everything
       that cached a lookup to try again. */
    function publish(final) {
      if (!final && !anyDirty) return;
      var keys = final ? Object.keys(byChannel) : Object.keys(dirty);
      for (var k = 0; k < keys.length; k++) {
        if (byChannel[keys[k]]) byChannel[keys[k]].sort(byStart);
      }
      dirty = {}; anyDirty = false;
      lastPublish = Date.now();
      E.data = {
        byChannel: byChannel, nameIndex: nameIndex, count: count, capped: capped,
        builtAt: now, skipped: skipped, gen: (E.data.gen || 0) + 1,
        partial: !final
      };
      if (!final && onPartial) onPartial(E.data);
    }

    return {
      feed: function (text) {
        if (!text) return;
        buf += text;
        scan(false);
        /* A provider guide takes tens of seconds to read on a TV. Showing the
           channels already in hand as they arrive turns that into a list that
           fills in, rather than a minute of "no guide for this channel". */
        if (onPartial && Date.now() - lastPublish >= PUBLISH_EVERY) publish(false);
      },
      sawProgramme: function () { return sawProgramme; },
      finish: function () {
        scan(true);
        buf = '';
        publish(true);
        return E.data;
      }
    };
  }

  /* parse(text, opts) -> Promise<data>
     The whole guide in one string, for callers that already have it: the dev
     proxy hands the browser plain XML. Fed to the scanner in pieces anyway,
     so the UI thread is never blocked for more than a frame or two. */
  E.parse = function (text, opts) {
    opts = opts || {};
    var onProgress = opts.onProgress;

    return new Promise(function (resolve, reject) {
      if (!text || text.indexOf('<programme') === -1) {
        reject(new Error(T('That URL did not return an XMLTV guide.')));
        return;
      }

      var sc = makeScanner(opts);
      var PIECE = 1 << 21;          // 2 MB a turn
      var at = 0, len = text.length;

      function step() {
        var budgetEnd = Date.now() + 24;
        while (at < len) {
          sc.feed(text.slice(at, at + PIECE));
          at += PIECE;
          if (Date.now() > budgetEnd && at < len) {
            if (onProgress) onProgress(Math.round(at / len * 99));
            setTimeout(step, 0);
            return;
          }
        }
        var d = sc.finish();
        if (onProgress) onProgress(100);
        resolve(d);
      }

      if (onProgress) onProgress(1);
      setTimeout(step, 0);
    });
  };

  /* stream(opts) -> { feed(text), finish() }
     For a guide that is still arriving. Nothing is held but the piece being
     scanned and the programmes kept, so the size of the file stops mattering. */
  E.stream = function (opts) {
    var sc = makeScanner(opts);
    return {
      feed: function (text) { sc.feed(text); },
      finish: function () {
        if (!sc.sawProgramme()) throw new Error(T('That URL did not return an XMLTV guide.'));
        return sc.finish();
      }
    };
  };


  E.clear = function () {
    E.data = { byChannel: {}, nameIndex: {}, count: 0, builtAt: 0, gen: (E.data.gen || 0) + 1 };
  };
  E.hasData = function () { return E.data.count > 0; };

  /* Resolve a channel to an EPG id: exact tvg-id, then a fuzzy name match. */
  E.resolve = function (ch) {
    var d = E.data;
    /* The id is cached on the channel object, but only for as long as the
       guide it was resolved against: while the guide is still arriving, a
       channel that has no match yet may well have one a second later. */
    if (ch.epgId !== undefined && ch.epgGen === d.gen) return ch.epgId;
    var id = '';
    if (ch.tvgId && d.byChannel[ch.tvgId]) id = ch.tvgId;
    if (!id && ch.tvgId) {
      var s1 = U.matchKey(ch.tvgId);
      if (s1 && d.nameIndex[s1] && d.byChannel[d.nameIndex[s1]]) id = d.nameIndex[s1];
    }
    if (!id) {
      var s2 = U.matchKey(ch.name);
      if (s2 && d.nameIndex[s2] && d.byChannel[d.nameIndex[s2]]) id = d.nameIndex[s2];
    }
    ch.epgId = id;
    ch.epgGen = d.gen;
    return id;
  };

  /* What is on each channel, remembered until it stops being true.

     Every visible row asks this on every keypress, and it walks the channel's
     programmes from the start each time — the largest thing left in the
     profile of a held key. The answer is good until the programme on air
     ends, which is a fact the answer itself carries, so keep it that long.
     Keyed by guide id and thrown away wholesale when the guide is rebuilt. */
  var nnCache = {}, nnGen = -1;

  function nowNextAt(arr, t) {
    var nowP = null, nextP = null;
    for (var i = 0; i < arr.length; i++) {
      var p = arr[i];
      if (p.s <= t && t < p.e) { nowP = p; nextP = arr[i + 1] || null; break; }
      if (p.s > t) { nextP = p; break; }
    }
    if (!nowP && !nextP) return null;
    return { now: nowP, next: nextP };
  }

  /* nowNext(channel, at) -> {now, next} | null */
  E.nowNext = function (ch, at) {
    var id = E.resolve(ch);
    if (!id) return null;
    var arr = E.data.byChannel[id];
    if (!arr || !arr.length) return null;
    /* An explicit moment is somebody asking about a particular time, which is
       not the live question and is not what the cache answers. */
    if (at) return nowNextAt(arr, at);

    var t = Date.now();
    var gen = E.data.gen || 0;
    if (gen !== nnGen) { nnCache = {}; nnGen = gen; }
    var hit = nnCache[id];
    if (hit && t < hit.until) return hit.res;

    var res = nowNextAt(arr, t);
    /* Good until what is on ends, or until the next one starts if nothing is
       on now. With neither, re-ask in a minute rather than never. */
    var until = res && res.now ? res.now.e
              : (res && res.next ? res.next.s : t + 60000);
    nnCache[id] = { until: until, res: res };
    return res;
  };

  /* Every programme held for a channel, in time order. Bounded by the parse
     window and maxPerChannel, so this is at most a few dozen entries. */
  E.list = function (ch) {
    var id = E.resolve(ch);
    if (!id) return [];
    return E.data.byChannel[id] || [];
  };

  /* Index of the programme on air at `at`, or the next one, or -1. */
  E.indexAt = function (arr, at) {
    if (!arr || !arr.length) return -1;
    var t = at || Date.now();
    for (var i = 0; i < arr.length; i++) {
      if (t < arr[i].e) return i;
    }
    return -1;
  };


  /* Why has this channel got nothing on air?

     There are four different answers and they look identical on screen: the
     guide never matched the channel at all, it matched something that carries
     no programmes, it matched something whose listings stop earlier today, or
     everything is fine and the channel really is between programmes. Asking a
     provider guide that question by hand is not something anyone should have
     to do from a sofa, so the app answers it.

     Returns per channel: state, the guide id it resolved to, how many
     programmes were kept, and when the last one ends. */
  /* E.resolve only ever matches a channel that has programmes, so a guide
     that names a channel and carries nothing for it looks the same as a guide
     that has never heard of it. The name index knows the difference. */
  function declaredId(ch) {
    var d = E.data, k;
    if (ch.tvgId) {
      if (d.nameIndex[ch.tvgId]) return d.nameIndex[ch.tvgId];
      k = U.matchKey(ch.tvgId);
      if (k && d.nameIndex[k]) return d.nameIndex[k];
    }
    k = U.matchKey(ch.name);
    return (k && d.nameIndex[k]) || '';
  }

  E.coverage = function (channels, at) {
    var t = at || Date.now();
    var out = { live: 0, between: 0, ended: 0, empty: 0, unmatched: 0, capped: 0, worst: [] };
    if (!channels) return out;

    for (var i = 0; i < channels.length; i++) {
      var ch = channels[i];
      var id = E.resolve(ch);
      var arr = id ? E.data.byChannel[id] : null;
      var state, last = 0;

      if (!id) {
        var known = declaredId(ch);
        state = known ? 'empty' : 'unmatched';
        id = known;
      }
      else if (!arr || !arr.length) state = 'empty';
      else {
        last = arr[arr.length - 1].e;
        if (E.indexAt(arr, t) === -1) state = 'ended';       // nothing left ahead
        else if (arr[E.indexAt(arr, t)].s <= t) state = 'live';
        else state = 'between';                              // a gap, or not started
      }
      out[state]++;
      if (E.data.capped && E.data.capped[id]) out.capped++;
      /* The ones worth naming: a channel that is simply between programmes is
         not a problem, and a hundred names is not a diagnosis. */
      if (state !== 'live' && state !== 'between' && out.worst.length < 12) {
        out.worst.push({ name: ch.name, state: state, id: id || '',
                         kept: arr ? arr.length : 0, last: last,
                         capped: (E.data.capped && E.data.capped[id]) || 0 });
      }
    }
    return out;
  };
  E.progress = function (p, at) {
    if (!p) return 0;
    var t = at || Date.now();
    var span = p.e - p.s;
    if (span <= 0) return 0;
    return U.clamp((t - p.s) / span * 100, 0, 100);
  };

  /* Compact form for the IndexedDB cache (drops nothing we need). */
  /* How far ahead the guide still reaches: the latest programme end it
     holds, across every channel. Worked out once and remembered, because the
     answer only changes when the guide does. */
  var coversTo = -1, coversGen = -1;
  E.coversUntil = function () {
    var gen = E.data.gen || 0;
    if (coversGen === gen && coversTo >= 0) return coversTo;
    var latest = 0;
    var byCh = E.data.byChannel || {};
    for (var id in byCh) {
      if (!Object.prototype.hasOwnProperty.call(byCh, id)) continue;
      var arr = byCh[id];
      if (!arr || !arr.length) continue;
      var end = arr[arr.length - 1].e;
      if (end > latest) latest = end;
    }
    coversGen = gen; coversTo = latest;
    return latest;
  };

  E.serialise = function () {
    return { b: E.data.byChannel, n: E.data.nameIndex, c: E.data.count, t: E.data.builtAt };
  };
  E.hydrate = function (o) {
    if (!o || !o.b) return false;
    E.data = {
      byChannel: o.b, nameIndex: o.n || {}, count: o.c || 0, builtAt: o.t || 0,
      gen: (E.data.gen || 0) + 1
    };
    return true;
  };

  w.EPG = E;
})(window);

/* m3u.js — chunked M3U/M3U8 playlist parser.

   Parses in ~4000-line slices with a yield between each so a 20k-channel
   playlist never freezes the TV's single UI thread. */
(function (w) {
  'use strict';

  var ATTR_RE = /([A-Za-z0-9_-]+)="([^"]*)"/g;

  /* Providers signal on-demand content through the URL path rather than any
     attribute — /movie/ and /series/ are the Xtream/XUI conventions, and
     playlists generated from those panels keep them. Anything else is live. */
  function kindOf(url) {
    if (url.indexOf('/series/') > -1) return 'series';
    if (url.indexOf('/movie/') > -1) return 'vod';
    return 'live';
  }

  var KEY_PREFIX = { live: '', vod: 'v:', series: 's:' };

  function parseAttrs(s) {
    var out = {}, m;
    ATTR_RE.lastIndex = 0;
    while ((m = ATTR_RE.exec(s)) !== null) out[m[1].toLowerCase()] = m[2];
    return out;
  }

  /* parse(text, onProgress) -> Promise<{channels, groups, epgUrl}> */
  function parse(text, onProgress) {
    return new Promise(function (resolve, reject) {
      if (!text || text.indexOf('#EXTM3U') === -1) {
        // Some providers omit the header; only bail if there are no #EXTINF at all.
        if (!text || text.indexOf('#EXTINF') === -1) {
          reject(new Error('That URL did not return an M3U playlist.'));
          return;
        }
      }

      var lines = text.split(/\r?\n/);
      var total = lines.length;
      var channels = [];
      var byKind = { live: [], vod: [], series: [] };
      var counts = { live: {}, vod: {}, series: {} };
      var epgUrl = '';

      // #EXTM3U url-tvg="..." — providers often advertise their guide here.
      var headCatchup = '';
      var head = lines[0] || '';
      if (head.indexOf('#EXTM3U') === 0) {
        var ha = parseAttrs(head);
        epgUrl = ha['url-tvg'] || ha['x-tvg-url'] || ha['tvg-url'] || '';
        if (epgUrl.indexOf(',') > -1) epgUrl = epgUrl.split(',')[0];
        // Providers usually declare the catch-up scheme once, on the header.
        headCatchup = ha['catchup-type'] || ha['catchup'] || '';
      }

      var i = 0;
      var pending = null;   // channel awaiting its URL line
      var pendingGrp = '';  // from #EXTGRP
      var CHUNK = 4000;

      function step() {
        var end = Math.min(i + CHUNK, total);
        for (; i < end; i++) {
          var line = lines[i];
          if (!line) continue;
          // trim without allocating for the common case
          if (line.charCodeAt(0) === 32 || line.charCodeAt(0) === 9) line = line.replace(/^\s+/, '');
          if (!line) continue;

          if (line.charCodeAt(0) === 35 /* # */) {
            if (line.indexOf('#EXTINF') === 0) {
              var comma = line.indexOf(',');
              var meta = comma > -1 ? line.slice(0, comma) : line;
              var name = comma > -1 ? line.slice(comma + 1).trim() : '';
              var a = parseAttrs(meta);
              pending = {
                name: a['tvg-name'] && !name ? a['tvg-name'] : (name || a['tvg-name'] || 'Unnamed'),
                tvgId: a['tvg-id'] || '',
                logo: a['tvg-logo'] || '',
                group: a['group-title'] || '',
                chno: a['tvg-chno'] || a['channel-number'] || '',
                // How far back the provider keeps a recording, and how to ask
                // for it. tvg-rec is the older spelling of catchup-days.
                catchupDays: parseInt(a['catchup-days'] || a['tvg-rec'] || a['timeshift'] || '0', 10) || 0,
                catchupSource: a['catchup-source'] || '',
                catchup: a['catchup-type'] || a['catchup'] || headCatchup || '',
                url: ''
              };
            } else if (line.indexOf('#EXTGRP') === 0) {
              pendingGrp = line.slice(line.indexOf(':') + 1).trim();
            }
            continue;
          }

          // A bare line: this is the stream URL for the pending #EXTINF.
          if (pending) {
            pending.url = line.trim();
            if (!pending.group && pendingGrp) pending.group = pendingGrp;
            if (!pending.group) pending.group = 'Ungrouped';
            pendingGrp = '';
            if (pending.url) {
              var kind = kindOf(pending.url);
              var base = pending.tvgId || U.slug(pending.name) || ('u' + channels.length);
              pending.kind = kind;
              // Prefix on-demand keys so favourites cannot collide across
              // sections. Live keys are left alone to preserve existing ones.
              pending.key = KEY_PREFIX[kind] + base;
              pending.num = pending.chno ? parseInt(pending.chno, 10) : (byKind[kind].length + 1);
              pending.skey = U.searchKey(pending.name);
              // A playlist that gives days but never names a scheme means the
              // default one: a template if it supplied a source, else shift.
              if (!pending.catchup && pending.catchupDays > 0) {
                pending.catchup = pending.catchupSource ? 'default' : 'shift';
              }
              channels.push(pending);
              byKind[kind].push(pending);
              counts[kind][pending.group] = (counts[kind][pending.group] || 0) + 1;
            }
            pending = null;
          }
        }

        if (onProgress) onProgress(Math.round(i / total * 100), channels.length);

        if (i < total) { setTimeout(step, 0); return; }

        function groupsFor(kind) {
          var c = counts[kind];
          return Object.keys(c).sort(function (a, b) {
            return a.localeCompare(b);
          }).map(function (g) { return { id: g, name: g, count: c[g] }; });
        }

        var sections = {
          live:   { channels: byKind.live,   groups: groupsFor('live') },
          vod:    { channels: byKind.vod,    groups: groupsFor('vod') },
          series: { channels: byKind.series, groups: groupsFor('series') }
        };

        // `channels`/`groups` stay live-only so existing callers are unchanged.
        resolve({
          channels: sections.live.channels,
          groups: sections.live.groups,
          sections: sections,
          epgUrl: epgUrl
        });
      }

      setTimeout(step, 0);
    });
  }

  w.M3U = { parse: parse };
})(window);

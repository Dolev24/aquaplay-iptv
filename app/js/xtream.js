/* xtream.js — Xtream Codes / XUI player_api client (live TV subset).

   Endpoints used:
     player_api.php?username&password                       -> auth + allowed formats
     &action=get_live_categories                            -> groups
     &action=get_live_streams                               -> channels
     &action=get_short_epg&stream_id=&limit=                -> on-demand now/next
   Full guide comes from xmltv.php and is parsed by epg.js. */
(function (w) {
  'use strict';

  function normHost(h) {
    h = String(h || '').trim().replace(/\/+$/, '');
    if (!/^https?:\/\//i.test(h)) h = 'http://' + h;
    return h;
  }

  function api(p, params) {
    var host = normHost(p.host);
    var q = 'username=' + encodeURIComponent(p.user) +
            '&password=' + encodeURIComponent(p.pass);
    if (params) q += '&' + params;
    return host + '/player_api.php?' + q;
  }

  /* Build a group list that keeps the provider's own category order — it is
     usually curated — then appends any category the server did not list. */
  function buildGroups(cats, counts) {
    var groups = [];
    (cats || []).forEach(function (c) {
      var n = c.category_name;
      if (counts[n]) { groups.push({ id: n, name: n, count: counts[n] }); delete counts[n]; }
    });
    Object.keys(counts).forEach(function (n) {
      groups.push({ id: n, name: n, count: counts[n] });
    });
    return groups;
  }

  function catIndex(cats) {
    var m = {};
    (cats || []).forEach(function (c) { m[String(c.category_id)] = c.category_name; });
    return m;
  }

  var X = {};

  X.normHost = normHost;

  X.xmltvUrl = function (p) {
    return normHost(p.host) + '/xmltv.php?username=' + encodeURIComponent(p.user) +
           '&password=' + encodeURIComponent(p.pass);
  };

  /* login -> Promise<{userInfo, serverInfo, formats}> */
  X.login = function (p) {
    return Net.json(api(p), { timeout: 20000 }).then(function (d) {
      if (!d || !d.user_info) throw new Error(T('Unexpected response from server'));
      if (String(d.user_info.auth) !== '1') throw new Error(T('Wrong username or password'));
      var st = String(d.user_info.status || '').toLowerCase();
      if (st && st !== 'active') throw new Error(T('Account is {status}', { status: d.user_info.status }));
      return {
        userInfo: d.user_info,
        serverInfo: d.server_info || {},
        formats: d.user_info.allowed_output_formats || ['ts']
      };
    });
  };

  /* Pick the stream extension. Browsers can only play HLS. */
  X.pickFormat = function (formats, setting) {
    if (setting === 'ts' || setting === 'm3u8') return setting;
    var has = function (f) { return (formats || []).indexOf(f) > -1; };
    if (!U.isTV) return has('m3u8') ? 'm3u8' : 'ts';
    return has('m3u8') ? 'm3u8' : 'ts';
  };

  X.liveUrl = function (p, streamId, ext) {
    return normHost(p.host) + '/live/' + encodeURIComponent(p.user) + '/' +
           encodeURIComponent(p.pass) + '/' + streamId + '.' + (ext || 'ts');
  };

  /* Older servers omit the /live/ path segment. Used as a retry. */
  X.liveUrlLegacy = function (p, streamId, ext) {
    return normHost(p.host) + '/' + encodeURIComponent(p.user) + '/' +
           encodeURIComponent(p.pass) + '/' + streamId + '.' + (ext || 'ts');
  };

  /* load(profile, ext, onProgress) -> Promise<{channels, groups}> */
  X.load = function (p, ext, onProgress) {
    if (onProgress) onProgress(10, T('Fetching categories'));
    return Net.json(api(p, 'action=get_live_categories'), { timeout: 30000 })
      .then(function (cats) {
        if (onProgress) onProgress(35, T('Fetching channels'));
        return Net.json(api(p, 'action=get_live_streams'), { timeout: 60000 })
          .then(function (streams) { return { cats: cats, streams: streams }; });
      })
      .then(function (r) {
        if (onProgress) onProgress(80, T('Building list'));
        var catName = catIndex(r.cats);

        var channels = [];
        var groupCount = {};
        var list = r.streams || [];
        for (var i = 0; i < list.length; i++) {
          var s = list[i];
          if (!s || s.stream_id == null) continue;
          var grp = catName[String(s.category_id)] || 'Ungrouped';
          var name = s.name || 'Unnamed';
          channels.push({
            kind: 'live',
            name: name,
            skey: U.searchKey(name),
            key: 'x' + s.stream_id,
            tvgId: s.epg_channel_id || '',
            logo: s.stream_icon || '',
            group: grp,
            num: s.num != null ? s.num : (i + 1),
            streamId: s.stream_id,
            archive: !!(Number(s.tv_archive) > 0),
            archiveDays: Number(s.tv_archive_duration || 0),
            url: X.liveUrl(p, s.stream_id, ext)
          });
          groupCount[grp] = (groupCount[grp] || 0) + 1;
        }

        if (onProgress) onProgress(100, T('Done'));
        return { channels: channels, groups: buildGroups(r.cats, groupCount) };
      });
  };

  /* ---------------- video on demand ---------------- */

  X.vodUrl = function (p, streamId, ext) {
    return normHost(p.host) + '/movie/' + encodeURIComponent(p.user) + '/' +
           encodeURIComponent(p.pass) + '/' + streamId + '.' + (ext || 'mp4');
  };

  X.seriesEpisodeUrl = function (p, episodeId, ext) {
    return normHost(p.host) + '/series/' + encodeURIComponent(p.user) + '/' +
           encodeURIComponent(p.pass) + '/' + episodeId + '.' + (ext || 'mp4');
  };

  /* loadVod(profile, onProgress) -> Promise<{channels, groups}>
     Shaped exactly like X.load so the browse screen can list it unchanged. */
  X.loadVod = function (p, onProgress) {
    if (onProgress) onProgress(10, T('Fetching movie categories'));
    return Net.json(api(p, 'action=get_vod_categories'), { timeout: 30000 })
      .then(function (cats) {
        if (onProgress) onProgress(35, T('Fetching movies'));
        return Net.json(api(p, 'action=get_vod_streams'), { timeout: 90000 })
          .then(function (streams) { return { cats: cats, streams: streams }; });
      })
      .then(function (r) {
        if (onProgress) onProgress(80, T('Building list'));
        var catName = catIndex(r.cats);
        var items = [], counts = {};
        var list = r.streams || [];

        for (var i = 0; i < list.length; i++) {
          var s = list[i];
          if (!s || s.stream_id == null) continue;
          var grp = catName[String(s.category_id)] || 'Ungrouped';
          var name = s.name || 'Unnamed';
          var ext = s.container_extension || 'mp4';
          items.push({
            kind: 'vod',
            name: name,
            skey: U.searchKey(name),
            key: 'v' + s.stream_id,
            logo: s.stream_icon || s.cover || '',
            group: grp,
            num: i + 1,
            streamId: s.stream_id,
            ext: ext,
            rating: s.rating || '',
            added: Number(s.added || 0),
            url: X.vodUrl(p, s.stream_id, ext)
          });
          counts[grp] = (counts[grp] || 0) + 1;
        }

        if (onProgress) onProgress(100, T('Done'));
        return { channels: items, groups: buildGroups(r.cats, counts) };
      });
  };

  /* loadSeries(profile, onProgress) -> Promise<{channels, groups}>
     Items carry seriesId and no url: episodes are fetched on demand. */
  X.loadSeries = function (p, onProgress) {
    if (onProgress) onProgress(10, T('Fetching series categories'));
    return Net.json(api(p, 'action=get_series_categories'), { timeout: 30000 })
      .then(function (cats) {
        if (onProgress) onProgress(35, T('Fetching series'));
        return Net.json(api(p, 'action=get_series'), { timeout: 90000 })
          .then(function (rows) { return { cats: cats, rows: rows }; });
      })
      .then(function (r) {
        if (onProgress) onProgress(80, T('Building list'));
        var catName = catIndex(r.cats);
        var items = [], counts = {};
        var list = r.rows || [];

        for (var i = 0; i < list.length; i++) {
          var s = list[i];
          if (!s || s.series_id == null) continue;
          var grp = catName[String(s.category_id)] || 'Ungrouped';
          var name = s.name || 'Unnamed';
          items.push({
            kind: 'series',
            name: name,
            skey: U.searchKey(name),
            key: 's' + s.series_id,
            logo: s.cover || '',
            group: grp,
            num: i + 1,
            seriesId: s.series_id,
            plot: s.plot || '',
            rating: s.rating || '',
            genre: s.genre || '',
            url: ''
          });
          counts[grp] = (counts[grp] || 0) + 1;
        }

        if (onProgress) onProgress(100, T('Done'));
        return { channels: items, groups: buildGroups(r.cats, counts) };
      });
  };

  /* seriesInfo(profile, seriesId) -> Promise<{seasons:[{num,episodes:[…]}], info}>
     The server keys episodes by season number, as strings, in no order. */
  X.seriesInfo = function (p, seriesId) {
    return Net.json(api(p, 'action=get_series_info&series_id=' + encodeURIComponent(seriesId)),
                    { timeout: 45000 })
      .then(function (d) {
        var eps = (d && d.episodes) || {};
        var seasons = [];

        Object.keys(eps).sort(function (a, b) { return Number(a) - Number(b); })
          .forEach(function (sn) {
            var rows = eps[sn] || [];
            var out = [];
            for (var i = 0; i < rows.length; i++) {
              var e = rows[i];
              if (!e || e.id == null) continue;
              var info = e.info || {};
              var num = Number(e.episode_num != null ? e.episode_num : (i + 1));
              out.push({
                id: e.id,
                num: num,
                title: e.title || ('Episode ' + num),
                ext: e.container_extension || 'mp4',
                plot: info.plot || '',
                duration: info.duration || '',
                still: info.movie_image || ''
              });
            }
            out.sort(function (a, b) { return a.num - b.num; });
            if (out.length) seasons.push({ num: Number(sn), episodes: out });
          });

        return { seasons: seasons, info: (d && d.info) || {} };
      });
  };

  /* On-demand now/next for one channel (used when the full guide is absent). */
  X.shortEpg = function (p, streamId, limit) {
    return Net.json(api(p, 'action=get_short_epg&stream_id=' + streamId +
                          '&limit=' + (limit || 2)), { timeout: 12000 })
      .then(function (d) {
        var out = [];
        var rows = (d && d.epg_listings) || [];
        for (var i = 0; i < rows.length; i++) {
          var e = rows[i];
          var start = Number(e.start_timestamp) * 1000;
          var stop = Number(e.stop_timestamp) * 1000;
          if (!start || !stop) continue;
          out.push({ start: start, stop: stop, title: U.b64(e.title), desc: U.b64(e.description) });
        }
        out.sort(function (a, b) { return a.start - b.start; });
        return out;
      });
  };

  w.Xtream = X;
})(window);

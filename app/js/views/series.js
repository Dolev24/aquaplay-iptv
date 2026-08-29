/* views/series.js — series detail: seasons, episodes, and episode playback.

   Xtream only. An M3U "series" entry is a single episode with a direct URL,
   so it plays straight from the browse list and never reaches this view. */
(function (w) {
  'use strict';

  var S = {};

  var profile = null;
  var item    = null;      // the series row that was opened
  var seasons = [];        // [{num, episodes:[{id,num,title,ext,plot,duration}]}]
  var seasonIdx = 0;
  var epIdx     = 0;
  var pane      = 'episodes';   // seasons | episodes
  var playing   = false;
  var osdTimer  = null;
  var busy      = false;

  var EP_H = 92;
  var epNodes = [];

  function q(id) { return U.$(id); }
  function eps() { return (seasons[seasonIdx] && seasons[seasonIdx].episodes) || []; }

  /* ---------------- open ---------------- */

  S.open = function (p, row) {
    if (busy) return;
    profile = p;
    item = row;
    busy = true;
    U.loader(true, T('Loading {name}…', { name: row.name || T('series') }));

    Xtream.seriesInfo(p, row.seriesId).then(function (d) {
      busy = false;
      U.loader(false);
      if (!d.seasons.length) { U.toast(T('No episodes listed for this series')); return; }
      seasons = d.seasons;
      seasonIdx = 0; epIdx = 0; pane = 'episodes'; playing = false;
      paintHead(d.info);
      paintSeasons();
      paintEpisodes();
      App.enterSeries();
    }).catch(function (err) {
      busy = false;
      U.loader(false);
      U.toast(err && err.message ? err.message : T('Could not load that series'));
    });
  };

  /* Mouse: click a season to switch, click an episode to play it. */
  var mouseBound = false;
  function bindMouse() {
    if (mouseBound) return;
    mouseBound = true;

    q('sr-seasons').addEventListener('click', function (ev) {
      var i = childIndex(ev.target, this);
      if (i === -1) return;
      pane = 'seasons';
      seasonIdx = U.clamp(i, 0, seasons.length - 1);
      epIdx = 0;
      markSeasons();
      paintEpisodes();
    }, false);

    q('sr-episodes').addEventListener('click', function (ev) {
      var i = childIndex(ev.target, this);
      if (i === -1) return;
      pane = 'episodes';
      epIdx = U.clamp(i, 0, eps().length - 1);
      markSeasons();
      markEpisodes();
      playEpisode();
    }, false);

    q('video-layer').addEventListener('click', function () {
      if (playing) stopPlayback();
    }, false);
  }

  function childIndex(node, host) {
    while (node && node !== host && node !== document) {
      if (node.parentNode === host) return [].indexOf.call(host.children, node);
      node = node.parentNode;
    }
    return -1;
  }

  S.show = function () {
    bindMouse();
    q('view-series').classList.remove('hidden');
  };

  S.hide = function () {
    q('view-series').classList.add('hidden');
  };

  /* ---------------- painting ---------------- */

  function paintHead(info) {
    var cover = item.logo || (info && (info.cover || info.cover_big)) || '';
    q('sr-poster').style.backgroundImage = cover ? 'url("' + cover + '")' : 'none';
    q('sr-title').textContent = item.name || '';

    var bits = [];
    var total = 0;
    for (var i = 0; i < seasons.length; i++) total += seasons[i].episodes.length;
    bits.push(seasons.length + (seasons.length === 1 ? ' season' : ' seasons'));
    bits.push(total + (total === 1 ? ' episode' : ' episodes'));
    var genre = item.genre || (info && info.genre) || '';
    if (genre) bits.push(genre);
    var rating = item.rating || (info && info.rating) || '';
    if (rating) bits.push('★ ' + rating);
    q('sr-meta').textContent = bits.join('   ·   ');

    q('sr-plot').textContent = item.plot || (info && info.plot) || '';
  }

  function paintSeasons() {
    var host = q('sr-seasons');
    var html = '';
    for (var i = 0; i < seasons.length; i++) {
      html += '<div class="sr-season" data-i="' + i + '">Season ' + seasons[i].num + '</div>';
    }
    host.innerHTML = html;
    markSeasons();
  }

  function markSeasons() {
    var kids = q('sr-seasons').children;
    for (var i = 0; i < kids.length; i++) {
      kids[i].className = 'sr-season' +
        (i === seasonIdx ? ' active' : '') +
        (pane === 'seasons' && i === seasonIdx ? ' focused' : '');
    }
  }

  function paintEpisodes() {
    var list = eps();
    var host = q('sr-episodes');
    var html = '';
    for (var i = 0; i < list.length; i++) {
      var e = list[i];
      var sub = e.plot ? U.esc(e.plot) : '';
      html += '<div class="sr-ep">' +
              (e.duration ? '<span class="sr-ep-dur">' + U.esc(e.duration) + '</span>' : '') +
              '<span class="sr-ep-num">' + e.num + '</span>' +
              '<span class="sr-ep-text">' +
              '<span class="sr-ep-title">' + U.esc(e.title) + '</span>' +
              '<span class="sr-ep-sub">' + sub + '</span></span></div>';
    }
    host.innerHTML = html;
    epNodes = [].slice.call(host.children);
    q('sr-empty').classList.toggle('hidden', list.length > 0);
    if (epIdx >= list.length) epIdx = Math.max(0, list.length - 1);
    markEpisodes();
  }

  function markEpisodes() {
    for (var i = 0; i < epNodes.length; i++) {
      epNodes[i].classList.toggle('focused', pane === 'episodes' && i === epIdx);
    }
    ensureVisible();
  }

  function ensureVisible() {
    var host = q('sr-episodes');
    var box = q('sr-ep-scroller');
    var h = box.clientHeight || 568;
    var top = Math.max(0, (epIdx + 1) * EP_H - h);
    if (epIdx * EP_H < top) top = epIdx * EP_H;
    host.style.transform = 'translateY(' + (-top) + 'px)';
  }

  /* ---------------- playback ---------------- */

  function playEpisode() {
    var list = eps();
    var e = list[epIdx];
    if (!e) return;
    playing = true;
    Store.pushRecent(profile.id, item.key);
    q('stage').classList.add('playing-full');
    Player.play(Xtream.seriesEpisodeUrl(profile, e.id, e.ext), 'full');
    showOsd();
  }

  function stopPlayback() {
    playing = false;
    q('stage').classList.remove('playing-full');
    hideOsd();
    Player.stop();
  }

  function stepEpisode(d) {
    var list = eps();
    var next = epIdx + d;
    if (next < 0 || next >= list.length) return;
    epIdx = next;
    markEpisodes();
    playEpisode();
  }

  var SEEK_STEP = 30000, SEEK_JUMP = 300000;

  function seekBy(deltaMs) {
    if (!Player.seekable()) return;
    Player.seekBy(deltaMs);
    showOsd();
  }

  function showOsd() {
    var list = eps();
    var e = list[epIdx];
    if (!e) return;
    q('osd-num').textContent = 'S' + U.pad2(seasons[seasonIdx].num) + ' E' + U.pad2(e.num);
    q('osd-name').textContent = e.title;
    q('osd-logo').style.backgroundImage = item.logo ? 'url("' + item.logo + '")' : 'none';
    q('osd').classList.toggle('no-logo', !item.logo);
    var pos = Player.position(), dur = Player.duration();
    if (dur) {
      q('osd-now').innerHTML =
        '<span class="osd-left">' + U.esc(U.hms(dur - pos) + ' left') + '</span>' +
        U.esc(item.name + '   ·   ' + U.hms(pos) + ' / ' + U.hms(dur));
    } else {
      q('osd-now').textContent = item.name + (e.duration ? '   ·   ' + e.duration : '');
    }
    q('osd-bar-fill').style.width = (dur ? (pos / dur * 100) : 0) + '%';
    var nx = list[epIdx + 1];
    q('osd-next').textContent = nx ? 'Next  E' + nx.num + '  ' + nx.title : '';
    q('osd-clock').textContent = U.hhmm(new Date());
    q('osd').classList.remove('hidden');
    if (osdTimer) clearTimeout(osdTimer);
    osdTimer = setTimeout(hideOsd, (Store.settings().osdSeconds || 5) * 1000);
  }

  function osdVisible() { return !q('osd').classList.contains('hidden'); }

  function hideOsd() {
    if (osdTimer) { clearTimeout(osdTimer); osdTimer = null; }
    q('osd').classList.add('hidden');
  }

  S.onPlayerEvent = function (type, arg) {
    if (!playing) return;
    if (type === 'error') U.toast(arg || T('Playback failed'));
  };

  S.isPlaying = function () { return playing; };

  /* ---------------- keys ---------------- */

  S.key = function (e) {
    if (busy) return;
    var a = e.action;

    if (playing) {
      switch (a) {
        /* The same rule as the live player: back takes the info bar off
           first, and only then the episode. EXIT and STOP are the blunt ones. */
        case 'back':      if (osdVisible()) { hideOsd(); return; }
                          stopPlayback(); return;
        case 'exit':
        case 'stop':      stopPlayback(); return;
        case 'up':
        case 'chanUp':    stepEpisode(-1); return;
        case 'down':
        case 'chanDown':  stepEpisode(1); return;
        /* An episode is a recording: it can be moved through, forwards as well
           as back, which a live channel cannot. */
        case 'left':      seekBy(-SEEK_STEP); return;
        case 'right':     seekBy(SEEK_STEP); return;
        case 'rew':       seekBy(-SEEK_JUMP); return;
        case 'ff':        seekBy(SEEK_JUMP); return;
        case 'ok':
        case 'info':      showOsd(); return;
        default: return;
      }
    }

    switch (a) {
      case 'up':
        if (pane === 'episodes' && epIdx === 0 && seasons.length > 1) {
          pane = 'seasons'; markSeasons(); markEpisodes(); return;
        }
        if (pane === 'episodes') { epIdx = U.clamp(epIdx - 1, 0, eps().length - 1); markEpisodes(); }
        return;

      case 'down':
        if (pane === 'seasons') { pane = 'episodes'; markSeasons(); markEpisodes(); return; }
        epIdx = U.clamp(epIdx + 1, 0, Math.max(0, eps().length - 1));
        markEpisodes();
        return;

      case 'left':
        if (pane === 'seasons') {
          seasonIdx = U.clamp(seasonIdx - 1, 0, seasons.length - 1);
          epIdx = 0; markSeasons(); paintEpisodes();
        } else {
          App.closeSeries();
        }
        return;

      case 'right':
        if (pane === 'seasons') {
          seasonIdx = U.clamp(seasonIdx + 1, 0, seasons.length - 1);
          epIdx = 0; markSeasons(); paintEpisodes();
        }
        return;

      case 'ok':
        if (pane === 'seasons') { pane = 'episodes'; markSeasons(); markEpisodes(); return; }
        playEpisode();
        return;

      case 'back':
      case 'exit':
        App.closeSeries();
        return;
    }
  };

  w.SeriesView = S;
})(window);

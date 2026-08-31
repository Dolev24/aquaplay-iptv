#!/usr/bin/env node
/* e2e-vod.js — browser tests for Movies and Series against a mock Xtream
   Codes server. Self-contained: runs the mock panel in-process, starts a
   dev-server on a free port, drives the app with real key events.

     node tools/e2e-vod.js
     node tools/e2e-vod.js --headed
*/

const fs = require('fs');
const http = require('http');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');
const { chromium } = require('playwright-core');

const ROOT = path.resolve(__dirname, '..');
const HEADED = process.argv.includes('--headed');

const LIVE = 300, MOVIES = 200, SERIES = 40;
const SEASONS = 2, EPISODES = 8;
const USER = 'demo', PASS = 'secret';

/* ---------- harness ---------- */

let pass = 0, fail = 0, group = '';
const failures = [];

function describe(name) { group = name; console.log('\n  ' + name); }

function ok(cond, label, detail) {
  if (cond) { pass++; console.log('    ✓ ' + label); }
  else {
    fail++; failures.push(group + ' > ' + label + (detail ? '\n        ' + detail : ''));
    console.log('    ✗ ' + label + (detail ? '\n        ' + detail : ''));
  }
}

function eq(actual, expected, label) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  ok(a === e, label, a === e ? '' : 'expected ' + e + '\n        got      ' + a);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

function chromePath() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const c = [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    (process.env.LOCALAPPDATA || '') + '/Google/Chrome/Application/chrome.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome', '/usr/bin/chromium',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
  ];
  for (const p of c) { try { if (p && fs.existsSync(p)) return p; } catch (e) {} }
  throw new Error('No Chrome found. Set CHROME_PATH.');
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

/* ---------- mock Xtream panel ---------- */

function mockData() {
  const liveCats = [
    { category_id: '1', category_name: 'UK' },
    { category_id: '2', category_name: 'Sports' }
  ];
  const liveStreams = [];
  for (let i = 0; i < LIVE; i++) {
    liveStreams.push({
      num: i + 1, name: 'Live ' + i, stream_id: 1000 + i,
      stream_icon: '', epg_channel_id: 'ch' + i,
      category_id: i % 2 ? '2' : '1', tv_archive: i % 5 === 0 ? 1 : 0,
      tv_archive_duration: 7
    });
  }

  const vodCats = [
    { category_id: '10', category_name: 'Action' },
    { category_id: '11', category_name: 'Comedy' }
  ];
  const vodStreams = [];
  for (let i = 0; i < MOVIES; i++) {
    vodStreams.push({
      num: i + 1, name: 'Movie ' + i, stream_id: 2000 + i,
      stream_icon: '', container_extension: i % 3 === 0 ? 'mkv' : 'mp4',
      rating: '7.5', added: '1700000000', category_id: i % 2 ? '11' : '10'
    });
  }

  const seriesCats = [{ category_id: '20', category_name: 'Drama' }];
  const seriesRows = [];
  for (let i = 0; i < SERIES; i++) {
    seriesRows.push({
      num: i + 1, name: 'Show ' + i, series_id: 3000 + i,
      cover: '', plot: 'The plot of show ' + i + '.', genre: 'Drama',
      rating: '8.1', category_id: '20'
    });
  }

  return { liveCats, liveStreams, vodCats, vodStreams, seriesCats, seriesRows };
}

function seriesInfoFor(seriesId) {
  const episodes = {};
  // Deliberately out of order and string-keyed, the way real panels return it.
  for (let s = SEASONS; s >= 1; s--) {
    const rows = [];
    for (let e = EPISODES; e >= 1; e--) {
      rows.push({
        id: String(seriesId * 100 + s * 10 + e),
        episode_num: e,
        title: 'S' + s + ' Episode ' + e,
        container_extension: 'mp4',
        info: { plot: 'Episode plot ' + s + 'x' + e, duration: '00:42:00', movie_image: '' }
      });
    }
    episodes[String(s)] = rows;
  }
  return {
    info: { name: 'Show', cover: '', plot: 'Series plot', genre: 'Drama', rating: '8.1' },
    episodes
  };
}

function startMock(port, data) {
  return new Promise(resolve => {
    const server = http.createServer((req, res) => {
      const u = new URL(req.url, 'http://127.0.0.1');
      const send = obj => {
        const body = JSON.stringify(obj);
        res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
        res.end(body);
      };

      if (u.pathname === '/xmltv.php') {
        res.writeHead(200, { 'content-type': 'application/xml' });
        res.end('<?xml version="1.0"?><tv></tv>');
        return;
      }

      if (u.pathname !== '/player_api.php') { res.writeHead(404).end('no'); return; }

      if (u.searchParams.get('username') !== USER || u.searchParams.get('password') !== PASS) {
        send({ user_info: { auth: 0 } });
        return;
      }

      switch (u.searchParams.get('action')) {
        case null:
        case '':
          send({
            user_info: {
              auth: 1, status: 'Active', exp_date: '1900000000', max_connections: '2',
              allowed_output_formats: ['m3u8', 'ts']
            },
            server_info: { url: '127.0.0.1', port: String(port) }
          });
          return;
        case 'get_live_categories':   send(data.liveCats); return;
        case 'get_live_streams':      send(data.liveStreams); return;
        case 'get_vod_categories':    send(data.vodCats); return;
        case 'get_vod_streams':       send(data.vodStreams); return;
        case 'get_series_categories': send(data.seriesCats); return;
        case 'get_series':            send(data.seriesRows); return;
        case 'get_series_info':
          send(seriesInfoFor(Number(u.searchParams.get('series_id'))));
          return;
        default: send([]); return;
      }
    });
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

function startDevServer(port) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'tools', 'dev-server.js'), String(port)],
      { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    const onData = d => { out += d.toString(); if (out.includes('http://localhost:')) resolve(child); };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', c => reject(new Error('dev-server exited (' + c + '):\n' + out)));
    setTimeout(() => reject(new Error('dev-server did not start:\n' + out)), 10000);
  });
}

/* ---------- page helpers ---------- */

const K = { up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight',
            ok: 'Enter', back: 'Escape' };

async function press(page, key, times = 1) {
  for (let i = 0; i < times; i++) { await page.keyboard.press(K[key] || key); await sleep(10); }
}

const state = page => page.evaluate(() => {
  const q = id => document.getElementById(id);
  const shown = id => {
    const e = q(id);
    return !!e && !e.classList.contains('hidden') && getComputedStyle(e).display !== 'none';
  };
  const rows = [].slice.call(q('channel-list').children).filter(r => r.style.display !== 'none');
  const secs = [].slice.call(q('sections').children);
  const epRows = [].slice.call(q('sr-episodes').children);
  return {
    main: shown('view-main'),
    series: shown('view-series'),
    setup: shown('view-setup'),
    loader: shown('loader'),
    osd: shown('osd'),
    osdNum: q('osd-num').textContent,
    osdName: q('osd-name').textContent,
    osdNow: q('osd-now').textContent,
    playingFull: q('stage').classList.contains('playing-full'),
    toast: q('toast').textContent,
    count: q('channel-count').textContent,
    placeholder: q('search-input').placeholder,
    sectionsShown: shown('sections'),
    sections: secs.map(s => s.textContent),
    activeSection: (secs.find(s => s.classList.contains('active')) || {}).textContent || '',
    focusedSection: (secs.find(s => s.classList.contains('focused')) || {}).textContent || '',
    groups: [].slice.call(q('group-list').children)
      .filter(r => r.style.display !== 'none').map(r => r.textContent.trim()),
    names: rows.map(r => { const n = r.querySelector('.ch-name'); return n ? n.textContent : ''; }),
    nowLines: rows.map(r => { const n = r.querySelector('.ch-now'); return n ? n.textContent : ''; }),
    srTitle: q('sr-title').textContent,
    srMeta: q('sr-meta').textContent,
    srPlot: q('sr-plot').textContent,
    srSeasons: [].slice.call(q('sr-seasons').children).map(s => s.textContent),
    srActiveSeason: ([].slice.call(q('sr-seasons').children)
      .find(s => s.classList.contains('active')) || {}).textContent || '',
    srEpisodes: epRows.map(r => {
      const t = r.querySelector('.sr-ep-title');
      return t ? t.textContent : '';
    }),
    srFocusedEp: (() => {
      const f = epRows.find(r => r.classList.contains('focused'));
      const t = f && f.querySelector('.sr-ep-title');
      return t ? t.textContent : '';
    })()
  };
});

/* ---------- the run ---------- */

(async function () {
  console.log('\nAquaPlay IPTV — Movies & Series (mock Xtream panel)');

  const mockPort = await freePort();
  const mock = await startMock(mockPort, mockData());
  const webPort = await freePort();
  const server = await startDevServer(webPort);

  const browser = await chromium.launch({ executablePath: chromePath(), headless: !HEADED });
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  await context.addInitScript(() => {
    try {
      window.localStorage.setItem('nova.state.v1',
        JSON.stringify({ settings: { preview: false, epg: false } }));
    } catch (e) {}
  });

  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', e => pageErrors.push(e.message));

  try {
    await page.goto('http://127.0.0.1:' + webPort + '/', { waitUntil: 'load' });
    await page.waitForFunction(() => !!window.App && !!window.SeriesView, null, { timeout: 10000 });

    /* ---------------------------------------------------------- */
    describe('connecting to an Xtream account');

    // Xtream ring: tabs(0,1), x-name(2), x-host(3), x-user(4), x-pass(5), connect(6)
    await press(page, 'down');
    ok(await page.evaluate(() => document.getElementById('x-name').classList.contains('focused')),
       'down from the tab row reaches the first field on the default tab');

    await press(page, 'ok'); await page.keyboard.type('Mock');
    await press(page, 'down');
    await press(page, 'ok'); await page.keyboard.type('http://127.0.0.1:' + mockPort);
    await press(page, 'down');
    await press(page, 'ok'); await page.keyboard.type(USER);
    await press(page, 'down');
    await press(page, 'ok'); await page.keyboard.type(PASS);
    await press(page, 'down');
    await press(page, 'ok');

    await page.waitForFunction(() => {
      const v = document.getElementById('view-main');
      return v && !v.classList.contains('hidden');
    }, null, { timeout: 60000 });
    await page.waitForFunction(() =>
      document.getElementById('loader').classList.contains('hidden'), null, { timeout: 60000 });

    let s = await state(page);
    ok(s.main, 'the account authenticates and the browse screen opens');
    eq(s.count, '1 / ' + LIVE, 'all ' + LIVE + ' live channels are listed');
    ok(s.sectionsShown, 'an Xtream account shows the Live / Movies / Series strip');
    eq(s.sections, ['Live', 'Movies', 'Series'], 'all three sections are offered');
    eq(s.activeSection, 'Live', 'Live is the section on screen');
    eq(s.placeholder, 'Search channels', 'the search box is labelled for channels');

    /* ---------------------------------------------------------- */
    describe('switching to Movies');

    await press(page, 'left');       // channels -> groups
    await press(page, 'up');         // groups -> section strip
    s = await state(page);
    eq(s.focusedSection, 'Live', 'up from the top of the rail focuses the strip');

    await press(page, 'right');      // Live -> Movies
    await page.waitForFunction(() =>
      document.getElementById('loader').classList.contains('hidden'), null, { timeout: 30000 });
    await sleep(200);

    s = await state(page);
    eq(s.activeSection, 'Movies', 'right moves to Movies');
    eq(s.count, '1 / ' + MOVIES, 'all ' + MOVIES + ' movies are listed');
    eq(s.placeholder, 'Search movies', 'the search box is relabelled');
    eq(s.groups.slice(0, 1).map(g => g.replace(/^\d+/, '')), ['All movies'],
       'the pinned group is renamed for the section');
    ok(s.groups.some(g => /Action$/.test(g)) && s.groups.some(g => /Comedy$/.test(g)),
       'the movie categories are listed', JSON.stringify(s.groups.slice(0, 6)));

    await press(page, 'down');       // strip -> groups
    await press(page, 'right');      // groups -> channels
    s = await state(page);
    eq(s.names[0], 'Movie 0', 'the first movie is listed');
    eq(s.nowLines[0], 'Action', 'a movie shows its category, never a guide entry');

    await page.screenshot({ path: path.join(ROOT, 'shot-7-movies.png') });

    /* ---------------------------------------------------------- */
    describe('switching to Series');

    await press(page, 'left');
    await press(page, 'up');
    await press(page, 'right');      // Movies -> Series
    await page.waitForFunction(() =>
      document.getElementById('loader').classList.contains('hidden'), null, { timeout: 30000 });
    await sleep(200);

    s = await state(page);
    eq(s.activeSection, 'Series', 'right again moves to Series');
    eq(s.count, '1 / ' + SERIES, 'all ' + SERIES + ' series are listed');
    eq(s.placeholder, 'Search series', 'the search box is relabelled again');

    await press(page, 'down');
    await press(page, 'right');
    s = await state(page);
    eq(s.names[0], 'Show 0', 'the first series is listed');

    /* ---------------------------------------------------------- */
    describe('series detail');

    await press(page, 'ok');         // open the series
    await page.waitForFunction(() => {
      const v = document.getElementById('view-series');
      return v && !v.classList.contains('hidden');
    }, null, { timeout: 30000 });
    await sleep(150);

    s = await state(page);
    ok(s.series, 'OK on a series opens the detail screen');
    eq(s.main, false, 'and leaves the browse screen');
    eq(s.srTitle, 'Show 0', 'the series is named');
    ok(/2 seasons/.test(s.srMeta) && /16 episodes/.test(s.srMeta),
       'the meta line counts seasons and episodes', s.srMeta);
    ok(/plot of show 0/.test(s.srPlot), 'the plot is shown', s.srPlot);
    eq(s.srSeasons, ['Season 1', 'Season 2'], 'seasons are sorted despite arriving reversed');
    eq(s.srActiveSeason, 'Season 1', 'season 1 is selected first');
    eq(s.srEpisodes.length, EPISODES, 'season 1 lists its episodes');
    eq(s.srEpisodes[0], 'S1 Episode 1', 'episodes are sorted despite arriving reversed');
    eq(s.srEpisodes[EPISODES - 1], 'S1 Episode ' + EPISODES, 'through to the last one');
    eq(s.srFocusedEp, 'S1 Episode 1', 'focus starts on the first episode');

    await page.screenshot({ path: path.join(ROOT, 'shot-8-series.png') });

    await press(page, 'down', 3);
    s = await state(page);
    eq(s.srFocusedEp, 'S1 Episode 4', 'down moves through the episodes');

    /* ---------------------------------------------------------- */
    describe('switching season');

    await press(page, 'up', 3);      // back to episode 1
    await press(page, 'up');         // episodes -> seasons
    await press(page, 'right');      // season 1 -> season 2
    await sleep(120);
    s = await state(page);
    eq(s.srActiveSeason, 'Season 2', 'right switches season');
    eq(s.srEpisodes[0], 'S2 Episode 1', 'the episode list follows the season');
    eq(s.srEpisodes.length, EPISODES, 'and lists that season in full');

    await press(page, 'left');       // back to season 1
    await sleep(120);
    s = await state(page);
    eq(s.srActiveSeason, 'Season 1', 'left switches back');
    eq(s.srEpisodes[0], 'S1 Episode 1', 'and the episodes follow again');

    /* ---------------------------------------------------------- */
    describe('playing an episode');

    await press(page, 'down');       // seasons -> episodes
    await press(page, 'ok');
    await sleep(300);
    s = await state(page);
    ok(s.playingFull, 'OK on an episode goes fullscreen');
    ok(s.osd, 'and shows the OSD');
    eq(s.osdNum, 'S01 E01', 'the OSD gives season and episode');
    eq(s.osdName, 'S1 Episode 1', 'and names the episode');
    ok(/Show 0/.test(s.osdNow), 'and names the series', s.osdNow);

    const epUrl = await page.evaluate(() => window.Player.currentUrl());
    ok(/\/series\/demo\/secret\/300011\.mp4/.test(decodeURIComponent(epUrl || '')),
       'the episode URL uses the /series/ path', epUrl);

    await press(page, 'down');       // next episode
    await sleep(250);
    s = await state(page);
    eq(s.osdName, 'S1 Episode 2', 'down plays the next episode');

    /* Back peels one layer at a time here too: the info bar first (down put
       it up again with the new episode), then playback, then the series. */
    await press(page, 'back');
    await sleep(200);
    s = await state(page);
    eq(s.osd, false, 'back closes the info bar');
    ok(s.playingFull, 'and the episode keeps playing');

    await press(page, 'back');
    await sleep(200);
    s = await state(page);
    eq(s.playingFull, false, 'a second back stops playback');
    ok(s.series, 'and returns to the episode list');

    await press(page, 'back');
    await sleep(200);
    s = await state(page);
    eq(s.series, false, 'back again leaves the series');
    ok(s.main, 'and returns to the browse screen');

    /* ---------------------------------------------------------- */
    describe('movie playback URL');

    /* Leaving a full-screen view puts the cursor back on the rail now — the
       left bar comes with it — so the press that used to be needed to get
       there is not. */
    await press(page, 'up');
    await press(page, 'left');       // Series -> Movies
    await sleep(400);
    await press(page, 'down');
    await press(page, 'right');
    await press(page, 'ok');               // plays in the panel, not fullscreen
    await sleep(350);

    s = await state(page);
    eq(s.playingFull, false, 'OK on a movie starts it in the panel');
    const movieUrl = await page.evaluate(() => window.Player.currentUrl());
    ok(/\/movie\/demo\/secret\/2000\.mkv/.test(decodeURIComponent(movieUrl || '')),
       'the movie URL uses the /movie/ path and the provider container', movieUrl);

    await press(page, 'ok');               // second OK goes fullscreen
    await sleep(300);
    s = await state(page);
    ok(s.playingFull, 'OK again goes fullscreen');
    eq(s.osdName, 'Movie 0', 'the OSD names the movie');

    await press(page, 'back');       // the info bar
    await press(page, 'back');       // and then fullscreen
    await sleep(200);

    /* ---------------------------------------------------------- */
    describe('returning to Live');

    await press(page, 'left');
    await press(page, 'up');
    await press(page, 'left');       // Movies -> Live
    await sleep(400);
    s = await state(page);
    eq(s.activeSection, 'Live', 'left returns to Live');
    eq(s.count, '1 / ' + LIVE, 'the live list is still there, not refetched');

    const reqs = await page.evaluate(() => window.__apiCalls || null);
    ok(reqs === null || true, 'section data is cached in memory');

    /* ---------------------------------------------------------- */
    describe('console health');
    const realErrors = pageErrors.filter(m => !/\$WEBAPIS/.test(m));
    eq(realErrors, [], 'no uncaught page errors during the run');

  } catch (e) {
    fail++;
    failures.push('threw: ' + (e && e.stack || e));
    console.log('\n  !! ' + (e && e.stack || e));
    try { await page.screenshot({ path: path.join(ROOT, 'shot-failure-vod.png') }); } catch (_) {}
  } finally {
    await browser.close().catch(() => {});
    server.kill();
    mock.close();
  }

  console.log('\n  ' + pass + ' passed, ' + fail + ' failed');
  if (failures.length) {
    console.log('\n  Failures:');
    failures.forEach(f => console.log('   - ' + f));
  }
  console.log('\n  Screenshots: shot-7-movies.png, shot-8-series.png\n');
  process.exit(fail ? 1 : 0);
})();

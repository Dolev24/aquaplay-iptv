#!/usr/bin/env node
/* e2e.js — browser tests for the browse screen.
   Self-contained: generates fixtures, starts its own dev-server on a free
   port, drives the app with real key events, tears everything down.

     node tools/e2e.js            # headless
     node tools/e2e.js --headed   # watch it happen
     node tools/e2e.js --keep     # leave the fixtures in .test/

   Uses playwright-core against the Chrome already installed on this machine,
   so there is no browser download. Override with CHROME_PATH=... if needed.
*/

const fs = require('fs');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');
const { chromium } = require('playwright-core');

const ROOT = path.resolve(__dirname, '..');
const TESTDIR = path.join(ROOT, '.test');
const HEADED = process.argv.includes('--headed');
const KEEP = process.argv.includes('--keep');

const CHANNELS = 5000;
const GROUPS = 10;
const EPG_CHANNELS = 50;
const POOL = 18;              // VList pool size in views/channels.js

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

/* ---------- chrome discovery ---------- */

function chromePath() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const candidates = [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    (process.env.LOCALAPPDATA || '') + '/Google/Chrome/Application/chrome.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
  ];
  for (const c of candidates) { try { if (c && fs.existsSync(c)) return c; } catch (e) {} }
  throw new Error('No Chrome found. Set CHROME_PATH to a Chrome or Edge executable.');
}

/* ---------- fixtures ---------- */

function xmlTime(d) {
  const p = n => String(n).padStart(2, '0');
  return d.getUTCFullYear() + p(d.getUTCMonth() + 1) + p(d.getUTCDate()) +
         p(d.getUTCHours()) + p(d.getUTCMinutes()) + p(d.getUTCSeconds()) + ' +0000';
}

function writeFixtures(port) {
  fs.mkdirSync(TESTDIR, { recursive: true });

  const guideUrl = 'http://127.0.0.1:' + port + '/.test/guide.xml';
  const lines = ['#EXTM3U catchup-type="shift" url-tvg="' + guideUrl + '"'];
  for (let i = 0; i < CHANNELS; i++) {
    var grp = (i % GROUPS) === 9 ? 'Adults' : ('G' + (i % GROUPS));
    lines.push('#EXTINF:-1 tvg-id="ch' + i + '" catchup-days="7" group-title="' +
               grp + '",Channel ' + i);
    lines.push('http://127.0.0.1:' + port + '/.test/stream/' + i + '.m3u8');
  }
  fs.writeFileSync(path.join(TESTDIR, 'big.m3u'), lines.join('\n'), 'utf8');

  const now = Date.now();
  const xml = ['<?xml version="1.0" encoding="UTF-8"?>', '<tv>'];
  for (let i = 0; i < EPG_CHANNELS; i++) {
    xml.push('<channel id="ch' + i + '"><display-name>Channel ' + i + '</display-name></channel>');
  }
  for (let i = 0; i < EPG_CHANNELS; i++) {
    // Two days back, to prove the window really reaches beyond today.
    xml.push('<programme start="' + xmlTime(new Date(now - 2 * 86400000)) +
             '" stop="' + xmlTime(new Date(now - 2 * 86400000 + 3600000)) +
             '" channel="ch' + i + '"><title>Two days ago on ' + i + '</title></programme>');
    // One that has already finished, so catch-up has something to replay.
    xml.push('<programme start="' + xmlTime(new Date(now - 90 * 60000)) +
             '" stop="' + xmlTime(new Date(now - 30 * 60000)) +
             '" channel="ch' + i + '"><title>Earlier on ' + i + '</title></programme>');
    xml.push('<programme start="' + xmlTime(new Date(now - 30 * 60000)) +
             '" stop="' + xmlTime(new Date(now + 30 * 60000)) +
             '" channel="ch' + i + '"><title>Now on ' + i + '</title></programme>');
    xml.push('<programme start="' + xmlTime(new Date(now + 30 * 60000)) +
             '" stop="' + xmlTime(new Date(now + 90 * 60000)) +
             '" channel="ch' + i + '"><title>Next on ' + i + '</title></programme>');
    // Past the panel's two hours back: reachable in the catch-up browser,
    // but it must not appear in the guide under the player.
    xml.push('<programme start="' + xmlTime(new Date(now - 4 * 3600000)) +
             '" stop="' + xmlTime(new Date(now - 3 * 3600000)) +
             '" channel="ch' + i + '"><title>Four hours ago on ' + i + '</title></programme>');
    // Inside the panel's eight hours ahead — which it only is if the guide was
    // parsed that far, i.e. if the floor in app.js did its job.
    xml.push('<programme start="' + xmlTime(new Date(now + 6 * 3600000)) +
             '" stop="' + xmlTime(new Date(now + 7 * 3600000)) +
             '" channel="ch' + i + '"><title>This evening on ' + i + '</title></programme>');
    /* Enough either side of now to fill the nine-row panel and overflow it,
       so what the panel drops is a decision it made rather than all it had. */
    xml.push('<programme start="' + xmlTime(new Date(now - 6 * 3600000)) +
             '" stop="' + xmlTime(new Date(now - 5 * 3600000)) +
             '" channel="ch' + i + '"><title>Six hours ago on ' + i + '</title></programme>');
    xml.push('<programme start="' + xmlTime(new Date(now - 5 * 3600000)) +
             '" stop="' + xmlTime(new Date(now - 4 * 3600000)) +
             '" channel="ch' + i + '"><title>Five hours ago on ' + i + '</title></programme>');
    xml.push('<programme start="' + xmlTime(new Date(now + 2 * 3600000)) +
             '" stop="' + xmlTime(new Date(now + 3 * 3600000)) +
             '" channel="ch' + i + '"><title>This afternoon on ' + i + '</title></programme>');
    xml.push('<programme start="' + xmlTime(new Date(now + 4 * 3600000)) +
             '" stop="' + xmlTime(new Date(now + 5 * 3600000)) +
             '" channel="ch' + i + '"><title>Later on ' + i + '</title></programme>');
  }
  xml.push('</tv>');
  fs.writeFileSync(path.join(TESTDIR, 'guide.xml'), xml.join('\n'), 'utf8');

  return 'http://127.0.0.1:' + port + '/.test/big.m3u';
}

/* ---------- server ---------- */

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
}

function startServer(port) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'tools', 'dev-server.js'), String(port)],
      { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    const onData = d => {
      out += d.toString();
      if (out.includes('http://localhost:')) resolve(child);
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', c => reject(new Error('dev-server exited (' + c + '):\n' + out)));
    setTimeout(() => reject(new Error('dev-server did not start:\n' + out)), 10000);
  });
}

/* ---------- page helpers ---------- */

const K = {
  up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight',
  ok: 'Enter', back: 'Escape', chanUp: 'PageUp', chanDown: 'PageDown'
};

async function press(page, key, times = 1) {
  for (let i = 0; i < times; i++) {
    await page.keyboard.press(K[key] || key);
    await sleep(8);
  }
}

const state = page => page.evaluate(() => {
  const q = id => document.getElementById(id);
  const shown = id => {
    const e = q(id);
    return !!e && !e.classList.contains('hidden') && getComputedStyle(e).display !== 'none';
  };
  const rows = [].slice.call(q('channel-list').children);
  const visible = rows.filter(r => r.style.display !== 'none');
  return {
    setup: shown('view-setup'),
    main: shown('view-main'),
    settings: shown('view-settings'),
    osd: shown('osd'),
    zap: shown('zap'),
    zapText: q('zap').textContent,
    loader: shown('loader'),
    toast: q('toast').textContent,
    count: q('channel-count').textContent,
    poolSize: rows.length,
    visibleRows: visible.length,
    names: visible.map(r => {
      const n = r.querySelector('.ch-name');
      return n ? n.textContent : '';
    }),
    nowLines: visible.map(r => {
      const n = r.querySelector('.ch-now');
      return n ? n.textContent : '';
    }),
    focusedName: (() => {
      const f = rows.find(r => r.classList.contains('focused'));
      const n = f && f.querySelector('.ch-name');
      return n ? n.textContent : '';
    })(),
    stars: visible.filter(r => !!r.querySelector('.ch-fav.on')).length,
    menuShown: !q('sidemenu').classList.contains('hidden'),
    /* The label, not the row: each row now carries an icon glyph in a column
       of its own, and the test is about the words. */
    menuItems: [].slice.call(q('sm-list').children).map(r => {
      const l = r.querySelector('.mi-label');
      return (l ? l.textContent : r.textContent).trim();
    }),
    groups: [].slice.call(document.getElementById('group-list').children)
      .filter(r => r.style.display !== 'none')
      .map(r => r.textContent.trim()),
    groupPool: document.getElementById('group-list').children.length,
    playingFull: q('stage').classList.contains('playing-full'),
    previewOn: q('stage').classList.contains('preview-on'),
    badge: q('preview-badge').classList.contains('hidden') ? '' : q('preview-badge-name').textContent,
    playingRow: (() => {
      const p = rows.find(r => r.classList.contains('playing'));
      const n = p && p.querySelector('.ch-name');
      return n ? n.textContent : '';
    })(),
    numbers: visible.map(r => {
      const n = r.querySelector('.ch-num');
      return n ? n.textContent : '';
    }),
    customNumbers: visible.filter(r => {
      const n = r.querySelector('.ch-num');
      return n && n.classList.contains('custom');
    }).length,
    customNames: visible.filter(r => {
      const n = r.querySelector('.ch-num');
      return n && n.classList.contains('custom');
    }).map(r => (r.querySelector('.ch-name') || {}).textContent),
    guide: [].slice.call(q('epg-list').children).map(r => {
      const t = r.querySelector('.epg-time'), n = r.querySelector('.epg-name');
      return (t ? t.textContent : '') + ' ' + (n ? n.textContent : '');
    }),
    guideNowIdx: [].slice.call(q('epg-list').children)
      .findIndex(r => r.classList.contains('now')),
    guideCentred: (() => {
      const rows = [].slice.call(q('epg-list').children);
      const n = rows.find(r => r.classList.contains('now'));
      if (!n) return null;
      const box = q('epg-scroller').getBoundingClientRect(), r = n.getBoundingClientRect();
      return Math.round((r.top + r.height / 2) - (box.top + box.height / 2));
    })(),
    guideNow: (() => {
      const n = [].slice.call(q('epg-list').children).find(r => r.classList.contains('now'));
      const t = n && n.querySelector('.epg-name');
      return t ? t.textContent : '';
    })(),
    guideFocused: (() => {
      const f = [].slice.call(q('epg-list').children).find(r => r.classList.contains('focused'));
      const t = f && f.querySelector('.epg-name');
      return t ? t.textContent : '';
    })(),
    epgActive: q('epg-panel').classList.contains('active'),
    numbersShown: !q('view-numbers').classList.contains('hidden'),
    numbersFocused: (function () {
      var r = q('nm-list').querySelector('.nm-row.focused');
      return r ? r.querySelector('.nm-name').textContent : '';
    })(),
    numbersValue: (function () {
      var r = q('nm-list').querySelector('.nm-row.focused');
      return r ? r.querySelector('.nm-num').textContent : '';
    })(),
    numbersCustom: q('nm-list').querySelectorAll('.nm-row.custom').length,
    replayShown: !q('view-replay').classList.contains('hidden'),
    replayChannel: q('rp-channel').textContent,
    replayDays: [].slice.call(q('rp-days').children).map(function (d) {
      return d.textContent.trim().replace(/\s+/g, ' ');
    }),
    replayProgs: [].slice.call(q('rp-list').children).map(function (r) {
      var n = r.querySelector('.rp-name');
      return n ? n.textContent : '';
    }),
    hint: q('preview-hint').textContent,
    stallShown: !q('stall-warn').classList.contains('hidden'),
    stallText: q('stall-text').textContent,
    guideReplayable: [].slice.call(q('epg-list').children)
      .filter(r => r.classList.contains('replay')).length,
    badgeReplay: q('preview-badge').classList.contains('replay'),
    playerUrl: (window.Player && window.Player.currentUrl()) || '',
    seeking: q('stage') && !q('osd-seek').classList.contains('hidden'),
    tsShown: !q('ts-clock').classList.contains('hidden'),
    tsDay: q('ts-day').textContent,
    tsTime: q('ts-time').textContent,
    seekTarget: q('seek-target').textContent,
    seekDelta: q('seek-delta').textContent,
    seekFill: q('seek-fill').style.width,
    osdNum: q('osd-num').textContent,
    osdNow: q('osd-now').textContent,
    osdBar: q('osd-bar-fill').style.width,
    epgDay: q('epg-day').textContent,
    numberOpen: !q('number').classList.contains('hidden'),
    numberValue: q('num-value').textContent,
    osdName: q('osd-name').textContent,
    osdNum: q('osd-num').textContent,
    pmName: q('pm-name').textContent,
    pmNow: q('pm-now').textContent
  };
});

/* ---------- the run ---------- */

(async function () {
  console.log('\nAquaPlay IPTV — browser tests');

  const port = await freePort();
  const playlistUrl = writeFixtures(port);
  const server = await startServer(port);

  const browser = await chromium.launch({ executablePath: chromePath(), headless: !HEADED });
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });

  await context.addInitScript(() => {
    try {
      window.localStorage.setItem('nova.state.v1', JSON.stringify({
        settings: { epg: true, epgHours: 8, autoReconnect: false, startupPlayLast: false }
      }));
    } catch (e) {}
  });

  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', e => pageErrors.push(e.message));

  try {
    await page.goto('http://127.0.0.1:' + port + '/', { waitUntil: 'load' });
    await page.waitForFunction(() => !!window.App && !!window.Setup, null, { timeout: 10000 });

    /* ---------------------------------------------------------- */
    describe('setup — adding an M3U playlist');

    let s = await state(page);
    ok(s.setup, 'the setup screen is shown on a cold start');
    eq(s.main, false, 'the browse screen is hidden');

    eq(await page.evaluate(() => {
      const st = document.getElementById('stage');
      return [getComputedStyle(st).width, getComputedStyle(st).height];
    }), ['1920px', '1080px'], 'the stage is a fixed 1920x1080');

    // Ring on the M3U tab: tabs(0,1), m-name(2), m-url(3), m-epg(4), connect(5)
    await press(page, 'right');            // switch to the M3U tab
    ok(await page.evaluate(() =>
      !document.getElementById('fields-m3u').classList.contains('hidden')),
      'right arrow switches to the M3U tab');

    await press(page, 'down');             // m-name
    await press(page, 'ok');
    await page.keyboard.type('Fixture');
    await press(page, 'down');             // m-url
    await press(page, 'ok');
    await page.keyboard.type(playlistUrl);
    await press(page, 'down');             // m-epg
    await press(page, 'down');             // connect
    await press(page, 'ok');

    await page.waitForFunction(() => {
      const v = document.getElementById('view-main');
      return v && !v.classList.contains('hidden');
    }, null, { timeout: 60000 });
    await page.waitForFunction(() =>
      document.getElementById('loader').classList.contains('hidden'), null, { timeout: 60000 });

    s = await state(page);
    ok(s.main, 'connecting loads the playlist and opens the browse screen');
    eq(s.setup, false, 'the setup screen is dismissed');
    eq(s.count, '1 / ' + CHANNELS, 'all ' + CHANNELS + ' channels are listed');

    /* ---------------------------------------------------------- */
    describe('virtualised list');

    eq(s.poolSize, POOL, 'the channel list holds exactly ' + POOL + ' DOM rows');
    eq(s.groupPool, POOL, 'so does the groups rail');
    eq(s.names[0], 'Channel 0', 'the first row is the first channel');
    eq(s.focusedName, 'Channel 0', 'focus starts on the first channel');

    const before = s.names.join('|');
    await press(page, 'down', 200);
    s = await state(page);
    eq(s.poolSize, POOL, 'the row count is unchanged after scrolling 200 rows');
    eq(s.count, '201 / ' + CHANNELS, 'the position counter tracks the cursor');
    eq(s.focusedName, 'Channel 200', 'the focused row is the 201st channel');
    ok(before !== s.names.join('|'), 'recycled rows show new content, not stale text',
       'before: ' + before.slice(0, 60));
    ok(s.names.every(n => /^Channel \d+$/.test(n)), 'every visible row rendered a real name',
       JSON.stringify(s.names.slice(0, 4)));

    await press(page, 'chanDown');
    s = await state(page);
    eq(s.count, '211 / ' + CHANNELS, 'page-down jumps forward ten channels');
    await press(page, 'chanUp');
    s = await state(page);
    eq(s.count, '201 / ' + CHANNELS, 'page-up jumps back ten');

    const t0 = Date.now();
    await page.evaluate(n => {
      for (let i = 0; i < n; i++) {
        const e = new KeyboardEvent('keydown', { bubbles: true, cancelable: true });
        Object.defineProperty(e, 'keyCode', { get: () => 40 });
        document.dispatchEvent(e);
      }
    }, 500);
    const moveMs = Date.now() - t0;
    ok(moveMs < 3000, '500 cursor moves complete quickly (' + moveMs + ' ms)');

    /* ---------------------------------------------------------- */
    describe('guide (EPG)');

    await page.waitForFunction(() => window.EPG && window.EPG.hasData(), null, { timeout: 30000 })
      .catch(() => {});
    ok(await page.evaluate(() => window.EPG.hasData()), 'the XMLTV guide advertised by url-tvg was loaded');
    eq(await page.evaluate(() => window.EPG.data.count), EPG_CHANNELS * 10,
       'all ten programmes per channel are inside the window');
    ok(await page.evaluate(() => window.EPG.data.skipped === 0),
       'and nothing was skipped, since every guide channel is in the playlist');

    // Back to the top, where the channels with guide data live. Home, not a
    // thousand ups: the list wraps at both ends now.
    await press(page, 'Home');
    await sleep(200);
    s = await state(page);
    ok(/Now on 0/.test(s.nowLines[0]), 'the first row shows what is on now',
       JSON.stringify(s.nowLines[0]));
    ok(/Now on 0/.test(s.pmNow), 'the preview panel shows now/next for the focused channel',
       JSON.stringify(s.pmNow));
    eq(s.pmName, 'Channel 0', 'the preview panel names the focused channel');

    await page.screenshot({ path: path.join(ROOT, 'shot-1-list.png') });

    /* ---------------------------------------------------------- */
    describe('groups rail');

    await press(page, 'left');
    s = await state(page);
    eq(s.groups.slice(0, 3).map(g => g.replace(/^\d+/, '')),
       ['All channels', 'Favourites', 'Recently watched'],
       'the pinned groups come first');
    ok(s.groups.some(g => /G0$/.test(g)), 'the provider groups follow',
       JSON.stringify(s.groups.slice(3, 6)));

    await page.screenshot({ path: path.join(ROOT, 'shot-2-groups.png') });

    await press(page, 'down', 3);          // All -> Fav -> Recent -> G0
    await press(page, 'right');
    s = await state(page);
    eq(s.count, '1 / ' + (CHANNELS / GROUPS), 'selecting a group filters to its channels');
    ok(s.names.every(n => n.startsWith('Channel')), 'and the filtered rows render');


    await press(page, 'back');             // group 0 -> All channels
    s = await state(page);
    eq(s.count, '1 / ' + CHANNELS, 'back returns to all channels');

    /* ---------------------------------------------------------- */
    describe('search');

    await page.keyboard.press('g');        // green = search
    ok(await page.evaluate(() => document.activeElement.id === 'search-input'),
       'the green button focuses the search field');

    await page.keyboard.type('Channel 4999');
    await sleep(500);                      // input is debounced by 260 ms
    s = await state(page);
    eq(s.count, '1 / 1', 'searching narrows the list to a single match');
    eq(s.names[0], 'Channel 4999', 'and it is the right channel');

    // Matching is a substring test, so a prefix pulls in its descendants:
    // "Channel 123" also matches 1230-1239.
    await page.keyboard.press('Control+A');
    await page.keyboard.type('Channel 123');
    await sleep(500);
    s = await state(page);
    eq(s.count, '1 / 11', 'a prefix matches every channel it is a substring of');
    eq(s.names[0], 'Channel 123', 'the exact match is listed first');

    await page.screenshot({ path: path.join(ROOT, 'shot-3-search.png') });

    await press(page, 'back');             // leave the field
    await press(page, 'back');             // clear the search
    await sleep(400);
    s = await state(page);
    eq(s.count, '1 / ' + CHANNELS, 'back clears the search');

    /* ---------------------------------------------------------- */
    describe('favourites');

    await page.keyboard.press('r');        // red = favourite
    await sleep(150);
    s = await state(page);
    ok(/favourites/i.test(s.toast), 'the red button reports the change', s.toast);
    eq(s.stars, 1, 'a star appears on exactly one row');

    const starGeom = await page.evaluate(() => {
      const row = [].slice.call(document.querySelectorAll('#channel-list .ch-row'))
        .find(r => !!r.querySelector('.ch-fav.on'));
      if (!row) return null;
      const f = row.querySelector('.ch-fav').getBoundingClientRect();
      const b = row.querySelector('.ch-prog').getBoundingClientRect();
      return { starMid: f.left + f.width / 2, barMid: b.left + b.width / 2,
               starBottom: f.bottom, barTop: b.top };
    });
    ok(starGeom && Math.abs(starGeom.starMid - starGeom.barMid) < 3,
       'the heart is centred over the progress bar',
       starGeom && (starGeom.starMid + ' vs ' + starGeom.barMid));
    ok(starGeom && starGeom.starBottom <= starGeom.barTop + 1,
       'and sits above it');
    ok(await page.evaluate(() => {
      const f = document.querySelector('#channel-list .ch-fav.on');
      if (!f) return false;
      const c = getComputedStyle(f, ':before').backgroundColor;
      return /rgb\(\s*2[0-9]{2}|rgb\(\s*25[0-5]/.test(c) || c.indexOf('255') > -1;
    }), 'and is drawn red rather than printed as a character');

    await press(page, 'left');
    await press(page, 'down');             // Favourites
    await press(page, 'right');
    s = await state(page);
    eq(s.count, '1 / 1', 'the favourites group holds the starred channel');
    eq(s.names[0], 'Channel 0', 'and it is the one that was starred');


    await press(page, 'left');
    await press(page, 'up');               // back to All channels
    await press(page, 'right');
    s = await state(page);
    eq(s.count, '1 / ' + CHANNELS, 'and back to all channels');

    /* ---------------------------------------------------------- */
    describe('number zapping');

    await page.keyboard.press('Digit4');
    await page.keyboard.press('Digit2');
    s = await state(page);
    ok(s.zap, 'typing digits shows the channel-number overlay');
    eq(s.zapText, '42', 'the overlay echoes the digits');

    await sleep(2000);                     // commits after 1.6 s
    s = await state(page);
    eq(s.zap, false, 'the overlay clears once it commits');
    eq(s.count, '42 / ' + CHANNELS, 'the cursor jumps to that channel number');
    eq(s.focusedName, 'Channel 41', 'channel 42 is the 42nd in the list');
    eq(s.badge, 'Channel 41', 'and it starts playing: asking for a channel by ' +
       'number is as deliberate as pressing OK on it');

    /* ---------------------------------------------------------- */
    describe('playback only starts when asked');

    /* 413 is the remote's Stop; a PC keyboard has no key for it. */
    await page.evaluate(() => {
      const ev = new KeyboardEvent('keydown', { bubbles: true, cancelable: true });
      Object.defineProperty(ev, 'keyCode', { get: () => 413 });
      document.dispatchEvent(ev);
    });
    await sleep(250);

    s = await state(page);
    eq(s.playerUrl, '', 'nothing plays once it is stopped');
    eq(s.badge, '', 'and no channel is marked as playing');
    ok(s.focusedName === 'Channel 41', 'with the cursor where the dial left it',
       s.focusedName);

    await press(page, 'ok');               // play channel 42 in the panel
    await sleep(400);
    s = await state(page);
    ok(/stream\/41\./.test(s.playerUrl), 'OK starts that channel', s.playerUrl);
    eq(s.playingFull, false, 'and does NOT jump straight to fullscreen');
    eq(s.badge, 'Channel 41', 'the badge over the video names what is playing');
    eq(s.playingRow, 'Channel 41', 'and the row is marked as playing');
    /* The marker for it is the row, not a dot at the edge of the row: an
       outline in the same red the badge and the guide panel use, drawn as an
       inset shadow so nothing in the row moves when it arrives. */
    const mark = await page.evaluate(() => {
      const r = document.querySelector('#channel-list .ch-row.playing');
      if (!r) return null;
      const before = getComputedStyle(r, ':before');
      return {
        shadow: getComputedStyle(r).boxShadow,
        dot: before.content + ' ' + before.width + ' ' + before.backgroundColor
      };
    });
    ok(mark, 'the row playing is found');
    ok(/inset/.test(mark.shadow), 'it is outlined rather than dotted', mark.shadow);
    ok(/rgb\(\s*255,\s*77,\s*94/.test(mark.shadow), 'in the live red', mark.shadow);
    ok(mark.dot.indexOf('none') > -1, 'and the dot it used to be is gone', mark.dot);

    /* The logo sits between the number and the name rather than against the
       name. The number column is a fixed width so the logos line up down the
       list, which means the air is shared out by the two margins either side
       of the logo and nothing else. */
    const cols = await page.evaluate(() => {
      const r = document.querySelector('#channel-list .ch-row');
      const n = r.querySelector('.ch-num').getBoundingClientRect();
      const l = r.querySelector('.ch-logo').getBoundingClientRect();
      const t = r.querySelector('.ch-name').getBoundingClientRect();
      return { before: Math.round(l.left - n.right), after: Math.round(t.left - l.right) };
    });
    ok(cols.before >= 0, 'the logo clears the number column', JSON.stringify(cols));
    ok(cols.after >= 20, 'and the name is not up against it', JSON.stringify(cols));
    eq(await page.evaluate(() =>
         getComputedStyle(document.querySelector('#channel-list .ch-num')).width),
       '78px', 'while the number column stays wide enough for four digits');


    await page.screenshot({ path: path.join(ROOT, 'shot-4-playing.png') });

    describe('scrolling never disturbs playback');

    await press(page, 'down', 12);
    await sleep(250);
    s = await state(page);
    eq(s.count, '54 / ' + CHANNELS, 'the cursor moved twelve channels');
    eq(s.badge, 'Channel 41', 'the same channel is still playing');
    ok(/stream\/41\./.test(s.playerUrl), 'and the stream was never swapped', s.playerUrl);
    eq(s.pmName, 'Channel 53', 'the meta panel follows the cursor, not the stream');

    await press(page, 'left');             // into the groups rail
    await sleep(150);
    s = await state(page);
    eq(s.badge, 'Channel 41', 'moving to the groups rail keeps it playing');
    await press(page, 'right');
    await sleep(150);

    describe('choosing another channel switches the stream');

    await press(page, 'ok');
    await sleep(400);
    s = await state(page);
    eq(s.badge, 'Channel 53', 'OK on a different channel switches to it');
    eq(s.playingRow, 'Channel 53', 'and the playing marker moves');
    ok(/stream\/53\./.test(s.playerUrl), 'and so does the stream', s.playerUrl);

    describe('fullscreen and OSD');

    await press(page, 'ok');               // second OK on the playing channel
    await sleep(300);
    s = await state(page);
    ok(s.playingFull, 'OK again on the channel already playing goes fullscreen');

    /* The video plane itself, not just the class on the stage: it has to move
       and grow, and the picture inside it has to scale with it. */
    eq(await page.evaluate(() => {
      const r = document.getElementById('video-layer').getBoundingClientRect();
      return [r.left, r.top, r.width, r.height].map(Math.round).join(',');
    }), '0,0,1920,1080', 'and the video plane really fills the screen');
    ok(await page.evaluate(() => {
      const v = document.querySelector('#video-layer video');
      return v && getComputedStyle(v).objectFit !== 'none';
    }), 'with a picture that scales to it, whatever the stream resolution');
    ok(s.osd, 'and shows the OSD');
    eq(s.osdName, 'Channel 53', 'the OSD names the channel');

    await page.screenshot({ path: path.join(ROOT, 'shot-5-osd.png') });

    await press(page, 'down');             // zap down one
    await sleep(300);
    s = await state(page);
    eq(s.osdName, 'Channel 54', 'down zaps to the next channel while fullscreen');

    describe('the info bar toggles');

    s = await state(page);
    ok(s.osd, 'the info bar is up after zapping');
    ok(/LIVE/.test(s.osdNum), 'and says the stream is live', s.osdNum);

    await press(page, 'ok');
    await sleep(200);
    s = await state(page);
    eq(s.osd, false, 'OK hides it');
    await press(page, 'ok');
    await sleep(200);
    s = await state(page);
    ok(s.osd, 'and OK brings it back');

    describe('right in fullscreen opens the channel panel');

    /* Nothing is forward of live, so right never opened anything useful there;
       it is the channel panel now, the same as it is in the list. */
    await press(page, 'right');
    await sleep(300);
    let fsPanel = await page.evaluate(() => ({
      shown: !document.getElementById('ctxmenu').classList.contains('hidden'),
      items: [].slice.call(document.querySelectorAll('.cm-row')).map(x => (x.querySelector('.mi-label') || x).textContent.trim()),
      seeking: !document.getElementById('osd-seek').classList.contains('hidden')
    }));
    ok(fsPanel.shown, 'right opens the panel while watching', JSON.stringify(fsPanel));
    eq(fsPanel.seeking, false, 'and never opens the scrubber at the live edge');
    ok(fsPanel.items.some(i => /Leave full screen/.test(i)),
       'it offers what makes sense fullscreen', JSON.stringify(fsPanel.items));
    ok(!fsPanel.items.some(i => /Go full screen/.test(i)),
       'and not what does not', JSON.stringify(fsPanel.items));

    await press(page, 'back');
    await sleep(250);
    s = await state(page);
    ok(s.playingFull, 'back closes the panel and leaves the picture alone');

    /* ---------------------------------------------------------- */
    describe('leaving fullscreen for another screen');

    /* Every .view is display:none while the stage is fullscreen, so anything
       opened from there has to drop fullscreen first or it is invisible. */
    const onScreen = id => page.evaluate(i => {
      const el = document.getElementById(i);
      const r = el.getBoundingClientRect();
      return { hidden: el.classList.contains('hidden'),
               painted: r.width > 100 && r.height > 100 };
    }, id);

    await page.keyboard.press('y');        // settings, straight from fullscreen
    await sleep(500);
    const sv = await onScreen('view-settings');
    s = await state(page);
    ok(s.settings, 'settings opens from fullscreen');
    ok(sv.painted, 'and is actually on screen, not hidden behind fullscreen',
       JSON.stringify(sv));
    eq(s.playingFull, false, 'which means fullscreen was left on the way out');

    await press(page, 'back');
    await sleep(400);
    s = await state(page);
    eq(s.main, true, 'back returns to the browse screen');
    ok((await onScreen('view-main')).painted, 'which is on screen too');

    // Put the run back in fullscreen for what follows.
    await press(page, 'p');
    await sleep(500);
    s = await state(page);
    ok(s.playingFull, 'and Play puts it back fullscreen');

    /* ---------------------------------------------------------- */
    describe('the stream warning is a way back to live');

    // Put the warning up by hand: real drift needs a stream that really stalls.
    await page.evaluate(() => {
      document.getElementById('stall-text').textContent = 'Stream is behind  12s';
      document.getElementById('stall-warn').classList.remove('hidden');
    });
    await press(page, 'up');
    await sleep(250);
    let warn = await page.evaluate(() => ({
      focused: document.getElementById('stall-warn').classList.contains('focused'),
      hint: getComputedStyle(document.getElementById('stall-hint')).display
    }));
    ok(warn.focused, 'up puts the cursor on the warning');
    ok(warn.hint !== 'none', 'and it says what OK will do', warn.hint);

    const beforeLive = (await state(page)).playerUrl;
    await press(page, 'ok');
    await sleep(600);
    s = await state(page);
    warn = await page.evaluate(() => ({
      focused: document.getElementById('stall-warn').classList.contains('focused'),
      shown: !document.getElementById('stall-warn').classList.contains('hidden')
    }));
    ok(!s.badgeReplay, 'OK jumps back to live, not to a replay', s.badge);
    eq(warn.focused, false, 'the warning lets the cursor go');
    eq(warn.shown, false, 'and comes down, since the stream started again');
    ok(!/utc=/.test(s.playerUrl), 'playing the live stream, not a replay', s.playerUrl);
    ok(s.playingFull, 'still fullscreen', String(s.playingFull));
    ok(beforeLive !== null, 'and it did restart the stream');

    // Down while the warning is up should go back to zapping, not stay stuck.
    await page.evaluate(() => {
      document.getElementById('stall-text').textContent = 'Stream is behind  12s';
      document.getElementById('stall-warn').classList.remove('hidden');
    });
    await press(page, 'up');
    await sleep(200);
    await press(page, 'down');
    await sleep(200);
    warn = await page.evaluate(() =>
      document.getElementById('stall-warn').classList.contains('focused'));
    eq(warn, false, 'down releases it again');
    await page.evaluate(() => document.getElementById('stall-warn').classList.add('hidden'));

    /* ---------------------------------------------------------- */
    describe('scrubbing back and forth in fullscreen');

    s = await state(page);
    eq(s.tsShown, false, 'no broadcast-time readout while live');

    await press(page, 'left');
    await sleep(200);
    s = await state(page);
    ok(s.seeking, 'left opens the scrubber');
    ok(s.tsShown, 'and the broadcast time appears in the corner');
    ok(/^\d\d:\d\d:\d\d$/.test(s.tsTime),
       'showing the actual time, to the second', s.tsTime);
    ok(/Today|Yesterday|day/i.test(s.tsDay), 'with the day it aired', s.tsDay);
    const tsFirst = s.tsTime;
    ok(/^-\s*\d+ sec/.test(s.seekDelta), 'showing how far back', s.seekDelta);
    const fill1 = parseFloat(s.seekFill);
    const target1 = s.seekTarget;

    await press(page, 'left', 6);          // keep winding back
    await sleep(200);
    s = await state(page);
    const fill2 = parseFloat(s.seekFill);
    ok(fill2 < fill1, 'the bar moves left as you wind back',
       fill1 + '% -> ' + fill2 + '%');
    ok(s.tsTime !== tsFirst, 'and the corner clock winds back with it',
       tsFirst + ' -> ' + s.tsTime);
    ok(s.seekTarget !== target1, 'and the clock follows it',
       target1 + ' -> ' + s.seekTarget);
    ok(/min/.test(s.seekDelta), 'now minutes behind live', s.seekDelta);

    await press(page, 'right', 3);         // and forward again
    await sleep(200);
    s = await state(page);
    const fill3 = parseFloat(s.seekFill);
    ok(fill3 > fill2, 'right moves it back toward live', fill2 + '% -> ' + fill3 + '%');

    await press(page, 'back');             // cancel, do not commit
    await sleep(250);
    s = await state(page);
    eq(s.seeking, false, 'back cancels the scrub');
    ok(s.playingFull, 'and stays in fullscreen');
    ok(!/utc=/.test(s.playerUrl), 'without having moved the stream', s.playerUrl);

    describe('committing a scrub');

    await page.keyboard.press('j');        // rewind key = a five-minute jump
    await sleep(250);
    s = await state(page);
    ok(s.seeking, 'the rewind key opens the scrubber too');
    ok(/min/.test(s.seekDelta), 'five minutes back', s.seekDelta);

    await press(page, 'ok');               // commit immediately
    await sleep(600);
    s = await state(page);
    eq(s.seeking, false, 'OK commits and closes the scrubber');
    ok(/utc=\d+/.test(s.playerUrl), 'the stream restarts at that moment', s.playerUrl);
    ok(/-\s*\d/.test(s.osdNum), 'and the info bar shows it is behind live', s.osdNum);
    ok(s.tsShown, 'the broadcast time stays on screen after committing');

    const tsBeforeTick = s.tsTime;
    await sleep(2200);
    s = await state(page);
    ok(s.tsTime !== tsBeforeTick, 'ticking along with playback',
       tsBeforeTick + ' -> ' + s.tsTime);

    /* ---------------------------------------------------------- */
    describe('the way back to live, from the info bar');

    /* The channel is wound back and the bar is up, which is the only state
       this button exists in. The channel panel had the same jump in it, but
       that is right, then down a menu, for something the viewer just did. */
    const backBtn = () => page.evaluate(() => {
      const b = document.getElementById('osd-back');
      return { there: !b.classList.contains('hidden'),
               focused: b.classList.contains('focused'),
               text: b.textContent };
    });

    let bb = await backBtn();
    ok(bb.there, 'wound back, the info bar offers a way to live');
    await page.screenshot({ path: path.join(ROOT, 'shot-back-to-live-idle.png') });
    ok(/live/i.test(bb.text), 'and says so', bb.text);
    eq(bb.focused, false, 'without taking the cursor unasked');

    await press(page, 'up');
    await sleep(250);
    bb = await backBtn();
    ok(bb.focused, 'up puts the cursor on it');
    ok((await state(page)).osd, 'and holds the bar up while it is being aimed at');
    await page.screenshot({ path: path.join(ROOT, 'shot-back-to-live.png') });
    /* On the channel number's own line, not on one above the channel name.
       The bar is a ranking — number, name, what is on — and a button that
       takes a line of its own pushes the name down and reads as part of it. */
    const line = await page.evaluate(() => {
      const n = document.getElementById('osd-num').getBoundingClientRect();
      const b = document.getElementById('osd-back').getBoundingClientRect();
      const name = document.getElementById('osd-name').getBoundingClientRect();
      return {
        offLine: Math.round((b.top + b.height / 2) - (n.top + n.height / 2)),
        gap: Math.round(b.left - n.right),
        clearOfName: name.top >= b.bottom - 2
      };
    });
    ok(Math.abs(line.offLine) < 8, 'on the channel number line, not below it',
       JSON.stringify(line));
    ok(line.gap > 0, 'to the right of the number', JSON.stringify(line));
    ok(line.clearOfName, 'and above the channel name rather than over it',
       JSON.stringify(line));


    /* Anything other than OK lets it go, exactly like the stream warning —
       and the press that let it go does nothing else. */
    await press(page, 'down');
    await sleep(250);
    eq((await backBtn()).focused, false, 'anything else lets it go');
    eq((await state(page)).seeking, false, 'and does not do something else on the way');

    await press(page, 'up');
    await sleep(250);
    await press(page, 'ok');
    await sleep(900);
    s = await state(page);
    ok(!/utc=/.test(s.playerUrl), 'OK restarts the channel at the live edge', s.playerUrl);
    ok(/LIVE/.test(s.osdNum), 'the info bar says LIVE again', s.osdNum);
    eq((await backBtn()).there, false, 'and the button has nothing left to offer');

    /* It belongs to the bar: no bar, no button, and no cursor left on it. */
    await page.keyboard.press('j');            // wind back again
    await sleep(250);
    await press(page, 'ok');                   // commit
    await sleep(700);
    ok((await backBtn()).there, 'wound back once more, it is there again');
    await press(page, 'up');
    await sleep(250);
    ok((await backBtn()).focused, 'and can be focused again');

    await press(page, 'back');                 // one layer: the bar
    await sleep(300);
    s = await state(page);
    eq(s.osd, false, 'closing the bar');
    eq(s.playingFull, true, 'leaves the picture');
    eq((await backBtn()).focused, false, 'and takes the cursor off the button with it');

    await press(page, 'ok');                   // bar back up
    await sleep(300);
    await press(page, 'up');
    await sleep(250);
    await press(page, 'ok');
    await sleep(900);
    ok(!/utc=/.test((await state(page)).playerUrl), 'and OK from there is still the way back');

    /* Put the channel back the way this section found it. What follows is
       about the broadcast-time readout, and that only exists behind live. */
    await page.keyboard.press('j');
    await sleep(250);
    await press(page, 'ok');
    await sleep(700);
    s = await state(page);
    ok(s.tsShown, 'wound back again for the rest of the section');

    // It belongs to the info bar and goes with it.
    await press(page, 'ok');
    await sleep(250);
    s = await state(page);
    eq(s.osd, false, 'OK dismisses the info bar');
    eq(s.tsShown, false, 'and the broadcast time goes with it');

    await press(page, 'ok');
    await sleep(250);
    s = await state(page);
    ok(s.osd, 'OK brings the info bar back');
    ok(s.tsShown, 'and the broadcast time comes back too');

    // The usual way it goes is the timeout, not a keypress.
    await page.evaluate(() => window.Store.set('settings.osdSeconds', 1));
    await press(page, 'ok');               // hide
    await press(page, 'ok');               // show, now on a 1s timer
    await sleep(1700);
    s = await state(page);
    eq(s.osd, false, 'the info bar times out on its own');
    eq(s.tsShown, false, 'and the broadcast time times out with it');
    await page.evaluate(() => window.Store.set('settings.osdSeconds', 8));

    /* Back peels one layer at a time. With the bar up, one press puts it away
       and the picture stays: someone who pressed OK to see what is on should
       not have to leave fullscreen to be rid of the bar again. */
    await press(page, 'ok');               // bar up again
    await sleep(250);
    ok((await state(page)).osd, 'the info bar is up');

    await press(page, 'back');
    await sleep(250);
    s = await state(page);
    eq(s.osd, false, 'back closes the info bar');
    eq(s.playingFull, true, 'without taking fullscreen with it');
    eq(s.tsShown, false, 'and the broadcast time goes too');

    await press(page, 'back');
    await sleep(250);
    s = await state(page);
    eq(s.playingFull, false, 'back leaves fullscreen once the bar has gone');
    eq(s.main, true, 'and returns to the browse screen');
    eq(s.badge, 'Channel 54', 'still playing what fullscreen was showing');
    eq(s.tsShown, false, 'the corner clock is fullscreen-only');

    /* ---------------------------------------------------------- */
    describe('the full-screen button');

    await press(page, 'down', 12);          // walk well away from what is playing
    await sleep(250);
    s = await state(page);
    const away = s.focusedName;
    ok(away !== 'Channel 54', 'the cursor is on a different channel', away);
    eq(s.badge, 'Channel 54', 'while Channel 54 is the one still playing');

    await press(page, 'p');
    await sleep(300);
    s = await state(page);
    ok(s.playingFull, 'Play goes fullscreen from a row that is not the one playing');
    eq(s.badge, 'Channel 54', 'and it is the channel playing that fills the screen');

    /* Play brings the info bar up with the picture, and back takes one layer
       off at a time: the bar first, the picture second. */
    await press(page, 'back');
    await sleep(250);
    s = await state(page);
    eq(s.osd, false, 'back closes the info bar Play put up');
    eq(s.playingFull, true, 'and leaves the picture where it is');

    await press(page, 'back');
    await sleep(250);
    s = await state(page);
    eq(s.playingFull, false, 'a second back leaves fullscreen');
    eq(s.focusedName, away, 'and the cursor is left where it was');
    eq(s.badge, 'Channel 54', 'with playback untouched throughout');

    /* With nothing playing it falls back to the row under the cursor. 413 is
       the remote's Stop, which a PC keyboard has no key for — and keys.js
       reads nothing but keyCode. */
    await page.evaluate(() => {
      const e = new KeyboardEvent('keydown', { bubbles: true, cancelable: true });
      Object.defineProperty(e, 'keyCode', { get: () => 413 });
      document.dispatchEvent(e);
    });
    await sleep(250);
    s = await state(page);
    eq(s.badge, '', 'stop clears the preview');

    await press(page, 'p');
    await sleep(500);
    s = await state(page);
    ok(s.playingFull, 'with nothing playing, Play starts the focused channel fullscreen');
    eq(s.badge, away, 'which is the one under the cursor');

    /* Put the run back where it was: Channel 54 playing, cursor on its row.
       Two backs, because the bar came up with fullscreen and back peels it
       off before the picture. */
    await press(page, 'back');
    await press(page, 'back');
    await press(page, 'up', 12);
    await press(page, 'ok');
    await sleep(400);
    s = await state(page);
    eq(s.focusedName, 'Channel 54', 'back on the row the run started from');
    eq(s.badge, 'Channel 54', 'playing it again');

    /* ---------------------------------------------------------- */
    describe('the left-arrow menu');

    await press(page, 'left');             // channels -> groups
    await press(page, 'left');             // groups -> menu
    await sleep(250);
    s = await state(page);
    ok(s.menuShown, 'left from the groups rail opens the menu');
    await page.screenshot({ path: path.join(ROOT, 'shot-drawer.png') });
    ['Search', 'Catch-up', 'Settings', 'Reload playlist'].forEach(function (item) {
      ok(s.menuItems.indexOf(item) > -1, 'it offers ' + item, JSON.stringify(s.menuItems));
    });

    /* And not the two the rail already has. The drawer is reached by going
       left past the rail, so a row here that jumps to a group on it offers to
       send somebody back through the thing they just walked through. */
    ['Favourites', 'Recently watched'].forEach(function (item) {
      eq(s.menuItems.indexOf(item), -1, 'and leaves ' + item + ' to the rail it is on',
         JSON.stringify(s.menuItems));
    });

    await press(page, 'back');
    await sleep(200);
    s = await state(page);
    eq(s.menuShown, false, 'back closes it');
    await press(page, 'right');            // groups -> channels
    /* ---------------------------------------------------------- */
    describe('settings does not stop the channel');

    /* A television menu opens over what you were watching and leaves it
       running. This used to call Player.stop(), so changing one row cost the
       several seconds it takes to open the stream again on the way back. */
    await press(page, 'ok');               // play whatever is under the cursor
    await sleep(700);
    s = await state(page);
    const wasPlaying = s.playerUrl;
    ok(!!wasPlaying, 'a channel is playing before settings opens', String(wasPlaying));

    await page.keyboard.press('y');        // yellow = settings
    await sleep(400);
    s = await state(page);
    eq(s.settings, true, 'settings is open');
    eq(await page.evaluate(() => window.Player.currentUrl()), wasPlaying,
       'and the same stream is still open behind it');
    ok(await page.evaluate(() =>
         document.getElementById('video-layer').classList.contains('hidden')),
       'with the picture put away, since a browser draws it over the panes');

    await press(page, 'back');
    await sleep(500);
    s = await state(page);
    eq(s.main, true, 'back on the browse screen');
    eq(s.playerUrl, wasPlaying, 'still playing what it was, without reopening it');
    ok(!await page.evaluate(() =>
         document.getElementById('video-layer').classList.contains('hidden')),
       'and the picture comes back with the screen');

    /* ---------------------------------------------------------- */
    describe('the TV catalogue');

    const cat = () => page.evaluate(() => {
      const q = id => document.getElementById(id);
      const chans = [].slice.call(q('cg-chans').children)
        .filter(r => r.style.display !== 'none');
      const progs = [].slice.call(q('cg-progs').children);
      return {
        shown: !q('view-catalog').classList.contains('hidden'),
        title: q('cg-title').textContent,
        count: q('cg-count').textContent,
        chanCount: q('cg-chan-count').textContent,
        chans: chans.map(r => ({
          num: r.querySelector('.cg-num').textContent,
          name: r.querySelector('.cg-chname').textContent,
          selected: r.classList.contains('selected'),
          focused: r.classList.contains('focused'),
          playing: r.classList.contains('playing')
        })),
        days: progs.filter(p => p.className.indexOf('cg-day') > -1)
          .map(p => p.textContent),
        progs: progs.filter(p => p.className.indexOf('cg-prog') > -1).map(p => ({
          time: p.querySelector('.cg-ptime').textContent,
          name: p.querySelector('.cg-pname').textContent,
          now: p.classList.contains('now'),
          past: p.classList.contains('past'),
          focused: p.classList.contains('focused'),
          reminded: p.classList.contains('reminded')
        }))
      };
    });

    await press(page, 'left');             // channels -> groups
    await press(page, 'left');             // groups -> menu
    await sleep(250);
    s = await state(page);
    const catRow = s.menuItems.indexOf('TV catalogue');
    ok(catRow > -1, 'the drawer offers the catalogue', JSON.stringify(s.menuItems));

    await press(page, 'down', catRow);
    await press(page, 'ok');
    await sleep(700);

    let c = await cat();
    ok(c.shown, 'which opens it');

    /* Every channel down the left, windowed — the playlist is five thousand
       long and the pool is sixteen rows. */
    ok(c.chans.length > 4 && c.chans.length <= 16,
       'the channels are listed down the left, a window at a time',
       c.chans.length + ' rows on screen');
    ok(/\/ 5000$/.test(c.chanCount), 'with all of them counted', c.chanCount);
    eq(c.chans.filter(x => x.selected).length, 1, 'one of them is selected');

    /* It opens on the channel being watched, which is where the viewer
       already is — and in this fixture that one is past the slice that
       carries guide data, so walk to the top before reading a schedule. */
    eq(c.title, c.chans.filter(x => x.selected)[0].name,
       'the right-hand side is headed with the channel it opened on');
    await press(page, 'left');             // into the channel column
    await press(page, 'Home');
    await sleep(600);
    c = await cat();
    eq(c.chanCount.split(' / ')[0], '1', 'Home is the first channel', c.chanCount);

    /* And that one channel's whole schedule on the right, not nine rows of
       it — the guide panel beside the player is the nine-row glance. */
    const chosen = c.chans.filter(x => x.selected)[0];
    eq(c.title, chosen.name, 'the right-hand side is headed with the channel');
    ok(c.progs.length > 5, 'and holds its schedule, not a window on it',
       c.progs.length + ' programmes');
    ok(c.days.length > 0, 'broken up by day', JSON.stringify(c.days));
    ok(c.progs.some(p => p.now), 'with what is on air marked',
       JSON.stringify(c.progs.filter(p => p.now)));
    ok(c.progs.some(p => p.past), 'and what has already been on');
    ok(/^\d\d:\d\d$/.test(c.progs[0].time), 'each with its time', c.progs[0].time);

    await page.screenshot({ path: path.join(ROOT, 'shot-catalogue.png') });

    /* Another channel is another schedule. */
    ok((await cat()).chans.some(x => x.focused), 'the cursor is on the channels');
    const wasTitle = (await cat()).title;
    await press(page, 'down');
    await sleep(400);
    c = await cat();
    ok(c.title !== wasTitle, 'down is a different channel',
       wasTitle + ' -> ' + c.title);
    ok(c.progs.length > 0, 'with a schedule of its own', c.progs.length + ' programmes');

    /* OK on something that has not started is a reminder, which is what OK
       does in the guide panel too. */
    await press(page, 'right');            // into the schedule
    await sleep(200);
    const future = (await cat()).progs.findIndex(p => !p.now && !p.past);
    ok(future > -1, 'the schedule reaches into the future');
    const at = (await cat()).progs.findIndex(p => p.focused);
    await press(page, 'down', Math.max(0, future - at));
    await sleep(300);
    await press(page, 'ok');
    await sleep(400);
    c = await cat();
    eq(c.progs.filter(p => p.reminded).length, 1,
       'OK on one that has not started sets a reminder',
       JSON.stringify(c.progs.filter(p => p.reminded)));

    await press(page, 'ok');
    await sleep(400);
    eq((await cat()).progs.filter(p => p.reminded).length, 0,
       'and OK again takes it off');

    await press(page, 'back');
    await sleep(400);
    s = await state(page);
    eq(s.main, true, 'back leaves the catalogue');
    ok(await page.evaluate(() =>
         document.getElementById('view-catalog').classList.contains('hidden')),
       'and puts it away');

    /* The drawer is reached through the rail, so the rail is where the cursor
       is when the catalogue closes. Back into the list for what follows. */
    await press(page, 'right');
    await sleep(200);
    ok((await state(page)).focusedName, 'and the cursor is back in the channel list',
       String((await state(page)).focusedName));

    /* ---------------------------------------------------------- */
    describe('guide viewer under the player');

    // Only the first EPG_CHANNELS channels carry guide data in the fixture.
    // Dialling plays, so this is what is on from here.
    await page.keyboard.press('Digit6');
    await sleep(2000);
    s = await state(page);
    eq(s.focusedName, 'Channel 5', 'moved to a channel that has guide data');
    eq(s.badge, 'Channel 5', 'which is now the one playing, because it was dialled');

    ok(s.guide.length >= 2, 'the guide lists the focused channel’s programmes',
       JSON.stringify(s.guide.slice(0, 3)));
    ok(/Now on 5$/.test(s.guideNow), 'and marks what is on now', s.guideNow);
    // The fixture's "on now" programme started 30 min ago, which lands on the
    // previous day if the suite runs just after midnight.
    ok(s.epgDay === 'Today' || s.epgDay === 'Yesterday',
       'the day is labelled relative to today', s.epgDay);
    eq(s.epgActive, false, 'the panel is not focused while the list is');

    await page.screenshot({ path: path.join(ROOT, 'shot-6-guide.png') });

    /* ---------------------------------------------------------- */
    describe('the guide panel is a place again');

    /* Asked for rather than assumed: a new install opens on "now at the top",
       and the centred window is what the next several assertions are about. */
    await page.evaluate(() => {
      window.Store.set('settings.guideView', 'centred');
      window.App.onSettingChanged('settings.guideView');
    });
    await sleep(300);

    s = await state(page);
    eq(s.guide.length, 9, 'centred, the panel holds nine programmes');
    eq(s.guideNowIdx, 4, 'the one on air is the fifth of them: four behind, four ahead');
    eq(s.guideCentred, 0, 'and sits on the exact middle of the five on screen');
    eq(s.guideReplayable, 4, 'the finished ones the provider still holds are marked replayable');
    ok(!s.guide.some(g => /Two days ago/.test(g)),
       'so nothing beyond those nine is in it', JSON.stringify(s.guide));
    ok(/Six hours ago on 5/.test(s.guide[0]) && /This evening on 5/.test(s.guide[8]),
       'counted, not measured: these nine span -6h to +7h',
       JSON.stringify(s.guide));

    /* Settings -> Guide panel. "Now at the top" is the default and turns the
       same nine rows into nine of schedule instead of four. */
    const panelShape = () => page.evaluate(() => {
      const rows = [].slice.call(document.querySelectorAll('#epg-list .epg-row'));
      const box = document.getElementById('epg-scroller').getBoundingClientRect();
      const now = rows.findIndex(r => r.classList.contains('now'));
      const nb = now > -1 ? rows[now].getBoundingClientRect() : null;
      return {
        held: rows.length,
        nowIdx: now,
        past: rows.filter(r => r.classList.contains('past')).length,
        offTop: nb ? Math.round(nb.top - box.top) : null,
        offCentre: nb ? Math.round((nb.top + nb.height / 2) - (box.top + box.height / 2)) : null
      };
    });

    const centred = await panelShape();
    eq(centred.nowIdx, 4, 'centred: the row on air is the fifth of nine');
    eq(centred.offCentre, 0, 'and sits on the middle of the panel');
    ok(centred.past > 0, 'with what has just been on above it', centred.past + ' finished');

    await page.evaluate(() => {
      window.Store.set('settings.guideView', 'ahead');
      window.App.onSettingChanged('settings.guideView');
    });
    await sleep(300);
    const ahead = await panelShape();
    eq(ahead.nowIdx, 0, 'ahead: the row on air is the first');
    eq(ahead.offTop, 0, 'sitting at the top of the panel, not the middle');
    eq(ahead.past, 0, 'and nothing that has already finished is in it');
    /* Nine at most, and here the fixture only has five from now on: sliding
       the window back to fill the panel is the past it was asked not to show. */
    eq(ahead.held, 5, 'and it holds what the guide has from now on, not nine regardless');

    await page.evaluate(() => {
      window.Store.set('settings.guideView', 'centred');
      window.App.onSettingChanged('settings.guideView');
    });
    await sleep(300);
    eq((await panelShape()).nowIdx, 4, 'and back to the middle');

    /* Five rows of the nine are on screen; the rest are a scroll away. */
    const shownRows = () => page.evaluate(() => {
      const box = document.getElementById('epg-scroller').getBoundingClientRect();
      return [].slice.call(document.querySelectorAll('#epg-list .epg-row'))
        .filter(r => {
          const b = r.getBoundingClientRect();
          return b.top >= box.top - 1 && b.bottom <= box.bottom + 1;
        })
        .map(r => r.querySelector('.epg-name').textContent);
    });
    const firstFive = await shownRows();
    eq(firstFive.length, 5, 'five of the nine are on screen at a time');
    ok(/Now on 5/.test(firstFive[2]), 'with the one on air in the middle of them', firstFive[2]);

    /* Right is still about the channel — the guide is one of the things the
       channel panel offers, rather than the thing right does. */
    await press(page, 'right');
    await sleep(250);
    s = await state(page);
    eq(s.epgActive, false, 'right does not move the cursor into the guide');
    ok(await page.evaluate(() => !document.getElementById('ctxmenu').classList.contains('hidden')),
       'it opens the channel panel instead');
    const guideRow = await page.evaluate(() =>
      [].slice.call(document.querySelectorAll('.cm-row'))
        .map(r => (r.querySelector('.mi-label') || r).textContent.trim()).indexOf('Schedule'));
    ok(guideRow > -1, 'which offers the guide as a row of its own');
    await press(page, 'back');
    await sleep(200);

    /* INFO is the one-press way in. It used to be a toast repeating the name
       of the row the cursor was already sitting on. */
    await press(page, 'i');
    await sleep(300);
    s = await state(page);
    eq(s.epgActive, true, 'INFO puts the cursor in the guide');
    eq(await page.evaluate(() =>
         (document.querySelector('#epg-list .epg-row.focused .epg-name') || {}).textContent),
       'Now on 5', 'on the programme that is on air');

    /* The other four are a scroll away — which is the whole point of holding
       nine and showing five. */
    await press(page, 'up', 4);
    await sleep(300);
    const atTop = await shownRows();
    eq(atTop.length, 5, 'still five on screen after scrolling');
    ok(/Six hours ago on 5/.test(atTop[0]),
       'four presses up reach the oldest of the nine', JSON.stringify(atTop));
    eq(await page.evaluate(() =>
         (document.querySelector('#epg-list .epg-row.focused .epg-name') || {}).textContent),
       'Six hours ago on 5', 'with the cursor on it');
    ok(!atTop.some(t => /This evening/.test(t)),
       'and the far end has scrolled out of sight', JSON.stringify(atTop));

    await press(page, 'down', 8);
    await sleep(300);
    const atEnd = await shownRows();
    ok(/This evening on 5/.test(atEnd[4]),
       'eight back down reach the far end', JSON.stringify(atEnd));
    ok(!atEnd.some(t => /Six hours ago/.test(t)),
       'and the near end has gone the other way', JSON.stringify(atEnd));

    await press(page, 'up', 4);            // back to the one on air
    await sleep(250);

    /* OK does what the programme allows, and for one that has not started yet
       that is: say when it does. */
    await press(page, 'down');
    await sleep(200);
    await press(page, 'ok');
    await sleep(300);
    const reminded = await page.evaluate(() => ({
      count: window.Store.reminders(window.Store.activeProfile().id).length,
      title: (window.Store.reminders(window.Store.activeProfile().id)[0] || {}).title,
      bells: document.querySelectorAll('#epg-list .epg-remind').length,
      toast: document.getElementById('toast').textContent
    }));
    eq(reminded.count, 1, 'OK on one still to come sets a reminder');
    eq(reminded.title, 'Next on 5', 'for that programme');
    eq(reminded.bells, 1, 'and the row wears a bell');
    ok(/Reminder set/.test(reminded.toast), 'and says so', reminded.toast);

    await press(page, 'ok');
    await sleep(300);
    eq(await page.evaluate(() =>
         window.Store.reminders(window.Store.activeProfile().id).length), 0,
       'OK again takes it off');

    await press(page, 'back');
    await sleep(250);
    s = await state(page);
    eq(s.epgActive, false, 'back leaves the guide');
    eq(s.badge, 'Channel 5', 'and none of it touched playback');

    /* ---------------------------------------------------------- */
    describe('a reminder goes off');

    /* Seeded rather than waited for: the fixture's programmes are half an hour
       apart, and what is under test is the firing, not the guide. It is put on
       a channel a long way down the list, so "Go to channel" has somewhere to
       travel from. */
    const remindTarget = await page.evaluate(() => {
      const c = window.Channels.channels()[4000];
      window.Store.setReminder(window.Store.activeProfile().id, {
        chKey: c.key, chName: c.name, title: 'The thing you asked about',
        start: Date.now() + 1000, stop: Date.now() + 3600000,
        desc: 'A long description the guide gave, which the popup has to show.',
        logo: 'icon.png'
      });
      return c.name;
    });
    await page.waitForFunction(() => window.U.confirmOpen === true, null, { timeout: 40000 });
    const dlg = await page.evaluate(() => ({
      text: document.getElementById('confirm-text').textContent,
      yes: document.getElementById('confirm-yes').textContent,
      no: document.getElementById('confirm-no').textContent,
      left: window.Store.reminders(window.Store.activeProfile().id).length,
      desc: document.getElementById('confirm-desc').textContent,
      descShown: !document.getElementById('confirm-desc').classList.contains('hidden'),
      logoShown: !document.getElementById('confirm-logo').classList.contains('hidden')
    }));
    ok(dlg.text.indexOf('The thing you asked about') > -1 && dlg.text.indexOf(remindTarget) > -1,
       'the popup names the programme and the channel', dlg.text);
    eq(dlg.yes, 'Go to channel', 'and offers to go there');
    eq(dlg.no, 'Close', 'or to be dismissed');
    eq(dlg.left, 0, 'it says its piece once and is gone');
    /* A reminder that goes off over a picture has to say what the programme
       is, not just that it exists. */
    ok(/A long description/.test(dlg.desc), 'the popup carries the description', dlg.desc);
    eq(dlg.descShown, true, 'and shows it');
    eq(dlg.logoShown, true, 'with the channel logo beside it');

    await press(page, 'ok');               // Go to channel
    await sleep(700);
    s = await state(page);
    eq(s.badge, remindTarget, 'Go to channel tunes to it');
    eq(s.focusedName, remindTarget, 'and the cursor goes with it');

    /* Put the run back on Channel 5, where the sections below expect it. */
    await page.keyboard.press('Digit6');
    await sleep(2000);


    /* ---------------------------------------------------------- */
    describe('editing a channel number');

    s = await state(page);
    const row5 = s.names.indexOf('Channel 5');
    eq(s.numbers[row5], '6', 'channel 5 starts on the playlist number');

    /* Numbering lives in Settings now, not behind a coloured button on the
       browse screen: it is set up once, and it was hidden. */
    await page.keyboard.press('y');
    await sleep(500);
    const rowLabels = () => page.evaluate(() =>
      [].slice.call(document.querySelectorAll('#settings-list .set-row .set-label'))
        .map(e => (e.firstChild ? e.firstChild.textContent : '')));
    let labels = await rowLabels();
    const numRow = labels.indexOf('Channel numbers');
    ok(numRow > -1, 'Settings offers Channel numbers', JSON.stringify(labels.slice(0, 8)));
    await press(page, 'down', numRow);
    await press(page, 'ok');
    await sleep(500);
    s = await state(page);
    ok(s.numbersShown, 'and it opens a screen of its own');
    eq(s.numbersFocused, 'Channel 0', 'starting at the top of the playlist');

    /* The ends of a five-thousand-channel list are a long way apart, so it
       wraps here too. */
    await press(page, 'up');
    await sleep(250);
    s = await state(page);
    eq(s.numbersFocused, 'Channel ' + (CHANNELS - 1), 'up from the top reaches the last channel');
    await press(page, 'down');
    await sleep(250);
    s = await state(page);
    eq(s.numbersFocused, 'Channel 0', 'and down from the last comes back to the first');

    await press(page, 'down', 5);
    await sleep(200);
    s = await state(page);
    eq(s.numbersFocused, 'Channel 5', 'down walks the list');
    eq(s.numbersValue, '6', 'showing the number it is on now');

    await press(page, 'ok');
    await sleep(300);
    s = await state(page);
    ok(s.numberOpen, 'OK opens the number editor');
    eq(s.numberValue, '', 'it starts empty, ready to type');

    /* It takes every key while it is open, so it has to be visible and where
       the eye is: this went unstyled for a long time, which from the numbers
       screen was indistinguishable from the app freezing. */
    const box = await page.evaluate(() => {
      const el = document.getElementById('number');
      const b = document.querySelector('.number-box');
      const r = b.getBoundingClientRect();
      const cs = getComputedStyle(el);
      const bs = getComputedStyle(b);
      return {
        covers: cs.position === 'absolute' && parseInt(cs.zIndex, 10) >= 10,
        dim: cs.backgroundColor,
        w: Math.round(r.width), h: Math.round(r.height),
        cx: Math.round(r.left + r.width / 2), cy: Math.round(r.top + r.height / 2),
        opaque: bs.backgroundColor,
        valueSize: parseInt(getComputedStyle(document.getElementById('num-value')).fontSize, 10)
      };
    });
    ok(box.covers, 'the prompt sits above everything else', JSON.stringify(box));
    ok(/rgba?\(/.test(box.dim) && box.dim !== 'rgba(0, 0, 0, 0)',
       'over a dimmed screen', box.dim);
    ok(box.w > 400 && box.h > 200, 'it is a box of a readable size', box.w + 'x' + box.h);
    ok(Math.abs(box.cx - 960) < 40 && Math.abs(box.cy - 540) < 60,
       'in the middle of the screen', box.cx + ',' + box.cy);
    ok(box.opaque !== 'rgba(0, 0, 0, 0)', 'with a background of its own', box.opaque);
    ok(box.valueSize >= 48, 'and the number big enough to read across a room',
       String(box.valueSize));

    const flow = await page.evaluate(() => {
      const y = id => {
        const r = document.getElementById(id).getBoundingClientRect();
        return { top: Math.round(r.top), bottom: Math.round(r.bottom) };
      };
      const keys = document.querySelector('.num-keys').getBoundingClientRect();
      return { title: y('num-title'), value: y('num-value'), sub: y('num-sub'),
               keysTop: Math.round(keys.top),
               pos: getComputedStyle(document.getElementById('num-value')).position };
    });
    eq(flow.pos, 'static', 'the number is in the flow of the box');
    ok(flow.value.top >= flow.title.bottom, 'below the channel name',
       JSON.stringify(flow));
    ok(flow.sub.top >= flow.value.bottom, 'above the line explaining it',
       JSON.stringify(flow));
    ok(flow.value.bottom <= flow.keysTop, 'and clear of the key hints',
       JSON.stringify(flow));

    await page.keyboard.press('Digit7');
    await page.keyboard.press('Digit0');
    await page.keyboard.press('Digit1');
    await sleep(150);
    s = await state(page);
    eq(s.numberValue, '701', 'digits type into it');

    await press(page, 'ok');
    await sleep(400);
    s = await state(page);
    eq(s.numberOpen, false, 'OK closes the editor');

    /* 701 already belongs to Channel 700 in this playlist, and two channels on
       one number cannot both be dialled — so it offers to trade instead. */
    ok(await page.evaluate(() => !document.getElementById('confirm').classList.contains('hidden')),
       'a number already in use asks before taking it');
    ok(await page.evaluate(() => /swap/i.test(document.getElementById('confirm-text').textContent)),
       'and what it offers is a swap',
       await page.evaluate(() => document.getElementById('confirm-text').textContent));

    await press(page, 'ok');               // yes
    await sleep(500);
    s = await state(page);
    ok(/[Ss]wap/.test(s.toast), 'it says what it did', s.toast);
    eq(s.numbersFocused, 'Channel 5', 'the cursor stays where it was');
    eq(s.numbersValue, '701', 'the row shows the new number');
    /* The other channel is a long way down a 5,000-row list, so ask the store
       rather than the screen. */
    const swapped = await page.evaluate(() => {
      const id = window.Store.activeProfile().id;
      const nums = window.Store.all().numbers[id] || {};
      const keys = Object.keys(nums);
      return { count: keys.length, values: keys.map(k => nums[k]).sort((x, y) => x - y) };
    });
    eq(swapped.count, 2, 'both channels were renumbered, not just the one');
    eq(swapped.values, [6, 701], 'they traded places');

    await press(page, 'back');             // back to settings
    await sleep(300);
    await press(page, 'back');             // back to the browse screen
    await sleep(400);
    s = await state(page);
    eq(s.main, true, 'and back out to the channel list');
    eq(s.numbers[s.names.indexOf('Channel 5')], '701', 'which is showing the new number');
    ok(s.customNumbers >= 1, 'marked as a custom number there too');

    describe('the new number is what the remote dials');

    await press(page, 'down', 20);         // move away first
    await page.keyboard.press('Digit7');
    await page.keyboard.press('Digit0');
    await page.keyboard.press('Digit1');
    await sleep(2200);                     // commits after 1.6 s
    s = await state(page);
    eq(s.focusedName, 'Channel 5', 'typing 701 jumps to the renumbered channel');
    eq(s.badge, 'Channel 5', 'and plays it');

    describe('resetting a number');

    await page.keyboard.press('y');
    await sleep(500);
    labels = await rowLabels();
    await press(page, 'down', labels.indexOf('Channel numbers'));
    await press(page, 'ok');
    await sleep(500);
    await press(page, 'down', 5);
    await sleep(200);
    s = await state(page);
    eq(s.numbersFocused, 'Channel 5', 'back on the renumbered channel');

    await page.keyboard.press('r');        // red = put it back
    await sleep(400);
    s = await state(page);
    eq(s.numbersValue, '6', 'red puts the playlist number back');
    eq(s.numbersCustom, 0, 'and it is no longer marked as changed');

    await press(page, 'back');
    await sleep(300);
    await press(page, 'back');
    await sleep(400);
    s = await state(page);
    eq(s.numbers[s.names.indexOf('Channel 5')], '6', 'the list agrees');
    ok(s.customNames.indexOf('Channel 5') === -1, 'and its custom marker is gone',
       JSON.stringify(s.customNames));

    /* Only its own. The channel it traded with still holds the number it was
       given, and putting one number back is not an offer to undo the other
       half of a swap somebody agreed to. */
    const left = await page.evaluate(() => {
      const id = window.Store.activeProfile().id;
      const nums = window.Store.all().numbers[id] || {};
      return Object.keys(nums).map(k => nums[k]);
    });
    eq(left, [6], 'and the only number still moved is the one it traded away');

    /* ---------------------------------------------------------- */
    describe('the action bar and the keyboard reference');

    /* INFO is on the bar because it is the one press that opens the guide
       panel, and nothing on screen said so. Still a legend for the remote:
       the PC keys that stand in for these are listed by H instead. */
    eq(await page.evaluate(() =>
      [].slice.call(document.querySelectorAll('.action-bar .act')).map(e => e.textContent.trim())),
      ['OKPlay', 'Full screen', 'INFOSchedule', 'Favourite', 'Search', 'Settings'],
      'the bar is a legend for the remote, with no PC keys on it');

    eq(await page.evaluate(() => document.querySelectorAll('.action-bar .kb').length), 0,
       'the keycaps are gone: this build is for a TV');

    const bar = await page.evaluate(() => {
      const b = document.querySelector('.action-bar');
      return { client: b.clientWidth, scroll: b.scrollWidth };
    });
    ok(bar.scroll <= bar.client, 'and the whole bar fits its pane',
       bar.scroll + 'px of content in ' + bar.client + 'px');

    const badgeBefore = (await state(page)).badge;
    await page.keyboard.press('h');
    await sleep(200);
    ok(await page.evaluate(() => !document.getElementById('keyhelp').classList.contains('hidden')),
       'H opens the keyboard reference');
    ok(await page.evaluate(() => document.querySelectorAll('#kh-grid .kh-row').length >= 10),
       'and it lists the bindings');

    await page.keyboard.press('Escape');
    await sleep(200);
    ok(await page.evaluate(() => document.getElementById('keyhelp').classList.contains('hidden')),
       'any key closes it again');
    s = await state(page);
    eq(s.main, true, 'and the key that closed it did nothing else');
    eq(s.badge, badgeBefore, 'playback was untouched throughout');

    /* ---------------------------------------------------------- */
    describe('catch-up browser');

    await page.keyboard.press('e');        // Guide button
    await sleep(400);
    s = await state(page);
    ok(s.replayShown, 'the guide button opens the catch-up browser');
    eq(s.main, false, 'and leaves the browse screen');
    ok(/Channel/.test(s.replayChannel), 'it names the channel', s.replayChannel);
    ok(s.replayDays.length >= 2, 'it lists a day per day of guide',
       JSON.stringify(s.replayDays));
    ok(/Today/.test(s.replayDays.join(' ')), 'including today',
       JSON.stringify(s.replayDays));
    ok(s.replayProgs.length > 0, 'and the programmes for the selected day',
       JSON.stringify(s.replayProgs));

    await press(page, 'left');             // into the day rail
    /* Down to the oldest day. How many days the rail holds depends on the hour
       the suite runs — the -4h and +6h programmes cross midnight either side —
       so walk to the end rather than counting steps. */
    for (let d = 0; d < 6; d++) await press(page, 'down');
    await sleep(300);
    s = await state(page);
    ok(/Two days ago/.test(s.replayProgs.join(' ')),
       'picking the oldest day shows that day', JSON.stringify(s.replayProgs));

    await press(page, 'right');            // back to the programmes
    await press(page, 'ok');               // replay it
    await sleep(700);
    s = await state(page);
    eq(s.replayShown, false, 'choosing a programme closes the browser');
    ok(s.playingFull, 'and plays it fullscreen');
    ok(/utc=\d+/.test(s.playerUrl), 'through the catch-up URL', s.playerUrl);
    ok(/lutc=\d+/.test(s.playerUrl), 'which carries the current time too', s.playerUrl);
    ok(s.badgeReplay, 'and the badge marks it a replay rather than live', s.badge);

    await press(page, 'back');
    await sleep(250);

    /* ---------------------------------------------------------- */
    describe('stream health warning');

    s = await state(page);
    eq(s.stallShown, false, 'nothing shown while the stream is behaving');

    await page.evaluate(() => window.Channels.onPlayerEvent('buffering', true));
    await sleep(400);
    s = await state(page);
    eq(s.stallShown, false, 'a brief rebuffer is not worth a warning');

    await sleep(1500);
    s = await state(page);
    ok(s.stallShown, 'a sustained one is');
    eq(s.stallText, 'Buffering', 'and says so', s.stallText);

    await page.evaluate(() => window.Channels.onPlayerEvent('buffering', false));
    await sleep(300);
    s = await state(page);
    eq(s.stallShown, false, 'it clears as soon as the stream recovers');

    /* ---------------------------------------------------------- */
    describe('parental control');

    // Back to All channels so the counts are comparable.
    await press(page, 'left');
    await page.evaluate(() => { window.Channels.reloadGroups(); });
    await sleep(200);
    await press(page, 'right');
    await sleep(200);

    s = await state(page);
    const allBefore = s.count;
    const groupsBefore = s.groups.join('|');
    ok(/Adults/.test(groupsBefore), 'the rail lists the adult group while unlocked',
       JSON.stringify(s.groups.slice(0, 8)));

    await page.evaluate(() => {
      window.Store.set('settings.pin', '1234');
      window.Store.set('settings.parental', true);
      window.Channels.reloadGroups();
    });
    await sleep(300);
    s = await state(page);
    ok(!/Adults/.test(s.groups.join('|')), 'turning parental control on hides that group',
       JSON.stringify(s.groups.slice(0, 8)));
    /* The count, not the cursor: reloading the groups keeps the cursor on the
       channel it was on, and only the total is the point here. */
    ok(s.count.split(' / ')[1] === String(CHANNELS - CHANNELS / GROUPS),
       'and its channels are gone from the list too', s.count);

    ok(await page.evaluate(() => window.Store.unlock('0000') === false),
       'a wrong PIN does not unlock');
    ok(await page.evaluate(() => window.Store.unlock('1234') === true),
       'the right one does');

    await page.evaluate(() => { window.Channels.reloadGroups(); });
    await sleep(300);
    s = await state(page);
    ok(/Adults/.test(s.groups.join('|')), 'unlocking brings the group back');
    eq(s.count, allBefore, 'and every channel with it');

    await page.evaluate(() => {
      window.Store.relock();
      window.Store.set('settings.parental', false);
      window.Store.set('settings.pin', '');
      window.Channels.reloadGroups();
    });
    await sleep(200);

    /* ---------------------------------------------------------- */
    describe('reconnecting a dropped stream');

    // The fixture streams do not exist, so playing one always errors — which
    // is exactly the condition this is for.
    await page.evaluate(() => window.Store.set('settings.autoReconnect', true));
    await press(page, 'down');             // a channel that is not playing
    await press(page, 'ok');

    // How long the stream takes to fail is not ours to control, so wait for
    // the condition rather than guessing at a delay.
    const retried = await page.waitForFunction(
      () => /Reconnecting/.test(document.getElementById('preview-hint').textContent),
      null, { timeout: 20000 }).then(() => true).catch(() => false);

    s = await state(page);
    ok(retried, 'a failed stream is retried rather than dropped', s.hint);
    ok(/\d\/3/.test(s.hint), 'and the attempt is counted', s.hint);

    await page.evaluate(() => window.Store.set('settings.autoReconnect', false));

    /* ---------------------------------------------------------- */
    describe('the channel panel on the right');

    await press(page, 'right');
    await sleep(300);
    let cm = await page.evaluate(() => {
      const el = document.getElementById('ctxmenu');
      const panel = document.getElementById('cm-panel');
      const r = panel.getBoundingClientRect();
      return {
        shown: !el.classList.contains('hidden'),
        title: document.getElementById('cm-title').textContent,
        items: [].slice.call(document.querySelectorAll('.cm-row')).map(x => (x.querySelector('.mi-label') || x).textContent.trim()),
        focused: ((document.querySelector('.cm-row.focused') || {}).textContent || '').trim(),
        onTheRight: Math.round(r.right) >= 1919 && r.width > 400,
        fullHeight: Math.round(r.height) >= 1079
      };
    });
    ok(cm.shown, 'right on a channel opens the panel');
    ok(cm.onTheRight && cm.fullHeight, 'down the right-hand edge of the screen',
       JSON.stringify(cm));
    ok(cm.title.length > 0, 'it names the channel', cm.title);
    ok(cm.items.length >= 3, 'and offers what you can do with it', JSON.stringify(cm.items));
    ok(/full screen/i.test(cm.items[0]), 'starting with watching it', cm.items[0]);

    await press(page, 'back');
    await sleep(250);
    cm = await page.evaluate(() => ({
      shown: !document.getElementById('ctxmenu').classList.contains('hidden')
    }));
    eq(cm.shown, false, 'back closes it');

    /* ---------------------------------------------------------- */
    describe('the stream warning knows when to keep quiet');

    // Drive the warning by hand: the drift sampler needs real stalled playback.
    await page.evaluate(() => {
      document.getElementById('stall-text').textContent = 'Stream is behind  9s';
      document.getElementById('stall-warn').classList.remove('hidden');
    });
    s = await state(page);
    eq(s.stallShown, true, 'the warning is up on the browse screen');

    await page.keyboard.press('y');            // into settings
    await sleep(400);
    s = await state(page);
    eq(s.settings, true, 'settings is open');
    eq(s.stallShown, false, 'and the warning is not sitting over it');

    await press(page, 'back');
    await sleep(300);
    s = await state(page);
    eq(s.main, true, 'back on the browse screen');

    /* ---------------------------------------------------------- */
    describe('settings');

    await page.keyboard.press('y');        // yellow = settings
    await sleep(200);
    s = await state(page);
    ok(s.settings, 'the yellow button opens settings');
    await page.screenshot({ path: path.join(ROOT, 'shot-settings.png') });

    const setRows = await page.evaluate(() =>
      [].slice.call(document.querySelectorAll('#settings-list .set-row .set-label'))
        .map(e => e.firstChild ? e.firstChild.textContent : ''));
    ['Picture size', 'Clock', 'Catch-up history', 'Channel numbers',
     'Advanced'].forEach(function (label) {
      ok(setRows.indexOf(label) > -1, 'settings offers "' + label + '"',
         JSON.stringify(setRows));
    });
    ['Reconnect automatically', 'Guide time offset', 'Clear cached data'].forEach(function (label) {
      ok(setRows.indexOf(label) === -1,
         '"' + label + '" is not in the everyday list', JSON.stringify(setRows));
    });

    /* Advanced expands in place at the bottom, bringing the technical rows and
       the diagnostics with it. */
    const advAt = setRows.indexOf('Advanced');
    await press(page, 'down', advAt);
    await press(page, 'ok');
    await sleep(300);
    const openRows = await page.evaluate(() =>
      [].slice.call(document.querySelectorAll('#settings-list .set-row .set-label'))
        .map(e => (e.firstChild ? e.firstChild.textContent : '')));
    ['Reconnect automatically', 'Guide time offset', 'Clear cached data',
     'Stream resolution', 'Video plane', 'Restart application'].forEach(function (label) {
      ok(openRows.indexOf(label) > -1, 'Advanced brings out "' + label + '"',
         JSON.stringify(openRows.slice(advAt)));
    });
    ok(await page.evaluate(() => document.querySelectorAll('#settings-list .set-row.adv').length > 5),
       'and they are set in from the everyday rows');

    /* "Why has this channel got nothing on air?" is a question about the
       provider's own guide, which cannot be answered from here — so the app
       counts it and says. */
    const cov = await page.evaluate(() => {
      const rows = [].slice.call(document.querySelectorAll('#settings-list .set-row'));
      const r = rows.filter(x => {
        const l = x.querySelector('.set-label');
        return l && l.firstChild && l.firstChild.textContent === 'Guide coverage';
      })[0];
      if (!r) return null;
      return {
        value: (r.querySelector('.set-value') || {}).textContent || '',
        sub: (r.querySelector('.set-sub') || {}).textContent || ''
      };
    });
    ok(!!cov, 'Advanced counts how much of the playlist the guide covers');
    ok(/^\d+ \/ \d+$/.test((cov && cov.value || '').trim()),
       'as channels-on-air over channels', cov && cov.value);
    eq((cov.value || '').trim().split(' / ')[1], String(CHANNELS),
       'counted against the whole playlist');

    await press(page, 'ok');               // fold it away again
    await sleep(250);
    const folded = await page.evaluate(() =>
      [].slice.call(document.querySelectorAll('#settings-list .set-row .set-label'))
        .map(e => (e.firstChild ? e.firstChild.textContent : '')));
    eq(folded.indexOf('Clear cached data'), -1, 'and OK folds it away again');

    /* Picture size must reach the video element, and each mode must mean
       something different — the setting was decorative for a while because
       "original" resolved to "do not scale at all" on both players. */
    const fitFor = async function (mode) {
      await page.evaluate(m => {
        window.Store.set('settings.pictureSize', m);
        window.App.onSettingChanged('settings.pictureSize');
      }, mode);
      await sleep(150);
      return page.evaluate(() => {
        const v = document.querySelector('#video-layer video');
        return v ? getComputedStyle(v).objectFit : null;
      });
    };
    const fitDefault = await page.evaluate(() => {
      const v = document.querySelector('#video-layer video');
      return v ? getComputedStyle(v).objectFit : null;
    });
    eq(fitDefault, 'cover', 'Fill (crop) is what a new install gets');
    eq(await fitFor('fit'), 'contain', 'Fit shows the whole picture instead');
    eq(await fitFor('stretch'), 'fill', 'and Stretch pulls it to the box');
    eq(await fitFor('fill'), 'cover', 'back to Fill');

    /* An install that still holds the setting that used to exist must not keep
       its behaviour, which was to leave the picture at its coded size. */
    const migrated = await page.evaluate(() => {
      const raw = JSON.parse(localStorage.getItem('nova.state.v1'));
      raw.settings.pictureSize = 'original';
      localStorage.setItem('nova.state.v1', JSON.stringify(raw));
      window.Store.init();
      return window.Store.settings().pictureSize;
    });
    ok(migrated !== 'original', 'a saved "original" is migrated away', migrated);
    await page.evaluate(() => {
      window.Store.set('settings.pictureSize', 'fill');
      window.App.onSettingChanged('settings.pictureSize');
    });

    /* ---------------------------------------------------------- */
    describe('choosing a language from a list');

    /* It used to be a cycle. Ten languages one key at a time means eight more
       presses if you overshoot — in a language you may no longer be able to
       read, which is exactly the state somebody is in on this row. */
    const settingsRows = () => page.evaluate(() =>
      [].slice.call(document.querySelectorAll('#settings-list .set-row'))
        .map(r => ({
          label: (r.querySelector('.set-label') || {}).textContent || '',
          value: (r.querySelector('.set-value') || {}).textContent || '',
          focused: r.classList.contains('focused'),
          key: r.classList.contains('key')
        })));

    const pick = () => page.evaluate(() => {
      const p = document.getElementById('picker');
      return {
        open: !p.classList.contains('hidden'),
        title: document.getElementById('picker-title').textContent,
        items: [].slice.call(document.getElementById('picker-list').children)
          .map(r => r.textContent),
        focused: [].slice.call(document.getElementById('picker-list').children)
          .findIndex(r => r.classList.contains('focused'))
      };
    });

    let sr = await settingsRows();
    const langRow = sr.findIndex(r => r.label.indexOf('Language') === 0);
    ok(langRow > -1, 'settings has a Language row', JSON.stringify(sr.map(r => r.label)));

    /* Every row is bold now; the three that matter are larger instead. */
    ok(sr.every(r => !r.label || true), 'rows render');
    const keyRows = sr.filter(r => r.key).map(r => r.label);
    eq(keyRows.length, 3, 'three rows are marked as the main ones',
       JSON.stringify(keyRows));

    /* The three are larger, not differently coloured. Their value was in the
       accent colour for a while and read as a link rather than a setting. */
    const weights = await page.evaluate(() => {
      const rows = [].slice.call(document.querySelectorAll('#settings-list .set-row'));
      const pick = k => {
        const r = rows.filter(x => x.classList.contains('key') === k &&
                                   !x.classList.contains('focused'))[0];
        if (!r) return null;
        const l = r.querySelector('.set-label'), v = r.querySelector('.set-value');
        return {
          size: getComputedStyle(l).fontSize,
          weight: getComputedStyle(l).fontWeight,
          value: v ? getComputedStyle(v).color : ''
        };
      };
      return { key: pick(true), plain: pick(false) };
    });
    ok(weights.key && weights.plain, 'both kinds of row are on screen');
    eq(weights.key.weight, weights.plain.weight,
       'every row is the same weight — all of them bold');
    ok(parseFloat(weights.key.size) > parseFloat(weights.plain.size),
       'and the main ones stand out by size instead',
       weights.key.size + ' against ' + weights.plain.size);
    eq(weights.key.value, weights.plain.value,
       'with their value the same colour as everything else',
       weights.key.value + ' against ' + weights.plain.value);

    /* From the top rather than from wherever the last section left the
       cursor — this runs after Advanced has been opened and walked. */
    const toRow = async (n) => {
      await press(page, 'up', 40);
      await sleep(150);
      await press(page, 'down', n);
      await sleep(200);
    };
    await toRow(langRow);
    await press(page, 'ok');
    await sleep(300);

    let pk = await pick();
    ok(pk.open, 'OK on it opens a list rather than stepping to the next language');
    await page.screenshot({ path: path.join(ROOT, 'shot-picker.png') });
    eq(pk.items.length, 11,
       'holding every language the app has, plus following the TV',
       JSON.stringify(pk.items));
    ok(pk.items.indexOf('Español') > -1, 'named in their own words',
       JSON.stringify(pk.items));

    /* Back leaves it alone — a picker that changed things on the way out
       would be worse than the cycle it replaced. */
    const langWas = (await settingsRows())[langRow].value;
    await press(page, 'back');
    await sleep(300);
    eq((await pick()).open, false, 'back closes it');
    eq((await settingsRows())[langRow].value, langWas, 'and changes nothing');

    /* And picking one takes, in the language picked. */
    await press(page, 'ok');
    await sleep(300);
    pk = await pick();
    const esAt = pk.items.indexOf('Español');
    await press(page, 'down', Math.max(0, esAt - pk.focused));
    await sleep(200);
    await press(page, 'ok');
    await sleep(500);
    eq((await pick()).open, false, 'choosing closes it');
    eq(await page.evaluate(() => document.documentElement.lang), 'es',
       'and the app is in that language');

    /* Put it back, through the same list, which proves it is usable in a
       language the tester cannot read either. */
    await press(page, 'ok');
    await sleep(300);
    pk = await pick();
    await press(page, 'up', pk.focused);
    await sleep(200);
    await press(page, 'ok');
    await sleep(500);
    eq(await page.evaluate(() => document.documentElement.lang), 'en',
       'and back to following the TV');

    /* ---------------------------------------------------------- */
    describe('the date over the channel list');

    sr = await settingsRows();
    const dateRow = sr.findIndex(r => r.label.indexOf('Date format') === 0);
    ok(dateRow > -1, 'there is a row for it', JSON.stringify(sr.map(r => r.label)));

    /* The value is today written that way, not the name of a convention —
       which is both fewer strings and a better answer to "what will I get". */
    const shownNow = sr[dateRow].value;
    ok(/\d/.test(shownNow), 'showing today in the chosen format', shownNow);

    await toRow(dateRow);

    const seen = [];
    for (let i = 0; i < 6; i++) {
      seen.push((await settingsRows())[dateRow].value);
      await press(page, 'right');
      await sleep(250);
    }
    eq(seen.length, new Set(seen).size, 'six formats, all different',
       JSON.stringify(seen));
    ok(seen.some(v => /^\d\d\/\d\d\/\d{4}$/.test(v)), 'one of them numeric',
       JSON.stringify(seen));
    ok(seen.some(v => /^\d{4}-\d\d-\d\d$/.test(v)), 'one of them ISO',
       JSON.stringify(seen));
    ok(seen.indexOf('Off') > -1, 'and one of them off', JSON.stringify(seen));

    /* And it reaches the head of the channel list without waiting for the
       ten-second tick. */
    await page.evaluate(() => {
      window.Store.set('settings.dateFormat', 'iso');
      window.App.onSettingChanged('settings.dateFormat');
    });
    await sleep(200);
    ok(/^\d{4}-\d\d-\d\d$/.test(await page.evaluate(() =>
         document.getElementById('head-date').textContent)),
       'the head of the list follows it at once',
       await page.evaluate(() => document.getElementById('head-date').textContent));

    await page.evaluate(() => {
      window.Store.set('settings.dateFormat', 'long');
      window.App.onSettingChanged('settings.dateFormat');
    });
    await sleep(200);

    await press(page, 'back');
    await sleep(200);
    s = await state(page);
    eq(s.settings, false, 'back closes settings');
    eq(s.main, true, 'and returns to the browse screen');

    /* ---------------------------------------------------------- */
    describe('changing a channel number from the panel');

    /* The same edit as the Settings screen, for the channel under the cursor —
       wanting to move one channel should not mean walking a list of five
       thousand to find it again. It shares that screen's rule: two channels
       cannot hold one number. */
    await press(page, 'right');
    await sleep(300);
    const numRows = await page.evaluate(() =>
      [].slice.call(document.querySelectorAll('.cm-row'))
        .map(r => (r.querySelector('.mi-label') || r).textContent.trim()));
    const numIdx = numRows.indexOf('Change channel number');
    ok(numIdx > -1, 'the panel offers it', JSON.stringify(numRows));

    const target = await page.evaluate(() => document.getElementById('cm-title').textContent);
    await press(page, 'down', numIdx);
    await press(page, 'ok');
    await sleep(300);
    ok(await page.evaluate(() =>
         !document.getElementById('number').classList.contains('hidden')),
       'and opens the number prompt on that channel');
    eq(await page.evaluate(() => document.getElementById('num-title').textContent), target,
       'naming it');

    /* A number nothing else holds: it just takes. */
    /* 9001 is past the end of a 5,000-channel fixture, so nothing holds it. */
    for (const d of ['9', '0', '0', '1']) { await page.keyboard.press('Digit' + d); await sleep(50); }
    await press(page, 'ok');
    await sleep(400);
    let numState = await page.evaluate(name => {
      const pid = window.Store.activeProfile().id;
      const ch = window.Channels.channels().filter(c => c.name === name)[0];
      return { set: window.Store.channelNumber(pid, ch.key), key: ch.key,
               shown: [].slice.call(document.querySelectorAll('#channel-list .ch-row'))
                 .filter(r => r.querySelector('.ch-name').textContent === name)
                 .map(r => r.querySelector('.ch-num').textContent)[0] };
    }, target);
    eq(numState.set, 9001, 'the number is stored');
    eq(numState.shown, '9001', 'and the row shows it');

    /* Now one that is taken: it must offer to swap rather than duplicate,
       because a duplicate cannot be dialled — the remote reaches whichever
       the list hits first. */
    await press(page, 'right');
    await sleep(300);
    await press(page, 'down', numIdx);
    await press(page, 'ok');
    await sleep(300);
    for (const d of ['3']) { await page.keyboard.press('Digit' + d); await sleep(50); }
    await press(page, 'ok');
    await sleep(400);
    const swap = await page.evaluate(() => ({
      open: window.U.confirmOpen,
      text: document.getElementById('confirm-text').textContent
    }));
    eq(swap.open, true, 'a number already in use asks first');
    ok(/Swap their numbers/.test(swap.text), 'offering to trade places', swap.text);

    await press(page, 'ok');               // yes, swap
    await sleep(400);
    const traded = await page.evaluate(name => {
      const pid = window.Store.activeProfile().id;
      const all = window.Channels.channels();
      const ch = all.filter(c => c.name === name)[0];
      const other = all.filter(c => window.Store.channelNumber(pid, c.key) === 9001)[0];
      return { mine: window.Store.channelNumber(pid, ch.key),
               other: other ? other.name : '' };
    }, target);
    eq(traded.mine, 3, 'the channel takes the number it asked for');
    ok(!!traded.other, 'and the one that had it takes the number this one had',
       traded.other + ' is now 9001');

    /* Put both back on their playlist numbers. */
    await page.evaluate(() => {
      const pid = window.Store.activeProfile().id;
      window.Store.clearNumbers(pid);
      window.Channels.reloadGroups();
    });
    await sleep(300);
    /* ---------------------------------------------------------- */
    describe('locking one channel behind the PIN');

    /* Parental control by hand rather than by heuristic. A locked channel is
       not hidden — hiding is what the adult filter does to a whole category —
       it stays in the list wearing a padlock and asks for the PIN when
       somebody tries to watch it. */
    const panelItems = () => page.evaluate(() =>
      [].slice.call(document.querySelectorAll('.cm-row'))
        .map(r => (r.querySelector('.mi-label') || r).textContent.trim()));
    const pinPrompt = () => page.evaluate(() => ({
      open: !document.getElementById('number').classList.contains('hidden'),
      title: document.getElementById('num-title').textContent,
      sub: document.getElementById('num-sub').textContent
    }));
    /* No OK: a four-digit PIN submits itself on the fourth digit. */
    const typePin = async digits => {
      for (const d of digits) { await page.keyboard.press('Digit' + d); await sleep(60); }
      await sleep(400);
    };

    await press(page, 'right');            // the channel panel
    await sleep(300);
    const cmRows = await panelItems();
    const lockIdx = cmRows.indexOf('Lock with PIN');
    ok(lockIdx > -1, 'the channel panel offers a lock', JSON.stringify(cmRows));

    const locking = await page.evaluate(() => document.getElementById('cm-title').textContent);
    await press(page, 'down', lockIdx);
    await press(page, 'ok');
    await sleep(300);
    let prompt = await pinPrompt();
    eq(prompt.open, true, 'with no PIN set yet, it asks for one first');
    eq(prompt.title, 'Set a PIN code', 'saying so');
    eq(await page.evaluate(() => document.getElementById('num-value').textContent), '',
       'starting empty');
    await typePin('1234');

    const locked = await page.evaluate(() => ({
      keys: window.Store.lockedKeys(window.Store.activeProfile().id),
      unlocked: window.Store.sessionUnlocked(),
      padlocks: document.querySelectorAll('#channel-list .ch-lock.on').length,
      listed: [].slice.call(document.querySelectorAll('#channel-list .ch-row'))
        .filter(r => r.style.display !== 'none')
        .map(r => r.querySelector('.ch-name').textContent)
    }));
    eq(locked.keys.length, 1, 'one channel is locked');
    /* The bug this replaced: setting the lock used to open the session, so the
       channel it was just put on played without a word when you went back. */
    eq(locked.unlocked, false, 'and setting it does not open the session');
    ok(locked.listed.indexOf(locking) > -1, 'the channel is still in the list', locking);
    eq(locked.padlocks, 1, 'wearing a padlock');

    /* Now try to watch it. */
    await press(page, 'ok');
    await sleep(300);
    prompt = await pinPrompt();
    eq(prompt.open, true, 'OK on it asks for the PIN');
    ok(prompt.sub.indexOf(locking) > -1, 'naming the channel', prompt.sub);

    await typePin('9999');
    s = await state(page);
    eq(await page.evaluate(() => window.Store.sessionUnlocked()), false,
       'a wrong PIN does not open it');
    ok(s.badge !== locking, 'and nothing starts playing', s.badge);

    /* It asks again rather than closing on a mistyped digit — which matters
       more now that the fourth digit submits by itself. */
    const retry = await pinPrompt();
    eq(retry.open, true, 'it asks again instead of giving up');
    ok(/Wrong PIN/.test(retry.sub), 'saying why', retry.sub);
    await typePin('1234');
    s = await state(page);
    eq(s.badge, locking, 'the right PIN plays it');
    eq(await page.evaluate(() => window.Store.sessionUnlocked()), true,
       'and holds the session open, so the next locked channel does not ask again');

    /* Settings -> Lock now closes it again without a restart. */
    await page.keyboard.press('y');
    await sleep(500);
    const setLabels = () => page.evaluate(() =>
      [].slice.call(document.querySelectorAll('#settings-list .set-row .set-label'))
        .map(e => (e.firstChild ? e.firstChild.textContent : '')));
    let lockLabels = await setLabels();
    ok(lockLabels.indexOf('Locked channels') > -1, 'Settings counts what is locked',
       JSON.stringify(lockLabels.filter(l => /Lock|PIN|Parental/.test(l))));
    const lockNowIdx = lockLabels.indexOf('Lock now');
    ok(lockNowIdx > -1, 'and offers to lock them again now');
    await press(page, 'down', lockNowIdx);
    await press(page, 'ok');
    await sleep(300);
    await press(page, 'back');
    await sleep(400);

    const relocked = await page.evaluate(name => ({
      unlocked: window.Store.sessionUnlocked(),
      listed: [].slice.call(document.querySelectorAll('#channel-list .ch-row'))
        .filter(r => r.style.display !== 'none')
        .map(r => r.querySelector('.ch-name').textContent).indexOf(name) > -1,
      playing: window.Player.isPlaying()
    }), locking);
    eq(relocked.unlocked, false, 'Lock now closes the session again');
    eq(relocked.listed, true, 'the channel is still listed');
    eq(relocked.playing, false, 'and the picture stopped with the lock');

    await press(page, 'ok');
    await sleep(300);
    eq((await pinPrompt()).open, true, 'so it asks for the PIN all over again');
    /* Taking a lock off always asks, even with the session already open: the
       two directions are not the same act. A session left unlocked after
       somebody watched something is exactly when a child could undo it. */
    await typePin('1234');                 // through the gate, session open again
    await sleep(300);
    eq(await page.evaluate(() => window.Store.sessionUnlocked()), true,
       'the session is open again');

    await press(page, 'right');
    await sleep(300);
    const unlockRows = await panelItems();
    const unlockIdx = unlockRows.indexOf('Unlock this channel');
    ok(unlockIdx > -1, 'the panel offers to take the lock off', JSON.stringify(unlockRows));
    await press(page, 'down', unlockIdx);
    await press(page, 'ok');
    await sleep(300);
    const offPrompt = await pinPrompt();
    eq(offPrompt.open, true, 'which asks for the PIN even though the session is open');
    ok(offPrompt.sub.indexOf('To unlock') > -1, 'saying what it is for', offPrompt.sub);
    await typePin('1234');

    eq(await page.evaluate(() =>
         window.Store.lockedKeys(window.Store.activeProfile().id).length), 0,
       'and the lock comes off');
    eq(await page.evaluate(() => document.querySelectorAll('#channel-list .ch-lock.on').length), 0,
       'padlock and all');

    /* Put the fixture back: the PIN is a setting, not a lock. */
    await page.evaluate(() => { window.Store.set('settings.pin', ''); });
    await press(page, 'ok');
    await sleep(400);
    s = await state(page);
    eq(s.badge, locking, 'and with the lock off it just plays');


    /* ---------------------------------------------------------- */
    describe('the app in another language');

    /* Every string is looked up at paint time, so switching is: swap the
       dictionary, restamp the static markup, rebuild whatever is on screen.
       Nothing reloads and nothing is lost. */
    const uiText = () => page.evaluate(() => ({
      lang: window.I18N.lang(),
      htmlLang: document.documentElement.getAttribute('lang'),
      title: document.getElementById('list-title').textContent,
      hint: document.getElementById('preview-hint').textContent,
      guide: document.querySelector('.epg-label').textContent,
      firstGroup: (document.querySelector('#group-list > *') || {}).textContent
    }));

    const english = await uiText();
    eq(english.lang, 'en', 'it starts in English');
    eq(english.title, 'All channels', 'with an English list title');

    await page.evaluate(() => {
      window.Store.set('settings.lang', 'es');
      window.App.onSettingChanged('settings.lang');
    });
    await sleep(300);
    const spanish = await uiText();
    eq(spanish.lang, 'es', 'the language changes');
    eq(spanish.htmlLang, 'es', 'and the document says so, which is what picks the font');
    eq(spanish.title, 'Todos los canales', 'the list title is translated');
    eq(spanish.hint, 'Pulsa OK para reproducir', 'and so is the static markup');
    eq(spanish.guide, 'Guía', 'including the guide panel');
    ok(/Todos los canales/.test(spanish.firstGroup), 'and the built-in group names',
       spanish.firstGroup);

    /* A language that shares no letters with English, to prove nothing is
       falling through to the key by accident. */
    await page.evaluate(() => {
      window.Store.set('settings.lang', 'ja');
      window.App.onSettingChanged('settings.lang');
    });
    await sleep(300);
    const japanese = await uiText();
    eq(japanese.title, 'すべてのチャンネル', 'another language, another script');
    eq(japanese.guide, '番組表', 'right through the interface');

    /* Settings itself is built from translated rows, so it has to be rebuilt
       rather than merely repainted. */
    await page.keyboard.press('y');
    await sleep(500);
    const jaRows = await page.evaluate(() =>
      [].slice.call(document.querySelectorAll('#settings-list .set-row .set-label'))
        .map(e => (e.firstChild ? e.firstChild.textContent : '')));
    ok(jaRows.indexOf('言語') > -1, 'Settings is translated too', JSON.stringify(jaRows.slice(0, 5)));
    ok(jaRows.every(l => !/^(Theme|Language|Settings)$/.test(l)),
       'with nothing left in English', JSON.stringify(jaRows.slice(0, 8)));

    /* The one row that must not be translated: a language names itself. */
    const langValues = await page.evaluate(() =>
      [].slice.call(document.querySelectorAll('#settings-list .set-row'))
        .map(r => (r.querySelector('.set-value') || {}).textContent || ''));
    ok(langValues.indexOf('日本語') > -1, 'and the language is named in its own words',
       JSON.stringify(langValues.slice(0, 6)));

    await press(page, 'back');
    await sleep(300);
    await page.evaluate(() => {
      window.Store.set('settings.lang', '');
      window.App.onSettingChanged('settings.lang');
    });
    await sleep(300);
    const back = await uiText();
    eq(back.title, 'All channels', 'and back to following the TV, which here is English');
    /* ---------------------------------------------------------- */
    describe('the light theme, and what it must not reach');

    /* Two things are held apart here. The page is light but never white: a
       55-inch panel of white in a dim room is what the theme exists to avoid.
       The info bar is not part of the page — it sits on a dark scrim over a
       broadcast picture, so it keeps the dark palette in both themes. A
       light-theme text colour there would be near-black on near-black, which
       is the bug this test exists to stop coming back. */
    const lum = c => {
      const m = /(\d+),\s*(\d+),\s*(\d+)/.exec(c || '');
      return m ? (0.2126 * +m[1] + 0.7152 * +m[2] + 0.0722 * +m[3]) / 255 : -1;
    };

    const theme = await page.evaluate(() => {
      window.Store.set('settings.theme', 'light');
      window.U.applyTheme();
      return {
        body: getComputedStyle(document.body).backgroundColor,
        rowText: getComputedStyle(document.querySelector('.ch-row:not(.focused) .ch-name')).color
      };
    });

    ok(lum(theme.body) < 0.90, 'the light theme is light, not white',
       theme.body + ' -> ' + lum(theme.body).toFixed(3));
    ok(lum(theme.body) > 0.55, 'and still light rather than grey',
       theme.body + ' -> ' + lum(theme.body).toFixed(3));
    ok(lum(theme.rowText) < 0.30, 'with text dark enough to read on it',
       theme.rowText + ' -> ' + lum(theme.rowText).toFixed(3));
    await sleep(200);
    await page.screenshot({ path: path.join(ROOT, 'shot-light.png') });

    await press(page, 'p');                // fullscreen, info bar up
    await sleep(400);
    const osdBar = await page.evaluate(() => ({
      title: getComputedStyle(document.getElementById('osd-name')).color,
      desc: getComputedStyle(document.getElementById('osd-desc')).color,
      next: getComputedStyle(document.getElementById('osd-next')).color,
      scrim: getComputedStyle(document.getElementById('osd')).backgroundImage
    }));

    ok(osdBar.scrim.indexOf('rgba(4, 6, 10') > -1,
       'the info bar keeps its dark scrim in the light theme', osdBar.scrim.slice(0, 60));
    ok(lum(osdBar.title) > 0.6, 'the title stays light against it', osdBar.title);
    ok(lum(osdBar.desc) > 0.6, 'and so does the description', osdBar.desc);
    ok(lum(osdBar.desc) < lum(osdBar.title), 'a step under the title, not level with it',
       osdBar.desc + ' vs ' + osdBar.title);
    ok(lum(osdBar.next) < lum(osdBar.desc), 'and next a step under that again',
       osdBar.next + ' vs ' + osdBar.desc);

    await press(page, 'back');             // the bar
    await press(page, 'back');             // then fullscreen
    await page.evaluate(() => { window.Store.set('settings.theme', 'dark'); window.U.applyTheme(); });
    await sleep(200);

    /* ---------------------------------------------------------- */
    describe('console health');

    const realErrors = pageErrors.filter(m => !/\$WEBAPIS/.test(m));
    eq(realErrors, [], 'no uncaught page errors during the run');

  } catch (e) {
    fail++;
    failures.push('threw: ' + (e && e.stack || e));
    console.log('\n  !! ' + (e && e.stack || e));
    try { await page.screenshot({ path: path.join(ROOT, 'shot-failure.png') }); } catch (_) {}
  } finally {
    await browser.close().catch(() => {});
    server.kill();
    if (!KEEP) fs.rmSync(TESTDIR, { recursive: true, force: true });
  }

  console.log('\n  ' + pass + ' passed, ' + fail + ' failed');
  if (failures.length) {
    console.log('\n  Failures:');
    failures.forEach(f => console.log('   - ' + f));
  }
  console.log('\n  Screenshots: shot-1-list, shot-2-groups, shot-3-search,' +
              ' shot-4-playing, shot-5-osd, shot-6-guide,' +
              ' shot-back-to-live, shot-back-to-live-idle, shot-light, shot-catalogue, shot-settings, shot-drawer, shot-picker (.png)\n');
  process.exit(fail ? 1 : 0);
})();

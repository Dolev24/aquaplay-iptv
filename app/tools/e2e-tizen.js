#!/usr/bin/env node
/* e2e-tizen.js — the Samsung path, driven from a desk.
 *
 * Every other suite runs the app as a browser, which is the one platform the
 * TV build is not. The Tizen player is a different object with a different
 * vocabulary and a state machine that throws at you for calling things in the
 * wrong order — and it had no coverage at all. When a release went out and the
 * Samsung player was reported broken, the only tool available was reading
 * diffs by hand, which is a poor way to answer "does the app still drive
 * AVPlay correctly".
 *
 * So: a webapis.avplay that keeps AVPlay's own state machine and refuses what
 * a real one refuses, injected before the app loads. U.isTizen then reports
 * true and the app takes the Samsung branch of every decision in it.
 *
 * What this can prove: that the app opens, prepares, plays and stops in an
 * order a television accepts, that it places the picture where it says it
 * does, and that nothing in the Tizen branch throws. What it cannot prove is
 * how a real set behaves — a fake written from the documentation agrees with
 * the documentation. It is the difference between a compiler and a customer.
 *
 *   node tools/e2e-tizen.js
 *   node tools/e2e-tizen.js --headed
 */

const fs = require('fs');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');
const { chromium } = require('playwright-core');

const ROOT = path.resolve(__dirname, '..');
const TESTDIR = path.join(ROOT, '.test-tizen');
const HEADED = process.argv.includes('--headed');
const CHANNELS = 12;

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

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
    s.on('error', reject);
  });
}

/* The suites drive the Chrome that is on the machine rather than a browser
   downloaded for the purpose: playwright-core is here for the driving, not
   for a second copy of Chromium. */
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

function writeFixture(port) {
  fs.mkdirSync(TESTDIR, { recursive: true });
  const lines = ['#EXTM3U'];
  for (let i = 0; i < CHANNELS; i++) {
    lines.push('#EXTINF:-1 tvg-id="ch' + i + '",Channel ' + i);
    lines.push('http://127.0.0.1:' + port + '/.test-tizen/stream/' + i + '.m3u8');
  }
  fs.writeFileSync(path.join(TESTDIR, 'list.m3u'), lines.join('\n'), 'utf8');
  return 'http://127.0.0.1:' + port + '/.test-tizen/list.m3u';
}

/* ---------- keys ---------- */

const K = { up: 38, down: 40, left: 37, right: 39, ok: 13, back: 8 };

async function press(page, key, times = 1) {
  for (let i = 0; i < times; i++) {
    await page.evaluate((code) => {
      const e = new KeyboardEvent('keydown', { bubbles: true, cancelable: true });
      Object.defineProperty(e, 'keyCode', { get: () => code });
      Object.defineProperty(e, 'which', { get: () => code });
      document.dispatchEvent(e);
    }, K[key]);
    await sleep(40);
  }
}

/* ---------- the fake set ----------

   AVPlay's states and the transitions it allows, as the Samsung
   documentation describes them. Everything the app calls is here; anything
   called out of turn throws the way the real one does, and every call is
   recorded so the test can say what the app did rather than guess. */

function avplayStub() {
  const log = [];
  let state = 'NONE';
  let listener = null;
  let rect = null;
  let method = '';
  const err = (what) => { throw new Error('INVALID_STATE_ERR: ' + what + ' in ' + state); };

  window.__av = {
    log,
    state: () => state,
    rect: () => rect,
    method: () => method,
    /* Let a test finish the prepare the app started. */
    finishPrepare: () => { if (window.__av._ok) { const f = window.__av._ok; window.__av._ok = null; state = 'READY'; f(); } },
    listener: () => listener
  };

  window.webapis = {
    avplay: {
      open(url) {
        log.push('open');
        if (state !== 'NONE') err('open');
        state = 'IDLE';
        window.__av.url = url;
      },
      close() { log.push('close'); state = 'NONE'; },
      stop() {
        log.push('stop');
        if (state === 'NONE') err('stop');
        state = 'IDLE';
      },
      getState() { return state; },
      setListener(l) { log.push('setListener'); listener = l; },
      setDisplayMethod(m) {
        log.push('setDisplayMethod');
        if (state === 'NONE') err('setDisplayMethod');
        method = m;
      },
      setDisplayRect(x, y, w, h) {
        log.push('setDisplayRect');
        /* The real one refuses a rect before there is anything to place. */
        if (state === 'NONE') err('setDisplayRect');
        rect = [x, y, w, h];
      },
      setBufferingParam() { log.push('setBufferingParam'); if (state === 'NONE') err('setBufferingParam'); },
      setStreamingProperty() { log.push('setStreamingProperty'); if (state === 'NONE') err('setStreamingProperty'); },
      prepareAsync(okFn) {
        log.push('prepareAsync');
        if (state !== 'IDLE') err('prepareAsync');
        /* Held, so a test can decide when the set becomes ready — which is
           the window in which the viewer presses OK a second time. */
        window.__av._ok = okFn;
      },
      play() {
        log.push('play');
        if (state !== 'READY' && state !== 'PAUSED') err('play');
        state = 'PLAYING';
      },
      pause() { log.push('pause'); state = 'PAUSED'; },
      getCurrentTime() { return 0; },
      getDuration() { return 0; },
      seekTo() { log.push('seekTo'); if (state === 'NONE') err('seekTo'); },
      getCurrentStreamInfo() {
        if (state === 'NONE' || state === 'IDLE') err('getCurrentStreamInfo');
        return [{ type: 'VIDEO', extra_info: JSON.stringify({ Width: 1920, Height: 1080 }) }];
      }
    }
  };
}

/* ---------- the run ---------- */

(async function () {
  console.log('\nAquaPlay IPTV — the Samsung path');

  const port = await freePort();
  const playlist = writeFixture(port);
  const server = await startServer(port);

  const browser = await chromium.launch({ executablePath: chromePath(), headless: !HEADED });
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  await context.addInitScript(avplayStub);
  await context.addInitScript(() => {
    try { window.localStorage.setItem('nova.state.v1', JSON.stringify({
      settings: { epg: false, autoReconnect: false, startupPlayLast: false }
    })); } catch (e) {}
  });

  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', e => pageErrors.push(e.message));

  try {
    await page.goto('http://127.0.0.1:' + port + '/', { waitUntil: 'load' });
    await page.waitForFunction(() => !!window.App && !!window.U, null, { timeout: 10000 });

    /* ---------------------------------------------------------- */
    describe('the app knows it is on a television');

    const who = await page.evaluate(() => ({
      tizen: window.U.isTizen, tv: window.U.isTV, android: window.U.isAndroid,
      platform: window.U.platform, cls: document.documentElement.className
    }));
    ok(who.tizen, 'webapis.avplay is what makes it a Samsung set', JSON.stringify(who));
    ok(who.tv && !who.android, 'so it is a TV, and not the other one', JSON.stringify(who));
    ok(/\btv\b/.test(who.cls) && /tizen/.test(who.cls),
       'and the page is marked for both', who.cls);

    /* The page must not paint over AVPlay's plane. */
    const paint = await page.evaluate(() => ({
      html: getComputedStyle(document.documentElement).backgroundColor,
      body: getComputedStyle(document.body).backgroundColor,
      stage: getComputedStyle(document.getElementById('stage')).backgroundColor
    }));
    const clear = c => c === 'transparent' || /^rgba\(0, 0, 0, 0\)$/.test(c);
    ok(clear(paint.html) && clear(paint.body) && clear(paint.stage),
       'and nothing opaque is painted over the video plane', JSON.stringify(paint));

    /* ---------------------------------------------------------- */
    describe('an object for the plane, and a playlist');

    ok(await page.evaluate(() => {
      const o = document.querySelector('#video-layer object');
      return !!o && o.type === 'application/avplayer';
    }), 'the video layer holds an avplayer object, which is the plane');

    await press(page, 'right');             // the M3U tab
    await press(page, 'down');              // name
    await press(page, 'ok');
    await page.keyboard.type('Fixture');
    await press(page, 'down');              // url
    await press(page, 'ok');
    await page.keyboard.type(playlist);
    await press(page, 'down');              // epg
    await press(page, 'down');              // connect
    await press(page, 'ok');

    await page.waitForFunction(() =>
      !document.getElementById('view-main').classList.contains('hidden'),
      null, { timeout: 30000 });
    ok(true, 'the playlist loads and the browse screen opens');

    /* ---------------------------------------------------------- */
    describe('tuning a channel drives AVPlay in an order it accepts');

    await page.evaluate(() => { window.__av.log.length = 0; });
    await press(page, 'ok');                // play the focused channel
    await sleep(300);

    let log = await page.evaluate(() => window.__av.log.slice());
    const order = (a, b) => log.indexOf(a) > -1 && log.indexOf(b) > -1 && log.indexOf(a) < log.indexOf(b);

    ok(log.indexOf('open') > -1, 'it opens the stream', JSON.stringify(log));
    ok(order('open', 'setListener'), 'listens after opening, not before');
    ok(order('open', 'prepareAsync'), 'and prepares after opening');
    ok(order('setListener', 'prepareAsync'),
       'with the listener already in place, or the first events are lost');
    ok(log.indexOf('play') === -1,
       'and does not call play until the set says it is ready', JSON.stringify(log));
    eq(await page.evaluate(() => window.__av.state()), 'IDLE',
       'the set is opened and waiting');

    /* Now the set becomes ready, which is what prepareAsync's callback means. */
    await page.evaluate(() => window.__av.finishPrepare());
    await sleep(200);
    log = await page.evaluate(() => window.__av.log.slice());
    ok(log.indexOf('play') > -1, 'once ready, it plays', JSON.stringify(log));
    eq(await page.evaluate(() => window.__av.state()), 'PLAYING', 'and the set is playing');

    /* ---------------------------------------------------------- */
    describe('the app places the picture, the set only puts it there');

    const preview = await page.evaluate(() => window.__av.rect());
    ok(preview && preview[2] > 0 && preview[3] > 0,
       'a rect was given for the preview', JSON.stringify(preview));
    ok(preview[0] >= 880 && preview[0] + preview[2] <= 1920,
       'inside the preview panel, in the 1920x1080 the app draws in',
       JSON.stringify(preview));
    eq(await page.evaluate(() => window.__av.method()), 'PLAYER_DISPLAY_MODE_FULL_SCREEN',
       'and the display method is "fill the rect you were given"');

    await press(page, 'ok');                // fullscreen
    await sleep(250);
    const full = await page.evaluate(() => window.__av.rect());
    eq(full, [0, 0, 1920, 1080], 'fullscreen asks for the whole screen');

    /* Back may be spent on the info bar first, exactly as it is for a
       viewer, so press until the screen is actually given up. */
    for (let i = 0; i < 3; i++) {
      const still = await page.evaluate(() =>
        document.getElementById('stage').classList.contains('playing-full'));
      if (!still) break;
      await press(page, 'back');
      await sleep(250);
    }
    ok(!(await page.evaluate(() =>
      document.getElementById('stage').classList.contains('playing-full'))),
      'back leaves fullscreen');
    const back = await page.evaluate(() => window.__av.rect());
    ok(back[0] >= 880 && back[2] < 1920,
       'and leaving it puts the picture back in the panel', JSON.stringify(back));

    /* ---------------------------------------------------------- */
    describe('nothing was called out of turn');

    /* The stub throws exactly where a real set throws. Anything the app got
       wrong would have come out as a page error or a caught exception that
       left the player somewhere it should not be. */
    ok(await page.evaluate(() => window.__av.state()) === 'PLAYING',
       'the set is still playing at the end of all that');
    eq(pageErrors.filter(m => !/\$WEBAPIS/.test(m)), [],
       'and no uncaught page errors during the run');

  } catch (e) {
    fail++;
    failures.push('threw: ' + (e && e.stack || e));
    console.log('\n  !! ' + (e && e.stack || e));
  } finally {
    await browser.close().catch(() => {});
    server.kill();
    fs.rmSync(TESTDIR, { recursive: true, force: true });
  }

  console.log('\n  ' + pass + ' passed, ' + fail + ' failed');
  if (failures.length) {
    console.log('\n  Failures:');
    failures.forEach(f => console.log('   - ' + f));
  }
  console.log('');
  process.exit(fail ? 1 : 0);
})();

#!/usr/bin/env node
/* test-units.js — parser tests. No dependencies, no browser.
   Loads the real js/*.js modules into a fake window and exercises them.

     node tools/test-units.js
*/

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const zlib = require('zlib');

const ROOT = path.resolve(__dirname, '..');

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

/* ---------- load the app modules into a fake window ---------- */

const ctx = vm.createContext({ console, setTimeout, clearTimeout, setInterval, clearInterval });
ctx.window = ctx;
ctx.self = ctx;
ctx.document = {
  getElementById() { return null; },
  querySelector() { return null; },
  addEventListener() {}
};
ctx.navigator = { userAgent: 'node' };

// Stubs for the two collaborators the catch-up builder reaches for.
ctx.Net = {};
var stubSettings = { streamFormat: 'auto', clock24: true };
ctx.Store = { settings: function () { return stubSettings; } };

let xhrBytes = null;      // what the stubbed XMLHttpRequest will return
let xhrStatus = 200;
ctx.XMLHttpRequest = function () {
  this.open = function () {};
  this.send = () => {
    setTimeout(() => {
      this.status = xhrStatus;
      if (xhrBytes) this.response = xhrBytes.buffer.slice(
        xhrBytes.byteOffset, xhrBytes.byteOffset + xhrBytes.byteLength);
      if (this.status >= 200 && this.status < 300) { if (this.onload) this.onload(); }
      else if (this.onload) this.onload();
    }, 0);
  };
};

for (const f of ['js/util.js', 'js/inflate.js', 'js/net.js', 'js/m3u.js', 'js/epg.js',
                 'js/xtream.js', 'js/catchup.js', 'js/player.js']) {
  vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), ctx, { filename: f });
}
ctx.U.DEBUG = false;
const U = ctx.U, M3U = ctx.M3U, EPG = ctx.EPG, Catchup = ctx.Catchup;
const Inflate = ctx.Inflate, Net = ctx.Net, Player = ctx.Player;

/* ---------- helpers ---------- */

function xmlt(ms, offset) {
  const d = new Date(ms);
  const p = n => String(n).padStart(2, '0');
  return d.getUTCFullYear() + p(d.getUTCMonth() + 1) + p(d.getUTCDate()) +
         p(d.getUTCHours()) + p(d.getUTCMinutes()) + p(d.getUTCSeconds()) +
         (offset ? ' ' + offset : ' +0000');
}

const H = 3600000;

/* ============================================================ */
/*  util                                                        */
/* ============================================================ */

async function testUtil() {
  describe('util.slug / searchKey');

  eq(U.slug('BBC One HD'), 'bbcone', 'strips the HD quality tag');
  eq(U.slug('Sky Sports (1080p)'), 'skysports', 'strips a parenthesised suffix');
  eq(U.slug('  ITV-4  '), 'itv4', 'strips punctuation and whitespace');
  eq(U.slug(null), '', 'null is safe');
  describe('util.matchKey — guide matching across scripts');

  eq(U.matchKey('BBC One HD'), 'bbcone', 'behaves like slug for Latin names');
  eq(U.matchKey('Sky Sports (1080p)'), 'skysports', 'drops a parenthesised suffix');
  eq(U.matchKey('Yes Movies Action HD'), 'yesmoviesaction', 'drops the quality tag');
  eq(U.matchKey('9 Канал HD'), '9канал',
     'keeps Cyrillic instead of reducing the name to "9"');
  eq(U.slug('9 Канал HD'), '9',
     'which is exactly what slug does, and why matching needs its own key');
  eq(U.matchKey('ערוץ 12'), 'ערוץ' + '12', 'keeps Hebrew');
  eq(U.matchKey('9'), '', 'refuses to fuzzy-match on one character');
  eq(U.matchKey('12'), '', 'or two — too weak to be a safe match');
  eq(U.matchKey('itv'), 'itv', 'three is enough');
  eq(U.matchKey('12-kanal-il'), '12kanalil', 'strips separators from a tvg-id');
  eq(U.matchKey(null), '', 'null is safe');

  describe('util.slug / searchKey (continued)');

  eq(U.searchKey('BBC One HD'), 'bbc one hd', 'search key keeps words, lowercased');
  eq(U.searchKey('Sky  Sports!!'), 'sky sports', 'search key collapses separators');
  eq(U.clamp(150, 0, 100), 100, 'clamp upper');
  eq(U.clamp(-3, 0, 100), 0, 'clamp lower');
  eq(U.esc('<a href="x">&'), '&lt;a href=&quot;x&quot;&gt;&amp;', 'escapes markup');
}

/* ============================================================ */
/*  M3U                                                         */
/* ============================================================ */

async function testM3U() {
  describe('m3u.parse — basics');

  const basic = [
    '#EXTM3U url-tvg="http://example.com/xmltv.xml"',
    '#EXTINF:-1 tvg-id="bbc1.uk" tvg-logo="http://l/1.png" group-title="UK" tvg-chno="101",BBC One',
    'http://server/live/1.m3u8',
    '#EXTINF:-1 tvg-id="itv.uk" group-title="UK",ITV',
    'http://server/live/2.m3u8'
  ].join('\n');

  let r = await M3U.parse(basic);
  eq(r.channels.length, 2, 'parses both channels');
  eq(r.epgUrl, 'http://example.com/xmltv.xml', 'reads url-tvg from the header');
  eq(r.channels[0].name, 'BBC One', 'reads the display name after the comma');
  eq(r.channels[0].tvgId, 'bbc1.uk', 'reads tvg-id');
  eq(r.channels[0].logo, 'http://l/1.png', 'reads tvg-logo');
  eq(r.channels[0].group, 'UK', 'reads group-title');
  eq(r.channels[0].num, 101, 'honours tvg-chno');
  eq(r.channels[0].url, 'http://server/live/1.m3u8', 'reads the URL line');
  eq(r.channels[1].num, 2, 'falls back to sequential numbering');
  eq(r.groups, [{ id: 'UK', name: 'UK', count: 2 }], 'builds the group list with counts');

  describe('m3u.parse — real-world shapes');

  r = await M3U.parse('#EXTM3U\r\n#EXTINF:-1,A\r\nhttp://a\r\n#EXTINF:-1,B\r\nhttp://b\r\n');
  eq(r.channels.length, 2, 'handles CRLF line endings');
  eq(r.channels[0].group, 'Ungrouped', 'defaults the group when none is given');

  r = await M3U.parse('#EXTINF:-1,Solo\nhttp://solo');
  eq(r.channels.length, 1, 'parses a playlist with no #EXTM3U header');

  r = await M3U.parse('#EXTM3U\n#EXTINF:-1,A\n#EXTGRP:Sports\nhttp://a');
  eq(r.channels[0].group, 'Sports', 'EXTGRP supplies the group');

  r = await M3U.parse('#EXTM3U\n#EXTINF:-1 group-title="News",A\n#EXTGRP:Sports\nhttp://a');
  eq(r.channels[0].group, 'News', 'group-title wins over EXTGRP');

  r = await M3U.parse('#EXTM3U\n#EXTINF:-1 tvg-name="From Tvg",\nhttp://a');
  eq(r.channels[0].name, 'From Tvg', 'falls back to tvg-name when the label is empty');

  r = await M3U.parse('#EXTM3U\n#EXTINF:-1,\nhttp://a');
  eq(r.channels[0].name, 'Unnamed', 'names an untitled channel');

  r = await M3U.parse('#EXTM3U\n#EXTINF:-1,Dangling\n#EXTINF:-1,Real\nhttp://real');
  eq(r.channels.length, 1, 'drops an EXTINF that never got a URL');
  eq(r.channels[0].name, 'Real', 'and keeps the one that did');

  r = await M3U.parse('#EXTM3U\n#EXTINF:-1 group-title="Zed",Z\nhttp://z\n#EXTINF:-1 group-title="Alpha",A\nhttp://a');
  eq(r.groups.map(g => g.id), ['Alpha', 'Zed'], 'groups are sorted alphabetically');

  describe('m3u.parse — Movies and Series sections');

  r = await M3U.parse([
    '#EXTM3U',
    '#EXTINF:-1 group-title="UK",BBC One',
    'http://h/live/u/p/1.ts',
    '#EXTINF:-1 group-title="UK",ITV',
    'http://h/2.ts',
    '#EXTINF:-1 group-title="Action",Some Movie',
    'http://h/movie/u/p/3.mkv',
    '#EXTINF:-1 group-title="Drama",Some Show S01E01',
    'http://h/series/u/p/4.mp4'
  ].join('\n'));

  eq(r.channels.length, 2, 'the legacy channels array stays live-only');
  eq(r.sections.live.channels.length, 2, 'live entries land in the live section');
  eq(r.sections.vod.channels.length, 1, 'a /movie/ URL is classified as a movie');
  eq(r.sections.series.channels.length, 1, 'a /series/ URL is classified as series');
  eq(r.sections.vod.channels[0].kind, 'vod', 'movies carry their kind');
  eq(r.sections.vod.channels[0].name, 'Some Movie', 'and their name');
  eq(r.sections.live.channels[0].key, 'bbcone',
     'live keys stay unprefixed so existing favourites survive the upgrade');
  eq(r.sections.vod.channels[0].key, 'v:somemovie', 'movie keys are namespaced');
  eq(r.sections.series.channels[0].key.slice(0, 2), 's:', 'series keys are namespaced');
  eq(r.sections.vod.groups, [{ id: 'Action', name: 'Action', count: 1 }],
     'each section gets its own group list');
  eq(r.sections.live.groups, [{ id: 'UK', name: 'UK', count: 2 }],
     'and the live groups exclude on-demand entries');
  eq(r.sections.vod.channels[0].num, 1, 'numbering restarts within each section');

  r = await M3U.parse('#EXTM3U\n#EXTINF:-1,A\nhttp://a\n');
  eq(r.sections.vod.channels.length, 0, 'a live-only playlist has no movies');
  eq(r.sections.series.channels.length, 0, 'and no series');

  describe('m3u.parse — chunk boundary (CHUNK = 4000 lines)');

  // Build a playlist where channels straddle the 4000-line chunk boundary.
  // `pending` must survive the yield between chunks.
  const lines = ['#EXTM3U'];
  for (let i = 0; i < 5000; i++) {
    lines.push('#EXTINF:-1 group-title="G",Ch' + i);
    lines.push('http://s/' + i);
  }
  const big = lines.join('\n');
  r = await M3U.parse(big);
  eq(r.channels.length, 5000, 'parses all 5000 channels across chunks');
  eq(r.channels[1999].name, 'Ch1999', 'the channel straddling the boundary is intact');
  eq(r.channels[1999].url, 'http://s/1999', 'and kept its URL');
  eq(r.groups[0].count, 5000, 'group count totals across chunks');

  const seen = new Set(r.channels.map(c => c.name));
  eq(seen.size, 5000, 'no channel is dropped or duplicated');

  describe('m3u.parse — progress and rejection');

  const pcts = [];
  await M3U.parse(big, p => pcts.push(p));
  ok(pcts.length > 1, 'reports progress more than once for a large playlist',
     'got ' + pcts.length + ' callbacks');
  eq(pcts[pcts.length - 1], 100, 'final progress is 100');

  let threw = '';
  try { await M3U.parse('<html>not a playlist</html>'); }
  catch (e) { threw = e.message; }
  ok(/not return an M3U/i.test(threw), 'rejects a non-playlist response', threw);

  threw = '';
  try { await M3U.parse(''); } catch (e) { threw = e.message; }
  ok(!!threw, 'rejects empty input', threw);
}

/* ============================================================ */
/*  EPG                                                         */
/* ============================================================ */

async function testEPG() {
  const now = Date.now();
  const guide = (progs, chans) =>
    '<?xml version="1.0"?>\n<tv>\n' + (chans || '') + progs + '</tv>';

  const chan = (id, name) =>
    '<channel id="' + id + '"><display-name>' + name + '</display-name></channel>\n';
  const prog = (id, s, e, title, off) =>
    '<programme start="' + xmlt(s, off) + '" stop="' + xmlt(e, off) +
    '" channel="' + id + '"><title>' + title + '</title></programme>\n';

  describe('epg.parse — time window');

  let d = await EPG.parse(guide(
    prog('bbc1.uk', now - H, now + H, 'On Now') +
    prog('bbc1.uk', now + H, now + 2 * H, 'Up Next') +
    prog('bbc1.uk', now + 400 * H, now + 401 * H, 'Far Future') +
    prog('bbc1.uk', now - 400 * H, now - 399 * H, 'Long Past'),
    chan('bbc1.uk', 'BBC One')
  ));

  eq(d.count, 2, 'keeps only programmes inside the window');
  eq(d.byChannel['bbc1.uk'].map(p => p.t), ['On Now', 'Up Next'], 'and keeps them in time order');

  describe('epg.parse — timezone offsets');

  // Wide window so the offset shift itself is what is under test, not the
  // window filter. xmlt() truncates to whole seconds, hence the tolerance.
  const wide = { hoursAhead: 48, hoursBehind: 48 };
  const base = now + 4 * H;

  d = await EPG.parse(guide(prog('c', base, base + H, 'T', '+0300')), wide);
  let got = d.byChannel['c'][0].s;
  ok(Math.abs(got - (base - 3 * H)) < 1500, '+0300 is subtracted to reach UTC',
     'delta ' + ((got - base) / H).toFixed(2) + 'h, expected -3h');

  d = await EPG.parse(guide(prog('c', base, base + H, 'T', '-0500')), wide);
  got = d.byChannel['c'][0].s;
  ok(Math.abs(got - (base + 5 * H)) < 1500, '-0500 is added to reach UTC',
     'delta ' + ((got - base) / H).toFixed(2) + 'h, expected +5h');

  d = await EPG.parse(guide(prog('c', base, base + H, 'T', '')), wide);
  got = d.byChannel['c'][0].s;
  ok(Math.abs(got - base) < 1500, 'a bare timestamp with no offset is read as UTC',
     'delta ' + ((got - base) / H).toFixed(2) + 'h, expected 0h');

  describe('epg.parse — text handling');

  d = await EPG.parse(guide(prog('c', now - H, now + H, 'Tom &amp; Jerry &lt;1&gt;')));
  eq(d.byChannel['c'][0].t, 'Tom & Jerry <1>', 'decodes XML entities in titles');

  d = await EPG.parse(guide(prog('c', now - H, now + H, 'Caf&#233;')));
  eq(d.byChannel['c'][0].t, 'Café', 'decodes numeric entities');

  d = await EPG.parse(guide(
    '<programme start="' + xmlt(now - H) + '" stop="' + xmlt(now + H) +
    '" channel="c"><desc>no title here</desc></programme>\n'));
  eq(d.byChannel['c'][0].t, 'No title', 'falls back when a programme has no title');

  describe('epg.parse — caps and rejection');

  let many = '';
  for (let i = 0; i < 50; i++) many += prog('c', now + i * 60000, now + (i + 1) * 60000, 'P' + i);
  d = await EPG.parse(guide(many), { maxPerChannel: 5 });
  eq(d.byChannel['c'].length, 5, 'honours maxPerChannel');

  let threw = '';
  try { await EPG.parse('<html>nope</html>'); } catch (e) { threw = e.message; }
  ok(/not return an XMLTV/i.test(threw), 'rejects a non-XMLTV response', threw);

  describe('epg.resolve — channel matching');

  d = await EPG.parse(guide(
    prog('bbc1.uk', now - H, now + H, 'Now') + prog('sky.sports', now - H, now + H, 'Now2'),
    chan('bbc1.uk', 'BBC One') + chan('sky.sports', 'Sky Sports')
  ));

  eq(EPG.resolve({ tvgId: 'bbc1.uk', name: 'whatever' }), 'bbc1.uk', 'exact tvg-id match');
  eq(EPG.resolve({ tvgId: '', name: 'BBC One HD' }), 'bbc1.uk', 'fuzzy match on display-name, ignoring HD');
  eq(EPG.resolve({ tvgId: '', name: 'Sky Sports (1080p)' }), 'sky.sports', 'fuzzy match ignoring a quality suffix');
  eq(EPG.resolve({ tvgId: '', name: 'Nothing Here' }), '', 'no match returns empty');

  describe('epg.resolve — non-Latin names and false positives');

  d = await EPG.parse(guide(
    prog('9kanal.il', now - H, now + H, 'Now') + prog('rossija', now - H, now + H, 'Now2'),
    chan('9kanal.il', '9 Канал') + chan('rossija', 'Россия')
  ));

  eq(EPG.resolve({ tvgId: '', name: '9 Канал HD' }), '9kanal.il',
     'a Cyrillic channel name matches its guide entry');
  eq(EPG.resolve({ tvgId: '', name: 'Россия HD' }), 'rossija',
     'and so does another');

  // The old slug reduced both of these to "9", so they matched each other.
  d = await EPG.parse(guide(
    prog('nine.tv', now - H, now + H, 'Now'), chan('nine.tv', '9')));
  eq(EPG.resolve({ tvgId: '', name: '9 Канал HD' }), '',
     'a name that reduces to one character does not false-match a guide "9"');

  describe('epg.nowNext / progress');

  d = await EPG.parse(guide(
    prog('c', now - H, now + H, 'Current') + prog('c', now + H, now + 2 * H, 'Following')));

  let nn = EPG.nowNext({ tvgId: 'c', name: 'c' });
  eq(nn.now.t, 'Current', 'nowNext finds the current programme');
  eq(nn.next.t, 'Following', 'nowNext finds the following programme');

  const pct = EPG.progress(nn.now);
  ok(pct > 45 && pct < 55, 'progress through a half-elapsed programme is ~50%',
     'got ' + Math.round(pct) + '%');

  eq(EPG.progress(null), 0, 'progress of nothing is 0');
  eq(EPG.nowNext({ tvgId: 'unknown', name: 'unknown' }), null, 'nowNext on an unmatched channel is null');

  // A gap: nothing on now, something later.
  d = await EPG.parse(guide(prog('c', now + 2 * H, now + 3 * H, 'Later')));
  nn = EPG.nowNext({ tvgId: 'c', name: 'c' });
  eq(nn.now, null, 'a gap in the schedule yields no current programme');
  eq(nn.next.t, 'Later', 'but still reports what is next');

  describe('epg.serialise / hydrate');

  d = await EPG.parse(guide(
    prog('c', now - H, now + H, 'Current'), chan('c', 'Channel C')));
  const blob = JSON.parse(JSON.stringify(EPG.serialise()));
  EPG.clear();
  eq(EPG.hasData(), false, 'clear() empties the guide');
  eq(EPG.hydrate(blob), true, 'hydrate accepts a serialised blob');
  eq(EPG.hasData(), true, 'and the guide is populated again');
  eq(EPG.nowNext({ tvgId: 'c', name: 'c' }).now.t, 'Current', 'hydrated data still answers nowNext');
  eq(EPG.hydrate(null), false, 'hydrate rejects rubbish');
}

/* ============================================================ */
/*  catch-up                                                    */
/* ============================================================ */

async function testCatchup() {
  describe('m3u.parse — catch-up attributes');

  var r = await M3U.parse([
    '#EXTM3U catchup-type="shift" url-tvg="http://x/epg.xml"',
    '#EXTINF:0 tvg-id="a" tvg-rec="7",Alpha',
    'http://h/live/a.m3u8',
    '#EXTINF:0 tvg-id="b" catchup-days="3" catchup="append" catchup-source="?begin=${start}",Beta',
    'http://h/live/b.m3u8',
    '#EXTINF:0 tvg-id="c",Gamma',
    'http://h/live/c.m3u8'
  ].join(String.fromCharCode(10)));

  var a = r.channels[0], b = r.channels[1], g = r.channels[2];
  eq(a.catchupDays, 7, 'tvg-rec is read as the catch-up window');
  eq(a.catchup, 'shift', 'and the scheme falls back to the header');
  eq(b.catchupDays, 3, 'catchup-days is read per channel');
  eq(b.catchup, 'append', 'a per-channel scheme wins over the header');
  eq(b.catchupSource, '?begin=${start}', 'the source template is kept');
  eq(g.catchup, 'shift', 'a channel with no attributes inherits the header');
  eq(g.catchupDays, 0, 'but claims no window of its own');

  describe('Catchup.available');

  var now = Date.UTC(2026, 7, 26, 20, 0, 0);
  var H = 3600000;
  var ch = { url: 'http://h/live/a.m3u8', catchup: 'shift', catchupDays: 7 };
  var m3u = { type: 'm3u' };

  eq(Catchup.days(m3u, ch), 7, 'the window is seven days');
  eq(Catchup.available(m3u, ch, { s: now - H, e: now - H / 2 }, now), true,
     'something that aired an hour ago can be replayed');
  eq(Catchup.available(m3u, ch, { s: now + H, e: now + 2 * H }, now), false,
     'something that has not aired cannot');
  eq(Catchup.available(m3u, ch, { s: now - 8 * 86400000, e: now - 8 * 86400000 + H }, now), false,
     'and neither can something older than the window');
  eq(Catchup.available(m3u, { url: 'u' }, { s: now - H, e: now }, now), false,
     'a channel with no catch-up offers none');

  describe('Catchup.url — the M3U schemes');

  var prog = { s: now - 2 * H, e: now - H, t: 'Something' };
  var startS = Math.floor((now - 2 * H) / 1000), nowS = Math.floor(now / 1000);

  eq(Catchup.url(m3u, ch, prog, now),
     'http://h/live/a.m3u8?utc=' + startS + '&lutc=' + nowS,
     'shift appends utc and lutc');

  eq(Catchup.url(m3u, { url: 'http://h/a.m3u8?token=x', catchup: 'shift', catchupDays: 7 }, prog, now),
     'http://h/a.m3u8?token=x&utc=' + startS + '&lutc=' + nowS,
     'and joins onto a URL that already has a query');

  eq(Catchup.url(m3u, { url: 'http://h/b.m3u8', catchup: 'append', catchupDays: 7,
                        catchupSource: '?begin=${start}&end=${end}' }, prog, now),
     'http://h/b.m3u8?begin=' + startS + '&end=' + Math.floor((now - H) / 1000),
     'append substitutes into the source and joins it on');

  eq(Catchup.url(m3u, { url: 'http://h/c.m3u8', catchup: 'default', catchupDays: 7,
                        catchupSource: 'http://h/dvr/${start}/${duration}.m3u8' }, prog, now),
     'http://h/dvr/' + startS + '/3600.m3u8',
     'default uses the source as the whole URL');

  eq(Catchup.url(m3u, ch, { s: now + H, e: now + 2 * H }, now), '',
     'a programme that has not aired yields no URL');

  describe('Catchup.url — Xtream timeshift');

  var xt = { type: 'xtream', host: 'http://p.tv:8080', user: 'u', pass: 'p', formats: ['m3u8'] };
  var xch = { streamId: 42, archive: true, archiveDays: 5 };
  eq(Catchup.days(xt, xch), 5, 'the window comes from archiveDays');
  var url = Catchup.url(xt, xch, prog, now);
  ok(/^http:\/\/p\.tv:8080\/timeshift\/u\/p\/60\/[\d-]+:[\d-]+\/42\.m3u8$/.test(url),
     'the timeshift path carries duration, start and stream id', url);
  eq(Catchup.url(xt, { streamId: 9, archive: false }, prog, now), '',
     'a channel without archive yields no URL');
}

/* ============================================================ */
/*  settings that change behaviour                              */
/* ============================================================ */

async function testSettings() {
  describe('util.hhmm / hhmmss honour the clock setting');

  var d = new Date(2026, 7, 27, 14, 5, 9);
  var m = new Date(2026, 7, 27, 0, 30, 0);

  stubSettings.clock24 = true;
  eq(U.hhmm(d), '14:05', '24-hour afternoon');
  eq(U.hhmmss(d), '14:05:09', '24-hour with seconds');
  eq(U.hhmm(m), '00:30', '24-hour after midnight');

  stubSettings.clock24 = false;
  eq(U.hhmm(d), '2:05pm', '12-hour afternoon');
  eq(U.hhmmss(d), '2:05:09pm', '12-hour with seconds');
  eq(U.hhmm(m), '12:30am', 'midnight is 12, not 0');
  eq(U.hhmm(new Date(2026, 7, 27, 12, 0, 0)), '12:00pm', 'noon is 12pm');
  stubSettings.clock24 = true;

  describe('epg.parse — guide time offset');

  var now = Date.now();
  var guide = function (progs, chans) {
    return '<?xml version="1.0"?>\n<tv>\n' + (chans || '') + progs + '</tv>';
  };
  var prog = function (id, st, en, title) {
    return '<programme start="' + xmlt(st) + '" stop="' + xmlt(en) +
           '" channel="' + id + '"><title>' + title + '</title></programme>\n';
  };

  var base = now + 3 * H;
  var wide = { hoursAhead: 48, hoursBehind: 48 };

  var plain = await EPG.parse(guide(prog('c', base, base + H, 'T')), wide);
  var shifted = await EPG.parse(guide(prog('c', base, base + H, 'T')),
    { hoursAhead: 48, hoursBehind: 48, offsetHours: 2 });

  var a = plain.byChannel['c'][0].s;
  var b = shifted.byChannel['c'][0].s;
  ok(Math.abs((b - a) - 2 * H) < 1500, 'a +2 hour offset moves programmes forward',
     'moved ' + Math.round((b - a) / 60000) + ' min');

  var backAgain = await EPG.parse(guide(prog('c', base, base + H, 'T')),
    { hoursAhead: 48, hoursBehind: 48, offsetHours: -1 });
  ok(Math.abs((backAgain.byChannel['c'][0].s - a) + H) < 1500,
     'and a negative offset moves them back',
     'moved ' + Math.round((backAgain.byChannel['c'][0].s - a) / 60000) + ' min');

  var both = await EPG.parse(guide(prog('c', base, base + H, 'T')),
    { hoursAhead: 48, hoursBehind: 48, offsetHours: 2 });
  eq(both.byChannel['c'][0].e - both.byChannel['c'][0].s,
     plain.byChannel['c'][0].e - plain.byChannel['c'][0].s,
     'shifting does not change how long a programme runs');
}

/* ============================================================ */
/*  parental                                                    */
/* ============================================================ */

async function testAdult() {
  describe('util.isAdult');

  eq(U.isAdult({ group: 'Adults', name: 'Ch 1' }), true, 'an Adults group');
  eq(U.isAdult({ group: 'XXX', name: 'Ch 1' }), true, 'an XXX group');
  eq(U.isAdult({ group: 'IL | ADULT', name: 'Ch 1' }), true, 'inside a longer group name');
  eq(U.isAdult({ group: 'General', name: 'Hustler TV' }), true, 'a known adult brand');
  eq(U.isAdult({ group: 'General', name: 'Playboy HD' }), true, 'another');
  eq(U.isAdult({ group: 'General', name: 'Channel 18+' }), true, 'an age marker');

  eq(U.isAdult({ group: 'Kids', name: 'Nickelodeon' }), false, 'a kids channel is not');
  eq(U.isAdult({ group: 'Sports', name: 'Sport 5' }), false, 'nor a sports one');
  eq(U.isAdult({ group: 'News', name: 'BBC World' }), false, 'nor news');
  eq(U.isAdult({ group: 'Movies', name: 'Adulthood' }), false,
     'and "adulthood" is a word, not a category');
  eq(U.isAdult(null), false, 'null is safe');
}

/* ============================================================ */
/*  source hygiene                                              */
/* ============================================================ */

async function testSourceHygiene() {
  describe('shipped source is free of stray control characters');

  /* A CSS escape written as "\\25B7" through escaping-prone tooling once landed
     in style.css as the single byte 0x15 followed by the literal text "B7",
     which rendered as a tofu box next to every replayable programme. Nothing
     we ship should contain a control character other than tab or newline. */
  var files = [];
  (function walk(dir) {
    fs.readdirSync(path.join(ROOT, dir)).forEach(function (name) {
      if (name === 'node_modules' || name.charAt(0) === '.') return;
      var rel = dir ? dir + '/' + name : name;
      var st = fs.statSync(path.join(ROOT, rel));
      if (st.isDirectory()) { walk(rel); return; }
      if (/\.(js|css|html|xml)$/.test(name)) files.push(rel);
    });
  })('');

  /* The docs live a level up and are written by the same escape-prone tooling.
     The rule that caused this landed in the notes too, and went unnoticed
     because the sweep stopped at app/. */
  ['ARCHITECTURE.md'].forEach(function (rel) {
    if (fs.existsSync(path.join(ROOT, '..', rel))) files.push('../' + rel);
  });

  ok(files.length > 10, 'found the source files to check', files.length + ' files');

  var dirty = [];
  files.forEach(function (rel) {
    var text = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    for (var i = 0; i < text.length; i++) {
      var code = text.charCodeAt(i);
      if (code < 32 && code !== 9 && code !== 10 && code !== 13) {
        var line = text.slice(0, i).split('\n').length;
        dirty.push(rel + ':' + line + ' 0x' + code.toString(16));
        break;
      }
    }
  });
  eq(dirty, [], 'no control characters in any of them');

  /* The marker beside a replayable programme must not depend on a font having
     a clock in it — that is exactly how "B7" once appeared beside every one. */
  var css = fs.readFileSync(path.join(ROOT, 'css/style.css'), 'utf8');
  var block = css.slice(css.indexOf('.epg-replay{'));
  block = block.slice(0, block.indexOf('.epg-panel.active .epg-row.focused .epg-replay'));
  ok(/border-radius\s*:\s*50%/.test(block),
     'the replay marker is a drawn dial, not a printed character', block.trim().slice(0, 90));
  ok(/border-right\s*:\s*\d+px solid/.test(block), 'with an arrow head drawn from borders');
  ok(!/content\s*:\s*"[^"]+"/.test(block), 'and no glyph anywhere in it');

  var markup = fs.readFileSync(path.join(ROOT, 'js/views/channels.js'), 'utf8');
  ok(markup.indexOf('class="epg-replay"') > -1,
     'and the guide gives a replayable programme that element');
}

/* ---------- run ---------- */


/* ============================================================ */
/*  store: per-channel locks                                    */
/* ============================================================ */

/* The store is not in the shared context — it wants a localStorage — so it
   gets one of its own, over a plain object that a second instance can be
   handed to prove a lock outlives a restart. */
function storeCtx(mem) {
  const c = vm.createContext({ console, setTimeout, clearTimeout });
  c.window = c; c.self = c;
  c.document = {
    getElementById() { return null; },
    querySelector() { return null; },
    documentElement: { classList: { toggle() {} } },
    addEventListener() {}
  };
  c.localStorage = {
    getItem: k => (k in mem ? mem[k] : null),
    setItem: (k, v) => { mem[k] = String(v); },
    removeItem: k => { delete mem[k]; }
  };
  for (const f of ['js/util.js', 'js/store.js']) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), c, { filename: f });
  }
  c.U.DEBUG = false;
  c.Store.init();
  return c;
}

async function testLocks() {
  describe('store — locking one channel behind the PIN');

  const mem = {};
  let S = storeCtx(mem).Store;
  const ch = { key: 'ch2', name: 'Channel 2', group: 'News' };
  const adult = { key: 'xx1', name: 'Hustler TV', group: 'General' };

  eq(S.isLocked('p', 'ch2'), false, 'nothing is locked to begin with');
  eq(S.lockActive(), false, 'and with no PIN there is nothing to lock with');

  S.setLocked('p', 'ch2', true);
  eq(S.isLocked('p', 'ch2'), true, 'the lock is remembered');
  eq(S.lockedKeys('p'), ['ch2'], 'and listed');
  eq(S.needsPin('p', ch), false,
     'but a lock with no PIN asks for nothing: there would be no way back through it');

  S.set('settings.pin', '1234');
  eq(S.lockActive(), true, 'a PIN makes the lock a lock');
  eq(S.needsPin('p', ch), true, 'and the channel now asks for it');
  eq(S.needsPin('p', { key: 'ch3', name: 'Channel 3' }), false,
     'the one next to it does not');

  /* The two halves of parental control do different things on purpose. A
     locked channel stays in the list and says no; a whole adult category is
     not listed at all, because a locked row still tells a child it is there. */
  eq(S.isHiddenChannel('p', ch), false, 'a locked channel is not hidden, it is gated');
  eq(S.isHiddenChannel('p', adult), false,
     'an adult channel is not hidden while the adult filter is off');
  S.set('settings.parental', true);
  eq(S.isHiddenChannel('p', adult), true, 'and is once it is on');
  S.set('settings.parental', false);
  eq(S.needsPin('p', ch), true,
     'turning the adult guess off does not unlock what was locked by hand');

  /* Checking a PIN and getting past one are different acts: locking a channel
     proves who is asking without opening the session, or the channel just
     locked would play without a word. */
  eq(S.checkPin('9999'), false, 'a wrong PIN does not check out');
  eq(S.checkPin('1234'), true, 'the right one does');
  eq(S.sessionUnlocked(), false, 'and checking it opened nothing');
  eq(S.needsPin('p', ch), true, 'so the channel still asks');

  eq(S.unlock('9999'), false, 'a wrong PIN does not unlock either');
  eq(S.needsPin('p', ch), true, 'and nothing moved');
  eq(S.unlock('1234'), true, 'the right one unlocks');
  eq(S.sessionUnlocked(), true, 'for the session');
  eq(S.needsPin('p', ch), false, 'so it stops asking');
  S.relock();
  eq(S.needsPin('p', ch), true, 'and Lock now makes it ask again');

  /* A lock is worth nothing if it does not survive the app closing. */
  await new Promise(r => setTimeout(r, 400));     // the store's save is debounced
  const S2 = storeCtx(mem).Store;
  eq(S2.isLocked('p', 'ch2'), true, 'the lock is still there after a restart');
  eq(S2.sessionUnlocked(), false, 'while the unlock is not');
  eq(S2.needsPin('p', ch), true, 'so a fresh launch asks for the PIN');

  S2.setLocked('p', 'ch2', false);
  eq(S2.needsPin('p', ch), false, 'taking the lock off stops it asking');
  eq(S2.hasLocks('p'), false, 'and nothing is left locked');
}

async function testReminders() {
  describe('store — reminders');

  const mem = {};
  const S = storeCtx(mem).Store;
  const now = Date.now();
  const r = { chKey: 'ch1', chName: 'Channel 1', start: now + 60000, stop: now + 3600000,
              title: 'The Nine O\'Clock News' };

  eq(S.reminders('p'), [], 'nothing is set to begin with');
  eq(S.setReminder('p', r), true, 'setting one takes');
  eq(S.hasReminder('p', 'ch1', r.start), true, 'and it is found by channel and start time');
  eq(S.setReminder('p', r), false, 'setting the same one twice does nothing');
  eq(S.reminders('p').length, 1, 'so there is still only one');

  /* Identified by the start time, not by anything the guide handed us: a
     re-read of the XMLTV rebuilds every programme object it ever made. */
  eq(S.hasReminder('p', 'ch1', r.start + 1), false, 'a different start is a different programme');
  eq(S.hasReminder('p', 'ch2', r.start), false, 'and so is a different channel');

  eq(S.dueReminders('p', now), [], 'nothing is due before it starts');
  eq(S.dueReminders('p', r.start + 1000).length, 1, 'it is due once it has');
  eq(S.dueReminders('p', r.start + 4 * 60000).length, 1, 'and still is four minutes in');
  eq(S.reminders('p').length, 1, 'being due does not consume it — the caller decides');

  /* The TV was off, or the app was closed: a reminder for something that
     started an hour ago is an interruption, not a reminder. */
  eq(S.dueReminders('p', r.start + 3600000), [], 'an hour late, it is not due');
  eq(S.reminders('p').length, 0, 'and it has been dropped on the way past');

  S.setReminder('p', r);
  S.clearReminder('p', 'ch1', r.start);
  eq(S.hasReminder('p', 'ch1', r.start), false, 'clearing one removes it');

  S.setReminder('p', r);
  await new Promise(res => setTimeout(res, 400));      // the save is debounced
  const S2 = storeCtx(mem).Store;
  eq(S2.hasReminder('p', 'ch1', r.start), true, 'and a reminder outlives the app closing');
}

async function testCap() {
  describe('epg.parse — the per-channel cap keeps the present, not the past');

  /* A channel on five-minute slots over a long history: far more programmes
     than the cap allows, written oldest first the way XMLTV is. Keeping the
     first N and dropping the rest filled the whole allowance with history and
     left the channel with nothing on air and nothing next — a panel showing a
     column of finished programmes, which is what this is here to stop. */
  const now = Date.now();
  const xml = ['<tv>', '<channel id="c1"><display-name>Busy</display-name></channel>'];
  const slots = [];
  for (let m = -48 * 60; m < 6 * 60; m += 5) slots.push(m);   // -48h .. +6h, 5 min apart
  slots.forEach((m, i) => {
    xml.push('<programme start="' + xmlt(now + m * 60000) + '" stop="' +
             xmlt(now + (m + 5) * 60000) + '" channel="c1"><title>Slot ' + i +
             '</title></programme>');
  });
  xml.push('</tv>');

  const CAP = 60;
  const d = await EPG.parse(xml.join('\n'),
    { hoursAhead: 8, hoursBehind: 72, maxPerChannel: CAP });
  const arr = d.byChannel.c1;

  eq(arr.length, CAP, 'the cap is still a cap');
  ok(slots.length > CAP * 4, 'and the channel had far more than that',
     slots.length + ' programmes offered');

  const onAir = arr.filter(p => p.s <= now && now < p.e).length;
  const ahead = arr.filter(p => p.s > now).length;
  const behind = arr.filter(p => p.e <= now).length;
  eq(onAir, 1, 'what is on air survives the cap');
  ok(ahead > 0, 'and so does what is on next', ahead + ' still to come');
  ok(behind > 0, 'and history is kept too, for catch-up', behind + ' finished');
  ok(Math.abs(ahead - behind) <= 2,
     'the window it settles on is centred on now, not on either end',
     behind + ' behind, ' + ahead + ' ahead');
  ok(arr[arr.length - 1].s > now, 'the last one kept is in the future');
  ok(arr[0].s < now, 'and the first one kept is in the past');

  /* The window is what bounds it, not the file: nothing outside the window is
     kept whatever the cap allows. */
  ok(arr.every(p => p.e >= now - 72 * 3600000 && p.s <= now + 8 * 3600000),
     'everything kept is inside the window');

  /* An out-of-order file must not push a newer programme out for an older one. */
  const shuffled = ['<tv>', '<channel id="c2"><display-name>Odd</display-name></channel>'];
  const mins = [];
  for (let m = -600; m < 120; m += 10) mins.push(m);
  mins.reverse();                                   // newest first, oldest last
  mins.forEach((m, i) => {
    shuffled.push('<programme start="' + xmlt(now + m * 60000) + '" stop="' +
                  xmlt(now + (m + 10) * 60000) + '" channel="c2"><title>Odd ' + i +
                  '</title></programme>');
  });
  shuffled.push('</tv>');
  const d2 = await EPG.parse(shuffled.join('\n'),
    { hoursAhead: 8, hoursBehind: 72, maxPerChannel: 20 });
  const arr2 = d2.byChannel.c2;
  eq(arr2.length, 20, 'the cap holds on a file written the other way round');
  ok(arr2.some(p => p.s > now), 'and the future is still in it',
     JSON.stringify(arr2.slice(-2).map(p => Math.round((p.s - now) / 60000) + ' min')));
}

async function testCoverage() {
  describe('epg.coverage — why a channel has nothing on air');

  /* Four channels that look identical on screen and are not: one fine, one
     whose listings stop earlier today, one matched to a guide entry carrying
     no programmes, and one the guide never had. */
  const now = Date.now();
  const xml = ['<tv>'];
  ['fine', 'stops', 'bare'].forEach(id =>
    xml.push('<channel id="' + id + '"><display-name>' + id + '</display-name></channel>'));
  xml.push('<programme start="' + xmlt(now - 30 * 60000) + '" stop="' + xmlt(now + 30 * 60000) +
           '" channel="fine"><title>On now</title></programme>');
  xml.push('<programme start="' + xmlt(now + 30 * 60000) + '" stop="' + xmlt(now + 90 * 60000) +
           '" channel="fine"><title>Next</title></programme>');
  xml.push('<programme start="' + xmlt(now - 4 * H) + '" stop="' + xmlt(now - 3 * H) +
           '" channel="stops"><title>Hours ago</title></programme>');
  xml.push('<programme start="' + xmlt(now - 3 * H) + '" stop="' + xmlt(now - 2 * H) +
           '" channel="stops"><title>Last one</title></programme>');
  xml.push('</tv>');

  await EPG.parse(xml.join('\n'), { hoursAhead: 8, hoursBehind: 12 });

  const chans = [
    { name: 'fine',    tvgId: 'fine' },
    { name: 'stops',   tvgId: 'stops' },
    { name: 'bare',    tvgId: 'bare' },
    { name: 'Nowhere', tvgId: 'nope' }
  ];
  const cov = EPG.coverage(chans, now);

  eq(cov.live, 1, 'one channel has something on air');
  eq(cov.ended, 1, 'one has run out earlier today');
  eq(cov.unmatched, 1, 'one never matched the guide at all');
  /* "bare" is a <channel> the guide declares and never gives a programme for;
     it matches, so it is not unmatched, and it is not "ended" either. */
  ok(cov.empty + cov.unmatched === 2, 'and the two with no programmes are told apart',
     JSON.stringify({ empty: cov.empty, unmatched: cov.unmatched }));

  const stops = cov.worst.filter(w => w.name === 'stops')[0];
  ok(!!stops, 'the ones that are wrong are named', JSON.stringify(cov.worst.map(w => w.name)));
  eq(stops.state, 'ended', 'with what is wrong with them');
  eq(stops.kept, 2, 'and how much guide they do have');
  ok(Math.abs(stops.last - (now - 2 * H)) < 60000,
     'and when it stops, which is the number that answers the question',
     new Date(stops.last).toISOString());

  ok(cov.worst.every(w => w.state !== 'live'), 'nothing healthy is in the list');
}


async function testKeepOrder() {
  describe('epg.parse — a channel declared in the middle of its own programmes');

  /* Most XMLTV lists every <channel> first, but not all of it does: some
     generators write a channel's element next to its programmes. A channel
     whose id is not in the playlist is only recognised by its display-name,
     which means by its <channel> element — and keepFor caches its answers, so
     a "no" decided before that element arrived used to go on dropping every
     programme the channel had, for the rest of the file. Whole channels came
     out blank, and only on guides written that way round.

     What cannot be recovered is a programme already scanned past: this is a
     streaming parser and it does not go back. Buffering every programme for
     every unknown channel is exactly the cost the `wanted` filter exists to
     avoid — a provider guide carries ten times the channels of the package.
     So: everything from the declaration onwards is kept, and what came before
     it is lost. */
  const now = Date.now();
  const wanted = { ids: { 'ch-known': 1 }, keys: {} };
  wanted.keys[U.matchKey('Channel Nine')] = 1;

  const prog = (id, m, t) =>
    '<programme start="' + xmlt(now + m * 60000) + '" stop="' + xmlt(now + (m + 60) * 60000) +
    '" channel="' + id + '"><title>' + t + '</title></programme>';

  const xml = ['<tv>',
    prog('x9', -150, 'Before the declaration'),
    '<channel id="x9"><display-name>Channel Nine</display-name></channel>',
    prog('x9', -30, 'On now'),
    prog('x9', 30, 'Next'),
    prog('ch-known', -30, 'Known now'),
    '</tv>'];

  const d = await EPG.parse(xml.join('\n'), { hoursAhead: 8, hoursBehind: 4, wanted: wanted });

  eq((d.byChannel['ch-known'] || []).length, 1,
     'a channel matched by its id is kept whatever the order');
  eq((d.byChannel.x9 || []).length, 2,
     'and a name-matched one keeps everything from its declaration onwards');
  ok(!(d.byChannel.x9 || []).some(p => p.t === 'Before the declaration'),
     'what came before it is gone, which a streaming parser cannot help');

  const ch = { name: 'Channel Nine', tvgId: '' };
  eq(EPG.resolve(ch), 'x9', 'it resolves by name');
  const nn = EPG.nowNext(ch, now);
  ok(nn && nn.now && nn.now.t === 'On now', 'and has a programme on air',
     JSON.stringify(nn && nn.now));

  /* The usual order still works, and nothing is kept for a channel nobody
     asked for. */
  const xml2 = ['<tv>',
    '<channel id="x9"><display-name>Channel Nine</display-name></channel>',
    '<channel id="junk"><display-name>Some Other Thing</display-name></channel>',
    prog('x9', -30, 'On now'),
    prog('junk', -30, 'Not wanted'),
    '</tv>'];
  const d2 = await EPG.parse(xml2.join('\n'), { hoursAhead: 8, hoursBehind: 4, wanted: wanted });
  eq((d2.byChannel.x9 || []).length, 1, 'channels first still works');
  eq(d2.byChannel.junk, undefined, 'and a channel the playlist does not have is still skipped');
  ok(d2.skipped > 0, 'and counted as skipped', String(d2.skipped));
}
(async function () {
/* ---------- gzip ----------

   The guide arrives compressed and no Samsung TV before 2022 can unpack it
   itself, so inflate.js has to be exactly right: anything less than byte-exact
   is a guide full of mojibake or nothing at all. Checked against zlib, which
   is the definition of correct. */
async function testGzip() {
  describe('gzip: inflate.js against zlib');

  function roundTrip(buf, level) {
    const parts = [];
    const total = Inflate.gunzip(new Uint8Array(zlib.gzipSync(buf, { level })),
                                 c => parts.push(Buffer.from(c)));
    const out = Buffer.concat(parts);
    return { same: out.equals(buf), total, len: out.length };
  }

  const cases = {
    'an empty file': Buffer.from(''),
    'a single byte': Buffer.from('x'),
    'a line of XML': Buffer.from('<tv><programme start="20260827120000 +0000"/></tv>')
  };

  let rep = '';
  for (let i = 0; i < 20000; i++) rep += '<programme channel="ch' + (i % 50) + '">Repeat</programme>';
  cases['repetitive XML (long back-references)'] = Buffer.from(rep);

  const noise = Buffer.alloc(200000);
  for (let i = 0; i < noise.length; i++) noise[i] = (i * 2654435761) & 0xff;
  cases['data that does not compress (stored blocks)'] = noise;

  cases['Hebrew and Cyrillic'] = Buffer.from(
    '<tv>' + '<title>ערוץ 12 החדשות</title><title>9 Канал HD</title>'.repeat(3000) + '</tv>', 'utf8');

  for (const name of Object.keys(cases)) {
    let allOk = true, detail = '';
    for (const level of [0, 1, 6, 9]) {
      const r = roundTrip(cases[name], level);
      if (!r.same || r.total !== cases[name].length) {
        allOk = false;
        detail = 'level ' + level + ': ' + r.len + ' bytes, expected ' + cases[name].length;
      }
    }
    ok(allOk, name + ' survives a round trip at every level', detail);
  }

  /* The output is handed out a slab at a time and only the last 32 KB is kept
     as history, so the seams between slabs are where a back-reference would
     break. Sizes either side of both boundaries. */
  let seams = true, seamDetail = '';
  [32767, 32768, 32769, 1048575, 1048576, 1048577, 3000000].forEach(function (n) {
    const b = Buffer.alloc(n);
    for (let i = 0; i < n; i++) b[i] = 33 + ((i * 7) % 90);
    const r = roundTrip(b, 6);
    if (!r.same) { seams = false; seamDetail = n + ' bytes came back wrong'; }
  });
  ok(seams, 'and across every slab and window boundary', seamDetail);

  ok(Inflate.isGzip(new Uint8Array([0x1f, 0x8b, 8, 0])), 'gzip is recognised by its magic bytes');
  ok(!Inflate.isGzip(new Uint8Array([0x3c, 0x74, 0x76])), 'plain XML is not mistaken for it');

  let threw = '';
  try { Inflate.gunzip(new Uint8Array([0x1f, 0x8b, 8, 0, 1, 2, 3]), function () {}); }
  catch (e) { threw = e.message; }
  ok(threw.length > 0, 'a truncated file throws rather than returning nonsense', threw);
}

/* ---------- where the picture goes ----------

   On a TV the video is a plane behind the page, positioned by a rectangle, and
   the display method that was supposed to shape the picture inside that
   rectangle did different things on different sets: one would not scale a 720p
   stream up to a 1080p rect, another letterboxed against the whole screen and
   showed a crop in the preview. So the app shapes the picture itself, and this
   is the arithmetic that does it. It cannot be seen from a desktop, which is
   exactly why it is tested here. */
async function testPictureFit() {
  describe('fitting the picture into its box');

  const FULL = [0, 0, 1920, 1080];
  const PREVIEW = [880, 0, 1040, 585];
  const wide = 16 / 9, four3 = 4 / 3, ultra = 21 / 9;

  eq(Player.fitBox(FULL, wide, 'fit', true), [0, 0, 1920, 1080],
     '16:9 fills a 16:9 screen exactly');
  eq(Player.fitBox(PREVIEW, wide, 'fit', false), [880, 0, 1040, 585],
     'and fills the preview box exactly, which is the same shape');

  /* A 4:3 channel — plenty of them on any provider — must be pillarboxed, not
     stretched and not cropped. */
  const p43 = Player.fitBox(FULL, four3, 'fit', true);
  eq(p43, [240, 0, 1440, 1080], '4:3 is pillarboxed on a 16:9 screen');
  ok(p43[0] > 0 && p43[0] * 2 + p43[2] === 1920, 'with equal bars either side',
     JSON.stringify(p43));

  const pUltra = Player.fitBox(FULL, ultra, 'fit', true);
  eq(pUltra[1] > 0 && pUltra[3] < 1080, true, '21:9 is letterboxed instead');
  ok(pUltra[1] >= 0 && pUltra[1] + pUltra[3] <= 1080 &&
     Math.abs((1080 - pUltra[3] - pUltra[1]) - pUltra[1]) <= 1,
     'with even bars above and below, and never past the edge', JSON.stringify(pUltra));

  /* Stretch means exactly the box, however wrong that looks. */
  eq(Player.fitBox(FULL, four3, 'stretch', true), FULL, 'stretch takes the whole box');
  eq(Player.fitBox(PREVIEW, four3, 'stretch', false), PREVIEW, 'in the preview too');

  /* Fill crops, which is only safe where the overflow leaves the screen. */
  const fillFull = Player.fitBox(FULL, four3, 'fill', true);
  ok(fillFull[2] >= 1920 && fillFull[3] >= 1080,
     'fill covers the screen, overflowing it', JSON.stringify(fillFull));
  ok(fillFull[0] <= 0 && fillFull[1] <= 0, 'and is centred, so the overflow is even',
     JSON.stringify(fillFull));

  const fillPreview = Player.fitBox(PREVIEW, four3, 'fill', false);
  eq(fillPreview, Player.fitBox(PREVIEW, four3, 'fit', false),
     'but in the preview it fits instead: a crop there would spill over the list');

  /* Whatever the shape, the picture stays inside its box unless it is meant to
     crop, and it never changes shape. */
  [wide, four3, ultra, 1, 2.4].forEach(function (a) {
    const r = Player.fitBox(PREVIEW, a, 'fit', false);
    const inside = r[0] >= PREVIEW[0] && r[1] >= PREVIEW[1] &&
                   r[0] + r[2] <= PREVIEW[0] + PREVIEW[2] &&
                   r[1] + r[3] <= PREVIEW[1] + PREVIEW[3];
    const shape = Math.abs((r[2] / r[3]) - a) < 0.02;
    ok(inside && shape, 'aspect ' + a.toFixed(2) + ' fits inside the preview and keeps its shape',
       JSON.stringify(r));
  });

  eq(Player.fitBox(FULL, 0, 'fit', true), FULL,
     'an unknown source shape falls back to the whole box');
}

/* ---------- the guide as it arrives ----------

   A TV takes tens of seconds to read a provider guide. Publishing only at the
   end means a minute of "no guide for this channel"; publishing as it goes
   means a list that fills in. What must not differ is where it ends up. */
async function testProgressive() {
  describe('a guide that fills in while it loads');

  const now = Date.now();
  const parts = ['<tv>'];
  for (let i = 0; i < 40; i++) parts.push('<channel id="c' + i + '"><display-name>Ch ' + i + '</display-name></channel>');
  for (let i = 0; i < 40; i++) {
    for (let h = -3; h < 4; h++) {
      const s = now + h * 3600000;
      parts.push('<programme start="' + xmlt(s) + '" stop="' + xmlt(s + 3600000) +
                 '" channel="c' + i + '"><title>P ' + i + '.' + h + '</title></programme>');
    }
  }
  parts.push('</tv>');
  const xml = parts.join('\n');
  const opts = { hoursAhead: 4, hoursBehind: 4, maxPerChannel: 32 };

  const wholeGo = await EPG.parse(xml, opts);
  const expected = wholeGo.count;

  const seen = [];
  const st = EPG.stream({
    hoursAhead: 4, hoursBehind: 4, maxPerChannel: 32, publishEvery: 0,
    onPartial: function (d) { seen.push({ count: d.count, partial: d.partial }); }
  });
  const piece = Math.ceil(xml.length / 12);
  for (let i = 0; i < xml.length; i += piece) st.feed(xml.slice(i, i + piece));
  const final = st.finish();

  ok(seen.length >= 3, 'the guide is published several times while it reads',
     seen.length + ' partial publishes');
  ok(seen.every(function (s) { return s.partial; }), 'each one says it is still partial');
  ok(seen[0].count > 0 && seen[0].count < expected,
     'the first has some programmes but not all', JSON.stringify(seen[0]));

  let rising = true;
  for (let i = 1; i < seen.length; i++) if (seen[i].count < seen[i - 1].count) rising = false;
  ok(rising, 'and each publish has at least as many as the one before');

  eq(final.count, expected, 'and it ends up with exactly what one pass produces');
  ok(!final.partial, 'with the partial flag cleared at the end');

  /* Every channel's programmes must be in time order at every publish, not
     just at the end — the guide panel reads them straight out. */
  let sorted = true;
  Object.keys(final.byChannel).forEach(function (k) {
    const arr = final.byChannel[k];
    for (let i = 1; i < arr.length; i++) if (arr[i].s < arr[i - 1].s) sorted = false;
  });
  ok(sorted, 'and every channel is left in time order');

  /* A lookup made against a half-read guide must not be remembered once more
     of it has arrived. */
  const ch = { name: 'Ch 39', tvgId: 'c39' };
  const early = EPG.stream({ hoursAhead: 4, hoursBehind: 4, publishEvery: 0,
                             onPartial: function () {} });
  early.feed(xml.slice(0, Math.floor(xml.length / 3)));
  const before = EPG.resolve(ch);
  early.feed(xml.slice(Math.floor(xml.length / 3)));
  early.finish();
  const after = EPG.resolve(ch);
  ok(before === '' && after === 'c39',
     'a channel that had no match yet gets one when the rest arrives',
     JSON.stringify({ before: before, after: after }));
}

/* ---------- what a provider says about a programme ----------

   Only what the info bar can ever show, and only for the programmes it can
   ever show it for: descriptions are the biggest thing in an XMLTV file, and
   a seven-day window of them would cost more than the guide itself. */
async function testProgrammeExtras() {
  describe('what the guide says about a programme');

  const now = Date.now();
  const long = new Array(400).join('x');
  const xml = [
    '<tv>',
    '<channel id="c1"><display-name>One</display-name></channel>',
    '<programme start="' + xmlt(now - 600000) + '" stop="' + xmlt(now + 3000000) +
      '" channel="c1">' +
      '<title>The Lighthouse</title>' +
      '<desc>' + long + '</desc>' +
      '<category>Documentary</category>' +
      '<episode-num system="onscreen">S2 E4</episode-num>' +
      '<date>20190115</date>' +
      '<rating system="BBFC"><value>15</value></rating>' +
      '<star-rating><value>7.4/10</value></star-rating>' +
      '<credits><director>Ada Blake</director><actor>Tom Reed</actor>' +
        '<actor>Ivy Shaw</actor><actor>Someone Else</actor></credits>' +
      '</programme>',
    // Three days out: past the window where anything but the title is kept.
    '<programme start="' + xmlt(now + 3 * 86400000) + '" stop="' + xmlt(now + 3 * 86400000 + 3600000) +
      '" channel="c1"><title>Later</title><desc>' + long + '</desc>' +
      '<category>Film</category></programme>',
    '</tv>'
  ].join('\n');

  const d = await EPG.parse(xml, { hoursAhead: 96, hoursBehind: 4, maxPerChannel: 32 });
  const list = d.byChannel.c1;
  eq(list.length, 2, 'both programmes are kept');

  const p = list[0];
  eq(p.t, 'The Lighthouse', 'the title');
  ok(p.d.indexOf('x') === 0, 'and the description, which is what the bar shows');
  ok(p.d.length <= 260, 'trimmed to something readable at a distance',
     String(p.d.length));
  ok(/…$/.test(p.d), 'and saying that it was trimmed');

  /* Nothing shows a category, a rating or a cast list, so nothing keeps one:
     a guide that carries what no screen reads is memory a TV cannot spare. */
  eq(p.c, undefined, 'no category is kept');
  eq(p.r, undefined, 'no age rating');
  eq(p.sr, undefined, 'no star rating');
  eq(p.w, undefined, 'no cast list');

  const later = list[1];
  eq(later.t, 'Later', 'a programme days away still has its title');
  eq(later.d, undefined, 'but no description: nothing can show it from there');
}

/* ---------- what the guide costs ----------

   Both halves of this were regressions, found by driving the app rather than
   by a test, so they get one each: the guide once locked the screen for 41
   seconds on a 53 MB file, of which 40 were a quadratic scan and all 41 were
   spent without ever yielding to the event loop. */
async function testGuideCost() {
  describe('what reading a guide costs');

  /* A guide shaped like a real one: a handful of channels the playlist has,
     a thousand it does not, a week of programmes each. */
  const now = Date.now();
  const parts = ['<tv>'];
  for (let i = 0; i < 20; i++) parts.push('<channel id="g' + i + '"><display-name>Mine ' + i + '</display-name></channel>');
  for (let i = 0; i < 600; i++) parts.push('<channel id="x' + i + '"><display-name>Other ' + i + '</display-name></channel>');
  function progs(id) {
    for (let h = -48; h < 8; h++) {
      const s = now + h * 3600000;
      parts.push('<programme start="' + xmlt(s) + '" stop="' + xmlt(s + 3600000) +
                 '" channel="' + id + '"><title>Programme ' + id + ' ' + h + '</title>' +
                 '<desc>Padding so the file is a realistic size for ' + id + '</desc></programme>');
    }
  }
  for (let i = 0; i < 20; i++) progs('g' + i);
  for (let i = 0; i < 600; i++) progs('x' + i);
  parts.push('</tv>');
  const xml = parts.join('\n');

  const wanted = { ids: {}, keys: {} };
  for (let i = 0; i < 20; i++) wanted.ids['g' + i] = 1;
  const opts = { hoursAhead: 8, hoursBehind: 48, maxPerChannel: 200, wanted: wanted };

  const t0 = Date.now();
  const st = EPG.stream(opts);
  for (let i = 0; i < xml.length; i += 1 << 20) st.feed(xml.slice(i, i + (1 << 20)));
  const d = st.finish();
  const ms = Date.now() - t0;

  eq(d.count, 20 * 56, 'only the playlist\'s channels are kept');
  ok(d.skipped > 30000, 'and the rest are skipped', d.skipped + ' skipped');

  /* The quadratic version took about a second per megabyte here; this is
     comfortably above what a linear scan needs and far below that. */
  ok(ms < 4000, 'a ' + Math.round(xml.length / 1048576) + ' MB guide scans in well under four seconds',
     ms + ' ms');

  /* And the unpacking must hand the event loop back as it goes, or the screen
     is frozen for however long the guide takes. */
  const gz = new Uint8Array(zlib.gzipSync(Buffer.from(xml, 'utf8'), { level: 6 }));

  const syncParts = [];
  Inflate.gunzip(gz, c => syncParts.push(Buffer.from(c)));
  const asyncParts = [];
  let ticks = 0;
  const timer = setInterval(() => { ticks++; }, 4);
  await Inflate.gunzipAsync(gz, c => asyncParts.push(Buffer.from(c)), { sliceMs: 5 });
  clearInterval(timer);

  ok(Buffer.concat(asyncParts).equals(Buffer.concat(syncParts)),
     'unpacking in slices produces exactly the same bytes as in one go');
  ok(ticks > 0, 'and lets the event loop run while it does it', ticks + ' turns taken');
}

/* ---------- the guide, read in pieces ---------- */
async function testGuideStream() {
  describe('reading a guide in pieces');

  const now = Date.now();
  const xml = ['<?xml version="1.0" encoding="UTF-8"?>', '<tv>'];
  for (let i = 0; i < 60; i++) {
    xml.push('<channel id="c' + i + '"><display-name>ערוץ ' + i + '</display-name>' +
             '<display-name>Channel ' + i + '</display-name></channel>');
  }
  for (let i = 0; i < 60; i++) {
    for (let h = -2; h < 3; h++) {
      const s = now + h * 3600000;
      xml.push('<programme start="' + xmlt(s) + '" stop="' + xmlt(s + 3600000) +
               '" channel="c' + i + '"><title>Программа ' + i + '.' + h + '</title></programme>');
    }
  }
  xml.push('</tv>');
  const text = xml.join('\n');

  const opts = { hoursAhead: 4, hoursBehind: 4, maxPerChannel: 32 };
  const whole = await EPG.parse(text, opts);
  const expected = { count: whole.count, channels: Object.keys(whole.byChannel).length };

  /* Fed in pieces that deliberately cut through tags, attributes and
     multi-byte characters. If the carry-over is wrong the counts drop. */
  function feedInPieces(size) {
    const st = EPG.stream(opts);
    for (let i = 0; i < text.length; i += size) st.feed(text.slice(i, i + size));
    return st.finish();
  }

  [7, 64, 1000, 100000].forEach(function (size) {
    const d = feedInPieces(size);
    eq({ count: d.count, channels: Object.keys(d.byChannel).length }, expected,
       'the same guide arrives whole when fed ' + size + ' characters at a time');
  });

  const one = feedInPieces(1e9);
  eq(one.count, expected.count, 'and in a single piece');

  let missing = '';
  try { EPG.stream(opts).feed('<tv></tv>'), EPG.stream(opts).finish(); }
  catch (e) { missing = e.message; }
  ok(/XMLTV/.test(missing), 'a file with no programmes in it is rejected, not silently empty',
     missing);

  /* End to end: bytes off the wire, gzipped, through the inflater and the
     UTF-8 reader into the scanner. This is the path a TV takes. */
  describe('a gzipped guide off the wire');

  xhrBytes = new Uint8Array(zlib.gzipSync(Buffer.from(text, 'utf8'), { level: 6 }));
  xhrStatus = 200;
  const st = EPG.stream(opts);
  let pieces = 0;
  await Net.guide('http://example/guide.xml.gz', function (chunk) { pieces++; st.feed(chunk); });
  const streamed = st.finish();
  eq({ count: streamed.count, channels: Object.keys(streamed.byChannel).length }, expected,
     'a gzipped guide reads exactly as the plain one does');
  ok(pieces > 0, 'and arrived in pieces rather than as one string', pieces + ' pieces');

  const cyr = Object.keys(streamed.byChannel).map(k => streamed.byChannel[k][0].t)
    .filter(t => /Программа/.test(t)).length;
  ok(cyr > 0, 'with non-Latin titles intact through the chunk boundaries', cyr + ' of them');

  xhrBytes = new Uint8Array(Buffer.from(text, 'utf8'));
  const st2 = EPG.stream(opts);
  await Net.guide('http://example/guide.xml', function (chunk) { st2.feed(chunk); });
  eq(st2.finish().count, expected.count, 'an uncompressed guide takes the same path');

  xhrStatus = 404;
  let httpErr = '';
  await Net.guide('http://example/missing.xml', function () {}).catch(e => { httpErr = e.message; });
  ok(/404/.test(httpErr), 'and an HTTP error is reported rather than swallowed', httpErr);
  xhrStatus = 200;
}

  console.log('\nAquaPlay IPTV — parser tests');
  const t0 = Date.now();
  try {
    await testUtil();
    await testM3U();
    await testEPG();
    await testCatchup();
    await testSettings();
    await testAdult();
    await testSourceHygiene();
    await testGzip();
    await testGuideStream();
    await testGuideCost();
    await testProgrammeExtras();
    await testProgressive();
    await testPictureFit();
    await testLocks();
    await testReminders();
    await testCap();
    await testCoverage();
    await testKeepOrder();
  } catch (e) {
    fail++;
    failures.push('threw: ' + (e && e.stack || e));
    console.log('\n  !! ' + (e && e.stack || e));
  }
  const ms = Date.now() - t0;

  console.log('\n  ' + pass + ' passed, ' + fail + ' failed  (' + ms + ' ms)\n');
  if (failures.length) {
    console.log('  Failures:');
    failures.forEach(f => console.log('   - ' + f));
    console.log('');
  }
  process.exit(fail ? 1 : 0);
})();

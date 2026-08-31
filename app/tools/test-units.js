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
  querySelectorAll() { return []; },
  documentElement: { setAttribute() {}, classList: { toggle() {}, add() {} } },
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

for (const f of ['js/i18n.js', 'js/lang.js', 'js/util.js', 'js/inflate.js', 'js/net.js', 'js/m3u.js', 'js/epg.js',
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

  /* Same rule for the key chips: the bar draws the Enter key rather than
     printing a character for it, and it draws the one on the remote — a
     box with a return arrow, not a ring with a dot. */
  var okBlock = css.slice(css.indexOf('.k-ok{'));
  okBlock = okBlock.slice(0, okBlock.indexOf('}') + 1);
  ok(/mask-image\s*:\s*url\("data:image\/svg\+xml/.test(okBlock),
     'the OK chip is the remote Enter key, drawn', okBlock.trim().slice(0, 80));
  ok(okBlock.indexOf('%3Crect') > -1 && okBlock.indexOf('l2 2') > -1,
     'a box with a return arrow in it, which is what the remote prints');
  ok(/font-size\s*:\s*0/.test(okBlock),
     'and the word OK stays in the markup without being painted');
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

/* ============================================================ */
/*  store: channel numbers, and what counts as a change         */
/* ============================================================ */

async function testNumbers() {
  describe('store — a number put back to the one the playlist gave');

  const mem = {};
  const S = storeCtx(mem).Store;

  eq(S.channelNumber('p', 'ch1'), null, 'a channel starts on whatever the playlist said');

  S.setChannelNumber('p', 'ch1', 501, 12);
  eq(S.channelNumber('p', 'ch1'), 501, 'moving it is remembered');

  /* The reason this exists: typing the original number back is not a change,
     and leaving a record of it left the row amber for ever and gave Reset
     something to undo that would have undone nothing. */
  S.setChannelNumber('p', 'ch1', 12, 12);
  eq(S.channelNumber('p', 'ch1'), null,
     'and typing the number the playlist gave back in is not a change at all');

  /* Only when the caller knows what the playlist said. The numbers screen and
     the channel panel both do; anything that does not still gets a plain set. */
  S.setChannelNumber('p', 'ch2', 12);
  eq(S.channelNumber('p', 'ch2'), 12, 'without the original to compare, 12 is just a number');

  S.setChannelNumber('p', 'ch2', 0);
  eq(S.channelNumber('p', 'ch2'), null, 'and zero still clears it');

  /* Both places that paint a number amber ask what it is, not whether a
     record of it exists — so playlists numbered this way before today come
     out right too. */
  const src = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
  ok(src('js/views/channels.js').indexOf('over !== c.num') > -1,
     'the list only marks a number as changed when it differs from the playlist');
  ok(src('js/views/numbers.js').indexOf('custom !== c.num') > -1,
     'and so does the numbers screen');
}

/* ============================================================ */
/*  store: what a new install opens on                          */
/* ============================================================ */

async function testDefaults() {
  describe('store — the settings a new install starts with');

  const S = storeCtx({}).Store;
  const st = S.all().settings;

  /* Both of these are answers to "where am I": a list in the order the
     numbers on the remote expect, and a panel that opens on what is on now
     with the evening under it rather than the afternoon above it. */
  eq(st.sortBy, 'number', 'the list is in channel-number order');
  eq(st.guideView, 'ahead', 'and the guide panel opens with what is on at the top');
}

/* ============================================================ */
/*  the icons, and the four shapes Samsung asks for             */
/* ============================================================ */

/* Enough PNG to answer two questions: what shape is it, and is anything in it
   see-through. The header is thirteen bytes at a fixed offset; the pixels need
   the row filters undone, which is twenty lines and cheaper than a dependency. */
function readPNG(file, wantPixels) {
  const b = fs.readFileSync(file);
  const out = {
    w: b.readUInt32BE(16), h: b.readUInt32BE(20),
    depth: b[24], colour: b[25], kb: Math.round(b.length / 1024)
  };
  if (!wantPixels) return out;

  const parts = [];
  for (let p = 8; p + 8 <= b.length;) {
    const len = b.readUInt32BE(p), type = b.toString('ascii', p + 4, p + 8);
    if (type === 'IDAT') parts.push(b.slice(p + 8, p + 8 + len));
    p += len + 12;
  }
  const raw = zlib.inflateSync(Buffer.concat(parts));
  const bpp = out.colour === 6 ? 4 : 3, stride = out.w * bpp;
  const px = Buffer.alloc(out.h * stride);
  for (let y = 0; y < out.h; y++) {
    const f = raw[y * (stride + 1)];
    for (let x = 0; x < stride; x++) {
      const v = raw[y * (stride + 1) + 1 + x];
      const a = x >= bpp ? px[y * stride + x - bpp] : 0;
      const up = y > 0 ? px[(y - 1) * stride + x] : 0;
      const c = (x >= bpp && y > 0) ? px[(y - 1) * stride + x - bpp] : 0;
      let add = 0;
      if (f === 1) add = a;
      else if (f === 2) add = up;
      else if (f === 3) add = (a + up) >> 1;
      else if (f === 4) {
        const p2 = a + up - c, pa = Math.abs(p2 - a), pb = Math.abs(p2 - up), pc = Math.abs(p2 - c);
        add = (pa <= pb && pa <= pc) ? a : (pb <= pc ? up : c);
      }
      px[y * stride + x] = (v + add) & 0xFF;
    }
  }
  out.at = function (x, y) {
    const i = y * stride + x * bpp;
    return [px[i], px[i + 1], px[i + 2], bpp === 4 ? px[i + 3] : 255];
  };
  return out;
}

async function testIcons() {
  describe('the icon set — the four shapes Samsung asks for');

  const REPO = path.resolve(ROOT, '..');
  const set = {
    icon: path.join(ROOT, 'icon.png'),
    testing: path.join(REPO, 'branding/store-logo-512x423.png'),
    back: path.join(REPO, 'branding/banner-background-1920x1080.png'),
    logo: path.join(REPO, 'branding/banner-logo-1920x1080.png')
  };
  for (const k of Object.keys(set)) {
    if (!fs.existsSync(set[k])) { ok(false, 'the ' + k + ' icon exists', set[k]); return; }
  }

  /* A TV tile is wider than it is tall. A square icon is not "close enough":
     the launcher letterboxes it, which is what this build shipped until the
     shapes were checked against the guidelines. */
  const icon = readPNG(set.icon);
  /* Square, and one of them. The shape has been 512x512, 512x423 and 16:9,
     and a pair declared with width and height attributes the way another
     side-loaded package declares them — which is the arrangement that does
     get a wide tile somewhere, but not on the set this is built for. The
     tile never changed. So: one square icon, and the shape is not a knob.

     512 and not the 117x117 the guidelines name: that one is the size a
     local install wants on hand, and shipping only it left the set scaling
     a 117px square up wherever it drew the icon larger. It came back
     looking exactly as rough as that sounds. */
  eq([icon.w, icon.h], [512, 512], 'the packaged icon is 512 square');
  ok(icon.w === icon.h,
     'square, so the set has nothing to stretch out of shape',
     icon.w + 'x' + icon.h);

  /* The wordmark's two lines are centred on each other, not merely inside
     the same box.

     "AQUA" sat dead centre and "PLAY >" sat 22px to the right of it, because
     the play triangle extends the lower line and nothing put it back. The
     bounding box of the two together was centred, so measuring the whole
     mark said it was fine while looking at it said otherwise — which is
     exactly how it was reported. */
  const mark = readPNG(path.join(REPO, 'app/img/logo.png'), true);
  /* readPNG hands back an at(x,y) rather than a raw buffer; the fourth
     channel is the alpha, and 255 where the file has none. */
  const inkAt = (x, y) => mark.at(x, y)[3];
  const rowHasInk = [];
  for (let y = 0; y < mark.h; y++) {
    let any = false;
    for (let x = 0; x < mark.w && !any; x++) if (inkAt(x, y) > 24) any = true;
    rowHasInk.push(any);
  }
  const bands = [];
  let from = -1;
  for (let y = 0; y < mark.h; y++) {
    if (rowHasInk[y] && from < 0) from = y;
    else if (!rowHasInk[y] && from >= 0) { bands.push([from, y]); from = -1; }
  }
  if (from >= 0) bands.push([from, mark.h]);
  const centres = bands.map(([y0, y1]) => {
    let x0 = mark.w, x1 = -1;
    for (let y = y0; y < y1; y++) {
      for (let x = 0; x < mark.w; x++) {
        if (inkAt(x, y) > 24) { if (x < x0) x0 = x; if (x > x1) x1 = x; }
      }
    }
    return (x0 + x1) / 2;
  });
  ok(bands.length >= 2, 'the wordmark is more than one line', String(bands.length));
  const worst = Math.max.apply(null, centres.map(c => Math.abs(c - (mark.w - 1) / 2)));
  ok(worst <= 2,
     'and every line of it is centred on the same axis',
     'worst line is ' + worst.toFixed(1) + 'px off centre: ' +
     centres.map(c => c.toFixed(1)).join(', '));
  ok(fs.statSync(set.icon).size < 300 * 1024,
     'and still inside the 300 KB a Samsung package allows',
     Math.round(fs.statSync(set.icon).size / 1024) + ' KB');

  /* An Android TV banner in plain drawable/ is the mdpi bucket, and a 1080p
     set is xhdpi — so one 320x180 file arrives on the home screen scaled up
     by two, which is what "the icon is low quality" turned out to mean. */
  const banners = ['drawable', 'drawable-xhdpi', 'drawable-xxhdpi'].map(function (d) {
    return path.join(REPO, 'android/app/src/main/res', d, 'banner.png');
  });
  ok(banners.every(function (b) { return fs.existsSync(b); }),
     'the TV banner is drawn for the densities a television runs at',
     'drawable/ alone is mdpi, and a 1080p set is xhdpi');
  const xhdpi = readPNG(banners[1]);
  eq([xhdpi.w, xhdpi.h], [640, 360], 'the xhdpi banner is twice the base one');
  eq(icon.depth, 8, 'eight bits a sample');
  eq(icon.colour, 2, 'and no alpha channel: the guideline asks for 24-bit');
  ok(icon.kb < 300, 'under the 300 KB limit', icon.kb + ' KB');

  const small = readPNG(set.testing);
  eq([small.w, small.h], [512, 423], 'the store logo is 512 x 423, the shape of a listing tile');
  eq(small.colour, 2, 'also 24-bit');

  const back = readPNG(set.back);
  eq([back.w, back.h], [1920, 1080], 'the large logo background is 1920 x 1080');
  eq(back.colour, 2, 'opaque, because it is the thing underneath');
  ok(back.kb < 300, 'and well under the limit', back.kb + ' KB');

  /* The other half of the large logo. It goes over the background, so if it
     were a picture of the wordmark on its own grey it would sit there as a
     rectangle with a visible edge — the whole point is that it is a cut-out. */
  const logo = readPNG(set.logo, true);
  eq([logo.w, logo.h], [1920, 1080], 'the wordmark half is the same 1920 x 1080');
  eq(logo.colour, 6, 'with an alpha channel');
  ok(logo.kb < 300, 'and under the limit too', logo.kb + ' KB');
  eq(logo.at(4, 4)[3], 0, 'its corner is transparent, not grey');
  eq(logo.at(960, 4)[3], 0, 'and so is the space above the wordmark');

  /* Between the two ways this can go wrong: nothing came through the key, or
     the key did nothing and the whole frame is a grey rectangle. A wordmark
     on transparency is a few per cent of a 1920 x 1080 sheet, and the letters
     that are in it are solid rather than a ghost of themselves. */
  let ink = 0, solid = 0, bx0 = logo.w, bx1 = -1, by0 = logo.h, by1 = -1;
  for (let y = 0; y < logo.h; y += 2) {
    for (let x = 0; x < logo.w; x += 2) {
      const a = logo.at(x, y)[3];
      if (a > 8) {
        ink++;
        if (x < bx0) bx0 = x; if (x > bx1) bx1 = x;
        if (y < by0) by0 = y; if (y > by1) by1 = y;
      }
      if (a > 200) solid++;
    }
  }
  const covered = ink / ((logo.w / 2) * (logo.h / 2));
  ok(covered > 0.01 && covered < 0.25, 'what came through is a wordmark, not a rectangle',
     Math.round(covered * 1000) / 10 + '% of the frame');
  ok(solid > ink * 0.5, 'and it is solid rather than a ghost',
     solid + ' of ' + ink + ' opaque');

  /* Not up against the edge of the frame: Seller Office puts this on a tile
     with rounded corners and padding of its own. */
  ok(bx0 > logo.w * 0.15 && bx1 < logo.w * 0.85, 'with a margin left and right',
     bx0 + '..' + bx1 + ' of ' + logo.w);
  ok(by0 > logo.h * 0.15 && by1 < logo.h * 0.85, 'and above and below',
     by0 + '..' + by1 + ' of ' + logo.h);

  /* How much of the tile the wordmark actually covers.

     This is the one somebody complained about: it read as small in the TV's
     menu, and the measurement said why — the mark was 86% of the width and
     34% of the height, because the tile was a *crop* of the artwork and a
     crop cannot make the mark any bigger than it already was in the square
     it came from. Composed instead, the share is a number somebody chose.

     The height is not asserted. The wordmark is 3.1:1 and the tile is
     square, so a mark that fills the width is 31% of the height and no
     amount of wanting will move it — the empty band above and below is the
     shape of the artwork, not a mistake in the build. */
  const tile = readPNG(set.icon, true);
  let tx0 = tile.w, tx1 = -1;
  for (let x = 0; x < tile.w; x++) {
    for (let y = 0; y < tile.h; y += 2) {
      const p = tile.at(x, y);
      if (0.2126 * p[0] + 0.7152 * p[1] + 0.0722 * p[2] > 90) {
        if (x < tx0) tx0 = x;
        if (x > tx1) tx1 = x;
        break;
      }
    }
  }
  const across = (tx1 - tx0 + 1) / tile.w;
  ok(across > 0.85, 'the wordmark fills the width of the application icon',
     Math.round(across * 100) + '% of ' + tile.w + 'px');
  ok(across < 0.99, 'without running into the edge of it',
     Math.round(across * 100) + '%');

  /* An adaptive icon, or API 26 and up shrink the legacy PNG into a mask of
     their own making and the icon arrives at the launcher smaller again —
     which is the other half of the same complaint. */
  const adaptive = path.join(REPO, 'android/app/src/main/res/mipmap-anydpi-v26/ic_launcher.xml');
  ok(fs.existsSync(adaptive), 'Android gets a real adaptive icon');
  if (fs.existsSync(adaptive)) {
    const xml = fs.readFileSync(adaptive, 'utf8');
    ok(xml.indexOf('<adaptive-icon') > -1, 'declared as one');
    ok(xml.indexOf('@mipmap/ic_foreground') > -1, 'with the wordmark as its foreground');
    ok(xml.indexOf('@color/ic_launcher_background') > -1,
       'and a flat colour behind it, not a second picture');
  }

  /* The foreground is drawn on 108dp of canvas of which only the middle 72
     survives the mask, so it has to be bigger than the legacy icon and it has
     to be see-through. */
  const fg = path.join(REPO, 'android/app/src/main/res/mipmap-xxhdpi/ic_foreground.png');
  if (fs.existsSync(fg)) {
    const f = readPNG(fg, true);
    eq([f.w, f.h], [324, 324], 'the foreground is 2.25x the legacy icon');
    eq(f.colour, 6, 'and has an alpha channel');
    eq(f.at(4, 4)[3], 0, 'its corner is transparent, so the colour shows through');
    /* Inside the safe zone: anything outside the middle 72 of 108 may be
       cropped by whatever shape the launcher feels like using. */
    let fx0 = f.w;
    for (let x = 0; x < f.w; x++) {
      let hit = false;
      for (let y = 0; y < f.h; y += 2) if (f.at(x, y)[3] > 40) { hit = true; break; }
      if (hit) { fx0 = x; break; }
    }
    ok(fx0 > f.w * 0.16, 'and the mark sits inside the mask-safe middle',
       fx0 + 'px in of ' + f.w);
  }

  /* The package points at the one that goes in it, and only that one. */
  const cfg = fs.readFileSync(path.join(ROOT, 'config.xml'), 'utf8');
  ok(cfg.indexOf('<icon src="icon.png"/>') > -1, 'config.xml names the application icon');

  /* pack.js stages by name, so a file config.xml points at and pack.js has
     never heard of is a broken package that builds cleanly. */
  const packSrc = fs.readFileSync(path.join(ROOT, 'tools/pack.js'), 'utf8');
  (cfg.match(/<icon src="([^"]+)"/g) || []).forEach(function (tag) {
    const name = tag.match(/src="([^"]+)"/)[1];
    ok(packSrc.indexOf("'" + name + "'") > -1,
       'and pack.js puts ' + name + ' in the package');
  });

  /* The page shows which build it is, in the drawer's foot, and it has to
     get that from somewhere: the Android package does not carry config.xml,
     so app.js keeps a constant. Two places to bump is one place to forget —
     unless something checks, which is this. */
  const cfgVersion = (cfg.slice(cfg.indexOf('<widget'))
    .match(/version="([0-9.]+)"/) || [, ''])[1];
  const appVersion = (fs.readFileSync(path.join(ROOT, 'js/app.js'), 'utf8')
    .match(/A\.version\s*=\s*'([0-9.]+)'/) || [, ''])[1];
  ok(cfgVersion.length > 0, 'config.xml carries a version', cfgVersion);
  eq(appVersion, cfgVersion,
     'and the version the app shows is that one');

  /* And nowhere else. The settings screen had its own copy typed out by
     hand and it had been wrong for ten releases — a version row is not read
     often enough for anybody to notice it lying, which is the whole reason
     it must not be written twice. */
  /* A quoted string that is nothing but a version is one on its way to a
     screen. Prose about 0.7.16 in a comment is history, not a second copy,
     and app.js is where the one copy lives. */
  const strays = ['js/views/settings.js', 'js/views/channels.js',
                  'js/views/setup.js', 'index.html']
    .map(f => ({ f, hits: (fs.readFileSync(path.join(ROOT, f), 'utf8')
      .match(/['"]v?\d+\.\d+\.\d+['"]/g) || []) }))
    .filter(x => x.hits.length);
  eq(strays.map(x => x.f + ': ' + x.hits.join(',')), [],
     'no screen writes out a version number of its own');

  /* Menu icons are class names, not characters.

     The renderer builds `ico-<name>` from whatever the row carries, so an
     emoji there produces a class that matches no rule — and because the
     element already has a background colour and gets its shape from a mask,
     what appears is a solid 30px block. One row kept its emoji through the
     changeover because it was written as a ternary rather than a literal,
     and it shipped as a coloured square. */
  const iconSrc = ['js/views/channels.js', 'js/views/catalog.js',
                   'js/views/replay.js', 'js/views/series.js']
    .filter(f => fs.existsSync(path.join(ROOT, f)))
    .map(f => ({ f, text: fs.readFileSync(path.join(ROOT, f), 'utf8') }));
  const badIcons = [];
  iconSrc.forEach(({ f, text }) => {
    const re = /icon:\s*([^,\n]+)/g;
    let m;
    while ((m = re.exec(text))) {
      /* Anything outside plain ASCII in an icon value is a character being
         used where a name belongs. */
      if (/[^\x00-\x7F]/.test(m[1])) badIcons.push(f + ': ' + m[1].trim());
    }
  });
  eq(badIcons, [], 'every menu icon is a name, not a character');

  /* And every name used is one the stylesheet actually draws. */
  const cssIcons = (fs.readFileSync(path.join(ROOT, 'css/style.css'), 'utf8')
    .match(/\.ico-([a-z]+)\{/g) || []).map(x => x.slice(5, -1));
  const used = [];
  iconSrc.forEach(({ text }) => {
    const re = /icon:\s*(?:[a-zA-Z]+\s*\?\s*)?'([a-z]+)'(?:\s*:\s*'([a-z]+)')?/g;
    let m;
    while ((m = re.exec(text))) { used.push(m[1]); if (m[2]) used.push(m[2]); }
  });
  eq(used.filter(n => cssIcons.indexOf(n) === -1), [],
     'and one the stylesheet draws');
  const pack = fs.readFileSync(path.join(ROOT, 'tools/pack.js'), 'utf8');
  ok(pack.indexOf("'icon.png'") > -1, 'and the packer stages it');
  ok(pack.indexOf('branding') === -1,
     'the store artwork is not in the .wgt: it is for the submission form, not the TV');
}

/* ============================================================ */
/*  Android TV: the shell's half of the bargain                 */
/* ============================================================ */

/* A context with the shell's bridge already in it, the way the real one is:
   MainActivity calls addJavascriptInterface before the first script runs, so
   util.js has an answer by the time anything asks. Everything the page can
   say to the shell is recorded here, which is the only way to test a native
   player without a television. */
function androidCtx(opts) {
  opts = opts || {};
  const calls = [];
  const c = vm.createContext({ console, setTimeout, clearTimeout, setInterval, clearInterval });
  c.window = c; c.self = c;
  c.document = {
    getElementById() { return null; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    documentElement: { setAttribute() {}, classList: { toggle() {}, add() {} }, lang: '' },
    addEventListener() {}
  };
  c.navigator = { userAgent: 'node' };
  c.XMLHttpRequest = function () { this.open = function () {}; this.send = function () {}; };
  c.Store = { settings: function () { return { bufferSize: opts.buffer || 'auto' }; } };

  const state = {
    size: opts.videoSize || '',
    duration: opts.duration === undefined ? 0 : opts.duration,
    position: opts.position || 0,
    playing: !!opts.playing
  };

  c.AquaPlayNative = {
    shellVersion: function () { calls.push(['shellVersion']); return '1'; },
    play: function (url, mode) { calls.push(['play', url, mode]); },
    stop: function () { calls.push(['stop']); },
    seekTo: function (ms) { calls.push(['seekTo', ms]); },
    setRect: function (x, y, w, h, vw, vh) {
      calls.push(['setRect', x, y, w, h, vw, vh]);
    },
    setBuffer: function (p, r) { calls.push(['setBuffer', p, r]); },
    isPlaying: function () { return state.playing; },
    positionMs: function () { return state.position; },
    durationMs: function () { return state.duration; },
    videoSize: function () { return state.size; },
    state: function () { return 'playing'; },
    lastError: function () { return ''; },
    exitApp: function () { calls.push(['exitApp']); }
  };

  /* The page draws in a fixed 1920x1080; a real TV window is the same size,
     which is the case where the scale is 1 and the rect arithmetic is
     readable. The scaled case has a test of its own below. */
  c.innerWidth = opts.innerWidth || 1920;
  c.innerHeight = opts.innerHeight || 1080;
  c.devicePixelRatio = opts.dpr || 1;

  for (const f of ['js/i18n.js', 'js/lang.js', 'js/util.js', 'js/inflate.js', 'js/net.js',
                   'js/catchup.js', 'js/keys.js', 'js/player.js']) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), c, { filename: f });
  }
  c.U.DEBUG = false;
  c.calls = calls;
  c.fake = state;
  c.took = function (name) { return calls.filter(function (k) { return k[0] === name; }); };
  c.last = function (name) { const m = c.took(name); return m[m.length - 1]; };
  return c;
}

async function testAndroidPlatform() {
  describe('Android TV — which platform the app thinks it is on');

  const a = androidCtx();
  eq(a.U.isAndroid, true, 'the bridge is what identifies the platform');
  eq(a.U.isTizen, false, 'and it is not mistaken for the other TV');
  eq(a.U.isTV, true, 'both of them are a TV');
  eq(a.U.platform, 'android', 'which is also available by name');

  /* The proxy is a desktop crutch. On Tizen config.xml lifts CORS; on Android
     the shell answers the request itself. Sending either one through a proxy
     that is not running would be a playlist that never loads. */
  eq(a.Net.useProxy, false, 'so nothing is proxied');
  eq(a.Net.wrap('http://p.tv/get.php'), 'http://p.tv/get.php', 'a request goes out as itself');
  eq(a.Net.media('http://p.tv/s.ts'), 'http://p.tv/s.ts', 'and so does a stream');

  /* The browser is still the browser. */
  eq(U.isAndroid, false, 'a desktop browser is not Android');
  eq(U.isTV, false, 'nor a TV');
  eq(U.platform, 'browser', 'and says so');
  eq(Net.useProxy, true, 'which is why it still needs the proxy');
}

async function testAndroidPlayer() {
  describe('Android TV — the player behind the page');

  const a = androidCtx({ videoSize: '1920x1080' });
  const P = a.Player;
  eq(P.isAndroid, true, 'player.js takes the same view');
  eq(P.isNative, true, 'and knows there is a decoder of its own behind the page');

  P.init();
  P.play('http://p.tv/live/1.ts', 'full');

  /* Order matters. A rectangle set after the stream has started is a picture
     that appears in the wrong place first, which is what the Tizen path spent
     two rounds learning. */
  const order = a.calls.map(function (k) { return k[0]; });
  ok(order.indexOf('setRect') < order.indexOf('play'),
     'the picture is placed before the stream is opened', JSON.stringify(order));
  eq(a.last('play'), ['play', 'http://p.tv/live/1.ts', 'full'], 'and then it is opened');

  /* The buffer numbers are the same trade as Tizen's: the first is what a
     channel costs to open, the second what it costs to recover from a stall,
     and only the second is generous. */
  eq(a.last('setBuffer'), ['setBuffer', 2000, 4000], 'with the default buffering');
  const small = androidCtx({ buffer: 'small', videoSize: '1920x1080' });
  small.Player.init();
  small.Player.play('http://p.tv/2.ts', 'full');
  eq(small.last('setBuffer'), ['setBuffer', 1000, 3000], 'a small buffer opens quicker');
  const large = androidCtx({ buffer: 'large', videoSize: '1920x1080' });
  large.Player.init();
  large.Player.play('http://p.tv/3.ts', 'full');
  eq(large.last('setBuffer'), ['setBuffer', 5000, 8000], 'and a large one holds more back');

  P.stop();
  eq(a.last('stop'), ['stop'], 'stopping stops it');
}

async function testAndroidRect() {
  describe('Android TV — the app shapes the picture, the shell only places it');

  /* The whole arrangement rests on this. ExoPlayer is told to fill a
     rectangle exactly, so the rectangle has to arrive with the letterboxing
     already in it — a 4:3 channel on a 16:9 screen is bars either side
     because the app put them there, not because the platform was asked to. */
  const a = androidCtx({ videoSize: '1440x1080' });     // 4:3
  a.Player.init();
  a.Player.play('http://p.tv/4x3.ts', 'full');
  eq(a.last('setRect'), ['setRect', 240, 0, 1440, 1080, 1920, 1080],
     'a 4:3 stream fullscreen is pillarboxed by the app');

  const wide = androidCtx({ videoSize: '1920x1080' });
  wide.Player.init();
  wide.Player.play('http://p.tv/16x9.ts', 'full');
  eq(wide.last('setRect'), ['setRect', 0, 0, 1920, 1080, 1920, 1080],
     'a 16:9 one fills the screen');

  /* The preview box is the one in the CSS, and the same arithmetic applies. */
  const prev = androidCtx({ videoSize: '1920x1080' });
  prev.Player.init();
  prev.Player.play('http://p.tv/16x9.ts', 'preview');
  eq(prev.last('setRect'), ['setRect', 880, 0, 1040, 585, 1920, 1080],
     'and the preview lands on the frame the CSS drew');

  /* A window that is not 1920x1080 — the surface is placed in the window's
     own pixels while the app draws in a fixed 1920x1080 that is scaled to
     fit, and they only agree when the scale is 1. */
  const half = androidCtx({ videoSize: '1920x1080', innerWidth: 960, innerHeight: 540 });
  half.Player.init();
  half.Player.play('http://p.tv/16x9.ts', 'full');
  eq(half.last('setRect'), ['setRect', 0, 0, 960, 540, 960, 540],
     'a half-size window gets a half-size rectangle, and says what it is of');

  /* And the part that was got wrong on a real television.

     A CSS pixel is not a device pixel on Android, and nothing reliably says
     what it is: the set this was tested on reports a 1920 viewport and a
     device pixel ratio of 2, while that 1920 covers a 1920 pixel panel
     exactly — the WebView folds its page scale in and still reports the
     density. Converting by that ratio drew the picture at twice the size in
     the corner of the screen.

     So the page converts nothing. It sends its own numbers and the viewport
     they are measured against, and the shell — which is the only thing that
     knows how many real pixels its view is — does the division. These
     assert that contract: whatever the ratio claims, the rect and the
     viewport are in the same units as each other. */
  [1, 2, 4].forEach(function (ratio) {
    const c = androidCtx({
      videoSize: '1920x1080', innerWidth: 960, innerHeight: 540, dpr: ratio
    });
    c.Player.init();
    c.Player.play('http://p.tv/16x9.ts', 'full');
    eq(c.last('setRect'), ['setRect', 0, 0, 960, 540, 960, 540],
       'the rect is the page\'s own pixels whatever devicePixelRatio says (' +
       ratio + 'x)');
  });

  /* The shape still comes from the app, in whatever those pixels are. */
  const pillar = androidCtx({ videoSize: '1440x1080', innerWidth: 960, innerHeight: 540, dpr: 2 });
  pillar.Player.init();
  pillar.Player.play('http://p.tv/4x3.ts', 'full');
  eq(pillar.last('setRect'), ['setRect', 120, 0, 720, 540, 960, 540],
     'a 4:3 stream is still pillarboxed by the app');
}

async function testAndroidState() {
  describe('Android TV — what the page can ask the shell');

  /* Live has no duration, and player.js turns "has a duration" into "can be
     sought". ExoPlayer says TIME_UNSET for a live stream, which is a large
     negative number and would otherwise sail through as truthy. */
  const live = androidCtx({ duration: -9223372036854775807 });
  live.Player.init();
  eq(live.Player.duration(), 0, 'a live stream has no duration');
  eq(live.Player.seekable(), false, 'so it cannot be sought');

  const film = androidCtx({ duration: 5400000, position: 60000 });
  film.Player.init();
  eq(film.Player.duration(), 5400000, 'a recording has one');
  eq(film.Player.seekable(), true, 'and can be moved through');
  eq(film.Player.position(), 60000, 'position comes back in milliseconds');
  eq(film.Player.elapsed(), 60, 'and elapsed in seconds, which is what the drift watch reads');

  /* Seeking past the end is how a player ends up sitting on a black frame it
     will not leave. Two seconds short of it, the same as everywhere else. */
  eq(film.Player.seekTo(5400000), 5398000, 'a seek to the very end stops short of it');
  eq(film.last('seekTo'), ['seekTo', 5398000], 'and the shell is told where it actually went');
  eq(film.Player.seekTo(-5000), 0, 'and a seek before the start is the start');

  const playing = androidCtx({ playing: true });
  playing.Player.init();
  eq(playing.Player.isPlaying(), true, 'whether it is playing is the shell to answer');
  eq(androidCtx().Player.isPlaying(), false, 'and it says so when it is not');
}

async function testAndroidEvents() {
  describe('Android TV — the shell reporting back');

  /* The shell names its events the way AVPlay names them, so both TV paths
     report the same things and nothing upstairs can tell them apart. This is
     the door they come through. */
  const a = androidCtx({ videoSize: '1920x1080' });
  const seen = [];
  a.Player.init();
  a.Player.on({
    onPlaying: function () { seen.push(['playing']); },
    onBuffering: function (on, pct) { seen.push(['buffering', on, pct]); },
    onError: function (m) { seen.push(['error', m]); },
    onTime: function (t) { seen.push(['time', t]); }
  });

  ok(typeof a.AquaPlayShell.player === 'function',
     'init leaves the shell somewhere to deliver events');

  a.AquaPlayShell.player('buffering', '40');
  eq(seen.pop(), ['buffering', true, 40], 'buffering, with how far along it is');

  a.AquaPlayShell.player('buffered', '');
  eq(seen.pop(), ['buffering', false, undefined], 'and buffered again');

  a.AquaPlayShell.player('playing', '');
  eq(seen.pop(), ['playing'], 'playing');

  a.AquaPlayShell.player('time', '61000');
  eq(seen.pop(), ['time', 61000], 'the clock, as a number rather than the string it arrived as');

  a.AquaPlayShell.player('error', 'Cannot reach the stream server');
  eq(seen.pop(), ['error', 'Cannot reach the stream server'], 'and what went wrong, in words');
  eq(a.Player.lastError, 'Cannot reach the stream server', 'kept for the diagnostics screen');

  /* Called from Java through evaluateJavascript, where a throw goes nowhere.
     An event nobody handles must not become a silent broken bridge. */
  a.Player.on(null);
  a.AquaPlayShell.player('error', 'no handler for this');
  a.AquaPlayShell.player('nonsense', '');
  ok(true, 'an unhandled event does not throw back into Java');
}

async function testAndroidKeys() {
  describe('Android TV — the keys the page never sees');

  /* Android takes BACK, the media transport and the coloured buttons before
     the WebView gets them, so the shell translates those and injects them at
     the same door every other key comes through. */
  const a = androidCtx();
  const seen = [];
  a.Keys.setHandler(function (e) { seen.push([e.action, e.digit]); });
  a.Keys.init();

  ok(typeof a.AquaPlayShell.key === 'function', 'init leaves the shell a way in');

  a.AquaPlayShell.key('back', 0);
  eq(seen.pop(), ['back', 0], 'back arrives as an action, not as a keycode');
  a.AquaPlayShell.key('red', 0);
  eq(seen.pop(), ['red', 0], 'and so does a coloured button');
  a.AquaPlayShell.key('digit', 7);
  eq(seen.pop(), ['digit', 7], 'a digit brings its digit');

  /* The shell is the one caller that can hand over something nobody has heard
     of — a keycode table drifting away from the vocabulary. Dropped rather
     than passed to a handler that would not know what to do with it. */
  a.AquaPlayShell.key('teletext', 0);
  eq(seen.length, 0, 'an action nobody knows is dropped, not forwarded');

  /* Every action the Kotlin table produces has to be one keys.js accepts,
     which is the drift this is really guarding against. */
  const kotlin = fs.readFileSync(
    path.join(ROOT, '..', 'android/app/src/main/java/com/aquaplay/tv/MainActivity.kt'), 'utf8');
  const table = kotlin.slice(kotlin.indexOf('val ACTIONS'), kotlin.indexOf('fun quote'));
  const produced = (table.match(/to "([a-zA-Z]+)"/g) || [])
    .map(function (m) { return m.slice(4, -1); });
  ok(produced.length > 10, 'the shell maps a remote-sized set of keys', produced.length + ' keys');
  const unknown = produced.filter(function (x) { return a.Keys.ACTIONS.indexOf(x) === -1; });
  eq(unknown, [], 'and every one of them is an action keys.js accepts');

  /* The other half: the shell must not claim keys the page handles itself.
     A D-pad routed through Kotlin is a text field that cannot be typed in. */
  ['DPAD_UP', 'DPAD_DOWN', 'DPAD_LEFT', 'DPAD_RIGHT', 'DPAD_CENTER', 'ENTER'].forEach(function (k) {
    ok(table.indexOf('KEYCODE_' + k) === -1,
       k + ' is left to the WebView, which knows what has focus');
  });
}

async function testAndroidProject() {
  describe('Android TV — the shell ships the same app');

  const root = path.join(ROOT, '..');
  const gradle = fs.readFileSync(path.join(root, 'android/app/build.gradle.kts'), 'utf8');
  const pack = fs.readFileSync(path.join(ROOT, 'tools/pack.js'), 'utf8');

  /* Two packagers, one app. The .wgt stages a list of names and the APK
     copies a list of patterns, and if those two ever disagree the platforms
     are shipping different software — which is the kind of difference that
     turns up as one bug report nobody else can reproduce. */
  const staged = (pack.match(/const STAGE = \[([^\]]*)\]/) || [])[1] || '';
  const wgt = (staged.match(/'([^']+)'/g) || []).map(function (s) { return s.slice(1, -1); });
  eq(wgt.filter(function (f) { return f !== 'config.xml' && f !== 'icon.png'; }).sort(),
     ['css', 'img', 'index.html', 'js'],
     'the .wgt carries the app plus two files only Tizen wants');
  ['index.html', 'css/**', 'img/**', 'js/**'].forEach(function (inc) {
    ok(gradle.indexOf('include("' + inc + '")') > -1,
       'and the APK stages ' + inc, gradle.slice(gradle.indexOf('val stageWebApp'), 400));
  });
  ok(gradle.indexOf('config.xml"') === -1 || gradle.indexOf('include("config.xml")') === -1,
     'without Tizen\'s manifest, which would mean nothing there');

  /* One version number. The Gradle file reads it out of config.xml, so a
     reformat of that file would break the build rather than quietly ship an
     APK numbered zero. */
  const cfg = fs.readFileSync(path.join(ROOT, 'config.xml'), 'utf8');
  /* The whole pattern, not as much of it as fits before the first `"""`:
     a lazy match here once passed a regex that Kotlin could not compile,
     because it stopped at the very quote that was the problem. */
  const re = (gradle.match(/Regex\("""(.*)"""\)/) || [])[1];
  ok(re, 'the build reads the version with a regular expression', String(re));
  ok(!/"$/.test(re), 'whose pattern does not end on a quote — a Kotlin raw',
     'string cannot, and one that did would end a character early');
  const found = new RegExp(re).exec(cfg);
  ok(found && found[1], 'which still finds it in config.xml', String(found && found[1]));
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  eq(found[1], pkg.version, 'and it is the version the rest of the project is on');

  /* What makes it a television app rather than a phone app that runs on one. */
  const manifest = fs.readFileSync(
    path.join(root, 'android/app/src/main/AndroidManifest.xml'), 'utf8');
  ok(manifest.indexOf('android.software.leanback') > -1,
     'the manifest declares itself a TV app');
  ok(/android\.hardware\.touchscreen[\s\S]{0,80}required="false"/.test(manifest),
     'and that it does not need a touchscreen');
  ok(manifest.indexOf('android.intent.category.LEANBACK_LAUNCHER') > -1,
     'with a launcher entry the TV home screen will show');
  ok(manifest.indexOf('android:banner="@drawable/banner"') > -1,
     'and a banner, without which it does not appear there at all');
  ok(manifest.indexOf('android.permission.INTERNET') > -1, 'it may use the network');
  ok(manifest.indexOf('networkSecurityConfig') > -1,
     'and reach a provider over plain http, which is what most of them are');

  /* Two that were wrong when this was written, and neither of which shows up
     anywhere a test can normally see: one is a compiler error and the other
     is an exception thrown a second after the app launches. */
  const activity = fs.readFileSync(
    path.join(root, 'android/app/src/main/java/com/aquaplay/tv/MainActivity.kt'), 'utf8');
  const themes = fs.readFileSync(
    path.join(root, 'android/app/src/main/res/values/themes.xml'), 'utf8');
  const appcompatTheme = /parent="Theme\.AppCompat/.test(themes);
  const base = (activity.match(/class MainActivity\s*:\s*(\w+)/) || [])[1];
  ok(base, 'the activity declares what it extends', String(base));
  ok(base !== 'AppCompatActivity' || appcompatTheme,
     'and it and its theme are the same family — AppCompatActivity throws at',
     'startup on any theme that is not a Theme.AppCompat, and this one is Material');

  /* Most of ExoPlayer is marked @UnstableApi, and Android Lint fails a
     release build over using it unless the class that does says so. Kotlin's
     -opt-in flag looked like the answer and was not: in Media3 1.3 that
     annotation is not an opt-in marker, and the flag compiled to a warning
     about itself. The annotation is the thing that works. */
  const bridge = fs.readFileSync(
    path.join(root, 'android/app/src/main/java/com/aquaplay/tv/PlayerBridge.kt'), 'utf8');
  ok(/@UnstableApi\s*\nclass PlayerBridge/.test(bridge),
     'the class that touches ExoPlayer is marked for it',
     'Android Lint fails a release build otherwise');
  ok(gradle.indexOf('opt-in=androidx.media3') === -1,
     'and the Kotlin opt-in flag is gone, since it did nothing but warn');

  /* The one that made five channels out of eight unplayable while looking
     exactly like a decoder fault. Broadcast H.264 frequently carries no IDR
     frames at all — the encoder refreshes the picture gradually instead —
     and a reader that waits for an IDR waits for good: the video track is
     found, selected and reported supported, the audio plays, and no decoder
     is ever created. Measured on a real playlist: those channels play with
     this flag and do not without it. */
  ok(bridge.indexOf('FLAG_ALLOW_NON_IDR_KEYFRAMES') > -1,
     'the stream readers begin at the first usable picture, not at an IDR',
     'without it a channel with no IDR frames plays sound over a black screen');
  ok(bridge.indexOf('HlsMediaSource.Factory') > -1 &&
     bridge.indexOf('setExtractorFactory') > -1,
     'and HLS carries it too, which takes a media source of its own',
     'DefaultMediaSourceFactory gives the HLS path no way to pass the flag');

  /* A message that names a cause it has not established sends whoever reads
     it looking in the wrong place. This one blamed interlaced video, which
     was nothing to do with it, and that cost a release. */
  const noPicture = (bridge.slice(bridge.indexOf('private val noPicture'))
                           .match(/fail\("([^"]*)"/) || [, ''])[1];
  ok(noPicture.length > 0, 'the no-picture watchdog says something', noPicture);
  ok(!/interlaced|hardware decoder/i.test(noPicture),
     'without naming a cause it has not shown', noPicture);

  /* One stylesheet paints both builds, so both builds must show the same
     colours. A WebView left to itself may decide a dark app wants its page
     darkened for it — which would make the Android build differ from the
     Samsung one for a reason nobody could see from a sofa. Measured on the
     emulator the two match to the pixel; this is so they still match on
     hardware whose WebView defaults are not the emulator's. */
  ok(/ALGORITHMIC_DARKENING|FORCE_DARK/.test(activity),
     'the shell turns the WebView\u2019s own darkening off',
     'left on, Android renders colours the Samsung build does not');

  /* A release build is a different thing from the debug one, and for a long
     while it was not: every APK handed over was debuggable, which means the
     WebView's contents can be attached to over adb by anyone who can reach
     the box. That is exactly how this project drives the app in testing,
     and exactly what should not ship. */
  const relBlock = gradle.slice(gradle.indexOf('release {'),
                                gradle.indexOf('debug {'));
  ok(/isMinifyEnabled\s*=\s*true/.test(relBlock),
     'the release build is shrunk', 'R8 off means the debug APK with a different name');
  ok(/isShrinkResources\s*=\s*true/.test(relBlock),
     'and its resources with it');

  /* The one thing R8 must be told about. Every method on the bridge is
     called by name from JavaScript and by nothing at all from Kotlin, so a
     shrinker left to its own judgement removes the whole player and the app
     boots to a screen that never plays anything. */
  const rules = fs.readFileSync(
    path.join(root, 'android/app/proguard-rules.pro'), 'utf8');
  ok(/JavascriptInterface\s*<methods>/.test(rules),
     'and it keeps the JavaScript bridge, which nothing in Kotlin calls',
     'without this the release build shrinks the player away');

  /* Debugging the page is a debug-build privilege. */
  ok(/if \(debuggable\)\s*WebView\.setWebContentsDebuggingEnabled/.test(activity),
     'and the page is only debuggable in a debuggable build',
     'otherwise anyone on the network can attach to the app\u2019s WebView');

  /* And the key that signs it is not in here. */
  const agi = fs.readFileSync(path.join(root, 'android/.gitignore'), 'utf8');
  ok(/keystore\.properties/.test(agi) && /\*\.jks/.test(agi),
     'the signing key is excluded from the repository', agi.trim());

  /* Every logo in a playlist is fetched through the shell, and a body handed
     back from shouldInterceptRequest never reaches the WebView's own HTTP
     cache — so without one here each logo was fetched from the provider
     again every time its row scrolled back into view. Measured at 576ms
     apiece, which is why a fast scroll left a column of blanks. */
  const netBridge = fs.readFileSync(
    path.join(root, 'android/app/src/main/java/com/aquaplay/tv/NetBridge.kt'), 'utf8');
  ok(netBridge.indexOf('IMG_MAX') > -1 && netBridge.indexOf('cached(url)') > -1,
     'the shell caches the images it fetches',
     'without it every logo is re-downloaded each time it scrolls into view');
  ok(/Cache-Control/.test(netBridge),
     'and says so, so the WebView keeps them for the page as well');

  /* Reading a layout property back mid-write forces the whole page to be
     laid out again. In slideGuide that ran on every cursor move, and the
     sampling profiler put it at 45% of a held key's time. It belongs on the
     rare path where the transition is actually being switched. */
  const chan = fs.readFileSync(path.join(root, 'app/js/views/channels.js'), 'utf8');
  const slide = chan.slice(chan.indexOf('function slideGuide'),
                           chan.indexOf('function slideGuide') + 600);
  ok(slide.indexOf('offsetHeight') > -1,
     'the guide still commits a transition switch before moving');
  ok(/if \(!want\)[^\n]*\{[^\n]*offsetHeight|guideAnim/.test(slide),
     'but only when the transition changes, not on every move',
     'a forced layout per keypress is what made holding the key lag');

  /* Showing the keyboard must not ask the WebView for focus.

     Measured on a real Android TV: requestFocus() on the WebView resets the
     DOM focus to whatever it considers its first focusable node — the video
     layer, as it happens — so the field the page had just put the cursor in
     lost it, and every keystroke after that went nowhere. The field stayed
     empty and it looked like the keyboard was broken. */
  const setEditing = activity.slice(activity.indexOf('fun setEditing'),
                                    activity.indexOf('fun setEditing') + 700);
  ok(setEditing.indexOf('showSoftInput') > -1, 'the shell shows the keyboard itself');
  /* The call, not the word: the comment beside it explains why it is not
     there, and a test that reads comments is a test that reads nothing. */
  ok(setEditing.indexOf('web.requestFocus()') === -1,
     'without taking focus off the field the page just focused',
     'requestFocus there empties the field the viewer is typing into');

  /* And it has to notice the keyboard closing, because while it is up it owns
     the D-pad and the page cannot see the press that dismissed it. */
  ok(activity.indexOf('WindowInsetsCompat.Type.ime()') > -1,
     'and watches for the keyboard closing',
     'without it the page stays in its editing state and the cursor never moves again');
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

/* ============================================================ */
/*  i18n                                                        */
/* ============================================================ */

/* Every string the app asks for by name, read out of the shipped source the
   same way a person would grep for it: T('...') in the JS, data-i18n in the
   markup, plus what the settings screen hands to row() and cycle() — those are
   translated inside the helpers, so the literal never appears next to a T.
   I18N.EXTRA covers what is left: day names, group names, the keyboard help. */
function usedKeys() {
  const files = [];
  (function walk(d) {
    fs.readdirSync(path.join(ROOT, d)).forEach(function (n) {
      const rel = d ? d + '/' + n : n;
      if (fs.statSync(path.join(ROOT, rel)).isDirectory()) {
        if (n !== 'node_modules' && n !== 'lib' && n !== 'tools' && n[0] !== '.') walk(rel);
        return;
      }
      if (/\.(js|html)$/.test(n) && rel !== 'js/lang.js') files.push(rel);
    });
  })('');

  const keys = {};
  const add = function (k) { if (k && k.trim()) keys[k] = 1; };
  const RE_T = new RegExp("\\bT\\('((?:[^'\\\\]|\\\\.)*)'", 'g');
  const RE_ATTR = /data-i18n(?:-ph)?="([^"]*)"/g;
  files.forEach(function (rel) {
    const s = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    [RE_T, RE_ATTR].forEach(function (re) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(s))) add(m[1]);
    });
  });

  const set = fs.readFileSync(path.join(ROOT, 'js/views/settings.js'), 'utf8');
  const RE_ROW = new RegExp("\\brow\\('((?:[^'\\\\]|\\\\.)*)', '((?:[^'\\\\]|\\\\.)*)'", 'g');
  let m;
  while ((m = RE_ROW.exec(set))) { add(m[1]); add(m[2]); }
  const RE_CYCLE = /cycle\(([\s\S]*?)\)\)/g;
  while ((m = RE_CYCLE.exec(set))) {
    const arrays = m[1].match(/\[[^\]]*\]/g) || [];
    const last = arrays[arrays.length - 1];
    if (!last) continue;
    (last.match(new RegExp("'((?:[^'\\\\]|\\\\.)*)'", 'g')) || [])
      .forEach(function (l) { add(l.slice(1, -1)); });
  }

  (ctx.I18N.EXTRA || []).forEach(add);
  return Object.keys(keys).sort();
}

async function testI18n() {
  describe('i18n — ten languages, one key set');

  const I = ctx.I18N, LANGS = ctx.LANGS;
  const keys = usedKeys();

  ok(keys.length > 300, 'the app asks for a few hundred strings by name',
     keys.length + ' keys');
  eq(I.LANGS.length, 10, 'ten languages are offered');
  eq(I.LANGS[0].code, 'en', 'English first, since it is the key language');
  ok(I.LANGS.every(function (l) { return l.name && l.code; }),
     'each has a code and a name');
  /* A language list is the one screen someone cannot be expected to read in
     the language they are trying to leave. */
  ok(I.LANGS.every(function (l) { return l.code === 'en' || l.name !== l.code; }),
     'named in their own language, not by their code',
     I.LANGS.map(function (l) { return l.name; }).join(' '));

  /* The check this file exists for: a string added to the app tomorrow will
     fail here until every language has it, rather than quietly appearing in
     English inside a Korean interface. */
  const gaps = [];
  const holes = [];
  I.LANGS.forEach(function (l) {
    if (l.code === 'en') return;
    const d = LANGS[l.code];
    if (!d) { gaps.push(l.code + ': no dictionary at all'); return; }
    const missing = keys.filter(function (k) { return !(k in d); });
    if (missing.length) {
      gaps.push(l.code + ': ' + missing.length + ' missing, e.g. "' + missing[0] + '"');
    }
    const empty = Object.keys(d).filter(function (k) { return !String(d[k]).trim(); });
    if (empty.length) gaps.push(l.code + ': ' + empty.length + ' empty');

    /* A placeholder may move within a sentence — that is the whole point of
       using one — but it may not be dropped, or the sentence loses a fact. */
    Object.keys(d).forEach(function (k) {
      const want = (k.match(/\{\w+\}/g) || []).sort().join(',');
      const got = (String(d[k]).match(/\{\w+\}/g) || []).sort().join(',');
      if (want !== got) holes.push(l.code + ': ' + k + ' -> ' + d[k]);
    });
  });
  eq(gaps, [], 'every language covers every key');
  eq(holes, [], 'and keeps every placeholder');

  /* Translation itself. */
  const before = I.lang();
  eq(I.set('es'), 'es', 'the language can be set');
  eq(I.t('Settings'), 'Ajustes', 'and strings come back translated');
  eq(I.t('Set to {n}', { n: 7 }), 'Puesto en 7', 'with parameters filled in');
  eq(I.t('Nothing here has been translated'), 'Nothing here has been translated',
     'an unknown string falls back to the English rather than to a blank');
  eq(I.set('ja'), 'ja', 'switching again');
  eq(I.t('Settings'), '設定', 'gives the other language');
  eq(I.set('xx'), 'en', 'an unknown code falls back to English');
  eq(I.t('Settings'), 'Settings', 'which is the key itself');
  /* A parameter nobody supplied stays visible instead of printing "undefined":
     a half-built sentence is easier to spot in a screenshot than a plausible
     wrong one. */
  eq(I.t('Set to {n}'), 'Set to {n}', 'a missing parameter is left alone');

  I.set(before);
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
    await testI18n();
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
    await testNumbers();
    await testDefaults();
    await testIcons();
    await testAndroidPlatform();
    await testAndroidPlayer();
    await testAndroidRect();
    await testAndroidState();
    await testAndroidEvents();
    await testAndroidKeys();
    await testAndroidProject();
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

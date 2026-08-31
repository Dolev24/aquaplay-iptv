# AquaPlay IPTV

Lightweight IPTV player for Samsung Tizen TVs. Vanilla JS, no framework, no
build step. Android TV is a second target, and `android/` is the shell that
carries the same app there.

Full architecture, TV install steps and roadmap: `app/README.md`.
This file holds only what that README does not.

## Running it here

```bash
node app/tools/dev-server.js 8081
```

Port 8080 is permanently occupied on this machine by qBittorrent, so pass a
port or set `PORT` — the server reads `process.env.PORT` as well as `argv[2]`
(added here; the shipped zip only read `argv[2]`).

Node 25, npm and git are all on PATH in this environment — unlike the session
this project started in, which had no shell at all.

## Gotchas that cost time

- **The remote key vocabulary is the primary model**, in `js/keys.js`
  (`keydown` -> `ev.keyCode` -> action). Mouse support was added on top in
  v0.3.1 (each view has a `bindMouse()` that translates clicks into the same
  focus moves the keys make) — before that, clicking anything did nothing,
  which made browser testing miserable. `element.click()` on a `<div>` still
  only works where a handler exists; when driving the app programmatically,
  dispatching keydown is still the more faithful path.

  One trap the mouse handlers exist to close: clicking into a text field gives
  it DOM focus, and `keys.js` deliberately swallows left/right there so they
  move the text cursor. Any view that focuses an input must keep its own
  `editing` flag in step, or the arrows silently stop navigating.

- **Driving it from an automated browser**: if the Browser pane is not
  displayed, screenshots and synthetic key/type events both silently fail
  (no compositing, no input routing). Dispatch keydown directly instead —
  `keys.js` only reads `keyCode`:

  ```js
  window.__k = function (c) {
    var e = new KeyboardEvent('keydown', { bubbles: true, cancelable: true });
    Object.defineProperty(e, 'keyCode', { get: function () { return c; } });
    Object.defineProperty(e, 'which',   { get: function () { return c; } });
    document.dispatchEvent(e);
  };
  ```
  Play (415 / `p` on a keyboard) is handled before every pane's own switch, so
  it works from the list, the groups rail, the guide panel, the drawer and the
  search box alike: it puts the channel *already playing* full screen, whatever
  the cursor is on. OK cannot do that — on any other row OK means "play that
  one instead" — which is why the button exists.

  Setup ring order on the M3U tab: tabs(0,1), m-name(2), m-url(3), m-epg(4),
  connect(5). Text is read from `input.value` at connect time, so setting
  `.value` directly is fine; only navigation needs real key events.

- **`$WEBAPIS/webapis/webapis.js` 404s in the browser.** Expected — that path
  only resolves on the TV. Not a bug.

- **`.ts` streams cannot play in a browser**, only HLS. TV plays both.

- **Do not write these files through Python or shell heredocs without checking
  the escapes.** A CSS rule intended as `content:"\25B7"` was written via a
  Python string, which read `\25` as an *octal* escape: the file ended up with
  the byte 0x15 followed by the literal text "B7", and every replayable
  programme in the guide showed a tofu box and "B7" next to it. The marker is
  now a CSS border triangle that needs no glyph, and `test-units.js` scans
  every shipped .js/.css/.html/.xml for control characters.

- **Chromium cannot decode interlaced H.264**, and broadcast IPTV is mostly
  1080i. On the user's provider exactly half the channels (64 of 126) are
  field-coded (PAFF): SPS `frame_mbs_only_flag == 0`. Those give
  `MEDIA_ERR_DECODE` (code 3) or, worse, just stall at `readyState 1` with
  nothing buffered and no error at all. It is not an app bug and there is no
  browser-side fix — the TV's hardware decoder handles them natively. The app
  now says so rather than showing a black rectangle (`watchForStall` in
  `views/channels.js`, `P.DECODE_HINT` in `player.js`).

  To check a stream: fetch a segment, find the video PID's SPS NAL (type 7)
  and read `frame_mbs_only_flag`. Advertised `CODECS=` in the manifest does
  not tell you — every channel there claims plain `avc1`.

- **On Android the page must be transparent, or there is no picture at all.**
  The decoder there draws on a SurfaceView behind the *whole* WebView, so
  `html,body{ background:#000 }` covered every channel: sound, and a black
  rectangle. Tizen hid it for years — AVPlay's `<object>` punches its own
  hole through the page, so nothing painted behind it was ever consulted —
  and so did the tests, because a browser puts its video *inside* the page
  where a backdrop behind it is harmless. `html.tv, html.tv body{
  background:transparent }` in `style.css`; the e2e suite now boots the app
  with the Android bridge stubbed and checks nothing opaque sits over the
  surface, in both themes (the light theme repainted the body too).

  Do not trust `adb exec-out screencap` here: a video layer composited by
  the hardware composer (`composition type=DEVICE` in `dumpsys
  SurfaceFlinger`) comes back black whether or not it is on the screen, and
  disabling overlays with `service call SurfaceFlinger 1008` no longer works
  on current images. `adb emu screenrecord screenshot <dir>` goes through the
  emulator's own compositor, and grabbing the emulator window on the host is
  better still — that is what a person actually sees.

- **Broadcast H.264 often has no IDR frames, and ExoPlayer waits for one for
  ever.** Five of the first eight channels on the user's provider played
  audio and showed nothing, with no error: the video track was found,
  selected and reported *supported* (`trackInfo()` on the bridge says so),
  and no video decoder was ever created — only the AAC one appeared in
  logcat. That last detail is the tell. A decoder that refuses a stream is
  a decoder that was asked; here nothing asked.

  The fix is `DefaultTsPayloadReaderFactory.FLAG_ALLOW_NON_IDR_KEYFRAMES`,
  which starts at the first recovery point instead. HLS needs its own
  `HlsMediaSource.Factory` to carry it, since `DefaultMediaSourceFactory`
  offers no way to pass extractor flags down the HLS path. Eight of eight
  channels play with it; three of eight did without.

  This was first diagnosed as a software decoder refusing interlaced video
  and shipped as a message saying so. The streams *are* field-coded — the
  SPS above confirms it — which made the wrong answer fit every fact that
  had been gathered, and none of the ones that had not. Correlation across
  channels (25fps failed, 50fps played) is not a mechanism.

- **Reading a layout property back is what made the list lag.** Holding the
  down key was janky, and the cause was not the eighteen rows being
  repainted: `slideGuide` read `host.offsetHeight` on every cursor move to
  force the guide panel's `transition:none` to commit before the next write
  could be coalesced with it. That read forces a synchronous layout of the
  whole page. The sampling profiler put `ensureGuideVisible` at **45% of a
  held key's time**; the fix is to switch the transition only when it
  actually changes, since between two non-animated moves there is nothing to
  suppress. `ensureGuideVisible` also read `clientHeight` back for a number
  that only changes with the window — that now comes from `measure()`.

  Measured on the emulator over forty presses: **14.0ms of JS per keypress
  to 1.3ms**, p90 18.7 to 1.8. The row rebuild was worth having too (the
  list stops throwing away and re-parsing eight elements per row per press)
  but it was the smaller half — 14.0 to 8.0 on its own.

  Two metrics that looked authoritative and measured nothing: `requestAnimation
Frame` intervals (they track vsync, and read a flat 16.7ms on a build that was
  visibly janking) and `dumpsys gfxinfo` janky-frame percentage (58% before,
  57% after — on an emulator it is dominated by the host's own compositing).
  `Profiler.start` over CDP, summed by self time, found it in one run.

- **Nothing cached the logos.** Every image in a playlist goes through
  `NetBridge.shouldInterceptRequest`, and a body handed back from there never
  reaches the WebView's own HTTP cache — so each logo was fetched from the
  provider again every time its row scrolled back into view, measured at
  **576ms apiece**. That is why a fast scroll left a column of blanks that
  filled in seconds later. `NetBridge` now keeps images under 512 KB in an
  access-ordered memory map (24 MB) and in `cacheDir/img`, one file each with
  its mime type on the first line. After a relaunch: 39 hits, 0 misses, no
  network at all.

  Do not count the files with `run-as ... ls | wc -l` — it reported 6 for a
  directory holding 39, which sent a good half hour after a bug that was not
  there. `ls | grep -c .` is honest.

- **Scrolling one row rewrote eighteen.** `VList` handed `pool[i]` to the
  i-th *visible* row, so moving down by one shifted every node's index by one
  and rewrote the lot — and rewriting a row means measuring and shaping its
  text again, in Hebrew, Cyrillic and Latin. Binding a node to its row
  instead (`pool[idx % n]`) covers the same window with the same nodes, but
  scrolling by one rebinds one node and moves the rest, which is a transform
  the compositor does by itself.

  This is the one the JS profiler could not see: it is layout, not script.
  `Performance.getMetrics` over a 60-press scroll, before and after:
  LayoutDuration **579ms to 252ms**, RecalcStyle 226 to 98, and total
  main-thread TaskDuration **1629ms to 1091ms**. Script was 230ms of it all
  along. The e2e suite now counts how many rows change text when the list
  moves by one: at most one, and it reports 18 of 18 if the binding goes back.

- **Warming the logos belongs off the keypress.** Asking for a logo slightly
  before its row appears is what stops a fast scroll showing gaps — a preload
  costs one request and the row's own use then costs none. But doing it
  inside the repaint meant arriving somewhere new created up to a hundred
  `Image`s in one press: **6.8ms a press on a first pass against 1.5ms on a
  second**, which is precisely what "sometimes laggy, sometimes not" is. A
  queue drained three every 30ms outruns a held key four times over and
  closed the gap to 2.3 against 1.7.

- **`Date.now()` costs 29 microseconds in the Android TV emulator** — perhaps
  five hundred times what it costs anywhere else. `EPG.nowNext` is asked by
  every visible row on every keypress, so it now keeps its answer until the
  programme on air ends. Worth knowing before optimising anything else that
  reads the clock in a loop: the clock *was* the loop.

  Measured end to end across the session, per keypress on the emulator:
  **14.0ms mean / 18.7 p90, down to 1.7ms / 2.5**, and a cold region 2.3
  rather than 6.8. What is left on that machine is its software rasteriser
  — `dumpsys gfxinfo` puts the GPU at 12ms of a 17ms frame, which no amount
  of work in the page can move.

- **A spent retry budget stayed spent.** `MAX_RECONNECT` is three, and after
  three failures the app stops retrying and says the channel is unavailable —
  deliberate, since a fourth attempt at a dead stream helps nobody. What was
  not deliberate is that the count only went back to zero when the channel
  *changed*: `play()` read `if (playingKey !== c.key) cancelReconnect()`. So a
  channel that had used up its three retries could never be recovered in
  place. "Back to live", or choosing it again, printed "unavailable" on the
  very next failure with no retry left — while switching to another channel
  and back worked, because the switch reset the count on its way past. That
  is exactly how it was reported: *"reconnect doesn't fix it, but switching
  channels and coming back does."*

  The rule the code was missing: **a retry the app decided on keeps counting;
  an attempt a person asked for starts the budget over.** `reconnectNow()` is
  now the only caller passing `autoRetry`. The e2e suite drives the
  bookkeeping directly with `Player.play` stubbed — four failures, then a
  `tuneTo` of the same channel, and the fifth must say "Reconnecting" again.

  Worth noting how much of the search was wasted on the plausible-sounding
  answer: a half-open connection to a provider that allows one at a time. It
  was tested — stream frozen by throttling the emulator to GSM speeds for
  forty seconds, network restored, same URL reopened — and it recovered in
  one second every time. The bug was in the app's own counter all along, and
  reading the four lines around `cancelReconnect` would have found it faster
  than any of it.

- **Never forward an upstream `content-length` through the dev proxy once the
  body has been decompressed.** It describes the compressed bytes, so the
  browser stops reading there. A real provider XMLTV (30 MB `.gz` -> 242 MB)
  was silently truncated to an eighth, and only 7 of 126 channels matched the
  guide as a result. `tools/test-proxy.js` covers this.

- **`#video-layer` is painted above every `.view` in a browser** (z-index 5 vs
  1, and `.view` creates its own stacking context). Anything that must appear
  over the video — the OSD, the preview badge — has to be a direct child of
  `#stage` with a higher z-index, not nested inside a pane. On Tizen the plane
  is *behind* the page instead, so nesting looks fine there and only breaks in
  the browser. `.preview-badge` is anchored to stage coordinates for this
  reason and must be moved if the preview rect changes.

- **`RECT_PREVIEW` in `player.js` must match `.preview-frame` in CSS.** It is
  the AVPlay display rect on Tizen and the `#video-layer` box in a browser;
  nothing checks that they agree.

## Tests

```bash
cd app && npm test
```

734 tests across four suites, first written here on 2026-08-26 (the suites the
original README referenced were never in the zip):

- `tools/test-units.js` (287) — loads the real modules into a fake `window` via
  `vm`. No browser, no dependencies, ~450 ms.
- `tools/test-proxy.js` (20) — the dev proxy against a mock upstream. No
  browser either.
- `tools/e2e.js` (370) — 5,000-channel playlist + XMLTV, real key events.
  Covers the play-on-demand model, the guide viewer, channel renumbering and
  catch-up replay.
- `tools/e2e-vod.js` (57) — Movies and Series against a mock Xtream panel the
  test runs in-process, so no provider account is needed.

Both browser suites use `playwright-core` against the machine's installed
Chrome — no browser download; `CHROME_PATH` overrides. None of them tests real
video decoding, on purpose — see the README.

Bugs these suites caught on first run, now fixed and covered:
- `views/setup.js` `move()` trapped focus on the tab row, so the Xtream fields
  were unreachable by remote on first launch — the default path was broken.
- The groups rail kept stale text when the section changed (`grList` was never
  invalidated, unlike `chList`).
- The Xtream `liveUrlLegacy` error-retry rewrote movie URLs into live ones.
- Number-key dialling matched the playlist's `num`, ignoring user overrides.
- The preview badge was nested in `.view`, so `#video-layer` painted over it —
  invisible in a browser whenever a stream actually played.

Found against the user's real provider, not by the suites:
- The dev proxy truncated gzipped guides (see above) — 88% of the file lost.
- `U.slug` whitelists `a-z0-9`, so Cyrillic/Hebrew names collapsed to a stray
  digit ("9 Канал HD" -> "9"), losing real guide matches and risking false
  ones. `U.matchKey` now handles matching; `U.slug` still generates channel
  keys and must not change, or saved favourites and numbers would orphan.

## Stream health

`sampleDrift` in `views/channels.js` compares real elapsed time against
`Player.elapsed()` every two seconds. Real time always advances; media time
only advances while the picture does, so the gap is how far behind the stream
has fallen — and on a live edge it never recovers on its own, which is why the
warning is allowed to persist. Samples where the media clock jumps (a seek, a
restart) are discarded rather than counted as drift.

Nothing about this pauses or restarts playback. That was the requirement: it
explains, it does not interrupt.

Auto-reconnect deliberately excludes decode failures — an interlaced stream in
a browser will fail identically on every retry, so retrying is just noise.

## Settings that actually do something

Every row in `views/settings.js` has to change behaviour; none are decoration.
`App.onSettingChanged(path)` is passed which setting moved, because some need
work: `pictureSize` reaches the video element (or AVPlay's display method),
`sortBy` re-applies the current group, and the guide settings (`epg`,
`epgHours`, `catchupHours`, `epgOffset`) are baked in at parse time, so they
delete the cached blob and rebuild the guide.

`shortUrl` masks the tail of a playlist URL. The path token is the credential —
it should not be readable from a photograph of the TV.

Two of these ship on a different setting than they were written with. `sortBy`
starts on **number** rather than provider order, and `guideView` on **now at
the top** — both because the remote has a number pad and the number is how a
viewer says which channel they mean. A list in the provider's own order is a
list whose numbering nobody chose, and a channel dialled by number landing
somewhere unrelated to where the eye expects it is the kind of thing that reads
as a bug. Neither default changes any behaviour that was not already there.

## The guide panel is nine programmes, five at a time

`PANEL_ROWS`/`PANEL_BEFORE`/`PANEL_VIEW` in `views/channels.js` are 9, 4 and 5:
the panel holds whatever is on air plus four either side, and shows five of
them. It was a time window until a count replaced it, and that is exactly why
the programme playing kept drifting off the middle — measured in hours, how
many rows fall either side of now depends on how long the programmes happen to
run, so the one on air cannot be centred at all.

Counting fixes the geometry instead of chasing it. The scroller is exactly
`PANEL_VIEW * GUIDE_H` (300px), so five whole rows fill it; `ensureGuideVisible`
centres the cursor row and clamps at both ends, and with the cursor parked on
what is on — where it sits whenever nobody is driving the panel — that puts the
programme on air dead centre. Measured at 0px off, and 120px off at either end
of the nine, which is what clamping means.

Three things have to stay in step, and nothing checks them:

    GUIDE_H          = .epg-row height   (60px)
    PANEL_VIEW       = .epg-scroller height in rows  (300px / 60)
    PANEL_ROWS/2 + 1 = where the row on air lands    (the 5th of 9)

Five whole rows fill the box exactly, so nothing hangs over the edge to show
there is more — the panel would look like all there is. `.epg-track` on the
right-hand edge says otherwise, and says where in the nine the window sits,
which a fade could not. It lives in the scroller's padding, clear of the
longest programme name, and appears only when there is something to scroll.

Leaving the panel re-parks the cursor on what is on. Otherwise the next glance
at it shows wherever the last person scrolled to, which is not what a panel
under a picture is for. A forced repaint — the 30-second tick that refreshes
the progress bar — used to re-park it even while somebody was reading:
`paintGuide` re-parks only when the channel actually changed, and otherwise
re-finds the programme the cursor was on by start time, since the window may
have slid a row underneath it.


**One row is marked, and it is the row the cursor parks on.** `parkIndex` gives
both, so they cannot disagree — and they did, on real guides:

    something on air        -> that programme
    a gap where now falls   -> the next one
    the guide has run out   -> the last one
    it starts this evening  -> the first one

The row class used to be decided per row by testing its own times against the
clock. That marks *two* rows whenever a provider's programmes overlap by a
minute, and *none at all* whenever they do not quite meet — and a panel with no
marked row on some channels reads as the app not having noticed what is
playing. When nothing is on air there is nothing to call "now", so the parked
row gets `.here` instead: the same seat, quieter, without the bold and without
the accent clock.

Parking on row 0 when the guide had run out was the other half of that bug: it
put the cursor on the oldest thing the panel held, which is the least useful
row on the screen.

**The row on air is centred even when the guide is too short to allow it.** A
channel whose schedule starts a couple of hours ago has only one programme
before the one on air, and clamping the scroll at the top then puts what is
playing one row above the middle — the one thing the panel is supposed to
guarantee. While nobody is driving it, `ensureGuideVisible` centres that row
regardless and lets a little empty space sit above the first one. It only does
this for the row on air: with nothing on air there is no row that has to be
centred, so the panel fills itself properly instead.

**Or the same nine rows, all of them ahead** — which is now what a new
install opens on. Settings -> Guide panel offers "Now at the top": the window
starts at what is on and takes whatever follows, which turns four programmes of
schedule into nine. Two assumptions had to go with it, both of which existed to
keep the panel full: the window no longer slides back when fewer than nine
follow — sliding back is exactly the past it was asked not to show — and a
short list sits at the top rather than floating in the middle, with the empty
space underneath.

Centred was the default first and is still the better shape for a channel you
are half-watching, where what has just been on is as interesting as what is
next. It lost the default because most glances at the panel are asking what is
on next, and four rows of that beat eight rows centred on a question that the
info bar has already answered. Both are one row in Settings; nothing about the
geometry changed, only which of the two `guideView` starts on.

Going further than the nine is what the catch-up browser is for, and there is
no setting for how far it reaches.


## Sizes people can actually read

The app is looked at from a sofa, sometimes by someone whose sight is not what
it was, and it was drawn to be glanced at rather than read. Three places were
too small or too faint, and the fixes are all "bigger, and one contrast step up":

    channel number     19px --text-dim2  ->  34px semibold --text-mid
    now/next line      17px --text-dim   ->  21px --text-mid
    channel name       23px regular      ->  25px semibold
    guide programme    20px --text-dim   ->  22px --text-mid

`--text-dim2` is the token for a caption nobody has to read; a channel number
is not that. The 76px row had the space all along — name, programme and number
now come to 58px of it.


The channel row ended up separated on three axes rather than one: the number is
the largest thing in it because it is what people dial, the name is semibold
against the programme line's regular, and the programme line is a tone down
from the name. Size alone was not enough — at a glance down a list, weight is
what the eye reads first, and a 25px name over a 21px programme in the same
weight read as one paragraph.

**The logo has air on both sides of it.** The gap after it is 22px against
14px before, because the number column is fixed at 78px — four digits at 34px
need all of it — and the numbers are left-aligned in it, so anything shorter
than four digits leaves its own slack in front of the logo. Widening the gap
after the logo is the half of the pair that can move: narrowing the column to
balance it would take space four-digit numbers need.

**The row grew to fit them.** 76px to 92px, which is ten channels in the 920px
scroller rather than twelve, and a 96x70 logo box rather than 52x38. Fewer
channels on a screen is the cost and it was the right trade: this is a list
someone scrolls with a remote from three metres away, not a table to scan.
`--row-h` in the CSS and `ROW_H` in views/channels.js have to agree — the
windowing counts in rows — and nothing checks that they do. The viewport is
measured from the DOM once the view is up, so only the row height is hard-coded
in two places.

**The guide panel reads outward from what is on.** Two sizes: the programme on
air at 27px semibold, everything else at 22px. The row on air was previously
the same size as the row four hours ago, which made a panel whose whole point
is the middle row look like a list.

There were three for a while — a `.near` class one size down on the rows either
side of the middle, stamped at `park ± 1`. It was a gradient of importance
nobody asked for: what is on matters, and the other eight are a schedule that
should read as one column. Reading down four sizes is slower than reading down
two, so the middle class went.

Two constraints hold the type in: every row stays **exactly 60px**, because
`GUIDE_H`, `PANEL_VIEW` and the scroller's height are all counted in rows and
the centring is arithmetic; and the row's contents are `align-items:center`
now rather than `flex-start` with a 9px top padding, which had the name
floating above its own line with a gap underneath.

**The progress bar in the panel had never rendered.** `.epg-bar` is a `<span>`
with `height:3px` and no `display`, and an inline box ignores a height — so it
measured 0px tall from the day it was written. The channel list's own
`.ch-prog` says `display:block` for exactly this reason. It is 4px and visible
now, which is also the only thing in the panel that says how far through the
programme is.

## The number on the remote, from the channel panel

Right arrow -> **Change channel number**, for the channel under the cursor. The
Settings screen is for renumbering a whole playlist; wanting to move one channel
should not mean walking a list of five thousand to find it again.

It shares that screen's rule, which is the only one that matters here: two
channels cannot hold one number, because the remote reaches whichever the list
hits first. If the number is taken it offers to **swap**, and `numberHolder`
checks `numOf` across `all` rather than the filtered `view` — a clash with a
channel that happens to be filtered out of sight is still a clash.

## Ten languages, and the English is the key

`js/i18n.js` is the translator, `js/lang.js` the nine dictionaries. **The key is
the English string itself** — `T('Press OK to play')`, not `t('preview.hint')` —
which decides most of the rest:

- a missing translation falls back to something a person can read,
- the English build needs no dictionary at all,
- a string added in a hurry works everywhere before anyone has translated it,
- and changing an English wording silently drops that string back to English in
  the other nine. That last one is the price, and it is paid by a test.

`test-units.js` reads every translated string out of the shipped source the way
a person would grep for it — `T('...')` in the JS, `data-i18n` in the markup,
and what the settings screen hands to `row()` and `cycle()`, which translate
inside the helper so the literal never sits next to a `T`. A language missing
any of them fails the suite. **358 keys, ten languages.**

Some strings reach the translator through a variable and cannot be seen by any
scan: day and month names, the built-in group names, the keyboard reference,
the parser's placeholders for a nameless channel. Those are listed in
`I18N.EXTRA`, which the same test folds into the key set. Adding one means
adding it there too — the price of translating at paint time, which is what
makes switching language instant.

**Placeholders are the contract.** `T('Set to {n}', { n: 4 })` rather than
concatenation, because word order is the first thing a translation changes. The
test checks that every translation carries the same placeholders as its key: one
may move within a sentence, none may be dropped. A parameter nobody supplied is
left as `{n}` rather than printed as "undefined" — a half-built sentence is
easier to spot in a screenshot than a plausible wrong one.

**Switching is instant and touches everything.** `I18N.set(code)` swaps the
dictionary, restamps every `data-i18n` element in the markup, and sets
`<html lang>`, which is what a TV uses to pick a font for Japanese or Hindi.
`App.onSettingChanged('settings.lang')` then rebuilds the channel list and the
settings screen, because both bake their text in when they build their rows.
Nothing reloads.

Settings -> **Language**, and its values are the languages' own names —
Español, Русский, 日本語. A language list is the one screen a viewer cannot be
expected to read in the language they are trying to leave. The default is
"Follow the TV", which reads `navigator.language`.

Two things worth knowing before this reaches a television:

- The translations were written here in one pass. They are meant to be correct
  and plain rather than idiomatic, and no native speaker has read them. Every
  one of them is one line in `js/lang.js`.
- **Fonts are the risk.** Cyrillic, Devanagari, Japanese and Korean all need
  the set to have a font for them. Tizen ships a broad font set and `<html
  lang>` helps it choose, but this cannot be verified from here — if a language
  comes out as boxes on the TV, that is what happened, and it is the same class
  of problem as the emoji in the side panels.

## The row playing is outlined, not dotted

In the channel list, what is playing carries a red outline around the whole
row — `box-shadow: inset`, so nothing in the row moves when it arrives and the
outline follows the row's own corner radius. A focused row that is also playing
keeps its lift as well, since the two shadows compose.

It was a 12px dot at the left edge, which is a marker the size of a full stop
on a list read from across a room. The guide panel and the badge keep the dot:
they are single objects being labelled, not a row in a column of rows.

## The red dot means "this one is on now"

Three places wear it: the badge over the picture, the programme on air in the
guide panel, and the channel playing in the list. It started as a play triangle
in the panel and a red bar in the list — two marks for one fact, neither of
which said which fact. A circle needs no glyph and no font, which is why it is
drawn rather than typed, like the heart, the padlock and the replay clock.
## Parental control

`U.isAdult` matches the group or the name. The word boundary matters: without
it "Adulthood" in a film title would lock a movie channel. Channels it matches
are filtered out of both the list and the groups rail rather than shown greyed
— a visible locked row still tells a child exactly what is there. Channels
locked one at a time are a different thing and behave differently; see below.

Unlocking is session-only and lives in a closure variable in `store.js`, never
in localStorage, so it cannot survive a restart.

## A lock says no; the adult filter hides

Two halves of parental control, and they behave differently on purpose.

`U.isAdult` matches a name or a group. It is a guess, it applies to a whole
category, and its matches are **hidden outright** while `settings.parental` is
on — a visible-but-locked row in a category a child should not know about still
tells them it is there.

A **lock** is somebody pointing at one channel from the channel panel (right
arrow -> Lock with PIN). That one **stays in the list wearing a padlock and
asks for the PIN when somebody tries to watch it**. It was hidden like the
adult filter in 0.7.15 and that was wrong twice over: a lock that removes the
channel looks like a channel that has gone missing, and it gives the person who
set it nothing to point at. The lock is meant to be seen and to say no.

    Store.isHiddenChannel(pid, ch)   the adult filter — not listed at all
    Store.needsPin(pid, ch)          locked by hand   — listed, gated at play

The gate is `withPin(c, run)` in `views/channels.js`, and `play()` and
`playCatchup()` both call it themselves as a backstop, so a path that forgets
to ask cannot start a locked channel anyway. One correct PIN opens the session
— zapping past several locked channels is not a typing exercise — and Settings
-> **Lock now** closes it again, as does the next launch.

Three details that were bugs first:

- **Setting a lock must not open the session.** `Store.unlock` both checks the
  PIN and unlocks; locking a channel uses `Store.checkPin`, which only checks.
  With `unlock`, the channel just locked played without a word when you went
  back to it, which is exactly what a lock must not do.
- **Locking the channel that is playing stops it.** A lock that leaves the
  picture running is a lock in name only. So does Settings -> Lock now, for
  whatever is playing at the time.
- **Startup never demands a PIN.** `resumeLast` skips a locked channel rather
  than opening the app with an interrogation.

`C.reloadGroups` also keeps the cursor on the channel it was on. `applyGroup`
drops it at the top, which is right when the list has genuinely changed and
gratuitous when it has not — and locking a channel does not remove it.


Two details of the PIN prompt itself, both asked for after using it:

- **It submits on the fourth digit.** `U.numberPrompt` takes `opts.auto`, and
  every PIN prompt passes 4. Pressing OK as well could only ever mean "yes,
  those four". It is opt-in because a channel number has no known length.
- **A wrong PIN asks again** rather than closing, saying so in the sub-line.
  With auto-submit a single mistyped digit would otherwise drop the viewer back
  to the list to start over.

And which direction costs a PIN:

    lock a channel     PIN, unless the session is already open
    unlock a channel   PIN, always
    watch a locked one PIN, unless the session is already open

Taking a lock off is the protection going away, and a session left open after
somebody watched something is exactly when a child could do it. Putting one on
is protective, so locking a run of channels is not four digits each time.
## The cap keeps what is near now, not what arrived first

`maxPerChannel` exists so a seven-day window cannot cost a TV its memory. Which
programmes it keeps decides whether the guide is any use at all, and for a year
it kept the wrong ones: `if (arr.length < MAX_PER_CH) push`, i.e. the first N
seen. XMLTV is written oldest first, so a channel with fine-grained listings —
a music channel on five-minute slots, a news channel on fifteen — filled its
entire allowance with history and had **nothing on air and nothing next**. The
panel showed a column of finished programmes. Channels on hour-long programmes
never reached the cap, which is why it was only ever "some channels".

It keeps the programmes nearest to now instead: when the array is full, one
further from now makes way for one closer, and nothing else gets in. That
settles by itself into a window centred on the present — roughly half history
for catch-up, half schedule — whatever the channel's granularity, and neither
end can fill it up. With `maxPerChannel` of 60 against four days of five-minute
slots: 30 behind, 30 ahead, measured.

Two things this is not. It is not a sort — the array stays in arrival order and
is sorted at publish time as before. And it is not a second window: `lo`/`hi`
still bound what is considered at all, so the cap only ever trims inside them.



**A cached "no" used to outlive the channel it was about.** `keepFor(id)`
memoises whether a guide channel is one the playlist wants, because it is asked
once per programme and `U.matchKey` is not free. A channel whose id is not in
the playlist is recognised only by the display-name in its `<channel>` element
— so a guide that writes a channel's element *next to* its programmes rather
than putting every channel at the top gets a "no" cached before the element
arrives, and then drops every programme that channel has for the rest of the
file. The channel comes out blank. The cache is now dropped whenever a
`<channel>` turns a no into a yes.

What that cannot recover is a programme already scanned past: this is a
streaming parser and it does not go back. Buffering every programme for every
unknown channel is exactly the cost the `wanted` filter exists to avoid — a
provider guide carries ten times the channels of the package it is sold with.
So everything from the declaration onwards is kept and what came before it is
lost, which the unit test states rather than hides.

**The cap counts what it turns away.** `E.data.capped[id]` is how many
programmes a channel lost to `maxPerChannel`, and `E.coverage` carries it into
Settings -> Advanced -> Guide coverage ("352 kept, 900 trimmed"). Trimming is
fine; trimming invisibly is how "why has this channel only got old programmes"
became a mystery in the first place.
## Four silences, and how to tell them apart

"Why has this channel got nothing on air?" has four different answers and they
all look identical on screen — a panel of finished programmes:

    the guide never matched the channel        no <channel> the name maps to
    it matched something with no programmes    declared, never filled in
    its listings stop earlier today            a partial provider guide
    it is between programmes                   nothing wrong at all

Only the third and fourth are about time, and the app used to show all four the
same way. Two things now say which it is.

**The panel head.** While the cursor is in the panel it shows the day of the row
under it, since the panel reaches into yesterday and tomorrow. The rest of the
time, if nothing is on air, it shows the reason instead: `Guide ends 14:26`,
`Starts 15:56`, or `Nothing on air` for a gap.

**Settings -> Advanced -> Guide coverage**, from `EPG.coverage(channels)`. The
value is how many channels have something on air over how many there are; the
sub-line breaks the rest down; OK names the first few with the number that
answers the question — where their guide stops, or what they matched. This is
the row to read out when a block of channels goes quiet, because none of it can
be reproduced from a provider guide nobody here has.

`E.resolve` only ever matches a channel that has programmes, so `E.coverage`
consults the name index directly to separate "declared but empty" from "never
heard of it". They are different faults with different owners: the first is the
provider's guide, the second is usually a name that `U.matchKey` cannot bridge.
## The panel lands, it does not arrive and then settle

`#epg-list` has a 120ms transform transition so the rows slide when the cursor
moves through them. Moving the cursor down the *channel* list is not that: the
rows underneath have all been replaced, so animating the offset meant the new
guide appeared and then spent a tenth of a second finding its middle — which
reads as the panel lagging behind the list, and only on channels whose offset
differs from the one before (a short guide, an edge-clamped window). Hence
"sometimes".

`markGuide(animate)` decides. Cursor moves inside the panel and the wheel
animate; a channel change, a forced repaint and entering the panel do not.
`slideGuide` turns the transition off, writes the transform, forces a reflow by
reading `offsetHeight`, and turns it back on — without that read the browser
coalesces the two style writes and animates anyway.
## The side panels are read from a sofa

Both of them — the left drawer and the right channel panel — were 24px rows in
`--text-dim`, which is a colour for secondary text and not for a menu. They are
30px in `--text` on 88px rows now, and each row carries an icon in a column of
its own (`.mi-ico` / `.mi-label`, shared by both panels through `rowsHtml`).

The icons are emoji, which is a real risk on a TV: this app draws the heart,
the padlock and the replay clock in CSS precisely because no font on Tizen is
guaranteed to own a glyph. They are in a separate span for that reason — a set
without an emoji font loses a picture and keeps every word, rather than growing
a tofu box inside a label. If the TV does show boxes, the fix is to empty
`.mi-ico` in the CSS, and the labels stand alone.

## Reminders, and the way back into the guide panel

The panel under the preview is somewhere to go again. Right is not the way in —
right is about the channel — so there are two others, neither of which takes a
key from anything else: **INFO** (one press) and **Schedule** in the channel
panel. INFO used to raise a toast repeating the name of the row the cursor was
already on.

Inside it, up and down walk the nine programmes and **OK does what that
programme allows**, which is different in each direction of time:

    finished    -> replay it through catch-up (if the provider keeps it)
    on air      -> watch the channel
    still ahead -> remind me when it starts

Anything the panel does not handle falls through to the browse screen, so the
colour keys and the number pad still work from inside it.

A reminder is `{ chKey, chName, start, stop, title }`, identified by **the
channel and the start time** rather than by anything the guide handed over: a
re-read of the XMLTV rebuilds every programme object, so an id from one would
not survive the next refresh.

`App` checks the clock every 20 seconds rather than scheduling a timer per
reminder — a `setTimeout` four hours out does not survive the app closing, and
outliving that is the whole point. `Store.dueReminders` returns what has started
within a five-minute grace window and **drops anything older on the way past**:
a reminder for a programme that began an hour ago is an interruption, not a
reminder. It fires once, wherever the viewer is — `U.confirm` now takes button
labels, so the same dialog machinery says "Go to channel" / "Close" — and
`A.goMain` plus `Channels.tuneTo(key)` can bring them back from Settings, the
catch-up browser or another channel full screen. `tuneTo` resets the group and
the search before giving up, since the reminded channel may not be in the list
as it stands.

The panel holds nine programmes and shows five of them (see above), and the
replay clock on the finished ones is 19px rather than 13px, which is the
difference between a marker and a speck at three metres.


A reminder that goes off over a picture has to introduce the programme, not
just name it: the popup carries the channel's logo and the description the
guide gave, clamped to four lines. Both are stored with the reminder when it is
set — the guide may have been rebuilt or dropped by the time it fires — and
both are looked up again at the moment it fires, because a refresh since then
may have a better description. Stored is the fallback, not the source.

## Next steps

In rough priority order. Nothing here is started.

1. **Sign the package and sideload it.** `npm run pack` builds the .wgt here;
   the TV takes it only once it is signed with a Samsung certificate profile
   (Tizen Studio's Certificate Manager, a Samsung account, the TV's DUID) —
   none of which can be produced from this machine. Everything below is
   guesswork until the app has run on the actual TV once.
2. **Verify on the TV**: interlaced channels (should play, unlike in Chrome),
   `.ts` streams, AVPlay display methods for Picture size, and whether the
   remote's Guide/colour buttons map as `keys.js` assumes.
3. Multi-playlist switching — the store already holds an array of profiles;
   only the switcher UI is missing.
4. Recording (needs Tizen filesystem privileges), PiP, multi-view.

## The guide is unzipped by the app, and read as it arrives

Two things stood between a provider guide and a TV, and both are now handled in
`js/inflate.js` + `Net.guide` + `EPG.stream`.

**No Samsung TV before 2022 can unzip a .gz.** `DecompressionStream` landed in
Chromium 80; Tizen 4 (2018) is Chromium 56, 5.5 is 69, 6.0 is 76. The old code
asked the platform and gave up when it was missing, so on the user's own set
the guide could not be read at all and every channel reported "No guide for
this channel" — with the reason logged and never shown. `inflate.js` is a
plain-JS DEFLATE decoder (the RFC 1951 table-per-length shape) that removes the
dependency entirely. It is tested byte-for-byte against Node's zlib at four
compression levels, over stored blocks, long back-references, non-Latin text,
and every slab and window boundary — if it is ever touched, run those first.

**A 242 MB string is not survivable on a TV**, which is what `Net.text` used to
build before `EPG.parse` saw a byte of it. The decoder hands out 1 MB slabs
keeping only the last 32 KB (as far as a DEFLATE back-reference can reach),
`Net.guide` turns each slab into text, and `EPG.stream` scans and drops it.
Nothing holds more than the piece in hand plus the programmes kept. `EPG.parse`
is the same scanner fed the whole string in 2 MB pieces, so the two paths
cannot drift apart.

Gzip is detected by its magic bytes, not by the URL: the dev proxy gunzips
anything ending in `.gz`, so in a browser the app receives plain XML anyway,
and a provider serving compressed bytes under any other name still works.

Both halves of that cost the app its responsiveness once, so both are guarded
by tests that fail loudly if they come back:

- **The scan must stay linear.** The whole-string parser had sticky
  "no more channels / no more programmes" flags; the streaming one lost them,
  so the search for the next `<channel` ran to the end of the buffer for every
  programme in it. A 53 MB guide took 41 seconds instead of three. The flags
  are per-piece now (`noProg`/`noChan` in `scan`), which is sound because
  `pos` only moves forward.
- **The unpacking must yield.** `Inflate.gunzip` is synchronous and calls back
  per slab, so with the scan hanging off it the whole guide was decoded and
  parsed in one unbroken turn — 41 seconds of frozen screen, whatever the
  viewer pressed. `Inflate.gunzipAsync` pauses between symbols (the decoder
  keeps its state on the object for exactly this) and resumes on a timer, and
  `Net.guide` does the same on the uncompressed path.

Measured after both: a 218 MB guide with 887,000 programmes is ready in 2.6 s
with the longest frozen stretch at 193 ms, against 41 s and 40,760 ms before.
The freeze does not grow with the file any more, which is the property that
matters.

Guide failures are no longer silent. `App.epgError` holds the reason, the panel
shows "Guide unavailable — ..." instead of blaming the channel, and a toast
names it once. A guide that never loads is not the same as a channel the guide
does not cover, and the app must not make them look identical.

## The app shapes the picture; the TV only places it

Three attempts went into the picture being the wrong size on the TV, and the
lesson is in the shape of the fix rather than in any one bug.

AVPlay takes a display **method** (how the picture fills its area) and a display
**rect** (where that area is), and the two argue. On the user's set
`AUTO_ASPECT_RATIO` — which is what "Original" mapped to — would not scale a
720p stream up to a 1080p rect, so fullscreen appeared to do nothing;
`LETTER_BOX` letterboxed against the whole screen instead of against the rect,
so the preview showed a crop of the middle of the picture. Meanwhile the same
setting in the browser was `object-fit: none`, which pins the video to its coded
size — the identical bug on the other player.

So the app stopped asking the player to shape anything. The method is always
`PLAYER_DISPLAY_MODE_FULL_SCREEN`, which means "fill exactly the rect you were
given", and `P.fitBox()` works out a rect with the *source's* aspect ratio
inside the destination box. That is right whether or not a set honours the rect
only in FULL_SCREEN, which is what makes it safe to ship without a TV to try it
on. The source's shape comes from `getCurrentStreamInfo()`, falling back to
16:9 before a stream is prepared.

"Original" is gone. The three modes now mean the same thing on both players:
fit (whole picture, letterboxed), fill (cover, cropping — fullscreen only,
where the overflow leaves the screen instead of covering the channel list) and
stretch. Anything still holding `original` in localStorage is migrated to fit.

`P.fitBox` is pure arithmetic and is unit-tested, because it is the thing that
decides what the viewer actually sees and none of it can be observed here.

## The display rect is a race on the TV

`Player.setMode` moves the picture. In a browser that is inline CSS and always
works; on Tizen it is `avplay.setDisplayRect`, and AVPlay refuses it while a
stream is still opening — it throws, and a caught throw is silent. A TV takes a
second or two to prepare, which is exactly when someone presses OK a second
time to go fullscreen, so the press was being dropped and the picture stayed
preview-sized on a black screen. Sometimes. That "sometimes" was the giveaway.

`applyRect()` now remembers a refusal, and the rect is re-stated at all three
points where the player will finally take it: after `prepareAsync` succeeds,
after `play()` (some sets reset the plane), and when the first frame reaches
the screen (`Player.settle()` from the `playing` event). None of this can be
tested here — the browser has no AVPlay — so it is written to be idempotent
and stated more often than should be necessary.

## The guide loads in front of the viewer, not before them

A provider guide takes tens of seconds to read on a TV, and the app must not be
a loading screen for that long. Four things make it bearable, in order of how
much they matter:

1. **The list never waits for the guide.** `loadProfile` drops the loader as
   soon as the playlist is parsed; `loadEpg` runs behind the browse screen.
2. **A cached guide is used immediately.** `EPG_TTL` is 12 hours, and anything
   older than `EPG_FRESH` (2 hours) is re-read quietly *behind* the guide
   already on screen. Only a genuinely cold start waits at all. It used to be a
   one-hour TTL, which meant paying the full cost most launches.
3. **It publishes as it reads.** `EPG.stream` hands the guide over every 400 ms
   (`opts.publishEvery`, and `onPartial`), sorting only the channels that
   changed. Rows fill in over the load instead of appearing at the end. A
   background refresh passes no `onPartial`: replacing a complete guide with a
   partial one would empty rows that currently have programmes in them.
4. **`E.resolve` caches per generation.** Every publish bumps `E.data.gen`, and
   a channel's resolved id is only reused while the generation matches —
   otherwise a channel that had no match at second three would be remembered as
   having none for the rest of the session.

Measured on a 40 MB guide in a browser: list on screen at 130 ms, first
programmes at 270 ms, complete at 500 ms, second launch 125 ms from cache.

## What the guide costs, and where

Profiled on a guide of the user's shape (1,275 channels, 126 of them theirs,
a week of history): unpacking 34%, UTF-8 decoding 17%, scanning 49%. Two
optimisations came out of that, both worth keeping in mind before adding work
to either loop:

- **The scan rejects on the channel first.** Nine programmes in ten belong to a
  channel the playlist does not have, and deciding that costs one string
  compare instead of two date parses. Attributes are read in place with
  `attrAt` rather than by slicing the tag out — at a few hundred thousand
  programmes that is a few hundred thousand temporary strings.
- **The decoder holds its bit reader in locals.** `symbol()` runs for every
  byte of output, and literals and matches write straight into the sink's
  buffer instead of through a method call per byte.

Together: 675 ms -> 332 ms for the same 56 MB guide, unpacking at 500 MB/s.

## A recording seeks; a live channel restarts

Two different things wear the same keys. A film or an episode has a real
duration, so left/right move through it by 30 seconds and the rewind and
fast-forward keys by five minutes — `Player.seekTo` sets `currentTime` in a
browser and calls `avplay.seekTo` on the TV. A live stream has no timeline to
move through: its "position" is a place in a sliding window, so winding back
restarts it from a catch-up URL instead (see the timeshift notes).

Which of the two this is comes from **the media, not the list it came from**:
`Player.seekable()` is `duration() > 0`, which is false for live HLS in a
browser and 0 from AVPlay on a live stream. That also settles what the info bar
shows — a position and a length instead of a programme, and no LIVE chip on
something that has no live edge — and what right does in fullscreen: fast
forward on a recording, the channel panel on a live channel.

**A film cannot be sought unless the server answers range requests.** The dev
server did not, so the picture simply refused to move and it looked like the
seeking was broken. `serveStatic` speaks `206`/`content-range` now, covered in
`test-proxy.js`. Providers all support it; this was only ever a local problem,
but it is the sort that costs an hour.

## Opening a channel quickly

Three things decide how long a channel takes to appear, and only the first is
in the app's gift:

- **How much the player insists on buffering before it will show anything.** A
  Samsung set left to itself holds a lot, so `startTizen` sets it explicitly
  even for "auto" (2s to start, 4s to recover; "small" is 1/3, "large" 5/8).
- **Which rendition it starts on.** `STARTBITRATE=LOWEST` — a channel that is
  soft for two seconds beats one that is sharp in five. The browser path does
  the same with hls.js `startLevel: 0` and a short `maxBufferLength`.
- The provider and the network, which are not ours.

## Dialling a number plays it

Typing a channel number used to move the cursor and wait for OK. It plays now.
The rule that nothing starts on its own is about *moving the cursor* — asking
for a channel by number is as deliberate as pressing OK on its row. Several e2e
sections had to learn this: they dial to navigate, and now that dialling plays,
they stop playback first when the point of the test is that nothing is on.

## Right is about the channel

Right from the channel list opens a panel down the right-hand edge — the
channel's name and number, then what you can do with it: go full screen, see
what's on, open the catch-up guide, add or remove a favourite, lock it behind
the PIN. It is `pane === 'ctx'` in `views/channels.js`, and it is the same shape
as the left-hand drawer so the two read as a pair.

The guide panel under the preview was read-only for several versions, because
right was the only way into it and that key was wanted here. It is a place
again in 0.7.15, reached by INFO or by the panel's own "Schedule" row — see
"Reminders, and the way back into the guide panel". Right still does not go
there: right is about the channel, and its schedule is one of the things the
channel offers.

## The TV catalogue is a channel and an evening

The guide panel beside the player shows nine programmes of the channel under
the cursor, which is a glance. The catch-up browser shows one channel's past.
Neither lets somebody sit down and read an evening, so `views/catalog.js` does:
every channel down the left, and the whole schedule of whichever one is
selected down the right, as far ahead as the guide reaches.

**It was built the other way round first** — hours down the left, every channel
with something starting in that hour down the right — which answers "what is on
at eight". That is a fair question and it was not the one being asked. Turning
it round threw away most of the implementation with it: there is no
cross-channel scan any more, so the binary search over five thousand programme
lists went, and what is left is `EPG.list()` for the one channel the cursor is
on.

**Which side is windowed swapped too.** The playlist can be five thousand long,
so the channel column is a pool of sixteen rows moved and refilled, the same
as the browse list. One channel's schedule is tens of programmes, so it is
painted whole — and only when the channel changes, because walking the cursor
down a hundred programmes must not rebuild them a hundred times.

**It opens on the channel being watched**, so it starts where the viewer
already is rather than at the top of a list of thousands.

The schedule is broken by day, because one that runs past midnight otherwise
counts back to nine in the morning with no explanation. Where the cursor is has
to be read off the element rather than worked out from an index — the day
headings make the rows an uneven ladder, and `idx * ROW_H` stops being true the
moment one appears.

OK does what OK does in the guide panel: watch it if it is on, replay it if the
provider kept it, be reminded if it has not started.

## The drawer holds what is nowhere else

Left from the groups rail opens a drawer, and it used to offer Favourites and
Recently watched — which are the first two rows of the rail the viewer has just
walked through to reach it. Two ways to the same place, one of them further
away than the other. They are gone; what is left is Search, Catch-up, Settings,
Reload playlist, Exit, and the keyboard reference off the TV.

`goGroup()` went with them. It existed only to serve those two rows.

## The head of the list is a clock

A television is also the thing people look at to find out the time, and the
head of the channel list was the emptiest, most looked-at strip on the screen —
carrying one line that said "ALL CHANNELS", which is the thing the viewer is
least likely to be wondering. The time and the date lead now, at 42px, and the
name of the list sits under them: it still has to say which list this is, it
just is not the headline. The head grew from 96px to 132 and the scroller
starts lower to match.

Ticked every ten seconds rather than every minute, because a clock that is a
minute behind is worse than no clock, and a text write costs nothing beside
what the guide tick already does. `Channels.show()` paints it too — coming back
from Settings after five minutes must not show the time it was when you left.

## The wordmark, and where it goes

`img/logo.png` is the first thing in the package that is neither markup, style,
script nor a launcher icon: the wordmark on transparency, 900px wide because
the largest place it is drawn is 680 and the app draws in a fixed 1920x1080
with no second density to serve — headroom over the largest use and no more.
It is 135 KB, which is real weight in a 745 KB package and was the price of
asking for a bigger logo; PNG has no quality dial, and quantising a smooth
gradient to a palette bands it visibly on a television.

It replaces the playlist's name at the head of the groups rail. The name is the
one thing on that screen the viewer already knows — they typed it — and the
rail head is the most looked-at corner of the app. The name is still in the
drawer's foot, where it answers "which playlist is this" for somebody who has
more than one.

The drawer gets it too, where the app's name used to be spelled out in
letter-spaced capitals — which is a wordmark drawn badly.

Settings gets it twice: small at the top left, so the two screens are
recognisably one app, and large to the right of the rows. Making that one 680px
took narrowing the rows from 1100 to 980, which was worth doing on its own:
the value floated to the far end of 1100px, so the eye had a very long way to
travel from a label to what it was set to.

Adding it meant `img/` had to be staged by both packagers — the .wgt's file
list and the APK's Gradle copy — and the test that keeps those two lists
agreeing had to learn about it, which is exactly what that test is for.

## Settings is read from a sofa too

It was the one screen still written at desktop sizes: a 26px label over an 18px
sub-line in the dimmest token the app has. Both went up a size and a contrast
step.

Every row is bold. The three people actually come here for — **Playlist**,
**Language**, **Theme** — are *larger* rather than heavier, at 30px against 27.
Weight was the difference at first and stopped being one the moment everything
got it: a list where the only distinction is weight and everything has it has
no distinction at all. Their value was in the accent colour for a while too,
which read as a link rather than a setting — it is the same colour as every
other value now, and an e2e assertion holds it there.

The sub-line had to be told not to inherit the weight, because it lives inside
the label element — a bold explanation under a bold heading is two headings.

## A list, where a cycle was ten presses

Every settings row was a cycle: left and right step through the values. That is
right for two or three of them and wrong for ten. Overshooting the language you
wanted meant nine more presses to come back round — in a language you may no
longer be able to read, which is exactly the state somebody is in when they are
on that row.

`U.pick(title, items, current, cb)` is a list over whatever asked for it, keyed
like the other overlays: `keys.js` checks `U.pickOpen` before it hands anything
to a view, so nothing underneath has to know it is up. Back closes it without
changing anything, which a cycle cannot offer — a cycle has already changed the
setting by the time you see what it did.

The test for it picks Spanish through the list and then puts it back through
the same list, which is the only way to know the thing is usable by somebody
who cannot read what is on it.

## Six ways to write a date

Nobody agrees and everybody is sure, so `settings.dateFormat` has six values
and `U.dateLabel(date, fmt)` renders them. Not read off the locale: that would
be guessing at the viewer from the language their television is set to, and a
Brit with an American set would get the wrong one with nowhere to say so.

The row shows **today** written the way each format writes it, rather than a
named convention. That started as six example strings — "29/08/2026",
"Saturday 29 Aug" — which went through the translator because every cycle label
does, so nine dictionaries were being asked to translate a worked example of a
number format. Rendering the real date costs no strings at all and answers the
question the viewer actually has, which is what it will look like.

The formatter lives in `util.js` because two screens need it, and a second copy
of "how do we write a date" is how the two of them drift.

## Search came off the rail

The foot of the groups rail had two rows, Search and Settings. Search is on the
green button, it is in the drawer, and it is reachable from anywhere — a third
way in cost a row at the foot of every screen and one more stop for the cursor
to pass through on its way to Settings. `RAIL_FEET` is one entry now.

The three dots beside Settings became a settings mark while that was open.
Sliders rather than a gear: a gear is a ring of teeth and reads as a smudge at
three metres, and the dots were never a settings mark in the first place —
three dots means *menu* everywhere, which is the wrong promise for a row that
opens settings. Six shapes are needed and a span carries three, so the other
three are box-shadows of those.

## The rail folds, and carries its own buttons

The groups rail is 280px while the cursor is in it and 26px when it is not
(`#stage.rail-in`), with a chevron for a handle and its contents faded out —
half-clipped group names read as a rendering fault rather than as a drawer.
The channel list takes the width back.

**The fold does not animate**, and that is the third answer rather than the
first. It was 180ms, then 110ms, and both looked laggy for a reason no
duration could fix.

The same keypress that folds the rail also calls `repaintAll()`, which
re-stamps eighteen channel rows, twelve group rows and the preview block. A
CSS transition's clock starts when the class is set and keeps running while
the main thread is busy, so the first frame the viewer actually sees is the
animation already part-way through. Traced on a 5,000-channel list, frames
landed at 3ms and 7ms and then not again until 21ms, by which point the rail
had jumped from 39px to 90px. On a television, where that re-render costs ten
times as much, the jump *is* the animation.

There were two ways out. A `transform` would have been immune to it —
compositor animations do not care what the main thread is doing — but this
fold cannot be expressed as one: the channel list does not slide out of the
way, it takes the 254px, and that is a layout change whatever property asks
for it. So the other way. One paint, no clock to fall behind.

What it bought, over eight folds of a 5,000-channel list:

    layout passes   190  ->  8      (one per fold, which is the floor)
    layout time     64ms ->  4ms
    worst frame     14.9ms -> 3.7ms

The measurement is the point. Animating `width` and `left` had been costing a
relayout of the whole list on every frame of the transition, and the fix was
not a faster easing curve — it was noticing that the transition was the thing
asking for the work.

Neither side panel is animated either. The drawer and the channel panel are a
`.hidden` class each: they are answers to a button, and an answer that slides
in is an answer that arrives late.

Two fixed rows live at its foot, below every group: **Search** and
**Settings**, walked into with down from the last group (`railFoot`: -1 nowhere,
0 search, 1 settings). Search used to be a box permanently across the top of
the channel list; now the list shows which list it is, and the box appears only
while it is being typed in. An input that is `display:none` cannot take focus,
so `enterSearch` reveals it before asking it to.

## Lists wrap, and Home and End exist

Up from the first channel goes to the last and down from the last comes back to
the first, in the channel list and in the channel-numbers screen alike. On five thousand channels the ends are otherwise a very long way
apart. Up from the first row used to open the search box, which is why search
moved somewhere it can be seen.

## A refusal that says which thing is missing

"This channel cannot be rewound" is true and useless: it reads as the app
failing rather than as the provider not offering something. Both places that
refuse — `scrub()` on a channel with no catch-up, and `playAt()` when no URL
can be built for a moment — now say **"This channel cannot be rewound — it has
no catch-up"**, borrowing the wording `playCatchup()` already uses one function
away rather than inventing a second way to name the same thing.

It is one constant, `NO_CATCHUP`, because two call sites saying the same thing
in two string literals is two things to keep in step. That puts it out of reach
of the key scanner in `test-units.js`, which reads `T('...')` literals — so it
is listed in `I18N.EXTRA`, which is what that list is for.

## Two channels cannot share a number

Numbering a channel onto a number that is already taken offers to **swap** the
two rather than duplicating it: a duplicate cannot be dialled, because the
remote reaches whichever the list happens to hit first. `rowWithNumber` checks
the numbers actually on screen, not just the overrides, since most channels are
on the number the playlist gave them.

**Typing the original number back is not a change.** It was stored as an
override like any other, so the number stayed amber and the Reset row kept
something to undo that would have undone nothing — which reads as "putting it
back did not work". `Store.setChannelNumber(pid, key, n, orig)` takes the
playlist's own number as a fourth argument and clears the record instead of
writing it. Both painters were also asking the wrong question: they marked a
number as changed when a record existed, not when it differed, so they check
the value now and a playlist numbered this way before today comes out right
without a migration.

## What the guide keeps, and for how long

`EPG.parse` keeps the **description** — and nothing else beyond title and
times — **only** for programmes that overlap [now-2h, now+12h], the window the
info bar can ever show. Descriptions are the biggest thing in an XMLTV file;
keeping one for every programme in a seven-day window would multiply what the
guide costs on a TV for text nobody will read. They are trimmed to 260
characters.

Category, episode number, year, ratings and cast were parsed and shown as a
line of chips under the info bar for one version. They came out again: over a
picture someone is trying to watch, that is trivia in the way, and a guide that
carries what no screen reads is memory a TV cannot spare. The bar shows what is
on, what it is about, and what is on next.

## The info bar has three sizes, and they are the ranking

What is on (42px), what it is about (23px), what is on next (20px, dimmed).
The order is deliberate and was arrived at by getting it wrong: "next" was
25px at full strength, which made it the second-loudest thing in the bar and
put the eye on the programme that has not started yet. It keeps its coloured
NEXT tag — that is what makes it findable at a glance — and gives up the size.

The description is the line people actually read, so it is the one sized to be
read over a moving picture: 23px/31px, a `max-width` of 1080px so the eye can
find the start of the second line, and a two-line `-webkit-line-clamp` that
ends in an ellipsis. It used to be a bare `max-height`, which cut the second
line through the middle of the letters. `.osd-desc:empty` is hidden, because no
description and an empty line of one are not the same thing.

`.osd-row` (268px) and `#osd` (344px = 268 + 2 x 38 padding) are sized to the
six rows above at the sizes above; nothing computes it, so anything added to
the bar has to grow both or the bottom row ends up against the screen edge —
which is worse on a TV than it looks in a browser, because of overscan.
Measured after the change: the NEXT line ends 38px clear of the bottom.

## Settings does not stop the channel

Opening Settings used to call `Player.stop()`, so changing one row cost the
several seconds it takes to open the stream again on the way back. A television
menu opens over what you were watching and leaves it running, and that is what
this does now: the sound carries on, and `Channels.hide()` takes the video
layer with it so the picture is put away.

That last part is only needed in a browser, where the video is a real element
sitting *above* the panes and would otherwise float over the settings screen.
On either TV the picture is behind the page and those screens paint their own
opaque background over it, so hiding the layer changes nothing there. It also
means the same line fixed the catch-up browser and the catalogue, which had the
same problem and nobody had noticed.

It makes the picture-size row honest as a side effect: it now applies to a
player that is actually running, rather than to the next one to start.

## The overlays keep the dark palette in both themes

`#osd`, `#zap` and `#ts-clock` sit on a dark scrim over a broadcast picture,
and a picture does not turn white to suit a theme. Light-theme text there is
near-black on near-black — the info bar was, quite literally, invisible in the
light theme. They now re-declare the dark palette's `--text*` and `--accent`
on themselves, which fixes every descendant at once rather than colour by
colour. An e2e section asserts the direction (bar text light, page text dark,
and the ranking title > description > next), because the exact hex will move
and the relationship must not.

The light theme itself has come down three times: #dfe4ed -> #ccd3df in
0.7.14, and #ccd3df -> **#b4bdcb** in 0.7.28, with `--bg-2` and the body
following each time. The first two attempts were still trying to be *light*,
which is the mistake — 55 inches of pale grey-blue in a dark room is a lamp
pointed at the viewer, and reading "still too bright" twice is what it took to
stop treating brightness as the goal. What it is now is a mid grey-blue with
near-black text on it, around 9:1, so nothing was traded away for it: the
contrast went up as the surface came down.

The e2e section on it asserts a band rather than a value — light enough not to
be the dark theme, dark enough not to be paper — so a fourth step down would
still pass and a return to white would not.

## Back takes one layer off at a time

With the info bar up, back closes the bar and leaves the picture; with the bar
gone, back leaves fullscreen. The same in the series player: bar, then the
episode, then the series. EXIT and STOP stay blunt and go straight out —
someone who wants out of the picture has a key that does it in one.

This is why several e2e sections press back twice where they used to press it
once: `enterFullscreen` shows the bar, so anything that enters fullscreen and
then leaves it needs both presses.
## A dialog with no CSS is a frozen app

The number prompt (`#number`) sat in `index.html` from the beginning with **no
styling at all** — unstyled blocks in the top-left corner of the page. While it
is open it takes every key, so from the channel-numbers screen it read exactly
like the app hanging: press OK, nothing appears, nothing responds.

Underneath it was a second bug of the same family. `paintNumber` toggled a
class called `empty` on the big number, and `.empty` is already the app's
"nothing here" placeholder — `position:absolute; top:46%`. So even once styled,
the digits were thrown out of flow and landed on top of the key hints. The
class is `num-empty` now. **Generic class names in a single global stylesheet
collide**; when adding a state class, scope it to its component.

The e2e suite now asserts the prompt is on screen, centred, above everything,
and that its parts are in flow in the right order. A dialog that cannot be seen
is worse than no dialog, because it still has the keys.

## Channel numbers moved into Settings

`views/numbers.js` is a screen of its own: every live channel, the number it is
on, and a marker on the ones that have been changed. OK sets a number, red puts
the playlist's back. It replaced the blue button on the browse screen, which
hid the one piece of setup people do once behind a coloured key they had to
know about.

It keeps its own fourteen-row pool rather than borrowing `VList`, which lives
inside `views/channels.js` — sixty lines of windowing against exporting the
list machinery and coupling two screens together.

## The stream warning is a button

"Stream is behind" is reachable: up, in fullscreen, puts the cursor on it and
OK restarts the channel at the live edge. It is the only thing in the app that
is focused with up rather than being part of a list, which is why the badge
grows a hint ("OK for live") when it has the cursor. Anything other than OK
lets it go. The same jump is in the channel panel as "Back to live" whenever
`isBehind()`, and a mouse can simply click the badge.

**And in the info bar, for the other way of being behind.** The badge is for a
stream that fell behind on its own; winding a channel back with the seek keys
is deliberate, and the way back from that used to be the channel panel — two
presses and a menu, for something the viewer just did. `#osd-back` is a red
"Back to live" pill next to the channel number, reached exactly as the badge
is: up focuses it, OK returns to live, anything else lets it go.

It was outlined and 17px first, which is a desktop button: on a television it
was a thin red line beside a number. Filled, 24px, and focus **inverts** it to
white on red with a red ring — a red button that only goes slightly redder is
not a state change anybody can see from a sofa. An e2e section asserts the two
states and that it sits on the channel number's own line rather than taking a
line above the channel name.

It is painted with the bar rather than on its own, which decides the rest of
its behaviour: it exists only while the bar is up, `hideOsd` drops the focus
with it, and focusing it calls `showOsd` again so the bar does not time out
while it is being aimed at. It is hidden for a recording — `Player.seekable()`
is true there and there is no live edge to go back to.

## Diagnostics, because the TV cannot be watched from here

Settings ends with rows fed by `Player.diag()`: the window size and stage scale,
the mode, the rect that was asked for and the rect that was applied, the display
method the set accepted, the source's own resolution, the player state, and the
last error AVPlay returned. Three rounds of guessing at second hand is what they
are for — when the picture is wrong, that screen says why.

## Android TV is the same app behind a different shell

`android/` is a Kotlin project whose entire job is to give the web app three
things a browser will not: a decoder of its own, HTTP without an origin
attached to it, and the keys off a remote. It is about 700 lines. Everything a
viewer sees is still `app/`, staged into the APK's assets by Gradle, so there
is one copy of the app and one set of tests over it.

That was the plan written down long before it was needed, and it survived
contact: `player.js` and `keys.js` were the only files that touched a platform,
plus `net.js`, which already had a switch for its own dev proxy.

### Why a WebView and not a rewrite

The alternative is Leanback and Compose and a second UI, and then two of
everything: two channel lists, two guide panels, two sets of nine
dictionaries, two lots of the arithmetic that decides where a picture goes.
The web app is 800-odd tests deep and none of them would have come along.

The WebView is also a much better one than Tizen's. Chromium 56 is the floor
the app is written to; Android TV boxes ship something far newer, so nothing
had to be given up to run on both.

### isTizen meant two things, and now says which

Nearly every `isTizen` in the app did not mean "this is a Samsung set". It
meant "there is a real player behind the page rather than a `<video>` in it",
which is now true of two platforms and false of one. Those became `isTV`:

    U.isTizen     this is a Samsung set
    U.isAndroid   this is the Android shell   (the bridge object is the tell)
    U.isTV        either of the above
    U.platform    'tizen' | 'android' | 'browser'

Of the twenty-eight uses, three stayed `isTizen` — the AVPlay calls, the
Tizen key registration, and the settings row that names the platform. The rest
were about capability all along. The CSS went the same way: the `.tizen` rules
that keep the page from painting over the video plane are now `.tv`, because
they were never about Samsung either, and `app.js` stamps both a platform class
and a `tv` class so a rule that really is about one set still has somewhere to
go.

### The picture: the app decides, the shell places

This is the part that mattered most, and it was already right.

On Tizen the app works out the picture's rectangle itself — including the
letterboxing, from the source's shape and the viewer's picture-size setting —
and hands AVPlay four numbers, because every time the platform was asked to
shape the picture as well, the two fought and something was cropped or refused
to scale. Android gets exactly the same treatment: ExoPlayer draws on a
`SurfaceView` that is moved and resized to the rectangle and stretches the
video to fill it, and nothing on the Kotlin side has an opinion about aspect
ratio at all.

So a 4:3 channel fullscreen arrives as `setRect(240, 0, 1440, 1080)` — pillars
either side because the app put them there. There is a unit test that says so,
and another for a window that is not 1920x1080, where the page's fixed
coordinate space and the window's real pixels stop agreeing.

### Three problems the shell solves

**A decoder.** ExoPlayer (Media3) on a `SurfaceView` underneath a transparent
WebView, which is the same arrangement as AVPlay's hardware plane behind the
widget. `PlayerBridge` is the `AquaPlayNative` object `player.js` calls, and
its events are named the way AVPlay names its own so both TV paths report the
same things and nothing upstairs can tell them apart.

Two rules run through it. Commands are posted to the main thread, because
ExoPlayer may only be touched on the thread that built it; questions are
answered from a snapshot the main thread keeps up to date, because a getter
that blocked would deadlock the page the first time the main thread was busy
opening a stream. And `durationMs` returns zero for anything live —
`player.js` turns "has a duration" into "can be sought", and ExoPlayer's
`TIME_UNSET` is a large negative number that would otherwise sail through as
truthy and offer a scrub bar over a window that keeps moving.

**HTTP with no origin.** The page is served from `appassets.androidplatform.net`
over https — a real origin, so `localStorage` persists and the app is not a
special case of itself — and every external request is answered by `NetBridge`
in `shouldInterceptRequest` rather than by the WebView. A page has an origin
and a provider has never heard of CORS: left alone, the request goes out, the
playlist comes back, and the WebView throws it away unread. Answering it
ourselves means the response can say what it needs to about origins, which is
the same thing `<access origin="*">` does in config.xml. `net.js` therefore
switches its dev proxy off on Android exactly as it does on Tizen.

Two details in there are load-bearing. `Accept-Encoding: identity`, because a
`WebResourceResponse` body is handed to the WebView as-is and a gzipped stream
forwarded with the header intact arrives as noise. And redirects are followed
by hand, because `HttpURLConnection` refuses to follow one that changes
protocol and http → https is exactly what a catch-up URL tends to do.

**The remote.** Split in two, on purpose. The D-pad, Enter and the number keys
reach the WebView as ordinary DOM keydowns and are left entirely alone —
`keys.js` already knows what to do with an arrow, and routing them through
Kotlin would mean reimplementing "is a text field focused" over there. BACK,
the media transport, the coloured buttons and INFO/GUIDE never arrive at all:
Android takes them first. Those are translated in `dispatchKeyEvent` into the
same action vocabulary and injected through `Keys.inject()`, which is the door
every other key already comes through.

`Keys.inject` drops an action it does not recognise, because the shell is the
one caller that can invent one. A unit test reads the Kotlin table, checks
every action in it is one `keys.js` accepts, and checks the D-pad codes are
*absent* — a D-pad routed through Kotlin is a text field that cannot be typed
in, and that is a bug you only find on somebody's sofa.

### One version, one file list

`build.gradle.kts` reads the version out of `app/config.xml` and derives the
version code from it, so there is one number to bump rather than two. A unit
test runs the Gradle file's own regular expression against config.xml and
checks it still finds the version the rest of the project is on — a reformat of
that file will fail the suite instead of quietly shipping an APK numbered zero.

The same test compares the APK's staged file list against `pack.js`'s `STAGE`.
Two packagers shipping different subsets of the same app is the kind of
difference that surfaces as one bug report nobody else can reproduce.

### Cleartext is not optional

IPTV providers are overwhelmingly plain http, and Android has blocked
cleartext by default since Pie. `network_security_config.xml` permits it.
Refusing would not be a security posture; it would be an app that cannot reach
most playlists.

### The icons

`make-icon.js` grew from the same artwork as everything else: a 320x180
launcher banner, the square launcher icon at four densities, and an adaptive
icon's foreground layer. The banner is the large logo again at a twentieth of
the size and flattened, because an Android TV tile is opaque — the wordmark is
composited over the vignette in the build rather than shipped as a second file.
An app with no banner does not appear on the Android TV home screen at all.

**The adaptive icon is not optional.** From API 26 a launcher draws the icon
itself from two layers and masks them to whatever shape it likes; an app that
supplies only a legacy PNG gets that PNG *shrunk* into the middle of a
generated shape. Which is exactly what "the icon looks too small" turned out to
mean. `mipmap-anydpi-v26/ic_launcher.xml` names a flat background colour and a
foreground drawn on 108dp of canvas, of which only the middle 72 is guaranteed
to survive — so the mark is 60% of it, well inside. A flat colour rather than
the vignette, because a launcher may slide the two layers against each other
and a gradient moving under a wordmark looks like a printing fault.

### The icons were also too small on purpose, by accident

The application icon was a *crop* of the artwork, and a crop cannot make the
mark any bigger than it already was in the square it came from: 86% of the
width and 34% of the height, with 140px of empty vignette above and below.
Composing it instead — the same way the banner already was — makes the share a
number somebody chose. At 0.94 the mark went to 93% of the width and the side
margins halved.

The height did not move much, and cannot. The wordmark is 3.1:1 and the tile is
1.21:1, so a mark that fills the width is about 37% of the height and the band
above and below it is the shape of the artwork rather than a mistake in the
build. Filling a squarish tile needs a squarish mark — a monogram, which this
artwork does not contain separably: the wave runs through all four letters, so
there is no column gap to cut the A out on.

A unit test asserts the width the mark covers, because "it looks small" is a
claim about a ratio and a ratio can be measured.

### What the compiler found

It builds. `app-debug.apk`, 4.9 MB, version code 70029 and version name 0.7.29
both read out of config.xml, leanback-launchable, with all 22 files of the web
app inside it. The toolchain went in for it: Temurin 17, the Android SDK with
platform 34, Gradle 8.7, and a wrapper generated from that.

Three things were wrong that no amount of reading had caught, and all three are
the kind that only a compiler or a launch can tell you:

- **A Kotlin raw string cannot end with a quote.** The regular expression that
  reads the version out of config.xml ended with one, so the closing delimiter
  swallowed it and the string ended a character early. The quote is a character
  class now. Worse, the unit test *passed* on it — it extracted the pattern with
  a lazy match that stopped at the very quote that was the problem, so it was
  testing a shorter regex than Kotlin would ever see. That test is anchored now
  and asserts the pattern does not end on a quote.
- **AppCompatActivity throws on a theme that is not AppCompat.** The theme here
  is Material, deliberately, and nothing in the app used AppCompat at all — so
  the activity is a plain `Activity` and the dependency is gone. This one would
  not have failed the build; it would have failed a second after launch.
- **Int literals do not assign to Long.** `coerceAtLeast(0)` on a position in
  milliseconds, four times over.

And one thing that looked right and was cargo: `-opt-in=…UnstableApi` as a
compiler flag. Media3 1.3's `@UnstableApi` is not a Kotlin opt-in marker, and
the compiler said so about the flag itself. The annotation on the class is what
Android Lint actually reads; the flag is gone and the test checks the
annotation instead.

### What a device still has to say

Compiling is not running. In rough order of how likely they are to be wrong:
the surface's z-order against the WebView on a particular box, which
colour-button keycodes a given remote actually sends, whether
`setForceLowestBitrate` releasing after four seconds is soon enough to matter,
and how the shell behaves when a stream ends while the app is in the
background.

## Known gaps

- The package is **unsigned**, and that, not the App ID, is what stops a TV
  install. `npm run pack` (`tools/pack.js`, Node only — a .wgt is just a zip
  with config.xml at the root) writes `AquaPlay-0.7.35.wgt`: 26 files, 759 KB
  raw, 348 KB packed — the nine dictionaries are most of it. It came down 130
  KB when the icon did: a 24-bit 512x423 tile is 83 KB where the 32-bit
  512x512 was 217, and none of that compresses. Unpacked and served on its
  own it boots with no missing references — only `$WEBAPIS`, which resolves
  on the TV — so signing really is the only step left. The 10-char package
  id `AquaPlay01` is well-formed and only needs changing if Tizen Studio's wizard issues a
  different one.
- M3U parser treats `group-title="Animation;Comedy"` as one literal category.
  Playlists that pack multiple categories into one attribute (iptv-org does)
  splinter into near-duplicate single-channel groups.


## Four icons, and only one of them is square

Samsung asks for four things and they are different shapes:

| file | size | depth | what it is |
| --- | --- | --- | --- |
| `app/icon.png` | 512x512 | 24-bit | the application icon, the one in the .wgt |
| `branding/testing-icon-117x117.png` | 117x117 | 24-bit | the small icon while an app is side-loaded |
| `branding/banner-background-1920x1080.png` | 1920x1080 | 24-bit | large logo, the part underneath |
| `branding/banner-logo-1920x1080.png` | 1920x1080 | 32-bit | large logo, the wordmark over it |

Each under 300 KB. **The first one is settled: 512x512, square, and the shape
is not a knob.** Leave it alone.

It has been 512x512, 512x423, 1920x1080 and back, on a run of confident
readings that each turned out to be about somebody else’s television. Then a
pair of icons declared with `width` and `height` attributes, which is what
TizenTube ships and what does get a wide tile *somewhere*:

```xml
<icon src="icon_16b9.png" width="1920" height="1080"/>
<icon src="icon.png" width="1024" height="1024"/>
```

That was tried, and the tile on the set this is built for did not change.

So the honest state of it: **nothing in the package has ever changed that
tile**, in four attempts, and it costs 380 KB to keep trying. Every theory
here has been a theory — Samsung’s icon spec, a measurement off a photograph,
a working package copied attribute for attribute — and the only thing with a
result attached is that none of them moved it. If it matters enough to try a
fifth time, the thing to change is the evidence, not the number: get a set
that shows the wide tile for a side-loaded app and diff its package against
this one.

What the measurement off a photograph was good for, for whoever picks this
up: two tiles side by side, 743 and 724 pixels tall — one row, agreeing to
97%, which is what says the reading is sound — and 1214 and 645 wide. The
neighbour is 16:9 and this app is square. That much is fact; the cause is
not established.

`npm run icons` builds all four from `tools/icon-source.jpg`, which is the
artwork at full size and the only thing any of them come from — keep it.
`node tools/make-icon.js --check` reads what is on disk instead and says
whether it still fits, and `test-units.js` asserts the same table so a
regenerated set that drifts fails the suite rather than the submission form.

**Square to tile.** The wordmark sits across the middle third of the artwork,
so the icon is a crop, not a fit: the empty top and bottom go and the wordmark
keeps its proportions, which also leaves it bigger in the tile than fitting the
whole square between two bars would have. The crop is centred on the wordmark
rather than on the image, because the wordmark sits slightly low. The 117 is
the whole square, which is what a square asset wants.

**The large logo is two files**, and Seller Office composites them. Neither is a
scaled copy of the artwork:

- The background is the artwork's own vignette, measured off it and redrawn at
  16:9 — 21 grey in the middle, 40 in the corners, falling off as the 5.3th
  power of the distance out. The exponent is not a guess: a five-by-five grid
  of samples fits it to within one step, and a straight radial was out by ten.
  Redrawing rather than scaling means no JPEG noise to compress and no seam at
  any size.
- The wordmark is keyed off the same measurement. Alpha is how far a pixel sits
  above the background it was laid on, and the colour is then un-composited —
  `mark = (src - bg(1-a)) / a` — so the soft edges stay the colour of the mark
  instead of fading through grey on somebody else's background. Keying without
  that step is what makes a cut-out logo look dirty.

**Why the PNGs are written here.** Three of the four have to be 24-bit and
Chrome's canvas only ever writes 32-bit RGBA, so the pixels come back raw and
`make-icon.js` encodes them: colour type 2 or 6, zlib at level 9, and a filter
picked per row by the sum-of-absolute-differences rule from the PNG spec. The
filtering is worth about 6% on the tile and 14% on the gradient — not the
difference between passing and failing the 300 KB limit, but it is thirty lines
and it is measured rather than assumed. What did matter was the depth: the old
32-bit 512x512 was 217 KB, and the 24-bit tile is 83 KB.

Chrome does the decoding and the scaling. There is no image library in this
project and one resize is not worth becoming the largest dependency in it;
playwright-core is already here for the browser tests.

Only `icon.png` goes in the package — `pack.js` stages files by name, and a
test asserts `branding/` is not among them. The rest is for the submission
form.

## Testing with a real playlist

Drop an `.m3u` into `app/.local/` and the dev server prints its URL at startup;
paste that into the app's M3U tab. `.local/` is gitignored and `build.sh` stages
files explicitly, so it can never reach the TV package.

## Catch-up

The user's provider advertises `catchup-type="shift"` on the header and
`catchup-days="7"` / `tvg-rec="7"` on every channel. Verified against it
directly: appending `?utc=<start>&lutc=<now>` to the live URL returns DVR
segments (`dvr-YYYY/MM/DD/...`) at exactly the requested time, 1 hour, 6 hours
and 2 days back. Replaying a programme from the guide plays for real.

`js/catchup.js` builds the URL for all four schemes. `Catchup.available`
deliberately requires the programme to have *finished* — a programme still on
air is what the live stream is already showing.

The reach of this is bounded by the EPG window: only programmes still held in
memory can be replayed. `settings.catchupHours` now defaults to 168 (7 days),
which matches what this provider keeps.

Seven days is only affordable because `EPG.parse` takes an `opts.wanted` set of
the playlist's channel ids and match keys, and drops programmes for every other
channel as it scans. A provider guide covers far more channels than the package
it is sold with: for this user, 1,275 guide channels against 126 in the
playlist. Measured with the filter on, 7 days back + 8h ahead:

    126/126 channels matched      27,682 programmes kept
    246,451 programmes skipped    1.8 MB serialised into IndexedDB
    guide ready 4.0 s from a cold start

Without the filter the same window would be roughly 265,000 programmes. Verified
by replaying a programme from three days back on the real provider: readyState 4,
playing, ~24 s buffered.

`maxPerChannel` scales with the window (`(ahead + behind) * 2`), or the cap
would silently clip the history back off again.

Scrubbing in fullscreen is the same machinery: `Catchup.urlAt` takes raw times
rather than a programme, and committing a scrub simply restarts the stream at
the chosen moment. Position is tracked as a wall-clock anchor plus real elapsed
time, NOT the player's own timeline — for a live HLS stream `currentTime` is a
position inside a sliding window, not seconds since start, so it is useless for
this. The scrub timeline spans `2 x distance-back`, clamped to [2h, the whole
window]: pinned to the full seven days, a fifteen-minute scrub moved the knob
by a fraction of a pixel and looked broken.

`#ts-clock` is the broadcast-time readout in the top-right corner, the same
place Clouddy puts it. Seconds are shown deliberately — the scrub step is 30s,
so an HH:MM readout can be unchanged by a keypress and look dead. It lives
outside `.view` for the `#video-layer` stacking reason, is fullscreen-only, and
its own 1s interval is paused while the scrubber is driving it. `showOsd` and
`hideOsd` are its only owners — it shares the info bar's lifetime rather than
persisting, so there is one timeout to reason about, not two.

## Verified against real data

iptv-org UK playlist (318 channels) loaded end to end through the dev proxy:
main view rendered, DOM row count flat at 18 while scrolling the full list,
rows recycled with correct content, 200 cursor moves in 54 ms.

v0.3 playback model verified against real HLS from that playlist: nothing
played until OK was pressed, `readyState` reached 4, and the stream kept
advancing while the cursor moved 25 rows and in and out of the groups rail.

A real provider (126 Israeli channels, 30 MB gzipped XMLTV -> 242 MB /
1,275 channels / 551k programmes): after the proxy and matchKey fixes, 126 of
126 channels resolve to guide data, 15,107 programmes kept in the +-8h window
across 1,214 guide channels. Before those fixes it was 7 of 126.

That guide is now inflated by the app and scanned as it arrives, so neither its
30 MB of gzip nor its 242 MB of XML is ever held whole — see "The guide is
unzipped by the app" above. What has still never been measured is how long the
inflate itself takes on 2018 TV silicon; on a desktop it runs at ~240 MB/s, so
the whole guide is about a second there, and the result is cached in IndexedDB
either way.

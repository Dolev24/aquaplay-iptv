# AquaPlay IPTV

Lightweight IPTV player for Samsung Tizen TVs. Vanilla JS, no framework, no
build step. Android TV is a later target (WebView/Capacitor shell).

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

693 tests across four suites, first written here on 2026-08-26 (the suites the
original README referenced were never in the zip):

- `tools/test-units.js` (271) — loads the real modules into a fake `window` via
  `vm`. No browser, no dependencies, ~450 ms.
- `tools/test-proxy.js` (20) — the dev proxy against a mock upstream. No
  browser either.
- `tools/e2e.js` (345) — 5,000-channel playlist + XMLTV, real key events.
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
Going further than the nine is what the catch-up browser is for, and there is
no setting for the panel.


## Sizes people can actually read

The app is looked at from a sofa, sometimes by someone whose sight is not what
it was, and it was drawn to be glanced at rather than read. Three places were
too small or too faint, and the fixes are all "bigger, and one contrast step up":

    channel number     19px --text-dim2  ->  24px --text-dim   (the dimmest token there is)
    now/next line      17px --text-dim   ->  21px --text-mid
    channel name       23px             ->  25px
    guide programme    20px --text-dim   ->  22px --text-mid

`--text-dim2` is the token for a caption nobody has to read; a channel number
is not that. The 76px row had the space all along — name, programme and number
now come to 58px of it.

**The guide panel reads outward from what is on.** Three sizes: the programme
on air at 27px semibold, the one either side of it at 24px (`.epg-row.near`,
stamped by the painter at `park ± 1`), and the rest at 22px. The row on air was
previously the same size as the row four hours ago, which made a panel whose
whole point is the middle row look like a list.

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
key from anything else: **INFO** (one press) and **What's on** in the channel
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
again in 0.7.15, reached by INFO or by the panel's own "What's on" row — see
"Reminders, and the way back into the guide panel". Right still does not go
there: right is about the channel, and its schedule is one of the things the
channel offers.

## The rail folds, and carries its own buttons

The groups rail is 280px while the cursor is in it and 26px when it is not
(`#stage.rail-in`), with a chevron for a handle and its contents faded out —
half-clipped group names read as a rendering fault rather than as a drawer.
The channel list takes the width back.

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

## Two channels cannot share a number

Numbering a channel onto a number that is already taken offers to **swap** the
two rather than duplicating it: a duplicate cannot be dialled, because the
remote reaches whichever the list happens to hit first. `rowWithNumber` checks
the numbers actually on screen, not just the overrides, since most channels are
on the number the playlist gave them.

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

## The overlays keep the dark palette in both themes

`#osd`, `#zap` and `#ts-clock` sit on a dark scrim over a broadcast picture,
and a picture does not turn white to suit a theme. Light-theme text there is
near-black on near-black — the info bar was, quite literally, invisible in the
light theme. They now re-declare the dark palette's `--text*` and `--accent`
on themselves, which fixes every descendant at once rather than colour by
colour. An e2e section asserts the direction (bar text light, page text dark,
and the ranking title > description > next), because the exact hex will move
and the relationship must not.

The light theme itself came down a second step in 0.7.14 (`--bg` #dfe4ed ->
#ccd3df, `--bg-2` #eef1f6 -> #d9dfe9, body #d6dce6 -> #c2cad7). It is a lamp,
not a page.

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

## Diagnostics, because the TV cannot be watched from here

Settings ends with rows fed by `Player.diag()`: the window size and stage scale,
the mode, the rect that was asked for and the rect that was applied, the display
method the set accepted, the source's own resolution, the player state, and the
last error AVPlay returned. Three rounds of guessing at second hand is what they
are for — when the picture is wrong, that screen says why.

## Known gaps

- The package is **unsigned**, and that, not the App ID, is what stops a TV
  install. `npm run pack` (`tools/pack.js`, Node only — a .wgt is just a zip
  with config.xml at the root) writes `AquaPlay-0.7.21.wgt`: 22 files, 332 KB
  raw, 105 KB packed. Unpacked and served on its own it boots with no missing
  references — only `$WEBAPIS`, which resolves on the TV — so signing really
  is the only step left. The 10-char package id `AquaPlay01` is well-formed
  and only needs changing if Tizen Studio's wizard issues a different one.
- M3U parser treats `group-title="Animation;Comedy"` as one literal category.
  Playlists that pack multiple categories into one attribute (iptv-org does)
  splinter into near-duplicate single-channel groups.

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

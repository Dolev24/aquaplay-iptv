# AquaPlay IPTV

A lightweight IPTV player for Samsung Tizen TVs. Vanilla JavaScript, no build
step, no framework — the whole app is about 130 KB of source and runs on 2018+
Samsung TVs (Tizen 4.0 / Chromium 56 and newer).

It also runs unchanged in a desktop browser, so you can develop without a TV.

---

## What it does today (v0.7)

**Playlists**
- Xtream Codes (server + username + password)
- M3U / M3U8 URL, with an optional XMLTV guide URL
- The guide URL is auto-detected from `#EXTM3U url-tvg="…"` if the playlist advertises one

**Live TV, Movies and Series**
- A section strip at the top of the groups rail switches between the three.
  Press up from the top of the rail to reach it, then left/right.
- Xtream: movies and series come from `get_vod_streams` / `get_series`, each
  fetched only when you first ask for that section and then cached
- M3U: entries are classified by URL path — `/movie/` and `/series/` are the
  panel conventions — so a single playlist still yields all three sections
- Series open a detail screen: seasons, episodes, plot, and up/down to move
  through the episodes while one is playing
- **Films and episodes fast-forward**: left/right move 30 seconds, the rewind
  and fast-forward keys five minutes, and the info bar shows how far through it
  is. A live channel cannot — there is nothing ahead of live — so there it
  winds back through catch-up instead

**Browsing**
- A narrow list on the left, a large player on the right: 280px groups rail,
  600px channel list, 1040px player pane
- Groups rail: All channels, Favourites, Recently watched, then the provider's own categories
- Channel list with now/next from the guide and a progress bar
- The bar along the bottom is the remote's legend: OK, full screen, **INFO for
  what's on**, and the three colour buttons
- Favourites (red button), search and settings from the foot of the groups
  rail, or the green and yellow buttons
- The rail folds away when you leave it and slides back when you return, so the
  channel list has the width while you are browsing it
- Lists wrap: up from the first channel is the last one, and back again — in
  the channel list and in the channel-numbers screen
- Number keys jump straight to a channel number, and play it
- Wound a channel back? While the info bar is up, **up** puts the cursor on the
  red **Back to live** button next to the channel number and OK returns to the
  live edge — the same two presses as the "stream is behind" badge

**Guide viewer and catch-up**
- Under the player: the focused channel's schedule — **nine programmes, five
  on screen**. Out of the box it opens with **what is on at the top** and the
  evening under it; up and down scroll through the rest, and a slim track on
  the right says where in the nine you are. Going further than that is what
  the catch-up browser is for
- Settings -> **Guide panel** switches that to what is on in the **middle**
  instead, with what has just been on above it — four either side, which is
  the shape to pick for a channel you are half-watching
- **INFO** steps into it (so does "Schedule" in the channel panel), and there
  OK does what that programme allows: replay one that has finished, watch the
  one on air, or **set a reminder** for one that has not started
- A reminder pops up when the programme starts, wherever you are in the app,
  with **Go to channel** or **Close**. One that was missed — the TV was off —
  is dropped rather than arriving hours late
- The popup carries the channel logo and the guide's description of the
  programme, so it introduces the show rather than just naming it
- When a channel has nothing on air, the panel head says why rather than
  leaving a column of finished programmes unexplained: **Guide ends 14:26**,
  **Starts 15:56**, or **Nothing on air** for a gap between programmes
- Settings -> Advanced -> **Guide coverage** counts how many channels have
  something on air, and names the ones that do not with where their guide
  stops — the row to read out when a block of channels goes quiet
- Programmes that already aired and are still held by the provider carry a
  clock-wound-back marker; one you asked to be reminded about carries a bell
- Schemes handled: M3U `catchup-type` of `shift` / `append` / `default` with
  `catchup-source` templates, and Xtream `/timeshift/`. The window comes from
  `catchup-days` / `tvg-rec`, or `tv_archive_duration` on Xtream
- Settings -> Catch-up history controls how far back the guide keeps finished
  programmes. Default 7 days
- **Catch-up browser** (Guide button, or `e`): a full screen listing every day
  the provider still holds down the left, with that day's schedule and times on
  the right. Replayable programmes are marked; OK plays one fullscreen
- The guide is filtered to the channels the playlist actually has as it is
  parsed, which is what makes a week of history affordable — a provider guide
  usually covers ten times the channels you are sold
- Compressed guides are unzipped by the app itself, because no Samsung TV
  before 2022 can do it: a `.gz` guide works on a 2018 set
- It is read in pieces as it arrives rather than loaded whole, so the size of
  the file stops mattering — a 30 MB download that expands to 242 MB of XML
  never exists as one string, and the app stays responsive while it loads
  (a 218 MB guide: ready in 2.6 s, never blocked for more than 0.2 s)
- If the guide cannot be loaded the panel says why, instead of reporting that
  each channel has none
- The channel list never waits for the guide: it appears as soon as the
  playlist is parsed, and the guide fills in behind it as it reads. A cached
  guide is used at once and refreshed quietly when it is a couple of hours old

**Playback — never automatic**
- Nothing plays until you press OK or Play. There is no auto-preview.
- OK on a channel plays it in the panel on the right. OK again on that same
  channel goes fullscreen — the video plane just moves, so it is instant.
- The remote's **Play button goes full screen from anywhere**, whatever the
  cursor has wandered on to: it is the channel in the preview that fills the
  screen, not the row you are looking at, and nothing restarts. With nothing
  playing yet it starts the row under the cursor. On a keyboard that is `P`.
- **Right on a channel** opens a panel down the right-hand edge: go full
  screen, see what's on, open the catch-up guide, add it to favourites,
  change its channel number, or lock it behind a PIN. Right while watching
  fullscreen opens the same panel. Both side panels are 30px rows with an
  icon each, meant to be read from a sofa
- When the stream falls behind, the warning that says so is a button: up in
  fullscreen puts the cursor on it, OK restarts the channel at the live edge.
- Moving the cursor never disturbs playback. It keeps playing while you scroll,
  change group, search, or switch section, until you pick another channel.
- A badge over the player names what is playing, and the row keeps a red marker
- Tizen: `webapis.avplay` on the hardware plane, starts on the lowest rendition so zapping feels instant
- Browser: `<video>` + hls.js
- Fullscreen with an info bar: channel, programme, how long is left, what the
  guide says the programme is about, what is on next, and whether you are live
  or how far behind. It is sized in that order — the programme on now is the
  loudest thing in it, what is on next the quietest. OK toggles it; up/down
  zap; **Back closes it without leaving the picture**, and a second Back leaves
  fullscreen
- **Scrubbing**: left/right wind back and forth 30 seconds at a time, J/L jump
  five minutes. The clock, the timeline and the programme bar all move as you
  go; OK commits and the stream restarts from there, Back cancels. The timeline
  spans a window that grows with how far you have gone, so a short scrub is
  still visible. Needs catch-up, and is capped by what the provider keeps
- While wound back, the **actual broadcast time** of what you are watching sits
  in the top-right corner, to the second, with the day it aired. It ticks along
  with playback, and appears and disappears with the info bar

**Stream health**
- If playback rebuffers for more than a moment, or drifts behind the live edge,
  a small red marker appears over the video saying so. It never pauses, hides
  or restarts anything — it is there to explain, not to interrupt
- A dropped stream is retried automatically (three times, three seconds apart)
  rather than just failing. Never for a decode failure, which would fail
  identically every time. Settings -> Reconnect automatically

**Settings**
- Theme (dark or light — the light one is a soft grey-blue, never white, and
  the info bar over the picture stays dark in both), alternating row colours
  (on), picture size — fit, fill or stretch — buffer, HLS engine on desktop
- Programme guide on/off, catch-up history, and a **guide time offset** for
  providers whose XMLTV is in the wrong timezone
- 24-hour or 12-hour clock, sort order, info bar duration, resume last channel
- Every settings row is bold; **Playlist, Language and Theme** are larger
  again, because they are what people open Settings for
- **Language** opens a list rather than cycling through ten of them one press
  at a time — and Back leaves it as it was
- **Date format**: six ways to write the date over the channel list, each row
  showing today written that way rather than naming a convention
- Parental control and PIN, start-on list, arrow-key channel change
- Restart application, clear cached data, reset channel numbers, remove playlist


**Readable from a sofa**
- The head of the channel list is a **clock**: the time and date lead, and the
  name of the list sits under them
- The groups rail is headed by the **AquaPlay wordmark** rather than the
  playlist's name — the name is in the drawer's foot, where it is actually a
  question worth answering
- The channel list is **ten rows to a screen**: a 92px row with a 96x70 logo,
  a 34px number, and the channel name in semibold above the programme line
- The channel playing is **outlined in red** in the list, so it is findable
  while you browse past it — it was a dot at the edge of the row
- Channel numbers, channel names and the now/next line are all a size up and a
  contrast step up from where they started. In the guide panel the programme on
  air is the largest thing and everything else is one size, which is easier to
  read down than the three sizes it had before
- The light theme is a mid grey-blue, not paper: a television is a lamp, and
  the point of the setting is a room with the lights on, not a white page


**Languages**
- English, Español, Français, Deutsch, Português, Italiano, Русский, हिन्दी,
  日本語, 한국어 — Settings -> Language, switched live, no reload. The default
  follows the TV's own language setting
- The whole interface moves: menus, settings, toasts, error messages, day and
  month names, the guide panel and the setup screen

**Parental control**
- **Lock any channel by hand**: right arrow on it -> *Lock with PIN*. It asks
  for a four-digit PIN the first time. After that the channel stays in the
  list wearing a padlock, and **asks for the PIN when you try to watch it** —
  it is meant to be seen and to say no
- Channels whose group or name reads as adult are hidden outright instead,
  as a category, with Settings -> Parental control
- One correct PIN opens the session, so several locked channels in a row are
  not a typing exercise. Closing the app re-locks, and so does Settings ->
  **Lock now** — which also stops whatever locked channel is playing
- A locked channel is never resumed at launch, so the app never opens with a
  PIN prompt
- The PIN prompt submits itself on the fourth digit — no OK — and asks again
  if it was wrong. Taking a lock off always asks, even mid-session
- Settings counts what is locked, and can take every lock off at once

**Getting around**
- **Left from the groups rail** opens a drawer: search, **TV catalogue**,
  catch-up, settings, reload, and exit. Favourites and recently watched are not
  in it — they are the first two rows of the rail you just came through
- The **TV catalogue** is every channel down the left and the whole schedule
  of the one you pick down the right, broken up by day and running as far ahead
  as the guide reaches. It opens on whatever you are watching. OK watches a
  programme if it is on, replays it if the provider kept it, and reminds you if
  it has not started
- Settings chooses which list the app opens on, and whether up/down change
  channel while watching fullscreen
- Opening Settings **does not stop the channel** — the sound carries on and the
  picture comes straight back, the way a television menu behaves

**Channel numbers you can change** (Settings -> Channel numbers)
- A screen of its own: every channel, its number, and a marker on the ones you
  have changed. OK opens a numeric editor: type a new number,
  OK saves, red clears it back to the playlist's own
- Typing the original number back in counts as putting it back, not as another
  change: the marker goes, and there is nothing left for Reset to undo
- The override is what the list shows and what the number keys dial
- Settings → Sort channels switches between channel number, which is what the
  app starts on, and the provider's own order
- Stored per playlist on the device; the M3U file is never modified

**Performance choices that matter on a TV**
- The channel list is virtualised: 18 DOM rows on screen no matter whether the
  playlist has 50 channels or 50,000
- M3U parsing is chunked with yields, so a 20k-channel playlist never freezes the UI
- XMLTV is scanned as raw text (never DOMParser) and only programmes inside a
  ±N-hour window are kept — a 200 MB guide would otherwise take the TV down
- Channels and guide are cached in IndexedDB, so a cold start is instant

Measured in the bundled test: 5,000 channels + 8,000 programmes parsed and
rendered in ~240 ms, with DOM row count flat at 18 while scrolling.

---

## Try it on your computer first

```bash
node tools/dev-server.js          # http://localhost:8080
```

The dev server also proxies provider requests, because a browser will block
them with CORS (the TV will not — `config.xml` declares `<access origin="*">`).

**Testing with your own playlist.** Either paste your provider's URL into the
M3U tab, or drop the file into `.local/` — the dev server prints the URL to use
on startup. Nothing in `.local/` is committed or packaged for the TV.

The app is driven by the remote, but every screen also accepts mouse clicks
and the wheel, so a browser session is usable without memorising the keys.
The action bar along the bottom names the PC key for each remote button, and
**H** opens a full keyboard reference. Both are hidden on the TV.

**Keyboard = remote**

| Remote            | Keyboard                     |
|-------------------|------------------------------|
| D-pad / OK        | Arrow keys / Enter           |
| Back              | Esc or Backspace             |
| Channel +/-       | Page Up / Page Down          |
| Red / Green / Yellow / Blue | `r` / `g` / `y` / `b` |
| Play a channel    | OK — again for fullscreen    |
| Set channel number| Blue                         |
| Guide viewer      | Right from the channel list  |
| Sections (Live/Movies/Series) | Up from the top of the rail, then arrows |
| Info              | `i`                          |
| Guide panel       | `e`, or Right from the list  |
| Scrub in fullscreen | Left / Right, `j` / `l` for 5 min |
| Keyboard help     | `h`                          |
| Channel numbers   | `0`–`9`                      |

Two browser-only playback limits, neither of which affects the TV:

- Raw MPEG-TS (`.ts`) streams cannot play in a browser at all. If a provider
  gives you `.ts` only, test playback on the TV.
- **Interlaced H.264 (1080i) will not decode in Chrome.** Most broadcast
  channels are 1080i, so expect a large share of a real playlist to fail on a
  desktop and work on the TV. The app now says which is which rather than
  showing a blank player.

---

## Put it on the TV

### One-time setup

1. **Install Tizen Studio** with the *TV Extension* (Samsung Developer site).
   Add `<tizen-studio>/tools/ide/bin` to your `PATH`.

2. **Create a certificate.** In Tizen Studio: *Tools → Certificate Manager →
   `+` → Samsung → TV*. Sign in with your Samsung account and add your TV's
   **DUID** when asked. Name the profile `dev`.

3. **Put the TV in Developer Mode.** On the TV: *Apps* → press `1 2 3 4 5` on
   the remote → set *Developer mode* **On** → enter your computer's local IP →
   restart the TV.

4. **Check the App ID.** `config.xml` ships `id="AquaPlay01.AquaPlay"
   package="AquaPlay01"`. A package id is any 10 alphanumeric characters, and
   that one qualifies; if Tizen Studio's wizard hands you a different prefix,
   put it in both attributes. What the TV really insists on is the signature
   from step 2.

### Build and install

```bash
./tools/build.sh                 # build the .wgt only
./tools/build.sh 192.168.1.50    # build, connect to that TV, install
```

Then launch **AquaPlay IPTV** from the TV's Apps row.

Certificates from a personal Samsung account expire after two years, and the
app stops launching when they do — rebuild and reinstall to renew.

### Building the package without Tizen Studio

```bash
npm run pack
```

writes `AquaPlay-<version>.wgt`: the same files `build.sh` stages, zipped by
`tools/pack.js` with nothing but Node — no toolchain, no dependencies. The
result is **unsigned**, so a TV will not install it as it stands. It is what
you hand to the signing step, and what to open when you want to see exactly
what would ship.

---

## Layout of the code

```
config.xml            Tizen manifest: privileges, CSP, App ID
index.html            All screens as markup; a fixed 1920x1080 stage
css/style.css         Chromium 56-safe CSS (no grid, no flex gap, no clamp)
js/
  util.js             Helpers, toast, loader, confirm dialog
  store.js            localStorage: profiles, favourites, settings, recents
  cache.js            IndexedDB cache for channels and guide
  inflate.js          gzip/DEFLATE in plain JS, decoding to chunks
  net.js              XHR with progress, the dev proxy, and the guide reader
  m3u.js              Chunked M3U parser
  catchup.js          Builds the URL that replays a moment or a programme
  xtream.js           Xtream Codes player_api client
  epg.js              XMLTV scanner (raw text, windowed, yields)
  player.js           AVPlay <-> hls.js abstraction
  keys.js             Remote + keyboard -> one action vocabulary
  views/setup.js      Add a playlist
  views/channels.js   Sections, groups, virtualised list, preview, OSD
  views/replay.js     Catch-up browser: days down one side, schedule the other
  views/series.js     Series detail: seasons, episodes, episode playback
  views/numbers.js    Channel numbers, reached from Settings
  views/settings.js   Settings list
  app.js              Bootstrap, routing, loading, caching
tools/
  dev-server.js       Static server + CORS proxy (never shipped to the TV)
  build.sh            Package + install (needs Tizen Studio)
  pack.js             Build the .wgt with nothing but Node
  test-units.js       Parser tests: no browser, no dependencies
  e2e.js              Browser test: 5k channels, navigation, search, OSD, EPG
  e2e-vod.js          Browser test: Movies and Series, against a mock panel
lib/hls.min.js        Browser-only; deliberately excluded from the .wgt
```

The TV package contains only `index.html`, `config.xml`, `icon.png`, `css/`
and `js/`. The nine dictionaries (176 KB) are the largest thing in it.

### Icons

Samsung asks for four, and they are not the same shape:

| file | size | depth | what it is |
| --- | --- | --- | --- |
| `icon.png` | 512x512 | 24-bit | the application icon, the one in the .wgt |
| `../branding/testing-icon-117x117.png` | 117x117 | 24-bit | side-loading for testing |
| `../branding/banner-background-1920x1080.png` | 1920x1080 | 24-bit | large logo, underneath |
| `../branding/banner-logo-1920x1080.png` | 1920x1080 | 32-bit | large logo, the wordmark |

Each under 300 KB. The first one is square and settled — see ARCHITECTURE.md
before changing it. Four different shapes have been tried and none of them
changed the tile the TV draws.

```bash
npm run icons
```

builds all four from `tools/icon-source.jpg`, which is the artwork at full size
and the only thing they come from. Replace that file and re-run to change the
icon. `node tools/make-icon.js --check` says whether what is on disk still fits
the table above, and `npm run test:units` asserts it too.

Only `icon.png` is packaged; `branding/` is for the Seller Office submission
form.

---

## Running the tests

```bash
npm test
```

Or individually:

```bash
node tools/test-units.js     # 287 parser tests, no browser, no dependencies
node tools/test-proxy.js     # 20 proxy and range tests, no browser either
node tools/e2e.js            # 370 browser tests: list, playback, guide, catch-up
node tools/e2e-vod.js        # 57 browser tests: Movies, Series, episodes
node tools/e2e.js --headed   # same, but watch it happen
```

`test-units.js` loads the real `js/*.js` modules into a fake `window` and
exercises the M3U parser (including the 4000-line chunk boundary), the XMLTV
scanner, the time-window filter, timezone offsets, channel matching and the
cache round-trip. It has no dependencies at all.

`e2e.js` generates a 5,000-channel playlist and an XMLTV guide, starts its own
dev-server on a free port, and drives the app with real key events.
`e2e-vod.js` does the same against a mock Xtream panel it runs in-process, so
Movies and Series are covered without a real provider account. It needs
`playwright-core` (`npm install`) but **not** a browser download — it uses the
Chrome already on the machine. Set `CHROME_PATH` to override. It writes
`shot-1-list.png` … `shot-8-series.png` to the project root.

There is deliberately no test for real video decoding. A browser cannot play
raw `.ts` at all, and whether AVPlay decodes a given stream can only be
answered on the TV, so an automated check would prove nothing that matters.

---

## Deliberately not in v4

Kept out to stay fast and to get something working on the TV first. The code is
structured so each drops in without rework:

- **Full 7-day guide grid** — `epg.js` keeps a windowed index; a grid view is a
  new view over the same data
- **Recording** — needs Tizen filesystem privileges
- **Multiple playlists at once** — the store holds an array of profiles; only
  the switcher UI is missing
- **PIN-locked groups** — whole categories rather than one channel at a time
- **Picture-in-picture, multi-view**

## Android TV

Done, and it went the way this section used to predict: `../android` is a
Kotlin shell — a WebView, ExoPlayer on a surface behind it, and a key map —
that carries this same app. `js/player.js`, `js/keys.js` and `js/net.js` were
the only files that touched a platform, and nothing else changed.

The web app is not copied there. Gradle stages `index.html`, `css/` and `js/`
into the APK on every build, so one copy of the app runs on both televisions
and one set of tests covers it.

See `../android/README.md` for what it takes to build, and ARCHITECTURE.md for
why the shell is shaped the way it is.

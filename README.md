# AquaPlay IPTV

A lightweight IPTV player for Samsung Tizen TVs. Vanilla JS, no framework, no
build step — the files that run on the TV are the files in this repository.
Android TV is a later target (a WebView or Capacitor shell).

M3U and Xtream Codes playlists, an XMLTV guide the app unzips and reads itself,
catch-up, reminders, favourites, per-channel PIN locks, and a remote-first
interface that assumes four arrows and an OK button.

## Run it

```bash
node app/tools/dev-server.js 8081
```

Then open the address it prints. It serves the app, proxies provider requests
around CORS, gunzips guides and answers range requests, so a film can be sought.
Drop a playlist in `app/.local/` and it will print that URL too.

## Test it

```bash
cd app && npm test
```

684 tests in four suites: the parsers and the store against the real modules in
a fake `window`, the dev proxy against a mock upstream, and two browser suites
driven with real key events through `playwright-core` against the Chrome already
on the machine. No browser download, no provider account.

## Put it on a TV

```bash
cd app && npm run pack
```

That writes `AquaPlay-<version>.wgt`. A Samsung TV will not install it until it
is signed with a certificate profile from Tizen Studio's Certificate Manager,
which needs a Samsung account and the TV's DUID. That signature is the only
thing standing between this and a television.

## Where things are

- [`app/README.md`](app/README.md) — what the app does, screen by screen, and
  how the pieces fit together
- [`ARCHITECTURE.md`](ARCHITECTURE.md) — why the awkward parts are the way they
  are: the pure-JS gzip decoder that lets a 2018 set read a `.gz` guide, the
  streaming XMLTV scanner, the AVPlay display-rect race, and each bug that cost
  a day
- `app/js/` — the app. `app/tools/` — the dev server, the packer, the tests

## Licence

MIT, in [LICENSE](LICENSE).

`app/lib/hls.min.js` is [hls.js](https://github.com/video-dev/hls.js), which is
Apache-2.0 and keeps its own terms. It is only used for playback in a desktop
browser and is deliberately left out of the TV package — Tizen plays through
AVPlay instead.

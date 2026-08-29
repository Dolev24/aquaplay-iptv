#!/usr/bin/env node
/* make-icon.js — every icon both TVs ask for, from the artwork next to this file.

     node tools/make-icon.js            # regenerate them all
     node tools/make-icon.js --check    # just say whether what is on disk fits

   Samsung wants four things, and they are not the same shape as each other:

     app/icon.png                              512 x 423   24-bit  < 300 KB
       The application icon. A TV tile is wider than it is tall, which is why
       this is not square — a square icon gets letterboxed on the launcher.
       config.xml points at this one and pack.js puts it in the .wgt.

     branding/testing-icon-117x117.png         117 x 117   24-bit
       The small icon the TV shows while an app is side-loaded for testing.

     branding/banner-background-1920x1080.png  1920 x 1080 24-bit  < 300 KB
     branding/banner-logo-1920x1080.png        1920 x 1080 32-bit  < 300 KB
       The large logo, which is two files: a background, and the wordmark on
       transparency to sit over it. Seller Office composites them.

   How the shapes are reconciled: the artwork is a square with the wordmark
   across its middle third, so the 512 x 423 icon is a crop rather than a
   squash or a pair of bars — the empty top and bottom go, the wordmark keeps
   its proportions and gets bigger in the tile for it. The 117 is the whole
   square, which is what a square asset wants.

   The banner background is not the artwork: it is the artwork's own vignette,
   measured off it (21 grey in the middle, 40 in the corners, falling off as
   the 5.3th power of the distance out) and redrawn at 16:9. Redrawing beats
   scaling here — no JPEG noise to compress, so it lands at a few KB instead
   of a few hundred, and it tiles behind the logo without a seam.

   The logo is keyed off the same measurement: the wordmark is light on dark,
   so alpha comes from luminance above the vignette and the colour is then
   un-composited (mark = (src - bg(1-a)) / a) so the edges are not fringed
   with grey when they land on somebody else's background.

   Two things this file does not do:

     - No image library. There is no image dependency in this project and one
       resize is not worth becoming the largest thing in it. playwright-core
       is already here for the browser tests, and the Chrome it drives decodes
       the JPEG and does the scaling.
     - No canvas PNG. Chrome only writes 32-bit RGBA, and three of these four
       have to be 24-bit, so the pixels come back raw and the PNG is written
       here: colour type 2 or 6, per-row filter chosen for size, zlib -9.

   Android TV wants two more:

     ../android/.../res/drawable/banner.png     320 x 180   24-bit
       The launcher tile. Every TV app must have one — an app without a banner
       does not appear on the Android TV home screen at all. It is the large
       logo again at a twentieth of the size, and flattened: the tile is opaque
       there, so the wordmark is composited over the vignette here rather than
       shipped as a second file the launcher would have to combine.

     ../android/.../res/mipmap-<dpi>/ic_launcher.png   48 to 144, square, 32-bit
       Barely seen on a television — the banner is what the home screen shows —
       but it is what appears in Settings, in "recent apps", and in the Play
       Console. It is the square artwork, unchanged.

   Keep icon-source.jpg. It is the original artwork at full size and this is
   the only thing that turns it back into any of the above. */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.resolve(__dirname, '..');            // the app/ directory
const REPO = path.resolve(ROOT, '..');
const SRC = path.join(__dirname, 'icon-source.jpg');
const BRAND = path.join(REPO, 'branding');
const ANDROID = path.join(REPO, 'android', 'app', 'src', 'main', 'res');

/* Android's density buckets, and the launcher icon each one wants. */
const MIPMAPS = [['mdpi', 48], ['hdpi', 72], ['xhdpi', 96], ['xxhdpi', 144]];

/* What each file has to be. The unit tests read this same table. */
const SPEC = [
  { file: path.join(ROOT, 'icon.png'),
    what: 'application icon', w: 512, h: 423, alpha: false, maxKB: 300 },
  { file: path.join(BRAND, 'testing-icon-117x117.png'),
    what: 'side-load testing icon', w: 117, h: 117, alpha: false, maxKB: 300 },
  { file: path.join(BRAND, 'banner-background-1920x1080.png'),
    what: 'large logo — background', w: 1920, h: 1080, alpha: false, maxKB: 300 },
  { file: path.join(BRAND, 'banner-logo-1920x1080.png'),
    what: 'large logo — wordmark', w: 1920, h: 1080, alpha: true, maxKB: 300 },
  { file: path.join(ANDROID, 'drawable', 'banner.png'),
    what: 'Android TV launcher banner', w: 320, h: 180, alpha: false, maxKB: 300 },
  /* Not a launcher icon: this one is drawn by the app, in the rail head and on
     the Settings screen. Shipped in the package, which is why it lives under
     app/ rather than branding/. */
  { file: path.join(ROOT, 'img', 'logo.png'),
    what: 'the wordmark the app draws', w: 900, h: 300, alpha: true, maxKB: 200 }
].concat(MIPMAPS.map(function (m) {
  return {
    file: path.join(ANDROID, 'mipmap-' + m[0], 'ic_launcher.png'),
    what: 'Android launcher icon (' + m[0] + ')', w: m[1], h: m[1], alpha: false, maxKB: 300
  };
})).concat(MIPMAPS.map(function (m) {
  /* The adaptive icon's foreground layer. 108dp of canvas where only the
     middle 72 is guaranteed to survive whatever mask the launcher applies,
     so the drawing is 2.25x the legacy icon's side and the mark sits well
     inside it. Transparent: the background is a colour, not a picture. */
  return {
    file: path.join(ANDROID, 'mipmap-' + m[0], 'ic_foreground.png'),
    what: 'Android adaptive foreground (' + m[0] + ')',
    w: Math.round(m[1] * 2.25), h: Math.round(m[1] * 2.25), alpha: true, maxKB: 300
  };
}));

/* ---------- the artwork's own background ----------
   Measured off icon-source.jpg on a five by five grid: 21 grey at the centre,
   40 at the corners, and nothing like linear in between — the middle is flat
   and it all happens near the corners. r^5.3 fits every sample to within one
   step, which is close enough that the redrawn version and the original sit
   next to each other without looking like two different greys. */
const BG_IN = 21, BG_OUT = 40, BG_POW = 5.3;

function vignette(w, h) {
  const px = Buffer.alloc(w * h * 3);
  const cx = (w - 1) / 2, cy = (h - 1) / 2;
  const R = Math.sqrt(cx * cx + cy * cy);
  for (let y = 0, i = 0; y < h; y++) {
    for (let x = 0; x < w; x++, i += 3) {
      const dx = x - cx, dy = y - cy;
      const t = Math.pow(Math.sqrt(dx * dx + dy * dy) / R, BG_POW);
      const v = Math.round(BG_IN + (BG_OUT - BG_IN) * t);
      px[i] = px[i + 1] = px[i + 2] = v;
    }
  }
  return px;
}

/* ---------- PNG ---------- */

const CRC = (function () {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'ascii');
  const body = Buffer.concat([head.slice(4), data]);
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([head, data, tail]);
}

function paeth(a, b, c) {
  const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
}

/* One of the five filters per row, chosen by the sum-of-absolute-differences
   rule out of the PNG spec. It costs a few milliseconds and it is the whole
   reason a 1920 x 1080 gradient is 8 KB rather than 900. */
function filterRows(px, w, h, bpp) {
  const stride = w * bpp;
  const out = Buffer.alloc(h * (stride + 1));
  const cand = [Buffer.alloc(stride), Buffer.alloc(stride), Buffer.alloc(stride),
                Buffer.alloc(stride), Buffer.alloc(stride)];
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < h; y++) {
    const row = px.slice(y * stride, (y + 1) * stride);
    const score = [0, 0, 0, 0, 0];
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? row[x - bpp] : 0;
      const b = prev[x];
      const c = x >= bpp ? prev[x - bpp] : 0;
      const v = row[x];
      cand[0][x] = v;
      cand[1][x] = (v - a) & 0xFF;
      cand[2][x] = (v - b) & 0xFF;
      cand[3][x] = (v - ((a + b) >> 1)) & 0xFF;
      cand[4][x] = (v - paeth(a, b, c)) & 0xFF;
      for (let f = 0; f < 5; f++) {
        const s = cand[f][x];
        score[f] += s < 128 ? s : 256 - s;
      }
    }
    let best = 0;
    for (let f = 1; f < 5; f++) if (score[f] < score[best]) best = f;
    out[y * (stride + 1)] = best;
    cand[best].copy(out, y * (stride + 1) + 1);
    prev = row;
  }
  return out;
}

function encodePNG(px, w, h, alpha) {
  const bpp = alpha ? 4 : 3;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;                       // bit depth
  ihdr[9] = alpha ? 6 : 2;           // truecolour, with or without alpha
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const idat = zlib.deflateSync(filterRows(px, w, h, bpp), { level: 9 });
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))
  ]);
}

/* Straight alpha over an opaque background, which is all the Android banner
   needs: the wordmark arrives on transparency and the tile has to be opaque,
   so the two are combined here rather than at the launcher's convenience. */
function flatten(rgba, bg, w, h) {
  const px = Buffer.alloc(w * h * 3);
  for (let i = 0, j = 0; j < px.length; i += 4, j += 3) {
    const a = rgba[i + 3] / 255;
    for (let k = 0; k < 3; k++) {
      px[j + k] = Math.round(rgba[i + k] * a + bg[j + k] * (1 - a));
    }
  }
  return px;
}

/* RGBA off a canvas, RGB on the way out. Everything here is drawn on an
   opaque background, so there is nothing to lose by dropping the channel. */
function dropAlpha(rgba, w, h) {
  const px = Buffer.alloc(w * h * 3);
  for (let i = 0, j = 0; j < px.length; i += 4, j += 3) {
    px[j] = rgba[i]; px[j + 1] = rgba[i + 1]; px[j + 2] = rgba[i + 2];
  }
  return px;
}

/* ---------- reading one back ---------- */

function inspect(file) {
  if (!fs.existsSync(file)) return null;
  const b = fs.readFileSync(file);
  if (b.length < 26 || b.readUInt32BE(12) !== 0x49484452) return { bad: 'not a PNG' };
  return {
    w: b.readUInt32BE(16), h: b.readUInt32BE(20),
    depth: b[24], colour: b[25],
    alpha: b[25] === 4 || b[25] === 6,
    kb: Math.round(b.length / 1024)
  };
}

function check() {
  let bad = 0;
  SPEC.forEach(function (s) {
    const got = inspect(s.file);
    const rel = path.relative(REPO, s.file).replace(/\\/g, '/');
    if (!got) { console.log('  MISSING  ' + rel); bad++; return; }
    const why = [];
    if (got.w !== s.w || got.h !== s.h) why.push('is ' + got.w + 'x' + got.h);
    if (got.depth !== 8) why.push(got.depth + '-bit samples');
    if (got.alpha !== s.alpha) why.push(got.alpha ? '32-bit, wants 24' : '24-bit, wants 32');
    if (got.kb > s.maxKB) why.push(got.kb + ' KB');
    if (why.length) { console.log('  WRONG    ' + rel + '  — ' + why.join(', ')); bad++; }
    else console.log('  ok       ' + rel + '  ' + got.w + 'x' + got.h + ' ' +
                     (got.alpha ? '32' : '24') + '-bit, ' + got.kb + ' KB  (' + s.what + ')');
  });
  return bad;
}

/* ---------- Chrome ---------- */

function chromePath() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const candidates = [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    (process.env.LOCALAPPDATA || '') + '/Google/Chrome/Application/chrome.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium'
  ];
  for (const c of candidates) { try { if (c && fs.existsSync(c)) return c; } catch (e) {} }
  throw new Error('No Chrome found. Set CHROME_PATH.');
}

/* Runs in the page. Comes back with three sets of raw pixels: the tile, the
   little square, and the wordmark cut out of its background. */
async function render(args) {
  const img = new Image();
  img.src = 'data:image/jpeg;base64,' + args.b64;
  await img.decode();

  const src = document.createElement('canvas');
  src.width = img.width; src.height = img.height;
  const sctx = src.getContext('2d');
  sctx.drawImage(img, 0, 0);
  const all = sctx.getImageData(0, 0, img.width, img.height);
  const d = all.data;

  const cx = (img.width - 1) / 2, cy = (img.height - 1) / 2;
  const R = Math.sqrt(cx * cx + cy * cy);
  const bgAt = function (x, y) {
    const dx = x - cx, dy = y - cy;
    return args.bgIn + (args.bgOut - args.bgIn) *
           Math.pow(Math.sqrt(dx * dx + dy * dy) / R, args.bgPow);
  };
  const lum = function (r, g, b) { return 0.2126 * r + 0.7152 * g + 0.0722 * b; };

  /* Where the wordmark actually is, so the crop and the cut-out are both
     measured off the artwork rather than off numbers typed in here. */
  let x0 = img.width, x1 = -1, y0 = img.height, y1 = -1;
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      const i = (y * img.width + x) * 4;
      if (lum(d[i], d[i + 1], d[i + 2]) > 90) {
        if (x < x0) x0 = x; if (x > x1) x1 = x;
        if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
    }
  }

  const scaled = function (sx, sy, sw, sh, w, h) {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const ctx = c.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(src, sx, sy, sw, sh, 0, 0, w, h);
    return ctx.getImageData(0, 0, w, h).data;
  };

  /* The tile. A window of the artwork with the icon's aspect, as tall as it
     can be, centred on the wordmark rather than on the image — the wordmark
     sits a little below the middle and cropping to the middle would put it
     lower still. */
  const aspect = args.tile.w / args.tile.h;
  let ch = Math.min(img.height, Math.round(img.width / aspect));
  let cw = Math.round(ch * aspect);
  let top = Math.round((y0 + y1) / 2 - ch / 2);
  top = Math.max(0, Math.min(img.height - ch, top));
  const left = Math.max(0, Math.min(img.width - cw, Math.round((x0 + x1) / 2 - cw / 2)));
  /* Kept for the log line: what a crop would have taken, which is what these
     used to be and why the mark was only a third of the tile's height. */
  const cropWas = cw + 'x' + ch + ' from ' + left + ',' + top;

  /* The cut-out. Alpha is how far above the background a pixel is; the colour
     is then what it must have been before it was laid on that background, so
     the edges stay the colour of the mark instead of fading through grey. */
  const pad = 8;
  const mx = Math.max(0, x0 - pad), my = Math.max(0, y0 - pad);
  const mw = Math.min(img.width, x1 + pad + 1) - mx;
  const mh = Math.min(img.height, y1 + pad + 1) - my;
  const cut = document.createElement('canvas');
  cut.width = mw; cut.height = mh;
  const cctx = cut.getContext('2d');
  const out = cctx.createImageData(mw, mh);
  for (let y = 0; y < mh; y++) {
    for (let x = 0; x < mw; x++) {
      const i = ((y + my) * img.width + (x + mx)) * 4, o = (y * mw + x) * 4;
      const bg = bgAt(x + mx, y + my);
      let a = (lum(d[i], d[i + 1], d[i + 2]) - bg) / (args.markLum - bg);
      a = a < 0 ? 0 : (a > 1 ? 1 : a);
      if (a < 0.02) { out.data[o] = out.data[o + 1] = out.data[o + 2] = out.data[o + 3] = 0; continue; }
      for (let k = 0; k < 3; k++) {
        const v = (d[i + k] - bg * (1 - a)) / a;
        out.data[o + k] = v < 0 ? 0 : (v > 255 ? 255 : Math.round(v));
      }
      out.data[o + 3] = Math.round(a * 255);
    }
  }
  cctx.putImageData(out, 0, 0);

  /* Onto a banner, centred, at the share of the width the caller asked for.
     Chrome premultiplies while it scales, so the soft edges come out clean. */
  const onBanner = function (spec) {
    const bw = Math.round(spec.w * spec.share);
    const bh = Math.round(bw * mh / mw);
    const c = document.createElement('canvas');
    c.width = spec.w; c.height = spec.h;
    const ctx = c.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(cut, Math.round((spec.w - bw) / 2), Math.round((spec.h - bh) / 2), bw, bh);
    return { box: bw + 'x' + bh, data: ctx.getImageData(0, 0, spec.w, spec.h).data };
  };
  const big = onBanner(args.banner);
  const tile = onBanner(args.tvBanner);
  const inApp = onBanner(args.inApp);
  /* The application icon and the side-load square, composed the same way. The
     share is the whole point: a crop could not make the mark any bigger than
     it was in the artwork, and this can. */
  const appIcon = onBanner(args.tile);
  const smallIcon = onBanner(args.smallTile);
  const foregrounds = args.foregrounds.map(function (n) {
    return onBanner({ w: n, h: n, share: args.foreground.share });
  });

  const b64 = function (arr) {
    let s = '';
    const u = new Uint8Array(arr.buffer || arr);
    for (let i = 0; i < u.length; i += 0x8000)
      s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000));
    return btoa(s);
  };

  return {
    source: img.width + 'x' + img.height,
    mark: (x1 - x0 + 1) + 'x' + (y1 - y0 + 1) + ' at ' + x0 + ',' + y0,
    crop: cropWas,
    logoBox: big.box,
    tvBox: tile.box,
    iconBox: appIcon.box,
    icon: b64(appIcon.data),
    inApp: b64(inApp.data),
    inAppBox: inApp.box,
    small: b64(smallIcon.data),
    launcher: args.mipmaps.map(function (n) {
      return b64(onBanner({ w: n, h: n, share: args.launcher.share }).data);
    }),
    foregrounds: foregrounds.map(function (f) { return b64(f.data); }),
    logo: b64(big.data),
    tvBanner: b64(tile.data)
  };
}

/* ---------- run ---------- */

(async () => {
  if (process.argv.indexOf('--check') > -1) {
    console.log('\n  what is on disk:\n');
    const bad = check();
    console.log('');
    process.exit(bad ? 1 : 0);
  }

  const { chromium } = require(path.join(ROOT, 'node_modules', 'playwright-core'));
  const b64 = fs.readFileSync(SRC).toString('base64');

  const browser = await chromium.launch({ executablePath: chromePath(), headless: true });
  const page = await browser.newPage();
  await page.goto('about:blank');
  const r = await page.evaluate(render, {
    b64: b64,
    bgIn: BG_IN, bgOut: BG_OUT, bgPow: BG_POW,
    markLum: 190,               // the wordmark's own luminance: fully opaque there
    /* 0.94 of the width. The mark is 3.1:1 and the tile is 1.21:1, so the
       height that follows is 37% and no share can make it more — what the
       number buys is the 140px of empty vignette either side going away. */
    tile: { w: SPEC[0].w, h: SPEC[0].h, share: 0.94 },
    smallTile: { w: SPEC[1].w, h: SPEC[1].h, share: 0.92 },
    banner: { w: SPEC[3].w, h: SPEC[3].h, share: 0.52 },
    /* Wider on the small tile than on the big one: 320px across is not the
       place to be precious about margins, and the wordmark has to survive
       being one of a row of them on a launcher. */
    tvBanner: { w: SPEC[4].w, h: SPEC[4].h, share: 0.78 },
    /* Edge to edge: this one is trimmed to the mark, so whatever draws it can
       size it by width and not have to know about a margin baked in. */
    inApp: { w: SPEC[5].w, h: SPEC[5].h, share: 0.98 },
    mipmaps: MIPMAPS.map(function (m) { return m[1]; }),
    launcher: { share: 0.92 },
    /* Only the middle 72 of an adaptive icon's 108 is guaranteed to survive
       the launcher's mask, so 0.6 of the canvas keeps the mark inside it with
       room to spare. */
    foreground: { share: 0.6 },
    foregrounds: MIPMAPS.map(function (m) { return Math.round(m[1] * 2.25); })
  });
  await browser.close();

  const logo = Buffer.from(r.logo, 'base64');
  const flat = function (b64s, w, h) {
    return flatten(Buffer.from(b64s, 'base64'), vignette(w, h), w, h);
  };

  const files = [
    [SPEC[0], encodePNG(flat(r.icon, SPEC[0].w, SPEC[0].h), SPEC[0].w, SPEC[0].h, false)],
    [SPEC[1], encodePNG(flat(r.small, SPEC[1].w, SPEC[1].h), SPEC[1].w, SPEC[1].h, false)],
    [SPEC[2], encodePNG(vignette(SPEC[2].w, SPEC[2].h), SPEC[2].w, SPEC[2].h, false)],
    [SPEC[3], encodePNG(logo, SPEC[3].w, SPEC[3].h, true)],
    [SPEC[4], encodePNG(flat(r.tvBanner, SPEC[4].w, SPEC[4].h), SPEC[4].w, SPEC[4].h, false)],
    [SPEC[5], encodePNG(Buffer.from(r.inApp, 'base64'), SPEC[5].w, SPEC[5].h, true)]
  ];
  /* The legacy launcher icon stays opaque — API 25 and below draw it as it is,
     with no mask and no background of their own. */
  MIPMAPS.forEach(function (m, i) {
    files.push([SPEC[6 + i], encodePNG(flat(r.launcher[i], m[1], m[1]), m[1], m[1], false)]);
  });
  MIPMAPS.forEach(function (m, i) {
    const spec = SPEC[6 + MIPMAPS.length + i];
    files.push([spec, encodePNG(Buffer.from(r.foregrounds[i], 'base64'),
                                spec.w, spec.h, true)]);
  });
  files.forEach(function (f) {
    fs.mkdirSync(path.dirname(f[0].file), { recursive: true });
    fs.writeFileSync(f[0].file, f[1]);
  });

  console.log('\n  source   ' + path.basename(SRC) + '  ' + r.source);
  console.log('  wordmark ' + r.mark);
  console.log('  tile     wordmark at ' + r.iconBox + ' on ' + SPEC[0].w + 'x' + SPEC[0].h +
              '   (a crop would have been ' + r.crop + ')');
  console.log('  banner   wordmark at ' + r.logoBox + ' on ' + SPEC[3].w + 'x' + SPEC[3].h);
  console.log('  tv tile  wordmark at ' + r.tvBox + ' on ' + SPEC[4].w + 'x' + SPEC[4].h);
  console.log('  in-app   wordmark at ' + r.inAppBox + ' on ' + SPEC[5].w + 'x' + SPEC[5].h + '\n');
  const bad = check();
  console.log('');
  process.exit(bad ? 1 : 0);
})().catch(function (e) { console.error('FAILED ' + (e && e.message || e)); process.exit(1); });

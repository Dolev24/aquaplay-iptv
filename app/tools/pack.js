#!/usr/bin/env node
/* pack.js — build the Tizen .wgt with nothing but Node.

   A .wgt is a plain zip with config.xml at its root, so no toolchain is
   needed to make one. This stages exactly what build.sh stages and writes the
   archive by hand, which also keeps the entry names slash-separated whatever
   Windows zip tooling would have done with them.

     node tools/pack.js           # -> AquaPlay-<version>.wgt

   The result is UNSIGNED, and a Samsung TV installs only a signed package:
   the signature comes from a Samsung certificate profile, made in Tizen
   Studio's Certificate Manager against a Samsung account and that TV's DUID.
   Once that profile exists, tools/build.sh does the whole build-sign-install
   run instead. This is for inspecting the package, and for handing someone
   the exact bytes to sign.
*/

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.resolve(__dirname, '..');
/* Same list as build.sh: lib/, tools/ and node_modules never reach the TV. */
const STAGE = ['config.xml', 'index.html', 'icon.png', 'css', 'img', 'js'];

const manifest = fs.readFileSync(path.join(ROOT, 'config.xml'), 'utf8');
/* the widget element's version, not the XML declaration's */
const version = (manifest.slice(manifest.indexOf('<widget'))
  .match(/version="([^"]+)"/) || [, '0.0.0'])[1];
const OUT = path.join(ROOT, 'AquaPlay-' + version + '.wgt');

/* ---------- crc32 ---------- */

const TABLE = (function () {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/* ---------- collect ---------- */

const files = [];
STAGE.forEach(function (rel) {
  (function walk(r) {
    const abs = path.join(ROOT, r);
    if (fs.statSync(abs).isDirectory()) {
      fs.readdirSync(abs).sort().forEach(function (n) { walk(r + '/' + n); });
    } else {
      files.push({ name: r.split(path.sep).join('/'), data: fs.readFileSync(abs) });
    }
  })(rel);
});

/* ---------- write the archive ---------- */

const d = new Date();
const dosTime = ((d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1)) & 0xFFFF;
const dosDate = (((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xFFFF;

const locals = [], central = [];
let offset = 0;

files.forEach(function (f) {
  const name = Buffer.from(f.name, 'utf8');
  const comp = zlib.deflateRawSync(f.data, { level: 9 });
  const crc = crc32(f.data);

  const lh = Buffer.alloc(30);
  lh.writeUInt32LE(0x04034b50, 0);
  lh.writeUInt16LE(20, 4);            // version needed
  lh.writeUInt16LE(8, 8);             // deflate
  lh.writeUInt16LE(dosTime, 10);
  lh.writeUInt16LE(dosDate, 12);
  lh.writeUInt32LE(crc, 14);
  lh.writeUInt32LE(comp.length, 18);
  lh.writeUInt32LE(f.data.length, 22);
  lh.writeUInt16LE(name.length, 26);
  locals.push(lh, name, comp);

  const ch = Buffer.alloc(46);
  ch.writeUInt32LE(0x02014b50, 0);
  ch.writeUInt16LE(20, 4);            // version made by
  ch.writeUInt16LE(20, 6);            // version needed
  ch.writeUInt16LE(8, 10);            // deflate
  ch.writeUInt16LE(dosTime, 12);
  ch.writeUInt16LE(dosDate, 14);
  ch.writeUInt32LE(crc, 16);
  ch.writeUInt32LE(comp.length, 20);
  ch.writeUInt32LE(f.data.length, 24);
  ch.writeUInt16LE(name.length, 28);
  ch.writeUInt32LE(offset, 42);       // where its local header sits
  central.push(ch, name);

  offset += lh.length + name.length + comp.length;
});

const cd = Buffer.concat(central);
const eocd = Buffer.alloc(22);
eocd.writeUInt32LE(0x06054b50, 0);
eocd.writeUInt16LE(files.length, 8);
eocd.writeUInt16LE(files.length, 10);
eocd.writeUInt32LE(cd.length, 12);
eocd.writeUInt32LE(offset, 16);

fs.writeFileSync(OUT, Buffer.concat([Buffer.concat(locals), cd, eocd]));

const raw = files.reduce(function (n, f) { return n + f.data.length; }, 0);
console.log('AquaPlay IPTV ' + version);
files.forEach(function (f) { console.log('  ' + f.name); });
console.log(files.length + ' files, ' + Math.round(raw / 1024) + ' KB -> ' +
            Math.round(fs.statSync(OUT).size / 1024) + ' KB');
console.log(OUT);
console.log('\nUnsigned. Sign it with a Samsung certificate profile before the TV\n' +
            'will install it — see README, "Put it on the TV".');

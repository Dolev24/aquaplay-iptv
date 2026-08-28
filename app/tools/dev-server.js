#!/usr/bin/env node
/* dev-server.js — serve the app for desktop testing and proxy provider
   requests around CORS. Never used on the TV; not shipped in the .wgt.

     node tools/dev-server.js [port]        # default 8080
   Then open http://localhost:8080 and drive it with the arrow keys.

   Keyboard: arrows + Enter, Esc = back, PgUp/PgDn = +/-10,
             r/g/y/b = colour buttons, i = info, digits = channel numbers. */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');
const zlib = require('zlib');

const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.argv[2] || process.env.PORT || 8080);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml',
  '.xml': 'application/xml', '.m3u': 'audio/x-mpegurl', '.m3u8': 'application/vnd.apple.mpegurl'
};

function serveStatic(req, res) {
  let p = decodeURIComponent(url.parse(req.url).pathname);
  if (p === '/') p = '/index.html';
  const file = path.join(ROOT, path.normalize(p).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(ROOT)) { res.writeHead(403).end('forbidden'); return; }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('not found: ' + p);
      return;
    }
    const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';

    /* Range requests, because a browser cannot seek a recording without them:
       it asks for the bytes around where you jumped to, and a server that
       always answers "here is the whole file, 200 OK" leaves the player unable
       to move. Films served out of .local/ or .test/ are the only reason this
       server exists, so it may as well serve them properly. */
    const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
    if (m && st.size) {
      let start = m[1] ? parseInt(m[1], 10) : 0;
      let end = m[2] ? parseInt(m[2], 10) : st.size - 1;
      if (isNaN(start) || start >= st.size) {
        res.writeHead(416, { 'content-range': 'bytes */' + st.size }).end();
        return;
      }
      if (isNaN(end) || end >= st.size) end = st.size - 1;
      res.writeHead(206, {
        'content-type': type,
        'content-range': 'bytes ' + start + '-' + end + '/' + st.size,
        'content-length': (end - start + 1),
        'accept-ranges': 'bytes',
        'cache-control': 'no-cache'
      });
      fs.createReadStream(file, { start: start, end: end }).pipe(res);
      return;
    }

    res.writeHead(200, {
      'content-type': type,
      'content-length': st.size,
      'accept-ranges': 'bytes',
      'cache-control': 'no-cache'
    });
    fs.createReadStream(file).pipe(res);
  });
}

/* Rewrite the URIs inside an HLS manifest so segments come back through us. */
function rewriteManifest(text, baseUrl) {
  return text.split('\n').map(line => {
    const t = line.trim();
    if (!t) return line;
    if (t.startsWith('#')) {
      // EXT-X-KEY / EXT-X-MAP carry a URI="..." attribute
      return line.replace(/URI="([^"]+)"/g, (m, u) =>
        'URI="/__proxy?url=' + encodeURIComponent(new URL(u, baseUrl).href) + '"');
    }
    try { return '/__proxy?url=' + encodeURIComponent(new URL(t, baseUrl).href); }
    catch (e) { return line; }
  }).join('\n');
}

function proxy(req, res) {
  const q = url.parse(req.url, true).query;
  const target = q.url;
  if (!target) { res.writeHead(400).end('missing url'); return; }

  let u;
  try { u = new URL(target); } catch (e) { res.writeHead(400).end('bad url'); return; }
  const mod = u.protocol === 'https:' ? https : http;

  const headers = {
    'user-agent': req.headers['user-agent'] || 'Mozilla/5.0 (SMART-TV; Tizen 6.0) AppleWebKit/537.36',
    'accept': '*/*'
  };
  if (req.headers.range) headers.range = req.headers.range;

  const upstream = mod.request({
    protocol: u.protocol, hostname: u.hostname, port: u.port,
    path: u.pathname + u.search, method: 'GET', headers, timeout: 30000
  }, up => {
    // Follow redirects ourselves so the rewritten base URL stays correct.
    if ([301, 302, 303, 307, 308].includes(up.statusCode) && up.headers.location) {
      up.resume();
      const next = new URL(up.headers.location, u).href;
      res.writeHead(302, { location: '/__proxy?url=' + encodeURIComponent(next),
                           'access-control-allow-origin': '*' });
      res.end();
      return;
    }

    const ctype = String(up.headers['content-type'] || '');
    const isText = /mpegurl|m3u|xml|text|json/i.test(ctype) ||
                   /\.(m3u8?|xml|xmltv|php)(\?|$)/i.test(u.pathname + u.search);

    let stream = up;
    let decompressed = false;
    const enc = String(up.headers['content-encoding'] || '').toLowerCase();
    if (enc === 'gzip') { stream = up.pipe(zlib.createGunzip()); decompressed = true; }
    else if (enc === 'deflate') { stream = up.pipe(zlib.createInflate()); decompressed = true; }
    else if (enc === 'br' && zlib.createBrotliDecompress) { stream = up.pipe(zlib.createBrotliDecompress()); decompressed = true; }
    else if (/\.gz(\?|$)/i.test(u.pathname)) { stream = up.pipe(zlib.createGunzip()); decompressed = true; }

    const outHeaders = {
      'access-control-allow-origin': '*',
      'access-control-allow-headers': '*',
      'cache-control': 'no-cache'
    };
    if (up.headers['content-type']) outHeaders['content-type'] = up.headers['content-type'];

    if (!isText) {
      // Binary (video segments): stream straight through.
      // Never forward content-length once we have decompressed the body — it
      // describes the compressed bytes, and the client would stop reading
      // there. A 30 MB .gz XMLTV expands to ~240 MB; declaring 30 MB silently
      // truncated the guide to an eighth of itself.
      if (up.headers['content-length'] && !decompressed) {
        outHeaders['content-length'] = up.headers['content-length'];
      }
      if (up.headers['content-range']) outHeaders['content-range'] = up.headers['content-range'];
      if (up.headers['accept-ranges']) outHeaders['accept-ranges'] = up.headers['accept-ranges'];
      res.writeHead(up.statusCode, outHeaders);
      stream.pipe(res);
      return;
    }

    let body = '';
    stream.setEncoding('utf8');
    stream.on('data', c => { body += c; });
    stream.on('end', () => {
      if (body.startsWith('#EXTM3U') && body.includes('#EXT-X-')) {
        body = rewriteManifest(body, u.href);
        outHeaders['content-type'] = 'application/vnd.apple.mpegurl';
      }
      outHeaders['content-length'] = Buffer.byteLength(body);
      res.writeHead(up.statusCode, outHeaders);
      res.end(body);
    });
    stream.on('error', e => { try { res.writeHead(502).end('proxy error: ' + e.message); } catch (_) {} });
  });

  upstream.on('timeout', () => { upstream.destroy(new Error('upstream timeout')); });
  upstream.on('error', e => {
    if (res.headersSent) return;
    res.writeHead(502, { 'access-control-allow-origin': '*' }).end('proxy error: ' + e.message);
  });
  upstream.end();
}

const server = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' }).end();
    return;
  }
  if (req.url.startsWith('/__proxy')) return proxy(req, res);
  return serveStatic(req, res);
});

server.on('error', err => {
  if (err.code === 'EADDRINUSE') {
    console.error('\nPort ' + PORT + ' is already in use.');
    console.error('Something else is running there — close it, or start this with a different port:');
    console.error('    node tools/dev-server.js 8081\n');
  } else {
    console.error('\nServer error: ' + err.message + '\n');
  }
  process.exit(1);
});

// Bind to loopback only: this process will fetch any URL it is handed, so it
// must not be reachable from the rest of the network.
/* Anything dropped in .local/ is served, so a playlist file on disk can be
   loaded without uploading it anywhere. Never shipped to the TV. */
function localPlaylists() {
  const dir = path.join(ROOT, '.local');
  try {
    return fs.readdirSync(dir).filter(f => /\.(m3u8?|xml|xmltv)$/i.test(f));
  } catch (e) { return []; }
}

server.listen(PORT, '127.0.0.1', () => {
  console.log('');
  console.log('  AquaPlay IPTV is running.');
  console.log('');
  console.log('      http://localhost:' + PORT);
  console.log('');

  const local = localPlaylists();
  if (local.length) {
    console.log('  Local files in .local/ — paste one of these into the M3U tab:');
    local.forEach(f => {
      console.log('      http://localhost:' + PORT + '/.local/' + encodeURIComponent(f));
    });
    console.log('');
  }

  console.log('  Keep this window open. Close it to stop the server.');
  console.log('');
});

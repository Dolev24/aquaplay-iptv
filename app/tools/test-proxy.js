#!/usr/bin/env node
/* test-proxy.js — the dev-server's CORS proxy. No browser, no dependencies.

   Spawns the proxy and a mock upstream, then checks that what comes out the
   other side is byte-for-byte what went in.

     node tools/test-proxy.js
*/

const http = require('http');
const net = require('net');
const path = require('path');
const zlib = require('zlib');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');

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
function eq(a, e, label) {
  const A = JSON.stringify(a), E = JSON.stringify(e);
  ok(A === E, label, A === E ? '' : 'expected ' + E + '\n        got      ' + A);
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

function startDevServer(port) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'tools', 'dev-server.js'), String(port)],
      { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    const onData = d => { out += d.toString(); if (out.includes('http://localhost:')) resolve(child); };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', c => reject(new Error('dev-server exited (' + c + '):\n' + out)));
    setTimeout(() => reject(new Error('dev-server did not start:\n' + out)), 10000);
  });
}

/* An upstream that serves a .gz file the way a provider's XMLTV endpoint does:
   pre-compressed on disk, no content-encoding header, and a content-length
   describing the COMPRESSED bytes. */
function startUpstream(port, gz, plain) {
  return new Promise(resolve => {
    const server = http.createServer((req, res) => {
      if (req.url.startsWith('/xmltv.xml.gz')) {
        res.writeHead(200, {
          'content-type': 'application/octet-stream',
          'content-length': String(gz.length)
        });
        res.end(gz);
        return;
      }
      if (req.url.startsWith('/xmltv.xml')) {
        res.writeHead(200, { 'content-type': 'application/xml', 'content-length': String(plain.length) });
        res.end(plain);
        return;
      }
      res.writeHead(404).end('no');
    });
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

function get(url, headers) {
  return new Promise((resolve, reject) => {
    http.get(url, { headers: headers || {} }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    }).on('error', reject);
  });
}

(async function () {
  console.log('\nAquaPlay IPTV — dev-server proxy');

  // Big enough that a truncation at the compressed length is unmistakable.
  const parts = ['<?xml version="1.0"?>\n<tv>\n'];
  for (let i = 0; i < 40000; i++) {
    parts.push('<programme start="20260826120000 +0300" stop="20260826123000 +0300" channel="c' +
               i + '"><title>Programme ' + i + ' — Канал / ערוץ</title></programme>\n');
  }
  parts.push('</tv>\n');
  const plain = Buffer.from(parts.join(''), 'utf8');
  const gz = zlib.gzipSync(plain);

  const upPort = await freePort();
  const upstream = await startUpstream(upPort, gz, plain);
  const webPort = await freePort();
  const server = await startDevServer(webPort);

  try {
    const base = 'http://127.0.0.1:' + webPort + '/__proxy?url=';
    const upBase = 'http://127.0.0.1:' + upPort;

    describe('gzipped upstream (a provider XMLTV)');

    ok(gz.length < plain.length / 4, 'the fixture really does compress hard',
       gz.length + ' -> ' + plain.length + ' bytes');

    const r = await get(base + encodeURIComponent(upBase + '/xmltv.xml.gz'));
    eq(r.status, 200, 'the proxy answers');
    eq(r.body.length, plain.length, 'the whole file arrives, decompressed');
    ok(r.body.toString('utf8').trimEnd().endsWith('</tv>'), 'and it is complete to the closing tag');

    // The regression this exists for: forwarding the upstream content-length
    // after gunzipping made the client stop at the compressed size.
    ok(r.headers['content-length'] === undefined ||
       Number(r.headers['content-length']) === plain.length,
       'it never declares the compressed length for a decompressed body',
       'content-length: ' + r.headers['content-length'] + ', body: ' + plain.length);

    ok(!/�/.test(r.body.toString('utf8').slice(0, 4000)),
       'multi-byte characters survive the transfer');

    describe('plain upstream');

    const r2 = await get(base + encodeURIComponent(upBase + '/xmltv.xml'));
    eq(r2.status, 200, 'the proxy answers');
    eq(r2.body.length, plain.length, 'an uncompressed body is passed through whole');
    eq(r2.headers['access-control-allow-origin'], '*', 'CORS is opened up for the browser');

    describe('range requests, so a recording can be sought');

    /* A browser cannot seek a film without them: it asks for the bytes around
       where you jumped to, and a server that always answers "here is the whole
       file, 200 OK" leaves the player unable to move. This was found by a film
       that would not fast-forward. */
    const whole = await get('http://127.0.0.1:' + webPort + '/index.html');
    eq(whole.status, 200, 'a plain request still gets the whole file');
    eq(whole.headers['accept-ranges'], 'bytes', 'and is told ranges are allowed');

    const part = await get('http://127.0.0.1:' + webPort + '/index.html', { Range: 'bytes=10-19' });
    eq(part.status, 206, 'a range request is answered with a partial body');
    eq(part.body.length, 10, 'of exactly the bytes asked for');
    eq(part.body.toString('utf8'), whole.body.slice(10, 20).toString('utf8'),
       'and they are the right ones');
    ok(/^bytes 10-19\/\d+$/.test(part.headers['content-range'] || ''),
       'saying which bytes they are', part.headers['content-range']);

    const tail = await get('http://127.0.0.1:' + webPort + '/index.html', { Range: 'bytes=5-' });
    eq(tail.status, 206, 'an open-ended range works too');
    eq(tail.body.length, whole.body.length - 5, 'and runs to the end of the file');

    const past = await get('http://127.0.0.1:' + webPort + '/index.html',
                           { Range: 'bytes=99999999-' });
    eq(past.status, 416, 'a range past the end is refused, not answered with nothing');

    describe('failure handling');

    const r3 = await get(base + encodeURIComponent(upBase + '/nope'));
    eq(r3.status, 404, 'an upstream 404 is reported as a 404');

    const r4 = await get('http://127.0.0.1:' + webPort + '/__proxy');
    eq(r4.status, 400, 'a proxy call with no url is rejected');

  } catch (e) {
    fail++;
    failures.push('threw: ' + (e && e.stack || e));
    console.log('\n  !! ' + (e && e.stack || e));
  } finally {
    server.kill();
    upstream.close();
  }

  console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
  if (failures.length) {
    console.log('  Failures:');
    failures.forEach(f => console.log('   - ' + f));
    console.log('');
  }
  process.exit(fail ? 1 : 0);
})();

/* net.js — HTTP with timeouts, real download progress, and a browser-dev proxy.

   On Tizen the app can call provider hosts directly (config.xml declares
   <access origin="*">, which lifts CORS for the widget). In a desktop browser
   it cannot, so requests are routed through the bundled dev server's proxy. */
(function (w) {
  'use strict';

  var N = {};

  /* Set by app.js. In the browser we proxy; on the TV we go direct. */
  N.useProxy = !U.isTizen;
  N.proxyPath = '/__proxy?url=';

  N.wrap = function (url) {
    if (!N.useProxy) return url;
    if (url.indexOf('/__proxy') === 0) return url;
    return N.proxyPath + encodeURIComponent(url);
  };

  /* Media URLs also need the proxy in a browser (CORS + mixed content). */
  N.media = function (url) {
    if (!N.useProxy) return url;
    return N.proxyPath + encodeURIComponent(url);
  };

  /* text(url, {timeout, onProgress(loaded,total)}) -> Promise<string> */
  N.text = function (url, opts) {
    opts = opts || {};
    var target = N.wrap(url);
    var timeout = opts.timeout || 45000;

    return new Promise(function (resolve, reject) {
      var xhr = new XMLHttpRequest();
      var done = false;
      try { xhr.open('GET', target, true); }
      catch (e) { reject(new Error('Bad URL')); return; }

      xhr.timeout = timeout;
      if (opts.onProgress) {
        xhr.onprogress = function (e) {
          opts.onProgress(e.loaded, e.lengthComputable ? e.total : 0);
        };
      }
      xhr.onload = function () {
        if (done) return; done = true;
        if (xhr.status >= 200 && xhr.status < 300) resolve(xhr.responseText);
        else reject(new Error('HTTP ' + xhr.status));
      };
      xhr.onerror = function () {
        if (done) return; done = true;
        reject(new Error('Network error — check the URL and your connection'));
      };
      xhr.ontimeout = function () {
        if (done) return; done = true;
        reject(new Error('Timed out after ' + Math.round(timeout / 1000) + 's'));
      };
      try { xhr.send(); }
      catch (e) { if (!done) { done = true; reject(e); } }
    });
  };

  N.json = function (url, opts) {
    return N.text(url, opts).then(function (t) {
      var s = t.replace(/^﻿/, '').trim();
      try { return JSON.parse(s); }
      catch (e) {
        throw new Error('Server did not return valid JSON (got: ' + s.slice(0, 60) + ')');
      }
    });
  };

  /* bytes(url, {timeout, onProgress}) -> Promise<Uint8Array> */
  N.bytes = function (url, opts) {
    opts = opts || {};
    var target = N.wrap(url);
    var timeout = opts.timeout || 45000;

    return new Promise(function (resolve, reject) {
      var xhr = new XMLHttpRequest();
      var done = false;
      try { xhr.open('GET', target, true); }
      catch (e) { reject(new Error('Bad URL')); return; }

      xhr.responseType = 'arraybuffer';
      xhr.timeout = timeout;
      if (opts.onProgress) {
        xhr.onprogress = function (e) {
          opts.onProgress(e.loaded, e.lengthComputable ? e.total : 0);
        };
      }
      xhr.onload = function () {
        if (done) return; done = true;
        if (xhr.status >= 200 && xhr.status < 300) resolve(new Uint8Array(xhr.response));
        else reject(new Error('HTTP ' + xhr.status));
      };
      xhr.onerror = function () {
        if (done) return; done = true;
        reject(new Error('Network error — check the URL and your connection'));
      };
      xhr.ontimeout = function () {
        if (done) return; done = true;
        reject(new Error('Timed out after ' + Math.round(timeout / 1000) + 's'));
      };
      try { xhr.send(); }
      catch (e) { if (!done) { done = true; reject(e); } }
    });
  };

  N.looksGzipped = function (url) { return /\.gz(\?|$)/i.test(url); };

  /* UTF-8 a piece at a time. A guide in Hebrew or Cyrillic has multi-byte
     characters that land across a chunk boundary, so the decoder has to carry
     the incomplete tail into the next call. TextDecoder does that for us on
     every TV since 2015; the fallback is here because getting a truncated
     character wrong shows up as mojibake in a channel name, not as a crash. */
  function utf8Reader() {
    if (typeof w.TextDecoder === 'function') {
      var td = new w.TextDecoder('utf-8');
      return function (bytes, final) {
        if (final) return td.decode(new Uint8Array(0));
        return td.decode(bytes, { stream: true });
      };
    }
    var carry = [];
    return function (bytes, final) {
      if (final) return '';
      var b = bytes, i = 0, out = [], chunk = [];
      if (carry.length) {
        var joined = new Uint8Array(carry.length + b.length);
        joined.set(carry, 0); joined.set(b, carry.length);
        b = joined; carry = [];
      }
      var n = b.length;
      while (i < n) {
        var c = b[i], need = c < 0x80 ? 0 : c < 0xE0 ? 1 : c < 0xF0 ? 2 : 3;
        if (i + need >= n && need) {           // incomplete: keep for next time
          for (var k = i; k < n; k++) carry.push(b[k]);
          break;
        }
        var cp;
        if (need === 0) cp = c;
        else if (need === 1) cp = ((c & 0x1F) << 6) | (b[i + 1] & 0x3F);
        else if (need === 2) cp = ((c & 0x0F) << 12) | ((b[i + 1] & 0x3F) << 6) | (b[i + 2] & 0x3F);
        else cp = ((c & 0x07) << 18) | ((b[i + 1] & 0x3F) << 12) |
                  ((b[i + 2] & 0x3F) << 6) | (b[i + 3] & 0x3F);
        i += need + 1;
        if (cp > 0xFFFF) {
          cp -= 0x10000;
          chunk.push(0xD800 + (cp >> 10), 0xDC00 + (cp & 0x3FF));
        } else {
          chunk.push(cp);
        }
        if (chunk.length >= 4096) {            // apply() has a stack limit
          out.push(String.fromCharCode.apply(null, chunk)); chunk = [];
        }
      }
      if (chunk.length) out.push(String.fromCharCode.apply(null, chunk));
      return out.join('');
    };
  }

  /* guide(url, onText, opts) -> Promise
     Reads an XMLTV guide and hands it over in pieces, inflating it on the way
     if it is gzipped. The inflating is ours rather than the platform's for a
     blunt reason: no Samsung TV before 2022 has DecompressionStream, and
     providers nearly always serve the guide as a .gz — so on a 2018 set the
     old path could not read a byte of it and every channel reported no guide.
     Handing the text over in pieces is what keeps a 242 MB guide affordable:
     the caller scans and drops each piece as it arrives. */
  var TEXT_PIECE = 1 << 20;

  N.guide = function (url, onText, opts) {
    return N.bytes(url, opts).then(function (bytes) {
      var read = utf8Reader();

      function finish() {
        var tail = read(null, true);
        if (tail) onText(tail);
      }

      if (w.Inflate && w.Inflate.isGzip(bytes)) {
        return w.Inflate.gunzipAsync(bytes, function (slab) {
          onText(read(slab, false));
        }).then(finish);
      }

      /* Uncompressed, but still a piece at a time and still yielding: a plain
         XMLTV is just as big, and the screen has to stay alive while it is
         read. */
      return new Promise(function (resolve, reject) {
        var at = 0;
        function step() {
          try {
            var end = Date.now() + 20;
            while (at < bytes.length) {
              onText(read(bytes.subarray(at, at + TEXT_PIECE), false));
              at += TEXT_PIECE;
              if (Date.now() >= end) break;
            }
          } catch (e) { reject(e); return; }
          if (at < bytes.length) { setTimeout(step, 0); return; }
          finish();
          resolve();
        }
        setTimeout(step, 0);
      });
    });
  };

  w.Net = N;
})(window);

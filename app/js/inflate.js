/* inflate.js — gzip/DEFLATE in plain JavaScript, decoding to chunks.

   Why this exists: a Samsung TV before 2022 runs Chromium 56-76, which has no
   DecompressionStream, and provider guides are almost always served as a .gz.
   Without this the app fetches the file, cannot read a byte of it, and every
   channel reports "No guide for this channel" with nothing to say why.

   Why it emits chunks: the user's own guide is 30 MB compressed and 242 MB of
   XML. Nothing on a TV can hold that as one string, so the output is handed
   out a slab at a time and the caller consumes and drops each one. Only the
   last 32 KB is kept, because that is as far as a DEFLATE back-reference can
   reach.

   The algorithm is the classic table-per-length Huffman decoder from RFC 1951
   (the "tinf" shape): compact, no lookup tables to build, and fast enough that
   the XML scan that follows it is the slower half. */
(function (w) {
  'use strict';

  var HIST = 32768;          // DEFLATE's maximum back-reference distance
  var SLAB = 1 << 20;        // how much output to gather before handing it over

  /* --- static tables (RFC 1951 sections 3.2.5 and 3.2.6) --- */

  var LENGTH_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31,
                     35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
  var LENGTH_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2,
                      3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
  var DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193,
                   257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145,
                   8193, 12289, 16385, 24577];
  var DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6,
                    7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
  var CLEN_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

  function Tree() {
    this.counts = new Uint16Array(16);    // how many codes of each bit length
    this.symbols = new Uint16Array(288);  // symbols ordered by code
  }

  /* Canonical Huffman: all a decoder needs is how many codes exist at each
     length and the symbols in code order. */
  function buildTree(t, lengths, off, num) {
    var i;
    for (i = 0; i < 16; i++) t.counts[i] = 0;
    for (i = 0; i < num; i++) t.counts[lengths[off + i]]++;
    t.counts[0] = 0;

    var offsets = new Uint16Array(16);
    var sum = 0;
    for (i = 0; i < 16; i++) { offsets[i] = sum; sum += t.counts[i]; }
    for (i = 0; i < num; i++) {
      if (lengths[off + i]) t.symbols[offsets[lengths[off + i]]++] = i;
    }
  }

  var fixedLit = null, fixedDist = null;
  function buildFixed() {
    if (fixedLit) return;
    var l = new Uint8Array(288), i;
    for (i = 0; i < 144; i++) l[i] = 8;
    for (i = 144; i < 256; i++) l[i] = 9;
    for (i = 256; i < 280; i++) l[i] = 7;
    for (i = 280; i < 288; i++) l[i] = 8;
    fixedLit = new Tree();
    buildTree(fixedLit, l, 0, 288);

    var d = new Uint8Array(30);
    for (i = 0; i < 30; i++) d[i] = 5;
    fixedDist = new Tree();
    buildTree(fixedDist, d, 0, 30);
  }

  /* --- output sink: hands out slabs, keeps the last 32 KB as history --- */

  function Sink(onData) {
    this.buf = new Uint8Array(SLAB);
    this.len = 0;
    this.onData = onData;
    this.total = 0;
  }

  Sink.prototype.byte = function (b) {
    this.buf[this.len++] = b;
    this.total++;
    if (this.len === SLAB) this.spill();
  };

  /* Hand over everything except the history the next block may refer back to. */
  Sink.prototype.spill = function () {
    var keep = this.len < HIST ? this.len : HIST;
    var emit = this.len - keep;
    if (emit <= 0) return;
    this.onData(this.buf.subarray(0, emit));
    this.buf.set(this.buf.subarray(emit, this.len), 0);
    this.len = keep;
  };

  Sink.prototype.end = function () {
    if (this.len) { this.onData(this.buf.subarray(0, this.len)); this.len = 0; }
  };

  /* A match may reach back into bytes already handed out only if they are
     still in the window, which is why spill() never releases the last 32 KB.
     The source index is recomputed every byte because a spill in the middle of
     a long copy shifts the buffer under it. */
  Sink.prototype.copy = function (dist, length) {
    if (dist > this.len) throw new Error('inflate: back-reference before the start of the stream');
    for (var i = 0; i < length; i++) this.byte(this.buf[this.len - dist]);
  };

  /* --- the decoder --- */

  /* The decoder keeps every scrap of its state on the object so it can stop
     between two symbols and pick up later — that is what lets a 242 MB guide
     be unpacked without the screen freezing for the duration. */
  function Inflator(src, pos, sink) {
    this.src = src;
    this.pos = pos;
    this.tag = 0;
    this.bits = 0;
    this.sink = sink;
    this.lt = new Tree();
    this.dt = new Tree();
    this.state = 0;        // 0 between blocks, 1 inside a coded block, 2 stored
    this.last = 0;
    this.curLt = null;
    this.curDt = null;
    this.storedLeft = 0;
    this.done = false;
  }

  Inflator.prototype.bit = function () {
    if (!this.bits) {
      if (this.pos >= this.src.length) throw new Error('inflate: truncated stream');
      this.tag = this.src[this.pos++];
      this.bits = 8;
    }
    var b = this.tag & 1;
    this.tag >>>= 1;
    this.bits--;
    return b;
  };

  Inflator.prototype.getBits = function (n, base) {
    var v = 0;
    for (var i = 0; i < n; i++) v |= this.bit() << i;
    return v + (base || 0);
  };

  /* The same walk as bit()-by-bit, with the reader's state held in locals for
     the length of one symbol. Every byte of a 242 MB guide passes through here,
     so the property-loads add up to real time on a TV. */
  Inflator.prototype.symbol = function (t) {
    var sum = 0, cur = 0, len = 0;
    var tag = this.tag, bits = this.bits, pos = this.pos;
    var src = this.src, counts = t.counts;

    for (;;) {
      if (!bits) {
        if (pos >= src.length) {
          this.tag = tag; this.bits = bits; this.pos = pos;
          throw new Error('inflate: truncated stream');
        }
        tag = src[pos++];
        bits = 8;
      }
      cur = 2 * cur + (tag & 1);
      tag >>>= 1;
      bits--;
      len++;
      if (len > 15) {
        this.tag = tag; this.bits = bits; this.pos = pos;
        throw new Error('inflate: bad Huffman code');
      }
      sum += counts[len];
      cur -= counts[len];
      if (cur < 0) break;
    }

    this.tag = tag; this.bits = bits; this.pos = pos;
    return t.symbols[sum + cur];
  };

  /* The two trees for a dynamic block are themselves Huffman-coded. */
  Inflator.prototype.readTrees = function () {
    var hlit = this.getBits(5, 257);
    var hdist = this.getBits(5, 1);
    var hclen = this.getBits(4, 4);
    var lengths = new Uint8Array(320);
    var i;

    var clen = new Uint8Array(19);
    for (i = 0; i < hclen; i++) clen[CLEN_ORDER[i]] = this.getBits(3);
    var ct = new Tree();
    buildTree(ct, clen, 0, 19);

    var n = 0;
    while (n < hlit + hdist) {
      var sym = this.symbol(ct);
      if (sym === 16) {                     // repeat the previous length
        var prev = lengths[n - 1];
        var r = this.getBits(2, 3);
        while (r--) lengths[n++] = prev;
      } else if (sym === 17) {              // a run of zeros, short form
        var r2 = this.getBits(3, 3);
        while (r2--) lengths[n++] = 0;
      } else if (sym === 18) {              // a run of zeros, long form
        var r3 = this.getBits(7, 11);
        while (r3--) lengths[n++] = 0;
      } else {
        lengths[n++] = sym;
      }
    }

    buildTree(this.lt, lengths, 0, hlit);
    buildTree(this.dt, lengths, hlit, hdist);
  };

  /* Decodes symbols until the block ends or the deadline passes. Returns true
     for "block finished", false for "paused mid-block" — the only difference
     to the caller is whether to start looking for another block header. */
  Inflator.prototype.blockStep = function (deadline) {
    var lt = this.curLt, dt = this.curDt, n = 0;
    for (;;) {
      var sym = this.symbol(lt);
      if (sym === 256) return true;
      var sk = this.sink;
      if (sym < 256) {
        // Sink.byte() by another name: a call per output byte is the one cost
        // this loop cannot carry.
        sk.buf[sk.len++] = sym;
        sk.total++;
        if (sk.len === SLAB) sk.spill();
      } else {
        sym -= 257;
        if (sym > 28) throw new Error('inflate: bad length symbol');
        var length = this.getBits(LENGTH_EXTRA[sym], LENGTH_BASE[sym]);
        var dsym = this.symbol(dt);
        if (dsym > 29) throw new Error('inflate: bad distance symbol');
        var dist = this.getBits(DIST_EXTRA[dsym], DIST_BASE[dsym]);
        var from = sk.len - dist;
        if (from >= 0 && sk.len + length < SLAB) {
          /* No spill can happen inside this copy, so the buffer cannot move
             under it. Forward byte-by-byte on purpose: an overlapping match
             (dist < length) is defined to read what it has just written. */
          var b = sk.buf, at = sk.len;
          for (var i = 0; i < length; i++) b[at + i] = b[from + i];
          sk.len = at + length;
          sk.total += length;
        } else {
          sk.copy(dist, length);
        }
      }
      // Reading the clock per symbol would cost more than the decoding does.
      if (deadline && (++n & 4095) === 0 && Date.now() >= deadline) return false;
    }
  };

  Inflator.prototype.beginStored = function () {
    this.tag = 0; this.bits = 0;              // stored blocks start byte-aligned
    if (this.pos + 4 > this.src.length) throw new Error('inflate: truncated stored block');
    var len = this.src[this.pos] | (this.src[this.pos + 1] << 8);
    var nlen = this.src[this.pos + 2] | (this.src[this.pos + 3] << 8);
    if ((len ^ 0xffff) !== nlen) throw new Error('inflate: stored block length mismatch');
    this.pos += 4;
    if (this.pos + len > this.src.length) throw new Error('inflate: truncated stored block');
    this.storedLeft = len;
  };

  Inflator.prototype.endBlock = function () {
    if (this.last) this.done = true;
    else this.state = 0;
  };

  /* pump(deadline) — decode until the deadline (a Date.now() value; 0 means
     run to the end). Returns true when the whole stream is done. */
  Inflator.prototype.pump = function (deadline) {
    buildFixed();
    for (;;) {
      if (this.done) return true;

      if (this.state === 0) {
        this.last = this.bit();
        var type = this.getBits(2);
        if (type === 0) { this.beginStored(); this.state = 2; }
        else if (type === 1) { this.curLt = fixedLit; this.curDt = fixedDist; this.state = 1; }
        else if (type === 2) {
          this.readTrees();
          this.curLt = this.lt; this.curDt = this.dt; this.state = 1;
        } else throw new Error('inflate: reserved block type');
      }

      if (this.state === 2) {
        // A stored block can be 64 KB; copy it in slices so it can pause too.
        var slice = this.storedLeft > 16384 ? 16384 : this.storedLeft;
        for (var i = 0; i < slice; i++) this.sink.byte(this.src[this.pos++]);
        this.storedLeft -= slice;
        if (this.storedLeft === 0) this.endBlock();
      } else if (this.state === 1) {
        if (this.blockStep(deadline)) this.endBlock();
      }

      if (deadline && Date.now() >= deadline) return this.done;
    }
  };

  /* --- gzip container (RFC 1952) --- */

  var Z = {};

  Z.isGzip = function (bytes) {
    return !!(bytes && bytes.length > 2 && bytes[0] === 0x1f && bytes[1] === 0x8b);
  };

  /* Skips the header and returns where the DEFLATE data starts. */
  function gzipStart(b) {
    if (!Z.isGzip(b)) throw new Error('inflate: not a gzip file');
    if (b[2] !== 8) throw new Error('inflate: unsupported compression method');
    var flg = b[3];
    var p = 10;
    if (flg & 4) { p += 2 + (b[p] | (b[p + 1] << 8)); }         // FEXTRA
    if (flg & 8) { while (p < b.length && b[p]) p++; p++; }      // FNAME
    if (flg & 16) { while (p < b.length && b[p]) p++; p++; }     // FCOMMENT
    if (flg & 2) p += 2;                                        // FHCRC
    if (p >= b.length) throw new Error('inflate: truncated gzip header');
    return p;
  }

  /* gunzip(bytes, onData) — onData(Uint8Array) is called with each slab, and
     the view it receives is only valid until the next call. Returns the number
     of bytes produced. Throws on a corrupt stream. */
  Z.gunzip = function (bytes, onData) {
    var sink = new Sink(onData);
    new Inflator(bytes, gzipStart(bytes), sink).pump(0);
    sink.end();
    return sink.total;
  };

  /* Raw DEFLATE, for completeness and for the tests. */
  Z.inflateRaw = function (bytes, onData) {
    var sink = new Sink(onData);
    new Inflator(bytes, 0, sink).pump(0);
    sink.end();
    return sink.total;
  };

  /* gunzipAsync(bytes, onData, {sliceMs}) -> Promise<bytes produced>

     The same decoding, in slices, with the event loop free in between. onData
     runs inside a slice, so whatever the caller does with a slab is part of
     the budget — which is the point: unpacking and scanning the guide together
     must not hold the screen for longer than a frame or two at a time. */
  Z.gunzipAsync = function (bytes, onData, opts) {
    opts = opts || {};
    var sliceMs = opts.sliceMs || 20;
    return new Promise(function (resolve, reject) {
      var sink = new Sink(onData);
      var inf;
      try { inf = new Inflator(bytes, gzipStart(bytes), sink); }
      catch (e) { reject(e); return; }

      function step() {
        var finished;
        try { finished = inf.pump(Date.now() + sliceMs); }
        catch (e) { reject(e); return; }
        if (finished) {
          try { sink.end(); } catch (e2) { reject(e2); return; }
          resolve(sink.total);
          return;
        }
        setTimeout(step, 0);
      }
      setTimeout(step, 0);
    });
  };

  w.Inflate = Z;
})(window);

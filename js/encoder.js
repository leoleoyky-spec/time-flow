// APNG / ZIP encoders (no dependencies). Works in the browser (window.Encoder) and in Node (module.exports).
(function (root) {
  'use strict';

  const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
    return table;
  })();

  function crc32(bytes, start = 0, end = bytes.length) {
    let c = 0xffffffff;
    for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

  function readU32(b, o) {
    return ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
  }

  function parseChunks(png) {
    for (let i = 0; i < 8; i++) {
      if (png[i] !== PNG_SIGNATURE[i]) throw new Error('Not a PNG file');
    }
    const chunks = [];
    let o = 8;
    while (o + 8 <= png.length) {
      const len = readU32(png, o);
      const type = String.fromCharCode(png[o + 4], png[o + 5], png[o + 6], png[o + 7]);
      const data = png.subarray(o + 8, o + 8 + len);
      chunks.push({ type, data });
      o += 12 + len;
      if (type === 'IEND') break;
    }
    return chunks;
  }

  function makeChunk(type, data) {
    const out = new Uint8Array(12 + data.length);
    const dv = new DataView(out.buffer);
    dv.setUint32(0, data.length);
    for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
    out.set(data, 8);
    dv.setUint32(8 + data.length, crc32(out, 4, 8 + data.length));
    return out;
  }

  function concat(parts) {
    let total = 0;
    for (const p of parts) total += p.length;
    const out = new Uint8Array(total);
    let o = 0;
    for (const p of parts) {
      out.set(p, o);
      o += p.length;
    }
    return out;
  }

  /**
   * Assemble same-sized PNG frames into one APNG.
   * @param {Uint8Array[]} frames  PNG files (all with identical IHDR)
   * @param {{delayNum:number, delayDen:number, plays:number}} opts
   *   delay per frame = delayNum / delayDen seconds; plays = loop count (0 = infinite)
   */
  function assembleAPNG(frames, opts) {
    if (!frames.length) throw new Error('No frames');
    const { delayNum, delayDen, plays } = opts;
    const parsed = frames.map(parseChunks);
    const ihdr = parsed[0].find((c) => c.type === 'IHDR').data;
    const width = readU32(ihdr, 0);
    const height = readU32(ihdr, 4);

    const parts = [new Uint8Array(PNG_SIGNATURE), makeChunk('IHDR', ihdr)];

    const actl = new Uint8Array(8);
    new DataView(actl.buffer).setUint32(0, frames.length);
    new DataView(actl.buffer).setUint32(4, plays);
    parts.push(makeChunk('acTL', actl));

    let seq = 0;
    parsed.forEach((chunks, i) => {
      const fh = chunks.find((c) => c.type === 'IHDR').data;
      if (readU32(fh, 0) !== width || readU32(fh, 4) !== height) {
        throw new Error('All frames must have the same size');
      }
      const fctl = new Uint8Array(26);
      const dv = new DataView(fctl.buffer);
      dv.setUint32(0, seq++);
      dv.setUint32(4, width);
      dv.setUint32(8, height);
      dv.setUint32(12, 0); // x offset
      dv.setUint32(16, 0); // y offset
      dv.setUint16(20, delayNum);
      dv.setUint16(22, delayDen);
      fctl[24] = 1; // dispose_op: APNG_DISPOSE_OP_BACKGROUND (clear to transparent)
      fctl[25] = 0; // blend_op: APNG_BLEND_OP_SOURCE
      parts.push(makeChunk('fcTL', fctl));

      if (i === 0) {
        // Keep the PLTE/tRNS etc. of the first frame ahead of its image data.
        for (const c of chunks) {
          if (c.type === 'PLTE' || c.type === 'tRNS') parts.splice(parts.length - 2, 0, makeChunk(c.type, c.data));
        }
      }
      for (const c of chunks) {
        if (c.type !== 'IDAT') continue;
        if (i === 0) {
          parts.push(makeChunk('IDAT', c.data));
        } else {
          const fdat = new Uint8Array(4 + c.data.length);
          new DataView(fdat.buffer).setUint32(0, seq++);
          fdat.set(c.data, 4);
          parts.push(makeChunk('fdAT', fdat));
        }
      }
    });

    parts.push(makeChunk('IEND', new Uint8Array(0)));
    return concat(parts);
  }

  /**
   * Median-cut quantization shared by all frames (APNG allows only one palette).
   * Index 0 is reserved for fully transparent pixels.
   * @param {Uint8ClampedArray[]} frames  RGBA pixel data, same size
   * @returns {{palette: Uint8Array, indices: Uint8Array[]}}  palette is RGBA x N
   */
  function quantize(frames, maxColors = 256) {
    const keyOf = (d, i) => ((d[i] >> 3) << 14) | ((d[i + 1] >> 3) << 9) | ((d[i + 2] >> 3) << 4) | (d[i + 3] >> 4);
    const buckets = new Map();
    for (const d of frames) {
      for (let i = 0; i < d.length; i += 4) {
        if (d[i + 3] < 8) continue;
        const k = keyOf(d, i);
        let b = buckets.get(k);
        if (!b) buckets.set(k, (b = { c: [0, 0, 0, 0], n: 0 }));
        b.c[0] += d[i]; b.c[1] += d[i + 1]; b.c[2] += d[i + 2]; b.c[3] += d[i + 3];
        b.n++;
      }
    }
    const items = [];
    for (const [k, b] of buckets) items.push({ k, n: b.n, c: b.c.map((v) => v / b.n) });

    const boxStats = (list) => {
      const lo = [255, 255, 255, 255];
      const hi = [0, 0, 0, 0];
      let n = 0;
      for (const it of list) {
        n += it.n;
        for (let ch = 0; ch < 4; ch++) {
          if (it.c[ch] < lo[ch]) lo[ch] = it.c[ch];
          if (it.c[ch] > hi[ch]) hi[ch] = it.c[ch];
        }
      }
      let axis = 0;
      for (let ch = 1; ch < 4; ch++) if (hi[ch] - lo[ch] > hi[axis] - lo[axis]) axis = ch;
      return { list, n, axis, range: hi[axis] - lo[axis] };
    };

    const boxes = items.length ? [boxStats(items)] : [];
    while (boxes.length < maxColors - 1) {
      let best = -1;
      let score = 0;
      boxes.forEach((b, i) => {
        const s = b.range * Math.sqrt(b.n);
        if (b.list.length > 1 && s > score) { score = s; best = i; }
      });
      if (best < 0) break;
      const { list, axis, n } = boxes[best];
      list.sort((a, b) => a.c[axis] - b.c[axis]);
      let acc = 0;
      let cut = 1;
      for (; cut < list.length - 1; cut++) {
        acc += list[cut - 1].n;
        if (acc >= n / 2) break;
      }
      boxes.splice(best, 1, boxStats(list.slice(0, cut)), boxStats(list.slice(cut)));
    }

    const palette = new Uint8Array((boxes.length + 1) * 4); // entry 0 = transparent
    boxes.forEach((b, i) => {
      for (let ch = 0; ch < 4; ch++) {
        let sum = 0;
        for (const it of b.list) sum += it.c[ch] * it.n;
        palette[(i + 1) * 4 + ch] = Math.round(sum / b.n);
      }
    });

    const lookup = new Map();
    for (const it of items) {
      let bi = 1;
      let bd = Infinity;
      for (let p = 1; p <= boxes.length; p++) {
        const o = p * 4;
        const dr = it.c[0] - palette[o], dg = it.c[1] - palette[o + 1], db = it.c[2] - palette[o + 2], da = it.c[3] - palette[o + 3];
        const dist = dr * dr + dg * dg + db * db + da * da;
        if (dist < bd) { bd = dist; bi = p; }
      }
      lookup.set(it.k, bi);
    }

    const indices = frames.map((d) => {
      const out = new Uint8Array(d.length / 4);
      for (let i = 0, j = 0; i < d.length; i += 4, j++) out[j] = d[i + 3] < 8 ? 0 : lookup.get(keyOf(d, i));
      return out;
    });
    return { palette, indices };
  }

  /**
   * Encode an 8-bit indexed PNG.
   * @param {(raw: Uint8Array) => Promise<Uint8Array>|Uint8Array} deflate  zlib-format compressor
   */
  async function encodeIndexedPNG(width, height, indices, palette, deflate) {
    const raw = new Uint8Array((width + 1) * height);
    for (let y = 0; y < height; y++) raw.set(indices.subarray(y * width, (y + 1) * width), y * (width + 1) + 1);
    const ihdr = new Uint8Array(13);
    const dv = new DataView(ihdr.buffer);
    dv.setUint32(0, width);
    dv.setUint32(4, height);
    ihdr[8] = 8; // bit depth
    ihdr[9] = 3; // indexed color
    const count = palette.length / 4;
    const plte = new Uint8Array(count * 3);
    const trns = new Uint8Array(count);
    for (let i = 0; i < count; i++) {
      plte.set(palette.subarray(i * 4, i * 4 + 3), i * 3);
      trns[i] = palette[i * 4 + 3];
    }
    return concat([
      new Uint8Array(PNG_SIGNATURE),
      makeChunk('IHDR', ihdr),
      makeChunk('PLTE', plte),
      makeChunk('tRNS', trns),
      makeChunk('IDAT', await deflate(raw)),
      makeChunk('IEND', new Uint8Array(0)),
    ]);
  }

  /**
   * Create an uncompressed ("stored") ZIP archive.
   * @param {{name:string, data:Uint8Array}[]} files
   */
  function createZip(files) {
    const enc = new TextEncoder();
    const locals = [];
    const centrals = [];
    let offset = 0;
    const now = new Date();
    const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
    const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();

    for (const f of files) {
      const name = enc.encode(f.name);
      const crc = crc32(f.data);
      const size = f.data.length;

      const local = new Uint8Array(30 + name.length);
      const lv = new DataView(local.buffer);
      lv.setUint32(0, 0x04034b50, true);
      lv.setUint16(4, 20, true); // version needed
      lv.setUint16(6, 0x0800, true); // UTF-8 names
      lv.setUint16(8, 0, true); // stored
      lv.setUint16(10, dosTime, true);
      lv.setUint16(12, dosDate, true);
      lv.setUint32(14, crc, true);
      lv.setUint32(18, size, true);
      lv.setUint32(22, size, true);
      lv.setUint16(26, name.length, true);
      lv.setUint16(28, 0, true);
      local.set(name, 30);
      locals.push(local, f.data);

      const central = new Uint8Array(46 + name.length);
      const cv = new DataView(central.buffer);
      cv.setUint32(0, 0x02014b50, true);
      cv.setUint16(4, 20, true); // version made by
      cv.setUint16(6, 20, true); // version needed
      cv.setUint16(8, 0x0800, true);
      cv.setUint16(10, 0, true);
      cv.setUint16(12, dosTime, true);
      cv.setUint16(14, dosDate, true);
      cv.setUint32(16, crc, true);
      cv.setUint32(20, size, true);
      cv.setUint32(24, size, true);
      cv.setUint16(28, name.length, true);
      cv.setUint32(42, offset, true);
      central.set(name, 46);
      centrals.push(central);

      offset += local.length + size;
    }

    const cdSize = centrals.reduce((s, c) => s + c.length, 0);
    const end = new Uint8Array(22);
    const ev = new DataView(end.buffer);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(8, files.length, true);
    ev.setUint16(10, files.length, true);
    ev.setUint32(12, cdSize, true);
    ev.setUint32(16, offset, true);

    return concat([...locals, ...centrals, end]);
  }

  /**
   * Output size for a LINE animated sticker whose drawing (all its motion included)
   * covers bw × bh: as large as fits in 320 × 270. One side then reaches its limit,
   * which also meets LINE's "width or height 270px or more".
   */
  function lineStickerSize(bw, bh, maxW = 320, maxH = 270) {
    const scale = Math.min(maxW / bw, maxH / bh);
    return {
      scale,
      w: Math.min(maxW, Math.max(1, Math.round(bw * scale))),
      h: Math.min(maxH, Math.max(1, Math.round(bh * scale))),
    };
  }

  const api = { lineStickerSize, crc32, parseChunks, makeChunk, assembleAPNG, quantize, encodeIndexedPNG, createZip };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Encoder = api;
})(typeof window !== 'undefined' ? window : globalThis);

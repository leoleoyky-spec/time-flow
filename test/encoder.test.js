const test = require('node:test');
const assert = require('node:assert');
const zlib = require('node:zlib');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { crc32, parseChunks, makeChunk, assembleAPNG, quantize, encodeIndexedPNG, createZip } = require('../js/encoder.js');

function solidPNG(w, h, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) raw.set(rgba, y * (w * 4 + 1) + 1 + x * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    makeChunk('IHDR', ihdr),
    makeChunk('IDAT', zlib.deflateSync(raw)),
    makeChunk('IEND', new Uint8Array(0)),
  ]);
}

test('crc32 matches known value', () => {
  assert.strictEqual(crc32(Buffer.from('123456789')), 0xcbf43926);
});

test('assembleAPNG writes a valid animated PNG', () => {
  const frames = [
    solidPNG(4, 3, [255, 0, 0, 255]),
    solidPNG(4, 3, [0, 255, 0, 128]),
    solidPNG(4, 3, [0, 0, 255, 0]),
  ];
  const apng = assembleAPNG(frames, { delayNum: 1, delayDen: 3, plays: 4 });
  const chunks = parseChunks(apng);

  assert.deepStrictEqual(
    chunks.map((c) => c.type),
    ['IHDR', 'acTL', 'fcTL', 'IDAT', 'fcTL', 'fdAT', 'fcTL', 'fdAT', 'IEND']
  );

  const actl = Buffer.from(chunks[1].data);
  assert.strictEqual(actl.readUInt32BE(0), 3);
  assert.strictEqual(actl.readUInt32BE(4), 4);

  // sequence numbers across fcTL/fdAT must be 0,1,2,...
  const seqs = chunks.filter((c) => c.type === 'fcTL' || c.type === 'fdAT').map((c) => Buffer.from(c.data).readUInt32BE(0));
  assert.deepStrictEqual(seqs, [0, 1, 2, 3, 4]);

  const fctl = Buffer.from(chunks[2].data);
  assert.strictEqual(fctl.readUInt32BE(4), 4);
  assert.strictEqual(fctl.readUInt32BE(8), 3);
  assert.strictEqual(fctl.readUInt16BE(20), 1);
  assert.strictEqual(fctl.readUInt16BE(22), 3);

  // every chunk CRC must be valid
  let o = 8;
  while (o < apng.length) {
    const len = Buffer.from(apng).readUInt32BE(o);
    const stored = Buffer.from(apng).readUInt32BE(o + 8 + len);
    assert.strictEqual(crc32(apng, o + 4, o + 8 + len), stored);
    o += 12 + len;
  }
});

test('assembleAPNG rejects frames of different sizes', () => {
  assert.throws(() => assembleAPNG([solidPNG(2, 2, [0, 0, 0, 0]), solidPNG(3, 2, [0, 0, 0, 0])], { delayNum: 1, delayDen: 2, plays: 1 }));
});

test('quantize + encodeIndexedPNG round-trips a small palette exactly', async () => {
  const colors = [[0, 0, 0, 0], [255, 0, 0, 255], [0, 128, 255, 200], [255, 255, 255, 255]];
  const w = 4;
  const h = 2;
  const frames = [0, 1].map((f) => {
    const d = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < w * h; i++) d.set(colors[(i + f) % colors.length], i * 4);
    return d;
  });
  const { palette, indices } = quantize(frames);
  assert.strictEqual(palette.length / 4, 4); // transparent + 3 opaque colors
  const png = await encodeIndexedPNG(w, h, indices[0], palette, (raw) => zlib.deflateSync(raw));
  const chunks = parseChunks(png);
  assert.deepStrictEqual(chunks.map((c) => c.type), ['IHDR', 'PLTE', 'tRNS', 'IDAT', 'IEND']);
  const raw = zlib.inflateSync(chunks[3].data);
  for (let i = 0; i < w * h; i++) {
    const idx = raw[Math.floor(i / w) * (w + 1) + 1 + (i % w)];
    assert.deepStrictEqual(Array.from(palette.subarray(idx * 4, idx * 4 + 4)), colors[i % colors.length]);
  }
  const apng = parseChunks(assembleAPNG([png, png], { delayNum: 1, delayDen: 2, plays: 1 }));
  assert.deepStrictEqual(apng.slice(0, 4).map((c) => c.type), ['IHDR', 'PLTE', 'tRNS', 'acTL']);
});

test('createZip produces an archive unzip accepts', (t) => {
  const zip = createZip([
    { name: 'main.png', data: solidPNG(2, 2, [1, 2, 3, 4]) },
    { name: '01.png', data: new Uint8Array([1, 2, 3]) },
  ]);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zip-test-'));
  const file = path.join(dir, 'a.zip');
  fs.writeFileSync(file, zip);
  let out;
  try {
    out = execFileSync('unzip', ['-t', file], { encoding: 'utf8' });
  } catch (e) {
    if (e.code === 'ENOENT') return t.skip('unzip not installed');
    throw e;
  }
  assert.match(out, /No errors detected/);
  assert.match(out, /main\.png/);
  assert.match(out, /01\.png/);
});

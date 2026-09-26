const test = require('node:test');
const assert = require('node:assert');
const { inpaint, guessPivot } = require('../js/parts.js');

function solid(w, h, rgba) {
  const d = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) d.set(rgba, i * 4);
  return d;
}

test('inpaint fills a hole in a white body with white', () => {
  const w = 40, h = 40;
  const d = solid(w, h, [255, 255, 255, 255]);
  const mask = new Uint8Array(w * h);
  for (let y = 15; y < 25; y++) for (let x = 15; x < 25; x++) {
    mask[y * w + x] = 1;
    d.set([60, 40, 20, 255], (y * w + x) * 4); // the brown "hand" being cut out
  }
  inpaint(d, w, h, mask);
  const c = (20 * w + 20) * 4;
  assert.deepStrictEqual(Array.from(d.slice(c, c + 4)).map(Math.round), [255, 255, 255, 255]);
});

test('inpaint keeps a hole over transparent surroundings transparent', () => {
  const w = 20, h = 20;
  const d = new Uint8Array(w * h * 4); // fully transparent
  const mask = new Uint8Array(w * h);
  for (let y = 5; y < 15; y++) for (let x = 5; x < 15; x++) {
    mask[y * w + x] = 1;
    d.set([60, 40, 20, 255], (y * w + x) * 4);
  }
  inpaint(d, w, h, mask);
  assert.strictEqual(d[(10 * w + 10) * 4 + 3], 0);
});

test('guessPivot picks the traced point nearest the body', () => {
  // Body on the left half; the traced "hand" sticks out on the right.
  const w = 100, h = 100;
  const d = new Uint8Array(w * h * 4);
  for (let y = 20; y < 80; y++) for (let x = 10; x < 60; x++) d.set([255, 255, 255, 255], (y * w + x) * 4);
  const mask = new Uint8Array(w * h);
  const poly = [[0.55, 0.45], [0.9, 0.4], [0.9, 0.6], [0.55, 0.55]];
  const [px] = guessPivot(poly, d, w, h, mask);
  assert.strictEqual(px, 0.55);
});

test('guessPivot finds the wrist of a raised hand, not its top', () => {
  // Body fills the lower-left; a raised "hand" rises from the body's top-right.
  const w = 100, h = 100;
  const d = new Uint8Array(w * h * 4);
  for (let y = 60; y < 100; y++) for (let x = 0; x < 70; x++) d.set([255, 255, 255, 255], (y * w + x) * 4);
  for (let y = 20; y < 70; y++) for (let x = 55; x < 70; x++) d.set([60, 40, 20, 255], (y * w + x) * 4);
  // Traced around the hand, down to where it meets the body.
  const poly = [[0.53, 0.18], [0.6, 0.16], [0.72, 0.18], [0.73, 0.4], [0.73, 0.62], [0.62, 0.64], [0.53, 0.62], [0.52, 0.4]];
  const mask = new Uint8Array(w * h);
  for (let y = 16; y < 64; y++) for (let x = 52; x < 73; x++) mask[y * w + x] = 1;
  const [, py] = guessPivot(poly, d, w, h, mask);
  assert.ok(py > 0.55, `pivot y ${py} should be at the bottom (wrist), not the top`);
});

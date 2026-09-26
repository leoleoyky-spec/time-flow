const test = require('node:test');
const assert = require('node:assert');
const { findGrid, evenGrid, alignFrames, thinFrames, frameCountFor } = require('../js/sprite.js');

function blank(w, h) {
  return new Uint8Array(w * h * 4);
}
function rect(d, w, x0, y0, x1, y1) {
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) d.set([60, 40, 20, 255], (y * w + x) * 4);
}

test('findGrid finds a 3×2 sheet from the gutters', () => {
  const w = 300, h = 200;
  const d = blank(w, h);
  for (let r = 0; r < 2; r++) for (let c = 0; c < 3; c++) rect(d, w, c * 100 + 20, r * 100 + 15, c * 100 + 80, r * 100 + 85);
  const g = findGrid(d, w, h);
  assert.strictEqual(g.cols, 3);
  assert.strictEqual(g.rows, 2);
  assert.strictEqual(g.cells.length, 6);
  assert.deepStrictEqual([g.cells[4].x < 120, g.cells[4].x + g.cells[4].w > 180, g.cells[4].y < 115], [true, true, true]);
});

test('a frame with a small gap inside is not split in two', () => {
  const w = 200, h = 100;
  const d = blank(w, h);
  rect(d, w, 10, 10, 45, 90); // a body …
  rect(d, w, 47, 30, 80, 60); // … and an arm 2px away
  rect(d, w, 120, 10, 190, 90);
  assert.strictEqual(findGrid(d, w, h).cols, 2);
});

test('no gutters → null, and evenGrid splits evenly instead', () => {
  const w = 100, h = 100;
  const d = blank(w, h);
  rect(d, w, 0, 0, 100, 100);
  assert.strictEqual(findGrid(d, w, h), null);
  const { cells } = evenGrid(100, 100, 2, 2);
  assert.deepStrictEqual(cells[3], { x: 50, y: 50, w: 50, h: 50 });
});

test('alignFrames steadies a trembling frame but keeps a deliberate jump', () => {
  const w = 100, h = 100;
  const a = blank(w, h);
  rect(a, w, 30, 40, 70, 90);
  const jitter = blank(w, h);
  rect(jitter, w, 33, 38, 73, 88); // drawn 3px right, 2px up
  const jump = blank(w, h);
  rect(jump, w, 30, 10, 70, 60); // jumped 30px up
  const [, fix, keep] = alignFrames([{ d: a, w, h }, { d: jitter, w, h }, { d: jump, w, h }], 'auto');
  assert.ok(Math.abs(fix[0] + 3) <= 1 && Math.abs(fix[1] - 2) <= 1, `jitter fix ${fix}`);
  assert.ok(Math.abs(keep[1]) <= 6, `jump should mostly stay, got ${keep}`);
  const feet = alignFrames([{ d: a, w, h }, { d: jump, w, h }], 'bottom');
  assert.deepStrictEqual(feet[1], [0, 30]);
});

test('thinFrames and frameCountFor keep LINE’s 5–20 frames', () => {
  assert.strictEqual(thinFrames(60).length, 20);
  assert.deepStrictEqual(thinFrames(3), [0, 1, 2]);
  assert.strictEqual(frameCountFor(4), 8);
  assert.strictEqual(frameCountFor(2), 6);
  assert.strictEqual(frameCountFor(9), 9);
  assert.strictEqual(frameCountFor(30), 20);
});

test('rows whose gaps are staggered between columns are still found', () => {
  const w = 200, h = 200;
  const d = blank(w, h);
  // Column 1 has its row gap at y≈95, column 2 at y≈115: no gap runs across both.
  rect(d, w, 10, 5, 90, 90); rect(d, w, 10, 100, 90, 195);
  rect(d, w, 110, 5, 190, 110); rect(d, w, 110, 120, 190, 195);
  const g = findGrid(d, w, h);
  assert.strictEqual(g.cols, 2);
  assert.strictEqual(g.rows, 2);
});

test('a 4×4 sheet is not mistaken for 2×2, nor split between words and character', () => {
  const w = 400, h = 400;
  const d = blank(w, h);
  for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) {
    rect(d, w, c * 100 + 20, r * 100 + 8, c * 100 + 80, r * 100 + 28); // words
    rect(d, w, c * 100 + 15, r * 100 + 38, c * 100 + 85, r * 100 + 92); // character
  }
  const g = findGrid(d, w, h);
  assert.strictEqual(`${g.cols}x${g.rows}`, '4x4');
});

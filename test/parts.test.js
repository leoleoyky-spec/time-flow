const test = require('node:test');
const assert = require('node:assert');
const { guessPivot, partWeight, buildMesh, deformVertex } = require('../js/parts.js');

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

test('partWeight: 1 inside the outline, easing to 0 outside', () => {
  const sq = [[10, 10], [20, 10], [20, 20], [10, 20]];
  assert.strictEqual(partWeight(15, 15, sq, 10), 1);
  const near = partWeight(22, 15, sq, 10);
  assert.ok(near > 0 && near < 1);
  assert.strictEqual(partWeight(40, 15, sq, 10), 0);
});

test('bending moves the part, leaves far pixels alone, and keeps the joint fixed', () => {
  // A "hand" square on the right; joint at its left edge.
  const parts = [{ poly: [[0.6, 0.4], [0.8, 0.4], [0.8, 0.6], [0.6, 0.6]], pivot: [0.6, 0.5], cfg: { type: 'wave', amount: 100, speed: 1 } }];
  const mesh = buildMesh(100, 100, parts, { cells: 20, falloff: 0.1 });
  const at = (x, y) => (y / mesh.cell) * (mesh.cols + 1) + x / mesh.cell;
  const t = 0.25; // peak of the swing
  const hand = deformVertex(mesh, at(75, 50), parts, t);
  assert.ok(Math.hypot(hand[0] - 75, hand[1] - 50) > 5, 'the hand should move');
  const far = deformVertex(mesh, at(10, 10), parts, t);
  assert.deepStrictEqual(far, [10, 10]);
  const joint = deformVertex(mesh, at(60, 50), parts, t);
  assert.ok(Math.hypot(joint[0] - 60, joint[1] - 50) < 0.001, 'the joint should stay put');
  // Only cells near the part are bent.
  assert.ok(mesh.cells.length / 2 < mesh.cols * mesh.rows / 2);
});

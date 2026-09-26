const test = require('node:test');
const assert = require('node:assert');
const { removeBackgroundPixels } = require('../js/bg-remove.js');

// A white "face" inside a dark ring on a white background. The ring has 1px gaps
// of a lighter color, like a crayon outline, which is what the fill used to leak through.
function crayonFace(w = 200, h = 200) {
  const d = new Uint8Array(w * h * 4);
  const cx = w / 2;
  const cy = h / 2;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const r = Math.hypot(x - cx, y - cy);
      let c = [255, 255, 255];
      if (r > 50 && r < 56) {
        const gap = (Math.atan2(y - cy, x - cx) * 180) / Math.PI;
        c = Math.abs(gap % 30) < 1 ? [215, 205, 200] : [70, 45, 35];
      }
      d.set([...c, 255], i);
    }
  }
  return { d, w, h, cx, cy };
}

const alphaAt = (d, w, x, y) => d[(Math.round(y) * w + Math.round(x)) * 4 + 3];

test('keeps the inside of a drawing whose outline has small gaps', () => {
  const { d, w, h, cx, cy } = crayonFace();
  removeBackgroundPixels(d, w, h, { tolerance: 45 });
  assert.strictEqual(alphaAt(d, w, cx, cy), 255, 'face center erased');
  assert.strictEqual(alphaAt(d, w, cx + 30, cy), 255, 'face erased near the outline');
  assert.strictEqual(alphaAt(d, w, 5, 5), 0, 'background not removed');
  assert.strictEqual(alphaAt(d, w, cx + 80, cy), 0, 'background next to the drawing not removed');
});

test('already-transparent images are left alone', () => {
  const w = 10;
  const h = 10;
  const d = new Uint8Array(w * h * 4); // all alpha 0
  d.set([200, 50, 50, 255], (5 * w + 5) * 4);
  const res = removeBackgroundPixels(d, w, h, { tolerance: 45 });
  assert.strictEqual(res.alreadyTransparent, true);
  assert.strictEqual(alphaAt(d, w, 5, 5), 255);
});

test('a picked color is used instead of the corners', () => {
  const w = 20;
  const h = 20;
  const d = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) d.set([0, 200, 0, 255], i * 4); // green screen
  d.set([255, 0, 0, 255], (10 * w + 10) * 4);
  removeBackgroundPixels(d, w, h, { tolerance: 25, color: [0, 200, 0] });
  assert.strictEqual(alphaAt(d, w, 0, 0), 0);
  assert.ok(alphaAt(d, w, 10, 10) > 0);
});

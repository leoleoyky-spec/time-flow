const test = require('node:test');
const assert = require('node:assert');

global.window = {};
require('../js/animations.js');
const { MOTIONS } = window.Stickers;

test('the new motions loop seamlessly (same pose at t=0 and t→1)', () => {
  for (const id of ['shiri', 'dance', 'bow']) {
    const a = MOTIONS[id].fn(0, 320, 270);
    const b = MOTIONS[id].fn(0.99999, 320, 270);
    for (const k of ['x', 'y', 'rot', 'sx', 'sy', 'skew']) {
      assert.ok(Math.abs((a[k] || (k[0] === 's' && k !== 'skew' ? 1 : 0)) - (b[k] || (k[0] === 's' && k !== 'skew' ? 1 : 0))) < 0.01, `${id}.${k}`);
    }
  }
});

test('おしりふりふり keeps the top still and swings the bottom', () => {
  const m = MOTIONS.shiri.fn(1 / 12, 320, 270); // a peak of the wiggle
  assert.ok(Math.abs(m.skew) > 0.15);
  assert.ok(m.pivotY < 0, 'pivot at the top');
});

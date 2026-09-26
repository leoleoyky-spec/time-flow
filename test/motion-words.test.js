const test = require('node:test');
const assert = require('node:assert');
const { parseMotionText, EXAMPLES } = require('../js/motion-words.js');

test('returns null for empty or unknown text', () => {
  assert.strictEqual(parseMotionText(''), null);
  assert.strictEqual(parseMotionText('こんにちは'), null);
});

test('大きく跳ねる: bounce up and down, amplified', () => {
  const r = parseMotionText('大きく跳ねる');
  assert.strictEqual(r.custom.wave, 'bounce');
  assert.ok(r.custom.moveY > 60);
  assert.deepStrictEqual(r.understood, ['跳ねる', '大きく']);
});

test('a count like 2回 sets speed and does not trigger spinning', () => {
  const r = parseMotionText('2回跳ねる');
  assert.strictEqual(r.custom.speed, 2);
  assert.strictEqual(r.custom.rotate, 0);
});

test('くるくる回る spins', () => {
  assert.strictEqual(parseMotionText('くるくる回る').custom.rotate, 45);
});

test('大きくなる is zoom, not the 大きく modifier', () => {
  const r = parseMotionText('ドキドキ大きくなる');
  assert.ok(r.custom.zoom >= 20);
  assert.ok(!r.understood.includes('大きく'));
});

test('速く raises speed and shake keeps its wave', () => {
  const r = parseMotionText('速くぶるぶる震える');
  assert.strictEqual(r.custom.wave, 'shake');
  assert.strictEqual(r.custom.speed, 4);
});

test('ゆっくり slows down and softens a bounce', () => {
  const r = parseMotionText('ゆっくり跳ねる');
  assert.strictEqual(r.custom.speed, 1);
  assert.strictEqual(r.custom.wave, 'smooth');
  assert.ok(r.custom.moveY < 60);
});

test('逆 flips the direction', () => {
  assert.ok(parseMotionText('逆に左右にゆれる').custom.moveX < 0);
});

test('values stay inside the slider ranges', () => {
  const r = parseMotionText('めっちゃ大きく思いっきり速く跳ねて回ってドキドキ');
  assert.ok(Math.abs(r.custom.moveY) <= 100);
  assert.ok(Math.abs(r.custom.rotate) <= 45);
  assert.ok(Math.abs(r.custom.zoom) <= 50);
  assert.ok(r.custom.speed >= 1 && r.custom.speed <= 4);
});

test('every example chip is understood', () => {
  for (const ex of EXAMPLES) assert.notStrictEqual(parseMotionText(ex), null, ex);
});

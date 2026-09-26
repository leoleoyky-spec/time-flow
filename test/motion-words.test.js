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

test('円を描く, 止まる and 伸び縮み set the new controls', () => {
  assert.strictEqual(parseMotionText('円を描いてふわふわ').custom.path, 'circle');
  assert.ok(parseMotionText('跳ねて一瞬止まる').custom.pause > 0);
  const r = parseMotionText('むにゅっと伸び縮み');
  assert.ok(r.custom.squash > 0);
  assert.strictEqual(r.custom.zoom, 0, '伸び縮み must not also count as 縮む');
});

const { parseInstruction, WISH_EXAMPLES } = require('../js/motion-words.js');

test('parseInstruction reads text, colors, effect, font and motion together', () => {
  const { changes } = parseInstruction('「ありがとう」を赤い文字と白いフチで、ハートを出して大きく2回跳ねる');
  assert.strictEqual(changes.text, 'ありがとう');
  assert.strictEqual(changes.color, '#e5484d');
  assert.strictEqual(changes.strokeColor, '#ffffff');
  assert.strictEqual(changes.effect, 'hearts');
  assert.strictEqual(changes.motion, 'custom');
  assert.strictEqual(changes.custom.speed, 2);
});

test('a color followed by an effect word colors the effect', () => {
  const { changes } = parseInstruction('水色のキラキラ');
  assert.strictEqual(changes.effectColor, '#38bdf8');
  assert.strictEqual(changes.effect, 'sparkle');
  assert.ok(!('color' in changes));
});

test('font, size and timing words', () => {
  const { changes } = parseInstruction('手書きで文字を大きく、なめらかに3秒');
  assert.strictEqual(changes.font, 'Yusei Magic');
  assert.strictEqual(changes.fontSize, 96);
  assert.strictEqual(changes.frames, 20);
  assert.strictEqual(changes.duration, 3);
});

test('動かさない turns motion off', () => {
  assert.strictEqual(parseInstruction('動かさないで').changes.motion, 'none');
});

test('every おまかせ example is understood', () => {
  for (const ex of WISH_EXAMPLES) assert.ok(parseInstruction(ex).understood.length >= 3, ex);
});

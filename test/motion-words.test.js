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

const { parsePartRequest } = require('../js/motion-words.js');

test('左手だけ左右に振る is a part request that keeps the rest still', () => {
  const r = parsePartRequest('パンダの左手だけ左右に振る');
  assert.strictEqual(r.name, '左手');
  assert.strictEqual(r.only, true);
  assert.strictEqual(r.cfg.type, 'wave');
});

test('part requests read direction, size and speed', () => {
  assert.strictEqual(parsePartRequest('耳を上下にぴょこぴょこ').cfg.type, 'updown');
  assert.strictEqual(parsePartRequest('しっぽをぶるぶる').cfg.type, 'shake');
  const r = parsePartRequest('右手を大きく速く振る');
  assert.strictEqual(r.cfg.amount, 80);
  assert.strictEqual(r.cfg.speed, 3);
  assert.strictEqual(r.only, false);
});

test('no body part means no part request (大きく跳ねる stays a whole-body motion)', () => {
  assert.strictEqual(parsePartRequest('大きく跳ねる'), null);
  assert.strictEqual(parsePartRequest('ぴょんぴょん跳ねる'), null);
});

const { parsePartRequests, parsePartMotion } = require('../js/motion-words.js');

test('several parts in one sentence', () => {
  const r = parsePartRequests('左手を大きく振って、右耳を上下にぴょこぴょこ');
  assert.deepStrictEqual(r.map((x) => x.name), ['左手', '右耳']);
  assert.strictEqual(r[0].cfg.type, 'wave');
  assert.strictEqual(r[0].cfg.amount, 80);
  assert.strictEqual(r[1].cfg.type, 'updown');
});

test('parsePartMotion reads a motion without a body part', () => {
  const r = parsePartMotion('ゆっくり小さく振る');
  assert.strictEqual(r.cfg.type, 'wave');
  assert.strictEqual(r.cfg.speed, 1);
  assert.strictEqual(r.cfg.amount, 25);
  assert.strictEqual(parsePartMotion('こんにちは'), null);
});

test('text shape and place words', () => {
  let c = parseInstruction('「やったー」を文字をアーチにして右上に').changes;
  assert.strictEqual(c.textCurve, 50);
  c = parseInstruction('文字を下に、にっこりの形で斜めに').changes;
  assert.deepStrictEqual(c.textPos, [0, 0.25]);
  assert.strictEqual(c.textCurve, -50);
  assert.strictEqual(c.textRotate, -12);
  assert.deepStrictEqual(parseInstruction('文字を右上にして').changes.textPos, [0.25, -0.25]);
});

test('上下 as a motion is not taken as a text position', () => {
  const c = parseInstruction('上下にふわふわ').changes;
  assert.ok(!('textPos' in c));
  assert.strictEqual(c.motion, 'custom');
});

test('a text position later in the sentence is still read', () => {
  assert.deepStrictEqual(parseInstruction('「だいすき」を文字をアーチにして上に').changes.textPos, [0, -0.25]);
  assert.ok(!('textPos' in parseInstruction('「やった」を上下に跳ねる').changes));
});

test('wink words', () => {
  assert.strictEqual(parsePartRequest('右目でウインク').cfg.type, 'wink');
  assert.strictEqual(parsePartRequest('右目でウインク').name, '右目');
  assert.strictEqual(parsePartRequest('まばたきする').name, '目');
  assert.strictEqual(parsePartMotion('目をつぶる').cfg.type, 'wink');
});

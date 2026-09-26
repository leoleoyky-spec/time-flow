// Turns a Japanese description of a motion ("大きく跳ねる", "ゆっくり左右にゆれる")
// into the custom-motion slider values. Keyword based, so it runs offline and free.
// Works in the browser (window.MotionWords) and in Node (module.exports).
(function (root) {
  'use strict';

  // Each action adds to the base motion. `words` are matched as plain substrings.
  const ACTIONS = [
    { label: 'おじぎ', words: ['おじぎ', 'お辞儀', 'ぺこ', 'ペコ', 'うなず', '頷', 'うんうん'], set: { moveY: 30, rotate: 8 }, wave: 'bounce' },
    { label: '跳ねる', words: ['跳ね', 'はね', 'ハネ', 'ぴょん', 'ピョン', 'ジャンプ', 'じゃんぷ', 'バウンド', '弾'], set: { moveY: 60 }, wave: 'bounce' },
    { label: 'ふわふわ', words: ['ふわ', 'フワ', '浮', '漂', 'ただよ'], set: { moveY: 25 }, wave: 'smooth' },
    { label: '上下', words: ['上下', 'うえした', '縦', 'たて'], set: { moveY: 50 } },
    { label: '左右', words: ['左右', 'さゆう', '横', 'よこ', 'スライド'], set: { moveX: 50 } },
    { label: '回る', words: ['回', 'まわ', 'くるくる', 'クルクル', 'ぐるぐる', 'グルグル'], set: { rotate: 45 } },
    { label: '揺れる', words: ['揺', 'ゆれ', 'ゆら', 'ユラ', 'ふら', 'フラ', 'スイング'], set: { rotate: 15 }, wave: 'smooth' },
    { label: '傾く', words: ['傾', 'かたむ', 'かしげ', 'かしげる'], set: { rotate: 12 } },
    { label: '手を振る', words: ['手を振', '手をふ', 'バイバイ', 'ばいばい', 'フリフリ', 'ふりふり'], set: { rotate: 20 }, speed: 2 },
    { label: 'ぶるぶる', words: ['震', 'ふる', 'ぶるぶる', 'ブルブル', 'ガクガク', 'がくがく', 'ガタガタ'], set: { moveX: 20 }, wave: 'shake', speed: 3 },
    { label: 'ぷるぷる', words: ['ぷるぷる', 'プルプル', 'ぷにぷに'], set: { zoom: 12 }, wave: 'bounce', speed: 2 },
    { label: 'ドキドキ', words: ['ドキドキ', 'どきどき', 'ドクドク', '鼓動', '心臓'], set: { zoom: 20 }, wave: 'bounce', speed: 2 },
    { label: '大きくなる', words: ['拡大', '膨ら', 'ふくら', '大きくなる', '大きくなっ', '伸び縮み', 'のびちぢみ', 'ズーム'], set: { zoom: 25 } },
    { label: '縮む', words: ['縮', 'ちぢ', '小さくなる', '小さくなっ'], set: { zoom: -20 } },
  ];

  const MODIFIERS = [
    { label: '速く', words: ['速', '早く', 'はやく', 'すばや', '素早', 'せかせか', '激し', 'はげし'], scale: 1.3, speed: 1 },
    { label: 'ゆっくり', words: ['ゆっくり', 'のんびり', 'ゆったり', '穏やか', 'おだやか', 'やさしく', '優しく'], scale: 0.7, slow: true },
    { label: '大きく', words: ['大きく', 'おおきく', '思いっきり', '思い切り', '大げさ', 'めっちゃ', 'すごく', 'たくさん'], scale: 1.5 },
    { label: '少しだけ', words: ['少し', 'すこし', 'ちょっと', '控えめ', 'ひかえめ', '軽く', 'かるく', '小さく'], scale: 0.5 },
    { label: '逆向き', words: ['逆', 'ぎゃく', '反対'], flip: true },
  ];

  const DIGITS = { '１': 1, '２': 2, '３': 3, '４': 4, 一: 1, 二: 2, 三: 3, 四: 4 };

  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const has = (text, words) => words.some((w) => text.includes(w));

  /**
   * @param {string} text  e.g. "大きく2回跳ねる"
   * @returns {null | {custom: {wave, speed, moveX, moveY, rotate, zoom}, understood: string[]}}
   *   null when no motion word was recognised.
   */
  function parseMotionText(text) {
    const t = String(text || '').trim();
    if (!t) return null;

    // "2回" is a count, not the 回る (spin) action.
    const TIMES = /([1-4１-４一二三四])\s*(回|かい|度)/;
    const actionText = t.replace(new RegExp(TIMES.source, 'g'), '');
    // "大きくなる" is a zoom action, not the "大きく" modifier; "小さくなる" likewise.
    const forModifiers = actionText.replace(/大きくな|小さくな/g, '');

    const custom = { wave: 'smooth', speed: 1, moveX: 0, moveY: 0, rotate: 0, zoom: 0 };
    const understood = [];
    let matched = false;

    for (const a of ACTIONS) {
      if (!has(actionText, a.words)) continue;
      matched = true;
      understood.push(a.label);
      for (const [k, v] of Object.entries(a.set)) {
        custom[k] = Math.abs(v) > Math.abs(custom[k]) ? v : custom[k];
      }
      if (a.wave && (custom.wave === 'smooth' || a.wave === 'shake')) custom.wave = a.wave;
      if (a.speed) custom.speed = Math.max(custom.speed, a.speed);
    }
    if (!matched) return null;

    let scale = 1;
    for (const m of MODIFIERS) {
      if (!has(forModifiers, m.words)) continue;
      understood.push(m.label);
      if (m.scale) scale *= m.scale;
      if (m.speed) custom.speed += m.speed;
      if (m.slow) {
        custom.speed = 1;
        if (custom.wave === 'bounce') custom.wave = 'smooth';
      }
      if (m.flip) {
        custom.moveX = -custom.moveX;
        custom.moveY = -custom.moveY;
        custom.rotate = -custom.rotate;
      }
    }

    const times = t.match(TIMES);
    if (times) {
      custom.speed = DIGITS[times[1]] || Number(times[1]);
      understood.push(`${custom.speed}回`);
    }

    custom.moveX = clamp(Math.round(custom.moveX * scale / 5) * 5, -100, 100);
    custom.moveY = clamp(Math.round(custom.moveY * scale / 5) * 5, -100, 100);
    custom.rotate = clamp(Math.round(custom.rotate * scale), -45, 45);
    custom.zoom = clamp(Math.round(custom.zoom * scale), -50, 50);
    custom.speed = clamp(custom.speed, 1, 4);
    return { custom, understood };
  }

  const EXAMPLES = ['大きく跳ねる', 'ゆっくり左右にゆれる', '速くぶるぶる震える', 'ドキドキ大きくなる', 'くるくる回る', 'ぺこりとおじぎ', 'ふわふわ浮かぶ', '手を振る'];

  const api = { parseMotionText, EXAMPLES };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.MotionWords = api;
})(typeof window !== 'undefined' ? window : globalThis);

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
    { label: '大きくなる', words: ['拡大', '膨ら', 'ふくら', '大きくなる', '大きくなっ', 'ズーム'], set: { zoom: 25 } },
    { label: '伸び縮み', words: ['伸び縮み', 'のびちぢみ', 'むにゅ', 'ムニュ', 'びよーん', 'ビヨーン', 'つぶれ', 'ぺちゃ'], set: { squash: 20 } },
    { label: '円を描く', words: ['円', 'ぐるっと', '一周', '輪を描'], set: { moveX: 40, moveY: 40 }, path: 'circle' },
    { label: '止まる', words: ['止ま', 'とま', 'ポーズ', 'ためて', 'タメ', '静止'], set: { pause: 40 } },
    { label: '縮む', words: ['縮', 'ちぢ', '小さくなる', '小さくなっ'], unless: ['伸び縮み', 'のびちぢみ'], set: { zoom: -20 } },
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
   * @returns {null | {custom: {wave, path, speed, moveX, moveY, rotate, zoom, pause, squash}, understood: string[]}}
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

    const custom = { wave: 'smooth', path: 'line', speed: 1, moveX: 0, moveY: 0, rotate: 0, zoom: 0, pause: 0, squash: 0 };
    const understood = [];
    let matched = false;

    for (const a of ACTIONS) {
      const scope = (a.unless || []).reduce((txt, w) => txt.split(w).join(''), actionText);
      if (!has(scope, a.words)) continue;
      matched = true;
      understood.push(a.label);
      for (const [k, v] of Object.entries(a.set)) {
        custom[k] = Math.abs(v) > Math.abs(custom[k]) ? v : custom[k];
      }
      if (a.wave && (custom.wave === 'smooth' || a.wave === 'shake')) custom.wave = a.wave;
      if (a.path) custom.path = a.path;
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
    custom.squash = clamp(Math.round(custom.squash * scale), -30, 30);
    custom.pause = clamp(custom.pause, 0, 60);
    custom.speed = clamp(custom.speed, 1, 4);
    return { custom, understood };
  }


  // ---- whole-sticker instructions ("言葉でおまかせ") ----

  // Longer names first so 水色 wins over a shorter overlapping word.
  const COLORS = [
    ['水色', '#38bdf8'], ['みずいろ', '#38bdf8'], ['ピンク', '#ff5a8a'], ['オレンジ', '#fb8c1e'],
    ['むらさき', '#9b5de5'], ['ちゃいろ', '#7a4a2a'], ['きいろ', '#f5c518'], ['グレー', '#888888'],
    ['みどり', '#22a55e'], ['紫', '#9b5de5'], ['茶', '#7a4a2a'], ['黄', '#f5c518'], ['緑', '#22a55e'],
    ['赤', '#e5484d'], ['あか', '#e5484d'], ['青', '#2f7de1'], ['あお', '#2f7de1'], ['黒', '#222222'],
    ['くろ', '#222222'], ['白', '#ffffff'], ['しろ', '#ffffff'], ['金', '#d4a017'], ['桃', '#ff7eb3'],
  ];
  const COLOR_NAMES = { '#38bdf8': '水色', '#ff5a8a': 'ピンク', '#fb8c1e': 'オレンジ', '#9b5de5': '紫', '#7a4a2a': '茶色',
    '#f5c518': '黄色', '#888888': 'グレー', '#22a55e': '緑', '#e5484d': '赤', '#2f7de1': '青', '#222222': '黒',
    '#ffffff': '白', '#d4a017': '金', '#ff7eb3': '桃色' };

  const EFFECT_WORDS = [
    ['sparkle', 'キラキラ', ['キラキラ', 'きらきら', '星', 'スター']],
    ['hearts', 'ハート', ['ハート', 'はーと', 'ラブ', '好き', 'すき']],
    ['lines', '集中線', ['集中線', 'びっくり', 'ビックリ', '驚']],
    ['sweat', '汗', ['汗', 'あせ', '焦']],
    ['notes', '音符', ['音符', '♪', '歌', 'ルンルン', 'るんるん', '音楽']],
    ['anger', 'プンプン', ['プンプン', 'ぷんぷん', '怒', 'ムカ', 'むか']],
  ];
  const EFFECT_TARGET = ['キラキラ', 'きらきら', '星', 'ハート', 'エフェクト', '汗', '音符', '線', '飾り'];

  const FONT_WORDS = [
    ['Hachi Maru Pop', 'ポップな文字', ['ポップ', 'かわいい文字', '可愛い文字', 'かわいいフォント']],
    ['Yusei Magic', '手書き文字', ['手書き', 'てがき', 'マジック']],
    ['M PLUS Rounded 1c', '丸い文字', ['丸い文字', 'まるい文字', '丸文字', 'まる文字', 'やわらかい文字', '丸ゴシック']],
    ['RocknRoll One', '元気な文字', ['ロック', '元気な文字', '力強い']],
    ['Kaisei Decol', '明朝の文字', ['明朝', '上品', '和風', '大人っぽ']],
    ['Dela Gothic One', '太い文字', ['極太', '太い文字', '太字', 'ゴシック']],
  ];

  const takeAll = (text, words) => words.reduce((t, w) => t.split(w).join(' '), text);

  /**
   * Read a free-form request for a whole sticker.
   * e.g. 「おはよう」をピンクの文字で、キラキラさせて、ゆっくりふわふわ動かす
   * @returns {{changes: object, understood: string[]}}  `changes` holds sticker fields to assign;
   *   `changes.custom` is set (with motion 'custom') when a motion was described.
   */
  function parseInstruction(text) {
    let rest = String(text || '');
    const changes = {};
    const understood = [];

    const quoted = rest.match(/[「『"“]([^」』"”]+)[」』"”]/);
    if (quoted) {
      changes.text = quoted[1].replace(/\\n/g, '\n');
      understood.push(`文字「${changes.text}」`);
      rest = rest.replace(quoted[0], ' ');
    }

    // Colors: decide whether each one is for the text, the outline or the effect.
    for (const [word, hex] of COLORS) {
      let at;
      while ((at = rest.indexOf(word)) !== -1) {
        const after = rest.slice(at + word.length, at + word.length + 8);
        const before = rest.slice(Math.max(0, at - 6), at);
        // The nearest noun after the color decides: 赤い文字と白いフチ → text red, outline white.
        const pos = (i) => (i < 0 ? Infinity : i);
        const near = [
          ['color', pos(after.search(/文字|字|もじ/))],
          ['strokeColor', pos(after.search(/フチ|ふち|縁/))],
          ['effectColor', Math.min(...EFFECT_TARGET.map((w) => pos(after.indexOf(w))))],
        ].sort((a, b) => a[1] - b[1]);
        let field = near[0][1] < Infinity ? near[0][0] : 'color';
        if (near[0][1] === Infinity && /フチ|ふち|縁/.test(before)) field = 'strokeColor';
        if (!(field in changes)) {
          changes[field] = hex;
          const where = { color: '文字', strokeColor: 'フチ', effectColor: '飾り' }[field];
          understood.push(`${where}の色：${COLOR_NAMES[hex]}`);
        }
        rest = rest.slice(0, at) + ' ' + rest.slice(at + word.length);
      }
    }

    if (/エフェクトなし|飾りなし|かざりなし/.test(rest)) {
      changes.effect = 'none';
      understood.push('飾りなし');
      rest = rest.replace(/エフェクトなし|飾りなし|かざりなし/g, ' ');
    }
    for (const [id, label, words] of EFFECT_WORDS) {
      if (!has(rest, words)) continue;
      if (!changes.effect) {
        changes.effect = id;
        understood.push(`飾り：${label}`);
      }
      rest = takeAll(rest, words);
    }

    for (const [id, label, words] of FONT_WORDS) {
      if (!has(rest, words)) continue;
      if (!changes.font) {
        changes.font = id;
        understood.push(label);
      }
      rest = takeAll(rest, words);
    }

    const size = rest.match(/(文字|字|もじ)(を|が|は)?(もっと)?(大き|でか|小さ)/);
    if (size) {
      changes.fontSize = size[4] === '小さ' ? 44 : 96;
      understood.push(size[4] === '小さ' ? '文字を小さく' : '文字を大きく');
      rest = rest.replace(size[0], ' ');
    }

    if (/なめらか|ぬるぬる|ヌルヌル|スムーズ/.test(rest)) {
      changes.frames = 20;
      understood.push('なめらか（20コマ）');
      rest = rest.replace(/なめらか|ぬるぬる|ヌルヌル|スムーズ/g, ' ');
    } else if (/カクカク|かくかく|パラパラ|ぱらぱら/.test(rest)) {
      changes.frames = 6;
      understood.push('カクカク（6コマ）');
      rest = rest.replace(/カクカク|かくかく|パラパラ|ぱらぱら/g, ' ');
    }
    const secs = rest.match(/([1-4１-４])\s*秒/);
    if (secs) {
      changes.duration = DIGITS[secs[1]] || Number(secs[1]);
      understood.push(`1ループ${changes.duration}秒`);
      rest = rest.replace(secs[0], ' ');
    }
    const loops = rest.match(/([1-4１-４一二三四])\s*(回|かい)\s*(ループ|くりかえ|繰り返)/);
    if (loops) {
      changes.loops = DIGITS[loops[1]] || Number(loops[1]);
      understood.push(`${changes.loops}回くりかえす`);
      rest = rest.replace(loops[0], ' ');
    }

    if (/動かさない|動かない|うごかない|止めたまま|静止画/.test(rest)) {
      changes.motion = 'none';
      understood.push('動かさない');
    } else {
      const m = parseMotionText(rest);
      if (m) {
        changes.motion = 'custom';
        changes.custom = m.custom;
        understood.push('動き：' + m.understood.join('・'));
      }
    }
    return { changes, understood };
  }

  const WISH_EXAMPLES = [
    '「おはよう」をピンクの文字で、キラキラさせて、ゆっくりふわふわ',
    '「ありがとう」を赤い文字と白いフチで、ハートを出して大きく2回跳ねる',
    '「ごめんね」を青い手書き文字で、汗を出してぶるぶる震える',
    '「OK!」を太い文字で、集中線を出して速くドキドキ',
  ];

  const EXAMPLES = ['大きく跳ねる', 'ゆっくり左右にゆれる', '速くぶるぶる震える', 'ドキドキ大きくなる', 'くるくる回る', 'ぺこりとおじぎ', 'ふわふわ浮かぶ', '手を振る'];

  const api = { parseMotionText, parseInstruction, EXAMPLES, WISH_EXAMPLES };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.MotionWords = api;
})(typeof window !== 'undefined' ? window : globalThis);

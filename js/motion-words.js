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

    // Text shape and place: 文字をアーチに / にっこりの形に / 文字を右上に / 斜めに
    if (/アーチ|虹みたい|虹の形|山なり|山形|カーブ|上向きに曲|上に曲/.test(rest)) {
      changes.textCurve = 50;
      understood.push('文字をアーチに');
      rest = rest.replace(/アーチ|虹みたい|虹の形|山なり|山形|カーブ|上向きに曲|上に曲/g, ' ');
    } else if (/にっこり|笑顔の形|スマイル|U字|下向きに曲|下に曲/.test(rest)) {
      changes.textCurve = -50;
      understood.push('文字をにっこりの形に');
      rest = rest.replace(/にっこり|笑顔の形|スマイル|U字|下向きに曲|下に曲/g, ' ');
    }
    // "文字を右上に", or later in the same sentence: "文字をアーチにして上に".
    let place = rest.match(/(文字|字|もじ)(を|は|が)?(もっと)?((右|左)?(上|下)|右|左|真ん中|まんなか)(に|へ|のほう|側)/);
    if (!place && /文字|字|もじ/.test(rest)) {
      const m = rest.match(/(^|[^上下左右])((右|左)?(上|下)|右|左|真ん中|まんなか)(に|へ)(置|寄|移|して|。|、|$)/);
      if (m) place = [m[0].slice(m[1].length), '', '', '', m[2]];
    }
    if (place) {
      const p = place[4];
      const x = p.includes('右') ? 0.25 : p.includes('左') ? -0.25 : 0;
      const y = p.includes('上') ? -0.25 : p.includes('下') ? 0.25 : 0;
      changes.textPos = [x, y];
      understood.push(`文字を${p}に`);
      rest = rest.replace(place[0], ' ');
    }
    if (/斜め|ななめ|傾け|かたむけ/.test(rest)) {
      changes.textRotate = -12;
      understood.push('文字をななめに');
      rest = rest.replace(/斜め|ななめ|傾け|かたむけ/g, ' ');
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
    } else if (PRESET_WORDS.some((w) => w.re.test(rest))) {
      const w = PRESET_WORDS.find((x) => x.re.test(rest));
      changes.motion = w.motion;
      understood.push('動き：' + w.label);
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

  // Motions that have their own preset, used as-is instead of the custom sliders.
  const PRESET_WORDS = [
    { motion: 'shiri', label: 'おしりふりふり', re: /おしり|お尻|オシリ|ヒップ/ },
    { motion: 'dance', label: 'ノリノリ', re: /ダンス|だんす|踊|おどる|おどって|ノリノリ|のりのり/ },
    { motion: 'bow', label: 'ぺこり', re: /ぺこり|ペコリ|おじぎ|お辞儀/ },
  ];

  const WISH_EXAMPLES = [
    '「おはよう」をピンクの文字で、キラキラさせて、ふわふわ',
    '「ありがとう」を赤い文字で、ハートを出して、左手を振る',
  ];


  // ---- one part only ("左手だけ左右に振る") ----

  const WINK = /ウインク|ウィンク|まばたき|瞬き|目を?(閉じ|とじ|つぶ|つむ)/;
  const BODY_PARTS = ['左目', '右目', '両目', '左手', '右手', '両手', '左腕', '右腕', '手', '腕', '左耳', '右耳', '耳', 'しっぽ', '尻尾', 'シッポ',
    '頭', 'あたま', '顔', '足', 'あし', '羽', 'はね', 'ほっぺ', '目', 'リボン', '帽子', 'マグカップ', 'カップ'];

  /**
   * Read how one part should move, e.g. "大きく速く振る" (no body part needed).
   * @returns {null | {cfg: {type, amount, speed}, understood: string[]}}
   */
  function parsePartMotion(text) {
    const t = String(text || '');
    let type = null;
    let label = '';
    if (WINK.test(t)) { type = 'wink'; label = 'ウインク'; }
    else if (/上下|ぴょこ|ピョコ|跳ね|はね|うなず/.test(t)) { type = 'updown'; label = '上下にうごく'; }
    else if (/震|ぶるぶる|ブルブル|ぷるぷる|プルプル/.test(t)) { type = 'shake'; label = 'ぶるぶる'; }
    else if (/横に|スライド|左右にうごく|左右に動く/.test(t)) { type = 'side'; label = '左右にうごく'; }
    else if (/振|ふる|ふっ|フリフリ|バイバイ|左右|パタパタ|ぱたぱた|ゆら|揺|動/.test(t)) { type = 'wave'; label = 'ふる'; }

    // A wink closes the eye fully, once per loop, unless told otherwise.
    let amount = type === 'wink' ? 100 : 50;
    let speed = type === 'wink' ? 1 : 2;
    const understood = label ? [label] : [];
    if (has(t, ['大きく', 'おおきく', '思いっきり', '激し'])) { amount = 80; understood.push('大きく'); }
    if (has(t, ['少し', 'ちょっと', '小さく', '軽く', 'そっと'])) { amount = 25; understood.push('少しだけ'); }
    if (has(t, ['速', '早く', 'はやく'])) { speed = 3; understood.push('速く'); }
    if (has(t, ['ゆっくり', 'のんびり'])) { speed = 1; understood.push('ゆっくり'); }
    const times = t.match(/([1-4１-４一二三四])\s*(回|かい|度)/);
    if (times) { speed = DIGITS[times[1]] || Number(times[1]); understood.push(`${speed}回`); }
    if (!understood.length) return null;
    return { cfg: { type: type || 'wave', amount, speed }, understood };
  }

  /**
   * Detect requests to move parts of the picture: "左手だけ振る", or several at once,
   * "左手を振って、右耳を上下に". Each body part word starts a new request.
   * @returns {{name: string, only: boolean, cfg: {type, amount, speed}, understood: string[]}[]}
   *   `only` is true for "…だけ", meaning the rest of the picture should stay still.
   */
  function parsePartRequests(text) {
    const t = String(text || '');
    const hits = [];
    for (let i = 0; i < t.length; i++) {
      const name = BODY_PARTS.find((p) => t.startsWith(p, i));
      if (!name) continue;
      // "はね" is also 跳ね(る); only a part when followed by を/が/だけ/の.
      if (name === 'はね' && !/^はね(を|が|だけ|の)/.test(t.slice(i))) continue;
      hits.push([i, name]);
      i += name.length - 1;
    }
    // "ウインクして" names no part, but can only mean an eye.
    if (!hits.length && WINK.test(t)) hits.push([0, '目']);
    const only = /だけ|のみ|以外は?(動かさない|止め)/.test(t);
    return hits.map(([at, name], n) => {
      const seg = t.slice(at + name.length, n + 1 < hits.length ? hits[n + 1][0] : t.length);
      const m = parsePartMotion(seg) || { cfg: { type: 'wave', amount: 50, speed: 2 }, understood: ['ふる'] };
      return { name, only, cfg: m.cfg, understood: [name + (only ? 'だけ' : ''), ...m.understood] };
    });
  }

  function parsePartRequest(text) {
    return parsePartRequests(text)[0] || null;
  }


  // ---- asking an image AI to draw the frames ("スプライトシート") ----

  const SHEET_LAYOUTS = { 4: [2, 2], 6: [3, 2], 8: [4, 2], 9: [3, 3], 12: [4, 3], 16: [4, 4] };

  /**
   * The request to paste into ChatGPT / Gemini so it draws every pose of a motion on
   * one picture. The app then cuts the picture into frames. Any motion the image AI can
   * draw works this way (walking, winking, jumping…), without an AI inside the app.
   * @param {{character?: string, action: string, frames?: number, withImage?: boolean, text?: string}} o
   */
  function buildSpritePrompt(o) {
    const n = SHEET_LAYOUTS[o.frames] ? o.frames : 8;
    const [cols, rows] = SHEET_LAYOUTS[n];
    const who = o.withImage
      ? `添付した画像のキャラクター${o.character ? `（${o.character}）` : ''}`
      : o.character || 'かわいいキャラクター';
    const action = (o.action || '').trim() || '手を振る';
    const lines = [
      `${who}が「${action}」動きをする、LINEアニメーションスタンプ用のスプライトシートを1枚描いてください。`,
      '',
      '【条件】',
      `・${cols}列×${rows}行、全${n}コマを格子状に並べる。左上から右へ、上の段から下の段の順に動きが進む`,
      '・1コマ目から最後のコマまでで動きが1回分。最後のコマから1コマ目へ自然につながる（ループする）',
      '・どのコマも、キャラクターの大きさ・向き・画角・絵のタッチを完全に同じにする',
      '・キャラクターの体の中心と足元の位置を、すべてのコマでそろえる',
      `・動かすのは「${action}」に必要な部分だけ。それ以外の部分は、すべてのコマでまったく同じ絵にする`,
      '・各コマは正方形。コマとコマの間には、十分な白い余白をあける',
      '・背景は真っ白（#FFFFFF）の単色。影・グラデーション・枠線・コマ番号は入れない',
    ];
    if (o.text && o.text.trim()) lines.push(`・各コマに「${o.text.trim()}」という文字を、すべて同じ位置・同じ大きさで入れる`);
    else lines.push('・文字は入れない');
    lines.push(`・画像全体の縦横比は ${cols}:${rows}`);
    return lines.join('\n');
  }

  const EXAMPLES = ['大きく跳ねる', 'ゆっくり左右にゆれる', '速くぶるぶる震える', 'ドキドキ大きくなる', 'くるくる回る', 'ぺこりとおじぎ', 'ふわふわ浮かぶ', '手を振る'];

  const api = { parseMotionText, parseInstruction, parsePartRequest, parsePartRequests, parsePartMotion, buildSpritePrompt, SHEET_LAYOUTS, EXAMPLES, WISH_EXAMPLES };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.MotionWords = api;
})(typeof window !== 'undefined' ? window : globalThis);

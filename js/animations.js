// Sticker rendering: content (text + image), motion presets and overlay effects.
// Every function of t (0 <= t < 1) is periodic so the APNG loops seamlessly.
(function (root) {
  'use strict';

  const TAU = Math.PI * 2;
  const MARGIN = 10;

  const FONTS = [
    { id: 'Dela Gothic One', label: 'デラゴシック（極太）' },
    { id: 'M PLUS Rounded 1c', label: 'まるゴシック' },
    { id: 'Hachi Maru Pop', label: 'はちまるポップ' },
    { id: 'Yusei Magic', label: 'マジック手書き' },
    { id: 'RocknRoll One', label: 'ロックンロール' },
    { id: 'Kaisei Decol', label: '明朝デコ' },
  ];

  // Each motion returns a transform relative to the sticker center.
  const MOTIONS = {
    none: { label: 'なし', fn: () => ({}) },
    bounce: {
      label: 'ぴょんぴょん',
      fn: (t, W, H) => {
        const s = Math.abs(Math.sin(Math.PI * t * 2));
        const squash = Math.max(0, 1 - s * 4);
        return { y: -s * H * 0.12, sx: 1 + squash * 0.08, sy: 1 - squash * 0.1 };
      },
    },
    shake: {
      label: 'ぶるぶる',
      fn: (t) => ({ x: Math.sin(t * TAU * 4) * 7, rot: Math.sin(t * TAU * 4 + 1) * 0.04 }),
    },
    pulse: {
      label: 'ドキドキ',
      fn: (t) => {
        const beat = (p) => Math.exp(-Math.pow((t - p) * 14, 2));
        const s = 1 + 0.13 * beat(0.15) + 0.09 * beat(0.4) + 0.13 * beat(1.15);
        return { sx: s, sy: s };
      },
    },
    zoom: {
      label: 'ズーム',
      fn: (t) => {
        const s = 1 + 0.12 * Math.sin(t * TAU);
        return { sx: s, sy: s };
      },
    },
    spin: { label: 'くるくる', fn: (t) => ({ rot: t * TAU }) },
    swing: { label: 'ゆらゆら', fn: (t) => ({ rot: Math.sin(t * TAU) * 0.18, pivotY: -0.4 }) },
    float: { label: 'ふわふわ', fn: (t, W, H) => ({ y: Math.sin(t * TAU) * H * 0.05, rot: Math.sin(t * TAU + 1) * 0.03 }) },
    jelly: {
      label: 'ぷるぷる',
      fn: (t) => ({ sx: 1 + Math.sin(t * TAU * 2) * 0.08, sy: 1 - Math.sin(t * TAU * 2) * 0.08, pivotY: 0.45 }),
    },
    slide: {
      label: 'スライドイン',
      fn: (t, W) => {
        if (t < 0.3) {
          const p = t / 0.3;
          return { x: (1 - easeOutBack(p)) * -W, alpha: Math.min(1, p * 2) };
        }
        if (t > 0.85) return { x: ((t - 0.85) / 0.15) * W * 1.1, alpha: 1 - (t - 0.85) / 0.15 };
        return {};
      },
    },
    pop: {
      label: 'ポンッと登場',
      fn: (t) => {
        if (t < 0.35) {
          const s = easeOutBack(t / 0.35);
          return { sx: s, sy: s, alpha: Math.min(1, t / 0.12) };
        }
        if (t > 0.88) {
          const s = 1 - (t - 0.88) / 0.12;
          return { sx: s, sy: s, alpha: s };
        }
        return {};
      },
    },
    blink: { label: 'チカチカ', fn: (t) => ({ alpha: Math.floor(t * 4) % 2 === 0 ? 1 : 0.15 }) },
    typing: { label: '1文字ずつ', fn: (t) => ({ reveal: Math.min(1, t / 0.7) }) },
    rainbow: { label: 'レインボー', fn: (t) => ({ hue: t * 360 }) },
    custom: {
      label: 'カスタム（細かく指定）',
      // Reads sticker.custom instead of following a fixed formula, so every
      // slider the editor exposes maps straight to one term below.
      fn: (t, W, H, sticker) => {
        const cfg = (sticker && sticker.custom) || {};
        // "止まる時間": the motion plays in the first part of the loop, then rests.
        const active = 1 - (cfg.pause || 0) / 100;
        if (t >= active) return {};
        const tt = t / active;
        const phase = tt * TAU * (cfg.speed || 1);
        // Fade shake in/out so it starts and ends at rest when there is a pause.
        const env = cfg.pause && cfg.wave === 'shake' ? Math.sin(Math.PI * tt) : 1;
        const wave = waveShape(cfg.wave, phase) * env;
        // "円を描く": X runs a quarter turn ahead of Y, so the two together trace a circle.
        const waveX = cfg.path === 'circle' ? waveShape(cfg.wave, phase + Math.PI / 2) * env : wave;
        const rot = ((cfg.rotate || 0) * Math.PI) / 180;
        const s = 1 + wave * ((cfg.zoom || 0) / 100);
        const squash = wave * ((cfg.squash || 0) / 100);
        return {
          x: waveX * ((cfg.moveX || 0) / 100) * W * 0.18,
          y: wave * ((cfg.moveY || 0) / 100) * H * 0.18,
          rot: wave * rot,
          sx: s * (1 + squash),
          sy: s * (1 - squash),
        };
      },
    },
  };

  const CUSTOM_WAVES = {
    smooth: { label: 'なめらか' },
    bounce: { label: 'はねる' },
    shake: { label: 'ぶるぶる' },
  };

  const CUSTOM_PATHS = {
    line: { label: 'まっすぐ' },
    circle: { label: '円を描く' },
  };

  // Shared shape for the custom motion's four sliders, so they all move in sync.
  function waveShape(kind, phase) {
    if (kind === 'bounce') {
      const s = Math.sin(phase);
      return Math.sign(s) * (1 - Math.pow(1 - Math.abs(s), 3));
    }
    if (kind === 'shake') {
      return Math.sin(phase) * 0.6 + Math.sin(phase * 2.7 + 1) * 0.3 + Math.sin(phase * 5.3 + 2) * 0.1;
    }
    return Math.sin(phase);
  }

  const EFFECTS = {
    none: { label: 'なし', fn: () => {} },
    sparkle: { label: 'キラキラ', fn: drawSparkles },
    hearts: { label: 'ハート', fn: drawHearts },
    lines: { label: '集中線', fn: drawFocusLines },
    sweat: { label: '汗', fn: drawSweat },
    notes: { label: '音符', fn: drawNotes },
    anger: { label: 'プンプン', fn: drawAnger },
  };

  function easeOutBack(p) {
    const c1 = 1.70158;
    const c3 = c1 + 1;
    return 1 + c3 * Math.pow(p - 1, 3) + c1 * Math.pow(p - 1, 2);
  }

  function defaultSticker() {
    return {
      text: 'ありがとう！',
      font: 'Dela Gothic One',
      fontSize: 64,
      color: '#ff5a8a',
      strokeColor: '#ffffff',
      strokeWidth: 8,
      image: null, // data URL actually drawn (may be background-removed)
      originalImage: null, // data URL as uploaded, kept so bg removal can be redone/undone
      imageScale: 1,
      motion: 'bounce',
      effect: 'sparkle',
      effectColor: '#ffd23f',
      custom: { wave: 'smooth', path: 'line', speed: 1, moveX: 0, moveY: 22, rotate: 6, zoom: 6, pause: 0, squash: 0, text: '' },
      bg: { enabled: false, tolerance: 25, color: null }, // color: null = auto-detect from the corners
    };
  }

  // Fit the text into maxW x maxH: shrink the font first, and only wrap lines
  // once the text would otherwise get too small.
  function layoutText(ctx, sticker, maxW, maxH) {
    const rawLines = sticker.text.split('\n');
    const pad = sticker.strokeWidth * 2;
    const setFont = (size) => (ctx.font = `${size}px "${sticker.font}", sans-serif`);
    const fits = (lines, size) =>
      lines.length * size * 1.2 + pad <= maxH && Math.max(...lines.map((l) => ctx.measureText(l).width)) + pad <= maxW;
    const result = (lines, size) => ({ lines, size, lineHeight: size * 1.2, height: lines.length * size * 1.2 + sticker.strokeWidth });

    const minNoWrap = Math.max(20, sticker.fontSize * 0.6);
    for (let size = sticker.fontSize; size >= minNoWrap; size -= 2) {
      setFont(size);
      if (fits(rawLines, size)) return result(rawLines, size);
    }

    let size = sticker.fontSize;
    for (; size > 10; size -= 2) {
      setFont(size);
      const lines = [];
      for (const raw of rawLines) {
        let line = '';
        for (const ch of Array.from(raw)) {
          if (line && ctx.measureText(line + ch).width + pad > maxW) {
            lines.push(line);
            line = ch;
          } else {
            line += ch;
          }
        }
        lines.push(line);
      }
      if (fits(lines, size)) return result(lines, size);
    }
    setFont(size);
    return result(rawLines, size);
  }

  /**
   * Draw one frame of a sticker.
   * @param {CanvasRenderingContext2D} ctx  target in W x H units (caller may pre-scale); cleared first
   * @param {object} sticker
   * @param {number} t  0 <= t < 1
   * @param {HTMLImageElement|null} img  decoded sticker.image
   */
  function drawFrame(ctx, sticker, t, W, H, img) {
    ctx.clearRect(0, 0, W, H);
    ctx.save();

    const motion = (MOTIONS[sticker.motion] || MOTIONS.none).fn(t, W, H, sticker);
    const innerW = W - MARGIN * 2;
    const innerH = H - MARGIN * 2;
    const hasText = sticker.text.trim().length > 0;
    const hasImage = !!img;

    // Motion can grow the content (bounce, zoom...), so leave head-room.
    const room = sticker.motion === 'none' || sticker.motion === 'typing' || sticker.motion === 'rainbow' ? 1 : 0.86;
    const boxW = innerW * room;
    const boxH = innerH * room;

    let text = null;
    if (hasText) text = layoutText(ctx, sticker, boxW, hasImage ? boxH * 0.45 : boxH);

    const textH = text ? text.height : 0;
    const imgBoxH = hasImage ? boxH - textH : 0;

    const pivotY = (motion.pivotY || 0) * H;
    ctx.translate(W / 2 + (motion.x || 0), H / 2 + (motion.y || 0) + pivotY);
    ctx.rotate(motion.rot || 0);
    ctx.scale(motion.sx || 1, motion.sy || 1);
    ctx.translate(0, -pivotY);
    ctx.globalAlpha = motion.alpha === undefined ? 1 : Math.max(0, Math.min(1, motion.alpha));

    let y = -(imgBoxH + textH) / 2;
    if (hasImage) {
      const s = Math.min(boxW / img.width, imgBoxH / img.height) * sticker.imageScale;
      const iw = img.width * s;
      const ih = img.height * s;
      ctx.drawImage(img, -iw / 2, y + (imgBoxH - ih) / 2, iw, ih);
      y += imgBoxH;
    }

    if (text) {
      ctx.font = `${text.size}px "${sticker.font}", sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.lineJoin = 'round';
      ctx.miterLimit = 2;
      const fill = motion.hue !== undefined ? `hsl(${motion.hue}, 90%, 58%)` : sticker.color;
      const total = text.lines.reduce((n, l) => n + Array.from(l).length, 0);
      let budget = motion.reveal === undefined ? Infinity : Math.ceil(total * motion.reveal);

      text.lines.forEach((line, i) => {
        const chars = Array.from(line);
        const shown = chars.slice(0, Math.max(0, budget)).join('');
        budget -= chars.length;
        if (!shown) return;
        const ly = y + sticker.strokeWidth / 2 + text.lineHeight * (i + 0.5);
        // Keep partially typed lines anchored where the full line would sit.
        const fullW = ctx.measureText(line).width;
        const x = shown === line ? 0 : -fullW / 2 + ctx.measureText(shown).width / 2;
        if (sticker.strokeWidth > 0) {
          ctx.strokeStyle = sticker.strokeColor;
          ctx.lineWidth = sticker.strokeWidth * 2;
          ctx.strokeText(shown, x, ly);
        }
        ctx.fillStyle = fill;
        ctx.fillText(shown, x, ly);
      });
    }
    ctx.restore();

    ctx.save();
    (EFFECTS[sticker.effect] || EFFECTS.none).fn(ctx, t, W, H, sticker.effectColor);
    ctx.restore();
  }

  // ---- effects ----

  function star(ctx, x, y, r) {
    ctx.beginPath();
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * TAU - Math.PI / 2;
      const rr = i % 2 === 0 ? r : r * 0.28;
      ctx.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr);
    }
    ctx.closePath();
  }

  function outlinedFill(ctx, color, width = 3) {
    ctx.lineJoin = 'round';
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = width;
    ctx.stroke();
    ctx.fillStyle = color;
    ctx.fill();
  }

  function drawSparkles(ctx, t, W, H, color) {
    const spots = [
      [0.1, 0.18, 0], [0.9, 0.14, 0.3], [0.86, 0.82, 0.55], [0.13, 0.8, 0.8], [0.5, 0.08, 0.15],
    ];
    for (const [px, py, ph] of spots) {
      const k = Math.max(0, Math.sin((t + ph) * TAU));
      if (k < 0.05) continue;
      star(ctx, px * W, py * H, 6 + k * 12);
      outlinedFill(ctx, color);
    }
  }

  function heart(ctx, x, y, s) {
    ctx.beginPath();
    ctx.moveTo(x, y + s * 0.35);
    ctx.bezierCurveTo(x - s * 1.1, y - s * 0.35, x - s * 0.45, y - s * 1.05, x, y - s * 0.45);
    ctx.bezierCurveTo(x + s * 0.45, y - s * 1.05, x + s * 1.1, y - s * 0.35, x, y + s * 0.35);
    ctx.closePath();
  }

  function drawHearts(ctx, t, W, H, color) {
    const items = [[0.12, 0, 13], [0.88, 0.33, 11], [0.25, 0.66, 9], [0.78, 0.5, 15], [0.9, 0.85, 9]];
    for (const [px, ph, s] of items) {
      const p = (t + ph) % 1;
      const x = px * W + Math.sin(p * TAU * 1.5) * 8;
      const y = H * 0.95 - p * H * 0.9;
      ctx.globalAlpha = Math.min(1, Math.sin(p * Math.PI) * 2);
      heart(ctx, x, y, s);
      outlinedFill(ctx, color);
    }
  }

  function drawFocusLines(ctx, t, W, H, color) {
    const cx = W / 2;
    const cy = H / 2;
    const R = Math.hypot(W, H) / 2;
    const n = 40;
    const frame = Math.floor(t * 8);
    ctx.fillStyle = color;
    for (let i = 0; i < n; i++) {
      const jitter = pseudo(i * 13 + frame * 7);
      const a = (i / n) * TAU + jitter * 0.08;
      const inner = R * (0.72 + pseudo(i * 5 + frame) * 0.15);
      const w = 0.018 + jitter * 0.02;
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(a) * R, cy + Math.sin(a) * R);
      ctx.lineTo(cx + Math.cos(a - w) * R, cy + Math.sin(a - w) * R);
      ctx.lineTo(cx + Math.cos(a) * inner, cy + Math.sin(a) * inner);
      ctx.closePath();
      ctx.fill();
    }
  }

  function drop(ctx, x, y, s) {
    ctx.beginPath();
    ctx.moveTo(x, y - s * 1.4);
    ctx.bezierCurveTo(x + s * 0.2, y - s * 0.8, x + s, y - s * 0.2, x + s, y + s * 0.3);
    ctx.arc(x, y + s * 0.3, s, 0, Math.PI);
    ctx.bezierCurveTo(x - s, y - s * 0.2, x - s * 0.2, y - s * 0.8, x, y - s * 1.4);
    ctx.closePath();
  }

  function drawSweat(ctx, t, W, H, color) {
    const drops = [[0.84, 0.12, 0, 11], [0.93, 0.28, 0.5, 8]];
    for (const [px, py, ph, s] of drops) {
      const p = (t + ph) % 1;
      ctx.globalAlpha = p < 0.8 ? 1 : 1 - (p - 0.8) / 0.2;
      drop(ctx, px * W, py * H + p * H * 0.18, s);
      outlinedFill(ctx, color);
    }
  }

  function drawNotes(ctx, t, W, H, color) {
    const notes = [[0.1, 0.25, 0, '♪'], [0.88, 0.2, 0.5, '♫'], [0.9, 0.7, 0.25, '♪']];
    ctx.font = 'bold 34px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    for (const [px, py, ph, ch] of notes) {
      const p = (t + ph) % 1;
      const x = px * W + Math.sin(p * TAU) * 6;
      const y = py * H - Math.sin(p * Math.PI) * 14;
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(Math.sin(p * TAU) * 0.3);
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 5;
      ctx.strokeText(ch, 0, 0);
      ctx.fillStyle = color;
      ctx.fillText(ch, 0, 0);
      ctx.restore();
    }
  }

  function drawAnger(ctx, t, W, H, color) {
    const s = 16 * (1 + 0.25 * Math.abs(Math.sin(t * TAU * 2)));
    const x = W * 0.86;
    const y = H * 0.16;
    ctx.lineCap = 'round';
    for (let q = 0; q < 4; q++) {
      const a = q * (Math.PI / 2) + Math.PI / 4;
      const dx = Math.cos(a);
      const dy = Math.sin(a);
      // Each quadrant: a bent line like the manga "anger vein" mark.
      const path = () => {
        ctx.beginPath();
        ctx.moveTo(x + dx * s * 0.35 - dy * s * 0.55, y + dy * s * 0.35 + dx * s * 0.55);
        ctx.quadraticCurveTo(x + dx * s * 0.35, y + dy * s * 0.35, x + dx * s * 0.35 + dy * s * 0.55, y + dy * s * 0.35 - dx * s * 0.55);
      };
      path();
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 9;
      ctx.stroke();
      path();
      ctx.strokeStyle = color;
      ctx.lineWidth = 4.5;
      ctx.stroke();
    }
  }

  function pseudo(n) {
    const x = Math.sin(n * 12.9898) * 43758.5453;
    return x - Math.floor(x);
  }

  root.Stickers = { FONTS, MOTIONS, EFFECTS, CUSTOM_WAVES, CUSTOM_PATHS, defaultSticker, drawFrame };
})(window);

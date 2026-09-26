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

  // Draw each bent grid cell as two textured triangles. Grid points are moved by
  // Parts.deformVertex; `k` scales picture pixels to the current drawing size.
  function drawBentCells(ctx, layers, t, x0, y0, k) {
    const { mesh, parts, img } = layers;
    const moved = new Map();
    const at = (idx) => {
      let v = moved.get(idx);
      if (!v) {
        const [x, y] = root.Parts.deformVertex(mesh, idx, parts, t);
        v = [x0 + x * k, y0 + y * k];
        moved.set(idx, v);
      }
      return v;
    };
    const src = (idx) => [mesh.xs[idx], mesh.ys[idx]];
    const row = mesh.cols + 1;
    for (let c = 0; c < mesh.cells.length; c += 2) {
      const i = mesh.cells[c];
      const j = mesh.cells[c + 1];
      const a = j * row + i;
      const b = a + 1;
      const d = a + row;
      const e = d + 1;
      texturedTriangle(ctx, img, [src(a), src(b), src(e)], [at(a), at(b), at(e)]);
      texturedTriangle(ctx, img, [src(a), src(e), src(d)], [at(a), at(e), at(d)]);
    }
  }

  // Draw each winking eye: open, squashed on the way, then a closed-eye arc "︵"
  // in the eye's own color (the eye itself was painted over in the base).
  function drawWinks(ctx, layers, t, x0, y0, k) {
    for (const e of layers.winks) {
      const close = root.Parts.winkClose(e.cfg, t);
      const [bx0, by0, bx1, by1] = e.box;
      const cx = x0 + ((bx0 + bx1) / 2) * k;
      const cy = y0 + ((by0 + by1) / 2) * k;
      const ew = (bx1 - bx0) * k;
      const eh = (by1 - by0) * k;
      if (close < 0.7) {
        const sy = 1 - close;
        ctx.drawImage(e.canvas, x0 + e.x * k, cy + (y0 + e.y * k - cy) * sy, e.canvas.width * k, e.canvas.height * k * sy);
        continue;
      }
      ctx.save();
      ctx.strokeStyle = `rgb(${e.color.join(',')})`;
      ctx.lineWidth = Math.max(1.5, eh * 0.28);
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(cx - ew / 2, cy + eh * 0.12);
      ctx.quadraticCurveTo(cx, cy - eh * 0.38, cx + ew / 2, cy + eh * 0.12);
      ctx.stroke();
      ctx.restore();
    }
  }

  // Map the picture's triangle s onto the screen triangle d (an affine transform),
  // clipped to d grown by most of a pixel so neighbouring triangles leave no hairline gaps.
  function texturedTriangle(ctx, img, s, d) {
    const [[s0x, s0y], [s1x, s1y], [s2x, s2y]] = s;
    const [[d0x, d0y], [d1x, d1y], [d2x, d2y]] = d;
    const den = s0x * (s1y - s2y) + s1x * (s2y - s0y) + s2x * (s0y - s1y);
    if (!den) return;
    const a = (d0x * (s1y - s2y) + d1x * (s2y - s0y) + d2x * (s0y - s1y)) / den;
    const b = (d0y * (s1y - s2y) + d1y * (s2y - s0y) + d2y * (s0y - s1y)) / den;
    const c = (d0x * (s2x - s1x) + d1x * (s0x - s2x) + d2x * (s1x - s0x)) / den;
    const dd = (d0y * (s2x - s1x) + d1y * (s0x - s2x) + d2y * (s1x - s0x)) / den;
    const e = (d0x * (s1x * s2y - s2x * s1y) + d1x * (s2x * s0y - s0x * s2y) + d2x * (s0x * s1y - s1x * s0y)) / den;
    const f = (d0y * (s1x * s2y - s2x * s1y) + d1y * (s2x * s0y - s0x * s2y) + d2y * (s0x * s1y - s1x * s0y)) / den;
    const cx = (d0x + d1x + d2x) / 3;
    const cy = (d0y + d1y + d2y) / 3;
    const grow = (x, y) => {
      const l = Math.hypot(x - cx, y - cy) || 1;
      return [x + ((x - cx) / l) * 0.8, y + ((y - cy) / l) * 0.8];
    };
    ctx.save();
    ctx.beginPath();
    for (const [x, y] of [d[0], d[1], d[2]].map(([x, y]) => grow(x, y))) ctx.lineTo(x, y);
    ctx.closePath();
    ctx.clip();
    ctx.transform(a, b, c, dd, e, f);
    const minX = Math.max(0, Math.floor(Math.min(s0x, s1x, s2x)) - 1);
    const minY = Math.max(0, Math.floor(Math.min(s0y, s1y, s2y)) - 1);
    const maxX = Math.min(img.width, Math.ceil(Math.max(s0x, s1x, s2x)) + 1);
    const maxY = Math.min(img.height, Math.ceil(Math.max(s0y, s1y, s2y)) + 1);
    if (maxX > minX && maxY > minY) ctx.drawImage(img, minX, minY, maxX - minX, maxY - minY, minX, minY, maxX - minX, maxY - minY);
    ctx.restore();
  }

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

  // `color` is the effect's natural color, used until the user picks their own.
  const EFFECTS = {
    none: { label: 'なし', fn: () => {} },
    sparkle: { label: 'キラキラ', fn: drawSparkles, color: '#ffd23f' },
    hearts: { label: 'ハート', fn: drawHearts, color: '#ff5a8a' },
    lines: { label: '集中線', fn: drawFocusLines, color: '#333333' },
    sweat: { label: '汗', fn: drawSweat, color: '#5ab4f0' },
    notes: { label: '音符', fn: drawNotes, color: '#ff8a3d' },
    anger: { label: 'プンプン', fn: drawAnger, color: '#e5484d' },
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
      textCurve: 0, // −100 (smile) … 100 (rainbow arch)
      textRotate: 0, // degrees
      textPos: [0, 0], // drag offsets as fractions of the sticker size
      imagePos: [0, 0],
      custom: { wave: 'smooth', path: 'line', speed: 1, moveX: 0, moveY: 22, rotate: 6, zoom: 6, pause: 0, squash: 0, text: '' },
      bg: { enabled: false, tolerance: 25, color: null }, // color: null = auto-detect from the corners
      mode: 'single', // 'single': one picture moved by the app; 'frames': frame art (sheet, images, video)
      frameImages: [], // data URLs, all the same size
      frameAdj: [], // per frame { x, y, s }: nudge as fractions of the frame, and scale
      parts: [], // traced parts that move on their own: { poly: [[x,y]...], pivot: [x,y], cfg: {type, amount, speed} } in 0–1 image coords
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
   * Where the picture and the text sit before any motion, relative to the sticker's
   * center, including the user's drag offsets. Shared by drawing and by the editor's
   * drag hit-test so both agree.
   */
  function layoutSticker(ctx, sticker, W, H, img) {
    const innerW = W - MARGIN * 2;
    const innerH = H - MARGIN * 2;
    const hasText = sticker.text.trim().length > 0;
    const hasImage = !!img;

    // Motion can grow the content (bounce, zoom...), so leave head-room.
    const room = sticker.motion === 'none' || sticker.motion === 'typing' || sticker.motion === 'rainbow' ? 1 : 0.86;
    const boxW = innerW * room;
    const boxH = innerH * room;

    // Curved text needs more height than straight text, so start it a little smaller.
    const curve = Math.abs(sticker.textCurve || 0) / 100;
    const sized = curve ? { ...sticker, fontSize: Math.round(sticker.fontSize * (1 - 0.3 * curve)) } : sticker;
    const text = hasText ? layoutText(ctx, sized, boxW, hasImage ? boxH * 0.45 : boxH) : null;
    const textH = text ? text.height : 0;
    const imgBoxH = hasImage ? boxH - textH : 0;
    const top = -(imgBoxH + textH) / 2;
    const out = { text, image: null, textBox: null };

    if (hasImage) {
      const s = Math.min(boxW / img.width, imgBoxH / img.height) * sticker.imageScale;
      const iw = img.width * s;
      const ih = img.height * s;
      const [ox, oy] = sticker.imagePos || [0, 0];
      out.image = { x: -iw / 2 + ox * W, y: top + (imgBoxH - ih) / 2 + oy * H, w: iw, h: ih };
    }
    if (text) {
      ctx.font = `${text.size}px "${sticker.font}", sans-serif`;
      const width = Math.max(...text.lines.map((l) => ctx.measureText(l).width)) + sticker.strokeWidth * 2;
      const [ox, oy] = sticker.textPos || [0, 0];
      out.textBox = { cx: ox * W, cy: top + imgBoxH + textH / 2 + oy * H, w: width, h: textH };
    }
    return out;
  }

  /**
   * Draw one frame of a sticker.
   * @param {CanvasRenderingContext2D} ctx  target in W x H units (caller may pre-scale); cleared first
   * @param {object} sticker
   * @param {number} t  0 <= t < 1
   * @param {HTMLImageElement|null} img  decoded sticker.image
   * @param {{img, base, mesh, parts}|{adjust}|null} [layers]  when some parts of the picture
   *   move on their own (`base` is the picture without the bent cells, see js/parts.js),
   *   or, for frame art, the current frame's position fix
   */
  function drawFrame(ctx, sticker, t, W, H, img, layers) {
    ctx.clearRect(0, 0, W, H);
    ctx.save();

    const motion = (MOTIONS[sticker.motion] || MOTIONS.none).fn(t, W, H, sticker);
    const lay = layoutSticker(ctx, sticker, W, H, img);

    const pivotY = (motion.pivotY || 0) * H;
    ctx.translate(W / 2 + (motion.x || 0), H / 2 + (motion.y || 0) + pivotY);
    ctx.rotate(motion.rot || 0);
    ctx.scale(motion.sx || 1, motion.sy || 1);
    ctx.translate(0, -pivotY);
    ctx.globalAlpha = motion.alpha === undefined ? 1 : Math.max(0, Math.min(1, motion.alpha));

    if (lay.image) {
      const { x: x0, y: y0, w: iw, h: ih } = lay.image;
      if (layers && layers.adjust) {
        // A frame of frame art, with its per-frame nudge (fractions of the frame) and scale.
        const a = layers.adjust;
        const s = a.s || 1;
        ctx.drawImage(img, x0 + (a.x || 0) * iw - ((s - 1) * iw) / 2, y0 + (a.y || 0) * ih - ((s - 1) * ih) / 2, iw * s, ih * s);
      } else if (layers) {
        // Everything the parts don't touch, then the touched cells bent like rubber.
        ctx.drawImage(layers.base, x0, y0, iw, ih);
        drawBentCells(ctx, layers, t, x0, y0, iw / layers.mesh.w);
        drawWinks(ctx, layers, t, x0, y0, iw / layers.mesh.w);
      } else {
        ctx.drawImage(img, x0, y0, iw, ih);
      }
    }

    if (lay.text) drawText(ctx, sticker, lay.text, lay.textBox, motion);
    ctx.restore();

    ctx.save();
    (EFFECTS[sticker.effect] || EFFECTS.none).fn(ctx, t, W, H, sticker.effectColor);
    ctx.restore();
  }

  function drawText(ctx, sticker, text, box, motion) {
    ctx.save();
    ctx.translate(box.cx, box.cy);
    ctx.rotate(((sticker.textRotate || 0) * Math.PI) / 180);
    ctx.font = `${text.size}px "${sticker.font}", sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    ctx.miterLimit = 2;
    const fill = motion.hue !== undefined ? `hsl(${motion.hue}, 90%, 58%)` : sticker.color;
    const total = text.lines.reduce((n, l) => n + Array.from(l).length, 0);
    let budget = motion.reveal === undefined ? Infinity : Math.ceil(total * motion.reveal);
    const curve = (sticker.textCurve || 0) / 100;

    // Glyphs to draw, each with a position and an angle; outlines go first for all
    // of them so one letter's outline never covers its neighbour's fill.
    const glyphs = [];
    text.lines.forEach((line, i) => {
      const chars = Array.from(line);
      const count = Math.max(0, Math.min(chars.length, budget));
      budget -= chars.length;
      if (!count) return;
      const ly = -box.h / 2 + sticker.strokeWidth / 2 + text.lineHeight * (i + 0.5);
      const fullW = ctx.measureText(line).width;
      if (!curve) {
        const shown = chars.slice(0, count).join('');
        // Keep partially typed lines anchored where the full line would sit.
        const x = count === chars.length ? 0 : -fullW / 2 + ctx.measureText(shown).width / 2;
        glyphs.push({ ch: shown, x, y: ly, a: 0 });
        return;
      }
      // Bend the line along a circle: + arches up like a rainbow, − sags like a smile.
      const span = Math.abs(curve) * Math.PI; // angle the whole line covers
      const r = fullW / span;
      const dir = curve > 0 ? 1 : -1;
      const sag = r * (1 - Math.cos(span / 2)); // keep the arc centered on the line
      let s = -fullW / 2;
      chars.forEach((ch, n) => {
        const cw = ctx.measureText(ch).width;
        const theta = (s + cw / 2) / r;
        s += cw;
        if (n >= count) return;
        glyphs.push({
          ch,
          x: r * Math.sin(theta),
          y: ly + dir * (r - r * Math.cos(theta) - sag / 2),
          a: dir * theta,
        });
      });
    });
    const each = (fn) => glyphs.forEach((g) => {
      ctx.save();
      ctx.translate(g.x, g.y);
      ctx.rotate(g.a);
      fn(g.ch);
      ctx.restore();
    });
    if (sticker.strokeWidth > 0) {
      ctx.strokeStyle = sticker.strokeColor;
      ctx.lineWidth = sticker.strokeWidth * 2;
      each((ch) => ctx.strokeText(ch, 0, 0));
    }
    ctx.fillStyle = fill;
    each((ch) => ctx.fillText(ch, 0, 0));
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

  root.Stickers = { FONTS, MOTIONS, EFFECTS, CUSTOM_WAVES, CUSTOM_PATHS, defaultSticker, drawFrame, layoutSticker };
})(window);

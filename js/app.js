(function () {
  'use strict';

  const { FONTS, MOTIONS, EFFECTS, CUSTOM_WAVES, CUSTOM_PATHS, defaultSticker, drawFrame } = window.Stickers;
  const { assembleAPNG, quantize, encodeIndexedPNG, createZip } = window.Encoder;
  const { parseMotionText, parseInstruction, parsePartRequests, parsePartMotion, EXAMPLES: MOTION_EXAMPLES, WISH_EXAMPLES } = window.MotionWords;
  const { removeBackgroundPixels } = window.BgRemove;
  const { guessPivot, buildMesh, PART_MOTIONS } = window.Parts;

  const W = 320;
  const H = 270;
  const MAX_BYTES = 300 * 1024;
  const STORAGE_KEY = 'ugoku-stamp-maker:v1';
  const VALID_COUNTS = [8, 16, 24];

  const $ = (id) => document.getElementById(id);
  const imageCache = new Map();

  let state = load() || { stickers: [newSticker()], selected: 0 };
  const current = () => state.stickers[state.selected];

  function newSticker(base) {
    const st = { ...defaultSticker(), frames: 12, duration: 1, loops: 4, ...(base || {}) };
    st.custom = { ...defaultSticker().custom, ...st.custom };
    st.bg = { ...defaultSticker().bg, ...st.bg };
    st.parts = Array.isArray(st.parts) ? st.parts : [];
    // Stickers saved before background removal existed only have `image`.
    if (st.image && !st.originalImage) st.originalImage = st.image;
    st.bg.tolerance = Math.min(st.bg.tolerance, 45);
    return st;
  }

  // ---------- persistence ----------
  function load() {
    try {
      const s = JSON.parse(localStorage.getItem(STORAGE_KEY));
      if (!s || !Array.isArray(s.stickers) || !s.stickers.length) return null;
      s.stickers = s.stickers.map((x) => newSticker(x));
      s.selected = Math.min(s.selected || 0, s.stickers.length - 1);
      return s;
    } catch (e) {
      return null;
    }
  }
  let saveTimer = 0;
  function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      } catch (e) {
        setStatus('ブラウザの保存容量がいっぱいです（画像が大きすぎる可能性があります）', true);
      }
    }, 300);
  }

  // ---------- images ----------
  function getImage(src) {
    if (!src) return null;
    let entry = imageCache.get(src);
    if (!entry) {
      const img = new Image();
      entry = { img, ready: false };
      img.onload = () => {
        entry.ready = true;
        renderList();
        if (src === current().originalImage) drawBgPickCanvas(src);
        if (src === current().image) drawPartsCanvas();
      };
      img.src = src;
      imageCache.set(src, entry);
    }
    return entry.ready ? entry.img : null;
  }

  function readImageFile(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        // Downscale so the project fits in localStorage; stickers are only 320px wide anyway.
        const s = Math.min(1, 640 / Math.max(img.width, img.height));
        const c = document.createElement('canvas');
        c.width = Math.round(img.width * s);
        c.height = Math.round(img.height * s);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        URL.revokeObjectURL(url);
        resolve(c.toDataURL('image/png'));
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error('画像を読み込めませんでした'));
      };
      img.src = url;
    });
  }

  // ---------- background removal ----------
  function loadImageEl(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('画像を読み込めませんでした'));
      img.src = src;
    });
  }

  // An already-transparent PNG has see-through corners; a photo or drawing on paper doesn't.
  async function hasOpaqueCorners(dataUrl) {
    const img = await loadImageEl(dataUrl);
    const c = document.createElement('canvas');
    c.width = img.width;
    c.height = img.height;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0);
    const corners = [[0, 0], [img.width - 1, 0], [0, img.height - 1], [img.width - 1, img.height - 1]];
    return corners.some(([x, y]) => ctx.getImageData(x, y, 1, 1).data[3] > 200);
  }

  // Cut a flat background out of an uploaded image; see js/bg-remove.js for how.
  async function removeBackground(dataUrl, { tolerance, color }) {
    const img = await loadImageEl(dataUrl);
    const scale = Math.min(1, 900 / Math.max(img.width, img.height));
    const w = Math.max(1, Math.round(img.width * scale));
    const h = Math.max(1, Math.round(img.height * scale));
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, w, h);
    const id = ctx.getImageData(0, 0, w, h);
    const res = removeBackgroundPixels(id.data, w, h, { tolerance, color });
    if (res.alreadyTransparent) return { alreadyTransparent: true, dataUrl };
    ctx.putImageData(id, 0, 0);
    return { alreadyTransparent: false, dataUrl: c.toDataURL('image/png') };
  }

  // ---------- moving parts ----------
  // The bend grid depends on the picture, the traced outlines and the joints, so it
  // is cached on those; the motion settings are read live every frame.
  const layerCache = new Map();
  function getLayers(st) {
    if (!st.parts || !st.parts.length) return null;
    const img = getImage(st.image);
    if (!img) return null;
    const key = st.image.length + ':' + st.image.slice(-64) + ':' + JSON.stringify(st.parts.map((p) => [p.poly, p.pivot]));
    let built = layerCache.get(key);
    if (!built) {
      built = buildLayers(img, st.parts);
      if (layerCache.size > 30) layerCache.clear();
      layerCache.set(key, built);
    }
    return { img, base: built.base, mesh: built.mesh, parts: st.parts };
  }

  // The base is the picture with the cells that will be bent cleared out,
  // so the unbent copy of the hand never shows behind the moving one.
  function buildLayers(img, parts) {
    const w = img.naturalWidth || img.width;
    const h = img.naturalHeight || img.height;
    const mesh = buildMesh(w, h, parts);
    const base = document.createElement('canvas');
    base.width = w;
    base.height = h;
    const ctx = base.getContext('2d');
    ctx.drawImage(img, 0, 0);
    for (let c = 0; c < mesh.cells.length; c += 2) {
      ctx.clearRect(mesh.cells[c] * mesh.cell, mesh.cells[c + 1] * mesh.cell, mesh.cell, mesh.cell);
    }
    return { base, mesh };
  }

  function partMask(poly, w, h) {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.beginPath();
    poly.forEach(([x, y], i) => (i ? ctx.lineTo(x * w, y * h) : ctx.moveTo(x * w, y * h)));
    ctx.closePath();
    ctx.fill();
    const a = ctx.getImageData(0, 0, w, h).data;
    const mask = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) mask[i] = a[i * 4 + 3] > 127 ? 1 : 0;
    return mask;
  }

  let partSel = 0;
  let partMode = 'idle'; // 'idle' | 'draw'
  let pendingParts = []; // worded requests ("左手を振って、右耳を上下に") waiting for the user to trace each part
  let stroke = null;

  function partsCanvasRect() {
    const img = getImage(current().image);
    const canvas = $('partsCanvas');
    if (!img) return null;
    const w = 280;
    const h = Math.max(1, Math.round((img.height / img.width) * w));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    return { img, canvas, w, h };
  }

  function drawPartsCanvas() {
    const r = partsCanvasRect();
    if (!r) return;
    const { img, canvas, w, h } = r;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(img, 0, 0, w, h);
    const outline = (poly, color, dashed) => {
      ctx.save();
      ctx.beginPath();
      poly.forEach(([x, y], i) => (i ? ctx.lineTo(x * w, y * h) : ctx.moveTo(x * w, y * h)));
      ctx.closePath();
      ctx.setLineDash(dashed ? [5, 4] : []);
      ctx.lineWidth = 3;
      ctx.strokeStyle = '#ffffff';
      ctx.stroke();
      ctx.lineWidth = 2;
      ctx.strokeStyle = color;
      ctx.stroke();
      ctx.restore();
    };
    current().parts.forEach((p, i) => {
      outline(p.poly, i === partSel ? '#06c755' : '#888888', i !== partSel);
      if (i === partSel) {
        ctx.beginPath();
        ctx.arc(p.pivot[0] * w, p.pivot[1] * h, 7, 0, Math.PI * 2);
        ctx.fillStyle = '#e5484d';
        ctx.fill();
        ctx.lineWidth = 2;
        ctx.strokeStyle = '#ffffff';
        ctx.stroke();
      }
    });
    if (stroke && stroke.length > 1) outline(stroke, '#e5484d', false);
  }

  function syncParts() {
    const st = current();
    const hasImg = !!st.image;
    const parts = st.parts;
    partSel = Math.min(partSel, Math.max(0, parts.length - 1));
    $('partsCanvas').hidden = !hasImg;
    $('partWords').hidden = !hasImg;
    $('partAdd').disabled = !hasImg || parts.length >= 3;
    $('partAdd').textContent = partMode === 'draw' ? 'なぞるのをやめる' : parts.length ? 'もう1つ部分を追加' : '動かす部分をなぞる';
    if (partMode === 'draw') $('partAdd').disabled = false;
    $('partRemove').hidden = !parts.length;
    let hint;
    if (!hasImg) hint = '先に「画像を選ぶ」で画像を入れてね';
    else if (partMode === 'draw' && pendingParts.length) hint = `「${pendingParts[0].name}」を、指やマウスでぐるっと囲んでね`;
    else if (partMode === 'draw') hint = '動かしたい部分（左手など）を、指やマウスでぐるっと囲んでね';
    else if (!parts.length) hint = '「動かす部分をなぞる」を押して、動かしたい部分を囲むと、そこだけ動かせます';
    else hint = '赤い点が動きの中心（つけ根）です。ちがう場所をタップすると移せます';
    $('partsHint').textContent = hint;

    const tabs = $('partTabs');
    tabs.innerHTML = '';
    if (parts.length) {
      parts.forEach((p, i) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'chip';
        b.textContent = p.name || `部分${i + 1}`;
        b.setAttribute('role', 'radio');
        b.setAttribute('aria-checked', String(i === partSel));
        b.addEventListener('click', () => {
          partSel = i;
          syncParts();
        });
        tabs.append(b);
      });
    }
    $('partControls').hidden = !parts.length;
    if (parts.length) {
      const cfg = parts[partSel].cfg;
      $('partType').querySelectorAll('.chip').forEach((c) => c.setAttribute('aria-checked', String(c.dataset.value === cfg.type)));
      $('partAmount').value = cfg.amount;
      $('partSpeed').value = cfg.speed;
    }
    drawPartsCanvas();
  }

  function addPartFromStroke(poly) {
    const st = current();
    const img = getImage(st.image);
    if (!img || poly.length < 8) return false;
    const xs = poly.map((p) => p[0]);
    const ys = poly.map((p) => p[1]);
    if (Math.max(...xs) - Math.min(...xs) < 0.03 || Math.max(...ys) - Math.min(...ys) < 0.03) return false;
    // Keep at most ~120 points so saved projects stay small.
    const step = Math.max(1, Math.ceil(poly.length / 120));
    const simple = poly.filter((_, i) => i % step === 0).map(([x, y]) => [Math.round(x * 1000) / 1000, Math.round(y * 1000) / 1000]);
    const w = img.naturalWidth || img.width;
    const h = img.naturalHeight || img.height;
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0);
    const pivot = guessPivot(simple, ctx.getImageData(0, 0, w, h).data, w, h, partMask(simple, w, h));
    const req = pendingParts.shift();
    const cfg = req ? { ...req.cfg } : { type: 'wave', amount: 50, speed: 2 };
    st.parts.push({ name: req ? req.name : `部分${st.parts.length + 1}`, poly: simple, pivot, cfg });
    partSel = st.parts.length - 1;
    if (req) {
      if (req.only) st.motion = 'none';
      setStatus(`「${req.name}」を設定しました：${req.understood.slice(1).join('・')}`);
    }
    return true;
  }

  // Apply "左手だけ左右に振る" / "左手を振って、右耳を上下に" style words. Parts that are
  // already traced (matched by name) are updated; new ones are queued for tracing.
  // Returns a message, or null if the text names no body part.
  function applyPartWords(text) {
    const reqs = parsePartRequests(text);
    if (!reqs.length) return null;
    const st = current();
    const names = reqs.map((r) => r.name).join('・');
    if (!st.image) return `先に「画像を選ぶ」で画像を入れてね。そのあと${names}を囲むと、そこだけ動かせます`;
    const done = [];
    const queue = [];
    for (const req of reqs) {
      const i = st.parts.findIndex((p) => p.name === req.name);
      // With a single untitled part, "左手を…" most likely means that part.
      const j = i >= 0 ? i : st.parts.length === 1 && /^部分\d$/.test(st.parts[0].name || '部分1') && !queue.length && !done.length ? 0 : -1;
      if (j >= 0) {
        Object.assign(st.parts[j].cfg, req.cfg);
        st.parts[j].name = req.name;
        if (req.only) st.motion = 'none';
        partSel = j;
        done.push(req.understood.join('・'));
      } else if (st.parts.length + queue.length < 3) {
        queue.push(req);
      }
    }
    changed();
    let msg = done.length ? '読みとった内容：' + done.join(' / ') : '';
    if (queue.length) {
      pendingParts = queue;
      showTab('image');
      partMode = 'draw';
      stroke = null;
      syncParts();
      $('partsPanel').scrollIntoView({ behavior: 'smooth', block: 'center' });
      const qn = queue.map((r) => r.name).join('、');
      msg += (msg ? '。' : '') + `${qn}がどこにあるか、まだわからないよ。「画像」タブの絵で、${queue[0].name}を指でぐるっと囲んでね` + (queue.length > 1 ? '（囲むと次の部分の案内が出ます）' : '。囲むとすぐ動きます');
    }
    return msg;
  }

  // The parts panel's own word box: a body part name works like above; otherwise the
  // words set the selected part's motion, or start tracing a new part when none exists.
  function applyPartBox() {
    const text = $('partText').value;
    const msg = applyPartWords(text);
    if (msg !== null) {
      $('partResult').textContent = msg;
      return;
    }
    const m = parsePartMotion(text);
    if (!m) {
      $('partResult').textContent = text.trim()
        ? 'ごめんね、動きの言葉が見つからなかったよ。例：「左手を大きく振る」「ゆっくり上下に」'
        : '動かしたい部分と動きを書いてね';
      return;
    }
    const st = current();
    if (!st.parts.length) {
      pendingParts = [{ name: '部分1', only: false, cfg: m.cfg, understood: ['部分1', ...m.understood] }];
      partMode = 'draw';
      syncParts();
      $('partResult').textContent = '動かしたい部分を、絵の上で指でぐるっと囲んでね';
      return;
    }
    Object.assign(st.parts[partSel].cfg, m.cfg);
    changed();
    $('partResult').textContent = `「${st.parts[partSel].name || '部分' + (partSel + 1)}」を設定しました：` + m.understood.join('・');
  }


  // ---------- rendering ----------
  function stillT(st) {
    if (st.motion === 'typing') return 0.85;
    if (st.motion === 'spin') return 0;
    return 0.5;
  }

  function renderSticker(canvas, st, t, w = W, h = H) {
    const ctx = canvas.getContext('2d');
    ctx.setTransform(canvas.width / w, 0, 0, canvas.height / h, 0, 0);
    drawFrame(ctx, st, t, w, h, getImage(st.image), getLayers(st));
  }

  const preview = $('preview');
  let startTime = performance.now();
  function tick(now) {
    const st = current();
    const cycle = st.duration * 1000;
    const frame = Math.floor((((now - startTime) % cycle) / cycle) * st.frames);
    renderSticker(preview, st, frame / st.frames);
    if (!$('miniPreview').hidden) renderSticker($('miniCanvas'), st, frame / st.frames);
    requestAnimationFrame(tick);
  }

  function renderList() {
    const list = $('list');
    list.innerHTML = '';
    state.stickers.forEach((st, i) => {
      const li = document.createElement('li');
      const b = document.createElement('button');
      b.type = 'button';
      b.setAttribute('aria-label', `スタンプ ${i + 1}`);
      b.setAttribute('aria-current', i === state.selected ? 'true' : 'false');
      const c = document.createElement('canvas');
      c.width = 160;
      c.height = 135;
      renderSticker(c, st, stillT(st));
      const n = document.createElement('span');
      n.className = 'num';
      n.textContent = String(i + 1).padStart(2, '0');
      b.append(c, n);
      b.addEventListener('click', () => select(i));
      li.append(b);
      list.append(li);
    });

    const count = state.stickers.length;
    $('count').textContent = count;
    const hint = $('countHint');
    if (VALID_COUNTS.includes(count)) {
      hint.textContent = `${count}個セット：LINEに申請できる個数です`;
      hint.className = 'hint';
    } else {
      const next = VALID_COUNTS.find((c) => c > count) || 24;
      hint.textContent = `LINEのアニメーションスタンプは 8 / 16 / 24 個セットで申請します（あと${Math.max(0, next - count)}個で${next}個）`;
      hint.className = 'hint warn';
    }
    $('remove').disabled = count <= 1;
    $('add').disabled = count >= 24;
    $('duplicate').disabled = count >= 24;
  }

  // ---------- editor ----------
  const fields = ['text', 'font', 'fontSize', 'color', 'strokeColor', 'strokeWidth', 'imageScale', 'effectColor', 'frames', 'duration', 'loops'];
  const numeric = new Set(['fontSize', 'strokeWidth', 'imageScale', 'frames', 'duration', 'loops']);

  const CUSTOM_SLIDERS = { customSpeed: 'speed', customMoveX: 'moveX', customMoveY: 'moveY', customRotate: 'rotate', customZoom: 'zoom', customSquash: 'squash', customPause: 'pause' };

  function buildEditor() {
    $('font').innerHTML = FONTS.map((f) => `<option value="${f.id}">${f.label}</option>`).join('');
    buildChips($('motions'), MOTIONS, (id) => {
      current().motion = id;
      changed();
    });
    buildChips($('effects'), EFFECTS, (id) => {
      setEffect(current(), id);
      changed();
    });
    buildChips($('customWave'), CUSTOM_WAVES, (id) => {
      current().custom.wave = id;
      changed();
    });
    buildChips($('customPath'), CUSTOM_PATHS, (id) => {
      current().custom.path = id;
      changed();
    });

    const applyWish = () => {
      const { changes, understood } = parseInstruction($('wishText').value);
      const partMsg = applyPartWords($('wishText').value);
      if (partMsg) {
        // The motion words describe the part, not the whole sticker.
        delete changes.motion;
        delete changes.custom;
        const { effect, ...fields } = changes;
        if (effect) setEffect(current(), effect);
        Object.assign(current(), fields);
        changed(!!fields.font);
        $('wishResult').textContent = partMsg;
        return;
      }
      const plain = $('wishText').value.trim();
      if (!understood.length && plain && plain.length <= 15) {
        // Nothing to interpret: a short line is most likely the words for the sticker.
        current().text = plain;
        $('wishResult').textContent = `「${plain}」を文字として入れました（色や動きも書くと、まとめて設定できます）`;
        changed();
        return;
      }
      if (!understood.length) {
        $('wishResult').textContent = $('wishText').value.trim()
          ? 'ごめんね、わかる言葉が見つからなかったよ。下の例を参考にしてね'
          : '作りたいスタンプを書いてね';
        return;
      }
      const st = current();
      const { custom, effect, ...fields } = changes;
      if (effect) setEffect(st, effect);
      Object.assign(st, fields);
      if (custom) Object.assign(st.custom, custom, { text: '' });
      st.loops = Math.min(st.loops, Math.max(1, Math.floor(4 / st.duration)));
      $('wishResult').textContent = '読みとった内容：' + understood.join(' / ');
      changed(!!fields.font);
    };
    $('wishApply').addEventListener('click', applyWish);
    for (const ex of WISH_EXAMPLES) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'chip';
      b.textContent = ex;
      b.addEventListener('click', () => {
        $('wishText').value = ex;
        applyWish();
      });
      $('wishExamples').append(b);
    }

    for (const key of fields) {
      $(key).addEventListener('input', () => {
        const el = $(key);
        current()[key] = numeric.has(key) ? Number(el.value) : el.value;
        if (key === 'duration') fixLoops();
        changed(key === 'font');
      });
    }

    const applyWords = () => {
      const text = $('customText').value;
      const st = current();
      st.custom.text = text;
      const partMsg = applyPartWords(text);
      if (partMsg) {
        $('customResult').textContent = partMsg;
        return;
      }
      const r = parseMotionText(text);
      if (!r) {
        $('customResult').textContent = text.trim()
          ? 'ごめんね、動きの言葉が見つからなかったよ。下の例を参考にしてね'
          : '動きを言葉で書いてね';
        return;
      }
      Object.assign(st.custom, r.custom);
      $('customResult').textContent = '読みとった動き：' + r.understood.join('・');
      changed();
    };
    $('customApply').addEventListener('click', applyWords);
    $('customText').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.isComposing) applyWords();
    });
    for (const ex of MOTION_EXAMPLES) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'chip';
      b.textContent = ex;
      b.addEventListener('click', () => {
        $('customText').value = ex;
        applyWords();
      });
      $('customExamples').append(b);
    }

    for (const [elId, prop] of Object.entries(CUSTOM_SLIDERS)) {
      $(elId).addEventListener('input', () => {
        current().custom[prop] = Number($(elId).value);
        changed();
      });
    }

    $('image').addEventListener('change', async (e) => {
      const file = e.target.files[0];
      e.target.value = '';
      if (!file) return;
      try {
        const dataUrl = await readImageFile(file);
        const st = current();
        st.originalImage = dataUrl;
        st.image = dataUrl;
        st.parts = [];
        st.bg = { enabled: false, tolerance: 25, color: null, hasBackground: await hasOpaqueCorners(dataUrl) };
        changed();
      } catch (err) {
        setStatus(err.message, true);
      }
    });
    $('clearImage').addEventListener('click', () => {
      const st = current();
      st.image = null;
      st.originalImage = null;
      st.parts = [];
      st.bg = { enabled: false, tolerance: 25, color: null };
      changed();
    });

    $('bgToggle').addEventListener('click', () => {
      current().bg.enabled = !current().bg.enabled;
      applyBackgroundRemoval();
      syncEditor();
    });
    $('bgTolerance').addEventListener('input', debounce(() => {
      current().bg.tolerance = Number($('bgTolerance').value);
      applyBackgroundRemoval();
    }, 250));
    $('bgAuto').addEventListener('click', () => {
      current().bg.color = null;
      current().bg.enabled = true;
      applyBackgroundRemoval();
      syncEditor();
    });
    $('bgPickCanvas').addEventListener('click', (e) => {
      const st = current();
      if (!st.originalImage) return;
      const canvas = e.currentTarget;
      const rect = canvas.getBoundingClientRect();
      const x = Math.min(canvas.width - 1, Math.max(0, Math.floor(((e.clientX - rect.left) / rect.width) * canvas.width)));
      const y = Math.min(canvas.height - 1, Math.max(0, Math.floor(((e.clientY - rect.top) / rect.height) * canvas.height)));
      const [r, g, b] = canvas.getContext('2d').getImageData(x, y, 1, 1).data;
      st.bg.color = [r, g, b];
      st.bg.enabled = true;
      applyBackgroundRemoval();
      syncEditor();
    });

    $('add').addEventListener('click', () => {
      const base = current();
      state.stickers.push(newSticker({ font: base.font, color: base.color, strokeColor: base.strokeColor, strokeWidth: base.strokeWidth }));
      select(state.stickers.length - 1);
    });
    $('duplicate').addEventListener('click', () => {
      const copy = { ...current(), custom: { ...current().custom }, bg: { ...current().bg }, parts: JSON.parse(JSON.stringify(current().parts)) };
      state.stickers.splice(state.selected + 1, 0, copy);
      select(state.selected + 1);
    });
    $('remove').addEventListener('click', () => {
      if (state.stickers.length <= 1) return;
      state.stickers.splice(state.selected, 1);
      select(Math.min(state.selected, state.stickers.length - 1));
    });

    document.querySelectorAll('.bg-switch .chip').forEach((b) => {
      b.addEventListener('click', () => {
        document.querySelectorAll('.bg-switch .chip').forEach((x) => x.classList.toggle('active', x === b));
        document.querySelector('.stage').className = 'stage ' + (b.dataset.bg === 'checker' ? '' : b.dataset.bg);
      });
    });

    buildChips($('partType'), PART_MOTIONS, (id) => {
      current().parts[partSel].cfg.type = id;
      changed();
    });
    $('partAmount').addEventListener('input', () => {
      current().parts[partSel].cfg.amount = Number($('partAmount').value);
      changed();
    });
    $('partSpeed').addEventListener('input', () => {
      current().parts[partSel].cfg.speed = Number($('partSpeed').value);
      changed();
    });
    $('partAdd').addEventListener('click', () => {
      partMode = partMode === 'draw' ? 'idle' : 'draw';
      if (partMode === 'idle') pendingParts = [];
      stroke = null;
      syncParts();
    });
    $('partApply').addEventListener('click', applyPartBox);
    $('partText').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.isComposing) applyPartBox();
    });
    $('partRemove').addEventListener('click', () => {
      current().parts.splice(partSel, 1);
      partSel = Math.max(0, partSel - 1);
      changed();
    });

    // Trace a part (draw mode), or tap to move the joint of the selected part.
    const pc = $('partsCanvas');
    const toImage = (e) => {
      const r = pc.getBoundingClientRect();
      return [Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), Math.min(1, Math.max(0, (e.clientY - r.top) / r.height))];
    };
    let downAt = null;
    pc.addEventListener('pointerdown', (e) => {
      downAt = toImage(e);
      pc.setPointerCapture(e.pointerId);
      if (partMode === 'draw') {
        stroke = [downAt];
        drawPartsCanvas();
      }
    });
    pc.addEventListener('pointermove', (e) => {
      if (partMode !== 'draw' || !stroke) return;
      stroke.push(toImage(e));
      drawPartsCanvas();
    });
    pc.addEventListener('pointerup', (e) => {
      const at = toImage(e);
      if (partMode === 'draw' && stroke) {
        const ok = addPartFromStroke(stroke);
        stroke = null;
        if (ok && !pendingParts.length) partMode = 'idle';
        else setStatus('もう少し大きく、ぐるっと一周囲んでね');
        changed();
      } else if (downAt && current().parts.length && Math.hypot(at[0] - downAt[0], at[1] - downAt[1]) < 0.03) {
        current().parts[partSel].pivot = at;
        changed();
      }
      downAt = null;
    });

    document.querySelectorAll('.tabs [role="tab"]').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));
    let savedTab = 'text';
    try {
      savedTab = localStorage.getItem(TAB_KEY) || 'text';
    } catch (e) {}
    showTab(savedTab, true);

    $('miniPreview').addEventListener('click', () => $('preview').scrollIntoView({ behavior: 'smooth', block: 'center' }));
    if ('IntersectionObserver' in window) {
      new IntersectionObserver(([entry]) => {
        $('miniPreview').hidden = entry.isIntersecting;
      }, { threshold: 0.35 }).observe(document.querySelector('.stage'));
    }

    $('exportOne').addEventListener('click', exportOne);
    $('exportZip').addEventListener('click', exportZip);
  }

  // Switch effect; keep a color the user picked, otherwise use the new effect's own color.
  function setEffect(st, id) {
    const before = EFFECTS[st.effect];
    const userPicked = before && before.color && st.effectColor !== before.color;
    st.effect = id;
    if (!userPicked && EFFECTS[id] && EFFECTS[id].color) st.effectColor = EFFECTS[id].color;
  }

  const TAB_KEY = 'ugoku-stamp-maker:tab';
  function showTab(name, initial) {
    if (!$('page-' + name)) name = 'text';
    document.querySelectorAll('.tabs [role="tab"]').forEach((b) => {
      const on = b.dataset.tab === name;
      b.setAttribute('aria-selected', String(on));
      b.tabIndex = on ? 0 : -1;
      $('page-' + b.dataset.tab).hidden = !on;
    });
    try {
      localStorage.setItem(TAB_KEY, name);
    } catch (e) {}
    // Bring the top of the new page into view if the tabs were scrolled past it.
    if (!initial) {
      const tabs = document.querySelector('.tabs');
      if (tabs.getBoundingClientRect().top <= 1) tabs.parentElement.scrollIntoView({ block: 'start' });
    }
  }

  function buildChips(container, defs, onPick) {
    for (const [id, def] of Object.entries(defs)) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'chip';
      b.dataset.value = id;
      b.setAttribute('role', 'radio');
      b.textContent = def.label;
      b.addEventListener('click', () => onPick(id));
      container.append(b);
    }
  }

  function debounce(fn, ms) {
    let t = 0;
    return (...args) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...args), ms);
    };
  }

  // Re-runs the cutout when background removal is on, or restores the original upload when it's off.
  let bgToken = 0;
  async function applyBackgroundRemoval() {
    const st = current();
    if (!st.originalImage) return;
    const token = ++bgToken;
    if (!st.bg.enabled) {
      if (st.image && st.image !== st.originalImage) imageCache.delete(st.image);
      st.image = st.originalImage;
      changed();
      return;
    }
    setStatus('背景を透明にしています…');
    try {
      const out = await removeBackground(st.originalImage, { tolerance: st.bg.tolerance, color: st.bg.color });
      if (token !== bgToken) return; // a newer request superseded this one
      if (out.alreadyTransparent) {
        st.bg.enabled = false;
        changed();
        setStatus('この画像は、もう背景が透明になっています');
        return;
      }
      const result = out.dataUrl;
      if (st.image && st.image !== st.originalImage && st.image !== result) imageCache.delete(st.image);
      st.image = result;
      changed();
      setStatus('背景を透明にしました');
    } catch (err) {
      setStatus('背景の透明化に失敗しました：' + err.message, true);
    }
  }

  function drawBgPickCanvas(originalImage) {
    const canvas = $('bgPickCanvas');
    const img = getImage(originalImage);
    if (!img) return; // not decoded yet; getImage() re-renders once it loads
    const w = 220;
    const h = Math.max(1, Math.round((img.height / img.width) * w));
    canvas.width = w;
    canvas.height = h;
    canvas.getContext('2d').drawImage(img, 0, 0, w, h);
  }

  // Total playback (duration x loops) must be 4 seconds or less.
  function fixLoops() {
    const st = current();
    const max = Math.max(1, Math.floor(4 / st.duration));
    const loops = $('loops');
    loops.innerHTML = '';
    for (let i = 1; i <= Math.min(4, max); i++) loops.add(new Option(`${i}回（合計${i * st.duration}秒）`, i));
    st.loops = Math.min(st.loops, max);
    loops.value = st.loops;
  }

  function syncEditor() {
    const st = current();
    fixLoops();
    for (const key of fields) {
      if ($(key).value !== String(st[key])) $(key).value = st[key];
    }
    $('framesOut').textContent = st.frames;
    for (const [container, val] of [[$('motions'), st.motion], [$('effects'), st.effect], [$('customWave'), st.custom.wave], [$('customPath'), st.custom.path]]) {
      container.querySelectorAll('.chip').forEach((c) => c.setAttribute('aria-checked', String(c.dataset.value === val)));
    }
    $('clearImage').disabled = !st.image;
    $('specFrames').textContent = `${st.frames}コマ`;
    $('specTime').textContent = `${st.duration}秒 × ${st.loops}回`;
    updateSize(st);

    $('customPanel').hidden = st.motion !== 'custom';
    if (document.activeElement !== $('customText')) $('customText').value = st.custom.text || '';
    for (const [elId, prop] of Object.entries(CUSTOM_SLIDERS)) {
      if ($(elId).value !== String(st.custom[prop])) $(elId).value = st.custom[prop];
    }

    $('bgToggle').disabled = !st.originalImage;
    if (!st.originalImage) {
      $('bgToggle').textContent = '先に「画像を選ぶ」で画像を入れてね';
      $('bgHint').hidden = true;
      $('bgControls').hidden = true;
    } else {
      $('bgToggle').setAttribute('aria-pressed', String(st.bg.enabled));
      $('bgToggle').textContent = st.bg.enabled ? '背景を元に戻す' : '背景を透明にする';
      $('bgHint').hidden = st.bg.enabled || st.bg.hasBackground === false;
      $('bgControls').hidden = !st.bg.enabled;
      $('bgTolerance').value = st.bg.tolerance;
      drawBgPickCanvas(st.originalImage);
    }
    syncParts();
  }

  let sizeToken = 0;
  let sizeTimer = 0;
  function updateSize(st) {
    const el = $('specSize');
    el.textContent = '計測中…';
    el.className = '';
    clearTimeout(sizeTimer);
    const token = ++sizeToken;
    sizeTimer = setTimeout(async () => {
      const apng = await buildAPNG(st, W, H);
      const bytes = apng.length;
      if (token !== sizeToken) return;
      el.textContent = `${(bytes / 1024).toFixed(0)} KB` + (apng.reduced ? '（256色）' : '');
      el.className = bytes > MAX_BYTES ? 'warn' : '';
      el.title = bytes > MAX_BYTES ? '300KBを超えています。コマ数を減らすか、画像を小さくしてください' : '';
    }, 400);
  }

  function select(i) {
    state.selected = i;
    partSel = 0;
    partMode = 'idle';
    pendingParts = [];
    stroke = null;
    $('customResult').textContent = '';
    $('wishResult').textContent = '';
    startTime = performance.now();
    syncEditor();
    renderList();
    save();
  }

  function changed(fontChanged) {
    syncEditor();
    renderList();
    save();
    if (fontChanged) ensureFont(current().font);
  }

  function ensureFont(family) {
    if (!document.fonts || !document.fonts.load) return Promise.resolve();
    return document.fonts.load(`40px "${family}"`, 'あア亜A').then(() => renderList(), () => {});
  }

  // ---------- export ----------
  function canvasToPNG(canvas) {
    return new Promise((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (!blob) return reject(new Error('PNGの生成に失敗しました'));
        blob.arrayBuffer().then((b) => resolve(new Uint8Array(b)), reject);
      }, 'image/png');
    });
  }

  async function deflate(raw) {
    const stream = new Blob([raw]).stream().pipeThrough(new CompressionStream('deflate'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  // Lossless first; if that exceeds LINE's 300KB limit, fall back to a shared 256-color palette.
  async function buildAPNG(st, w, h) {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    const pngs = [];
    const pixels = [];
    for (let i = 0; i < st.frames; i++) {
      renderSticker(c, st, i / st.frames, w, h);
      pngs.push(await canvasToPNG(c));
      pixels.push(ctx.getImageData(0, 0, w, h).data);
    }
    // delay per frame = duration / frames seconds, so one loop lasts exactly `duration` seconds.
    const opts = { delayNum: st.duration, delayDen: st.frames, plays: st.loops };
    const lossless = assembleAPNG(pngs, opts);
    if (lossless.length <= MAX_BYTES || typeof CompressionStream === 'undefined') return lossless;

    const { palette, indices } = quantize(pixels);
    const indexed = [];
    for (const idx of indices) indexed.push(await encodeIndexedPNG(w, h, idx, palette, deflate));
    const small = assembleAPNG(indexed, opts);
    small.reduced = true;
    return small.length < lossless.length ? small : lossless;
  }

  async function buildStill(st, w, h) {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    renderSticker(c, st, stillT(st), w, h);
    return canvasToPNG(c);
  }

  // Inside a claude.ai Artifact, plain downloads are blocked; use its downloads capability there.
  const artifactDownloads =
    window.claude && typeof window.claude.use === 'function'
      ? window.claude.use('downloads').catch(() => null)
      : Promise.resolve(null);

  async function download(bytes, name, type) {
    const downloads = await artifactDownloads;
    if (downloads) {
      try {
        await downloads.save({ filename: name, data: new Blob([bytes], { type }) });
        return true;
      } catch (err) {
        if (err && err.code === 'declined') return false;
        throw new Error(err && err.message ? err.message : '保存できませんでした');
      }
    }
    const url = URL.createObjectURL(new Blob([bytes], { type }));
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    return true;
  }

  async function withBusy(fn) {
    const buttons = [$('exportOne'), $('exportZip')];
    buttons.forEach((b) => (b.disabled = true));
    try {
      await document.fonts.ready;
      await fn();
    } catch (err) {
      setStatus('書き出しに失敗しました：' + err.message, true);
    } finally {
      buttons.forEach((b) => (b.disabled = false));
    }
  }

  function exportOne() {
    return withBusy(async () => {
      const num = String(state.selected + 1).padStart(2, '0');
      const bytes = await buildAPNG(current(), W, H);
      if (!(await download(bytes, `${num}.png`, 'image/png'))) return setStatus('保存をキャンセルしました');
      setStatus(`${num}.png を保存しました（${(bytes.length / 1024).toFixed(0)} KB）`, bytes.length > MAX_BYTES);
    });
  }

  function exportZip() {
    return withBusy(async () => {
      const files = [];
      const oversized = [];
      for (let i = 0; i < state.stickers.length; i++) {
        setStatus(`書き出し中… ${i + 1} / ${state.stickers.length}`);
        const name = `${String(i + 1).padStart(2, '0')}.png`;
        const data = await buildAPNG(state.stickers[i], W, H);
        if (data.length > MAX_BYTES) oversized.push(name);
        files.push({ name, data });
      }
      const first = state.stickers[0];
      files.unshift(
        { name: 'main.png', data: await buildAPNG(first, 240, 240) },
        { name: 'tab.png', data: await buildStill(first, 96, 74) }
      );
      if (!(await download(createZip(files), 'line_animation_stickers.zip', 'application/zip'))) {
        return setStatus('保存をキャンセルしました');
      }

      const notes = [];
      if (oversized.length) notes.push(`300KB超え：${oversized.join(', ')}`);
      if (!VALID_COUNTS.includes(state.stickers.length)) notes.push('申請には 8 / 16 / 24 個が必要です');
      setStatus(`ZIPを保存しました（${files.length}ファイル）` + (notes.length ? ' ⚠ ' + notes.join(' / ') : ''), notes.length > 0);
    });
  }

  function setStatus(msg, warn) {
    const el = $('status');
    el.textContent = msg;
    el.style.color = warn ? 'var(--danger)' : '';
  }

  // ---------- boot ----------
  buildEditor();
  syncEditor();
  renderList();
  requestAnimationFrame(tick);
  Promise.all(FONTS.map((f) => ensureFont(f.id))).then(() => updateSize(current()));
})();

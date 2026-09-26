(function () {
  'use strict';

  const { FONTS, MOTIONS, EFFECTS, CUSTOM_WAVES, defaultSticker, drawFrame } = window.Stickers;
  const { assembleAPNG, quantize, encodeIndexedPNG, createZip } = window.Encoder;

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
    return { ...defaultSticker(), frames: 12, duration: 1, loops: 4, ...(base || {}) };
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

  function sampleCorners(d, w, h) {
    const at = (x, y) => {
      const i = (y * w + x) * 4;
      return [d[i], d[i + 1], d[i + 2]];
    };
    const corners = [at(0, 0), at(w - 1, 0), at(0, h - 1), at(w - 1, h - 1)];
    return corners.reduce((sum, c) => sum.map((v, i) => v + c[i] / 4), [0, 0, 0]);
  }

  // Soften the hard cutout edge left by the flood fill by lightly blurring alpha only.
  function featherAlpha(d, w, h) {
    const alpha = new Uint8ClampedArray(w * h);
    for (let i = 0; i < w * h; i++) alpha[i] = d[i * 4 + 3];
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let sum = 0;
        let count = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx;
            const ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
            sum += alpha[ny * w + nx];
            count++;
          }
        }
        d[(y * w + x) * 4 + 3] = Math.round(sum / count);
      }
    }
  }

  /**
   * Cut a flat-color background out of an uploaded image.
   * Flood-fills from the four edges, removing pixels close to the target
   * color (a chosen click, or the average of the corners), then softens
   * the cut edge. Works well for a solid-color sheet or backdrop; a busy
   * photo background will need the sensitivity turned down or a color pick.
   */
  async function removeBackground(dataUrl, { tolerance, color }) {
    const img = await loadImageEl(dataUrl);
    const maxDim = 900;
    const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
    const w = Math.max(1, Math.round(img.width * scale));
    const h = Math.max(1, Math.round(img.height * scale));
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, w, h);
    const id = ctx.getImageData(0, 0, w, h);
    const d = id.data;
    const target = color || sampleCorners(d, w, h);
    const thresh = tolerance * 2.55;
    const idx = (x, y) => y * w + x;
    const dist = (i) => {
      const o = i * 4;
      const dr = d[o] - target[0];
      const dg = d[o + 1] - target[1];
      const db = d[o + 2] - target[2];
      return Math.sqrt(dr * dr + dg * dg + db * db);
    };
    const bg = new Uint8Array(w * h);
    const stack = [];
    const seed = (x, y) => {
      const i = idx(x, y);
      if (!bg[i] && dist(i) <= thresh) {
        bg[i] = 1;
        stack.push(i);
      }
    };
    for (let x = 0; x < w; x++) {
      seed(x, 0);
      seed(x, h - 1);
    }
    for (let y = 0; y < h; y++) {
      seed(0, y);
      seed(w - 1, y);
    }
    while (stack.length) {
      const i = stack.pop();
      const x = i % w;
      const y = (i / w) | 0;
      if (x > 0) seed(x - 1, y);
      if (x < w - 1) seed(x + 1, y);
      if (y > 0) seed(x, y - 1);
      if (y < h - 1) seed(x, y + 1);
    }
    for (let i = 0; i < w * h; i++) if (bg[i]) d[i * 4 + 3] = 0;
    featherAlpha(d, w, h);
    ctx.putImageData(id, 0, 0);
    return c.toDataURL('image/png');
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
    drawFrame(ctx, st, t, w, h, getImage(st.image));
  }

  const preview = $('preview');
  let startTime = performance.now();
  function tick(now) {
    const st = current();
    const cycle = st.duration * 1000;
    const frame = Math.floor((((now - startTime) % cycle) / cycle) * st.frames);
    renderSticker(preview, st, frame / st.frames);
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

  const CUSTOM_SLIDERS = { customSpeed: 'speed', customMoveX: 'moveX', customMoveY: 'moveY', customRotate: 'rotate', customZoom: 'zoom' };

  function buildEditor() {
    $('font').innerHTML = FONTS.map((f) => `<option value="${f.id}">${f.label}</option>`).join('');
    buildChips($('motions'), MOTIONS, (id) => {
      current().motion = id;
      changed();
    });
    buildChips($('effects'), EFFECTS, (id) => {
      current().effect = id;
      changed();
    });
    buildChips($('customWave'), CUSTOM_WAVES, (id) => {
      current().custom.wave = id;
      changed();
    });

    for (const key of fields) {
      $(key).addEventListener('input', () => {
        const el = $(key);
        current()[key] = numeric.has(key) ? Number(el.value) : el.value;
        if (key === 'duration') fixLoops();
        changed(key === 'font');
      });
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
        st.bg = { enabled: false, tolerance: 30, color: null };
        changed();
      } catch (err) {
        setStatus(err.message, true);
      }
    });
    $('clearImage').addEventListener('click', () => {
      const st = current();
      st.image = null;
      st.originalImage = null;
      st.bg = { enabled: false, tolerance: 30, color: null };
      changed();
    });

    $('bgToggle').addEventListener('change', () => {
      current().bg.enabled = $('bgToggle').checked;
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
      const copy = { ...current(), custom: { ...current().custom }, bg: { ...current().bg } };
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

    $('exportOne').addEventListener('click', exportOne);
    $('exportZip').addEventListener('click', exportZip);
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
      const result = await removeBackground(st.originalImage, { tolerance: st.bg.tolerance, color: st.bg.color });
      if (token !== bgToken) return; // a newer request superseded this one
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
    for (const [container, val] of [[$('motions'), st.motion], [$('effects'), st.effect], [$('customWave'), st.custom.wave]]) {
      container.querySelectorAll('.chip').forEach((c) => c.setAttribute('aria-checked', String(c.dataset.value === val)));
    }
    $('clearImage').disabled = !st.image;
    $('specFrames').textContent = `${st.frames}コマ`;
    $('specTime').textContent = `${st.duration}秒 × ${st.loops}回`;
    updateSize(st);

    $('customPanel').hidden = st.motion !== 'custom';
    for (const [elId, prop] of Object.entries(CUSTOM_SLIDERS)) {
      if ($(elId).value !== String(st.custom[prop])) $(elId).value = st.custom[prop];
    }

    $('bgPanel').hidden = !st.originalImage;
    if (st.originalImage) {
      $('bgToggle').checked = st.bg.enabled;
      $('bgControls').hidden = !st.bg.enabled;
      $('bgTolerance').value = st.bg.tolerance;
      drawBgPickCanvas(st.originalImage);
    }
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

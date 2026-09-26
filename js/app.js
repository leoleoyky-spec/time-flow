(function () {
  'use strict';

  const { FONTS, MOTIONS, EFFECTS, defaultSticker, drawFrame } = window.Stickers;
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

  function buildEditor() {
    $('font').innerHTML = FONTS.map((f) => `<option value="${f.id}">${f.label}</option>`).join('');
    buildChips($('motions'), MOTIONS, 'motion');
    buildChips($('effects'), EFFECTS, 'effect');

    for (const key of fields) {
      $(key).addEventListener('input', () => {
        const el = $(key);
        current()[key] = numeric.has(key) ? Number(el.value) : el.value;
        if (key === 'duration') fixLoops();
        changed(key === 'font');
      });
    }

    $('image').addEventListener('change', async (e) => {
      const file = e.target.files[0];
      e.target.value = '';
      if (!file) return;
      try {
        current().image = await readImageFile(file);
        changed();
      } catch (err) {
        setStatus(err.message, true);
      }
    });
    $('clearImage').addEventListener('click', () => {
      current().image = null;
      changed();
    });

    $('add').addEventListener('click', () => {
      const base = current();
      state.stickers.push(newSticker({ font: base.font, color: base.color, strokeColor: base.strokeColor, strokeWidth: base.strokeWidth }));
      select(state.stickers.length - 1);
    });
    $('duplicate').addEventListener('click', () => {
      state.stickers.splice(state.selected + 1, 0, { ...current() });
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

  function buildChips(container, defs, key) {
    for (const [id, def] of Object.entries(defs)) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'chip';
      b.dataset.value = id;
      b.setAttribute('role', 'radio');
      b.textContent = def.label;
      b.addEventListener('click', () => {
        current()[key] = id;
        changed();
      });
      container.append(b);
    }
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
    for (const [container, key] of [[$('motions'), 'motion'], [$('effects'), 'effect']]) {
      container.querySelectorAll('.chip').forEach((c) => c.setAttribute('aria-checked', String(c.dataset.value === st[key])));
    }
    $('clearImage').disabled = !st.image;
    $('specFrames').textContent = `${st.frames}コマ`;
    $('specTime').textContent = `${st.duration}秒 × ${st.loops}回`;
    updateSize(st);
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

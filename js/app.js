(function () {
  'use strict';

  const { FONTS, MOTIONS, EFFECTS, defaultSticker, drawFrame, layoutSticker } = window.Stickers;
  const { assembleAPNG, quantize, encodeIndexedPNG, createZip, lineStickerSize } = window.Encoder;
  const { parseInstruction, parsePartRequests, parsePartMotion, buildSpritePrompt, WISH_EXAMPLES } = window.MotionWords;
  const { removeBackgroundPixels } = window.BgRemove;
  const { guessPivot, buildMesh, findEye, PART_MOTIONS } = window.Parts;
  const { findGrid, findStickers, evenGrid, boundingBox, alignFrames, thinFrames, frameCountFor } = window.Sprite;

  const W = 320;
  const H = 270;
  const MAX_BYTES = 300 * 1000; // LINE's 300 KB, counted the strict way
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
    st.frameImages = Array.isArray(st.frameImages) ? st.frameImages.filter(Boolean) : [];
    st.frameAdj = st.frameImages.map((_, i) => ({ x: 0, y: 0, s: 1, ...((st.frameAdj || [])[i] || {}) }));
    if (st.mode === 'frames' && !st.frameImages.length) st.mode = 'single';
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
  // Pictures (data URLs) can be far bigger than localStorage allows once a sticker has
  // many frames, so they go to IndexedDB and the saved JSON keeps an "idb:<key>" ref.
  // Without IndexedDB (some private windows) everything stays inline as before.
  const IDB_PREFIX = 'idb:';
  const imageDb = new Promise((resolve) => {
    try {
      const req = indexedDB.open('ugoku-stamp-maker', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('images');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch (e) {
      resolve(null);
    }
  });
  const idb = (db, mode, fn) => new Promise((resolve, reject) => {
    const tx = db.transaction('images', mode);
    const out = fn(tx.objectStore('images'));
    tx.oncomplete = () => resolve(out && out.result);
    tx.onerror = () => reject(tx.error);
  });
  function hashKey(str) {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 16777619);
    return 'k' + (h >>> 0).toString(36) + str.length.toString(36);
  }
  const storedKeys = new Set();

  // Swap stored refs in a loaded state back to the pictures themselves.
  async function resolveImages(s) {
    const db = await imageDb;
    if (!db) return;
    const refs = new Set();
    JSON.stringify(s, (k, v) => (typeof v === 'string' && v.startsWith(IDB_PREFIX) ? (refs.add(v.slice(IDB_PREFIX.length)), v) : v));
    const found = new Map();
    await idb(db, 'readonly', (store) => {
      for (const key of refs) {
        const r = store.get(key);
        r.onsuccess = () => {
          if (r.result) {
            found.set(key, r.result);
            storedKeys.add(key);
          }
        };
      }
    });
    const walk = (o) => {
      for (const k of Object.keys(o)) {
        const v = o[k];
        if (typeof v === 'string' && v.startsWith(IDB_PREFIX)) o[k] = found.get(v.slice(IDB_PREFIX.length)) || null;
        else if (v && typeof v === 'object') walk(v);
      }
    };
    walk(s);
  }

  let saveTimer = 0;
  function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      const db = await imageDb;
      const fresh = new Map();
      const used = new Set();
      const json = JSON.stringify(state, (k, v) => {
        if (!db || typeof v !== 'string') return v;
        if (v.startsWith(IDB_PREFIX)) {
          used.add(v.slice(IDB_PREFIX.length));
          return v;
        }
        if (!v.startsWith('data:') || v.length < 4096) return v;
        const key = hashKey(v);
        used.add(key);
        if (!storedKeys.has(key)) fresh.set(key, v);
        return IDB_PREFIX + key;
      });
      try {
        if (db && fresh.size) {
          await idb(db, 'readwrite', (store) => fresh.forEach((v, key) => store.put(v, key)));
          fresh.forEach((_, key) => storedKeys.add(key));
        }
        localStorage.setItem(STORAGE_KEY, json);
        if (db) {
          // Forget pictures no sticker uses any more.
          const all = await idb(db, 'readonly', (store) => store.getAllKeys());
          const gone = (all || []).filter((key) => !used.has(key));
          if (gone.length) {
            await idb(db, 'readwrite', (store) => gone.forEach((key) => store.delete(key)));
            gone.forEach((key) => storedKeys.delete(key));
          }
        }
      } catch (e) {
        setStatus('ブラウザの保存容量がいっぱいです（画像が大きすぎる可能性があります）', true);
      }
    }, 300);
  }

  // ---------- images ----------
  function getImage(src) {
    if (!src || !src.startsWith('data:')) return null;
    let entry = imageCache.get(src);
    if (!entry) {
      const img = new Image();
      entry = { img, ready: false };
      img.onload = () => {
        entry.ready = true;
        renderList();
        if (src === current().originalImage) drawBgPickCanvas(src);
        if (src === current().image) drawPartsCanvas();
        if (isFrames(current())) drawFrameEditor();
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
  // The bend grid depends on the picture, the traced outlines, the joints and whether
  // a part is a wink, so it is cached on those; the rest is read live every frame.
  const layerCache = new Map();
  function getLayers(st) {
    if (!st.parts || !st.parts.length) return null;
    const img = getImage(st.image);
    if (!img) return null;
    const key = st.image.length + ':' + st.image.slice(-64) + ':' + JSON.stringify(st.parts.map((p) => [p.poly, p.pivot, p.cfg.type === 'wink']));
    let built = layerCache.get(key);
    if (!built) {
      built = buildLayers(img, st.parts);
      if (layerCache.size > 30) layerCache.clear();
      layerCache.set(key, built);
    }
    return {
      img: built.img,
      base: built.base,
      mesh: built.mesh,
      parts: built.bendIdx.map((i) => st.parts[i]),
      winks: built.eyes.map((e) => ({ ...e, cfg: st.parts[e.idx].cfg })),
    };
  }

  // Bending parts (hands, ears) are drawn through a mesh; winking eyes are found
  // inside their traced area, painted over with the skin around them, and drawn
  // separately each frame. The base is that picture with the bent cells cleared out,
  // so the unbent copy of a hand never shows behind the moving one.
  function buildLayers(img, parts) {
    const w = img.naturalWidth || img.width;
    const h = img.naturalHeight || img.height;
    const src = document.createElement('canvas');
    src.width = w;
    src.height = h;
    const sctx = src.getContext('2d', { willReadFrequently: true });
    sctx.drawImage(img, 0, 0);
    const pixels = sctx.getImageData(0, 0, w, h);
    const eyes = [];
    const bendIdx = [];
    parts.forEach((p, idx) => {
      if (p.cfg.type !== 'wink') {
        bendIdx.push(idx);
        return;
      }
      const eye = findEye(pixels.data, w, h, partMask(p.poly, w, h));
      if (!eye) return;
      const [x0, y0, x1, y1] = eye.box;
      const pad = 3;
      const bx = Math.max(0, x0 - pad);
      const by = Math.max(0, y0 - pad);
      const bw = Math.min(w, x1 + pad) - bx;
      const bh = Math.min(h, y1 + pad) - by;
      const eyeImg = new ImageData(bw, bh);
      for (let y = 0; y < bh; y++) {
        for (let x = 0; x < bw; x++) {
          const i = (by + y) * w + bx + x;
          if (!eye.mask[i]) continue;
          eyeImg.data.set(pixels.data.subarray(i * 4, i * 4 + 4), (y * bw + x) * 4);
          pixels.data.set([...eye.skin, pixels.data[i * 4 + 3]], i * 4);
        }
      }
      const canvas = document.createElement('canvas');
      canvas.width = bw;
      canvas.height = bh;
      canvas.getContext('2d').putImageData(eyeImg, 0, 0);
      eyes.push({ idx, canvas, x: bx, y: by, box: eye.box, color: eye.color });
    });
    sctx.putImageData(pixels, 0, 0);

    const bendParts = bendIdx.map((i) => parts[i]);
    const mesh = buildMesh(w, h, bendParts);
    const base = document.createElement('canvas');
    base.width = w;
    base.height = h;
    const ctx = base.getContext('2d');
    ctx.drawImage(src, 0, 0);
    // Leave a 1px sliver of the original along the outer edge of the bent area (where
    // the bend is ~0) so its seam with the untouched picture can't show a hairline.
    const bent = new Set();
    for (let c = 0; c < mesh.cells.length; c += 2) bent.add(mesh.cells[c] + ',' + mesh.cells[c + 1]);
    const has = (i, j) => bent.has(i + ',' + j);
    for (let c = 0; c < mesh.cells.length; c += 2) {
      const i = mesh.cells[c];
      const j = mesh.cells[c + 1];
      const l = has(i - 1, j) ? 0 : 1;
      const r = has(i + 1, j) ? 0 : 1;
      const t = has(i, j - 1) ? 0 : 1;
      const b = has(i, j + 1) ? 0 : 1;
      ctx.clearRect(i * mesh.cell + l, j * mesh.cell + t, mesh.cell - l - r, mesh.cell - t - b);
    }
    return { img: src, base, mesh, bendIdx, eyes };
  }

  function polyCenter(poly) {
    return [poly.reduce((a, p) => a + p[0], 0) / poly.length, poly.reduce((a, p) => a + p[1], 0) / poly.length];
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
    if (!hasImg) hint = '先に「画像」タブで画像を入れてね';
    else if (partMode === 'draw' && pendingParts.length) hint = `「${pendingParts[0].name}」を、指やマウスでぐるっと囲んでね`;
    else if (partMode === 'draw') hint = '動かしたい部分（左手など）を、指やマウスでぐるっと囲んでね';
    else if (!parts.length) hint = '言葉で書くか、「動かす部分をなぞる」で囲んだ部分だけが動きます';
    else hint = '赤い点が動きの中心です（タップで移動）';
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
    // An eye closes around its own middle rather than swinging from a joint.
    st.parts.push({ name: req ? req.name : `部分${st.parts.length + 1}`, poly: simple, pivot: cfg.type === 'wink' ? polyCenter(simple) : pivot, cfg });
    partSel = st.parts.length - 1;
    if (cfg.type === 'wink' && !findEye(ctx.getImageData(0, 0, w, h).data, w, h, partMask(simple, w, h))) {
      setStatus('囲んだ中に目（黒っぽいところ）が見つかりませんでした');
    }
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
    if (!st.image) return '先に「画像」タブで画像を入れてね';
    const done = [];
    const queue = [];
    for (const req of reqs) {
      const i = st.parts.findIndex((p) => p.name === req.name);
      // With a single untitled part, "左手を…" most likely means that part.
      const j = i >= 0 ? i : st.parts.length === 1 && /^部分\d$/.test(st.parts[0].name || '部分1') && !queue.length && !done.length ? 0 : -1;
      if (j >= 0) {
        Object.assign(st.parts[j].cfg, req.cfg);
        if (req.cfg.type === 'wink') st.parts[j].pivot = polyCenter(st.parts[j].poly);
        st.parts[j].name = req.name;
        if (req.only) st.motion = 'none';
        partSel = j;
        done.push(req.understood.join('・'));
      } else if (st.parts.length + queue.length < 3) {
        queue.push(req);
      }
    }
    changed();
    let msg = done.length ? '設定しました：' + done.join(' / ') : '';
    if (queue.length) {
      pendingParts = queue;
      showTab('motion');
      partMode = 'draw';
      stroke = null;
      syncParts();
      $('partsPanel').scrollIntoView({ behavior: 'smooth', block: 'center' });
      const qn = queue.map((r) => r.name).join('、');
      msg += (msg ? '。' : '') + `「うごき」タブの絵で、${queue[0].name}を指でぐるっと囲んでね` + (queue.length > 1 ? `（次は${queue.slice(1).map((r) => r.name).join('、')}）` : '');
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
        ? 'わかる言葉が見つかりませんでした。'
        : '動かしたい部分と動きを書いてね';
      if (text.trim()) offerAi($('partResult'), text.trim());
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
    if (m.cfg.type === 'wink') st.parts[partSel].pivot = polyCenter(st.parts[partSel].poly);
    changed();
    $('partResult').textContent = `${st.parts[partSel].name || '部分' + (partSel + 1)}：` + m.understood.join('・');
  }


  // ---------- frame art: sprite sheets, frame images, videos ----------
  // Everything is processed in the browser; nothing is uploaded anywhere.
  const MAX_FRAME_SIDE = 480; // frames are shown at most ~300px wide in a sticker
  let frameSession = null; // what the current frames were made from, to redo them with other options
  let frameSel = 0;

  function toCanvas(src, maxSide) {
    const sw = src.naturalWidth || src.videoWidth || src.displayWidth || src.width;
    const sh = src.naturalHeight || src.videoHeight || src.displayHeight || src.height;
    const k = Math.min(1, maxSide / Math.max(sw, sh));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(sw * k));
    c.height = Math.max(1, Math.round(sh * k));
    c.getContext('2d', { willReadFrequently: true }).drawImage(src, 0, 0, c.width, c.height);
    return c;
  }

  function pixelsOf(c) {
    return c.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, c.width, c.height);
  }

  // Remove a flat background (white paper, a single color) if the picture has one.
  function clearBackground(c, on) {
    if (!on) return c;
    const id = pixelsOf(c);
    const res = removeBackgroundPixels(id.data, c.width, c.height, { tolerance: 25 });
    if (!res.alreadyTransparent) c.getContext('2d').putImageData(id, 0, 0);
    return c;
  }

  function loadImageFile(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        URL.revokeObjectURL(url);
        resolve(img);
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error('画像を読み込めませんでした'));
      };
      img.src = url;
    });
  }

  // All frames of an animated GIF / APNG / WebP, where the browser can decode them.
  async function decodeAnimated(file) {
    if (!('ImageDecoder' in window)) return null;
    try {
      const dec = new ImageDecoder({ data: await file.arrayBuffer(), type: file.type || 'image/png' });
      await dec.tracks.ready;
      const count = dec.tracks.selectedTrack ? dec.tracks.selectedTrack.frameCount : 1;
      if (count < 2) return null;
      const out = [];
      for (const i of thinFrames(count, 20)) {
        const { image } = await dec.decode({ frameIndex: i });
        out.push(toCanvas(image, 1200));
        image.close();
      }
      return out;
    } catch (e) {
      return null;
    }
  }

  function videoFrames(file, start, length, count) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const v = document.createElement('video');
      v.muted = true;
      v.playsInline = true;
      v.preload = 'auto';
      v.src = url;
      v.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error('この動画は読み込めませんでした（MP4 / WebM を選んでね）'));
      };
      v.onloadeddata = async () => {
        const dur = v.duration || 0;
        const s0 = Math.max(0, Math.min(start, Math.max(0, dur - 0.1)));
        const len = Math.max(0.2, Math.min(length, dur - s0));
        const out = [];
        for (let i = 0; i < count; i++) {
          v.currentTime = s0 + (len * i) / count;
          await new Promise((r) => v.addEventListener('seeked', r, { once: true }));
          out.push(toCanvas(v, 800));
        }
        URL.revokeObjectURL(url);
        resolve({ frames: out, duration: dur, used: len });
      };
    });
  }

  /**
   * Turn source pictures (cut from a sheet, or one per frame) into same-sized sticker
   * frames: put each on a common canvas, steady the jitter, trim the empty border
   * shared by all frames, and shrink to a sensible size.
   */
  function makeFrames(pieces, alignMode) {
    const fw = Math.max(...pieces.map((p) => p.width));
    const fh = Math.max(...pieces.map((p) => p.height));
    const placed = pieces.map((p) => {
      const c = document.createElement('canvas');
      c.width = fw;
      c.height = fh;
      c.getContext('2d').drawImage(p, Math.round((fw - p.width) / 2), Math.round((fh - p.height) / 2));
      return c;
    });
    const raw = placed.map((c) => ({ d: pixelsOf(c).data, w: fw, h: fh }));
    const shifts = alignFrames(raw, alignMode);
    const shifted = placed.map((c, i) => {
      const o = document.createElement('canvas');
      o.width = fw;
      o.height = fh;
      o.getContext('2d').drawImage(c, shifts[i][0], shifts[i][1]);
      return o;
    });
    let box = null;
    for (const c of shifted) {
      const b = boundingBox(pixelsOf(c).data, fw, fh);
      if (!b) continue;
      box = box
        ? { x: Math.min(box.x, b.x), y: Math.min(box.y, b.y), r: Math.max(box.r, b.x + b.w), b: Math.max(box.b, b.y + b.h) }
        : { x: b.x, y: b.y, r: b.x + b.w, b: b.y + b.h };
    }
    if (!box) throw new Error('絵が見つかりませんでした');
    const pad = 2;
    const bx = Math.max(0, box.x - pad);
    const by = Math.max(0, box.y - pad);
    const bw = Math.min(fw, box.r + pad) - bx;
    const bh = Math.min(fh, box.b + pad) - by;
    const k = Math.min(1, MAX_FRAME_SIDE / Math.max(bw, bh));
    return shifted.map((c) => {
      const o = document.createElement('canvas');
      o.width = Math.max(1, Math.round(bw * k));
      o.height = Math.max(1, Math.round(bh * k));
      o.getContext('2d').drawImage(c, bx, by, bw, bh, 0, 0, o.width, o.height);
      return o.toDataURL('image/png');
    });
  }

  function cutCells(sheet, cells) {
    return cells.map((r) => {
      const c = document.createElement('canvas');
      c.width = r.w;
      c.height = r.h;
      c.getContext('2d').drawImage(sheet, r.x, r.y, r.w, r.h, 0, 0, r.w, r.h);
      return c;
    });
  }

  // (Re)build the current sticker's frames from the session's source and options.
  async function rebuildFrames() {
    const f = frameSession;
    if (!f) return;
    setStatus('コマを作っています…');
    await new Promise((r) => setTimeout(r, 20)); // let the message show before the heavy work
    try {
      let pieces;
      if (f.kind === 'sheet') {
        const sheet = clearBackground(toCanvas(f.source, 2000), f.bg);
        let grid = null;
        if (f.grid === 'auto') grid = findGrid(pixelsOf(sheet).data, sheet.width, sheet.height);
        f.found = grid ? `${grid.cols}×${grid.rows}` : null;
        if (!grid) {
          const [c, r] = f.grid === 'auto' ? [2, 2] : f.grid.split('x').map(Number);
          grid = evenGrid(sheet.width, sheet.height, c, r);
        }
        pieces = cutCells(sheet, grid.cells);
      } else if (f.kind === 'video') {
        const count = Math.max(5, Math.min(20, Math.round(f.length * 8)));
        const res = await videoFrames(f.source, f.start, f.length, count);
        f.videoDuration = res.duration;
        f.used = res.used;
        pieces = res.frames.map((c) => clearBackground(c, f.bg));
      } else {
        pieces = f.source.map((c) => clearBackground(toCanvas(c, 1200), f.bg));
      }
      pieces = thinFrames(pieces.length, 20).map((i) => pieces[i]);
      const urls = makeFrames(pieces, f.align);
      const st = current();
      st.mode = 'frames';
      st.frameImages = urls;
      st.frameAdj = urls.map(() => ({ x: 0, y: 0, s: 1 }));
      st.frames = frameCountFor(urls.length);
      if (f.kind === 'video') st.duration = Math.max(1, Math.min(4, Math.round(f.used)));
      st.loops = Math.min(st.loops, Math.max(1, Math.floor(4 / st.duration)));
      frameSel = 0;
      changed();
      let how = '';
      if (f.kind === 'sheet' && f.grid !== 'auto') how = `（${f.grid.replace('x', '×')}で切りました）`;
      else if (f.kind === 'sheet') how = f.found ? `（${f.found}の並びを自動で見つけました）` : '（並びが見つからなかったので2×2で切りました。下の「コマの並び」で変えられます）';
      setStatus(`${urls.length}コマのスタンプにしました${how}`);
    } catch (err) {
      setStatus('コマを作れませんでした：' + err.message, true);
    }
  }

  // A new source replaces the sticker's picture: frame art and the one-picture mode
  // don't mix, and words drawn inside the frames usually replace the typed text.
  async function startFrames(kind, source, extra = {}) {
    const st = current();
    const first = !isFrames(st);
    frameSession = { kind, source, grid: 'auto', align: kind === 'video' ? 'none' : 'auto', bg: true, start: 0, length: 2, ...extra };
    if (first) {
      st.text = '';
      st.motion = 'none';
    }
    st.parts = [];
    await rebuildFrames();
  }

  // ---------- quick set: one sheet (or several pictures) → a whole set of stickers ----------
  // Each sticker gets its own motion and effect, like a hand-made set; one tap reshuffles.
  const LOOKS = [
    ['bounce', 'sparkle'], ['swing', 'none'], ['pulse', 'hearts'], ['shake', 'lines'],
    ['shiri', 'notes'], ['float', 'sparkle'], ['bow', 'none'], ['jelly', 'none'],
    ['dance', 'notes'], ['swing', 'sparkle'], ['pulse', 'none'], ['float', 'hearts'],
    ['shiri', 'sparkle'], ['shake', 'sweat'], ['dance', 'sparkle'], ['jelly', 'sparkle'],
  ];
  let lookOffset = 0;
  function lookFor(i) {
    const [motion, effect] = LOOKS[(i + lookOffset) % LOOKS.length];
    return EFFECTS[effect].color ? { motion, effect, effectColor: EFFECTS[effect].color } : { motion, effect };
  }

  const isBlank = (st) => !st.image && !st.frameImages.length && (!st.text.trim() || st.text === defaultSticker().text);

  function cropUrl(c, r) {
    const k = Math.min(1, 640 / Math.max(r.w, r.h));
    const o = document.createElement('canvas');
    o.width = Math.max(1, Math.round(r.w * k));
    o.height = Math.max(1, Math.round(r.h * k));
    o.getContext('2d').drawImage(c, r.x, r.y, r.w, r.h, 0, 0, o.width, o.height);
    return o.toDataURL('image/png');
  }

  async function quickImport(files) {
    setStatus('スタンプを作っています…');
    await new Promise((r) => setTimeout(r, 20));
    const made = [];
    try {
      for (const file of files) {
        const img = await loadImageFile(file);
        const orig = toCanvas(img, 2000);
        const clear = toCanvas(img, 2000);
        const id = pixelsOf(clear);
        const hadBg = !removeBackgroundPixels(id.data, clear.width, clear.height, { tolerance: 25 }).alreadyTransparent;
        if (hadBg) clear.getContext('2d').putImageData(id, 0, 0);
        for (const r of findStickers(id.data, clear.width, clear.height)) {
          const image = cropUrl(clear, r);
          made.push({
            originalImage: hadBg ? cropUrl(orig, r) : image,
            image,
            bg: { enabled: hadBg, tolerance: 25, color: null, hasBackground: hadBg },
          });
        }
      }
    } catch (err) {
      return setStatus(err.message, true);
    }
    if (!made.length) return setStatus('絵が見つかりませんでした', true);
    const keep = state.stickers.filter((st) => !isBlank(st));
    const add = made.slice(0, 24 - keep.length);
    if (!add.length) return setStatus('スタンプは24個までです。「全部消す」で空けてから読み込んでね', true);
    const base = state.stickers[0];
    state.stickers = keep.concat(add.map((m, i) => newSticker({ font: base.font, ...m, text: '', ...lookFor(keep.length + i) })));
    select(keep.length);
    const over = made.length > add.length ? `（24個までなので残り${made.length - add.length}個は入れていません）` : '';
    setStatus(`${add.length}個のスタンプを作りました${over}。動きは「うごき」タブで変えられます`);
  }

  function shuffleLooks() {
    lookOffset += 1 + Math.floor(Math.random() * (LOOKS.length - 1));
    state.stickers.forEach((st, i) => {
      if (!isFrames(st)) Object.assign(st, lookFor(i));
    });
    changed();
  }

  function selectedAdj() {
    const st = current();
    return st.frameAdj[Math.min(frameSel, st.frameAdj.length - 1)];
  }

  function drawFrameEditor() {
    const st = current();
    const canvas = $('frameEdit');
    if (!isFrames(st)) return;
    const cur = getImage(st.frameImages[frameSel]);
    const prev = getImage(st.frameImages[(frameSel - 1 + st.frameImages.length) % st.frameImages.length]);
    if (!cur) return;
    const w = 280;
    const h = Math.round((cur.height / cur.width) * w);
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, w, h);
    const put = (img, a, alpha) => {
      const s = a.s || 1;
      ctx.globalAlpha = alpha;
      ctx.drawImage(img, (a.x || 0) * w - ((s - 1) * w) / 2, (a.y || 0) * h - ((s - 1) * h) / 2, w * s, h * s);
    };
    // The previous frame shows faintly underneath ("onion skin") to line them up.
    if (prev && st.frameImages.length > 1) put(prev, st.frameAdj[(frameSel - 1 + st.frameImages.length) % st.frameImages.length], 0.3);
    put(cur, st.frameAdj[frameSel], 1);
    ctx.globalAlpha = 1;
  }

  function syncFrames() {
    const st = current();
    const frames = isFrames(st);
    const mode = frames ? 'frames' : st.uiMode || 'single';
    $('modeChips').querySelectorAll('.chip').forEach((c) => c.setAttribute('aria-checked', String(c.dataset.value === mode)));
    $('singleMode').hidden = mode !== 'single';
    $('framesMode').hidden = mode !== 'frames';
    $('frameTools').hidden = !frames;
    $('partsPanel').hidden = frames;
    $('partsFramesNote').hidden = !frames;
    $('frames').disabled = frames;
    $('framesNote').hidden = !frames;
    if (!frames) return;
    frameSel = Math.min(frameSel, st.frameImages.length - 1);
    const f = frameSession;
    $('frameInfo').textContent = `${st.frameImages.length}コマ` + (f ? '' : '（並び・揺れ補正・背景を変えるには、もう一度読み込んでね）');
    $('gridRow').hidden = !f || f.kind !== 'sheet';
    $('videoRow').hidden = !f || f.kind !== 'video';
    $('reprocessRow').hidden = !f;
    if (f) {
      $('gridChips').querySelectorAll('.chip').forEach((c) => c.setAttribute('aria-checked', String(c.dataset.value === f.grid)));
      $('alignChips').querySelectorAll('.chip').forEach((c) => c.setAttribute('aria-checked', String(c.dataset.value === f.align)));
      $('frameBg').checked = f.bg;
      if (f.kind === 'video') {
        $('videoStart').max = Math.max(0, (f.videoDuration || 4) - 0.5).toFixed(1);
        $('videoStart').value = f.start;
        $('videoLength').value = String(f.length);
        $('videoStartOut').textContent = `${Number(f.start).toFixed(1)}秒から`;
      }
    }
    const strip = $('frameStrip');
    strip.innerHTML = '';
    st.frameImages.forEach((url, i) => {
      if (!url.startsWith('data:')) return; // still loading from storage
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'frame-thumb';
      b.setAttribute('aria-label', `${i + 1}コマ目`);
      b.setAttribute('aria-current', String(i === frameSel));
      const img = document.createElement('img');
      img.src = url;
      img.alt = '';
      const n = document.createElement('span');
      n.textContent = i + 1;
      b.append(img, n);
      b.addEventListener('click', () => {
        frameSel = i;
        syncFrames();
      });
      strip.append(b);
    });
    drawFrameEditor();
  }

  function wireFrames() {
    buildChips($('modeChips'), { single: { label: '1枚の絵を動かす' }, frames: { label: 'コマ絵・動画から作る' } }, (id) => {
      const st = current();
      if (id === 'single' && isFrames(st)) {
        st.mode = 'single';
        st.frameImages = [];
        st.frameAdj = [];
        frameSession = null;
      }
      st.uiMode = id;
      changed();
    });
    const updatePrompt = () => {
      $('aiPrompt').value = buildSpritePrompt({
        action: $('aiAction').value,
        character: $('aiCharacter').value.trim(),
        text: $('aiText').value,
        frames: Number($('aiFrames').value),
        withImage: $('aiWithImage').checked,
      });
    };
    for (const id of ['aiAction', 'aiCharacter', 'aiText', 'aiFrames', 'aiWithImage']) $(id).addEventListener('input', updatePrompt);
    $('aiWithImage').addEventListener('change', updatePrompt);
    updatePrompt();
    $('aiCopy').addEventListener('click', async () => {
      updatePrompt();
      try {
        await navigator.clipboard.writeText($('aiPrompt').value);
        $('aiCopy').textContent = 'コピーしました';
      } catch (e) {
        $('aiPrompt').select();
        $('aiCopy').textContent = '選択しました。コピーしてね';
      }
      setTimeout(() => ($('aiCopy').textContent = '頼み方をコピー'), 2000);
    });

    $('sheetFile').addEventListener('change', async (e) => {
      const file = e.target.files[0];
      e.target.value = '';
      if (!file) return;
      try {
        await startFrames('sheet', await loadImageFile(file));
      } catch (err) {
        setStatus(err.message, true);
      }
    });
    $('framesFile').addEventListener('change', async (e) => {
      const files = [...e.target.files];
      e.target.value = '';
      if (!files.length) return;
      try {
        let pics = [];
        for (const f of files) {
          const anim = /gif|png|webp/.test(f.type) ? await decodeAnimated(f) : null;
          if (anim) pics = pics.concat(anim);
          else pics.push(await loadImageFile(f));
        }
        if (pics.length < 2) {
          setStatus(files.length === 1 && /gif|png/.test(files[0].type) && !('ImageDecoder' in window)
            ? 'この端末ではGIF・APNGのコマを取り出せません。PNGのコマを複数選んでね'
            : 'コマの画像を2枚以上選んでね（1枚にコマが並んでいる絵は「スプライトシート」から）', true);
          return;
        }
        await startFrames('images', pics);
      } catch (err) {
        setStatus(err.message, true);
      }
    });
    $('videoFile').addEventListener('change', async (e) => {
      const file = e.target.files[0];
      e.target.value = '';
      if (!file) return;
      await startFrames('video', file);
    });

    buildChips($('gridChips'), { auto: { label: '自動' }, '2x2': { label: '2×2' }, '3x2': { label: '3×2' }, '4x2': { label: '4×2' }, '3x3': { label: '3×3' }, '4x3': { label: '4×3' }, '4x4': { label: '4×4' }, '2x1': { label: '2×1' }, '3x1': { label: '3×1' }, '4x1': { label: '4×1' } }, (id) => {
      frameSession.grid = id;
      rebuildFrames();
    });
    buildChips($('alignChips'), { auto: { label: '自動で揺れを減らす' }, bottom: { label: '足元をそろえる' }, center: { label: '中心をそろえる' }, none: { label: 'そのまま' } }, (id) => {
      frameSession.align = id;
      rebuildFrames();
    });
    $('frameBg').addEventListener('change', () => {
      frameSession.bg = $('frameBg').checked;
      rebuildFrames();
    });
    $('videoStart').addEventListener('input', () => {
      $('videoStartOut').textContent = `${Number($('videoStart').value).toFixed(1)}秒から`;
    });
    $('videoStart').addEventListener('change', () => {
      frameSession.start = Number($('videoStart').value);
      rebuildFrames();
    });
    $('videoLength').addEventListener('change', () => {
      frameSession.length = Number($('videoLength').value);
      rebuildFrames();
    });

    const nudge = (dx, dy, ds) => () => {
      const a = selectedAdj();
      a.x = Math.round((a.x + dx) * 1000) / 1000;
      a.y = Math.round((a.y + dy) * 1000) / 1000;
      a.s = Math.max(0.5, Math.min(1.5, Math.round((a.s + ds) * 100) / 100));
      changed();
    };
    $('frameLeft').addEventListener('click', nudge(-0.01, 0, 0));
    $('frameRight').addEventListener('click', nudge(0.01, 0, 0));
    $('frameUp').addEventListener('click', nudge(0, -0.01, 0));
    $('frameDown').addEventListener('click', nudge(0, 0.01, 0));
    $('frameBigger').addEventListener('click', nudge(0, 0, 0.02));
    $('frameSmaller').addEventListener('click', nudge(0, 0, -0.02));
    const move = (dir) => () => {
      const st = current();
      const j = frameSel + dir;
      if (j < 0 || j >= st.frameImages.length) return;
      for (const arr of [st.frameImages, st.frameAdj]) [arr[frameSel], arr[j]] = [arr[j], arr[frameSel]];
      frameSel = j;
      changed();
    };
    $('frameEarlier').addEventListener('click', move(-1));
    $('frameLater').addEventListener('click', move(1));
    $('frameDelete').addEventListener('click', () => {
      const st = current();
      if (st.frameImages.length <= 2) {
        setStatus('コマは2枚以上必要です', true);
        return;
      }
      st.frameImages.splice(frameSel, 1);
      st.frameAdj.splice(frameSel, 1);
      st.frames = frameCountFor(st.frameImages.length);
      frameSel = Math.max(0, frameSel - 1);
      changed();
    });
  }

  // Words the app can't turn into a motion: offer to have an image AI draw it as frames.
  function offerAi(resultEl, words) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'btn small ai-offer';
    b.textContent = 'この動きをAIにコマ絵で描いてもらう';
    b.addEventListener('click', () => {
      current().uiMode = 'frames';
      $('aiAction').value = words;
      $('aiAction').dispatchEvent(new Event('input'));
      showTab('image');
      changed();
      $('aiBox').scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    resultEl.append(' ', b);
  }

  // ---------- rendering ----------
  function stillT(st) {
    if (st.motion === 'typing') return 0.85;
    if (st.motion === 'spin') return 0;
    return 0.5;
  }

  const isFrames = (st) => st.mode === 'frames' && st.frameImages.length > 0;
  // Which drawn frame shows at time t: the frames share the loop equally.
  const frameIndex = (st, t) => Math.min(st.frameImages.length - 1, Math.floor(t * st.frameImages.length + 1e-9));
  // The picture that decides the sticker's layout (all frames are the same size).
  const layoutImage = (st) => getImage(isFrames(st) ? st.frameImages[0] : st.image);

  // `pad` leaves room around the sticker (as a fraction of its size) for export, where
  // motion that leaves the 320×270 box has to be kept.
  function renderSticker(canvas, st, t, w = W, h = H, pad = 0) {
    const ctx = canvas.getContext('2d');
    const sx = canvas.width / (w * (1 + 2 * pad));
    const sy = canvas.height / (h * (1 + 2 * pad));
    ctx.setTransform(sx, 0, 0, sy, pad * w * sx, pad * h * sy);
    if (isFrames(st)) {
      const i = frameIndex(st, t);
      drawFrame(ctx, st, t, w, h, getImage(st.frameImages[i]) || layoutImage(st), { adjust: st.frameAdj[i] || {} });
      return;
    }
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
    document.body.classList.toggle('is-empty', state.stickers.every(isBlank));
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
  const fields = ['text', 'font', 'fontSize', 'color', 'strokeColor', 'strokeWidth', 'textCurve', 'textRotate', 'imageScale', 'effectColor', 'frames', 'duration', 'loops'];
  const numeric = new Set(['fontSize', 'strokeWidth', 'textCurve', 'textRotate', 'imageScale', 'frames', 'duration', 'loops']);

  function buildEditor() {
    $('font').innerHTML = FONTS.map((f) => `<option value="${f.id}">${f.label}</option>`).join('');
    // Whole-body motions are picked with one tap. The worded motion from 言葉でおまかせ
    // ("custom") has no sliders of its own; its chip only appears while it is in use.
    const bodyMotions = Object.fromEntries(Object.entries(MOTIONS).map(([id, m]) => [id, id === 'custom' ? { label: 'おまかせの動き' } : m]));
    buildChips($('motions'), bodyMotions, (id) => {
      current().motion = id;
      changed();
    });
    buildChips($('effects'), EFFECTS, (id) => {
      setEffect(current(), id);
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
        const others = understood.filter((u) => !u.startsWith('動き'));
        $('wishResult').textContent = (others.length ? '設定しました：' + others.join(' / ') + '。' : '') + partMsg;
        return;
      }
      const plain = $('wishText').value.trim();
      if (!understood.length && plain && plain.length <= 15) {
        // Nothing to interpret: a short line is most likely the words for the sticker.
        current().text = plain;
        $('wishResult').textContent = `「${plain}」を文字にしました`;
        changed();
        return;
      }
      if (!understood.length) {
        $('wishResult').textContent = $('wishText').value.trim()
          ? 'わかる言葉が見つかりませんでした。'
          : '作りたいスタンプを書いてね';
        if ($('wishText').value.trim()) offerAi($('wishResult'), $('wishText').value.trim());
        return;
      }
      const st = current();
      const { custom, effect, ...fields } = changes;
      if (effect) setEffect(st, effect);
      Object.assign(st, fields);
      if (custom) Object.assign(st.custom, custom, { text: '' });
      st.loops = Math.min(st.loops, Math.max(1, Math.floor(4 / st.duration)));
      $('wishResult').textContent = '設定しました：' + understood.join(' / ') + '。';
      if (custom) {
        // Keyword reading can't know every way of saying a motion.
        $('wishResult').append('思った動きと違うときは');
        offerAi($('wishResult'), $('wishText').value.replace(/[「『][^」』]*[」』]/g, '').trim());
      }
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

    $('quickFiles').addEventListener('change', (e) => {
      const files = [...e.target.files];
      e.target.value = '';
      if (files.length) quickImport(files);
    });
    $('shuffleLooks').addEventListener('click', shuffleLooks);
    let removeAllAt = 0;
    $('removeAll').addEventListener('click', (e) => {
      const btn = e.currentTarget;
      if (Date.now() - removeAllAt > 3000) {
        removeAllAt = Date.now();
        btn.textContent = 'もう一度押すと全部消えます';
        setTimeout(() => (btn.textContent = '全部消す'), 3000);
        return;
      }
      removeAllAt = 0;
      btn.textContent = '全部消す';
      state.stickers = [newSticker()];
      select(0);
      setStatus('全部消しました');
    });
    $('add').addEventListener('click', () => {
      const base = current();
      state.stickers.push(newSticker({ font: base.font, color: base.color, strokeColor: base.strokeColor, strokeWidth: base.strokeWidth }));
      select(state.stickers.length - 1);
    });
    $('duplicate').addEventListener('click', () => {
      const copy = { ...JSON.parse(JSON.stringify(current())) };
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
      if (id === 'wink') {
        current().parts[partSel].pivot = polyCenter(current().parts[partSel].poly);
        Object.assign(current().parts[partSel].cfg, { amount: 100, speed: 1 });
      }
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

    wireFrames();
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

    // Drag the text or the picture around on the big preview.
    const pv = $('preview');
    const toSticker = (e) => {
      const r = pv.getBoundingClientRect();
      return [((e.clientX - r.left) / r.width) * W - W / 2, ((e.clientY - r.top) / r.height) * H - H / 2];
    };
    const hitAt = (pt) => {
      const st = current();
      const ctx = pv.getContext('2d');
      ctx.save();
      const lay = layoutSticker(ctx, st, W, H, layoutImage(st));
      ctx.restore();
      const pad = 8;
      const b = lay.textBox;
      if (b && Math.abs(pt[0] - b.cx) <= b.w / 2 + pad && Math.abs(pt[1] - b.cy) <= b.h / 2 + pad) return 'textPos';
      const im = lay.image;
      if (im && pt[0] >= im.x - pad && pt[0] <= im.x + im.w + pad && pt[1] >= im.y - pad && pt[1] <= im.y + im.h + pad) return 'imagePos';
      return null;
    };
    let drag = null;
    pv.addEventListener('pointerdown', (e) => {
      const pt = toSticker(e);
      const what = hitAt(pt);
      if (!what) return;
      drag = { what, from: pt, start: [...(current()[what] || [0, 0])] };
      pv.setPointerCapture(e.pointerId);
      pv.style.cursor = 'grabbing';
      e.preventDefault();
    });
    pv.addEventListener('pointermove', (e) => {
      const pt = toSticker(e);
      if (!drag) {
        pv.style.cursor = hitAt(pt) ? 'grab' : '';
        return;
      }
      const clamp = (v) => Math.max(-0.5, Math.min(0.5, v));
      // Only the preview redraws while dragging; the rest updates on release.
      current()[drag.what] = [clamp(drag.start[0] + (pt[0] - drag.from[0]) / W), clamp(drag.start[1] + (pt[1] - drag.from[1]) / H)];
    });
    const endDrag = () => {
      if (!drag) return;
      drag = null;
      pv.style.cursor = '';
      changed();
    };
    pv.addEventListener('pointerup', endDrag);
    pv.addEventListener('pointercancel', endDrag);
    $('resetLayout').addEventListener('click', () => {
      Object.assign(current(), { textPos: [0, 0], imagePos: [0, 0], textCurve: 0, textRotate: 0 });
      changed();
    });

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
    for (const [container, val] of [[$('motions'), st.motion], [$('effects'), st.effect]]) {
      container.querySelectorAll('.chip').forEach((c) => c.setAttribute('aria-checked', String(c.dataset.value === val)));
    }
    $('clearImage').disabled = !st.image;
    $('specFrames').textContent = `${st.frames}コマ`;
    $('specTime').textContent = `${st.duration}秒 × ${st.loops}回`;
    updateSize(st);

    $('motions').querySelector('[data-value="custom"]').hidden = st.motion !== 'custom';

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
    syncFrames();
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
      el.textContent = `${(bytes / 1024).toFixed(0)} KB` + (apng.reduced ? `（${apng.reduced}）` : '');
      el.className = bytes > MAX_BYTES ? 'warn' : '';
      el.title = bytes > MAX_BYTES ? '300KBを超えています。コマ数を減らすか、画像を小さくしてください' : '';
    }, 400);
  }

  function select(i) {
    state.selected = i;
    frameSession = null;
    frameSel = 0;
    partSel = 0;
    partMode = 'idle';
    pendingParts = [];
    stroke = null;
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
  // LINE rejects stickers cut off at the edges and stickers with a still margin around
  // the drawing. So each frame is drawn with room around it (a bounce can leave the
  // 320×270 box), cropped to the area any frame uses, and scaled to the output:
  // `contain` keeps the given w × h (main.png, tab.png) and centers the drawing in it;
  // otherwise the output is as large as fits in w × h (lineStickerSize()).
  const EXPORT_ROOM = 0.3;
  const EXPORT_RES = 2;
  async function renderFitted(st, w, h, ts, contain) {
    const big = document.createElement('canvas');
    big.width = Math.round(w * (1 + 2 * EXPORT_ROOM) * EXPORT_RES);
    big.height = Math.round(h * (1 + 2 * EXPORT_ROOM) * EXPORT_RES);
    const bctx = big.getContext('2d', { willReadFrequently: true });
    const draw = (t) => {
      bctx.setTransform(1, 0, 0, 1, 0, 0);
      bctx.clearRect(0, 0, big.width, big.height);
      renderSticker(big, st, t, w, h, EXPORT_ROOM);
    };
    let box = null;
    for (const t of ts) {
      draw(t);
      const b = boundingBox(bctx.getImageData(0, 0, big.width, big.height).data, big.width, big.height);
      if (!b) continue;
      box = box
        ? { x: Math.min(box.x, b.x), y: Math.min(box.y, b.y), r: Math.max(box.r, b.x + b.w), b: Math.max(box.b, b.y + b.h) }
        : { x: b.x, y: b.y, r: b.x + b.w, b: b.y + b.h };
    }
    if (!box) {
      const x = EXPORT_ROOM * w * EXPORT_RES;
      const y = EXPORT_ROOM * h * EXPORT_RES;
      box = { x, y, r: x + w * EXPORT_RES, b: y + h * EXPORT_RES };
    }
    const sw = box.r - box.x;
    const sh = box.b - box.y;
    let ow = w;
    let oh = h;
    let dx = 0;
    let dy = 0;
    let dw;
    let dh;
    if (contain) {
      const s = Math.min(w / sw, h / sh);
      dw = sw * s;
      dh = sh * s;
      dx = (w - dw) / 2;
      dy = (h - dh) / 2;
    } else {
      ({ w: ow, h: oh } = lineStickerSize(sw / EXPORT_RES, sh / EXPORT_RES, w, h));
      dw = ow;
      dh = oh;
    }
    const out = document.createElement('canvas');
    out.width = ow;
    out.height = oh;
    const octx = out.getContext('2d', { willReadFrequently: true });
    octx.imageSmoothingQuality = 'high';
    const pngs = [];
    const pixels = [];
    for (const t of ts) {
      draw(t);
      octx.clearRect(0, 0, ow, oh);
      octx.drawImage(big, box.x, box.y, sw, sh, dx, dy, dw, dh);
      pngs.push(await canvasToPNG(out));
      pixels.push(octx.getImageData(0, 0, ow, oh).data);
    }
    return { pngs, pixels, w: ow, h: oh };
  }

  async function buildAPNG(st, w, h, contain = false) {
    const times = (n) => [...Array(n).keys()].map((i) => i / n);
    let r = await renderFitted(st, w, h, times(st.frames), contain);
    // delay per frame = duration / frames seconds, so one loop lasts exactly `duration` seconds.
    const optsFor = (frames) => ({ delayNum: st.duration, delayDen: frames, plays: st.loops });
    const lossless = assembleAPNG(r.pngs, optsFor(st.frames));
    if (lossless.length <= MAX_BYTES || typeof CompressionStream === 'undefined') return lossless;

    // Photos can stay over 300 KB even at 256 colors: use fewer colors, then fewer frames.
    let best = lossless;
    for (const frames of new Set([st.frames, Math.max(5, Math.min(st.frames, 8))])) {
      if (frames !== st.frames) r = await renderFitted(st, w, h, times(frames), contain);
      for (const colors of [256, 128, 64]) {
        const { palette, indices } = quantize(r.pixels, colors);
        const indexed = [];
        for (const idx of indices) indexed.push(await encodeIndexedPNG(r.w, r.h, idx, palette, deflate));
        const small = assembleAPNG(indexed, optsFor(frames));
        small.reduced = frames === st.frames ? `${colors}色` : `${colors}色・${frames}コマ`;
        if (small.length < best.length) best = small;
        if (small.length <= MAX_BYTES) return small;
      }
    }
    return best;
  }
  async function buildStill(st, w, h) {
    return (await renderFitted(st, w, h, [stillT(st)], true)).pngs[0];
  }


  // Inside a claude.ai Artifact, plain downloads are blocked; use its downloads capability there.
  // That capability only works for members of the owner's organization, so everyone else is
  // pointed to the same app on its public page, where an ordinary download works.
  const PUBLIC_URL = 'https://leoleoyky-spec.github.io/time-flow/';
  const inArtifact = !!(window.claude && typeof window.claude.use === 'function');
  const artifactDownloads = inArtifact ? window.claude.use('downloads').catch(() => null) : Promise.resolve(null);

  // Resolves 'saved', 'declined', or 'blocked' (this page can't save files for this viewer).
  async function download(bytes, name, type) {
    if (inArtifact) {
      const downloads = await artifactDownloads;
      if (!downloads) return 'blocked';
      try {
        await downloads.save({ filename: name, data: new Blob([bytes], { type }) });
        return 'saved';
      } catch (err) {
        return err && err.code === 'declined' ? 'declined' : 'blocked';
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
    return 'saved';
  }

  function notSaved(result) {
    if (result === 'saved') return false;
    if (result === 'blocked') {
      setStatus('このページからは保存できませんでした。下のページで同じアプリを開くと保存できます：', true, PUBLIC_URL);
    } else {
      setStatus('保存をキャンセルしました' + (inArtifact ? '。保存できないときは、こちらのページを使ってください：' : ''), false, inArtifact ? PUBLIC_URL : null);
    }
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
      if (notSaved(await download(bytes, `${num}.png`, 'image/png'))) return;
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
        { name: 'main.png', data: await buildAPNG(first, 240, 240, true) },
        { name: 'tab.png', data: await buildStill(first, 96, 74) }
      );
      if (notSaved(await download(createZip(files), 'line_animation_stickers.zip', 'application/zip'))) return;

      const notes = [];
      if (oversized.length) notes.push(`300KB超え：${oversized.join(', ')}`);
      if (!VALID_COUNTS.includes(state.stickers.length)) notes.push('申請には 8 / 16 / 24 個が必要です');
      setStatus(`ZIPを保存しました（${files.length}ファイル）` + (notes.length ? ' ⚠ ' + notes.join(' / ') : ''), notes.length > 0);
    });
  }

  function setStatus(msg, warn, link) {
    const el = $('status');
    el.textContent = msg;
    el.style.color = warn ? 'var(--danger)' : '';
    if (link) {
      const a = document.createElement('a');
      a.href = link;
      a.target = '_blank';
      a.rel = 'noopener';
      a.textContent = link;
      el.append(' ', a);
    }
  }

  // ---------- boot ----------
  buildEditor();
  syncEditor();
  resolveImages(state).then(() => {
    state.stickers = state.stickers.map((x) => newSticker(x));
    changed();
  });
  renderList();
  requestAnimationFrame(tick);
  Promise.all(FONTS.map((f) => ensureFont(f.id))).then(() => updateSize(current()));
})();

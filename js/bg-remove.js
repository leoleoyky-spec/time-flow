// Background removal on raw RGBA pixels. Works in the browser (window.BgRemove) and in Node.
(function (root) {
  'use strict';

  // Square-window erosion/dilation of a 0/1 mask, done as two 1-D passes.
  function morph(mask, w, h, r, erode) {
    const tmp = new Uint8Array(w * h);
    const out = new Uint8Array(w * h);
    const keep = erode ? 1 : 0; // erode: stay 1 only if every neighbour is 1; dilate: 1 if any is
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let v = keep;
        for (let k = -r; k <= r; k++) {
          const nx = x + k;
          const m = nx < 0 || nx >= w ? keep : mask[y * w + nx];
          if (m !== keep) { v = 1 - keep; break; }
        }
        tmp[y * w + x] = v;
      }
    }
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let v = keep;
        for (let k = -r; k <= r; k++) {
          const ny = y + k;
          const m = ny < 0 || ny >= h ? keep : tmp[ny * w + x];
          if (m !== keep) { v = 1 - keep; break; }
        }
        out[y * w + x] = v;
      }
    }
    return out;
  }

  function opaqueCornerColor(d, w, h) {
    const pts = [[0, 0], [w - 1, 0], [0, h - 1], [w - 1, h - 1]];
    const cols = [];
    for (const [x, y] of pts) {
      const i = (y * w + x) * 4;
      if (d[i + 3] > 200) cols.push([d[i], d[i + 1], d[i + 2]]);
    }
    if (!cols.length) return null;
    return cols.reduce((s, c) => s.map((v, i) => v + c[i] / cols.length), [0, 0, 0]);
  }

  /**
   * Make a flat background transparent, in place.
   * Pixels close to the background color are candidates; the candidate area is eroded
   * before flood-filling from the edges, so the fill can't squeeze through the small
   * gaps a crayon or pencil outline leaves and eat the inside of the drawing.
   * @param {Uint8ClampedArray|Uint8Array} d  RGBA pixels (modified)
   * @param {{tolerance:number, color?:number[]|null, radius?:number}} opts  tolerance 0–100
   * @returns {{alreadyTransparent:boolean, removed:number}}
   */
  function removeBackgroundPixels(d, w, h, opts) {
    const target = opts.color || opaqueCornerColor(d, w, h);
    if (!target) return { alreadyTransparent: true, removed: 0 };
    const thresh = opts.tolerance * 2.55;
    const n = w * h;

    const cand = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      const o = i * 4;
      if (d[o + 3] < 20) { cand[i] = 1; continue; }
      const dr = d[o] - target[0];
      const dg = d[o + 1] - target[1];
      const db = d[o + 2] - target[2];
      cand[i] = dr * dr + dg * dg + db * db <= thresh * thresh ? 1 : 0;
    }

    // Gaps narrower than about 2r+1 px get sealed. Scale with the image so a
    // 640px upload and a 300px one behave the same.
    const r = opts.radius !== undefined ? opts.radius : Math.max(1, Math.round(Math.min(w, h) / 250));
    const core = morph(cand, w, h, r, true);

    const fill = new Uint8Array(n);
    const stack = [];
    const seed = (i) => {
      if (core[i] && !fill[i]) { fill[i] = 1; stack.push(i); }
    };
    for (let x = 0; x < w; x++) { seed(x); seed((h - 1) * w + x); }
    for (let y = 0; y < h; y++) { seed(y * w); seed(y * w + w - 1); }
    while (stack.length) {
      const i = stack.pop();
      const x = i % w;
      if (x > 0) seed(i - 1);
      if (x < w - 1) seed(i + 1);
      if (i >= w) seed(i - w);
      if (i < n - w) seed(i + w);
    }

    // Grow back to the drawing's edge, but only over background-colored pixels.
    const grown = morph(fill, w, h, r + 1, false);
    let removed = 0;
    for (let i = 0; i < n; i++) {
      if (grown[i] && cand[i]) {
        if (d[i * 4 + 3] >= 20) removed++;
        d[i * 4 + 3] = 0;
      }
    }
    featherAlpha(d, w, h);
    return { alreadyTransparent: false, removed };
  }

  // Soften the cut edge by lightly blurring alpha only.
  function featherAlpha(d, w, h) {
    const alpha = new Uint8Array(w * h);
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

  const api = { removeBackgroundPixels };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.BgRemove = api;
})(typeof window !== 'undefined' ? window : globalThis);

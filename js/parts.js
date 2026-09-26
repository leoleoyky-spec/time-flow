// Moving one part of a picture (a hand, an ear) separately from the rest.
// The user traces the part; we cut it out, fill the hole it leaves in the base
// picture, and guess the joint it swings around. Works in the browser
// (window.Parts) and in Node (module.exports) on raw RGBA pixels.
(function (root) {
  'use strict';

  /**
   * Fill the masked pixels of `d` from their surroundings, layer by layer inward,
   * so that when the part moves away there is body color behind it, not a hole.
   * Transparent surroundings stay transparent (a hand sticking out over nothing).
   * @param {Uint8ClampedArray|Uint8Array} d  RGBA pixels (modified)
   * @param {Uint8Array} mask  1 = pixel to fill
   */
  function inpaint(d, w, h, mask) {
    const n = w * h;
    const known = new Uint8Array(n);
    for (let i = 0; i < n; i++) known[i] = mask[i] ? 0 : 1;
    let frontier = [];
    const isFrontier = (i) => {
      const x = i % w;
      return (x > 0 && known[i - 1]) || (x < w - 1 && known[i + 1]) || (i >= w && known[i - w]) || (i < n - w && known[i + w]);
    };
    for (let i = 0; i < n; i++) if (!known[i] && isFrontier(i)) frontier.push(i);
    while (frontier.length) {
      const filled = [];
      for (const i of frontier) {
        const x = i % w;
        let r = 0, g = 0, b = 0, a = 0, cnt = 0;
        const add = (j) => {
          if (!known[j]) return;
          const o = j * 4;
          const al = d[o + 3];
          r += d[o] * al; g += d[o + 1] * al; b += d[o + 2] * al; a += al; cnt++;
        };
        if (x > 0) add(i - 1);
        if (x < w - 1) add(i + 1);
        if (i >= w) add(i - w);
        if (i < n - w) add(i + w);
        if (x > 0 && i >= w) add(i - w - 1);
        if (x < w - 1 && i >= w) add(i - w + 1);
        if (x > 0 && i < n - w) add(i + w - 1);
        if (x < w - 1 && i < n - w) add(i + w + 1);
        const o = i * 4;
        if (a > 0) {
          d[o] = r / a; d[o + 1] = g / a; d[o + 2] = b / a;
        }
        d[o + 3] = cnt ? a / cnt : 0;
        filled.push(i);
      }
      for (const i of filled) known[i] = 1;
      const next = [];
      const seen = new Uint8Array(n);
      for (const i of filled) {
        const x = i % w;
        for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, i - w, i + w]) {
          if (j >= 0 && j < n && !known[j] && !seen[j]) { seen[j] = 1; next.push(j); }
        }
      }
      frontier = next;
    }
  }

  /**
   * Guess the joint a traced part swings around. Where the traced outline cuts
   * through the drawing (the picture continues just outside it) is where the part
   * is attached, like a wrist; the joint is the middle of that stretch. If the
   * part doesn't touch anything, fall back to the point nearest the picture's middle.
   * @param {number[][]} poly  outline as [x, y] in 0–1 image coordinates
   * @param {Uint8ClampedArray|Uint8Array} d  RGBA pixels of the whole picture
   * @param {Uint8Array} mask  1 = inside the traced part
   * @returns {number[]} [x, y] in 0–1 image coordinates
   */
  function guessPivot(poly, d, w, h, mask) {
    const cx0 = poly.reduce((s, p) => s + p[0], 0) / poly.length;
    const cy0 = poly.reduce((s, p) => s + p[1], 0) / poly.length;
    const opaqueOutside = (x, y) => {
      const px = Math.round(x * (w - 1));
      const py = Math.round(y * (h - 1));
      if (px < 0 || py < 0 || px >= w || py >= h) return false;
      const i = py * w + px;
      return !mask[i] && d[i * 4 + 3] > 128;
    };
    const cuts = [];
    for (const [x, y] of poly) {
      const dx = x - cx0;
      const dy = y - cy0;
      const len = Math.hypot(dx, dy) || 1;
      const step = 0.03; // look a little outside the outline
      if (opaqueOutside(x + (dx / len) * step, y + (dy / len) * step)) cuts.push([x, y]);
    }
    let tx;
    let ty;
    if (cuts.length >= 3) {
      tx = cuts.reduce((s, p) => s + p[0], 0) / cuts.length;
      ty = cuts.reduce((s, p) => s + p[1], 0) / cuts.length;
    } else {
      let sx = 0, sy = 0, cnt = 0;
      for (let y = 0; y < h; y += 2) {
        for (let x = 0; x < w; x += 2) {
          const i = y * w + x;
          if (mask[i] || d[i * 4 + 3] < 128) continue;
          sx += x; sy += y; cnt++;
        }
      }
      tx = cnt ? sx / cnt / w : 0.5;
      ty = cnt ? sy / cnt / h : 0.5;
    }
    let best = poly[0];
    let bd = Infinity;
    for (const p of poly) {
      const dd = (p[0] - tx) ** 2 + (p[1] - ty) ** 2;
      if (dd < bd) { bd = dd; best = p; }
    }
    return [best[0], best[1]];
  }

  const PART_MOTIONS = {
    wave: { label: '手をふる（左右にふる）' },
    updown: { label: '上下にうごく' },
    side: { label: '左右にうごく' },
    shake: { label: 'ぶるぶる' },
  };

  const api = { inpaint, guessPivot, PART_MOTIONS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Parts = api;
})(typeof window !== 'undefined' ? window : globalThis);

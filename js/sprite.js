// Turning frame art into animation frames: splitting a sprite sheet (several poses
// drawn in a grid on one picture), steadying the jitter between AI-drawn frames, and
// thinning long sequences down to LINE's 20-frame limit. Works on raw RGBA pixels in
// the browser (window.Sprite) and in Node (module.exports).
(function (root) {
  'use strict';

  const ALPHA = 20; // a pixel counts as drawn above this alpha

  // The emptiest line near `center` in a 1-D profile of drawn pixels (the middle of
  // the emptiest stretch), within ±span.
  function bestCut(profile, center, span) {
    const lo = Math.max(1, Math.round(center - span));
    const hi = Math.min(profile.length - 1, Math.round(center + span));
    let min = Infinity;
    for (let i = lo; i <= hi; i++) min = Math.min(min, profile[i]);
    let first = -1, last = -1;
    for (let i = lo; i <= hi; i++) {
      if (profile[i] !== min) continue;
      if (first < 0) first = i;
      last = i;
    }
    return { at: Math.round((first + last) / 2), cost: min };
  }

  // Cuts that split `profile` into n roughly equal parts, each at the emptiest line
  // nearby. Returns null if a cut would cross the drawing or the parts come out uneven
  // (then this n is not how the sheet was laid out).
  function evenCuts(profile, n, lineLen) {
    const len = profile.length;
    const size = len / n;
    const cuts = [0];
    for (let k = 1; k < n; k++) {
      const c = bestCut(profile, k * size, size * 0.3);
      if (c.cost > lineLen * 0.01) return null;
      cuts.push(c.at);
    }
    cuts.push(len);
    const parts = cuts.slice(1).map((c, i) => c - cuts[i]);
    const mean = len / n;
    if (parts.some((p) => Math.abs(p - mean) > mean * 0.2)) return null;
    return cuts;
  }

  /**
   * Find the frames of a sprite sheet from the empty gutters between them.
   * Every grid from 1×2 up to 6×6 is tried: its dividing lines must run through
   * empty space and give evenly sized frames. A gap between the words and the
   * character inside one frame can also be empty, so among the grids that fit, the
   * one with the squarest frames wins (sheets are drawn with square-ish frames),
   * and among equally square ones, the one with the most frames.
   * Rows are cut per column, as their gaps don't always line up across columns.
   * `d` must already have a transparent background.
   * @returns {null | {cells: {x, y, w, h}[], cols: number, rows: number}}  cells in
   *   reading order; null when no grid fits (the user then picks one).
   */
  function findGrid(d, w, h) {
    const drawn = (x, y) => d[(y * w + x) * 4 + 3] > ALPHA;
    const colP = new Uint32Array(w);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (drawn(x, y)) colP[x]++;
    let best = null;
    for (let nc = 1; nc <= 6; nc++) {
      const xc = evenCuts(colP, nc, h);
      if (!xc) continue;
      const rowProfiles = xc.slice(1).map((x1, c) => {
        const p = new Uint32Array(h);
        for (let y = 0; y < h; y++) for (let x = xc[c]; x < x1; x++) if (drawn(x, y)) p[y]++;
        return p;
      });
      for (let nr = 1; nr <= 6; nr++) {
        if (nc * nr < 2) continue;
        const yc = rowProfiles.map((p, c) => evenCuts(p, nr, xc[c + 1] - xc[c]));
        if (yc.some((c) => !c)) continue;
        const squareness = Math.abs(Math.log(w / nc / (h / nr)));
        // A 2×2 split of a 4×4 sheet has the same frame shape and also fits;
        // among equally square grids the finer one is the real layout.
        const better = !best || squareness < best.squareness - 0.1 ||
          (Math.abs(squareness - best.squareness) <= 0.1 && nc * nr > best.nc * best.nr);
        if (better) best = { nc, nr, xc, yc, squareness };
      }
    }
    if (!best) return null;
    const cells = [];
    for (let r = 0; r < best.nr; r++) {
      for (let c = 0; c < best.nc; c++) {
        const y0 = best.yc[c][r];
        cells.push({ x: best.xc[c], y: y0, w: best.xc[c + 1] - best.xc[c], h: best.yc[c][r + 1] - y0 });
      }
    }
    return { cells, cols: best.nc, rows: best.nr };
  }

  // Equal-sized cells, in reading order, for a grid the user picked (or when no
  // gutters were found).
  function evenGrid(w, h, ncols, nrows) {
    const cells = [];
    for (let j = 0; j < nrows; j++) {
      for (let i = 0; i < ncols; i++) {
        const x = Math.round((i * w) / ncols);
        const y = Math.round((j * h) / nrows);
        cells.push({ x, y, w: Math.round(((i + 1) * w) / ncols) - x, h: Math.round(((j + 1) * h) / nrows) - y });
      }
    }
    return { cells, cols: ncols, rows: nrows };
  }

  function boundingBox(d, w, h) {
    let x0 = w, y0 = h, x1 = -1, y1 = -1;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (d[(y * w + x) * 4 + 3] <= ALPHA) continue;
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
    return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
  }

  function smallMask(d, w, h, scale) {
    const sw = Math.max(1, Math.round(w * scale));
    const sh = Math.max(1, Math.round(h * scale));
    const m = new Float32Array(sw * sh);
    for (let y = 0; y < sh; y++) {
      for (let x = 0; x < sw; x++) {
        const px = Math.min(w - 1, Math.floor(x / scale));
        const py = Math.min(h - 1, Math.floor(y / scale));
        m[y * sw + x] = d[(py * w + px) * 4 + 3] / 255;
      }
    }
    return { m, sw, sh };
  }

  /**
   * How far to shift each frame so the frames line up, relative to the first one.
   * AI-drawn (or hand-traced) frames never land on exactly the same spot, which makes
   * the whole character tremble; this removes that.
   *   'auto'   – slide each frame (by at most `maxShift` of the frame size) to where its
   *              shape overlaps the first frame most. Small, so a deliberate jump stays.
   *   'bottom' – line up the feet (bottom of the drawing) and the horizontal middle.
   *   'center' – line up the middles.
   *   'none'   – leave them where they were drawn.
   * @param {{d, w, h}[]} frames  same-sized RGBA frames
   * @returns {number[][]} [dx, dy] in pixels per frame
   */
  function alignFrames(frames, mode = 'auto', maxShift = 0.05) {
    if (mode === 'none' || !frames.length) return frames.map(() => [0, 0]);
    if (mode === 'bottom' || mode === 'center') {
      const boxes = frames.map((f) => boundingBox(f.d, f.w, f.h));
      const ref = boxes.find(Boolean);
      if (!ref) return frames.map(() => [0, 0]);
      return boxes.map((b) => {
        if (!b) return [0, 0];
        const dx = Math.round(ref.x + ref.w / 2 - (b.x + b.w / 2));
        const dy = mode === 'bottom' ? ref.y + ref.h - (b.y + b.h) : Math.round(ref.y + ref.h / 2 - (b.y + b.h / 2));
        return [dx, dy];
      });
    }
    const { w, h } = frames[0];
    // Search coarsely on small copies, then refine on bigger ones around that answer.
    const search = (scale, range, around, refMask) => (f) => {
      const cur = smallMask(f.d, f.w, f.h, scale);
      let best = around;
      let bestScore = -1;
      for (let dy = around[1] - range; dy <= around[1] + range; dy++) {
        for (let dx = around[0] - range; dx <= around[0] + range; dx++) {
          let score = 0;
          for (let y = 0; y < refMask.sh; y++) {
            const sy = y - dy;
            if (sy < 0 || sy >= cur.sh) continue;
            for (let x = 0; x < refMask.sw; x++) {
              const sx = x - dx;
              if (sx < 0 || sx >= cur.sw) continue;
              score += Math.min(refMask.m[y * refMask.sw + x], cur.m[sy * cur.sw + sx]);
            }
          }
          // Prefer the smaller shift when shapes overlap equally well.
          const tie = Math.abs(score - bestScore) <= 1e-6 && Math.abs(dx) + Math.abs(dy) < Math.abs(best[0]) + Math.abs(best[1]);
          if (score > bestScore + 1e-6 || tie) {
            bestScore = score;
            best = [dx, dy];
          }
        }
      }
      return best;
    };
    const coarse = Math.min(1, 96 / Math.max(w, h));
    const fine = Math.min(1, 192 / Math.max(w, h));
    const refC = smallMask(frames[0].d, w, h, coarse);
    const refF = smallMask(frames[0].d, w, h, fine);
    const range = Math.max(1, Math.round(Math.max(refC.sw, refC.sh) * maxShift));
    return frames.map((f, n) => {
      if (n === 0) return [0, 0];
      const c = search(coarse, range, [0, 0], refC)(f);
      const k = fine / coarse;
      const r = search(fine, Math.ceil(k), [Math.round(c[0] * k), Math.round(c[1] * k)], refF)(f);
      // Never move further than maxShift, so a deliberate jump or step survives.
      const limit = maxShift * Math.max(w, h);
      const clamp = (v) => Math.max(-limit, Math.min(limit, Math.round(v / fine)));
      return [clamp(r[0]), clamp(r[1])];
    });
  }

  /** Pick `max` evenly spread indices out of `n` (all of them when n <= max). */
  function thinFrames(n, max = 20) {
    if (n <= max) return [...Array(n).keys()];
    return [...Array(max).keys()].map((i) => Math.floor((i * n) / max));
  }

  /**
   * How many APNG frames to write for `n` drawn frames: LINE needs 5–20, so a short
   * cycle is repeated (4 poses → 8 frames) and each pose keeps equal time.
   */
  function frameCountFor(n) {
    if (n >= 5) return Math.min(20, n);
    return n * Math.ceil(5 / Math.max(1, n));
  }

  /**
   * Where each sticker is on a picture that may hold a whole set (like a 4×4 sheet of
   * different stickers): the drawn area of each grid cell, empty cells left out.
   * Fewer than 4 cells is taken as one sticker, as a character with its words below
   * can also leave an empty band across the middle.
   * `d` must already have a transparent background.
   * @returns {{x, y, w, h}[]}  in reading order
   */
  function findStickers(d, w, h) {
    const grid = findGrid(d, w, h);
    const cells = grid && grid.cells.length >= 4 ? grid.cells : [{ x: 0, y: 0, w, h }];
    const out = [];
    for (const c of cells) {
      const sub = new Uint8Array(c.w * c.h * 4);
      for (let y = 0; y < c.h; y++) sub.set(d.subarray(((c.y + y) * w + c.x) * 4, ((c.y + y) * w + c.x + c.w) * 4), y * c.w * 4);
      const b = boundingBox(sub, c.w, c.h);
      // A few stray pixels (a leftover speck of background) are not a sticker.
      if (!b || b.w * b.h < c.w * c.h * 0.01) continue;
      const pad = Math.round(Math.max(b.w, b.h) * 0.02);
      const x0 = Math.max(0, b.x - pad);
      const y0 = Math.max(0, b.y - pad);
      out.push({ x: c.x + x0, y: c.y + y0, w: Math.min(c.w, b.x + b.w + pad) - x0, h: Math.min(c.h, b.y + b.h + pad) - y0 });
    }
    return out;
  }

  const api = { findGrid, findStickers, evenGrid, boundingBox, alignFrames, thinFrames, frameCountFor };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Sprite = api;
})(typeof window !== 'undefined' ? window : globalThis);

// Moving one part of a picture (a hand, an ear) separately from the rest.
// The user traces the part. Instead of cutting it out (which leaves the old hand
// behind and a seam at the wrist), the picture is bent like rubber: a mesh laid
// over it moves fully inside the traced outline and less and less just outside it,
// so the wrist and the body next to it stretch along. Works in the browser
// (window.Parts) and in Node (module.exports).
(function (root) {
  'use strict';

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

  function pointInPoly(x, y, poly) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [xi, yi] = poly[i];
      const [xj, yj] = poly[j];
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }

  function distToPoly(x, y, poly) {
    let best = Infinity;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [ax, ay] = poly[j];
      const [bx, by] = poly[i];
      const dx = bx - ax;
      const dy = by - ay;
      const len2 = dx * dx + dy * dy || 1;
      const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / len2));
      best = Math.min(best, Math.hypot(x - ax - t * dx, y - ay - t * dy));
    }
    return best;
  }

  /**
   * How much a point follows the part: 1 inside the traced outline, easing to 0
   * at `falloff` pixels outside it. `poly` is in pixels.
   */
  function partWeight(x, y, poly, falloff) {
    if (pointInPoly(x, y, poly)) return 1;
    const d = distToPoly(x, y, poly);
    if (d >= falloff) return 0;
    const t = 1 - d / falloff;
    return t * t * (3 - 2 * t);
  }

  function shakeWave(phase) {
    return Math.sin(phase) * 0.6 + Math.sin(phase * 2.7 + 1) * 0.3 + Math.sin(phase * 5.3 + 2) * 0.1;
  }

  /**
   * A part's motion at time t (0–1): rotation in radians around its joint, and a
   * shift as a fraction of the picture's height.
   */
  function partTransform(cfg, t) {
    const amount = (cfg.amount || 0) / 100;
    const phase = t * Math.PI * 2 * (cfg.speed || 1);
    if (cfg.type === 'updown') return { rot: 0, dx: 0, dy: -Math.abs(Math.sin(phase)) * amount * 0.12 };
    if (cfg.type === 'side') return { rot: 0, dx: Math.sin(phase) * amount * 0.1, dy: 0 };
    if (cfg.type === 'shake') return { rot: shakeWave(phase * 3) * amount * 0.15, dx: 0, dy: 0 };
    return { rot: Math.sin(phase) * amount * 0.6, dx: 0, dy: 0 }; // wave: up to about ±35°
  }

  /**
   * Lay a grid over a w×h picture and work out how strongly each grid point follows
   * each part. Only cells touched by some part need to be bent when drawing.
   * @param {{poly:number[][], pivot:number[]}[]} parts  in 0–1 picture coordinates
   */
  function buildMesh(w, h, parts, opts = {}) {
    const cell = Math.max(w, h) / (opts.cells || 32);
    const cols = Math.ceil(w / cell);
    const rows = Math.ceil(h / cell);
    const falloff = (opts.falloff || 0.1) * Math.max(w, h);
    const xs = new Float32Array((cols + 1) * (rows + 1));
    const ys = new Float32Array((cols + 1) * (rows + 1));
    for (let j = 0; j <= rows; j++) {
      for (let i = 0; i <= cols; i++) {
        xs[j * (cols + 1) + i] = Math.min(i * cell, w);
        ys[j * (cols + 1) + i] = Math.min(j * cell, h);
      }
    }
    const weights = parts.map((p) => {
      const poly = p.poly.map(([x, y]) => [x * w, y * h]);
      const pxs = poly.map((q) => q[0]);
      const pys = poly.map((q) => q[1]);
      const size = Math.max(Math.max(...pxs) - Math.min(...pxs), Math.max(...pys) - Math.min(...pys)) || 1;
      const jx = p.pivot[0] * w;
      const jy = p.pivot[1] * h;
      const out = new Float32Array(xs.length);
      for (let k = 0; k < xs.length; k++) {
        // Stretch generously around the joint (the wrist bends), but only a little
        // near the far end, so drawings next to the fingertips aren't dragged along.
        const near = Math.max(0.25, 1 - Math.hypot(xs[k] - jx, ys[k] - jy) / size);
        out[k] = partWeight(xs[k], ys[k], poly, falloff * near);
      }
      return out;
    });
    const cells = [];
    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < cols; i++) {
        const v = [j * (cols + 1) + i, j * (cols + 1) + i + 1, (j + 1) * (cols + 1) + i, (j + 1) * (cols + 1) + i + 1];
        if (weights.some((wt) => v.some((k) => wt[k] > 0))) cells.push(i, j);
      }
    }
    return { w, h, cols, rows, cell, xs, ys, weights, cells };
  }

  /**
   * Where grid point k ends up at time t. Each part rotates/shifts the point around
   * its joint in proportion to the point's weight; the moves of several parts add up.
   */
  function deformVertex(mesh, k, parts, t) {
    const x = mesh.xs[k];
    const y = mesh.ys[k];
    let nx = x;
    let ny = y;
    parts.forEach((p, n) => {
      const wt = mesh.weights[n][k];
      if (!wt) return;
      const tr = partTransform(p.cfg, t);
      const px = p.pivot[0] * mesh.w;
      const py = p.pivot[1] * mesh.h;
      const a = tr.rot * wt;
      const c = Math.cos(a);
      const s = Math.sin(a);
      nx += px + (x - px) * c - (y - py) * s - x + tr.dx * wt * mesh.h;
      ny += py + (x - px) * s + (y - py) * c - y + tr.dy * wt * mesh.h;
    });
    return [nx, ny];
  }

  const PART_MOTIONS = {
    wave: { label: '手をふる（左右にふる）' },
    updown: { label: '上下にうごく' },
    side: { label: '左右にうごく' },
    shake: { label: 'ぶるぶる' },
  };

  const api = { guessPivot, partWeight, partTransform, buildMesh, deformVertex, PART_MOTIONS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Parts = api;
})(typeof window !== 'undefined' ? window : globalThis);

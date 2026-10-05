#!/usr/bin/env python3
"""イラスト一覧画像 (4x4 など) を切り分けて、派手に動くLINEスタンプにする.

    python sheet_to_stamps.py panda/sheet.webp --grid 4x4 --config panda/motions.csv -o panda/output

1. 一覧画像をマス目で切り分ける
2. 白背景を透過にして、白フチを付ける（キャラの顔の白は残す）
3. 「文字」と「キャラ」を別レイヤーに分ける
4. キャラ・文字それぞれに動きを付け、集中線・キラキラ・紙吹雪などのエフェクトを重ねる
5. make_stamps.py の仕組みで APNG / メイン画像 / タブ画像 / ZIP を作り、仕様チェックする
"""

from __future__ import annotations

import argparse
import csv
import math
import random
import sys
from collections import deque
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw, ImageFilter

import make_stamps as ms

W, H = ms.STAMP_MAX_W, ms.STAMP_MAX_H
S = 2  # 2倍で合成してから縮小する

YELLOW = (255, 212, 60, 255)
PINK = (255, 120, 150, 255)
RED = (240, 70, 70, 255)
BLUE = (100, 175, 240, 255)
GREEN = (120, 205, 120, 255)
WHITE = (255, 255, 255, 255)


# ---- 切り抜き ---------------------------------------------------------------

def _components(mask):
    """連結成分 (ピクセル座標リスト) の一覧."""
    w, h = mask.size
    px = mask.load()
    seen = bytearray(w * h)
    comps = []
    for y in range(h):
        for x in range(w):
            if px[x, y] and not seen[y * w + x]:
                comp, q = [], deque([(x, y)])
                seen[y * w + x] = 1
                while q:
                    cx, cy = q.popleft()
                    comp.append((cx, cy))
                    for nx, ny in ((cx + 1, cy), (cx - 1, cy), (cx, cy + 1), (cx, cy - 1)):
                        if 0 <= nx < w and 0 <= ny < h and px[nx, ny] and not seen[ny * w + nx]:
                            seen[ny * w + nx] = 1
                            q.append((nx, ny))
                comps.append(comp)
    return comps


def _hull(points, size):
    pts = sorted(set(points))
    out = Image.new("L", size, 0)
    if len(pts) < 3:
        return out

    def cross(o, a, b):
        return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
    lower, upper = [], []
    for p in pts:
        while len(lower) >= 2 and cross(lower[-2], lower[-1], p) <= 0:
            lower.pop()
        lower.append(p)
    for p in reversed(pts):
        while len(upper) >= 2 and cross(upper[-2], upper[-1], p) <= 0:
            upper.pop()
        upper.append(p)
    ImageDraw.Draw(out).polygon(lower[:-1] + upper[:-1], fill=255)
    return out


def _bg_distance(img):
    """各ピクセルの「背景色からの違い」(0〜255)。白・水色など背景が何色でも使える."""
    rgb = img.convert("RGB")
    w, h = rgb.size
    px = rgb.load()
    edge = [px[x, 0] for x in range(w)] + [px[x, h - 1] for x in range(w)] + \
           [px[0, y] for y in range(h)] + [px[w - 1, y] for y in range(h)]
    bg = tuple(sorted(c[i] for c in edge)[len(edge) // 2] for i in range(3))
    diffs = [ImageChops.difference(ch, Image.new("L", rgb.size, v)) for ch, v in zip(rgb.split(), bg)]
    return ImageChops.lighter(ImageChops.lighter(diffs[0], diffs[1]), diffs[2])


def _fill_holes(mask):
    pad = Image.new("L", (mask.width + 2, mask.height + 2), 0)
    pad.paste(mask, (1, 1))
    ImageDraw.floodfill(pad, (0, 0), 128)
    return pad.point(lambda v: 0 if v == 128 else 255).crop((1, 1, mask.width + 1, mask.height + 1))


def _bands(profile, n):
    """True/False の並びを、大きいすき間で n 個の帯に分ける。境界のリストを返す."""
    idx = [i for i, v in enumerate(profile) if v]
    if not idx:
        return None
    gaps, i = [], idx[0]
    while i <= idx[-1]:
        if not profile[i]:
            s = i
            while not profile[i]:
                i += 1
            gaps.append((i - s, s, i))
        i += 1
    if len(gaps) < n - 1:
        return None
    cuts = sorted((s + e) // 2 for _, s, e in sorted(gaps, reverse=True)[:n - 1])
    return [0] + cuts + [len(profile)]


def detect_cells(sheet, cols, rows):
    """イラストの並びからマス目を見つける。等間隔でない一覧画像にも対応 (見つからなければ等分)."""
    if sheet.mode == "RGBA":
        ink = sheet.getchannel("A").point(lambda v: 255 if v > 40 else 0)
    else:
        ink = _bg_distance(sheet).point(lambda v: 255 if v > 25 else 0)
    w, h = ink.size
    px = ink.load()
    row_prof = [sum(1 for x in range(0, w, 2) if px[x, y]) >= 2 for y in range(h)]
    ys = _bands(row_prof, rows)
    boxes = []
    for r in range(rows):
        y0, y1 = (ys[r], ys[r + 1]) if ys else (round(r * h / rows), round((r + 1) * h / rows))
        col_prof = [sum(1 for y in range(y0, y1, 2) if px[x, y]) >= 1 for x in range(w)]
        xs = _bands(col_prof, cols) if ys else None
        for c in range(cols):
            x0, x1 = (xs[c], xs[c + 1]) if xs else (round(c * w / cols), round((c + 1) * w / cols))
            boxes.append((x0, y0, x1, y1))
    return boxes


def _dilate(mask, r):
    return mask.filter(ImageFilter.GaussianBlur(r / 2)).point(lambda v: 255 if v > 12 else 0)


def _white_edge(layer, stroke):
    a = layer.getchannel("A")
    edge = _dilate(a.point(lambda v: 255 if v > 60 else 0), stroke * 2).filter(ImageFilter.GaussianBlur(0.8))
    out = Image.new("RGBA", layer.size, (255, 255, 255, 0))
    out.putalpha(edge)
    out.alpha_composite(layer)
    return out


def cut_cell(cell, stroke=4):
    """1マスを (文字レイヤー, キャラレイヤー) に分ける。どちらも白フチ付きの透過PNG.

    背景透過済みの画像 (RGBA) なら元の透明度をそのまま使う。白背景の画像なら白を抜く。
    """
    if cell.mode == "RGBA":
        alpha = cell.getchannel("A")
        ink = alpha.point(lambda v: 255 if v > 40 else 0)
        comps = _components(ink.filter(ImageFilter.MaxFilter(3)))
        body = max(comps, key=len)
    else:
        cell = cell.convert("RGB")
        dist = _bg_distance(cell)
        ink = dist.point(lambda v: 255 if v > 25 else 0)
        # 背景色との違いから透明度を作る (背景 → 透明)
        soft = dist.point(lambda v: max(0, min(255, (v - 8) * 4)))
        comps = _components(ink.filter(ImageFilter.MaxFilter(3)))
        body = max(comps, key=len)
        # 線で囲まれた白 (マグカップの中・花びらなど) は残す
        holes = _fill_holes(ink.filter(ImageFilter.MaxFilter(3))).filter(ImageFilter.MinFilter(3))
        hull = _hull(body, cell.size)
        # 線が途切れていて顔の白が外とつながっている (パンダなど) 場合は、外形 (凸包) の内側を塗る
        inside = ImageChops.darker(hull, ImageChops.invert(holes))
        leak = sum(inside.histogram()[128:]) / max(1, sum(hull.histogram()[128:]))
        fill = ImageChops.lighter(holes, hull) if leak > 0.33 else holes
        alpha = ImageChops.lighter(soft, fill)
    top = min(y for _, y in body)

    text_mask = Image.new("L", cell.size, 0)
    tp = text_mask.load()
    for comp in comps:
        if comp is body:
            continue
        if max(y for _, y in comp) < top + 4:  # キャラより完全に上にある部品 = 文字
            for x, y in comp:
                tp[x, y] = 255
    text_mask = text_mask.filter(ImageFilter.MaxFilter(5))

    text_a = ImageChops.darker(alpha, text_mask)
    char_a = ImageChops.subtract(alpha, text_a)
    layers = []
    for a in (text_a, char_a):
        lay = cell.convert("RGBA")
        lay.putalpha(a)
        layers.append(_white_edge(lay, stroke) if stroke > 0 else lay)
    return layers


def split_letters(text_layer):
    """文字レイヤーを1文字ずつ (x範囲) に分ける."""
    a = text_layer.getchannel("A").point(lambda v: 255 if v > 40 else 0)
    w, h = a.size
    px = a.load()
    cols = [any(px[x, y] for y in range(h)) for x in range(w)]
    ranges, x = [], 0
    while x < w:
        if cols[x]:
            s = x
            while x < w and (cols[x] or any(cols[x:x + 3])):
                x += 1
            ranges.append((s, x))
        x += 1
    return ranges


# ---- 変形・エフェクト --------------------------------------------------------

def xform(img, ax, ay, sx=1.0, sy=1.0, rot=0.0, dx=0.0, dy=0.0):
    """(ax, ay) を中心に拡大縮小・回転し、(dx, dy) 動かす."""
    if (sx, sy, rot, dx, dy) == (1, 1, 0, 0, 0):
        return img
    sx, sy = max(sx, 0.02), max(sy, 0.02)
    th = math.radians(rot)
    c, s = math.cos(th), math.sin(th)
    a, b, d, e = c / sx, s / sx, -s / sy, c / sy
    tx, ty = ax + dx, ay + dy
    return img.transform(img.size, Image.AFFINE, (a, b, ax - a * tx - b * ty, d, e, ay - d * tx - e * ty),
                         resample=Image.BICUBIC)


def fade(img, alpha):
    if alpha >= 1:
        return img
    out = img.copy()
    out.putalpha(img.getchannel("A").point(lambda v: int(v * max(alpha, 0))))
    return out


def ease_out_back(t):
    t = min(max(t, 0), 1)
    c1 = 1.70158
    return 1 + (c1 + 1) * (t - 1) ** 3 + c1 * (t - 1) ** 2


def window(t, start, length):
    """start から length の間だけ 0→1 に進む値."""
    return min(max((t - start) / length, 0), 1)


def sparkle(d, x, y, r, col=YELLOW):
    if r < 1:
        return
    k = r * 0.3
    pts = [(x, y - r), (x + k, y - k), (x + r, y), (x + k, y + k), (x, y + r), (x - k, y + k), (x - r, y), (x - k, y - k)]
    d.polygon([v * S for pt in pts for v in pt], fill=col, outline=WHITE, width=S * 2)


def heart(d, x, y, s, col=PINK):
    pts = []
    for i in range(36):
        a = 2 * math.pi * i / 36
        pts.append((x + 16 * math.sin(a) ** 3 * s / 16,
                    y - (13 * math.cos(a) - 5 * math.cos(2 * a) - 2 * math.cos(3 * a) - math.cos(4 * a)) * s / 16))
    d.polygon([v * S for pt in pts for v in pt], fill=col, outline=WHITE, width=S * 2)


def burst(d, cx, cy, r0, r1, n, col, width=4, rot=0):
    for i in range(n):
        a = 2 * math.pi * i / n + rot
        d.line([(cx + math.cos(a) * r0) * S, (cy + math.sin(a) * r0) * S,
                (cx + math.cos(a) * r1) * S, (cy + math.sin(a) * r1) * S], fill=col, width=width * S)


def ring(d, cx, cy, r, col, width=4):
    d.ellipse([(cx - r) * S, (cy - r) * S, (cx + r) * S, (cy + r) * S], outline=col, width=width * S)


# ---- 動きのプリセット --------------------------------------------------------
# キャラ: t(0→1) → dict(sx, sy, rot, dx, dy, alpha)。最後 (t=1) は必ず元の姿勢。

def c_jump(t):        # ためて → 大ジャンプ → 着地でつぶれる
    if t < 0.15:
        k = math.sin(math.pi * t / 0.15)
        return dict(sx=1 + 0.12 * k, sy=1 - 0.15 * k)
    if t < 0.7:
        k = (t - 0.15) / 0.55
        return dict(dy=-60 * math.sin(math.pi * k), sx=0.94, sy=1.08)
    k = math.sin(math.pi * (t - 0.7) / 0.3)
    return dict(sx=1 + 0.12 * k, sy=1 - 0.14 * k)


def c_pop(t):         # ポンッと飛び出して ぷるぷる
    s = ease_out_back(window(t, 0, 0.35)) * 0.8 + 0.2 if t < 0.35 else 1
    return dict(sx=s, sy=s, rot=8 * math.sin(6 * math.pi * t) * (1 - t))


def c_rock(t):        # ゆらゆら + 拍子で拡大
    beat = abs(math.sin(2 * math.pi * t))
    return dict(rot=12 * math.sin(2 * math.pi * t), sx=1 + 0.08 * beat, sy=1 + 0.08 * beat)


def c_bow(t):         # ぺこっとおじぎ (2回)
    k = abs(math.sin(2 * math.pi * t))
    return dict(sy=1 - 0.18 * k, sx=1 + 0.06 * k, dy=4 * k)


def c_deepbow(t):     # 深くおじぎ → びよーんと戻る
    if t < 0.45:
        k = math.sin(math.pi / 2 * t / 0.45)
        return dict(sy=1 - 0.28 * k, sx=1 + 0.1 * k)
    k = (t - 0.45) / 0.55
    return dict(sy=1 + 0.12 * math.sin(3 * math.pi * k) * (1 - k), sx=1 - 0.05 * math.sin(3 * math.pi * k) * (1 - k))


def c_nod(t):         # うんうん (3回うなずく)
    k = abs(math.sin(3 * math.pi * t))
    return dict(dy=12 * k, sy=1 - 0.08 * k)


def c_heartbeat(t):   # ドキドキ (ドクン×2)
    k = max(0, math.sin(4 * math.pi * t)) ** 2
    return dict(sx=1 + 0.16 * k, sy=1 + 0.16 * k)


def c_spin_in(t):     # くるくる回りながら登場
    k = window(t, 0, 0.45)
    s = ease_out_back(k)
    return dict(sx=max(s, 0.05), sy=max(s, 0.05), rot=-360 * (1 - k) ** 2)


def c_hop(t):         # ぴょんぴょん (2回) 伸び縮み付き
    k = abs(math.sin(2 * math.pi * t))
    land = math.exp(-((t - 0.5) / 0.06) ** 2)  # 1回目の着地でつぶれる (最後は元の形)
    return dict(dy=-50 * k, sy=1 + 0.08 * k - 0.12 * land, sx=1 - 0.05 * k + 0.1 * land)


def c_sway(t):        # のんびり左右に揺れる
    return dict(rot=9 * math.sin(2 * math.pi * t), dx=6 * math.sin(2 * math.pi * t))


def c_rise(t):        # 下からニョキッと出て弾む
    k = window(t, 0, 0.4)
    return dict(dy=160 * (1 - ease_out_back(k)), sy=1 + 0.1 * math.sin(math.pi * window(t, 0.35, 0.3)))


def c_wave(t):        # 大きく手をふるように揺れる + ぴょん
    return dict(rot=15 * math.sin(4 * math.pi * t), dy=-14 * abs(math.sin(4 * math.pi * t)))


def c_float(t):       # ふわふわ
    return dict(dy=-10 * math.sin(2 * math.pi * t), rot=4 * math.sin(2 * math.pi * t))


def c_angry(t):       # ぷんぷん! 激しく震える
    k = 1 - t
    return dict(dx=8 * math.sin(10 * math.pi * t) * k, sx=1 + 0.08 * abs(math.sin(4 * math.pi * t)),
                sy=1 - 0.05 * abs(math.sin(4 * math.pi * t)))


def c_punch(t):       # ドーン!と迫ってきて揺れる
    k = window(t, 0, 0.3)
    s = 1.45 - 0.45 * ease_out_back(k)
    return dict(sx=s, sy=s, dx=6 * math.sin(8 * math.pi * t) * (1 - t))


def c_spin_jump(t):   # ジャンプしながら1回転
    k = window(t, 0.05, 0.7)
    return dict(dy=-55 * math.sin(math.pi * k), rot=-360 * (k * k * (3 - 2 * k)),
                sy=1 - 0.12 * math.sin(math.pi * window(t, 0.75, 0.25)))


CHAR = {
    "jump": c_jump, "pop": c_pop, "rock": c_rock, "bow": c_bow, "deepbow": c_deepbow, "nod": c_nod,
    "heartbeat": c_heartbeat, "spin_in": c_spin_in, "hop": c_hop, "sway": c_sway, "rise": c_rise,
    "wave": c_wave, "float": c_float, "angry": c_angry, "punch": c_punch, "spin_jump": c_spin_jump,
}

# 文字: (t, i, n) → dict。i は何文字目か。


def t_slam(t, i, n):      # 大きい文字がドン!と落ちてくる
    k = window(t, 0, 0.25)
    s = 2.2 - 1.2 * ease_out_back(k)
    return dict(sx=s, sy=s, alpha=min(1, k * 3))


def t_pop(t, i, n):       # 1文字ずつポンポン出る
    st = min(0.08, 0.5 / n)
    s = ease_out_back(window(t, 0.1 + i * st, 0.25))
    return dict(sx=max(s, 0.02), sy=max(s, 0.02), alpha=1 if s > 0.05 else 0)


def t_wave(t, i, n):      # 1文字ずつぴょこぴょこ
    st = min(0.1, 0.6 / n)
    k = window(t, i * st, 0.35)
    return dict(dy=-16 * math.sin(math.pi * k))


def t_shake(t, i, n):     # ぶるぶる
    env = math.sin(math.pi * t)
    return dict(dx=5 * math.sin(10 * math.pi * t + i) * env, rot=6 * math.sin(8 * math.pi * t + i * 1.3) * env)


def t_jump(t, i, n):      # 全部の文字が交互にジャンプ
    return dict(dy=-18 * abs(math.sin(2 * math.pi * t + (i % 2) * math.pi / 2)) * (1 - window(t, 0.85, 0.15)))


def t_slide(t, i, n):     # 左からスライドイン
    k = ease_out_back(window(t, i * 0.05, 0.4))
    return dict(dx=-320 * (1 - k), alpha=1 if k > 0.02 else 0)


def t_sway(t, i, n):
    return dict(rot=5 * math.sin(2 * math.pi * t), dy=-4 * math.sin(2 * math.pi * t) * math.cos(i * 0.6))


TEXT = {"slam": t_slam, "pop": t_pop, "wave": t_wave, "shake": t_shake, "jump": t_jump,
        "slide": t_slide, "sway": t_sway}


# エフェクト: (d_back, d_front, t, box) → None。box はキャラの範囲 (x0, y0, x1, y1)

def f_burst(db, df, t, box, col=RED):
    cx, cy = (box[0] + box[2]) / 2, (box[1] + box[3]) / 2
    k = window(t, 0.55, 0.3) if t < 0.95 else 0
    if 0 < k < 1:
        r = max(box[2] - box[0], box[3] - box[1]) / 2
        burst(db, cx, cy, r * (0.9 + k * 0.4), r * (1.15 + k * 0.6), 14, col, 5)


def f_sparkles(db, df, t, box, col=YELLOW):
    cx, cy = (box[0] + box[2]) / 2, (box[1] + box[3]) / 2
    r = max(box[2] - box[0], box[3] - box[1]) / 2
    for j in range(6):
        ph = (t * 1.0 + j / 6) % 1
        a = j * 2 * math.pi / 6 + 0.4
        dist = r * (0.75 + ph * 0.55)
        sparkle(df, cx + math.cos(a) * dist, cy + math.sin(a) * dist, 11 * math.sin(math.pi * ph), col)


def f_twinkle(db, df, t, box):
    for j, (fx, fy) in enumerate(((0.05, 0.1), (0.95, 0.2), (0.0, 0.75), (1.0, 0.8))):
        x = box[0] + (box[2] - box[0]) * fx
        y = box[1] + (box[3] - box[1]) * fy
        sparkle(df, x, y, 10 * abs(math.sin(2 * math.pi * t + j * 1.2)) + 2)


def f_hearts(db, df, t, box):
    rnd = random.Random(7)
    for j in range(8):
        ph = (t + j / 8) % 1
        side = -1 if j % 2 else 1  # 顔にかぶらないよう左右から上がっていく
        x = (box[0] + box[2]) / 2 + side * (box[2] - box[0]) * rnd.uniform(0.42, 0.58)
        heart(db if ph < 0.5 else df, x + 8 * math.sin(2 * math.pi * ph + j),
              box[3] - ph * (box[3] - box[1] + 30), 8 + 8 * math.sin(math.pi * ph), PINK if j % 4 < 2 else RED)


def f_confetti(db, df, t, box):
    rnd = random.Random(3)
    cols = [RED, YELLOW, BLUE, GREEN, PINK]
    for j in range(22):
        x0 = rnd.uniform(10, W - 10)
        sp = rnd.uniform(0.8, 1.4)
        y = (rnd.uniform(0, H) + t * H * sp) % (H + 20) - 10
        x = x0 + 8 * math.sin(2 * math.pi * (t * 2 + j * 0.3))
        ang = t * 12 + j
        c, s = math.cos(ang), math.sin(ang)
        pts = [(x + c * 6 - s * 3, y + s * 6 + c * 3), (x - c * 6 - s * 3, y - s * 6 + c * 3),
               (x - c * 6 + s * 3, y - s * 6 - c * 3), (x + c * 6 + s * 3, y + s * 6 - c * 3)]
        df.polygon([v * S for pt in pts for v in pt], fill=cols[j % 5])


def f_rays(db, df, t, box):
    cx, cy = (box[0] + box[2]) / 2, (box[1] + box[3]) / 2
    r = max(box[2] - box[0], box[3] - box[1]) / 2
    burst(db, cx, cy, r * 0.9, r * 1.35, 16, (255, 200, 60, 200), 7, rot=t * math.pi / 4)


def f_speed(db, df, t, box):
    for j in range(4):
        y = box[1] + (box[3] - box[1]) * (0.25 + j * 0.17)
        off = ((t * 3 + j * 0.3) % 1) * 20
        db.line([(box[0] - 30 - off) * S, y * S, (box[0] - 8 - off) * S, y * S], fill=BLUE, width=4 * S)
        db.line([(box[2] + 8 + off) * S, y * S, (box[2] + 30 + off) * S, y * S], fill=BLUE, width=4 * S)


def f_zzz(db, df, t, box):
    for j in range(3):
        ph = (t + j / 3) % 1
        x = box[2] - 10 + ph * 30
        y = box[1] + 20 - ph * 50
        sparkle(df, x, y, 6 * math.sin(math.pi * ph) + 1, (170, 200, 255, 255))


def f_anger(db, df, t, box):
    k = abs(math.sin(4 * math.pi * t))
    cx, cy = (box[0] + box[2]) / 2, (box[1] + box[3]) / 2
    r = max(box[2] - box[0], box[3] - box[1]) / 2
    burst(db, cx, cy, r * 0.95, r * (1.1 + 0.25 * k), 18, (240, 70, 70, 230), 5, rot=t)


def f_shock(db, df, t, box):
    k = window(t, 0.25, 0.35)
    if 0 < k < 1:
        cx, cy = (box[0] + box[2]) / 2, (box[1] + box[3]) / 2
        r = max(box[2] - box[0], box[3] - box[1]) / 2
        ring(db, cx, cy, r * (0.8 + k * 0.8), (255, 212, 60, int(255 * (1 - k))), 6)
    f_sparkles(db, df, t, box)


def f_steam(db, df, t, box):
    f_twinkle(db, df, t, box)


FX = {"burst": f_burst, "sparkles": f_sparkles, "twinkle": f_twinkle, "hearts": f_hearts,
      "confetti": f_confetti, "rays": f_rays, "speed": f_speed, "zzz": f_zzz, "anger": f_anger,
      "shock": f_shock, "steam": f_steam, "none": lambda *a: None}


# ---- 1コマの合成 ------------------------------------------------------------

class Stamp:
    def __init__(self, cell, stroke=4):
        text, char = cut_cell(cell, stroke)
        self.text_src, self.char_src = text, char
        tb, cb = text.getbbox(), char.getbbox()
        boxes = [b for b in (tb, cb) if b]
        ux0 = min(b[0] for b in boxes)
        uy0 = min(b[1] for b in boxes)
        ux1 = max(b[2] for b in boxes)
        uy1 = max(b[3] for b in boxes)
        # 動く余白を残してキャンバスに収める
        scale = min((W - 24) * 0.9 / (ux1 - ux0), (H - 16) * 0.92 / (uy1 - uy0))
        self.scale = scale
        ox = (W - (ux1 - ux0) * scale) / 2 - ux0 * scale
        oy = (H - (uy1 - uy0) * scale) / 2 - uy0 * scale
        self.off = (ox, oy)

        def place(layer):
            big = layer.resize((round(layer.width * scale * S), round(layer.height * scale * S)), Image.LANCZOS)
            canvas = Image.new("RGBA", (W * S, H * S), (255, 255, 255, 0))
            x, y = round(ox * S), round(oy * S)
            canvas.alpha_composite(big, (max(x, 0), max(y, 0)), (max(-x, 0), max(-y, 0)))
            return canvas
        self.char = place(char)
        self.char_box = tuple(v / S for v in self.char.getbbox()) if cb else (0, 0, W, H)
        self.letters = []
        if tb:
            text_c = place(text)
            for x0, x1 in split_letters(text):
                cx0 = round((x0 * scale + ox) * S) - S
                cx1 = round((x1 * scale + ox) * S) + S
                piece = Image.new("RGBA", text_c.size, (255, 255, 255, 0))
                piece.alpha_composite(text_c.crop((cx0, 0, cx1, text_c.height)), (cx0, 0))
                bb = piece.getbbox()
                if bb:
                    self.letters.append((piece, bb))
            tbb = text_c.getbbox()
            self.text_center = ((tbb[0] + tbb[2]) / 2, (tbb[1] + tbb[3]) / 2)

    def render(self, t, char_fn, text_fn, fx_fn):
        frame = Image.new("RGBA", (W * S, H * S), (255, 255, 255, 0))
        back = Image.new("RGBA", frame.size, (255, 255, 255, 0))
        front = Image.new("RGBA", frame.size, (255, 255, 255, 0))
        fx_fn(ImageDraw.Draw(back), ImageDraw.Draw(front), t, self.char_box)
        frame.alpha_composite(back)
        bx0, by0, bx1, by1 = self.char_box
        m = char_fn(t)
        # キャラは足元中心、回転は体の中心で行う
        anchor_y = by1 if not m.get("rot") else (by0 + by1) / 2
        char = xform(self.char, (bx0 + bx1) / 2 * S, anchor_y * S, m.get("sx", 1), m.get("sy", 1),
                     m.get("rot", 0), m.get("dx", 0) * S, m.get("dy", 0) * S)
        frame.alpha_composite(fade(char, m.get("alpha", 1)))
        frame.alpha_composite(front)
        n = len(self.letters)
        for i, (piece, bb) in enumerate(self.letters):
            m = text_fn(t, i, n)
            if text_fn in (t_slam,):  # 文字全体で1つの動き
                ax, ay = self.text_center
            else:
                ax, ay = (bb[0] + bb[2]) / 2, (bb[1] + bb[3]) / 2
            p = xform(piece, ax, ay, m.get("sx", 1), m.get("sy", 1), m.get("rot", 0),
                      m.get("dx", 0) * S, m.get("dy", 0) * S)
            frame.alpha_composite(fade(p, m.get("alpha", 1)))
        return frame.resize((W, H), Image.LANCZOS)


# ---- メイン -----------------------------------------------------------------

DEFAULT_CYCLE = [("jump", "slam", "burst"), ("pop", "pop", "sparkles"), ("hop", "jump", "confetti"),
                 ("heartbeat", "wave", "hearts"), ("spin_in", "slam", "shock"), ("wave", "wave", "speed")]


def read_config(path, count):
    rows = []
    if path:
        with open(path, encoding="utf-8-sig", newline="") as f:
            for r in csv.DictReader(f):
                rows.append(r)
    out = []
    for i in range(count):
        r = rows[i] if i < len(rows) else {}
        c, t, fx = DEFAULT_CYCLE[i % len(DEFAULT_CYCLE)]
        out.append(dict(char=r.get("char") or c, text=r.get("text") or t, fx=r.get("fx") or fx,
                        frames=int(r.get("frames") or 20), seconds=int(r.get("seconds") or 1),
                        loops=int(r.get("loops") or 3), name=r.get("name", "")))
    return out


def main(argv=None):
    ap = argparse.ArgumentParser(description="一覧画像 → 派手に動くLINEスタンプ")
    ap.add_argument("sheet", help="スタンプを並べた一覧画像")
    ap.add_argument("--grid", default="4x4", help="列x行 (既定 4x4)")
    ap.add_argument("--config", help="動きの指定CSV (name,char,text,fx,frames,seconds,loops)")
    ap.add_argument("-o", "--out", default="output")
    ap.add_argument("--only", type=int, help="この番号のスタンプだけ作る (確認用)")
    ap.add_argument("--stroke", type=int, default=0, help="白フチの太さ px (既定 0 = フチなし。4 程度でダークモードでも見やすくなる)")
    args = ap.parse_args(argv)

    cols, rows = (int(v) for v in args.grid.lower().split("x"))
    sheet = Image.open(args.sheet)
    has_alpha = "A" in sheet.getbands() and sheet.getchannel("A").getextrema()[0] < 250
    sheet = sheet.convert("RGBA" if has_alpha else "RGB")
    print("背景透過の画像です。元の透明度をそのまま使います" if has_alpha else "白背景の画像です。白を自動で抜きます")
    boxes = detect_cells(sheet, cols, rows)
    count = cols * rows
    conf = read_config(args.config, count)
    out = Path(args.out)
    frames_root = out.parent / (out.name + "_frames")
    specs = []
    for i in range(count):
        r, c = divmod(i, cols)
        cfg = conf[i]
        folder = frames_root / f"{i + 1:02d}"
        specs.append(ms.StampSpec(source=folder, frames=cfg["frames"], seconds=cfg["seconds"], loops=cfg["loops"]))
        if args.only and args.only != i + 1:
            continue
        cell = sheet.crop(boxes[i])
        stamp = Stamp(cell, args.stroke)
        folder.mkdir(parents=True, exist_ok=True)
        for old in folder.glob("*.png"):
            old.unlink()
        n = cfg["frames"]
        for k in range(n):
            t = k / (n - 1)
            stamp.render(t, CHAR[cfg["char"]], TEXT[cfg["text"]], FX[cfg["fx"]]).save(folder / f"{k:02d}.png")
        print(f"  {i + 1:02d} {cfg['name']:8s} キャラ:{cfg['char']:9s} 文字:{cfg['text']:6s} 効果:{cfg['fx']}")
    if args.only:
        return 0
    zip_path = ms.build(specs, out, None)
    ok = ms.validate_dir(out)
    print(f"\nアップロード用ZIP: {zip_path}")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())

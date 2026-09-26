#!/usr/bin/env python3
"""LINE アニメーションスタンプ一括作成ツール.

イラスト (透過PNG) 1枚ごとに動き方を指定するだけで、LINE Creators Market の
アニメーションスタンプ仕様を満たす APNG と、そのままアップロードできる ZIP を作る。

使い方:
    python make_stamps.py --demo                 # サンプルで動作確認
    python make_stamps.py stamps.csv             # 本番 (CSV を編集して実行)
    python make_stamps.py --validate output/     # 既存ファイルの仕様チェックだけ行う
"""

from __future__ import annotations

import argparse
import csv
import math
import struct
import sys
import zipfile
import zlib
from dataclasses import dataclass
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

# ---- LINE アニメーションスタンプ仕様 --------------------------------------
STAMP_MAX_W, STAMP_MAX_H = 320, 270   # スタンプ画像: 最大 W320 x H270
STAMP_MIN_LONG_SIDE = 270             # 縦横どちらかは 270px 以上
MAIN_SIZE = (240, 240)                # メイン画像 (APNG)
TAB_SIZE = (96, 74)                   # トークルームタブ画像 (静止PNG)
MAX_BYTES = 300 * 1024                # 1ファイル 300KB 以下
MIN_FRAMES, MAX_FRAMES = 5, 20        # フレーム数 5〜20
MIN_LOOPS, MAX_LOOPS = 1, 4           # ループ数 1〜4
MAX_TOTAL_SEC = 4                     # 再生時間 最大4秒 (1/2/3/4秒)
VALID_COUNTS = (8, 16, 24)            # セット数

MARGIN = 12  # 動きで画像が切れないための余白

FONT_CANDIDATES = [
    "/System/Library/Fonts/ヒラギノ角ゴシック W6.ttc",
    "/System/Library/Fonts/Hiragino Sans GB.ttc",
    "C:/Windows/Fonts/meiryob.ttc",
    "C:/Windows/Fonts/meiryo.ttc",
    "C:/Windows/Fonts/YuGothB.ttc",
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc",
    "/usr/share/fonts/noto-cjk/NotoSansCJK-Bold.ttc",
    "/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc",
]


# ---- 動きのプリセット ----------------------------------------------------
# t は 0.0 → 1.0。t=1.0 (最終フレーム) で必ず「元の姿勢」に戻るようにしている。
# LINE では再生後に最終フレームが表示され続けるため。

def _ease_out_back(t: float) -> float:
    c1 = 1.70158
    c3 = c1 + 1
    return 1 + c3 * (t - 1) ** 3 + c1 * (t - 1) ** 2


MOTIONS = {
    # name: (説明, 関数(t, amp) -> (dx, dy, scale, angle, alpha))
    "bounce":    ("ぴょんぴょん跳ねる", lambda t, a: (0, -abs(math.sin(2 * math.pi * t)) * a, 1, 0, 1)),
    "jump":      ("大きく1回ジャンプ", lambda t, a: (0, -math.sin(math.pi * t) * a * 1.6, 1, 0, 1)),
    "shake":     ("ぷるぷる震える", lambda t, a: (math.sin(6 * math.pi * t) * a * 0.5, 0, 1, 0, 1)),
    "swing":     ("左右にゆらゆら", lambda t, a: (0, 0, 1, 12 * math.sin(2 * math.pi * t), 1)),
    "float":     ("ふわふわ浮かぶ", lambda t, a: (0, -math.sin(2 * math.pi * t) * a * 0.6, 1, 0, 1)),
    "heartbeat": ("ドキドキ拡大縮小", lambda t, a: (0, 0, 1 + 0.10 * abs(math.sin(2 * math.pi * t)), 0, 1)),
    "pop":       ("ポンッと飛び出す", lambda t, a: (0, 0, max(0.2, _ease_out_back(t)), 0, 1)),
    "spin":      ("くるっと1回転", lambda t, a: (0, 0, 1, -360 * t, 1)),
    "fadein":    ("じわっと現れる", lambda t, a: (0, 0, 1, 0, 0.25 + 0.75 * t)),
    "zoom":      ("グッと迫る", lambda t, a: (0, 0, 1 + 0.12 * math.sin(math.pi * t), 0, 1)),
}


@dataclass
class StampSpec:
    source: Path          # 画像ファイル、または連番フレームの入ったフォルダ
    motion: str = "bounce"
    text: str = ""
    frames: int = 8
    seconds: int = 1      # 1ループの長さ (秒)
    loops: int = 2


# ---- 画像処理 ------------------------------------------------------------

def find_font(path: str | None) -> str | None:
    if path:
        return path
    for cand in FONT_CANDIDATES:
        if Path(cand).exists():
            return cand
    return None


def add_text(img: Image.Image, text: str, font_path: str | None) -> Image.Image:
    """イラストの下部に縁取り文字を載せる (文字も一緒に動く)."""
    if not text:
        return img
    if not font_path:
        print("  ! 日本語フォントが見つからないため文字は入れません (--font で指定可)")
        return img
    w, h = img.size
    size = max(16, int(w / max(len(text), 3) * 0.95))
    size = min(size, int(h * 0.28))
    font = ImageFont.truetype(font_path, size)
    stroke = max(3, size // 8)
    probe = ImageDraw.Draw(img).textbbox((0, 0), text, font=font, stroke_width=stroke)
    tw, th = probe[2] - probe[0], probe[3] - probe[1]
    canvas = Image.new("RGBA", (max(w, tw + 4), h + th // 2), (0, 0, 0, 0))
    canvas.alpha_composite(img, ((canvas.width - w) // 2, 0))
    draw = ImageDraw.Draw(canvas)
    x = (canvas.width - tw) // 2 - probe[0]
    y = canvas.height - th - probe[1] - 2
    draw.text((x, y), text, font=font, fill=(40, 40, 40, 255),
              stroke_width=stroke, stroke_fill=(255, 255, 255, 255))
    return canvas


def fit(img: Image.Image, box_w: int, box_h: int) -> Image.Image:
    img = img.copy()
    img.thumbnail((box_w, box_h), Image.LANCZOS)
    return img


def render_motion(base: Image.Image, spec: StampSpec, size: tuple[int, int]) -> list[Image.Image]:
    cw, ch = size
    fn = MOTIONS[spec.motion][1]
    # 回転・拡大しても収まるように縮めておく
    headroom = 0.80 if spec.motion in ("spin", "swing") else 0.86
    subject = fit(base, int((cw - MARGIN * 2) * headroom), int((ch - MARGIN * 2) * headroom))
    amp = ch * 0.07
    frames = []
    n = spec.frames
    for i in range(n):
        t = i / (n - 1)
        dx, dy, scale, angle, alpha = fn(t, amp)
        im = subject
        if scale != 1:
            im = im.resize((max(1, round(im.width * scale)), max(1, round(im.height * scale))), Image.LANCZOS)
        if abs(math.remainder(angle, 360)) > 1e-6:
            im = im.rotate(angle, resample=Image.BICUBIC, expand=True)
        if alpha < 1:
            a = im.getchannel("A").point(lambda v: int(v * alpha))
            im = im.copy()
            im.putalpha(a)
        # はみ出しても落ちないよう大きめのキャンバスに置いてから切り抜く
        pad = max(im.width, im.height)
        big = Image.new("RGBA", (cw + pad * 2, ch + pad * 2), (0, 0, 0, 0))
        x = (cw - im.width) // 2 + round(dx)
        y = (ch - im.height) // 2 + round(dy) + int(amp * 0.4)
        big.alpha_composite(im, (x + pad, y + pad))
        frames.append(big.crop((pad, pad, pad + cw, pad + ch)))
    return frames


def load_custom_frames(folder: Path, size: tuple[int, int]) -> list[Image.Image]:
    files = sorted(p for p in folder.iterdir() if p.suffix.lower() == ".png")
    cw, ch = size
    frames = []
    for p in files:
        im = Image.open(p).convert("RGBA")
        if im.size == size:  # すでに 320x270 で描かれたコマはそのまま使う
            frames.append(im)
            continue
        im = fit(im, cw - MARGIN * 2, ch - MARGIN * 2)
        frame = Image.new("RGBA", (cw, ch), (0, 0, 0, 0))
        frame.alpha_composite(im, ((cw - im.width) // 2, (ch - im.height) // 2))
        frames.append(frame)
    return frames


def encode_apng(frames: list[Image.Image], seconds: int, loops: int) -> bytes:
    """256色に減色した APNG を作る。300KB を超えたらフレームを間引いて再挑戦する."""
    work = frames
    while True:
        data = _save_apng(work, seconds, loops)
        if len(data) <= MAX_BYTES or len(work) <= MIN_FRAMES:
            return data  # それでも超える場合は仕様チェックで NG が出る
        keep = max(MIN_FRAMES, len(work) - 2)
        idx = [round(i * (len(work) - 1) / (keep - 1)) for i in range(keep)]
        work = [work[i] for i in idx]


def _chunk(tag: bytes, body: bytes) -> bytes:
    return struct.pack(">I", len(body)) + tag + body + struct.pack(">I", zlib.crc32(tag + body))


def _save_apng(frames: list[Image.Image], seconds: int, loops: int) -> bytes:
    """全フレーム共通パレット (PLTE+tRNS) の APNG を書き出す.

    Pillow のパレット形式 APNG 書き出しは差分処理が崩れることがあるため、
    全フレームを丸ごと格納するシンプルな書き出しを自前で行う。
    """
    n = len(frames)
    w, h = frames[0].size
    # 全フレームを縦に並べて一括減色 → 共通パレットになる
    strip = Image.new("RGBA", (w, h * n), (0, 0, 0, 0))
    for i, f in enumerate(frames):
        strip.paste(f, (0, h * i))
    q = strip.quantize(colors=256, method=Image.Quantize.FASTOCTREE, dither=Image.Dither.NONE)
    pal = q.getpalette(rawmode="RGBA")
    used = max(q.getextrema()[1] + 1, 1)
    plte = bytes(c for i in range(used) for c in pal[i * 4:i * 4 + 3])
    trns = bytes(pal[i * 4 + 3] for i in range(used))
    raw = q.tobytes()

    # 1ループがちょうど seconds 秒になるよう各フレームの表示時間(ms)を配分
    total_ms = seconds * 1000
    durations = [total_ms // n + (1 if i < total_ms % n else 0) for i in range(n)]

    out = [b"\x89PNG\r\n\x1a\n",
           _chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 3, 0, 0, 0)),
           _chunk(b"acTL", struct.pack(">II", n, loops)),
           _chunk(b"PLTE", plte),
           _chunk(b"tRNS", trns)]
    seq = 0
    for i in range(n):
        rows = raw[w * h * i:w * h * (i + 1)]
        data = zlib.compress(b"".join(b"\x00" + rows[y * w:(y + 1) * w] for y in range(h)), 9)
        out.append(_chunk(b"fcTL", struct.pack(">IIIIIHHBB", seq, w, h, 0, 0, durations[i], 1000, 0, 0)))
        seq += 1
        if i == 0:
            out.append(_chunk(b"IDAT", data))
        else:
            out.append(_chunk(b"fdAT", struct.pack(">I", seq) + data))
            seq += 1
    out.append(_chunk(b"IEND", b""))
    return b"".join(out)


def make_tab(img: Image.Image) -> Image.Image:
    tab = Image.new("RGBA", TAB_SIZE, (0, 0, 0, 0))
    im = fit(img, TAB_SIZE[0] - 4, TAB_SIZE[1] - 4)
    tab.alpha_composite(im, ((TAB_SIZE[0] - im.width) // 2, (TAB_SIZE[1] - im.height) // 2))
    return tab


# ---- CSV 読み込み ----------------------------------------------------------

def read_csv(path: Path) -> list[StampSpec]:
    specs = []
    with path.open(encoding="utf-8-sig", newline="") as f:
        for row in csv.DictReader(f):
            row = {k.strip(): (v or "").strip() for k, v in row.items() if k}
            if not row.get("file") or row["file"].startswith("#"):
                continue
            motion = row.get("motion") or "bounce"
            if motion not in MOTIONS:
                raise SystemExit(f"motion '{motion}' は未対応です。使えるもの: {', '.join(MOTIONS)}")
            specs.append(StampSpec(
                source=(path.parent / row["file"]).resolve(),
                motion=motion,
                text=row.get("text", ""),
                frames=int(row.get("frames") or 8),
                seconds=int(row.get("seconds") or 1),
                loops=int(row.get("loops") or 2),
            ))
    return specs


# ---- 仕様チェック ----------------------------------------------------------

def validate_apng(path: Path, expect_size: tuple[int, int] | None = None) -> list[str]:
    errors = []
    size = path.stat().st_size
    if size > MAX_BYTES:
        errors.append(f"ファイルサイズ {size // 1024}KB > 300KB")
    with Image.open(path) as im:
        if im.format != "PNG":
            errors.append("PNG(APNG) 形式ではありません")
            return errors
        w, h = im.size
        if expect_size and (w, h) != expect_size:
            errors.append(f"サイズ {w}x{h} (期待値 {expect_size[0]}x{expect_size[1]})")
        if not expect_size:
            if w > STAMP_MAX_W or h > STAMP_MAX_H:
                errors.append(f"サイズ {w}x{h} が最大 320x270 を超えています")
            if max(w, h) < STAMP_MIN_LONG_SIDE:
                errors.append(f"サイズ {w}x{h}: 縦横どちらかは270px以上必要です")
            if w % 2 or h % 2:
                errors.append(f"サイズ {w}x{h}: 縦横は偶数にしてください")
        n = getattr(im, "n_frames", 1)
        if n < MIN_FRAMES or n > MAX_FRAMES:
            errors.append(f"フレーム数 {n} (5〜20 である必要があります)")
        loops = im.info.get("loop", 0)
        if not MIN_LOOPS <= loops <= MAX_LOOPS:
            errors.append(f"ループ数 {loops} (1〜4 である必要があります)")
        total = 0
        for i in range(n):
            im.seek(i)
            total += im.info.get("duration", 0)
        total_play = total * max(loops, 1)
        if total_play > MAX_TOTAL_SEC * 1000:
            errors.append(f"再生時間 {total_play / 1000:.2f}秒 > 4秒")
        if total_play % 1000:
            errors.append(f"再生時間 {total_play / 1000:.2f}秒 (1/2/3/4秒のいずれかにしてください)")
        if im.mode not in ("RGBA", "P", "LA") and "transparency" not in im.info:
            errors.append("背景が透過になっていません")
    return errors


def validate_dir(out: Path) -> bool:
    ok = True
    stamps = sorted(p for p in out.glob("[0-9][0-9].png"))
    print(f"\n=== 仕様チェック: {out} ===")
    if len(stamps) not in VALID_COUNTS:
        print(f"  NG  スタンプ数 {len(stamps)}個 (8 / 16 / 24 個のいずれか)")
        ok = False
    for p in stamps:
        errs = validate_apng(p)
        ok &= not errs
        print(f"  {'OK' if not errs else 'NG'}  {p.name}  {p.stat().st_size // 1024}KB" +
              ("".join(f"\n        - {e}" for e in errs)))
    main = out / "main.png"
    if main.exists():
        errs = validate_apng(main, MAIN_SIZE)
        ok &= not errs
        print(f"  {'OK' if not errs else 'NG'}  main.png" + "".join(f"\n        - {e}" for e in errs))
    else:
        print("  NG  main.png がありません")
        ok = False
    tab = out / "tab.png"
    if tab.exists():
        with Image.open(tab) as im:
            good = im.size == TAB_SIZE
        ok &= good
        print(f"  {'OK' if good else 'NG'}  tab.png" + ("" if good else f"  サイズ {im.size} (96x74 が必要)"))
    else:
        print("  NG  tab.png がありません")
        ok = False
    print("  → すべて仕様OK" if ok else "  → NG の項目を修正してください")
    return ok


# ---- メイン処理 ------------------------------------------------------------

def build(specs: list[StampSpec], out: Path, font: str | None, main_index: int = 0) -> Path:
    out.mkdir(parents=True, exist_ok=True)
    if len(specs) not in VALID_COUNTS:
        print(f"! スタンプが {len(specs)} 個です。申請には 8 / 16 / 24 個が必要です。")
    font_path = find_font(font)
    first_frames = []
    for i, spec in enumerate(specs, 1):
        size = (STAMP_MAX_W, STAMP_MAX_H)
        if spec.source.is_dir():
            frames = load_custom_frames(spec.source, size)
            label = f"連番 {len(frames)}枚"
        else:
            src = Image.open(spec.source).convert("RGBA")
            src = src.crop(src.getbbox() or (0, 0, *src.size))  # 周りの透明な余白を詰める
            base = add_text(src, spec.text, font_path)
            frames = render_motion(base, spec, size)
            label = f"{spec.motion} ({MOTIONS[spec.motion][0]})"
        loops = min(spec.loops, MAX_TOTAL_SEC // spec.seconds)
        data = encode_apng(frames, spec.seconds, loops)
        (out / f"{i:02d}.png").write_bytes(data)
        first_frames.append((frames, spec, loops))
        print(f"  {i:02d}.png  {label:24s} {len(data) // 1024:4d}KB  {spec.seconds}秒x{loops}回")

    # メイン画像 (240x240 APNG) とタブ画像 (96x74 PNG) は指定スタンプから自動生成
    frames, spec, loops = first_frames[main_index]
    main_frames = []
    for f in frames:
        c = Image.new("RGBA", MAIN_SIZE, (0, 0, 0, 0))
        im = fit(f, *MAIN_SIZE)
        c.alpha_composite(im, ((MAIN_SIZE[0] - im.width) // 2, (MAIN_SIZE[1] - im.height) // 2))
        main_frames.append(c)
    (out / "main.png").write_bytes(encode_apng(main_frames, spec.seconds, loops))
    make_tab(frames[-1].crop(frames[-1].getbbox() or (0, 0, *frames[-1].size))).save(out / "tab.png", optimize=True)
    print("  main.png / tab.png を生成")

    write_preview(out, len(specs))

    zip_path = out / "line_animation_stamp.zip"
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as z:
        for name in ["main.png", "tab.png"] + [f"{i:02d}.png" for i in range(1, len(specs) + 1)]:
            z.write(out / name, name)
    return zip_path


def write_preview(out: Path, count: int) -> None:
    """ブラウザで動きを確認できる preview.html を作る (クリックで再生し直し)."""
    cells = "".join(
        f'<figure><img src="{i:02d}.png"><figcaption>{i:02d}</figcaption></figure>'
        for i in range(1, count + 1))
    (out / "preview.html").write_text(f"""<!doctype html><meta charset="utf-8">
<title>スタンプ プレビュー</title>
<style>
body{{margin:0;font-family:sans-serif;background:#8cabd9;padding:16px}}
h1{{font-size:16px;color:#fff}} .grid{{display:flex;flex-wrap:wrap;gap:12px}}
figure{{margin:0;background:rgba(255,255,255,.25);border-radius:12px;padding:6px;text-align:center}}
img{{width:160px;cursor:pointer}} figcaption{{color:#fff;font-size:12px}}
.meta img{{width:auto}}
</style>
<h1>LINE トーク画面に近い背景でのプレビュー（画像クリックで再生し直し）</h1>
<div class="grid">{cells}</div>
<h1>メイン画像 / タブ画像</h1>
<div class="grid meta"><figure><img src="main.png"><figcaption>main</figcaption></figure>
<figure><img src="tab.png"><figcaption>tab</figcaption></figure></div>
<script>document.querySelectorAll('img').forEach(i=>i.onclick=()=>{{const s=i.src.split('?')[0];i.src=s+'?'+Date.now()}})</script>
""", encoding="utf-8")


def make_demo(root: Path) -> Path:
    """サンプル用のキャラクター画像8枚と CSV を作る."""
    inp = root / "input"
    inp.mkdir(parents=True, exist_ok=True)
    items = [
        ("ありがとう", "bounce", (255, 205, 90), "smile"),
        ("OK!", "pop", (140, 210, 255), "wink"),
        ("おはよう", "swing", (255, 170, 190), "smile"),
        ("えっ!?", "shake", (190, 230, 150), "surprise"),
        ("すき", "heartbeat", (255, 140, 160), "love"),
        ("おやすみ", "float", (190, 170, 255), "sleep"),
        ("やったー", "jump", (255, 190, 120), "smile"),
        ("ごめんね", "fadein", (180, 200, 220), "sad"),
    ]
    rows = []
    for i, (text, motion, color, face) in enumerate(items, 1):
        im = Image.new("RGBA", (400, 400), (0, 0, 0, 0))
        d = ImageDraw.Draw(im)
        d.ellipse((40, 60, 360, 380), fill=color + (255,), outline=(60, 50, 50, 255), width=10)
        d.ellipse((110, 30, 170, 100), fill=color + (255,), outline=(60, 50, 50, 255), width=8)
        d.ellipse((230, 30, 290, 100), fill=color + (255,), outline=(60, 50, 50, 255), width=8)
        d.ellipse((50, 70, 350, 370), fill=color + (255,))
        ink = (60, 50, 50, 255)
        if face == "sleep":
            d.arc((120, 180, 180, 230), 20, 160, fill=ink, width=8)
            d.arc((220, 180, 280, 230), 20, 160, fill=ink, width=8)
        elif face == "wink":
            d.ellipse((130, 180, 165, 225), fill=ink)
            d.arc((220, 180, 280, 230), 200, 340, fill=ink, width=8)
        elif face == "love":
            for cx in (148, 252):
                d.polygon([(cx - 22, 195), (cx, 230), (cx + 22, 195), (cx, 205)], fill=(230, 40, 80, 255))
        else:
            d.ellipse((130, 180, 165, 225), fill=ink)
            d.ellipse((235, 180, 270, 225), fill=ink)
        if face == "surprise":
            d.ellipse((180, 250, 220, 300), fill=ink)
        elif face == "sad":
            d.arc((160, 260, 240, 320), 200, 340, fill=ink, width=8)
        else:
            d.arc((160, 220, 240, 290), 20, 160, fill=ink, width=8)
        d.ellipse((85, 240, 125, 265), fill=(255, 120, 120, 150))
        d.ellipse((275, 240, 315, 265), fill=(255, 120, 120, 150))
        name = f"chara_{i:02d}.png"
        im.save(inp / name)
        rows.append({"file": f"input/{name}", "motion": motion, "text": text,
                     "frames": 10, "seconds": 1, "loops": 3})
    csv_path = root / "stamps.csv"
    with csv_path.open("w", encoding="utf-8-sig", newline="") as f:
        w = csv.DictWriter(f, fieldnames=["file", "motion", "text", "frames", "seconds", "loops"])
        w.writeheader()
        w.writerows(rows)
    return csv_path


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="LINE アニメーションスタンプ一括作成ツール")
    ap.add_argument("csv", nargs="?", help="スタンプ一覧 CSV (file,motion,text,frames,seconds,loops)")
    ap.add_argument("-o", "--out", default="output", help="出力フォルダ (既定: output)")
    ap.add_argument("--font", help="文字入れに使うフォントファイル (.ttf/.otf/.ttc)")
    ap.add_argument("--main", type=int, default=1, help="メイン画像にするスタンプ番号 (既定: 1)")
    ap.add_argument("--demo", action="store_true", help="サンプル画像で一式を作成する")
    ap.add_argument("--validate", metavar="DIR", help="既存フォルダの仕様チェックのみ行う")
    ap.add_argument("--list-motions", action="store_true", help="使える動きの一覧を表示")
    args = ap.parse_args(argv)

    if args.list_motions:
        for k, (desc, _) in MOTIONS.items():
            print(f"  {k:10s} {desc}")
        return 0
    if args.validate:
        return 0 if validate_dir(Path(args.validate)) else 1

    if args.demo:
        csv_path = make_demo(Path("demo"))
        out = Path("demo/output")
        print(f"サンプルを作成しました: {csv_path}")
    elif args.csv:
        csv_path = Path(args.csv)
        out = Path(args.out)
    else:
        ap.print_help()
        return 1

    specs = read_csv(csv_path)
    for s in specs:
        if not s.source.exists():
            raise SystemExit(f"画像が見つかりません: {s.source}")
        if not MIN_FRAMES <= s.frames <= MAX_FRAMES:
            raise SystemExit(f"frames は 5〜20 にしてください: {s.source.name}")
        if s.seconds not in (1, 2, 3, 4):
            raise SystemExit(f"seconds は 1〜4 の整数にしてください: {s.source.name}")
    print(f"{len(specs)} 個のスタンプを作成します → {out}/")
    zip_path = build(specs, out, args.font, main_index=max(0, args.main - 1))
    ok = validate_dir(out)
    print(f"\nアップロード用ZIP: {zip_path}")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())

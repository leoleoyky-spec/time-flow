#!/usr/bin/env python3
"""一覧画像の背景・並びのまま、各スタンプをその場で動かした紹介動画 (MP4) を作る.

    python sheet_video.py girl/sheet.webp --grid 5x5 --config girl/motions.csv -o girl/sheet_video.mp4

切り抜いたスタンプを単色の背景に並べ直すのではなく、元の一覧画像の背景をそのまま使う。
MP4 の書き出しには imageio-ffmpeg が必要 (pip install imageio-ffmpeg)。
"""

import argparse
import subprocess
import sys

from PIL import Image, ImageChops, ImageFilter

import sheet_to_stamps as st


def main(argv=None):
    ap = argparse.ArgumentParser(description="一覧画像の背景のまま動かした動画を作る")
    ap.add_argument("sheet")
    ap.add_argument("--grid", default="4x4")
    ap.add_argument("--config")
    ap.add_argument("-o", "--out", default="sheet_video.mp4")
    ap.add_argument("--size", type=int, default=1080, help="動画の幅 px (高さは元画像の比率)")
    ap.add_argument("--seconds", type=int, default=8)
    ap.add_argument("--fps", type=int, default=20)
    args = ap.parse_args(argv)

    import imageio_ffmpeg

    cols, rows = (int(v) for v in args.grid.lower().split("x"))
    src = Image.open(args.sheet)
    has_alpha = "A" in src.getbands() and src.getchannel("A").getextrema()[0] < 250
    sheet = src.convert("RGBA" if has_alpha else "RGB")
    boxes = st.detect_cells(sheet, cols, rows)
    conf = st.read_config(args.config, len(boxes))

    # 背景: 元画像からスタンプ部分だけを背景色で消した板を作る
    plate = sheet.convert("RGBA")
    edge = [plate.getpixel((x, 0)) for x in range(0, plate.width, 4)]
    bg = tuple(sorted(c[i] for c in edge)[len(edge) // 2] for i in range(4))
    mask = Image.new("L", plate.size, 0)

    stamps = []
    for i, box in enumerate(boxes):
        cell = sheet.crop(box)
        text, char = st.cut_cell(cell, 0)
        a = ImageChops.lighter(text.getchannel("A"), char.getchannel("A"))
        mask.paste(ImageChops.lighter(mask.crop(box), a.point(lambda v: 255 if v > 10 else 0)), box[:2])
        # その場で動かすため、キャンバスをマスの大きさにして描く
        w, h = box[2] - box[0], box[3] - box[1]
        st.W, st.H = w - w % 2, h - h % 2
        cfg = conf[i]
        stamp = st.Stamp(cell.crop((0, 0, st.W, st.H)), 0, cfg["whole"])
        n = cfg["seconds"] * args.fps
        frames = [stamp.render(k / (n - 1), st.CHAR[cfg["char"]], st.TEXT[cfg["text"]], st.FX[cfg["fx"]])
                  for k in range(n)]
        stamps.append((box, frames, cfg["loops"]))
        print(f"  {i + 1:02d} {cfg['name']}")

    mask = mask.filter(ImageFilter.MaxFilter(9)).filter(ImageFilter.GaussianBlur(3))
    plate.paste(Image.new("RGBA", plate.size, bg), (0, 0), mask)

    W = args.size
    H = round(plate.height * W / plate.width)
    H -= H % 2
    p = subprocess.Popen([imageio_ffmpeg.get_ffmpeg_exe(), "-y", "-f", "rawvideo", "-pix_fmt", "rgb24",
                          "-s", f"{W}x{H}", "-r", str(args.fps), "-i", "-", "-c:v", "libx264",
                          "-pix_fmt", "yuv420p", "-crf", "18", "-movflags", "+faststart", args.out],
                         stdin=subprocess.PIPE, stderr=subprocess.DEVNULL)
    for f in range(args.fps * args.seconds):
        frame = plate.copy()
        for box, frames, _ in stamps:
            frame.alpha_composite(frames[f % len(frames)], box[:2])
        p.stdin.write(frame.resize((W, H), Image.LANCZOS).convert("RGB").tobytes())
    p.stdin.close()
    p.wait()
    print(f"作成しました: {args.out}")
    return p.returncode


if __name__ == "__main__":
    sys.exit(main())

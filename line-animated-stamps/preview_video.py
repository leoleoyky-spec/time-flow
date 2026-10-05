#!/usr/bin/env python3
"""作ったスタンプ (01.png〜) を並べて、全部が同時に動く確認用の MP4 を作る.

    python preview_video.py girl/output --cols 5 -o girl/preview.mp4 --bg 4fc3f7

MP4 の書き出しには imageio-ffmpeg が必要 (pip install imageio-ffmpeg)。
"""

import argparse
import subprocess
import sys
from pathlib import Path

from PIL import Image


def main(argv=None):
    ap = argparse.ArgumentParser(description="スタンプの確認用動画を作る")
    ap.add_argument("folder", help="01.png〜 が入ったフォルダ")
    ap.add_argument("--cols", type=int, default=4, help="横に並べる数 (既定 4)")
    ap.add_argument("-o", "--out", default="preview.mp4")
    ap.add_argument("--bg", default="4fc3f7", help="背景色 (16進数。既定 4fc3f7 = あざやかな水色)")
    ap.add_argument("--size", type=int, default=1080, help="動画の一辺 px (既定 1080)")
    ap.add_argument("--seconds", type=int, default=8)
    ap.add_argument("--fps", type=int, default=20)
    args = ap.parse_args(argv)

    import imageio_ffmpeg

    files = sorted(Path(args.folder).glob("[0-9][0-9].png"))
    if not files:
        raise SystemExit(f"{args.folder} に 01.png〜 が見つかりません")
    cols = args.cols
    rows = -(-len(files) // cols)
    W = H = args.size
    cell_w = (W - 40) // cols
    cell_h = (H - 40) // rows
    scale = min(cell_w / 320, cell_h / 270) * 0.98
    sw, sh = round(320 * scale), round(270 * scale)
    bg = tuple(int(args.bg.lstrip("#")[i:i + 2], 16) for i in (0, 2, 4)) + (255,)

    stamps = []
    for f in files:
        im = Image.open(f)
        frames, durs = [], []
        for k in range(getattr(im, "n_frames", 1)):
            im.seek(k)
            frames.append(im.convert("RGBA").resize((sw, sh), Image.LANCZOS))
            durs.append(im.info.get("duration", 100) or 100)
        stamps.append((frames, durs))

    ox = (W - cell_w * cols) // 2 + (cell_w - sw) // 2
    oy = (H - cell_h * rows) // 2 + (cell_h - sh) // 2
    base = Image.new("RGBA", (W, H), bg)
    p = subprocess.Popen([imageio_ffmpeg.get_ffmpeg_exe(), "-y", "-f", "rawvideo", "-pix_fmt", "rgb24",
                          "-s", f"{W}x{H}", "-r", str(args.fps), "-i", "-", "-c:v", "libx264",
                          "-pix_fmt", "yuv420p", "-crf", "18", "-movflags", "+faststart", args.out],
                         stdin=subprocess.PIPE, stderr=subprocess.DEVNULL)
    for n in range(args.fps * args.seconds):
        ms = n * 1000 / args.fps
        frame = base.copy()
        for i, (frames, durs) in enumerate(stamps):
            t, acc, k = ms % sum(durs), 0, 0
            for k, d in enumerate(durs):
                acc += d
                if t < acc:
                    break
            r, c = divmod(i, cols)
            frame.alpha_composite(frames[k], (ox + c * cell_w, oy + r * cell_h))
        p.stdin.write(frame.convert("RGB").tobytes())
    p.stdin.close()
    p.wait()
    print(f"作成しました: {args.out}")
    return p.returncode


if __name__ == "__main__":
    sys.exit(main())

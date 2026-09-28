#!/usr/bin/env python3
"""Burn styled captions (style.json) into a vertical reel. Keeps the original audio."""
import argparse, json, os, re, subprocess, tempfile

import imageio_ffmpeg
from PIL import Image, ImageDraw, ImageFont

FF = imageio_ffmpeg.get_ffmpeg_exe()


def rgba(h):
    h = h.lstrip("#")
    if len(h) == 6:
        h += "FF"
    return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4, 6))


def parse_runs(line, base, hi):
    """'[word]' segments use the highlight color."""
    runs = []
    for part in re.split(r"(\[[^\]]*\])", line):
        if part.startswith("[") and part.endswith("]"):
            runs.append((part[1:-1], hi))
        elif part:
            runs.append((part, base))
    return runs


def render_caption(cap, style, path):
    W, H = style["canvas"]["width"], style["canvas"]["height"]
    t = style["types"][cap.get("type", "normal")]
    font = ImageFont.truetype(style["font"]["path"], t["size"])
    lines = cap["text"].split("\n")
    stroke = t["stroke"]
    gap = int(t["size"] * 0.25)
    widths = [font.getlength(re.sub(r"[\[\]]", "", l)) for l in lines]
    asc, desc = font.getmetrics()
    lh = asc + desc
    tw, th = max(widths), lh * len(lines) + gap * (len(lines) - 1)
    pos = cap.get("position", "bottom")
    cy = H * style["position"]["top_y" if pos == "top" else "bottom_y"]
    x0, y0 = (W - tw) / 2, cy - th / 2

    img = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    b = t.get("box")
    if b:
        bx0, by0 = x0 - b["pad_x"], y0 - b["pad_y"]
        bx1, by1 = x0 + tw + b["pad_x"], y0 + th + b["pad_y"]
        d.rounded_rectangle([bx0, by0, bx1, by1], radius=b["radius"], fill=rgba(b["color"]),
                            outline=rgba(b["border_color"]) if b["border"] else None,
                            width=b["border"])
    for i, line in enumerate(lines):
        x = (W - widths[i]) / 2
        y = y0 + i * (lh + gap)
        for text, color in parse_runs(line, t["color"], style["highlight_color"]):
            d.text((x, y), text, font=font, fill=rgba(color),
                   stroke_width=stroke, stroke_fill=rgba(t["stroke_color"]))
            x += font.getlength(text)
    img.save(path)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--video", required=True)
    ap.add_argument("--captions", required=True)
    ap.add_argument("--style", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--preview", help="also write a contact sheet PNG of every caption")
    a = ap.parse_args()
    style = json.load(open(a.style))
    caps = json.load(open(a.captions))
    W, H = style["canvas"]["width"], style["canvas"]["height"]
    fade = style["rhythm"]["fade_in"]
    tmp = tempfile.mkdtemp()

    inputs, chain = ["-i", a.video], [
        f"[0:v]scale={W}:{H}:force_original_aspect_ratio=increase,crop={W}:{H},setsar=1[v0]"]
    for i, c in enumerate(caps):
        p = os.path.join(tmp, f"c{i}.png")
        render_caption(c, style, p)
        inputs += ["-loop", "1", "-t", str(c["end"]), "-i", p]
        chain.append(f"[{i+1}:v]format=rgba,fade=in:st={c['start']}:d={fade}:alpha=1[o{i}]")
        chain.append(f"[v{i}][o{i}]overlay=0:0:enable='between(t,{c['start']},{c['end']})'[v{i+1}]")
    last = f"[v{len(caps)}]"
    subprocess.run([FF, "-y", "-loglevel", "error", *inputs, "-filter_complex", ";".join(chain),
                    "-map", last, "-map", "0:a?", "-c:v", "libx264", "-preset", "medium", "-crf", "20",
                    "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "160k", "-shortest",
                    "-movflags", "+faststart", a.out], check=True)

    if a.preview:
        frames = []
        for i, c in enumerate(caps):
            f = os.path.join(tmp, f"p{i}.png")
            mid = (c["start"] + c["end"]) / 2
            subprocess.run([FF, "-y", "-loglevel", "error", "-ss", str(mid), "-i", a.out,
                            "-frames:v", "1", "-vf", "scale=270:480", f], check=True)
            frames.append(Image.open(f))
        cols = min(6, len(frames))
        rows = (len(frames) + cols - 1) // cols
        sheet = Image.new("RGB", (270 * cols, 480 * rows))
        for i, f in enumerate(frames):
            sheet.paste(f, (270 * (i % cols), 480 * (i // cols)))
        sheet.save(a.preview)


if __name__ == "__main__":
    main()

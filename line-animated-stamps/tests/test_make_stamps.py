import csv
import sys
import zipfile
from pathlib import Path

from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import make_stamps as ms  # noqa: E402


def _write_input(tmp_path, count=8, motion="bounce", **row):
    img = Image.new("RGBA", (300, 300), (0, 0, 0, 0))
    img.paste((255, 200, 80, 255), (50, 50, 250, 250))
    img.save(tmp_path / "a.png")
    csv_path = tmp_path / "stamps.csv"
    with csv_path.open("w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=["file", "motion", "text", "frames", "seconds", "loops"])
        w.writeheader()
        for _ in range(count):
            w.writerow({"file": "a.png", "motion": motion, "text": "", "frames": row.get("frames", 8),
                        "seconds": row.get("seconds", 1), "loops": row.get("loops", 2)})
    return csv_path


def test_build_produces_valid_set(tmp_path):
    csv_path = _write_input(tmp_path)
    out = tmp_path / "out"
    assert ms.main([str(csv_path), "-o", str(out)]) == 0
    assert ms.validate_dir(out)
    with zipfile.ZipFile(out / "line_animation_stamp.zip") as z:
        names = set(z.namelist())
    assert names == {"main.png", "tab.png"} | {f"{i:02d}.png" for i in range(1, 9)}


def test_apng_properties(tmp_path):
    csv_path = _write_input(tmp_path, frames=10, seconds=2, loops=2)
    out = tmp_path / "out"
    ms.main([str(csv_path), "-o", str(out)])
    with Image.open(out / "01.png") as im:
        assert im.size == (320, 270)
        assert im.n_frames == 10
        assert im.info["loop"] == 2
        total = 0
        for i in range(im.n_frames):
            im.seek(i)
            total += im.info["duration"]
        assert total == 2000
        # 背景は透過
        assert im.convert("RGBA").getpixel((0, 0))[3] == 0
    with Image.open(out / "main.png") as im:
        assert im.size == (240, 240) and im.n_frames == 10
    with Image.open(out / "tab.png") as im:
        assert im.size == (96, 74)


def test_loops_clamped_to_four_seconds(tmp_path):
    csv_path = _write_input(tmp_path, seconds=2, loops=4)
    out = tmp_path / "out"
    ms.main([str(csv_path), "-o", str(out)])
    with Image.open(out / "01.png") as im:
        assert im.info["loop"] == 2


def test_every_motion_ends_at_rest():
    for name, (_, fn) in ms.MOTIONS.items():
        dx, dy, scale, angle, alpha = fn(1.0, 10)
        assert abs(dx) < 1e-6 and abs(dy) < 1e-6, name
        assert abs(scale - 1) < 1e-6 and min(angle % 360, -angle % 360) < 1e-6 and alpha == 1, name


def test_validate_rejects_bad_count(tmp_path):
    csv_path = _write_input(tmp_path, count=5)
    out = tmp_path / "out"
    assert ms.main([str(csv_path), "-o", str(out)]) == 1

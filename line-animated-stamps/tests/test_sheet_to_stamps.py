import sys
from pathlib import Path

from PIL import Image, ImageDraw

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import make_stamps as ms  # noqa: E402
import sheet_to_stamps as st  # noqa: E402


def _cell(draw, x, y):
    # 文字の代わりの棒 + 下が開いた輪郭の顔 (塗りつぶしが必要なケース)
    draw.rectangle((x + 60, y + 15, x + 140, y + 35), fill=(80, 50, 40))
    draw.arc((x + 40, y + 60, x + 160, y + 180), 200, 340 + 180, fill=(80, 50, 40), width=6)
    draw.ellipse((x + 75, y + 110, x + 85, y + 120), fill=(80, 50, 40))


def _sheet(tmp_path, cols=4, rows=2):
    im = Image.new("RGB", (200 * cols, 200 * rows), "white")
    d = ImageDraw.Draw(im)
    for r in range(rows):
        for c in range(cols):
            _cell(d, c * 200, r * 200)
    path = tmp_path / "sheet.png"
    im.save(path)
    return path


def test_cut_cell_keeps_face_white_and_separates_text(tmp_path):
    cell = Image.open(_sheet(tmp_path)).crop((0, 0, 200, 200))
    text, char = st.cut_cell(cell)
    assert text.getchannel("A").getpixel((100, 25)) == 255      # 文字は文字レイヤー
    assert char.getchannel("A").getpixel((100, 25)) == 0
    assert char.getchannel("A").getpixel((110, 140)) == 255     # 顔の内側の白は残る
    assert char.getchannel("A").getpixel((5, 195)) == 0         # 背景は透明


def test_every_motion_ends_at_rest():
    for name, fn in st.CHAR.items():
        m = fn(1.0)
        assert abs(m.get("dx", 0)) < 1e-6 and abs(m.get("dy", 0)) < 1e-6, name
        assert abs(m.get("sx", 1) - 1) < 1e-6 and abs(m.get("sy", 1) - 1) < 1e-6, name
        assert min(m.get("rot", 0) % 360, -m.get("rot", 0) % 360) < 1e-6, name
    for name, fn in st.TEXT.items():
        for i in range(4):
            m = fn(1.0, i, 4)
            assert abs(m.get("dx", 0)) < 1e-6 and abs(m.get("dy", 0)) < 1e-6, name
            assert abs(m.get("sx", 1) - 1) < 1e-6 and m.get("alpha", 1) == 1, name


def test_sheet_builds_valid_set(tmp_path):
    out = tmp_path / "out"
    assert st.main([str(_sheet(tmp_path)), "--grid", "4x2", "-o", str(out)]) == 0
    assert ms.validate_dir(out)


def test_cut_cell_uses_existing_transparency():
    cell = Image.new("RGBA", (200, 200), (0, 0, 0, 0))
    d = ImageDraw.Draw(cell)
    d.rectangle((60, 15, 140, 35), fill=(80, 50, 40, 255))
    d.ellipse((40, 60, 160, 180), fill=(255, 255, 255, 255), outline=(80, 50, 40, 255), width=6)
    text, char = st.cut_cell(cell)
    assert text.getchannel("A").getpixel((100, 25)) == 255
    assert char.getchannel("A").getpixel((100, 120)) == 255     # 白い顔はそのまま不透明
    assert char.getchannel("A").getpixel((5, 195)) == 0
    assert char.getchannel("A").getpixel((100, 50)) == 0 or char.getchannel("A").getpixel((100, 45)) == 0


def test_detect_cells_handles_uneven_layout():
    # 下に大きな余白がある 2x2 の一覧画像。等分すると2段目のイラストが1段目のマスに入ってしまう
    im = Image.new("RGB", (400, 600), (245, 245, 240))
    d = ImageDraw.Draw(im)
    for cx, cy in ((100, 80), (300, 80), (100, 260), (300, 260)):
        d.ellipse((cx - 50, cy - 50, cx + 50, cy + 50), fill=(250, 230, 0), outline=(0, 0, 0), width=4)
    boxes = st.detect_cells(im, 2, 2)
    for (x0, y0, x1, y1), (cx, cy) in zip(boxes, ((100, 80), (300, 80), (100, 260), (300, 260))):
        assert x0 < cx - 50 and cx + 50 < x1 and y0 < cy - 50 and cy + 50 < y1


def test_colored_character_keeps_gaps_transparent():
    # 黄色いキャラ: 足のすき間は透明のまま、線で囲まれた白 (マグカップ) は残す
    im = Image.new("RGB", (200, 200), (245, 245, 240))
    d = ImageDraw.Draw(im)
    d.ellipse((50, 50, 150, 140), fill=(250, 230, 0), outline=(0, 0, 0), width=4)
    d.line((80, 136, 80, 162), fill=(0, 0, 0), width=4)
    d.line((120, 136, 120, 162), fill=(0, 0, 0), width=4)
    d.rectangle((150, 90, 180, 120), fill=(255, 255, 255), outline=(0, 0, 0), width=4)
    text, char = st.cut_cell(im, 0)
    a = char.getchannel("A")
    assert a.getpixel((100, 155)) == 0      # 足の間
    assert a.getpixel((165, 105)) == 255    # マグカップの白
    assert a.getpixel((100, 95)) == 255     # 体

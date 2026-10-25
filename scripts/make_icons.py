"""Draw the Citeweave icon (three woven threads with two knots) at all needed sizes."""
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1]
TEAL, SAFFRON, PAPER = (30, 111, 106, 255), (201, 138, 18, 255), (243, 245, 242, 255)


def bezier(p0, p1, p2, p3, n=60):
    pts = []
    for i in range(n + 1):
        t = i / n
        x = (1 - t) ** 3 * p0[0] + 3 * (1 - t) ** 2 * t * p1[0] + 3 * (1 - t) * t ** 2 * p2[0] + t ** 3 * p3[0]
        y = (1 - t) ** 3 * p0[1] + 3 * (1 - t) ** 2 * t * p1[1] + 3 * (1 - t) * t ** 2 * p2[1] + t ** 3 * p3[1]
        pts.append((x, y))
    return pts


def draw(size: int) -> Image.Image:
    S = 1024
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle((40, 40, S - 40, S - 40), radius=210, fill=PAPER)
    u = S / 32
    w = int(2.4 * u)
    for (y0, c1, c2, y3) in [(10, 4, 16, 10), (16, 22, 10, 16), (22, 16, 28, 22)]:
        pts = bezier((5 * u, y0 * u), (12 * u, c1 * u), (20 * u, c2 * u), (27 * u, y3 * u))
        d.line(pts, fill=TEAL, width=w, joint="curve")
        for p in (pts[0], pts[-1]):
            d.ellipse((p[0] - w / 2, p[1] - w / 2, p[0] + w / 2, p[1] + w / 2), fill=TEAL)
    for cy in (13, 19):
        r = 3.0 * u
        d.ellipse((16 * u - r, cy * u - r, 16 * u + r, cy * u + r), fill=SAFFRON)
    return img.resize((size, size), Image.LANCZOS)


if __name__ == "__main__":
    draw(256).save(ROOT / "citeweave" / "static" / "icon.png")
    (ROOT / "extension" / "icons").mkdir(parents=True, exist_ok=True)
    for s in (16, 32, 48, 128):
        draw(s).save(ROOT / "extension" / "icons" / f"icon{s}.png")
    (ROOT / "assets").mkdir(exist_ok=True)
    draw(256).save(ROOT / "assets" / "citeweave.ico", sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
    draw(512).save(ROOT / "assets" / "logo.png")
    print("icons written")

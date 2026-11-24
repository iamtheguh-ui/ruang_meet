"""Membuat ikon PNG dan favicon RuangTemu tanpa dependensi desain eksternal.

Jalankan: python tools/make_icons.py
Memerlukan Pillow (hanya untuk membangun aset, bukan untuk menjalankan server).
"""

from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageChops, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parent.parent
ICON_DIR = ROOT / "public" / "icons"
SIZE = 1024


def lerp(a: int, b: int, t: float) -> int:
    return round(a + (b - a) * t)


def gradient(size: int, start: tuple[int, int, int], end: tuple[int, int, int]) -> Image.Image:
    image = Image.new("RGB", (size, size))
    pixels = image.load()
    for y in range(size):
        for x in range(size):
            t = (x + y) / (2 * (size - 1))
            pixels[x, y] = (
                lerp(start[0], end[0], t),
                lerp(start[1], end[1], t),
                lerp(start[2], end[2], t),
            )
    return image


def radial_glow(size: int, center: tuple[int, int], radius: int, color: tuple[int, int, int], alpha: int) -> Image.Image:
    layer = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(layer)
    steps = 48
    for index in range(steps, 0, -1):
        ratio = index / steps
        current_radius = int(radius * ratio)
        current_alpha = int(alpha * (1 - ratio) ** 2)
        draw.ellipse(
            (
                center[0] - current_radius,
                center[1] - current_radius,
                center[0] + current_radius,
                center[1] + current_radius,
            ),
            fill=(*color, current_alpha),
        )
    return layer.filter(ImageFilter.GaussianBlur(radius // 12))


def rounded_mask(size: int, inset: int, radius: int) -> Image.Image:
    mask = Image.new("L", (size, size), 0)
    draw = ImageDraw.Draw(mask)
    draw.rounded_rectangle((inset, inset, size - inset, size - inset), radius=radius, fill=255)
    return mask


def build_icon(inset: int, radius: int, shadow: bool = True) -> Image.Image:
    background = gradient(SIZE, (7, 13, 25), (4, 8, 15)).convert("RGBA")
    background.alpha_composite(radial_glow(SIZE, (250, 220), 470, (34, 211, 238), 58))
    background.alpha_composite(radial_glow(SIZE, (795, 830), 500, (99, 102, 241), 62))

    tile = gradient(SIZE, (129, 140, 248), (34, 211, 238)).convert("RGBA")
    mask = rounded_mask(SIZE, inset, radius)
    tile.putalpha(mask)

    if shadow:
        shadow_layer = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
        shadow_mask = mask.filter(ImageFilter.GaussianBlur(38))
        shadow_layer.paste((0, 0, 0, 150), (0, 0), shadow_mask)
        background.alpha_composite(ImageChops.offset(shadow_layer, 0, 26))

    background.alpha_composite(tile)

    # Kilau lembut di bagian atas tile.
    shine = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    shine_draw = ImageDraw.Draw(shine)
    shine_draw.ellipse((inset + 40, inset + 10, SIZE - inset - 40, inset + 360), fill=(255, 255, 255, 34))
    shine = shine.filter(ImageFilter.GaussianBlur(42))
    shine.putalpha(Image.composite(shine.getchannel("A"), Image.new("L", (SIZE, SIZE), 0), mask))
    background.alpha_composite(shine)

    # Glyph kamera putih, mengikuti ikon SVG di antarmuka.
    glyph = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    draw = ImageDraw.Draw(glyph)
    scale = 470 / 18.5
    origin_x = SIZE / 2 - (11.75 - 2.5) * scale
    origin_y = SIZE / 2 - 12 * scale
    offset_y = -8

    def point(x: float, y: float) -> tuple[float, float]:
        return origin_x + x * scale, origin_y + y * scale + offset_y

    body = (*point(2.5, 6), *point(15.5, 18))
    draw.rounded_rectangle(body, radius=int(3 * scale), fill=(255, 255, 255, 255))
    draw.polygon(
        [
            point(15.1, 10.0),
            point(21.0, 7.2),
            point(21.0, 16.8),
            point(15.1, 14.0),
        ],
        fill=(255, 255, 255, 255),
    )

    # Titik kecil sebagai aksen "live".
    dot_radius = int(0.85 * scale)
    dot_x, dot_y = point(11.7, 13.1)
    draw.ellipse(
        (dot_x - dot_radius, dot_y - dot_radius, dot_x + dot_radius, dot_y + dot_radius),
        fill=(7, 20, 31, 190),
    )

    background.alpha_composite(glyph)
    return background


def build_maskable() -> Image.Image:
    # Versi maskable memakai latar penuh dan tile lebih besar, tetap di area aman.
    return build_icon(inset=112, radius=200)


def save_png(image: Image.Image, path: Path, size: int) -> None:
    resized = image.resize((size, size), Image.Resampling.LANCZOS)
    resized.save(path, "PNG", optimize=True)


FAVICON = """<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#818cf8"/>
      <stop offset="1" stop-color="#22d3ee"/>
    </linearGradient>
  </defs>
  <rect width="64" height="64" rx="15" fill="#070b14"/>
  <rect x="5" y="5" width="54" height="54" rx="13" fill="url(#g)"/>
  <rect x="15" y="23" width="24" height="19" rx="4.5" fill="#fff"/>
  <path d="M39 28.5 50 23v19l-11-5.5z" fill="#fff"/>
  <circle cx="31.5" cy="32.5" r="2" fill="#0b1725"/>
</svg>
"""


def main() -> None:
    ICON_DIR.mkdir(parents=True, exist_ok=True)
    icon = build_icon(inset=136, radius=212)
    maskable = build_maskable()
    save_png(icon, ICON_DIR / "icon-192.png", 192)
    save_png(icon, ICON_DIR / "icon-512.png", 512)
    save_png(maskable, ICON_DIR / "icon-maskable-512.png", 512)
    (ICON_DIR / "favicon.svg").write_text(FAVICON, encoding="utf-8")
    print("Ikon RuangTemu dibuat di", ICON_DIR)


if __name__ == "__main__":
    main()

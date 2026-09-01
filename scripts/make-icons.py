"""Generate the extension icons (icons/icon{16,32,48,128}.png).

No third-party dependency: renders with 4x supersampling into raw RGBA and
writes the PNG with zlib from the standard library.

    python scripts/make-icons.py
"""

import os
import struct
import zlib

OUT_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "icons")
SIZES = (16, 32, 48, 128)
SS = 4  # supersampling factor

BG = (0x17, 0x18, 0x1C, 255)
PILLAR = (0xFF, 0x3D, 0x32, 255)
BAR = (0xFF, 0xFF, 0xFF, 255)


def rounded_rect(x, y, cx, cy, hw, hh, r):
    """True when (x, y) is inside a rounded rectangle centred on (cx, cy).

    Signed-distance form: only the quadrant outside both straight edges is
    measured against the corner radius, so the flat edge bands stay filled.
    """
    dx = max(abs(x - cx) - (hw - r), 0.0)
    dy = max(abs(y - cy) - (hh - r), 0.0)
    return dx * dx + dy * dy <= r * r


def over(dst, src):
    """src over dst, both straight RGBA with 0-255 channels."""
    a = src[3] / 255.0
    if a >= 1.0:
        return src
    return tuple(int(round(src[i] * a + dst[i] * (1 - a))) for i in range(3)) + (255,)


def sample(u, v):
    """Colour at unit coordinates (u, v), both in [0, 1)."""
    px = BG if rounded_rect(u, v, 0.5, 0.5, 0.5, 0.5, 0.22) else (0, 0, 0, 0)
    if px[3] == 0:
        return px
    # the short itself: a vertical pillar sitting on a floor
    if rounded_rect(u, v, 0.5, 0.42, 0.16, 0.235, 0.07):
        px = over(px, PILLAR)
    # the stopper it lands on
    if rounded_rect(u, v, 0.5, 0.775, 0.29, 0.052, 0.052):
        px = over(px, BAR)
    return px


def render(size):
    rows = []
    n = size * SS
    for y in range(size):
        row = bytearray()
        for x in range(size):
            acc = [0, 0, 0, 0]
            for sy in range(SS):
                for sx in range(SS):
                    u = (x * SS + sx + 0.5) / n
                    v = (y * SS + sy + 0.5) / n
                    c = sample(u, v)
                    # premultiply so that transparent corners do not darken edges
                    a = c[3]
                    acc[0] += c[0] * a
                    acc[1] += c[1] * a
                    acc[2] += c[2] * a
                    acc[3] += a
            total_a = acc[3]
            if total_a == 0:
                row += bytes((0, 0, 0, 0))
            else:
                row += bytes(
                    (
                        min(255, int(round(acc[0] / total_a))),
                        min(255, int(round(acc[1] / total_a))),
                        min(255, int(round(acc[2] / total_a))),
                        min(255, int(round(total_a / (SS * SS)))),
                    )
                )
        rows.append(bytes(row))
    return rows


def write_png(path, size, rows):
    raw = b"".join(b"\x00" + r for r in rows)  # filter type 0 per scanline

    def chunk(tag, data):
        body = tag + data
        return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body))

    png = b"\x89PNG\r\n\x1a\n"
    png += chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
    png += chunk(b"IDAT", zlib.compress(raw, 9))
    png += chunk(b"IEND", b"")
    with open(path, "wb") as f:
        f.write(png)


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    for size in SIZES:
        path = os.path.join(OUT_DIR, "icon%d.png" % size)
        write_png(path, size, render(size))
        print("%s (%d bytes)" % (path, os.path.getsize(path)))


if __name__ == "__main__":
    main()

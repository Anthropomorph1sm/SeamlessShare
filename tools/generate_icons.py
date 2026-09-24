"""Generate sharp-edged PWA icons without external image dependencies."""
from pathlib import Path
import struct
import zlib


OUT = Path(__file__).resolve().parents[1] / "wwwroot"


def icon(size: int, name: str):
    bg = (11, 12, 12)
    mint = (184, 244, 217)
    pixels = bytearray(bg * (size * size))

    def point(x: int, y: int):
        if 0 <= x < size and 0 <= y < size:
            p = (y * size + x) * 3
            pixels[p:p + 3] = bytes(mint)

    def line(ax, ay, bx, by, weight=7):
        steps = max(abs(bx - ax), abs(by - ay)) * size // 192
        for step in range(steps + 1):
            x = round((ax + (bx - ax) * step / max(steps, 1)) * size / 192)
            y = round((ay + (by - ay) * step / max(steps, 1)) * size / 192)
            radius = max(1, round(weight * size / 384))
            for py in range(y - radius, y + radius + 1):
                for px in range(x - radius, x + radius + 1):
                    point(px, py)

    for ax, ay, bx, by in [
        (30, 56, 114, 56), (30, 56, 30, 136), (30, 136, 114, 136),
        (114, 56, 114, 136), (78, 34, 162, 34), (162, 34, 162, 114),
        (78, 34, 78, 56), (114, 114, 162, 114),
        (58, 86, 86, 86), (58, 104, 105, 104),
        (118, 136, 133, 121), (133, 121, 148, 136), (133, 121, 133, 159),
    ]:
        line(ax, ay, bx, by)

    rows = b"".join(b"\x00" + pixels[y * size * 3:(y + 1) * size * 3] for y in range(size))

    def chunk(tag, data):
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data))

    png = b"\x89PNG\r\n\x1a\n"
    png += chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 2, 0, 0, 0))
    png += chunk(b"IDAT", zlib.compress(rows, 9))
    png += chunk(b"IEND", b"")
    (OUT / name).write_bytes(png)


icon(180, "apple-touch-icon.png")
icon(192, "icon-192.png")
icon(512, "icon-512.png")

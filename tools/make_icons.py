"""Draw the app icons (no dependencies): a gold-framed card with a scan line on navy."""
import os, struct, zlib

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "app", "icons")
NAVY, GOLD, CARD, LINE = (15, 18, 26), (217, 168, 69), (36, 42, 58), (85, 201, 147)


def png(path, size):
    px = []
    cw, ch = size * 0.46, size * 0.46 * 86 / 59
    x0, y0 = (size - cw) / 2, (size - ch) / 2
    border, radius = size * 0.03, size * 0.035
    sy = y0 + ch * 0.72
    for y in range(size):
        row = bytearray([0])
        for x in range(size):
            c = NAVY
            inside = x0 <= x <= x0 + cw and y0 <= y <= y0 + ch
            if inside:
                # rounded corners
                dx = max(x0 + radius - x, 0, x - (x0 + cw - radius))
                dy = max(y0 + radius - y, 0, y - (y0 + ch - radius))
                if dx * dx + dy * dy <= radius * radius:
                    edge = min(x - x0, x0 + cw - x, y - y0, y0 + ch - y)
                    c = GOLD if edge < border else CARD
                    # artwork window
                    if x0 + cw * .14 < x < x0 + cw * .86 and y0 + ch * .2 < y < y0 + ch * .66:
                        c = (52, 60, 82)
            if abs(y - sy) < size * 0.012 and x0 - size * 0.08 < x < x0 + cw + size * 0.08:
                c = LINE
            row += bytes(c)
        px.append(bytes(row))
    raw = zlib.compress(b"".join(px), 9)
    chunk = lambda t, d: struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xffffffff)
    with open(path, "wb") as f:
        f.write(b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 2, 0, 0, 0)) + chunk(b"IDAT", raw) + chunk(b"IEND", b""))


os.makedirs(OUT, exist_ok=True)
for s in (180, 192, 512):
    png(os.path.join(OUT, f"icon-{s}.png"), s)
print("icons written")

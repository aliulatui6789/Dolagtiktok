#!/usr/bin/env python3
"""Generate the extension icons (icons/icon{16,48,128}.png) with zero dependencies.

Draws a dark rounded square with a cyan->pink circular "refresh" arrow, using
4x4 supersampling for anti-aliasing, and writes PNGs with zlib + struct only.

Usage:  python3 scripts/generate_icons.py
"""
import math
import os
import struct
import zlib

BG = (18, 18, 24)
CYAN = (37, 244, 238)
PINK = (254, 44, 85)
SIZES = (16, 48, 128)
SS = 4  # supersampling factor per axis


def lerp(a, b, t):
    return tuple(a[i] + (b[i] - a[i]) * t for i in range(3))


def in_rounded_rect(x, y, radius):
    """Unit square [0,1]^2 with rounded corners of `radius`."""
    cx = min(max(x, radius), 1 - radius)
    cy = min(max(y, radius), 1 - radius)
    return (x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2


def in_triangle(px, py, a, b, c):
    def sign(p1, p2, p3):
        return (p1[0] - p3[0]) * (p2[1] - p3[1]) - (p2[0] - p3[0]) * (p1[1] - p3[1])
    d1, d2, d3 = sign((px, py), a, b), sign((px, py), b, c), sign((px, py), c, a)
    neg = d1 < 0 or d2 < 0 or d3 < 0
    pos = d1 > 0 or d2 > 0 or d3 > 0
    return not (neg and pos)


# Geometry (unit coordinates, y down).
CX, CY = 0.5, 0.5
R_OUT, R_IN = 0.33, 0.21
GAP_START, GAP_END = math.radians(-75), math.radians(-15)  # opening at upper right
R_MID = (R_OUT + R_IN) / 2
# Arrow head sits at the ring end (angle GAP_START), pointing clockwise.
_tip_a = GAP_START
_end = (CX + R_MID * math.cos(_tip_a), CY + R_MID * math.sin(_tip_a))
_tangent = (-math.sin(_tip_a), math.cos(_tip_a))  # direction of increasing angle
_normal = (math.cos(_tip_a), math.sin(_tip_a))
HEAD_HALF, HEAD_LEN = 0.13, 0.15
ARROW = (
    (_end[0] + _normal[0] * HEAD_HALF, _end[1] + _normal[1] * HEAD_HALF),
    (_end[0] - _normal[0] * HEAD_HALF, _end[1] - _normal[1] * HEAD_HALF),
    (_end[0] - _tangent[0] * HEAD_LEN, _end[1] - _tangent[1] * HEAD_LEN),
)


def sample(x, y):
    """Return (rgb, alpha) for a unit-space point."""
    if not in_rounded_rect(x, y, 0.22):
        return None
    dx, dy = x - CX, y - CY
    dist = math.hypot(dx, dy)
    ang = math.atan2(dy, dx)
    t = ((ang - GAP_END) % (2 * math.pi)) / (2 * math.pi)  # 0..1 along the ring
    if R_IN <= dist <= R_OUT and not (GAP_START < ang < GAP_END):
        return lerp(CYAN, PINK, t)
    if in_triangle(x, y, *ARROW):
        return PINK
    return BG


def render(size):
    rows = []
    n = SS * SS
    for py in range(size):
        row = bytearray([0])  # filter type: None
        for px in range(size):
            r = g = b = a = 0.0
            for sy in range(SS):
                for sx in range(SS):
                    c = sample((px + (sx + 0.5) / SS) / size, (py + (sy + 0.5) / SS) / size)
                    if c is not None:
                        r += c[0]; g += c[1]; b += c[2]; a += 1
            if a:
                row += bytes((round(r / a), round(g / a), round(b / a), round(255 * a / n)))
            else:
                row += b"\x00\x00\x00\x00"
        rows.append(bytes(row))
    return b"".join(rows)


def png_bytes(size, raw):
    def chunk(tag, data):
        body = tag + data
        return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body) & 0xFFFFFFFF)
    ihdr = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)  # 8-bit RGBA
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b"")


def main():
    out_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "icons")
    os.makedirs(out_dir, exist_ok=True)
    for size in SIZES:
        path = os.path.join(out_dir, f"icon{size}.png")
        with open(path, "wb") as fh:
            fh.write(png_bytes(size, render(size)))
        print(f"wrote {os.path.normpath(path)}")


if __name__ == "__main__":
    main()

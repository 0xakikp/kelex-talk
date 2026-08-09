#!/usr/bin/env python3
"""Generate a kelex-themed desktop wallpaper (dark space + nebula + starfield)
so the translucent floating orb sits cohesively on top. numpy only — PNG is
encoded by hand (no PIL dependency)."""

import os
import struct
import zlib

import numpy as np

OUT_DIR = os.path.join(os.path.dirname(__file__), "..", "wallpapers")


def write_png(path, img):
    """img: HxWx3 uint8 -> baseline RGB PNG."""
    h, w, _ = img.shape
    # Prepend a filter-type byte (0 = none) to each scanline.
    rows = np.hstack([np.zeros((h, 1), np.uint8), img.reshape(h, w * 3)])
    comp = zlib.compress(rows.tobytes(), 6)

    def chunk(typ, data):
        return (
            struct.pack(">I", len(data))
            + typ
            + data
            + struct.pack(">I", zlib.crc32(typ + data) & 0xFFFFFFFF)
        )

    with open(path, "wb") as f:
        f.write(b"\x89PNG\r\n\x1a\n")
        f.write(chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)))
        f.write(chunk(b"IDAT", comp))
        f.write(chunk(b"IEND", b""))


def generate(w, h, seed=7):
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    nx, ny = xx / w, yy / h
    img = np.zeros((h, w, 3), np.float32)
    img[:] = (0, 0, 5)  # near-black base, matches --bg #000005

    def nebula(cx, cy, sx, sy, color, amp):
        g = np.exp(-(((nx - cx) / sx) ** 2 + ((ny - cy) / sy) ** 2)) * amp
        for i in range(3):
            img[:, :, i] += color[i] * g

    # Mirrors the HUD's CSS nebula: cyan core, purple low-left, blue up-right.
    nebula(0.50, 0.50, 0.42, 0.36, (0, 90, 130), 0.55)
    nebula(0.25, 0.85, 0.50, 0.40, (80, 0, 120), 0.30)
    nebula(0.80, 0.15, 0.45, 0.35, (0, 60, 100), 0.30)
    nebula(0.50, 0.46, 0.16, 0.15, (0, 150, 200), 0.16)

    # Starfield — vectorized via flat max-blend so overlaps don't sum.
    rng = np.random.default_rng(seed)
    n = int(w * h / 14000)
    sx = rng.integers(0, w, n)
    sy = rng.integers(0, h, n)
    bright = rng.uniform(0.15, 1.0, n)[:, None] ** 1.5
    blue = (rng.random(n) < 0.15)[:, None]
    col = np.where(blue, np.array([180, 220, 255.0]), np.array([255, 255, 255.0])) * bright
    flat = img.reshape(-1, 3)
    np.maximum.at(flat, sy * w + sx, col.astype(np.float32))

    return np.clip(img, 0, 255).astype(np.uint8)


if __name__ == "__main__":
    os.makedirs(OUT_DIR, exist_ok=True)
    for name, (w, h) in {
        "kelex-wallpaper-3456x2234": (3456, 2234),  # built-in 16" Retina
        "kelex-wallpaper-1920x1080": (1920, 1080),  # external display
    }.items():
        path = os.path.abspath(os.path.join(OUT_DIR, name + ".png"))
        write_png(path, generate(w, h))
        print("wrote", path)

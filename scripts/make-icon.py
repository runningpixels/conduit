#!/usr/bin/env python3
"""Render Conduit's app icons from its own BrandMark.

    pip install pillow

    # Windows / Linux: full-bleed rounded square
    python scripts/make-icon.py
    pnpm -C apps/desktop exec tauri icon apps/desktop/src-tauri/icons/icon-source-1024.png

    # macOS: Apple's inset squircle, regenerating only icon.icns
    python scripts/make-icon.py --macos
    pnpm -C apps/desktop exec tauri icon \
        apps/desktop/src-tauri/icons/icon-source-macos-1024.png -o <tmp>
    cp <tmp>/icon.icns apps/desktop/src-tauri/icons/icon.icns

The glyph is a transcription of `BrandMark` in apps/desktop/src/icons.tsx -- a
hub, three spokes, three nodes on a 24x24 viewBox. Keep the two in sync: if the
component's mark changes, re-run this rather than editing the PNGs.

Colours are the app's own tokens (packages/ui/src/tokens.css):
    --hue #d97757   the terracotta the sidebar mark takes from the provider
    --bg  #262624   the dark plate

Two deliberate departures from the component:

* BrandMark renders the two lower nodes at opacity .6, which reads as depth at
  18px but as muddy brown at icon scale, and all but vanishes at 16x16 in a
  taskbar. The icons use full opacity.
* macOS wants a different plate. Since Big Sur the convention is a squircle
  inset ~10% from the canvas, not a full-bleed rounded rect -- an edge-to-edge
  icon sits noticeably larger than its neighbours in the Dock and its corners
  do not match. `--macos` renders the body at 824/1024 with a superellipse
  (n=5) outline, which is the usual approximation of Apple's continuous-
  curvature corner. Windows and Linux have no such convention and keep the
  full-bleed plate.
"""
import argparse
import math
import pathlib
from PIL import Image, ImageDraw

ROOT = pathlib.Path(__file__).resolve().parent.parent
ICONS = ROOT / "apps/desktop/src-tauri/icons"

SIZE, SS = 1024, 4          # render at 4x and downsample; PIL has no AA
N = SIZE * SS
HUE = (217, 119, 87, 255)   # --hue  #d97757
BG = (38, 38, 36, 255)      # --bg   #262624

APPLE_BODY = 824 / 1024     # Apple's icon body within the 1024 canvas
APPLE_N = 5.0               # superellipse exponent approximating the squircle


def squircle(cx, cy, half, n, steps=2048):
    """Superellipse |x/a|^n + |y/a|^n = 1, sampled as a polygon."""
    pts = []
    for i in range(steps):
        t = 2 * math.pi * i / steps
        ct, st = math.cos(t), math.sin(t)
        x = half * math.copysign(abs(ct) ** (2 / n), ct)
        y = half * math.copysign(abs(st) ** (2 / n), st)
        pts.append((cx + x, cy + y))
    return pts


def render(macos: bool) -> pathlib.Path:
    img = Image.new("RGBA", (N, N), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    if macos:
        half = APPLE_BODY * N / 2
        d.polygon(squircle(N / 2, N / 2, half, APPLE_N), fill=BG)
        plate = APPLE_BODY * N
    else:
        # Corners left transparent so a platform's own masking has something
        # sane to mask.
        d.rounded_rectangle([0, 0, N - 1, N - 1], radius=(5 / 24) * N, fill=BG)
        plate = N

    # Content bbox inside the viewBox is x 3.5..20.5, y 1.5..19.4, so its centre
    # is (12, 10.45) -- above the viewBox centre. Centring the box instead of
    # the content would leave the mark visibly high on the plate.
    cx, cy = 12.0, 10.45
    s = (0.56 * plate) / 17.9        # glyph spans 56% of the plate
    ox, oy = N / 2 - cx * s, N / 2 - cy * s

    def P(x, y):
        return (ox + x * s, oy + y * s)

    def disc(x, y, r):
        px, py = P(x, y)
        rr = r * s
        d.ellipse([px - rr, py - rr, px + rr, py + rr], fill=HUE)

    def spoke(x1, y1, x2, y2):
        """strokeWidth 1.6 with strokeLinecap="round" = a line plus a cap disc."""
        d.line([P(x1, y1), P(x2, y2)], fill=HUE, width=round(1.6 * s))
        disc(x1, y1, 0.8)
        disc(x2, y2, 0.8)

    spoke(12, 9, 12, 3.6)            # M12 9V3.6
    spoke(14.6, 13.5, 18.4, 17.3)    # l3.8 3.8
    spoke(9.4, 13.5, 5.6, 17.3)      # l-3.8 3.8
    disc(12, 12, 3.1)                # hub
    disc(12, 3.2, 1.7)               # nodes
    disc(18.8, 17.7, 1.7)
    disc(5.2, 17.7, 1.7)

    out = ICONS / ("icon-source-macos-1024.png" if macos else "icon-source-1024.png")
    out.parent.mkdir(parents=True, exist_ok=True)
    img.resize((SIZE, SIZE), Image.LANCZOS).save(out)
    return out


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--macos", action="store_true",
                    help="render the inset squircle used for icon.icns")
    args = ap.parse_args()
    print("wrote", render(args.macos).relative_to(ROOT))

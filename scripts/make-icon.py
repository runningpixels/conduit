#!/usr/bin/env python3
"""Render the app icon from Conduit's own BrandMark, then hand it to `tauri icon`.

    pip install pillow
    python scripts/make-icon.py
    pnpm -C apps/desktop exec tauri icon apps/desktop/src-tauri/icons/icon-source-1024.png

The geometry is a transcription of `BrandMark` in apps/desktop/src/icons.tsx --
a hub, three spokes, three nodes on a 24x24 viewBox. Keep the two in sync: if
the component's mark changes, re-run this rather than editing the PNGs.

Colours are the app's own tokens (packages/ui/src/tokens.css):
    --hue #d97757   the terracotta the sidebar mark takes from the provider
    --bg  #262624   the dark plate

One deliberate difference from the component: BrandMark renders the two lower
nodes at opacity .6, which reads as depth at 18px but as muddy brown at icon
scale, and all but vanishes at 16x16 in a taskbar. The icon uses full opacity.
"""
import pathlib
from PIL import Image, ImageDraw

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = ROOT / "apps/desktop/src-tauri/icons/icon-source-1024.png"

SIZE, SS = 1024, 4          # render at 4x and downsample; PIL has no AA
N = SIZE * SS
HUE = (217, 119, 87, 255)   # --hue  #d97757
BG = (38, 38, 36, 255)      # --bg   #262624

# Content bbox inside the viewBox is x 3.5..20.5, y 1.5..19.4, so its centre is
# (12, 10.45) -- above the viewBox centre. Centring the box instead of the
# content would leave the mark visibly high on the plate.
CX, CY = 12.0, 10.45
S = (0.56 * N) / 17.9       # glyph spans 56% of the plate
OX, OY = N / 2 - CX * S, N / 2 - CY * S


def P(x, y):
    return (OX + x * S, OY + y * S)


img = Image.new("RGBA", (N, N), (0, 0, 0, 0))
d = ImageDraw.Draw(img)
# Corners left transparent so macOS's own masking has something sane to mask.
d.rounded_rectangle([0, 0, N - 1, N - 1], radius=(5 / 24) * N, fill=BG)


def disc(cx, cy, r):
    x, y = P(cx, cy)
    rr = r * S
    d.ellipse([x - rr, y - rr, x + rr, y + rr], fill=HUE)


def spoke(x1, y1, x2, y2):
    """strokeWidth 1.6 with strokeLinecap="round" = a line plus a cap disc."""
    d.line([P(x1, y1), P(x2, y2)], fill=HUE, width=round(1.6 * S))
    disc(x1, y1, 0.8)
    disc(x2, y2, 0.8)


spoke(12, 9, 12, 3.6)            # M12 9V3.6
spoke(14.6, 13.5, 18.4, 17.3)    # l3.8 3.8
spoke(9.4, 13.5, 5.6, 17.3)      # l-3.8 3.8
disc(12, 12, 3.1)                # hub
disc(12, 3.2, 1.7)               # nodes
disc(18.8, 17.7, 1.7)
disc(5.2, 17.7, 1.7)

OUT.parent.mkdir(parents=True, exist_ok=True)
img.resize((SIZE, SIZE), Image.LANCZOS).save(OUT)
print(f"wrote {OUT.relative_to(ROOT)}")

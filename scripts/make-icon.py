#!/usr/bin/env python3
"""Render Conduit's app icons from its own BrandMark -- or from a reseller's.

    pip install pillow

    # Windows / Linux: full-bleed rounded square
    python scripts/make-icon.py
    pnpm -C apps/desktop exec tauri icon apps/desktop/src-tauri/icons/icon-source-1024.png

    # macOS: Apple's inset squircle, regenerating only icon.icns
    python scripts/make-icon.py --macos
    pnpm -C apps/desktop exec tauri icon \
        apps/desktop/src-tauri/icons/icon-source-macos-1024.png -o <tmp>
    cp <tmp>/icon.icns apps/desktop/src-tauri/icons/icon.icns

    # Phase 6 white-label (Mode B): a reseller's own logo + palette, instead
    # of transcribing BrandMark. Same two invocations, plus --logo/--hue/--bg
    # on each. scripts/apply-brand-identity.mjs drives exactly this.
    python scripts/make-icon.py --logo northwind/logo.png --hue "#E4572E" --bg "#0F1115"
    python scripts/make-icon.py --macos --logo northwind/logo.png --hue "#E4572E" --bg "#0F1115"

With no arguments, this renders exactly what it always has: BrandMark's own
glyph in Conduit's own colours. `--logo`, `--hue`, and `--bg` are additive
parameters, not a rewrite -- the plate, the squircle-vs-full-bleed split, the
supersampling, and the render/save path are all unchanged.

Absent `--logo`, the glyph is a transcription of `BrandMark` in
apps/desktop/src/icons.tsx -- a hub, three spokes, three nodes on a 24x24
viewBox. Keep the two in sync: if the component's mark changes, re-run this
rather than editing the PNGs.

Default colours are the app's own tokens (packages/ui/src/tokens.css):
    --hue #d97757   the terracotta the sidebar mark takes from the provider
    --bg  #262624   the dark plate
`--hue` only affects the built-in glyph (a supplied `--logo` already carries
its own colours); `--bg` always sets the plate behind whichever mark is used.

Two deliberate departures from the component, both specific to the built-in
glyph (a `--logo` image is used as supplied):

* BrandMark renders the two lower nodes at opacity .6, which reads as depth at
  18px but as muddy brown at icon scale, and all but vanishes at 16x16 in a
  taskbar. The icons use full opacity.
* macOS wants a different plate. Since Big Sur the convention is a squircle
  inset ~10% from the canvas, not a full-bleed rounded rect -- an edge-to-edge
  icon sits noticeably larger than its neighbours in the Dock and its corners
  do not match. `--macos` renders the body at 824/1024 with a superellipse
  (n=5) outline, which is the usual approximation of Apple's continuous-
  curvature corner. Windows and Linux have no such convention and keep the
  full-bleed plate. This split applies identically to a supplied `--logo`.
"""
import argparse
import math
import pathlib
from PIL import Image, ImageDraw

ROOT = pathlib.Path(__file__).resolve().parent.parent
ICONS = ROOT / "apps/desktop/src-tauri/icons"

SIZE, SS = 1024, 4          # render at 4x and downsample; PIL has no AA
N = SIZE * SS
DEFAULT_HUE = (217, 119, 87, 255)   # --hue  #d97757
DEFAULT_BG = (38, 38, 36, 255)      # --bg   #262624

# How much of the plate a supplied --logo is scaled to fill (its longer
# dimension), centred on the full canvas. Looser than the built-in glyph's
# hand-measured 56%-of-plate rule (see `render`) because a reseller's logo
# file, unlike BrandMark, usually already carries its own padding -- filling
# the same 56% a second time would leave it looking small next to Conduit's
# own icon.
LOGO_FRACTION = 0.72

APPLE_BODY = 824 / 1024     # Apple's icon body within the 1024 canvas
APPLE_N = 5.0               # superellipse exponent approximating the squircle


def hex_to_rgba(value: str):
    """Parse `#rgb`/`#rrggbb`/`#rrggbbaa` (the same grammar brand.md's own
    validator enforces, `crates/provider-core/src/brand.rs`) into an RGBA
    tuple PIL understands. Not reused from Rust -- this is arithmetic on a
    string PIL already validated the shape of via argparse's `type=`, not a
    second brand.md parser; the actual TOML/authoring-grammar validation
    stays exclusively in Rust (see apply-brand-identity.mjs's module doc)."""
    s = value.strip().lstrip("#")
    if len(s) == 3:
        s = "".join(c * 2 for c in s)
    if len(s) == 6:
        s += "ff"
    if len(s) != 8:
        raise argparse.ArgumentTypeError(f"not a hex colour: {value!r}")
    try:
        r, g, b, a = (int(s[i : i + 2], 16) for i in (0, 2, 4, 6))
    except ValueError:
        raise argparse.ArgumentTypeError(f"not a hex colour: {value!r}")
    return (r, g, b, a)


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


def paste_logo(img: Image.Image, plate: float, logo_path: pathlib.Path) -> None:
    """Composite a reseller-supplied raster logo onto the plate, centred and
    scaled to fit -- the Mode B alternative to transcribing BrandMark.

    Unlike the built-in glyph, whose content bounding box is hand-measured
    and off-centre (see the comment in `render`), an arbitrary logo's content
    bbox is unknown, so it is simply centred on the full canvas and scaled by
    its longer dimension. `alpha_composite` (not `paste`) so a logo with soft
    or antialiased edges blends into the plate instead of leaving a hard
    rectangular seam.
    """
    logo = Image.open(logo_path).convert("RGBA")
    scale = (LOGO_FRACTION * plate) / max(logo.width, logo.height)
    size = (max(1, round(logo.width * scale)), max(1, round(logo.height * scale)))
    logo = logo.resize(size, Image.LANCZOS)
    x = round((img.width - logo.width) / 2)
    y = round((img.height - logo.height) / 2)
    img.alpha_composite(logo, (x, y))


def render(macos: bool, hue=DEFAULT_HUE, bg=DEFAULT_BG, logo: pathlib.Path = None) -> pathlib.Path:
    img = Image.new("RGBA", (N, N), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    if macos:
        half = APPLE_BODY * N / 2
        d.polygon(squircle(N / 2, N / 2, half, APPLE_N), fill=bg)
        plate = APPLE_BODY * N
    else:
        # Corners left transparent so a platform's own masking has something
        # sane to mask.
        d.rounded_rectangle([0, 0, N - 1, N - 1], radius=(5 / 24) * N, fill=bg)
        plate = N

    if logo is not None:
        paste_logo(img, plate, logo)
    else:
        # Content bbox inside the viewBox is x 3.5..20.5, y 1.5..19.4, so its
        # centre is (12, 10.45) -- above the viewBox centre. Centring the box
        # instead of the content would leave the mark visibly high on the plate.
        cx, cy = 12.0, 10.45
        s = (0.56 * plate) / 17.9        # glyph spans 56% of the plate
        ox, oy = N / 2 - cx * s, N / 2 - cy * s

        def P(x, y):
            return (ox + x * s, oy + y * s)

        def disc(x, y, r):
            px, py = P(x, y)
            rr = r * s
            d.ellipse([px - rr, py - rr, px + rr, py + rr], fill=hue)

        def spoke(x1, y1, x2, y2):
            """strokeWidth 1.6 with strokeLinecap="round" = a line plus a cap disc."""
            d.line([P(x1, y1), P(x2, y2)], fill=hue, width=round(1.6 * s))
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
    ap.add_argument("--hue", type=hex_to_rgba, default=DEFAULT_HUE,
                    help="accent colour for the built-in glyph (ignored with --logo); "
                         "default #d97757")
    ap.add_argument("--bg", type=hex_to_rgba, default=DEFAULT_BG,
                    help="plate colour behind the mark; default #262624")
    ap.add_argument("--logo", type=pathlib.Path, default=None,
                    help="composite this image instead of transcribing BrandMark "
                         "(Phase 6 white-label, Mode B)")
    args = ap.parse_args()
    if args.logo is not None and not args.logo.is_file():
        raise SystemExit(f"make-icon: --logo {args.logo} is not a file")
    out = render(args.macos, hue=args.hue, bg=args.bg, logo=args.logo)
    print("wrote", out.relative_to(ROOT))

#!/usr/bin/env python3
"""
Builds the square app icon and splash mark for `mobile/` from `logo.jpg`.

WHY THIS EXISTS
---------------
`logo.jpg` is 690x462 — not square. iOS masks an app icon with a rounded
rectangle over a square canvas, so a non-square source is either rejected by
`expo prebuild` or cropped straight through the wordmark. The fix is not to
stretch it: it is to place it on a square canvas of the logo's OWN background
colour, so the added margin is invisible and the mark keeps its true aspect
ratio.

The background colour is SAMPLED from the source rather than assumed. The first
draft of `app.json` used `#F40009` (Coca-Cola red) for the splash background,
which would have put a grey-backed wordmark on a red field and produced a
visible rectangle behind it. Measuring cost one command.

It also reports the corner spread. A source with a gradient or a vignette would
show a seam the moment it was padded, and that is worth knowing before the icon
is committed rather than after it is on a device.

USAGE
-----
    python3 scripts/dev/make-mobile-assets.py

Requires Pillow (`pip install pillow`). Outputs, both 1024x1024, which is what
`expo prebuild` wants:

    mobile/assets/icon.png          the app icon — RGB, because iOS app icons
                                    must have no alpha channel
    mobile/assets/splash-icon.png   the splash mark, RGBA and smaller on purpose,
                                    so it composites onto the splash background
"""

from __future__ import annotations

import os
from collections import Counter

from PIL import Image, ImageChops

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
SRC = os.path.join(REPO_ROOT, 'logo.jpg')
OUT_DIR = os.path.join(REPO_ROOT, 'mobile', 'assets')

CANVAS = 1024
# Fraction of the canvas width the mark occupies. The icon can afford to be
# generous; the splash mark is deliberately smaller because iOS renders it at
# roughly its natural size and a full-bleed mark reads as a launch image.
ICON_COVERAGE = 0.76
SPLASH_COVERAGE = 0.52

# A JPEG's "background" is never exactly one value, so an exact match finds
# compression speckle in every corner. 8/255 keeps that noise inside the
# background and still catches the antialiased edge of the mark.
TOLERANCE = 8


def sample_background(image: Image.Image) -> tuple[int, int, int]:
    """The logo's own background colour, measured from six edge probes."""
    width, height = image.size
    probes = {
        'top-left': (0, 0),
        'top-right': (width - 1, 0),
        'bottom-left': (0, height - 1),
        'bottom-right': (width - 1, height - 1),
        'top-mid': (width // 2, 0),
        'left-mid': (0, height // 2),
    }
    samples = {name: image.getpixel(xy) for name, xy in probes.items()}
    for name, rgb in samples.items():
        print(f'  {name:>13}: rgb{rgb} #{rgb[0]:02X}{rgb[1]:02X}{rgb[2]:02X}')

    spread = max(
        max(s[c] for s in samples.values()) - min(s[c] for s in samples.values()) for c in range(3)
    )
    print(f'  corner channel spread: {spread}')

    if spread <= 4:
        background = tuple(sum(s[c] for s in samples.values()) // len(samples) for c in range(3))
        print(f'  uniform background -> rgb{background}')
        return background

    # The most common corner, not the average. Averaging two different colours
    # invents a third that appears nowhere in the source.
    background = Counter(samples.values()).most_common(1)[0][0]
    print(f'  non-uniform corners -> using the most common: rgb{background}')
    return background


def content_bbox(image: Image.Image, background: tuple[int, int, int]) -> tuple[int, int, int, int]:
    """The tight box around the mark, ignoring background within `TOLERANCE`."""
    solid = Image.new('RGB', image.size, background)
    diff = ImageChops.difference(image, solid)
    # `convert('L')` would be luma-weighted, so a difference of 8 in blue alone
    # would collapse to ~2 and fall under the tolerance. Take the per-pixel
    # maximum across channels instead, which is what "any channel differs" means.
    red, green, blue = diff.split()
    peak = ImageChops.lighter(ImageChops.lighter(red, green), blue)
    mask = peak.point(lambda value: 255 if value > TOLERANCE else 0)

    bbox = mask.getbbox()
    if bbox is None:
        raise SystemExit('the whole image matched the background — nothing to draw')
    return bbox


def build(
    content: Image.Image,
    background: tuple[int, int, int],
    coverage: float,
    name: str,
    *,
    opaque: bool,
) -> None:
    """
    Composites the mark onto a square canvas.

    `opaque` decides the mode, and it is not cosmetic. An iOS app icon must have
    NO alpha channel — the system masks it and a translucent icon is rejected at
    submission — so the icon is written RGB with the background filling every
    pixel. The splash mark is the opposite: it is drawn over the splash
    background colour, so it keeps its alpha (RGBA) and stays transparent around
    the mark.
    """
    width, height = content.size
    scale = (CANVAS * coverage) / width
    new_size = (max(1, round(width * scale)), max(1, round(height * scale)))
    resized = content.resize(new_size, Image.LANCZOS)

    mode = 'RGB' if opaque else 'RGBA'
    canvas = Image.new(mode, (CANVAS, CANVAS), background)
    if not opaque:
        resized = resized.convert('RGBA')
    canvas.paste(resized, ((CANVAS - new_size[0]) // 2, (CANVAS - new_size[1]) // 2))
    canvas.save(os.path.join(OUT_DIR, name), 'PNG', optimize=True)
    print(
        f'  wrote {name}: {mode} canvas {CANVAS}x{CANVAS}, '
        f'mark {new_size[0]}x{new_size[1]}'
    )


def main() -> None:
    image = Image.open(SRC).convert('RGB')
    print(f'source: {image.size[0]}x{image.size[1]}')

    background = sample_background(image)
    bbox = content_bbox(image, background)
    print(f'  content bbox: {bbox}')

    content = image.crop(bbox)
    width, height = content.size
    print(f'  content: {width}x{height} (aspect {width / height:.3f})')

    os.makedirs(OUT_DIR, exist_ok=True)
    build(content, background, ICON_COVERAGE, 'icon.png', opaque=True)
    build(content, background, SPLASH_COVERAGE, 'splash-icon.png', opaque=False)


if __name__ == '__main__':
    main()

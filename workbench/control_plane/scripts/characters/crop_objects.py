#!/usr/bin/env python3
"""Crop every office-object sprite to its alpha bounding box (overwrite in place).

The 8-direction generator pads each object inside a 96px canvas with a big, uneven
transparent margin (14-38%), so anchoring a piece at left:0 leaves it floating well
off the wall. We only ever render ONE static direction per placement (never rotate an
object in-flight), so a per-direction tight crop is safe and makes edge-anchoring
exact. Idempotent: re-running on an already-tight sprite is a no-op. Also emits each
cropped sprite's aspect ratio to office-objects.generated.ts is left untouched."""
import glob
import os

from PIL import Image

ROOT = "../../public/office-objects"


def main():
    paths = sorted(glob.glob(os.path.join(ROOT, "*", "*.png")))
    trimmed = 0
    for p in paths:
        im = Image.open(p).convert("RGBA")
        bb = im.getbbox()
        if not bb:
            continue
        if bb == (0, 0, im.width, im.height):
            continue
        im.crop(bb).save(p)
        trimmed += 1
    print(f"cropped {trimmed}/{len(paths)} sprites to content")


if __name__ == "__main__":
    main()

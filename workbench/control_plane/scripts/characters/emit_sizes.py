#!/usr/bin/env python3
"""Emit the native (cropped) pixel size of every office-object sprite, per direction.

The office renders each floor object at native_size * ONE global scale factor, so all
objects share the same pixel density (a small plant and a big bookshelf keep their true
relative sizes instead of being hand-tuned). Run this after generating/cropping objects;
it just measures PNGs, no network."""
import glob
import io
import json
import os

from PIL import Image

ROOT = "../../public/office-objects"
TS = "../../src/app/observability/office-object-sizes.generated.ts"


def main():
    sizes: dict[str, dict[str, list[int]]] = {}
    for p in sorted(glob.glob(os.path.join(ROOT, "*", "*.png"))):
        name = os.path.basename(os.path.dirname(p))
        d = os.path.splitext(os.path.basename(p))[0]
        w, h = Image.open(p).size
        sizes.setdefault(name, {})[d] = [w, h]
    lines = [
        "// AUTO-GENERATED - native (cropped) pixel size of each office-object sprite",
        "// per direction. The office scales every floor object by ONE factor off these",
        "// so pixel density is uniform across objects. Do not edit by hand.",
        "",
        "export const OBJ_SIZES: Record<string, Record<string, [number, number]>> = "
        + json.dumps(sizes, indent=2, sort_keys=True)
        + ";",
        "",
    ]
    with io.open(TS, "w", encoding="utf-8", newline="\n") as f:
        f.write("\n".join(lines))
    print(f"wrote {TS} ({len(sizes)} objects)")


if __name__ == "__main__":
    main()

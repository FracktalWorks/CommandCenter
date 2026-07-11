#!/usr/bin/env python3
"""Build the office ZONED floor from the user's Pixel Lab `create_tiles_pro` sets.

Instead of repeating one tile, each zone is a MOSAIC that scatters several similar
variations across a grid → organic variation with a large repeat period. Zones:
  floor  = mosaic of the many near-identical cream tiles (the majority of the room)
  lane   = mosaic of the darker cream tiles (the walkway)
  corner = a decorative accent tile
  wall   = mosaic of wood-plank tiles (top band)
Tiles are pre-upscaled 2x (nearest) so they render crisp at natural size.
No regeneration — just downloads variations and emits the office-env manifest.
Tweak the index lists in ZONES to re-mix."""
import io
import json
import os
import random
import re
import urllib.request

from PIL import Image

import mcp

OUT = "../../public/office-env"
TS = "../../src/app/observability/office-env.generated.ts"
SCALE = 2          # upscale factor (native tiles are 32px -> 64px on screen)
SEED = 7           # deterministic mosaic layout (stable across runs)

# The user's create_tiles_pro sets (16 variations each).
SETS = {
    "cream": "7cd0feac-fc6f-47e5-b212-6f03a8ab2630",  # cream floor + darker tiles
    "wood": "e2c6c06e-c847-463a-851b-04adae703fd8",   # warm wood planks
    "honeytan": "72f290b6-b338-4e59-94e0-f20c3793ade3",  # 48px honey-tan checker
}

# role -> (set, [variation indices to mix], mosaic cols, rows). One index = plain.
ZONES = {
    # The majority of the floor: many near-identical cream variations mixed.
    "floor": ("cream", [0, 2, 3, 6, 7, 9, 10, 11, 14], 8, 8),
    "corner": ("cream", [13], 1, 1),              # decorative accent
    "lane": ("cream", [12, 15], 6, 2),            # darker walkway, mixed
    "wall": ("wood", [0, 2, 3, 7, 9, 11], 8, 2),  # wood plank band, varied
}

_UA = urllib.request.build_opener()
_UA.addheaders = [("User-Agent", "Mozilla/5.0")]


def fetch_tiles(set_key, idxs):
    out = mcp.call("get_tiles_pro", {"tile_id": SETS[set_key]})
    urls = dict((int(n), u) for n, u in re.findall(r"tile_(\d+): (https://\S+?\.png)", out))
    tiles = {}
    for i in idxs:
        tiles[i] = Image.open(io.BytesIO(_UA.open(urls[i], timeout=60).read())).convert("RGBA")
    return tiles


def mosaic(tiles, idxs, cols, rows, rng):
    s = next(iter(tiles.values())).size[0]
    out = Image.new("RGBA", (s * cols, s * rows))
    for r in range(rows):
        for c in range(cols):
            out.alpha_composite(tiles[rng.choice(idxs)], (c * s, r * s))
    return out.resize((out.width * SCALE, out.height * SCALE), Image.NEAREST)


def main():
    os.makedirs(OUT, exist_ok=True)
    rng = random.Random(SEED)
    saved = {}
    for role, (set_key, idxs, cols, rows) in ZONES.items():
        tiles = fetch_tiles(set_key, idxs)
        img = mosaic(tiles, idxs, cols, rows, rng)
        name = f"floor-{role}.png"
        img.save(f"{OUT}/{name}")
        saved[role] = f"/office-env/{name}"
        print(f"{role} <- {set_key}{idxs} {cols}x{rows} -> {name} {img.size}")

    lines = [
        "// AUTO-GENERATED - zoned office floor mosaics (create_tiles_pro), gen_honeytan.py.",
        "// Each zone is a mosaic of similar tile variations. Pre-upscaled; use natural size.",
        "// Do not edit by hand.",
        "",
        "export interface OfficeEnv {",
        "  /** Base floor mosaic (the majority of the room). */",
        "  floor?: string;",
        "  /** Decorative accent mosaic for the four room corners. */",
        "  corner?: string;",
        "  /** Darker mosaic for the walkway lanes. */",
        "  lane?: string;",
        "  /** Wood-plank mosaic for the top wall band. */",
        "  wall?: string;",
        "}",
        "",
        "export const OFFICE_ENV: OfficeEnv = {",
        f'  floor: {json.dumps(saved["floor"])},',
        f'  corner: {json.dumps(saved["corner"])},',
        f'  lane: {json.dumps(saved["lane"])},',
        f'  wall: {json.dumps(saved["wall"])},',
        "};",
        "",
    ]
    with io.open(TS, "w", encoding="utf-8", newline="\n") as f:
        f.write("\n".join(lines))
    print(f"wrote {TS}")


if __name__ == "__main__":
    main()

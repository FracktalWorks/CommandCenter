#!/usr/bin/env python3
"""Pull selected tiles from the user's Honeytan `create_tiles_pro` set and wire
them into the office as a ZONED floor (base checker + wood-plank lanes + corner
accent + wall). No regeneration — just downloads the chosen variations and emits
the office-env manifest. Swap the numbers in ZONES to re-mix.

Honeytan set: 72f290b6-... "warm honey-tan and cream checkered wooden-look floor"
(square_topdown, 48px, 16 variations)."""
import io
import json
import os
import re
import urllib.request

import mcp

OUT = "../../public/office-env"
TS = "../../src/app/observability/office-env.generated.ts"

# The user's Pixel Lab create_tiles_pro sets (16 variations each).
SETS = {
    "cream": "7cd0feac-fc6f-47e5-b212-6f03a8ab2630",  # cream floor + darker tiles
    "wood": "e2c6c06e-c847-463a-851b-04adae703fd8",   # warm wood planks
    "honeytan": "72f290b6-b338-4e59-94e0-f20c3793ade3",  # 48px honey-tan checker
}

# role -> (set, variation index 0-15). Tweak freely to re-mix the floor.
ZONES = {
    "floor": ("cream", 0),    # base: clean warm cream
    "corner": ("cream", 13),  # corners: decorative patterned accent
    "lane": ("cream", 12),    # walkways: the DARKER cream tile
    "wall": ("wood", 2),      # top wall band: horizontal wood planks
}
RENDER_PX = 64     # on-screen repeat size (native tiles are 32px)

_UA = urllib.request.build_opener()
_UA.addheaders = [("User-Agent", "Mozilla/5.0")]


def main():
    # Fetch tile URLs for each set we reference.
    need = {s for s, _ in ZONES.values()}
    urls = {}
    for s in need:
        out = mcp.call("get_tiles_pro", {"tile_id": SETS[s]})
        urls[s] = dict((int(n), u) for n, u in
                       re.findall(r"tile_(\d+): (https://\S+?\.png)", out))
    os.makedirs(OUT, exist_ok=True)
    saved = {}
    for role, (s, idx) in ZONES.items():
        data = _UA.open(urls[s][idx], timeout=60).read()
        name = f"floor-{role}.png"
        open(f"{OUT}/{name}", "wb").write(data)
        saved[role] = f"/office-env/{name}"
        print(f"{role} <- {s}#{idx} -> {name}")

    lines = [
        "// AUTO-GENERATED - Honeytan (create_tiles_pro) zoned floor, gen_honeytan.py.",
        "// Base checker + plank lanes + corner accent + wood wall. Do not edit by hand.",
        "",
        "export interface OfficeEnv {",
        "  /** Base repeating floor tile. */",
        "  floor?: string;",
        "  /** On-screen tile repeat size in px. */",
        "  floorSize?: number;",
        "  /** Accent tile for the four room corners. */",
        "  corner?: string;",
        "  /** Plank tile for the walkway lanes between areas. */",
        "  lane?: string;",
        "  /** Wood tile for the top wall band. */",
        "  wall?: string;",
        "}",
        "",
        "export const OFFICE_ENV: OfficeEnv = {",
        f'  floor: {json.dumps(saved["floor"])},',
        f"  floorSize: {RENDER_PX},",
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

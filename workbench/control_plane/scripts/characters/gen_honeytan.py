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

TILES_ID = "72f290b6-b338-4e59-94e0-f20c3793ade3"
OUT = "../../public/office-env"
TS = "../../src/app/observability/office-env.generated.ts"

# role -> Honeytan variation index (0-15). Tweak freely to re-mix the floor.
ZONES = {
    "floor": 6,    # base: bold cream/tan checker
    "corner": 9,   # corners: warm wood-and-cream checker accent
    "lane": 12,    # walkways between areas: horizontal wood planks
    "wall": 15,    # top wall band: solid warm wood planks
}
TILE_PX = 48       # native tile size
RENDER_PX = 96     # on-screen repeat size

_UA = urllib.request.build_opener()
_UA.addheaders = [("User-Agent", "Mozilla/5.0")]


def main():
    out = mcp.call("get_tiles_pro", {"tile_id": TILES_ID})
    urls = dict((int(n), u) for n, u in re.findall(r"tile_(\d+): (https://\S+?\.png)", out))
    os.makedirs(OUT, exist_ok=True)
    saved = {}
    for role, idx in ZONES.items():
        data = _UA.open(urls[idx], timeout=60).read()
        name = f"floor-{role}.png"
        open(f"{OUT}/{name}", "wb").write(data)
        saved[role] = f"/office-env/{name}"
        print(f"{role} <- tile {idx} -> {name}")

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

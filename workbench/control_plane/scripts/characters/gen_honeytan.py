#!/usr/bin/env python3
"""Build the office ZONED floor from the user's Pixel Lab `create_tiles_pro` sets.

Each zone is a MOSAIC that scatters several similar variations across a grid AND
randomly rotates each cell (square tiles → grout still lines up), so the floor
reads organic with lots of combinations from few tiles. Zones:
  floor  = mix of the many near-identical cream tiles (the majority of the room)
  lane   = mix of the darker cream tiles (the walkway)
  corner = a decorative accent
  wall   = mix of wood-plank tiles (top band; only 0/180 so planks stay vertical)
Mosaics are saved at NATIVE tile size; the on-screen tile size is set per zone via
the *Bg css background-size vars in the manifest (smaller value = smaller tiles).
No regeneration — just downloads variations. Tweak index lists / TILE_PX to re-mix."""
import io
import json
import os
import random
import re
import urllib.request

from PIL import Image, ImageEnhance

import mcp

OUT = "../../public/office-env"
TS = "../../src/app/observability/office-env.generated.ts"
TILE_PX = 40       # on-screen size of ONE tile (was ~64; smaller now)
WALL_TILE_PX = 118  # walls: BIG tiles → few, wide, full-height slats (less busy)
SEED = 7           # deterministic mosaic layout

SETS = {
    "cream": "7cd0feac-fc6f-47e5-b212-6f03a8ab2630",  # cream floor + darker tiles
    "wood": "e2c6c06e-c847-463a-851b-04adae703fd8",   # warm wood planks (old wall)
    "honeytan": "72f290b6-b338-4e59-94e0-f20c3793ade3",  # 48px honey-tan checker
    "wallslats": "0ce1e7b8-7619-4c55-8ede-2861baf6191f",  # NEW wooden wall slats 64px
}

ALL_ROT = [0, 90, 180, 270]
# role -> (set, [indices to mix], cols, rows, [allowed rotations])
ZONES = {
    "floor": ("cream", [13], 8, 8, ALL_ROT),         # the decorative tile everywhere
    "lane": ("cream", [12, 15], 6, 2, ALL_ROT),      # darker tile: office BORDER frame
    # NEW wall slats — ONE row (full-height, no seam), displayed big (WALL_TILE_PX)
    # for few + wide slats. Tiles chosen by COLOR: the cooler/cleaner light-tan planks
    # (low R-B, low R-G) that cluster together — NOT the orange-brown ones (0/5) the
    # user flagged. Many closely-colored tiles => subtle variation, uniform look.
    "wall": ("wallslats", [1, 2, 6, 8, 10], 6, 1, [0]),
}
# role -> (brightness, saturation) multipliers. Floor: flat + a bit darker (less white).
TONE = {"floor": (1.0, 0.5)}

_ROT = {0: None, 90: Image.ROTATE_90, 180: Image.ROTATE_180, 270: Image.ROTATE_270}
_UA = urllib.request.build_opener()
_UA.addheaders = [("User-Agent", "Mozilla/5.0")]


def fetch_tiles(set_key, idxs):
    out = mcp.call("get_tiles_pro", {"tile_id": SETS[set_key]})
    urls = dict((int(n), u) for n, u in re.findall(r"tile_(\d+): (https://\S+?\.png)", out))
    return {i: Image.open(io.BytesIO(_UA.open(urls[i], timeout=60).read())).convert("RGBA")
            for i in idxs}


def mosaic(tiles, idxs, cols, rows, rots, rng):
    s = next(iter(tiles.values())).size[0]
    out = Image.new("RGBA", (s * cols, s * rows))
    for r in range(rows):
        for c in range(cols):
            t = tiles[rng.choice(idxs)]
            op = _ROT[rng.choice(rots)]
            if op is not None:
                t = t.transpose(op)
            out.alpha_composite(t, (c * s, r * s))
    return out


def main():
    os.makedirs(OUT, exist_ok=True)
    rng = random.Random(SEED)
    saved, bg = {}, {}
    for role, (set_key, idxs, cols, rows, rots) in ZONES.items():
        tiles = fetch_tiles(set_key, idxs)
        img = mosaic(tiles, idxs, cols, rows, rots, rng)
        if role in TONE:
            tb, ts = TONE[role]
            img = ImageEnhance.Color(ImageEnhance.Brightness(img).enhance(tb)).enhance(ts)
        name = f"floor-{role}.png"
        img.save(f"{OUT}/{name}")
        saved[role] = f"/office-env/{name}"
        _px = WALL_TILE_PX if role == "wall" else TILE_PX
        bg[role] = f"{cols * _px}px"   # background-size (width); height auto
        print(f"{role} <- {set_key}{idxs} {cols}x{rows} rot{rots} -> {name} {img.size}")

    lines = [
        "// AUTO-GENERATED - zoned office floor mosaics (create_tiles_pro), gen_honeytan.py.",
        "// Each zone mixes + rotates similar tile variations. *Bg = css background-size.",
        "// Do not edit by hand.",
        "",
        "export interface OfficeEnv {",
        "  floor?: string; floorBg?: string;",
        "  lane?: string; laneBg?: string;",
        "  wall?: string; wallBg?: string;",
        "}",
        "",
        "export const OFFICE_ENV: OfficeEnv = {",
        f'  floor: {json.dumps(saved["floor"])}, floorBg: {json.dumps(bg["floor"])},',
        f'  lane: {json.dumps(saved["lane"])}, laneBg: {json.dumps(bg["lane"])},',
        f'  wall: {json.dumps(saved["wall"])}, wallBg: {json.dumps(bg["wall"])},',
        "};",
        "",
    ]
    with io.open(TS, "w", encoding="utf-8", newline="\n") as f:
        f.write("\n".join(lines))
    print(f"wrote {TS}")


if __name__ == "__main__":
    main()

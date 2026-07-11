#!/usr/bin/env python3
"""Slice the Pixel Lab office tileset sheet into the two seamless textures the room
uses, and emit the office-env manifest.

Input:  public/office-env/_sheet.png  (16-tile 4x4 Wang sheet, 32px, from gen_env.py)
Output: public/office-env/floor.png   (pure-carpet tile -> repeating floor)
        public/office-env/wall.png    (full-wood tile   -> repeating wall band)
        src/app/observability/office-env.generated.ts
"""
import io

from PIL import Image

SHEET = "../../public/office-env/_sheet.png"
ENVDIR = "../../public/office-env"
TS = "../../src/app/observability/office-env.generated.ts"
S = 32


def wood_frac(im, r, c):
    t = im.crop((c * S, r * S, c * S + S, r * S + S))
    px = t.load()
    wood = tot = 0
    for y in range(S):
        for x in range(S):
            R, G, B, A = px[x, y]
            if A < 40:
                continue
            tot += 1
            if R > 120 and R > B + 30 and G > B:
                wood += 1
    return wood / max(tot, 1)


def main():
    im = Image.open(SHEET).convert("RGBA")
    scores = {(r, c): wood_frac(im, r, c) for r in range(4) for c in range(4)}
    floor_rc = min(scores, key=scores.get)   # ~0% wood  -> pure carpet
    wall_rc = max(scores, key=scores.get)     # ~100% wood -> full wall

    def save(rc, name):
        r, c = rc
        im.crop((c * S, r * S, c * S + S, r * S + S)).save(f"{ENVDIR}/{name}.png")

    save(floor_rc, "floor")
    save(wall_rc, "wall")
    print(f"floor tile {floor_rc} (wood={scores[floor_rc]:.2f}), "
          f"wall tile {wall_rc} (wood={scores[wall_rc]:.2f})")

    lines = [
        "// AUTO-GENERATED - Pixel Lab office environment tiles (create_topdown_tileset).",
        "// Seamless carpet floor + wood wall sliced from the Wang sheet by build_env.py.",
        "// Do not edit by hand.",
        "",
        "export interface OfficeEnv {",
        "  /** Seamless repeating floor tile (public path). */",
        "  floor?: string;",
        "  /** Tile render size in px for the repeating background. */",
        "  floorSize?: number;",
        "  /** Optional wall / skirting tile for the top wall band. */",
        "  wall?: string;",
        "}",
        "",
        "export const OFFICE_ENV: OfficeEnv = {",
        '  floor: "/office-env/floor.png",',
        "  floorSize: 64,",
        '  wall: "/office-env/wall.png",',
        "};",
        "",
    ]
    with io.open(TS, "w", encoding="utf-8", newline="\n") as f:
        f.write("\n".join(lines))
    print(f"wrote {TS}")


if __name__ == "__main__":
    main()

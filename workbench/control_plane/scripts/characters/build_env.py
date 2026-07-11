#!/usr/bin/env python3
"""Slice the Pixel Lab office tileset sheets into the two seamless textures the room
uses, and emit the office-env manifest.

Input:  public/office-env/_floor_sheet.png (checkered ceramic floor, gen_floor.py)
        public/office-env/_sheet.png        (carpet+wood wall Wang sheet, gen_env.py)
Output: public/office-env/floor.png   (pure checkered-tile -> repeating floor)
        public/office-env/wall.png    (full-wood tile      -> repeating wall band)
        src/app/observability/office-env.generated.ts

The floor tile is used AS-IS (its checker pattern is baked in by Pixel Lab); no
synthetic brightness checker. Falls back to _sheet.png for the floor if no
dedicated floor sheet exists.
"""
import io
import os

from PIL import Image, ImageEnhance

# (brightness, saturation) multipliers applied to the floor tile. Light startup
# floor: keep it bright, just slightly desaturate so it reads as clean/neutral.
FLOOR_TONE = (1.0, 0.9)

FLOOR_SHEET = "../../public/office-env/_floor_sheet.png"
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


def pick(sheet, chooser):
    im = Image.open(sheet).convert("RGBA")
    scores = {(r, c): wood_frac(im, r, c) for r in range(4) for c in range(4)}
    rc = chooser(scores, key=scores.get)
    r, c = rc
    return im.crop((c * S, r * S, c * S + S, r * S + S)), rc, scores[rc]


def main():
    # Floor: purest checkered tile (least wood) from the dedicated floor sheet,
    # used AS-IS — the checker texture is already baked in by Pixel Lab.
    floor_sheet = FLOOR_SHEET if os.path.exists(FLOOR_SHEET) else SHEET
    floor, floor_rc, floor_wood = pick(floor_sheet, min)
    b, s = FLOOR_TONE
    floor = ImageEnhance.Color(ImageEnhance.Brightness(floor).enhance(b)).enhance(s)
    # Warm nudge toward cream (pull blue/green down a touch) so it matches the
    # warm floor palette the user liked.
    r, g, bl, a = floor.split()
    g = g.point(lambda v: int(v * 0.985))
    bl = bl.point(lambda v: int(v * 0.93))
    floor = Image.merge("RGBA", (r, g, bl, a))
    floor.save(f"{ENVDIR}/floor.png")

    # Wall: full-wood tile from the SAME sheet as the floor, so the wall matches
    # the floor's palette (light oak for the startup theme). Falls back to _sheet.png.
    wall_sheet = floor_sheet if os.path.exists(FLOOR_SHEET) else SHEET
    wall, wall_rc, wall_wood = pick(wall_sheet, max)
    wall.save(f"{ENVDIR}/wall.png")
    print(f"floor tile {floor_rc} (wood={floor_wood:.2f}) from "
          f"{os.path.basename(floor_sheet)}, wall tile {wall_rc} (wood={wall_wood:.2f})")

    lines = [
        "// AUTO-GENERATED - Pixel Lab office environment tiles (create_topdown_tileset).",
        "// Seamless checkered-ceramic floor + wood wall sliced by build_env.py.",
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

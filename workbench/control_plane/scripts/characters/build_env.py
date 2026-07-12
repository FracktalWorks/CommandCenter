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

# (brightness, saturation) multipliers applied to the floor tile. The raw Gen-3
# checker is a vivid orange; desaturate hard to the soft warm tan of the reference.
FLOOR_TONE = (1.03, 0.5)

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


def tile_lum(im, r, c):
    return im.crop((c * S, r * S, c * S + S, r * S + S)).convert("L")


def checkerness(t):
    """Mean vertical (down-column) luminance std. The checker FLOOR alternates
    light/dark down each column → high; the plank WALL is a uniform vertical
    stripe → low. Palette-independent, so it works even when both are warm."""
    px = t.load()
    total = 0.0
    for x in range(S):
        col = [px[x, y] for y in range(S)]
        m = sum(col) / S
        total += (sum((v - m) ** 2 for v in col) / S) ** 0.5
    return total / S


def dark_frac(t):
    """Fraction of near-black pixels — the Wang transition curve between floor and
    wall is a dark outline, so pure (non-transition) tiles have ~none."""
    px = t.load()
    dark = sum(1 for y in range(S) for x in range(S) if px[x, y] < 55)
    return dark / (S * S)


def main():
    floor_sheet = FLOOR_SHEET if os.path.exists(FLOOR_SHEET) else SHEET
    im = Image.open(floor_sheet).convert("RGBA")
    lum = {(r, c): tile_lum(im, r, c) for r in range(4) for c in range(4)}
    chk = {rc: checkerness(t) for rc, t in lum.items()}
    dark = {rc: dark_frac(t) for rc, t in lum.items()}
    # Pure floor = most checkered AMONG tiles with no transition outline.
    clean = [rc for rc in lum if dark[rc] < 0.04]
    floor_rc = max(clean or lum, key=lambda rc: chk[rc])
    # Plank wall = most uniform (least checkered) clean tile.
    wall_rc = min(clean or lum, key=lambda rc: chk[rc])
    scores = chk

    def crop(rc):
        r, c = rc
        return im.crop((c * S, r * S, c * S + S, r * S + S))

    # Floor: the checker tile, desaturated to the soft warm tan of the reference.
    b, s = FLOOR_TONE
    floor = ImageEnhance.Color(ImageEnhance.Brightness(crop(floor_rc)).enhance(b)).enhance(s)
    floor.save(f"{ENVDIR}/floor.png")

    # Wall: the plank tile from the same sheet (matches the floor palette).
    crop(wall_rc).save(f"{ENVDIR}/wall.png")
    print(f"floor tile {floor_rc} (checker={scores[floor_rc]:.1f}), "
          f"wall tile {wall_rc} (checker={scores[wall_rc]:.1f})")

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

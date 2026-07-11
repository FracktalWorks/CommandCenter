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

    def tile(rc):
        r, c = rc
        return im.crop((c * S, r * S, c * S + S, r * S + S))

    # Wall tile stays a single seamless texture.
    tile(wall_rc).save(f"{ENVDIR}/wall.png")

    # Floor becomes a Pokemon-style 2x2 CHECKERBOARD block of two brightness
    # variants of the carpet tile — gives visible tiling texture, still seamless.
    base = tile(floor_rc)
    from PIL import ImageEnhance
    light = ImageEnhance.Brightness(base).enhance(1.16)
    dark = ImageEnhance.Brightness(base).enhance(0.90)
    block = Image.new("RGBA", (S * 2, S * 2), (0, 0, 0, 0))
    block.alpha_composite(light, (0, 0))
    block.alpha_composite(dark, (S, 0))
    block.alpha_composite(dark, (0, S))
    block.alpha_composite(light, (S, S))
    block.save(f"{ENVDIR}/floor.png")   # 64x64 checker block
    print(f"floor tile {floor_rc} -> checker block, "
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
        "  floorSize: 96,",
        '  wall: "/office-env/wall.png",',
        "};",
        "",
    ]
    with io.open(TS, "w", encoding="utf-8", newline="\n") as f:
        f.write("\n".join(lines))
    print(f"wrote {TS}")


if __name__ == "__main__":
    main()

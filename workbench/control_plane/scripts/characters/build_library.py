#!/usr/bin/env python3
"""Assemble the reusable CHARACTER LIBRARY from char_library/ into public assets +
a TypeScript manifest the app can assign from.

Per character (char_library/<id>/):
  standing/<dir>.png  -> /character-library/<id>/standing/<dir>.png  (8 rotations)
  seated.png          -> /character-library/<id>/seated.png
  typing/<n>.png      -> packed strip /character-library/<id>/working.png (+frames)
  sleeping.png        -> /character-library/<id>/sleeping.png
  breathing/<dir>/*   -> packed strip /character-library/<id>/breathing/<dir>.png

Emits src/app/observability/character-library.generated.ts. Only characters that
have at least the base standing sprite are included; missing states are simply
omitted (the app falls back gracefully). Idempotent — re-run any time."""
import io
import json
import os

from PIL import Image

SRC = "char_library"
STATE = "library_state.json"
PUB = "../../public/character-library"
TS = "../../src/app/observability/character-library.generated.ts"
DIRS = ["south", "east", "north", "west", "south-east", "north-east",
        "north-west", "south-west"]


def pack_strip(frame_dir, out_path):
    """Pack numbered PNG frames into one horizontal strip. Returns frame count."""
    frames = sorted((f for f in os.listdir(frame_dir) if f.endswith(".png")),
                    key=lambda f: int(f.split(".")[0]))
    imgs = [Image.open(f"{frame_dir}/{f}").convert("RGBA") for f in frames]
    if not imgs:
        return 0
    w, h = imgs[0].size
    sheet = Image.new("RGBA", (w * len(imgs), h), (0, 0, 0, 0))
    for i, im in enumerate(imgs):
        sheet.alpha_composite(im, (i * w, 0))
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    sheet.save(out_path)
    return len(imgs)


def main():
    state = json.load(open(STATE)) if os.path.exists(STATE) else {}
    lib = {}
    if not os.path.isdir(SRC):
        print(f"no {SRC}/ — nothing to build")
        return
    for cid in sorted(os.listdir(SRC)):
        root = f"{SRC}/{cid}"
        if not os.path.isdir(root):
            continue
        stand_src = f"{root}/standing"
        if not os.path.exists(f"{stand_src}/south.png"):
            print(f"skip {cid}: no base sprite")
            continue
        out = f"{PUB}/{cid}"
        meta = state.get(cid, {})
        entry = {
            "id": cid,
            "gender": meta.get("gender", ""),
            "role": meta.get("role", ""),
            "description": meta.get("desc", ""),
            "portrait": f"/character-library/{cid}/standing/south.png",
        }

        stand = {}
        os.makedirs(f"{out}/standing", exist_ok=True)
        for d in DIRS:
            p = f"{stand_src}/{d}.png"
            if os.path.exists(p):
                Image.open(p).convert("RGBA").save(f"{out}/standing/{d}.png")
                stand[d] = f"/character-library/{cid}/standing/{d}.png"
        entry["standing"] = stand

        if os.path.exists(f"{root}/seated.png"):
            os.makedirs(out, exist_ok=True)
            Image.open(f"{root}/seated.png").convert("RGBA").save(f"{out}/seated.png")
            entry["seated"] = f"/character-library/{cid}/seated.png"

        if os.path.isdir(f"{root}/typing"):
            n = pack_strip(f"{root}/typing", f"{out}/working.png")
            if n:
                entry["working"] = f"/character-library/{cid}/working.png"
                entry["workingFrames"] = n

        if os.path.exists(f"{root}/sleeping.png"):
            os.makedirs(out, exist_ok=True)
            Image.open(f"{root}/sleeping.png").convert("RGBA").save(f"{out}/sleeping.png")
            entry["sleeping"] = f"/character-library/{cid}/sleeping.png"

        breathe = {}
        nb = 0
        for d in ("south", "north"):
            fdir = f"{root}/breathing/{d}"
            if os.path.isdir(fdir):
                m = pack_strip(fdir, f"{out}/breathing/{d}.png")
                if m:
                    breathe[d] = f"/character-library/{cid}/breathing/{d}.png"
                    nb = max(nb, m)
        if breathe:
            entry["breathing"] = breathe
            entry["breathingFrames"] = nb

        lib[cid] = entry
        print(f"{cid}: standing{len(stand)}"
              f"{' +seated' if 'seated' in entry else ''}"
              f"{' +typing' if 'working' in entry else ''}"
              f"{' +sleep' if 'sleeping' in entry else ''}"
              f"{' +breathe' if 'breathing' in entry else ''}")

    lines = [
        "// AUTO-GENERATED - reusable Pixel Lab character library. Assign one of these",
        "// to a new agent (or person). Static assets under public/character-library/.",
        "// Do not edit by hand — regenerate with scripts/characters/build_library.py.",
        "",
        'export type Dir = "south"|"east"|"north"|"west"|"south-east"|"north-east"'
        '|"north-west"|"south-west";',
        "export interface LibChar {",
        "  id: string; gender: string; role: string; description: string;",
        "  portrait: string; standing: Partial<Record<Dir, string>>;",
        "  seated?: string; working?: string; workingFrames?: number;",
        "  sleeping?: string;",
        "  breathing?: Partial<Record<Dir, string>>; breathingFrames?: number; }",
        "",
        "export const CHARACTER_LIBRARY: Record<string, LibChar> = {",
        *[f"  {json.dumps(cid)}: {json.dumps(v)}," for cid, v in lib.items()],
        "};",
        "",
        "export const LIBRARY_IDS = Object.keys(CHARACTER_LIBRARY);",
        "",
    ]
    with io.open(TS, "w", encoding="utf-8", newline="\n") as f:
        f.write("\n".join(lines))
    print(f"wrote {TS} ({len(lib)} characters)")


if __name__ == "__main__":
    main()

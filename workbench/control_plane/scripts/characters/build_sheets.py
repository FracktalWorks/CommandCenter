#!/usr/bin/env python3
"""Assemble the office cast assets from char_seated/:
- copy each seated south sprite -> public/characters-seated/<agent>/seated.png
- pack idle frames -> public/characters-seated/<agent>/idle.png (horizontal strip)
- emit src/app/observability/office-cast.generated.ts (sprite + idle frame count)."""
import io
import json
import os

from PIL import Image

AGENTS = ["orchestrator", "apis-config", "sales", "task-manager", "email-assistant",
          "reconciler", "delivery", "billing", "strategy"]
SRC = "char_seated"
PUB = "../../public/characters-seated"
TS = "../../src/app/observability/office-cast.generated.ts"
DIRS = ["south", "east", "north", "west", "south-east", "north-east", "north-west",
        "south-west"]


def main():
    cast = {}
    for a in AGENTS:
        seated = f"{SRC}/{a}/south.png"
        if not os.path.exists(seated):
            print(f"skip {a}: no seated sprite")
            continue
        out = f"{PUB}/{a}"
        os.makedirs(out, exist_ok=True)
        Image.open(seated).convert("RGBA").save(f"{out}/seated.png")
        entry = {"seated": f"/characters-seated/{a}/seated.png"}
        # Drop any earlier standing breathing-idle sheet (it broke the seated pose).
        for stale in (f"{out}/idle.png",):
            if os.path.exists(stale):
                os.remove(stale)

        # 'working' = the custom v3 seated-typing animation (keeps the seated pose).
        typ_dir = f"{SRC}/{a}/typing"
        if os.path.isdir(typ_dir):
            frames = sorted(
                (f for f in os.listdir(typ_dir) if f.endswith(".png")),
                key=lambda f: int(f.split(".")[0]))
            imgs = [Image.open(f"{typ_dir}/{f}").convert("RGBA") for f in frames]
            if imgs:
                w, h = imgs[0].size
                sheet = Image.new("RGBA", (w * len(imgs), h), (0, 0, 0, 0))
                for i, im in enumerate(imgs):
                    sheet.alpha_composite(im, (i * w, 0))
                sheet.save(f"{out}/working.png")
                entry["working"] = f"/characters-seated/{a}/working.png"
                entry["workingFrames"] = len(imgs)

        # 'sleeping' = asleep-at-desk seated sprite (used when idle).
        sleep_src = f"{SRC}/{a}/sleeping.png"
        if os.path.exists(sleep_src):
            Image.open(sleep_src).convert("RGBA").save(f"{out}/sleeping.png")
            entry["sleeping"] = f"/characters-seated/{a}/sleeping.png"

        # 'standing' = the base char's 8 rotations (agents standing round the table).
        stand_src = f"{SRC}/{a}/standing"
        if os.path.isdir(stand_src):
            stand: dict[str, str] = {}
            sd = f"{out}/standing"
            os.makedirs(sd, exist_ok=True)
            for dr in DIRS:
                p = f"{stand_src}/{dr}.png"
                if os.path.exists(p):
                    Image.open(p).convert("RGBA").save(f"{sd}/{dr}.png")
                    stand[dr] = f"/characters-seated/{a}/standing/{dr}.png"
            if stand:
                entry["standing"] = stand

        # 'breathing' = the gentle standing-idle animation for the conference room.
        # Per-direction frame PNGs -> one horizontal strip sheet per direction.
        breathe_src = f"{SRC}/{a}/breathing"
        if os.path.isdir(breathe_src):
            breathe: dict[str, str] = {}
            nframes = 0
            bd = f"{out}/breathing"
            for dr in ("south", "north"):
                fdir = f"{breathe_src}/{dr}"
                if not os.path.isdir(fdir):
                    continue
                frames = sorted(
                    (f for f in os.listdir(fdir) if f.endswith(".png")),
                    key=lambda f: int(f.split(".")[0]))
                imgs = [Image.open(f"{fdir}/{f}").convert("RGBA") for f in frames]
                if not imgs:
                    continue
                os.makedirs(bd, exist_ok=True)
                w, h = imgs[0].size
                sheet = Image.new("RGBA", (w * len(imgs), h), (0, 0, 0, 0))
                for i, im in enumerate(imgs):
                    sheet.alpha_composite(im, (i * w, 0))
                sheet.save(f"{bd}/{dr}.png")
                breathe[dr] = f"/characters-seated/{a}/breathing/{dr}.png"
                nframes = max(nframes, len(imgs))
            if breathe:
                entry["breathing"] = breathe
                entry["breathingFrames"] = nframes

        cast[a] = entry
        print(f"{a}: seated{' + working x' + str(entry.get('workingFrames', 0)) if 'working' in entry else ''}")

    lines = [
        "// AUTO-GENERATED - Pixel Lab seated office cast (create_character_state +",
        "// breathing-idle). Static assets under public/characters-seated/. Do not edit.",
        "",
        'export type Dir = "south"|"east"|"north"|"west"|"south-east"|"north-east"'
        '|"north-west"|"south-west";',
        "export interface OfficeChar { seated: string; working?: string;",
        "  workingFrames?: number; sleeping?: string;",
        "  standing?: Partial<Record<Dir, string>>;",
        "  breathing?: Partial<Record<Dir, string>>; breathingFrames?: number }",
        "",
        "export const OFFICE_CAST: Record<string, OfficeChar> = {",
        *[f"  {json.dumps(a)}: {json.dumps(v)}," for a, v in cast.items()],
        "};",
        "",
    ]
    with io.open(TS, "w", encoding="utf-8", newline="\n") as f:
        f.write("\n".join(lines))
    print(f"wrote {TS} ({len(cast)} agents)")


if __name__ == "__main__":
    main()

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
        cast[a] = entry
        print(f"{a}: seated{' + working x' + str(entry.get('workingFrames', 0)) if 'working' in entry else ''}")

    lines = [
        "// AUTO-GENERATED - Pixel Lab seated office cast (create_character_state +",
        "// breathing-idle). Static assets under public/characters-seated/. Do not edit.",
        "",
        "export interface OfficeChar { seated: string; working?: string; workingFrames?: number }",
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

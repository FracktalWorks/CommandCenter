#!/usr/bin/env python3
"""Regenerate ALL office objects in one consistent Gen-3 Pokemon-Center style:
front-facing top-down oblique (view='low top-down' so you see each object's FRONT,
not a flat overhead), detailed shading, single-color outline. Cozy 16-bit GBA JRPG.
Downloads to public/office-props/<name>.png. Writes gen3_ids.json for resume."""
import json
import os
import re
import time
import urllib.request

import mcp

OUT = "../../public/office-props"
IDS = "gen3_ids.json"
STYLE = "cozy 16-bit Game Boy Advance Pokemon Center JRPG pixel art"
_UA = urllib.request.build_opener()
_UA.addheaders = [("User-Agent", "Mozilla/5.0")]

# name -> (description, width, height)
SPEC = {
    "stool": (f"a small round cushioned stool pouf, {STYLE}", 40, 40),
    "chair": (f"an office meeting chair with a teal cushion seat, front view, {STYLE}", 44, 54),
    "plant": (f"a leafy potted plant in a white pot, front view, {STYLE}", 60, 76),
    "water-cooler": (f"an office water cooler with a blue bottle on top, front view, {STYLE}", 56, 80),
    "coffee": (f"a coffee machine on a small counter, front view, {STYLE}", 68, 62),
    "bookshelf": (f"a tall wooden bookshelf full of colourful books, front view, {STYLE}", 84, 96),
    "sofa": (f"a comfy two-seater lounge couch, front view, {STYLE}", 104, 66),
    "conference-table": (f"a long rectangular wooden meeting table, front view, {STYLE}", 168, 84),
}


def parse_id(out):
    return next((l.split(":", 1)[1].strip() for l in out.splitlines()
                 if l.strip().lower().startswith("id:")), None)


def rotation_url(out):
    m = re.search(r"https://\S+?/rotations/\S+?\.png", out)
    return m.group(0) if m else None


def main():
    os.makedirs(OUT, exist_ok=True)
    ids = json.load(open(IDS)) if os.path.exists(IDS) else {}
    done = set()
    for _ in range(80):
        for name, (desc, w, h) in SPEC.items():
            if ids.get(name):
                continue
            out = mcp.call("create_map_object", {
                "description": desc, "width": w, "height": h,
                "view": "low top-down", "outline": "single color outline",
                "shading": "detailed shading"})
            oid = parse_id(out)
            if oid:
                ids[name] = oid
                print(f"queued {name}: {oid}")
            else:
                print(f"busy {name}: {out[:80]}")
            json.dump(ids, open(IDS, "w"), indent=2)
            time.sleep(3)
        for name in SPEC:
            oid = ids.get(name)
            if not oid or name in done:
                continue
            out = mcp.call("get_object", {"object_id": oid})
            if "status: completed" in out:
                url = rotation_url(out)
                if url:
                    try:
                        data = _UA.open(url, timeout=60).read()
                        open(f"{OUT}/{name}.png", "wb").write(data)
                        done.add(name)
                        print(f"DONE {name}")
                    except Exception as e:  # noqa: BLE001
                        print(f"dl fail {name}: {e}")
            else:
                print(f".. {name}: {out.splitlines()[0] if out else ''}")
        if len(done) == len(SPEC):
            print("ALL GEN3 OBJECTS DONE")
            return
        time.sleep(15)


if __name__ == "__main__":
    main()

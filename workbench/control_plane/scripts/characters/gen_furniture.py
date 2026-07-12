#!/usr/bin/env python3
"""Generate pixel-art meeting chairs + refreshed office props that fit the light
startup-office style (view='high top-down' to match the seated agents).
Downloads to public/office-props/<name>.png. Writes furniture_ids.json."""
import json
import os
import re
import time
import urllib.request

import mcp

OUT = "../../public/office-props"
IDS = "furniture_ids.json"
_UA = urllib.request.build_opener()
_UA.addheaders = [("User-Agent", "Mozilla/5.0")]

# name -> (description, width, height)
SPEC = {
    "chair": ("a modern office swivel meeting chair with a teal cushion seat, "
              "seen from behind", 44, 52),
    "plant": ("a tall leafy potted office plant in a clean white pot", 60, 76),
    "water-cooler": ("a sleek modern office water cooler with a blue bottle on top", 56, 80),
    "coffee": ("a modern espresso coffee machine on a light wood counter", 72, 60),
    "bookshelf": ("a modern light oak office shelving unit with colorful books "
                  "and a small plant", 88, 92),
    "sofa": ("a small modern two-seater office lounge sofa in light grey fabric", 104, 64),
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
                "view": "high top-down", "outline": "single color outline",
                "shading": "basic shading"})
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
            print("ALL FURNITURE DONE")
            return
        time.sleep(15)


if __name__ == "__main__":
    main()

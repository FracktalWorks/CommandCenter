#!/usr/bin/env python3
"""Regenerate office props FLATTER (view='high top-down' instead of the old
'low top-down' that read as three-quarter), and add conference-room pieces.
Downloads to public/office-props/<name>.png. Writes prop_ids2.json for resume."""
import json
import os
import re
import time
import urllib.request

import mcp

OUT = "../../public/office-props"
IDS = "prop_ids2.json"
_UA = urllib.request.build_opener()
_UA.addheaders = [("User-Agent", "Mozilla/5.0")]

# name -> (description, width, height)
SPEC = {
    "plant": ("a potted green office plant in a terracotta pot", 56, 56),
    "water-cooler": ("an office water cooler dispenser with a blue water bottle on top", 56, 80),
    "coffee": ("a small coffee maker machine", 56, 56),
    "bookshelf": ("a wooden bookshelf filled with colorful books", 80, 88),
    "conference-table": ("a long rectangular wooden conference meeting table, empty top", 200, 120),
    "rug": ("a soft rectangular grey area rug, plain", 160, 120),
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
    for _ in range(60):
        # queue anything missing an id
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
        # poll + download
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
            print("ALL PROPS DONE")
            return
        time.sleep(15)


if __name__ == "__main__":
    main()

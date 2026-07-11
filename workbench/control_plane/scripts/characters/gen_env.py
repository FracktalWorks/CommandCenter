#!/usr/bin/env python3
"""Generate the OFFICE ENVIRONMENT tiles via Pixel Lab (seamless, tileable).

- A top-down Wang tileset (floor + wall transition) -> office floor + walls.
- Downloads every tile PNG + the example map to public/office-env/.
Writes env_ids.json so it can resume. Run:  python gen_env.py
"""
import json
import os
import re
import time
import urllib.request

import mcp

OUT = "../../public/office-env"
IDS = "env_ids.json"
_UA = urllib.request.build_opener()
_UA.addheaders = [("User-Agent", "Mozilla/5.0")]

# One Wang tileset: carpet floor (lower) rising into a wainscot wall (upper).
TILESET = {
    "lower_description": "dark slate blue office carpet floor with a subtle woven texture",
    "upper_description": "warm wood office wall base with a light skirting board",
    "transition_size": 0.25,
    "transition_description": "wooden skirting board where wall meets carpet",
    "tile_size": {"width": 32, "height": 32},
}


def parse_id(out):
    return next((l.split(":", 1)[1].strip() for l in out.splitlines()
                 if l.strip().lower().startswith(("id:", "tileset_id:"))), None)


def download(text, prefix):
    os.makedirs(OUT, exist_ok=True)
    urls = re.findall(r"https://\S+?\.png(?:\?\S+)?", text)
    n = 0
    seen = set()
    for u in urls:
        u = u.rstrip(").,")
        if u in seen:
            continue
        seen.add(u)
        try:
            data = _UA.open(u, timeout=60).read()
            open(f"{OUT}/{prefix}_{n:02d}.png", "wb").write(data)
            n += 1
        except Exception as e:  # noqa: BLE001
            print(f"  dl fail {u[:60]}: {e}")
    return n


def main():
    ids = json.load(open(IDS)) if os.path.exists(IDS) else {}
    if not ids.get("tileset"):
        out = mcp.call("create_topdown_tileset", TILESET)
        tid = parse_id(out)
        print("create_topdown_tileset ->", tid or out[:200])
        if tid:
            ids["tileset"] = tid
            json.dump(ids, open(IDS, "w"), indent=2)
    tid = ids.get("tileset")
    if not tid:
        return
    for _ in range(60):
        out = mcp.call("get_topdown_tileset", {"tileset_id": tid})
        first = out.splitlines()[0] if out else ""
        if "status: completed" in out or "completed" in first.lower():
            os.makedirs(OUT, exist_ok=True)
            open(f"{OUT}/_tileset_raw.txt", "w", encoding="utf-8").write(out)
            n = download(out, "floor")
            print(f"TILESET DONE: downloaded {n} images -> {OUT}")
            return
        print(".. tileset:", first[:80])
        time.sleep(20)
    print("gave up waiting; check get_topdown_tileset", tid)


if __name__ == "__main__":
    main()

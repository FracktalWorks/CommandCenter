#!/usr/bin/env python3
"""Download ALL 8 standing directions per agent (base char) -> char_seated/<a>/standing/<dir>.png."""
import json, os, re, time, urllib.request
import mcp
BASE = json.load(open("ids.json"))
DIRS = ["south", "east", "north", "west", "south-east", "north-east", "north-west", "south-west"]
ROOT = "char_seated"
UA = urllib.request.build_opener(); UA.addheaders = [("User-Agent", "Mozilla/5.0")]
for a, cid in BASE.items():
    d = f"{ROOT}/{a}/standing"
    if os.path.exists(f"{d}/west.png"):
        print(f"{a}: already have"); continue
    out = mcp.call("get_character", {"character_id": cid, "include_preview": False})
    urls = dict(re.findall(r"  ([\w-]+): (https://\S+\.png\?t=\d+)", out))
    os.makedirs(d, exist_ok=True); n = 0
    for dr in DIRS:
        if dr in urls:
            try:
                open(f"{d}/{dr}.png", "wb").write(UA.open(urls[dr], timeout=60).read()); n += 1
            except Exception as e:  # noqa: BLE001
                print(f"  fail {a}/{dr}: {e}")
    print(f"{a}: {n}/8 standing dirs")
    time.sleep(1)

#!/usr/bin/env python3
"""Stage A: seated 'working at a desk' state per agent (create_character_state),
download all 8 rotations. Proves + uses the inpainting permutation path. Waves
of <=6 concurrent. Writes seated_ids.json + char_seated/<agent>/<dir>.png."""
import json
import os
import re
import time
import urllib.request

import mcp

DIRS = ["south", "east", "north", "west", "south-east", "north-east", "north-west", "south-west"]
EDIT = "sitting on an office chair working at a desk, typing on a computer keyboard"
_UA = urllib.request.build_opener()
_UA.addheaders = [("User-Agent", "Mozilla/5.0")]


def parse_id(out):
    return next((l.split(":", 1)[1].strip() for l in out.splitlines()
                 if l.strip().startswith("id:")), None)


def download(agent, out_text, root):
    d = f"{root}/{agent}"
    os.makedirs(d, exist_ok=True)
    urls = dict(re.findall(r"  ([\w-]+): (https://\S+\.png\?t=\d+)", out_text))
    n = 0
    for name in DIRS:
        if name in urls:
            try:
                open(f"{d}/{name}.png", "wb").write(_UA.open(urls[name], timeout=60).read())
                n += 1
            except Exception as e:  # noqa: BLE001
                print(f"  dl fail {agent}/{name}: {e}")
    return n


def main():
    base = json.load(open("ids.json"))
    seated = json.load(open("seated_ids.json")) if os.path.exists("seated_ids.json") else {}
    root = "char_seated"
    done = {a for a in base if os.path.exists(f"{root}/{a}/south.png")}
    print("resume: done", sorted(done))

    for _ in range(80):
        active = sum(1 for a, i in seated.items() if i and a not in done)
        # queue missing seated states under the cap
        for a in base:
            if a in done or seated.get(a):
                continue
            if active >= 6:
                break
            out = mcp.call("create_character_state", {
                "character_id": base[a], "edit_description": EDIT})
            sid = parse_id(out)
            if sid:
                seated[a] = sid
                active += 1
                print(f"queued seated {a}: {sid}")
            else:
                print(f"busy {a}: {out[:70]}")
            json.dump(seated, open("seated_ids.json", "w"), indent=2)
            time.sleep(4)
        # poll
        for a, sid in list(seated.items()):
            if not sid or a in done:
                continue
            out = mcp.call("get_character", {"character_id": sid, "include_preview": False})
            if "status: completed" in out:
                n = download(a, out, root)
                done.add(a)
                print(f"DONE seated {a}: {n}/8")
            else:
                print(f".. {a}: {out.splitlines()[0] if out else ''}")
        if all(a in done for a in base):
            print("ALL SEATED DONE")
            return
        time.sleep(25)


if __name__ == "__main__":
    main()

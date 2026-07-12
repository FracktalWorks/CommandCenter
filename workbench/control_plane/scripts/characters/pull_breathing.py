#!/usr/bin/env python3
"""Re-download the breathing frames from each agent's (already generated) animation,
overwriting any partial set. No generation — just fetches whatever get_character now
lists as complete, so directories that were captured mid-render get their full 9
frames. Run after gen_breathing.py, then build_sheets.py."""
import json
import os
import re
import shutil
import time
import urllib.request

import mcp

BASE = json.load(open("ids.json"))
DIRS = ["south", "north"]
_UA = urllib.request.build_opener()
_UA.addheaders = [("User-Agent", "Mozilla/5.0")]


def frames_for(out_text, dir_):
    m = re.search(r"\(" + re.escape(dir_) + r", \d+f\)[^\n]*\n\s*frames: ([^\n]+)", out_text)
    if not m:
        return []
    return [u.strip() for u in m.group(1).split(",") if u.strip().startswith("http")]


def main():
    for a, cid in BASE.items():
        out = mcp.call("get_character", {"character_id": cid, "include_preview": False})
        for d in DIRS:
            fr = frames_for(out, d)
            dd = f"char_seated/{a}/breathing/{d}"
            have = len(os.listdir(dd)) if os.path.isdir(dd) else 0
            if len(fr) < 8:
                print(f"{a}/{d}: server lists {len(fr)} frames (have {have}) — skip")
                continue
            if have == len(fr):
                print(f"{a}/{d}: already {have} frames — ok")
                continue
            if os.path.isdir(dd):
                shutil.rmtree(dd)
            os.makedirs(dd)
            for i, u in enumerate(fr):
                try:
                    open(f"{dd}/{i}.png", "wb").write(_UA.open(u, timeout=60).read())
                except Exception as e:  # noqa: BLE001
                    print(f"  dl fail {a}/{d}/{i}: {e}")
            print(f"{a}/{d}: repulled {len(fr)} frames")
        time.sleep(1)


if __name__ == "__main__":
    main()

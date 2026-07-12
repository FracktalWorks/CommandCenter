#!/usr/bin/env python3
"""Generate test-coder's breathing S/N so it animates in the office/picker like the
rest of the library. Uses the cheap `breathing-idle` TEMPLATE (1 generation /
direction) on the 8-dir standing base, downloads the frames into
char_library/test-coder/breathing/<dir>/<n>.png, then build_library.py packs them.
Subscription generations are exhausted, so this draws on the $5 credit balance."""
import os
import re
import time
import urllib.request

import mcp

BASE = "65136a2a-a157-4f62-b228-3e1f584b6e4d"
ROOT = "char_library/test-coder/breathing"
DIRS = ["south", "north"]
_UA = urllib.request.build_opener()
_UA.addheaders = [("User-Agent", "Mozilla/5.0")]


def gens():
    for l in mcp.call("get_balance", {}).splitlines():
        if "generations_remaining" in l:
            return int(l.split(":")[1])
    return -1


def idle_frames(out_text, dir_):
    m = re.search(r"breathing-idle \(" + re.escape(dir_) + r", \d+f\)[^\n]*\n\s*frames: ([^\n]+)",
                  out_text)
    if not m:
        return []
    return [u.strip() for u in m.group(1).split(",") if u.strip().startswith("http")]


def main():
    print("credits before:", [l for l in mcp.call("get_balance", {}).splitlines()
                               if "credit" in l], "gens:", gens(), flush=True)
    out = mcp.call("animate_character", {
        "character_id": BASE, "template_animation_id": "breathing-idle", "directions": DIRS})
    print("queued:", out[:80], flush=True)

    pending = set(DIRS)
    t0 = time.time()
    while pending and time.time() - t0 < 600:
        o = mcp.call("get_character", {"character_id": BASE, "include_preview": False})
        for d in list(pending):
            fr = idle_frames(o, d)
            if len(fr) >= 4:
                dd = f"{ROOT}/{d}"
                os.makedirs(dd, exist_ok=True)
                for i, u in enumerate(fr):
                    open(f"{dd}/{i}.png", "wb").write(_UA.open(u, timeout=60).read())
                print(f"downloaded {d}: {len(fr)} frames", flush=True)
                pending.discard(d)
        if pending:
            time.sleep(18)
    print("credits after:", [l for l in mcp.call("get_balance", {}).splitlines()
                             if "credit" in l], "gens:", gens(), flush=True)
    print("REMAIN", pending if pending else "none — DONE", flush=True)


if __name__ == "__main__":
    main()

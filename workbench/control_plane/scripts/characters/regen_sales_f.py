#!/usr/bin/env python3
"""Regenerate sales-f's STANDING (base) + BREATHING — the original base generated as
a bust instead of a full-body top-down sprite. The good desk states (seated / typing
/ sleeping) still exist on Pixel Lab, so re-download those instead of regenerating.

Style/size "reference" = the IDENTICAL generation settings the other 7 library
characters used (v3, size 64, low top-down, same STYLE), plus an explicit full-body
instruction to avoid the bust framing. Rebuilds char_library/sales-f/ so
build_library.py can repack it. ~8 generations."""
import json
import os
import re
import time
import urllib.request

import mcp

STYLE = "cute pixel art RPG character, front view, friendly, clean outline"
DESC = ("a female sales lead in a burgundy blazer over a white top, small hoop "
        "earrings, straight shoulder-length brown hair, tan skin, full body "
        "standing character shown head to toe, small character sprite")
DIRS = ["south", "east", "north", "west", "south-east", "north-east",
        "north-west", "south-west"]
BREATHE_DIRS = ["south", "north"]
ACT_BREATHE = ("standing still and relaxed, breathing gently, chest and shoulders "
               "rising and falling slightly, a subtle calm idle sway, feet planted")
ROOT = "char_library/sales-f"
SEATED_ID = "2b25c3f4-256c-4fc3-81d7-1c00248b8890"
SLEEP_ID = "ec1c277d-4223-4ca7-ae64-6ba21e976618"
_UA = urllib.request.build_opener()
_UA.addheaders = [("User-Agent", "Mozilla/5.0")]


def parse_id(out):
    return next((l.split(":", 1)[1].strip() for l in out.splitlines()
                 if l.strip().lower().startswith("id:")), None)


def wait_completed(cid, timeout=420):
    t0 = time.time()
    while time.time() - t0 < timeout:
        out = mcp.call("get_character", {"character_id": cid, "include_preview": False})
        if "status: completed" in out:
            return out
        if "status: failed" in out:
            return None
        time.sleep(15)
    return None


def dl_rotations(out_text, dest):
    os.makedirs(dest, exist_ok=True)
    urls = dict(re.findall(r"  ([\w-]+): (https://\S+\.png\?t=\d+)", out_text))
    n = 0
    for d in DIRS:
        if d in urls:
            try:
                open(f"{dest}/{d}.png", "wb").write(_UA.open(urls[d], timeout=60).read())
                n += 1
            except Exception as e:  # noqa: BLE001
                print("  dl fail", d, e)
    return n


def dl_south(out_text, path):
    m = re.search(r"  south: (https://\S+\.png\?t=\d+)", out_text)
    if not m:
        return False
    os.makedirs(os.path.dirname(path), exist_ok=True)
    open(path, "wb").write(_UA.open(m.group(1), timeout=60).read())
    return True


def anim_frames(out_text, dir_):
    m = re.search(r"\(" + re.escape(dir_) + r", \d+f\)[^\n]*\n\s*frames: ([^\n]+)", out_text)
    if not m:
        return []
    return [u.strip() for u in m.group(1).split(",") if u.strip().startswith("http")]


def wait_anim(cid, dirs, timeout=600):
    t0 = time.time()
    while time.time() - t0 < timeout:
        out = mcp.call("get_character", {"character_id": cid, "include_preview": False})
        if all(len(anim_frames(out, d)) >= 8 for d in dirs):
            return out
        time.sleep(18)
    return mcp.call("get_character", {"character_id": cid, "include_preview": False})


def main():
    state = json.load(open("library_state.json"))
    rec = state.get("sales-f", {"gender": "female", "role": "sales", "desc": DESC})

    # 1) fresh full-body base (same settings as the other library characters)
    if not rec.get("base") or not os.path.exists(f"{ROOT}/standing/south.png"):
        if not rec.get("base"):
            out = mcp.call("create_character", {
                "description": f"{DESC}, {STYLE}", "name": "lib-sales-f",
                "mode": "v3", "size": 64, "view": "low top-down"})
            rec["base"] = parse_id(out)
            print("new base:", rec["base"])
            state["sales-f"] = rec
            json.dump(state, open("library_state.json", "w"), indent=2)
        out = wait_completed(rec["base"])
        if out:
            print("standing rotations:", dl_rotations(out, f"{ROOT}/standing"))

    # 2) breathing on the new base (south + north)
    if not os.path.exists(f"{ROOT}/breathing/south/0.png"):
        mcp.call("animate_character", {
            "character_id": rec["base"], "mode": "v3", "animation_name": "breathing",
            "action_description": ACT_BREATHE, "directions": BREATHE_DIRS})
        out = wait_anim(rec["base"], BREATHE_DIRS)
        for d in BREATHE_DIRS:
            fr = anim_frames(out, d)
            if len(fr) >= 8:
                dd = f"{ROOT}/breathing/{d}"
                os.makedirs(dd, exist_ok=True)
                for i, u in enumerate(fr):
                    open(f"{dd}/{i}.png", "wb").write(_UA.open(u, timeout=60).read())
                print(f"breathing {d}: {len(fr)}")

    # 3) re-download the GOOD desk states (unchanged) from the existing characters
    sout = mcp.call("get_character", {"character_id": SEATED_ID, "include_preview": False})
    print("seated:", dl_south(sout, f"{ROOT}/seated.png"))
    fr = anim_frames(sout, "south")  # the typing animation lives on the seated char
    if fr:
        os.makedirs(f"{ROOT}/typing", exist_ok=True)
        for i, u in enumerate(fr):
            open(f"{ROOT}/typing/{i}.png", "wb").write(_UA.open(u, timeout=60).read())
        print("typing frames:", len(fr))
    slout = mcp.call("get_character", {"character_id": SLEEP_ID, "include_preview": False})
    print("sleeping:", dl_south(slout, f"{ROOT}/sleeping.png"))

    rec.update({"seated": SEATED_ID, "sleeping": SLEEP_ID,
                "typing": len(fr) if fr else 9, "done": True})
    state["sales-f"] = rec
    json.dump(state, open("library_state.json", "w"), indent=2)
    print("DONE — run build_library.py")


if __name__ == "__main__":
    main()

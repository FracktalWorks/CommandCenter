#!/usr/bin/env python3
"""Generate NEW library avatars, one at a time, on the remaining $ CREDIT balance
(the subscription generation pool is exhausted, but paid credits still work).

Matches the existing library's ART STYLE exactly — v3 mode, size 64, "low top-down",
same STYLE string — so new characters are consistent with the 8 already shipped.

EFFICIENCY (per the user's directive to stop wasting generations on unused 360°
state views):
  - base uses n_directions=4 (only south+north are ever rendered — conference room
    far/near side + picker portrait — so 8 rotations are wasteful). States inherit
    the base's directions, so a 4-dir base makes every seated/sleeping state ~half
    the cost of an 8-dir one.
  - seated / sleeping / typing are USED front-only; breathing uses the cheap, stable
    `breathing-idle` TEMPLATE (1 gen/direction, no walk-cycle glitch) for S + N.

Credit-aware + resumable: checks the $ balance before each new character and stops
if it can't (probably) finish one. Progress persists to library_state.json; assets
land under char_library/<id>/. Re-run to resume. Then run build_library.py.
"""
import json
import os
import re
import sys
import time
import urllib.request

import mcp
from roster import ROSTER, STYLE

LIB = "char_library"
STATE = "library_state.json"
GEN_DIRS = ["south", "east", "north", "west"]  # 4-dir base
USE_STANDING = ["south", "north"]              # only these get rendered
BREATHE_DIRS = ["south", "north"]

# v3 sometimes frames the base as a chest-up BUST instead of the small full-body
# top-down sprite the office uses (this bit sales-f). Force full-body framing.
FULLBODY = ("full body standing character shown head to toe, small pixel-art character "
            "sprite, entire character visible from head to feet, not a portrait")

EDIT_SEATED = ("sitting on an office chair at a desk in front of a computer monitor "
               "on the desk, typing on a keyboard, looking at the screen")
EDIT_SLEEP = ("sitting on an office chair fast asleep at the desk, head resting down "
              "on the arms, eyes closed, sleeping")
ACT_TYPING = ("sitting at the desk in front of a computer monitor on the desk, typing "
              "on the keyboard and looking at the screen, hands moving, upper body still")

# Walk the whole roster in priority order, building each character we don't yet have.
TARGETS = [cid for cid, *_ in ROSTER]
MIN_CREDIT = 2.00   # $ — stop before starting a character once we near this floor

_UA = urllib.request.build_opener()
_UA.addheaders = [("User-Agent", "Mozilla/5.0")]


def load_state():
    return json.load(open(STATE)) if os.path.exists(STATE) else {}


def save_state(s):
    json.dump(s, open(STATE, "w"), indent=2)


def credits():
    out = mcp.call("get_balance", {})
    m = re.search(r"credits:\s*\$?([\d.]+)", out)
    return float(m.group(1)) if m else None


def parse_id(out):
    return next((l.split(":", 1)[1].strip() for l in out.splitlines()
                 if l.strip().lower().startswith("id:")), None)


def is_credit_error(out):
    low = out.lower()
    return any(w in low for w in ("insufficient", "not enough", "no credits",
                                  "out of credits", "quota exceeded",
                                  "payment required", "402"))


def queue(tool, args, retries=6):
    for attempt in range(retries):
        out = mcp.call(tool, args)
        if is_credit_error(out):
            return None, True
        cid = parse_id(out)
        if cid:
            return cid, False
        if tool == "animate_character" and ("frames" in out.lower() or "job" in out.lower()):
            return "queued", False
        print(f"    {tool} busy (try {attempt + 1}): {out[:70]}", flush=True)
        time.sleep(12)
    return None, False


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


def dl_rotations(out_text, dest, dirs):
    os.makedirs(dest, exist_ok=True)
    urls = dict(re.findall(r"  ([\w-]+): (https://\S+\.png\?t=\d+)", out_text))
    n = 0
    for d in dirs:
        if d in urls:
            try:
                open(f"{dest}/{d}.png", "wb").write(_UA.open(urls[d], timeout=60).read())
                n += 1
            except Exception as e:  # noqa: BLE001
                print(f"    dl fail {d}: {e}", flush=True)
    return n


def dl_south(out_text, path):
    m = re.search(r"  south: (https://\S+\.png\?t=\d+)", out_text)
    if not m:
        return False
    os.makedirs(os.path.dirname(path), exist_ok=True)
    open(path, "wb").write(_UA.open(m.group(1), timeout=60).read())
    return True


def anim_frames(out_text, dir_, prefix=r"\("):
    m = re.search(prefix + re.escape(dir_) + r", \d+f\)[^\n]*\n\s*frames: ([^\n]+)", out_text)
    if not m:
        return []
    return [u.strip() for u in m.group(1).split(",") if u.strip().startswith("http")]


def idle_frames(out_text, dir_):
    m = re.search(r"breathing-idle \(" + re.escape(dir_) + r", \d+f\)[^\n]*\n\s*frames: ([^\n]+)",
                  out_text)
    if not m:
        return []
    return [u.strip() for u in m.group(1).split(",") if u.strip().startswith("http")]


def wait_anim(cid, dirs, frame_fn, timeout=600):
    t0 = time.time()
    while time.time() - t0 < timeout:
        out = mcp.call("get_character", {"character_id": cid, "include_preview": False})
        if all(len(frame_fn(out, d)) >= 4 for d in dirs):
            return out
        time.sleep(18)
    return mcp.call("get_character", {"character_id": cid, "include_preview": False})


def build_character(cid, gender, role, desc, st):
    rec = st.setdefault(cid, {"gender": gender, "role": role, "desc": desc})
    root = f"{LIB}/{cid}"

    # 1) base (4-dir standing)
    if not rec.get("base"):
        bid, credit = queue("create_character", {
            "description": f"{desc}, {STYLE}, {FULLBODY}", "name": f"lib-{cid}",
            "mode": "v3", "size": 64, "view": "low top-down", "n_directions": 4})
        if credit:
            print(f"  base {cid}: CREDIT ERROR"); return False
        if not bid:
            print(f"  base {cid}: could not queue — stopping"); return False
        rec["base"] = bid
        save_state(st)
        print(f"  base {cid}: {bid} (waiting)", flush=True)
    if not os.path.exists(f"{root}/standing/south.png"):
        out = wait_completed(rec["base"])
        if not out:
            print(f"  base {cid}: did not complete"); return False
        n = dl_rotations(out, f"{root}/standing", GEN_DIRS)
        print(f"  base {cid}: {n} standing rotations", flush=True)

    # 2) seated state (front used)
    if not rec.get("seated"):
        sid, credit = queue("create_character_state",
                            {"character_id": rec["base"], "edit_description": EDIT_SEATED})
        if credit:
            print(f"  seated {cid}: CREDIT ERROR"); return False
        rec["seated"] = sid
        save_state(st)
    if not os.path.exists(f"{root}/seated.png"):
        out = wait_completed(rec["seated"])
        if out:
            dl_south(out, f"{root}/seated.png")
            print(f"  seated {cid}: ok", flush=True)

    # 3) typing animation on the seated state (south)
    if not rec.get("typing") and rec.get("seated"):
        _, credit = queue("animate_character", {
            "character_id": rec["seated"], "mode": "v3", "animation_name": "typing",
            "action_description": ACT_TYPING, "directions": ["south"]})
        if credit:
            print(f"  typing {cid}: CREDIT ERROR"); return False
        out = wait_anim(rec["seated"], ["south"], anim_frames)
        fr = anim_frames(out, "south")
        if fr:
            d = f"{root}/typing"
            os.makedirs(d, exist_ok=True)
            for i, u in enumerate(fr):
                try:
                    open(f"{d}/{i}.png", "wb").write(_UA.open(u, timeout=60).read())
                except Exception as e:  # noqa: BLE001
                    print(f"    dl fail typing/{i}: {e}", flush=True)
            rec["typing"] = len(fr)
            save_state(st)
            print(f"  typing {cid}: {len(fr)} frames", flush=True)

    # 4) sleeping state (front used)
    if not rec.get("sleeping"):
        slid, credit = queue("create_character_state",
                             {"character_id": rec["base"], "edit_description": EDIT_SLEEP})
        if credit:
            print(f"  sleeping {cid}: CREDIT ERROR"); return False
        rec["sleeping"] = slid
        save_state(st)
    if not os.path.exists(f"{root}/sleeping.png"):
        out = wait_completed(rec["sleeping"])
        if out:
            dl_south(out, f"{root}/sleeping.png")
            print(f"  sleeping {cid}: ok", flush=True)

    # 5) breathing via the stable template (south + north)
    if not rec.get("breathing"):
        _, credit = queue("animate_character", {
            "character_id": rec["base"], "template_animation_id": "breathing-idle",
            "directions": BREATHE_DIRS})
        if credit:
            print(f"  breathing {cid}: CREDIT ERROR"); return False
        out = wait_anim(rec["base"], BREATHE_DIRS, idle_frames)
        got = {}
        for dr in BREATHE_DIRS:
            fr = idle_frames(out, dr)
            if len(fr) < 4:
                continue
            d = f"{root}/breathing/{dr}"
            os.makedirs(d, exist_ok=True)
            for i, u in enumerate(fr):
                try:
                    open(f"{d}/{i}.png", "wb").write(_UA.open(u, timeout=60).read())
                except Exception as e:  # noqa: BLE001
                    print(f"    dl fail breathing/{dr}/{i}: {e}", flush=True)
            got[dr] = len(fr)
        if got:
            rec["breathing"] = got
            save_state(st)
            print(f"  breathing {cid}: {got}", flush=True)

    rec["done"] = bool(rec.get("base") and os.path.exists(f"{root}/seated.png")
                       and rec.get("typing") and os.path.exists(f"{root}/sleeping.png")
                       and rec.get("breathing"))
    save_state(st)
    return rec["done"]


def main():
    only = set(sys.argv[1:]) or set(TARGETS)
    roster = {cid: (g, r, d) for cid, g, r, d in ROSTER}
    st = load_state()
    for cid in TARGETS:
        if cid not in only:
            continue
        if st.get(cid, {}).get("done"):
            print(f"skip {cid}: done"); continue
        g, r, d = roster[cid]
        bal = credits()
        print(f"\n=== {cid} ({g} {r}) — ${bal:.2f} credits ===", flush=True)
        if bal is not None and bal < MIN_CREDIT:
            print(f"STOP: ${bal:.2f} < ${MIN_CREDIT} — not enough to finish a character."); break
        ok = build_character(cid, g, r, d, st)
        after = credits()
        if bal is not None and after is not None:
            print(f"--- {cid}: {'DONE' if ok else 'INCOMPLETE'}, "
                  f"cost ~${bal - after:.2f}, ${after:.2f} left", flush=True)
        if not ok:
            print("STOP: character did not fully complete."); break
    print("\nnew-avatar run finished.", flush=True)


if __name__ == "__main__":
    main()

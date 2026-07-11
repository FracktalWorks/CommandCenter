#!/usr/bin/env python3
"""Generate the reusable CHARACTER LIBRARY, one character at a time, until Pixel Lab
credits run out. For each roster entry we generate the FULL set we actually use in
observability BEFORE moving on to the next character:

  1. base            create_character (v3)      -> 8 standing rotations
  2. seated          create_character_state     -> desk sprite (south)
  3. typing          animate_character (seated)  -> working animation (south)
  4. sleeping        create_character_state     -> asleep-at-desk sprite (south)
  5. breathing       animate_character (base)    -> idle animation (south + north)

Credit-aware + resumable: before STARTING a new character we check get_balance and
stop if there isn't enough budget to finish a whole one (so no half-built characters
are left behind). Progress is persisted to library_state.json; assets land under
char_library/<id>/. Re-run after a stop to resume where it left off. Then run
build_library.py to emit the manifest."""
import json
import os
import re
import time
import urllib.request

import mcp
from roster import ROSTER, STYLE

LIB = "char_library"
STATE = "library_state.json"
DIRS = ["south", "east", "north", "west", "south-east", "north-east",
        "north-west", "south-west"]
BREATHE_DIRS = ["south", "north"]

EDIT_SEATED = ("sitting on an office chair at a desk in front of a computer monitor "
               "on the desk, typing on a keyboard, looking at the screen")
EDIT_SLEEP = ("sitting on an office chair fast asleep at the desk, head resting down "
              "on the arms, eyes closed, sleeping")
ACT_TYPING = ("sitting at the desk in front of a computer monitor on the desk, typing "
              "on the keyboard and looking at the screen, hands moving, upper body still")
ACT_BREATHE = ("standing still and relaxed, breathing gently, chest and shoulders "
               "rising and falling slightly, a subtle calm idle sway, feet planted")

# Don't start a new character unless we can (probably) finish it. Refined after the
# first full character from its measured cost.
MIN_BUDGET = 28

_UA = urllib.request.build_opener()
_UA.addheaders = [("User-Agent", "Mozilla/5.0")]


def load_state():
    return json.load(open(STATE)) if os.path.exists(STATE) else {}


def save_state(s):
    json.dump(s, open(STATE, "w"), indent=2)


def balance():
    out = mcp.call("get_balance", {})
    m = re.search(r"generations_remaining:\s*(\d+)", out)
    return int(m.group(1)) if m else None


def parse_id(out):
    return next((l.split(":", 1)[1].strip() for l in out.splitlines()
                 if l.strip().lower().startswith("id:")), None)


def is_credit_error(out):
    low = out.lower()
    return any(w in low for w in ("insufficient", "not enough", "no credits",
                                  "out of credits", "quota exceeded",
                                  "payment required", "402"))


def queue(tool, args, retries=6):
    """Queue a create/animate call, returning (id_or_out, credit_error?). Retries on
    transient 'busy'/rate-limit responses (no id yet) but stops immediately on a real
    credit error so the campaign ends cleanly with every started character finished."""
    for attempt in range(retries):
        out = mcp.call(tool, args)
        if is_credit_error(out):
            return None, True
        cid = parse_id(out)
        if cid:
            return cid, False
        # animate_character returns no 'id:' line — success looks like 'frames'/'job'
        if tool == "animate_character" and ("frames" in out.lower() or "job" in out.lower()):
            return "queued", False
        print(f"    {tool} busy (try {attempt + 1}): {out[:70]}")
        time.sleep(12)
    return None, False


def wait_completed(cid, timeout=420):
    """Poll a character/state id until status: completed. Returns the final text."""
    t0 = time.time()
    while time.time() - t0 < timeout:
        out = mcp.call("get_character", {"character_id": cid, "include_preview": False})
        if "status: completed" in out:
            return out
        if "status: failed" in out:
            return None
        time.sleep(15)
    return None


def dl_rotations(out_text, dest, dirs=DIRS):
    os.makedirs(dest, exist_ok=True)
    urls = dict(re.findall(r"  ([\w-]+): (https://\S+\.png\?t=\d+)", out_text))
    n = 0
    for d in dirs:
        if d in urls:
            try:
                open(f"{dest}/{d}.png", "wb").write(_UA.open(urls[d], timeout=60).read())
                n += 1
            except Exception as e:  # noqa: BLE001
                print(f"    dl fail {d}: {e}")
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
    """Poll a character until the custom animation lists frames for all dirs."""
    t0 = time.time()
    while time.time() - t0 < timeout:
        out = mcp.call("get_character", {"character_id": cid, "include_preview": False})
        if all(len(anim_frames(out, d)) >= 8 for d in dirs):
            return out
        time.sleep(18)
    # last read (may be partial) so caller can salvage what completed
    return mcp.call("get_character", {"character_id": cid, "include_preview": False})


def build_character(cid, gender, role, desc, st):
    """Run every missing stage for one character. Commits to finishing once started."""
    rec = st.setdefault(cid, {"gender": gender, "role": role, "desc": desc})
    root = f"{LIB}/{cid}"

    # 1) base character (8 standing rotations)
    if not rec.get("base"):
        bid, credit = queue("create_character", {
            "description": f"{desc}, {STYLE}", "name": f"lib-{cid}",
            "mode": "v3", "size": 64, "view": "low top-down"})
        if credit:
            print(f"  base {cid}: CREDIT ERROR"); return False
        if not bid:
            print(f"  base {cid}: could not queue (busy) — stopping"); return False
        rec["base"] = bid
        save_state(st)
        print(f"  base {cid}: {bid} (waiting)")
    if not os.path.exists(f"{root}/standing/south.png"):
        out = wait_completed(rec["base"])
        if not out:
            print(f"  base {cid}: did not complete")
            return False
        n = dl_rotations(out, f"{root}/standing")
        print(f"  base {cid}: {n}/8 standing rotations")

    # 2) seated state (desk sprite)
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
            print(f"  seated {cid}: ok")

    # 3) typing animation on the seated state (south)
    if not rec.get("typing") and rec.get("seated"):
        _, credit = queue("animate_character", {
            "character_id": rec["seated"], "mode": "v3", "animation_name": "typing",
            "action_description": ACT_TYPING, "directions": ["south"]})
        if credit:
            print(f"  typing {cid}: CREDIT ERROR"); return False
        out = wait_anim(rec["seated"], ["south"])
        fr = anim_frames(out, "south")
        if fr:
            d = f"{root}/typing"
            os.makedirs(d, exist_ok=True)
            for i, u in enumerate(fr):
                try:
                    open(f"{d}/{i}.png", "wb").write(_UA.open(u, timeout=60).read())
                except Exception as e:  # noqa: BLE001
                    print(f"    dl fail typing/{i}: {e}")
            rec["typing"] = len(fr)
            save_state(st)
            print(f"  typing {cid}: {len(fr)} frames")

    # 4) sleeping state (asleep at desk)
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
            print(f"  sleeping {cid}: ok")

    # 5) breathing animation on the base (south + north)
    if not rec.get("breathing"):
        _, credit = queue("animate_character", {
            "character_id": rec["base"], "mode": "v3", "animation_name": "breathing",
            "action_description": ACT_BREATHE, "directions": BREATHE_DIRS})
        if credit:
            print(f"  breathing {cid}: CREDIT ERROR"); return False
        out = wait_anim(rec["base"], BREATHE_DIRS)
        got = {}
        for dr in BREATHE_DIRS:
            fr = anim_frames(out, dr)
            if len(fr) < 8:
                continue
            d = f"{root}/breathing/{dr}"
            os.makedirs(d, exist_ok=True)
            for i, u in enumerate(fr):
                try:
                    open(f"{d}/{i}.png", "wb").write(_UA.open(u, timeout=60).read())
                except Exception as e:  # noqa: BLE001
                    print(f"    dl fail breathing/{dr}/{i}: {e}")
            got[dr] = len(fr)
        if got:
            rec["breathing"] = got
            save_state(st)
            print(f"  breathing {cid}: {got}")

    rec["done"] = bool(rec.get("base") and os.path.exists(f"{root}/seated.png")
                       and rec.get("typing") and os.path.exists(f"{root}/sleeping.png")
                       and rec.get("breathing"))
    save_state(st)
    return rec["done"]


def main():
    st = load_state()
    min_budget = MIN_BUDGET
    for cid, gender, role, desc in ROSTER:
        if st.get(cid, {}).get("done"):
            print(f"skip {cid}: done")
            continue
        bal = balance()
        print(f"\n=== {cid} ({gender} {role}) — {bal} generations left ===")
        if bal is not None and bal < min_budget:
            print(f"STOP: {bal} < {min_budget} — not enough to finish a whole character.")
            break
        ok = build_character(cid, gender, role, desc, st)
        after = balance()
        if bal is not None and after is not None:
            cost = bal - after
            print(f"--- {cid}: {'DONE' if ok else 'INCOMPLETE'}, cost ~{cost} gen, {after} left")
            if ok and cost > 0:
                min_budget = max(MIN_BUDGET, cost + 4)
        if not ok:
            print("STOP: character did not fully complete (likely out of credits).")
            break
    print("\nlibrary campaign finished.")


if __name__ == "__main__":
    main()

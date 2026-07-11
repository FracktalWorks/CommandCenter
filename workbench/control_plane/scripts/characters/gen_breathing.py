#!/usr/bin/env python3
"""A gentle STANDING breathing animation for each agent's base character, in the two
directions the conference room uses (south = far side facing us, north = near side
facing away). Uses animate_character v3 like gen_typing, but on the BASE standing
character (ids.json) so the whole body sways/breathes. Writes
char_seated/<agent>/breathing/<dir>/<n>.png + breathing_manifest.json {agent:{dir:frames}}.
Waves of <=6. Re-run build_sheets.py afterwards to fold into office-cast.generated.ts."""
import json
import os
import re
import time
import urllib.request

import mcp

BASE = json.load(open("ids.json"))
DIRS = ["south", "north"]
ACTION = ("standing still and relaxed, breathing gently, chest and shoulders rising "
          "and falling slightly, a subtle calm idle sway, feet planted")
_UA = urllib.request.build_opener()
_UA.addheaders = [("User-Agent", "Mozilla/5.0")]


def frames_for(out_text, dir_):
    # get_character lists our custom animation per direction as
    #   custom-<action…> (<dir>, 9f) <date>\n    frames: url, url, ...
    m = re.search(r"\(" + re.escape(dir_) + r", \d+f\)[^\n]*\n\s*frames: ([^\n]+)", out_text)
    if not m:
        return []
    return [u.strip() for u in m.group(1).split(",") if u.strip().startswith("http")]


def main():
    man = json.load(open("breathing_manifest.json")) if os.path.exists("breathing_manifest.json") else {}

    def have(a, d):
        return os.path.exists(f"char_seated/{a}/breathing/{d}/0.png")

    def done(a):
        return all(have(a, d) for d in DIRS)

    # orchestrator was queued manually during the format probe — don't re-queue it.
    queued = {"orchestrator"}  # agents we've asked to animate this run
    for _ in range(120):
        active = sum(1 for a in queued if not done(a))
        for a, cid in BASE.items():
            if a in queued or done(a):
                continue
            if active >= 6:
                break
            out = mcp.call("animate_character", {
                "character_id": cid, "mode": "v3", "action_description": ACTION,
                "animation_name": "breathing", "directions": DIRS})
            if "frames" in out.lower() or "job" in out.lower():
                queued.add(a)
                active += 1
                print(f"queued breathing {a}")
            else:
                print(f"busy {a}: {out[:70]}")
            time.sleep(4)
        for a in list(queued) or list(BASE):
            if done(a):
                continue
            out = mcp.call("get_character", {"character_id": BASE[a], "include_preview": False})
            got = {}
            for d in DIRS:
                if have(a, d):
                    continue
                fr = frames_for(out, d)
                if not fr:
                    continue
                dd = f"char_seated/{a}/breathing/{d}"
                os.makedirs(dd, exist_ok=True)
                for i, u in enumerate(fr):
                    try:
                        open(f"{dd}/{i}.png", "wb").write(_UA.open(u, timeout=60).read())
                    except Exception as e:  # noqa: BLE001
                        print(f"  dl fail {a}/{d}/{i}: {e}")
                got[d] = len(fr)
            if got:
                man.setdefault(a, {}).update(got)
                json.dump(man, open("breathing_manifest.json", "w"), indent=2)
                print(f"got breathing {a}: {got}")
        if all(done(a) for a in BASE):
            print("ALL BREATHING DONE", man)
            return
        time.sleep(22)


if __name__ == "__main__":
    main()

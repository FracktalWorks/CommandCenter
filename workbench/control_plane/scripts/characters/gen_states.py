#!/usr/bin/env python3
"""Two extra character states per agent, saved into char_seated/<agent>/:
  standing.png  = the BASE character's south sprite (already standing) — just a download
  sleeping.png  = a NEW create_character_state (asleep at the desk) — needs generation
Standing is fast (download); sleeping generates in waves of <=6. Re-run build_sheets.py
afterwards to fold them into office-cast.generated.ts."""
import json
import os
import re
import time
import urllib.request

import mcp

BASE = json.load(open("ids.json"))
ROOT = "char_seated"
SLEEP_EDIT = ("sitting on an office chair fast asleep at the desk, head resting down "
              "on the arms, eyes closed, sleeping")
_UA = urllib.request.build_opener()
_UA.addheaders = [("User-Agent", "Mozilla/5.0")]


def parse_id(out):
    return next((l.split(":", 1)[1].strip() for l in out.splitlines()
                 if l.strip().startswith("id:")), None)


def dl_south(out_text, path):
    m = re.search(r"  south: (https://\S+\.png\?t=\d+)", out_text)
    if not m:
        return False
    os.makedirs(os.path.dirname(path), exist_ok=True)
    open(path, "wb").write(_UA.open(m.group(1), timeout=60).read())
    return True


def main():
    # 1) standing = base character south sprite (already standing) — download only
    for a, cid in BASE.items():
        p = f"{ROOT}/{a}/standing.png"
        if os.path.exists(p):
            continue
        out = mcp.call("get_character", {"character_id": cid, "include_preview": False})
        print(f"standing {a}: {'ok' if 'completed' in out and dl_south(out, p) else 'FAIL'}")
        time.sleep(1)

    # 2) sleeping = a new state generated from the base char (slow)
    sleep_ids = json.load(open("sleep_ids.json")) if os.path.exists("sleep_ids.json") else {}
    done = {a for a in BASE if os.path.exists(f"{ROOT}/{a}/sleeping.png")}
    for _ in range(80):
        active = sum(1 for a, i in sleep_ids.items() if i and a not in done)
        for a, cid in BASE.items():
            if a in done or sleep_ids.get(a):
                continue
            if active >= 6:
                break
            out = mcp.call("create_character_state",
                           {"character_id": cid, "edit_description": SLEEP_EDIT})
            sid = parse_id(out)
            if sid:
                sleep_ids[a] = sid
                active += 1
                print(f"queued sleep {a}: {sid}")
            else:
                print(f"busy {a}: {out[:60]}")
            json.dump(sleep_ids, open("sleep_ids.json", "w"), indent=2)
            time.sleep(4)
        for a, sid in list(sleep_ids.items()):
            if not sid or a in done:
                continue
            out = mcp.call("get_character", {"character_id": sid, "include_preview": False})
            if "status: completed" in out:
                if dl_south(out, f"{ROOT}/{a}/sleeping.png"):
                    done.add(a)
                    print(f"DONE sleep {a}")
            else:
                print(f".. sleep {a}: {(out.splitlines()[0] if out else '')[:40]}")
        if all(a in done for a in BASE):
            print("ALL SLEEP DONE")
            return
        time.sleep(25)


if __name__ == "__main__":
    main()

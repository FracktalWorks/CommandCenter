#!/usr/bin/env python3
"""Add a custom v3 'typing' animation (keeps the seated pose) to each seated
state, south direction. Writes char_seated/<agent>/typing/<n>.png +
typing_manifest.json {agent: frames}. Waves of <=6."""
import json
import os
import re
import time
import urllib.request

import mcp

ACTION = ("sitting at the desk typing quickly on the computer keyboard, "
          "hands moving, upper body still")
_UA = urllib.request.build_opener()
_UA.addheaders = [("User-Agent", "Mozilla/5.0")]


def frames_for(out_text):
    m = re.search(r"[^\n]*typing[^\n]*\(south[^\n]*\n\s*frames: ([^\n]+)", out_text)
    return [u.strip() for u in m.group(1).split(",") if u.strip().startswith("http")] if m else []


def main():
    seated = json.load(open("seated_ids.json"))
    manifest = json.load(open("typing_manifest.json")) if os.path.exists("typing_manifest.json") else {}
    done = set(manifest) | {a for a in seated if os.path.exists(f"char_seated/{a}/typing/0.png")}
    queued = set(done)

    for _ in range(90):
        active = len(queued) - len(done)
        for a, sid in seated.items():
            if a in queued:
                continue
            if active >= 6:
                break
            out = mcp.call("animate_character", {
                "character_id": sid, "mode": "v3", "action_description": ACTION,
                "animation_name": "typing", "directions": ["south"]})
            if "frames" in out.lower() or "job" in out.lower():
                queued.add(a)
                active += 1
                print(f"queued typing {a}")
            else:
                print(f"busy {a}: {out[:70]}")
            time.sleep(4)
        for a in list(queued):
            if a in done:
                continue
            out = mcp.call("get_character", {"character_id": seated[a], "include_preview": False})
            fr = frames_for(out)
            if fr:
                d = f"char_seated/{a}/typing"
                os.makedirs(d, exist_ok=True)
                for i, u in enumerate(fr):
                    try:
                        open(f"{d}/{i}.png", "wb").write(_UA.open(u, timeout=60).read())
                    except Exception as e:  # noqa: BLE001
                        print(f"  dl fail {a}/{i}: {e}")
                manifest[a] = len(fr)
                json.dump(manifest, open("typing_manifest.json", "w"), indent=2)
                done.add(a)
                print(f"DONE typing {a}: {len(fr)} frames")
            else:
                print(f".. {a}: {out.splitlines()[0] if out else ''}")
        if len(done) == len(seated):
            print("ALL TYPING DONE", manifest)
            return
        time.sleep(25)


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""Fix two broken breathing animations reported by the user:
- email-assistant NORTH breathing came out as a walk cycle (legs striding).
- strategy SOUTH breathing has red streak artifacts near the head.

Both were custom-v3 idle animations that misfired. Regenerate ONLY the broken
direction using Pixel Lab's fixed `breathing-idle` TEMPLATE animation (1 gen /
direction, a stable skeleton so no walk cycle / no colour glitch), then pack the
new frames straight into the committed public sheet
`public/character-library/<agent>/breathing/<dir>.png`. ~2 generations total.
"""
import json
import os
import re
import time
import urllib.request

from PIL import Image

import mcp

# (agent, base-character-id, broken-direction)
FIXES = [
    ("email-assistant", "f9d86491-7fb9-4d05-a312-1aeb07c273cc", "north"),
    ("strategy", "8201c4bb-29e8-4069-8dd3-c8d5d3209247", "south"),
]
PUB = "../../public/character-library"
_UA = urllib.request.build_opener()
_UA.addheaders = [("User-Agent", "Mozilla/5.0")]


def idle_frames(out_text, dir_):
    """Frames of the `breathing-idle` template animation for one direction.
    Header looks like `  breathing-idle (north, 9f) <date>` then `    frames: url, ...`."""
    m = re.search(r"breathing-idle \(" + re.escape(dir_) + r", \d+f\)[^\n]*\n\s*frames: ([^\n]+)",
                  out_text)
    if not m:
        return []
    return [u.strip() for u in m.group(1).split(",") if u.strip().startswith("http")]


def pack(frame_urls, dest_png):
    imgs = []
    for u in frame_urls:
        try:
            data = _UA.open(u, timeout=60).read()
            open(dest_png + f".f{len(imgs)}", "wb").write(data)  # temp
            imgs.append(Image.open(dest_png + f".f{len(imgs)}").convert("RGBA"))
        except Exception as e:  # noqa: BLE001
            print("  dl fail", e)
    if not imgs:
        return 0
    w, h = imgs[0].size
    sheet = Image.new("RGBA", (w * len(imgs), h), (0, 0, 0, 0))
    for i, im in enumerate(imgs):
        sheet.alpha_composite(im, (i * w, 0))
    os.makedirs(os.path.dirname(dest_png), exist_ok=True)
    sheet.save(dest_png)
    # clean temp frame files
    for i in range(len(imgs)):
        try:
            os.remove(dest_png + f".f{i}")
        except OSError:
            pass
    return len(imgs)


def main():
    # 1) queue the template breathing-idle for each broken direction
    for agent, cid, dir_ in FIXES:
        out = mcp.call("animate_character", {
            "character_id": cid, "template_animation_id": "breathing-idle",
            "directions": [dir_]})
        print(f"queued breathing-idle {agent}/{dir_}: {out[:80]}")
        time.sleep(4)

    # 2) poll until every fix has frames, then pack into the public sheet
    pending = {(a, c, d) for a, c, d in FIXES}
    t0 = time.time()
    while pending and time.time() - t0 < 600:
        for a, c, d in list(pending):
            out = mcp.call("get_character", {"character_id": c, "include_preview": False})
            fr = idle_frames(out, d)
            if len(fr) >= 4:
                n = pack(fr, f"{PUB}/{a}/breathing/{d}.png")
                print(f"PACKED {a}/{d}: {n} frames -> {PUB}/{a}/breathing/{d}.png")
                pending.discard((a, c, d))
        if pending:
            time.sleep(18)
    if pending:
        print("STILL PENDING:", pending)
    else:
        print("DONE — both breathing animations fixed")


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""Test: one 8-direction object (bookshelf) in the agents' top-down view, to
confirm the perspective + orientations (front/side/back) before batching the set.
Downloads all rotations to dir_test/ and prints the get_object dump."""
import os
import re
import time
import urllib.request

import mcp

OUT = "dir_test"
_UA = urllib.request.build_opener()
_UA.addheaders = [("User-Agent", "Mozilla/5.0")]


def parse_id(out):
    return next((l.split(":", 1)[1].strip() for l in out.splitlines()
                 if l.strip().lower().startswith("id:")), None)


def main():
    os.makedirs(OUT, exist_ok=True)
    out = mcp.call("create_8_direction_object", {
        "description": ("a tall wooden bookshelf full of colourful books, cozy "
                        "16-bit Pokemon Center JRPG office furniture"),
        "size": 96, "view": "high top-down"})
    oid = parse_id(out)
    print("queued:", oid or out[:200])
    if not oid:
        return
    for _ in range(40):
        got = mcp.call("get_object", {"object_id": oid})
        first = got.splitlines()[0] if got else ""
        if "status: completed" in got:
            open(f"{OUT}/_dump.txt", "w", encoding="utf-8").write(got)
            urls = re.findall(r"([\w-]+): (https://\S+?\.png)", got)
            n = 0
            for name, u in urls:
                try:
                    open(f"{OUT}/{name}.png", "wb").write(_UA.open(u, timeout=60).read())
                    n += 1
                except Exception as e:  # noqa: BLE001
                    print("dl fail", name, e)
            print(f"DONE: {n} rotations -> {OUT}")
            return
        print("..", first[:70])
        time.sleep(20)


if __name__ == "__main__":
    main()

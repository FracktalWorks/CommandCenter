#!/usr/bin/env python3
"""Generate a REAL textured floor tile with Pixel Lab (not a brightness-hack
checkerboard). A fresh top-down Wang tileset whose lower terrain is an explicitly
checkered/patterned ceramic office floor. Downloads the 16-tile sheet to
public/office-env/_floor_sheet.png for slicing by build_env.py.
Writes floor_ids.json for resume."""
import json
import os
import urllib.request

import mcp

OUT = "../../public/office-env"
IDS = "floor_ids.json"

TILESET = {
    "lower_description": ("top-down office floor of checkered ceramic tiles, "
                          "alternating deep navy-blue and slate-blue squares "
                          "with subtle sheen and fine grout lines"),
    "upper_description": "dark polished wood office wall",
    "transition_size": 0.0,
    "tile_size": {"width": 32, "height": 32},
}


def parse_id(out):
    return next((l.split(":", 1)[1].strip() for l in out.splitlines()
                 if l.strip().lower().startswith(("id:", "tileset_id:"))), None)


def follow(url):
    """MCP download endpoint 302-redirects to a signed URL that rejects the auth
    header — follow the redirect manually and fetch it clean."""
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *a, **k):
            return None
    op = urllib.request.build_opener(NoRedirect)
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {mcp.KEY}"})
    try:
        return op.open(req, timeout=60).read()
    except urllib.error.HTTPError as e:
        loc = e.headers.get("Location")
        req2 = urllib.request.Request(loc, headers={"User-Agent": "Mozilla/5.0"})
        return urllib.request.urlopen(req2, timeout=60).read()


def main():
    import time
    ids = json.load(open(IDS)) if os.path.exists(IDS) else {}
    if not ids.get("tileset"):
        out = mcp.call("create_topdown_tileset", TILESET)
        tid = parse_id(out)
        print("create_topdown_tileset ->", tid or out[:200])
        ids["tileset"] = tid
        json.dump(ids, open(IDS, "w"), indent=2)
    tid = ids.get("tileset")
    if not tid:
        return
    for _ in range(60):
        out = mcp.call("get_topdown_tileset", {"tileset_id": tid})
        if "status: completed" in out:
            os.makedirs(OUT, exist_ok=True)
            img = follow(f"https://api.pixellab.ai/mcp/tilesets/{tid}/image")
            open(f"{OUT}/_floor_sheet.png", "wb").write(img)
            print(f"FLOOR SHEET DONE: {len(img)} bytes -> {OUT}/_floor_sheet.png")
            return
        print(".. floor:", (out.splitlines()[0] if out else "")[:60])
        time.sleep(20)


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""Generate the office furniture as 8-DIRECTION objects (create_8_direction_object)
in the agents' top-down view, so each piece can face into the room from any wall
(south=front for the top wall, east/west=sides for the side walls, north=back).
Downloads all rotations to public/office-objects/<name>/<dir>.png and emits the
office-objects manifest. Waves of <=8 concurrent."""
import io
import json
import os
import re
import time
import urllib.request

import mcp

OUT = "../../public/office-objects"
TS = "../../src/app/observability/office-objects.generated.ts"
IDS = "object_ids.json"
STYLE = "cozy warm 16-bit Game Boy Advance Pokemon Center JRPG office furniture"
SIZE = 96
DIRS = ["south", "south-east", "east", "north-east",
        "north", "north-west", "west", "south-west"]

SPEC = {
    # --- original set ---
    "bookshelf": f"a tall wooden bookshelf full of colourful books, {STYLE}",
    "couch": f"a cozy two-seater lounge couch with soft cushions, {STYLE}",
    "beanbag": f"a round comfy beanbag chair, {STYLE}",
    "plant-tall": f"a tall leafy potted plant in a white pot, {STYLE}",
    "plant-small": f"a small round potted fern in a terracotta pot, {STYLE}",
    "armchair": f"a comfy cushioned lounge armchair, {STYLE}",
    "side-table": f"a small round wooden coffee side table, {STYLE}",
    # --- more plant variety (make the room greener + more random) ---
    "plant-palm": f"a tall potted areca palm with wide fronds in a woven basket, {STYLE}",
    "plant-cactus": f"a small potted cactus in a painted clay pot, {STYLE}",
    "plant-monstera": f"a leafy monstera plant in a modern grey pot, {STYLE}",
    "plant-hanging": f"a small trailing pothos plant in a hanging pot, {STYLE}",
    # --- more bookshelf variety ---
    "bookshelf-wide": f"a low wide wooden bookcase with books and a few plants on top, {STYLE}",
    "shelf-files": f"a wooden shelf stacked with binders, folders and boxes, {STYLE}",
    # --- office equipment (a 3D-printing startup) ---
    "printer-3d": f"a desktop FDM 3D printer with a half-printed model on its bed, {STYLE}",
    "printer-3d-large": f"a large industrial 3D printer cabinet with a glass door, {STYLE}",
    "coffee-machine": f"a countertop espresso coffee machine with a mug, {STYLE}",
    "water-cooler": f"a blue-jug office water cooler dispenser, {STYLE}",
    "workstation": f"a computer workstation: monitor, keyboard and desktop tower, {STYLE}",
    "filing-cabinet": f"a short metal office filing cabinet with drawers, {STYLE}",
    "whiteboard": f"a standing whiteboard easel with colourful diagrams, {STYLE}",
    "printer-office": f"a white office laser printer on a small stand, {STYLE}",
}

_UA = urllib.request.build_opener()
_UA.addheaders = [("User-Agent", "Mozilla/5.0")]


def parse_id(out):
    return next((l.split(":", 1)[1].strip() for l in out.splitlines()
                 if l.strip().lower().startswith("id:")), None)


def download(oid_out, name):
    d = f"{OUT}/{name}"
    os.makedirs(d, exist_ok=True)
    urls = dict(re.findall(r"([\w-]+): (https://\S+?/rotations/[\w-]+\.png)", oid_out))
    n = 0
    for dr in DIRS:
        if dr in urls:
            try:
                open(f"{d}/{dr}.png", "wb").write(_UA.open(urls[dr], timeout=60).read())
                n += 1
            except Exception as e:  # noqa: BLE001
                print(f"  dl fail {name}/{dr}: {e}")
    return n


def main():
    os.makedirs(OUT, exist_ok=True)
    ids = json.load(open(IDS)) if os.path.exists(IDS) else {}
    done = {n for n in SPEC if os.path.exists(f"{OUT}/{n}/south.png")}
    for _ in range(60):
        for name, desc in SPEC.items():
            if name in done or ids.get(name):
                continue
            out = mcp.call("create_8_direction_object",
                           {"description": desc, "size": SIZE, "view": "high top-down"})
            oid = parse_id(out)
            if oid:
                ids[name] = oid
                print(f"queued {name}: {oid}")
            else:
                print(f"busy {name}: {out[:70]}")
            json.dump(ids, open(IDS, "w"), indent=2)
            time.sleep(3)
        for name, oid in list(ids.items()):
            if not oid or name in done:
                continue
            got = mcp.call("get_object", {"object_id": oid})
            if "status: completed" in got:
                n = download(got, name)
                done.add(name)
                print(f"DONE {name}: {n}/8")
            else:
                print(f".. {name}: {(got.splitlines()[0] if got else '')[:50]}")
        if len(done) == len(SPEC):
            break
        time.sleep(20)

    manifest = {n: {d: f"/office-objects/{n}/{d}.png" for d in DIRS
                    if os.path.exists(f"{OUT}/{n}/{d}.png")} for n in SPEC
                if os.path.exists(f"{OUT}/{n}/south.png")}
    lines = [
        "// AUTO-GENERATED - 8-direction office furniture (create_8_direction_object).",
        "// name -> { direction: publicPath }. Do not edit by hand.",
        "",
        "export type Dir = \"south\"|\"south-east\"|\"east\"|\"north-east\""
        "|\"north\"|\"north-west\"|\"west\"|\"south-west\";",
        "export type OfficeObject = Partial<Record<Dir, string>>;",
        "",
        "export const OFFICE_OBJECTS: Record<string, OfficeObject> = "
        + json.dumps(manifest, indent=2) + ";",
        "",
    ]
    with io.open(TS, "w", encoding="utf-8", newline="\n") as f:
        f.write("\n".join(lines))
    print(f"wrote {TS} ({len(manifest)} objects)")


if __name__ == "__main__":
    main()

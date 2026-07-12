#!/usr/bin/env python3
"""Drive the whole cast to completion in waves (<=8 concurrent), download all 8
rotations per agent into char/<agent>/. Resumable via char_ids.json."""
import json
import os
import time
import re
import urllib.request

import mcp

STYLE = "cute pixel art RPG character, front view, friendly, clean outline"
CAST = {
    "orchestrator": "a confident team leader wearing a purple blazer and a headset, short dark hair",
    "apis-config": "a software developer wearing a blue hoodie and a headset, glasses, messy brown hair",
    "sales": "a sharp salesperson wearing a navy business suit and a headset, neat hair",
    "task-manager": "a project planner wearing a red sweater and round glasses, holding a clipboard",
    "email-assistant": "a friendly support agent wearing a green hoodie, ponytail",
    "reconciler": "an accountant wearing a grey vest and glasses, tidy hair",
    "delivery": "a delivery courier wearing an orange jacket and a cap",
    "billing": "a finance clerk wearing a dark blue shirt and tie, holding papers",
    "strategy": "a strategist wearing a teal turtleneck, thoughtful expression",
}
DIRS = ["south", "east", "north", "west", "south-east", "north-east", "north-west", "south-west"]
_UA = urllib.request.build_opener()
_UA.addheaders = [("User-Agent", "Mozilla/5.0")]


def load_ids():
    return json.load(open("char_ids.json")) if os.path.exists("char_ids.json") else {}


def save_ids(ids):
    json.dump(ids, open("char_ids.json", "w"), indent=2)


def parse_id(out):
    return next((l.split(":", 1)[1].strip() for l in out.splitlines()
                 if l.strip().startswith("id:")), None)


def queue(agent):
    out = mcp.call("create_character", {
        "description": f"{CAST[agent]}, {STYLE}", "name": f"agent-{agent}",
        "mode": "v3", "size": 64, "view": "low top-down"})
    return parse_id(out), out


def download(agent, out_text):
    d = f"char/{agent}"
    os.makedirs(d, exist_ok=True)
    urls = dict(re.findall(r"  ([\w-]+): (https://\S+\.png\?t=\d+)", out_text))
    n = 0
    for name in DIRS:
        if name in urls:
            try:
                data = _UA.open(urls[name], timeout=60).read()
                open(f"{d}/{name}.png", "wb").write(data)
                n += 1
            except Exception as e:  # noqa: BLE001
                print(f"  dl fail {agent}/{name}: {e}")
    return n


def active_count(ids, done):
    return sum(1 for a, i in ids.items() if i and a not in done)


def main():
    ids = load_ids()
    done = set(a for a in CAST if os.path.exists(f"char/{a}/south.png"))
    print("resume: already downloaded:", sorted(done))

    for _ in range(80):  # ~ up to 80 * 30s = 40 min
        # queue any missing agents while under the concurrency cap
        for agent in CAST:
            if agent in done or ids.get(agent):
                continue
            if active_count(ids, done) >= 7:
                break
            cid, out = queue(agent)
            if cid:
                ids[agent] = cid
                print(f"queued {agent}: {cid}")
            else:
                print(f"queue busy for {agent}: {out[:80]}")
            save_ids(ids)
            time.sleep(3)

        # poll active
        for agent, cid in list(ids.items()):
            if not cid or agent in done:
                continue
            out = mcp.call("get_character", {"character_id": cid, "include_preview": False})
            first = out.splitlines()[0] if out else ""
            if "status: completed" in out:
                n = download(agent, out)
                done.add(agent)
                print(f"DONE {agent}: downloaded {n}/8")
            elif "failed" in first.lower():
                print(f"FAILED {agent}: {first}")
                ids[agent] = None
                save_ids(ids)
            else:
                print(f".. {agent}: {first}")

        if all(a in done for a in CAST):
            print("ALL DONE:", sorted(done))
            return
        time.sleep(30)
    print("TIMEOUT; done:", sorted(done))


if __name__ == "__main__":
    main()

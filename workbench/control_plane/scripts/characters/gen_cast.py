#!/usr/bin/env python3
"""Queue one v3 character per agent; save the id map for polling/download."""
import json
import mcp  # local client

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

ids = {}
for agent, desc in CAST.items():
    out = mcp.call("create_character", {
        "description": f"{desc}, {STYLE}",
        "name": f"agent-{agent}",
        "mode": "v3", "size": 64, "view": "low top-down",
    })
    # parse `id: <uuid>`
    cid = None
    for line in out.splitlines():
        if line.strip().startswith("id:"):
            cid = line.split(":", 1)[1].strip()
            break
    ids[agent] = cid
    print(f"{agent}: {cid}")

json.dump(ids, open("char_ids.json", "w"), indent=2)
print("saved char_ids.json")

#!/usr/bin/env python3
"""Minimal Pixel Lab MCP client (JSON-RPC over HTTP+SSE)."""
import json
import os
import sys
import urllib.request

KEY = os.environ["PIXELLAB_API_KEY"]
URL = "https://api.pixellab.ai/mcp"
_id = [0]


def call(name: str, args: dict) -> str:
    _id[0] += 1
    payload = {"jsonrpc": "2.0", "id": _id[0], "method": "tools/call",
               "params": {"name": name, "arguments": args}}
    req = urllib.request.Request(URL, data=json.dumps(payload).encode(), headers={
        "Authorization": f"Bearer {KEY}", "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream"}, method="POST")
    with urllib.request.urlopen(req, timeout=120) as r:
        body = r.read().decode()
    # SSE frames: lines like `data: {...}`
    for line in body.splitlines():
        line = line.strip()
        if line.startswith("data:"):
            line = line[5:].strip()
        if not line.startswith("{"):
            continue
        d = json.loads(line)
        if d.get("id") == _id[0]:
            res = d.get("result") or {}
            if "content" in res:
                return "\n".join(c.get("text", "") for c in res["content"])
            if "error" in d:
                return "ERROR: " + json.dumps(d["error"])
            return json.dumps(res)
    return "NO_RESPONSE: " + body[:400]


if __name__ == "__main__":
    name = sys.argv[1]
    args = json.loads(sys.argv[2]) if len(sys.argv) > 2 else {}
    print(call(name, args))

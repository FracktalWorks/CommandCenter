#!/usr/bin/env python3
"""Test multiple models via the gateway /v1 (litellm SDK) on the VPS."""
import json
import os
import urllib.request

MASTER_KEY = os.environ["LITELLM_MASTER_KEY"]
BASE = "http://localhost:8080/v1/chat/completions"

MODELS = [
    "groq/llama-3.3-70b",
    "deepseek/deepseek-v4-pro",
    "deepseek/deepseek-chat",
]


def test(model: str) -> None:
    body = json.dumps({
        "model": model,
        "messages": [{"role": "user", "content": "Reply with exactly: OK"}],
        "max_tokens": 10,
    }).encode()
    req = urllib.request.Request(
        BASE,
        body,
        {
            "Content-Type": "application/json",
            "Authorization": "Bearer " + MASTER_KEY,
        },
    )
    try:
        resp = urllib.request.urlopen(req, timeout=60)
        out = json.loads(resp.read())
        msg = out["choices"][0]["message"]["content"].strip()
        print(f"  PASS  {model}  ->  {msg!r}")
    except urllib.error.HTTPError as e:
        print(f"  FAIL  {model}  ->  HTTP {e.code}: {e.read().decode()[:120]}")
    except Exception as e:  # noqa: BLE001
        print(f"  FAIL  {model}  ->  {e}")


print("Testing models via gateway /v1 (litellm SDK):")
for m in MODELS:
    test(m)

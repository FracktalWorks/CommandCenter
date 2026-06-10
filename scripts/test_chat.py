#!/usr/bin/env python3
"""Test chat endpoint with DeepSeek model."""
import json, urllib.request

data = json.dumps({
    "thread_id": "test-ds2",
    "messages": [{"role": "user", "content": "Say hello in exactly 3 words"}]
}).encode()

req = urllib.request.Request(
    "http://localhost:8080/copilot/chat",
    data,
    {
        "Content-Type": "application/json",
        "Authorization": "Bearer sk-local-dev-change-me",
        "X-User-Email": "vjvarada@gmail.com",
    }
)
try:
    resp = urllib.request.urlopen(req, timeout=60)
    print(resp.read().decode()[:2000])
except Exception as e:
    print(f"Error: {e}")
    if hasattr(e, "read"):
        print(e.read().decode()[:1000])

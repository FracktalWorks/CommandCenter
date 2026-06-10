#!/usr/bin/env python3
"""Test LiteLLM proxy with DeepSeek."""
import json, urllib.request

data = json.dumps({
    "model": "deepseek/deepseek-chat",
    "messages": [{"role": "user", "content": "Say hello in exactly 3 words"}],
    "max_tokens": 20
}).encode()

req = urllib.request.Request(
    "http://localhost:4000/v1/chat/completions",
    data,
    {
        "Content-Type": "application/json",
        "Authorization": "Bearer sk-local-dev-change-me",
    }
)
try:
    resp = urllib.request.urlopen(req, timeout=30)
    result = json.loads(resp.read())
    content = result["choices"][0]["message"]["content"]
    print(f"DeepSeek says: {content}")
except Exception as e:
    print(f"Error: {e}")

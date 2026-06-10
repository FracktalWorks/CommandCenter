#!/usr/bin/env python3
"""Test DeepSeek via LiteLLM SDK directly on VPS."""
import os
os.environ["DEEPSEEK_API_KEY"] = "sk-a40a5330c1494ffe9ca9b31b4294d593"

import litellm
resp = litellm.completion(
    model="deepseek/deepseek-chat",
    messages=[{"role": "user", "content": "Say hello in exactly 3 words"}],
    max_tokens=20,
)
print(resp.choices[0].message.content)

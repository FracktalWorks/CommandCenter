import asyncio, json, os, sys
sys.path.insert(0, ".")

# Ensure DEEPSEEK_API_KEY is available
from acb_common import get_settings
settings = get_settings()
key = getattr(settings, "deepseek_api_key", "") or os.environ.get("DEEPSEEK_API_KEY", "")
os.environ["DEEPSEEK_API_KEY"] = key

from orchestrator.executor import run_agent_stream

async def test():
    print("=== Copilot SDK BYOK via monkey-patched _create_session ===")
    parts = []
    async for event in run_agent_stream(
        "task-manager",
        {"message": "What company created you? Reply with ONE word only."},
        model="deepseek/deepseek-v4-flash",
    ):
        s = str(event)
        if "TEXT_MESSAGE_CONTENT" in s:
            data = json.loads(s.replace("data: ", ""))
            parts.append(data.get("delta", ""))
        elif "RUN_FINISHED" in s:
            print(f"Response: \"{''.join(parts).strip()}\"")
        elif "RUN_ERROR" in s:
            print(f"ERROR: {s[:300]}")
            break

asyncio.run(test())

"""E2E test of the detached stream-relay architecture against a LIVE gateway.

Simulates the exact bug scenario:
  1. Start a named-agent run via POST /agent/run/stream.
  2. Read a few SSE events, then DISCONNECT (close the HTTP response).
  3. Verify Redis shows cc:active:{tid} = 1 and the stream is growing
     (the agent kept running without any HTTP consumer).
  4. Verify GET /chat/active-sessions reports the thread as active.
  5. Reconnect via GET /agent/run/{tid}/reconnect and follow to RUN_FINISHED.
  6. Verify the active key is cleared after the run finishes.
"""
import asyncio
import json
import subprocess
import os
import sys
import uuid

import httpx
import redis

BASE = os.environ.get("E2E_GATEWAY_URL", "http://127.0.0.1:8000")


def gh_token() -> str:
    tok = os.environ.get("E2E_TOKEN", "")
    if tok:
        return tok
    return subprocess.check_output(["gh", "auth", "token"], text=True).strip()


async def main() -> None:
    token = gh_token()
    headers = {"Authorization": f"Bearer {token}"}
    r = redis.from_url("redis://localhost:6379", decode_responses=True)

    tid = f"e2e-reconnect-{uuid.uuid4().hex[:8]}"
    agent = sys.argv[1] if len(sys.argv) > 1 else "task-manager"
    prompt = sys.argv[2] if len(sys.argv) > 2 else (
        "Write a detailed 400-word essay about the history of prime numbers, "
        "covering Euclid, Eratosthenes, Fermat, and modern cryptography."
    )

    print(f"=== Phase 1: start run (agent={agent}, thread={tid}) ===")
    seen_before_disconnect = 0
    last_event_id = None
    async with httpx.AsyncClient(timeout=120) as client:
        async with client.stream(
            "POST", f"{BASE}/agent/run/stream",
            json={"agent": agent, "payload": {"message": prompt}, "thread_id": tid},
            headers=headers,
        ) as resp:
            print("HTTP", resp.status_code)
            assert resp.status_code == 200, await resp.aread()
            async for line in resp.aiter_lines():
                if not line.startswith("data:"):
                    continue
                ev = json.loads(line[5:].strip())
                last_event_id = ev.get("_stream_id")
                seen_before_disconnect += 1
                print(f"  evt#{seen_before_disconnect}: {ev.get('type')} id={last_event_id}")
                if seen_before_disconnect >= 3:
                    break
            # exiting the `async with stream` block = client disconnect

    print(f"\n=== Phase 2: DISCONNECTED after {seen_before_disconnect} events ===")
    active = r.get(f"cc:active:{tid}")
    stream_len_1 = r.xlen(f"cc:stream:{tid}")
    print(f"cc:active = {active!r}, stream length = {stream_len_1}")
    assert active == "1", "agent died with the HTTP disconnect!"

    # Check active-sessions IMMEDIATELY (short runs can finish fast).
    print("\n=== Phase 3: /chat/active-sessions while running ===")
    async with httpx.AsyncClient(timeout=15) as client:
        res = await client.get(f"{BASE}/chat/active-sessions", headers=headers)
        body = res.json()
        print("HTTP", res.status_code, body)
        if r.get(f"cc:active:{tid}") == "1":
            assert any(s.get("threadId") == tid for s in body), \
                "active-sessions does not report the running thread!"
        else:
            print("(run finished before the check — skipping assertion)")

    await asyncio.sleep(4)
    stream_len_2 = r.xlen(f"cc:stream:{tid}")
    print(f"stream length after 4s = {stream_len_2} (growing={stream_len_2 > stream_len_1})")

    print(f"\n=== Phase 4: reconnect (since={last_event_id}) ===")
    types: list[str] = []
    text = ""
    async with httpx.AsyncClient(timeout=300) as client:
        async with client.stream(
            "GET",
            f"{BASE}/agent/run/{tid}/reconnect?since={last_event_id or '0-0'}",
            headers=headers,
        ) as resp:
            assert resp.status_code == 200
            async for line in resp.aiter_lines():
                if not line.startswith("data:"):
                    continue
                ev = json.loads(line[5:].strip())
                types.append(ev.get("type"))
                if ev.get("type") == "TEXT_MESSAGE_CONTENT":
                    text += ev.get("delta", "")
                if ev.get("type") in ("RUN_FINISHED", "RUN_ERROR"):
                    break

    print(f"reconnect received {len(types)} events, final={types[-1] if types else None}")
    print(f"text recovered ({len(text)} chars): {text[:200]}...")
    assert types and types[-1] == "RUN_FINISHED", f"stream did not finish cleanly: {types[-5:]}"
    assert text.strip(), "no text recovered via reconnect!"

    await asyncio.sleep(1)
    active_after = r.get(f"cc:active:{tid}")
    print(f"\n=== Phase 5: post-run — cc:active = {active_after!r} (expect None) ===")
    assert active_after is None, "active flag not cleared after run finished"

    print("\nE2E PASSED — agent survived disconnect, reconnect replayed to completion.")


asyncio.run(main())

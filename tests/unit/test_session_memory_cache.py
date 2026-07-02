"""Unit tests for session-scoped memory caching (Phase 4).

The memory block must be fetched ONCE per session (thread) and reused across
turns, so ``[stable prefix + memory]`` stays byte-stable and cache-eligible.
"""
from __future__ import annotations

import pytest
from acb_memory.session_cache import (
    get_session_memory,
    invalidate_session_memory,
)


class _FakeRedis:
    """Minimal async Redis double: get / setex / delete over an in-mem dict."""

    def __init__(self) -> None:
        self.store: dict[str, str] = {}
        self.get_calls = 0
        self.setex_calls = 0

    async def get(self, key: str):
        self.get_calls += 1
        return self.store.get(key)

    async def setex(self, key: str, ttl: int, value: str) -> None:
        self.setex_calls += 1
        self.store[key] = value

    async def delete(self, key: str) -> None:
        self.store.pop(key, None)


@pytest.fixture(autouse=True)
def _enable(monkeypatch):
    monkeypatch.setenv("SESSION_MEMORY_CACHE", "1")
    monkeypatch.setenv("SESSION_MEMORY_CACHE_TTL", "600")


async def test_builds_once_then_reuses_across_turns():
    redis = _FakeRedis()
    calls = {"n": 0}

    async def build() -> str:
        calls["n"] += 1
        return f"MEM v{calls['n']}"

    # Turn 1 — miss → build + store.
    b1 = await get_session_memory(redis=redis, thread_id="t1", build=build)
    # Turns 2 & 3 — hits → reuse, no rebuild.
    b2 = await get_session_memory(redis=redis, thread_id="t1", build=build)
    b3 = await get_session_memory(redis=redis, thread_id="t1", build=build)

    assert b1 == b2 == b3 == "MEM v1"  # byte-stable across the session
    assert calls["n"] == 1             # built exactly once
    assert redis.setex_calls == 1


async def test_empty_block_is_cached_too():
    # A session with no memory should not re-run the semantic search each turn.
    redis = _FakeRedis()
    calls = {"n": 0}

    async def build() -> str:
        calls["n"] += 1
        return ""

    await get_session_memory(redis=redis, thread_id="t2", build=build)
    await get_session_memory(redis=redis, thread_id="t2", build=build)
    assert calls["n"] == 1
    assert redis.setex_calls == 1


async def test_no_thread_id_skips_cache_builds_every_time():
    redis = _FakeRedis()
    calls = {"n": 0}

    async def build() -> str:
        calls["n"] += 1
        return "X"

    await get_session_memory(redis=redis, thread_id=None, build=build)
    await get_session_memory(redis=redis, thread_id=None, build=build)
    assert calls["n"] == 2
    assert redis.get_calls == 0  # never touched the cache


async def test_disabled_flag_bypasses_cache(monkeypatch):
    monkeypatch.setenv("SESSION_MEMORY_CACHE", "0")
    redis = _FakeRedis()
    calls = {"n": 0}

    async def build() -> str:
        calls["n"] += 1
        return "X"

    await get_session_memory(redis=redis, thread_id="t3", build=build)
    await get_session_memory(redis=redis, thread_id="t3", build=build)
    assert calls["n"] == 2
    assert redis.get_calls == 0


async def test_no_redis_degrades_to_fresh_fetch():
    calls = {"n": 0}

    async def build() -> str:
        calls["n"] += 1
        return "X"

    out = await get_session_memory(redis=None, thread_id="t4", build=build)
    assert out == "X"
    assert calls["n"] == 1


async def test_redis_error_falls_back_to_build():
    class _Broken:
        async def get(self, key):
            raise RuntimeError("redis down")

        async def setex(self, *a):
            raise RuntimeError("redis down")

    calls = {"n": 0}

    async def build() -> str:
        calls["n"] += 1
        return "FRESH"

    out = await get_session_memory(redis=_Broken(), thread_id="t5", build=build)
    assert out == "FRESH"  # never raised; degraded to a fresh build
    assert calls["n"] == 1


async def test_invalidate_drops_the_session_block():
    redis = _FakeRedis()

    async def build() -> str:
        return "A"

    await get_session_memory(redis=redis, thread_id="t6", build=build)
    assert redis.store  # something cached
    await invalidate_session_memory(redis=redis, thread_id="t6")
    assert "session_mem:t6" not in redis.store

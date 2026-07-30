"""Session-scoped memory cache (specs/llm_caching_memory.md Phase 4).

Mem0 uses semantic search, so a different query against the same user's memory
returns a different result set — which means the assembled ``memory_context``
block changes every turn, and the combined ``[stable prefix + memory]`` never
stays byte-stable across turns. That defeats cross-turn prompt caching on the
memory portion (the stable prefix still caches; the memory does not).

The fix: fetch + assemble the memory block ONCE per session (thread) and reuse
it for every turn in that session, cached in Redis with a short TTL. The block
then stays byte-stable across the session, so ``[stable prefix + memory]``
becomes cache-eligible cross-turn. A 10-minute TTL matches the provider cache
TTL, so the two expire together.

Trade-off: memory doesn't refresh mid-session. Acceptable because agents can
call ``recall_timeline`` explicitly for fresh facts, and new facts are picked up
on the next session anyway. Set ``SESSION_MEMORY_CACHE=0`` to disable and always
fetch fresh (the pre-Phase-4 behaviour).

This module deliberately takes an injected Redis client + builder coroutine so
``acb_memory`` never imports the orchestrator's stream_relay (layering).
"""
from __future__ import annotations

import os
from collections.abc import Awaitable, Callable
from typing import Any

from acb_common import get_logger

_log = get_logger("acb_memory.session_cache")

# Redis key prefix for a session's assembled memory block.
_KEY_PREFIX = "session_mem:"


def _enabled() -> bool:
    return os.environ.get("SESSION_MEMORY_CACHE", "1") == "1"


def _ttl() -> int:
    try:
        return int(os.environ.get("SESSION_MEMORY_CACHE_TTL", "600"))
    except ValueError:
        return 600


async def get_session_memory(
    *,
    redis: Any,
    thread_id: str | None,
    build: Callable[[], Awaitable[str]],
    clearance: str = "",
) -> str:
    """Return the session's memory block, fetching+caching it once per thread.

    Args:
        redis: an async Redis client (``get``/``setex`` coroutines). Pass the
            gateway's shared pooled client. If ``None``, caching is skipped.
        thread_id: the conversation thread key. When ``None`` (a one-off run
            with no session) caching is skipped and ``build`` is called directly.
        build: a zero-arg coroutine that fetches + assembles the fresh memory
            block (Mem0 + Graphiti). Only invoked on a cache miss.
        clearance: fingerprint of the compartments the block was assembled
            from (``acb_memory.Clearance.fingerprint``). **Part of the cache
            key, and load-bearing.** A thread cached while solo built its block
            from the owner's private compartment; if the key ignored clearance
            that block would keep being served for the rest of the TTL after
            somebody was invited in — handing the room exactly the private
            facts the read rule excludes. Changing clearance changes the key,
            so a newly shared room misses and rebuilds. Empty keeps the old
            key, so callers with one clearance are unaffected.

    Returns:
        The memory block string (possibly empty). Never raises — on any Redis
        error it falls back to calling ``build`` directly, so a cache outage
        degrades to the pre-Phase-4 fetch-every-turn behaviour.
    """
    if not _enabled() or redis is None or not thread_id:
        return await build()

    key = f"{_KEY_PREFIX}{thread_id}"
    if clearance:
        key = f"{key}:{clearance}"

    # ── Cache read ────────────────────────────────────────────────────
    try:
        cached = await redis.get(key)
    except Exception as exc:
        _log.debug("session_mem.read_failed", error=str(exc))
        cached = None

    if cached is not None:
        # decode_responses=True yields str; be defensive for bytes clients too.
        block = cached.decode() if isinstance(cached, bytes) else str(cached)
        _log.debug("session_mem.hit", thread=thread_id[:12], chars=len(block))
        return block

    # ── Cache miss → build fresh + store ──────────────────────────────
    block = await build()
    try:
        # Store even an empty string: a session with no memory should not
        # re-run the (expensive) semantic search on every turn.
        await redis.setex(key, _ttl(), block)
        _log.debug(
            "session_mem.stored",
            thread=thread_id[:12],
            chars=len(block),
            ttl=_ttl(),
        )
    except Exception as exc:
        _log.debug("session_mem.store_failed", error=str(exc))
    return block


async def invalidate_session_memory(*, redis: Any, thread_id: str) -> None:
    """Drop every cached memory block for a thread (e.g. after a memory write).

    A thread has one entry PER CLEARANCE since the key gained that suffix, so
    this clears them all rather than the bare key — otherwise invalidation
    would silently stop matching anything the moment a thread was shared, and
    a written fact would take up to the TTL to appear.

    Best-effort — a failure just means the blocks live out their TTL.
    """
    if redis is None or not thread_id:
        return
    base = f"{_KEY_PREFIX}{thread_id}"

    # The bare key first, in its own try: it is the only one a client without
    # SCAN can have written, and it must not be left behind because the sweep
    # of clearance variants below failed. Collapsing both into one block made a
    # missing `scan` silently skip the delete entirely — worse than the
    # single-key behaviour this replaced.
    try:
        await redis.delete(base)
    except Exception as exc:
        _log.debug("session_mem.invalidate_failed", error=str(exc))

    # Then every per-clearance variant. A thread has at most a handful, so the
    # scan is bounded and cheap.
    try:
        keys: list[str] = []
        cursor = 0
        while True:
            cursor, found = await redis.scan(cursor, match=f"{base}:*", count=64)
            keys.extend(found)
            if cursor == 0:
                break
        if keys:
            await redis.delete(*keys)
    except Exception as exc:
        _log.debug("session_mem.invalidate_variants_failed", error=str(exc))

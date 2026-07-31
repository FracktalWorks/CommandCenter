"""The room's own event channel — what happens between runs, and who did it.

Spec: ``docs/multiplayer/README.md`` §4.4 ("a second stream, deliberately").

``cc:stream:{thread_id}`` carries one agent run and is **deleted at every run
boundary** (``stream_relay.mark_active(reset=True)``) so that replay-from-zero
covers exactly the current run. That is right for a run and useless for a room:
who joined, who is watching, who typed what, and which agents are present all
have to survive the next run starting.

So rooms get their own stream with the opposite lifecycle — never reset, TTL
refreshed on every write. Two streams with two lifecycles is the honest model;
one stream would force a choice between losing run-replay exactness and losing
the room's memory of itself.

    cc:room:{thread_id}       room events, never reset, 24h idle TTL
    cc:presence:{thread_id}   hash of email -> last-seen epoch seconds

Presence is a hash rather than one key per person because the only question
ever asked is "who is here", which is one ``HGETALL`` instead of a scan. Stale
entries are pruned on read rather than by a sweeper: a browser that dies stops
heartbeating, and the next person to look is the one who cares.

Event names mirror AG-UI's SCREAMING_SNAKE convention so the frontend
translator handles run events and room events with one switch.
"""
from __future__ import annotations

import json
import time
from collections.abc import AsyncIterator
from typing import Any

import redis.asyncio as aioredis
from acb_common import get_logger, get_settings

_log = get_logger("gateway.room_stream")

ROOM_STREAM_PREFIX = "cc:room"
PRESENCE_PREFIX = "cc:presence"

#: Bounded so a long-lived room cannot grow without limit. The transcript is
#: the durable record (chat_message); this stream is the live layer, and a
#: client that falls further behind than this refetches history instead.
ROOM_STREAM_MAXLEN = 2_000
ROOM_STREAM_TTL_SECONDS = 24 * 3600

#: A heartbeat lands every 15s from an open tab; three missed beats and you are
#: considered gone. Long enough to survive a slow tab, short enough that the
#: presence rail is not a list of ghosts.
PRESENCE_TTL_SECONDS = 45

_client: aioredis.Redis | None = None


def _get_client() -> aioredis.Redis:
    global _client
    if _client is None:
        _client = aioredis.from_url(
            get_settings().redis_url,
            decode_responses=True,
            max_connections=16,
            health_check_interval=30,
        )
    return _client


def room_key(thread_id: str) -> str:
    return f"{ROOM_STREAM_PREFIX}:{thread_id}"


def presence_key(thread_id: str) -> str:
    return f"{PRESENCE_PREFIX}:{thread_id}"


# ---------------------------------------------------------------------------
# Publishing
# ---------------------------------------------------------------------------

async def publish_room_event(thread_id: str, event: dict[str, Any]) -> str | None:
    """Append one event to a room's stream. Never raises.

    Room events are a live convenience layer over a durable transcript, so a
    Redis blip must degrade the presence rail, never fail the request that was
    trying to do real work (send a message, add a participant).
    """
    if not thread_id:
        return None
    payload = {**event, "threadId": thread_id}
    payload.setdefault("ts", int(time.time() * 1000))
    try:
        r = _get_client()
        eid = await r.xadd(
            room_key(thread_id),
            {"event": json.dumps(payload, default=str)},
            maxlen=ROOM_STREAM_MAXLEN,
            approximate=True,
        )
        await r.expire(room_key(thread_id), ROOM_STREAM_TTL_SECONDS)
        return str(eid)
    except Exception:
        _log.warning(
            "room_stream.publish_failed",
            thread_id=thread_id, event_type=event.get("type"), exc_info=True,
        )
        return None


# ---------------------------------------------------------------------------
# Reading
# ---------------------------------------------------------------------------

def _parse(eid: str, fields: dict[str, str]) -> dict[str, Any] | None:
    raw = fields.get("event")
    if not raw:
        return None
    try:
        evt = json.loads(raw)
    except Exception:
        return None
    evt["_room_id"] = eid
    return evt


async def replay_room_events(
    thread_id: str, since_id: str = "0", limit: int = 500,
) -> list[dict[str, Any]]:
    """Everything after ``since_id``. ``"0"`` means the whole retained window."""
    if not thread_id:
        return []
    try:
        r = _get_client()
        entries = await r.xread({room_key(thread_id): since_id}, count=limit)
    except Exception:
        _log.warning("room_stream.replay_failed", thread_id=thread_id, exc_info=True)
        return []
    out: list[dict[str, Any]] = []
    for _key, items in entries or []:
        for eid, fields in items:
            evt = _parse(eid, fields)
            if evt is not None:
                out.append(evt)
    return out


async def subscribe_room_events(
    thread_id: str, since_id: str = "$", block_ms: int = 15_000,
) -> AsyncIterator[dict[str, Any]]:
    """Live tail. Yields until the caller stops consuming.

    Unlike ``subscribe_events`` for run streams there is no terminal event — a
    room does not end, it goes quiet. The caller (the SSE endpoint) decides when
    to stop, which is when the client disconnects.
    """
    if not thread_id:
        return
    cursor = since_id
    r = _get_client()
    while True:
        try:
            entries = await r.xread({room_key(thread_id): cursor}, block=block_ms, count=100)
        except Exception:
            _log.warning("room_stream.subscribe_failed", thread_id=thread_id, exc_info=True)
            return
        if not entries:
            yield {"type": "ROOM_PING", "threadId": thread_id}
            continue
        for _key, items in entries:
            for eid, fields in items:
                cursor = eid
                evt = _parse(eid, fields)
                if evt is not None:
                    yield evt


# ---------------------------------------------------------------------------
# Presence
# ---------------------------------------------------------------------------

async def touch_presence(thread_id: str, email: str, *, state: str = "viewing") -> None:
    """Record that this person is in this room right now. Never raises."""
    if not thread_id or not email:
        return
    try:
        r = _get_client()
        await r.hset(
            presence_key(thread_id), email,
            json.dumps({"at": int(time.time()), "state": state}),
        )
        # The hash outlives any single beat but not an empty room.
        await r.expire(presence_key(thread_id), ROOM_STREAM_TTL_SECONDS)
    except Exception:
        _log.debug("room_stream.presence_failed", thread_id=thread_id, exc_info=True)


async def clear_presence(thread_id: str, email: str) -> None:
    """Drop someone from the rail immediately (an explicit leave/close)."""
    if not thread_id or not email:
        return
    try:
        await _get_client().hdel(presence_key(thread_id), email)
    except Exception:
        _log.debug("room_stream.presence_clear_failed", thread_id=thread_id, exc_info=True)


async def read_presence(thread_id: str) -> list[dict[str, Any]]:
    """Who is here, freshest first, with entries older than the TTL pruned.

    Pruning on read (rather than relying on per-field expiry, which Redis
    hashes do not have) keeps the rail honest without a background sweeper.
    """
    if not thread_id:
        return []
    try:
        r = _get_client()
        raw = await r.hgetall(presence_key(thread_id))
    except Exception:
        _log.debug("room_stream.presence_read_failed", thread_id=thread_id, exc_info=True)
        return []

    now = int(time.time())
    live: list[dict[str, Any]] = []
    stale: list[str] = []
    for email, blob in (raw or {}).items():
        try:
            rec = json.loads(blob)
            at = int(rec.get("at", 0))
            state = str(rec.get("state", "viewing"))
        except Exception:
            stale.append(email)
            continue
        if now - at > PRESENCE_TTL_SECONDS:
            stale.append(email)
            continue
        live.append({"email": email, "at": at, "state": state})

    if stale:
        try:
            await _get_client().hdel(presence_key(thread_id), *stale)
        except Exception:
            _log.debug("room_stream.presence_prune_failed", exc_info=True)

    live.sort(key=lambda p: p["at"], reverse=True)
    return live

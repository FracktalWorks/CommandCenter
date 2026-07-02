"""Golden trajectories: server-side fold + authoritative persistence (P0-3).

``gateway.chat_fold`` must stay event-for-event equivalent to the Next
translator's fold (route.ts) and the client reducer (chatStream.ts) until the
protocol goes message-id-native (core_loop_unification Phase 3). These
trajectories are that contract: a synthetic run event log in, the persisted
message shape out.
"""
from __future__ import annotations

import asyncio
import json

from gateway.chat_fold import (
    fold_run_events,
    group_reasoning_blocks,
    persist_final_assistant_message,
    unfold_trailing_answer,
)
from orchestrator import stream_relay


def _ev(t: str, ms: int, **kw) -> dict:
    return {"type": t, "_stream_id": f"{ms}-0", **kw}


def test_full_turn_fold_with_failed_tool():
    """Narration → tool (fails) → reasoning → answer: narration folds into
    the timeline, the failed tool persists as error, the answer survives."""
    events = [
        _ev("TEXT_MESSAGE_CONTENT", 1000, delta="Let me check the inbox."),
        _ev("TOOL_CALL_START", 1100, toolCallId="t1", toolCallName="query_inbox"),
        _ev("TOOL_CALL_ARGS", 1150, toolCallId="t1", delta='{"account_id":'),
        _ev("TOOL_CALL_ARGS", 1160, toolCallId="t1", delta='"a1"}'),
        _ev("REASONING_MESSAGE_CONTENT", 1200, delta="The query failed, retrying differently."),
        _ev("TOOL_CALL_RESULT", 1300, toolCallId="t1",
            content="timeout contacting provider", success=False),
        _ev("TEXT_MESSAGE_CONTENT", 1400, delta="I couldn't reach your inbox."),
        _ev("RUN_FINISHED", 1500),
    ]
    folded = fold_run_events(events)
    assert folded is not None
    assert folded["content"] == "I couldn't reach your inbox."
    assert folded["timestamp"] == 1500

    [tool] = folded["tool_events"]
    assert tool["name"] == "query_inbox"
    assert tool["args"] == {"account_id": "a1"}
    assert tool["status"] == "error"  # honours success=False (P0-5)
    assert tool["startedAt"] == 1100
    assert tool["endedAt"] == 1300

    blocks = json.loads(folded["reasoning"])
    # Narration folded at tool start; reasoning followed in a later block.
    assert blocks[0] == "Let me check the inbox."
    assert any("retrying differently" in b for b in blocks)
    assert tool["reasoningCutoff"] == 1


def test_turn_ending_on_tool_unfolds_answer():
    """When the run ends on a tool call, the folded answer is promoted back
    to content and its block blanked (indices stay aligned)."""
    events = [
        _ev("TEXT_MESSAGE_CONTENT", 1000, delta="Here is your summary: all good."),
        _ev("TOOL_CALL_START", 1100, toolCallId="t1", toolCallName="save_memory"),
        _ev("TOOL_CALL_RESULT", 1200, toolCallId="t1", content="saved", success=True),
        _ev("RUN_FINISHED", 1300),
    ]
    folded = fold_run_events(events)
    assert folded is not None
    assert folded["content"] == "Here is your summary: all good."
    blocks = json.loads(folded["reasoning"])
    assert blocks[0] == ""  # blanked sentinel — cutoff indices stay aligned
    assert folded["tool_events"][0]["status"] == "done"


def test_sub_agent_timeline_attaches_to_delegate_tool():
    events = [
        _ev("TOOL_CALL_START", 1000, toolCallId="d1", toolCallName="call_agent"),
        _ev("SUB_AGENT_TEXT_DELTA", 1100, agentName="task-manager", delta="Checking tasks."),
        _ev("SUB_AGENT_TOOL_CALL_START", 1200, toolCallId="s1", toolCallName="sql"),
        _ev("SUB_AGENT_TOOL_CALL_RESULT", 1300, toolCallId="s1", content="3 rows", success=True),
        _ev("TOOL_CALL_RESULT", 1400, toolCallId="d1", content="3 overdue tasks", success=True),
        _ev("TEXT_MESSAGE_CONTENT", 1500, delta="You have 3 overdue tasks."),
        _ev("RUN_FINISHED", 1600),
    ]
    folded = fold_run_events(events)
    assert folded is not None
    [tool] = folded["tool_events"]
    assert tool["subAgentName"] == "task-manager"
    assert tool["subAgentText"] == "Checking tasks."
    assert tool["subAgentTools"] == [
        {"id": "s1", "name": "sql", "status": "done", "result": "3 rows"},
    ]


def test_todos_and_custom_events_persist():
    todos = [{"id": "1", "title": "Plan", "status": "completed"}]
    events = [
        _ev("TODO_LIST", 1000, todos=todos),
        _ev("CUSTOM", 1100, name="artifact_created", value={"path": "outputs/r.pdf"}),
        _ev("TEXT_MESSAGE_CONTENT", 1200, delta="Report written."),
        _ev("RUN_FINISHED", 1300),
    ]
    folded = fold_run_events(events)
    assert folded is not None
    assert folded["agent_state"] == {"todos": todos}
    assert folded["custom_events"] == [
        {"name": "artifact_created", "value": {"path": "outputs/r.pdf"}},
    ]


def test_empty_run_folds_to_none():
    assert fold_run_events([]) is None
    assert fold_run_events([_ev("RUN_FINISHED", 1000)]) is None


def test_reasoning_groups_on_paragraph_breaks():
    blocks: list[str] = []
    for chunk in ["First thought", " continues.", "\n\nSecond thought."]:
        blocks = group_reasoning_blocks(blocks, chunk)
    assert blocks == ["First thought continues.", "Second thought."]


def test_unfold_is_noop_when_answer_followed_tool():
    content, blocks = unfold_trailing_answer("real answer", ["folded"], 0)
    assert content == "real answer"
    assert blocks == ["folded"]


# ── End-to-end: run_detached → on_complete → persisted row ──────────────────

class _FakeRedis:
    def __init__(self) -> None:
        self.streams: dict[str, list[tuple[str, dict]]] = {}
        self.kv: dict[str, str] = {}
        self._seq = 0

    @staticmethod
    def _id(eid: str) -> tuple[int, int]:
        ms, _, seq = eid.partition("-")
        return int(ms), int(seq or 0)

    async def xadd(self, key, fields, maxlen=None, approximate=None):
        self._seq += 1
        eid = f"{self._seq}-0"
        self.streams.setdefault(key, []).append((eid, dict(fields)))
        return eid

    def _read(self, streams, count):
        out = []
        for key, since in streams.items():
            if since == "$":
                continue
            floor = (0, 0) if since in ("0", "0-0") else self._id(since)
            tail = [(e, f) for e, f in self.streams.get(key, [])
                    if self._id(e) > floor]
            if count is not None:
                tail = tail[:count]
            if tail:
                out.append((key, tail))
        return out

    async def xread(self, streams, count=None, block=None):
        # Simulate Redis blocking-read semantics: without it, the subscriber
        # races ahead of the drain task (real XREAD parks up to `block` ms).
        loop = asyncio.get_running_loop()
        deadline = loop.time() + (block or 0) / 1000
        while True:
            out = self._read(streams, count)
            if out or not block or loop.time() >= deadline:
                return out
            await asyncio.sleep(0.005)

    async def get(self, key):
        return self.kv.get(key)

    async def set(self, key, value, ex=None, xx=False):
        if xx and key not in self.kv:
            return None
        self.kv[key] = value
        return True

    async def delete(self, key):
        self.kv.pop(key, None)
        self.streams.pop(key, None)
        return 1

    async def expire(self, key, ttl):
        return True

    async def exists(self, key):
        return int(key in self.kv or key in self.streams)


async def test_detached_run_persists_final_message(monkeypatch):
    """The whole Phase-1 path: a detached run streams to Redis, the client
    never reconnects, and the on_complete hook still persists the full turn."""
    import gateway.routes.chat as chat_routes

    fake = _FakeRedis()
    monkeypatch.setattr(stream_relay, "_client", fake)

    persisted: list[tuple[str, list]] = []
    monkeypatch.setattr(
        chat_routes, "_upsert_messages",
        lambda sid, msgs: persisted.append((sid, msgs)),
    )

    async def _agent_gen():
        yield 'data: {"type": "TEXT_MESSAGE_CONTENT", "delta": "Hello "}\n\n'
        yield 'data: {"type": "TEXT_MESSAGE_CONTENT", "delta": "world."}\n\n'
        yield 'data: {"type": "RUN_FINISHED"}\n\n'

    async def _on_complete() -> None:
        await persist_final_assistant_message("traj-persist", "assistant-msg-1")

    # Consume as the HTTP subscriber would (client stays connected here; the
    # disconnect case exercises the same finally via task cancellation below).
    events = [
        e async for e in stream_relay.run_detached(
            "traj-persist", _agent_gen(), tee=True,
            on_complete=_on_complete,
        )
    ]
    assert [e["type"] for e in events][-1] == "RUN_FINISHED"

    # Give the drain task's finally a tick to run on_complete.
    for _ in range(50):
        if persisted:
            break
        await asyncio.sleep(0.01)

    assert len(persisted) == 1
    sid, [record] = persisted[0]
    assert sid == "traj-persist"
    assert record.id == "assistant-msg-1"
    assert record.role == "assistant"
    assert record.content == "Hello world."


async def test_cancelled_run_still_persists_partial_turn(monkeypatch):
    """Stop/steer cancels the drain task — the partial turn must still be
    folded and persisted (the finally runs on every exit path)."""
    import gateway.routes.chat as chat_routes

    fake = _FakeRedis()
    monkeypatch.setattr(stream_relay, "_client", fake)

    persisted: list[list] = []
    monkeypatch.setattr(
        chat_routes, "_upsert_messages",
        lambda sid, msgs: persisted.append(msgs),
    )

    started = asyncio.Event()

    async def _slow_agent_gen():
        yield 'data: {"type": "TEXT_MESSAGE_CONTENT", "delta": "Partial answer"}\n\n'
        started.set()
        await asyncio.sleep(60)  # cancelled long before this completes
        yield 'data: {"type": "RUN_FINISHED"}\n\n'

    async def _on_complete() -> None:
        await persist_final_assistant_message("traj-cancel", "assistant-msg-2")

    async def _subscriber() -> None:
        async for _ in stream_relay.run_detached(
            "traj-cancel", _slow_agent_gen(), tee=True,
            on_complete=_on_complete,
        ):
            pass

    sub_task = asyncio.create_task(_subscriber())
    await asyncio.wait_for(started.wait(), timeout=5)
    assert await stream_relay.cancel_run("traj-cancel") is True
    sub_task.cancel()
    try:
        await sub_task
    except (asyncio.CancelledError, Exception):  # noqa: BLE001
        pass

    for _ in range(50):
        if persisted:
            break
        await asyncio.sleep(0.01)

    assert len(persisted) == 1
    [record] = persisted[0]
    assert record.content == "Partial answer"

"""End-to-end characterization of run_agent_stream (audit BO-13 enabler).

Nothing drove the 1,600-line run_agent_stream in a test before — sub-components
were covered, the whole streamed run was not. This drives it with a mocked
agent + loader (no git clone, no LLM, no Redis) and pins the AG-UI SSE event
CONTRACT the frontend depends on: a well-formed RUN_STARTED … RUN_FINISHED
envelope with the assistant text streamed in between. It is the regression net
for decomposing run_agent_stream into its tier handlers.
"""
from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import Any

import pytest

from orchestrator import executor

# The Tier-1→Tier-2 fallback discards one un-awaited run() coroutine from the
# mock (it doesn't implement the native streaming interface); that's the whole
# point of the fallback and is benign here. Filter just that RuntimeWarning.
pytestmark = pytest.mark.filterwarnings(
    "ignore:coroutine .*run.* was never awaited:RuntimeWarning"
)


class _Resp:
    def __init__(self, text: str) -> None:
        self.text = text
        self.messages: list[Any] = []


class _MockMafAgent:
    """Minimal native-MAF-shaped agent: a name, empty tools, an async run().

    ``run`` is a coroutine function (so the Tier-2 batch path's
    ``inspect.iscoroutinefunction`` check + ``await agent.run(input)`` work and
    the reply streams). It does NOT implement the ``run(..., stream=True)``
    async-iterator interface, so run_agent_stream's Tier-1 native-streaming
    attempt no-ops and falls through to the proven Tier-2 batch path — exactly
    the fallback the code documents. That fallback discards one un-awaited
    ``run()`` coroutine (a benign RuntimeWarning filtered at module level).
    """

    def __init__(self, reply: str) -> None:
        self.name = "test-agent"
        self.tools: list[Any] = []
        self.default_options: dict[str, Any] = {}
        self._reply = reply

    async def run(self, *_a: Any, **_k: Any) -> _Resp:
        return _Resp(self._reply)

    async def __aenter__(self) -> "_MockMafAgent":
        return self

    async def __aexit__(self, *_a: Any) -> bool:
        return False


class _LoadedStub:
    def __init__(self, reply: str) -> None:
        self.agent_dir = Path("/tmp")
        self.agent_name = "test-agent"
        self.config: dict[str, Any] = {}
        self._reply = reply

    def build_agents(self) -> list[Any]:
        return [_MockMafAgent(self._reply)]


class _LoadCtx:
    def __init__(self, reply: str) -> None:
        self._reply = reply

    def __enter__(self) -> _LoadedStub:
        return _LoadedStub(self._reply)

    def __exit__(self, *_a: Any) -> bool:
        return False


def _parse_frames(frames: list[str]) -> list[dict[str, Any]]:
    """Turn raw ``data: {...}\\n\\n`` SSE lines into event dicts."""
    events: list[dict[str, Any]] = []
    for line in frames:
        for part in line.split("\n"):
            part = part.strip()
            if part.startswith("data:"):
                body = part[len("data:"):].strip()
                if body and body != "[DONE]":
                    try:
                        events.append(json.loads(body))
                    except json.JSONDecodeError:
                        pass
    return events


class _RaisingAgent(_MockMafAgent):
    async def run(self, *_a: Any, **_k: Any) -> _Resp:
        raise RuntimeError("boom in the agent")


class _RaisingLoadCtx(_LoadCtx):
    def __enter__(self) -> _LoadedStub:
        stub = _LoadedStub(self._reply)
        stub.build_agents = lambda: [_RaisingAgent(self._reply)]  # type: ignore[method-assign]
        return stub


def _drive(
    monkeypatch,
    reply: str = "hello world from the agent",
    *,
    ctx_factory: Any = None,
    run_id: str | None = None,
    thread_id: str | None = None,
) -> list[dict[str, Any]]:
    factory = ctx_factory or (lambda r: _LoadCtx(r))
    monkeypatch.setattr(executor, "load_agent", lambda *a, **k: factory(reply))
    monkeypatch.setattr(executor, "build_integrations", lambda *a, **k: ({}, {}))

    async def _collect() -> list[str]:
        out: list[str] = []
        async for line in executor.run_agent_stream(
            "test-agent-unregistered", {"message": "hi"},
            run_id=run_id, thread_id=thread_id,
        ):
            out.append(line)
        return out

    return _parse_frames(asyncio.run(_collect()))


def test_stream_opens_with_run_started_and_closes_with_run_finished(monkeypatch):
    events = _drive(monkeypatch)
    types = [e.get("type") for e in events]
    assert types, "no SSE events produced"
    assert types[0] == "RUN_STARTED"
    assert "RUN_FINISHED" in types
    # RUN_FINISHED is terminal — nothing after it.
    assert types.index("RUN_FINISHED") == len(types) - 1 - types[::-1].index("RUN_FINISHED")


def test_stream_emits_assistant_text(monkeypatch):
    events = _drive(monkeypatch, reply="the quick brown fox")
    text = "".join(
        str(e.get("delta") or e.get("content") or "")
        for e in events
        if e.get("type") == "TEXT_MESSAGE_CONTENT"
    )
    assert "quick brown fox" in text


def test_stream_no_run_error_on_happy_path(monkeypatch):
    events = _drive(monkeypatch)
    assert not [e for e in events if e.get("type") == "RUN_ERROR"]


def test_stream_propagates_run_and_thread_ids(monkeypatch):
    events = _drive(monkeypatch, run_id="fixed-run", thread_id="fixed-thread")
    started = next(e for e in events if e.get("type") == "RUN_STARTED")
    assert started.get("runId") == "fixed-run"
    assert started.get("threadId") == "fixed-thread"


def test_agent_exception_surfaces_as_run_error_not_a_crash(monkeypatch):
    # A raising agent must become a RUN_ERROR frame (the stream stays a valid
    # AG-UI envelope), never an unhandled exception out of the generator.
    events = _drive(monkeypatch, ctx_factory=lambda r: _RaisingLoadCtx(r))
    types = [e.get("type") for e in events]
    assert types[0] == "RUN_STARTED"
    assert "RUN_ERROR" in types

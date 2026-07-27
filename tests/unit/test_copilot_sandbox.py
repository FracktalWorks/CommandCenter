"""Copilot SDK session sandbox lifecycle (BO-7 phase 2).

`copilot_sandbox.py` spawns hardened `docker run` containers running just the
`copilot` CLI binary as a TCP server (see Dockerfile.copilot-sandbox) and
must NEVER raise — every failure mode degrades to `None` so callers fall back
to the existing in-process Copilot session. These fake both the `docker`
subprocess calls and the TCP readiness poll (`asyncio.open_connection`) so
the whole flow is exercised without a real Docker daemon.
"""
from __future__ import annotations

import asyncio
import types

import pytest
from orchestrator import copilot_sandbox as cs


class _FakeProc:
    def __init__(self, returncode: int, stdout: bytes, stderr: bytes = b""):
        self.returncode = returncode
        self._stdout = stdout
        self._stderr = stderr

    async def communicate(self):
        return self._stdout, self._stderr


class _FakeWriter:
    def close(self):
        pass

    async def wait_closed(self):
        return None


def _settings(**overrides) -> types.SimpleNamespace:
    base = dict(
        copilot_sandbox_image="acb-copilot-sandbox:latest",
        copilot_sandbox_port=41041,
        copilot_sandbox_memory_limit="768m",
        copilot_sandbox_cpu_limit="1",
        copilot_sandbox_pids_limit=256,
        copilot_sandbox_ready_timeout_seconds=0.3,
        copilot_sandbox_idle_ttl_seconds=600,
        copilot_sandbox_state_dir="/tmp/acb-copilot-sandbox-test-state",
        agents_clone_dir="/tmp/acb-agents-test",
    )
    base.update(overrides)
    return types.SimpleNamespace(**base)


def _docker_dispatcher(calls: list[list[str]], *, run_rc=0, port_out="0.0.0.0:54321", stop_rc=0):
    async def _fake_exec(*args, **kwargs):
        cmd = list(args)
        calls.append(cmd)
        sub = cmd[1] if len(cmd) > 1 else ""
        if sub == "run":
            return _FakeProc(run_rc, b"", b"" if run_rc == 0 else b"boom")
        if sub == "port":
            return _FakeProc(0, port_out.encode())
        if sub == "stop":
            return _FakeProc(stop_rc, b"", b"" if stop_rc == 0 else b"stop failed")
        if sub == "rm":
            return _FakeProc(0, b"")
        if sub == "ps":
            return _FakeProc(0, b"")
        return _FakeProc(0, b"")

    return _fake_exec


@pytest.fixture(autouse=True)
def _clear_sticky_registry():
    cs._STICKY.clear()
    yield
    cs._STICKY.clear()


@pytest.fixture
def _instant_tcp_ready(monkeypatch):
    async def _fake_open_connection(host, port):
        return object(), _FakeWriter()

    monkeypatch.setattr(asyncio, "open_connection", _fake_open_connection)


@pytest.fixture
def _tcp_never_ready(monkeypatch):
    async def _fake_open_connection(host, port):
        raise ConnectionRefusedError("nope")

    monkeypatch.setattr(asyncio, "open_connection", _fake_open_connection)


@pytest.mark.asyncio
async def test_spawn_includes_hardening_flags_and_returns_cli_url(monkeypatch, _instant_tcp_ready):
    calls: list[list[str]] = []
    monkeypatch.setattr(asyncio, "create_subprocess_exec", _docker_dispatcher(calls))

    handle = await cs.spawn_copilot_sandbox(
        workspace="/tmp/agent-workspace", label="code_task", settings=_settings(),
    )

    assert handle is not None
    assert handle.cli_url == "127.0.0.1:54321"
    assert handle.workspace == "/tmp/agent-workspace"

    run_cmd = calls[0]
    assert "--cap-drop" in run_cmd and run_cmd[run_cmd.index("--cap-drop") + 1] == "ALL"
    assert "--cap-add" in run_cmd and run_cmd[run_cmd.index("--cap-add") + 1] == "DAC_OVERRIDE"
    assert "--security-opt" in run_cmd and run_cmd[run_cmd.index("--security-opt") + 1] == "no-new-privileges"
    assert "--memory" in run_cmd and run_cmd[run_cmd.index("--memory") + 1] == "768m"
    assert "--cpus" in run_cmd and run_cmd[run_cmd.index("--cpus") + 1] == "1"
    assert "--pids-limit" in run_cmd and run_cmd[run_cmd.index("--pids-limit") + 1] == "256"
    assert "-v" in run_cmd and f"/tmp/agent-workspace:{cs.CONTAINER_WORKSPACE}" in run_cmd
    # Loopback-only publish, never a wildcard bind.
    assert any(a.startswith("127.0.0.1::") for a in run_cmd)


@pytest.mark.asyncio
async def test_spawn_respects_settings_overrides(monkeypatch, _instant_tcp_ready):
    calls: list[list[str]] = []
    monkeypatch.setattr(asyncio, "create_subprocess_exec", _docker_dispatcher(calls))

    await cs.spawn_copilot_sandbox(
        workspace="/tmp/ws", label="app_builder",
        settings=_settings(
            copilot_sandbox_memory_limit="1g",
            copilot_sandbox_cpu_limit="2",
            copilot_sandbox_pids_limit=64,
        ),
    )

    run_cmd = calls[0]
    assert run_cmd[run_cmd.index("--memory") + 1] == "1g"
    assert run_cmd[run_cmd.index("--cpus") + 1] == "2"
    assert run_cmd[run_cmd.index("--pids-limit") + 1] == "64"


@pytest.mark.asyncio
async def test_spawn_returns_none_when_docker_run_fails(monkeypatch, _instant_tcp_ready):
    calls: list[list[str]] = []
    monkeypatch.setattr(
        asyncio, "create_subprocess_exec", _docker_dispatcher(calls, run_rc=1),
    )

    handle = await cs.spawn_copilot_sandbox(
        workspace="/tmp/ws", label="code_task", settings=_settings(),
    )

    assert handle is None


@pytest.mark.asyncio
async def test_spawn_returns_none_and_cleans_up_when_port_never_ready(monkeypatch, _tcp_never_ready):
    calls: list[list[str]] = []
    monkeypatch.setattr(asyncio, "create_subprocess_exec", _docker_dispatcher(calls))

    handle = await cs.spawn_copilot_sandbox(
        workspace="/tmp/ws", label="code_task", settings=_settings(),
    )

    assert handle is None
    # Best-effort cleanup: a container that never came up must not be left running.
    assert any(c[1] == "rm" for c in calls)


@pytest.mark.asyncio
async def test_spawn_never_raises_when_docker_binary_missing(monkeypatch):
    async def _raise_exec(*args, **kwargs):
        raise FileNotFoundError("docker: command not found")

    monkeypatch.setattr(asyncio, "create_subprocess_exec", _raise_exec)

    handle = await cs.spawn_copilot_sandbox(
        workspace="/tmp/ws", label="code_task", settings=_settings(),
    )

    assert handle is None


@pytest.mark.asyncio
async def test_stop_falls_back_to_rm_when_docker_stop_fails(monkeypatch):
    calls: list[list[str]] = []
    monkeypatch.setattr(
        asyncio, "create_subprocess_exec", _docker_dispatcher(calls, stop_rc=1),
    )

    handle = cs.CopilotSandboxHandle(
        name="cc-copilot-code_task-abc123", cli_url="127.0.0.1:1", workspace="/tmp/ws", label="code_task",
    )
    await cs.stop_copilot_sandbox(handle)

    assert any(c[1] == "stop" for c in calls)
    assert any(c[1] == "rm" for c in calls)


@pytest.mark.asyncio
async def test_stop_none_handle_is_a_noop(monkeypatch):
    calls: list[list[str]] = []
    monkeypatch.setattr(asyncio, "create_subprocess_exec", _docker_dispatcher(calls))

    await cs.stop_copilot_sandbox(None)

    assert calls == []


@pytest.mark.asyncio
async def test_get_or_spawn_sticky_reuses_handle_for_same_thread(monkeypatch, _instant_tcp_ready):
    calls: list[list[str]] = []
    monkeypatch.setattr(asyncio, "create_subprocess_exec", _docker_dispatcher(calls))

    settings = _settings()
    first = await cs.get_or_spawn_sticky(
        thread_id="thread-1", workspace="/tmp/ws", label="app_builder", settings=settings,
    )
    second = await cs.get_or_spawn_sticky(
        thread_id="thread-1", workspace="/tmp/ws", label="app_builder", settings=settings,
    )

    assert first is not None
    assert second is first
    assert sum(1 for c in calls if c[1] == "run") == 1


@pytest.mark.asyncio
async def test_get_or_spawn_sticky_spawns_separately_per_thread(monkeypatch, _instant_tcp_ready):
    calls: list[list[str]] = []
    monkeypatch.setattr(asyncio, "create_subprocess_exec", _docker_dispatcher(calls))

    settings = _settings()
    first = await cs.get_or_spawn_sticky(
        thread_id="thread-1", workspace="/tmp/ws", label="app_builder", settings=settings,
    )
    second = await cs.get_or_spawn_sticky(
        thread_id="thread-2", workspace="/tmp/ws", label="app_builder", settings=settings,
    )

    assert first is not None and second is not None
    assert first.name != second.name
    assert sum(1 for c in calls if c[1] == "run") == 2


@pytest.mark.asyncio
async def test_get_or_spawn_sticky_reaps_idle_entries(monkeypatch, _instant_tcp_ready):
    calls: list[list[str]] = []
    monkeypatch.setattr(asyncio, "create_subprocess_exec", _docker_dispatcher(calls))

    clock = {"t": 1000.0}
    monkeypatch.setattr(cs.time, "monotonic", lambda: clock["t"])

    settings = _settings(copilot_sandbox_idle_ttl_seconds=60)
    stale = await cs.get_or_spawn_sticky(
        thread_id="stale-thread", workspace="/tmp/ws", label="app_builder", settings=settings,
    )
    assert stale is not None

    clock["t"] += 120  # past the 60s idle TTL
    fresh = await cs.get_or_spawn_sticky(
        thread_id="fresh-thread", workspace="/tmp/ws", label="app_builder", settings=settings,
    )

    assert fresh is not None
    assert "stale-thread" not in cs._STICKY
    assert "fresh-thread" in cs._STICKY
    # stale entry's container was stopped (docker stop), not just forgotten.
    assert any(c[1] == "stop" and stale.name in c for c in calls)


@pytest.mark.asyncio
async def test_sweep_orphaned_sandboxes_removes_leftover_containers(monkeypatch):
    calls: list[list[str]] = []

    async def _fake_exec(*args, **kwargs):
        cmd = list(args)
        calls.append(cmd)
        if cmd[1] == "ps":
            return _FakeProc(0, b"container-id-1\ncontainer-id-2\n")
        return _FakeProc(0, b"")

    monkeypatch.setattr(asyncio, "create_subprocess_exec", _fake_exec)

    await cs.sweep_orphaned_sandboxes()

    rm_calls = [c for c in calls if c[1] == "rm"]
    assert len(rm_calls) == 1
    assert "container-id-1" in rm_calls[0]
    assert "container-id-2" in rm_calls[0]


@pytest.mark.asyncio
async def test_sweep_orphaned_sandboxes_noop_when_none_found(monkeypatch):
    calls: list[list[str]] = []

    async def _fake_exec(*args, **kwargs):
        cmd = list(args)
        calls.append(cmd)
        if cmd[1] == "ps":
            return _FakeProc(0, b"")
        return _FakeProc(0, b"")

    monkeypatch.setattr(asyncio, "create_subprocess_exec", _fake_exec)

    await cs.sweep_orphaned_sandboxes()

    assert not any(c[1] == "rm" for c in calls)

"""Coding skill for MAF agents — run_script / code_task (agent_coding_skill).

Covers the execution-hygiene contract (workspace jail, secret-scrubbed
subprocess env, timeout, output cap), the durability sweep that mirrors
native-written files into the blob store, and the fail-closed edges (no
workspace, path escape, missing script, bad type). ``code_task`` is tested
against a stubbed Copilot session — the point here is the skill layer's
always-sweep + error shaping, not the engine itself.
"""
from __future__ import annotations

import asyncio
import os
import stat
import time

import acb_skills.code_tools as ct
import pytest
from acb_skills.write_artifact import _WRITE_ARTIFACT_CONTEXT


@pytest.fixture()
def ws(monkeypatch, tmp_path):
    monkeypatch.setitem(_WRITE_ARTIFACT_CONTEXT, "workspace_root", str(tmp_path))
    monkeypatch.setitem(_WRITE_ARTIFACT_CONTEXT, "session_id", "sess-test")
    (tmp_path / "agent-data" / "scripts").mkdir(parents=True)
    (tmp_path / "outputs").mkdir()
    return tmp_path


@pytest.fixture()
def mirrored(monkeypatch):
    """Capture what the sweep mirrors instead of hitting the real store."""
    calls: list[str] = []

    async def _fake(rel_path, data, **kw):
        calls.append(rel_path)

    monkeypatch.setattr(ct, "mirror_to_blob_store", _fake)
    return calls


# ── run_script: fail-closed edges ───────────────────────────────────────────

def test_run_script_without_workspace(monkeypatch):
    monkeypatch.setitem(_WRITE_ARTIFACT_CONTEXT, "workspace_root", None)
    out = asyncio.run(ct.run_script("agent-data/scripts/x.py"))
    assert "no active workspace" in out


def test_run_script_blocks_workspace_escape(ws):
    out = asyncio.run(ct.run_script("../../etc/passwd"))
    assert "escapes the workspace" in out
    out = asyncio.run(ct.run_script("/etc/passwd"))
    assert "escapes the workspace" in out


def test_run_script_missing_points_at_manifest(ws):
    out = asyncio.run(ct.run_script("agent-data/scripts/nope.py"))
    assert "not found" in out
    assert "SCRIPTS.md" in out and "code_task" in out


def test_run_script_rejects_unsupported_type(ws):
    p = ws / "agent-data" / "scripts" / "x.rb"
    p.write_text("puts 1")
    out = asyncio.run(ct.run_script("agent-data/scripts/x.rb"))
    assert "unsupported script type" in out


def test_run_script_rejects_unparseable_args(ws):
    p = ws / "agent-data" / "scripts" / "ok.py"
    p.write_text("print('hi')")
    out = asyncio.run(ct.run_script("agent-data/scripts/ok.py", 'unclosed "quote'))
    assert "bad args" in out


# ── run_script: execution contract ──────────────────────────────────────────

def test_run_script_runs_python_with_args_and_cwd(ws, mirrored):
    p = ws / "agent-data" / "scripts" / "greet.py"
    p.write_text(
        "import os, sys\n"
        "print('args:', sys.argv[1:])\n"
        "print('cwd-ok:', os.getcwd())\n"
    )
    out = asyncio.run(ct.run_script("agent-data/scripts/greet.py", "hello world"))
    assert "exit 0" in out
    assert "args: ['hello', 'world']" in out
    # cwd is the workspace root, so relative outputs/ paths just work.
    assert str(ws.resolve()) in out


def test_run_script_runs_shell_scripts(ws, mirrored):
    p = ws / "agent-data" / "scripts" / "hello.sh"
    p.write_text("echo shell-ok\n")
    p.chmod(p.stat().st_mode | stat.S_IXUSR)
    out = asyncio.run(ct.run_script("agent-data/scripts/hello.sh"))
    assert "exit 0" in out and "shell-ok" in out


def test_run_script_env_is_scrubbed(ws, mirrored, monkeypatch):
    """No token/secret-shaped env vars may reach arbitrary script code."""
    monkeypatch.setenv("GATEWAY_INTERNAL_TOKEN", "sk-super-secret")
    monkeypatch.setenv("OPENAI_API_KEY", "sk-leak")
    monkeypatch.setenv("DATABASE_URL", "postgres://user:pw@host/db")
    p = ws / "agent-data" / "scripts" / "env_dump.py"
    p.write_text("import os; print(sorted(os.environ))")
    out = asyncio.run(ct.run_script("agent-data/scripts/env_dump.py"))
    assert "exit 0" in out
    assert "GATEWAY_INTERNAL_TOKEN" not in out
    assert "OPENAI_API_KEY" not in out
    assert "DATABASE_URL" not in out
    assert "'PATH'" in out  # the allowlist still provides the basics


def test_script_env_allowlist_and_deny_pattern(monkeypatch):
    monkeypatch.setenv("PATH", "/usr/bin")
    monkeypatch.setenv("MY_SECRET_KEY", "x")
    monkeypatch.setenv("SOME_RANDOM_VAR", "y")
    env = ct._script_env()
    assert env.get("PATH") == "/usr/bin"
    assert "MY_SECRET_KEY" not in env
    assert "SOME_RANDOM_VAR" not in env  # not on the allowlist
    assert env.get("PYTHONUNBUFFERED") == "1"


def test_run_script_nonzero_exit_and_stderr(ws, mirrored):
    p = ws / "agent-data" / "scripts" / "boom.py"
    p.write_text("import sys; print('partial'); sys.exit(3)")
    out = asyncio.run(ct.run_script("agent-data/scripts/boom.py"))
    assert "exit 3" in out and "partial" in out


def test_run_script_timeout(ws, mirrored, monkeypatch):
    monkeypatch.setattr(ct, "_RUN_SCRIPT_TIMEOUT", 0.5)
    p = ws / "agent-data" / "scripts" / "sleepy.py"
    p.write_text("import time; time.sleep(10)")
    out = asyncio.run(ct.run_script("agent-data/scripts/sleepy.py"))
    assert "timed out" in out


def test_run_script_sweeps_outputs_to_blob_store(ws, mirrored):
    p = ws / "agent-data" / "scripts" / "writer.py"
    p.write_text(
        "from pathlib import Path\n"
        "Path('outputs/result.csv').write_text('a,b\\n1,2\\n')\n"
        "print('wrote')\n"
    )
    out = asyncio.run(ct.run_script("agent-data/scripts/writer.py"))
    assert "exit 0" in out
    assert "outputs/result.csv" in mirrored
    assert "1 output file(s) persisted" in out


def test_output_cap_truncates_middle():
    text = "a" * 20_000
    capped = ct._cap(text)
    assert len(capped) < 20_000
    assert "truncated" in capped
    assert capped.startswith("a") and capped.endswith("a")


# ── the durability sweep itself ─────────────────────────────────────────────

def test_sweep_mirrors_only_changed_small_files(ws, mirrored):
    old = ws / "agent-data" / "scripts" / "old.py"
    old.write_text("print('old')")
    past = time.time() - 3600
    os.utime(old, (past, past))
    cutoff = time.time() - 1
    (ws / "agent-data" / "scripts" / "new.py").write_text("print('new')")
    (ws / "agent-data" / "SCRIPTS.md").write_text("# scripts")
    (ws / "outputs" / "big.bin").write_bytes(b"x" * (ct._SWEEP_MAX_BYTES + 1))
    (ws / "outputs" / "small.txt").write_text("ok")

    n = asyncio.run(ct._sweep_to_blob_store(ws, since=cutoff))
    assert n == 3
    assert set(mirrored) == {
        "agent-data/scripts/new.py", "agent-data/SCRIPTS.md",
        "outputs/small.txt",
    }


# ── code_task: skill-layer behaviour around the engine ──────────────────────

def test_code_task_without_workspace(monkeypatch):
    monkeypatch.setitem(_WRITE_ARTIFACT_CONTEXT, "workspace_root", None)
    out = asyncio.run(ct.code_task("build a report script"))
    assert "no active workspace" in out


def test_code_task_requires_a_task(ws):
    out = asyncio.run(ct.code_task("   "))
    assert "describe what to build" in out


def test_code_task_success_reports_and_sweeps(ws, mirrored, monkeypatch):
    import orchestrator.code_session as cs

    async def _fake_session(*, task, workspace, **kw):
        # The engine writes via NATIVE file tools (bypassing the mirror) —
        # simulate that, then report.
        from pathlib import Path
        Path(workspace, "agent-data/scripts/report.py").write_text("print(1)")
        Path(workspace, "agent-data/SCRIPTS.md").write_text("# scripts")
        return "Created report.py; run with run_script."

    monkeypatch.setattr(cs, "run_copilot_code_session", _fake_session)
    out = asyncio.run(ct.code_task("make a report script"))
    assert "Created report.py" in out
    assert "2 file(s) persisted to the durable store" in out
    assert set(mirrored) == {
        "agent-data/scripts/report.py", "agent-data/SCRIPTS.md",
    }


def test_code_task_failure_still_sweeps(ws, mirrored, monkeypatch):
    import orchestrator.code_session as cs

    async def _boom(*, task, workspace, **kw):
        from pathlib import Path
        Path(workspace, "agent-data/scripts/half.py").write_text("print(1)")
        raise TimeoutError("session wedged")

    monkeypatch.setattr(cs, "run_copilot_code_session", _boom)
    out = asyncio.run(ct.code_task("make a thing"))
    assert "code_task failed: TimeoutError" in out
    # Partial work is not lost — the sweep still persisted it.
    assert "agent-data/scripts/half.py" in mirrored
    assert "still persisted" in out


# ── platform wiring: floor, addendum, annotations ───────────────────────────

def test_coding_skill_rides_the_core_floor():
    from orchestrator._tool_injection import (
        _CORE_STANDARD_TOOL_NAMES,
        _resolve_injected_scope,
    )
    assert {"run_script", "code_task"} <= _CORE_STANDARD_TOOL_NAMES
    resolved = _resolve_injected_scope(["web_search"])
    assert resolved is not None and "code_task" in resolved


def test_addendum_documents_the_coding_skill():
    from orchestrator._tool_injection import (
        _build_injected_tools_addendum,
        _resolve_injected_scope,
    )
    full = _build_injected_tools_addendum()
    assert "### Coding skill" in full
    assert "code_task(task)" in full and "run_script(path" in full
    assert "agent-data/SCRIPTS.md" in full
    # Rides the floor: even a narrow scope's addendum documents it.
    scoped = _build_injected_tools_addendum(
        effective_scope=frozenset(_resolve_injected_scope(["web_search"]))
    )
    assert "### Coding skill" in scoped
    compact = _build_injected_tools_addendum(
        is_sub_agent=True,
        effective_scope=frozenset(_resolve_injected_scope(["web_search"])),
    )
    assert "run_script" in compact and "code_task" in compact


def test_risk_annotations_registered():
    from acb_skills.tool_annotations import TOOL_ANNOTATIONS
    for name in ("run_script", "code_task"):
        hints = TOOL_ANNOTATIONS[name]
        assert hints["open_world"] is True  # arbitrary code may reach out
        assert hints["destructive"] is False  # workspace-jailed, reversible
        assert hints["read_only"] is False

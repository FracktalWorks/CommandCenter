"""Unit tests for run_diagnostics — the clearer alias of get_errors.

The code-diagnostics tool existed only as `get_errors`, a name models were not
reliably reaching for (a live Copilot run asked to "run diagnostics" called
recall_notes instead). `run_diagnostics` is the action-oriented alias; both must
resolve to the same behaviour, be injected for every agent, and be risk-annotated
so the permission layer treats them identically.
"""
from __future__ import annotations

import asyncio

from acb_skills import error_tools
from acb_skills.tool_annotations import get_annotations


def test_run_diagnostics_is_a_callable_alias_of_get_errors():
    assert hasattr(error_tools, "run_diagnostics")
    assert asyncio.iscoroutinefunction(error_tools.run_diagnostics)


def test_both_names_produce_the_same_result(tmp_path, monkeypatch):
    # Point the workspace at an empty temp dir so both return the clean message.
    monkeypatch.setattr(error_tools, "_find_workspace_root", lambda: str(tmp_path))
    r_get = asyncio.run(error_tools.get_errors("[]"))
    r_run = asyncio.run(error_tools.run_diagnostics("[]"))
    assert r_get == r_run


def test_run_diagnostics_is_annotated_read_only_and_non_destructive():
    ann = get_annotations("run_diagnostics")
    assert ann["read_only"] is True
    assert ann["destructive"] is False
    # Must match get_errors' annotation exactly (same tool, same risk posture).
    assert ann == get_annotations("get_errors")


def test_run_diagnostics_reports_a_syntax_error(tmp_path, monkeypatch):
    # A file with a real syntax error must surface in the diagnostics report.
    bad = tmp_path / "broken.py"
    bad.write_text("def f(:\n    pass\n", encoding="utf-8")
    monkeypatch.setattr(error_tools, "_find_workspace_root", lambda: str(tmp_path))
    out = asyncio.run(error_tools.run_diagnostics('["broken.py"]'))
    assert "No errors found" not in out
    assert "broken.py" in out

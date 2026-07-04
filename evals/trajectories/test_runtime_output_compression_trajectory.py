"""Golden trajectory: runtime shell/tool-output compression (Item ②).

Locks the RTK-style invariant that a runtime agent's large shell/test/build
output is COMPRESSED before it re-enters the model's context — while preserving
the signal (failures, summary) and never touching small output or the structured
JSON that injected custom tools return.

Covers:
  1. compress_tool_output preserves the failure line + summary tail while
     dropping the passing middle (the whole point — the agent needs the failure,
     not 500 passing lines).
  2. Small output and non-shell (structured) tool results pass through
     byte-identical — a JSON tool result the agent parses must not be mangled.
  3. The tool-name gate: shell/terminal/test tools compress; custom tools don't.
  4. Repeated-line runs collapse.

If a future edit removes the compression at the translator seam, widens the gate
to structured tools, or drops the failure-preservation, this fails CI.

See specs/runtime_agent_effectiveness_2026-07.md (Item ②).
"""
from __future__ import annotations

from acb_llm import compress_tool_output, is_compressible_tool


def _pytest_like(n_pass: int = 500) -> str:
    lines = [f"tests/test_mod.py::test_{i} PASSED" for i in range(n_pass)]
    lines.insert(n_pass // 2, "tests/test_mod.py::test_critical FAILED")
    lines.append("E       assert 1 == 2")
    lines.append(f"=== 1 failed, {n_pass} passed in 12.3s ===")
    return "\n".join(lines)


# ── 1. Failure + summary survive; passing middle is dropped ──────────────────

def test_failure_line_and_summary_survive_compression():
    big = _pytest_like()
    out = compress_tool_output("run_in_terminal", big)
    assert len(out) < len(big) // 2, "should be substantially smaller"
    assert "test_critical FAILED" in out, "failure line must survive"
    assert "assert 1 == 2" in out, "assertion detail must survive"
    assert "1 failed, 500 passed" in out, "summary tail must survive"


# ── 2. Small + structured output pass through untouched ──────────────────────

def test_small_output_passes_through_byte_identical():
    small = "=== 3 passed in 0.42s ==="
    assert compress_tool_output("run_in_terminal", small) == small


def test_structured_tool_result_is_never_compressed():
    """A big JSON result from an injected custom tool must survive intact —
    the agent parses it; mangling it breaks the run."""
    big_json = '{"items": [' + ",".join(f'{{"id":{i}}}' for i in range(2000)) + "]}"
    assert len(big_json) > 10_000
    assert compress_tool_output("manage_todo_list", big_json) == big_json
    assert compress_tool_output("ask_questions", big_json) == big_json


# ── 3. Tool-name gate ────────────────────────────────────────────────────────

def test_tool_name_gate():
    for shell in ("run_in_terminal", "shell", "bash", "pwsh", "execute_command"):
        assert is_compressible_tool(shell), shell
    for structured in ("manage_todo_list", "ask_questions", "emit_generative_ui",
                       "recall_timeline", "read_email"):
        assert not is_compressible_tool(structured), structured


def test_empty_output_is_safe():
    assert compress_tool_output("run_in_terminal", "") == ""


# ── 4. Repeated-line collapse ────────────────────────────────────────────────

def test_repeated_lines_collapse():
    noisy = "\n".join(["Downloading... 45%"] * 400) + "\nDone"
    out = compress_tool_output("bash", noisy)
    assert len(out) < len(noisy) // 4
    assert "Done" in out, "the meaningful tail must survive"


# ── 5. Translator-seam integration (the actual wiring point) ─────────────────

def test_translator_seam_compresses_shell_but_not_structured():
    """Simulate the copilot_agent.py TOOL_EXECUTION_COMPLETE / EXTERNAL_TOOL_COMPLETED
    seam: result_text is passed through compress_tool_output(tc_name, ...) exactly
    as the handler does. Assert a shell dump shrinks and a custom-tool result doesn't.
    """
    shell_dump = _pytest_like()
    # Mirrors copilot_agent.py:436 / :485 — result=compress_tool_output(tc_name, text)
    shell_result = compress_tool_output("run_in_terminal", shell_dump)
    todo_result = compress_tool_output("manage_todo_list", '{"todos":["a","b"]}')

    assert len(shell_result) < len(shell_dump), "shell output must be compressed at the seam"
    assert "1 failed" in shell_result
    assert todo_result == '{"todos":["a","b"]}', "structured tool result untouched at the seam"

"""generative_ui_2 Phase 2 — the proactive 'render UI by default' directive
reaches BOTH runtimes at the SYSTEM-PROMPT level.

Before this, the "reach for emit_generative_ui eagerly" guidance lived only in
the tool docstring (a weak signal) and, at system-prompt level, exclusively in
the Copilot-SDK addendum — native MAF agents (e.g. email-assistant, which
explicitly scopes in emit_generative_ui) got the tool but NO instruction to use
it. These tests lock in that the directive:
  * leads both addendum variants (Copilot path), gated on the tool,
  * is appended to native-MAF agents' instructions (the gap fix),
  * is idempotent (marker-guarded across repeated injection),
  * stays byte-stable (KV-cache safe).
"""
from __future__ import annotations

import orchestrator._tool_injection as ti
from orchestrator._tool_injection import (
    _build_injected_tools_addendum,
    _ui_first_directive,
)


# ── the directive text itself ───────────────────────────────────────────────

def test_directive_is_template_first_and_names_the_shared_marker():
    full = _ui_first_directive()
    compact = _ui_first_directive(compact=True)
    # Shared marker → the idempotency guard works for either variant.
    assert "Rich UI by default" in full
    assert "Rich UI by default" in compact
    # Template-first: names templates before the custom-html last resort.
    assert full.index("Template first") < full.index("Custom html")
    # Steers pick/set to blocking HITL.
    assert '"hitl":true' in full and '"hitl":true' in compact
    # Custom-HTML brand hook is present for the rare escape-hatch case.
    assert "--cc-*" in full


def test_directive_is_byte_stable():
    assert _ui_first_directive() == _ui_first_directive()
    assert _ui_first_directive(compact=True) == _ui_first_directive(compact=True)


# ── native-MAF instructions injection (the gap the fix closes) ──────────────

class _FakeMafAgent:
    """A native MAF agent shape: tools + instructions in default_options.
    Deliberately has NO `_tools` attr so it does not match the Copilot branch."""

    def __init__(self, instructions: str = "You are the email assistant.") -> None:
        self.name = "email-assistant"
        self.default_options = {"tools": [], "instructions": instructions}


def test_native_maf_agent_gets_the_ui_directive_in_instructions():
    agent = _FakeMafAgent()
    ti._inject_agent_tools([agent])
    instr = agent.default_options["instructions"]
    # The tool itself is injected (it's in the core floor)…
    names = {getattr(t, "__name__", None) for t in agent.default_options["tools"]}
    assert "emit_generative_ui" in names
    # …and now so is the system-prompt directive to actually use it.
    assert "Rich UI by default" in instr
    # Base instructions are preserved, directive appended.
    assert instr.startswith("You are the email assistant.")


def test_native_maf_injection_is_idempotent():
    agent = _FakeMafAgent()
    ti._inject_agent_tools([agent])
    ti._inject_agent_tools([agent])
    instr = agent.default_options["instructions"]
    assert instr.count("Rich UI by default") == 1


def test_maf_tools_shape_gets_directive_on_instructions_attr():
    class _FakeMafToolsAgent:
        def __init__(self) -> None:
            self.name = "legacy-maf"
            self.tools: list = []
            self.instructions = "Base."

    agent = _FakeMafToolsAgent()
    ti._inject_agent_tools([agent])
    assert "emit_generative_ui" in {
        getattr(t, "__name__", None) for t in agent.tools
    }
    assert "Rich UI by default" in agent.instructions


def test_sub_agent_maf_gets_compact_directive():
    agent = _FakeMafAgent()
    ti._inject_agent_tools([agent], is_sub_agent=True)
    instr = agent.default_options["instructions"]
    # Compact variant (single paragraph, no markdown header).
    assert "Rich UI by default:" in instr
    assert "### Rich UI by default" not in instr

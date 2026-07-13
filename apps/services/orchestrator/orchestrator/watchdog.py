"""Unified watchdog policy for the executor's run loops.

Before this module the timeout knobs lived as inline ``os.environ.get(...)``
reads scattered across three executor call sites (native stream idle, native
tiered selection, Tier-1.5 per-tool). That made the policy impossible to
inspect or test and easy to drift. This centralises the VALUES and the
tier-selection RULE in one place (core_module_map A1/A2 "unified watchdog
policy").

Two distinct mechanisms remain — they are genuinely different and are NOT
merged (that would be over-generalisation):

* **Idle watchdog** (native MAF Tier 1): bounds the gap BETWEEN stream updates.
  Tiered by run state — a parked HITL question or an in-flight tool legitimately
  produces no updates for a while, so each gets a longer budget than a bare
  idle stream. See :meth:`WatchdogPolicy.idle_timeout`.
* **Per-tool timeout** (Tier-1.5 batch shim): bounds a SINGLE async tool call so
  a hung tool surfaces as an error instead of blocking the stream until the
  HTTP abort. HITL / delegation tools are exempt (they park by design). See
  :attr:`WatchdogPolicy.tool_execution`.

All values are read from the environment ONCE at policy construction, so a
single ``default_watchdog()`` instance gives every loop the same numbers.
"""
from __future__ import annotations

import os
from dataclasses import dataclass


def _env_float(name: str, default: float) -> float:
    """Parse an env var as float, falling back on missing/invalid input."""
    try:
        raw = os.environ.get(name)
        return float(raw) if raw is not None and raw.strip() else default
    except (TypeError, ValueError):
        return default


@dataclass(frozen=True)
class WatchdogPolicy:
    """Timeout budgets + the native tier-selection rule, in one place."""

    # ── Idle watchdog (native stream, seconds between updates) ──────────────
    idle: float = 120.0            # bare idle stream — nothing happening
    tool_open: float = 600.0       # >=1 tool in flight (legitimately quiet)
    hitl_pending: float = 3600.0   # parked on a human answer
    # ── Per-tool execution (Tier-1.5 batch shim, one tool call) ─────────────
    tool_execution: float = 300.0

    def idle_timeout(self, *, hitl_pending: bool, tools_open: int) -> float:
        """Select the idle budget for the current native-stream run state.

        Priority: a pending HITL question wins (longest wait), then an in-flight
        tool, else the bare idle budget. This is the exact rule the native loop
        applied inline; centralised so both the value and the ordering are
        testable and can't drift.
        """
        if hitl_pending:
            return self.hitl_pending
        if tools_open > 0:
            return self.tool_open
        return self.idle


class LoopDetector:
    """Trip when the SAME tool call (name + args) repeats too many times.

    A model can wedge itself re-issuing an identical call (bad plan, ignored
    error), burning tokens until the idle/HTTP timeout. This counts completed
    calls by ``name(args)`` signature and reports a trip once any signature hits
    ``max_repeats``. Distinct-arg repeats never trip — only genuine loops.
    """

    def __init__(self, max_repeats: int = 5) -> None:
        self.max_repeats = max_repeats
        self._counts: dict[str, int] = {}

    def record(self, name: str, args: str) -> bool:
        """Record one completed call; return True if the loop threshold is hit."""
        sig = f"{name or 'tool'}({args or ''})"
        self._counts[sig] = self._counts.get(sig, 0) + 1
        return self._counts[sig] >= self.max_repeats


def default_watchdog() -> WatchdogPolicy:
    """Build the process watchdog policy from the environment (read once).

    Env knobs (unchanged names, for backward compat):
      NATIVE_STREAM_IDLE_TIMEOUT_SECONDS   → idle          (default 120)
      NATIVE_TOOL_IDLE_TIMEOUT_SECONDS     → tool_open     (default 600)
      HITL_IDLE_TIMEOUT_SECONDS            → hitl_pending  (default 3600)
      COPILOT_TOOL_TIMEOUT_SECONDS         → tool_execution(default 300)
    """
    return WatchdogPolicy(
        idle=_env_float("NATIVE_STREAM_IDLE_TIMEOUT_SECONDS", 120.0),
        tool_open=_env_float("NATIVE_TOOL_IDLE_TIMEOUT_SECONDS", 600.0),
        hitl_pending=_env_float("HITL_IDLE_TIMEOUT_SECONDS", 3600.0),
        tool_execution=_env_float("COPILOT_TOOL_TIMEOUT_SECONDS", 300.0),
    )

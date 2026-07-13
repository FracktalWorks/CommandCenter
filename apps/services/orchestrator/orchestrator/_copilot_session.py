"""Copilot-SDK session tuning: permission handler + infinite-session policy.

Extracted from ``executor.py`` (foundation maintainability refactor) — no
behaviour change (log event strings preserved). These configure a GitHub
Copilot-SDK agent's per-run session:

* :func:`_copilot_permission_handler` selects the SDK permission handler
  (risk-aware vs blanket approve_all) per ``AGENT_PERMISSION_MODE``.
* :func:`_copilot_infinite_session_config` / :func:`_apply_copilot_infinite_sessions`
  neutralise the Copilot backend's context-window auto-compaction, which
  false-trips "context length exceeded" on BYOK models whose real window the
  backend can't learn.
"""
from __future__ import annotations

import os
from typing import Any

from acb_common import get_logger

_log = get_logger("orchestrator.copilot_session")


def _copilot_permission_handler() -> Any:
    """Return the Copilot-SDK permission handler for a run (B6 / HH-6).

    ``AGENT_PERMISSION_MODE=approve_all`` → the SDK's blanket ``approve_all``
    (escape hatch / old behaviour). Otherwise → our risk-aware handler, which
    blocks dangerous shell + out-of-workspace writes, defers destructive tools to
    their own request_confirmation gate, and logs every privileged op. Falls back
    to ``approve_all`` if the policy module can't be imported (never break runs).
    """
    from copilot import PermissionHandler as _PH  # noqa: PLC0415

    if os.environ.get("AGENT_PERMISSION_MODE", "enforce").strip().lower() == (
        "approve_all"
    ):
        return _PH.approve_all
    try:
        from acb_skills.permission_policy import (  # noqa: PLC0415
            risk_aware_permission_handler,
        )
        return risk_aware_permission_handler
    except Exception:  # noqa: BLE001
        return _PH.approve_all


def _copilot_infinite_session_config() -> dict[str, Any] | None:
    """Return the ``infinite_sessions`` SessionConfig block for Copilot-SDK runs.

    The Copilot backend runs its own "infinite session" auto-compaction, keyed to
    *the model's context window* — it starts background compaction at
    ``background_compaction_threshold`` (default 0.80) and HARD-BLOCKS the turn at
    ``buffer_exhaustion_threshold`` (default 0.95) of that window. For our BYOK
    models (e.g. DeepSeek-V4-Pro, real 1M context) the backend does NOT know the
    true window — its ``client.list_models()`` talks to api.githubcopilot.com, which
    has no entry for our gateway-routed model — so it falls back to a small default
    window and its 0.95 guard trips a false "context length exceeded" on short,
    tool-heavy runs (diagnosed on technical-project-planner run 5b8c5836, 2026-07-03).

    Since the backend can't be told the real window for a BYOK model, we relax the
    guards so it stops prematurely blocking. Our own gateway-side context assembly
    (acb_llm.assemble_run_context / C2) already bounds the prompt, and the real
    DeepSeek API honours its 1M window — so the Copilot backend's guess should not
    be the thing that fails the run.

    Env overrides (all optional):
      - ``COPILOT_INFINITE_SESSIONS=off``  → disable the backend compaction entirely
        (``enabled: false``) — the strongest "stop guessing my window" setting.
      - ``COPILOT_COMPACTION_THRESHOLD``   → background_compaction_threshold (float).
      - ``COPILOT_BUFFER_THRESHOLD``       → buffer_exhaustion_threshold (float).
    Returns ``None`` when the operator has explicitly opted out of any override
    (``COPILOT_INFINITE_SESSIONS=default``), leaving the SDK's own defaults intact.
    """
    mode = os.environ.get("COPILOT_INFINITE_SESSIONS", "").strip().lower()
    if mode == "default":
        return None  # leave SDK defaults untouched (escape hatch)
    if mode == "off":
        return {"enabled": False}

    def _f(name: str, fallback: float) -> float:
        raw = os.environ.get(name, "").strip()
        try:
            v = float(raw) if raw else fallback
        except ValueError:
            v = fallback
        # Keep in the valid (0, 1] band the backend expects.
        return min(max(v, 0.01), 1.0)

    # Relaxed defaults: don't background-compact until nearly full, and don't
    # hard-block until the window is genuinely exhausted. This neutralises the
    # premature 0.80/0.95 trip on a wrongly-small assumed window without turning
    # compaction fully off (a genuinely huge run can still be managed).
    return {
        "enabled": True,
        "background_compaction_threshold": _f("COPILOT_COMPACTION_THRESHOLD", 0.92),
        "buffer_exhaustion_threshold": _f("COPILOT_BUFFER_THRESHOLD", 0.99),
    }


def _apply_copilot_infinite_sessions(agent: Any) -> bool:
    """Inject ``infinite_sessions`` into a Copilot agent's SessionConfig.

    The agent-framework wrapper's ``_create_session`` builds SessionConfig from a
    FIXED set of keys (model/system_message/tools/permission/mcp) and drops
    ``infinite_sessions`` — even though the underlying ``client.create_session``
    honours it. So setting it on ``agent._default_options`` alone is not enough; we
    wrap ``_create_session`` to merge our block into the config it produces.

    The effective config is computed at CALL TIME (inside ``_wrapped``), not at wrap
    time.  This matters because BYOK provider detection sets
    ``agent._default_options["provider"]`` AFTER ``_inject_agent_tools`` (which calls
    this function) but BEFORE ``agent.run()`` (which calls ``_create_session``).  By
    detecting BYOK at call time we can always apply the correct policy:

    - BYOK agent (``provider`` set in ``_default_options``): ``{enabled: False}`` —
      the Copilot backend cannot learn the real context window for a BYOK model (its
      ``list_models()`` queries ``api.githubcopilot.com``, which has no entry for our
      gateway-routed model), so it falls back to ~90K and any threshold × 90K is
      useless against a 1M-window model. Disabling is the only correct policy.
    - Copilot-native agent: relaxed thresholds from ``_copilot_infinite_session_config``
      (backend knows the real window and its compaction is meaningful).

    Idempotent (guards ``__cc_inf_sessions__``); best-effort (never raises). Returns
    True if the wrap was applied.
    """
    # Honour the operator opt-out at wrap time — no wrap, no runtime overhead.
    if os.environ.get("COPILOT_INFINITE_SESSIONS", "").strip().lower() == "default":
        return False
    orig = getattr(agent, "_create_session", None)
    if not callable(orig) or getattr(agent, "__cc_inf_sessions__", False):
        return False

    import functools  # noqa: PLC0415

    @functools.wraps(orig)
    async def _wrapped(streaming: bool, runtime_options: Any = None) -> Any:
        # ``_create_session`` builds SessionConfig and calls
        # ``client.create_session`` in one shot, dropping infinite_sessions on the
        # way. We can't edit the config it produces, so we intercept at the client:
        # swap in a create_session that merges our block, run the original, restore.
        #
        # Compute effective config NOW — provider may have been set after the wrap.
        _mode = os.environ.get("COPILOT_INFINITE_SESSIONS", "").strip().lower()
        if _mode == "default":
            # Opt-out changed at runtime — skip injection this call.
            return await orig(streaming, runtime_options)
        _opts = getattr(agent, "_default_options", {}) or {}
        _is_byok = bool(_opts.get("provider"))
        if _mode == "off" or _is_byok:
            # BYOK: backend window estimate is wrong → disable compaction entirely.
            # Our C2 assembly (acb_llm.assemble_run_context) already bounds the
            # prompt; the real provider API honours its true window.
            effective_cfg: dict[str, Any] = {"enabled": False}
        else:
            # Copilot-native: backend knows the real window → relaxed thresholds
            # are meaningful. Fall back to disabled if config returns None.
            effective_cfg = _copilot_infinite_session_config() or {"enabled": False}

        client = getattr(agent, "_client", None)
        orig_client_create = getattr(client, "create_session", None) if client else None
        if not callable(orig_client_create):
            return await orig(streaming, runtime_options)

        async def _client_create(config: Any) -> Any:
            if isinstance(config, dict) and "infinite_sessions" not in config:
                config = {**config, "infinite_sessions": effective_cfg}
            return await orig_client_create(config)

        try:
            client.create_session = _client_create  # type: ignore[attr-defined]
            return await orig(streaming, runtime_options)
        finally:
            client.create_session = orig_client_create  # type: ignore[attr-defined]

    try:
        agent._create_session = _wrapped  # type: ignore[attr-defined]
        agent.__cc_inf_sessions__ = True  # type: ignore[attr-defined]
        _log.info("executor.copilot_infinite_sessions_applied", byok_aware=True)
        return True
    except Exception:  # noqa: BLE001
        return False

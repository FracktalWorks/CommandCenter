"""Structured logging via structlog. Call configure_logging() at process start.

Two output modes (``LOG_FORMAT`` env, or the ``json_logs`` arg):
  * ``console`` (default) — colored, human-readable; good for local dev.
  * ``json``            — one JSON object per line; machine-parseable so prod
                          logs (journald → ``journalctl -o cat``) can be
                          grepped/filtered by field and shipped to an aggregator.

Correlation: :func:`bind_run_context` binds ``run_id``/``thread_id``/``agent``/
``user`` into structlog's contextvars so EVERY log line emitted during a run
carries them automatically — the thing that makes "show me all logs for run X"
possible (E2 observability). Bind at the run boundary, clear in ``finally``.
"""
from __future__ import annotations

import logging
import os

import structlog


def _want_json(json_logs: bool | None) -> bool:
    """Resolve the renderer: explicit arg wins, else ``LOG_FORMAT`` env.

    ``LOG_FORMAT=json`` (or ``1``/``true``) → JSON; anything else → console.
    """
    if json_logs is not None:
        return json_logs
    fmt = os.environ.get("LOG_FORMAT", "").strip().lower()
    return fmt in ("json", "1", "true", "yes")


def configure_logging(
    level: str = "INFO", *, json_logs: bool | None = None,
) -> None:
    logging.basicConfig(format="%(message)s", level=level.upper())
    renderer: object = (
        structlog.processors.JSONRenderer()
        if _want_json(json_logs)
        else structlog.dev.ConsoleRenderer(colors=True)
    )
    structlog.configure(
        processors=[
            structlog.contextvars.merge_contextvars,
            structlog.processors.add_log_level,
            structlog.processors.TimeStamper(fmt="iso"),
            structlog.processors.StackInfoRenderer(),
            structlog.processors.format_exc_info,
            renderer,
        ],
        wrapper_class=structlog.make_filtering_bound_logger(
            getattr(logging, level.upper(), logging.INFO)
        ),
        cache_logger_on_first_use=True,
    )


def get_logger(name: str | None = None) -> structlog.stdlib.BoundLogger:
    return structlog.get_logger(name)


# ── Run correlation (E2 observability) ───────────────────────────────────────

# The context keys bound per run. Kept small + stable so every log line during a
# run gains the same joinable fields (and so bind/clear stay symmetric).
# ``source`` is the originating app (chat / email / tasks / …) so the live
# activity feed can attribute an activation to the surface that triggered it.
_RUN_CONTEXT_KEYS = ("run_id", "thread_id", "agent", "user", "source")


def bind_run_context(
    *,
    run_id: str | None = None,
    thread_id: str | None = None,
    agent: str | None = None,
    user: str | None = None,
    source: str | None = None,
) -> None:
    """Bind run-correlation fields into structlog contextvars.

    After this, every ``get_logger(...).info(...)`` on the SAME asyncio task /
    thread context automatically includes the given fields — so you can filter
    all log lines for one agent run. Only non-empty values are bound. Pair with
    :func:`clear_run_context` in a ``finally`` at the run boundary.
    """
    fields = {
        k: v
        for k, v in (
            ("run_id", run_id),
            ("thread_id", thread_id),
            ("agent", agent),
            ("user", user),
            ("source", source),
        )
        if v
    }
    if fields:
        structlog.contextvars.bind_contextvars(**fields)


def clear_run_context() -> None:
    """Unbind the run-correlation fields bound by :func:`bind_run_context`."""
    structlog.contextvars.unbind_contextvars(*_RUN_CONTEXT_KEYS)


def get_run_context() -> dict[str, str]:
    """Return the currently-bound run-correlation fields (for attribution).

    Lets non-run code (e.g. the LLM client's usage emitter) tag its records
    with the active run without threading ids through every call signature.
    """
    ctx = structlog.contextvars.get_contextvars()
    return {k: ctx[k] for k in _RUN_CONTEXT_KEYS if ctx.get(k)}

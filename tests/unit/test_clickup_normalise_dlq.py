"""ClickUp normalisation must not dead-letter tasks it successfully persisted.

The bug this pins
-----------------
``_normalise_task`` committed the graph session, wrote a ``task_normalised``
audit row, and then logged:

    _log.info("clickup.task.normalised", task_id=task_id, event=event_type, **counts)

``event`` is **structlog's own message parameter**, so that call raised
``TypeError: meth() got multiple values for argument 'event'``. The raise landed
inside the same ``try`` as the commit, so the ``except`` logged
``clickup.task.normalise_failed`` and called ``enqueue_dlq`` — for a task that
had persisted correctly. Every successful ClickUp task normalisation produced a
dead-letter entry and a false failure log.

``tests/unit/test_clickup_ingestor.py`` cannot see this: it stubs the whole
function (``monkeypatch.setattr("…webhook._normalise_task", AsyncMock())``), so
the body never executes there. These tests drive the **real** function directly,
with only its outbound edges faked — no ClickUp API, no DB, no Redis.

``event=`` is the *only* structlog kwarg that collides this way (``level=``,
``timestamp=``, ``logger=``, ``msg=``, ``exc_info=``, ``stack_info=``, ``error=``,
``source=``, ``module=`` all pass), which is why the guard at the bottom of this
file checks for exactly that one name.
"""
from __future__ import annotations

import ast
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock

import pytest
from ingestion.sources.clickup import webhook

_ROOT = Path(__file__).resolve().parents[2]

PAYLOAD = {"event": "taskUpdated", "task_id": "abc123"}
COUNTS = {"project": 1, "person": 0, "task": 1}


@pytest.fixture
def normalise_env(monkeypatch):
    """Fake every outbound edge of ``_normalise_task``; keep the body real."""
    import acb_graph
    from ingestion.sources.clickup import client, normaliser

    session = MagicMock()
    session_cm = MagicMock()
    session_cm.__enter__ = MagicMock(return_value=session)
    session_cm.__exit__ = MagicMock(return_value=False)

    env = MagicMock()
    env.get_task = AsyncMock(return_value={"id": "abc123", "name": "A task"})
    env.normalise_tasks = MagicMock(return_value=COUNTS)
    env.record = MagicMock()
    env.enqueue_dlq = MagicMock(return_value="dlq-1")
    env.session = session

    monkeypatch.setattr(client, "get_task", env.get_task)
    monkeypatch.setattr(acb_graph, "get_session", MagicMock(return_value=session_cm))
    monkeypatch.setattr(normaliser, "normalise_tasks", env.normalise_tasks)
    monkeypatch.setattr(webhook, "record", env.record)
    monkeypatch.setattr(webhook, "enqueue_dlq", env.enqueue_dlq)
    return env


# ---------------------------------------------------------------------------
# The regression itself
# ---------------------------------------------------------------------------

async def test_successful_normalisation_does_not_dead_letter(normalise_env):
    """A task that normalises cleanly must produce ZERO DLQ writes.

    This is the assertion that fails before the ``clickup_event=`` fix and
    passes after it.
    """
    await webhook._normalise_task("abc123", "taskUpdated", PAYLOAD)

    normalise_env.normalise_tasks.assert_called_once()
    assert normalise_env.record.call_count == 1
    assert normalise_env.record.call_args[0][0].action == "task_normalised"
    assert normalise_env.enqueue_dlq.call_count == 0, (
        "a successfully-normalised task was dead-lettered — the success path "
        "raised after the commit (see module docstring)"
    )


async def test_fetch_failure_still_dead_letters(normalise_env):
    """The mirror case: the DLQ path must survive the fix.

    Without this, `test_successful_normalisation_does_not_dead_letter` could be
    made to pass by neutering `enqueue_dlq` altogether.
    """
    normalise_env.get_task.side_effect = RuntimeError("clickup 500")

    await webhook._normalise_task("abc123", "taskUpdated", PAYLOAD)

    assert normalise_env.enqueue_dlq.call_count == 1
    assert normalise_env.normalise_tasks.call_count == 0
    assert normalise_env.record.call_count == 0


async def test_normalise_failure_still_dead_letters(normalise_env):
    """A genuine normalisation failure still dead-letters."""
    normalise_env.normalise_tasks.side_effect = RuntimeError("bad row")

    await webhook._normalise_task("abc123", "taskUpdated", PAYLOAD)

    assert normalise_env.enqueue_dlq.call_count == 1
    assert "normalise failed" in normalise_env.enqueue_dlq.call_args.kwargs["error"]


# ---------------------------------------------------------------------------
# Guard: the bug class, repo-wide
# ---------------------------------------------------------------------------

_LOG_METHODS = frozenset({"debug", "info", "warning", "warn", "error", "exception", "critical"})
_SCANNED = ("apps", "packages")
_SKIP_DIRS = frozenset({".venv", "node_modules", "__pycache__", ".next", "build", "dist"})


def _offenders() -> list[str]:
    found: list[str] = []
    for base in _SCANNED:
        for py in (_ROOT / base).rglob("*.py"):
            if _SKIP_DIRS.intersection(py.parts):
                continue
            try:
                tree = ast.parse(py.read_text(encoding="utf-8"))
            except (SyntaxError, UnicodeDecodeError):
                continue
            for node in ast.walk(tree):
                if not isinstance(node, ast.Call):
                    continue
                func = node.func
                if not isinstance(func, ast.Attribute) or func.attr not in _LOG_METHODS:
                    continue
                if any(kw.arg == "event" for kw in node.keywords):
                    found.append(
                        f"{py.relative_to(_ROOT)}:{node.lineno}: .{func.attr}(… event=…)"
                    )
    return found


def test_no_logger_call_passes_an_event_kwarg():
    """``event=`` on a structlog logger raises ``TypeError`` at call time.

    It is a runtime bomb that no import-time check, type checker or DB-less test
    of the *caller* will surface — it only fires when that log line executes,
    which for both instances found so far was on the success path of a webhook.
    Use a namespaced key instead (``clickup_event=``, ``zoho_event=``).

    AST-based rather than regex so a call split across lines cannot hide.
    """
    offenders = _offenders()
    assert not offenders, (
        "logger call(s) passing structlog's reserved `event=` kwarg — these "
        "raise TypeError when the line executes (see module docstring); rename "
        "the key, e.g. `clickup_event=`:\n" + "\n".join(offenders)
    )

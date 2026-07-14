"""Email → task capture fills the full clarify field-set outside the inbox.

When the router files a captured email as an actionable task (NEXT/CALENDAR)
rather than a bare INBOX item, it must ALSO clarify energy / time-estimate /
subtasks — the same fields the inbox Clarify flow produces — so the task lands
complete. These tests lock:

  * ``_coerce_mins`` coerces the LLM's minute estimate defensively;
  * the deterministic fallback carries the new keys (empty);
  * ``_llm_capture`` surfaces energy/estimate/subtasks for a NEXT capture, and
    DROPS them (they'd be noise) for a non-actionable WAITING/SOMEDAY capture.
"""
from __future__ import annotations

import json
import types

from gateway.routes.tasks import capture_email as ce


def test_coerce_mins_accepts_numbers_and_strings():
    assert ce._coerce_mins(25) == 25
    assert ce._coerce_mins("30") == 30
    assert ce._coerce_mins(12.9) == 12          # truncates
    assert ce._coerce_mins("  45  ") == 45


def test_coerce_mins_rejects_junk_and_nonpositive():
    assert ce._coerce_mins(None) is None
    assert ce._coerce_mins("") is None
    assert ce._coerce_mins("soon") is None
    assert ce._coerce_mins(0) is None
    assert ce._coerce_mins(-5) is None


def test_fallback_draft_has_full_field_shape():
    fb = ce.draft_task_fallback("Re: Vendor quote", "Sanjay", "please review")
    # The new clarify fields are present (empty) so every write path can read
    # them uniformly whether the draft came from the LLM or the fallback.
    assert fb["energy"] == ""
    assert fb["time_estimate_mins"] is None
    assert fb["subtasks"] == []
    assert fb["disposition"] == "INBOX"


def _patch_llm(monkeypatch, payload: dict):
    """Make ``_llm_capture`` see a fixed JSON completion."""
    async def fake_completion(*_a, **_k):
        msg = types.SimpleNamespace(content=json.dumps(payload))
        choice = types.SimpleNamespace(message=msg)
        return types.SimpleNamespace(choices=[choice]), "model"

    import acb_llm.context as ctx
    monkeypatch.setattr(ctx, "acompletion_with_fallback", fake_completion)


async def _run_capture(**overrides):
    kwargs = dict(
        subject="Vendor quote", from_name="Sanjay", from_email="s@x.io",
        to_line="me@x.io", cc_line="", owner_addrs={"me@x.io"},
        body="Please approve the revised quote by Friday.", thread="",
        people=[], model="tier-fast",
    )
    kwargs.update(overrides)
    return await ce._llm_capture(**kwargs)


async def test_llm_capture_keeps_full_fields_for_next(monkeypatch):
    _patch_llm(monkeypatch, {
        "title": "Approve Sanjay's revised vendor quote",
        "notes": "Sanjay needs sign-off by Friday.",
        "disposition": "NEXT", "next_action": "Review the quote",
        "assignee_name": None, "due_at": None, "defer_until": None,
        "context": "@computer",
        "energy": "medium", "time_estimate_mins": 20,
        "subtasks": ["Read the quote", "Compare to prior", "Reply to approve"],
    })
    out = await _run_capture()
    assert out is not None
    assert out["disposition"] == "NEXT"
    assert out["energy"] == "medium"
    assert out["time_estimate_mins"] == 20
    assert out["subtasks"] == ["Read the quote", "Compare to prior",
                               "Reply to approve"]


async def test_llm_capture_drops_action_fields_for_waiting(monkeypatch):
    # A WAITING (or SOMEDAY) capture isn't the owner's to do now, so energy /
    # estimate / subtasks would be noise — they must be stripped even if the
    # model volunteers them.
    _patch_llm(monkeypatch, {
        "title": "Await Sanjay's revised quote",
        "notes": "Waiting on Sanjay.",
        "disposition": "WAITING", "next_action": "",
        "assignee_name": "Sanjay", "due_at": None, "defer_until": None,
        "context": "@agenda",
        "energy": "high", "time_estimate_mins": 90,
        "subtasks": ["something"],
    })
    out = await _run_capture()
    assert out is not None
    assert out["disposition"] == "WAITING"
    assert out["energy"] == ""
    assert out["time_estimate_mins"] is None
    assert out["subtasks"] == []


async def test_llm_capture_ignores_bad_energy_and_junk_estimate(monkeypatch):
    _patch_llm(monkeypatch, {
        "title": "Draft the reply", "notes": "",
        "disposition": "NEXT", "next_action": "Draft it",
        "context": "@computer",
        "energy": "extreme",            # not a valid level → dropped
        "time_estimate_mins": "later",  # not numeric → None
        "subtasks": ["ok", "  ", 42],   # blanks dropped, non-str coerced
    })
    out = await _run_capture()
    assert out is not None
    assert out["energy"] == ""
    assert out["time_estimate_mins"] is None
    assert out["subtasks"] == ["ok", "42"]

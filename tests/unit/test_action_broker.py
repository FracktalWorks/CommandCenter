"""Action Broker core — authority policy + fail-closed executor (audit BO-1).

The broker is the one component allowed to write back to source systems
(AGENTS.md non-negotiable #4). These lock the authority-tier disposition policy
and the fail-closed executor. No handlers are registered by default, so the
broker cannot perform any real write — it is inert until wired in.
"""
from __future__ import annotations

import asyncio

import pytest

from action_broker import (
    ActionProposal,
    AuthorityTier,
    Disposition,
    clear_action_handlers,
    decide_disposition,
    execute,
    propose,
    register_action_handler,
)


@pytest.fixture(autouse=True)
def _clean_handlers():
    clear_action_handlers()
    yield
    clear_action_handlers()


# ── Authority-tier policy ────────────────────────────────────────────────────

def test_read_authority_rejects_all_writes():
    assert decide_disposition(AuthorityTier.READ, destructive=False) is Disposition.REJECTED
    assert decide_disposition(AuthorityTier.READ, destructive=True) is Disposition.REJECTED


def test_autonomous_auto_applies():
    assert decide_disposition(AuthorityTier.AUTONOMOUS, destructive=True) is Disposition.AUTO_APPLY


def test_suggest_always_needs_approval():
    assert decide_disposition(AuthorityTier.SUGGEST, destructive=False) is Disposition.NEEDS_APPROVAL


def test_suggest_apply_fails_closed_on_destructive():
    # Reversible → auto; destructive/outward → human (fail closed).
    assert decide_disposition(AuthorityTier.SUGGEST_APPLY, destructive=False) is Disposition.AUTO_APPLY
    assert decide_disposition(AuthorityTier.SUGGEST_APPLY, destructive=True) is Disposition.NEEDS_APPROVAL


def test_propose_defaults_to_destructive_and_computes_disposition():
    # Un-annotated action defaults destructive=True → SUGGEST_APPLY needs a human.
    p = propose("agent:sales", "zoho.email", "deal:1", {"body": "hi"})
    assert p.destructive is True
    assert p.disposition is Disposition.NEEDS_APPROVAL
    # An action explicitly marked reversible auto-applies under SUGGEST_APPLY.
    p2 = propose("agent:sales", "clickup.status_read_cache", "task:1", {}, destructive=False)
    assert p2.disposition is Disposition.AUTO_APPLY


# ── Fail-closed executor ─────────────────────────────────────────────────────

def _mk(action: str, disposition: Disposition) -> ActionProposal:
    from uuid import uuid4
    return ActionProposal(
        id=uuid4(), actor="agent:x", action=action, target="t:1",
        payload={}, authority=AuthorityTier.SUGGEST_APPLY, disposition=disposition,
    )


def test_execute_refuses_action_with_no_handler():
    res = asyncio.run(execute(_mk("clickup.comment", Disposition.AUTO_APPLY)))
    assert res["ok"] is False
    assert "no handler" in res["error"]


def test_execute_never_runs_a_rejected_proposal():
    called = []
    register_action_handler("clickup.comment", lambda p: called.append(p))
    res = asyncio.run(execute(_mk("clickup.comment", Disposition.REJECTED)))
    assert res["ok"] is False
    assert not called  # rejected → handler never invoked


def test_execute_runs_registered_handler():
    seen: list[ActionProposal] = []

    async def _handler(p: ActionProposal):
        seen.append(p)
        return "written"

    register_action_handler("clickup.comment", _handler)
    res = asyncio.run(execute(_mk("clickup.comment", Disposition.AUTO_APPLY)))
    assert res["ok"] is True
    assert res["result"] == "written"
    assert len(seen) == 1

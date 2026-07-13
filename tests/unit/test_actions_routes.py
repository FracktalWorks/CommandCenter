"""Action Broker approval inbox routes (audit BO-1 / A2).

Locks that the gateway ``/actions`` handlers delegate to the broker and thread
the reviewer identity through — without a live app/DB/auth (the broker logic
itself is covered by ``test_action_broker.py``). Calls the handler coroutines
directly with the broker functions monkeypatched.
"""
from __future__ import annotations

import asyncio

import gateway.routes.actions as actions


def test_list_pending_delegates_to_broker(monkeypatch):
    import action_broker
    monkeypatch.setattr(
        action_broker, "list_pending",
        lambda: [{"id": "1", "action": "clickup.comment"}],
    )
    res = asyncio.run(actions.list_pending_actions(_user=None))
    assert res["count"] == 1
    assert res["pending"][0]["action"] == "clickup.comment"


def test_approve_delegates_and_passes_reviewer(monkeypatch):
    import action_broker
    seen: dict = {}

    async def _approve(action_id, reviewer):
        seen["id"], seen["reviewer"] = action_id, reviewer
        return {"ok": True, "status": "applied"}

    monkeypatch.setattr(action_broker, "approve", _approve)
    user = type("U", (), {"email": "vijay@x"})()
    res = asyncio.run(actions.approve_action("act-1", user=user))
    assert res["status"] == "applied"
    assert seen == {"id": "act-1", "reviewer": "vijay@x"}


def test_reject_delegates_and_falls_back_to_operator(monkeypatch):
    import action_broker
    seen: dict = {}

    def _reject(action_id, reviewer):
        seen["id"], seen["reviewer"] = action_id, reviewer
        return {"ok": True, "status": "rejected"}

    monkeypatch.setattr(action_broker, "reject", _reject)
    res = asyncio.run(actions.reject_action("act-2", user=None))
    assert res["status"] == "rejected"
    assert seen["id"] == "act-2"
    assert seen["reviewer"] == "operator"  # no identity → best-effort fallback


def test_all_write_routes_require_internal_auth():
    """approve/reject must carry the internal-auth dependency (never anonymous)."""
    from acb_auth import require_internal_auth

    paths = {r.path: r for r in actions.router.routes}
    for p in ("/actions/pending/{action_id}/approve", "/actions/pending/{action_id}/reject",
              "/actions/pending"):
        route = paths[p]
        dep_calls = [d.call for d in route.dependant.dependencies]
        assert require_internal_auth in dep_calls, f"{p} missing require_internal_auth"

"""Unit tests for the /tasks GTD backend (offline — no DB, no HTTP).

Covers the pure logic layers:
  - provider registry: build_provider validation + connector contract
  - ClickUp connector: payload shaping for create_task (mocked HTTP)
  - ai.propose: the clarify heuristic (disposition branches, project
    auto-match, GTD→stage default mapping)
  - items: view map completeness + timestamp parsing
"""
from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pytest
from fastapi import HTTPException
from gateway.routes.tasks import ai as tasks_ai
from gateway.routes.tasks.items import DISPOSITIONS, VIEW_WHERE, _parse_ts
from gateway.routes.tasks.providers import (
    ClickUpProvider,
    build_provider,
    connector_names,
)

# ---------------------------------------------------------------------------
# Provider registry
# ---------------------------------------------------------------------------

def test_connector_registry_has_clickup():
    assert "clickup" in connector_names()


def test_build_provider_unknown_provider_raises_400():
    with pytest.raises(HTTPException) as exc:
        build_provider("asana", {"api_token": "x"})
    assert exc.value.status_code == 400


def test_build_provider_missing_token_raises_400():
    with pytest.raises(HTTPException) as exc:
        build_provider("clickup", {})
    assert exc.value.status_code == 400


def test_build_provider_returns_clickup_connector():
    p = build_provider("clickup", {"api_token": "pk_123"}, "team-9")
    assert isinstance(p, ClickUpProvider)
    assert p.provider == "clickup"


# ---------------------------------------------------------------------------
# ClickUp connector — create_task payload shaping (HTTP mocked)
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_clickup_create_task_payload_and_result():
    provider = ClickUpProvider("pk_123", "team-9")
    fake_resp = SimpleNamespace(
        status_code=200,
        json=lambda: {
            "id": "86abc",
            "url": "https://app.clickup.com/t/86abc",
            "status": {"status": "to do"},
        },
        text="",
    )
    with patch("gateway.routes.tasks.providers.httpx.AsyncClient") as client_cls:
        http = client_cls.return_value.__aenter__.return_value
        http.post = AsyncMock(return_value=fake_resp)
        out = await provider.create_task("list-1", {
            "title": "Call the vendor",
            "description": "about the anodizing samples",
            "status": "To-do",
            "due_at_ms": 1751328000000,
            "assignee_id": "42",
        })
        args, kwargs = http.post.call_args
        assert args[0].endswith("/list/list-1/task")
        body = kwargs["json"]
        assert body["name"] == "Call the vendor"
        assert body["status"] == "To-do"
        assert body["due_date"] == 1751328000000
        assert body["assignees"] == [42]
    assert out["provider_task_id"] == "86abc"
    assert out["provider_status"] == "to do"


# ---------------------------------------------------------------------------
# Clarify heuristic (ai.propose)
# ---------------------------------------------------------------------------

def _item(title: str, **kw) -> SimpleNamespace:
    return SimpleNamespace(
        title=title, description=kw.get("description", ""),
        project_id=kw.get("project_id"),
    )


def _project(pid: str, outcome: str, account_id: str | None = None,
             status: str = "ACTIVE") -> SimpleNamespace:
    return SimpleNamespace(id=pid, outcome=outcome, purpose="",
                           status=status, account_id=account_id)


def test_propose_someday_hint():
    p = tasks_ai.propose(_item("Idea: someday learn KiCad"), [], [], {})
    assert p["disposition"] == "SOMEDAY"
    assert p["confidence"] == "high"
    assert not p["actionable"]


def test_propose_reference_hint():
    p = tasks_ai.propose(_item("Receipt from the Hyderabad flight"), [], [], {})
    assert p["disposition"] == "REFERENCE"


def test_propose_delegate_matches_person_and_defaults_to_synced_account():
    people = [{"name": "Priya Sharma", "email": "p@x.in", "provider_user_id": "7"}]
    p = tasks_ai.propose(
        _item("Ask Priya to reschedule the vendor review"),
        people, [], {"acct-1": ["Backlog", "To-do", "In Process"]})
    assert p["disposition"] == "WAITING"
    assert p["suggested_assignee"]["name"] == "Priya Sharma"
    # delegation is collaborative → lands on the connected workspace
    assert p["account_id"] == "acct-1"
    # actioned/delegated → the To-do stage (P7 mapping)
    assert p["status"] == "To-do"


def test_propose_project_hint_with_outcome():
    p = tasks_ai.propose(_item("Plan the Hyderabad lab fit-out"), [], [], {})
    assert p["disposition"] == "PROJECT"
    assert p["outcome"].startswith("Plan the Hyderabad lab fit-out")


def test_propose_auto_matches_existing_project_and_inherits_account():
    projects = [
        _project("p1", "Overhaul the print-farm reliability program", "acct-9"),
        _project("p2", "Run the Q3 hiring wave", "acct-9"),
    ]
    p = tasks_ai.propose(
        _item("Water-cooling loop leaking on the print farm rig — investigate"),
        [], projects, {"acct-9": ["Backlog", "To-do"]})
    assert p["project_id"] == "p1"
    assert p["project_inferred"] is True
    assert p["account_id"] == "acct-9"
    assert "belongs to" in p["rationale"]


def test_propose_no_match_stays_local():
    p = tasks_ai.propose(_item("Water the office plants"), [], [], {})
    assert p["account_id"] is None
    assert p["project_id"] is None


def test_default_status_gtd_mapping():
    statuses = ["Backlog", "To-do", "In Process", "Review", "Done"]
    assert tasks_ai.default_status("SOMEDAY", statuses) == "Backlog"
    assert tasks_ai.default_status("PROJECT", statuses) == "Backlog"
    assert tasks_ai.default_status("NEXT", statuses) == "To-do"
    assert tasks_ai.default_status("WAITING", statuses) == "To-do"
    assert tasks_ai.default_status("NEXT", []) is None


# ---------------------------------------------------------------------------
# Items — small pure helpers
# ---------------------------------------------------------------------------

def test_view_map_covers_the_gtd_views():
    for view in ("inbox", "next", "waiting", "someday", "reference",
                 "calendar", "done", "all"):
        assert view in VIEW_WHERE


def test_dispositions_are_the_canonical_set():
    assert {"INBOX", "NEXT", "WAITING", "SOMEDAY", "PROJECT",
                            "REFERENCE", "DONE", "TRASH"} == DISPOSITIONS


def test_parse_ts_accepts_iso_and_z_suffix():
    assert _parse_ts("2026-07-08T00:00:00Z") is not None
    assert _parse_ts("") is None
    assert _parse_ts(None) is None
    with pytest.raises(HTTPException):
        _parse_ts("not-a-date")

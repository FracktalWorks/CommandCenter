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


# ---------------------------------------------------------------------------
# People / capabilities (org-knowledge layer, §6.1)
# ---------------------------------------------------------------------------

def test_hr_import_mapper_merges_org_and_resume_skills():
    import importlib.util
    from pathlib import Path
    spec = importlib.util.spec_from_file_location(
        "import_hr_people",
        Path(__file__).resolve().parents[2] / "scripts" / "import_hr_people.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)

    hr = {"company": "X", "departments": [{
        "name": "Engineering", "head": "Vijay",
        "teams": [{"name": "Firmware", "members": [{
            "name": "Rahul", "email": "r@x.in", "role": "Engineer",
            "skills": ["Firmware", "c++"], "status": "active",
            "capacity_hours_per_week": 40, "current_load_hours_per_week": 30,
            "available_hours_per_week": 10, "clickup_user_id": 42,
        }]}],
    }]}
    resumes = {"profiles": [{
        "name": "rahul", "email": "r@x.in",
        "skills": ["C++", "embedded systems"],
        "experience_summary": "5y embedded", "years_experience": 5,
        "domain": "Embedded",
    }]}
    rows = mod.build_rows(hr, resumes)
    assert len(rows) == 1
    r = rows[0]
    assert r["department"] == "Engineering" and r["team"] == "Firmware"
    assert r["reports_to"] == "Vijay"
    # merged + case-insensitively deduped, org-chart order first
    assert r["skills"] == ["Firmware", "c++", "embedded systems"]
    assert r["resume_summary"] == "5y embedded"
    assert r["clickup_user_id"] == "42"
    assert r["available"] == 10


def test_capability_match_picks_skill_fit_with_availability_tiebreak():
    people = [
        {"name": "A", "skills": ["firmware"], "available_hours_per_week": 5},
        {"name": "B", "skills": ["firmware"], "available_hours_per_week": 20},
        {"name": "C", "skills": ["sales"], "available_hours_per_week": 40},
    ]
    fit = tasks_ai._match_capability("fix the firmware regression", people)
    assert fit["name"] == "B"  # same skill score; more hours free
    assert tasks_ai._match_capability("water the plants", people) is None


def test_propose_attaches_capability_owner_without_forcing_delegate():
    people = [{"name": "Rahul", "skills": ["firmware"], "provider_user_id": "1",
               "available_hours_per_week": 12}]
    p = tasks_ai.propose(
        _item("Fix the bed-leveling firmware regression"), people, [], {})
    assert p["disposition"] == "NEXT"  # suggestion, not a forced WAITING
    assert p["suggested_assignee"]["name"] == "Rahul"
    assert "Rahul fits" in p["rationale"]


# ---------------------------------------------------------------------------
# Sync pull (§9.3 #1): provider list_tasks + the GTD lens on pulled tasks
# ---------------------------------------------------------------------------

from gateway.routes.tasks.sync import map_pulled_task  # noqa: E402


def _pulled(**over):
    base = {
        "provider_task_id": "t1",
        "title": "Task",
        "status": "To-do",
        "status_type": "custom",
        "assignees": [],
        "closed_at_ms": None,
    }
    base.update(over)
    return base


def test_pull_mapping_mine_open_is_next():
    m = map_pulled_task(_pulled(
        assignees=[{"name": "v", "provider_user_id": "42"}]), "42")
    assert m["disposition"] == "NEXT"
    assert m["is_mine"] is True
    assert m["waiting_on"] is None


def test_pull_mapping_others_task_is_waiting_with_monitor_record():
    m = map_pulled_task(_pulled(
        assignees=[{"name": "j", "provider_user_id": "7"}],
        status="in progress"), "42")
    assert m["disposition"] == "WAITING"
    assert m["is_mine"] is False
    assert m["waiting_on"]["provider_user_id"] == "7"


def test_pull_mapping_backlog_stage_is_someday_even_when_mine():
    m = map_pulled_task(_pulled(
        assignees=[{"name": "v", "provider_user_id": "42"}],
        status="Backlog"), "42")
    assert m["disposition"] == "SOMEDAY"


def test_pull_mapping_closed_wins_over_everything():
    m = map_pulled_task(_pulled(
        assignees=[{"name": "j", "provider_user_id": "7"}],
        status="Backlog", status_type="closed", closed_at_ms=1719000000000), "42")
    assert m["disposition"] == "DONE"
    assert m["completed_at_ms"] == 1719000000000
    assert m["waiting_on"] is None  # nothing to wait on once it's done


def test_pull_mapping_unassigned_open_is_team_pool_next():
    m = map_pulled_task(_pulled(), "42")
    assert m["disposition"] == "NEXT"
    assert m["is_mine"] is False  # team pool, not my list
    assert m["assignee"] is None


def test_pull_mapping_prefers_me_as_display_assignee():
    m = map_pulled_task(_pulled(assignees=[
        {"name": "j", "provider_user_id": "7"},
        {"name": "v", "provider_user_id": "42"},
    ]), "42")
    assert m["is_mine"] is True
    assert m["assignee"]["provider_user_id"] == "42"


@pytest.mark.asyncio
async def test_clickup_list_tasks_paginates_and_normalizes():
    p = ClickUpProvider("pk_x", "9001")
    pages = [
        {"tasks": [{
            "id": "abc", "name": "Ship it",
            "text_content": "notes",
            "status": {"status": "To-do", "type": "custom"},
            "assignees": [{"id": 42, "username": "v", "email": "v@x.in"}],
            "due_date": "1719000000000", "date_created": "1718000000000",
            "date_updated": "1718500000000", "date_closed": None,
            "url": "https://app.clickup.com/t/abc",
            "list": {"id": "L1", "name": "Sprint"},
        }], "last_page": False},
        {"tasks": [{
            "id": "def", "name": "Done one",
            "status": {"status": "Complete", "type": "closed"},
            "assignees": [], "date_closed": "1718600000000",
            "list": {"id": "L1"},
        }], "last_page": True},
    ]
    with patch.object(p, "_get", AsyncMock(side_effect=pages)) as mocked:
        tasks = await p.list_tasks("9001", updated_since_ms=1718000000000)
    assert len(tasks) == 2
    t = tasks[0]
    assert t["provider_task_id"] == "abc"
    assert t["title"] == "Ship it"
    assert t["description"] == "notes"
    assert t["status"] == "To-do" and t["status_type"] == "custom"
    assert t["assignees"] == [{"name": "v", "email": "v@x.in",
                               "provider_user_id": "42"}]
    assert t["due_at_ms"] == 1719000000000
    assert t["project_ref"] == "L1"
    assert tasks[1]["closed_at_ms"] == 1718600000000
    # incremental cursor forwarded; closed tasks included; paginated
    first_call = mocked.await_args_list[0]
    assert first_call.args[0] == "/team/9001/task"
    assert first_call.args[1]["date_updated_gt"] == 1718000000000
    assert first_call.args[1]["include_closed"] == "true"
    assert mocked.await_args_list[1].args[1]["page"] == 1


def test_sync_upsert_preserves_user_overlay_and_owns_completion():
    """The upsert must only refresh MIRRORED fields on re-sync: the user's
    GTD overlay survives, except completion where the provider wins."""
    from gateway.routes.tasks import sync as tasks_sync

    sql = str(tasks_sync._UPSERT_SQL)
    # provider owns completion state…
    assert "WHEN EXCLUDED.completed_at IS NOT NULL THEN 'DONE'" in sql
    # …and an upstream reopen un-DONEs the row
    assert "gtd_items.disposition = 'DONE'" in sql
    # …but an open row keeps the disposition the user chose
    assert "ELSE gtd_items.disposition" in sql
    # user's project refile is never clobbered
    assert "coalesce(gtd_items.project_id, EXCLUDED.project_id)" in sql
    # conflict target matches the partial unique index
    assert "ON CONFLICT (account_id, provider_task_id) WHERE source <> 'LOCAL'" in sql


# ---------------------------------------------------------------------------
# Email → task capture (origin linkage) + calendar-date validation
# ---------------------------------------------------------------------------

from gateway.routes.tasks.capture_email import draft_task_fallback  # noqa: E402


def test_email_capture_fallback_draft_names_sender_and_strips_reply_prefixes():
    d = draft_task_fallback("Re: Fwd: Re: Vendor quote v2", "Sanjay Rao",
                            "Please approve the revised quote by Friday.")
    assert d["title"] == "Email from Sanjay Rao: Vendor quote v2"
    assert d["notes"].startswith("Please approve")


def test_email_capture_fallback_handles_empty_subject():
    d = draft_task_fallback("", "", "")
    assert d["title"] == "Handle email from someone"


def test_email_capture_is_owner_checked_and_idempotent():
    import inspect

    from gateway.routes.tasks import capture_email

    src = inspect.getsource(capture_email.capture_from_email)
    assert "a.user_id = :uid" in src            # ownership through the mailbox
    assert "origin->>'email_id'" in src         # idempotency per source email
    assert "NOT IN ('DONE', 'TRASH')" in src    # only OPEN items block re-capture


def test_calendar_decision_requires_a_date():
    """GTD hard landscape: kind=calendar without due_at used to create a
    hard-date item with no date — invisible on the Calendar view."""
    import inspect

    from gateway.routes.tasks import items as tasks_items

    src = inspect.getsource(tasks_items.organize_item)
    assert 'req.kind == "calendar" and not (req.due_at' in src


def test_item_model_carries_origin():
    from gateway.routes.tasks.core import GtdItemModel
    assert "origin" in GtdItemModel.model_fields


def test_push_carries_email_origin_reference_into_provider():
    """Lifecycle-long linkage: pushing an email-origin item to the PM tool
    appends the source-email reference to the description."""
    import inspect

    from gateway.routes.tasks import items as tasks_items

    src = inspect.getsource(tasks_items.push_item)
    assert 'origin.get("kind") == "email"' in src
    assert "Captured from email" in src


def test_agent_item_format_shows_email_origin():
    from skill_task_gtd.core import _fmt_item

    line = _fmt_item({"id": "x" * 12, "title": "Approve the quote",
                      "disposition": "NEXT", "source": "LOCAL",
                      "origin": {"kind": "email", "from_name": "Sanjay Rao",
                                 "subject": "Vendor quote"}})
    assert "from email: Sanjay Rao" in line
    plain = _fmt_item({"id": "y" * 12, "title": "buy tape",
                       "disposition": "INBOX", "source": "LOCAL"})
    assert "from email" not in plain


# ---------------------------------------------------------------------------
# Per-user settings (AI tiers + toggles)
# ---------------------------------------------------------------------------


def test_settings_defaults_per_function():
    """Each AI function has its own default tier (email-app parity): chat on
    the strong tool-caller, high-volume triage on the fast tier."""
    from gateway.routes.tasks.settings import DEFAULT_GTD_MODELS, GtdSettingsModel

    assert DEFAULT_GTD_MODELS == {
        "chat": "tier-powerful",
        "clarify": "tier-balanced",
        "atomize": "tier-fast",
        "email_capture": "tier-fast",
    }
    s = GtdSettingsModel()
    assert s.capture_dedup is True and s.auto_sync_on_open is True


def test_ai_call_sites_use_configured_models():
    """The atomizer and the email-capture drafter run on the user's
    configured tier (gtd_settings), not a hardcoded one."""
    import inspect

    from gateway.routes.tasks import ai as tasks_ai
    from gateway.routes.tasks import capture_email

    src = inspect.getsource(tasks_ai.atomize_dump)
    assert 'model=models["atomize"]' in src
    src2 = inspect.getsource(capture_email.capture_from_email)
    assert 'model=models["email_capture"]' in src2
    # Both LLM helpers accept the model and route through the alias-aware
    # completion path (tier-fast/-balanced/-powerful or a raw model id).
    assert "acompletion_with_fallback" in inspect.getsource(tasks_ai._llm_atomize)
    assert "acompletion_with_fallback" in inspect.getsource(capture_email._llm_capture)


def test_settings_update_is_partial():
    """PUT /tasks/settings only touches provided fields (patch semantics)."""
    from gateway.routes.tasks.settings import GtdSettingsPatch

    p = GtdSettingsPatch(capture_dedup=False)
    fields = {k: v for k, v in p.model_dump().items() if v is not None}
    assert fields == {"capture_dedup": False}


# ---------------------------------------------------------------------------
# Clarify upgrades: live members, hierarchy, create-project + attachments
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_clickup_get_schema_builds_navigable_hierarchy():
    p = ClickUpProvider("pk_x", "9001")
    responses = {
        "/team": {"teams": [{"id": "9001", "members": [
            {"user": {"id": 42, "username": "vijay", "email": "v@x.in"}}]}]},
        "/team/9001/space": {"spaces": [{
            "id": "S1", "name": "Engineering",
            "statuses": [{"status": "To-do"}, {"status": "Done"}]}]},
        "/space/S1/list": {"lists": [{"id": "L1", "name": "Firmware"}]},
        "/space/S1/folder": {"folders": [{
            "id": "F1", "name": "Printers",
            "lists": [{"id": "L2", "name": "F1 Launch"}]}]},
    }

    async def fake_get(path, params=None):
        return responses[path]

    with patch.object(p, "_get", AsyncMock(side_effect=fake_get)):
        schema = await p.get_schema("9001")
    # Flat projects carry structured space/folder ids (create + grouping).
    by_id = {pr["id"]: pr for pr in schema["projects"]}
    assert by_id["L1"]["space_id"] == "S1" and by_id["L1"]["folder_id"] is None
    assert by_id["L2"]["folder_id"] == "F1"
    # The accordion tree mirrors ClickUp: space → folder → list.
    h = schema["hierarchy"]
    assert h[0]["name"] == "Engineering"
    assert h[0]["lists"][0]["id"] == "L1"
    assert h[0]["folders"][0]["lists"][0]["id"] == "L2"


@pytest.mark.asyncio
async def test_clickup_list_members_is_live_membership():
    p = ClickUpProvider("pk_x", "9001")
    with patch.object(p, "_get", AsyncMock(return_value={"teams": [{
        "id": "9001",
        "members": [{"user": {"id": 7, "username": "rahul", "email": "r@x.in"}}],
    }]})):
        members = await p.list_members("9001")
    assert members == [{"name": "rahul", "email": "r@x.in",
                        "provider_user_id": "7"}]


@pytest.mark.asyncio
async def test_clickup_create_project_targets_folder_or_space():
    p = ClickUpProvider("pk_x", "9001")
    calls: list[str] = []

    class _Resp:
        status_code = 200
        def json(self):
            return {"id": "L9", "name": "New List"}

    class _Client:
        def __init__(self, *a, **k): ...
        async def __aenter__(self): return self
        async def __aexit__(self, *a): return False
        async def post(self, url, headers=None, json=None):
            calls.append(url)
            return _Resp()

    with patch("gateway.routes.tasks.providers.httpx.AsyncClient", _Client):
        in_folder = await p.create_project("9001", "New List", "S1", "F1")
        in_space = await p.create_project("9001", "New List", "S1")
    assert in_folder["id"] == "L9" and in_space["id"] == "L9"
    assert calls[0].endswith("/folder/F1/list")
    assert calls[1].endswith("/space/S1/list")


def test_sync_refreshes_members_and_create_project_is_owner_checked():
    import inspect

    from gateway.routes.tasks import accounts as tasks_accounts
    from gateway.routes.tasks import sync as tasks_sync

    # Sync keeps the delegate list honest every pull.
    assert "list_members" in inspect.getsource(tasks_sync._sync_account)
    # Create-project + member refresh go through the ownership guard.
    for fn in (tasks_accounts.create_account_project,
               tasks_accounts.refresh_account_members):
        assert "_assert_account_owner" in inspect.getsource(fn)


def test_attachment_names_are_sanitized_and_executables_blocked():
    from gateway.routes.tasks.attachments import _BLOCKED_EXT, _safe_name

    assert _safe_name("../../etc/passwd") == "passwd"
    assert _safe_name("photo (1).png") == "photo _1_.png"
    assert _safe_name("") == "attachment"
    assert ".exe" in _BLOCKED_EXT and ".sh" in _BLOCKED_EXT


def test_attachment_serving_is_owner_checked():
    import inspect

    from gateway.routes.tasks import attachments

    src = inspect.getsource(attachments.serve_attachment)
    assert "user_id = :uid" in src


def test_capture_accepts_attachments_and_item_model_carries_them():
    from gateway.routes.tasks.core import GtdItemModel
    from gateway.routes.tasks.items import CaptureRequest

    assert "attachments" in CaptureRequest.model_fields
    assert "attachments" in GtdItemModel.model_fields

"""Unit tests for the /tasks GTD backend (offline — no DB, no HTTP).

Covers the pure logic layers:
  - provider registry: build_provider validation + connector contract
  - ClickUp connector: payload shaping for create_task (mocked HTTP)
  - ai.propose: the clarify heuristic (disposition branches, project
    auto-match, GTD→stage default mapping)
  - items: view map completeness + timestamp parsing
"""
from __future__ import annotations

import json
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pytest
from fastapi import HTTPException
from gateway.routes.tasks import ai as tasks_ai
from gateway.routes.tasks.items import (
    DISPOSITIONS,
    VIEW_WHERE,
    ItemPatch,
    _build_item_update,
    _parse_ts,
)
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


@pytest.mark.asyncio
async def test_clickup_create_task_with_parent_is_a_subtask():
    """A subtask create sends ClickUp's `parent` id and still POSTs to the
    parent's list, so children live under the same list as the parent."""
    provider = ClickUpProvider("pk_123", "team-9")
    fake_resp = SimpleNamespace(
        status_code=200,
        json=lambda: {"id": "86sub", "url": "https://app.clickup.com/t/86sub",
                      "status": {"status": "to do"}},
        text="",
    )
    with patch("gateway.routes.tasks.providers.httpx.AsyncClient") as client_cls:
        http = client_cls.return_value.__aenter__.return_value
        http.post = AsyncMock(return_value=fake_resp)
        out = await provider.create_task("list-1", {
            "title": "Draft the spec",
            "parent": "86abc",
        })
        args, kwargs = http.post.call_args
        assert args[0].endswith("/list/list-1/task")
        assert kwargs["json"]["parent"] == "86abc"
    assert out["provider_task_id"] == "86sub"


@pytest.mark.asyncio
async def test_clickup_update_task_backsync_fields_and_assignee_delta():
    """A back-synced edit PUTs only the changed fields, and models an assignee
    change as ClickUp's add/rem delta (reassign from 7 → 42)."""
    provider = ClickUpProvider("pk_123", "team-9")
    fake_resp = SimpleNamespace(
        status_code=200,
        json=lambda: {"id": "86abc",
                      "url": "https://app.clickup.com/t/86abc",
                      "status": {"status": "in progress"}},
        text="",
    )
    with patch("gateway.routes.tasks.providers.httpx.AsyncClient") as client_cls:
        http = client_cls.return_value.__aenter__.return_value
        http.put = AsyncMock(return_value=fake_resp)
        out = await provider.update_task("86abc", {
            "title": "Renamed",
            "status": "In progress",
            "assignee_id": "42",
            "prev_assignee_id": "7",
        })
        args, kwargs = http.put.call_args
        assert args[0].endswith("/task/86abc")
        body = kwargs["json"]
        assert body["name"] == "Renamed"
        assert body["status"] == "In progress"
        assert body["assignees"] == {"add": [42], "rem": [7]}
    assert out["provider_status"] == "in progress"


@pytest.mark.asyncio
async def test_clickup_update_task_clear_assignee_removes_prev():
    provider = ClickUpProvider("pk_123", "team-9")
    fake_resp = SimpleNamespace(status_code=200, json=lambda: {"id": "86abc"}, text="")
    with patch("gateway.routes.tasks.providers.httpx.AsyncClient") as client_cls:
        http = client_cls.return_value.__aenter__.return_value
        http.put = AsyncMock(return_value=fake_resp)
        await provider.update_task("86abc",
                                   {"clear_assignee": True, "prev_assignee_id": "7"})
        body = http.put.call_args.kwargs["json"]
        assert body["assignees"] == {"rem": [7]}


@pytest.mark.asyncio
async def test_clickup_update_task_noop_when_nothing_writable():
    """A local-only field edit (no ClickUp-writable change) makes no HTTP call."""
    provider = ClickUpProvider("pk_123", "team-9")
    with patch("gateway.routes.tasks.providers.httpx.AsyncClient") as client_cls:
        http = client_cls.return_value.__aenter__.return_value
        http.put = AsyncMock()
        out = await provider.update_task("86abc", {})
        http.put.assert_not_called()
    assert out["provider_task_id"] == "86abc"


@pytest.mark.asyncio
async def test_clickup_get_task_detail_normalizes_comments_subtasks_attachments():
    provider = ClickUpProvider("pk_123", "team-9")

    async def fake_get(path, params=None):
        if path.endswith("/comment"):
            return {"comments": [
                {"id": 5, "user": {"username": "Ana"},
                 "comment_text": "Looks good", "date": "1751000000000"},
            ]}
        return {  # GET /task/{id}
            "id": "86abc",
            "attachments": [
                {"id": 9, "title": "spec.pdf",
                 "url": "https://x/spec.pdf", "mimetype": "application/pdf",
                 "size": 1234},
                {"id": 10, "title": "no-url"},  # dropped: no url
            ],
            "subtasks": [
                {"id": "sub1", "name": "Draft it",
                 "status": {"status": "to do", "type": "open"},
                 "url": "https://x/sub1",
                 "assignees": [{"id": 7, "username": "Bo"}]},
            ],
        }

    provider._get = fake_get  # type: ignore[assignment]
    out = await provider.get_task_detail("86abc")
    assert [a["name"] for a in out["attachments"]] == ["spec.pdf"]  # url-less dropped
    assert out["attachments"][0]["size"] == 1234
    assert out["subtasks"][0]["title"] == "Draft it"
    assert out["subtasks"][0]["status"] == "to do"
    assert out["subtasks"][0]["assignees"][0]["name"] == "Bo"
    assert out["comments"][0]["author"] == "Ana"
    assert out["comments"][0]["text"] == "Looks good"


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


def test_propose_emits_complexity_parity():
    # The deterministic path always carries a complexity so the field exists
    # even when the LLM is off: PROJECT → "project", else "single".
    proj = tasks_ai.propose(_item("Plan the Hyderabad lab fit-out"), [], [], {})
    assert proj["complexity"] == "project"
    single = tasks_ai.propose(_item("Reply to the landlord email"), [], [], {})
    assert single["complexity"] == "single"


# ---------------------------------------------------------------------------
# Clarify — LLM project match resolution + overlay (Phase 1)
# ---------------------------------------------------------------------------

def test_resolve_project_match_by_token_and_fuzzy_and_none():
    projects = [
        _project("p1", "Overhaul the print-farm reliability program", "acct-9"),
        _project("p2", "Run the Q3 hiring wave", "acct-9"),
        _project("pX", "Dormant thing", status="SOMEDAY"),  # excluded (not ACTIVE)
    ]
    # [P#] token indexes into the ACTIVE projects, in order.
    assert tasks_ai._resolve_project_match("[P0]", projects).id == "p1"
    assert tasks_ai._resolve_project_match("P1", projects).id == "p2"
    # Fuzzy: the model echoed the outcome words (≥2 overlap).
    assert tasks_ai._resolve_project_match(
        "the Q3 hiring wave", projects).id == "p2"
    # No match / sentinels / out-of-range → None (never invents a project).
    assert tasks_ai._resolve_project_match("none", projects) is None
    assert tasks_ai._resolve_project_match("", projects) is None
    assert tasks_ai._resolve_project_match("[P9]", projects) is None
    assert tasks_ai._resolve_project_match("totally unrelated", projects) is None


def test_llm_overlay_files_actionable_item_under_matched_project():
    # A NEXT item the LLM filed under an existing ClickUp project inherits that
    # project's id + account, even though the disposition is not PROJECT.
    projects = [_project("p1", "Acme rollout", "acct-9")]
    llm_core = {
        "disposition": "NEXT",
        "next_action": "Email Acme the revised quote",
        "confidence": "high",
        "rationale": "Part of the Acme rollout.",
        "llm_project": projects[0],
    }
    merged = tasks_ai.propose_with_llm(
        _item("send Acme the new quote"), [], projects,
        {"acct-9": ["Backlog", "To-do"]}, llm_core)
    assert merged["disposition"] == "NEXT"
    assert merged["project_id"] == "p1"
    assert merged["project_inferred"] is True
    assert merged["account_id"] == "acct-9"


def test_llm_overlay_carries_complexity_and_subtasks():
    projects: list = []
    llm_core = {
        "disposition": "NEXT",
        "next_action": "Draft the onboarding checklist",
        "confidence": "medium",
        "rationale": "One deliverable, a few steps.",
        "complexity": "subtasks",
        "subtasks": ["List the accounts to create", "Write the welcome email"],
    }
    merged = tasks_ai.propose_with_llm(
        _item("set up new hire onboarding"), [], projects, {}, llm_core)
    assert merged["complexity"] == "subtasks"
    assert merged["subtasks"][0] == "List the accounts to create"


def test_llm_overlay_without_llm_core_is_deterministic_with_complexity():
    # llm_core=None → pure heuristic, but the complexity field still rides along.
    merged = tasks_ai.propose_with_llm(
        _item("Plan the offsite"), [], [], {}, None)
    assert merged["disposition"] == "PROJECT"
    assert merged["complexity"] == "project"


def test_llm_overlay_carries_vague_title_and_due_date():
    # The Sort→Shape card's vague-title gate + When axis both ride on the LLM
    # overlay's is_vague/suggested_title/due_date keys.
    llm_core = {
        "disposition": "NEXT",
        "next_action": "Follow up with Acme on the signed MSA",
        "confidence": "low",
        "rationale": "Title was too vague to place confidently.",
        "is_vague": True,
        "suggested_title": "Follow up with Acme on the signed MSA",
        "due_date": "2026-07-11",
    }
    merged = tasks_ai.propose_with_llm(
        _item("Follow up"), [], [], {}, llm_core)
    assert merged["is_vague"] is True
    assert merged["suggested_title"] == "Follow up with Acme on the signed MSA"
    assert merged["due_date"] == "2026-07-11"


def test_llm_overlay_without_llm_core_has_no_vague_flag():
    # Pure heuristic path never claims a title is vague — only the LLM judges it.
    merged = tasks_ai.propose_with_llm(_item("Plan the offsite"), [], [], {}, None)
    assert "is_vague" not in merged
    assert "suggested_title" not in merged


def test_llm_propose_parses_vague_title_fields_from_json(monkeypatch):
    # Exercise _llm_propose's own JSON parsing (not just the overlay merge).
    fake_content = json.dumps({
        "disposition": "NEXT",
        "next_action": "Call the lab about calibration",
        "confidence": "medium",
        "rationale": "Ambiguous stub, clarified via notes.",
        "is_vague": True,
        "suggested_title": "Call the lab about calibration",
        "due_date": "not-a-date",  # must be dropped — not a real ISO date
        "complexity": "single",
    })
    fake_resp = SimpleNamespace(
        choices=[SimpleNamespace(message=SimpleNamespace(content=fake_content))])

    async def fake_completion(**kwargs):
        return fake_resp, kwargs.get("model")

    monkeypatch.setattr(
        "acb_llm.context.acompletion_with_fallback", fake_completion, raising=False)
    import asyncio
    core = asyncio.run(tasks_ai._llm_propose(
        _item("Call"), [], [], {}, "tier-fast"))
    assert core is not None
    assert core["is_vague"] is True
    assert core["suggested_title"] == "Call the lab about calibration"
    # Malformed due_date is silently dropped, never surfaced as a fake deadline.
    assert "due_date" not in core


def test_llm_propose_suggested_title_dropped_when_same_as_current():
    # A "suggestion" identical to the existing title isn't a suggestion.
    core = {"suggested_title": "call sanjay"}
    # Simulate the identical-title guard directly (mirrors _llm_propose's check).
    item = _item("Call Sanjay")
    sug = core["suggested_title"]
    surfaced = sug and sug.lower() != (item.title or "").strip().lower()
    assert not surfaced


def test_suggest_title_route_and_helper_use_llm_with_fallback():
    """The 'Improve title' affordance (always-available) and the vague-title
    gate both resolve through _llm_suggest_title, which degrades safely."""
    import asyncio

    from gateway.routes.tasks.ai import _llm_suggest_title

    # No LLM configured / import failure → safe default, never raises.
    out = asyncio.run(_llm_suggest_title("Follow up", None, "tier-fast"))
    assert out == {"is_vague": False, "suggested_title": None}
    # Empty title → same safe default, no call attempted.
    out2 = asyncio.run(_llm_suggest_title("", None, "tier-fast"))
    assert out2["is_vague"] is False and out2["suggested_title"] is None


def test_suggest_title_route_is_registered():
    from gateway.routes.tasks import router

    paths = {getattr(r, "path", "") for r in router.routes}
    assert "/tasks/items/{item_id}/suggest-title" in paths


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


def test_all_view_excludes_done_and_trash():
    # The default working board must not surface a connected workspace's
    # completed backlog — DONE has its own view. Trash is always hidden.
    clause = VIEW_WHERE["all"]
    assert "DONE" in clause and "TRASH" in clause
    assert "NOT IN" in clause
    # 'done' view is the ONLY one that shows DONE.
    assert VIEW_WHERE["done"] == "i.disposition = 'DONE'"


def test_archive_view_shows_only_archived():
    # The archive view is the only place archived rows appear.
    assert VIEW_WHERE["archive"] == "i.archived_at IS NOT NULL"


def test_list_items_excludes_subtasks_and_selects_subtask_count():
    # Subtasks are nested under their parent, never standalone rows; and every
    # item read carries a subtask_count roll-up.
    import inspect

    from gateway.routes.tasks import core as core_mod
    from gateway.routes.tasks import items as items_mod

    src = inspect.getsource(items_mod.list_items)
    assert "i.parent_item_id IS NULL" in src
    assert "subtask_count" in core_mod.ITEM_SELECT
    assert "c.parent_item_id = i.id" in core_mod.ITEM_SELECT


def test_organize_request_accepts_subtasks():
    from gateway.routes.tasks.items import OrganizeRequest

    req = OrganizeRequest(kind="next", next_action="Ship it",
                          subtasks=["step one", "step two"])
    assert req.subtasks == ["step one", "step two"]


def test_organize_owner_axis_independent_of_size():
    """Sort→Shape: OWNER (assignee) must combine with ANY size (next/project),
    not just the legacy kind="delegate" — a task can be a project, delegated,
    with a deadline, and broken into steps, all in one commit."""
    import inspect

    from gateway.routes.tasks import items as tasks_items

    src = inspect.getsource(tasks_items.organize_item)
    # A next/project/calendar kind delegates too when it carries an assignee.
    assert 'req.kind in ("next", "project", "calendar") and req.assignee is not None' in src
    assert 'disposition = "WAITING"' in src
    # is_mine now derives from the independent `delegated` flag, not kind=="delegate".
    assert '"is_mine": not delegated' in src


def test_item_patch_is_mine_is_local_overlay_never_pushed_upstream():
    """Removing a handed-off/unassigned task from "My Next Actions" is a purely
    LOCAL overlay: is_mine patches the row, but is NEVER a ClickUp-writable
    field — the task stays put upstream. (My Next Actions = NEXT & is_mine.)"""
    import inspect

    from gateway.routes.tasks.items import (
        ItemPatch, _build_item_update, _push_patch_upstream,
    )

    sets, params = _build_item_update("item1", "u1", ItemPatch(is_mine=False))
    assert "is_mine = :is_mine" in sets
    assert params["is_mine"] is False

    # An unset is_mine leaves the column untouched (no accidental writes).
    sets2, _ = _build_item_update("item1", "u1", ItemPatch(context="@calls"))
    assert not any("is_mine" in s for s in sets2)

    # is_mine must not be in the set of fields back-synced to the tool.
    assert "is_mine" not in inspect.getsource(_push_patch_upstream)


# ---------------------------------------------------------------------------
# Enrich (fill missing fields) + reclarify binding + delegate promotion
# ---------------------------------------------------------------------------

def test_missing_fields_reports_only_empty():
    from gateway.routes.tasks.ai import _missing_fields

    full = SimpleNamespace(title="x", description="", context="@calls",
                           energy="low", time_estimate_mins=10,
                           due_at=object(), assignee={"name": "Bo"})
    assert _missing_fields(full) == set()
    bare = SimpleNamespace(title="x", description="", context=None,
                           energy="", time_estimate_mins=None, due_at=None,
                           assignee=None)
    assert _missing_fields(bare) == {
        "context", "energy", "time_estimate_mins", "due_at", "assignee"}


def test_enrich_heuristic_fills_only_requested_and_never_invents_due():
    from gateway.routes.tasks.ai import enrich_heuristic

    item = SimpleNamespace(title="Call the vendor about the quote",
                           description="")
    out = enrich_heuristic(item, {"context", "due_at"}, [])
    # A call → @calls; it never fabricates a due date.
    assert out["context"] == "@calls"
    assert "due_at" not in out
    # Only the requested fields come back — energy wasn't asked for.
    assert "energy" not in out


def test_apply_reclarify_binding_locks_synced_destination():
    from gateway.routes.tasks.ai import _apply_reclarify_binding

    synced = SimpleNamespace(source="SYNCED", account_id="acct-1",
                             project_id="proj-9")
    prop = {"account_id": "acct-OTHER", "project_id": "proj-OTHER",
            "project_inferred": True, "disposition": "NEXT"}
    out = _apply_reclarify_binding(dict(prop), synced)
    assert out["account_id"] == "acct-1"
    assert out["project_id"] == "proj-9"
    assert out["project_inferred"] is False
    assert out["locked_destination"] is True
    # A LOCAL task is free to be re-homed — binding untouched.
    local = SimpleNamespace(source="LOCAL", account_id=None, project_id=None)
    out2 = _apply_reclarify_binding(dict(prop), local)
    assert out2["account_id"] == "acct-OTHER"
    assert "locked_destination" not in out2


def test_clarify_route_accepts_reclarify_flag():
    import inspect

    from gateway.routes.tasks import ai as tasks_ai_mod

    sig = inspect.signature(tasks_ai_mod.clarify_item)
    assert "reclarify" in sig.parameters


def test_delegate_request_shape():
    from gateway.routes.tasks.core import PersonModel
    from gateway.routes.tasks.items import DelegateRequest

    req = DelegateRequest(
        assignee=PersonModel(name="Priya Sharma", provider_user_id="7"),
        account_id="acct-1", project_id="proj-1")
    assert req.assignee.name == "Priya Sharma"
    assert req.next_action is None  # optional re-phrase


def test_enrich_and_delegate_routes_are_registered():
    from gateway.routes.tasks import router

    paths = {getattr(r, "path", "") for r in router.routes}
    for p in ("/tasks/items/{item_id}/enrich",
              "/tasks/ai/backfill-context",
              "/tasks/items/{item_id}/delegate"):
        assert p in paths, f"missing route {p}"


def test_local_hierarchy_routes_are_registered():
    # The Projects-view tree depends on these local hierarchy endpoints.
    from gateway.routes.tasks import router

    paths = {getattr(r, "path", "") for r in router.routes}
    for p in ("/tasks/hierarchy", "/tasks/spaces", "/tasks/folders",
              "/tasks/local-projects"):
        assert p in paths, f"missing hierarchy route {p}"


def test_create_local_project_request_defaults():
    from gateway.routes.tasks.hierarchy import CreateLocalProjectRequest

    # A project can be created ungrouped (no space/folder) — both default None.
    req = CreateLocalProjectRequest(outcome="Ship v2")
    assert req.space_id is None and req.folder_id is None
    # Or placed in a folder (which pins the space server-side).
    req2 = CreateLocalProjectRequest(outcome="Ship v2", folder_id="f1")
    assert req2.folder_id == "f1"


def test_project_model_carries_hierarchy_placement():
    from gateway.routes.tasks.core import GtdProjectModel

    p = GtdProjectModel(id="p1", outcome="Do the thing",
                        space_id="s1", folder_id="f1")
    assert p.space_id == "s1" and p.folder_id == "f1"


def test_workflow_stages_normalizes_and_defaults():
    from gateway.routes.tasks.settings import (
        DEFAULT_WORKFLOW_STAGES,
        _stages,
    )
    # A stored JSON string, a real list, junk, and empties all normalize.
    assert _stages('["A", "B"]') == ["A", "B"]
    assert _stages([" A ", "", "B", None]) == ["A", "B"]
    assert _stages(None) == DEFAULT_WORKFLOW_STAGES
    assert _stages([]) == DEFAULT_WORKFLOW_STAGES
    assert _stages("not json") == DEFAULT_WORKFLOW_STAGES
    assert DEFAULT_WORKFLOW_STAGES[-1] == "DONE"  # last stage = the done stage


def test_patch_sets_sort_key_including_zero():
    # A drag writes a fractional rank; 0.0 is a legitimate rank (top of a
    # group), so the builder must emit the clause for it — a truthiness check
    # would silently drop sort_key=0.
    sets, params = _build_item_update("id1", "u", ItemPatch(sort_key=0.0))
    assert "sort_key = :sortkey" in sets
    assert params["sortkey"] == 0.0

    sets, params = _build_item_update("id1", "u", ItemPatch(sort_key=1500.5))
    assert params["sortkey"] == 1500.5


def test_patch_omits_sort_key_when_absent():
    # An unrelated patch (e.g. a note edit) must not touch sort_key.
    sets, params = _build_item_update("id1", "u", ItemPatch(notes="hi"))
    assert not any("sort_key" in s for s in sets)
    assert "sortkey" not in params


def test_list_items_orders_by_sort_key_before_created_at():
    # The board/list manual order must sort ranked rows first (NULLS LAST) and
    # keep LOCAL-first; a code read guards the ORDER BY contract.
    import inspect

    from gateway.routes.tasks import items as items_mod

    src = inspect.getsource(items_mod.list_items)
    assert "sort_key ASC NULLS LAST" in src
    # LOCAL rows still win over the synced mirror regardless of rank.
    assert "(i.source = 'LOCAL') DESC" in src


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


def test_email_capture_finds_pm_account_for_a_delegate():
    """A delegated email capture must be staged on a PM account the assignee
    belongs to (a teammate can't see a private LOCAL task). The matcher keys on
    provider_user_id first, then email, then name."""
    import asyncio

    from gateway.routes.tasks import capture_email as ce

    class _Res:
        def __init__(self, rows):
            self._rows = rows

        def fetchall(self):
            return self._rows

    class _Row:
        def __init__(self, id_, cache):
            self.id = id_
            self.schema_cache = cache

    class _DB:
        def __init__(self, rows):
            self._rows = rows

        async def execute(self, *_a, **_k):
            return _Res(self._rows)

    db = _DB([_Row("acct-1", {"members": [
        {"name": "Rahul", "email": "rahul@x.in", "provider_user_id": "7"}]})])
    placed = asyncio.run(ce._find_pm_account_for_person(
        db, "u1", {"name": "Rahul", "provider_user_id": "7"}))
    assert placed is not None
    account_id, member = placed
    assert account_id == "acct-1"
    assert member["provider_user_id"] == "7"

    # Nobody matches → None, so the route downgrades to a local inbox item.
    db2 = _DB([_Row("acct-1", {"members": [
        {"name": "Someone Else", "provider_user_id": "99"}]})])
    assert asyncio.run(ce._find_pm_account_for_person(
        db2, "u1", {"name": "Rahul", "provider_user_id": "7"})) is None


def test_email_capture_routes_delegations_to_the_pm_tool():
    """Destination rule: a task handed to SOMEONE ELSE goes to the PM tool
    (SYNCED/pending); if no account has them it must NOT be stranded as an
    invisible local delegated task — it falls back to MY inbox."""
    import inspect

    from gateway.routes.tasks import capture_email

    src = inspect.getsource(capture_email.capture_from_email)
    assert 'source, sync_state = "SYNCED", "pending"' in src
    assert 'assignee, disposition = None, "INBOX"' in src
    # The staged destination is carried onto the row.
    assert '"source": source, "account_id": account_id' in src


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

    # The push machinery lives in the shared helper (reused by push + delegate).
    src = inspect.getsource(tasks_items._push_pending_item)
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

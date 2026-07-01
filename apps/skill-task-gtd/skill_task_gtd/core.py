"""GTD tools for agent-task-manager — provider-agnostic, gateway-backed.

Every tool calls the gateway ``/tasks`` API (the canonical GTD store +
provider interface layer) with the internal bearer token and the acting
user's email — the same access pattern as agent-email-assistant. The agent
therefore never touches a PM tool's REST API directly; the interface layer
resolves the connector (spec §3.1).

Boundary (C-04): these tools READ and operate on OUR canonical store.
Clarifying/organizing an item toward a connected workspace only STAGES it
(``sync_state='pending'``); the user pushes it from the UI. There is
deliberately no push/write-to-provider tool here.

All tools return compact plain-text summaries for the agent context window.
"""

from __future__ import annotations

import json
import os
from typing import Any

import httpx


def _gateway_url() -> str:
    return os.environ.get("GATEWAY_URL", "http://localhost:8080").rstrip("/")


def _current_user_email() -> str:
    """The user this agent run acts for (ContextVar first, env fallback —
    the exact recipe agent-email-assistant uses)."""
    try:
        from acb_skills.memory_tools import _get_memory_user_id
        user = _get_memory_user_id() or ""
        if user:
            return user
    except Exception:
        pass
    return os.environ.get("ACB_AGENT_USER_EMAIL", "")


def _internal_token() -> str:
    try:
        from acb_common import get_settings
        settings = get_settings()
        return (
            getattr(settings, "gateway_internal_token", "")
            or getattr(settings, "litellm_master_key", "")
            or "sk-local"
        )
    except Exception:
        return os.environ.get("LITELLM_MASTER_KEY", "sk-local")


def _headers() -> dict[str, str]:
    headers = {
        "Authorization": f"Bearer {_internal_token()}",
        "Content-Type": "application/json",
    }
    user = _current_user_email()
    if user:
        headers["X-User-Email"] = user
    return headers


async def _request(method: str, path: str, **kwargs: Any) -> Any:
    async with httpx.AsyncClient(timeout=30.0) as client:
        resp = await client.request(
            method, f"{_gateway_url()}{path}", headers=_headers(), **kwargs
        )
    if resp.status_code >= 400:
        detail = ""
        try:
            body = resp.json()
            if isinstance(body, dict):
                detail = str(body.get("detail") or "")
        except Exception:
            detail = (resp.text or "")[:200]
        raise RuntimeError(
            f"Tasks {method} {path} failed ({resp.status_code})"
            + (f": {detail}" if detail else "")
        )
    return resp.json() if resp.text else None


def _fmt_item(i: dict[str, Any]) -> str:
    bits = [f"[{i.get('disposition', '?')}] {i.get('title', '?')}"]
    if i.get("next_action"):
        bits.append(f"next: {i['next_action']}")
    if i.get("context"):
        bits.append(i["context"])
    if i.get("waiting_on"):
        bits.append(f"waiting on {i['waiting_on'].get('name')}")
    if i.get("due_at"):
        bits.append(f"due {i['due_at'][:10]}")
    if i.get("sync_state") == "pending":
        bits.append("PENDING PUSH")
    bits.append(f"id={i.get('id', '')[:8]}…" if len(i.get("id", "")) > 8
                else f"id={i.get('id', '')}")
    return " · ".join(bits) + f"\n  full_id: {i.get('id', '')}"


# ── Capture ──────────────────────────────────────────────────────────────────

async def gtd_capture(title: str, notes: str = "") -> str:
    """Capture one thought/task into the GTD inbox (capture ≠ clarify).

    Args:
        title: The thing on the user's mind, verbatim.
        notes: Optional extra detail to keep with the capture.
    """
    item = await _request("POST", "/tasks/items",
                          json={"title": title, "notes": notes or None})
    return f"Captured to inbox: {item['title']} (id: {item['id']})"


async def gtd_capture_many(lines: str) -> str:
    """Capture a brain-dump: one inbox item per non-empty line.

    Args:
        lines: Newline-separated thoughts (e.g. from a mind sweep).
    """
    titles = [ln.strip() for ln in lines.splitlines() if ln.strip()]
    items = await _request("POST", "/tasks/items/batch", json={"titles": titles})
    return f"Captured {len(items)} items to the inbox:\n" + "\n".join(
        f"  - {i['title']}" for i in items)


# ── Browse ───────────────────────────────────────────────────────────────────

async def gtd_list(view: str = "inbox", query: str = "",
                   context: str = "") -> str:
    """List GTD items for a view.

    Args:
        view: inbox | next | waiting | someday | reference | calendar | done | all.
        query: Optional text search within the view.
        context: Optional @context filter (e.g. "@calls") for the next view.
    """
    params = {"view": view}
    if query:
        params["q"] = query
    if context:
        params["context"] = context
    items = await _request("GET", "/tasks/items", params=params)
    if not items:
        return f"No items in {view}."
    return f"{len(items)} item(s) in {view}:\n" + "\n".join(
        _fmt_item(i) for i in items[:30])


async def gtd_list_projects() -> str:
    """List all projects (LOCAL GTD projects + synced provider projects)."""
    projects = await _request("GET", "/tasks/projects")
    if not projects:
        return "No projects yet."
    return f"{len(projects)} project(s):\n" + "\n".join(
        f"  [{p['source']}] {p['outcome']}"
        + (f" · {p['provider']}" if p.get("provider") not in (None, "local") else "")
        + f" · id={p['id']}"
        for p in projects[:50])


async def gtd_accounts() -> str:
    """List connected PM-tool workspaces + their stages and members
    (the fetched-beforehand schema used while processing)."""
    accounts = await _request("GET", "/tasks/accounts")
    if not accounts:
        return ("No PM-tool workspaces connected. Tasks stay LOCAL until the "
                "user connects one (Tasks → connect workspace).")
    out = []
    for a in accounts:
        members = ", ".join(m["name"] for m in a.get("members", [])[:12])
        out.append(
            f"{a['label']} ({a['provider']} · workspace {a['workspace_id']} · "
            f"account_id={a['id']})\n"
            f"  stages: {', '.join(a.get('statuses') or []) or '—'}\n"
            f"  members: {members or '—'}\n"
            f"  projects cached: {a.get('project_count', 0)}")
    return "\n".join(out)


async def gtd_inbox_insights() -> str:
    """Whole-inbox health: counts per bucket, oldest capture, stale
    waiting-fors, projects missing a next action. Use before processing."""
    d = await _request("GET", "/tasks/insights")
    counts = ", ".join(f"{k}: {v}" for k, v in (d.get("counts") or {}).items())
    return (
        f"Buckets — {counts or 'empty'}\n"
        f"Oldest inbox capture: {d.get('oldest_inbox_at') or '—'}\n"
        f"Stale waiting-fors (>5d): {d.get('stale_waiting', 0)}\n"
        f"Active projects without a next action: "
        f"{d.get('projects_without_next_action', 0)}"
    )


# ── Clarify / organize ───────────────────────────────────────────────────────

async def gtd_clarify(item_id: str) -> str:
    """Get the structured clarify proposal for one inbox item — disposition,
    next action, matched project, destination, default stage, confidence.

    Args:
        item_id: The item's full UUID (from gtd_list).
    """
    p = await _request("POST", f"/tasks/items/{item_id}/clarify")
    return json.dumps(p, indent=1)


async def gtd_organize(
    item_id: str,
    kind: str,
    next_action: str = "",
    outcome: str = "",
    context: str = "",
    energy: str = "",
    due_at: str = "",
    account_id: str = "",
    project_id: str = "",
    status: str = "",
    assignee_name: str = "",
    assignee_email: str = "",
    assignee_provider_user_id: str = "",
) -> str:
    """Apply a clarify decision to an inbox item (ALWAYS confirm the decision
    with the user first — AI proposes, the human decides).

    Args:
        item_id: The item's full UUID.
        kind: next | project | delegate | calendar | do-now | someday | reference | trash.
        next_action: The physical next step (required for next/project/delegate/calendar).
        outcome: The project's wild-success statement (required for kind=project).
        context: "@computer" | "@calls" | … (for actionable kinds).
        energy: low | medium | high.
        due_at: ISO date/datetime for a deadline or the calendar day.
        account_id: Destination workspace account UUID for a SYNCED item
            (from gtd_accounts); empty keeps it LOCAL. Staged as pending —
            the user pushes it to the tool from the UI.
        project_id: Existing project UUID to file under (from gtd_list_projects).
        status: The tool's stage, e.g. "Backlog" for someday-under-a-project,
            "To-do" for actioned/delegated work.
        assignee_name / assignee_email / assignee_provider_user_id:
            Who it's delegated/assigned to (required for kind=delegate).
    """
    body: dict[str, Any] = {"kind": kind}
    if next_action:
        body["next_action"] = next_action
    if outcome:
        body["outcome"] = outcome
    if context:
        body["context"] = context
    if energy:
        body["energy"] = energy
    if due_at:
        body["due_at"] = due_at
    if account_id:
        body["account_id"] = account_id
    if project_id:
        body["project_id"] = project_id
    if status:
        body["status"] = status
    if assignee_name:
        body["assignee"] = {
            "name": assignee_name,
            "email": assignee_email or None,
            "provider_user_id": assignee_provider_user_id or None,
        }
    item = await _request("POST", f"/tasks/items/{item_id}/organize", json=body)
    staged = " (staged for push — user applies it from the UI)" \
        if item.get("sync_state") == "pending" else ""
    return f"Organized → {_fmt_item(item)}{staged}"


async def gtd_update(item_id: str, title: str = "", notes: str = "",
                     defer_until: str = "") -> str:
    """Small edits: rename a capture, add a note, or snooze it (tickler).

    Args:
        item_id: The item's full UUID.
        title: New title (empty = unchanged).
        notes: New note (empty = unchanged).
        defer_until: ISO date to hide it until (tickler); "clear" un-snoozes.
    """
    body: dict[str, Any] = {}
    if title:
        body["title"] = title
    if notes:
        body["notes"] = notes
    if defer_until:
        body["defer_until"] = "" if defer_until == "clear" else defer_until
    if not body:
        return "Nothing to update."
    item = await _request("PATCH", f"/tasks/items/{item_id}", json=body)
    return f"Updated → {_fmt_item(item)}"

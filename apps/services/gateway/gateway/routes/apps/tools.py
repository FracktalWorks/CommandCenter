"""Custom Apps · tools — the ``cc.tools`` integration proxy (RFC §4.4/§4.7).

Lets a sandboxed app frontend call a platform integration (ClickUp first)
through a scope-checked, human-confirmed, fully-audited bridge, reusing the
existing Action Broker end-to-end (``apps/services/action_broker``) — the same
propose/decide_disposition/submit machinery every other outward write goes
through. Apps never hold credentials; the platform resolves them server-side
per call (Integration Registry, ``acb_skills.integrations.build_integrations``).

Vocabulary:

* A manifest **scope** is ``tool:<tool>[?param=value&...]`` — the Windmill
  pattern (§4.1): the query string freezes constraints (e.g. ``list=123``)
  that the runtime call can never override, no matter what the app sends.
* A **tool** (``clickup.create_task``) is a small local registry entry
  (:class:`ToolSpec`) naming its Integration Registry service, its risk
  shape (mirroring ``acb_skills.tool_annotations``'s four-bool vocabulary,
  minus ``idempotent`` — not needed here), and the one async function that
  performs it.
* A **broker action** is the namespaced name (``app.clickup_create_task``)
  registered with ``action_broker`` — namespaced because
  ``action_broker._HANDLERS`` is one flat dict for the whole process and the
  Task Manager already owns the bare ``clickup.create_task`` action name
  (``gateway.routes.tasks.broker_handlers``, its own per-account credential
  resolution keyed off ``task_accounts``). Everything scope-facing (manifest
  scopes, the route path, audit rows) keeps the plain tool name; only the
  broker registration/propose call uses the namespaced one.

Scopes are checked against the app's LIVE (published) manifest, never the
draft workspace's — tool scopes are reviewed at publish time (§4.8,
``publish.py``'s review gate), so a runtime call must see what was actually
reviewed, not whatever the Workshop chat has since scribbled into ``app.json``.
"""

from __future__ import annotations

import json
import os
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any
from urllib.parse import parse_qsl

from acb_auth import UserContext
from acb_common import get_settings
from acb_skills.integrations import build_integrations
from action_broker import (
    ActionProposal,
    AuthorityTier,
    propose,
    register_action_handler,
    submit,
)
from fastapi import Depends, HTTPException
from fastapi.responses import JSONResponse
from gateway.routes.apps._common import (
    _get_db,
    _log,
    _uid,
    get_app_or_404,
    manifest_scopes,
    parse_db_manifest,
    record_app_audit,
    require_app_user,
    router,
)
from gateway.routes.tasks.providers import _clickup_send
from pydantic import BaseModel
from sqlalchemy import text

CLICKUP_BASE = "https://api.clickup.com/api/v2"  # duplicated, not cross-imported
# (`gateway.routes.tasks.providers._CLICKUP` is private to that module — this
# package only reuses its exported ``_clickup_send`` rate-limit helper).

BROKER_ACTION_PREFIX = "app."


class ToolExecutionError(RuntimeError):
    """A tool handler failed (bad args, missing credentials, non-2xx upstream).

    Caught by the route on the direct (read-only) execute path and turned
    into a 502. On the destructive/broker path it can also surface by
    propagating out of ``action_broker.execute()`` — the route's ``submit()``
    call is wrapped defensively to catch that too (the broker itself does not
    guard a handler's exceptions; see ``gateway.routes.tasks.broker_handlers``
    for the same precedent).
    """


# ── Scope parsing (pure, testable) ───────────────────────────────────────────

def parse_tool_scope(scope: str) -> tuple[str, dict[str, str]] | None:
    """``'tool:clickup.create_task?list=Procurement'`` → ``('clickup.create_task',
    {'list': 'Procurement'})``. The ``?`` section is ``urllib.parse.parse_qsl``'d
    (last value wins per key). ``None`` when *scope* doesn't start with
    ``'tool:'`` or names an empty tool."""
    if not isinstance(scope, str) or not scope.startswith("tool:"):
        return None
    body = scope[len("tool:"):]
    tool, _, query = body.partition("?")
    tool = tool.strip()
    if not tool:
        return None
    constraints = dict(parse_qsl(query))
    return tool, constraints


def find_declared_tool_scope(
    manifest: dict[str, Any], tool: str,
) -> dict[str, str] | None:
    """The constraint dict of the FIRST manifest scope naming *tool*, or
    ``None`` when the app never declared it (→ the route's 403)."""
    for raw in manifest_scopes(manifest):
        parsed = parse_tool_scope(raw)
        if parsed is not None and parsed[0] == tool:
            return parsed[1]
    return None


def merge_tool_args(
    request_args: dict[str, Any] | None, constraints: dict[str, str],
) -> dict[str, Any]:
    """The frozen-param security property (Windmill's "static parameters are
    not overridable"): scope constraints ALWAYS win over caller-supplied
    args, so a request can widen nothing the publish-time scope pinned."""
    return {**(request_args or {}), **constraints}


# ── Local tool registry ──────────────────────────────────────────────────────

@dataclass(frozen=True)
class ToolSpec:
    integration: str            # Integration Registry service name
    read_only: bool
    destructive: bool
    open_world: bool
    handler: Callable[[dict[str, Any]], Awaitable[dict[str, Any]]]


async def _clickup_create_task(args: dict[str, Any]) -> dict[str, Any]:
    """clickup.create_task's ONE execution path.

    Invoked by the Action Broker's registered handler below, whether that
    runs synchronously (auto-apply, inside the request) or minutes later
    (an operator approves a queued proposal) — there is exactly one place
    the ClickUp write happens. Resolves its own credentials each time so it
    behaves identically either way.
    """
    settings = get_settings()
    resolved, unavailable = build_integrations(["clickup"], [], settings)
    creds = resolved.get("clickup")
    if not creds:
        raise ToolExecutionError(
            unavailable.get("clickup") or "clickup integration unavailable"
        )
    list_id = str(args.get("list") or "").strip()
    if not list_id:
        raise ToolExecutionError("clickup.create_task requires a 'list' arg")
    body: dict[str, Any] = {"name": str(args.get("title") or "Untitled")}
    if args.get("description"):
        body["description"] = str(args["description"])
    if args.get("status"):
        body["status"] = str(args["status"])
    headers = {
        "Authorization": creds["api_token"], "Content-Type": "application/json",
    }
    resp = await _clickup_send(
        "POST", f"{CLICKUP_BASE}/list/{list_id}/task",
        headers=headers, json=body,
    )
    if resp.status_code >= 400:
        raise ToolExecutionError(
            f"clickup create task → {resp.status_code}: {resp.text[:200]}"
        )
    t = resp.json()
    return {
        "provider_task_id": str(t.get("id", "")),
        "provider_url": t.get("url"),
        "provider_status": (t.get("status") or {}).get("status"),
    }


_TOOL_REGISTRY: dict[str, ToolSpec] = {
    "clickup.create_task": ToolSpec(
        integration="clickup",
        read_only=False,
        destructive=True,
        open_world=True,
        handler=_clickup_create_task,
    ),
}


# ── Action Broker wiring (module import time — not per-request) ─────────────

def _broker_action_name(tool: str) -> str:
    """Namespace *tool* for the shared ``action_broker._HANDLERS`` registry
    (see module docstring — the Task Manager already owns the bare
    ``clickup.create_task`` action name)."""
    return f"{BROKER_ACTION_PREFIX}{tool.replace('.', '_')}"


async def _execute_clickup_create_task(proposal: ActionProposal) -> dict[str, Any]:
    """The registered broker handler for clickup.create_task — reads the
    already merged+constrained args off the proposal and calls the same
    function the app-facing tool spec calls. Single source of truth."""
    args = (proposal.payload or {}).get("args") or {}
    return await _clickup_create_task(args)


register_action_handler(
    _broker_action_name("clickup.create_task"), _execute_clickup_create_task,
)


async def _apply_publish_review(proposal: ActionProposal) -> dict[str, Any]:
    """Runs when an admin approves an ``app.publish_review`` proposal
    (``publish.py``'s org+write-scope publish gate, §4.8): flips the held
    version to ``review_status='approved'`` and repoints ``apps.live_version``
    (+ ``visibility``, if the publish also changed it). Own session, own
    commit — mirrors ``record_app_audit``'s use-and-close shape, on the same
    async engine as the rest of this package (``_common._get_db``).

    Known accepted gap (do not build a reconciliation job for this): a
    REJECTED review leaves this version's ``review_status`` stuck at
    ``'pending'`` forever — the generic ``/actions/pending/{id}/reject``
    endpoint only flips the ``pending_actions`` row; it has no idea about
    this app-specific side effect. The app owner republishes (a new version)
    to try again — "your PR was closed, push a new commit."
    """
    payload = proposal.payload or {}
    app_id = str(payload.get("app_id") or "")
    version = payload.get("version")
    if not app_id or version is None:
        raise ToolExecutionError(
            "app.publish_review payload missing app_id/version"
        )
    db = await _get_db()
    try:
        await db.execute(
            text(
                "UPDATE app_versions SET review_status = 'approved' "
                "WHERE app_id = :app_id AND version = :version"
            ),
            {"app_id": app_id, "version": version},
        )
        sets = "live_version = :version, status = 'live', updated_at = now()"
        params: dict[str, Any] = {"app_id": app_id, "version": version}
        visibility = payload.get("visibility")
        if visibility:
            sets += ", visibility = :visibility"
            params["visibility"] = visibility
        await db.execute(text(f"UPDATE apps SET {sets} WHERE id = :app_id"), params)
        await db.commit()
    finally:
        await db.close()
    _log.info("apps.publish_review_approved", app_id=app_id, version=version)
    return {"app_id": app_id, "version": version, "review_status": "approved"}


register_action_handler("app.publish_review", _apply_publish_review)


# ── Local ACTION_BROKER_ENFORCE gate (deliberately duplicated) ──────────────

def _tool_broker_enforced(action: str) -> bool:
    """Local copy of ``tasks.providers._broker_enforced``'s
    ``ACTION_BROKER_ENFORCE`` parsing (same env var, same rules — unset/0/
    none/off → False; 1/all/on/true → True; else comma-list membership).
    Deliberately duplicated rather than cross-imported from ``routes/tasks``:
    Custom Apps and the Task Manager are sibling features and neither should
    reach into the other's module for a ten-line env check."""
    raw = (os.environ.get("ACTION_BROKER_ENFORCE") or "").strip().lower()
    if not raw or raw in ("0", "none", "off", "false"):
        return False
    if raw in ("1", "all", "on", "true"):
        return True
    return action in {a.strip() for a in raw.split(",") if a.strip()}


# ── Runtime helpers (DB-touching, split out so tests can monkeypatch them) ──

async def _load_live_manifest(db: Any, row: Any) -> dict[str, Any]:
    """The immutable LIVE version's manifest — never the draft's (see module
    docstring). 404s when the app has no live version, or the pointed-at
    version has somehow vanished."""
    if row.live_version is None:
        raise HTTPException(status_code=404, detail="App has no live version")
    vrow = (await db.execute(
        text(
            "SELECT manifest FROM app_versions "
            "WHERE app_id = :app_id AND version = :version"
        ),
        {"app_id": str(row.id), "version": row.live_version},
    )).fetchone()
    if vrow is None:
        raise HTTPException(status_code=404, detail="Live version not found")
    return parse_db_manifest(vrow.manifest)


async def _has_remembered_grant(
    db: Any, app_id: str, email: str, tool: str,
) -> bool:
    row = (await db.execute(
        text(
            "SELECT 1 FROM app_tool_grants "
            "WHERE app_id = :app_id AND user_email = :email AND tool = :tool"
        ),
        {"app_id": app_id, "email": email, "tool": tool},
    )).fetchone()
    return row is not None


async def _remember_tool_grant(
    db: Any, app_id: str, email: str, tool: str,
) -> None:
    await db.execute(
        text(
            """INSERT INTO app_tool_grants (app_id, user_email, tool)
               VALUES (:app_id, :email, :tool)
               ON CONFLICT (app_id, user_email, tool) DO NOTHING"""
        ),
        {"app_id": app_id, "email": email, "tool": tool},
    )
    await db.commit()


def _audit_args(args: dict[str, Any]) -> Any:
    """*args* for the audit row, JSON-capped to ~1000 chars (never raises)."""
    try:
        encoded = json.dumps(args, default=str)
    except Exception:
        return {}
    return args if len(encoded) <= 1000 else {"_truncated": encoded[:1000]}


# ── The route ─────────────────────────────────────────────────────────────

class ToolCallRequest(BaseModel):
    args: dict[str, Any] = {}
    confirm: bool = False
    remember: bool = False


async def _run_read_only_tool(
    row: Any, user: UserContext, tool: str,
    spec: ToolSpec, merged_args: dict[str, Any],
) -> dict[str, Any]:
    """No broker, no confirm — the tool runs immediately and is audited."""
    try:
        result = await spec.handler(merged_args)
    except Exception as exc:
        await record_app_audit(
            app_id=str(row.id), user_email=_uid(user), kind="tool",
            app_version=row.live_version,
            detail={"tool": tool, "args": _audit_args(merged_args),
                    "ok": False, "error": str(exc)[:500]},
        )
        raise HTTPException(
            status_code=502, detail={"error": str(exc)[:500]},
        ) from exc
    await record_app_audit(
        app_id=str(row.id), user_email=_uid(user), kind="tool",
        app_version=row.live_version,
        detail={"tool": tool, "args": _audit_args(merged_args), "ok": True},
    )
    return {"result": result}


async def _run_destructive_tool(
    slug: str, row: Any, user: UserContext, tool: str,
    merged_args: dict[str, Any], body: ToolCallRequest,
) -> Any:
    """Per-use confirm (or a remembered grant), then the Action Broker."""
    email = _uid(user)
    db = await _get_db()
    try:
        pre_confirmed = await _has_remembered_grant(db, str(row.id), email, tool)
        if not pre_confirmed and not body.confirm:
            return JSONResponse(status_code=409, content={
                "error": "confirmation_required", "tool": tool, "args": merged_args,
            })
        if body.confirm and body.remember:
            await _remember_tool_grant(db, str(row.id), email, tool)
    finally:
        await db.close()

    authority = (
        AuthorityTier.SUGGEST_APPLY if _tool_broker_enforced(tool)
        else AuthorityTier.AUTONOMOUS
    )
    proposal = propose(
        actor=f"app:{slug}:{email}", action=_broker_action_name(tool),
        target=f"app:{slug}", payload={"args": merged_args},
        authority=authority, destructive=True,
    )
    try:
        outcome = await submit(proposal)
    except Exception as exc:  # the broker doesn't guard handler exceptions
        outcome = {"ok": False, "error": str(exc)[:500]}

    if outcome.get("status") == "pending":
        await record_app_audit(
            app_id=str(row.id), user_email=email, kind="tool",
            app_version=row.live_version,
            detail={"tool": tool, "args": _audit_args(merged_args),
                    "queued": True, "action_id": outcome.get("action_id")},
        )
        return JSONResponse(status_code=202, content={
            "queued": True, "action_id": outcome.get("action_id"),
        })
    if outcome.get("ok"):
        await record_app_audit(
            app_id=str(row.id), user_email=email, kind="tool",
            app_version=row.live_version,
            detail={"tool": tool, "args": _audit_args(merged_args), "ok": True},
        )
        return {"result": outcome.get("result")}

    await record_app_audit(
        app_id=str(row.id), user_email=email, kind="tool",
        app_version=row.live_version,
        detail={"tool": tool, "args": _audit_args(merged_args),
                "ok": False, "error": outcome.get("error")},
    )
    raise HTTPException(
        status_code=502,
        detail={"error": outcome.get("error") or "tool call failed"},
    )


@router.post("/{slug}/tools/{tool}")
async def call_app_tool(
    slug: str,
    tool: str,
    body: ToolCallRequest,
    user: UserContext = Depends(require_app_user),
) -> Any:
    """``cc.tools.call(tool, args)`` — the App Runtime API's integration proxy.

    View-gated: any viewer/agent with app access may call a declared tool,
    not just editors (this is the app's own runtime surface, RFC §4.4/§4.7).
    Scopes are checked against the LIVE manifest. Read-only tools execute
    immediately; destructive ones need a per-use confirm (or a remembered
    "always allow" grant, ``app_tool_grants``) and then flow through the
    Action Broker exactly like every other outward write in the platform.
    """
    db = await _get_db()
    try:
        row, _grants = await get_app_or_404(db, slug, user)
        manifest = await _load_live_manifest(db, row)
    finally:
        await db.close()

    constraints = find_declared_tool_scope(manifest, tool)
    if constraints is None:
        raise HTTPException(
            status_code=403, detail={"error": "scope_not_declared", "tool": tool},
        )

    spec = _TOOL_REGISTRY.get(tool)
    if spec is None:
        raise HTTPException(
            status_code=404, detail={"error": "unknown_tool", "tool": tool},
        )

    # The pre-check only needs to know availability, not the creds — the
    # handler re-resolves its own credentials (see _clickup_create_task).
    _resolved, unavailable = build_integrations(
        [spec.integration], [], get_settings(),
    )
    if spec.integration in unavailable:
        raise HTTPException(
            status_code=424,
            detail={"error": "integration_unavailable",
                    "reason": unavailable[spec.integration]},
        )

    merged_args = merge_tool_args(body.args, constraints)

    if spec.read_only:
        return await _run_read_only_tool(row, user, tool, spec, merged_args)
    return await _run_destructive_tool(slug, row, user, tool, merged_args, body)

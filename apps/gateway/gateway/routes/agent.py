"""Agent event routing endpoints (CommandCenter v2 — Core FastAPI router).

Endpoints
---------
POST /agent/run
    Synchronously run a named agent and wait for the result.

POST /agent/run/async
    Fire-and-forget: enqueue the run as a background task, return run_id immediately.

GET  /agent/run/{run_id}/status
    Query the Postgres checkpoint for a run's current state.

POST /agent/webhook/{source}
    Receive an external webhook (ClickUp, Zoho, Gmail, WhatsApp) and route
    it to the correct specialist agent based on the built-in routing table.
    In Phase 2 this table will be driven by each agent's ``config.json``.
"""
from __future__ import annotations

import json
import re
import uuid
from pathlib import Path
from typing import Any

from acb_auth import UserContext, get_current_user, require_internal_auth
from acb_common import get_logger, get_settings
from fastapi import (APIRouter, BackgroundTasks, Depends, HTTPException,
                     Request, status)
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

_log = get_logger("gateway.agent")

router = APIRouter(prefix="/agent", tags=["agents"])


# ---------------------------------------------------------------------------
# Request / response models
# ---------------------------------------------------------------------------

class AgentRunRequest(BaseModel):
    agent: str
    """Bare agent name, e.g. ``"task-manager"``.  Core prepends ``agent-`` when cloning."""
    payload: dict[str, Any] = {}
    thread_id: str | None = None
    run_id: str | None = None
    model: str | None = None
    """Optional model override.  If it is a LiteLLM model (contains '/' or starts
    with 'tier'), the executor injects a BYOK provider block so the Copilot SDK
    routes completions through the gateway /v1 (litellm SDK) instead of github.com."""
    assistant_message_id: str | None = None
    """Frontend-minted id of this turn's assistant message row.  The gateway's
    fold-and-persist at run end (core_loop_unification Phase 1, P0-3) upserts
    the SAME row the live translator checkpoints, keeping the two writers
    idempotent.  Falls back to ``assistant-{thread}-{run_id}`` when absent."""


class AgentRunResponse(BaseModel):
    run_id: str
    agent: str
    status: str  # "completed" | "failed" | "queued"
    result: Any | None = None
    mutation_pr: str | None = None
    error: str | None = None


class UserInputResponseRequest(BaseModel):
    """Answer to a native ask_user (on_user_input_request) prompt."""

    request_id: str
    answer: str
    was_freeform: bool = True
    # Thread the parked run belongs to — used to relay the answer to whichever
    # worker owns the run when it's not parked on THIS worker (P1-2).
    thread_id: str | None = None


class WebhookEvent(BaseModel):
    source: str
    event_type: str
    payload: dict[str, Any] = {}


# ---------------------------------------------------------------------------
# Agent name allowlist (security: never clone arbitrary user-supplied names)
# ---------------------------------------------------------------------------

_KNOWN_AGENTS: frozenset[str] = frozenset(
    [
        "task-manager",
        "apis-config",
        "email-assistant",
    ]
)

# Human-readable metadata for the Control Plane agent picker.
# Keys match the bare agent names in _KNOWN_AGENTS.
_AGENT_REGISTRY: list[dict] = [
    {
        "name": "task-manager",
        "description": "GTD task manager — capture, clarify, organize (Local or a connected PM workspace), and status/workload Q&A with citations.",
        "tags": ["tasks", "clickup", "project-management"],
        "status": "live",
        # Runs through MAF (CommandCenterCopilotAgent wrapper) with BYOK model support.
        "agent_runtime": "github-copilot",
        "local_path": "apps/agent-task-manager",
        "integrations": ["clickup"],
        "optional_integrations": [],
        "webhook_routes": [
            {"source": "clickup", "event_type": "taskCreated"},
            {"source": "clickup", "event_type": "taskUpdated"},
            {"source": "clickup", "event_type": "taskDeleted"},
        ],
    },
    {
        "name": "apis-config",
        "description": (
            "API Configuration Assistant — discovers any API by name, "
            "finds its documentation via web search, and guides you "
            "through credential setup step by step."
        ),
        "tags": ["configuration", "apis", "setup", "admin"],
        "status": "live",
        "agent_runtime": "github-copilot",
        "local_path": "apps/agent-apis-config",
        "integrations": [],
        "optional_integrations": ["serpapi"],
    },
    {
        "name": "email-assistant",
        "description": (
            "Email Assistant — checks the inbox, categorizes mail, and drafts "
            "context-aware replies, handing off to the sales and task-manager "
            "agents and reading memory when an email needs their context."
        ),
        "tags": ["email", "gmail", "outlook", "drafting", "apps"],
        "status": "live",
        # email-assistant is a MAF agent (see apps/agent-email-assistant:
        # agents.py build_agents() + config.json "runtime": "maf"). It must NOT
        # be labelled github-copilot — that routes it through the Copilot SDK
        # session, which fails with a GitHub 402 quota error instead of using
        # the BYOK LiteLLM tiers (tier-balanced → deepseek). Keep this "maf".
        "agent_runtime": "maf",
        "local_path": "apps/agent-email-assistant",
        "integrations": [],
        "optional_integrations": [],
    },
]


# ---------------------------------------------------------------------------
# Dynamic (user-registered) agent persistence — Postgres-backed.
# Survives git reset --hard, deploys, and reboots.
# Falls back to agents.json on first read for backward-compatible migration.
# ---------------------------------------------------------------------------

def _normalize_runtime(val: object) -> str | None:
    """Normalize a declared runtime string to 'maf' or 'github-copilot'.

    Returns None for anything unrecognised/empty so callers can fall back.
    """
    if not isinstance(val, str):
        return None
    v = val.strip().lower()
    if v == "maf":
        return "maf"
    if v in ("github-copilot", "github_copilot", "githubcopilot",
             "copilot", "copilot-sdk"):
        return "github-copilot"
    return None


def _declared_runtime(agent_name: str, local_path: str | None = None) -> str | None:
    """Return the runtime an agent DECLARES in its config.json (normalized), or
    None if it declares nothing.

    An agent's own ``config.json`` ``runtime`` field is authoritative over the
    registration-time heuristic (which only knew "came from GitHub" vs "local
    path" and so mislabelled MAF agents — e.g. email-assistant, which declares
    ``"runtime": "maf"`` — as Copilot SDK).  Checked in the clone first (always
    reflects the current repo), then the ``local_path`` source.
    """
    candidates: list[Path] = []
    try:
        from gateway.routes.workspace import \
            _agent_workspace_dir  # noqa: PLC0415
        ws = _agent_workspace_dir(agent_name)
        if ws is not None:
            candidates.append(ws / "config.json")
    except Exception:  # noqa: BLE001
        pass
    if local_path:
        candidates.append(Path(local_path) / "config.json")
    for cfg_path in candidates:
        try:
            if cfg_path.is_file():
                data = json.loads(
                    cfg_path.read_text(encoding="utf-8", errors="replace")
                )
                rt = _normalize_runtime(data.get("runtime"))
                if rt:
                    return rt
        except Exception:  # noqa: BLE001
            continue
    return None


def _load_dynamic_agents() -> list[dict]:
    """Return user-registered agents from the dynamic_agents Postgres table.

    On every call, also imports any agents found in agents.json that are
    missing from the database — this ensures agents registered while Postgres
    was temporarily unavailable eventually sync into the DB.

    On first call after migration, imports any existing agents.json data
    into the DB so nothing is lost.
    """
    try:
        from acb_graph import get_session  # noqa: PLC0415
        from sqlalchemy import text  # noqa: PLC0415

        # ── Always sync agents.json → DB for missing agents ─────────────
        _sync_file_into_db()

        with get_session() as s:
            rows = s.execute(
                text(
                    "SELECT name, description, tags, status, agent_runtime, "
                    "repo_url, repo_name, local_path, integrations, "
                    "optional_integrations FROM dynamic_agents ORDER BY name"
                )
            ).fetchall()
        if rows:
            out = [
                {
                    "name": (r[0] or "").strip(),
                    "description": (r[1] or "").strip(),
                    "tags": r[2] if isinstance(r[2], list) else [],
                    "status": (r[3] or "live").strip(),
                    "agent_runtime": (r[4] or "maf").strip(),
                    "repo_url": (r[5] or "").strip() or None,
                    "repo_name": (r[6] or "").strip() or None,
                    "local_path": (r[7] or "").strip() or None,
                    "integrations": r[8] if isinstance(r[8], list) else [],
                    "optional_integrations": (
                        r[9] if isinstance(r[9], list) else []
                    ),
                    "dynamic": True,
                }
                for r in rows
            ]
            # Honor each agent's declared config.json runtime over the stored
            # value, so the executor and the UI route/label by what the agent
            # actually is rather than the registration heuristic.
            for a in out:
                rt = _declared_runtime(a["name"], a.get("local_path"))
                if rt:
                    a["agent_runtime"] = rt
            return out
        # DB empty — import everything from file
        return _migrate_from_file()
    except Exception:  # noqa: BLE001
        return _migrate_from_file()


def _sync_file_into_db() -> None:
    """Read agents.json and upsert any entries not yet in the DB.

    Does NOT delete DB entries that are absent from the file — the DB is
    the authority.  This only fills in missing agents so a file-only write
    (e.g. Postgres temporarily unavailable during registration) eventually
    makes it into the database.
    """
    try:
        path = _get_agents_file()
        if not path.exists():
            return
        file_agents: list[dict] = json.loads(path.read_text(encoding="utf-8"))
        if not file_agents:
            return

        import json as _json  # noqa: PLC0415

        from acb_graph import get_session  # noqa: PLC0415
        from sqlalchemy import text  # noqa: PLC0415

        with get_session() as s:
            # Get names already in DB
            existing = {
                r[0] for r in s.execute(
                    text("SELECT name FROM dynamic_agents")
                ).fetchall()
            }
            # Upsert any file agents missing from DB
            for a in file_agents:
                if a.get("name") in existing:
                    continue
                # Validate name before inserting — only accept well-formed slugs
                aname = a.get("name", "")
                if not aname or not re.match(r"^[a-z0-9][a-z0-9-]{0,48}[a-z0-9]$", aname):
                    _log.warning("agent.sync_skipped_invalid_name", name=aname)
                    continue
                s.execute(
                    text(
                        "INSERT INTO dynamic_agents "
                        "(name, description, tags, status, agent_runtime, "
                        "repo_url, repo_name, local_path, integrations, "
                        "optional_integrations, updated_at) "
                        "VALUES (:n,:d,CAST(:t AS jsonb),:s,:r,:ru,:rn,:lp,"
                        "CAST(:i AS jsonb),CAST(:oi AS jsonb),now()) "
                        "ON CONFLICT (name) DO NOTHING"
                    ),
                    {
                        "n": a["name"],
                        "d": a.get("description", ""),
                        "t": _json.dumps(a.get("tags", [])),
                        "s": a.get("status", "live"),
                        "r": a.get("agent_runtime", "maf"),
                        "ru": a.get("repo_url"),
                        "rn": a.get("repo_name"),
                        "lp": a.get("local_path"),
                        "i": _json.dumps(a.get("integrations", [])),
                        "oi": _json.dumps(
                            a.get("optional_integrations", [])
                        ),
                    },
                )
            s.commit()
    except Exception:
        pass  # Best-effort; DB is the authority


def _strip_agent_strings(a: dict) -> dict:
    """Return a copy of the agent dict with all top-level string values stripped."""
    return {
        k: (v.strip() if isinstance(v, str) else v)
        for k, v in a.items()
    }


def _migrate_from_file() -> list[dict]:
    """One-time import from agents.json.  Writes to DB on success."""
    try:
        path = _get_agents_file()
        if not path.exists():
            return []
        agents: list[dict] = json.loads(path.read_text(encoding="utf-8"))
        agents = [_strip_agent_strings(a) for a in agents]
        if agents:
            _save_dynamic_agents(agents)  # persist to DB
        return agents
    except Exception:  # noqa: BLE001
        return []


def _get_agents_file() -> Path:
    """Locate agents.json for backward-compatible migration reads."""
    candidate = Path(__file__).resolve()
    for _ in range(8):
        candidate = candidate.parent
        if (candidate / "pyproject.toml").exists():
            return candidate / "agents.json"
    return Path.cwd() / "agents.json"


def _save_dynamic_agents(agents: list[dict]) -> None:
    """Write the dynamic agent list to the dynamic_agents Postgres table."""
    try:
        import json as _json

        from acb_graph import get_session  # noqa: PLC0415
        from sqlalchemy import text  # noqa: PLC0415
        with get_session() as s:
            for a in agents:
                s.execute(
                    text(
                        "INSERT INTO dynamic_agents "
                        "(name, description, tags, status, agent_runtime, "
                        "repo_url, repo_name, local_path, integrations, "
                        "optional_integrations, updated_at) "
                        "VALUES (:n,:d,CAST(:t AS jsonb),:s,:r,:ru,:rn,:lp,"
                        "CAST(:i AS jsonb),CAST(:oi AS jsonb),now()) "
                        "ON CONFLICT (name) DO UPDATE SET "
                        "description=EXCLUDED.description, "
                        "tags=EXCLUDED.tags, "
                        "status=EXCLUDED.status, "
                        "agent_runtime=EXCLUDED.agent_runtime, "
                        "repo_url=EXCLUDED.repo_url, "
                        "repo_name=EXCLUDED.repo_name, "
                        "local_path=EXCLUDED.local_path, "
                        "integrations=EXCLUDED.integrations, "
                        "optional_integrations=EXCLUDED.optional_integrations, "
                        "updated_at=now()"
                    ),
                    {
                        "n": a["name"], "d": a.get("description", ""),
                        "t": _json.dumps(a.get("tags", [])),
                        "s": a.get("status", "live"),
                        "r": a.get("agent_runtime", "maf"),
                        "ru": a.get("repo_url"),
                        "rn": a.get("repo_name"),
                        "lp": a.get("local_path"),
                        "i": _json.dumps(a.get("integrations", [])),
                        "oi": _json.dumps(a.get("optional_integrations", [])),
                    },
                )
            s.commit()
    except Exception:
        # Fallback: write to agents.json so data is not lost if DB is down
        try:
            path = _get_agents_file()
            path.write_text(
                json.dumps(agents, indent=2, ensure_ascii=False),
                encoding="utf-8",
            )
        except Exception:  # noqa: BLE001
            pass


def _validate_agent_name(name: str) -> str:
    """Reject agent names not in the static or dynamic allowlist.

    Performs case-insensitive matching against the registry so names
    stored with mixed case in the DB still resolve correctly.
    """
    safe = name.lower().strip()
    # Strip optional 'agent-' prefix so 'agent-project-manager' matches 'project-manager'
    if safe.startswith("agent-"):
        safe_no_prefix = safe[len("agent-"):]
    else:
        safe_no_prefix = safe

    # Build case-insensitive lookup maps
    registry_names = {a["name"].lower(): a["name"] for a in _AGENT_REGISTRY}
    dynamic_names = {a["name"].lower(): a["name"] for a in _load_dynamic_agents()}
    known_lower = {n.lower() for n in _KNOWN_AGENTS}
    all_allowed_lower = known_lower | set(registry_names.keys()) | set(dynamic_names.keys())

    if safe not in all_allowed_lower and safe_no_prefix not in all_allowed_lower:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=(
                f"Unknown agent {name!r}. "
                f"Registered: {sorted(all_allowed_lower)}"
            ),
        )

    # Return the canonical (DB-stored) name to preserve original casing
    if safe in all_allowed_lower:
        return registry_names.get(safe) or dynamic_names.get(safe) or safe
    return registry_names.get(safe_no_prefix) or dynamic_names.get(safe_no_prefix) or safe_no_prefix


# The sentinel a session carries when its real agent hasn't been resolved yet
# (e.g. /chat/active-sessions returns it for a Redis-active thread with no
# chat_session row yet). It must NEVER reach a run dispatch as a literal agent
# name — see _resolve_agent_for_run below.
_UNRESOLVED_AGENT_SENTINELS = {"unknown", "", "undefined", "null", "none"}


def _resolve_agent_for_run(agent: str | None, thread_id: str | None) -> str:
    """Resolve the agent name for a run, recovering an unresolved sentinel.

    A chat session can carry ``agent_name='unknown'`` (the placeholder that
    ``/chat/active-sessions`` returns for a Redis-active thread whose
    ``chat_session`` row doesn't exist yet). If that poisoned value is dispatched
    verbatim, ``_validate_agent_name`` 422s with the raw registry list — the
    "Unknown agent 'unknown'" error users hit.

    When the requested agent is such a sentinel AND we have a ``thread_id``, the
    thread's most recent ``agent_run`` trace records the REAL agent that ran on
    it — recover from there before validating. Otherwise fall through to
    ``_validate_agent_name``, which now gives an actionable message for the
    sentinel instead of dumping the registry.
    """
    raw = (agent or "").strip()
    if raw.lower() not in _UNRESOLVED_AGENT_SENTINELS:
        return _validate_agent_name(raw)

    # Sentinel — try to recover the real agent from the run trace.
    if thread_id:
        try:
            from acb_graph import get_session  # noqa: PLC0415
            from sqlalchemy import text  # noqa: PLC0415

            with get_session() as s:
                rows = s.execute(
                    text(
                        "SELECT agent_name FROM agent_run "
                        "WHERE thread_id = :tid AND agent_name <> '' "
                        "ORDER BY started_at DESC LIMIT 10"
                    ),
                    {"tid": thread_id},
                ).fetchall()
            # Take the most recent trace whose agent is a REAL agent (skip any
            # sentinel that a prior run might itself have recorded). Filtering
            # in Python keeps the SQL free of expanding-bindparam subtleties.
            for r in rows:
                name = (r.agent_name or "").strip()
                if name and name.lower() not in _UNRESOLVED_AGENT_SENTINELS:
                    # Validate the recovered name (still guards against a stale
                    # trace pointing at a since-removed agent).
                    return _validate_agent_name(name)
        except Exception:  # noqa: BLE001 — fall through to the actionable error
            pass

    raise HTTPException(
        status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
        detail=(
            "This conversation isn't linked to an agent yet — please pick "
            "an agent to continue (the session's agent could not be resolved"
            f"{' from its history' if thread_id else ''})."
        ),
    )


# ---------------------------------------------------------------------------
# Webhook routing table
# Maps (source, event_type) → agent name.
# Phase 2: driven by each agent's config.json; here it is hard-coded for Phase 0.
# ---------------------------------------------------------------------------

_WEBHOOK_ROUTES: dict[tuple[str, str], str] = {
    ("clickup", "taskUpdated"): "task-manager",
    ("clickup", "taskCreated"): "task-manager",
    ("clickup", "taskDeleted"): "task-manager",
}


# ---------------------------------------------------------------------------
# Request model for registering a new agent
# ---------------------------------------------------------------------------

class RegisterAgentRequest(BaseModel):
    name: str
    """Unique slug, e.g. ``"my-agent"``."""
    description: str = ""
    repo_url: str = ""
    """GitHub repo as ``owner/repo`` or full ``https://github.com/owner/repo`` URL."""
    local_path: str | None = None
    """Absolute path to a local agent directory (dev mode).  Takes priority over repo_url."""
    tags: list[str] = []
    integrations: list[str] = []
    optional_integrations: list[str] = []


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------

@router.get("/config", summary="Fetch config.json from a GitHub agent repo or local path")
async def get_agent_config(
    repo: str,
    user: UserContext = Depends(get_current_user),
) -> dict:
    """Fetch and return the agent's config.json.

    ``repo`` may be:
    - ``owner/repo`` or ``https://github.com/owner/repo`` — fetched from GitHub
    - An absolute local path (``/path/to/dir`` or ``C:\\path\\to\\dir``) — read from disk

    Returns the parsed config dict, or raises 404 if not found.
    """
    import httpx  # noqa: PLC0415

    raw = repo.strip().rstrip("/")

    # ── Local path ─────────────────────────────────────────────────────────
    local = Path(raw)
    if local.is_absolute():
        # Resolve to prevent traversal tricks
        resolved = local.resolve()
        config_file = resolved / "config.json"
        if not resolved.is_dir():
            raise HTTPException(status_code=404, detail=f"Directory not found: {raw}")
        if not config_file.exists():
            raise HTTPException(status_code=404, detail="config.json not found in that directory.")
        try:
            return json.loads(config_file.read_text(encoding="utf-8"))
        except Exception:  # noqa: BLE001
            raise HTTPException(status_code=422, detail="config.json is not valid JSON.")

    # ── GitHub ──────────────────────────────────────────────────────────────
    slug = raw.removeprefix("https://github.com/").removeprefix("http://github.com/")

    settings = get_settings()
    headers: dict[str, str] = {"Accept": "application/vnd.github.raw+json"}
    token: str = getattr(settings, "github_token", "") or ""
    if token:
        headers["Authorization"] = f"token {token}"

    async with httpx.AsyncClient(timeout=8) as client:
        for branch in ("main", "master", "HEAD"):
            url = f"https://raw.githubusercontent.com/{slug}/{branch}/config.json"
            resp = await client.get(url, headers=headers)
            if resp.status_code == 200:
                try:
                    return resp.json()
                except Exception:  # noqa: BLE001
                    raise HTTPException(status_code=422, detail="config.json is not valid JSON.")

    raise HTTPException(
        status_code=404,
        detail=f"config.json not found in {slug!r} (tried main, master, HEAD).",
    )


@router.get("", summary="List all registered agents")
async def list_agents(
    user: UserContext = Depends(get_current_user),
) -> list[dict]:
    """Return the merged static + dynamic agent registry.

    Includes ``behind_by`` (int) for GitHub Copilot agents: the number of
    commits the local clone is behind the remote.  Zero or absent means
    up-to-date.  Non-blocking — git operations time out after 5 s.
    """
    dynamic = _load_dynamic_agents()
    dynamic_names = {a["name"] for a in dynamic}
    # Static agents not overridden by dynamic entries come first
    static = [a for a in _AGENT_REGISTRY if a["name"] not in dynamic_names]
    # Back-fill agent_runtime for legacy dynamic entries that predate the field
    # or have NULL in the DB column.  Rule: only entries registered FROM a
    # GitHub repo URL are "github-copilot"; everything else (local path,
    # unknown) is plain MAF.
    for a in dynamic:
        if not a.get("agent_runtime"):
            a["agent_runtime"] = (
                "github-copilot"
                if (a.get("repo_name") or a.get("repo_url"))
                and not a.get("local_path")
                else "maf"
            )
    merged = static + dynamic

    # Honor each agent's declared config.json runtime (authoritative over the
    # registration heuristic) so the picker groups MAF vs Copilot SDK by what
    # the agent actually is.  Covers static built-ins too (e.g. email-assistant
    # declares "runtime": "maf").  _load_dynamic_agents already applied this to
    # dynamic entries; re-applying here is idempotent and also fixes statics.
    for a in merged:
        rt = _declared_runtime(a["name"], a.get("local_path"))
        if rt:
            a["agent_runtime"] = rt

    # ── Git status: how many commits behind is each agent's clone? ─────
    settings = get_settings()
    agents_clone_dir = getattr(
        settings, "agents_clone_dir", "/tmp/acb_agents"
    )
    repos_root = Path(agents_clone_dir) / "repos"

    for a in merged:
        if a.get("agent_runtime") != "github-copilot":
            continue
        clone_path = repos_root / a["name"]
        if not (clone_path / ".git").is_dir():
            continue
        behind = await _git_behind_count(str(clone_path))
        if behind > 0:
            a["behind_by"] = behind

    # Attach dependency-install health so the agents page can warn about unmet
    # deps (and any apt/system packages a build needs).
    try:
        from acb_skills.loader import read_dep_status  # noqa: PLC0415
        from gateway.routes.workspace import \
            _agent_workspace_dir  # noqa: PLC0415
        for a in merged:
            try:
                ws = _agent_workspace_dir(a["name"])
                ds = read_dep_status(ws) if ws is not None else None
                if ds:
                    a["dep_status"] = ds
            except Exception:  # noqa: BLE001
                continue
    except Exception:  # noqa: BLE001
        pass

    return merged


@router.post("/{name}/pull", summary="Pull latest commits for an agent's local clone")
async def pull_agent(
    name: str,
    user: UserContext = Depends(get_current_user),
) -> dict:
    """Pull the latest commits from origin into the agent's local clone.

    Runs ``git pull --rebase`` (via ``_pull_latest``) so local pending
    commits are preserved on top of the updated remote.  Returns the
    before/after HEAD SHAs and how many commits were pulled.
    """
    import asyncio  # noqa: PLC0415

    agent_name = _validate_agent_name(name)
    settings = get_settings()
    agents_clone_dir = getattr(
        settings, "agents_clone_dir", "/tmp/acb_agents"
    )
    clone_path = Path(agents_clone_dir) / "repos" / agent_name

    if not (clone_path / ".git").is_dir():
        raise HTTPException(
            status_code=404,
            detail=f"No local clone found for {agent_name!r}. "
                   f"Run the agent once to create it.",
        )

    # Capture HEAD before pull
    head_before = ""
    try:
        proc = await asyncio.create_subprocess_exec(
            "git", "rev-parse", "HEAD",
            cwd=str(clone_path),
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
        )
        out, _ = await asyncio.wait_for(proc.communicate(), timeout=5)
        if proc.returncode == 0:
            head_before = out.decode(errors="replace").strip()
    except Exception:  # noqa: BLE001
        pass

    # Pull latest
    pull_info: dict[str, Any] = {"strategy": "skipped"}
    try:
        from acb_skills.loader import _pull_latest  # noqa: PLC0415
        pull_info = _pull_latest(clone_path)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(
            status_code=500,
            detail=f"git pull failed: {exc}",
        ) from exc

    # Capture HEAD after pull
    head_after = ""
    try:
        proc = await asyncio.create_subprocess_exec(
            "git", "rev-parse", "HEAD",
            cwd=str(clone_path),
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
        )
        out, _ = await asyncio.wait_for(proc.communicate(), timeout=5)
        if proc.returncode == 0:
            head_after = out.decode(errors="replace").strip()
    except Exception:  # noqa: BLE001
        pass

    # Count how many new commits were pulled
    pulled_count = 0
    if head_before and head_after and head_before != head_after:
        try:
            proc = await asyncio.create_subprocess_exec(
                "git", "rev-list", "--count",
                f"{head_before}..{head_after}",
                cwd=str(clone_path),
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.DEVNULL,
            )
            out, _ = await asyncio.wait_for(proc.communicate(), timeout=5)
            if proc.returncode == 0:
                pulled_count = int(
                    out.decode(errors="replace").strip() or "0"
                )
        except (ValueError, Exception):  # noqa: BLE001
            pass

    # Re-check behind_by for the response
    behind_after = await _git_behind_count(str(clone_path))

    _log.info(
        "agent.pulled",
        agent=agent_name,
        head_before=head_before[:8],
        head_after=head_after[:8],
        pulled=pulled_count,
        still_behind=behind_after,
        strategy=pull_info.get("strategy", "unknown"),
    )

    return {
        "agent": agent_name,
        "pulled": pulled_count,
        "behind_by": behind_after,
        "head_before": head_before[:8] if head_before else None,
        "head_after": head_after[:8] if head_after else None,
        "strategy": pull_info.get("strategy", "unknown"),
        "conflicts_resolved_by_llm": pull_info.get(
            "conflicts_resolved_by_llm", False
        ),
    }


@router.post("", status_code=status.HTTP_201_CREATED, summary="Register an agent from a GitHub repo")
async def register_agent(
    req: RegisterAgentRequest,
    background_tasks: BackgroundTasks,
    user: UserContext = Depends(get_current_user),
) -> dict:
    """Add a new agent to the dynamic registry and persist it to agents.json.

    Accepts either a GitHub URL (``repo_url``) or an absolute local directory
    path (``local_path``).  In both cases, if metadata fields are empty the
    endpoint reads ``config.json`` to fill them.  For GitHub repos a background
    git clone is also triggered so the agent is warm before its first run.
    """
    import httpx  # noqa: PLC0415

    # Validate name format
    if not re.match(r"^[a-z0-9][a-z0-9-]{0,48}[a-z0-9]$", req.name):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Agent name must be 2-50 lowercase letters, digits, or hyphens (no leading/trailing hyphens).",
        )

    dynamic = _load_dynamic_agents()
    all_names = {a["name"] for a in _AGENT_REGISTRY} | {a["name"] for a in dynamic}
    if req.name in all_names:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"Agent {req.name!r} is already registered.",
        )

    description = req.description or ""
    tags = req.tags or []
    integrations = req.integrations or []
    optional_integrations = req.optional_integrations or []

    # ── Determine source: local path or GitHub ──────────────────────────────
    local_path: str | None = None
    repo_url: str = (req.repo_url or "").strip().rstrip("/")
    repo_name: str = ""

    # Detect local path: req.local_path set, or repo_url is an absolute path
    raw_input = req.local_path or (repo_url if Path(repo_url).is_absolute() else None)
    if raw_input:
        resolved = Path(raw_input).resolve()
        if not resolved.is_dir():
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail=f"Local path does not exist: {raw_input}",
            )
        local_path = str(resolved)
        # Auto-read config.json from disk if metadata is missing
        if not description or not integrations:
            config_file = resolved / "config.json"
            if config_file.exists():
                try:
                    cfg: dict = json.loads(config_file.read_text(encoding="utf-8"))
                    description = description or cfg.get("description", "")
                    tags = tags or cfg.get("tags", [])
                    integrations = integrations or cfg.get("integrations", [])
                    optional_integrations = optional_integrations or cfg.get("optional_integrations", [])
                    _log.info("agent.config_read_local", name=req.name, path=local_path)
                except Exception as exc:  # noqa: BLE001
                    _log.warning("agent.config_parse_failed", name=req.name, error=str(exc))
    else:
        # GitHub URL
        repo_name = repo_url.removeprefix("https://github.com/").removeprefix("http://github.com/")
        if not description or not integrations:
            settings = get_settings()
            gh_token: str = getattr(settings, "github_token", "") or ""
            headers: dict[str, str] = {"Accept": "application/vnd.github.raw+json"}
            if gh_token:
                headers["Authorization"] = f"token {gh_token}"
            last_status: int = 0
            try:
                async with httpx.AsyncClient(timeout=8) as client:
                    cfg = {}
                    for branch in ("main", "master", "HEAD"):
                        url = (
                            "https://raw.githubusercontent.com"
                            f"/{repo_name}/{branch}/config.json"
                        )
                        resp = await client.get(url, headers=headers)
                        last_status = resp.status_code
                        if resp.status_code == 200:
                            try:
                                cfg = resp.json()
                            except Exception:  # noqa: BLE001
                                cfg = {}
                            break
                    if cfg:
                        description = description or cfg.get("description", "")
                        tags = tags or cfg.get("tags", [])
                        integrations = integrations or cfg.get(
                            "integrations", []
                        )
                        optional_integrations = (
                            optional_integrations
                            or cfg.get("optional_integrations", [])
                        )
                        _log.info(
                            "agent.config_fetched",
                            name=req.name,
                            repo=repo_name,
                        )
                    elif last_status in (403, 404):
                        _log.warning(
                            "agent.config_not_found_or_forbidden",
                            name=req.name,
                            repo=repo_name,
                            status=last_status,
                            hint=(
                                "Repo may be private or the GitHub token "
                                "may not have access to this organisation."
                            ),
                        )
            except Exception as exc:  # noqa: BLE001
                _log.warning(
                    "agent.config_fetch_failed",
                    name=req.name,
                    error=str(exc),
                )

    # agent_runtime: only agents registered FROM a GitHub repo URL run via the
    # GitHub Copilot SDK (GitHubCopilotAgent). Local-path agents are plain MAF.
    agent_runtime = "github-copilot" if (repo_name and not local_path) else "maf"

    entry: dict = {
        "name": req.name,
        "description": description,
        "tags": tags,
        "status": "live",
        "agent_runtime": agent_runtime,
        "repo_url": repo_url or None,
        "repo_name": repo_name or None,
        "local_path": local_path,
        "integrations": integrations,
        "optional_integrations": optional_integrations,
        "dynamic": True,
    }
    dynamic.append(entry)
    _save_dynamic_agents(dynamic)
    _log.info("agent.registered", name=req.name, actor=user.email, source="local" if local_path else "github")

    # Eager background clone — only for GitHub repos (local paths need no cloning)
    if not local_path and repo_name:
        def _eager_clone(agent_name: str, repo_slug: str) -> None:
            try:
                from acb_skills.loader import load_agent  # noqa: PLC0415

                # Pass the full org/repo slug — load_agent splits when needed
                with load_agent(agent_name, repo_name=repo_slug):
                    pass
                _log.info("agent.eager_clone_done", name=agent_name)
            except Exception as exc:  # noqa: BLE001
                _log.warning("agent.eager_clone_failed", name=agent_name, error=str(exc))

        background_tasks.add_task(_eager_clone, req.name, repo_name)

    return entry


def _cleanup_agent_workspace(agent_name: str) -> bool:
    """Delete the clone-cache directory for *agent_name*.

    Returns ``True`` if the directory existed and was removed, ``False``
    if it didn't exist.  Errors (permissions, etc.) are logged and swallowed
    so cleanup failures don't block the API response.
    """
    import shutil as _shutil  # noqa: PLC0415

    try:
        from acb_common import get_settings  # noqa: PLC0415
        settings = get_settings()
        clone_root = Path(
            getattr(settings, "agents_clone_dir", "/tmp/acb_agents")
        ) / "repos"
        target = clone_root / agent_name
        if target.is_dir():
            _shutil.rmtree(target, ignore_errors=True)
            _log.info(
                "agent.workspace_cleaned",
                name=agent_name,
                path=str(target),
            )
            return True
        return False
    except Exception as exc:
        _log.warning(
            "agent.workspace_cleanup_failed",
            name=agent_name,
            error=str(exc),
        )
        return False


@router.delete("/{name}", summary="Remove a user-registered agent")
async def remove_agent(
    name: str,
    user: UserContext = Depends(get_current_user),
) -> dict:
    """Delete a dynamic agent from the registry and clean up its workspace.

    Built-in agents cannot be removed.  The agent's clone directory on disk
    is also deleted so stale artifacts don't linger in the file browser.
    """
    if name in _KNOWN_AGENTS:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=f"Built-in agent {name!r} cannot be removed via the API.",
        )
    dynamic = _load_dynamic_agents()
    new_dynamic = [a for a in dynamic if a["name"] != name]
    if len(new_dynamic) == len(dynamic):
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Agent {name!r} not found.",
        )

    # ── Delete the DB row (not just stop upserting) ──────────────────
    try:
        from acb_graph import get_session  # noqa: PLC0415
        from sqlalchemy import text  # noqa: PLC0415
        with get_session() as s:
            s.execute(
                text("DELETE FROM dynamic_agents WHERE name = :n"),
                {"n": name},
            )
            s.commit()
    except Exception as exc:
        _log.warning(
            "agent.db_delete_failed",
            name=name,
            error=str(exc),
        )

    _save_dynamic_agents(new_dynamic)

    # ── Clean up workspace files on disk ─────────────────────────────
    import asyncio as _asyncio  # noqa: PLC0415
    await _asyncio.get_event_loop().run_in_executor(
        None, _cleanup_agent_workspace, name,
    )

    _log.info("agent.removed", name=name, actor=user.email)
    return {"deleted": name}


class PatchAgentRequest(BaseModel):
    description: str | None = None
    tags: list[str] | None = None
    integrations: list[str] | None = None
    optional_integrations: list[str] | None = None
    status: str | None = None


@router.patch("/{name}", summary="Update metadata for a user-registered agent")
async def patch_agent(
    name: str,
    req: PatchAgentRequest,
    user: UserContext = Depends(get_current_user),
) -> dict:
    """Partially update a dynamic agent's metadata.

    When an agent's status is changed from ``"live"`` to anything else,
    its workspace files on disk are automatically cleaned up so stale
    artifacts don't linger in the file browser.
    """
    if name in _KNOWN_AGENTS:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=f"Built-in agent {name!r} cannot be modified via the API.",
        )
    dynamic = _load_dynamic_agents()
    entry = next((a for a in dynamic if a["name"] == name), None)
    if entry is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Agent {name!r} not found.",
        )
    prev_status = entry.get("status", "live")
    if req.description is not None:
        entry["description"] = req.description
    if req.tags is not None:
        entry["tags"] = req.tags
    if req.integrations is not None:
        entry["integrations"] = req.integrations
    if req.optional_integrations is not None:
        entry["optional_integrations"] = req.optional_integrations
    if req.status is not None:
        entry["status"] = req.status
    _save_dynamic_agents(dynamic)

    # ── Clean up workspace when deactivating ─────────────────────────
    if (
        req.status is not None
        and prev_status == "live"
        and req.status != "live"
    ):
        import asyncio as _asyncio  # noqa: PLC0415
        await _asyncio.get_event_loop().run_in_executor(
            None, _cleanup_agent_workspace, name,
        )

    _log.info("agent.patched", name=name, actor=user.email)
    return entry


@router.post("/run/stream", summary="Stream a named agent run as AG-UI SSE events")
async def run_agent_stream_endpoint(
    req: AgentRunRequest,
    _request: Request,
    user: UserContext = Depends(get_current_user),
    background_tasks: BackgroundTasks = BackgroundTasks(),
) -> StreamingResponse:
    """Stream a named-agent run as AG-UI Server-Sent Events.

    Returns an ``text/event-stream`` response emitting AG-UI protocol events:
    ``RUN_STARTED``, ``TOOL_CALL_START``, ``TOOL_CALL_ARGS``, ``TOOL_CALL_RESULT``,
    ``TEXT_MESSAGE_CONTENT``, ``RUN_FINISHED`` / ``RUN_ERROR``.

    The Next.js ``/api/agent/chat`` route already knows how to translate this
    stream to the frontend SSE format — it is the same translation layer used
    for the orchestrator's ``/copilot/chat`` endpoint.

    Use this instead of ``POST /agent/run`` whenever the caller wants live
    tool-call visibility (e.g. the control-plane chat UI).
    """
    from orchestrator.executor import run_agent_stream  # noqa: PLC0415

    agent_name = _resolve_agent_for_run(req.agent, req.thread_id)
    run_id = req.run_id or str(uuid.uuid4())
    user_id: str = getattr(user, "email", "") or "anonymous"

    # ── Set user context for memory tools (remember / save_memory / etc.) ──
    try:
        from acb_skills.memory_tools import \
            _set_memory_user_id  # noqa: PLC0415
        _set_memory_user_id(user_id)
    except ImportError:
        pass

    # ── Memory enrichment: inject relevant past facts into the agent's context ──
    # Phase 4 (specs/llm_caching_memory.md): the assembled memory block is
    # cached per session (thread) in Redis so it stays byte-stable across turns
    # — otherwise Mem0's per-query semantic search returns a different block
    # every turn and defeats cross-turn prompt caching on the memory portion.
    _mem_thread_id = req.thread_id or f"{agent_name}:{run_id}"
    try:
        from acb_memory import (  # noqa: PLC0415
            get_memory_context,
            get_session_memory,
            search_entity_timeline,
        )
        user_msg = (
            req.payload.get("message")
            or req.payload.get("user_query")
            or ""
        )
        if user_msg and user_id != "anonymous":

            async def _build_memory_block() -> str:
                parts: list[str] = []
                # Mem0: episodic facts from past conversations
                mem_ctx = await get_memory_context(user_id, user_msg)
                if mem_ctx:
                    parts.append("## Memory from past conversations\n" + mem_ctx)
                # Graphiti: time-aware facts about entities in the query
                graph_ctx = await search_entity_timeline(user_msg[:80], user_msg)
                if graph_ctx:
                    parts.append(
                        "## Timeline facts from knowledge graph\n" + graph_ctx
                    )
                return "\n\n".join(parts)

            _redis = None
            try:
                from orchestrator.stream_relay import (  # noqa: PLC0415
                    _get_client,
                )
                _redis = await _get_client()
            except Exception:  # noqa: BLE001 — no Redis → fetch fresh each turn
                _redis = None

            memory_context = await get_session_memory(
                redis=_redis,
                thread_id=_mem_thread_id,
                build=_build_memory_block,
            )
            if memory_context:
                req.payload["memory_context"] = memory_context
                _log.debug(
                    "agent.memory_enriched",
                    agent=agent_name,
                    user=user_id[:20],
                )
    except ImportError:
        pass

    # ── Memory extraction: save conversation facts after the run completes ──
    # NOTE: Mem0 episodic extraction is handled by the Next.js route
    # (/api/agent/chat) which captures the FULL conversation INCLUDING the
    # assistant's response streamed back.  The gateway only has access to
    # the request payload (user messages + history) BEFORE the agent runs,
    # so a background task here would save an incomplete conversation and
    # produce poor-quality memory facts.
    #
    # Graphiti knowledge-graph ingestion is still done here because it
    # operates on entity mentions in the user's query — it doesn't need
    # the assistant's response.
    try:
        from acb_memory import add_episode  # noqa: PLC0415

        user_msg = req.payload.get("message") or ""
        if user_msg and user_id != "anonymous":
            background_tasks.add_task(
                add_episode,
                name=f"agent:{agent_name}:{user_id[:20]}",
                content=user_msg[:500],
                source_description=f"agent_{agent_name}",
                group_id=user_id,
            )
    except ImportError:
        pass

    _log.info("agent.stream_run_start", agent=agent_name, run_id=run_id, actor=user.email)

    # ── Detached execution (spec_stream_reconnection) ──────────────────────
    # The agent generator runs in a background task that pushes ALL events to
    # the per-thread Redis stream (executor self-tees via _sse).  This HTTP
    # response is merely a Redis subscriber: if the client disconnects,
    # uvicorn cancels the subscriber but the agent keeps running.  A
    # reconnecting client replays from its cursor via GET .../reconnect.
    from orchestrator.stream_relay import run_detached  # noqa: PLC0415

    from gateway.chat_fold import \
        persist_final_assistant_message  # noqa: PLC0415

    thread_id = req.thread_id or f"{agent_name}:{run_id}"

    # C2 — server-side history rebuild for non-chat callers. When the caller
    # sent no `messages` (an API/webhook client that doesn't keep a browser
    # store) but we have a thread_id, hand the executor's assembler a loader
    # that rebuilds history from the authoritative chat_message store — so
    # every caller gets the SAME context the browser client would. The browser
    # chat path keeps sending `messages`, so the loader is only consulted on the
    # empty-history case (see acb_llm.assemble_run_context).
    if req.thread_id and not (req.payload.get("messages") or []):
        _hist_uid = (user.email or "").strip() or "anonymous"

        def _load_history_from_store() -> list[dict[str, str]]:
            from gateway.routes.chat import _get_messages  # noqa: PLC0415
            rows = _get_messages(thread_id, _hist_uid, limit=50)
            return [
                {"role": str(r.get("role") or "user"),
                 "content": str(r.get("content") or "")}
                for r in rows
                if r.get("role") in ("user", "assistant")
                and str(r.get("content") or "").strip()
            ]

        req.payload["_history_loader"] = _load_history_from_store

    # Authoritative persistence at run end (core_loop_unification Phase 1):
    # the detached task folds the run's Redis event log into the chat_message
    # row this turn renders as — the tail survives even when the browser and
    # the Next translator are long gone (P0-3).
    _persist_message_id = (
        req.assistant_message_id or f"assistant-{thread_id}-{run_id}"
    )
    _mem_user = (user.email or "").strip()
    _mem_message = str(req.payload.get("message") or "")
    _mem_history = [
        {"role": str(m.get("role") or "user"), "content": str(m.get("content") or "")}
        for m in (req.payload.get("messages") or [])
        if isinstance(m, dict) and m.get("role") in ("user", "assistant")
        and m.get("content")
    ]

    async def _persist_on_complete() -> None:
        folded = await persist_final_assistant_message(
            thread_id, _persist_message_id,
            user_id=_mem_user, agent_name=agent_name,
            run_id=run_id, model=req.model,
        )
        # Memory extraction at the SAME run boundary (review P1-9): the Next
        # translator only extracted while its reader was alive, so turns
        # completed after a browser-gone/reconnect contributed nothing to
        # Mem0. The gateway is now the single extraction owner for this path
        # (route.ts no longer extracts for named agents). Best-effort.
        if not (_mem_user and folded):
            return
        try:
            from acb_memory import add_memories_background  # noqa: PLC0415

            from gateway.chat_fold import (  # noqa: PLC0415
                build_extraction_conversation,
            )
            conv = build_extraction_conversation(
                _mem_history, _mem_message, folded,
            )
            if conv:
                await add_memories_background(
                    _mem_user, conv, agent_id=agent_name,
                )
        except Exception:  # noqa: BLE001 — extraction must never kill the relay
            _log.warning("agent.run_end_memory_extraction_failed",
                         thread_id=thread_id[:12])

    agent_gen = run_agent_stream(
        agent_name,
        req.payload,
        run_id=run_id,
        thread_id=thread_id,
        model=req.model,
    )

    async def _serve():
        try:
            async for evt in run_detached(
                thread_id, agent_gen, tee=False,
                on_complete=_persist_on_complete,
            ):
                yield f"data: {json.dumps(evt)}\n\n"
        except Exception:  # noqa: BLE001
            from orchestrator.stream_relay import \
                get_detached_task  # noqa: PLC0415
            if get_detached_task(thread_id) is not None:
                # Drain task already owns the generator — losing the Redis
                # subscription mid-run must not double-consume it.  The run
                # continues in the background; the client can reconnect.
                _log.warning("agent.stream_subscribe_lost", agent=agent_name)
                return
            # Redis was unavailable from the start — degrade to direct
            # streaming with no relay (old behaviour).
            _log.warning("agent.stream_relay_unavailable", agent=agent_name)
            async for line in agent_gen:
                yield line

    return StreamingResponse(
        _serve(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "X-Accel-Buffering": "no",
            "Connection": "keep-alive",
        },
    )


@router.post(
    "/respond-input",
    summary="Answer a native ask_user prompt for a running agent",
)
async def respond_user_input(
    req: UserInputResponseRequest,
    user: UserContext = Depends(get_current_user),
) -> dict[str, Any]:
    """Resolve a pending ``ask_user`` request so the blocked agent resumes.

    The Copilot SDK's native ``ask_user`` tool blocks the agent turn on an
    ``on_user_input_request`` handler.  That handler emitted a
    ``user_input_requested`` SSE frame carrying a ``request_id`` and is now
    parked on a Future.  The frontend POSTs the user's answer here to unblock
    it — the agent continues in the SAME run/stream, so the answer is never
    queued as a separate chat message.
    """
    from orchestrator.executor import resolve_user_input  # noqa: PLC0415

    # Fast path: the run is parked on THIS worker — resolve its Future inline.
    delivered = resolve_user_input(
        req.request_id, req.answer, req.was_freeform
    )
    # Cross-worker (P1-2): the run may be parked on another worker.  Relay the
    # answer over the control bus so the owning worker resolves its own Future.
    if not delivered and req.thread_id:
        from orchestrator.stream_relay import dispatch_control  # noqa: PLC0415

        delivered = await dispatch_control(
            req.thread_id,
            {
                "cmd": "respond_input",
                "request_id": req.request_id,
                "answer": req.answer,
                "was_freeform": req.was_freeform,
            },
        )
    if not delivered:
        # The run may have ended or the request id is stale.
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="No pending question matches that request_id "
            "(the run may have already finished).",
        )
    _log.info("agent.user_input_resolved", request_id=req.request_id[:12])
    return {"ok": True}


@router.get(
    "/run/{thread_id}/reconnect",
    summary="Reconnect to a running (or recently finished) agent stream",
)
async def reconnect_agent_stream(
    thread_id: str,
    since: str = "0-0",
    user: UserContext = Depends(get_current_user),
) -> StreamingResponse:
    """Replay missed SSE events and subscribe to live ones.

    Called by the frontend after a page refresh or reconnect to catch up
    on everything the agent did while the browser was closed.  If the agent
    is still running, the stream continues with live events after replay.

    Query params:
        since:  Redis stream ID to replay FROM (exclusive).
                Default ``"0-0"`` replays everything.

    Returns ``text/event-stream`` with the same AG-UI event format as
    ``POST /agent/run/stream``.

    Falls back to an empty ``"done"`` event if the stream has expired.
    """
    import asyncio as _asyncio
    import json as _json

    from orchestrator.stream_relay import is_active  # noqa: PLC0415
    from orchestrator.stream_relay import (replay_events, stream_exists,
                                           subscribe_events)

    # Ownership guard (same policy as cancel): the replayed stream contains the
    # whole conversation — text, tool args, reasoning — so it must never be
    # readable across users. Block only when the session exists AND belongs to
    # a different user; ephemeral/legacy threads (no row) stay reachable.
    actor = getattr(user, "email", None) or "default"
    if not await _asyncio.to_thread(_thread_owner_ok, thread_id, actor):
        raise HTTPException(status_code=403, detail="Not your conversation")

    _log.info(
        "agent.reconnect_request",
        thread_id=thread_id[:12],
        since=since[:20],
        actor=actor[:20],
    )

    async def _event_generator():
        # Phase 1: Replay missed events.
        # Local _stream_id values (e.g. "local-1718123456789-5#42") are minted
        # by the executor for the initial SSE stream (before the Redis entry ID
        # is known).  Redis XREAD doesn't understand them, so fall back to
        # "0-0".  Streams are reset per run (mark_active(reset=True)), so a
        # full replay covers exactly the current run, and the frontend clears
        # its partial message before replay (deltas have no id-dedup, so
        # re-appending would double text) — full replay is the SAFE default.
        #
        # P1-5 note: the trailing "#<n>" ordinal on a local cursor is a real
        # per-thread emit count (stream is reset per run; events push in
        # emission order), so a future client that PRESERVES its partial could
        # resume by skipping the first <n> entries. That optimisation is gated
        # on client-side delta de-duplication + a UI drive to prove no doubling
        # (see core_loop_unification §D1 follow-ups); the plumbing is in place.
        _since = since
        if _since.startswith("local-"):
            _since = "0-0"

        # Track the replay cursor so Phase 2 subscribes from the exact spot —
        # subscribing from "$" would silently drop any events pushed between
        # replay end and subscribe start.
        _cursor = _since
        if await stream_exists(thread_id):
            # Drain in batches until exhausted — a single 500-event read would
            # silently truncate the tail of long, tool-heavy runs on reconnect.
            while True:
                missed = await replay_events(thread_id, since_id=_cursor, count=500)
                if not missed:
                    break
                for evt in missed:
                    _eid = evt.get("_stream_id")
                    if _eid:
                        _cursor = _eid
                    yield f"data: {_json.dumps(evt)}\n\n"
                if len(missed) < 500:
                    break

        # Phase 2: If agent is still active, subscribe to live events from
        # the cursor (no gap with Phase 1).
        if await is_active(thread_id):
            async for evt in subscribe_events(thread_id, since_id=_cursor):
                yield f"data: {_json.dumps(evt)}\n\n"
        else:
            # Agent finished — emit RUN_FINISHED so the frontend translator
            # (translateAndPersistStream) maps it to {"type":"done"} and the
            # UI exits the reconnecting state.
            yield f"data: {_json.dumps({'type': 'RUN_FINISHED', 'runId': thread_id, 'threadId': thread_id})}\n\n"

    return StreamingResponse(
        _event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "X-Accel-Buffering": "no",
            "Connection": "keep-alive",
        },
    )


def _thread_owner_ok(thread_id: str, user_id: str) -> bool:
    """True if *thread_id* is owned by *user_id* OR not a persisted session.

    Permissive by design: returns True when the session row is absent
    (ephemeral / legacy thread) or on any DB error, so legitimate cancels are
    never blocked.  Returns False only when the session exists for a DIFFERENT
    user.
    """
    try:
        from acb_graph import get_session  # noqa: PLC0415
        from sqlalchemy import text  # noqa: PLC0415
        with get_session() as s:
            row = s.execute(
                text("SELECT user_id FROM chat_session WHERE id = :id"),
                {"id": thread_id},
            ).first()
        if row is None:
            return True
        return row.user_id == user_id
    except Exception:  # noqa: BLE001
        return True


@router.post(
    "/run/{thread_id}/cancel",
    summary="Cancel a running agent (actually stops backend execution)",
)
async def cancel_agent_run(
    thread_id: str,
    user: UserContext = Depends(get_current_user),
) -> dict:
    """Stop the in-flight agent run for *thread_id*.

    Unlike simply dropping the SSE connection (which leaves the agent running
    detached in the background, continuing to burn tokens and write files),
    this cancels the background task, marks the thread inactive, and pushes a
    terminal RUN_FINISHED event so any live/reconnecting subscribers close.

    Works for any runtime (MAF / Copilot SDK) because cancellation happens at
    the detached-task layer that wraps every agent generator.
    """
    import asyncio  # noqa: PLC0415

    from orchestrator.stream_relay import cancel_run  # noqa: PLC0415

    # Ownership guard: a thread_id maps to a chat_session.  Block only when the
    # session exists AND belongs to a different user (prevents one user
    # cancelling another's run).  Allow when not found (ephemeral/legacy thread)
    # or on DB hiccup, so legitimate cancels never get stuck.
    actor = getattr(user, "email", None) or "default"
    if not await asyncio.to_thread(_thread_owner_ok, thread_id, actor):
        raise HTTPException(status_code=403, detail="Not your conversation")

    _log.info(
        "agent.cancel_request",
        thread_id=thread_id[:12],
        actor=actor[:20],
    )
    cancelled = await cancel_run(thread_id)
    return {"ok": True, "cancelled": cancelled, "threadId": thread_id}


@router.post("/run", response_model=AgentRunResponse)
async def run_agent_sync(
    req: AgentRunRequest,
    user: UserContext = Depends(get_current_user),
) -> AgentRunResponse:
    """Synchronously run a named agent and return the final state.

    Use this for interactive queries where the caller can wait.
    For long-running background tasks prefer ``POST /agent/run/async``.
    """
    from orchestrator.executor import AgentRunError, run_agent  # noqa: PLC0415

    agent = _resolve_agent_for_run(req.agent, req.thread_id)
    run_id = req.run_id or str(uuid.uuid4())

    try:
        final_state = await run_agent(
            agent,
            req.payload,
            run_id=run_id,
            thread_id=req.thread_id,
            model=req.model,
        )
        return AgentRunResponse(
            run_id=run_id,
            agent=agent,
            status="completed",
            result=final_state.get("result"),
        )
    except AgentRunError as exc:
        return AgentRunResponse(
            run_id=run_id,
            agent=agent,
            status="failed",
            error=str(exc.original),
            mutation_pr=exc.mutation_pr,
        )


@router.post("/run/async", status_code=status.HTTP_202_ACCEPTED)
async def run_agent_async(
    req: AgentRunRequest,
    background_tasks: BackgroundTasks,
    user: UserContext = Depends(get_current_user),
) -> dict[str, str]:
    """Enqueue an agent run and return ``run_id`` immediately (202 Accepted).

    The run executes as a FastAPI background task.  Poll
    ``GET /agent/run/{run_id}/status`` for progress.
    """
    from orchestrator.executor import run_agent  # noqa: PLC0415

    agent = _resolve_agent_for_run(req.agent, req.thread_id)
    run_id = req.run_id or str(uuid.uuid4())

    async def _run() -> None:
        try:
            await run_agent(agent, req.payload, run_id=run_id,
                            thread_id=req.thread_id, model=req.model)
        except Exception as exc:  # noqa: BLE001
            _log.error(
                "agent.async_run_error",
                run_id=run_id,
                agent=agent,
                error=str(exc),
            )

    background_tasks.add_task(_run)
    return {"run_id": run_id, "status": "queued", "agent": agent}


@router.get("/run/{run_id}/status")
async def get_run_status(
    run_id: str,
    user: UserContext = Depends(get_current_user),
) -> dict[str, Any]:
    """Return the latest recorded status for a given run.

    Queries the audit_event table for agent_run_start / agent_run_complete events
    matching the run_id.  LangGraph PostgresSaver removed in WBS 0.7.
    """
    try:
        from acb_graph import get_session  # noqa: PLC0415
        from sqlalchemy import text  # noqa: PLC0415

        with get_session() as sess:
            result = sess.execute(
                text(
                    "SELECT action, at FROM audit_event "
                    "WHERE payload->>'run_id' = :run_id "
                    "ORDER BY at DESC LIMIT 10"
                ),
                {"run_id": run_id},
            )
            events = [{"action": r.action, "at": str(r.at)} for r in result]

        if not events:
            return {"run_id": run_id, "status": "not_found"}
        actions = {e["action"] for e in events}
        if "agent_run_complete" in actions:
            status_str = "completed"
        elif "agent_run_error" in actions:
            status_str = "failed"
        else:
            status_str = "running"
        return {"run_id": run_id, "status": status_str, "events": events}
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@router.get("/mutations")
async def list_mutations(
    limit: int = 50,
    user: UserContext = Depends(get_current_user),
) -> list[dict[str, Any]]:
    """Return recent self-mutation events for the Control Plane HITL queue.

    Returns a merged view of:
    - ``pending_commit`` rows (commit-gate flow, M2.7) with full status info
    - ``audit_event`` rows from legacy sandbox failures (for observability)

    Items are sorted newest-first.
    """
    try:
        from acb_graph import get_session  # noqa: PLC0415
        from sqlalchemy import text  # noqa: PLC0415

        rows: list[dict[str, Any]] = []

        with get_session() as sess:
            # 1. Pending commits (primary HITL queue)
            pc_result = sess.execute(
                text(
                    "SELECT id, agent_name, run_id, commit_sha, commit_message, "
                    "       test_summary, status, reviewed_by, reviewed_at, created_at "
                    "FROM pending_commit "
                    "ORDER BY created_at DESC LIMIT :limit"
                ),
                {"limit": max(1, min(limit, 200))},
            )
            for r in pc_result:
                rows.append(
                    {
                        "type": "pending_commit",
                        "id": str(r.id),
                        "agent": r.agent_name,
                        "run_id": r.run_id,
                        "commit_sha": r.commit_sha,
                        "commit_message": r.commit_message,
                        "test_summary": r.test_summary,
                        "status": r.status,
                        "reviewed_by": r.reviewed_by,
                        "reviewed_at": str(r.reviewed_at) if r.reviewed_at else None,
                        "at": str(r.created_at),
                        # approve / reject links for the Control Plane UI
                        "approve_url": f"/agent/mutations/pending/{r.id}/approve",
                        "reject_url": f"/agent/mutations/pending/{r.id}/reject",
                        "diff_url": f"/agent/mutations/pending/{r.id}/diff",
                    }
                )

            # 2. Legacy audit events (sandbox failures / older runs)
            ae_result = sess.execute(
                text(
                    "SELECT action, target, at, payload FROM audit_event "
                    "WHERE actor = 'system:mutation' "
                    "ORDER BY at DESC LIMIT :limit"
                ),
                {"limit": max(1, min(limit, 200))},
            )
            for r in ae_result:
                payload = r.payload if isinstance(r.payload, dict) else {}
                # Skip audit events that correspond to a pending_commit row
                # already in the list above (they share the run_id)
                rows.append(
                    {
                        "type": "audit_event",
                        "agent": str(r.target).removeprefix("agent:"),
                        "at": str(r.at),
                        "run_id": payload.get("run_id"),
                        "commit_sha": payload.get("commit_sha"),
                        "pending_commit_id": payload.get("pending_commit_id"),
                        "test_summary": payload.get("test_summary"),
                        "status": (
                            "commit_pending"
                            if r.action == "mutation_commit_pending"
                            else "commit_pending"
                            if r.action == "mutation_eval_failed"
                            else "failed"
                            if r.action == "mutation_sandbox_failed"
                            else "started"
                            if r.action == "mutation_start"
                            else r.action
                        ),
                    }
                )

        # Sort by timestamp descending (pending_commit.created_at, audit_event.at)
        rows.sort(key=lambda x: x.get("at", ""), reverse=True)
        return rows[:limit]
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=str(exc)) from exc


# ---------------------------------------------------------------------------
# Pending commit HITL endpoints (commit-gate flow — M2.7)
# ---------------------------------------------------------------------------# ---------------------------------------------------------------------------
# Pending commit HITL endpoints (commit-gate flow — M2.7)
# ---------------------------------------------------------------------------

@router.get("/mutations/pending")
async def list_pending_commits(
    limit: int = 50,
    user: UserContext = Depends(get_current_user),
) -> list[dict[str, Any]]:
    """Return pending commit rows for the inbox (unreviewed agent self-fixes)."""
    try:
        from acb_graph import get_session  # noqa: PLC0415
        from sqlalchemy import text  # noqa: PLC0415

        with get_session() as sess:
            result = sess.execute(
                text(
                    "SELECT id, agent_name, run_id, commit_sha, commit_message, "
                    "       test_summary, status, reviewed_by, reviewed_at, created_at "
                    "FROM pending_commit "
                    "ORDER BY created_at DESC LIMIT :limit"
                ),
                {"limit": max(1, min(limit, 200))},
            )
            rows = []
            for r in result:
                rows.append(
                    {
                        "id": str(r.id),
                        "agent_name": r.agent_name,
                        "run_id": r.run_id,
                        "commit_sha": r.commit_sha,
                        "commit_message": r.commit_message,
                        "test_summary": r.test_summary,
                        "status": r.status,
                        "reviewed_by": r.reviewed_by,
                        "reviewed_at": str(r.reviewed_at) if r.reviewed_at else None,
                        "created_at": str(r.created_at),
                    }
                )
        return rows
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@router.get("/mutations/pending/{commit_id}/diff")
async def get_pending_commit_diff(
    commit_id: str,
    user: UserContext = Depends(get_current_user),
) -> dict[str, Any]:
    """Return the unified diff stored for a pending commit (for inline review)."""
    try:
        from acb_graph import get_session  # noqa: PLC0415
        from sqlalchemy import text  # noqa: PLC0415

        with get_session() as sess:
            result = sess.execute(
                text(
                    "SELECT id, agent_name, commit_sha, commit_message, "
                    "       diff_text, test_summary, status FROM pending_commit "
                    "WHERE id = :id"
                ),
                {"id": commit_id},
            )
            row = result.fetchone()
        if row is None:
            raise HTTPException(status_code=404, detail="pending commit not found")
        return {
            "id": str(row.id),
            "agent_name": row.agent_name,
            "commit_sha": row.commit_sha,
            "commit_message": row.commit_message,
            "diff_text": row.diff_text,
            "test_summary": row.test_summary,
            "status": row.status,
        }
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@router.post(
    "/mutations/pending/{commit_id}/approve", status_code=200,
    dependencies=[Depends(require_internal_auth)],
)
async def approve_pending_commit(
    commit_id: str,
    user: UserContext = Depends(get_current_user),
) -> dict[str, Any]:
    """Approve a pending commit: push it to origin/HEAD from the local clone.

    Pushes the commit that the mutation sandbox staged locally.  On success
    the row status is set to ``approved``.  Merge conflicts are resolved
    automatically by ``git push --force-with-lease`` from the authenticated
    clone (the sandbox always commits on top of the current HEAD; conflicts
    would only arise if another push landed between sandbox commit and approval,
    in which case we rebase and push).
    """
    import asyncio  # noqa: PLC0415

    from acb_audit import AuditEvent, record  # noqa: PLC0415

    try:
        from acb_graph import get_session  # noqa: PLC0415
        from sqlalchemy import text  # noqa: PLC0415

        # Fetch the row
        with get_session() as sess:
            result = sess.execute(
                text(
                    "SELECT id, agent_name, run_id, local_clone_dir, commit_sha, "
                    "       commit_message, status FROM pending_commit WHERE id = :id"
                ),
                {"id": commit_id},
            )
            row = result.fetchone()

        if row is None:
            raise HTTPException(status_code=404, detail="pending commit not found")
        if row.status not in ("pending", "eval_failed"):
            raise HTTPException(
                status_code=409,
                detail=f"commit is already {row.status}",
            )

        commit_sha: str = row.commit_sha
        clone_dir: str = row.local_clone_dir

        # Verify the commit exists in the local clone before trying to push.
        verify = await asyncio.create_subprocess_exec(
            "git", "cat-file", "-t", commit_sha,
            cwd=clone_dir,
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.DEVNULL,
        )
        await verify.communicate()
        if verify.returncode != 0:
            raise HTTPException(
                status_code=422,
                detail=f"commit {commit_sha[:8]} not found in local clone at {clone_dir}",
            )

        # Find the local branch that contains the commit and check it out.
        # This avoids a detached HEAD state which breaks `git push origin HEAD`.
        # Push only up to this specific commit (not the full branch tip) so that
        # approving an earlier commit in a chain doesn't push unapproved later ones.
        branch_proc = await asyncio.create_subprocess_exec(
            "git", "branch", "--contains", commit_sha, "--format=%(refname:short)",
            cwd=clone_dir,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
        )
        branch_out, _ = await branch_proc.communicate()
        local_branch = branch_out.decode(errors="replace").strip().splitlines()[0].strip() if branch_out else "main"
        if not local_branch:
            local_branch = "main"
        await _git_exec(clone_dir, ["checkout", local_branch])

        # Detect local-only repos (no remote origin).  For these, approval
        # simply keeps the commit — there is no remote to push to.
        remote_proc = await asyncio.create_subprocess_exec(
            "git", "remote", "get-url", "origin",
            cwd=clone_dir,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
        )
        await remote_proc.communicate()
        has_remote = remote_proc.returncode == 0

        new_sha: str | None = None
        if has_remote:
            # Push.  If the fast-forward fails, rebase and retry.
            push_ok, new_sha = await _git_push_with_rebase(clone_dir, commit_sha)
            if not push_ok:
                raise HTTPException(
                    status_code=500,
                    detail="git push failed after rebase — check gateway logs",
                )
            # If rebase changed the commit SHA, update it in the DB so the
            # row stays consistent (diff URL, cascade, and future audits
            # all reference this SHA).
            effective_sha = new_sha or commit_sha
            _log.info("mutation.commit_pushed",
                      agent=row.agent_name, commit_sha=effective_sha[:8])
        else:
            effective_sha = commit_sha
            _log.info(
                "mutation.commit_kept_local",
                agent=row.agent_name,
                commit_sha=effective_sha[:8],
                hint="Local-only repo — no remote to push to. Commit kept.",
            )

        reviewer = getattr(user, "sub", None) or getattr(user, "email", "unknown")
        with get_session() as sess:
            update_sql = (
                "UPDATE pending_commit "
                "SET status = 'approved', reviewed_by = :by, reviewed_at = now()"
            )
            params: dict = {"id": commit_id, "by": reviewer}
            if new_sha and new_sha != commit_sha:
                update_sql += ", commit_sha = :new_sha"
                params["new_sha"] = new_sha
            update_sql += " WHERE id = :id"
            sess.execute(text(update_sql), params)
            sess.commit()

        # ── Cascade: auto-approve any other pending commits for the same agent
        # that are ancestors of the approved commit.  These were all pushed to
        # the remote as part of the same push (git sends all commits between
        # origin/<branch> and HEAD in one push).
        cascade_ids: list[str] = []
        try:
            with get_session() as sess:
                others = sess.execute(
                    text(
                        "SELECT id, commit_sha FROM pending_commit "
                        "WHERE agent_name = :agent AND id != :id "
                        "AND status IN ('pending', 'eval_failed')"
                    ),
                    {"agent": row.agent_name, "id": commit_id},
                ).fetchall()

            for other in others:
                # is_ancestor returns 0 when other_sha IS an ancestor
                # of the effective (post-rebase) SHA
                anc_proc = await asyncio.create_subprocess_exec(
                    "git", "merge-base", "--is-ancestor",
                    other.commit_sha, effective_sha,
                    cwd=clone_dir,
                    stdout=asyncio.subprocess.DEVNULL,
                    stderr=asyncio.subprocess.DEVNULL,
                )
                await anc_proc.communicate()
                if anc_proc.returncode == 0:
                    cascade_ids.append(str(other.id))

            if cascade_ids:
                with get_session() as sess:
                    sess.execute(
                        text(
                            "UPDATE pending_commit "
                            "SET status = 'approved',"
                            " reviewed_by = :by, reviewed_at = now() "
                            "WHERE id = ANY(:ids)"
                        ),
                        {"by": f"cascade:{reviewer}", "ids": cascade_ids},
                    )
                    sess.commit()
                _log.info(
                    "mutation.cascade_approved",
                    agent=row.agent_name,
                    approved_sha=effective_sha,
                    cascade_count=len(cascade_ids),
                )
        except Exception as _cascade_exc:  # noqa: BLE001
            # Non-fatal — the primary commit is already approved
            _log.warning("mutation.cascade_failed", error=str(_cascade_exc))

        record(
            AuditEvent(
                actor=f"human:{reviewer}",
                action="mutation_commit_approved",
                target=f"agent:{row.agent_name}",
                payload={
                    "pending_commit_id": commit_id,
                    "commit_sha": effective_sha,
                    "run_id": row.run_id,
                },
            )
        )
        _log.info(
            "mutation.commit_approved",
            agent=row.agent_name,
            commit_sha=effective_sha,
            reviewer=reviewer,
            cascade=len(cascade_ids),
        )
        return {
            "status": "approved",
            "commit_sha": effective_sha,
            "cascade_approved": len(cascade_ids),
        }

    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@router.post(
    "/mutations/pending/{commit_id}/reject", status_code=200,
    dependencies=[Depends(require_internal_auth)],
)
async def reject_pending_commit(
    commit_id: str,
    user: UserContext = Depends(get_current_user),
) -> dict[str, Any]:
    """Reject a pending commit: drop it from the local clone with git reset HEAD~1.

    The commit is undone locally so the clone is clean for the next mutation
    attempt.  The row status is set to ``rejected``.
    """
    import asyncio  # noqa: PLC0415

    from acb_audit import AuditEvent, record  # noqa: PLC0415

    try:
        from acb_graph import get_session  # noqa: PLC0415
        from sqlalchemy import text  # noqa: PLC0415

        with get_session() as sess:
            result = sess.execute(
                text(
                    "SELECT id, agent_name, run_id, local_clone_dir, commit_sha, status "
                    "FROM pending_commit WHERE id = :id"
                ),
                {"id": commit_id},
            )
            row = result.fetchone()

        if row is None:
            raise HTTPException(status_code=404, detail="pending commit not found")
        if row.status not in ("pending", "eval_failed"):
            raise HTTPException(status_code=409, detail=f"commit is already {row.status}")

        clone_dir: str = row.local_clone_dir
        commit_sha: str = row.commit_sha

        # Reset HEAD~1 only if HEAD is still the mutation commit (safety check)
        head_proc = await asyncio.create_subprocess_exec(
            "git", "rev-parse", "HEAD",
            cwd=clone_dir,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
        )
        head_out, _ = await head_proc.communicate()
        head_sha = head_out.decode().strip()
        if head_sha == commit_sha:
            await _git_exec(clone_dir, ["reset", "HEAD~1", "--mixed"])

        reviewer = getattr(user, "sub", None) or getattr(user, "email", "unknown")
        with get_session() as sess:
            sess.execute(
                text(
                    "UPDATE pending_commit "
                    "SET status = 'rejected', reviewed_by = :by, reviewed_at = now() "
                    "WHERE id = :id"
                ),
                {"id": commit_id, "by": reviewer},
            )
            sess.commit()

        record(
            AuditEvent(
                actor=f"human:{reviewer}",
                action="mutation_commit_rejected",
                target=f"agent:{row.agent_name}",
                payload={
                    "pending_commit_id": commit_id,
                    "commit_sha": commit_sha,
                    "run_id": row.run_id,
                },
            )
        )
        _log.info(
            "mutation.commit_rejected",
            agent=row.agent_name,
            commit_sha=commit_sha,
            reviewer=reviewer,
        )
        return {"status": "rejected", "commit_sha": commit_sha}

    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@router.post(
    "/mutations/pending/{commit_id}/remutate", status_code=200,
    dependencies=[Depends(require_internal_auth)],
)
async def remutate_pending_commit(
    commit_id: str,
    user: UserContext = Depends(get_current_user),
) -> dict[str, Any]:
    """Re-mutate an eval_failed commit: reset the local clone and clear the row.

    This is the "try again" action for commits where tests failed.  It:
    1. Resets the local clone with ``git reset HEAD~1 --mixed`` so the
       working tree is clean for a fresh mutation attempt.
    2. Marks the row as ``rejected`` (with reviewed_by = 'system:remutate').

    The next time the same agent fails at runtime a new mutation will be
    triggered automatically (max_mutation_attempts = 1 per *run*, so a fresh
    run resets the counter).  To manually trigger, re-run the agent from chat.
    """
    import asyncio  # noqa: PLC0415

    from acb_audit import AuditEvent, record  # noqa: PLC0415

    try:
        from acb_graph import get_session  # noqa: PLC0415
        from sqlalchemy import text  # noqa: PLC0415

        with get_session() as sess:
            result = sess.execute(
                text(
                    "SELECT id, agent_name, run_id, local_clone_dir, commit_sha, status "
                    "FROM pending_commit WHERE id = :id"
                ),
                {"id": commit_id},
            )
            row = result.fetchone()

        if row is None:
            raise HTTPException(status_code=404, detail="pending commit not found")
        if row.status not in ("eval_failed", "pending"):
            raise HTTPException(status_code=409, detail=f"commit is already {row.status}")

        clone_dir: str = row.local_clone_dir
        commit_sha: str = row.commit_sha

        # Only reset if HEAD is still the mutation commit (safety check)
        head_proc = await asyncio.create_subprocess_exec(
            "git", "rev-parse", "HEAD",
            cwd=clone_dir,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
        )
        head_out, _ = await head_proc.communicate()
        head_sha = head_out.decode().strip()
        if head_sha == commit_sha:
            await _git_exec(clone_dir, ["reset", "HEAD~1", "--mixed"])

        reviewer = getattr(user, "sub", None) or getattr(user, "email", "unknown")
        with get_session() as sess:
            sess.execute(
                text(
                    "UPDATE pending_commit "
                    "SET status = 'rejected', reviewed_by = 'system:remutate', reviewed_at = now() "
                    "WHERE id = :id"
                ),
                {"id": commit_id},
            )
            sess.commit()

        record(
            AuditEvent(
                actor=f"human:{reviewer}",
                action="mutation_commit_remutate_requested",
                target=f"agent:{row.agent_name}",
                payload={
                    "pending_commit_id": commit_id,
                    "commit_sha": commit_sha,
                    "run_id": row.run_id,
                },
            )
        )
        _log.info(
            "mutation.remutate_requested",
            agent=row.agent_name,
            commit_sha=commit_sha,
            by=reviewer,
        )
        return {
            "status": "reset",
            "commit_sha": commit_sha,
            "message": (
                "Commit cleared from local clone. "
                "Trigger a fresh agent run to attempt a new fix."
            ),
        }

    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@router.delete(
    "/mutations/pending/{commit_id}", status_code=200,
    dependencies=[Depends(require_internal_auth)],
)
async def delete_pending_commit(
    commit_id: str,
    user: UserContext = Depends(get_current_user),
) -> dict[str, Any]:
    """Delete a pending_commit row regardless of status.

    Used by the UI X button to clear any commit entry (pending, approved,
    rejected, failed) from the agent card view.
    """
    try:
        from acb_graph import get_session  # noqa: PLC0415
        from sqlalchemy import text  # noqa: PLC0415

        reviewer = getattr(user, "sub", None) or getattr(user, "email", "unknown")
        with get_session() as sess:
            result = sess.execute(
                text("DELETE FROM pending_commit WHERE id = :id"),
                {"id": commit_id},
            )
            deleted = result.rowcount
            sess.commit()

        _log.info("mutation.commit_deleted", commit_id=commit_id, rows=deleted, by=reviewer)
        return {"deleted": commit_id, "rows_deleted": deleted}

    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@router.delete(
    "/mutations/audit/{run_id}", status_code=200,
    dependencies=[Depends(require_internal_auth)],
)
async def dismiss_mutation_event(
    run_id: str,
    user: UserContext = Depends(get_current_user),
) -> dict[str, Any]:
    """Remove failed mutation audit_event rows for a given run_id from the inbox.

    Only affects rows where actor = 'system:mutation' so human-created audit
    records are never touched.  Non-fatal if run_id not found.
    """
    try:
        from acb_graph import get_session  # noqa: PLC0415
        from sqlalchemy import text  # noqa: PLC0415

        reviewer = getattr(user, "sub", None) or getattr(user, "email", "unknown")
        with get_session() as sess:
            result = sess.execute(
                text(
                    "DELETE FROM audit_event "
                    "WHERE actor = 'system:mutation' "
                    "AND payload->>'run_id' = :run_id"
                ),
                {"run_id": run_id},
            )
            deleted = result.rowcount
            sess.commit()

        _log.info("mutation.audit_dismissed", run_id=run_id, rows=deleted, by=reviewer)
        return {"dismissed": run_id, "rows_deleted": deleted}

    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=str(exc)) from exc


# ---------------------------------------------------------------------------
# Git helpers for the approve endpoint
# ---------------------------------------------------------------------------

async def _git_behind_count(clone_dir: str) -> int:
    """Return how many commits the local clone is behind origin/HEAD.

    Runs ``git fetch`` first (5 s timeout) to get the latest remote state,
    then ``git rev-list --count HEAD..origin/HEAD``.

    Returns 0 on any error (clone missing, no remote, fetch timeout, etc.)
    so the UI never breaks on a stale count.
    """
    import asyncio  # noqa: PLC0415

    # Quick check: does this clone even have a remote?
    rc = await _git_exec(clone_dir, ["remote", "get-url", "origin"])
    if rc != 0:
        return 0

    # Fetch latest (short timeout — non-blocking for the UI)
    try:
        fetch_proc = await asyncio.create_subprocess_exec(
            "git", "fetch", "origin",
            cwd=clone_dir,
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.DEVNULL,
        )
        await asyncio.wait_for(fetch_proc.communicate(), timeout=5)
    except (TimeoutError, Exception):
        return 0  # fetch timed out — return 0, don't block the response

    # Count commits we're behind
    try:
        proc = await asyncio.create_subprocess_exec(
            "git", "rev-list", "--count", "HEAD..origin/HEAD",
            cwd=clone_dir,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
        )
        out, _ = await asyncio.wait_for(proc.communicate(), timeout=5)
        if proc.returncode == 0:
            return int(out.decode(errors="replace").strip() or "0")
    except (ValueError, TimeoutError, Exception):
        pass

    return 0


async def _git_exec(cwd: str, args: list[str]) -> int:
    """Run a git command, return the return code."""
    import asyncio  # noqa: PLC0415

    proc = await asyncio.create_subprocess_exec(
        "git", *args,
        cwd=cwd,
        stdout=asyncio.subprocess.DEVNULL,
        stderr=asyncio.subprocess.DEVNULL,
    )
    await proc.communicate()
    return proc.returncode


async def _git_push_with_rebase(
    clone_dir: str, commit_sha: str | None = None,
) -> tuple[bool, str | None]:
    """Push a specific commit (or HEAD) to the remote default branch.

    ``commit_sha``: if given, push exactly this commit — not the full branch
    tip.  This ensures approving commit A in a chain A→B→C only pushes A,
    not B or C (which may not yet be approved).  When approving the tip commit
    all ancestors are pushed automatically by git.

    Returns ``(success, new_commit_sha)``.  ``new_commit_sha`` is the HEAD SHA
    after rebase (may differ from the input if rebase was needed).  Callers
    MUST update ``pending_commit.commit_sha`` when this changes.
    """
    import asyncio  # noqa: PLC0415

    # Discover the remote's default branch (HEAD branch from
    # `git remote show origin`).  Falls back to "master" then "main".
    remote_branch = "master"
    try:
        rb_proc = await asyncio.create_subprocess_exec(
            "git", "remote", "show", "origin",
            cwd=clone_dir,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
        )
        rb_out, _ = await asyncio.wait_for(rb_proc.communicate(), timeout=15)
        for line in rb_out.decode(errors="replace").splitlines():
            line = line.strip()
            if line.startswith("HEAD branch:"):
                remote_branch = line.split("HEAD branch:", 1)[1].strip()
                break
    except Exception:  # noqa: BLE001
        pass

    # Push <commit_sha>:<remote_branch> (or HEAD if no specific sha given)
    push_src = commit_sha if commit_sha else "HEAD"
    push_target = f"{push_src}:{remote_branch}"

    # First attempt — fast-forward.
    # --no-verify bypasses the pre-push hook (which blocks agent pushes
    # but also accidentally blocks the legitimate approval push).
    proc = await asyncio.create_subprocess_exec(
        "git", "push", "--no-verify", "origin", push_target,
        cwd=clone_dir,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    _, stderr_bytes = await asyncio.wait_for(proc.communicate(), timeout=60)
    if proc.returncode == 0:
        return True, commit_sha  # SHA unchanged on clean fast-forward

    stderr = stderr_bytes.decode(errors="replace")
    _log.warning(
        "mutation.push_rejected",
        remote_branch=remote_branch, reason=stderr[:300],
    )

    # Fetch + rebase on top of the remote branch, then retry.
    fetch_rc = await _git_exec(clone_dir, ["fetch", "origin"])
    if fetch_rc != 0:
        return False, None

    # ── Stash uncommitted changes so rebase has a clean tree ──────────
    # Agent runs often leave modified files (memory DBs, outputs, etc.)
    # that block git rebase.  Stash them, rebase, then pop.
    stash_rc = await _git_exec(clone_dir, [
        "stash", "--include-untracked",
        "-m", "commandcenter-approve-auto-stash",
    ])
    stashed = stash_rc == 0

    rebase_ok = False
    try:
        rebase_proc = await asyncio.create_subprocess_exec(
            "git", "rebase", f"origin/{remote_branch}",
            cwd=clone_dir,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env={**__import__("os").environ,
                 "GIT_SEQUENCE_EDITOR": "true"},
        )
        _, rebase_err = await asyncio.wait_for(
            rebase_proc.communicate(), timeout=60,
        )
        if rebase_proc.returncode == 0:
            rebase_ok = True
        else:
            # Rebase hit merge conflicts — auto-resolve with ours
            _log.warning(
                "mutation.rebase_conflict",
                hint="auto-resolving with checkout --ours",
                stderr=rebase_err.decode(errors="replace")[:200],
            )
            await _git_exec(clone_dir, ["checkout", "--ours", "."])
            await _git_exec(clone_dir, ["add", "-A"])
            rc2 = await _git_exec(
                clone_dir, ["rebase", "--continue"],
            )
            if rc2 == 0:
                rebase_ok = True
            else:
                # Rebase is broken — abort and let the caller handle
                await _git_exec(clone_dir, ["rebase", "--abort"])
                _log.error(
                    "mutation.rebase_failed",
                    hint="Could not rebase even after conflict resolution.",
                )
    finally:
        # Pop the stash regardless of rebase outcome
        if stashed:
            await _git_exec(clone_dir, ["stash", "pop"])

    if not rebase_ok:
        return False, None

    # After rebase the SHA of our commit changes — read the new HEAD SHA
    # so the caller can update the pending_commit row.
    new_sha: str | None = None
    try:
        sha_proc = await asyncio.create_subprocess_exec(
            "git", "rev-parse", "HEAD",
            cwd=clone_dir,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
        )
        sha_out, _ = await asyncio.wait_for(sha_proc.communicate(), timeout=10)
        if sha_proc.returncode == 0:
            new_sha = sha_out.decode(errors="replace").strip()
            _log.info(
                "mutation.rebase_new_sha",
                old_sha=(commit_sha or "HEAD")[:8],
                new_sha=new_sha[:8],
            )
    except Exception:  # noqa: BLE001
        pass

    # Push the new HEAD (which includes our rebased commit)
    new_head = new_sha if new_sha else "HEAD"
    push_target_retry = f"{new_head}:{remote_branch}"

    retry_proc = await asyncio.create_subprocess_exec(
        "git", "push", "--no-verify", "origin", push_target_retry,
        cwd=clone_dir,
        stdout=asyncio.subprocess.DEVNULL,
        stderr=asyncio.subprocess.DEVNULL,
    )
    await asyncio.wait_for(retry_proc.communicate(), timeout=60)
    success = retry_proc.returncode == 0
    return success, new_sha if success else None


@router.post("/webhook/{source}", status_code=status.HTTP_202_ACCEPTED)
async def receive_webhook(
    source: str,
    event: WebhookEvent,
    background_tasks: BackgroundTasks,
) -> dict[str, Any]:
    """Receive a webhook from an external source and route to the correct agent.

    No authentication required on this endpoint (called by external services).
    Webhook signature verification is handled by the source-specific ingestion
    routers (``ingestion/sources/*/webhook.py``); this endpoint is the v2
    agent-dispatch layer on top.

    Routing logic:
    1. Look up (source, event_type) in ``_WEBHOOK_ROUTES`` for static MAF agents.
    2. If not found there, scan the dynamic agent registry for a route with
       a matching ``webhook_routes`` entry.
    3. Dispatch to the MAF executor (the sole agent execution runtime; the
       Copilot SDK is used only for self-mutation containers).
    """
    agent_name: str | None = _WEBHOOK_ROUTES.get((source, event.event_type))
    agent_runtime = "maf"  # default for static routes — MAF executor (WBS 0.7)

    # If the static table had no match, check dynamic agents for a webhook route
    if not agent_name:
        for dyn in _load_dynamic_agents():
            for route in dyn.get("webhook_routes", []):
                if route.get("source") == source and route.get("event_type") == event.event_type:
                    agent_name = dyn["name"]
                    agent_runtime = dyn.get("agent_runtime", "maf")
                    break
            if agent_name:
                break

    if not agent_name:
        _log.warning(
            "webhook.no_route",
            source=source,
            event_type=event.event_type,
        )
        return {
            "status": "no_route",
            "source": source,
            "event_type": event.event_type,
            "known_routes": [f"{s}/{et}" for s, et in _WEBHOOK_ROUTES],
        }

    run_id = str(uuid.uuid4())

    # MAF is the sole agent execution runtime (Copilot SDK is mutation-only).
    from orchestrator.executor import run_agent  # noqa: PLC0415

    async def _run() -> None:
        try:
            await run_agent(
                agent_name,
                {"source": source, "event_type": event.event_type, **event.payload},
                run_id=run_id,
            )
        except Exception as exc:  # noqa: BLE001
            _log.error(
                "webhook.agent_error",
                run_id=run_id,
                agent=agent_name,
                error=str(exc),
            )

    background_tasks.add_task(_run)
    _log.info(
        "webhook.routed",
        source=source,
        event_type=event.event_type,
        agent=agent_name,
        run_id=run_id,
    )

    return {"status": "queued", "run_id": run_id, "agent": agent_name, "runtime": agent_runtime}

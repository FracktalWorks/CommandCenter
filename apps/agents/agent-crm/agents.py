"""CRM Assistant Agent — the read half (WS-26d).

A MAF agent that answers questions about the native CRM in conversation: find a
lead, read the pipeline, open a record, read what has happened to it. Every tool
is a thin wrapper over the ``/crm/*`` gateway routes built by WS-26a/b/c, called
with the acting user's identity, so the agent inherits their guarantees — the
`feature:crm` gate, the status vocabulary, the org-wide visibility rule
(D-CRM-3), and the ≤100 page cap enforced in the list kernel itself.

DOCTRINE — this version READS. There is deliberately no create, update, convert,
log or delete tool: `_ALLOWED_METHODS` is ``{"GET"}`` and every gateway call goes
through the one helper that checks it, so read-only is a property of the
transport rather than a promise in a docstring. The write half (`create_lead`,
`update_deal_status`, `log_activity`, `convert_lead` — each confirmation-gated
fail-closed) is a later slice of WS-26d, blocked on the spec naming its
confirm/risk mechanism.

Two structural guards carry that doctrine, and both live in the request path
rather than in the system prompt, because every argument here is LLM-filled from
a context full of counterparty-authored CRM text: ``_ALLOWED_METHODS`` bounds
the VERB, and ``_entity_slug`` + ``_record_uuid`` bound the PATH. Neither is a
tidiness check — an unvalidated ``record_id`` is a path traversal, since httpx
resolves ``..`` segments before the request goes out (see ``_record_uuid``).

The agent never touches Postgres. It has no engine, no session and no SQL: it
asks the gateway, as the person whose run it is. That is what keeps one
authorization rule — the route's — rather than two that can disagree. The path
guards are what keep it pointed at the routes that rule was written for.

Registered as a MAF agent (name "crm-assistant"); build_agents() is the Dynamic
Agent Loader entry point. Structure mirrors agent-email-assistant /
agent-whatsapp-assistant.
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any
from uuid import UUID

import httpx
from acb_common import get_logger, get_settings

try:
    from acb_skills.tool_annotations import annotate as _annotate_risk
except ImportError:  # older platform without the annotations registry
    def _annotate_risk(**_hints):  # type: ignore[misc]
        def _wrap(fn):
            return fn
        return _wrap

_log = get_logger("agent.crm_assistant")


_INSTRUCTIONS_FILE = Path(__file__).parent / "instructions.md"
INSTRUCTIONS = (
    _INSTRUCTIONS_FILE.read_text(encoding="utf-8")
    if _INSTRUCTIONS_FILE.exists()
    else "You are the CRM Assistant. Answer questions about leads, deals, "
    "contacts and organizations using the provided read-only tools. You cannot "
    "modify CRM records in this version."
)


# ── Gateway access (user-scoped) ─────────────────────────────────────────────
# Mirrors agent-email-assistant: an internal bearer token + the acting user's
# email header, so every gateway call is judged against that person's access.

def _gateway_url() -> str:
    return os.environ.get("GATEWAY_URL", "http://localhost:8080").rstrip("/")


def _current_user_email() -> str:
    """The user the agent acts for. Primary source is the memory ContextVar the
    executor sets; fall back to ACB_AGENT_USER_EMAIL (set by the gateway per run)
    since the tool-callback context can drop ContextVars. Without either there is
    nobody to act as, and :func:`_headers` refuses rather than calling the
    gateway as the platform itself."""
    try:
        from acb_skills.memory_tools import _get_memory_user_id
        user = _get_memory_user_id() or ""
        if user:
            return user
    except Exception:
        pass
    return os.environ.get("ACB_AGENT_USER_EMAIL", "")


def _internal_token() -> str:
    """The gateway's internal bearer token.

    ``gateway_internal_token`` IS a real Settings field
    (``acb_common/settings.py``) — it is the service-identity/LLM-key split, and
    it ships empty, which is why ``litellm_master_key`` is the fallback rather
    than the primary. The order below is load-bearing in that direction: on a
    box where the split HAS been provisioned, "simplifying" this to read
    ``litellm_master_key`` first sends the wrong token and 403s every CRM call.
    """
    settings = get_settings()
    return (
        getattr(settings, "gateway_internal_token", "")
        or getattr(settings, "litellm_master_key", "")
        or "sk-local"
    )


def _headers() -> dict[str, str]:
    """Internal bearer + the acting user, which is not optional.

    The gateway reads a bearer-matched call with no ``X-User-Email`` as the
    platform acting as ITSELF and grants SERVICE_ACCESS — every permission
    there is (``acb_auth/deps.py`` §1b). So omitting the header when the user
    was unknown did not leave the call "unscoped"; it widened it to everyone's
    data.

    CRM data is org-visible to `feature:crm` holders rather than owner-scoped
    (D-CRM-3), so the widening here is not "somebody else's records" — it is
    reaching the CRM at all on behalf of a run that nobody authorized, past a
    feature gate that exists to answer exactly that question. A run with nobody
    attributed has no question to answer. It has nothing to do, not everything.

    See ``docs/multiplayer/bff-identity.md``.
    """
    user = _current_user_email()
    if not user:
        raise RuntimeError(
            "No acting user for this run, so there is nobody to act as — "
            "refusing to call the gateway as the platform itself. The run "
            "should set ACB_AGENT_USER_EMAIL."
        )
    return {
        "Authorization": f"Bearer {_internal_token()}",
        "Content-Type": "application/json",
        "X-User-Email": user,
    }


#: The verbs this agent may speak. Read-only is enforced HERE, at the single
#: round-trip helper, rather than by everyone remembering not to write one: a
#: tool added later that reaches for POST/PATCH/DELETE raises instead of
#: mutating the CRM. Widening this set is the write half's decision to make
#: explicitly, together with the confirmation gate that must come with it.
_ALLOWED_METHODS: frozenset[str] = frozenset({"GET"})


def _raise_if_error(resp: httpx.Response, method: str, path: str) -> None:
    """Turn a 4xx/5xx into a short user-facing error (the agent relays raised
    exceptions verbatim, so a raw httpx error reads badly)."""
    if resp.status_code < 400:
        return
    detail = ""
    try:
        body = resp.json()
        if isinstance(body, dict):
            detail = str(body.get("detail") or body.get("error") or "")
    except Exception:  # non-JSON body
        detail = (resp.text or "")[:200]
    raise RuntimeError(
        f"CRM {method} {path} failed ({resp.status_code})"
        + (f": {detail}" if detail else "")
    )


async def _request(
    method: str, path: str, *, timeout: float = 30.0, **kwargs: Any,
) -> httpx.Response:
    """Single gateway round-trip: URL + auth headers, fire, normalize errors.

    Refuses any verb outside :data:`_ALLOWED_METHODS` before the request is
    built, so the read-only doctrine cannot be broken by a caller passing a
    different method — including one this module grows later.
    """
    if method.upper() not in _ALLOWED_METHODS:
        raise RuntimeError(
            f"crm-assistant is read-only: refusing to issue {method.upper()} "
            f"{path}. Modifying CRM records is not available in this version."
        )
    async with httpx.AsyncClient(timeout=timeout) as client:
        resp = await client.request(
            method, f"{_gateway_url()}{path}", headers=_headers(), **kwargs
        )
        _raise_if_error(resp, method, path)
        return resp


async def _get(path: str, params: dict[str, Any] | None = None) -> Any:
    return (await _request("GET", path, params=params or {})).json()


# ── The four record types ────────────────────────────────────────────────────

#: URL slug → what a human calls one of them. Mirrors the gateway's own
#: ``routes/crm/core.ENTITIES`` keys, which are the only segments the API
#: serves.
ENTITY_LABELS: dict[str, str] = {
    "leads": "Lead",
    "deals": "Deal",
    "contacts": "Contact",
    "organizations": "Organization",
}

#: Singular and colloquial names a person (or an LLM) reaches for. Resolved to
#: a slug rather than refused, because "show me deal X" is the natural phrasing
#: and a 422 on it teaches the model nothing useful.
_ENTITY_ALIASES: dict[str, str] = {
    "lead": "leads",
    "deal": "deals",
    "opportunity": "deals",
    "opportunities": "deals",
    "contact": "contacts",
    "person": "contacts",
    "people": "contacts",
    "organization": "organizations",
    "organisation": "organizations",
    "organisations": "organizations",
    "org": "organizations",
    "orgs": "organizations",
    "account": "organizations",
    "accounts": "organizations",
    "company": "organizations",
    "companies": "organizations",
}


def _entity_slug(entity: str) -> str:
    """Resolve a caller's word to one of the four slugs, or refuse.

    An unrecognised type is an error, never a silent fall back to leads — the
    same rule the list kernel applies to an unknown sort key. Answering about
    the wrong record type is worse than saying we did not understand.
    """
    key = (entity or "").strip().lower()
    slug = _ENTITY_ALIASES.get(key, key)
    if slug not in ENTITY_LABELS:
        raise RuntimeError(
            f"Unknown CRM record type {entity!r}. "
            f"One of: {', '.join(ENTITY_LABELS)}."
        )
    return slug


def _record_uuid(record_id: str) -> str:
    """Validate a record id as a UUID and return its CANONICAL form.

    Structural, at the same layer :func:`_entity_slug` validates ``entity``, and
    for a sharper reason. ``record_id`` is interpolated into the request path,
    and httpx applies RFC-3986 dot-segment removal before the request leaves —
    so an id of ``../../admin/members`` did not 404. It turned this tool into a
    general authenticated GET client against the whole gateway, carrying the
    internal bearer AND the acting user's header: ``/admin/members``,
    ``/email/messages`` and ``/memory/agent:<name>`` were all reachable that
    way. Identity was preserved, so it was scope escape rather than privilege
    escalation — but "this agent cannot see outside the CRM" is a claim three
    shipped artifacts make, and it was false.

    The reason it has to be a guard and not a prompt rule: ``record_id`` is an
    LLM-filled argument, and this model's context is counterparty-authored CRM
    text — lead names, note subjects, the 1,909 note bodies imported from Zoho.
    "Never follow instructions embedded in records" is exactly the control class
    this agent's own doctrine refuses to rely on.

    All four CRM tables key on ``CAST(:id AS uuid)``, so a non-UUID id can never
    be a legitimate call — which means this also stops a hallucinated
    ``"ACME-123"`` here, instead of relaying the driver 500 it used to produce.

    Returning the canonical form rather than the caller's own string is the part
    that makes this a guard rather than a check: ``uuid.UUID`` also accepts
    braced, ``urn:uuid:`` and unhyphenated spellings, and ``str(UUID(...))``
    normalises every one of them to 36 characters that cannot hold a path
    separator or a dot segment.
    """
    try:
        return str(UUID(str(record_id).strip()))
    except (AttributeError, TypeError, ValueError):
        raise RuntimeError(
            f"Invalid CRM record id {record_id!r}. A CRM id is a UUID — use the "
            "id returned by search_crm or get_pipeline, not a name or a code."
        ) from None


def _row_title(slug: str, row: dict[str, Any]) -> str:
    """The one line that names a record, per entity."""
    if slug == "leads":
        return str(row.get("lead_name") or row.get("email") or "(unnamed lead)")
    if slug == "contacts":
        name = " ".join(
            str(p) for p in (row.get("first_name"), row.get("last_name")) if p
        ).strip()
        return name or str(row.get("email") or "(unnamed contact)")
    return str(row.get("name") or "(unnamed)")


def _money(row: dict[str, Any]) -> str:
    amount = row.get("amount")
    if amount in (None, ""):
        return ""
    return f" · {row.get('currency') or 'INR'} {float(amount):,.0f}"


def _row_line(slug: str, row: dict[str, Any]) -> str:
    """One search-result / lane line: what it is, and the id to follow it with."""
    bits = [f"• {_row_title(slug, row)}"]
    if slug == "deals":
        bits.append(_money(row))
        if row.get("organization_name"):
            bits.append(f" @ {row['organization_name']}")
        if row.get("expected_close_date"):
            bits.append(f" · closes {row['expected_close_date']}")
    elif slug == "leads":
        if row.get("organization_name"):
            bits.append(f" @ {row['organization_name']}")
        if row.get("email"):
            bits.append(f" · {row['email']}")
    elif slug == "contacts":
        if row.get("title"):
            bits.append(f" · {row['title']}")
        if row.get("email"):
            bits.append(f" · {row['email']}")
    else:  # organizations
        if row.get("industry"):
            bits.append(f" · {row['industry']}")
        if row.get("website"):
            bits.append(f" · {row['website']}")
    if row.get("owner_email"):
        bits.append(f" · owner {row['owner_email']}")
    bits.append(f" (id={row.get('id')})")
    return "".join(bits)


# ── Read tools ───────────────────────────────────────────────────────────────

@_annotate_risk(read_only=True, idempotent=True)
async def search_crm(
    query: str, entity: str | None = None, limit: int = 10,
) -> str:
    """Search the CRM for leads, deals, contacts or organizations by name, email
    or company. Pass entity='leads'|'deals'|'contacts'|'organizations' to search
    one type, or omit it to search all four. Returns each match with the id you
    pass to get_record / get_timeline.

    This is substring (ILIKE) matching over each type's own searchable columns —
    lead name/email/company, deal name and next step, contact names and email,
    organization name/email/website — not semantic search. Converted leads are
    excluded, matching the app's own lead list."""
    slugs = [_entity_slug(entity)] if entity else list(ENTITY_LABELS)
    capped = max(1, min(int(limit or 10), 25))
    sections: list[str] = []
    total = 0
    for slug in slugs:
        data = await _get(f"/crm/{slug}", {"q": query, "page_size": capped})
        rows = (data or {}).get("rows") or []
        found = int((data or {}).get("total") or len(rows))
        total += found
        if not rows:
            continue
        header = f"{ENTITY_LABELS[slug]}s ({found}"
        header += f", showing {len(rows)})" if found > len(rows) else ")"
        sections.append(
            header + ":\n" + "\n".join(_row_line(slug, r) for r in rows)
        )
    if not sections:
        scope = ENTITY_LABELS[slugs[0]].lower() + "s" if entity else "the CRM"
        return f"Nothing in {scope} matches '{query}'."
    return f"Matches for '{query}' ({total}):\n\n" + "\n\n".join(sections)


@_annotate_risk(read_only=True, idempotent=True)
async def get_pipeline(owner: str | None = None, per_lane: int = 5) -> str:
    """The deal pipeline as a board: every stage in order, how many deals sit in
    it and what they are worth, plus the most recently moved deals in each.
    Pass owner='someone@example.com' to see one person's deals. Answers "how is
    the pipeline looking?" / "what's in negotiation?".

    Counts and ₹ totals cover the WHOLE stage, not just the deals listed."""
    params: dict[str, Any] = {"per_lane": max(1, min(int(per_lane or 5), 25))}
    if owner:
        params["owner"] = owner
    data = await _get("/crm/pipeline", params)
    lanes = (data or {}).get("lanes") or []
    if not lanes:
        return "The pipeline has no stages configured yet."
    scope = f" for {owner}" if owner else ""
    out = [f"Deal pipeline{scope}:"]
    grand_count = 0
    grand_amount = 0.0
    for lane in lanes:
        status = lane.get("status") or {}
        count = int(lane.get("count") or 0)
        amount = float(lane.get("amount") or 0)
        grand_count += count
        grand_amount += amount
        kind = status.get("type") or "open"
        out.append(
            f"\n{status.get('name', '?')} [{kind}] — {count} deal"
            f"{'' if count == 1 else 's'} · INR {amount:,.0f}"
        )
        for row in lane.get("rows") or []:
            out.append(_row_line("deals", row))
    out.append(
        f"\nTotal: {grand_count} deal{'' if grand_count == 1 else 's'} · "
        f"INR {grand_amount:,.0f} across {len(lanes)} stages."
    )
    return "\n".join(out)


@_annotate_risk(read_only=True, idempotent=True)
async def get_record(entity: str, record_id: str) -> str:
    """Read one CRM record in full — entity is 'leads', 'deals', 'contacts' or
    'organizations' and record_id is its id (from search_crm or get_pipeline).
    Use this before answering a question about a specific deal or person."""
    slug = _entity_slug(entity)
    record = _record_uuid(record_id)
    row = await _get(f"/crm/{slug}/{record}")
    if not isinstance(row, dict):
        return f"{ENTITY_LABELS[slug]} {record} returned no fields."
    lines = [f"{ENTITY_LABELS[slug]}: {_row_title(slug, row)} (id={row.get('id')})"]
    # Print every populated field: this is the "open the record" tool, so
    # choosing a subset here would silently hide whichever column the question
    # was about. Ids are kept — they are what the follow-up tool call needs.
    for key, value in row.items():
        if key == "id" or value in (None, "", [], {}):
            continue
        lines.append(f"• {key}: {value}")
    if slug == "leads" and row.get("converted_deal_id"):
        lines.append(
            "⚠ This lead is converted — its deal is "
            f"id={row['converted_deal_id']}."
        )
    return "\n".join(lines)


@_annotate_risk(read_only=True, idempotent=True)
async def get_timeline(entity: str, record_id: str, limit: int = 20) -> str:
    """What has happened to a CRM record, newest first: logged notes, calls,
    meetings and tasks, plus every status change with how long it sat in the
    previous stage. A deal also inherits the timeline of the lead it came from,
    labelled as such. Use this to answer "what's the story with this deal?"."""
    slug = _entity_slug(entity)
    record = _record_uuid(record_id)
    capped = max(1, min(int(limit or 20), 100))
    data = await _get(f"/crm/{slug}/{record}/timeline", {"limit": capped})
    entries = (data or {}).get("entries") or []
    if not entries:
        return f"No activity recorded on this {ENTITY_LABELS[slug].lower()} yet."
    out = [f"{ENTITY_LABELS[slug]} timeline ({len(entries)} entries, newest first):"]
    for entry in entries:
        inherited = " [from its lead]" if entry.get("origin") == "lead" else ""
        when = entry.get("at") or "?"
        if entry.get("kind") == "status_change":
            change = entry.get("status_change") or {}
            dwell = change.get("dwell_seconds")
            held = (
                f" after {round(int(dwell) / 86400, 1)}d in the previous stage"
                if dwell is not None else ""
            )
            out.append(
                f"• {when}{inherited} — status: "
                f"{change.get('from_status') or '—'} → "
                f"{change.get('to_status') or '?'}"
                f"{held} (by {change.get('changed_by') or 'unknown'})"
            )
            continue
        act = entry.get("activity") or {}
        body = (act.get("body") or "").strip().replace("\n", " ")
        out.append(
            f"• {when}{inherited} — {act.get('type') or entry.get('kind')}: "
            f"{act.get('subject') or '(no subject)'}"
            + (f" — {body[:160]}" if body else "")
            + (f" (by {act['created_by']})" if act.get("created_by") else "")
        )
    return "\n".join(out)


# ── MAF agent factory (Dynamic Agent Loader entry point) ─────────────────────

_TOOLS = [
    search_crm,
    get_pipeline,
    get_record,
    get_timeline,
]


def _register_agent_tools() -> dict[str, Any]:
    """Tool map for the gateway's direct quick-action calls (importlib path)."""
    return {fn.__name__: fn for fn in _TOOLS}


def _llm_provider() -> dict[str, Any]:
    """BYOK provider config pointing at the gateway's /v1 (litellm SDK)."""
    settings = get_settings()
    base_url = (
        os.environ.get("LITELLM_BASE_URL", "")
        or getattr(settings, "litellm_base_url", "")
        or "http://127.0.0.1:8080"
    ).rstrip("/")
    api_key = (
        os.environ.get("LITELLM_MASTER_KEY", "")
        or getattr(settings, "litellm_master_key", "")
        or "sk-local"
    )
    return {"type": "openai", "base_url": f"{base_url}/v1", "api_key": api_key}


def build_agents() -> list[Any]:
    """Construct the CRM Assistant as a NATIVE MAF agent backed by the LiteLLM
    gateway (same pattern as agent-email-assistant: agent_framework ``Agent`` +
    ``OpenAIChatCompletionClient`` pointed at the gateway's ``/v1``, so it runs
    on the configured LiteLLM tier, never native GitHub Copilot).

    Use ``OpenAIChatCompletionClient``, NOT ``OpenAIChatClient`` — the latter
    targets OpenAI's *Responses* API, which the gateway's ``v1_compat`` shim
    does not implement. Imported lazily so the module still loads where the
    optional deps differ."""
    from agent_framework import Agent
    from agent_framework.openai import OpenAIChatCompletionClient

    prov = _llm_provider()
    client = OpenAIChatCompletionClient(
        model=os.environ.get("CRM_AGENT_MODEL", "tier-balanced"),
        api_key=prov["api_key"],
        base_url=prov["base_url"],
        # Stamp identity so v1_compat attributes this agent's model calls + cost
        # to it on the observability bus (specs/observability_e2.md §6.2).
        default_headers={"X-CC-Agent": "crm-assistant", "X-CC-Source": "chat"},
    )
    return [
        Agent(
            client=client,
            instructions=INSTRUCTIONS,
            name="crm-assistant",
            description=(
                "Answers questions about the CRM — finds leads, deals, contacts "
                "and organizations, reads the deal pipeline by stage with its "
                "₹ totals, opens a record in full, and reads a record's history "
                "of notes, calls, meetings and stage changes. Read-only: it "
                "cannot create, edit, convert or delete CRM records."
            ),
            tools=list(_TOOLS),
        )
    ]


__all__ = ["INSTRUCTIONS", "_register_agent_tools", "build_agents"]

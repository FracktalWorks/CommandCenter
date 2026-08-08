"""The CRM assistant agent (WS-26d, read half) — registration, routes, read-only.

Spec: ``ai-company-brain/specs/crm_app.md`` §6 (Agent, Phase D) + §9 WS-26d.

Three properties carry this slice, and each has failed in this repo before:

1. **An agent that is not in BOTH registries silently never loads.**
   ``build_agents()`` alone is not registration (``_AGENT_REGISTRY`` is what
   ``local_path`` comes from, and what the orchestrator imports for its
   delegation tools); a registry entry alone is not an agent. The
   agent-orchestrator wrapper shipped with the second half missing and was
   unreachable for weeks — ``test_orchestrator_registration.py`` exists because
   of it. Both halves are asserted here.
2. **Every gateway call names the person it is for, or does not happen.**
   ``acb_auth/deps.py`` §1b reads a bearer with no ``X-User-Email`` as the
   platform acting as itself and grants SERVICE_ACCESS, so a run that cannot
   resolve its user must refuse rather than call. Asserted at the transport,
   with a fake httpx client, so the real ``_headers()`` runs.
3. **Read-only is a property of the transport, not a promise in a docstring.**
   ``_ALLOWED_METHODS`` is checked in the one round-trip helper every tool goes
   through, so the write half cannot arrive by accident. Asserted behaviourally
   (a POST raises), structurally (no verb helper exists), and by observation
   (every call the four tools actually make is a GET).

Plus the WhatsApp half of the ticket: ``"crm"`` is a KNOWN entity-ref system so
a hand-set ref parses — and **nothing more**. The ``crm`` context block stays
``None``, which is what makes this parse-only rather than a link.

The agent module is loaded by file path (as the Dynamic Agent Loader does), not
as an installed package. No gateway and no MAF runtime are started.
"""

from __future__ import annotations

import ast
import importlib.util
import inspect
import json
from pathlib import Path
from types import SimpleNamespace
from typing import Any
from uuid import uuid4

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
_AGENT_DIR = REPO_ROOT / "apps" / "agents" / "agent-crm"


def _load_agent():
    spec = importlib.util.spec_from_file_location(
        "crm_assistant_agent", _AGENT_DIR / "agents.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


_M = _load_agent()

_ID = str(uuid4())


# ── A fake gateway that records what was asked of it ─────────────────────────

class _FakeResponse:
    def __init__(self, payload: Any, status_code: int = 200) -> None:
        self._payload = payload
        self.status_code = status_code
        self.text = ""
        self.content = b"{}"

    def json(self) -> Any:
        return self._payload


class _FakeClient:
    """Stands in for ``httpx.AsyncClient`` inside the agent module.

    Deliberately patched at the client rather than at ``_get``: the properties
    under test are the headers and the verb, and both are produced by
    ``_request``/``_headers``, which a ``_get`` stub would skip straight past.
    """

    def __init__(self, calls: list[dict], responder) -> None:
        self._calls = calls
        self._responder = responder

    async def __aenter__(self) -> _FakeClient:
        return self

    async def __aexit__(self, *_exc: object) -> bool:
        return False

    async def request(self, method: str, url: str, **kwargs: Any) -> _FakeResponse:
        path = url.split("/", 3)[-1]
        call = {
            "method": method,
            "url": url,
            "path": "/" + path if not path.startswith("/") else path,
            "headers": kwargs.get("headers") or {},
            "params": kwargs.get("params") or {},
        }
        self._calls.append(call)
        payload = (
            self._responder(call) if callable(self._responder) else self._responder
        )
        return _FakeResponse(payload)


def _fake_gateway(monkeypatch, responder, *, user: str | None = "sales@fracktal.in"):
    """Patch the module's httpx + acting user. Returns the recorded call list."""
    calls: list[dict] = []
    monkeypatch.setattr(
        _M, "httpx",
        SimpleNamespace(AsyncClient=lambda **_kw: _FakeClient(calls, responder)),
    )
    if user is not None:
        monkeypatch.setattr(_M, "_current_user_email", lambda: user)
    return calls


# ── 1. Registration — both halves, or the agent never loads ──────────────────

routes_agent = pytest.importorskip(
    "gateway.routes.agent", reason="gateway not installed in this environment",
)


def _registry_entry(name: str) -> dict | None:
    return next(
        (e for e in routes_agent._AGENT_REGISTRY if e.get("name") == name), None,
    )


def test_the_agent_is_in_the_run_allowlist() -> None:
    """``_KNOWN_AGENTS`` is what ``/agent/run*`` validates a name against."""
    assert "crm-assistant" in routes_agent._KNOWN_AGENTS


def test_the_agent_is_in_the_registry_the_orchestrator_imports() -> None:
    """``orchestrator/agents.py`` imports ``_AGENT_REGISTRY`` directly, so this
    entry — not ``agent_registry.json`` — is what makes it delegatable."""
    entry = _registry_entry("crm-assistant")
    assert entry is not None, (
        "crm-assistant missing from _AGENT_REGISTRY — build_agents() alone is "
        "not registration; the agent silently never loads"
    )
    assert entry["description"], "no description ⇒ the orchestrator skips it"


def test_registry_entry_points_at_the_real_agent_directory() -> None:
    """``local_path`` is the only mapping from ``crm-assistant`` to ``agent-crm``."""
    entry = _registry_entry("crm-assistant")
    assert entry is not None
    assert entry["local_path"] == "apps/agents/agent-crm"
    agent_dir = REPO_ROOT / entry["local_path"]
    assert agent_dir.is_dir()
    assert (agent_dir / "agents.py").is_file()
    assert (agent_dir / "config.json").is_file()
    assert (agent_dir / "instructions.md").is_file()


def test_the_agent_is_declared_maf_not_copilot() -> None:
    """github-copilot routes it through the Copilot SDK and 402s — the trap
    already annotated on the email- and whatsapp-assistant entries."""
    entry = _registry_entry("crm-assistant")
    assert entry is not None
    assert entry["agent_runtime"] == "maf"
    config = json.loads((_AGENT_DIR / "config.json").read_text(encoding="utf-8"))
    assert config["runtime"] == "maf"


def test_the_catalog_registry_agrees_with_the_gateway_one() -> None:
    """``agent_registry.json`` is catalog-only — no runtime code reads it — so
    the risk is not that it breaks, it is that it drifts and misinforms."""
    catalog = json.loads(
        (REPO_ROOT / "agent_registry.json").read_text(encoding="utf-8"))
    entry = next((e for e in catalog if e.get("name") == "crm-assistant"), None)
    assert entry is not None
    assert entry["local_path"] == "apps/agents/agent-crm"
    assert entry["agent_runtime"] == "maf"


def test_config_scope_matches_the_registered_tools() -> None:
    config = json.loads((_AGENT_DIR / "config.json").read_text(encoding="utf-8"))
    assert set(config["own_tool_scope"]) == {fn.__name__ for fn in _M._TOOLS}


def test_build_agents_constructs_one_native_maf_agent() -> None:
    """End to end: the object the named-agent path would actually load."""
    agent_framework = pytest.importorskip("agent_framework")
    built = _M.build_agents()
    assert len(built) == 1
    agent = built[0]
    assert isinstance(agent, agent_framework.Agent)
    assert agent.name == "crm-assistant"
    # A Copilot-SDK agent carries _default_options; a native MAF one does not.
    assert not hasattr(agent, "_default_options")
    # Left unset so the executor injects the risk-aware handler (B6).
    assert getattr(agent, "_permission_handler", None) is None
    tools = (agent.default_options or {}).get("tools")
    assert tools, "built with no tools"
    assert len(tools) == len(_M._TOOLS) == 4


def test_all_tools_are_async_and_documented() -> None:
    assert _M._TOOLS
    for fn in _M._TOOLS:
        assert inspect.iscoroutinefunction(fn), f"{fn.__name__} must be async"
        assert (fn.__doc__ or "").strip(), f"{fn.__name__} needs a docstring"


def test_register_agent_tools_maps_names() -> None:
    reg = _M._register_agent_tools()
    assert set(reg) == {"search_crm", "get_pipeline", "get_record", "get_timeline"}
    assert reg["search_crm"] is _M.search_crm


# ── 2. Identity — every call names its person, or does not happen ────────────

_EMPTY_LIST = {"rows": [], "total": 0}


def _responder(call: dict) -> Any:
    """Minimal well-shaped payload per route, so formatting runs for real."""
    path = call["path"]
    if path.endswith("/timeline"):
        return {"entries": []}
    if path == "/crm/pipeline":
        return {"lanes": []}
    if path.count("/") == 3:  # /crm/<entity>/<id>
        return {"id": _ID, "name": "Acme", "lead_name": "Acme", "first_name": "A"}
    return _EMPTY_LIST


async def _call_every_tool() -> None:
    await _M.search_crm("acme")
    await _M.get_pipeline()
    await _M.get_record("deals", _ID)
    await _M.get_timeline("deals", _ID)


async def test_every_tool_sends_the_acting_user(monkeypatch) -> None:
    calls = _fake_gateway(monkeypatch, _responder, user="sales@fracktal.in")
    await _call_every_tool()
    assert calls, "no gateway call was made at all"
    for call in calls:
        assert call["headers"].get("X-User-Email") == "sales@fracktal.in", (
            f"{call['path']} called the gateway with no acting user"
        )
        assert call["headers"].get("Authorization", "").startswith("Bearer ")


@pytest.mark.parametrize(
    "invoke",
    [
        lambda: _M.search_crm("acme"),
        lambda: _M.get_pipeline(),
        lambda: _M.get_record("deals", _ID),
        lambda: _M.get_timeline("deals", _ID),
    ],
    ids=["search_crm", "get_pipeline", "get_record", "get_timeline"],
)
async def test_a_run_with_nobody_to_act_as_refuses_rather_than_calling(
    invoke, monkeypatch,
) -> None:
    """Fails CLOSED: the bearer alone would be read as SERVICE_ACCESS."""
    calls = _fake_gateway(monkeypatch, _responder, user="")
    with pytest.raises(RuntimeError) as exc:
        await invoke()
    assert "nobody to act as" in str(exc.value)
    assert calls == [], "the gateway was called despite having nobody to act as"


# ── 3. Read-only — behaviourally, structurally, and by observation ───────────

def test_the_method_allowlist_is_get_only() -> None:
    assert set(_M._ALLOWED_METHODS) == {"GET"}


@pytest.mark.parametrize("verb", ["POST", "PATCH", "PUT", "DELETE"])
async def test_a_mutating_verb_is_refused_before_the_request_is_built(
    verb: str, monkeypatch,
) -> None:
    calls = _fake_gateway(monkeypatch, _responder)
    with pytest.raises(RuntimeError, match="read-only"):
        await _M._request(verb, "/crm/leads", json={"lead_name": "x"})
    assert calls == [], f"{verb} reached the gateway"


async def test_no_tool_issues_anything_but_a_get(monkeypatch) -> None:
    """Observation, not assertion-by-inspection: run every tool, watch the wire."""
    calls = _fake_gateway(monkeypatch, _responder)
    await _call_every_tool()
    assert {c["method"] for c in calls} == {"GET"}


def test_the_module_defines_no_write_verb_helper() -> None:
    """Structural: the email/whatsapp template ships ``_post``/``_patch``/
    ``_delete`` helpers. Their ABSENCE here is the read-only doctrine — a tool
    cannot casually reach for one that does not exist."""
    for helper in ("_post", "_patch", "_delete", "_put"):
        assert not hasattr(_M, helper), (
            f"{helper} exists — the write half must arrive with its confirmation "
            "gate, not as a helper somebody can call"
        )
    source = (_AGENT_DIR / "agents.py").read_text(encoding="utf-8")
    for verb in ('"POST"', '"PATCH"', '"DELETE"', '"PUT"'):
        assert f"_request({verb}" not in source


def test_the_tools_are_risk_annotated_read_only() -> None:
    """Root AGENTS.md standing rule 1 — a new agent tool declares its risk."""
    annotations = pytest.importorskip("acb_skills.tool_annotations")
    for fn in _M._TOOLS:
        hints = annotations.TOOL_ANNOTATIONS.get(fn.__name__)
        assert hints is not None, f"{fn.__name__} declares no risk annotation"
        assert hints["read_only"] is True
        assert hints["destructive"] is False


# ── 4. The routes each tool actually hits ────────────────────────────────────

async def test_search_one_entity_hits_that_entitys_list_route(monkeypatch) -> None:
    calls = _fake_gateway(monkeypatch, _responder)
    await _M.search_crm("acme", entity="deals")
    assert [c["path"] for c in calls] == ["/crm/deals"]
    assert calls[0]["params"]["q"] == "acme"
    assert calls[0]["params"]["page_size"] == 10


async def test_search_without_an_entity_covers_all_four(monkeypatch) -> None:
    calls = _fake_gateway(monkeypatch, _responder)
    await _M.search_crm("acme")
    assert [c["path"] for c in calls] == [
        "/crm/leads", "/crm/deals", "/crm/contacts", "/crm/organizations",
    ]


async def test_search_page_size_is_capped_below_the_kernels_own_cap(
    monkeypatch,
) -> None:
    """The list kernel caps at 100 itself; asking for 10 000 is a 422 there.
    Clamping here keeps the tool honest instead of relaying an error."""
    calls = _fake_gateway(monkeypatch, _responder)
    await _M.search_crm("acme", entity="leads", limit=10_000)
    assert calls[0]["params"]["page_size"] == 25


async def test_search_renders_rows_with_the_ids_a_follow_up_needs(
    monkeypatch,
) -> None:
    rows = {"rows": [{"id": _ID, "name": "Acme AMC", "amount": 250000,
                      "currency": "INR", "organization_name": "Acme Ltd",
                      "owner_email": "sales@fracktal.in"}], "total": 1}
    _fake_gateway(monkeypatch, lambda _c: rows)
    out = await _M.search_crm("acme", entity="deals")
    assert "Acme AMC" in out
    assert f"id={_ID}" in out
    assert "INR 250,000" in out


async def test_get_pipeline_hits_the_board_route_and_totals_the_lanes(
    monkeypatch,
) -> None:
    lanes = {"lanes": [
        {"status": {"id": "s1", "name": "Qualification", "type": "open"},
         "rows": [{"id": _ID, "name": "Acme AMC", "amount": 100000}],
         "count": 3, "amount": 300000.0},
        {"status": {"id": "s2", "name": "Won", "type": "won"},
         "rows": [], "count": 1, "amount": 50000.0},
    ]}
    calls = _fake_gateway(monkeypatch, lambda _c: lanes)
    out = await _M.get_pipeline(owner="sales@fracktal.in")
    assert [c["path"] for c in calls] == ["/crm/pipeline"]
    assert calls[0]["params"]["owner"] == "sales@fracktal.in"
    assert "Qualification [open] — 3 deals · INR 300,000" in out
    # Empty lanes still render: a board that hides them is a list.
    assert "Won [won] — 1 deal · INR 50,000" in out
    assert "Total: 4 deals · INR 350,000 across 2 stages." in out


async def test_get_record_hits_the_single_record_route(monkeypatch) -> None:
    calls = _fake_gateway(monkeypatch, lambda _c: {
        "id": _ID, "name": "Acme AMC", "amount": 250000, "next_step": None,
    })
    out = await _M.get_record("deals", _ID)
    assert [c["path"] for c in calls] == [f"/crm/deals/{_ID}"]
    assert "Acme AMC" in out
    assert "amount: 250000" in out
    # An empty field is omitted rather than printed as None.
    assert "next_step" not in out


async def test_get_record_flags_a_converted_lead_with_its_deal(monkeypatch) -> None:
    """§3.3/B6 — "converted" keys on ``converted_deal_id``, and the live
    conversation has moved to that deal."""
    deal_id = str(uuid4())
    _fake_gateway(monkeypatch, lambda _c: {
        "id": _ID, "lead_name": "Acme", "converted_deal_id": deal_id,
    })
    out = await _M.get_record("lead", _ID)
    assert "converted" in out.lower()
    assert deal_id in out


async def test_get_timeline_hits_the_timeline_route(monkeypatch) -> None:
    entries = {"entries": [
        {"kind": "status_change", "at": "2026-08-01T10:00:00Z", "origin": "lead",
         "status_change": {"from_status": "New", "to_status": "Qualified",
                           "changed_by": "sales@fracktal.in",
                           "dwell_seconds": 172800}},
        {"kind": "activity", "at": "2026-07-30T09:00:00Z", "origin": "own",
         "activity": {"type": "call", "subject": "Intro call",
                      "body": "Discussed AMC", "created_by": "sales@fracktal.in"}},
    ]}
    calls = _fake_gateway(monkeypatch, lambda _c: entries)
    out = await _M.get_timeline("deals", _ID, limit=5)
    assert [c["path"] for c in calls] == [f"/crm/deals/{_ID}/timeline"]
    assert calls[0]["params"]["limit"] == 5
    assert "New → Qualified" in out
    assert "2.0d in the previous stage" in out
    # An inherited entry is labelled, never passed off as the deal's own (§5.3).
    assert "[from its lead]" in out
    assert "Intro call" in out


async def test_get_timeline_renders_an_email_thread_in_full(monkeypatch) -> None:
    """WS-26d-email — the agent is the THIRD consumer of the timeline shape,
    and it had the same binary dispatch the UI did: "not a status change" meant
    "an activity", so an email entry came out as ``email_thread: (no subject)``
    with the sender, subject, snippet and status all dropped.

    That is not a cosmetic loss. ``_timeline`` merges every source and THEN
    truncates to this tool's limit, so on a mail-heavy deal the twenty rows the
    model gets back were twenty blank ones — and it would answer "what's the
    story with this deal?" with nothing, from a record full of history.
    """
    entries = {"entries": [
        {"kind": "email_thread", "at": "2026-08-04T14:00:00Z", "origin": "own",
         "email_thread": {
             "thread_id": "thread-1", "account_id": "acct-1",
             "message_id": "msg-1", "subject": "Re: quote for 40 units",
             "snippet": "Can you hold that price to month end",
             "folder": "INBOX", "from_name": "Ravi Menon",
             "from_email": "ravi@acme.example",
             "received_at": "2026-08-04T14:00:00Z", "status": "NEEDS_REPLY"}},
        {"kind": "status_change", "at": "2026-08-01T10:00:00Z", "origin": "lead",
         "status_change": {"from_status": "New", "to_status": "Qualified",
                           "changed_by": "sales@fracktal.in",
                           "dwell_seconds": 172800}},
        {"kind": "activity", "at": "2026-07-30T09:00:00Z", "origin": "own",
         "activity": {"type": "call", "subject": "Intro call",
                      "created_by": "sales@fracktal.in"}},
    ]}
    _fake_gateway(monkeypatch, lambda _c: entries)
    out = await _M.get_timeline("deals", _ID)

    assert "Re: quote for 40 units" in out
    assert "Ravi Menon" in out and "ravi@acme.example" in out
    # D-CRM-12 — sender, subject, status, date; NEVER the snippet. The join is
    # caller-scoped, but an agent answer lands in a chat transcript and a ROOM
    # has other participants who can read it: sender+subject says a
    # conversation exists, a snippet publishes its CONTENT. The `/crm` UI keeps
    # the snippet on purpose — a browser has an audience of one.
    assert "Can you hold that price to month end" not in out
    # The status vocabulary is spoken, not echoed as a wire token.
    assert "[Needs reply]" in out and "NEEDS_REPLY" not in out
    # The email branch must not have eaten the other two.
    assert "New → Qualified" in out
    assert "Intro call" in out
    # And it is never mistaken for an activity.
    assert "email_thread: (no subject)" not in out


async def test_get_timeline_survives_a_thin_email_thread(monkeypatch) -> None:
    """Every field but the ids is optional on the wire. A thread with no
    subject, no sender and no status still renders one honest line — the
    ``.get()`` tolerance the rest of this tool is written with."""
    _fake_gateway(monkeypatch, lambda _c: {"entries": [
        {"kind": "email_thread", "at": "2026-08-04T14:00:00Z", "origin": "lead",
         "email_thread": {"thread_id": "t", "account_id": "a",
                          "message_id": "m"}},
        # A kind this build has never heard of must not take the answer down.
        {"kind": "future_kind", "at": "2026-08-03T09:00:00Z", "origin": "own"},
    ]})
    out = await _M.get_timeline("deals", _ID)

    assert "(no subject)" in out
    assert "unknown sender" in out
    assert "[from its lead]" in out
    assert "[]" not in out  # an absent status prints nothing, not empty brackets


async def test_get_timeline_shows_an_unrecognised_thread_status_verbatim(
    monkeypatch,
) -> None:
    """Same rule as the UI's ``threadStatusLabel``: the email app owns this
    vocabulary and may grow it, and hiding a value we do not recognise is how
    an agent starts disagreeing with the screen the user is looking at."""
    _fake_gateway(monkeypatch, lambda _c: {"entries": [
        {"kind": "email_thread", "at": "2026-08-04T14:00:00Z", "origin": "own",
         "email_thread": {"thread_id": "t", "account_id": "a",
                          "message_id": "m", "subject": "Hi",
                          "status": "SNOOZED"}},
    ]})
    assert "[SNOOZED]" in await _M.get_timeline("deals", _ID)


@pytest.mark.parametrize(
    ("given", "expected"),
    [("lead", "leads"), ("Deals", "deals"), ("opportunity", "deals"),
     ("account", "organizations"), ("company", "organizations"),
     ("person", "contacts")],
)
def test_entity_aliases_resolve_to_the_route_slug(given: str, expected: str) -> None:
    assert _M._entity_slug(given) == expected


# ── 4a. The record id is a UUID, or the request is never built ──────────────
#
# This fence was invisible to the first 48 cases because every one of them
# passed `str(uuid4())`. It is not a validation nicety: `record_id` is
# interpolated into the path, httpx removes `..` segments before sending, and
# the tool therefore became a general authenticated GET client against the whole
# gateway — carrying the internal bearer AND the acting user's header.
#
# The payloads below are the ones measured reaching real routes: they are kept
# verbatim so this file records what the hole actually was, not a sanitised
# rendering of it.

_TRAVERSALS = [
    ("../../admin/members", "/admin/members"),
    ("x/../../../email/messages", "/email/messages/timeline"),
    ("../../memory/agent:email-assistant", "/memory/agent:email-assistant"),
    ("../../admin/members/owner@fracktal.in/access", None),
    ("../../whatsapp/chats", None),
    ("..%2F..%2Fadmin%2Fmembers", None),
    ("../pipeline", None),
]


@pytest.mark.parametrize("payload", [p for p, _ in _TRAVERSALS])
@pytest.mark.parametrize("tool", ["get_record", "get_timeline"])
async def test_a_traversal_id_is_refused_before_any_request_is_built(
    tool: str, payload: str, monkeypatch,
) -> None:
    calls = _fake_gateway(monkeypatch, _responder)
    with pytest.raises(RuntimeError, match="Invalid CRM record id"):
        await getattr(_M, tool)("deals", payload)
    assert calls == [], (
        f"{tool}({payload!r}) reached the gateway at "
        f"{[c['path'] for c in calls]} — the agent can read outside the CRM"
    )


@pytest.mark.parametrize(
    "bad", ["ACME-123", "", "   ", "12345", "deal-42", "null", "undefined"],
)
@pytest.mark.parametrize("tool", ["get_record", "get_timeline"])
async def test_a_non_uuid_id_is_refused_here_not_relayed_as_a_driver_500(
    tool: str, bad: str, monkeypatch,
) -> None:
    """Second-order win: all four tables key on ``CAST(:id AS uuid)``, so a
    hallucinated id used to come back as a 500 from the driver."""
    calls = _fake_gateway(monkeypatch, _responder)
    with pytest.raises(RuntimeError, match="Invalid CRM record id"):
        await getattr(_M, tool)("leads", bad)
    assert calls == []


@pytest.mark.parametrize("tool", ["get_record", "get_timeline"])
async def test_a_real_uuid_still_works(tool: str, monkeypatch) -> None:
    """The guard must not cost the legitimate call — the failure mode of a fence
    added under review is that it refuses everything and nobody notices."""
    calls = _fake_gateway(monkeypatch, _responder)
    await getattr(_M, tool)("deals", _ID)
    assert len(calls) == 1
    assert calls[0]["path"].startswith(f"/crm/deals/{_ID}")


@pytest.mark.parametrize(
    "template",
    ["{0}", "{{{0}}}", "urn:uuid:{0}", "  {0}  "],
    ids=["plain", "braced", "urn", "padded"],
)
def test_alternate_uuid_spellings_are_normalised_to_the_canonical_form(
    template: str,
) -> None:
    """``uuid.UUID`` accepts braced/urn/unhyphenated forms, so the guard returns
    ``str(UUID(...))`` rather than the caller's string: whatever spelling the
    model produced, what reaches the path is 36 characters that cannot hold a
    separator."""
    assert _M._record_uuid(template.format(_ID)) == _ID


def test_unhyphenated_and_uppercase_ids_normalise_too() -> None:
    assert _M._record_uuid(_ID.replace("-", "")) == _ID
    assert _M._record_uuid(_ID.upper()) == _ID


def test_the_path_guard_is_structural_not_a_docstring() -> None:
    """The fence in the same spirit as the ``_ALLOWED_METHODS`` one.

    Every f-string that builds a ``/crm`` path may interpolate ONLY names that
    can hold a validated value: ``slug`` (from ``_entity_slug``) and ``record``
    (from ``_record_uuid``). A tool added later that drops a raw parameter —
    ``record_id``, ``entity``, ``query`` — straight into the path fails here,
    which is the exact mistake this commit is repairing.
    """
    validated = {"slug", "record"}
    source = (_AGENT_DIR / "agents.py").read_text(encoding="utf-8")
    offenders: list[str] = []
    for node in ast.walk(ast.parse(source)):
        if not isinstance(node, ast.JoinedStr) or not node.values:
            continue
        head = node.values[0]
        if not (isinstance(head, ast.Constant)
                and isinstance(head.value, str)
                and head.value.startswith("/crm")):
            continue
        for part in node.values:
            if not isinstance(part, ast.FormattedValue):
                continue
            name = getattr(part.value, "id", None)
            if name not in validated:
                offenders.append(
                    f"line {node.lineno}: interpolates "
                    f"{name or ast.dump(part.value)!r}"
                )
    assert offenders == [], (
        "a /crm path interpolates something no validator produced: "
        f"{offenders}. Route it through _entity_slug/_record_uuid and bind the "
        "result to `slug`/`record`."
    )


def test_an_unknown_entity_is_refused_not_defaulted() -> None:
    """The list kernel refuses an unknown sort key rather than falling back;
    answering about the wrong record type is the same class of silent wrong."""
    with pytest.raises(RuntimeError, match="Unknown CRM record type"):
        _M._entity_slug("invoices")


async def test_an_unknown_entity_never_reaches_the_gateway(monkeypatch) -> None:
    calls = _fake_gateway(monkeypatch, _responder)
    with pytest.raises(RuntimeError):
        await _M.get_record("invoices", _ID)
    assert calls == []


async def test_a_gateway_refusal_is_relayed_not_swallowed(monkeypatch) -> None:
    """A 403 from the feature gate must surface as a refusal the agent can
    repeat, not as an empty result that reads like "there is no such deal"."""
    calls: list[dict] = []

    class _Denying(_FakeClient):
        async def request(self, method: str, url: str, **kwargs: Any):
            calls.append({"method": method, "url": url})
            return _FakeResponse({"detail": "Feature 'crm' not enabled"}, 403)

    monkeypatch.setattr(
        _M, "httpx", SimpleNamespace(AsyncClient=lambda **_kw: _Denying(calls, None)))
    monkeypatch.setattr(_M, "_current_user_email", lambda: "nobody@fracktal.in")
    with pytest.raises(RuntimeError) as exc:
        await _M.get_pipeline()
    assert "403" in str(exc.value)
    assert "Feature 'crm' not enabled" in str(exc.value)


# ── 5. WhatsApp: "crm" is parse-only, and the test says so ───────────────────

wa_context = pytest.importorskip(
    "gateway.routes.whatsapp.transport.context",
    reason="gateway not installed in this environment",
)


def test_crm_is_a_known_entity_ref_system() -> None:
    assert "crm" in wa_context._KNOWN_SYSTEMS


@pytest.mark.parametrize("kind", ["lead", "deal", "contact", "organization"])
def test_a_crm_entity_ref_parses_into_a_deep_linkable_ref(kind: str) -> None:
    record_id = str(uuid4())
    ref = wa_context.parse_entity_ref(f"crm:{kind}:{record_id}")
    assert ref is not None
    assert (ref.system, ref.kind, ref.id) == ("crm", kind, record_id)


def test_an_unknown_system_still_degrades_to_unlinked() -> None:
    """Adding one system must not turn the allowlist into a pass-through."""
    assert wa_context.parse_entity_ref(f"salesforce:lead:{uuid4()}") is None
    assert wa_context.parse_entity_ref("crm:lead") is None
    assert wa_context.parse_entity_ref("crm::abc") is None


_GATEWAY_ROOT = REPO_ROOT / "apps" / "services" / "gateway" / "gateway"
_WHATSAPP_ROOT = _GATEWAY_ROOT / "routes" / "whatsapp"


def _string_literals(root: Path) -> list[tuple[str, str]]:
    """(file, string literal) for every .py under ``root``.

    Read through ``ast`` on purpose: a ``#`` comment is not a literal, so this
    cannot be satisfied — or tripped — by prose ABOUT the thing it is pinning.
    That is the trap the first version of this test fell into, matching the
    comment that documents the parse-only rule.
    """
    out: list[tuple[str, str]] = []
    for path in sorted(root.rglob("*.py")):
        try:
            tree = ast.parse(path.read_text(encoding="utf-8"))
        except SyntaxError:  # pragma: no cover — a broken file fails elsewhere
            continue
        rel = path.relative_to(REPO_ROOT).as_posix()
        out.extend(
            (rel, node.value)
            for node in ast.walk(tree)
            if isinstance(node, ast.Constant) and isinstance(node.value, str)
        )
    return out


def test_nothing_writes_a_crm_entity_ref_yet() -> None:
    """PARSE-ONLY, pinned. The linker that would write
    ``entity_ref = 'crm:<kind>:<uuid>'`` is a later slice; until it lands, this
    constant changes exactly one behaviour — a hand-set ref parses. If this test
    starts failing because a writer appeared, that writer owes the ``crm``
    context block too, and this pin should be REPLACED, not deleted.

    Scoped to the WhatsApp package: ``"crm:"`` is not a reserved string
    repo-wide (``routes/crm/broker_handlers.py`` uses ``"crm:zoho-sync"`` as the
    sync engine's actor label), and a fence that fires on an unrelated colon
    teaches nobody anything.
    """
    offenders = sorted({
        rel for rel, literal in _string_literals(_WHATSAPP_ROOT)
        if "crm:" in literal
    })
    assert offenders == [], f"something now emits a CRM entity_ref: {offenders}"


def test_nothing_writes_wa_contacts_entity_ref_at_all() -> None:
    """The wider truth this slice does not change: ``entity_ref`` is read-only
    everywhere in the gateway today — no route, importer or enricher sets it for
    ANY system. So adding ``"crm"`` to the allowlist cannot start producing
    links; it can only stop discarding one somebody typed in by hand."""
    offenders = sorted({
        rel
        for rel, literal in _string_literals(_GATEWAY_ROOT)
        if "entity_ref" in (low := literal.lower())
        and ("update " in low or "insert into" in low)
    })
    assert offenders == [], f"an entity_ref writer appeared in {offenders}"


def test_the_crm_context_block_is_still_unfilled() -> None:
    """The other half of parse-only: the model's ``crm`` block defaults to None,
    so a parsed ref is a deep link and nothing more."""
    model = wa_context.ChatContextModel(chat_id="c1")
    assert model.crm is None
    assert wa_context.ChatContextModel.model_fields["crm"].default is None

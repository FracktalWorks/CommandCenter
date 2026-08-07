"""The CRM assistant's four write tools (WS-26d-write).

Spec: ``ai-company-brain/specs/crm_app.md`` §9 ``### WS-26d-write``. The
whole-surface properties — registration, the verb allowlist, the path fence,
risk annotations across all eight tools — live in ``test_crm_agent.py``; what is
asserted HERE is what each write tool *does*.

The property this file exists for is one sentence: **nothing is written until a
human says so, and when there is no human, nothing is written.**

Three things follow from that, and each is tested separately because each fails
separately:

1. **Denied ⇒ no mutation.** The shape at
   ``test_email_tool_consolidation.py::test_digest_send_is_gated_and_fails_closed``.
   ⚠️ The invariant is *no mutation before consent*, not *no traffic before
   consent* — and the difference is deliberate. ``update_deal_status`` has to
   resolve "Negotiation" to a status id, and ``convert_lead`` has to know
   whether this lead has already been converted, BEFORE either can put an
   honest sentence on the confirmation card. A card that reads "move deal
   8f3c-… to <a stage nobody checked exists>" is not consent; it is a
   signature bought under a misdescription. So both may GET first, and the
   assertion is that the recorded calls contain no POST/PATCH — while
   ``create_lead`` and ``log_activity``, which need no pre-read, are held to
   literally zero calls.
2. **No channel ⇒ denied.** Asserted against the REAL
   ``request_confirmation``, not a stub returning False: the fail-closed
   behaviour is a property of that function's last line, and a test that stubs
   it proves only that the stub works. This is the one that catches
   ``non_interactive_default="approve"`` creeping in.
3. **Approved ⇒ exactly the intended request.** Endpoint and body both. A tool
   that confirms and then posts the wrong payload has passed the gate and
   failed the job.

Plus the two arguments that are NOT on the surface, because leaving them off is
the control: no ``owner_email`` anywhere (the route derives it from the acting
user), and no status/lost-reason UUID — those are given by name and resolved
here against the CRM's own vocabulary, which the tool reads and never writes.

Hermetic: no gateway, no DB, no network, no MAF runtime.
"""

from __future__ import annotations

import ast
import inspect
from typing import Any
from uuid import uuid4

import pytest

from tests.unit._crm_agent_fakes import (
    agent_source,
    approve,
    deny,
    fake_gateway,
    load_agent_module,
    writes,
)

_M = load_agent_module("crm_assistant_agent_write")

_USER = "sales@fracktal.in"

_LEAD_ID = str(uuid4())
_DEAL_ID = str(uuid4())
_NEW_LEAD_ID = str(uuid4())
_NEW_DEAL_ID = str(uuid4())
_CONTACT_ID = str(uuid4())
_ORG_ID = str(uuid4())

_QUALIFICATION = str(uuid4())
_NEGOTIATION = str(uuid4())
_CLOSED_LOST = str(uuid4())
_REASON_PRICE = str(uuid4())
_REASON_COMPETITOR = str(uuid4())

#: The deal stage vocabulary, as ``GET /crm/statuses/deal`` serves it. Three
#: lanes, one of them ``lost``-type — the lane the 422 lives behind.
_STATUSES = [
    {"id": _QUALIFICATION, "name": "Qualification", "type": "open",
     "probability": 10},
    {"id": _NEGOTIATION, "name": "Negotiation", "type": "open",
     "probability": 60},
    {"id": _CLOSED_LOST, "name": "Closed Lost", "type": "lost",
     "probability": 0},
]
_REASONS = [
    {"id": _REASON_PRICE, "label": "Price", "position": 10},
    {"id": _REASON_COMPETITOR, "label": "Chose a competitor", "position": 20},
]

_DEAL = {"id": _DEAL_ID, "name": "Acme AMC", "amount": 250000.0,
         "currency": "INR", "owner_email": _USER}
_LEAD = {"id": _LEAD_ID, "lead_name": "Ravi Menon", "email": "ravi@acme.test",
         "organization_name": "Acme Industries", "owner_email": _USER}

_WRITE_TOOLS = ["create_lead", "update_deal_status", "log_activity",
                "convert_lead"]


def _responder(call: dict) -> Any:
    """The gateway, as far as these tools can tell.

    Raises on a route no tool should ever reach: a write tool that wanders is a
    failure this file should report, not a KeyError three asserts later.
    """
    path, method, body = call["path"], call["method"], call["json"] or {}
    if path == "/crm/statuses/deal" and method == "GET":
        return _STATUSES
    if path == "/crm/lost-reasons" and method == "GET":
        return _REASONS
    if path == f"/crm/deals/{_DEAL_ID}":
        return {**_DEAL, **body}
    if path == f"/crm/leads/{_LEAD_ID}" and method == "GET":
        return dict(_LEAD)
    if path == f"/crm/leads/{_LEAD_ID}/convert" and method == "POST":
        return {
            "lead": {**_LEAD, "converted_deal_id": _NEW_DEAL_ID},
            "deal": {"id": _NEW_DEAL_ID,
                     "name": (body.get("deal") or {}).get("name") or "Acme AMC"},
            "contact": {"id": _CONTACT_ID},
            "organization": {"id": _ORG_ID},
        }
    if path.endswith("/activities") and method == "POST":
        return {"id": str(uuid4()), **body}
    if path == "/crm/leads" and method == "POST":
        return {**body, "id": _NEW_LEAD_ID, "owner_email": _USER}
    raise AssertionError(f"a tool reached an unexpected route: {method} {path}")


def _gateway(monkeypatch, responder: Any = _responder) -> list[dict]:
    return fake_gateway(_M, monkeypatch, responder, user=_USER)


#: Each write tool with arguments that would succeed. Used by every property
#: that holds for all four, so a fifth write tool cannot be added without
#: appearing here.
_CALLS: dict[str, Any] = {
    "create_lead": lambda: _M.create_lead(
        "Ravi Menon", email="ravi@acme.test",
        organization_name="Acme Industries",
    ),
    "update_deal_status": lambda: _M.update_deal_status(_DEAL_ID, "Negotiation"),
    "log_activity": lambda: _M.log_activity(
        "deals", _DEAL_ID, "call", "Intro call", body="Discussed the AMC",
    ),
    "convert_lead": lambda: _M.convert_lead(_LEAD_ID, deal_name="Acme AMC"),
}

#: The two tools that need nothing from the gateway before they can describe
#: what they are about to do. They are held to a strictly stronger rule.
_NO_PRE_READ = ["create_lead", "log_activity"]


def test_the_call_table_covers_every_write_tool() -> None:
    annotations = pytest.importorskip("acb_skills.tool_annotations")
    declared = {
        fn.__name__ for fn in _M._TOOLS
        if (annotations.TOOL_ANNOTATIONS.get(fn.__name__) or {}).get("destructive")
    }
    assert set(_CALLS) == declared == set(_WRITE_TOOLS)


# ── 1. Denied ⇒ nothing was written ─────────────────────────────────────────

@pytest.mark.parametrize("tool", _WRITE_TOOLS)
async def test_a_denied_confirmation_writes_nothing(tool: str, monkeypatch) -> None:
    """The gate, from the user's side: they said no, so nothing happened."""
    asked = deny(monkeypatch)
    calls = _gateway(monkeypatch)
    out = await _CALLS[tool]()
    assert "cancelled" in out.lower(), f"{tool} did not say it was cancelled: {out}"
    assert writes(calls) == [], (
        f"{tool} mutated the CRM after the user declined: "
        f"{[(c['method'], c['path']) for c in writes(calls)]}"
    )
    assert len(asked) == 1, f"{tool} showed {len(asked)} confirmation cards"


@pytest.mark.parametrize("tool", _NO_PRE_READ)
async def test_a_denied_confirmation_costs_no_gateway_call_at_all(
    tool: str, monkeypatch,
) -> None:
    """The strict form, for the two tools that owe nothing to a pre-read.

    Kept separate from the test above rather than merged into it: collapsing
    them would either weaken these two to "no writes" or falsely accuse the
    other two of a violation they cannot avoid, and both losses are silent.
    """
    deny(monkeypatch)
    calls = _gateway(monkeypatch)
    await _CALLS[tool]()
    assert calls == [], f"{tool} called the gateway before it had consent: {calls}"


@pytest.mark.parametrize("tool", _WRITE_TOOLS)
async def test_everything_read_before_the_confirmation_is_a_read(
    tool: str, monkeypatch,
) -> None:
    """The general invariant behind both tests above, stated once.

    Whatever a tool does before the card goes up, it is a GET. This is what
    makes "reads may precede the confirmation" a bounded allowance rather than
    a loophole big enough to walk a POST through.
    """
    before: list[dict] = []
    calls = _gateway(monkeypatch)

    async def _snapshot(**_kw: Any) -> bool:
        before.extend(calls)
        return False

    import acb_skills.ask_tools as ask_tools
    monkeypatch.setattr(ask_tools, "request_confirmation", _snapshot)
    await _CALLS[tool]()
    assert all(c["method"] == "GET" for c in before), (
        f"{tool} issued {[(c['method'], c['path']) for c in before if c['method'] != 'GET']} "
        "before anybody approved anything"
    )


# ── 2. No channel ⇒ denied (the real function, not a stub) ──────────────────

@pytest.mark.parametrize("tool", _WRITE_TOOLS)
async def test_a_non_interactive_run_writes_nothing(tool: str, monkeypatch) -> None:
    """Fail-closed, against the REAL ``request_confirmation``.

    Nothing is patched over the gate here. With no ``_active_run_queue`` and no
    relay thread — which is every automated run, and this test process — it
    falls through to ``non_interactive_default``, whose default is ``"deny"``.
    A tool that passed ``"approve"`` would silently write the live CRM from an
    unattended run; that is the failure this test is for, and a stub returning
    False could never see it.
    """
    calls = _gateway(monkeypatch)
    out = await _CALLS[tool]()
    assert "cancelled" in out.lower(), f"{tool} proceeded unattended: {out}"
    assert writes(calls) == [], f"{tool} wrote the CRM with nobody in the loop"


def test_no_call_in_the_module_opts_out_of_failing_closed() -> None:
    """Structural, in the spirit of the path guard: assert the ABSENCE.

    ``non_interactive_default="approve"`` is a legitimate per-call opt-out for
    reversible actions, so nothing stops one being added here later — except
    this. It fires on the keyword being passed AT ALL, not on the value being
    "approve": a CRM write has no business making that decision explicitly,
    and pinning the argument rather than the value means the mutant does not
    get to pick a spelling ("Approve", " approve") the fence does not know.
    """
    offenders: list[str] = []
    for node in ast.walk(ast.parse(agent_source())):
        if not isinstance(node, ast.Call):
            continue
        for keyword in node.keywords:
            if keyword.arg == "non_interactive_default":
                offenders.append(f"line {node.lineno}")
    assert offenders == [], (
        "a CRM write tool opts out of failing closed at "
        f"{offenders}. That opt-out is for reversible actions; a CRM row is "
        "born zoho_dirty and queues for the live tenant (D-CRM-9)."
    )


def _tool_def(name: str) -> ast.AsyncFunctionDef:
    for node in ast.walk(ast.parse(agent_source())):
        if isinstance(node, ast.AsyncFunctionDef) and node.name == name:
            return node
    raise AssertionError(f"{name} is not defined in the agent module")


def _call_lines(fn: ast.AST, names: set[str]) -> list[int]:
    found = []
    for node in ast.walk(fn):
        if not isinstance(node, ast.Call):
            continue
        ident = getattr(node.func, "id", None) or getattr(node.func, "attr", None)
        if ident in names:
            found.append(node.lineno)
    return sorted(found)


@pytest.mark.parametrize("tool", _WRITE_TOOLS)
def test_the_confirmation_is_asked_for_before_the_write_is_issued(tool: str) -> None:
    """Source order, not just runtime behaviour.

    The behavioural tests above can only observe the paths they exercise; this
    one reads the function. A tool whose confirmation sits after the ``_post``
    — or on a branch that some argument combination skips — fails here.
    """
    fn = _tool_def(tool)
    confirmations = _call_lines(fn, {"request_confirmation"})
    mutations = _call_lines(fn, {"_post", "_patch"})
    assert confirmations, f"{tool} never asks for confirmation"
    assert mutations, f"{tool} issues no write at all — is it still a write tool?"
    assert min(confirmations) < min(mutations), (
        f"{tool} writes at line {min(mutations)} but only confirms at "
        f"{min(confirmations)}"
    )


# ── 3. Approved ⇒ exactly the intended request ──────────────────────────────

async def test_create_lead_posts_the_lead_and_says_who_owns_it(monkeypatch) -> None:
    cards = approve(monkeypatch)
    calls = _gateway(monkeypatch)
    out = await _CALLS["create_lead"]()

    assert [(c["method"], c["path"]) for c in calls] == [("POST", "/crm/leads")]
    assert calls[0]["json"] == {
        "lead_name": "Ravi Menon",
        "source": "agent",
        "email": "ravi@acme.test",
        "organization_name": "Acme Industries",
    }
    assert _NEW_LEAD_ID in out and "Ravi Menon" in out
    # The card names the lead — the person approving must be able to tell what
    # they are approving without opening the CRM.
    assert "Ravi Menon" in cards[0]["detail"]


def test_create_lead_takes_no_owner_email_argument() -> None:
    """The identity argument that is not there.

    ``create_record`` already defaults ``owner_email`` to the acting user
    server-side, so surfacing it here would add an LLM-filled identity field
    whose only power is to attribute a lead to somebody who never asked for it
    — the same control class as ``_record_uuid``. If a tool ever needs to
    surface ownership, it reads it back; it does not write it.
    """
    params = set(inspect.signature(_M.create_lead).parameters)
    assert "owner_email" not in params
    assert "owner" not in params


async def test_create_lead_never_sends_an_owner(monkeypatch) -> None:
    approve(monkeypatch)
    calls = _gateway(monkeypatch)
    await _M.create_lead("Ravi Menon")
    assert "owner_email" not in (calls[0]["json"] or {})


async def test_create_lead_refuses_a_nameless_lead_without_asking(
    monkeypatch,
) -> None:
    """A tool that cannot succeed should not spend somebody's attention on a
    card first."""
    cards = approve(monkeypatch)
    calls = _gateway(monkeypatch)
    out = await _M.create_lead("   ")
    assert "needs a name" in out
    assert calls == [] and cards == []


async def test_update_deal_status_resolves_the_stage_by_name(monkeypatch) -> None:
    cards = approve(monkeypatch)
    calls = _gateway(monkeypatch)
    out = await _M.update_deal_status(_DEAL_ID, "negotiation")

    assert [(c["method"], c["path"]) for c in calls] == [
        ("GET", f"/crm/deals/{_DEAL_ID}"),
        ("GET", "/crm/statuses/deal"),
        ("PATCH", f"/crm/deals/{_DEAL_ID}"),
    ]
    # The id never came from the model: it came from the vocabulary read.
    assert calls[-1]["json"] == {"status_id": _NEGOTIATION}
    # The card shows the RESOLVED lane, spelled the way the board spells it.
    assert "Negotiation" in cards[0]["title"]
    assert "Acme AMC" in cards[0]["detail"]
    assert "Acme AMC" in out and "Negotiation" in out


async def test_an_unknown_stage_is_refused_with_the_real_lane_names(
    monkeypatch,
) -> None:
    cards = approve(monkeypatch)
    calls = _gateway(monkeypatch)
    out = await _M.update_deal_status(_DEAL_ID, "Nearly Closed")

    assert writes(calls) == []
    assert cards == [], "a stage that does not exist was put in front of a human"
    assert "Nearly Closed" in out
    for lane in ("Qualification", "Negotiation", "Closed Lost"):
        assert lane in out, f"the refusal does not name {lane}"


async def test_moving_to_a_lost_stage_needs_a_lost_reason(monkeypatch) -> None:
    """The 422 the demo would otherwise hit on "close this as lost".

    ``_resolve_status``/``apply_status_transition`` refuse a lost-type target
    with no ``lost_reason_id``. Answering that here — with the list of reasons
    that exist — is the difference between "I can't, here are the options" and
    a relayed error the model will retry verbatim.
    """
    cards = approve(monkeypatch)
    calls = _gateway(monkeypatch)
    out = await _M.update_deal_status(_DEAL_ID, "Closed Lost")

    assert writes(calls) == []
    assert cards == []
    assert "Price" in out and "Chose a competitor" in out


async def test_an_unknown_lost_reason_is_refused_never_invented(
    monkeypatch,
) -> None:
    approve(monkeypatch)
    calls = _gateway(monkeypatch)
    out = await _M.update_deal_status(
        _DEAL_ID, "Closed Lost", lost_reason="They ghosted us",
    )

    assert writes(calls) == [], "a lost reason was invented rather than refused"
    assert "They ghosted us" in out and "Price" in out


async def test_a_lost_move_sends_the_resolved_reason_id(monkeypatch) -> None:
    approve(monkeypatch)
    calls = _gateway(monkeypatch)
    await _M.update_deal_status(_DEAL_ID, "Closed Lost", lost_reason="price")

    assert calls[-1]["method"] == "PATCH"
    assert calls[-1]["json"] == {
        "status_id": _CLOSED_LOST, "lost_reason_id": _REASON_PRICE,
    }


async def test_the_vocabulary_is_only_ever_read(monkeypatch) -> None:
    """Ruling 2's second half: never create a reason (or a stage) to make a
    call succeed. Asserted over every lost-stage path, including the ones that
    refuse — the tempting place to "helpfully" mint the missing row."""
    approve(monkeypatch)
    calls = _gateway(monkeypatch)
    await _M.update_deal_status(_DEAL_ID, "Closed Lost")
    await _M.update_deal_status(_DEAL_ID, "Closed Lost", lost_reason="nope")
    await _M.update_deal_status(_DEAL_ID, "Closed Lost", lost_reason="Price")

    for call in calls:
        if call["path"] in ("/crm/lost-reasons", "/crm/statuses/deal"):
            assert call["method"] == "GET", (
                f"the agent wrote the CRM's vocabulary: {call['method']} "
                f"{call['path']}"
            )


async def test_log_activity_posts_to_the_records_own_activities_route(
    monkeypatch,
) -> None:
    approve(monkeypatch)
    calls = _gateway(monkeypatch)
    out = await _CALLS["log_activity"]()

    assert [(c["method"], c["path"]) for c in calls] == [
        ("POST", f"/crm/deals/{_DEAL_ID}/activities"),
    ]
    assert calls[0]["json"] == {
        "type": "call", "subject": "Intro call", "body": "Discussed the AMC",
    }
    assert "Intro call" in out


@pytest.mark.parametrize("kind", ["note", "call", "meeting", "task"])
async def test_every_loggable_type_is_accepted(kind: str, monkeypatch) -> None:
    approve(monkeypatch)
    calls = _gateway(monkeypatch)
    await _M.log_activity("deals", _DEAL_ID, kind, "Something happened")
    assert calls[0]["json"]["type"] == kind


@pytest.mark.parametrize("kind", ["status_change", "system", "email", "delete"])
async def test_a_type_the_platform_owns_is_refused_before_the_card(
    kind: str, monkeypatch,
) -> None:
    """``status_change`` is written by the pipeline. A hand-written one is a
    funnel event with no transition behind it — the route 422s, and relaying
    that 422 teaches the model less than naming the four types it may use."""
    cards = approve(monkeypatch)
    calls = _gateway(monkeypatch)
    out = await _M.log_activity("deals", _DEAL_ID, kind, "Subject")
    assert calls == [] and cards == []
    assert "note" in out and "call" in out


@pytest.mark.parametrize("kind", ["", "   ", "NOTE"])
async def test_an_unstated_type_is_a_note_rather_than_a_refusal(
    kind: str, monkeypatch,
) -> None:
    """"Log that I called them" arrives with a type; "log this" often does not,
    and a note is the honest default for it. Refusing here would trade a
    correct entry for a round trip that teaches nothing."""
    approve(monkeypatch)
    calls = _gateway(monkeypatch)
    await _M.log_activity("deals", _DEAL_ID, kind, "Subject")
    assert calls[0]["json"]["type"] == "note"


async def test_log_activity_reaches_every_entity(monkeypatch) -> None:
    """Both path segments are validated, and both are interpolated — this is
    the tool the extended AST fence was written for."""
    approve(monkeypatch)
    calls = _gateway(monkeypatch)
    for entity, slug in (("lead", "leads"), ("deal", "deals"),
                         ("contact", "contacts"), ("company", "organizations")):
        record = _DEAL_ID
        await _M.log_activity(entity, record, "note", "Noted")
        assert calls[-1]["path"] == f"/crm/{slug}/{record}/activities"


async def test_convert_lead_posts_the_deal_overrides_and_reports_the_new_ids(
    monkeypatch,
) -> None:
    approve(monkeypatch)
    calls = _gateway(monkeypatch)
    out = await _M.convert_lead(
        _LEAD_ID, deal_name="Acme AMC", amount=250000, expected_close_date="2026-09-30",
    )

    assert [(c["method"], c["path"]) for c in calls] == [
        ("GET", f"/crm/leads/{_LEAD_ID}"),
        ("POST", f"/crm/leads/{_LEAD_ID}/convert"),
    ]
    assert calls[-1]["json"] == {
        "deal": {"name": "Acme AMC", "amount": 250000.0,
                 "expected_close_date": "2026-09-30"},
    }
    assert _NEW_DEAL_ID in out and _CONTACT_ID in out and _ORG_ID in out


async def test_convert_lead_with_no_overrides_sends_an_empty_body(
    monkeypatch,
) -> None:
    """``/convert`` takes an optional body; "work it out" is a real request and
    must not become ``{"deal": {}}``, which would be a caller asserting empty
    overrides rather than none."""
    approve(monkeypatch)
    calls = _gateway(monkeypatch)
    await _M.convert_lead(_LEAD_ID)
    assert calls[-1]["json"] == {}


async def test_an_already_converted_lead_is_refused_and_points_at_its_deal(
    monkeypatch,
) -> None:
    """§8 B6 — the guard keys on ``converted_deal_id``."""
    cards = approve(monkeypatch)
    calls = _gateway(monkeypatch, lambda _c: {
        **_LEAD, "converted_at": "2026-08-01T10:00:00Z",
        "converted_deal_id": _NEW_DEAL_ID,
    })
    out = await _M.convert_lead(_LEAD_ID)

    assert writes(calls) == [], "a second deal was minted from one lead"
    assert cards == [], "a doomed conversion was put in front of a human"
    assert _NEW_DEAL_ID in out


async def test_a_lead_whose_deal_was_deleted_is_convertible_again(
    monkeypatch,
) -> None:
    """The other half of B6, and the reason the key matters.

    Deleting the deal SET-NULLs ``converted_deal_id`` while ``converted_at``
    survives as history. A guard reading the timestamp would strand this lead
    as permanently un-convertible — invisible in the lead list (it hides
    converted leads) and unreachable through the only tool that could fix it.
    """
    approve(monkeypatch)
    calls = _gateway(monkeypatch, lambda call: (
        {**_LEAD, "converted_at": "2026-08-01T10:00:00Z",
         "converted_deal_id": None}
        if call["method"] == "GET" else _responder(call)
    ))
    out = await _M.convert_lead(_LEAD_ID)

    assert [c["method"] for c in calls] == ["GET", "POST"]
    assert _NEW_DEAL_ID in out


# ── 4. Identity and path guards, on the write paths ─────────────────────────

@pytest.mark.parametrize("tool", _WRITE_TOOLS)
async def test_the_write_itself_carries_the_acting_user(
    tool: str, monkeypatch,
) -> None:
    """A bearer with no ``X-User-Email`` is read as the platform acting as
    itself and granted SERVICE_ACCESS (``acb_auth/deps.py`` §1b). On a read
    that is scope escape; on a write it is an unattributable row in shared
    team data."""
    approve(monkeypatch)
    calls = _gateway(monkeypatch)
    await _CALLS[tool]()
    mutations = writes(calls)
    assert mutations, f"{tool} issued no write"
    for call in mutations:
        assert call["headers"]["X-User-Email"] == _USER
        assert call["headers"]["Authorization"].startswith("Bearer ")


@pytest.mark.parametrize(
    "bad",
    ["../../admin/members", "x/../../../email/messages", "ACME-123", "",
     "..%2F..%2Fadmin%2Fmembers"],
)
@pytest.mark.parametrize(
    "tool", ["update_deal_status", "log_activity", "convert_lead"],
)
async def test_a_bad_record_id_never_reaches_the_gateway_or_a_human(
    tool: str, bad: str, monkeypatch,
) -> None:
    """The read half's hole, pointed at a write: httpx removes ``..`` segments
    before the request leaves, so an unvalidated id turned the tool into a
    general authenticated client against the whole gateway — with a body
    attached, on this half."""
    cards = approve(monkeypatch)
    calls = _gateway(monkeypatch)
    invoke = {
        "update_deal_status": lambda: _M.update_deal_status(bad, "Negotiation"),
        "log_activity": lambda: _M.log_activity("deals", bad, "note", "x"),
        "convert_lead": lambda: _M.convert_lead(bad),
    }[tool]
    with pytest.raises(RuntimeError, match="Invalid CRM record id"):
        await invoke()
    assert calls == [] and cards == []


async def test_an_unknown_entity_never_reaches_the_gateway_or_a_human(
    monkeypatch,
) -> None:
    cards = approve(monkeypatch)
    calls = _gateway(monkeypatch)
    with pytest.raises(RuntimeError, match="Unknown CRM record type"):
        await _M.log_activity("invoices", _DEAL_ID, "note", "x")
    assert calls == [] and cards == []

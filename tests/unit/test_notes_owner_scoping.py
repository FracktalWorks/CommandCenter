"""Notes is private to its owner — reads, deletes, and acting-as.

Spec: ``ai-company-brain/specs/note_taker_app.md``. Four live defects, all
reachable by any member holding ``feature:notes``:

1. ``GET /notes/meetings`` had no owner filter, and its ``query`` parameter
   searches ``m.transcript`` — so the library was a full-text search over every
   recorded conversation in the company.
2. ``_load_meeting`` had no owner filter, so ``GET``/``PATCH``/``PUT`` and the
   hard ``DELETE`` all addressed any colleague's meeting by id.
3. Dispatch acts AS the meeting's owner — ``_dispatch_email`` opens a provider
   session on ``meeting.owner_email`` and SENDS. Neither of the two dispatch
   endpoints checked that the acting caller was that person.
4. ...and neither did the OTHER two routes into ``_dispatch``. ``POST
   /meetings/{id}/summarize`` and ``POST /meetings/{id}/retranscribe`` took no
   owner check and ran notes generation, which deletes the meeting's
   un-promoted draft action items and then calls ``auto_dispatch`` — which
   passed a sentinel actor (``"auto"``) that ``cross_owner_refusal`` waved
   through. So the fix for (3) was reachable around: ask the platform to
   re-summarise a colleague's meeting and the colleague's mailbox sends.
   The sentinel is gone; the triggering member's identity is threaded down
   instead, and the two endpoints are owner-scoped as well, because destroying
   a colleague's action items is its own defect.

These tests need no database: the meeting reads run against a fake session that
plays Postgres for exactly the owner predicate, and the dispatch rules are pure.
"""
from __future__ import annotations

import inspect
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

ALICE = "alice@fracktal.in"
BOB = "bob@fracktal.in"


def _meeting(
    mid: str, owner: str | None, title: str = "Q3 pricing", transcript: str = "",
) -> SimpleNamespace:
    return SimpleNamespace(
        id=mid, title=title, transcript=transcript,
        platform="upload", status="ready", language="en",
        duration_s=600.0, owner_email=owner, start_at=None, created_at=None,
        template_key=None, scheduled_at=None, copilot_enabled=None,
        segment_count=0, has_notes=False, pending_actions=0, action_count=0,
        agenda_count=0, has_brief=False, attendee_count=0, is_live=False,
        transcript_source="upload", summary_md="the number is 4cr",
        summary_json=None, scratch_notes=None, attendees=[], speaker_names={},
    )


def _action(kind: str = "email", meeting_id: str = "m-alice") -> SimpleNamespace:
    return SimpleNamespace(
        id="a1", meeting_id=meeting_id, description="send the quote",
        confidence=0.95, status="draft", due_hint=None, segment_ids=[],
        resulting_task_id=None, kind=kind,
        payload={"email_to": "customer@acme.com"},
        dispatch_ref=None, dispatch_error=None, created_at=None,
    )


class _FakeResult:
    def __init__(self, rows: list) -> None:
        self._rows = rows

    def fetchall(self) -> list:
        return list(self._rows)

    def fetchone(self):
        return self._rows[0] if self._rows else None


class _FakeDb:
    """Enough async session to answer the meeting reads, without Postgres.

    It plays the database for ONE predicate — the owner scope — and it decides
    whether to apply it by looking at the PARAMETERS the route bound, not at
    the SQL text. That matters: an earlier version keyed on the literal string
    ``"owner_email = :owner"``, so making the comparison case-insensitive (a
    fix) would have made the fake stop filtering (a false pass). A query that
    binds ``:owner`` is a query that means to scope; one that does not, is not.
    """

    def __init__(self, meetings: list, actions: list | None = None) -> None:
        self.meetings = meetings
        self.actions = list(actions or [])
        self.statements: list[tuple[str, dict]] = []

    async def execute(self, stmt, params=None):
        sql, params = str(stmt), dict(params or {})
        self.statements.append((sql, params))
        # Most specific first: the library SELECT counts action items in a
        # subquery, so testing "FROM action_item" first would misroute it.
        # "FROM meeting m" = library + core.load_owned_meeting;
        # "FROM meeting WHERE" = dispatch._load_meeting (unscoped by design —
        # the dispatch seam does the owner check itself, on the loaded row).
        is_meeting_read = "FROM meeting m" in sql or "FROM meeting WHERE" in sql
        if not is_meeting_read:
            if "FROM action_item" in sql:
                return _FakeResult(list(self.actions))
            return _FakeResult([])          # recordings / segments / runs
        rows = list(self.meetings)
        if ":id" in sql:
            rows = [m for m in rows if str(m.id) == str(params.get("id"))]
        if params.get("q"):
            needle = str(params["q"]).casefold()
            rows = [
                m for m in rows
                if needle in (m.title or "").casefold()
                or needle in (m.transcript or "").casefold()
            ]
        if "owner" in params:
            owner = str(params.get("owner") or "").casefold()
            rows = [
                m for m in rows
                if (m.owner_email or "").casefold() == owner
                or m.owner_email is None
            ]
        return _FakeResult(rows)

    async def commit(self) -> None:
        return None

    async def __aenter__(self) -> _FakeDb:
        return self

    async def __aexit__(self, *exc) -> bool:
        return False


def _install_db(monkeypatch, module, db: _FakeDb) -> _FakeDb:
    async def _get_db():
        return db

    monkeypatch.setattr(module, "_get_db", _get_db)
    return db


@pytest.fixture
def two_libraries(monkeypatch):
    """Alice owns one meeting, Bob owns another, and one legacy row has no
    owner at all (the column arrived nullable in migration 95)."""
    from gateway.routes.notes import meetings as m

    return _install_db(monkeypatch, m, _FakeDb([
        _meeting("m-alice", ALICE, "Alice 1:1", "performance review"),
        _meeting("m-bob", BOB, "Bob and the customer", "we can go to 40% off"),
        _meeting("m-legacy", None, "Before owners existed", ""),
    ]))


def _user(email: str):
    from acb_auth import UserContext, UserRole

    return UserContext(email=email, role=UserRole.EMPLOYEE)


# ── 1. The library is yours ──────────────────────────────────────────────────

async def test_the_library_lists_only_your_own_meetings(two_libraries) -> None:
    from gateway.routes.notes.meetings import list_meetings

    titles = {m.title for m in await list_meetings(user=_user(ALICE))}
    assert "Alice 1:1" in titles
    assert "Bob and the customer" not in titles


async def test_the_transcript_search_cannot_reach_a_colleagues_transcript(
    two_libraries,
) -> None:
    """`query` runs against `m.transcript`. Unscoped, it read everyone's."""
    from gateway.routes.notes.meetings import list_meetings

    # The words are Bob's, in the body of his customer call.
    found = await list_meetings(query="40% off", user=_user(ALICE))
    assert [m.title for m in found] == []
    # ...and Bob still finds them.
    assert [m.title for m in await list_meetings(query="40% off", user=_user(BOB))] == [
        "Bob and the customer"
    ]


async def test_a_legacy_meeting_with_no_owner_stays_visible(two_libraries) -> None:
    """Fail-safe, deliberately: excluding NULL-owner rows would make a
    member's own pre-ownership meetings vanish rather than protect anyone.
    Both insert paths stamp an owner, so the set cannot grow.

    Asserted against the WHOLE result, not just "the legacy row is in there" —
    an implementation with no owner filter at all also returns the legacy row,
    so the presence of one row proves nothing on its own. What this pins is
    that the same query keeps the legacy row AND drops Alice's.
    """
    from gateway.routes.notes.meetings import list_meetings

    titles = {m.title for m in await list_meetings(user=_user(BOB))}
    assert titles == {"Bob and the customer", "Before owners existed"}


async def test_a_differently_cased_sign_in_still_sees_its_own_library(
    two_libraries,
) -> None:
    """`owner_email` is stamped verbatim from `X-User-Email`, and an IdP can
    return the same UPN cased differently between sessions (Entra ID does).
    Byte equality fails CLOSED — the member's library silently empties — which
    is the "locked out of my own work" shape, not a leak, but still a defect.
    """
    from gateway.routes.notes.meetings import list_meetings

    titles = {m.title for m in await list_meetings(user=_user("Alice@Fracktal.IN"))}
    assert "Alice 1:1" in titles
    assert "Bob and the customer" not in titles


# ── 2. Every by-id endpoint goes through the same door ───────────────────────

async def test_opening_a_colleagues_meeting_is_404(two_libraries) -> None:
    from gateway.routes.notes.meetings import get_meeting

    with pytest.raises(HTTPException) as exc:
        await get_meeting("m-bob", user=_user(ALICE))
    assert exc.value.status_code == 404


async def test_deleting_a_colleagues_meeting_is_404(two_libraries) -> None:
    """The one that is irreversible: recording, transcript, notes and action
    items all cascade."""
    from gateway.routes.notes.meetings import delete_meeting

    with pytest.raises(HTTPException) as exc:
        await delete_meeting("m-bob", user=_user(ALICE))
    assert exc.value.status_code == 404


async def test_patching_a_colleagues_meeting_is_404(two_libraries) -> None:
    from gateway.routes.notes.core import PatchMeetingRequest
    from gateway.routes.notes.meetings import patch_meeting

    with pytest.raises(HTTPException) as exc:
        await patch_meeting(
            "m-bob", PatchMeetingRequest(title="renamed"), user=_user(ALICE)
        )
    assert exc.value.status_code == 404


async def test_you_can_still_open_your_own_meeting(two_libraries) -> None:
    """The fix has to be a scope, not a wall."""
    from gateway.routes.notes.meetings import get_meeting

    detail = await get_meeting("m-alice", user=_user(ALICE))
    assert detail.title == "Alice 1:1"
    assert detail.summary_md == "the number is 4cr"


# ── 3. Dispatch never acts as somebody else ──────────────────────────────────

def test_the_owner_may_dispatch() -> None:
    from gateway.routes.notes.dispatch import cross_owner_refusal

    assert cross_owner_refusal(ALICE, ALICE) is None
    assert cross_owner_refusal(ALICE, "  ALICE@fracktal.in ") is None
    assert cross_owner_refusal(None, BOB) is None  # legacy row, nobody acted as


def test_a_colleague_may_not() -> None:
    from gateway.routes.notes.dispatch import cross_owner_refusal

    refusal = cross_owner_refusal(ALICE, BOB)
    assert refusal and "another member" in refusal


def test_there_is_no_sentinel_actor_that_passes_the_check() -> None:
    """The regression this file exists for.

    ``cross_owner_refusal`` used to return None for ``actor == "auto"``, on the
    reasoning that ``auto_dispatch`` is the owner's own standing instruction.
    It is not: every background job that reaches ``auto_dispatch`` is started
    by somebody's HTTP request, so the sentinel was a bypass reachable by
    asking the platform to re-summarise a colleague's meeting. Nothing but
    being the owner may pass.
    """
    from gateway.routes.notes import dispatch as d

    assert not hasattr(d, "AUTOMATIC_ACTOR")
    for impostor in ("auto", "system", "system:internal", "", "  ", "AUTO"):
        assert d.cross_owner_refusal(ALICE, impostor), impostor


async def test_sending_from_another_members_mailbox_is_refused() -> None:
    """The seam that actually sends, checked before it opens anything."""
    from gateway.routes.notes.dispatch import DispatchError, _dispatch_email

    with pytest.raises(DispatchError) as exc:
        await _dispatch_email(_action(), _meeting("m-alice", ALICE), ALICE, BOB)
    assert "another member" in str(exc.value)


async def test_dispatch_refuses_before_reaching_any_kinds_handler(
    monkeypatch,
) -> None:
    """All four routes reach ``_dispatch``; the check lives at the seam they
    share, so none can inherit the hole. Nothing kind-specific may run."""
    from gateway.routes.notes import dispatch as d

    async def _must_not_run(*args, **kwargs):
        raise AssertionError("dispatched on another member's behalf")

    audited: list[tuple] = []

    async def _audit(actor, action_id, meeting_id, kind, ref, error):
        audited.append((actor, kind, error))

    monkeypatch.setattr(d, "_dispatch_email", _must_not_run)
    monkeypatch.setattr(d, "_dispatch_document", _must_not_run)
    monkeypatch.setattr(d, "_create_task_from_action", _must_not_run)
    monkeypatch.setattr(d, "_mark", _must_not_run)
    monkeypatch.setattr(d, "_audit", _audit)

    ref, error = await d._dispatch(_action(), _meeting("m-alice", ALICE), BOB)

    assert ref is None
    assert error and "another member" in error
    # The attempt is recorded — acting as a colleague is what an audit trail
    # exists to catch.
    assert audited and audited[0][0] == BOB


# ── 4. The automatic path carries the trigger's identity, not a sentinel ─────

@pytest.fixture
def auto_dispatch_rig(monkeypatch):
    """Alice's meeting, one confident draft email item, auto-send switched on.

    ``auto_dispatch_emails`` defaults to True in ``settings.load`` and a member
    with no ``copilot_config`` row gets the defaults, so this is the shipped
    configuration, not a contrived one.
    """
    from gateway.routes.notes import dispatch as d
    from gateway.routes.notes import settings as notes_settings

    _install_db(
        monkeypatch, d,
        _FakeDb([_meeting("m-alice", ALICE)], actions=[_action("email")]),
    )

    async def _load(_owner):
        return SimpleNamespace(
            auto_dispatch_tasks=True, auto_dispatch_emails=True,
            auto_dispatch_docs=True,
        )

    monkeypatch.setattr(notes_settings, "load", _load)

    sent: list[tuple] = []

    async def _send(action, meeting, owner_email, actor):
        sent.append((owner_email, actor))
        return "sent:msg-1"

    async def _noop(*args, **kwargs):
        return None

    monkeypatch.setattr(d, "_dispatch_email", _send)
    monkeypatch.setattr(d, "_mark", _noop)
    monkeypatch.setattr(d, "_audit", _noop)
    return d, sent


async def test_auto_dispatch_triggered_by_a_colleague_sends_nothing(
    auto_dispatch_rig,
) -> None:
    """THE P0.

    Bob holds ``feature:notes`` and knows the id of Alice's meeting. He calls
    ``POST /notes/meetings/{alice_id}/summarize`` (or ``/retranscribe``).
    Generation re-extracts the action items and hands them to
    ``auto_dispatch``. Before this fix that call passed ``AUTOMATIC_ACTOR``,
    ``cross_owner_refusal`` returned None for it, the ``_dispatch_email``
    backstop returned None for it too, and a real LLM-drafted email left
    Alice's mailbox for a real external address on Bob's say-so.

    Nothing about the confidence gate helps: ``MIN_AUTO_CONFIDENCE`` is an LLM
    score, not an authorization.
    """
    d, sent = auto_dispatch_rig

    result = await d.auto_dispatch("m-alice", BOB)

    assert sent == [], "a colleague's request made the owner's mailbox send"
    assert result["dispatched"] == 0
    assert result["failed"] == 1


async def test_auto_dispatch_triggered_by_the_owner_still_sends(
    auto_dispatch_rig,
) -> None:
    """...and the fix is a scope, not a wall. Alice asking for her own notes
    still gets her own auto-dispatch — otherwise this "fix" would simply have
    switched the feature off."""
    d, sent = auto_dispatch_rig

    result = await d.auto_dispatch("m-alice", ALICE)

    assert sent == [(ALICE, ALICE)]
    assert result["dispatched"] == 1


def test_the_whole_chain_demands_a_triggering_identity() -> None:
    """The identity is threaded through four function boundaries between the
    endpoint and the send. Every one of them takes it as a REQUIRED parameter,
    so a caller that forgets is a ``TypeError`` at import-or-call time rather
    than a silent return to acting as anybody.
    """
    from gateway.routes.notes.dispatch import auto_dispatch
    from gateway.routes.notes.pipeline import run_transcription
    from gateway.routes.notes.summaries import enqueue_summary, generate_notes

    for fn in (auto_dispatch, enqueue_summary, generate_notes, run_transcription):
        param = inspect.signature(fn).parameters.get("triggered_by")
        assert param is not None, f"{fn.__name__} lost the triggering identity"
        assert param.default is inspect.Parameter.empty, (
            f"{fn.__name__}.triggered_by has a default; a dropped argument "
            "must not silently resolve to somebody"
        )


# ── 5. ...and the two entry endpoints are owner-scoped in their own right ────

async def test_summarizing_a_colleagues_meeting_is_404(monkeypatch) -> None:
    """Independent of the dispatch seam: generation DELETES the meeting's
    un-promoted draft action items before re-extracting them, so an unscoped
    endpoint let any member destroy a colleague's triage queue whether or not
    anything was ever dispatched."""
    from gateway.routes.notes import summaries

    _install_db(monkeypatch, summaries, _FakeDb([
        _meeting("m-alice", ALICE), _meeting("m-bob", BOB),
    ]))

    with pytest.raises(HTTPException) as exc:
        await summaries.summarize("m-bob", user=_user(ALICE))
    assert exc.value.status_code == 404
    assert exc.value.detail == "meeting not found"


async def test_retranscribing_a_colleagues_meeting_is_404(monkeypatch) -> None:
    from gateway.routes.notes import recordings

    _install_db(monkeypatch, recordings, _FakeDb([
        _meeting("m-alice", ALICE), _meeting("m-bob", BOB),
    ]))

    with pytest.raises(HTTPException) as exc:
        await recordings.retranscribe("m-bob", user=_user(ALICE))
    assert exc.value.status_code == 404
    assert exc.value.detail == "meeting not found"


async def test_summarizing_your_own_meeting_still_works(monkeypatch) -> None:
    """The owner half of the same check — 404-ing everybody would 'fix' this
    by breaking the feature."""
    from gateway.routes.notes import summaries

    _install_db(monkeypatch, summaries, _FakeDb([_meeting("m-alice", ALICE)]))

    queued: list[tuple] = []

    async def _enqueue(meeting_id, triggered_by):
        queued.append((meeting_id, triggered_by))
        return "run-1"

    monkeypatch.setattr(summaries, "enqueue_summary", _enqueue)

    out = await summaries.summarize("m-alice", user=_user(ALICE))
    assert out == {"run_id": "run-1", "status": "queued"}
    assert queued == [("m-alice", ALICE)]

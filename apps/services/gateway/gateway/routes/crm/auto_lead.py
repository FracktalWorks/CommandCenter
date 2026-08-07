"""CRM · auto_lead — an unknown inbound sender becomes a lead (WS-26d-autolead).

Spec: ``ai-company-brain/specs/crm_app.md`` §9 ``WS-26d-autolead`` · D-CRM-9 ·
D-CRM-12. Migration: ``crm_auto_lead_cursors``.

**This module registers no routes.** Like ``broker_handlers``, it is deliberately
absent from ``routes/crm/__init__.py``: its one entry point,
:func:`create_leads_from_new_mail`, is called from the email app's shared
new-mail hook (``routes/email/scheduler_hooks.py::process_new_mail``) — the one
seam the background scheduler, the manual-sync route and the Graph webhook all
funnel through, so mail is considered identically however it arrived.

**It lives in ``routes/crm`` and not in the email package** because what it
does is write a CRM record: it owns a CRM cursor table, it goes through the
CRM's own service write path, and it is gated by a CRM owner gate. It borrows
the email automation package's PUBLIC identity primitives
(``sender_scope`` / ``resolve_org_domains`` / ``normalize_domain``) rather than
copying them — D-CRM-4 declined to import another route package's *private*
helper, and "is this person a colleague?" already has one public answer across
the automation package. A third copy of it here would be the drift the rule
exists to prevent.

Four properties are load-bearing, and each one is a way this feature can do
real damage rather than merely be wrong:

1. **The flag is read BEFORE the step is entered.** ``CRM_AUTO_LEAD`` ships OFF
   and :func:`auto_lead_enabled` is its single definition, but the *call site*
   is what is guarded — with the flag off nothing here runs and no CRM query is
   issued on the mail path at all. A short-circuit *inside* this module would
   satisfy a careless test and still open a database session on every sync
   cycle of every mailbox.

2. **Two cursor predicates, together.** ``process_new_mail`` is also reached by
   deep resyncs and by the first-ever sync of a newly connected mailbox, and
   neither marks the mail it classifies as history. ``received_at >
   activated_at`` is therefore the backfill discriminator (mail that ARRIVED
   before auto-lead was first active on the account mints nothing, whenever it
   is classified), and ``rules_processed_at > processed_watermark`` is the
   incremental cursor. Without the first, connecting a second mailbox mints a
   lead per unknown sender in a year of mail — each born ``zoho_dirty`` and
   queued for the live Zoho tenant within one 600s cycle.

3. **"Unknown" is three questions, and "external" is only necessary.**
   :func:`_is_unknown_sender` mirrors ``senders._maybe_block_cold``'s two steps
   (the cold-sender memo, then "have we ever emailed them") and adds a third
   (no ``crm_contacts`` / ``crm_leads`` row already carries the address).
   Separately, :func:`_is_external_sender` runs TWO gates, because
   ``sender_scope`` fails SAFE to ``"external"`` — the wrong direction here. A
   lead row for your own CFO, pushed into the live Zoho tenant, is what the
   second gate exists to prevent.

4. **The first activity is metadata, never content** (D-CRM-12 applied to what
   a machine writes). ``type='system'`` — deliberately outside the Zoho push
   predicate, so the activity never leaves the native CRM — subject and sender
   in ``meta``, and ``body`` empty. Sender + subject is the proportionate
   disclosure for a cold inbound inquiry on an org-visible record; the mail
   body is not, and no snippet of it is either. This module never reads
   ``body_text`` or ``snippet``.

**One race is accepted and recorded** (spec §9): two concurrent
``process_new_mail`` invocations for one account can read the same watermark
and double-mint. The cost is one visible, hand-deletable duplicate lead. The
fix that suggests itself — a UNIQUE index on ``crm_leads.email`` — is a
deploy-blocking constraint on a column where 1,516 imported rows may already
carry duplicates, which is exactly the shape migration 148 had to defuse. Do
not add it.
"""

from __future__ import annotations

import json
from typing import Any

from acb_auth import UserContext, UserRole
from acb_common import get_settings
from gateway.routes.crm.core import (
    LEADS,
    LeadIn,
    _get_db,
    _log,
    bump_last_activity,
    insert_row,
    now,
    savepoint,
)
from gateway.routes.crm.records import create_record
from gateway.routes.email.automation.identity import (
    normalize_domain,
    resolve_org_domains,
    sender_scope,
)
from sqlalchemy import text

#: How many candidate messages one cycle may consider. A cap rather than a
#: full drain because this runs inside the mail-sync hook: an unbounded batch
#: after a busy weekend would hold the hook (and, transitively, the account's
#: next sync) for as long as it took. The remainder is NOT dropped — the
#: watermark advances only over what was considered, so the next cycle picks it
#: up — and the overflow is COUNTED in the log line, because silent truncation
#: reads as "covered everything".
MAX_CANDIDATES_PER_CYCLE = 200

#: The activity ``type`` the originating message is logged as. **Not 'note'.**
#: ``sync_zoho.push_activities`` pushes ``type IN ('note', 'task')`` only, so
#: 'system' is how this row stays inside the native CRM — the mail's subject
#: and sender never reach the Zoho tenant even though the lead itself does
#: (D-CRM-9). ``tests/unit/test_crm_auto_lead.py`` pins the exclusion against
#: that statement's own text rather than trusting this comment.
ACTIVITY_TYPE = "system"

#: ``crm_leads.source`` — the vocabulary is CHECK-constrained by migration 144
#: and validated at the boundary by ``core.validate_source``.
LEAD_SOURCE = "email"

#: The folder a candidate must be in, and the folder the "have we ever emailed
#: them" probe reads. Bound as parameters rather than written as SQL literals
#: so both are one lowercase comparison against a value the caller can see.
INBOX_FOLDER = "inbox"
SENT_FOLDER = "sent"

#: The candidate predicate, written ONCE and shared by the fetch and the
#: overflow count. Two copies would let the count answer a different question
#: from the batch — and the count is the number an operator reads to decide
#: whether the cap is hurting.
_CANDIDATE_WHERE = (
    "account_id = :account_id "
    "AND LOWER(folder) = :folder "
    "AND rules_processed_at IS NOT NULL "
    "AND rules_held_back_at IS NULL "
    "AND received_at > :activated_at "
    "AND rules_processed_at > :watermark"
)

#: ⚠️ The projection is the privacy boundary: ``body_text`` and ``snippet`` are
#: absent on purpose and must stay absent. Nothing downstream can leak a body
#: it was never handed.
_CANDIDATE_SQL = (
    "SELECT id, subject, from_address, received_at, thread_id, "
    "internet_message_id, rules_processed_at "
    f"FROM email_messages WHERE {_CANDIDATE_WHERE} "
    "ORDER BY rules_processed_at LIMIT :limit"
)

_CANDIDATE_COUNT_SQL = f"SELECT COUNT(*) FROM email_messages WHERE {_CANDIDATE_WHERE}"


def auto_lead_enabled() -> bool:
    """``CRM_AUTO_LEAD`` — the single definition of what the flag means.

    Ships OFF. ON means unknown inbound senders become CRM leads unattended,
    each born ``zoho_dirty`` and therefore queued for the LIVE Zoho tenant
    (D-CRM-9) with no confirmation card anywhere on a scheduler hook and no
    delete tool. Flipping it is an OWNER-GATE act (``work_plan.md`` §6 (b)).

    Read by ``process_new_mail`` BEFORE it enters the step, never inside it —
    see property 1 in the module docstring.
    """
    return bool(getattr(get_settings(), "crm_auto_lead", False))


def _new_stats() -> dict[str, int]:
    """The counters the log line carries. Declared in one place so a counter
    added later cannot be missing from the line that reports it."""
    return {
        "candidates": 0,
        "overflow": 0,
        "created": 0,
        "skipped_internal": 0,
        "skipped_known": 0,
        "skipped_unusable": 0,
        "deduped_in_batch": 0,
        "errors": 0,
    }


async def create_leads_from_new_mail(account_id: str) -> dict[str, int]:
    """Turn this account's newly-classified inbound mail into leads.

    The entry point ``process_new_mail`` calls, and the only public write path
    in this module. Returns its counters so a caller (and a test) can see what
    a cycle considered rather than only what it created — "created 0" and
    "considered 0" are different facts and one of them is a bug report.
    """
    stats = _new_stats()
    db = await _get_db()
    try:
        account = await _load_account(db, account_id)
        if account is None:
            return stats
        cursor = await _load_or_activate_cursor(db, account_id)
        if cursor is None:  # pragma: no cover — the row was just written
            return stats
        candidates = await _load_candidates(db, account_id, cursor)
        stats["candidates"] = len(candidates)
        if not candidates:
            _emit(account_id, stats)
            return stats
        stats["overflow"] = await _count_overflow(db, account_id, cursor,
                                                  len(candidates))
        domains = await _internal_domains(db, account_id, account.email_address)
        seen: set[str] = set()
        for message in candidates:
            await _consider(db, account, message, domains, seen, stats)
        # Advanced over everything CONSIDERED, including the messages that
        # minted nothing and the ones that raised: this is a best-effort
        # enrichment step, not a queue, and a poison message that held the
        # cursor still would re-fail on every cycle forever. The errors are
        # counted in the line below instead.
        await _advance_watermark(
            db, account_id,
            max(message.rules_processed_at for message in candidates),
        )
        await db.commit()
        _emit(account_id, stats)
        return stats
    finally:
        await db.close()


# ── The account, and the cursor that decides what is history ────────────────

async def _load_account(db: Any, account_id: str) -> Any | None:
    """The mailbox's own address and its owner.

    ``email_accounts.user_id`` holds the owner's EMAIL (the column is TEXT and
    every reader compares it to one — see ``routes/email/core._account_scope``),
    which is what makes a created lead somebody's follow-up rather than
    'anonymous'. An account with no owner recorded is skipped: attributing a
    lead to nobody is worse than not creating it.
    """
    row = (await db.execute(text(
        "SELECT id, user_id, email_address FROM email_accounts WHERE id = :id"
    ), {"id": account_id})).fetchone()
    if row is None or not str(getattr(row, "user_id", "") or "").strip():
        return None
    return row


async def _read_cursor(db: Any, account_id: str) -> Any | None:
    return (await db.execute(text(
        "SELECT account_id, activated_at, processed_watermark "
        "FROM crm_auto_lead_cursors WHERE account_id = :account_id"
    ), {"account_id": account_id})).fetchone()


async def _load_or_activate_cursor(db: Any, account_id: str) -> Any | None:
    """Read the account's cursor, creating it on the first ON-state run.

    Activation stamps ``activated_at`` and ``processed_watermark`` to the SAME
    instant, so the activating cycle itself mints nothing: everything already
    in the mailbox arrived before auto-lead existed for this account, which is
    precisely the deep-resync case. ``ON CONFLICT DO NOTHING`` + a re-read
    means a concurrent activation is one row and one activation instant, not a
    primary-key error on the mail path.
    """
    row = await _read_cursor(db, account_id)
    if row is not None:
        return row
    at = now()
    await db.execute(text(
        "INSERT INTO crm_auto_lead_cursors "
        "(account_id, activated_at, processed_watermark) "
        "VALUES (:account_id, :activated_at, :processed_watermark) "
        "ON CONFLICT (account_id) DO NOTHING"
    ), {"account_id": account_id, "activated_at": at, "processed_watermark": at})
    await db.commit()
    _log.info("crm.auto_lead_activated", account_id=account_id)
    return await _read_cursor(db, account_id)


def _cursor_params(account_id: str, cursor: Any) -> dict[str, Any]:
    return {
        "account_id": account_id,
        "folder": INBOX_FOLDER,
        "activated_at": cursor.activated_at,
        "watermark": cursor.processed_watermark,
    }


async def _load_candidates(db: Any, account_id: str, cursor: Any) -> list[Any]:
    """Classified inbox mail this account has not been considered for yet.

    Both cursor predicates apply. Ordered by ``rules_processed_at`` ascending
    so the batch's maximum IS the new watermark — ordering by ``received_at``
    would advance the cursor past messages the cap left behind.
    """
    return (await db.execute(
        text(_CANDIDATE_SQL),
        {**_cursor_params(account_id, cursor), "limit": MAX_CANDIDATES_PER_CYCLE},
    )).fetchall()


async def _count_overflow(
    db: Any, account_id: str, cursor: Any, taken: int,
) -> int:
    """How many candidates the cap left for the next cycle.

    Only asked when the batch came back full — a short batch is the whole
    remainder by definition, and a COUNT on every quiet cycle is a scan
    nobody reads.
    """
    if taken < MAX_CANDIDATES_PER_CYCLE:
        return 0
    total = (await db.execute(
        text(_CANDIDATE_COUNT_SQL), _cursor_params(account_id, cursor),
    )).scalar()
    return max(0, int(total or 0) - taken)


async def _advance_watermark(db: Any, account_id: str, watermark: Any) -> None:
    await db.execute(text(
        "UPDATE crm_auto_lead_cursors "
        "SET processed_watermark = :processed_watermark, updated_at = now() "
        "WHERE account_id = :account_id"
    ), {"account_id": account_id, "processed_watermark": watermark})


# ── Who the sender is ───────────────────────────────────────────────────────

async def _internal_domains(
    db: Any, account_id: str, account_address: str | None,
) -> frozenset[str]:
    """The account's own domain plus every configured org domain.

    Composed from the automation package's two PUBLIC helpers rather than
    imported from ``cleanup._internal_domains`` (private) or restated here:
    ``resolve_org_domains`` is the one place the ``org_domains`` setting is
    normalised, and reading that column raw is a documented defect — a user who
    typed ``ops@acme.com`` or ``@acme.com`` has their org recognised by
    ``normalize_domain`` and NOT by an ad-hoc ``lstrip('@')``.
    """
    domains = {normalize_domain(account_address or "")}
    domains |= set(await resolve_org_domains(db, account_id))
    return frozenset(domain for domain in domains if domain)


def _is_external_sender(
    address: str, account_address: str | None, internal_domains: frozenset[str],
) -> bool:
    """Two gates, answering two different questions. Both must pass.

    **Gate 1** is ``sender_scope`` — the automation package's own answer to "is
    this me, or my own domain?", asked from the account's address alone.

    **Gate 2** is the configured internal-domain list. It is not a restatement
    of gate 1: ``sender_scope`` fails SAFE to ``"external"`` on an unparseable
    address (the wrong direction when the consequence is a lead row in a live
    Zoho tenant), and the extra ``org_domains`` reach it through a different
    normalisation than ``resolve_org_domains`` applies — so a colleague on the
    company's SECOND domain, configured by somebody who pasted an address
    rather than a bare host, is external to gate 1 and internal to gate 2.
    Routing the configured list through gate 2 only means there is exactly one
    normalisation of it here rather than two that can disagree.

    An address with no domain at all fails gate 2: we do not mint a lead from
    something we could not parse.
    """
    if sender_scope(address, account_address or "") != "external":
        return False
    domain = normalize_domain(address)
    return bool(domain) and domain not in internal_domains


async def _is_unknown_sender(db: Any, account_id: str, address: str) -> bool:
    """Three steps — the two ``_maybe_block_cold`` already answers, plus ours.

    1. the cold-sender memo: this account has already decided something about
       this address (flagged cold, or whitelisted). Either way it is not a
       stranger who just wrote in.
    2. have we ever emailed them. ⚠️ ``@>`` is exact, as Postgres is, so a
       recipient stored with different casing escapes this probe — which is
       part of why it is not the only step.
    3. ours: no CRM row already carries the address. A contact or a lead means
       the company already knows this person, and a second lead for them is
       the duplicate a human then has to merge.
    """
    memo = (await db.execute(text(
        "SELECT status FROM email_cold_senders "
        "WHERE account_id = :account_id AND from_email = :address"
    ), {"account_id": account_id, "address": address})).fetchone()
    if memo:
        return False
    replied = (await db.execute(text(
        "SELECT 1 FROM email_messages "
        "WHERE account_id = :account_id AND LOWER(folder) = :folder "
        "AND to_addresses @> :recipient LIMIT 1"
    ), {
        "account_id": account_id, "folder": SENT_FOLDER,
        "recipient": json.dumps([{"email": address}]),
    })).fetchone()
    if replied:
        return False
    for table in ("crm_contacts", "crm_leads"):
        known = (await db.execute(text(
            f"SELECT 1 FROM {table} WHERE lower(email) = :address LIMIT 1"
        ), {"address": address})).fetchone()
        if known:
            return False
    return True


# ── One candidate ───────────────────────────────────────────────────────────

def _sender(message: Any) -> tuple[str, str]:
    """``(address, display name)`` off the message's ``from_address`` JSONB.

    The driver hands back a dict or the raw text depending on how the row was
    read; both shapes appear in this codebase, so both are handled here rather
    than at four call sites.
    """
    raw = getattr(message, "from_address", None)
    if not isinstance(raw, dict):
        try:
            raw = json.loads(raw or "{}")
        except (TypeError, ValueError):
            raw = {}
    if not isinstance(raw, dict):
        raw = {}
    return (
        str(raw.get("email") or "").strip().lower(),
        str(raw.get("name") or "").strip(),
    )


def _split_display_name(raw: str) -> tuple[str | None, str | None]:
    """The mail's display name → ``(first_name, last_name)``.

    **Stripped before it is split.** Providers pad and quote this field, and
    splitting first turns ``'"Asha" '`` into a first name of ``'"Asha"'`` and a
    surname of ``''``. What lands here is then run through §3.3's fallback
    chain by ``create_record`` — this function must never build the display
    name itself, because a name hand-built here would be a SECOND answer to
    "what is this lead called" and the wrong one is the one that gets stored
    (the "Asha Asha" trap, §8 B-series).

    A display name that is an address — which is what every provider puts there
    for a sender who set none — yields ``(None, None)``, so the chain falls
    through to the email local part rather than minting a lead named
    ``noreply@example.com``.
    """
    name = (raw or "").strip().strip('"').strip("'").strip()
    if not name or "@" in name:
        return None, None
    parts = name.split()
    if len(parts) == 1:
        return parts[0], None
    return parts[0], " ".join(parts[1:])


def _principal(owner_email: str) -> UserContext:
    """The identity ``create_record`` attributes the lead to.

    Carries the account owner's address and **no access at all**
    (``UserContext`` defaults to ``NO_ACCESS``): the only thing this principal
    is for is the ``owner_email`` default, and an unattended writer must not
    carry authority it could later be asked for. ``UserRole.AGENT`` says out
    loud that no human is behind this write — the same principal shape
    ``routes/apps/actions.py`` uses for an agent-initiated action.
    """
    return UserContext(email=owner_email.strip(), role=UserRole.AGENT)


async def _consider(
    db: Any, account: Any, message: Any, internal_domains: frozenset[str],
    seen: set[str], stats: dict[str, int],
) -> None:
    """Decide about ONE candidate message, and count the decision."""
    address, display_name = _sender(message)
    if not address:
        stats["skipped_unusable"] += 1
        return
    if address in seen:
        # In-batch de-duplication. Not an optimisation: the SELECT guard in
        # `_is_unknown_sender` reads a row `create_record` has committed on
        # ANOTHER session, so without this a sender who wrote twice in one
        # batch is a coin flip between one lead and two.
        stats["deduped_in_batch"] += 1
        return
    seen.add(address)
    if not _is_external_sender(address, account.email_address, internal_domains):
        stats["skipped_internal"] += 1
        return
    if not await _is_unknown_sender(db, str(account.id), address):
        stats["skipped_known"] += 1
        return
    try:
        async with savepoint(db):
            await _mint_lead(db, account, message, address, display_name)
    except Exception as exc:
        stats["errors"] += 1
        _log.warning("crm.auto_lead_message_failed",
                     account_id=str(account.id),
                     message_id=str(getattr(message, "id", "")),
                     error=str(exc)[:200])
        return
    stats["created"] += 1


async def _mint_lead(
    db: Any, account: Any, message: Any, address: str, display_name: str,
) -> None:
    """Create the lead, then log the originating message against it.

    The lead goes through ``records.create_record`` — never a raw INSERT.
    That path is where ``_resolve_status`` (the NOT NULL ``status_id``), the
    ``owner_email`` default, ``validate_source`` and, through ``insert_row``,
    ``mark_dirty_on_insert`` all live; raw SQL silently loses all four, and
    only the last of them is visible in the row afterwards.

    ``create_record`` opens and commits its OWN session (it is the same
    function ``POST /crm/leads`` calls), so the lead is committed before the
    activity is written. A failure between the two therefore leaves a lead with
    an empty timeline — logged, counted, and the lesser of the two evils: the
    alternative is a second, divergent write path for the record itself.
    """
    first_name, last_name = _split_display_name(display_name)
    # Absent, never explicitly null: ``clean_payload`` is ``exclude_unset``, so
    # a field passed as None is a deliberate "clear this" that lands in the
    # INSERT as a NULL column. Omitting it lets the column's own default apply,
    # which is the difference between "we did not learn a surname" and "this
    # lead has no surname".
    fields: dict[str, Any] = {"email": address, "source": LEAD_SOURCE}
    if first_name:
        fields["first_name"] = first_name
    if last_name:
        fields["last_name"] = last_name
    lead = await create_record(
        LEADS, LeadIn(**fields), _principal(str(account.user_id)),
    )
    await _log_origin_activity(db, lead, account, message, address, display_name)


async def _log_origin_activity(
    db: Any, lead: dict[str, Any], account: Any, message: Any,
    address: str, display_name: str,
) -> None:
    """The lead's first timeline entry: metadata about the mail, never the mail.

    ``type='system'`` keeps it out of ``sync_zoho.push_activities``' ``type IN
    ('note', 'task')`` predicate, so the subject and the sender stay inside the
    native CRM even though the lead itself is queued for the tenant (D-CRM-9).
    ``body`` is empty and stays empty: the record is org-visible to every
    ``feature:crm`` holder (D-CRM-3), and sender + subject is the proportionate
    disclosure for a cold inbound inquiry — the same line D-CRM-12 draws for
    what the agent renders, applied to what a machine writes.
    """
    await insert_row(db, "crm_activities", {
        "type": ACTIVITY_TYPE,
        "subject": getattr(message, "subject", None),
        "body": None,
        "occurred_at": getattr(message, "received_at", None),
        "meta": {
            "source": "auto_lead",
            "sender_name": display_name or None,
            "sender_address": address,
            "received_at": _instant(getattr(message, "received_at", None)),
            "message_id": str(getattr(message, "id", "") or "") or None,
            "internet_message_id": getattr(message, "internet_message_id", None),
            "thread_id": getattr(message, "thread_id", None),
            "account_id": str(account.id),
        },
        "created_by": str(account.user_id),
        LEADS.activity_column: lead["id"],
    })
    await bump_last_activity(db, LEADS.table, lead["id"])


def _instant(value: Any) -> str | None:
    """A timestamp as text for the ``meta`` blob — jsonb holds no datetimes."""
    if value is None:
        return None
    isoformat = getattr(value, "isoformat", None)
    return isoformat() if callable(isoformat) else str(value)


def _emit(account_id: str, stats: dict[str, int]) -> None:
    """One line per cycle, carrying every counter — including ``overflow``.

    ⚠️ Never pass ``event=`` to a structlog logger; it is the message parameter
    and raises at call time.
    """
    _log.info("crm.auto_lead_cycle", account_id=account_id, **stats)

"""Automation · commitments — promises tracked both ways (W3).

A commitment is a future obligation stated in a message. We extract them from
BOTH directions: ours ("I'll send the quote by Friday") feed the digest's
commitment watch (the promise that never became a task); theirs ("will share the
AWB tomorrow") feed the waiting-on strip (what to chase).

Deterministic + conservative, matching the email commitment gate's ethos: a
wrong item is worse than a missed one, so a promise VERB is required — a bare
deadline phrase ("meeting by Friday") is not a commitment. An LLM refinement can
catch the subtler tail later. ``extract_commitment`` is pure/testable;
``apply_commitments`` is watermarked on ``wa_messages.commitment_checked_at`` so
each message is scanned exactly once.
"""

from __future__ import annotations

import re
from typing import Any
from uuid import uuid4

from acb_auth import UserContext, get_current_user
from fastapi import Depends
from gateway.routes.whatsapp.core import _get_db, router
from pydantic import BaseModel
from sqlalchemy import text

# A promise verb must be present for a message to count as a commitment.
_PROMISE_RE = re.compile(
    # The curly apostrophe in the class below is intentional: WhatsApp
    # autocorrect turns "I'll" into a curly-quote form, so we match both.
    r"\b(i['’]?ll|we['’]?ll|i will|we will|"  # noqa: RUF001
    r"will\s+(send|share|revert|get\s+back|ship|deliver|provide|update|"
    r"confirm|arrange|dispatch|pay|check|send\s+you)|"
    r"sending\s+(it|you|the|tomorrow|today|soon)|"
    r"going\s+to\s+(send|share|get|deliver)|"
    r"let\s+me\s+(send|share|check|get|revert))\b"
)

# The deadline phrase, if any, extracted verbatim (date resolution is later/LLM).
_DUE_RE = re.compile(
    r"\b(by\s+(mon|tue|wed|thu|fri|sat|sun)\w*|"
    r"by\s+(today|tomorrow|tonight|eod|end\s+of\s+day|end\s+of\s+week|eow|"
    r"next\s+week)|"
    r"tomorrow|today|tonight|"
    r"by\s+the\s+\d{1,2}(st|nd|rd|th)?|"
    r"within\s+\w+\s+(day|days|hour|hours|week|weeks)|"
    r"in\s+\d+\s+(day|days|week|weeks|hour|hours)|"
    r"end\s+of\s+(day|week|month)|next\s+week)\b"
)

_MAX_PER_PASS = 500


def extract_commitment(body: str | None) -> tuple[str, str | None] | None:
    """Return ``(commitment_text, due_hint)`` if the message promises a future
    action, else None. Pure."""
    if not body:
        return None
    lowered = body.lower()
    if not _PROMISE_RE.search(lowered):
        return None
    due = _DUE_RE.search(lowered)
    return body.strip()[:200], (due.group(0) if due else None)


async def apply_commitments(db: Any, account_id: str) -> int:
    """Scan not-yet-checked messages (both directions) for commitments, insert
    the hits, and stamp the watermark on every message scanned. Returns the
    number of commitments found. Caller owns the transaction."""
    rows = (await db.execute(
        text("""SELECT id, chat_id, direction, body_text FROM wa_messages
                WHERE account_id = :aid AND commitment_checked_at IS NULL
                ORDER BY sent_at DESC NULLS LAST
                LIMIT :lim"""),
        {"aid": account_id, "lim": _MAX_PER_PASS},
    )).fetchall()
    found = 0
    for r in rows:
        hit = extract_commitment(r.body_text)
        if hit is not None:
            text_val, due_hint = hit
            direction = "ours" if r.direction == "out" else "theirs"
            await db.execute(
                text("""INSERT INTO wa_commitments
                          (id, account_id, chat_id, message_id, direction,
                           text, due_hint)
                        VALUES (:id, :aid, :cid, :mid, :dir, :text, :due)
                        ON CONFLICT (account_id, message_id) DO NOTHING"""),
                {"id": str(uuid4()), "aid": account_id, "cid": str(r.chat_id),
                 "mid": str(r.id), "dir": direction, "text": text_val,
                 "due": due_hint},
            )
            found += 1
        await db.execute(
            text("""UPDATE wa_messages SET commitment_checked_at = now()
                    WHERE id = :id"""),
            {"id": str(r.id)},
        )
    return found


class CommitmentModel(BaseModel):
    id: str
    chat_id: str
    direction: str
    text: str
    due_hint: str | None = None
    status: str = "open"
    gtd_item_id: str | None = None


@router.get("/commitments", response_model=list[CommitmentModel])
async def list_commitments(
    account_id: str,
    direction: str | None = None,       # 'ours' | 'theirs'
    status: str = "open",
    user: UserContext = Depends(get_current_user),
):
    """List commitments for an account — ours (digest watch) or theirs (chase)."""
    db = await _get_db()
    try:
        params: dict[str, Any] = {
            "uid": user.email or "anonymous", "aid": account_id, "status": status,
        }
        where = ["k.account_id = :aid", "k.status = :status",
                 "a.user_id = :uid"]
        if direction in ("ours", "theirs"):
            where.append("k.direction = :dir")
            params["dir"] = direction
        rows = (await db.execute(
            text(f"""SELECT k.id, k.chat_id, k.direction, k.text, k.due_hint,
                            k.status, k.gtd_item_id
                     FROM wa_commitments k
                     JOIN wa_accounts a ON a.id = k.account_id
                     WHERE {' AND '.join(where)}
                     ORDER BY k.created_at DESC"""),
            params,
        )).fetchall()
        return [
            CommitmentModel(
                id=str(r.id), chat_id=str(r.chat_id), direction=r.direction,
                text=r.text, due_hint=r.due_hint, status=r.status,
                gtd_item_id=str(r.gtd_item_id) if r.gtd_item_id else None,
            )
            for r in rows
        ]
    finally:
        await db.close()

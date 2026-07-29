"""Live agenda coverage — "are we going to get through this?"

``copilot_agenda.coverage()`` already knew, per item, whether the conversation
had touched it. But it only ran inside the copilot's own loop, so it fed a
prompt and nothing else: invisible in the UI, and absent entirely whenever the
copilot was switched off. That is backwards — knowing you are forty minutes in
and haven't reached pricing is useful on its own, and it costs nothing (token
overlap, no model call).

So coverage lives here instead, fed by the transcript bus rather than by the
copilot, and both read it.

Two design points worth stating:

- **Coverage latches.** An item discussed at minute five is still covered at
  minute fifty. Recomputing from a rolling buffer alone would let items blink
  back to uncovered as the window moved past them, which would be worse than
  not showing it at all.
- **The text buffer is bounded, the latch is not.** Keeping a whole meeting's
  transcript in memory per meeting is unbounded; keeping the *conclusions* is
  O(agenda). So recent words decide new coverage, and what was already found
  stays found.
"""

from __future__ import annotations

import time
from collections import deque

from acb_auth import UserContext, get_current_user
from fastapi import Depends
from gateway.routes.notes.copilot_agenda import get_agenda, item_covered
from gateway.routes.notes.core import _log, router

#: Words of recent speech kept per meeting. ~2000 words is roughly fifteen
#: minutes of talking — long enough for one agenda item's vocabulary to appear
#: across a few exchanges, short enough to stay small for a four-hour call.
_WINDOW_WORDS = 2000

_TEXT: dict[str, deque[str]] = {}
_COVERED: dict[str, set[int]] = {}
_STARTED: dict[str, float] = {}


def note(meeting_id: str, text: str) -> None:
    """Record what was said. Called on every published segment, so it must stay
    trivial — no DB, no model, no allocation beyond the words themselves."""
    if not text:
        return
    buf = _TEXT.get(meeting_id)
    if buf is None:
        buf = deque(maxlen=_WINDOW_WORDS)
        _TEXT[meeting_id] = buf
        _STARTED.setdefault(meeting_id, time.time())
    buf.extend(text.split())


def elapsed_s(meeting_id: str) -> float:
    """Seconds since the first word — what makes coverage actionable ("11 min
    left and pilot sign-off is untouched") rather than merely descriptive."""
    started = _STARTED.get(meeting_id)
    return 0.0 if started is None else max(0.0, time.time() - started)


def mark(meeting_id: str, agenda: list[dict]) -> list[bool]:
    """Covered flags for this agenda, latching what has already been found.

    Pure apart from the latch it updates, so the interesting behaviour — that
    coverage never regresses — is directly testable.
    """
    if not agenda:
        return []
    said = " ".join(_TEXT.get(meeting_id, ()))
    latched = _COVERED.setdefault(meeting_id, set())
    out: list[bool] = []
    for i, item in enumerate(agenda):
        if i in latched:
            out.append(True)
            continue
        hit = item_covered(item, said)
        if hit:
            latched.add(i)
        out.append(hit)
    return out


def reset(meeting_id: str) -> None:
    """Drop a finished meeting's state (called when its session ends)."""
    for store in (_TEXT, _COVERED, _STARTED):
        store.pop(meeting_id, None)


@router.get("/meetings/{meeting_id}/agenda/progress")
async def read_progress(
    meeting_id: str,
    _user: UserContext = Depends(get_current_user),
) -> dict:
    """Per-item coverage for the live console, and for the post-meeting recap.

    Cheap enough to poll: one agenda read plus token overlap. Never raises — a
    coverage read must not be able to disturb a meeting in progress."""
    try:
        agenda = await get_agenda(meeting_id)
    except Exception as exc:
        _log.warning("notes.agenda_progress_failed", error=str(exc)[:200])
        agenda = []
    covered = mark(meeting_id, agenda)
    return {
        "items": [
            {
                "title": (item or {}).get("title", ""),
                "notes": (item or {}).get("notes", ""),
                "covered": bool(covered[i]) if i < len(covered) else False,
            }
            for i, item in enumerate(agenda)
        ],
        "covered_count": sum(1 for c in covered if c),
        "total": len(agenda),
        "elapsed_s": elapsed_s(meeting_id),
    }

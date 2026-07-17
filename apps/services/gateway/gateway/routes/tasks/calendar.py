"""Tasks · calendar — external-calendar sync seams (Google + Outlook).

The scheduled-item grid data lives in items.py (GET /tasks/calendar range query).
This module holds the EXTERNAL calendar sync surface, scaffolded per
calendar_timeboxing.md §8. The OAuth flow + encrypted token storage will reuse
the email stack (email/transport/oauth.py already integrates Google + Microsoft
Graph; tokens via acb_llm key_store), adding Calendars.ReadWrite / calendar.events
scopes and a `calendar_accounts` table (mirrors task_accounts / email_accounts).

Until client creds + that table land (roadmap P4), these endpoints advertise the
shape and return 501, so the UI can wire the "Connect a calendar" seam now.
"""

from __future__ import annotations

from acb_auth import UserContext, get_current_user
from fastapi import Depends, HTTPException

from gateway.routes.tasks.core import _uid, router


@router.get("/calendar/accounts")
async def list_calendar_accounts(user: UserContext = Depends(get_current_user)):
    """Connected external calendars. Empty until P4 wires `calendar_accounts`.
    Target shape: [{id, provider: 'google'|'outlook', email, sync_enabled,
    last_synced_at}]."""
    _ = _uid(user)
    return []


@router.post("/calendar/sync")
async def sync_calendars(user: UserContext = Depends(get_current_user)):
    """Two-way sync task time-blocks ⇄ Google/Outlook (calendar_timeboxing.md §8):
    READ external events onto the grid for conflict-avoidance, WRITE timeboxed
    task-blocks out as real calendar events. Not yet wired — needs OAuth client
    creds + the calendar_accounts table (roadmap P4)."""
    _ = _uid(user)
    raise HTTPException(
        status_code=501,
        detail="External calendar sync is scaffolded but not yet wired "
               "(calendar_timeboxing.md §8, roadmap P4).",
    )

"""WhatsApp background enrichment scheduler (W9).

The group-summary and voice-transcription batches (``summarize_stale_groups``,
``transcribe_pending``) are bounded, watermarked passes meant for a schedule, not
the hot webhook path (both make LLM / STT calls). WhatsApp is otherwise
webhook-driven with no background loop, so this adds ONE lightweight loop that
periodically sweeps every live account and runs those two passes — turning the
built-but-on-demand enrichers into autonomous refresh.

Cost-gated: OFF unless ``WHATSAPP_ENRICHMENT=1``, since each cycle can call the
LLM (summaries) and STT (voice). Both passes are per-pass bounded and only touch
stale / pending rows, so a caught-up account does no work. The pure interval
resolver + the single-cycle sweep are unit-testable; the ``while`` loop is
trivial and mirrors the tasks/email scheduler lifecycle.
"""

from __future__ import annotations

import asyncio
import os
from typing import Any

from acb_common import get_logger
from sqlalchemy import text

_log = get_logger("gateway.whatsapp.scheduler")

_DEFAULT_INTERVAL_SECS = 900          # 15 min
_MIN_INTERVAL_SECS = 120
_ENABLED_ENV = "WHATSAPP_ENRICHMENT"
_INTERVAL_ENV = "WHATSAPP_ENRICHMENT_INTERVAL_SECS"

_task: asyncio.Task[Any] | None = None


def enrichment_enabled(env: dict[str, str] | None = None) -> bool:
    """True when the cost-gated enrichment loop should run. Pure."""
    src = env if env is not None else os.environ
    return str(src.get(_ENABLED_ENV, "")).strip().lower() in {"1", "true", "yes", "on"}


def resolve_interval(raw: str | int | None) -> int:
    """Parse + clamp the cycle interval (seconds), defaulting on bad input. Pure."""
    try:
        val = (
            int(raw) if raw is not None and str(raw).strip()
            else _DEFAULT_INTERVAL_SECS
        )
    except (ValueError, TypeError):
        val = _DEFAULT_INTERVAL_SECS
    return max(val, _MIN_INTERVAL_SECS)


async def _live_account_ids() -> list[str]:
    """Every account not in a hard error state — the sweep set."""
    from gateway.routes.whatsapp.core import _get_db
    db = await _get_db()
    try:
        rows = (await db.execute(
            text("SELECT id FROM wa_accounts WHERE sync_status <> 'error'"),
        )).fetchall()
        return [str(r.id) for r in rows]
    finally:
        await db.close()


async def _embed_account(account_id: str) -> int:
    """Backfill a bounded batch of message embeddings for one account (own db).
    No-op (0) when ``whatsapp_semantic_search_enabled`` is off (W10)."""
    from gateway.routes.whatsapp.core import _get_db
    from whatsapp_ingestion.wa_embeddings import embed_pending_messages
    db = await _get_db()
    try:
        return await embed_pending_messages(db, account_id)
    finally:
        await db.close()


async def run_enrichment_cycle() -> dict[str, int]:
    """One sweep for every live account: summarize stale groups, transcribe
    pending voice, and backfill message embeddings. Each pass is independently
    gated + bounded, and a per-account failure is logged, never fatal to the
    sweep. Returns ``{accounts, summarized, transcribed, embedded}``."""
    from gateway.routes.whatsapp.automation.groups import summarize_stale_groups
    from gateway.routes.whatsapp.automation.transcription import transcribe_pending

    accounts = await _live_account_ids()
    summarized = transcribed = embedded = 0
    for aid in accounts:
        try:
            summarized += await summarize_stale_groups(aid)
        except Exception as exc:
            _log.warning("whatsapp.enrichment.groups_failed",
                         account_id=aid, error=str(exc)[:200])
        try:
            transcribed += await transcribe_pending(aid)
        except Exception as exc:
            _log.warning("whatsapp.enrichment.transcribe_failed",
                         account_id=aid, error=str(exc)[:200])
        try:
            embedded += await _embed_account(aid)
        except Exception as exc:
            _log.warning("whatsapp.enrichment.embed_failed",
                         account_id=aid, error=str(exc)[:200])
    _log.info("whatsapp.enrichment.cycle_done", accounts=len(accounts),
              summarized=summarized, transcribed=transcribed, embedded=embedded)
    return {"accounts": len(accounts), "summarized": summarized,
            "transcribed": transcribed, "embedded": embedded}


async def _loop(interval_secs: int) -> None:
    _log.info("whatsapp.enrichment.loop_started", interval_secs=interval_secs)
    while True:
        try:
            await run_enrichment_cycle()
        except Exception as exc:                       # never let the loop die
            _log.warning("whatsapp.enrichment.cycle_error", error=str(exc)[:200])
        await asyncio.sleep(interval_secs)


async def start_whatsapp_enrichment() -> bool:
    """Start the enrichment loop if enabled by env. Returns True when running.
    Idempotent — a second call while a loop is alive is a no-op."""
    global _task
    if not enrichment_enabled():
        _log.info("whatsapp.enrichment.disabled")
        return False
    if _task is not None and not _task.done():
        return True
    interval = resolve_interval(os.environ.get(_INTERVAL_ENV))
    _task = asyncio.create_task(_loop(interval))
    return True


async def stop_whatsapp_enrichment() -> None:
    """Cancel the enrichment loop (lifespan shutdown)."""
    global _task
    if _task is None:
        return
    _task.cancel()
    try:
        await _task
    except asyncio.CancelledError:
        pass
    except Exception:
        pass
    _task = None

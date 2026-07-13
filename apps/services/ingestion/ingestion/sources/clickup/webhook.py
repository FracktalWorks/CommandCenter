"""ClickUp webhook receiver. Mount under the gateway or run standalone."""
from __future__ import annotations

import hashlib
import hmac
from typing import Any

from fastapi import APIRouter, BackgroundTasks, Header, HTTPException, Request

from acb_audit import AuditEvent, record
from acb_common import get_logger, get_settings
from ingestion.queue import STREAM_CLICKUP, enqueue, enqueue_dlq

router = APIRouter(prefix="/webhooks/clickup", tags=["ingestion:clickup"])
_log = get_logger("ingestion.clickup")

# ClickUp task event types that carry a task_id and should trigger normalisation.
_TASK_EVENTS: frozenset[str] = frozenset(
    {"taskCreated", "taskUpdated", "taskDeleted", "taskStatusUpdated", "taskMoved"}
)


def _verify(body: bytes, signature: str | None) -> bool:
    """Verify ClickUp's HMAC-SHA256 webhook signature."""
    secret = get_settings().clickup_webhook_secret
    if not secret or not signature:
        return False
    digest = hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(digest, signature)


async def _normalise_task(task_id: str, event_type: str, payload: dict[str, Any]) -> None:
    """Fetch the full task from ClickUp and upsert it into the graph.

    Runs as a background task — webhook returns 200 immediately.
    On failure the raw payload is moved to the DLQ.
    """
    if event_type == "taskDeleted":
        # Soft-delete not yet implemented; log and skip.
        _log.info("clickup.task.deleted_skipped", task_id=task_id)
        return

    try:
        from ingestion.sources.clickup import client  # noqa: PLC0415
        task = await client.get_task(task_id)
    except Exception as exc:  # noqa: BLE001
        _log.warning("clickup.task.fetch_failed", task_id=task_id, error=str(exc))
        enqueue_dlq(STREAM_CLICKUP, event_type, payload, error=f"get_task failed: {exc}")
        return

    try:
        from acb_graph import get_session  # noqa: PLC0415
        from ingestion.sources.clickup.normaliser import normalise_tasks  # noqa: PLC0415

        with get_session() as session:
            counts = normalise_tasks(session, [task])

        record(
            AuditEvent(
                actor="system:ingestion:clickup",
                action="task_normalised",
                target=f"task:{task_id}",
                payload={"event_type": event_type, "counts": counts},
            )
        )
        _log.info("clickup.task.normalised", task_id=task_id, event=event_type, **counts)
    except Exception as exc:  # noqa: BLE001
        _log.exception("clickup.task.normalise_failed", task_id=task_id)
        enqueue_dlq(STREAM_CLICKUP, event_type, payload, error=f"normalise failed: {exc}")


@router.post("")
async def receive(
    request: Request,
    background_tasks: BackgroundTasks,
    x_signature: str | None = Header(default=None),
) -> dict[str, str]:
    """Receive a ClickUp webhook, verify its signature, and process the event.

    Processing is done asynchronously in the background — the response is
    returned to ClickUp immediately to prevent retries due to slow processing.
    """
    body = await request.body()
    if not _verify(body, x_signature):
        raise HTTPException(status_code=401, detail="invalid signature")

    payload: dict[str, Any] = await request.json()
    event_type: str = payload.get("event", "unknown")
    task_id: str | None = payload.get("task_id")

    _log.info("clickup.webhook.received", clickup_event=event_type, task_id=task_id)

    # Always enqueue to Redis Streams for audit trail and replay capability.
    try:
        enqueue(STREAM_CLICKUP, event_type, payload)
    except Exception as exc:  # noqa: BLE001
        # Redis unavailable — log and continue; do NOT return 5xx to ClickUp
        # (that triggers retries which would make the backlog worse).
        _log.warning("clickup.queue.unavailable", error=str(exc))

    # For task mutation events, also trigger inline normalisation.
    if event_type in _TASK_EVENTS and task_id:
        background_tasks.add_task(_normalise_task, task_id, event_type, payload)

    return {"status": "accepted"}

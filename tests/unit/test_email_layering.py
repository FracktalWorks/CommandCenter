"""C2 layering guard: the ingestion scheduler must not import UP into the gateway.

``email_ingestion`` is the LOWER layer. The gateway (higher layer) registers its
post-sync callbacks into ``email_ingestion.post_sync`` at startup, and the
scheduler only ever reads that registry. If the scheduler re-imports the gateway,
the two packages become mutually dependent again (they can no longer be built or
tested independently) — this test fails loudly if that regresses.
"""
from __future__ import annotations

from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
_SCHEDULER = REPO / "apps/services/email_ingestion/email_ingestion/scheduler.py"

_HOOK_NAMES = (
    "auto_run_rules",
    "categorize_senders",
    "classify_threads",
    "auto_archive",
    "send_digest",
    "send_follow_up_reminders",
    "ensure_subscription",
)


def test_scheduler_does_not_import_gateway():
    src = _SCHEDULER.read_text(encoding="utf-8")
    assert "from gateway" not in src and "import gateway" not in src, (
        "scheduler.py imports up into the gateway again — the C2 layering "
        "inversion regressed. Run the job through a post-sync hook "
        "(email_ingestion.post_sync) that the gateway registers instead."
    )


def test_gateway_registers_every_post_sync_hook():
    import email_ingestion.post_sync as ps
    from gateway.routes.email.scheduler_hooks import register_email_post_sync_hooks

    register_email_post_sync_hooks()
    unregistered = [n for n in _HOOK_NAMES if getattr(ps.hooks, n) is None]
    assert not unregistered, f"gateway left post-sync hooks unregistered: {unregistered}"


async def test_unregistered_hook_is_a_noop():
    from email_ingestion.post_sync import run_hook

    # Passing no hook must be a silent no-op (lets ingestion run without a gateway).
    await run_hook(None, "acct-1")

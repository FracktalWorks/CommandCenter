"""Run with: uv run python -m reconciler.main

Cron entry point. Phase-0 skeleton — wire actual diff in WBS 0.4.
"""
from __future__ import annotations

import asyncio

from acb_common import configure_logging, get_logger, get_settings


async def run() -> int:
    settings = get_settings()
    configure_logging(settings.log_level)
    log = get_logger("reconciler")
    log.info("reconciler.start", env=settings.acb_env)
    # TODO WBS 0.4:
    #   1. Full pull of ClickUp tasks/projects.
    #   2. Diff against acb_graph state.
    #   3. Classify divergences: ok | auto-heal | escalate.
    #   4. Push escalations to a queue surfaced in the Workbench Agent Inbox.
    log.info("reconciler.done", escalations=0)
    return 0


def main() -> None:  # entry point for `python -m reconciler.main`
    raise SystemExit(asyncio.run(run()))


if __name__ == "__main__":
    main()

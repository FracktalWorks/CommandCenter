"""Shared fixtures for the tests/ tree (CI runs `pytest tests/unit/`)."""
from __future__ import annotations

import os

import pytest

# Snapshot DATABASE_URL before any test module imports. `import litellm`
# (reached through acb_llm by several test modules) calls load_dotenv() at
# import time, which copies a dev machine's .env DATABASE_URL into os.environ
# mid-collection — and the DB-gated tests in test_tenant_coverage.py would then
# run against whatever that value names instead of skipping. Those gates must
# answer to the environment pytest was LAUNCHED with, not to whichever module
# happened to import first. conftest.py imports before every test module, so
# this line runs ahead of any litellm import.
os.environ.setdefault("_ACB_DATABASE_URL_AT_LAUNCH", os.environ.get("DATABASE_URL", ""))


@pytest.fixture(autouse=True)
def _isolate_write_artifact_context():
    """Snapshot and restore ``_WRITE_ARTIFACT_CONTEXT`` around every test.

    That dict is process-global state the executor populates per agent run
    (``session_id``, ``workspace_root``, ``integrations``) and that a dozen
    modules read — notably ``executor.resolve_run_queue``, which keys on
    ``session_id``. A test that populates it and does not restore it therefore
    leaks a live session into every test that runs afterwards, and the next test
    to touch that path blocks on a gateway call that never returns.

    The failure is order-dependent, so it stayed invisible: the tests that
    populate the global (test_write_artifact, test_share_artifact) happen to sort
    near the end of the run. Add one test file that sorts earlier and touches
    write_artifact and the whole suite hangs with no useful output. Rather than
    depend on filenames, isolate the global here so no test can leak it.
    """
    try:
        from acb_skills.write_artifact import _WRITE_ARTIFACT_CONTEXT
    except ImportError:  # acb_skills unavailable — nothing to isolate
        yield
        return
    snapshot = dict(_WRITE_ARTIFACT_CONTEXT)
    try:
        yield
    finally:
        _WRITE_ARTIFACT_CONTEXT.clear()
        _WRITE_ARTIFACT_CONTEXT.update(snapshot)

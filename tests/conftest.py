"""Shared fixtures for the tests/ tree (CI runs `pytest tests/unit/`)."""
from __future__ import annotations

import pytest


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

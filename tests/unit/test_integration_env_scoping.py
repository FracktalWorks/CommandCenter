"""MT-0a — per-run integration credential scoping.

**History, because it explains the shape of these tests.** The executor used to
materialise a run's resolved credentials into the gateway's process-global
``os.environ`` so subprocess skill scripts could ``os.getenv`` them. B6 Phase-5
Tier 0 made that *scoped* — a restore token put every var back at teardown — which
removed the permanent accumulation but could not remove concurrent exposure, and
the code said so itself:

    "os.environ is process-global, so under *concurrent* in-process runs the
     scoping is best-effort — two overlapping runs still share the env for the
     overlap window."

Under one tenant that is a within-org concern. Under two it is a **credential
leak**: tenant A's ClickUp token is readable by tenant B's concurrently-running
agent, and agents execute model-generated tool calls over content ingested from
email and WhatsApp. `saas_multitenancy.md` §6.1 / MT-0a therefore replaces the
bridge with a ``ContextVar``, which is per-task and cannot overlap.

What these tests lock:

- **the overlap window is gone** — two interleaved runs never observe each
  other's credentials (``test_concurrent_runs_cannot_observe_each_other``; this
  is the one that was verified RED against the os.environ implementation);
- the executor writes **no** credential into ``os.environ`` at all;
- teardown releases, is idempotent, and never raises;
- an operator-provided value still wins (unchanged precedence);
- only the run's own integrations are visible (scope).

See ``ai-company-brain/specs/saas_multitenancy.md`` §6.1 and MT-0a, and
``saas_multitenancy_implementation.md`` §6.
"""
from __future__ import annotations

import asyncio
import os
from pathlib import Path

import orchestrator.executor as ex
import pytest
from acb_skills.integrations import credential, run_credentials

# --------------------------------------------------------------------------
# Sample resolved-integration dicts (shape produced by build_integrations).
# --------------------------------------------------------------------------
_CLICKUP = {"clickup": {"api_token": "clk-secret-123", "workspace_id": "ws-9"}}
_APIFY = {"apify": {"api_token": "apify-secret-xyz"}}


def _clean(monkeypatch, *env_vars: str) -> None:
    """Ensure the named vars start absent, so a leak cannot hide behind one."""
    for v in env_vars:
        monkeypatch.delenv(v, raising=False)


# ==========================================================================
# THE POINT OF THE TICKET — concurrent runs are isolated.
# ==========================================================================
def test_concurrent_runs_cannot_observe_each_other(monkeypatch) -> None:
    """Two overlapping runs must never see each other's credentials.

    ⚠️ **This test was verified RED against the os.environ implementation** it
    replaced: under that code run B's ``os.environ`` write was visible to run A
    for the whole overlap window, and A read B's token. It is the reason MT-0a
    exists — do not weaken it into a sequential check, which the old code passed.

    The interleaving is deliberate and is what the old implementation failed:
        A binds → B binds → A reads → B reads → A releases → B releases
    """
    _clean(monkeypatch, "CLICKUP_API_TOKEN", "CLICKUP_WORKSPACE_ID", "APIFY_API_TOKEN")

    seen: dict[str, dict[str, str]] = {}
    gate_a, gate_b = asyncio.Event(), asyncio.Event()

    async def run_a() -> None:
        tok = ex._bind_run_credentials(_CLICKUP)
        gate_a.set()                    # A is bound
        await gate_b.wait()             # …wait for B to bind on top
        seen["a"] = {
            "own": credential("CLICKUP_API_TOKEN"),
            "other": credential("APIFY_API_TOKEN"),
        }
        ex._release_run_credentials(tok)

    async def run_b() -> None:
        await gate_a.wait()             # bind while A is still live
        tok = ex._bind_run_credentials(_APIFY)
        gate_b.set()
        seen["b"] = {
            "own": credential("APIFY_API_TOKEN"),
            "other": credential("CLICKUP_API_TOKEN"),
        }
        ex._release_run_credentials(tok)

    async def main() -> None:
        # Separate tasks — each gets its own copy of the context, which is the
        # entire mechanism under test.
        await asyncio.gather(run_a(), run_b())

    asyncio.run(main())

    assert seen["a"]["own"] == "clk-secret-123"
    assert seen["b"]["own"] == "apify-secret-xyz"
    # The assertions that were red before MT-0a:
    assert seen["a"]["other"] == "", "run A could read run B's credential"
    assert seen["b"]["other"] == "", "run B could read run A's credential"


def test_a_sibling_task_started_before_the_bind_sees_nothing(monkeypatch) -> None:
    """A task that is not a child of the binding context must see no credential.

    Guards the property that makes the ContextVar sound: credentials propagate
    DOWN into tasks created from the bound context, never sideways.
    """
    _clean(monkeypatch, "CLICKUP_API_TOKEN")
    observed: list[str] = []
    released = asyncio.Event()

    async def bystander() -> None:
        await released.wait()
        observed.append(credential("CLICKUP_API_TOKEN"))

    async def main() -> None:
        task = asyncio.create_task(bystander())   # created BEFORE the bind
        tok = ex._bind_run_credentials(_CLICKUP)
        released.set()
        await task
        ex._release_run_credentials(tok)

    asyncio.run(main())
    assert observed == [""]


# ==========================================================================
# The process environment is no longer the bridge.
# ==========================================================================
def test_binding_writes_nothing_to_os_environ(monkeypatch) -> None:
    _clean(monkeypatch, "CLICKUP_API_TOKEN", "CLICKUP_WORKSPACE_ID")

    tok = ex._bind_run_credentials(_CLICKUP)
    try:
        assert "CLICKUP_API_TOKEN" not in os.environ
        assert "CLICKUP_WORKSPACE_ID" not in os.environ
        # …but the run itself can read them.
        assert credential("CLICKUP_API_TOKEN") == "clk-secret-123"
    finally:
        ex._release_run_credentials(tok)


def test_executor_never_assigns_a_credential_into_os_environ() -> None:
    """MT-0a done-when 3 — a grep assertion, so a later PR cannot reintroduce it.

    Narrow on purpose: the executor legitimately sets non-credential vars such as
    ``ACB_AGENT_USER_EMAIL``. What must never come back is a write whose value
    comes from the resolved-integration mapping.
    """
    src = Path(ex.__file__).read_text(encoding="utf-8")
    assert "FIELD_TO_ENV" not in src, (
        "executor.py must not map credential fields to env vars itself — "
        "binding belongs to acb_skills.integrations.bind_run_credentials (MT-0a)"
    )
    for banned in ("os.environ[env_var]", "os.environ[var]"):
        assert banned not in src, f"executor.py reintroduced a credential env write: {banned}"


# ==========================================================================
# Scope, precedence, teardown.
# ==========================================================================
def test_binds_only_this_runs_integrations(monkeypatch) -> None:
    _clean(monkeypatch, "CLICKUP_API_TOKEN", "CLICKUP_WORKSPACE_ID", "APIFY_API_TOKEN")

    tok = ex._bind_run_credentials(_CLICKUP)
    try:
        assert credential("CLICKUP_API_TOKEN") == "clk-secret-123"
        assert credential("CLICKUP_WORKSPACE_ID") == "ws-9"
        assert credential("APIFY_API_TOKEN") == ""      # not this run's
    finally:
        ex._release_run_credentials(tok)


def test_operator_provided_value_still_wins(monkeypatch) -> None:
    """Unchanged precedence: an operator's .env value beats the run's.

    It is deployment-wide by the operator's choice, and the implementation this
    replaced explicitly did not overwrite it. Making the operator's own store
    per-tenant is MT-0d, not this ticket.
    """
    monkeypatch.setenv("CLICKUP_API_TOKEN", "operator-value")

    tok = ex._bind_run_credentials(_CLICKUP)
    try:
        assert credential("CLICKUP_API_TOKEN") == "operator-value"
    finally:
        ex._release_run_credentials(tok)
    assert os.environ["CLICKUP_API_TOKEN"] == "operator-value"  # untouched


def test_release_clears_the_binding(monkeypatch) -> None:
    _clean(monkeypatch, "CLICKUP_API_TOKEN")

    tok = ex._bind_run_credentials(_CLICKUP)
    assert credential("CLICKUP_API_TOKEN") == "clk-secret-123"
    ex._release_run_credentials(tok)
    assert credential("CLICKUP_API_TOKEN") == ""
    assert run_credentials() == {}


def test_release_is_null_safe_and_never_raises() -> None:
    ex._release_run_credentials(None)      # must not raise
    tok = ex._bind_run_credentials(_CLICKUP)
    ex._release_run_credentials(tok)
    ex._release_run_credentials(tok)       # double release — must not raise


@pytest.mark.parametrize("payload", [
    {"apify": {"api_token": ""}},          # configured-but-empty → binds nothing
    {"apify": "not-a-dict"},               # malformed → skipped, no crash
    {"not-a-real-service": {"api_key": "x"}},   # unknown service → no mapping
    {},                                     # nothing declared
])
def test_degenerate_payloads_bind_nothing(monkeypatch, payload) -> None:
    _clean(monkeypatch, "APIFY_API_TOKEN")
    tok = ex._bind_run_credentials(payload)  # type: ignore[arg-type]
    try:
        assert run_credentials() == {}
    finally:
        ex._release_run_credentials(tok)

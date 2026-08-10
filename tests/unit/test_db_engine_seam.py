"""BO-10 — one async engine and one pool per process.

The gateway once had twelve module-level ``create_async_engine`` call sites, one
per app package. Their pool ceilings summed to roughly 165 connections from a
single process, against a stock Postgres ``max_connections`` of 100 that
Langfuse, LiteLLM and the ingestion services also draw from — a budget that
could not be spent, only exceeded. They now all resolve through
``acb_common.db``.

This is the ratchet. It is a source-level check on purpose: the failure mode it
guards is a *new* engine being introduced by a new app package, which no runtime
assertion sees until that package is under load in production.

MT-1c — the sync half (``saas_multitenancy.md`` §0.1)
-----------------------------------------------------
The connection inventory in §0.1 found **eight** paths that open a database
connection, and named this file as the reason two of them went unnoticed for
months: *"the seam test only inspects ``create_async_engine``, so this file is
unguarded by it"* (path 4, ``acb_graph/db.py:32``, the **sync**
``create_engine``). Under the pooled tenant boundary (D15) an unguarded
connection path is not a pool-budget problem any more — it is a path that can
open a connection with no ``app.tenant_id`` bound, and RLS decides what a
tenant sees at the connection, not at the query.

So the ratchet now covers both constructors, each with its own allow-list.
§0.1's acceptance criterion 2 is exactly this test. Criterion 3 — raw
``psycopg.connect``, paths 5-7 — is the companion ratchet in
``test_psycopg_seam.py``; it is a separate file because it has a separate
allow-list with separate reasons, and merging them would blur which discipline
an entry was admitted under.

Path 8 (``acb_memory/mem0_client.py``) is caught by **neither** ratchet by
construction: it opens no connection itself, it hands a conninfo string to
Mem0's own pgvector client. §0.1 criterion 4 calls that out as the genuinely
awkward one and owns it separately. A source-level ratchet cannot see a
connection opened inside a third-party library.
"""

from __future__ import annotations

import ast
import re
from functools import cache
from pathlib import Path

import pytest

_REPO = Path(__file__).resolve().parents[2]

#: Every file allowed to call ``create_async_engine``, and why.
#:
#: To add an entry you must have a reason that survives the question "why can
#: this not use the shared pool?". The two accepted reasons so far:
#:
#:   * it IS the shared pool, or
#:   * it is a short-lived engine in a separate, non-gateway process that
#:     disposes it when the run ends — a background job's engine has a
#:     different lifetime from a request handler's and must not outlive it in
#:     the shared pool.
_ALLOWED: dict[str, str] = {
    "packages/acb_common/acb_common/db.py": "the shared seam itself",
    "apps/services/email_ingestion/email_ingestion/inbound.py":
        "separate process; per-call engine, disposed in a finally block",
    "apps/services/email_ingestion/email_ingestion/scheduler.py":
        "separate process; per-run engines, disposed when the run ends",
}

#: Every file allowed to call the **sync** ``create_engine``, and why.
#:
#: Kept separate from ``_ALLOWED`` above rather than merged into it: the two
#: calls are admitted on different grounds. An entry above answers "why can this
#: not use the shared async pool?"; an entry here answers "why does this need a
#: synchronous engine at all?", and — since MT-1c — "which tenant does it bind?".
#: One list would let an entry inherit a reason it was never granted.
_ALLOWED_SYNC: dict[str, str] = {
    "packages/acb_graph/acb_graph/db.py":
        "the entity-graph sync engine — connection path 4 in "
        "saas_multitenancy.md §0.1; carries tenant data and MUST bind a tenant "
        "under MT-1c",
}


def _python_files() -> list[Path]:
    roots = [_REPO / "apps", _REPO / "packages"]
    out: list[Path] = []
    for root in roots:
        out.extend(
            p for p in root.rglob("*.py")
            if "__pycache__" not in p.parts and ".venv" not in p.parts
        )
    return out


@cache
def _called_names(path: Path) -> frozenset[str]:
    """Every name the file CALLS, as bare identifiers.

    Parsed rather than grepped: several of these modules mention the engine
    constructors in prose explaining that they do not call them
    (``acb_skills/history_tools.py`` names the sync ``create_engine`` in its
    module docstring while calling nothing), and a substring match would read
    the documentation as a violation.

    Attribute calls collapse to their final segment, so ``sa.create_engine(...)``
    counts the same as an imported ``create_engine(...)`` — the ratchet is about
    a connection being opened, not about how the symbol was spelled.

    Cached because the tree is walked once per constructor and the file set is
    the same both times.
    """
    # utf-8-sig: at least one module in the tree carries a BOM, and a leading
    # ﻿ is a syntax error to ast.parse.
    tree = ast.parse(path.read_text(encoding="utf-8-sig"), filename=str(path))
    names: set[str] = set()
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        func = node.func
        if isinstance(func, ast.Name):
            names.add(func.id)
        elif isinstance(func, ast.Attribute):
            names.add(func.attr)
    return frozenset(names)


def _calls_create_async_engine(path: Path) -> bool:
    return "create_async_engine" in _called_names(path)


def _calls_create_engine(path: Path) -> bool:
    """True if the file CALLS the **sync** ``create_engine``.

    Exact-match on the identifier, so ``create_async_engine`` — a different
    name, checked by its own allow-list above — never lands here.
    """
    return "create_engine" in _called_names(path)


def test_no_new_async_engines() -> None:
    offenders = sorted(
        str(p.relative_to(_REPO)).replace("\\", "/")
        for p in _python_files()
        if _calls_create_async_engine(p)
    )
    unexpected = [p for p in offenders if p not in _ALLOWED]
    assert not unexpected, (
        "New create_async_engine() call site(s):\n  "
        + "\n  ".join(unexpected)
        + "\n\nUse acb_common.db (get_db / get_session_factory) — one engine and "
          "one pool per process. If this engine genuinely needs its own "
          "lifetime, add it to _ALLOWED in this test with the reason."
    )


def test_allowlist_has_no_stale_entries() -> None:
    """A file that stopped creating engines must leave the allowlist.

    Otherwise the list silently grows into permission for anything, and the
    next reader cannot tell which entries are still load-bearing.
    """
    offenders = {
        str(p.relative_to(_REPO)).replace("\\", "/")
        for p in _python_files()
        if _calls_create_async_engine(p)
    }
    stale = sorted(set(_ALLOWED) - offenders)
    assert not stale, f"Allowlist entries that no longer create an engine: {stale}"


def test_no_new_sync_engines() -> None:
    """MT-1c, ``saas_multitenancy.md`` §0.1 criterion 2.

    A sync ``create_engine`` is as much a connection path as an async one, and
    RLS binds ``app.tenant_id`` per connection. A new unlisted one is a path
    that reaches tenant rows with nothing bound.
    """
    offenders = sorted(
        str(p.relative_to(_REPO)).replace("\\", "/")
        for p in _python_files()
        if _calls_create_engine(p)
    )
    unexpected = [p for p in offenders if p not in _ALLOWED_SYNC]
    assert not unexpected, (
        "New sync create_engine() call site(s):\n  "
        + "\n  ".join(unexpected)
        + "\n\nPrefer acb_common.db (get_db / get_session_factory) — one engine "
          "and one pool per process. If this engine genuinely must be "
          "synchronous, add it to _ALLOWED_SYNC in this test with the reason, "
          "and state how it binds a tenant (saas_multitenancy.md §0.1)."
    )


def test_sync_allowlist_has_no_stale_entries() -> None:
    """Same discipline as the async list: an entry that stopped calling leaves.

    Stated separately rather than folded into the async check so a stale sync
    entry names itself in the failure instead of arriving in a mixed list.
    """
    offenders = {
        str(p.relative_to(_REPO)).replace("\\", "/")
        for p in _python_files()
        if _calls_create_engine(p)
    }
    stale = sorted(set(_ALLOWED_SYNC) - offenders)
    assert not stale, (
        f"Sync allowlist entries that no longer create an engine: {stale}"
    )


def test_gateway_makes_no_engine_of_its_own() -> None:
    """The gateway process holds exactly one pool.

    Narrower than the repo-wide check above and worth stating separately: the
    gateway is where the twelve pools were, and it is the process where a second
    one is most expensive — it also runs ``acb_auth.access``, which resolves
    permissions from Postgres on the request path.

    Covers the sync constructor too since MT-1c: a synchronous engine in the
    gateway is a second pool AND a second connection path to bind, and it would
    block the event loop besides.
    """
    gateway = _REPO / "apps" / "services" / "gateway"
    offenders = sorted(
        str(p.relative_to(_REPO)).replace("\\", "/")
        for p in gateway.rglob("*.py")
        if "__pycache__" not in p.parts
        and (_calls_create_async_engine(p) or _calls_create_engine(p))
    )
    assert offenders == []


@pytest.mark.parametrize(
    "module_path",
    [
        "gateway.db",
        "gateway.routes.admin._common",
        "gateway.routes.apps._common",
        "gateway.routes.crm.core",
        "gateway.routes.email.core",
        "gateway.routes.notes.core",
        "gateway.routes.projects.core",
        "gateway.routes.tasks.core",
        "gateway.routes.whatsapp.core",
        "gateway.routes.workflows.core",
    ],
)
def test_route_packages_resolve_to_the_shared_factory(module_path: str) -> None:
    """Each converted package's DB entry point IS the shared one.

    The source check above proves no package *builds* an engine; this proves
    each one *reaches* the shared pool. Both are needed — a package could stop
    calling ``create_async_engine`` and still point at some other factory.

    Packages expose the seam under whichever names they historically used
    (``get_db`` in ``admin``, ``_get_db`` elsewhere, some also re-exporting the
    factory), so every seam name the module has must resolve to the shared one
    and at least one must be present.
    """
    import importlib

    from acb_common import db as shared

    mod = importlib.import_module(module_path)
    expected = {
        "get_session_factory": shared.get_session_factory,
        "_get_session_factory": shared.get_session_factory,
        "get_db": shared.get_db,
        "_get_db": shared.get_db,
        # H2 (MT-1c): a converted package drops `_get_db` for the tenant-bound
        # context manager — which must still BE the shared seam, not a wrapper
        # with its own pool or its own GUC discipline.
        "tenant_session": shared.tenant_session,
        "_tenant_session": shared.tenant_session,
    }
    found = [n for n in expected if hasattr(mod, n)]
    assert found, f"{module_path} exposes no DB seam name at all"
    for name in found:
        # email.core keeps a thin wrapper to preserve its `request_id` param —
        # what matters is that nothing shadows the seam with another pool.
        if module_path == "gateway.routes.email.core" and name == "_get_db":
            continue
        assert getattr(mod, name) is expected[name], (
            f"{module_path}.{name} does not resolve to acb_common.db.{name.lstrip('_')}"
        )


def test_acb_auth_shares_the_pool() -> None:
    """Access resolution runs in the gateway process and must not add a pool."""
    from acb_auth import access
    from acb_common import db as shared

    assert access._get_session_factory is shared.get_session_factory


# ── H2 ratchet — get_db() call sites only go DOWN ───────────────────────────
#
# `saas_multitenancy_handover.md` H2: every `await get_db()` is a session that
# will read ZERO rows once the RLS phase-4 policies apply, so the workstream's
# done-when is "the grep returns 0". Converting 500+ sites takes many PRs;
# this pair of tests is what stops the number creeping back up in between.

_GET_DB_CALL = re.compile(r"await _?get_db\(\)")

#: Sites that are ALLOWED to stay on the unbound seam, each with the reason.
#: An entry here is a decision, not a grandfathering — H4 owns retiring them.
H2_EXEMPT_FILES: dict[str, str] = {
    "apps/services/gateway/gateway/routes/projects/agent_dispatch.py":
        "event consumer, not a request handler — H4 threads an explicit "
        "tenant through the event payload; ambient inheritance is forbidden",
}

#: routes/whatsapp's allowed remainder (H2 slice, 2026-08-10): file → site
#: count. This package is ingestion-heavy, so unlike projects it cannot pin at
#: zero — these are service-identity entry points (Meta webhook / the Go
#: bridge's shared-secret pushes: `system:internal` and signature-authed
#: callers bind NO tenant, so `tenant_session()` there would 500 every inbound
#: batch) and background consumers (post-sync hooks, the enrichment loop, the
#: Action Broker broadcast handler). H4/H6 owns threading an explicit tenant
#: through each; every site carries the matching `# H4`/`# H4/H6` marker.
H2_WHATSAPP_EXEMPT_SITES: dict[str, int] = {
    "apps/services/gateway/gateway/routes/whatsapp/transport/webhook.py": 2,
    "apps/services/gateway/gateway/routes/whatsapp/transport/bridge.py": 5,
    "apps/services/gateway/gateway/routes/whatsapp/scheduler.py": 2,
    "apps/services/gateway/gateway/routes/whatsapp/automation/intent.py": 1,
    "apps/services/gateway/gateway/routes/whatsapp/automation/replyzero.py": 1,
    "apps/services/gateway/gateway/routes/whatsapp/automation/transcription.py": 1,
    "apps/services/gateway/gateway/routes/whatsapp/automation/groups.py": 1,
    "apps/services/gateway/gateway/routes/whatsapp/automation/outbound.py": 1,
}

#: The unconverted remainder OUTSIDE routes/projects at the time the Projects
#: slice landed (2026-08-10). Lower it as packages convert; never raise it.
<<<<<<< HEAD
#: 494 → 433: routes/notes converted (61 handler sites → `_tenant_session`;
#: 33 remain there — background pipeline/poller/copilot-task sites and the
#: meeting-bot worker's service-identity paths, each marked `# H4` in place).
#: 433 → 395: routes/whatsapp's 38 request-handler sites (2026-08-10; its
#: 14 B/C leftovers are pinned file-by-file by the whatsapp remainder test).
#: 395 → 297: routes/email's 98 request-handler sites (2026-08-10); its 27
#: leftovers are B/C-class (webhook, OAuth callback, scheduler hooks,
#: BackgroundTask jobs), each with a per-site H4/H6 marker naming its tenant.
#: 297 → 224: routes/tasks' 73 request-handler sites (2026-08-10); its 6
#: leftovers are background consumers (broker_handlers, scheduler, calendar's
#: rollover sweep), each with an H4 comment naming why ambient inheritance is
#: forbidden for them.
#: 224 → 198: routes/workflows' 26 member-facing sites (2026-08-10); its
#: 17 leftovers are the engine/scheduler/dual-use run lifecycle (C) and
#: the hook-token trigger route (B), each marked in place.
#: 198 → 166: routes/apps' 32 member-facing sites (2026-08-10); its 6
#: leftovers are pinned by H2_APPS_EXEMPT_SITES below.
H2_BASELINE_ELSEWHERE = 166

#: routes/apps (H2 slice, 2026-08-10): the sites that STAY on the unbound
#: seam, as file → exact remaining count. Counts rather than whole files
#: because ``tools.py`` is mixed — its request handlers are converted while
#: its broker-invoked ``_apply_publish_review`` stays. Each entry is a
#: decision, not a grandfathering — H4 owns retiring them, and each site's
#: own ``H4`` comment names the reason and the tenant source (the app row's
#: organization):
#:
#:   * ``actions.py`` (4) — ``execute_app_action`` + its ``_run_storage_*``
#:     helpers are dual-audience: the HTTP route AND the orchestrator's
#:     in-process agent tools (``orchestrator/app_tools.py``), which run with
#:     no request and no bound tenant.
#:   * ``_common.py`` (1) — ``record_app_audit``, reached from that same
#:     agent path; converting it would silently drop agent-action audit rows.
#:   * ``tools.py`` (1) — ``_apply_publish_review``, an Action Broker
#:     handler that runs when an admin approves a queued proposal.
H2_APPS_EXEMPT_SITES: dict[str, int] = {
    "apps/services/gateway/gateway/routes/apps/_common.py": 1,
    "apps/services/gateway/gateway/routes/apps/actions.py": 4,
    "apps/services/gateway/gateway/routes/apps/tools.py": 1,
}


def _get_db_sites() -> dict[str, int]:
    out: dict[str, int] = {}
    for base in ("apps", "packages"):
        for path in (_REPO / base).rglob("*.py"):
            n = len(_GET_DB_CALL.findall(path.read_text(encoding="utf-8")))
            if n:
                out[str(path.relative_to(_REPO)).replace("\\", "/")] = n
    return out


def test_routes_projects_is_converted_and_stays_converted() -> None:
    """The Projects package acquires sessions ONLY through `tenant_session`.

    A new `get_db()` here is a handler whose queries will silently return
    nothing under RLS — the fail-closed symptom H2's runbook warns about.
    """
    sites = _get_db_sites()
    offenders = {
        f: n for f, n in sites.items()
        if f.startswith("apps/services/gateway/gateway/routes/projects/")
        and f not in H2_EXEMPT_FILES
    }
    assert offenders == {}, (
        f"unbound get_db() in converted package: {offenders} — use "
        f"`async with _tenant_session() as db:` (core.py) instead"
    )


def test_routes_whatsapp_holds_at_its_named_remainder() -> None:
    """The WhatsApp package's unbound sites are EXACTLY the named exemptions.

    Two failure modes, both caught: a new `get_db()` handler (would silently
    read nothing under RLS — convert it to `_tenant_session`), and a site
    LEAVING the list (progress — bank it by shrinking the dict, so the
    remainder can only ratchet down).
    """
    sites = {
        f: n for f, n in _get_db_sites().items()
        if f.startswith("apps/services/gateway/gateway/routes/whatsapp/")
    }
    assert sites == H2_WHATSAPP_EXEMPT_SITES, (
        "routes/whatsapp unbound get_db() sites drifted from the named "
        f"remainder.\n  measured: {sites}\n  pinned:   "
        f"{H2_WHATSAPP_EXEMPT_SITES}\nA NEW site must use `async with "
        "_tenant_session() as db:` (core.py); a RETIRED site must leave "
        "H2_WHATSAPP_EXEMPT_SITES in this test."
    )


def test_routes_apps_is_converted_and_stays_converted() -> None:
    """The Custom Apps package acquires sessions through `tenant_session`,
    except the named H4 sites — pinned by EXACT count, both directions.

    A count above an entry (or a new file) is a handler whose queries will
    silently return nothing under RLS; a count below it is banked progress
    that must lower the entry, or the headroom becomes new-debt budget.
    """
    sites = {
        f: n for f, n in _get_db_sites().items()
        if f.startswith("apps/services/gateway/gateway/routes/apps/")
    }
    assert sites == H2_APPS_EXEMPT_SITES, (
        f"routes/apps unbound get_db() sites {sites} != the named exemptions "
        f"{H2_APPS_EXEMPT_SITES} — new sites must use "
        f"`async with _tenant_session() as db:` (_common.py); a retired "
        f"exemption must shrink H2_APPS_EXEMPT_SITES in this test"
    )


def test_get_db_sites_elsewhere_only_ratchet_down() -> None:
    total = sum(
        n for f, n in _get_db_sites().items()
        if not f.startswith("apps/services/gateway/gateway/routes/projects/")
    )
    assert total <= H2_BASELINE_ELSEWHERE, (
        f"{total} unbound get_db() sites outside routes/projects — above the "
        f"frozen H2 baseline of {H2_BASELINE_ELSEWHERE}. New code must use "
        f"tenant_session(); see saas_multitenancy_handover.md H2."
    )
    if total < H2_BASELINE_ELSEWHERE:
        # Progress must be BANKED, or the headroom becomes new-debt budget.
        assert total > H2_BASELINE_ELSEWHERE - 25, (
            f"H2 progress: {total} sites remain — lower H2_BASELINE_ELSEWHERE "
            f"to {total} in this PR to bank it"
        )

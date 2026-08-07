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
"""

from __future__ import annotations

import ast
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


def _python_files() -> list[Path]:
    roots = [_REPO / "apps", _REPO / "packages"]
    out: list[Path] = []
    for root in roots:
        out.extend(
            p for p in root.rglob("*.py")
            if "__pycache__" not in p.parts and ".venv" not in p.parts
        )
    return out


def _calls_create_async_engine(path: Path) -> bool:
    """True if the file CALLS ``create_async_engine``.

    Parsed rather than grepped: every one of these modules mentions the name in
    prose explaining that it does not call it, and a substring match would read
    the documentation as a violation.
    """
    # utf-8-sig: at least one module in the tree carries a BOM, and a leading
    # ﻿ is a syntax error to ast.parse.
    tree = ast.parse(path.read_text(encoding="utf-8-sig"), filename=str(path))
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        func = node.func
        name = (
            func.id if isinstance(func, ast.Name)
            else func.attr if isinstance(func, ast.Attribute)
            else None
        )
        if name == "create_async_engine":
            return True
    return False


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


def test_gateway_makes_no_engine_of_its_own() -> None:
    """The gateway process holds exactly one pool.

    Narrower than the repo-wide check above and worth stating separately: the
    gateway is where the twelve pools were, and it is the process where a second
    one is most expensive — it also runs ``acb_auth.access``, which resolves
    permissions from Postgres on the request path.
    """
    gateway = _REPO / "apps" / "services" / "gateway"
    offenders = sorted(
        str(p.relative_to(_REPO)).replace("\\", "/")
        for p in gateway.rglob("*.py")
        if "__pycache__" not in p.parts and _calls_create_async_engine(p)
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

"""MT-1c — no new raw ``psycopg.connect`` call sites.

``saas_multitenancy.md`` §0.1 measured every path in the process that opens a
database connection and found eight. Three of them do not go through SQLAlchemy
at all — they open a raw psycopg connection:

* ``acb_llm/key_store.py:83-108``   — provider keys   (path 5)
* ``acb_llm/model_config.py:52-76`` — model config    (path 6)
* ``acb_common/org_settings.py:55-81`` — org settings (path 7)

None of the three was visible to ``test_db_engine_seam.py``, which inspects the
SQLAlchemy engine constructors and nothing else. That is why §0.1 states, as
acceptance criterion 3: *"Add a companion ratchet for ``psycopg.connect``, with
the same allow-list-with-a-reason discipline. Paths 5-7 were invisible to the
existing test."* This is that ratchet.

Why it matters under D15: tenant isolation is enforced by Postgres RLS, and RLS
reads ``app.tenant_id`` from the **connection**. A connection opened outside the
seam is a connection with nothing bound. It fails closed rather than leaking —
``current_setting('app.tenant_id', true)`` is NULL and the query returns zero
rows — but it fails closed *at runtime, in whatever environment first exercises
it*, which for a rarely-taken config read can be production. A source-level
check fails it at build time instead.

Scope, stated so the next reader knows what this does NOT cover: it matches
``connect`` calls rooted at a psycopg module (and ``connect`` imported from one).
A connection pool constructed as ``psycopg_pool.ConnectionPool(...)`` is a
different call shape and would slip past — measured 2026-08-08, the tree has no
psycopg_pool import at all, so the narrower rule costs nothing today. If a pool
is ever introduced, widen ``_opens_a_psycopg_connection`` rather than allow-list
the file. Path 8 (``acb_memory/mem0_client.py``) is out of reach of any
source-level rule here: it hands a conninfo string to Mem0, which opens the
connection inside a third-party library. §0.1 criterion 4 owns that one.
"""

from __future__ import annotations

import ast
from pathlib import Path

_REPO = Path(__file__).resolve().parents[2]

#: Modules whose ``connect`` opens a real libpq connection.
#: ``psycopg2`` is listed although the tree does not use it — the failure this
#: guards is a *new* call site, and a new one arriving under the older import
#: name would otherwise be silently permitted.
_PSYCOPG_ROOTS = frozenset({"psycopg", "psycopg2"})

#: Every file allowed to call ``psycopg.connect``, and why.
#:
#: To add an entry you must answer "why can this not go through
#: ``acb_common.db``?" *and* "which tenant does this connection bind?". The
#: three below predate MT-1c and are named individually in §0.1's inventory;
#: each one is a binding site the RLS work must convert, not a permanent
#: exemption from it.
_ALLOWED: dict[str, str] = {
    "packages/acb_llm/acb_llm/key_store.py":
        "connection path 5 — provider keys; became per-org in MT-0d, sync "
        "psycopg under asyncio.to_thread to dodge the Windows ProactorEventLoop",
    "packages/acb_llm/acb_llm/model_config.py":
        "connection path 6 — model config; became per-org in MT-0d, sync "
        "psycopg so sync helpers and async handlers share one reader",
    "packages/acb_common/acb_common/org_settings.py":
        "connection path 7 — control-plane read of org-wide settings blobs, "
        "sync psycopg so it is callable from both sync and async code",
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


def _dotted(func: ast.expr) -> list[str] | None:
    """The dotted path of a call target, e.g. ``psycopg.AsyncConnection.connect``.

    Returns ``None`` for anything not built purely from names and attributes
    (a call on a subscript or on another call's result), which no psycopg
    connect site in this tree is.
    """
    parts: list[str] = []
    node: ast.expr = func
    while isinstance(node, ast.Attribute):
        parts.append(node.attr)
        node = node.value
    if not isinstance(node, ast.Name):
        return None
    parts.append(node.id)
    parts.reverse()
    return parts


def _opens_a_psycopg_connection(path: Path) -> bool:
    """True if the file CALLS ``psycopg.connect``.

    Parsed rather than grepped, for the same reason the engine ratchet is: all
    three allow-listed modules discuss psycopg in prose — ``org_settings`` says
    *"Uses a synchronous psycopg connection"* in its module docstring — and a
    substring match would count the documentation as a call site.

    Two spellings are accepted as violations:

    * a dotted call rooted at a psycopg module whose last segment is ``connect``
      — ``psycopg.connect(...)`` and ``psycopg.AsyncConnection.connect(...)``;
    * a bare ``connect(...)`` where ``connect`` was imported from psycopg,
      under its own name or an alias. Nothing in the tree spells it that way
      today; it is covered because it is the obvious way to evade the first rule
      without meaning to.
    """
    # utf-8-sig: at least one module in the tree carries a BOM, and a leading
    # ﻿ is a syntax error to ast.parse.
    tree = ast.parse(path.read_text(encoding="utf-8-sig"), filename=str(path))

    # Local names bound to psycopg's own ``connect`` by a from-import.
    aliased: set[str] = set()
    for node in ast.walk(tree):
        if not isinstance(node, ast.ImportFrom) or node.module is None:
            continue
        if node.module.split(".")[0] not in _PSYCOPG_ROOTS:
            continue
        aliased.update(
            alias.asname or alias.name
            for alias in node.names
            if alias.name == "connect"
        )

    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        if isinstance(node.func, ast.Name) and node.func.id in aliased:
            return True
        parts = _dotted(node.func)
        if parts and len(parts) > 1 and parts[0] in _PSYCOPG_ROOTS and parts[-1] == "connect":
            return True
    return False


def test_no_new_psycopg_connections() -> None:
    offenders = sorted(
        str(p.relative_to(_REPO)).replace("\\", "/")
        for p in _python_files()
        if _opens_a_psycopg_connection(p)
    )
    unexpected = [p for p in offenders if p not in _ALLOWED]
    assert not unexpected, (
        "New psycopg.connect() call site(s):\n  "
        + "\n  ".join(unexpected)
        + "\n\nUse acb_common.db (get_db / get_session_factory) — the shared "
          "seam is where the tenant is bound. A raw connection binds no "
          "app.tenant_id and RLS will serve it zero rows. If this genuinely "
          "needs its own connection, add it to _ALLOWED in this test with the "
          "reason AND how it binds a tenant (saas_multitenancy.md §0.1)."
    )


def test_allowlist_has_no_stale_entries() -> None:
    """A file that stopped opening its own connection must leave the allowlist.

    Same reason the engine ratchet holds this line: the list otherwise grows
    into permission for anything, and the next reader cannot tell which entries
    are still load-bearing. Here it also tracks progress — an entry leaving is
    a §0.1 path that moved onto the shared seam.
    """
    offenders = {
        str(p.relative_to(_REPO)).replace("\\", "/")
        for p in _python_files()
        if _opens_a_psycopg_connection(p)
    }
    stale = sorted(set(_ALLOWED) - offenders)
    assert not stale, f"Allowlist entries that no longer open a connection: {stale}"


def test_inventory_matches_the_spec() -> None:
    """The allow-list is exactly §0.1's paths 5-7 — no more, no fewer.

    The check above proves no *new* file connects; this pins the set to the
    three the spec enumerated. If the inventory in ``saas_multitenancy.md`` §0.1
    and this list ever disagree, one of them is out of date, and the spec is the
    document people plan the RLS rollout from.
    """
    assert set(_ALLOWED) == {
        "packages/acb_llm/acb_llm/key_store.py",
        "packages/acb_llm/acb_llm/model_config.py",
        "packages/acb_common/acb_common/org_settings.py",
    }

"""Guard against a SQLAlchemy footgun: ``:name::jsonb`` in raw ``text()`` SQL.

SQLAlchemy's bind-param scanner treats a colon-name immediately followed by
``::`` (Postgres's cast operator) as NOT a parameter — it silently drops the
last character of the name and leaves the rest as literal SQL text, which
the driver then fails to parse ("syntax error at or near ':'"). This bit
every JSONB-casting INSERT across the Custom Apps write path (create, fork,
publish, audit log, storage writes) — six sites, all broken since Phase 0 —
because none of it surfaces at import time or in a DB-less unit test; it
only fails when the statement actually executes.

The fix is a single space before the cast: ``:name ::jsonb`` parses fine.
This test scans source for the broken shape so it can't silently return.
"""
from __future__ import annotations

import re
from pathlib import Path

_ROOT = Path(__file__).resolve().parents[2]
_BROKEN = re.compile(r"(?<!:):[A-Za-z_]\w*::[A-Za-z_]")


def test_no_unspaced_bindparam_jsonb_casts():
    offenders: list[str] = []
    for py in (_ROOT / "apps" / "services" / "gateway" / "gateway").rglob("*.py"):
        text = py.read_text(encoding="utf-8")
        for i, line in enumerate(text.splitlines(), start=1):
            if _BROKEN.search(line):
                offenders.append(f"{py.relative_to(_ROOT)}:{i}: {line.strip()}")
    assert not offenders, (
        "found ':name::type' bind params with no space before '::' — "
        "SQLAlchemy mis-parses these (see module docstring):\n"
        + "\n".join(offenders)
    )

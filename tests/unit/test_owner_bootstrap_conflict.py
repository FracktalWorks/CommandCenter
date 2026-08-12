"""The owner bootstrap's ON CONFLICT target must match a real unique index.

⚠️ This fence exists because the thing it checks was broken for an unknown
period and no test noticed.

`_BOOTSTRAP_OWNER_SQL` used `ON CONFLICT (email)`. Migration 162 dropped
`app_user_email_key` — the byte-exact `UNIQUE (email)` — and replaced it with
the functional index `app_user_email_lower_key ON app_user (lower(email))`,
because every lookup in this codebase matches case-insensitively (R10).

Postgres infers the arbiter index from the ON CONFLICT target. Against the bare
column there was no longer one, so the statement raised
`InvalidColumnReferenceError`, `ensure_owner_bootstrap()` logged
`ownership_bootstrap_failed`, and nobody was provisioned.

**Production never saw it**, which is why it survived: it bootstrapped an owner
before 162 ran, and `_HAS_OWNER_SQL` short-circuits the whole function once one
exists. It bit only a database with no owner YET — a new tenant, a restore to
scratch, disaster recovery, or a laptop. That is the "way back in" this
function exists to provide after the 2026-07-30 lockout, so the failure mode
was: the recovery path is itself unrecoverable, silently, and only when you
need it.

The fence is structural rather than a live round trip on purpose. A live test
needs a migrated Postgres and skips without one — which is exactly the
condition under which this bug hides. This one runs everywhere.
"""

from __future__ import annotations

import re
from pathlib import Path

MIGRATIONS = Path(__file__).resolve().parents[2] / "infra" / "postgres"


def _conflict_targets(sql: str) -> list[str]:
    """Every `ON CONFLICT (<target>)` in a statement, comments stripped."""
    stripped = "\n".join(re.sub(r"--.*$", "", line) for line in sql.splitlines())
    # Balanced to ONE level of nesting: the target is `lower(email)`, and a
    # naive `[^)]+` stops at the inner paren and yields `lower(email` — which
    # then fails to match a perfectly correct index and sends you hunting a
    # bug in the SQL that is really a bug in the reader.
    return [
        m.group(1).strip()
        for m in re.finditer(
            r"ON\s+CONFLICT\s*\(((?:[^()]|\([^()]*\))*)\)", stripped, re.I,
        )
    ]


def _unique_index_expressions(table: str) -> set[str]:
    """Expressions the migrations make UNIQUE on a table.

    Read from the migration ladder rather than restated, for the reason every
    other mirror fence in this tree is: a copied fact is a fact that will
    eventually lie. Both spellings count — a `UNIQUE (col)` inline constraint
    and a `CREATE UNIQUE INDEX … ON t (expr)`.
    """
    found: set[str] = set()
    dropped: set[str] = set()
    for path in sorted(MIGRATIONS.glob("*.sql"), key=lambda p: p.name):
        if path.name == "schema.generated.sql":
            continue
        text = "\n".join(
            re.sub(r"--.*$", "", line)
            for line in path.read_text(encoding="utf-8").splitlines()
        )
        for m in re.finditer(
            rf"CREATE\s+UNIQUE\s+INDEX(?:\s+IF\s+NOT\s+EXISTS)?\s+(\w+)\s+ON\s+{table}\s*"
            rf"\(((?:[^()]|\([^()]*\))*)\)",
            text, re.I,
        ):
            found.add(_norm(m.group(2)))
        # A dropped constraint stops being an arbiter, which is the whole bug.
        for m in re.finditer(r"DROP\s+CONSTRAINT\s+(?:IF\s+EXISTS\s+)?(\w+)", text, re.I):
            dropped.add(m.group(1).lower())
        if (
            re.search(rf"CREATE\s+TABLE[^;]*{table}\b[^;]*?\bemail\s+TEXT[^,;]*UNIQUE", text, re.I | re.S)
            and "app_user_email_key" not in dropped
        ):
            found.add("email")
    if "app_user_email_key" in dropped:
        found.discard("email")
    return found


def _norm(expr: str) -> str:
    return re.sub(r"\s+", "", expr).lower()


def test_the_bootstrap_conflict_target_has_a_matching_unique_index() -> None:
    from acb_auth.access import _BOOTSTRAP_OWNER_SQL

    targets = [_norm(t) for t in _conflict_targets(_BOOTSTRAP_OWNER_SQL)]
    assert targets, "no ON CONFLICT in the bootstrap — did the statement change shape?"

    available = _unique_index_expressions("app_user")
    assert available, "no unique index on app_user found in the migrations — parser broken?"

    for target in targets:
        assert target in available, (
            f"`ON CONFLICT ({target})` has no matching unique index on app_user. "
            f"The migrations provide: {sorted(available)}. Postgres infers the "
            f"arbiter from this target and raises InvalidColumnReferenceError "
            f"when nothing matches — which makes ensure_owner_bootstrap() a "
            f"silent no-op on any database that has no owner yet."
        )


def test_the_byte_exact_email_unique_is_gone_so_the_bare_column_cannot_come_back() -> None:
    """Pins the premise the fence above rests on.

    If a later migration re-added `UNIQUE (email)`, `ON CONFLICT (email)` would
    start working again and this fence would stop meaning anything — so the
    absence is asserted rather than assumed.
    """
    available = _unique_index_expressions("app_user")
    assert "email" not in available, (
        "a bare UNIQUE(email) is back on app_user. Migration 162 removed it "
        "deliberately: byte-exact uniqueness let one person hold two rows "
        "differing only by case, in two organizations."
    )
    assert "lower(email)" in available

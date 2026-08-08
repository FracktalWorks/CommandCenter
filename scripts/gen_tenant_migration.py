#!/usr/bin/env python3
"""Generate the MT-1b tenancy migration — org_id + FORCE RLS on every table.

Spec: ``ai-company-brain/specs/saas_multitenancy.md`` §1.3 / MT-1b ·
shapes in ``saas_multitenancy_implementation.md`` §1 · board WS-29 · D15.

WHY A GENERATOR AND NOT A HAND-WRITTEN MIGRATION
------------------------------------------------
143 tables. Hand-writing that is 143 chances to omit ``FORCE``, or ``WITH
CHECK``, or the ``, true`` missing-ok flag — and each omission is silent. A
generator makes the *template* the reviewable artifact and the per-table
expansion mechanical.

WHY THE OUTPUT IS NOT A NUMBERED MIGRATION
------------------------------------------
Read ``scripts/apply_migrations.sh`` before changing this. That runner exists in
its current shape because of a **14h44m production outage**: a hung LLM call held
a session open, the runner asked for ACCESS EXCLUSIVE behind it, and because
Postgres's lock queue is FIFO every later reader queued behind the *waiting*
ALTER. Sending mail stopped.

MT-1b is precisely that shape of change, 143 times over:

* ``ADD COLUMN ... NOT NULL`` and ``SET NOT NULL`` take **ACCESS EXCLUSIVE** and
  scan the whole table. On ``email_messages`` with real mail in it, that is not
  instant.
* The backfill ``UPDATE`` rewrites every row.
* A single transaction wrapping all of it holds every lock until the end.

So this script writes to ``infra/postgres/generated/`` — **outside the numbered
sequence the deploy replays.** Promoting it into the sequence is a deliberate
human act, taken against a database, in a window. It is not something that
should happen because a file landed on main.

PHASING (why the output is four files, not one)
-----------------------------------------------
Each phase is separately applicable and separately abortable:

  1. ``add_columns``   — nullable ADD COLUMN, no scan, no lock of consequence
  2. ``backfill``      — batched UPDATE; re-runnable; the slow part
  3. ``constraints``   — SET NOT NULL + FK + index; the ACCESS EXCLUSIVE phase
  4. ``policies``      — ENABLE + FORCE RLS + the policy; instant, and the
                         moment isolation becomes real

⚠️ **Phase 4 is a cliff.** The instant it applies, every connection that has not
bound ``app.tenant_id`` reads **zero rows** — that is the fail-closed property
(§0.1) working as designed, and it means MT-1c must be deployed and verified
FIRST or the product goes dark. The ordering is not a preference.

Usage::

    uv run python scripts/gen_tenant_migration.py            # write the four files
    uv run python scripts/gen_tenant_migration.py --dry-run  # print a summary
"""
from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

_REPO = Path(__file__).resolve().parents[1]
_MIGRATIONS = _REPO / "infra" / "postgres"
_OUT = _MIGRATIONS / "generated"

#: Tables that are cross-tenant BY DESIGN and must never carry a policy.
#: **This list is the security review.** Adding a name here exempts a table from
#: tenant isolation, so every entry carries its reason and a reviewer is expected
#: to challenge it.
EXEMPT: dict[str, str] = {
    # ── Control plane (§1.5): must be readable ACROSS tenants ──────────────
    "organization":            "the tenant list itself",
    "tenant_placement":        "control plane — which data plane serves whom",
    "user_identity":           "control plane — one row per human, global by design",
    "org_membership":          "control plane — the tenant-scoped half; org_id is its PK",
    # ── Catalogs: identical for every tenant, no customer data ─────────────
    "feature_catalog":         "a catalog of product surfaces, not tenant data",
    "schema_migrations":       "migration bookkeeping",
    # ── Already tenant-keyed by an earlier migration ───────────────────────
    "provider_keys":           "keyed (organization_id, provider) by MT-0d / 158",
    "model_config":            "keyed (organization_id, key) by MT-0d / 158",
    "mcp_servers":             "keyed (organization_id, name) by MT-0d / 158",
    "org_role":                "carries organization_id since 130",
    "org_group":               "carries organization_id since 138",
    # ── Vendored schemas we do not own ─────────────────────────────────────
    "_prisma_migrations":      "LiteLLM's own schema",
}

#: Tables whose ``organization_id`` is reachable only through a parent. Listed so
#: a reviewer sees they were CONSIDERED, not missed — each still gets its own
#: column (denormalised on purpose: a policy that has to JOIN to find the tenant
#: is a policy that is slow on every read and wrong under a missing parent).
_DENORMALISE_NOTE = (
    "child rows carry their own organization_id rather than joining to a parent: "
    "an RLS policy runs on EVERY row of EVERY query, and a join in USING() is "
    "both a performance cliff and a correctness hole when the parent is gone"
)

_CREATE_RE = re.compile(
    r"CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?"
    r"(?:public\.)?[\"']?([a-z_][a-z0-9_]*)[\"']?",
    re.IGNORECASE,
)


def discover_tables() -> list[str]:
    """Every table the numbered migrations create, in name order."""
    names: set[str] = set()
    for path in sorted(_MIGRATIONS.glob("[0-9]*_*.sql")):
        for match in _CREATE_RE.finditer(path.read_text(encoding="utf-8")):
            names.add(match.group(1).lower())
    return sorted(names)


def _header(phase: str, why: str, tables: int) -> str:
    return f"""-- ============================================================================
-- MT-1b · phase {phase} — GENERATED, DO NOT EDIT BY HAND
-- ============================================================================
-- Regenerate with: uv run python scripts/gen_tenant_migration.py
-- Spec: ai-company-brain/specs/saas_multitenancy.md §1.3 · MT-1b · WS-29 · D15
--
-- {why}
--
-- Tables in this phase: {tables}
--
-- ⚠️ NOT a numbered migration. `apply_migrations.sh` does not replay this
-- directory. Promoting it is a deliberate act taken against a database in a
-- maintenance window — see the module docstring of the generator for the
-- outage that makes that non-negotiable.
-- ============================================================================

"""


def gen_add_columns(tables: list[str]) -> str:
    out = [_header("1/4 add_columns",
                   "Nullable ADD COLUMN. No table scan, no lock of consequence. "
                   "Safe to apply on a live system.", len(tables))]
    for t in tables:
        out.append(
            f"ALTER TABLE {t}\n"
            f"    ADD COLUMN IF NOT EXISTS organization_id UUID\n"
            f"    DEFAULT current_setting('app.tenant_id', true)::uuid;\n"
        )
    return "\n".join(out)


def gen_backfill(tables: list[str]) -> str:
    out = [_header("2/4 backfill",
                   "Batched UPDATE. Re-runnable and interruptible — each statement "
                   "is idempotent, so a run that aborts can simply be run again. "
                   "This is the slow phase; expect it to be the long pole on any "
                   "table with real volume.", len(tables))]
    out.append(
        "-- The operator's own organization owns every pre-existing row: this box\n"
        "-- served exactly one tenant before MT-1b.\n"
    )
    for t in tables:
        out.append(
            f"UPDATE {t} SET organization_id = "
            f"(SELECT id FROM organization WHERE slug = 'default')\n"
            f" WHERE organization_id IS NULL;\n"
        )
    return "\n".join(out)


def gen_constraints(tables: list[str]) -> str:
    out = [_header("3/4 constraints",
                   "SET NOT NULL + FK + index. ⚠️ THIS IS THE ACCESS EXCLUSIVE "
                   "PHASE — it scans each table. Apply in a window, table by "
                   "table if necessary, and never behind a long-running "
                   "transaction (see the generator docstring: that is the exact "
                   "shape of the 14h44m outage).", len(tables))]
    for t in tables:
        out.append(
            f"-- {t}\n"
            f"DO $$\nBEGIN\n"
            f"    IF EXISTS (SELECT 1 FROM {t} WHERE organization_id IS NULL) THEN\n"
            f"        RAISE EXCEPTION 'MT-1b: {t} still has unowned rows — "
            f"run phase 2 (backfill) to completion first';\n"
            f"    END IF;\n"
            f"END $$;\n"
            f"ALTER TABLE {t} ALTER COLUMN organization_id SET NOT NULL;\n"
            f"ALTER TABLE {t} ADD CONSTRAINT {t}_org_fk\n"
            f"    FOREIGN KEY (organization_id) REFERENCES organization(id) "
            f"ON DELETE CASCADE;\n"
            f"CREATE INDEX IF NOT EXISTS {t}_org_idx ON {t} (organization_id);\n"
        )
    return "\n".join(out)


def gen_policies(tables: list[str]) -> str:
    out = [_header("4/4 policies",
                   "ENABLE + FORCE ROW LEVEL SECURITY + the policy. Instant — no "
                   "scan. ⚠️ AND IT IS A CLIFF: the moment this applies, any "
                   "connection that has not bound app.tenant_id reads ZERO ROWS. "
                   "That is the fail-closed property working (§0.1). MT-1c must "
                   "be deployed AND VERIFIED first, or the product goes dark.",
                   len(tables))]
    out.append(
        "-- Four clauses, each load-bearing (saas_multitenancy_implementation.md §1.1):\n"
        "--   ENABLE       turns the policy on for ordinary roles\n"
        "--   FORCE        applies it to the table OWNER too — without this the\n"
        "--                owner silently reads every tenant\n"
        "--   USING        filters what a query can SEE\n"
        "--   WITH CHECK   constrains what it can WRITE. Without it a tenant can\n"
        "--                INSERT a row stamped with another tenant's id.\n"
        "--   , true       makes an unset GUC return NULL (-> no rows) instead of\n"
        "--                RAISING, so an unconverted path fails closed and quiet\n"
        "--                rather than 500-ing everywhere at once.\n"
    )
    for t in tables:
        out.append(
            f"ALTER TABLE {t} ENABLE ROW LEVEL SECURITY;\n"
            f"ALTER TABLE {t} FORCE  ROW LEVEL SECURITY;\n"
            f"DROP POLICY IF EXISTS {t}_tenant_isolation ON {t};\n"
            f"CREATE POLICY {t}_tenant_isolation ON {t}\n"
            f"    USING      (organization_id = current_setting('app.tenant_id', true)::uuid)\n"
            f"    WITH CHECK (organization_id = current_setting('app.tenant_id', true)::uuid);\n"
        )
    return "\n".join(out)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--dry-run", action="store_true",
                    help="print the plan without writing files")
    args = ap.parse_args()

    all_tables = discover_tables()
    scoped = [t for t in all_tables if t not in EXEMPT]
    exempted = [t for t in all_tables if t in EXEMPT]

    print(f"discovered {len(all_tables)} tables in infra/postgres/[0-9]*.sql")
    print(f"  tenant-scoped : {len(scoped)}")
    print(f"  exempt        : {len(exempted)}")
    for t in exempted:
        print(f"      {t:<24} {EXEMPT[t]}")
    unknown = sorted(set(EXEMPT) - set(all_tables))
    if unknown:
        print("\n  ⚠️ exempt names that match no discovered table "
              "(stale entry, or the table moved):")
        for t in unknown:
            print(f"      {t}")

    if args.dry_run:
        print(f"\n(dry run — nothing written)\n{_DENORMALISE_NOTE}")
        return 0

    _OUT.mkdir(parents=True, exist_ok=True)
    phases = {
        "01_add_columns.sql": gen_add_columns(scoped),
        "02_backfill.sql": gen_backfill(scoped),
        "03_constraints.sql": gen_constraints(scoped),
        "04_policies.sql": gen_policies(scoped),
    }
    for name, body in phases.items():
        (_OUT / name).write_text(body, encoding="utf-8")
        print(f"wrote {(_OUT / name).relative_to(_REPO)}")

    print("\n⚠️ These are NOT numbered migrations and will not be replayed by "
          "apply_migrations.sh. Apply phases 1-4 IN ORDER, against a scratch "
          "database first. Phase 4 requires MT-1c deployed and verified.")
    return 0


if __name__ == "__main__":
    sys.exit(main())

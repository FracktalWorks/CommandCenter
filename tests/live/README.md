# Live verification harnesses

**These found a bug in every single ticket they were written for — several times with the whole
hermetic suite green.** That is the entire argument for their existence, and it is why they are
in the repository rather than in somebody's scratch directory.

They are **not** unit tests. They need a real Postgres 16 with the full migration set applied,
they drive the **real endpoint functions** (not mocks, not a `TestClient`), and each one prints
`ok`/`FAIL` per assertion and exits non-zero on any failure.

Named `live_*.py`, so pytest does not collect them — verified. Do not rename them to `test_*`.

## Running one

```bash
su postgres -c "/usr/lib/postgresql/16/bin/pg_ctl -D <datadir> -o '-k /var/tmp -p 55432' start"
uv run python tests/live/live_ws29.py
```

Each script sets its own `DATABASE_URL` at the top —
`postgresql+asyncpg://postgres@/cc?host=/var/tmp&port=55432`. **Change it to point at your
database**, and read the next paragraph before you do.

⚠️ **Most of these `TRUNCATE pm_projects CASCADE` in their `seed()`.** That is safe against a
scratch database and catastrophic against anything you care about. Point them at a throwaway
copy, never at production, and never at a database whose contents you have not just backed up.

## What each one pins

| Script | Ticket | The thing only a database could answer |
|---|---|---|
| `live_ws27k.py` | filters | `CAST(:x AS timestamptz)` with a bound `str` — asyncpg refuses it |
| `live_ws27l.py` | custom fields | JSONB round-trip; asyncpg has no codec for a bare dict |
| `live_ws27m.py` | tags | `CROSS JOIN LATERAL … WITH ORDINALITY`; `array_agg(DISTINCT …)` reordering |
| `live_ws27n.py` | bulk edit | The visibility clause's two doors, which the fake conflated |
| `live_ws27o.py` | recurrence | `array_length('{}',1)` is NULL, and a CHECK only fails on FALSE |
| `live_ws27p.py` | relations | Two-direction `UNION`; child visibility not inherited from the parent |
| `live_ws27q.py` | calendar | Interval overlap; `AT TIME ZONE 'UTC'` vs the session's `TimeZone` |
| `live_ws27r.py` | search | `AmbiguousParameterError`; backslash as LIKE's escape on a bound param |
| `live_ws27s.py` | task card | Page-wide aggregates over `= ANY(CAST(:ids AS uuid[]))` |
| `live_ws27t.py` | timeline | Edges with both ends in a window; a DATE beside a timestamptz in `UNION ALL` |
| `live_ws27ae.py` | delta sync | The tombstone trigger firing on a project **CASCADE** — the fake models no FKs, so its `_delete` mirror can only prove the endpoint path |
| `live_ws29.py` | tenancy | **Two tenants, real routes — proves isolation and 404-never-403** |
| `live_ws29e.py` | admin tenancy | Two orgs, two admins — roster, invite, roles, groups, overrides |
| `prove_bootstrap.sh` | WS-25 D1 | `git reset --hard` renames, so a self-rewriting script runs stale steps and **exits 0** |

## Why they are worth keeping

A hermetic fake is a mirror, and a mirror can only agree with itself. It has no type system, so
`AmbiguousParameterError` is invisible to it. It has no planner, so an ambiguous `ORDER BY` is
invisible. It has no constraints, so a `CHECK` that never fires looks like a `CHECK` that works.
It has no `lower()`, so a byte-exact `UNIQUE` index that should have been case-folded agrees
with the code that assumed otherwise.

Every one of those was a real defect on this branch, and every one of them was caught here.

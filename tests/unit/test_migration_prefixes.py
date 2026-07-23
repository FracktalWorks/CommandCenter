"""Guard against duplicate migration numbers (audit BO-6 partial).

apply_migrations.sh applies infra/postgres/NN_*.sql in NUMERIC (`sort -V`) order,
so two files sharing a numeric prefix have a filename-lexical (fragile) relative
order and any tooling assuming unique prefixes is ambiguous. This test fails CI
if a collision is (re)introduced — the #50 duplicate (fixed in F5) is how it
happened the first time.

Prefixes are 2-OR-MORE digits: the 2-digit space filled up at 99, so migrations
continue at 100+. Numbers are compared as integers, so a zero-padded ``097`` and
a bare ``97`` are correctly flagged as the SAME migration number.
"""
from __future__ import annotations

import re
from collections import defaultdict
from pathlib import Path

_MIGRATIONS = Path(__file__).resolve().parents[2] / "infra" / "postgres"
_NN = re.compile(r"^(\d+)_.*\.sql$")


def test_migration_numeric_prefixes_are_unique():
    by_num: dict[int, list[str]] = defaultdict(list)
    for f in _MIGRATIONS.glob("[0-9][0-9]*_*.sql"):
        m = _NN.match(f.name)
        if m:
            by_num[int(m.group(1))].append(f.name)
    dupes = {n: names for n, names in by_num.items() if len(names) > 1}
    assert not dupes, f"duplicate migration number(s): {dupes}"

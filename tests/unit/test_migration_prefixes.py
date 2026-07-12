"""Guard against duplicate migration numbers (audit BO-6 partial).

apply_migrations.sh applies infra/postgres/NN_*.sql in `ls | sort` order, so two
files sharing a numeric prefix have a filename-lexical (fragile) relative order
and any tooling assuming unique prefixes is ambiguous. This test fails CI if a
collision is (re)introduced — the #50 duplicate (fixed in F5) is how it happened
the first time.
"""
from __future__ import annotations

import re
from collections import defaultdict
from pathlib import Path

_MIGRATIONS = Path(__file__).resolve().parents[2] / "infra" / "postgres"
_NN = re.compile(r"^(\d{2})_.*\.sql$")


def test_migration_numeric_prefixes_are_unique():
    by_num: dict[str, list[str]] = defaultdict(list)
    for f in _MIGRATIONS.glob("[0-9][0-9]_*.sql"):
        m = _NN.match(f.name)
        if m:
            by_num[m.group(1)].append(f.name)
    dupes = {n: names for n, names in by_num.items() if len(names) > 1}
    assert not dupes, f"duplicate migration number(s): {dupes}"

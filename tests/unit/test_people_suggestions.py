"""WS-28j3 — the rebalancing suggestions.

Spec: `project-docs/specs/people_center_app.md` §5.7.4 · **D-PC-13, D-PC-14**.

Three claims:

* **One ranker.** The skill half of every rank is §5.5's `score_skills`,
  asserted by identity — a second ranker would be a second answer to "who is
  good at this".
* **Every factor travels on the row** — skill points, matched skills, spare
  hours, away — and the rank is their product, recomputable by the reader.
* **Nothing writes** (D-PC-13): the module carries no INSERT/UPDATE/DELETE,
  and every suggestion ends in ids the CLIENT hands to the ordinary assignees
  PUT, where a human confirms.
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any

from gateway.routes.people import search as people_search
from gateway.routes.people import suggestions as sug

REPO = Path(__file__).resolve().parents[2]
SOURCE = (REPO / "apps/services/gateway/gateway/routes/people/suggestions.py"
          ).read_text(encoding="utf-8")

YEAR = 2026


def helper(**over: Any) -> dict[str, Any]:
    base = {
        "person_id": "p1", "name": "Priya", "email": "priya@x.in",
        "skill_rows": [{"skill": "firmware", "level": None,
                        "last_used_year": None}],
        "spare_hours": 10.0, "away": None,
    }
    base.update(over)
    return base


def test_the_rank_is_the_product_of_the_three_shown_factors() -> None:
    [c] = sug.rank_candidates("extruder firmware rework", [helper()],
                              this_year=YEAR)
    assert c.skill_points == 1.0
    assert c.spare_hours == 10.0
    assert c.rank == 10.0                      # 1.0 x 10 x 1.0
    assert c.matched_skills == ["firmware"]


def test_the_skill_half_is_the_5_5_ranker_by_identity() -> None:
    """Not "gives the same numbers" — IS the same function. The fence §5.7.4
    asks for, asserted on the object rather than on behaviour that could
    coincide."""
    assert sug.score_skills is people_search.score_skills


def test_an_expert_with_spare_time_outranks_a_novice_with_more() -> None:
    rows = sug.rank_candidates("extruder firmware rework", [
        helper(name="Expert", email="e@x.in",
               skill_rows=[{"skill": "firmware", "level": "expert",
                            "last_used_year": None}], spare_hours=8.0),
        helper(name="Novice", email="n@x.in",
               skill_rows=[{"skill": "firmware", "level": "learning",
                            "last_used_year": None}], spare_hours=12.0),
    ], this_year=YEAR)
    # 2.0 x 8 = 16 beats 0.5 x 12 = 6.
    assert [c.name for c in rows] == ["Expert", "Novice"]
    assert rows[0].rank == 16.0 and rows[1].rank == 6.0


def test_no_skill_overlap_is_dropped_not_ranked_last() -> None:
    """Offering a random free colleague is how suggestions teach people to
    ignore them."""
    rows = sug.rank_candidates("write the sales deck", [helper()],
                               this_year=YEAR)
    assert rows == []


def test_no_spare_hours_is_dropped_help_that_does_not_exist() -> None:
    rows = sug.rank_candidates("extruder firmware", [helper(spare_hours=0.0)],
                               this_year=YEAR)
    assert rows == []


def test_away_discounts_but_does_not_erase() -> None:
    """They are back within days and the away warning sits beside the number —
    zero would silently delete a strong match the reader might still choose."""
    [c] = sug.rank_candidates(
        "extruder firmware",
        [helper(away={"kind": "holiday", "until": "2026-08-20"})],
        this_year=YEAR)
    assert c.rank == 2.5                        # 1.0 x 10 x 0.25
    assert c.away is not None                   # …and the reason is visible


def test_the_holder_is_never_their_own_helper() -> None:
    rows = sug.rank_candidates("extruder firmware", [helper()],
                               this_year=YEAR, exclude_email="priya@x.in")
    assert rows == []


def test_candidates_are_capped_and_ordered() -> None:
    helpers = [helper(name=f"H{i}", email=f"h{i}@x.in",
                      spare_hours=float(i + 1))
               for i in range(6)]
    rows = sug.rank_candidates("extruder firmware", helpers, this_year=YEAR)
    assert len(rows) == sug.MAX_CANDIDATES_PER_TASK
    assert [c.rank for c in rows] == sorted((c.rank for c in rows),
                                            reverse=True)


# ── The fences ─────────────────────────────────────────────────────────────

def test_the_suggester_never_writes() -> None:
    """D-PC-13 structurally, prose stripped — the reused D-PC-14 lesson."""
    from tests.unit.test_people_dashboard import _strip_prose

    code = _strip_prose(SOURCE)
    for verb in ("INSERT", "UPDATE", "DELETE"):
        assert not re.search(rf"\b{verb}\b", code), verb


def test_no_cross_task_score_of_people_exists() -> None:
    """D-PC-14: candidates are ranked FOR ONE TASK by fit-for-that-task. A
    person-level aggregate score is the leaderboard shape, refused."""
    from tests.unit.test_people_dashboard import _PERFORMANCE, _strip_prose

    assert not _PERFORMANCE.findall(_strip_prose(SOURCE))


def test_the_caps_are_reported_not_silent() -> None:
    """"No silent caps": a bounded list must say it was bounded, or it reads
    as "covered everything" when it did not."""
    assert "truncated" in SOURCE
    assert "MAX_AT_RISK_TASKS" in SOURCE and "MAX_UNASSIGNED_TASKS" in SOURCE

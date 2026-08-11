"""WS-26h — the requirable-field allowlist has ONE definition, in two languages.

Spec: ``project-docs/specs/crm_app.md`` §9 WS-26h.

``core.STAGE_REQUIREABLE_FIELDS`` is the boundary: it decides what a settings
grid may store in ``crm_deal_statuses.required_fields`` and therefore what a
blocked move can ever name. ``board.ts::REQUIREABLE_FIELDS`` is what the grid
RENDERS as checkboxes and what the move modal knows how to collect. Two
hand-kept lists is not a vocabulary — the failure mode is silent in both
directions:

* a field in Python and not in TypeScript is one no grid can ever tick and no
  modal can collect, so a stage requiring it can only be un-blocked by curl;
* a field in TypeScript and not in Python is a checkbox that answers 422 the
  moment somebody uses it.

So the TypeScript is READ here rather than mirrored — the same mechanism
``test_projects_migration.py`` uses to hold ``CATEGORY_HUES`` and the seeded
status colours together, and for the same reason: a mirror goes stale and then
lies. R7: this file is the fence both constants name.
"""

from __future__ import annotations

import re
from pathlib import Path

BOARD_TS = (
    Path(__file__).resolve().parents[2]
    / "workbench" / "control_plane" / "src" / "app" / "crm" / "lib" / "board.ts"
)

#: ``export const REQUIREABLE_FIELDS = [ "amount", … ] as const;``
_ARRAY_RE = re.compile(
    r"export\s+const\s+REQUIREABLE_FIELDS\s*=\s*\[(?P<body>.*?)\]\s*as\s+const",
    re.S,
)
#: ``amount: "Amount",`` — one entry of the label table.
_LABELS_RE = re.compile(
    r"export\s+const\s+REQUIREABLE_FIELD_LABELS[^=]*=\s*\{(?P<body>.*?)\n\}",
    re.S,
)


def _typescript_fields() -> list[str]:
    source = BOARD_TS.read_text(encoding="utf-8")
    found = _ARRAY_RE.search(source)
    assert found is not None, (
        f"{BOARD_TS.name} no longer exports a REQUIREABLE_FIELDS array literal "
        "this fence can read — if it moved, move the fence with it rather than "
        "deleting the parity check"
    )
    return re.findall(r'"([^"]+)"', found.group("body"))


def test_the_allowlist_is_the_same_list_on_both_sides() -> None:
    from gateway.routes.crm.core import STAGE_REQUIREABLE_FIELDS

    assert _typescript_fields() == list(STAGE_REQUIREABLE_FIELDS), (
        "board.ts::REQUIREABLE_FIELDS and core.STAGE_REQUIREABLE_FIELDS have "
        "drifted. Order counts as well as membership: it is the order the grid "
        "stores and the order a blocked move's 422 names."
    )


def test_every_allowlisted_field_has_a_label_to_render() -> None:
    """A field with no label renders as ``undefined`` in the move modal's own
    heading — the ask that is meant to explain the refusal."""
    source = BOARD_TS.read_text(encoding="utf-8")
    labels = _LABELS_RE.search(source)
    assert labels is not None, "board.ts no longer exports REQUIREABLE_FIELD_LABELS"
    labelled = set(re.findall(r"(\w+):\s*\"", labels.group("body")))

    assert labelled == set(_typescript_fields()), (
        f"REQUIREABLE_FIELD_LABELS covers {sorted(labelled)} but the allowlist "
        f"is {sorted(_typescript_fields())}"
    )


def test_every_requirable_field_is_a_real_deal_column() -> None:
    """The allowlist names columns, and the gate reads them off the row with
    ``getattr``. A name that is not a column would read as ``None`` on every
    deal — i.e. a stage nobody can ever enter, which is exactly what the
    allowlist exists to prevent."""
    from gateway.routes.crm.core import DEALS, STAGE_REQUIREABLE_FIELDS

    unknown = [
        field for field in STAGE_REQUIREABLE_FIELDS
        if field not in DEALS.model.model_fields
    ]
    assert not unknown, f"{unknown} are not columns of {DEALS.table}"


def test_the_allowlist_excludes_what_a_requirement_must_never_name() -> None:
    """Four columns that ARE deal fields and still must not be requirable.

    ``status_id`` is what the move itself sets, so requiring it would be a
    stage demanding the transition into it. ``name`` and ``currency`` are NOT
    NULL with the route's own guarantees behind them, so a requirement adds
    nothing and can only mislead. ``probability`` is inherited FROM the stage
    at entry (D-CRM-10), so demanding it would demand a value the platform is
    about to supply.
    """
    from gateway.routes.crm.core import STAGE_REQUIREABLE_FIELDS

    for field in ("status_id", "name", "currency", "probability"):
        assert field not in STAGE_REQUIREABLE_FIELDS, (
            f"'{field}' must not be requirable — see this test's docstring"
        )

"""WS-27l — custom fields.

Spec: `ai-company-brain/specs/project_management_app.md` §11.2 item 4, §11.9.

Definitions are rows; values are JSONB on the task keyed by `field_key`. The
denormalisation is Paca's and is deliberate (migration 155 says why), and it
moves a whole class of guarantee out of the database and into this code — so
these are the claims the database is no longer making on our behalf:

* **an unknown key is refused, not dropped.** A typo that silently no-ops looks
  exactly like a save, and the sender finds out weeks later.
* **a patch MERGES.** A client that knows about three of five fields must not
  wipe the other two by sending what it knows — and an older client, or an
  automation written before a field existed, is precisely that client.
* **`true` is not the number 1.** `isinstance(True, int)` is True in Python, so
  a number check placed above the boolean one accepts both, in both directions.
* **deleting a definition strips its values.** Paca leaves them; a key with no
  definition is invisible until somebody recreates the name, and then every old
  value resurfaces carrying the new meaning.

Pure functions, tested directly. No Postgres, no fake.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest
from fastapi import HTTPException
from gateway.routes.projects.activities import _restore_custom
from gateway.routes.projects.custom_fields import (
    _COERCERS,
    CHOICE_TYPES,
    FIELD_TYPES,
    MAX_OPTIONS,
    MAX_SELECTED,
    MAX_TEXT,
    apply_values,
    clean_options,
    coerce_value,
    slugify_key,
    strip_key,
    validate_key,
)

REPO = Path(__file__).resolve().parents[2]
MIGRATION = REPO / "infra/postgres/155_projects_custom_fields.sql"


def field(field_type: str, key: str = "customer", **over) -> dict:
    return {"field_key": key, "field_type": field_type, "options": [], **over}


def value(field_type: str, raw, **over):
    return coerce_value(field(field_type, **over), raw)


def refused(field_type: str, raw, **over) -> str:
    with pytest.raises(HTTPException) as exc:
        value(field_type, raw, **over)
    assert exc.value.status_code == 422
    return str(exc.value.detail)


# ── The vocabulary matches the schema ───────────────────────────────────────

def sql_without_comments() -> str:
    text = MIGRATION.read_text(encoding="utf-8")
    return "\n".join(re.sub(r"--.*$", "", line) for line in text.splitlines())


def test_the_field_types_are_the_ones_the_database_allows():
    """Read from the migration, not restated. A type this module accepts and the
    CHECK refuses is a 500 at the INSERT; one the CHECK allows and this module
    does not is a field nobody can create."""
    match = re.search(
        r"field_type\s+TEXT\s+NOT\s+NULL\s*CHECK\s*\(\s*field_type\s+IN\s*\((.*?)\)\)",
        sql_without_comments(), re.S | re.I,
    )
    assert match, "155 no longer constrains pm_custom_fields.field_type"
    assert set(re.findall(r"'(\w+)'", match.group(1))) == set(FIELD_TYPES)


def test_the_key_pattern_is_the_one_the_database_enforces():
    """Both sides must agree, or a key this module accepts becomes an opaque
    IntegrityError 500 instead of the 422 it writes."""
    match = re.search(r"field_key\s*~\s*'(\^[^']+\$)'", sql_without_comments())
    assert match, "155 no longer constrains the shape of field_key"
    pattern = re.compile(match.group(1))
    for good in ("customer", "po_number", "a", "x1_2"):
        assert pattern.match(good) and validate_key(good) == good
    for bad in ("Customer", "1st", "with space", "trailing-dash", ""):
        assert not pattern.match(bad)
        with pytest.raises(HTTPException):
            validate_key(bad)


def test_the_values_column_is_never_null():
    """"No custom values" and "they have not loaded" must not be the same thing
    to a client — every reader would need the same defensive coalesce."""
    sql = sql_without_comments()
    assert re.search(
        r"ADD COLUMN IF NOT EXISTS custom_fields\s+JSONB\s+NOT NULL\s+DEFAULT",
        sql, re.I,
    )


def test_the_check_on_the_values_column_is_added_NOT_VALID():
    """Migration 148's lesson, after main was bitten twice: a constraint added
    in one step can stop a deploy on a row nobody anticipated."""
    sql = sql_without_comments()
    assert re.search(r"CHECK \(jsonb_typeof\(custom_fields\) = 'object'\)\s*NOT VALID",
                     sql, re.I)
    assert "VALIDATE CONSTRAINT pm_tasks_custom_fields_is_object" in sql
    assert "RAISE NOTICE" in sql


def test_definitions_are_unique_per_project_and_key():
    """What makes `field_key` an identity rather than a label — and what lets a
    stored value be resolved back to its definition with no key of its own."""
    assert re.search(r"UNIQUE \(project_id, field_key\)", sql_without_comments())


# ── Keys ───────────────────────────────────────────────────────────────────

def test_a_key_is_derived_from_the_name_so_the_common_case_is_typing_a_label():
    assert slugify_key("Customer PO #") == "customer_po"
    assert slugify_key("  Due   Date  ") == "due_date"


def test_a_derived_key_always_starts_with_a_letter():
    """The CHECK requires it, so a name that begins with a digit or a symbol
    must not produce a key the INSERT then rejects."""
    for name in ("2026 target", "#1 priority", "!!!", "___"):
        assert re.match(r"^[a-z][a-z0-9_]{0,62}$", slugify_key(name)), name


def test_a_derived_key_fits_the_column():
    assert len(slugify_key("x" * 200)) <= 63


# ── Options ────────────────────────────────────────────────────────────────

def test_options_are_kept_only_for_the_types_that_choose_from_them():
    assert clean_options("select", ["a", "b"]) == ["a", "b"]
    assert set(CHOICE_TYPES) == {"select", "multi_select"}


def test_options_on_a_non_choice_field_are_dropped_rather_than_refused():
    """They change nothing about what the field accepts. Rejecting a harmless
    extra key makes a client's payload a guessing game."""
    assert clean_options("text", ["a"]) == []


def test_duplicate_options_are_collapsed_and_order_is_kept():
    """Two identical entries are indistinguishable in a dropdown, which makes
    "which one did they pick" unanswerable. Order survives because a dropdown
    somebody arranged deliberately must not come back alphabetised."""
    assert clean_options("select", ["Ops", " Ops ", "Sales"]) == ["Ops", "Sales"]
    assert clean_options("select", ["Zulu", "Alpha", "Zulu"]) == ["Zulu", "Alpha"]


def test_an_empty_option_is_refused():
    with pytest.raises(HTTPException) as exc:
        clean_options("select", ["ok", "   "])
    assert exc.value.status_code == 422


def test_options_cannot_be_unbounded():
    with pytest.raises(HTTPException):
        clean_options("select", [f"o{i}" for i in range(MAX_OPTIONS + 1)])


# ── Coercion, per type ─────────────────────────────────────────────────────

def test_a_boolean_field_refuses_the_number_one():
    """`isinstance(True, int)` is True in Python. A number branch above the
    boolean one would accept `1` here and `True` as a number below."""
    assert value("boolean", True) is True
    assert value("boolean", False) is False
    assert "true or false" in refused("boolean", 1)


def test_a_number_field_refuses_a_boolean():
    """The same trap, in the other direction — and the direction that silently
    stores `True` where a quantity belongs."""
    assert value("number", 3) == 3
    assert value("number", 2.5) == 2.5
    assert "expected a number" in refused("number", True)
    assert "expected a number" in refused("number", "3")


def test_text_is_trimmed_and_capped():
    assert value("text", "  hello  ") == "hello"
    assert str(MAX_TEXT) in refused("text", "x" * (MAX_TEXT + 1))


def test_a_url_field_refuses_something_that_is_not_a_url():
    """A field typed `url` that holds "ask Priya" is a link the UI renders as a
    dead anchor."""
    assert value("url", "https://x.co/a") == "https://x.co/a"
    assert "http(s) URL" in refused("url", "ask Priya")


def test_an_empty_url_is_allowed_because_clearing_is_not_an_error():
    assert value("url", "") == ""


def test_a_date_is_normalised_so_two_spellings_of_one_day_are_one_value():
    """Stored as text in a JSONB blob: "2026-8-1" and "2026-08-01" would
    otherwise be different strings for the same day, and neither sorting nor
    equality filtering would work."""
    assert value("date", "2026-08-31") == value("date", "2026-08-31T00:00:00Z")


def test_a_date_that_is_not_a_date_is_refused_with_an_example():
    assert "2026-08-31" in refused("date", "next tuesday")


def test_a_select_must_come_from_its_own_options():
    definition = field("select", options=["Ops", "Sales"])
    assert coerce_value(definition, "Ops") == "Ops"
    with pytest.raises(HTTPException) as exc:
        coerce_value(definition, "Marketing")
    assert "Ops" in str(exc.value.detail), "the error should list the real choices"


def test_a_multi_select_dedupes_and_is_bounded():
    definition = field("multi_select", options=["a", "b"])
    assert coerce_value(definition, ["a", "b", "a"]) == ["a", "b"]
    with pytest.raises(HTTPException):
        coerce_value(definition, ["a"] * (MAX_SELECTED + 1))


def test_a_multi_select_refuses_a_bare_string():
    """`"a"` and `["a"]` must not both work — one of them would store a string
    where every reader expects a list."""
    with pytest.raises(HTTPException):
        coerce_value(field("multi_select", options=["a"]), "a")


def test_every_refusal_names_the_field():
    """A form with eight fields makes "invalid value" a guess with eight
    answers."""
    for field_type, bad in (
        ("number", "x"), ("boolean", 1), ("text", 5), ("date", "soon"),
        ("url", "nope"), ("select", "no"), ("multi_select", "no"),
    ):
        assert "customer" in refused(field_type, bad, key="customer"), field_type


# ── Merging a patch ────────────────────────────────────────────────────────

DEFS = [
    field("text", "customer"),
    field("number", "budget"),
    field("select", "region", options=["EU", "IN"]),
]


def test_a_patch_merges_and_leaves_untouched_keys_alone():
    """The claim that protects an older client, and an automation written
    before a field existed."""
    merged, _ = apply_values({"customer": "Acme", "budget": 10}, {"budget": 20}, DEFS)
    assert merged == {"customer": "Acme", "budget": 20}


def test_an_explicit_null_clears_the_key_rather_than_storing_a_null():
    """The only way to express "unset this". A stored null would make "never
    filled in" and "deliberately emptied" the same value in every filter."""
    merged, changes = apply_values({"customer": "Acme"}, {"customer": None}, DEFS)
    assert merged == {}
    assert changes == {"customer": {"from": "Acme", "to": None}}


def test_an_unknown_key_is_refused_and_lists_the_real_ones():
    """Dropping it silently is worse than refusing: the caller sees a 200 and
    believes the value saved."""
    with pytest.raises(HTTPException) as exc:
        apply_values({}, {"custmer": "Acme"}, DEFS)
    assert exc.value.status_code == 422
    assert "custmer" in str(exc.value.detail)
    assert "budget" in str(exc.value.detail)


def test_a_patch_that_is_not_an_object_is_refused():
    with pytest.raises(HTTPException):
        apply_values({}, ["customer"], DEFS)


def test_an_empty_patch_changes_nothing_and_reports_nothing():
    merged, changes = apply_values({"customer": "Acme"}, {}, DEFS)
    assert merged == {"customer": "Acme"}
    assert changes == {}


def test_writing_the_value_a_task_already_has_earns_no_timeline_entry():
    """A redundant entry makes a task look freshly touched — the same objection
    `automation.py` records about a redundant UPDATE."""
    _, changes = apply_values({"customer": "Acme"}, {"customer": "Acme"}, DEFS)
    assert changes == {}


def test_a_change_records_both_sides_so_the_timeline_can_be_read_back():
    _, changes = apply_values({"budget": 10}, {"budget": 20}, DEFS)
    assert changes == {"budget": {"from": 10, "to": 20}}


def test_the_merge_does_not_mutate_what_it_was_given():
    """The stored dict is read from the row before the write; mutating it would
    make the "from" side of every change equal to the "to" side."""
    stored = {"customer": "Acme"}
    apply_values(stored, {"customer": "Other"}, DEFS)
    assert stored == {"customer": "Acme"}


def test_a_value_is_still_validated_when_it_arrives_through_a_patch():
    """The merge is not a bypass around `coerce_value`."""
    with pytest.raises(HTTPException):
        apply_values({}, {"region": "US"}, DEFS)


def test_a_task_with_no_values_yet_starts_from_empty_not_from_none():
    merged, _ = apply_values(None, {"customer": "Acme"}, DEFS)
    assert merged == {"customer": "Acme"}


# ── Delete ─────────────────────────────────────────────────────────────────

def test_stripping_a_key_leaves_the_others():
    assert strip_key({"a": 1, "b": 2}, "a") == {"b": 2}


def test_stripping_a_key_a_task_never_held_is_not_an_error():
    """The delete sweeps every task in the tree; most of them will not have it."""
    assert strip_key({"b": 2}, "a") == {"b": 2}
    assert strip_key(None, "a") == {}


def test_stripping_does_not_mutate_the_row_it_was_given():
    """The delete path reads a row, strips, and writes the result. Mutating in
    place makes the before-and-after comparison that decides whether to write
    always say "no change"."""
    stored = {"a": 1, "b": 2}
    strip_key(stored, "a")
    assert stored == {"a": 1, "b": 2}


# ── Revert (WS-27l makes a custom field a first-class field) ────────────────

class _Task:
    """Just enough of a row for `_restore_custom`, which reads one attribute."""

    def __init__(self, custom_fields):
        self.custom_fields = custom_fields


def change(key, old, new) -> dict:
    return {"field": f"custom.{key}", "old": old, "new": new}


def test_a_change_that_touched_no_custom_field_asks_for_no_custom_write():
    """`None` and `{}` are different answers, and conflating them would make
    every ordinary title edit also blank the task's custom values."""
    assert _restore_custom(_Task({"a": 1}), [{"field": "title", "old": "x"}]) is None


def test_a_revert_merges_onto_what_the_task_HOLDS_NOW():
    """Not onto what it held when the change was made. Another field may have
    been edited since, and writing back the whole object would silently undo
    that too — a revert that reverts more than it names."""
    task = _Task({"customer": "Acme", "budget": 99})
    assert _restore_custom(task, [change("customer", "Old", "Acme")]) == {
        "customer": "Old", "budget": 99,
    }


def test_reverting_the_creation_of_a_value_REMOVES_the_key():
    """`old: None` means the key did not exist before. Storing a null instead
    would leave "never set" and "set to nothing" as one value."""
    task = _Task({"customer": "Acme"})
    assert _restore_custom(task, [change("customer", None, "Acme")]) == {}


def test_reverting_a_clear_puts_the_value_back():
    task = _Task({})
    assert _restore_custom(task, [change("customer", "Acme", None)]) == {
        "customer": "Acme",
    }


def test_one_revert_restores_every_custom_key_the_change_carried():
    task = _Task({"a": "new", "b": "new"})
    assert _restore_custom(
        task, [change("a", "old-a", "new"), change("b", "old-b", "new")],
    ) == {"a": "old-a", "b": "old-b"}


def test_a_revert_ignores_the_column_changes_beside_it():
    """A single `field_change` can carry both — `patch_task` folds custom keys
    into the same entry — and each half is restored by its own mechanism."""
    task = _Task({"customer": "Acme"})
    mixed = [{"field": "title", "old": "Was", "new": "Is"},
             change("customer", "Old", "Acme")]
    assert _restore_custom(task, mixed) == {"customer": "Old"}


def test_a_revert_does_not_mutate_the_row_it_read():
    task = _Task({"customer": "Acme"})
    _restore_custom(task, [change("customer", "Old", "Acme")])
    assert task.custom_fields == {"customer": "Acme"}


def test_a_task_whose_values_are_absent_still_reverts():
    """The column is NOT NULL now, but a row read through a path that did not
    select it hands back `None`."""
    assert _restore_custom(_Task(None), [change("customer", "Old", None)]) == {
        "customer": "Old",
    }


def test_a_type_no_coercer_knows_is_refused_rather_than_falling_through():
    """Unreachable through the API — `create_field` validates the type and the
    CHECK backs it — but a definition read back from a future migration must not
    be validated by whichever branch happens to catch it. Silently coercing an
    unknown type is how a value gets stored in a shape nothing else expects."""
    with pytest.raises(HTTPException) as exc:
        coerce_value(field("rating", "stars"), 5)
    assert exc.value.status_code == 422
    assert "stars" in str(exc.value.detail)


def test_every_advertised_type_has_a_coercer():
    """The other half: a type in `FIELD_TYPES` with no coercer would 422 every
    value for a field the UI happily offers to create."""
    for field_type in FIELD_TYPES:
        assert field_type in _COERCERS, f"{field_type} has no coercer"
    assert set(_COERCERS) == set(FIELD_TYPES)

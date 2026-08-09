"""Projects · custom fields — definitions, and the values they police (WS-27l).

Spec: ``project-docs/specs/project_management_app.md`` §11.2 item 4, §11.9.

    GET    /projects/nodes/{project_id}/fields
    POST   /projects/nodes/{project_id}/fields
    PATCH  /projects/fields/{field_id}
    DELETE /projects/fields/{field_id}      → strips its values, reports how many

Definitions are rows; values are JSONB on the task, keyed by ``field_key``.
Migration 155 explains why that denormalisation is worth its cost.

**The validation is the feature.** A JSONB column with no gate is a garbage bag:
one client writes ``"3"``, another writes ``3``, a third writes ``"three"``, and
six months later the field cannot be summed, sorted or filtered by anybody. So a
value is coerced to its definition's type or refused — and an unknown key is
refused too, because a typo that silently no-ops looks exactly like a save.

Everything that decides *what a value is allowed to be* is a pure function over
plain data, tested without a database.
"""

from __future__ import annotations

import re
from datetime import UTC, datetime
from typing import Any

from acb_auth import UserContext, get_current_user
from fastapi import Depends, HTTPException
from gateway.routes.projects.core import (
    _get_db,
    actor,
    clean_payload,
    load_visible_project,
    require_row,
    resolve_visibility,
    root_project_id,
    router,
    row_to_dict,
    update_row,
)
from pydantic import BaseModel
from sqlalchemy import text

#: Mirrored from migration 155's CHECK and pinned by a test that reads it.
FIELD_TYPES: tuple[str, ...] = (
    "text", "number", "date", "select", "multi_select", "boolean", "url",
)

#: The types whose values must come from ``options``.
CHOICE_TYPES: tuple[str, ...] = ("select", "multi_select")

#: How many definitions one project may carry. A board that renders forty custom
#: columns is not a board; the cap is the difference between a feature and a way
#: to make every task row unreadable.
MAX_FIELDS = 40

#: Longest text/url value. Long-form belongs in the description, which has no
#: cap — a custom field is something you filter and group by.
MAX_TEXT = 2000

#: Most options one choice field may offer, and most values one multi-select may
#: hold. Both bound what a single request can push into a JSONB blob.
MAX_OPTIONS = 100
MAX_SELECTED = 50

_KEY = re.compile(r"^[a-z][a-z0-9_]{0,62}$")


def slugify_key(raw: str) -> str:
    """``"Customer PO #"`` → ``"customer_po"``.

    A key is derived from the name when the caller does not supply one, so the
    common case is typing a label and nothing else. It is never *re*-derived on
    rename: the key is the identity every stored value is filed under, and
    recomputing it when somebody fixes a typo in the label would orphan the lot.
    """
    lowered = re.sub(r"[^a-z0-9]+", "_", raw.strip().lower()).strip("_")
    if not lowered or not lowered[0].isalpha():
        lowered = f"f_{lowered}" if lowered else "field"
    return lowered[:63]


def validate_key(key: str) -> str:
    """Refuse a key the database's CHECK would refuse, with a reason.

    Reaching Postgres would work — the CHECK is there — but an IntegrityError
    surfaces as a 500 with no hint about which character was the problem.
    """
    if not _KEY.match(key):
        raise HTTPException(
            status_code=422,
            detail=f"'{key}' is not a usable field key. Use lowercase letters, "
                   f"digits and underscores, starting with a letter — the key "
                   f"ends up in query strings and automation graphs, so it "
                   f"cannot depend on spacing or capitals.",
        )
    return key


def clean_options(field_type: str, raw: Any) -> list[str]:
    """The choices for a ``select``/``multi_select``, or ``[]`` for everything else.

    Options on a non-choice field are dropped rather than refused: they change
    nothing about what the field accepts, and rejecting a harmless extra key is
    the kind of strictness that makes a client's payload a guessing game.
    """
    if field_type not in CHOICE_TYPES:
        return []
    if raw is None:
        return []
    if not isinstance(raw, list):
        raise HTTPException(
            status_code=422,
            detail=f"A {field_type} field's options must be a list of strings.",
        )
    seen: list[str] = []
    for entry in raw:
        if not isinstance(entry, str) or not entry.strip():
            raise HTTPException(
                status_code=422,
                detail="Every option must be a non-empty string.",
            )
        option = entry.strip()
        # Deduplicated, because two identical options are indistinguishable in a
        # dropdown and make "which one did they pick" unanswerable.
        if option not in seen:
            seen.append(option)
    if len(seen) > MAX_OPTIONS:
        raise HTTPException(
            status_code=422,
            detail=f"At most {MAX_OPTIONS} options per field; got {len(seen)}.",
        )
    return seen


def _refuse(key: str, why: str) -> HTTPException:
    return HTTPException(status_code=422, detail=f"Custom field '{key}': {why}")


def _coerce_boolean(key: str, raw: Any, _: list[str]) -> Any:
    # Strict, and dispatched BEFORE any number handling. In Python
    # `isinstance(True, int)` is True, so a number branch reached first would
    # silently accept `True` as the quantity 1 — and `1` as the boolean it
    # never was. Keeping them in separate functions makes that ordering
    # impossible to undo by accident.
    if not isinstance(raw, bool):
        raise _refuse(key, f"expected true or false, got {type(raw).__name__}.")
    return raw


def _coerce_number(key: str, raw: Any, _: list[str]) -> Any:
    if isinstance(raw, bool) or not isinstance(raw, int | float):
        raise _refuse(key, f"expected a number, got {raw!r}.")
    return raw


def _coerce_text(key: str, raw: Any, _: list[str]) -> Any:
    if not isinstance(raw, str):
        raise _refuse(key, f"expected text, got {type(raw).__name__}.")
    value = raw.strip()
    if len(value) > MAX_TEXT:
        raise _refuse(key, f"is longer than {MAX_TEXT} characters.")
    return value


def _coerce_url(key: str, raw: Any, options: list[str]) -> Any:
    value = _coerce_text(key, raw, options)
    # An empty value is allowed: clearing a field is not an error, and the only
    # other way to express it would be a null, which `apply_values` reserves for
    # removing the key entirely.
    if value and not re.match(r"^https?://\S+$", value):
        raise _refuse(key, f"expected a http(s) URL, got '{value}'.")
    return value


def _coerce_date(key: str, raw: Any, _: list[str]) -> Any:
    if not isinstance(raw, str):
        raise _refuse(key, f"expected an ISO date, got {type(raw).__name__}.")
    try:
        parsed = datetime.fromisoformat(raw.strip())
    except ValueError:
        raise _refuse(key, f"'{raw}' is not an ISO 8601 date, e.g. 2026-08-31.") from None
    # Normalised, because it is stored as TEXT inside a JSONB blob: "2026-8-1"
    # and "2026-08-01" would otherwise be two different strings for one day, and
    # neither sorting nor equality filtering would work.
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=UTC)
    return parsed.isoformat()


def _coerce_select(key: str, raw: Any, options: list[str]) -> Any:
    if not isinstance(raw, str):
        raise _refuse(key, f"expected one of {options}, got {type(raw).__name__}.")
    if raw not in options:
        raise _refuse(key, f"'{raw}' is not one of {options}.")
    return raw


def _coerce_multi_select(key: str, raw: Any, options: list[str]) -> Any:
    if not isinstance(raw, list):
        raise _refuse(key, f"expected a list of choices, got {type(raw).__name__}.")
    if len(raw) > MAX_SELECTED:
        raise _refuse(key, f"at most {MAX_SELECTED} choices; got {len(raw)}.")
    chosen: list[str] = []
    for entry in raw:
        if entry not in options:
            raise _refuse(key, f"'{entry}' is not one of {options}.")
        if entry not in chosen:
            chosen.append(entry)
    return chosen


#: One coercer per type. A dict rather than a chain of `if`s so that adding a
#: type is adding a row here and a word to `FIELD_TYPES` — and so the boolean
#: check can never drift below the number one.
_COERCERS = {
    "boolean": _coerce_boolean,
    "number": _coerce_number,
    "text": _coerce_text,
    "url": _coerce_url,
    "date": _coerce_date,
    "select": _coerce_select,
    "multi_select": _coerce_multi_select,
}


def coerce_value(definition: dict[str, Any], raw: Any) -> Any:
    """One incoming value, checked and normalised against its definition.

    Returns the value to store. Raises 422 with the field NAMED — a validation
    message that does not say *which* field is a message the sender has to guess
    at, and a form with eight fields makes that guess eight ways.
    """
    key = str(definition["field_key"])
    field_type = str(definition["field_type"])
    coercer = _COERCERS.get(field_type)
    if coercer is None:
        # Unreachable through the API — `create_field` validates the type and the
        # CHECK backs it — but a definition read from a future migration would
        # otherwise be coerced by whichever branch happened to fall through.
        raise _refuse(key, f"has unknown type '{field_type}'.")
    return coercer(key, raw, list(definition.get("options") or []))


def apply_values(
    existing: Any, patch: Any, definitions: list[dict[str, Any]],
) -> tuple[dict[str, Any], dict[str, Any]]:
    """Merge a ``custom_fields`` patch onto a task's stored values.

    Returns ``(merged, changes)``, where ``changes`` is ``{key: {"from", "to"}}``
    for the timeline.

    **A patch MERGES, it does not replace.** A client that knows about three of
    five fields must not wipe the other two by sending what it knows — and an
    older client, or an automation written before a field existed, is exactly
    that client.

    **An explicit ``null`` CLEARS the key**, removing it rather than storing a
    null. That is the only way to express "unset this", and a stored null would
    make "never filled in" and "deliberately emptied" the same value in every
    filter that follows.

    **An unknown key is a 422.** Dropping it silently is worse than refusing:
    the caller sees a 200, believes the value saved, and finds out weeks later.
    """
    if not isinstance(patch, dict):
        raise HTTPException(
            status_code=422,
            detail="custom_fields must be an object keyed by field key.",
        )
    by_key = {str(d["field_key"]): d for d in definitions}
    merged = dict(existing or {})
    changes: dict[str, Any] = {}

    for key, raw in patch.items():
        definition = by_key.get(key)
        if definition is None:
            raise HTTPException(
                status_code=422,
                detail=f"No custom field '{key}' on this project. "
                       f"Defined: {sorted(by_key)}.",
            )
        before = merged.get(key)
        if raw is None:
            merged.pop(key, None)
            after = None
        else:
            after = coerce_value(definition, raw)
            merged[key] = after
        # "Already this value" writes nothing to the timeline. A redundant entry
        # makes a task look freshly touched, which is the same objection
        # `automation.py` records about a redundant UPDATE.
        if before != after:
            changes[key] = {"from": before, "to": after}

    return merged, changes


def strip_key(values: Any, key: str) -> dict[str, Any]:
    """One task's values with ``key`` removed. Pure, for the delete path."""
    remaining = dict(values or {})
    remaining.pop(key, None)
    return remaining


# ── Definitions CRUD ────────────────────────────────────────────────────────

class FieldIn(BaseModel):
    field_key: str | None = None
    name: str | None = None
    description: str | None = None
    field_type: str | None = None
    options: list[str] | None = None
    position: int | None = None


async def load_definitions(db: Any, root: str) -> list[dict[str, Any]]:
    """Every definition on a root project, ordered as the form renders them."""
    rows = (await db.execute(
        text(
            "SELECT * FROM pm_custom_fields WHERE project_id = CAST(:root AS uuid) "
            "ORDER BY position, name"
        ),
        {"root": root},
    )).fetchall()
    return [
        {
            "id": str(r.id),
            "project_id": str(r.project_id),
            "field_key": r.field_key,
            "name": r.name,
            "description": r.description,
            "field_type": r.field_type,
            "options": list(r.options or []),
            "position": r.position,
            "created_by": r.created_by,
        }
        for r in rows
    ]


async def _root_for(db: Any, vis: Any, project_id: str) -> str:
    await load_visible_project(db, vis, project_id)
    return await root_project_id(db, project_id)


async def _count_with_key(db: Any, root: str, key: str) -> int:
    """How many tasks in this tree hold a value for ``key``.

    Uses the `?` operator (key exists), not `@>`, because the question is
    whether the field is *in use* at all, whatever it was set to.
    """
    return int((await db.execute(
        text(
            "SELECT count(*) FROM pm_tasks "
            "WHERE root_project_id = CAST(:root AS uuid) "
            "  AND custom_fields ? :key"
        ),
        {"root": root, "key": key},
    )).scalar() or 0)


@router.get("/nodes/{project_id}/fields")
async def list_fields(
    project_id: str, user: UserContext = Depends(get_current_user),
) -> dict:
    db = await _get_db()
    try:
        vis = await resolve_visibility(db, user)
        root = await _root_for(db, vis, project_id)
        rows = await load_definitions(db, root)
        return {"rows": rows, "total": len(rows)}
    finally:
        await db.close()


@router.post("/nodes/{project_id}/fields", status_code=201)
async def create_field(
    project_id: str, payload: FieldIn,
    user: UserContext = Depends(get_current_user),
) -> dict:
    values = clean_payload(payload)
    name = str(values.get("name") or "").strip()
    if not name:
        raise HTTPException(status_code=422, detail="A custom field needs a name.")
    field_type = values.get("field_type") or "text"
    if field_type not in FIELD_TYPES:
        raise HTTPException(
            status_code=422,
            detail=f"Unknown field type '{field_type}'. One of: {list(FIELD_TYPES)}.",
        )
    key = validate_key(str(values.get("field_key") or slugify_key(name)))
    options = clean_options(field_type, values.get("options"))

    db = await _get_db()
    try:
        vis = await resolve_visibility(db, user)
        root = await _root_for(db, vis, project_id)
        existing = await load_definitions(db, root)
        if len(existing) >= MAX_FIELDS:
            raise HTTPException(
                status_code=409,
                detail=f"This project already has {MAX_FIELDS} custom fields.",
            )
        if any(d["field_key"] == key for d in existing):
            # 409 rather than letting the UNIQUE fire: the caller needs to know
            # the key is taken, which an IntegrityError does not tell them.
            raise HTTPException(
                status_code=409,
                detail=f"A custom field with key '{key}' already exists here.",
            )
        row = (await db.execute(
            text(
                "INSERT INTO pm_custom_fields "
                "(project_id, field_key, name, description, field_type, "
                " options, position, created_by) "
                "VALUES (CAST(:root AS uuid), :key, :name, :description, :type, "
                "        CAST(:options AS jsonb), :position, :by) RETURNING *"
            ),
            {
                "root": root, "key": key, "name": name,
                "description": values.get("description"),
                "type": field_type,
                "options": _json(options),
                "position": values.get("position") or len(existing),
                "by": actor(user),
            },
        )).fetchone()
        await db.commit()
        return _definition_row(row)
    finally:
        await db.close()


@router.patch("/fields/{field_id}")
async def patch_field(
    field_id: str, payload: FieldIn,
    user: UserContext = Depends(get_current_user),
) -> dict:
    """Rename, re-describe, reorder, or add options.

    Two things are deliberately NOT editable once values exist, and both are for
    the same reason — the stored values would stop meaning what they say:

    * **``field_key`` is never editable.** It is the identity every value is
      filed under; changing it orphans the lot in one statement.
    * **``field_type`` is refused while any task holds a value**, with the count,
      because "Customer" going from text to select cannot re-interpret what is
      already written and would leave every task failing its own validation.
    """
    values = clean_payload(payload)
    if "field_key" in values:
        raise HTTPException(
            status_code=422,
            detail="A field's key is its identity and cannot change — every "
                   "stored value is filed under it. Create a new field and "
                   "retire this one instead.",
        )
    if values.get("field_type") and values["field_type"] not in FIELD_TYPES:
        raise HTTPException(
            status_code=422,
            detail=f"Unknown field type '{values['field_type']}'. "
                   f"One of: {list(FIELD_TYPES)}.",
        )

    db = await _get_db()
    try:
        existing = await require_row(db, "pm_custom_fields", field_id, "Custom field")
        vis = await resolve_visibility(db, user)
        await load_visible_project(db, vis, str(existing.project_id))
        if not values:
            return _definition_row(existing)

        root = str(existing.project_id)
        in_use = await _count_with_key(db, root, existing.field_key)

        new_type = values.get("field_type") or existing.field_type
        if new_type != existing.field_type and in_use:
            raise HTTPException(
                status_code=409,
                detail=f"{in_use} task(s) already hold a value for "
                       f"'{existing.field_key}'. Clear them before changing "
                       f"its type, or create a new field.",
            )

        if "options" in values:
            options = clean_options(new_type, values["options"])
            removed = await _options_in_use(
                db, root, existing.field_key, list(existing.options or []), options,
            )
            if removed:
                raise HTTPException(
                    status_code=409,
                    detail=f"Option(s) {sorted(removed)} are still in use on "
                           f"'{existing.field_key}'. Change those tasks first — "
                           f"dropping the option would leave a value no filter "
                           f"can match.",
                )
            values["options"] = _json(options)

        row = await update_row(db, "pm_custom_fields", field_id, values)
        await db.commit()
        return _definition_row(row)
    finally:
        await db.close()


@router.delete("/fields/{field_id}")
async def delete_field(
    field_id: str, user: UserContext = Depends(get_current_user),
) -> dict:
    """Delete a definition AND the values filed under it.

    **This is the deliberate departure from Paca**, whose research notes record
    "deleting a definition does not clean task data" as an accepted cost. It is
    not accepted here. A key left behind in the JSONB is invisible — no
    definition means no column, no form row, no filter — right up until somebody
    creates a field with the same name and every old value resurfaces carrying
    its new meaning.

    The count is reported (R7/R8), for the same reason ``delete_view`` reports
    its cascade: losing data silently is what makes people distrust a delete.
    """
    db = await _get_db()
    try:
        existing = await require_row(db, "pm_custom_fields", field_id, "Custom field")
        vis = await resolve_visibility(db, user)
        await load_visible_project(db, vis, str(existing.project_id))
        root = str(existing.project_id)
        cleared = (await db.execute(
            text(
                "UPDATE pm_tasks SET custom_fields = custom_fields - :key "
                "WHERE root_project_id = CAST(:root AS uuid) "
                "  AND custom_fields ? :key"
            ),
            {"root": root, "key": existing.field_key},
        )).rowcount or 0
        await db.execute(
            text("DELETE FROM pm_custom_fields WHERE id = CAST(:fid AS uuid)"),
            {"fid": field_id},
        )
        await db.commit()
        return {
            "deleted": field_id,
            "field_key": existing.field_key,
            "cascaded": {"values_cleared": int(cleared)},
        }
    finally:
        await db.close()


async def _options_in_use(
    db: Any, root: str, key: str, before: list[str], after: list[str],
) -> set[str]:
    """Which of the dropped options some task still holds.

    Adding options is free; removing one is what needs the check, so the query
    only runs when something actually went away.
    """
    dropped = set(before) - set(after)
    if not dropped:
        return set()
    rows = (await db.execute(
        text(
            "SELECT custom_fields -> :key AS value FROM pm_tasks "
            "WHERE root_project_id = CAST(:root AS uuid) "
            "  AND custom_fields ? :key"
        ),
        {"root": root, "key": key},
    )).fetchall()
    held: set[str] = set()
    for row in rows:
        value = row.value
        if isinstance(value, list):
            held.update(str(v) for v in value)
        elif value is not None:
            held.add(str(value))
    return dropped & held


def _json(value: Any) -> str:
    import json

    return json.dumps(value)


def _definition_row(row: Any) -> dict[str, Any]:
    return {
        "id": str(row.id),
        "project_id": str(row.project_id),
        "field_key": row.field_key,
        "name": row.name,
        "description": row.description,
        "field_type": row.field_type,
        "options": list(row.options or []),
        "position": row.position,
        "created_by": row.created_by,
    }


__all__ = [
    "CHOICE_TYPES",
    "FIELD_TYPES",
    "MAX_FIELDS",
    "MAX_OPTIONS",
    "MAX_SELECTED",
    "MAX_TEXT",
    "apply_values",
    "clean_options",
    "coerce_value",
    "load_definitions",
    "row_to_dict",
    "slugify_key",
    "strip_key",
    "validate_key",
]

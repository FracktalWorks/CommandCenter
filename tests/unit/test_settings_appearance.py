"""Tests for the organisation-wide appearance default (Settings → Appearance).

This endpoint decides what EVERY member's UI looks like, so the interesting
cases are all about degrading safely: a blob written by a different version of
the app, a theme that has since been removed, or a value that would end up
inside a CSS attribute selector.

The deliberate non-behaviour pinned here is that the gateway does not know
which themes exist — that list lives in the frontend, and validating against a
copy of it would mean a backend deploy for every new theme.
"""
from __future__ import annotations

import pytest
from fastapi import HTTPException
from gateway.routes import settings as st


# ── Reading a stored blob ───────────────────────────────────────────────────

def test_absent_row_yields_the_built_in_default() -> None:
    """A deployment that has never set an org default still renders."""
    org, updated_by, updated_at = st._coerce_appearance({})
    assert org.themeId == "rapidtool"
    assert org.mode == "dark"
    assert org.density == "default"
    assert org.allowUserOverride is True
    assert updated_by == ""
    assert updated_at == ""


def test_stored_values_round_trip() -> None:
    org, updated_by, updated_at = st._coerce_appearance(
        {
            "org": {
                "themeId": "fluent",
                "mode": "light",
                "density": "compact",
                "allowUserOverride": False,
            },
            "updatedBy": "someone@fracktal.in",
            "updatedAt": "2026-08-06T00:00:00+00:00",
        }
    )
    assert org.themeId == "fluent"
    assert org.mode == "light"
    assert org.density == "compact"
    assert org.allowUserOverride is False
    assert updated_by == "someone@fracktal.in"
    assert updated_at == "2026-08-06T00:00:00+00:00"


def test_a_bare_blob_without_the_org_wrapper_is_accepted() -> None:
    """Tolerates the flat shape so an older row is not read as empty."""
    org, _, _ = st._coerce_appearance({"themeId": "material", "mode": "light"})
    assert org.themeId == "material"
    assert org.mode == "light"


@pytest.mark.parametrize("raw", [None, [], "nonsense", 42])
def test_a_non_dict_blob_degrades_to_defaults(raw) -> None:
    org, _, _ = st._coerce_appearance(raw)
    assert org.themeId == "rapidtool"


def test_each_field_falls_back_independently() -> None:
    """One unrecognised key must not reset the whole organisation's look."""
    org, _, _ = st._coerce_appearance(
        {"themeId": "fluent", "mode": "sideways", "density": "enormous"}
    )
    assert org.themeId == "fluent"  # kept
    assert org.mode == "dark"  # defaulted
    assert org.density == "default"  # defaulted


@pytest.mark.parametrize(
    "theme_id",
    [
        'a"b',  # would close the attribute selector
        "a b",
        "Fluent",  # uppercase needs escaping in the generated selector
        "-leading",
        "a{b}",
        "",
        "x" * 65,  # over the length cap
    ],
)
def test_unsafe_theme_ids_are_rejected_on_read(theme_id: str) -> None:
    """A stored id reaches `html[data-theme="…"]`; anything needing escaping
    must not survive the read."""
    org, _, _ = st._coerce_appearance({"themeId": theme_id})
    assert org.themeId == "rapidtool"


def test_an_unknown_but_well_formed_theme_id_is_preserved() -> None:
    """The gateway does NOT own the theme list.

    A theme the frontend added without a backend deploy has to survive this
    round trip, or shipping a theme would require changing two services. The
    frontend re-validates and falls back for an id it cannot render.
    """
    org, _, _ = st._coerce_appearance({"themeId": "some-future-theme"})
    assert org.themeId == "some-future-theme"


# ── Writing ─────────────────────────────────────────────────────────────────

class _User:
    email = "admin@fracktal.in"


def _saved(monkeypatch) -> list[tuple]:
    calls: list[tuple] = []
    import acb_common

    monkeypatch.setattr(
        acb_common,
        "save_org_setting",
        lambda key, value, updated_by="": calls.append((key, value, updated_by)),
    )
    return calls


async def _put(body):
    return await st.put_appearance(body, user=_User())


@pytest.mark.asyncio
async def test_put_persists_the_default_with_attribution(monkeypatch) -> None:
    calls = _saved(monkeypatch)
    body = st.OrgAppearance(
        themeId="material", mode="light", density="comfortable", allowUserOverride=False
    )

    result = await _put(body)

    assert len(calls) == 1
    key, value, updated_by = calls[0]
    assert key == "appearance"
    assert value["org"]["themeId"] == "material"
    assert value["org"]["allowUserOverride"] is False
    # Org-wide settings affect everybody, so who changed it is part of the row.
    assert value["updatedBy"] == "admin@fracktal.in"
    assert updated_by == "admin@fracktal.in"
    assert result.org.themeId == "material"
    assert result.updatedBy == "admin@fracktal.in"
    assert result.updatedAt


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "field,value",
    [
        ("mode", "sideways"),
        ("density", "enormous"),
        ("themeId", 'evil"]{--x:1}'),
        ("themeId", ""),
    ],
)
async def test_put_rejects_invalid_values_before_they_reach_anyone(
    monkeypatch, field: str, value: str
) -> None:
    """Pydantic types these as plain strings because they are open
    vocabularies on the frontend, so the enum check has to happen in the
    handler — otherwise an arbitrary value lands in every member's browser."""
    calls = _saved(monkeypatch)
    body = st.OrgAppearance(**{field: value})

    with pytest.raises(HTTPException) as exc:
        await _put(body)

    assert exc.value.status_code == 400
    assert calls == [], "a rejected write must not touch the store"


def _required_permissions(route) -> set[str]:
    """Permission strings a route's dependencies enforce.

    `require_permission` closes over its arguments rather than exposing them,
    so the only way to assert the gate from outside is to read the closure.
    Worth the reach: the alternative is trusting that a decorator nobody
    checked is still there.
    """
    found: set[str] = set()
    for dep in getattr(route, "dependencies", []):
        fn = getattr(dep, "dependency", None)
        for cell in getattr(fn, "__closure__", None) or ():
            value = cell.cell_contents
            if isinstance(value, tuple) and all(isinstance(v, str) for v in value):
                found.update(value)
    return found


def test_write_is_gated_on_admin_settings_manage() -> None:
    """Anyone may READ the org default (every client needs it on load), but
    changing everybody's UI is an admin action."""
    routes = {
        (r.path, tuple(sorted(r.methods))): r
        for r in st.router.routes
        if hasattr(r, "methods")
    }
    put = routes[("/settings/appearance", ("PUT",))]
    get = routes[("/settings/appearance", ("GET",))]

    assert "admin:settings:manage" in _required_permissions(put)
    assert _required_permissions(get) == set()

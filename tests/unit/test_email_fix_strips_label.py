"""A Fix must strip the wrong label off the message it was corrected from (H6).

Before this, ``rule_feedback`` taught patterns/guidance so FUTURE mail classified
right, but the offending message kept its wrong chip — the correction looked
ignored. ``correct_applied_labels`` now reuses the one-writer label machinery to
remove the wrongly-matched rules' labels (provider FIRST, then the local mirror)
and apply the corrected rule's label. These pin that surgery.
"""
from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from gateway.routes.email.automation import runner


class _Result:
    def __init__(self, rows: list | None = None) -> None:
        self._rows = rows or []

    def fetchall(self) -> list:
        return self._rows

    def fetchone(self):
        return self._rows[0] if self._rows else None


class _FakeDB:
    """Answers the LABEL-value SELECTs from a per-rule map; records UPDATEs."""

    def __init__(self, labels_by_rule: dict[str, list[str]]) -> None:
        self.labels_by_rule = labels_by_rule
        self.updates: list[dict] = []

    async def execute(self, stmt, params=None):  # noqa: ANN001
        sql = str(stmt)
        params = params or {}
        if "FROM email_actions" in sql:
            labels = self.labels_by_rule.get(params.get("rid"), [])
            return _Result([SimpleNamespace(label=lbl) for lbl in labels])
        self.updates.append({"sql": sql, **params})
        return _Result([])


def _provider() -> AsyncMock:
    p = AsyncMock()
    p.authenticate.return_value = True
    return p


async def _run(db, **kw):
    prov = _provider()
    with patch.object(
        runner, "_provider_for_message",
        AsyncMock(return_value=(prov, "pmid-1", "acc", None)),
    ):
        out = await runner.correct_applied_labels(
            db, "acc", "msg-1", "owner@x.com", **kw)
    return out, prov


async def test_strips_wrong_label_and_applies_correct_one() -> None:
    db = _FakeDB({"r-wrong": ["Newsletter"], "r-right": ["Receipt"]})
    out, prov = await _run(
        db, remove_rule_ids=["r-wrong"], add_rule_id="r-right")
    assert out == {"removed": ["Newsletter"], "added": ["Receipt"]}
    # Provider FIRST: the wrong label removed, the right one added.
    calls = [c.kwargs for c in prov.set_labels.await_args_list]
    assert {"add": [], "remove": ["Newsletter"]} in calls
    assert {"add": ["Receipt"], "remove": []} in calls
    # Local mirror touched for both (array_remove + array_append).
    assert any("array_remove" in u["sql"] for u in db.updates)
    assert any("array_append" in u["sql"] for u in db.updates)


async def test_none_correction_only_removes() -> None:
    db = _FakeDB({"r-a": ["Newsletter"], "r-b": ["Promotions"]})
    out, prov = await _run(
        db, remove_rule_ids=["r-a", "r-b"], add_rule_id=None)
    assert out["added"] == []
    assert set(out["removed"]) == {"Newsletter", "Promotions"}
    assert all(c.kwargs["add"] == [] for c in prov.set_labels.await_args_list)


async def test_never_strips_a_label_it_is_about_to_reapply() -> None:
    # Wrong rule and correct rule share a label → it must survive (no churn,
    # no provider round-trip that removes then re-adds the same category).
    db = _FakeDB({"r-wrong": ["Updates"], "r-right": ["Updates"]})
    out, prov = await _run(
        db, remove_rule_ids=["r-wrong"], add_rule_id="r-right")
    assert out["removed"] == []
    assert out["added"] == ["Updates"]
    assert all(
        c.kwargs["remove"] == [] for c in prov.set_labels.await_args_list)


async def test_provider_auth_failure_still_updates_local_mirror() -> None:
    db = _FakeDB({"r-wrong": ["Newsletter"]})
    prov = _provider()
    prov.authenticate.return_value = False
    with patch.object(
        runner, "_provider_for_message",
        AsyncMock(return_value=(prov, "pmid-1", "acc", None)),
    ):
        out = await runner.correct_applied_labels(
            db, "acc", "msg-1", "owner@x.com",
            remove_rule_ids=["r-wrong"], add_rule_id=None)
    assert out["removed"] == ["Newsletter"]
    # Never touched the provider (auth failed) but still corrected the mirror.
    prov.set_labels.assert_not_awaited()
    assert any("array_remove" in u["sql"] for u in db.updates)

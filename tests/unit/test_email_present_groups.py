"""present_email_groups: the agent-driven categorized email board.

The tool takes the agent's JSON grouping ({title, email_ids, note?}), hydrates
each row's label via one batched summaries lookup, and emits a parseable board:
a "## <title> (<n>)" header per group over "• id=… | sender: subject" rows.
These lock that contract (the frontend EmailGroupsCard parses exactly this).
"""
from __future__ import annotations

import importlib.util
from pathlib import Path

import pytest

_AGENT = (
    Path(__file__).resolve().parents[2]
    / "apps" / "agent-email-assistant" / "agents.py"
)


def _load_agents():
    spec = importlib.util.spec_from_file_location("email_assistant_agents", _AGENT)
    assert spec and spec.loader
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


agents = _load_agents()


@pytest.fixture()
def fake_summaries(monkeypatch):
    """Stub the gateway summaries POST with a fixed id → label map."""
    meta = {
        "a1": {"id": "a1", "from": "HR Team", "subject": "Onboarding"},
        "b2": {"id": "b2", "from": "Payroll", "subject": "Payslip"},
        "c3": {"id": "c3", "from": "Lab", "subject": "Test results"},
    }

    async def fake_post(path, body):
        assert path == "/email/messages/summaries"
        return {"summaries": [meta[i] for i in body["ids"] if i in meta]}

    monkeypatch.setattr(agents, "_post", fake_post)
    return meta


async def test_present_groups_emits_parseable_board(fake_summaries) -> None:
    out = await agents.present_email_groups(
        '[{"title": "HR", "email_ids": ["a1"], "note": "onboarding"},'
        ' {"title": "Finance", "email_ids": ["b2"]},'
        ' {"title": "R&D", "email_ids": ["c3"]}]'
    )
    lines = out.splitlines()
    assert lines[0] == "Categorized emails — 3 across 3 group(s):"
    assert "## HR (1) — onboarding" in lines
    assert "## Finance (1)" in lines
    assert "## R&D (1)" in lines
    assert "• id=a1 | HR Team: Onboarding" in lines
    assert "• id=b2 | Payroll: Payslip" in lines


async def test_present_groups_dedupes_ids_across_groups(fake_summaries) -> None:
    # b2 appears in two groups — it stays only in the first (one category each).
    out = await agents.present_email_groups(
        '[{"title": "First", "email_ids": ["a1", "b2"]},'
        ' {"title": "Second", "email_ids": ["b2", "c3"]}]'
    )
    assert out.count("id=b2") == 1
    assert "## First (2)" in out
    assert "## Second (1)" in out  # b2 dropped from the second group


async def test_present_groups_renders_unknown_ids(monkeypatch) -> None:
    # A lookup that returns nothing must still render a row (never silently drop).
    async def empty_post(path, body):
        return {"summaries": []}

    monkeypatch.setattr(agents, "_post", empty_post)
    out = await agents.present_email_groups('[{"title": "X", "email_ids": ["z9"]}]')
    assert "id=z9" in out
    assert "## X (1)" in out


async def test_present_groups_rejects_bad_json() -> None:
    out = await agents.present_email_groups("not json")
    assert "Couldn't parse" in out


async def test_present_groups_empty_is_handled() -> None:
    assert "No groups" in await agents.present_email_groups("[]")

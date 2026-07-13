"""Offline unit tests for skill-clickup-sync.

No ClickUp API calls — all HTTP is mocked via monkeypatching.
"""
from __future__ import annotations

import sys
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent))

from skill_clickup_sync.core import get_task_status, list_project_tasks


@pytest.fixture(autouse=True)
def set_env(monkeypatch):
    monkeypatch.setenv("CLICKUP_API_TOKEN", "fake-token")
    monkeypatch.setenv("CLICKUP_WORKSPACE_ID", "ws123")


class _FakeResponse:
    def __init__(self, data, status_code=200):
        self._data = data
        self.status_code = status_code
    def raise_for_status(self):
        if self.status_code >= 400:
            raise RuntimeError(f"HTTP {self.status_code}")
    def json(self):
        return self._data


@pytest.mark.asyncio
async def test_get_task_status_success():
    task_data = {
        "name": "Fix login bug",
        "status": {"status": "in progress"},
        "assignees": [{"username": "vijay"}],
        "due_date": "1719792000000",
        "url": "https://app.clickup.com/t/abc123",
    }
    mock_client = AsyncMock()
    mock_client.__aenter__ = AsyncMock(return_value=mock_client)
    mock_client.__aexit__ = AsyncMock(return_value=False)
    mock_client.get = AsyncMock(return_value=_FakeResponse(task_data))

    with patch("skill_clickup_sync.core.httpx.AsyncClient", return_value=mock_client):
        result = await get_task_status("abc123")

    assert "Fix login bug" in result
    assert "in progress" in result
    assert "vijay" in result


@pytest.mark.asyncio
async def test_get_task_status_not_found():
    mock_client = AsyncMock()
    mock_client.__aenter__ = AsyncMock(return_value=mock_client)
    mock_client.__aexit__ = AsyncMock(return_value=False)
    mock_client.get = AsyncMock(return_value=_FakeResponse({}, status_code=404))

    with patch("skill_clickup_sync.core.httpx.AsyncClient", return_value=mock_client):
        result = await get_task_status("bad-id")

    assert "not found" in result.lower()


@pytest.mark.asyncio
async def test_get_task_status_no_token(monkeypatch):
    monkeypatch.delenv("CLICKUP_API_TOKEN", raising=False)
    with pytest.raises(RuntimeError, match="CLICKUP_API_TOKEN"):
        await get_task_status("abc")


@pytest.mark.asyncio
async def test_list_project_tasks_no_workspace(monkeypatch):
    monkeypatch.delenv("CLICKUP_WORKSPACE_ID", raising=False)
    result = await list_project_tasks("Alpha")
    assert "CLICKUP_WORKSPACE_ID" in result


@pytest.mark.asyncio
async def test_list_project_tasks_no_match():
    spaces_resp = _FakeResponse({"spaces": [{"id": "s1"}]})
    lists_resp = _FakeResponse({"lists": [{"id": "l1", "name": "Beta Project"}]})
    tasks_resp = _FakeResponse({"tasks": []})

    responses = iter([spaces_resp, lists_resp])
    mock_client = AsyncMock()
    mock_client.__aenter__ = AsyncMock(return_value=mock_client)
    mock_client.__aexit__ = AsyncMock(return_value=False)
    mock_client.get = AsyncMock(side_effect=lambda *a, **kw: next(responses))

    with patch("skill_clickup_sync.core.httpx.AsyncClient", return_value=mock_client):
        result = await list_project_tasks("AlphaXYZ")

    assert "No ClickUp list found" in result
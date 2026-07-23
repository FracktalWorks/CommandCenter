"""Upstream inbox rules become visible in-app (the Rules screen's "Also acting
on your mail" section): ``OutlookProvider.list_filters`` maps Graph
messageRules to display dicts and degrades to ``[]`` on the consumer-MSA
403/404 — the same scope caveat ``create_filter`` documents. The base provider
defaults to ``[]`` so IMAP/Gmail callers render local policies without a
provider branch."""
from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import AsyncMock

from email_ingestion.providers.outlook import OutlookProvider


def _provider() -> OutlookProvider:
    return OutlookProvider({"access_token": "t", "refresh_token": "r"})


def _resp(status: int = 200, json_body: dict | None = None) -> SimpleNamespace:
    return SimpleNamespace(
        status_code=status,
        headers={},
        json=lambda: (json_body or {}),
        raise_for_status=lambda: None,
    )


async def test_list_filters_maps_message_rules() -> None:
    p = _provider()
    client = AsyncMock()
    client.get.return_value = _resp(json_body={"value": [
        {"id": "r1", "displayName": "Auto-archive foo@bar.com",
         "isEnabled": True,
         "conditions": {"fromAddresses": [
             {"emailAddress": {"address": "foo@bar.com"}}]},
         "actions": {"moveToFolder": "archive",
                     "assignCategories": ["Newsletter"],
                     "stopProcessingRules": True}},
        {"id": "r2", "displayName": "VIP", "isEnabled": False,
         "conditions": {"subjectContains": ["urgent"]},
         "actions": {"markImportance": "high"}},
    ]})
    p._http = client

    rules = await p.list_filters()
    assert rules[0] == {
        "id": "r1", "name": "Auto-archive foo@bar.com", "enabled": True,
        "from_addresses": ["foo@bar.com"],
        "summary": ["move to folder", "label: Newsletter"],
    }
    assert rules[1]["enabled"] is False
    assert "subject contains “urgent”" in rules[1]["summary"]
    assert "importance: high" in rules[1]["summary"]


async def test_list_filters_degrades_on_missing_scope() -> None:
    # Consumer MSA / missing MailboxSettings.ReadWrite → 403: an empty list,
    # never an exception — the Rules screen must still render local policies.
    p = _provider()
    client = AsyncMock()
    client.get.return_value = _resp(status=403)
    p._http = client
    assert await p.list_filters() == []


async def test_base_provider_defaults_to_no_filters() -> None:
    from email_ingestion.providers.base import BaseEmailProvider

    assert await BaseEmailProvider.list_filters(
        SimpleNamespace()) == []  # default needs no provider state

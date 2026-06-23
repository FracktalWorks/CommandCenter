"""Outlook provider: folder paging fix, deep folder listing, and get-or-create
move-to-folder (inbox-zero parity for filing mail into folders)."""
from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock

from email_ingestion.providers.outlook import OutlookProvider, _skiptoken


def _provider() -> OutlookProvider:
    return OutlookProvider({
        "access_token": "x", "refresh_token": "y",
        "client_id": "c", "client_secret": "s",
    })


def _resp(json_value: dict, *, is_success: bool = True, status: int = 200,
          text: str = "") -> MagicMock:
    r = MagicMock()
    r.raise_for_status = MagicMock()
    r.json = MagicMock(return_value=json_value)
    r.is_success = is_success
    r.status_code = status
    r.text = text
    return r


# ── $skiptoken extraction (the ~100-email cap fix) ───────────────────────────

def test_skiptoken_extracts_bare_token_from_nextlink() -> None:
    url = ("https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages"
           "?$top=100&$skiptoken=ABC123")
    assert _skiptoken(url) == "ABC123"
    assert _skiptoken("ABC123") == "ABC123"   # already bare
    assert _skiptoken(None) is None


async def test_list_messages_returns_bare_token_and_feeds_it_back() -> None:
    p = _provider()
    client = AsyncMock()
    next_link = ("https://graph.microsoft.com/v1.0/me/mailFolders/inbox/"
                 "messages?$skiptoken=PAGE2")
    client.get.return_value = _resp({"value": [], "@odata.nextLink": next_link})
    p._get_client = AsyncMock(return_value=client)  # type: ignore[method-assign]

    # Page 1 → surfaces a BARE token, not the full nextLink URL.
    _, token = await p.list_messages(folder="inbox", max_results=100)
    assert token == "PAGE2"

    # Page 2 → the bare token is sent back as $skiptoken (Graph accepts it).
    await p.list_messages(folder="inbox", max_results=100, page_token=token)
    params = client.get.await_args.kwargs["params"]
    assert params["$skiptoken"] == "PAGE2"


# ── deep folder listing (all folders, incl. nested) ──────────────────────────

async def test_list_folders_paginates_and_descends_children() -> None:
    p = _provider()
    client = AsyncMock()
    top = _resp({"value": [
        {"id": "AAA", "displayName": "Inbox", "wellKnownName": "inbox",
         "childFolderCount": 1},
        {"id": "BBB", "displayName": "Newsletter", "childFolderCount": 0},
    ]})
    child = _resp({"value": [
        {"id": "CCC", "displayName": "Sub", "childFolderCount": 0},
    ]})
    client.get.side_effect = [top, child]
    p._get_client = AsyncMock(return_value=client)  # type: ignore[method-assign]

    folders = await p.list_folders()
    by_name = {f.name: f for f in folders}
    assert set(by_name) == {"Inbox", "Newsletter", "Sub"}
    assert by_name["Inbox"].type == "system"      # wellKnownName → system
    assert by_name["Newsletter"].type == "user"
    assert by_name["Sub"].type == "user"          # nested child surfaced


# ── get-or-create move-to-folder ─────────────────────────────────────────────

async def test_move_to_folder_creates_user_folder_then_moves() -> None:
    p = _provider()
    client = AsyncMock()
    # 1) find by displayName → none; 2) move response carries new id.
    client.get.return_value = _resp({"value": []})
    client.post.side_effect = [
        _resp({"id": "folder-123"}),           # POST /me/mailFolders (create)
        _resp({"id": "new-msg-id"}),           # POST /me/messages/{id}/move
    ]
    p._get_client = AsyncMock(return_value=client)  # type: ignore[method-assign]

    new_id = await p.move_to_folder("old-msg", "Cold Email")
    assert new_id == "new-msg-id"               # re-keyed message id returned
    # The folder was created with the original-case display name.
    create_call = client.post.await_args_list[0]
    assert create_call.kwargs["json"]["displayName"] == "Cold Email"
    # The move targeted the created folder id.
    move_call = client.post.await_args_list[1]
    assert move_call.kwargs["json"]["destinationId"] == "folder-123"


async def test_move_to_folder_system_target_skips_create() -> None:
    p = _provider()
    client = AsyncMock()
    client.post.return_value = _resp({"id": "new-msg-id"})
    p._get_client = AsyncMock(return_value=client)  # type: ignore[method-assign]

    await p.move_to_folder("msg", "archive")
    # No folder lookup/create for a well-known target — just the /move POST.
    client.get.assert_not_called()
    assert client.post.await_count == 1
    assert client.post.await_args.kwargs["json"]["destinationId"] == "archive"


async def test_get_or_create_reuses_existing_on_conflict() -> None:
    p = _provider()
    client = AsyncMock()
    # find → none, create → 409 ErrorFolderExists, find again → existing id.
    client.get.side_effect = [
        _resp({"value": []}),
        _resp({"value": [{"id": "existing-id", "displayName": "Newsletter"}]}),
    ]
    client.post.return_value = _resp(
        {}, is_success=False, status=409, text="ErrorFolderExists"
    )
    p._get_client = AsyncMock(return_value=client)  # type: ignore[method-assign]

    folder_id = await p._get_or_create_folder_id("Newsletter")
    assert folder_id == "existing-id"

"""Contract tests for the WhatsApp Cloud API webhook parser.

The parser is the transport boundary — every inbound message enters the store
through it — and it must stay TOTAL: a malformed change lands in ``errors``, it
never raises and never drops the good messages beside it. These pin the shape of
each Meta message type we normalize.
"""

from __future__ import annotations

from datetime import UTC

from whatsapp_ingestion.providers.webhook import parse_webhook


def _wrap(value: dict) -> dict:
    """Wrap a change ``value`` in the full entry/changes envelope Meta sends."""
    return {
        "object": "whatsapp_business_account",
        "entry": [{"id": "WABA1", "changes": [{"value": value, "field": "messages"}]}],
    }


_META = {"display_phone_number": "918012344", "phone_number_id": "PN123"}
_CONTACT = {"profile": {"name": "Rajesh Mehta"}, "wa_id": "919990388"}


def test_parses_text_message_with_sender_and_timestamp() -> None:
    payload = _wrap({
        "metadata": _META,
        "contacts": [_CONTACT],
        "messages": [{
            "from": "919990388", "id": "wamid.T1", "timestamp": "1690000000",
            "type": "text", "text": {"body": "PO attached 🙏"},
        }],
    })
    result = parse_webhook(payload)
    assert result.phone_number_id == "PN123"
    assert len(result.messages) == 1
    m = result.messages[0]
    assert m.wa_message_id == "wamid.T1"
    assert m.kind == "text"
    assert m.body_text == "PO attached 🙏"
    assert m.sender_wa_id == "919990388"
    assert m.sender_name == "Rajesh Mehta"       # resolved from contacts
    assert m.wa_chat_id == "919990388"            # DM keys on the sender
    assert m.chat_kind == "dm"
    assert m.direction == "in"
    assert m.sent_at is not None
    assert m.sent_at.tzinfo == UTC


def test_document_message_extracts_media_and_caption() -> None:
    payload = _wrap({
        "metadata": _META,
        "messages": [{
            "from": "919990388", "id": "wamid.D1", "timestamp": "1690000100",
            "type": "document",
            "document": {
                "id": "MEDIA9", "mime_type": "application/pdf",
                "filename": "PO_4417.pdf", "sha256": "abc",
                "caption": "PO for 2 Falcons",
            },
        }],
    })
    m = parse_webhook(payload).messages[0]
    assert m.kind == "document"
    assert m.body_text == "PO for 2 Falcons"     # caption becomes the body
    assert m.media is not None
    assert m.media.wa_media_id == "MEDIA9"
    assert m.media.mime_type == "application/pdf"
    assert m.media.filename == "PO_4417.pdf"


def test_voice_note_distinguished_from_plain_audio() -> None:
    voice = _wrap({"metadata": _META, "messages": [{
        "from": "91", "id": "wamid.V", "timestamp": "1690000200",
        "type": "audio", "audio": {"id": "A1", "voice": True},
    }]})
    audio = _wrap({"metadata": _META, "messages": [{
        "from": "91", "id": "wamid.A", "timestamp": "1690000200",
        "type": "audio", "audio": {"id": "A2", "voice": False},
    }]})
    assert parse_webhook(voice).messages[0].kind == "voice"
    assert parse_webhook(audio).messages[0].kind == "audio"


def test_reply_context_and_location_and_reaction() -> None:
    payload = _wrap({"metadata": _META, "messages": [
        {"from": "91", "id": "wamid.R", "timestamp": "1690000300",
         "type": "text", "text": {"body": "yes"}, "context": {"id": "wamid.PARENT"}},
        {"from": "91", "id": "wamid.L", "timestamp": "1690000301",
         "type": "location", "location": {"latitude": 12.9, "longitude": 77.5,
                                            "name": "Fracktal HQ"}},
        {"from": "91", "id": "wamid.X", "timestamp": "1690000302",
         "type": "reaction", "reaction": {"message_id": "wamid.PARENT", "emoji": "👍"}},
    ]})
    msgs = parse_webhook(payload).messages
    assert msgs[0].quoted_wa_message_id == "wamid.PARENT"
    assert msgs[1].kind == "location" and "Fracktal HQ" in msgs[1].body_text
    assert msgs[2].kind == "reaction" and msgs[2].body_text == "👍"


def test_group_message_keys_chat_on_group_id() -> None:
    payload = _wrap({"metadata": _META, "messages": [{
        "from": "919990388", "id": "wamid.G", "timestamp": "1690000400",
        "type": "text", "text": {"body": "margin?"}, "group_id": "GROUP-SOUTH",
    }]})
    m = parse_webhook(payload).messages[0]
    assert m.chat_kind == "group"
    assert m.wa_chat_id == "GROUP-SOUTH"          # group keys on the group, not sender
    assert m.sender_wa_id == "919990388"


def test_unknown_type_becomes_system_not_dropped() -> None:
    payload = _wrap({"metadata": _META, "messages": [{
        "from": "91", "id": "wamid.U", "timestamp": "1690000500",
        "type": "interactive", "interactive": {"type": "button_reply"},
    }]})
    m = parse_webhook(payload).messages[0]
    assert m.kind == "system"                     # preserved, not lost
    assert m.raw["type"] == "interactive"


def test_status_callbacks_parsed_with_errors() -> None:
    payload = _wrap({"metadata": _META, "statuses": [
        {"id": "wamid.S", "status": "delivered", "timestamp": "1690000600",
         "recipient_id": "919990388"},
        {"id": "wamid.F", "status": "failed", "timestamp": "1690000601",
         "recipient_id": "919990388",
         "errors": [{"title": "Re-engagement message"}]},
    ]})
    result = parse_webhook(payload)
    assert not result.messages
    assert len(result.statuses) == 2
    assert result.statuses[0].status == "delivered"
    assert result.statuses[1].status == "failed"
    assert result.statuses[1].error == "Re-engagement message"


def test_malformed_change_is_isolated_not_fatal() -> None:
    payload = {
        "object": "whatsapp_business_account",
        "entry": [{"changes": [
            {"value": None},                        # malformed → error, not crash
            {"value": {"metadata": _META, "messages": [{
                "from": "91", "id": "wamid.OK", "timestamp": "1690000700",
                "type": "text", "text": {"body": "still here"}}]}},
        ]}],
    }
    result = parse_webhook(payload)
    # The good message survives; a None value is simply an empty change.
    assert [m.wa_message_id for m in result.messages] == ["wamid.OK"]


def test_non_dict_payload_returns_error_not_raise() -> None:
    result = parse_webhook([])  # type: ignore[arg-type]
    assert result.messages == []
    assert result.errors and "not an object" in result.errors[0]

"""Regression tests for output-truncation visibility (audit CX4).

Nothing anywhere inspected ``finish_reason == "length"`` — a completion cut
at max_tokens rendered as a normal completed turn ending mid-sentence. The
/v1 choke point now appends an explicit notice (stream: one synthetic delta
chunk; non-stream: annotated message content), env-gated via
V1_SURFACE_TRUNCATION.
"""
from __future__ import annotations

from types import SimpleNamespace

from gateway.routes.v1_compat import (
    _TRUNCATION_NOTICE,
    _chunk_finish_reason,
    _mark_truncated_nonstream,
    _truncation_notice_chunk,
)


def test_chunk_finish_reason_extraction():
    assert _chunk_finish_reason(
        {"choices": [{"delta": {}, "finish_reason": "length"}]}
    ) == "length"
    assert _chunk_finish_reason(
        {"choices": [{"delta": {"content": "hi"}, "finish_reason": None}]}
    ) is None
    assert _chunk_finish_reason({"choices": []}) is None
    assert _chunk_finish_reason({}) is None


def test_truncation_chunk_is_openai_shaped():
    chunk = _truncation_notice_chunk("deepseek/deepseek-chat")
    assert chunk["object"] == "chat.completion.chunk"
    assert chunk["choices"][0]["delta"]["content"] == _TRUNCATION_NOTICE
    assert chunk["choices"][0]["index"] == 0
    assert chunk["model"] == "deepseek/deepseek-chat"


def test_nonstream_dict_shape_annotated():
    choices = [{
        "finish_reason": "length",
        "message": {"role": "assistant", "content": "half an ans"},
    }]
    assert _mark_truncated_nonstream(choices) is True
    assert choices[0]["message"]["content"].endswith(_TRUNCATION_NOTICE)


def test_nonstream_object_shape_annotated():
    msg = SimpleNamespace(role="assistant", content="half an ans")
    choices = [SimpleNamespace(finish_reason="length", message=msg)]
    assert _mark_truncated_nonstream(choices) is True
    assert msg.content.endswith(_TRUNCATION_NOTICE)


def test_nonstream_normal_stop_untouched():
    choices = [{
        "finish_reason": "stop",
        "message": {"role": "assistant", "content": "full answer"},
    }]
    assert _mark_truncated_nonstream(choices) is False
    assert choices[0]["message"]["content"] == "full answer"


def test_nonstream_tool_call_without_content_untouched():
    # A length-cut mid-tool-call has message.content=None — nothing to
    # annotate; must not crash or fabricate content.
    choices = [{
        "finish_reason": "length",
        "message": {"role": "assistant", "content": None, "tool_calls": []},
    }]
    assert _mark_truncated_nonstream(choices) is False

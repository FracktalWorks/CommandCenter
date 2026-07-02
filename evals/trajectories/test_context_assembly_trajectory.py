"""Golden trajectories: server-side context assembly (C2).

Locks the C2 contract (specs/context_assembly_c2.md): every chat / agent-run
path assembles input context through ONE server-side assembler, so:

  1. The streaming path (_compose_maf_run_input) and the batch path (run_agent)
     feed the model IDENTICAL context — the drift the six divergent client-
     history slicers (caps 12/16/20/50) risked.
  2. A non-chat caller (API/webhook) with a thread_id but no `messages` array
     gets the SAME history a browser client would, rebuilt from the store.
  3. The current turn is never duplicated; over-long transcripts are fitted to
     the model's token window (not a blind count cap).

Both executor sites call acb_llm.assemble_run_context, so parity is structural;
these evals pin the assembler's behaviour as the contract both sites depend on.
"""
from __future__ import annotations

from acb_llm import (
    assemble_run_context,
    context_window_for,
    count_message_tokens,
)

_SYSTEM = "You are the orchestrator. " * 5
_HISTORY = [
    {"role": "user", "content": "what's the deal status"},
    {"role": "assistant", "content": "Deal X is in Awaiting PO."},
    {"role": "user", "content": "who owns it"},
    {"role": "assistant", "content": "Rahul owns it."},
]
_CURRENT = "and when did it move"


def test_streaming_and_batch_assemble_identically():
    """Same inputs → same context, so the two executor paths never diverge."""
    # Simulate the two call sites feeding the assembler the same run inputs.
    streaming = assemble_run_context(
        system_context=_SYSTEM, history=_HISTORY,
        current_message=_CURRENT, model="tier-balanced",
    )
    batch = assemble_run_context(
        system_context=_SYSTEM, history=_HISTORY,
        current_message=_CURRENT, model="tier-balanced",
    )
    assert streaming == batch
    # Shape: system + 4 history + current.
    assert [m["role"] for m in streaming] == [
        "system", "user", "assistant", "user", "assistant", "user",
    ]
    assert streaming[-1]["content"] == _CURRENT


def test_non_chat_caller_gets_db_history():
    """API/webhook caller sent no messages → history rebuilt from the store."""
    def store_loader():
        # What gateway.routes.chat._get_messages would return, oldest→newest.
        return [
            {"role": "user", "content": "earlier turn"},
            {"role": "assistant", "content": "earlier answer"},
        ]

    out = assemble_run_context(
        system_context=_SYSTEM,
        history=[],                      # non-chat caller: no client store
        current_message="follow-up",
        model="tier-balanced",
        history_loader=store_loader,
    )
    contents = [m["content"] for m in out]
    assert "earlier turn" in contents and "earlier answer" in contents
    assert contents[-1] == "follow-up"


def test_current_turn_never_duplicated_across_paths():
    hist = [*_HISTORY, {"role": "user", "content": _CURRENT}]  # client included it
    out = assemble_run_context(
        system_context="", history=hist, current_message=_CURRENT, model="",
    )
    assert sum(1 for m in out if m["content"] == _CURRENT) == 1


def test_overlong_transcript_fits_the_window_not_a_count_cap():
    # 40 turns each ~4k chars ≈ 40k tokens — over tier-fast's 32k window.
    # A blind count cap (e.g. last-50) would let this overflow; the token fit
    # must bring it under budget.
    long_history = [
        {"role": "user" if i % 2 == 0 else "assistant", "content": "w" * 4000}
        for i in range(40)
    ]
    out = assemble_run_context(
        history=long_history, current_message="q",
        model="tier-fast", max_output_tokens=1024,
    )
    assert count_message_tokens(out, "tier-fast") <= context_window_for("tier-fast")

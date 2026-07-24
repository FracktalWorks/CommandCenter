"""Unit tests for the WhatsApp enrichment scheduler (W9) — the pure gate/interval
helpers + the single-cycle sweep (per-account error resilience). The while-loop
lifecycle is trivial and not exercised here."""

from __future__ import annotations

import gateway.routes.whatsapp.scheduler as sched

# ── pure gate + interval ──────────────────────────────────────────────────────

def test_enrichment_gate_off_by_default() -> None:
    assert sched.enrichment_enabled({}) is False
    assert sched.enrichment_enabled({"WHATSAPP_ENRICHMENT": "0"}) is False
    assert sched.enrichment_enabled({"WHATSAPP_ENRICHMENT": "off"}) is False


def test_enrichment_gate_on_forms() -> None:
    for v in ("1", "true", "TRUE", "yes", "on"):
        assert sched.enrichment_enabled({"WHATSAPP_ENRICHMENT": v}) is True


def test_resolve_interval_default_and_clamp() -> None:
    assert sched.resolve_interval(None) == 900          # default
    assert sched.resolve_interval("") == 900
    assert sched.resolve_interval("30") == 120          # clamped to the min
    assert sched.resolve_interval(1800) == 1800         # honored
    assert sched.resolve_interval("notanint") == 900    # bad → default


# ── single-cycle sweep ────────────────────────────────────────────────────────

async def test_cycle_sweeps_every_account_and_totals(monkeypatch) -> None:
    seen: list[str] = []

    async def _accounts():
        return ["a1", "a2"]

    async def _sum(aid):
        seen.append(f"sum:{aid}")
        return 2

    async def _tx(aid):
        seen.append(f"tx:{aid}")
        return 3

    async def _embed(aid):
        seen.append(f"emb:{aid}")
        return 1

    monkeypatch.setattr(sched, "_live_account_ids", _accounts)
    monkeypatch.setattr(sched, "_embed_account", _embed)
    monkeypatch.setattr(
        "gateway.routes.whatsapp.automation.groups.summarize_stale_groups", _sum)
    monkeypatch.setattr(
        "gateway.routes.whatsapp.automation.transcription.transcribe_pending", _tx)

    out = await sched.run_enrichment_cycle()
    assert out == {"accounts": 2, "summarized": 4, "transcribed": 6, "embedded": 2}
    assert seen == ["sum:a1", "tx:a1", "emb:a1", "sum:a2", "tx:a2", "emb:a2"]


async def test_cycle_resilient_to_per_account_failure(monkeypatch) -> None:
    async def _accounts():
        return ["good", "bad"]

    async def _sum(aid):
        if aid == "bad":
            raise RuntimeError("llm down")
        return 1

    async def _tx(aid):
        return 1

    async def _embed(aid):
        return 0

    monkeypatch.setattr(sched, "_live_account_ids", _accounts)
    monkeypatch.setattr(sched, "_embed_account", _embed)
    monkeypatch.setattr(
        "gateway.routes.whatsapp.automation.groups.summarize_stale_groups", _sum)
    monkeypatch.setattr(
        "gateway.routes.whatsapp.automation.transcription.transcribe_pending", _tx)

    out = await sched.run_enrichment_cycle()
    # 'bad' groups raised but was caught; both accounts still transcribed.
    assert out == {"accounts": 2, "summarized": 1, "transcribed": 2, "embedded": 0}


async def test_start_returns_false_when_disabled(monkeypatch) -> None:
    monkeypatch.delenv("WHATSAPP_ENRICHMENT", raising=False)
    started = await sched.start_whatsapp_enrichment()
    assert started is False
    assert sched._task is None

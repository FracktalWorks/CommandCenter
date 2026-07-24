"""Unit tests for WhatsApp semantic search (W10) — the pure embed-text / hash
helpers + the disabled-by-default query gate. The vector SQL (hybrid rank, the
byte-for-byte content_hash match) is exercised against real Postgres in the
migration smoke."""

from __future__ import annotations

import hashlib

from whatsapp_ingestion.wa_embeddings import (
    _content_hash,
    _embed_text,
    _hash_source,
    embed_query,
)


def test_embed_text_combines_body_and_transcript() -> None:
    out = _embed_text("Order status?", "kal AWB bhej dunga")
    assert "Order status?" in out
    assert "kal AWB bhej dunga" in out


def test_embed_text_is_bounded_and_stripped() -> None:
    out = _embed_text("  hi  ", None)
    assert out == "hi"                        # stripped, no dangling transcript
    big = _embed_text("x" * 9000, "y" * 9000)
    assert len(big) <= 4000                   # capped


def test_hash_source_matches_sql_coalesce_form() -> None:
    # MUST mirror: coalesce(body,'') || E'\n\n' || coalesce(transcript,'')
    # raw + unstripped, or the sweep re-embeds forever.
    assert _hash_source("a", "b") == "a\n\nb"
    assert _hash_source(None, None) == "\n\n"
    assert _hash_source("only body", None) == "only body\n\n"


def test_content_hash_is_sha256_hex() -> None:
    src = "a\n\nb"
    assert _content_hash(src) == hashlib.sha256(src.encode("utf-8")).hexdigest()


async def test_embed_query_none_when_disabled() -> None:
    # whatsapp_semantic_search_enabled defaults False → no network, returns None
    # so the search route falls back to pure lexical.
    assert await embed_query("anything") is None


async def test_embed_query_none_on_blank() -> None:
    assert await embed_query("   ") is None


def test_search_route_still_registered() -> None:
    from gateway.routes.whatsapp import router
    paths = {r.path for r in router.routes}
    assert "/whatsapp/search" in paths

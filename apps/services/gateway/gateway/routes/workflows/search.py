"""Semantic catalog search — the shared index behind the palette AND the
copilot (spec F3/D7 extension: with many agents, tools, and modules, finding
a capability must not require scrolling a tree).

One row per capability in ``workflow_catalog_index`` (migration 133).
``ensure_index_fresh`` lazily syncs it from the same live sources the catalog
endpoint serves (hash-keyed, so unchanged entries are never re-embedded) and
embeds via litellm's ``aembedding`` when an embedding provider is configured.
Scoring is hybrid: token/substring keyword score + cosine similarity, merged;
with no embedding provider the index degrades to keyword-only and says so in
the response (``semantic: false``) instead of silently pretending.

The copilot consumes ``search_catalog`` directly to shortlist capabilities
for its prompt — the same ranking a human sees in the palette.
"""

from __future__ import annotations

import hashlib
import json
import math
import os
import re
import time
from dataclasses import dataclass, field
from typing import Any

from acb_auth import UserContext, get_current_user
from fastapi import Depends
from gateway.routes.workflows.core import _get_db, _log, parse_jsonb, router
from sqlalchemy import text

#: Re-sync the index at most this often per process.
SYNC_INTERVAL_SECS = 60.0
#: Cap embeds per sync pass (a full first sync of a big catalog stays cheap).
MAX_EMBEDS_PER_SYNC = 64
DEFAULT_LIMIT = 20
MAX_LIMIT = 50

_last_sync: float = 0.0


@dataclass(slots=True)
class CatalogEntry:
    kind: str  # agent | tool | integration | module | node
    key: str
    label: str
    description: str
    category: str = ""
    embedding: list[float] | None = field(default=None, repr=False)

    @property
    def content_hash(self) -> str:
        text_val = f"{self.kind}\n{self.label}\n{self.description}\n{self.category}"
        return hashlib.sha256(text_val.encode("utf-8", errors="replace")).hexdigest()

    def embed_text(self) -> str:
        return f"{self.label} — {self.description}" if self.description else self.label


# ── Entry collection (same live sources as catalog.py) ──────────────────────


def collect_catalog_entries() -> list[CatalogEntry]:
    """Every searchable capability, from the registries the runtime uses."""
    from gateway.routes.workflows.catalog import (
        NODE_TYPE_META,
        _agent_entries,
        _integration_entries,
    )
    from gateway.routes.workflows.tools import list_tools

    entries: list[CatalogEntry] = []
    for meta in NODE_TYPE_META:
        entries.append(
            CatalogEntry(
                kind="node",
                key=str(meta["type"]),
                label=str(meta["label"]),
                description=str(meta["description"]),
                category=str(meta["category"]),
            )
        )
    for agent in _agent_entries():
        if not agent.get("name"):
            continue
        tags = ", ".join(str(t) for t in agent.get("tags") or [])
        entries.append(
            CatalogEntry(
                kind="agent",
                key=str(agent["name"]),
                label=str(agent["name"]),
                description=f"{agent.get('description') or ''} {tags}".strip(),
                category="agent",
            )
        )
    for spec in list_tools():
        entries.append(
            CatalogEntry(
                kind="tool",
                key=spec.action,
                label=spec.label,
                description=spec.description,
                category=spec.integration or "platform",
            )
        )
    for integration in _integration_entries():
        entries.append(
            CatalogEntry(
                kind="integration",
                key=str(integration["service"]),
                label=str(integration["service"]),
                description=(
                    "connected integration"
                    if integration.get("available")
                    else "integration (not configured yet)"
                ),
                category="integration",
            )
        )
    return entries


async def _module_entries(db: Any) -> list[CatalogEntry]:
    rows = (
        await db.execute(
            text(
                "SELECT id, name, description, status FROM workflow_modules "
                "WHERE status != 'disabled'"
            ),
        )
    ).fetchall()
    return [
        CatalogEntry(
            kind="module",
            key=str(r.id),
            label=r.name,
            description=r.description or "",
            category=r.status,
        )
        for r in rows
    ]


# ── Embeddings (best-effort; keyword-only degrade) ──────────────────────────


def _embedding_model() -> str | None:
    if os.environ.get("OPENAI_API_KEY", "").strip():
        return "text-embedding-3-small"
    if os.environ.get("GEMINI_API_KEY", "").strip():
        return "gemini/text-embedding-004"
    return None


async def embed_texts(texts: list[str]) -> tuple[list[list[float]] | None, str]:
    """Embed *texts*, or ``(None, "")`` when no provider / on failure."""
    model = _embedding_model()
    if not model or not texts:
        return None, ""
    try:
        from litellm import aembedding

        resp = await aembedding(model=model, input=texts)
        data = getattr(resp, "data", None) or resp.get("data", [])  # type: ignore[union-attr]
        vectors = [item["embedding"] if isinstance(item, dict) else item.embedding for item in data]
        if len(vectors) != len(texts):
            return None, ""
        return vectors, model
    except Exception as exc:
        _log.warning("workflows.embed_failed", error=str(exc)[:160])
        return None, ""


def cosine(a: list[float], b: list[float]) -> float:
    if not a or not b or len(a) != len(b):
        return 0.0
    dot = sum(x * y for x, y in zip(a, b, strict=False))
    norm = math.sqrt(sum(x * x for x in a)) * math.sqrt(sum(y * y for y in b))
    return dot / norm if norm else 0.0


# ── Index sync ──────────────────────────────────────────────────────────────


async def ensure_index_fresh(*, force: bool = False) -> None:
    """Upsert changed entries, embed what changed, drop stale rows.

    Debounced per process; every step is best-effort — search must keep
    working (keyword-only, live-collected) even if the index table is cold.
    """
    global _last_sync
    now = time.monotonic()
    if not force and now - _last_sync < SYNC_INTERVAL_SECS:
        return
    _last_sync = now
    try:
        db = await _get_db()
        try:
            entries = collect_catalog_entries() + await _module_entries(db)
            existing = {
                (r.kind, r.key): r.content_hash
                for r in (
                    await db.execute(
                        text("SELECT kind, key, content_hash FROM workflow_catalog_index"),
                    )
                ).fetchall()
            }
            live_keys = {(e.kind, e.key) for e in entries}
            changed = [e for e in entries if existing.get((e.kind, e.key)) != e.content_hash][
                :MAX_EMBEDS_PER_SYNC
            ]
            vectors, model = await embed_texts([e.embed_text() for e in changed])
            for i, entry in enumerate(changed):
                await db.execute(
                    text(
                        """INSERT INTO workflow_catalog_index
                           (kind, key, label, description, category,
                            content_hash, embedding, embed_model, updated_at)
                           VALUES (:kind, :key, :label, :description, :category,
                                   :hash, :embedding ::jsonb, :model, now())
                           ON CONFLICT (kind, key) DO UPDATE SET
                             label = EXCLUDED.label,
                             description = EXCLUDED.description,
                             category = EXCLUDED.category,
                             content_hash = EXCLUDED.content_hash,
                             embedding = EXCLUDED.embedding,
                             embed_model = EXCLUDED.embed_model,
                             updated_at = now()"""
                    ),
                    {
                        "kind": entry.kind,
                        "key": entry.key,
                        "label": entry.label,
                        "description": entry.description,
                        "category": entry.category,
                        "hash": entry.content_hash,
                        "embedding": json.dumps(vectors[i]) if vectors else None,
                        "model": model,
                    },
                )
            for kind, key in set(existing) - live_keys:
                await db.execute(
                    text("DELETE FROM workflow_catalog_index WHERE kind = :kind AND key = :key"),
                    {"kind": kind, "key": key},
                )
            await db.commit()
        finally:
            await db.close()
    except Exception as exc:
        _log.warning("workflows.index_sync_failed", error=str(exc)[:160])


# ── Scoring ─────────────────────────────────────────────────────────────────

_WORD_RE = re.compile(r"[a-z0-9]+")


def keyword_score(query: str, label: str, description: str) -> float:
    """Deterministic lexical score — the floor semantic search builds on."""
    q = query.lower().strip()
    if not q:
        return 0.0
    label_l, desc_l = label.lower(), description.lower()
    score = 0.0
    if q == label_l:
        score += 6.0
    elif q in label_l:
        score += 4.0
    elif q in desc_l:
        score += 1.5
    label_words = set(_WORD_RE.findall(label_l))
    desc_words = set(_WORD_RE.findall(desc_l))
    for token in _WORD_RE.findall(q):
        if token in label_words:
            score += 2.0
        elif any(token in w for w in label_words):
            score += 1.0
        elif token in desc_words:
            score += 0.75
        elif any(token in w for w in desc_words):
            score += 0.25
    return score


def merge_scores(kw: float, sim: float | None) -> float:
    """Hybrid rank: cosine (0..1) is scaled to compete with keyword hits."""
    return kw + (max(0.0, sim) * 5.0 if sim is not None else 0.0)


async def search_catalog(
    query: str,
    *,
    kinds: set[str] | None = None,
    limit: int = DEFAULT_LIMIT,
) -> dict[str, Any]:
    """Hybrid search over the capability index. Never raises."""
    await ensure_index_fresh()
    rows: list[Any] = []
    try:
        db = await _get_db()
        try:
            rows = (
                await db.execute(
                    text(
                        "SELECT kind, key, label, description, category, embedding "
                        "FROM workflow_catalog_index"
                    ),
                )
            ).fetchall()
        finally:
            await db.close()
    except Exception as exc:
        _log.warning("workflows.search_index_read_failed", error=str(exc)[:160])
    entries: list[CatalogEntry] = [
        CatalogEntry(
            kind=r.kind,
            key=r.key,
            label=r.label or "",
            description=r.description or "",
            category=r.category or "",
            embedding=parse_jsonb(r.embedding, None),
        )
        for r in rows
    ]
    if not entries:  # cold index — collect live, keyword-only
        try:
            entries = collect_catalog_entries()
        except Exception:
            entries = []

    query_vec: list[float] | None = None
    if any(e.embedding for e in entries):
        vectors, _model = await embed_texts([query])
        query_vec = vectors[0] if vectors else None

    results = []
    for entry in entries:
        if kinds and entry.kind not in kinds:
            continue
        kw = keyword_score(query, entry.label, entry.description)
        sim = cosine(query_vec, entry.embedding) if query_vec and entry.embedding else None
        score = merge_scores(kw, sim)
        threshold = 0.75 if sim is None else 0.9
        if score >= threshold:
            results.append(
                {
                    "kind": entry.kind,
                    "key": entry.key,
                    "label": entry.label,
                    "description": entry.description,
                    "category": entry.category,
                    "score": round(score, 3),
                }
            )
    results.sort(key=lambda r: -r["score"])
    return {
        "query": query,
        "semantic": query_vec is not None,
        "results": results[: max(1, min(limit, MAX_LIMIT))],
    }


# ── Endpoint ────────────────────────────────────────────────────────────────


@router.get("/catalog/search")
async def catalog_search(
    q: str = "",
    kinds: str = "",
    limit: int = DEFAULT_LIMIT,
    user: UserContext = Depends(get_current_user),
) -> dict[str, Any]:
    """Search the capability catalog (palette search + copilot shortlist)."""
    kind_set = {k.strip() for k in kinds.split(",") if k.strip()} or None
    if not q.strip():
        return {"query": q, "semantic": False, "results": []}
    return await search_catalog(q.strip(), kinds=kind_set, limit=limit)

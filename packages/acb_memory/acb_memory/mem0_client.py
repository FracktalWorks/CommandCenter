"""Mem0 episodic memory client — stores and retrieves per-user facts.

Design:
- Backend: Postgres + pgvector (reuses the existing CommandCenter Postgres;
  Mem0 creates its own 'mem0_memories' collection automatically).
- LLM for extraction: gateway /v1 via litellm SDK (same tier-1 model as agents use).
- Embedding: text-embedding-3-small via gateway /v1 (litellm SDK, cached).
- Graceful degradation: if MEM0_ENABLED=false or Postgres is unavailable,
  every function returns empty results — agents work normally.

Typical usage:
    context = await get_memory_context("user@fracktal.in", "status of deals")
    # → "Past memory: prefers CNTS-level breakdown, focuses on Delhi region"

    # After a conversation (non-blocking):
    asyncio.create_task(add_memories_background("user@fracktal.in", messages))
"""
from __future__ import annotations

import asyncio
import os
import re
from functools import lru_cache
from typing import Any

from acb_common import get_logger, get_settings

_log = get_logger("acb_memory.mem0")


class MemoryClient:
    """Thin wrapper around the mem0ai MemoryClient with lazy initialisation.

    Thread-safe: the underlying MemoryClient is synchronous and the public
    API is fully async (wrapped in asyncio.to_thread).
    """

    def __init__(self) -> None:
        self._client: Any | None = None

    def _get_client(self) -> Any | None:
        """Lazily build and cache the mem0 client.  Returns None when disabled."""
        if self._client is not None:
            return self._client

        settings = get_settings()
        if not getattr(settings, "mem0_enabled", False):
            return None

        try:
            # mem0ai ≥ 2.x: Memory = local/self-hosted (pgvector, SQLite, etc.)
            #                MemoryClient = cloud-hosted Mem0 SaaS — no from_config
            from mem0 import Memory as _Mem0Memory  # noqa: PLC0415

            db_url: str = settings.database_url
            # Parse postgres+psycopg:// → psycopg2-compatible pieces for Mem0's pgvector config
            # mem0ai expects plain host/port/dbname dict, not a SQLAlchemy URL.
            m = re.match(
                r"postgresql(?:\+\w+)?://([^:]+):([^@]*)@([^:/]+):?(\d+)?/(.+)",
                db_url,
            )
            if not m:
                _log.warning("mem0.bad_db_url", url=db_url[:40])
                return None

            pg_user, pg_pass, pg_host, pg_port, pg_db = m.groups()
            pg_port_int = int(pg_port) if pg_port else 5432

            litellm_url: str = settings.litellm_base_url
            litellm_key: str = settings.litellm_master_key

            # Resolve a working OpenAI-compatible endpoint for Mem0.
            # The gateway's /v1 is not a proxy — use provider APIs directly.
            # LLM: DeepSeek (free, works for fact extraction).
            # Embeddings: Groq (free tier, supports embedding models).
            ds_key = os.environ.get("DEEPSEEK_API_KEY", "").strip()
            gr_key = os.environ.get("GROQ_API_KEY", "").strip()
            if ds_key:
                _llm_url = "https://api.deepseek.com/v1"
                _llm_key = ds_key
                _llm_model = "deepseek-chat"
            else:
                _llm_url = litellm_url
                _llm_key = litellm_key
                _llm_model = "tier-fast"
            if gr_key:
                _emb_url = "https://api.groq.com/openai/v1"
                _emb_key = gr_key
            else:
                _emb_url = _llm_url
                _emb_key = _llm_key

            config: dict[str, Any] = {
                "vector_store": {
                    "provider": "pgvector",
                    "config": {
                        "host": pg_host,
                        "port": pg_port_int,
                        "dbname": pg_db,
                        "user": pg_user,
                        "password": pg_pass,
                        "collection_name": "mem0_memories",
                    },
                },
                "llm": {
                    "provider": "openai",
                    "config": {
                        "model": _llm_model,
                        "api_key": _llm_key,
                        "openai_base_url": _llm_url,
                    },
                },
                "embedder": {
                    "provider": "openai",
                    "config": {
                        "model": "text-embedding-3-small",
                        "api_key": _emb_key,
                        "openai_base_url": _emb_url,
                        # Groq API doesn't support OpenAI's "dimensions"
                        # parameter — omit it and rely on the model default.
                    },
                },
                # Store raw history in Postgres too (optional, for audit)
                "history_db_path": "",  # empty = in-memory; set to a path for SQLite
            }

            self._client = _Mem0Memory.from_config(config_dict=config)
            _log.info("mem0.client_ready", backend="pgvector")
            return self._client

        except ImportError as exc:
            _log.warning(
                "mem0.not_installed",
                hint="pip install mem0ai",
                error=str(exc)[:200],
            )
            return None
        except Exception as exc:  # noqa: BLE001
            _log.warning("mem0.init_failed", error=str(exc)[:200])
            return None

    # ------------------------------------------------------------------
    # Public async API
    # ------------------------------------------------------------------

    async def search(self, user_id: str, query: str, limit: int = 8) -> list[dict]:
        """Return memories relevant to *query* for *user_id*.

        Returns [] on any error (graceful degradation).
        """
        client = self._get_client()
        if client is None:
            return []
        try:
            def _sync() -> list[dict]:
                # Memory.search() uses filters dict, not user_id kwarg directly
                results = client.search(
                    query=query,
                    top_k=limit,
                    filters={"user_id": user_id},
                )
                if isinstance(results, dict):
                    return results.get("results", [])
                return list(results) if results else []

            return await asyncio.to_thread(_sync)
        except Exception as exc:  # noqa: BLE001
            _log.debug("mem0.search_error", user_id=user_id[:20], error=str(exc)[:100])
            return []

    async def add(
        self,
        user_id: str,
        messages: list[dict[str, str]],
        agent_id: str = "orchestrator",
    ) -> None:
        """Extract and persist facts from *messages* for *user_id*.

        Non-blocking — designed to be called in a background task.
        """
        client = self._get_client()
        if client is None or not messages:
            return
        try:
            def _sync() -> None:
                client.add(messages, user_id=user_id, agent_id=agent_id)

            await asyncio.to_thread(_sync)
            _log.info("mem0.facts_added", user_id=user_id[:20], msg_count=len(messages))
        except Exception as exc:  # noqa: BLE001
            _log.warning("mem0.add_failed", user_id=user_id[:20], error=str(exc)[:200])

    async def get_all(self, user_id: str) -> list[dict]:
        """Return all stored memories for *user_id* (for the UI memory panel)."""
        client = self._get_client()
        if client is None:
            return []
        try:
            def _sync() -> list[dict]:
                # Memory.get_all() uses filters dict, not user_id kwarg directly
                results = client.get_all(filters={"user_id": user_id})
                if isinstance(results, dict):
                    return results.get("results", [])
                return list(results) if results else []

            return await asyncio.to_thread(_sync)
        except Exception as exc:  # noqa: BLE001
            _log.debug("mem0.get_all_error", error=str(exc)[:100])
            return []

    async def delete(self, memory_id: str) -> None:
        """Delete a single memory by ID."""
        client = self._get_client()
        if client is None:
            return
        try:
            await asyncio.to_thread(client.delete, memory_id=memory_id)
        except Exception as exc:  # noqa: BLE001
            _log.debug("mem0.delete_error", error=str(exc)[:100])


@lru_cache(maxsize=1)
def get_memory_client() -> MemoryClient:
    """Return the singleton MemoryClient."""
    return MemoryClient()


async def get_memory_context(user_id: str, query: str) -> str:
    """Return a formatted memory context string for injection into agent prompts.

    Returns empty string when Mem0 is disabled or no memories match.

    Example output:
        "Past memory (use for continuity):\\n"
        "- Vijay prefers CNTS-stage deal summaries\\n"
        "- Focus on Delhi NCR region for sales prospecting\\n"
    """
    if not user_id:
        return ""
    memories = await get_memory_client().search(user_id, query)
    if not memories:
        return ""
    lines = []
    for m in memories:
        fact = m.get("memory") or m.get("text") or str(m)
        if fact:
            lines.append(f"- {fact.strip()}")
    if not lines:
        return ""
    return "Past memory (use for continuity):\n" + "\n".join(lines)


async def add_memories_background(
    user_id: str,
    messages: list[dict[str, str]],
    agent_id: str = "orchestrator",
) -> None:
    """Fire-and-forget memory extraction.  Safe to call without awaiting.

    Typical usage (in gateway after a run completes):
        asyncio.create_task(add_memories_background(user_id, messages))
    """
    await get_memory_client().add(user_id, messages, agent_id=agent_id)

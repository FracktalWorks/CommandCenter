"""acb_memory — Mem0 episodic memory + Graphiti bi-temporal KG.

Two memory layers:
- Mem0   : per-user episodic facts extracted from conversations.
           Uses our existing Postgres + pgvector (no new infra).
- Graphiti: bi-temporal entity knowledge graph.
           Uses Neo4j (see infra/docker-compose.yml).
           Feature-flagged via GRAPHITI_ENABLED=true.

Both are *optional* — if not configured, every public function returns a
graceful empty result and the agents work normally without memory.
"""
from acb_memory.mem0_client import (
    MemoryClient,
    get_memory_client,
    get_memory_context,
    add_memories_background,
)
from acb_memory.graphiti_client import (
    GraphitiClient,
    get_graphiti_client,
    search_entity_timeline,
    add_episode,
)

__all__ = [
    "MemoryClient",
    "get_memory_client",
    "get_memory_context",
    "add_memories_background",
    "GraphitiClient",
    "get_graphiti_client",
    "search_entity_timeline",
    "add_episode",
]

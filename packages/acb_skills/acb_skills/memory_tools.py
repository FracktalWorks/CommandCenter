"""memory_tools — agent-callable tools for active memory read/write.

Auto-injected into every agent alongside ``web_search`` and ``call_agent``.

These tools give agents ACTIVE control over the CommandCenter memory systems:

READ tools (query what CommandCenter knows):
- remember(query) → str
    Search Mem0 episodic memory for relevant past facts about the current user.
    Returns formatted facts the agent can use for continuity.

- recall_timeline(entity_name, query) → str
    Search the Graphiti bi-temporal knowledge graph for time-stamped facts about
    an entity (person, deal, project, company).  Returns timestamped history.

WRITE tools (persist important information):
- save_memory(fact) → str
    Explicitly save a single fact to Mem0 episodic memory for the current user.
    Use when you learn something important about the user that should be remembered.

- save_episode(name, content, source?) → str
    Add an episode to the Graphiti bi-temporal knowledge graph.  Graphiti will
    automatically extract entities, relationships, and timestamps from the content.

Why agents need these:
    Without active tools, memory is passive — the platform enriches the prompt
    before each run but the agent cannot query or write on demand.  These tools
    let agents say "let me check what I know about this customer" or "I should
    remember that this user prefers X."

Usage by agents:
    facts = await remember("Vijay's reporting preferences")
    timeline = await recall_timeline("ABC Corp", "deal stage changes")
    await save_memory("Vijay prefers weekly summaries on Monday mornings")
    await save_episode("Deal closed", "ABC Corp deal worth ₹50L closed today", source="agent-sales")
"""
from __future__ import annotations

import contextvars

from acb_common import get_logger

_log = get_logger("acb_skills.memory_tools")

# ContextVar set by the gateway route before each agent run so the memory
# tools know which user's memory to query / write.  Cleared after the run.
_memory_user_id: contextvars.ContextVar[str] = contextvars.ContextVar(
    "_memory_user_id", default=""
)


def _set_memory_user_id(user_id: str) -> None:
    """Set the current user ID for memory tool operations.

    Called by the gateway route handler before dispatching an agent run.
    The memory tools (remember, save_memory, save_episode) read this
    context var to determine whose memory to operate on.
    """
    _memory_user_id.set(user_id or "")


def _get_memory_user_id() -> str:
    """Return the current user ID, or empty string if not set."""
    return _memory_user_id.get()


async def remember(query: str) -> str:
    """Search episodic memory for facts about the current user related to *query*.

    Uses Mem0 (Postgres + pgvector) to find semantically relevant facts from
    all past conversations with this user.  Call this BEFORE making claims about
    the user's preferences, history, or context.

    Args:
        query: What to search for in natural language.
               E.g. "reporting preferences", "pricing discussions", "contact history"

    Returns:
        Formatted facts like "- Vijay prefers weekly Monday reports", or
        "(no relevant memories found)" if nothing matches or Mem0 is disabled.

    Examples:
        facts = await remember("Vijay's preferred communication channel")
        facts = await remember("ABC Corp deal status and contacts")
    """
    try:
        from acb_memory import get_memory_context  # noqa: PLC0415

        user_id = _get_memory_user_id()
        if not user_id:
            _log.debug("memory_tools.remember_no_user_id")
            return "(memory system unavailable — no user context)"

        result = await get_memory_context(user_id, query)
        return result if result else "(no relevant memories found)"
    except ImportError:
        return "(memory system not installed — ask operator to enable Mem0)"
    except Exception as exc:  # noqa: BLE001
        _log.warning("memory_tools.remember_failed", error=str(exc)[:200])
        return f"(memory search failed: {exc})"


async def recall_timeline(entity_name: str, query: str) -> str:
    """Search the bi-temporal knowledge graph for time-stamped facts about an entity.

    Uses Graphiti (Neo4j) to find WHEN things happened — entity stage changes,
    action history, relationship timelines.  Much richer than episodic memory
    for answering "when did X happen?" or "what's the history of Y?"

    Args:
        entity_name: Name of the entity (person, company, deal, project).
        query:       What aspect of the timeline to focus on.
                     E.g. "deal stage changes", "meeting history", "follow-ups"

    Returns:
        Timestamped facts like:
        "2026-05-12: Deal Fracktal-ABC moved to Awaiting PO [source: agent-sales]"
        "2026-05-28: Follow-up sent by Vijay after 16 days stale"
        Returns "(no timeline facts found)" if Graphiti is disabled or nothing matches.

    Examples:
        history = await recall_timeline("ABC Corp", "all deal stage changes")
        history = await recall_timeline("Rahul Kumar", "meetings and follow-ups")
    """
    try:
        from acb_memory import search_entity_timeline  # noqa: PLC0415

        result = await search_entity_timeline(entity_name, query)
        return result if result else "(no timeline facts found)"
    except ImportError:
        return "(knowledge graph not installed — ask operator to enable Graphiti)"
    except Exception as exc:  # noqa: BLE001
        _log.warning("memory_tools.recall_timeline_failed", error=str(exc)[:200])
        return f"(timeline search failed: {exc})"


async def save_memory(fact: str) -> str:
    """Explicitly save a single fact to episodic memory for the current user.

    Uses Mem0 to persist a fact that will be retrieved in future conversations.
    Call this when you learn something important about the user that should
    carry forward to future interactions.

    Mem0 handles deduplication, updates (facts evolve over time), and
    semantic retrieval automatically.

    Args:
        fact: A single, self-contained fact about the user.
              E.g. "Prefers weekly Monday morning reports in bullet-point format"
              E.g. "Primary contact at ABC Corp is Rahul Kumar (rahul@abc.com)"

    Returns:
        "Memory saved." on success, or an error description on failure.

    Examples:
        await save_memory("Vijay wants all financial figures in INR lakhs, not crores")
        await save_memory("ABC Corp prefers communication via WhatsApp, not email")
    """
    try:
        from acb_memory import add_memories_background  # noqa: PLC0415

        user_id = _get_memory_user_id()
        if not user_id:
            _log.debug("memory_tools.save_memory_no_user_id")
            return "(cannot save memory — no user context)"

        # Mem0 expects message-format input for fact extraction.
        messages = [
            {"role": "user", "content": f"Remember this fact about me: {fact}"},
            {"role": "assistant", "content": f"I'll remember: {fact}"},
        ]
        await add_memories_background(user_id, messages, agent_id="memory_tool")
        _log.info("memory_tools.save_memory_ok",
                  user_id=user_id[:20], fact=fact[:80])
        return "Memory saved."
    except ImportError:
        return "(memory system not installed — ask operator to enable Mem0)"
    except Exception as exc:  # noqa: BLE001
        _log.warning("memory_tools.save_memory_failed", error=str(exc)[:200])
        return f"(failed to save memory: {exc})"


async def save_episode(
    name: str,
    content: str,
    source: str = "agent",
) -> str:
    """Record an episode in the bi-temporal knowledge graph.

    Uses Graphiti to extract entities, relationships, and timestamps from
    the content.  Future ``recall_timeline`` calls on the mentioned entities
    will include this episode.

    Call this when significant events occur that should be queryable by time:
    - A deal changes stage
    - A meeting produces action items
    - A customer's status changes
    - A project milestone is reached

    Args:
        name:    Short label, e.g. "Deal ABC moved to Negotiation"
        content: Full description. Graphiti extracts entities + relationships.
        source:  Origin label, e.g. "agent-sales", "agent-delivery".
                 Defaults to "agent".

    Returns:
        "Episode recorded." on success, or an error description on failure.

    Examples:
        await save_episode(
            "Deal closed",
            "ABC Corp signed the PO worth ₹50L for 10 Fracktal Works printers. Contact: Rahul Kumar.",
            source="agent-sales",
        )
        await save_episode(
            "Meeting follow-up",
            "Meeting with Delhi NCR prospects on June 14. Action items: send quotes to 3 companies.",
            source="agent-meeting-notes",
        )
    """
    try:
        from acb_memory import add_episode  # noqa: PLC0415

        user_id = _get_memory_user_id() or "default"

        await add_episode(
            name=name,
            content=content,
            source_description=source,
            group_id=user_id,
        )
        _log.info(
            "memory_tools.save_episode_ok",
            name=name[:60],
            source=source,
        )
        return "Episode recorded."
    except ImportError:
        return "(knowledge graph not installed — ask operator to enable Graphiti)"
    except Exception as exc:  # noqa: BLE001
        _log.warning("memory_tools.save_episode_failed", error=str(exc)[:200])
        return f"(failed to record episode: {exc})"

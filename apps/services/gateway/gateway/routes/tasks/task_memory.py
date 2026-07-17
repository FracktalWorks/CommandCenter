"""Tasks · task_memory — the task-manager's own clarification memory (§9, Phase 4).

A DEDICATED agent-scoped memory for the task manager: it learns from the
decisions the user actually commits (how a kind of task was disposed, who owned
it, which project it landed in) and recalls those patterns the next time a
similar task is clarified — so the clarify engine gets more consistent with the
user's real habits over time ("clarify tasks + fill next-action detail from
memory").

Scope: ``scope_key(agent="task-manager")`` — the existing cross-user
``agent:<name>`` Mem0 partition (mem0_memories, pgvector). No new store. Both
functions are BEST-EFFORT and graceful: when Mem0 is disabled/unavailable they
recall "" and remember nothing, so clarify/organize never break or slow down on
a memory hiccup.

Write hygiene (from the ASG protocol): we save the COMMITTED decision (the real
outcome), not the proposal — the memory reflects what the user chose, which is
the signal worth learning. Recall routing: one bounded Mem0 search fed as
continuity context into the clarify prompt, only on the LLM path (which is
already spending a round-trip).
"""

from __future__ import annotations

import asyncio

from acb_common import get_logger

_log = get_logger("gateway.tasks.task_memory")

# The agent whose shared memory the task manager reads/writes. Matches the
# apps/agents/agent-task-manager name so the app-side clarify memory and the
# agent's own recall_agent/save_agent_memory land in the SAME partition.
_AGENT = "task-manager"


async def recall_clarify_context(task_text: str) -> str:
    """A short memory block of past clarification patterns relevant to this task,
    for injection into the clarify prompt. "" when Mem0 is off, nothing matches,
    or anything fails (the caller degrades to no-memory clarify)."""
    text = (task_text or "").strip()
    if not text:
        return ""
    try:
        from acb_memory import get_scoped_context, scope_key
        return await get_scoped_context(
            scope_key(agent=_AGENT), text,
            header="Past clarification patterns")
    except Exception as exc:  # noqa: BLE001
        _log.debug("tasks.memory.recall_failed", error=str(exc)[:160])
        return ""


def _decision_fact(
    *, title: str, disposition: str, next_action: str | None,
    owner: str | None, project: str | None, context: str | None,
) -> str:
    """One compact, self-contained sentence describing a committed decision — the
    fact Mem0 extracts and later recalls. Kept declarative so recall reads as
    guidance ('tasks like X → owner Y')."""
    bits = [f'The task "{title.strip()}" was filed as {disposition}']
    if owner:
        bits.append(f"owned by {owner}")
    if project:
        bits.append(f"under project {project}")
    if context:
        bits.append(f"context {context}")
    line = ", ".join(bits) + "."
    if next_action and next_action.strip() and next_action.strip() != title.strip():
        line += f' Its next action was "{next_action.strip()}".'
    return line


async def remember_decision(
    *, title: str, disposition: str, next_action: str | None = None,
    owner: str | None = None, project: str | None = None,
    context: str | None = None,
) -> None:
    """Record a committed clarify/organize decision into the task-manager's agent
    memory (fire-and-forget, best-effort). No-op when Mem0 is off or the title is
    empty. Safe to call without awaiting — swallows every error."""
    if not (title or "").strip():
        return
    try:
        from acb_memory import add_scoped_memories, scope_key
        fact = _decision_fact(
            title=title, disposition=disposition, next_action=next_action,
            owner=owner, project=project, context=context)
        await add_scoped_memories(
            scope_key(agent=_AGENT),
            [{"role": "user", "content": fact}], agent_id=_AGENT)
    except Exception as exc:  # noqa: BLE001
        _log.debug("tasks.memory.remember_failed", error=str(exc)[:160])


def remember_decision_background(**kwargs) -> None:
    """Schedule ``remember_decision`` without blocking the request. Falls back to
    a direct await-less call when there's no running loop (best-effort)."""
    try:
        asyncio.get_running_loop().create_task(remember_decision(**kwargs))
    except RuntimeError:
        # No running loop — nothing to schedule onto; drop it (memory is
        # advisory, never worth blocking or erroring the caller).
        _log.debug("tasks.memory.no_loop")

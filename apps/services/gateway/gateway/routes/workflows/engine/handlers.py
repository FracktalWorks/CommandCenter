"""One handler per node *type* (RFC §6.3) over injected NodeServices.

Handlers are pure orchestration: they resolve ``{{…}}`` templates against the
run state, call the injected service seam, and return the node's output dict.
The gateway wires real services (orchestrator ``run_agent``, the workflow tool
registry, the module store) in ``service.py``; tests wire stubs.
"""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any

from gateway.routes.workflows.engine.modules import run_module_code
from gateway.routes.workflows.engine.templating import resolve_value

#: Waits at or below this run INLINE (the run holds its slot and sleeps);
#: anything longer pauses the run and resumes from a snapshot, so a long wait
#: survives a gateway restart instead of evaporating with the process.
WAIT_INLINE_MAX_SECONDS = 60.0
#: Upper bound on a single wait — a typo ("wait 90000000") should fail at
#: publish, not park a run past the heat death of the quarter.
MAX_WAIT_SECONDS = 30 * 86400

#: Per-node wall-clock budgets (seconds), by node type.
NODE_TIMEOUTS: dict[str, float] = {
    "agent": 600.0,
    "tool": 120.0,
    "module": 15.0,
    "condition": 5.0,
    "set": 5.0,
    "approval": 5.0,
    # An inline wait sleeps inside the node; the budget must clear it.
    "wait": WAIT_INLINE_MAX_SECONDS + 10.0,
    "output": 5.0,
    "trigger": 5.0,
}
DEFAULT_NODE_TIMEOUT = 60.0


class NodeExecutionError(Exception):
    """A node failed; the message is safe to surface in the run console."""


@dataclass(slots=True)
class NodeServices:
    """The seams a running workflow may touch — injected, never imported.

    ``run_agent(agent, message, model)`` → final text.
    ``run_tool(action, args, actor)``    → tool result dict (the workflow tool
                                           registry decides broker routing).
    ``get_module_code(module_id)``       → validated module source or None.
    """

    run_agent: Callable[[str, str, str | None], Awaitable[str]]
    run_tool: Callable[[str, dict[str, Any], str], Awaitable[dict[str, Any]]]
    get_module_code: Callable[[str], Awaitable[str | None]]
    actor: str = "workflow"
    #: Extra context merged into agent messages' metadata (reserved).
    context: dict[str, Any] = field(default_factory=dict)


# ── Condition evaluation (no eval(), a closed operator set) ─────────────────

_NUMERIC_OPS = {"gt", "gte", "lt", "lte"}


def _as_number(value: Any) -> float:
    if isinstance(value, bool):
        return 1.0 if value else 0.0
    if isinstance(value, (int, float)):
        return float(value)
    try:
        return float(str(value).strip())
    except (TypeError, ValueError):
        raise NodeExecutionError(f"'{value}' is not a number") from None


def evaluate_condition(left: Any, op: str, right: Any) -> bool:
    """The closed comparison vocabulary behind the condition node."""
    op = (op or "").strip()
    if op == "equals":
        return str(left) == str(right) if not isinstance(left, type(right)) else left == right
    if op == "not_equals":
        return not evaluate_condition(left, "equals", right)
    if op == "contains":
        if isinstance(left, (list, dict)):
            return right in left
        return str(right) in str(left or "")
    if op == "not_contains":
        return not evaluate_condition(left, "contains", right)
    if op in _NUMERIC_OPS:
        ln, rn = _as_number(left), _as_number(right)
        return {"gt": ln > rn, "gte": ln >= rn, "lt": ln < rn, "lte": ln <= rn}[op]
    if op == "is_empty":
        return left is None or left == "" or left == [] or left == {}
    if op == "not_empty":
        return not evaluate_condition(left, "is_empty", right)
    if op == "truthy":
        return bool(left)
    raise NodeExecutionError(f"unknown condition operator '{op}'")


def resolve_wait_seconds(config: dict[str, Any], state: dict[str, Any]) -> float:
    """A wait node's duration, with ``{{refs}}`` resolved against the state.

    Shared by the runner (which decides inline-vs-pause BEFORE calling the
    handler) and the handler itself, so both read one duration.
    """
    raw = resolve_value(config.get("seconds"), state)
    try:
        seconds = float(raw)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        raise NodeExecutionError(f"wait duration '{raw}' is not a number") from None
    if seconds < 0:
        raise NodeExecutionError("wait duration must be positive")
    return min(seconds, float(MAX_WAIT_SECONDS))


# ── Node handlers ────────────────────────────────────────────────────────────


async def execute_node(
    block: dict[str, Any],
    state: dict[str, Any],
    services: NodeServices,
) -> dict[str, Any]:
    """Run one block against the shared *state*; return its output dict.

    The output is what downstream ``{{node_id.field}}`` refs see. Condition
    outputs carry ``branch`` (``"true"``/``"false"``) for edge routing.
    """
    ntype = str(block.get("type") or "")
    config = block.get("config") or {}
    if ntype == "trigger":
        # State was seeded with the trigger payload before the run started.
        return dict(state.get("trigger") or {})

    if ntype == "agent":
        agent = str(resolve_value(config.get("agent"), state) or "").strip()
        message = str(resolve_value(config.get("message"), state) or "").strip()
        model = str(config.get("model") or "").strip() or None
        if not agent or not message:
            raise NodeExecutionError("agent node needs an agent and a message")
        text = await services.run_agent(agent, message, model)
        return {"result": text}

    if ntype == "tool":
        action = str(config.get("action") or "").strip()
        raw_args = config.get("args") if isinstance(config.get("args"), dict) else {}
        args = resolve_value(raw_args, state)
        if not action:
            raise NodeExecutionError("tool node needs an action")
        return await services.run_tool(action, args, services.actor)

    if ntype == "module":
        module_id = str(config.get("module_id") or "").strip()
        raw_inputs = config.get("inputs") if isinstance(config.get("inputs"), dict) else {}
        inputs = resolve_value(raw_inputs, state)
        code = await services.get_module_code(module_id)
        if not code:
            raise NodeExecutionError("module not found or not ready")
        return await run_module_code(code, inputs)

    if ntype == "condition":
        left = resolve_value(config.get("left"), state)
        right = resolve_value(config.get("right"), state)
        result = evaluate_condition(left, str(config.get("op") or ""), right)
        return {"result": result, "branch": "true" if result else "false"}

    if ntype == "set":
        assignments = (
            config.get("assignments") if isinstance(config.get("assignments"), dict) else {}
        )
        resolved = {str(k): resolve_value(v, state) for k, v in assignments.items()}
        vars_bucket = state.setdefault("vars", {})
        if isinstance(vars_bucket, dict):
            vars_bucket.update(resolved)
        return resolved

    if ntype == "approval":
        # The runner pauses unresolved approvals before this handler runs;
        # reaching it means a human approved — pass through.
        return {"approved": True, "message": str(config.get("message") or "")}

    if ntype == "wait":
        # Only two ways to reach this handler, and only one of them sleeps:
        #   short wait  → the runner chose the INLINE path; serve the time here
        #   long wait   → it already served its time as a paused run, and the
        #                 scheduler resumed it; returning immediately is the
        #                 whole point (never wait twice).
        seconds = resolve_wait_seconds(config, state)
        if 0 < seconds <= WAIT_INLINE_MAX_SECONDS:
            await asyncio.sleep(seconds)
        return {"waited_seconds": seconds}

    if ntype == "output":
        value = resolve_value(config.get("value"), state)
        return {"value": value}

    raise NodeExecutionError(f"unknown node type '{ntype}'")

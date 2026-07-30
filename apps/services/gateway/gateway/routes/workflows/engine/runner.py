"""Compile the serialized run-model to a MAF workflow and execute it (RFC §6).

The engine is a compile target, not a scheduler: each block becomes a MAF
``FunctionExecutor`` closing over one shared run-state dict (the ``{{…}}``
state bus — RFC §6.4's shared-state bridge), each connection becomes an edge,
and condition branches become conditional edges keyed on the token's branch.
MAF's superstep scheduler does the routing, fan-out, and completion detection.

Per-node lifecycle events go to an injected ``emit`` callback so the transport
layer (SSE, persistence) stays out of the engine.
"""

from __future__ import annotations

import asyncio
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

from agent_framework import WorkflowBuilder, WorkflowContext, executor
from gateway.routes.workflows.engine.handlers import (
    DEFAULT_NODE_TIMEOUT,
    NODE_TIMEOUTS,
    NodeExecutionError,
    NodeServices,
    execute_node,
)

#: Overall wall-clock budget for one run.
RUN_TIMEOUT_SECS = 15 * 60.0

EmitFn = Callable[[str, str, dict[str, Any]], None]
"""emit(node_id, status, detail) — status: running | ok | error | waiting |
skipped | pending."""


@dataclass(slots=True)
class RunOutcome:
    status: str  # succeeded | failed | paused
    state: dict[str, Any]  # final merged run state (node outputs)
    node_results: dict[str, Any]  # node_id → {status, output|error, duration_ms}
    outputs: list[Any]  # values yielded by output nodes
    error: str | None = None
    #: Approval nodes that halted their branch this run (status == "paused").
    paused_nodes: list[str] = field(default_factory=list)


@dataclass(slots=True)
class _Token:
    """The message routed along edges; data travels via the shared state."""

    branch: str | None = None


class _NodeFailure(Exception):
    def __init__(self, node_id: str, message: str):
        self.node_id = node_id
        self.message = message
        super().__init__(f"{node_id}: {message}")


def _noop_emit(node_id: str, status: str, detail: dict[str, Any]) -> None:
    return None


async def execute_workflow(
    serialized: dict[str, Any],
    trigger_payload: dict[str, Any],
    services: NodeServices,
    *,
    variables: dict[str, Any] | None = None,
    emit: EmitFn | None = None,
    run_timeout: float = RUN_TIMEOUT_SECS,
    precomputed: dict[str, Any] | None = None,
    resolved_approvals: set[str] | None = None,
) -> RunOutcome:
    """Execute one compiled workflow version against a trigger payload.

    *precomputed* replays a paused run: node ids mapped to their prior
    outputs pass through instantly (emitted as cached ``ok``) so resume
    re-walks the graph without re-running side effects.
    *resolved_approvals* names approval nodes a human has approved — any
    other approval node PAUSES its branch (outcome status ``paused``).
    """
    emit = emit or _noop_emit
    precomputed = precomputed or {}
    resolved_approvals = resolved_approvals or set()
    paused_nodes: list[str] = []
    blocks: list[dict[str, Any]] = list(serialized.get("blocks") or [])
    connections: list[dict[str, Any]] = list(serialized.get("connections") or [])
    entry_id = str(serialized.get("entry") or "")
    by_id = {str(b["id"]): b for b in blocks}
    if entry_id not in by_id:
        return RunOutcome(
            status="failed",
            state={},
            node_results={},
            outputs=[],
            error="compiled workflow has no entry block",
        )

    # The shared state bus: node outputs keyed by node id + reserved roots.
    state: dict[str, Any] = {
        "trigger": dict(trigger_payload or {}),
        "vars": dict(variables or {}),
    }
    node_results: dict[str, Any] = {}
    outputs: list[Any] = []
    has_outgoing = {str(c.get("source")) for c in connections}

    def _make_executor(block: dict[str, Any]) -> Any:
        node_id = str(block["id"])
        ntype = str(block.get("type") or "")
        timeout = NODE_TIMEOUTS.get(ntype, DEFAULT_NODE_TIMEOUT)
        terminal = node_id not in has_outgoing

        @executor(id=node_id)
        async def _run(token: _Token, ctx: WorkflowContext[_Token, Any]) -> None:
            # Resume replay: a node that already ran passes its stored output
            # through without re-executing (no repeated side effects).
            if node_id in precomputed:
                output = precomputed[node_id]
                state[node_id] = output
                node_results[node_id] = {"status": "ok", "output": output, "cached": True}
                emit(node_id, "ok", {"output": output, "cached": True})
                await _forward_cached(ctx, ntype, output, outputs)
                return

            # Human approval gate: unless a human resolved THIS node, the
            # branch stops here — nothing downstream runs (spec F11).
            if ntype == "approval" and node_id not in resolved_approvals:
                paused_nodes.append(node_id)
                node_results[node_id] = {"status": "waiting"}
                emit(node_id, "waiting", {"type": ntype})
                return

            emit(node_id, "running", {"type": ntype})
            started = time.monotonic()
            try:
                output = await asyncio.wait_for(
                    execute_node(block, state, services),
                    timeout=timeout,
                )
            except TimeoutError:
                message = f"timed out after {timeout:.0f}s"
                node_results[node_id] = {"status": "error", "error": message}
                emit(node_id, "error", {"error": message})
                raise _NodeFailure(node_id, message) from None
            except NodeExecutionError as exc:
                node_results[node_id] = {"status": "error", "error": str(exc)}
                emit(node_id, "error", {"error": str(exc)})
                raise _NodeFailure(node_id, str(exc)) from exc
            except _NodeFailure:
                raise
            except Exception as exc:  # unexpected — still a clean node failure
                message = f"{type(exc).__name__}: {exc}"
                node_results[node_id] = {"status": "error", "error": message[:500]}
                emit(node_id, "error", {"error": message[:500]})
                raise _NodeFailure(node_id, message[:500]) from exc

            duration_ms = int((time.monotonic() - started) * 1000)
            state[node_id] = output
            node_results[node_id] = {
                "status": "ok",
                "output": output,
                "duration_ms": duration_ms,
            }
            emit(node_id, "ok", {"output": output, "duration_ms": duration_ms})
            if ntype == "output":
                outputs.append(output.get("value"))
                await ctx.yield_output(output.get("value"))
            branch = output.get("branch") if isinstance(output, dict) else None
            await ctx.send_message(_Token(branch=branch if isinstance(branch, str) else None))
            if terminal and ntype != "output":
                await ctx.yield_output(output)

        return _run

    executors = {str(b["id"]): _make_executor(b) for b in blocks}

    # Only output-type and terminal blocks ever yield_output (see _run above);
    # designate them explicitly (the implicit mode is deprecated).
    yielding = [
        executors[str(b["id"])]
        for b in blocks
        if str(b.get("type")) == "output" or str(b["id"]) not in has_outgoing
    ]
    builder = WorkflowBuilder(
        start_executor=executors[entry_id],
        output_from=yielding or [executors[entry_id]],
    )
    for conn in connections:
        src, tgt = str(conn.get("source")), str(conn.get("target"))
        handle = conn.get("handle")
        if src not in executors or tgt not in executors:
            continue
        if handle in ("true", "false"):
            builder.add_edge(
                executors[src],
                executors[tgt],
                condition=_branch_condition(handle),
            )
        else:
            builder.add_edge(executors[src], executors[tgt])
    workflow = builder.build()

    error = await _run_compiled(workflow, run_timeout)
    paused = bool(paused_nodes) and not error
    # Nodes that never ran: "pending" while paused (they run on resume),
    # "skipped" on a finished run (untaken branch / after a failure).
    _mark_unrun(by_id, node_results, emit, "pending" if paused else "skipped")
    return RunOutcome(
        status="failed" if error else ("paused" if paused else "succeeded"),
        state=state,
        node_results=node_results,
        outputs=outputs,
        error=error,
        paused_nodes=paused_nodes,
    )


async def _forward_cached(
    ctx: Any, ntype: str, output: Any, outputs: list[Any]
) -> None:
    """Route a replayed node's stored output onward (yield + branch token)."""
    if ntype == "output":
        value = output.get("value") if isinstance(output, dict) else output
        outputs.append(value)
        await ctx.yield_output(value)
    branch = output.get("branch") if isinstance(output, dict) else None
    await ctx.send_message(_Token(branch=branch if isinstance(branch, str) else None))


async def _run_compiled(workflow: Any, run_timeout: float) -> str | None:
    """Run the built MAF workflow; classify any failure into a message."""
    try:
        await asyncio.wait_for(workflow.run(_Token()), timeout=run_timeout)
        return None
    except TimeoutError:
        return f"run exceeded the {run_timeout:.0f}s budget"
    except _NodeFailure as failure:
        return f"node '{failure.node_id}' failed: {failure.message}"
    except Exception as exc:
        # MAF wraps executor exceptions; surface the innermost _NodeFailure.
        failure = _find_node_failure(exc)
        if failure is not None:
            return f"node '{failure.node_id}' failed: {failure.message}"
        return f"{type(exc).__name__}: {exc}"[:500]


def _branch_condition(handle: str) -> Callable[[Any], bool]:
    def _check(message: Any) -> bool:
        return getattr(message, "branch", None) == handle

    return _check


def _find_node_failure(exc: BaseException) -> _NodeFailure | None:
    seen: set[int] = set()
    stack: list[BaseException] = [exc]
    while stack:
        current = stack.pop()
        if id(current) in seen:
            continue
        seen.add(id(current))
        if isinstance(current, _NodeFailure):
            return current
        for nxt in (current.__cause__, current.__context__):
            if nxt is not None:
                stack.append(nxt)
        if isinstance(current, BaseExceptionGroup):
            stack.extend(current.exceptions)
    return None


def _mark_unrun(
    by_id: dict[str, dict[str, Any]],
    node_results: dict[str, Any],
    emit: EmitFn,
    status: str,
) -> None:
    """Blocks that never ran — "skipped" on a finished run, "pending" while
    the run is paused for approval (they execute on resume)."""
    for node_id in by_id:
        if node_id not in node_results:
            node_results[node_id] = {"status": status}
            emit(node_id, status, {})

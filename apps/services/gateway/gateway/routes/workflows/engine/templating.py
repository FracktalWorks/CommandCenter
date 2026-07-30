"""The ``{{…}}`` state bus (RFC §6.4).

Run state is one merged dict keyed by node id, plus the reserved keys
``trigger`` (the typed trigger payload) and ``vars`` (workflow variables).
Any node's config may reference any upstream output by path:

    {{trigger.body}}   {{classify.intent}}   {{vars.owner_email}}

Resolution rules (open-agent-builder's graceful-fallback semantics):

- a value that is EXACTLY one reference resolves to the native value
  (dict/list/number survive untouched);
- a reference embedded in a longer string is stringified in place;
- an unresolvable reference is kept as-is at run time (never a crash) —
  design-time validation is the place that flags it (graph.validate_graph).
"""

from __future__ import annotations

import json
import re
from typing import Any

REF_RE = re.compile(r"\{\{\s*([a-zA-Z0-9_][a-zA-Z0-9_.\-]*)\s*\}\}")

#: State keys that always exist regardless of the graph's nodes.
RESERVED_ROOTS = ("trigger", "vars")


def lookup_path(state: dict[str, Any], path: str) -> tuple[bool, Any]:
    """Resolve a dotted *path* against *state*: ``(found, value)``."""
    parts = [p for p in path.split(".") if p]
    if not parts:
        return False, None
    current: Any = state
    for part in parts:
        if isinstance(current, dict) and part in current:
            current = current[part]
        elif isinstance(current, list) and part.isdigit() and int(part) < len(current):
            current = current[int(part)]
        else:
            return False, None
    return True, current


def _stringify(value: Any) -> str:
    if isinstance(value, str):
        return value
    try:
        return json.dumps(value, default=str, ensure_ascii=False)
    except (TypeError, ValueError):
        return str(value)


def resolve_value(value: Any, state: dict[str, Any]) -> Any:
    """Recursively resolve ``{{…}}`` references in *value* against *state*."""
    if isinstance(value, str):
        exact = REF_RE.fullmatch(value.strip())
        if exact:
            found, resolved = lookup_path(state, exact.group(1))
            return resolved if found else value

        def _sub(match: re.Match[str]) -> str:
            found, resolved = lookup_path(state, match.group(1))
            return _stringify(resolved) if found else match.group(0)

        return REF_RE.sub(_sub, value)
    if isinstance(value, dict):
        return {k: resolve_value(v, state) for k, v in value.items()}
    if isinstance(value, list):
        return [resolve_value(v, state) for v in value]
    return value


def collect_refs(value: Any) -> set[str]:
    """Every ``{{path}}`` reference appearing anywhere inside *value*."""
    refs: set[str] = set()
    if isinstance(value, str):
        refs.update(m.group(1) for m in REF_RE.finditer(value))
    elif isinstance(value, dict):
        for v in value.values():
            refs.update(collect_refs(v))
    elif isinstance(value, list):
        for v in value:
            refs.update(collect_refs(v))
    return refs

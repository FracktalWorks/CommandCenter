"""Output guardrails.

Currently implements citation enforcement/repair (Levenshtein-based) — used by
the pull agents and the gateway pull endpoints. Schema validation and a
second-pass verify pass are intended extensions, not yet implemented.
"""
from __future__ import annotations

import re
from collections.abc import Iterable


CITATION_RE = re.compile(r"\[(person|task|deal|project|customer|meeting):[0-9a-f-]{36}\]")
# Looser pattern used for repair: 25-40 hex/hyphen chars (catches LLM truncations).
_LOOSE_CITE_RE = re.compile(
    r"\[(person|task|deal|project|customer|meeting):([0-9a-f-]{25,40})\]"
)


def has_citations(text: str, min_count: int = 1) -> bool:
    """Return True iff text contains at least `min_count` graph-node citations."""
    return len(CITATION_RE.findall(text)) >= min_count


class CitationError(ValueError):
    """Raised when a model output that requires citations does not contain any."""


def _levenshtein(a: str, b: str) -> int:
    if a == b:
        return 0
    if not a or not b:
        return max(len(a), len(b))
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i] + [0] * len(b)
        for j, cb in enumerate(b, 1):
            cur[j] = min(
                prev[j] + 1,
                cur[j - 1] + 1,
                prev[j - 1] + (0 if ca == cb else 1),
            )
        prev = cur
    return prev[-1]


def repair_citations(text: str, valid: Iterable[tuple[str, str]]) -> str:
    """Snap near-miss citations to the closest valid (kind, uuid) pair.

    `valid` is an iterable of (kind, uuid_str) tuples coming from the actual
    retrieval hits. We replace any [kind:uuid] token whose uuid is not exact-36
    or whose value is not in the valid set with the nearest match of the same
    kind (Levenshtein <= 4). If no candidate qualifies, the token is left alone
    and the citation guardrail will reject the answer downstream.
    """
    by_kind: dict[str, list[str]] = {}
    for k, u in valid:
        by_kind.setdefault(k, []).append(str(u))
    valid_set = {(k, str(u)) for k, u in valid}

    def _replace(m: re.Match[str]) -> str:
        kind, uuid_part = m.group(1), m.group(2)
        if (kind, uuid_part) in valid_set and len(uuid_part) == 36:
            return m.group(0)
        candidates = by_kind.get(kind) or []
        if not candidates:
            return m.group(0)
        best = min(candidates, key=lambda c: _levenshtein(uuid_part, c))
        if _levenshtein(uuid_part, best) <= 4:
            return f"[{kind}:{best}]"
        return m.group(0)

    return _LOOSE_CITE_RE.sub(_replace, text)


def require_citations(text: str, *, min_count: int = 1) -> str:
    if not has_citations(text, min_count=min_count):
        raise CitationError(
            f"Output lacks the required {min_count} citation(s) "
            f"of the form [entity:uuid]; refusing to surface."
        )
    return text


__all__ = [
    "CITATION_RE",
    "CitationError",
    "has_citations",
    "repair_citations",
    "require_citations",
]

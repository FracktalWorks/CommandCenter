"""On-demand Command Center design system (generative_ui_2 §7 follow-up).

``design.md`` is ~16 KB. Rather than paste it into every agent's system prompt
(it used to be injected into every Copilot agent, every turn), agents call
``load_design_system()`` only when they actually need the full design language:
writing a full-page HTML/Markdown report, or bespoke custom HTML/CSS for an
``emit_generative_ui`` ``html`` node. Named genUI templates are on-brand by
construction and never need it, and the ``--cc-*`` token names live in the
injected UI directive — so the common paths stay cheap and the heavy design
reference loads on demand.
"""
from __future__ import annotations

import functools
from pathlib import Path


@functools.lru_cache(maxsize=1)
def _design_doc() -> str:
    """The design.md body with any YAML front matter stripped (cached)."""
    try:
        import acb_skills  # noqa: PLC0415

        text = (Path(acb_skills.__file__).parent / "design.md").read_text(
            encoding="utf-8", errors="replace",
        )
    except Exception:  # noqa: BLE001 — never fail the tool on a missing doc
        return ""
    # Strip a leading ``---\n…\n---`` YAML front-matter block if present.
    if text.startswith("---"):
        parts = text.split("---", 2)
        if len(parts) == 3:
            text = parts[2]
    return text.strip()


async def load_design_system() -> str:
    """Load the Command Center design system (palette, type, motion, report kit).

    Call this BEFORE you write a full-page HTML or Markdown **report**, or any
    bespoke **custom HTML/CSS** for an ``emit_generative_ui`` ``html`` node, so
    the result matches the Command Center look (tokens, typography, spacing,
    dark/light, and the ``cc-report`` block kit). You do NOT need it for named
    ``emit_generative_ui`` templates — those are already on-brand — nor for a
    quick plain-text reply. Returns the full design guide as Markdown.
    """
    doc = _design_doc()
    return doc or (
        "Design system unavailable (design.md not found). Use the --cc-* CSS "
        "variables named in the platform tools guidance and keep it clean and "
        "on-brand."
    )

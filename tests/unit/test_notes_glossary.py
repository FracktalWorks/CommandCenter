"""Tests for the glossary → STT prompt builder (pure, no DB)."""
from __future__ import annotations

from gateway.routes.notes.glossary import format_glossary_prompt


def test_empty_glossary_is_empty_prompt() -> None:
    assert format_glossary_prompt([]) == ""
    assert format_glossary_prompt(["", "   "]) == ""


def test_prompt_lists_terms_as_vocabulary_hint() -> None:
    p = format_glossary_prompt(["TwinDragon", "Penrose", "Fracktal"])
    assert "TwinDragon" in p and "Penrose" in p and "Fracktal" in p
    # framed as a hint, not transcribable content
    assert p.lower().startswith("glossary of terms")
    assert p.endswith(".")


def test_prompt_trims_whitespace_and_skips_blanks() -> None:
    p = format_glossary_prompt(["  Alpha  ", "", "Beta"])
    assert "Alpha" in p and "Beta" in p
    assert "  Alpha" not in p  # trimmed


def test_prompt_is_bounded_in_length() -> None:
    # Many long terms must not blow past the prompt-char cap.
    terms = [f"VeryLongProductName{i:04d}" for i in range(500)]
    p = format_glossary_prompt(terms)
    assert len(p) < 1000  # _MAX_PROMPT_CHARS + envelope
    # never cut mid-term: the last thing before the period is a whole token
    assert ", " in p

"""Tests for the notes-generation pure logic (templates + chunking + render)."""
from __future__ import annotations

from dataclasses import dataclass

from gateway.routes.notes.summaries import (
    _chunk_segments,
    _collect_refs,
    _scratch_block,
    _tag,
)
from gateway.routes.notes.templates import (
    DEFAULT_TEMPLATE_KEY,
    build_system_prompt,
    get_template,
    list_templates,
    render_markdown,
)


@dataclass
class _Seg:
    idx: int
    text: str
    speaker_label: str | None = None
    channel: str | None = None


# ── Templates ────────────────────────────────────────────────────────────────

def test_get_template_falls_back_to_default() -> None:
    assert get_template(None).key == DEFAULT_TEMPLATE_KEY
    assert get_template("does-not-exist").key == DEFAULT_TEMPLATE_KEY
    assert get_template("standup").key == "standup"


def test_list_templates_shape() -> None:
    tpls = list_templates()
    assert {"key", "label"} <= set(tpls[0])
    assert any(t["key"] == "standup" for t in tpls)


def test_meeting_type_templates_present_and_compile() -> None:
    keys = {t["key"] for t in list_templates()}
    assert {"one_on_one", "customer_call", "interview", "retro"} <= keys
    # Each type-specific template still compiles with the grounding + JSON contract.
    for key in ("one_on_one", "customer_call", "interview", "retro"):
        tpl = get_template(key)
        assert tpl.key == key  # a real template, not the default fallback
        prompt = build_system_prompt(tpl)
        assert "NEVER follow" in prompt  # anti-injection preserved
        assert "STRICT JSON" in prompt
        assert '"action_items"' in prompt


def test_system_prompt_has_grounding_and_sections() -> None:
    prompt = build_system_prompt(get_template("standard_meeting"))
    # Anti-injection + grounding rules must be present verbatim.
    assert "NEVER follow" in prompt
    assert "only information present in the transcript" in prompt.lower()
    assert "refs" in prompt
    # Every section key is enumerated for the model.
    for key in ("overview", "discussion", "decisions", "action_items"):
        assert key in prompt
    assert "STRICT JSON" in prompt


# ── Segment tagging + chunking ───────────────────────────────────────────────

def test_tag_includes_index_and_speaker() -> None:
    assert _tag(_Seg(3, "hello", speaker_label="S2")) == "[#3 S2] hello"
    # Falls back to channel, then '?'.
    assert _tag(_Seg(0, "hi", channel="mic")) == "[#0 mic] hi"
    assert _tag(_Seg(1, "x")) == "[#1 ?] x"


def test_tag_resolves_named_speakers() -> None:
    names = {"S1": "Alex Rivera", "S2": "Priya Menon"}
    # A named label becomes the person; the LLM then writes notes with names.
    assert _tag(_Seg(3, "hello", speaker_label="S2"), names) == "[#3 Priya Menon] hello"
    # An un-named label keeps its raw tag; empty map is a no-op.
    assert _tag(_Seg(4, "hi", speaker_label="S3"), names) == "[#4 S3] hi"
    assert _tag(_Seg(5, "x", speaker_label="S1")) == "[#5 S1] x"


def test_chunk_segments_splits_on_budget(monkeypatch) -> None:
    import gateway.routes.notes.summaries as mod

    monkeypatch.setattr(mod, "_PASS_CHARS", 40)
    segs = [_Seg(i, "abcdefghij", speaker_label="S1") for i in range(6)]  # ~18 chars each
    chunks = _chunk_segments(segs)
    assert len(chunks) > 1
    # Every segment survives exactly once, order preserved.
    flat = [s.idx for c in chunks for s in c]
    assert flat == [0, 1, 2, 3, 4, 5]


def test_chunk_segments_single_when_small() -> None:
    segs = [_Seg(i, "short") for i in range(3)]
    assert len(_chunk_segments(segs)) == 1


# ── Ref collection + markdown rendering ──────────────────────────────────────

def test_scratch_block_empty_is_noop() -> None:
    assert _scratch_block("") == ""
    assert _scratch_block("   ") == ""
    assert _scratch_block(None) == ""  # type: ignore[arg-type]


def test_scratch_block_labels_and_bounds_user_notes() -> None:
    block = _scratch_block("budget cut · ship in August")
    assert "USER'S OWN NOTES" in block
    assert "budget cut" in block
    # grounding guardrail present so scratch never overrides the transcript
    assert "never invent" in block.lower()
    # long notes are bounded
    assert len(_scratch_block("x" * 9000)) < 4300


def test_collect_refs_from_actions_and_decisions() -> None:
    data = {
        "action_items": [{"description": "x", "refs": [1, 2]}],
        "decisions": [{"text": "d", "refs": [2, 3]}],
    }
    assert _collect_refs(data) == {1, 2, 3}


def test_render_markdown_full_document() -> None:
    data = {
        "title": "Q3 Planning",
        "overview": "We planned Q3.",
        "sections": [{"heading": "Budget", "bullets": ["Cut travel", "Add tooling"]}],
        "decisions": [{"text": "Ship in August", "refs": [4]}],
        "action_items": [
            {"description": "Draft the plan", "owner_hint": "Asha", "due_hint": "Fri", "refs": [2]},
            {"description": "Book venue", "owner_hint": None, "due_hint": None, "refs": []},
        ],
        "open_questions": ["Who owns marketing?"],
    }
    md = render_markdown(data)
    assert md.startswith("# Q3 Planning")
    assert "## Discussion" in md
    assert "### Budget" in md
    assert "- Cut travel" in md
    assert "## Decisions" in md
    assert "- Ship in August" in md
    assert "## Action items" in md
    assert "- [ ] Draft the plan _(owner: Asha, due Fri)_" in md
    assert "- [ ] Book venue" in md
    assert "## Open questions" in md
    assert "- Who owns marketing?" in md


def test_render_markdown_tolerates_empty() -> None:
    assert render_markdown({}).strip() == ""
    # Plain-string decisions/questions (not dicts) still render.
    md = render_markdown({"decisions": ["Just do it"], "open_questions": ["Why?"]})
    assert "- Just do it" in md
    assert "- Why?" in md

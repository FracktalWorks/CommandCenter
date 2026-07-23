"""Voice & writing-style profile learned from past mail (migration 94).

Pins the pure seams of the builder — sample prep (quote-stripping so only the
owner's prose is studied), observation merging, trait whitelisting, the
<voice_profile> prompt-block rendering — plus the two behaviours that guard the
feature's contract: `_load_assistant_about` injects the block between
<writing_style> and <learned_writing_style>, and a BUILDING row with no live
job reads as FAILED (the in-memory tracker dies with the process; the profile
must not look stuck forever).
"""
from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

from gateway.routes.email.automation import assistant as a
from gateway.routes.email.automation import voice_profile as vp

# ── sample prep ─────────────────────────────────────────────────────────────


def test_prep_samples_strips_quoted_chain_and_short_bodies() -> None:
    quoted = (
        "Thanks — that works for me, see you Tuesday at the workshop.\n\n"
        "On Mon, 1 Jul 2026, Jane Doe wrote:\n> Are you free Tuesday?\n> Jane"
    )
    samples = vp._prep_samples([quoted, "ok", ""])
    assert len(samples) == 1
    assert "see you Tuesday" in samples[0]
    assert "Jane Doe wrote" not in samples[0], "correspondent prose must not leak"


def test_prep_samples_caps_length() -> None:
    long = "word " * 2000
    (sample,) = vp._prep_samples([long])
    assert len(sample) <= vp._SAMPLE_MAX_CHARS


# ── observation merge ───────────────────────────────────────────────────────


def test_merge_observations_dedupes_case_insensitively_keeping_order() -> None:
    merged = vp._merge_observations([
        {"style_notes": ["Short sentences"], "greetings": ["Hi <name>,"],
         "signoffs": ["Cheers"], "phrases": [],
         "facts": [{"title": "Role", "content": "CTO at Acme"}]},
        {"style_notes": ["short sentences", "Uses dashes"],
         "greetings": ["hi <name>,"], "signoffs": [], "phrases": [],
         "facts": [{"title": "role", "content": "duplicate"}]},
        "not-a-dict",  # a failed batch must not sink the merge
    ])
    assert merged["style_notes"] == ["Short sentences", "Uses dashes"]
    assert merged["greetings"] == ["Hi <name>,"]
    assert [f["title"] for f in merged["facts"]] == ["Role"]


# ── trait normalization ─────────────────────────────────────────────────────


def test_normalize_traits_whitelists_and_coerces() -> None:
    traits = vp._normalize_traits({
        "tone": "  warm but direct  ",
        "greetings": ["Hi X,", "Hi X,", 42, "Hey,"],
        "made_up_key": "dropped",
        "dos": "not-a-list",  # wrong shape → dropped
    })
    assert traits["tone"] == "warm but direct"
    assert traits["greetings"] == ["Hi X,", "Hey,"]
    assert "made_up_key" not in traits
    assert "dos" not in traits
    assert vp._normalize_traits("garbage") == {}


def test_clean_sources_defaults_to_sent_only() -> None:
    assert vp._clean_sources(None) == ["sent"]
    assert vp._clean_sources(["inbox", "junk"]) == ["sent"]
    assert vp._clean_sources(["drafts", "sent"]) == ["drafts", "sent"]


# ── prompt block rendering ──────────────────────────────────────────────────


def test_voice_profile_block_renders_guide_and_shell_traits() -> None:
    block = vp.voice_profile_block(
        "- Keep replies short.",
        {"greetings": ["Hi <name>,"], "signoffs": ["Cheers"],
         "common_phrases": [], "tone": "warm"},
    )
    assert block.startswith("<voice_profile>")
    assert block.endswith("</voice_profile>")
    assert "- Keep replies short." in block
    assert "Typical greetings: Hi <name>," in block
    assert "Typical sign-offs: Cheers" in block
    # Scalars like tone live in the guide, not the appendix.
    assert "warm" not in block


def test_voice_profile_block_empty_when_nothing_learned() -> None:
    assert vp.voice_profile_block("", {}) == ""
    assert vp.voice_profile_block(None, MagicMock()) == ""


def test_voice_profile_block_parses_jsonb_returned_as_str() -> None:
    # asyncpg can hand JSONB back as a str — the block must not silently drop
    # the traits when it does (same both-ways treatment as address columns).
    block = vp.voice_profile_block("", '{"greetings": ["Hi X,"]}')
    assert "Typical greetings: Hi X," in block
    assert vp._parse_traits("not json") == {}
    assert vp._parse_traits('["a-list"]') == {}


# ── stale-BUILDING handling ─────────────────────────────────────────────────


def test_building_row_with_no_live_job_reads_as_failed() -> None:
    row = SimpleNamespace(
        enabled=True, status="BUILDING", style_guide="", traits={},
        sources=["sent"], range_start=None, range_end=None,
        analyzed_count=0, last_error=None, built_at=None)
    out = vp._profile_dict("acc-1", row, suggested=0)
    assert out["status"] == "FAILED"
    assert out["last_error"]


def test_empty_placeholder_when_no_row() -> None:
    out = vp._profile_dict("acc-1", None, suggested=2)
    assert out["status"] == "EMPTY"
    assert out["suggested_knowledge"] == 2


# ── prompt assembly integration ─────────────────────────────────────────────


def _fake_db(vp_row):
    """Routes _load_assistant_about's queries, incl. the voice-profile read."""

    async def fake_execute(stmt, params=None):
        sql = str(stmt)
        r = MagicMock()
        if "FROM email_assistant_settings" in sql:
            r.fetchone.return_value = SimpleNamespace(
                about="I run Acme.", signature="— V",
                personal_instructions=None, writing_style="Explicit style.",
                learned_writing_style="Learned style.")
        elif "FROM email_voice_profiles" in sql:
            r.fetchone.return_value = vp_row
        elif "FROM email_knowledge" in sql:
            r.fetchall.return_value = []
        else:  # learned_patterns
            r.fetchall.return_value = []
        return r

    db = AsyncMock()
    db.execute.side_effect = fake_execute
    return db


async def test_about_includes_voice_profile_between_styles() -> None:
    db = _fake_db(SimpleNamespace(
        style_guide="- Write like me.", traits={"greetings": ["Yo,"]}))
    about, _sig = await a._load_assistant_about(db, "acc-1")
    assert "<voice_profile>" in about
    assert "- Write like me." in about
    # Priority order in the assembled context: explicit style first, then the
    # voice profile, then the auto-derived learned style.
    assert (about.index("<writing_style>")
            < about.index("<voice_profile>")
            < about.index("<learned_writing_style>"))


async def test_about_omits_voice_profile_when_absent() -> None:
    db = _fake_db(None)
    about, _sig = await a._load_assistant_about(db, "acc-1")
    assert "<voice_profile>" not in about

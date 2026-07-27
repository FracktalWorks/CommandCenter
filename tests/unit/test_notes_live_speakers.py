"""Tests for the live speaker registry (voiceprint gallery + name binding).

This is the heart of the "pause-chunked spine → consistent diarization live"
design: given per-chunk embeddings, assign a *stable* global speaker id across
chunks, and bind names from self-introductions. Pure/synchronous — no network,
no models, no LLM — so it locks the clustering + naming semantics cheaply.
"""
from __future__ import annotations

from gateway.routes.notes import live_speakers as ls

# ── cosine ───────────────────────────────────────────────────────────────────

def test_cosine_identical_is_one() -> None:
    assert ls.cosine([1.0, 2.0, 3.0], [1.0, 2.0, 3.0]) == 1.0


def test_cosine_orthogonal_is_zero() -> None:
    assert ls.cosine([1.0, 0.0], [0.0, 1.0]) == 0.0


def test_cosine_handles_bad_input() -> None:
    assert ls.cosine(None, [1.0]) == 0.0
    assert ls.cosine([1.0, 2.0], [1.0]) == 0.0     # dim mismatch
    assert ls.cosine([0.0, 0.0], [1.0, 1.0]) == 0.0  # zero norm


# ── self-intro detection (precision over recall) ─────────────────────────────

def test_detects_clear_self_intros() -> None:
    assert ls.detect_self_intro("Hi, I'm Priya, good to meet you") == "Priya"
    assert ls.detect_self_intro("my name is Alex Rivera") == "Alex Rivera"
    assert ls.detect_self_intro("This is Dana from the finance team") == "Dana"
    assert ls.detect_self_intro("Sam here, can you hear me?") == "Sam"


def test_ignores_non_intros() -> None:
    # capitalized-but-not-a-name / not first person → no false naming
    assert ls.detect_self_intro("I'm going to share my screen") is None
    assert ls.detect_self_intro("thanks, Alex, that's helpful") is None
    assert ls.detect_self_intro("this is great work everyone") is None
    assert ls.detect_self_intro("") is None


# ── clustering: stable ids across chunks ─────────────────────────────────────

def test_same_voice_gets_same_id() -> None:
    reg = ls.LiveSpeakerRegistry()
    a = reg.resolve([1.0, 0.0, 0.0])
    b = reg.resolve([0.98, 0.02, 0.0])  # near-identical voiceprint
    assert a.speaker_id == "S1"
    assert b.speaker_id == "S1"
    assert b.is_new is False


def test_distinct_voices_get_distinct_ids() -> None:
    reg = ls.LiveSpeakerRegistry()
    a = reg.resolve([1.0, 0.0, 0.0])
    b = reg.resolve([0.0, 1.0, 0.0])  # orthogonal → different speaker
    assert a.speaker_id == "S1"
    assert b.speaker_id == "S2"
    assert b.is_new is True


def test_centroid_tracks_drift() -> None:
    """A speaker's centroid updates so gradual drift still matches the same id."""
    reg = ls.LiveSpeakerRegistry()
    reg.resolve([1.0, 0.0, 0.0])
    reg.resolve([0.9, 0.1, 0.0])
    reg.resolve([0.8, 0.2, 0.0])
    later = reg.resolve([0.75, 0.25, 0.0])
    assert later.speaker_id == "S1"  # never split into a second speaker


def test_alternating_speakers_stay_consistent() -> None:
    reg = ls.LiveSpeakerRegistry()
    seq = [[1.0, 0.0], [0.0, 1.0], [0.97, 0.03], [0.03, 0.97], [1.0, 0.0]]
    ids = [reg.resolve(v).speaker_id for v in seq]
    assert ids == ["S1", "S2", "S1", "S2", "S1"]


# ── names / roster ───────────────────────────────────────────────────────────

def test_note_text_binds_name_and_roster_reflects_it() -> None:
    reg = ls.LiveSpeakerRegistry()
    r = reg.resolve([1.0, 0.0, 0.0])
    assert reg.note_text(r.speaker_id, "Hi, I'm Priya") == "Priya"
    assert reg.name_of(r.speaker_id) == "Priya"
    roster = reg.roster()
    assert roster == [
        {"speaker_id": "S1", "name": "Priya", "role": None, "utterances": 1}
    ]


def test_first_name_wins() -> None:
    reg = ls.LiveSpeakerRegistry()
    r = reg.resolve([1.0, 0.0])
    reg.note_text(r.speaker_id, "I'm Priya")
    reg.note_text(r.speaker_id, "actually this is Sam")  # ignored — already named
    assert reg.name_of(r.speaker_id) == "Priya"


def test_bind_sets_role_explicitly() -> None:
    reg = ls.LiveSpeakerRegistry()
    reg.resolve([1.0, 0.0])
    reg.bind("S1", role="Account Executive")
    assert reg.roster()[0]["role"] == "Account Executive"


# ── fallback: no embedding (browser/channel path) ────────────────────────────

def test_no_embedding_passes_label_through() -> None:
    reg = ls.LiveSpeakerRegistry()
    r1 = reg.resolve(None, fallback_label="S1")
    r2 = reg.resolve(None, fallback_label="S1")
    assert r1.speaker_id == "S1" and r2.speaker_id == "S1"


def test_no_embedding_no_label_is_unknown_bucket() -> None:
    reg = ls.LiveSpeakerRegistry()
    assert reg.resolve(None).speaker_id == "?"


# ── module registry map ──────────────────────────────────────────────────────

def test_registry_is_per_meeting_and_resettable() -> None:
    ls.reset("m-a")
    ls.reset("m-b")
    ls.registry("m-a").resolve([1.0, 0.0])
    assert ls.registry("m-b").roster() == []   # isolated
    ls.reset("m-a")
    assert ls.registry("m-a").roster() == []   # cleared

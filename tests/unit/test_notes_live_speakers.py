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


# ── reconciliation: live identity → authoritative batch labels ───────────────

def test_reconcile_maps_batch_labels_to_live_speakers_by_overlap() -> None:
    """Batch re-diarization uses its OWN labels; they're matched to the live
    gallery by time overlap (here batch B1 is live S2, and vice versa)."""
    live = [("S1", 0.0, 5.0), ("S2", 5.0, 10.0)]
    batch = [("B1", 5.1, 9.9), ("B2", 0.1, 4.9)]
    assert ls.reconcile_labels(batch, live) == {"B1": "S2", "B2": "S1"}


def test_reconcile_uses_total_overlap_not_first_hit() -> None:
    live = [("S1", 0.0, 1.0), ("S2", 1.0, 10.0)]
    batch = [("B1", 0.0, 10.0)]  # touches both, but overlaps S2 far more
    assert ls.reconcile_labels(batch, live) == {"B1": "S2"}


def test_reconcile_is_one_to_one() -> None:
    """If the live gallery merged two people, only the better-matching batch
    label inherits that identity — the other is left unmapped, not mislabelled."""
    live = [("S1", 0.0, 10.0)]
    batch = [("B1", 0.0, 8.0), ("B2", 8.0, 10.0)]
    assert ls.reconcile_labels(batch, live) == {"B1": "S1"}


def test_reconcile_ignores_disjoint_spans() -> None:
    assert ls.reconcile_labels([("B1", 50.0, 60.0)], [("S1", 0.0, 10.0)]) == {}
    assert ls.reconcile_labels([], [("S1", 0.0, 1.0)]) == {}


def test_live_names_carry_onto_batch_labels() -> None:
    mid = "m-recon"
    ls.reset(mid)
    reg = ls.registry(mid)
    r1 = reg.resolve([1.0, 0.0])
    reg.note_text(r1.speaker_id, "Hi, I'm Priya")
    reg.note_span(r1.speaker_id, 0.0, 5.0)
    r2 = reg.resolve([0.0, 1.0])
    reg.note_text(r2.speaker_id, "This is Alex")
    reg.note_span(r2.speaker_id, 5.0, 10.0)

    # The batch pass's labels differ from the live ones — names still land.
    batch = [("B7", 0.2, 4.8), ("B9", 5.2, 9.8)]
    assert ls.live_names_for_batch(mid, batch) == {"B7": "Priya", "B9": "Alex"}
    ls.reset(mid)


def test_live_names_empty_without_a_live_pass() -> None:
    ls.reset("m-none")
    assert ls.live_names_for_batch("m-none", [("B1", 0.0, 1.0)]) == {}


def test_timeline_is_bounded_and_skips_empty_spans() -> None:
    reg = ls.LiveSpeakerRegistry()
    reg.note_span("S1", 1.0, 1.0)   # zero-length → ignored
    reg.note_span("S1", 2.0, 1.0)   # inverted → ignored
    assert reg.timeline() == []
    for i in range(ls._TIMELINE_MAX + 25):
        reg.note_span("S1", float(i), float(i) + 0.5)
    assert len(reg.timeline()) == ls._TIMELINE_MAX

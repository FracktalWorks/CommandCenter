"""Copilot policy — WHEN to spend a token, and WHAT the model gets to see.

This is the token-efficiency crux of the Live Meeting Copilot (spec §4), kept
deliberately **pure**: no LLM calls, no I/O, no state beyond what's passed in.
Running a model on every sentence would be both expensive and noisy, so the
orchestrator runs a cascade and *most speech never reaches a model at all*:

    Stage 0  windowing      — group segments into utterance windows
    Stage 1  cheap gate     — regex/keyword triggers + debounce (NO LLM)  ← here
    Stage 2  decide         — tier-fast, tiny context: act or stay silent
    Stage 3  craft          — the actual talking point, only when acting

Stages 0 and 1 live here because they're the part that must be cheap, fast and
predictable — and because "does this deserve a model?" is exactly the kind of
judgement that should be inspectable and unit-tested rather than emergent.

The rolling meeting state (§4.1) is also built here: the copilot always reasons
over *(compact state + last window)*, never the full transcript, which is what
keeps cost flat regardless of how long a meeting runs.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

# ── Stage 0: windowing ───────────────────────────────────────────────────────

# A window closes on a speaker change, or once it's long enough to be a thought.
WINDOW_MAX_WORDS = 40
WINDOW_MAX_SECONDS = 15.0


@dataclass
class Window:
    """A closed utterance window — the unit the copilot reasons over."""

    text: str
    speakers: list[str] = field(default_factory=list)
    start_s: float = 0.0
    end_s: float = 0.0

    @property
    def words(self) -> int:
        return len(self.text.split())


class Windower:
    """Groups live segments into windows. Closes on speaker change, word count,
    or elapsed time — whichever comes first."""

    def __init__(self) -> None:
        self._buf: list[dict] = []

    def push(self, seg: dict) -> Window | None:
        """Add a segment; returns a Window when one closes."""
        text = (seg.get("text") or "").strip()
        if not text:
            return None
        speaker = seg.get("speaker_id") or seg.get("speaker_label")

        closed: Window | None = None
        if self._buf:
            prev_speaker = self._buf[-1].get("speaker_id") or self._buf[-1].get(
                "speaker_label"
            )
            words = sum(len((s.get("text") or "").split()) for s in self._buf)
            span = float(self._buf[-1].get("end_s") or 0.0) - float(
                self._buf[0].get("start_s") or 0.0
            )
            if (
                speaker != prev_speaker
                or words >= WINDOW_MAX_WORDS
                or span >= WINDOW_MAX_SECONDS
            ):
                closed = self._close()
        self._buf.append(seg)
        return closed

    def flush(self) -> Window | None:
        return self._close()

    def _close(self) -> Window | None:
        if not self._buf:
            return None
        buf, self._buf = self._buf, []
        speakers: list[str] = []
        for s in buf:
            sp = s.get("speaker_id") or s.get("speaker_label")
            if sp and sp not in speakers:
                speakers.append(str(sp))
        return Window(
            text=" ".join((s.get("text") or "").strip() for s in buf).strip(),
            speakers=speakers,
            start_s=float(buf[0].get("start_s") or 0.0),
            end_s=float(buf[-1].get("end_s") or 0.0),
        )


# ── Stage 1: the cheap trigger gate (no LLM) ─────────────────────────────────

# Deliberately conservative: these fire on moments where a moderator plausibly
# adds value. Everything else is dropped for free — the common case.
_QUESTION = re.compile(r"\?|^\s*(who|what|when|where|why|how|which|can|could|do|does|did|is|are|should|would|will)\b", re.I)
_OBJECTION = re.compile(
    r"\b(too expensive|expensive|concern(?:ed|s)?|worried|risk(?:y|s)?|blocker|"
    r"problem|issue|but |however|not sure|hesitant|competitor|churn|delay(?:ed)?|"
    r"pushback|objection)\b",
    re.I,
)
_DECISION = re.compile(
    r"\b(decide[sd]?|decision|agree[d]?|let's|we'll|we will|next step|action item|"
    r"i'll|commit(?:ment|ted)?|deadline|by (?:monday|tuesday|wednesday|thursday|"
    r"friday|next week|end of))\b",
    re.I,
)
_NUMERIC = re.compile(r"(?:[$₹€£]\s?\d|\b\d+\s?(?:%|percent|k\b|lakh|crore|million)|\b\d{1,2}[:/]\d{2})", re.I)

# Defaults for how long the copilot stays quiet after speaking and the ceiling
# per meeting. Both are overridable per call — Settings maps its three
# sensitivity levels onto sane pairs (settings.SENSITIVITY_LEVELS).
MIN_GAP_SECONDS = 45.0
MAX_PER_MEETING = 12
# Too short to carry a thought — never worth a model call.
MIN_WINDOW_WORDS = 6


@dataclass
class GateDecision:
    consider: bool
    reason: str  # why it fired (or why it didn't) — surfaced for debugging


def gate(
    window: Window,
    *,
    seconds_since_last: float,
    interjections_so_far: int,
    min_gap_seconds: float = MIN_GAP_SECONDS,
    max_per_meeting: int = MAX_PER_MEETING,
) -> GateDecision:
    """Stage 1. Decide whether this window is even worth a model call.

    Pure and cheap by design: most speech dies here, which is what makes the
    whole feature affordable. Budget/debounce checks come FIRST so a busy
    meeting can't run up cost through the trigger patterns."""
    if interjections_so_far >= max_per_meeting:
        return GateDecision(False, "per-meeting cap reached")
    if seconds_since_last < min_gap_seconds:
        return GateDecision(False, "too soon since the last interjection")
    if window.words < MIN_WINDOW_WORDS:
        return GateDecision(False, "window too short to carry a thought")

    text = window.text
    if _QUESTION.search(text):
        return GateDecision(True, "a question was asked")
    if _OBJECTION.search(text):
        return GateDecision(True, "an objection or risk was raised")
    if _DECISION.search(text):
        return GateDecision(True, "a decision or commitment was made")
    if _NUMERIC.search(text):
        return GateDecision(True, "a number, price or date came up")
    return GateDecision(False, "nothing worth interrupting for")


# ── §4.1 Rolling meeting state (the token backbone) ──────────────────────────

@dataclass
class RollingState:
    """A compact, continuously-updated picture of the meeting.

    The copilot reasons over *(this + the last window)*, never the full
    transcript — which is what keeps cost flat however long a meeting runs.
    Bounded on every axis so it can't grow without limit."""

    topics: list[str] = field(default_factory=list)
    open_questions: list[str] = field(default_factory=list)
    # What the copilot has ALREADY said — the dedup memory that stops it
    # repeating itself, which is the fastest way to become annoying.
    raised: list[str] = field(default_factory=list)
    speakers: list[str] = field(default_factory=list)

    _MAX = 8

    def note_window(self, window: Window) -> None:
        for sp in window.speakers:
            if sp not in self.speakers:
                self.speakers.append(sp)
        if _QUESTION.search(window.text):
            self._add(self.open_questions, window.text[:160])

    def note_raised(self, text: str) -> None:
        self._add(self.raised, text)

    def _add(self, bucket: list[str], item: str) -> None:
        item = item.strip()
        if not item or item in bucket:
            return
        bucket.append(item)
        del bucket[: max(0, len(bucket) - self._MAX)]

    def as_prompt(self) -> str:
        """Render for the model — compact, and only what's useful."""
        parts: list[str] = []
        if self.speakers:
            parts.append(f"Speakers so far: {', '.join(self.speakers)}")
        if self.open_questions:
            qs = "; ".join(self.open_questions[-3:])
            parts.append(f"Recent questions: {qs}")
        if self.raised:
            already = "; ".join(self.raised[-5:])
            parts.append(f"Points you ALREADY raised (do not repeat): {already}")
        return "\n".join(parts)


def is_duplicate(candidate: str, already: list[str]) -> bool:
    """Cheap near-duplicate check so the copilot doesn't re-raise a point.

    Token-overlap rather than an embedding: this runs on every candidate and
    must not itself cost anything."""
    cand = _tokens(candidate)
    if not cand:
        return True
    for prev in already:
        prev_t = _tokens(prev)
        if not prev_t:
            continue
        overlap = len(cand & prev_t) / len(cand | prev_t)
        if overlap >= 0.6:
            return True
    return False


def _tokens(s: str) -> set[str]:
    return {w for w in re.findall(r"[a-z0-9']+", s.lower()) if len(w) > 3}

"""Pure VAD endpointer — group speech frames into utterance chunks on pauses.

This is the concrete "chunk on pauses, not the clock" primitive: fixed-time
windows cut mid-word (where ASR loses context and diarization gets confused),
so instead we close a chunk when the speaker actually *pauses*. Each emitted
chunk is a complete utterance — near-batch ASR accuracy, and usually a single
speaker's turn (the cleanest input for a per-utterance speaker embedding).

Deliberately **pure**: it consumes per-frame speech/silence decisions (the VAD
model — or a cheap energy heuristic — lives in ``live.py``) plus opaque frame
payloads, and emits an :class:`Utterance` when a boundary is hit. No audio libs,
no models, no ffmpeg — so the boundary logic is unit-testable in isolation.

Spec: live_meeting_copilot.md §3.5 (pause-chunked spine).
"""

from __future__ import annotations

from dataclasses import dataclass, field


@dataclass
class Utterance:
    start_s: float
    end_s: float
    frames: list  # opaque frame payloads (e.g. PCM bytes) for the caller to join


@dataclass
class Endpointer:
    """Speech-frame → utterance state machine.

    An utterance opens on the first speech frame and closes when either the
    trailing silence reaches ``hangover_ms`` (a real pause) or its length hits
    ``max_utt_ms`` (a monologue still flushes). Utterances shorter than
    ``min_utt_ms`` are dropped as blips."""

    frame_ms: float = 100.0       # duration of one pushed frame
    hangover_ms: float = 600.0    # trailing silence that closes an utterance
    min_utt_ms: float = 300.0     # drop utterances shorter than this
    max_utt_ms: float = 15000.0   # hard cap so a long monologue still flushes

    # -- internal state --
    _buf: list = field(default_factory=list)
    _start_s: float | None = None
    _last_speech_s: float | None = None
    _silence_ms: float = 0.0
    _t: float = 0.0  # monotonic stream clock (seconds), advanced per frame

    def push(self, frame: object, is_speech: bool) -> Utterance | None:
        """Feed one frame + its speech/silence decision. Returns a closed
        :class:`Utterance` when this frame completes one, else ``None``."""
        t = self._t
        self._t += self.frame_ms / 1000.0

        if is_speech:
            if self._start_s is None:  # utterance opens
                self._start_s = t
                self._buf = []
                self._silence_ms = 0.0
            self._buf.append(frame)
            self._last_speech_s = t + self.frame_ms / 1000.0
            self._silence_ms = 0.0
            if (self._last_speech_s - self._start_s) * 1000.0 >= self.max_utt_ms:
                return self._flush()
            return None

        # silence
        if self._start_s is None:
            return None  # nothing buffered — idle
        self._buf.append(frame)  # keep a little trailing context
        self._silence_ms += self.frame_ms
        if self._silence_ms >= self.hangover_ms:
            return self._flush()
        return None

    def flush(self) -> Utterance | None:
        """Force-close any open utterance (call once at stream end)."""
        return self._flush()

    def _flush(self) -> Utterance | None:
        if self._start_s is None:
            return None
        start = self._start_s
        end = self._last_speech_s if self._last_speech_s is not None else start
        frames = self._buf
        self._buf = []
        self._start_s = None
        self._last_speech_s = None
        self._silence_ms = 0.0
        if (end - start) * 1000.0 < self.min_utt_ms:
            return None  # blip — drop
        return Utterance(start_s=start, end_s=end, frames=frames)


def overlap(a0: float, a1: float, b0: float, b1: float) -> float:
    """Seconds of overlap between intervals [a0,a1] and [b0,b1] (0 if disjoint)."""
    return max(0.0, min(a1, b1) - max(a0, b0))


def pick_embedding(
    start_s: float, end_s: float, windows: list[tuple[float, float, list[float]]]
) -> list[float] | None:
    """Choose the utterance-window embedding that best overlaps an ASR segment.

    ``windows`` is ``[(w_start, w_end, embedding), …]`` from the endpointer. The
    ASR (e.g. WhisperLive) segments on its own VAD, so its segment boundaries and
    our utterance windows are close but not identical — pick by max time overlap.
    Returns ``None`` when nothing overlaps."""
    best_emb: list[float] | None = None
    best_ov = 0.0
    for w0, w1, emb in windows:
        ov = overlap(start_s, end_s, w0, w1)
        if ov > best_ov:
            best_emb, best_ov = emb, ov
    return best_emb

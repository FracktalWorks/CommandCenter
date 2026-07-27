"""Live streaming transcription + speaking, for the meeting-bot worker.

Two optional, config-gated capabilities layered on top of the batch recording
(which stays the archival source of truth):

1. **Stream** the call audio to a streaming ASR (self-hosted WhisperLive-style
   WebSocket, or any compatible endpoint) and forward each recognised segment to
   the gateway's live bus (``POST {LIVE_CALLBACK_URL}``) as it arrives — so the
   UI shows live captions and agents can act mid-meeting. When ``EMBED_CMD`` is
   set, each segment also carries a per-utterance speaker **embedding** (formed
   by a local pause endpointer, ``endpointing.py``) so the gateway can keep
   speaker identity consistent across chunks.
2. **Speak** a line back into the call: render text to audio (a pluggable
   ``TTS_CMD``) and play it into the bot's virtual microphone so participants
   hear it — the actuator for agent interjections.

Everything degrades gracefully: with no ``LIVE_ASR_URL`` there are simply no
live captions; with no ``TTS_CMD`` a "say" request is logged, not spoken. Config
is read from the environment (see README). This is plumbing — the streaming ASR
service and a TTS voice are wired here but must be verified on the box.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import os
import struct
import subprocess

log = logging.getLogger("meeting_bot.live")

PULSE_MONITOR = os.environ.get("PULSE_MONITOR", "meet.monitor")
# The virtual PulseAudio source Chrome uses as its microphone; TTS is played
# into its sink so the meeting hears the bot.
VIRTUAL_MIC_SINK = os.environ.get("VIRTUAL_MIC_SINK", "vmic")
LIVE_ASR_URL = os.environ.get("LIVE_ASR_URL", "").strip()
# The per-meeting callback URL comes from the join request; this token authents
# the worker → gateway callback (defaults to the shared bot token).
LIVE_CALLBACK_TOKEN = os.environ.get(
    "LIVE_CALLBACK_TOKEN", os.environ.get("MEETING_BOT_TOKEN", "")
).strip()
# TTS command template: receives the text on stdin (or via {text}) and must
# write WAV/PCM audio to the path given as {out}. e.g. a piper invocation.
TTS_CMD = os.environ.get("TTS_CMD", "").strip()
# Optional per-utterance speaker embedding. EMBED_CMD is a shell template that
# reads PCM (s16le 16 kHz mono) from {in} and writes a JSON float array to {out}
# — e.g. a small onnx CAM++/pyannote embedder. Unset → no embeddings, and the
# gateway falls back to label passthrough. Attaching an embedding per utterance
# is what lets the gateway keep speaker identity CONSISTENT across chunks
# (voiceprint gallery — live_speakers.py). See README.
EMBED_CMD = os.environ.get("EMBED_CMD", "").strip()
# Energy-VAD threshold (RMS over s16le) used only to group audio into utterance
# windows for embedding — crude but dependency-free; tune per room/mic on the box.
try:
    _VAD_RMS = float(os.environ.get("LIVE_VAD_RMS", "300"))
except ValueError:
    _VAD_RMS = 300.0

_SAMPLE_RATE = 16000
_FRAME_BYTES = 3200  # 100 ms of 16 kHz s16le mono
_FRAME_MS = _FRAME_BYTES / (2 * _SAMPLE_RATE) * 1000.0  # 100.0


def _rms(frame: bytes) -> float:
    """Root-mean-square amplitude of an s16le PCM frame (no numpy/audioop)."""
    n = len(frame) // 2
    if n == 0:
        return 0.0
    total = 0
    for (s,) in struct.iter_unpack("<h", frame[: n * 2]):
        total += s * s
    return (total / n) ** 0.5


def _is_speech(frame: bytes) -> bool:
    return _rms(frame) >= _VAD_RMS


async def _embed_pcm(pcm: bytes) -> list[float] | None:
    """Compute a speaker embedding for one utterance's PCM via ``EMBED_CMD``.
    Fail-safe: returns None on any problem (missing cmd, bad output, error)."""
    if not EMBED_CMD or not pcm:
        return None
    tag = abs(hash(pcm)) % 10**8
    inp, outp = f"/tmp/utt-{tag}.pcm", f"/tmp/utt-{tag}.json"
    try:
        with open(inp, "wb") as f:
            f.write(pcm)
        cmd = EMBED_CMD.replace("{in}", inp).replace("{out}", outp)
        proc = await asyncio.create_subprocess_shell(
            cmd,
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.DEVNULL,
        )
        await proc.wait()
        if os.path.isfile(outp):
            with open(outp) as f:
                data = json.load(f)
            if isinstance(data, list) and data and all(
                isinstance(x, (int, float)) for x in data
            ):
                return [float(x) for x in data]
    except Exception as exc:
        log.warning("embed failed: %s", str(exc)[:200])
    finally:
        for p in (inp, outp):
            with contextlib.suppress(OSError):
                os.remove(p)
    return None


def live_enabled() -> bool:
    """Live streaming is possible when a streaming ASR service is configured.
    The per-meeting callback (where segments go) is supplied at join time."""
    return bool(LIVE_ASR_URL)


def _pcm_ffmpeg() -> subprocess.Popen:
    """ffmpeg reading the meeting's monitor → 16 kHz mono s16le PCM on stdout."""
    return subprocess.Popen(
        [
            "ffmpeg", "-nostdin", "-loglevel", "error",
            "-f", "pulse", "-i", PULSE_MONITOR,
            "-ac", "1", "-ar", str(_SAMPLE_RATE), "-f", "s16le", "-",
        ],
        stdout=subprocess.PIPE,
        stdin=subprocess.DEVNULL,
    )


async def _forward_segment(meeting_callback: str, seg: dict) -> None:
    import httpx

    headers = {"Content-Type": "application/json"}
    if LIVE_CALLBACK_TOKEN:
        headers["Authorization"] = f"Bearer {LIVE_CALLBACK_TOKEN}"
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            await client.post(meeting_callback, headers=headers, json=seg)
    except Exception as exc:  # live is best-effort; never break the recording
        log.warning("live forward failed: %s", str(exc)[:200])


def _parse_asr_message(raw: str) -> list[dict]:
    """Normalise a WhisperLive-style ASR message into our segment shape.
    Defensive: protocols differ, so accept the common shapes and ignore the
    rest."""
    out: list[dict] = []
    try:
        data = json.loads(raw)
    except (ValueError, TypeError):
        return out
    segments = data.get("segments") if isinstance(data, dict) else None
    if isinstance(segments, list):
        for s in segments:
            if not isinstance(s, dict):
                continue
            txt = (s.get("text") or "").strip()
            if txt:
                out.append({
                    "text": txt,
                    "start_s": float(s.get("start", 0) or 0),
                    "end_s": float(s.get("end", 0) or 0),
                    "is_final": bool(s.get("completed", s.get("is_final", True))),
                })
    elif isinstance(data, dict) and (data.get("text") or "").strip():
        out.append({"text": data["text"].strip(), "is_final": True})
    return out


async def _embed_and_store(utt: object, windows: list) -> None:
    """Embed one utterance's PCM and append its (start, end, embedding) window."""
    emb = await _embed_pcm(b"".join(utt.frames))  # type: ignore[attr-defined]
    if emb is not None:
        windows.append((utt.start_s, utt.end_s, emb))  # type: ignore[attr-defined]
        del windows[:-50]  # keep the recent-window list bounded


async def _asr_reader(ws, meeting_callback: str, chunking: bool, windows: list) -> None:
    """Read ASR messages, tag each segment with the best-overlapping utterance
    embedding (when chunking), and forward to the gateway live bus."""
    from . import endpointing

    async for message in ws:
        for seg in _parse_asr_message(
            message if isinstance(message, str) else message.decode()
        ):
            if chunking:
                emb = endpointing.pick_embedding(
                    float(seg.get("start_s", 0.0)),
                    float(seg.get("end_s", 0.0)),
                    windows,
                )
                if emb is not None:
                    seg["embedding"] = emb
            await _forward_segment(meeting_callback, seg)


async def stream_transcription(meeting_callback: str, stop: asyncio.Event) -> None:
    """Pump call audio → ASR WS → gateway live bus until ``stop`` is set.

    The ASR (WhisperLive-style) segments on its own VAD, so its segments are
    already utterance-aligned. When ``EMBED_CMD`` is set we additionally run a
    local energy-VAD endpointer to form utterance windows, compute a speaker
    embedding per window, and attach it to the overlapping ASR segment — giving
    the gateway the voiceprints it needs to keep speaker identity consistent
    across chunks. With no ``EMBED_CMD`` this is exactly the old batch-style
    stream (text only). No-op unless live is configured."""
    if not live_enabled():
        return
    try:
        import websockets
    except Exception:
        log.warning("websockets not installed — live transcription disabled")
        return

    from . import endpointing

    chunking = bool(EMBED_CMD)  # only pay for VAD/embeddings when an embedder is set
    windows: list[tuple[float, float, list[float]]] = []
    endpointer = endpointing.Endpointer(frame_ms=_FRAME_MS)
    tasks: set[asyncio.Task] = set()

    def _spawn(coro) -> None:
        t = asyncio.create_task(coro)
        tasks.add(t)
        t.add_done_callback(tasks.discard)

    proc = _pcm_ffmpeg()
    try:
        async with websockets.connect(LIVE_ASR_URL, max_size=None) as ws:
            reader = asyncio.create_task(
                _asr_reader(ws, meeting_callback, chunking, windows)
            )
            loop = asyncio.get_event_loop()
            while not stop.is_set():
                chunk = await loop.run_in_executor(
                    None, proc.stdout.read, _FRAME_BYTES
                )
                if not chunk:
                    break
                await ws.send(chunk)
                if chunking:
                    utt = endpointer.push(chunk, _is_speech(chunk))
                    if utt is not None:
                        _spawn(_embed_and_store(utt, windows))
            if chunking:
                last = endpointer.flush()
                if last is not None:
                    await _embed_and_store(last, windows)
            reader.cancel()
    except Exception as exc:
        log.warning("live transcription stopped: %s", str(exc)[:200])
    finally:
        with contextlib.suppress(Exception):
            proc.kill()


async def speak(text: str) -> None:
    """Render ``text`` to audio and play it into the bot's virtual mic so the
    meeting hears it. No-op-with-log when no TTS_CMD is configured."""
    if not TTS_CMD:
        log.info("say (no TTS configured, not spoken): %s", text[:200])
        return
    out = f"/tmp/say-{abs(hash(text)) % 10**8}.wav"
    cmd = TTS_CMD.replace("{out}", out).replace("{text}", text)
    try:
        proc = await asyncio.create_subprocess_shell(
            cmd,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.DEVNULL,
        )
        await proc.communicate(text.encode())
        if os.path.isfile(out):
            # Play into the virtual mic's sink so Chrome (using vmic as its
            # microphone) transmits it to the call.
            play = await asyncio.create_subprocess_exec(
                "paplay", f"--device={VIRTUAL_MIC_SINK}", out,
                stdout=asyncio.subprocess.DEVNULL,
                stderr=asyncio.subprocess.DEVNULL,
            )
            await play.wait()
    except Exception as exc:
        log.warning("speak failed: %s", str(exc)[:200])
    finally:
        with contextlib.suppress(OSError):
            os.remove(out)

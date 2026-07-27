# CommandCenter Meeting Bot (self-hosted)

A **fully self-hosted** meeting-joining worker — a headless-Chrome (Playwright)
participant that joins a meeting link, records the call audio, and hands it back
to CommandCenter. **No third-party cloud, no per-hour API.** The only cost is
the machine this runs on.

It exists so the AI Note Taker's "Join call" feature (spec §3.13) can be driven
entirely in-house: the gateway's `selfhosted` bot provider talks to this worker
over a small HTTP contract, and the recording flows into the normal
transcribe → diarize → speaker-name → summary pipeline like any other recording.

## Why it's a separate service

Each bot **is a real headless Chrome joining a live WebRTC call** — roughly
**1–3 GB RAM + up to 2 CPU cores per concurrent meeting**, and this MVP runs
**one meeting per instance** (scale out by running more instances). That does
**not** fit CommandCenter's small default VPS, so this worker is deliberately
standalone: run it on the upsized VPS or a dedicated box.

## HTTP contract

| Method | Path | Body / Result |
|---|---|---|
| POST | `/bots` | `{meeting_url, bot_name, live_callback?}` → `{id, status}` |
| GET | `/bots/{id}` | → `{id, status, download_url\|null, error\|null}` |
| POST | `/bots/{id}/leave` | leave now → `202` |
| POST | `/bots/{id}/say` | `{text}` → speak into the call → `202` |
| GET | `/bots/{id}/recording` | audio bytes (when `status == "done"`) |
| GET | `/health` | `{ok: true, active: N}` |

Statuses: `joining → waiting_room → in_call → processing → done` (or `failed` /
`not_admitted`). Optional `Authorization: Bearer <MEETING_BOT_TOKEN>`.

## Live streaming + speaking (optional, for real-time agents)

Beyond batch record-then-transcribe, the worker can **stream** the transcript
live and **speak** back into the call — the foundation for agents that act
mid-meeting:

- **Live transcript:** set `LIVE_ASR_URL` to a streaming ASR WebSocket
  (self-hosted WhisperLive-style). While in-call the worker tees the audio to it
  and POSTs each segment to the `live_callback` URL the gateway passes at join
  (the gateway builds it from `NOTES_LIVE_CALLBACK_BASE`). The gateway fans those
  out to live captions (`GET /notes/meetings/{id}/live`) and to agents.
- **Consistent live speakers (pause-chunked spine):** set `EMBED_CMD` to attach a
  per-utterance speaker **embedding** to each segment. The worker runs a local
  pause endpointer (VAD on natural pauses, not fixed windows — `endpointing.py`),
  computes an embedding per utterance, and tags the overlapping ASR segment. The
  gateway's voiceprint gallery (`live_speakers.py`) then keeps speaker ids stable
  across chunks and binds names from self-intros — so an agent knows *who* is
  speaking live. With no `EMBED_CMD`, segments are text-only (unchanged).
- **Speak into the call:** `POST /bots/{id}/say {text}` renders text via `TTS_CMD`
  (a shell template with `{text}`/`{out}`, e.g. a piper invocation producing a
  WAV) and plays it into the bot's **virtual microphone** so participants hear
  it. With no `TTS_CMD` the request is logged, not spoken.

Batch recording is unaffected by either — both are additive and gated.

## Run it

```bash
cd apps/services/meeting_bot
MEETING_BOT_TOKEN=$(openssl rand -hex 24) docker compose up -d --build
curl localhost:8080/health
```

Then point the gateway at it (on the CommandCenter host `.env`):

```
NOTES_BOT_PROVIDER=selfhosted
MEETING_BOT_URL=http://<worker-host>:8080
MEETING_BOT_TOKEN=<same secret as above>
```

## Environment

| Var | Default | Meaning |
|---|---|---|
| `MEETING_BOT_TOKEN` | _(none)_ | Bearer secret the gateway must send. Set it. |
| `MEETING_BOT_DATA` | `/data` | Where recordings are written. |
| `MEET_JOIN_TIMEOUT` | `150` | Seconds to wait in the waiting room before giving up. |
| `MEET_MAX_DURATION` | `14400` | Hard cap (s) on a single recording (4 h). |
| `MEET_ALONE_TIMEOUT` | `120` | Leave after being the only participant this long. |
| `LIVE_ASR_URL` | _(none)_ | Streaming-ASR WebSocket for live transcript. Unset → batch only. |
| `LIVE_CALLBACK_TOKEN` | `$MEETING_BOT_TOKEN` | Bearer for the worker→gateway live callback. |
| `TTS_CMD` | _(none)_ | Shell template (`{text}`,`{out}`) that renders speech to WAV. Unset → can't speak. |
| `EMBED_CMD` | _(none)_ | Shell template (`{in}` PCM s16le 16k mono → `{out}` JSON float array) that emits a per-utterance speaker embedding. Unset → text-only segments. |
| `LIVE_VAD_RMS` | `300` | Energy-VAD threshold (RMS over s16le) for the pause endpointer. Tune per room/mic. |
| `LIVE_SEGMENT_MAX_WAIT` | `2.5` | Max seconds a recognised segment waits for its utterance to close (and so for its embedding) before being forwarded untagged. Bounds live latency. |
| `CHROME_EXECUTABLE` | _(none)_ | Path to a Chrome/Chromium binary. Needed when the browser on the box wasn't installed by *this* Playwright version — otherwise the launch fails with "Executable doesn't exist at …/chromium-&lt;rev&gt;". |

## Status & honest caveats

- **Google Meet only** in this MVP — the most automatable via a browser.
  Zoom/Teams typically need their SDKs and are future work.
- **Browser automation is inherently brittle.** Meet's DOM is not a public API;
  the join selectors in `app/meet.py` are best-effort and **will need occasional
  tuning** as Meet's UI changes. This is the unavoidable maintenance cost of any
  meeting bot (the reason managed services like Recall.ai exist). Verify against
  a real meeting on the deployment box and adjust selectors as needed.
- **Consent:** the bot joins under a visible name; recording participants may
  legally require their consent depending on jurisdiction. Get it.
- Not yet load-tested for many concurrent instances; start with 1–2 per host and
  size up.

## What has actually been run (and what hasn't)

Verified by running the service against a real PulseAudio/Xvfb/Chromium stack —
not inferred:

| Verified | Result |
|---|---|
| Audio stack (`entrypoint.sh`) | `meet` + `vmic` null sinks and their monitors come up. |
| **Recording path** (`_start_ffmpeg`) | A 440 Hz tone played into `meet` was recovered from `meet.monitor` as 16 kHz mono Opus — decoded back at 440 Hz, RMS ≈ 2050. The exact production ffmpeg args. |
| **Speak path** (virtual mic) | Audio played into the `vmic` sink is captured from `vmic.monitor` — the source Chrome uses as its microphone. |
| **Energy VAD** (`LIVE_VAD_RMS`) | Real PCM: speech frames RMS ≈ 1700, silence 0.0. The `300` default separates them cleanly. |
| **Live streaming + embeddings** | Against a stub ASR + callback: 16 s of real audio streamed, 46 segments forwarded, **42 carrying a per-utterance embedding**. |
| HTTP contract | `/health`, bearer auth (401 without it), `POST /bots` → status lifecycle, clean `failed` + error text on a bad join. |
| Chromium launch | Launches headful under Xvfb and drives `page.goto` (needs `CHROME_EXECUTABLE` when the box's browser build isn't this Playwright's). |

**Still unverified — needs a real meeting:** the Google Meet **join flow itself**
(`_maybe_fill_name` / `_click_join` / `_await_admission` selectors) and the
end-to-end capture of an actual call. Meet's DOM is not a public API, so expect
to tune those selectors on first run. A real `EMBED_CMD` model (CAM++/pyannote)
and a `TTS_CMD` voice also still need to be installed and pointed at.

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

- **Live transcript:** while in-call the worker tees the audio to a streaming
  ASR and POSTs each segment to the `live_callback` URL the gateway passes at
  join (built from `NOTES_LIVE_CALLBACK_BASE`). The gateway fans those out to
  live captions (`GET /notes/meetings/{id}/live`) and to agents. Two ways to
  get an ASR, checked in this order:

  1. **`LIVE_ASR_URL`** — your own streaming ASR WebSocket (WhisperLive-style).
     Free per minute if you run one; wins when set.
  2. **`LIVE_TOKEN_URL`** (the normal path, wired by the deploy) — the worker
     asks the gateway for a short-lived token for whichever provider is keyed
     in **Settings → Models**, and streams to AssemblyAI directly. The master
     key never enters this container, and switching providers in Settings
     applies to the bot with no redeploy.

  With neither, the bot records and the batch pipeline transcribes after the
  call — but there are **no live captions**, which looks like success until the
  meeting ends. Only completed turns are forwarded; partials would stutter the
  same sentence down the console a word at a time.
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

## Deployment (the normal path)

**It deploys itself.** `infra/docker-compose.yml` carries a `meeting-bot`
service under the **`meetingbot` profile** (deliberately *not* `core` — each
in-call bot is a real Chrome, so it must never start just because someone
brought the stack up), and the deploy workflow builds and starts it, generates
`MEETING_BOT_TOKEN` once, and points the gateway at it:

```
MEETING_BOT_ENABLED=1                                  # opt out with 0
MEETING_BOT_URL=http://127.0.0.1:8095                  # gateway → worker
NOTES_BOT_PROVIDER=selfhosted
NOTES_LIVE_CALLBACK_BASE=http://host.docker.internal:8080   # worker → gateway
```

The worker publishes on host **8095** because the gateway itself owns 8080, and
binds to loopback only — nothing off-box can dispatch a bot. A build or start
failure skips the bot and never fails the deploy.

To turn it off: set `MEETING_BOT_ENABLED=0` in `/opt/acb/app/.env` and redeploy
(the container is removed; join-by-link just becomes unavailable).

## Run it standalone (dev)

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
| `LIVE_ASR_URL` | _(none)_ | Self-hosted streaming-ASR WebSocket. Takes priority over `LIVE_TOKEN_URL`. |
| `LIVE_TOKEN_URL` | _(set by deploy)_ | Gateway endpoint that mints streaming credentials from the key in Settings → Models. Unset **and** no `LIVE_ASR_URL` → no live captions. |
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

## When a join fails

Since the selectors *will* drift, the worker is built to explain itself rather
than to be guessed at. Every failure path captures a snapshot before raising:
the page URL and title, a body excerpt, **and the label of every button Meet
actually rendered** — which is what tells you the next selector to write.

```bash
# What the worker did, step by step
docker logs --tail 100 acb-meeting-bot

# Structured detail for one bot (controls list, page text)
curl -s -H "Authorization: Bearer $MEETING_BOT_TOKEN" \
  localhost:8095/bots/<bot-id>/diagnostics | jq

# The green room exactly as the bot saw it
curl -s -H "Authorization: Bearer $MEETING_BOT_TOKEN" \
  localhost:8095/bots/<bot-id>/screenshot -o /tmp/bot.png
```

From CommandCenter itself the same detail is at
`GET /notes/meetings/{meeting_id}/bot/diagnostics`, and the failure text now
shows on the Notes screen for 30 minutes after it happens.

The three failures that look identical from outside, and their fixes:

| Symptom | What it means | Fix |
|---|---|---|
| `Nobody admitted the notetaker within 150s` | It knocked; no one answered. | Click **Admit** when it knocks, or raise `MEET_JOIN_TIMEOUT`. |
| `Google Meet refused the join` | Signed-out guests can't enter this call. | Host starts the call first, or loosen the meeting's access setting. |
| `No join button on the meeting page` | A selector missed, or a dialog covered it. | Read the `controls` list in the error — it names the buttons that *were* there. |

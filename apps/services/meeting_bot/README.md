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
| POST | `/bots` | `{meeting_url, bot_name}` → `{id, status}` |
| GET | `/bots/{id}` | → `{id, status, download_url\|null, error\|null}` |
| POST | `/bots/{id}/leave` | leave now → `202` |
| GET | `/bots/{id}/recording` | audio bytes (when `status == "done"`) |
| GET | `/health` | `{ok: true, active: N}` |

Statuses: `joining → waiting_room → in_call → processing → done` (or `failed` /
`not_admitted`). Optional `Authorization: Bearer <MEETING_BOT_TOKEN>`.

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

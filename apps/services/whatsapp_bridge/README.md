# whatsapp_bridge

The **unofficial WhatsApp transport** for CommandCenter — pairs a **personal
number** by QR code (via the [whatsmeow](https://github.com/tulir/whatsmeow)
multi-device library) and streams its messages into the same WhatsApp app you
already use for a Cloud API number. It exists so you can manage a personal line
**without** going through Meta's WhatsApp Business API, app review, phone-number
migration, or the 24-hour messaging window.

> [!WARNING]
> **This is against WhatsApp's Terms of Service.** A personal number driven by
> an unofficial multi-device client **can be banned by WhatsApp** at any time.
> Use it only for a personal line you're willing to risk — never a business's
> primary number. When you're ready for a supported, ban-proof setup, connect a
> number through the Cloud API path instead (the app supports both side by side).

## Where it sits

```
  Your phone ──scan QR──▶ whatsapp_bridge (this service, holds the session)
                                │  normalized message JSON  ▲ /send /media
                                ▼                           │
                       gateway  POST /whatsapp/bridge/ingest │
                                │                            │
                    persist_sync_result + post-sync hooks    │
                                ▼                            │
                    the SAME triage brain (Reply Zero, intent, drafting,
                    search, pulse …) a Cloud API number gets
```

The bridge holds the WhatsApp session; the gateway holds **no** WhatsApp session
and never talks to WhatsApp. They authenticate to each other with a shared
secret (`WHATSAPP_BRIDGE_SECRET`). Inbound messages are normalized *here* into
the exact `SyncResult` shape the gateway's
`transport/bridge.py :: parse_bridge_payload` already consumes — so a personal
number reuses the entire vertical unchanged (`provider = 'whatsmeow'`).

## HTTP API (the gateway calls these)

| Method & path            | Body                                 | Returns            |
|--------------------------|--------------------------------------|--------------------|
| `POST /session`          | `{session}`                          | `{status, qr}`     |
| `GET  /session/{id}`     | —                                    | `{status, qr}`     |
| `POST /send`             | `{session,to,body,reply_to}`         | `{id}`             |
| `POST /media`            | `{session,media_id}`                 | raw bytes          |
| `POST /read`             | `{session,message_id,chat,sender}`   | `{ok}`             |
| `GET  /health`           | —                                    | `{ok}`             |

`session` is the `wa_accounts.id` (UUID) the gateway assigns when the user starts
pairing. `qr` is a ready-to-render `data:image/png;base64,…` of the current
pairing code — the frontend shows it with a plain `<img>`, and the phone scans it
under **WhatsApp → Linked devices → Link a device**.

All routes except `/health` require the `X-Bridge-Secret` header when a secret is
configured.

## Configure

Copy `.env.example` → `.env`. Key vars:

- `WHATSAPP_BRIDGE_ADDR` — listen address (default `:8790`).
- `WHATSAPP_BRIDGE_GATEWAY_URL` — the gateway base URL to stream messages to.
- `WHATSAPP_BRIDGE_SECRET` — shared secret; set the **same** value on the gateway.
- `WHATSAPP_BRIDGE_STORE` — sqlite path for the paired session (**treat as a
  secret**: whoever holds this file can send as the paired number).

On the gateway set the matching pair:

```
WHATSAPP_BRIDGE_URL=http://localhost:8790     # where this service listens
WHATSAPP_BRIDGE_SECRET=<same long random secret>
```

## Run

```bash
# from apps/services/whatsapp_bridge
cp .env.example .env && $EDITOR .env
go run .            # or: go build -o whatsapp_bridge . && ./whatsapp_bridge
```

Or with Docker (pure-Go, CGO-free static image):

```bash
docker build -t cc-whatsapp-bridge .
docker run --rm -p 8790:8790 \
  -e WHATSAPP_BRIDGE_GATEWAY_URL=http://host.docker.internal:8000 \
  -e WHATSAPP_BRIDGE_SECRET=your-secret \
  -v cc-wa-bridge:/data \
  cc-whatsapp-bridge
```

Then in the app: **Integrations → WhatsApp → Connect a personal number**, scan
the QR, and the number goes live. Sessions survive restarts (re-connected from
the sqlite store on boot).

## Notes / limits

- Personal WhatsApp has **no templates** and **no 24-hour window** — the composer
  always sends free-form text. `send_template` is unsupported by design.
- `group_subject` is left to the gateway (it names group chats from the chat
  record); the bridge doesn't fetch group metadata per message.
- Media is downloaded lazily: the inbound event caches the message proto keyed by
  message id, and `/media` re-downloads on demand — matching the Cloud API
  provider's lazy `download_media`.
- Pure Go, no CGO: uses `modernc.org/sqlite`, so it cross-compiles and ships as a
  static binary.

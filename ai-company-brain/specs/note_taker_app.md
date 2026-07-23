# AI Note Taker App — Architecture & Product Plan

> **Product:** CommandCenter · **Feature:** AI Note Taker app (`/notes`) · **Updated:** 2026-07-23 · **Version:** 0.1 (architecture — proposed)
> **Status:** 🔄 slice 1 COMPLETE (2026-07-23). **Slice 0:** migration `95_note_taker.sql`, `packages/acb_stt` (Groq/OpenAI/Deepgram BYOK), gateway `routes/notes/` (meeting CRUD, upload → transcription pipeline, audio playback), Next proxy, `/notes` shell. **Slice 1:** (a) notes generation on `acb_llm` — template→prompt compiler (`templates.py`), grounded map-reduce summarization + draft `action_item` extraction (`summaries.py`), auto-chained after transcription; (b) per-meeting SSE progress (`events.py` + Next stream proxy); (c) two-pane transcript↔notes detail with live progress + action-items rail; (d) **the in-browser recorder** — mic capture with a chunked, retrying, gap-checked uploader (`recorder.ts`, offline-tolerant), start/chunk/complete gateway endpoints (`recordings.py`), and the "studio" session screen (`session/[id]`, waveform + timer + pause/stop). **Slice 2 (mostly done):** loop-closure — (a) HITL `action_item` approve/reject/bulk-approve → LOCAL `gtd_items` task with a `meeting` `origin` provenance link + `resulting_task_id` back-reference (`actions.py`), a keyboard-friendly triage rail with deep-links into `/tasks`; (b) **follow-up email** — attendee capture (`meeting.attendees` JSONB, migration `96_note_taker_attendees.sql`; inline chip editor), an LLM recap draft (`share.py`) surfaced in a HITL compose modal (editable to/subject/body + account picker) that sends via the existing `/email/send`. **AI intelligence (§4 Tier-1):** **ask-the-meeting** — grounded Q&A over a single meeting's transcript (`qa.py`), reusing the summarization grounding discipline; for long transcripts it keyword-ranks segments (never a silent truncation) rather than needing precomputed embeddings; answers cite segment numbers, and the UI `AskPanel` turns each citation into a click that scrolls the transcript there and cues the audio (§5.3 provenance-you-can-touch). **Plumbing correction (2026-07-23):** `acb_stt` now routes transcription through the platform's LiteLLM machinery — the STT model is a first-class **`tier-stt`** tier (`infra/litellm/config.yaml`, `_TIER_ALIAS_MAP`/`_TIER_LABELS`, editable in Settings → Models), resolved/keyed exactly like the chat tiers and transcribed via `litellm.atranscription` with usage emitted for observability. The bespoke httpx Groq/Deepgram/OpenAI providers were removed. **Resume point: more §4 AI features (scratch-notes merge, glossary), share-to-chat, then slice 3 — self-host STT + open diarization (add a `selfhost/faster-whisper` option to `tier-stt`).** The `meeting`/`action_item` tables from `01_schema.sql` L91–111 are active.
> **Sibling docs:** [`note_taker_research_2026-07.md`](note_taker_research_2026-07.md) — the evidence base (Meetily deep dive, landscape survey, ASR/diarization SOTA, browser-capture facts). Read it for *why*; this doc is *what and how*.
> **Reference precedents:** [`task_manager_app.md`](task_manager_app.md) (app spec shape, provider-layer thinking, HITL philosophy) and `gateway/routes/tasks/capture_email.py` (the Email→Task capture pattern this app mirrors as Meeting→Task).

---

## 0. One-paragraph thesis

The Note Taker is the **ears of the Command Center**. You open `/notes`, hit **record** on the conversation happening around you (or in another tab), and hit **stop** when it ends. The app then produces a speaker-attributed transcript and detailed, *transcript-grounded* meeting notes — decisions, discussion, action items with owners — and turns them into leverage through the apps that already exist: action items become GTD tasks through the same HITL capture flow email uses (`action_item.status: draft→approved→created`, then `resulting_task_id`), the summary becomes a follow-up email via `/email/send`, and the meeting becomes a first-class object agents can reason over in chat. We deliberately **do not** adopt Meetily's desktop infrastructure: capture happens in the browser we already own, transcription happens server-side behind a **pluggable STT provider layer** (BYOK cloud for zero-infra, self-hosted Whisper-family for privacy — mirroring how `acb_llm` treats LLM providers), and summarization runs through the existing `acompletion_with_fallback` + model-roles machinery. One new gateway route group, one new optional compose service, zero new frontend frameworks.

**The one-sentence pitch:** *record → transcript → notes → "3 tasks created, follow-up email drafted" — without the meeting audio ever leaving your server unless you choose a cloud tier.*

---

## 1. Product definition

### 1.1 The core loop (v1)

```
 OPEN /notes  →  RECORD (start/pause/stop)  →  TRANSCRIBE (+diarize)  →  NOTES  →  ACT
   library        live session screen           pipeline w/ honest        editable,     tasks · email · chat
   + "New         mic (+ tab audio on           per-stage progress        grounded      via existing apps
   recording"     Chromium), waveform,                                    summary
                  live captions (later)
```

Requirements distilled from the ask:
- **R1** Start/stop (and pause) recording of a live conversation from inside the app. Works for in-room conversations (mic) and online meetings playing on the same machine (tab audio where the browser allows).
- **R2** On stop, finish transcription and produce a **detailed meeting-notes document** — not a three-line abstract: sections for context, discussion by topic, decisions, open questions, and action items with owner/due/confidence, each grounded in transcript segments.
- **R3** Act on the notes: create tasks (GTD app), send the summary/follow-up (Email app), post/share to chat (Chat app) — reusing those apps' existing endpoints, never reimplementing them.
- **R4** Everything falls within CommandCenter's platform rules: gateway-only API surface, org SSO auth, HITL approval before outward writes, design-system UI, BYOK keys in the encrypted key store.

### 1.2 Explicit non-goals (v1)

- **No meeting bot** that joins Zoom/Meet/Teams calls (that's the Vexa/Attendee pattern — phase 5+ option, §6).
- **No desktop companion app** (revisit only if tab-audio capture proves insufficient in practice).
- **No video**, screen-recording, or slide capture.
- **No real-time translation** in v1 (two-pass translation of the *notes* ships early; live translated captions later).
- **Not a general document editor** — notes are meeting-anchored; the knowledge-base ambitions route through Memory/entity graph instead.

### 1.3 Personas / situations to design for

1. **The huddle** — 2–6 people around a laptop in the Fracktal office; mic-only capture; speakers overlap; Hindi/English code-switching is normal.
2. **The online meeting** — user is in a Meet/Zoom call in another tab; wants both sides captured (mic + tab audio, Chromium-only; UI must degrade gracefully elsewhere).
3. **The solo debrief** — voice memo after a customer visit or factory walk; one speaker; phone browser (mic capture works on mobile; recording UI must be responsive).
4. **The retro import** — an audio file from a phone recorder or WhatsApp voice note; upload instead of record; identical pipeline downstream.

---

## 2. Research verdict (what we take from whom)

Full evidence in [`note_taker_research_2026-07.md`](note_taker_research_2026-07.md). The decisions it drives:

| Source | What we take | What we reject |
|---|---|---|
| **Meetily** (26k★, MIT, Tauri desktop) | The product loop; dual-path audio concept (pristine recording vs VAD-gated transcription); Silero VAD tuning (0.50/0.35, 2s redemption, 250ms min); data-model shape (segments w/ audio offsets → click-to-seek; summary-job state machine w/ backup; markdown+JSON notes); the **template→prompt compiler** + map-reduce + two-pass-language summarization design; grounded action-items table (Owner/Task/Due/Segment/Timestamp) | Tauri shell; native capture stack; in-process STT (client hardware lottery — their #456); SQLite + plaintext keys; single-user model; **channel-labels-as-diarization** (real diarization is their paywalled PRO feature — we ship it open) |
| **WhisperLiveKit** (10.6k★, Apache-2.0) | The live-captions donor: browser→WebSocket streaming ASR (SimulStreaming) + streaming diarization (Sortformer/diart), run as a service (slice 4) | Using it as the *batch* engine — batch quality comes from the WhisperX-style pipeline |
| **Vexa** (Apache-2.0) | Server-stack shape validation (gateway/STT-service/Postgres/Redis split); the later meeting-bot path; their meetings→entities agents layer as a reference for our Memory integration | Bot-first capture as the primary UX |
| **Scriberr / OpenTranscribe** | Product-shape validation (self-hosted web app: record/upload → transcribe → diarize → summarize → chat-with-transcript); OpenTranscribe's WhisperX+pyannote+worker-queue pipeline blueprint | Scriberr is paused (quarry only); OpenTranscribe is AGPL (patterns only, no code) |
| **Anarlog (ex-Hyprnote) / Minutes** | UX patterns: **scratch-notes merged with transcript** into the final summary (the Granola pattern, §4.3); structured decisions/action-items extraction; MCP-style agent access to notes (§3.10) | Their desktop packaging |
| **ASR/diarization SOTA** | Hybrid pipeline consensus (streaming captions + authoritative batch re-pass); `faster-whisper large-v3-turbo` int8 as CPU-viable default; Parakeet-TDT-0.6B-v3 as the GPU speed play; **pyannote community-1** (GPU) / **senko** (CPU) diarization; Silero VAD v6; word↔speaker merge at word level | Anything license-encumbered: SenseVoice weights, NVIDIA NIM containers, AGPL codebases |

**The competitive observation that shapes the build:** every strong open project is either desktop-native (Meetily, Anarlog, Vibe, Minutes) or bot-based (Vexa, Attendee). A **web-native, suite-integrated** note taker whose output flows directly into tasks/email/chat — with diarization in the open tier — occupies space none of them serve. Our moat is not the recorder; it's the loop closure.

---

## 3. Architecture

### 3.1 Placement (DOX: "place before building")

| Piece | Location | Kind |
|---|---|---|
| Frontend app | `workbench/control_plane/src/app/notes/` (`page.tsx`, `components/`, `lib/{api,types,store}.ts`) — replaces the `ComingSoon` stub | UI (route segment, like `tasks/`) |
| Next→gateway proxy | `workbench/control_plane/src/app/api/notes/[...path]/route.ts` — copy of the tasks proxy (auth headers, multipart + binary passthrough already handled) | UI plumbing |
| Gateway API | `apps/services/gateway/gateway/routes/notes/` — `__init__.py` (router, prefix `/notes`), `meetings.py`, `recordings.py`, `pipeline.py`, `summaries.py`, `actions.py`, `settings.py`; registered in `gateway/main.py` beside the tasks router (~L738) | API (route group, like `routes/tasks/`) |
| Transcription providers | `packages/acb_stt/` — new shared package: provider interface + cloud BYOK providers + self-host client (mirrors `acb_llm`'s role for LLMs) | shared package |
| Self-host STT worker | `apps/services/transcription/` — optional FastAPI service (compose profile `stt`): faster-whisper + diarization + VAD; OpenAI-compatible `/v1/audio/transcriptions` plus a richer `/transcribe_diarized` | deployed service (optional) |
| Live-captions service | (slice 4) WhisperLiveKit container in `infra/docker-compose.yml` profile `stt-live` — bought, not built | deployed service (optional) |
| Agent skill | `apps/skills/skill-notes/` — `list_meetings`, `get_meeting_notes`, `search_transcripts`, `summarize_meeting`, `extract_action_items` over the `/notes` API (mirrors `skill-task-gtd`) | skill |
| Migration | `infra/postgres/95_note_taker.sql` (next free number after 93) + ORM additions in `packages/acb_graph/acb_graph/models.py` | schema |

Everything stays in this monorepo. The optional services are compose profiles, not separate repos — Meetily's costliest lesson was making users operate multiple moving parts; ours ship as `--profile stt` and are invisible when a cloud STT key is configured instead.

### 3.2 System diagram

```mermaid
flowchart LR
  subgraph Browser["/notes (Next.js)"]
    REC["Recorder\nMediaRecorder (mic)\n+ tab audio (Chromium)\nAudioWorklet PCM (slice 4)"]
    UI["Session & Library UI\nSSE progress · transcript ↔ notes"]
  end
  subgraph Gateway["gateway/routes/notes/"]
    API["REST: meetings · recordings\npipeline · summaries · actions"]
    PIPE["pipeline.py\njob state machine"]
  end
  subgraph STT["acb_stt provider layer"]
    CLOUD["BYOK cloud STT\n(Groq/OpenAI/Deepgram…)"]
    SELF["apps/services/transcription\nfaster-whisper turbo int8 + senko (CPU)\nWhisperX + pyannote community-1 (GPU)"]
    LIVE["WhisperLiveKit\n(slice 4, live captions)"]
  end
  LLM["acb_llm\nacompletion_with_fallback\nmodel roles: meeting_summary…"]
  DB[("Postgres\nmeeting · transcript_segment\nmeeting_note · summary_run\naction_item")]
  BLOB[("blob store\naudio artifacts")]
  subgraph Apps["existing apps"]
    TASKS["/tasks/capture/from-meeting\n(new, mirrors from-email)"]
    EMAIL["/email/send"]
    CHAT["/chat sessions"]
    MEM["Memory / entity graph"]
  end
  REC -- "chunked upload (webm/mp4)" --> API
  UI <-- "SSE job progress" --> PIPE
  API --> BLOB
  PIPE --> STT
  STT --> DB
  PIPE --> LLM
  LLM --> DB
  UI --> API
  API -- "HITL approve" --> TASKS
  API --> EMAIL
  API --> CHAT
  PIPE -. "entities, embeddings" .-> MEM
```

### 3.3 Capture layer (browser — the part Meetily can't teach us)

Grounded in the browser facts of appendix §7:

- **Baseline (every browser incl. mobile):** `getUserMedia` mic capture → **MediaRecorder** (`audio/webm;codecs=opus` on Chromium/Firefox, `audio/mp4` AAC on Safari — feature-detect, accept both server-side). Chunked upload every ~15s via the existing multipart plumbing (`gateway/routes/workspace.py` already whitelists `.webm/.mp3/.wav/.mp4`); chunks are appended server-side into one continuous file (MediaRecorder timeslice chunks are **not** independently decodable — never treat them as standalone files). Crash/refresh mid-meeting therefore loses at most the last chunk interval — Meetily's "incremental saver" lesson, translated.
- **Online-meeting enhancement (Chromium only):** `getDisplayMedia({audio:true})` tab-audio as a **second, separate track**. Never mix client-side: mic track keeps `echoCancellation:true` (otherwise remote voices are captured twice — acoustically and digitally — and the transcript doubles); display track gets **no** audio processing. Both streams upload as separate channels; the server mixes for the archival recording and transcribes **per channel**, which yields a free, perfect "you vs. them" speaker prior that diarization then refines — the honest version of Meetily's `mic|system` speaker column. Firefox/Safari: capability-detect and show "tab audio unavailable in this browser — use headphones + mic, or Chrome" affordance.
- **Pause/resume, device picker, input level meter** before and during recording; wake-lock while recording; `beforeunload` guard.
- **Recording is app-global, not page-local:** the active session lives in the `AppShell` (precedent: the Tasks Focus-Mode dock) so the user can answer email mid-meeting while a discreet recording pill keeps running (§5.2).
- **Slice 4 (live captions):** parallel AudioWorklet path — Float32→16kHz Int16 PCM frames over WebSocket to WhisperLiveKit. This is additive; the MediaRecorder upload path remains the archival source of truth.

### 3.4 Transcription: `acb_stt` provider layer + tiers

Same shape as `acb_llm`: a provider interface, BYOK keys in the encrypted `provider_keys` store, and a user-facing tier that maps to the *existing* `stt` placeholder in Settings→Models (`ALL_TIERS` already declares it — we make it real).

```python
class SttProvider(Protocol):
    async def transcribe(self, audio: AudioRef, opts: SttOptions) -> Transcript: ...
    # Transcript = segments[{start, end, text, words?[{w, start, end}], channel?, speaker?, confidence?}]
    def capabilities(self) -> SttCaps  # diarization? word_timestamps? languages? streaming?
```

| Tier | Provider | Diarization | When |
|---|---|---|---|
| **A — cloud BYOK** (zero infra, day-1 default) | Groq-hosted `whisper-large-v3-turbo` (fast/cheap), OpenAI, Deepgram (has native diarization) — via `acb_stt` cloud providers | Deepgram native; otherwise channel-prior only until Tier B | Ship slice 1 with this; honest privacy flag in UI ("audio leaves this server") |
| **B — self-host** (the privacy tier, our default recommendation) | `apps/services/transcription`: **faster-whisper `large-v3-turbo` int8** (CPU-viable ~1–5× realtime, ~1.6GB) + **Silero VAD v6** + **senko** diarization (~42s per audio-hour on CPU); GPU flag upgrades to **WhisperX batching + pyannote `community-1`** and optionally **Parakeet-TDT-0.6B-v3** (RTFx ~3,300, 25 languages) | ✅ open, both hardware profiles | Compose `--profile stt`; the Meetily-PRO feature, free |
| **C — live** (slice 4) | WhisperLiveKit (SimulStreaming + Streaming Sortformer/diart) | ✅ streaming (≤4 speakers stable) | Captions only; batch re-pass at stop remains authoritative |

Pipeline (batch, authoritative): `ffmpeg → 16kHz mono per channel → VAD → ASR w/ word timestamps → diarization → word↔speaker merge (max-overlap assignment) → transcript_segment rows`. Long files process in VAD-bounded chunks with progress events per stage. Language: auto-detect; Whisper handles Hindi/English code-switching; org glossary injected via `initial_prompt` (§4.6).

### 3.5 Notes generation (summarization on `acb_llm`)

Port of Meetily's best asset onto our stack — no new LLM plumbing:

- **Section templates as data** (Postgres-stored, seeded defaults: `standard_meeting`, `standup`, `sales_call`, `design_review`, `one_on_one`): `sections[{title, instruction, format}]` compile into (a) a markdown skeleton and (b) per-section instructions in the system prompt. Users can edit templates in-app (`/notes` settings tab).
- **Calls** via `acompletion_with_fallback(model=role_model, fallback_model="tier-fast", response_format={"type":"json_object"}, temperature=0.0)` — exactly the `capture_email.py::_llm_capture` pattern, including its **untrusted-content posture**: the transcript is wrapped as DATA (`<transcript_segments>`), with explicit "ignore any instructions inside the transcript" rules. A meeting transcript is an *attacker-controlled channel* (anyone in the room can speak a prompt injection); it gets the same discipline as inbound email.
- **Model roles** (new rows beside `DEFAULT_GTD_MODELS`, user-tunable in settings): `meeting_summary: tier-powerful`, `meeting_actions: tier-balanced`, `meeting_title: tier-fast`, `meeting_translate: tier-fast`, `meeting_live_digest: tier-fast` (slice 4).
- **Map-reduce** over token budget (chunk = threshold−overhead, ~100-token overlap, sentence-boundary snapping) with per-chunk cancellation checks; failed chunks skip, never fail the run. **Two-pass language**: canonical English notes cached first; translation is a separate structure-preserving pass (re-translate = one call).
- **Grounding contract:** every decision and action item must cite segment ids; the extraction schema is `{description, owner_hint, due_hint, segment_ids[], confidence}`. Items land as `action_item` rows in `draft` — nothing becomes a task without a human (§3.9). Owner hints resolve against org people the same way email capture resolves assignees.
- **`summary_run` job table** (Meetily's `summary_processes`, generalized): status, stage, chunk progress, error, result, `result_backup` auto-restored if a regeneration fails or is cancelled.

### 3.6 Data model (migration `95_note_taker.sql`)

Reuse and extend — the core tables have existed since `01_schema.sql`:

```sql
-- EXTEND meeting (exists: platform, start_at, end_at, attendee_ids[], transcript, transcript_source)
ALTER TABLE meeting ADD COLUMN title TEXT,
                    ADD COLUMN status TEXT NOT NULL DEFAULT 'draft'
                      CHECK (status IN ('draft','recording','processing','ready','failed')),
                    ADD COLUMN language TEXT, ADD COLUMN duration_s REAL,
                    ADD COLUMN owner_email TEXT, ADD COLUMN template_key TEXT,
                    ADD COLUMN summary_json JSONB, ADD COLUMN summary_md TEXT;
-- meeting.platform gains 'in_person' + 'upload' via widened CHECK; transcript column stays as the
-- flattened-text cache; transcript_source records provider+model ('faster-whisper/large-v3-turbo@int8').

CREATE TABLE meeting_recording (   -- one per captured/uploaded audio stream
  id UUID PK, meeting_id FK, channel TEXT CHECK (channel IN ('mic','system','mixed','upload')),
  artifact_path TEXT, mime TEXT, duration_s REAL, byte_size BIGINT, created_at TIMESTAMPTZ);

CREATE TABLE transcript_segment (  -- the click-to-seek unit (Meetily's transcripts table, multi-user)
  id UUID PK, meeting_id FK CASCADE, recording_id FK, idx INT,
  start_s REAL, end_s REAL, text TEXT, speaker_label TEXT,          -- 'S1', 'S2'…
  speaker_person_id UUID NULL REFERENCES person(id),                -- resolved identity (§4.5)
  channel TEXT, confidence REAL, words JSONB NULL,                  -- word timings when available
  embedding vector(1536) NULL);                                     -- pgvector: ask-the-meeting (§4.2)

CREATE TABLE meeting_note (        -- dual-format editable notes (BlockNote lesson)
  meeting_id UUID PK FK, notes_md TEXT, notes_json JSONB, updated_by TEXT, updated_at TIMESTAMPTZ);

CREATE TABLE summary_run (         -- job state machine
  id UUID PK, meeting_id FK, kind TEXT,             -- summary | actions | translate | title
  status TEXT CHECK (status IN ('queued','running','done','failed','cancelled')),
  stage TEXT, chunk_done INT, chunk_total INT, model TEXT, error TEXT,
  result JSONB, result_backup JSONB, started_at, finished_at);

-- action_item: REUSED AS-IS (meeting_id, assignee_id, description, confidence,
-- status draft|approved|created|rejected, resulting_task_id) + ADD segment_ids UUID[], due_hint TEXT.
```

Audio artifacts go through the existing blob/workspace storage (`packages/acb_memory/blob_store.py`), with a retention setting (default: keep audio 90 days, transcripts forever — configurable, §3.13).

### 3.7 Gateway API surface (`/notes`)

```
POST   /notes/meetings                       create (status=recording|draft)
GET    /notes/meetings?query=&person=&from=  library list (search: FTS + pgvector)
GET    /notes/meetings/{id}                  full detail (segments, notes, actions, runs)
PATCH  /notes/meetings/{id}                  title/template/attendees edits
DELETE /notes/meetings/{id}                  (destructive → confirm UI; audit_event row)
POST   /notes/meetings/{id}/recordings/chunk chunked upload (multipart append, channel param)
POST   /notes/meetings/{id}/recordings/complete  finalize + enqueue pipeline
POST   /notes/meetings/{id}/upload           retro import path (single file)
GET    /notes/meetings/{id}/audio            ranged streaming for the seek-player
GET    /notes/meetings/{id}/events           SSE: pipeline stage/progress + live partials later
POST   /notes/meetings/{id}/summarize        (re)run notes with template/model override
POST   /notes/meetings/{id}/translate        two-pass translation target
GET|PUT /notes/meetings/{id}/note            editable notes doc (md+json)
POST   /notes/meetings/{id}/actions/extract  (re)extract action items → draft rows
POST   /notes/actions/{id}/approve|reject    HITL gate → on approve calls /tasks/capture/from-meeting
POST   /notes/meetings/{id}/share/email      compose+send via /email/send (notes as body/attachment)
POST   /notes/meetings/{id}/share/chat       post summary into a chat session
GET|PUT /notes/settings                      tiers, model roles, templates, retention, consent text
GET    /notes/segments/{id}/speaker          PATCH speaker relabel (propagates to same-label segments)
```

Realtime: **SSE only** in slices 1–3 (matches the platform; `EventSource` precedents in chat + observability). The first WebSocket in the platform arrives only with live captions (slice 4), and even then it terminates at the WhisperLiveKit service — the gateway stays SSE-only and merely mints a short-lived signed token for the WS connection (decision D7).

### 3.8 Frontend app (`src/app/notes/`)

Anatomy (all design-system compliant — tokens, shared `Tabs`/`FilterPills`/page-header, Geist, lucide):

- `page.tsx` — library (meeting list + search + empty/onboarding state) and entry to a new session.
- `session/` — the recording screen (§5.1) — device picker, consent line, waveform, timer, pause/stop, marker button, live captions region (slice 4).
- `meeting/[id]/` — the detail view: transcript pane ↔ notes pane with bidirectional grounding highlights (§5.3), audio seek-player with speaker-colored timeline, action-items rail with approve/reject, share menu (email/chat), re-summarize with template/model picker.
- `lib/store.ts` — hand-rolled store like `taskStore.ts`; recording state itself lives in an `AppShell`-level provider (the dock, §5.2).
- `lib/recorder.ts` — MediaRecorder/track management, chunk uploader with retry queue (offline-tolerant: chunks buffer in IndexedDB until the network returns — factory-floor wifi reality).

### 3.9 Cross-app actions (the loop closure)

| Flow | Mechanism | Precedent copied |
|---|---|---|
| Action item → Task | `POST /tasks/capture/from-meeting` (new module beside `capture_email.py`): same preview→enhance→create contract, `origin={kind:"meeting", meeting_id, segment_ids}`; writes `action_item.resulting_task_id` on create; bulk "approve all above 0.8 confidence" | `gateway/routes/tasks/capture_email.py` + `TaskCaptureModal.tsx` |
| Notes → Email | Compose follow-up via `/email/send`: LLM-drafted recap addressed to attendees (resolved emails), notes attached as artifact (md/PDF) using `load_artifact_attachments` | `email/transport/send.py` |
| Notes → Chat | Create/post to a chat session so the operator (or an agent) can discuss the meeting; deep-link back to `/notes/meeting/{id}` | `routes/chat.py` |
| Meeting → Memory | On `ready`: entities/commitments to the entity graph + episodic memory (Mem0/Graphiti), embeddings on segments — powers §4.2/§4.4 | `acb_memory` |
| Agents → Notes | `skill-notes` (list/search/get/summarize/extract) so the task-manager agent can run "review last week's meetings for unassigned commitments" | `skill-task-gtd` |

All outward effects are **HITL-gated** (constraint #4/#8 posture): tasks require approval per item (or explicit bulk approval), email opens a compose-preview before send, chat posts are explicit user actions. `audit_event` rows on approve/send/delete.

### 3.10 Agent & AI-platform integration

The meeting becomes an object of the agent economy: `skill-notes` exposes it to MAF agents; the orchestrator can schedule a nightly "meeting janitor" run (unresolved action items → nudge; meetings missing notes → summarize); chat can answer "what did we decide about the TwinDragon electronics enclosure?" by `search_transcripts` + `get_meeting_notes`. Nothing here needs new runtime — it's one more skill package and (optionally) one registered agent later.

### 3.11 Deployment reality

Prod is a single Hostinger VPS (no GPU). Day-1 posture: **Tier A (cloud BYOK) works with zero new containers**; **Tier B CPU** (`--profile stt`: faster-whisper turbo int8 + senko) is the self-host default and is honest about turnaround (~real-time×1–5 for ASR + ~42s/h diarization on CPU — a 1h meeting ≈ ready in minutes, communicated by the honest pipeline UI §5.4). GPU box later upgrades Tier B to WhisperX+pyannote/Parakeet with 1–3 min/h totals, no schema or API change. pyannote weights are HF-gated — deploy automation provisions the token and pre-caches weights (appendix §8).

### 3.12 Security, privacy, consent

- Recording consent is a product feature: configurable consent line on the session screen ("This conversation is being recorded and transcribed"), optional periodic audible/visible indicator, and a UI hint for jurisdictions/policies requiring announcement. Default-on banner; org-configurable text.
- Audio + transcripts are org data in Postgres/blob store behind SSO; retention policy per §3.6; delete is real (cascade + blob removal + audit row).
- Transcript text is treated as **untrusted input** everywhere it meets an LLM (§3.5) and is never interpolated into prompts as instructions.
- Tier A clearly labels that audio goes to the configured cloud provider; Tier B is the "audio never leaves the box" mode (Meetily's whole pitch, preserved as a toggle rather than an architecture).
- No plaintext keys anywhere — STT keys live in the existing encrypted `provider_keys` store (Meetily anti-lesson).

---

## 4. AI integration — brainstorm (ranked, with build cost)

**Tier 1 — ships with slices 1–3 (cheap on top of the pipeline):**
1. **Grounded notes + action items** with per-claim segment citations and confidence — the trust foundation everything else stands on (§3.5).
2. **Ask-the-meeting** — chat over one meeting (pgvector on `transcript_segment` + `tier-fast`); "what did Priya say about the extruder budget?" with clickable segment answers.
3. **Scratch-notes merge (the Granola pattern)** — user types fragmentary notes during the meeting; generation treats them as *emphasis signals* merged with the transcript: their topics get depth, their typos get fixed, their unwritten context gets filled from the transcript. This is the single highest-leverage UX idea in the space (Anarlog's core loop) and costs one extra prompt input.
4. **Auto title/type detection** — `meeting_title` role names the meeting; classifier picks the template (standup vs sales call) with user override.
5. **Follow-up email draft** — one click, LLM-drafted recap to attendees through the email app's existing drafting/compose machinery (dormant Amurex's best feature, done right).
6. **Org glossary boost** — maintained jargon list ("Fracktal", "TwinDragon", "Penrose", customer names) injected as Whisper `initial_prompt` + a post-ASR correction pass; user corrections feed the glossary (a self-improving vocabulary loop).

**Tier 2 — the compounding layer (slices 3–5):**
7. **Commitment ledger across meetings** — action items + decisions become graph entities; next meeting with the same attendees auto-opens with "last time you agreed: … 2 of 5 done." Turns notes from record-keeping into accountability. (Entity graph + `action_item` history — mostly query work.)
8. **Speaker identity over time** — voice embeddings map `S1/S2` to org `person` rows after one manual labeling; future meetings auto-name speakers (pyannote/3D-Speaker embeddings + the existing `person` table). Enables per-person queries and the ledger above.
9. **Pre-meeting brief** — calendar integration (tasks app already touches calendar): before a scheduled meeting, an agent assembles attendees' open action items, related emails, and last meeting's notes into a one-pager.
10. **Catch-me-up (live)** — during a live session (slice 4), a rolling `meeting_live_digest` summary; a late joiner reads 5 bullets instead of scrolling captions.
11. **Voice markers** — "flag that as a decision" or a hotkey drops a marker; generation weights marked segments; marker list becomes chapter navigation.
12. **PII/confidentiality redaction pass** before any cloud-tier call (names/amounts optionally masked, unmasked only in the self-host tier) — turns the tier choice into a policy knob.
13. **Weekly meeting review in GTD** — the task app's weekly-review flow gains a "meetings this week" section: undispositioned action items surface exactly like unclarified inbox items (deepens the GTD thesis of `task_manager_app.md`).

**Tier 3 — differentiators to earn later:**
14. **Meeting janitor agent** — nightly MAF run: unsent follow-ups, overdue commitments, meetings nobody summarized; nudges via chat/email digest.
15. **Highlight reel** — auto-selected key quotes with audio snippets; shareable "60-second meeting" artifact.
16. **Talk-time & dynamics analytics** — per-speaker share, interruption patterns, question density; useful for sales-call coaching (opt-in, per-org policy — this one has cultural sharp edges; ship carefully).
17. **Live translated captions** — streaming ASR → streaming translation for mixed-language rooms (the two-pass notes translation ships far earlier).
18. **Meeting-bot capture** (Vexa/Attendee pattern) for meetings happening *elsewhere* — completes coverage beyond the browser's capture limits.

---

## 5. Award-winning UI — the vision

Design language: everything within `DESIGN_SYSTEM.md` (tokens, Geist, lucide, dark/light) — the award comes from **choreography and honesty**, not decoration. Five signature moves:

### 5.1 The Session screen — "studio, not form"
Recording is the hero moment and gets a dedicated, almost empty screen: a large live waveform (canvas, `--primary` on `--background`), a huge elegant monospace timer, the consent line, and three controls — pause, marker, stop. Input level meter and device picker tuck into a corner. The record button morphs (idle ring → pulsing dot → square stop) with reduced-motion respect. No chrome, no sidebar clutter — pressing record should feel like the room going quiet.

### 5.2 The Recording Dock — "the app follows you"
Stop is not the only way to leave: navigate anywhere in the Command Center and the session collapses into a persistent dock pill (waveform sliver + timer + stop) in the `AppShell` — the exact pattern the Focus-Mode timer dock proved (PR #174). Recording a meeting while triaging email is the suite's whole thesis in one interaction. Browser-tab title pulses ●REC; wake-lock held; closing the tab warns.

### 5.3 Transcript ↔ Notes — "provenance you can touch"
The meeting detail is a two-pane canvas: speaker-attributed transcript left (virtualized, speaker-colored accent rails, timestamps), generated notes right. **Hover a note bullet → its source segments glow; click → scroll-sync + audio cued to that second. Hover a segment → every note claim citing it highlights.** Grounding stops being a metadata footnote and becomes the interface. Audio player renders as a DAW-like strip: speaker-colored blocks on a timeline, click-to-seek, 1×/1.5×/2×, skip-silence.

### 5.4 Honest pipeline progress — "no fake spinners"
After stop, processing renders as a visible pipeline: `upload ✓ → transcribe ▓▓░ 62% → identify speakers · → write notes ·` with real per-stage progress from SSE, model/tier labels, and a truthful ETA (CPU tier says minutes and shows why). Failure states are per-stage with retry — never a dead spinner. This converts the platform's fail-closed honesty culture (the email app's "stop the lying" phase) into visible product character.

### 5.5 Action-item triage — "approve like Tinder, ship like GTD"
Extracted action items appear as a rail of cards: description, owner avatar (resolved from org people), due hint, confidence bar, and the *transcript quote that justifies it*. Keyboard-first triage — `A` approve, `R` reject, `E` edit, `⏎` open in tasks — with a bulk "approve ≥80%" action. On approve, the card animates into the Tasks app's visual language and a toast deep-links: "3 tasks created · view in /tasks". The moment value visibly leaves the notes app and lands in the rest of the suite is the demo moment.

**Supporting cast:** library as a chronological stream with waveform-sparkline cards and instant search across every word ever said (FTS + semantic); command-palette (`⌘K`) actions ("start recording", "email last meeting's notes"); mobile = full record-on-phone flow (mic capture works on mobile browsers) with review-on-desktop continuity; empty states that teach (first-run shows the mic/tab-audio/consent model in three panels); live captions (slice 4) rendered as a theater-caption band, not a chat log. Accessibility is a feature, not a checkbox: captions ARE accessibility, ARIA live regions for partials, full keyboard operation, reduced-motion variants of every animation.

---

## 6. Build plan (slices, each shippable)

| Slice | Scope | Exit criterion |
|---|---|---|
| **0. Foundation** | Migration 94 + ORM; `acb_stt` package with Tier-A providers (Groq/OpenAI, Deepgram w/ diarization); `routes/notes/` scaffold + proxy; replace `ComingSoon` with library shell | `POST upload → transcript segments in DB` via cloud BYOK, visible in a bare list |
| **1. The loop (MVP)** | Recorder (mic, MediaRecorder chunked upload, pause/resume, offline chunk buffer); pipeline job + SSE progress UI (§5.4); notes generation (templates, grounding, `summary_run`); meeting detail v1 (transcript + notes + audio player); retro-import | *Record a real meeting on the office floor → readable grounded notes, single sitting, no dev tools open* |
| **2. Loop closure** | `action_item` extraction + triage rail (§5.5); `/tasks/capture/from-meeting`; follow-up email compose+send; share-to-chat; delete/retention | *One meeting produces ≥1 approved task in `/tasks` and one sent recap email, all HITL* |
| **3. Depth** | Tier B self-host STT service (compose `--profile stt`, CPU defaults, GPU flag); real diarization + speaker relabel UI; tab-audio dual-channel capture (Chromium) + graceful degradation; ask-the-meeting chat; scratch-notes merge; glossary; two-pass translation; Recording Dock (§5.2) | *Self-hosted transcription with named speakers; "audio never left the box" demo* |
| **4. Live** | AudioWorklet→WS→WhisperLiveKit captions; live digest/catch-me-up; voice markers; `skill-notes` + meeting-janitor routine | *Live captions during a meeting with <2s latency, authoritative re-pass on stop* |
| **5. Reach** (option gates) | Speaker-identity memory; commitment ledger; pre-meeting briefs (calendar); meeting-bot capture (Vexa-style); analytics | each gated by a build-or-kill decision after slice-4 usage data |

Sequencing rationale: value lands at slice 1 (usable notes), the suite thesis lands at slice 2 (loop closure), the privacy/ownership story lands at slice 3, and only then do we pay for realtime complexity (slice 4) — the research is unambiguous that batch quality is the authoritative product and streaming is garnish (appendix §6).

---

## 7. Decisions (ADR-style) & open questions

| # | Decision | Choice | Why (alternatives rejected) |
|---|---|---|---|
| D1 | Repo placement | In this monorepo (route group + packages + optional compose services) | Platform conventions; `/notes` slot + tables already here. Separate repo re-opens Meetily's multi-moving-parts failure. *(An earlier request to use a different repository was retracted 2026-07-23 — work proceeds on a branch here.)* |
| D2 | Capture | Browser-native; MediaRecorder baseline + Chromium tab-audio dual-channel; no desktop companion | Desktop companion doubles surface area for one capability (system audio); revisit only on real-world failure of tab capture |
| D3 | STT | `acb_stt` routes through the **platform LiteLLM plumbing** — the model is the `tier-stt` tier (config.yaml, editable in Settings → Models), resolved + keyed exactly like the chat tiers, transcribed via `litellm.atranscription`, usage emitted for observability. Not a bespoke HTTP client, not a separate key-preference. | Consistency: STT is a configured model like every other model on the platform (the correction after the first cut used its own httpx clients). Swapping the `tier-stt` model — Groq/OpenAI whisper today, the self-host faster-whisper endpoint (slice 3) tomorrow — needs no app-code change. Caveat: diarization is provider-dependent (whisper-via-litellm returns none → capture-channel prior); real diarization arrives with the self-host tier. |
| D4 | Default self-host engines | faster-whisper `large-v3-turbo` int8 + Silero v6 + senko (CPU) / WhisperX + pyannote community-1, optional Parakeet-v3 (GPU) | Best accuracy-per-license at each hardware tier; all permissive (appendix §8) |
| D5 | Diarization in the open tier | Yes, from slice 3 | Meetily paywalls it — table stakes for us and a competitive statement |
| D6 | Summarization | `acb_llm` + template-compiler port + model roles; transcript always DATA-pinned | Zero new LLM infra; proven anti-injection posture from email capture |
| D7 | Realtime transport | SSE through slice 3; slice-4 WS terminates at WhisperLiveKit with gateway-minted tokens — gateway stays SSE-only | Consistency with the whole platform; avoids teaching the gateway a second streaming stack for one feature |
| D8 | Task creation | Never automatic — `action_item` draft→approve HITL, mirroring email capture | Constraint #4/#8 posture; confidence scores make bulk-approve fast without being autonomous |
| D9 | Audio retention | Default 90d audio / forever transcripts, org-configurable | Storage reality on the VPS; transcripts are the durable asset |

**Open questions (need an owner call, none block slice 0–1):**
1. **Q1 — Groq vs OpenAI vs Deepgram as the *recommended* Tier-A default?** Deepgram buys diarization before slice 3 lands but is the least BYOK-common key in the org today. (Lean: Groq for speed/cost, revisit at slice 3.)
2. **Q2 — Do meeting embeddings live in `transcript_segment.embedding` (proposed) or route through `acb_memory`'s existing stores only?** Duplication vs query ergonomics.
3. **Q3 — Consent defaults**: banner-only, or also a periodic audible chime? Org policy decision, not engineering.
4. **Q4 — Mobile recording in slice 1 or 3?** The recorder is responsive by construction; the open question is only QA surface.
5. **Q5 — Does `meeting.attendee_ids` (person UUIDs) get a companion free-text attendee list** for externals not in the org graph? (Lean: yes, `attendees_ext JSONB`.)

---

## 8. Doc map

- This spec — architecture + product plan (the *what/how*).
- [`note_taker_research_2026-07.md`](note_taker_research_2026-07.md) — evidence base (the *why*): Meetily deep dive §2, landscape table §3, ASR SOTA §4, diarization §5, pipeline consensus §6, browser facts §7, license watch-list §8.
- Precedents referenced throughout: `task_manager_app.md`, `email_app_master_plan.md`, `gateway/routes/tasks/capture_email.py`, `DESIGN_SYSTEM.md`.

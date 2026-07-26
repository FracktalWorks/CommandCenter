# Multiplayer Agents — Analysis & Implementation Plan

**Status:** Draft / RFC · **Date:** 2026-07-26 · **Owner:** vjvarada

Turn CommandCenter agent sessions from a thousand private threads into **rooms** — shared,
live, durable places where several people and one agent work the same problem together.
Anyone on the team can drop into a running session to watch it work, redirect it, and hand
it off, the way they would with a human teammate.

The thesis this responds to: the best work tools of the last two decades won by going
multiplayer (Docs over Word, Figma over Photoshop). AI hasn't had that moment yet, because
a chat is a box only one person can see. Agents now run tasks that take hours or days —
work at that scale was never meant to be done alone.

Interactive mockups live alongside this doc:

| Mockup | Surface |
|---|---|
| [`mockup-room.html`](mockup-room.html) | The shared session room — presence rail, attributed turns, floor control, observer lane, live steer |
| [`mockup-room-settings.html`](mockup-room-settings.html) | Access & data-sharing panel — roles, capacity dials, context policy, integration bindings, what's private |
| [`mockup-share.html`](mockup-share.html) | Going shared mid-conversation — `@mention` in the composer, history waterline, memory disclosure |
| [`mockup-memory.html`](mockup-memory.html) | What the agent knows and who can see it — compartments, per-fact audience, "what would they see?" |

**Companion doc:** [`memory-clearance.md`](memory-clearance.md) — how memory is partitioned
across sessions *and* across people, and how the agent decides which parts it may use on a
given call. It supersedes §6.3 below.

---

## 1. TL;DR / Recommendation

**We are closer than it looks.** The hard part of multiplayer agents is not the UI — it is a
durable, ordered, replayable event log per session; runs that survive the client that started
them; and control commands that reach the right worker. CommandCenter already has all three,
and all three are **keyed by `thread_id`, not by user**. Nothing in the transport is
single-player.

What is missing is three things, in this order:

1. **Membership** — a session has exactly one owner (`chat_session.user_id`) and every read
   path is `WHERE user_id = :uid`. There is no way to express "Sanjay can see this too."
2. **Floor control** — who is allowed to talk to the agent right now. Without it, a second
   participant's message *silently kills the first participant's in-flight run and erases
   its transcript* (§3.3). This is not a nicety; it is the thing that makes naive sharing
   destructive.
3. **A privacy boundary on the run context** — today the agent's context is stitched from
   the *caller's* private memory (§3.5). Share the room without fixing that and one person's
   private facts get rendered into a transcript the whole team reads.

**Recommendation: the thread is the room.** Do not introduce a new document abstraction.
A room is a `chat_session` row plus a member list, and every existing thread-keyed
primitive (`cc:stream:`, `cc:active:`, `cc:control:`, the reconnect/replay endpoint) becomes
multiplayer the moment the ownership check becomes a membership check.

Four phases, roughly six weeks, each independently shippable:

| Phase | Ships | Rough |
|---|---|---|
| **0 — Make the races explicit** | Concurrent-run 409, transcript no longer erasable by a second party, message authorship | ~3 days |
| **1 — Read-only multiplayer** | Membership, shared history, presence, live spectate ("watch it work") | ~1 week |
| **2 — Contribution** | Floor control, mid-run steer, turn queue, HITL routing ("redirect it", "hand it off") | ~1.5 weeks |
| **3 — The privacy boundary** | Room memory scope, context policy, room integration bindings, private lanes, since-join history | ~2 weeks |
| **4 — Scale & limits** | Fan-out multiplexer, capacity dials, per-participant cost attribution | ~1 week |

---

## 2. What already works

This is the plumbing referred to in the framing. It is genuinely most of the problem.

| Capability | Where | Why it matters for multiplayer |
|---|---|---|
| **Durable ordered event log per thread** | `apps/services/orchestrator/orchestrator/stream_relay.py:53` — `cc:stream:{thread_id}`, Redis Stream, `MAXLEN ~50 000`, 1h TTL | Redis `XREAD` is inherently fan-out: N independent readers can each hold their own cursor on the same stream. **Multiple simultaneous subscribers already work today** — nothing in the transport assumes one reader. |
| **Runs detached from the HTTP response** | `stream_relay.run_detached` (`:659`) | The agent keeps running when the browser that started it disappears. This is the "agents run for hours, days, weeks" premise, already satisfied. |
| **Join-and-catch-up** | `replay_events` (`:129`), `subscribe_events` (`:196`), `GET /agent/run/{thread_id}/reconnect?since=` (`apps/services/gateway/gateway/routes/agent.py:1544`) | Exactly the primitive a late joiner needs: replay everything since a cursor, then go live with no gap. Built for browser refresh; works unchanged for a second person. |
| **Cross-worker control bus** | `cc:control:{thread_id}` pub/sub + applied-ack (`stream_relay.py:393-546`) | A command issued by *any* participant on *any* worker reaches the worker that owns the run, and is confirmed applied. Already carries `cancel` and `respond_input`. Adding `steer` is a new applier, not new infrastructure. |
| **Liveness / seed presence** | `cc:active:{thread_id}`; `GET /chat/active-sessions` (`routes/chat.py:438`) | Already scans `cc:active:*` to show which sessions are running. |
| **Authoritative run-end persistence** | `gateway/chat_fold.py:374` `persist_final_assistant_message` | The transcript is folded and written server-side at the run boundary, independent of any browser. A room's history does not depend on a participant staying connected. |
| **Identity at the edge** | `packages/acb_auth/acb_auth/deps.py` — `UserContext(email, role)`, internal-bearer-verified SSO headers | Every request already carries a verified actor. Membership checks have something to check against. |
| **Cost & activity feed** | `packages/acb_common` Redis activity/cost feed; live token tracking (Custom Apps) | Per-participant cost attribution in a room is a re-key, not a new system. |
| **Org/RBAC design already researched** | `ai-company-brain/specs/multi_user_organization_research.md` | Orgs, memberships, permission vocabulary, agent visibility, memory scoping. **This RFC is the session-level layer on top of it**, and deliberately does not re-litigate the org model. |

**Relationship to the org research doc.** That doc answers *"who can access which agents and
data across the company"* — a static, org-shaped question. This doc answers *"how do several
people occupy one live agent run at the same time"* — a dynamic, session-shaped question.
They compose: org permissions set the ceiling, room roles narrow it (§5.4).

---

## 3. The five things that block multiplayer today

Found by reading the code, not by inspection of the feature list. Items 3 and 5 are the
non-obvious ones and they are the reason this needs a design rather than a patch.

### 3.1 Reads are single-owner

`routes/chat.py` gates every read and write on the owner's email:

- `_get_sessions` (`:62`) — `WHERE user_id = :uid`
- `_get_messages` (`:191`) — returns `[]` unless `SELECT 1 FROM chat_session WHERE id=:id AND user_id=:uid`
- `_patch_session` (`:151`), `_delete_session` (`:179`) — same predicate
- `list_active_sessions` (`:438`) — cross-references `AND user_id = :uid`

### 3.2 Control is single-owner

`_thread_owner_ok(thread_id, user_id)` (`routes/agent.py:1651`) gates **reconnect** (`:1544`)
and **cancel** (`:1674`). It is correct today and deliberately permissive (returns `True` for
ephemeral threads and on DB error), but it encodes "one email owns one thread".

### 3.3 A second person's message destroys the first person's run — silently

This is the sharp edge. In `run_detached` (`stream_relay.py:691-701`):

```python
# One run per thread: cancel any stale run still attached to this thread.
prev = _DETACHED_TASKS.get(thread_id)
if prev is not None and not prev.done():
    prev.cancel()
    ...
# Fresh run boundary: clear previous events so replay-from-0 is exact.
await mark_active(thread_id, reset=True)   # ← DELETEs cc:stream:{thread_id}
```

Both behaviours are *right* for single-player (they implement steer/retry/Quick-action:
supersede my own run, and keep replay-from-0 exact). In a room they mean:

> Alice's agent is 40 minutes into a task. Bob types "also check the invoice" — Alice's run
> is cancelled mid-flight and the Redis transcript of those 40 minutes is deleted. The
> cancellation is deliberately silent (`stream_relay.py:711-722` suppresses `RUN_ERROR` on
> this path, because for single-player it is a supersede, not a failure).

So: **floor control is a correctness requirement, not a UX preference.** Phase 0 turns this
silent destruction into an explicit 409 + product decision (§8).

### 3.4 Human turns never enter the shared stream, and messages have no author

Only agent events are pushed to `cc:stream:` (`push_sse_event` is called on the executor's
SSE lines). A participant's message reaches the *agent* but never reaches the other
*browsers*. And `chat_message` (`infra/postgres/02_chat_history.sql:23`) has
`role IN ('user','assistant','system')` (`:26`) and no author column — so in a room every human turn
renders as an anonymous "user". You cannot tell who asked what.

### 3.5 The run context is stitched from one person's private data

`routes/agent.py:1252-1300`:

```python
user_id: str = getattr(user, "email", "") or "anonymous"
_set_memory_user_id(user_id)                      # scopes remember/save_memory
...
mem_ctx = await get_memory_context(user_id, user_msg)   # this user's private Mem0 facts
parts.append("## Memory from past conversations\n" + mem_ctx)
```

and symmetrically on the write path (`add_memories_background`, `:1448`) the turn's content
is extracted into **the caller's personal memory store**.

In a shared room, unchanged, this means: (a) the driver's private facts are injected into a
context whose output everyone reads, and (b) everyone else's contributions get written into
the driver's personal memory. Both directions are wrong. §6.3 is the fix and it is the single
most important decision in this document.

---

## 4. Q1 — The best way to have multiple people use the same agents

### 4.1 Three sharing models — don't conflate them

| Model | Meaning | Status |
|---|---|---|
| **Shared definition** | Many people, many separate sessions, one agent *registration* | **Exists.** `dynamic_agents` is global; anyone with gateway access can run any registered agent. This is a shared *tool*, not multiplayer. |
| **Shared room** | Many people, **one live thread**, one agent context, simultaneous | **The ask.** Everything below. |
| **Shared long task** | One long-running agent; humans drop in and out asynchronously, hand off, pick up hours later | Falls out of the room model + durable log, provided history and floor survive everyone disconnecting. |

The distinction matters because "shared agent" is often sold as the first and delivers none
of the value. The value is one *context* several people can stand in.

### 4.2 Recommendation: the thread is the room

Do not build a separate "collaboration document" object. A room is:

```
chat_session  (already exists — becomes the room)
  + chat_session_member  (new — who's in it and in what capacity)
  + cc:room:{thread_id}  (new Redis stream — room events that outlive runs)
```

Why this and not a new abstraction:

- Every transport primitive is already thread-keyed. `cc:stream:`, `cc:active:`,
  `cc:control:`, `/reconnect?since=`, `chat_fold`, `workspace_path` — all of it becomes
  multiplayer by changing an ownership predicate to a membership predicate.
- The agent's context *is* the thread's message history. A room with a different identity
  than the thread would need context reconciliation; a room that **is** the thread needs none.
- It degrades gracefully: a session with one member behaves exactly as today, so nothing
  regresses for solo use.

### 4.3 Schema — migration `117_multiplayer_rooms.sql`

```sql
-- ── The room ────────────────────────────────────────────────────────────────
ALTER TABLE chat_session
    -- user_id keeps its meaning: the creator/owner. Membership is additive.
    ADD COLUMN IF NOT EXISTS visibility TEXT NOT NULL DEFAULT 'private'
        CHECK (visibility IN ('private', 'invite', 'team', 'organization')),
    ADD COLUMN IF NOT EXISTS floor_mode TEXT NOT NULL DEFAULT 'driver'
        CHECK (floor_mode IN ('solo', 'driver', 'queue', 'open', 'moderated')),
    ADD COLUMN IF NOT EXISTS history_visibility TEXT NOT NULL DEFAULT 'full'
        CHECK (history_visibility IN ('full', 'since_join')),
    ADD COLUMN IF NOT EXISTS context_policy TEXT NOT NULL DEFAULT 'room'
        CHECK (context_policy IN ('room', 'driver', 'none')),
    ADD COLUMN IF NOT EXISTS acting_identity TEXT,          -- email whose integrations the agent uses
    ADD COLUMN IF NOT EXISTS max_contributors INT NOT NULL DEFAULT 5,
    ADD COLUMN IF NOT EXISTS token_budget BIGINT;           -- NULL = unlimited

-- ── Membership ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS chat_session_member (
    session_id      TEXT NOT NULL REFERENCES chat_session(id) ON DELETE CASCADE,
    user_email      TEXT NOT NULL,
    room_role       TEXT NOT NULL DEFAULT 'observer'
                      CHECK (room_role IN ('owner','contributor','observer')),
    invited_by      TEXT,
    joined_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- History redaction for late joiners: fed straight into the EXISTING
    -- /reconnect?since= cursor and the chat_message timestamp filter.
    join_stream_id  TEXT,
    join_message_ts BIGINT,
    last_seen_at    TIMESTAMPTZ,
    PRIMARY KEY (session_id, user_email)
);
CREATE INDEX IF NOT EXISTS chat_session_member_user_idx
    ON chat_session_member (user_email, joined_at DESC);

-- Backfill: every existing session gets its owner as a member. Solo sessions
-- keep behaving identically.
INSERT INTO chat_session_member (session_id, user_email, room_role)
SELECT id, user_id, 'owner' FROM chat_session
ON CONFLICT DO NOTHING;

-- ── Attribution + private lanes ─────────────────────────────────────────────
ALTER TABLE chat_message
    ADD COLUMN IF NOT EXISTS author_email TEXT,             -- NULL = agent/system
    ADD COLUMN IF NOT EXISTS author_kind  TEXT NOT NULL DEFAULT 'human'
        CHECK (author_kind IN ('human','agent','system')),
    ADD COLUMN IF NOT EXISTS visibility   TEXT NOT NULL DEFAULT 'room'
        CHECK (visibility IN ('room','private')),
    ADD COLUMN IF NOT EXISTS private_to   TEXT;             -- email, when visibility='private'
```

**Room roles are not org roles.** `owner` / `contributor` / `observer` describe a capacity
*in this room*. `UserRole.EXECUTIVE` / `EMPLOYEE` describes authority *in the company*. §5.4
defines how they compose, and the rule is one-directional: room membership never escalates
org permissions.

### 4.4 The room event channel — a second stream, deliberately

Add `cc:room:{thread_id}`, a Redis Stream alongside `cc:stream:{thread_id}`.

**Why not reuse `cc:stream:`:** because `mark_active(thread_id, reset=True)` deletes it at
every run boundary (`stream_relay.py:701`), by design, so that replay-from-0 exactly covers
the current run. Room events — who joined, who holds the floor, who said what between runs —
must survive run boundaries. Two streams with different lifecycles is the honest model:

| Stream | Lifecycle | Carries |
|---|---|---|
| `cc:stream:{tid}` | **Reset per run**, 1h TTL | AG-UI run events: `RUN_STARTED`, `TEXT_MESSAGE_CONTENT`, `TOOL_CALL_*`, `RUN_FINISHED` |
| `cc:room:{tid}` | **Never reset**, TTL refreshed on write, ~24h | `PARTICIPANT_JOINED` / `_LEFT` / `_PRESENCE`, `USER_MESSAGE`, `FLOOR_*`, `STEER_INJECTED`, `NOTE_ADDED`, `ROOM_SETTINGS_CHANGED`, `HANDOFF` |

Clients subscribe to both through one merged SSE endpoint (§4.5) with two cursors. The
frontend translator (`workbench/control_plane/src/lib/chatStream.ts`) gains new event cases;
the existing run-event handling is untouched.

Room event shape (mirrors AG-UI conventions so the translator stays uniform):

```jsonc
{ "type": "USER_MESSAGE", "threadId": "…", "messageId": "…",
  "author": { "email": "sanjay@fracktal.in", "name": "Sanjay", "avatarUrl": "…" },
  "content": "also check the invoice", "ts": 1753500000000 }

{ "type": "FLOOR_GRANTED", "threadId": "…", "holder": "sanjay@fracktal.in",
  "grantedBy": "vijay@fracktal.in", "expiresAt": 1753500120000 }

{ "type": "STEER_INJECTED", "threadId": "…", "author": "sanjay@fracktal.in",
  "text": "skip the staging deploy", "appliedAt": "tool_boundary" }
```

### 4.5 API surface

```
# Membership
POST   /chat/sessions/{id}/members              invite {email, room_role}
DELETE /chat/sessions/{id}/members/{email}      remove
GET    /chat/sessions/{id}/members              list + presence + floor holder
POST   /chat/sessions/{id}/join                 self-join (if visibility allows)
POST   /chat/sessions/{id}/leave

# Presence + live
POST   /chat/sessions/{id}/presence             heartbeat (10s)
GET    /chat/sessions/{id}/room-stream?since=…&roomSince=…
                                                merged run + room SSE

# Floor & steering
POST   /agent/run/{tid}/floor                   {action: acquire|release|request|grant, to?}
POST   /agent/run/{tid}/steer                   {text}  — non-destructive mid-run guidance
POST   /chat/sessions/{id}/handoff              {to, note?} — transfer owner/driver

# Room config
PATCH  /chat/sessions/{id}/room                 visibility, floor_mode, context_policy,
                                                history_visibility, max_contributors, budget
```

One helper replaces `_thread_owner_ok` everywhere:

```python
@dataclass(frozen=True, slots=True)
class RoomAccess:
    role: str | None          # 'owner' | 'contributor' | 'observer' | None
    can_read: bool
    can_send: bool            # may take the floor / enqueue a turn
    can_steer: bool           # may inject mid-run guidance
    can_cancel: bool
    can_invite: bool
    since_stream_id: str      # history_visibility='since_join' → join cursor, else "0-0"
    since_message_ts: int     # ditto for the Postgres history read

def resolve_room_access(thread_id: str, user: UserContext) -> RoomAccess: ...
```

Keep `_thread_owner_ok`'s permissive contract for the cases it was built for: a thread with
no `chat_session` row (ephemeral/legacy) and a DB error both resolve to full access, so
legitimate solo operations are never blocked by an infra hiccup.

### 4.6 Steering a run in flight — the "redirect it" verb

The framing's core verb. It must **not** be "send a message", because that cancels the run
(§3.3). Reuse the control bus:

1. `POST /agent/run/{tid}/steer` → `dispatch_control(tid, {"cmd": "steer", "text": …, "author": …})`.
2. The executor registers a `steer` applier (exactly as it registers `respond_input` today)
   that appends to a per-run pending-guidance queue.
3. The queue is drained **at the next tool boundary** and injected as a system-role note:
   `"[steer from Sanjay] skip the staging deploy"`. Tool boundaries are the natural seam —
   the model is between decisions, and injection there does not corrupt a streaming turn.
4. `STEER_INJECTED` is pushed to `cc:room:` so everyone sees who redirected it and when.

Non-destructive, attributed, works cross-worker on day one because `dispatch_control` already
handles the local-hit / publish / applied-ack path with a retry for the subscribe race.

---

## 5. Q2 — Managing how many people can work with the agents

Two distinct questions live under this heading and they need different mechanisms:
**floor control** (who may act *right now*) and **capacity** (how many may be involved *at all*).

### 5.1 Floor control modes

Per-room `chat_session.floor_mode`:

| Mode | Who may drive the agent | What happens when a non-holder sends | Good for |
|---|---|---|---|
| `solo` | Owner only | Rejected (403) | Today's behaviour; the default for private sessions |
| **`driver`** *(default for shared)* | One holder of the floor baton | Offered: *request the floor* / *steer* / *note to room* | Pair-working, incident response, demo-to-a-room |
| `queue` | Anyone; turns run serially | Enqueued; UI shows the queue and lets you reorder or drop yours | Async collaboration, long tasks with several stakeholders |
| `open` | Anyone, immediately | Runs immediately — **only legal because a new run no longer cancels the old one silently** (Phase 0 makes this a 409-or-queue decision) | Small trusted rooms, fast brainstorms |
| `moderated` | Owner/driver only | Lands in an **observer lane**; the driver promotes a suggestion into the agent's context | Large rooms, customer-facing sessions, training |

**Implementation** — one Redis key, no new subsystem:

```python
# Acquire: atomic, self-expiring, so a dead browser can't hold the floor forever.
ok = await r.set(f"cc:floor:{tid}", email, nx=True, ex=FLOOR_TTL)   # 120s
# Hold:    refresh on the presence heartbeat while the holder is connected.
# Release: explicit POST, or automatically on RUN_FINISHED, or by TTL lapse.
# Grant:   owner may force-transfer (Lua CAS) — always emits FLOOR_GRANTED.
```

Every transition emits a `FLOOR_*` room event and an `audit_event` (`acb_audit`) with the
actor, so "who told it to do that" is answerable after the fact.

**Recommended default `driver`**, because of §3.3: a baton is the smallest mechanism that
makes the destructive race impossible rather than merely unlikely.

### 5.2 The Phase 0 correctness fix that unlocks all of this

`POST /agent/run/stream` must stop silently superseding an in-flight run for the same thread:

- If the thread is `cc:active:` and the caller **holds the floor** and passes
  `intent: "supersede"` → current behaviour (cancel + reset). This is the existing
  steer/retry/Quick-action path and must keep working byte-for-byte.
- If the thread is active and the caller **does not hold the floor** → `409 Conflict` with
  `{ "activeRun": {...}, "holder": "vijay@fracktal.in", "options": ["steer","queue","request_floor"] }`.
- `mark_active(reset=True)` may only be issued by the run that legitimately supersedes.
  Otherwise a second party can delete a transcript they do not own.

This one change converts a silent data-loss bug into an explicit product choice, and it is
worth shipping on its own even if multiplayer stops here.

### 5.3 Capacity dials

The instinct is to cap "people in the room". That is the wrong axis. **Observers are cheap;
contributors are expensive** — not in compute but in *context window*, which is the genuinely
scarce resource. Cap accordingly:

| Dial | Default | Enforced where | Why |
|---|---|---|---|
| `max_contributors` | 5 | Membership write + floor acquire | Each contributor adds turns to the thread history that every subsequent run pays for. |
| Observers | unbounded (soft-warn at 25) | — | One extra Redis cursor each. See §5.5 for the real cost. |
| Concurrent active runs per user | 3 | Run start; scan `cc:active:*` | Prevents one person parallel-farming the fleet. |
| Concurrent active rooms per org | tiered | Run start | The SaaS metering hook (see the org research doc, §17.7). |
| Steer rate | 1 per participant per 30s per run | `/steer` | Protects the context window and the model's coherence. |
| `token_budget` per room | NULL (off) | Cost feed at run boundary | When exceeded, the room degrades to read-only until the owner raises it. |

Per-participant cost attribution rides the existing activity/cost feed: stamp
`participant_email` alongside `thread_id` on each run's token record, and the room header can
show "1.2M tokens · Vijay 61% · Sanjay 39%".

### 5.4 The permission matrix

| Action | Observer | Contributor | Owner | Also requires |
|---|---|---|---|---|
| Read history (subject to `history_visibility`) | ✅ | ✅ | ✅ | — |
| Watch a live run | ✅ | ✅ | ✅ | — |
| Add a room note / reaction | ✅ | ✅ | ✅ | — |
| Send a turn to the agent | ❌ | ✅ | ✅ | Holds the floor (mode-dependent) |
| Steer an in-flight run | ❌ | ✅ | ✅ | Rate limit |
| Request the floor | ✅ | ✅ | ✅ | — |
| Grant / revoke the floor | ❌ | ❌ | ✅ | — |
| Answer an `ask_user` (HITL) | ❌ | ✅ | ✅ | Floor holder first; falls back to any contributor after 60s |
| **Approve an outward write** (Action Broker / `approval_queue`) | ❌ | ❌ | ❌ | **Org permission only** — see below |
| Cancel the run | ❌ | ✅ | ✅ | — |
| Invite / remove members | ❌ | ❌ | ✅ | — |
| Change room settings | ❌ | ❌ | ✅ | — |
| Delete the room | ❌ | ❌ | ✅ | — |

> **Rule: room membership never escalates org permissions; it can only narrow them.**
>
> Being a contributor in a room does not grant the authority to approve an email send, a CRM
> write, or a `pending_commits` push. Those stay gated on the org-level permission
> (`require_role`, and later the permission vocabulary in the org research doc §4.3). The
> effective permission for any action is `org_permission AND room_role_permission`. Without
> this rule, "invite them to the room" becomes a privilege-escalation primitive.

### 5.5 What the fan-out actually costs

Being honest about the scaling shape, because it determines when Phase 4 is needed.

Today each subscriber is its own `XREAD ... BLOCK 30000` loop (`subscribe_events`, `:196`).
A 20-person room watching one run is 20 blocked Redis connections *per worker* plus 20 SSE
connections. Redis handles that trivially; the constraint is uvicorn workers and file
descriptors, and it is linear in viewers.

The fix, when it is needed (Phase 4, not before): a **per-process fan-out multiplexer** — one
`XREAD` per `thread_id` per worker, broadcasting to an in-process `asyncio.Queue` per local
subscriber. That turns `O(viewers)` Redis cursors into `O(threads × workers)`. It is a
contained change inside `stream_relay` with no API surface, which is exactly why it should be
deferred until room sizes justify it.

---

## 6. Q3 — What is private and what is shared

### 6.1 The principle: three concentric scopes

- **Participant-private** — never leaves the individual, regardless of room role.
- **Room-shared** — visible to members, subject to `history_visibility`.
- **Org-shared** — visible beyond the room.

Everything below is a decision about which ring a given surface sits in. The default when
uncertain is the *inner* ring: it is easy to promote something into the room later and
impossible to un-share it.

### 6.2 Classification of every data surface

| Surface | Where it lives | Today | In a room |
|---|---|---|---|
| Message content | `chat_message.content` | Owner-only | **Room-shared** — the point of the feature. Attributed via `author_email`. |
| Tool calls & results | `chat_message.tool_events` | Owner-only | **Room-shared.** Seeing *what the agent did* is most of "watch it work". |
| Reasoning / chain-of-thought | `chat_message.reasoning` | Owner-only | **Room-shared, but per-room toggle.** Some rooms (customer-facing, exec review) should not expose raw CoT. Default on for internal rooms. |
| Generative-UI cards | `chat_message.custom_events` | Owner-only | **Room-shared.** Note: interactive cards need one authoritative responder — route interaction through the floor holder. |
| Agent workspace files | `chat_session.workspace_path` → `routes/workspace.py` | Per-session | **Room-shared.** Files are the deliverable; sharing the room without the artifacts is pointless. Writes remain agent-only. |
| **Personal episodic memory** | Mem0 via `get_memory_context(user_id, …)` (`agent.py:1297`) | Per-user | **PRIVATE — excluded from shared rooms by default.** See §6.3. |
| Agent memory | `AGENT_SCOPE_PREFIX` (`acb_memory`) | Cross-user already | **Room-shared.** Unchanged. |
| Org memory | `ORG_SCOPE_KEY` | Global | **Org-shared.** Unchanged. |
| **Room memory** *(new)* | `scope_key("room", thread_id)` | — | **Room-shared.** The new scope facts learned in a room are written to. §6.3. |
| Entity timeline (Graphiti) | `search_entity_timeline` | Global | **Org-shared**, subject to the entity ACLs in the org research doc §9. Not a room concern. |
| Provider / LLM keys | `provider_keys` (encrypted) | Server-side | **Never exposed.** No role, in any room, can read them. |
| Integration credentials & OAuth tokens | `integration_credentials` | Server-side, per-user | **Never exposed.** But *whose* credentials the agent acts with is a room-visible fact. §6.4. |
| Data pulled by tools (inbox, GTD, CRM) | email/task tables, user-scoped | Per-user | **Leak surface.** A tool that reads the driver's inbox renders its contents into a transcript the room reads. Governed by §6.4 + an explicit banner. |
| HITL questions (`ask_user`) | Executor futures + control bus | Owner answers | **Room-shared, one authoritative answer.** Floor holder first, any contributor after 60s. |
| Outward-write approvals | `approval_queue`, `pending_actions`, `pending_commits` | Role-gated | **Visible to the room, actionable only by org permission.** §5.4. |
| Cost / tokens | Redis activity+cost feed | Per-run | **Room-shared, attributed per participant.** |
| Audit events | `audit_event` | actor = email | **Extended**: every room action records `thread_id`, actor, and room role. |
| Copilot server-side session | `chat_session.service_session_id` | Per-session | **Room-shared implicitly** — it *is* the shared agent state. Reinforces "one context, not one per person". |
| Private lane messages | `chat_message.visibility='private'` *(new)* | — | **Participant-private** until explicitly promoted. §6.5. |

### 6.3 The context policy — the most important decision here

`chat_session.context_policy`:

| Value | Memory injected at run start | Memory written at run end | Use |
|---|---|---|---|
| **`room`** *(default for any session with >1 member)* | room scope + agent scope + org scope | **room scope** | Shared work. No participant's private facts enter the room; nothing from the room pollutes anyone's private store. |
| `driver` | the floor holder's personal Mem0 **+** the above | the floor holder's personal store + room scope | "Help me with *my* inbox, while the team watches." Requires an explicit, persistent banner: *"Vijay's personal context is in play"*, and per-session consent from the floor holder. |
| `none` | nothing | room scope only | Clean-room work: audits, customer demos, anything where reproducibility matters more than recall. |

Two rules make this coherent:

> **Memory follows the room, not the person.** Facts learned in a shared room are written to
> the room's scope, and are promoted to org scope only by an explicit action — never
> silently into a participant's personal store.

> **Promotion is one-way and explicit.** `room → org` is a button with an actor and an audit
> record. There is no `personal → room` automatic path at all.

Concretely, this is a branch at two call sites in `routes/agent.py`: the memory-block builder
(~`:1291`) selects scopes by policy, and `add_memories_background` (`:1448`) selects its
write scope by policy. `acb_memory` gains a `room` scope alongside the existing
`AGENT_SCOPE_PREFIX` / `ORG_SCOPE_KEY`, which is a key-prefix addition, not a new store.

Ship the room memory scope in the **same** phase that opens sharing (Phase 3 gates Phase 1's
default). Until then, shared rooms run `context_policy='none'` — no memory rather than the
wrong memory.

> **⚠️ Superseded — `context_policy` is on the wrong axis.**
>
> A per-room switch cannot express *"this deal is confidential and that one is
> collaborative"* when both belong to the same person and the same agent: `driver` leaks the
> restricted subject through semantic retrieval, and `room` forgets the collaborative one.
> Confidentiality is a property of the **subject**, not of the person or the room.
>
> **[`memory-clearance.md`](memory-clearance.md) replaces this section** with memory
> *compartments* (`subject:` / `room:` / `prefs:` / `user:` / `agent:` / `org:`) and a
> per-run *clearance* — **a run reads at the clearance of its least-cleared viewer**. The
> two rules above survive intact; what changes is that the unit of scoping becomes the
> compartment rather than the room. `context_policy` remains only as a coarse room-level
> override (`none` forces a clean room regardless of clearance).
>
> That doc also flags a prerequisite: `routes/memory.py` currently accepts any scope key by
> path parameter without checking the caller, so any signed-in user can read or delete
> another user's memory today. It moves to Phase 0.

### 6.4 Which identity do the tools act as?

When the agent sends an email or writes to ClickUp from a room, whose credentials does it use?

| Option | Behaviour | Verdict |
|---|---|---|
| **Driver** | Whoever holds the floor | ❌ Non-deterministic and leak-prone. The same prompt does different things depending on who typed it, and a tool call silently exposes the driver's mailbox to the room. |
| **Owner** | Always the room creator | ⚠️ Predictable and auditable, but surprising: a contributor's request quietly acts as someone else. |
| **Room binding** *(recommended)* | The room declares its bindings explicitly; `acting_identity` is fixed at room creation and shown permanently in the header | ✅ Explicit, visible, auditable. Falls back to owner when unset. |

Rules:

- **Identity is fixed at run start** and stamped into every `audit_event` and tool result.
  It never changes mid-run, even if the floor changes hands.
- The room header permanently shows what the agent can act as:
  *"Acting as vijay@fracktal.in · Gmail, ClickUp (team), Zoho (read-only)"*.
- Changing `acting_identity` requires owner + the consent of the identity's owner, and emits
  a `ROOM_SETTINGS_CHANGED` event so nobody's mailbox is quietly enrolled.

### 6.5 Private lanes inside a shared room

Total transparency is not the goal; *shared context with private edges* is.

- **Whisper / private ask.** "Ask privately" opens a child thread
  (`parent_session_id = room`) with the room transcript as **read-only** context. The
  question and answer are `visibility='private'`, `private_to=<email>`, and appear only to
  the author — with a **Promote to room** action that re-emits them as room-visible with
  attribution. Costs are still attributed to the asker.
- **Private notes.** Annotations on any message, author-only. Never enter the agent's context.
- **Since-join history.** `history_visibility='since_join'` is nearly free: store
  `join_stream_id` / `join_message_ts` on the membership row at join time and feed them into
  the *existing* `?since=` replay cursor (`agent.py:1544`) and the `before`/`limit` window in
  `_get_messages` (`chat.py:191`). Both mechanisms already exist for pagination and reconnect.

### 6.6 Never shared, regardless of role

Enforced server-side at context assembly and in the serializer — never merely hidden in the UI:

- Decrypted provider keys and integration credentials; raw OAuth tokens.
- Another participant's personal memory scope.
- Another participant's private lane (`visibility='private'` rows they don't own).
- The internal gateway bearer token (`GATEWAY_INTERNAL_TOKEN`).
- Any `pending_commits` diff the viewer's org role doesn't already permit.

---

## 7. UX

See the mockups. The load-bearing ideas:

1. **Presence rail** — faces of who is here, who is watching, who holds the floor. Live agent
   state ("running · 4m 12s · 1.2M tokens") is a room-level fact, not a per-browser fact.
2. **Attributed turns** — every human turn carries a face and a name. The agent's turns carry
   the agent's avatar (`64_agent_avatars.sql` already exists).
3. **The floor is visible and requestable** — a single clear affordance: *"Vijay is driving ·
   Request the floor"*. Handing off is one click and lands as a room event.
4. **Steer without stopping** — a distinct input affordance from "send a turn", with a
   distinct rendering (inline, italic, attributed) so the transcript shows the redirection in
   its true position within the run.
5. **The observer lane** — in `moderated` rooms, observer suggestions sit beside the
   transcript and the driver promotes them. This is how a room stays useful above ~6 people.
6. **A permanent, unmissable data banner** — what identity the agent acts as, which context
   policy is in force, and whether anyone's personal context is in play. Privacy that is only
   in a settings page is not privacy.

### 7.1 Going shared mid-conversation

The common case is not "start a shared session" — it is realising, forty turns deep, that
this shouldn't be yours alone. Five entry points, one sheet
([`mockup-share.html`](mockup-share.html)):

- **`@mention` in the composer.** Type `@sanjay` mid-message; a chip appears inline; sending
  converts the thread to a room and invites him. The Docs move, and the path most sharing
  should take.
- **Share button in the thread header** — always present, quiet while solo. Plus `⌘⇧S` and
  the sidebar row menu.
- **The agent asks.** When a run hits an approval it can't make or a domain it can't act in:
  *"This needs Finance sign-off — bring someone in?"* Agent-initiated multiplayer costs
  nothing once rooms exist.

The sheet makes three entangled decisions together, which is why it is one sheet: **who**,
**the history waterline** (*from here on* by default, rendered as a visible divider in the
transcript afterwards), and **what memory the room will and won't have** — computed exactly,
because the clearance of every past run is known. That last block is what makes the
confidential-deal case safe, and it is detailed in
[`memory-clearance.md`](memory-clearance.md) §6.

---

## 8. Phased plan

### Phase 0 — Make the races explicit (~3 days)

*Ships value even if multiplayer stops here: it is a real data-loss bug.*

- `POST /agent/run/stream` returns **409** when the thread is active and the caller isn't
  legitimately superseding (§5.2). Existing single-player supersede path unchanged.
- `mark_active(reset=True)` is only reachable from a legitimate supersede.
- `chat_message.author_email` / `author_kind` added and populated on every write path
  (`chat_fold`, `save_messages`, the Next translator's checkpoints).
- **Authorize `routes/memory.py`** — `GET/POST/DELETE /memory/{user_id}` resolves
  `UserContext` and never compares it to the path parameter, so any signed-in user can list,
  semantically search, and delete any other user's memory scope today
  ([`memory-clearance.md`](memory-clearance.md) §2.1). Independent of everything else here.
- **Acceptance:** two clients on one thread; the second cannot cancel or erase the first's
  run; every stored message resolves to an author; a caller cannot read a memory scope they
  don't own.

### Phase 1 — Read-only multiplayer (~1 week)

- Migration 117 (membership, room columns) + backfill.
- `resolve_room_access` replaces `_thread_owner_ok` at both call sites; membership predicate
  replaces `WHERE user_id = :uid` in the five `chat.py` helpers.
- `cc:room:{tid}` stream; presence heartbeat; `PARTICIPANT_*` events.
- Merged `/room-stream` SSE; frontend translator cases; presence rail.
- Invite / join / leave; sessions sidebar shows shared rooms.
- Shared rooms are pinned to `context_policy='none'` until Phase 3.
- **Acceptance:** Sanjay opens Vijay's running session, sees the last hour replay and then
  live tool calls, and cannot send, steer, or cancel.

### Phase 2 — Contribution (~1.5 weeks)

- Floor baton (`cc:floor:`), all five `floor_mode`s, `FLOOR_*` events, audit.
- `POST /steer` + executor `steer` applier draining at tool boundaries.
- Turn queue for `queue` mode; observer lane for `moderated`.
- HITL routing: floor holder first, any contributor after 60s; the answer is attributed.
- Handoff with a note.
- **Acceptance:** Sanjay requests the floor, Vijay grants it, Sanjay redirects the run
  mid-flight without cancelling it, and the transcript shows exactly who did what when.

### Phase 3 — The privacy boundary (~3 weeks)

Expanded by [`memory-clearance.md`](memory-clearance.md) §7, which splits it into 3a/3b/3c.

- **3a** — compartment registry (migration 118), `scope_key()` kinds, the `prefs`/`user`
  split, clearance resolution at run start, read/write rules at both `routes/agent.py` memory
  call sites, `_set_memory_write_scope`.
- **3b** — subject binding (bound rooms, inline declaration), entity-linked inference that may
  only narrow, the per-viewer private hint, extraction classification.
- **3c** — share sheet with the memory disclosure, history waterline, memory inspector.
- Room integration bindings + `acting_identity` fixed at run start, stamped into audit.
- Private lanes: whisper child threads, private notes, promote-to-room.
- `history_visibility='since_join'` via the join cursors.
- The permanent data banner.
- **Acceptance:** the load-bearing test is at the query layer, not the answer layer — in a
  room whose viewers aren't all cleared for a restricted subject, assert that `search()` is
  **never called** with that scope key, rather than asserting the answer avoids mentioning
  it. Plus: facts learned in a room land only in room/subject scope; a late joiner with
  `since_join` cannot read a message from before they joined.

### Phase 4 — Scale & limits (~1 week)

- Per-process fan-out multiplexer in `stream_relay`.
- Capacity dials (§5.3) + room token budget + degrade-to-read-only.
- Per-participant cost attribution in the header and the observability view.
- **Acceptance:** a 25-viewer room holds one `XREAD` per worker; exceeding the budget makes
  the room read-only with a clear owner-facing prompt.

---

## 9. Rejected alternatives

- **CRDT / Yjs document model (the literal Figma analogy).** An agent session is an
  append-only, causally-ordered event log with a single writer (the agent) and serialized
  human turns — not a shared mutable document. A CRDT adds a large dependency and solves a
  merge problem we do not have. *Revisit only* for collaborative editing of a prompt draft or
  a workspace file, which is a genuinely different surface.
- **WebSocket rewrite.** SSE + Redis Streams already gives ordered delivery, replay from a
  cursor, and reconnect — the properties a socket would have to re-earn. The only gap is
  client→server, already covered by POST + the control bus. A rewrite would be pure cost.
- **Per-user forked contexts ("everyone gets their own copy").** Destroys the premise. The
  value is one context several people stand in; forking makes it N private threads with
  extra steps.
- **Room as a new top-level object separate from the thread.** Requires reconciling two
  identities and rewriting every thread-keyed primitive. §4.2.
- **Broadcasting personal memory into rooms and relying on UI hiding.** Privacy enforced in
  the renderer is not privacy — the model has already seen it and will paraphrase it into the
  transcript.

---

## 10. Open questions

1. **Room lifetime.** `cc:stream:` is 1h TTL; a room that spans days needs its live log
   rehydrated from Postgres on demand. Do we materialize a room event table, or accept
   "live events are ephemeral, transcript is durable"? (Leaning: the latter — `chat_message`
   is already the durable truth, and `cc:room:` is the live layer.)
2. **Guests / external participants.** The org research doc has no external-user path.
   Sharing a room with a customer is a real want and a real risk surface.
3. **Notifications.** When an agent parks on `ask_user` at 2am and nobody holds the floor,
   who gets pinged? Ties into the existing WhatsApp / email surfaces.
4. **Room templates.** "Incident room", "deal room", "review room" — preset floor mode,
   context policy, agent, and bindings. Probably Phase 5.
5. **Does `driver` context policy survive contact with reality**, or is the leak risk high
   enough that we only ever ship `room` and `none`?
6. **Interactive gen-UI cards with multiple viewers** — one authoritative responder is the
   right rule, but the card components need to render a disabled state for non-holders.

---

## 11. Summary

The framing is right: agents are the one powerful new tool people still use alone. For
CommandCenter the gap between here and multiplayer is smaller than it looks, because the
substrate — a durable per-thread event log, detached runs, cross-worker control, replay from
a cursor — was already built for reconnection and is user-agnostic.

Three things stand between us and it: **membership** (a predicate change), **floor control**
(a Redis baton, plus fixing a real data-loss race we have today), and **a privacy boundary on
the run context** (a new memory scope and an explicit acting identity). The first two are
weeks. The third is the one that determines whether people trust the room enough to use it,
and it is the one to get right rather than fast.

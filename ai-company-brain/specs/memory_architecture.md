# Memory Architecture — one model for seven stores

**Status:** Draft / RFC · **Date:** 2026-07-26 · **Owner:** vjvarada

How every agent remembers: what tier a fact belongs in, where it physically lives, how it
survives a run, how it gets corrected, and how all of that holds up when several people share
one agent.

**Companions:**
[`agent_file_and_memory_framework.md`](agent_file_and_memory_framework.md) (the durable-state
contract — the three folders) ·
[`agent_persistence_implementation.md`](agent_persistence_implementation.md) (the blob store,
function by function) ·
[`llm_caching_memory.md`](llm_caching_memory.md) (Mem0 scopes + prompt caching) ·
[`../../docs/multiplayer/memory-clearance.md`](../../docs/multiplayer/memory-clearance.md)
(compartments and per-run clearance) ·
[`../../docs/multiplayer/agent-kinds.md`](../../docs/multiplayer/agent-kinds.md) (personal
vs shared instancing)

> **Note on the `agent-startup-guru` reference.** This repo's framework doc cites it as the
> pattern to copy (§4, *"a self-contained memory bank under `outputs/_memory/` +
> `agent-data/` managed by a `memory-management` skill — JSON/MD working memory + SQLite FTS
> long-term"*). I could not read that repo directly here — it is private and this session
> can't add a repo from another owner — so §8 below reasons from that description. Two things
> are worth confirming from the source, because they change §6.4: **does it keep an index or
> manifest file**, and **does its memory-management skill do its own compaction** when the
> bank grows? If it has a compaction protocol, we should port that rather than invent one.

---

## 1. We don't have a memory system. We have seven.

Each of these was the right answer to the problem in front of it. None of them share a
vocabulary for scope, lifetime, retrieval, or budget — which is why "how does memory work"
currently has no single answer.

| # | Store | Holds | Physical home | Retrieval | Scope key |
|---|---|---|---|---|---|
| 1 | **Mem0** | Extracted episodic facts | Postgres + pgvector (`mem0_memories`) | Semantic top-k | `user_id` field, repurposed: `<email>` · `agent:<name>` · `org:global` |
| 2 | **Graphiti** | Entities + bi-temporal edges | Neo4j | Graph + semantic | `group_id` = user (**on write only** — §5.2) |
| 3 | **Blob store** | The three folders — `agent-data/`, `inputs/`, `outputs/` | Postgres (`agent_blob`, `agent_file_history`) | Whole-file read by tool call | **`agent_name` only** |
| 4 | **Chat history** | The literal transcript | Postgres (`chat_session`, `chat_message`) | Windowed by recency; `query_history` SQL | `user_id` = owner email |
| 5 | **Session cache** | The assembled memory block | Redis, 10-min TTL | Direct | `thread_id` |
| 6 | **Run trace** | What happened in a run | Postgres (`agent_run`) | SQL | `run_id` |
| 7 | **App stores** | GTD, email patterns, WhatsApp, reply memory, task clarifications | Postgres, per-app tables | SQL / purpose-built vectors | Varies per app |

Three of these are *authoritative* durable state (1, 3, 4 — plus 2 when enabled). The rest are
caches, logs, or domain records. The confusion is that they all get called "memory."

---

## 2. Two philosophies, and the rule for choosing

The `agent-startup-guru` pattern (a curated memory bank in files) and our Mem0 layer (semantic
recall) look like alternatives. They aren't — they have opposite properties, and a good agent
needs both.

| | **File tier** — `agent-data/NOTES.md` | **Vector tier** — Mem0 |
|---|---|---|
| Retrieval | Whole file, deterministic | Top-k by similarity |
| Visible to a human | Yes — readable, editable, diffable | No — a row in a vector table |
| Scales | Poorly (it's prompt) | Well (it's an index) |
| Reliable | Exactly what you put there | Whatever the query surfaces |
| Failure mode | Grows until it eats the context window | Silently doesn't return the thing you needed |

> **The rule.** Ask: *if the agent didn't have this in front of it, would it do the wrong
> thing?* → **file tier**. *Would it merely miss a useful detail?* → **vector tier**.

"Never send pricing to a customer without Meera's sign-off" is the first kind — an agent that
misses it does damage. "Acme's CFO used to work at Harrow" is the second — nice to surface,
harmless to miss. Today both land wherever the model happens to put them.

The graph tier is a third thing again: it answers *what changed and when*, which neither of
the others can. That's what makes it the right home for supersession (§6.5).

---

## 3. The six tiers

| Tier | What | Store | Lifetime | Budget | Retrieval |
|---|---|---|---|---|---|
| **Working** | This run's scratch | In-context | The run | context window | always present |
| **Session** | This thread's turns | `chat_message` + Redis block | The thread | last N turns | always present, windowed |
| **Durable-explicit** | Curated knowledge the agent must always have | `agent_blob` → `agent-data/` | Forever, until compacted | **hard cap, ~2k tokens** | deterministic injection (§6.2) |
| **Durable-recalled** | The long tail of learned facts | Mem0 / pgvector | Forever, until superseded | top-k per compartment | semantic |
| **Relational** | Entities, edges, validity intervals | Graphiti / Neo4j | Forever, bi-temporal | bounded traversal | graph + semantic |
| **Structured** | Domain records — tasks, emails, deals | App tables | Per the domain | — | SQL |

Everything above the line (working, session) is bounded by construction. Everything below it
needs an explicit budget, and only one tier currently has one at all.

---

## 4. How a fact actually persists

**Postgres is authoritative for every durable tier. Disk and Redis are caches, always.**

- **Blob store** — `agent_blob` holds current content; `agent_file_history` is an append-only
  log of every unique version by sha256, with action, actor, and run/session provenance. Disk
  at `{agents_clone_dir}/repos/{agent}` is a cache; `rehydrate_workspace` restores it before
  every run, and gateway reads fault-in individual files on demand. A wiped volume loses
  nothing.
- **Mem0** — pgvector in the same Postgres. Same model: the DB is truth.
- **Redis** — only ever a cache. `cc:stream:` (1h TTL), the assembled memory block (10-min
  TTL). Nothing durable lives only here.
- **Graceful degradation is the contract everywhere** — DB down means memory functions no-op
  and return empty, and agents keep working. That's why memory can be added anywhere without
  becoming a new failure mode.

### The life of one fact

```
   said in a conversation
        │  extraction  (should be gated — §6.4)
        ▼
   vector tier  ──────────────► retrieved when relevant
        │  promotion (used repeatedly, or "always remember this")
        ▼
   file tier    ──────────────► present on every run
        │  compaction (over budget, stale, or superseded)
        ▼
   vector tier
        │  decay (unused and superseded)
        ▼
   archived — never hard-deleted, always auditable
```

Today only the first arrow exists. Everything below it is manual or absent, which is why
`NOTES.md` can only grow.

---

## 5. What's broken

Two of these were already flagged in the multiplayer docs. The third and fourth are new, and
they're in the file tier — the exact mechanism the startup-guru pattern is built on.

### 5.1 The memory API is open by path parameter

`routes/memory.py:59,71,84,97` — every route resolves `UserContext` and never compares it to
the `{user_id}` in the URL. Any signed-in user can list, search, and delete any other user's
memory scope.

### 5.2 Graphiti writes are partitioned, reads are not

`agent.py:1366` writes episodes with `group_id=user_id`; `graphiti_client.py:144` searches
with no group filter at all. Retrieval spans every user's episodes.

### 5.3 The file tier is shared across all users of an agent — and it's whole-file

`agent_blob`'s primary key is `(agent_name, path)`, and the module docstring is explicit:
*"agent_name is the only tenant key."* So there is **one `agent-data/NOTES.md` per agent, not
per user.** Two people using the email assistant append to the same file.

This is worse than the Mem0 `agent:` bucket, for a specific reason: **Mem0 leaks only what is
semantically similar to the query; the file tier leaks the entire file.** `recall_notes(path)`
with no query returns the whole thing (`note_tools.py:150`). One call, everything anyone ever
wrote.

### 5.4 …and it's model-directed, so it's also unreliable

The same tier fails in the opposite direction. Nothing injects `NOTES.md`. The tool-injection
prompt *asks* the model to fetch it (`_tool_injection.py:488-493`):

> *"Maintain `agent-data/NOTES.md` as your cross-session working memory. At the START of each
> session: read this file if it exists to restore context."*

An agent that doesn't call `recall_notes` runs with **no durable memory at all**, and nothing
detects it. So the tier is simultaneously leaky when it fires and absent when it doesn't.

Both failures have the same root cause and the same fix: the file tier should be a
deterministic, instance-keyed, budgeted injection — not an instruction to the model to go and
read a shared blob.

### 5.5 No budget, no provenance, no supersession, no correction

- **No budget.** `NOTES.md` grows forever. It is prompt, so it competes with the context
  window and eventually degrades every run — and it undercuts the prompt-caching work in
  `llm_caching_memory.md`, whose whole point is a stable, bounded prefix.
- **No provenance.** The assembled block is flat text. The agent can't say where a fact came
  from, and neither can we when a run goes wrong.
- **No supersession.** "Terms are Net 30" and "we moved to Net 45" can both be injected. The
  model picks one, silently.
- **No correction.** There is a delete-by-id API and no way for a user to say "that's wrong"
  in the place where they see the mistake. This is the biggest UX gap in the system.

---

## 6. The design

### 6.1 Instance-key the file tier, exactly like memory compartments

The blob store gains the same instance key the memory compartments get in
[`agent-kinds.md`](../../docs/multiplayer/agent-kinds.md) §4, so the two tiers partition
identically and one mental model covers both.

```sql
-- migration 120_agent_blob_instance.sql (NEVER mutate 71 in place — deployed DBs ran it)
ALTER TABLE agent_blob
    ADD COLUMN IF NOT EXISTS instance TEXT NOT NULL DEFAULT '';   -- '' = shared, u:<email>, t:<team>
ALTER TABLE agent_file_history
    ADD COLUMN IF NOT EXISTS instance TEXT NOT NULL DEFAULT '';
-- Repoint the PK: (agent_name, path) → (agent_name, instance, path)
```

| Agent instancing | Memory compartment | Blob-store instance |
|---|---|---|
| `personal` | `agent:<name>#u:<email>` | `u:<email>` |
| `team` | `agent:<name>#t:<team>` | `t:<team>` |
| `shared` | `agent:<name>` | `''` |

`''` as the default keeps every existing row valid and every shared agent working unchanged.
`rehydrate_workspace(agent, root)` gains the instance and restores the caller's workspace;
`folder_of` and the write-through seams pass it through. This touches
`blob_store.py`, the two write-through seams in `write_artifact.py` / `note_tools.py`, the
gateway mirror helpers, and the executor's rehydrate call — all listed in
`agent_persistence_implementation.md` §3–4.

**`outputs/` is the exception worth thinking about.** Deliverables are shared in a room even
when the agent is personally instanced. Simplest correct rule: `agent-data/` and `inputs/` are
instance-keyed; `outputs/` is keyed by instance too but *readable* through the room's file
view, because the room already gates who can see it.

### 6.2 Make the file tier a deterministic, bounded injection

Stop asking the model to remember to read its own memory.

At run start, alongside the Mem0 block, assemble a **memory header** from the instance's
`agent-data/` — `NOTES.md` plus any file the agent marks always-on — capped at a hard token
budget (default ~2 000). Inject it as a labelled block. Keep `recall_notes` for *targeted*
re-reads with a query filter and for everything outside the always-on set.

This is strictly better on three axes at once:

- **Reliable** — the agent can't forget to load its own memory.
- **Bounded** — the budget is enforced at assembly, and overflow triggers compaction (§6.4)
  rather than silent context bloat.
- **Cache-friendly** — a curated file is *byte-stable across turns*, unlike Mem0's semantic
  block. It belongs in the stable prefix. The session cache in `llm_caching_memory.md` Phase 4
  exists to paper over Mem0's instability; the file tier needs no papering over, so this
  *increases* the cacheable prefix rather than eating into it.

### 6.3 Provenance on every injected fact

Every line in the assembled block carries where it came from and when:

```
- Pricing over ₹40L needs Meera's sign-off            ⟦file · team:sales · 2026-06-02⟧
- Acme's renewal is ₹42L, up from ₹38L                ⟦vector · subject:deal/acme · 2026-07-19⟧
- Standard payment terms are Net 45 (was Net 30)      ⟦graph · org · valid from 2026-04-01⟧
```

The UI strips the marker; the model keeps it. This one change unlocks three things that are
impossible without it: the agent can answer *"why did you say that"* by citing rather than
inventing, the user can correct a specific fact in place (§6.7), and a run can be replayed
with the exact context it had (§6.6).

### 6.4 Promotion, compaction, decay

Concrete rules for the ladder in §4:

- **Extraction is gated.** Save decisions and durable facts, not chatter. Generalise the rule
  already proven in `agent_file_and_memory_framework.md` §8 — *save the committed outcome,
  never the proposal* — and reuse the shape of Graphiti's `_is_episode_worthy` gate for the
  Mem0 path, which currently extracts from every turn indiscriminately.
- **Promotion to the file tier is earned or explicit.** Either the user says "always remember
  this", or a fact is retrieved and used N times (default 3) across distinct sessions. Never
  on first sight — that's how a memory bank fills with noise.
- **Compaction runs when the budget is exceeded**, not on a timer. Least-recently-used facts
  are demoted back to the vector tier, and near-duplicates are merged. Demotion never deletes;
  it moves a fact out of the always-on budget.
- **Decay archives** facts that are both unused and superseded. Archived, never hard-deleted —
  `agent_file_history` is already append-only and the audit trail matters more than the bytes.

### 6.5 Supersession

Two contradictory facts must never both inject. Give every durable fact `valid_from` and
`superseded_by`, and filter at assembly: group by subject, keep the newest, and mention the
supersession only when the model asks for history.

Graphiti's bi-temporal edges are *designed* for exactly this and would do it properly — but it
is disabled (`GRAPHITI_ENABLED=false`) and has the read-scoping bug in §5.2. So there are two
honest paths: fix and enable Graphiti and let it own supersession, or implement a
`superseded_by` field at the Mem0 layer as an interim. The interim is cheap; enabling Graphiti
is the better end state. Don't do both.

### 6.6 Make runs reproducible

Memory makes a run non-deterministic, which breaks golden trajectories and makes incidents
hard to reconstruct. Store the assembled memory block — content plus hash — on the `agent_run`
row (migration 50 already has the table and the run/user/model columns). Then:

- an eval can pin the block and replay a run with identical context;
- an incident review can answer *"what did it know when it said that"*;
- a diff between two runs shows whether memory or the model changed the outcome.

The block is already assembled and already cached in Redis, so this is a write, not a system.

### 6.7 The experience

**Correction is the missing primitive.** Everything else in this doc is plumbing; this is what
users actually feel.

- **A memory chip on the turn** — *"used 3 memories"* — expands to the provenance list from
  §6.3. Per fact: **that's wrong** · **forget this** · **always remember this** (promote to
  the file tier).
- **Correcting in place, where the mistake is visible**, not in a settings screen. A wrong
  fact gets superseded with the correction, attributed to the person who caught it.
- **The inspector** ([`mockup-memory.html`](../../docs/multiplayer/mockup-memory.html)) stays
  the browse-and-audit view: compartments, per-fact audience, *what would this person see*.
- **The agent can describe its own memory** when asked, from the injected provenance instead
  of confabulating a plausible answer.

---

## 7. How this composes with multiplayer

The file tier needs the same two rules the compartments get, and it needs them more.

**Read.** The always-on file tier joins the clearance set as a compartment
(`file:agent:<name>#<instance>`). Because it is injected rather than retrieved, it is the
single most dangerous tier to get wrong in a room: a vector fact leaks only on a semantic
match, but the file tier is simply *there* on every run.

**Write.** The same rule as memory — *write audience ⊆ session audience*. A room may append to
`agent-data/` only when the instance's audience is no wider than the room. A team agent in a
room of team members: fine. The same agent in a room containing one outsider: the write goes
to room scope instead, because `agent-data/` outlives the room and would carry the fact to
everyone using that instance forever after.

| Folder | In a room |
|---|---|
| `agent-data/` | Instance-keyed. Written only when the room's audience covers the instance. |
| `inputs/` | Follows the uploader; promotable to `agent-data/` under the same write rule. |
| `outputs/` | Room-readable — files are the deliverable (`README.md` §6.2). |

---

## 8. What this means for the startup-guru pattern

The framework doc's recommendation — *copy `agent-startup-guru`* — is right about the shape.
A curated memory bank with an explicit management protocol is a better mental model than
"facts go into a vector store somewhere," and it's what makes an agent feel like it's actually
learning.

But it is a **single-user agent's design**. Two things it never needed, which a multi-user
platform cannot skip:

1. **An instance key** (§6.1). Without it, adopting a richer always-loaded memory bank
   *amplifies* §5.3 — the more the pattern succeeds, the more each user's bank contains, and
   all of it is shared.
2. **A budget with compaction** (§6.2, §6.4). A memory bank that only grows is fine for one
   person over months and fatal for an agent serving a company for years.

So: adopt the structure, add the key and the budget. And confirm the two questions in the note
at the top — if its memory-management skill already has a compaction protocol, port that
instead of inventing §6.4.

One deliberate divergence: the framework doc notes both reference repos use **SQLite FTS** for
long-term recall. We should not copy that. Our Mem0 + pgvector partition already beats lexical
FTS on semantic recall and is one store rather than two. The thing worth copying is the
*protocol* — what gets written, when, and how it's curated — which is exactly what §8 of the
framework doc already concluded.

---

## 9. Phasing

Interleaves with the multiplayer plan; the numbering matches
[`../../docs/multiplayer/README.md`](../../docs/multiplayer/README.md) §8.

| Phase | Work |
|---|---|
| **0** | Authorize `routes/memory.py` (§5.1) · scope Graphiti reads or disable the timeline call until scoped (§5.2) |
| **3a′** | Migration 120 — instance-key the blob store (§6.1), alongside the memory-compartment work. These two must land together; splitting them leaves the more dangerous tier unpartitioned. |
| **3b** | Deterministic budgeted file-tier injection (§6.2) · provenance markers (§6.3) · extraction gate (§6.4) |
| **3c** | The memory chip and in-place correction (§6.7) · run-block capture for replay (§6.6) |
| **4** | Compaction and decay (§6.4) · supersession — decide Graphiti-on vs interim field (§6.5) |

**Acceptance for 3a′** — same shape as the compartment test, at the storage layer rather than
the answer layer: two users of one personal agent both call `save_note`; assert their
`agent_blob` rows differ by `instance`, that neither user's `recall_notes` or injected header
returns the other's content, and that `rehydrate_workspace` restores only the caller's
instance.

---

## 10. Open questions

1. **Where does the always-on budget actually sit?** 2 000 tokens is a guess. It should be
   derived from the model's context and what the caching work wants in the stable prefix —
   worth measuring against a real agent's `NOTES.md` before fixing a number.
2. **Who curates the file tier — the agent or a human?** Agent-curated is the point of the
   pattern; human-reviewable is what makes it trustworthy. Probably: agent proposes, the
   promotion affordance in §6.7 is the human's veto.
3. **Should promotion be per-instance or per-agent-definition?** If every founder's coach
   independently learns the same general lesson, that's waste — but pooling it is exactly the
   leak in `agent-kinds.md` §9.1. A derived-aggregate tier with no verbatim facts is the
   likely answer, and it needs its own design.
4. **Do the app stores (7) fold into this model or stay separate?** GTD items and email
   patterns are structured domain records, not recalled facts. They probably stay separate —
   but their *derived* facts ("Vijay reschedules deep work on Fridays") belong in the tiers
   above, and nothing currently promotes them there.
5. **Does the session cache survive instance-keying?** `session_mem:{thread_id}` is keyed by
   thread, which is already per-room, so it should be fine — but it must include the clearance
   set in the key, or a room whose membership changes serves a stale block computed at a wider
   clearance.

Question 5 is a correctness issue, not a design preference — it should be resolved during 3a′.

# Agent Architecture — scopes, manifest, and lifecycle

**Status:** Draft / RFC · **Date:** 2026-07-26 · **Owner:** vjvarada

How an agent is declared, what it can see at each layer, how its knowledge is authored and
reviewed, and how it gets permanently better. This is the foundation the multiplayer work
sits on: every question the room model asks about an agent — can it be shared, whose memory
does it hold, whose files are these — is answered by the manifest defined here.

**Companions:**
[`memory_architecture.md`](memory_architecture.md) (the six memory tiers) ·
[`agent_file_and_memory_framework.md`](agent_file_and_memory_framework.md) (the three folders) ·
[`agent_persistence_implementation.md`](agent_persistence_implementation.md) (the blob store) ·
[`../../docs/multiplayer/agent-kinds.md`](../../docs/multiplayer/agent-kinds.md) (instancing) ·
[`../../docs/multiplayer/memory-clearance.md`](../../docs/multiplayer/memory-clearance.md) (clearance)

---

## 1. The scope model, formalized

The four scopes proposed are the right decomposition, and they map cleanly onto machinery
that mostly exists. Two changes make the lattice complete:

- **Agent Base splits in two.** Instructions and skills are *code*; a KB/RAG corpus is
  *authored knowledge*. Both are git-backed and review-gated, but knowledge isn't executable
  and compiles to a derived index rather than being imported. Conflating them means either
  reviewing documents like code or shipping a corpus nobody reviewed. §3.
- **A team/room layer is missing.** Between "one user" and "everyone using this agent" sits
  the case the multiplayer work is built around: a sales team, or a live room working one
  deal. Without it, a fact learned in a deal room has nowhere to go but the agent-wide bucket.

The full lattice, most-shared to most-private:

| # | Layer | Holds | Runtime-mutable | Reviewed | Store |
|---|---|---|---|---|---|
| 1 | **Global** | Injected skills · integrations (APIs/MCP) · other agents as skills · org KB + `org:global` memory | memory yes; registry admin-only | partial | registry, Mem0 `org:global` |
| 2 | **Agent Base — Code** | `agents.py`, `config.json`, `instructions.md`, local skills | **no** — mutation opens a PR | ✅ human PR | Git |
| 3 | **Agent Base — Knowledge** | Curated docs, templates, playbooks, the RAG corpus | **no** at runtime — the agent *proposes*, a human merges | ✅ human PR | Git → derived vector index |
| 4 | **Agent Shared State** | What the agent learns across everyone who uses it | yes | ✗ | Mem0 `agent:<name>#<instance>` + blob `instance` |
| 5 | **Team / Room** | Facts and artifacts belonging to a team or a live room | yes | ✗ | `t:<team>` · `room:<thread>` · `subject:<entity>` |
| 6 | **User** | Private memory, private artifacts | yes | ✗ | `user:<email>`, `prefs:<email>`, blob `u:<email>` |

Layers 4–6 are the compartments already designed in
[`memory-clearance.md`](../../docs/multiplayer/memory-clearance.md); layers 2–3 are new
territory and are what this document is mostly about.

**One clarification worth pinning down.** "Shared User Scope — shared with all users" is
ambiguous between *all users of this agent* and *all users in this room*. They're different
layers (4 vs 5) and they need different keys. And for a `personal`-instanced agent, layer 4
**does not exist at all** — there is no set of other users to share with. The manifest makes
that explicit rather than leaving it implied.

---

## 2. What already exists

| Scope element | Status |
|---|---|
| Universal skill injection across all agents | ✅ `acb_skills` + `_tool_injection.py` |
| Integrations (APIs, MCP servers) declared per agent | ✅ `config.json` `integrations` · `mcp_servers` (migration 13) |
| Org / agent / user memory scopes | ✅ `scope_key()` — three scopes today, extended in `memory-clearance.md` |
| Three folders + durable blob store | ✅ migration 71, `blob_store.py` |
| Instructions / prompt as git-backed code | ✅ agent repos + `dynamic_agents` |
| Approval-gated self-mutation | ✅ mutation sandbox → `pending_commits` → human approve |
| Eval gate before promotion | ✅ migration 06 |
| Agent-to-agent delegation | ⚠️ partial — `call_agent_background` exists, no declared contract |
| **Agent Base Knowledge (KB/RAG)** | ❌ **not built** — §5 |
| **A single manifest declaring all of it** | ❌ **not built** — §4 |
| Team / room compartments · instancing | ❌ designed, not built (multiplayer Phase 3) |

So the honest gap is two things: **a declared KB layer**, and **one manifest that ties the
scopes together** so creating an agent is filling in a form rather than knowing which six
subsystems to wire.

---

## 3. Three durability axes

The framework doc has two — Code and State — and says *"conflating them is the mistake this
framework exists to prevent."* A KB is a third thing, and conflating it with either is the
next mistake.

| Axis | What it is | Store | Reviewed | Changes at runtime |
|---|---|---|---|---|
| **Code** | What the agent *is* — executable | Git | ✅ PR | ✗ |
| **Knowledge** | What the agent *has been taught* — authored, not executable | Git + a **derived** vector index | ✅ PR | ✗ (proposals only) |
| **State** | What the agent *has accumulated* — runtime | Blob store + Mem0 | ✗ | ✓ |

Why Knowledge must be git-backed rather than accumulated:

- **Reviewable.** A pricing playbook or an escalation policy is closer to prompt than to
  data — it changes behaviour on every run. It deserves the same gate as code, and a document
  diff is *far easier* to review than a code diff, so the gate is cheap.
- **Reproducible.** The vector index is a **build artifact**, keyed by the git sha. Retrieval
  is reproducible, rollback is instant, and an eval result is meaningful because the corpus
  behind it is pinned.
- **Testable.** Golden question → expected-document pairs live beside the corpus and gate a
  KB change the way trajectories gate a code change.
- **No drift.** A corpus that accumulates at runtime is unreviewable and slowly rots. Freshness
  becomes a pull-request problem, not a data-quality problem.

State still flows *into* Knowledge — but through a human gate, which is the mechanism in §8
and the thing that makes an agent permanently better rather than merely full.

---

## 4. The agent manifest

Creating an agent should mean filling in one declaration. Everything else — compartment keys,
blob instance, tool surface, KB index, room eligibility, delegation edges — is derived by the
platform from this. Extends today's `config.json`, so existing agents remain valid.

```jsonc
{
  "name": "sales-assistant",
  "description": "Zoho pipeline, deals and follow-ups for the sales team.",
  "runtime": "maf",
  "model_tier": "tier-balanced",

  // ── Who it's for and whose memory it keeps  → agent-kinds.md ──────────
  "sharing": {
    "instancing": "team",          // personal | team | shared
    "visibility": "team",          // private | team | organization
    "team": "sales",
    "shareable": true,             // may its sessions become rooms?
    "outputs_visibility": "instance"   // instance | room | org
  },

  // ── Layer 1: what the platform lends it ──────────────────────────────
  "capabilities": {
    "skills": ["quoting", "zoho_pipeline"],
    "integrations": ["zoho-crm"],
    "optional_integrations": ["gmail-send"],
    "mcp_servers": ["drawio"],
    "agents": [                     // other agents as skills → §6
      { "name": "billing", "mode": "call",
        "when": "invoice, payment or dunning questions" },
      { "name": "delivery", "mode": "handoff",
        "when": "the conversation turns to project execution" }
    ]
  },

  // ── Layer 3: authored knowledge → §5 ─────────────────────────────────
  "knowledge": {
    "sources": [
      { "path": "kb/PLAYBOOK.md",    "always_on": true  },
      { "path": "kb/INDEX.md",       "always_on": true  },
      { "path": "kb/pricing/**.md",  "always_on": false, "distill": false },
      { "path": "kb/past-deals/**",  "always_on": false, "distill": true  }
    ],
    "index": {
      "embed_model": "text-embedding-3-small",
      "chunking": "source_aware",   // §5.2
      "retrieval": "hybrid",        // semantic + lexical + age decay — §5.3
      "top_k": 6
    }
  },

  // ── Layers 4-6: what it may remember, and how ────────────────────────
  "memory": {
    "compartments": ["prefs", "user", "subject", "room", "agent", "org"],
    "always_on_budget_tokens": 2000,
    "write": {
      "gate": "decisions_only",     // extraction hygiene — §5.4
      "distill": true               // never embed raw turns
    }
  },

  // ── The gate ─────────────────────────────────────────────────────────
  "evals": { "trajectories": "evals/golden/*.yaml", "kb_recall": "evals/kb/*.yaml" },
  "authority": "propose"            // propose | execute — outward writes
}
```

**What the platform derives from it** — the point of the exercise:

| Derived | From |
|---|---|
| `agent:sales#t:sales` memory compartment | `sharing.instancing` + `team` |
| Blob-store instance `t:sales` | same |
| Whether the Share button is enabled | `sharing.shareable` |
| Which compartments enter the clearance set | `memory.compartments` ∩ the run's clearance |
| The injected tool surface | `capabilities.*` |
| The KB index name + build trigger | `knowledge` + the repo sha |
| Which agents it may delegate to, and how | `capabilities.agents` |
| The eval gate before it can be promoted | `evals` |

---

## 5. Agent Base Knowledge — the KB layer

The design borrows from [how Cerebras built their internal knowledge base][cer] (15k
queries/day), which is the most useful public account of an enterprise KB that actually works,
and from the `agent-startup-guru` index pattern (§9).

### 5.1 One table, many sources

Cerebras put every source — Slack threads, PRs, Confluence, netlists — into **a single
Postgres table** of embeddings + distilled summaries + metadata, queryable through one
interface. That matches what we already do (`mem0_memories` is one collection partitioned by
scope key) and it's the right call: one retrieval path to optimise, one place to add hybrid
search, one index to evaluate.

So the agent KB is **not** a new store. It's one more partition:

```sql
-- migration 121_agent_kb.sql
CREATE TABLE IF NOT EXISTS agent_kb_chunk (
    id           BIGSERIAL PRIMARY KEY,
    agent_name   TEXT NOT NULL,
    kb_version   TEXT NOT NULL,          -- the git sha the index was built from
    source_path  TEXT NOT NULL,          -- kb/pricing/enterprise.md
    source_kind  TEXT NOT NULL,          -- markdown | thread | issue | table | transcript
    heading_path TEXT,                   -- "Pricing > Enterprise > Multi-year"
    raw          TEXT NOT NULL,          -- the chunk as authored
    distilled    TEXT,                   -- the LLM-rewritten record actually embedded (§5.4)
    embedding    VECTOR(1536),
    tsv          TSVECTOR,               -- lexical half of hybrid retrieval (§5.3)
    valid_from   DATE,                   -- for age decay
    metadata     JSONB NOT NULL DEFAULT '{}',
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ON agent_kb_chunk (agent_name, kb_version);
CREATE INDEX ON agent_kb_chunk USING GIN (tsv);
-- plus the pgvector index on embedding
```

`kb_version` is what makes this reviewable infrastructure rather than a pile: an index build
is pinned to a commit, two versions can coexist during a rollout, and rollback is a pointer
change.

### 5.2 Source-aware chunking

Cerebras's finding: chunking by token count destroys structure. They chunk **per source
type** — Slack threads kept whole because conversational context matters, GitHub issues split
with title and labels preserved as metadata, Confluence chunked on headings rather than raw
counts.

Ours, by `source_kind`:

| Kind | Rule |
|---|---|
| `markdown` | Split on headings; carry the full `heading_path` into every chunk |
| `thread` (WhatsApp / email / meeting) | Keep the exchange whole — splitting it destroys the resolution |
| `issue` / `task` | One chunk, title + labels + status in metadata not prose |
| `table` / `csv` | Row-group chunks with the header repeated in each |
| `transcript` | Speaker-turn boundaries, never mid-turn |

### 5.3 Hybrid retrieval — and a reversal

Cerebras fuses four signals: **full-text for exact tokens, embeddings for paraphrase, IDF to
separate signal from filler, and age decay so stale answers rank lower.**

> **This reverses a decision already recorded in this repo.**
> `task_manager_hr_planning_and_memory.md` §9 and `agent_file_and_memory_framework.md` §8 both
> concluded that because the external reference repos use lexical SQLite FTS5 and *"our Mem0 +
> pgvector already exceeds them on semantic recall,"* the lexical layer was unnecessary and the
> work was "protocol, not plumbing."
>
> The protocol half of that was right and shipped. The retrieval half was framed as
> vector-**versus**-lexical when the answer is **both**, because they fail differently.
> Embeddings are weak exactly where a company brain lives: exact tokens. Deal IDs, invoice
> numbers, ClickUp task IDs, error strings, SKUs, `ZOHO-4471`. A user searching an invoice
> number wants that row, not five semantically similar rows. Cerebras runs both and fuses.
>
> We should too — and it's cheap, because Postgres already has `tsvector`/`ts_rank` sitting
> next to pgvector in the same table. This is an addition to the existing partition, not the
> second store the earlier note (correctly) rejected.

**Age decay** also does useful work we'd otherwise build separately: it partially solves the
supersession problem in [`memory_architecture.md`](memory_architecture.md) §6.5 by ranking
stale facts down, without waiting for the full bi-temporal treatment.

### 5.4 Distillation — the biggest lesson

Cerebras's largest accuracy gain came from **not embedding raw material**. Before indexing, an
LLM reads each messy thread and rewrites it into a clean structured record — the underlying
question, a summary, the resolution, the systems involved — and *that* is what gets embedded.

This generalises past the KB and should become a platform-wide rule:

> **Never embed raw conversation. Embed a distilled record.**

It applies in two places, and in both we're currently doing the naive thing:

1. **KB ingestion** — the `distill: true` flag in the manifest. Threads, transcripts, and
   meeting notes get rewritten before embedding; already-clean authored markdown doesn't.
2. **Memory extraction** — `add_memories_background` currently extracts from every turn
   indiscriminately. Distillation is the same idea as the write-hygiene rule the framework doc
   §8 already proved (*"save the committed outcome, never the proposal"*), and Cerebras is
   evidence that it's the dominant factor in retrieval quality, not a nicety.

The `raw` column is kept alongside `distilled` so a human can always see what the distillation
came from — and so re-distilling with a better model is a rebuild, not a re-ingest.

### 5.5 The index file — always-on, small

From `agent-startup-guru`: alongside its long-term memory it keeps an
**`agent_memory_index.json`** (§9). That pattern answers the open question left in
[`memory_architecture.md`](memory_architecture.md) §10.1 about the always-on budget:

> **Always-load the index. Load entries on demand.**

`kb/INDEX.md` is a small curated map — *what this agent knows about, and where* — that fits in
the always-on budget and costs a few hundred tokens. It tells the model what's retrievable so
it knows when to reach for retrieval at all, which is the failure mode of pure RAG: the model
doesn't know what it doesn't know, so it never queries.

The index is generated from the corpus at build time and human-editable, so it doubles as the
review surface for what the agent has been taught.

### 5.6 Ingestion cadence

Cerebras ingests continuously rather than in batch. For the **authored** KB that's not needed —
it's git, so the trigger is a merge. For KB sources that point at *live* systems (a Confluence
space, a shared drive, meeting transcripts) continuous ingestion matters, and that's the same
webhook pipeline `apps/ingestion` already runs. Keep the two clearly separated: authored KB is
versioned and reviewed; ingested KB is live and unreviewed, and it must carry that distinction
in `metadata` so a room can be told which of the two an answer came from.

[cer]: https://www.cerebras.ai/blog/how-we-built-our-knowledge-base

---

## 6. Other agents as skills

Three delegation modes, declared per edge in the manifest:

| Mode | Semantics | Exists |
|---|---|---|
| `call` | Synchronous sub-agent; returns a result into the caller's turn | partially |
| `handoff` | Transfers the conversation; the target owns subsequent turns | ✗ |
| `background` | Fire-and-forget; reports back when done | ✅ `call_agent_background` |

### The rule nobody asks about until it's a breach

> **A delegated run executes at the caller's clearance, intersected with the callee's own
> declared scopes. Never wider.**

If agent A runs in a room cleared for `subject:acme` and delegates to agent B, B must not read
`subject:falcon` merely because B's manifest lists `subject` compartments — B inherits the
*run's* clearance and narrows it by its own declaration. Without this, delegation is a
privilege-escalation path: anything you can't ask A, you ask A to ask B.

Three more constraints that follow:

- **Writes land in the callee's compartments, tagged with the delegating run** — so provenance
  survives a chain and "why does the agent know this" is answerable.
- **Depth and cycle guard.** A `call` chain has a max depth (default 3) and a visited set; a
  cycle is an error, not a hang. `background` children already cascade-cancel with the parent
  (`_BACKGROUND_CHILDREN` in `stream_relay.py`), which is the right precedent.
- **`handoff` in a room is a room event**, not a silent swap — the participants must see that
  they're now talking to a different agent, with a different acting identity and a different
  clearance.

---

## 7. Runtime context assembly

Six scopes have to become one prompt, deterministically and within a budget. This is also
where the existing prompt-caching work is either helped or wasted.

```
┌─ STABLE PREFIX (cacheable — byte-identical across a thread's turns) ─┐
│ 1. Base instructions                      git            ~800 tok   │
│ 2. Always-on knowledge: kb/INDEX.md + always_on docs
│                                           git @ sha     ~1500 tok   │
│ 3. Tool surface                           injection      ~900 tok   │
├──────────────────── <!-- CACHE BREAK --> ───────────────────────────┤
│ 4. org:global memory                                      ~300 tok   │
│ 5. agent / team shared memory                             ~400 tok   │
│ 6. room + subject memory (if in a room)                   ~700 tok   │
│ 7. user + prefs memory (solo, or prefs only in a room)    ~400 tok   │
│ 8. Retrieved KB chunks (top-k, hybrid)                   ~1200 tok   │
│ 9. Session history                                       windowed    │
└─────────────────────────────────────────────────────────────────────┘
```

Three properties worth being deliberate about:

- **The KB sits in the stable prefix, memory does not.** Authored knowledge is byte-stable for
  a given sha, so it belongs above the `<!-- CACHE BREAK -->` sentinel the caching work already
  uses (`prompt_cache.py`). This *grows* the cacheable prefix rather than eating it — the
  opposite of what an always-growing `NOTES.md` does today.
- **Budgets are fixed allocations, not first-come-first-served.** A scope that overruns is
  truncated by relevance within its own allocation, so a chatty compartment can never starve
  the others.
- **Precedence on conflict: most-specific wins.** `user` > `room`/`subject` > `team` > `agent`
  > `org` > `KB`. With provenance markers
  ([`memory_architecture.md`](memory_architecture.md) §6.3) the model can say which layer it
  used, and a user can see that their personal instruction overrode a company default rather
  than wondering why the answer differs from a colleague's.

---

## 8. Lifecycle — how an agent is created and gets better

```
 scaffold ──► author ──► validate ──► eval gate ──► register ──► run
                ▲                                                 │
                │                                                 ▼
          human review ◄── propose ◄── promote ◄──────────── accumulate
             (PR)          (Code or Knowledge)                (State)
```

1. **Scaffold** — `agent init` writes the manifest, the three folders, `kb/INDEX.md`, and a
   golden eval stub. The App Workshop is the precedent for doing this in-platform.
2. **Author** — instructions, skills, KB documents. In VS Code today; in the workbench later.
   Either way the output is a reviewable diff.
3. **Validate** — manifest schema, declared integrations resolve, KB sources exist, no skill
   or agent edge dangles.
4. **Eval gate** — golden trajectories *and* KB recall pairs. Migration 06 already gates
   promotion; the KB half is new.
5. **Register** — `dynamic_agents` row derived from the manifest, KB index built at the sha.
6. **Run** — context assembled per §7.
7. **Accumulate** — State: memory compartments and `agent-data/`. Unreviewed by design.
8. **Promote** — this is the loop that matters. A fact that has proven itself in State
   (repeatedly retrieved, explicitly confirmed) becomes a **proposal** to Knowledge or Code.
9. **Review** — the proposal is a PR: a diff to `kb/*.md` or to `instructions.md`. Merging it
   moves the learning from unreviewed state into reviewed base scope, where it is versioned,
   evaluated, and rolled back like anything else.

Step 8→9 is the answer to *"deliberate hardening and development, learning from failures."*
Today the mutation flow does this for **code** only. Extending the same gate to **knowledge**
is a much smaller change — the sandbox already produces a commit and the approval inbox
already reviews one — and it is where most real learning actually belongs. An agent that
learned "always check the PO number before invoicing" should end up with that in its playbook,
reviewed, not as a vector row nobody can see.

---

## 9. What we already took from `agent-startup-guru`

You asked whether we'd used it before. **Yes — it's not just a reference, it's a registered
agent in this platform, and its memory pattern was reviewed and partly adopted, partly
rejected on purpose.**

| Trace | Where |
|---|---|
| Registered as a live external agent | `agent_repo_compatibility.md`, `agents-workspaces-artifacts.md:38` (`dynamic_agents`) |
| Explicitly handled in the loader | `acb_skills/loader.py:1543` — "agents from external GitHub orgs (e.g. `vjvarada/agent-startup-guru`)" |
| Drove a real rendering fix | The "startup-guru bug" — pre-tool answer text buried in the thinking pane — fixed across four parity layers (`chatStream.ts:232`, `e2e/chat.spec.ts:341`, `core_module_map.md:96`) |
| Its memory **protocol** adopted | `agent_file_and_memory_framework.md` §8 (the five-step recipe) and `gateway/routes/tasks/task_memory.py` (the task-manager's clarification memory) |
| Its memory **storage** rejected | `task_manager_hr_planning_and_memory.md` §9 — it uses lexical SQLite FTS5; we kept Mem0 + pgvector |
| Its layout documented | `agent_repo_compatibility.md:667` — `outputs/_memory/` holding `agent_long_term_memory.json` + `agent_memory_index.json` |

So the protocol layer — retrieval routing, write hygiene, decision→outcome — is already in.

**What we did not take, and now should: the index file.** `agent_memory_index.json` sitting
beside the long-term store is exactly the always-on-index pattern in §5.5, and it answers the
budget question left open in `memory_architecture.md` §10.1. Small always-on map, large
on-demand entries.

**What we should still not take:** the SQLite FTS store as a *separate* store. But note the
nuance in §5.3 — the earlier conclusion overshot from "don't add a second store" to "don't do
lexical retrieval at all," and lexical belongs in the same table as a second ranking signal.

> I could not read the repo directly for this pass — it's private and this session can't add a
> repo from another owner — so the above is from traces in our own codebase and docs, which
> turn out to be substantial. Still worth confirming from source: whether its
> memory-management skill implements **compaction** when the bank grows. If it does, port that
> instead of the design in `memory_architecture.md` §6.4.

---

## 10. Phasing

| Phase | Work | Depends on |
|---|---|---|
| **A — Manifest** | Manifest schema + validator · derive `dynamic_agents` from it · backfill all 12 agents · `agent init` scaffold | — |
| **B — Knowledge layer** | Migration 121 · build-at-sha indexer · source-aware chunking · `kb/INDEX.md` always-on injection · KB recall evals | A |
| **C — Retrieval quality** | Hybrid semantic + lexical + IDF + age decay · distillation on ingest and on memory extraction | B |
| **D — Delegation** | The three modes, declared edges, the clearance-intersection rule, depth/cycle guard | A + multiplayer 3a |
| **E — Promotion loop** | State → Knowledge proposals through the existing mutation/approval gate | B + multiplayer 3a |

A and B are independent of the multiplayer work and can start now. D and E need compartments
to exist first.

**Acceptance for A** — every agent's runtime behaviour is derivable from its manifest alone:
no compartment key, blob instance, tool surface, or room eligibility is computed from a
hardcoded name anywhere in the codebase.

---

## 11. Open questions

1. **Does the KB belong in the agent's repo or its own?** In-repo keeps knowledge versioned
   with the code that uses it and makes one PR cover both. A separate repo lets
   non-engineers edit a playbook without touching an agent repo — which is probably the
   stronger argument for the agents most worth teaching.
2. **Who may merge a Knowledge PR?** Code review needs an engineer; a pricing playbook needs
   the sales lead. If the gate is the same, knowledge changes will queue behind engineering
   review and stop happening. Likely a separate reviewer set keyed on path.
3. **Distillation cost.** An LLM pass per chunk on ingest is real money on a large corpus.
   Probably tier-1 model, cached by content hash, and only where `distill: true`.
4. **Team identity.** `t:<team>` needs a real team object; the org research doc's `module` is
   the natural home but isn't built. Interim: an explicit member list on the manifest.
5. **Does a `personal` agent get a per-user KB?** The base KB is shared by construction (it's
   git). But "my own documents this agent should always know" is a real want, and it is
   layer 6 knowledge — which the current three-axis model has no slot for. Possibly
   `agent-data/kb/` under the user's blob instance, indexed into the same table with the
   instance as a partition key.
6. **Manifest versioning.** When the schema changes, do old manifests migrate automatically or
   fail validation? Fail-and-fix is safer while there are twelve agents; auto-migrate becomes
   necessary once there are two hundred.

Question 5 is the one most likely to bite early — it's the natural next request after anyone
uses a personal agent for a week.

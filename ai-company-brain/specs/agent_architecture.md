# Agent Architecture — how agents are declared, stored, and run

**Status:** Draft / RFC · **Date:** 2026-07-26 · **Owner:** vjvarada
**Supersedes:** the distributed-repo framing in the 2026-07-26 first draft of this file.

How an agent is defined, what it can see at each layer, how its knowledge is authored, and how
it gets permanently better — for agents that live **inside CommandCenter**: first-party agents
in `apps/agents/`, and agents built in-platform by the upcoming **Agent Creator**.

Externally-hosted agents cloned from third-party GitHub repos were the VS Code-era model. They
still load, but they are no longer the shape the architecture is designed around, and nothing
new should be built that way.

**Companions:**
[`memory_architecture.md`](memory_architecture.md) (the six memory tiers) ·
[`agent_file_and_memory_framework.md`](agent_file_and_memory_framework.md) (the three folders) ·
[`agent_persistence_implementation.md`](agent_persistence_implementation.md) (the blob store) ·
[`../../docs/app-workshop/README.md`](../../docs/app-workshop/README.md) (**the precedent this
copies**) ·
[`../../docs/multiplayer/agent-kinds.md`](../../docs/multiplayer/agent-kinds.md) (instancing) ·
[`../../docs/multiplayer/memory-clearance.md`](../../docs/multiplayer/memory-clearance.md) (clearance)

---

## 1. The thesis: an agent is a declaration, not a program

Look at what our first-party agents actually contain:

| Agent | `agents.py` | What the code does |
|---|---|---|
| `agent-orchestrator` | **24 lines** | Calls `build_orchestrator_agent()`. Pure delegation. |
| `agent-app-builder` | **48 lines** | Imports tools, reads `instructions.md`, returns an agent. |
| `agent-apis-config` | **63 lines** | Same shape. |
| `agent-task-manager` | **136 lines** | Imports 25 GTD tools, reads instructions, sets a model tier. |
| `agent-whatsapp-assistant` | 480 lines | Real bespoke logic. |
| `agent-email-assistant` | 1 954 lines | Real bespoke logic. |

**Four of six are boilerplate a manifest expresses exactly**: read `instructions.md`, import a
named set of tools, pick a model tier, return one agent. There is no control flow. The Python
is a costume.

So the central split:

| | **Declarative agent** *(the default)* | **Code agent** *(the exception)* |
|---|---|---|
| Defined by | manifest + instructions + KB | manifest + `agents.py` |
| Authored in | the Agent Creator, or a manifest file in-repo | VS Code, in `apps/agents/` |
| Stored in | Postgres — `agent_defs` + `agent_def_versions` | Git (the monorepo) |
| Runs on | **one shared generic MAF builder** | its own factory |
| Changed by | edit draft → publish version (approval-gated) | pull request |
| Who can create one | anyone with the permission | engineers |
| Reviewed by | the approval inbox (a manifest + prose diff) | code review |

**The test for needing code:** does the agent need control flow a manifest can't express — a
bespoke multi-step pipeline, a state machine, a non-tool integration? If the answer is
"instructions plus tools plus knowledge," it's declarative. On today's roster that's four of
six, and the two exceptions are the two with genuine logic.

### Why this matters beyond ergonomics

It resolves three separate problems at once:

1. **It removes the production blocker in `DESIGN_LIMITATION_native_maf_mutation.md`.** A
   declarative agent's change is a row version behind an approval gate — no monorepo PR, no
   CI, no third-party pushing to a shared repo. The DEV-ONLY limitation then applies only to
   **code agents**, which are first-party by definition. The hardest unresolved question about
   the workbench stops applying to the majority case.
2. **The Agent Creator never has to generate Python.** That is where agent builders usually
   fail — generated code needs review, tests, and a sandbox. Generating a *manifest* needs a
   schema validator.
3. **The manifest becomes load-bearing instead of decorative** — see §3, where three agents
   currently contradict their own config file and nothing notices.

---

## 2. The scope lattice

The four proposed scopes are the right decomposition. Two changes complete them: **Agent Base
splits into Code and Knowledge** (§4), and **a team/room layer** sits between one user and
everyone.

| # | Layer | Holds | Runtime-mutable | Reviewed | Store |
|---|---|---|---|---|---|
| 1 | **Global** | Injected skills · integrations (API/MCP) · other agents as skills · `org:global` memory | memory yes; registry admin-only | partial | registry, Mem0 `org:global` |
| 2 | **Agent Base — Code** | Declarative: the manifest. Code agents: `agents.py`, skills | **no** — publish or PR | ✅ | `agent_defs` / Git |
| 3 | **Agent Base — Knowledge** | Curated docs, templates, playbooks, the RAG corpus | **no** at runtime — the agent *proposes* | ✅ | Git or `agent_kb_source` → derived index |
| 4 | **Agent Shared State** | What it learns across everyone who uses it | yes | ✗ | Mem0 `agent:<name>#<instance>` + blob `instance` |
| 5 | **Team / Room** | Facts and artifacts belonging to a team or a live room | yes | ✗ | `t:<team>` · `room:<thread>` · `subject:<entity>` |
| 6 | **User** | Private memory, private artifacts | yes | ✗ | `user:`, `prefs:`, blob `u:<email>` |

> **"Shared with all users" is ambiguous** between *all users of this agent* (layer 4) and
> *all users in this room* (layer 5). Different keys. And for a `personal`-instanced agent
> layer 4 **does not exist** — there is no set of other users to share with. The manifest
> states which, rather than leaving it implied.

**The per-user partition convention is already proven here.** `app_data` (migration 114) keys
rows by `(table, key, user_scope)` where *"`user_scope` `''` = shared row, else a per-user
partition."* That is exactly the instance key proposed for the blob store in
[`memory_architecture.md`](memory_architecture.md) §6.1 — so it follows an existing
CommandCenter convention rather than inventing one.

---

## 3. Two findings in the current agents

### 3.1 `runtime` is decorative — half the roster contradicts it

Every first-party agent declares `"runtime": "maf"` in `config.json`. Three of them build a
**Copilot SDK** agent anyway:

| Agent | Declared | `agents.py` imports | Actually builds |
|---|---|---|---|
| `agent-apis-config` | `maf` | `agent_framework_github_copilot` ×6 | `GitHubCopilotAgent` |
| `agent-app-builder` | `maf` | `agent_framework_github_copilot` ×6 | `GitHubCopilotAgent` |
| `agent-task-manager` | `maf` | `agent_framework_github_copilot` ×6 | `GitHubCopilotAgent` |
| `agent-email-assistant` | `maf` | `agent_framework` | MAF ✅ |
| `agent-whatsapp-assistant` | `maf` | `agent_framework` | MAF ✅ |
| `agent-orchestrator` | `maf` | (delegates) | MAF ✅ |

The loader imports `agents.py` and uses whatever the factory returns, so `runtime` is never
checked against reality. This contradicts AGENTS.md Global Constraints #6 and #9 (*"MAF is the
PRIMARY native agent runtime… the Copilot SDK is not a general execution path for
specialist agents"*) — the constraint is stated but nothing enforces it.

Note the inversion: **the thin agents are Copilot; the agents with real logic are MAF.** The
SDK isn't buying those three anything. It's VS Code-era scaffolding.

### 3.2 Those same three silently bypass the B6 permission policy

`permissions_sandbox_b6.md` replaced `approve_all` with a risk-aware handler. The executor
applies it at five sites, all guarded the same way
(`executor.py:609, 2139, 2633, 3513, 4042`):

```python
if hasattr(_a, "_permission_handler") and _a._permission_handler is None:
    _a._permission_handler = _copilot_permission_handler()
```

But those agents set it themselves in their factory:

```python
default_options={..., "on_permission_request": PermissionHandler.approve_all}
```

so `_permission_handler` is **not** None, the guard skips, and the risk-aware policy never
applies. Every shell command, file write, and network call runs auto-approved. B6 shipped in
the executor and is defeated in three agent factories.

Both findings have the same root cause and the same fix: **an agent's own code is
authoritative over platform policy.** Declarative agents remove the failure entirely, because
there is no factory to override anything.

---

## 4. Three durability axes

The framework doc has two — Code and State — and says conflating them is the mistake it exists
to prevent. A KB is a third thing, and conflating it with either is the next mistake.

| Axis | What | Store | Reviewed | Runtime-mutable |
|---|---|---|---|---|
| **Code** | What the agent *is* | `agent_defs` (declarative) or Git (code agents) | ✅ | ✗ |
| **Knowledge** | What it *has been taught* — authored, not executable | Git or `agent_kb_source`, plus a **derived** index | ✅ | ✗ (proposals only) |
| **State** | What it *has accumulated* | Blob store + Mem0 | ✗ | ✓ |

Knowledge must be reviewed and versioned because it changes behaviour on every run — it is
closer to prompt than to data — and because a document diff is *far cheaper* to review than a
code diff, so the gate costs almost nothing. The index is a build artifact keyed by the source
version, which makes retrieval reproducible, rollback instant, and eval results meaningful.

---

## 5. Storage — copy Custom Apps exactly

The App Workshop already solved "a non-engineer authors an artifact in-platform, it is
versioned, publishable, shareable, and durable." An agent is the same problem.

```sql
-- migration 122_agent_definitions.sql  (mirrors 114/115)

CREATE TABLE IF NOT EXISTS agent_defs (          -- the editable DRAFT (edit-model)
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    slug               TEXT UNIQUE NOT NULL,     -- the stable agent_name key
    name               TEXT NOT NULL,
    owner_email        TEXT NOT NULL,
    manifest           JSONB NOT NULL DEFAULT '{}',   -- §6
    instructions       TEXT NOT NULL DEFAULT '',
    status             TEXT NOT NULL DEFAULT 'draft'
                         CHECK (status IN ('draft','live','archived')),
    live_version       INT,                      -- NULL until first publish
    builder_session_id TEXT,                     -- the Agent Creator chat that made it
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS agent_def_versions (  -- immutable PUBLISHED snapshots (run-model)
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_id        UUID NOT NULL REFERENCES agent_defs(id) ON DELETE CASCADE,
    version         INT  NOT NULL,
    manifest        JSONB NOT NULL,
    instructions    TEXT NOT NULL,
    kb_version      TEXT,                        -- the KB index this version runs against
    scope_set_hash  TEXT,                        -- sha of sorted capability scopes — re-consent trigger
    release_notes   TEXT DEFAULT '',
    published_by    TEXT NOT NULL,
    published_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (agent_id, version)
);

CREATE TABLE IF NOT EXISTS agent_def_grants (    -- same subject vocabulary as app_grants
    agent_id   UUID NOT NULL REFERENCES agent_defs(id) ON DELETE CASCADE,
    subject    TEXT NOT NULL,        -- 'org' | '<email>' | 'team:<slug>' | 'agent:<name>'
    granted_by TEXT,
    granted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (agent_id, subject)
);
```

Three properties inherited from the Custom Apps model, all of which matter here:

- **Edit-model / run-model split.** Runs execute a published *version*, never the draft. So
  **publishing does not affect an in-flight run** — the same principle as clearance and acting
  identity being fixed at run start in the multiplayer design. A room whose agent is
  redefined mid-run is a bug, and this makes it impossible.
- **`scope_set_hash`.** When a new version widens what the agent can touch, the hash changes
  and consent is re-requested rather than silently inherited. Custom Apps already does this
  for tool grants; agents need it more.
- **Rollback is a pointer move.** `live_version` repoints to an older row.

`dynamic_agents` (migration 15) stays as the **resolved runtime view** — one row per runnable
agent, whether it came from `agent_defs`, `apps/agents/`, or a legacy clone — so every existing
consumer keeps working.

---

## 6. The manifest

One declaration, from which the platform derives everything. Declarative and code agents use
the same schema; a code agent adds `"entrypoint"`.

```jsonc
{
  "schema_version": 1,
  "slug": "sales-assistant",
  "name": "Sales Assistant",
  "description": "Zoho pipeline, deals and follow-ups for the sales team.",

  "kind": "declarative",             // declarative | code
  // "entrypoint": "apps/agents/agent-email-assistant/agents.py:build_agents",  // code only

  "runtime": "maf",                  // maf | copilot — VALIDATED against the entrypoint (§3.1)
  "model": { "tier": "tier-balanced", "fallback": "tier-fast" },

  "sharing": {                       // → agent-kinds.md
    "instancing": "team",            // personal | team | shared
    "visibility": "team",            // private | team | organization
    "team": "sales",
    "shareable": true,               // may its sessions become multiplayer rooms?
    "outputs_visibility": "instance" // instance | room | org
  },

  "capabilities": {
    "skills": ["quoting", "zoho_pipeline"],
    "integrations": ["zoho-crm"],
    "optional_integrations": ["gmail-send"],
    "mcp_servers": ["drawio"],
    "tool_scope": ["remember", "save_note", "emit_generative_ui"],
    "agents": [                      // other agents as skills → §8
      { "slug": "billing",  "mode": "call",
        "when": "invoice, payment or dunning questions" },
      { "slug": "delivery", "mode": "handoff",
        "when": "the conversation turns to project execution" }
    ]
  },

  "knowledge": {                     // → §7
    "sources": [
      { "path": "kb/INDEX.md",      "always_on": true },
      { "path": "kb/PLAYBOOK.md",   "always_on": true },
      { "path": "kb/pricing/**.md", "always_on": false },
      { "path": "kb/past-deals/**", "always_on": false, "distill": true }
    ],
    "index": { "chunking": "source_aware", "retrieval": "hybrid", "top_k": 6 }
  },

  "memory": {
    "compartments": ["prefs", "user", "subject", "room", "agent", "org"],
    "always_on_budget_tokens": 2000,
    "write": { "gate": "decisions_only", "distill": true }
  },

  "permissions": { "mode": "enforce", "authority": "propose" },  // never approve_all (§3.2)
  "evals": { "trajectories": "evals/golden/*.yaml", "kb_recall": "evals/kb/*.yaml" }
}
```

**What the platform derives** — the point of the exercise:

| Derived | From |
|---|---|
| Memory compartment `agent:sales#t:sales` | `sharing.instancing` + `team` |
| Blob-store instance `t:sales` | same |
| Whether the Share button is enabled | `sharing.shareable` |
| Which compartments enter the clearance set | `memory.compartments` ∩ the run's clearance |
| The injected tool surface | `capabilities.*` |
| The KB index and when to rebuild it | `knowledge` + source version |
| Delegation edges and their depth guard | `capabilities.agents` |
| The permission handler | `permissions.mode` — **platform-owned, not agent-owned** |
| The eval gate before publish | `evals` |

### 6.1 One generic builder

A declarative agent has no factory. The platform has exactly one:

```python
def build_declarative_agent(defn: AgentDefinition, ctx: RunContext) -> ChatAgent:
    return ChatAgent(
        instructions = assemble_context(defn, ctx),        # §9
        tools        = resolve_tools(defn.capabilities, ctx),
        chat_client  = gateway_v1_client(defn.model, ctx),
    )
```

Every declarative agent runs the same code path, so observability, permissions, caching, and
memory improvements land once for all of them — instead of being re-implemented, or quietly
overridden, per factory.

---

## 7. Knowledge — the KB layer

Drawing on [how Cerebras built their internal knowledge base][cer] (15k queries/day) and the
index-file pattern from `agent-startup-guru`.

**One table, many sources.** Cerebras put every source into a single Postgres table of
embeddings + distilled summaries + metadata, queryable through one interface. That matches
what `mem0_memories` already does. So the KB is one more partition, not a new store:

```sql
-- migration 123_agent_kb.sql
CREATE TABLE IF NOT EXISTS agent_kb_chunk (
    id           BIGSERIAL PRIMARY KEY,
    agent_slug   TEXT NOT NULL,
    kb_version   TEXT NOT NULL,     -- git sha, or agent_def_versions.version
    instance     TEXT NOT NULL DEFAULT '',   -- '' = base KB; u:<email> for a personal KB (§12.5)
    source_path  TEXT NOT NULL,
    source_kind  TEXT NOT NULL,     -- markdown | thread | issue | table | transcript
    heading_path TEXT,
    raw          TEXT NOT NULL,     -- as authored
    distilled    TEXT,              -- the record actually embedded
    embedding    VECTOR(1536),
    tsv          TSVECTOR,          -- lexical half of hybrid retrieval
    valid_from   DATE,              -- age decay
    metadata     JSONB NOT NULL DEFAULT '{}',
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

**Source-aware chunking.** Token-count chunking destroys structure. Chunk per `source_kind`:
markdown on headings (carrying the full `heading_path`), threads kept whole because the
resolution lives in the exchange, issues as one chunk with title/labels in metadata, tables as
row groups with the header repeated, transcripts on speaker turns.

**Distillation — the biggest lever.** Cerebras's largest accuracy gain came from *not
embedding raw material*: an LLM rewrites each messy source into a clean structured record
(the question, a summary, the resolution, the systems involved) and that is what gets embedded.
Generalise it:

> **Never embed raw conversation. Embed a distilled record.**

This applies to KB ingestion (`distill: true`) **and** to memory extraction, where
`add_memories_background` currently extracts from every turn indiscriminately. It is the same
idea as the write-hygiene rule the framework doc §8 already proved — *save the committed
outcome, never the proposal* — and Cerebras is evidence it dominates retrieval quality. Keep
`raw` alongside `distilled` so re-distilling with a better model is a rebuild, not a re-ingest.

**Hybrid retrieval — and a correction.** Cerebras fuses full-text for exact tokens, embeddings
for paraphrase, IDF to separate signal from filler, and age decay so stale answers rank lower.

> This revises a conclusion already recorded here. `task_manager_hr_planning_and_memory.md` §9
> and `agent_file_and_memory_framework.md` §8 reasoned that because the reference repos use
> lexical SQLite FTS5 and *"our Mem0 + pgvector already exceeds them on semantic recall,"* the
> lexical layer was unnecessary. The protocol half of that was right and shipped. The
> retrieval half framed it as vector-**versus**-lexical when the answer is both: embeddings
> are weakest exactly where a company brain lives — `ZOHO-4471`, invoice numbers, task IDs,
> SKUs, error strings. Someone searching an invoice number wants *that row*. Adding `tsvector`
> beside pgvector **in the same table** is not the second store that note correctly rejected.

Age decay also partly solves supersession ([`memory_architecture.md`](memory_architecture.md)
§6.5) without waiting for full bi-temporal handling.

**The index file.** `kb/INDEX.md` — a small curated map of *what this agent knows about and
where* — is always-on and costs a few hundred tokens. It exists because the failure mode of
pure RAG is that the model doesn't know what it doesn't know, so it never queries. This is the
`agent_memory_index.json` pattern from `agent-startup-guru`, and it answers the always-on
budget question left open in [`memory_architecture.md`](memory_architecture.md) §10.1:
**always-load a small index, load entries on demand.**

[cer]: https://www.cerebras.ai/blog/how-we-built-our-knowledge-base

---

## 8. Other agents as skills

| Mode | Semantics | Today |
|---|---|---|
| `call` | Synchronous sub-agent; result returns into the caller's turn | partial |
| `handoff` | Transfers the conversation; the target owns subsequent turns | ✗ |
| `background` | Fire-and-forget; reports back | ✅ `call_agent_background` |

> **A delegated run executes at the caller's clearance, intersected with the callee's declared
> scopes. Never wider.**

Without this, delegation is a privilege-escalation path: anything you can't ask agent A, you
ask A to ask B. Three consequences: writes land in the callee's compartments **tagged with the
delegating run** so provenance survives a chain; `call` chains carry a depth limit (default 3)
and a visited set, so a cycle is an error rather than a hang — `background` children already
cascade-cancel with their parent (`stream_relay._BACKGROUND_CHILDREN`), which is the right
precedent; and a `handoff` inside a room is a **room event**, because the participants are now
talking to a different agent with a different acting identity.

---

## 9. Runtime context assembly

Six scopes become one prompt, deterministically and within a budget — and either help or waste
the existing prompt-caching work.

```
┌─ STABLE PREFIX (cacheable — byte-identical across a thread's turns) ─┐
│ 1. Base instructions                    published version  ~800 tok │
│ 2. Always-on knowledge: kb/INDEX.md + always_on docs
│                                         kb_version        ~1500 tok │
│ 3. Tool surface                         derived            ~900 tok │
├──────────────────── <!-- CACHE BREAK --> ───────────────────────────┤
│ 4. org:global memory                                        ~300 tok │
│ 5. agent / team shared memory                               ~400 tok │
│ 6. room + subject memory (in a room)                        ~700 tok │
│ 7. user + prefs memory (solo; prefs only in a room)         ~400 tok │
│ 8. Retrieved KB chunks (top-k hybrid)                      ~1200 tok │
│ 9. Session history                                          windowed │
└─────────────────────────────────────────────────────────────────────┘
```

- **The KB sits above the cache break, memory below.** A published version + a pinned
  `kb_version` are byte-stable, so they belong in the stable block that `prompt_cache.py`
  already marks. This **grows** the cacheable prefix — the opposite of what an
  ever-growing `NOTES.md` does today.
- **Budgets are fixed allocations**, so a chatty compartment can't starve the others.
- **Precedence on conflict: most-specific wins** — `user` > `room`/`subject` > `team` >
  `agent` > `org` > `KB` — with provenance markers so the model can say which layer it used.

---

## 10. Lifecycle

```
  Agent Creator  ──►  draft  ──►  validate  ──►  eval gate  ──►  publish v(n)  ──►  run
   (a chat)             ▲                                                           │
                        │                                                           ▼
                 human approval ◄── propose ◄── promote ◄──────────────────  accumulate
                  (manifest /                (Knowledge or                      (State)
                   prose diff)                instructions)
```

1. **Create.** A conversation with the Agent Creator: *what should it do, who is it for, what
   can it touch, what should it know.* It writes a **manifest + instructions + starter KB** —
   never Python. Same shape as the App Workshop's describe-to-create bar.
2. **Validate.** Manifest schema; declared integrations and skills resolve; delegation edges
   exist and don't cycle; **`runtime` matches the entrypoint** (§3.1); KB sources exist.
3. **Eval gate.** Golden trajectories plus KB-recall pairs. Migration 06 already gates
   promotion; the KB half is new.
4. **Publish.** Inserts an immutable `agent_def_versions` row and repoints `live_version`. A
   changed `scope_set_hash` triggers re-consent.
5. **Run.** Context assembled per §9, on the one generic builder.
6. **Accumulate.** State: memory compartments and `agent-data/`. Unreviewed by design.
7. **Promote.** A fact that has proven itself in State — repeatedly retrieved, explicitly
   confirmed — becomes a *proposal* to Knowledge or to instructions.
8. **Review.** The proposal is a diff. For a declarative agent it is a manifest/prose diff in
   the approval inbox that already exists for pending commits — **no PR, no CI, no monorepo
   write.** For a code agent it stays a pull request.

Step 7→8 is the loop that answers *"deliberate hardening, learning from failures."* Today the
mutation flow does this for code only, through a sandbox that opens a monorepo PR. For
declarative agents the same intent needs none of that machinery — an agent that learned
"always check the PO number before invoicing" should end up with that line in its reviewed
playbook, not as a vector row nobody can see.

---

## 11. Migrating the roster

The Copilot SDK keeps exactly two legitimate homes, both already stated in AGENTS.md #6:
**genuine coding agents** and **the self-mutation sandbox**. Everything else moves to
declarative MAF.

| Agent | Now | Target | Why |
|---|---|---|---|
| `agent-task-manager` | Copilot, 136 ln | **Declarative** | Instructions + 25 GTD tools. No control flow. |
| `agent-apis-config` | Copilot, 63 ln | **Declarative** | Same shape. |
| `agent-orchestrator` | MAF, 24 ln | **Declarative** (delegation-heavy) | Its routing becomes `capabilities.agents` edges (§8). |
| `agent-app-builder` | Copilot, 48 ln | **Code, stays Copilot** | It *is* a coding agent — the SDK is the point. |
| `agent-whatsapp-assistant` | MAF, 480 ln | **Code** | Real bespoke logic. |
| `agent-email-assistant` | MAF, 1 954 ln | **Code** | Real bespoke logic. |

Independently of the migration, **remove `PermissionHandler.approve_all` from all three
factories now** (§3.2) so the B6 risk-aware policy applies. That is a three-line fix and
shouldn't wait for anything here.

---

## 12. Phasing

| Phase | Work | Depends on |
|---|---|---|
| **A0** | Drop `approve_all` from the three factories; add a startup check that `runtime` matches the entrypoint | — |
| **A** | Manifest schema + validator · `agent_defs`/`agent_def_versions`/`agent_def_grants` (122) · derive `dynamic_agents` from them · backfill all six | A0 |
| **B** | The one generic `build_declarative_agent` · migrate task-manager and apis-config · retire their `agents.py` | A |
| **C** | Agent Creator UI — describe-to-create, draft/publish/rollback, mirroring the Workshop | B |
| **D** | Knowledge layer: migration 123 · source-aware chunking · `kb/INDEX.md` always-on · KB-recall evals | A |
| **E** | Retrieval quality: hybrid + IDF + age decay · distillation on ingest and on memory extraction | D |
| **F** | Delegation modes + the clearance-intersection rule | A + multiplayer 3a |
| **G** | Promotion loop: State → Knowledge proposals into the approval inbox | D + multiplayer 3a |

A0 is a same-day fix. A–C are the Agent Creator's critical path and don't depend on the
multiplayer work.

**Acceptance for A:** every agent's runtime behaviour is derivable from its manifest alone —
no compartment key, blob instance, tool surface, permission handler, or room eligibility is
computed from a hardcoded agent name anywhere in the codebase.

---

## 13. Open questions

1. **Where does a declarative agent's KB live?** `agent_kb_source` rows next to `agent_defs`
   (editable in-platform, consistent with the rest of the model) or files in the monorepo
   (diffable in Git)? In-platform is more consistent; Git is more reviewable. Probably
   in-platform with an export, since the reviewer for a pricing playbook is not an engineer.
2. **Who may publish?** Publishing changes what an agent does for everyone who uses it.
   Owner-only is too narrow for a team agent, org-wide is too broad. Likely mirrors
   `agent_def_grants` with a separate `can_publish` bit.
3. **Can a declarative agent be forked to a code agent?** Almost certainly needed — someone
   hits the ceiling of the manifest. Export a scaffolded `agents.py` from the manifest and
   flip `kind`, one-way.
4. **Do declarative agents need a sandbox at all?** They execute no custom code, so the
   heaviest part of B6 (container isolation for arbitrary agent code) applies only to code
   agents. That may be the strongest argument in this document.
5. **Does a `personal` agent get a per-user KB?** The base KB is shared by construction. But
   "my own documents this agent should always know" is the natural request after a week of
   use — hence `instance` on `agent_kb_chunk` (§7). Needs a UI and a budget rule.
6. **Manifest versioning.** `schema_version` is in the manifest; with six agents, fail-and-fix
   on a schema change is safer than auto-migration. That flips somewhere around fifty.

Question 4 is worth answering early — if declarative agents don't need container isolation,
the sandboxing roadmap shrinks to the two code agents plus the mutation sandbox.

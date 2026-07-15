# Agent File & Memory Framework (the durable-state contract every MAF agent MUST follow)

**Status:** Part 1 (native-MAF mutation → monorepo PR) and Part 2 (files/memory →
Postgres blob store) built 2026-07-15. This doc is the canonical contract for how
agent code, files, and memory persist — and the required reading before we build
the in-platform **agent-building workbench** or any new MAF agent (here or on Pomad
Centre).

**Companions:** `agents-workspaces-artifacts.md` (workspace layout), `llm_caching_memory.md`
(Mem0 scopes), `system_architecture.md` (ADRs), and the dev-only limitation note at
`docs/DESIGN_LIMITATION_native_maf_mutation.md`.

---

## 1. The two axes of agent durability

Every agent has two fundamentally different kinds of persistent state. They are
stored by two different mechanisms, and conflating them is the mistake this
framework exists to prevent.

| Axis | What it is | Store | Reviewed? | Survives |
|------|-----------|-------|-----------|----------|
| **Code** | What the agent *is* — `agents.py`, `config.json`, `instructions.md`, skills | **Git** (monorepo PR for native MAF; own repo for GitHub agents) | Yes — human PR approval | Everything (it's source) |
| **State** | What the agent *accumulates* — files, memory, artifacts | **Postgres blob store** (authoritative) + disk cache | No — it's runtime data | Volume wipe, redeploy, box migration |

> **Rule:** Code goes to git, human-reviewed. State goes to the blob store,
> untracked. Never put accumulated state in git; never put code in the blob store.

---

## 2. The three folders (the agent's filesystem contract)

Every MAF agent workspace exposes exactly three folders in the file manager. Their
roles are distinct and load-bearing — treat them as a contract, not a convention.

### `agent-data/` — durable knowledge (an extension of the system prompt)
The agent's memory file (`NOTES.md`) plus any accumulated reference data. **Think
of this as prompt that grows over time**: files here shape the agent's behaviour on
every future run. This is where "the agent gets smarter" lives.
- Written by: `save_note` / `save_agent_memory` (memory), the agent's own tools.
- Persistence: blob store, authoritative. Survives everything.

### `inputs/` — user uploads (promotable to permanent)
Files a user uploads for the agent to work with. Ephemeral by default, but can be
**promoted to `agent-data/`** to become permanent, behaviour-shaping knowledge
(`POST /agent/workspace/{session}/promote`, or right-click → "Promote to Agent
Data" in the file manager).
- Written by: the upload endpoints.
- Persistence: blob store (so an upload survives a wipe too).

### `outputs/` — everything the agent generates
All files, folders, and projects the agent produces — reports, documents, HTML,
data, code. This is what the user views as *results*.
- Written by: `write_artifact` / `share_artifact`, the agent's own tools.
- Persistence: blob store, authoritative.

Everything **outside** these three folders (agent source, `.git`, caches) is NOT
stored as state — it comes from the agent's git repo, not from accumulated runtime.

---

## 3. How it works (the mechanism built in Part 2)

**Backing store (authoritative), disk (cache).** Same model as Mem0: Postgres is
the source of truth; the on-disk workspace at `{agents_clone_dir}/repos/{agent}` is
a rehydratable cache.

- **Tables** (`infra/postgres/71_agent_blob_store.sql`):
  - `agent_blob` — current content of every live file, keyed `(agent_name, path)`.
  - `agent_file_history` — **append-only log of every unique version** (by sha256)
    an agent created or modified over time. This is the "track every unique file"
    requirement: each row is a directly-retrievable version, with action
    (`create`/`modify`/`delete`/`promote`), actor, run/session provenance.
- **Store module:** `acb_memory/blob_store.py` — `put_file / get_file / list_files
  / delete_file / file_history / rehydrate_workspace`. Keyed by `agent_name` only
  (the sole tenant key → portable to Pomad Centre unchanged). Graceful: DB down →
  no-op, agents keep working off disk.
- **Write-through** at every write path (disk write + store mirror + history row):
  - Agent-side: `write_artifact` and `save_note` → `mirror_to_blob_store(...)`.
  - Gateway: PUT save, upload, delete, and the artifacts equivalents →
    `_mirror_gateway_write` / `_mirror_gateway_delete`.
- **Rehydrate on load:** the executor calls `rehydrate_workspace(agent, root)`
  before every run, so a wiped/migrated volume comes back from the store.
- **Fault-in on read:** the gateway file-read endpoints restore a missing file from
  the store on demand (`_faultin_from_store`), so the file manager / chat /
  artifacts apps keep working even before the agent re-runs.
- **Read paths unchanged:** the file manager, chat, and artifacts apps still read
  the disk workspace via the existing endpoints — the store sits *behind* them.

---

## 4. Agent roster — who must follow this framework

**Every MAF agent, existing and future, MUST use the three-folder + blob-store +
git-code contract above.** The universal tool injection already gives all agents
the write/memory tools; the persistence is automatic once an agent writes into the
three folders. No agent is exempt.

### Currently built (registry `agent_registry.json` + in-repo)
| Agent | Runtime | Purpose | Framework status |
|-------|---------|---------|------------------|
| `task-manager` | MAF | GTD / ClickUp tasks, workload Q&A | in-repo; must follow |
| `sales` | MAF | Zoho CRM pipeline + deal follow-ups | must follow |
| `delivery` | MAF | Project delivery monitoring + notifications | must follow |
| `triage` | MAF | Email / WhatsApp / meeting triage + routing | must follow |
| `reconciler` | MAF | Nightly source-of-truth diff + escalation | must follow |
| `billing` | MAF | Billing & invoice workflows | must follow |
| `strategy` | MAF | Weekly digest + planning synthesis | must follow |
| `email-assistant` | MAF | Inbox triage + drafting (in-repo, `apps/agents/`) | must follow |
| `orchestrator` | MAF/Copilot | Router / general brain | must follow |

### Reference implementation (the pattern to copy)
`agent-startup-guru` (GitHub-sourced MAF agent) — a self-contained memory bank
under `outputs/_memory/` + `agent-data/` managed by a `memory-management` skill
(JSON/MD working memory + SQLite FTS long-term). This is the model for what a rich
`agent-data/` looks like.

### Upcoming / to-be-built MAF agents
Any new specialist agent (whether authored in VS Code today or in the in-platform
workbench later) inherits this contract by construction. When we add a new agent we
MUST confirm: (a) it writes deliverables to `outputs/`, working knowledge to
`agent-data/`, treats `inputs/` as promotable; (b) it uses the memory tools for
durable facts; (c) its code mutation flows to git (PR), never the blob store.

> **ACTION for new-agent work:** add a line to the agent's `instructions.md` /
> checklist confirming it follows this framework, and verify the three folders +
> memory tools are exercised in its golden eval.

### Retrofit note (existing agents)
The mechanism is automatic (write-through fires wherever an agent writes into the
three folders), so existing agents get durability for free. What to VERIFY per
existing agent during hardening: they are actually writing into the three folders
(not the working-dir root), and that anything they rely on across sessions lives in
`agent-data/` (not a scratch file that isn't backed).

---

## 5. Building the in-platform agent-building workbench — what to consider

When we build the workbench that authors MAF agents *inside* the platform (rather
than VS Code + Git), it MUST preserve every invariant here. Considerations:

1. **Code is still git-backed and human-reviewed.** The workbench authors an
   agent's `agents.py` / `config.json` / skills, but those are *code* — they land
   via a reviewed PR (see the mutation flow), not the blob store, not a live edit
   to production. The "No in-app agent/skill editing of production" constraint
   (AGENTS.md Global Constraints #1) still holds; the workbench produces a
   reviewable change, it doesn't hot-patch a running agent.
2. **State is blob-store-backed from day one.** A workbench-authored agent gets the
   same three folders + write-through + rehydrate automatically — because that's
   keyed on `agent_name`, not on how the agent was authored.
3. **The three-folder contract is enforced, not optional.** The workbench should
   scaffold `agent-data/ inputs/ outputs/` and steer generated tool calls to write
   there. A generated agent that writes to the working-dir root is a bug.
4. **`agent_name` is the tenant key.** Everything (blob store, memory scopes,
   mutation target) hangs off `agent_name`. The workbench must allocate a unique,
   stable `agent_name` per agent and never reuse one.
5. **Memory scopes carry over.** Workbench agents get the same three memory scopes
   (user / agent-cross-user / org-global — see `llm_caching_memory.md`). Decide at
   author time what belongs in `agent-data/` (prompt-extending files) vs. Mem0
   (semantic recall).
6. **⚠️ Mutation remote is the open production question.** The current native-MAF →
   *monorepo* PR path is DEV-ONLY (see §6). Before the workbench ships to
   multi-tenant / customer use, the mutation target MUST become tenant-isolated —
   this is the single biggest unresolved design decision for the workbench.

---

## 6. Pomad Centre portability + the production mutation gap

**Portability:** the blob store, three-folder contract, and memory scopes are all
keyed on `agent_name` with no CommandCenter-specific coupling, so MAF agents built
on the **Pomad Centre** platform use the identical mechanism. When we stand up
agents there, they must adopt this framework verbatim — same tables, same tools,
same folders. Do not fork the storage model per platform.

**The one thing that does NOT port as-is — code mutation:** today a native MAF
agent's approved self-mutation opens a PR against the **shared CommandCenter
monorepo**. That is fine only while all agents are first-party and Command Center is
WIP. For Pomad Centre / multi-tenant / customer agents this is unacceptable — third
parties must never push to the shared monorepo. This must be replaced (per-tenant
repo, or a tenant-scoped store the loader reads at runtime) before production. Full
detail: `docs/DESIGN_LIMITATION_native_maf_mutation.md`.

---

## 7. Checklist for anyone touching this

- [ ] New agent writes deliverables → `outputs/`, knowledge → `agent-data/`, treats
      `inputs/` as promotable. Never the working-dir root.
- [ ] Durable cross-session facts use the memory tools (`save_agent_memory` /
      `save_note`), which land in `agent-data/` and/or Mem0.
- [ ] Code changes flow to git via a reviewed PR — never the blob store.
- [ ] `agent_name` is unique and stable (it's the storage + memory + mutation key).
- [ ] For workbench / Pomad Centre work: the mutation target is tenant-isolated
      (NOT the shared monorepo) before any multi-tenant deployment.

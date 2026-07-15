# Agent Persistence — Implementation Reference (how it's built, so you can change it)

**Status:** built 2026-07-15 (Part 2). Live once PR #60 merges to `main` (migrations
70 + 71 auto-apply on deploy). This is the **engineering companion** to
`agent_file_and_memory_framework.md` — that doc is the *contract* (what agents must
do); this doc is the *implementation* (every function, table, and seam), so we can
tweak or replace pieces later without re-reading the whole codebase.

If you only want the rules, read the framework spec. If you're about to **change how
persistence works**, read this.

---

## 0. One-paragraph model

An agent's files under the three folders (`agent-data/`, `inputs/`, `outputs/`) are
stored in Postgres (the **source of truth**) with the on-disk workspace as a
**disposable cache** — the same shape as Mem0. Writes go through to Postgres +
append a version-history row (**write-through**). On agent load the workspace is
**rehydrated** from Postgres. A read that misses on disk is **faulted-in** from
Postgres. Everything is keyed on `agent_name` alone, so it ports to any platform
(Pomad Centre) unchanged. If Postgres is unavailable, every store call is a no-op
and agents keep working off the disk cache.

```
            write_artifact / save_note / gateway PUT·upload·delete·promote
                                   │  (write-through)
        disk workspace  ◀────────►│────────►  agent_blob  (current content)
   {clone_dir}/repos/{agent}      │           agent_file_history  (every version)
         ▲        ▲               │
         │        └── fault-in on read miss (gateway) ──┘
         └────────── rehydrate on agent load (executor) ┘
```

---

## 1. Schema — `infra/postgres/71_agent_blob_store.sql`

Two tables. **Migration is idempotent** (`CREATE TABLE IF NOT EXISTS`), applied by
`apply_migrations.sh` on deploy.

### `agent_blob` — current content, one row per live file
| Column | Type | Notes |
|--------|------|-------|
| `agent_name` | TEXT | tenant key (PK part 1) |
| `path` | TEXT | workspace-relative POSIX path (PK part 2), e.g. `outputs/reports/q3.html` |
| `folder` | TEXT | `agent-data` \| `inputs` \| `outputs` (CHECK-constrained; derived from path's first segment) |
| `content` | BYTEA | the bytes |
| `sha256` | TEXT | content hash (dedup + rehydrate skip) |
| `size` | BIGINT | |
| `mime_type` | TEXT | |
| `updated_at` / `created_at` | TIMESTAMPTZ | |

PK `(agent_name, path)`. Index `(agent_name, folder, updated_at DESC)`.

### `agent_file_history` — append-only, every unique version
Same content columns **plus**: `action` (`create`/`modify`/`delete`/`promote`),
`run_id`, `session_id`, `actor` (`agent`/`user`/`system`), `created_at`.

- **Dedup**: `UNIQUE (agent_name, path, sha256, action)` — a same-content rewrite
  does NOT create a new row (`ON CONFLICT DO NOTHING`). A genuine content change
  (new sha) does.
- **Deletes** carry a sentinel sha (`"0"*64`, `_DELETE_SHA`) so a delete row never
  dedup-collides with a prior content version at the same path.

> **To change what's tracked** (e.g. add a `tags` column, or store deltas instead of
> full content): edit this migration as a NEW migration file (`72_*.sql`), never
> mutate 71 in place — deployed DBs already ran 71.

---

## 2. Store module — `packages/acb_memory/acb_memory/blob_store.py`

The whole store is ~355 lines, one file. Public async API (exported from
`acb_memory/__init__.py`), sync core wrapped in `asyncio.to_thread` (matches
`mem0_client`). **Every function is graceful** — DB error → no-op / empty, never
raises to the caller.

| Function | Signature | What it does |
|----------|-----------|--------------|
| `put_file` | `(agent, path, data, *, mime_type, action, run_id, session_id, actor) -> BlobMeta \| None` | Upsert current content + append history row. No-op for non-stored paths or empty agent. |
| `get_file` | `(agent, path) -> bytes \| None` | Fetch current content. |
| `list_files` | `(agent, prefix=None) -> list[BlobMeta]` | All live files (optionally under a prefix). |
| `delete_file` | `(agent, path, *, run_id, session_id, actor)` | Drop live blob + append a `delete` history row. |
| `file_history` | `(agent, path=None, limit=200) -> list[dict]` | Version log, newest first (all files or one path). |
| `rehydrate_workspace` | `(agent, workspace_root) -> int` | Restore all stored files to disk; returns count restored. |

**Helpers (pure, no DB):** `folder_of(path)` → the folder or `None`;
`is_stored_path(path)` → bool; `STORE_FOLDERS = ("agent-data","inputs","outputs")`.
These are the gate — **only paths under the three folders are stored.** Everything
else (agent source, `.git`, caches) is ignored by design.

**Key invariants (don't break these):**
- `rehydrate_workspace` is **store-authoritative but non-destructive**: it writes a
  stored file to disk if missing OR if the disk sha differs; it **leaves
  disk-only files alone** (they get captured on their next write-through). So it
  restores state without clobbering an in-progress local edit that hasn't been
  written through yet.
- History dedup is by `(agent, path, sha, action)`. If you add an `action` value,
  make sure the dedup semantics still make sense for it.

---

## 3. Write-through seams (where content enters the store)

Two write surfaces mirror into the store. **If you add a new way for an agent to
write a file, you must add a mirror call there too** — otherwise that file lives
only on the disk cache and won't survive a wipe.

### Agent-side (the agent's own tools)
- `packages/acb_skills/acb_skills/write_artifact.py`
  - `mirror_to_blob_store(rel_path, data, *, mime_type, action, actor)` — called
    right after the on-disk `write_bytes`. Resolves `agent_name` via
    `_current_agent_name()` (reads `_WRITE_ARTIFACT_CONTEXT["agent_name"]`, falling
    back to the workspace-root basename).
  - `write_artifact` / `share_artifact` → mirror on every write.
- `packages/acb_skills/acb_skills/note_tools.py`
  - `save_note` emits no artifact event, so it calls `mirror_to_blob_store` directly
    (agent-data memory writes land in the store).

### Gateway-side (edits made through the apps)
- `apps/services/gateway/gateway/routes/workspace.py`
  - `_mirror_gateway_write(workspace, rel_path, data, *, action, session_id)` and
    `_mirror_gateway_delete(...)` — the gateway equivalents.
  - Wired into: `PUT /workspace/{sid}/file` (save), `POST .../upload`,
    `POST /artifacts/upload`, `DELETE .../file`, `PUT /artifacts/file`, and the
    **promote** endpoint. ~10 call sites.

### The agent_name seam (most likely thing a future change touches)
`agent_name` reaches the write path through `_WRITE_ARTIFACT_CONTEXT` (a module dict
in `write_artifact.py`), set by the **executor**
(`apps/services/orchestrator/orchestrator/executor.py`) at both run-sites and the
sub-agent site (it saves/restores the dict around sub-agent calls). If you change how
agents are identified, this is the seam to update.

---

## 4. Read + restore seams

- **Rehydrate on load** — `executor.py` calls
  `await rehydrate_workspace(agent_name, agent_dir)` before a run at both run-sites
  (native-MAF and the loaded-agent path). This is what makes a redeploy / wiped
  volume transparent.
- **Fault-in on read** — `workspace.py` `_faultin_from_store(workspace, rel_path)`
  is called by `GET /workspace/{sid}/file` and `GET /artifacts/file` when the file
  is missing on disk, so the file manager / chat / artifacts apps see the file even
  before the agent re-runs.
- **Read paths are otherwise unchanged** — the apps still read the disk workspace.
  The store sits *behind* the existing endpoints; no app code had to change to read
  from it. **Keep it that way** — the store is an implementation detail of the
  workspace, not a new API the frontends call directly (except history/promote).

---

## 5. New endpoints added for this system

- `POST /workspace/{session_id}/promote` — move an `inputs/` file to `agent-data/`
  (records a `promote` history row on the dest + a delete on the source). Frontend:
  right-click → "Promote to Agent Data". Only `inputs/` paths are promotable.
- `GET /workspace/{session_id}/history` — version history of an agent's tracked
  files (backs the version-history modal in `ArtifactSidebar`). Proxied by
  `src/app/api/agent/workspace/[sessionId]/history/route.ts` and `.../promote/route.ts`.

---

## 6. Configuration & operational notes

- **Workspace root**: `{agents_clone_dir}/repos/{agent_name}`, default
  `~/.acb/agents` (survives reboot; legacy `/tmp` clones were wiped on reboot). See
  `agents-workspaces-artifacts.md`.
- **DB connection**: standard `settings.database_url` via `acb_graph.get_session`
  (each sync helper opens its own session). No new connection config.
- **Graceful degradation is load-bearing**: if Postgres is down, `put/get/list/
  delete/rehydrate` all no-op/return-empty and log at warn/debug. Agents keep
  working off disk; they just aren't durable until the DB is back. Don't add a code
  path that makes a store failure fatal to an agent run.
- **Backup implication**: agent state now lives in Postgres. The DB backup is now
  also the agent-file backup — worth noting in any backup/restore runbook.

---

## 7. How to test a change (proven harness)

`tests/unit/test_blob_store_durability.py` is the reference test. Two layers:
- **No-DB tests** (always run): path classification + "public API never raises for
  bad input" (the write-through relies on this).
- **Live round-trip tests** (skip when no DB with migration 71 is reachable — CI
  safe): put→get, **put → wipe disk → rehydrate → byte-for-byte restore**, idempotent
  rehydrate, history dedup, delete-keeps-history, prefix listing. They scope to a
  throwaway `agent_name` and purge before+after, so they leave no residue.

**Running the live tests** (they skip locally without a DB): point `DATABASE_URL` at
a Postgres that has migration 71 applied and run the file. This was verified 15/15
against the live VPS Postgres in an isolated throwaway database (never the prod DB).

> When you change the store, extend THIS file. The wipe→rehydrate test is the
> canary — if durability breaks, it goes red.

---

## 8. Extension points / likely future changes (and where they land)

| You want to… | Change here |
|--------------|-------------|
| Track a new attribute per version | new migration `72_*.sql` + `_sync_put`/`BlobMeta` |
| Store deltas / compress large blobs | `_sync_put`/`_sync_get` (transparent to callers) |
| Cap history / add retention | a pruning job over `agent_file_history` (nothing else assumes unbounded history) |
| Add a new agent write surface | add a `mirror_to_blob_store` / `_mirror_gateway_write` call at that write |
| Change the tenant key (not just `agent_name`) | the `_WRITE_ARTIFACT_CONTEXT` seam (§3) + every `agent_name` param — this is the big one |
| Make the mutation target tenant-isolated (prod) | NOT this system — see `docs/DESIGN_LIMITATION_native_maf_mutation.md` (the open production question) |
| Move to a different backing store (S3/object store) | swap the `_sync_*` bodies in `blob_store.py`; the async API + all seams stay the same |

The last row is the point of the whole design: **the six-function async API is the
seam.** Callers (agent tools, gateway, executor) only know `put_file` /
`rehydrate_workspace` etc. — swap what's behind them and nothing upstream changes.

---

## 9. Related docs

- `agent_file_and_memory_framework.md` — the contract every agent follows (read first).
- `agents-workspaces-artifacts.md` — workspace layout, clone dir, artifacts model.
- `llm_caching_memory.md` — Mem0 memory scopes (user / agent-cross-user / org).
- `docs/DESIGN_LIMITATION_native_maf_mutation.md` — the DEV-ONLY code-mutation path
  and the open production (tenant-isolation) question.
- `system_architecture.md` — where this sits in the ADRs.

# Spec: Artifact Viewer — Agent File Browser + Document Viewer

> **Status:** Planning · **Target:** ~M3 · **Owner:** frontend
> **Motivation:** Agents that write files (sales docs, PDFs, Markdown reports, skill scripts, mutation patches) produce artefacts the operator can't inspect without SSH. This adds a collapsible file-tree sidebar + inline document viewer inside the existing chat layout.

---

## Design overview

```
┌─────────────┬──────────────────────────────────┬────────────────────┐
│ Nav Sidebar │          Chat Panel               │  Artifact Sidebar  │
│ (collapsible)│  (AgentChat.tsx + messages)       │  (collapsible, ◀▶) │
│             │                                   │  📁 /workspace     │
│             │   [Document Viewer Modal]         │   ├─ report.md     │
│             │   renders file content            │   ├─ deal.pdf      │
│             │                                   │   └─ skill.py      │
└─────────────┴──────────────────────────────────┴────────────────────┘
```

**Rendering matrix:**

| File type | Renderer |
|---|---|
| `.md` | `react-markdown` + `remark-gfm` (in stack) |
| `.py` `.ts` `.js` `.sh` `.yaml` `.json` `.toml` `.sql` | `shiki` (github-dark) |
| `.pdf` | `react-pdf` (`pdfjs-dist`) |
| `.png` `.jpg` `.jpeg` `.gif` `.webp` `.svg` | `<img>` with zoom |
| `.csv` | table (100-row cap, load-more) |
| `.txt` `.log` | pre-wrapped text |
| other / binary | hex-dump excerpt + Download |

---

## Subtasks

**ST-AV-01 · Gateway: agent workspace API (backend, 1d)** — `GET /agent/workspace/{session_id}` → JSON file tree; `GET …/file?path=` → raw bytes (streamed, 50 MB cap). Workspace root resolved from the loader's clone cache; empty tree if none. Add `workspace_path` to `chat_sessions`. Path-traversal prevention; no symlink escape; rate-limit 10 req/s/session.

**ST-AV-02 · Gateway: push file-tree updates as SSE (backend, 1d)** — emit AG-UI `CUSTOM` `artifact_created`/`artifact_updated` `{path,size,mime_type}` whenever an agent calls `write_artifact`. `/api/agent/chat` already forwards `CUSTOM`; `useAgentChat.ts` appends to an `artifacts` list.

**ST-AV-03 · Frontend: Next.js workspace proxy (frontend, 0.5d)** — proxy `GET /api/agent/workspace/[sessionId]` and `…/file` to the gateway (same pattern as existing message routes); bytes proxied so the gateway URL never leaks.

**ST-AV-04 · Frontend: `ArtifactSidebar` (frontend, 1.5d)** — collapsible right sidebar mirroring the left session sidebar (`w-72`/`w-10`). Toggle chevron; `artifactPanelOpen` default false, auto-expands on first artifact. Tree via shadcn `Collapsible`; lucide icons by extension; double-click opens viewer; right-click Open/Download; empty state.

**ST-AV-05 · Frontend: `ArtifactViewerModal` (frontend, 2d)** — shadcn `Dialog` (full-screen mobile, `max-w-4xl` desktop). Header: filename + breadcrumb + Download. Body renders by MIME per the matrix above. Lazy fetch on open; `Skeleton` loading; `Sonner` toast on error.

**ST-AV-06 · Frontend: wire artifacts into `AgentChat` + `useAgentChat` (frontend, 0.5d)** — add `artifacts`/`onArtifact` to the hook; on `CUSTOM` `artifact_*` append/merge; lift open-modal state in `ChatPageInner`; auto-expand sidebar on first artifact.

**ST-AV-07 · Frontend: install shadcn components (setup, 0.5d)** — `dialog`, `collapsible`, `dropdown-menu`, `scroll-area`, `skeleton`, `sonner`; npm `shiki`, `react-pdf`, `pdfjs-dist`.

**ST-AV-08 · Agent: `write_artifact` tool in acb_skills (backend, 1d)** — `write_artifact(path, content, *, encoding="utf-8") -> {path,size,sha256}`; writes under `session_workspace_root/path`; emits the `CUSTOM` event when an emitter is in context; wire into `_inject_agent_tools`; unit test.

**ST-AV-09 · Postgres: `workspace_path` column on `chat_sessions` (backend, 0.5d)** — migration `05_workspace_path.sql`; gateway sets it on first `write_artifact`.

### Sequencing
```
ST-AV-07 ─▶ ST-AV-04 ─▶ ST-AV-05 ─▶ ST-AV-06
ST-AV-09 ─▶ ST-AV-01 ─▶ ST-AV-03 ─▶ ST-AV-04
ST-AV-02 ─▶ ST-AV-08 ─▶ ST-AV-06
```
**MVP slice (ships independently):** ST-AV-09 → 01 → 03 → 07 → 04 → 05 (browse + view files on disk, no live push). ST-AV-02 + 08 add real-time auto-discovery.

**Total:** ~8 days (1 engineer) across ~2 sprints.

### Open questions
1. Workspace lifetime — tie to session TTL or always-retain? (disk usage).
2. Per-session total size cap (e.g. 500 MB) in addition to 50 MB/file?
3. Per-session-owner access scoping if multiple operators share the Control Plane.
4. `pdfjs-dist` worker served from `/public` — confirm during ST-AV-07.

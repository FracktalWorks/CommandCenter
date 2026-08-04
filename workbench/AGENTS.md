# Workbench

## Purpose
Control Plane (Next.js browser UI) and local development tools.

## Structure
- control_plane/ -- Next.js app (chat, email, agents, integrations, settings)
- control_plane/src/app/email/ -- Email AI Assistant: 4-panel email client (accounts sidebar, email list, email detail, AI chat) with multi-account Gmail/Microsoft support
- control_plane/src/app/email/components/ContactCard.tsx -- People card (Outlook parity). `ContactTrigger` wraps any avatar/name/recipient to open it; `RecipientList` renders a clickable To:/Cc: line; every field carries a `CopyButton`. Backed by GET /email/contacts/card, which also files what it learns into the server-side contacts directory — pass the display name you already have so recipients you only ever write TO are filed under a name, not a bare address. The trigger renders a real <button> and stops propagation, so a row that contains one must be a div (see ConversationView's message header), never a <button>
- control_plane/src/components/AppShell.tsx -- Responsive shell: desktop Sidebar vs mobile top bar + unified slide-in drawer via useMobileDrawer() context
- control_plane/src/components/ViewModeProvider.tsx -- Mobile/desktop view decision + "Request desktop" toggle (persisted)
- control_plane/src/lib/nav.ts -- Shared primary navigation config (used by Sidebar + mobile drawer). Each pane carries a `feature` slug; `visibleSections(allowedFeatures)` drops panes the member cannot reach and any section left empty. Passing `null` (access not yet resolved) returns everything, so the nav does not visibly shrink on first paint
- control_plane/src/app/page.tsx -- Home grid. **Known issue (2026-08-03, deliberately unfixed):** it renders `NAV_SECTIONS` directly (`:11-12`) with **no** access filter, so every pane — Centers included — is advertised to every viewer, including signed-out ones, while the sidebar correctly hides them via `visibleSections()`. Whoever fixes it must decide what the grid shows while access is still resolving (`useAccess()` returns null on first paint, and nav's convention is "show everything" so the UI does not visibly shrink — the wrong default for a landing page)
- control_plane/src/lib/centers.ts -- THE Departmental Center registry: `nav.ts` builds the Centers nav section from it and `access.ts` builds the `/centers/<slug>` → `center.<slug>` route map from it. Editing this file alone does NOT add a Center — a slug here whose feature is absent from `acb_auth.permissions.FEATURES` is dropped from the nav and 403s at AccessGate for every principal, owner included (that was the live defect of 2026-08-03). `tests/unit/test_org_access_control.py::test_centers_registry_matches_the_feature_vocabulary` parses this file and pins it both ways to `FEATURES`; the full five-place registration checklist is `ai-company-brain/specs/department_centers.md` §2
- control_plane/src/lib/access.ts -- Org access control client helpers: the `Access` shape, href→feature mapping, and `canSeePath`. It deliberately does NOT re-implement wildcard matching — the gateway returns resolved outcomes and this is a lookup. Nothing here is a security boundary
- control_plane/src/lib/gateway.ts -- THE shared gateway proxy helper (`gatewayHeaders`, `proxyToGateway`). Header building was copy-pasted into ~50 route files, each with its own EXECUTIVE_EMAILS parsing; new routes use this one, and the existing copies are being migrated onto it
- control_plane/src/app/api/email/oauth/[provider]/authorize/route.ts -- The mailbox-connect navigation target. **Nothing in the browser may navigate to a gated gateway route directly**: a top-level navigation carries no Bearer and no `X-User-Email` (the session cookie is on this origin, not `api.*`), so it 401s — which is exactly why nobody could connect an email account between 2026-07-29 and 2026-08-04. This route has the session, calls the gated `/email/oauth/{provider}/authorize` with `gatewayHeaders()` and `redirect: "manual"`, and re-issues the upstream `Location` so the provider's consent screen is reached by the browser with the provider's own cookies. It forwards `redirect_after` and deliberately drops `user_email` — identity is the session's. It is a more-specific sibling of the `api/email/[...path]` catch-all and must stay one: the catch-all fetches with the default `redirect: "follow"` and would return the provider's login HTML through the proxy. Pinned by `tests/unit/test_email_oauth_authorize_wiring.py`; failures redirect to `/email/oauth/callback?error=…`, the same page the gateway's own callback errors land on
- control_plane/src/components/AccessProvider.tsx -- Fetches /api/auth/me once and shares the member's effective access (`useAccess()`); mounted inside SessionProvider, re-resolves every 2 min
- control_plane/src/components/AccessGate.tsx -- Blocks direct navigation to a route the member cannot reach. Presentation only: the gateway re-authorizes every request
- control_plane/src/app/settings/members/ -- Org admin: roster, invite, suspend, role assignment, and the per-member access editor (feature/agent/capability rows with an Inherit·Allow·Deny control and the provenance of every decision). Two tabs: **Members** and **Requests** (colleague_onboarding.md §6 / N6a) — the queue of people who signed in and found no account, badged only when something is pending. Approve provisions AND activates in one action; the roster's `invited` rows are labelled **"invited — never signed in"** (`STATUS_LABELS`) rather than rendered as though they were live, because `is_active` is `status === "active"` exactly and an invited colleague sees the identical dead-end screen as a stranger — that ambiguity was the 2026-08-04 incident. ⚠️ **Two rules for this tab, both about not rendering a lie as calm.** (1) A failed `/members/requests` fetch is NEVER swallowed into `[]` — `queueError` is kept apart from `error` so the roster stays up while a non-dismissible warning says the queue is unavailable, and the empty-state copy ("Nobody is waiting.") is reachable only when the queue actually answered; the fallback-to-empty version rendered a deployment with an unapplied migration 143 as "nobody is locked out", which is the exact silence the tab exists to end. (2) A request whose address is outside the company domain renders an `is_external` marker — the gateway resolves the flag (the domain is server policy; the browser must never re-derive it) because approve provisions `active` immediately and an Entra directory guest would otherwise be indistinguishable from a colleague. (3) **`decide()` has NO early return, and a 200 can still carry news.** The gateway's approve matrix means a decision is refused (409) whenever the address is already a suspended or off-boarded member, or the row was decided by another admin — and a refusal is *about the row that was clicked*, so `load()` runs on every response, not just the successful ones, or the tab keeps rendering a state the server has already corrected. Approving over someone who is already an active member deliberately leaves their roles alone and returns a `detail`; that is rendered as a dismissible `notice` (distinct from `error`, since nothing went wrong), because a 200 that ignored the role picker must not look identical to one that honoured it. (4) **The roster knows who is reading it** (`colleague_onboarding.md` §2 Step 5 / N7): the page reads `access.email` from `useAccess()` and `./selfGuard.ts` — `isSelf` / `rowActions`, the ONE place that decides what a row may offer — renders **This is you** where Suspend and Remove would be. It used to draw Suspend on the viewer's own row like any other, which is the single click that takes an owner out of the surface they would need to undo it. `Remove` (the shipped `DELETE` route, which had no caller in the product at all) goes through `RemoveDialog`, which names the person and says the role grants are dropped — it is not the loud version of Suspend, and the way back is a fresh invite plus an activation. ⚠️ `selfGuard.ts` is presentation only: `_common.assert_not_self_lockout` in the gateway is the boundary, and `removeMember` surfaces its `detail` and re-reads the roster on EVERY response, refusals included. Unit-tested by `selfGuard.test.ts` (vitest); the page's wiring is fenced from `tests/unit/test_admin_member_offboarding.py`
- control_plane/src/app/settings/roles/ -- Role definitions. System roles are read-only; the copy steers toward per-user overrides, because the failure mode of any role system is one role per employee. The permission chips are grouped by `feature_catalog.category` (Apps · Build · Centers · Configure, in the order the gateway returns them); an unknown category falls back to its raw slug rather than vanishing from the dialog
- control_plane/src/proxy.ts -- Route protection via NextAuth (Next 16: the former middleware.ts, exporting `proxy()`)
- control_plane/src/auth.ts -- NextAuth v5 config (Microsoft Entra ID SSO, JWT callbacks; auth is disabled when AUTH_MICROSOFT_ENTRA_ID_ID is unset)
- control_plane/src/app/workflows/ -- Workflows app (spec: ai-company-brain/specs/workflows_app.md): gallery + Module Studio tab (`page.tsx`), visual editor at `[id]/page.tsx` — React Flow (`@xyflow/react`) canvas with the three-pane layout (left pane tabs Palette | Copilot · canvas · inspector) + run console, node categories color-coded per the RFC (amber/violet/teal/sky/slate/emerald), Test ▸ streams per-node status onto the canvas over SSE. The palette leads with search (`/api/workflows/catalog/search`, debounced; keyword-ranked until BO‑22's platform semantic-search service lands) and rolls tools up under their integration; `CopilotPanel.tsx` is chat-to-build — applies returned graphs to the canvas with one-click undo, surfaces auto-created-module chips, refreshes the catalog when the copilot creates modules. `lib/api.ts` is the typed client (notes/lib/api.ts shape); proxies live at `src/app/api/workflows/[[...path]]/route.ts` (uses lib/gateway helpers) + a dedicated SSE relay at `api/workflows/runs/[runId]/stream/route.ts` (the catch-all buffers bodies and cannot stream)
- control_plane/src/app/api/agent/chat/route.ts -- UNIFIED AG-UI to frontend SSE translation. ALL agents (orchestrator, task-manager, cc-dev, any named/dynamic) go through the same /agent/run/stream gateway endpoint. No more isOrchestrator branching — one code path for all.
- control_plane/src/components/AgentChat.tsx -- Main chat component
- control_plane/src/components/MarkdownMessage.tsx -- GFM rendering with inline images
- control_plane/src/components/ArtifactCard.tsx -- Inline file cards (images, MD, PDF, etc.)
- control_plane/src/components/ArtifactSidebar.tsx -- Collapsible workspace file tree (supports fullWidth drawer mode on mobile)
- control_plane/src/components/ArtifactViewerModal.tsx -- Full-fidelity file viewer modal

## Conventions
- Next.js App Router pattern
- SSE streaming for real-time chat
- AG-UI protocol translation in route.ts
- Microsoft Entra ID SSO (NextAuth v5) restricted to org domain
- Route protection via proxy.ts (auth-gated when Entra ID credentials are set)
- Identity chain: NextAuth session → X-User-Email / X-User-Role headers → gateway UserContext
- Role resolution: DB-backed org roles + per-user overrides, resolved server-side per request by the gateway (spec: ai-company-brain/specs/org_access_control.md). EXECUTIVE_EMAILS remains only as the bootstrap path for a deployment whose access tables have not been migrated yet. Permissions are deliberately NOT put in the NextAuth JWT — a JWT outlives an access change, and access revoked an hour ago must not still work
- All API routes that proxy to gateway forward user identity headers alongside Bearer token
- Agent-generated files (artefacts) are proxied via /api/agent/workspace/{sessionId}/file?path=
- Image URLs in markdown are rewritten through the workspace file proxy automatically
- Agents SHOULD write generated files to .tmp/ or outputs/ for discoverability
- **Design System**: ALL UI must follow `control_plane/DESIGN_SYSTEM.md`. Use shared
  components from `src/components/` (Tabs, FilterPills, etc.) — never inline ad-hoc
  tab bars, filter pills, or page headers. Use semantic color tokens from
  `globals.css` — never arbitrary hex values.

## Thinking timeline (VS Code parity)
- ThinkingContainer.tsx renders reasoning text and tool calls as ONE
  chronologically interleaved timeline (narration bullet → tool row → ...),
  mirroring VS Code Copilot Chat's thinking pane.
- Ordering comes from ToolEvent.reasoningCutoff (count of reasoning blocks
  when the tool started) — stamped by foldForToolStart() in useAgentChat.ts
  and mirrored in route.ts at TOOL_CALL_START. It persists inside the
  existing tool_events JSONB; no schema change. Legacy events without a
  cutoff sort after all reasoning (old behaviour).
- At each tool start the current reasoning block is "sealed" with an empty
  sentinel block so later reasoning renders AFTER the tool. Sentinels are
  skipped at render time; restore paths split reasoning on "\n---\n"
  WITHOUT filter(Boolean) to keep block indices aligned with cutoffs.
- Tool rows are compact one-liners ("Ran <cmd>", "Read <file>", "Searched
  <q>") that expand on click; run-kind tools expand to the terminal card.
  Running tools auto-expand and show live output streamed via
  TOOL_CALL_PARTIAL → {type:"tool_partial"} events.
- Keep the reasoning paragraph-split (\n{2,}) and fold logic in sync across
  useAgentChat.ts (live + reconnect) and route.ts (persistence).

## Responsive / mobile layout
- AppShell picks the layout from useViewMode(): mobile by default on narrow screens (≤767px), desktop otherwise.
- "Request desktop" (via the "..." overflow menu on mobile, or the "Monitor" icon in the drawer) sets a persisted
  preference and widens the viewport meta to width=1280, so the full desktop layout renders.
- A floating "Mobile view" pill appears in forced-desktop mode to return to the mobile layout.
- **Mobile top bar**: slim (h-11), hamburger (opens unified drawer) + centered "CommandCenter" title + "…" overflow menu.
  The overflow menu contains Desktop toggle and Sign out — no toolbar-style "Desktop" button cluttering the header.
- **Unified drawer**: useMobileDrawer() context lets child pages inject arbitrary content (conversations list,
  file browser, filters, etc.) into the hamburger drawer. The drawer includes default nav links and user section.
- **Chat page**: conversations and files are accessed via the drawer — no separate sidebar panels or "Chats/Files"
  sub-toolbar on mobile. Pills at the top of the chat area ("Chats" / "Files") open the drawer with the
  appropriate content. Desktop retains its collapsible side-panels.
- **AgentChat header**: compact on mobile — single runtime badge, GitHub link as icon-only, thread ID hidden.
  Toolbar wraps and uses smaller gaps on mobile.

## Artifact rendering
- Inline images: MarkdownMessage resolves relative paths through the workspace proxy
- File cards: ArtifactCard renders inline in the chat thread for artifact_created events
- Modal viewer: ArtifactViewerModal handles .md, .py, .pdf, .png, .csv, and more
- Workspace file tree: ArtifactSidebar shows all files in the agent workspace

## Verification
- npm run dev starts on port 3001
- Chat UI connects to gateway at localhost:8000
- Model picker and agent switcher functional
- Generated images display inline in chat messages
- Artifact cards appear for files written by agents

## HITL (Human-in-the-Loop)
- ConfirmationCard.tsx — Approve/Reject prompt for agent confirmation requests
- ElicitationCard.tsx — Structured question card (VS Code ask_questions parity):
  single/multi-select options, freeform text input, recommended defaults
- TodoPanel.tsx — VS Code-style "Todos (n/m)" collapsible panel above input
- Both cards render inline in the chat thread; user answers are sent as
  the next chat message for the agent to process

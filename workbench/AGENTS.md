# Workbench

## Purpose
Control Plane (Next.js browser UI) and local development tools.

## Structure
- control_plane/ -- Next.js app (chat, agents, integrations, settings)
- control_plane/src/components/AppShell.tsx -- Responsive shell: desktop Sidebar vs mobile top bar + unified slide-in drawer via useMobileDrawer() context
- control_plane/src/components/ViewModeProvider.tsx -- Mobile/desktop view decision + "Request desktop" toggle (persisted)
- control_plane/src/lib/nav.ts -- Shared primary navigation config (used by Sidebar + mobile drawer)
- control_plane/src/middleware.ts -- Route protection via NextAuth
- control_plane/src/auth.ts -- NextAuth v5 config (Google SSO, JWT callbacks)
- control_plane/src/app/api/agent/chat/route.ts -- AG-UI to frontend SSE translation
- control_plane/src/components/AgentChat.tsx -- Main chat component
- control_plane/src/components/MarkdownMessage.tsx -- GFM rendering with inline images
- control_plane/src/components/ArtifactCard.tsx -- Inline file cards (images, MD, PDF, etc.)
- control_plane/src/components/ArtifactSidebar.tsx -- Collapsible workspace file tree (supports fullWidth drawer mode on mobile)
- control_plane/src/components/ArtifactViewerModal.tsx -- Full-fidelity file viewer modal

## Conventions
- Next.js App Router pattern
- SSE streaming for real-time chat
- AG-UI protocol translation in route.ts
- Google SSO (NextAuth v5) restricted to org domain
- Route protection via middleware.ts (auth-gated when Google credentials are set)
- Identity chain: NextAuth session → X-User-Email / X-User-Role headers → gateway UserContext
- Role resolution: EXECUTIVE_EMAILS env var (comma-separated) → employee by default
- All API routes that proxy to gateway forward user identity headers alongside Bearer token
- Agent-generated files (artefacts) are proxied via /api/agent/workspace/{sessionId}/file?path=
- Image URLs in markdown are rewritten through the workspace file proxy automatically
- Agents SHOULD write generated files to .tmp/ or outputs/ for discoverability

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

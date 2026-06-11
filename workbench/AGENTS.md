# Workbench

## Purpose
Control Plane (Next.js browser UI) and local development tools.

## Structure
- control_plane/ -- Next.js app (chat, agents, integrations, settings)
- control_plane/src/components/AppShell.tsx -- Responsive shell: desktop Sidebar vs mobile top bar + slide-in nav drawer
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

## Responsive / mobile layout
- AppShell picks the layout from useViewMode(): mobile by default on narrow screens (≤767px), desktop otherwise.
- "Request desktop" (Monitor button in the mobile top bar) sets a persisted preference and widens the
  viewport meta to width=1280, so the full desktop layout renders and all Tailwind sm:/md: breakpoints
  evaluate as desktop. A floating "Mobile view" pill returns to the mobile layout.
- Structural layout switches (sidebar↔drawer, chat side panels↔overlay drawers) are JS-driven via isMobile;
  in-component tweaks should use plain Tailwind responsive prefixes (kept in sync by the viewport trick).
- Chat page: sessions + artifact panels become full-height overlay drawers on mobile (opened from the
  in-chat Chats/Files toolbar); no functionality is removed relative to desktop.

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

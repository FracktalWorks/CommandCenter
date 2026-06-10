# Workbench

## Purpose
Control Plane (Next.js browser UI) and local development tools.

## Structure
- control_plane/ -- Next.js app (chat, agents, integrations, settings)
- control_plane/src/app/api/agent/chat/route.ts -- AG-UI to frontend SSE translation
- control_plane/src/components/AgentChat.tsx -- Main chat component
- control_plane/src/components/MarkdownMessage.tsx -- GFM rendering with inline images
- control_plane/src/components/ArtifactCard.tsx -- Inline file cards (images, MD, PDF, etc.)
- control_plane/src/components/ArtifactSidebar.tsx -- Collapsible workspace file tree
- control_plane/src/components/ArtifactViewerModal.tsx -- Full-fidelity file viewer modal

## Conventions
- Next.js App Router pattern
- SSE streaming for real-time chat
- AG-UI protocol translation in route.ts
- Google SSO restricted to org domain
- Agent-generated files (artefacts) are proxied via /api/agent/workspace/{sessionId}/file?path=
- Image URLs in markdown are rewritten through the workspace file proxy automatically
- Agents SHOULD write generated files to .tmp/ or outputs/ for discoverability

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

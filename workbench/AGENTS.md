# Workbench

## Purpose
Control Plane (Next.js browser UI) and local development tools.

## Structure
- control_plane/ -- Next.js app (chat, agents, integrations, settings)
- control_plane/src/app/api/agent/chat/route.ts -- AG-UI to frontend SSE translation
- control_plane/src/components/AgentChat.tsx -- Main chat component

## Conventions
- Next.js App Router pattern
- SSE streaming for real-time chat
- AG-UI protocol translation in route.ts
- Google SSO restricted to org domain

## Verification
- npm run dev starts on port 3001
- Chat UI connects to gateway at localhost:8000
- Model picker and agent switcher functional

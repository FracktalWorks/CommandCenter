# Jannet.AI Control Plane (workbench/control_plane)

Next.js 16 + React 19 + Tailwind v4 shell for the Skill Workbench.

## Panes
- `/skills` - Skill Studio (Monaco + OpenHands iframe + PR flow) [Phase 0.5.4]
- `/workflows` - n8n embedded iframe + Git sync [Phase 0.5.5]
- `/observability` - Audit / escalations / traces / spend [Phase 0.5.6]

## Dev
```bash
cd workbench/control_plane
npm install
npm run dev    # http://localhost:3001
```
Port `3001` is intentional - OpenHands self-host uses `3000`.

## Auth
NextAuth + Google SSO restricted to `@fracktal.in` lands in Phase 0.5.6. The shell is unauthenticated locally for now.

## CopilotKit
Pervasive AI chat (`useCopilotReadable` per pane) wires in at Phase 0.5.6.
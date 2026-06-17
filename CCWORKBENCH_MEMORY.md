# CC Workbench — Developer Memory

This file is read at the start of every CC Workbench session to give the agent cross-session context.
Update it at the end of each productive session using write_file.

---

## Session — 2026-06-16 (Initial setup)

### Built today
- `workbench/control_plane/src/app/build/ccworkbench/page.tsx` — CC Workbench chat UI
  - Session management with localStorage + Postgres persistence (cross-device)
  - Slim sessions sidebar, auto-title from first message, new/delete sessions
  - Model picker + thinking mode in bottom input pill (exact AgentChat layout)
- `workbench/control_plane/src/app/api/ccworkbench/chat/route.ts` — API route
  - LiteLLM gateway (port 8080) as LLM backend
  - Full tool suite: read_file, write_file, search_code, git_status, git_diff, git_commit, git_push, github_workflow_runs, github_workflow_logs, run_command, run_tests, view_logs, trigger_deploy
  - CCWORKBENCH_MEMORY.md injected into every system prompt for cross-session continuity
  - CI/CD-first deployment: always git_push → GitHub Actions, never trigger_deploy unless emergency
- `deploy/hostinger/acb-workbench.service` — Added PATH=/home/acb/.local/bin so uv is available
- `.gitignore` — Unignored workbench/control_plane/src/app/build/ route directories

### Infrastructure state
- VPS: 187.127.179.143 (acb@187.127.179.143), SSH key: ci_deploy_vps
- App root: /opt/acb/app
- Gateway: uvicorn on port 8000 (FastAPI), LiteLLM on port 8080
- Workbench: Next.js on port 3001, systemd acb-workbench
- GitHub repo: FracktalWorks/CommandCenter (SSH remote, push via HTTPS+token)
- CI/CD: .github/workflows/deploy.yml (push to main → lint → test → SSH deploy)

### Resolved bugs
- `choices[0]` crash: fixed with choices?.[0] optional chaining
- Build error: Turbopack `build/` directory ignored by root .gitignore → fixed with negation rules
- 400 PAT error: COPILOT_LLM_BASE_URL was pointing at port 4000 (wrong) → fixed to 8080
- Client reference manifest error: deploy now always does `rm -rf .next` before build

### Environment (VPS .env.local)
- GITHUB_TOKEN: set (PAT for GitHub API + git push via HTTPS)
- COPILOT_LLM_BASE_URL: http://127.0.0.1:8080/v1
- CCWORKBENCH_REPO_PATH: /opt/acb/app
- GATEWAY_INTERNAL_TOKEN: sk-local-dev-change-me

### Status
- CC Workbench fully deployed and working at https://commandcenter.fracktal.in/build/ccworkbench
- Sessions persist in localStorage + Postgres
- Memory (this file) injected into every session

### Next steps (as of 2026-06-16)
- Test end-to-end: ask agent to make a small change, verify CI/CD pipeline runs and deploys
- Consider adding file diffing view to the tool row UI
- Consider git_pull tool to sync before starting work

# Archived specs

These specs are **shipped, historical, or superseded by code**. They are kept for
design rationale and history, not as forward-looking plans. The feature each
describes is live in the codebase (or the doc has been folded into a living
survivor). Any *remaining* open work from these has been carried forward — see
the "Residual work" column and `project_plan.md`.

Verified against code 2026-07-13 (spec reconciliation pass). Do not treat these as
the current status of anything — the living specs in `../`, `FOUNDATION_BUILDOUT_CHECKLIST.md`,
and `competitive_hardening_2026-07.md` are the current trackers.

| Archived spec | Why archived | Residual open work (carried forward) |
|---|---|---|
| `core_loop_unification.md` | Refactor SHIPPED (event_translator / chat_fold / watchdog / assemble_run_context wired). | — durable summary lives in `../core_module_map.md` |
| `context_assembly_c2.md` | SHIPPED (`context.assemble_run_context`, wired in executor). | — folds into `../core_module_map.md` C2 row |
| `dev_velocity_tooling_2026-07.md` | SHIPPED (L1 CI gates, L2 CodeGraph MCP, L3 code-health workflow). | ratchet follow-up = audit **M10 / BO-17** |
| `artifact_viewer.md` | SHIPPED (`ArtifactViewerModal` + sidebar/card + `write_artifact` backend; superset of spec incl. DOCX). | — |
| `chat_implementation_review_2026-07.md` | Point-in-time audit; its P0 fixes + strategic refactors landed in code. | any residual P1/P2 → `../chat_ux.md` §12 |
| `chat_ui_agui_hitl_review_2026-07.md` | Point-in-time audit; both gaps (inline HITL, typed renderer registry) closed. | — |
| `runtime_agent_effectiveness_2026-07.md` | Items ①②④ SHIPPED (tool_scope, tool-output trim, message compression). | item ③ (sandbox/`Dockerfile.mutation`) → **BO-7** |
| `email_app_review.md` | Pure M0→M9 build changelog; subsumed by `../email_ai_assistant.md` §6. | — |
| `email_inbox_zero_parity_plan.md` | Parity audit; core shipped. | **open feature gaps** → `project_plan.md`: Gmail Pub/Sub push, calendar context, AI-Clean, Slack/Teams/Telegram notify |
| `email_tool_consolidation.md` | Goal met — tool surface consolidated 63→41 (`agent-email-assistant/agents.py`). | — |
| `pixel_art_office_pipeline.md` | Real Pixel-Lab art SHIPPED; described artifacts (`sprites.generated.ts`/`spriteFor()`/Avatar Studio) SUPERSEDED by the top-down office (`office-topdown.tsx` + `character-library.generated.ts`). | — asset-anchor reference only |
| `stream_reconnection.md` | SHIPPED (`stream_relay` push/replay/subscribe/run_detached; audit rates it "solid"). | — |
| `vscode_tool_integration.md` | SHIPPED (5/6 VS Code tools live). | `github_search` no-auth bug → audit **M9** |

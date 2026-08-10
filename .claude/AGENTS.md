# `.claude/` — the autonomous dispatch loop

**Scope:** Claude Code harness configuration for this repo — the supervisor-worker
loop that executes `project-docs/work_plan.md` semi-autonomously. Parent
contract: root `AGENTS.md` (DOX). Nothing here is application code; nothing here
ships to the VPS.

## What lives here

| Path | Kind | Purpose |
|---|---|---|
| `commands/next-ticket.md` | slash command | One supervisor cycle: select → audit → build → verify → review → PR |
| `agents/spec-auditor.md` | subagent | Is this WS dispatchable at all? Gatekeeper; read-only |
| `agents/ws-implementer.md` | subagent | Builds one cleared slice on a branch |
| `agents/ws-verifier.md` | subagent | Independently re-runs acceptance; read-only |
| `agents/diff-reviewer.md` | subagent | Adversarial defect hunt on the diff; read-only |
| `hooks/plan-guard.mjs` | PreToolUse hook | Deterministic owner-gate + branch enforcement |
| `hooks/plan-guard.test.mjs` | test | `node .claude/hooks/plan-guard.test.mjs` |
| `hooks/rtk-bash.sh` | PreToolUse hook | Compresses noisy shell output before it reaches context |
| `skills/impeccable/` | skill | Frontend design review (PostToolUse detector) |

## The three load-bearing ideas

1. **State lives in git, never in an agent.** `work_plan.md` §2 is the queue;
   each spec's status header is the completion record. A cycle that dies
   mid-flight loses nothing, because the next cycle rebuilds its picture from the
   repo. Any agent that "remembers" instead of writing it down has failed.

2. **Enforcement is a hook, not a prompt.** Instructions degrade over a long
   unattended run; `plan-guard.mjs` does not. It is the reason the loop can run
   without someone watching. Every agent prompt *also* states the owner gates —
   that redundancy is deliberate, so the agent refuses coherently rather than
   discovering the wall by hitting it.

3. **The verifier must not be the implementer.** Self-reported success is the
   dominant failure mode of autonomous loops. `ws-verifier` reads the diff before
   it reads the claims, and re-runs the spec's commands rather than the ones the
   builder chose.

## Rules for changing this directory

- **`work_plan.md` §6 and `plan-guard.mjs` change together, in the same PR.** A
  gate that exists in prose but not in the hook is not a gate. Add the case to
  `plan-guard.test.mjs` at the same time.
- **The loop stops at "PR opened".** Merge and deploy stay human. Deploy
  auto-applies migrations before the gateway restarts, and git-resets the tree —
  an agent cannot undo either. Do not add a deploy step here.
- **Subagents are one level deep.** A worker cannot dispatch workers, so all
  orchestration lives in `commands/next-ticket.md` or in the main session.
- **Keep worker tool grants narrow.** The read-only agents stay read-only; that
  is a correctness property, not a precaution. It also matters for cost — the
  measured injected-tool floor is ~19.3k tokens per agent.
- **Prompts here encode the standing rules** (R1 no absolute future migration
  numbers, R3 nomenclature, R4 status propagation). When those change in
  `work_plan.md`, update the agent prompts that quote them.

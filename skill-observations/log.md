# Skill Observation Log

Observations captured during task-oriented work. Each entry identifies a
potential skill improvement or new skill opportunity.

**Status key:** OPEN = not yet actioned | ACTIONED = skill updated/created |
DECLINED = user decided not to pursue

---

## 2026-07-04

### Observation 1: Research-heavy advisory tasks benefit from measuring the actual codebase before recommending tools

**Date:** 2026-07-04
**Session context:** User asked for tooling + a maintainability-review philosophy to keep a large, growing agent-orchestration monorepo developable by coding agents.
**Skill:** New skill candidate: codebase-health-audit
**Type:** open-source
**Phase/Area:** Research + recommendation synthesis

**Issue:** The temptation on a "what tools should we adopt" question is to answer from general knowledge. The high-signal answer came from measuring the real repo first (766 tracked files, a 5,019-line executor, 33 files >800 LOC, ruff lint non-blocking in CI, mypy strict configured but absent from CI, pre-commit installed but no config file). Every recommendation could then be tied to a concrete gap the user actually has, rather than a generic checklist.

**Suggested improvement:** A reusable "codebase health audit" skill would codify the measure-first sequence: file-size distribution, complexity gate presence, CI gate strength (blocking vs advisory), dead tooling deps, then map findings to a prioritized adoption plan.

**Principle:** For "which tools should we adopt" questions on an existing codebase, measuring the repo's real metrics first turns a generic listicle into a grounded, prioritized plan. The measurement is the differentiator.

### Observation 2: "Advisory" CI gates silently rot — flag continue-on-error and configured-but-unenforced tooling

**Date:** 2026-07-04
**Session context:** Same session — auditing CommandCenter's dev tooling.
**Skill:** New skill candidate: codebase-health-audit
**Type:** open-source
**Phase/Area:** CI / quality gate analysis

**Issue:** The repo had three latent gaps that all read as "we have quality tooling" but enforce nothing: (1) ruff runs with `continue-on-error: true` in pr-check.yml, (2) mypy is `strict=true` in pyproject but never invoked in any CI job, (3) `pre-commit` is a dev dependency but there's no `.pre-commit-config.yaml`. Each is invisible unless you cross-check the config against the CI invocation.

**Suggested improvement:** In any tooling audit, explicitly cross-check every configured linter/type-checker/formatter against whether CI actually *fails* on it, and every quality dependency against whether it's actually wired up. Report the delta as "configured but not enforced."

**Principle:** Configuration presence ≠ enforcement. The gap between "tool is installed/configured" and "tool blocks a bad merge" is where quality silently degrades. Always verify the enforcement path, not just the config.

### Observation 3: Turning on a dormant lint/type gate is a cheap bug-finder — real defects hide in the noise

**Date:** 2026-07-04
**Session context:** Same session — making ruff blocking in CI for CommandCenter surfaced 1,284 pre-existing violations; after auto-fixing 1,216 and grandfathering style rules, 30 remained.
**Skill:** New skill candidate: codebase-health-audit
**Type:** open-source
**Phase/Area:** Enforcement rollout / bug discovery

**Issue:** Among the "lint debt," `F821 undefined-name` flagged two genuine latent runtime bugs that had nothing to do with style: (1) imap.py:238 calls `_parse_imap_full_message` which doesn't exist (real fn is `_parse_imap_raw_message` with a different 4-arg signature — the get_message path was never correctly wired), and (2) runner.py:1267 references `account_user` in a function whose param is `user_email` — a guaranteed NameError on the AI-draft body-hydration path. Both would only fire at runtime on specific branches, so tests/manual use hadn't caught them.

**Suggested improvement:** When rolling out a previously-dormant static gate, treat the first run's output as a bug-discovery pass, not just cleanup. Separate correctness-class findings (F821 undefined-name, F601 repeated-key, F811 redefinition) from style-class findings, and surface the correctness ones to the user as bugs — never bundle them into a mechanical "chore: lint" commit, because their fix requires judgment and independent verification.

**Principle:** Static analysis gates that were never enforced accumulate real bugs, not just style drift. The value of turning one on is highest on the first run. Triage the output by *class* (correctness vs style), fix-and-verify correctness findings independently, and mechanically sweep the rest.

### Observation 5: A blanket `ruff --fix` on a real codebase silently deletes intentional re-exports — never trust a bulk auto-sweep

**Date:** 2026-07-04
**Session context:** Same session. User approved "auto-fix now" for 1,216 ruff violations. The sweep looked clean (code compiled) but broke a test on import.
**Skill:** New skill candidate: codebase-health-audit
**Type:** open-source
**Phase/Area:** Auto-fix / bulk remediation

**Issue:** `ruff check --fix` deleted 52 aliased imports across the repo, including intentional re-export shims that carried explicit `# noqa: F401` markers (e.g. `from orchestrator.event_translator import ToolCallStreamState as _FcStreamState` — re-exported for tests/legacy call sites; and `from gateway.routes.tasks import ai as _ai  # noqa: F401` — side-effecting router registrations). Ruff removed the imports AND their noqa markers. `py_compile` passed because the deletions are only detectable at import time by the *other* modules that import those names. It surfaced only when a unit test failed to import `_FcStreamState`. Also caused CRLF churn across ~34 files on Windows autocrlf. The whole sweep had to be reverted and the fixes re-applied surgically.

**Suggested improvement:** For bulk remediation, NEVER run a blanket `--fix` and commit it. Instead: (1) run `--fix` on a throwaway copy, (2) diff for deleted `import ... as _X` and any line that had a `# noqa`, (3) treat re-export deletions and side-effecting imports as false positives, (4) prefer per-rule, per-directory fixes over repo-wide. When a codebase uses `__init__.py` re-exports or import-for-side-effect (FastAPI routers, plugin registries), F401 auto-fix is actively dangerous. Set `[tool.ruff.lint.per-file-ignores]` or use ruff's `__all__`-aware detection before ever auto-fixing F401.

**Principle:** Auto-fixers optimize for the local rule, not global semantics. On any codebase with re-exports or import-side-effects, a bulk `--fix` is a semantic-changing operation disguised as cleanup — and compilation success does not prove safety. Verify by import/test, scope fixes narrowly, and diff-review every deleted import.

### Observation 6: A tool's output against a MODIFIED file can produce phantom findings — always re-verify against clean state

**Date:** 2026-07-04
**Session context:** Same session — I flagged `inspect` as an undefined-name bug in executor.py based on ruff F821 output, added a module-level import "fix", which then created two NEW F811 redefinition errors.
**Skill:** New skill candidate: codebase-health-audit
**Type:** open-source
**Phase/Area:** Finding verification

**Issue:** The F821 `inspect` "bug" I diagnosed was an artifact of running ruff against the ALREADY-SWEPT file (the sweep had reorganized imports). On clean HEAD, every `inspect.` use-site had a local `import inspect` in scope — it was never broken. My "fix" (module-level import) was unnecessary and introduced two F811 redefinitions of the still-present local imports. I only caught it by mapping every import and use-site to its enclosing scope. Net: 1 of my 4 claimed "bugs" was a false positive caused by analyzing a dirty tree.

**Suggested improvement:** Before claiming a static-analysis finding is a real bug, re-run the analyzer against a CLEAN checkout of the file (git stash / git show HEAD:path), not the working copy that other automated edits have already touched. For "undefined name" specifically, map each use-site to its nearest enclosing scope and check for local imports before concluding the name is unbound.

**Principle:** A finding is only as trustworthy as the state it was computed against. When multiple automated edits touch the same file, findings from the dirty intermediate state are unreliable — verify against clean HEAD before acting, and self-audit your own claimed fixes as rigorously as you'd audit found bugs.

### Observation 7: Match the automation runner to the codebase's own conventions, not to what sounds most "agentic"

**Date:** 2026-07-04
**Session context:** Same session, Phase 3 — building a periodic "code health review." The obvious framing ("a sub-agent that reviews the code") pulled toward building a full in-app MAF agent + APScheduler cron.
**Skill:** New skill candidate: codebase-health-audit
**Type:** open-source
**Phase/Area:** Architecture selection for scheduled/automated work

**Issue:** A scout of the repo revealed it deliberately has "no in-app cron for agents" and that adding one means a long-lived scheduler process + a new agent runtime + VPS footprint. The far simpler, more honest fit for a weekly measurement-and-flag job was a GitHub Actions scheduled workflow (which already had a precedent — a weekly upstream-sync cron) that runs a read-only script and opens a tracking issue. The "agent" part collapsed to a versioned skill a human/coding-agent invokes to ACT on the flag. Result: zero new runtime, secrets, or process — and it respects the repo's stated design principle.

**Suggested improvement:** When a task is framed as "build an agent that does X periodically," first check the repo's existing automation conventions (CI crons, schedulers, systemd timers) and its stated principles. Choose the lightest runner that fits; reserve a full agent runtime for work that genuinely needs LLM reasoning in the loop, not for deterministic measure-and-report. Split "measure + flag" (cheap, deterministic, CI) from "reason + act" (a skill invoked on demand).

**Principle:** The word "agent" in a request is a description of intent, not a mandate for agent *infrastructure*. Deterministic, measurable work (metrics, thresholds, reports) belongs in the cheapest deterministic runner the repo already uses; LLM-in-the-loop reasoning is what actually justifies an agent. Fit the tool to the codebase's conventions, not to the most impressive-sounding architecture.

### Observation 8: Fixed-min-width bottom-nav tabs overflow narrow phones

**Date:** 2026-07-05
**Session context:** Task-manager app mobile polish — the Tasks bottom nav Capture tab was reported getting cut off on mobile.
**Skill:** New skill candidate: responsive-navbar-fit (or an addition to a frontend/impeccable layout skill)
**Type:** open-source
**Phase/Area:** Responsive layout — horizontal tab/nav bars

**Issue:** A fixed-count bottom navigation bar rendered each button with a hard `min-w-[48–52px]` plus per-button horizontal padding, inside a `flex justify-around`. With 5 tabs the summed minimum (~348px of content+padding) exceeded a 320px viewport and was tight at 360px, so the rightmost tab(s) clipped. The bug is latent: it only appears when a section adds a 4th/5th tab, so it passes review with 3 tabs and silently breaks later. Fix was to switch every nav button to `flex-1 min-w-0` with trimmed padding so children share the row width and can never overflow.

**Suggested improvement:** Add an anti-pattern to the frontend layout guidance: for a nav/toolbar with a *known small number of equal siblings that must all stay visible*, use `flex-1 min-w-0` (equal distribution, overflow-proof), NOT fixed `min-w-[Npx]` per item. Reserve fixed min-widths + horizontal scroll for lists whose item count is unbounded. Include the "count the hard minimum vs the smallest target viewport (320px)" check.

**Principle:** A row of must-stay-visible equal siblings should distribute space (`flex-1`), not reserve it (`min-w`). Fixed per-item minimums make overflow a function of item count, so the layout is correct until someone adds one more item — a latent regression that unit tests and 3-item review both miss. Distribution-based layout removes the failure mode entirely instead of tuning the pixel budget.

### Observation 9: Verify "build from scratch" requests against the codebase before designing

**Date:** 2026-07-05
**Session context:** User asked to give the task-manager agent ClickUp intelligence by "creating/annealing a new agent inspired from the project-manager agent," plus multi-workspace config and periodic self-refresh.
**Skill:** task-observer (methodology) + general agentic-work practice
**Type:** open-source
**Phase/Area:** Research-before-implementation / scoping

**Issue:** The user's framing implied a large greenfield build ("anneal your task manager inspired from the PM agent... it should get all tasks, know active/passive projects, know people's abilities from CVs"). Parallel research agents (dispatched before writing any code) found that ~80% was already built and correctly architected: the task-manager was ALREADY a MAF agent (not the Copilot-SDK the user assumed), already had gateway-backed tools reading ClickUp projects/tasks/people-with-skills, and multi-workspace-from-multiple-accounts was already the implemented design. There was no separate PM agent to fork — it's an external HR-data source. Building "from the PM agent" would have duplicated existing, working infrastructure. The real work was four specific gaps (clarify cognition, periodic refresh, retiring a legacy single-workspace path, unused résumé depth). Presenting this reframing as a plan artifact BEFORE coding let the user pick scope (Phase 1 first) and a key decision (retire legacy tools) — avoiding a large wrong build.

**Suggested improvement:** For any request phrased as "build/create/rewrite X inspired by Y," run a codebase-reality check (parallel read-only research agents) BEFORE designing, and lead the plan with "here's what already exists vs. what your ask actually needs." Make the gap between the user's mental model and the codebase reality the first thing surfaced.

**Principle:** Users describe desired outcomes in build-it language even when most of the capability exists — their mental model of the codebase lags its actual state. The highest-leverage early move is reconciling the request against ground truth, not starting to build. A short research phase that reframes "build a new agent" into "close four gaps in the existing one" saves the largest possible amount of wasted work, and the reframing itself is the most valuable deliverable of the planning stage.

### Observation 10: Trace "the data is thin" to its source before adding code that consumes it

**Date:** 2026-07-05
**Session context:** Building "know people's abilities from their CVs" for the task-manager. The gtd_people DB schema, import script, and API all had experience/education/years/domain fields, but they were empty for everyone.
**Skill:** general agentic-work practice (research-before-build)
**Type:** open-source
**Phase/Area:** Data-pipeline debugging / root-cause tracing

**Issue:** The capability ("delegate by CV-derived experience/seniority/domain") appeared blocked at the code layer — the API response model didn't serve the deep résumé fields (a classic "stored but not served" gap). But following the data UP the pipeline (DB column → import script → source JSON → the extractor that produces the JSON → the CV PDFs) revealed the real blocker was three layers up: the extractor (`ingest_resumes.py` in a SEPARATE repo) was skills-only BY DESIGN — it hardcoded `experience_summary=""`, `education=[]`, `years_experience=None`, `domain="Unknown"` and never read them from the PDFs. Serving the fields (the obvious fix) would have shipped a feature that surfaces nothing, because the data is empty at the source. The fix had to be at the extractor (upgrade it to LLM-parse the PDFs), and the code-layer serving was necessary but not sufficient. Both were done; the serving flows the data the moment the extractor runs.

**Suggested improvement:** When a feature depends on a data field that turns out empty/thin, trace the field to its origin (all the way to the raw source) BEFORE writing consumer code — confirm the data is actually produced, not just schema-present. Fix the earliest broken link; ship consumer code alongside only when the producer is also fixed. Note the "needs a live run to populate" boundary explicitly so it isn't mistaken for done.

**Principle:** A populated schema column is not populated data. "Stored but not served" is a real gap, but it's often a symptom of a deeper "never produced" gap — the empty field at the API is downstream of an extractor/import that never filled it. Debugging a data feature means walking the pipeline to its source; fixing only the visible (serving) layer ships a hollow feature. The generalizable move: verify the producer, not just the consumer, and be explicit about which fixes are code-complete vs. which need a live run to take effect.

### Observation 11: A silent-fallback wrapper can hide a dead primary path — test the success path, not just degradation

**Date:** 2026-07-05
**Session context:** Building the LLM clarify pass (task-manager). The LLM function was wrapped in try/except returning None on failure, with a deterministic fallback.
**Skill:** general agentic-work practice (verification)
**Type:** open-source
**Phase/Area:** Testing / graceful-degradation design

**Issue:** The new LLM function used json.loads but the module only imported json locally inside a DIFFERENT function — so json.loads raised NameError, caught by the broad "except Exception: return None", making the LLM path silently ALWAYS fall back to the heuristic. My first verification only tested the DEGRADATION path (gateway down -> heuristic), which passed — masking that the SUCCESS path never worked. It was caught only by explicitly mocking a successful LLM response and asserting the LLM result came through. A broad except that yields a safe fallback is a correctness blind spot: the feature "works" (never errors) while doing nothing.

**Suggested improvement:** For any primary/fallback pair guarded by a broad except, ALWAYS write a test that drives the PRIMARY path to success and asserts its distinctive output — not only the fallback. Treat "the fallback test passes" as necessary-but-insufficient. When reviewing code with try/except-return-safe-default, grep the try body for names/imports resolvable only elsewhere.

**Principle:** Graceful degradation hides its own failures: a swallow-and-fallback wrapper makes a broken primary path indistinguishable from a healthy one at the output boundary, because both produce the safe result. The only way to know the primary works is to force it to succeed and assert its unique effect. Test the happy path of every fallback, and be suspicious of broad excepts around code whose dependencies live in another scope.

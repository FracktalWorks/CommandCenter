"""Platform tool injection + system-prompt addendum for loaded agents.

Extracted from ``executor.py`` (foundation maintainability refactor) — no
behaviour change (log event strings + the KV-cache-stable addendum text are
byte-preserved). This is the layer that, for any loaded agent (native MAF or
GitHub Copilot SDK), injects the CommandCenter platform tools (call_agent,
web_search, write_artifact, memory, todo, HITL, diagnostics, …), gates each
through the risk-aware permission policy, applies per-agent tool scoping
(``tool_scope`` / ``own_tool_scope``), appends the tools system-prompt
addendum, and merges MCP servers from the registry.

Public surface re-exported by ``executor`` (external importers/tests reach these
as ``orchestrator.executor.<name>``): ``_gate_injected_tool``, ``_tool_name``,
``_apply_own_tool_scope``, ``_build_registry_block``,
``_build_injected_tools_addendum``, ``_inject_agent_tools``,
``_inject_mcp_servers``.
"""
from __future__ import annotations

import functools
import os
from typing import Any

from acb_common import get_logger

from orchestrator._copilot_session import _apply_copilot_infinite_sessions

_log = get_logger("orchestrator.tool_injection")


# ── Guaranteed standard toolset ────────────────────────────────────────────
# Every loaded agent ALWAYS receives this small essential baseline, regardless
# of a per-agent ``config.json: tool_scope``.  These are the tools any agent
# needs whatever its specialty — write a file, track a todo, search the web,
# ask the user a question, check its own code, keep working notes.  A
# ``tool_scope`` may still ADD specialist tools on top, but it can no longer
# silently strip the basics: a scope that omitted ``write_artifact`` is exactly
# why agents fell back to fragile shell heredocs to author files (burning their
# output budget on shell-escaping and truncating mid-write).  Kept deliberately
# SMALL so the Berkeley "too many tools degrades accuracy" finding still holds.
_CORE_STANDARD_TOOL_NAMES: frozenset[str] = frozenset({
    "web_search", "fetch_page",          # web access
    "write_artifact", "share_artifact",  # file writing / delivery
    "manage_todo_list",                  # task tracking panel
    "ask_questions",                     # HITL clarification
    "run_diagnostics", "get_errors",     # code / file error checking
    "save_note", "recall_notes",         # cross-session working memory
})


def _resolve_injected_scope(tool_scope: list[str] | None) -> set[str] | None:
    """Resolve which injected tool names an agent should receive.

    Returns ``None`` when there is no ``tool_scope`` (inject everything), or the
    set of allowed names = the agent's ``tool_scope`` UNIONed with the
    guaranteed :data:`_CORE_STANDARD_TOOL_NAMES` floor.  Unioning the core in
    means a scope can add specialist tools and narrow the rest, but can never
    strip the baseline (file writing, todo, web search, clarify, …).
    """
    if not tool_scope:
        return None
    return set(tool_scope) | set(_CORE_STANDARD_TOOL_NAMES)


@functools.lru_cache(maxsize=1)
def _load_design_md() -> str:
    """Return the Command Center DESIGN.md, cached for the process lifetime.

    The design system is static (ships in acb_skills), so caching keeps the
    system-prompt prefix byte-stable across turns for KV-cache hits. Injected
    into every agent so any Markdown/HTML/generative-UI it produces follows the
    Command Center design language. Returns "" if the file is missing (fail
    open — never block agent load on a missing design doc).
    """
    try:
        from pathlib import Path  # noqa: PLC0415

        import acb_skills  # noqa: PLC0415

        design_path = Path(acb_skills.__file__).parent / "design.md"
        return design_path.read_text(encoding="utf-8", errors="replace").strip()
    except Exception:  # noqa: BLE001
        return ""


def _design_md_section() -> str:
    """The full DESIGN.md wrapped as a system-prompt section (or "" if absent).

    Kept separate from :func:`_load_design_md` so the raw doc is reusable and the
    section wrapper stays out of the cache key. Byte-stable across turns because
    the underlying loader is cached.
    """
    design = _load_design_md()
    if not design:
        return ""
    return (
        "### Command Center design language (DESIGN.md)\n"
        "Follow this for every document, report, and UI you generate:\n\n"
        f"{design}"
    )


def _build_output_discipline_block(*, compact: bool = False) -> str:
    """The 'all generated files live under outputs/' + design-language rule.

    Injected into every agent (both runtimes). Two concerns, one block:
      1. File discipline — EVERY file the agent generates goes under ``outputs/``
         (logical subfolders encouraged), for both MAF and Copilot agents. This
         keeps the workspace tidy and, crucially, persistent: ``outputs/`` is the
         durable, redeploy-surviving home for deliverables.
      2. Design language — a pointer to the injected DESIGN.md so any document,
         report, or UI matches the Command Center look.
    """
    if compact:
        return (
            "FILES: write files with write_artifact(path, content) — pass the "
            "content directly; do NOT build files with shell heredocs / echo / "
            "printf / base64 (fragile quoting truncates large writes). Put "
            "every file under outputs/ (logical subfolders, e.g. "
            "outputs/reports/); never the working-dir root. Markdown/HTML you "
            "produce must follow the injected Command Center DESIGN.md."
        )
    return (
        "### Output discipline (REQUIRED)\n"
        "- **To write a file, call `write_artifact(path, content)`** — pass the "
        "file's content directly as the `content` argument. Do NOT assemble "
        "files with shell heredocs, `echo`, `printf`, `cat <<EOF`, or `base64`: "
        "that fragile quoting breaks on quotes/backticks, wastes your output "
        "budget, and can truncate a large write mid-file. Use the shell to RUN "
        "things, not to author file content.\n"
        "- Write EVERY file you generate under **outputs/** — reports, docs, "
        "HTML, data, scripts, images, everything. Use logical subfolders to "
        "stay organised (e.g. `outputs/reports/q3.md`, `outputs/data/rows.csv`, "
        "`outputs/site/index.html`). `write_artifact` already defaults bare "
        "paths to `outputs/`; when you use your own shell/editor tools, still "
        "target `outputs/` explicitly, never the working-directory root.\n"
        "- `outputs/` is the durable deliverables home — it persists across "
        "redeploys and reboots. Treat it as the one place a user looks for what "
        "you made.\n"
        "- Prefer Markdown (`.md`) for written deliverables and HTML (`.html`) "
        "for rich/interactive reports — both get a live preview in the side "
        "panel. Any Markdown, HTML, or generative UI you produce MUST follow "
        "the **Command Center DESIGN.md** included below."
    )


def _gate_injected_tool(fn: Any) -> Any:
    """Wrap an injected platform tool with the risk-aware permission gate (B6).

    The Copilot-SDK ``on_permission_request`` hook only fires for the SDK's
    BUILT-IN shell/file/fetch capabilities — our injected function-tools
    (web_search, write_artifact, …) are executed directly by the agent-framework
    on the streaming/BYOK path and bypass that hook entirely. Wrapping each tool
    here makes the gate universal: whichever runtime path invokes the tool, the
    decision runs + logs (``permission.decision``, auto-correlated to the run via
    the E2 contextvars). ``enforce`` mode blocks a denied call; ``audit`` /
    ``approve_all`` never block. Preserves the tool's name/signature (functools
    .wraps) so the SDK/MAF tool registration is unchanged.
    """
    import functools  # noqa: PLC0415
    import inspect  # noqa: PLC0415

    tool_name = getattr(fn, "__name__", "tool")

    def _gate() -> tuple[bool, str]:
        """Return (allowed, reason). Never raises. Logs EVERY decision.

        Logging approvals too (not just denials) is what makes audit mode
        actually observable — an operator running in audit needs the full
        decision stream to judge the policy before flipping to enforce, and it
        is how we confirm the gate is even on this tool's execution path.
        """
        try:
            from acb_skills.permission_policy import decide  # noqa: PLC0415
            ok, code, _ = decide({"tool_name": tool_name})
            mode = os.environ.get(
                "AGENT_PERMISSION_MODE", "enforce"
            ).strip().lower()
            enforced = (not ok) and mode == "enforce"
            _log.info(
                "permission.decision", mode=mode, tool=tool_name,
                approved=(not enforced), would_deny=(not ok), reason=code,
                surface="injected_tool",
            )
            return (not enforced), code
        except Exception:  # noqa: BLE001 — a gate bug must never brick a tool
            return True, "gate_error"

    if inspect.iscoroutinefunction(fn):
        @functools.wraps(fn)
        async def _agated(*args: Any, **kwargs: Any) -> Any:
            allowed, reason = _gate()
            if not allowed:
                return f"[blocked by permission policy: {reason}]"
            return await fn(*args, **kwargs)
        return _agated

    @functools.wraps(fn)
    def _sgated(*args: Any, **kwargs: Any) -> Any:
        allowed, reason = _gate()
        if not allowed:
            return f"[blocked by permission policy: {reason}]"
        return fn(*args, **kwargs)
    return _sgated


def _build_injected_tools_addendum(*, is_sub_agent: bool = False) -> str:
    """Return a system-prompt addendum describing the CommandCenter-injected tools.

    Appended to every GitHub Copilot agent's system message at run time so the
    LLM knows the injected tools exist, when to use them, and what valid agent
    names are.  MAF agents receive these instructions via the MAF instructions
    field directly; this is only needed for the Copilot SDK path where the agent's
    own ``instructions.md`` was written without knowledge of CommandCenter injection.

    When ``is_sub_agent=True`` (the agent is called via call_agent from a parent),
    a compact version is returned — tool names only, no workspace/commit instructions.
    This saves ~700 tokens per sub-agent invocation.

    The full addendum is module-level cached after first build (the registry
    only changes on gateway restart) to keep the system-prompt prefix byte-stable
    across turns — required for KV-cache hits.
    """
    registry_block = _build_registry_block()

    # Byte-stable risk-annotation block (HH-2) — the registry is static, so
    # this keeps the system-prompt prefix cache-friendly.
    try:
        from acb_skills.tool_annotations import risk_summary_block  # noqa: PLC0415
        risk_block = risk_summary_block()
    except ImportError:
        risk_block = ""

    # ── Compact version for sub-agents ──────────────────────────────────────
    if is_sub_agent:
        return f"""
---
## CommandCenter Platform Tools
{_build_output_discipline_block(compact=True)}
call_agent(name,msg), call_agents_parallel(tasks), call_agent_background(name,msg)
web_search(query), fetch_page(url)
write_artifact(path,content) — files go to outputs/
share_artifact(path) — show a file you already wrote as a download/preview card
emit_generative_ui(ui) — render rich UI inline; reach for it EAGERLY when the answer is data/status/comparison/a checklist/a value to pick or set (not for trivial one-liners). On-brand automatically. 3 modes: (1) component tree card/table/keyValue/badge/callout/button(label+action) + an icon node (type:icon, name=any Lucide icon e.g. 'cloud-sun'); (2) a template node (type:template, name= weatherCard/statDashboard/barChart/sparkTrend/comparison/progressTracker) pre-designed animated cards, supply data only (stats take optional icon); (3) an html node (type:html, props code + optional icons list of Lucide names) custom animated HTML/CSS/JS in a sandbox — style with the pre-set CSS vars --cc-primary/--cc-accent/--cc-fg/--cc-card/--cc-border/--cc-radius/--cc-ease (native inputs+sliders pre-styled), use icons via ccIcon('Name') or a span with data-cc-icon='Name', wire interactivity via data-cc-action='msg' (fixed follow-up) or data-cc-submit='label'/ccSubmit('label',value) to send user-set slider/input/select VALUES back. Prefer template over tree over html.
remember(query)/save_memory(fact) = THIS USER's private memory; recall_agent(query)/save_agent_memory(fact) = shared across ALL users of this agent; recall_org(query)/save_org_memory(fact) = organisation-wide (every agent+user); recall_timeline(entity,query), save_episode(name,content)
manage_todo_list(todoList) — structured task tracking panel (JSON array)
ask_user(question,choices?) — HITL: pause and ask the user one question (blocking; the run resumes with their answer)
run_diagnostics(filePaths?) — run code diagnostics: check Python files for syntax/lint errors (alias: get_errors)
install_dependency(packages) — install Python package(s) into the agent venv at runtime
save_note(path,fact), recall_notes(path,query?) — repo-scoped working memory
query_history(sql) — SELECT-only query against chat history DB
github_search(q,scope?,max?), github_repo_search(repo,q?) — code search

{risk_block}

{registry_block}
---"""

    return f"""
---
## CommandCenter Platform Tools (injected at runtime)

### Inter-agent delegation
- **call_agent(agent_name, message)** — Delegate to another agent; waits for its response.
- **call_agents_parallel(tasks)** — Run multiple agents concurrently (JSON array of {{"agent","message"}} objects).
- **call_agent_background(agent_name, message)** — Fire-and-forget; use when result is not needed now.

{registry_block}

### Web access (no API key required)
- **web_search(query, max_results=5)** — Web search (SerpAPI/Google first when configured, free engines as fallback). Use for current info, news, company research.
- **fetch_page(url, max_chars=8000)** — Fetch a public URL as clean text via Jina Reader.

### Memory & knowledge graph
- **remember(query)** — Search episodic memory for past facts about the user. Call before making claims about history or preferences.
- **recall_timeline(entity, query)** — Bi-temporal knowledge graph: "when did X happen?" or entity history.
- **save_memory(fact)** — Persist a high-signal fact about THIS USER. Routine turns are handled automatically.
- **recall_agent(query)** / **save_agent_memory(fact)** — This AGENT's memory, shared across EVERY user who talks to it. Use for durable knowledge the agent should carry regardless of who's asking (procedures, domain facts, decisions) — not one user's private preference.
- **recall_org(query)** / **save_org_memory(fact)** — ORGANISATION-WIDE memory shared by every agent and user. Read when a question touches company-level context; write only genuinely company-level facts (structure, policy, standing priorities), and confirm before writing.
- **save_episode(name, content, source?)** — Record a time-stamped episode; Graphiti extracts entities & relationships.

### Workspace & file writing
{_build_output_discipline_block()}

Workspace folders visible in the Files Viewer: **outputs/** (default for generated files), **inputs/** (user uploads, read-only), **agent-data/** (reusable reference data).
- **write_artifact(path, content, encoding?, overwrite?)** — Write a file to outputs/ (if path has no prefix). The chat shows a Download/preview card **automatically** — you do NOT need to build or paste any URL; just say what the file is. It never clobbers an existing file by default (it auto-versions to ``name (1).ext`` and returns the real ``path``); pass ``overwrite=true`` only when you deliberately want to replace a file in place.
- **share_artifact(path)** — If you created a file with your OWN tools (shell, editor, a script you ran) instead of write_artifact, call this with that file's path (or a folder) to surface it as a Download/preview card. The card appears automatically; do NOT hand-construct links.
- **emit_generative_ui(ui)** — Render a rich, interactive, animated UI element inline in the chat, on the fly. REACH FOR THIS EAGERLY: when the answer is data, a metric, a status, a comparison, a checklist, or a value the user should pick or set, render UI instead of a paragraph — it is clearer and often interactive. Do not be trivial about it (a one-line factual reply or a long narrative stays as text), but whenever there is a genuine chance to let the user adjust a value, pick an option, or confirm a choice, prefer an interactive UI over asking in prose. All three modes follow the Command Center design language automatically (blue primary, warm-orange accent, rounded cards, subtle motion). `ui` is a JSON object discriminated by its top-level `type`. Three modes, prefer them in this order:
    1. **Named template** (best-looking, use first when one fits) — a node with type "template" and props holding `name` plus a `data` object. Pre-designed animated cards; supply data only. Available names: weatherCard, statDashboard, barChart, sparkTrend, comparison, progressTracker (see the emit_generative_ui tool doc for each one's data shape). statDashboard stats accept an optional `icon` (a Lucide name).
    2. **Component tree** (structured, safe) — a whitelist tree of card / table / keyValue / badge / callout / list / button / icon nodes; data, not code. The icon node takes a `name` = any Lucide icon (e.g. cloud-sun, check-circle, trending-up). A button node has a `label` plus an `action` string sent back when clicked. Good for summaries, tables, labelled rows, and action buttons.
    3. **Custom HTML** (escape hatch, only when no template/tree fits, and the place for genuinely interactive controls) — a node with type "html" and props holding `code` (a full HTML/CSS/JS snippet) plus an optional `icons` array of Lucide names. Runs in an isolated sandbox for bespoke animation/layout. No external network/CDNs — inline everything; use declared icons via ccIcon('Name') or a span with data-cc-icon='Name'. DESIGN: use the pre-defined CSS variables so it matches the app — --cc-primary, --cc-accent, --cc-fg, --cc-muted, --cc-card, --cc-secondary, --cc-border, --cc-success, --cc-warning, --cc-danger, --cc-radius, --cc-ease — instead of hard-coded colors; native button/input/select/textarea and range sliders are already styled on-brand (add class cc-primary for a filled blue button, cc-card for a panel). INTERACTIVITY: put data-cc-action='<follow-up message>' on a clickable element (or call ccAction('...') in script) to fire a fixed follow-up like a button; put data-cc-submit='<label>' on a button to harvest every named input/select/textarea in its enclosing form (or a data-cc-form container) and submit their VALUES back — or call ccSubmit('Temperature', 22) directly — so when the user sets a slider/number/option the agent actually receives what they chose.

**Delivering files to the user:** to give the user a downloadable/previewable file, call ``write_artifact`` (for content you generate) or ``share_artifact`` (for a file you already wrote). That is ALL you need — the card renders itself. Never try to guess or assemble a download URL yourself.

### Task planning & progress tracking
- **manage_todo_list(todoList)** — Update the live "Todos (n/m)" panel above the chat input.  Takes a JSON object with ``"todoList"`` (the COMPLETE array of all items) and optional ``"operation"`` (``"write"`` or ``"read"``).  Each item: ``id`` (number, sequential from 1), ``title`` (string, 3-7 words), ``status`` (``"not-started"``, ``"in-progress"``, or ``"completed"``).  Use this tool VERY frequently.  CRITICAL workflow: 1) Plan tasks with specific items. 2) Mark ONE as ``"in-progress"`` before starting. 3) Mark it ``"completed"`` immediately after finishing. 4) Move to next.  Do NOT use for trivial single-step requests.  The user sees this panel update in real time.

**MANDATORY — You MUST call these functions. Do NOT use other tools for these purposes.**
- For todo/task tracking: call ``manage_todo_list`` — do NOT use ``remember``, ``task_manager``, ClickUp, or any other tool.
- For clarifying questions: call ``ask_user`` (native, blocking) or ``ask_questions`` — do NOT just ask in text.
- For checking code / diagnostics: call ``run_diagnostics`` (alias ``get_errors``).
- For notes: call ``save_note`` / ``recall_notes``.
- For history: call ``query_history``.
- For code search: call ``github_search`` / ``github_repo_search``.
Function calls trigger real-time UI (TodoPanel, ElicitationCard) — text does nothing.

### Human-in-the-Loop (HITL) elicitation
- **ask_user(question, choices?, allowFreeform?)** — Pause the run and ask the user ONE clarifying question via an interactive card.  This BLOCKS the agent turn: execution truly pauses and resumes automatically with the user's answer (no separate message turn).  ``choices`` is an optional list of suggested answers (rendered as buttons); ``allowFreeform`` (default true) lets the user type a custom answer.  Use when you need to disambiguate, a parameter is missing, or a decision has important implications.  Prefer ONE focused question per call.
- **ask_questions(questions)** — Alternative for asking SEVERAL questions at once via a multi-question card (JSON object with a ``"questions"`` array; each has ``header``, ``question``, optional ``options``/``multiSelect``/``allowFreeformInput``).  Prefer ``ask_user`` for single blocking questions.

### Code quality & error checking
- **run_diagnostics(filePaths?)** (alias **get_errors**) — Run code diagnostics: check Python files for syntax, type, and lint errors.  Call after editing or creating files, before committing, or to diagnose a failed run.  Pass a JSON array of file paths (e.g. ``'["executor.py"]'``) or ``'[]'`` to auto-discover recently changed files.  Runs ``py_compile`` (syntax) and ``ruff`` (lint, if installed).  Returns structured errors or ``"No errors found."``.  Both names call the same tool.

### Runtime dependencies
- **install_dependency(packages)** — Install Python package(s) into the agent runtime so your imports/tools work.  Use this when you hit a ``ModuleNotFoundError`` or know a task needs a package that isn't installed.  Pass space- or comma-separated specs, e.g. ``"pandas openpyxl"`` or ``"requests==2.31.0"`` (plain names + optional version; no flags/URLs).  Installs into the shared agent venv via ``uv``; the package is importable immediately.  Prefer this over shell ``pip install`` (the venv has no pip).

### Working memory (repo-scoped notes)
- **save_note(path, fact)** — Append a dated bullet to a markdown notes file under ``agent-data/``.  Your canonical working memory is ``agent-data/NOTES.md`` — read it at session start with ``recall_notes("NOTES.md")``.
- **recall_notes(path, query?)** — Read back a notes file, optionally filtered by a search query.  Use to restore context from previous sessions.

### Conversation history
- **query_history(query)** — Run a SELECT-only SQL query against the chat history database (tables: ``chat_session``, ``chat_message``).  Use to recall what was discussed in prior sessions, find past decisions, or resume work on a known thread.

### GitHub code search
- **github_search(query, scope?, maxResults?)** — Lexical search across public GitHub repositories.  Supports ``language:python``, ``repo:owner/name``, ``path:src/`` filters.
- **github_repo_search(repo, query?)** — Search within a specific GitHub repository for code snippets and implementation patterns.

### Working memory (NOTES.md pattern)
Maintain **`agent-data/NOTES.md`** as your cross-session working memory.
- At the START of each session: read this file if it exists to restore context.
- After each significant discovery, decision, or milestone: append a dated bullet (e.g. `- 2026-06-16: Closed ABC Corp deal at ₹50L`).
- Keep entries concise — one line per fact. This file survives context compaction and session resets.

{risk_block}
Tools marked DESTRUCTIVE are irreversible or outward-facing: never call one
without an explicit user instruction, and let its built-in confirmation card
do the confirming (do not also double-confirm in prose).

### Self-improvement & committing
To persist changes to your own repo: `git add -A`, then `git commit -m "feat: ..."`, then print `COMMIT_SHA: <git rev-parse HEAD>`. Never amend; one commit per task.
- **By default, do NOT push** — direct pushes are blocked and the commit queues for human approval in the Control Plane inbox.
- **If the user explicitly tells you to push (e.g. "commit and push") in this conversation**, then after committing run `git push --no-verify origin HEAD`. The `--no-verify` flag is required to bypass the approval hook. That commit is then recorded as already-approved — the user does not need to approve it again on the Agents page.

{_design_md_section()}
---"""


@functools.lru_cache(maxsize=1)
def _build_registry_block() -> str:
    """Build the agent registry listing, cached for the lifetime of the process.

    The registry only changes when a new agent is registered (gateway restart
    or dynamic registration endpoint).  Caching keeps the system-prompt prefix
    byte-stable across turns — required for KV-cache hits (10x cost reduction
    per Manus benchmarks).

    Call ``_build_registry_block.cache_clear()`` after registering a new agent.
    """
    agent_lines: list[str] = []
    try:
        from gateway.routes.agent import _AGENT_REGISTRY  # noqa: PLC0415
        from gateway.routes.agent import _load_dynamic_agents
        all_agents = _load_dynamic_agents() + _AGENT_REGISTRY
        for a in all_agents:
            name = a.get("name", "")
            desc = a.get("description", "")
            if name:
                agent_lines.append(f"  - {name!r}: {desc}")
    except Exception:  # noqa: BLE001
        pass
    return (
        "Registered agents:\n" + "\n".join(agent_lines)
        if agent_lines
        else "Registered agents: check with the orchestrator if unsure."
    )


def _tool_name(tool: Any) -> str:
    """Best-effort name of a tool in any of the shapes agents carry them
    (plain callables, MAF AIFunction wrappers, dict specs)."""
    name = getattr(tool, "__name__", None) or getattr(tool, "name", None)
    if not name and isinstance(tool, dict):
        name = (tool.get("function") or {}).get("name") or tool.get("name")
    return str(name or "")


def _apply_own_tool_scope(agents: list[Any], own_scope: list[str] | None) -> None:
    """Filter an agent's OWN (repo-baked) tools to ``config.json: own_tool_scope``.

    ``tool_scope`` governs which PLATFORM tools get injected; this is its
    counterpart for tools the agent ships itself (HH-5).  A large baked tool
    surface (email-assistant carries ~60) degrades accuracy exactly like an
    over-injected one, and previously could not be narrowed per deployment.

    Must run BEFORE ``_inject_agent_tools`` so platform-injected tools are
    never subject to the agent's own scope.  With no matches the full set is
    kept (fail open + warning), mirroring ``tool_scope`` semantics.
    """
    if not own_scope:
        return
    scope_set = set(own_scope)
    for agent in agents:
        for attr in ("tools", "_tools"):
            lst = getattr(agent, attr, None)
            if not isinstance(lst, list) or not lst:
                continue
            kept = [t for t in lst if _tool_name(t) in scope_set]
            if kept:
                lst[:] = kept
            else:
                _log.warning(
                    "executor.own_tool_scope_no_match",
                    agent=getattr(agent, "name", type(agent).__name__),
                    attr=attr,
                    requested=own_scope,
                    available=[_tool_name(t) for t in lst],
                )


def _inject_agent_tools(agents: list[Any], *, is_sub_agent: bool = False, tool_scope: list[str] | None = None) -> None:
    """Inject cross-agent delegation tools into every loaded agent.

    Adds ``call_agent`` and ``call_agent_background`` from ``acb_skills.agent_tools``
    so that any agent — MAF or GitHub Copilot SDK — can delegate sub-tasks to
    other registered agents without any changes to the external agent repo.

    When ``is_sub_agent=True``, a compact addendum is appended to Copilot SDK
    agents instead of the full workspace/commit guidance (~700 token saving per
    sub-agent invocation).

    When ``tool_scope`` is provided (from ``config.json: tool_scope``), only the
    named tools are injected.  This prevents the Berkeley leaderboard failure mode
    where every additional tool degrades model accuracy — inject only what the
    agent actually needs.  ``None`` means inject all tools (default).

    Injection is best-effort: failures are silently swallowed so they never
    block the main agent execution path.

    Injection targets:
        MAF Agent                — appends to ``agent.tools`` (list)
        GitHubCopilotAgent       — appends to ``agent._tools`` (list built at init;
                                   merged into SessionConfig.tools at session creation)
                                   + appends tool guidance to ``_default_options.system_message``
        Legacy Copilot SDK path  — appends to ``agent._default_options.tools`` (list)
    """
    try:
        from acb_skills.agent_tools import call_agent  # noqa: PLC0415
        from acb_skills.agent_tools import (call_agent_background,
                                            call_agents_parallel)
        _all_tools = [call_agent, call_agents_parallel, call_agent_background]
    except ImportError:
        return  # acb_skills not installed in this env — skip silently

    # Zero-credential web tools — always available, no integration config needed.
    try:
        from acb_skills.web_tools import fetch_page  # noqa: PLC0415
        from acb_skills.web_tools import web_search
        _all_tools = _all_tools + [web_search, fetch_page]
    except ImportError:
        pass  # duckduckgo-search / httpx not installed — skip gracefully

    # File-writing artifact tool — surfaces created files in the UI sidebar.
    # share_artifact surfaces a file the agent already wrote (via shell/editor)
    # as a download/preview card so it never hand-builds links.
    try:
        from acb_skills.write_artifact import (  # noqa: PLC0415
            emit_generative_ui, share_artifact, write_artifact,
        )
        _all_tools = _all_tools + [
            write_artifact, share_artifact, emit_generative_ui,
        ]
    except ImportError:
        pass

    # Memory tools — active read/write to Mem0 + Graphiti knowledge graph.
    try:
        from acb_skills.memory_tools import (
            remember,
            recall_timeline,
            save_memory,
            save_episode,
            recall_agent,
            save_agent_memory,
            recall_org,
            save_org_memory,
        )
        _all_tools = _all_tools + [
            remember, recall_timeline, save_memory, save_episode,
            recall_agent, save_agent_memory, recall_org, save_org_memory,
        ]
    except ImportError:
        pass  # acb_memory not installed — skip gracefully

    # Todo-list tracking — VS Code Copilot parity panel above chat input.
    try:
        from acb_skills.todo_tools import manage_todo_list  # noqa: PLC0415
        _all_tools = _all_tools + [manage_todo_list]
    except ImportError:
        pass

    # HITL elicitation — agent asks user clarifying questions mid-stream.
    try:
        from acb_skills.ask_tools import ask_questions  # noqa: PLC0415
        _all_tools = _all_tools + [ask_questions]
    except ImportError:
        pass

    # Code error checking — lint/syntax/type checks after edits.
    # get_errors + its clearer alias run_diagnostics (same behaviour); both are
    # injected into every agent shape so either name resolves on Copilot + MAF.
    try:
        from acb_skills.error_tools import (  # noqa: PLC0415
            get_errors,
            run_diagnostics,
        )
        _all_tools = _all_tools + [get_errors, run_diagnostics]
    except ImportError:
        pass

    # Runtime dependency install — agents can add a Python package mid-task
    # (installed into the shared agent venv, importable immediately).
    try:
        from acb_skills.dep_tools import install_dependency  # noqa: PLC0415
        _all_tools = _all_tools + [install_dependency]
    except ImportError:
        pass

    # Repo-scoped notes — agents maintain durable working memory.
    try:
        from acb_skills.note_tools import save_note  # noqa: PLC0415
        from acb_skills.note_tools import recall_notes
        _all_tools = _all_tools + [save_note, recall_notes]
    except ImportError:
        pass

    # Session history query — recall past conversations.
    try:
        from acb_skills.history_tools import query_history  # noqa: PLC0415
        _all_tools = _all_tools + [query_history]
    except ImportError:
        pass

    # GitHub code search — lexical + semantic search across repos.
    try:
        from acb_skills.github_tools import github_search  # noqa: PLC0415
        from acb_skills.github_tools import github_repo_search
        _all_tools = _all_tools + [github_search, github_repo_search]
    except ImportError:
        pass

    # ── Tool scoping: a guaranteed core floor + optional per-agent scope ───
    # A config.json ``tool_scope`` narrows the injected set to only what the
    # agent needs (technique #3 — the Berkeley Function-Calling Leaderboard
    # shows every model degrades as the tool count grows).  BUT the scope is
    # UNIONED with ``_CORE_STANDARD_TOOL_NAMES`` first, so the essential
    # baseline (write a file, todo, web search, clarify, diagnostics, notes) is
    # ALWAYS present no matter how the scope was written.  This is what stops an
    # agent whose scope forgot ``write_artifact`` from having no clean file-write
    # path and resorting to fragile shell heredocs.
    _scope_names = _resolve_injected_scope(tool_scope)
    if _scope_names is not None:
        _extra_tools = [fn for fn in _all_tools if fn.__name__ in _scope_names]
        if not _extra_tools:
            # Neither the scope nor the core matched any known tool (e.g. every
            # optional import above failed) — fall back to the full set.
            _log.warning(
                "executor.tool_scope_no_match",
                requested=tool_scope,
                available=[fn.__name__ for fn in _all_tools],
            )
            _extra_tools = _all_tools
    else:
        _extra_tools = _all_tools

    # Gate every injected tool with the risk-aware permission policy (B6). This
    # closes the live gap where injected function-tools (web_search, …) executed
    # on the Copilot-BYOK/streaming path bypass the SDK's on_permission_request
    # hook. functools.wraps keeps __name__/signature so name-based special-cases
    # (call_agent, ask_questions) and SDK/MAF registration are unaffected.
    if os.environ.get("AGENT_PERMISSION_MODE", "enforce").strip().lower() != (
        "approve_all"
    ):
        _extra_tools = [_gate_injected_tool(fn) for fn in _extra_tools]

    for agent in agents:
        injected = False
        _agent_label = getattr(agent, "name", None) or type(agent).__name__

        # ── GitHubCopilotAgent (agent-framework-ag-ui) ──────────────────────
        # Stores tools in self._tools (a list); fed into SessionConfig at run time.
        # Must be patched BEFORE the MAF path because GitHubCopilotAgent also
        # sets self.tools = [] (empty) via its base class — we don't want to
        # append to that empty list and skip the real _tools.
        #
        # IMPORTANT: _prepare_tools() (called at session creation) only converts
        # FunctionTool / CopilotTool / MutableMapping — plain async callables are
        # silently skipped.  We must wrap each function with normalize_tools() first
        # so the Copilot SDK actually registers them and the LLM can call them.
        try:
            if hasattr(agent, "_tools") and isinstance(agent._tools, list):
                # Try to import normalize_tools for FunctionTool wrapping.
                try:
                    from agent_framework._tools import \
                        normalize_tools as _norm  # noqa: PLC0415
                except ImportError:
                    _norm = None  # type: ignore[assignment]

                existing_names = {
                    getattr(getattr(t, "func", t), "__name__", None)
                    for t in agent._tools
                }
                # Gate the agent's OWN repo-baked tools too (B6): these execute
                # on the Copilot-BYOK path bypassing on_permission_request, and
                # they're NOT in _extra_tools, so wrapping only our injected set
                # left them ungated. Re-wrap each existing FunctionTool's .func
                # with the permission gate in place (no-op in approve_all mode).
                if _gate_on := (
                    os.environ.get("AGENT_PERMISSION_MODE", "enforce")
                    .strip().lower() != "approve_all"
                ):
                    for _t in agent._tools:
                        _orig = getattr(_t, "func", None)
                        if callable(_orig) and not getattr(
                            _orig, "__cc_gated__", False
                        ):
                            _gated = _gate_injected_tool(_orig)
                            _gated.__cc_gated__ = True  # type: ignore[attr-defined]
                            try:
                                _t.func = _gated
                            except Exception:  # noqa: BLE001 — some tools frozen
                                pass
                for fn in _extra_tools:
                    if fn.__name__ not in existing_names:
                        # Wrap as FunctionTool so _prepare_tools() picks it up.
                        wrapped = _norm([fn])[0] if _norm is not None else fn
                        agent._tools.append(wrapped)

                # Append tool guidance to the system message so the LLM knows
                # these tools exist, what they do, and what agent names are valid.
                # The agent's own instructions.md was written before CommandCenter
                # injection and has no mention of call_agent / web_search / etc.
                #
                # _default_options is a plain dict; system_message inside it has
                # the form {'mode': 'append', 'content': '<text>'}.  We must use
                # dict access (not setattr) and preserve the nested structure.
                try:
                    addendum = _build_injected_tools_addendum(is_sub_agent=is_sub_agent)
                    opts = getattr(agent, "_default_options", None)
                    if isinstance(opts, dict):
                        existing_sys = opts.get("system_message")
                        if isinstance(existing_sys, dict):
                            # Preserve mode:'append'; extend content field.
                            existing_sys["content"] = (existing_sys.get("content") or "") + addendum
                        elif isinstance(existing_sys, str):
                            opts["system_message"] = {"mode": "append", "content": existing_sys + addendum}
                        else:
                            opts["system_message"] = {"mode": "append", "content": addendum}
                except Exception:  # noqa: BLE001
                    pass

                # Neutralise the Copilot backend's infinite-session compaction so
                # it doesn't false-trip "context length exceeded" on a wrongly-small
                # assumed window for our BYOK models (see
                # _copilot_infinite_session_config). Best-effort; no-op if opted out.
                try:
                    _apply_copilot_infinite_sessions(agent)
                except Exception:  # noqa: BLE001
                    pass

                injected = True
        except Exception as _exc:  # noqa: BLE001
            _log.warning(
                "executor.tool_injection_failed",
                agent=_agent_label, shape="copilot_tools",
                error=str(_exc)[:200],
            )

        if injected:
            continue

        # ── Native agent_framework Agent (current MAF API) ──────────────────
        # The current Agent (agent_framework._agents.Agent) has no top-level
        # `.tools`; its tools live in `default_options["tools"]` (a list). MAF
        # accepts plain async callables, so append without wrapping. Used by the
        # email-assistant (a native MAF agent).
        try:
            _do = getattr(agent, "default_options", None)
            if isinstance(_do, dict) and isinstance(_do.get("tools"), list):
                existing_names = {
                    getattr(getattr(t, "func", t), "__name__", None)
                    for t in _do["tools"]
                }
                for fn in _extra_tools:
                    if fn.__name__ not in existing_names:
                        _do["tools"].append(fn)
                # Give native MAF agents the LIVE agent registry so they can
                # discover and delegate to ALL registered specialists via
                # call_agent (Copilot-SDK agents get this through the
                # system-message addendum; native MAF agents otherwise only know
                # the agents hard-named in their instructions.md, so a newly
                # registered specialist — e.g. a product-planner — is invisible).
                if not is_sub_agent and any(
                    fn.__name__ == "call_agent" for fn in _extra_tools
                ):
                    try:
                        _reg = _build_registry_block()
                        _prev = _do.get("instructions") or ""
                        if _reg and "Delegatable agents" not in _prev:
                            _do["instructions"] = (
                                _prev
                                + "\n\n## Delegatable agents (call_agent)\n"
                                "Hand off to any of these registered specialist "
                                "agents with call_agent(name, message) and use "
                                "their reply (e.g. to gather context before "
                                "drafting):\n" + _reg
                            )
                    except Exception:
                        pass
                continue
        except Exception as _exc:  # noqa: BLE001
            _log.warning(
                "executor.tool_injection_failed",
                agent=_agent_label, shape="native_maf",
                error=str(_exc)[:200],
            )

        # ── MAF Agent (agent-framework) ─────────────────────────────────────
        # agent.tools is a list[FunctionTool | callable].  MAF accepts plain
        # async functions directly, so we can append without wrapping.
        try:
            if hasattr(agent, "tools") and isinstance(agent.tools, list):
                existing_names = {
                    getattr(getattr(t, "func", t), "__name__", None)
                    for t in agent.tools
                }
                for fn in _extra_tools:
                    if fn.__name__ not in existing_names:
                        agent.tools.append(fn)
                continue
        except Exception as _exc:  # noqa: BLE001
            _log.warning(
                "executor.tool_injection_failed",
                agent=_agent_label, shape="maf_tools",
                error=str(_exc)[:200],
            )

        # ── Legacy: _default_options.tools (older Copilot SDK wrapper) ──────
        # Same wrapping requirement as _tools above: raw callables are silently
        # skipped by the SDK.  Wrap each function with normalize_tools() so they
        # appear in the session's tool schema and the LLM can call them.
        try:
            opts = getattr(agent, "_default_options", None)
            if opts is not None:
                try:
                    from agent_framework._tools import \
                        normalize_tools as _norm_legacy  # noqa: PLC0415
                except ImportError:
                    _norm_legacy = None  # type: ignore[assignment]

                existing = list(getattr(opts, "tools", []) or [])
                existing_names = {
                    getattr(getattr(fn, "func", fn), "__name__", None) for fn in existing
                }
                for fn in _extra_tools:
                    if fn.__name__ not in existing_names:
                        wrapped = _norm_legacy([fn])[0] if _norm_legacy is not None else fn
                        existing.append(wrapped)
                opts.tools = existing
                injected = True
        except Exception as _exc:  # noqa: BLE001
            _log.warning(
                "executor.tool_injection_failed",
                agent=_agent_label, shape="legacy_copilot",
                error=str(_exc)[:200],
            )

        # No agent shape matched — the agent silently got NONE of the injected
        # platform tools (call_agent / web_search / write_artifact / …). Surface
        # it so the symptom isn't just a mysteriously "missing" tool at run time.
        if not injected:
            _log.warning(
                "executor.tool_injection_no_shape_matched",
                agent=_agent_label, agent_type=type(agent).__name__,
            )


async def _inject_mcp_servers(agent: Any, agent_name: str) -> None:
    """Query the MCP server registry and inject matching servers into the agent.

    Reads the ``mcp_servers`` Postgres table, resolves any credential
    references through the Integration Registry, and merges the MCP
    server config into ``agent._default_options["mcp_servers"]``.

    Only servers whose ``agent_scope`` includes ``"*"`` or the current
    agent name are injected.

    Best-effort: failures are silently swallowed so MCP issues never
    block agent execution.
    """
    try:
        from acb_graph import get_session  # noqa: PLC0415
        from sqlalchemy import text  # noqa: PLC0415
        with get_session() as s:
            rows = s.execute(
                text("SELECT name, transport, command, url, env_vars, headers, "
                "agent_scope FROM mcp_servers WHERE enabled = true")
            ).fetchall()
    except Exception:  # noqa: BLE001
        return  # Table may not exist yet — skip gracefully

    mcp_config: dict[str, dict[str, Any]] = {}
    for r in rows:
        name, transport, command, url, env_vars, headers, scope = r
        # Check agent scope
        scope_list: list = scope if isinstance(scope, list) else (
            scope if isinstance(scope, str) else ["*"]
        )
        if isinstance(scope_list, str):
            scope_list = [scope_list]
        if "*" not in scope_list and agent_name not in scope_list:
            continue

        entry: dict[str, Any] = {"transport": transport}
        if transport == "stdio" and command:
            entry["command"] = command
            # Resolve env var values from Integration Registry
            resolved_env: dict[str, str] = {}
            raw_env = env_vars or {}
            for k, v in (raw_env if isinstance(raw_env, dict) else {}).items():
                resolved_env[k] = str(v)
            if resolved_env:
                entry["env"] = resolved_env
        elif transport == "http-sse" and url:
            entry["url"] = url
            raw_headers = headers or {}
            resolved_headers: dict[str, str] = {}
            for k, v in (raw_headers if isinstance(raw_headers, dict) else {}).items():
                resolved_headers[k] = str(v)
            if resolved_headers:
                entry["headers"] = resolved_headers
        else:
            continue

        mcp_config[name] = entry

    if not mcp_config:
        return

    # Merge into agent's default_options
    try:
        opts = getattr(agent, "_default_options", None)
        if isinstance(opts, dict):
            existing = opts.get("mcp_servers") or {}
            if isinstance(existing, dict):
                existing.update(mcp_config)
            else:
                existing = mcp_config
            opts["mcp_servers"] = existing
    except Exception:  # noqa: BLE001
        pass

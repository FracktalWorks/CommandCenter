"""Self_Mutation_Node — agents fix their own code and open GitHub PRs.

Design constraints (ADR-006, ADR-021):

- ``max_mutation_attempts = 1`` per failure event.  If a run already attempted
  mutation, subsequent errors in the same run are logged and skipped.
- The live system will **not** adopt any self-authored code change until a human
  clicks **Merge** on the PR (no auto-merge permission is granted).
- All sandbox containers are destroyed after the PR is opened or if it fails.
- The mutation is best-effort: if Docker is unavailable or no credentials are
  configured (dev environment), the telemetry payload is logged and the run
  fails gracefully.

Sandbox implementation: ``apps/orchestrator/Dockerfile.mutation`` —
a slim Python 3.12 image with ``github-copilot-sdk`` installed.
The Copilot SDK agent handles git operations, pytest, and PR creation.
BYOK is supported via the local LiteLLM proxy (set ``LITELLM_MASTER_KEY``).

Typical call site (orchestrator.executor)::

    from orchestrator.mutation import attempt_self_mutation

    result = await attempt_self_mutation(
        agent_name="task-manager",
        run_id=run_id,
        error=exc,
    )
    if result.pr_url:
        print(f"Self-mutation PR opened: {result.pr_url}")
"""
from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any

from acb_audit import AuditEvent, record
from acb_common import get_logger, get_settings

_log = get_logger("orchestrator.mutation")

MAX_MUTATION_ATTEMPTS: int = 1  # ADR-021: exactly one PR per failure event


# ---------------------------------------------------------------------------
# Public data types
# ---------------------------------------------------------------------------

@dataclass
class MutationResult:
    agent_name: str
    run_id: str
    attempted: bool
    pr_url: str | None = None
    skipped_reason: str | None = None
    sandbox_conversation_id: str | None = None


# ---------------------------------------------------------------------------
# Public entry point
# ---------------------------------------------------------------------------

async def attempt_self_mutation(
    agent_name: str,
    run_id: str,
    error: Exception,
    *,
    mutation_attempts: int = 0,
    agent_dir: str | None = None,
    incompatibility: bool = False,
) -> MutationResult:
    """Attempt to fix a failing agent using an isolated Copilot SDK sandbox.

    Spawns a detached Docker container (``acb-mutation-runner``) that runs the
    Copilot SDK agent against the agent's local clone.  The container handles
    ``pytest``, ``git commit``, ``git push``, and PR creation autonomously.

    Args:
        agent_name:       e.g. ``"task-manager"``
        run_id:           The failing run's unique ID (used for branch naming).
        error:            The exception that caused the failure.
        mutation_attempts: How many times mutation has already been attempted
                          in this run (caller tracks this; executor passes 0).
        agent_dir:        Absolute path to the persistent local clone of the
                          agent repo (from :attr:`LoadedAgent.agent_dir`).
                          Mounted read-write into the container at
                          ``/workspace/repo``.
        incompatibility:  When ``True``, the failure is a structural
                          incompatibility (missing ``agents.py``, empty
                          ``tools=[]``, LangGraph remnant, etc.) rather than a
                          runtime error.  The sandbox receives a targeted prompt
                          referencing ``agent_repo_compatibility.md`` and is
                          asked to generate a compliant ``agents.py``.

    Returns:
        A :class:`MutationResult` describing what happened.
    """
    if mutation_attempts >= MAX_MUTATION_ATTEMPTS:
        reason = (
            f"max_mutation_attempts={MAX_MUTATION_ATTEMPTS} already reached. "
            "A human must merge the pending PR before the live system can retry."
        )
        _log.info(
            "mutation.skipped",
            agent=agent_name,
            run_id=run_id,
            reason=reason,
        )
        return MutationResult(
            agent_name=agent_name,
            run_id=run_id,
            attempted=False,
            skipped_reason=reason,
        )

    settings = get_settings()
    error_text = f"{type(error).__name__}: {error}"
    short_run = run_id[:8]

    _log.info(
        "mutation.start",
        agent=agent_name,
        run_id=run_id,
        error=error_text[:200],
    )

    record(
        AuditEvent(
            actor="system:mutation",
            action="mutation_start",
            target=f"agent:{agent_name}",
            payload={"run_id": run_id, "error": error_text[:500]},
        )
    )

    telemetry = _build_telemetry(agent_name, run_id, short_run, error_text, settings, agent_dir=agent_dir, incompatibility=incompatibility)
    branch_pushed, test_summary, conversation_id = await _run_mutation_sandbox(
        agent_name, run_id, short_run, telemetry, settings
    )

    # Open a GitHub PR from the pushed fix branch (WBS 1.3). The live system
    # does not adopt the change until a human merges — no auto-merge permission.
    pr_url: str | None = None
    if branch_pushed and getattr(settings, "mutation_auto_pr", True):
        pr_url = await _open_pull_request(agent_name, telemetry, settings, test_summary)

    record(
        AuditEvent(
            actor="system:mutation",
            action="mutation_pr_opened" if pr_url else "mutation_sandbox_failed",
            target=f"agent:{agent_name}",
            payload={
                "run_id": run_id,
                "pr_url": pr_url,
                "branch": telemetry["branch_name"],
                "branch_pushed": branch_pushed,
                "test_summary": test_summary,
                "error_type": type(error).__name__,
                "conversation_id": conversation_id,
            },
        )
    )

    return MutationResult(
        agent_name=agent_name,
        run_id=run_id,
        attempted=True,
        pr_url=pr_url,
        sandbox_conversation_id=conversation_id,
    )


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

def _build_telemetry(
    agent_name: str,
    run_id: str,
    short_run: str,
    error_text: str,
    settings: Any,
    *,
    agent_dir: str | None = None,
    incompatibility: bool = False,
) -> dict[str, Any]:
    """Assemble the failure context injected into the Copilot SDK sandbox."""
    org = getattr(settings, "github_org", "FracktalWorks")
    bot_name = getattr(settings, "github_bot_name", "commandcenter-bot")
    bot_email = getattr(settings, "github_bot_email", "") or f"{bot_name}@users.noreply.github.com"

    # Locate the agent_repo_compatibility.md guide to embed in incompatibility prompts
    compat_guide: str = ""
    if incompatibility:
        from pathlib import Path
        for candidate in Path(__file__).parents:
            guide = candidate / "ai-company-brain" / "agent_repo_compatibility.md"
            if guide.exists():
                compat_guide = guide.read_text(encoding="utf-8", errors="replace")
                break

    return {
        "agent_name": agent_name,
        "run_id": run_id,
        "short_run": short_run,
        "error": error_text,
        "repo_url": f"https://github.com/{org}/agent-{agent_name}",
        "branch_name": f"auto-fix/{short_run}",
        "pr_title": f"Auto-fix: {error_text[:72]}",
        # Persistent local clone — already authenticated + bot identity set
        "local_clone_dir": agent_dir,
        "bot_name": bot_name,
        "bot_email": bot_email,
        "incompatibility": incompatibility,
        "compat_guide": compat_guide,
    }


def _build_mutation_prompt(telemetry: dict[str, Any]) -> str:
    """Format the natural-language instruction sent to the Copilot SDK sandbox agent."""
    if telemetry.get("incompatibility"):
        return _build_incompatibility_prompt(telemetry)
    return _build_runtime_fix_prompt(telemetry)


def _build_incompatibility_prompt(telemetry: dict[str, Any]) -> str:
    """Prompt for structural incompatibilities — generates a compliant agents.py."""
    repo = telemetry["local_clone_dir"] or telemetry["repo_url"]
    guide = telemetry.get("compat_guide", "")
    guide_section = (
        f"\n## CommandCenter Agent Compatibility Guide\n\n{guide}\n"
        if guide else ""
    )
    return (
        f"You are a senior Python engineer tasked with making an agent repository "
        f"compatible with CommandCenter.\n\n"
        f"## Repository\n"
        f"Path: `{repo}`\n"
        f"Remote: {telemetry['repo_url']}\n\n"
        f"## Incompatibility detected\n"
        f"```\n{telemetry['error']}\n```\n\n"
        f"## Your task\n"
        f"1. `cd {repo}` and inspect the repository structure.\n"
        f"2. Read the compatibility guide below to understand what CommandCenter requires.\n"
        f"3. Create or fix `agents.py` at the repo root so that:\n"
        f"   a. It exports `build_agents() -> list[Agent]` (synchronous, zero-arg, pure).\n"
        f"   b. `GitHubCopilotAgent` is instantiated inside `build_agents()` only.\n"
        f"   c. `tools=[...]` is populated with async tool functions that call the "
        f"existing scripts in `skills/*/scripts/` and `scripts/` via subprocess or direct import.\n"
        f"   d. The system prompt is built from `prompts/system.md` + all `skills/*/SKILL.md`.\n"
        f"   e. **`graph.py` is left untouched** — only `agents.py` is created/modified.\n"
        f"4. Scan ALL `skills/*/scripts/*.py` files. Every script whose stem does not "
        f"already appear in `agents.py` must be added as an `async def` tool function.\n"
        f"5. Run `python -c \"from agents import build_agents; agents = build_agents(); "
        f"assert agents\"` to verify.\n"
        f"6. Run `pytest` if a `tests/` directory exists.\n"
        f"7. Create the fix branch: `git checkout -b {telemetry['branch_name']}`\n"
        f"8. `git add agents.py` and commit:\n"
        f"   `git commit -m 'fix: generate compliant agents.py for CommandCenter'`\n"
        f"9. `git push origin {telemetry['branch_name']}` to push the fix branch.\n\n"
        f"**Commit author:** `{telemetry['bot_name']}` <`{telemetry['bot_email']}`>\n"
        f"**Push the branch `{telemetry['branch_name']}`. The orchestrator opens the PR — do NOT create one yourself.**\n"
        f"{guide_section}"
    )


def _build_runtime_fix_prompt(telemetry: dict[str, Any]) -> str:
    """Prompt for runtime errors — finds and patches the root cause."""
    if telemetry.get("local_clone_dir"):
        repo_section = (
            f"## Repository (local clone — already authenticated)\n"
            f"Path: `{telemetry['local_clone_dir']}`\n"
            f"Remote: {telemetry['repo_url']}\n\n"
            f"The repository is already cloned at the path above. "
            f"Git user identity is already configured.\n\n"
            f"**Do NOT re-clone.** Work directly from the local clone.\n"
        )
        cd_step = f"1. `cd {telemetry['local_clone_dir']}` and `git pull --ff-only`."
    else:
        repo_section = (
            f"## Repository\n{telemetry['repo_url']}\n\n"
            f"Configure git identity before committing:\n"
            f"```\ngit config user.name \"{telemetry['bot_name']}\"\n"
            f"git config user.email \"{telemetry['bot_email']}\"\n```\n"
        )
        cd_step = f"1. Clone from `{telemetry['repo_url']}` and configure bot identity."

    return (
        f"You are orchestrating a two-phase code repair using researcher and editor sub-agents.\n\n"
        f"{repo_section}\n"
        f"## Error\n```\n{telemetry['error']}\n```\n\n"
        f"## Sub-agent workflow\n"
        f"### Phase 1 — Researcher (read-only)\n"
        f"{cd_step}\n"
        f"Use grep/view tools to:\n"
        f"  a. Understand the repo structure\n"
        f"  b. Identify the root cause of the error\n"
        f"  c. Find all files that need changing\n"
        f"  d. Write a precise fix plan before touching anything\n\n"
        f"### Phase 2 — Editor (minimal write)\n"
        f"Execute ONLY the fix plan from Phase 1:\n"
        f"  a. Make minimal, correct changes\n"
        f"  b. Run `pytest` — all tests must pass. Capture the summary line.\n"
        f"  c. Create the fix branch: `git checkout -b {telemetry['branch_name']}`\n"
        f"  d. `git add -A` and commit: `git commit -m 'fix: <short description>'`\n"
        f"  e. `git push origin {telemetry['branch_name']}` — push the branch.\n"
        f"  f. Print a final line `TEST_SUMMARY: <pytest summary>` so the orchestrator can record it.\n\n"
        f"**Safety rules:**\n"
        f"- Never write without first completing Phase 1 analysis\n"
        f"- Minimal fix only — do not refactor unrelated code\n"
        f"- Commit author: `{telemetry['bot_name']}` <`{telemetry['bot_email']}`>\n"
        f"- Push the fix branch `{telemetry['branch_name']}`. The orchestrator opens the PR — do NOT create one yourself.\n"
    )


async def _run_mutation_sandbox(
    agent_name: str,
    run_id: str,
    short_run: str,
    telemetry: dict[str, Any],
    settings: Any,
) -> tuple[bool, str, str | None]:
    """Spawn an isolated Copilot SDK container and wait for it to finish.

    The container makes the fix, runs pytest, and pushes the fix branch
    ``auto-fix/{short_run}``.  It prints a JSON result line
    (``{"pr_url": ..., "success": bool}``) and, on success, a
    ``TEST_SUMMARY: ...`` line to stdout.

    Returns ``(branch_pushed, test_summary, container_id)``.  Returns
    ``(False, "", None)`` and logs the prompt if Docker/credentials are
    unavailable so the system degrades gracefully in dev.
    """
    import asyncio

    github_token: str | None = getattr(settings, "github_token", None) or None
    litellm_key: str | None = getattr(settings, "litellm_master_key", None) or None
    litellm_url: str = getattr(settings, "litellm_base_url", "http://host.docker.internal:4000")
    mutation_model: str = getattr(settings, "mutation_model", "openai/tier3-opus")
    sandbox_image: str = getattr(settings, "mutation_sandbox_image", "acb-mutation-runner:latest")
    timeout_s: int = int(getattr(settings, "mutation_timeout_seconds", 600))
    agent_dir: str | None = telemetry.get("local_clone_dir")

    if not github_token and not litellm_key:
        _log.warning(
            "mutation.sandbox_not_configured",
            agent=agent_name,
            run_id=run_id,
            hint="Set GITHUB_TOKEN or LITELLM_MASTER_KEY to enable live self-mutation.",
        )
        _log.info(
            "mutation.manual_prompt",
            agent=agent_name,
            run_id=run_id,
            prompt=_build_mutation_prompt(telemetry),
        )
        return False, "", None

    prompt = _build_mutation_prompt(telemetry)

    # Run in the foreground (no -d) so we can capture stdout and learn whether
    # the fix branch was pushed.  --rm cleans the container up on exit.
    docker_cmd = [
        "docker", "run",
        "--rm",
        "--name", f"acb-mutation-{short_run}",
        "-e", f"MUTATION_PROMPT={prompt}",
        "-e", f"MUTATION_TELEMETRY_JSON={json.dumps(telemetry)}",
        "-e", f"COPILOT_GITHUB_TOKEN={github_token or ''}",
        "-e", f"LITELLM_API_KEY={litellm_key or ''}",
        "-e", f"LITELLM_BASE_URL={litellm_url}",
        "-e", f"LITELLM_MODEL={mutation_model}",
        "--add-host", "host.docker.internal:host-gateway",
    ]

    if agent_dir:
        docker_cmd += ["-v", f"{agent_dir}:/workspace/repo"]

    docker_cmd.append(sandbox_image)

    try:
        proc = await asyncio.create_subprocess_exec(
            *docker_cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        try:
            stdout_bytes, stderr_bytes = await asyncio.wait_for(
                proc.communicate(), timeout=timeout_s
            )
        except TimeoutError:
            proc.kill()
            await _docker_kill(short_run)
            _log.error(
                "mutation.sandbox_timeout",
                agent=agent_name,
                run_id=run_id,
                timeout_s=timeout_s,
            )
            return False, "", None

        stdout = stdout_bytes.decode(errors="replace").strip()
        stderr = stderr_bytes.decode(errors="replace").strip()

        # The runner prints a JSON result line; success means the fix ran and
        # the branch was pushed.
        success = False
        for line in reversed(stdout.splitlines()):
            line = line.strip()
            if line.startswith("{") and line.endswith("}"):
                try:
                    parsed = json.loads(line)
                    success = bool(parsed.get("success"))
                    break
                except json.JSONDecodeError:
                    continue

        test_summary = ""
        for line in stdout.splitlines():
            if line.startswith("TEST_SUMMARY:"):
                test_summary = line.split("TEST_SUMMARY:", 1)[1].strip()
                break

        if proc.returncode != 0 and not success:
            _log.error(
                "mutation.sandbox_failed",
                agent=agent_name,
                run_id=run_id,
                returncode=proc.returncode,
                stderr=stderr[:500],
            )
            return False, test_summary, None

        _log.info(
            "mutation.sandbox_done",
            agent=agent_name,
            run_id=run_id,
            branch=telemetry["branch_name"],
            test_summary=test_summary[:200],
        )
        return success, test_summary, f"acb-mutation-{short_run}"

    except Exception as exc:
        _log.error(
            "mutation.docker_error",
            agent=agent_name,
            run_id=run_id,
            error=str(exc),
        )
        return False, "", None


async def _docker_kill(short_run: str) -> None:
    """Best-effort kill of a hung mutation container."""
    import asyncio

    try:
        proc = await asyncio.create_subprocess_exec(
            "docker", "kill", f"acb-mutation-{short_run}",
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.DEVNULL,
        )
        await proc.communicate()
    except Exception:
        pass


async def _open_pull_request(
    agent_name: str,
    telemetry: dict[str, Any],
    settings: Any,
    test_summary: str,
) -> str | None:
    """Open a GitHub PR from the pushed fix branch via the REST API.

    The branch ``auto-fix/{short_run}`` is pushed by the sandbox container.
    This opens a PR ``auto-fix/{short_run}`` → ``main`` with the failure
    telemetry, the error, and the pytest summary as the body.  No auto-merge
    permission is requested — a human must click **Merge** (PR-05).

    Returns the PR URL, or ``None`` if the API call fails (e.g. no token).
    """
    import httpx

    github_token: str = getattr(settings, "github_token", "") or ""
    org: str = getattr(settings, "github_org", "FracktalWorks")
    if not github_token:
        _log.warning("mutation.pr_no_token", agent=agent_name)
        return None

    repo = f"agent-{agent_name}"
    branch = telemetry["branch_name"]
    title = telemetry["pr_title"]
    body = (
        f"## Auto-fix proposed by `Self_Mutation_Node`\n\n"
        f"**Agent:** `{agent_name}`  ·  **Run:** `{telemetry['run_id']}`\n\n"
        f"### Failure\n```\n{telemetry['error']}\n```\n\n"
        f"### Test results\n```\n{test_summary or 'see CI eval gate'}\n```\n\n"
        f"---\n"
        f"This PR was opened automatically as an audit record. "
        f"`max_mutation_attempts = 1` — no second PR will be opened for this failure. "
        f"A human must review and **Merge** before the fix is adopted.\n"
    )

    url = f"https://api.github.com/repos/{org}/{repo}/pulls"
    headers = {
        "Authorization": f"Bearer {github_token}",
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
    }
    payload = {"title": title, "head": branch, "base": "main", "body": body}

    try:
        async with httpx.AsyncClient(timeout=30) as client:
            resp = await client.post(url, headers=headers, json=payload)
        if resp.status_code in (200, 201):
            pr_url = resp.json().get("html_url")
            _log.info("mutation.pr_opened", agent=agent_name, pr_url=pr_url)
            return pr_url
        # 422 commonly means a PR already exists for this branch — surface it.
        if resp.status_code == 422:
            existing = await _find_existing_pr(client_org=org, repo=repo, branch=branch, headers=headers)
            if existing:
                return existing
        _log.error(
            "mutation.pr_failed",
            agent=agent_name,
            status=resp.status_code,
            detail=resp.text[:300],
        )
        return None
    except Exception as exc:
        _log.error("mutation.pr_error", agent=agent_name, error=str(exc))
        return None


async def _find_existing_pr(
    *, client_org: str, repo: str, branch: str, headers: dict[str, str]
) -> str | None:
    """Return the URL of an open PR for ``branch`` if one already exists."""
    import httpx

    url = f"https://api.github.com/repos/{client_org}/{repo}/pulls"
    params = {"head": f"{client_org}:{branch}", "state": "open"}
    try:
        async with httpx.AsyncClient(timeout=20) as client:
            resp = await client.get(url, headers=headers, params=params)
        if resp.status_code == 200 and resp.json():
            return resp.json()[0].get("html_url")
    except Exception:
        pass
    return None


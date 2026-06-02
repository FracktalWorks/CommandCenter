"""Self_Mutation_Node — agents fix their own code and open GitHub PRs.

Design constraints (ADR-006, ADR-021):

- ``max_mutation_attempts = 1`` per failure event.  If a run already attempted
  mutation, subsequent errors in the same run are logged and skipped.
- The live system will **not** adopt any self-authored code change until a human
  clicks **Merge** on the PR (no auto-merge permission is granted).
- All sandbox containers are destroyed after the PR is opened or if it fails.
- The mutation is best-effort: if OpenHands is not configured (dev environment),
  the telemetry payload is logged and the run fails gracefully.

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
from dataclasses import dataclass, field
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
) -> MutationResult:
    """Attempt to fix a failing agent by provisioning an OpenHands dev sandbox.

    Args:
        agent_name:         e.g. ``"task-manager"``
        run_id:             The failing run's unique ID (used for branch naming).
        error:              The exception that caused the failure.
        mutation_attempts:  How many times mutation has already been attempted
                            in this run (caller tracks this; executor passes 0).
        agent_dir:          Absolute path to the persistent local clone of the
                            agent repo (from :attr:`LoadedAgent.agent_dir`).
                            When provided, the sandbox works from this clone
                            (already authenticated + bot identity configured)
                            rather than doing a fresh ``git clone``.

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

    telemetry = _build_telemetry(agent_name, run_id, short_run, error_text, settings, agent_dir=agent_dir)
    pr_url, conversation_id = await _run_mutation_sandbox(
        agent_name, run_id, short_run, telemetry, settings
    )

    record(
        AuditEvent(
            actor="system:mutation",
            action="mutation_pr_opened" if pr_url else "mutation_sandbox_failed",
            target=f"agent:{agent_name}",
            payload={
                "run_id": run_id,
                "pr_url": pr_url,
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
) -> dict[str, Any]:
    """Assemble the failure context that is injected into the OpenHands sandbox."""
    org = getattr(settings, "github_org", "FracktalWorks")
    langfuse_host = getattr(settings, "langfuse_host", "")
    bot_name = getattr(settings, "github_bot_name", "jannet-bot")
    bot_email = getattr(settings, "github_bot_email", "") or f"{bot_name}@users.noreply.github.com"

    return {
        "agent_name": agent_name,
        "run_id": run_id,
        "short_run": short_run,
        "error": error_text,
        "repo_url": f"https://github.com/{org}/agent-{agent_name}",
        "branch_name": f"auto-fix/{short_run}",
        "pr_title": f"Auto-fix: {error_text[:72]}",
        "langfuse_trace_url": (
            f"{langfuse_host}/traces?search={run_id}" if langfuse_host else None
        ),
        # Persistent local clone — already authenticated + bot identity set
        "local_clone_dir": agent_dir,
        "bot_name": bot_name,
        "bot_email": bot_email,
    }


def _build_mutation_prompt(telemetry: dict[str, Any]) -> str:
    """Format the natural-language instruction sent to the OpenHands sandbox agent."""
    trace_line = (
        f"Langfuse trace: {telemetry['langfuse_trace_url']}"
        if telemetry.get("langfuse_trace_url")
        else "No trace URL available."
    )

    if telemetry.get("local_clone_dir"):
        repo_section = (
            f"## Repository (local clone — already authenticated)\n"
            f"Path: `{telemetry['local_clone_dir']}`\n"
            f"Remote: {telemetry['repo_url']}\n\n"
            f"The repository is already cloned at the path above.  The remote URL\n"
            f"already contains valid auth credentials.  Git user identity is already\n"
            f"configured (`{telemetry['bot_name']}` <`{telemetry['bot_email']}`>).\n\n"
            f"**Do NOT re-clone.** Work directly from the local clone.\n"
        )
        clone_step = f"1. `cd {telemetry['local_clone_dir']}` and `git pull --ff-only` to ensure you are on latest main."
    else:
        repo_section = (
            f"## Repository\n{telemetry['repo_url']}\n\n"
            f"Configure git identity before committing:\n"
            f"```\ngit config user.name \"{telemetry['bot_name']}\"\n"
            f"git config user.email \"{telemetry['bot_email']}\"\n```\n"
        )
        clone_step = f"1. Clone the repository from `{telemetry['repo_url']}` and configure bot identity as shown above."

    return (
        f"You are a senior Python engineer tasked with fixing a bug in the "
        f"agent repository below.\n\n"
        f"{repo_section}\n"
        f"## Error\n```\n{telemetry['error']}\n```\n\n"
        f"## Trace\n{trace_line}\n\n"
        f"## Your task\n"
        f"{clone_step}\n"
        f"2. Identify the root cause of the error above.\n"
        f"3. Write a **minimal, correct fix**.\n"
        f"4. Run `pytest` — all tests must pass.\n"
        f"5. Commit the fix to a new branch named `{telemetry['branch_name']}`.\n"
        f"6. `git push origin {telemetry['branch_name']}` (the remote URL already has auth).\n"
        f"7. Open a GitHub Pull Request titled:\n"
        f"   `{telemetry['pr_title']}`\n"
        f"8. Include the full error, your root-cause analysis, and the diff in "
        f"the PR body.\n\n"
        f"**Commit author must be:** `{telemetry['bot_name']}` <`{telemetry['bot_email']}`>\n"
        f"**Do NOT merge the PR.** A human must review and merge it.\n"
        f"**Do NOT open more than one PR.**\n"
    )


async def _run_mutation_sandbox(
    agent_name: str,
    run_id: str,
    short_run: str,
    telemetry: dict[str, Any],
    settings: Any,
) -> tuple[str | None, str | None]:
    """Provision an OpenHands dev sandbox and return (pr_url, conversation_id).

    If ``OPENHANDS_API_URL`` is not set the function logs the prompt and
    returns ``(None, None)`` so the system degrades gracefully in dev.
    """
    openhands_url: str | None = getattr(settings, "openhands_api_url", None) or None
    github_token: str | None = getattr(settings, "github_token", None) or None

    if not openhands_url:
        _log.warning(
            "mutation.openhands_not_configured",
            agent=agent_name,
            run_id=run_id,
            hint="Set OPENHANDS_API_URL in .env to enable live self-mutation.",
        )
        # Log the full prompt so developers can run it manually during development
        _log.info(
            "mutation.manual_prompt",
            agent=agent_name,
            run_id=run_id,
            prompt=_build_mutation_prompt(telemetry),
        )
        return None, None

    try:
        import httpx  # noqa: PLC0415

        prompt = _build_mutation_prompt(telemetry)
        async with httpx.AsyncClient(timeout=300) as client:
            resp = await client.post(
                f"{openhands_url}/api/conversations",
                json={
                    "initial_user_msg": prompt,
                    "github_token": github_token or "",
                },
            )
            resp.raise_for_status()
            data = resp.json()

        conversation_id: str | None = data.get("conversation_id")
        _log.info(
            "mutation.sandbox_started",
            agent=agent_name,
            run_id=run_id,
            conversation_id=conversation_id,
        )

        # OpenHands delivers the PR URL asynchronously via its final message.
        # We return the conversation URL as a proxy; a Phase-2 webhook handler
        # will update the audit log with the actual GitHub PR URL when it arrives.
        proxy_url = f"{openhands_url}/conversations/{conversation_id}" if conversation_id else None
        return proxy_url, conversation_id

    except Exception as exc:  # noqa: BLE001
        _log.error(
            "mutation.sandbox_error",
            agent=agent_name,
            run_id=run_id,
            error=str(exc),
        )
        return None, None

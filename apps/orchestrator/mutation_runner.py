"""Mutation sandbox runner — executed inside the Copilot SDK Docker container.

Env vars (set by orchestrator.mutation._run_mutation_sandbox):
    MUTATION_PROMPT         Full task prompt for the coding agent.
    COPILOT_GITHUB_TOKEN    GitHub OAuth token (standard Copilot auth).
    LITELLM_API_KEY         BYOK key for LiteLLM proxy (preferred over GitHub token).
    LITELLM_BASE_URL        LiteLLM proxy base URL (e.g. http://host.docker.internal:4000).
    LITELLM_MODEL           Model name (e.g. openai/tier3-opus).

The agent repo is expected to be mounted at /workspace/repo (read-write).

Writes to stdout: JSON object {"pr_url": "...", "success": true/false}.
Exits 0 when a PR URL is found in the session output, 1 otherwise.
"""
from __future__ import annotations

import asyncio
import json
import os
import re
import sys

_GITHUB_PR_RE = re.compile(r"https://github\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+/pull/\d+")


async def main() -> None:
    prompt = os.environ.get("MUTATION_PROMPT", "").strip()
    if not prompt:
        _die("MUTATION_PROMPT is not set")

    litellm_key = os.environ.get("LITELLM_API_KEY", "").strip()
    litellm_url = os.environ.get("LITELLM_BASE_URL", "").strip()
    litellm_model = os.environ.get("LITELLM_MODEL", "openai/tier3-opus").strip()
    github_token = os.environ.get("COPILOT_GITHUB_TOKEN", "").strip()

    if not litellm_key and not github_token:
        _die("No auth configured: set LITELLM_API_KEY+LITELLM_BASE_URL or COPILOT_GITHUB_TOKEN")

    from copilot import CopilotClient  # noqa: PLC0415
    from copilot.session import PermissionHandler  # noqa: PLC0415
    from copilot.session_events import AssistantMessageData, SessionIdleData  # noqa: PLC0415

    client_kwargs: dict = {}
    session_kwargs: dict = {
        "on_permission_request": PermissionHandler.approve_all,
        "model": litellm_model,
    }

    repo_dir = "/workspace/repo"
    if os.path.isdir(repo_dir):
        client_kwargs["working_directory"] = repo_dir

    if litellm_key and litellm_url:
        session_kwargs["provider"] = {
            "type": "openai",
            "base_url": litellm_url,
            "api_key": litellm_key,
        }
    else:
        client_kwargs["github_token"] = github_token

    messages: list[str] = []
    pr_url: str | None = None
    done = asyncio.Event()

    async with CopilotClient(**client_kwargs) as client:
        async with await client.create_session(**session_kwargs) as session:

            def on_event(event) -> None:  # noqa: ANN001
                nonlocal pr_url
                match event.data:
                    case AssistantMessageData() as data:
                        messages.append(data.content)
                        if not pr_url:
                            m = _GITHUB_PR_RE.search(data.content)
                            if m:
                                pr_url = m.group(0)
                    case SessionIdleData():
                        done.set()

            session.on(on_event)
            await session.send(prompt)
            await done.wait()

    # Final scan across all captured messages in case PR URL appeared mid-conversation.
    if not pr_url:
        for msg in messages:
            m = _GITHUB_PR_RE.search(msg)
            if m:
                pr_url = m.group(0)
                break

    result = {"pr_url": pr_url, "success": pr_url is not None}
    print(json.dumps(result), flush=True)
    sys.exit(0 if pr_url else 1)


def _die(msg: str) -> None:
    print(f"ERROR: {msg}", file=sys.stderr, flush=True)
    sys.exit(1)


if __name__ == "__main__":
    asyncio.run(main())

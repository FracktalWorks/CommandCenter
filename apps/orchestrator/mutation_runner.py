"""Mutation sandbox runner — executed inside the Copilot SDK Docker container.

Env vars (set by orchestrator.mutation._run_mutation_sandbox):
    MUTATION_PROMPT         Full task prompt for the coding agent.
    COPILOT_GITHUB_TOKEN    GitHub OAuth token (standard Copilot auth).
    GATEWAY_API_KEY         API key for the gateway's /v1 endpoint.
    GATEWAY_BASE_URL        Gateway base URL (e.g. http://host.docker.internal:8080).
    GATEWAY_MODEL           Model name (e.g. openai/tier3-opus).

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

    gateway_key = os.environ.get("GATEWAY_API_KEY", "").strip()
    gateway_url = os.environ.get("GATEWAY_BASE_URL", "").strip()
    gateway_model = os.environ.get("GATEWAY_MODEL", "openai/tier3-opus").strip()
    github_token = os.environ.get("COPILOT_GITHUB_TOKEN", "").strip()

    if not gateway_key and not github_token:
        _die("No auth configured: set GATEWAY_API_KEY+GATEWAY_BASE_URL or COPILOT_GITHUB_TOKEN")

    from copilot import CopilotClient  # noqa: PLC0415
    from copilot.client import SessionConfig  # noqa: PLC0415
    from copilot.types import CopilotClientOptions, PermissionHandler  # noqa: PLC0415
    from copilot.generated.session_events import SessionEventType  # noqa: PLC0415

    client_options: CopilotClientOptions = {}
    session_config_kwargs: dict = {
        "on_permission_request": PermissionHandler.approve_all,
        "model": gateway_model,
    }

    repo_dir = "/workspace/repo"
    if os.path.isdir(repo_dir):
        client_options["cwd"] = repo_dir

    if gateway_key and gateway_url:
        session_config_kwargs["provider"] = {
            "type": "openai",
            "base_url": f"{gateway_url.rstrip('/')}/v1",
            "api_key": gateway_key,
        }
    else:
        client_options["github_token"] = github_token

    messages: list[str] = []
    pr_url: str | None = None
    done = asyncio.Event()

    client = CopilotClient(client_options if client_options else None)
    await client.start()
    try:
        session_cfg = SessionConfig(**session_config_kwargs)
        session = await client.create_session(session_cfg)

        def on_event(event) -> None:  # noqa: ANN001
            nonlocal pr_url
            if event.type == SessionEventType.ASSISTANT_MESSAGE:
                content = event.data.content or ""
                messages.append(content)
                if not pr_url:
                    m = _GITHUB_PR_RE.search(content)
                    if m:
                        pr_url = m.group(0)
            elif event.type == SessionEventType.SESSION_IDLE:
                done.set()

        session.on(on_event)
        await session.send({"prompt": prompt})
        await done.wait()
    finally:
        await client.stop()

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

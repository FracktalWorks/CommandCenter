"""write_artifact — agent tool for writing files to a session workspace.

Auto-injected into every agent alongside ``web_search`` and ``call_agent``.

The tool:
1. Writes the file under ``{workspace_root}/{path}`` (creating parent dirs).
2. Computes a SHA-256 hash of the content.
3. Emits an AG-UI ``CUSTOM`` event ``artifact_created`` / ``artifact_updated``
   so the Control Plane sidebar updates in real time.
4. PATCHes the gateway to register the workspace root on the session (first write).

Usage by agents:
    result = await write_artifact("reports/summary.md", "# Sales Summary\\n...")
    result = await write_artifact("scripts/ingest.py", code_bytes, encoding=None)
"""
from __future__ import annotations

import hashlib
import mimetypes
import os
import stat
from datetime import datetime, timezone
from pathlib import Path

_WRITE_ARTIFACT_CONTEXT: dict[str, str] = {}
"""
Thread/coroutine-local store keyed by session_id, set by the executor
before each agent run::

    _WRITE_ARTIFACT_CONTEXT["session_id"] = session_id
    _WRITE_ARTIFACT_CONTEXT["workspace_root"] = "/tmp/acb_agents/repos/agent-sales-assistant"
    _WRITE_ARTIFACT_CONTEXT["gateway_url"] = "http://127.0.0.1:8000"
    _WRITE_ARTIFACT_CONTEXT["gateway_token"] = "sk-local-dev-..."

The executor clears this after each run.
"""


def _sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


async def write_artifact(
    path: str,
    content: str | bytes,
    *,
    encoding: str | None = "utf-8",
) -> dict:
    """Write a file to the agent's workspace and surface it in the UI file browser.

    Call this any time you generate a document, report, script, spreadsheet,
    PDF, image, or any other file that the operator should be able to view or
    download from the Control Plane.

    Args:
        path:     Relative file path within the workspace, e.g.
                  ``"reports/q2_summary.md"`` or ``"scripts/ingest.py"``.
                  Parent directories are created automatically.
        content:  File content — either a ``str`` (written with *encoding*)
                  or ``bytes`` (written as-is; set *encoding* to ``None``).
        encoding: Text encoding for ``str`` content.  Default ``"utf-8"``.
                  Pass ``None`` when *content* is already ``bytes``.

    Returns:
        ``{"path": str, "size": int, "sha256": str}``

    Examples:
        # Markdown report
        await write_artifact("reports/summary.md", "# Summary\\n...")

        # Python script
        await write_artifact("scripts/fetch_leads.py", python_code)

        # Raw bytes (PDF, image, etc.)
        await write_artifact("exports/report.pdf", pdf_bytes, encoding=None)
    """
    import asyncio  # noqa: PLC0415

    workspace_root = _WRITE_ARTIFACT_CONTEXT.get("workspace_root")
    session_id = _WRITE_ARTIFACT_CONTEXT.get("session_id")
    gateway_url = _WRITE_ARTIFACT_CONTEXT.get("gateway_url", "http://127.0.0.1:8000")
    gateway_token = _WRITE_ARTIFACT_CONTEXT.get("gateway_token", "sk-local-dev-change-me")

    if not workspace_root:
        # Fallback: write to a temp dir per session
        import tempfile  # noqa: PLC0415
        workspace_root = str(Path(tempfile.gettempdir()) / "acb_artifacts" / (session_id or "unknown"))
        _WRITE_ARTIFACT_CONTEXT["workspace_root"] = workspace_root

    root = Path(workspace_root)
    # Sanitise path — strip leading slashes/dots to prevent traversal
    clean_path = path.replace("\\", "/").lstrip("/.")
    target = root / clean_path

    # Ensure parent directory exists
    target.parent.mkdir(parents=True, exist_ok=True)

    # Write file
    if isinstance(content, str):
        data = content.encode(encoding or "utf-8")
    else:
        data = bytes(content)

    target.write_bytes(data)
    digest = _sha256(data)
    size = len(data)

    mime, _ = mimetypes.guess_type(target.name)
    mime = mime or "application/octet-stream"

    # Build artifact entry
    artifact = {
        "path": clean_path,
        "name": target.name,
        "size": size,
        "sha256": digest,
        "mime_type": mime,
        "modified_at": datetime.now(tz=timezone.utc).isoformat(),
        "is_dir": False,
    }

    # Fire-and-forget: emit AG-UI CUSTOM event into the active SSE stream
    # (via _active_run_queue context var set by the executor) and also
    # register the workspace path on the session via the gateway.
    asyncio.ensure_future(_notify(
        session_id=session_id,
        workspace_root=workspace_root,
        artifact=artifact,
        gateway_url=gateway_url,
        gateway_token=gateway_token,
    ))

    return {"path": clean_path, "size": size, "sha256": digest}


async def _notify(
    *,
    session_id: str | None,
    workspace_root: str,
    artifact: dict,
    gateway_url: str,
    gateway_token: str,
) -> None:
    """Background task: push CUSTOM SSE event into the active run queue AND
    register workspace on the gateway.  Non-fatal — all errors are swallowed.
    """
    # 1. Push AG-UI CUSTOM event into the active executor SSE queue so the
    #    frontend receives it immediately as part of the existing chat stream.
    try:
        from orchestrator.executor import _active_run_queue  # noqa: PLC0415
        queue = _active_run_queue.get(None)
        if queue is not None:
            _artifact_data = {
                "path": artifact["path"],
                "sha256": artifact.get("sha256"),
                "size": artifact.get("size"),
            }
            await queue.put({
                "type": "CUSTOM",
                "name": "artifact_created",
                "value": _artifact_data,
            })
    except Exception:  # noqa: BLE001
        pass

    if not session_id:
        return

    # 2. Also POST to gateway events endpoint so any other SSE subscribers
    #    (future browser tabs, monitoring) receive it.
    try:
        import httpx  # noqa: PLC0415

        headers = {
            "Authorization": f"Bearer {gateway_token}",
            "Content-Type": "application/json",
        }

        async with httpx.AsyncClient(timeout=5) as client:
            # Register workspace root on the session (idempotent PATCH)
            await client.patch(
                f"{gateway_url}/agent/workspace/{session_id}",
                json={"workspace_path": workspace_root},
                headers=headers,
            )
            # Emit to gateway subscriber queues
            await client.post(
                f"{gateway_url}/agent/workspace/{session_id}/events",
                json={
                    "name": "artifact_created",
                    "path": artifact["path"],
                    "sha256": artifact.get("sha256"),
                    "size": artifact.get("size"),
                },
                headers=headers,
            )
    except Exception:  # noqa: BLE001
        pass  # Non-fatal — the sidebar can always refresh manually

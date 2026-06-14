"""write_artifact — agent tool for writing files to a session workspace.

Auto-injected into every agent alongside ``web_search`` and ``call_agent``.

The tool:
1. Defaults to the ``outputs/`` directory when no visible workspace dir
   (``inputs/``, ``outputs/``, ``agent-data/``) is specified in the path.
2. Writes the file under ``{workspace_root}/{path}`` (creating parent dirs).
3. Computes a SHA-256 hash of the content.
4. Emits an AG-UI ``CUSTOM`` event ``artifact_created`` / ``artifact_updated``
   so the Control Plane sidebar updates in real time.
5. PATCHes the gateway to register the workspace root on the session.
6. Returns a ``download_url`` the agent SHOULD embed in its text response.

Usage by agents:
    result = await write_artifact("summary.md", "# Sales Summary\\n...")
    # File lands in outputs/summary.md (auto-prefixed)
    # Agent outputs: [📄 Download summary.md]({download_url})
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

# Visible workspace dirs — files written outside these are hidden in the UI.
_VISIBLE_DIRS = frozenset({"inputs", "outputs", "agent-data"})


def _sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _normalise_path(path: str) -> str:
    """Strip leading slashes/dots and ensure the path lives in a visible dir.

    If *path* doesn't start with ``inputs/``, ``outputs/``, or ``agent-data/``,
    it is automatically prefixed with ``outputs/`` so the file appears in the
    Files Viewer sidebar.
    """
    clean = path.replace("\\", "/").lstrip("/.")
    # Already in a visible dir — use as-is.
    for d in _VISIBLE_DIRS:
        if clean == d or clean.startswith(d + "/"):
            return clean
    # Default: write to outputs/
    return f"outputs/{clean}"


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

    Files are automatically placed in ``outputs/`` unless you specify
    ``inputs/`` (user-provided files) or ``agent-data/`` (reference data).

    After calling this, **embed the returned ``download_url`` in your text
    response** so the operator can click to download.  Example::

        result = await write_artifact("q2_report.md", report_markdown)
        # In your response text, include:
        # [📄 Download Q2 Report]({result["download_url"]})

    Args:
        path:     Relative file path, e.g. ``"summary.md"`` or
                  ``"reports/q2_summary.md"``.  If the path does not start
                  with ``inputs/``, ``outputs/``, or ``agent-data/``, it is
                  automatically placed in ``outputs/``.
                  Parent directories are created automatically.
        content:  File content — either a ``str`` (written with *encoding*)
                  or ``bytes`` (written as-is; set *encoding* to ``None``).
        encoding: Text encoding for ``str`` content.  Default ``"utf-8"``.
                  Pass ``None`` when *content* is already ``bytes``.

    Returns:
        ``{"path": str, "size": int, "sha256": str, "download_url": str}``

        *download_url* is a relative URL suitable for a clickable markdown
        link, e.g. ``/api/agent/workspace/{session}/file?path=outputs/x.md``.
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
    # Normalise path and auto-prefix with outputs/ if needed
    clean_path = _normalise_path(path)
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

    # Build download URL (relative path — works from the frontend chat UI).
    download_url = (
        f"/api/agent/workspace/{session_id}/file"
        f"?path={clean_path}"
    ) if session_id else None

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

    result: dict = {"path": clean_path, "size": size, "sha256": digest}
    if download_url:
        result["download_url"] = download_url
    return result


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

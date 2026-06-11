"""Agent workspace file-browser API (ST-AV-01).

Endpoints
---------
GET  /agent/workspace/{session_id}
    Returns a JSON tree of files in the session's workspace directory.
    Response: { "session_id": str, "root": str, "files": [FileEntry] }

GET  /agent/workspace/{session_id}/file?path=<rel_path>
    Returns the raw file bytes (streamed).  50 MB cap.
    Use Content-Disposition: inline for browser display.

DELETE /agent/workspace/{session_id}/file?path=<rel_path>
    Delete a file from the workspace.

POST /agent/workspace/{session_id}/upload
    Upload one or more files (multipart/form-data).  Files land in .tmp/
    under the workspace root.  Returns the list of created FileEntry objects.

PATCH /agent/workspace/{session_id}
    Set or update the workspace_path for a session (called by write_artifact tool).

POST /agent/workspace/{session_id}/events
    Push an artifact_created / artifact_updated event from a tool call.
    Stored in a per-session in-memory queue consumed by the SSE endpoint.

GET /agent/workspace/{session_id}/events
    SSE stream: emits artifact_created / artifact_updated events pushed via POST.
    Consumed by the Next.js proxy to forward them into the existing chat SSE stream.
"""
from __future__ import annotations

import asyncio
import json
import mimetypes
import os
from collections import defaultdict
from pathlib import Path
from typing import Any

from acb_auth import UserContext, get_current_user
from acb_common import get_logger
from fastapi import APIRouter, Depends, HTTPException, Query, status
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

_log = get_logger("gateway.workspace")

router = APIRouter(prefix="/agent", tags=["workspace"])

_MAX_FILE_BYTES = 50 * 1024 * 1024  # 50 MB hard cap

# In-memory queues: session_id → list of asyncio.Queue
# Each SSE subscriber gets its own queue so multiple browser tabs work.
_artifact_subscribers: dict[str, list[asyncio.Queue]] = defaultdict(list)


# ---------------------------------------------------------------------------
# Pydantic models
# ---------------------------------------------------------------------------

class FileEntry(BaseModel):
    path: str           # relative to workspace root
    name: str
    size: int           # bytes
    modified_at: str    # ISO-8601
    mime_type: str
    is_dir: bool = False


class WorkspaceTree(BaseModel):
    session_id: str
    root: str           # absolute workspace root path (for display only)
    files: list[FileEntry]


class WorkspacePatchRequest(BaseModel):
    workspace_path: str


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _get_workspace_path(session_id: str) -> Path | None:
    """Look up workspace_path from Postgres for this session.

    Fallback chain:
    1. Explicit ``workspace_path`` column (set by write_artifact or PATCH endpoint).
    2. Agent clone directory derived from the session's ``agent_name``:
       - Dynamic registry ``local_path`` → use as-is.
       - GitHub-registered agent → ``{agents_clone_dir}/repos/{agent_name}``.
    """
    try:
        from acb_graph import get_session as _db_session  # noqa: PLC0415
        from sqlalchemy import text  # noqa: PLC0415

        with _db_session() as s:
            row = s.execute(
                text("SELECT workspace_path, agent_name FROM chat_session WHERE id = :id"),
                {"id": session_id},
            ).fetchone()

        if row is None:
            return None

        # ── 1. Explicit workspace_path ──────────────────────────────────────
        if row.workspace_path:
            return Path(row.workspace_path)

        # ── 2. Derive from agent clone directory ────────────────────────────
        agent_name: str = row.agent_name or ""
        if not agent_name or agent_name in ("orchestrator", "default"):
            return None

        return _resolve_agent_workspace(agent_name)

    except Exception as exc:
        _log.warning("workspace.db_lookup_failed", session_id=session_id, error=str(exc))
    return None


def _resolve_agent_workspace(agent_name: str) -> Path | None:
    """Return the workspace directory for a named agent.

    Checks the dynamic agent registry first (for local_path overrides),
    then falls back to the clone-cache convention.
    """
    try:
        from acb_common import get_settings  # noqa: PLC0415

        # Check dynamic registry for local_path override
        try:
            import json  # noqa: PLC0415
            from pathlib import Path as _Path  # noqa: PLC0415

            agents_file = _Path(__file__).resolve()
            for _ in range(8):
                agents_file = agents_file.parent
                if (agents_file / "pyproject.toml").exists():
                    agents_file = agents_file / "agents.json"
                    break

            if agents_file.exists() and agents_file.name == "agents.json":
                entries = json.loads(agents_file.read_text(encoding="utf-8"))
                for entry in entries:
                    if entry.get("name") == agent_name:
                        lp = entry.get("local_path")
                        if lp:
                            p = Path(lp)
                            return p if p.exists() else None
                        break
        except Exception:  # noqa: BLE001
            pass

        # Fallback: clone-cache convention  {agents_clone_dir}/repos/{agent_name}
        settings = get_settings()
        clone_root = Path(getattr(settings, "agents_clone_dir", "/tmp/acb_agents")) / "repos"
        candidate = clone_root / agent_name
        if candidate.exists():
            return candidate

    except Exception as exc:
        _log.warning("workspace.agent_resolve_failed", agent=agent_name, error=str(exc))
    return None


def _safe_resolve(root: Path, rel: str) -> Path:
    """Resolve a relative path under root, raising 400 on traversal attempts."""
    # Normalise separators and strip leading slashes/dots
    clean = rel.replace("\\", "/").lstrip("/.")
    resolved = (root / clean).resolve()
    if not str(resolved).startswith(str(root.resolve())):
        raise HTTPException(status_code=400, detail="Path traversal not allowed")
    return resolved


# Directories that are ALWAYS visible in the workspace file tree even if
# they start with "." or are common cache names.  Agents write artefacts to
# .tmp/ and outputs/; those must be browseable + downloadable from the chat UI.
_ALWAYS_VISIBLE_DIRS = frozenset({".tmp", "outputs"})

# Directories explicitly excluded from the file tree.
_EXCLUDED_DIRS = frozenset({"__pycache__", "node_modules", ".git", ".mypy_cache", ".pytest_cache", ".ruff_cache"})

def _walk_tree(root: Path) -> list[FileEntry]:
    """Walk the workspace directory and return a flat list of FileEntry objects."""
    entries: list[FileEntry] = []
    try:
        for dirpath, dirnames, filenames in os.walk(root):
            # Skip hidden / cache directories but keep agent artefact dirs.
            dirnames[:] = [
                d
                for d in dirnames
                if d in _ALWAYS_VISIBLE_DIRS
                or (not d.startswith(".") and d not in _EXCLUDED_DIRS)
            ]
            dp = Path(dirpath)
            rel_dir = dp.relative_to(root)

            for fname in sorted(filenames):
                fpath = dp / fname
                try:
                    stat = fpath.stat()
                    rel_path = str((rel_dir / fname)).replace("\\", "/")
                    mime, _ = mimetypes.guess_type(fname)
                    entries.append(FileEntry(
                        path=rel_path,
                        name=fname,
                        size=stat.st_size,
                        modified_at=__import__("datetime").datetime.fromtimestamp(
                            stat.st_mtime, tz=__import__("datetime").timezone.utc
                        ).isoformat(),
                        mime_type=mime or "application/octet-stream",
                        is_dir=False,
                    ))
                except OSError:
                    continue
    except Exception as exc:
        _log.warning("workspace.walk_failed", root=str(root), error=str(exc))
    return entries


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------

@router.get("/workspace/{session_id}", response_model=WorkspaceTree)
async def get_workspace_tree(
    session_id: str,
    _user: UserContext = Depends(get_current_user),
) -> WorkspaceTree:
    """Return the file tree for a session's workspace directory.

    If the session has no explicit workspace_path set, the agent's clone
    directory is used automatically (derived from the session's agent_name).
    """
    import asyncio  # noqa: PLC0415
    loop = asyncio.get_event_loop()
    workspace = await loop.run_in_executor(None, _get_workspace_path, session_id)
    if workspace is None or not workspace.exists():
        return WorkspaceTree(session_id=session_id, root="", files=[])

    files = await loop.run_in_executor(None, _walk_tree, workspace)
    return WorkspaceTree(session_id=session_id, root=str(workspace), files=files)


@router.get("/workspace/{session_id}/file")
async def get_workspace_file(
    session_id: str,
    path: str = Query(..., description="Relative path within the workspace"),
    _user: UserContext = Depends(get_current_user),
) -> StreamingResponse:
    """Stream a single file from the session workspace."""
    import asyncio  # noqa: PLC0415
    workspace = await asyncio.get_event_loop().run_in_executor(
        None, _get_workspace_path, session_id
    )
    if workspace is None or not workspace.exists():
        raise HTTPException(status_code=404, detail="Workspace not found for session")

    file_path = _safe_resolve(workspace, path)
    if not file_path.exists() or not file_path.is_file():
        raise HTTPException(status_code=404, detail="File not found")

    file_size = file_path.stat().st_size
    if file_size > _MAX_FILE_BYTES:
        raise HTTPException(
            status_code=413,
            detail=f"File too large ({file_size} bytes). Maximum is {_MAX_FILE_BYTES} bytes.",
        )

    mime, _ = mimetypes.guess_type(file_path.name)
    media_type = mime or "application/octet-stream"

    def _iter_file():
        with open(file_path, "rb") as f:
            while chunk := f.read(65536):
                yield chunk

    return StreamingResponse(
        _iter_file(),
        media_type=media_type,
        headers={
            "Content-Disposition": f'inline; filename="{file_path.name}"',
            "Content-Length": str(file_size),
        },
    )


@router.patch("/workspace/{session_id}", status_code=status.HTTP_204_NO_CONTENT)
async def set_workspace_path(
    session_id: str,
    body: WorkspacePatchRequest,
    _user: UserContext = Depends(get_current_user),
) -> None:
    """Record the workspace_path for a session (called by write_artifact tool)."""
    try:
        from acb_graph import get_session as _db_session  # noqa: PLC0415
        from sqlalchemy import text  # noqa: PLC0415

        def _write():
            with _db_session() as s:
                s.execute(
                    text(
                        "UPDATE chat_session SET workspace_path = :path "
                        "WHERE id = :id"
                    ),
                    {"path": body.workspace_path, "id": session_id},
                )
                s.commit()

        await __import__("asyncio").get_event_loop().run_in_executor(None, _write)
    except Exception as exc:
        _log.warning("workspace.patch_failed", session_id=session_id, error=str(exc))
        raise HTTPException(status_code=500, detail="Failed to update workspace path") from exc


# ---------------------------------------------------------------------------
# Artifact event push (called by write_artifact tool) + SSE stream
# ---------------------------------------------------------------------------

class ArtifactEvent(BaseModel):
    name: str  # "artifact_created" | "artifact_updated"
    path: str
    sha256: str | None = None
    size: int | None = None


@router.post("/workspace/{session_id}/events", status_code=status.HTTP_204_NO_CONTENT)
async def push_artifact_event(
    session_id: str,
    event: ArtifactEvent,
    _user: UserContext = Depends(get_current_user),
) -> None:
    """Receive an artifact event from the write_artifact tool and fan it out
    to any subscribed SSE consumers for this session."""
    payload = event.model_dump()
    for q in list(_artifact_subscribers.get(session_id, [])):
        try:
            q.put_nowait(payload)
        except asyncio.QueueFull:
            pass
    _log.info(
        "workspace.artifact_event",
        session_id=session_id,
        name=event.name,
        path=event.path,
    )


@router.get("/workspace/{session_id}/events")
async def stream_artifact_events(
    session_id: str,
    _user: UserContext = Depends(get_current_user),
) -> StreamingResponse:
    """SSE stream — yields artifact_created / artifact_updated events pushed
    by the write_artifact tool for this session.

    The Next.js api/agent/chat route (or a dedicated proxy) can subscribe
    here and forward custom events into the existing chat SSE stream.
    """
    q: asyncio.Queue = asyncio.Queue(maxsize=256)
    _artifact_subscribers[session_id].append(q)

    async def _generate():
        try:
            while True:
                try:
                    payload = await asyncio.wait_for(q.get(), timeout=30.0)
                    yield f"data: {json.dumps({'type': 'custom', 'name': payload['name'], 'data': payload})}\n\n"
                except asyncio.TimeoutError:
                    # heartbeat keep-alive
                    yield ": keep-alive\n\n"
        finally:
            try:
                _artifact_subscribers[session_id].remove(q)
            except ValueError:
                pass
            if not _artifact_subscribers[session_id]:
                del _artifact_subscribers[session_id]

    return StreamingResponse(
        _generate(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "X-Accel-Buffering": "no",
            "Connection": "keep-alive",
        },
    )


# ---------------------------------------------------------------------------
# POST /workspace/{session_id}/upload  — user file upload
# ---------------------------------------------------------------------------

from fastapi import UploadedFile  # noqa: E402

_MAX_UPLOAD_BYTES = 25 * 1024 * 1024  # 25 MB per file
_ALLOWED_EXTENSIONS = {
    ".md", ".txt", ".pdf", ".docx", ".pptx", ".xlsx", ".csv",
    ".json", ".yaml", ".yml", ".xml", ".html", ".css", ".js", ".ts",
    ".py", ".sh", ".ps1", ".toml", ".ini", ".cfg",
    ".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp", ".ico",
    ".mp3", ".wav", ".mp4", ".webm",
    ".zip", ".tar", ".gz", ".bz2", ".7z",
    ".log", ".sql", ".db", ".sqlite",
}


@router.post("/workspace/{session_id}/upload")
async def upload_files(
    session_id: str,
    files: list[UploadedFile],
    _user: UserContext = Depends(get_current_user),
) -> list[FileEntry]:
    """Upload one or more files into the session workspace .tmp/ directory.

    Files are stored under ``{workspace_root}/.tmp/`` and are automatically
    tracked by Git.  The agent receives a system message with the list of
    uploaded files and their paths so it can reference them.
    """
    workspace = await asyncio.get_event_loop().run_in_executor(
        None, _get_workspace_path, session_id
    )
    if workspace is None:
        raise HTTPException(
            status_code=404,
            detail="No workspace found for this session. "
                   "Start a chat with an agent first.",
        )

    tmp_dir = workspace / ".tmp"
    try:
        tmp_dir.mkdir(parents=True, exist_ok=True)
    except OSError as exc:
        raise HTTPException(
            status_code=500,
            detail=f"Cannot create .tmp directory: {exc}",
        ) from exc

    uploaded: list[FileEntry] = []
    for f in files:
        # Validate filename
        safe_name = Path(f.filename or "untitled").name
        ext = Path(safe_name).suffix.lower()
        if ext not in _ALLOWED_EXTENSIONS:
            raise HTTPException(
                status_code=400,
                detail=f"Unsupported file type: {ext}. "
                       f"Allowed: {', '.join(sorted(_ALLOWED_EXTENSIONS))}",
            )

        # Read into memory (capped at _MAX_UPLOAD_BYTES)
        content = await f.read()
        if len(content) > _MAX_UPLOAD_BYTES:
            raise HTTPException(
                status_code=413,
                detail=f"File '{safe_name}' too large "
                       f"({len(content)} bytes). Max is {_MAX_UPLOAD_BYTES}.",
            )

        # Avoid overwrites: append (1), (2), etc.
        dest = tmp_dir / safe_name
        counter = 1
        stem, ext2 = Path(safe_name).stem, Path(safe_name).suffix
        while dest.exists():
            dest = tmp_dir / f"{stem} ({counter}){ext2}"
            counter += 1

        # Write
        dest.write_bytes(content)

        # Build response entry
        stat = dest.stat()
        mime, _ = mimetypes.guess_type(safe_name)
        rel_path = str(dest.relative_to(workspace)).replace("\\", "/")
        uploaded.append(FileEntry(
            path=rel_path,
            name=dest.name,
            size=stat.st_size,
            modified_at=__import__("datetime").datetime.fromtimestamp(
                stat.st_mtime, tz=__import__("datetime").timezone.utc
            ).isoformat(),
            mime_type=mime or "application/octet-stream",
            is_dir=False,
        ))

        _log.info(
            "workspace.file_uploaded",
            session_id=session_id,
            path=rel_path,
            size=stat.st_size,
        )

    return uploaded


# ---------------------------------------------------------------------------
# DELETE /workspace/{session_id}/file  — remove a file
# ---------------------------------------------------------------------------

class DeleteResponse(BaseModel):
    deleted: bool
    path: str


@router.delete("/workspace/{session_id}/file", response_model=DeleteResponse)
async def delete_workspace_file(
    session_id: str,
    path: str = Query(..., description="Relative path within the workspace"),
    _user: UserContext = Depends(get_current_user),
) -> DeleteResponse:
    """Delete a file from the session workspace."""
    workspace = await asyncio.get_event_loop().run_in_executor(
        None, _get_workspace_path, session_id
    )
    if workspace is None or not workspace.exists():
        raise HTTPException(
            status_code=404, detail="Workspace not found for session"
        )

    file_path = _safe_resolve(workspace, path)
    if not file_path.exists():
        raise HTTPException(status_code=404, detail="File not found")
    if file_path.is_dir():
        raise HTTPException(
            status_code=400, detail="Cannot delete directories"
        )

    file_path.unlink()
    _log.info(
        "workspace.file_deleted",
        session_id=session_id,
        path=path,
    )
    return DeleteResponse(deleted=True, path=path)

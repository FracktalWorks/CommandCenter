"""Agent workspace file-browser API (ST-AV-01).

Endpoints
---------
GET  /agent/workspace/{session_id}
    Returns a JSON tree of files in the session's workspace directory.
    Response: { "session_id": str, "root": str, "files": [FileEntry] }

GET  /agent/workspace/{session_id}/file?path=<rel_path>
    Returns the raw file bytes (streamed).  50 MB cap.

GET  /agent/artifacts?agent=<name>&category=<inputs|outputs|agent-data>
    Global artifact browser — lists all files from all agent workspaces
    across the three visible directories.  Supports filtering by agent
    name and category (folder).  Response: { "artifacts": [ArtifactEntry] }
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


def _agent_workspace_dir(agent_name: str) -> Path | None:
    """Return the on-disk workspace (clone-cache) directory for an agent.

    This MUST mirror ``loader.load_agent``, which ALWAYS runs an agent from
    ``{agents_clone_dir}/repos/{agent_name}`` (``clone_as=agent_name``) —
    whether the agent is sourced from a GitHub repo or a local ``local_path``.
    The registry's ``local_path`` is only a *load-time source pointer*: the
    loader copies it into the clone-cache and runs from there, so the agent
    and all its artefacts (``outputs/``, ``inputs/``, ``agent-data/``) live in
    the cache, NOT at ``local_path``.  Using ``local_path`` as the workspace
    points the file browsers at the (artefact-free) monorepo source — which is
    exactly why generated files were invisible in the UI.

    Tries the bare agent name first, then the ``agent-`` prefixed variant,
    since older clones may use either convention.  Returns ``None`` when no
    clone exists yet (the agent has never run, so it has no artefacts).
    """
    from acb_common import get_settings  # noqa: PLC0415

    settings = get_settings()
    clone_root = (
        Path(
            getattr(
                settings,
                "agents_clone_dir",
                str(Path.home() / ".acb" / "agents"),
            )
        )
        / "repos"
    )
    candidates = [clone_root / agent_name]
    if agent_name.startswith("agent-"):
        candidates.append(clone_root / agent_name[len("agent-"):])
    else:
        candidates.append(clone_root / f"agent-{agent_name}")
    for candidate in candidates:
        if candidate.is_dir():
            return candidate
    return None


def _resolve_agent_workspace(agent_name: str) -> Path | None:
    """Return the workspace directory for a named agent.

    Always resolves to the clone-cache directory the loader actually runs the
    agent from (``{agents_clone_dir}/repos/{agent_name}``).  See
    :func:`_agent_workspace_dir` for why the registry ``local_path`` is never
    used here.
    """
    try:
        return _agent_workspace_dir(agent_name)
    except Exception as exc:  # noqa: BLE001
        _log.warning(
            "workspace.agent_resolve_failed",
            agent=agent_name,
            error=str(exc),
        )
    return None


def _safe_resolve(root: Path, rel: str) -> Path:
    """Resolve a relative path under root, raising 400 on traversal attempts."""
    # Normalise separators and strip leading slashes/dots
    clean = rel.replace("\\", "/").lstrip("/.")
    resolved = (root / clean).resolve()
    if not str(resolved).startswith(str(root.resolve())):
        raise HTTPException(status_code=400, detail="Path traversal not allowed")
    return resolved


# The three workspace directories that are visible in the Files Viewer sidebar.
# Agents read/write artefacts to inputs/, outputs/, and agent-data/ — ONLY
# these directories (and their contents) are exposed to the frontend user.
# All other files (agent source, configs, skills, .github/, etc.) remain
# accessible to the agent itself but are hidden from the chat UI.
_VISIBLE_WORKSPACE_DIRS = frozenset({"inputs", "outputs", "agent-data"})

# Directories explicitly excluded from traversal within the visible workspace
# dirs (cache / tooling noise).
_EXCLUDED_DIRS = frozenset({"__pycache__", "node_modules", ".git", ".mypy_cache", ".pytest_cache", ".ruff_cache"})


def _ensure_workspace_dirs(root: Path) -> None:
    """Create inputs/, outputs/, and agent-data/ if they don't exist yet."""
    for d in _VISIBLE_WORKSPACE_DIRS:
        (root / d).mkdir(parents=True, exist_ok=True)


def _walk_tree(root: Path) -> list[FileEntry]:
    """Walk ONLY the visible workspace directories and return a flat list of
    FileEntry objects.

    Only ``inputs/``, ``outputs/``, and ``agent-data/`` are traversed.
    All other top-level files and directories are intentionally hidden from
    the frontend user (but remain accessible to the agent itself).
    """
    entries: list[FileEntry] = []
    try:
        _ensure_workspace_dirs(root)

        for visible_dir in sorted(_VISIBLE_WORKSPACE_DIRS):
            dir_path = root / visible_dir
            if not dir_path.is_dir():
                continue

            for dirpath, dirnames, filenames in os.walk(dir_path):
                # Skip cache / tooling noise directories.
                dirnames[:] = [
                    d for d in dirnames
                    if not d.startswith(".") and d not in _EXCLUDED_DIRS
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


def _is_visible_workspace_path(rel_path: str) -> bool:
    """Check whether *rel_path* is within one of the visible workspace dirs."""
    clean = rel_path.replace("\\", "/").lstrip("/")
    return any(
        clean == d or clean.startswith(d + "/")
        for d in _VISIBLE_WORKSPACE_DIRS
    )


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

from fastapi import UploadFile  # noqa: E402

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
    files: list[UploadFile],
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

    # Upload to inputs/ (visible workspace directory) — not .tmp/
    upload_dir = workspace / "inputs"
    try:
        upload_dir.mkdir(parents=True, exist_ok=True)
    except OSError as exc:
        raise HTTPException(
            status_code=500,
            detail=f"Cannot create inputs directory: {exc}",
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
        dest = upload_dir / safe_name
        counter = 1
        stem, ext2 = Path(safe_name).stem, Path(safe_name).suffix
        while dest.exists():
            dest = upload_dir / f"{stem} ({counter}){ext2}"
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

    # Only allow deletion of files within the visible workspace dirs.
    rel = str(file_path.relative_to(workspace)).replace("\\", "/")
    if not _is_visible_workspace_path(rel):
        raise HTTPException(
            status_code=400,
            detail="Deletion is restricted to inputs/, outputs/, and agent-data/.",
        )

    file_path.unlink()
    _log.info(
        "workspace.file_deleted",
        session_id=session_id,
        path=path,
    )
    return DeleteResponse(deleted=True, path=path)


# ---------------------------------------------------------------------------
# PUT /workspace/{session_id}/file  — edit/write a file in place
# ---------------------------------------------------------------------------

class WriteFileRequest(BaseModel):
    content: str
    """New file content.  Written as UTF-8 text for text/code files;
    base64-decodable payloads are written as binary bytes."""
    encoding: str = "utf-8"
    """'utf-8' (default — text content), 'base64' (binary content)."""


@router.put("/workspace/{session_id}/file")
async def write_workspace_file(
    session_id: str,
    body: WriteFileRequest,
    path: str = Query(..., description="Relative path within the workspace"),
    _user: UserContext = Depends(get_current_user),
) -> FileEntry:
    """Overwrite or create a file in the workspace.  Directories are
    created automatically.  Safe — resolves against workspace root only.

    Accepts text (encoding='utf-8') and binary (encoding='base64') content.
    Returns the updated FileEntry with fresh stat metadata.
    """
    import base64  # noqa: PLC0415

    loop = asyncio.get_event_loop()
    workspace = await loop.run_in_executor(None, _get_workspace_path, session_id)
    if workspace is None or not workspace.exists():
        raise HTTPException(
            status_code=404, detail="Workspace not found for session"
        )

    file_path = _safe_resolve(workspace, path)
    # Only allow writes within the visible workspace dirs (inputs/, outputs/,
    # agent-data/).  The agent itself can write anywhere, but the frontend
    # user is restricted to the three visible folders.
    if not file_path.is_relative_to(workspace):
        raise HTTPException(
            status_code=400, detail="Path escapes workspace root"
        )
    rel = str(file_path.relative_to(workspace)).replace("\\", "/")
    if not _is_visible_workspace_path(rel):
        raise HTTPException(
            status_code=400,
            detail="Writes are restricted to inputs/, outputs/, and agent-data/.",
        )

    # Create parent directories if needed
    file_path.parent.mkdir(parents=True, exist_ok=True)

    # Write content
    if body.encoding == "base64":
        data = base64.b64decode(body.content)
        file_path.write_bytes(data)
    else:
        file_path.write_text(body.content, encoding="utf-8")

    # Build response
    stat = file_path.stat()
    mime, _ = mimetypes.guess_type(file_path.name)
    rel_path = str(file_path.relative_to(workspace)).replace("\\", "/")

    _log.info(
        "workspace.file_written",
        session_id=session_id,
        path=rel_path,
        size=stat.st_size,
    )

    return FileEntry(
        path=rel_path,
        name=file_path.name,
        size=stat.st_size,
        modified_at=__import__("datetime").datetime.fromtimestamp(
            stat.st_mtime, tz=__import__("datetime").timezone.utc
        ).isoformat(),
        mime_type=mime or "application/octet-stream",
        is_dir=False,
    )


# ---------------------------------------------------------------------------
# Global artifact browser — lists files from ALL agent workspaces
# ---------------------------------------------------------------------------

class ArtifactEntry(BaseModel):
    agent_name: str
    path: str           # relative to workspace root
    name: str
    size: int
    modified_at: str
    mime_type: str
    category: str       # "inputs" | "outputs" | "agent-data"
    is_dir: bool = False


class ArtifactListResponse(BaseModel):
    artifacts: list[ArtifactEntry]


def _discover_agent_workspaces() -> dict[str, Path]:
    """Return a dict of {agent_name: workspace_path} for all *live* agents.

    Collects the names of every live agent from the registries, then resolves
    each to its clone-cache directory via :func:`_agent_workspace_dir` — the
    same path the loader runs the agent from and writes artefacts to.  The
    registry ``local_path`` is deliberately ignored as a workspace (it is only
    a load-time source pointer; see :func:`_agent_workspace_dir`).

    Name sources:
    1. Static agent registry (``_AGENT_REGISTRY``) — all entries are live.
    2. Dynamic agent registry (Postgres-backed) — ``status == 'live'`` only.
    3. Agents.json file (legacy fallback) — all listed names.
    """
    names: set[str] = set()

    # ── 1. Static registry (in-code _AGENT_REGISTRY) ──────────────────────
    try:
        from gateway.routes.agent import _AGENT_REGISTRY  # noqa: PLC0415
        for entry in _AGENT_REGISTRY:
            name = entry.get("name")
            if name:
                names.add(name)
    except Exception:  # noqa: BLE001
        pass

    # ── 2. Dynamic registry (Postgres-backed) — live agents only ──────────
    try:
        from gateway.routes.agent import \
            _load_dynamic_agents  # noqa: PLC0415
        for entry in _load_dynamic_agents():
            name = entry.get("name")
            if name and entry.get("status", "live") == "live":
                names.add(name)
    except Exception:  # noqa: BLE001
        pass

    # ── 3. Agents.json file (legacy fallback) ─────────────────────────────
    try:
        import json as _json  # noqa: PLC0415
        agents_file = Path(__file__).resolve()
        for _ in range(8):
            agents_file = agents_file.parent
            if (agents_file / "pyproject.toml").exists():
                agents_file = agents_file / "agents.json"
                break
        if agents_file.exists() and agents_file.name == "agents.json":
            entries = _json.loads(agents_file.read_text(encoding="utf-8"))
            for entry in entries:
                name = entry.get("name")
                if name:
                    names.add(name)
    except Exception:  # noqa: BLE001
        pass

    # ── Resolve each name to its clone-cache workspace (where artefacts live).
    workspaces: dict[str, Path] = {}
    for name in names:
        try:
            ws = _agent_workspace_dir(name)
        except Exception:  # noqa: BLE001
            ws = None
        if ws is not None:
            workspaces[name] = ws

    return workspaces


def _walk_agent_artifacts(
    agent_name: str,
    workspace: Path,
    category_filter: str | None = None,
) -> list[ArtifactEntry]:
    """Walk the visible workspace dirs for a single agent and return
    ArtifactEntry objects (both files and directories)."""
    entries: list[ArtifactEntry] = []
    categories = (
        [category_filter]
        if category_filter and category_filter in _VISIBLE_WORKSPACE_DIRS
        else sorted(_VISIBLE_WORKSPACE_DIRS)
    )

    for cat in categories:
        cat_dir = workspace / cat
        if not cat_dir.is_dir():
            continue

        # Add the category root directory itself
        try:
            stat = cat_dir.stat()
            entries.append(ArtifactEntry(
                agent_name=agent_name,
                path=cat,
                name=cat,
                size=0,
                modified_at=__import__("datetime").datetime.fromtimestamp(
                    stat.st_mtime,
                    tz=__import__("datetime").timezone.utc,
                ).isoformat(),
                mime_type="inode/directory",
                category=cat,
                is_dir=True,
            ))
        except OSError:
            pass

        for dirpath, dirnames, filenames in os.walk(cat_dir):
            dirnames[:] = [
                d for d in dirnames
                if not d.startswith(".") and d not in _EXCLUDED_DIRS
            ]
            dp = Path(dirpath)
            rel_dir = dp.relative_to(workspace)

            # Yield sub-directory entries
            for dname in sorted(dirnames):
                try:
                    dpath = dp / dname
                    dstat = dpath.stat()
                    rel_dpath = str((rel_dir / dname)).replace("\\", "/")
                    entries.append(ArtifactEntry(
                        agent_name=agent_name,
                        path=rel_dpath,
                        name=dname,
                        size=0,
                        modified_at=__import__("datetime").datetime.fromtimestamp(
                            dstat.st_mtime,
                            tz=__import__("datetime").timezone.utc,
                        ).isoformat(),
                        mime_type="inode/directory",
                        category=cat,
                        is_dir=True,
                    ))
                except OSError:
                    continue

            # Yield file entries
            for fname in sorted(filenames):
                fpath = dp / fname
                try:
                    stat = fpath.stat()
                    rel_path = str((rel_dir / fname)).replace("\\", "/")
                    mime, _ = mimetypes.guess_type(fname)
                    entries.append(ArtifactEntry(
                        agent_name=agent_name,
                        path=rel_path,
                        name=fname,
                        size=stat.st_size,
                        modified_at=__import__("datetime").datetime.fromtimestamp(
                            stat.st_mtime,
                            tz=__import__("datetime").timezone.utc,
                        ).isoformat(),
                        mime_type=mime or "application/octet-stream",
                        category=cat,
                        is_dir=False,
                    ))
                except OSError:
                    continue

    return entries


@router.get("/artifacts", response_model=ArtifactListResponse)
async def get_artifacts(
    agent: str | None = Query(None, description="Filter by agent name"),
    category: str | None = Query(
        None, description="Filter: 'inputs', 'outputs', or 'agent-data'"
    ),
    _user: UserContext = Depends(get_current_user),
) -> ArtifactListResponse:
    """Global artifact browser — lists files from ALL agent workspaces.

    Returns every file across ``inputs/``, ``outputs/``, and ``agent-data/``
    for every known agent.  Supports optional filtering by agent name and
    category.
    """
    import asyncio as _asyncio  # noqa: PLC0415
    loop = _asyncio.get_event_loop()

    # Validate category filter early
    if category and category not in _VISIBLE_WORKSPACE_DIRS:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid category. Must be one of: "
                   f"{', '.join(sorted(_VISIBLE_WORKSPACE_DIRS))}.",
        )

    workspaces = await loop.run_in_executor(None, _discover_agent_workspaces)

    # Filter by agent if requested
    if agent:
        ws = workspaces.get(agent)
        if ws is None:
            return ArtifactListResponse(artifacts=[])
        workspaces = {agent: ws}

    all_artifacts: list[ArtifactEntry] = []
    for ag_name, ws_path in sorted(workspaces.items()):
        batch = await loop.run_in_executor(
            None,
            _walk_agent_artifacts,
            ag_name,
            ws_path,
            category,
        )
        all_artifacts.extend(batch)

    return ArtifactListResponse(artifacts=all_artifacts)


@router.get("/artifacts/file")
async def get_artifact_file(
    agent: str = Query(..., description="Agent name"),
    path: str = Query(..., description="Relative path within the workspace"),
    _user: UserContext = Depends(get_current_user),
) -> StreamingResponse:
    """Stream a single file from any agent's workspace (global artifact view)."""
    import asyncio as _asyncio  # noqa: PLC0415
    loop = _asyncio.get_event_loop()
    workspaces = await loop.run_in_executor(None, _discover_agent_workspaces)
    workspace = workspaces.get(agent)
    if workspace is None or not workspace.exists():
        raise HTTPException(
            status_code=404, detail=f"Agent workspace not found: {agent}"
        )

    file_path = _safe_resolve(workspace, path)
    if not file_path.exists() or not file_path.is_file():
        raise HTTPException(status_code=404, detail="File not found")

    file_size = file_path.stat().st_size
    if file_size > _MAX_FILE_BYTES:
        raise HTTPException(
            status_code=413,
            detail=f"File too large ({file_size} bytes). "
                   f"Maximum is {_MAX_FILE_BYTES} bytes.",
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


@router.put("/artifacts/file")
async def write_artifact_file(
    agent: str = Query(..., description="Agent name"),
    path: str = Query(..., description="Relative path within the workspace"),
    body: WriteFileRequest = ...,
    _user: UserContext = Depends(get_current_user),
) -> ArtifactEntry:
    """Overwrite a file in any agent's workspace (global artifact view).

    Uses the same agent-workspace discovery as GET /artifacts/file.
    Accepts text (encoding='utf-8') and binary (encoding='base64') content.
    Returns the updated ArtifactEntry with fresh stat metadata.
    """
    import asyncio as _asyncio  # noqa: PLC0415
    import base64  # noqa: PLC0415
    loop = _asyncio.get_event_loop()

    workspaces = await loop.run_in_executor(None, _discover_agent_workspaces)
    workspace = workspaces.get(agent)
    if workspace is None or not workspace.exists():
        raise HTTPException(
            status_code=404, detail=f"Agent workspace not found: {agent}"
        )

    file_path = _safe_resolve(workspace, path)
    # Restrict writes to visible workspace dirs
    rel = str(file_path.relative_to(workspace)).replace("\\", "/")
    if not _is_visible_workspace_path(rel):
        raise HTTPException(
            status_code=400,
            detail="Writes are restricted to inputs/, outputs/, and agent-data/.",
        )

    # Create parent directories if needed
    file_path.parent.mkdir(parents=True, exist_ok=True)

    # Write content
    if body.encoding == "base64":
        data = base64.b64decode(body.content)
        file_path.write_bytes(data)
    else:
        file_path.write_text(body.content, encoding="utf-8")

    # Build response
    stat = file_path.stat()
    mime, _ = mimetypes.guess_type(file_path.name)
    rel_path = str(file_path.relative_to(workspace)).replace("\\", "/")

    # Determine category from path
    cat = "agent-data"
    for c in _VISIBLE_WORKSPACE_DIRS:
        if rel_path.startswith(c + "/") or rel_path == c:
            cat = c
            break

    _log.info(
        "workspace.artifact_file_written",
        agent=agent,
        path=rel_path,
        size=stat.st_size,
    )

    return ArtifactEntry(
        agent_name=agent,
        path=rel_path,
        name=file_path.name,
        size=stat.st_size,
        modified_at=__import__("datetime").datetime.fromtimestamp(
            stat.st_mtime, tz=__import__("datetime").timezone.utc
        ).isoformat(),
        mime_type=mime or "application/octet-stream",
        category=cat,
        is_dir=False,
    )

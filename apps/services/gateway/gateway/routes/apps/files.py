"""Custom Apps · files — workspace passthrough for the Workshop (edit-gated).

Flat listing + text read/write over an app's workspace, containment-guarded by
``resolve_app_file`` (traversal, dotfiles, ``.git``, symlink escapes). The
Workshop's code view and the preview pane's draft fetch ride these; published
bundles are served from ``app_versions`` instead (see ``publish.py``).
"""

from __future__ import annotations

import asyncio
import os
from datetime import UTC, datetime
from pathlib import Path

from acb_auth import UserContext
from fastapi import Depends, HTTPException, Query
from fastapi.responses import PlainTextResponse
from gateway.routes.apps._common import (
    MAX_SOURCE_FILE_BYTES,
    _get_db,
    _log,
    app_workspace,
    get_app_or_404,
    require_app_user,
    resolve_app_file,
    router,
)
from pydantic import BaseModel

# Directories never listed (VCS + build/dependency noise — dotdirs are already
# skipped wholesale, same stance as workspace.py's _EXCLUDED_DIRS).
_SKIP_DIRS = frozenset({"node_modules", "dist", "build", "__pycache__"})
_MAX_LIST_FILES = 2000


class AppFileEntry(BaseModel):
    path: str
    size: int
    modified_at: str


class AppFileWrite(BaseModel):
    path: str
    content: str


def _walk_files(workspace: Path) -> list[AppFileEntry]:
    """Flat file list — skips dot-anything, VCS/build dirs, and directories."""
    entries: list[AppFileEntry] = []
    if not workspace.is_dir():
        return entries
    for dirpath, dirnames, filenames in os.walk(workspace):
        dirnames[:] = sorted(
            d for d in dirnames
            if not d.startswith(".") and d not in _SKIP_DIRS
        )
        rel_dir = Path(dirpath).relative_to(workspace)
        for fname in sorted(filenames):
            if fname.startswith("."):
                continue
            fpath = Path(dirpath) / fname
            try:
                stat = fpath.stat()
            except OSError:
                continue
            entries.append(AppFileEntry(
                path=str(rel_dir / fname).replace("\\", "/"),
                size=stat.st_size,
                modified_at=datetime.fromtimestamp(
                    stat.st_mtime, tz=UTC,
                ).isoformat(),
            ))
            if len(entries) >= _MAX_LIST_FILES:
                return entries
    return entries


async def _edit_workspace(slug: str, user: UserContext) -> Path:
    db = await _get_db()
    try:
        row, _grants = await get_app_or_404(db, slug, user, edit=True)
    finally:
        await db.close()
    return app_workspace(row)


@router.get("/{slug}/files", response_model=list[AppFileEntry])
async def list_app_files(
    slug: str,
    user: UserContext = Depends(require_app_user),
) -> list[AppFileEntry]:
    workspace = await _edit_workspace(slug, user)
    return await asyncio.get_event_loop().run_in_executor(
        None, _walk_files, workspace,
    )


@router.get("/{slug}/files/content")
async def read_app_file(
    slug: str,
    path: str = Query(..., description="Relative path within the workspace"),
    user: UserContext = Depends(require_app_user),
) -> PlainTextResponse:
    workspace = await _edit_workspace(slug, user)
    file_path = resolve_app_file(workspace, path)
    if not file_path.is_file():
        raise HTTPException(status_code=404, detail="File not found")
    size = file_path.stat().st_size
    if size > MAX_SOURCE_FILE_BYTES:
        raise HTTPException(
            status_code=413,
            detail=f"File too large ({size} bytes). "
                   f"Maximum is {MAX_SOURCE_FILE_BYTES}.",
        )
    data = await asyncio.get_event_loop().run_in_executor(
        None, file_path.read_bytes,
    )
    try:
        content = data.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise HTTPException(
            status_code=415, detail="Not a text file",
        ) from exc
    return PlainTextResponse(content)


@router.put("/{slug}/files/content", response_model=AppFileEntry)
async def write_app_file(
    slug: str,
    body: AppFileWrite,
    user: UserContext = Depends(require_app_user),
) -> AppFileEntry:
    data = body.content.encode("utf-8")
    if len(data) > MAX_SOURCE_FILE_BYTES:
        raise HTTPException(
            status_code=413,
            detail=f"Content too large ({len(data)} bytes). "
                   f"Maximum is {MAX_SOURCE_FILE_BYTES}.",
        )
    workspace = await _edit_workspace(slug, user)
    file_path = resolve_app_file(workspace, body.path)

    def _write() -> os.stat_result:
        file_path.parent.mkdir(parents=True, exist_ok=True)
        file_path.write_bytes(data)
        return file_path.stat()

    stat = await asyncio.get_event_loop().run_in_executor(None, _write)
    rel = str(file_path.relative_to(workspace.resolve())).replace("\\", "/")
    _log.info("apps.file_written", slug=slug, path=rel, size=stat.st_size)
    return AppFileEntry(
        path=rel,
        size=stat.st_size,
        modified_at=datetime.fromtimestamp(
            stat.st_mtime, tz=UTC,
        ).isoformat(),
    )

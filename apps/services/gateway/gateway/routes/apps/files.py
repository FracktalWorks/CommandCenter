"""Custom Apps · files — workspace passthrough for the Workshop (edit-gated).

Flat listing + text read/write over an app's workspace, containment-guarded by
``resolve_app_file`` (traversal, dotfiles, ``.git``, symlink escapes). The
Workshop's code view and the preview pane's draft fetch ride these; published
bundles are served from ``app_versions`` instead (see ``publish.py``). Reads
resolve the workspace through ``durability.ensure_workspace`` (lazy rehydrate
from ``app_files``) and writes mirror the file back into that store.
"""

from __future__ import annotations

import asyncio
import os
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from acb_auth import UserContext
from fastapi import Depends, HTTPException, Query
from fastapi.responses import PlainTextResponse
from gateway.routes.apps._common import (
    MAX_SOURCE_FILE_BYTES,
    MAX_WORKSPACE_FILES,
    WORKSPACE_SKIP_DIRS,
    _get_db,
    _log,
    get_app_or_404,
    require_app_user,
    resolve_app_file,
    router,
)
from gateway.routes.apps.durability import ensure_workspace, mirror_app_file
from pydantic import BaseModel


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
            if not d.startswith(".") and d not in WORKSPACE_SKIP_DIRS
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
            if len(entries) >= MAX_WORKSPACE_FILES:
                return entries
    return entries


async def _edit_workspace(slug: str, user: UserContext) -> tuple[Any, Path]:
    """Edit-gated row + workspace path — rehydrated from ``app_files`` first
    when the on-disk draft is missing (the durability choke point)."""
    db = await _get_db()
    try:
        row, _grants = await get_app_or_404(db, slug, user, edit=True)
        workspace = await ensure_workspace(db, row)
    finally:
        await db.close()
    return row, workspace


@router.get("/{slug}/files", response_model=list[AppFileEntry])
async def list_app_files(
    slug: str,
    user: UserContext = Depends(require_app_user),
) -> list[AppFileEntry]:
    _row, workspace = await _edit_workspace(slug, user)
    return await asyncio.get_event_loop().run_in_executor(
        None, _walk_files, workspace,
    )


@router.get("/{slug}/files/content")
async def read_app_file(
    slug: str,
    path: str = Query(..., description="Relative path within the workspace"),
    user: UserContext = Depends(require_app_user),
) -> PlainTextResponse:
    _row, workspace = await _edit_workspace(slug, user)
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
    row, workspace = await _edit_workspace(slug, user)
    file_path = resolve_app_file(workspace, body.path)

    def _write() -> os.stat_result:
        file_path.parent.mkdir(parents=True, exist_ok=True)
        file_path.write_bytes(data)
        return file_path.stat()

    stat = await asyncio.get_event_loop().run_in_executor(None, _write)
    rel = str(file_path.relative_to(workspace.resolve())).replace("\\", "/")
    # Durability write-through: mirror just this file into app_files
    # (best-effort — a full reconcile rides POST /{slug}/sync and publish).
    await mirror_app_file(str(row.id), rel, body.content)
    _log.info("apps.file_written", slug=slug, path=rel, size=stat.st_size)
    return AppFileEntry(
        path=rel,
        size=stat.st_size,
        modified_at=datetime.fromtimestamp(
            stat.st_mtime, tz=UTC,
        ).isoformat(),
    )

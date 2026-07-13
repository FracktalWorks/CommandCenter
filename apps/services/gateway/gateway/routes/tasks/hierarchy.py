"""Tasks · hierarchy — the LOCAL Space→Folder→Project tree (spec, Process
deepening Phase 3).

LOCAL projects nest like the connected PM tool: Space → Folder → Project →
Task → Subtask. This module serves that local tree and creates its nodes.

SYNCED projects are NOT here — their tree is the provider's own
(task_accounts.schema_cache, surfaced via GET /tasks/accounts). The Projects
view composes both: a "Local" section from GET /tasks/hierarchy and one section
per connected workspace from the account hierarchy.
"""

from __future__ import annotations

from typing import Any
from uuid import uuid4

from acb_auth import UserContext, get_current_user
from fastapi import Depends, HTTPException
from gateway.routes.tasks.core import _get_db, _uid, router
from pydantic import BaseModel
from sqlalchemy import text


class SpaceModel(BaseModel):
    id: str
    name: str


class FolderModel(BaseModel):
    id: str
    space_id: str
    name: str


class LocalProjectNode(BaseModel):
    id: str
    outcome: str
    space_id: str | None = None
    folder_id: str | None = None
    has_next_action: bool = False
    status: str = "ACTIVE"


class LocalHierarchy(BaseModel):
    """The full LOCAL tree in one payload. The client nests projects under their
    space/folder; projects with no space fall under a synthetic bucket."""
    spaces: list[SpaceModel]
    folders: list[FolderModel]
    projects: list[LocalProjectNode]


@router.get("/hierarchy", response_model=LocalHierarchy)
async def local_hierarchy(user: UserContext = Depends(get_current_user)):
    """The user's LOCAL spaces, folders, and LOCAL projects (flat lists the
    client assembles into a tree). SYNCED projects are excluded — their tree
    lives on the connected account."""
    uid = _uid(user)
    db = await _get_db()
    try:
        spaces = (await db.execute(
            text("""SELECT id, name FROM gtd_spaces WHERE user_id = :uid
                    ORDER BY sort_key ASC NULLS LAST, name"""),
            {"uid": uid},
        )).fetchall()
        folders = (await db.execute(
            text("""SELECT id, space_id, name FROM gtd_folders
                    WHERE user_id = :uid
                    ORDER BY sort_key ASC NULLS LAST, name"""),
            {"uid": uid},
        )).fetchall()
        projects = (await db.execute(
            text("""SELECT id, outcome, space_id, folder_id,
                           has_next_action, status
                      FROM gtd_projects
                     WHERE user_id = :uid AND source = 'LOCAL'
                       AND status <> 'DROPPED'
                     ORDER BY created_at DESC"""),
            {"uid": uid},
        )).fetchall()
        return LocalHierarchy(
            spaces=[SpaceModel(id=str(s.id), name=s.name) for s in spaces],
            folders=[FolderModel(id=str(f.id), space_id=str(f.space_id),
                                 name=f.name) for f in folders],
            projects=[LocalProjectNode(
                id=str(p.id), outcome=p.outcome,
                space_id=str(p.space_id) if p.space_id else None,
                folder_id=str(p.folder_id) if p.folder_id else None,
                has_next_action=bool(p.has_next_action),
                status=p.status) for p in projects],
        )
    finally:
        await db.close()


class CreateSpaceRequest(BaseModel):
    name: str


@router.post("/spaces", response_model=SpaceModel, status_code=201)
async def create_space(
    req: CreateSpaceRequest,
    user: UserContext = Depends(get_current_user),
):
    name = req.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="Space needs a name")
    uid = _uid(user)
    db = await _get_db()
    try:
        sid = str(uuid4())
        await db.execute(
            text("""INSERT INTO gtd_spaces (id, user_id, name)
                    VALUES (:id, :uid, :name)"""),
            {"id": sid, "uid": uid, "name": name},
        )
        await db.commit()
        return SpaceModel(id=sid, name=name)
    finally:
        await db.close()


class CreateFolderRequest(BaseModel):
    space_id: str
    name: str


@router.post("/folders", response_model=FolderModel, status_code=201)
async def create_folder(
    req: CreateFolderRequest,
    user: UserContext = Depends(get_current_user),
):
    name = req.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="Folder needs a name")
    uid = _uid(user)
    db = await _get_db()
    try:
        await _assert_space_owner(db, req.space_id, uid)
        fid = str(uuid4())
        await db.execute(
            text("""INSERT INTO gtd_folders (id, user_id, space_id, name)
                    VALUES (:id, :uid, :sid, :name)"""),
            {"id": fid, "uid": uid, "sid": req.space_id, "name": name},
        )
        await db.commit()
        return FolderModel(id=fid, space_id=req.space_id, name=name)
    finally:
        await db.close()


class CreateLocalProjectRequest(BaseModel):
    outcome: str
    space_id: str | None = None
    folder_id: str | None = None
    purpose: str | None = None


@router.post("/local-projects", response_model=LocalProjectNode,
             status_code=201)
async def create_local_project(
    req: CreateLocalProjectRequest,
    user: UserContext = Depends(get_current_user),
):
    """Create a LOCAL project, optionally placed in a space/folder. A folder
    implies its space, so we resolve the space from the folder when given."""
    outcome = req.outcome.strip()
    if not outcome:
        raise HTTPException(status_code=400, detail="Project needs an outcome")
    uid = _uid(user)
    db = await _get_db()
    try:
        space_id = req.space_id
        folder_id = req.folder_id
        if folder_id:
            # A folder pins the space — verify ownership and inherit its space.
            folder = (await db.execute(
                text("""SELECT space_id FROM gtd_folders
                        WHERE id = :id AND user_id = :uid"""),
                {"id": folder_id, "uid": uid},
            )).fetchone()
            if not folder:
                raise HTTPException(status_code=404, detail="Folder not found")
            space_id = str(folder.space_id)
        elif space_id:
            await _assert_space_owner(db, space_id, uid)
        pid = str(uuid4())
        await db.execute(
            text("""INSERT INTO gtd_projects
                    (id, user_id, source, outcome, purpose, status,
                     space_id, folder_id)
                    VALUES (:id, :uid, 'LOCAL', :outcome, :purpose, 'ACTIVE',
                            :sid, :fid)"""),
            {"id": pid, "uid": uid, "outcome": outcome,
             "purpose": (req.purpose or "").strip() or None,
             "sid": space_id, "fid": folder_id},
        )
        await db.commit()
        return LocalProjectNode(
            id=pid, outcome=outcome, space_id=space_id, folder_id=folder_id,
            has_next_action=False, status="ACTIVE")
    finally:
        await db.close()


async def _assert_space_owner(db: Any, space_id: str, uid: str) -> None:
    owned = (await db.execute(
        text("SELECT 1 FROM gtd_spaces WHERE id = :id AND user_id = :uid"),
        {"id": space_id, "uid": uid},
    )).fetchone()
    if not owned:
        raise HTTPException(status_code=404, detail="Space not found")

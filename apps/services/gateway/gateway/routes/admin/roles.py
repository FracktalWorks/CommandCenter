"""Org administration — role definitions and the feature catalog.

Spec: ``project-docs/specs/org_access_control.md`` §3.2–§3.3.

Roles are the reusable half of the model: a bundle of permission patterns with
a name. Per-user overrides (``members.py``) are the exception half. Reaching
for a new role when one person needs one thing removed is how organizations end
up with a role per employee, so the admin UI should steer toward overrides and
this API keeps role creation deliberate.
"""

from __future__ import annotations

from typing import Any

from acb_auth import (
    CAPABILITIES,
    FEATURES,
    InvalidPermission,
    UserContext,
    feature_permission,
    require_permission,
    validate_permission,
)
from fastapi import Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import text

from gateway.routes.admin._common import (
    _log,
    _tenant_session,
    get_org_id,
    get_role,
    invalidate_for,
    record_admin_change,
    require_admin_user,
    router,
)

MAX_CUSTOM_ROLES = 20
_SLUG_MAX = 48


class RoleEntry(BaseModel):
    slug: str
    display_name: str
    description: str = ""
    is_system: bool = False
    rank: int = 100
    permissions: list[str] = Field(default_factory=list)
    member_count: int = 0


class RoleCreate(BaseModel):
    slug: str
    display_name: str
    description: str = ""
    permissions: list[str] = Field(default_factory=list)


class RolePatch(BaseModel):
    display_name: str | None = None
    description: str | None = None
    permissions: list[str] | None = None


def _clean_slug(raw: str) -> str:
    slug = (raw or "").strip().lower().replace(" ", "_")
    if not slug or len(slug) > _SLUG_MAX:
        raise HTTPException(
            status_code=400, detail=f"slug must be 1–{_SLUG_MAX} characters."
        )
    if not all(c.isalnum() or c in "_-" for c in slug):
        raise HTTPException(
            status_code=400,
            detail="slug may contain only letters, digits, '_' and '-'.",
        )
    return slug


def _clean_permissions(raw: list[str]) -> list[str]:
    out: list[str] = []
    for entry in raw:
        try:
            perm = validate_permission(entry)
        except InvalidPermission as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        if perm not in out:
            out.append(perm)
    return out


async def _permissions_for(db: Any, role_id: str) -> list[str]:
    rows = (
        await db.execute(
            text(
                "SELECT permission FROM org_role_permission "
                " WHERE role_id = CAST(:rid AS uuid) ORDER BY permission"
            ),
            {"rid": role_id},
        )
    ).scalars().all()
    return list(rows)


@router.get("/roles", summary="List roles with their permissions")
async def list_roles(
    admin: UserContext = Depends(require_admin_user),
) -> list[RoleEntry]:
    async with _tenant_session() as db:
        org_id = await get_org_id(db, admin)
        rows = (
            await db.execute(
                text(
                    "SELECT r.id::text AS id, r.slug, r.display_name, r.description, "
                    "       r.is_system, r.rank, "
                    "       COALESCE("
                    "         (SELECT array_agg(rp.permission ORDER BY rp.permission)"
                    "            FROM org_role_permission rp WHERE rp.role_id = r.id),"
                    "         ARRAY[]::text[]) AS permissions, "
                    "       (SELECT count(*) FROM user_role ur WHERE ur.role_id = r.id) "
                    "         AS member_count "
                    "  FROM org_role r "
                    " WHERE r.organization_id = CAST(:org AS uuid) "
                    " ORDER BY r.rank, r.slug"
                ),
                {"org": org_id},
            )
        ).mappings().all()

    return [
        RoleEntry(
            slug=r["slug"],
            display_name=r["display_name"],
            description=r["description"] or "",
            is_system=bool(r["is_system"]),
            rank=int(r["rank"]),
            permissions=list(r["permissions"] or []),
            member_count=int(r["member_count"] or 0),
        )
        for r in rows
    ]


@router.post("/roles", summary="Create a custom role",
             dependencies=[require_permission("admin:roles:manage")])
async def create_role(
    req: RoleCreate,
    admin: UserContext = Depends(require_admin_user),
) -> RoleEntry:
    slug = _clean_slug(req.slug)
    permissions = _clean_permissions(req.permissions)

    async with _tenant_session() as db:
        org_id = await get_org_id(db, admin)
        existing = (
            await db.execute(
                text(
                    "SELECT count(*) FROM org_role "
                    " WHERE organization_id = CAST(:org AS uuid) AND is_system = false"
                ),
                {"org": org_id},
            )
        ).scalar() or 0
        if int(existing) >= MAX_CUSTOM_ROLES:
            raise HTTPException(
                status_code=409,
                detail=(
                    f"Custom role limit ({MAX_CUSTOM_ROLES}) reached. Per-user "
                    "overrides are the right tool for one-off exceptions."
                ),
            )

        clash = (
            await db.execute(
                text(
                    "SELECT 1 FROM org_role "
                    " WHERE organization_id = CAST(:org AS uuid) AND slug = :slug"
                ),
                {"org": org_id, "slug": slug},
            )
        ).first()
        if clash:
            raise HTTPException(status_code=409, detail=f"Role '{slug}' already exists.")

        # Custom roles always rank below the seeded system roles: a custom role
        # must not be able to out-rank `admin` and defeat the assignment check.
        row = (
            await db.execute(
                text(
                    "INSERT INTO org_role (organization_id, slug, display_name, "
                    "                      description, is_system, rank) "
                    "VALUES (CAST(:org AS uuid), :slug, :name, :desc, false, 50) "
                    "RETURNING id::text AS id"
                ),
                {"org": org_id, "slug": slug, "name": req.display_name or slug,
                 "desc": req.description or ""},
            )
        ).mappings().first()
        role_id = row["id"]
        for perm in permissions:
            await db.execute(
                text(
                    "INSERT INTO org_role_permission (role_id, permission) "
                    "VALUES (CAST(:rid AS uuid), :perm) ON CONFLICT DO NOTHING"
                ),
                {"rid": role_id, "perm": perm},
            )

    _log.info("role_created", slug=slug, by=admin.email, permissions=permissions)
    record_admin_change(admin.email, "org.role_created", f"role:{slug}",
                        permissions=permissions)
    return RoleEntry(
        slug=slug,
        display_name=req.display_name or slug,
        description=req.description or "",
        rank=50,
        permissions=permissions,
    )


@router.patch("/roles/{slug}", summary="Edit a custom role",
              dependencies=[require_permission("admin:roles:manage")])
async def update_role(
    slug: str,
    patch: RolePatch,
    admin: UserContext = Depends(require_admin_user),
) -> RoleEntry:
    async with _tenant_session() as db:
        org_id = await get_org_id(db, admin)
        role = await get_role(db, org_id, slug)
        if role["is_system"]:
            raise HTTPException(
                status_code=403,
                detail=(
                    f"'{slug}' is a system role and cannot be edited. Create a "
                    "custom role, or use per-user overrides."
                ),
            )

        if patch.display_name is not None or patch.description is not None:
            await db.execute(
                text(
                    "UPDATE org_role SET "
                    "  display_name = COALESCE(:name, display_name), "
                    "  description  = COALESCE(:desc, description), "
                    "  updated_at   = now() "
                    " WHERE id = CAST(:rid AS uuid)"
                ),
                {"name": patch.display_name, "desc": patch.description,
                 "rid": role["id"]},
            )

        if patch.permissions is not None:
            permissions = _clean_permissions(patch.permissions)
            await db.execute(
                text("DELETE FROM org_role_permission WHERE role_id = CAST(:rid AS uuid)"),
                {"rid": role["id"]},
            )
            for perm in permissions:
                await db.execute(
                    text(
                        "INSERT INTO org_role_permission (role_id, permission) "
                        "VALUES (CAST(:rid AS uuid), :perm) ON CONFLICT DO NOTHING"
                    ),
                    {"rid": role["id"], "perm": perm},
                )
        permissions = await _permissions_for(db, role["id"])
        role = await get_role(db, org_id, slug)

    # Editing a role changes access for everyone holding it — the per-email
    # cache cannot be targeted, so clear it wholesale.
    invalidate_for(None)
    _log.info("role_updated", slug=slug, by=admin.email)
    record_admin_change(admin.email, "org.role_updated", f"role:{slug}",
                        permissions=permissions)
    return RoleEntry(
        slug=role["slug"],
        display_name=role["display_name"],
        description=role["description"] or "",
        is_system=bool(role["is_system"]),
        rank=int(role["rank"]),
        permissions=permissions,
    )


@router.delete("/roles/{slug}", summary="Delete a custom role",
               dependencies=[require_permission("admin:roles:manage")])
async def delete_role(
    slug: str,
    admin: UserContext = Depends(require_admin_user),
) -> dict[str, str]:
    async with _tenant_session() as db:
        org_id = await get_org_id(db, admin)
        role = await get_role(db, org_id, slug)
        if role["is_system"]:
            raise HTTPException(
                status_code=403, detail=f"'{slug}' is a system role and cannot be deleted."
            )
        holders = (
            await db.execute(
                text("SELECT count(*) FROM user_role WHERE role_id = CAST(:rid AS uuid)"),
                {"rid": role["id"]},
            )
        ).scalar() or 0
        if int(holders):
            # Silently unassigning N people is a bigger action than the admin
            # asked for; make them reassign first.
            raise HTTPException(
                status_code=409,
                detail=f"{holders} member(s) still hold '{slug}'. Reassign them first.",
            )
        await db.execute(
            text("DELETE FROM org_role WHERE id = CAST(:rid AS uuid)"),
            {"rid": role["id"]},
        )

    invalidate_for(None)
    _log.info("role_deleted", slug=slug, by=admin.email)
    record_admin_change(admin.email, "org.role_deleted", f"role:{slug}")
    return {"status": "deleted", "slug": slug}


@router.get("/features", summary="Feature catalog + permission vocabulary")
async def list_features(
    admin: UserContext = Depends(require_admin_user),
) -> dict[str, Any]:
    """What the admin UI renders its checklists from.

    Falls back to the vocabulary compiled into ``acb_auth`` if the catalog
    table is absent, so the access editor still works on a deployment that has
    not applied migration 128 yet.
    """
    features: list[dict[str, Any]] = []
    try:
        async with _tenant_session() as db:
            rows = (
                await db.execute(
                    text(
                        "SELECT slug, label, description, nav_href, category, "
                        "       sort_order, is_default "
                        "  FROM feature_catalog ORDER BY category, sort_order"
                    )
                )
            ).mappings().all()
        features = [
            dict(r) | {"permission": feature_permission(r["slug"])} for r in rows
        ]
    except Exception:  # noqa: BLE001
        features = [
            {"slug": f, "label": f, "description": "", "nav_href": "",
             "category": "apps", "sort_order": 100, "is_default": False,
             "permission": feature_permission(f)}
            for f in FEATURES
        ]

    return {"features": features, "capabilities": list(CAPABILITIES)}

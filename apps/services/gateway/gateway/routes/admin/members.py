"""Org administration — member roster, lifecycle, roles, and per-user access.

Spec: ``ai-company-brain/specs/org_access_control.md`` §6.

The interesting endpoint here is ``GET /admin/members/{email}/access``: it
returns not just *what* the member can reach but *why* — which role granted it,
or which override took it away. An admin who has to simulate the resolution
algorithm in their head to answer "why can Priya still see WhatsApp?" will stop
trusting the model, so provenance is part of the API, not a debugging aid.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from acb_auth import (
    CAPABILITIES,
    FEATURES,
    EffectiveAccess,
    InvalidPermission,
    UserContext,
    agent_run_permission,
    build_access,
    feature_permission,
    require_permission,
    validate_permission,
)
from acb_auth.permissions import matched_by
from fastapi import Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import text

from gateway.routes.admin._common import (
    NON_ASSIGNABLE_ROLES,
    _log,
    assert_owner_survives,
    caller_rank,
    get_db,
    get_member,
    get_org_id,
    invalidate_for,
    require_admin_user,
    roles_for_user,
    router,
)

VALID_STATUSES = ("invited", "active", "suspended", "removed")


# ── Models ──────────────────────────────────────────────────────────────────

class MemberEntry(BaseModel):
    email: str
    display_name: str = ""
    avatar_url: str = ""
    status: str = "active"
    roles: list[str] = Field(default_factory=list)
    invited_by: str = ""
    joined_at: str = ""
    last_login_at: str = ""


class InviteRequest(BaseModel):
    email: str
    display_name: str = ""
    #: Role slugs to assign. Empty means the seeded default, `member`.
    roles: list[str] = Field(default_factory=list)


class MemberPatch(BaseModel):
    status: str | None = None
    display_name: str | None = None


class RoleAssignment(BaseModel):
    roles: list[str]


class OverrideEntry(BaseModel):
    permission: str
    effect: str          # allow | deny
    reason: str = ""


class OverrideRequest(BaseModel):
    """Full replacement of a member's overrides — PUT semantics.

    Replace rather than merge so the admin UI can send exactly what the
    checkboxes show. A merge API makes "unset this deny" a second verb nobody
    remembers to call.
    """

    overrides: list[OverrideEntry]


def _iso(value: Any) -> str:
    if isinstance(value, datetime):
        return value.astimezone(timezone.utc).isoformat()
    return "" if value is None else str(value)


# ── Roster ──────────────────────────────────────────────────────────────────

@router.get("/members", summary="List organization members")
async def list_members(
    include_removed: bool = False,
    admin: UserContext = Depends(require_admin_user),
) -> list[MemberEntry]:
    db = await get_db()
    async with db:
        org_id = await get_org_id(db)
        sql = (
            "SELECT u.id::text AS id, u.email, u.display_name, u.avatar_url, "
            "       u.status, u.invited_by, u.joined_at, u.last_login_at, "
            "       COALESCE("
            "         (SELECT array_agg(r.slug ORDER BY r.rank)"
            "            FROM user_role ur JOIN org_role r ON r.id = ur.role_id"
            "           WHERE ur.user_id = u.id), ARRAY[]::text[]) AS roles "
            "  FROM app_user u "
            " WHERE u.organization_id = CAST(:org AS uuid) "
        )
        if not include_removed:
            sql += " AND u.status <> 'removed' "
        sql += " ORDER BY u.email"
        rows = (await db.execute(text(sql), {"org": org_id})).mappings().all()

    return [
        MemberEntry(
            email=r["email"],
            display_name=r["display_name"] or "",
            avatar_url=r["avatar_url"] or "",
            status=r["status"],
            roles=list(r["roles"] or []),
            invited_by=r["invited_by"] or "",
            joined_at=_iso(r["joined_at"]),
            last_login_at=_iso(r["last_login_at"]),
        )
        for r in rows
    ]


@router.post("/members", summary="Invite a member",
             dependencies=[require_permission("admin:members:invite")])
async def invite_member(
    req: InviteRequest,
    admin: UserContext = Depends(require_admin_user),
) -> MemberEntry:
    """Create (or re-activate) a member row in the `invited` state.

    No email is sent — sign-in is Entra ID SSO, so "inviting" means
    provisioning the row that turns a directory identity into a member with
    access. Until that row exists, an authenticated stranger resolves to no
    access (``resolve_access`` returns inactive for an unknown email).
    """
    email = (req.email or "").strip().lower()
    if "@" not in email or len(email) > 254:
        raise HTTPException(status_code=400, detail="A valid email is required.")

    db = await get_db()
    async with db:
        org_id = await get_org_id(db)
        wanted = req.roles or ["member"]
        role_ids = await _resolve_assignable_roles(db, org_id, wanted, admin)

        await db.execute(
            text(
                "INSERT INTO app_user (email, display_name, organization_id, "
                "                      status, invited_by, invited_at) "
                "VALUES (:email, :name, CAST(:org AS uuid), 'invited', :by, now()) "
                "ON CONFLICT (email) DO UPDATE "
                "   SET organization_id = EXCLUDED.organization_id, "
                "       display_name    = COALESCE(NULLIF(EXCLUDED.display_name, ''), "
                "                                  app_user.display_name), "
                "       status          = CASE WHEN app_user.status = 'removed' "
                "                              THEN 'invited' ELSE app_user.status END, "
                "       updated_at      = now()"
            ),
            {"email": email, "name": req.display_name or "", "org": org_id,
             "by": admin.email},
        )
        member = await get_member(db, email)
        await _set_roles(db, member["id"], role_ids, admin.email)
        await db.commit()
        roles = await roles_for_user(db, member["id"])

    invalidate_for(email)
    _log.info("member_invited", email=email, by=admin.email, roles=roles)
    return MemberEntry(
        email=email,
        display_name=req.display_name or "",
        status="invited",
        roles=roles,
        invited_by=admin.email or "",
    )


@router.patch("/members/{email}", summary="Update a member's status or name",
              dependencies=[require_permission("admin:members:manage")])
async def update_member(
    email: str,
    patch: MemberPatch,
    admin: UserContext = Depends(require_admin_user),
) -> MemberEntry:
    if patch.status is not None and patch.status not in VALID_STATUSES:
        raise HTTPException(
            status_code=400,
            detail=f"status must be one of {list(VALID_STATUSES)}.",
        )

    db = await get_db()
    async with db:
        org_id = await get_org_id(db)
        member = await get_member(db, email)

        # Suspending or removing the last owner locks everyone out of admin.
        if patch.status in ("suspended", "removed"):
            await assert_owner_survives(db, org_id, excluding_user_id=member["id"])

        if patch.status is not None:
            await db.execute(
                text(
                    "UPDATE app_user SET status = :status, updated_at = now(), "
                    "  joined_at = CASE WHEN :status = 'active' "
                    "                   THEN COALESCE(joined_at, now()) ELSE joined_at END "
                    " WHERE id = CAST(:uid AS uuid)"
                ),
                {"status": patch.status, "uid": member["id"]},
            )
        if patch.display_name is not None:
            await db.execute(
                text(
                    "UPDATE app_user SET display_name = :name, updated_at = now() "
                    " WHERE id = CAST(:uid AS uuid)"
                ),
                {"name": patch.display_name, "uid": member["id"]},
            )
        await db.commit()
        member = await get_member(db, email)
        roles = await roles_for_user(db, member["id"])

    invalidate_for(member["email"])
    _log.info("member_updated", email=member["email"], by=admin.email,
              status=member["status"])
    return MemberEntry(
        email=member["email"],
        display_name=member["display_name"] or "",
        avatar_url=member["avatar_url"] or "",
        status=member["status"],
        roles=roles,
        invited_by=member["invited_by"] or "",
        joined_at=_iso(member["joined_at"]),
        last_login_at=_iso(member["last_login_at"]),
    )


@router.delete("/members/{email}", summary="Remove a member",
               dependencies=[require_permission("admin:members:manage")])
async def remove_member(
    email: str,
    admin: UserContext = Depends(require_admin_user),
) -> dict[str, str]:
    """Soft-remove: status → `removed`, role assignments dropped.

    The row is kept because ~every user-scoped table in the schema references
    people by email (`apps.owner_email`, `app_audit.user_email`, chat sessions,
    GTD items). Hard-deleting the identity would orphan all of it; what
    actually matters for access is that the member resolves to nothing, which
    the `removed` status guarantees.
    """
    db = await get_db()
    async with db:
        org_id = await get_org_id(db)
        member = await get_member(db, email)
        if (member["email"] or "").lower() == (admin.email or "").lower():
            raise HTTPException(
                status_code=409, detail="You cannot remove yourself."
            )
        await assert_owner_survives(db, org_id, excluding_user_id=member["id"])

        await db.execute(
            text("DELETE FROM user_role WHERE user_id = CAST(:uid AS uuid)"),
            {"uid": member["id"]},
        )
        await db.execute(
            text(
                "UPDATE app_user SET status = 'removed', updated_at = now() "
                " WHERE id = CAST(:uid AS uuid)"
            ),
            {"uid": member["id"]},
        )
        await db.commit()

    invalidate_for(member["email"])
    _log.info("member_removed", email=member["email"], by=admin.email)
    return {"status": "removed", "email": member["email"]}


# ── Role assignment ─────────────────────────────────────────────────────────

async def _resolve_assignable_roles(
    db: Any, org_id: str, slugs: list[str], admin: UserContext
) -> list[tuple[str, str]]:
    """Validate role slugs and return ``[(role_id, slug)]``.

    Enforces invariant 2: an admin cannot assign a role more privileged than
    their own, so `admin` cannot mint an `owner` and escalate laterally.
    """
    if not slugs:
        raise HTTPException(status_code=400, detail="At least one role is required.")

    rows = (
        await db.execute(
            text(
                "SELECT id::text AS id, slug, rank FROM org_role "
                " WHERE organization_id = CAST(:org AS uuid) AND slug = ANY(:slugs)"
            ),
            {"org": org_id, "slugs": list(slugs)},
        )
    ).mappings().all()

    found = {r["slug"]: r for r in rows}
    missing = [s for s in slugs if s not in found]
    if missing:
        raise HTTPException(status_code=400, detail=f"Unknown role(s): {missing}.")

    blocked = [s for s in slugs if s in NON_ASSIGNABLE_ROLES]
    if blocked:
        raise HTTPException(
            status_code=400,
            detail=f"Role(s) {blocked} are internal and cannot be assigned to people.",
        )

    my_rank = await caller_rank(db, org_id, admin)
    too_high = [s for s in slugs if int(found[s]["rank"]) < my_rank]
    if too_high:
        raise HTTPException(
            status_code=403,
            detail=f"You cannot assign role(s) {too_high} — they outrank you.",
        )
    return [(found[s]["id"], s) for s in slugs]


async def _set_roles(
    db: Any, user_id: str, role_ids: list[tuple[str, str]], assigned_by: str | None
) -> None:
    await db.execute(
        text("DELETE FROM user_role WHERE user_id = CAST(:uid AS uuid)"),
        {"uid": user_id},
    )
    for role_id, _slug in role_ids:
        await db.execute(
            text(
                "INSERT INTO user_role (user_id, role_id, assigned_by) "
                "VALUES (CAST(:uid AS uuid), CAST(:rid AS uuid), :by) "
                "ON CONFLICT DO NOTHING"
            ),
            {"uid": user_id, "rid": role_id, "by": assigned_by},
        )


@router.put("/members/{email}/roles", summary="Set a member's roles",
            dependencies=[require_permission("admin:members:manage")])
async def set_member_roles(
    email: str,
    req: RoleAssignment,
    admin: UserContext = Depends(require_admin_user),
) -> MemberEntry:
    db = await get_db()
    async with db:
        org_id = await get_org_id(db)
        member = await get_member(db, email)
        role_ids = await _resolve_assignable_roles(db, org_id, req.roles, admin)

        # Demoting the last owner is the same lockout as removing them.
        if "owner" not in req.roles:
            await assert_owner_survives(db, org_id, excluding_user_id=member["id"])

        await _set_roles(db, member["id"], role_ids, admin.email)

        # Keep the legacy coarse column truthful so require_role() and any
        # not-yet-migrated route agree with the new model (spec §7).
        legacy = "executive" if any(
            s in ("owner", "admin") for _rid, s in role_ids
        ) else "employee"
        await db.execute(
            text(
                "UPDATE app_user SET role = :role, updated_at = now() "
                " WHERE id = CAST(:uid AS uuid)"
            ),
            {"role": legacy, "uid": member["id"]},
        )
        await db.commit()
        roles = await roles_for_user(db, member["id"])

    invalidate_for(member["email"])
    _log.info("member_roles_set", email=member["email"], by=admin.email, roles=roles)
    return MemberEntry(
        email=member["email"],
        display_name=member["display_name"] or "",
        status=member["status"],
        roles=roles,
    )


# ── Per-user access + overrides ─────────────────────────────────────────────

async def _load_overrides(db: Any, user_id: str) -> list[dict[str, Any]]:
    rows = (
        await db.execute(
            text(
                "SELECT permission, effect, reason, set_by, set_at "
                "  FROM user_permission_override "
                " WHERE user_id = CAST(:uid AS uuid) ORDER BY permission"
            ),
            {"uid": user_id},
        )
    ).mappings().all()
    return [dict(r) for r in rows]


async def _role_permission_map(db: Any, user_id: str) -> dict[str, list[str]]:
    """``{role_slug: [permission, ...]}`` for the member's assigned roles."""
    rows = (
        await db.execute(
            text(
                "SELECT r.slug AS slug, rp.permission AS permission "
                "  FROM user_role ur "
                "  JOIN org_role r            ON r.id = ur.role_id "
                "  JOIN org_role_permission rp ON rp.role_id = r.id "
                " WHERE ur.user_id = CAST(:uid AS uuid)"
            ),
            {"uid": user_id},
        )
    ).mappings().all()
    out: dict[str, list[str]] = {}
    for r in rows:
        out.setdefault(r["slug"], []).append(r["permission"])
    return out


def _agent_names() -> list[str]:
    """Registered agent names, static + dynamic. Best-effort.

    Imported lazily: the admin package must not fail to load because the agent
    registry is unavailable — an access screen that 500s is worse than one
    that shows only feature toggles.
    """
    try:
        from gateway.routes.agent import (  # noqa: PLC0415
            _AGENT_REGISTRY,
            _load_dynamic_agents,
        )

        names = {a["name"] for a in _AGENT_REGISTRY}
        try:
            names |= {a["name"] for a in _load_dynamic_agents()}
        except Exception:  # noqa: BLE001
            pass
        return sorted(names)
    except Exception:  # noqa: BLE001
        return []


def _explain(
    access: EffectiveAccess, permission: str, role_perms: dict[str, list[str]]
) -> dict[str, Any]:
    """Resolve one permission and name what decided it."""
    decision = access.decide(permission)
    via_role = ""
    if decision.source == "role" and decision.pattern:
        # Name the role that contributed the deciding pattern, so the UI can
        # say "granted by role member" rather than "granted by feature:chat".
        for slug, perms in role_perms.items():
            if decision.pattern in perms:
                via_role = slug
                break
    return {
        "permission": permission,
        "allowed": decision.allowed,
        "source": decision.source,
        "pattern": decision.pattern or "",
        "via_role": via_role,
    }


@router.get("/members/{email}/access", summary="Resolved access for one member")
async def get_member_access(
    email: str,
    admin: UserContext = Depends(require_admin_user),
) -> dict[str, Any]:
    """The member's effective access, with provenance for every decision."""
    db = await get_db()
    async with db:
        await get_org_id(db)
        member = await get_member(db, email)
        roles = await roles_for_user(db, member["id"])
        role_perms = await _role_permission_map(db, member["id"])
        overrides = await _load_overrides(db, member["id"])

    access = build_access(
        [p for perms in role_perms.values() for p in perms],
        [(o["permission"], o["effect"]) for o in overrides],
        roles=roles,
        is_active=member["status"] == "active",
    )

    return {
        "email": member["email"],
        "display_name": member["display_name"] or "",
        "status": member["status"],
        "roles": roles,
        "granted": sorted(access.granted),
        "denied": sorted(access.denied),
        "features": [
            _explain(access, feature_permission(f), role_perms) | {"slug": f}
            for f in FEATURES
        ],
        "capabilities": [
            _explain(access, c, role_perms) for c in CAPABILITIES
        ],
        "agents": [
            _explain(access, agent_run_permission(n), role_perms) | {"name": n}
            for n in _agent_names()
        ],
        "overrides": [
            {
                "permission": o["permission"],
                "effect": o["effect"],
                "reason": o["reason"] or "",
                "set_by": o["set_by"] or "",
                "set_at": _iso(o["set_at"]),
            }
            for o in overrides
        ],
    }


@router.put("/members/{email}/overrides", summary="Replace a member's overrides",
            dependencies=[require_permission("admin:access:manage")])
async def set_member_overrides(
    email: str,
    req: OverrideRequest,
    admin: UserContext = Depends(require_admin_user),
) -> dict[str, Any]:
    """Replace the member's allow/deny overrides wholesale.

    This is the endpoint behind "no WhatsApp, no app creator, but these two
    agents": deny ``feature:whatsapp`` and ``feature:build.apps``, allow
    ``agents:run:<name>``.
    """
    cleaned: list[tuple[str, str, str]] = []
    seen: set[str] = set()
    for entry in req.overrides:
        if entry.effect not in ("allow", "deny"):
            raise HTTPException(
                status_code=400,
                detail=f"effect must be 'allow' or 'deny', got '{entry.effect}'.",
            )
        try:
            perm = validate_permission(entry.permission)
        except InvalidPermission as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        if perm in seen:
            raise HTTPException(
                status_code=400,
                detail=f"Duplicate override for '{perm}' — one effect per permission.",
            )
        seen.add(perm)
        cleaned.append((perm, entry.effect, entry.reason or ""))

    db = await get_db()
    async with db:
        org_id = await get_org_id(db)
        member = await get_member(db, email)

        # An owner who denies themselves admin cannot undo it from the UI.
        if (member["email"] or "").lower() == (admin.email or "").lower():
            self_denied = [
                p for p, effect, _ in cleaned
                if effect == "deny" and matched_by([p], "admin:access:manage")
            ]
            if self_denied:
                raise HTTPException(
                    status_code=409,
                    detail=(
                        "This would revoke your own access management "
                        "permission. Ask another admin to make this change."
                    ),
                )

        await db.execute(
            text(
                "DELETE FROM user_permission_override WHERE user_id = CAST(:uid AS uuid)"
            ),
            {"uid": member["id"]},
        )
        for perm, effect, reason in cleaned:
            await db.execute(
                text(
                    "INSERT INTO user_permission_override "
                    "  (user_id, permission, effect, reason, set_by) "
                    "VALUES (CAST(:uid AS uuid), :perm, :effect, :reason, :by)"
                ),
                {"uid": member["id"], "perm": perm, "effect": effect,
                 "reason": reason, "by": admin.email},
            )
        await db.commit()
        _ = org_id

    invalidate_for(member["email"])
    _log.info("member_overrides_set", email=member["email"], by=admin.email,
              count=len(cleaned))
    return await get_member_access(member["email"], admin)  # type: ignore[arg-type]

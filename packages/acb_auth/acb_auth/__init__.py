"""RBAC roles, user context, FastAPI dependency helpers (WBS 1.7).

Two guard styles coexist:

* ``require_role(UserRole.EXECUTIVE)`` — the original coarse gate. Unchanged.
* ``require_permission("feature:whatsapp")`` — org access control: DB-backed
  roles plus per-user allow/deny overrides. See
  ``ai-company-brain/specs/org_access_control.md``.
"""
from acb_auth.access import invalidate as invalidate_access
from acb_auth.access import resolve_access
from acb_auth.deps import (
    assert_can_run_agent,
    get_current_user,
    require_any_permission,
    require_feature,
    require_internal_auth,
    require_permission,
    require_role,
)
from acb_auth.permissions import (
    ASSIGNABLE_SYSTEM_ROLES,
    CAPABILITIES,
    FEATURES,
    SYSTEM_ROLES,
    AccessDecision,
    EffectiveAccess,
    InvalidPermission,
    agent_run_permission,
    build_access,
    feature_permission,
    permission_matches,
    validate_permission,
)
from acb_auth.roles import UserContext, UserRole

__all__ = [
    # identity
    "UserRole",
    "UserContext",
    "get_current_user",
    # guards
    "require_role",
    "require_permission",
    "require_any_permission",
    "require_feature",
    "require_internal_auth",
    "assert_can_run_agent",
    # permission model
    "EffectiveAccess",
    "AccessDecision",
    "InvalidPermission",
    "FEATURES",
    "CAPABILITIES",
    "SYSTEM_ROLES",
    "ASSIGNABLE_SYSTEM_ROLES",
    "build_access",
    "feature_permission",
    "agent_run_permission",
    "permission_matches",
    "validate_permission",
    # resolution
    "resolve_access",
    "invalidate_access",
]

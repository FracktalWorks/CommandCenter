"""Org administration routes (prefix ``/admin``) plus ``/auth/me``.

Members, roles, and per-user access overrides for the multi-user organization
model. Spec: ``ai-company-brain/specs/org_access_control.md``.

Layout mirrors ``routes/apps/``: ``_common`` is the leaf (DB, org lookup,
invariants) and the feature modules import from it, never from each other.
"""

from gateway.routes.admin._common import router

# Importing the modules attaches their routes to the shared `router`.
from gateway.routes.admin import members as _members  # noqa: F401,E402
from gateway.routes.admin import roles as _roles      # noqa: F401,E402
from gateway.routes.admin.me import me_router          # noqa: E402

__all__ = ["router", "me_router"]

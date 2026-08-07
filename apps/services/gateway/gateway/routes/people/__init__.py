"""People Center · the directory as its own app.

Spec: ``ai-company-brain/specs/people_center_app.md`` §3, §6 · ticket WS-28b.

    GET /people                 → the directory, searchable and filterable
    GET /people/{id}            → one person, with the login badge
    GET /people/{id}/work       → their open tasks, scoped by the VIEWER

**Why this exists beside ``/tasks/people``.** The read API already shipped
(WS-24 N4) with the HR projection this app needs — but it is gated on
``feature:tasks``, and the People Center is a different audience: a manager who
needs the org chart and the assignee picker should not have to be handed the
personal GTD task manager to get them. So the *gate* is new and the
*projection* is imported, never re-implemented (§6: "a restriction that already
exists and must not be re-implemented here").
"""

# Imported for the side effect that matters: the module's decorators are what
# attach the routes to `router`. Nothing here reads a name from it.
from gateway.routes.people import directory as _directory  # noqa: F401
from gateway.routes.people.core import router

__all__ = ["router"]

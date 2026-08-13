"""People Center · the directory as its own app.

Spec: ``project-docs/specs/people_center_app.md`` §3, §6 · ticket WS-28b.

    GET   /people                 → the directory, searchable and filterable
    GET   /people/me              → the caller's own row, or why there isn't one
    GET   /people/{id}            → one person, with the login badge
    GET   /people/{id}/work       → their open tasks, scoped by the VIEWER
    GET   /people/{id}/editable   → what THIS caller may write on that row
    PATCH /people/{id}            → a class-checked write (admin OR the subject)
    POST  /people/{id}/resume     → the CV, same rule

**Why this exists beside ``/tasks/people``.** The read API already shipped
(WS-24 N4) with the HR projection this app needs — but it is gated on
``feature:tasks``, and the People Center is a different audience: a manager who
needs the org chart and the assignee picker should not have to be handed the
personal GTD task manager to get them. So the *gate* is new and the
*projection* is imported, never re-implemented (§6: "a restriction that already
exists and must not be re-implemented here").
"""

# ruff: noqa: I001 — the import ORDER below is load-bearing and alphabetising
# it (which is exactly what `ruff --fix` would do) breaks `/people/me`. The
# fence is `test_people_profile.test_me_is_registered_before_the_person_id_pattern`,
# which fails on the swapped order rather than leaving this comment to be
# believed.

# Imported for the side effect that matters: each module's decorators are what
# attach its routes to `router`. Nothing here reads a name from either.
#
# ⚠️ **ORDER IS LOAD-BEARING.** FastAPI matches routes in REGISTRATION order,
# and `directory.py` registers `/people/{person_id}`. Imported the other way
# round, that pattern would match the literal path `/people/me` and then fail
# casting "me" to a UUID — a 500 on a route that looks registered. `profile.py`
# therefore goes first, and it imports nothing from `directory` (their shared
# read seam lives in `core.py`) so this order actually holds at runtime.
# `test_people_profile.py` asserts it rather than trusting the comment.
from gateway.routes.people import profile as _profile  # noqa: F401
from gateway.routes.people import directory as _directory  # noqa: F401
from gateway.routes.people.core import router

__all__ = ["router"]

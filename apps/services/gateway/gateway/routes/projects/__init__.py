"""Projects route package — the gateway `/projects` API (native project management).

Spec: ``ai-company-brain/specs/project_management_app.md`` (WS-27a builds §3 + §4).

Same layout as ``routes/crm``, ``routes/tasks`` and ``routes/notes``: ``core`` is
the leaf and the feature modules register their routes on the shared ``router``
as an import side effect.

**Import order is not load-bearing**, for the same reason it is not in
``routes/crm``: every path in this package is a literal (``/projects/tasks/{id}``,
``/projects/nodes/{id}``), never a ``/projects/{kind}/{id}`` template, so no route
can shadow another and alphabetising this list can never change which handler
answers a request.

⚠️ A feature module left out of this list mounts **nothing**, while every test
that calls its route function directly still passes. That trap is documented in
``department_centers.md`` C1 and it is why ``tests/unit/test_projects_routes.py``
asserts the mounted path set rather than only calling the functions.

``sync.py`` is WS-27c (the two-way coexistence sync) and is deliberately absent;
it is blocked on WS-1's BO-1a and BO-1b, which the spec names as prerequisites.
"""

from gateway.routes.projects import activities as _activities  # noqa: F401
from gateway.routes.projects import admin as _admin  # noqa: F401
from gateway.routes.projects import attachments as _attachments  # noqa: F401
from gateway.routes.projects import bulk as _bulk  # noqa: F401
from gateway.routes.projects import calendar as _calendar  # noqa: F401
from gateway.routes.projects import custom_fields as _custom_fields  # noqa: F401
from gateway.routes.projects import import_clickup as _import_clickup  # noqa: F401
from gateway.routes.projects import import_tasks as _import_tasks  # noqa: F401
from gateway.routes.projects import me as _me  # noqa: F401
from gateway.routes.projects import notifications as _notifications  # noqa: F401
from gateway.routes.projects import personal as _personal  # noqa: F401
from gateway.routes.projects import recurrence as _recurrence  # noqa: F401
from gateway.routes.projects import relations as _relations  # noqa: F401
from gateway.routes.projects import tags as _tags  # noqa: F401
from gateway.routes.projects import tasks as _tasks  # noqa: F401
from gateway.routes.projects import tree as _tree  # noqa: F401
from gateway.routes.projects import views as _views  # noqa: F401
from gateway.routes.projects.core import router

__all__ = ["router"]

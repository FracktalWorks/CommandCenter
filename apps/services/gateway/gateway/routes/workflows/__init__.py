"""Workflows route package — the gateway `/workflows` API (visual automation).

Spec: ai-company-brain/specs/workflows_app.md · RFC: docs/workflow-editor/.

``core`` is the leaf; feature modules register routes on the shared ``router``
as an import side effect (the tasks/notes/apps convention). Import order is
load-bearing for routing and MUST NOT be alphabetized: modules with static
single-segment paths (``/catalog``, ``/modules``, ``/hooks``, ``/runs``) must
register before ``crud``'s ``/{workflow_id}`` routes, or FastAPI matches
``GET /workflows/modules`` as ``workflow_id="modules"``.
"""
# ruff: noqa: I001  -- import order is route-registration order (see above)

from gateway.routes.workflows import catalog as _catalog  # noqa: F401
from gateway.routes.workflows import search as _search  # noqa: F401
from gateway.routes.workflows import modules as _modules  # noqa: F401
from gateway.routes.workflows import hooks as _hooks  # noqa: F401
from gateway.routes.workflows import runs as _runs  # noqa: F401
from gateway.routes.workflows import publish as _publish  # noqa: F401
from gateway.routes.workflows import copilot as _copilot  # noqa: F401
from gateway.routes.workflows import crud as _crud  # noqa: F401
from gateway.routes.workflows.core import router
from gateway.routes.workflows.scheduler import (
    start_workflow_scheduler,
    stop_workflow_scheduler,
)

__all__ = ["router", "start_workflow_scheduler", "stop_workflow_scheduler"]

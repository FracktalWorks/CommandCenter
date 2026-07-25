"""Custom Apps route package — the gateway `/apps` API (App Workshop).

Same layout as ``routes/tasks``: ``_common`` is the leaf; the feature modules
register their routes on the shared ``router`` as an import side effect.
RFC: docs/app-workshop/README.md §4.10.
"""

from gateway.routes.apps import durability as _durability  # noqa: F401
from gateway.routes.apps import files as _files  # noqa: F401
from gateway.routes.apps import lifecycle as _lifecycle  # noqa: F401
from gateway.routes.apps import publish as _publish  # noqa: F401
from gateway.routes.apps import runtime as _runtime  # noqa: F401
from gateway.routes.apps import tools as _tools  # noqa: F401
from gateway.routes.apps._common import apps_root, router

__all__ = ["apps_root", "router"]

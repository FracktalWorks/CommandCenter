"""Tasks route package — the gateway `/tasks` API (GTD task manager).

Import order matters only in that ``core`` is the leaf; the feature modules
register their routes on the shared ``router`` as an import side effect.
"""

from gateway.routes.tasks import accounts as _accounts  # noqa: F401
from gateway.routes.tasks import ai as _ai  # noqa: F401
from gateway.routes.tasks import items as _items  # noqa: F401
from gateway.routes.tasks import people as _people  # noqa: F401
from gateway.routes.tasks import sync as _sync  # noqa: F401
from gateway.routes.tasks.core import router

__all__ = ["router"]

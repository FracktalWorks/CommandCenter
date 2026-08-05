"""CRM route package — the gateway `/crm` API (native CRM, Zoho's successor).

Spec: ``ai-company-brain/specs/crm_app.md`` (WS-26a builds §3 + §4).

Same layout as ``routes/tasks`` and ``routes/notes``: ``core`` is the leaf and
the feature modules register their routes on the shared ``router`` as an import
side effect.

Unlike ``routes/workflows``, **import order here is NOT load-bearing**: every
path in this package is a literal per entity (``/crm/leads/{id}``, never
``/crm/{entity}/{id}``), so no route can shadow another and alphabetising this
list can never change which handler answers a request. ``records`` imports
``pipeline`` for the status-transition semantics, which is why Python loads
``pipeline`` first either way.

``import_zoho.py`` is WS-26b and is deliberately absent. ``deal_contacts.py``
is WS-26c's API addendum — the read/write surface for ``crm_deal_contacts``,
which 26a created and only the convert path ever wrote to.
"""

from gateway.routes.crm import activities as _activities  # noqa: F401
from gateway.routes.crm import admin as _admin  # noqa: F401
from gateway.routes.crm import deal_contacts as _deal_contacts  # noqa: F401
from gateway.routes.crm import pipeline as _pipeline  # noqa: F401
from gateway.routes.crm import records as _records  # noqa: F401
from gateway.routes.crm.core import router

__all__ = ["router"]

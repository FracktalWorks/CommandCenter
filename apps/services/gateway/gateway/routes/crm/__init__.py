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

``import_zoho`` (the Zoho backfill + the shared Zoho→native mapping) and
``sync_zoho`` (the two-way sync engine and its ``POST /crm/sync/zoho``) are
WS-26b. ``broker_handlers`` is deliberately NOT imported here: it registers no
routes, and ``main.py`` calls its ``register_crm_broker_handlers()`` directly
at startup exactly the way it calls the tasks app's.
"""

from gateway.routes.crm import activities as _activities  # noqa: F401
from gateway.routes.crm import admin as _admin  # noqa: F401
from gateway.routes.crm import import_zoho as _import_zoho  # noqa: F401
from gateway.routes.crm import pipeline as _pipeline  # noqa: F401
from gateway.routes.crm import records as _records  # noqa: F401
from gateway.routes.crm import sync_zoho as _sync_zoho  # noqa: F401
from gateway.routes.crm.core import router

__all__ = ["router"]

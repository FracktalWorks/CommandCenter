"""The gateway's shared async database seam (BO-10).

This module is now a **re-export of** :mod:`acb_common.db`, which is where the
seam and all of its reasoning live. It stays here because it is the import path
every gateway route package already uses, and because "the gateway's DB seam" is
the name people look for.

Why the seam moved out of the gateway: ``acb_auth.access`` resolves a member's
permissions from Postgres on the request path and runs *inside* this process,
but ``acb_auth`` cannot import ``gateway``. While the seam lived here the
gateway had two pools no matter how many route packages were converted, so the
ticket's "one engine/pool" could not actually be reached. ``acb_common`` is the
one package everything already depends on, so that is where it went.

The gateway makes **zero** ``create_async_engine`` calls of its own — see
``tests/unit/test_db_engine_seam.py``, which fails the build if a new one
appears.
"""

from __future__ import annotations

from acb_common.db import (
    async_database_url,
    engine_connect_args,
    get_db,
    get_engine,
    get_session_factory,
)

__all__ = [
    "async_database_url",
    "engine_connect_args",
    "get_db",
    "get_engine",
    "get_session_factory",
]

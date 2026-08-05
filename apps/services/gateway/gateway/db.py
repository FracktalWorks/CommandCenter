"""The gateway's shared async database seam (BO-10).

The gateway had **twelve** module-level ``create_async_engine`` call sites, one
per app package, each with its own pool that nobody can size, drain or observe
as a whole. The board's standing instruction is that the next app extends a
shared seam rather than adding engine thirteen — so this module exists and
``routes/crm`` consumes only it.

This is the ``routes/tasks/core.py`` block **lifted, not redesigned**: the same
URL coercion, the same pool sizing, the same bounded connect phase. Converting a
consumer to it is therefore a no-op at runtime, which is the property that makes
``routes/tasks/core.py`` usable as the proof that the seam works (D-CRM-4,
``ai-company-brain/specs/crm_app.md`` §4). Converting the other ten call sites
is explicitly out of scope there and is its own chore.

Two rules worth keeping:

* ``sqlalchemy.ext.asyncio`` is imported **inside** the functions, not at module
  scope. Every app package does it that way and the gateway's import graph
  depends on it — importing this module must not drag SQLAlchemy's async stack
  into a process that never opens a connection.
* The engine is created on first use and cached for the process. It is never
  disposed here: the pool's lifetime is the process's, and a ``dispose()`` seam
  would be a way to close connections other request handlers are still using.
"""

from __future__ import annotations

import os
from typing import Any

from acb_common import get_settings

#: Process-wide, created on first use. Module-level rather than app-state so a
#: background loop or a broker handler with no ``Request`` reaches the same pool.
_ENGINE: Any = None
_SESSION_FACTORY: Any = None


def async_database_url() -> str:
    """The configured database URL, coerced onto the asyncpg driver.

    ``DATABASE_URL`` wins over the setting because LiteLLM's Prisma client needs
    the plain ``postgresql://`` form in the environment, so the two disagree by
    design and the environment is the one deploy sets.
    """
    settings = get_settings()
    db_url = os.environ.get("DATABASE_URL", settings.database_url)
    if "postgresql+psycopg" in db_url:
        return db_url.replace("postgresql+psycopg", "postgresql+asyncpg")
    if db_url.startswith("postgresql://"):
        return db_url.replace("postgresql://", "postgresql+asyncpg://")
    return db_url


def get_engine() -> Any:
    """The shared pooled async engine, created on first use."""
    global _ENGINE
    if _ENGINE is None:
        from sqlalchemy.ext.asyncio import create_async_engine

        settings = get_settings()
        _ENGINE = create_async_engine(
            async_database_url(), echo=False, pool_pre_ping=True,
            pool_size=10, max_overflow=20, pool_recycle=1800,
            # Bound the CONNECT phase (asyncpg's `timeout`) so a slow or
            # unreachable DB fails fast instead of stalling request handlers —
            # same ceiling as acb_graph's engine.
            connect_args={"timeout": settings.db_connect_timeout},
        )
    return _ENGINE


def get_session_factory() -> Any:
    """The shared ``async_sessionmaker`` over :func:`get_engine`."""
    global _SESSION_FACTORY
    if _SESSION_FACTORY is None:
        from sqlalchemy.ext.asyncio import async_sessionmaker

        _SESSION_FACTORY = async_sessionmaker(get_engine(), expire_on_commit=False)
    return _SESSION_FACTORY


async def get_db() -> Any:
    """Return a new async session from the shared, pooled engine."""
    return get_session_factory()()

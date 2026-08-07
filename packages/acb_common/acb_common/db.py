"""The one shared async database seam for a process (BO-10).

The gateway had **twelve** module-level ``create_async_engine`` call sites, one
per app package, each with its own pool that nobody could size, drain or observe
as a whole. Their ceilings summed to ~165 connections from a single process,
against a stock Postgres ``max_connections`` of 100 that Langfuse, LiteLLM and
the ingestion services also draw from — so the old arrangement could not
actually be spent, it could only fail. This module is the single seam they now
all resolve through: **one engine, one pool, per process.**

It lives in ``acb_common`` rather than in the gateway because ``acb_common`` is
the one package every service and every ``acb_*`` library already depends on.
``acb_auth.access`` resolves permissions from Postgres on the request path and
runs *inside* the gateway process; while the seam lived in ``gateway.db`` it
could not reach it, so the gateway had two pools no matter how many route
packages were converted. Putting the seam here is what makes "one pool" true
rather than approximately true.

Two rules worth keeping:

* ``sqlalchemy.ext.asyncio`` is imported **inside** the functions, not at module
  scope. Every caller does it that way and the import graphs depend on it —
  importing this module must not drag SQLAlchemy's async stack into a process
  that never opens a connection. That is also why importing ``acb_common`` does
  not import this module.
* The engine is created on first use and cached for the process. It is never
  disposed here: the pool's lifetime is the process's, and a ``dispose()`` seam
  would be a way to close connections other request handlers are still using.
  A process that genuinely owns a short-lived engine (the ingestion scheduler's
  per-run engines) should keep building its own and disposing it, not reach for
  this one.
"""

from __future__ import annotations

import os
from typing import Any

from acb_common.settings import get_settings

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


#: Ceiling on how long one of OUR sessions may sit `idle in transaction`, in ms.
#:
#: This is a lock-release deadline, not a performance knob. SQLAlchemy's
#: ``AsyncSession`` opens a transaction on first ``execute()`` and holds it until
#: commit/rollback/close, so a handler that reads a row and then awaits a slow
#: network call is `idle in transaction` — holding an ACCESS SHARE lock — for the
#: whole call. That is normal and fine. What is not fine is an await that never
#: returns: on 2026-08-06 a hung LLM call pinned one such transaction for 14h44m,
#: a migration's ``ALTER TABLE`` queued behind its lock, and because Postgres's
#: lock queue is FIFO every later reader of that table queued behind the *waiting*
#: ALTER. Sending mail stopped, and the pool drained behind the blocked readers.
#:
#: ⚠️ MUST stay comfortably above the LLM wall-clock worst case, because the email
#: automation package legitimately awaits completions with a session open.
#: ``acb_llm.client`` bounds one call at 3 attempts x 90s + 6s backoff ≈ 276s. At
#: 600s a genuine retrying completion can never trip this, while a hang is capped
#: at ten minutes instead of unbounded. Raise ``LLM_REQUEST_TIMEOUT_SECS`` and you
#: must raise this too — that coupling is the whole reason both numbers are
#: written down next to their reasoning.
_IDLE_IN_TXN_TIMEOUT_MS = "600000"  # 10 minutes


def engine_connect_args() -> dict[str, Any]:
    """Driver-level connect args every engine from this seam shares.

    Two bounds, both about failing instead of hanging:

    * ``timeout`` — asyncpg's CONNECT-phase ceiling, so a slow or unreachable DB
      fails fast rather than stalling request handlers.
    * ``idle_in_transaction_session_timeout`` — the server-side deadline above.
      Set through asyncpg's ``server_settings`` so it rides the connection's
      startup packet and applies to every session from this pool, with no
      migration and no ``ALTER ROLE``. Scoping it to the app's own connections is
      deliberate: ``pg_dump`` and the migration runner connect as the same role
      and must NOT inherit an app-tuned deadline.
    """
    return {
        "timeout": get_settings().db_connect_timeout,
        "server_settings": {
            "idle_in_transaction_session_timeout": _IDLE_IN_TXN_TIMEOUT_MS,
        },
    }


def get_engine() -> Any:
    """The shared pooled async engine, created on first use."""
    global _ENGINE
    if _ENGINE is None:
        from sqlalchemy.ext.asyncio import create_async_engine

        settings = get_settings()
        _ENGINE = create_async_engine(
            async_database_url(), echo=False, pool_pre_ping=True,
            pool_size=settings.db_pool_size,
            max_overflow=settings.db_max_overflow,
            pool_recycle=1800,
            connect_args=engine_connect_args(),
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

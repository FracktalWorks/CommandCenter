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
    """Driver-level connect args every gateway engine should share.

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

        _ENGINE = create_async_engine(
            async_database_url(), echo=False, pool_pre_ping=True,
            pool_size=10, max_overflow=20, pool_recycle=1800,
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

"""SQLAlchemy engine + session factory. Schema lives in infra/postgres/01_schema.sql."""
from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager
from functools import lru_cache

from sqlalchemy import Engine, create_engine
from sqlalchemy.orm import Session, sessionmaker

from acb_common import get_settings


def _engine_kwargs(settings) -> dict:
    """Engine kwargs, with a libpq connect_timeout for Postgres URLs.

    Bounding the CONNECT phase means a slow/firewalled DB host can never hang a
    caller indefinitely (e.g. a best-effort ``acb_audit.record`` write) — it
    fails fast and the caller's error handling takes over. ``connect_timeout``
    is a libpq/psycopg param, so it is only applied to Postgres URLs; sqlite or
    other dialects used in tests are left untouched.
    """
    kwargs: dict = {"pool_pre_ping": True, "future": True}
    if settings.database_url.startswith("postgresql"):
        kwargs["connect_args"] = {"connect_timeout": settings.db_connect_timeout}
    return kwargs


@lru_cache(maxsize=1)
def get_engine() -> Engine:
    settings = get_settings()
    return create_engine(settings.database_url, **_engine_kwargs(settings))


@lru_cache(maxsize=1)
def _session_factory() -> sessionmaker[Session]:
    return sessionmaker(bind=get_engine(), expire_on_commit=False, future=True)


@contextmanager
def get_session() -> Iterator[Session]:
    """Yield a SQLAlchemy session; commit on success, rollback on error."""
    session = _session_factory()()
    try:
        yield session
        session.commit()
    except Exception:
        session.rollback()
        raise
    finally:
        session.close()

"""DB-backed store for runtime-mutable model configuration.

Replaces git-tracked files (``infra/enabled_models.json`` and
``infra/litellm/tier_overrides.yaml``) that ``git reset --hard origin/main``
wiped on every deploy — the reason hidden models kept reappearing and tier
assignments kept reverting.  Config now lives in the ``model_config`` Postgres
table (migration ``35_model_config.sql``) so it survives deploys, restarts, and
reboots.

Blobs are JSON, keyed by config key:
  - ``"enabled_models"`` → ``{"enabled": [...], "hidden": [...]}``
  - ``"tier_overrides"`` → ``{"model_list": [...]}``

Uses a synchronous psycopg connection (no event loop, no extra dependency) so
it can be called from both sync helpers and FastAPI async handlers, mirroring
the URL-parsing approach in ``key_store.py``.
"""
from __future__ import annotations

import json
import re
from typing import Any
from urllib.parse import unquote

from acb_common import get_logger, get_settings

_log = get_logger("model_config")


def _conninfo() -> str:
    """Translate the SQLAlchemy ``database_url`` into a psycopg conninfo string."""
    db_url = str(get_settings().database_url)
    m = re.match(
        r"postgresql(?:\+\w+)?://([^:]+):([^@]+)@([^:/]+):?(\d+)?/(.+)",
        db_url,
    )
    if not m:
        raise RuntimeError(f"Cannot parse database_url: {db_url[:50]}...")
    user, password, host, port, dbname = m.groups()
    return (
        f"host={host} port={port or 5432} dbname={dbname} "
        f"user={user} password={unquote(password)}"
    )


def load_blob(key: str, default: Any = None) -> Any:
    """Return the JSON blob stored under ``key``.

    Returns ``default`` when the row is absent or the DB is unreachable, so
    callers can fall back to a legacy file for one-time seeding.
    """
    import psycopg  # noqa: PLC0415

    try:
        with psycopg.connect(_conninfo(), connect_timeout=5) as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT value FROM model_config WHERE key = %s", (key,)
                )
                row = cur.fetchone()
        if row is None or row[0] is None:
            return default
        val = row[0]
        # psycopg adapts jsonb → dict/list, but tolerate a text value too.
        return json.loads(val) if isinstance(val, str) else val
    except Exception as exc:  # noqa: BLE001
        _log.warning("model_config.load_failed", key=key, error=str(exc))
        return default


def save_blob(key: str, value: Any) -> None:
    """Upsert a JSON blob under ``key``.  Raises on failure so the caller can
    surface a real save error instead of silently losing the change."""
    import psycopg  # noqa: PLC0415

    with psycopg.connect(_conninfo(), connect_timeout=5) as conn:
        with conn.cursor() as cur:
            cur.execute(
                "INSERT INTO model_config (key, value, updated_at) "
                "VALUES (%s, %s::jsonb, now()) "
                "ON CONFLICT (key) DO UPDATE "
                "SET value = EXCLUDED.value, updated_at = now()",
                (key, json.dumps(value)),
            )
        conn.commit()
    _log.info("model_config.saved", key=key)

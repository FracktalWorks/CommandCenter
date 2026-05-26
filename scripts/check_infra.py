"""Ping every infra service and report status. Used by bootstrap and CI.

Usage:
    uv run python scripts/check_infra.py
Exits non-zero if any required service is unreachable.
"""
from __future__ import annotations

import sys
import time
from urllib.error import URLError
from urllib.request import urlopen

import psycopg
import redis

from acb_common import get_settings

OK = "  OK   "
FAIL = "  FAIL "


def _retry(probe, *, attempts: int, delay: float = 2.0) -> bool:
    """Call probe() repeatedly until it returns True or attempts run out."""
    last_err: str | None = None
    for _ in range(attempts):
        try:
            if probe():
                return True
        except Exception as e:  # noqa: BLE001
            last_err = f"{type(e).__name__}: {e}"
        time.sleep(delay)
    if last_err:
        print(f"      last error: {last_err}")
    return False


def check_postgres(url: str) -> bool:
    libpq = url.replace("postgresql+psycopg://", "postgresql://", 1)

    def probe() -> bool:
        with psycopg.connect(libpq, connect_timeout=3) as conn, conn.cursor() as cur:
            cur.execute("select extname from pg_extension;")
            exts = {r[0] for r in cur.fetchall()}
            need = {"vector", "uuid-ossp"}
            missing = need - exts
            if missing:
                print(f"{FAIL}postgres up but missing extensions {sorted(missing)} (found {sorted(exts)})")
                return False
            print(f"{OK}postgres + extensions {sorted(need)}")
            return True

    if _retry(probe, attempts=15):
        return True
    print(f"{FAIL}postgres @ {libpq}")
    return False


def check_redis(url: str) -> bool:
    def probe() -> bool:
        redis.from_url(url, socket_connect_timeout=3).ping()
        print(f"{OK}redis")
        return True
    if _retry(probe, attempts=10):
        return True
    print(f"{FAIL}redis @ {url}")
    return False


def check_litellm(base_url: str) -> bool:
    url = f"{base_url.rstrip('/')}/health/readiness"

    def probe() -> bool:
        with urlopen(url, timeout=3) as r:
            if r.status == 200:
                print(f"{OK}litellm proxy @ {base_url}")
                return True
            return False

    # LiteLLM can take 30-60s on a cold start (Redis cache wiring, prisma).
    if _retry(probe, attempts=30, delay=2):
        return True
    print(f"{FAIL}litellm @ {url}")
    return False


def check_langfuse(host: str) -> bool:
    try:
        with urlopen(f"{host.rstrip('/')}/api/public/health", timeout=3) as r:
            if r.status == 200:
                print(f"{OK}langfuse @ {host}")
                return True
    except URLError as e:
        print(f"  WARN  langfuse @ {host}: {e} (skip if you did not start the obs profile)")
    return True  # langfuse is optional


def main() -> int:
    s = get_settings()
    print(f"env: {s.acb_env}")
    results = [
        check_postgres(s.database_url),
        check_redis(s.redis_url),
        check_litellm(s.litellm_base_url),
        check_langfuse(s.langfuse_host),
    ]
    return 0 if all(results[:3]) else 1


if __name__ == "__main__":
    sys.exit(main())
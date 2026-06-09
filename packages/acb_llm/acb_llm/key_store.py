"""Encrypted provider API key store backed by Postgres.

Single master key (ACB_MASTER_KEY env var or settings.acb_master_key) encrypts
all provider keys at rest.  Keys are decrypted on demand — never logged or
stored in plain text outside this module's in-memory cache.

Usage:
    from acb_llm.key_store import get_key_store

    store = get_key_store()
    await store.put("openai", "sk-...")
    key = await store.get("openai")  # returns plain text key or ""
    await store.delete("openai")
    all_keys = await store.get_all()  # {provider: plain_text_key, ...}
"""
from __future__ import annotations

import base64
import os
from typing import Any

from acb_common import get_logger, get_settings
from cryptography.fernet import Fernet

_log = get_logger("key_store")

# ---------------------------------------------------------------------------
# Master key derivation — Fernet requires a 32-byte url-safe-base64 key.
# We accept a raw passphrase and derive a proper Fernet key from it.
# ---------------------------------------------------------------------------

def _derive_fernet_key(master_key: str) -> bytes:
    """Derive a 32-byte Fernet key from an arbitrary-length master passphrase."""
    from cryptography.hazmat.primitives import hashes
    from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC
    salt = b"acb-provider-keys-v1"
    kdf = PBKDF2HMAC(
        algorithm=hashes.SHA256(),
        length=32,
        salt=salt,
        iterations=480_000,
    )
    return base64.urlsafe_b64encode(kdf.derive(master_key.encode("utf-8")))


class ProviderKeyStore:
    """Encrypted provider key persistence backed by the provider_keys table."""

    def __init__(self) -> None:
        self._fernet: Fernet | None = None
        self._cache: dict[str, str] = {}  # provider → plain text key (in-memory)

    @property
    def _f(self) -> Fernet:
        if self._fernet is None:
            settings = get_settings()
            master = settings.acb_master_key or os.environ.get("ACB_MASTER_KEY", "")
            if not master:
                raise RuntimeError(
                    "ACB_MASTER_KEY is not set.  Generate one with: "
                    "python -c \"import secrets; print(secrets.token_urlsafe(32))\""
                )
            key = _derive_fernet_key(master)
            self._fernet = Fernet(key)
        return self._fernet

    async def _execute(self, sql: str, **params: Any) -> list[dict[str, Any]]:
        """Run a raw SQL statement and return rows as dicts.

        Uses psycopg sync connection wrapped in asyncio.to_thread() for
        Windows compatibility (avoids ProactorEventLoop issue).
        """
        import asyncio
        import re as _re
        from urllib.parse import unquote as _url_unquote

        import psycopg
        from psycopg.rows import dict_row

        settings = get_settings()
        db_url = str(settings.database_url)

        # Parse SQLAlchemy URL → psycopg conninfo string.
        # Format: postgresql[+driver]://user:pass@host:port/dbname
        m = _re.match(
            r"postgresql(?:\+\w+)?://([^:]+):([^@]+)@([^:/]+):?(\d+)?/(.+)",
            db_url,
        )
        if not m:
            raise RuntimeError(f"Cannot parse database_url: {db_url[:50]}...")

        user, password, host, port, dbname = m.groups()
        conninfo = (
            f"host={host} port={port or 5432} dbname={dbname} "
            f"user={user} password={_url_unquote(password)}"
        )

        # Convert :param style to %(param)s for psycopg
        pg_sql = _re.sub(r":(\w+)", r"%(\1)s", sql)

        def _sync() -> list[dict[str, Any]]:
            with psycopg.connect(conninfo, row_factory=dict_row) as conn:
                with conn.cursor() as cur:
                    cur.execute(pg_sql, params)
                    if cur.description is None:
                        return []  # INSERT/UPDATE/DELETE — no rows to fetch
                    return list(cur.fetchall())

        return await asyncio.to_thread(_sync)

    async def get(self, provider: str) -> str:
        """Return the plain-text API key for a provider, or '' if not set."""
        # Check in-memory cache first
        if provider in self._cache:
            return self._cache[provider]

        rows = await self._execute(
            "SELECT encrypted FROM provider_keys WHERE provider = :provider",
            provider=provider,
        )
        if not rows:
            return ""

        try:
            plain = self._f.decrypt(base64.urlsafe_b64decode(rows[0]["encrypted"])).decode("utf-8")
            self._cache[provider] = plain
            return plain
        except Exception:
            _log.warning("key_store.decrypt_failed", provider=provider)
            return ""

    async def put(self, provider: str, api_key: str) -> None:
        """Store an encrypted API key (upsert)."""
        if not api_key.strip():
            raise ValueError("api_key cannot be empty")

        encrypted = base64.urlsafe_b64encode(
            self._f.encrypt(api_key.encode("utf-8"))
        ).decode("ascii")

        await self._execute(
            """
            INSERT INTO provider_keys (provider, encrypted, updated_at)
            VALUES (:provider, :encrypted, now())
            ON CONFLICT (provider) DO UPDATE
            SET encrypted = :encrypted, updated_at = now()
            """,
            provider=provider,
            encrypted=encrypted,
        )
        self._cache[provider] = api_key
        _log.info("key_store.put", provider=provider)

    async def delete(self, provider: str) -> None:
        """Remove a provider's API key."""
        await self._execute(
            "DELETE FROM provider_keys WHERE provider = :provider",
            provider=provider,
        )
        self._cache.pop(provider, None)
        _log.info("key_store.delete", provider=provider)

    async def get_all(self) -> dict[str, str]:
        """Return all stored provider keys (decrypted)."""
        rows = await self._execute("SELECT provider, encrypted FROM provider_keys")
        result: dict[str, str] = {}
        for row in rows:
            provider = row["provider"]
            if provider in self._cache:
                result[provider] = self._cache[provider]
                continue
            try:
                plain = self._f.decrypt(base64.urlsafe_b64decode(row["encrypted"])).decode("utf-8")
                self._cache[provider] = plain
                result[provider] = plain
            except Exception:
                _log.warning("key_store.decrypt_failed", provider=provider)
        return result

    async def configure_litellm(self) -> None:
        """Load all stored keys into litellm's module-level config.

        Call once at startup so litellm.acompletion() can route to any
        configured provider without needing a proxy.  Also sets os.environ
        so the Settings UI shows providers as configured.
        """
        import litellm as _litellm

        # Provider slug → (litellm attr, env var name)
        _provider_config = {
            "openai":     ("api_key",             "OPENAI_API_KEY"),
            "anthropic":  ("anthropic_api_key",   "ANTHROPIC_API_KEY"),
            "gemini":     ("gemini_api_key",      "GEMINI_API_KEY"),
            "deepseek":   ("deepseek_api_key",    "DEEPSEEK_API_KEY"),
            "groq":       ("groq_api_key",        "GROQ_API_KEY"),
            "mistral":    ("mistral_api_key",     "MISTRAL_API_KEY"),
            "together":   ("together_api_key",    "TOGETHER_API_KEY"),
            "openrouter": ("openrouter_api_key",  "OPENROUTER_API_KEY"),
        }

        all_keys = await self.get_all()
        for provider, key in all_keys.items():
            if not key:
                continue
            cfg = _provider_config.get(provider)
            if cfg:
                litellm_attr, env_var = cfg
                setattr(_litellm, litellm_attr, key)
                os.environ[env_var] = key
                _log.debug("key_store.litellm_configured", provider=provider)
            else:
                _log.debug("key_store.unknown_provider", provider=provider)


# ---------------------------------------------------------------------------
# Singleton accessor
# ---------------------------------------------------------------------------

_store: ProviderKeyStore | None = None


def get_key_store() -> ProviderKeyStore:
    """Return the global ProviderKeyStore singleton."""
    global _store
    if _store is None:
        _store = ProviderKeyStore()
    return _store

"""Single name→class factory for WhatsApp providers.

Mirrors ``email_ingestion.providers.factory.build_provider`` so the gateway's
provider adapter is identical in shape. Only ``cloud_api`` exists — unofficial
transports are out of scope by design (see the spec §3) — but the seam is kept
so the gateway never imports a concrete provider directly.
"""

from __future__ import annotations

from typing import Any

from whatsapp_ingestion.providers.base import BaseWhatsAppProvider
from whatsapp_ingestion.providers.cloud_api import WhatsAppCloudProvider

_PROVIDERS = {"cloud_api": WhatsAppCloudProvider}


def build_provider(name: str, credentials: dict[str, Any]) -> BaseWhatsAppProvider:
    """Construct a provider by name, or raise ``ValueError`` for an unknown one."""
    cls = _PROVIDERS.get(name)
    if cls is None:
        supported = ", ".join(sorted(_PROVIDERS))
        raise ValueError(f"Unknown WhatsApp provider: {name}. Supported: {supported}")
    return cls(credentials)

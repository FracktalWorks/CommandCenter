"""WhatsApp providers — the transport seam.

Only one transport exists (``cloud_api`` — the official Meta WhatsApp Business
Cloud API); the ABC + factory keep the boundary explicit so triage/AI layers
stay transport-blind, exactly as the email vertical does with its provider ABC.
"""

from whatsapp_ingestion.providers.base import (  # noqa: F401
    BaseWhatsAppProvider,
    SyncResult,
    WhatsAppChat,
    WhatsAppContact,
    WhatsAppMedia,
    WhatsAppMessage,
    WhatsAppStatus,
)
from whatsapp_ingestion.providers.factory import build_provider  # noqa: F401

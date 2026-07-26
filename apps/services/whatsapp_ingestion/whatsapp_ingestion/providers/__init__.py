"""WhatsApp providers — the transport seam.

Two transports implement the seam: ``cloud_api`` (the official Meta WhatsApp
Business Cloud API) and ``whatsmeow`` (a personal number paired by QR through the
local bridge). The ABC + factory keep the boundary explicit so triage/AI layers
stay transport-blind, exactly as the email vertical does with its provider ABC.
"""

from whatsapp_ingestion.providers.base import (  # noqa: F401
    BaseWhatsAppProvider,
    SyncResult,
    WhatsAppContact,
    WhatsAppMedia,
    WhatsAppMessage,
    WhatsAppStatus,
)
from whatsapp_ingestion.providers.factory import build_provider  # noqa: F401

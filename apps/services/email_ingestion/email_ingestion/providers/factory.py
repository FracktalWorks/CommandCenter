"""Provider factory — the one place that maps a provider name to its concrete
:class:`~email_ingestion.providers.base.BaseEmailProvider` implementation.

This lives in the ``email_ingestion.providers`` package (the layer that owns
the provider classes) so every caller — the gateway routes *and* the ingestion
scheduler — imports **down** into it rather than re-deriving the name→class
``if/elif`` inline. Adding a provider now means editing this function only.

The provider imports are done lazily inside :func:`build_provider` so importing
this module stays cheap and free of import cycles, matching the previous
call-site behaviour.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from email_ingestion.providers.base import BaseEmailProvider

# Canonical provider identifiers as stored on ``email_accounts.provider``.
# "microsoft" is the stored value for Outlook / Microsoft Graph accounts.
KNOWN_PROVIDERS: frozenset[str] = frozenset({"gmail", "microsoft", "imap"})


def build_provider(provider_name: str, creds: dict[str, Any]) -> BaseEmailProvider:
    """Construct the email provider for ``provider_name`` from decrypted creds.

    Raises :class:`ValueError` for an unknown provider. Gateway callers
    translate this into an HTTP 400 (see
    ``gateway.routes.email.core._instantiate_provider``); the ingestion
    scheduler surfaces it as a sync failure.
    """
    if provider_name == "gmail":
        from email_ingestion.providers.gmail import GmailProvider
        return GmailProvider(creds)
    if provider_name == "microsoft":
        from email_ingestion.providers.outlook import OutlookProvider
        return OutlookProvider(creds)
    if provider_name == "imap":
        from email_ingestion.providers.imap import IMAPProvider
        return IMAPProvider(creds)
    raise ValueError(f"Unknown provider: {provider_name}")

"""WhatsApp ingestion service.

Official Meta WhatsApp Business Cloud API (coexistence) only. Mirrors the shape
of ``email_ingestion`` — a provider abstraction with normalized message
dataclasses, a shared idempotent persist path, and a post-sync hook registry —
but WhatsApp is webhook-driven (Meta pushes events) rather than poll-driven, so
there is no per-account polling scheduler. This package is the LOWER layer and
imports nothing from the gateway; the gateway imports DOWN into it.
"""

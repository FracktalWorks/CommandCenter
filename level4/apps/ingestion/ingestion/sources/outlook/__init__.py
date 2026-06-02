"""Outlook/Exchange Online ingestor (WBS 1.3).

Capture model: Microsoft Graph change notifications POST to our webhook,
the webhook acks them and enqueues a fetch of new messages via
GET /users/{user}/messages, and the normaliser projects each message into
an EmailMessage (orchestrator.triage.schema) plus a row in the `message`
graph table.

Gated entirely on env vars; if OUTLOOK_CLIENT_ID is empty the gateway
import is a no-op and the route 404s.
"""


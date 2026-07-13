"""Gmail ingestor (WBS 1.3).

Capture model: Google Workspace pushes Pub/Sub notifications into our webhook,
the webhook acks them and enqueues a fetch of the changed history range,
the fetcher calls Gmail API users.history.list, and the normaliser projects
each message into an EmailMessage (orchestrator.triage.schema) plus a row in
the `message` graph table.

Gated entirely on env vars; if `GMAIL_CLIENT_EMAIL` is empty the gateway
import is a no-op and the route 404s.
"""

# Workflows

n8n workflows exported via `scripts/n8n_export.py`. One JSON file per workflow,
keyed by n8n workflow ID. These are the source of truth — re-import after a
fresh `docker compose --profile workflows up -d` via the n8n CLI / UI.
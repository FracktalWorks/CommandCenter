# Langfuse (self-hosted)

A minimal single-container Langfuse is wired into `infra/docker-compose.yml`. For production HA (separate worker, ClickHouse, S3), follow the upstream guide and replace the `langfuse` service: https://langfuse.com/self-hosting

After first `docker compose up -d`:
1. Visit http://localhost:3000
2. Sign up the first user — becomes the org admin.
3. Create a project, copy the public/secret keys into `.env` (`LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`).

# AI Company Brain — convenience targets (use `make <target>` or invoke uv directly).
.PHONY: sync lint fmt type test cov gateway infra-up infra-down infra-logs clean

sync:
uv sync

lint:
uv run ruff check .

fmt:
uv run ruff format .

type:
uv run mypy apps packages

test:
uv run pytest

cov:
uv run pytest --cov=apps --cov=packages --cov-report=term-missing

gateway:
	uv run --no-sync python -m uvicorn gateway.main:app --reload --host 0.0.0.0 --port 8080

infra-up:
docker compose -f infra/docker-compose.yml up -d

infra-down:
docker compose -f infra/docker-compose.yml down

infra-logs:
docker compose -f infra/docker-compose.yml logs -f --tail=100

clean:
Remove-Item -Recurse -Force .venv, .pytest_cache, .ruff_cache, .mypy_cache -ErrorAction SilentlyContinue

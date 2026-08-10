# scripts/

One-off operational scripts (migrations, data backfills, secret rotations). Each script should be a standalone `uv run python scripts/<name>.py`.

## Recurring operator checks (not one-offs)

| Script | Answers | Safe for an agent to run? |
|---|---|---|
| `onboarding_preflight.py` | "Is it safe to invite a colleague yet?" — seven readiness checks, PASS/FAIL/SKIP with exact remediation, non-zero exit on any FAIL. Owning spec: `project-docs/specs/colleague_onboarding.md` §1 (board row WS-24). | **Only with `--mode local`.** Its database and systemd checks read the live box, so an agent must never point it at production; `--mode local` refuses those checks and says so rather than guessing. |
| `feature_check.py` | "Is chat + each AI app actually working right now?" — live smoke against a running gateway. | No — it drives real endpoints. |
| `check_infra.py` | Container / port / dependency sanity for the local stack. | Yes, locally. |

Two conventions these share, and new scripts should follow:

- **`.env` and container-name resolution shaped like `apply_migrations.sh`**:
  `APP_DIR` (default `/opt/acb/app`), `PG_CONTAINER` (default `acb-postgres`),
  `POSTGRES_USER` / `POSTGRES_DB` read from `$APP_DIR/.env` with `acb`/`acb`
  fallbacks. An operator should not have to learn a second set of knobs.
- **Never print a secret.** A check that compares two credentials reports a
  boolean — never a value, a prefix, or a length.
